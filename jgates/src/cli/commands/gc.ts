import type { CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { resolveHome } from "../../core/home/index.js";
import { applyRetention, DEFAULT_RETENTION, planRetention } from "../../core/artifacts/index.js";
import type { RetentionPolicy } from "../../core/artifacts/index.js";
import { applyPiiFixRetention, planPiiFixRetention } from "../../core/pii-fix/index.js";

const t = translator("gc");
const tp = translator("pii");
const MIB = 1024 * 1024;

function parseNumber(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export const command: CommandModule = {
  name: "gc",
  description: t("gc_description"),
  options: [
    { name: "dry-run", type: "boolean", description: t("gc_option_dry_run") },
    { name: "yes", type: "boolean", description: t("gc_option_yes") },
    { name: "max-age-days", type: "string", description: t("gc_option_max_age_days") },
    { name: "max-workspace-mb", type: "string", description: t("gc_option_max_workspace_mb") },
    { name: "max-total-mb", type: "string", description: t("gc_option_max_total_mb") },
  ],
  run(ctx) {
    if (ctx.args[0] !== undefined) return reportError(ctx, ctx.json, "UNEXPECTED_ARGUMENT", t("gc_unexpected_argument", { name: ctx.args[0] }), t("gc_unexpected_argument_fix"), EXIT_USAGE);
    const dry = ctx.options["dry-run"] === true;
    const yes = ctx.options.yes === true;
    if (dry && yes) return reportError(ctx, ctx.json, "DRY_RUN_WITH_YES", t("gc_dry_and_yes"), t("gc_dry_and_yes_fix"), EXIT_USAGE);

    const policy: RetentionPolicy = { ...DEFAULT_RETENTION };
    const sources: [string, string, string | undefined, (n: number) => void][] = [
      ["--max-age-days", "JGATES_RETENTION_DAYS", undefined, (n) => (policy.maxAgeDays = n)],
      ["--max-workspace-mb", "JGATES_RETENTION_WORKSPACE_MB", undefined, (n) => (policy.maxWorkspaceBytes = n * MIB)],
      ["--max-total-mb", "JGATES_RETENTION_TOTAL_MB", undefined, (n) => (policy.maxTotalBytes = n * MIB)],
    ];
    for (const [flag, envName, , set] of sources) {
      const fromFlag = ctx.options[flag.slice(2)];
      const raw = typeof fromFlag === "string" ? fromFlag : process.env[envName];
      const n = parseNumber(raw);
      if (n === null) return reportError(ctx, ctx.json, "BAD_NUMBER", t("gc_bad_number", { name: typeof fromFlag === "string" ? flag : envName, value: String(raw) }), t("gc_bad_number_fix"), EXIT_USAGE);
      if (n !== undefined) set(n);
    }

    const home = resolveHome();
    const plan = planRetention(home, policy);
    // The originals kept by `jgates pii fix --undo` hold personal data: they go when their own expiry passes.
    const piiFix = planPiiFixRetention(home);
    const piiFixBytes = piiFix.reduce((n, b) => n + b.bytes, 0);
    const piiFixApplied = yes ? applyPiiFixRetention(home, piiFix) : null;
    const applied = yes ? applyRetention(home, plan) : null;
    const mode = applied ? "applied" : dry ? "dry-run" : "none";

    if (ctx.json) {
      writeJson(ctx, {
        schemaVersion: 1,
        status: "OK",
        tool: "jgates",
        version: ctx.version,
        home,
        mode,
        policy,
        runs: plan.runs,
        missingWorkspaces: plan.missingWorkspaces,
        freedBytes: plan.freedBytes,
        piiFix: { expired: piiFix.map(({ dir: _dir, ...b }) => b), freedBytes: piiFixBytes },
        ...(applied ? { applied: { ...applied, piiFixRemoved: (piiFixApplied?.removed ?? []).map(({ dir: _dir, ...b }) => b) } } : {}),
      });
      return 0;
    }
    if (plan.runs.length === 0 && plan.missingWorkspaces.length === 0 && piiFix.length === 0) ctx.stdout(t("gc_text_nothing") + "\n");
    for (const b of piiFix) ctx.stdout(tp("pii_gc_text_backup", { workspace: b.workspaceId, id: b.fixId, bytes: b.bytes }) + "\n");
    for (const r of plan.runs) ctx.stdout(t("gc_text_run", { reason: r.reason, workspace: r.workspaceId, run: r.runId, bytes: r.bytes }) + "\n");
    for (const w of plan.missingWorkspaces) {
      ctx.stdout(t("gc_text_missing", { id: w.id, path: w.path, kept: w.keptRuns.length ? " " + t("gc_text_kept", { runs: w.keptRuns.join(", ") }) : "" }) + "\n");
    }
    if (applied) {
      ctx.stdout(t("gc_text_summary_done", { count: applied.removedRuns.length, workspaces: applied.removedWorkspaces.length, bytes: applied.freedBytes }) + "\n");
      for (const s of applied.skipped) ctx.stdout(t("gc_text_skipped", { path: s.path, reason: s.reason }) + "\n");
      if (piiFixApplied && piiFixApplied.removed.length > 0) ctx.stdout(tp("pii_gc_text_removed", { count: piiFixApplied.removed.length, bytes: piiFixApplied.freedBytes }) + "\n");
    } else if (plan.runs.length > 0 || plan.missingWorkspaces.some((w) => w.removable)) {
      ctx.stdout(t(dry ? "gc_text_summary_dry" : "gc_text_summary_none", { count: plan.runs.length, bytes: plan.freedBytes }) + "\n");
    }
    if (!applied && piiFix.length > 0) ctx.stdout(tp("pii_gc_text_pending", { count: piiFix.length, bytes: piiFixBytes }) + "\n");
    return 0;
  },
};
