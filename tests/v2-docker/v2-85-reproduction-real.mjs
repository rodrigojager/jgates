import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setupWorkspace } from "../v2/fixtures/semantic-executor/helpers.mjs";
import * as R from "../v2/fixtures/reproduction/helpers.mjs";

// V2-85 (real engine, scripted model): confirm by reproduction on a real defect of a small Python project. The fixture
// (tests/fixtures/reproduction-python) has two needs-validation findings left by an earlier security audit: a discount
// above 100% makes the total negative (a real defect) and reserving more than the stock (a defect that does not exist:
// the code refuses it). The scripted model writes one pytest reproducer per finding; the host runs each in a container of
// jgates-tools:dev (the copy of the project and the prepared dependencies read-only, --network none), for real. The
// reproducer of the real defect fails for the defect and the finding shows as confirmed by execution; the reproducer that
// passes leaves its finding needs-validation. The project folder is byte for byte the same afterwards, the reproducer is
// gone from the workspace copy, and no container and no JGates temporary file is left. Every object the case creates in
// the engine carries its workspace id; the cleanup selects by it only.

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "fixtures", "reproduction-python");
const IMAGE = "jgates-tools:dev";
const METHOD = "confirm-by-reproduction";
const { TESTS, LINES, SEED_RUN, SEED_CANDIDATES, read, answer, readJson, treeHash, load, cliFor, writeSeedRun } = R;

const docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const lines = (text) => text.split(/\s+/).filter(Boolean);
const tempEntries = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => /^jgates/i.test(n)));

const made = [];
let workspaceFilter = null;
// The cleanup is a hook of the test itself, not of the file: under the harness, a root `after` hook registered once the
// root has nothing pending (the case run alone with --test-name-pattern, after filtered cases) runs at once, before the
// test made anything.
function cleanup() {
  if (workspaceFilter) {
    for (const id of lines(docker(["ps", "-aq", ...workspaceFilter]).out)) docker(["rm", "-f", id]);
    for (const name of lines(docker(["volume", "ls", "-q", ...workspaceFilter]).out)) docker(["volume", "rm", "-f", name]);
  }
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** The relative path and content of every file of a folder. */
function filesOf(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(next);
      else out[next] = fs.readFileSync(path.join(dir, next), "utf8");
    }
  };
  walk("");
  return out;
}

/** The JSON tool script of the mock provider: a reproducer per finding and one assessment (the failing one). */
function script() {
  const repro = (p, testFile) => [read([p]), answer({ summary: `One reproducer for the finding in ${p}.`, defect: `the behavior the finding in ${p} describes`, test: testFile })];
  return {
    contexts: {
      "reproducer:C1": repro("src/pricing.py", TESTS.discountBound),
      "reproducer:C2": repro("src/inventory.py", TESTS.reserveLimit),
      "assessment:C1": [
        read(["src/pricing.py"]),
        answer({ candidateId: "C1", cause: "defect", reason: "The failing assertion is the negative total the finding describes, on the line it cites.", evidence: [{ path: "src/pricing.py", line: LINES["src/pricing.py"], note: "percent is never bounded" }] }),
      ],
    },
  };
}

