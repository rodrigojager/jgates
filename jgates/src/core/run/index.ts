// One JGates run: registers the workspace, creates the run folder outside it, runs the steps through the
// executor of the local runner (dependency order, preflight, fail-fast, cancellation), computes the fail-closed
// decision and writes result.json. The events of the run go to events.jsonl as they happen, and result.json
// is rewritten after each step with `partial: true`, so a run whose process dies is still on disk as incomplete.
// What the run analyzed (the work tree in place or a snapshot of another commit), the input manifest checked before
// and after the steps, the hashes and the identity go to `analyzed` and `provenance` (analysis.ts).
import fs from "node:fs";
import path from "node:path";
import { RunCache } from "../cache/index.js";
import { computeDecision } from "../contract/index.js";
import { EVENTS_FILE, EventLog, type RunEvent } from "../events/index.js";
import { createRunDir, resolveHome, touchWorkspace } from "../home/index.js";
import { newRunId } from "../ids/index.js";
import { listRuns } from "../artifacts/index.js";
import { compareWithBaseline, findingMetrics, finalizeFindings, loadWaiverFile, markBaselineState, WAIVERS_FILE, type Waiver } from "../results/index.js";
import { executeSteps, mergeOutputs, type RunStep } from "../runner/index.js";
import type { Plan } from "../plan/types.js";
import { describeAnalysis, planOutputs, prepareAnalysis, verifyInputs, type PreparedAnalysis } from "./analysis.js";
import type { AdapterContext, AdapterOutput, CacheableStep, ResultDisabled, ResultPolicy, RunResult, SemanticHook } from "./types.js";
import { ChangeAttribution, compareGitStatus, diffManifests, takeGitStatus, takeManifest } from "./workspace-state.js";

export * from "./types.js";
export { compareGitStatus, diffManifests, takeGitStatus, takeManifest } from "./workspace-state.js";
export * from "./analysis.js";
export { isLegacyPlan, legacyPlan, legacySteps, legacySelection, validateLegacyPlan } from "./legacy-plan.js";

export const RESULT_FILE = "result.json";

export interface RunOptions {
  workspacePath: string;
  /** Data folder; defaults to resolveHome(). */
  home?: string;
  version: string;
  adapter: string;
  /** Options of this run, recorded in selection.options. */
  options: Record<string, string | number | boolean>;
  /** Extra selection fields (the plan this run executes). */
  selection?: Partial<RunResult["selection"]>;
  /** Files written in the run folder before the adapter starts (for example plan.json); name -> JSON text. */
  runFiles?: Record<string, string>;
  /**
   * The plan this run executes: its hashes enter the identity of the analysis, its declared workspace writes are
   * outputs (never inputs), and a plan with scope.head analyzes that commit in a snapshot of the data folder.
   */
  plan?: Plan;
  /** One adapter that produces every stage (one step named after the adapter). */
  execute?: (context: AdapterContext) => Promise<AdapterOutput>;
  /** The steps of the run (one per invocation of a plan); takes the place of `execute`. */
  steps?: (context: AdapterContext) => RunStep[];
  /** Disabled entries known before anything runs (items the plan left off). */
  disabled?: ResultDisabled[];
  /** Human summary of the result (the caller owns the wording). */
  summarize?: (result: RunResult) => string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Cancels the run: the running process tree is stopped, the rest is recorded as cancelled, exit 130. */
  signal?: AbortSignal;
  /** Stop at the first failure; the rest is recorded as not run because of it. */
  failFast?: boolean;
  /** Another file that receives a copy of the event stream (--events-jsonl). */
  eventsFile?: string;
  /** Called with every event, after it is on disk. */
  onEvent?: (event: RunEvent) => void;
  /** On cancel, also stop every descendant of this process (the CLI process owns all of them). */
  ownsProcess?: boolean;
  /** false: no step is served from or stored in the cache of results (JGATES_NO_CACHE=1 does the same). */
  cache?: boolean;
  /** Waivers of this run; when absent the file .jgates/waivers.json of the workspace is read. */
  waivers?: Waiver[];
  /** Extra metrics (unit, numerator, denominator, component, scope, origin). */
  metrics?: RunResult["metrics"];
  /** The optional semantic review: only present when the run asked for it; runs after the decision. */
  semantic?: SemanticHook;
  /** Governed runs: the CI policy, recorded in every copy of result.json. */
  policy?: ResultPolicy;
  /** Governed runs: a reduced run never passes (it ends incomplete, exit 2). */
  neverPassReduced?: boolean;
  /** Governed runs: false when a self-reported stage may not satisfy its requirement (the CI policy's choice). */
  selfReportedSatisfies?: boolean;
}

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function writePrivateFile(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o600 });
}

