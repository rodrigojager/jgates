import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { importDist, runFolders, setupSequenceProject } from "./fixtures/sequence/helpers.mjs";

// V2-07: after a combined sequence stopped on a failed Quality run, the user selects Semantic only. That is a new,
// independent selection: it runs, attaches the failed report as evidence with its original status, and neither the
// Quality result nor the stopped sequence is rewritten.

test("V2-07: Semantic only is allowed after a failed Quality run and the earlier failure is preserved", async () => {
  const p = setupSequenceProject({ prefix: "v2-07" });
  try {
    p.setMode("fail");
    const seq = p.cli("run", "--cwd", p.dir, "--gates", "quality,semantic", "--json");
    assert.ok(seq.doc, seq.out + seq.err);
    assert.equal(seq.doc.sequence.status, "stopped");
    assert.equal(seq.doc.sequence.reason.code, "QUALITY_FAILED");
    assert.equal(p.providerCalls(), 0);
    const qualityRunId = seq.doc.sequence.runs[0].runId;
    const wsId = seq.doc.details.workspace.id;
    const resultFile = path.join(runFolders(p.home, wsId).runs, qualityRunId, "result.json");
    const before = fs.readFileSync(resultFile, "utf8");

    // Semantic only, with the failed Quality report attached explicitly.
    const sem = p.cli("run", "--cwd", p.dir, "--gates", "semantic", "--quality", "latest", "--json");
    assert.ok(sem.doc, sem.out + sem.err);
    assert.equal(sem.code, 0, sem.out + sem.err);
    assert.equal(sem.doc.gate, "semantic");
    assert.match(sem.doc.runId, /^sem_/);
    assert.equal(sem.doc.decision, "passed");
    assert.equal(p.reviews(), 1, "the independent Semantic run called the provider");
    const evidence = sem.doc.semanticRun.quality;
    assert.equal(evidence.runId, qualityRunId);
    assert.equal(evidence.decision, "failed", "the attached report keeps its original status");
    assert.equal(evidence.currentApproval, false, "a failed report is never a current approval");

    // The earlier failure is preserved: the Quality result is byte-identical and the sequence still says stopped.
    assert.equal(fs.readFileSync(resultFile, "utf8"), before);
    assert.equal(JSON.parse(before).decision, "failed");
    const { readSequence } = await importDist("core", "sequence", "index.js");
    const stored = readSequence(p.home, wsId, seq.doc.sequenceId);
    assert.equal(stored.record.status, "stopped");
    assert.equal(stored.record.reason.code, "QUALITY_FAILED");
    assert.deepEqual(stored.record.runs, seq.doc.sequence.runs, "the Semantic run is not added to the stopped sequence");

    // Semantic only without any Quality report also works: no Quality history is required.
    const plain = p.cli("run", "--cwd", p.dir, "--gates", "semantic", "--json");
    assert.equal(plain.code, 0, plain.out + plain.err);
    assert.equal(plain.doc.semanticRun.quality, null);
    const qh = p.cli("history", "--cwd", p.dir, "--json");
    assert.deepEqual(qh.doc.runs.map((r) => r.runId), [qualityRunId], "no Quality run was added by Semantic-only selections");
  } finally {
    p.cleanup();
  }
});
