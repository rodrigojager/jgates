// The environment diagnosis behind `jgates doctor` and the Environment screen: runtimes, binaries and tool versions
// against the adapter ranges and the lock file. It only reads: it never installs, downloads or creates anything
// (not the data folder, not the workspace). What to install, and how, is core/install (`jgates doctor --fix`).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { translator } from "../../i18n/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { probeRuff } from "../../adapters/ruff/probe.js";
import { probeSemgrep } from "../../adapters/semgrep/probe.js";
import { findOnPath, resolvePython, resolveSidecarDir } from "../bridge/index.js";
import type { AdapterManifest } from "../catalog/index.js";
import { resolveHome } from "../home/index.js";
import { readLock, LOCK_FILE, type LockRead } from "../lock/index.js";
import { resolveToolBindings } from "../tools/index.js";
import { probeLockedImage, runsInContainer, runtimeClientEnv, type LockedImageProbe } from "./image.js";
import { satisfiesRange } from "./semver.js";
import { hostOf, preparedRulesOf, semgrepRulesUrl, SEMGREP_RULES_REF, type PreparedState } from "./store.js";

export type EnvState = "ready" | "absent" | "incompatible" | "not_checked";

export interface RuntimeStatus {
  id: "node" | "python" | "git" | "docker";
  state: EnvState;
  version: string | null;
  path: string | null;
  /** Docker is optional: its absence does not make the environment not ready. */
  optional: boolean;
  /** Docker only: the client is on the PATH but its daemon does not answer (installed and stopped). */
  stopped?: boolean;
  message: string;
  /** Command or instruction that fixes it; the doctor never runs it. */
  fix: string | null;
}

export interface PreparationStatus {
  supported: boolean;
  /** What the preparation pins: a rule set (Semgrep) or the container image of the instance. */
  kind: "rules" | "image" | null;
  /** What was prepared: the pinned rule set or image state. */
  state: PreparedState | "n/a";
  /** The rule set ref, or the image reference that was prepared. */
  ref: string | null;
  /** The rule set hash, or the pinned image id. */
  hash: string | null;
  /** Network a preparation would use, shown before it runs. */
  network: { hosts: string[]; url: string | null };
  command: string | null;
}

export interface ToolStatus {
  instance: string;
  adapter: string;
  component: string | null;
  enabled: boolean;
  required: boolean;
  /** Runner of the instance in tools.yml (local or container). */
  runner: string;
  state: EnvState;
  executable: string | null;
  version: string | null;
  range: string;
  message: string;
  fix: string | null;
  /** Pinned version in .jgates/lock.json, and whether the installed one differs from it. */
  lock: { pinned: string | null; drift: boolean; message: string | null };
  preparation: PreparationStatus;
}

export interface EnvironmentDiagnosis {
  schemaVersion: 1;
  projectDir: string;
  home: { path: string; exists: boolean };
  lock: { file: string; exists: boolean; valid: boolean; problem: string | null };
  runtimes: RuntimeStatus[];
  tools: ToolStatus[];
  summary: { ready: number; absent: number; incompatible: number; notChecked: number };
  /** true when no runtime and no enabled tool is absent or incompatible. Independent from plan validity and from approval. */
  environmentReady: boolean;
}

interface ToolProbe {
  executable: string | null;
  version: string | null;
  problem: "not_found" | "no_answer" | null;
  detail: string;
}

/** The fix of a Python tool JGates can install in its own environment (<JGATES_HOME>/tools/python). */
export const INSTALL_FIX = "jgates doctor --fix";

/** The Python packages the quality sidecar imports (quality-gate/pyproject.toml), as import names. */
export const SIDECAR_IMPORTS = ["defusedxml", "tomlkit"];

const depsCache = new Map<string, { mtimeMs: number; ok: boolean }>();

/** Whether the interpreter imports the sidecar's packages. Read-only: it runs `python -c "import ..."`. */
export function sidecarDependenciesPresent(interpreter: string, env: NodeJS.ProcessEnv): boolean {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(interpreter).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  const hit = depsCache.get(interpreter);
  if (hit && hit.mtimeMs === mtimeMs) return hit.ok;
  const r = spawnSync(interpreter, ["-c", `import ${SIDECAR_IMPORTS.join(", ")}`], { encoding: "utf8", timeout: 30_000, env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "", PYTHONDONTWRITEBYTECODE: "1" }, windowsHide: true });
  const ok = r.status === 0;
  depsCache.set(interpreter, { mtimeMs, ok });
  return ok;
}