/** Writes through a temporary file and a rename, so a reader never sees half a document. */
export function writePrivateFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const positiveInt = (value: string | undefined): number | undefined => {
  const n = Number(value);
  return value !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
};

export async function executeRun(opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const startedAt = now();
  const home = opts.home ?? resolveHome({ env });
  const workspace = touchWorkspace(opts.workspacePath, { home, now: startedAt });
  const runId = newRunId(startedAt);
  const runDir = createRunDir(home, workspace.id, runId);
  let prep: PreparedAnalysis;
  try {
    prep = prepareAnalysis({
      workspacePath: workspace.path,
      home,
      workspaceId: workspace.id,
      runId,
      env,
      head: opts.plan?.scope.head ?? null,
      base: opts.plan?.scope.base ?? null,
      outputs: planOutputs(opts.plan),
    });
  } catch (error) {
    // The commit could not be written as a snapshot: nothing ran, no run is left behind.
    fs.rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
  const logsDir = path.join(runDir, "logs");
  const outputsDir = path.join(runDir, "outputs");
  mkdirPrivate(logsDir);
  mkdirPrivate(outputsDir);

  const artifactFiles: Record<string, string> = {};
  for (const [name, content] of Object.entries(opts.runFiles ?? {})) {
    writePrivateFile(path.join(runDir, name), content);
    if (name === "plan.json") artifactFiles.plan = name;
  }

  const events = new EventLog({
    runId,
    files: [path.join(runDir, EVENTS_FILE), ...(opts.eventsFile ? [opts.eventsFile] : [])],
    now,
    ...(opts.onEvent ? { listener: opts.onEvent } : {}),
  });
  const signal = opts.signal;
  const onAbort = (): void => {
    const reason = signal?.reason;
    events.emit("cancel-requested", { reason: typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "cancel" });
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  const selection: RunResult["selection"] = { ...(opts.selection ?? {}), adapter: opts.adapter, options: opts.options, overrides: [] };
  events.emit("run-started", {
    workspace: { id: workspace.id, path: workspace.path },
    runDir,
    adapter: opts.adapter,
    ...(selection.planHash ? { planHash: selection.planHash } : {}),
    failFast: opts.failFast === true,
  });

  // The steps read the analyzed folder: the workspace itself, or the snapshot of the commit.
  const context: AdapterContext = { workspacePath: prep.path, runDir, logsDir, outputsDir, env, ...(signal ? { signal } : {}) };
  const before = takeManifest(workspace.path);
  const gitBefore = takeGitStatus(workspace.path, env);
  const attribution = new ChangeAttribution(before, workspace.path);

  const waivers = opts.waivers ?? loadWaiverFile(path.join(workspace.path, WAIVERS_FILE)).waivers;
  const metricsOf = (findings: RunResult["findings"], adapterMetrics: RunResult["metrics"] = []) => [...findingMetrics(findings, selection.scope ?? "workspace"), ...adapterMetrics, ...(opts.metrics ?? [])];
  // The run marked as baseline (never this one), when it finished.
  const loadBaseline = (): RunResult | null => {
    const marked = listRuns(home, workspace.id).find((r) => r.marks.baseline && r.runId !== runId);
    if (!marked) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(marked.dir, RESULT_FILE), "utf8")) as RunResult;
    } catch {
      return null;
    }
  };

  // The document as it stands; `partial` copies never claim passed (the rest of the run is still missing).
  const assemble = (
    output: AdapterOutput,
    partial: boolean,
    stopped: RunResult["stopped"] | null,
    cancelled: boolean,
    changes: RunResult["workspaceChanges"],
    verified: ReturnType<typeof verifyInputs> | null = null,
    gitState: RunResult["workspaceGit"] | null = null,
  ): RunResult => {
    // Fingerprints and waivers first: a waiver lowers the blocking count of a completed stage and nothing else.
    const finalized = finalizeFindings(output, waivers, now());
    let findings = finalized.findings;
    const base = partial ? null : loadBaseline();
    if (base) findings = markBaselineState(findings, base);
    const outcome = computeDecision({
      resolved: true,
      cancelled,
      requirements: output.requirements.map(({ id, required }) => ({ id, required })),
      stages: finalized.stages,
      disabled: output.disabled.map(({ id, origin }) => ({ id, origin })),
      ...(opts.selfReportedSatisfies === false ? { selfReportedSatisfies: false } : {}),
    });
    let { decision, complete, exitCode } = outcome;
    if (partial && decision === "passed") {
      decision = "incomplete";
      exitCode = 2;
    }
    if (partial) complete = false;
    // A governed run whose selection was reduced proves less than its policy asks for: it never passes.
    if (opts.neverPassReduced && outcome.reduced && decision === "passed") {
      decision = "incomplete";
      exitCode = 2;
      complete = false;
    }
    // An analyzed file changed during the run: what was checked is no longer what is there, so nothing passes.
    if (verified?.changes.changed && decision === "passed") {
      decision = "incomplete";
      exitCode = 2;
      complete = false;
    }
    const { analyzed, provenance } = describeAnalysis(prep, {
      verified,
      decision,
      ...(opts.plan ? { plan: opts.plan } : {}),
      ...(opts.selection?.planSource ? { planSource: opts.selection.planSource } : {}),
      version: opts.version,
      // generatedAt of the provenance: when this copy of the result was written.
      now: now(),
    });
    const result: RunResult = {
      schemaVersion: 1,
      runId,
      tool: "jgates",
      version: opts.version,
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      workspace: { id: workspace.id, path: workspace.path, name: workspace.name },
      runDir,
      selection: { ...selection, overrides: output.disabled.filter((d) => d.origin === "run").map((d) => ({ id: d.id, reason: d.reason ?? "" })) },
      decision,
      complete,
      reduced: outcome.reduced,
      exitCode,
      requirements: output.requirements,
      stages: finalized.stages,
      findings,
      ...(metricsOf(findings, output.metrics).length > 0 ? { metrics: metricsOf(findings, output.metrics) } : {}),
      ...(output.architecture?.length ? { architecture: output.architecture } : {}),
      unsatisfied: outcome.unsatisfied,
      warnings: outcome.warnings,
      blockingViolations: outcome.blockingViolations,
      disabled: output.disabled,
      workspaceChanges: changes,
      ...(gitState ? { workspaceGit: gitState } : {}),
      artifacts: { result: RESULT_FILE, logs: output.logs, outputs: output.outputs, events: EVENTS_FILE, ...artifactFiles },
      ...(partial ? { partial: true } : {}),
      ...(stopped ? { stopped } : {}),
      analyzed,
      provenance,
      ...(opts.policy ? { policy: opts.policy } : {}),
    };
    if (base) result.baseline = compareWithBaseline(base, result);
    if (opts.summarize) result.summary = opts.summarize(result);
    return result;
  };
  const pending: RunResult["workspaceChanges"] = { checked: false, added: [], modified: [], removed: [] };
  const extraDisabled = opts.disabled ?? [];
  const checkpoint = (outputs: AdapterOutput[]): void => {
    const merged = mergeOutputs(outputs);
    merged.disabled.push(...extraDisabled);
    writePrivateFileAtomic(path.join(runDir, RESULT_FILE), JSON.stringify(assemble(merged, true, null, false, pending), null, 2) + "\n");
  };
  checkpoint([]);

  const cache = new RunCache({
    home,
    workspaceId: workspace.id,
    runId,
    runDir,
    root: prep.path,
    inputsHash: prep.before.hash,
    inputsTraceable: !prep.before.truncated,
    version: opts.version,
    now,
    enabled: opts.cache !== false && env.JGATES_NO_CACHE !== "1",
  });
  const rawSteps: RunStep[] = opts.steps
    ? opts.steps(context)
    : [
        {
          id: opts.adapter,
          skeleton: () => ({ stages: [{ id: opts.adapter, state: "pending" }], requirements: [{ id: opts.adapter, required: true }], disabled: [], findings: [], logs: [], outputs: [] }),
          run: () => (opts.execute ? opts.execute(context) : Promise.reject(new Error("the run has no steps"))),
        },
      ];
  // A step that says what its result depends on goes through the cache of results (src/core/cache).
  const steps: RunStep[] = rawSteps.map((step) => {
    const subject = (step as CacheableStep).cacheSubject;
    return subject ? { ...step, run: () => cache.wrap(step.id, subject, step.run) } : step;
  });
  const done: AdapterOutput[] = [];
  const maxLogBytes = positiveInt(env.JGATES_MAX_LOG_BYTES);
  const killGraceMs = positiveInt(env.JGATES_KILL_GRACE_MS);
  let executed;
  let verified: ReturnType<typeof verifyInputs> | null = null;
  try {
    executed = await executeSteps(steps, {
      ...(signal ? { signal } : {}),
      failFast: opts.failFast === true,
      ...(maxLogBytes !== undefined ? { maxLogBytes } : {}),
      ...(killGraceMs !== undefined ? { killGraceMs } : {}),
      sweepDescendants: opts.ownsProcess === true,
      emit: (type, data) => void events.emit(type, data),
      onStep: (report) => {
        done.push(report.output);
        if (report.status !== "not-run") attribution.afterStep(report.step.id);
        checkpoint(done);
      },
    });
    verified = verifyInputs(prep);
    // Results enter the cache only when what was analyzed did not change while the steps ran.
    if (executed.cancelled || signal?.aborted || verified.changes.changed) cache.discard();
    else cache.commit();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // A snapshot never outlives its run, even when a step threw (JGATES_KEEP_SNAPSHOTS=1 keeps it for diagnosis).
    if (!verified && prep.snapshot && env.JGATES_KEEP_SNAPSHOTS !== "1") fs.rmSync(prep.snapshot.path, { recursive: true, force: true });
  }

  const output = mergeOutputs(executed.reports.map((r) => r.output));
  output.disabled.push(...extraDisabled);
  const after = takeManifest(workspace.path);
  let stopped: RunResult["stopped"] | null = null;
  if (executed.cancelled) {
    const at = executed.reports.find((r) => r.cause === "cancelled");
    stopped = { cause: "cancelled", ...(at ? { stepId: at.step.id } : {}), detail: "cancelled" };
  } else if (executed.failFast) {
    stopped = { cause: "fail-fast", stepId: executed.failFast.stepId, detail: executed.failFast.detail };
  }
  const finalChanges = diffManifests(before, after);
  // `entries` only appears when something was left behind, so a clean run keeps the three plain lists.
  const entries = finalChanges.truncated ? [] : attribution.entries(finalChanges);
  if (entries.length > 0) finalChanges.entries = entries;
  const gitState = compareGitStatus(gitBefore, takeGitStatus(workspace.path, env));
  const result = assemble(output, false, stopped, executed.cancelled, finalChanges, verified, gitState);
  // The semantic review comes after the decision and cannot change it: whatever it does is only recorded.
  if (opts.semantic && !executed.cancelled) {
    try {
      result.semantic = await opts.semantic({ workspacePath: prep.path, runDir, env, ...(signal ? { signal } : {}) });
      // The provenance says with which prompts the semantic review was made (never part of the identity).
      if (result.semantic.prompts && result.provenance) result.provenance.semanticPrompts = result.semantic.prompts;
    } catch (error) {
      result.semantic = {
        requested: true,
        state: "unavailable",
        separateFromDecision: true,
        provider: null,
        model: null,
        scope: null,
        limits: null,
        cost: { reported: false, perCall: null, total: null },
        calls: 0,
        reason: error instanceof Error ? error.message.slice(0, 300) : "the semantic review failed",
      };
    }
  }
  writePrivateFileAtomic(path.join(runDir, RESULT_FILE), JSON.stringify(result, null, 2) + "\n");
  events.emit("run-finished", { decision: result.decision, exitCode: result.exitCode, complete: result.complete, reduced: result.reduced, ...(stopped ? { stopped } : {}) });
  events.close();
  return result;
}
