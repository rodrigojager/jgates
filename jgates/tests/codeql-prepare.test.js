import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// CodeQL prepared into its own volume (core/codeql-prepare), end to end against the fake engine and a release served
// locally. The real CodeQL bundle is never downloaded (accepting GitHub's terms is the user's decision):
//   1. without an acceptance `jgates tools prepare-codeql` refuses, downloads nothing, calls no container and records
//      nothing; the plan shows the dataflow capability as CUSTOMER_SUPPLIED with the action;
//   2. with --accept-terms the fake engine records the bundle written into jgates-codeql with its checksum verified, the
//      acceptance is recorded with its date in the JGates data folder (never in the project), and the plan then runs
//      CodeQL from the volume; a later call needs no flag; a bundle with a wrong checksum installs nothing;
//   3. the codeql step mounts the volume read-only at /codeql with no network, and an unprepared volume blocks the step.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const FIXTURE = path.join(here, "fixtures", "codeql", "bad");
const CLI_VERSION = JSON.parse(fs.readFileSync(path.resolve(here, "..", "..", "package.json"), "utf8")).version;
const load = (rel) => import(pathToFileURL(path.join(dist, ...rel.split("/"))).href);
const { buildPlan, validatePlanDocument } = await load("core/plan/index.js");
const { setLocale, getLocale } = await load("i18n/index.js");
const prepare = await load("core/codeql-prepare/index.js");
const reasons = await load("core/reasons/index.js");

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const servers = [];
test.after(() => {
  for (const server of servers) server.close();
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** The fake engine, its call log and the environment a JGates process needs to use it in container mode. */
function engine(extra = {}) {
  const dir = tmp("codeql-prepare-engine-");
  const calls = path.join(dir, "calls.jsonl");
  const runtime = path.join(dir, "docker.cjs");
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(dir)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const home = tmp("codeql-prepare-home-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", ...extra };
  const dockerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const file = (...parts) => path.join(dir, ...parts);
  return { dir, home, env, dockerCalls, file, volume: (...parts) => file("volumes", "jgates-codeql", ...parts) };
}

/** The CLI without blocking this process, so a release server in it can answer the fake engine's download. */
function cli(env, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const BUNDLE = Buffer.from("fake codeql bundle: not CodeQL, only bytes whose checksum is verified\n");
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/** A release served locally: the bundle and its checksum file, the way GitHub's release names them. */
async function release({ sum = sha(BUNDLE) } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/codeql-bundle-linux64.tar.gz") res.end(BUNDLE);
    else if (req.url === "/codeql-bundle-linux64.tar.gz.checksum.txt") res.end(`${sum}  codeql-bundle-linux64.tar.gz\n`);
    else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, hits };
}

/** A Python project with a declared CodeQL instance (the project is only read: the test checks it never changes). */
const DECLARED = "schemaVersion: 1\ntools:\n  codeql:\n    adapter: codeql\n    capabilities: [dataflow]\n    language: python\n";
const REQUIRED = DECLARED.replace("adapter: codeql\n", "adapter: codeql\n    enabled: true\n");
function project(tools = DECLARED) {
  const dir = tmp("codeql-prepare-project-");
  fs.cpSync(FIXTURE, dir, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  fs.mkdirSync(path.join(dir, ".jgates"));
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(dir, "jgates.yml"), "schemaVersion: 1\nselection:\n  profile: p\ntemplates: []\n");
  fs.writeFileSync(path.join(dir, ".jgates", "profiles.yml"), JSON.stringify({ schemaVersion: 1, profiles: { p: { checks: { "capability:dataflow": { enabled: true, when: "available" } } } } }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), tools);
  return dir;
}

const listing = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
const flag = (call, name) => call[call.indexOf(name) + 1];
const mountsOf = (call) => call.filter((a, i) => call[i - 1] === "--mount");
const dataRuns = (e) => e.dockerCalls().filter((c) => c[0] === "run" && c.includes("org.jgates.kind=data") && c.includes("python3"));

function planOf(dir, e) {
  const previous = getLocale();
  setLocale("en");
  try {
    prepare.resetCodeqlStatusCache();
    const built = buildPlan(dir, { compare: false, home: e.home, env: e.env, version: CLI_VERSION });
    assert.equal(built.ok, true, JSON.stringify(built.error ?? built.errors ?? null));
    return built.plan;
  } finally {
    setLocale(previous);
  }
}

test("CUSTOMER_SUPPLIED has its text and action in both languages, the action never accepting the terms for the user", () => {
  for (const locale of ["en", "pt-BR"]) {
    const reason = reasons.resolveReason("CUSTOMER_SUPPLIED", { tool: "CodeQL" }, locale);
    assert.match(reason.message, /CodeQL/);
    assert.doesNotMatch(reason.message, /\(s\)/);
    assert.equal(reason.action.kind, "command");
    assert.equal(reason.action.command, "jgates tools prepare-codeql");
  }
  assert.equal(reasons.resolveReason("CUSTOMER_SUPPLIED", { tool: "CodeQL" }, "pt-BR").action.label, "Preparar o CodeQL");
  assert.equal(reasons.resolveReason("CUSTOMER_SUPPLIED", { tool: "CodeQL" }, "en").action.label, "Prepare CodeQL");
});

test("without an acceptance the command refuses and downloads nothing, and the plan shows the dataflow capability as CUSTOMER_SUPPLIED with the action", async () => {
  const served = await release();
  const e = engine({ JGATES_CODEQL_RELEASE_BASE: served.base });
  const dir = project();
  const before = listing(dir);

  const refused = await cli(e.env, ["tools", "prepare-codeql", "--json"], dir);
  assert.equal(refused.status, 3, refused.stdout + refused.stderr);
  const doc = JSON.parse(refused.stdout);
  assert.equal(doc.status, "ERROR");
  assert.equal(doc.error.code, "TERMS_NOT_ACCEPTED");
  assert.match(doc.error.message, /GitHub CodeQL Terms and Conditions/);
  assert.match(doc.error.message, /jgates tools prepare-codeql --accept-terms/);
  assert.deepEqual(served.hits, [], "nothing was downloaded");
  assert.deepEqual(e.dockerCalls(), [], "no engine call, no container");
  assert.equal(fs.existsSync(prepare.termsFile(e.home)), false, "a refusal records no acceptance");

  const p = planOf(dir, e);
  assert.deepEqual(validatePlanDocument(p), []);
  const item = p.groups.notApplicableRequirements.find((r) => r.selector === "capability:dataflow");
  assert.ok(item, JSON.stringify(p.groups.notApplicableRequirements.map((r) => r.selector)));
  assert.equal(item.reasonCode, "CUSTOMER_SUPPLIED");
  assert.match(item.message, /CodeQL is supplied by you/);
  assert.equal(item.action.kind, "prepare-codeql");
  assert.equal(item.action.command, "jgates tools prepare-codeql");
  assert.equal(item.action.label, "Prepare CodeQL");
  assert.deepEqual(item.action.tools, ["codeql"]);
  assert.equal(p.groups.willRun.some((i) => i.adapter === "codeql"), false, "CodeQL does not run, and no TOOL_MISSING offer of the image is made");
  assert.equal(p.blockers.length, 0, "never a blocker");
  assert.deepEqual(listing(dir), before, "the project is untouched");
});

test("--accept-terms: the bundle is written into jgates-codeql with its checksum verified, the acceptance is recorded with its date in the JGates data folder, and the plan runs CodeQL from the volume", async () => {
  const served = await release();
  const e = engine({ JGATES_CODEQL_RELEASE_BASE: served.base });
  const dir = project();
  const before = listing(dir);
  const started = Date.now();

  const done = await cli(e.env, ["tools", "prepare-codeql", "--accept-terms", "--json"], dir);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  const doc = JSON.parse(done.stdout);
  assert.equal(doc.status, "OK");
  assert.equal(doc.codeql.sha256, sha(BUNDLE));
  assert.equal(doc.codeql.version, "2.18.4");
  assert.equal(doc.codeql.volume, "jgates-codeql");
  assert.deepEqual(served.hits.sort(), ["/codeql-bundle-linux64.tar.gz", "/codeql-bundle-linux64.tar.gz.checksum.txt"]);

  // The labelled volume and one data container with a network, the volume writable, the release named in its environment.
  const objects = JSON.parse(fs.readFileSync(e.file("objects.json"), "utf8"));
  const volume = objects.volumes.find((v) => v.name === "jgates-codeql");
  assert.ok(volume, "the volume exists");
  assert.equal(volume.labels["org.jgates.managed"], "true");
  assert.equal(volume.labels["org.jgates.kind"], "data");
  const runs = dataRuns(e);
  assert.equal(runs.length, 1);
  assert.equal(flag(runs[0], "--network"), "bridge");
  assert.ok(runs[0].includes("--rm"));
  assert.ok(mountsOf(runs[0]).includes("type=volume,src=jgates-codeql,dst=/codeql"), mountsOf(runs[0]).join(" | "));
  assert.ok(runs[0].includes(`JGATES_CODEQL_URL=${served.base}/codeql-bundle-linux64.tar.gz`));

  // What the (fake) engine recorded: the bundle in the volume, with the checksum verified against the release's file.
  const records = fs.readFileSync(e.file("codeql-prepare.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(records.length, 1);
  assert.equal(records[0].volume, "jgates-codeql");
  assert.equal(records[0].verified, true);
  assert.equal(records[0].sha256, sha(BUNDLE));
  assert.deepEqual(fs.readFileSync(e.volume("codeql", "bundle.fake")), BUNDLE);
  const stamp = JSON.parse(fs.readFileSync(e.volume("jgates-codeql.json"), "utf8"));
  assert.equal(stamp.sha256, sha(BUNDLE));
  assert.equal(stamp.termsAcceptedAt, JSON.parse(fs.readFileSync(prepare.termsFile(e.home), "utf8")).acceptedAt);

  // The acceptance: in the JGates data folder with its date, never in the project.
  const accepted = prepare.readAcceptance(e.home);
  assert.ok(accepted, "the acceptance is recorded");
  assert.match(accepted.acceptedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(Math.abs(Date.parse(accepted.acceptedAt) - started) < 5 * 60_000);
  assert.deepEqual(listing(dir), before, "the project is untouched and holds no acceptance");
  assert.equal(listing(dir).some((f) => /terms|codeql-terms/i.test(f)), false);
  assert.equal(doc.termsAcceptedAt, accepted.acceptedAt);

  // The plan now finds CodeQL in the volume: it runs, with the executable inside /codeql, and nothing is "not applicable".
  const p = planOf(dir, e);
  const item = p.groups.willRun.find((i) => i.id === "codeql#dataflow");
  assert.ok(item, JSON.stringify(p.groups.willRun.map((i) => i.id)));
  assert.equal(item.availability.status, "available");
  assert.equal(item.versions.toolVersion, "2.18.4");
  assert.equal(item.command.executable, "/codeql/codeql/codeql");
  assert.equal(p.groups.notApplicableRequirements.filter((r) => r.selector === "capability:dataflow").length, 0);

  // A later call needs no flag (the acceptance is recorded); it prepares again and keeps the same date.
  const again = await cli(e.env, ["tools", "prepare-codeql", "--json"], dir);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(prepare.readAcceptance(e.home).acceptedAt, accepted.acceptedAt);
});

test("a bundle whose checksum differs from the release's checksum file installs nothing and the command is incomplete", async () => {
  const served = await release({ sum: "0".repeat(64) });
  const e = engine({ JGATES_CODEQL_RELEASE_BASE: served.base });
  const dir = project();
  const failed = await cli(e.env, ["tools", "prepare-codeql", "--accept-terms", "--json"], dir);
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  const doc = JSON.parse(failed.stdout);
  assert.equal(doc.status, "INCOMPLETE");
  assert.match(doc.error, /checksum mismatch/);
  assert.equal(doc.codeql, null);
  assert.equal(fs.existsSync(e.volume("codeql", "bundle.fake")), false, "no bundle was written");
  assert.equal(fs.existsSync(e.volume("jgates-codeql.json")), false, "no status was written");
  assert.equal(fs.existsSync(e.file("codeql-prepare.jsonl")), false);
  // The plan still says CUSTOMER_SUPPLIED.
  const item = planOf(dir, e).groups.notApplicableRequirements.find((r) => r.selector === "capability:dataflow");
  assert.equal(item?.reasonCode, "CUSTOMER_SUPPLIED");
});

test("the codeql step mounts jgates-codeql read-only with no network; an unprepared volume blocks the step and starts no container", async () => {
  const served = await release();
  const e = engine({ JGATES_CODEQL_RELEASE_BASE: served.base });
  const dir = project(REQUIRED);
  const run = async () => {
    fs.rmSync(e.file("calls.jsonl"), { force: true });
    const r = await cli(e.env, ["run", "--cwd", dir, "--no-interactive", "--json", "--only", "tool:codeql"], dir);
    const result = JSON.parse(r.stdout);
    return { r, result, steps: e.dockerCalls().filter((c) => c[0] === "run" && c.includes("org.jgates.kind=step")) };
  };

  // Not prepared: the stage is blocked (never passed) and no step container starts.
  const blocked = await run();
  assert.notEqual(blocked.result.decision, "passed");
  const stage = blocked.result.stages.find((s) => s.id === "codeql#dataflow");
  assert.equal(stage.state, "blocked", JSON.stringify(stage));
  assert.equal(blocked.steps.length, 0);

  // Prepared: both CodeQL processes (database create, analyze) run in step containers with the volume read-only.
  assert.equal((await cli(e.env, ["tools", "prepare-codeql", "--accept-terms", "--json"], dir)).status, 0);
  const ran = await run();
  assert.ok(ran.steps.length >= 2, JSON.stringify(ran.steps.map((c) => flag(c, "--name"))));
  for (const step of ran.steps) {
    assert.ok(mountsOf(step).includes("type=volume,src=jgates-codeql,dst=/codeql,readonly"), mountsOf(step).join(" | "));
    assert.equal(flag(step, "--network"), "none");
    assert.ok(step.includes("/codeql/codeql/codeql"), "the executable is the one in the volume");
  }
  assert.ok(ran.steps[0].includes("create"), "the database is created first");
  const recorded = JSON.parse(fs.readFileSync(path.join(ran.result.runDir, "codeql-status.json"), "utf8"));
  assert.equal(recorded.state, "ok");
  assert.equal(recorded.status.sha256, sha(BUNDLE));
});
