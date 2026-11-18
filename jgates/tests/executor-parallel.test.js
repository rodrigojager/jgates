import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

// Steps in parallel (ADR-0023, PLAN-engine.md section 11). The executor runs the steps that only read the project beside
// each other, up to the number of checks at a time, and every other step alone; the result is the same for 1 and 4;
// cancelling stops every running step; a step container ended at its memory limit is incomplete with that reason. The
// engine is a fake: the steps are timed promises or node processes, and the launcher plays the engine client.

process.env.JGATES_LOCALE = "en";
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const runner = await import(pathToFileURL(path.join(dist, "core", "runner", "index.js")).href);
const { builtinManifests } = await import(pathToFileURL(path.join(dist, "adapters", "manifests.js")).href);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const output = (id, state, findings = []) => ({
  stages: [{ id, state, ...(state === "completed" ? { interpreted: true, blockingViolations: findings.length } : { reason: state }) }],
  requirements: [{ id, required: true }],
  disabled: [],
  findings,
  logs: [],
  outputs: [],
});

/** A fake engine that records which steps run at the same time. */
function clock() {
  const active = new Set();
  const spans = new Map();
  let max = 0;
  const step = (id, { readOnly = false, ms = 120, state = "completed", findings = [], dependsOn } = {}) => ({
    id,
    ...(readOnly ? { readOnly: true } : {}),
    ...(dependsOn ? { dependsOn } : {}),
    skeleton: () => output(id, "pending"),
    run: async () => {
      active.add(id);
      max = Math.max(max, active.size);
      const span = { start: performance.now(), end: 0, beside: new Set(active) };
      spans.set(id, span);
      // Every step that starts while this one runs is beside it too.
      for (const other of active) spans.get(other)?.beside.add(id);
      await sleep(ms);
      active.delete(id);
      span.end = performance.now();
      return output(id, state, findings.map((f) => ({ ...f, stageId: id })));
    },
  });
  return { step, spans, max: () => max };
}

/** What the result says about a run, without times: step order, status, stages and findings. */
const shape = (result) =>
  result.reports.map((r) => ({
    step: r.step.id,
    status: r.status,
    cause: r.cause ?? null,
    stages: r.output.stages.map((s) => ({ id: s.id, state: s.state, reason: s.reason ?? null, blocking: s.blockingViolations ?? null })),
    findings: r.output.findings,
  }));

test("with a concurrency of 4, four read-only steps overlap in time", async () => {
  const c = clock();
  const steps = ["a", "b", "c", "d"].map((id) => c.step(id, { readOnly: true, ms: 250 }));
  const started = performance.now();
  const result = await runner.executeSteps(steps, { concurrency: 4 });
  const elapsed = performance.now() - started;
  assert.equal(c.max(), 4, "the four read-only steps ran at the same time");
  assert.ok(elapsed < 4 * 250, `four steps of 250 ms took ${Math.round(elapsed)} ms: they did not overlap`);
  assert.deepEqual(result.reports.map((r) => r.status), ["succeeded", "succeeded", "succeeded", "succeeded"]);
});

test("never more read-only steps at a time than the number, and a step not marked read-only never shares the machine", async () => {
  const c = clock();
  const steps = [
    c.step("r1", { readOnly: true }),
    c.step("r2", { readOnly: true }),
    c.step("r3", { readOnly: true }),
    c.step("tests", { ms: 150 }),
    c.step("r4", { readOnly: true }),
    c.step("r5", { readOnly: true }),
    c.step("r6", { readOnly: true }),
    c.step("build", { ms: 150 }),
  ];
  const events = [];
  const result = await runner.executeSteps(steps, { concurrency: 2, emit: (type, data) => events.push({ type, data }) });
  assert.equal(c.max(), 2, "at most two read-only steps at a time");
  for (const alone of ["tests", "build"]) {
    const span = c.spans.get(alone);
    assert.deepEqual([...span.beside], [alone], `${alone} ran with ${[...span.beside].join(", ")} beside it`);
    for (const [id, other] of c.spans) {
      if (id === alone) continue;
      assert.ok(other.end <= span.start || other.start >= span.end, `${id} overlapped ${alone}`);
    }
  }
  // Plan order holds across the exclusive steps: everything before "tests" ended before it started, everything after started after it ended.
  const order = steps.map((s) => s.id);
  const t = c.spans.get("tests");
  for (const id of order.slice(0, 3)) assert.ok(c.spans.get(id).end <= t.start, `${id} ended before tests started`);
  for (const id of order.slice(4)) assert.ok(c.spans.get(id).start >= t.end, `${id} started after tests ended`);
  assert.deepEqual(result.reports.map((r) => r.step.id), order, "the reports are in plan order");
  const startedEvents = events.filter((e) => e.type === "step-started");
  assert.equal(startedEvents.find((e) => e.data.step === "tests").data.readOnly, false);
  assert.equal(startedEvents.find((e) => e.data.step === "tests").data.running, 1);
  assert.equal(startedEvents.find((e) => e.data.step === "r1").data.readOnly, true);
  assert.ok(startedEvents.every((e) => e.data.concurrency === 2));
});

