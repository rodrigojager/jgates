import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-36 (fake engine): the project folder is untouched by a full run whose tests write files. A project with sources,
// a `.git` folder and a test that writes a cache and a report is run end to end (`jgates run`: plan, sync phase, steps,
// result) and then a step container with the contract of PLAN-architecture.md section 6 runs in the synchronized volume
// and writes files there (the fake engine plays the test: FAKE_DOCKER_WORKSPACE_WRITES). The tree hash of the project
// (every path, its mode and its content) is the same before and after, the written files exist only in the source
// volume, and no container ever got the project folder as a mount.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
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

/** Hash of the whole tree: relative paths, kinds, sizes, mtimes and contents, in a stable order. */
function treeHash(dir) {
  const hash = crypto.createHash("sha256");
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (entry.isDirectory()) {
        hash.update(`d:${next}\0`);
        walk(full, next);
      } else {
        hash.update(`f:${next}:${stat.size}:${stat.mtimeMs}\0`).update(fs.readFileSync(full));
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

test("V2-36: the project folder is identical before and after a full run whose test step writes files", async () => {
  const project = tmp("v2-36-project-");
  const home = tmp("v2-36-home-");
  const engine = tmp("v2-36-engine-");
  const log = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  const writes = ["tests/__pycache__/test_app.cpython-312.pyc", ".pytest_cache/v/cache/lastfailed", "coverage.xml", "src/generated.py"];
  const labels = JSON.stringify({ "org.jgates.version": CLI_VERSION });
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(log)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(labels)};\nprocess.env.FAKE_DOCKER_WORKSPACE_WRITES = ${JSON.stringify(JSON.stringify(writes))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };

  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "tests"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "app.py"), "def add(a, b):\n    return a + b\n");
  fs.writeFileSync(path.join(project, "tests", "test_app.py"), "from src.app import add\n\n\ndef test_add():\n    open('coverage.xml', 'w').write('<coverage/>')\n    assert add(1, 2) == 3\n");
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 240_000 });
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  // The test step of the plan: a launched step container (the fake engine plays the test: it writes the files above in
  // the source volume mounted at /workspace).
  fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".jgates", "templates", "tests.yml"),
    [
      "schemaVersion: 1",
      "id: tests",
      "extends: [builtin:base]",
      "config:",
      "  tools:",
      "    test-step:",
      "      adapter: generic-command",
      "      enabled: true",
      "      capabilities: [lint]",
      `      command: ${JSON.stringify(process.execPath)}`,
      '      args: ["-e", "0"]',
      "      config:",
      "        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
      "        evidence: { kind: exit-code }",
      "",
    ].join("\n"),
  );
  fs.appendFileSync(path.join(project, "jgates.yml"), "  - id: tests\n    source: .jgates/templates/tests.yml\n    activation: always\n");
  spawnSync("git", ["add", "-A"], { cwd: project });

  const before = treeHash(project);

  // 1. A full run: the sync phase copies the project into the volume and nothing writes to the project.
  const run = cli(["run", "--cwd", project, "--json"]);
  const doc = JSON.parse(run.stdout);
  const events = fs.readFileSync(path.join(doc.runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const synced = events.find((e) => e.type === "phase-finished" && e.data.phase === "sync");
  assert.equal(synced?.data.status, "succeeded", JSON.stringify(synced));
  const volume = synced.data.details.volume;
  assert.equal(treeHash(project), before, "the project is unchanged after the run");
  assert.deepEqual(doc.workspaceChanges?.added ?? [], [], "the run reports no change in the project");

  // 2. The test step ran as a launched step container (the launcher, not the host) and wrote its files in the source volume.
  const stepRuns = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c[0] === "run" && c.includes("org.jgates.kind=step"));
  const testStep = stepRuns.find((c) => c[c.indexOf("--name") + 1] === `jgates-${doc.runId}-test-step`);
  assert.ok(testStep, `the test step was launched in a container: ${JSON.stringify(stepRuns.map((c) => c[c.indexOf("--name") + 1]))}`);
  assert.ok(testStep.includes(`type=volume,src=${volume},dst=/workspace`));
  const volumeDir = path.join(engine, "volumes", volume);
  for (const rel of writes) assert.ok(fs.existsSync(path.join(volumeDir, rel)), `${rel} was written in the source volume`);
  assert.equal(treeHash(project), before, "the project is unchanged after the test step wrote files");
  for (const rel of writes) assert.ok(!fs.existsSync(path.join(project, rel)), `${rel} was not written in the project`);

  // 3. The next run starts from a fresh sync: the files the tests wrote are not part of the project, and the project is still untouched.
  const again = cli(["run", "--cwd", project, "--json"]);
  assert.ok(JSON.parse(again.stdout).runId);
  assert.equal(treeHash(project), before);

  // No container ever received the project folder.
  const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const mounts = calls.filter((c) => c[0] === "run").flatMap((c) => c.filter((a, i) => c[i - 1] === "--mount"));
  assert.ok(mounts.length >= 3);
  assert.ok(!mounts.some((m) => m.includes(project)), `the project was mounted: ${mounts.join(" | ")}`);
});
