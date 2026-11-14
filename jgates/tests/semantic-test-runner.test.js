// The Semantic test-file runner (jgates/src/core/regressions): one recipe per test runner (pytest and node:test), a file
// placed in the workspace copy, and the answer for a runner without a recipe. The tests run in containers of the tools
// image: here the fake engine replays recorded container runs
// (tests/fixtures/semantic-test-runner/recorded/semantic-test-runner.json), so no test file runs on the host. The
// real-engine counterpart is tests/docker/semantic-tests-pytest.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = (name) => pathToFileURL(path.resolve(here, "..", "..", "tests", "v2", "fixtures", name)).href;
const H = await import(FIX("complementary-b/helpers.mjs"));
const regressions = await H.load("core/regressions/index.js");
const { workspaceId } = await H.load("core/ids/index.js");
const { depsStateFile } = await H.load("core/deps/index.js");
const { sourceVolumeName } = await H.load("core/engine/index.js");

const FIXTURES = path.join(here, "fixtures", "semantic-test-runner");
const ENGINE = path.join(FIXTURES, "replay-engine.cjs");
const placed = (name) => fs.readFileSync(path.join(FIXTURES, "placed", name), "utf8");
const projectFile = (rel) => fs.readFileSync(path.join(FIXTURES, "python-app", ...rel.split("/")), "utf8");
const DEPS = { py: "jgates-deps-test-py", node: "jgates-deps-test-node" };

/** A Git workspace holding the Python fixture, its synchronized copy in the fake engine's source volume, and prepared dependencies. */
async function setup(prefix) {
  const files = { "src/inventory.py": projectFile("src/inventory.py"), "tests/test_inventory.py": projectFile("tests/test_inventory.py"), "requirements.txt": projectFile("requirements.txt"), "package.json": "{}\n" };
  const ws = H.setupWorkspace(prefix, files);
  Object.assign(ws.env, H.containerEnv(ws, { engine: ENGINE }));
  const id = workspaceId(ws.dir);
  const volume = path.join(ws.root, "engine-state", "volumes", sourceVolumeName(id));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(volume, rel)), { recursive: true });
    fs.writeFileSync(path.join(volume, rel), text);
  }
  const state = depsStateFile(ws.home, id);
  fs.mkdirSync(path.dirname(state), { recursive: true });
  const unit = (volumeName, manager) => ({ volume: volumeName, key: "0".repeat(64), manager, installRoot: ".", installedAt: "2026-11-14T00:00:00.000Z" });
  fs.writeFileSync(state, JSON.stringify({ schemaVersion: 1, units: { py: unit(DEPS.py, "pip"), app: unit(DEPS.node, "npm") }, failures: {} }, null, 2));
  const prepared = await regressions.testEnvironment({ env: ws.env, home: ws.home, workspace: id, run: "semantic-test-runner" });
  assert.equal(prepared.ok, true, prepared.reason);
  const stageDir = path.join(ws.root, "stage");
  const run = (file, content, options) => regressions.runTestFileInWorkspaceCopy(prepared.environment, { workspace: id, file, content, stageDir }, options);
  return { ws, id, volume, environment: prepared.environment, run, stageDir };
}

/** Every path of a folder, relative, sorted (what the workspace copy holds). */
function listing(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      out.push(e.isDirectory() ? `${next}/` : next);
      if (e.isDirectory()) walk(path.join(dir, e.name), next);
    }
  };
  walk(root, "");
  return out.sort();
}

const helpers = (ws, step) => H.engineCalls(ws).filter((args) => args[0] === "run" && args.includes(`org.jgates.workspace-copy=${step}`));

