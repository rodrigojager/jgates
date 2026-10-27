import fs from "node:fs";
import path from "node:path";
import type { CommandModule, CommandContext } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { resolveHome } from "../../core/home/index.js";
import { workspaceId } from "../../core/ids/index.js";
import { listRuns, markRun } from "../../core/artifacts/index.js";
import { assignFingerprints, compareWithBaseline } from "../../core/results/index.js";
import type { RunResult } from "../../core/run/types.js";

const t = translator("baseline");

function readResult(dir: string): RunResult | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")) as RunResult;
  } catch {
    return null;
  }
}

export const command: CommandModule = {
  name: "baseline",
  description: t("baseline_description"),
  options: [{ name: "cwd", type: "string", description: t("baseline_option_cwd") }],
  run(ctx: CommandContext) {
    const sub = ctx.args[0] ?? "show";
    if (!["set", "clear", "show", "compare"].includes(sub)) return reportError(ctx, ctx.json, "UNKNOWN_SUBCOMMAND", t("baseline_unknown_subcommand", { name: sub }), t("baseline_unknown_subcommand_fix"), EXIT_USAGE);
    const cwdOption = ctx.options.cwd;
    const dir = path.resolve(typeof cwdOption === "string" ? cwdOption : process.cwd());
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return reportError(ctx, ctx.json, "BAD_CWD", t("baseline_bad_cwd", { path: dir }), t("baseline_bad_cwd_fix"), EXIT_USAGE);
    const home = resolveHome();
    const id = workspaceId(dir);
    const runs = listRuns(home, id);
    const current = runs.find((r) => r.marks.baseline);
    const say = (body: Record<string, unknown>, line: string): number => {
      if (ctx.json) writeJson(ctx, { schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, workspace: { id, path: dir }, ...body });
      else ctx.stdout(line + "\n");
      return 0;
    };
    const needRun = (): string | null => ctx.args[1] ?? null;

    if (sub === "show") return say({ baseline: current?.runId ?? null }, current ? t("baseline_set", { runId: current.runId }) : t("baseline_none"));

    if (sub === "clear") {
      for (const r of runs) if (r.marks.baseline) markRun(home, r.workspaceId, r.runId, { baseline: false });
      return say({ baseline: null }, t("baseline_cleared"));
    }

    const runId = needRun();
    if (!runId) return reportError(ctx, ctx.json, "MISSING_RUN", t("baseline_missing_run"), t("baseline_missing_run_fix"), EXIT_USAGE);
    const run = runs.find((r) => r.runId === runId);
    if (!run) return reportError(ctx, ctx.json, "RUN_NOT_FOUND", t("baseline_run_not_found", { runId }), t("baseline_run_not_found_fix"), EXIT_USAGE);

    if (sub === "set") {
      if (run.partial) return reportError(ctx, ctx.json, "RUN_UNFINISHED", t("baseline_run_unfinished", { runId }), t("baseline_run_unfinished_fix"), EXIT_USAGE);
      for (const r of runs) if (r.marks.baseline && r.runId !== runId) markRun(home, r.workspaceId, r.runId, { baseline: false });
      markRun(home, run.workspaceId, run.runId, { baseline: true });
      return say({ baseline: runId }, t("baseline_set", { runId }));
    }

    // compare <runId>: the run against the baseline (a run is never its own baseline).
    if (!current || current.runId === runId) return reportError(ctx, ctx.json, "NO_BASELINE", t("baseline_no_baseline"), t("baseline_no_baseline_fix"), EXIT_USAGE);
    const base = readResult(current.dir);
    const now = readResult(run.dir);
    if (!base || !now) return reportError(ctx, ctx.json, "RESULT_UNREADABLE", t("baseline_run_unfinished", { runId: base ? runId : current.runId }), t("baseline_run_unfinished_fix"), EXIT_USAGE);
    // Results written before fingerprints v1 get them now, so the two sides speak the same language.
    base.findings = assignFingerprints(base.findings ?? []);
    now.findings = assignFingerprints(now.findings ?? []);
    const cmp = compareWithBaseline(base, now);
    const codes = cmp.warnings.map((w) => w.code).join(", ");
    let line = t("baseline_compare_line", { new: cmp.new, resolved: cmp.resolved.length, kept: cmp.kept });
    if (!cmp.comparable) line += "\n" + t("baseline_not_comparable", { codes });
    return say({ runId, comparison: cmp }, line);
  },
};
