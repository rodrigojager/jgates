import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-49 (fake engine): the vulnerability databases are the jgates-data volume, never the network.
//   1. `jgates tools update-data` creates the labelled volume and refreshes the four databases in data containers (the only
//      containers with a network next to the volume mounted for writing); a database that fails keeps its place in the
//      report with the error and the exit code is 2.
//   2. With fresh data (1 day old), the plan records each database's fetch time (inputs.container.dataTimestamps) and
//      lists the scanners with network `none`; the run starts the OSV-Scanner and Trivy steps with `--network none`, the
//      volume mounted read-only at /data and the offline flags, and the result records the fetch times (provenance).
//   3. With a 9-day-old timestamp the checks are blocked with DATA_STALE (the run is incomplete, exit 2, no step
//      container starts); execution.dataMaxAgeDays: 10 in jgates.yml lets the same data through.
//   4. Without the volume the checks are blocked with DATA_MISSING and the run is incomplete.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN = path.join(root, "jgates", "dist", "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const DAY = 86_400_000;

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const LOCK = JSON.stringify({ name: "demo", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "demo", version: "1.0.0", dependencies: { lodash: "4.17.15" } }, "node_modules/lodash": { version: "4.17.15" } } }, null, 2) + "\n";
const TOOLS = "schemaVersion: 1\ntools:\n  osv-scanner:\n    adapter: osv-scanner\n    capabilities: [dependencies]\n  trivy:\n    adapter: trivy\n    capabilities: [dependencies]\n";
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

