import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { importDist, listDir, runFolders, setupSequenceProject } from "./fixtures/sequence/helpers.mjs";

// V2-06: the source changes between the gates. A sequence that waits after its Quality approval (--manual-advance) is
// advanced after a file of the workspace changed: the prerequisite is checked again against the current source, the
// stale approval is detected and the sequence pauses (no Semantic call, the Quality result kept as recorded). A
// separately selected Semantic-only run on the new state is allowed and discloses the Quality report as stale. With an
// unchanged source the same advance needs no repeated permission and runs Semantic.

test("V2-06: a source change between the gates is detected as a stale prerequisite and pauses the sequence", async () => {
  const p = setupSequenceProject({ prefix: "v2-06" });
  try {
    const held = p.cli("run", "--cwd", p.dir, "--gates", "quality,semantic", "--manual-advance", "--json");
    assert.ok(held.doc, held.out + held.err);
    assert.equal(held.doc.sequence.status, "awaiting-advancement");
    assert.equal(held.doc.details.assessment.approved, true, "Quality was approved for the source it judged");
    assert.equal(held.code, 2, "the combined approval is not complete yet");
    const sequenceId = held.doc.sequenceId;
    const qualityRunId = held.doc.sequence.runs[0].runId;
    assert.equal(p.providerCalls(), 0);

    // A file changes between the gates.
    fs.appendFileSync(path.join(p.dir, "src", "core", "a.js"), "exports.c = () => 3;\n");
    const advanced = p.cli("run", "--cwd", p.dir, "--advance", sequenceId, "--json");
    assert.ok(advanced.doc, advanced.out + advanced.err);
    assert.equal(advanced.doc.sequence.status, "paused");
    assert.equal(advanced.doc.sequence.reason.code, "SOURCE_CHANGED");
    const a = advanced.doc.details.assessment;
    assert.equal(a.approved, false);
    assert.equal(a.freshness.state, "stale");
    assert.equal(a.freshness.code, "DIFFERENT_SOURCE");
    assert.notEqual(a.freshness.qualitySourceId, a.freshness.currentSourceId);
    assert.equal(a.quality.decision, "passed", "the Quality decision itself is kept as recorded");
    assert.equal(advanced.code, 2);
    assert.equal(advanced.doc.semantic, null);
    assert.equal(p.providerCalls(), 0, "no silent current approval: Semantic never ran");
    const dirs = runFolders(p.home, held.doc.details.workspace.id);
    assert.deepEqual(listDir(dirs.semantic), []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.runs, qualityRunId, "result.json"), "utf8")).decision, "passed");

    // A paused sequence does not advance again; it needs a fresh Quality approval.
    const again = p.cli("run", "--cwd", p.dir, "--advance", sequenceId, "--json");
    assert.equal(again.doc.code, "SEQUENCE_NOT_AWAITING");

    // A separately selected Semantic-only run on the new state is allowed; the attached report reads as stale.
    const sem = p.cli("run", "--cwd", p.dir, "--gates", "semantic", "--quality", qualityRunId, "--json");
    assert.ok(sem.doc, sem.out + sem.err);
    assert.equal(sem.code, 0, sem.out + sem.err);
    assert.equal(sem.doc.gate, "semantic");
    assert.equal(sem.doc.semanticRun.quality.runId, qualityRunId);
    assert.equal(sem.doc.semanticRun.quality.freshness, "stale");
    assert.equal(sem.doc.semanticRun.quality.currentApproval, false);
    assert.equal(p.reviews(), 1);
    const { readSequence } = await importDist("core", "sequence", "index.js");
    assert.equal(readSequence(p.home, held.doc.details.workspace.id, sequenceId).record.status, "paused", "the paused sequence is not rewritten");

    // Unchanged source: the advance runs Semantic without asking again.
    const held2 = p.cli("run", "--cwd", p.dir, "--gates", "quality,semantic", "--manual-advance", "--json");
    assert.equal(held2.doc.sequence.status, "awaiting-advancement", held2.out + held2.err);
    const go = p.cli("run", "--cwd", p.dir, "--advance", held2.doc.sequenceId, "--json");
    assert.ok(go.doc, go.out + go.err);
    assert.equal(go.doc.sequence.status, "completed");
    assert.equal(go.doc.details.assessment.freshness.state, "current");
    assert.equal(go.doc.semantic.semanticRun.quality.runId, held2.doc.sequence.runs[0].runId);
    assert.equal(go.doc.semantic.semanticRun.quality.currentApproval, true);
    assert.equal(go.code, 0);
    assert.equal(p.reviews(), 2);
  } finally {
    p.cleanup();
  }
});
