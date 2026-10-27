// Installation recipes: what JGates can install for a missing tool or runtime, shown as a preview (the commands, the
// network hosts and where it writes) before anything runs. Three kinds, and JGates never runs sudo by itself:
//   - Python packages (the quality sidecar's packages, Ruff, Semgrep) go into an environment of JGates's own at
//     <JGATES_HOME>/tools/python, never into the system Python;
//   - images and rule sets go through `jgates tools prepare` (prepareInstance), the step that already existed;
//   - Docker is a system install: the official command of the detected system (apt, dnf, brew, winget), or the start
//     of an installed and stopped Docker. It runs only after a confirmation on the terminal; the command itself asks
//     for sudo where the system needs it.
// Shared by `jgates doctor` and by the run that offers to install after a failure.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { findQualityGateDir, resolveProjectPython } from "../bridge/index.js";
import { ensureHome, resolveHome } from "../home/index.js";
import { LOCK_FILE } from "../lock/index.js";
import { prepareCommand, prepareInstance, satisfiesRange, toolsDir } from "../prepare/index.js";
import { pythonEnvBinDir, pythonEnvDir, pythonEnvInterpreter } from "./paths.js";
import { displayCommand, dockerInstallCommands, dockerStartCommands, type HostSystem } from "./system.js";

export type RecipeKind = "python-packages" | "prepare" | "docker-install" | "docker-start";

/** What the doctor shows (and --json carries) before anything is installed. */
export interface RecipePreview {
  id: string;
  kind: RecipeKind;
  /** The command lines, in the order they run. */
  commands: string[];
  network: {
    hosts: string[];
    /** The system's package manager reaches its own configured mirrors (apt, dnf). */
    systemMirrors: boolean;
  };
  /** Folders and files it writes. */
  writes: string[];
  /** A system install (Docker): runs only after a confirmation on the terminal, never with --yes alone. */
  system: boolean;
  /** Whether JGates can run it here; when not, `reason` says why and what to do. */
  available: boolean;
  reason: string | null;
}

export interface Recipe extends RecipePreview {
  /** The argv of each command (no shell). Empty for kind prepare, which runs in process. */
  steps: string[][];
  /** kind python-packages: the pip requirements, and the command that creates the environment when it is missing. */
  packages?: string[];
  createEnv?: string[] | null;
  /** kind prepare: the instance and the project. */
  instance?: string;
  projectDir?: string;
}

/** The public part of a recipe (what --json prints). */
export function previewOf(recipe: Recipe): RecipePreview {
  const { id, kind, commands, network, writes, system, available, reason } = recipe;
  return { id, kind, commands: [...commands], network: { hosts: [...network.hosts], systemMirrors: network.systemMirrors }, writes: [...writes], system, available, reason };
}

/** The packages the quality sidecar needs, read from quality-gate/pyproject.toml (the same pins). */
export const SIDECAR_REQUIREMENTS_FALLBACK = ["defusedxml==0.7.1", "tomlkit==0.13.3"];

export function sidecarRequirements(): string[] {
  const qg = findQualityGateDir();
  if (!qg) return [...SIDECAR_REQUIREMENTS_FALLBACK];
  try {
    const text = fs.readFileSync(path.join(qg, "pyproject.toml"), "utf8");
    const block = /^dependencies\s*=\s*\[([^\]]*)\]/m.exec(text)?.[1];
    if (!block) return [...SIDECAR_REQUIREMENTS_FALLBACK];
    const reqs = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string).filter((r) => /^[A-Za-z0-9._-]+/.test(r));
    return reqs.length > 0 ? reqs : [...SIDECAR_REQUIREMENTS_FALLBACK];
  } catch {
    return [...SIDECAR_REQUIREMENTS_FALLBACK];
  }
}

/** A pip requirement for a tool: the version the lock pins, else the adapter range (">=0.5.0 <1.0.0" becomes ">=0.5.0,<1.0.0"). */
export function pipRequirement(pkg: string, range: string, pinned: string | null): string {
  if (pinned && /^\d+(\.\d+)*$/.test(pinned)) return `${pkg}==${pinned}`;
  const parts = range.trim().split(/\s+/).filter((p) => p !== "" && p !== "*");
  return parts.length > 0 ? `${pkg}${parts.join(",")}` : pkg;
}

/** The hosts pip reaches: the index of PIP_INDEX_URL, else PyPI. */
export function pipHosts(env: NodeJS.ProcessEnv): string[] {
  const index = env.PIP_INDEX_URL ?? env.pip_index_url;
  if (index) {
    try {
      return [new URL(index).host];
    } catch {
      return [index];
    }
  }
  return ["pypi.org", "files.pythonhosted.org"];
}

