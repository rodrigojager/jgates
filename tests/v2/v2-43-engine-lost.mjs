import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-43 (fake engine): the engine disappears in the middle of a run (Docker Desktop quit). A run of three steps goes
// through `jgates run` with the fake engine; while the container of gen-b runs, the fake engine stops answering for good
// and its client dies with a connection error. The result must say the step is incomplete because of ENGINE_LOST:
//   - gen-a (before) keeps its completed stage; gen-b's stage is an error carrying the reason code ENGINE_LOST and the
//     catalogue text (the raw engine text is not the main text); gen-c is not run, blocked with the same reason code, and
//     no container is started for it;
//   - the decision is incomplete (exit 2), never passed and never failed, with no blocking violation counted.

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

test("V2-43: an engine that vanishes mid-step ends the step incomplete with ENGINE_LOST and the run never passes", () => {
  const project = tmp("v2-43-project-");
  const home = tmp("v2-43-home-");
  const engine = tmp("v2-43-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    [
      `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};`,
      `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};`,
      `process.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};`,
      'process.env.FAKE_DOCKER_STEP_MODE = "vanish";',
      'process.env.FAKE_DOCKER_STEP_NAME = "gen-b";',
      `require(${JSON.stringify(FAKE)});`,
      "",
    ].join("\n"),
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 240_000 });

  fs.writeFileSync(path.join(project, "check.js"), "process.exit(0);\n");
  fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
  const tools = ["gen-a", "gen-b", "gen-c"];
  for (const tool of tools) fs.writeFileSync(path.join(project, ".jgates", "templates", `${tool}.yml`), template(tool));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  fs.appendFileSync(path.join(project, "jgates.yml"), tools.map((tool) => `  - id: ${tool}\n    source: .jgates/templates/${tool}.yml\n    activation: always\n`).join(""));
  spawnSync("git", ["add", "-A"], { cwd: project });
  fs.rmSync(calls, { force: true });

  const run = cli(["run", "--cwd", project, "--no-interactive", "--json", ...tools.flatMap((t) => ["--only", `tool:${t}`])]);
  const doc = JSON.parse(run.stdout);
  const stagesOf = (tool) => doc.stages.filter((s) => s.execution?.step === tool);

  // The decision: incomplete, never passed, never failed, nothing counted as a violation.
  assert.equal(doc.decision, "incomplete", JSON.stringify(doc.stages.map((s) => [s.id, s.state, s.reason])));
  assert.equal(run.status, 2);
  assert.notEqual(doc.decision, "passed");
  assert.equal(doc.complete, false);
  assert.equal(doc.blockingViolations, 0);

  // The steps: before, during and after the loss.
  assert.deepEqual(stagesOf("gen-a").map((s) => s.state), ["completed"]);
  const lost = stagesOf("gen-b");
  assert.equal(lost.length, 1);
  assert.equal(lost[0].state, "error");
  assert.equal(lost[0].execution.reasonCode, "ENGINE_LOST");
  assert.match(lost[0].reason, /Docker stopped during the run; this check is incomplete/);
  assert.doesNotMatch(lost[0].reason, /error during connect|EOF/, "the raw engine text is not the main text");
  const after = doc.stages.filter((s) => !stagesOf("gen-a").includes(s) && !lost.includes(s));
  assert.ok(after.length > 0, "the step after the loss is recorded");
  for (const stage of after) {
    assert.equal(stage.state, "blocked", `${stage.id}: ${stage.state}`);
    assert.equal(stage.execution.notRun.problems[0].code, "ENGINE_LOST");
  }
  assert.ok(doc.unsatisfied.length > 0, "the requirements that were not proven are listed");

  // No container was started for the step after the loss, and the engine answered nothing after it vanished.
  const dockerCalls = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const stepNames = dockerCalls.filter((c) => c[0] === "run" && c.includes("org.jgates.kind=step")).map((c) => c[c.indexOf("--name") + 1]);
  assert.deepEqual(stepNames, [`jgates-${doc.runId}-gen-a`, `jgates-${doc.runId}-gen-b`], "gen-c never got a container");
  assert.ok(fs.existsSync(path.join(engine, "daemon.lost")), "the fake engine did vanish");

  // The result on disk says the same.
  const onDisk = JSON.parse(fs.readFileSync(path.join(doc.runDir, "result.json"), "utf8"));
  assert.equal(onDisk.decision, "incomplete");
  assert.equal(onDisk.partial, undefined);
});
