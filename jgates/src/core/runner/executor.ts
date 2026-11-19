// The executor of the local runner: runs the steps of a run in dependency order, with a preflight before each, and
// keeps the result fail-closed:
// - steps start in plan order; a step that only reads the project (`readOnly`) runs beside other such steps, up to
//   `concurrency` at a time; every other step runs alone (it waits for the running ones and nothing starts beside it);
//   the reports come back in plan order whatever the number, so the result does not depend on it (ADR-0023);
// - a step whose prerequisite is absent does not start: its stages are blocked with the reason;
// - the steps that depend on a step that did not end well are blocked, the independent ones still run;
// - with --fail-fast the first failure stops the run and the rest is recorded as not run because of it (fail-fast runs
//   one step at a time, so which steps ran never depends on timing);
// - a cancellation stops the process trees of every running step and records the remaining steps as cancelled;
// - in a step container, a process the kernel ended at the step's memory limit makes the step incomplete with that
//   reason (STEP_MEMORY_LIMIT), never a pass;
// - an output the adapter could not interpret is an error, never a completed stage with zero findings.
import { translator } from "../../i18n/index.js";
import type { EventType } from "../events/index.js";
import { DEFAULT_RESOURCES } from "../engine/index.js";
import { resolveReason } from "../reasons/index.js";
import type { AdapterOutput, NotRunCause, ResultStage, StageExecution } from "../run/types.js";
import type { PreflightProblem } from "./preflight.js";
import { runInScope, type ProcessRecord, type StepLauncherHook, type StepLaunchFacts } from "./scope.js";
import { listDescendants, treeStopper } from "./tree.js";

export interface RunStep {
  /** Step id (one per invocation of the plan, for example "quality-bridge" or a tool instance). */
  id: string;
  label?: string;
  /** Steps that must end well before this one runs. */
  dependsOn?: string[];
  /** Prerequisites checked right before the step starts; any problem blocks the step. */
  preflight?: () => PreflightProblem[];
  /** The stages, requirements and disabled entries the step reports when it does not run. */
  skeleton: () => AdapterOutput;
  run: () => Promise<AdapterOutput>;
  /** `bridge` only when a plan item of the step declares network; the step container has none otherwise. */
  network?: "none" | "bridge";
  /** Resources of the step container (the adapter manifest's `resources`); 4096 MB / 2 CPUs when absent. */
  resources?: StepLaunchFacts["resources"];
  /** The step's timeout (the smallest timeoutSeconds of its items): enforced for every process of the step that sets no timeout itself. */
  timeoutSeconds?: number;
  /**
   * The step only reads the synchronized copy of the project: it executes no project code, writes nothing next to the
   * sources and starts no service. Such steps may run beside each other; absent or false: the step runs alone.
   */
  readOnly?: boolean;
}

/**
 * A phase of the run before the steps (the sync of the project into the source volume). It runs once, in order; when it
 * fails no step starts and every step is recorded as not run with the phase's reason, never as an empty success.
 */
export interface RunPhase {
  id: string;
  label?: string;
  run: () => Promise<PhaseOutcome>;
}

export interface PhaseOutcome {
  ok: boolean;
  /** Why it failed (shown as the reason of the blocked steps). */
  reason?: string;
  /** Machine code of the failure. */
  code?: string;
  /** Facts of the phase for the events and the result (counts, exclusion list, engine text on failure). */
  details: Record<string, unknown>;
  /** Log files the phase wrote, relative to the run folder. */
  logs?: string[];
}

export interface PhaseReport {
  id: string;
  status: "succeeded" | "failed" | "cancelled";
  durationMs: number;
  outcome: PhaseOutcome;
}

export type StepStatus = "succeeded" | "failed" | "not-run";

export interface StepReport {
  step: RunStep;
  output: AdapterOutput;
  status: StepStatus;
  cause?: NotRunCause;
}

