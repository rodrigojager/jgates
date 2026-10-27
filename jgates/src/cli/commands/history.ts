import fs from "node:fs";
import path from "node:path";
import type { CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { resolveHome } from "../../core/home/index.js";
import { workspaceId } from "../../core/ids/index.js";
import { listRuns, markRun } from "../../core/artifacts/index.js";

const t = translator("history");

export const command: CommandModule = {
  name: "history",
  description: t("history_description"),
  options: [
    { name: "cwd", type: "string", description: t("history_option_cwd") },
    { name: "limit", type: "string", description: t("history_option_limit") },
  ],
  run(ctx) {
    const sub = ctx.args[0];
    if (sub !== undefined && sub !== "preserve" && sub !== "unpreserve") return reportError(ctx, ctx.json, "UNKNOWN_SUBCOMMAND", t("history_unknown_subcommand", { name: sub }), t("history_unknown_subcommand_fix"), EXIT_USAGE);
    const cwdOption = ctx.options.cwd;
    const dir = path.resolve(typeof cwdOption === "string" ? cwdOption : process.cwd());
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return reportError(ctx, ctx.json, "BAD_CWD", t("history_bad_cwd", { path: dir }), t("history_bad_cwd_fix"), EXIT_USAGE);
    if (sub !== undefined) {
      const runId = ctx.args[1];
      if (!runId) return reportError(ctx, ctx.json, "MISSING_RUN", t("history_missing_run"), t("history_missing_run_fix"), EXIT_USAGE);
      const home = resolveHome();
      const id = workspaceId(dir);
      const run = listRuns(home, id).find((r) => r.runId === runId);
      if (!run) return reportError(ctx, ctx.json, "RUN_NOT_FOUND", t("history_run_not_found", { runId }), t("history_run_not_found_fix"), EXIT_USAGE);
      const marks = markRun(home, run.workspaceId, run.runId, { preserved: sub === "preserve" });
      if (ctx.json) writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, workspace: { id, path: dir }, runId, preserved: marks.preserved });
      else ctx.stdout(t(marks.preserved ? "history_preserved" : "history_unpreserved", { runId }) + "\n");
      return 0;
    }
    const rawLimit = ctx.options.limit;
    const limit = typeof rawLimit === "string" ? Number(rawLimit) : 20;
    if (!Number.isInteger(limit) || limit < 1) return reportError(ctx, ctx.json, "BAD_LIMIT", t("history_bad_limit", { value: String(rawLimit) }), t("history_bad_limit_fix"), EXIT_USAGE);

    const home = resolveHome();
    const id = workspaceId(dir);
    const runs = listRuns(home, id)
      .slice(0, limit)
      .map((r) => ({ runId: r.runId, workspaceId: r.workspaceId, startedAt: r.startedAt, decision: r.decision, partial: r.partial || r.reduced, reduced: r.reduced, bytes: r.bytes, baseline: r.marks.baseline, preserved: r.marks.preserved, dir: r.dir }));
    if (ctx.json) {
      writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, workspace: { id, path: dir }, runs });
      return 0;
    }
    if (runs.length === 0) ctx.stdout(t("history_empty") + "\n");
    for (const r of runs) ctx.stdout(`${r.runId}  ${r.startedAt ?? "-"}  ${r.decision ?? "-"}${r.partial ? "  [" + t("history_partial_tag") + "]" : ""}${r.baseline ? "  [" + t("history_baseline_tag") + "]" : ""}${r.preserved ? "  [" + t("history_preserved_tag") + "]" : ""}\n`);
    return 0;
  },
};
