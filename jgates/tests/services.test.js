// Project services through Docker Compose (PLAN-services.md), with the fake engine (tests/docker/fake-docker.cjs):
//   - discovery reads compose files without running anything and reports host effects (bind mounts of host paths,
//     privileged, network_mode/pid host, devices, cap_add), project bind mounts apart;
//   - a governed plan or run refuses the host effects the policy does not allow; local mode lists them as warnings;
//   - the run's override file resets published ports, mounts project folders read-only and labels everything;
//   - a run starts the services as its own compose project, the steps that use services (integration, not lint) join
//     its network, and the project is taken down at the end;
//   - an unhealthy service blocks the dependent steps with SERVICES_NOT_READY and its logs are a log block; the
//     independent steps still run; failure and cancellation both run `compose down` for the run project only;
//   - a runtime check that names a service nobody configured is SERVICES_REQUIRED; ZAP and Schemathesis accept
//     `service:<name>:<port>` targets.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "dist");
const FAKE = path.join(__dirname, "docker", "fake-docker.cjs");
const FIXTURE = path.join(__dirname, "fixtures", "compose", "effects");
const load = (...parts) => import(pathToFileURL(path.join(DIST, ...parts)).href);
const VERSION = "test";

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A fake engine client: a script that sets the fake's variables and loads it; returns its folder and the call log. */
function fakeEngine(vars = {}) {
  const dir = tmp("svc-engine-");
  const calls = path.join(dir, "calls.jsonl");
  const runtime = path.join(dir, "docker.cjs");
  const all = { FAKE_DOCKER_LOG: calls, FAKE_DOCKER_STATE: dir, FAKE_DOCKER_LABELS: JSON.stringify({ "org.jgates.version": VERSION }), ...vars };
  fs.writeFileSync(runtime, [...Object.entries(all).map(([k, v]) => `process.env.${k} = ${JSON.stringify(v)};`), `require(${JSON.stringify(FAKE)});`, ""].join("\n"));
  const read = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, runtime, calls: read };
}

function template(tool, capability) {
  return [
    "schemaVersion: 1",
    `id: ${tool}`,
    "extends: [builtin:base]",
    "config:",
    "  tools:",
    `    ${tool}:`,
    "      adapter: generic-command",
    "      enabled: true",
    `      capabilities: [${capability}]`,
    `      command: ${JSON.stringify(process.execPath)}`,
    '      args: ["{workspace}/check.js"]',
    "      config:",
    "        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
    "        evidence: { kind: exit-code }",
    "",
  ].join("\n");
}

const COMPOSE = [
  "services:",
  "  db:",
  "    image: postgres:16-alpine",
  "    ports: ['5432:5432']",
  "    healthcheck:",
  "      test: ['CMD', 'pg_isready']",
  "    volumes:",
  "      - ./initdb:/docker-entrypoint-initdb.d",
  "",
].join("\n");

