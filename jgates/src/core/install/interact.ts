// The conversation that installs what is missing, shared by `jgates doctor` and the run that failed for lack of a
// tool. On a terminal it asks first about the essential items and then, apart, about the optional ones (saying the
// alternative); any answer but yes cancels that group without installing. --yes installs the essential items without
// asking (and the optional ones with --include-optional), except a system recipe (Docker), which always waits for a
// yes on the terminal. With --json, --ci or without a terminal it never asks.
import readline from "node:readline";
import { translator } from "../../i18n/index.js";
import type { Assessment, ItemAssessment } from "./assess.js";
import { executeRecipe, mergeRecipes, type InstallExecutor, type Recipe, type RecipeOutcome, type RecipePreview } from "./recipes.js";

export interface InstallTerminal {
  /** A person can answer (stdin is a terminal, and neither --json, --ci nor --no-interactive was given). */
  interactive: boolean;
  /** Asks one question and returns the answer line ("" at the end of the input). */
  ask(question: string): Promise<string>;
}

/** A terminal that never asks: what --json, --ci and a missing terminal get. */
export const NO_TERMINAL: InstallTerminal = { interactive: false, ask: async () => "" };

/**
 * A terminal over a stream of lines. Lines that arrive before a question are kept for the next one, so a piped
 * answer ("s\nn\n") reaches each question in order; the end of the input answers "" (no) to the rest.
 */
export function lineTerminal(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, interactive = true): InstallTerminal & { close(): void } {
  const rl = readline.createInterface({ input, terminal: false });
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let ended = false;
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    ended = true;
    while (waiting.length > 0) waiting.shift()?.("");
  });
  return {
    interactive,
    ask(question) {
      output.write(question);
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (ended) return Promise.resolve("");
      return new Promise((resolve) => waiting.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}

export const isYes = (answer: string): boolean => ["s", "sim", "y", "yes"].includes(answer.trim().toLowerCase());

export interface OfferOptions {
  /** --fix: ask even when nothing essential is missing. */
  fix: boolean;
  /** --yes: install the essential items without asking. */
  yes: boolean;
  /** --include-optional: the optional items go with the essential ones. */
  includeOptional: boolean;
  terminal: InstallTerminal;
  /** Where the lists and the progress go. */
  out: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  executor?: InstallExecutor;
}

export interface InstallSession {
  /** The groups a question was asked for, in order. */
  asked: Array<"essential" | "optional" | "all">;
  /** The groups that were accepted (by an answer or by --yes). */
  accepted: Array<"essential" | "optional" | "all">;
  outcomes: RecipeOutcome[];
  /** Missing items JGates has no recipe for here (or a recipe it cannot run): what to do by hand. */
  manual: Array<{ key: string; reason: string | null }>;
  /** Whether a recipe ran (the doctor diagnoses again). */
  ran: boolean;
  /** Whether a recipe that ran failed. */
  failed: boolean;
}

function describe(item: ItemAssessment, t: ReturnType<typeof translator>): string[] {
  const lines = [`  - ${item.name}`];
  if (item.alternative) lines.push(`    ${t("prepare_offer_alternative", { alternative: item.alternative.message, command: item.alternative.command })}`);
  const recipe = item.recipe as RecipePreview;
  for (const c of recipe.commands) lines.push(`    $ ${c}`);
  const hosts = recipe.network.hosts.length > 0 ? recipe.network.hosts.join(", ") : recipe.network.systemMirrors ? t("prepare_offer_system_mirrors") : t("prepare_offer_no_network");
  lines.push(`    ${t("prepare_offer_network", { hosts })}`);
  if (recipe.writes.length > 0) lines.push(`    ${t("prepare_offer_writes", { paths: recipe.writes.join(", ") })}`);
  if (recipe.system) lines.push(`    ${t("prepare_offer_system")}`);
  return lines;
}

/** Offers (and runs) the recipes of the missing items; returns what happened. Never asks without a terminal. */
export async function offerInstall(assessment: Assessment, options: OfferOptions): Promise<InstallSession> {
  const t = translator("prepare");
  const session: InstallSession = { asked: [], accepted: [], outcomes: [], manual: [], ran: false, failed: false };
  const missing = assessment.items.filter((i) => i.missing && i.classification !== "unused");
  for (const i of missing) if (!i.recipe || !i.recipe.available) session.manual.push({ key: i.key, reason: i.recipe?.reason ?? null });
  const runnable = (classification: "essential" | "optional") => missing.filter((i) => i.classification === classification && i.recipe?.available);
  const essential = runnable("essential");
  const optional = runnable("optional");
  const { terminal } = options;

  const run = async (group: ItemAssessment[], confirmed: boolean) => {
    const recipes = mergeRecipes(group.map((i) => assessment.recipes.get(i.key)).filter((r): r is Recipe => r !== undefined), options.env);
    for (const recipe of recipes) {
      let ok = confirmed;
      if (recipe.system && !confirmed && terminal.interactive) {
        // --yes never covers a system command: it waits for its own yes.
        options.out(`${t("prepare_offer_system_header")}\n${recipe.commands.map((c) => `  $ ${c}`).join("\n")}\n`);
        ok = isYes(await terminal.ask(t("prepare_offer_system_confirm")));
      }
      if (!recipe.system) ok = true;
      if (recipe.available && ok) options.out(`${t("prepare_offer_running", { commands: recipe.commands.join(" && ") })}\n`);
      const outcome = await executeRecipe(recipe, { ...(options.executor ? { executor: options.executor } : {}), ...(options.env ? { env: options.env } : {}), confirmed: ok, interactive: terminal.interactive });
      session.outcomes.push(outcome);
      if (outcome.status !== "skipped") session.ran = true;
      if (outcome.status === "failed") session.failed = true;
      options.out(`${t(`prepare_offer_outcome_${outcome.status}`, { id: recipe.id, message: outcome.message ?? "" })}\n`);
    }
  };

  const ask = async (group: "essential" | "optional" | "all", list: ItemAssessment[]): Promise<boolean> => {
    options.out(`${t(`prepare_offer_header_${group}`)}\n${list.flatMap((i) => describe(i, t)).join("\n")}\n`);
    session.asked.push(group);
    const yes = isYes(await terminal.ask(t(`prepare_offer_confirm_${group}`)));
    if (!yes) options.out(`${t("prepare_offer_cancelled")}\n`);
    return yes;
  };

  if (options.yes) {
    const group = options.includeOptional ? [...essential, ...optional] : essential;
    if (group.length > 0) {
      session.accepted.push(options.includeOptional ? "all" : "essential");
      options.out(`${t(options.includeOptional ? "prepare_offer_header_all" : "prepare_offer_header_essential")}\n${group.flatMap((i) => describe(i, t)).join("\n")}\n`);
      await run(group, false);
    }
    return session;
  }
  if (!terminal.interactive) return session;
  if (!options.fix && essential.length === 0) return session;
  if (options.includeOptional) {
    const all = [...essential, ...optional];
    if (all.length > 0 && (await ask("all", all))) {
      session.accepted.push("all");
      await run(all, true);
    }
    return session;
  }
  if (essential.length > 0 && (await ask("essential", essential))) {
    session.accepted.push("essential");
    await run(essential, true);
  }
  if (optional.length > 0 && (await ask("optional", optional))) {
    session.accepted.push("optional");
    await run(optional, true);
  }
  return session;
}
