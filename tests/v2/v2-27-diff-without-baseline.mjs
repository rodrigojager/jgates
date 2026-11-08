import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { APPROVED, ids, load, plan, setupRepo } from "./fixtures/semantic-scope/helpers.mjs";

// V2-27: an incremental (differential) run with no prior audit. The Semantic history is empty; planning an incremental
// scope from an explicit base still works, and the plan (JSON and text) discloses that the run inherits no repository
// coverage. The effective subjects are only the differential region (the changed files, including a selected
// untracked file) and the context only the allowed proposal; the run sends exactly those to the provider and its scope
// record says the same. A baseline asked for that does not exist inherits nothing either, without blocking the run.

test("V2-27: incremental plan with no prior audit inherits no coverage, says so, and examines only the differential region plus allowed context", async () => {
  const p = setupRepo("v2-27", { provider: true });
  try {
    const base = p.head();
    // One committed change to a route and one untracked new file selected as a dirty input.
    p.write("src/routes/orders.js", "import { requireTenant } from \"../auth/guard.js\";\n\nexport function listOrders(req, db) {\n  const user = requireTenant(req, req.params.tenantId);\n  return db.orders.filter((o) => o.tenantId === user.tenantId && !o.deleted);\n}\n");
    p.git("commit", "-q", "-am", "hide deleted orders");
    p.write("src/routes/export.js", "import { listOrders } from \"./orders.js\";\n\nexport function exportOrders(req, db) {\n  return JSON.stringify(listOrders(req, db));\n}\n");

    const history = p.cli("semantic", "history", "--json");
    assert.deepEqual(history.doc.runs, [], "no prior Semantic run exists");

    const planned = plan(p, "--scope", "incremental", "--base", base, "--dirty", "src/routes/export.js");
    const r = planned.scope.resolution;
    assert.deepEqual(r.blockers, [], JSON.stringify(r.blockers));
    assert.equal(planned.ready, true, JSON.stringify(planned.blockers));
    // No inherited coverage, visibly.
    assert.equal(r.inheritedCoverage.state, "none");
    assert.equal(r.inheritedCoverage.code, "NO_BASELINE");
    assert.equal(r.inheritedCoverage.units, 0);
    assert.ok(r.inheritedCoverage.message.length > 0);
    assert.equal(r.spec.baselineRunId, null);
    assert.deepEqual(r.reuse.reused, []);
    assert.equal(r.completion.claim, "scope-only");
    const text = p.cli("semantic", "plan", "--scope", "incremental", "--base", base, "--dirty", "src/routes/export.js");
    assert.equal(text.code, 0, text.err);
    assert.match(text.out, /Inherited coverage: None: no prior audit was named/);

    // The differential region: the committed change and the selected untracked file, nothing else.
    const diffRegion = ["src/routes/export.js", "src/routes/orders.js"];
    assert.deepEqual(ids(r.spec.units.effective), diffRegion);
    assert.deepEqual(r.subjects.map((s) => [s.path, s.change]).sort(), [["src/routes/export.js", "untracked"], ["src/routes/orders.js", "modified"]]);
    assert.deepEqual(r.spec.resolved.dirtyInputs.map((d) => [d.path, d.change]), [["src/routes/export.js", "untracked"]]);
    // Allowed context: only what the proposal derives (the guard the changed route imports), each with a reason.
    const allowed = r.spec.context.allowed.map((a) => a.value).sort();
    assert.deepEqual(allowed, r.context.map((c) => c.path).sort());
    assert.ok(allowed.includes("src/auth/guard.js"), JSON.stringify(r.context));
    for (const c of r.context) assert.ok(c.reasons.length > 0 && !diffRegion.includes(c.path));
    for (const unrelated of ["src/routes/health.js", "src/routes/users.js", "src/routes/reports.js", "src/util/format.js"]) {
      assert.equal(allowed.includes(unrelated), false, `${unrelated} is outside the region`);
      assert.equal(ids(r.spec.units.effective).includes(unrelated), false);
    }

    // The run sends exactly the region plus allowed context and records what it examined.
    p.answer(APPROVED);
    const run = p.cli("semantic", "run", "--scope", "incremental", "--base", base, "--dirty", "src/routes/export.js", "--json");
    assert.ok(run.doc, run.out + run.err);
    assert.equal(run.doc.decision, "passed", JSON.stringify(run.doc.semanticRun.outcome));
    const sentPaths = [...run.doc.semanticRun.outcome.context.paths].sort();
    assert.deepEqual(sentPaths, [...diffRegion, ...allowed].sort());
    const prompt = p.sentPrompts().join("\n");
    assert.equal(prompt.includes("src/routes/health.js"), false);
    const { loadGateRecord } = await load("core/gates/index.js");
    const record = loadGateRecord("scope", path.join(run.doc.runDir, "scope.json"));
    assert.equal(record.mode, "incremental");
    assert.equal(record.resolved.base.commit, base);
    assert.deepEqual(ids(record.units.examined), diffRegion);
    assert.deepEqual(record.units.reused, []);

    // A baseline that does not exist inherits nothing and does not block the differential run.
    const missing = plan(p, "--scope", "incremental", "--base", base, "--baseline", "sem_20200101T000000Z_00000000");
    assert.equal(missing.scope.resolution.inheritedCoverage.state, "none");
    assert.equal(missing.scope.resolution.inheritedCoverage.code, "BASELINE_NOT_FOUND");
    assert.deepEqual(missing.scope.resolution.blockers, []);
  } finally {
    p.cleanup();
  }
});
