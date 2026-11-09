import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-22: a customer-supplied tool (CodeQL) is configured by the path of its executable and gives readiness plus
// normalized findings through the real plan and run services.
//
// HONEST NOTE: the real CodeQL CLI is not available here and is never downloaded (its terms restrict use). The
// executable the test configures is a STAND-IN (jgates/tests/fixtures/codeql/stand-in) that answers `codeql version`,
// creates a marker database and replays a SARIF in the shape of CodeQL's `--format=sarif-latest`. That SARIF
// (jgates/tests/fixtures/codeql/recorded) was constructed strictly per the published CodeQL SARIF 2.1.0 shape, it is not
// captured from a real run. What this proves is the adapter's contract with the tool (readiness, database, suite,
// SARIF normalization, fail-closed handling), not CodeQL's analysis, so the CodeQL rows of the matrix stay
// customer-setup-required.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const FIXTURES = path.join(root, "jgates", "tests", "fixtures", "codeql");
const load = (...parts) => import(pathToFileURL(path.join(DIST, ...parts)).href);

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

async function workspace(fixture) {
  const { planInit, writeInit } = await load("core", "init", "index.js");
  const dir = tmp("v2-22-ws-");
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  writeInit(dir, planInit(dir, "minimal"));
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  codeql:\n    adapter: codeql\n    enabled: true\n    capabilities: [dataflow]\n    language: python\n    suite: security-extended\n");
  return dir;
}

test("V2-22: a configured customer-supplied executable (CodeQL, stand-in with recorded SARIF) gives readiness and normalized findings", async () => {
  let restoreLocale = () => undefined;
  try {
    const { setLocale, getLocale } = await load("i18n", "index.js");
    const previousLocale = getLocale();
    restoreLocale = () => setLocale(previousLocale);
    setLocale("en");
    const { buildPlan } = await load("core", "plan", "index.js");
    const { executeRun } = await load("core", "run", "index.js");
    const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
    const { probeCodeql } = await load("adapters", "codeql", "index.js");
    const { buildStandIn } = await import(pathToFileURL(path.join(FIXTURES, "stand-in", "build.mjs")).href);

    const home = tmp("v2-22-home-");
    const standIn = buildStandIn(tmp("v2-22-standin-"));
    const env = { ...process.env, JGATES_HOME: home, NO_COLOR: "1", JGATES_CODEQL: standIn };

    // Readiness: the configured path answers `codeql version` with a supported version.
    const probe = probeCodeql(env);
    assert.equal(probe.problem, null);
    assert.equal(probe.executable, standIn);
    assert.equal(probe.version, "2.18.4");

    const plan = (dir) => {
      const built = buildPlan(dir, { only: ["tool:codeql"], env, home, compare: false, version: "test" });
      assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
      return built.plan;
    };
    const run = (dir, builtPlan) =>
      executeRun({
        workspacePath: dir,
        home,
        version: "test",
        adapter: "quality-bridge",
        options: { planHash: builtPlan.planHash, planSource: "built", profile: "minimal", scope: "full" },
        plan: builtPlan,
        steps: (context) => planSteps(context, builtPlan),
        disabled: planDisabled(builtPlan),
        env,
        cache: false,
      });

    const bad = await workspace("bad");
    const badPlan = plan(bad);
    const item = badPlan.groups.willRun.find((i) => i.id === "codeql#dataflow");
    assert.ok(item);
    assert.equal(item.availability.status, "available", "the configured executable makes the stage ready");
    assert.equal(item.versions.toolVersion, "2.18.4");
    assert.equal(item.command.executable, standIn);
    assert.ok(item.command.args.includes("codeql/python-queries:codeql-suites/python-security-extended.qls"), "the selected suite is planned");

    // Findings: the known-bad project fails with a normalized, located, blocking finding.
    const failed = await run(bad, badPlan);
    assert.equal(failed.decision, "failed");
    const stage = failed.stages.find((s) => s.id === "codeql#dataflow");
    assert.equal(stage.state, "completed");
    assert.equal(stage.interpreted, true);
    const found = failed.findings.filter((f) => f.tool === "codeql");
    assert.equal(found.length, 1);
    assert.equal(found[0].ruleId, "py/command-line-injection");
    assert.equal(found[0].category, "dataflow");
    assert.equal(found[0].normalizedSeverity, "critical");
    assert.equal(found[0].blocking, true);
    assert.equal(found[0].location.path, "app.py");
    assert.equal(found[0].location.line, 10);
    assert.ok(fs.existsSync(path.join(failed.runDir, "outputs", "codeql", "codeql", "codeql.sarif")), "the raw SARIF is kept in the run folder");
    assert.equal(fs.existsSync(path.join(bad, "codeql.sarif")), false, "nothing was written in the workspace");

    // The clean twin passes with the same configuration and no findings.
    const clean = await workspace("clean");
    const passed = await run(clean, plan(clean));
    assert.equal(passed.decision, "passed");
    assert.equal(passed.findings.filter((f) => f.tool === "codeql").length, 0);
    assert.equal(passed.stages.find((s) => s.id === "codeql#dataflow").state, "completed");
  } finally {
    // The process language is shared by every case the acceptance harness runs in this process.
    restoreLocale();
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  }
});
