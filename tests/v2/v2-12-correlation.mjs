import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FIXTURES, FINGERPRINT, fakeAuditor, load, runAudit, setupWorkspace } from "./fixtures/cloudflare/auditor.mjs";

// V2-12: two tools detect one root cause. A real Quality run (core/run executeRun) records the Semgrep findings that the
// real Semgrep normalizer (adapters/semgrep parseSemgrepOutput) reads from a Semgrep JSON report of the fixture: a
// project rule flags the SQL text concatenated into db.raw at src/routes.js:5, and a weak-hash rule flags an unrelated
// MD5 digest in tools/digest.js. The report is a hand-built Semgrep 1.168-shaped document (fixtures/complementary-a/
// correlation; Semgrep did not run in this test). A real Semantic run (method security-audit, the Cloudflare baseline,
// scripted auditor) confirms the same SQL injection after independent refutation and verification. The root-cause
// correlation reads both runs from their folders and puts the Semgrep finding and the Semantic candidate in one group
// whose members keep both original findings, their tools and their own validation states; the unrelated finding stays
// alone, nothing is merged, dropped or relabeled.

const here = path.dirname(fileURLToPath(import.meta.url));
const SEMGREP_JSON = path.join(here, "fixtures", "complementary-a", "correlation", "semgrep-output.json");
const DIGEST = ['const crypto = require("crypto");', "", "// Content digest of a build artifact.", 'exports.digest = (buf) => crypto.createHash("md5").update(buf).digest("hex");', ""].join("\n");

test("V2-12: a Semgrep finding and a confirmed Semantic candidate on the same SQL injection are correlated into one group that keeps both originals, tools and validation states", async () => {
  const { coverageId } = (await load("core/semantic-modules/index.js")).securityAudit;
  const { parseSemgrepOutput } = await load("adapters/semgrep/normalize.js");
  const { executeRun } = await load("core/run/index.js");
  const { correlateRunDirs, CORRELATION_FILE } = await load("core/correlation/index.js");
  const ws = setupWorkspace("v2-12", { ...FIXTURES.vulnerable, "tools/digest.js": DIGEST });
  try {
    // Quality: the Semgrep report through the real normalizer, recorded by the real Quality run service.
    let qualityDir = null;
    const quality = await executeRun({
      workspacePath: ws.dir,
      home: ws.home,
      env: ws.env,
      version: "test",
      adapter: "semgrep",
      options: {},
      cache: false,
      waivers: [],
      execute: async (ctx) => {
        qualityDir = ctx.runDir;
        const parsed = parseSemgrepOutput(fs.readFileSync(SEMGREP_JSON, "utf8"), { stageId: "semgrep#sast", version: "1.168.0", workspace: ws.dir, cwd: ws.dir });
        assert.equal(parsed.ok, true, parsed.problem);
        return { stages: [{ id: "semgrep#sast", state: "completed", blockingViolations: parsed.findings.filter((f) => f.blocking).length }], requirements: [{ id: "semgrep#sast", required: true }], disabled: [], findings: parsed.findings, logs: [], outputs: [] };
      },
    });
    assert.match(quality.runId, /^run_/);
    const qualityResult = JSON.parse(fs.readFileSync(path.join(qualityDir, "result.json"), "utf8"));
    const semgrepSql = qualityResult.findings.find((f) => f.ruleId === "project.raw-sql-concatenation");
    assert.ok(semgrepSql, "the Quality run recorded the Semgrep SQL finding");
    assert.equal(semgrepSql.tool, "semgrep");
    assert.deepEqual(semgrepSql.location, { path: "src/routes.js", line: 5, column: 16 });

    // Semantic: the security audit confirms the injection at the same place.
    const { result } = await runAudit(ws, { scope: { mode: "selected", subjects: [{ kind: "path", value: "src" }] }, script: fakeAuditor({ coverageId }) });
    const candidate = result.semanticRun.outcome.investigation.candidates[0];
    assert.equal(candidate.status, "confirmed");
    assert.match(JSON.stringify(candidate.details), new RegExp(FINGERPRINT.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
    // The confirmed record ends at its sink (src/db.js); its trace passes through the line Semgrep flags.
    assert.equal(candidate.path, "src/db.js");
    assert.ok(candidate.details.record.trace.some((t) => t.file === "src/routes.js" && t.line === 5), JSON.stringify(candidate.details.record.trace));

    // Correlation from the two run folders.
    const out = path.join(result.runDir, CORRELATION_FILE);
    const report = correlateRunDirs([qualityDir, result.runDir], { write: out });
    assert.equal(report.members, 3, "every finding and candidate is a member");
    assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")).groups.length, report.groups.length);
    const group = report.groups.find((g) => g.members.some((m) => m.origin === "semantic"));
    assert.equal(group.rootCause.class, "sql-injection");
    assert.ok(group.rootCause.anchors.some((a) => a.path === "src/routes.js" && a.line === 5));
    assert.deepEqual(group.tools, ["semantic-gate", "semgrep"]);
    assert.deepEqual(group.origins, ["quality", "semantic"]);
    assert.deepEqual(group.methods, ["security-audit"]);
    assert.equal(group.members.length, 2);
    const q = group.members.find((m) => m.origin === "quality");
    const s = group.members.find((m) => m.origin === "semantic");
    // Both original findings, untouched, with their own tools, runs and validation states.
    assert.deepEqual(q.original, semgrepSql);
    assert.equal(q.tool, "semgrep");
    assert.equal(q.runId, quality.runId);
    assert.deepEqual(q.validation, { state: "tool-reported", by: "semgrep", reason: null });
    // The normalized Semgrep finding keeps no CWE; its class comes from the rule id and message.
    assert.equal(q.rootCause.basis, "keywords");
    assert.deepEqual(s.original, candidate);
    assert.equal(s.tool, "semantic-gate");
    assert.equal(s.method, "security-audit");
    assert.equal(s.runId, result.runId);
    assert.equal(s.validation.state, "confirmed");
    assert.equal(s.validation.by, "refutation:C1");
    assert.equal(s.original.verification.outcome, "verified", "the independent verification stays inside the candidate");
    assert.deepEqual(group.validation, { "tool-reported": 1, waived: 0, confirmed: 1, "needs-validation": 0, rejected: 0, unresolved: 0, open: 0 });
    assert.equal(group.disagreement, false);
    // The unrelated weak-hash finding is its own group; nothing was merged into it.
    const other = report.groups.find((g) => g.members.some((m) => m.original.ruleId === "project.weak-hash"));
    assert.notEqual(other, group);
    assert.equal(other.members.length, 1);
    assert.equal(other.rootCause.class, "weak-crypto");
    assert.equal(report.correlated, 1);
  } finally {
    ws.cleanup();
  }
});
