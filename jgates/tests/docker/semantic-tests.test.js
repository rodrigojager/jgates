import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { docker, dockerAvailable } from "./dev-docker.mjs";

// Real-engine test of the Semantic test-file runner (npm run test:docker; never part of npm test): the `node:test` recipe
// runs a test file of a prepared tree in a container of the local development image jgates-tools:dev (the tree read-only
// at /workspace, no network, the step user), and its outcomes are the ones the runner reads from the TAP summary
// (passed, failed, error). The project's own folder is never involved: the trees are built by host code.
//
// With JGATES_SEMANTIC_TESTS_RECORD=1 the suite also writes what the image printed for every scenario into
// tests/v2/fixtures/complementary-b/recorded/semantic-tests.json, in the shape the replay engine of the default suite
// reads (tests/v2/fixtures/complementary-b/replay-engine.cjs): one run per scenario, with its file, the conditions on the
// tree that select it, the exit code and the raw standard output and error. Runs already in that file whose id is not
// one of these scenarios (the one that needs a prepared dependency volume) are kept as they are.

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const dist = path.join(packageRoot, "dist");
const RECORDINGS = path.resolve(packageRoot, "..", "tests", "v2", "fixtures", "complementary-b", "recorded", "semantic-tests.json");
const RECORD = process.env.JGATES_SEMANTIC_TESTS_RECORD === "1";
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
const engine = await load("core", "engine", "index.js");
const runnerModule = await load("core", "regressions", "runner.js");
const fixtureModule = await load("core", "regressions", "fixture.js");
const containerModule = await load("core", "runner", "container.js");
const IMAGE = engine.DEV_TOOLS_IMAGE;
const WORKSPACE = `semantic-tests-${crypto.randomBytes(4).toString("hex")}`;

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};

/** Everything this suite created in the engine carries its workspace id (and the JGates labels); the cleanup selects by them only. */
function cleanup() {
  const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${WORKSPACE}`];
  for (const id of docker(["ps", "-aq", ...filters]).out.split(/\s+/).filter(Boolean)) docker(["rm", "-f", id]);
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

const PAGINATE_FILE = ".jgates/regressions/paginate-pages.test.mjs";
const paginate = (end) => `export function paginate(list, size) {\n  const pages = [];\n  for (let start = 0; start < list.length; start += size) {\n    const end = ${end};\n    pages.push(list.slice(start, end));\n  }\n  return pages;\n}\n`;
const PAGINATE_TEST = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { paginate } from "../../src/paginate.js";',
  "",
  'test("every page holds at most size items and the pages cover the list exactly once", () => {',
  "  const pages = paginate([1, 2, 3], 1);",
  "  for (const [i, page] of pages.entries()) assert.ok(page.length <= 1, `page ${i + 1} of size 1 has ${page.length} items`);",
  "});",
  "",
].join("\n");
const format = (body) => `export const label = (n) => ${body};\n`;
const FORMAT_FILE = "test/format.test.mjs";
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

/**
 * The scenarios: a tree, the test file to run, the outcome the recipe must read, and (for the recording) the conditions
 * that select the recording on a tree. `when` is what tells two runs of the same file apart (before and after a patch).
 */
const SCENARIOS = [
  {
    id: "reproducer-syntax-error",
    file: PAGINATE_FILE,
    files: { [PAGINATE_FILE]: 'import test from "node:test";\nthis is not javascript\n' },
    when: [{ path: PAGINATE_FILE, contains: "this is not javascript" }],
    outcome: "error",
  },
  {
    id: "needs-package-without-dependencies",
    file: PAGINATE_FILE,
    files: { [PAGINATE_FILE]: 'import test from "node:test";\nimport leftPad from "left-pad";\ntest("left-pad pads to the requested width", () => { leftPad("a", 3); });\n' },
    when: [{ path: PAGINATE_FILE, contains: 'from "left-pad"' }],
    dependencies: false,
    outcome: "error",
    dependenciesMissing: true,
  },
  {
    id: "paginate-bound-too-large",
    file: PAGINATE_FILE,
    files: { "src/paginate.js": paginate("start + size + 1"), [PAGINATE_FILE]: PAGINATE_TEST },
    when: [{ path: "src/paginate.js", contains: "start + size + " }],
    outcome: "failed",
  },
  {
    id: "paginate-bound-correct",
    file: PAGINATE_FILE,
    files: { "src/paginate.js": paginate("start + size"), [PAGINATE_FILE]: PAGINATE_TEST },
    when: [{ path: "src/paginate.js", contains: "start + size;" }],
    outcome: "passed",
  },
  {
    id: "format-label-item",
    file: FORMAT_FILE,
    files: { "src/format.js": format("`Item ${n}`"), [FORMAT_FILE]: FORMAT_TEST },
    when: [{ path: "src/format.js", contains: "`Item ${n}`" }],
    outcome: "passed",
  },
  {
    id: "format-label-hash",
    file: FORMAT_FILE,
    files: { "src/format.js": format("`#${n}`"), [FORMAT_FILE]: FORMAT_TEST },
    when: [{ path: "src/format.js", contains: "`#${n}`" }],
    outcome: "failed",
  },
];

