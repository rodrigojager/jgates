import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

// Independent Semantic runs (core/semantic, `jgates semantic ...`, /api/semantic/runs): plan and prerequisites, the
// result and events against their schemas, invalid model output, cancellation of owned processes with partial
// evidence, a run whose process died, an attached Quality report with its freshness and the API driving the same
// service. Every provider is a fake (a command that records its calls, or an in-process review), so no test spends
// model tokens.

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const MAIN = path.join(DIST, "cli", "main.js");
const SCHEMAS = path.resolve(here, "..", "schemas");
const load = (rel) => import(pathToFileURL(path.join(DIST, rel)).href);

const temps = [];
const pids = [];
test.after(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const tmp = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const ANSWERS = {
  approved: JSON.stringify({ status: "APPROVED", score: 95, findings: [], hardBlockers: [] }),
  rejected: JSON.stringify({ status: "REJECTED", score: 40, findings: [{ severity: "blocking", category: "security", path: "app.js", message: "Injection." }] }),
  malformed: "Looks great, ship it!",
};

/** A workspace (Git, one untracked file) with a fake command provider: approved, rejected, malformed or hang. */
function workspace(mode = "approved", { configure = true } = {}) {
  const dir = tmp("jg-semrun-ws-");
  const home = tmp("jg-semrun-home-");
  const aux = tmp("jg-semrun-aux-");
  const calls = path.join(aux, "calls.log");
  const pidFile = path.join(aux, "provider.pid");
  const script = path.join(aux, "provider.mjs");
  fs.writeFileSync(
    script,
    [
      `import fs from "node:fs";`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `for await (const c of process.stdin) {}`,
      `fs.appendFileSync(${JSON.stringify(calls)}, "CALL\\n");`,
      mode === "hang" ? `await new Promise((r) => setTimeout(r, 60000));` : "",
      `process.stdout.write(${JSON.stringify(ANSWERS[mode] ?? ANSWERS.approved)});`,
    ].join("\n"),
  );
  if (configure) {
    fs.writeFileSync(
      path.join(dir, "jgates.yml"),
      ["extensions:", "  semantic-gate:", "    provider: command", `    command: ${JSON.stringify(process.execPath)}`, `    commandArgs: [${JSON.stringify(script)}]`, "    model: fake-model", "    timeoutSeconds: 90", ""].join("\n"),
    );
  }
  fs.writeFileSync(path.join(dir, "app.js"), "exports.answer = () => 42;\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  const env = { ...process.env, JGATES_HOME: home, NO_COLOR: "1" };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env, input: "", timeout: 120_000 });
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {
      doc = null;
    }
    return { code: r.status, out: r.stdout, err: r.stderr, doc };
  };
  const providerCalls = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0);
  const providerPid = () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : null);
  return { dir, home, env, cli, providerCalls, providerPid };
}

function validator(file) {
  return new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(fs.readFileSync(path.join(SCHEMAS, file), "utf8")));
}

test("plan: Semantic-only needs a provider and the package, never a Quality run; without a provider no run is created", () => {
  const p = workspace("approved", { configure: false });
  const plan = p.cli("semantic", "plan", "--cwd", p.dir, "--json");
  assert.equal(plan.code, 0, plan.out + plan.err);
  assert.equal(plan.doc.plan.ready, false);
  assert.deepEqual(plan.doc.plan.blockers.map((b) => b.code), ["SEMANTIC_NOT_CONFIGURED"]);
  const quality = plan.doc.plan.prerequisites.find((x) => x.id === "quality-history");
  assert.equal(quality.required, false);
  assert.equal(plan.doc.plan.quality.requirement, "none");
  const run = p.cli("semantic", "run", "--cwd", p.dir, "--json");
  assert.equal(run.code, 3);
  assert.equal(run.doc.code, "SEMANTIC_NOT_CONFIGURED");
  assert.equal(fs.existsSync(path.join(p.home, "workspaces", plan.doc.workspace.id, "semantic-runs")), false);
  assert.equal(p.providerCalls(), 0);
  const missing = p.cli("semantic", "run", "--cwd", p.dir, "--quality", "latest", "--json");
  assert.equal(missing.code, 3);
});

