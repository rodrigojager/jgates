import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// V2-35 (fake engine): every step of a plan runs in a container and no tool runs as a host process. A project with
// three generic-command checks (and the built-in ones of the minimal profile) is run end to end with `JGATES_TOOLS_IMAGE`
// set (container-first). A preload module wraps every function of child_process (spawn, spawnSync, exec*, fork) in the
// CLI process and logs what was started. The log must hold the engine CLI (the fake docker) and git (discovery and the
// git state of the project) and nothing else; and each step of the plan is exactly one `docker run --pull never` of
// the tools image with the contract flags: read-only root, tmpfs, no capabilities, no new privileges, a pids limit,
// the source volume at /workspace, the run folder at /output, labels, and `--network none` because no item declares network.

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

const PRELOAD = `
const cp = require("node:child_process");
const fs = require("node:fs");
const log = process.env.JGATES_SPAWN_AUDIT_LOG;
const record = (fn, file, args) => fs.appendFileSync(log, JSON.stringify({ fn, file: String(file), args: Array.isArray(args) ? args.map(String) : [] }) + "\\n");
for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
  const original = cp[fn];
  cp[fn] = function (file, args, ...rest) {
    record(fn, file, Array.isArray(args) ? args : []);
    return original.call(this, file, args, ...rest);
  };
}
for (const fn of ["exec", "execSync"]) {
  const original = cp[fn];
  cp[fn] = function (command, ...rest) {
    record(fn, command, []);
    return original.call(this, command, ...rest);
  };
}
`;

function template(tool, extra = []) {
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
    ...extra,
    "",
  ].join("\n");
}

test("V2-35: a multi-step run spawns only the engine CLI and git, and each step is one docker run with the step contract", () => {
  const project = tmp("v2-35-project-");
  const home = tmp("v2-35-home-");
  const engine = tmp("v2-35-engine-");
  const audit = path.join(engine, "spawn-audit.jsonl");
  const calls = path.join(engine, "calls.jsonl");
  const runtime = path.join(engine, "docker.cjs");
  const preload = path.join(engine, "preload.cjs");
  fs.writeFileSync(preload, PRELOAD);
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_LOG = ${JSON.stringify(calls)};\nprocess.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_LABELS = ${JSON.stringify(JSON.stringify({ "org.jgates.version": CLI_VERSION }))};\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_NO_CACHE: "1", JGATES_LOCALE: "en", NO_COLOR: "1", JGATES_SPAWN_AUDIT_LOG: audit };
  const cli = (args) => spawnSync(process.execPath, ["--require", preload, MAIN, ...args], { cwd: project, encoding: "utf8", env, input: "", timeout: 240_000 });

  fs.writeFileSync(path.join(project, "check.js"), "process.exit(0);\n");
  fs.writeFileSync(path.join(project, "app.py"), "def add(a, b):\n    return a + b\n");
  fs.mkdirSync(path.join(project, ".jgates", "templates"), { recursive: true });
  const tools = ["gen-a", "gen-b", "gen-c"];
  for (const tool of tools) fs.writeFileSync(path.join(project, ".jgates", "templates", `${tool}.yml`), template(tool));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: project }).status, 0);
  assert.equal(cli(["init", "--cwd", project, "--profile", "minimal", "--no-interactive", "--json"]).status, 0);
  fs.appendFileSync(path.join(project, "jgates.yml"), tools.map((tool) => `  - id: ${tool}\n    source: .jgates/templates/${tool}.yml\n    activation: always\n`).join(""));
  spawnSync("git", ["add", "-A"], { cwd: project });
  fs.rmSync(audit, { force: true });
  fs.rmSync(calls, { force: true });

  const run = cli(["run", "--cwd", project, "--no-interactive", "--json", "--only", "tool:gen-a", "--only", "tool:gen-b", "--only", "tool:gen-c"]);
  const doc = JSON.parse(run.stdout);
  const stepIds = doc.stages.map((s) => s.execution?.step).filter(Boolean);
  for (const tool of tools) assert.ok(stepIds.includes(tool), `step ${tool} ran: ${JSON.stringify(doc.stages.map((s) => [s.id, s.state, s.reason]))}`);
  for (const stage of doc.stages) assert.equal(stage.state, "completed", `${stage.id}: ${stage.state} ${stage.reason ?? ""}`);

  // 1. The spawn audit: the engine CLI and git, nothing else.
  const spawned = fs.readFileSync(audit, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const engineCalls = spawned.filter((s) => s.args[0] === runtime);
  const gitCalls = spawned.filter((s) => path.basename(s.file).replace(/\.exe$/i, "") === "git");
  const others = spawned.filter((s) => !engineCalls.includes(s) && !gitCalls.includes(s));
  assert.ok(engineCalls.length > 0, "the engine CLI was spawned");
  assert.deepEqual(others, [], `host processes other than the engine CLI and git: ${JSON.stringify(others)}`);

  // 2. One `docker run --pull never` per step, with the contract.
  const dockerCalls = fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const stepRuns = dockerCalls.filter((c) => c[0] === "run" && c.includes("org.jgates.kind=step"));
  assert.equal(stepRuns.length, tools.length, `one docker run per step: ${JSON.stringify(stepRuns.map((c) => c[c.indexOf("--name") + 1]))}`);
  const flag = (c, name) => c[c.indexOf(name) + 1];
  const names = stepRuns.map((c) => flag(c, "--name")).sort();
  assert.deepEqual(names, tools.map((t) => `jgates-${doc.runId}-${t}`).sort());
  for (const c of stepRuns) {
    assert.equal(flag(c, "--pull"), "never");
    for (const f of ["--rm", "--init", "--read-only"]) assert.ok(c.includes(f), `${f} in ${c.join(" ")}`);
    assert.equal(flag(c, "--network"), "none");
    assert.equal(flag(c, "--cap-drop"), "ALL");
    assert.equal(flag(c, "--security-opt"), "no-new-privileges");
    assert.ok(Number(flag(c, "--pids-limit")) > 0);
    assert.equal(flag(c, "--memory"), "4096m");
    assert.equal(flag(c, "--cpus"), "2");
    assert.match(flag(c, "--tmpfs"), /^\/tmp:/);
    assert.ok(c.includes(`org.jgates.workspace=${doc.workspace.id}`));
    assert.ok(c.includes(`org.jgates.run=${doc.runId}`));
    assert.ok(c.includes("org.jgates.managed=true"));
    const mounts = c.filter((a, i) => c[i - 1] === "--mount");
    assert.ok(mounts.some((m) => m === `type=volume,src=jgates-${doc.workspace.id}-src,dst=/workspace`), mounts.join(" | "));
    assert.ok(mounts.some((m) => m.startsWith("type=bind,") && m.endsWith(",dst=/output")), mounts.join(" | "));
    assert.ok(!mounts.some((m) => m.includes(project)), `the project was mounted: ${mounts.join(" | ")}`);
    assert.ok(c.includes("/workspace/check.js"), "the host workspace path became /workspace");
    assert.ok(!c.some((a) => a.includes(project)), "no host project path reached the container");
    assert.equal(flag(c, "--user"), process.platform === "linux" && process.getuid() > 0 ? `${process.getuid()}:${process.getgid()}` : "10001:10001");
  }
});
