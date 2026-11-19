import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-47 (real engine): compose services for integration, API contract and DAST. The db + api fixture
// (jgates/tests/fixtures/compose/db-api, both services on the local jgates-tools:dev image, the project folder bind
// mounted as `.:/app` and the ports published, like a development compose file) is run end to end with `jgates run`:
//   - the review (`jgates plan --json`) lists the host effects (the project bind mounts) and the services it starts;
//   - the run starts db and api as its own compose project, waits for their healthchecks and for the target's /health,
//     and the services are up and healthy;
//   - an integration check (a generic-command step with the integration capability and a JSON evidence contract) reaches
//     the db by name and finds the api's project folder mounted read-only (the api's own write attempt failed, and
//     nothing appeared in the project);
//   - Schemathesis and ZAP, both with `target: service:api:8000`, reach the api on the run's network and complete;
//   - afterwards nothing carrying the run's label is left (containers, networks, volumes), nor any container of the
//     run's compose project, and the project folder is byte-for-byte the same.
// Every object the test creates carries the workspace's JGates labels; the cleanup selects by those labels only.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FIXTURE = path.join(root, "jgates", "tests", "fixtures", "compose", "db-api");
const IMAGE = "jgates-tools:dev";

const docker = (args) => {
  const r = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
let workspace = "";
// Registered per test with t.after, so it runs after the case even when the case runs alone with --test-name-pattern.
const cleanupCase = () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  if (!workspace) return;
  const filters = ["--filter", "label=org.jgates.managed=true", "--filter", `label=org.jgates.workspace=${workspace}`];
  for (const id of lines(docker(["ps", "-aq", ...filters]).out)) docker(["rm", "-f", id]);
  for (const id of lines(docker(["network", "ls", "-q", ...filters]).out)) docker(["network", "rm", id]);
  for (const name of lines(docker(["volume", "ls", "-q", ...filters]).out)) docker(["volume", "rm", "-f", name]);
};

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
      } else hash.update(`f:${next}:${stat.size}:${stat.mtimeMs}\0`).update(fs.readFileSync(full));
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

// The integration check: a generic-command instance (declared by a project template) with a JSON evidence contract.
const INTEG_TEMPLATE = [
  "schemaVersion: 1",
  "id: integ",
  "extends: [builtin:base]",
  "config:",
  "  tools:",
  "    integ:",
  "      adapter: generic-command",
  "      enabled: true",
  "      capabilities: [integration]",
  "      command: python3",
  '      args: ["{workspace}/check_db.py", "{runDir}/outputs/generic-command/integ/integration.json"]',
  "      config:",
  "        effects: { readsCode: true, writesOutputs: true, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
  "        evidence: { kind: json-file, file: integration.json, schema: integration.schema.json }",
  "",
].join("\n");

const TOOLS = [
  "schemaVersion: 1",
  "tools:",
  "  schemathesis:",
  "    adapter: schemathesis",
  "    enabled: true",
  "    capabilities: [api-contract]",
  "    target: service:api:8000",
  "    spec: openapi.yaml",
  "    maxExamples: 5",
  "  zap:",
  "    adapter: zap",
  "    enabled: true",
  "    capabilities: [dast]",
  "    target: service:api:8000",
  "    blockingRisk: high",
  "",
].join("\n");

const SERVICES = ["services:", "  compose: [compose.yaml]", "  target:", "    service: api", "    port: 8000", "    health: /health", "  timeoutSeconds: 180", ""].join("\n");

