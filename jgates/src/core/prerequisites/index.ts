// What has to be in place before a validation can run, as a short list the UI shows on top of the Overview and the
// Environment screens, each with the one action that fixes it:
//   - docker: Docker is installed but stopped (start it) or absent (install it), when an enabled check runs in it;
//   - git: Git refuses to read the project's repository because of its ownership (safe.directory);
//   - tools: the tools JGates installs itself (its Python environment, prepared rules and images);
//   - manual:<key>: anything else that is missing and that JGates cannot fix here (it carries the instruction).
// The list is read-only. `fixPrerequisite` runs the action of one item, and only when a person confirmed it in the UI:
// commands that need sudo never run here (no terminal to ask for the password); the UI shows them to copy instead.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { assessEnvironment, executeRecipe, mergeRecipes, type Assessment, type InstallExecutor, type Recipe, type RecipeOutcome } from "../install/index.js";
import { displayCommand } from "../install/system.js";
import { gitContext, resolveGit } from "../snapshot/git.js";

export type PrerequisiteKind = "docker-start" | "docker-install" | "git-trust" | "tools-install" | "manual";

/** run: the UI runs it after a confirmation; copy: the person runs it in a terminal (sudo); null: only the text. */
export type PrerequisiteAction = "run" | "copy" | null;

export interface Prerequisite {
  id: string;
  kind: PrerequisiteKind;
  /** essential: an enabled check does not run without it; optional: there is an alternative. */
  classification: "essential" | "optional";
  /** What is missing: tool instances, the runtime id or the refused folder. */
  names: string[];
  /** The command lines, as they are shown before anything runs. */
  commands: string[];
  action: PrerequisiteAction;
  /** Network hosts the action reaches. */
  hosts: string[];
  /** Why it is missing (manual items) or why the action cannot run here. */
  message: string | null;
  fix: string | null;
}

export interface PrerequisiteReport {
  /** No essential item is missing. */
  ready: boolean;
  platform: NodeJS.Platform;
  items: Prerequisite[];
}

export interface PrerequisiteOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** An assessment already made; made here when absent. */
  assessment?: Assessment;
  executor?: InstallExecutor;
}

const usesSudo = (recipe: { commands: string[] }): boolean => recipe.commands.some((c) => c === "sudo" || c.startsWith("sudo "));

