import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { listDir, runFolders, setupSequenceProject } from "./fixtures/sequence/helpers.mjs";

// V2-13: reuse of an equivalent Quality execution in a combined sequence (--reuse-quality). A finished Quality run
// stands in for a new one only when its source, plan, settings, versions and freshness all match; the sequence then
// links that run and shows what matched (provenance). A changed source or changed settings run Quality again and say
// why the earlier run was not reused.

const FIELDS = ["source", "plan", "config", "policy", "templates", "nativeFiles", "inventory", "tools", "version", "outcome"];

test("V2-13: a Quality stage is reused only when inputs, settings, versions and freshness match, with provenance", () => {
  const p = setupSequenceProject({ prefix: "v2-13" });
  const both = ["run", "--cwd", p.dir, "--gates", "quality,semantic", "--json"];
  try {
    const first = p.cli(...both);
    assert.ok(first.doc, first.out + first.err);
    assert.equal(first.doc.sequence.status, "completed");
    const original = first.doc.sequence.runs[0].runId;
    const dirs = runFolders(p.home, first.doc.details.workspace.id);

    // Everything matches: the earlier Quality run is reused, a new Semantic run is made.
    const reused = p.cli(...both, "--reuse-quality");
    assert.ok(reused.doc, reused.out + reused.err);
    assert.equal(reused.code, 0, reused.out + reused.err);
    assert.equal(reused.doc.sequence.status, "completed");
    const [q, s] = reused.doc.sequence.runs;
    assert.equal(q.runId, original, "the equivalent Quality run is linked");
    assert.notEqual(s.runId, first.doc.sequence.runs[1].runId, "Semantic ran again as its own run");
    const reuse = reused.doc.details.quality.reuse;
    assert.equal(reuse.state, "reused");
    assert.equal(reuse.reusedFrom.runId, original);
    assert.deepEqual(reuse.reusedFrom.matches.map((m) => m.field), FIELDS);
    assert.ok(reuse.reusedFrom.matches.every((m) => m.matched && m.expected === m.found || (m.field === "outcome" && m.matched)), JSON.stringify(reuse.reusedFrom.matches));
    assert.ok(reused.doc.details.timeline.some((e) => e.event === "quality-reused" && e.runId === original));
    assert.equal(reused.doc.details.assessment.freshness.state, "current");
    assert.equal(reused.doc.semantic.semanticRun.quality.runId, original);
    assert.deepEqual(listDir(dirs.runs), [original], "no new Quality run was executed");
    assert.equal(p.reviews(), 2);

    // The source changed: no reuse, Quality runs again, and the provenance says why.
    fs.appendFileSync(path.join(p.dir, "src", "other", "b.js"), "exports.d = () => 4;\n");
    const changed = p.cli(...both, "--reuse-quality");
    assert.ok(changed.doc, changed.out + changed.err);
    assert.equal(changed.doc.sequence.status, "completed");
    const rerun = changed.doc.sequence.runs[0].runId;
    assert.notEqual(rerun, original);
    assert.equal(changed.doc.details.quality.reuse.state, "executed");
    assert.equal(changed.doc.details.quality.reuse.rejected.runId, original);
    assert.equal(changed.doc.details.quality.reuse.rejected.code, "REUSE_SOURCE_CHANGED");
    assert.equal(changed.doc.details.quality.reuse.rejected.matches.find((m) => m.field === "source").matched, false);

    // The settings changed (a check's command): no reuse either.
    const template = path.join(p.dir, ".jgates", "templates", "seq.yml");
    fs.writeFileSync(template, fs.readFileSync(template, "utf8").replace('args: ["-e", "process.exit(0)"]', 'args: ["-e", "process.exit(0)", "changed"]'));
    const settings = p.cli(...both, "--reuse-quality");
    assert.ok(settings.doc, settings.out + settings.err);
    assert.equal(settings.doc.sequence.status, "completed");
    assert.notEqual(settings.doc.sequence.runs[0].runId, rerun);
    const rejected = settings.doc.details.quality.reuse.rejected;
    assert.equal(rejected.runId, rerun);
    // The template lives in the workspace, so its edit changes the source too; every mismatch is listed.
    const miss = (field) => rejected.matches.find((m) => m.field === field).matched === false;
    assert.ok(miss("plan"), "the plan differs");
    assert.ok(miss("tools"), "the tool commands differ");
    assert.ok(miss("templates"), "the template files differ");
    assert.equal(rejected.matches.find((m) => m.field === "version").matched, true);

    // A failed run is never reused, even with everything else equal.
    p.setMode("fail");
    const failed = p.cli(...both);
    assert.equal(failed.doc.sequence.reason.code, "QUALITY_FAILED");
    p.setMode("pass");
    const afterFail = p.cli(...both, "--reuse-quality");
    assert.equal(afterFail.doc.details.quality.reuse.state, "reused", "the newest passing equivalent run is still reused");
    assert.equal(afterFail.doc.details.quality.reuse.reusedFrom.runId, settings.doc.sequence.runs[0].runId);
    assert.equal(afterFail.doc.details.quality.reuse.rejected.code, "REUSE_NOT_APPROVED");
    assert.equal(afterFail.doc.details.quality.reuse.rejected.runId, failed.doc.sequence.runs[0].runId);
  } finally {
    p.cleanup();
  }
});
