import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

// The local runner: fail-closed stages, cancellation of the whole process tree with a partial result and exit 130,
// log limits on disk, dependencies and --fail-fast,
// and the JSONL event stream resumable by cursor. The controlled executable is tests/fixtures/executables/fake-tool.cjs;
// it also answers like Ruff, so the end-to-end tests drive a real `jgates run` through JGATES_RUFF.

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FAKE = path.join(here, "fixtures", "executables", "fake-tool.cjs");
const runner = await import(pathToFileURL(path.join(dist, "core", "runner", "index.js")).href);
const events = await import(pathToFileURL(path.join(dist, "core", "events", "index.js")).href);
const run = await import(pathToFileURL(path.join(dist, "core", "run", "index.js")).href);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateResult = ajv.compile(readJson(path.resolve(here, "..", "schemas", "result", "result.schema.json")));
const validateEvent = ajv.compile(readJson(path.resolve(here, "..", "schemas", "events", "event.schema.json")));

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MiB = 1024 * 1024;

async function waitFor(check, ms, what) {
  const until = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const alive = (pid) => runner.isAlive(pid);
const fake = (mode, extra = {}) => ({ executable: process.execPath, args: [FAKE, "--fake-mode", mode], cwd: os.tmpdir(), ...extra });

function assertValidResult(doc) {
  assert.ok(validateResult(doc), JSON.stringify(validateResult.errors, null, 2));
}

// ---------------------------------------------------------------------------------------------------------------
// A project with Ruff instances answered by the fake tool (one mode per instance, through its config binding).

function project(instances, { timeoutSeconds } = {}) {
  const dir = tmp("jgates-rl-ws-");
  const home = tmp("jgates-rl-home-");
  const bin = tmp("jgates-rl-bin-");
  // The only thing on PATH is node (the fake tool's #!/usr/bin/env node): no scanner of the machine is found.
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.mkdirSync(path.join(dir, "demo"));
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\nname = "demo"\nversion = "0.1.0"\n');
  fs.writeFileSync(path.join(dir, "demo", "__init__.py"), "");
  fs.writeFileSync(path.join(dir, "demo", "mod.py"), "x = 1\n");
  const env = { ...process.env, JGATES_HOME: home, JGATES_RUFF: FAKE, PATH: bin, JGATES_PYTHON: path.join(bin, "no-python") };
  const cliSync = (args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const init = cliSync(["init", "--cwd", dir, "--profile", "minimal", "--no-interactive", "--json"]);
  assert.equal(init.code, 0, init.out + init.err);
  let tools = "schemaVersion: 1\ntools:\n";
  for (const [id, mode] of Object.entries(instances)) {
    fs.writeFileSync(path.join(dir, `${id}.toml`), `# fake-mode: ${mode}\n`);
    tools += `  ${id}:\n    adapter: ruff\n    capabilities: [lint]\n    config: ${id}.toml\n`;
  }
  fs.writeFileSync(path.join(dir, ".jgates", "tools.yml"), tools);
  if (timeoutSeconds !== undefined) fs.appendFileSync(path.join(dir, "jgates.yml"), `execution:\n  timeoutSeconds: ${timeoutSeconds}\n`);
  const only = Object.keys(instances).flatMap((id) => ["--only", `tool:${id}`]);
  const runArgs = (...more) => ["run", "--cwd", dir, ...only, "--no-interactive", "--json", ...more];
  const runSync = (...more) => cliSync(runArgs(...more));
  const runAsync = (...more) => {
    const child = spawn(process.execPath, [MAIN, ...runArgs(...more)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
    const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, out, err })));
    return { child, exited };
  };
  const runDirs = () => {
    const ws = path.join(home, "workspaces");
    if (!fs.existsSync(ws)) return [];
    return fs.readdirSync(ws).flatMap((id) => {
      const runs = path.join(ws, id, "runs");
      return fs.existsSync(runs) ? fs.readdirSync(runs).map((r) => path.join(runs, r)) : [];
    });
  };
  const cleanup = () => {
    for (const d of [dir, home, bin]) fs.rmSync(d, { recursive: true, force: true });
  };
  return { dir, home, env, cliSync, runSync, runAsync, runDirs, cleanup };
}

const stage = (doc, id) => {
  const s = doc.stages.find((x) => x.id === id);
  assert.ok(s, `stage ${id} in ${doc.stages.map((x) => x.id).join(", ")}`);
  return s;
};

// ---------------------------------------------------------------------------------------------------------------
// Missing binary, timeout and malformed output never pass.