/** What the doctor can check for an adapter without running anything but `--version`. */
function probeAdapter(manifest: AdapterManifest, env: NodeJS.ProcessEnv): ToolProbe | null {
  if (manifest.id === "ruff") return probeRuff(env);
  if (manifest.id === "semgrep") return probeSemgrep(env);
  if (manifest.id === "quality-bridge") {
    const python = resolvePython(env);
    if (!python.interpreter) return { executable: null, version: null, problem: "not_found", detail: python.tried.join(", ") };
    if (!resolveSidecarDir(env)) return { executable: python.interpreter, version: null, problem: "no_answer", detail: "sidecar" };
    if (!sidecarDependenciesPresent(python.interpreter, env)) return { executable: python.interpreter, version: null, problem: "not_found", detail: `${SIDECAR_IMPORTS.join(", ")} (${python.interpreter})` };
    return { executable: python.interpreter, version: null, problem: null, detail: "" };
  }
  if (manifest.id === "builtin-pii") return { executable: "builtin", version: null, problem: null, detail: "" };
  return null;
}

/** The image of a container instance as a probe: the runtime, the pinned version, or what is missing. */
function containerProbe(image: LockedImageProbe): ToolProbe {
  if (image.problem !== null) return { executable: image.runtime, version: null, problem: "not_found", detail: image.detail };
  return { executable: image.runtime, version: image.version, problem: null, detail: "" };
}

function fixFor(manifest: AdapterManifest): string | null {
  if (manifest.id === "ruff" || manifest.id === "semgrep" || manifest.id === "quality-bridge") return INSTALL_FIX;
  return null;
}

/** Whether the Docker daemon answers (`docker info`), and its server version. */
function dockerDaemon(docker: string, env: NodeJS.ProcessEnv): { running: boolean; version: string | null } {
  const r = spawnSync(docker, ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 15_000, env: runtimeClientEnv(env), windowsHide: true });
  if (r.status !== 0) return { running: false, version: null };
  const version = r.stdout.trim().split(/\r?\n/)[0] ?? "";
  return { running: true, version: version === "" ? null : version };
}

