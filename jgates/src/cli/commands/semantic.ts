// `jgates semantic plan|run|status|cancel|history`: independent Semantic runs, apart from Quality. A Semantic run has
// its own sem_ ID, folder and history; it needs no Quality run (a Quality report is attached only with --quality, as
// evidence with its freshness). `jgates run` stays the Quality run and never calls a provider unless --semantic asks for
// the advisory review. stdout carries one JSON document with --json; progress goes to stderr; events to events.jsonl.
import fs from "node:fs";
import path from "node:path";
import type { CommandContext, CommandModule } from "../command.js";
import { EXIT_USAGE, reportError, writeJson } from "../output.js";
import { translator } from "../../i18n/index.js";
import { resolveHome } from "../../core/home/index.js";
import { workspaceId } from "../../core/ids/index.js";
import type { RunEvent } from "../../core/events/index.js";
import {
  SemanticRunError,
  buildSemanticPlan,
  executeSemanticRun,
  isSemanticRunId,
  listSemanticRuns,
  readSemanticRun,
  requestSemanticCancel,
  type SemanticPlan,
} from "../../core/semantic/index.js";

const t = translator("semantic");
const SUBCOMMANDS = ["plan", "run", "status", "cancel", "history"] as const;

const str = (ctx: CommandContext, name: string): string | undefined => (typeof ctx.options[name] === "string" ? (ctx.options[name] as string) : undefined);

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Ctrl+C (and SIGTERM/SIGHUP outside Windows) cancels the run: owned processes stop, the partial evidence stays. */
async function withCancellation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (name: NodeJS.Signals): void => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort(name);
  };
  for (const name of signals) process.on(name, onSignal);
  try {
    return await work(controller.signal);
  } finally {
    for (const name of signals) process.off(name, onSignal);
  }
}

function planText(ctx: CommandContext, plan: SemanticPlan): void {
  ctx.stdout(`${t("semantic_text_plan_header", { path: plan.workspace.path })}\n`);
  ctx.stdout(`  ${t("semantic_text_methods", { methods: plan.methods.map((m) => m.id).join(", ") })}\n`);
  ctx.stdout(`  ${t("semantic_text_provider", { provider: plan.settings.provider ?? "-", model: plan.settings.model ?? "-", scope: plan.settings.scope ?? "-" })}\n`);
  for (const p of plan.prerequisites) ctx.stdout(`  ${p.ok ? "ok " : "-- "} ${p.id}: ${p.message}\n`);
  if (plan.quality.attached) ctx.stdout(`  ${t("semantic_text_quality_attached", { runId: plan.quality.attached })}\n`);
  ctx.stdout(`${plan.ready ? t("semantic_text_ready") : t("semantic_text_not_ready")}\n`);
}