/** A project with two generic-command checks: `lint-a` (lint) and `integ` (integration), and a compose file with a db. */
async function project(services) {
  const { planInit, writeInit } = await load("core", "init", "index.js");
  const dir = tmp("svc-project-");
  fs.writeFileSync(path.join(dir, "check.js"), "process.exit(0);\n");
  fs.writeFileSync(path.join(dir, "compose.yaml"), COMPOSE);
  fs.mkdirSync(path.join(dir, "initdb"));
  fs.mkdirSync(path.join(dir, ".jgates", "templates"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  writeInit(dir, planInit(dir, "minimal"));
  const tools = { "lint-a": "lint", integ: "integration" };
  for (const [tool, capability] of Object.entries(tools)) fs.writeFileSync(path.join(dir, ".jgates", "templates", `${tool}.yml`), template(tool, capability));
  fs.appendFileSync(path.join(dir, "jgates.yml"), Object.keys(tools).map((t) => `  - id: ${t}\n    source: .jgates/templates/${t}.yml\n    activation: always\n`).join(""));
  if (services) fs.appendFileSync(path.join(dir, "jgates.yml"), services);
  spawnSync("git", ["add", "-A"], { cwd: dir });
  return { dir, tools: Object.keys(tools) };
}

async function withEnglish(fn) {
  const { setLocale, getLocale } = await load("i18n", "index.js");
  const previous = getLocale();
  setLocale("en");
  try {
    return await fn();
  } finally {
    setLocale(previous);
  }
}

/** Builds the plan and runs it with the fake engine; `onEvent` sees every event. */
async function runProject(proj, engine, { signal, onEvent } = {}) {
  const { buildPlan } = await load("core", "plan", "index.js");
  const { executeRun } = await load("core", "run", "index.js");
  const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
  const home = tmp("svc-home-");
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: engine.runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const built = buildPlan(proj.dir, { only: proj.tools.map((t) => `tool:${t}`), env, home, compare: false, version: VERSION });
  assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
  const plan = built.plan;
  // An exit-code check proves no integration coverage (REQUIREMENT_UNCOVERED); the engine and the image are ready.
  assert.deepEqual(plan.blockers.filter((b) => b.code !== "REQUIREMENT_UNCOVERED"), [], "the fake engine and image are ready");
  const result = await executeRun({
    workspacePath: proj.dir,
    home,
    version: VERSION,
    adapter: "quality-bridge",
    options: { planHash: plan.planHash, planSource: "built", profile: "minimal", scope: "full" },
    plan,
    steps: (context) => planSteps(context, plan),
    disabled: planDisabled(plan),
    env,
    cache: false,
    ...(signal ? { signal } : {}),
    ...(onEvent ? { onEvent } : {}),
  });
  return { plan, result };
}

const composeCalls = (calls) => calls.filter((c) => c[0] === "compose");
const projectOf = (call) => call[call.indexOf("--project-name") + 1];
const subOf = (call) => ["up", "down", "logs", "ps"].find((s) => call.includes(s));
const stagesOf = (result, tool) => result.stages.filter((s) => s.execution?.step === tool);

function assertStepTerminatedBeforeDown(calls, step, snapshot) {
  const down = calls.findIndex((c) => c[0] === "compose" && subOf(c) === "down");
  assert.ok(down >= 0, "the run's services are taken down");
  const terminatesStep = (c) =>
    (c[0] === "kill" && c.length === 2 && [step.id, step.name].includes(c[1])) ||
    (c[0] === "rm" && c.length === 3 && c[1] === "--force" && c[2] === step.name);
  assert.ok(calls.slice(0, down).some(terminatesStep), "the exact step container is killed or force-removed before services go down");
  assert.ok(!snapshot.markers.includes(`${step.name}.container`), "the step is no longer running when compose down starts");
  assert.ok(!snapshot.containers.some((c) => (c.id === step.id || c.name === step.name) && c.state === "running"), "the registry has no running step at compose down");
}

test("service cancellation evidence accepts both exact termination paths and rejects missing, wrong, late or ineffective cleanup", () => {
  const step = { id: "step-id", name: "jgates-run-integ" };
  const down = ["compose", "--project-name", "jgates-run", "down"];
  const ended = { containers: [{ ...step, state: "exited" }], markers: [] };
  for (const cleanup of [["kill", step.id], ["kill", step.name], ["rm", "--force", step.name]]) {
    assertStepTerminatedBeforeDown([cleanup, down], step, ended);
    assert.throws(() => assertStepTerminatedBeforeDown([down, cleanup], step, ended));
    assert.throws(() => assertStepTerminatedBeforeDown([cleanup, down], step, { ...ended, markers: [`${step.name}.container`] }));
    assert.throws(() => assertStepTerminatedBeforeDown([cleanup, down], step, { ...ended, containers: [{ ...step, state: "running" }] }));
  }
  for (const cleanup of [null, ["kill"], ["kill", "another-id"], ["rm", "--force", "another-name"], ["rm", step.name], ["container", "rm", step.name]]) {
    assert.throws(() => assertStepTerminatedBeforeDown([...(cleanup ? [cleanup] : []), down], step, ended));
  }
});

// ---- discovery ---------------------------------------------------------------------------------------------------

test("discovery lists the compose files and reports privileged, network_mode host, host bind mounts and the other host effects", async () => {
  const { discoverCompose, listComposeFiles } = await load("core", "discovery", "compose.js");
  assert.deepEqual(listComposeFiles(FIXTURE), ["compose.yaml", "compose.test.yaml"]);
  const found = discoverCompose(FIXTURE);
  assert.deepEqual(found.problems, []);
  assert.deepEqual(found.files, ["compose.yaml", "compose.test.yaml"]);
  assert.deepEqual(found.services.map((s) => s.name), ["agent", "api", "db", "monitor"]);
  assert.deepEqual(found.volumes, ["pgdata"], "external volumes are not the project's");
  const byName = Object.fromEntries(found.services.map((s) => [s.name, s]));
  // Roles from evidence: a postgres image is a dependency, a project build with a published port the application.
  assert.equal(byName.db.role, "dependency");
  assert.equal(byName.api.role, "application");
  assert.equal(byName.db.healthcheck, true);
  assert.deepEqual(byName.api.dependsOn, ["db"]);
  assert.deepEqual(byName.api.ports, [{ published: "8000", target: "8000" }]);
  assert.deepEqual(byName.api.expose, ["9000"], "the override file adds to the service");
  assert.deepEqual(byName.monitor.profiles, ["debug"]);
  assert.equal(byName.db.image, "postgres:16-alpine", "merge keys (<<) of compose files are read");

  const kinds = (name) => byName[name].hostEffects.map((e) => e.kind).sort();
  assert.deepEqual(kinds("agent"), ["bind-mount", "bind-mount", "cap-add", "device", "network-host", "privileged"]);
  assert.deepEqual(kinds("monitor"), ["pid-host"]);
  const agentBinds = byName.agent.hostEffects.filter((e) => e.kind === "bind-mount");
  assert.ok(agentBinds.every((e) => e.insideProject === false), "host paths outside the project");
  assert.ok(agentBinds.some((e) => e.detail === "/var/run -> /host-run"));
  assert.ok(agentBinds.some((e) => e.detail === "~/cache -> /cache"));
  // Project binds (the usual `.:/app`) are host effects too, flagged inside the project.
  const apiBinds = byName.api.binds;
  assert.deepEqual(apiBinds.map((b) => [b.target, b.insideProject, b.resolved]), [
    ["/app", true, path.resolve(FIXTURE)],
    ["/fixtures", true, path.join(path.resolve(FIXTURE), "fixtures")],
  ]);
  assert.deepEqual(byName.db.binds.map((b) => [b.target, b.readOnly, b.insideProject]), [["/docker-entrypoint-initdb.d", true, true]], "named volumes are not binds");
  // Nothing was written next to the compose files.
  assert.deepEqual(fs.readdirSync(FIXTURE).sort(), ["compose.test.yaml", "compose.yaml"]);
});

test("discovery reports an unreadable compose file as a problem and never throws", async () => {
  const { discoverCompose } = await load("core", "discovery", "compose.js");
  const dir = tmp("svc-bad-compose-");
  fs.writeFileSync(path.join(dir, "compose.yaml"), "services: [unclosed\n");
  const found = discoverCompose(dir);
  assert.equal(found.services.length, 0);
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0], /^compose\.yaml: /);
});

