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
// With JGATES_SEMANTIC_RUNNER_RECORD=<file> the suite also writes what the image printed for each file into <file>, in
// the shape of tests/fixtures/semantic-test-runner/recorded/semantic-test-runner.json (the default suite replays it:
// tests/semantic-test-runner.test.js, through tests/fixtures/semantic-test-runner/replay-engine.cjs). Each recording is a
// raw run of the recipe's command in the container the runner starts (stdout and stderr apart, unmasked), on a
// read-only tree that holds what the workspace copy holds plus the test file, with the dependency volume mounted where
// the recording says so. Runs of <file> (or of the default recordings when <file> does not exist yet) whose id is not
// recorded here (the one that never finishes) are kept as they are.

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
const { stepUser } = await load("core", "runner", "container.js");
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

const DEFAULT_RECORDINGS = path.join(FIXTURES, "recorded", "semantic-test-runner.json");
const FORMAT_SOURCE = "export const label = (n) => `Item ${n}`;\n";
const FORMAT_TEST = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { label } from "../src/format.js";',
  "",
  'test("labels name the item", () => {',
  '  assert.strictEqual(label(3), "Item 3");',
  "});",
  "",
].join("\n");
const recorded = [];

/**
 * The raw run of a recipe's command in the same container the runner starts (for the recording: stdout and stderr apart,
 * unmasked): the tree is the workspace copy's files plus `extra`, mounted read-only at /workspace, with the prepared
 * dependency volumes on their mount points when `dependencies` is true.
 */
async function rawRun(environment, { runner, file, files, dependencies }) {
  const recipe = regressions.TEST_RECIPES[runner];
  const deps = dependencies ? regressions.dependencyMounts(environment, recipe) : [];
  if (dependencies) assert.ok(deps.length > 0, `a prepared dependency volume for ${runner}`);
  const dir = path.join(tmp("jgates-semantic-runner-raw-"), "tree");
  const fixture = regressions.writeFixture(dir, files, { mountPoints: deps.map((d) => d.mountPoint) });
  try {
    return await engine.runInEngine(
      {
        image: environment.runtime.image,
        command: recipe.command(file),
        name: `jgates-test-${crypto.randomBytes(6).toString("hex")}`,
        labels: engine.engineLabels({ kind: "step", version: environment.labels.version, workspace: environment.labels.workspace, run: environment.labels.run, extra: { [regressions.LABEL_TEST_RUNNER]: recipe.id } }),
        mounts: [{ type: "bind", source: fixture.dir, target: "/workspace", readonly: true }, ...deps.map((d) => ({ type: "volume", source: d.volume, target: `/workspace/${d.mountPoint}`, readonly: true }))],
        network: "none",
        user: stepUser(),
        env: { ...recipe.env },
        workdir: "/workspace",
        resources: { ...regressions.TEST_LIMITS },
        timeoutMs: regressions.TEST_TIMEOUT_MS,
      },
      environment.runtime.engine,
    );
  } finally {
    regressions.removeFixture(dir);
  }
}

/**
 * Records one run in the replay shape: `when` and `dependencies` are the conditions that select it on a tree; `checked`
 * (when given) is the runner's own run of the same file, whose exit code the raw run must repeat.
 */