function pythonVersion(interpreter: string, env: NodeJS.ProcessEnv): string | null {
  const r = spawnSync(interpreter, ["--version"], { encoding: "utf8", timeout: 15_000, env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" }, windowsHide: true });
  if (r.status !== 0) return null;
  return /(\d+\.\d+\.\d+)/.exec(`${r.stdout}${r.stderr}`)?.[1] ?? null;
}

function diagnoseRuntimes(env: NodeJS.ProcessEnv): RuntimeStatus[] {
  const t = translator("prepare");
  const out: RuntimeStatus[] = [];
  const nodeOk = satisfiesRange(process.versions.node, ">=18.17.0") === true;
  out.push({
    id: "node",
    state: nodeOk ? "ready" : "incompatible",
    version: process.versions.node,
    path: process.execPath,
    optional: false,
    message: nodeOk ? t("prepare_runtime_ready", { name: "Node.js", version: process.versions.node }) : t("prepare_incompatible", { tool: "Node.js", version: process.versions.node, range: ">=18.17.0", what: "jgates" }),
    fix: nodeOk ? null : "https://nodejs.org/",
  });
  const python = resolvePython(env);
  const pyVersion = python.interpreter ? pythonVersion(python.interpreter, env) : null;
  const pyRange = ">=3.11.0";
  const pyFit = pyVersion ? satisfiesRange(pyVersion, pyRange) : null;
  out.push({
    id: "python",
    state: !python.interpreter ? "absent" : pyFit === false ? "incompatible" : "ready",
    version: pyVersion,
    path: python.interpreter,
    optional: false,
    message: !python.interpreter
      ? t("prepare_runtime_absent", { name: "Python", detail: python.tried.join(", ") })
      : pyFit === false
        ? t("prepare_incompatible", { tool: "Python", version: pyVersion ?? "?", range: pyRange, what: "quality-bridge" })
        : t("prepare_runtime_ready", { name: "Python", version: pyVersion ?? "?" }),
    fix: python.interpreter && pyFit !== false ? null : t("prepare_fix_python"),
  });
  const git = findOnPath("git", env);
  out.push({
    id: "git",
    state: git ? "ready" : "absent",
    version: null,
    path: git,
    optional: false,
    message: git ? t("prepare_runtime_ready", { name: "Git", version: "-" }) : t("prepare_runtime_absent", { name: "Git", detail: "git on PATH" }),
    fix: git ? null : t("prepare_fix_git"),
  });
  const docker = findOnPath("docker", env);
  const daemon = docker ? dockerDaemon(docker, env) : null;
  const dockerReady = daemon?.running === true;
  out.push({
    id: "docker",
    state: dockerReady ? "ready" : "absent",
    version: daemon?.version ?? null,
    path: docker,
    optional: true,
    ...(docker && !dockerReady ? { stopped: true } : {}),
    message: dockerReady
      ? t("prepare_runtime_ready", { name: "Docker", version: daemon?.version ?? "-" })
      : docker
        ? t("prepare_docker_stopped", { path: docker })
        : t("prepare_runtime_absent_optional", { name: "Docker" }),
    fix: dockerReady ? null : docker ? t("prepare_fix_docker_stopped") : t("prepare_fix_docker"),
  });
  return out;
}

export function prepareCommand(instance: string, projectDir: string): string {
  return `jgates tools prepare --instance ${instance} --cwd ${projectDir} --no-interactive`;
}

/** Adapters that have a preparation step for rule sets to download (the container images are the other kind). */
export const PREPARABLE_ADAPTERS = new Set(["semgrep"]);

/** What `tools prepare` pins for an instance: the rule set of the adapter, its container image, or nothing. */
export function preparationKindOf(adapter: string, runner: string | null | undefined): "rules" | "image" | null {
  if (PREPARABLE_ADAPTERS.has(adapter)) return "rules";
  if (runsInContainer(adapter, runner)) return "image";
  return null;
}

const NO_PREPARATION: PreparationStatus = { supported: false, kind: null, state: "n/a", ref: null, hash: null, network: { hosts: [], url: null }, command: null };

function imagePreparation(probe: LockedImageProbe, instance: string, projectDir: string): PreparationStatus {
  const state: PreparedState = probe.locked === null ? "none" : probe.problem === "image_missing" ? "missing" : probe.problem === "image_changed" ? "corrupt" : "ready";
  return { supported: true, kind: "image", state, ref: probe.locked?.reference ?? null, hash: probe.locked?.id ?? null, network: { hosts: [], url: null }, command: prepareCommand(instance, projectDir) };
}

function preparationOf(manifest: AdapterManifest, instance: string, runner: string, projectDir: string, lock: LockRead, home: string, env: NodeJS.ProcessEnv): PreparationStatus {
  const kind = preparationKindOf(manifest.id, runner);
  if (kind === null) return NO_PREPARATION;
  if (kind === "image") return imagePreparation(probeLockedImage({ env, dir: projectDir, instance }), instance, projectDir);
  const prepared = preparedRulesOf(lock.lock, instance, home);
  const url = semgrepRulesUrl(env);
  return {
    supported: true,
    kind: "rules",
    state: prepared.state,
    ref: SEMGREP_RULES_REF,
    hash: prepared.entry?.hash ?? null,
    network: { hosts: [hostOf(url)], url },
    command: prepareCommand(instance, projectDir),
  };
}

export function diagnoseEnvironment(projectDir: string, options: { env?: NodeJS.ProcessEnv; manifests?: AdapterManifest[] } = {}): EnvironmentDiagnosis {
  const env = options.env ?? process.env;
  const t = translator("prepare");
  const manifests = options.manifests ?? builtinManifests();
  const byAdapter = new Map(manifests.map((m) => [m.id, m]));
  const home = resolveHome({ env });
  const lock = readLock(projectDir);
  const runtimes = diagnoseRuntimes(env);
  const resolved = resolveToolBindings(projectDir, { manifests, skipInventory: true });
  const tools: ToolStatus[] = [];
  for (const instance of resolved.instances) {
    const manifest = byAdapter.get(instance.adapter);
    if (!manifest) {
      tools.push({
        instance: instance.id,
        adapter: instance.adapter,
        component: instance.component,
        enabled: instance.enabled,
        required: instance.required,
        runner: instance.runner,
        state: "not_checked",
        executable: null,
        version: null,
        range: "*",
        message: t("prepare_adapter_unknown", { adapter: instance.adapter }),
        fix: null,
        lock: { pinned: null, drift: false, message: null },
        preparation: NO_PREPARATION,
      });
      continue;
    }
    // An instance that runs in a container is checked through the image the lock pins, not a local binary.
    const container = runsInContainer(manifest.id, instance.runner) ? probeLockedImage({ env, dir: projectDir, instance: instance.id }) : null;
    const probe = container ? containerProbe(container) : probeAdapter(manifest, env);
    const range = manifest.toolVersionRange;
    const fit = probe?.version ? satisfiesRange(probe.version, range) : null;
    let state: EnvState;
    let message: string;
    let fix: string | null = fixFor(manifest);
    if (!probe) {
      state = "not_checked";
      message = t("prepare_not_checked", { tool: manifest.toolName });
      fix = null;
    } else if (container && container.problem !== null) {
      state = "absent";
      message = t(`prepare_image_${container.problem}`, { tool: manifest.toolName, image: container.image ?? "-", detail: container.detail, runtime: container.runtimeName });
      fix = container.problem === "runtime_missing" ? t("prepare_fix_docker_required") : prepareCommand(instance.id, projectDir);
    } else if (probe.problem === "not_found" && manifest.id === "quality-bridge" && probe.executable) {
      state = "absent";
      message = t("prepare_sidecar_deps_missing", { python: probe.executable, packages: SIDECAR_IMPORTS.join(", ") });
    } else if (probe.problem === "not_found") {
      state = "absent";
      message = t("prepare_tool_absent", { tool: manifest.toolName, detail: probe.detail });
    } else if (probe.problem === "no_answer") {
      state = "absent";
      message = t("prepare_tool_no_answer", { tool: manifest.toolName, detail: probe.detail });
    } else if (fit === false) {
      state = "incompatible";
      message = t("prepare_incompatible", { tool: manifest.toolName, version: probe.version ?? "?", range, what: manifest.id });
      fix = t("prepare_fix_incompatible", { tool: manifest.toolName, range });
    } else {
      state = "ready";
      message = t("prepare_runtime_ready", { name: manifest.toolName, version: probe.version ?? "-" });
      fix = null;
    }
    const pinned = lock.lock.tools[instance.id]?.toolVersion ?? null;
    const drift = pinned !== null && probe?.version != null && pinned !== probe.version;
    tools.push({
      instance: instance.id,
      adapter: instance.adapter,
      component: instance.component,
      enabled: instance.enabled,
      required: instance.required,
      runner: instance.runner,
      state,
      executable: probe?.executable ?? null,
      version: probe?.version ?? null,
      range,
      message,
      fix,
      lock: { pinned, drift, message: drift ? t("prepare_lock_drift", { tool: instance.id, pinned: pinned ?? "-", found: probe?.version ?? "-", file: LOCK_FILE }) : null },
      preparation: preparationOf(manifest, instance.id, instance.runner, projectDir, lock, home, env),
    });
  }
  const count = (s: EnvState, list: Array<{ state: EnvState; optional?: boolean; enabled?: boolean }>) => list.filter((x) => x.state === s && !x.optional && x.enabled !== false).length;
  const summary = {
    ready: [...runtimes, ...tools].filter((x) => x.state === "ready").length,
    absent: count("absent", runtimes) + count("absent", tools),
    incompatible: count("incompatible", runtimes) + count("incompatible", tools),
    notChecked: tools.filter((x) => x.state === "not_checked").length,
  };
  const homeExists = fs.existsSync(home);
  return {
    schemaVersion: 1,
    projectDir,
    home: { path: home, exists: homeExists },
    lock: { file: lock.file, exists: lock.exists, valid: lock.problem === null, problem: lock.problem },
    runtimes,
    tools,
    summary,
    environmentReady: summary.absent === 0 && summary.incompatible === 0,
  };
}