export interface ExecuteStepsOptions {
  signal?: AbortSignal;
  failFast?: boolean;
  /** Per-stream limit of the log files on disk, for every process of every step. */
  maxLogBytes?: number;
  killGraceMs?: number;
  /** On cancel, also stop every descendant of this process (the CLI owns all of them; tools a helper started without runSpec). */
  sweepDescendants?: boolean;
  emit?: (type: EventType, data: Record<string, unknown>) => void;
  /** Called after each step (the run writes its partial result there). */
  onStep?: (report: StepReport) => void;
  /** Phases that run once before the steps (sync, ...); a failed phase blocks every step. */
  phases?: RunPhase[];
  /** Container-first: every process of every step goes through this launcher (never the host). */
  launcher?: StepLauncherHook | null;
  /**
   * How many read-only steps may run at the same time (default 1: one step at a time). Steps that are not read-only
   * always run alone; with failFast every step runs alone.
   */
  concurrency?: number;
}

export interface ExecuteStepsResult {
  phases: PhaseReport[];
  reports: StepReport[];
  cancelled: boolean;
  failFast: { stepId: string; detail: string } | null;
}

const INERT = new Set(["disabled", "not_applicable"]);
const ENGINE_LOST_CODE = "ENGINE_LOST";
const MEMORY_LIMIT_CODE = "STEP_MEMORY_LIMIT";
/** Exit status of a process ended by SIGKILL: in a step container whose memory and swap are capped, the kernel's OOM kill. */
const KILLED_EXIT = 137;

/** The text of the ENGINE_LOST reason in the current language (the raw engine text never is the main text). */
function engineLostMessage(): string {
  return resolveReason(ENGINE_LOST_CODE).message;
}
/** Preflight problems about a tool on the host PATH; in container-first mode the image provides the tool. */
const HOST_TOOL_PROBLEMS = new Set<string>(["RUNTIME_MISSING", "BINARY_NOT_FOUND", "BINARY_NOT_EXECUTABLE", "VERSION_MISMATCH", "VERSION_UNKNOWN"]);

export function stageSatisfied(stage: ResultStage): boolean {
  return (stage.state === "completed" || stage.state === "not_applicable") && stage.interpreted !== false;
}

/** The step ended well: every stage that is not disabled or not applicable completed with an interpreted output. */
export function stepSucceeded(output: AdapterOutput): boolean {
  return output.stages.every((s) => INERT.has(s.state) || stageSatisfied(s));
}

/** What --fail-fast stops on: a required stage that did not end well, or a blocking violation. */
export function tripsFailFast(output: AdapterOutput): ResultStage | null {
  const required = new Map(output.requirements.map((r) => [r.id, r.required]));
  for (const s of output.stages) {
    if (INERT.has(s.state)) continue;
    if (s.state === "completed" && (s.blockingViolations ?? 0) > 0) return s;
    if (!stageSatisfied(s) && required.get(s.requirementId ?? s.id) !== false) return s;
  }
  return null;
}

/**
 * Fail-closed reading of an adapter output: a completed stage whose output was not interpreted is an error. A
 * completed stage that came back with its count of blocking violations (and not marked uninterpreted) is an output
 * the adapter read, so it says so (interpreted: true); a completed stage without a count stays neutral.
 */
export function failClosed(output: AdapterOutput): AdapterOutput {
  const t = translator("runner");
  return {
    ...output,
    stages: output.stages.map((s) => {
      if (s.state !== "completed") return s;
      if (s.interpreted === false) return { ...s, state: "error", reason: t("runner_invalid_output", { detail: s.reason ?? "-" }), blockingViolations: 0 };
      if (s.interpreted === undefined && typeof s.blockingViolations === "number") return { ...s, interpreted: true };
      return s;
    }),
  };
}

function notRun(output: AdapterOutput, stepId: string, state: "blocked" | "cancelled", cause: NotRunCause, detail: string, extra: Partial<NonNullable<StageExecution["notRun"]>> = {}): AdapterOutput {
  return {
    ...output,
    findings: [],
    stages: output.stages.map((s) => {
      if (INERT.has(s.state)) return s;
      const stage: ResultStage = { id: s.id, state, reason: detail, execution: { step: stepId, notRun: { cause, detail, ...extra } } };
      for (const key of ["label", "kind", "parentId", "adapter", "requirementId"] as const) if (s[key] !== undefined) (stage as unknown as Record<string, unknown>)[key] = s[key];
      return stage;
    }),
  };
}

