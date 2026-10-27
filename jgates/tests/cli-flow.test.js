import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// The whole non-interactive flow on the main fixture: init, discover, plan and run through the CLI, without Docker.
// The interpreter is given by absolute path (JGATES_PYTHON) and PATH holds an empty folder, as in run-bridge.test.js.

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "..", "dist", "cli", "main.js");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const mainFixture = require("../../tests/fixtures/jgates/main-fixture.js");
const { findOnPath } = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "bridge", "index.js")).href);
const { EXIT_CODES } = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "contract", "index.js")).href);

const validateResult = new Ajv2020({ strict: true, allErrors: true }).compile(JSON.parse(fs.readFileSync(path.resolve(here, "..", "schemas", "result", "result.schema.json"), "utf8")));
const PYTHON = findOnPath("python") ?? findOnPath("python3");
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const NO_DOCKER = { DOCKER_CONTEXT: "", DOCKER_HOST: "tcp://127.0.0.1:1", GITHUB_BASE_REF: "", GITHUB_HEAD_REF: "", GITHUB_SHA: "", GITLAB_CI: "" };

/** A fixture project with its own data folder and a CLI runner that never finds a scanner on the machine. */
function project() {
  assert.ok(PYTHON, "python not found on PATH: put the repository .venv/bin first on PATH");
  const { dir } = mainFixture.createMainFixture();
  const home = tmp("jgates-flow-home-");
  const emptyBin = tmp("jgates-flow-bin-");
  const env = { ...process.env, ...NO_DOCKER, JGATES_HOME: home, JGATES_PYTHON: PYTHON, PATH: emptyBin };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 600_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const cleanup = () => {
    mainFixture.removeFixture(dir);
    for (const d of [home, emptyBin]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, home, cli, cleanup };
}

function one(r) {
  try {
    return JSON.parse(r.out);
  } catch (error) {
    throw new Error(`stdout is not one JSON document (${error.message}):\n${r.out}\n${r.err}`);
  }
}

function assertValidResult(doc) {
  assert.ok(validateResult(doc), JSON.stringify(validateResult.errors, null, 2));
  assert.equal(doc.exitCode, EXIT_CODES[doc.decision]);
}

const gitStatus = (dir) => spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" }).stdout;

test("init, discover, plan and run on the main fixture end with valid JSON at every step", () => {
  const p = project();
  try {
    const init = p.cli("init", "--cwd", p.dir, "--no-interactive", "--json");
    assert.equal(init.code, 0, init.out + init.err);
    one(init);

    const discover = p.cli("discover", "--cwd", p.dir, "--json");
    assert.equal(discover.code, 0, discover.out + discover.err);
    const found = one(discover);
    const inventory = found.inventory ?? found;
    const roots = inventory.classifications.map((c) => c.componentRoot).sort();
    assert.deepEqual(roots, ["api", "libs/shared", "web"]);

    const plan = p.cli("plan", "--cwd", p.dir, "--no-interactive", "--json");
    assert.equal(plan.code, 0, plan.out + plan.err);
    const planned = one(plan);
    assert.ok(planned.plan.groups.willRun.length > 0);

    const run = p.cli("run", "--cwd", p.dir, "--no-interactive", "--json");
    const result = one(run);
    assertValidResult(result);
    assert.equal(run.code, result.exitCode);
    // The run executed the plan the CLI showed.
    assert.equal(result.selection.planHash, planned.planHash);
    assert.equal(result.selection.planSource, "built");
    assert.ok(result.artifacts.plan);
    assert.ok(fs.existsSync(path.join(result.runDir, "plan.json")));
    assert.ok(!result.runDir.startsWith(p.dir));
  } finally {
    p.cleanup();
  }
});

test("run --skip capability:unit leaves the run reduced, lists the shutdown and changes no project file", () => {
  const p = project();
  try {
    assert.equal(p.cli("init", "--cwd", p.dir, "--profile", "strict", "--no-interactive", "--json").code, 0);
    const statusBefore = gitStatus(p.dir);

    const full = one(p.cli("run", "--cwd", p.dir, "--no-interactive", "--json"));
    assertValidResult(full);
    assert.equal(full.reduced, false);
    assert.ok(full.requirements.find((r) => r.id === "quality-bridge.project-tests")?.required);

    const run = p.cli("run", "--cwd", p.dir, "--skip", "capability:unit", "--no-interactive", "--json");
    const result = one(run);
    assertValidResult(result);
    assert.equal(result.reduced, true);
    const overrides = result.selection.overrides.map((o) => o.id);
    assert.ok(overrides.includes("quality-bridge.project-tests"), JSON.stringify(result.selection.overrides));
    assert.deepEqual(result.selection.request.skip, ["capability:unit"]);
    assert.ok(result.selection.planOverrides.some((o) => o.source === "--skip" && o.selector === "capability:unit"));
    assert.equal(result.requirements.find((r) => r.id === "quality-bridge.project-tests").required, false);
    assert.equal(result.stages.find((s) => s.id === "quality-bridge.project-tests").state, "disabled");
    assert.equal(result.workspaceChanges.added.length + result.workspaceChanges.modified.length + result.workspaceChanges.removed.length, 0);

    // Nothing changed in the project, and the only difference from a clean checkout is the JGates configuration.
    assert.equal(gitStatus(p.dir), statusBefore);
    const lines = gitStatus(p.dir).split("\n").filter(Boolean);
    assert.ok(lines.every((l) => /\sjgates\.yml$|\s\.jgates\//.test(l)), lines.join("\n"));
    assert.ok(lines.length > 0);
  } finally {
    p.cleanup();
  }
});
