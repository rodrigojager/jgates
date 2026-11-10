import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// file-size adapter: a tree with a text file over the line limit yields a located, blocking finding for that file and a
// tree within the limit none, through the real init, plan and run services (the check is in-process, there is no
// external tool). A setting that is not valid refuses the plan; binary files, generated folders and a tree too big to
// walk are never counted as small.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const FIXTURES = path.join(here, "fixtures", "file-size");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const { planInit, writeInit } = await load("core", "init", "index.js");
const { buildPlan } = await load("core", "plan", "index.js");
const { executeRun } = await load("core", "run", "index.js");
const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
const adapter = await load("adapters", "file-size", "index.js");
const manifests = await load("adapters", "manifests.js");
const matrix = await load("core", "matrix", "index.js");

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const home = tmp("jgates-fs-home-");
const env = { ...process.env, JGATES_HOME: home, JGATES_NO_CACHE: "1", NO_COLOR: "1", JGATES_LOCALE: "en" };

/** A workspace with one fixture and an instance of the file-size adapter (opt-in: written to tools.yml, like a user would). */
function workspace(kind, settings = "    maxLines: 20\n", files = {}) {
  const dir = tmp(`jgates-fs-${kind}-`);
  fs.cpSync(path.join(FIXTURES, kind), dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  writeInit(dir, planInit(dir, "minimal"));
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), `schemaVersion: 1\ntools:\n  file-size:\n    adapter: file-size\n    capabilities: [file-size]\n${settings}`);
  return dir;
}

function plan(dir) {
  const built = buildPlan(dir, { only: ["tool:file-size"], env, home, compare: false, version: "test" });
  assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
  return built.plan;
}

function execute(dir, builtPlan) {
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
  });
}

test("file-size: a file over the line limit is a located blocking finding and the clean tree none [proves: file-size#file-size, file-size#file-size@any]", async () => {
  const bad = workspace("bad");
  const badPlan = plan(bad);
  const item = badPlan.groups.willRun.find((i) => i.id === "file-size#file-size");
  assert.ok(item, "file-size#file-size is in the plan");
  assert.equal(item.adapter, "file-size");
  assert.equal(item.availability.status, "available", item.availability.reason ?? "");
  const failed = await execute(bad, badPlan);
  assert.equal(failed.decision, "failed", JSON.stringify(failed.stages));
  const stage = failed.stages.find((s) => s.id === "file-size#file-size");
  assert.equal(stage.state, "completed", stage.reason);
  assert.notEqual(stage.interpreted, false);
  const found = failed.findings.filter((f) => f.origin === "file-size");
  assert.deepEqual(found.map((f) => f.location.path), ["src/huge.txt"], "only the oversized file is a finding, and the small one is not");
  assert.equal(found[0].ruleId, "file-size.max-lines");
  assert.equal(found[0].blocking, true);
  // Whatever the language of the process, the message names the file, its lines and the limit.
  assert.match(found[0].message, /src\/huge\.txt.*\b30\b.*\b20\b/);

  const clean = workspace("clean");
  const passed = await execute(clean, plan(clean));
  assert.equal(passed.decision, "passed", JSON.stringify(passed.stages));
  assert.equal(passed.findings.filter((f) => f.origin === "file-size").length, 0);
  assert.equal(passed.stages.find((s) => s.id === "file-size#file-size").state, "completed");
});

test("file-size: the limit is the setting of the instance, 5000 lines by default", async () => {
  const same = workspace("bad", "");
  const passed = await execute(same, plan(same));
  assert.equal(passed.decision, "passed", "30 lines are within the default limit");
  const strict = workspace("bad", "    maxLines: 29\n");
  const failed = await execute(strict, plan(strict));
  assert.equal(failed.decision, "failed");
  const exact = workspace("bad", "    maxLines: 30\n");
  assert.equal((await execute(exact, plan(exact))).decision, "passed", "a file at the limit is within it");
});

test("file-size: an unreadable setting blocks the plan and a tree over the walk limit is never counted as clean", async () => {
  const wrong = workspace("clean", "    maxLines: 0\n");
  const built = buildPlan(wrong, { only: ["tool:file-size"], env, home, compare: false, version: "test" });
  assert.match(JSON.stringify(built), /maxLines/, JSON.stringify(built).slice(0, 1500));

  // Past the walk limit the answer is incomplete: the analysis says so and the stage is not interpreted.
  const result = adapter.analyzeFileSize(path.join(FIXTURES, "clean"), { maxLines: 20, maxFiles: 1 });
  assert.equal(result.truncated, true);
  assert.equal(result.checked, 1);
  const whole = adapter.analyzeFileSize(path.join(FIXTURES, "clean"), { maxLines: 20 });
  assert.equal(whole.truncated, false);
  assert.equal(whole.checked, 2);
});

test("file-size analysis: binary files are listed and skipped, generated folders are not entered, a last line without a newline counts", () => {
  const dir = tmp("jgates-fs-analysis-");
  const write = (name, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  };
  write("a.txt", "1\n2\n3");
  write("blob.bin", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("x\n".repeat(50))]));
  write("node_modules/dep/index.js", "x\n".repeat(50));
  write(".git/config", "x\n".repeat(50));
  write("src/big.txt", "x\n".repeat(50));
  const result = adapter.analyzeFileSize(dir, { maxLines: 2 });
  assert.deepEqual(result.oversized.map((f) => [f.file, f.lines]).sort(), [["a.txt", 3], ["src/big.txt", 50]]);
  assert.deepEqual(result.skipped, [{ file: "blob.bin", reason: "binary" }]);
  assert.equal(result.checked, 2);
});

test("file-size: the support matrix shows the any row validated with its proof", () => {
  const built = matrix.buildMatrix(manifests.builtinManifests());
  const rows = built.rows.filter((r) => r.adapter === "file-size");
  assert.deepEqual(rows.map((r) => [r.capability, r.stack, r.state]), [["file-size", "any", "validated"]]);
  assert.ok(rows[0].evidence.tests.length > 0);
  assert.deepEqual(matrix.verifyMatrix(built).filter((p) => /file-size/.test(p)), []);
});
