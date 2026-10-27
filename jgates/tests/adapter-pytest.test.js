import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// pytest adapter: the tests that ran (JUnit) and the line coverage with numerator, denominator and component,
// judged against the minimum of the policy; a missing coverage report is "not measured", never 0% or passed; nothing
// is left in the workspace.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const VENV_BIN = path.join(repo, ".venv", process.platform === "win32" ? "Scripts" : "bin");
const PYTHON = path.join(VENV_BIN, process.platform === "win32" ? "python.exe" : "python");
const require = createRequire(import.meta.url);
const mainFixture = require("../../tests/fixtures/jgates/main-fixture.js");
const pytestAdapter = await import(pathToFileURL(path.join(dist, "adapters", "pytest", "index.js")).href);

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const TOOLS = "schemaVersion: 1\ntools:\n  pytest:\n    adapter: pytest\n    component: api\n    capabilities: [unit, coverage]\n";
const POLICY = (min) => `schemaVersion: 1\nrules:\n  coverage.minimum:\n    threshold: ${min}\n`;

function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

function project({ minimum = mainFixture.MIN_API_COVERAGE, noCache = true } = {}) {
  assert.ok(fs.existsSync(PYTHON), "the repository .venv has no python: run `npm --prefix jgates run setup:dev-tools`");
  const probe = spawnSync(PYTHON, ["-c", "import pytest, pytest_cov"], { encoding: "utf8" });
  assert.equal(probe.status, 0, `pytest and pytest-cov are not installed in the repository .venv: run \`npm --prefix jgates run setup:dev-tools\`\n${probe.stderr}`);
  const { dir } = mainFixture.createMainFixture();
  const home = tmp("jgates-pt-home-");
  const emptyBin = tmp("jgates-pt-bin-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_PYTHON: PYTHON, ...(noCache ? { JGATES_NO_CACHE: "1" } : {}), PATH: emptyBin, DOCKER_HOST: "tcp://127.0.0.1:1" };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 300_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const init = cli(["init", "--cwd", dir, "--profile", "strict", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), TOOLS);
  if (minimum !== null) fs.writeFileSync(path.join(dir, ".jgates", "policy.yml"), POLICY(minimum));
  const plan = () => cli(["plan", "--cwd", dir, "--only", "tool:pytest", "--json"]);
  const run = () => cli(["run", "--cwd", dir, "--only", "tool:pytest", "--no-interactive", "--json"]);
  const cleanup = () => {
    mainFixture.removeFixture(dir);
    for (const d of [home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, cli, plan, run, cleanup };
}

const metric = (result, id) => (result.metrics ?? []).find((m) => m.id === id);
const stage = (result, id) => result.stages.find((s) => s.id === id);
const pytestFindings = (result) => result.findings.filter((f) => f.tool === "pytest");
const noLeftovers = (dir) => {
  const left = listTree(dir).filter((f) => /(^|\/)(\.coverage[^/]*|\.pytest_cache(\/.*)?|__pycache__(\/.*)?|[^/]+\.pyc)$/.test(f));
  assert.deepEqual(left, []);
};

test("on the broken fixture the API coverage comes with numerator, denominator and component, below the policy minimum, and the run fails with the coverage finding [proves: pytest#coverage]", () => {
  const p = project();
  try {
    const before = listTree(p.dir);
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const unit = planned.doc.plan.groups.willRun.find((i) => i.id === "pytest#unit");
    const cov = planned.doc.plan.groups.willRun.find((i) => i.id === "pytest#coverage");
    assert.ok(unit && cov, JSON.stringify(planned.doc.plan.groups.willRun.map((i) => i.id)));
    assert.equal(unit.adapter, "pytest");
    assert.equal(unit.effects.executesProjectCode, true, "pytest declares that it executes project code");
    assert.ok(unit.limitations.some((l) => /executes project code/i.test(l)));
    assert.match(unit.versions.toolVersion, /^\d+\.\d+\.\d+/);
    assert.equal(unit.command.cwd, "{workspace}/api");
    const args = unit.command.args;
    assert.ok(args.includes("no:cacheprovider"));
    assert.ok(args.some((a) => /^--junitxml=\{runDir\}\//.test(a)));
    assert.ok(args.includes("--cov=src"));
    assert.equal(unit.command.env.PYTHONDONTWRITEBYTECODE, "1");
    assert.match(unit.command.env.COVERAGE_FILE, /^\{runDir\}\//);

    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    const result = ran.doc;
    assert.equal(result.decision, "failed");
    assert.equal(stage(result, "pytest#unit").state, "completed");
    assert.equal(stage(result, "pytest#coverage").state, "completed");

    const coverage = metric(result, "coverage.lines");
    assert.ok(coverage, JSON.stringify(result.metrics));
    assert.equal(coverage.unit, "percent");
    assert.equal(coverage.component, "api");
    assert.equal(coverage.origin, "pytest");
    assert.ok(Number.isInteger(coverage.numerator) && Number.isInteger(coverage.denominator) && coverage.denominator > 0, JSON.stringify(coverage));
    assert.ok(coverage.numerator < coverage.denominator, "refunds has no tests");
    assert.ok(coverage.value < mainFixture.MIN_API_COVERAGE, `${coverage.value}% is under the minimum`);
    assert.equal(coverage.value, Math.round((coverage.numerator / coverage.denominator) * 10000) / 100);
    assert.ok(Array.isArray(coverage.exclusions) && coverage.exclusions.length > 0);

    const below = pytestFindings(result).filter((f) => f.ruleId === "coverage-below-minimum");
    assert.equal(below.length, 1);
    assert.equal(below[0].blocking, true);
    assert.equal(below[0].stageId, "pytest#coverage");
    assert.match(below[0].message, /api/);
    assert.ok(result.blockingViolations >= 1);

    // The tests that ran: the unit stage and the counts.
    assert.equal(metric(result, "tests.total").value >= 1, true);
    assert.equal(metric(result, "tests.failed").value, 0);
    assert.equal(metric(result, "tests.skipped").value, 0);


    // Nothing is left in the workspace; the reports live in the run folder.
    assert.deepEqual(listTree(p.dir), before);
    noLeftovers(p.dir);
    assert.deepEqual(result.workspaceChanges.added, []);
    assert.ok(fs.existsSync(path.join(result.runDir, "outputs", "pytest", "pytest", "junit.xml")));
    assert.ok(fs.existsSync(path.join(result.runDir, "outputs", "pytest", "pytest", "coverage.json")));
  } finally {
    p.cleanup();
  }
});

test("on the fixed fixture the coverage is above the minimum and the step passes", () => {
  const p = project();
  try {
    mainFixture.fixMainFixture(p.dir);
    const before = listTree(p.dir);
    const ran = p.run();
    assert.equal(ran.code, 0, ran.out + ran.err);
    const result = ran.doc;
    assert.equal(stage(result, "pytest#unit").state, "completed");
    assert.equal(stage(result, "pytest#coverage").state, "completed");
    const coverage = metric(result, "coverage.lines");
    assert.ok(coverage.value >= mainFixture.MIN_API_COVERAGE, `${coverage.value}%`);
    assert.equal(coverage.component, "api");
    assert.ok(coverage.numerator <= coverage.denominator);
    assert.deepEqual(pytestFindings(result), []);
    assert.equal(result.decision, "passed");
    assert.ok(metric(result, "tests.total").value >= 4);
    assert.deepEqual(listTree(p.dir), before);
    noLeftovers(p.dir);
  } finally {
    p.cleanup();
  }
});

test("without the coverage plugin the metric is not measured and the coverage requirement is incomplete, never 0% or passed", () => {
  const p = project();
  try {
    mainFixture.fixMainFixture(p.dir);
    // The component switches the plugin off for itself: pytest then does not know --cov.
    fs.writeFileSync(path.join(p.dir, "api", "pytest.ini"), "[pytest]\naddopts = -p no:cov\n");
    const planned = p.plan();
    assert.equal(planned.code, 0, planned.out + planned.err);
    const unit = planned.doc.plan.groups.willRun.find((i) => i.id === "pytest#unit");
    assert.ok(!unit.command.args.some((a) => a.startsWith("--cov")), "no --cov when the plugin does not answer it");
    assert.ok(unit.limitations.some((l) => /pytest-cov/.test(l)));
    const before = listTree(p.dir);

    const ran = p.run();
    const result = ran.doc;
    assert.equal(ran.code, 2, ran.out + ran.err);
    assert.equal(result.decision, "incomplete");
    assert.equal(stage(result, "pytest#unit").state, "completed", "the tests themselves ran and passed");
    const cov = stage(result, "pytest#coverage");
    assert.equal(cov.state, "blocked");
    assert.match(cov.reason, /pytest-cov/);
    assert.ok(result.unsatisfied.some((u) => u.requirementId === "pytest#coverage"));
    const coverage = metric(result, "coverage.lines");
    assert.ok(coverage, "the metric is reported");
    assert.equal(coverage.measured, false);
    assert.equal("value" in coverage, false, "no value, so never 0%");
    assert.ok(coverage.reason);
    assert.deepEqual(pytestFindings(result), []);
    assert.deepEqual(listTree(p.dir), before);
    noLeftovers(p.dir);
  } finally {
    p.cleanup();
  }
});

test("a failing test fails the step with the test name in the finding, and skipped tests are counted [proves: pytest#unit]", () => {
  const p = project({ minimum: null });
  try {
    mainFixture.fixMainFixture(p.dir);
    fs.writeFileSync(
      path.join(p.dir, "api", "tests", "test_extra.py"),
      'import unittest\n\n\nclass ExtraTest(unittest.TestCase):\n    def test_broken_total(self):\n        self.assertEqual(1 + 1, 3)\n\n    @unittest.skip("not now")\n    def test_later(self):\n        pass\n',
    );
    const before = listTree(p.dir);
    const ran = p.run();
    assert.equal(ran.code, 1, ran.out + ran.err);
    const result = ran.doc;
    assert.equal(result.decision, "failed");
    const unit = stage(result, "pytest#unit");
    assert.equal(unit.state, "completed");
    assert.equal(unit.blockingViolations, 1);
    const failed = pytestFindings(result).filter((f) => f.ruleId === "test-failed");
    assert.equal(failed.length, 1);
    assert.match(failed[0].message, /ExtraTest::test_broken_total/);
    assert.equal(failed[0].blocking, true);
    assert.equal(failed[0].stageId, "pytest#unit");
    assert.equal(failed[0].location?.path, "api/tests/test_extra.py");
    assert.equal(metric(result, "tests.failed").value, 1);
    assert.equal(metric(result, "tests.skipped").value, 1);
    assert.ok(metric(result, "tests.total").value >= 6);
    // Without a minimum in the policy the coverage is measured and reported, and nothing is blocked by it.
    assert.equal(stage(result, "pytest#coverage").state, "completed");
    assert.ok(metric(result, "coverage.lines").value > 0);
    assert.deepEqual(pytestFindings(result).filter((f) => f.ruleId === "coverage-below-minimum"), []);
    assert.deepEqual(listTree(p.dir), before);
    noLeftovers(p.dir);
  } finally {
    p.cleanup();
  }
});

test("parseJunit counts failures, errors and skips from the cases and refuses a document that is not JUnit", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="1" failures="1" skipped="1" tests="4">
<testcase classname="tests.test_a.A" name="test_ok" time="0.001" />
<testcase classname="tests.test_a.A" name="test_bad" time="0.001"><failure message="assert 1 &gt; 2&#10;more">trace &lt;x&gt;</failure></testcase>
<testcase classname="tests.test_a" name="test_err"><error message="boom">t</error></testcase>
<testcase classname="tests.test_a" name="test_skip"><skipped type="pytest.skip" message="later">s</skipped></testcase>
</testsuite></testsuites>`;
  const r = pytestAdapter.parseJunit(xml);
  assert.equal(r.ok, true);
  assert.deepEqual([r.total, r.failed, r.errors, r.skipped], [4, 1, 1, 1]);
  assert.equal(r.cases[1].message, "assert 1 > 2");
  assert.equal(pytestAdapter.parseJunit("<html></html>").ok, false);
});

test("parseCoverageJson keeps the denominator and refuses reports it cannot read", () => {
  const ok = pytestAdapter.parseCoverageJson(JSON.stringify({ meta: { branch_coverage: false }, totals: { covered_lines: 8, num_statements: 10, excluded_lines: 2 }, files: { "a.py": {} } }));
  assert.deepEqual([ok.ok, ok.covered, ok.statements, ok.excluded, ok.files], [true, 8, 10, 2, 1]);
  assert.equal(pytestAdapter.parseCoverageJson("{}").ok, false);
  assert.equal(pytestAdapter.parseCoverageJson("not json").ok, false);
  assert.equal(pytestAdapter.parseCoverageJson(JSON.stringify({ totals: { covered_lines: 11, num_statements: 10 } })).ok, false);
});

test("a pytest run is never served from the cache (it executes project code)", () => {
  const p = project({ noCache: false });
  try {
    for (let i = 0; i < 2; i++) {
      const ran = p.run();
      const cache = stage(ran.doc, "pytest#unit").cache;
      assert.equal(cache.status, "uncacheable", ran.out + ran.err);
      assert.equal(cache.code, "EXECUTES_PROJECT_CODE");
    }
  } finally {
    p.cleanup();
  }
});
