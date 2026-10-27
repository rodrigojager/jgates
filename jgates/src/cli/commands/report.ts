import fs from "node:fs";
import path from "node:path";
import type { CommandModule } from "../command.js";
import { EXIT_USAGE, reportError } from "../output.js";
import { translator } from "../../i18n/index.js";
import { resolveHome } from "../../core/home/index.js";
import { workspaceId } from "../../core/ids/index.js";
import { listRuns } from "../../core/artifacts/index.js";
import { toSarif } from "../../core/results/index.js";
import { buildAgentContext } from "../../core/agent-context/index.js";
import type { RunResult } from "../../core/run/types.js";

const t = translator("report");

export const command: CommandModule = {
  name: "report",
  description: t("report_description"),
  options: [
    { name: "cwd", type: "string", description: t("report_option_cwd") },
    { name: "format", type: "string", description: t("report_option_format") },
    { name: "out", type: "string", description: t("report_option_out") },
    { name: "agent-context", type: "boolean", description: t("report_option_agent_context") },
  ],
  run(ctx) {
    const runId = ctx.args[0];
    if (!runId) return reportError(ctx, ctx.json, "MISSING_RUN", t("report_missing_run"), t("report_missing_run_fix"), EXIT_USAGE);
    const format = typeof ctx.options.format === "string" ? ctx.options.format : "json";
    if (format !== "json" && format !== "sarif") return reportError(ctx, ctx.json, "BAD_FORMAT", t("report_bad_format", { value: format }), t("report_bad_format_fix"), EXIT_USAGE);
    const agentContext = ctx.options["agent-context"] === true;
    if (agentContext && format === "sarif") return reportError(ctx, ctx.json, "BAD_FORMAT", t("report_agent_context_format"), t("report_agent_context_format_fix"), EXIT_USAGE);
    const cwdOption = ctx.options.cwd;
    const dir = path.resolve(typeof cwdOption === "string" ? cwdOption : process.cwd());
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return reportError(ctx, ctx.json, "BAD_CWD", t("report_bad_cwd", { path: dir }), t("report_bad_cwd_fix"), EXIT_USAGE);

    const run = listRuns(resolveHome(), workspaceId(dir)).find((r) => r.runId === runId);
    if (!run) return reportError(ctx, ctx.json, "RUN_NOT_FOUND", t("report_run_not_found", { runId }), t("report_run_not_found_fix"), EXIT_USAGE);
    let raw: string;
    let doc: RunResult;
    try {
      raw = fs.readFileSync(path.join(run.dir, "result.json"), "utf8");
      doc = JSON.parse(raw) as RunResult;
    } catch {
      return reportError(ctx, ctx.json, "RESULT_UNREADABLE", t("report_unreadable", { runId }), t("report_unreadable_fix"), EXIT_USAGE);
    }

    // agent-context: the safe summary for a coding agent (same text as the UI button). json: the result.json itself, byte
    // for byte. sarif: the findings only.
    const context = agentContext ? buildAgentContext(doc) : null;
    const text = context ? (ctx.json ? JSON.stringify({ schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, runId, format: "agent-context", agentContext: context }) + "\n" : context.text) : format === "json" ? raw : JSON.stringify(toSarif(doc), null, 2) + "\n";
    const out = ctx.options.out;
    if (typeof out === "string" && out !== "") {
      const file = path.resolve(out);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text, { mode: 0o600 });
      } catch (error) {
        return reportError(ctx, ctx.json, "WRITE_FAILED", t("report_write_failed", { path: file, reason: error instanceof Error ? error.message : String(error) }), t("report_write_failed_fix"), EXIT_USAGE);
      }
      if (!ctx.json) ctx.stdout(t("report_written", { path: file }) + "\n");
      else ctx.stdout(JSON.stringify({ schemaVersion: 1, status: "OK", tool: "jgates", version: ctx.version, runId, format, out: file }) + "\n");
      return 0;
    }
    ctx.stdout(text);
    return 0;
  },
};
