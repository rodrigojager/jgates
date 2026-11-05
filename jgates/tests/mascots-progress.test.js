import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { routes } from "../dist/server/routes/runs.js";
import { frozenPlan, runMascots } from "../dist/server/mascots.js";
import { workspaceDir } from "../dist/core/home/index.js";
import { Mascot } from "../ui/src/mascots/actors/characters.js";

test("progress pages keep a separately versioned evidence snapshot and the persisted frozen plan", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-mascot-progress-"));
  const runId = "run_20261105T100000Z_0a1b2c3d";
  const server = { home, workspace: { id: "ws_fixture" }, runs: { active: null }, plans: new Map() };
  const dir = path.join(workspaceDir(home, server.workspace.id), "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const plan = { kind: "jgates-plan", schemaVersion: 1, planHash: "original", blockers: [], selection: { reduced: false },
    invocations: [{ id: "lint" }], groups: { willRun: [{ id: "lint#lint", tool: "lint", adapter: "ruff", category: "quality", label: "Lint", state: { enabled: true, origin: "profile" }, command: { invocation: "lint" }, reason: { message: "Selected" }, availability: { status: "available" } }], notApplicableOrDisabled: [], uncoveredRequirements: [] } };
  const result = { runId, decision: "passed", partial: true, finishedAt: "checkpoint-2", stages: [{ id: "lint#lint", state: "completed", interpreted: true, blockingViolations: 0 }], findings: [] };
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));
  const events = Array.from({ length: 602 }, (_, n) => ({ schemaVersion: 1, runId, sequence: n + 1, type: n === 0 ? "step-started" : n === 601 ? "stage" : "process-started", data: n === 601 ? { step: "lint", stageId: "lint#lint", state: "completed" } : { step: "lint" } }));
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  try {
    const handler = routes.find((r) => r.path === "/api/runs/:id/progress").handler;
    const first = (await handler({ server, params: { id: runId }, query: { cursor: "0", wait: "0" } })).json;
    assert.equal(first.events.length, 500); assert.equal(first.cursor, 500); assert.equal(first.done, false);
    assert.equal(first.mascots.planHash, "original"); assert.match(first.mascots.revision, /^602:checkpoint-2:/);
    assert.equal(first.mascots.domains[0].status, "passed");
    assert.ok(!JSON.stringify(first.mascots).includes("invocations"));
    const second = (await handler({ server, params: { id: runId }, query: { cursor: "500", wait: "0" } })).json;
    assert.equal(second.events.length, 102); assert.equal(second.cursor, 602); assert.equal(second.orphan, true);
    assert.deepEqual(first.mascots, second.mascots);
    assert.equal(second.steps[0].id, "lint");
    assert.equal(runMascots(server, runId, result, { running: true, cancelRequested: true }).cancelling, true);
    assert.equal(runMascots(server, runId, { ...result, partial: false }, { running: true, cancelRequested: true }).cancelling, false);
    fs.unlinkSync(path.join(dir, "plan.json"));
    assert.equal(frozenPlan(server, runId), null);
    const legacy = runMascots(server, runId, result);
    assert.equal(legacy.evidenceUnavailable, true); assert.equal(legacy.domains[0].status, "incomplete");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("settled hydration applies gray rest and final reactions without an animation clock", () => {
  for (const domain of ["quality", "security", "dependencies", "tests", "architecture", "infrastructure"]) {
    const actor = new Mascot(domain);
    actor.setStatus("disabled", { settled: true }); actor.update(0);
    assert.equal(actor.inspect().gray, 1);
    actor.setStatus("passed", { settled: true }); actor.update(0);
    assert.equal(actor.inspect().gray, 0); assert.ok(actor.inspect().expression.happy > .95);
    actor.dispose();
  }
});
