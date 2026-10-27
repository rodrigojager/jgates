import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The data folder: runs stay out of the project, one folder per workspace, files a test executable leaves in
// the workspace are listed with their step (and never deleted), retention and gc, and workspaces relink.

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FAKE = path.join(here, "fixtures", "executables", "fake-tool.cjs");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const { createMainFixture, listTree, removeFixture } = require(path.join(repo, "tests", "fixtures", "jgates", "main-fixture.js"));
const run = await import(pathToFileURL(path.join(dist, "core", "run", "index.js")).href);
const runner = await import(pathToFileURL(path.join(dist, "core", "runner", "index.js")).href);
const artifacts = await import(pathToFileURL(path.join(dist, "core", "artifacts", "index.js")).href);
const homeLib = await import(pathToFileURL(path.join(dist, "core", "home", "index.js")).href);
const { findOnPath } = await import(pathToFileURL(path.join(dist, "core", "bridge", "index.js")).href);

const validateResult = new Ajv2020({ strict: true, allErrors: true }).compile(
  JSON.parse(fs.readFileSync(path.resolve(here, "..", "schemas", "result", "result.schema.json"), "utf8")),
);
const PYTHON = findOnPath("python") ?? findOnPath("python3");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (...dirs) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

function cli(args, env) {
  const emptyBin = tmp("jg-art-bin-");
  const r = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, JGATES_PYTHON: PYTHON, DOCKER_HOST: "tcp://127.0.0.1:1", ...env, PATH: emptyBin },
    timeout: 600_000,
  });
  rm(emptyBin);
  return r;
}

// ---------------------------------------------------------------------------------------------------------------

test("a full run on the main fixture leaves only the JGates configuration in the project", () => {
  assert.ok(PYTHON, "python not found: put the repository .venv/bin first on PATH");
  const { dir } = createMainFixture();
  const home = tmp("jg-art-home-");
  try {
    const env = { JGATES_HOME: home };
    const init = cli(["init", "--cwd", dir, "--no-interactive", "--json"], env);
    assert.equal(init.status, 0, init.stderr);
    const before = listTree(dir);
    const r = cli(["run", "--cwd", dir, "--json"], env);
    const doc = JSON.parse(r.stdout);
    assert.ok(validateResult(doc), JSON.stringify(validateResult.errors));
    assert.equal(doc.workspaceChanges.checked, true);
    assert.deepEqual([doc.workspaceChanges.added, doc.workspaceChanges.modified, doc.workspaceChanges.removed], [[], [], []]);
    assert.deepEqual(listTree(dir), before);
    // The tree holds only what the fixture had plus jgates.yml and .jgates/.
    const tree = listTree(dir);
    const extra = Object.keys(tree).filter((f) => f === "jgates.yml" || f.startsWith(".jgates/"));
    assert.ok(extra.length >= 1);
    for (const f of Object.keys(tree)) assert.ok(!/^\.quality|(^|\/)__pycache__|\.pytest_cache|\.ruff_cache/.test(f), `stray ${f}`);
    const runDir = path.join(home, "workspaces", doc.workspace.id, "runs", doc.runId);
    assert.equal(fs.realpathSync(doc.runDir), fs.realpathSync(runDir));
    assert.ok(fs.statSync(path.join(runDir, "result.json")).isFile());
    assert.ok(fs.statSync(path.join(runDir, "plan.json")).isFile());
  } finally {
    removeFixture(dir);
    rm(home);
  }
});

test("a second workspace writes to its own folder and its history never shows the other's runs", () => {
  assert.ok(PYTHON);
  const a = createMainFixture().dir;
  const b = createMainFixture().dir;
  const home = tmp("jg-art-home-");
  try {
    const env = { JGATES_HOME: home, JGATES_NO_CACHE: "1" };
    const ra = JSON.parse(cli(["run", "--cwd", a, "--bridge-mode", "quick", "--json"], env).stdout);
    const rb = JSON.parse(cli(["run", "--cwd", b, "--bridge-mode", "quick", "--json"], env).stdout);
    assert.notEqual(ra.workspace.id, rb.workspace.id);
    assert.ok(fs.existsSync(path.join(home, "workspaces", ra.workspace.id, "runs", ra.runId, "result.json")));
    assert.ok(fs.existsSync(path.join(home, "workspaces", rb.workspace.id, "runs", rb.runId, "result.json")));
    assert.ok(!fs.existsSync(path.join(home, "workspaces", rb.workspace.id, "runs", ra.runId)));
    const ha = JSON.parse(cli(["history", "--cwd", a, "--json"], env).stdout);
    const hb = JSON.parse(cli(["history", "--cwd", b, "--json"], env).stdout);
    assert.deepEqual(ha.runs.map((x) => x.runId), [ra.runId]);
    assert.deepEqual(hb.runs.map((x) => x.runId), [rb.runId]);
  } finally {
    removeFixture(a);
    removeFixture(b);
    rm(home);
  }
});