test("V2-47 (real engine): db + api compose services serve an integration check, Schemathesis and ZAP, read-only and torn down afterwards", { timeout: 1_500_000 }, async (t) => {
  t.after(cleanupCase);
  const version = docker(["version", "--format", "{{.Server.Version}}"]);
  assert.equal(version.code, 0, "Docker is required for the real-engine acceptance cases (the daemon did not answer)");
  assert.equal(docker(["image", "inspect", IMAGE]).code, 0, `${IMAGE} is missing; build it with npm --prefix jgates run image:build`);
  assert.equal(docker(["compose", "version"]).code, 0, "Docker Compose is required");
  const { workspaceId } = await import(pathToFileURL(path.join(dist, "core", "ids", "index.js")).href);

  const project = tmp("v2-47-project-");
  const home = tmp("v2-47-home-");
  const stubs = tmp("v2-47-stubs-");
  for (const name of fs.readdirSync(FIXTURE)) fs.copyFileSync(path.join(FIXTURE, name), path.join(project, name));
  workspace = workspaceId(project);
  // The integration check's executable only has to look available to the plan; it runs in the image.
  fs.writeFileSync(path.join(stubs, "python3"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, "python3.cmd"), "@exit /b 99\r\n");
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const env = { ...process.env, [pathKey]: `${stubs}${path.delimiter}${process.env[pathKey] ?? ""}`, JGATES_HOME: home, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: IMAGE, JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  if (env.JGATES_CONTAINER_RUNTIME === "jgates-test-no-engine") delete env.JGATES_CONTAINER_RUNTIME;
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024 });

  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  const init = cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  fs.writeFileSync(path.join(project, ".jgates", "tools.yml"), TOOLS);
  fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
  fs.writeFileSync(path.join(project, ".jgates", "templates", "integ.yml"), INTEG_TEMPLATE);
  fs.appendFileSync(path.join(project, "jgates.yml"), `  - id: integ\n    source: .jgates/templates/integ.yml\n    activation: always\n${SERVICES}`);
  spawnSync("git", ["add", "-A"], { cwd: project });
  const before = treeHash(project);
  const only = ["integ", "schemathesis", "zap"].flatMap((t) => ["--only", `tool:${t}`]);

  // 1. The review lists the services it starts and their host effects (the project folder, mounted read-only).
  const planned = cli(["plan", "--cwd", project, "--json", ...only]);
  const plan = JSON.parse(planned.stdout).plan;
  assert.ok(plan, planned.stdout + planned.stderr);
  assert.deepEqual(plan.inputs.container.services, ["api", "db"]);
  const effects = plan.warnings.filter((w) => w.code === "SERVICES_HOST_EFFECT").map((w) => w.message);
  assert.deepEqual(effects.sort(), ["The service api mounts a folder of the project (. -> /app); JGates mounts it read-only.", "The service db mounts a folder of the project (. -> /app); JGates mounts it read-only."]);
  for (const id of ["schemathesis#api-contract", "zap#dast"]) {
    const item = plan.groups.willRun.find((i) => i.id === id);
    assert.equal(item?.availability.status, "available", `${id}: ${JSON.stringify(item?.availability)}`);
  }
  assert.deepEqual(plan.blockers, [], JSON.stringify(plan.blockers));

  // 2. The run.
  const run = cli(["run", "--cwd", project, "--no-interactive", "--json", ...only]);
  let doc;
  try {
    doc = JSON.parse(run.stdout);
  } catch {
    assert.fail(`jgates run printed no JSON (exit ${run.status}): ${run.stdout.slice(-2000)}\n${run.stderr.slice(-4000)}`);
  }
  const runId = doc.runId;
  const events = fs.readFileSync(path.join(doc.runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const servicesLog = path.join(doc.runDir, "logs", "services.log");
  const showLog = () => (fs.existsSync(servicesLog) ? fs.readFileSync(servicesLog, "utf8").slice(-4000) : "(no services log)");
  const phase = events.find((e) => e.type === "phase-finished" && e.data.phase === "services");
  assert.equal(phase?.data.details.status, "ready", `${JSON.stringify(phase)}\n${showLog()}`);
  // Services up and healthy.
  assert.deepEqual(phase.data.details.states.map((s) => [s.service, s.state, s.health]), [["api", "running", "healthy"], ["db", "running", "healthy"]], showLog());
  assert.match(fs.readFileSync(servicesLog, "utf8"), /\$ health http:\/\/api:8000\/health\nready 200/);
  const project_ = phase.data.details.project;
  assert.equal(project_, `jgates-${workspace}-${runId}`.toLowerCase());

  const stage = (id) => doc.stages.find((s) => s.id === id);
  const show = (id) => `${JSON.stringify(stage(id))}\n${["stdout", "stderr"].map((k) => { const f = path.join(doc.runDir, "logs", `${id.split("#")[0]}.${k}.log`); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").slice(-3000) : ""; }).join("\n")}`;
  // The integration check reached the db by name and saw the api's project folder read-only.
  assert.equal(stage("integ#integration")?.state, "completed", show("integ#integration"));
  const integOut = fs.readFileSync(path.join(doc.runDir, "logs", "integ.stdout.log"), "utf8");
  assert.match(integOut, /db answered: PONG PING integration/);
  assert.match(integOut, /api project folder writable: False/);
  // Schemathesis and ZAP reached service:api:8000.
  assert.equal(stage("schemathesis#api-contract")?.state, "completed", show("schemathesis#api-contract"));
  assert.match(stage("schemathesis#api-contract").reason, /http:\/\/api:8000/);
  assert.equal(stage("zap#dast")?.state, "completed", show("zap#dast"));
  const report = JSON.parse(fs.readFileSync(path.join(doc.runDir, "outputs", "zap", "zap", "zap-report.json"), "utf8"));
  assert.ok((report.site ?? []).some((s) => s["@name"] === "http://api:8000"), JSON.stringify((report.site ?? []).map((s) => s["@name"])));
  // The steps that used the services ran on the run's network.
  const integHeader = fs.readFileSync(path.join(doc.runDir, "logs", "integ.stderr.log"), "utf8");
  assert.match(integHeader, new RegExp(`--network ${project_}_default `));

  // 3. Project binds were read-only: the override says so and the api's write never reached the project.
  const override = fs.readFileSync(path.join(doc.runDir, phase.data.details.overrideFile), "utf8");
  assert.equal((override.match(/read_only: true/g) ?? []).length, 2, override);
  assert.match(override, /ports: !reset \[\]/);
  assert.ok(!fs.existsSync(path.join(project, "written-by-api.txt")), "the api could not write to the project folder");
  assert.equal(treeHash(project), before, "the project is unchanged after the run");

  // 4. Everything is down: nothing with the run's label, no container of the run's compose project.
  const runFilter = ["--filter", `label=org.jgates.run=${runId}`];
  assert.deepEqual(lines(docker(["ps", "-aq", ...runFilter]).out), [], "no container of the run");
  assert.deepEqual(lines(docker(["network", "ls", "-q", ...runFilter]).out), [], "no network of the run");
  // (The workspace's synchronized copy, jgates-<ws>-src, is kept between runs by design; it is not a services object.)
  assert.deepEqual(lines(docker(["volume", "ls", "-q", ...runFilter]).out).filter((v) => v !== `jgates-${workspace}-src`), [], "no volume of the run");
  assert.deepEqual(lines(docker(["volume", "ls", "-q", "--filter", "label=org.jgates.kind=services", "--filter", `label=org.jgates.workspace=${workspace}`]).out), [], "no services volume");
  assert.deepEqual(lines(docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project_}`]).out), [], "no container of the run's compose project");
  assert.ok(events.some((e) => e.type === "phase-finished" && e.data.phase === "services-down"));
  assert.match(fs.readFileSync(servicesLog, "utf8"), /down --volumes --remove-orphans/);
});
