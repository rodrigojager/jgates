import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Advisory data (core/data): the age of each database against the limit, the problems a step gets (DATA_MISSING,
// DATA_STALE, with their text in both languages), which plan items read which database, where the data is inside the
// image, the fetch time a result records, and the status read from a (fake) jgates-data volume. The end-to-end cases are
// V2-49 (fake engine) and tests/docker/advisory-data.test.js (real engine).

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const data = await import(pathToFileURL(path.join(dist, "core", "data", "index.js")).href);
const reasons = await import(pathToFileURL(path.join(dist, "core", "reasons", "index.js")).href);
const FAKE = path.join(here, "docker", "fake-docker.cjs");

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW = new Date("2026-11-10T12:00:00Z");
const at = (days) => new Date(NOW.getTime() - days * DAY).toISOString();
const status = (days) => ({ schemaVersion: 1, databases: Object.fromEntries(Object.entries(days).map(([id, d]) => [id, { fetchedAt: at(d), source: `s://${id}` }])) });

test("agesOf: a database is fresh up to the limit, stale beyond it, missing when never fetched; the future counts as fresh", () => {
  const ages = Object.fromEntries(data.agesOf(status({ trivy: 1, osv: 7, govulndb: 9 }), NOW, 7).map((a) => [a.id, a]));
  assert.equal(ages.trivy.state, "fresh");
  assert.equal(ages.osv.state, "fresh", "exactly the limit is still fresh");
  assert.equal(ages.govulndb.state, "stale");
  assert.equal(ages.govulndb.ageDays, 9);
  assert.equal(ages.rustsec.state, "missing");
  assert.equal(ages.rustsec.fetchedAt, null);
  assert.deepEqual(["grype", "kubescape"].map((id) => ages[id].state), ["missing", "missing"]);
  const future = data.agesOf(status({ trivy: -3 }), NOW, 7).find((a) => a.id === "trivy");
  assert.equal(future.state, "fresh");
  assert.equal(future.ageDays, 0);
});

test("dataProblems: DATA_MISSING and DATA_STALE per database a step reads, nothing for fresh data or databases it does not read", () => {
  const problems = data.dataProblems(["trivy", "osv", "govulndb"], status({ trivy: 1, osv: 9 }), NOW, 7);
  assert.deepEqual(problems.map((p) => p.code), ["DATA_STALE", "DATA_MISSING"]);
  assert.match(problems[0].message, /osv-scanner/);
  assert.match(problems[0].message, /9 (dias|days)/);
  assert.match(problems[1].message, /govulncheck/);
  assert.deepEqual(data.dataProblems(["trivy"], status({ trivy: 1 }), NOW, 7), []);
  assert.deepEqual(data.dataProblems([], status({}), NOW, 7), []);
});

test("the reasons DATA_STALE and DATA_MISSING have text and an action in both languages, with the plural in the text and no '(s)'", () => {
  for (const locale of ["en", "pt-BR"]) {
    const stale = reasons.resolveReason("DATA_STALE", { database: "trivy", days: 1, max: 7 }, locale);
    const staleMany = reasons.resolveReason("DATA_STALE", { database: "trivy", days: 9, max: 7 }, locale);
    const missing = reasons.resolveReason("DATA_MISSING", { database: "trivy" }, locale);
    assert.notEqual(stale.message, staleMany.message);
    for (const r of [stale, staleMany, missing]) {
      assert.ok(!r.message.includes("(s)") && !/\{|\}/.test(r.message), r.message);
      assert.equal(r.action.kind, "command");
      assert.equal(r.action.command, "jgates tools update-data");
      assert.ok(r.action.label.length > 3);
    }
  }
  assert.match(reasons.resolveReason("DATA_STALE", { database: "trivy", days: 1, max: 7 }, "en").message, /1 day old/);
  assert.match(reasons.resolveReason("DATA_STALE", { database: "trivy", days: 9, max: 7 }, "pt-BR").message, /9 dias/);
});

test("databaseOfItem: the vulnerability scanners read a database, Trivy only for its dependencies capability", () => {
  const item = (adapter, capability) => ({ adapter, capabilities: [capability] });
  assert.equal(data.databaseOfItem(item("trivy", "dependencies")), "trivy");
  assert.equal(data.databaseOfItem(item("trivy", "iac")), null);
  assert.equal(data.databaseOfItem(item("trivy", "secrets")), null);
  assert.equal(data.databaseOfItem(item("osv-scanner", "dependencies")), "osv");
  assert.equal(data.databaseOfItem(item("govulncheck", "dependencies")), "govulndb");
  assert.equal(data.databaseOfItem(item("cargo-audit", "dependencies")), "rustsec");
  assert.equal(data.databaseOfItem(item("grype", "dependencies")), "grype");
  assert.equal(data.databaseOfItem(item("kubescape", "iac")), "kubescape");
  assert.equal(data.databaseOfItem(item("gitleaks", "secrets")), null);
});

test("the data is at /data, and only JGates inside the image can be told another place", () => {
  assert.equal(data.dataRootOf({}), "/data");
  assert.equal(data.dataRootOf({ JGATES_DATA_DIR: "/elsewhere" }), "/data", "on the host the variable means nothing");
  const inImage = { JGATES_IMAGE_JSON: path.join(tmp("t20-image-"), "image.json") };
  fs.writeFileSync(inImage.JGATES_IMAGE_JSON, JSON.stringify({ schemaVersion: 1, tools: {} }));
  assert.equal(data.dataRootOf({ ...inImage, JGATES_DATA_DIR: "/mnt/advisories/" }), "/mnt/advisories");
  assert.equal(data.databaseDir("osv", {}), "/data/osv");
  assert.equal(data.databaseDir("govulndb", { ...inImage, JGATES_DATA_DIR: "/mnt/advisories" }), "/mnt/advisories/govulndb");
});

test("recordedDatabaseFacts: the fetch time and source the run recorded, found from the instance's output folder; none without a record", () => {
  const run = tmp("t20-run-");
  const out = path.join(run, "outputs", "osv-scanner", "osv-scanner");
  fs.mkdirSync(out, { recursive: true });
  assert.equal(data.recordedDatabaseFacts(out, "osv"), null);
  fs.writeFileSync(path.join(run, data.RUN_DATA_FILE), JSON.stringify({ ...status({ osv: 2 }), maxAgeDays: 7 }));
  assert.deepEqual(data.recordedDatabaseFacts(out, "osv"), { database: { source: "s://osv", updatedAt: at(2), downloadedAt: at(2), reported: true, networkRequired: false } });
  assert.equal(data.recordedDatabaseFacts(out, "trivy"), null, "a database the run did not read has no record");
});

test("dataMaxAgeDaysOf: 7 by default, execution.dataMaxAgeDays of the configuration otherwise", () => {
  const initialized = () => {
    const dir = tmp("t20-config-");
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const init = spawnSync(process.execPath, [path.join(dist, "cli", "main.js"), "init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"], { encoding: "utf8", env: { ...process.env, JGATES_HOME: tmp("t20-home-") } });
    assert.equal(init.status, 0, init.stdout + init.stderr);
    return dir;
  };
  const plain = initialized();
  assert.equal(data.dataMaxAgeDaysOf(plain), 7);
  const custom = initialized();
  fs.appendFileSync(path.join(custom, "jgates.yml"), "execution:\n  dataMaxAgeDays: 3\n");
  assert.equal(data.dataMaxAgeDaysOf(custom), 3);
  // A value the schema refuses never loosens the limit.
  const invalid = initialized();
  fs.appendFileSync(path.join(invalid, "jgates.yml"), "execution:\n  dataMaxAgeDays: 0\n");
  assert.equal(data.dataMaxAgeDaysOf(invalid), 7);
});

test("readDataStatusSync reads the fetch times of a data volume through a read-only helper container, and never creates a missing volume", () => {
  const engine = tmp("t20-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(runtime, `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nrequire(${JSON.stringify(FAKE)});\n`);
  const env = { JGATES_CONTAINER_RUNTIME: runtime, JGATES_TOOLS_IMAGE: "jgates-tools:dev" };
  const seen = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

  // No volume: nothing fetched, the helper is never started.
  const none = data.readDataStatusSync(env, "0.0.0");
  assert.equal(none.state, "no-volume");
  assert.deepEqual(none.status.databases, {});
  assert.ok(!seen().some((c) => c[0] === "run"), "no helper container without the volume");
  assert.ok(!seen().some((c) => c[0] === "volume" && c[1] === "create"));

  // The volume with a status file.
  fs.writeFileSync(path.join(engine, "objects.json"), JSON.stringify({ containers: [], volumes: [{ name: "jgates-data", labels: { "org.jgates.managed": "true", "org.jgates.kind": "data" } }], networks: [], images: [] }));
  fs.mkdirSync(path.join(engine, "volumes", "jgates-data"), { recursive: true });
  fs.writeFileSync(path.join(engine, "volumes", "jgates-data", "jgates-data.json"), JSON.stringify(status({ trivy: 2, rustsec: 4 })));
  const read = data.readDataStatusSync(env, "0.0.0");
  assert.equal(read.state, "ok");
  assert.equal(read.status.databases.trivy.fetchedAt, at(2));
  assert.equal(read.status.databases.osv, undefined);
  const helper = seen().find((c) => c[0] === "run");
  assert.ok(helper.includes("--network") && helper[helper.indexOf("--network") + 1] === "none");
  assert.ok(helper.some((a, i) => helper[i - 1] === "--mount" && a === "type=volume,src=jgates-data,dst=/data,readonly"));
  assert.ok(helper.includes("org.jgates.kind=data"));
  assert.deepEqual(data.dataTimestampsOf(read.status), { trivy: at(2), osv: null, govulndb: null, rustsec: at(4), grype: null, kubescape: null });

  // A status file that is not JSON is unreadable, never "fresh".
  fs.writeFileSync(path.join(engine, "volumes", "jgates-data", "jgates-data.json"), "not json");
  const broken = data.readDataStatusSync(env, "0.0.0");
  assert.equal(broken.state, "unreadable");
  assert.deepEqual(broken.status.databases, {});
});

test("updateData refreshes grype and kubescape in their own data containers: network, the data volume for writing, one id each", async () => {
  const engine = tmp("g6-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(runtime, `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nrequire(${JSON.stringify(FAKE)});\n`);
  fs.writeFileSync(path.join(engine, "objects.json"), JSON.stringify({ containers: [], volumes: [], networks: [], images: [{ id: "sha256:aaaa", name: "jgates-tools", tag: "dev", labels: {}, built: true }] }));
  const env = { JGATES_CONTAINER_RUNTIME: runtime, JGATES_TOOLS_IMAGE: "jgates-tools:dev" };
  const progress = [];
  const result = await data.updateData({ env, version: "0.0.0", only: ["grype", "kubescape"], onProgress: (e) => progress.push(`${e.database}:${e.state}`) });
  assert.deepEqual(result.databases.map((d) => d.id), ["grype", "kubescape"]);
  assert.ok(result.databases.every((d) => d.ok), JSON.stringify(result));
  assert.deepEqual(progress, ["grype:started", "grype:updated", "kubescape:started", "kubescape:updated"]);
  const runs = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c[0] === "run" && c.includes("python3"));
  assert.equal(runs.length, 2);
  for (const [i, id] of ["grype", "kubescape"].entries()) {
    const run = runs[i];
    assert.equal(run[run.length - 1], id);
    assert.equal(run[run.indexOf("--network") + 1], "bridge");
    assert.ok(run.some((a, j) => run[j - 1] === "--mount" && a === "type=volume,src=jgates-data,dst=/data"), "the volume is mounted for writing");
  }
});