export const command: CommandModule = {
  name: "semantic",
  description: t("semantic_description"),
  options: [
    { name: "cwd", type: "string", description: t("semantic_option_cwd") },
    { name: "quality", type: "string", description: t("semantic_option_quality") },
    { name: "events-jsonl", type: "string", description: t("semantic_option_events_jsonl") },
    { name: "run-id", type: "string", description: t("semantic_option_run_id") },
    { name: "limit", type: "string", description: t("semantic_option_limit") },
    { name: "no-interactive", type: "boolean", description: t("semantic_option_no_interactive") },
  ],
  async run(ctx) {
    const usage = (code: string, key: string, params: Record<string, string> = {}): number => reportError(ctx, ctx.json, code, t(key, params), t(`${key}_fix`, params), EXIT_USAGE);
    const sub = ctx.args[0];
    if (sub === undefined) return usage("MISSING_SUBCOMMAND", "semantic_missing_subcommand");
    if (!(SUBCOMMANDS as readonly string[]).includes(sub)) return usage("UNKNOWN_SUBCOMMAND", "semantic_unknown_subcommand", { name: sub });
    const workspacePath = path.resolve(str(ctx, "cwd") ?? process.cwd());
    if (!isDirectory(workspacePath)) return usage("BAD_CWD", "semantic_bad_cwd", { path: workspacePath });
    const home = resolveHome();
    const wsId = workspaceId(workspacePath);
    const base = { schemaVersion: 1 as const, status: "OK" as const, tool: "jgates", version: ctx.version, gate: "semantic" as const, workspace: { id: wsId, path: workspacePath } };

    if (sub === "plan") {
      if (ctx.args[1] !== undefined) return usage("UNEXPECTED_ARGUMENT", "semantic_unexpected_argument", { name: ctx.args[1] });
      const plan = buildSemanticPlan({ workspacePath, home, quality: str(ctx, "quality") ?? null });
      if (ctx.json) writeJson(ctx, { ...base, plan });
      else planText(ctx, plan);
      return 0;
    }

    if (sub === "history") {
      if (ctx.args[1] !== undefined) return usage("UNEXPECTED_ARGUMENT", "semantic_unexpected_argument", { name: ctx.args[1] });
      const rawLimit = str(ctx, "limit");
      const limit = rawLimit !== undefined ? Number(rawLimit) : 20;
      if (!Number.isInteger(limit) || limit < 1) return usage("BAD_LIMIT", "semantic_bad_limit", { value: String(rawLimit) });
      const runs = listSemanticRuns(home, wsId)
        .slice(0, limit)
        .map(({ time: _time, ...run }) => run);
      if (ctx.json) {
        writeJson(ctx, { ...base, runs });
        return 0;
      }
      if (runs.length === 0) ctx.stdout(`${t("semantic_history_empty")}\n`);
      for (const r of runs) ctx.stdout(`${r.runId}  ${r.startedAt ?? "-"}  ${r.decision ?? "-"}  [${t(`semantic_lifecycle_${r.lifecycle}`)}]\n`);
      return 0;
    }

    if (sub === "status" || sub === "cancel") {
      const runId = ctx.args[1];
      if (!runId) return usage("MISSING_RUN", "semantic_missing_run");
      if (!isSemanticRunId(runId)) return usage("BAD_RUN_ID", "semantic_bad_run_id", { runId });
      if (sub === "status") {
        const view = readSemanticRun(home, wsId, runId);
        if (!view) return usage("RUN_NOT_FOUND", "semantic_run_not_found", { runId });
        if (ctx.json) {
          const { time: _time, ...run } = view;
          writeJson(ctx, { ...base, run });
        } else {
          ctx.stdout(`${runId}  ${t(`semantic_lifecycle_${view.lifecycle}`)}  ${view.decision ?? "-"}\n`);
          for (const s of view.result?.stages ?? []) ctx.stdout(`  ${s.state.padEnd(10)} ${s.id}${s.reason ? `  (${s.reason})` : ""}\n`);
          if (view.result?.summary) ctx.stdout(`${view.result.summary}\n`);
        }
        return 0;
      }
      const outcome = requestSemanticCancel(home, wsId, runId, { reason: "cancel requested (jgates semantic cancel)" });
      if (outcome.status === "not-found") return usage("RUN_NOT_FOUND", "semantic_run_not_found", { runId });
      if (outcome.status === "not-active") return usage("RUN_NOT_ACTIVE", "semantic_run_not_active", { runId });
      if (ctx.json) writeJson(ctx, { ...base, runId, cancel: outcome.status });
      else ctx.stdout(`${t(outcome.status === "settled" ? "semantic_cancel_settled" : "semantic_cancel_requested", { runId })}\n`);
      return 0;
    }

    // run
    if (ctx.args[1] !== undefined) return usage("UNEXPECTED_ARGUMENT", "semantic_unexpected_argument", { name: ctx.args[1] });
    const eventsOption = str(ctx, "events-jsonl");
    const eventsFile = eventsOption !== undefined ? path.resolve(eventsOption) : undefined;
    if (eventsFile !== undefined && !isDirectory(path.dirname(eventsFile))) return usage("BAD_EVENTS_PATH", "semantic_bad_events_path", { path: eventsFile });
    const runId = str(ctx, "run-id");
    if (runId !== undefined && !isSemanticRunId(runId)) return usage("BAD_RUN_ID", "semantic_bad_run_id", { runId });
    const plan = buildSemanticPlan({ workspacePath, home, quality: str(ctx, "quality") ?? null });
    if (!plan.ready) {
      const code = plan.blockers[0]?.code ?? "SEMANTIC_NOT_READY";
      return reportError(ctx, ctx.json, code, plan.blockers.map((b) => b.message).join(" "), t("semantic_not_ready_fix"), EXIT_USAGE);
    }
    const progress = ctx.json
      ? undefined
      : (event: RunEvent): void => {
          if (event.type === "stage") ctx.stderr(`  ${String(event.data.state).padEnd(10)} ${String(event.data.stageId)}${event.data.reason ? `  (${String(event.data.reason)})` : ""}\n`);
          else if (event.type === "run-started") ctx.stderr(`${t("semantic_text_started", { runId: event.runId })}\n`);
          else if (event.type === "cancel-requested") ctx.stderr(`${t("semantic_text_cancelling")}\n`);
        };
    let result;
    try {
      result = await withCancellation((signal) =>
        executeSemanticRun({
          workspacePath,
          home,
          version: ctx.version,
          plan,
          signal,
          ownsProcess: true,
          ...(eventsFile !== undefined ? { eventsFile } : {}),
          ...(runId !== undefined ? { runId } : {}),
          ...(progress ? { onEvent: progress } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof SemanticRunError) return reportError(ctx, ctx.json, error.code, error.message, t("semantic_not_ready_fix"), EXIT_USAGE);
      throw error;
    }
    if (ctx.json) writeJson(ctx, result);
    else {
      ctx.stdout(`${result.summary ?? result.decision}\n`);
      const q = result.semanticRun?.quality;
      if (q) ctx.stdout(`${t("semantic_text_quality_evidence", { runId: q.runId, freshness: q.freshness, reason: q.reason })}\n`);
      ctx.stdout(`${t("semantic_text_run_dir", { runId: result.runId, dir: result.runDir })}\n`);
    }
    return result.exitCode;
  },
};
