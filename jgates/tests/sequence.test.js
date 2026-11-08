import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Gate selection and the combined sequence (core/sequence): parsing the gate choice, its origins through the
// configuration layers, the Quality prerequisite assessment from the core decision fields (every refusal reason, scoped
// Quality under both coverage policies, optional warnings), the coverage summary that never makes a blanket claim, the
// run identity a Quality run now records, saved profile gates and the cancellation of a waiting sequence.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (...parts) => import(pathToFileURL(path.join(here, "..", "dist", ...parts)).href);
const seq = await dist("core", "sequence", "index.js");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const SOURCE = (id = "a") => ({
  schemaVersion: 1,
  id: `sha256:${id.repeat(64).slice(0, 64)}`,
  basis: "git-working-tree",
  repository: { id: `sha256:${"1".repeat(64)}`, idBasis: "root-commits", root: "/repo", prefix: "" },
  commit: "c".repeat(40),
  dirty: false,
  dirtyContentHash: null,
  dirtyPaths: 0,
  inputsHash: `sha256:${"2".repeat(64)}`,
  traceable: true,
});

/** A Quality result with the decision fields of the core contract. */
function result(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: "run_20260101T000000Z_00000001",
    decision: "passed",
    complete: true,
    reduced: false,
    exitCode: 0,
    requirements: [{ id: "lint", required: true }, { id: "extra", required: false }],
    stages: [{ id: "lint", state: "completed" }],
    unsatisfied: [],
    warnings: [],
    blockingViolations: 0,
    ...overrides,
  };
}

function evidence({ res = result(), source = SOURCE(), recorded = true, scope = { requested: "full", effective: "full", paths: [], base: null, head: null, note: null } } = {}) {
  return { runId: res.runId, result: res, identity: { source }, identityRecorded: recorded, planScope: scope };
}

const assess = (ev, more = {}) => seq.assessQualityPrerequisite({ quality: ev, current: SOURCE(), policy: "declared-scope", semanticScope: null, ...more });

test("the --gates flag accepts quality, semantic, both and comma lists, ordered Quality first; anything else is refused", () => {
  assert.deepEqual(seq.parseGatesFlag(["semantic,quality"]), { ok: true, gates: ["quality", "semantic"] });
  assert.deepEqual(seq.parseGatesFlag(["both"]), { ok: true, gates: ["quality", "semantic"] });
  assert.deepEqual(seq.parseGatesFlag(["semantic", "semantic"]), { ok: true, gates: ["semantic"] });
  assert.deepEqual(seq.parseGatesFlag(["quality,ai"]), { ok: false, problem: { code: "GATES_UNKNOWN", value: "ai" } });
  assert.equal(seq.parseGatesFlag([","]).ok, false);
  assert.equal(seq.normalizeGates([]), null);
  assert.equal(seq.isCombined(["quality", "semantic"]), true);
  assert.equal(seq.isCombined(["semantic"]), false);
});

test("a complete, passed, non-reduced Quality run of the current source approves; optional warnings never block", () => {
  const ok = assess(evidence({ res: result({ warnings: [{ stageId: "extra", state: "error" }], stages: [{ id: "lint", state: "completed" }, { id: "extra", state: "error" }] }) }));
  assert.equal(ok.approved, true);
  assert.equal(ok.code, "QUALITY_APPROVED");
  assert.equal(ok.status, "advance");
  assert.equal(ok.freshness.state, "current");
  assert.equal(ok.quality.warnings, 1);
  assert.deepEqual(ok.quality.problemStages, [], "an optional stage in error is not a required problem");
});

test("every non-approving Quality state is refused with its own reason, and the decision is copied, never rewritten", () => {
  const cases = [
    [result({ decision: "failed", blockingViolations: 2 }), "QUALITY_FAILED", "stopped"],
    [result({ decision: "incomplete", complete: false, exitCode: 2, unsatisfied: [{ requirementId: "lint", state: "blocked" }], stages: [{ id: "lint", state: "blocked" }] }), "QUALITY_INCOMPLETE", "stopped"],
    [result({ reduced: true }), "QUALITY_REDUCED", "stopped"],
    [result({ decision: "invalid", complete: false, exitCode: 3 }), "QUALITY_INVALID", "stopped"],
    [result({ decision: "cancelled", complete: false, exitCode: 130, stages: [{ id: "lint", state: "cancelled" }] }), "QUALITY_CANCELLED", "cancelled"],
    [result({ decision: "incomplete", complete: false, exitCode: 2, stages: [{ id: "lint", state: "timeout" }] }), "QUALITY_TIMEOUT", "stopped"],
    [result({ decision: "incomplete", complete: false, exitCode: 2, stages: [{ id: "lint", state: "error" }] }), "QUALITY_ERROR", "stopped"],
    [result({ decision: "incomplete", complete: false, partial: true }), "QUALITY_PARTIAL", "stopped"],
    [null, "QUALITY_RUN_UNREADABLE", "stopped"],
  ];
  for (const [res, code, status] of cases) {
    const a = assess({ runId: "run_20260101T000000Z_00000001", result: res, identity: { source: SOURCE() }, identityRecorded: true, planScope: null });
    assert.equal(a.approved, false, code);
    assert.equal(a.code, code, JSON.stringify(a.reasons));
    assert.equal(a.status, status, code);
    assert.equal(a.quality.decision, res?.decision ?? null, "the Quality decision is copied as recorded");
  }
});

