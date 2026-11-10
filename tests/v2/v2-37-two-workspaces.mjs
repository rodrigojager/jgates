import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-37: two projects alternate in one JGates installation without any reconfiguration. With the fake engine, project A
// and project B each run twice, interleaved (A, B, A, B), with no terminal to answer a prompt. Each workspace gets its
// own source volume named after its workspace id, the volumes never mix their files, each keeps its own history, and the
// second run of a workspace syncs incrementally (nothing is copied again for the project that did not change).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

test("V2-37: two workspaces alternate with distinct volumes derived from their ids, separate histories and no configuration prompt", () => {
  const home = tmp("v2-37-home-");
  const engine = tmp("v2-37-engine-");
  const log = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  const labels = JSON.stringify({ "org.jgates.version": CLI_VERSION });
  fs.writeFileSync(runtime, `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(log)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(labels)};\nrequire(${JSON.stringify(FAKE)});\n`);
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };

  const projects = { A: tmp("v2-37-a-"), B: tmp("v2-37-b-") };
  fs.writeFileSync(path.join(projects.A, "alpha.py"), "ALPHA = 1\n");
  fs.writeFileSync(path.join(projects.B, "beta.py"), "BETA = 2\n");
  fs.writeFileSync(path.join(projects.B, "beta_two.py"), "BETA2 = 3\n");

  const cli = (dir, args) => {
    // No terminal: stdin is empty, so a prompt would end the command without an answer.
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: dir, encoding: "utf8", env, input: "", timeout: 240_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, doc };
  };
  for (const dir of Object.values(projects)) {
    const init = cli(dir, ["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
    assert.equal(init.status, 0, init.stderr || init.stdout);
  }

  const events = (runDir) =>
    fs
      .readFileSync(path.join(runDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const seen = { A: [], B: [] };
  for (const name of ["A", "B", "A", "B"]) {
    const dir = projects[name];
    const run = cli(dir, ["run", "--cwd", dir, "--json"]);
    assert.ok(run.doc, `run ${name}: ${run.stdout}${run.stderr}`);
    assert.ok(!/\[y\/N\]|\(y\/n\)|Choose|Select a profile/i.test(run.stdout + run.stderr), `run ${name} asked a question: ${run.stderr}`);
    assert.ok(run.doc.runDir, JSON.stringify(run.doc).slice(0, 300));
    const finished = events(run.doc.runDir).find((e) => e.type === "phase-finished" && e.data.phase === "sync");
    assert.ok(finished, `run ${name} has a sync phase event`);
    assert.equal(finished.data.status, "succeeded", JSON.stringify(finished.data));
    seen[name].push({ id: run.doc.workspace.id, runId: run.doc.runId, sync: finished.data.details });
  }

  // Distinct volumes, derived from the workspace ids; the same workspace always uses the same one.
  const idA = seen.A[0].id;
  const idB = seen.B[0].id;
  assert.notEqual(idA, idB);
  assert.match(idA, /^ws_[0-9a-f]{16}$/);
  for (const [name, id] of [["A", idA], ["B", idB]]) {
    for (const s of seen[name]) {
      assert.equal(s.id, id);
      assert.equal(s.sync.volume, `jgates-${id}-src`);
    }
  }
  assert.equal(seen.A[0].sync.createdVolume, true);
  assert.equal(seen.A[1].sync.createdVolume, false, "the second run of A reuses its volume");
  assert.equal(seen.A[1].sync.changedFiles, 0, "and copies nothing: A did not change");
  assert.equal(seen.B[1].sync.changedFiles, 0);
  const volumes = fs.readdirSync(path.join(engine, "volumes")).filter((n) => !n.endsWith(".json")).sort();
  assert.deepEqual(volumes, [`jgates-${idA}-src`, `jgates-${idB}-src`].sort());

  // The volumes hold their own project and nothing of the other one.
  const filesOf = (id) => fs.readdirSync(path.join(engine, "volumes", `jgates-${id}-src`));
  assert.ok(filesOf(idA).includes("alpha.py") && !filesOf(idA).includes("beta.py"));
  assert.ok(filesOf(idB).includes("beta.py") && filesOf(idB).includes("beta_two.py") && !filesOf(idB).includes("alpha.py"));

  // Separate histories: two runs each, and the run ids do not cross.
  const history = (name) => cli(projects[name], ["history", "--cwd", projects[name], "--json"]).doc;
  const hA = history("A");
  const hB = history("B");
  assert.equal(hA.workspace.id, idA);
  assert.equal(hB.workspace.id, idB);
  assert.deepEqual(hA.runs.map((r) => r.runId).sort(), seen.A.map((s) => s.runId).sort());
  assert.deepEqual(hB.runs.map((r) => r.runId).sort(), seen.B.map((s) => s.runId).sort());

  // Every sync helper carried its own workspace label, and no container ever mounted a project folder.
  const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const syncRuns = calls.filter((c) => c[0] === "run" && c.includes("org.jgates.kind=sync"));
  assert.equal(syncRuns.length, 2, "one sync helper per workspace (the other syncs had nothing to send)");
  assert.deepEqual(
    syncRuns.map((c) => c.find((a) => a.startsWith("org.jgates.workspace="))).sort(),
    [`org.jgates.workspace=${idA}`, `org.jgates.workspace=${idB}`].sort(),
  );
  for (const c of calls.filter((x) => x[0] === "run")) {
    const mounts = c.filter((a, i) => c[i - 1] === "--mount");
    assert.ok(!mounts.some((m) => m.includes(projects.A) || m.includes(projects.B)), `a project folder was mounted: ${mounts.join(" | ")}`);
  }
});