test("a test executable that writes into the workspace is listed with its step, and the file stays", async () => {
  const ws = tmp("jg-art-ws-");
  const home = tmp("jg-art-home-");
  fs.writeFileSync(path.join(ws, "keep.txt"), "x");
  const step = (id, mode) => ({
    id,
    skeleton: () => ({ stages: [{ id: `${id}#check`, kind: "step", adapter: "fake", state: "pending" }], requirements: [{ id: `${id}#check`, required: true }], disabled: [], findings: [], logs: [], outputs: [] }),
    run: async () => {
      const r = await runner.runSpec({ executable: process.execPath, args: [FAKE, "--fake-mode", mode], cwd: ws });
      return {
        stages: [{ id: `${id}#check`, kind: "step", adapter: "fake", state: r.exitCode === 0 ? "completed" : "error", ...(r.exitCode === 0 ? { reason: "ok" } : { reason: "exit" }) }],
        requirements: [{ id: `${id}#check`, required: true }],
        disabled: [],
        findings: [],
        logs: [],
        outputs: [],
      };
    },
  });
  try {
    const result = await run.executeRun({
      workspacePath: ws,
      home,
      version: "0.0.0-test",
      adapter: "fake",
      options: {},
      env: { ...process.env, JGATES_NO_CACHE: "1" },
      steps: () => [step("quiet", "clean"), step("messy", "touch:coverage.xml")],
    });
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    assert.deepEqual(result.workspaceChanges.added, ["coverage.xml"]);
    assert.deepEqual(result.workspaceChanges.entries, [{ path: "coverage.xml", change: "added", stage: "messy" }]);
    assert.ok(fs.existsSync(path.join(ws, "coverage.xml")), "JGates never deletes what the tool left");
    assert.ok(fs.existsSync(path.join(ws, "keep.txt")));
    const saved = JSON.parse(fs.readFileSync(path.join(result.runDir, "result.json"), "utf8"));
    assert.deepEqual(saved.workspaceChanges.entries, result.workspaceChanges.entries);
  } finally {
    rm(ws, home);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Retention and gc.

const DAY = 24 * 60 * 60 * 1000;

function fakeRun(home, workspaceId, runId, { ageDays = 0, bytes = 10, marks } = {}) {
  const dir = path.join(home, "workspaces", workspaceId, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const startedAt = new Date(Date.now() - ageDays * DAY).toISOString();
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ runId, startedAt, decision: "passed" }));
  fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.alloc(bytes));
  if (marks) fs.writeFileSync(path.join(dir, "marks.json"), JSON.stringify(marks));
  const t = new Date(startedAt);
  fs.utimesSync(dir, t, t);
  return dir;
}

test("gc: dry-run lists old runs and a workspace whose path is gone; without --yes nothing is deleted; --yes keeps baselines", () => {
  const home = tmp("jg-gc-home-");
  const live = tmp("jg-gc-live-");
  const gone = tmp("jg-gc-gone-");
  const outside = tmp("jg-gc-outside-");
  fs.writeFileSync(path.join(outside, "precious.txt"), "do not touch");
  try {
    const liveEntry = homeLib.registerWorkspace(live, { home });
    const goneEntry = homeLib.registerWorkspace(gone, { home });
    const newRun = fakeRun(home, liveEntry.id, "run_new", { ageDays: 1 });
    const oldRun = fakeRun(home, liveEntry.id, "run_old", { ageDays: 90 });
    const baseline = fakeRun(home, liveEntry.id, "run_baseline", { ageDays: 90, marks: { baseline: true } });
    const goneRun = fakeRun(home, goneEntry.id, "run_gone", { ageDays: 1 });
    // A symlink inside the data folder pointing outside it must never be followed.
    fs.symlinkSync(outside, path.join(home, "workspaces", liveEntry.id, "runs", "run_link"));
    rm(gone);
    const env = { JGATES_HOME: home };

    const dry = JSON.parse(cli(["gc", "--dry-run", "--json"], env).stdout);
    assert.equal(dry.mode, "dry-run");
    assert.deepEqual(dry.runs.map((r) => r.runId).sort(), ["run_gone", "run_old"]);
    assert.equal(dry.runs.find((r) => r.runId === "run_old").reason, "age");
    assert.deepEqual(dry.missingWorkspaces.map((w) => [w.id, w.removable]), [[goneEntry.id, true]]);
    for (const d of [newRun, oldRun, baseline, goneRun]) assert.ok(fs.existsSync(d));

    const plain = cli(["gc", "--json"], env);
    assert.equal(plain.status, 0);
    assert.equal(JSON.parse(plain.stdout).mode, "none");
    for (const d of [newRun, oldRun, baseline, goneRun]) assert.ok(fs.existsSync(d), "gc without --yes deletes nothing");

    const real = cli(["gc", "--yes", "--json"], env);
    assert.equal(real.status, 0, real.stderr);
    const applied = JSON.parse(real.stdout);
    assert.equal(applied.mode, "applied");
    assert.ok(!fs.existsSync(oldRun));
    assert.ok(!fs.existsSync(path.join(home, "workspaces", goneEntry.id)));
    assert.ok(fs.existsSync(newRun));
    assert.ok(fs.existsSync(baseline), "baseline runs survive");
    assert.ok(fs.existsSync(path.join(outside, "precious.txt")), "nothing outside the data folder is touched");
    assert.deepEqual(homeLib.listWorkspaces(home).map((w) => w.id), [liveEntry.id]);
  } finally {
    rm(home, live, gone, outside);
  }
});

