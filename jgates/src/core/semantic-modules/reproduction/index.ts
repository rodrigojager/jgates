// Confirm by reproduction (method `confirm-by-reproduction`), an original JGates method. It takes the needs-validation
// findings of an earlier Semantic run and, for each one, has the model write one test that fails while the defect is
// real; the host executes it in a container, and an independent context judges whether the failure is the defect. Only
// an executed, failing, attributed reproducer counts as reproduced. It runs only when asked for: no purpose, profile,
// template or default selects it, and `jgates ci` never runs a Semantic method.
//
//   inputs        the needs-validation findings of one earlier Semantic run of the workspace (named by the caller, or the
//                 newest run that has any) of a method that reads source code, with their records (claimed root cause,
//                 blockers, the validation plan of security-audit records); a container engine with the tools image (or
//                 JGates running inside the image); the prepared dependencies of each finding's component
//   hypothesis    the defect each finding describes is real and a test can show it on the current code
//   method        reproducer (explore, one context per finding): from the finding, its evidence and its validation plan,
//                              one test in the project's test framework (pytest or node:test) that fails if the defect is
//                              real. Its artifact check refuses a file that is not a test of that runner, that lives outside
//                              the reserved regressions folder, or that imports anything outside the readable project
//                              files. Once valid (its settle step), host code executes it (execute.ts); a run that passed,
//                              did not load or did not run decides the finding there (reproduction attempted)
//                 assessment (validate, a fresh context per failing reproducer, with the execution record): is the
//                              failure the defect the finding describes, a defect of the reproducer, or the environment
//   output        evidence/confirm-by-reproduction/execution.json (every execution: the facts of its container and the
//                 masked output) and evidence/confirm-by-reproduction/reproduction.json (per finding: reproduced, with the
//                 evidence basis "execution", or reproduction attempted with the reason); a reproducer (node:test or
//                 pytest) that reproduced becomes a regression proposal (evidence/regressions/proposals.json). The earlier run is never
//                 rewritten
//   claims        reproduced only when the reproducer executed, failed and the assessment attributes the failure to the
//                 defect. Anything else leaves the finding needs-validation with "reproduction attempted" and why: a
//                 failed reproduction never rejects a finding and never lowers its severity. A run that executed nothing
//                 ends unavailable: no claim without execution
//   applicability not applicable, with no model call: no earlier needs-validation finding (REPRODUCTION_NO_NEEDS_VALIDATION,
//                 REPRODUCTION_SEED_RUN_NOT_FOUND); no supported runner for the findings' files (TEST_RUNNER_NOT_SUPPORTED);
//                 asked by the run only: no container engine or tools image (the engine's own code) and no prepared
//                 dependencies for the findings' components (DEPENDENCIES_NOT_PREPARED)
//   overlap       post-patch validation asks whether a patch fixes the defect its reproducer shows (before and after); this
//                 method has no patch and asks whether the defect of an earlier finding shows at all on the current code.
//                 The security audit argues from source only; this module adds the observed behavior.
import path from "node:path";
import { translator } from "../../../i18n/index.js";
import { proposalRunnerOf, proposalsFile } from "../../regressions/proposals.js";
import { DEPENDENCIES_NOT_PREPARED, testRuntime } from "../../regressions/runner.js";
import { resolveHome } from "../../home/index.js";
import { workspaceId } from "../../ids/index.js";
import type { ArtifactCandidate, ArtifactCheck, ArtifactCheckContext, ArtifactVerdict, Candidate, InvestigationModule, ModuleApplicability, ModuleBriefInput, ModuleFinalizeInput, ModuleFinalizeOutput, ModulePrerequisites } from "../../semantic-executor/index.js";
import { briefJson, checkVerdict, str } from "../complementary/shared.js";
import { EXECUTION_FILE, executeReproducer, executionFor, executionsOf, forgetRun, type ExecutionInputs, type ReproductionExecution } from "./execute.js";
import { checkReproducerTest, type CheckedReproducer } from "./reproducer.js";
import { collectSeeds, seedsWithDependencies, type ReproductionSeed, type SeedSelection, type SkippedFinding } from "./seeds.js";

