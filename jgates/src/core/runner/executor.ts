// The executor of the local runner: runs the steps of a run one at a time
// (concurrency 1) in dependency order, with a preflight before each, and keeps the result fail-closed:
// - a step whose prerequisite is absent does not start: its stages are blocked with the reason;
// - the steps that depend on a step that did not end well are blocked, the independent ones still run;
// - with --fail-fast the first failure stops the run and the rest is recorded as not run because of it;
// - a cancellation stops the running process tree and records the remaining steps as cancelled;
// - an output the adapter could not interpret is an error, never a completed stage with zero findings.
import { translator } from "../../i18n/index.js";
import type { EventType } from "../events/index.js";
import type { AdapterOutput, NotRunCause, ResultStage, StageExecution } from "../run/types.js";
import type { PreflightProblem } from "./preflight.js";
import { runInScope, type ProcessRecord } from "./scope.js";
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
}

export interface ExecuteStepsResult {
  reports: StepReport[];
  cancelled: boolean;
  failFast: { stepId: string; detail: string } | null;
}

const INERT = new Set(["disabled", "not_applicable"]);

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

/** Fail-closed reading of an adapter output: a completed stage whose output was not interpreted is an error. */
export function failClosed(output: AdapterOutput): AdapterOutput {
  const t = translator("runner");
  return {
    ...output,
    stages: output.stages.map((s) =>
      s.state === "completed" && s.interpreted === false ? { ...s, state: "error", reason: t("runner_invalid_output", { detail: s.reason ?? "-" }), blockingViolations: 0 } : s,
    ),
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
  const { ordered, problems } = orderSteps(steps);
  const status = new Map<string, StepStatus>();
  const reports: StepReport[] = [];
  let cancelled = false;
  let failFast: ExecuteStepsResult["failFast"] = null;

  // Tools started by helpers that do not go through runSpec are stopped too: every descendant of this process.
  const sweep = (): void => {
    if (!options.sweepDescendants) return;
    for (const pid of listDescendants(process.pid)) treeStopper(pid, { group: false, graceMs }).stop();
  };
  signal?.addEventListener("abort", sweep, { once: true });

  const record = (report: StepReport): void => {
    reports.push(report);
    status.set(report.step.id, report.status);
    for (const s of report.output.stages) emit("stage", { step: report.step.id, stageId: s.id, state: s.state, ...(s.reason ? { reason: s.reason } : {}) });
    if (report.status === "not-run") emit("step-skipped", { step: report.step.id, cause: report.cause ?? null });
    if (options.failFast && !failFast) {
      const bad = tripsFailFast(report.output);
      if (bad) failFast = { stepId: report.step.id, detail: `${bad.id}: ${bad.state}${bad.state === "completed" ? ` (${bad.blockingViolations ?? 0} blocking)` : ""}` };
    }
    options.onStep?.(report);
  };

  try {
    for (const step of ordered) {
      if (signal?.aborted) {
        cancelled = true;
        record({ step, status: "not-run", cause: "cancelled", output: notRun(skeletonOf(step), step.id, "cancelled", "cancelled", t("runner_not_run_cancelled")) });
        continue;
      }
      if (failFast) {
        const ff = failFast as { stepId: string; detail: string };
        const detail = t("runner_not_run_fail_fast", { step: ff.stepId, detail: ff.detail });
        record({ step, status: "not-run", cause: "fail-fast", output: notRun(skeletonOf(step), step.id, "blocked", "fail-fast", detail, { steps: [ff.stepId] }) });
        continue;
      }
      const structural = problems.get(step.id);
      if (structural) {
        const key = structural.kind === "unknown" ? "runner_unknown_dependency" : "runner_dependency_cycle";
        const detail = t(key, { steps: structural.steps.join(", ") });
        record({ step, status: "not-run", cause: "dependency", output: notRun(skeletonOf(step), step.id, "blocked", "dependency", detail, { steps: structural.steps }) });
        continue;
      }
      const badDeps = (step.dependsOn ?? []).filter((d) => status.get(d) !== "succeeded");
      if (badDeps.length > 0) {
        const detail = t("runner_blocked_dependency", { steps: badDeps.join(", "), states: badDeps.map((d) => `${d}: ${status.get(d) ?? "-"}`).join(", ") });
        record({ step, status: "not-run", cause: "dependency", output: notRun(skeletonOf(step), step.id, "blocked", "dependency", detail, { steps: badDeps }) });
        continue;
      }
      let found: PreflightProblem[] = [];
      try {
        found = step.preflight?.() ?? [];
      } catch (error) {
        found = [{ code: "PREREQUISITE_MISSING", message: error instanceof Error ? error.message : String(error) }];
      }
      if (found.length > 0) {
        const detail = t("runner_blocked_preflight", { detail: found.map((p) => p.message).join("; ") });
        const problemsOut = found.map((p) => ({ code: p.code, message: p.message }));
        record({ step, status: "not-run", cause: "preflight", output: notRun(skeletonOf(step), step.id, "blocked", "preflight", detail, { problems: problemsOut }) });
        continue;
      }

      const processes: ProcessRecord[] = [];
      const startedAt = new Date();
      emit("step-started", { step: step.id, ...(step.label ? { label: step.label } : {}), dependsOn: step.dependsOn ?? [] });
      let output: AdapterOutput;
      try {
        output = await settleOrAbandon(
          runInScope(
            {
              stepId: step.id,
              ...(signal ? { signal } : {}),
              ...(options.maxLogBytes !== undefined ? { maxLogBytes: options.maxLogBytes } : {}),
              killGraceMs: graceMs,
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
      let stepStatus: StepStatus;
      if (signal?.aborted) {
        // Stopped while running: whatever the step produced does not count.
        cancelled = true;
        output = notRun(output, step.id, "cancelled", "cancelled", t("runner_cancelled_running"));
        output.stages = output.stages.map((s) => (INERT.has(s.state) ? s : { ...s, execution: { ...execution, ...(s.execution?.notRun ? { notRun: s.execution.notRun } : {}) } }));
        stepStatus = "failed";
      } else {
        output = failClosed(output);
        output.stages = output.stages.map((s) => (s.state === "disabled" ? s : { ...s, execution: { ...execution, ...(s.execution ?? {}), step: step.id } }));
        stepStatus = stepSucceeded(output) ? "succeeded" : "failed";
      }
      emit("step-finished", { step: step.id, status: stepStatus, durationMs: execution.durationMs ?? 0 });
      record({ step, status: stepStatus, output, ...(signal?.aborted ? { cause: "cancelled" as const } : {}) });
    }
  } finally {
    signal?.removeEventListener("abort", sweep);
  }
  return { reports, cancelled, failFast };
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
