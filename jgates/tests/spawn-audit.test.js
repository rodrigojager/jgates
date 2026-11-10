import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Spawn audit (V2-35, in process): `child_process` is wrapped before the runner is loaded, then a plan of steps runs
// through executeSteps with the step launcher on the fake engine. Every process the runner starts is recorded: with the
// launcher only the engine CLI shows up (never the tool the adapter named), and the control run without the launcher
// shows the host process, so the audit would notice one.

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "docker", "fake-docker.cjs");
const started = [];
for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
  const original = cp[fn];
  cp[fn] = function (file, args, ...rest) {
    started.push({ fn, file: String(file), args: Array.isArray(args) ? args.map(String) : [] });
    return original.call(this, file, args, ...rest);
  };
}
module.syncBuiltinESMExports();
const runner = await import(pathToFileURL(path.resolve(here, "..", "dist", "core", "runner", "index.js")).href);

const FAKE_ENV = ["FAKE_DOCKER_LOG", "FAKE_DOCKER_STATE", "FAKE_DOCKER_LABELS"];
const isEngine = (s) => s.file === FAKE || s.args[0] === FAKE;

const step = (id, executable, args, cwd) => ({
  id,
  skeleton: () => ({ stages: [{ id, state: "pending" }], requirements: [{ id, required: true }], disabled: [], findings: [], logs: [], outputs: [] }),
  run: async () => {
    const result = await runner.runSpec({ executable, args, cwd }, { envAllowlist: [...runner.DEFAULT_ENV_ALLOWLIST, ...FAKE_ENV] });
    return {
      stages: [{ id, state: result.exitCode === 0 ? "completed" : "error", reason: result.spawnError?.message, blockingViolations: 0, interpreted: true }],
      requirements: [{ id, required: true }],
      disabled: [],
      findings: [],
      logs: [],
      outputs: [],
    };
  },
});

test("with the launcher no tool runs as a host process: only the engine CLI is spawned, one docker run per step", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-spawn-audit-"));
  const workspace = path.join(dir, "ws");
  const runDir = path.join(dir, "run");
  fs.mkdirSync(workspace);
  fs.mkdirSync(runDir);
  const log = path.join(dir, "calls.jsonl");
  const saved = Object.fromEntries(FAKE_ENV.map((k) => [k, process.env[k]]));
  process.env.FAKE_DOCKER_LOG = log;
  process.env.FAKE_DOCKER_STATE = dir;
  process.env.FAKE_DOCKER_LABELS = JSON.stringify({ "org.jgates.version": "1.2.3" });
  try {
    const env = { ...process.env, JGATES_TOOLS_IMAGE: "jgates-tools:dev", JGATES_IMAGE_JSON: path.join(dir, "absent.json") };
    const launcher = runner.createStepLauncher({ env, workspaceId: "ws_0123456789abcdef", runId: "r1", runDir, projectDir: workspace, version: "1.2.3", engine: { runtime: FAKE, runnerOptions: { parentEnv: env, envAllowlist: [...runner.DEFAULT_ENV_ALLOWLIST, ...FAKE_ENV] } } });
    started.length = 0;
    const steps = [step("ruff", "ruff", ["check", "."], workspace), step("pytest", "python", ["-m", "pytest"], workspace), step("semgrep", "semgrep", ["--json", workspace], workspace)];
    const executed = await runner.executeSteps(steps, { launcher });
    assert.deepEqual(executed.reports.map((r) => r.status), ["succeeded", "succeeded", "succeeded"]);
    assert.ok(started.length > 0);
    assert.deepEqual(started.filter((s) => !isEngine(s)), [], "a process other than the engine CLI was spawned");
    const runs = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c[0] === "run");
    assert.equal(runs.length, 3);
    assert.deepEqual(runs.map((c) => c[c.indexOf("--name") + 1]), ["jgates-r1-ruff", "jgates-r1-pytest", "jgates-r1-semgrep"]);

    // Control: without the launcher the same call is a host process, and the audit sees it.
    started.length = 0;
    const host = await runner.executeSteps([step("host", process.execPath, ["-e", "0"], workspace)], {});
    assert.equal(host.reports[0].status, "succeeded");
    assert.ok(started.some((s) => s.file === process.execPath && !isEngine(s)), "the audit sees a host process");
  } finally {
    for (const k of FAKE_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
