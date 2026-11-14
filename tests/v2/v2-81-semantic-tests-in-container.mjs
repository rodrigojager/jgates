// V2-81: the tests the Semantic side executes run in containers of the tools image, never on the host. A
// post-patch-validation run (scripted model, fake engine replaying recorded container runs) starts the reproducer and
// the nearby test as containers at both ends of the patch, under the step contract (no network, read-only root and
// tree, limits, a non-root user, the JGates labels, never a mount of the project folder); any host process that would
// run a test is made to fail while the runs happen. The claims follow the recorded outcomes. Without an engine the
// method is not applicable with the engine's own code and spends no model call; without prepared dependencies a test
// that needs a package ends as error and the run says so. `jgates regressions validate` and `incorporate` run the
// proposed test as a container too.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as H from "./fixtures/complementary-b/helpers.mjs";

const { PAGINATE_BAD, PAGINATE_GOOD, readJson, treeHash } = H;
const modules = await H.load("core/semantic-modules/index.js");
const semantic = await H.load("core/semantic/index.js");
const regressions = await H.load("core/regressions/index.js");
const { workspaceId } = await H.load("core/ids/index.js");

/** A Git workspace whose base commit has the given pagination and the format helper with its node:test file, in container mode. */
function patchWorkspace(prefix, paginate = PAGINATE_BAD) {
  const ws = H.setupWorkspace(prefix, { "src/paginate.js": paginate, "src/format.js": H.FORMAT, "test/format.test.mjs": H.FORMAT_TEST });
  const base = ws.git("rev-parse", "HEAD");
  Object.assign(ws.env, H.containerEnv(ws));
  return { ws, scope: { mode: "incremental", base, context: { allow: ["test/format.test.mjs", "src/format.js"] } } };
}

/** Runs post-patch validation with every host test process refused; returns the run and what it tried. */
async function guardedRun(ws, scope, analyst) {
  const { value, attempts } = await H.withoutHostTests(H.REPLAY_ENGINE, () => H.runModule(ws, modules.postPatch.postPatchModule(), { script: analyst.script, scope }));
  assert.deepEqual(attempts, [], "no test process is started on the host");
  return value;
}

/** Every test container of the workspace follows the step contract and sees only a fixture of the run folder. */
function assertContract(ws, containers, runId) {
  const wsId = workspaceId(ws.dir);
  assert.ok(containers.length > 0);
  for (const c of containers) {
    assert.equal(c.image, H.TOOLS_IMAGE_ID, "the tools image, by its digest");
    assert.equal(c.network, "none");
    assert.equal(c.readOnlyRoot, true);
    assert.deepEqual(c.capDrop, ["ALL"]);
    assert.ok(c.user && !/^(root|0)(:|$)/.test(c.user), `never root: ${c.user}`);
    assert.deepEqual([c.memory, c.cpus, c.pids], ["1024m", "1", "256"]);
    assert.equal(c.labels["org.jgates.managed"], "true");
    assert.equal(c.labels["org.jgates.kind"], "step");
    assert.equal(c.labels["org.jgates.workspace"], wsId);
    assert.equal(c.labels["org.jgates.test-runner"], "node:test");
    if (runId) assert.equal(c.labels["org.jgates.run"], runId);
    const tree = c.mounts.find((m) => m.dst === "/workspace");
    assert.equal(tree.type, "bind");
    assert.equal(tree.readonly, true, "the tree is read-only");
    assert.equal(c.command[0], "node");
    assert.equal(c.command[1], "--test-reporter=tap");
  }
  // No engine call of the case ever mounts the project folder.
  for (const args of H.engineCalls(ws)) {
    for (const [i, a] of args.entries()) if (args[i - 1] === "--mount") assert.ok(!a.includes(`src=${ws.dir}`), `the project folder is never mounted: ${a}`);
  }
}

