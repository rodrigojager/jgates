// The independent Semantic run service: one Semantic run with its own sem_ ID and folder, its plan, ordered JSONL
// events, heartbeat, cancellation, artifacts and result (gate semantic) next to its run identity (source identity
// included). It never creates, reads as a prerequisite or changes a Quality run; a Quality report is only attached
// when the caller names one, as evidence with its freshness. The CLI (`jgates semantic ...`) and the server routes
// (server/routes/semantic-runs.ts) drive this same service.
//
// Stages of the general review: semantic-context (collect, filter and mask what goes to the provider) and
// semantic-review (the provider calls and the validated verdict). The decision is computed fail-closed from them by
// the same contract as Quality (core/contract): missing, unfinished or invalid model output is never favorable, a
// verdict other than APPROVED fails, and a model output that does not validate makes the run invalid.
//
// Cancellation: the caller's AbortSignal, or a cancel request file another process writes (requestSemanticCancel).
// Only the processes this run owns stop (the descendants of the run's process when it owns its process, as the CLI
// does); whatever was produced so far stays (outputs/review.json, events, the partial result settled as cancelled).
import fs from "node:fs";
import path from "node:path";
import { computeDecision, type StageState } from "../contract/index.js";
import { EventLog, readEvents, type RunEvent } from "../events/index.js";
import { resolveHome, touchWorkspace } from "../home/index.js";
import { contentHash } from "../ids/index.js";
import { newGateRunId } from "../gates/ids.js";
import { writeGateRecord } from "../gates/read.js";
import { computeSourceIdentity } from "../gates/source.js";
import type { GateRunIdentity, SourceIdentity } from "../gates/types.js";
import { startHeartbeat, HEARTBEAT_FILE } from "../run/heartbeat.js";
import type { NormalizedSeverity, ResultFinding, ResultSemantic, ResultStage, RunResult } from "../run/types.js";
import { listDescendants, treeStopper } from "../runner/tree.js";
import { runSemanticReview, type SemanticDeps, type SemanticProgress } from "../../adapters/semantic-gate/index.js";
import { translator } from "../../i18n/index.js";
import { finishScopeRun, prepareScopeRun, type ScopeRunPreparation } from "../semantic-scope/index.js";
import { investigationModuleFor, runInvestigation, type InvestigationDeps, type InvestigationEventType, type InvestigationModule } from "../semantic-executor/index.js";
import { buildSemanticPlan, resolveQualityRun, type SemanticPlan } from "./plan.js";
import { attachQuality, type AttachedQuality } from "./quality.js";
import {
  CANCEL_REQUEST_FILE,
  REVIEW_OUTPUT,
  RUN_IDENTITY_FILE,
  SEMANTIC_EVENTS_FILE,
  SEMANTIC_PLAN_FILE,
  SEMANTIC_RESULT_FILE,
  findSemanticRun,
  isSemanticRunId,
  semanticRunDir,
} from "./store.js";

const t = translator("semantic");

export const SEMANTIC_ADAPTER = "semantic-review";
export const CONTEXT_STAGE = "semantic-context";
export const REVIEW_STAGE = "semantic-review";

export type SemanticRunErrorCode = "SEMANTIC_NOT_READY" | "BAD_RUN_ID" | "RUN_EXISTS";

export class SemanticRunError extends Error {
  constructor(
    readonly code: SemanticRunErrorCode,
    message: string,
    readonly plan: SemanticPlan | null = null,
  ) {
    super(message);
    this.name = "SemanticRunError";
  }
}

/** What a review method gets from the run: the workspace, its folders, the signal and a progress callback. */
export interface SemanticReviewContext {
  workspacePath: string;
  runDir: string;
  outputsDir: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onProgress: SemanticProgress;
  /**
   * The resolved scope of the run: its guard (every read of a module goes through it), the subjects to examine, the
   * allowed context and the paths a context-only review collects. null only for a plan written before scopes.
   */
  scope: ScopeRunPreparation | null;
  /** The plan of the run (purpose, rigor, budget, methods). */
  plan: SemanticPlan;
  /** Stage and process events of the work inside the review step (an investigation's stages, its owned processes). */
  emit: (type: InvestigationEventType, data: Record<string, unknown>) => void;
}

