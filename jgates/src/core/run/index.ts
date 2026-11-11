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
import { engineRuntime, type EngineMount } from "../engine/index.js";
import { cancelRunInEngine, createStepLauncher, executeSteps, mergeOutputs, type EngineCancelResult, type RunPhase, type RunStep } from "../runner/index.js";
import { toolsImageGateEnabled } from "../tools-image/index.js";
import { createSyncPhase } from "../sync/phase.js";
import { createDepsRun, type DepsRun } from "../deps/run.js";
import { createDataRun, dataMaxAgeDaysOf, type DataRun } from "../data/index.js";
import { createCodeqlRun, type CodeqlRun } from "../codeql-prepare/index.js";
import { createServicesRun, type ServicesRun } from "../services/run.js";
import type { Plan } from "../plan/types.js";
import { describeAnalysis, planOutputs, prepareAnalysis, verifyInputs, type PreparedAnalysis } from "./analysis.js";
import type { AdapterContext, AdapterOutput, CacheableStep, ResultDisabled, ResultPolicy, RunResult, SemanticHook } from "./types.js";
import { ChangeAttribution, compareGitStatus, diffManifests, takeGitStatus, takeManifest } from "./workspace-state.js";
import { startHeartbeat } from "./heartbeat.js";
import { readResultAsGateRun, writeGateRecord } from "../gates/read.js";
import { sourceIdentityOf } from "../gates/source.js";
import type { SourceIdentity } from "../gates/types.js";
import { renameWithRetry } from "../fs-retry/index.js";

export * from "./types.js";
export { compareGitStatus, diffManifests, takeGitStatus, takeManifest } from "./workspace-state.js";
export * from "./analysis.js";
export * from "./heartbeat.js";
export { isLegacyPlan, legacyPlan, legacySteps, legacySelection, validateLegacyPlan } from "./legacy-plan.js";

export const RESULT_FILE = "result.json";
/**
 * The run identity of a Quality run (schemas/gates/run-identity), next to result.json: gate, run ID, configuration,
 * the source identity of the analyzed state, plan, stages and outcome. A combined sequence and an attached Quality report
 * read it to tell whether the run judged the current source.
 */
export const RUN_IDENTITY_FILE = "run.json";

