import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { importDist, listDir, runFolders, setupSequenceProject, waitFor } from "./fixtures/sequence/helpers.mjs";

// V2-05: a Quality run that is incomplete, reduced, invalid, cancelled, in error or timed out never advances the
// sequence: each case stops (or cancels) it with its own reason, the Semantic provider is never called, and the
// evidence produced so far stays (the Quality run folder with its result, events and logs; for an invalid
// configuration, where nothing could start, the diagnostics kept in the sequence details).

function qualityEvidence(p, r) {
  const dirs = runFolders(p.home, r.doc.details.workspace.id);
  const runId = r.doc.sequence.runs[0]?.runId;
  assert.ok(runId, "the Quality run is linked");
  const dir = path.join(dirs.runs, runId);
  const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
  assert.ok(fs.existsSync(path.join(dir, "events.jsonl")), "events are kept");
  assert.ok(fs.existsSync(path.join(dir, "run.json")), "the run identity is kept");
  assert.ok(listDir(path.join(dir, "logs")).length > 0, "logs are kept");
  return result;
}

function assertNotAdvanced(p, r, code, status = "stopped") {
  assert.ok(r.doc, r.out + r.err);
  assert.equal(r.doc.sequence.status, status, JSON.stringify(r.doc.sequence));
  assert.equal(r.doc.sequence.reason.code, code, JSON.stringify(r.doc.details.assessment?.reasons ?? r.doc.details.preflight));
  assert.ok(r.doc.sequence.runs.every((x) => x.gate === "quality"), "no Semantic run is linked");
  assert.equal(r.doc.semantic, null);
  assert.equal(p.providerCalls(), 0, `no Semantic provider call after ${code}`);
  assert.equal(r.doc.details.timeline.some((e) => e.event === "semantic-started"), false);
}

test("V2-05: incomplete, reduced, invalid, cancelled, error and timeout Quality runs never advance and keep their evidence", async () => {
  const p = setupSequenceProject({ prefix: "v2-05", timeoutSeconds: 3 });
  const both = ["run", "--cwd", p.dir, "--gates", "quality,semantic", "--json"];
  try {
    // Incomplete: an analyzed file changed while the check ran, so nothing could pass.
    p.setMode("incomplete");
    let r = p.cli(...both);
    assertNotAdvanced(p, r, "QUALITY_INCOMPLETE");
    assert.equal(r.code, 2);
    assert.equal(qualityEvidence(p, r).decision, "incomplete");

    // Reduced: a check turned off for this run only; the run passes, but it does not approve the profile.
    p.setMode("pass");
    r = p.cli(...both, "--skip", "tool:seq-extra");
    assertNotAdvanced(p, r, "QUALITY_REDUCED");
    const reduced = qualityEvidence(p, r);
    assert.equal(reduced.decision, "passed");
    assert.equal(reduced.reduced, true);
    assert.equal(r.doc.details.assessment.quality.reduced, true);

    // Error: the check left no valid evidence, so its output proves nothing.
    p.setMode("error");
    r = p.cli(...both);
    assertNotAdvanced(p, r, "QUALITY_ERROR");
    const errored = qualityEvidence(p, r);
    assert.equal(errored.stages.find((s) => s.id === "seq-check#lint").state, "error");
    assert.notEqual(errored.decision, "passed");

    // Timeout: the check ran past its time limit.
    p.setMode("timeout");
    r = p.cli(...both);
    assertNotAdvanced(p, r, "QUALITY_TIMEOUT");
    assert.equal(qualityEvidence(p, r).stages.find((s) => s.id === "seq-check#lint").state, "timeout");

    // Invalid: the configuration cannot be resolved; nothing starts and the diagnostics are kept.
    const profiles = path.join(p.dir, ".jgates", "profiles.yml");
    const saved = fs.readFileSync(profiles, "utf8");
    fs.writeFileSync(profiles, "schemaVersion: 1\nprofiles:\n  seq:\n    checks: 5\n");
    r = p.cli(...both);
    assertNotAdvanced(p, r, "QUALITY_INVALID");
    assert.equal(r.code, 3);
    assert.deepEqual(r.doc.sequence.runs, [], "no run could start");
    assert.equal(r.doc.details.preflight[0].gate, "quality");
    assert.equal(r.doc.details.preflight[0].code, "QUALITY_INVALID");
    assert.ok(Array.isArray(r.doc.details.preflight[0].details.errors) && r.doc.details.preflight[0].details.errors.length > 0, "the diagnostics are kept");
    assert.ok(fs.existsSync(path.join(r.doc.sequenceDir, "details.json")));
    fs.writeFileSync(profiles, saved);

    // Cancelled: the sequence is cancelled through the API while the Quality check runs.
    p.setMode("hang");
    const { newSequenceId } = await importDist("core", "gates", "ids.js");
    const sequenceId = newSequenceId();
    const running = p.cliAsync(...both, "--sequence-id", sequenceId);
    await waitFor(() => p.started(), 60_000, "the Quality check to start");
    const { routes } = await importDist("server", "routes", "sequence.js");
    const server = await p.server("test");
    const cancel = await routes.find((x) => x.method === "POST" && x.path === "/api/sequences/:id/cancel").handler({ params: { id: sequenceId }, query: {}, body: {}, server });
    assert.equal(cancel.status, 202);
    assert.equal(cancel.json.cancel, "requested");
    r = await running.done;
    assertNotAdvanced(p, r, "QUALITY_CANCELLED", "cancelled");
    assert.equal(r.code, 130);
    assert.equal(r.doc.sequenceId, sequenceId);
    const cancelled = qualityEvidence(p, r);
    assert.equal(cancelled.decision, "cancelled");
    const events = fs.readFileSync(path.join(runFolders(p.home, r.doc.details.workspace.id).runs, cancelled.runId, "events.jsonl"), "utf8");
    assert.match(events, /"cancel-requested"/);

    // Across every case: no Semantic run was ever created.
    assert.deepEqual(listDir(runFolders(p.home, r.doc.details.workspace.id).semantic), []);
    assert.equal(p.providerCalls(), 0);
  } finally {
    p.cleanup();
  }
});
