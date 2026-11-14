// Post-patch validation (method `post-patch-validation`), an original JGates method (the Trail of Bits post-patch-
// validation skill is a reference for the question it asks; no upstream text is used). Does the reproducer fail before
// the patch and pass after it, without a nearby regression? The host answers by execution, never the model: the model
// chooses (or writes) the reproducer and the nearby tests, the host runs them in isolated fixtures of both ends of the
// patch, each file in an ephemeral container of the tools image (core/regressions runner: no network, read-only tree
// and root, the step user, limits, removed when it ends; the project folder is never mounted), and an independent
// context judges every failure the runs show. No test runs as a host process.
//
//   inputs        the patch: an incremental scope with a resolved base commit and changed code; the changed test files
//                 of the patch and the node:test files near the change (host facts); a container engine with the
//                 tools image (or JGates running inside the image); the workspace's dependency volume when prepared
//   hypothesis    the patch fixes the defect its reproducer shows, and breaks no test near it
//   method        reproducer (explore, one context): the defect, the changed code it lives in, the reproducer (a test the
//                              patch adds or changes, or a node:test module it writes) and the nearby tests to keep green;
//                              once that artifact is valid (its settle step), the host builds the before fixture (base
//                              commit) and the after fixture (target) from the files the run may read, runs the reproducer
//                              and the nearby tests in both, in containers, and turns each failure into a candidate (not
//                              reproduced before, still failing after, nearby regression)
//                 assessment (validate, a fresh context per candidate, with the execution records): is the failure the
//                              patch's, the reproducer's or the environment's
//   output        evidence/post-patch-validation/execution.json (every run: fixture end, file, outcome, TAP summary, masked
//                 output, the facts of its container: image digest, network none, read-only tree, user, limits; a
//                 record of the earlier host sandbox listed its permission flags there instead) and evidence/post-patch-validation/validation.json (reproduced, fixed, regressions,
//                 evidence basis "execution"); a reproducer the model wrote that failed before and passed after becomes a
//                 regression proposal (evidence/regressions/proposals.json) with that execution evidence
//   claims        reproduced only when the before run executed and failed; fixed only when the after run executed and
//                 passed. When nothing could be executed the run ends unavailable: no claim is made without execution
//   applicability not applicable without a patch (POST_PATCH_NO_PATCH: no incremental scope with a base, or no changed code)
//                 or, asked by the run before any context starts, without a container engine or the tools image (the
//                 engine's own code: ENGINE_NOT_INSTALLED, ENGINE_STOPPED, UNSUPPORTED_PLATFORM, IMAGE_MISSING). Without
//                 prepared dependencies a test that needs a package ends as error and the run says so
//                 (DEPENDENCIES_NOT_PREPARED)
//   overlap       the differential review argues what a change breaks from source; the Quality test checks run the
//                 project's suites on the current tree only. This module adds the observed before/after behavior of one
//                 reproducer and the nearby tests, in isolation, which neither provides.
import fs from "node:fs";
import path from "node:path";
import { openTarget } from "../../semantic-scope/index.js";
import type { ArtifactCandidate, ArtifactCheck, ArtifactCheckContext, InvestigationModule, ModuleApplicability, ModuleApplicabilityInput, ModuleBriefInput, ModuleFinalizeInput, ModuleFinalizeOutput } from "../../semantic-executor/index.js";
import { checkProposedTest, proposalsFile, REGRESSIONS_DIR, sha256 } from "../../regressions/proposals.js";
import { removeFixture, writeFixture, type Fixture, type FixtureFile } from "../../regressions/fixture.js";
import { DEPENDENCIES_NOT_PREPARED, TEST_RECIPES, dependencyMountPoints, notRunTest, runTestFile, testEnvironment, testRuntime, type TestRun } from "../../regressions/runner.js";
import { resolveHome } from "../../home/index.js";
import { workspaceId } from "../../ids/index.js";
import { briefJson, checkVerdict, isCodePath, isTestPath, isObj, list, maskBrief, seenPaths, seenRef, str } from "../complementary/shared.js";
import { lineDiff } from "../differential/index.js";