/** The folder in the command Git suggests (`git config --global --add safe.directory '<folder>'`), without quotes. */
export function safeDirectoryOf(fix: string): string | null {
  const m = /safe\.directory\s+(.+)$/.exec(fix.trim());
  if (!m?.[1]) return null;
  const raw = m[1].trim();
  const unquoted = /^(['"])(.*)\1$/.exec(raw)?.[2] ?? raw;
  return unquoted === "" || unquoted.startsWith("-") ? null : unquoted;
}

/** Whether `folder` is the project folder or one of its parents (the only folders the UI may mark as safe). */
function containsProject(folder: string, projectDir: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const a = norm(folder);
  const b = norm(projectDir);
  return b === a || b.startsWith(`${a}/`);
}

function gitItem(projectDir: string, env: NodeJS.ProcessEnv): Prerequisite | null {
  const context = gitContext(projectDir, env);
  if (context.repository || !context.available || context.problem?.code !== "UNSAFE_REPOSITORY") return null;
  const folder = context.problem.fix ? safeDirectoryOf(context.problem.fix) : null;
  const valid = folder !== null && containsProject(folder, projectDir);
  return {
    id: "git",
    kind: "git-trust",
    classification: "essential",
    names: folder ? [folder] : [],
    commands: valid ? [displayCommand(["git", "config", "--global", "--add", "safe.directory", folder])] : context.problem.fix ? [context.problem.fix] : [],
    action: valid ? "run" : context.problem.fix ? "copy" : null,
    hosts: [],
    message: context.problem.message,
    fix: context.problem.fix,
  };
}

/** The list of what is missing, in the order it should be fixed: Docker, Git, the tools, then the manual items. */
export function listPrerequisites(projectDir: string, options: PrerequisiteOptions = {}): PrerequisiteReport {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const assessment = options.assessment ?? assessEnvironment(projectDir, { env });
  const items: Prerequisite[] = [];
  const manual: Prerequisite[] = [];
  const missing = assessment.items.filter((i) => i.missing && i.classification !== "unused");
  const classOf = (c: string): "essential" | "optional" => (c === "essential" ? "essential" : "optional");

  for (const r of assessment.report.runtimes) {
    const item = missing.find((i) => i.key === `runtime:${r.id}`);
    if (!item) continue;
    if (r.id === "docker" && item.recipe) {
      const recipe = item.recipe;
      items.push({
        id: "docker",
        kind: r.stopped ? "docker-start" : "docker-install",
        classification: classOf(item.classification),
        names: ["docker"],
        commands: recipe.commands,
        action: !recipe.available ? null : usesSudo(recipe) ? "copy" : "run",
        hosts: recipe.network.hosts,
        message: recipe.available ? null : recipe.reason,
        fix: r.fix,
      });
      continue;
    }
    manual.push({ id: `manual:runtime:${r.id}`, kind: "manual", classification: classOf(item.classification), names: [r.id], commands: [], action: null, hosts: [], message: r.message, fix: r.fix });
  }

  const git = gitItem(projectDir, env);
  if (git) items.push(git);

  const installable = missing.filter((i) => i.key.startsWith("tool:") && i.recipe?.available && !i.recipe.system);
  if (installable.length > 0) {
    const recipes = mergeRecipes(installable.map((i) => assessment.recipes.get(i.key)).filter((r): r is Recipe => r !== undefined), env);
    items.push({
      id: "tools",
      kind: "tools-install",
      classification: installable.some((i) => i.classification === "essential") ? "essential" : "optional",
      names: installable.map((i) => i.name),
      commands: recipes.flatMap((r) => r.commands),
      action: "run",
      hosts: [...new Set(recipes.flatMap((r) => r.network.hosts))],
      message: null,
      fix: null,
    });
  }
  for (const i of missing.filter((x) => x.key.startsWith("tool:") && !installable.includes(x))) {
    const tool = assessment.report.tools.find((x) => `tool:${x.instance}` === i.key);
    manual.push({
      id: `manual:${i.key}`,
      kind: "manual",
      classification: classOf(i.classification),
      names: [i.name],
      commands: [],
      action: null,
      hosts: [],
      message: i.recipe?.reason ?? tool?.message ?? null,
      fix: tool?.fix ?? i.alternative?.command ?? null,
    });
  }

  const all = [...items, ...manual];
  return { ready: !all.some((i) => i.classification === "essential"), platform, items: all };
}

export interface FixOutcome {
  id: string;
  status: "done" | "failed" | "skipped";
  message: string | null;
  /** Each recipe that ran, for the tools item. */
  outcomes: RecipeOutcome[];
}

export class PrerequisiteError extends Error {
  constructor(
    public code: "PREREQUISITE_NOT_FOUND" | "PREREQUISITE_NOT_RUNNABLE",
    message: string,
  ) {
    super(message);
  }
}

/** Runs the action of one item of the list; the caller has the person's confirmation. Never runs sudo. */
export async function fixPrerequisite(projectDir: string, id: string, options: PrerequisiteOptions = {}): Promise<FixOutcome> {
  const env = options.env ?? process.env;
  const assessment = options.assessment ?? assessEnvironment(projectDir, { env });
  const report = listPrerequisites(projectDir, { ...options, env, assessment });
  const item = report.items.find((i) => i.id === id);
  if (!item) throw new PrerequisiteError("PREREQUISITE_NOT_FOUND", id);
  if (item.action !== "run") throw new PrerequisiteError("PREREQUISITE_NOT_RUNNABLE", id);
  const exec = options.executor ? { executor: options.executor } : {};

  if (item.kind === "git-trust") {
    const folder = item.names[0] as string;
    const git = resolveGit(env) ?? "git";
    const argv = [git, "config", "--global", "--add", "safe.directory", folder];
    const r = options.executor ? await options.executor.run(argv, { env, interactive: false }) : spawnOnce(argv, env);
    return r.status === 0 ? { id, status: "done", message: null, outcomes: [] } : { id, status: "failed", message: `${displayCommand(argv.slice(1))}: ${r.error ?? `exit ${r.status ?? "-"}`}`, outcomes: [] };
  }

  const keys = item.kind === "tools-install" ? item.names.map((n) => `tool:${n}`) : [`runtime:${item.names[0]}`];
  const recipes = mergeRecipes(keys.map((k) => assessment.recipes.get(k)).filter((r): r is Recipe => r !== undefined), env);
  const outcomes: RecipeOutcome[] = [];
  for (const recipe of recipes) outcomes.push(await executeRecipe(recipe, { ...exec, env, confirmed: true, interactive: false }));
  const failed = outcomes.find((o) => o.status === "failed");
  const skipped = outcomes.find((o) => o.status === "skipped");
  if (failed) return { id, status: "failed", message: failed.message, outcomes };
  if (skipped) return { id, status: "skipped", message: skipped.message, outcomes };
  return { id, status: "done", message: null, outcomes };
}

function spawnOnce(argv: string[], env: NodeJS.ProcessEnv): { status: number | null; error?: string } {
  const [command, ...args] = argv;
  const r = spawnSync(command as string, args, { stdio: "ignore", env, windowsHide: true });
  return r.error ? { status: r.status, error: r.error.message } : { status: r.status };
}
