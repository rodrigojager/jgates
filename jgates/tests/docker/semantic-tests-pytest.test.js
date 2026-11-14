import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// The Semantic test-file runner with the real engine (npm run test:docker; never part of npm test): a pytest file that
// is not in the project is placed in the workspace copy (the source volume the Quality steps use), runs there in a
// container of the local development image jgates-tools:dev with no network, the copy and the dependency volume
// mounted read-only, and is removed afterwards. Four outcomes are proved: passed (the file also proves its own limits
// from the inside), failed (the failing test is named), error (a file that does not load) and not run (the time limit).
// The project folder is byte for byte the same afterwards and no container of the run is left.
//
// With JGATES_SEMANTIC_RUNNER_RECORD=<file> the suite also writes what the image printed for each file as the
// recordings tests/fixtures/semantic-test-runner/recorded/semantic-test-runner.json holds (the default suite replays
// them: tests/semantic-test-runner.test.js).

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const dist = path.join(packageRoot, "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURES = path.join(packageRoot, "tests", "fixtures", "semantic-test-runner");
const RECORD = process.env.JGATES_SEMANTIC_RUNNER_RECORD ?? "";
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const engine = await load("core", "engine", "index.js");
const { workspaceId } = await load("core", "ids", "index.js");
const regressions = await load("core", "regressions", "index.js");
const IMAGE = engine.DEV_TOOLS_IMAGE;

const made = [];
let workspace = null;
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** Everything this suite created in the engine carries its workspace id (and the JGates labels); the cleanup selects by them only. */
function cleanup() {
  if (!workspace) return;
  const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];
  for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
  for (const name of docker(["volume", "ls", "-q", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["volume", "rm", "-f", name]);
}

before(() => {
  assert.ok(dockerAvailable(), "Docker is required for npm run test:docker (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
});

after(() => {
  try {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } finally {
    cleanup();
  }
});

function treeHash(root) {
  const h = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git") continue;
      if (e.isDirectory()) {
        h.update(`d:${next}\0`);
        walk(path.join(d, e.name), next);
      } else h.update(`f:${next}\0`).update(fs.readFileSync(path.join(d, e.name)));
    }
  };
  walk(root, "");
  return h.digest("hex");
}

const placed = (name) => fs.readFileSync(path.join(FIXTURES, "placed", name), "utf8");

/** What the workspace copy holds (outside the dependency mount), listed by a helper that mounts it read-only. */
function copyListing(volume) {
  const listed = docker([
    "run", "--rm", "--network", "none",
    "--label", "org.jgates.managed=true", "--label", "org.jgates.kind=helper", "--label", `org.jgates.workspace=${workspace}`,
    "--mount", `type=volume,src=${volume},dst=/dst,readonly`,
    IMAGE, "sh", "-c", "cd /dst && find . -path ./.venv -prune -o -print | sort",
  ]);
  assert.equal(listed.code, 0, listed.err);
  return listed.out;
}

const recorded = [];
function record(id, file, content, run) {
  if (!RECORD) return;
  recorded.push({ id, file, content, exitCode: run.exitCode, timedOut: run.timedOut, stdout: run.rawStdout ?? run.output });
}

test("a pytest file placed in the workspace copy runs in a container without network and reads as passed, failed, error and not run; nothing is left behind", { timeout: 1_800_000 }, async () => {
  const project = tmp("jgates-semantic-runner-");
  const home = tmp("jgates-semantic-runner-home-");
  fs.cpSync(path.join(FIXTURES, "python-app"), project, { recursive: true });
  const env = { ...process.env, JGATES_HOME: home, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  delete env.JGATES_IMAGE_JSON;
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  spawnSync("git", ["add", "-A"], { cwd: project });
  workspace = workspaceId(project);

  // The workspace prepares its dependencies (this is the one step with network): the copy and the dependency volume exist.
  const prepared = cli(["deps", "prepare", "--cwd", project, "--json"]);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const volume = engine.sourceVolumeName(workspace);

  const before = treeHash(project);
  const listingBefore = copyListing(volume);
  assert.match(listingBefore, /\.\/src\/inventory\.py/, "the project is in the workspace copy");

  const made = await regressions.testEnvironment({ env, home, workspace, run: "semantic-test-runner-docker" });
  assert.equal(made.ok, true, made.reason);
  const { environment } = made;
  assert.equal(environment.runtime.mode, "container");
  assert.ok(environment.dependencies.length >= 1, "the workspace's dependency volume is prepared");
  const stageDir = path.join(home, "stage");
  const run = (file, content, options = {}) => regressions.runTestFileInWorkspaceCopy(environment, { workspace, file, content, stageDir }, options);

  // passed: the file placed in a folder the copy does not have; it proves the limits from the inside.
  const passes = placed("test_passes.py");
  const ok = await run(".jgates/regressions/test_passes.py", passes);
  assert.equal(ok.outcome, "passed", `${ok.reason}\n${ok.output}`);
  assert.equal(ok.executed, true);
  assert.equal(ok.tests.pass, 4);
  assert.equal(ok.container.mode, "container");
  assert.equal(ok.container.network, "none");
  assert.equal(ok.container.readOnlyTree, true);
  assert.equal(ok.container.readOnlyRoot, true);
  assert.deepEqual(ok.container.dependencies.map((d) => d.target), ["/workspace/.venv"], "the prepared dependency volume, read-only, at .venv");
  assert.equal(ok.placed, true);
  assert.equal(ok.removed, true);
  assert.equal(copyListing(volume), listingBefore, "the placed file and the folders its placement created are gone");
  record("passes", ".jgates/regressions/test_passes.py", passes, ok);

  // failed: the failing test is named.
  const fails = placed("test_fails.py");
  const bad = await run("tests/test_fails.py", fails);
  assert.equal(bad.outcome, "failed", `${bad.reason}\n${bad.output}`);
  assert.equal(bad.executed, true);
  assert.deepEqual([bad.tests.pass, bad.tests.fail], [1, 1]);
  assert.match(bad.reason, /test_total_ignores_the_discount/);
  assert.doesNotMatch(bad.reason, /test_total_of_one_item/);
  assert.equal(copyListing(volume), listingBefore);
  record("fails", "tests/test_fails.py", fails, bad);

  // error: a file that does not load is not a verdict on any test.
  const broken = placed("test_broken.py.txt");
  const err = await run("tests/test_broken.py", broken);
  assert.equal(err.outcome, "error", `${err.reason}\n${err.output}`);
  assert.equal(err.executed, true);
  assert.notEqual(err.outcome, "failed");
  assert.equal(copyListing(volume), listingBefore);
  record("broken", "tests/test_broken.py", broken, err);

  // not run: the time limit stops it; nothing was observed, and the container is gone.
  const slow = placed("test_slow.py");
  const late = await run("tests/test_slow.py", slow, { timeoutMs: 8_000 });
  assert.equal(late.outcome, "not-run", `${late.reason}\n${late.output}`);
  assert.equal(late.timedOut, true);
  assert.equal(late.code, "TEST_TIMEOUT");
  assert.equal(late.removed, true);
  assert.equal(docker(["ps", "-aq", "--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`]).out.trim(), "", "no container of the run is left");
  assert.equal(copyListing(volume), listingBefore);

  // A path the project already has is never replaced.
  const clash = await run("tests/test_inventory.py", passes);
  assert.equal(clash.outcome, "not-run");
  assert.equal(clash.code, "WORKSPACE_COPY_UNAVAILABLE");
  assert.equal(clash.placed, false);
  assert.equal(copyListing(volume), listingBefore);

  // A runner without a recipe is answered as not supported and nothing is started.
  const started = docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${workspace}`]).out;
  const go = await run("pkg/calc_test.go", "package pkg\n");
  assert.deepEqual([go.outcome, go.executed, go.code], ["not-run", false, "TEST_RUNNER_NOT_SUPPORTED"]);
  assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${workspace}`]).out, started);

  assert.equal(treeHash(project), before, "the project folder is byte for byte the same");

  if (RECORD) {
    fs.mkdirSync(path.dirname(RECORD), { recursive: true });
    fs.writeFileSync(RECORD, JSON.stringify({ schemaVersion: 1, source: "Recorded from jgates-tools:dev by tests/docker/semantic-tests-pytest.test.js", runs: recorded }, null, 1) + "\n");
  }
});