export { EXECUTION_FILE, executionFor, executionsOf, type ReproductionExecution } from "./execute.js";
export { checkReproducerTest, importProblems, jsImports, pythonImports, PYTEST_FILE_PATTERN, MAX_REPRODUCER, type CheckedReproducer, type ProjectFiles } from "./reproducer.js";
export { collectSeeds, runnerForSource, seedRunFor, seedsWithDependencies, INELIGIBLE_SEED_METHODS, MAX_FINDINGS, type ReproductionSeed, type SeedSelection, type SkippedFinding } from "./seeds.js";

export const REPRODUCTION_METHOD = "confirm-by-reproduction";
export const REPRODUCTION_MODULE_ID = "confirm-by-reproduction";
export const REPRODUCTION_FILE = "evidence/confirm-by-reproduction/reproduction.json";
export const STAGES = { reproducer: "reproducer", assessment: "assessment" } as const;
/** What the assessment may attribute a failure to. */
export const CAUSES = ["defect", "reproducer", "environment", "unknown"] as const;

/**
 * Why a finding stays needs-validation after an attempt (reproduced: none). Never a rejection: every one of them leaves
 * the finding and its severity as the earlier run decided.
 */
export const ATTEMPT_REASONS = [
  "REPRODUCER_PASSED",
  "REPRODUCER_DID_NOT_LOAD",
  "DEPENDENCIES_NOT_PREPARED",
  "NOT_EXECUTED",
  "ATTRIBUTED_TO_REPRODUCER",
  "ATTRIBUTED_TO_ENVIRONMENT",
  "ATTRIBUTION_UNDECIDED",
  "BUDGET",
  "REPRODUCER_INVALID",
  "NOT_RUN",
] as const;
export type AttemptReason = (typeof ATTEMPT_REASONS)[number];

/** Which earlier run and which of its findings (the CLI and the screens name them; absent: the newest run, every finding). */
export type ReproductionOptions = SeedSelection;

interface ReproductionInputs extends ExecutionInputs {
  seeds: ReproductionSeed[];
  skipped: SkippedFinding[];
}

const inputsOf = (inputs: Readonly<Record<string, unknown>> | undefined): ReproductionInputs | null => (Array.isArray(inputs?.seeds) ? (inputs as unknown as ReproductionInputs) : null);
const seedOf = (inputs: ReproductionInputs | null, candidate: Candidate | null): ReproductionSeed | null => {
  const id = (candidate?.details as { seed?: { id?: string } } | undefined)?.seed?.id;
  return inputs?.seeds.find((s) => s.id === id) ?? null;
};

/** The record a seed candidate carries (shown to every context that examines it). */
function seedDetails(seed: ReproductionSeed): Record<string, unknown> {
  return {
    seed: { id: seed.id, runId: seed.source.runId, candidateId: seed.source.candidateId, method: seed.source.method, fingerprint: seed.fingerprint },
    runner: seed.runner,
    claimed_root_cause: seed.claimedRootCause,
    impact: seed.impact,
    blockers: seed.blockers,
    validation_plan: seed.validationPlan,
    earlier_verdict: seed.validation,
  };
}

// ---- the stages ------------------------------------------------------------------------------------------------------

const REPRO_SHAPE = `{"summary": "...", "defect": "the wrong behavior the test shows", "test": {"name": "pytest: test_<name>.py | node:test: <name>.test.mjs", "content": "the whole test file; it lives at .jgates/regressions/<name>"}}`;
const ASSESS_SHAPE = `{"candidateId": "C1", "cause": "${CAUSES.join("|")}", "reason": "...", "evidence": [{"path": "...", "line": 12, "note": "..."}]}`;

