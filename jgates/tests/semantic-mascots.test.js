import test from "node:test";
import assert from "node:assert/strict";
import { SEMANTIC_MASCOTS, mascotForStage, projectSemanticMascots } from "../dist/core/semantic-mascots/index.js";
import { MASCOT_DOMAINS } from "../dist/core/mascots/index.js";
import { SECURITY_AUDIT_STAGES } from "../dist/core/semantic-modules/cloudflare/index.js";
import { registeredInvestigationModules } from "../dist/core/semantic-modules/index.js";
import { SEMANTIC_MASCOT_IDS, SEMANTIC_MASCOT_MODELS, SEMANTIC_MASCOT_STATES } from "../ui/src/mascots/semantic/catalog.js";

const stage = (id, state, extra = {}) => ({ id, state, required: true, ...extra });

test("the projection exposes only the six AI mascots, never a Quality domain", () => {
  const ids = Object.values(SECURITY_AUDIT_STAGES);
  const snap = projectSemanticMascots({ stages: ids.map((id) => stage(id, "completed")) });
  assert.deepEqual(snap.mascots.map((m) => m.mascot), [...SEMANTIC_MASCOTS]);
  assert.equal(snap.mascots.flatMap((m) => m.stages).length, ids.length);
  assert.ok(!SEMANTIC_MASCOTS.some((m) => MASCOT_DOMAINS.includes(m)));
  assert.deepEqual([...SEMANTIC_MASCOT_IDS], [...SEMANTIC_MASCOTS]);
  assert.deepEqual(Object.keys(SEMANTIC_MASCOT_MODELS), [...SEMANTIC_MASCOTS]);
  assert.deepEqual([...SEMANTIC_MASCOT_STATES], ["waiting", "working", "done", "incomplete", "failed", "cancelled"]);
  assert.ok(!JSON.stringify(snap).match(new RegExp(`"(${MASCOT_DOMAINS.join("|")})"`)));
  for (const entry of registeredInvestigationModules()) assert.ok(entry.methodId);
  for (const s of registeredInvestigationModules().flatMap((e) => e.module?.stages ?? [])) assert.ok(SEMANTIC_MASCOTS.includes(mascotForStage(s)));
});

test("states are truthful: waiting, working, done, incomplete, failed", () => {
  const S = SECURITY_AUDIT_STAGES;
  const by = (stages, opts = {}) => Object.fromEntries(projectSemanticMascots({ stages, ...opts }).mascots.map((m) => [m.mascot, m.state]));
  const mid = by([stage(S.recon, "completed"), stage(S.plan, "completed"), stage(S.hunt, "running"), stage(S.critic, "pending"), stage(S.refute, "pending"), stage(S.verify, "pending")], { running: true });
  assert.deepEqual(mid, { atlas: "done", trace: "working", verdict: "waiting", fit: "waiting", seal: "waiting", folio: "waiting" });
  // one of two Atlas stages done and the other queued: working, not done
  assert.equal(by([stage(S.recon, "completed"), stage(S.plan, "pending")], { running: true }).atlas, "working");
  // budget out / not run is incomplete, an invalid stage failed
  const end = by([stage(S.hunt, "budget-exhausted"), stage(S.refute, "invalid"), stage(S.verify, "not-run")]);
  assert.equal(end.trace, "incomplete"); assert.equal(end.verdict, "failed"); assert.equal(end.seal, "incomplete");
  assert.equal(end.fit, "incomplete"); assert.equal(end.folio, "incomplete");
  // a run that is no longer running never leaves a mascot waiting or working
  const stale = by([stage(S.hunt, "running"), stage(S.refute, "pending")], { running: false });
  assert.equal(stale.trace, "incomplete"); assert.equal(stale.verdict, "incomplete");
  // no stage reported at all: incomplete, not done, the host phases included
  assert.deepEqual(new Set(Object.values(by([]))), new Set(["incomplete"]));
});

test("a cancelled run never shows a mascot as done", () => {
  const ids = Object.values(SECURITY_AUDIT_STAGES);
  const snap = projectSemanticMascots({ cancelled: true, running: true, stages: ids.map((id) => stage(id, "completed")) });
  assert.ok(snap.mascots.every((m) => m.state !== "done" && m.state !== "working" && m.state !== "waiting"));
  assert.equal(snap.running, false);
  const part = projectSemanticMascots({ cancelled: true, stages: [stage("reconnaissance", "completed"), stage("hunting", "running"), stage("refutation", "pending")] });
  assert.deepEqual(Object.fromEntries(part.mascots.map((m) => [m.mascot, m.state])), { atlas: "incomplete", trace: "cancelled", verdict: "cancelled", fit: "cancelled", seal: "cancelled", folio: "cancelled" });
});
