import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Engine-facing behaviour of a run with the fake engine (tests/docker/fake-docker.cjs): the timeoutSeconds of a step is
// enforced by the executor for an adapter that sets no timeout itself (the container is stopped with `docker stop -t`
// and removed), the log of a step container starts with its in-container command and the full `docker run` line, the
// plan hash changes with each container-first input (image digest, extension digests, dependency keys, data timestamps,
// services selection) and every result records those values, and cancelling only touches what is labelled and
// registered for the run.

const here = path.dirname(fileURLToPath(import.meta.url));
// This file tests the container mode (the default outside the tools image): not the in-image mode of the other tests
// (tests/setup/in-image.mjs); every engine call goes to the fake engine.
const IN_IMAGE_JSON = process.env.JGATES_IMAGE_JSON;
delete process.env.JGATES_IMAGE_JSON;
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const dist = path.resolve(here, "..", "dist");
const load = (...parts) => import(pathToFileURL(path.join(dist, ...parts)).href);
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

/** A fake engine: the runtime script, its call log and its state folder. */
function fakeEngine(vars = {}) {
  const dir = tmp("jgates-engine-");
  const calls = path.join(dir, "calls.jsonl");
  const runtime = path.join(dir, "docker.cjs");
  const lines = [
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};`,
    `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(dir)};`,
    `process.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": VERSION }))};`,
    ...Object.entries(vars).map(([k, v]) => `process.env.${k} = ${JSON.stringify(v)};`),
    `require(${JSON.stringify(FAKE)});`,
    "",
  ];
  fs.writeFileSync(runtime, lines.join("\n"));
  const recorded = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, runtime, recorded, env: (home) => ({ ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" }) };
}

const outcome = (id, state) => ({ stages: [{ id, state }], requirements: [{ id, required: true }], disabled: [], findings: [], logs: [], outputs: [] });

test("timeoutSeconds of a step is enforced by the executor for an adapter without its own timeout: stop -t, then remove, and the stage is a timeout", async () => {
  const { executeSteps, createStepLauncher, runSpec } = await load("core", "runner", "index.js");
  const engine = fakeEngine({ FAKE_DOCKER_STEP_MODE: "hang" });
  const runDir = tmp("jgates-run-");
  const projectDir = tmp("jgates-project-");
  const env = engine.env(tmp("jgates-home-"));
  const launcher = createStepLauncher({ env, workspaceId: "ws_0123456789abcdef", runId: "run_t1", runDir, projectDir, version: VERSION, image: "sha256:" + "a".repeat(64) });
  const step = {
    id: "slow",
    skeleton: () => outcome("slow#check", "pending"),
    timeoutSeconds: 1,
    // No timeoutMs in the spec: this adapter ignores timeoutSeconds, like the external adapters did.
    run: async () => {
      const result = await runSpec({ executable: "slowtool", args: ["--scan"], cwd: projectDir });
      return outcome("slow#check", result.exitCode === 0 ? "completed" : "error");
    },
  };
  const started = Date.now();
  const executed = await executeSteps([step], { launcher });
  assert.ok(Date.now() - started < 30_000, "the step did not run forever");
  const stage = executed.reports[0].output.stages[0];
  assert.equal(stage.state, "timeout");
  assert.match(stage.reason, /(time limit of 1 s|limite de tempo de 1 s)/);
  assert.equal(stage.execution.timedOut, true);
  const calls = engine.recorded();
  const name = "jgates-run_t1-slow";
  const stop = calls.findIndex((c) => c[0] === "stop" && c.includes(name));
  const remove = calls.findIndex((c) => c[0] === "rm" && c.includes(name));
  assert.ok(stop >= 0 && remove > stop, `docker stop then docker rm for ${name}: ${JSON.stringify(calls.map((c) => c.slice(0, 3)))}`);
  assert.deepEqual(calls[stop].slice(0, 3), ["stop", "--time", "5"]);
  assert.equal(fs.existsSync(path.join(engine.dir, `${name}.container`)), false, "the container is gone");
});

test("a tool that fails keeps its own exit code in the step facts, and the engine liveness probe is not one of the step's processes", async () => {
  const { executeSteps, createStepLauncher, runSpec } = await load("core", "runner", "index.js");
  const engine = fakeEngine({ FAKE_DOCKER_EXIT: "3" });
  const runDir = tmp("jgates-run-");
  const projectDir = tmp("jgates-project-");
  const env = engine.env(tmp("jgates-home-"));
  const launcher = createStepLauncher({ env, workspaceId: "ws_0123456789abcdef", runId: "run_t4", runDir, projectDir, version: VERSION, image: "sha256:" + "c".repeat(64) });
  const step = {
    id: "failing",
    skeleton: () => outcome("failing#check", "pending"),
    run: async () => {
      const result = await runSpec({ executable: "sometool", args: [], cwd: projectDir });
      return outcome("failing#check", result.exitCode === 0 ? "completed" : "error");
    },
  };
  const executed = await executeSteps([step], { launcher });
  const stage = executed.reports[0].output.stages[0];
  assert.equal(stage.state, "error");
  assert.equal(stage.execution.exitCode, 3, "the tool's exit code, not the one of a later engine command");
  assert.equal(stage.execution.processes, 1);
  assert.ok(engine.recorded().some((c) => c[0] === "version"), "a failure while the engine answers is checked once, and it does answer");
  assert.equal(launcher.engineLost(), null);
});

test("the stderr log of a step container starts with the in-container command and the full docker run line", async () => {
  const { executeSteps, createStepLauncher, runSpec } = await load("core", "runner", "index.js");
  const engine = fakeEngine();
  const runDir = tmp("jgates-run-");
  const projectDir = tmp("jgates-project-");
  fs.mkdirSync(path.join(projectDir, "sub"));
  const env = engine.env(tmp("jgates-home-"));
  const launcher = createStepLauncher({ env, workspaceId: "ws_0123456789abcdef", runId: "run_t2", runDir, projectDir, version: VERSION, image: "sha256:" + "b".repeat(64) });
  const stderrFile = path.join(runDir, "tool.stderr.log");
  const step = {
    id: "tool",
    skeleton: () => outcome("tool#check", "pending"),
    run: async () => {
      const result = await runSpec({ executable: "mytool", args: ["check", path.join(projectDir, "sub", "a b.py"), "--out", path.join(runDir, "out.json")], cwd: path.join(projectDir, "sub"), stderrFile });
      return outcome("tool#check", result.exitCode === 0 ? "completed" : "error");
    },
  };
  await executeSteps([step], { launcher });
  const log = fs.readFileSync(stderrFile, "utf8");
  const [head] = log.split("\n---\n");
  assert.match(head, /^executable: mytool$/m);
  assert.match(head, /^args: \["check","\/workspace\/sub\/a b\.py","--out","\/output\/out\.json"\]$/m, "the command as run inside the container, host paths mapped");
  assert.match(head, /^cwd: \/workspace\/sub$/m);
  assert.match(head, /^container: jgates-run_t2-tool$/m);
  const line = /^Comando executado: (.*)$/m.exec(head)?.[1];
  assert.ok(line, head);
  assert.ok(line.startsWith(engine.runtime) || line.includes("docker.cjs"), "the line starts with the engine client");
  for (const part of ["run", "--rm", "--init", "--pull never", "--read-only", "--cap-drop ALL", "--network none", "--name jgates-run_t2-tool", "org.jgates.kind=step", "org.jgates.run=run_t2", "sha256:" + "b".repeat(64), "mytool"]) {
    assert.ok(line.includes(part), `the docker run line holds ${part}: ${line}`);
  }
  assert.match(log, /\nexit code: 0\n/, "the footer is kept");
  // The line is the call the engine really received.
  const run = engine.recorded().find((c) => c[0] === "run" && c.includes("--name") && c[c.indexOf("--name") + 1] === "jgates-run_t2-tool");
  assert.ok(run);
  assert.ok(run.every((arg) => line.includes(arg.includes(" ") ? `'${arg}'` : arg)), "every argument of the real call is on the line");
});

test("a stderr log the adapter wrote itself gets the in-container command and the docker run line in front of its own header", async () => {
  const { executeSteps, createStepLauncher, runSpec } = await load("core", "runner", "index.js");
  const engine = fakeEngine();
  const runDir = tmp("jgates-run-");
  const projectDir = tmp("jgates-project-");
  fs.mkdirSync(path.join(runDir, "logs"));
  const env = engine.env(tmp("jgates-home-"));
  const launcher = createStepLauncher({ env, workspaceId: "ws_0123456789abcdef", runId: "run_t5", runDir, projectDir, version: VERSION, image: "sha256:" + "d".repeat(64) });
  const step = {
    id: "own-log",
    skeleton: () => outcome("own-log#check", "pending"),
    run: async () => {
      const result = await runSpec({ executable: "ownlog", args: ["--flag"], cwd: projectDir });
      fs.writeFileSync(path.join(runDir, "logs", "own-log.stderr.log"), `executable: ownlog\nargs: ["--flag"]\nexit code: ${result.exitCode}\n---\nstderr text\n`);
      return { ...outcome("own-log#check", "completed"), logs: ["logs/own-log.stdout.log", "logs/own-log.stderr.log"] };
    },
  };
  await executeSteps([step], { launcher });
  const log = fs.readFileSync(path.join(runDir, "logs", "own-log.stderr.log"), "utf8");
  assert.match(log, /^executable: ownlog\nargs: \["--flag"\]\ncwd: \/workspace\ncontainer: jgates-run_t5-own-log\n/);
  assert.match(log, /\nComando executado: .*--name jgates-run_t5-own-log .*ownlog --flag\n---\nexecutable: ownlog\n/, "the adapter's own header follows");
  assert.match(log, /stderr text\n$/);
});

async function planProject(engine, container) {
  const { planInit, writeInit } = await load("core", "init", "index.js");
  const { buildPlan } = await load("core", "plan", "index.js");
  const project = tmp("jgates-planproject-");
  const home = tmp("jgates-home-");
  fs.writeFileSync(path.join(project, "check.js"), "process.exit(0);\n");
  fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  writeInit(project, planInit(project, "minimal"));
  fs.writeFileSync(
    path.join(project, ".jgates", "templates", "gen-a.yml"),
    [
      "schemaVersion: 1",
      "id: gen-a",
      "extends: [builtin:base]",
      "config:",
      "  tools:",
      "    gen-a:",
      "      adapter: generic-command",
      "      enabled: true",
      "      capabilities: [lint]",
      `      command: ${JSON.stringify(process.execPath)}`,
      '      args: ["{workspace}/check.js"]',
      "      config:",
      "        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }",
      "        evidence: { kind: exit-code }",
      "",
    ].join("\n"),
  );
  fs.appendFileSync(path.join(project, "jgates.yml"), "  - id: gen-a\n    source: .jgates/templates/gen-a.yml\n    activation: always\n");
  spawnSync("git", ["add", "-A"], { cwd: project });
  const env = engine.env(home);
  const plan = (options = {}) => {
    const built = buildPlan(project, { only: ["tool:gen-a"], env, home, compare: false, version: VERSION, ...options });
    assert.equal(built.ok, true, JSON.stringify(built.errors ?? built.error));
    return built.plan;
  };
  return { project, home, env, plan, container };
}

test("each container-first input changes the plan hash, the same inputs never do, and a result records every value", async () => {
  const { executeRun } = await load("core", "run", "index.js");
  const { planSteps, planDisabled } = await load("core", "run", "plan-run.js");
  const a = await planProject(fakeEngine({ FAKE_DOCKER_IMAGE_ID: "sha256:" + "1".repeat(64) }));
  const base = {
    extensionImages: [{ name: "acme/tools", digest: "sha256:" + "e".repeat(64) }],
    dependencyKeys: { api: "key-1", web: "key-2" },
    dataTimestamps: { osv: "2026-11-01T00:00:00.000Z", trivy: null },
    services: ["db", "cache"],
  };
  const reference = a.plan({ container: base });
  assert.equal(reference.inputs.container.toolsImage, "sha256:" + "1".repeat(64), "the tools image digest is read from the engine");
  assert.deepEqual(reference.inputs.container.services, ["cache", "db"], "sorted");

  // Same inputs, written in another order: the same plan hash.
  const reordered = a.plan({ container: { ...base, services: ["cache", "db"], dependencyKeys: { web: "key-2", api: "key-1" }, dataTimestamps: { trivy: null, osv: "2026-11-01T00:00:00.000Z" } } });
  assert.equal(reordered.planHash, reference.planHash);

  const variants = {
    "extension image digest": { extensionImages: [{ name: "acme/tools", digest: "sha256:" + "f".repeat(64) }] },
    "dependency key": { dependencyKeys: { ...base.dependencyKeys, api: "key-1-changed" } },
    "data timestamp": { dataTimestamps: { ...base.dataTimestamps, osv: "2026-11-02T00:00:00.000Z" } },
    "services selection": { services: ["db"] },
  };
  const hashes = new Map([["reference", reference.planHash]]);
  for (const [what, change] of Object.entries(variants)) {
    const changed = a.plan({ container: { ...base, ...change } });
    assert.notEqual(changed.planHash, reference.planHash, `changing the ${what} changes the plan hash`);
    hashes.set(what, changed.planHash);
  }
  // The image digest of the engine.
  const b = await planProject(fakeEngine({ FAKE_DOCKER_IMAGE_ID: "sha256:" + "2".repeat(64) }));
  const otherImage = b.plan({ container: base });
  assert.equal(otherImage.inputs.container.toolsImage, "sha256:" + "2".repeat(64));
  assert.notEqual(otherImage.planHash, reference.planHash, "changing the tools image digest changes the plan hash");
  assert.equal(new Set([...hashes.values(), otherImage.planHash]).size, 6, "every variant has its own hash");

  // The results: provenance holds each value and the identity of the analysis follows the plan.
  const run = (ctx, plan) =>
    executeRun({
      workspacePath: ctx.project,
      home: ctx.home,
      version: VERSION,
      adapter: "quality-bridge",
      options: { planHash: plan.planHash, planSource: "built", profile: "minimal", scope: "full" },
      plan,
      steps: (context) => planSteps(context, plan),
      disabled: planDisabled(plan),
      env: ctx.env,
      cache: false,
    });
  const first = await run(a, reference);
  assert.equal(first.decision, "passed", JSON.stringify(first.stages.map((s) => [s.id, s.state, s.reason])));
  assert.deepEqual(first.provenance.container, reference.inputs.container, "the provenance records the container inputs value by value");
  assert.equal(first.provenance.hashes.plan, reference.planHash);
  const changedPlan = a.plan({ container: { ...base, dependencyKeys: { ...base.dependencyKeys, api: "key-1-changed" } } });
  const second = await run(a, changedPlan);
  assert.equal(second.provenance.container.dependencyKeys.api, "key-1-changed");
  assert.notEqual(second.provenance.hashes.plan, first.provenance.hashes.plan);
  assert.notEqual(second.provenance.hashes.tools, first.provenance.hashes.tools, "the tools hash follows the container inputs");
  assert.notEqual(second.provenance.identity, first.provenance.identity, "a different input is a different analysis identity");
  const written = JSON.parse(fs.readFileSync(path.join(first.runDir, "result.json"), "utf8"));
  assert.deepEqual(written.provenance.container, reference.inputs.container);
});

test("a plan made inside the tools image (in-image mode) has no container inputs, so its hash is not tied to an engine", async () => {
  const engine = fakeEngine();
  const ctx = await planProject(engine);
  const plain = ctx.plan({ env: { ...ctx.env, JGATES_IMAGE_JSON: IN_IMAGE_JSON } });
  assert.equal(plain.inputs.container, undefined);
});

test("cancelRunInEngine takes down only the registered, labelled projects and kills only the run's label", async () => {
  const { cancelRunInEngine, registerRunServices, runServices } = await load("core", "runner", "index.js");
  const engine = fakeEngine();
  fs.writeFileSync(
    path.join(engine.dir, "objects.json"),
    JSON.stringify({
      containers: [
        { id: "111111111111", name: "mine-1", state: "running", labels: { "org.jgates.managed": "true", "org.jgates.run": "run_c1" } },
        { id: "222222222222", name: "mine-2", state: "running", labels: { "org.jgates.managed": "true", "org.jgates.run": "run_c1" } },
        { id: "333333333333", name: "other", state: "running", labels: { "org.jgates.managed": "true", "org.jgates.run": "run_c2" } },
        { id: "444444444444", name: "foreign", state: "running", labels: { "org.jgates.run": "run_c1" } },
      ],
      volumes: [],
      networks: [],
      images: [],
    }),
  );
  const labels = { "org.jgates.managed": "true", "org.jgates.kind": "services", "org.jgates.run": "run_c1" };
  registerRunServices("run_c1", { project: "jgates-ws-services", files: ["compose.yml"], labels });
  registerRunServices("run_c1", { project: "jgates-ws-services", files: ["compose.yml"], labels });
  assert.equal(runServices("run_c1").length, 1, "registering twice keeps one entry");
  registerRunServices("run_c1", { project: "jgates-ws-bad", files: ["compose.yml"], labels: { "org.jgates.run": "run_c1" } });
  const result = await cancelRunInEngine({ runId: "run_c1", context: { runtime: engine.runtime } });
  assert.deepEqual(result.killed.map((c) => c.name).sort(), ["mine-1", "mine-2"]);
  assert.deepEqual(result.servicesDown, ["jgates-ws-services"]);
  assert.equal(result.errors.length, 1, "a project without the JGates label is refused");
  assert.match(result.errors[0], /jgates-ws-bad/);
  const objects = JSON.parse(fs.readFileSync(path.join(engine.dir, "objects.json"), "utf8"));
  assert.deepEqual(objects.containers.map((c) => [c.name, c.state]).sort(), [["foreign", "running"], ["other", "running"]]);
  const down = engine.recorded().filter((c) => c[0] === "compose");
  assert.equal(down.length, 1);
  assert.equal(runServices("run_c1").length, 0, "the registry is cleared");
});
