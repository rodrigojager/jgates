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
  METHOD_ID_PATTERN,
  SemanticRunError,
  buildSemanticPlan,
  executeSemanticRun,
  isSemanticRunId,
  listSemanticRuns,
  readSemanticRun,
  requestSemanticCancel,
  semanticMethodCatalog,
  FINDING_ID_PATTERN,
  reproductionOf,
  withReproduction,
  type ReproductionSelection,
  type RunReproduction,
  type SemanticPlan,
  type SemanticPlanRequest,
} from "../../core/semantic/index.js";
import { REPRODUCTION_METHOD } from "../../core/semantic-modules/reproduction/index.js";
import type { RunResult } from "../../core/run/types.js";
import { CONTEXT_POLICIES, SEMANTIC_PURPOSES, SEMANTIC_RIGORS, type ScopeRequest, type SemanticPurpose, type SemanticRigor } from "../../core/semantic-scope/index.js";

const t = translator("semantic");
const ts = translator("semantic-scope");
const SUBCOMMANDS = ["plan", "run", "status", "cancel", "history", "methods"] as const;
const METHOD_ID = new RegExp(METHOD_ID_PATTERN);

/** The methods named with --method (comma-separated, the option may repeat), or the first malformed value. */
export function methodFlags(ctx: CommandContext): { ok: true; value: string[] } | { ok: false; value: string } {
  const raw = ctx.lists.method ?? (typeof ctx.options.method === "string" ? [ctx.options.method as string] : []);
  const out: string[] = [];
  for (const part of raw.flatMap((r) => r.split(","))) {
    const id = part.trim();
    if (id === "") continue;
    if (!METHOD_ID.test(id)) return { ok: false, value: id };
    if (!out.includes(id)) out.push(id);
  }
  return { ok: true, value: out };
}
const SCOPE_MODES = ["full", "selected", "incremental"] as const;

const str = (ctx: CommandContext, name: string): string | undefined => (typeof ctx.options[name] === "string" ? (ctx.options[name] as string) : undefined);
const list = (ctx: CommandContext, name: string): string[] => ctx.lists[name] ?? (typeof ctx.options[name] === "string" ? [ctx.options[name] as string] : []);

type ScopeFlags = Pick<SemanticPlanRequest, "purpose" | "rigor" | "budget" | "scope">;