function pythonVersionOf(interpreter: string, env: NodeJS.ProcessEnv): string | null {
  const r = spawnSync(interpreter, ["--version"], { encoding: "utf8", timeout: 15_000, env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" }, windowsHide: true });
  if (r.status !== 0) return null;
  return /(\d+\.\d+\.\d+)/.exec(`${r.stdout}${r.stderr}`)?.[1] ?? null;
}

const SIDECAR_PYTHON_RANGE = ">=3.11.0";

function envPythonPath(env: NodeJS.ProcessEnv): string {
  return path.join(pythonEnvBinDir(env), process.platform === "win32" ? "python.exe" : "python");
}

function pipStep(python: string, packages: string[]): string[] {
  return [python, "-m", "pip", "install", "--disable-pip-version-check", "--upgrade", ...packages];
}

/**
 * Installs Python packages into <JGATES_HOME>/tools/python, creating the environment first (`python -m venv`) with the
 * Python of the project when it does not exist yet. The sidecar's packages always go in: the bridge uses this
 * environment as soon as it exists.
 */
export function pythonPackagesRecipe(id: string, packages: string[], env: NodeJS.ProcessEnv = process.env): Recipe {
  const t = translator("prepare");
  const dir = pythonEnvDir(env);
  const all = [...new Set([...sidecarRequirements(), ...packages])];
  const own = pythonEnvInterpreter(env);
  const python = own ?? envPythonPath(env);
  let createEnv: string[] | null = null;
  let available = true;
  let reason: string | null = null;
  if (!own) {
    const base = resolveProjectPython(env);
    const version = base.interpreter ? pythonVersionOf(base.interpreter, env) : null;
    if (!base.interpreter) {
      available = false;
      reason = t("prepare_recipe_python_missing", { tried: base.tried.join(", ") });
    } else if (version !== null && satisfiesRange(version, SIDECAR_PYTHON_RANGE) === false) {
      available = false;
      reason = t("prepare_recipe_python_old", { python: base.interpreter, version, range: SIDECAR_PYTHON_RANGE });
    }
    createEnv = [base.interpreter ?? "python3", "-m", "venv", dir];
  }
  const steps = [...(createEnv ? [createEnv] : []), pipStep(python, all)];
  return {
    id,
    kind: "python-packages",
    commands: steps.map(displayCommand),
    network: { hosts: pipHosts(env), systemMirrors: false },
    writes: [dir],
    system: false,
    available,
    reason,
    steps,
    packages: all,
    createEnv,
  };
}

/** `jgates tools prepare --instance <id>`: the image or the rule set of an instance, pinned in .jgates/lock.json. */
export function prepareRecipe(input: { instance: string; projectDir: string; kind: "rules" | "image"; hosts: string[]; available: boolean; reason: string | null; env?: NodeJS.ProcessEnv }): Recipe {
  const home = resolveHome({ env: input.env ?? process.env });
  return {
    id: `prepare:${input.instance}`,
    kind: "prepare",
    commands: [prepareCommand(input.instance, input.projectDir)],
    network: { hosts: [...input.hosts], systemMirrors: false },
    writes: input.kind === "rules" ? [path.join(input.projectDir, LOCK_FILE), toolsDir(home)] : [path.join(input.projectDir, LOCK_FILE)],
    system: false,
    available: input.available,
    reason: input.reason,
    steps: [],
    instance: input.instance,
    projectDir: input.projectDir,
  };
}

function systemRecipe(id: string, kind: "docker-install" | "docker-start", commands: string[][], hosts: string[], docs: string, systemMirrors: boolean): Recipe {
  const t = translator("prepare");
  const available = commands.length > 0;
  return {
    id,
    kind,
    commands: commands.map(displayCommand),
    network: { hosts, systemMirrors },
    writes: [],
    system: true,
    available,
    reason: available ? null : t("prepare_recipe_docker_unknown_system", { docs }),
    steps: commands,
  };
}

/** Docker from the system's package manager. */
export function dockerInstallRecipe(system: HostSystem): Recipe {
  const c = dockerInstallCommands(system);
  return systemRecipe("docker:install", "docker-install", c.commands, c.hosts, c.docs, c.manager === "apt" || c.manager === "dnf");
}

/** Starts an installed Docker whose daemon does not answer. */
export function dockerStartRecipe(system: HostSystem): Recipe {
  const c = dockerStartCommands(system);
  return systemRecipe("docker:start", "docker-start", c.commands, c.hosts, c.docs, false);
}

/** Joins the Python recipes into one (one environment, one pip call) and orders the batch: Docker, Python, prepare. */
export function mergeRecipes(recipes: Recipe[], env: NodeJS.ProcessEnv = process.env): Recipe[] {
  const seen = new Set<string>();
  const docker: Recipe[] = [];
  const prepare: Recipe[] = [];
  const packages: string[] = [];
  let python = false;
  for (const r of recipes) {
    if (r.kind === "python-packages") {
      python = true;
      packages.push(...(r.packages ?? []));
      continue;
    }
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    (r.kind === "prepare" ? prepare : docker).push(r);
  }
  const out = [...docker];
  if (python) out.push(pythonPackagesRecipe("python:packages", packages, env));
  return [...out, ...prepare];
}

export interface CommandOutcome {
  status: number | null;
  error?: string;
}

/** What runs the recipes. Tests give a fake one; the default spawns the commands and calls prepareInstance. */
export interface InstallExecutor {
  /** Runs one command (no shell). With `interactive`, the terminal's stdin reaches it (sudo, a package manager). */
  run(argv: string[], options: { env: NodeJS.ProcessEnv; interactive: boolean }): CommandOutcome | Promise<CommandOutcome>;
  prepare(projectDir: string, instance: string, env: NodeJS.ProcessEnv): Promise<void>;
}

export const defaultExecutor: InstallExecutor = {
  run(argv, options) {
    const [command, ...args] = argv;
    if (!command) return { status: null, error: "empty command" };
    // The command's output goes to stderr, so the doctor's stdout stays its own (and one JSON document with --json).
    const r = spawnSync(command, args, { stdio: [options.interactive ? "inherit" : "ignore", 2, 2], env: options.env, windowsHide: true });
    return r.error ? { status: r.status, error: r.error.message } : { status: r.status };
  },
  async prepare(projectDir, instance, env) {
    await prepareInstance(projectDir, instance, { env });
  },
};

export interface RecipeOutcome {
  id: string;
  kind: RecipeKind;
  status: "installed" | "failed" | "skipped";
  /** The command that failed, or why it was skipped. */
  message: string | null;
}

export interface ExecuteOptions {
  executor?: InstallExecutor;
  env?: NodeJS.ProcessEnv;
  /** Somebody said yes on the terminal to this recipe (required for a system recipe). */
  confirmed: boolean;
  /** The terminal's stdin may reach the command. */
  interactive: boolean;
}

/** Runs one recipe. A system recipe without a confirmation is skipped, and no recipe adds sudo by itself. */
export async function executeRecipe(recipe: Recipe, options: ExecuteOptions): Promise<RecipeOutcome> {
  const t = translator("prepare");
  const env = options.env ?? process.env;
  const executor = options.executor ?? defaultExecutor;
  const base = { id: recipe.id, kind: recipe.kind };
  if (!recipe.available) return { ...base, status: "skipped", message: recipe.reason };
  if (recipe.system && !options.confirmed) return { ...base, status: "skipped", message: t("prepare_recipe_needs_confirmation", { command: recipe.commands.join(" && ") }) };
  if (!recipe.system && recipe.steps.some((s) => s[0] === "sudo")) return { ...base, status: "skipped", message: t("prepare_recipe_no_sudo") };
  if (recipe.kind === "prepare") {
    try {
      await executor.prepare(recipe.projectDir as string, recipe.instance as string, env);
      return { ...base, status: "installed", message: null };
    } catch (error) {
      const fix = (error as { fix?: string | null }).fix;
      return { ...base, status: "failed", message: `${(error as Error).message}${fix ? ` ${fix}` : ""}` };
    }
  }
  if (recipe.kind === "python-packages" && recipe.createEnv) {
    // The parent of the environment is the data folder, created with owner-only permission.
    const home = ensureHome(resolveHome({ env }));
    fs.mkdirSync(toolsDir(home), { recursive: true, mode: 0o700 });
  }
  const childEnv: NodeJS.ProcessEnv = recipe.kind === "python-packages" ? { ...env, PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_REQUIRE_VIRTUALENV: "0" } : env;
  for (const step of recipe.steps) {
    const r = await executor.run(step, { env: childEnv, interactive: options.interactive });
    if (r.status !== 0) {
      const hint = recipe.kind === "python-packages" && step === recipe.createEnv ? ` ${t("prepare_recipe_venv_hint")}` : "";
      return { ...base, status: "failed", message: `${displayCommand(step)}: ${r.error ?? `exit ${r.status ?? "-"}`}.${hint}` };
    }
  }
  return { ...base, status: "installed", message: null };
}