function skeletonOf(step: RunStep): AdapterOutput {
  try {
    return step.skeleton();
  } catch {
    return { stages: [{ id: step.id, state: "pending" }], requirements: [{ id: step.id, required: true }], disabled: [], findings: [], logs: [], outputs: [] };
  }
}

/** Dependency order, stable on the input order; unknown dependencies and cycles are reported per step. */
function orderSteps(steps: RunStep[]): { ordered: RunStep[]; problems: Map<string, { kind: "unknown" | "cycle"; steps: string[] }> } {
  const ids = new Set(steps.map((s) => s.id));
  const problems = new Map<string, { kind: "unknown" | "cycle"; steps: string[] }>();
  for (const s of steps) {
    const unknown = (s.dependsOn ?? []).filter((d) => !ids.has(d));
    if (unknown.length > 0) problems.set(s.id, { kind: "unknown", steps: unknown });
  }
  const done = new Set<string>();
  const ordered: RunStep[] = [];
  let progress = true;
  while (progress && ordered.length < steps.length) {
    progress = false;
    for (const s of steps) {
      if (done.has(s.id)) continue;
      if ((s.dependsOn ?? []).every((d) => done.has(d) || !ids.has(d))) {
        ordered.push(s);
        done.add(s.id);
        progress = true;
        break;
      }
    }
  }
  const cyclic = steps.filter((s) => !done.has(s.id));
  for (const s of cyclic) {
    problems.set(s.id, { kind: "cycle", steps: cyclic.map((c) => c.id) });
    ordered.push(s);
  }
  return { ordered, problems };
}