export const POST_PATCH_METHOD = "post-patch-validation";
export const POST_PATCH_MODULE_ID = "post-patch-validation";
export const EXECUTION_FILE = "evidence/post-patch-validation/execution.json";
export const VALIDATION_FILE = "evidence/post-patch-validation/validation.json";
export const STAGES = { reproducer: "reproducer", assessment: "assessment" } as const;
export const CAUSES = ["patch", "reproducer", "environment", "unknown"] as const;
const RUNNABLE = /\.(mjs|cjs|js)$/;
const MAX_CHANGES = 30;
const MAX_LINES = 60;
const MAX_NEIGHBOURS = 5;

export interface PatchFacts {
  baseline: { ref: string | null; commit: string };
  target: { ref: string | null; commit: string | null };
  changes: Array<{ path: string; change: string; previousPath: string | null; removed: Array<{ line: number; text: string }>; added: Array<{ line: number; text: string }>; truncated: boolean }>;
  /** Test files the patch adds or changes that the test runner can run (node:test candidates). */
  patchTests: string[];
  /** Readable runnable test files that mention a changed file. */
  nearbyTests: string[];
}

/** The test runner of this method (node:test; pytest is another recipe of the same runner). */
const RECIPE = TEST_RECIPES["node:test"];

interface PatchInputs {
  facts: PatchFacts;
  workspacePath: string;
  env: NodeJS.ProcessEnv;
}

/** The host facts of the patch (no model involved), or what is missing. */
export function patchFacts(input: ModuleApplicabilityInput): PatchFacts | { missing: "patch"; reason: string } {
  const res = input.scope.resolution;
  const base = res.spec.resolved.base;
  if (res.mode !== "incremental" || !base?.commit) {
    return { missing: "patch", reason: `post-patch validation needs a patch: an incremental scope with a base commit (this run's scope is ${res.mode}${res.mode === "incremental" ? " without a resolved base commit" : ""}); run it with --scope incremental --base <ref>` };
  }
  const changed = res.impact.changes.filter((c) => c.change !== "unchanged");
  if (!changed.some((c) => isCodePath(c.path) && !isTestPath(c.path))) {
    return { missing: "patch", reason: `post-patch validation found no changed code between the base ${base.ref ?? base.commit.slice(0, 12)} and the target (only tests, documentation or configuration changed, or nothing)` };
  }
  const baseView = openTarget(input.workspacePath, { kind: "commit", commit: base.commit, overlay: [] }, input.env);
  const readable = input.readableFiles();
  const changes: PatchFacts["changes"] = [];
  for (const c of changed.slice(0, MAX_CHANGES)) {
    const beforeBuf = c.change === "added" || c.change === "untracked" ? null : baseView.read(c.previousPath ?? c.path);
    const before = beforeBuf ? beforeBuf.toString("utf8").replace(/\r\n/g, "\n").split("\n") : [];
    const after = c.change === "removed" ? [] : (input.readFile(c.path) ?? "").replace(/\r\n/g, "\n").split("\n");
    const diff = lineDiff(before, after);
    const keep = (l: { line: number; text: string }) => l.text.trim() !== "";
    const removed = diff.removed.filter(keep);
    const added = diff.added.filter(keep);
    changes.push({
      path: c.path,
      change: c.change,
      previousPath: c.previousPath ?? null,
      removed: removed.slice(0, MAX_LINES).map((l) => ({ line: l.line, text: maskBrief(l.text.slice(0, 300)) })),
      added: added.slice(0, MAX_LINES).map((l) => ({ line: l.line, text: maskBrief(l.text.slice(0, 300)) })),
      truncated: removed.length > MAX_LINES || added.length > MAX_LINES,
    });
  }
  const patchTests = changed.filter((c) => c.change !== "removed" && isTestPath(c.path) && RUNNABLE.test(c.path) && readable.includes(c.path)).map((c) => c.path);
  const stems = changed.filter((c) => isCodePath(c.path) && !isTestPath(c.path)).map((c) => path.posix.basename(c.path).replace(/\.[^.]+$/, ""));
  const nearbyTests = readable.filter((p) => isTestPath(p) && RUNNABLE.test(p) && !patchTests.includes(p) && stems.some((s) => (input.readFile(p) ?? "").includes(s))).slice(0, 10);
  return { baseline: { ref: base.ref, commit: base.commit }, target: { ref: res.spec.resolved.target.ref, commit: res.spec.resolved.target.commit }, changes, patchTests, nearbyTests };
}

