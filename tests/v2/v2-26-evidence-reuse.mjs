import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { APPROVED, codes, ids, load, plan, setupRepo } from "./fixtures/semantic-scope/helpers.mjs";

// V2-26: reuse of prior evidence only after current checks. A first Semantic run (full scope, fake provider) examines
// the project; the provider leaves a finding that needs validation on src/routes/users.js. Planning again with that run
// as baseline reuses the unchanged route that imports the guard while the guard is unchanged; after the guard changes,
// the same route is invalidated (its protection changed) and examined again, while a route that does not import the
// guard is still reused. The unresolved prior unit is never carried as covered, and a second run sends only what it
// examines now (reused files do not reach the provider).

const NEEDS_VALIDATION = {
  status: "APPROVED",
  score: 90,
  hardBlockers: [],
  findings: [{ severity: "suggestion", category: "security", message: "The user lookup may need a tenant check.", path: "src/routes/users.js", confirmation: "needs-validation" }],
};

test("V2-26: evidence is reused for an unchanged file only while its guard is unchanged, invalidated after the guard changes, and an unresolved prior unit is never carried", async () => {
  const p = setupRepo("v2-26", { provider: true });
  try {
    // Run 1: the whole project, with a finding that needs validation on users.js.
    p.answer(NEEDS_VALIDATION);
    const first = p.cli("semantic", "run", "--scope", "full", "--json");
    assert.ok(first.doc, first.out + first.err);
    assert.equal(first.doc.gate, "semantic");
    assert.equal(first.doc.semanticRun.outcome.state, "completed", JSON.stringify(first.doc.semanticRun.outcome));
    const run1 = first.doc.runId;
    const runDir = first.doc.runDir;
    assert.ok(first.doc.artifacts.outputs.includes("scope.json"));
    assert.ok(first.doc.artifacts.outputs.includes("evidence/scope-ledger.json"));
    const { loadGateRecord } = await load("core/gates/index.js");
    const record = loadGateRecord("scope", path.join(runDir, "scope.json"));
    assert.equal(record.mode, "full");
    assert.ok(ids(record.units.examined).includes("src/routes/orders.js"));
    const ledger = JSON.parse(fs.readFileSync(path.join(runDir, "evidence", "scope-ledger.json"), "utf8"));
    const state = Object.fromEntries(ledger.units.map((u) => [u.id, u.state]));
    assert.equal(state["src/routes/orders.js"], "clean");
    assert.equal(state["src/auth/guard.js"], "clean");
    assert.equal(state["src/routes/users.js"], "unresolved");
    assert.ok(Object.keys(ledger.units.find((u) => u.id === "src/routes/orders.js").fingerprint.dependencies).includes("src/auth/guard.js"), "the route's fingerprint covers the guard it imports");

    // Plan 2, nothing changed: the guard importer is reused; the unresolved unit is not carried and is examined again.
    const unchanged = plan(p, "--scope", "full", "--baseline", run1).scope.resolution;
    assert.deepEqual(unchanged.blockers, []);
    const reused1 = ids(unchanged.reuse.reused);
    assert.ok(reused1.includes("src/routes/orders.js"), JSON.stringify(unchanged.reuse));
    assert.ok(reused1.includes("src/auth/guard.js"));
    assert.ok(reused1.includes("src/routes/health.js"));
    assert.equal(reused1.includes("src/routes/users.js"), false, "an unresolved prior unit is never reused");
    const users1 = unchanged.reuse.notCarried.find((u) => u.id === "src/routes/users.js");
    assert.ok(users1 && codes(users1).includes("PRIOR_UNRESOLVED"), JSON.stringify(unchanged.reuse.notCarried));
    const subjects1 = new Map(unchanged.subjects.map((s) => [s.path, s]));
    assert.equal(subjects1.get("src/routes/orders.js").disposition, "reused");
    assert.equal(subjects1.get("src/routes/users.js").disposition, "examine");
    assert.ok(codes(subjects1.get("src/routes/users.js")).includes("PRIOR_UNRESOLVED_RETURNS"));
    assert.equal(unchanged.inheritedCoverage.state, "partial");
    assert.equal(unchanged.inheritedCoverage.baselineRunId, run1);
    assert.ok(unchanged.spec.units.reused.every((u) => u.evidence.runId === run1 && u.evidence.gate === "semantic"));
    assert.equal(ids(unchanged.spec.units.reused).includes("src/routes/users.js"), false);

    // The guard changes (committed): the route that imports it loses its reuse; the public route keeps it.
    p.write("src/auth/guard.js", fs.readFileSync(path.join(p.dir, "src/auth/guard.js"), "utf8").replace("if (!req.user) {", "if (!req.user || req.user.disabled) {"));
    p.git("commit", "-q", "-am", "tighten the guard");
    const changed = plan(p, "--scope", "full", "--baseline", run1).scope.resolution;
    const reused2 = ids(changed.reuse.reused);
    assert.equal(reused2.includes("src/routes/orders.js"), false, "the guard importer is no longer reused");
    assert.equal(reused2.includes("src/auth/guard.js"), false);
    assert.ok(reused2.includes("src/routes/health.js"), "a file that does not import the guard is still reused");
    const orders = changed.reuse.invalidated.find((u) => u.id === "src/routes/orders.js");
    assert.ok(orders, JSON.stringify(changed.reuse.invalidated));
    assert.ok(codes(orders).includes("PROTECTION_CHANGED"), JSON.stringify(orders));
    assert.equal(orders.reasons.find((r) => r.code === "PROTECTION_CHANGED").via, "src/auth/guard.js");
    assert.ok(codes(changed.reuse.invalidated.find((u) => u.id === "src/auth/guard.js")).includes("CONTENT_CHANGED"));
    assert.equal(new Map(changed.subjects.map((s) => [s.path, s])).get("src/routes/orders.js").disposition, "examine");
    assert.equal(reused2.includes("src/routes/users.js"), false);
    assert.ok(changed.reuse.notCarried.some((u) => u.id === "src/routes/users.js"));

    // Run 2 with the baseline: only what is examined now reaches the provider; reused files do not.
    p.answer(APPROVED);
    p.clearPrompts();
    const second = p.cli("semantic", "run", "--scope", "full", "--baseline", run1, "--json");
    assert.ok(second.doc, second.out + second.err);
    assert.equal(second.doc.semanticRun.outcome.state, "completed", JSON.stringify(second.doc.semanticRun.outcome));
    const sent = p.sentPrompts().join("\n");
    assert.ok(sent.includes("src/routes/orders.js"), "the invalidated route is sent again");
    assert.ok(sent.includes("src/auth/guard.js"));
    assert.ok(sent.includes("src/routes/users.js"), "the unresolved unit is examined again");
    assert.equal(sent.includes("src/routes/health.js"), false, "a reused file is not sent");
    const record2 = loadGateRecord("scope", path.join(second.doc.runDir, "scope.json"));
    assert.equal(record2.baselineRunId, run1);
    assert.ok(ids(record2.units.reused).includes("src/routes/health.js"));
    assert.equal(ids(record2.units.examined).includes("src/routes/health.js"), false);
    assert.ok(ids(record2.units.examined).includes("src/routes/orders.js"));
  } finally {
    p.cleanup();
  }
});