/** The scope, purpose, rigor and budget flags as a plan request, or the usage problem they have. */
export function scopeFlags(ctx: CommandContext): { ok: true; value: ScopeFlags } | { ok: false; code: string; key: string; params: Record<string, string> } {
  const bad = (code: string, key: string, params: Record<string, string>) => ({ ok: false as const, code, key, params });
  const mode = str(ctx, "scope");
  if (mode !== undefined && !(SCOPE_MODES as readonly string[]).includes(mode)) return bad("BAD_SCOPE", "scope_cli_bad_scope", { value: mode });
  const purpose = str(ctx, "purpose");
  if (purpose !== undefined && !(SEMANTIC_PURPOSES as readonly string[]).includes(purpose)) return bad("BAD_PURPOSE", "scope_cli_bad_purpose", { value: purpose });
  const rigor = str(ctx, "rigor");
  if (rigor !== undefined && !(SEMANTIC_RIGORS as readonly string[]).includes(rigor)) return bad("BAD_RIGOR", "scope_cli_bad_rigor", { value: rigor });
  const policy = str(ctx, "context-policy");
  if (policy !== undefined && !(CONTEXT_POLICIES as readonly string[]).includes(policy)) return bad("BAD_CONTEXT_POLICY", "scope_cli_bad_context_policy", { value: policy });
  const numbers: Record<string, number | undefined> = {};
  for (const name of ["context-max-files", "context-max-depth", "context-max-bytes", "budget-calls", "budget-tokens"]) {
    const raw = str(ctx, name);
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n)) return bad("BAD_NUMBER", "scope_cli_bad_number", { name, value: raw });
    numbers[name] = n;
  }
  const dirtyValues = list(ctx, "dirty");
  let dirty: ScopeRequest["dirty"] | undefined;
  if (dirtyValues.length === 1 && (dirtyValues[0] === "none" || dirtyValues[0] === "all")) dirty = dirtyValues[0];
  else if (dirtyValues.length > 0) {
    if (dirtyValues.includes("none") || dirtyValues.includes("all")) return bad("BAD_DIRTY", "scope_cli_bad_dirty", {});
    dirty = dirtyValues;
  }
  const subjects = [...list(ctx, "path").map((value) => ({ kind: "path" as const, value })), ...list(ctx, "subsystem").map((value) => ({ kind: "subsystem" as const, value }))];
  const context: NonNullable<ScopeRequest["context"]> = {
    ...(policy !== undefined ? { policy: policy as (typeof CONTEXT_POLICIES)[number] } : {}),
    ...(numbers["context-max-files"] !== undefined ? { maxFiles: numbers["context-max-files"] } : {}),
    ...(numbers["context-max-depth"] !== undefined ? { maxDepth: numbers["context-max-depth"] } : {}),
    ...(numbers["context-max-bytes"] !== undefined ? { maxBytes: numbers["context-max-bytes"] } : {}),
    ...(list(ctx, "allow-context").length > 0 ? { allow: list(ctx, "allow-context") } : {}),
  };
  const scope: ScopeRequest = {
    mode: (mode as ScopeRequest["mode"]) ?? (subjects.length > 0 ? "selected" : str(ctx, "base") !== undefined ? "incremental" : "full"),
    ...(subjects.length > 0 ? { subjects } : {}),
    ...(list(ctx, "exclude").length > 0 ? { exclusions: list(ctx, "exclude") } : {}),
    ...(str(ctx, "base") !== undefined ? { base: str(ctx, "base") as string } : {}),
    ...(str(ctx, "target") !== undefined ? { target: str(ctx, "target") as string } : {}),
    ...(dirty !== undefined ? { dirty } : {}),
    ...(str(ctx, "baseline") !== undefined ? { baseline: str(ctx, "baseline") as string } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
  };
  const budget = {
    ...(numbers["budget-calls"] !== undefined ? { maxCalls: numbers["budget-calls"] } : {}),
    ...(numbers["budget-tokens"] !== undefined ? { maxTokens: numbers["budget-tokens"] } : {}),
  };
  return {
    ok: true,
    value: {
      scope,
      ...(purpose !== undefined ? { purpose: purpose as SemanticPurpose } : {}),
      ...(rigor !== undefined ? { rigor: rigor as SemanticRigor } : {}),
      ...(Object.keys(budget).length > 0 ? { budget } : {}),
    },
  };
}

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

/** What a confirm-by-reproduction run will do, before it starts: findings to try, the call budget, the container. */
function reproductionPlanText(ctx: CommandContext, plan: SemanticPlan): void {
  const r = plan.reproduction;
  if (!r) return;
  ctx.stdout(`${t("semantic_text_reproduction_plan", { runId: r.seedRun ?? r.from ?? "-", cost: t("semantic_reproduction_cost", { count: r.findingsToTry, calls: r.budget.maxCalls }) })}\n`);
  for (const s of r.skipped) ctx.stdout(`${t("semantic_text_reproduction_skipped", { candidateId: s.candidateId, code: s.code })}\n`);
  ctx.stdout(`  ${t("semantic_reproduction_never_rejects")}\n`);
}

/** How a finding's reproduction state reads (none, attempted with the reason, confirmed by execution). */
function reproductionStateText(f: RunReproduction["findings"][number]): string {
  if (f.state === "confirmed") return t("semantic_reproduction_state_confirmed", { runId: f.reproductionRunId ?? "-" });
  if (f.state === "none") return t("semantic_reproduction_state_none");
  // A known attempt reason reads in the user's language; a reason code of the run (a skipped finding) keeps its detail.
  const key = `semantic_reproduction_reason_${f.reason ?? "NOT_RUN"}`;
  const translated = t(key);
  const reason = translated !== key ? translated : `${f.reason ?? "-"}${f.detail ? `: ${f.detail}` : ""}`;
  return t("semantic_reproduction_state_attempted", { runId: f.reproductionRunId ?? "-", reason });
}