function checkReproducer(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const inputs = inputsOf(ctx.run?.inputs);
  const seed = seedOf(inputs, ctx.candidate);
  if (!inputs || !ctx.run || !seed) return { ok: false, problems: ["the reproducer stage needs the finding of the earlier run"] };
  const summary = str(value.summary, 1500);
  const defect = str(value.defect, 800);
  if (summary === "" || defect === "") return { ok: false, problems: ["summary and defect are required"] };
  const files = ctx.run.scope.guard.readable();
  const test = checkReproducerTest(value.test, seed.runner, { readable: (p) => ctx.readable(p), files });
  if (!test.ok) return { ok: false, problems: test.problems };
  return { ok: true, problems: test.problems, value: { summary, defect, test: { path: test.reproducer.path, runner: test.reproducer.runner, sha256: test.reproducer.sha256, content: test.reproducer.content } }, examined: ctx.seen.has(seed.path) ? [seed.path] : [], gaps: [] };
}

/** What an execution means for the finding: null when the reproducer failed (the assessment judges it), else the attempt. */
function attemptOf(ex: ReproductionExecution): { reason: AttemptReason; detail: string } | null {
  const r = ex.run;
  if (!r.executed) return { reason: "NOT_EXECUTED", detail: `the reproducer was not executed: ${r.reason ?? "-"}` };
  if (r.outcome === "failed") return null;
  if (r.outcome === "passed") return { reason: "REPRODUCER_PASSED", detail: `the reproducer passed${r.tests ? ` (${r.tests.pass}/${r.tests.total})` : ""}: the defect was not shown` };
  if (r.dependenciesMissing) return { reason: "DEPENDENCIES_NOT_PREPARED", detail: r.reason ?? `${DEPENDENCIES_NOT_PREPARED}: a package the reproducer needs is not prepared` };
  return { reason: "REPRODUCER_DID_NOT_LOAD", detail: `the reproducer did not run to a verdict: ${r.reason ?? "it did not load"}` };
}

const runView = (r: ReproductionExecution["run"]) => ({ executed: r.executed, outcome: r.outcome, code: r.code, tests: r.tests, exitCode: r.exitCode, timedOut: r.timedOut, reason: r.reason, output: r.output });

/** After a valid reproducer: executes it; a run that did not fail decides the finding here, a failing one waits for the assessment. */
async function settleReproducer(check: ArtifactCheck, ctx: ArtifactCheckContext, signal: AbortSignal): Promise<ArtifactCheck> {
  const inputs = inputsOf(ctx.run?.inputs);
  const seed = seedOf(inputs, ctx.candidate);
  const test = (check.value as { test?: CheckedReproducer } | undefined)?.test;
  if (!inputs || !ctx.run || !seed || !ctx.candidate || !test) return { ok: false, problems: [...check.problems, "the reproducer stage needs the finding of the earlier run"] };
  const execution = await executeReproducer(ctx, inputs, seed, ctx.candidate.id, test, signal);
  const attempt = attemptOf(execution);
  const value = { ...check.value, execution: { tree: execution.tree, workspaceCopy: execution.workspaceCopy, executedAt: execution.executedAt, run: runView(execution.run), container: execution.run.container } };
  if (!attempt) return { ...check, value };
  // Decided by the host from the execution: the finding stays needs-validation, never rejected, its severity unchanged.
  const verdict: ArtifactVerdict = {
    confirmation: "needs-validation",
    reason: `Reproduction attempted (${attempt.reason}): ${attempt.detail}`,
    evidence: [],
    details: { ...(ctx.candidate.details ?? {}), reproduction: { state: "attempted", reason: attempt.reason, detail: attempt.detail, executed: execution.executed, outcome: execution.run.outcome } },
  };
  return { ...check, value, verdict, gaps: [{ path: seed.path, reason: `${seed.id} reproduction attempted (${attempt.reason}): ${attempt.detail}` }] };
}

