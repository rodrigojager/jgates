import test from "node:test";
import assert from "node:assert/strict";
import { SEMANTIC_MASCOTS, mascotForStage, projectSemanticMascots } from "../dist/core/semantic-mascots/index.js";
import { MASCOT_DOMAINS } from "../dist/core/mascots/index.js";
import { INVESTIGATION_MODULE } from "../dist/core/semantic-executor/index.js";
import { SECURITY_AUDIT_STAGES, securityAuditModule } from "../dist/core/semantic-modules/cloudflare/index.js";
import { registeredInvestigationModules } from "../dist/core/semantic-modules/index.js";
import { SEMANTIC_MASCOT_IDS, SEMANTIC_MASCOT_STATES, SEMANTIC_MASCOT_CSS, renderSemanticMascotSvg, semanticMascotLabel } from "../ui/src/mascots/semantic/index.js";

const stage = (id, state, extra = {}) => ({ id, state, required: true, ...extra });

test("every Cloudflare phase and general-review stage maps to exactly one AI mascot, never a Quality domain", () => {
  const ids = Object.values(SECURITY_AUDIT_STAGES);
  const expected = { reconnaissance: "scout", "coverage-planning": "scout", hunting: "tracker", "coverage-critic": "challenger", refutation: "challenger", verification: "verifier" };
  assert.deepEqual(Object.fromEntries(ids.map((id) => [id, mascotForStage({ id })])), expected);
  // the real module stages, with their roles and module prefix
  for (const s of securityAuditModule().stages) assert.equal(mascotForStage({ id: `security-audit/${s.id}`, role: s.role, verify: s.verify }), expected[s.id]);
  // general review: the built-in investigation module and the T13 steps
  assert.deepEqual(INVESTIGATION_MODULE.stages.map((s) => mascotForStage(s)), ["tracker", "challenger"]);
  assert.equal(mascotForStage({ id: "semantic-context" }), "scout");
  assert.equal(mascotForStage({ id: "semantic-review" }), "tracker");
  // a stage id nobody listed still lands on exactly one mascot, by role
  assert.equal(mascotForStage({ id: "x-1", role: "validate" }), "challenger");
  assert.equal(mascotForStage({ id: "x-2", role: "explore" }), "tracker");
  assert.equal(mascotForStage({ id: "x-3", role: "validate", verify: true }), "verifier");
  for (const entry of registeredInvestigationModules()) assert.ok(entry.methodId);
  // projection exposes only AI mascots
  const snap = projectSemanticMascots({ stages: ids.map((id) => stage(id, "completed")) });
  assert.deepEqual(snap.mascots.map((m) => m.mascot), [...SEMANTIC_MASCOTS]);
  assert.equal(snap.mascots.flatMap((m) => m.stages).length, ids.length);
  assert.ok(!SEMANTIC_MASCOTS.some((m) => MASCOT_DOMAINS.includes(m)));
  assert.deepEqual([...SEMANTIC_MASCOT_IDS], [...SEMANTIC_MASCOTS]);
  assert.ok(!JSON.stringify(snap).match(new RegExp(`"(${MASCOT_DOMAINS.join("|")})"`)));
});

test("states are truthful: waiting, working, done, incomplete, failed", () => {
  const ids = Object.values(SECURITY_AUDIT_STAGES);
  const by = (stages, opts = {}) => Object.fromEntries(projectSemanticMascots({ stages, ...opts }).mascots.map((m) => [m.mascot, m.state]));
  assert.deepEqual(by(ids.map((id) => stage(id, "completed"))), { scout: "done", tracker: "done", challenger: "done", verifier: "done" });
  const mid = by([stage("reconnaissance", "completed"), stage("coverage-planning", "completed"), stage("hunting", "running"), stage("coverage-critic", "pending"), stage("refutation", "pending"), stage("verification", "pending")], { running: true });
  assert.deepEqual(mid, { scout: "done", tracker: "working", challenger: "waiting", verifier: "waiting" });
  // one of two scout stages done and the other queued: working, not done
  assert.equal(by([stage("reconnaissance", "completed"), stage("coverage-planning", "pending")], { running: true }).scout, "working");
  // budget out / not run is incomplete, an invalid stage failed
  const end = by([stage("hunting", "budget-exhausted"), stage("refutation", "invalid"), stage("verification", "not-run")]);
  assert.equal(end.tracker, "incomplete"); assert.equal(end.challenger, "failed"); assert.equal(end.verifier, "incomplete");
  // a run that is no longer running never leaves a mascot waiting or working
  const stale = by([stage("hunting", "running"), stage("refutation", "pending")], { running: false });
  assert.equal(stale.tracker, "incomplete"); assert.equal(stale.challenger, "incomplete");
  // no stage reported at all: incomplete, not done
  assert.equal(by([]).scout, "incomplete");
});

test("a cancelled run never shows a mascot as done", () => {
  const ids = Object.values(SECURITY_AUDIT_STAGES);
  const snap = projectSemanticMascots({ cancelled: true, running: true, stages: ids.map((id) => stage(id, "completed")) });
  assert.ok(snap.mascots.every((m) => m.state !== "done" && m.state !== "working" && m.state !== "waiting"));
  assert.equal(snap.running, false);
  const part = projectSemanticMascots({ cancelled: true, stages: [stage("reconnaissance", "completed"), stage("hunting", "running"), stage("refutation", "pending")] });
  assert.deepEqual(Object.fromEntries(part.mascots.map((m) => [m.mascot, m.state])), { scout: "incomplete", tracker: "cancelled", challenger: "cancelled", verifier: "cancelled" });
});

test("each SVG has role img, a label per state in en and pt-BR, and stops animating under reduced motion", () => {
  const seen = new Set();
  for (const mascot of SEMANTIC_MASCOT_IDS) for (const state of SEMANTIC_MASCOT_STATES) for (const locale of ["en", "pt-BR"]) {
    const svg = renderSemanticMascotSvg({ mascot, state, locale });
    const label = semanticMascotLabel(mascot, state, locale);
    assert.match(svg, /^<svg [^>]*role="img"/);
    assert.ok(svg.includes(`aria-label="${label}"`) && svg.includes(`<title>${label}</title>`));
    assert.ok(svg.includes('viewBox="0 0 64 64"'));
    seen.add(`${locale}|${label}`);
  }
  assert.equal(seen.size, SEMANTIC_MASCOT_IDS.length * SEMANTIC_MASCOT_STATES.length * 2);
  assert.throws(() => renderSemanticMascotSvg({ mascot: "quality", state: "done" }));
  assert.throws(() => renderSemanticMascotSvg({ mascot: "scout", state: "passed" }));
  // every animation is declared only for the working state and cancelled under reduced motion
  const anims = [...SEMANTIC_MASCOT_CSS.matchAll(/([^{}]+)\{animation:(?!none)/g)].map((m) => m[1]);
  assert.ok(anims.length >= 4 && anims.every((s) => s.includes('[data-state=working]')));
  assert.match(SEMANTIC_MASCOT_CSS, /@media \(prefers-reduced-motion:reduce\)\{\.sem-mascot \.m-anim\{animation:none!important\}\}/);
  // themes: colors come from theme variables, no hard-coded color outside var() fallbacks
  assert.ok(!/#[0-9a-f]{3,8}\b(?![^()]*\))/i.test(SEMANTIC_MASCOT_CSS.replace(/var\([^()]*\)/g, "")));
});
