import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// A plan assembled from the old option flags (planSource: options, no jgates.yml) can be run again with run --plan:
// it is validated against the options recorded in its own bridge request, not against a
// jgates.yml that does not exist, so it never comes out as PLAN_STALE.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const { findOnPath } = await import(pathToFileURL(path.join(dist, "core", "bridge", "index.js")).href);

const PYTHON = findOnPath("python") ?? findOnPath("python3");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const NO_DOCKER = { DOCKER_CONTEXT: "", DOCKER_HOST: "tcp://127.0.0.1:1", GITHUB_BASE_REF: "", GITHUB_HEAD_REF: "", GITHUB_SHA: "", GITLAB_CI: "" };

function project() {
  assert.ok(PYTHON, "python not found on PATH: put the repository .venv/bin first on PATH");
  const dir = tmp("jgates-legacy-plan-");
  const home = tmp("jgates-legacy-home-");
  const emptyBin = tmp("jgates-legacy-bin-");
  fs.writeFileSync(path.join(dir, "app.py"), "VALUE = 1\n", "utf8");
  const env = { ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, JGATES_NO_CACHE: "1", PATH: emptyBin };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 600_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const cleanup = () => {
    for (const d of [dir, home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, cli, cleanup };
}

const one = (r) => {
  try {
    return JSON.parse(r.out);
  } catch (error) {
    throw new Error(`stdout is not one JSON document (${error.message}):\n${r.out}\n${r.err}`);
  }
};

test("a plan from the option flags runs again with run --plan and is not PLAN_STALE", () => {
  const p = project();
  try {
    assert.equal(fs.existsSync(path.join(p.dir, "jgates.yml")), false);
    const first = one(p.cli("run", "--cwd", p.dir, "--bridge-mode", "quick", "--no-interactive", "--json"));
    assert.equal(first.selection.planSource, "options");
    const planFile = path.join(first.runDir, "plan.json");
    const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
    assert.ok(plan.warnings.some((w) => w.code === "PLAN_FROM_OPTIONS"));

    const again = p.cli("run", "--cwd", p.dir, "--plan", planFile, "--no-interactive", "--json");
    assert.ok(!/PLAN_STALE/.test(again.out + again.err), again.out + again.err);
    assert.notEqual(again.code, 3, again.out + again.err);
    const second = one(again);
    assert.equal(second.selection.planSource, "file");
    assert.equal(second.selection.planHash, first.selection.planHash);
    assert.equal(second.decision, first.decision);
    assert.deepEqual(
      second.stages.map((s) => [s.id, s.state]),
      first.stages.map((s) => [s.id, s.state]),
    );
  } finally {
    p.cleanup();
  }
});

test("a plan from the option flags that was edited is still refused", () => {
  const p = project();
  try {
    const first = one(p.cli("run", "--cwd", p.dir, "--bridge-mode", "quick", "--no-interactive", "--json"));
    const planFile = path.join(first.runDir, "plan.json");
    const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
    plan.invocations[0].command.args.push("--evil");
    const edited = path.join(path.dirname(planFile), "edited-plan.json");
    fs.writeFileSync(edited, JSON.stringify(plan), "utf8");
    const refused = p.cli("run", "--cwd", p.dir, "--plan", edited, "--no-interactive", "--json");
    assert.equal(refused.code, 3, refused.out + refused.err);
    assert.match(one(refused).error.code, /PLAN_TAMPERED/);
  } finally {
    p.cleanup();
  }
});