test("the result is the same for 1 and 4: findings, order of the steps, dependencies and failures", async () => {
  const plan = (c) => [
    c.step("lint-a", { readOnly: true, ms: 200, state: "completed", findings: [{ ruleId: "A1", file: "a.py", line: 1, severity: "error", message: "a" }] }),
    c.step("lint-b", { readOnly: true, ms: 30, state: "error" }),
    c.step("lint-c", { readOnly: true, ms: 90, state: "completed", findings: [{ ruleId: "C1", file: "c.py", line: 3, severity: "warning", message: "c" }] }),
    c.step("after-b", { readOnly: true, ms: 10, dependsOn: ["lint-b"] }),
    c.step("tests", { ms: 40 }),
    c.step("lint-d", { readOnly: true, ms: 10, findings: [{ ruleId: "D1", file: "d.py", line: 4, severity: "error", message: "d" }] }),
    c.step("after-d", { readOnly: true, ms: 60, dependsOn: ["lint-d"] }),
    c.step("lint-e", { readOnly: true, ms: 5 }),
  ];
  const one = await runner.executeSteps(plan(clock()), { concurrency: 1 });
  const c4 = clock();
  const four = await runner.executeSteps(plan(c4), { concurrency: 4 });
  assert.ok(c4.max() > 1, "the run with 4 really ran steps at the same time");
  assert.deepEqual(shape(four), shape(one));
  assert.equal(four.cancelled, one.cancelled);
  const merged = (r) => runner.mergeOutputs(r.reports.map((x) => x.output));
  assert.deepEqual(merged(four).findings, merged(one).findings);
  // A dependent of a failed step is blocked; a dependent waits for its dependency even when a place is free.
  const afterB = four.reports.find((r) => r.step.id === "after-b");
  assert.equal(afterB.status, "not-run");
  assert.equal(afterB.cause, "dependency");
  assert.ok(c4.spans.get("after-d").start >= c4.spans.get("lint-d").end, "after-d started only once lint-d ended");
});

test("cancelling stops every running step: their processes end and the run settles as cancelled", { timeout: 60_000 }, async () => {
  const pids = new Map();
  const step = (id, readOnly = true) => ({
    id,
    ...(readOnly ? { readOnly: true } : {}),
    skeleton: () => output(id, "pending"),
    run: async () => {
      const r = await runner.runSpec({ executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: os.tmpdir(), stdin: null });
      return r.exitCode === 0 ? output(id, "completed") : output(id, "error");
    },
  });
  const controller = new AbortController();
  const steps = [step("a"), step("b"), step("c"), step("d"), step("later", false)];
  const runningStarted = new Set();
  const settled = runner.executeSteps(steps, {
    concurrency: 4,
    signal: controller.signal,
    emit: (type, data) => {
      if (type === "process-started") {
        pids.set(data.step, data.pid);
        runningStarted.add(data.step);
        // From the event loop, like the Ctrl+C handler (never from inside the runner's own callback).
        if (runningStarted.size === 4) setImmediate(() => controller.abort("test"));
      }
    },
  });
  const started = performance.now();
  const result = await settled;
  assert.ok(performance.now() - started < 30_000, "the run settled soon after the cancellation");
  assert.equal(result.cancelled, true);
  assert.deepEqual([...pids.keys()].sort(), ["a", "b", "c", "d"], "the four read-only steps were running together");
  for (const id of ["a", "b", "c", "d"]) {
    const r = result.reports.find((x) => x.step.id === id);
    assert.equal(r.output.stages[0].state, "cancelled", id);
    assert.equal(r.output.stages[0].execution.cancelled, true, `${id}: its process was stopped by the cancellation`);
  }
  const later = result.reports.find((x) => x.step.id === "later");
  assert.equal(later.status, "not-run");
  assert.equal(later.cause, "cancelled");
  await sleep(200);
  for (const [id, pid] of pids) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `the process of ${id} (${pid}) still runs`);
  }
});

test("--fail-fast runs one step at a time, so the step that stops the run never depends on timing", async () => {
  const c = clock();
  const steps = [c.step("a", { readOnly: true, ms: 60, state: "error" }), c.step("b", { readOnly: true, ms: 10 }), c.step("c", { readOnly: true, ms: 10 })];
  const result = await runner.executeSteps(steps, { concurrency: 4, failFast: true });
  assert.equal(c.max(), 1);
  assert.equal(result.failFast.stepId, "a");
  assert.deepEqual(result.reports.map((r) => r.cause ?? r.status), ["failed", "fail-fast", "fail-fast"]);
});