function checkAssessment(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const candidate = ctx.candidate;
  if (!candidate || !ctx.run) return { ok: false, problems: ["the assessment needs a finding and its execution record"] };
  const ex = executionFor(ctx.run.runDir, candidate.id);
  const failed = !!ex && ex.run.executed && ex.run.outcome === "failed";
  const cause = (CAUSES as readonly string[]).includes(String(value.cause)) ? (String(value.cause) as (typeof CAUSES)[number]) : "unknown";
  // Only an executed failure attributed to the defect confirms; nothing here rejects or changes the severity.
  const confirmation = cause === "defect" && failed ? "confirmed" : "needs-validation";
  const check = checkVerdict({ ...value, confirmation, severity: undefined }, ctx, () => ({ cause, evidence_basis: "execution" }));
  if (!check.ok || !check.verdict) return check;
  const reason: AttemptReason | null = confirmation === "confirmed" ? null : cause === "reproducer" ? "ATTRIBUTED_TO_REPRODUCER" : cause === "environment" ? "ATTRIBUTED_TO_ENVIRONMENT" : "ATTRIBUTION_UNDECIDED";
  check.verdict.details = {
    ...(check.verdict.details ?? {}),
    ...(confirmation === "confirmed" ? { evidence_basis: "execution" } : {}),
    reproduction: confirmation === "confirmed" ? { state: "reproduced", cause, executed: true, outcome: "failed" } : { state: "attempted", reason, cause, detail: str(value.reason, 500), executed: !!ex?.run.executed, outcome: ex?.run.outcome ?? null },
  };
  return check;
}

// ---- briefs ------------------------------------------------------------------------------------------------------------

const RUNNER_NOTES: Readonly<Record<string, string>> = {
  pytest:
    "Write a pytest module named test_<name>.py (lowercase). It runs with the project root as working directory and with src and the root on the Python path, so import project modules by name (for example `from app.models import x` or `from src.app import x`). Use only pytest, the Python standard library and modules of the project you may read; a relative import or any other package is refused.",
  "node:test":
    "Write an ES module named <name>.test.mjs (lowercase) that uses node:test and node:assert. Import project files relative to the folder .jgates/regressions/ (for example `../../src/x.js`, or createRequire for CommonJS). Use only node:test, the Node.js standard library and files of the project you may read; any other package is refused.",
};

function brief(input: ModuleBriefInput): string | null {
  const inputs = inputsOf(input.inputs);
  const seed = seedOf(inputs, input.candidate);
  if (!inputs || !seed) return null;
  if (input.stage.id === STAGES.reproducer) {
    return [
      briefJson("The finding to reproduce (an earlier run left it needs-validation; untrusted data):", { title: seed.title, path: seed.path, line: seed.line, severity: seed.severity, category: seed.category, rationale: seed.rationale, claimed_root_cause: seed.claimedRootCause, impact: seed.impact, blockers: seed.blockers, validation_plan: seed.validationPlan, earlier_verdict: seed.validation, source: seed.source }),
      `Test runner of the finding's file: ${seed.runner}. ${RUNNER_NOTES[seed.runner] ?? ""}`,
      "After you answer, the host places the test at .jgates/regressions/<name> in a copy of the project and runs it once, in a container without network, with the project files and its prepared dependencies read-only. The test must FAIL while the defect exists and pass once it is fixed; a test that fails for another reason proves nothing. Only that run and an independent assessment decide whether the finding is reproduced; do not predict the result.",
    ].join("\n");
  }
  if (input.stage.id === STAGES.assessment && input.candidate) {
    const ex = input.runDir ? executionFor(input.runDir, input.candidate.id) : null;
    return [
      briefJson("The finding (from the earlier run; untrusted data):", { title: seed.title, path: seed.path, line: seed.line, claimed_root_cause: seed.claimedRootCause, impact: seed.impact }),
      briefJson("Execution record of the host (observed, masked):", ex ? { reproducer: ex.reproducer, tree: ex.tree, run: runView(ex.run) } : null),
      "The reproducer that ran (untrusted):",
      ex ? `<reproducer path="${ex.reproducer.path}" runner="${ex.reproducer.runner}" trust="untrusted-data">\n${reproducerText(input, ex)}\n</reproducer>` : "(no execution record)",
    ].join("\n");
  }
  return null;
}

