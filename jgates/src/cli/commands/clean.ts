import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { resolveHome } from "../../core/home/index.js";
import {
  applyCleanup,
  engineContextFor,
  itemsJson,
  planCleanup,
  removeLegacySidecar,
  renderAppliedLine,
  renderPlanLines,
  type AppliedLine,
  type CleanScope,
} from "../../core/cleanup/index.js";
import { formatBytes } from "../../core/reasons/index.js";

const t = translator("cleanup");
const EXIT_PARTIAL = 2;
const WORKSPACE_ID = /^ws_[0-9a-f]{16}$/;

/** Asks y/N on the terminal; anything but yes is a no. */
export async function confirmOnTerminal(question: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "s" || answer === "sim" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

const interactive = (ctx: CommandContext): boolean => !ctx.json && ctx.options["no-interactive"] !== true && ctx.options.ci !== true && process.stdin.isTTY === true;

/**
 * `jgates clean [--images] [--data] [--toolchains] [--caches] [--workspace <id>] [--orphans] [--runs] [--dry-run] [--yes]`:
 * removes JGates objects that are not in use, selected by their labels only, and the runs retention of `jgates gc`. It always
 * lists first, with sizes; in a script (no terminal) without --yes it stays a dry run.
 */
export const command: CommandModule = {
  name: "clean",
  description: t("cleanup_clean_description"),
  options: [
    { name: "images", type: "boolean", description: t("cleanup_option_images") },
    { name: "data", type: "boolean", description: t("cleanup_option_data") },
    { name: "toolchains", type: "boolean", description: t("cleanup_option_toolchains") },
    { name: "caches", type: "boolean", description: t("cleanup_option_caches") },
    { name: "workspace", type: "string", description: t("cleanup_option_workspace") },
    { name: "orphans", type: "boolean", description: t("cleanup_option_orphans") },
    { name: "runs", type: "boolean", description: t("cleanup_option_runs") },
    { name: "legacy-sidecar", type: "boolean", description: t("cleanup_option_legacy_sidecar") },
    { name: "dry-run", type: "boolean", description: t("cleanup_option_dry_run") },
    { name: "yes", type: "boolean", description: t("cleanup_option_yes") },
  ],
  async run(ctx) {
    if (ctx.args[0] !== undefined) return reportError(ctx, ctx.json, "UNEXPECTED_ARGUMENT", t("cleanup_unexpected_argument", { name: ctx.args[0] }), t("cleanup_clean_usage"), EXIT_USAGE);
    const dry = ctx.options["dry-run"] === true;
    const yes = ctx.options.yes === true;
    if (dry && yes) return reportError(ctx, ctx.json, "DRY_RUN_WITH_YES", t("cleanup_dry_and_yes"), t("cleanup_dry_and_yes_fix"), EXIT_USAGE);
    const workspace = typeof ctx.options.workspace === "string" ? ctx.options.workspace : undefined;
    if (workspace !== undefined && !WORKSPACE_ID.test(workspace)) return reportError(ctx, ctx.json, "BAD_WORKSPACE", t("cleanup_bad_workspace", { id: workspace }), t("cleanup_bad_workspace_fix"), EXIT_USAGE);

    const scope: CleanScope = {
      ...(ctx.options.images === true ? { images: true } : {}),
      ...(ctx.options.data === true ? { data: true } : {}),
      ...(ctx.options.toolchains === true ? { toolchains: true } : {}),
      ...(ctx.options.caches === true ? { caches: true } : {}),
      ...(workspace ? { workspace } : {}),
      ...(ctx.options.orphans === true ? { orphans: true } : {}),
      ...(ctx.options.runs === true ? { runs: true } : {}),
    };
    const home = resolveHome();
    const plan = await planCleanup({ version: ctx.version, home, mode: "clean", scope });
    const legacy = ctx.options["legacy-sidecar"] === true;

    // A dry run is explicit (--dry-run) or implied: no --yes and nobody to ask.
    let go = yes && !dry;
    let asked = false;
    if (!go && !dry && interactive(ctx) && (plan.totals.remove > 0 || (legacy && plan.unmanaged.length > 0))) {
      for (const line of renderPlanLines(plan)) ctx.stdout(line + "\n");
      asked = true;
      go = await confirmOnTerminal(t("cleanup_confirm"));
      if (!go) ctx.stdout(t("cleanup_cancelled") + "\n");
    }

    let applied: Awaited<ReturnType<typeof applyCleanup>> | null = null;
    let legacyResults: Awaited<ReturnType<typeof removeLegacySidecar>> = [];
    const lines: AppliedLine[] = [];
    if (go) {
      const context = engineContextFor(process.env);
      applied = await applyCleanup(plan, home, context, (line) => {
        lines.push(line);
        if (!ctx.json) ctx.stdout(renderAppliedLine(line) + "\n");
      });
      if (legacy) legacyResults = await removeLegacySidecar(plan.unmanaged, context);
    }
    const failed = (applied?.failed ?? 0) + legacyResults.filter((r) => !r.removed).length;
    const exit = failed > 0 ? EXIT_PARTIAL : 0;
    const mode = applied ? "applied" : "dry-run";

    if (ctx.json) {
      writeJson(ctx, {
        schemaVersion: 1,
        status: "OK",
        tool: "jgates",
        version: ctx.version,
        home,
        mode,
        explicitDryRun: dry,
        scope,
        engine: plan.engine,
        items: itemsJson(plan.items),
        unmanaged: plan.unmanaged,
        retention: plan.retention ? { policy: plan.retention.policy, missingWorkspaces: plan.retention.missingWorkspaces } : null,
        totals: plan.totals,
        ...(applied
          ? {
              applied: {
                removed: applied.removed,
                inUse: applied.inUse,
                failed: applied.failed,
                freedBytes: applied.freedBytes,
                lines: applied.lines.map((l) => ({ resource: l.item.resource, id: l.item.id, name: l.item.name, outcome: l.outcome, freedBytes: l.freedBytes, ...(l.details ? { details: l.details } : {}) })),
                legacySidecar: legacyResults.map((r) => ({ name: r.image.name, id: r.image.id, removed: r.removed, ...(r.removed ? {} : { details: r.details }) })),
              },
            }
          : {}),
        exitCode: exit,
      });
      return exit;
    }

    if (!asked) for (const line of renderPlanLines(plan)) ctx.stdout(line + "\n");
    if (applied) {
      ctx.stdout(t("cleanup_summary_done", { count: applied.removed, size: formatBytes(applied.freedBytes) }) + "\n");
      if (applied.inUse + plan.totals.skipped > 0) ctx.stdout(t("cleanup_summary_done_in_use", { count: applied.inUse + plan.totals.skipped }) + "\n");
      if (applied.failed > 0) ctx.stdout(t("cleanup_summary_done_failed", { count: applied.failed }) + "\n");
      for (const r of legacyResults) ctx.stdout(t(r.removed ? "cleanup_legacy_removed" : "cleanup_legacy_kept", { name: r.image.name, reason: r.details.split(/\r?\n/)[0] ?? "" }) + "\n");
    } else if (plan.totals.remove === 0 && plan.totals.skipped === 0) {
      ctx.stdout(t("cleanup_nothing") + "\n");
    } else if (!asked || !go) {
      if (plan.totals.remove > 0) ctx.stdout(t("cleanup_summary_dry", { count: plan.totals.remove, size: formatBytes(plan.totals.removeBytes) }) + "\n");
      if (plan.totals.skipped > 0) ctx.stdout(t("cleanup_summary_skipped", { count: plan.totals.skipped }) + "\n");
      if (!asked && plan.totals.remove > 0) ctx.stdout(t("cleanup_summary_hint") + "\n");
    }
    return exit;
  },
};
