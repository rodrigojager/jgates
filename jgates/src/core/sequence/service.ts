// The combined gate sequence: Quality runs first, then Semantic starts automatically only when the Quality run's own
// decision fields, its source identity against the current source, the scope and the policy say it may (approval.ts).
// Each gate keeps its own run ID, folder, decision, artifacts and cancellation; the sequence (store.ts) only links them
// and records why it advanced, paused, stopped or was cancelled. Nothing here rewrites a run's decision.
//
// The caller provides the Quality execution (the CLI runs the plan with the same options as `jgates run`); the
// Semantic run is the independent Semantic service (core/semantic executeSemanticRun) with the Quality report attached
// as evidence. Cancellation: the caller's AbortSignal or a cancel request file in the sequence folder
// (requestSequenceCancel, used by the server and other processes); it reaches whichever run is going, which stops only
// its own processes and keeps its partial evidence, and the other gate never starts.
import fs from "node:fs";
import path from "node:path";
import { listRuns } from "../artifacts/index.js";
import { touchWorkspace, resolveHome } from "../home/index.js";
import { newGateRunId, newSequenceId } from "../gates/ids.js";
import { loadGateRecord, readResultAsGateRun } from "../gates/read.js";
import { computeSourceIdentity } from "../gates/source.js";
import type { GateRunIdentity, SequenceRecord, SequenceStatus, SourceIdentity } from "../gates/types.js";
import { startHeartbeat } from "../run/heartbeat.js";
import { planOutputs } from "../run/analysis.js";
import type { RunResult } from "../run/types.js";
import type { Plan } from "../plan/types.js";
import { buildSemanticPlan, type SemanticPlan } from "../semantic/plan.js";
import { executeSemanticRun, SemanticRunError, type SemanticReviewer, type SemanticInvestigationOptions } from "../semantic/service.js";
import type { SemanticDeps } from "../../adapters/semantic-gate/index.js";
import type { RunEvent } from "../events/index.js";
import { translator } from "../../i18n/index.js";
import { assessQualityPrerequisite, sequenceCoverage, type QualityAssessment, type QualityEvidence } from "./approval.js";
import { semanticScopeShape, semanticSettingsHash, type GatePlan } from "./plan.js";
import { findEquivalentQuality, QUALITY_RUN_IDENTITY_FILE, type ReuseOutcome } from "./reuse.js";
import {
  clearCancelRequest,
  isSequenceId,
  readCancelRequest,
  readSequence,
  sequenceDir,
  writeCancelRequest,
  writeSequence,
  type SequenceDetails,
  type SequenceRequest,
  type SequenceRunSummary,
} from "./store.js";

const t = translator("sequence");

export const EXIT_PASSED = 0;
/** A combined approval that is not complete (paused, waiting for an advance, a stage that did not finish). */
export const EXIT_INCOMPLETE = 2;
/** The plan of a gate could not run (configuration, coverage, Semantic prerequisites): nothing started. */
export const EXIT_NOT_READY = 3;
export const EXIT_CANCELLED = 130;

export type SequenceErrorCode = "BAD_SEQUENCE_ID" | "SEQUENCE_EXISTS" | "SEQUENCE_NOT_FOUND" | "SEQUENCE_NOT_AWAITING" | "SEQUENCE_NOT_COMBINED";

export class SequenceError extends Error {
  constructor(
    readonly code: SequenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SequenceError";
  }
}

/** Starts the Quality run of the plan; reports the run ID as soon as the run has one. */
export type QualityExecutor = (input: { plan: Plan; signal: AbortSignal; onRunStarted: (runId: string) => void }) => Promise<RunResult | { error: { code: string; message: string; exitCode: number } }>;

/** Seams and controls of the Semantic run inside a sequence. */
export interface SequenceSemanticOptions {
  deps?: SemanticDeps;
  review?: SemanticReviewer;
  investigation?: SemanticInvestigationOptions;
  onEvent?: (event: RunEvent) => void;
  eventsFile?: string;
}

export interface SequenceCommon {
  workspacePath: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  version: string;
  now?: () => Date;
  /** Cancels the sequence (Ctrl+C in the CLI). A cancel request file does the same from another process. */
  signal?: AbortSignal;
  /** On cancel, the running gate also stops every descendant of this process (the CLI process owns them all). */
  ownsProcess?: boolean;
  semantic?: SequenceSemanticOptions;
  /** Called each time the sequence record changes (progress on stderr). */
  onUpdate?: (record: SequenceRecord, details: SequenceDetails) => void;
  /** How often the cancel request file is looked for (ms). */
  cancelPollMs?: number;
}

