import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { importDist, setupSequenceProject } from "./fixtures/sequence/helpers.mjs";

// V2-08: the gate selection is a setting with origins. A template, a saved profile and jgates.yml can each select the
// gates (the stronger layer wins, with its file and path as the origin); a run-only override (--gates, the API's
// `gates`) wins over all of them for that run, is reported as run-only next to the saved choice, and is never written
// anywhere. The CLI and the server interpret the same request identically.

const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("V2-08: run-only gate overrides and saved profile choices keep distinct origins with the same interpretation in CLI and API", async () => {
  const p = setupSequenceProject({ prefix: "v2-08" });
  try {
    const dry = (...more) => {
      const r = p.cli("run", "--cwd", p.dir, "--dry-run", "--json", ...more);
      assert.ok(r.doc, r.out + r.err);
      assert.equal(r.code, 0, r.out + r.err);
      return r.doc;
    };
    const { routes } = await importDist("server", "routes", "sequence.js");
    const planRoute = routes.find((x) => x.method === "POST" && x.path === "/api/sequence/plan");

    // Nothing selects gates: Quality only, from the built-in default.
    let doc = dry();
    assert.deepEqual(doc.plan.selection.gates, ["quality"]);
    assert.equal(doc.plan.selection.origin.layer, "defaults");
    const server = await p.server(doc.version);

    // A template selects both gates.
    fs.appendFileSync(path.join(p.dir, ".jgates", "templates", "seq.yml"), "  selection:\n    gates: [quality, semantic]\n");
    doc = dry();
    assert.deepEqual(doc.plan.selection.gates, ["quality", "semantic"]);
    assert.equal(doc.plan.selection.origin.layer, "template");
    assert.equal(doc.plan.selection.origin.runOnly, false);

    // The profile saves its own choice (through the profiles service): it wins over the template.
    const { setProfileGates, listProfiles } = await importDist("core", "profiles", "index.js");
    setProfileGates(p.dir, "seq", ["quality"]);
    assert.deepEqual(listProfiles(p.dir).profiles.find((x) => x.id === "seq").gates, ["quality"]);
    doc = dry();
    assert.deepEqual(doc.plan.selection.gates, ["quality"]);
    assert.deepEqual(doc.plan.selection.origin, { layer: "profile", source: "profile:seq", file: ".jgates/profiles.yml", path: "profiles.seq.gates", runOnly: false });
    assert.equal(doc.plan.semantic, null, "a Quality-only selection plans no Semantic run");

    // jgates.yml wins over the profile; removing it gives the profile back.
    const root = path.join(p.dir, "jgates.yml");
    const rootText = fs.readFileSync(root, "utf8");
    fs.writeFileSync(root, rootText.replace("  profile: seq\n", "  profile: seq\n  gates: [semantic]\n"));
    doc = dry();
    assert.deepEqual(doc.plan.selection.gates, ["semantic"]);
    assert.equal(doc.plan.selection.origin.layer, "project");
    assert.equal(doc.plan.selection.origin.file, "jgates.yml");
    fs.writeFileSync(root, rootText);

    // A run-only override: reported as such, next to the saved profile choice.
    doc = dry("--gates", "quality,semantic");
    assert.deepEqual(doc.plan.selection.gates, ["quality", "semantic"]);
    assert.deepEqual(doc.plan.selection.origin, { layer: "call", source: "--gates", file: null, path: null, runOnly: true });
    assert.deepEqual(doc.plan.selection.saved.gates, ["quality"]);
    assert.equal(doc.plan.selection.saved.origin.layer, "profile");
    assert.equal(doc.plan.advancement.condition, "quality-approved");

    // The server interprets the same requests identically.
    const apiOverride = await planRoute.handler({ body: { gates: ["quality", "semantic"] }, query: {}, params: {}, server });
    assert.deepEqual(apiOverride.json.plan.selection, doc.plan.selection);
    assert.equal(apiOverride.json.plan.quality.planHash, doc.plan.quality.planHash);
    assert.equal(apiOverride.json.plan.semantic.planHash, doc.plan.semantic.planHash);
    const apiSaved = await planRoute.handler({ body: {}, query: {}, params: {}, server });
    assert.deepEqual(apiSaved.json.plan.selection, dry().plan.selection);

    // Running with the override: a combined sequence whose details keep the run-only origin; nothing is saved.
    const profiles = path.join(p.dir, ".jgates", "profiles.yml");
    const before = { profiles: sha(profiles), root: sha(root) };
    const both = p.cli("run", "--cwd", p.dir, "--gates", "quality,semantic", "--json");
    assert.ok(both.doc, both.out + both.err);
    assert.equal(both.doc.sequence.status, "completed", both.out + both.err);
    assert.equal(both.doc.details.selection.origin.runOnly, true);
    assert.deepEqual(both.doc.details.selection.saved.gates, ["quality"]);
    assert.deepEqual({ profiles: sha(profiles), root: sha(root) }, before, "a run-only choice is never written");
    assert.equal(p.reviews(), 1);

    // Without the override the saved profile applies: a plain Quality run (the legacy result document).
    const plain = p.cli("run", "--cwd", p.dir, "--json");
    assert.ok(plain.doc, plain.out + plain.err);
    assert.match(plain.doc.runId, /^run_/);
    assert.equal(plain.doc.kind, undefined);
    assert.equal(plain.doc.decision, "passed");
    assert.equal(p.reviews(), 1, "the saved Quality-only choice never calls the provider");
  } finally {
    p.cleanup();
  }
});
