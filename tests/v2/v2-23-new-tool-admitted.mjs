import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-23: a new Quality tool (zizmor, GitHub Actions security) is admitted end to end through the real services:
// its configuration (settings in tools.yml reach the command), its prerequisites (a missing tool is reported with the
// guided preparation, which installs it into the JGates environment, never during a run), its execution (the real
// plan and run services over a known-bad and a clean workflow fixture), its cancellation (only the run-owned process
// stops and the partial evidence stays) and its normalized results.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const FIXTURES = path.join(root, "jgates", "tests", "fixtures", "zizmor");
const load = (...parts) => import(pathToFileURL(path.join(DIST, ...parts)).href);
const { imageJsonWithout, releaseImageJson } = await import(pathToFileURL(path.join(root, "jgates", "tests", "setup", "image-json.mjs")).href);

/**
 * A zizmor that stands for the tools image's in this in-image run (tests/setup/in-image.mjs): the one on this machine's
 * PATH, else the image's version installed into a throwaway virtual environment of the test (never JGates's doing).
 */
function zizmorStandIn(probe) {
  if (probe.executable && path.isAbsolute(probe.executable)) return probe.executable;
  const venv = path.join(tmp("v2-23-venv-"), "venv");
  const created = spawnSync(process.platform === "win32" ? "python" : "python3", ["-m", "venv", venv], { encoding: "utf8" });
  assert.equal(created.status, 0, `python -m venv failed: ${created.stderr}`);
  const bin = path.join(venv, process.platform === "win32" ? "Scripts" : "bin");
  const pip = spawnSync(path.join(bin, process.platform === "win32" ? "python.exe" : "python"), ["-m", "pip", "install", "--quiet", `zizmor==${releaseImageJson().tools.zizmor}`], { encoding: "utf8", timeout: 600_000 });
  assert.equal(pip.status, 0, `installing the stand-in zizmor failed (network?): ${pip.stderr}`);
  return path.join(bin, process.platform === "win32" ? "zizmor.exe" : "zizmor");
}

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** A workspace with the workflows of one fixture, initialized by the real init service (the zizmor template comes by evidence). */
async function workspace(fixture) {
  const { planInit, writeInit } = await load("core", "init", "index.js");
  const dir = tmp("v2-23-ws-");
  if (fixture) fs.cpSync(path.join(FIXTURES, fixture, ".github"), path.join(dir, ".github"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  writeInit(dir, planInit(dir, "minimal"));
  return dir;
}

async function plan(dir, env, home) {
  const { buildPlan } = await load("core", "plan", "index.js");
  const built = buildPlan(dir, { only: ["tool:zizmor"], env, home, compare: false, version: "test" });
  assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
  return built.plan;
}

async function run(dir, env, home, builtPlan, extra = {}) {
  const { executeRun } = await load("core", "run", "index.js");
  const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
  return executeRun({
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
    ...extra,
  });
}

test("V2-23: a new tool (zizmor) is admitted through configuration, prerequisites, execution, cancellation and normalized results", async (t) => {
  try {
    const home = tmp("v2-23-home-");
    const { probeZizmor } = await load("adapters", "zizmor", "index.js");
    const { assessEnvironment } = await load("core", "install", "index.js");
    const baseEnv = { ...process.env, JGATES_HOME: home, NO_COLOR: "1" };
    delete baseEnv.JGATES_ZIZMOR;

    // Applicability: a repo with workflows lists the check under infrastructure; one without workflows has no zizmor.
    const bad = await workspace("injection");
    const none = await workspace(null);
    const missingEnv = { ...baseEnv, JGATES_IMAGE_JSON: imageJsonWithout("zizmor") };
    const withFlows = await plan(bad, missingEnv, home);
    const item = withFlows.groups.willRun.find((i) => i.id === "zizmor#ci-cd");
    assert.ok(item, "zizmor#ci-cd is in the plan of a repo with .github/workflows");
    assert.equal(item.category, "infrastructure");
    const { buildPlan } = await load("core", "plan", "index.js");
    const noFlows = buildPlan(none, { env: missingEnv, home, compare: false, version: "test" });
    assert.equal(noFlows.ok, true);
    assert.equal([...noFlows.plan.groups.willRun, ...noFlows.plan.groups.notApplicableOrDisabled].some((i) => i.adapter === "zizmor"), false);

    // Prerequisites: a tool the tools image lacks is unavailable with the image as its one cause; nothing is offered
    // to install on the host.
    assert.equal(item.availability.status, "unavailable");
    assert.match(item.availability.reason, /jgates setup/);
    const blocked = await run(bad, missingEnv, home, withFlows);
    assert.equal(blocked.stages.find((s) => s.id === "zizmor#ci-cd").state, "blocked");
    assert.notEqual(blocked.decision, "passed");
    const assessment = assessEnvironment(bad, { env: missingEnv });
    const diagnosed = assessment.report.tools.find((x) => x.adapter === "zizmor");
    assert.equal(diagnosed.missing, true);
    assert.equal(diagnosed.recipe, null, "no host install is offered for a tool");
    assert.equal(diagnosed.fix, "jgates setup");
    assert.equal(assessment.recipes.has("tool:zizmor"), false);
    // Execution: a zizmor stands for the image's (an override inside the image, as an advanced CI setup names it).
    const env = { ...baseEnv, JGATES_ZIZMOR: zizmorStandIn(probeZizmor(baseEnv)) };
    const ready = probeZizmor(env);
    assert.ok(ready.executable && ready.version, `zizmor answers (${ready.detail})`);
    t.diagnostic(`zizmor ${ready.version} at ${ready.executable}`);

    // Configuration: the settings of the instance reach the planned command.
    fs.writeFileSync(
      path.join(bad, ".jgates", "tools.yml"),
      "schemaVersion: 1\ntools:\n  zizmor:\n    adapter: zizmor\n    capabilities: [ci-cd]\n    persona: pedantic\n    minSeverity: low\n",
    );
    const configured = await plan(bad, env, home);
    const args = configured.groups.willRun.find((i) => i.id === "zizmor#ci-cd").command.args;
    assert.equal(args[args.indexOf("--persona") + 1], "pedantic");
    assert.equal(args[args.indexOf("--min-severity") + 1], "low");
    assert.ok(args.includes("--offline"), "offline is the default");
    assert.equal(configured.groups.willRun.find((i) => i.id === "zizmor#ci-cd").availability.status, "available");
    fs.writeFileSync(path.join(bad, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  zizmor:\n    adapter: zizmor\n    capabilities: [ci-cd]\n");

    // Execution and normalized results: the known-bad workflow fails with the finding, the clean one passes.
    const badPlan = await plan(bad, env, home);
    const failed = await run(bad, env, home, badPlan);
    assert.equal(failed.decision, "failed");
    const stage = failed.stages.find((s) => s.id === "zizmor#ci-cd");
    assert.equal(stage.state, "completed");
    assert.equal(stage.interpreted, true);
    const found = failed.findings.filter((f) => f.tool === "zizmor");
    assert.equal(found.length, 1);
    assert.equal(found[0].ruleId, "template-injection");
    assert.equal(found[0].category, "ci-cd");
    assert.equal(found[0].normalizedSeverity, "high");
    assert.equal(found[0].blocking, true);
    assert.equal(found[0].location.path, ".github/workflows/triage.yml");
    assert.equal(found[0].location.line, 16);
    assert.ok(fs.existsSync(path.join(failed.runDir, "outputs", "zizmor", "zizmor", "zizmor.json")), "the raw report is kept in the run folder");

    const clean = await workspace("clean");
    const passed = await run(clean, env, home, await plan(clean, env, home));
    assert.equal(passed.decision, "passed");
    assert.equal(passed.findings.filter((f) => f.tool === "zizmor").length, 0);
    assert.equal(passed.stages.find((s) => s.id === "zizmor#ci-cd").state, "completed");

    // Cancellation: the run is cancelled while the zizmor process runs; the run-owned process stops, the decision is
    // cancelled (never favorable) and the evidence written so far stays.
    const controller = new AbortController();
    const events = [];
    const cancelled = await run(bad, env, home, badPlan, {
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === "process-started") controller.abort("v2-23 cancels the run");
      },
    });
    assert.ok(events.includes("process-started"), "the zizmor process had started");
    assert.ok(events.includes("cancel-requested"));
    assert.equal(cancelled.decision, "cancelled");
    assert.equal(cancelled.stopped?.cause, "cancelled");
    assert.equal(cancelled.stages.find((s) => s.id === "zizmor#ci-cd").state, "cancelled");
    assert.equal(cancelled.findings.filter((f) => f.tool === "zizmor").length, 0);
    assert.ok(fs.existsSync(path.join(cancelled.runDir, "result.json")), "the partial run is kept");
    assert.ok(fs.existsSync(path.join(cancelled.runDir, "events.jsonl")), "the events written so far are kept");
  } finally {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  }
});