test("a changed source pauses (stale); an untraceable, legacy or unrecorded source pauses as unverifiable", () => {
  const stale = assess(evidence({ source: SOURCE("b") }));
  assert.equal(stale.code, "SOURCE_CHANGED");
  assert.equal(stale.status, "paused");
  assert.equal(stale.freshness.state, "stale");
  const legacy = assess(evidence({ source: { ...SOURCE(), basis: "legacy-analyzed" }, recorded: false }));
  assert.equal(legacy.code, "SOURCE_UNVERIFIABLE");
  assert.equal(legacy.freshness.code, "SOURCE_LEGACY");
  assert.equal(legacy.freshness.recorded, "derived");
  assert.equal(assess(evidence({ source: { ...SOURCE(), traceable: false } })).freshness.code, "SOURCE_UNTRACEABLE");
  assert.equal(assess({ ...evidence(), identity: null }).freshness.code, "SOURCE_NOT_RECORDED");
  assert.equal(assess(evidence(), { current: null }).freshness.code, "SOURCE_NOT_COMPUTED");
  // A failure and a stale source together stop (the failure is not a pause).
  assert.equal(assess(evidence({ res: result({ decision: "failed", blockingViolations: 1 }), source: SOURCE("b") })).status, "stopped");
});

test("scoped Quality: declared-scope approves its declared scope when it covers the Semantic subjects; repository needs repository coverage", () => {
  const scoped = { requested: "paths", effective: "paths", paths: ["src/core"], base: null, head: null, note: null };
  const inside = { mode: "selected", subjects: ["src/core/a.js", "src/core"], base: null };
  const ok = assess(evidence({ scope: scoped }), { semanticScope: inside });
  assert.equal(ok.approved, true);
  assert.equal(ok.scope.completion, "complete");
  assert.equal(ok.scope.repositoryCoverage, "declared-scope", "completing a scope is not covering the repository");
  assert.equal(ok.scope.coversSemantic, true);

  const outside = assess(evidence({ scope: scoped }), { semanticScope: { mode: "selected", subjects: ["src/core/a.js", "src/other/b.js"], base: null } });
  assert.equal(outside.code, "QUALITY_SCOPE_MISMATCH");
  assert.deepEqual(outside.scope.uncoveredSubjects, ["src/other/b.js"]);
  assert.equal(assess(evidence({ scope: scoped }), { semanticScope: { mode: "full", subjects: [], base: null } }).code, "QUALITY_SCOPE_MISMATCH", "a scoped Quality run never approves a whole-repository review");

  const strict = assess(evidence({ scope: scoped }), { semanticScope: inside, policy: "repository" });
  assert.equal(strict.code, "QUALITY_SCOPE_NOT_PERMITTED");
  assert.equal(strict.status, "stopped");
  // A scoped request the tools executed on the whole repository covers it, under either policy.
  const widened = assess(evidence({ scope: { ...scoped, effective: "full", note: "widened" } }), { semanticScope: inside, policy: "repository" });
  assert.equal(widened.approved, true);
  assert.equal(widened.scope.repositoryCoverage, "repository");

  const changed = { requested: "changed", effective: "changed", paths: [], base: "main", head: null, note: null };
  assert.equal(assess(evidence({ scope: changed }), { semanticScope: { mode: "incremental", subjects: [], base: "main" } }).approved, true);
  assert.equal(assess(evidence({ scope: changed }), { semanticScope: { mode: "incremental", subjects: [], base: "other" } }).code, "QUALITY_SCOPE_MISMATCH");
});

test("the sequence coverage keeps each gate's completion apart from repository coverage and never makes a blanket claim", () => {
  const full = seq.qualityScopeReport(evidence(), { mode: "full", subjects: [], base: null });
  const passed = { decision: "passed", complete: true };
  const repo = seq.sequenceCoverage(full, { mode: "full", subjects: 0, result: passed }, true);
  assert.equal(repo.approvedScope, "repository");
  assert.equal(repo.blanketClaim, false);
  const scoped = seq.sequenceCoverage(full, { mode: "selected", subjects: 1, result: passed }, true);
  assert.equal(scoped.approvedScope, "declared-scope");
  assert.equal(scoped.semantic.repositoryCoverage, "declared-scope");
  const failed = seq.sequenceCoverage(full, { mode: "full", subjects: 0, result: { decision: "failed", complete: true } }, true);
  assert.equal(failed.approvedScope, "none");
  assert.equal(seq.sequenceCoverage(full, { mode: "full", subjects: 0, result: null }, false).semantic.completion, "not-run");
});

