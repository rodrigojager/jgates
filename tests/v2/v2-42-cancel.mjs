import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-42 (fake engine): cancelling a run stops only that run's containers and services, and keeps the evidence of the
// steps that had finished. A run of three steps (gen-a, gen-b, gen-c) is started in this process (a cancellation is an
// abort signal; a child process cannot be sent one portably) with the engine CLI replaced by the fake engine, whose step
// container for gen-b never ends. The fake engine already holds two containers that are not this run's: one with
// another run's JGates label and one with no label at all. Once gen-b is running the run is cancelled, and:
//   - `docker kill` is issued only for the containers that carry this run's label (never for the other two, which are
//     still running afterwards), after a listing filtered by `org.jgates.managed` and `org.jgates.run=<this run>`;
//   - `docker compose down` is issued for the services project the run had brought up, and only for it;
//   - the result is the final one (not partial): decision cancelled, exit 130, gen-a completed with its evidence, gen-b
//     cancelled, gen-c cancelled as not run; the events say the cancel phase killed gen-b's container.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(root, "jgates", "dist");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
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

function template(tool) {
  return [
    "schemaVersion: 1",
    `id: ${tool}`,
    "extends: [builtin:base]",
    "config:",
    "  tools:",
    `    ${tool}:`,
    "      adapter: generic-command",
    "      enabled: true",
    "      capabilities: [lint]",
    `      command: ${JSON.stringify(process.execPath)}`,
    '      args: ["{workspace}/check.js"]',
    "      config:",
    "        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
    "        evidence: { kind: exit-code }",
    "",
  ].join("\n");
}