let environmentPromise = null;
function environment() {
  environmentPromise ??= (async () => {
    const env = { ...process.env, JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
    delete env.JGATES_IMAGE_JSON;
    // The real engine (the node test runs name a missing engine client by default, tests/setup/in-image.mjs).
    if (env.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete env.JGATES_CONTAINER_RUNTIME;
    const prepared = await runnerModule.testEnvironment({ env, home: tmp("jgates-semantic-tests-home-"), workspace: WORKSPACE, run: "semantic-tests" });
    assert.ok(prepared.ok, JSON.stringify(prepared));
    assert.equal(prepared.environment.runtime.mode, "container", "the tests run in a container, not natively");
    return prepared.environment;
  })();
  return environmentPromise;
}

const recorded = [];

/** The raw run of the recipe's command in the same container the runner starts (for the recording: stdout and stderr apart). */
async function rawRun(env, scenario, fixture) {
  const recipe = runnerModule.TEST_RECIPES["node:test"];
  const name = `jgates-test-${crypto.randomBytes(6).toString("hex")}`;
  return engine.runInEngine(
    {
      image: env.runtime.image,
      command: recipe.command(scenario.file),
      name,
      labels: engine.engineLabels({ kind: "step", version: env.labels.version, workspace: WORKSPACE, run: "semantic-tests", extra: { [runnerModule.LABEL_TEST_RUNNER]: recipe.id } }),
      mounts: [{ type: "bind", source: fixture.dir, target: "/workspace", readonly: true }],
      network: "none",
      user: containerModule.stepUser(),
      env: { ...recipe.env },
      workdir: "/workspace",
      resources: { ...runnerModule.TEST_LIMITS },
      timeoutMs: runnerModule.TEST_TIMEOUT_MS,
    },
    env.runtime.engine,
  );
}

for (const scenario of SCENARIOS) {
  test(`semantic tests node:test: ${scenario.id} reads as ${scenario.outcome} from a container of the tools image`, async () => {
    const env = await environment();
    const dir = path.join(tmp("jgates-semantic-tests-tree-"), "tree");
    const fixture = fixtureModule.writeFixture(dir, Object.entries(scenario.files).map(([p, content]) => ({ path: p, content })));
    const run = await runnerModule.runTestFile(env, fixture, scenario.file);
    assert.equal(run.outcome, scenario.outcome, `${run.reason ?? ""}\n${run.output}`);
    assert.equal(run.container?.mode, "container");
    assert.equal(run.container.network, "none");
    assert.equal(run.container.readOnlyTree, true);
    assert.equal(run.dependenciesMissing, scenario.dependenciesMissing ?? false);
    if (scenario.outcome === "passed") assert.equal(run.exitCode, 0);
    else assert.notEqual(run.exitCode, 0);
    assert.equal(docker(["ps", "-aq", "--filter", `label=org.jgates.workspace=${WORKSPACE}`]).out.trim(), "", "no test container is left");
    if (RECORD) {
      const raw = await rawRun(env, scenario, fixture);
      assert.equal(raw.exitCode, run.exitCode, "the recorded run ended as the checked one did");
      recorded.push({
        id: scenario.id,
        file: scenario.file,
        ...(scenario.dependencies === undefined ? {} : { dependencies: scenario.dependencies }),
        when: scenario.when,
        exitCode: raw.exitCode,
        stdout: raw.stdout,
        stderr: raw.stderr,
      });
    }
    fixtureModule.removeFixture(dir);
  });
}

test("semantic tests node:test: the recordings are written in the shape the replay engine reads", () => {
  if (!RECORD) return; // Nothing to write unless asked for.
  const existing = fs.existsSync(RECORDINGS) ? JSON.parse(fs.readFileSync(RECORDINGS, "utf8")) : { schemaVersion: 1, runs: [] };
  const ids = new Set(recorded.map((r) => r.id));
  const order = [...SCENARIOS.map((s) => s.id), ...existing.runs.map((r) => r.id)];
  const merged = [...existing.runs.filter((r) => !ids.has(r.id)), ...recorded].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const doc = {
    schemaVersion: 1,
    source: "Recorded from node --test-reporter=tap runs inside the tools image by jgates/tests/docker/semantic-tests.test.js (JGATES_SEMANTIC_TESTS_RECORD=1); a run it cannot make without a prepared dependency volume stays as written by hand.",
    matching: existing.matching ?? "The first run whose file is the container's test file, whose dependencies flag (when set) says whether a dependency volume is mounted, and whose when-conditions (a tree file that contains / lacks a text) all hold.",
    runs: merged,
  };
  fs.writeFileSync(RECORDINGS, JSON.stringify(doc, null, 2) + "\n");
  assert.ok(merged.length >= SCENARIOS.length);
});
