import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setupSequenceProject } from "./fixtures/sequence/helpers.mjs";

// V2-30: a combined sequence with a declared scope. The sequence reports scope completion apart from repository
// coverage for each gate and never makes a blanket claim: a fully completed Quality run that satisfies the selected
// policy for the declared scope advances, and Semantic examines only that scope. Missing required coverage (a policy
// requirement no check covers) or stale evidence (the source changed after the Quality approval) blocks the automatic
// advancement.

test("V2-30: scope completion stays apart from repository coverage; a policy-permitted complete scoped Quality run advances while missing coverage or stale evidence blocks", () => {
  const p = setupSequenceProject({ prefix: "v2-30", reviewSubjects: ["src/core/a.js"] });
  const scoped = ["run", "--cwd", p.dir, "--gates", "quality,semantic", "--scope", "paths", "--path", "src/core", "--json"];
  try {
    // A declared scope: Quality completes it, Semantic examines only src/core.
    const r = p.cli(...scoped);
    assert.ok(r.doc, r.out + r.err);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.doc.sequence.status, "completed");
    const a = r.doc.details.assessment;
    assert.equal(a.approved, true);
    assert.equal(a.policy.qualityCoverage, "declared-scope", "the default policy accepts a completed declared scope");
    // Quality: the declared scope (requested) and what actually ran (effective, with the reason) are both reported;
    // completion of that scope is a separate field from repository coverage.
    assert.equal(a.scope.requested, "paths");
    assert.deepEqual(a.scope.paths, ["src/core"]);
    assert.equal(a.scope.completion, "complete");
    assert.ok(["repository", "declared-scope"].includes(a.scope.repositoryCoverage));
    if (a.scope.effective === "full") {
      assert.equal(a.scope.repositoryCoverage, "repository");
      assert.ok(a.scope.note, "a widened Quality scope says why");
    }
    assert.equal(a.scope.coversSemantic, true);
    // Semantic: a selected scope, complete, covering only the declared scope.
    const cov = r.doc.details.coverage;
    assert.equal(cov.semantic.mode, "selected");
    assert.equal(cov.semantic.completion, "complete");
    assert.equal(cov.semantic.repositoryCoverage, "declared-scope");
    assert.equal(cov.approvedScope, "declared-scope", "the sequence approved the declared scope, not the repository");
    assert.equal(cov.blanketClaim, false);
    const semanticPlan = JSON.parse(fs.readFileSync(path.join(r.doc.semantic.runDir, "plan.json"), "utf8"));
    assert.equal(semanticPlan.scope.resolution.mode, "selected");
    const examined = semanticPlan.scope.resolution.subjects.map((s) => s.path);
    assert.ok(examined.length > 0 && examined.every((f) => f.startsWith("src/core/")), examined.join(","));
    assert.equal(p.reviews(), 1);

    // Missing required coverage: the policy requires evidence no check provides, so Quality cannot even run.
    p.write(".jgates/policy.yml", "schemaVersion: 1\nrequiredEvidence:\n  - check: capability:sast\n    locked: true\n    reason: SAST is required before any review\n");
    const missing = p.cli(...scoped);
    assert.ok(missing.doc, missing.out + missing.err);
    assert.equal(missing.doc.sequence.status, "stopped");
    assert.equal(missing.doc.sequence.reason.code, "QUALITY_COVERAGE_MISSING");
    assert.equal(missing.code, 3);
    assert.deepEqual(missing.doc.sequence.runs, []);
    assert.match(missing.doc.details.preflight[0].message, /sast/);
    assert.equal(p.reviews(), 1, "no Semantic call without the required coverage");
    fs.rmSync(path.join(p.dir, ".jgates", "policy.yml"));

    // Stale evidence: approved for the declared scope, then the source changes before the advance.
    const held = p.cli(...scoped, "--manual-advance");
    assert.equal(held.doc.sequence.status, "awaiting-advancement", held.out + held.err);
    assert.equal(held.doc.details.assessment.scope.completion, "complete");
    fs.appendFileSync(path.join(p.dir, "src", "core", "a.js"), "exports.e = () => 5;\n");
    const stale = p.cli("run", "--cwd", p.dir, "--advance", held.doc.sequenceId, "--json");
    assert.ok(stale.doc, stale.out + stale.err);
    assert.equal(stale.doc.sequence.status, "paused");
    assert.equal(stale.doc.sequence.reason.code, "SOURCE_CHANGED");
    assert.equal(stale.doc.details.assessment.freshness.state, "stale");
    assert.equal(stale.doc.details.assessment.scope.completion, "complete", "the scope was completed, the evidence is stale");
    assert.equal(stale.doc.details.coverage.approvedScope, "none");
    assert.equal(p.reviews(), 1, "stale evidence never advances");

    // A stricter saved policy (repository coverage) is read from the configuration and applied to the same request.
    const root = path.join(p.dir, "jgates.yml");
    fs.writeFileSync(root, fs.readFileSync(root, "utf8").replace("  profile: seq\n", "  profile: seq\n  sequence:\n    qualityCoverage: repository\n"));
    const strict = p.cli(...scoped);
    assert.ok(strict.doc, strict.out + strict.err);
    const sa = strict.doc.details.assessment;
    assert.equal(sa.policy.qualityCoverage, "repository");
    assert.equal(strict.doc.details.selection.policy.origin.file, "jgates.yml");
    // It advances only when the Quality run really covered the repository; otherwise it blocks with the policy reason.
    if (sa.scope.repositoryCoverage === "repository") assert.equal(strict.doc.sequence.status, "completed");
    else assert.equal(strict.doc.sequence.reason.code, "QUALITY_SCOPE_NOT_PERMITTED");
  } finally {
    p.cleanup();
  }
});