const inputsOf = (inputs: Readonly<Record<string, unknown>> | undefined): PatchInputs | null => (inputs?.facts ? (inputs as unknown as PatchInputs) : null);

type End = "before" | "after";
interface ExecutionRecord {
  executed: boolean;
  executedAt: string;
  reason: string | null;
  reproducer: { source: "patch-test" | "proposed"; path: string; sha256: string };
  /** dependencies: the workspace's dependency volume was mounted in the fixture's containers (false: not prepared). */
  fixtures: Record<End, { files: number; dependencies: boolean }>;
  /** Each run carries the facts of its container (`container`); a record of the earlier host sandbox has `permissions`. */
  before: TestRun | null;
  after: TestRun | null;
  neighbours: Array<{ path: string; existedBefore: boolean; before: TestRun | null; after: TestRun | null; regression: boolean }>;
}

/** A run of this record or of a stored one (the host sandbox's records have no `dependenciesMissing` or `container`). */
type AnyRun = Pick<TestRun, "executed" | "outcome" | "tests" | "exitCode" | "reason" | "output"> & Partial<Pick<TestRun, "dependenciesMissing">>;

/** Whether a run of the record ended as error because the workspace's dependencies are not prepared. */
const needsDependencies = (ex: ExecutionRecord): boolean => [ex.before, ex.after, ...ex.neighbours.flatMap((n) => [n.before, n.after])].some((r) => !!r?.dependenciesMissing);
const DEPENDENCIES_REASON = "the workspace's dependencies are not prepared, so a test that needs a package ended as error (jgates deps prepare, or the prepare dependencies action, then run the method again)";

/** Executions already made for a run (a repeated validation of the same artifact never runs anything twice). */
const executions = new Map<string, ExecutionRecord>();

/** package.json files that decide how the copied files load (root and the folders above each file), never excluded ones. */
function manifestsFor(paths: readonly string[], ctx: ArtifactCheckContext): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = parts.length - 1; i >= 0; i--) out.add([...parts.slice(0, i), "package.json"].join("/"));
  }
  return [...out].filter((m) => ctx.run?.scope.guard.check(m).code !== "EXCLUDED");
}

