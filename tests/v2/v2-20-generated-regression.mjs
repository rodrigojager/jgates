// V2-20: a generated regression is incorporated. Property reasoning (run from the CLI with the scripted mock provider)
// proposes a property test for a violated pagination bound; the proposal stays out of the project, its Quality plan and
// JGates' shipped packs until the explicit `jgates regressions incorporate <run>/<id> --approve` (which first validates
// it in the sandbox). Later Quality runs execute it as a deterministic check with no provider call: it fails on the bad
// fixture and passes once the code is corrected.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PAGINATE_BAD, PAGINATE_GOOD, PROPERTY_TEST, PROPERTY_TEST_NAME, ROOT, cliFor, propertyScript, readJson, semanticRuns, setupWorkspace, treeHash } from "./fixtures/complementary-b/helpers.mjs";

const SHIPPED = [path.join(ROOT, "jgates", "packs"), path.join(ROOT, "jgates", "src", "builtin", "templates")];

test("V2-20: a property test proposed by a Semantic method becomes a Quality regression only by explicit approval, and later Quality runs execute it with no provider call, failing on the bad fixture and passing on the corrected one", () => {
  // A Quality-valid project (schemaVersion, a project profile that selects unit checks) whose semantic provider is the scripted mock.
  const profiles = ["schemaVersion: 1", "profiles:", "  reg:", "    label: Regressions", "    checks:", '      "capability:unit": { enabled: true }', '      "tool:quality-bridge": { enabled: false }', ""].join("\n");
  const ws = setupWorkspace("v2-20", { "src/paginate.js": PAGINATE_BAD, ".jgates/profiles.yml": profiles }, { extra: ["schemaVersion: 1", "selection:", "  profile: reg"] });
  const cli = cliFor(ws);
  const shippedBefore = SHIPPED.map(treeHash);
  try {
    // 1. The Semantic run (property reasoning, selected explicitly) confirms the violated bound and proposes its test.
    const projectBefore = treeHash(ws.dir);
    const sem = cli(["semantic", "run", "--cwd", ws.dir, "--method", "property-reasoning", "--json"], { script: propertyScript(["src/paginate.js", "jgates.yml"]) });
    assert.ok(sem.doc, sem.out + sem.err);
    const outcome = sem.doc.semanticRun.outcome;
    assert.equal(outcome.investigation.module.id, "property-reasoning");
    assert.equal(outcome.investigation.candidates[0].status, "confirmed");
    assert.ok(outcome.calls > 0, "the proposal came from the model");
    assert.equal(treeHash(ws.dir), projectBefore, "the Semantic run wrote nothing in the project");

    // 2. The proposal exists only as run evidence: no Quality plan includes it.
    const listed = cli(["regressions", "list", "--cwd", ws.dir, "--json"]);
    assert.equal(listed.code, 0, listed.err);
    assert.equal(listed.doc.proposals.length, 1);
    const proposal = listed.doc.proposals[0];
    assert.equal(proposal.ref, `${sem.doc.runId}/P1`);
    assert.equal(proposal.file, PROPERTY_TEST_NAME);
    assert.equal(proposal.incorporated, null);
    const planBefore = cli(["plan", "--cwd", ws.dir, "--json"]);
    assert.ok(planBefore.doc, planBefore.out + planBefore.err);
    const items = (doc) => [...doc.plan.groups.willRun, ...doc.plan.groups.notApplicableOrDisabled];
    assert.ok(!items(planBefore.doc).some((i) => String(i.tool ?? i.id).startsWith("regression-")), "no regression check before incorporation");

    // 3. Without the explicit approval nothing is executed or written.
    const refused = cli(["regressions", "incorporate", proposal.ref, "--cwd", ws.dir, "--json"]);
    assert.equal(refused.code, 3);
    assert.equal(refused.doc.error.code, "APPROVAL_REQUIRED");
    assert.equal(treeHash(ws.dir), projectBefore);

    // 4. With it: a fresh sandboxed validation (it fails on the bad source: it shows the defect), then the files.
    const incorporated = cli(["regressions", "incorporate", proposal.ref, "--approve", "--cwd", ws.dir, "--json"]);
    assert.equal(incorporated.code, 0, incorporated.out + incorporated.err);
    const reg = incorporated.doc.incorporated;
    assert.equal(incorporated.doc.validation.run.outcome, "failed");
    assert.equal(incorporated.doc.validation.detectsDefect, true);
    assert.deepEqual(incorporated.doc.files.sort(), [".jgates/regressions/evidence.schema.json", ".jgates/regressions/manifest.json", `.jgates/regressions/${PROPERTY_TEST_NAME}`, ".jgates/regressions/run.mjs", ".jgates/templates/jgates-regressions.yml", "jgates.yml"].sort());
    assert.equal(fs.readFileSync(path.join(ws.dir, ".jgates", "regressions", PROPERTY_TEST_NAME), "utf8"), PROPERTY_TEST);
    const manifest = readJson(path.join(ws.dir, ".jgates", "regressions", "manifest.json"));
    assert.deepEqual(manifest.regressions[0].origin, { runId: sem.doc.runId, method: "property-reasoning", stage: "invariants", candidate: "C1", candidateStatus: "confirmed", invariant: "I1", proposal: "P1" });
    assert.equal(manifest.regressions[0].approval.explicit, true);
    const planAfter = cli(["plan", "--cwd", ws.dir, "--json"]);
    const item = items(planAfter.doc).find((i) => i.tool === reg.tool);
    assert.ok(item, JSON.stringify(items(planAfter.doc).map((i) => i.id)));
    assert.equal(item.adapter, "generic-command");
    assert.ok(item.limitations.some((l) => l.includes(sem.doc.runId) && /without any model call/.test(l)), "the plan shows its provenance");

    // 5. Later Quality runs: any provider call would fail (the scripted model is gone), and none happens.
    const semanticBefore = semanticRuns(ws.home);
    const noModel = { SEMANTIC_GATE_MOCK_TOOL_SCRIPT: path.join(ws.root, "no-script-any-call-fails.json") };
    const bad = cli(["run", "--cwd", ws.dir, "--only", `tool:${reg.tool}`, "--no-interactive", "--json"], { env: noModel });
    assert.ok(bad.doc, bad.out + bad.err);
    assert.equal(bad.code, 1, bad.out + bad.err);
    assert.equal(bad.doc.decision, "failed");
    const badStage = bad.doc.stages.find((s) => s.id === `${reg.tool}#unit`);
    assert.equal(badStage.state, "completed");
    assert.equal(badStage.blockingViolations, 1);
    const badEvidence = readJson(path.join(bad.doc.runDir, "outputs", "generic-command", reg.tool, "evidence.json"));
    assert.equal(badEvidence.ok, false);
    assert.equal(badEvidence.modelCalls, 0);
    assert.equal(badEvidence.sha256Matches, true);
    assert.equal(badEvidence.tests.fail > 0, true);
    assert.equal(badEvidence.provenance.runId, sem.doc.runId);

    fs.writeFileSync(path.join(ws.dir, "src", "paginate.js"), PAGINATE_GOOD);
    const good = cli(["run", "--cwd", ws.dir, "--only", `tool:${reg.tool}`, "--no-interactive", "--json"], { env: noModel });
    assert.equal(good.code, 0, good.out + good.err);
    assert.equal(good.doc.decision, "passed");
    const goodEvidence = readJson(path.join(good.doc.runDir, "outputs", "generic-command", reg.tool, "evidence.json"));
    assert.deepEqual([goodEvidence.ok, goodEvidence.modelCalls, goodEvidence.tests.fail], [true, 0, 0]);
    for (const doc of [bad.doc, good.doc]) assert.ok(!doc.semantic || doc.semantic.requested !== true, "the Quality run requested no model review");
    assert.deepEqual(semanticRuns(ws.home), semanticBefore, "no Semantic run, no provider call during the Quality runs");

    // 6. Shipped packs and built-in templates never receive a proposal.
    assert.deepEqual(SHIPPED.map(treeHash), shippedBefore);
  } finally {
    ws.cleanup();
  }
});
