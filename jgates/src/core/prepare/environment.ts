// The environment diagnosis behind `jgates doctor` and the Environment screen: the container engine and the JGates tools
// image (container-first, ADR-0004: the host needs only Node, Git and a Docker-compatible engine), and the tool
// versions the image records in its image.json against the adapter ranges and the lock file. It only reads: it never
// installs, downloads or creates anything (not the data folder, not the workspace), and it never starts a tool. What
// can be prepared, and how, is core/install (engine install or start, the image download, data preparation).
import fs from "node:fs";
import { translator } from "../../i18n/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { probeImportLinter } from "../../adapters/import-linter/probe.js";
import { probePytest } from "../../adapters/pytest/probe.js";
import { probeRuff } from "../../adapters/ruff/probe.js";
import { probeSemgrep } from "../../adapters/semgrep/probe.js";
import { probeZizmor } from "../../adapters/zizmor/probe.js";
import { probeCodeql } from "../../adapters/codeql/probe.js";
import { probeOasdiff } from "../../adapters/oasdiff/probe.js";
import { probeGovulncheck } from "../../adapters/govulncheck/probe.js";
import { probeCargoAudit } from "../../adapters/cargo-audit/probe.js";
import { probeCargo } from "../../adapters/cargo-test/probe.js";
import { probeSchemathesis } from "../../adapters/schemathesis/probe.js";
import { probeZap } from "../../adapters/zap/probe.js";
import { readVersion } from "../../cli/version.js";
import { findOnPath, sidecarAvailability } from "../bridge/index.js";
import { detectEngineSync, inspectImageSync, type EngineContext } from "../engine/index.js";
import { resolveReason } from "../reasons/index.js";
import { readImageJson, stepMode } from "../runner/in-image.js";
import { IMAGE_VERSION_LABEL, toolsImageTarget } from "../tools-image/index.js";
import type { AdapterManifest } from "../catalog/index.js";
import { resolveHome } from "../home/index.js";
import { readLock, LOCK_FILE, type LockRead } from "../lock/index.js";
import { buildPlan } from "../plan/build.js";
import { resolveToolBindings } from "../tools/index.js";
import { satisfiesRange } from "./semver.js";
import { hostOf, preparedRulesOf, semgrepRulesUrl, SEMGREP_RULES_REF, type PreparedState } from "./store.js";

export type EnvState = "ready" | "absent" | "incompatible" | "not_checked";

export interface RuntimeStatus {
  /** docker: the container engine every check runs in; image: the JGates tools image this release pins. */
  id: "node" | "git" | "docker" | "image";
  state: EnvState;
  version: string | null;
  path: string | null;
  /** An optional runtime's absence does not make the environment not ready (the engine inside the tools image). */
  optional: boolean;
  /** Docker only: the client is on the PATH but its daemon does not answer (installed and stopped). */
  stopped?: boolean;
  /** The reason code of a runtime that is not ready (ENGINE_NOT_INSTALLED, IMAGE_MISSING...), from the shared catalogue. */
  reasonCode?: string;
  message: string;
  /** Command or instruction that fixes it; the doctor never runs it. */
  fix: string | null;
}

