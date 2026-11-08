import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The security-audit baseline module (core/semantic-modules/cloudflare): the vendored, pinned Cloudflare material and
// its distribution record, the registration that makes purpose "security" runnable, the host checks of the ledger and
// the records, and whole runs through the real phase pipeline with a deterministic fake auditor (it decides only from
// what it reads through the host tools): a vulnerable fixture ends with a confirmed candidate and its clean twin with
// none, prior-ledger handling carries a same-source record to current verification, and a disputed verification or a
// budget that cannot fund the method is never favorable. No test spends model tokens.

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");
const VENDOR = path.join(ROOT, "jgates", "vendor", "cloudflare-security-audit");
const auditor = await import(pathToFileURL(path.join(ROOT, "tests", "v2", "fixtures", "cloudflare", "auditor.mjs")).href);
const { FIXTURES, FINGERPRINT, fakeAuditor, load, runAudit, setupWorkspace } = auditor;
const modules = await load("core/semantic-modules/index.js");
const cf = modules.securityAudit;
const distribution = await load("core/distribution/index.js");
const { buildSemanticPlan } = await load("core/semantic/index.js");

test("vendored material: pinned upstream URL, commit SHA and MIT license; the distribution check accepts the pack", () => {
  const record = JSON.parse(fs.readFileSync(path.join(VENDOR, "jgates-pack.json"), "utf8"));
  assert.equal(record.source.url, "https://github.com/cloudflare/security-audit-skill");
  assert.match(record.source.revision, /^[0-9a-f]{40}$/);
  assert.equal(record.source.revision, cf.UPSTREAM.revision, "the module and the record pin the same commit");
  assert.equal(record.spdx, "MIT");
  const license = fs.readFileSync(path.join(VENDOR, "LICENSE"), "utf8");
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2025-2026 Cloudflare, Inc\./);
  assert.match(license, /Permission is hereby granted, free of charge/);
  const notice = fs.readFileSync(path.join(VENDOR, "NOTICE.md"), "utf8");
  assert.ok(notice.includes(record.source.revision) && notice.includes(record.source.url));
  const report = distribution.checkPack(VENDOR);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(record.artifact.sha256, report.identity, "the record pins the content identity");
  // The whole vendor root as a shipping root (what `jgates tools distribution --packs vendor` checks).
  const all = distribution.checkDistribution({ roots: [path.join(ROOT, "jgates", "vendor")], manifests: [] });
  assert.equal(all.ok, true, JSON.stringify(all.problems));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "jgates", "package.json"), "utf8"));
  assert.ok(pkg.files.includes("vendor/"), "the vendored material ships with the package");
});

test("vendored blocks: every upstream ordinary class and companion section is addressable by its exact reference", () => {
  const v = cf.loadVendored();
  for (const name of ["Injection", "Access control", "Resource and file handling", "Cryptography and secrets", "Business logic", "Feature abuse and data leakage", "Chained vulnerabilities and trust boundaries", "Wildcard", "Obvious things"]) {
    assert.ok(v.blocks.has(`ATTACK-CLASSES.md#${name}`), name);
  }
  assert.equal(v.companions.length, 10);
  for (const c of v.companions) {
    assert.ok(v.blocks.has(`${c.file}#Core discipline`) && v.blocks.has(`${c.file}#Validation rules`) && v.blocks.has(`${c.file}#Universal moves`), c.file);
    assert.ok(c.whenToUse.length > 50, c.file);
  }
  assert.match(v.blocks.get("WEB-PROTOCOL-AND-AUTH.md#Ordinary CSRF").text, /^\*\*Ordinary CSRF\*\*\nA browser sends ambient credentials/);
  for (const p of Object.values(v.prompts)) assert.ok(p.length > 300);
});

test("registration: purpose security plans security-audit and is no longer blocked as unavailable", () => {
  assert.deepEqual(modules.unavailableModules, []);
  assert.ok(modules.registeredInvestigationModules().some((m) => m.methodId === "security-audit" && m.module === "security-audit"));
  const ws = setupWorkspace("cf-plan", FIXTURES.clean);
  try {
    const plan = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env, purpose: "security" });
    assert.deepEqual(plan.methods.map((m) => m.id), ["security-audit"]);
    assert.equal(plan.blockers.some((b) => b.code === "SEMANTIC_METHOD_UNAVAILABLE"), false, JSON.stringify(plan.blockers));
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
  } finally {
    ws.cleanup();
  }
});