test("a required stage with a missing binary, a timeout or malformed JSON output is never passed: the decision is incomplete", async () => {
  const cases = [
    { name: "missing binary", mode: "clean", env: { JGATES_RUFF: path.join(os.tmpdir(), "jgates-no-such-ruff") }, state: "blocked" },
    { name: "timeout", mode: "sleep", timeoutSeconds: 1, state: "timeout" },
    { name: "malformed output", mode: "malformed", state: "error" },
    { name: "abnormal exit code", mode: "exit:2", state: "error" },
  ];
  for (const c of cases) {
    const p = project({ lint: c.mode }, { timeoutSeconds: c.timeoutSeconds });
    try {
      Object.assign(p.env, c.env ?? {});
      const started = Date.now();
      const r = p.runSync();
      assert.ok(r.doc, `${c.name}: ${r.out}${r.err}`);
      assertValidResult(r.doc);
      assert.equal(r.doc.decision, "incomplete", c.name);
      assert.notEqual(r.doc.decision, "passed", c.name);
      assert.equal(r.code, 2, c.name);
      assert.equal(r.doc.complete, false, c.name);
      const s = stage(r.doc, "lint#lint");
      assert.equal(s.state, c.state, `${c.name}: ${s.reason}`);
      assert.ok(s.reason, c.name);
      assert.ok(r.doc.unsatisfied.some((u) => u.requirementId === "lint#lint"), c.name);
      assert.deepEqual(r.doc.findings, [], `${c.name}: no finding is made up`);
      if (c.name === "timeout") {
        assert.equal(s.execution.timedOut, true);
        assert.ok(Date.now() - started < 30_000, "the timeout stops the tool");
      }
    } finally {
      p.cleanup();
    }
  }
});

test("the executor reads an uninterpreted completed stage as an error, never as a pass", () => {
  const out = runner.failClosed({
    stages: [{ id: "x", state: "completed", interpreted: false, reason: "bad json" }],
    requirements: [{ id: "x", required: true }],
    disabled: [],
    findings: [],
    logs: [],
    outputs: [],
  });
  assert.equal(out.stages[0].state, "error");
  assert.match(out.stages[0].reason, /bad json/);
});

// ---------------------------------------------------------------------------------------------------------------
// Cancelling stops the whole tree, keeps the partial report and exits 130.

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`cancelling a run (${signal}) stops every process of the tool's tree, writes result.json and exits 130`, { skip: process.platform === "win32" && "POSIX signals; the Windows tree test is below" }, async () => {
    const pidFile = path.join(tmp("jgates-rl-pids-"), "pids.json");
    const p = project({ lint: `children:${pidFile}` });
    let pids = [];
    try {
      const { child, exited } = p.runAsync();
      pids = await waitFor(() => (fs.existsSync(pidFile) ? readJson(pidFile) : null), 30_000, "the tool's process tree");
      assert.equal(pids.length, 5, "the tool, two children and two grandchildren (one in its own session)");
      for (const pid of pids) assert.ok(alive(pid), `pid ${pid} is up before the cancel`);
      child.kill(signal);
      const done = await Promise.race([exited, sleep(30_000).then(() => null)]);
      assert.ok(done, "the run stops after the cancel");
      assert.equal(done.code, 130, done.out + done.err);
      const doc = JSON.parse(done.out);
      assertValidResult(doc);
      assert.equal(doc.decision, "cancelled");
      assert.equal(doc.exitCode, 130);
      assert.equal(doc.stopped.cause, "cancelled");
      const s = stage(doc, "lint#lint");
      assert.equal(s.state, "cancelled");
      assert.equal(s.execution.cancelled, true);
      // The partial report is on disk, final (not a checkpoint), with the events of the cancellation.
      const onDisk = readJson(path.join(doc.runDir, "result.json"));
      assert.equal(onDisk.decision, "cancelled");
      assert.equal(onDisk.partial, undefined);
      const types = events.readEvents(path.join(doc.runDir, "events.jsonl")).events.map((e) => e.type);
      assert.ok(types.includes("cancel-requested"));
      assert.equal(types[types.length - 1], "run-finished");
      // No pid of the tree is left.
      await waitFor(() => pids.every((pid) => !alive(pid)), 10_000, `the tree to stop: ${pids.filter(alive).join(", ")}`);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // gone
        }
      }
      fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
      p.cleanup();
    }
  });
}