/** Waits for the step; once the run is cancelled, a step that does not settle within the grace period is given up. */
function settleOrAbandon<T>(work: Promise<T>, signal: AbortSignal | undefined, graceMs: number): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const onAbort = (): void => {
      timer = setTimeout(() => reject(new Error("the step did not stop after the cancellation")), graceMs * 2 + 2000);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function executionOf(stepId: string, startedAt: Date, finishedAt: Date, processes: ProcessRecord[]): StageExecution {
  const last = processes[processes.length - 1];
  const execution: StageExecution = {
    step: stepId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    processes: processes.length,
  };
  if (last) {
    execution.exitCode = last.exitCode;
    execution.signal = last.signal;
    execution.timedOut = processes.some((p) => p.timedOut);
    execution.cancelled = processes.some((p) => p.cancelled);
    execution.stdoutBytes = last.stdoutBytes;
    execution.stderrBytes = last.stderrBytes;
    execution.logTruncated = processes.some((p) => p.logTruncated);
  }
  return execution;
}

export async function executeSteps(steps: RunStep[], options: ExecuteStepsOptions = {}): Promise<ExecuteStepsResult> {
  const t = translator("runner");
  const emit = options.emit ?? (() => undefined);
  const signal = options.signal;
  const graceMs = options.killGraceMs ?? 3000;
  // Fail-fast stops at "the first failure": with one step at a time that step is always the same one.
  const limit = options.failFast ? 1 : Math.max(1, Math.floor(Number.isFinite(options.concurrency) ? (options.concurrency as number) : 1));
  const { ordered, problems } = orderSteps(steps);
  const status = new Map<string, StepStatus>();
  // One slot per step, in plan order: the reports come back in that order whatever finished first.
  const slots: Array<StepReport | undefined> = new Array<StepReport | undefined>(ordered.length);
  let cancelled = false;
  let failFast: ExecuteStepsResult["failFast"] = null;

  // Tools started by helpers that do not go through runSpec are stopped too: every descendant of this process.
  const sweep = (): void => {
    if (!options.sweepDescendants) return;
    for (const pid of listDescendants(process.pid)) treeStopper(pid, { group: false, graceMs }).stop();
  };
  signal?.addEventListener("abort", sweep, { once: true });

  const record = (index: number, report: StepReport): void => {
    slots[index] = report;
    status.set(report.step.id, report.status);
    for (const s of report.output.stages) emit("stage", { step: report.step.id, stageId: s.id, state: s.state, ...(s.reason ? { reason: s.reason } : {}) });
    if (report.status === "not-run") emit("step-skipped", { step: report.step.id, cause: report.cause ?? null });
    if (options.failFast && !failFast) {
      const bad = tripsFailFast(report.output);
      if (bad) failFast = { stepId: report.step.id, detail: `${bad.id}: ${bad.state}${bad.state === "completed" ? ` (${bad.blockingViolations ?? 0} blocking)` : ""}` };
    }
    options.onStep?.(report);
  };

  // Phases first. The first one that does not end well stops the others and blocks every step.
  const phaseReports: PhaseReport[] = [];
  let phaseFailure: { id: string; reason: string; code: string } | null = null;
  for (const phase of options.phases ?? []) {
    if (phaseFailure || signal?.aborted) break;
    const startedAt = Date.now();
    emit("phase-started", { phase: phase.id, ...(phase.label ? { label: phase.label } : {}) });
    let outcome: PhaseOutcome;
    try {
      outcome = await phase.run();
    } catch (error) {
      outcome = { ok: false, code: "PHASE_CRASHED", reason: error instanceof Error ? error.message : String(error), details: {} };
    }
    const durationMs = Date.now() - startedAt;
    const status: PhaseReport["status"] = signal?.aborted ? "cancelled" : outcome.ok ? "succeeded" : "failed";
    emit("phase-finished", { phase: phase.id, status, durationMs, details: outcome.details, ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.code ? { code: outcome.code } : {}) });
    phaseReports.push({ id: phase.id, status, durationMs, outcome });
    if (status === "failed") phaseFailure = { id: phase.id, reason: outcome.reason ?? phase.id, code: outcome.code ?? "PHASE_FAILED" };
  }

  /** Why the step does not start, decided right before it would start (after its dependencies ended); null: it starts. */
  const notStarting = (step: RunStep): StepReport | null => {
    if (phaseFailure && !signal?.aborted) {
      const detail = t("runner_blocked_preflight", { detail: phaseFailure.reason });
      return { step, status: "not-run", cause: "preflight", output: notRun(skeletonOf(step), step.id, "blocked", "preflight", detail, { problems: [{ code: phaseFailure.code, message: phaseFailure.reason }] }) };
    }
    if (signal?.aborted) {
      cancelled = true;
      return { step, status: "not-run", cause: "cancelled", output: notRun(skeletonOf(step), step.id, "cancelled", "cancelled", t("runner_not_run_cancelled")) };
    }
    if (failFast) {
      const ff = failFast as { stepId: string; detail: string };
      const detail = t("runner_not_run_fail_fast", { step: ff.stepId, detail: ff.detail });
      return { step, status: "not-run", cause: "fail-fast", output: notRun(skeletonOf(step), step.id, "blocked", "fail-fast", detail, { steps: [ff.stepId] }) };
    }
    const structural = problems.get(step.id);
    if (structural) {
      const key = structural.kind === "unknown" ? "runner_unknown_dependency" : "runner_dependency_cycle";
      const detail = t(key, { steps: structural.steps.join(", ") });
      return { step, status: "not-run", cause: "dependency", output: notRun(skeletonOf(step), step.id, "blocked", "dependency", detail, { steps: structural.steps }) };
    }
    const badDeps = (step.dependsOn ?? []).filter((d) => status.get(d) !== "succeeded");
    if (badDeps.length > 0) {
      const detail = t("runner_blocked_dependency", { steps: badDeps.join(", "), states: badDeps.map((d) => `${d}: ${status.get(d) ?? "-"}`).join(", ") });
      return { step, status: "not-run", cause: "dependency", output: notRun(skeletonOf(step), step.id, "blocked", "dependency", detail, { steps: badDeps }) };
    }
    // The engine vanished during an earlier step: nothing else starts, and the step says why.
    const lostEarlier = options.launcher?.engineLost?.();
    if (lostEarlier) {
      const message = engineLostMessage();
      return {
        step,
        status: "not-run",
        cause: "preflight",
        output: notRun(skeletonOf(step), step.id, "blocked", "preflight", t("runner_engine_lost_blocked", { message }), { problems: [{ code: ENGINE_LOST_CODE, message }] }),
      };
    }
    let found: PreflightProblem[] = [];
    try {
      found = step.preflight?.() ?? [];
      // Under the launcher the tool lives in the image: a binary the host does not have is not a problem of the step.
      if (options.launcher) found = found.filter((p) => !HOST_TOOL_PROBLEMS.has(p.code));
    } catch (error) {
      found = [{ code: "PREREQUISITE_MISSING", message: error instanceof Error ? error.message : String(error) }];
    }
    if (found.length > 0) {
      const detail = t("runner_blocked_preflight", { detail: found.map((p) => p.message).join("; ") });
      const problemsOut = found.map((p) => ({ code: p.code, message: p.message }));
      return { step, status: "not-run", cause: "preflight", output: notRun(skeletonOf(step), step.id, "blocked", "preflight", detail, { problems: problemsOut }) };
    }
    return null;
  };

  /** Runs one step that passed its checks and returns its report (never throws). */
  const runStep = async (step: RunStep, running: number): Promise<StepReport> => {
    const processes: ProcessRecord[] = [];
    const startedAt = new Date();
    emit("step-started", {
      step: step.id,
      ...(step.label ? { label: step.label } : {}),
      dependsOn: step.dependsOn ?? [],
      ...(options.launcher ? { network: step.network ?? "none" } : {}),
      readOnly: step.readOnly === true,
      running,
      concurrency: limit,
    });
    let output: AdapterOutput;
    try {
      output = await settleOrAbandon(
        runInScope(
          {
            stepId: step.id,
            ...(signal ? { signal } : {}),
            ...(options.maxLogBytes !== undefined ? { maxLogBytes: options.maxLogBytes } : {}),
            killGraceMs: graceMs,
            ...(options.launcher
              ? {
                  launcher: options.launcher,
                  launch: {
                    network: step.network ?? "none",
                    ...(step.resources ? { resources: step.resources } : {}),
                    ...(step.timeoutSeconds !== undefined && step.timeoutSeconds > 0 ? { timeoutMs: step.timeoutSeconds * 1000 } : {}),
                  },
                }
              : {}),
            onProcessStart: (p) => emit("process-started", { step: step.id, pid: p.pid, executable: p.executable }),
            onProcessEnd: (r) => {
              processes.push(r);
              emit("process-finished", { step: step.id, ...r });
            },
          },
          () => step.run(),
        ),
        signal,
        graceMs,
      );
    } catch (error) {
      const detail = t("runner_step_crashed", { detail: error instanceof Error ? error.message : String(error) });
      const base = skeletonOf(step);
      output = { ...base, findings: [], stages: base.stages.map((s) => (INERT.has(s.state) ? s : { ...s, state: "error", reason: detail, interpreted: false })) };
    }
    const finishedAt = new Date();
    const execution = executionOf(step.id, startedAt, finishedAt, processes);
    // The stderr logs the adapter wrote itself start with the in-container command and the docker run line.
    try {
      options.launcher?.annotateLogs?.(step.id, output.logs);
    } catch {
      // A log that cannot be annotated stays as the adapter wrote it.
    }
    let stepStatus: StepStatus;
    const killedAtLimit = options.launcher ? processes.some((p) => p.exitCode === KILLED_EXIT && !p.timedOut && !p.cancelled) : false;
    if (signal?.aborted) {
      // Stopped while running: whatever the step produced does not count.
      cancelled = true;
      output = notRun(output, step.id, "cancelled", "cancelled", t("runner_cancelled_running"));
      output.stages = output.stages.map((s) => (INERT.has(s.state) ? s : { ...s, execution: { ...execution, ...(s.execution?.notRun ? { notRun: s.execution.notRun } : {}) } }));
      stepStatus = "failed";
    } else if (options.launcher?.engineLost?.()) {
      // The engine disappeared while the step ran: whatever the tool said proves nothing. The step ends incomplete
      // (an errored stage, never completed, never a violation), with the shared reason code.
      const message = engineLostMessage();
      const base = skeletonOf(step);
      output = {
        ...base,
        findings: [],
        stages: base.stages.map((s) =>
          INERT.has(s.state) ? s : { ...s, state: "error", reason: t("runner_engine_lost", { message }), interpreted: false, execution: { ...execution, reasonCode: ENGINE_LOST_CODE } },
        ),
      };
      stepStatus = "failed";
    } else if (killedAtLimit) {
      // The kernel ended a process of the step at the container's memory limit: the tool did not finish, so what it
      // printed proves nothing. Incomplete, with the limit and the hint to run fewer checks at a time.
      const memoryMb = step.resources?.memoryMb ?? DEFAULT_RESOURCES.memoryMb;
      const detail = t("runner_memory_limit", { memory: memoryMb, concurrency: limit });
      const base = skeletonOf(step);
      output = {
        ...base,
        findings: [],
        logs: output.logs,
        outputs: output.outputs,
        stages: base.stages.map((s) => (INERT.has(s.state) ? s : { ...s, state: "error", reason: detail, interpreted: false, execution: { ...execution, reasonCode: MEMORY_LIMIT_CODE } })),
      };
      stepStatus = "failed";
    } else {
      output = failClosed(output);
      // timeoutSeconds holds for every adapter: a process the executor's timeout stopped never leaves a completed stage.
      if (execution.timedOut && step.timeoutSeconds !== undefined) {
        const detail = t("runner_step_timeout", { seconds: step.timeoutSeconds });
        output = { ...output, findings: [], stages: output.stages.map((s) => (INERT.has(s.state) || s.state === "timeout" ? s : { ...s, state: "timeout", reason: detail, blockingViolations: 0 })) };
      }
      output.stages = output.stages.map((s) => (s.state === "disabled" ? s : { ...s, execution: { ...execution, ...(s.execution ?? {}), step: step.id } }));
      stepStatus = stepSucceeded(output) ? "succeeded" : "failed";
    }
    emit("step-finished", { step: step.id, status: stepStatus, durationMs: execution.durationMs ?? 0 });
    return { step, status: stepStatus, output, ...(signal?.aborted ? { cause: "cancelled" as const } : {}) };
  };

  // The steps that are running, and whether one of them runs alone.
  const inflight = new Set<Promise<void>>();
  let aloneRunning = false;
  // A callback (onStep) that threw: the run stops starting steps, waits for the running ones and throws it.
  let thrown: { error: unknown } | null = null;
  const known = new Set(ordered.map((s) => s.id));
  const dependenciesEnded = (step: RunStep): boolean => (step.dependsOn ?? []).every((d) => !known.has(d) || status.has(d));

  try {
    for (let index = 0; index < ordered.length; index += 1) {
      const step = ordered[index] as RunStep;
      const shared = limit > 1 && step.readOnly === true;
      // Wait until the step may start: its dependencies have ended, and there is room. A step that runs alone waits for
      // an empty machine; a read-only step waits for a free place and for no step running alone.
      while (inflight.size > 0 && !(dependenciesEnded(step) && shared && !aloneRunning && inflight.size < limit)) {
        await Promise.race(inflight);
        if (thrown) break;
      }
      if (thrown) break;
      const skipped = notStarting(step);
      if (skipped) {
        record(index, skipped);
        continue;
      }
      if (!shared) aloneRunning = true;
      const running = inflight.size + 1;
      const handle: Promise<void> = runStep(step, running)
        .then((report) => record(index, report))
        .catch((error: unknown) => {
          thrown ??= { error };
        })
        .finally(() => {
          inflight.delete(handle);
          if (!shared) aloneRunning = false;
        });
      inflight.add(handle);
    }
    // Every step has started or been recorded: wait for the ones still running.
    while (inflight.size > 0) await Promise.race(inflight);
  } finally {
    signal?.removeEventListener("abort", sweep);
  }
  if (thrown) throw (thrown as { error: unknown }).error;
  const reports = slots.filter((r): r is StepReport => r !== undefined);
  return { phases: phaseReports, reports, cancelled, failFast };
}

/** Merges the outputs of the steps, in order. */
export function mergeOutputs(outputs: AdapterOutput[]): AdapterOutput {
  const merged: AdapterOutput = { stages: [], requirements: [], disabled: [], findings: [], logs: [], outputs: [] };
  for (const out of outputs) {
    merged.stages.push(...out.stages);
    merged.requirements.push(...out.requirements);
    merged.disabled.push(...out.disabled);
    merged.findings.push(...out.findings);
    if (out.metrics?.length) (merged.metrics ??= []).push(...out.metrics);
    if (out.architecture?.length) (merged.architecture ??= []).push(...out.architecture);
    merged.logs.push(...out.logs);
    merged.outputs.push(...out.outputs);
  }
  return merged;
}
