import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { FIXTURES, FINGERPRINT, fakeAuditor, load, runAudit, setupWorkspace } from "./fixtures/cloudflare/auditor.mjs";

// V2-11: the independent validator finds the guard. A Semantic security run (method security-audit, the Cloudflare
// baseline module) audits a handler whose SQL looks interpolated: `run(sql\`... ${req.query.id}\`)`. The hunter reads
// only the handler and proposes a confirmed SQL injection. The refutation runs in a fresh context that receives only the
// candidate and an excerpt of the handler; it reads src/db.js through the host's read tool, finds that the sql tag binds
// every interpolated value as a parameter, and rejects the candidate citing that line. The candidate ends rejected
// with that evidence, the rejected record is kept in findings.json, and nothing reaches the findings of the run.

test("V2-11: the refuter finds the parameterizing guard through the read tool and the SQL injection candidate ends rejected with that evidence", async () => {
  const { coverageId } = (await load("core/semantic-modules/index.js")).securityAudit;
  const ws = setupWorkspace("v2-11", FIXTURES.guarded);
  try {
    const requests = [];
    const { result, outcome, investigation, json } = await runAudit(ws, { script: fakeAuditor({ coverageId, hunterReads: ["src/routes.js"], requests }) });
    assert.equal(outcome.state, "completed", JSON.stringify(outcome.reason));

    // The hunter never read the guard and proposed a confirmed injection.
    const hunting = requests.filter((r) => r.contextLabel === "hunting");
    const huntReads = hunting.flatMap((r) => r.messages.filter((m) => m.role === "tool").flatMap((m) => m.results.map((x) => x.content)));
    assert.equal(huntReads.some((c) => c.includes("params.push")), false, "the hunter did not see the guard");
    const [candidate] = investigation.candidates;
    assert.equal(investigation.candidates.length, 1);
    assert.equal(candidate.details.proposed_verdict, "confirmed", "the hunter proposed it as confirmed");
    assert.equal(candidate.path, "src/routes.js");

    // The refuter's fresh context: its brief has the candidate and the handler excerpt, never the guard's text ...
    const refute = requests.filter((r) => r.contextLabel === "refutation:C1");
    assert.ok(refute.length >= 2, "the refuter used the read tool before deciding");
    const briefText = refute[0].messages[0].text;
    assert.equal(refute[0].messages.length, 1, "a fresh context: only its brief");
    assert.match(briefText, /Candidate C1 \(reported by another context; judge it independently\)/);
    assert.equal(briefText.includes("params.push"), false, "the guard is not in the brief");
    assert.ok(refute[0].tools.includes("read_file"));
    // ... and it found the guard by reading src/db.js through the host tool.
    const calls = refute.flatMap((r) => r.messages.filter((m) => m.role === "assistant").flatMap((m) => m.toolCalls));
    assert.ok(calls.some((c) => c.name === "read_file" && c.arguments.path === "src/db.js"), JSON.stringify(calls));
    const toolResults = refute.at(-1).messages.filter((m) => m.role === "tool").flatMap((m) => m.results);
    const dbResult = toolResults.find((x) => x.content.startsWith('<repository-file path="src/db.js"'));
    assert.ok(dbResult && !dbResult.isError, "the host served src/db.js inside the scope");
    const guardLine = Number(/\n(\d+): .*params\.push\(values\[i\]\)/.exec(dbResult.content)[1]);

    // The candidate ends rejected with that evidence.
    assert.equal(candidate.status, "rejected");
    assert.equal(candidate.confirmation, "rejected");
    assert.equal(candidate.validation.context, "refutation:C1");
    assert.deepEqual(candidate.validation.evidence, [{ path: "src/db.js", line: guardLine, note: "the sql tag binds every interpolated value as a parameter ($n)" }]);
    assert.match(candidate.validation.reason, /sql tag \(src\/db\.js:\d+\) turns the interpolated id into a bind parameter/);
    // A rejected record is not re-verified (only confirmed and needs-validation records are) and is not a finding.
    const verification = investigation.stages.find((s) => s.id === "verification");
    assert.equal(verification.contexts.length, 0);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(outcome.conclusion.findings, []);
    assert.equal(outcome.conclusion.status, "APPROVED");

    // The structured report keeps the rejected record with the refuting evidence, so later runs do not repeat it.
    const findings = json("findings.json");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].verdict, "rejected");
    assert.equal(findings[0].fingerprint, FINGERPRINT);
    assert.deepEqual(findings[0].evidence.map((e) => [e.file, e.line]), [["src/db.js", guardLine]]);
    assert.match(findings[0].reason, /bind parameter/);
    assert.equal("severity" in findings[0], false, "a rejected record has no severity");
    const ledger = json("coverage-ledger.json");
    const unit = ledger.find((u) => u.result_fingerprints.includes(FINGERPRINT));
    assert.equal(unit.status, "candidate");
    assert.deepEqual(unit.decisions.map((d) => [d.fingerprint, d.state, d.refutedBy]), [[FINGERPRINT, "rejected", "refutation:C1"]]);
    assert.ok(unit.local_checks.some((k) => k.agent_id === "refutation-c1" && k.reviewed_paths.includes("src/db.js")));
    const record = JSON.parse(fs.readFileSync(`${result.runDir}/evidence/investigation.json`, "utf8"));
    assert.equal(record.module.id, "security-audit");
    assert.equal(record.module.provenance.revision.length, 40);
  } finally {
    ws.cleanup();
  }
});