test("a run whose process dies keeps a partial result.json that says incomplete, never passed", { skip: process.platform === "win32" && "SIGKILL of the CLI process" }, async () => {
  const pidFile = path.join(tmp("jgates-rl-pids-"), "pids.json");
  const p = project({ lint: `children:${pidFile}` });
  let pids = [];
  try {
    const { child, exited } = p.runAsync();
    pids = await waitFor(() => (fs.existsSync(pidFile) ? readJson(pidFile) : null), 30_000, "the tool's process tree");
    child.kill("SIGKILL");
    await exited;
    const [runDir] = p.runDirs();
    assert.ok(runDir, "the run folder exists");
    const doc = readJson(path.join(runDir, "result.json"));
    assertValidResult(doc);
    assert.equal(doc.partial, true);
    assert.equal(doc.decision, "incomplete");
    assert.equal(doc.complete, false);
    assert.equal(doc.exitCode, 2);
    const list = events.readEvents(path.join(runDir, "events.jsonl")).events;
    assert.ok(list.some((e) => e.type === "step-started" && e.data.step === "lint"), "the events written before the crash survive");
    assert.ok(!list.some((e) => e.type === "run-finished"));
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
    p.cleanup();
  }
});

test("runSpec: a timeout stops the whole process tree", { skip: process.platform === "win32" && "covered by the Windows tree test" }, async () => {
  const dir = tmp("jgates-rl-timeout-");
  const pidFile = path.join(dir, "pids.json");
  try {
    const started = Date.now();
    const pending = runner.runSpec(fake(`children:${pidFile}`, { timeoutMs: 2000 }), { killGraceMs: 500 });
    const pids = await waitFor(() => (fs.existsSync(pidFile) ? readJson(pidFile) : null), 20_000, "the tree");
    const result = await pending;
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.ok(Date.now() - started < 15_000);
    await waitFor(() => pids.every((pid) => !alive(pid)), 10_000, "the tree to stop");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: cancelling stops the whole process tree (taskkill /T)", { skip: process.platform !== "win32" && "the process tree of Windows (taskkill /T, CIM process table) only exists on Windows" }, async () => {
  const dir = tmp("jgates-rl-win-");
  const pidFile = path.join(dir, "pids.json");
  const controller = new AbortController();
  try {
    const pending = runner.runSpec(fake(`children:${pidFile}`, { signal: controller.signal }));
    const pids = await waitFor(() => (fs.existsSync(pidFile) ? readJson(pidFile) : null), 30_000, "the tree");
    for (const pid of pids) assert.ok(alive(pid));
    controller.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    await waitFor(() => pids.every((pid) => !alive(pid)), 20_000, "the tree to stop");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Log limits: on disk, cut with the marker; memory bounded.

test("output beyond the log limit is cut on disk with the truncation marker and memory stays bounded", async () => {
  const dir = tmp("jgates-rl-logs-");
  const total = 192 * MiB;
  let peak = 0;
  const base = process.memoryUsage().arrayBuffers;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
  }, 10);
  try {
    const stdoutFile = path.join(dir, "tool.stdout.log");
    const stderrFile = path.join(dir, "tool.stderr.log");
    const result = await runner.runSpec(fake(`flood-stdout:${total}`, { stdoutFile, stderrFile }), { maxLogBytes: MiB, maxOutputBytes: MiB });
    clearInterval(sampler);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutBytes, total, "every byte was read from the pipe");
    assert.equal(result.logTruncated, true);
    assert.equal(result.truncated, true, "the in-memory copy says it is not the whole output");
    const size = fs.statSync(stdoutFile).size;
    assert.ok(size >= MiB && size < MiB + 1024, `log size ${size}`);
    const tail = fs.readFileSync(stdoutFile).subarray(MiB).toString("utf8");
    assert.ok(tail.includes(runner.TRUNCATION_MARKER), tail);
    assert.match(tail, new RegExp(`of ${total} bytes`));
    assert.ok(Buffer.byteLength(result.stdout) <= MiB);
    assert.ok(peak < 96 * MiB, `peak external memory ${Math.round(peak / MiB)} MiB for ${total / MiB} MiB of output`);
    // The stderr log keeps the process facts around the (empty) stderr.
    const err = fs.readFileSync(stderrFile, "utf8");
    assert.match(err, /executable: /);
    assert.match(err, /exit code: 0/);
  } finally {
    clearInterval(sampler);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Dependencies and --fail-fast.

function processStep(id, mode, dependsOn = []) {
  const output = (state, reason) => ({
    stages: [{ id: `${id}#check`, kind: "step", adapter: "fake", state, ...(reason ? { reason } : {}) }],
    requirements: [{ id: `${id}#check`, required: true }],
    disabled: [],
    findings: [],
    logs: [],
    outputs: [],
  });
  return {
    id,
    dependsOn,
    skeleton: () => output("pending"),
    run: async () => {
      const r = await runner.runSpec(fake(mode));
      return r.exitCode === 0 ? output("completed", "ok") : output("error", `exit ${r.exitCode}`);
    },
  };
}

test("with a step failing, independent steps still run and dependents are blocked with the reason; --fail-fast records the rest as not run", async () => {
  const steps = () => [processStep("a", "exit:3"), processStep("b", "clean"), processStep("c", "clean", ["a"]), processStep("d", "clean", ["c"])];
  const seen = [];
  const plain = await runner.executeSteps(steps(), { emit: (type, data) => seen.push({ type, data }) });
  const state = (res, id) => res.reports.find((r) => r.step.id === id).output.stages[0];
  assert.equal(state(plain, "a").state, "error");
  assert.equal(state(plain, "b").state, "completed", "an independent step runs after a failure");
  assert.equal(state(plain, "c").state, "blocked");
  assert.match(state(plain, "c").reason, /\ba\b/);
  assert.equal(state(plain, "c").execution.notRun.cause, "dependency");
  assert.deepEqual(state(plain, "c").execution.notRun.steps, ["a"]);
  assert.equal(state(plain, "d").state, "blocked", "a blocked step blocks its own dependents");
  assert.ok(!seen.some((e) => e.type === "step-started" && ["c", "d"].includes(e.data.step)), "a blocked step never starts");

  const fast = await runner.executeSteps(steps(), { failFast: true });
  assert.equal(state(fast, "a").state, "error");
  for (const id of ["b", "c", "d"]) {
    const s = state(fast, id);
    assert.equal(s.state, "blocked", id);
    assert.equal(s.execution.notRun.cause, "fail-fast", id);
    assert.match(s.reason, /--fail-fast/);
  }
  assert.equal(fast.failFast.stepId, "a");

  // The order follows the dependencies, whatever the input order.
  const order = [];
  await runner.executeSteps([processStep("late", "clean", ["early"]), processStep("early", "clean")], { emit: (type, data) => type === "step-started" && order.push(data.step) });
  assert.deepEqual(order, ["early", "late"]);
});

test("--fail-fast through jgates run: the first failing instance stops the run and the rest is recorded as not run", () => {
  const p = project({ "lint-a": "malformed", "lint-b": "clean" });
  try {
    const plain = p.runSync();
    assert.ok(plain.doc, plain.out + plain.err);
    assert.equal(stage(plain.doc, "lint-a#lint").state, "error");
    assert.equal(stage(plain.doc, "lint-b#lint").state, "completed", "without --fail-fast the independent instance runs");
    const order = events.readEvents(path.join(plain.doc.runDir, "events.jsonl")).events.filter((e) => e.type === "step-started").map((e) => e.data.step);
    assert.deepEqual(order, ["lint-a", "lint-b"], "the plan runs lint-a first");

    const fast = p.runSync("--fail-fast");
    assert.ok(fast.doc, fast.out + fast.err);
    assertValidResult(fast.doc);
    assert.equal(fast.code, 2);
    assert.equal(fast.doc.decision, "incomplete");
    assert.equal(stage(fast.doc, "lint-a#lint").state, "error");
    const b = stage(fast.doc, "lint-b#lint");
    assert.equal(b.state, "blocked");
    assert.equal(b.execution.notRun.cause, "fail-fast");
    assert.match(b.reason, /--fail-fast/);
    assert.deepEqual(fast.doc.stopped, { cause: "fail-fast", stepId: "lint-a", detail: fast.doc.stopped.detail });
    assert.equal(fast.doc.selection.options.failFast, true);
  } finally {
    p.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Events.

test("--events-jsonl writes events with runId, a growing sequence and a type; a reader resuming from cursor N gets only what came after N", () => {
  const p = project({ lint: "violations" });
  const outDir = tmp("jgates-rl-events-");
  const file = path.join(outDir, "eventos.jsonl");
  try {
    const r = p.runSync("--events-jsonl", file);
    assert.ok(r.doc, r.out + r.err);
    assert.equal(r.code, 1, "the violations fail the run");
    assert.equal(r.doc.decision, "failed");
    assert.equal(r.doc.artifacts.events, "events.jsonl");
    const all = events.readEvents(file);
    assert.ok(all.events.length >= 6, `events: ${all.events.map((e) => e.type).join(", ")}`);
    all.events.forEach((e, i) => {
      assert.ok(validateEvent(e), JSON.stringify(validateEvent.errors));
      assert.equal(e.runId, r.doc.runId);
      assert.equal(e.sequence, i + 1, "the sequence starts at 1 and grows by one");
    });
    const types = all.events.map((e) => e.type);
    assert.equal(types[0], "run-started");
    assert.equal(types[types.length - 1], "run-finished");
    for (const t of ["step-started", "process-started", "process-finished", "stage", "step-finished"]) assert.ok(types.includes(t), t);
    assert.deepEqual(all.events.at(-1).data.decision, "failed");
    assert.equal(all.cursor, all.events.length);
    // The run folder has the same stream.
    assert.deepEqual(events.readEvents(path.join(r.doc.runDir, "events.jsonl")).events, all.events);

    const n = 3;
    const resumed = events.readEvents(file, { after: n });
    assert.deepEqual(resumed.events, all.events.slice(n));
    assert.ok(resumed.events.every((e) => e.sequence > n));
    assert.deepEqual(events.readEvents(file, { after: all.cursor }).events, [], "nothing after the last cursor");

    // A line still being written is left for the next read: no half event.
    const text = fs.readFileSync(file, "utf8");
    const half = events.parseEvents(`${text}{"schemaVersion":1,"runId":"${r.doc.runId}","seq`, n);
    assert.deepEqual(half.events, all.events.slice(n));
    assert.equal(half.invalidLines, 0);

    // A folder that does not exist is a usage error, before any run.
    const bad = p.runSync("--events-jsonl", path.join(outDir, "no", "such", "dir", "e.jsonl"));
    assert.equal(bad.code, 3);
    assert.equal(bad.doc.error.code, "BAD_EVENTS_PATH");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
    p.cleanup();
  }
});

test("EventLog: every event is on disk when emit returns, in every file", () => {
  const dir = tmp("jgates-rl-eventlog-");
  try {
    const a = path.join(dir, "a.jsonl");
    const b = path.join(dir, "b.jsonl");
    const log = new events.EventLog({ runId: "run_20261025T000000Z_0000abcd", files: [a, b] });
    log.emit("run-started", {});
    assert.equal(events.readEvents(a).events.length, 1);
    log.emit("stage", { step: "s", stageId: "s#x", state: "completed" });
    assert.equal(log.cursor, 2);
    log.close();
    assert.deepEqual(events.readEvents(a).events, events.readEvents(b).events);
    assert.equal(events.readEvents(path.join(dir, "missing.jsonl")).events.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Preflight.

test("preflight blocks a step whose binary, configuration or working directory is gone, and the run records why", async () => {
  const dir = tmp("jgates-rl-pre-");
  try {
    const problems = runner.preflight({
      executable: path.join(dir, "nope"),
      configFiles: [path.join(dir, "missing.toml")],
      cwd: path.join(dir, "gone"),
      runtime: { name: "python", interpreter: null },
      version: { expected: "1.0.0", read: () => "1.0.0" },
    });
    assert.deepEqual(problems.map((x) => x.code).sort(), ["BINARY_NOT_FOUND", "CONFIG_MISSING", "CWD_MISSING", "RUNTIME_MISSING"]);
    const mismatch = runner.preflight({ executable: process.execPath, version: { expected: "1.0.0", read: () => "2.0.0" } });
    assert.deepEqual(mismatch.map((x) => x.code), ["VERSION_MISMATCH"]);
    assert.deepEqual(runner.preflight({ executable: process.execPath, cwd: dir, outputDirs: [path.join(dir, "out", "x")] }), []);
    assert.ok(fs.statSync(path.join(dir, "out", "x")).isDirectory());

    const ws = tmp("jgates-rl-pre-ws-");
    const home = tmp("jgates-rl-pre-home-");
    try {
      let ran = false;
      const result = await run.executeRun({
        workspacePath: ws,
        home,
        version: "0.0.0-test",
        adapter: "fake",
        options: {},
        steps: () => [
          {
            id: "tool",
            preflight: () => runner.preflight({ executable: path.join(dir, "nope") }),
            skeleton: () => ({ stages: [{ id: "tool#lint", state: "pending" }], requirements: [{ id: "tool#lint", required: true }], disabled: [], findings: [], logs: [], outputs: [] }),
            run: async () => {
              ran = true;
              throw new Error("must not run");
            },
          },
        ],
      });
      assert.equal(ran, false);
      assertValidResult(result);
      assert.equal(result.decision, "incomplete");
      assert.equal(result.stages[0].state, "blocked");
      assert.equal(result.stages[0].execution.notRun.cause, "preflight");
      assert.equal(result.stages[0].execution.notRun.problems[0].code, "BINARY_NOT_FOUND");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