test("ledger: coverage IDs are lossless RFC 3986 encodings; the state table is enforced", () => {
  assert.equal(cf.encodeRef("src/a.js#GET /x"), "src%2Fa.js%23GET%20%2Fx");
  assert.equal(cf.encodeRef("é~"), "%C3%A9~");
  const id = cf.coverageId({ surface: "s", boundary: "b", subsystem: "x", attack_class: "ATTACK-CLASSES.md#Injection", lifecycle: "restore" });
  assert.equal(id, "s::b::x::ATTACK-CLASSES.md%23Injection::restore");
  const unit = (over) => ({ coverage_id: "s::b::x::a", canonical_refs: { surface: "s", boundary: "b", subsystem: "x", attack_class: "a" }, status: "planned", state: "pending", agent_id: null, reviewed_paths: [], local_checks: [], result_fingerprints: [], unresolved: [], ...over });
  assert.deepEqual(cf.validateLedger([unit({})]), []);
  assert.ok(cf.validateLedger([unit({ status: "covered", state: "examined", agent_id: "hunting" })]).some((p) => /covered unit has owned evidence/.test(p)));
  assert.ok(cf.validateLedger([unit({ status: "deferred" })]).some((p) => /reason/.test(p)));
  assert.ok(cf.validateLedger([unit({}), unit({})]).some((p) => /duplicate/.test(p)));
});

test("records: verdict branches stay distinct; references must have been read; severity never exceeds impact", () => {
  const seen = new Set(["src/routes.js"]);
  const ctx = { seen, lines: () => 10 };
  const base = { fingerprint: "a:b", title: "t", description: "d", trace: [{ kind: "sink", file: "src/routes.js", line: 5, scope: "f", description: "x" }], evidence: [{ file: "src/routes.js", line: 5, description: "x" }] };
  assert.ok("record" in cf.checkRecord({ ...base, claimed_root_cause: "c", reason: "guard" }, "rejected", ctx));
  assert.ok(cf.checkRecord({ ...base, claimed_root_cause: "c", reason: "guard", severity: {} }, "rejected", ctx).problems.some((p) => /must not carry severity/.test(p)));
  assert.ok(cf.checkRecord({ ...base, claimed_root_cause: "c", impact: "i", priority: "high", blockers: [], validation_plan: {} }, "needs_validation", ctx).problems.some((p) => /blockers/.test(p)));
  const unread = cf.checkRecord({ ...base, evidence: [{ file: "src/db.js", line: 1, description: "x" }], claimed_root_cause: "c", reason: "r" }, "rejected", ctx);
  assert.ok(unread.problems.some((p) => /never read/.test(p)));
  const sev = cf.checkRecord(
    { ...base, root_cause: "r", intended_behavior: "i", impact: "i", source_argument: "s", conditions: [], remediation: { strategy: "s" }, severity: { likelihood: { score: "high", reason: "r" }, impact: { score: "low", reason: "r" }, overall_severity: "high" }, confidence: { score: "high", reason: "r" } },
    "confirmed",
    ctx,
  );
  assert.ok(sev.problems.some((p) => /cannot exceed/.test(p)));
  assert.ok(cf.checkRecord({ ...base, fingerprint: "bad fingerprint" }, "rejected", ctx).problems.some((p) => /fingerprint/.test(p)));
  const order = cf.checkRecord({ ...base, trace: [base.trace[0], base.trace[0]], claimed_root_cause: "c", reason: "r" }, "rejected", ctx);
  assert.ok(order.problems.some((p) => /begins at entrypoint/.test(p)));
});

