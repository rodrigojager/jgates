import test from "node:test";
import assert from "node:assert/strict";
import { projectMascots } from "../dist/core/mascots/index.js";
import { CORE_CAPABILITIES } from "../dist/core/catalog/index.js";

const item = (id, category = "quality", overrides = {}) => ({
  id, tool: id.split("#")[0], adapter: "ruff", label: id, category, capabilities: [id.split("#")[1]],
  state: { enabled: true, origin: "profile", runOnly: false }, reason: { message: "Selected by profile" },
  availability: { status: "available" }, command: { invocation: id.split("#")[0] }, ...overrides,
});
const plan = (items, gaps = []) => ({ kind: "jgates-plan", planHash: "frozen", selection: { reduced: false }, approvable: true, blocked: null, blockers: [], groups: {
  willRun: items.filter((i) => i.state.enabled), notApplicableOrDisabled: items.filter((i) => !i.state.enabled), uncoveredRequirements: gaps,
} });
const result = (stages, extra = {}) => ({ runId: "run_A", finishedAt: "2026-11-05T00:00:00Z", stages, findings: [], decision: "passed", ...extra });
const stage = (id, extra = {}) => ({ id, state: "completed", interpreted: true, blockingViolations: 0, ...extra });
const event = (sequence, type, data = {}, runId = "run_A") => ({ schemaVersion: 1, runId, sequence, type, data });
const quality = (options) => projectMascots(options).domains.find((d) => d.domain === "quality");

