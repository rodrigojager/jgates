import assert from "node:assert/strict";
import test from "node:test";
import { load, plan, setupRepo } from "./fixtures/semantic-scope/helpers.mjs";

// V2-24: the scope controls are the same for the general review and for security, and scope is independent of rigor
// and budget. For each mode (full, selected, incremental) the plan of `jgates semantic plan` resolves the same scope
// whatever the purpose, rigor and budget; the plan itself records rigor and budget (its hash changes) while the
// resolved scope (subjects, context, units and scope hash) stays identical. The API offers the same controls for both
// purposes.

const strip = (resolution) => ({
  scopeHash: resolution.scopeHash,
  mode: resolution.mode,
  subjects: resolution.subjects.map((s) => [s.path, s.change, s.disposition]),
  context: resolution.context.map((c) => [c.path, c.relation]),
  effective: resolution.spec.units.effective.map((u) => u.id),
  allowed: resolution.spec.context.allowed.map((a) => a.value),
  expansion: resolution.spec.context.expansion,
});

test("V2-24: general review and security get the same scope controls, and rigor or budget changes leave the resolved scope unchanged", async () => {
  const p = setupRepo("v2-24");
  try {
    const base = p.head();
    p.write("src/auth/guard.js", "export function requireUser(req) {\n  if (!req.user) throw new Error(\"unauthenticated\");\n  return req.user;\n}\nexport function requireTenant(req, tenantId) {\n  const user = requireUser(req);\n  if (user.tenantId !== tenantId) throw new Error(\"forbidden\");\n  return user;\n}\n");
    p.git("commit", "-q", "-am", "simplify guard");
    const modes = {
      full: ["--scope", "full"],
      selected: ["--scope", "selected", "--path", "src/routes", "--exclude", "src/routes/health.js"],
      incremental: ["--scope", "incremental", "--base", base, "--context-max-files", "5"],
    };
    const variants = [
      ["--purpose", "general-review", "--rigor", "quick", "--budget-calls", "1"],
      ["--purpose", "general-review", "--rigor", "deep", "--budget-calls", "50", "--budget-tokens", "200000"],
      ["--purpose", "security", "--rigor", "standard", "--budget-tokens", "10"],
    ];
    for (const [mode, args] of Object.entries(modes)) {
      const plans = variants.map((v) => plan(p, ...args, ...v));
      const first = plans[0];
      assert.equal(first.scope.resolution.mode, mode);
      assert.deepEqual(first.scope.resolution.blockers, [], `${mode}: ${JSON.stringify(first.scope.resolution.blockers)}`);
      for (const other of plans.slice(1)) {
        // Same controls for every purpose, same resolved scope for every purpose, rigor and budget.
        assert.deepEqual(other.scope.controls, first.scope.controls, `${mode}: the controls differ for ${other.purpose}`);
        assert.deepEqual(strip(other.scope.resolution), strip(first.scope.resolution), `${mode}: rigor/budget/purpose changed the scope`);
      }
      // Rigor and budget are recorded in the plan (they change it), never in the scope.
      assert.deepEqual([plans[0].rigor, plans[1].rigor], ["quick", "deep"]);
      assert.deepEqual(plans[1].budget, { maxCalls: 50, maxTokens: 200000 });
      assert.notEqual(plans[0].planHash, plans[1].planHash);
      assert.deepEqual([plans[2].purpose, plans[2].methods.map((m) => m.id)], ["security", ["security-audit"]]);
      assert.deepEqual(first.scope.controls.independentOf, ["purpose", "rigor", "budget"]);
      assert.deepEqual(first.scope.controls.modes.map((m) => [m.id, m.recommended]), [["full", true], ["selected", false], ["incremental", false]]);
    }
    // The selected mode honours its exclusion; the incremental mode its context limit.
    const selected = plan(p, ...modes.selected).scope.resolution;
    assert.equal(selected.subjects.some((s) => s.path === "src/routes/health.js"), false);
    assert.ok(selected.exclusions.excluded.some((e) => e.path === "src/routes/health.js"));
    assert.equal(plan(p, ...modes.incremental).scope.resolution.policy.maxFiles, 5);

    // The API offers the same controls for both purposes.
    const { routes } = await load("server/routes/semantic-scope.js");
    const controls = routes.find((r) => r.method === "GET" && r.path === "/api/semantic/scope/controls");
    const general = await controls.handler({ query: { purpose: "general-review" } });
    const security = await controls.handler({ query: { purpose: "security" } });
    assert.deepEqual(security.json.controls, general.json.controls);
    assert.deepEqual(general.json.controls, plan(p).scope.controls);
  } finally {
    p.cleanup();
  }
});
