import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakeHostDiskEnv } from "../../jgates/tests/setup/fake-host-disk.mjs";

// V2-108 (fake engine): steps in parallel (ADR-0023, PLAN-engine.md section 11).
//   1. With a concurrency of 4, four read-only steps overlap in time and a step that executes project code runs with
//      nothing beside it; the result (findings, order of the steps, decision) is identical to a run with 1.
//   2. Cancelling ends every running step and the run settles as cancelled.
//   3. The automatic default is the number computed from the engine's memory and CPUs (15.5 GB and 16 CPUs with steps
//      of 4 GB and 2 CPUs: 3), a number written in the configuration wins, and `jgates status` shows both.
// The steps of 1 and 2 are fakes driven through a real run (events.jsonl and result.json); the engine of 3 is
// tests/docker/fake-docker.cjs.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const MAIN = path.join(dist, "cli", "main.js");
const FAKE = path.join(root, "jgates", "tests", "docker", "fake-docker.cjs");
const run = await import(pathToFileURL(path.join(dist, "core", "run", "index.js")).href);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const made = [];
const tmp = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const finding = (stageId, ruleId, file, line) => ({
  stageId,
  tool: stageId.split("#")[0],
  ruleId,
  severity: "error",
  normalizedSeverity: "high",
  message: `${ruleId} in ${file}`,
  location: { path: file, line },
  blocking: true,
  waived: false,
});

/** A fake step: completed after `ms`, with its findings; `readOnly` marks a check that only reads the project. */
function fakeStep(id, { readOnly, ms, findings = [] }) {
  const stageId = `${id}#lint`;
  const out = (state, extra = {}) => ({
    stages: [{ id: stageId, state, ...extra }],
    requirements: [{ id: stageId, required: true }],
    disabled: [],
    findings: state === "completed" ? findings.map(([rule, file, line]) => finding(stageId, rule, file, line)) : [],
    logs: [],
    outputs: [],
  });
  return {
    id,
    ...(readOnly ? { readOnly: true } : {}),
    skeleton: () => out("pending"),
    run: async () => {
      await sleep(ms);
      return out("completed", { interpreted: true, blockingViolations: findings.length });
    },
  };
}

const plan = () => [
  fakeStep("ruff", { readOnly: true, ms: 300, findings: [["E501", "app.py", 3]] }),
  fakeStep("hadolint", { readOnly: true, ms: 120, findings: [["DL3008", "Dockerfile", 2]] }),
  fakeStep("gitleaks", { readOnly: true, ms: 200 }),
  fakeStep("yamllint", { readOnly: true, ms: 60, findings: [["truthy", "ci.yml", 1], ["indentation", "ci.yml", 4]] }),
  fakeStep("pytest", { readOnly: false, ms: 150 }),
  fakeStep("markdownlint", { readOnly: true, ms: 40, findings: [["MD013", "README.md", 9]] }),
];

function workspace(prefix) {
  const ws = tmp(`${prefix}-ws-`);
  fs.writeFileSync(path.join(ws, "app.py"), "print('x')\n");
  return { ws, home: tmp(`${prefix}-home-`) };
}