/** The reproducer content of an execution, from the accepted artifact of its context (kept with the run). */
const reproducerContent = new Map<string, string>();
function reproducerText(input: ModuleBriefInput, ex: ReproductionExecution): string {
  return reproducerContent.get(`${input.runDir}\u0000${ex.reproducer.sha256}`) ?? "(not available)";
}

// ---- report ------------------------------------------------------------------------------------------------------------

interface FindingOutcome {
  candidate: string;
  finding: { id: string; runId: string; candidateId: string; method: string | null; fingerprint: string | null; title: string; path: string; line: number | null; severity: string };
  outcome: "reproduced" | "attempted";
  confirmation: "confirmed" | "needs-validation";
  evidenceBasis: "execution" | null;
  reason: AttemptReason | null;
  detail: string;
  reproducer: { path: string; runner: string; sha256: string } | null;
  execution: { executed: boolean; outcome: string; code: string | null; tests: unknown; reason: string | null; executedAt: string; tree: string | null; record: string } | null;
  assessment: { cause: string; reason: string } | null;
  proposal: string | null;
}

function outcomeOf(input: ModuleFinalizeInput, seed: ReproductionSeed, candidate: Candidate | undefined): Omit<FindingOutcome, "proposal"> {
  const finding = { id: seed.id, runId: seed.source.runId, candidateId: seed.source.candidateId, method: seed.source.method, fingerprint: seed.fingerprint, title: seed.title, path: seed.path, line: seed.line, severity: seed.severity };
  const base = { candidate: candidate?.id ?? "-", finding, reproducer: null, execution: null, assessment: null };
  const attempted = (reason: AttemptReason, detail: string, extra: Partial<FindingOutcome> = {}): Omit<FindingOutcome, "proposal"> => ({ ...base, outcome: "attempted", confirmation: "needs-validation", evidenceBasis: null, reason, detail, ...extra });
  if (!candidate) return attempted("NOT_RUN", "the finding could not be examined in this run");
  const stage = (id: string) => input.stages.find((s) => s.id === id);
  const reproCtx = stage(STAGES.reproducer)?.contexts.find((c) => c.candidate === candidate.id);
  const ex = executionFor(input.runDir, candidate.id);
  const reproducer = ex ? ex.reproducer : null;
  const execution = ex ? { executed: ex.executed, outcome: ex.run.outcome, code: ex.code, tests: ex.run.tests, reason: ex.reason, executedAt: ex.executedAt, tree: ex.tree, record: EXECUTION_FILE } : null;
  if (!ex) {
    if (!reproCtx || reproCtx.status === "budget" || reproCtx.status === "not-run") return attempted("BUDGET", "the budget of the run ended before the reproducer was written");
    if (reproCtx.status !== "answered") return attempted("NOT_RUN", `the reproducer context ended ${reproCtx.status}`);
    return attempted("REPRODUCER_INVALID", "the reproducer was refused by the host checks and never executed");
  }
  const attempt = attemptOf(ex);
  if (attempt) return attempted(attempt.reason, attempt.detail, { reproducer, execution });
  const verdict = (candidate.details as { verdict?: { cause?: string } } | undefined)?.verdict;
  const assessment = verdict?.cause ? { cause: verdict.cause, reason: candidate.validation?.reason ?? "" } : null;
  if (candidate.status === "confirmed") return { ...base, outcome: "reproduced", confirmation: "confirmed", evidenceBasis: "execution", reason: null, detail: "the reproducer executed, failed, and the assessment attributes the failure to the defect", reproducer, execution, assessment };
  const assessCtx = stage(STAGES.assessment)?.contexts.find((c) => c.candidate === candidate.id);
  if (!assessment) {
    if (!assessCtx || assessCtx.status === "budget" || assessCtx.status === "not-run") return attempted("BUDGET", "the reproducer failed, and the budget of the run ended before its assessment", { reproducer, execution });
    return attempted(assessCtx.status === "answered" ? "ATTRIBUTION_UNDECIDED" : "NOT_RUN", `the reproducer failed and its assessment gave no valid verdict (${assessCtx.status})`, { reproducer, execution });
  }
  const reason: AttemptReason = assessment.cause === "reproducer" ? "ATTRIBUTED_TO_REPRODUCER" : assessment.cause === "environment" ? "ATTRIBUTED_TO_ENVIRONMENT" : "ATTRIBUTION_UNDECIDED";
  return attempted(reason, `the reproducer failed and the assessment ${reason === "ATTRIBUTION_UNDECIDED" ? "could not attribute the failure to the defect" : `attributes the failure to the ${assessment.cause}`}`, { reproducer, execution, assessment });
}