async function execute(ctx: ArtifactCheckContext, inputs: PatchInputs, reproducer: { source: "patch-test" | "proposed"; path: string; content: string }, neighbours: string[], signal: AbortSignal): Promise<ExecutionRecord> {
  const run = ctx.run!;
  const key = `${run.runDir}\u0000${reproducer.path}\u0000${sha256(reproducer.content)}\u0000${neighbours.join(",")}`;
  const cached = executions.get(key);
  if (cached) return cached;
  const { facts, workspacePath, env } = inputs;
  const record: ExecutionRecord = {
    executed: false,
    executedAt: new Date().toISOString(),
    reason: null,
    reproducer: { source: reproducer.source, path: reproducer.path, sha256: sha256(reproducer.content) },
    fixtures: { before: { files: 0, dependencies: false }, after: { files: 0, dependencies: false } },
    before: null,
    after: null,
    neighbours: [],
  };
  const readable = run.scope.guard.readable().filter((p) => ctx.readable(p));
  const changes = new Map(facts.changes.map((c) => [c.path, c]));
  const baseView = openTarget(workspacePath, { kind: "commit", commit: facts.baseline.commit, overlay: [] }, env);
  const targetView = openTarget(workspacePath, run.scope.resolution.target, env);
  const after: FixtureFile[] = [];
  const before: FixtureFile[] = [];
  for (const p of readable) {
    const text = run.readFile(p);
    if (text !== null) after.push({ path: p, content: text });
    const c = changes.get(p);
    if (c && (c.change === "added" || c.change === "untracked")) continue;
    const old = baseView.read(c?.previousPath ?? p);
    if (old !== null) before.push({ path: p, content: old });
  }
  // Files the patch removed exist only before it.
  for (const c of facts.changes) if (c.change === "removed") {
    const old = baseView.read(c.path);
    if (old !== null && ctx.run?.scope.guard.check(c.path).code !== "EXCLUDED") before.push({ path: c.path, content: old });
  }
  for (const m of manifestsFor(readable, ctx)) {
    const a = targetView.read(m);
    const b = baseView.read(m);
    if (a !== null && !after.some((f) => f.path === m)) after.push({ path: m, content: a });
    if (b !== null && !before.some((f) => f.path === m)) before.push({ path: m, content: b });
  }
  // The reproducer runs at both ends: the same file, byte for byte.
  for (const list of [before, after]) {
    const i = list.findIndex((f) => f.path === reproducer.path);
    if (i >= 0) list.splice(i, 1);
    list.push({ path: reproducer.path, content: reproducer.content });
  }
  const work = path.join(run.runDir, "work", "post-patch");
  const dirs: Record<End, string> = { before: path.join(work, "before"), after: path.join(work, "after") };
  try {
    // Where the tests run: a container engine with the tools image (or JGates inside the image), and the workspace's
    // prepared dependency volumes. Without them nothing runs and nothing is claimed.
    const prepared = await testEnvironment({ env, home: resolveHome({ env }), workspace: workspaceId(workspacePath), run: path.basename(run.runDir) });
    if (!prepared.ok) {
      record.reason = `${prepared.code}: ${prepared.reason}`;
      record.before = notRunTest(reproducer.path, record.reason);
      record.after = notRunTest(reproducer.path, record.reason);
    } else {
      const { environment } = prepared;
      // The host dependencies folder is never used (ADR-0006): the dependency volume is mounted read-only on an empty folder.
      const mountPoints = dependencyMountPoints(environment, RECIPE);
      const fx: Record<End, Fixture> = { before: writeFixture(dirs.before, before, { mountPoints }), after: writeFixture(dirs.after, after, { mountPoints }) };
      record.fixtures = { before: { files: fx.before.files, dependencies: fx.before.mountPoints.length > 0 }, after: { files: fx.after.files, dependencies: fx.after.mountPoints.length > 0 } };
      const runAt = (end: End, file: string): Promise<TestRun> => runTestFile(environment, fx[end], file, { recipe: RECIPE, signal });
      record.before = await runAt("before", reproducer.path);
      record.after = await runAt("after", reproducer.path);
      for (const n of neighbours) {
        const existedBefore = before.some((f) => f.path === n);
        const b = existedBefore ? await runAt("before", n) : null;
        const a = await runAt("after", n);
        record.neighbours.push({ path: n, existedBefore, before: b, after: a, regression: !!b && b.executed && b.outcome === "passed" && a.executed && a.outcome !== "passed" });
      }
      record.executed = record.before.executed && record.after.executed;
      if (!record.executed) record.reason = record.before.reason ?? record.after.reason ?? "the container did not run the reproducer";
    }
  } catch (error) {
    record.executed = false;
    record.reason = `the isolated fixtures could not be prepared: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
  } finally {
    for (const d of Object.values(dirs)) removeFixture(d);
  }
  try {
    const file = path.join(run.runDir, ...EXECUTION_FILE.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, kind: "semantic-post-patch-execution", baseline: facts.baseline, target: facts.target, ...record }, null, 2)}\n`);
  } catch {
    // The accepted artifact still carries the record (validation.json repeats it).
  }
  executions.set(key, record);
  return record;
}

const outcomeText = (r: AnyRun | null): string => (!r ? "absent" : !r.executed ? `not executed (${r.reason ?? "-"})` : `${r.outcome}${r.tests ? ` (${r.tests.pass}/${r.tests.total} passed)` : ""}${r.reason ? `: ${r.reason}` : ""}`);