test("pytest: a file placed in the workspace copy runs in a container without network, with the copy and the dependency volume read-only, and reads as passed, failed, error and not run", async () => {
  const s = await setup("runner-pytest");
  try {
    const before = H.treeHash(s.ws.dir);
    const copyBefore = listing(s.volume);

    // passed: a folder the copy does not have is created for the file and taken away with it.
    const ok = await s.run(".jgates/regressions/test_passes.py", placed("test_passes.py"));
    assert.equal(ok.outcome, "passed", `${ok.reason}\n${ok.output}`);
    assert.equal(ok.executed, true);
    assert.equal(ok.tests.pass, 4);
    assert.deepEqual([ok.placed, ok.removed], [true, true]);
    assert.deepEqual({ ...ok.container, name: "-", user: "-" }, {
      mode: "container", image: H.TOOLS_IMAGE_ID, name: "-", network: "none", readOnlyTree: true, readOnlyRoot: true, user: "-",
      limits: { memoryMb: 1024, cpus: 1, pids: 256, tmpfsMb: 64, timeoutSeconds: 60 },
      dependencies: [{ volume: DEPS.py, target: "/workspace/.venv" }],
    });
    const containers = H.testContainers(s.ws);
    assert.equal(containers.length, 1);
    const [c] = containers;
    assert.equal(c.network, "none");
    assert.equal(c.readOnlyRoot, true);
    assert.deepEqual(c.capDrop, ["ALL"]);
    assert.ok(c.user && !/^(root|0)(:|$)/.test(c.user), `never root: ${c.user}`);
    assert.equal(c.labels["org.jgates.test-runner"], "pytest");
    assert.equal(c.labels["org.jgates.managed"], "true");
    assert.deepEqual(c.mounts, [
      { type: "volume", src: sourceVolumeName(s.id), dst: "/workspace", readonly: true },
      { type: "volume", src: DEPS.py, dst: "/workspace/.venv", readonly: true },
    ], "the workspace copy and the dependency volume, both read-only; never the project folder");
    assert.equal(c.command[0], "sh");
    assert.equal(c.command.at(-2), "pytest");
    assert.equal(c.command.at(-1), ".jgates/regressions/test_passes.py");
    assert.match(c.command[2], /exec pytest -p no:cacheprovider/);
    assert.deepEqual(copyBefore, listing(s.volume), "the placed file and the folders its placement created are gone");

    // failed: the failing test is named, the passing one is not.
    const bad = await s.run("tests/test_fails.py", placed("test_fails.py"));
    assert.equal(bad.outcome, "failed", `${bad.reason}\n${bad.output}`);
    assert.deepEqual([bad.tests.pass, bad.tests.fail], [1, 1]);
    assert.equal(bad.reason, "failing: tests/test_fails.py::test_total_ignores_the_discount");
    assert.match(bad.output, /FAILED tests\/test_fails\.py::test_total_ignores_the_discount/);
    assert.doesNotMatch(bad.output, /\/workspace\//, "container paths are masked");
    assert.deepEqual(copyBefore, listing(s.volume));

    // error: a file that does not load gives no verdict on any test; a file with no test is an error too.
    const broken = await s.run("tests/test_broken.py", placed("test_broken.py.txt"));
    assert.equal(broken.outcome, "error", broken.output);
    assert.equal(broken.executed, true);
    assert.match(broken.reason, /1 error\(s\) before a verdict \(tests\/test_broken\.py\)/);
    const empty = await s.run("tests/test_empty.py", "def helper():\n    return 1\n");
    assert.deepEqual([empty.outcome, empty.reason], ["error", "the file declares no test"]);

    // not run: the time limit stops it, nothing was observed.
    const late = await s.run("tests/test_slow.py", placed("test_slow.py"), { timeoutMs: 1500 });
    assert.deepEqual([late.outcome, late.executed, late.timedOut, late.code], ["not-run", false, true, "TEST_TIMEOUT"]);
    assert.match(late.reason, /did not finish within 2 s/);
    assert.deepEqual([late.placed, late.removed], [true, true]);
    assert.deepEqual(copyBefore, listing(s.volume), "removed even when the run is stopped by the time limit");

    // Every run placed and removed its file in the copy, and the project folder never changed.
    assert.equal(helpers(s.ws, "place").length, 5);
    assert.equal(helpers(s.ws, "remove").length, 5);
    for (const args of H.engineCalls(s.ws).filter((a) => a[0] === "run")) {
      assert.ok(args.some((a, i) => args[i - 1] === "--network" && a === "none"), "no container has a network");
      assert.ok(!args.some((a) => a.includes(s.ws.dir)), "the project folder is never mounted");
    }
    assert.equal(H.treeHash(s.ws.dir), before, "the project folder is byte for byte the same");
    assert.deepEqual(fs.readdirSync(s.stageDir), [], "no staged copy of the file is left");
  } finally {
    s.ws.cleanup();
  }
});

test("pytest: without the prepared dependencies the missing package is named, and a path the project already has is never replaced", async () => {
  const s = await setup("runner-pytest-nodeps");
  try {
    fs.rmSync(depsStateFile(s.ws.home, s.id));
    const noDeps = await regressions.testEnvironment({ env: s.ws.env, home: s.ws.home, workspace: s.id, run: "semantic-test-runner" });
    const run = (file, content) => regressions.runTestFileInWorkspaceCopy(noDeps.environment, { workspace: s.id, file, content, stageDir: s.stageDir });
    const missing = await run(".jgates/regressions/test_passes.py", placed("test_passes.py"));
    assert.equal(missing.outcome, "error");
    assert.equal(missing.dependenciesMissing, true);
    assert.match(missing.reason, /^DEPENDENCIES_NOT_PREPARED: the test needs the package six/);
    assert.deepEqual(H.testContainers(s.ws)[0].mounts.map((m) => m.dst), ["/workspace"]);

    const projectTest = listing(s.volume).filter((p) => p === "tests/test_inventory.py");
    const clash = await run("tests/test_inventory.py", placed("test_passes.py"));
    assert.deepEqual([clash.outcome, clash.executed, clash.code, clash.placed], ["not-run", false, "WORKSPACE_COPY_UNAVAILABLE", false]);
    assert.equal(fs.readFileSync(path.join(s.volume, "tests", "test_inventory.py"), "utf8"), projectFile("tests/test_inventory.py"), "the project's own file in the copy is untouched");
    assert.deepEqual(listing(s.volume).filter((p) => p === "tests/test_inventory.py"), projectTest);
    assert.equal(H.testContainers(s.ws).length, 1, "a refused placement starts no test container");
  } finally {
    s.ws.cleanup();
  }
});

test("node:test recipe: a fixture runs as before, and the same recipe runs a file placed in the workspace copy with its node_modules volume read-only", async () => {
  const s = await setup("runner-node");
  try {
    const FORMAT_TEST = H.FORMAT_TEST;
    const fx = regressions.writeFixture(path.join(s.ws.root, "fx"), [{ path: "src/format.js", content: H.FORMAT }, { path: "test/format.test.mjs", content: FORMAT_TEST }]);
    const viaFixture = await regressions.runTestFile(s.environment, fx, "test/format.test.mjs");
    assert.equal(viaFixture.outcome, "passed", viaFixture.output);
    assert.equal(viaFixture.tests.total, 1);
    assert.deepEqual(H.testContainers(s.ws)[0].mounts, [{ type: "bind", src: path.resolve(fx.dir), dst: "/workspace", readonly: true }]);
    assert.deepEqual(H.testContainers(s.ws)[0].command, ["node", "--test-reporter=tap", "test/format.test.mjs"]);

    const copyBefore = listing(s.volume);
    const inCopy = (value) => `import test from "node:test";
import assert from "node:assert/strict";
test("labels name the item", () => assert.equal(${value}, 3));
`;
    const good = await s.run(".jgates/regressions/label.test.mjs", inCopy("3"));
    assert.equal(good.outcome, "passed", good.output);
    assert.deepEqual(good.container.dependencies, [{ volume: DEPS.node, target: "/workspace/node_modules" }]);
    assert.deepEqual(H.testContainers(s.ws).at(-1).mounts, [
      { type: "volume", src: sourceVolumeName(s.id), dst: "/workspace", readonly: true },
      { type: "volume", src: DEPS.node, dst: "/workspace/node_modules", readonly: true },
    ]);
    assert.equal(H.testContainers(s.ws).at(-1).labels["org.jgates.test-runner"], "node:test");
    const bad = await s.run(".jgates/regressions/label.test.mjs", inCopy("4"));
    assert.equal(bad.outcome, "failed", bad.output);
    assert.deepEqual([bad.tests.pass, bad.tests.fail], [0, 1]);
    assert.deepEqual(listing(s.volume), copyBefore);
  } finally {
    s.ws.cleanup();
  }
});

test("a file of a runner without a recipe (Jest, Vitest, go test, cargo test, dotnet test) is answered as not supported with a reason code, and nothing is started", async () => {
  const s = await setup("runner-unsupported");
  try {
    const fx = regressions.writeFixture(path.join(s.ws.root, "fx"), [{ path: "src/a.js", content: "exports.a = 1;\n" }]);
    const cases = [
      ["src/cart.test.ts", undefined, /Jest or Vitest is not supported/],
      ["src/cart.spec.tsx", undefined, /Jest or Vitest is not supported/],
      ["src/cart.test.js", "jest", /Jest is not supported/],
      ["src/cart.test.js", "vitest", /Vitest is not supported/],
      ["pkg/cart_test.go", undefined, /go test is not supported/],
      ["pkg/cart_test.go", "go test", /go test is not supported/],
      ["tests/cart.rs", undefined, /cargo test is not supported/],
      ["src/cart.js", "cargo test", /cargo test is not supported/],
      ["Cart.Tests/CartTests.cs", undefined, /dotnet test is not supported/],
      ["Cart.Tests/Cart.cs", "dotnet test", /dotnet test is not supported/],
      ["src/readme.txt", undefined, /no test runner runs src\/readme\.txt/],
      ["src/inventory.py", undefined, /no test runner runs src\/inventory\.py/],
    ];
    for (const [file, runner, reason] of cases) {
      const options = runner === undefined ? {} : { runner };
      const viaFixture = await regressions.runTestFile(s.environment, fx, file, options);
      const viaCopy = await s.run(file, "x\n", options);
      for (const r of [viaFixture, viaCopy]) {
        assert.deepEqual([r.outcome, r.executed, r.code, r.container], ["not-run", false, "TEST_RUNNER_NOT_SUPPORTED", null], `${file} (${String(runner)})`);
        assert.match(r.reason, reason);
        assert.match(r.reason, /^TEST_RUNNER_NOT_SUPPORTED: /);
      }
      assert.equal(viaCopy.placed, false);
    }
    // The runners that do have a recipe are still found by their files and by the runner a proposal names.
    assert.equal(regressions.recipeFor("tests/test_cart.py")?.id, "pytest");
    assert.equal(regressions.recipeFor("cart_test.py", "pytest")?.id, "pytest");
    assert.equal(regressions.recipeFor("test/cart.test.mjs")?.id, "node:test");
    assert.equal(regressions.recipeFor("src/inventory.py"), null, "a module of the project is not a test file");
    // Nothing was started: no engine call that runs a container, no place or removal in the copy.
    assert.deepEqual(H.engineCalls(s.ws).filter((a) => a[0] === "run"), []);
    assert.equal(fs.existsSync(s.stageDir), false);
  } finally {
    s.ws.cleanup();
  }
});

test("the summaries of pytest and node:test are read the way the recipes need", () => {
  const summary = regressions.pytestSummary;
  assert.deepEqual(summary("....\n4 passed in 0.05s\n"), { total: 4, pass: 4, fail: 0, cancelled: 0 });
  assert.deepEqual(summary("F.s\n=========================== 1 failed, 1 passed, 1 skipped in 0.04s ===========================\n"), { total: 3, pass: 1, fail: 1, cancelled: 0 });
  assert.deepEqual(summary("1 error in 0.05s\n"), { total: 1, pass: 0, fail: 0, cancelled: 1 });
  assert.deepEqual(summary("no tests ran in 0.01s\n"), { total: 0, pass: 0, fail: 0, cancelled: 0 });
  assert.equal(summary("Traceback (most recent call last):\n"), null);
  assert.deepEqual(regressions.pytestFailures("FAILED t/a.py::test_x - assert 1 == 2\nFAILED t/a.py::test_y\nERROR t/b.py\n"), ["t/a.py::test_x", "t/a.py::test_y"]);
  assert.equal(regressions.tapSummary("# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n")?.total, 2);
});