test("all catalog specialities have explicit domain coverage, custom capabilities are not guessed", () => {
  const items = CORE_CAPABILITIES.map((c) => item(`tool#${c.id}`, c.category));
  const s = projectMascots({ plan: plan([...items, item("quality-looking-name#unknown", "custom")]) });
  assert.equal(s.domains.length, 6);
  assert.equal(s.domains.flatMap((d) => d.checks).length, items.length);
});
test("configuration uses selected plan, disabled scope and coverage gaps independently", () => {
  const on = item("ruff#lint"), off = item("size#file-size", "quality", { state: { enabled: false, origin: "run", runOnly: true } });
  let q = quality({ plan: plan([on, off]) });
  assert.equal(q.selection, "partial"); assert.equal(q.status, "waiting"); assert.equal(q.runOnlyExcluded, 1);
  assert.equal(quality({ plan: plan([off]) }).status, "disabled");
  q = quality({ plan: plan([], [{ category: "quality", reason: "NO_EXECUTABLE_CHECK" }]) });
  assert.equal(q.status, "blocked"); assert.equal(q.coverageGap, true);
});
test("terminal domain aggregates all stages rather than the last successful event", () => {
  const p = plan([item("a#lint"), item("b#lint")]);
  const r = result([stage("a#lint", { blockingViolations: 2 }), stage("b#lint")]);
  assert.equal(quality({ plan: p, result: r }).status, "failed");
  assert.deepEqual(quality({ plan: p, result: r }).progress, { completed: 2, total: 2 });
});
test("partial findings keep processing while another selected check is active", () => {
  const p = plan([item("a#lint"), item("b#lint")]);
  const q = quality({ plan: p, runId: "run_A", result: result([stage("a#lint", { blockingViolations: 1 })], { partial: true }), running: true,
    events: [event(1, "step-started", { step: "b" })] });
  assert.equal(q.status, "processing"); assert.equal(q.hasFindings, true); assert.deepEqual(q.progress, { completed: 1, total: 2 });
});
test("bridge aliases bind shared Trivy evidence to two domains, excluding composite count", () => {
  const common = { tool: "quality-bridge.trivy", adapter: "quality-bridge", command: { invocation: "quality-bridge" } };
  const p = plan([item("quality-bridge.trivy#dependencies", "dependencies", common), item("quality-bridge.trivy#iac", "infrastructure", common)]);
  const s = projectMascots({ plan: p, result: result([stage("quality-bridge", { kind: "composite", blockingViolations: 9 }), stage("quality-bridge.trivy")]) });
  for (const d of s.domains.filter((d) => ["dependencies", "infrastructure"].includes(d.domain))) {
    assert.equal(d.status, "passed"); assert.deepEqual(d.progress, { completed: 1, total: 1 });
  }
});
test("completion without evidence is neutral, untrusted evidence stays incomplete", () => {
  const p = plan([item("a#lint")]);
  assert.equal(quality({ plan: p, result: result([{ id: "a#lint", state: "completed" }]) }).status, "finished");
  assert.equal(quality({ plan: p, result: result([stage("a#lint", { selfReported: true })], { policy: { trustSelfReported: false } }) }).status, "incomplete");
  assert.equal(quality({ plan: p, result: result([stage("a#lint", { interpreted: false })]) }).status, "incomplete");
});
test("cancel request keeps active animation and final cancellation preserves completed domains", () => {
  const p = plan([item("a#lint"), item("b#unit", "tests")]);
  const events = [event(1, "step-started", { step: "b" }), event(2, "cancel-requested")];
  const live = projectMascots({ plan: p, result: result([stage("a#lint")], { partial: true }), running: true, events });
  assert.equal(live.cancelling, true); assert.equal(live.domains.find((d) => d.domain === "tests").status, "processing");
  const final = projectMascots({ plan: p, result: result([stage("a#lint"), stage("b#unit", { state: "cancelled" })], { decision: "cancelled" }) });
  assert.equal(final.domains[0].status, "passed"); assert.equal(final.domains.find((d) => d.domain === "tests").status, "cancelled");
});
test("snapshot is independent of event pagination and duplicate/foreign replay", () => {
  const p = plan([item("a#lint")]);
  const events = [event(1, "step-started", { step: "a" }), event(601, "step-finished", { step: "a" }), event(602, "stage", { stageId: "a#lint", state: "completed", step: "a" })];
  const input = { plan: p, runId: "run_A", result: result([stage("a#lint")]), events };
  assert.deepEqual(projectMascots(input), projectMascots({ ...input, events: [...events].reverse().concat(events, event(999, "step-started", { step: "a" }, "old")) }));
});
test("orphan, legacy missing evidence, n/a and reduced scope remain explicit", () => {
  const p = plan([item("a#lint")]);
  assert.equal(quality({ plan: p, runId: "run_A", orphan: true }).status, "incomplete");
  const legacy = projectMascots({ plan: null, result: result([stage("a#lint")]) });
  assert.equal(legacy.evidenceUnavailable, true); assert.equal(legacy.domains[0].status, "incomplete");
  assert.equal(quality({ plan: p, result: result([stage("a#lint", { state: "not_applicable" })]) }).status, "not_applicable");
  const reduced = projectMascots({ plan: p, result: result([stage("a#lint")], { reduced: true }) });
  assert.equal(reduced.reduced, true); assert.equal(reduced.domains[0].status, "passed");
});
test("waived findings never trigger partial alerts; nonblocking findings remain warnings", () => {
  const input = { plan: plan([item("a#lint")]), result: result([stage("a#lint")], { findings: [ { stageId: "a#lint", blocking: true, waived: true }, { stageId: "a#lint", blocking: false, waived: false } ] }) };
  const q = quality(input); assert.equal(q.status, "passed"); assert.equal(q.hasFindings, false); assert.equal(q.hasWarnings, true);
});
test("operational errors retain distinct statuses and closed counts without inventing success", () => {
  for (const state of ["error", "timeout", "blocked", "cancelled"]) {
    const q = quality({ plan: plan([item("a#lint")]), result: result([stage("a#lint", { state })]) });
    assert.equal(q.status, state); assert.deepEqual(q.progress, { completed: 1, total: 1 });
  }
  const skipped = quality({ plan: plan([item("a#lint")]), runId: "run_A", running: true, events: [
    event(1, "stage", { step: "a", stageId: "a#lint", state: "blocked", reason: "Stopped by fail-fast after the previous check failed" }),
    event(2, "step-skipped", { step: "a", cause: "fail-fast" }),
  ] });
  assert.equal(skipped.status, "blocked"); assert.match(skipped.checks[0].reason, /fail-fast/);
});
