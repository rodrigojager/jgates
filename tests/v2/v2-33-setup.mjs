import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-33 (fake engine): `jgates setup` on a machine whose engine runs.
//   1. The tools image is not in the engine: setup pulls the pinned reference (by digest), creates the shared volumes
//      (jgates-cache, jgates-toolchains, jgates-data) with the JGates labels, refreshes the four advisory databases and
//      exits 0; it never prepares CodeQL (no jgates-codeql volume).
//   2. A second call exits 0 and pulls nothing, creates nothing and refreshes nothing.
//   3. `status --json` reports the machine ready: engine, image of this release and fresh data.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const PINNED = `registry.example.test/jgates/jgates-tools@sha256:${"ab".repeat(32)}`;

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

test("V2-33: setup pulls the pinned image, creates the shared volumes and data; a second call is a no-op; status is ready", () => {
  const project = tmp("v2-33-project-");
  const home = tmp("v2-33-home-");
  const engine = tmp("v2-33-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  // The image exists in the fake engine only once it was pulled (or loaded): the wrapper decides at every call.
  fs.writeFileSync(
    runtime,
    `const fs = require("node:fs");\nconst path = require("node:path");\nprocess.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nconst present = fs.existsSync(path.join(${JSON.stringify(engine)}, "pull-attempts"));\nprocess.env.FAKE_DOCKER_LABELS = present ? ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))} : "none";\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: PINNED, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const cli = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 240_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, doc };
  };
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const objects = () => JSON.parse(fs.readFileSync(path.join(engine, "objects.json"), "utf8"));
  const flag = (call, name) => call[call.indexOf(name) + 1];

  // 1. A machine with a running engine and no image.
  const first = cli(["setup", "--json"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(first.doc, first.stdout);
  assert.equal(first.doc.status, "OK");
  assert.equal(first.doc.ready, true);
  assert.equal(first.doc.pulled, true);
  assert.deepEqual(first.doc.steps.map((s) => [s.id, s.state]), [["engine", "done"], ["disk", "done"], ["image", "done"], ["volumes", "done"], ["data", "done"]]);
  const pulls = dockerCalls().filter((c) => c[0] === "pull");
  assert.deepEqual(pulls, [["pull", PINNED]], "exactly one pull, of the pinned digest");
  const volumes = objects().volumes;
  for (const [name, kind] of [["jgates-cache", "deps"], ["jgates-toolchains", "toolchain"], ["jgates-data", "data"]]) {
    const volume = volumes.find((v) => v.name === name);
    assert.ok(volume, `${name} exists`);
    assert.equal(volume.labels["org.jgates.managed"], "true");
    assert.equal(volume.labels["org.jgates.kind"], kind);
  }
  assert.ok(!volumes.some((v) => v.name === "jgates-codeql"), "setup never prepares CodeQL (it needs the terms accepted)");
  const refreshes = dockerCalls().filter((c) => c[0] === "run" && c.includes("org.jgates.kind=data") && c.includes("python3"));
  assert.deepEqual(refreshes.map((c) => c.at(-1)), ["trivy", "osv", "govulndb", "rustsec"]);
  for (const c of refreshes) assert.equal(flag(c, "--network"), "bridge");
  // Progress went to stderr as JSON lines, never to stdout.
  const events = first.stderr.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === "image-pull" && e.phase === "done" && e.downloaded === e.total && e.total > 0), "pull progress events");
  assert.ok(events.some((e) => e.type === "data-update" && e.state === "updated"));

  // 2. The second call changes nothing.
  fs.rmSync(calls, { force: true });
  const volumesBefore = JSON.stringify(objects().volumes);
  const second = cli(["setup", "--json"]);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(second.doc.ready, true);
  assert.equal(second.doc.pulled, false);
  assert.deepEqual(second.doc.steps.filter((s) => s.id !== "engine").map((s) => s.state), ["skipped", "skipped", "skipped", "skipped"]);
  const again = dockerCalls();
  assert.ok(!again.some((c) => c[0] === "pull"), "no pull the second time");
  assert.ok(!again.some((c) => c[0] === "run" && c.includes("python3")), "no data refresh the second time");
  assert.ok(!again.some((c) => c[0] === "volume" && c[1] === "create"), "no volume created the second time");
  assert.equal(JSON.stringify(objects().volumes), volumesBefore);

  // 3. status --json: ready.
  const status = cli(["status", "--json"]);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.equal(status.doc.status, "OK");
  assert.equal(status.doc.ready, true);
  assert.equal(status.doc.engine.state, "ready");
  assert.equal(status.doc.image.state, "ready");
  assert.equal(status.doc.image.version, CLI_VERSION);
  assert.equal(status.doc.data.state, "fresh");
  assert.deepEqual(status.doc.data.databases.map((d) => d.id), ["trivy", "osv", "govulndb", "rustsec"]);
  assert.deepEqual(status.doc.reasons, []);
  assert.deepEqual(status.doc.warnings, []);
  // The text form says so too (English here).
  const text = cli(["status"]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /^Ready: JGates can run checks on this machine\./);
  const textSetup = cli(["setup"]);
  assert.equal(textSetup.status, 0, textSetup.stderr);
  assert.match(textSetup.stdout, /This machine is ready\./);
});