/** A tool-enabled investigation of the run (core/semantic-executor) instead of the context-only general review. */
export interface SemanticInvestigationOptions {
  /** The module to run; otherwise the module registered for the plan's method (when there is one). */
  module?: InvestigationModule;
  /** Seams of the executor (a scripted model in tests). */
  deps?: InvestigationDeps;
  /** An agent CLI wrapper's executable and the arguments put before its restricted ones. */
  agentCli?: { command?: string; prefixArgs?: string[] };
  /** Time budget of the investigation in seconds (otherwise the per-call timeout times the call budget). */
  maxSeconds?: number;
}

/** A review method: the general review by default; tests (and later executors) pass their own. */
export type SemanticReviewer = (context: SemanticReviewContext) => Promise<ResultSemantic>;

export interface SemanticRunOptions {
  workspacePath: string;
  /** Data folder; defaults to resolveHome(). */
  home?: string;
  version: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Cancels the run (Ctrl+C in the CLI). A cancel request file does the same from another process. */
  signal?: AbortSignal;
  /** On cancel, also stop every descendant of this process (the CLI process owns all of them). */
  ownsProcess?: boolean;
  /** Another file that receives a copy of the event stream (--events-jsonl). */
  eventsFile?: string;
  onEvent?: (event: RunEvent) => void;
  /** A Semantic run ID chosen by the caller (the server allocates it to answer at once); otherwise a new one. */
  runId?: string;
  /** A Quality run to attach as evidence ("latest" or a run_ ID); ignored when `plan` is given. */
  quality?: string | null;
  /** The plan, when the caller already built it. */
  plan?: SemanticPlan;
  /** Replaces the general review. */
  review?: SemanticReviewer;
  /** Seams of the general review (a fake provider in tests). */
  deps?: SemanticDeps;
  /** Runs the plan's method as a tool-enabled investigation (also when a module is registered for the method). */
  investigation?: SemanticInvestigationOptions;
  /** How often the cancel request file is looked for (ms). */
  cancelPollMs?: number;
}

const SEVERITY: Record<string, NormalizedSeverity> = { blocking: "high", important: "medium", suggestion: "low", nit: "info" };

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** How far the review got, as its progress said. */
interface Reached {
  contextStarted: boolean;
  contextFinished: boolean;
  reviewStarted: boolean;
}

interface StagePlan {
  context: ResultStage;
  review: ResultStage;
}

const stage = (id: string, label: string, state: StageState, extra: Partial<ResultStage> = {}): ResultStage => ({ id, label, kind: "step", adapter: SEMANTIC_ADAPTER, state, ...extra });

/** Blocking count of a completed verdict: any verdict other than APPROVED blocks (at least one violation). */
function blockingOf(outcome: ResultSemantic): number {
  const c = outcome.conclusion ?? {};
  if (String(c.status) === "APPROVED") return 0;
  const hard = Array.isArray(c.hardBlockers) ? c.hardBlockers.length : 0;
  const blockingFindings = Array.isArray(c.findings) ? (c.findings as Array<{ severity?: unknown }>).filter((f) => f.severity === "blocking").length : 0;
  // Hard blockers already list the blocking findings when the model gave none of its own: never count one twice.
  return Math.max(1, hard, blockingFindings);
}