export interface SequenceRunOptions extends SequenceCommon {
  /** A sequence ID chosen by the caller (the server allocates it to answer at once); otherwise a new one. */
  sequenceId?: string;
  /** The plan of the combined selection (buildGatePlan), already built. */
  plan: GatePlan;
  request: SequenceRequest;
  runQuality: QualityExecutor;
}

export interface SequenceOutcome {
  sequenceId: string;
  dir: string;
  record: SequenceRecord;
  details: SequenceDetails;
  quality: RunResult | null;
  semantic: RunResult | null;
  exitCode: number;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The folder of a Quality run of the workspace (or of one relinked into it). */
function qualityRunDir(home: string, workspaceId: string, runId: string): string | null {
  return listRuns(home, workspaceId).find((r) => r.runId === runId)?.dir ?? null;
}

/** What a Quality run left on disk: result.json, its run identity (run.json, else derived) and its plan's scope. */
export function readQualityEvidence(home: string, workspaceId: string, runId: string): QualityEvidence & { dir: string | null } {
  const dir = qualityRunDir(home, workspaceId, runId);
  const result = dir ? readJson<RunResult>(path.join(dir, "result.json")) : null;
  let identity: GateRunIdentity | null = null;
  let recorded = false;
  if (dir && fs.existsSync(path.join(dir, QUALITY_RUN_IDENTITY_FILE))) {
    try {
      identity = loadGateRecord("run-identity", path.join(dir, QUALITY_RUN_IDENTITY_FILE));
      recorded = true;
    } catch {
      identity = null;
    }
  }
  if (!identity && result) {
    try {
      identity = readResultAsGateRun(result);
    } catch {
      identity = null;
    }
  }
  const planFile = dir && typeof result?.artifacts?.plan === "string" ? path.join(dir, result.artifacts.plan) : dir ? path.join(dir, "plan.json") : null;
  const plan = planFile ? readJson<Plan>(planFile) : null;
  return { runId, dir, result, identity, identityRecorded: recorded, planScope: plan?.scope ?? null };
}

const summaryOf = (result: RunResult | null, runId: string): SequenceRunSummary => ({
  runId,
  decision: result?.decision ?? null,
  complete: result?.complete === true,
  reduced: result?.reduced === true,
  exitCode: typeof result?.exitCode === "number" && result.partial !== true ? result.exitCode : null,
  runDir: result?.runDir ?? null,
});

/** The mutable state of one sequence while a process drives it. */
class SequenceState {
  constructor(
    readonly dir: string,
    public record: SequenceRecord,
    public details: SequenceDetails,
    private readonly now: () => Date,
    private readonly onUpdate?: (record: SequenceRecord, details: SequenceDetails) => void,
  ) {}

  set(status: SequenceStatus, event: string, extra: { code?: string; message?: string; runId?: string } = {}): void {
    const at = this.now().toISOString();
    const record: SequenceRecord = { ...this.record, status, updatedAt: at };
    if (extra.code && extra.message && ["paused", "stopped", "cancelled", "awaiting-advancement"].includes(status)) record.reason = { code: extra.code, message: extra.message };
    else delete record.reason;
    this.record = record;
    this.details = {
      ...this.details,
      timeline: [...this.details.timeline, { at, status, event, ...(extra.code ? { code: extra.code } : {}), ...(extra.runId ? { runId: extra.runId } : {}) }],
    };
    this.save();
  }