test("the semantic scope follows the Quality scope by default and its shape is what the assessment compares", () => {
  assert.deepEqual(seq.semanticScopeFromQuality({ requested: "paths", paths: ["a", "b"], base: null, head: null }), { mode: "selected", subjects: [{ kind: "path", value: "a" }, { kind: "path", value: "b" }] });
  assert.deepEqual(seq.semanticScopeFromQuality({ requested: "changed", paths: [], base: "main", head: "HEAD" }), { mode: "incremental", base: "main", target: "HEAD" });
  assert.equal(seq.semanticScopeFromQuality({ requested: "full", paths: [], base: null, head: null }), null);
  assert.deepEqual(seq.semanticScopeShape(null), { mode: "full", subjects: [], base: null });
  assert.deepEqual(seq.semanticScopeShape({ mode: "selected", subjects: [{ kind: "path", value: "x" }, { kind: "subsystem", value: "core" }] }), { mode: "selected", subjects: ["x"], base: null });
});

/** A project with a profile `p` and an always-active project template, for the selection origins. */
function project({ templateGates = null, profileGates = null, rootGates = null } = {}) {
  const dir = tmp("jgates-seq-ws-");
  fs.mkdirSync(path.join(dir, ".jgates", "templates"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "jgates.yml"),
    ["schemaVersion: 1", "selection:", "  profile: p", ...(rootGates ? [`  gates: [${rootGates.join(", ")}]`] : []), "templates:", "  - id: t", "    source: .jgates/templates/t.yml", "    activation: always", ""].join("\n"),
  );
  fs.writeFileSync(path.join(dir, ".jgates", "templates", "t.yml"), ["schemaVersion: 1", "id: t", "config:", ...(templateGates ? ["  selection:", `    gates: [${templateGates.join(", ")}]`] : ["  execution:", "    concurrency: 1"]), ""].join("\n"));
  fs.writeFileSync(path.join(dir, ".jgates", "profiles.yml"), ["schemaVersion: 1", "profiles:", "  p:", "    label: P", ...(profileGates ? [`    gates: [${profileGates.join(", ")}]`] : []), ""].join("\n"));
  return dir;
}