const REPRO_SHAPE = `{"summary": "...", "defect": "the behavior the patch fixes", "target": {"path": "changed code file you read", "line": 12}, "reproducer": {"source": "patch-test|proposed", "path": "patch-test: the changed test file you read", "name": "proposed: short-name.test.mjs", "content": "proposed: a node:test module; it lives at ${REGRESSIONS_DIR}/<name> and imports project files relative to that folder, e.g. ../../src/x.js"}, "neighbours": ["runnable node:test files near the change that you read"]}`;
const ASSESS_SHAPE = `{"candidateId": "C1", "confirmation": "confirmed|rejected|needs-validation", "reason": "...", "evidence": [{"path": "...", "line": 12, "note": "..."}], "severity": "optional correction", "cause": "${CAUSES.join("|")}"}`;

function checkReproducer(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const problems: string[] = [];
  const inputs = inputsOf(ctx.run?.inputs);
  if (!inputs || !ctx.run) return { ok: false, problems: ["the reproducer stage needs the patch facts of the run"] };
  const summary = str(value.summary, 1500);
  const defect = str(value.defect, 800);
  if (summary === "" || defect === "") return { ok: false, problems: ["summary and defect are required"] };
  const target = isObj(value.target) ? seenRef(value.target.path, value.target.line, ctx, problems, "target") : null;
  if (!target || !inputs.facts.changes.some((c) => c.path === target.path && c.change !== "removed" && !isTestPath(c.path))) {
    return { ok: false, problems: [...problems, "target must be a changed code file of the patch that this context read"] };
  }
  const raw = isObj(value.reproducer) ? value.reproducer : null;
  let reproducer: { source: "patch-test" | "proposed"; path: string; content: string } | null = null;
  if (raw?.source === "patch-test") {
    const p = seenPaths([raw.path], ctx, problems, "reproducer")[0];
    const content = p && inputs.facts.patchTests.includes(p) ? ctx.run.readFile(p) : null;
    if (p && content !== null) reproducer = { source: "patch-test", path: p, content: content.replace(/\r\n/g, "\n") };
    else problems.push(`reproducer: ${JSON.stringify(String(raw.path ?? "").slice(0, 100))} is not a runnable test file of the patch this context read`);
  } else if (raw) {
    const test = checkProposedTest(raw, problems, "reproducer");
    if (test) reproducer = { source: "proposed", path: `${REGRESSIONS_DIR}/${test.file}`, content: test.content };
  }
  if (!reproducer) return { ok: false, problems: [...problems, "a reproducer is required: a runnable test of the patch (patch-test) or a node:test module (proposed)"] };
  const neighbours = seenPaths(value.neighbours, ctx, problems, "neighbours")
    .filter((p) => {
      const ok = isTestPath(p) && RUNNABLE.test(p) && p !== reproducer!.path && ctx.readable(p);
      if (!ok) problems.push(`neighbour ${p} is dropped: not a runnable test file other than the reproducer`);
      return ok;
    })
    .slice(0, MAX_NEIGHBOURS);
  // The runs happen in the settle step (settleReproducer), once this artifact is known to be valid.
  return { ok: true, problems, value: { summary, defect, target, reproducer: { source: reproducer.source, path: reproducer.path, content: reproducer.content }, neighbours }, examined: [target.path, ...neighbours, ...(reproducer.source === "patch-test" ? [reproducer.path] : [])], gaps: [] };
}