// ---- governed refusal and the review ------------------------------------------------------------------------------

function selectionInput(dir, extra = {}) {
  const item = { id: "integ#integration", tool: "integ", adapter: "generic-command", capabilities: ["integration"] };
  return { projectDir: dir, configDir: dir, items: [item], invocations: [{ id: "integ" }], governed: false, ...extra };
}

function fixtureProject(services) {
  const dir = tmp("svc-effects-");
  for (const f of ["compose.yaml", "compose.test.yaml"]) fs.copyFileSync(path.join(FIXTURE, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "jgates.yml"), `schemaVersion: 2\n${services}`);
  return dir;
}

test("governed mode refuses privileged, network_mode host and host bind mounts unless the policy allows them; local mode lists them", async () => {
  const { planServices } = await load("core", "services", "index.js");
  await withEnglish(async () => {
    const dir = fixtureProject("services:\n  compose: [compose.yaml, compose.test.yaml]\n  start: [api, agent]\n");
    // Local: every host effect of the services that start is a warning of the review; nothing blocks.
    const local = planServices(selectionInput(dir));
    assert.deepEqual(local.services, ["agent", "api", "db"], "the named services and what they depend on");
    assert.deepEqual(local.blockers, []);
    const effects = local.warnings.filter((w) => w.code === "SERVICES_HOST_EFFECT").map((w) => w.message);
    assert.ok(effects.some((m) => /agent.*privileged/.test(m)), effects.join("\n"));
    assert.ok(effects.some((m) => /agent.*network-host/.test(m)), effects.join("\n"));
    assert.ok(effects.some((m) => /agent.*\/var\/run -> \/host-run/.test(m)), effects.join("\n"));
    assert.ok(effects.some((m) => /api.*\.:?\/?.* -> \/app.*read-only/.test(m) || /api mounts a folder of the project \(\. -> \/app\)/.test(m)), effects.join("\n"));
    assert.ok(!effects.some((m) => /monitor/.test(m)), "a service that does not start is not listed");

    // Governed: one blocker per effect the policy does not allow; the project binds (mounted read-only) are not refused.
    const governed = planServices(selectionInput(dir, { governed: true }));
    const refused = governed.blockers.map((b) => b.message);
    assert.ok(governed.blockers.every((b) => b.code === "SERVICES_HOST_EFFECT_REFUSED" && b.items.includes("integ#integration")));
    for (const pattern of [/agent \(privileged/, /agent \(network-host/, /agent \(bind-mount: \/var\/run -> \/host-run/, /agent \(bind-mount: ~\/cache -> \/cache/, /agent \(cap-add/, /agent \(device/]) {
      assert.ok(refused.some((m) => pattern.test(m)), `${pattern}: ${refused.join("\n")}`);
    }
    assert.ok(!refused.some((m) => /service api/.test(m)), "the project binds of api are mounted read-only, not refused");

    // The policy allows them: nothing is refused.
    const allowed = fixtureProject("services:\n  compose: [compose.yaml]\n  start: [agent]\n  allowHostEffects: [privileged, network-host, bind-mount, cap-add, device]\n");
    assert.deepEqual(planServices(selectionInput(allowed, { governed: true })).blockers, []);
    // A writable project folder is never allowed in governed mode.
    const writable = fixtureProject("services:\n  compose: [compose.yaml]\n  start: [api]\n  writableBinds: [api]\n  allowHostEffects: [bind-mount]\n");
    const refusedWritable = planServices(selectionInput(writable, { governed: true })).blockers;
    assert.equal(refusedWritable.length, 1, JSON.stringify(refusedWritable));
    assert.match(refusedWritable[0].message, /never lets the service api write to the project folder/);
    assert.match(planServices(selectionInput(writable)).warnings.map((w) => w.message).join("\n"), /api may write to the project folder/);
  });
});

test("a governed run refuses to start services with host effects the policy does not allow: the dependent step is SERVICES_NOT_READY and nothing starts", async () => {
  const { createServicesRun } = await load("core", "services", "index.js");
  await withEnglish(async () => {
    const dir = fixtureProject("services:\n  compose: [compose.yaml]\n  start: [agent]\n");
    const engine = fakeEngine();
    const runDir = tmp("svc-rundir-");
    const plan = { groups: { willRun: [{ id: "integ#integration", tool: "integ", adapter: "generic-command", capabilities: ["integration"] }] }, invocations: [{ id: "integ" }] };
    const env = { ...process.env, JGATES_CONTAINER_RUNTIME: engine.runtime, JGATES_IMAGE_JSON: "" };
    const services = createServicesRun({ plan, projectDir: dir, configDir: dir, workspace: "ws_0123456789abcdef", runId: "run_x", runDir, version: VERSION, env, governed: true });
    const outcome = await services.phase.run();
    assert.equal(outcome.ok, true, "a refusal never blocks the steps that do not use services");
    assert.equal(outcome.details.status, "refused");
    assert.ok(outcome.details.refused.some((e) => e.kind === "privileged"));
    const [step] = services.gate([{ id: "integ", skeleton: () => ({}), run: async () => ({}) }, { id: "lint-a", skeleton: () => ({}), run: async () => ({}) }]);
    const problems = step.preflight();
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, "SERVICES_NOT_READY");
    assert.match(problems[0].message, /^Governed mode refuses these host effects of the services: .*agent: privileged: true; agent: network_mode: host;.*The policy must allow them/);
    assert.equal(services.stepEnvironment("integ"), null);
    assert.deepEqual(composeCalls(engine.calls()), [], "compose never ran");
    await services.teardown();
    assert.deepEqual(composeCalls(engine.calls()), [], "nothing to take down");
  });
});

test("a check that names a service with no services configured, or a service the compose files lack, is SERVICES_REQUIRED; a URL target needs no services", async () => {
  const { createServicesRun, selectServices } = await load("core", "services", "index.js");
  await withEnglish(async () => {
    const zapItem = { id: "zap#dast", tool: "zap", adapter: "zap", capabilities: ["dast"] };
    const serviceContract = { target: "http://api:8000", service: { name: "api", port: 8000, path: "" } };
    const bare = tmp("svc-required-");
    fs.writeFileSync(path.join(bare, "jgates.yml"), "schemaVersion: 2\n");
    const plan = { groups: { willRun: [zapItem] }, invocations: [{ id: "zap", contract: serviceContract }] };
    const env = { ...process.env, JGATES_CONTAINER_RUNTIME: fakeEngine().runtime, JGATES_IMAGE_JSON: "" };
    const run = createServicesRun({ plan, projectDir: bare, configDir: bare, workspace: "ws_0123456789abcdef", runId: "run_y", runDir: tmp("svc-rundir-"), version: VERSION, env, governed: false });
    assert.equal((await run.phase.run()).details.status, "not-configured");
    const [gated] = run.gate([{ id: "zap", skeleton: () => ({}), run: async () => ({}) }]);
    const [problem] = gated.preflight();
    assert.equal(problem.code, "SERVICES_REQUIRED");
    assert.match(problem.message, /This check needs the project services.*Configure the services in the services section of jgates\.yml/);

    const other = fixtureProject("services:\n  compose: [compose.yaml]\n");
    const unknown = selectServices({ projectDir: other, configDir: other, items: [zapItem], invocations: [{ id: "zap", contract: { ...serviceContract, service: { name: "web", port: 80, path: "" } } }], governed: false });
    assert.deepEqual(unknown.steps.get("zap").required, { reason: "unknown-service", service: "web" });
    // A URL target (the developer's own running stack) keeps its own network: no services, no SERVICES_REQUIRED.
    assert.equal(selectServices({ projectDir: bare, configDir: bare, items: [zapItem], invocations: [{ id: "zap", contract: { target: "http://localhost:3000", service: null } }], governed: false }), null);
    // An integration check without a services section runs as before.
    assert.equal(selectServices(selectionInput(bare)), null);
  });
});

test("ZAP and Schemathesis accept service:<name>:<port> targets and reach them by name; a malformed one is refused", async () => {
  const { zapSettings, containerTarget } = await load("adapters", "zap", "index.js");
  const { schemathesisSettings, urlAsStepSees } = await load("adapters", "schemathesis", "index.js");
  const config = (target) => ({ tools: { t: { target } } });
  const zap = zapSettings({ config: config("service:api:8000"), tool: "t" });
  assert.deepEqual([zap.target, zap.service, zap.problems], ["http://api:8000", { name: "api", port: 8000, path: "" }, []]);
  assert.equal(containerTarget(zap.target, { JGATES_IMAGE_JSON: "" }), "http://api:8000", "a service name is not rewritten to the host alias");
  const st = schemathesisSettings({ config: config("service:api:8000/v1"), tool: "t" });
  assert.deepEqual([st.target, st.service], ["http://api:8000/v1", { name: "api", port: 8000, path: "/v1" }]);
  assert.equal(urlAsStepSees(st.target, { JGATES_IMAGE_JSON: "" }), "http://api:8000/v1");
  assert.equal(schemathesisSettings({ config: config("http://localhost:8000"), tool: "t" }).service, null);
  for (const bad of ["service:api", "service:api:0", "service:-x:80", "service:api:99999"]) {
    assert.equal(zapSettings({ config: config(bad), tool: "t" }).problems.length, 1, bad);
    assert.equal(schemathesisSettings({ config: config(bad), tool: "t" }).problems.length, 1, bad);
  }
});

// ---- the override file ----------------------------------------------------------------------------------------------

test("the run's override file labels the services, resets their published ports, mounts project folders read-only and keeps the network internal", async () => {
  const { servicesOverride } = await load("core", "services", "index.js");
  const { discoverCompose } = await load("core", "discovery", "compose.js");
  const discovery = discoverCompose(FIXTURE);
  const labels = { "org.jgates.managed": "true", "org.jgates.kind": "services", "org.jgates.run": "run_z" };
  const text = servicesOverride({ discovery, services: ["api", "db"], labels });
  const lines = text.split("\n");
  const section = (name) => lines.slice(lines.indexOf(`  ${JSON.stringify(name)}:`), lines.findIndex((l, i) => i > lines.indexOf(`  ${JSON.stringify(name)}:`) && /^ {2}"/.test(l)));
  const api = section("api").join("\n");
  assert.match(api, /ports: !reset \[\]/);
  assert.match(api, /"org\.jgates\.run": "run_z"/);
  assert.match(api, new RegExp(`source: ${JSON.stringify(path.resolve(FIXTURE)).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\n\\s+target: "/app"\\n\\s+read_only: true`));
  assert.match(api, /target: "\/fixtures"\n\s+read_only: true/);
  assert.match(text, /networks:\n {2}default:\n {4}internal: true\n {4}labels:\n {6}"org\.jgates\.managed": "true"/);
  assert.match(text, /volumes:\n {2}"pgdata":\n {4}labels:/);
  assert.ok(!text.includes("agent"), "only the services that start");
  // writableBinds keeps the project folder of that service writable (labels and ports still apply).
  const writable = servicesOverride({ discovery, services: ["api"], labels, writable: ["api"] });
  assert.ok(!writable.includes("read_only"));
  assert.match(writable, /ports: !reset \[\]/);
});

// ---- runs with the fake engine ------------------------------------------------------------------------------------

const SERVICES_SECTION = "services:\n  compose: [compose.yaml]\n  timeoutSeconds: 30\n";

test("a run starts the services as its own project, only the integration step joins their network, and the project is taken down at the end", async () => {
  await withEnglish(async () => {
    const proj = await project(SERVICES_SECTION);
    const engine = fakeEngine({ FAKE_DOCKER_COMPOSE_PS: '{"Service":"db","State":"running","Health":"healthy"}\n' });
    const events = [];
    const { plan, result } = await runProject(proj, engine, { onEvent: (e) => events.push(e) });
    // The review: the selected services are part of the plan, and the project bind of db is listed.
    assert.deepEqual(plan.inputs.container.services, ["db"]);
    const effects = plan.warnings.filter((w) => w.code === "SERVICES_HOST_EFFECT").map((w) => w.message);
    assert.deepEqual(effects, ["The service db mounts a folder of the project (./initdb -> /docker-entrypoint-initdb.d); JGates mounts it read-only."]);

    for (const tool of proj.tools) assert.deepEqual(stagesOf(result, tool).map((s) => s.state), ["completed"], `${tool}: ${JSON.stringify(stagesOf(result, tool))}`);
    const calls = engine.calls();
    const compose = composeCalls(calls);
    const projectName = `jgates-${result.workspace.id}-${result.runId}`.toLowerCase();
    assert.deepEqual([...new Set(compose.map(projectOf))], [projectName], "every compose call is for the run's project");
    assert.deepEqual(compose.map(subOf), ["up", "ps", "down"]);
    const up = compose[0];
    assert.ok(up.includes("--wait") && up.includes("--no-build") && up.at(-1) === "db", JSON.stringify(up));
    const files = up.filter((a, i) => up[i - 1] === "-f");
    // (The workspace path is normalized; Windows paths compare without case.)
    const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
    assert.ok(same(files[0], path.join(proj.dir, "compose.yaml")), files[0]);
    assert.equal(files[1], path.join(result.runDir, "services", "compose.jgates.yml"), "the override file is in the run folder, never in the project");
    assert.match(fs.readFileSync(files[1], "utf8"), /read_only: true/);
    const down = compose.at(-1);
    assert.ok(down.includes("--volumes") && down.includes("--remove-orphans"));
    // The integration step joined the services network; the lint step kept no network.
    const runOf = (tool) => calls.find((c) => c[0] === "run" && c[c.indexOf("--name") + 1] === `jgates-${result.runId}-${tool}`);
    assert.equal(runOf("integ")[runOf("integ").indexOf("--network") + 1], `${projectName}_default`);
    assert.equal(runOf("lint-a")[runOf("lint-a").indexOf("--network") + 1], "none");
    const phase = events.find((e) => e.type === "phase-finished" && e.data.phase === "services");
    assert.equal(phase.data.details.status, "ready");
    assert.deepEqual(phase.data.details.states, [{ service: "db", state: "running", health: "healthy" }]);
    assert.ok(events.some((e) => e.type === "phase-finished" && e.data.phase === "services-down"));
    assert.ok(result.artifacts.logs.includes("logs/services.log"));
    assert.equal(fs.existsSync(path.join(proj.dir, "compose.jgates.yml")), false);
  });
});

test("an unhealthy service blocks the dependent step with SERVICES_NOT_READY, its logs are a log block, the other step runs, and compose down runs for the run project only", async () => {
  await withEnglish(async () => {
    const proj = await project(SERVICES_SECTION);
    const engine = fakeEngine({
      FAKE_DOCKER_COMPOSE_UP_EXIT: "1",
      FAKE_DOCKER_COMPOSE_UP_STDERR: "dependency failed to start: container jgates-x-db-1 is unhealthy",
      FAKE_DOCKER_COMPOSE_LOGS: "db-1  | FATAL:  password authentication failed for user \"app\"\n",
    });
    const { result } = await runProject(proj, engine);
    assert.equal(result.decision, "incomplete");
    const [integ] = stagesOf(result, "integ");
    assert.equal(integ.state, "blocked", JSON.stringify(integ));
    assert.equal(integ.execution.notRun.problems[0].code, "SERVICES_NOT_READY");
    assert.match(integ.reason, /The service db was not ready in 30 seconds\. The services' log is in logs\/services\.log\./);
    assert.deepEqual(stagesOf(result, "lint-a").map((s) => s.state), ["completed"], "a step that does not use services still runs");
    assert.ok(result.artifacts.logs.includes("logs/services.log"), JSON.stringify(result.artifacts.logs));
    const log = fs.readFileSync(path.join(result.runDir, "logs", "services.log"), "utf8");
    assert.match(log, /is unhealthy/);
    assert.match(log, /FATAL: {2}password authentication failed/, "the services' own logs are in the log block");
    const compose = composeCalls(engine.calls());
    const projectName = `jgates-${result.workspace.id}-${result.runId}`.toLowerCase();
    assert.deepEqual([...new Set(compose.map(projectOf))], [projectName]);
    assert.deepEqual(compose.map(subOf), ["up", "logs", "down"], "failure: logs, then down, once");
    assert.ok(!engine.calls().some((c) => c[0] === "run" && c.includes(`jgates-${result.runId}-integ`)), "the blocked step never started");
  });
});

test("cancelling a run while a step uses the services takes the run's compose project down, and only it", async () => {
  await withEnglish(async () => {
    const { runServices } = await load("core", "runner", "index.js");
    const proj = await project(SERVICES_SECTION);
    const snapshotFile = path.join(tmp("svc-cancel-evidence-"), "first-compose-down.json");
    const engine = fakeEngine({ FAKE_DOCKER_STEP_MODE: "hang", FAKE_DOCKER_STEP_NAME: "integ", FAKE_DOCKER_COMPOSE_DOWN_SNAPSHOT: snapshotFile });
    const controller = new AbortController();
    let runId = null;
    const pending = runProject(proj, engine, { signal: controller.signal, onEvent: (e) => (e.type === "run-started" ? (runId = e.runId) : null) });
    await until(() => fs.readdirSync(engine.dir).find((f) => /integ\.container$/.test(f)), 60_000, "the integ container to start");
    const step = JSON.parse(fs.readFileSync(path.join(engine.dir, "objects.json"), "utf8")).containers.find((c) => c.name === `jgates-${runId}-integ`);
    assert.ok(step, "the started step is registered");
    assert.equal(step.labels["org.jgates.run"], runId);
    assert.equal(step.labels["org.jgates.managed"], "true");
    controller.abort("user cancelled");
    const { result } = await pending;
    assert.equal(result.decision, "cancelled");
    assert.equal(result.runId, runId);
    const calls = engine.calls();
    const compose = composeCalls(calls);
    const projectName = `jgates-${result.workspace.id}-${result.runId}`.toLowerCase();
    assert.deepEqual([...new Set(compose.map(projectOf))], [projectName], "nothing but the run's project");
    assert.ok(compose.filter((c) => subOf(c) === "down").length >= 1, JSON.stringify(compose));
    const integRun = calls.find((c) => c[0] === "run" && c.includes(`jgates-${result.runId}-integ`));
    assert.equal(integRun[integRun.indexOf("--network") + 1], `${projectName}_default`);
    assertStepTerminatedBeforeDown(calls, step, JSON.parse(fs.readFileSync(snapshotFile, "utf8")));
    assert.equal(fs.existsSync(path.join(engine.dir, `${step.name}.container`)), false, "no step marker remains");
    const remaining = JSON.parse(fs.readFileSync(path.join(engine.dir, "objects.json"), "utf8")).containers;
    assert.ok(!remaining.some((c) => (c.id === step.id || c.name === step.name) && c.state === "running"), "no running step remains");
    assert.deepEqual(runServices(result.runId), [], "nothing stays registered");
  });
});
