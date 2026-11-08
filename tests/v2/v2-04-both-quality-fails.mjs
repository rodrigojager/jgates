import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { importDist, listDir, runFolders, setupSequenceProject } from "./fixtures/sequence/helpers.mjs";

// V2-04: both gates selected and the Quality run fails. The sequence stops with the Quality failure as its reason;
// the Semantic provider is never invoked and no Semantic run exists; the Quality run keeps its actual failure.

test("V2-04: both gates with a failing Quality run stop the sequence with zero Semantic provider calls", async () => {
  const p = setupSequenceProject({ prefix: "v2-04" });
  try {
    p.setMode("fail");
    const r = p.cli("run", "--cwd", p.dir, "--gates", "quality,semantic", "--json");
    assert.ok(r.doc, r.out + r.err);
    assert.equal(r.code, 1, "the exit code is the Quality failure's");
    const seq = r.doc.sequence;
    assert.equal(seq.status, "stopped");
    assert.equal(seq.reason.code, "QUALITY_FAILED");
    assert.equal(seq.runs.length, 1, "only the Quality run is linked");
    assert.equal(seq.runs[0].gate, "quality");
    assert.equal(r.doc.semantic, null);
    assert.equal(p.providerCalls(), 0, "the Semantic provider was never invoked");

    // The actual failure is shown: the Quality decision as recorded, its blocking violation and the reason.
    const a = r.doc.details.assessment;
    assert.equal(a.approved, false);
    assert.equal(a.status, "stopped");
    assert.equal(a.quality.decision, "failed");
    assert.equal(a.reasons[0].code, "QUALITY_FAILED");
    assert.match(a.reasons[0].message, new RegExp(seq.runs[0].runId));
    assert.equal(r.doc.quality.decision, "failed");
    assert.equal(r.doc.quality.blockingViolations, 1);
    assert.equal(r.doc.details.timeline.some((e) => e.event === "semantic-started"), false);

    // No Semantic run anywhere; the Quality result on disk still says failed.
    const dirs = runFolders(p.home, r.doc.details.workspace.id);
    assert.deepEqual(listDir(dirs.semantic), []);
    const stored = JSON.parse(fs.readFileSync(path.join(dirs.runs, seq.runs[0].runId, "result.json"), "utf8"));
    assert.equal(stored.decision, "failed");
    assert.equal(stored.exitCode, 1);
    const sh = p.cli("semantic", "history", "--cwd", p.dir, "--json");
    assert.deepEqual(sh.doc.runs, []);

    // The server shows the stopped sequence with its reason.
    const { routes } = await importDist("server", "routes", "sequence.js");
    const server = await p.server(r.doc.version);
    const one = await routes.find((x) => x.method === "GET" && x.path === "/api/sequences/:id").handler({ params: { id: seq.sequenceId }, query: {}, server });
    assert.equal(one.json.sequence.record.status, "stopped");
    assert.equal(one.json.sequence.record.reason.code, "QUALITY_FAILED");
  } finally {
    p.cleanup();
  }
});