test("the gate selection resolves through template < profile < jgates.yml < call, each with its origin", () => {
  const dirs = [];
  try {
    let dir = project();
    dirs.push(dir);
    let s = seq.resolveGateSelection(dir);
    assert.deepEqual(s.gates, ["quality"]);
    assert.equal(s.origin.layer, "defaults");

    dir = project({ templateGates: ["semantic", "quality"] });
    dirs.push(dir);
    s = seq.resolveGateSelection(dir);
    assert.deepEqual(s.gates, ["quality", "semantic"]);
    assert.equal(s.origin.layer, "template");

    dir = project({ templateGates: ["quality", "semantic"], profileGates: ["semantic"] });
    dirs.push(dir);
    s = seq.resolveGateSelection(dir);
    assert.deepEqual(s.gates, ["semantic"]);
    assert.deepEqual(s.origin, { layer: "profile", source: "profile:p", file: ".jgates/profiles.yml", path: "profiles.p.gates", runOnly: false });

    dir = project({ profileGates: ["semantic"], rootGates: ["quality"] });
    dirs.push(dir);
    s = seq.resolveGateSelection(dir);
    assert.deepEqual(s.gates, ["quality"]);
    assert.equal(s.origin.file, "jgates.yml");

    s = seq.resolveGateSelection(dir, { gates: ["semantic", "quality"] });
    assert.deepEqual(s.gates, ["quality", "semantic"]);
    assert.equal(s.origin.runOnly, true);
    assert.deepEqual(s.saved.gates, ["quality"], "the saved choice is reported next to the run-only one");
    assert.equal(s.policy.qualityCoverage, "declared-scope");
  } finally {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("an invalid configuration leaves the default selection and says why; a run-only choice still applies", () => {
  const dir = project();
  try {
    fs.writeFileSync(path.join(dir, ".jgates", "profiles.yml"), "schemaVersion: 1\nprofiles:\n  p:\n    gates: [ai]\n");
    const s = seq.resolveGateSelection(dir, { gates: ["semantic"] });
    assert.deepEqual(s.gates, ["semantic"]);
    assert.ok(s.problems.length > 0);
    assert.deepEqual(seq.resolveGateSelection(dir).gates, ["quality"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a profile saves its gates through the profiles service and lists them; a builtin profile is read-only", async () => {
  const { setProfileGates, listProfiles, createProfile } = await dist("core", "profiles", "index.js");
  const dir = project();
  try {
    const written = setProfileGates(dir, "p", ["semantic", "quality"]);
    assert.deepEqual(written.gates, ["quality", "semantic"]);
    assert.deepEqual(listProfiles(dir).profiles.find((x) => x.id === "p").gates, ["quality", "semantic"]);
    assert.deepEqual(seq.resolveGateSelection(dir).gates, ["quality", "semantic"]);
    setProfileGates(dir, "p", null);
    assert.equal(listProfiles(dir).profiles.find((x) => x.id === "p").gates, null);
    const created = createProfile(dir, "q", { from: "p", gates: ["semantic"] });
    assert.deepEqual(created.gates, ["semantic"]);
    assert.throws(() => setProfileGates(dir, "builtin:standard", ["quality"]), (e) => e.code === "PROFILE_READONLY");
    assert.throws(() => setProfileGates(dir, "p", ["ai"]), (e) => e.code === "SELECTION_REJECTED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a Quality run writes its run identity (run.json) with the source it judged, so attached evidence reads as current", async () => {
  const { executeRun } = await dist("core", "run", "index.js");
  const { loadGateRecord, computeSourceIdentity, sourceMatch } = await dist("core", "gates", "index.js");
  const dir = tmp("jgates-seq-run-");
  const home = tmp("jgates-seq-home-");
  try {
    fs.writeFileSync(path.join(dir, "a.js"), "exports.a = 1;\n");
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
    const r = await executeRun({
      workspacePath: dir,
      home,
      version: "test",
      adapter: "seq-check",
      options: {},
      cache: false,
      waivers: [],
      execute: async () => ({ stages: [{ id: "seq-check", state: "completed", blockingViolations: 0 }], requirements: [{ id: "seq-check", required: true }], disabled: [], findings: [], logs: [], outputs: [] }),
    });
    const identity = loadGateRecord("run-identity", path.join(r.runDir, "run.json"));
    assert.equal(identity.gate, "quality");
    assert.equal(identity.runId, r.runId);
    assert.equal(identity.migratedFrom, undefined);
    assert.equal(identity.outcome.decision, "passed");
    assert.equal(identity.outcome.partial, false);
    assert.equal(sourceMatch(identity.source, computeSourceIdentity(dir)).same, true);
    const ev = seq.readQualityEvidence(home, r.workspace.id, r.runId);
    assert.equal(ev.identityRecorded, true);
    assert.equal(seq.assessQualityPrerequisite({ quality: ev, current: computeSourceIdentity(dir), policy: "declared-scope", semanticScope: null }).approved, true);
    fs.appendFileSync(path.join(dir, "a.js"), "exports.b = 2;\n");
    assert.equal(seq.assessQualityPrerequisite({ quality: ev, current: computeSourceIdentity(dir), policy: "declared-scope", semanticScope: null }).code, "SOURCE_CHANGED");
  } finally {
    for (const d of [dir, home]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("cancelling a sequence that waits for its advance settles it as cancelled; a settled one is not active", async () => {
  const { newSequenceId } = await dist("core", "gates", "index.js");
  const home = tmp("jgates-seq-home-");
  try {
    const id = newSequenceId();
    const dir = seq.sequenceDir(home, "ws_test", id);
    fs.mkdirSync(dir, { recursive: true });
    const record = { schemaVersion: 1, sequenceId: id, createdAt: new Date().toISOString(), selectedGates: ["quality", "semantic"], runs: [{ gate: "quality", runId: "run_20260101T000000Z_00000001" }], advancement: { condition: "quality-approved" }, status: "awaiting-advancement" };
    seq.writeSequence(dir, record, { schemaVersion: 1, sequenceId: id, workspace: { id: "ws_test", path: home }, selection: null, request: null, plans: { quality: null, semantic: null }, quality: null, assessment: null, semantic: null, coverage: null, preflight: [], timeline: [] });
    assert.equal(seq.readSequence(home, "ws_test", id).lifecycle, "waiting");
    assert.deepEqual(seq.requestSequenceCancel(home, "ws_test", id), { status: "settled", sequenceId: id });
    const after = seq.readSequence(home, "ws_test", id);
    assert.equal(after.record.status, "cancelled");
    assert.equal(after.record.reason.code, "SEQUENCE_CANCELLED");
    assert.deepEqual(after.record.runs, record.runs, "the runs stay linked with their own decisions");
    assert.equal(seq.requestSequenceCancel(home, "ws_test", id).status, "not-active");
    assert.equal(seq.requestSequenceCancel(home, "ws_test", newSequenceId()).status, "not-found");
    assert.equal(seq.listSequences(home, "ws_test").length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