/** After a valid reproducer artifact: runs the reproducer and the neighbours at both ends, in containers, and turns the runs into candidates. */
async function settleReproducer(check: ArtifactCheck, ctx: ArtifactCheckContext, signal: AbortSignal): Promise<ArtifactCheck> {
  const inputs = inputsOf(ctx.run?.inputs);
  const value = check.value as { target: { path: string; line: number | null }; reproducer: { source: "patch-test" | "proposed"; path: string; content: string }; neighbours: string[] } | undefined;
  if (!inputs || !ctx.run || !value) return { ok: false, problems: [...check.problems, "the reproducer stage needs the patch facts of the run"] };
  const { target, reproducer, neighbours } = value;
  const execution = await execute(ctx, inputs, reproducer, neighbours, signal);
  const candidates: ArtifactCandidate[] = [];
  const gaps: Array<{ path?: string; reason: string }> = [];
  if (needsDependencies(execution)) gaps.push({ reason: `${DEPENDENCIES_NOT_PREPARED}: ${DEPENDENCIES_REASON}` });
  if (!execution.executed) {
    gaps.push({ path: reproducer.path, reason: `not executed: ${execution.reason ?? "-"}; nothing is claimed` });
  } else {
    const at = { path: target.path, line: target.line };
    if (execution.before?.outcome !== "failed") {
      candidates.push({ ...at, title: "The reproducer does not fail before the patch", severity: "important", category: "post-patch", rationale: `Before the patch the reproducer ${outcomeText(execution.before)}: the defect is not demonstrated, so the patch's effect is not shown.`, details: { kind: "not-reproduced", before: outcomeText(execution.before), after: outcomeText(execution.after), evidence_basis: "execution" } });
    } else if (execution.after?.outcome !== "passed") {
      candidates.push({ ...at, title: "The reproducer still fails after the patch", severity: "blocking", category: "post-patch", rationale: `The reproducer failed before the patch (${outcomeText(execution.before)}) and after it ${outcomeText(execution.after)}.`, details: { kind: "not-fixed", before: outcomeText(execution.before), after: outcomeText(execution.after), evidence_basis: "execution" } });
    }
    for (const n of execution.neighbours) {
      if (n.regression) {
        candidates.push({ path: n.path, line: null, title: `Nearby test ${n.path} passes before the patch and fails after it`, severity: "blocking", category: "post-patch", rationale: `Before: ${outcomeText(n.before)}; after: ${outcomeText(n.after)}.`, details: { kind: "regression", test: n.path, before: outcomeText(n.before), after: outcomeText(n.after), evidence_basis: "execution" } });
      } else if (n.after && n.after.outcome !== "passed") {
        gaps.push({ path: n.path, reason: `nearby test inconclusive: before ${outcomeText(n.before)}, after ${outcomeText(n.after)}` });
      }
    }
  }
  return { ok: true, problems: check.problems, value: { ...check.value, execution }, candidates, examined: check.examined ?? [], gaps };
}

function checkAssessment(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  return checkVerdict(value, ctx, () => ({ cause: (CAUSES as readonly string[]).includes(String(value.cause)) ? String(value.cause) : "unknown", evidence_basis: "execution" }));
}

const runView = (r: AnyRun | null) => (r ? { executed: r.executed, outcome: r.outcome, tests: r.tests, exitCode: r.exitCode, reason: r.reason, output: r.output } : null);