test("retention by size: the oldest unprotected runs go first, per workspace and in total", () => {
  const home = tmp("jg-gc-home-");
  const ws = tmp("jg-gc-ws-");
  const ws2 = tmp("jg-gc-ws2-");
  try {
    const a = homeLib.registerWorkspace(ws, { home }).id;
    const b = homeLib.registerWorkspace(ws2, { home }).id;
    fakeRun(home, a, "r1", { ageDays: 3, bytes: 1000 });
    fakeRun(home, a, "r2", { ageDays: 2, bytes: 1000 });
    fakeRun(home, a, "r3", { ageDays: 1, bytes: 1000, marks: { preserved: true } });
    fakeRun(home, b, "r4", { ageDays: 4, bytes: 1000 });
    const policy = { maxAgeDays: 30, maxWorkspaceBytes: 2500, maxTotalBytes: 3500 };
    const plan = artifacts.planRetention(home, policy);
    const byId = Object.fromEntries(plan.runs.map((r) => [r.runId, r.reason]));
    assert.equal(byId.r1, "workspace-size");
    assert.equal(byId.r3, undefined, "preserved runs are never planned");
    assert.ok(plan.freedBytes > 0);
    assert.equal(byId.r2, undefined);
    assert.equal(byId.r4, undefined, "3 runs of about 1 KiB fit in the total");
    // A tighter total takes the oldest unprotected run across workspaces: r4 (4 days) goes before r2.
    const tight = artifacts.planRetention(home, { ...policy, maxTotalBytes: 2200 });
    assert.equal(Object.fromEntries(tight.runs.map((r) => [r.runId, r.reason])).r4, "total-size");
  } finally {
    rm(home, ws, ws2);
  }
});

test("workspaces relink: the history of the new path shows the runs of the old one", () => {
  const home = tmp("jg-rl-home-");
  const oldDir = tmp("jg-rl-old-");
  const newDir = tmp("jg-rl-new-");
  try {
    const env = { JGATES_HOME: home };
    const old = homeLib.registerWorkspace(oldDir, { home });
    fakeRun(home, old.id, "run_before_move", { ageDays: 2 });
    const newEntry = homeLib.registerWorkspace(newDir, { home });
    fakeRun(home, newEntry.id, "run_after_move", { ageDays: 1 });
    const before = JSON.parse(cli(["history", "--cwd", newDir, "--json"], env).stdout);
    assert.deepEqual(before.runs.map((r) => r.runId), ["run_after_move"]);

    const r = cli(["workspaces", "relink", old.id, "--cwd", newDir, "--json"], env);
    assert.equal(r.status, 0, r.stderr);
    const after = JSON.parse(cli(["history", "--cwd", newDir, "--json"], env).stdout);
    assert.deepEqual(after.runs.map((x) => x.runId), ["run_after_move", "run_before_move"]);
    assert.equal(after.runs[1].workspaceId, old.id);

    // The old path vanishing does not make its (relinked) history an orphan for gc.
    rm(oldDir);
    const dry = JSON.parse(cli(["gc", "--dry-run", "--json"], env).stdout);
    assert.deepEqual(dry.missingWorkspaces, []);
    assert.deepEqual(dry.runs, []);

    const bad = cli(["workspaces", "relink", "nope", "--cwd", newDir, "--json"], env);
    assert.equal(bad.status, 3);
    assert.equal(JSON.parse(bad.stdout).error.code, "WORKSPACE_NOT_FOUND");
  } finally {
    rm(home, oldDir, newDir);
  }
});