async function runWith(concurrency, prefix, extra = {}) {
  const { ws, home } = workspace(prefix);
  const result = await run.executeRun({ workspacePath: ws, home, version: "0.0.0-test", adapter: "fake", options: {}, steps: () => plan(), concurrency, env: { ...process.env, JGATES_NO_CACHE: "1" }, ...extra });
  const events = fs.readFileSync(path.join(result.runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { result, events, written: readJson(path.join(result.runDir, "result.json")) };
}

/** Start and end (ms) of each step, from the events of the run. */
function spans(events) {
  const out = new Map();
  for (const e of events) {
    if (e.type === "step-started") out.set(e.data.step, { start: Date.parse(e.at), end: Infinity, readOnly: e.data.readOnly });
    if (e.type === "step-finished") out.get(e.data.step).end = Date.parse(e.at);
  }
  return out;
}

const verdict = (r) => ({
  decision: r.decision,
  exitCode: r.exitCode,
  complete: r.complete,
  stages: r.stages.map((s) => ({ id: s.id, state: s.state, blocking: s.blockingViolations ?? null })),
  findings: r.findings.map((f) => ({ stageId: f.stageId, ruleId: f.ruleId, path: f.location?.path ?? null, line: f.location?.line ?? null, blocking: f.blocking })),
});

test("V2-108: with 4 at a time the read-only steps overlap, the step that runs project code is alone, and the result equals a run with 1", { timeout: 120_000 }, async () => {
  const four = await runWith(4, "v2-108-four");
  const one = await runWith(1, "v2-108-one");

  const s4 = spans(four.events);
  const readOnly = ["ruff", "hadolint", "gitleaks", "yamllint"];
  // The four read-only steps before pytest were all running at one instant (the last start is before the first end).
  const lastStart = Math.max(...readOnly.map((id) => s4.get(id).start));
  const firstEnd = Math.min(...readOnly.map((id) => s4.get(id).end));
  assert.ok(lastStart <= firstEnd, `the four read-only steps did not overlap: ${JSON.stringify([...s4])}`);
  const alone = s4.get("pytest");
  assert.equal(alone.readOnly, false);
  for (const [id, span] of s4) if (id !== "pytest") assert.ok(span.end <= alone.start || span.start >= alone.end, `${id} ran beside pytest`);
  const started = four.events.filter((e) => e.type === "step-started");
  assert.equal(started.find((e) => e.data.step === "pytest").data.running, 1);
  assert.ok(started.every((e) => e.data.concurrency === 4));

  // With one at a time nothing overlaps.
  const s1 = [...spans(one.events).values()].sort((a, b) => a.start - b.start);
  for (let i = 1; i < s1.length; i += 1) assert.ok(s1[i].start >= s1[i - 1].end, "a run with 1 runs one step at a time");

  // Same findings, same order of steps, same decision.
  assert.deepEqual(verdict(four.written), verdict(one.written));
  assert.deepEqual(four.written.stages.map((s) => s.id), plan().map((s) => `${s.id}#lint`));
  assert.equal(four.written.findings.length, 5);
  assert.equal(four.written.decision, one.written.decision);
});

test("V2-108: cancelling ends every running step and the run settles as cancelled", { timeout: 120_000 }, async () => {
  const { ws, home } = workspace("v2-108-cancel");
  const controller = new AbortController();
  const startedSteps = new Set();
  const steps = () => [
    ...["a", "b", "c", "d"].map((id) => ({
      id,
      readOnly: true,
      skeleton: () => ({ stages: [{ id: `${id}#lint`, state: "pending" }], requirements: [{ id: `${id}#lint`, required: true }], disabled: [], findings: [], logs: [], outputs: [] }),
      // A tool that runs until its process is stopped: a node process through the runner.
      run: async () => {
        const { runSpec } = await import(pathToFileURL(path.join(dist, "core", "runner", "index.js")).href);
        const r = await runSpec({ executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: ws, stdin: null });
        return { stages: [{ id: `${id}#lint`, state: r.exitCode === 0 ? "completed" : "error" }], requirements: [{ id: `${id}#lint`, required: true }], disabled: [], findings: [], logs: [], outputs: [] };
      },
    })),
    fakeStep("pytest", { readOnly: false, ms: 10 }),
  ];
  const result = await run.executeRun({
    workspacePath: ws,
    home,
    version: "0.0.0-test",
    adapter: "fake",
    options: {},
    steps,
    concurrency: 4,
    signal: controller.signal,
    env: { ...process.env, JGATES_NO_CACHE: "1" },
    onEvent: (event) => {
      if (event.type === "process-started") {
        startedSteps.add(event.data.step);
        if (startedSteps.size === 4) setImmediate(() => controller.abort("test"));
      }
    },
  });
  const written = readJson(path.join(result.runDir, "result.json"));
  assert.equal(written.stopped?.cause, "cancelled");
  assert.equal(written.exitCode, 130);
  assert.notEqual(written.partial, true);
  for (const id of ["a", "b", "c", "d"]) {
    const stage = written.stages.find((s) => s.id === `${id}#lint`);
    assert.equal(stage.state, "cancelled", id);
    assert.equal(stage.execution.cancelled, true, `${id}: its process was ended`);
  }
  const pytest = written.stages.find((s) => s.id === "pytest#lint");
  assert.equal(pytest.state, "cancelled");
  assert.equal(pytest.execution.notRun.cause, "cancelled");
});

test("V2-108: the automatic number comes from the engine's memory and CPUs, the configuration wins, and jgates status shows it", { timeout: 240_000 }, () => {
  const project = tmp("v2-108-status-project-");
  const home = tmp("v2-108-status-home-");
  const engine = tmp("v2-108-status-engine-");
  const runtime = path.join(engine, "docker.cjs");
  // The user's machine: 15.5 GB and 16 CPUs.
  fs.writeFileSync(
    runtime,
    `process.env.FAKE_DOCKER_STATE = ${JSON.stringify(engine)};\nprocess.env.FAKE_DOCKER_MEMORY_MB = "15872";\nprocess.env.FAKE_DOCKER_CPUS = "16";\nprocess.env.FAKE_DOCKER_LABELS = "none";\nrequire(${JSON.stringify(FAKE)});\n`,
  );
  const env = { ...process.env, JGATES_HOME: home, JGATES_CONTAINER_RUNTIME: runtime, JGATES_IMAGE_JSON: "", JGATES_NO_CACHE: "1", NO_COLOR: "1" };
  const status = (args, locale = "en") => spawnSync(process.execPath, [MAIN, "status", ...args], { cwd: project, encoding: "utf8", env: fakeHostDiskEnv({ ...env, JGATES_LOCALE: locale }), input: "", timeout: 120_000 });

  const json = status(["--json"]);
  const report = JSON.parse(json.stdout);
  assert.deepEqual(report.concurrency, { value: 3, source: "automatic", automatic: 3, step: { memoryMb: 4096, cpus: 2 } }, json.stderr);
  // What a run of this project would use is the same number.
  assert.equal(run.runConcurrency({ projectDir: project, env }).value, 3);
  assert.match(status([]).stdout, /Checks at a time: 3 \(automatic: 4(\.0)? GB of memory and 2 CPUs per check\)/);
  assert.match(status([], "pt-BR").stdout, /Verificações ao mesmo tempo: 3 \(automático/);

  // A number written in the configuration wins over the automatic one; the automatic one is still shown.
  fs.writeFileSync(path.join(project, "jgates.yml"), "schemaVersion: 2\nexecution:\n  concurrency: 6\n");
  const configured = JSON.parse(status(["--json"]).stdout);
  assert.deepEqual([configured.concurrency.value, configured.concurrency.source, configured.concurrency.automatic], [6, "configuration", 3]);
  assert.equal(run.runConcurrency({ projectDir: project, env }).value, 6);
  assert.match(status([]).stdout, /Checks at a time: 6 \(set in the configuration; automatic would be 3\)/);
});