test("vulnerable fixture ends with a confirmed candidate and its clean twin with none, through the real phase pipeline", async () => {
  for (const [name, files] of [["vulnerable", FIXTURES.vulnerable], ["clean", FIXTURES.clean]]) {
    const ws = setupWorkspace(`cf-${name}`, files);
    try {
      const requests = [];
      const { result, outcome, investigation, json, audit } = await runAudit(ws, { script: fakeAuditor({ coverageId: cf.coverageId, requests }) });
      assert.equal(outcome.state, "completed", JSON.stringify(outcome.reason));
      const stages = Object.fromEntries(investigation.stages.map((s) => [s.id, s]));
      for (const id of ["reconnaissance", "coverage-planning", "hunting", "coverage-critic"]) assert.equal(stages[id].state, "completed", `${name}: ${id}`);
      const findings = json("findings.json");
      const ledger = json("coverage-ledger.json");
      const meta = json("run-metadata.json");
      assert.equal(meta.run_status, "complete", JSON.stringify(meta));
      assert.equal(meta.upstream.revision, cf.UPSTREAM.revision);
      assert.equal(meta.ledger_validation.ok, true, JSON.stringify(meta.ledger_validation));
      const injection = ledger.find((u) => u.attack_class === "Injection");
      assert.equal(injection.state, "examined");
      assert.deepEqual(ledger.find((u) => u.canonical_refs.attack_class === "ATTACK-CLASSES.md#Cryptography and secrets").state, "not-applicable");
      if (name === "vulnerable") {
        assert.deepEqual(investigation.candidates.map((c) => [c.status, c.confirmation]), [["confirmed", "confirmed"]]);
        const [c] = investigation.candidates;
        assert.equal(c.severity, "blocking", "a high overall severity is a blocking JGates finding");
        assert.equal(c.verification.outcome, "verified");
        assert.equal(findings.length, 1);
        assert.equal(findings[0].verdict, "confirmed");
        assert.equal(findings[0].fingerprint, FINGERPRINT);
        assert.equal(findings[0].evidence_basis, "source-argument");
        assert.ok(findings[0].evidence.some((e) => e.file === "src/db.js"), "the refuter's own evidence, from the helper it read");
        assert.equal(injection.status, "candidate");
        assert.deepEqual(injection.result_fingerprints, [FINGERPRINT]);
        assert.deepEqual(injection.local_checks.map((k) => k.agent_id), ["hunting", "refutation-c1", "verification-c1"]);
        assert.equal(outcome.conclusion.status, "REJECTED");
        assert.equal(result.findings.length, 1);
        assert.equal(stages.refutation.contexts.length, 1);
        assert.equal(stages.verification.contexts.length, 1);
        // Independent contexts: the refuter and the verifier never see the hunter's conversation.
        const refute = requests.filter((r) => r.contextLabel === "refutation:C1");
        assert.equal(refute[0].messages.length, 1);
        assert.equal(JSON.stringify(refute[0].messages).includes("One injection candidate."), false);
        assert.match(fs.readFileSync(audit("REPORT.md"), "utf8"), /SQL injection in GET \/users/);
        assert.match(fs.readFileSync(audit("agent-context.md"), "utf8"), /<<<JGATES-DATA[\s\S]*sqli:src\/routes\.js:getUser[\s\S]*JGATES-DATA>>>/);
      } else {
        assert.deepEqual(investigation.candidates, []);
        assert.deepEqual(findings, []);
        assert.equal(injection.status, "covered");
        assert.equal(outcome.conclusion.status, "APPROVED");
        assert.deepEqual(result.findings, []);
        assert.equal(stages.refutation.reason, "no candidate to validate");
      }
      for (const f of ["run-metadata.json", "architecture.md", "coverage-ledger.json", "findings.json", "REPORT.md", "FINDINGS-DETAIL.md", "NEEDS-VALIDATION.md", "agent-context.md"]) {
        assert.ok(result.artifacts.outputs.includes(`evidence/security-audit/${f}`), f);
      }
    } finally {
      ws.cleanup();
    }
  }
});

test("prior ledger: a same-source confirmed record is carried to current refutation and verification; changed source returns as current work", async () => {
  const ws = setupWorkspace("cf-prior", FIXTURES.vulnerable);
  try {
    const first = await runAudit(ws, { script: fakeAuditor({ coverageId: cf.coverageId }) });
    assert.equal(first.json("findings.json")[0].verdict, "confirmed");
    const firstId = first.result.runId;

    // Unchanged source: the record is carried, the hunter may not re-report it, a fresh refuter re-checks it.
    const second = await runAudit(ws, { scope: { mode: "full", baseline: firstId }, script: fakeAuditor({ coverageId: cf.coverageId }) });
    assert.equal(second.outcome.state, "completed", JSON.stringify(second.outcome.reason));
    const meta = second.json("run-metadata.json");
    assert.equal(meta.prior_run.state, "read");
    assert.equal(meta.prior_run.baselineRunId, firstId);
    const [carried] = second.investigation.candidates;
    assert.equal(second.investigation.candidates.length, 1);
    assert.equal(carried.details.reported_by, `prior:${firstId}`);
    assert.equal(carried.details.carried.verdict, "confirmed");
    assert.equal(carried.status, "confirmed");
    assert.equal(carried.validation.context, "refutation:C1", "the carried record went through current refutation");
    assert.equal(carried.verification.outcome, "verified");
    const hunt = second.investigation.stages.find((s) => s.id === "hunting").contexts[0];
    assert.ok(hunt.artifact.problems.some((p) => /carried or unchanged prior record/.test(p)), JSON.stringify(hunt.artifact.problems));
    const unit = second.json("coverage-ledger.json").find((u) => u.attack_class === "Injection");
    assert.equal(unit.prior_status, "prior_confirmed_same_source");
    assert.equal(unit.status, "candidate");
    assert.equal(unit.agent_id, "refutation-c1", "the verifier that re-checks a carried record owns its unit");
    assert.equal(second.json("findings.json")[0].carried.baselineRunId, firstId);
    const planBrief = second.investigation.stages.find((s) => s.id === "coverage-planning");
    assert.equal(planBrief.state, "completed");

    // Changed source: nothing is carried; the unit returns as current work and the hunter finds the root cause again.
    fs.writeFileSync(path.join(ws.dir, "src", "routes.js"), `// users routes\n${FIXTURES.vulnerable["src/routes.js"]}`);
    ws.git("commit", "-qam", "comment");
    const third = await runAudit(ws, { scope: { mode: "full", baseline: second.result.runId }, script: fakeAuditor({ coverageId: cf.coverageId }) });
    assert.equal(third.outcome.state, "completed", JSON.stringify(third.outcome.reason));
    const [again] = third.investigation.candidates;
    assert.equal(again.details.carried, undefined);
    assert.equal(again.details.reported_by, "hunting");
    assert.equal(third.json("coverage-ledger.json").find((u) => u.attack_class === "Injection").prior_status, "prior_confirmed_changed_source");
  } finally {
    ws.cleanup();
  }
});