/** The two stages of the run from what the review returned (null while it goes) and whether it was cancelled. */
function stagesOf(outcome: ResultSemantic | null, reached: Reached, cancelled: boolean): StagePlan {
  const contextLabel = t("semantic_stage_context");
  const reviewLabel = t("semantic_stage_review");
  const reason = outcome?.reason;
  let context: ResultStage;
  let review: ResultStage;
  if (!outcome) {
    context = stage(CONTEXT_STAGE, contextLabel, reached.contextFinished ? "completed" : reached.contextStarted ? "running" : "pending");
    review = stage(REVIEW_STAGE, reviewLabel, reached.reviewStarted ? "running" : "pending");
  } else {
    const contextDone = reached.contextFinished || outcome.context !== undefined;
    switch (outcome.state) {
      case "completed": {
        const investigation = outcome.investigation as { complete?: unknown; incomplete?: unknown } | undefined;
        if (investigation && investigation.complete === false) {
          // The investigation finished its stages but left required work undone (subjects never read): incomplete.
          context = stage(CONTEXT_STAGE, contextLabel, "completed");
          review = stage(REVIEW_STAGE, reviewLabel, "blocked", { reason: typeof investigation.incomplete === "string" ? investigation.incomplete : t("semantic_reason_budget") });
          break;
        }
        const blocking = blockingOf(outcome);
        context = stage(CONTEXT_STAGE, contextLabel, "completed");
        const found = outcome.conclusion?.findings;
        review = stage(REVIEW_STAGE, reviewLabel, "completed", { blockingViolations: blocking, nativeStatus: String(outcome.conclusion?.status ?? ""), findings: Array.isArray(found) ? found.length : 0 });
        break;
      }
      case "invalid":
        context = stage(CONTEXT_STAGE, contextLabel, "completed");
        review = stage(REVIEW_STAGE, reviewLabel, "error", { interpreted: false, nativeStatus: "INVALID", ...(reason ? { reason } : {}) });
        break;
      case "timeout":
        context = stage(CONTEXT_STAGE, contextLabel, "completed");
        review = stage(REVIEW_STAGE, reviewLabel, "timeout", reason ? { reason } : {});
        break;
      case "budget-exhausted":
        context = stage(CONTEXT_STAGE, contextLabel, "completed");
        review = stage(REVIEW_STAGE, reviewLabel, "blocked", { reason: reason ?? t("semantic_reason_budget") });
        break;
      case "blocked":
        context = stage(CONTEXT_STAGE, contextLabel, "blocked", reason ? { reason } : {});
        review = stage(REVIEW_STAGE, reviewLabel, "blocked", { reason: t("semantic_reason_not_run_context") });
        break;
      default:
        // unavailable or not-configured: the failing part is the one that was going when it stopped.
        if (contextDone && (reached.reviewStarted || (outcome.calls ?? 0) > 0)) {
          context = stage(CONTEXT_STAGE, contextLabel, "completed");
          review = stage(REVIEW_STAGE, reviewLabel, "error", reason ? { reason } : {});
        } else {
          context = stage(CONTEXT_STAGE, contextLabel, "error", reason ? { reason } : {});
          review = stage(REVIEW_STAGE, reviewLabel, "blocked", { reason: t("semantic_reason_not_run_context") });
        }
    }
  }
  if (cancelled) {
    const cancel = (s: ResultStage): ResultStage => (s.state === "completed" ? s : { ...s, state: "cancelled", reason: t("semantic_reason_cancelled"), blockingViolations: 0 });
    context = cancel(context);
    review = cancel(review);
  }
  return { context, review };
}

function findingsOf(outcome: ResultSemantic | null): ResultFinding[] {
  const found = outcome?.state === "completed" ? outcome.conclusion?.findings : undefined;
  if (!Array.isArray(found)) return [];
  return (found as Array<Record<string, unknown>>).map((f) => {
    const severity = String(f.severity ?? "unknown");
    const category = String(f.category ?? "general");
    return {
      stageId: REVIEW_STAGE,
      tool: "semantic-gate",
      ruleId: `semantic/${category || "general"}`,
      category,
      severity,
      normalizedSeverity: SEVERITY[severity] ?? "unknown",
      message: String(f.message ?? ""),
      ...(typeof f.path === "string" && f.path !== "" ? { location: { path: f.path, ...(typeof f.line === "number" ? { line: f.line } : {}) } } : {}),
      blocking: severity === "blocking",
      waived: false,
      origin: "model",
    };
  });
}

function summaryOf(result: RunResult): string {
  const outcome = result.semanticRun?.outcome ?? null;
  const status = outcome?.conclusion?.status;
  switch (result.decision) {
    case "passed":
      return t("semantic_summary_passed", { score: String(outcome?.conclusion?.score ?? "-") });
    case "failed":
      return t("semantic_summary_failed", { status: String(status ?? "-"), count: result.blockingViolations });
    case "invalid":
      return t("semantic_summary_invalid", { reason: outcome?.reason ?? "-" });
    case "cancelled":
      return t("semantic_summary_cancelled");
    default:
      return t("semantic_summary_incomplete", { state: outcome?.state ?? "-" });
  }
}