export interface PreparationStatus {
  supported: boolean;
  /** What the preparation pins: a rule set (Semgrep). */
  kind: "rules" | null;
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
  /**
   * On only "when available" (strict): the plan runs it where its tool is present. Missing, it is offered to prepare
   * but never makes the environment not ready.
   */
  whenAvailable?: boolean;
  /** Where the instance runs: always the tools image's container (kept for the readers of older reports). */
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

/** What the doctor can check for an adapter: the image's image.json (nothing starts; an override inside the image only
 * is asked for its version). */
function probeAdapter(manifest: AdapterManifest, env: NodeJS.ProcessEnv, projectDir: string): ToolProbe | null {
  if (manifest.id === "ruff") return probeRuff(env);
  if (manifest.id === "semgrep") return probeSemgrep(env);
  if (manifest.id === "zizmor") return probeZizmor(env);
  if (manifest.id === "oasdiff") return probeOasdiff(env);
  if (manifest.id === "govulncheck") {
    const p = probeGovulncheck(env);
    return { executable: p.executable, version: p.version, problem: p.problem === "no_go" ? "not_found" : p.problem, detail: p.detail };
  }
  if (manifest.id === "cargo-audit") return probeCargoAudit(env);
  if (manifest.id === "cargo-test") return probeCargo(env);
  if (manifest.id === "schemathesis") return probeSchemathesis(env);
  if (manifest.id === "zap") {
    // The ZAP image the adapter starts (the image's own copy replaces it with the adapter migration).
    const p = probeZap(env);
    return { executable: p.runtime, version: null, problem: p.problem === null ? null : "not_found", detail: p.problem === null ? "" : p.detail };
  }
  if (manifest.id === "codeql") return probeCodeql(env);
  if (manifest.id === "import-linter") {
    const p = probeImportLinter(env);
    return { executable: p.executable, version: p.version, problem: p.problem, detail: p.detail };
  }
  if (manifest.id === "pytest") {
    // The project's own Python: pytest runs the project's code, so it is the one the tests need.
    const p = probePytest(env, projectDir);
    if (p.problem === "python_missing") return { executable: null, version: null, problem: "not_found", detail: `python (${p.detail})` };
    if (p.problem === "no_pytest") return { executable: null, version: null, problem: "not_found", detail: `pytest, ${p.detail}` };
    return { executable: p.python, version: p.version, problem: null, detail: "" };
  }
  if (manifest.id === "quality-bridge") {
    // The sidecar's environment in the tools image (quality_sidecar, tomlkit, defusedxml).
    const sidecar = sidecarAvailability(env);
    if (sidecar.problem === "python_missing") return { executable: null, version: null, problem: "not_found", detail: sidecar.tried.join(", ") };
    if (sidecar.problem === "sidecar_missing") return { executable: sidecar.interpreter, version: null, problem: "not_found", detail: "quality-sidecar" };
    return { executable: sidecar.interpreter, version: sidecar.version, problem: null, detail: "" };
  }
  // The supply-chain check reads the lockfiles in-process: nothing to prepare.
  if (manifest.id === "supply-chain") return { executable: "builtin", version: null, problem: null, detail: "" };
  if (manifest.id === "builtin-pii") return { executable: "builtin", version: null, problem: null, detail: "" };
  return null;
}

/** A tool missing from the image is fixed by the image of this release, never by a host install. */
function fixFor(manifest: AdapterManifest): string | null {
  if (manifest.id === "codeql") return translator("codeql")("codeql_fix");
  if (manifest.id === "zap") return translator("zap")("zap_fix");
  return resolveReason("TOOL_MISSING", { tools: manifest.toolName, image: "" }).action.command ?? null;
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
  out.push(...engineRuntimes(env));
  return out;
}

/**
 * The container engine and the tools image, with the reason codes of the shared catalogue. Inside the tools image the
 * engine is not needed (steps run natively) and the image is the one JGates runs in.
 */
function engineRuntimes(env: NodeJS.ProcessEnv): RuntimeStatus[] {
  const t = translator("prepare");
  const reason = (code: string, params: Record<string, string | number> = {}) => resolveReason(code, params);
  if (stepMode(env) === "in-image") {
    const own = readImageJson(env);
    const version = typeof own?.imageVersion === "string" ? own.imageVersion : null;
    return [
      { id: "docker", state: "not_checked", version: null, path: null, optional: true, message: t("prepare_engine_in_image"), fix: null },
      { id: "image", state: "ready", version, path: null, optional: false, message: t("prepare_runtime_ready", { name: "JGates tools", version: version ?? "-" }), fix: null },
    ];
  }
  const context: EngineContext = { runnerOptions: { parentEnv: env } };
  const engine = detectEngineSync({ requiredMemoryMb: 0, requiredDiskMb: 0 }, context);
  const runtimeName = env.JGATES_CONTAINER_RUNTIME?.trim() || "docker";
  const client = findOnPath(runtimeName, env);
  const target = toolsImageTarget(env);
  const notChecked: RuntimeStatus = { id: "image", state: "not_checked", version: null, path: target.reference, optional: false, message: t("prepare_image_needs_engine", { image: target.reference }), fix: null };
  if (engine.code === "ENGINE_NOT_INSTALLED" || engine.code === "ENGINE_STOPPED") {
    const r = reason(engine.code);
    const stopped = engine.code === "ENGINE_STOPPED";
    return [
      { id: "docker", state: "absent", version: null, path: client, optional: false, ...(stopped ? { stopped: true } : {}), reasonCode: engine.code, message: r.message, fix: stopped ? t("prepare_fix_docker_stopped") : t("prepare_fix_docker_required") },
      notChecked,
    ];
  }
  if (engine.code === "UNSUPPORTED_PLATFORM") {
    const r = reason(engine.code, { platform: `${engine.facts.os ?? "?"}/${engine.facts.arch ?? "?"}` });
    return [{ id: "docker", state: "incompatible", version: engine.facts.serverVersion, path: client, optional: false, reasonCode: engine.code, message: r.message, fix: r.action.url ?? null }, notChecked];
  }
  const docker: RuntimeStatus = { id: "docker", state: "ready", version: engine.facts.serverVersion, path: client, optional: false, message: t("prepare_runtime_ready", { name: "Docker", version: engine.facts.serverVersion ?? "-" }), fix: null };
  const found = inspectImageSync(target.reference, context);
  if (!found) {
    const r = reason("IMAGE_MISSING", { size: "-", reference: target.reference });
    return [docker, { id: "image", state: "absent", version: null, path: target.reference, optional: false, reasonCode: "IMAGE_MISSING", message: r.message, fix: r.action.command ?? null }];
  }
  const actual = found.labels[IMAGE_VERSION_LABEL] ?? null;
  const expected = readVersion();
  if (actual !== expected) {
    const r = reason("IMAGE_VERSION_MISMATCH", { actual: actual ?? "?", expected, reference: target.reference });
    return [docker, { id: "image", state: "incompatible", version: actual, path: target.reference, optional: false, reasonCode: "IMAGE_VERSION_MISMATCH", message: r.message, fix: r.action.command ?? null }];
  }
  return [docker, { id: "image", state: "ready", version: actual, path: target.reference, optional: false, message: t("prepare_runtime_ready", { name: "JGates tools", version: actual ?? "-" }), fix: null }];
}

export function prepareCommand(instance: string, projectDir: string): string {
  return `jgates tools prepare --instance ${instance} --cwd ${projectDir} --no-interactive`;
}

/** Adapters that have a preparation step for rule sets to download (the container images are the other kind). */
export const PREPARABLE_ADAPTERS = new Set(["semgrep"]);

/** What `tools prepare` pins for an instance: the rule set of the adapter, or nothing. */
export function preparationKindOf(adapter: string): "rules" | null {
  return PREPARABLE_ADAPTERS.has(adapter) ? "rules" : null;
}

const NO_PREPARATION: PreparationStatus = { supported: false, kind: null, state: "n/a", ref: null, hash: null, network: { hosts: [], url: null }, command: null };

function preparationOf(manifest: AdapterManifest, instance: string, projectDir: string, lock: LockRead, home: string, env: NodeJS.ProcessEnv): PreparationStatus {
  const kind = preparationKindOf(manifest.id);
  if (kind === null) return NO_PREPARATION;
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

interface PlannedInstance {
  id: string;
  adapter: string;
  component: string | null;
  enabled: boolean;
  required: boolean;
  runner: string;
  whenAvailable?: boolean;
}

/**
 * The tool instances of the project's plan (default profile and scope): the ones its templates bring and tools.yml
 * does not declare. A project without configuration, or one whose plan cannot be built, has none (the plan says why).
 */
function plannedInstances(projectDir: string, env: NodeJS.ProcessEnv): PlannedInstance[] {
  let built;
  try {
    built = buildPlan(projectDir, { env });
  } catch {
    return [];
  }
  if (!built.ok) return [];
  const plan = built.plan;
  const out = new Map<string, PlannedInstance>();
  for (const item of plan.groups.willRun) {
    if (!item.adapter) continue;
    // A bridge subcheck is a part of the bridge: the bridge itself is the instance to check.
    const id = item.subcheck ? item.adapter : item.tool;
    const previous = out.get(id);
    const required = item.requirement === "required" || (previous?.required ?? false);
    const invocation = plan.invocations.find((i) => i.id === id || i.adapter === id);
    out.set(id, {
      id,
      adapter: item.adapter,
      component: item.subcheck ? null : (item.components[0]?.id ?? null),
      enabled: true,
      required,
      runner: "container",
    });
  }
  // On "when available" with the tool missing here: not in willRun, yet it is what "Preparar" must offer to install.
  for (const item of plan.groups.notApplicableOrDisabled) {
    if (!item.adapter || item.subcheck || item.reason.code !== "NOT_AVAILABLE_HERE" || out.has(item.tool)) continue;
    const invocation = plan.invocations.find((i) => i.id === item.tool);
    out.set(item.tool, {
      id: item.tool,
      adapter: item.adapter,
      component: item.components[0]?.id ?? null,
      enabled: true,
      required: false,
      runner: "container",
      whenAvailable: true,
    });
  }
  return [...out.values()];
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
  // The tools the plan runs come from the templates as well, not only from tools.yml: the doctor checks every one of
  // them, so "ready" means what the run needs is there (a pytest or Ruff brought by a template included).
  const declared = new Set(resolved.instances.map((i) => i.id));
  const planned = plannedInstances(projectDir, env);
  // A declared instance on "when available" (the plan found its tool missing) is offered, never essential.
  const plannedWhen = new Set(planned.filter((i) => i.whenAvailable).map((i) => i.id));
  const instances: PlannedInstance[] = [
    ...resolved.instances.map((i) => (plannedWhen.has(i.id) ? { ...i, whenAvailable: true } : i)),
    ...planned.filter((i) => !declared.has(i.id)),
  ];
  const tools: ToolStatus[] = [];
  for (const instance of instances) {
    const manifest = byAdapter.get(instance.adapter);
    if (!manifest) {
      tools.push({
        instance: instance.id,
        adapter: instance.adapter,
        component: instance.component,
        enabled: instance.enabled,
        required: instance.required,
        ...(instance.whenAvailable ? { whenAvailable: true } : {}),
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
    // Every instance runs in the tools image: its tool is what the image's image.json records.
    const probe = probeAdapter(manifest, env, projectDir);
    const range = manifest.toolVersionRange;
    const fit = probe?.version ? satisfiesRange(probe.version, range) : null;
    let state: EnvState;
    let message: string;
    let fix: string | null = fixFor(manifest);
    if (!probe) {
      state = "not_checked";
      message = instance.whenAvailable ? t("prepare_when_available_missing", { tool: instance.id }) : t("prepare_not_checked", { tool: manifest.toolName });
      fix = null;
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
      ...(instance.whenAvailable ? { whenAvailable: true } : {}),
      runner: "container",
      state,
      executable: probe?.executable ?? null,
      version: probe?.version ?? null,
      range,
      message,
      fix,
      lock: { pinned, drift, message: drift ? t("prepare_lock_drift", { tool: instance.id, pinned: pinned ?? "-", found: probe?.version ?? "-", file: LOCK_FILE }) : null },
      preparation: preparationOf(manifest, instance.id, projectDir, lock, home, env),
    });
  }
  const count = (s: EnvState, list: Array<{ state: EnvState; optional?: boolean; enabled?: boolean; whenAvailable?: boolean }>) => list.filter((x) => x.state === s && !x.optional && !x.whenAvailable && x.enabled !== false).length;
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