function finalize(input: ModuleFinalizeInput): ModuleFinalizeOutput {
  const inputs = inputsOf(input.inputs);
  const executions = executionsOf(input.runDir);
  const contents = new Map<string, string>();
  for (const st of input.stages) for (const c of st.contexts) {
    const test = (c.accepted as { test?: { sha256?: string; content?: string } } | undefined)?.test;
    if (test?.sha256 && typeof test.content === "string") contents.set(test.sha256, test.content);
  }
  try {
    // Nothing is claimed without execution: a run whose reproducers never ran ends without an outcome.
    if (!inputs || !executions.some((e) => e.executed)) {
      const why = executions.length === 0 ? "no reproducer was executed" : `no reproducer ran (${executions.map((e) => `${e.candidate}: ${e.reason ?? "-"}`).join("; ").slice(0, 300)})`;
      throw new Error(`confirm-by-reproduction claims nothing without execution: ${why}`);
    }
    const byId = new Map(input.candidates.map((c) => [(c.details as { seed?: { id?: string } } | undefined)?.seed?.id ?? "", c]));
    const outcomes: FindingOutcome[] = inputs.seeds.map((seed) => ({ ...outcomeOf(input, seed, byId.get(seed.id)), proposal: null }));
    // A reproducer that reproduced becomes a regression proposal (the existing flow; never applied by itself): node:test
    // and pytest files alike.
    const proposable = outcomes.filter((o) => o.outcome === "reproduced" && !!o.reproducer && proposalRunnerOf(path.posix.basename(o.reproducer.path)) !== null && contents.has(o.reproducer.sha256));
    const proposals = proposable.length
      ? proposalsFile(
          input.runDir,
          REPRODUCTION_METHOD,
          proposable.map((o) => ({
            file: path.posix.basename(o.reproducer!.path),
            content: contents.get(o.reproducer!.sha256) as string,
            title: `Reproducer: ${o.finding.title.slice(0, 160)}`,
            rationale: `Executed in a container of the tools image on the current code, it failed, and an independent assessment attributed the failure to the defect of ${o.finding.runId}/${o.finding.candidateId}.`,
            origin: { stage: STAGES.reproducer, candidate: o.candidate, candidateStatus: "confirmed", invariant: null },
            execution: { outcome: o.execution?.outcome ?? null, tests: o.execution?.tests ?? null, executedAt: o.execution?.executedAt ?? null, finding: { runId: o.finding.runId, candidateId: o.finding.candidateId } },
          })),
        )
      : null;
    proposable.forEach((o, i) => (o.proposal = proposals?.proposals[i]?.id ?? null));
    const notProposed = outcomes.filter((o) => o.outcome === "reproduced" && !proposable.includes(o));
    const doc = {
      schemaVersion: 1,
      kind: "semantic-reproduction",
      method: REPRODUCTION_METHOD,
      generatedAt: input.now.toISOString(),
      evidenceBasis: "execution",
      seedRun: inputs.seedRun,
      note: "A failed reproduction never rejects a finding and never lowers its severity; the earlier run is never rewritten.",
      findings: outcomes,
      skipped: inputs.skipped,
      counts: { findings: outcomes.length, reproduced: outcomes.filter((o) => o.outcome === "reproduced").length, attempted: outcomes.filter((o) => o.outcome === "attempted").length, skipped: inputs.skipped.length, executed: executions.filter((e) => e.executed).length },
      execution: EXECUTION_FILE,
      proposals: proposals?.proposals.map((p) => p.id) ?? [],
    };
    return {
      files: [{ path: REPRODUCTION_FILE, content: `${JSON.stringify(doc, null, 2)}\n` }, ...(proposals ? [{ path: proposals.path, content: proposals.content }] : [])],
      gaps: [
        ...inputs.skipped.map((s) => ({ code: s.code, path: s.path, reason: `${s.candidateId} not reproduced: ${s.reason}` })),
        ...outcomes.filter((o) => o.outcome === "attempted").map((o) => ({ code: "REPRODUCTION_ATTEMPTED", path: o.finding.path, reason: `${o.finding.candidateId} (${o.reason}): ${o.detail}` })),
        ...notProposed.map((o) => ({ code: "REGRESSION_PROPOSAL_NOT_SUPPORTED", path: o.finding.path, reason: `the reproducer of ${o.finding.candidateId} (${o.reproducer?.path ?? "-"}) could not become a regression proposal: its file name or content is not available as a node:test or pytest proposal` })),
      ],
      report: { seedRun: inputs.seedRun.runId, findings: outcomes.length, reproduced: doc.counts.reproduced, attempted: doc.counts.attempted, skipped: doc.counts.skipped, executed: doc.counts.executed, proposals: doc.proposals.length },
    };
  } finally {
    forgetRun(input.runDir);
    for (const key of [...reproducerContent.keys()]) if (key.startsWith(`${input.runDir}\u0000`)) reproducerContent.delete(key);
  }
}

