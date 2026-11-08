import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { FIXTURES, alive, load, readEvents, readJson, setupWorkspace, until } from "./fixtures/semantic-executor/helpers.mjs";

// V2-17: the user cancels. A Semantic investigation runs in this process with an agent CLI backend whose process (and
// its child) the run owns; an unrelated process started by the same parent keeps running. A cancel request (the same
// file `jgates semantic cancel` writes) stops only the owned processes; the partial artifacts stay (the investigation
// record, the context transcript, the CLI logs, the review outcome) and the history holds a valid, settled, cancelled
// entry. The same for a Quality run: cancelling stops only the tool's process tree and keeps its log, its partial result
// and a valid history entry.

const FAKE = path.join(FIXTURES, "fake-agent-cli.mjs");
const owned = [];
test.after(() => {
  for (const pid of owned) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

function unrelatedProcess() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  owned.push(child.pid);
  return child;
}

test("V2-17: cancelling a semantic run and a Quality run stops only their own processes, keeps partial artifacts and leaves valid history", async () => {
  // ---- Semantic run: agent CLI investigation ----
  const ws = setupWorkspace("v2-17", { "src/app.js": 'exports.find = (db, id) => db.query("SELECT * FROM t WHERE id = " + id);\n' }, { provider: "claude-code" });
  const unrelated = unrelatedProcess();
  try {
    const { buildSemanticPlan, executeSemanticRun, requestSemanticCancel, listSemanticRuns, findSemanticRun } = await load("core/semantic/index.js");
    const { INVESTIGATION_MODULE } = await load("core/semantic-executor/index.js");
    const { newGateRunId, loadGateRecord } = await load("core/gates/index.js");
    const plan = buildSemanticPlan({ workspacePath: ws.dir, home: ws.home, env: ws.env });
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    const runId = newGateRunId("semantic");
    const pidFile = path.join(ws.root, "cli-pids.json");
    const pending = executeSemanticRun({
      workspacePath: ws.dir,
      home: ws.home,
      env: ws.env,
      version: "0.0.0-test",
      plan,
      runId,
      cancelPollMs: 50,
      investigation: { module: INVESTIGATION_MODULE, agentCli: { command: process.execPath, prefixArgs: [FAKE, "--fake-mode=hang", `--fake-pids=${pidFile}`] } },
    });
    const [cliPid, grandchildPid] = await until(() => (fs.existsSync(pidFile) ? readJson(pidFile) : null), 60_000, "the agent CLI to start");
    owned.push(cliPid, grandchildPid);
    assert.ok(alive(cliPid) && alive(grandchildPid) && alive(unrelated.pid));
    assert.equal(findSemanticRun(ws.home, plan.workspace.id, runId).lifecycle, "running");

    const cancel = requestSemanticCancel(ws.home, plan.workspace.id, runId, { reason: "user cancelled" });
    assert.equal(cancel.status, "requested");
    const result = await pending;
    assert.equal(result.decision, "cancelled");
    assert.equal(result.exitCode, 130);
    assert.equal(result.stopped.cause, "cancelled");
    assert.deepEqual(result.stages.map((s) => `${s.id}:${s.state}`), ["semantic-context:completed", "semantic-review:cancelled"]);

    // Only the run's own processes stopped.
    await until(() => !alive(cliPid) && !alive(grandchildPid), 20_000, "the owned agent CLI tree to stop");
    assert.equal(alive(unrelated.pid), true, "an unrelated process is never stopped");

    // Partial artifacts: the investigation record with the cancelled stage, the context transcript with the process,
    // the CLI's logs, and the review outcome.
    const investigation = result.semanticRun.outcome.investigation;
    assert.equal(investigation.backend.kind, "agent-cli");
    assert.equal(investigation.stages[0].state, "cancelled");
    assert.equal(investigation.stages[0].contexts[0].status, "cancelled");
    assert.equal(investigation.stages[1].state, "not-run");
    const record = readJson(path.join(result.runDir, "evidence", "investigation.json"));
    assert.equal(record.stages[0].state, "cancelled");
    const transcript = readJson(path.join(result.runDir, investigation.artifacts.contexts[0]));
    const proc = transcript.entries.find((e) => e.role === "process").process;
    assert.equal(proc.pid, cliPid);
    assert.equal(proc.cancelled, true);
    const logs = fs.readdirSync(path.join(result.runDir, "logs", "agent-cli"));
    const huntLog = logs.find((f) => f.endsWith("-hunt.stdout.log"));
    assert.ok(huntLog, logs.join(", "));
    assert.match(fs.readFileSync(path.join(result.runDir, "logs", "agent-cli", huntLog), "utf8"), /phase: hunting started/);
    assert.equal(readJson(path.join(result.runDir, "outputs", "review.json")).investigation.stages[0].state, "cancelled");
    for (const f of ["evidence/investigation.json", "outputs/review.json"]) assert.ok(result.artifacts.outputs.includes(f), f);
    // The CLI's own progress claim is never taken as a stage state.
    assert.equal(JSON.stringify(investigation.stages).includes("phase: hunting"), false);
    // The staged copy of the scope does not outlive the run.
    assert.equal(fs.existsSync(path.join(result.runDir, "work", "scope")), false);

    // Ordered events: the owned process started, the cancel was requested, the process finished cancelled, the run ended.
    const events = readEvents(result.runDir);
    assert.deepEqual(events.map((e) => e.sequence), events.map((_, i) => i + 1));
    const kinds = events.map((e) => `${e.type}${e.type.startsWith("process") ? `:${e.data.context}` : ""}`);
    const at = (k) => kinds.indexOf(k);
    assert.ok(at("process-started:hunt") > 0 && at("process-started:hunt") < at("cancel-requested") && at("cancel-requested") < at("process-finished:hunt"), kinds.join(" "));
    assert.equal(events.find((e) => e.type === "process-finished" && e.data.context === "hunt").data.cancelled, true);
    assert.equal(kinds.at(-1), "run-finished");

    // A valid, settled history entry.
    const history = listSemanticRuns(ws.home, plan.workspace.id);
    assert.deepEqual(history.map((h) => [h.runId, h.lifecycle, h.decision, h.live]), [[runId, "settled", "cancelled", false]]);
    const identity = loadGateRecord("run-identity", path.join(result.runDir, "run.json"));
    assert.equal(identity.outcome.decision, "cancelled");
    assert.equal(identity.outcome.partial, false);
  } finally {
    ws.cleanup();
  }

  // ---- Quality run: a tool whose process tree the run owns ----
  const qws = setupWorkspace("v2-17q", { "app.js": "exports.answer = () => 42;\n" });
  const unrelatedQ = unrelatedProcess();
  try {
    const run = await load("core/run/index.js");
    const runner = await load("core/runner/index.js");
    const { listRuns } = await load("core/artifacts/index.js");
    const pidFile = path.join(qws.root, "tool-pids.json");
    const controller = new AbortController();
    const step = (ctx) => ({
      id: "slow-tool",
      skeleton: () => ({ stages: [{ id: "slow-tool#check", kind: "step", adapter: "fake", state: "pending" }], requirements: [{ id: "slow-tool#check", required: true }], disabled: [], findings: [], logs: [], outputs: [] }),
      run: async () => {
        const r = await runner.runSpec({ executable: process.execPath, args: [FAKE, "--fake-mode=hang", `--fake-pids=${pidFile}`], cwd: qws.dir, stdoutFile: path.join(ctx.logsDir, "slow-tool.stdout.log") });
        return {
          stages: [{ id: "slow-tool#check", kind: "step", adapter: "fake", state: r.exitCode === 0 ? "completed" : "error", reason: r.cancelled ? "cancelled" : "exit" }],
          requirements: [{ id: "slow-tool#check", required: true }],
          disabled: [],
          findings: [],
          logs: ["logs/slow-tool.stdout.log"],
          outputs: [],
        };
      },
    });
    const pending = run.executeRun({ workspacePath: qws.dir, home: qws.home, version: "0.0.0-test", adapter: "fake", options: {}, env: { ...qws.env, JGATES_NO_CACHE: "1" }, steps: (ctx) => [step(ctx)], signal: controller.signal });
    const [toolPid, toolChild] = await until(() => (fs.existsSync(pidFile) ? readJson(pidFile) : null), 60_000, "the Quality tool to start");
    owned.push(toolPid, toolChild);
    controller.abort("user cancelled");
    const result = await pending;
    assert.equal(result.decision, "cancelled");
    assert.equal(result.exitCode, 130);
    assert.match(result.runId, /^run_/);
    await until(() => !alive(toolPid) && !alive(toolChild), 20_000, "the Quality tool tree to stop");
    assert.equal(alive(unrelatedQ.pid), true, "an unrelated process is never stopped by a Quality cancel");
    assert.equal(alive(unrelated.pid), true);
    // Partial artifacts: the final (not partial) result, the tool's log up to the cancel, the events.
    const onDisk = readJson(path.join(result.runDir, "result.json"));
    assert.equal(onDisk.decision, "cancelled");
    assert.equal(onDisk.partial, undefined);
    assert.equal(result.stages.find((s) => s.id === "slow-tool#check").state, "cancelled");
    assert.match(fs.readFileSync(path.join(result.runDir, "logs", "slow-tool.stdout.log"), "utf8"), /phase: hunting started/);
    const events = readEvents(result.runDir);
    assert.ok(events.some((e) => e.type === "cancel-requested"));
    assert.equal(events.at(-1).type, "run-finished");
    // A valid history entry in the Quality history, and none in the Semantic one.
    const history = listRuns(qws.home, result.workspace.id);
    assert.deepEqual(history.map((h) => [h.runId, h.decision, h.partial, h.alive]), [[result.runId, "cancelled", false, false]]);
    assert.equal(fs.existsSync(path.join(qws.home, "workspaces", result.workspace.id, "semantic-runs")), false);
  } finally {
    qws.cleanup();
  }
});
