import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { FIXTURES, FINGERPRINT, fakeAuditor, load, readEvents, runAudit, setupWorkspace } from "./fixtures/cloudflare/auditor.mjs";

// V2-29: deep rigor within a small incremental scope keeps every phase. The repository's base commit has a safe users
// handler and an unrelated admin module; a later commit changes the handler to concatenate the id into SQL. A security
// run with incremental scope (base..HEAD) and deep rigor examines only the changed handler (its helper is supporting
// context), and still runs reconnaissance, coverage planning, hunting with the coverage critic, independent refutation
// and fresh verification for that region, each in its own context. A unit the planner proposes outside the region is
// recorded out of scope, never examined; no baseline means no inherited coverage, disclosed; the report presents itself
// as a partial pass.

test("V2-29: an incremental deep review shows reconnaissance, coverage planning, independent refutation and fresh verification for the scoped region", async () => {
  const { coverageId } = (await load("core/semantic-modules/index.js")).securityAudit;
  const ws = setupWorkspace("v2-29", { ...FIXTURES.clean, "src/admin.js": 'exports.stats = () => ({ users: 0 });\n' });
  try {
    const base = ws.git("rev-parse", "HEAD");
    fs.writeFileSync(`${ws.dir}/src/routes.js`, FIXTURES.vulnerable["src/routes.js"]);
    ws.git("add", "-A");
    ws.git("commit", "-q", "-m", "concatenate the id");
    const requests = [];
    const outside = { canonical_refs: { surface: "src/admin.js#stats", boundary: "none", subsystem: "src", attack_class: "ATTACK-CLASSES.md#Access control" }, status: "planned", starting_paths: ["src/admin.js"], selected_companion_blocks: [], excluded_blocks: [] };
    const events = [];
    const { plan, result, outcome, investigation, json, audit } = await runAudit(ws, {
      scope: { mode: "incremental", base },
      rigor: "deep",
      script: fakeAuditor({ coverageId, extraUnits: [outside], requests }),
      onEvent: (e) => events.push(e),
    });

    // The scoped region: only the changed handler is a subject; scope is independent of the deep rigor.
    assert.equal(plan.rigor, "deep");
    assert.equal(plan.scope.resolution.mode, "incremental");
    assert.deepEqual(plan.scope.resolution.subjects.filter((s) => s.disposition === "examine").map((s) => s.path), ["src/routes.js"]);
    assert.equal(plan.scope.resolution.inheritedCoverage.state, "none");
    assert.equal(outcome.state, "completed", JSON.stringify(outcome.reason));

    // Every phase is present for the region, each in its own context(s).
    const stages = Object.fromEntries(investigation.stages.map((s) => [s.id, s]));
    assert.deepEqual(investigation.stages.map((s) => s.id), ["reconnaissance", "coverage-planning", "hunting", "coverage-critic", "refutation", "verification"]);
    for (const s of investigation.stages) assert.equal(s.state, "completed", `${s.id}: ${s.reason ?? ""}`);
    assert.deepEqual(stages.reconnaissance.contexts.map((c) => c.label), ["reconnaissance"]);
    assert.deepEqual(stages["coverage-planning"].contexts.map((c) => c.label), ["coverage-planning"]);
    assert.deepEqual(stages.refutation.contexts.map((c) => c.label), ["refutation:C1"]);
    assert.deepEqual(stages.verification.contexts.map((c) => c.label), ["verification:C1"]);
    const labels = [...new Set(requests.map((r) => r.contextLabel))];
    assert.deepEqual(labels, ["reconnaissance", "coverage-planning", "hunting", "coverage-critic", "refutation:C1", "verification:C1"]);
    for (const label of labels) {
      const first = requests.find((r) => r.contextLabel === label);
      assert.equal(first.messages.length, 1, `${label} starts in a fresh context`);
    }
    // Reconnaissance read the region; planning received the validated reconnaissance facts.
    const recon = investigation.stages[0].contexts[0];
    assert.equal(recon.artifact.valid, true);
    assert.match(requests.find((r) => r.contextLabel === "coverage-planning").messages[0].text, /Reconnaissance facts \(host-validated/);
    // The hunter received the architecture and the verbatim attack-class block of its unit.
    const huntBrief = requests.find((r) => r.contextLabel === "hunting").messages[0].text;
    assert.match(huntBrief, /architecture\.md \(verbatim\)/);
    assert.match(huntBrief, /--- ATTACK-CLASSES\.md#Injection ---\n\*\*Injection\*\* \(subagent_type: `general`\)/);

    // Coverage planning: the region's unit was examined; the unit outside it is out of scope (host), never examined.
    const ledger = json("coverage-ledger.json");
    const inRegion = ledger.find((u) => u.attack_class === "Injection");
    assert.equal(inRegion.state, "examined");
    assert.deepEqual(inRegion.local_checks.map((k) => k.agent_id), ["hunting", "refutation-c1", "verification-c1"]);
    const admin = ledger.find((u) => u.starting_paths.includes("src/admin.js"));
    assert.equal(admin.status, "out_of_scope");
    assert.equal(admin.state, "out-of-scope");
    assert.match(admin.unresolved[0], /outside the subjects of the resolved scope/);
    assert.equal(ledger.find((u) => u.canonical_refs.attack_class === "ATTACK-CLASSES.md#Cryptography and secrets").state, "not-applicable");

    // Independent refutation and fresh verification of the candidate in the region.
    const [c] = investigation.candidates;
    assert.equal(c.status, "confirmed");
    assert.equal(c.validation.context, "refutation:C1");
    assert.equal(c.verification.context, "verification:C1");
    assert.equal(c.verification.outcome, "verified");
    const verifyBrief = requests.find((r) => r.contextLabel === "verification:C1").messages[0].text;
    assert.match(verifyBrief, /Record to verify \(decided by an independent validation you did not perform/);
    const findings = json("findings.json");
    assert.deepEqual(findings.map((f) => [f.fingerprint, f.verdict, f.verification.outcome]), [[FINGERPRINT, "confirmed", "verified"]]);

    // Honest scope and coverage: no inherited coverage, a partial pass, references re-checked.
    const meta = json("run-metadata.json");
    assert.equal(meta.profile, "deep");
    assert.equal(meta.scope.mode, "incremental");
    assert.deepEqual(meta.scope_paths, ["src/routes.js"]);
    assert.equal(meta.scope.inheritedCoverage.code, "NO_BASELINE");
    assert.equal(meta.prior_run.state, "none");
    assert.equal(meta.run_status, "complete");
    assert.equal(meta.reference_check.invalid.length, 0);
    assert.deepEqual(meta.phases.map((p) => [p.phase, p.state]), [
      ["Reconnaissance", "completed"],
      ["Coverage planning", "completed"],
      ["Hunting", "completed"],
      ["Independent refutation", "completed"],
      ["Fresh verification", "completed"],
      ["Reporting", "completed"],
    ]);
    const report = fs.readFileSync(audit("REPORT.md"), "utf8");
    assert.match(report, /Scope: incremental \(1 subject\(s\)/);
    assert.match(report, /This is a partial pass/);
    assert.match(report, /no reproduction was executed/);

    // The ordered events show each phase of the region.
    const stageEvents = readEvents(result.runDir).filter((e) => e.type === "stage" && String(e.data.stageId).startsWith("security-audit/") && e.data.state !== "running");
    assert.deepEqual(stageEvents.map((e) => `${e.data.stageId}:${e.data.state}`), [
      "security-audit/reconnaissance:completed",
      "security-audit/coverage-planning:completed",
      "security-audit/hunting:completed",
      "security-audit/coverage-critic:completed",
      "security-audit/refutation:completed",
      "security-audit/verification:completed",
    ]);
    assert.ok(events.length > 0);
  } finally {
    ws.cleanup();
  }
});