test("V2-42: cancel kills only the run's labelled containers, takes its services down and keeps the finished steps' evidence", async () => {
  const { setLocale, getLocale } = await load("i18n", "index.js");
  const previousLocale = getLocale();
  setLocale("en");
  try {
    const { planInit, writeInit } = await load("core", "init", "index.js");
    const { buildPlan } = await load("core", "plan", "index.js");
    const { executeRun } = await load("core", "run", "index.js");
    const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
    const { registerRunServices } = await load("core", "runner", "index.js");

    const project = tmp("v2-42-project-");
    const home = tmp("v2-42-home-");
    const engine = tmp("v2-42-engine-");
    const calls = path.join(engine, "calls.jsonl");
    const runtime = path.join(engine, "docker.cjs");
    fs.writeFileSync(
      runtime,
      [
        `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};`,
        `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`,
        `process.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": VERSION }))};`,
        'process.env.FAKE_DOCKER_STEP_MODE = "hang";',
        'process.env.FAKE_DOCKER_STEP_NAME = "gen-b";',
        `require(${JSON.stringify(FAKE)});`,
        "",
      ].join("\n"),
    );
    // Containers of the engine that are not this run's: another run of JGates, and one that is not JGates' at all.
    fs.writeFileSync(
      path.join(engine, "objects.json"),
      JSON.stringify({
        containers: [
          { id: "aaaaaaaaaaaa", name: "jgates-run_other-step", state: "running", labels: { "org.jgates.managed": "true", "org.jgates.kind": "step", "org.jgates.run": "run_other" } },
          { id: "bbbbbbbbbbbb", name: "someone-elses-db", state: "running", labels: {} },
        ],
        volumes: [],
        networks: [],
        images: [],
      }),
    );
    const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };

    fs.writeFileSync(path.join(project, "check.js"), "process.exit(0);\n");
    fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
    writeInit(project, planInit(project, "minimal"));
    const tools = ["gen-a", "gen-b", "gen-c"];
    for (const tool of tools) fs.writeFileSync(path.join(project, ".jgates", "templates", `${tool}.yml`), template(tool));
    fs.appendFileSync(path.join(project, "jgates.yml"), tools.map((tool) => `  - id: ${tool}\n    source: .jgates/templates/${tool}.yml\n    activation: always\n`).join(""));
    spawnSync("git", ["add", "-A"], { cwd: project });

    const built = buildPlan(project, { only: tools.map((t) => `tool:${t}`), env, home, compare: false, version: VERSION });
    assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
    const plan = built.plan;
    assert.deepEqual(plan.blockers, [], "the fake engine and image are ready");

    const controller = new AbortController();
    let runId = null;
    const servicesProject = "jgates-ws-services";
    const events = [];
    const pending = executeRun({
      workspacePath: project,
      home,
      version: VERSION,
      adapter: "quality-bridge",
      options: { planHash: plan.planHash, planSource: "built", profile: "minimal", scope: "full" },
      plan,
      steps: (context) => planSteps(context, plan),
      disabled: planDisabled(plan),
      env,
      cache: false,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "run-started") {
          runId = event.runId;
          // The services phase (a later slice) registers the compose project it brings up; cancel takes it down.
          registerRunServices(runId, {
            project: servicesProject,
            files: [path.join(project, "compose.yml")],
            labels: { "org.jgates.managed": "true", "org.jgates.kind": "services", "org.jgates.run": runId },
          });
        }
      },
    });
    // gen-b's step container is running (the fake engine keeps a marker file per live container).
    await until(() => fs.readdirSync(engine).find((f) => /gen-b\.container$/.test(f)), 60_000, "the gen-b container to start");
    controller.abort("user cancelled");
    const result = await pending;

    // 1. The decision and the evidence kept.
    assert.equal(result.decision, "cancelled");
    assert.equal(result.exitCode, 130);
    const onDisk = JSON.parse(fs.readFileSync(path.join(result.runDir, "result.json"), "utf8"));
    assert.equal(onDisk.partial, undefined, "the final result replaced the partial one");
    assert.equal(onDisk.decision, "cancelled");
    const stateOf = (tool) => result.stages.filter((s) => s.execution?.step === tool).map((s) => s.state);
    assert.deepEqual(stateOf("gen-a"), ["completed"], "the finished step keeps its evidence");
    assert.deepEqual(stateOf("gen-b"), ["cancelled"], "the running step is cancelled");
    assert.deepEqual(stateOf("gen-c"), ["cancelled"], "the step that never started is recorded as cancelled");
    assert.ok(fs.readdirSync(path.join(result.runDir, "logs")).some((f) => f.startsWith("gen-a")), "gen-a's log stays in the run folder");

    // 2. Engine calls: a listing by this run's label, one kill with only this run's container, then the compose down.
    const dockerCalls = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const listing = dockerCalls.find((c) => c[0] === "container" && c[1] === "ls" && c.includes(`label=org.jgates.run=${result.runId}`));
    assert.ok(listing, `the run's containers are listed by their label: ${JSON.stringify(dockerCalls.filter((c) => c[0] === "container"))}`);
    assert.ok(listing.includes("label=org.jgates.managed=true"), "the listing is also limited to JGates objects");
    const kills = dockerCalls.filter((c) => c[0] === "kill");
    assert.equal(kills.length, 1, `one kill: ${JSON.stringify(kills)}`);
    const killed = kills[0].slice(1);
    assert.equal(killed.length, 1, "only one container is killed");
    const stepContainer = `jgates-${result.runId}-gen-b`;
    const objects = JSON.parse(fs.readFileSync(path.join(engine, "objects.json"), "utf8"));
    assert.ok(!objects.containers.some((c) => c.name === stepContainer), "the run's container is gone");
    const survivors = objects.containers.map((c) => [c.name, c.state]);
    assert.deepEqual(survivors.sort(), [["jgates-run_other-step", "running"], ["someone-elses-db", "running"]], "containers that are not this run's are untouched");
    assert.ok(!killed.includes("aaaaaaaaaaaa") && !killed.includes("bbbbbbbbbbbb"));
    const down = dockerCalls.filter((c) => c[0] === "compose" && c.includes("down"));
    assert.equal(down.length, 1, `one compose down: ${JSON.stringify(down)}`);
    assert.equal(down[0][down[0].indexOf("--project-name") + 1], servicesProject, "compose down is limited to the run's project");
    assert.ok(dockerCalls.indexOf(kills[0]) < dockerCalls.indexOf(down[0]), "containers first, then the services");
    assert.ok(!dockerCalls.some((c) => c[0] === "system" || (c[1] === "prune") || c[0] === "volume" && c[1] === "rm"), "nothing is pruned or removed outside the run");

    // 3. The events say what the cancel did.
    const cancelDone = events.find((e) => e.type === "phase-finished" && e.data.phase === "cancel");
    assert.ok(cancelDone, "the cancel phase is in the event stream");
    assert.equal(cancelDone.data.status, "succeeded", JSON.stringify(cancelDone.data));
    assert.deepEqual(cancelDone.data.details.servicesDown, [servicesProject]);
    assert.deepEqual(cancelDone.data.details.killed, [stepContainer]);
    assert.equal(events.at(-1).type, "run-finished");
    assert.ok(events.findIndex((e) => e.type === "cancel-requested") < events.findIndex((e) => e.type === "phase-finished" && e.data.phase === "cancel"));
  } finally {
    setLocale(previousLocale);
  }
});