test("result and events of a Semantic run follow their schemas; a rejected verdict fails with its findings", () => {
  const p = workspace("rejected");
  const r = p.cli("semantic", "run", "--cwd", p.dir, "--json");
  assert.ok(r.doc, r.out + r.err);
  assert.equal(r.code, 1);
  assert.equal(r.doc.decision, "failed");
  assert.equal(r.doc.blockingViolations, 1);
  assert.equal(r.doc.findings.length, 1);
  assert.equal(r.doc.findings[0].blocking, true);
  assert.equal(r.doc.findings[0].location.path, "app.js");
  assert.equal(r.doc.semanticRun.enforcement, "advisory");
  const validResult = validator("result/result.schema.json");
  assert.equal(validResult(r.doc), true, JSON.stringify(validResult.errors));
  const validEvent = validator("events/event.schema.json");
  const lines = fs.readFileSync(path.join(r.doc.runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const e of lines) assert.equal(validEvent(e), true, `${JSON.stringify(e)} ${JSON.stringify(validEvent.errors)}`);
  assert.deepEqual(lines.filter((e) => e.type === "step-started").map((e) => e.data.step), ["semantic-context", "semantic-review"]);
});

test("invalid model output is an explicit invalid state: in the advisory review and in a Semantic run (never favorable)", async () => {
  const { runSemanticReview } = await load("adapters/semantic-gate/index.js");
  const p = workspace("malformed");
  for (const [text, code] of [
    ["Looks great, ship it!", "malformed-output"],
    ["", "empty-output"],
    ["{}", "empty-output"],
  ]) {
    const outcome = await runSemanticReview(p.dir, { env: p.env }, { callProvider: async () => ({ text, raw: null }) });
    assert.equal(outcome.state, "invalid", `${JSON.stringify(text)}: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.conclusion.status, "INVALID");
    assert.equal(outcome.conclusion.reasonCode, code);
    assert.equal(outcome.calls, 1);
  }
  const r = p.cli("semantic", "run", "--cwd", p.dir, "--json");
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(r.doc.decision, "invalid");
  assert.equal(r.doc.complete, false);
  const review = r.doc.stages.find((s) => s.id === "semantic-review");
  assert.equal(review.state, "error");
  assert.equal(review.interpreted, false);
  assert.equal(r.doc.semanticRun.outcome.conclusion.reasonCode, "malformed-output");
});

test("cancel stops only the run's own processes, keeps the partial evidence and settles the run as cancelled", async () => {
  const p = workspace("hang");
  const { newGateRunId } = await load("core/gates/index.js");
  const runId = newGateRunId("semantic");
  // A process the run does not own: it must survive the cancellation.
  const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  pids.push(unrelated.pid);
  const child = spawn(process.execPath, [MAIN, "semantic", "run", "--cwd", p.dir, "--run-id", runId, "--json"], { env: p.env, stdio: ["ignore", "pipe", "pipe"] });
  pids.push(child.pid);
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const providerPid = await until(() => p.providerPid(), 60_000, "the provider to start");
  pids.push(providerPid);
  const status = p.cli("semantic", "status", runId, "--cwd", p.dir, "--json");
  assert.equal(status.doc.run.lifecycle, "running");
  assert.equal(status.doc.run.live, true);
  const cancel = p.cli("semantic", "cancel", runId, "--cwd", p.dir, "--json");
  assert.equal(cancel.code, 0, cancel.out + cancel.err);
  assert.equal(cancel.doc.cancel, "requested");
  const code = await exited;
  assert.equal(code, 130);
  const doc = JSON.parse(out);
  assert.equal(doc.decision, "cancelled");
  assert.equal(doc.stopped.cause, "cancelled");
  assert.deepEqual(doc.stages.map((s) => `${s.id}:${s.state}`), ["semantic-context:completed", "semantic-review:cancelled"]);
  // Partial evidence stays: the review outcome with the context it had prepared, and the events up to the end.
  const review = JSON.parse(fs.readFileSync(path.join(doc.runDir, "outputs", "review.json"), "utf8"));
  assert.ok(review.context && review.context.files >= 1);
  const events = fs.readFileSync(path.join(doc.runDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.type === "cancel-requested"));
  assert.equal(events.at(-1).type, "run-finished");
  await until(() => !alive(providerPid), 15_000, "the owned provider process to stop");
  assert.equal(alive(unrelated.pid), true, "an unrelated process is never stopped");
  const history = p.cli("semantic", "history", "--cwd", p.dir, "--json");
  assert.equal(history.doc.runs[0].runId, runId);
  assert.equal(history.doc.runs[0].lifecycle, "settled");
  assert.equal(history.doc.runs[0].decision, "cancelled");
  const again = p.cli("semantic", "cancel", runId, "--cwd", p.dir, "--json");
  assert.equal(again.doc.code, "RUN_NOT_ACTIVE");
});

test("a run whose process died is interrupted, and a cancel settles it as cancelled with what it had", async () => {
  const p = workspace("hang");
  const { newGateRunId } = await load("core/gates/index.js");
  const runId = newGateRunId("semantic");
  const child = spawn(process.execPath, [MAIN, "semantic", "run", "--cwd", p.dir, "--run-id", runId, "--json"], { env: p.env, stdio: "ignore" });
  pids.push(child.pid);
  const exited = new Promise((resolve) => child.on("exit", resolve));
  pids.push(await until(() => p.providerPid(), 60_000, "the provider to start"));
  child.kill("SIGKILL");
  await exited;
  // The heartbeat file stays behind with a dead pid: the run is not running any more.
  const status = p.cli("semantic", "status", runId, "--cwd", p.dir, "--json");
  assert.equal(status.doc.run.lifecycle, "interrupted");
  assert.equal(status.doc.run.live, false);
  assert.equal(status.doc.run.result.partial, true);
  const cancel = p.cli("semantic", "cancel", runId, "--cwd", p.dir, "--json");
  assert.equal(cancel.doc.cancel, "settled", cancel.out + cancel.err);
  const settled = p.cli("semantic", "status", runId, "--cwd", p.dir, "--json");
  assert.equal(settled.doc.run.lifecycle, "settled");
  assert.equal(settled.doc.run.result.decision, "cancelled");
  assert.equal(settled.doc.run.result.exitCode, 130);
  assert.equal(settled.doc.run.identity.outcome.decision, "cancelled");
  const validResult = validator("result/result.schema.json");
  assert.equal(validResult(settled.doc.run.result), true, JSON.stringify(validResult.errors));
  const events = fs.readFileSync(path.join(settled.doc.run.dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.sequence), events.map((_, i) => i + 1));
  assert.equal(events.at(-1).type, "run-finished");
});

test("an attached Quality report is current only for the same source; stale or legacy evidence is never a current approval", async () => {
  const p = workspace("approved");
  const semantic = await load("core/semantic/index.js");
  const gates = await load("core/gates/index.js");
  const home = await load("core/home/index.js");
  const ws = home.touchWorkspace(p.dir, { home: p.home });
  // A finished, passed Quality run of this exact source, with its run identity next to its result.
  const writeQuality = (runId, withIdentity) => {
    const dir = path.join(p.home, "workspaces", ws.id, "runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    const result = { schemaVersion: 1, runId, gate: "quality", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), decision: "passed", complete: true, reduced: false, exitCode: 0, stages: [{ id: "lint", state: "completed" }], disabled: [] };
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));
    if (withIdentity) {
      const identity = gates.readResultAsGateRun(result, { source: gates.computeSourceIdentity(p.dir) });
      gates.writeGateRecord("run-identity", path.join(dir, "run.json"), identity);
    }
  };
  const review = async () => ({ requested: true, state: "completed", separateFromDecision: true, provider: "fake", model: null, scope: "changed", limits: null, cost: { reported: false, perCall: null, total: null }, calls: 1, context: { files: 1 }, conclusion: { status: "APPROVED", score: 99, threshold: 90, findings: [], hardBlockers: [] } });
  const run = (quality) => semantic.executeSemanticRun({ workspacePath: p.dir, home: p.home, env: p.env, version: "test", quality, review });

  writeQuality("run_20260101T000000Z_0000aaaa", true);
  const current = await run("run_20260101T000000Z_0000aaaa");
  assert.equal(current.decision, "passed");
  assert.equal(current.semanticRun.quality.freshness, "current");
  assert.equal(current.semanticRun.quality.currentApproval, true);
  const binding = gates.loadGateRecord("evidence-binding", path.join(current.runDir, "evidence", "quality-run_20260101T000000Z_0000aaaa.json"));
  assert.equal(binding.freshness.state, "current");
  assert.equal(binding.origin.gate, "quality");

  // The source changes after the Quality run: the same report is now stale and no longer a current approval.
  fs.writeFileSync(path.join(p.dir, "app.js"), "exports.answer = () => 43;\n");
  const stale = await run("run_20260101T000000Z_0000aaaa");
  assert.equal(stale.semanticRun.quality.freshness, "stale");
  assert.equal(stale.semanticRun.quality.code, "DIFFERENT_SOURCE");
  assert.equal(stale.semanticRun.quality.currentApproval, false);
  assert.equal(stale.decision, "passed", "the Semantic decision is its own; the stale report is only disclosed");

  // A Quality run without a run identity (written before V2): freshness unknown, never current.
  writeQuality("run_20260102T000000Z_0000bbbb", false);
  const legacy = await run("latest");
  assert.equal(legacy.semanticRun.quality.runId, "run_20260102T000000Z_0000bbbb");
  assert.equal(legacy.semanticRun.quality.freshness, "unknown");
  assert.equal(legacy.semanticRun.quality.code, "SOURCE_LEGACY");
  assert.equal(legacy.semanticRun.quality.currentApproval, false);
  // Attaching evidence never wrote into the Quality runs.
  assert.deepEqual(fs.readdirSync(path.join(p.home, "workspaces", ws.id, "runs")).sort(), ["run_20260101T000000Z_0000aaaa", "run_20260102T000000Z_0000bbbb"]);
});

test("the API starts, follows and cancels a Semantic run through the same service", async () => {
  const p = workspace("hang");
  const { routes } = await load("server/routes/semantic-runs.js");
  const { workspaceId } = await load("core/ids/index.js");
  const route = (method, routePath) => routes.find((r) => r.method === method && r.path === routePath);
  const server = { home: p.home, workspace: { id: workspaceId(p.dir), path: p.dir, name: "api" }, log: () => undefined };
  const previous = process.env.JGATES_HOME;
  process.env.JGATES_HOME = p.home;
  try {
    const plan = await route("GET", "/api/semantic/plan").handler({ query: {}, server });
    assert.equal(plan.json.plan.ready, true);
    const started = await route("POST", "/api/semantic/runs").handler({ body: {}, server });
    assert.equal(started.status, 202);
    const runId = started.json.run.runId;
    assert.match(runId, /^sem_/);
    await assert.rejects(async () => route("POST", "/api/semantic/runs").handler({ body: {}, server }), (e) => e.code === "SEMANTIC_RUN_ACTIVE");
    pids.push(await until(() => p.providerPid(), 60_000, "the provider to start"));
    const followed = await route("GET", "/api/semantic/runs/:id/events").handler({ params: { id: runId }, query: { cursor: "0" }, server });
    assert.equal(followed.json.events[0].type, "run-started");
    assert.equal(followed.json.live, true);
    const cancel = await route("POST", "/api/semantic/runs/:id/cancel").handler({ params: { id: runId }, server });
    assert.equal(cancel.status, 202);
    await until(() => {
      const r = spawnSync(process.execPath, [MAIN, "semantic", "status", runId, "--cwd", p.dir, "--json"], { encoding: "utf8", env: p.env });
      return JSON.parse(r.stdout).run?.lifecycle === "settled";
    }, 60_000, "the run to settle");
    const one = await route("GET", "/api/semantic/runs/:id").handler({ params: { id: runId }, server });
    assert.equal(one.json.run.result.decision, "cancelled");
    await assert.rejects(async () => route("POST", "/api/semantic/runs/:id/cancel").handler({ params: { id: runId }, server }), (e) => e.code === "RUN_NOT_ACTIVE");
    await assert.rejects(async () => route("GET", "/api/semantic/runs/:id").handler({ params: { id: "sem_20200101T000000Z_00000000" }, server }), (e) => e.code === "RUN_NOT_FOUND");
  } finally {
    if (previous === undefined) delete process.env.JGATES_HOME;
    else process.env.JGATES_HOME = previous;
  }
});