  save(): void {
    writeSequence(this.dir, this.record, this.details);
    this.onUpdate?.(this.record, this.details);
  }
}

/** Cancellation of a sequence: the caller's signal or the cancel request file, whichever comes first. */
function cancellation(dir: string, signal: AbortSignal | undefined, pollMs: number) {
  const controller = new AbortController();
  const abort = (reason: string): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onCaller = (): void => {
    const r = signal?.reason;
    abort(typeof r === "string" ? r : r instanceof Error ? r.message : "cancel");
  };
  const watch = (): void => {
    const request = readCancelRequest(dir);
    if (request) abort(request.reason);
  };
  if (signal?.aborted) onCaller();
  else signal?.addEventListener("abort", onCaller, { once: true });
  const timer = setInterval(watch, pollMs);
  timer.unref();
  watch();
  return {
    signal: controller.signal,
    check: watch,
    stop(): void {
      clearInterval(timer);
      signal?.removeEventListener("abort", onCaller);
    },
  };
}

/** Runs a combined sequence (Quality, then Semantic when approved) to its end. */
export async function executeSequence(opts: SequenceRunOptions): Promise<SequenceOutcome> {
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const home = opts.home ?? resolveHome({ env });
  const plan = opts.plan;
  if (!plan.advancement || plan.advancement.condition !== "quality-approved") throw new SequenceError("SEQUENCE_NOT_COMBINED", t("sequence_not_combined"));
  const sequenceId = opts.sequenceId ?? newSequenceId(now());
  if (!isSequenceId(sequenceId)) throw new SequenceError("BAD_SEQUENCE_ID", t("sequence_bad_id", { id: sequenceId }));
  const createdAt = now();
  const workspace = touchWorkspace(opts.workspacePath, { home, now: createdAt });
  const dir = sequenceDir(home, workspace.id, sequenceId);
  if (readSequence(home, workspace.id, sequenceId)) throw new SequenceError("SEQUENCE_EXISTS", t("sequence_exists", { id: sequenceId }));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const record: SequenceRecord = {
    schemaVersion: 1,
    sequenceId,
    createdAt: createdAt.toISOString(),
    selectedGates: ["quality", "semantic"],
    runs: [],
    advancement: { condition: "quality-approved" },
    status: "pending",
  };
  const details: SequenceDetails = {
    schemaVersion: 1,
    sequenceId,
    workspace: { id: workspace.id, path: workspace.path },
    selection: plan.selection,
    request: opts.request,
    plans: {
      quality: plan.quality ? { planHash: plan.quality.planHash, source: plan.qualitySource === "file" ? "file" : "built" } : null,
      semantic: plan.semantic && plan.semanticSettingsHash ? { planHash: plan.semantic.planHash, settingsHash: plan.semanticSettingsHash } : null,
    },
    quality: null,
    assessment: null,
    semantic: null,
    coverage: null,
    preflight: [],
    timeline: [{ at: createdAt.toISOString(), status: "pending", event: "created" }],
  };
  const state = new SequenceState(dir, record, details, now, opts.onUpdate);
  state.save();
  const heartbeat = startHeartbeat(dir);
  const cancel = cancellation(dir, opts.signal, opts.cancelPollMs ?? 250);
  try {
    // Nothing starts when either plan cannot run: the reason is the first blocker, every blocker is kept.
    if (!plan.ready || !plan.quality || !plan.semantic) {
      state.details = { ...state.details, preflight: plan.blockers.map((b) => ({ gate: b.gate, code: b.code, message: b.message, ...(b.details !== undefined ? { details: b.details } : {}) })) };
      const first = plan.blockers[0] ?? { code: "QUALITY_INVALID", message: t("sequence_quality_invalid", { code: "-", detail: "-" }) };
      state.set("stopped", "preflight", { code: first.code, message: first.message });
      return finish(state, null, null, EXIT_NOT_READY);
    }

    // Quality: an equivalent finished run when asked and every input matches, otherwise a new run.
    let qualityRunId: string | null = null;
    let reuse: ReuseOutcome | null = null;
    let qualityResult: RunResult | null = null;
    const qualityPlan = plan.quality;
    if (opts.request.reuseQuality) {
      let current: SourceIdentity | null = null;
      try {
        current = computeSourceIdentity(workspace.path, { env, outputs: planOutputs(qualityPlan) });
      } catch {
        current = null;
      }
      reuse = current ? findEquivalentQuality(home, workspace.id, qualityPlan, current, opts.version) : { state: "executed", reusedFrom: null, rejected: null, message: t("sequence_reuse_none") };
      if (reuse.state === "reused" && reuse.reusedFrom) {
        qualityRunId = reuse.reusedFrom.runId;
        state.record = { ...state.record, runs: [{ gate: "quality", runId: qualityRunId }] };
        qualityResult = readQualityEvidence(home, workspace.id, qualityRunId).result;
        state.details = { ...state.details, quality: { ...summaryOf(qualityResult, qualityRunId), reuse } };
        state.set("running", "quality-reused", { runId: qualityRunId });
      }
    }
    if (!qualityRunId) {
      if (cancel.signal.aborted) {
        state.set("cancelled", "cancel", { code: "SEQUENCE_CANCELLED", message: t("sequence_reason_sequence_cancelled") });
        return finish(state, null, null, EXIT_CANCELLED);
      }
      state.set("running", "quality-starting");
      const outcome = await opts.runQuality({
        plan: qualityPlan,
        signal: cancel.signal,
        onRunStarted: (runId) => {
          state.record = { ...state.record, runs: [{ gate: "quality", runId }] };
          state.set("running", "quality-started", { runId });
        },
      });
      if ("error" in outcome) {
        state.set("stopped", "quality-not-started", { code: outcome.error.code, message: outcome.error.message });
        return finish(state, null, null, outcome.error.exitCode);
      }
      qualityResult = outcome;
      qualityRunId = outcome.runId;
      state.record = { ...state.record, runs: [{ gate: "quality", runId: qualityRunId }] };
      state.details = { ...state.details, quality: { ...summaryOf(qualityResult, qualityRunId), reuse } };
      state.set("running", "quality-finished", { runId: qualityRunId });
    }
    return await transition(state, {
      ...opts,
      home,
      env,
      now,
      workspace: { id: workspace.id, path: workspace.path },
      qualityRunId,
      qualityResult,
      qualityOutputs: planOutputs(qualityPlan),
      settingsHash: plan.semanticSettingsHash,
      cancel,
      manualAdvance: opts.request.manualAdvance,
    });
  } finally {
    cancel.stop();
    heartbeat.stop();
  }
}

interface TransitionContext extends SequenceCommon {
  home: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  workspace: { id: string; path: string };
  qualityRunId: string;
  qualityResult: RunResult | null;
  /** Paths the Quality plan declares as outputs: the current source is taken the same way the Quality run took its own. */
  qualityOutputs: string[];
  /** The Semantic settings hash approved with the plan (null: not known, no check). */
  settingsHash: string | null;
  cancel: ReturnType<typeof cancellation>;
  manualAdvance?: boolean;
}

/** After Quality: assess the prerequisite, then pause, stop, wait or run Semantic. */
async function transition(state: SequenceState, ctx: TransitionContext): Promise<SequenceOutcome> {
  const { home, env, now, workspace } = ctx;
  const request = state.details.request;
  const evidence = readQualityEvidence(home, workspace.id, ctx.qualityRunId);
  const qualityResult = evidence.result ?? ctx.qualityResult;
  let current: SourceIdentity | null = null;
  try {
    current = computeSourceIdentity(workspace.path, { env, outputs: ctx.qualityOutputs });
  } catch {
    current = null;
  }
  const semanticScope = semanticScopeShape(request.semantic.scope);
  const assessment: QualityAssessment = assessQualityPrerequisite({
    quality: { ...evidence, result: qualityResult },
    current,
    policy: state.details.selection.policy.qualityCoverage,
    semanticScope,
    now: now(),
  });
  // The Semantic plan with the Quality report attached; it must decide the same review as the plan that was approved.
  const semanticPlan: SemanticPlan = buildSemanticPlan({
    workspacePath: workspace.path,
    home,
    env,
    now,
    quality: ctx.qualityRunId,
    ...(request.semantic.purpose ? { purpose: request.semantic.purpose } : {}),
    ...(request.semantic.rigor ? { rigor: request.semantic.rigor } : {}),
    scope: request.semantic.scope,
  });
  if (assessment.approved && ctx.settingsHash !== null && semanticSettingsHash(semanticPlan) !== ctx.settingsHash) {
    assessment.approved = false;
    assessment.status = "paused";
    const reason = { code: "SEMANTIC_SETTINGS_CHANGED", message: t("sequence_reason_semantic_settings_changed") };
    assessment.reasons.push(reason);
    assessment.code = reason.code;
    assessment.message = reason.message;
  }
  state.details = { ...state.details, assessment, coverage: sequenceCoverage(assessment.scope, { mode: semanticScope.mode, subjects: semanticScope.subjects.length, result: null }, false) };
  ctx.cancel.check();
  if (ctx.cancel.signal.aborted && assessment.status !== "cancelled") {
    state.set("cancelled", "cancel", { code: "SEQUENCE_CANCELLED", message: t("sequence_reason_sequence_cancelled") });
    return finish(state, qualityResult, null, EXIT_CANCELLED);
  }
  if (!assessment.approved) {
    const status: SequenceStatus = assessment.status === "cancelled" ? "cancelled" : assessment.status === "paused" ? "paused" : "stopped";
    state.set(status, "transition", { code: assessment.code, message: assessment.message, runId: ctx.qualityRunId });
    const qualityExit = typeof qualityResult?.exitCode === "number" && qualityResult.exitCode !== 0 ? qualityResult.exitCode : EXIT_INCOMPLETE;
    return finish(state, qualityResult, null, status === "cancelled" ? EXIT_CANCELLED : qualityExit);
  }
  if (ctx.manualAdvance) {
    state.details = { ...state.details, plans: { ...state.details.plans, semantic: { planHash: semanticPlan.planHash, settingsHash: semanticSettingsHash(semanticPlan) } } };
    state.set("awaiting-advancement", "transition", { code: "AWAITING_ADVANCE", message: t("sequence_reason_awaiting_advance", { id: state.record.sequenceId }), runId: ctx.qualityRunId });
    return finish(state, qualityResult, null, EXIT_INCOMPLETE);
  }
  return runSemantic(state, ctx, semanticPlan, qualityResult);
}

async function runSemantic(state: SequenceState, ctx: TransitionContext, semanticPlan: SemanticPlan, qualityResult: RunResult | null): Promise<SequenceOutcome> {
  const { home, env, now, workspace } = ctx;
  const semanticRunId = newGateRunId("semantic", now());
  state.record = { ...state.record, runs: [{ gate: "quality", runId: ctx.qualityRunId }, { gate: "semantic", runId: semanticRunId }] };
  state.set("advanced", "semantic-started", { code: "QUALITY_APPROVED", runId: semanticRunId });
  let semantic: RunResult;
  try {
    semantic = await executeSemanticRun({
      workspacePath: workspace.path,
      home,
      env,
      now,
      version: ctx.version,
      plan: semanticPlan,
      runId: semanticRunId,
      signal: ctx.cancel.signal,
      ...(ctx.ownsProcess ? { ownsProcess: true } : {}),
      ...(ctx.semantic?.deps ? { deps: ctx.semantic.deps } : {}),
      ...(ctx.semantic?.review ? { review: ctx.semantic.review } : {}),
      ...(ctx.semantic?.investigation ? { investigation: ctx.semantic.investigation } : {}),
      ...(ctx.semantic?.onEvent ? { onEvent: ctx.semantic.onEvent } : {}),
      ...(ctx.semantic?.eventsFile ? { eventsFile: ctx.semantic.eventsFile } : {}),
    });
  } catch (error) {
    // The Semantic prerequisites changed after Quality (a provider removed): it never started.
    const message = error instanceof SemanticRunError ? error.message : error instanceof Error ? error.message : String(error);
    state.record = { ...state.record, runs: [{ gate: "quality", runId: ctx.qualityRunId }] };
    state.set("stopped", "semantic-not-started", { code: "SEMANTIC_NOT_READY", message: t("sequence_reason_semantic_not_ready", { detail: message.slice(0, 300) }) });
    return finish(state, qualityResult, null, EXIT_NOT_READY);
  }
  const evidence = semantic.semanticRun?.quality ?? null;
  const scope = semanticScopeShape(state.details.request.semantic.scope);
  state.details = {
    ...state.details,
    semantic: { ...summaryOf(semantic, semantic.runId), planHash: semanticPlan.planHash, qualityEvidence: evidence ? { freshness: evidence.freshness, currentApproval: evidence.currentApproval } : null },
    coverage: sequenceCoverage(state.details.assessment?.scope ?? null, { mode: scope.mode, subjects: scope.subjects.length, result: semantic }, state.details.assessment?.approved === true),
  };
  if (semantic.decision === "cancelled") {
    state.set("cancelled", "semantic-finished", { code: "SEMANTIC_CANCELLED", message: t("sequence_reason_semantic_cancelled", { runId: semantic.runId }), runId: semantic.runId });
    return finish(state, qualityResult, semantic, EXIT_CANCELLED);
  }
  state.set("completed", "semantic-finished", { runId: semantic.runId });
  return finish(state, qualityResult, semantic, semantic.exitCode);
}

function finish(state: SequenceState, quality: RunResult | null, semantic: RunResult | null, exitCode: number): SequenceOutcome {
  return { sequenceId: state.record.sequenceId, dir: state.dir, record: state.record, details: state.details, quality, semantic, exitCode };
}

export interface AdvanceOptions extends SequenceCommon {
  sequenceId: string;
}

/**
 * Continues a sequence that waits after its Quality approval (run with manual advance). The prerequisite is checked
 * again: a source, settings or Quality state that changed since then pauses or stops the sequence instead of running
 * Semantic on a stale approval. Nothing needs repeated permission when everything is unchanged.
 */
export async function advanceSequence(opts: AdvanceOptions): Promise<SequenceOutcome> {
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const home = opts.home ?? resolveHome({ env });
  if (!isSequenceId(opts.sequenceId)) throw new SequenceError("BAD_SEQUENCE_ID", t("sequence_bad_id", { id: opts.sequenceId }));
  const workspace = touchWorkspace(opts.workspacePath, { home, now: now() });
  const view = readSequence(home, workspace.id, opts.sequenceId);
  if (!view || !view.details) throw new SequenceError("SEQUENCE_NOT_FOUND", t("sequence_not_found", { id: opts.sequenceId }));
  if (view.record.status !== "awaiting-advancement") throw new SequenceError("SEQUENCE_NOT_AWAITING", t("sequence_not_awaiting", { id: opts.sequenceId, status: view.record.status }));
  const qualityRunId = view.record.runs.find((r) => r.gate === "quality")?.runId;
  if (!qualityRunId) throw new SequenceError("SEQUENCE_NOT_AWAITING", t("sequence_not_awaiting", { id: opts.sequenceId, status: view.record.status }));
  const state = new SequenceState(view.dir, view.record, view.details, now, opts.onUpdate);
  clearCancelRequest(view.dir);
  const heartbeat = startHeartbeat(view.dir);
  const cancel = cancellation(view.dir, opts.signal, opts.cancelPollMs ?? 250);
  try {
    state.set("running", "advance-requested", { runId: qualityRunId });
    const evidence = readQualityEvidence(home, view.workspaceId, qualityRunId);
    const qualityPlan = evidence.dir ? readJson<Plan>(path.join(evidence.dir, "plan.json")) : null;
    return await transition(state, {
      ...opts,
      home,
      env,
      now,
      workspace: { id: view.workspaceId, path: workspace.path },
      qualityRunId,
      qualityResult: evidence.result,
      qualityOutputs: planOutputs(qualityPlan ?? undefined),
      settingsHash: view.details.plans.semantic?.settingsHash ?? null,
      cancel,
    });
  } finally {
    cancel.stop();
    heartbeat.stop();
  }
}

export interface SequenceCancelOutcome {
  /** requested: the driving process will stop; settled: nobody drove it, it is now cancelled. */
  status: "requested" | "settled" | "not-active" | "not-found";
  sequenceId: string;
}

/**
 * Asks a sequence to stop, from any process. A running one gets a cancel request (the running gate stops its own
 * processes and keeps its partial evidence; the next gate never starts). One that waits for an advance, or whose
 * process died, is settled at once as cancelled; its runs keep their own decisions.
 */
export function requestSequenceCancel(home: string, workspaceId: string, sequenceId: string, options: { reason?: string; now?: () => Date } = {}): SequenceCancelOutcome {
  const view = readSequence(home, workspaceId, sequenceId);
  if (!view) return { status: "not-found", sequenceId };
  const now = (options.now ?? (() => new Date()))();
  const reason = options.reason ?? "cancel requested";
  if (view.lifecycle === "settled") return { status: "not-active", sequenceId };
  writeCancelRequest(view.dir, reason, now);
  if (view.lifecycle === "running") return { status: "requested", sequenceId };
  if (view.details) {
    const state = new SequenceState(view.dir, view.record, view.details, () => now);
    state.set("cancelled", "cancel", { code: "SEQUENCE_CANCELLED", message: t("sequence_reason_sequence_cancelled") });
  }
  return { status: "settled", sequenceId };
}