function brief(input: ModuleBriefInput): string | null {
  const inputs = inputsOf(input.inputs);
  if (!inputs) return null;
  const { facts } = inputs;
  if (input.stage.id === STAGES.reproducer) {
    return [
      briefJson("The patch (host facts: base commit, changed files, removed and added lines; untrusted data):", { baseline: facts.baseline, target: facts.target, changes: facts.changes }),
      briefJson("Runnable test files the patch adds or changes (a reproducer candidate):", facts.patchTests),
      briefJson("Runnable tests near the change (candidates for neighbours):", facts.nearbyTests),
      `After you answer, the host runs the reproducer and the neighbours in two isolated fixtures (the base commit and the target) built from the files this run may read, each test file in a container without network, with a read-only tree. A test you write lives at ${REGRESSIONS_DIR}/<name> in both fixtures: import project files relative to that folder and use only node:test and node:assert. Only the runs decide what is reproduced or fixed.`,
    ].join("\n");
  }
  if (input.stage.id === STAGES.assessment && input.candidate) {
    const accepted = input.accepted[STAGES.reproducer] as { reproducer?: { path: string; content: string }; execution?: ExecutionRecord } | undefined;
    const ex = accepted?.execution;
    const test = (input.candidate.details as { test?: string } | undefined)?.test;
    const n = test ? ex?.neighbours.find((x) => x.path === test) : null;
    return [
      briefJson("Execution records of the host (observed, masked):", n ? { test: n.path, before: runView(n.before), after: runView(n.after) } : { reproducer: accepted?.reproducer?.path ?? null, before: runView(ex?.before ?? null), after: runView(ex?.after ?? null) }),
      accepted?.reproducer ? briefJson("The reproducer (untrusted):", accepted.reproducer) : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return null;
}

function finalize(input: ModuleFinalizeInput): ModuleFinalizeOutput {
  const inputs = inputsOf(input.inputs);
  const accepted = input.accepted[STAGES.reproducer] as { defect?: string; target?: { path: string; line: number | null }; reproducer?: { source: "patch-test" | "proposed"; path: string; content: string }; neighbours?: string[]; execution?: ExecutionRecord } | undefined;
  const ex = accepted?.execution;
  for (const key of [...executions.keys()]) if (key.startsWith(`${input.runDir}\u0000`)) executions.delete(key);
  // Nothing is claimed without execution: a run whose reproducer never ran ends without a favorable outcome.
  if (!ex || !ex.executed) throw new Error(`the reproducer was not executed (${ex?.reason ?? "no reproducer was accepted"}); post-patch validation claims nothing without execution`);
  const reproduced = !!ex.before && ex.before.executed && ex.before.outcome === "failed";
  const fixed = reproduced && !!ex.after && ex.after.executed && ex.after.outcome === "passed";
  const regressions = ex.neighbours.filter((n) => n.regression).map((n) => n.path);
  const proposals =
    accepted?.reproducer?.source === "proposed" && reproduced && fixed
      ? proposalsFile(input.runDir, POST_PATCH_METHOD, [
          {
            file: path.posix.basename(accepted.reproducer.path),
            content: accepted.reproducer.content,
            title: `Reproducer: ${String(accepted.defect ?? "").slice(0, 160)}`,
            rationale: `Failed before the patch (${inputs?.facts.baseline.ref ?? inputs?.facts.baseline.commit.slice(0, 12) ?? "base"}) and passed after it, in isolated fixtures run in containers of the tools image.`,
            origin: { stage: STAGES.reproducer, candidate: null, candidateStatus: null, invariant: null },
            execution: { before: { outcome: ex.before?.outcome, tests: ex.before?.tests }, after: { outcome: ex.after?.outcome, tests: ex.after?.tests }, executedAt: ex.executedAt, baseline: inputs?.facts.baseline ?? null },
          },
        ])
      : null;
  const doc = {
    schemaVersion: 1,
    kind: "semantic-post-patch-validation",
    method: POST_PATCH_METHOD,
    generatedAt: input.now.toISOString(),
    evidenceBasis: "execution",
    baseline: inputs?.facts.baseline ?? null,
    target: inputs?.facts.target ?? null,
    defect: accepted?.defect ?? null,
    changedCode: accepted?.target ?? null,
    reproducer: accepted?.reproducer ? { source: accepted.reproducer.source, path: accepted.reproducer.path, sha256: sha256(accepted.reproducer.content) } : null,
    executed: true,
    reproduced,
    fixed,
    regressions,
    // Whether the workspace's dependency volume was mounted (prepared) and whether a test needed it when it was not.
    dependencies: { prepared: ex.fixtures.before.dependencies || ex.fixtures.after.dependencies, missingForTests: needsDependencies(ex), ...(needsDependencies(ex) ? { code: DEPENDENCIES_NOT_PREPARED, reason: DEPENDENCIES_REASON } : {}) },
    before: runView(ex.before),
    after: runView(ex.after),
    neighbours: ex.neighbours.map((n) => ({ path: n.path, existedBefore: n.existedBefore, before: runView(n.before), after: runView(n.after), regression: n.regression })),
    candidates: input.candidates.map((c) => ({ id: c.id, title: c.title, path: c.path, status: c.status, details: c.details ?? null, validation: c.validation })),
    proposal: proposals?.proposals[0]?.id ?? null,
  };
  return {
    files: [{ path: VALIDATION_FILE, content: `${JSON.stringify(doc, null, 2)}\n` }, ...(proposals ? [{ path: proposals.path, content: proposals.content }] : [])],
    gaps: [
      ...(needsDependencies(ex) ? [{ code: DEPENDENCIES_NOT_PREPARED, reason: DEPENDENCIES_REASON }] : []),
      ...ex.neighbours.filter((n) => !n.regression && n.after && n.after.outcome !== "passed").map((n) => ({ code: "NEIGHBOUR_INCONCLUSIVE", path: n.path, reason: `before ${outcomeText(n.before)}, after ${outcomeText(n.after)}` })),
    ],
    report: { executed: true, reproduced, fixed, regressions: regressions.length, neighbours: ex.neighbours.length, proposal: proposals !== null, dependenciesPrepared: ex.fixtures.before.dependencies || ex.fixtures.after.dependencies },
  };
}

const OBJECTIVE =
  "Validate a patch by execution: identify the defect the patch fixes and a reproducer that demonstrates it (a test the patch adds or changes, or a small node:test module you write), and the existing tests near the change that must keep passing. The host runs them before and after the patch in isolated fixtures; only those runs decide whether the defect was reproduced, whether the patch fixes it and whether a nearby test regressed.";

export function postPatchModule(): InvestigationModule {
  return {
    id: POST_PATCH_MODULE_ID,
    version: "1",
    title: "Post-patch validation",
    objective: OBJECTIVE,
    provenance: { origin: "original JGates method", reference: "https://github.com/trailofbits/skills/tree/main/plugins/post-patch-validation (question only; no upstream text used)", execution: "core/regressions test-file runner (ephemeral containers of the tools image, no network, read-only tree)" },
    minimum: { exploreCalls: 1, reserveCalls: 1 },
    applicability: (input): ModuleApplicability => {
      const facts = patchFacts(input);
      if ("missing" in facts) return { applicable: false, code: "POST_PATCH_NO_PATCH", missing: "patch", reason: facts.reason };
      const inputs: PatchInputs = { facts, workspacePath: input.workspacePath, env: input.env };
      return { applicable: true, inputs: inputs as unknown as Record<string, unknown>, record: { baseline: facts.baseline, changes: facts.changes.length, patchTests: facts.patchTests, nearbyTests: facts.nearbyTests } };
    },
    // Asked by the run only (never by a plan preview): the reproducer runs in containers of the tools image.
    prerequisites: async (input) => {
      const runtime = await testRuntime(input.env);
      return runtime.ok ? null : { code: runtime.code, missing: "container engine and tools image", reason: `post-patch validation runs the reproducer and the nearby tests in containers of the tools image: ${runtime.reason}` };
    },
    stages: [
      {
        id: STAGES.reproducer,
        label: "Reproducer and nearby tests",
        role: "explore",
        required: true,
        contexts: "once",
        instructions:
          "Read the changed code and the tests your brief lists. State the defect the patch fixes and the changed code file it lives in. Choose the reproducer: a runnable test file the patch adds or changes (source patch-test, give its path), or write a minimal deterministic node:test module that fails while the defect exists and passes once it is fixed (source proposed, give name and content). List up to five existing runnable tests near the change that must keep passing. Do not predict the results: the host executes everything after you answer.",
        artifact: { kind: "custom", shape: REPRO_SHAPE, validate: checkReproducer, settle: settleReproducer },
      },
      {
        id: STAGES.assessment,
        label: "Failure assessment",
        role: "validate",
        required: true,
        contexts: "per-candidate",
        instructions:
          "You judge one failure the host observed while validating the patch; your brief has the execution records. Read the code and tests involved. Confirm it when the failure is the patch's (it does not fix the defect, or it breaks the nearby test); reject it when the records and the code you read show the failure comes from the reproducer itself (it tests something else) or from the environment of the fixture (cite what shows it), and say which cause; answer needs-validation when you cannot tell. Cite the files you read; the execution records are observed facts, never your guess.",
        artifact: { kind: "custom", shape: ASSESS_SHAPE, validate: checkAssessment },
      },
    ],
    brief,
    finalize,
  };
}
