import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-41 (fake engine): the network of a step is decided by the plan, not by the tool. Two generic checks, one that
// declares `usesNetwork: false` and one that declares `usesNetwork: true`, are planned and run. `jgates plan --json` lists
// the network kind and the reason of each item; the run starts the offline step with `--network none` and only the
// declaring one with a network (`bridge`), as recorded by the fake engine.

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

function template(tool, network) {
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
    `        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: ${network} }`,
    "        evidence: { kind: exit-code }",
    "",
  ].join("\n");
}

test("V2-41: offline steps run with --network none, only the item that declares network gets one, and plan --json lists it", () => {
  const project = tmp("v2-41-project-");
  const home = tmp("v2-41-home-");
  const engine = tmp("v2-41-engine-");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1" };
  const cli = (args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 240_000 });

  fs.writeFileSync(path.join(project, "check.js"), "process.exit(0);\n");
  fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
  const tools = [
    ["net-off", false],
    ["net-on", true],
  ];
  for (const [tool, network] of tools) fs.writeFileSync(path.join(project, ".jgates", "templates", `${tool}.yml`), template(tool, network));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  fs.appendFileSync(path.join(project, "jgates.yml"), tools.map(([tool]) => `  - id: ${tool}\n    source: .jgates/templates/${tool}.yml\n    activation: always\n`).join(""));
  spawnSync("git", ["add", "-A"], { cwd: project });
  const only = ["--only", "tool:net-off", "--only", "tool:net-on"];

  // 1. The plan lists the network kind and the reason of every item.
  const planned = JSON.parse(cli(["plan", "--cwd", project, "--json", ...only]).stdout);
  const items = [...planned.plan.groups.willRun];
  const off = items.find((i) => i.tool === "net-off");
  const on = items.find((i) => i.tool === "net-on");
  assert.ok(off && on, JSON.stringify(items.map((i) => i.id)));
  assert.equal(off.networkKind, "none");
  assert.equal(on.networkKind, "bridge");
  assert.match(off.networkReason, /no network declared/i);
  assert.match(on.networkReason, /usesNetwork/);
  assert.notEqual(off.networkReason, on.networkReason);
  for (const item of items) assert.ok(item.networkKind === (item.network ? "bridge" : "none"), `${item.id}: kind follows the declaration`);

  // 2. The run gives a network to the declaring step only.
  fs.rmSync(calls, { force: true });
  const run = cli(["run", "--cwd", project, "--no-interactive", "--json", ...only]);
  const doc = JSON.parse(run.stdout);
  for (const stage of doc.stages) assert.equal(stage.state, "completed", `${stage.id}: ${stage.state} ${stage.reason ?? ""}`);
  const dockerCalls = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const stepRuns = dockerCalls.filter((c) => c[0] === "run" && c.includes("org.jgates.kind=step"));
  const networkOf = (tool) => {
    const call = stepRuns.find((c) => c[c.indexOf("--name") + 1] === `jgates-${doc.runId}-${tool}`);
    assert.ok(call, `a step container for ${tool}: ${JSON.stringify(stepRuns.map((c) => c[c.indexOf("--name") + 1]))}`);
    return call[call.indexOf("--network") + 1];
  };
  assert.equal(networkOf("net-off"), "none");
  assert.equal(networkOf("net-on"), "bridge");
  assert.equal(stepRuns.filter((c) => c[c.indexOf("--network") + 1] !== "none").length, 1, "only one step has a network");
});
