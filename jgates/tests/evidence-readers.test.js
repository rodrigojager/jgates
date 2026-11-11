import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The shared report readers (core/evidence): SARIF, JUnit and Checkstyle into normalized findings, fail-closed.

const here = path.dirname(fileURLToPath(import.meta.url));
const { readSarif, readJunit, readCheckstyle, severityBySecurityScore } = await import(pathToFileURL(path.join(here, "..", "dist", "core", "evidence", "index.js")).href);

const sarif = (results, rules = [], driver = { name: "my-linter", version: "1.2.3" }) =>
  JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { ...driver, rules } }, results }] });
const loc = (uri, startLine, startColumn) => [{ physicalLocation: { artifactLocation: { uri }, region: { startLine, startColumn } } }];

test("sarif: level and security-severity become the normalized severity, with rule, file, line, column and fingerprint", () => {
  const text = sarif(
    [
      { ruleId: "R1", level: "error", message: { text: "bad" }, locations: loc("src/a.py", 4, 2), partialFingerprints: { "primaryLocationLineHash/v1": "abc:1" } },
      { ruleId: "R2", level: "warning", message: { text: "meh" }, locations: loc("src/b.py", 9) },
      { ruleId: "R3", level: "note", message: { text: "fyi" }, locations: loc("src/c.py", 1) },
      { ruleId: "R4", message: { text: "scored" }, locations: loc("src/d.py", 7) },
      { ruleId: "R5", level: "weird", message: { text: "odd" }, locations: loc("src/e.py", 7) },
    ],
    [{ id: "R4", properties: { "security-severity": "9.1", tags: ["external/cwe/cwe-089"] }, defaultConfiguration: { level: "warning" }, help: { text: "fix it" } }],
  );
  const r = readSarif(text);
  assert.equal(r.ok, true, r.problem);
  assert.equal(r.driverName, "my-linter");
  assert.equal(r.driverVersion, "1.2.3");
  const by = Object.fromEntries(r.findings.map((f) => [f.ruleId, f]));
  assert.equal(by.R1.normalizedSeverity, "high");
  assert.deepEqual([by.R1.path, by.R1.line, by.R1.column, by.R1.nativeFingerprint], ["src/a.py", 4, 2, "abc:1"]);
  assert.equal(by.R2.normalizedSeverity, "medium");
  assert.equal(by.R3.normalizedSeverity, "low");
  assert.equal(by.R4.normalizedSeverity, "critical", "security-severity wins over the level");
  assert.equal(by.R4.securitySeverity, 9.1);
  assert.equal(by.R4.help, "fix it");
  assert.deepEqual(by.R4.tags, ["external/cwe/cwe-089"]);
  assert.equal(by.R5.normalizedSeverity, "unknown");
  assert.equal(by.R5.known, false, "an unknown level is flagged so callers can block");
  assert.equal(severityBySecurityScore(7), "high");
  assert.equal(severityBySecurityScore(4), "medium");
  assert.equal(severityBySecurityScore(0.5), "low");
});

test("sarif: fail-closed on anything that is not a SARIF 2.1 report; an empty results list is the clean answer", () => {
  for (const bad of ["", "not json", "{}", "[]", JSON.stringify({ version: "2.0.0", runs: [] }), JSON.stringify({ version: "2.1.0", runs: [] }), JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "x" } } }] }), sarif([{ ruleId: "R", message: {} }]), sarif([{ message: { text: "m" } }])]) {
    const r = readSarif(bad, { requireLocation: false });
    assert.equal(r.ok, false, `accepted: ${bad.slice(0, 50)}`);
    assert.deepEqual(r.findings, []);
  }
  assert.equal(readSarif(sarif([])).ok, true);
  assert.deepEqual(readSarif(sarif([])).findings, []);
  // A required location, a required driver and a path root.
  const noLoc = sarif([{ ruleId: "R", level: "error", message: { text: "m" } }]);
  assert.equal(readSarif(noLoc).ok, false);
  assert.equal(readSarif(noLoc, { requireLocation: false }).findings[0].path, null);
  assert.equal(readSarif(sarif([]), { driver: /codeql/i }).ok, false);
  assert.equal(readSarif(sarif([{ ruleId: "R", message: { text: "m" }, locations: loc("a.py", 1) }]), { root: "svc" }).findings[0].path, "svc/a.py");
});

const JUNIT = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="s" tests="4" file="suite.js">
    <testcase classname="mod.Calc" name="adds" time="0.25"/>
    <testcase classname="mod.Calc" name="divides" file="src/calc.js" line="42" time="0.5"><failure message="expected 2 &amp; got 3">AssertionError: expected 2
  at calc.js:42</failure></testcase>
    <testcase classname="mod.Calc" name="boom"><error message="TypeError">stack here</error></testcase>
    <testcase classname="mod.Calc" name="later"><skipped message="not yet"/></testcase>
  </testsuite>
</testsuites>`;

test("junit: failures, errors and skips are counted from the cases, with file, line, duration and failure text", () => {
  const r = readJunit(JUNIT);
  assert.equal(r.ok, true);
  assert.deepEqual([r.total, r.failed, r.errors, r.skipped], [4, 1, 1, 1]);
  const [adds, divides, boom, later] = r.cases;
  assert.equal(adds.outcome, "passed");
  assert.equal(adds.durationSeconds, 0.25);
  assert.equal(adds.file, "suite.js", "the file of the suite is the default");
  assert.equal(divides.outcome, "failed");
  assert.deepEqual([divides.file, divides.line], ["src/calc.js", 42]);
  assert.equal(divides.message, "expected 2 & got 3");
  assert.match(divides.text, /AssertionError: expected 2\n\s+at calc\.js:42/);
  assert.equal(boom.outcome, "error");
  assert.equal(boom.message, "TypeError");
  assert.equal(later.outcome, "skipped");
});

test("junit: a document that is not a JUnit report is refused, not read as zero tests", () => {
  for (const bad of ["", "<html></html>", "{}"]) {
    const r = readJunit(bad);
    assert.equal(r.ok, false);
    assert.equal(r.total, 0);
  }
  assert.equal(readJunit("<testsuite name='x'/>").ok, true);
});

test("checkstyle: findings carry file, line, column, severity, message and rule", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="8.0">
  <file name="src/A.java">
    <error line="3" column="5" severity="error" message="Missing &lt;javadoc&gt;" source="com.puppycrawl.JavadocCheck"/>
    <error line="10" severity="warning" message="Line too long" source="LineLength"/>
  </file>
  <file name="src/B.java"/>
</checkstyle>`;
  const r = readCheckstyle(xml);
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 2);
  assert.deepEqual(r.findings[0], { file: "src/A.java", line: 3, column: 5, severity: "error", message: "Missing <javadoc>", source: "com.puppycrawl.JavadocCheck" });
  assert.deepEqual([r.findings[1].severity, r.findings[1].line, r.findings[1].column], ["warning", 10, undefined]);
  assert.equal(readCheckstyle("<checkstyle/>").ok, true);
  assert.deepEqual(readCheckstyle("<checkstyle/>").findings, []);
  assert.equal(readCheckstyle("<html/>").ok, false);
});