test("a step container ended at its memory limit is incomplete with STEP_MEMORY_LIMIT and the hint to lower the number", async () => {
  // The launcher plays the engine: the tool's process becomes a `docker run` client that the kernel ended with 137.
  const launcher = {
    handles: (spec) => spec.executable !== process.execPath,
    run: (_spec, options) => runner.runSpec({ executable: process.execPath, args: ["-e", "process.exit(137)"], cwd: os.tmpdir(), stdin: null }, options),
    engineLost: () => null,
  };
  const step = {
    id: "semgrep",
    readOnly: true,
    resources: { memoryMb: 2048 },
    skeleton: () => output("semgrep", "pending"),
    // An adapter that (wrongly) reads a killed tool as clean: the executor does not let it pass.
    run: async () => {
      await runner.runSpec({ executable: "semgrep", args: ["--json"], cwd: os.tmpdir(), stdin: null });
      return output("semgrep", "completed");
    },
  };
  const result = await runner.executeSteps([step], { concurrency: 3, launcher });
  const stage = result.reports[0].output.stages[0];
  assert.equal(result.reports[0].status, "failed");
  assert.equal(stage.state, "error");
  assert.equal(stage.interpreted, false);
  assert.equal(stage.execution.reasonCode, "STEP_MEMORY_LIMIT");
  assert.match(stage.reason, /2048 MB/);
  assert.match(stage.reason, /checks at a time \(now 3\)/);
  // Not in a container (no launcher): an exit of 137 is the adapter's to read, as before.
  const native = await runner.executeSteps([{ ...step, run: async () => output("semgrep", "completed") }], { concurrency: 3 });
  assert.equal(native.reports[0].output.stages[0].state, "completed");
});

test("the automatic number: the smaller of memory and CPUs over a step's limits, at least 1 and at most 8", () => {
  // The user's machine: 15.5 GB and 16 CPUs, steps of 4 GB and 2 CPUs.
  assert.equal(runner.automaticConcurrency({ memoryMb: 15_872, cpus: 16 }), 3);
  assert.equal(runner.automaticConcurrency({ memoryMb: 8192, cpus: 4 }), 2);
  assert.equal(runner.automaticConcurrency({ memoryMb: 131_072, cpus: 64 }), runner.MAX_AUTOMATIC_CONCURRENCY);
  assert.equal(runner.MAX_AUTOMATIC_CONCURRENCY, 8);
  assert.equal(runner.automaticConcurrency({ memoryMb: 2048, cpus: 8 }), 1, "never below 1");
  assert.equal(runner.automaticConcurrency({ memoryMb: null, cpus: null }), 1, "nothing known: one at a time");
  assert.equal(runner.automaticConcurrency({ memoryMb: null, cpus: 6 }), 3);
  assert.equal(runner.automaticConcurrency({ memoryMb: 16_384, cpus: 16 }, { memoryMb: 2048, cpus: 1 }), 8);
  const configured = runner.chooseConcurrency(6, { memoryMb: 15_872, cpus: 16 });
  assert.deepEqual([configured.value, configured.source, configured.automatic], [6, "configuration", 3]);
  const automatic = runner.chooseConcurrency(null, { memoryMb: 15_872, cpus: 16 });
  assert.deepEqual([automatic.value, automatic.source], [3, "automatic"]);
  assert.deepEqual(automatic.step, { memoryMb: 4096, cpus: 2 });
});

test("the built-in adapters that only read the project are marked one by one, and no marked one executes project code", () => {
  const marked = builtinManifests().filter((m) => m.effects.onlyReadsProject === true).map((m) => m.id).sort();
  assert.deepEqual(marked, ["builtin-pii", "cargo-audit", "checkov", "file-size", "gitleaks", "hadolint", "import-linter", "jscpd", "oasdiff", "osv-scanner", "ruff", "semgrep", "shellcheck", "supply-chain", "trivy", "zizmor"]);
  for (const m of builtinManifests().filter((x) => x.effects.onlyReadsProject === true)) {
    assert.equal(m.effects.executesProjectCode, false, m.id);
    assert.equal(m.effects.mayChangeCode, false, m.id);
    assert.equal(m.effects.needsService, false, m.id);
    assert.deepEqual(m.redirection?.unavoidableWorkspaceWrites ?? [], [], m.id);
  }
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(readJson(path.resolve(here, "..", "schemas", "catalog", "adapter-manifest.schema.json")));
  for (const m of builtinManifests()) assert.ok(validate(m), `${m.id}: ${JSON.stringify(validate.errors)}`);
});