test("fresh verification: a rejection of a confirmed record is not applied; the record stays unresolved and the run is incomplete", async () => {
  const ws = setupWorkspace("cf-dispute", FIXTURES.vulnerable);
  try {
    const base = fakeAuditor({ coverageId: cf.coverageId });
    const script = (request) => {
      const turn = request.messages.filter((m) => m.role === "assistant").length;
      if (request.contextLabel.startsWith("verification") && turn === 1) {
        return {
          text: JSON.stringify({
            decision: "replace",
            reason: "I think the driver escapes it.",
            record: { verdict: "rejected", fingerprint: FINGERPRINT, title: "SQL injection in GET /users", description: "d", claimed_root_cause: "c", trace: [{ kind: "sink", file: "src/db.js", line: 4, scope: "raw", description: "x" }], evidence: [{ file: "src/db.js", line: 4, description: "x" }], reason: "escaped" },
          }),
        };
      }
      return base(request);
    };
    const { outcome, investigation, json } = await runAudit(ws, { script });
    const [c] = investigation.candidates;
    assert.equal(c.verification.outcome, "disputed");
    assert.equal(c.status, "unresolved");
    assert.match(c.reason, /disputed the confirmed record/);
    assert.equal(outcome.state, "budget-exhausted", "incomplete, never favorable");
    assert.equal(outcome.conclusion.status, "INCOMPLETE");
    const meta = json("run-metadata.json");
    assert.equal(meta.run_status, "incomplete");
    assert.equal(meta.incomplete_reason, "verification_disputed_needs_further_independent_verification");
    assert.deepEqual(json("findings.json"), [], "an unvalidated record never enters findings.json");
    assert.deepEqual(meta.unvalidated.map((u) => u.fingerprint), [FINGERPRINT]);
  } finally {
    ws.cleanup();
  }
});

test("budget gate: limits that cannot fund reconnaissance and the reserves launch no context and end incomplete", async () => {
  const ws = setupWorkspace("cf-budget", FIXTURES.vulnerable);
  try {
    const requests = [];
    const { outcome, investigation, json } = await runAudit(ws, { budget: { maxCalls: 3 }, script: fakeAuditor({ coverageId: cf.coverageId, requests }) });
    assert.deepEqual(requests, [], "no model call was sent");
    assert.equal(outcome.state, "budget-exhausted");
    assert.ok(investigation.stages.every((s) => s.state === "budget-exhausted"));
    assert.match(investigation.budget.exhausted.message, /cannot fund the security-audit minimum/);
    assert.equal(json("run-metadata.json").incomplete_reason, "budget_cannot_fund_reconnaissance_and_reserves");
  } finally {
    ws.cleanup();
  }
});

test("invalid output: a reconnaissance answer that is not the JSON artifact makes the run invalid, never favorable", async () => {
  const ws = setupWorkspace("cf-invalid", FIXTURES.clean);
  try {
    const base = fakeAuditor({ coverageId: cf.coverageId });
    const script = (request) => (request.contextLabel === "reconnaissance" ? { text: "Looks fine to me." } : base(request));
    const { result, outcome } = await runAudit(ws, { script });
    assert.equal(outcome.state, "invalid");
    assert.equal(result.decision, "invalid");
    assert.equal(outcome.conclusion.status, "INVALID");
  } finally {
    ws.cleanup();
  }
});