test("V2-85 (real engine): a real defect of a Python fixture is reproduced under pytest in a container, a reproducer that passes leaves its finding needs-validation, and nothing is left behind", async (t) => {
  t.after(cleanup);
  assert.equal(docker(["version", "--format", "{{.Server.Version}}"]).code, 0, "Docker is required for the real-engine acceptance cases (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
  const { workspaceId } = await load("core/ids/index.js");
  const { sourceVolumeName } = await load("core/engine/index.js");
  const { reproduction } = await load("core/semantic-modules/index.js");
  const { readDepsState } = await load("core/deps/state.js");

  // The project: the fixture, committed in a temporary repository of its own, with the earlier run (stored in the data folder).
  const ws = setupWorkspace("v2-85", filesOf(FIXTURE));
  made.push(ws.root);
  const workspace = workspaceId(ws.dir);
  workspaceFilter = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];
  // The container engine and the image are the real ones.
  Object.assign(ws.env, { JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" });
  delete ws.env.JGATES_IMAGE_JSON;
  if (ws.env.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete ws.env.JGATES_CONTAINER_RUNTIME;
  const seed = await writeSeedRun(ws, SEED_CANDIDATES.filter((c) => c.id === "C1" || c.id === "C2"));
  const cli = cliFor(ws);

  const projectBefore = treeHash(ws.dir);
  const seedBefore = treeHash(seed.dir);
  const seedResultBefore = fs.readFileSync(seed.file);
  const tempBefore = tempEntries();

  // 1. The dependencies are prepared the way a validation prepares them (jgates deps prepare, a dependency volume).
  const deps = cli(["deps", "prepare", "--cwd", ws.dir]);
  assert.equal(deps.code, 0, `${deps.out}\n${deps.err}`);
  const units = Object.values(readDepsState(ws.home, workspace).units);
  assert.ok(units.length > 0 && units.every((u) => u.volume), `the dependencies are recorded as prepared: ${JSON.stringify(units)}`);
  assert.ok(lines(docker(["volume", "ls", "-q", ...workspaceFilter, "--filter", "label=org.jgates.kind=deps"]).out).length > 0, "a dependency volume exists");

  // 2. The reproduction, asked for from the terminal, with the scripted model and the real engine.
  const run = cli(["semantic", "run", "--cwd", ws.dir, "--method", METHOD, "--from", SEED_RUN, "--json"], { script: script() });
  assert.ok(run.doc, `one JSON document: ${run.out.slice(0, 400)} ${run.err.slice(0, 400)}`);
  const result = run.doc;
  assert.equal(run.code, result.exitCode);
  assert.equal(result.semanticRun.outcome.state, "completed", result.semanticRun.outcome.reason);
  assert.equal(result.reproduction.findingsToTry, 2);
  assert.deepEqual(result.reproduction.execution, { where: "container", network: "none", host: false, runners: ["node:test", "pytest"] });
  const reproRun = result.runId;
  const doc = readJson(path.join(result.runDir, reproduction.REPRODUCTION_FILE));
  assert.deepEqual(Object.fromEntries(doc.findings.map((f) => [f.finding.candidateId, [f.outcome, f.reason]])), { C1: ["reproduced", null], C2: ["attempted", "REPRODUCER_PASSED"] });

  // 3. What really ran: pytest in a container without network, on a read-only copy, as a non-root user, no host process.
  const record = readJson(path.join(result.runDir, reproduction.EXECUTION_FILE));
  const executions = Object.fromEntries(record.executions.map((e) => [e.finding.candidateId, e]));
  assert.deepEqual(Object.keys(executions).sort(), ["C1", "C2"]);
  for (const e of Object.values(executions)) {
    assert.equal(e.tree, "workspace-copy");
    assert.equal(e.reproducer.runner, "pytest");
    assert.equal(e.run.executed, true, e.run.reason ?? "");
    assert.deepEqual(e.workspaceCopy, { synchronized: true, placed: true, removed: true }, "the reproducer was placed in the copy and removed again");
    const c = e.run.container;
    assert.equal(c?.mode, "container");
    assert.equal(c.network, "none");
    assert.equal(c.readOnlyTree, true);
    assert.equal(c.readOnlyRoot, true);
    assert.ok(!/^(0|root)(:|$)/.test(c.user), `the test does not run as root (${c.user})`);
    assert.match(c.image, /^sha256:/, "the image is pinned by its id");
  }
  assert.equal(executions.C1.run.outcome, "failed", executions.C1.run.output);
  assert.match(executions.C1.run.output, /-20/, `it fails for the defect (the negative total): ${executions.C1.run.output}`);
  assert.deepEqual(executions.C1.run.tests && { total: executions.C1.run.tests.total, fail: executions.C1.run.tests.fail }, { total: 1, fail: 1 });
  assert.equal(executions.C2.run.outcome, "passed", executions.C2.run.output);
  assert.deepEqual(executions.C2.run.tests && { total: executions.C2.run.tests.total, fail: executions.C2.run.tests.fail }, { total: 1, fail: 0 });

  // 4. The earlier run as `jgates semantic status` shows it: C1 confirmed by execution, C2 still needs-validation, never rejected.
  const status = cli(["semantic", "status", SEED_RUN, "--cwd", ws.dir, "--json"]);
  assert.equal(status.code, 0, status.err);
  const linked = Object.fromEntries(status.doc.run.reproduction.findings.map((f) => [f.candidateId, f]));
  assert.deepEqual(Object.keys(linked).sort(), ["C1", "C2"]);
  assert.deepEqual([linked.C1.state, linked.C1.confirmation, linked.C1.evidenceBasis, linked.C1.reproductionRunId, linked.C1.severity], ["confirmed", "confirmed", "execution", reproRun, "blocking"]);
  assert.deepEqual([linked.C2.state, linked.C2.confirmation, linked.C2.reason, linked.C2.reproductionRunId, linked.C2.severity], ["attempted", "needs-validation", "REPRODUCER_PASSED", reproRun, "important"]);
  assert.notEqual(linked.C2.evidenceBasis, "execution");
  const statusText = cli(["semantic", "status", SEED_RUN, "--cwd", ws.dir]);
  assert.match(statusText.out, new RegExp(`C1  confirmed by execution \\(run ${reproRun}\\)`));
  assert.match(statusText.out, new RegExp(`C2  needs validation, reproduction attempted \\(run ${reproRun}\\): the reproducer passed, so the defect was not shown`));

  // 5. The reproducer is gone from the workspace copy (the volume of the engine), and the project folder is untouched.
  const copy = sourceVolumeName(workspace);
  if (docker(["volume", "inspect", copy]).code === 0) {
    const listing = docker(["run", "--rm", "--network", "none", "--label", "org.jgates.managed=true", "--label", "org.jgates.kind=test", "--label", `org.jgates.workspace=${workspace}`, "--entrypoint", "sh", "-v", `${copy}:/w:ro`, IMAGE, "-c", "ls -A /w/.jgates/regressions 2>/dev/null; ls /w/src"]);
    assert.equal(listing.code, 0, listing.err);
    assert.doesNotMatch(listing.out, /test_discount_bound|test_reserve_limit|\.py\b.*test_/, `no reproducer is left in the workspace copy: ${listing.out}`);
    assert.match(listing.out, /pricing\.py/, "the copy holds the project's own files");
  }
  assert.equal(treeHash(ws.dir), projectBefore, "the project folder is byte for byte the same");
  assert.equal(fs.existsSync(path.join(ws.dir, ".jgates", "regressions")), false, "no reproducer appears in the project folder");
  assert.equal(treeHash(seed.dir), seedBefore, "the files of the earlier run are byte-identical");
  assert.deepEqual(fs.readFileSync(seed.file), seedResultBefore);

  // 6. Nothing is left: no container (checked by label) and no JGates temporary file.
  assert.equal(docker(["ps", "-aq", ...workspaceFilter]).out.trim(), "", "no container of this workspace is left");
  assert.equal(docker(["ps", "-aq", "--filter", "label=org.jgates.managed=true", "--filter", "label=org.jgates.kind=test", "--filter", `label=org.jgates.workspace=${workspace}`]).out.trim(), "", "no test container is left");
  // (This case's own folders are named v2-85-*, so any new jgates* entry in the temporary folder is JGates' own.)
  assert.deepEqual([...tempEntries()].filter((n) => !tempBefore.has(n)), [], "no JGates temporary file is left");
});