/** Every descendant of this process stops (the run owns them all when it owns its process). */
function stopOwnedProcesses(): void {
  for (const pid of listDescendants(process.pid)) treeStopper(pid, { group: false, graceMs: 2000 }).stop();
}

/** Runs one independent Semantic run to its end and returns its result (also written as result.json). */
export async function executeSemanticRun(opts: SemanticRunOptions): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const home = opts.home ?? resolveHome({ env });
  const plan = opts.plan ?? buildSemanticPlan({ workspacePath: opts.workspacePath, home, env, now, quality: opts.quality ?? null });
  if (!plan.ready) throw new SemanticRunError("SEMANTIC_NOT_READY", plan.blockers.map((b) => b.message).join(" "), plan);
  if (opts.runId !== undefined && !isSemanticRunId(opts.runId)) throw new SemanticRunError("BAD_RUN_ID", t("semantic_bad_run_id", { runId: opts.runId }));

  const startedAt = now();
  const workspace = touchWorkspace(opts.workspacePath, { home, now: startedAt });
  const runId = opts.runId ?? newGateRunId("semantic", startedAt);
  const runDir = semanticRunDir(home, workspace.id, runId);
  if (fs.existsSync(runDir) && fs.existsSync(path.join(runDir, SEMANTIC_RESULT_FILE))) throw new SemanticRunError("RUN_EXISTS", t("semantic_run_exists", { runId }));
  mkdirPrivate(runDir);
  const outputsDir = path.join(runDir, "outputs");
  mkdirPrivate(outputsDir);
  writeAtomic(path.join(runDir, SEMANTIC_PLAN_FILE), `${JSON.stringify(plan, null, 2)}\n`);

  // The source this run judges, taken before anything is reviewed.
  const source: SourceIdentity = computeSourceIdentity(workspace.path, { env });
  // The resolved scope: its guard and the fingerprints of what is examined, taken before the review too.
  const scopePrep: ScopeRunPreparation | null = plan.scope?.resolution
    ? prepareScopeRun({ workspacePath: workspace.path, resolution: plan.scope.resolution, methods: plan.methods.map((m) => m.id), env })
    : null;
  let attached: AttachedQuality | null = null;
  if (plan.quality.attached) {
    const found = resolveQualityRun(home, workspace.id, plan.quality.attached);
    attached = found
      ? attachQuality(found, source, runDir, startedAt)
      : {
          evidence: { runId: plan.quality.attached, decision: null, complete: false, reduced: false, freshness: "unknown", code: "QUALITY_RUN_NOT_FOUND", reason: t("semantic_blocker_quality_not_found", { ref: plan.quality.attached }), currentApproval: false },
          bindingFile: null,
        };
  }

  const events = new EventLog({
    runId,
    files: [path.join(runDir, SEMANTIC_EVENTS_FILE), ...(opts.eventsFile ? [opts.eventsFile] : [])],
    now,
    ...(opts.onEvent ? { listener: opts.onEvent } : {}),
  });

  // Cancellation: the caller's signal or the request file, whichever comes first.
  const controller = new AbortController();
  const cancelFile = path.join(runDir, CANCEL_REQUEST_FILE);
  const abort = (reason: string): void => {
    if (controller.signal.aborted) return;
    controller.abort(reason);
    events.emit("cancel-requested", { reason });
    if (opts.ownsProcess) stopOwnedProcesses();
  };
  const onCallerAbort = (): void => {
    const r = opts.signal?.reason;
    abort(typeof r === "string" ? r : r instanceof Error ? r.message : "cancel");
  };
  const watchCancelFile = (): void => {
    if (!fs.existsSync(cancelFile)) return;
    const request = readJson<{ reason?: unknown }>(cancelFile);
    abort(typeof request?.reason === "string" && request.reason !== "" ? request.reason : "cancel requested");
  };
  const poll = setInterval(watchCancelFile, opts.cancelPollMs ?? 250);
  poll.unref();

  const configHash = contentHash({ settings: plan.settings, methods: plan.methods });
  const reached: Reached = { contextStarted: false, contextFinished: false, reviewStarted: false };
  let scopeFiles: string[] = [];
  let reviewFiles: string[] = [];
  const artifacts = (outcomeWritten: boolean): RunResult["artifacts"] => ({
    result: SEMANTIC_RESULT_FILE,
    logs: [],
    outputs: [...(outcomeWritten ? [REVIEW_OUTPUT] : []), ...(attached?.bindingFile ? [attached.bindingFile] : []), ...scopeFiles, ...reviewFiles],
    events: SEMANTIC_EVENTS_FILE,
    plan: SEMANTIC_PLAN_FILE,
  });

  const assemble = (outcome: ResultSemantic | null, partial: boolean, cancelled: boolean, outcomeWritten: boolean): RunResult => {
    const { context, review } = stagesOf(outcome, reached, cancelled);
    const stages = [context, review];
    const requirements = [
      { id: CONTEXT_STAGE, required: true },
      { id: REVIEW_STAGE, required: true },
    ];
    const decided = computeDecision({ resolved: true, cancelled, requirements, stages });
    let { decision, complete, exitCode } = decided;
    if (!cancelled && outcome?.state === "invalid") {
      decision = "invalid";
      exitCode = 3;
      complete = false;
    }
    if (partial) {
      complete = false;
      if (decision === "passed") {
        decision = "incomplete";
        exitCode = 2;
      }
    }
    const result: RunResult = {
      schemaVersion: 1,
      runId,
      gate: "semantic",
      tool: "jgates",
      version: opts.version,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      workspace: { id: workspace.id, path: workspace.path, name: workspace.name },
      runDir,
      selection: {
        adapter: SEMANTIC_ADAPTER,
        options: {
          methods: plan.methods.map((m) => m.id).join(","),
          ...(plan.settings.provider ? { provider: plan.settings.provider } : {}),
          ...(plan.settings.model ? { model: plan.settings.model } : {}),
          ...(plan.settings.scope ? { scope: plan.settings.scope } : {}),
          ...(plan.quality.attached ? { quality: plan.quality.attached } : {}),
        },
        overrides: [],
        planHash: plan.planHash,
        planSource: "built",
      },
      decision,
      complete,
      reduced: false,
      exitCode,
      requirements,
      stages,
      findings: findingsOf(outcome),
      unsatisfied: decided.unsatisfied,
      warnings: decided.warnings,
      blockingViolations: decided.blockingViolations,
      disabled: [],
      // A review reads the workspace and writes nothing in it.
      workspaceChanges: { checked: false, added: [], modified: [], removed: [] },
      artifacts: artifacts(outcomeWritten),
      ...(partial ? { partial: true } : {}),
      ...(cancelled ? { stopped: { cause: "cancelled" as const, stepId: review.state === "cancelled" && context.state === "completed" ? REVIEW_STAGE : CONTEXT_STAGE, detail: "cancelled" } } : {}),
      semanticRun: {
        schemaVersion: 1,
        enforcement: "advisory",
        methods: plan.methods.map((m) => m.id),
        outcome,
        source: { id: source.id, basis: source.basis, traceable: source.traceable },
        quality: attached?.evidence ?? null,
      },
    };
    result.summary = summaryOf(result);
    return result;
  };

  const identityOf = (result: RunResult): GateRunIdentity => ({
    schemaVersion: 1,
    gate: "semantic",
    runId,
    configHash,
    source,
    plan: { hash: plan.planHash, source: "built" },
    stages: result.stages.map((s) => ({ id: s.id, state: s.state })),
    outcome: { decision: result.decision, complete: result.complete, reduced: false, exitCode: result.partial ? null : result.exitCode, partial: result.partial === true },
    artifacts: { result: SEMANTIC_RESULT_FILE, logs: [], outputs: result.artifacts.outputs, plan: SEMANTIC_PLAN_FILE, events: SEMANTIC_EVENTS_FILE },
  });
  const write = (result: RunResult): void => {
    writeAtomic(path.join(runDir, SEMANTIC_RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
    writeGateRecord("run-identity", path.join(runDir, RUN_IDENTITY_FILE), identityOf(result));
  };
  const checkpoint = (): void => write(assemble(null, true, controller.signal.aborted, false));

  checkpoint();
  const heartbeat = startHeartbeat(runDir);
  events.emit("run-started", {
    gate: "semantic",
    workspace: { id: workspace.id, path: workspace.path },
    runDir,
    adapter: SEMANTIC_ADAPTER,
    planHash: plan.planHash,
    methods: plan.methods.map((m) => m.id),
    sourceId: source.id,
    ...(attached ? { quality: { runId: attached.evidence.runId, freshness: attached.evidence.freshness } } : {}),
    ...(scopePrep
      ? {
          scope: {
            mode: scopePrep.resolution.mode,
            scopeHash: scopePrep.resolution.scopeHash,
            toExamine: scopePrep.toExamine.length,
            reused: scopePrep.resolution.completion.reused,
            context: scopePrep.resolution.context.length,
            inheritedCoverage: scopePrep.resolution.inheritedCoverage.state,
          },
        }
      : {}),
  });
  if (opts.signal?.aborted) onCallerAbort();
  else opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
  watchCancelFile();

  const onProgress: SemanticProgress = (phase, status, data) => {
    if (phase === "context" && status === "started" && !reached.contextStarted) {
      reached.contextStarted = true;
      events.emit("step-started", { step: CONTEXT_STAGE, label: t("semantic_stage_context"), dependsOn: [] });
      events.emit("stage", { step: CONTEXT_STAGE, stageId: CONTEXT_STAGE, state: "running" });
    } else if (phase === "context" && status === "finished" && !reached.contextFinished) {
      reached.contextFinished = true;
      events.emit("stage", { step: CONTEXT_STAGE, stageId: CONTEXT_STAGE, state: "completed", ...data });
      events.emit("step-finished", { step: CONTEXT_STAGE, status: "completed", durationMs: 0 });
    } else if (phase === "review" && status === "started" && !reached.reviewStarted) {
      reached.reviewStarted = true;
      events.emit("step-started", { step: REVIEW_STAGE, label: t("semantic_stage_review"), dependsOn: [CONTEXT_STAGE] });
      events.emit("stage", { step: REVIEW_STAGE, stageId: REVIEW_STAGE, state: "running", ...data });
    } else if (phase === "review" && status === "call") {
      events.emit("stage", { step: REVIEW_STAGE, stageId: REVIEW_STAGE, state: "running", ...data });
    } else {
      return;
    }
    checkpoint();
  };

  // Events of the work inside the review step, in the same ordered stream; each one also refreshes the partial result.
  let reviewOpen = true;
  const emitReviewEvent = (type: InvestigationEventType, data: Record<string, unknown>): void => {
    if (!reviewOpen) return;
    events.emit(type, { step: REVIEW_STAGE, ...data });
    if (type === "stage") checkpoint();
  };

  // A tool-enabled investigation when the caller asks for one or a module is registered for the plan's method; it
  // needs the resolved scope (its guard decides every read).
  const module = opts.investigation?.module ?? investigationModuleFor(plan.methods.map((m) => m.id));
  const investigate: SemanticReviewer | null = module
    ? async (ctx) => {
        if (!ctx.scope) {
          return { requested: true, state: "unavailable", separateFromDecision: true, provider: plan.settings.provider, model: plan.settings.model, scope: plan.settings.scope, limits: plan.settings.limits, cost: { reported: false, perCall: null, total: null }, calls: 0, reason: "An investigation needs a resolved scope; this plan has none." };
        }
        return runInvestigation({
          module,
          workspacePath: ctx.workspacePath,
          runDir: ctx.runDir,
          env: ctx.env,
          signal: ctx.signal,
          scope: ctx.scope,
          rigor: ctx.plan.rigor,
          budget: { maxCalls: ctx.plan.budget.maxCalls, maxTokens: ctx.plan.budget.maxTokens, maxSeconds: opts.investigation?.maxSeconds ?? null },
          onProgress: ctx.onProgress,
          emit: ctx.emit,
          ...(opts.investigation?.deps ? { deps: opts.investigation.deps } : {}),
          ...(opts.investigation?.agentCli ? { agentCli: opts.investigation.agentCli } : {}),
          now,
        });
      }
    : null;
  const contextReview: SemanticReviewer = (ctx) =>
    runSemanticReview(
      ctx.workspacePath,
      {
        env: ctx.env,
        signal: ctx.signal,
        onProgress: ctx.onProgress,
        // Only the subjects to examine and the allowed context reach the provider; the guard decides each file.
        ...(ctx.scope ? { scope: { paths: ctx.scope.sendPaths, allow: (p: string) => ctx.scope!.allow(p) } } : {}),
      },
      opts.deps ?? {},
    );
  // A module whose method is also a context-only review (the general review) falls back to it when the provider has
  // no tool-enabled backend, so providers that only answer one prompt keep their advisory review.
  const review: SemanticReviewer =
    opts.review ??
    (investigate && module?.contextReviewFallback
      ? async (ctx) => {
          const outcome = await investigate(ctx);
          return outcome.code === "NO_TOOL_BACKEND" ? contextReview(ctx) : outcome;
        }
      : investigate) ??
    contextReview;
  let outcome: ResultSemantic;
  try {
    outcome = controller.signal.aborted
      ? { requested: true, state: "unavailable", separateFromDecision: true, provider: plan.settings.provider, model: plan.settings.model, scope: plan.settings.scope, limits: plan.settings.limits, cost: { reported: false, perCall: null, total: null }, calls: 0, reason: "cancelled before the review started" }
      : await review({ workspacePath: workspace.path, runDir, outputsDir, env, signal: controller.signal, onProgress, scope: scopePrep, plan, emit: emitReviewEvent });
  } catch (error) {
    outcome = {
      requested: true,
      state: "unavailable",
      separateFromDecision: true,
      provider: plan.settings.provider,
      model: plan.settings.model,
      scope: plan.settings.scope,
      limits: plan.settings.limits,
      cost: { reported: false, perCall: null, total: null },
      calls: 0,
      reason: error instanceof Error ? error.message.slice(0, 300) : "the semantic review failed",
    };
  } finally {
    reviewOpen = false;
    clearInterval(poll);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
  // The evidence an investigation wrote (its record and the transcript of each context), as outputs of the run.
  const investigationArtifacts = (outcome.investigation as { artifacts?: { record?: unknown; contexts?: unknown; module?: unknown } } | undefined)?.artifacts;
  if (investigationArtifacts) {
    reviewFiles = [
      investigationArtifacts.record,
      ...(Array.isArray(investigationArtifacts.contexts) ? investigationArtifacts.contexts : []),
      // The module's own records (a structured report, a readable result, an agent context).
      ...(Array.isArray(investigationArtifacts.module) ? investigationArtifacts.module : []),
    ].filter((f): f is string => typeof f === "string");
  }
  // A request that arrived while the last answer was being judged still cancels the run.
  watchCancelFile();
  const cancelled = controller.signal.aborted;
  writeAtomic(path.join(runDir, REVIEW_OUTPUT), `${JSON.stringify(outcome, null, 2)}\n`);
  if (scopePrep) {
    // The units actually examined and the ledger a later run may reuse after its own checks. A review that did not
    // complete leaves every examined unit unresolved: nothing of it can be carried as covered.
    const sentPaths = (outcome.context as { paths?: unknown } | undefined)?.paths;
    const findings = outcome.state === "completed" && Array.isArray(outcome.conclusion?.findings) ? (outcome.conclusion.findings as Array<{ path?: unknown; confirmation?: unknown }>) : [];
    try {
      scopeFiles = finishScopeRun(runDir, scopePrep, {
        runId,
        now: now(),
        completed: outcome.state === "completed" && !cancelled,
        findings,
        sentRepositoryPaths: Array.isArray(sentPaths) ? sentPaths.filter((p): p is string => typeof p === "string") : null,
      });
    } catch (error) {
      // Without its scope record the run cannot say what it examined: it is never favorable.
      if (outcome.state === "completed") {
        outcome = { ...outcome, state: "unavailable", reason: `The scope record could not be written: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` };
        writeAtomic(path.join(runDir, REVIEW_OUTPUT), `${JSON.stringify(outcome, null, 2)}\n`);
      }
    }
  }
  const result = assemble(outcome, false, cancelled, true);
  // The final state of each stage, unless the progress already announced it.
  for (const s of result.stages) {
    const announced = s.id === CONTEXT_STAGE ? reached.contextFinished && s.state === "completed" : false;
    if (!announced) events.emit("stage", { step: s.id, stageId: s.id, state: s.state, ...(s.reason ? { reason: s.reason } : {}) });
  }
  if (reached.reviewStarted || result.stages[1]?.state !== "pending") {
    events.emit("step-finished", { step: REVIEW_STAGE, status: result.stages[1]?.state ?? "unknown", durationMs: outcome.durationMs ?? 0 });
  }
  write(result);
  heartbeat.stop();
  events.emit("run-finished", { decision: result.decision, exitCode: result.exitCode, complete: result.complete, reduced: false, ...(result.stopped ? { stopped: result.stopped } : {}) });
  events.close();
  return result;
}

export interface CancelOutcome {
  /** requested: the running process will stop; settled: the process was gone, the run is now settled as cancelled. */
  status: "requested" | "settled" | "not-active" | "not-found";
  runId: string;
}

/**
 * Asks a Semantic run to stop, from any process: writes the cancel request file the running process watches. A run
 * whose process is gone (interrupted) is settled at once as cancelled, keeping what it had produced.
 */
export function requestSemanticCancel(home: string, workspaceId: string, runId: string, options: { reason?: string; now?: () => Date } = {}): CancelOutcome {
  const run = findSemanticRun(home, workspaceId, runId);
  if (!run) return { status: "not-found", runId };
  if (run.lifecycle === "settled") return { status: "not-active", runId };
  const now = (options.now ?? (() => new Date()))();
  const reason = options.reason ?? "cancel requested";
  writeAtomic(path.join(run.dir, CANCEL_REQUEST_FILE), `${JSON.stringify({ schemaVersion: 1, requestedAt: now.toISOString(), reason, pid: process.pid })}\n`);
  if (run.lifecycle === "running") return { status: "requested", runId };
  settleInterrupted(run.dir, runId, reason, now);
  return { status: "settled", runId };
}

/** Settles the partial result of a run whose process died: cancelled, its stages as far as they got, events appended. */
function settleInterrupted(runDir: string, runId: string, reason: string, now: Date): void {
  const file = path.join(runDir, SEMANTIC_RESULT_FILE);
  const partial = readJson<RunResult>(file);
  const eventsFile = path.join(runDir, SEMANTIC_EVENTS_FILE);
  const last = readEvents(eventsFile).cursor;
  const append = (sequence: number, type: RunEvent["type"], data: Record<string, unknown>): void => {
    const event: RunEvent = { schemaVersion: 1, runId, sequence, type, at: now.toISOString(), data };
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  };
  append(last + 1, "cancel-requested", { reason });
  if (partial) {
    const stages = (partial.stages ?? []).map((s) => (s.state === "completed" ? s : { ...s, state: "cancelled" as const, reason: t("semantic_reason_cancelled") }));
    const settled: RunResult = {
      ...partial,
      finishedAt: now.toISOString(),
      stages,
      decision: "cancelled",
      complete: false,
      exitCode: 130,
      unsatisfied: stages.filter((s) => s.state !== "completed").map((s) => ({ requirementId: s.id, state: s.state })),
      stopped: { cause: "cancelled", detail: t("semantic_reason_interrupted") },
    };
    delete settled.partial;
    settled.summary = summaryOf(settled);
    writeAtomic(file, `${JSON.stringify(settled, null, 2)}\n`);
    const identityFile = path.join(runDir, RUN_IDENTITY_FILE);
    const identity = readJson<GateRunIdentity>(identityFile);
    if (identity) {
      try {
        writeGateRecord("run-identity", identityFile, {
          ...identity,
          stages: stages.map((s) => ({ id: s.id, state: s.state })),
          outcome: { decision: "cancelled", complete: false, reduced: false, exitCode: 130, partial: false },
        });
      } catch {
        // The result is settled; an identity that cannot be rewritten keeps its last valid copy.
      }
    }
  }
  append(last + 2, "run-finished", { decision: "cancelled", exitCode: 130, complete: false, reduced: false, stopped: { cause: "cancelled", detail: "interrupted" } });
  fs.rmSync(path.join(runDir, HEARTBEAT_FILE), { force: true });
}
