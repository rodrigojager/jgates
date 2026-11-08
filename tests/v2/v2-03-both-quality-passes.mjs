import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { importDist, listDir, runFolders, setupSequenceProject } from "./fixtures/sequence/helpers.mjs";

// V2-03: both gates selected and the Quality run passes. `jgates run --gates quality,semantic` creates a Quality run
// (run_...) and then, because the core decision approved it for the current source, a separate Semantic run (sem_...).
// A sequence record links the two runs in order; the transition is visible in its timeline; each run keeps its own
// result, folder and history, and the Semantic run carries the Quality report as current evidence.

test("V2-03: both gates with a passing Quality run give two distinct runs linked by a sequence", async () => {
  const p = setupSequenceProject({ prefix: "v2-03" });
  try {
    const r = p.cli("run", "--cwd", p.dir, "--gates", "quality,semantic", "--json");
    assert.ok(r.doc, r.out + r.err);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.doc.kind, "jgates-sequence");
    const seq = r.doc.sequence;
    assert.match(seq.sequenceId, /^seq_/);
    assert.equal(seq.status, "completed");
    assert.deepEqual(seq.selectedGates, ["quality", "semantic"]);
    assert.equal(seq.advancement.condition, "quality-approved");

    // Distinct IDs in disjoint namespaces, linked in execution order.
    assert.equal(seq.runs.length, 2);
    const [qRef, sRef] = seq.runs;
    assert.equal(qRef.gate, "quality");
    assert.match(qRef.runId, /^run_/);
    assert.equal(sRef.gate, "semantic");
    assert.match(sRef.runId, /^sem_/);
    assert.notEqual(qRef.runId, sRef.runId);
    assert.equal(r.doc.quality.runId, qRef.runId);
    assert.equal(r.doc.semantic.runId, sRef.runId);
    assert.equal(p.reviews(), 1, "Semantic called the provider once, after Quality");

    // The visible transition: Quality finished, the assessment approved it, then Semantic started and finished.
    const events = r.doc.details.timeline.map((e) => e.event);
    const order = ["created", "quality-started", "quality-finished", "semantic-started", "semantic-finished"].map((e) => events.indexOf(e));
    assert.ok(order.every((i) => i >= 0), events.join(","));
    assert.deepEqual([...order].sort((a, b) => a - b), order, "the transition happens in order");
    assert.equal(r.doc.details.timeline.find((e) => e.event === "semantic-started").status, "advanced");
    const a = r.doc.details.assessment;
    assert.equal(a.approved, true);
    assert.equal(a.code, "QUALITY_APPROVED");
    assert.equal(a.quality.decision, "passed");
    assert.equal(a.quality.complete, true);
    assert.equal(a.quality.reduced, false);
    assert.equal(a.freshness.state, "current");
    assert.equal(a.freshness.recorded, "run-identity", "the Quality run recorded its own source identity");

    // The sequence record on disk is a valid gate record with the same links; the API shows the same.
    const { loadGateRecord } = await importDist("core", "gates", "index.js");
    const stored = loadGateRecord("sequence", path.join(r.doc.sequenceDir, "sequence.json"));
    assert.deepEqual(stored.runs, seq.runs);
    const { routes } = await importDist("server", "routes", "sequence.js");
    const server = await p.server(r.doc.version);
    const one = await routes.find((x) => x.method === "GET" && x.path === "/api/sequences/:id").handler({ params: { id: seq.sequenceId }, query: {}, server });
    assert.deepEqual(one.json.sequence.record.runs, seq.runs);
    assert.equal(one.json.sequence.record.status, "completed");
    assert.equal(one.json.sequence.lifecycle, "settled");

    // Separate results: each run in its own folder, with its own decision; Semantic never rewrote Quality.
    const wsId = r.doc.details.workspace.id;
    const dirs = runFolders(p.home, wsId);
    const qResult = JSON.parse(fs.readFileSync(path.join(dirs.runs, qRef.runId, "result.json"), "utf8"));
    assert.equal(qResult.decision, "passed");
    assert.notEqual(qResult.gate, "semantic");
    assert.equal(qResult.semanticRun, undefined);
    assert.equal(qResult.semantic, undefined);
    const qIdentity = loadGateRecord("run-identity", path.join(dirs.runs, qRef.runId, "run.json"));
    assert.equal(qIdentity.gate, "quality");
    assert.equal(qIdentity.runId, qRef.runId);
    const sResult = JSON.parse(fs.readFileSync(path.join(dirs.semantic, sRef.runId, "result.json"), "utf8"));
    assert.equal(sResult.gate, "semantic");
    assert.equal(sResult.decision, "passed");
    assert.equal(sResult.semanticRun.quality.runId, qRef.runId);
    assert.equal(sResult.semanticRun.quality.freshness, "current");
    assert.equal(sResult.semanticRun.quality.currentApproval, true);
    assert.equal(sResult.semanticRun.source.id, qIdentity.source.id, "both runs judged the same source");
    assert.deepEqual(listDir(dirs.runs), [qRef.runId]);
    assert.deepEqual(listDir(dirs.semantic), [sRef.runId]);

    // Separate histories.
    const qh = p.cli("history", "--cwd", p.dir, "--json");
    assert.deepEqual(qh.doc.runs.map((x) => x.runId), [qRef.runId]);
    const sh = p.cli("semantic", "history", "--cwd", p.dir, "--json");
    assert.deepEqual(sh.doc.runs.map((x) => x.runId), [sRef.runId]);
  } finally {
    p.cleanup();
  }
});