test("V2-49: scanners run offline with the data volume read-only, stale data is DATA_STALE, missing data is DATA_MISSING, update-data refreshes it", () => {
  const project = tmp("v2-49-project-");
  const home = tmp("v2-49-home-");
  const engine = tmp("v2-49-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  const engineScript = (settings = {}) =>
    fs.writeFileSync(
      runtime,
      `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\n${Object.entries(settings).map(([k, v]) => `process.env.${k} = ${JSON.stringify(String(v))};\n`).join("")}require(${JSON.stringify(FAKE)});\n`,
    );
  engineScript();
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 240_000 });
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const objectsFile = path.join(engine, "objects.json");
  const objects = () => JSON.parse(fs.readFileSync(objectsFile, "utf8"));
  const statusFile = path.join(engine, "volumes", "jgates-data", "jgates-data.json");
  const mountsOf = (call) => call.filter((a, i) => call[i - 1] === "--mount");
  const flag = (call, name) => call[call.indexOf(name) + 1];

  /** Puts the data volume in the fake engine with the given fetch times (null: no volume at all). */
  const seed = (fetched) => {
    fs.rmSync(path.join(engine, "volumes", "jgates-data"), { recursive: true, force: true });
    const current = fs.existsSync(objectsFile) ? objects() : { containers: [], volumes: [], networks: [], images: [] };
    current.volumes = current.volumes.filter((v) => v.name !== "jgates-data");
    if (fetched) {
      current.volumes.push({ name: "jgates-data", labels: { "org.jgates.managed": "true", "org.jgates.kind": "data", "org.jgates.version": CLI_VERSION } });
      fs.mkdirSync(path.dirname(statusFile), { recursive: true });
      fs.writeFileSync(statusFile, JSON.stringify({ schemaVersion: 1, databases: Object.fromEntries(Object.entries(fetched).map(([id, at]) => [id, { fetchedAt: at, source: `fake://${id}` }])) }));
    }
    fs.writeFileSync(objectsFile, JSON.stringify(current));
  };

  fs.writeFileSync(path.join(project, "package-lock.json"), LOCK);
  fs.writeFileSync(path.join(project, "package.json"), '{"name":"demo","version":"1.0.0","dependencies":{"lodash":"4.17.15"}}\n');
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  fs.writeFileSync(path.join(project, ".jgates", "tools.yml"), TOOLS);
  spawnSync("git", ["add", "-A"], { cwd: project });
  const only = ["--only", "tool:osv-scanner", "--only", "tool:trivy"];
  const planOf = () => JSON.parse(cli(["plan", "--cwd", project, "--json", ...only]).stdout);
  const run = () => {
    fs.rmSync(calls, { force: true });
    const r = cli(["run", "--cwd", project, "--no-interactive", "--json", ...only]);
    const doc = JSON.parse(r.stdout);
    const stepRuns = dockerCalls().filter((c) => c[0] === "run" && c.includes("org.jgates.kind=step"));
    const stepOf = (tool) => stepRuns.find((c) => flag(c, "--name") === `jgates-${doc.runId}-${tool}`);
    return { r, doc, stepRuns, stepOf };
  };
  const stageOf = (doc, tool) => doc.stages.find((s) => s.id.startsWith(`${tool}#`)) ?? assert.fail(JSON.stringify(doc.stages.map((s) => s.id)));

  // 1. update-data: the labelled volume, one data container per database (network, volume writable), the fetch times.
  const updated = cli(["tools", "update-data", "--json"]);
  assert.equal(updated.status, 0, updated.stdout + updated.stderr);
  const updateDoc = JSON.parse(updated.stdout);
  assert.equal(updateDoc.status, "OK");
  assert.deepEqual(updateDoc.databases.map((d) => [d.id, d.ok]), [["trivy", true], ["osv", true], ["govulndb", true], ["rustsec", true]]);
  for (const d of updateDoc.databases) assert.match(d.fetchedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const volume = objects().volumes.find((v) => v.name === "jgates-data");
  assert.ok(volume, "the data volume exists");
  assert.equal(volume.labels["org.jgates.managed"], "true");
  assert.equal(volume.labels["org.jgates.kind"], "data");
  const dataRuns = dockerCalls().filter((c) => c[0] === "run" && c.includes("org.jgates.kind=data") && c.includes("python3"));
  assert.equal(dataRuns.length, 4, "one data container per database");
  for (const call of dataRuns) {
    assert.equal(flag(call, "--network"), "bridge", "the refresh is the one container with a network");
    assert.ok(mountsOf(call).includes("type=volume,src=jgates-data,dst=/data"), mountsOf(call).join(" | "));
    assert.ok(call.includes("--rm"));
  }
  assert.deepEqual(dataRuns.map((c) => c.at(-1)), ["trivy", "osv", "govulndb", "rustsec"]);
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(statusFile, "utf8")).databases).length === 4, "the volume stores the fetch time of each database");

  // A database that cannot be downloaded is reported with its error; the others are still refreshed; exit 2.
  engineScript({ FAKE_DOCKER_DATA_FAIL: "osv" });
  const partial = cli(["tools", "update-data", "--json"]);
  assert.equal(partial.status, 2, partial.stdout + partial.stderr);
  const partialDoc = JSON.parse(partial.stdout);
  assert.equal(partialDoc.status, "INCOMPLETE");
  assert.equal(partialDoc.databases.find((d) => d.id === "osv").ok, false);
  assert.match(partialDoc.databases.find((d) => d.id === "osv").error, /osv could not be downloaded/);
  assert.ok(partialDoc.databases.filter((d) => d.id !== "osv").every((d) => d.ok));
  assert.equal(cli(["tools", "update-data", "--database", "nope", "--json"]).status, 3, "an unknown database is a usage error");
  engineScript();

  // 2. Fresh data: offline scanners with the volume read-only.
  const fresh = iso(Date.now() - DAY);
  seed({ trivy: fresh, osv: fresh, govulndb: fresh, rustsec: fresh });
  const planned = planOf();
  assert.deepEqual(planned.plan.inputs.container.dataTimestamps, { osv: fresh, trivy: fresh });
  for (const tool of ["osv-scanner", "trivy"]) {
    const item = planned.plan.groups.willRun.find((i) => i.tool === tool);
    assert.ok(item, `${tool} in the plan`);
    assert.equal(item.networkKind, "none", `${tool}: no network`);
    assert.equal(item.network, false);
  }
  const ok = run();
  const osvStep = ok.stepOf("osv-scanner");
  const trivyStep = ok.stepOf("trivy");
  assert.ok(osvStep && trivyStep, JSON.stringify(ok.stepRuns.map((c) => flag(c, "--name"))));
  for (const step of [osvStep, trivyStep]) {
    assert.equal(flag(step, "--network"), "none");
    assert.ok(mountsOf(step).includes("type=volume,src=jgates-data,dst=/data,readonly"), mountsOf(step).join(" | "));
  }
  assert.ok(osvStep.includes("--offline-vulnerabilities"));
  assert.ok(osvStep.includes("OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=/data/osv"));
  for (const arg of ["--skip-db-update", "--offline-scan", "--skip-check-update"]) assert.ok(trivyStep.includes(arg), arg);
  assert.equal(trivyStep[trivyStep.indexOf("--cache-dir") + 1], "/data/trivy");
  // The result records each database's fetch time (the fake scanners write no report, so the stages end uninterpreted).
  assert.deepEqual(ok.doc.provenance.container.dataTimestamps, { osv: fresh, trivy: fresh }, JSON.stringify(ok.doc.provenance));
  const recorded = JSON.parse(fs.readFileSync(path.join(ok.doc.runDir, "data-status.json"), "utf8"));
  assert.equal(recorded.databases.osv.fetchedAt, fresh);
  assert.equal(recorded.maxAgeDays, 7);

  // 3. Nine days old: stale. The checks are blocked and no scanner container starts.
  const old = iso(Date.now() - 9 * DAY);
  seed({ trivy: old, osv: old, govulndb: old, rustsec: old });
  const stale = run();
  assert.equal(stale.r.status, 2, stale.r.stdout + stale.r.stderr);
  assert.equal(stale.doc.decision, "incomplete");
  assert.equal(stale.stepRuns.length, 0, "no scanner started on stale data");
  for (const tool of ["osv-scanner", "trivy"]) {
    const stage = stageOf(stale.doc, tool);
    assert.equal(stage.state, "blocked", JSON.stringify(stage));
    assert.equal(stage.execution.notRun.problems[0].code, "DATA_STALE");
    assert.match(stage.reason, /9 days old \(the limit is 7 days\)/);
  }
  assert.deepEqual(stale.doc.provenance.container.dataTimestamps, { osv: old, trivy: old });
  // A looser limit in the configuration lets the same data through.
  fs.appendFileSync(path.join(project, "jgates.yml"), "execution:\n  dataMaxAgeDays: 10\n");
  const loose = run();
  assert.ok(loose.stepOf("osv-scanner") && loose.stepOf("trivy"), "with dataMaxAgeDays: 10 the scanners start");
  assert.equal(JSON.parse(fs.readFileSync(path.join(loose.doc.runDir, "data-status.json"), "utf8")).maxAgeDays, 10);
  fs.writeFileSync(path.join(project, "jgates.yml"), fs.readFileSync(path.join(project, "jgates.yml"), "utf8").replace("execution:\n  dataMaxAgeDays: 10\n", ""));

  // 4. Only one database stale: that scanner is blocked, the other one runs.
  seed({ trivy: fresh, osv: old });
  const mixed = run();
  assert.ok(mixed.stepOf("trivy"), "trivy has fresh data");
  assert.equal(mixed.stepOf("osv-scanner"), undefined);
  assert.equal(stageOf(mixed.doc, "osv-scanner").execution.notRun.problems[0].code, "DATA_STALE");

  // 5. No volume at all: DATA_MISSING, incomplete, nothing started, and the plan records "never fetched".
  seed(null);
  assert.deepEqual(planOf().plan.inputs.container.dataTimestamps, { osv: null, trivy: null });
  const missing = run();
  assert.equal(missing.r.status, 2, missing.r.stdout + missing.r.stderr);
  assert.equal(missing.doc.decision, "incomplete");
  assert.equal(missing.stepRuns.length, 0, "no scanner started without data");
  for (const tool of ["osv-scanner", "trivy"]) {
    const stage = stageOf(missing.doc, tool);
    assert.equal(stage.state, "blocked", JSON.stringify(stage));
    assert.equal(stage.execution.notRun.problems[0].code, "DATA_MISSING");
    assert.match(stage.reason, /never downloaded/);
  }
  assert.ok(!objects().volumes.some((v) => v.name === "jgates-data"), "reading the data never creates the volume");
  // A database that was never fetched while others were: only its scanner is missing.
  seed({ trivy: fresh });
  const partialData = run();
  assert.ok(partialData.stepOf("trivy"));
  assert.equal(stageOf(partialData.doc, "osv-scanner").execution.notRun.problems[0].code, "DATA_MISSING");
});
