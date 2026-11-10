// Installation recipes: what JGates can prepare for a missing runtime, shown as a preview (the commands, the network
// hosts and where it writes) before anything runs. Container-first (ADR-0004), no tool is ever installed on the host:
//   - Docker is a system install: the official command of the detected system (apt, dnf, brew, winget), or the start
//     of an installed and stopped Docker. It runs only after a confirmation on the terminal; the command itself asks
//     for sudo where the system needs it;
//   - the JGates tools image is downloaded by the engine (`docker pull` of the reference this release pins);
//   - data an instance needs (the Semgrep registry rules) goes through `jgates tools prepare` (prepareInstance).
// Shared by `jgates doctor`, the prerequisites of the UI and the run that offers to prepare after a failure.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { translator } from "../../i18n/index.js";
import { EngineError, pullImage, type EngineContext } from "../engine/index.js";
import { resolveHome } from "../home/index.js";
import { LOCK_FILE } from "../lock/index.js";
import { prepareCommand, prepareInstance, toolsDir } from "../prepare/index.js";
import { displayCommand, dockerInstallCommands, dockerStartCommands, type HostSystem } from "./system.js";

export type RecipeKind = "docker-install" | "docker-start" | "image-pull" | "prepare";

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
  /** The argv of each command (no shell). Empty for kinds prepare and image-pull, which run in process. */
  steps: string[][];
  /** kind prepare: the instance and the project. */
  instance?: string;
  projectDir?: string;
  /** kind image-pull: the image reference the engine pulls. */
  image?: string;
}

/** The public part of a recipe (what --json prints). */
export function previewOf(recipe: Recipe): RecipePreview {
  const { id, kind, commands, network, writes, system, available, reason } = recipe;
  return { id, kind, commands: [...commands], network: { hosts: [...network.hosts], systemMirrors: network.systemMirrors }, writes: [...writes], system, available, reason };
}

/** `jgates tools prepare --instance <id>`: the rule set of an instance, pinned in .jgates/lock.json. */
export function prepareRecipe(input: { instance: string; projectDir: string; hosts: string[]; available: boolean; reason: string | null; env?: NodeJS.ProcessEnv }): Recipe {
  const home = resolveHome({ env: input.env ?? process.env });
  return {
    id: `prepare:${input.instance}`,
    kind: "prepare",
    commands: [prepareCommand(input.instance, input.projectDir)],
    network: { hosts: [...input.hosts], systemMirrors: false },
    writes: [path.join(input.projectDir, LOCK_FILE), toolsDir(home)],
    system: false,
    available: input.available,
    reason: input.reason,
    steps: [],
    instance: input.instance,
    projectDir: input.projectDir,
  };
}

/** The JGates tools image, pulled by the engine (`available` false with the reason when this release pins nothing to pull). */
export function imagePullRecipe(input: { reference: string; hosts: string[]; available: boolean; reason: string | null }): Recipe {
  return {
    id: "image:pull",
    kind: "image-pull",
    commands: [displayCommand(["docker", "pull", input.reference])],
    network: { hosts: [...input.hosts], systemMirrors: false },
    writes: [],
    system: false,
    available: input.available,
    reason: input.reason,
    steps: [],
    image: input.reference,
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

/** Orders a batch without duplicates: Docker first, then the tools image, then the data preparations. */
export function mergeRecipes(recipes: Recipe[]): Recipe[] {
  const seen = new Set<string>();
  const unique = recipes.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  const rank = (r: Recipe): number => (r.kind === "docker-install" || r.kind === "docker-start" ? 0 : r.kind === "image-pull" ? 1 : 2);
  return unique.sort((a, b) => rank(a) - rank(b));
}

export interface CommandOutcome {
  status: number | null;
  error?: string;
}

/** What runs the recipes. Tests give a fake one; the default spawns the commands, calls prepareInstance and pulls
 * through the engine module. */
export interface InstallExecutor {
  /** Runs one command (no shell). With `interactive`, the terminal's stdin reaches it (sudo, a package manager). */
  run(argv: string[], options: { env: NodeJS.ProcessEnv; interactive: boolean }): CommandOutcome | Promise<CommandOutcome>;
  prepare(projectDir: string, instance: string, env: NodeJS.ProcessEnv): Promise<void>;
  /** Pulls the image (kind image-pull); absent: the engine module's pull. */
  pull?(reference: string, env: NodeJS.ProcessEnv): Promise<CommandOutcome>;
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
  async pull(reference, env) {
    const context: EngineContext = { runnerOptions: { parentEnv: env } };
    try {
      await pullImage(reference, {}, context);
      return { status: 0 };
    } catch (error) {
      const details = error instanceof EngineError ? error.details : "";
      return { status: 1, error: `${(error as Error).message}${details ? `: ${details}` : ""}` };
    }
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
  if (recipe.kind === "image-pull") {
    const pull = executor.pull ?? defaultExecutor.pull;
    const r = pull ? await pull(recipe.image as string, env) : { status: null, error: "no engine" };
    return r.status === 0 ? { ...base, status: "installed", message: null } : { ...base, status: "failed", message: `${recipe.commands.join(" ")}: ${r.error ?? `exit ${r.status ?? "-"}`}` };
  }
  for (const step of recipe.steps) {
    const r = await executor.run(step, { env, interactive: options.interactive });
    if (r.status !== 0) return { ...base, status: "failed", message: `${displayCommand(step)}: ${r.error ?? `exit ${r.status ?? "-"}`}.` };
  }
  return { ...base, status: "installed", message: null };
}