async function record(environment, copyFiles, { id, runner, file, content, dependencies, mount = dependencies === true, when, checked }) {
  if (!RECORD) return;
  const raw = await rawRun(environment, { runner, file, files: [...copyFiles.filter((f) => f.path !== file), { path: file, content }], dependencies: mount });
  assert.equal(raw.timedOut, false, `${id}: the recorded run finished`);
  if (checked) assert.equal(raw.exitCode, checked.exitCode, `${id}: the recorded run ended as the checked one did\n${raw.stdout}\n${raw.stderr}`);
  recorded.push({ id, runner, file, ...(dependencies === undefined ? {} : { dependencies }), ...(when ? { when } : {}), exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr });
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
  const copySource = regressions.workspaceFiles(project, env);
  assert.ok("files" in copySource, JSON.stringify(copySource));
  const copyFiles = copySource.files;

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
  const passesWhen = [{ path: ".jgates/regressions/test_passes.py", contains: "import six" }];
  await record(environment, copyFiles, { id: "pytest-passes", runner: "pytest", file: ".jgates/regressions/test_passes.py", content: passes, dependencies: true, when: passesWhen, checked: ok });
  // The same file without the dependency volume (what a workspace whose dependencies are not prepared runs).
  await record(environment, copyFiles, { id: "pytest-passes-without-dependencies", runner: "pytest", file: ".jgates/regressions/test_passes.py", content: passes, dependencies: false, when: passesWhen });

  // failed: the failing test is named.
  const fails = placed("test_fails.py");
  const bad = await run("tests/test_fails.py", fails);
  assert.equal(bad.outcome, "failed", `${bad.reason}\n${bad.output}`);
  assert.equal(bad.executed, true);
  assert.deepEqual([bad.tests.pass, bad.tests.fail], [1, 1]);
  assert.match(bad.reason, /test_total_ignores_the_discount/);
  assert.doesNotMatch(bad.reason, /test_total_of_one_item/);
  assert.equal(copyListing(volume), listingBefore);
  await record(environment, copyFiles, { id: "pytest-fails", runner: "pytest", file: "tests/test_fails.py", content: fails, when: [{ path: "tests/test_fails.py", contains: "test_total_ignores_the_discount" }], checked: bad });

  // error: a file that does not load is not a verdict on any test.
  const broken = placed("test_broken.py.txt");
  const err = await run("tests/test_broken.py", broken);
  assert.equal(err.outcome, "error", `${err.reason}\n${err.output}`);
  assert.equal(err.executed, true);
  assert.notEqual(err.outcome, "failed");
  assert.equal(copyListing(volume), listingBefore);
  await record(environment, copyFiles, { id: "pytest-does-not-load", runner: "pytest", file: "tests/test_broken.py", content: broken, when: [{ path: "tests/test_broken.py", contains: "def test_never_collected(:" }], checked: err });
  // A file with no test, and the node:test recipe on the trees the default suite replays (a fixture and the copy). The
  // copy's node:test files import node: modules only, and this Python project has no node_modules volume: they run
  // without one, and their recordings keep the condition the default suite's copy has (a node_modules volume).
  await record(environment, copyFiles, { id: "pytest-no-test", runner: "pytest", file: "tests/test_empty.py", content: "def helper():\n    return 1\n" });
  await record(environment, [{ path: "src/format.js", content: FORMAT_SOURCE }], { id: "node-test-passes-fixture", runner: "node:test", file: "test/format.test.mjs", content: FORMAT_TEST });
  const inCopy = (value) => `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("labels name the item", () => assert.equal(${value}, 3));\n`;
  await record(environment, copyFiles, { id: "node-test-fails-in-copy", runner: "node:test", file: ".jgates/regressions/label.test.mjs", content: inCopy("4"), dependencies: true, mount: false, when: [{ path: ".jgates/regressions/label.test.mjs", contains: "equal(4, 3)" }] });
  await record(environment, copyFiles, { id: "node-test-passes-in-copy", runner: "node:test", file: ".jgates/regressions/label.test.mjs", content: inCopy("3"), dependencies: true, mount: false, when: [{ path: ".jgates/regressions/label.test.mjs", contains: "equal(3, 3)" }] });

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
    const base = fs.existsSync(RECORD) ? RECORD : DEFAULT_RECORDINGS;
    const existing = JSON.parse(fs.readFileSync(base, "utf8"));
    const byId = new Map(recorded.map((r) => [r.id, r]));
    // Every run keeps its place (the first matching run wins); a recording of an id the file does not have goes last.
    const runs = [...existing.runs.map((r) => byId.get(r.id) ?? r), ...recorded.filter((r) => !existing.runs.some((e) => e.id === r.id))];
    const doc = {
      schemaVersion: 1,
      source: "Recorded from raw runs of the recipes' commands inside the tools image by jgates/tests/docker/semantic-tests-pytest.test.js (JGATES_SEMANTIC_RUNNER_RECORD=<file>); the node:test runs in the copy ran without a node_modules volume (their files import node: modules only); the run that never finishes stays as written by hand.",
      matching: existing.matching,
      runs,
    };
    fs.mkdirSync(path.dirname(RECORD), { recursive: true });
    fs.writeFileSync(RECORD, JSON.stringify(doc, null, 2) + "\n");
  }
});