test("V2-81: post-patch validation and jgates regressions run their tests in containers of the tools image, never on the host, and the claims follow the recorded runs", async (t) => {
  // The guard itself: a host process that would run a test fails while it is active.
  const self = await H.withoutHostTests(H.REPLAY_ENGINE, async () => {
    assert.throws(() => spawnSync(process.execPath, ["--test-reporter=tap", "probe.test.mjs"]), /about to run as a host process/);
  });
  assert.equal(self.attempts.length, 1);

  await t.test("reproduced and fixed, both ends in containers; regressions validate and incorporate run the proposal as a container", async () => {
    const { ws, scope } = patchWorkspace("v2-81-fixed");
    try {
      fs.writeFileSync(path.join(ws.dir, "src/paginate.js"), PAGINATE_GOOD);
      ws.git("commit", "-q", "-am", "fix: one page holds size items");
      const projectBefore = treeHash(ws.dir);
      const { result, outcome, investigation } = await guardedRun(ws, scope, H.postPatchAnalyst());
      assert.equal(outcome.state, "completed", outcome.reason);
      assert.equal(investigation.candidates.length, 0, JSON.stringify(investigation.candidates));
      const v = readJson(path.join(result.runDir, modules.postPatch.VALIDATION_FILE));
      assert.deepEqual([v.executed, v.reproduced, v.fixed, v.regressions], [true, true, true, []]);
      assert.deepEqual(v.neighbours.map((n) => [n.path, n.before.outcome, n.after.outcome]), [["test/format.test.mjs", "passed", "passed"]]);
      assert.equal(result.decision, "passed");

      // Four containers: the reproducer and the nearby test, before and after, each on the fixture of its end.
      const containers = H.testContainers(ws);
      assert.equal(containers.length, 4);
      assertContract(ws, containers, result.runId);
      const work = path.join(result.runDir, "work", "post-patch");
      assert.deepEqual(containers.map((c) => [path.basename(c.mounts[0].src), c.command[2]]), [
        ["before", ".jgates/regressions/paginate-pages.test.mjs"],
        ["after", ".jgates/regressions/paginate-pages.test.mjs"],
        ["before", "test/format.test.mjs"],
        ["after", "test/format.test.mjs"],
      ]);
      assert.ok(containers.every((c) => path.dirname(c.mounts[0].src) === work), "the fixtures live in the run folder");
      assert.deepEqual(H.replayedTests(ws).map((r) => r.recording), ["paginate-bound-too-large", "paginate-bound-correct", "format-label-item", "format-label-item"]);

      // execution.json keeps its shape and lists the facts of the container where it listed the permission flags.
      const ex = readJson(path.join(result.runDir, modules.postPatch.EXECUTION_FILE));
      assert.equal(ex.kind, "semantic-post-patch-execution");
      for (const r of [ex.before, ex.after, ex.neighbours[0].before, ex.neighbours[0].after]) {
        assert.equal(r.executed, true);
        assert.equal(r.permissions, undefined);
        assert.deepEqual({ ...r.container, name: "-", user: "-" }, { mode: "container", image: H.TOOLS_IMAGE_ID, name: "-", network: "none", readOnlyTree: true, readOnlyRoot: true, user: "-", limits: { memoryMb: 1024, cpus: 1, pids: 256, tmpfsMb: 64, timeoutSeconds: 60 }, dependencies: [] });
      }
      assert.match(ex.before.output, /not ok 1/);
      assert.doesNotMatch(ex.before.output, /\/workspace\//, "container paths are masked");
      assert.ok(!fs.existsSync(path.join(work, "before")), "fixtures are removed after their runs");
      assert.equal(treeHash(ws.dir), projectBefore, "the project is untouched");

      // jgates regressions validate and incorporate: the proposal runs as a container against a copy of the tree.
      const [proposal] = regressions.readRunProposals(result.runDir);
      const ref = `${result.runId}/${proposal.id}`;
      const listed = regressions.findProposal(ws.home, workspaceId(ws.dir), ref);
      const validated = await H.withoutHostTests(H.REPLAY_ENGINE, () => regressions.validateProposal(ws.dir, listed, { workDir: path.join(ws.root, "regressions-work"), env: ws.env, home: ws.home }));
      assert.deepEqual(validated.attempts, []);
      assert.equal(validated.value.run.outcome, "passed", validated.value.run.reason);
      assert.equal(validated.value.runtime.mode, "container");
      assert.equal(validated.value.usable, true);
      const incorporated = await H.withoutHostTests(H.REPLAY_ENGINE, () => regressions.incorporateProposal({ workspacePath: ws.dir, home: ws.home, workspaceId: workspaceId(ws.dir), ref, approve: true, env: ws.env }));
      assert.deepEqual(incorporated.attempts, []);
      assert.equal(incorporated.value.ok, true, JSON.stringify(incorporated.value));
      assert.equal(incorporated.value.regression.validation.container.network, "none");
      const after = H.testContainers(ws);
      assert.equal(after.length, 6, "validate and incorporate each started one container");
      assertContract(ws, after.slice(4), result.runId);
      assert.ok(after.slice(4).every((c) => !c.mounts[0].src.startsWith(ws.dir)), "the copy of the tree is in the data folder");
    } finally {
      ws.cleanup();
    }
  });

  await t.test("not reproduced: the reproducer passes before the patch", async () => {
    const { ws, scope } = patchWorkspace("v2-81-not-reproduced", PAGINATE_GOOD);
    try {
      fs.writeFileSync(path.join(ws.dir, "src/paginate.js"), PAGINATE_GOOD.replace("exports.pageItems", "// Pages never overlap.\nexports.pageItems"));
      ws.git("commit", "-q", "-am", "docs: pagination");
      const { result, investigation } = await guardedRun(ws, scope, H.postPatchAnalyst());
      assert.deepEqual(investigation.candidates.map((c) => c.details.kind), ["not-reproduced"]);
      const v = readJson(path.join(result.runDir, modules.postPatch.VALIDATION_FILE));
      assert.deepEqual([v.reproduced, v.fixed, v.before.outcome], [false, false, "passed"]);
      assert.equal(v.proposal, null);
      assertContract(ws, H.testContainers(ws), result.runId);
    } finally {
      ws.cleanup();
    }
  });

  await t.test("still failing after the patch and a nearby regression", async () => {
    const { ws, scope } = patchWorkspace("v2-81-not-fixed");
    try {
      fs.writeFileSync(path.join(ws.dir, "src/paginate.js"), PAGINATE_BAD.replace("start + size + 1", "start + size + 2"));
      fs.writeFileSync(path.join(ws.dir, "src/format.js"), H.FORMAT_BROKEN);
      ws.git("commit", "-q", "-am", "refactor: pagination and labels");
      const { result, investigation } = await guardedRun(ws, scope, H.postPatchAnalyst());
      assert.deepEqual(investigation.candidates.map((c) => c.details.kind).sort(), ["not-fixed", "regression"]);
      const v = readJson(path.join(result.runDir, modules.postPatch.VALIDATION_FILE));
      assert.deepEqual([v.reproduced, v.fixed, v.regressions], [true, false, ["test/format.test.mjs"]]);
      assert.equal(result.decision, "failed");
      assert.deepEqual(H.replayedTests(ws).map((r) => r.recording), ["paginate-bound-too-large", "paginate-bound-too-large", "format-label-item", "format-label-hash"]);
      assertContract(ws, H.testContainers(ws), result.runId);
    } finally {
      ws.cleanup();
    }
  });

  await t.test("without an engine the method is not applicable with the engine's code and spends no model call", async () => {
    const { ws, scope } = patchWorkspace("v2-81-no-engine");
    try {
      fs.writeFileSync(path.join(ws.dir, "src/paginate.js"), PAGINATE_GOOD);
      ws.git("commit", "-q", "-am", "fix");
      const env = { ...ws.env, JGATES_CONTAINER_RUNTIME: path.join(ws.root, "no-such-engine") };
      const model = H.forbidden();
      const plan = semantic.buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env, scope });
      const { value: run, attempts } = await H.withoutHostTests(H.REPLAY_ENGINE, () =>
        semantic.executeSemanticRun({ workspacePath: ws.dir, home: ws.home, env, version: "0.0.0-test", plan, cancelPollMs: 50, investigation: { module: modules.postPatch.postPatchModule(), deps: { script: model.script } } }),
      );
      assert.deepEqual(attempts, []);
      assert.deepEqual(model.calls, [], "no model call");
      const outcome = run.semanticRun.outcome;
      assert.equal(outcome.code, "METHOD_NOT_APPLICABLE");
      assert.equal(outcome.calls, 0);
      assert.equal(outcome.investigation.applicability.code, "ENGINE_NOT_INSTALLED");
      assert.notEqual(run.decision, "passed");
      assert.deepEqual(H.testContainers(ws), []);
    } finally {
      ws.cleanup();
    }
  });

  await t.test("without prepared dependencies a test that needs a package ends as error and the run says dependencies are not prepared", async () => {
    const { ws, scope } = patchWorkspace("v2-81-no-deps");
    try {
      fs.writeFileSync(path.join(ws.dir, "src/paginate.js"), PAGINATE_GOOD);
      ws.git("commit", "-q", "-am", "fix");
      const needs = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport leftPad from "left-pad";\n\ntest("left-pad pads to the requested width", () => {\n  assert.equal(leftPad("1", 3, "0"), "001");\n});\n';
      const { result, investigation } = await guardedRun(ws, scope, H.postPatchAnalyst({ reproducer: needs }));
      const v = readJson(path.join(result.runDir, modules.postPatch.VALIDATION_FILE));
      assert.deepEqual([v.before.outcome, v.after.outcome, v.reproduced], ["error", "error", false]);
      assert.match(v.before.reason, /^DEPENDENCIES_NOT_PREPARED: the test needs the package left-pad/);
      assert.equal(v.dependencies.prepared, false);
      assert.equal(v.dependencies.missingForTests, true);
      assert.equal(v.dependencies.code, "DEPENDENCIES_NOT_PREPARED");
      assert.match(v.dependencies.reason, /dependencies are not prepared/);
      assert.equal(investigation.candidates[0].details.kind, "not-reproduced");
      assert.ok(H.testContainers(ws).every((c) => c.mounts.length === 1), "no dependency volume is mounted when none is prepared");
      assert.notEqual(result.decision, "passed");
    } finally {
      ws.cleanup();
    }
  });
});
