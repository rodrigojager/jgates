import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-62 (fake engine): the dependency scanner is fully offline. The osv-scanner step runs with `--network none`, the data
// volume read-only, the offline-vulnerabilities flag and `--no-resolve` (no transitive resolution, which would ask
// api.deps.dev and fail with no network on a requirements.txt); no step of the run is given a network.

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

test("V2-62: the osv-scanner command carries the offline flags and no step asks for network", () => {
  const project = tmp("v2-62-project-");
  const home = tmp("v2-62-home-");
  const engine = tmp("v2-62-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 240_000 });
  const flag = (call, name) => call[call.indexOf(name) + 1];

  // Fresh data volume in the fake engine.
  const fresh = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
  const statusFile = path.join(engine, "volumes", "jgates-data", "jgates-data.json");
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, JSON.stringify({ schemaVersion: 1, databases: Object.fromEntries(["trivy", "osv", "govulndb", "rustsec"].map((id) => [id, { fetchedAt: fresh, source: `fake://${id}` }])) }));
  fs.writeFileSync(path.join(engine, "objects.json"), JSON.stringify({ containers: [], volumes: [{ name: "jgates-data", labels: { "org.jgates.managed": "true", "org.jgates.kind": "data", "org.jgates.version": CLI_VERSION } }], networks: [], images: [] }));

  fs.writeFileSync(path.join(project, "requirements.txt"), "requests==2.31.0\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  fs.writeFileSync(path.join(project, ".jgates", "tools.yml"), "schemaVersion: 1\ntools:\n  osv-scanner:\n    adapter: osv-scanner\n    capabilities: [dependencies]\n");
  spawnSync("git", ["add", "-A"], { cwd: project });
  fs.rmSync(calls, { force: true });

  const r = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:osv-scanner"]);
  const doc = JSON.parse(r.stdout);
  const all = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const steps = all.filter((c) => c[0] === "run" && c.includes("org.jgates.kind=step"));
  const osv = steps.find((c) => flag(c, "--name") === `jgates-${doc.runId}-osv-scanner`);
  assert.ok(osv, JSON.stringify(steps.map((c) => flag(c, "--name"))));
  for (const arg of ["--offline-vulnerabilities", "--no-resolve"]) assert.ok(osv.includes(arg), `${arg} in ${osv.join(" ")}`);
  assert.ok(steps.length > 0);
  for (const step of steps) assert.equal(flag(step, "--network"), "none", `step ${flag(step, "--name")} asked for a network`);
});