/** How a finding's outcome reads for a person (reproduced, or reproduction attempted and why), in either language. */
export function reproductionText(outcome: { outcome: "reproduced" | "attempted"; reason: AttemptReason | null }, locale?: string): string {
  const t = translator("semantic", locale);
  if (outcome.outcome === "reproduced") return t("semantic_reproduction_reproduced");
  return t("semantic_reproduction_attempted", { reason: t(`semantic_reproduction_reason_${outcome.reason ?? "NOT_RUN"}`) });
}

const OBJECTIVE =
  "Confirm needs-validation findings of an earlier review by execution: for each finding, write one minimal deterministic test in the project's test framework that fails while the defect the finding describes exists. The host runs it once in a container without network; an independent context judges whether a failure is that defect. A finding is reproduced only when its test executed, failed and the failure is attributed to the defect; nothing else changes the finding.";

export function confirmByReproductionModule(options: ReproductionOptions = {}): InvestigationModule {
  return {
    id: REPRODUCTION_MODULE_ID,
    version: "1",
    title: "Confirm by reproduction",
    objective: OBJECTIVE,
    provenance: { origin: "original JGates method", execution: "core/regressions test-file runner (the reproducer placed in the workspace copy, an ephemeral container of the tools image, no network, read-only copy and dependencies)", runners: ["pytest", "node:test"] },
    minimum: { exploreCalls: 1, reserveCalls: 1 },
    applicability: (input): ModuleApplicability => {
      const found = collectSeeds(input, options);
      if ("code" in found) return { applicable: false, code: found.code, missing: found.missing, reason: found.reason };
      const inputs: ReproductionInputs = { seedRun: found.seedRun, seeds: found.seeds, skipped: found.skipped, workspacePath: input.workspacePath, env: input.env };
      return { applicable: true, inputs: inputs as unknown as Record<string, unknown>, record: { seedRun: found.seedRun, findings: found.seeds.map((s) => ({ id: s.id, runId: s.source.runId, candidateId: s.source.candidateId, path: s.path, line: s.line, runner: s.runner })), skipped: found.skipped } };
    },
    // Asked by the run only (never by a plan preview): the reproducers run in containers of the tools image, with the
    // prepared dependencies of each finding's component.
    prerequisites: async (input): Promise<ModulePrerequisites> => {
      const runtime = await testRuntime(input.env);
      if (!runtime.ok) return { code: runtime.code, missing: "container engine and tools image", reason: `confirm by reproduction runs each reproducer in a container of the tools image: ${runtime.reason}` };
      const inputs = inputsOf(input.inputs);
      if (!inputs || runtime.mode !== "container") return null;
      const { ready, skipped } = seedsWithDependencies({ workspacePath: input.workspacePath, home: resolveHome({ env: input.env }), workspace: workspaceId(input.workspacePath) }, inputs.seeds);
      if (ready.length === 0) return { code: DEPENDENCIES_NOT_PREPARED, missing: "prepared dependencies", reason: skipped.map((s) => `${s.candidateId} ${s.path}: ${s.reason}`).join("; ").slice(0, 900) };
      if (skipped.length === 0) return null;
      const narrowed: ReproductionInputs = { ...inputs, seeds: ready, skipped: [...inputs.skipped, ...skipped] };
      return { inputs: narrowed as unknown as Record<string, unknown>, record: { findings: ready.map((s) => ({ id: s.id, runId: s.source.runId, candidateId: s.source.candidateId, path: s.path, line: s.line, runner: s.runner })), skipped: narrowed.skipped } };
    },
    seedCandidates: ({ inputs: raw }): ArtifactCandidate[] => {
      const inputs = inputsOf(raw);
      return (inputs?.seeds ?? []).map((s) => ({
        title: s.title,
        path: s.path,
        line: s.line,
        severity: (["blocking", "important", "suggestion", "nit"].includes(s.severity) ? s.severity : "important") as ArtifactCandidate["severity"],
        category: s.category,
        rationale: s.rationale || s.title,
        details: seedDetails(s),
      }));
    },
    stages: [
      {
        id: STAGES.reproducer,
        label: "Reproducer",
        role: "explore",
        required: true,
        contexts: "per-candidate",
        decides: false,
        instructions:
          "You write the reproducer of one finding an earlier review could not settle; your brief has the finding, its validation plan and the test runner of its file. Read the code the finding points to and what it needs. Write one minimal, deterministic test that fails while the defect the finding describes exists and passes once it is fixed: exercise the code path of the finding, assert the correct behavior, and avoid anything that fails for another reason (network, clock, randomness, missing services). Do not predict the result: the host executes the test after you answer.",
        artifact: { kind: "custom", shape: REPRO_SHAPE, validate: checkReproducer, settle: rememberingSettle },
      },
      {
        id: STAGES.assessment,
        label: "Failure assessment",
        role: "validate",
        required: true,
        contexts: "per-candidate",
        instructions:
          "You judge one failure the host observed while reproducing a finding; your brief has the finding, the reproducer that ran and its execution record. Read the code the finding and the reproducer involve. Answer cause defect only when the failure is the defect the finding describes (cite the code that shows it); reproducer when the test itself is wrong or tests something else; environment when the run's setting caused it (a missing package or service, permissions, time); unknown when you cannot tell. The execution record is observed fact, never your guess; your answer never rejects the finding.",
        artifact: { kind: "custom", shape: ASSESS_SHAPE, validate: checkAssessment },
      },
    ],
    brief,
    finalize,
  };
}

/** The settle step, keeping the reproducer text for the assessment brief of the same run. */
async function rememberingSettle(check: ArtifactCheck, ctx: ArtifactCheckContext, signal: AbortSignal): Promise<ArtifactCheck> {
  const test = (check.value as { test?: { sha256?: string; content?: string } } | undefined)?.test;
  if (ctx.run && test?.sha256 && typeof test.content === "string") reproducerContent.set(`${ctx.run.runDir}\u0000${test.sha256}`, test.content);
  return settleReproducer(check, ctx, signal);
}