function reproductionLines(ctx: CommandContext, runId: string, r: RunReproduction): void {
  if (r.reproduces) ctx.stdout(`${t("semantic_text_reproduction_of", { runId: r.reproduces })}\n`);
  if (r.findings.length === 0) return;
  ctx.stdout(`${t("semantic_text_reproduction_header", { runId })}\n`);
  for (const f of r.findings) ctx.stdout(`${t("semantic_text_reproduction_line", { candidateId: f.candidateId, state: reproductionStateText(f), title: f.title })}\n`);
}

const FINDING_ID = new RegExp(FINDING_ID_PATTERN);

function planText(ctx: CommandContext, plan: SemanticPlan): void {
  ctx.stdout(`${t("semantic_text_plan_header", { path: plan.workspace.path })}\n`);
  ctx.stdout(`  ${t("semantic_text_methods", { methods: plan.methods.map((m) => m.id).join(", ") })}\n`);
  for (const m of plan.methods) {
    const a = m.applicability;
    const label = t(`semantic_text_applicability_${a.state}`);
    ctx.stdout(`    ${t("semantic_text_method_line", { id: m.id, title: m.title, applicability: a.reason ? `${label} (${a.code ? `${a.code}: ` : ""}${a.reason})` : label })}\n`);
  }
  ctx.stdout(`  ${t("semantic_text_provider", { provider: plan.settings.provider ?? "-", model: plan.settings.model ?? "-", scope: plan.settings.scope ?? "-" })}\n`);
  for (const p of plan.prerequisites) ctx.stdout(`  ${p.ok ? "ok " : "-- "} ${p.id}: ${p.message}\n`);
  if (plan.quality.attached) ctx.stdout(`  ${t("semantic_text_quality_attached", { runId: plan.quality.attached })}\n`);
  const r = plan.scope.resolution;
  ctx.stdout(`  ${ts("scope_text_summary", { mode: r.mode, methods: plan.methods.map((m) => m.id).join(", "), rigor: plan.rigor, examine: r.completion.toExamine, reused: r.completion.reused, context: r.completion.context, excluded: r.completion.excluded })}\n`);
  ctx.stdout(`  ${ts("scope_text_inherited", { message: r.inheritedCoverage.message })}\n`);
  for (const s of r.subjects.slice(0, 40)) ctx.stdout(`    ${s.disposition === "reused" ? "reuse" : "exam "} ${s.path}  (${s.reasons.map((x) => x.message).join("; ")})\n`);
  if (r.subjects.length > 40) ctx.stdout(`    ${ts("scope_text_more", { count: r.subjects.length - 40 })}\n`);
  for (const c of r.context) ctx.stdout(`    ctx   ${c.path}  (${c.reasons.map((x) => x.message).join("; ")})\n`);
  for (const u of r.impact.unknowns.slice(0, 20)) ctx.stdout(`    ?     ${u.message}\n`);
  for (const e of r.impact.recommendedExpansion.slice(0, 20)) ctx.stdout(`    +     ${ts("scope_text_recommended", { path: e.path })}\n`);
  for (const b of plan.blockers) ctx.stdout(`  -- ${b.code}: ${b.message}\n`);
  for (const w of r.warnings) ctx.stdout(`  !  ${w.message}\n`);
  reproductionPlanText(ctx, plan);
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
    { name: "scope", type: "string", description: ts("scope_option_scope") },
    { name: "path", type: "string", description: ts("scope_option_path") },
    { name: "subsystem", type: "string", description: ts("scope_option_subsystem") },
    { name: "exclude", type: "string", description: ts("scope_option_exclude") },
    { name: "base", type: "string", description: ts("scope_option_base") },
    { name: "target", type: "string", description: ts("scope_option_target") },
    { name: "dirty", type: "string", description: ts("scope_option_dirty") },
    { name: "baseline", type: "string", description: ts("scope_option_baseline") },
    { name: "context-policy", type: "string", description: ts("scope_option_context_policy") },
    { name: "context-max-files", type: "string", description: ts("scope_option_context_max_files") },
    { name: "context-max-depth", type: "string", description: ts("scope_option_context_max_depth") },
    { name: "context-max-bytes", type: "string", description: ts("scope_option_context_max_bytes") },
    { name: "allow-context", type: "string", description: ts("scope_option_allow_context") },
    { name: "purpose", type: "string", description: ts("scope_option_purpose") },
    { name: "rigor", type: "string", description: ts("scope_option_rigor") },
    { name: "budget-calls", type: "string", description: ts("scope_option_budget_calls") },
    { name: "budget-tokens", type: "string", description: ts("scope_option_budget_tokens") },
    { name: "method", type: "string", description: t("semantic_option_method") },
    { name: "from", type: "string", description: t("semantic_option_from") },
    { name: "finding", type: "string", description: t("semantic_option_finding") },
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

    const scoped = scopeFlags(ctx);
    if (!scoped.ok) return reportError(ctx, ctx.json, scoped.code, ts(scoped.key, scoped.params), ts("scope_cli_fix"), EXIT_USAGE);
    const methodsFlag = methodFlags(ctx);
    if (!methodsFlag.ok) return usage("BAD_METHOD", "semantic_bad_method", { value: methodsFlag.value });
    const methods = methodsFlag.value;
    // The earlier run (and one finding) confirm-by-reproduction starts from: only with that method, never on its own.
    const from = str(ctx, "from");
    const finding = str(ctx, "finding");
    let reproduction: ReproductionSelection | null = null;
    if ((sub === "run" || sub === "plan") && (from !== undefined || finding !== undefined)) {
      if (!methods.includes(REPRODUCTION_METHOD)) return usage("REPRODUCTION_WITHOUT_METHOD", "semantic_reproduction_option_without_method");
      if (finding !== undefined && from === undefined) return usage("FINDING_WITHOUT_FROM", "semantic_reproduction_finding_without_from");
      if (from !== undefined && !isSemanticRunId(from)) return usage("BAD_FROM", "semantic_reproduction_bad_from", { value: from.slice(0, 90) });
      if (finding !== undefined && !FINDING_ID.test(finding)) return usage("BAD_FINDING", "semantic_reproduction_bad_finding", { value: finding.slice(0, 40) });
      reproduction = { from: from ?? null, findings: finding !== undefined ? [finding] : [] };
    }

    if (sub === "methods") {
      if (ctx.args[1] !== undefined) return usage("UNEXPECTED_ARGUMENT", "semantic_unexpected_argument", { name: ctx.args[1] });
      const catalog = semanticMethodCatalog();
      if (ctx.json) {
        writeJson(ctx, { ...base, methods: catalog });
        return 0;
      }
      ctx.stdout(`${t("semantic_text_methods_header")}\n`);
      for (const m of catalog) {
        const purposes = m.purposes.length > 0 ? t("semantic_text_method_purposes", { purposes: m.purposes.join(", ") }) : "";
        ctx.stdout(`  ${t("semantic_text_method_catalog_line", { id: m.id, title: m.title, state: t(m.available ? "semantic_text_method_available" : "semantic_text_method_unavailable"), purposes })}\n`);
      }
      return 0;
    }

    if (sub === "plan") {
      if (ctx.args[1] !== undefined) return usage("UNEXPECTED_ARGUMENT", "semantic_unexpected_argument", { name: ctx.args[1] });
      const plan = buildSemanticPlan({ workspacePath, home, quality: str(ctx, "quality") ?? null, ...scoped.value, methods, reproduction });
      if (ctx.json) writeJson(ctx, { ...base, plan });
      else planText(ctx, plan);
      return 0;
    }

    if (sub === "history") {
      if (ctx.args[1] !== undefined) return usage("UNEXPECTED_ARGUMENT", "semantic_unexpected_argument", { name: ctx.args[1] });
      const rawLimit = str(ctx, "limit");
      const limit = rawLimit !== undefined ? Number(rawLimit) : 20;
      if (!Number.isInteger(limit) || limit < 1) return usage("BAD_LIMIT", "semantic_bad_limit", { value: String(rawLimit) });
      // Each run with the reproduction state of its findings, read from the reproduction runs that name it.
      const runs = withReproduction(home, wsId, listSemanticRuns(home, wsId).slice(0, limit)).map(({ time: _time, ...run }) => run);
      if (ctx.json) {
        writeJson(ctx, { ...base, runs });
        return 0;
      }
      if (runs.length === 0) ctx.stdout(`${t("semantic_history_empty")}\n`);
      for (const r of runs) {
        const { counts, reproduces } = r.reproduction;
        const tried = counts.confirmed + counts.attempted > 0 ? `  (${t("semantic_history_reproduction", { confirmed: counts.confirmed, attempted: counts.attempted })})` : "";
        ctx.stdout(`${r.runId}  ${r.startedAt ?? "-"}  ${r.decision ?? "-"}  [${t(`semantic_lifecycle_${r.lifecycle}`)}]${tried}\n`);
        if (reproduces) ctx.stdout(`${t("semantic_text_reproduction_of", { runId: reproduces })}\n`);
        for (const f of r.reproduction.findings.filter((x) => x.state !== "none")) ctx.stdout(`${t("semantic_text_reproduction_line", { candidateId: f.candidateId, state: reproductionStateText(f), title: f.title })}\n`);
      }
      return 0;
    }

    if (sub === "status" || sub === "cancel") {
      const runId = ctx.args[1];
      if (!runId) return usage("MISSING_RUN", "semantic_missing_run");
      if (!isSemanticRunId(runId)) return usage("BAD_RUN_ID", "semantic_bad_run_id", { runId });
      if (sub === "status") {
        const view = readSemanticRun(home, wsId, runId);
        if (!view) return usage("RUN_NOT_FOUND", "semantic_run_not_found", { runId });
        // The stored run is never rewritten: the reproduction state of its findings is read beside it.
        const reproductionView = reproductionOf(home, wsId, view);
        if (ctx.json) {
          const { time: _time, ...run } = view;
          writeJson(ctx, { ...base, run: { ...run, reproduction: reproductionView } });
        } else {
          ctx.stdout(`${runId}  ${t(`semantic_lifecycle_${view.lifecycle}`)}  ${view.decision ?? "-"}\n`);
          for (const s of view.result?.stages ?? []) ctx.stdout(`  ${s.state.padEnd(10)} ${s.id}${s.reason ? `  (${s.reason})` : ""}\n`);
          if (view.result?.summary) ctx.stdout(`${view.result.summary}\n`);
          reproductionLines(ctx, runId, reproductionView);
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
    const plan = buildSemanticPlan({ workspacePath, home, quality: str(ctx, "quality") ?? null, ...scoped.value, methods, reproduction });
    if (!plan.ready) {
      const code = plan.blockers[0]?.code ?? "SEMANTIC_NOT_READY";
      return reportError(ctx, ctx.json, code, plan.blockers.map((b) => b.message).join(" "), t("semantic_not_ready_fix"), EXIT_USAGE);
    }
    // One Semantic run per method, in order: each has its own sem_ ID, folder, plan (narrowed to its method) and result.
    // A single method keeps the plan as built; --run-id names the first run (the local server answers with it).
    const plans =
      plan.methods.length <= 1
        ? [plan]
        : plan.methods.map((m) => buildSemanticPlan({ workspacePath, home, quality: str(ctx, "quality") ?? null, ...scoped.value, methods: [m.id], ...(m.id === REPRODUCTION_METHOD ? { reproduction } : {}) }));
    const notReady = plans.find((p) => !p.ready);
    if (notReady) {
      const code = notReady.blockers[0]?.code ?? "SEMANTIC_NOT_READY";
      return reportError(ctx, ctx.json, code, notReady.blockers.map((b) => b.message).join(" "), t("semantic_not_ready_fix"), EXIT_USAGE);
    }
    // Before a reproduction starts: how many findings it tries, the model calls it may spend, and that the project's
    // tests run in a container without network (with --json the same numbers are in the document, under reproduction).
    const reproductionPlan = plans.find((p) => p.reproduction)?.reproduction ?? null;
    if (!ctx.json) for (const p of plans) reproductionPlanText(ctx, p);
    const progress = ctx.json
      ? undefined
      : (event: RunEvent): void => {
          if (event.type === "stage") ctx.stderr(`  ${String(event.data.state).padEnd(10)} ${String(event.data.stageId)}${event.data.reason ? `  (${String(event.data.reason)})` : ""}\n`);
          else if (event.type === "run-started") ctx.stderr(`${t("semantic_text_started", { runId: event.runId })}\n`);
          else if (event.type === "cancel-requested") ctx.stderr(`${t("semantic_text_cancelling")}\n`);
        };
    const results: RunResult[] = [];
    let stopped = null as string | null;
    try {
      await withCancellation(async (signal) => {
        for (const [index, p] of plans.entries()) {
          if (signal.aborted) {
            stopped = "cancelled";
            break;
          }
          const result = await executeSemanticRun({
            workspacePath,
            home,
            version: ctx.version,
            plan: p,
            signal,
            ownsProcess: true,
            ...(eventsFile !== undefined && index === 0 ? { eventsFile } : {}),
            ...(runId !== undefined && index === 0 ? { runId } : {}),
            ...(progress ? { onEvent: progress } : {}),
          });
          results.push(result);
          // A cancelled run stops the selection: the methods after it are not started.
          if (result.decision === "cancelled") {
            if (index < plans.length - 1) stopped = "cancelled";
            break;
          }
        }
      });
    } catch (error) {
      if (error instanceof SemanticRunError && results.length === 0) return reportError(ctx, ctx.json, error.code, error.message, t("semantic_not_ready_fix"), EXIT_USAGE);
      if (!(error instanceof SemanticRunError)) throw error;
      stopped = error.message;
    }
    const printed = (result: RunResult): void => {
      ctx.stdout(`${result.summary ?? result.decision}\n`);
      const q = result.semanticRun?.quality;
      if (q) ctx.stdout(`${t("semantic_text_quality_evidence", { runId: q.runId, freshness: q.freshness, reason: q.reason })}\n`);
      ctx.stdout(`${t("semantic_text_run_dir", { runId: result.runId, dir: result.runDir })}\n`);
    };
    if (plans.length === 1) {
      const result = results[0] as RunResult;
      if (ctx.json) writeJson(ctx, reproductionPlan ? { ...result, reproduction: reproductionPlan } : result);
      else printed(result);
      return result.exitCode;
    }
    // Several methods: every run's result, and the worst exit code (a run that did not pass is never hidden).
    const exitCode = results.reduce((worst, r) => Math.max(worst, r.exitCode), 0);
    const notStarted = plans.slice(results.length).map((p) => p.methods[0]?.id ?? "-");
    if (ctx.json) writeJson(ctx, { ...base, methods: plans.map((p) => p.methods[0]?.id), runs: results, notStarted, ...(stopped ? { stopped } : {}), ...(reproductionPlan ? { reproduction: reproductionPlan } : {}), exitCode });
    else {
      for (const r of results) printed(r);
      if (notStarted.length > 0) ctx.stdout(`${t("semantic_text_sequence_stopped", { reason: `${stopped ?? "-"} (${notStarted.join(", ")})` })}\n`);
    }
    return notStarted.length > 0 && exitCode === 0 ? EXIT_USAGE : exitCode;
  },
};