/** Writes run.json from the result and the source identity taken before the steps; a failure leaves the result alone. */
function writeRunIdentity(runDir: string, result: RunResult, source: SourceIdentity | null): void {
  if (!source) return;
  try {
    const { migratedFrom: _migrated, ...identity } = readResultAsGateRun(result, { source });
    writeGateRecord("run-identity", path.join(runDir, RUN_IDENTITY_FILE), identity);
  } catch {
    // Without its identity the run reads as legacy evidence (unknown freshness); its result is unaffected.
  }
}

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
  /** Phases that run before the steps; by default a plan run synchronizes the project when container-first checks are on. */
  phases?: (context: AdapterContext) => RunPhase[];
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
  renameWithRetry(tmp, file);
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
  // The source this run judges (repository, commit, dirty contents), from the same analysis; kept in run.json.
  let source: SourceIdentity | null = null;
  try {
    source = sourceIdentityOf(prep);
  } catch {
    source = null;
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
    const partialResult = assemble(merged, true, null, false, pending);
    writePrivateFileAtomic(path.join(runDir, RESULT_FILE), JSON.stringify(partialResult, null, 2) + "\n");
    writeRunIdentity(runDir, partialResult, source);
  };
  checkpoint([]);
  // While the steps run, heartbeat.json tells a working run from one whose process died (both are `partial`).
  // Real time on purpose: a test clock (opts.now) would make a live run look stale.
  const heartbeat = startHeartbeat(runDir);

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
  const cachedSteps: RunStep[] = rawSteps.map((step) => {
    const subject = (step as CacheableStep).cacheSubject;
    return subject ? { ...step, run: () => cache.wrap(step.id, subject, step.run) } : step;
  });
  const done: AdapterOutput[] = [];
  const maxLogBytes = positiveInt(env.JGATES_MAX_LOG_BYTES);
  const killGraceMs = positiveInt(env.JGATES_KILL_GRACE_MS);
  let executed;
  let verified: ReturnType<typeof verifyInputs> | null = null;
  // Container-first (same gate as the sync phase): every process of every step is launched in a step container, with
  // the dependency volumes the deps phase prepared for the checks that need them.
  let deps: DepsRun | null = null;
  let data: DataRun | null = null;
  let codeql: CodeqlRun | null = null;
  // What a step container gets besides the source volume and the run folder: its dependency volumes, the advisory data
  // (read-only) for the scanners that read a database, and the prepared CodeQL (read-only) for the CodeQL check.
  let services: ServicesRun | null = null;
  // A step that uses the run's compose services joins their network (in place of its own).
  const stepEnvironment = (stepId: string): { mounts: EngineMount[]; env: Record<string, string>; network?: string } | null => {
    const parts = [deps?.stepEnvironment(stepId) ?? null, data?.stepEnvironment(stepId) ?? null, codeql?.stepEnvironment(stepId) ?? null].filter((p): p is { mounts: EngineMount[]; env: Record<string, string> } => p !== null);
    const network = services?.stepEnvironment(stepId)?.network;
    // The dependency environment wins over the data and CodeQL ones, as before.
    const merged = parts.length <= 1 ? (parts[0] ?? null) : { mounts: parts.flatMap((p) => p.mounts), env: Object.assign({}, ...[...parts].reverse().map((p) => p.env)) };
    if (!network) return merged;
    return { mounts: merged?.mounts ?? [], env: merged?.env ?? {}, network };
  };
  const launcher =
    opts.plan && toolsImageGateEnabled(env)
      ? createStepLauncher({ env, workspaceId: workspace.id, runId, runDir, projectDir: prep.path, version: opts.version, stepEnvironment })
      : null;
  data = opts.plan && launcher ? createDataRun({ plan: opts.plan, env, runDir, maxAgeDays: dataMaxAgeDaysOf(opts.policy?.source.dir ?? prep.path), version: opts.version }) : null;
  codeql = opts.plan && launcher ? createCodeqlRun({ plan: opts.plan, env, runDir, version: opts.version }) : null;
  // The project's dependencies (after the sync): only when a planned check needs them and the steps run in containers.
  deps =
    !opts.phases && opts.plan && launcher
      ? createDepsRun({
          plan: opts.plan,
          projectDir: prep.path,
          configDir: opts.policy?.source.dir ?? prep.path,
          workspace: workspace.id,
          runId,
          runDir,
          version: opts.version,
          home,
          env,
          governed: opts.policy !== undefined,
          ...(signal ? { signal } : {}),
        })
      : null;
  // The project's compose services (after the dependencies): only when a planned check uses them, in containers.
  services =
    !opts.phases && opts.plan && launcher
      ? createServicesRun({
          plan: opts.plan,
          projectDir: prep.path,
          configDir: opts.policy?.source.dir ?? prep.path,
          workspace: workspace.id,
          runId,
          runDir,
          version: opts.version,
          env,
          governed: opts.policy !== undefined,
          ...(signal ? { signal } : {}),
        })
      : null;
  const phases = opts.phases
    ? opts.phases(context)
    : opts.plan && toolsImageGateEnabled(env)
      ? [createSyncPhase({ projectDir: prep.path, workspace: workspace.id, runId, runDir, version: opts.version, home, env }), ...(deps ? [deps.phase] : []), ...(services ? [services.phase] : [])]
      : [];
  // A cancellation also reaches the engine: the containers carrying this run's label are killed and the run's services
  // taken down (nothing else is touched). Whatever the steps finished before stays in the partial result.
  const engineContext = { runtime: engineRuntime(env), runnerOptions: { parentEnv: env } };
  let engineCancel: Promise<EngineCancelResult> | null = null;
  const cancelInEngine = (): Promise<EngineCancelResult> | null => {
    if (!launcher) return null;
    events.emit("phase-started", { phase: "cancel" });
    const started = Date.now();
    const pending = cancelRunInEngine({ runId, context: engineContext }).then((outcome) => {
      events.emit("phase-finished", {
        phase: "cancel",
        status: outcome.errors.length === 0 ? "succeeded" : "failed",
        durationMs: Date.now() - started,
        details: { killed: outcome.killed.map((c) => c.name), servicesDown: outcome.servicesDown, errors: outcome.errors },
      });
      return outcome;
    });
    return pending;
  };
  const onEngineAbort = (): void => {
    engineCancel ??= cancelInEngine();
  };
  if (launcher) {
    if (signal?.aborted) onEngineAbort();
    else signal?.addEventListener("abort", onEngineAbort, { once: true });
  }
  try {
    // A check that needs dependencies does not start without them (DEPENDENCIES_FAILED / DEPENDENCIES_NOT_READY).
    const depsGated = deps ? deps.gate(cachedSteps) : cachedSteps;
    const dataGated = data ? data.gate(depsGated) : depsGated;
    const codeqlGated = codeql ? codeql.gate(dataGated) : dataGated;
    // A check that uses the services does not start without them (SERVICES_NOT_READY / SERVICES_REQUIRED).
    const steps = services ? services.gate(codeqlGated) : codeqlGated;
    executed = await executeSteps(steps, {
      phases,
      ...(launcher ? { launcher } : {}),
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
    if (signal?.aborted) {
      onEngineAbort();
      await engineCancel;
      // A container started in the instant of the cancellation is caught by a last sweep (it finds nothing otherwise).
      await cancelRunInEngine({ runId, context: engineContext }).catch(() => undefined);
    }
    verified = verifyInputs(prep);
    // Results enter the cache only when what was analyzed did not change while the steps ran.
    if (executed.cancelled || signal?.aborted || verified.changes.changed) cache.discard();
    else cache.commit();
  } finally {
    // The run's compose project is always taken down when the steps end (also after a failure, a cancellation or a
    // step that threw); `down` touches only this run's project.
    if (services) {
      const started = Date.now();
      await services.teardown().catch(() => undefined);
      events.emit("phase-finished", { phase: "services-down", status: "succeeded", durationMs: Date.now() - started, details: { project: services.project, status: services.status() } });
    }
    signal?.removeEventListener("abort", onAbort);
    signal?.removeEventListener("abort", onEngineAbort);
    // A step threw: the run stops here, and it must not look alive.
    if (!executed) heartbeat.stop();
    // A snapshot never outlives its run, even when a step threw (JGATES_KEEP_SNAPSHOTS=1 keeps it for diagnosis).
    if (!verified && prep.snapshot && env.JGATES_KEEP_SNAPSHOTS !== "1") fs.rmSync(prep.snapshot.path, { recursive: true, force: true });
  }

  const output = mergeOutputs(executed.reports.map((r) => r.output));
  output.disabled.push(...extraDisabled);
  // The log blocks of the phases (the sync) come before those of the steps.
  output.logs.unshift(...executed.phases.flatMap((p) => p.outcome.logs ?? []));
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
  writeRunIdentity(runDir, result, source);
  heartbeat.stop();
  events.emit("run-finished", { decision: result.decision, exitCode: result.exitCode, complete: result.complete, reduced: result.reduced, ...(stopped ? { stopped } : {}) });
  events.close();
  return result;
}
