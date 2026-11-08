import assert from "node:assert/strict";
import test from "node:test";
import { codes, ids, load, plan, setupRepo } from "./fixtures/semantic-scope/helpers.mjs";

// V2-25: the impact/context preview of an incremental scope. In a temporary Git repository the shared auth guard
// changes, a legacy helper is deleted and a utility is renamed (its importer is left pointing at the old path). The
// preview of `jgates semantic plan --scope incremental --base <base>` and of the API (POST /api/semantic/scope/preview)
// lists the unchanged routes that import the guard as supporting context with reasons, keeps them apart from the
// review subjects, includes the renamed and the deleted file, and records an unknown for the plugin loader's dynamic
// import (it may load changed code the proposal cannot see).

test("V2-25: impact preview lists unchanged guard importers as context with reasons, renamed and deleted files, and a dynamic import as unknown", async () => {
  const p = setupRepo("v2-25");
  try {
    const base = p.head();
    p.write("src/auth/guard.js", `${"// tightened: tenant check also requires an active user\n"}export function requireUser(req) {\n  if (!req.user || req.user.disabled) {\n    const error = new Error("unauthenticated");\n    error.status = 401;\n    throw error;\n  }\n  return req.user;\n}\n\nexport function requireTenant(req, tenantId) {\n  const user = requireUser(req);\n  if (user.tenantId !== tenantId) {\n    const error = new Error("forbidden");\n    error.status = 403;\n    throw error;\n  }\n  return user;\n}\n`);
    p.git("rm", "-q", "src/legacy/old-helper.js");
    p.git("mv", "src/util/format.js", "src/util/formatting.js");
    p.git("add", "-A");
    p.git("commit", "-q", "-m", "change guard, delete helper, rename util");

    const planned = plan(p, "--scope", "incremental", "--base", base);
    const r = planned.scope.resolution;
    assert.equal(r.mode, "incremental");
    assert.deepEqual(r.blockers, [], JSON.stringify(r.blockers));
    assert.equal(r.spec.resolved.base.commit, base);
    assert.equal(r.spec.resolved.target.commit, p.head());

    // Subjects: exactly the changes, the renamed one with its previous path and the deleted one.
    const subjects = new Map(r.subjects.map((s) => [s.path, s]));
    assert.deepEqual([...subjects.keys()].sort(), ["src/auth/guard.js", "src/legacy/old-helper.js", "src/util/formatting.js"]);
    assert.equal(subjects.get("src/auth/guard.js").change, "modified");
    assert.ok(subjects.get("src/auth/guard.js").categories.includes("shared-guard"));
    assert.equal(subjects.get("src/util/formatting.js").change, "renamed");
    assert.equal(subjects.get("src/util/formatting.js").previousPath, "src/util/format.js");
    assert.equal(subjects.get("src/legacy/old-helper.js").change, "removed");
    const changes = new Map(r.impact.changes.map((c) => [c.path, c]));
    assert.equal(changes.get("src/util/formatting.js").previousPath, "src/util/format.js");
    assert.equal(changes.get("src/legacy/old-helper.js").change, "removed");

    // Context: the unchanged routes importing the guard, with the reason and the file it goes through.
    const context = new Map(r.context.map((c) => [c.path, c]));
    for (const route of ["src/routes/orders.js", "src/routes/users.js"]) {
      const entry = context.get(route);
      assert.ok(entry, `${route} is proposed as context: ${JSON.stringify(r.context)}`);
      assert.equal(entry.relation, "importer");
      assert.ok(codes(entry).includes("IMPORTS_CHANGED_GUARD"), JSON.stringify(entry));
      assert.equal(entry.reasons.find((x) => x.code === "IMPORTS_CHANGED_GUARD").via, "src/auth/guard.js");
      assert.ok(entry.reasons.every((x) => typeof x.message === "string" && x.message.length > 0));
      assert.equal(subjects.has(route), false, "supporting context is not a review subject");
    }
    // The importer of the deleted and renamed files is context, with both reasons.
    const reports = context.get("src/routes/reports.js");
    assert.ok(reports, JSON.stringify(r.context));
    assert.ok(codes(reports).includes("IMPORTS_REMOVED"), JSON.stringify(reports));
    assert.ok(codes(reports).includes("IMPORTS_RENAMED_OLD_PATH"), JSON.stringify(reports));
    // A public route that imports nothing changed is neither subject nor context.
    assert.equal(context.has("src/routes/health.js"), false);
    assert.equal(subjects.has("src/routes/health.js"), false);

    // The dynamic import is an unknown, and the map never claims to be exhaustive.
    const dynamic = r.impact.unknowns.find((u) => u.code === "DYNAMIC_IMPORT" && u.path === "src/plugins/loader.js");
    assert.ok(dynamic, JSON.stringify(r.impact.unknowns));
    assert.ok(dynamic.message.length > 0);
    assert.equal(r.impact.extractor.exhaustive, false);

    // The gate record keeps subjects and context apart.
    assert.deepEqual(ids(r.spec.units.effective), ["src/auth/guard.js", "src/legacy/old-helper.js", "src/util/formatting.js"]);
    assert.deepEqual(r.spec.context.allowed.map((a) => a.value).sort(), [...context.keys()].sort());
    const { validateGateRecord } = await load("core/gates/index.js");
    assert.deepEqual(validateGateRecord("scope", r.spec), []);

    // The API preview drives the same service and resolves the same scope.
    const { routes } = await load("server/routes/semantic-scope.js");
    const { workspaceId } = await load("core/ids/index.js");
    const preview = routes.find((x) => x.method === "POST" && x.path === "/api/semantic/scope/preview");
    const previous = process.env.JGATES_HOME;
    process.env.JGATES_HOME = p.home;
    try {
      const server = { home: p.home, policyMode: false, workspace: { id: workspaceId(p.dir), path: p.dir, name: "v2-25" }, log: () => undefined };
      const answer = await preview.handler({ body: { scope: { mode: "incremental", base } }, server });
      assert.equal(answer.status, 200);
      assert.equal(answer.json.resolution.scopeHash, r.scopeHash);
      assert.deepEqual(
        answer.json.resolution.context.map((c) => ({ path: c.path, relation: c.relation, codes: codes(c) })),
        r.context.map((c) => ({ path: c.path, relation: c.relation, codes: codes(c) })),
      );
    } finally {
      if (previous === undefined) delete process.env.JGATES_HOME;
      else process.env.JGATES_HOME = previous;
    }
  } finally {
    p.cleanup();
  }
});
