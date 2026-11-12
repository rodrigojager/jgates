import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// V2-76: the six static 3D Semantic mascots replace the four SVG characters.
//   - the stage-to-mascot mapping gives one mascot per phase of the Cloudflare method (reconnaissance Atlas, coverage-led
//     hunting Trace, candidate validation Verdict, structured output Fit, independent verification Seal, target-neutral
//     reporting Folio), with the real module's stages;
//   - stages of the other methods (general review, a module nobody listed) land on the closest phase;
//   - the four old role ids of stored runs (scout, tracker, challenger, verifier) resolve to a phase mascot, in the core
//     and in the UI catalog, and the core and the UI agree on the six ids;
//   - the mascot source is in the product (no build dependency on the study folder), with only the shortlisted models,
//     the satin vinyl mode and the clear brain capsule; each mascot has its pre-rendered fallback image; the SVG module
//     is gone.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(root, "jgates", "dist");
const uiMascots = path.join(root, "jgates", "ui", "src", "mascots", "semantic");
const core = await import(pathToFileURL(path.join(dist, "core", "semantic-mascots", "index.js")).href);
const cloudflare = await import(pathToFileURL(path.join(dist, "core", "semantic-modules", "cloudflare", "index.js")).href);
const executor = await import(pathToFileURL(path.join(dist, "core", "semantic-executor", "index.js")).href);
const catalog = await import(pathToFileURL(path.join(uiMascots, "catalog.js")).href);

const SIX = ["atlas", "trace", "verdict", "fit", "seal", "folio"];

test("V2-76: one mascot per Cloudflare phase, other methods on the closest phase, old role ids resolve", () => {
  assert.deepEqual([...core.SEMANTIC_MASCOTS], SIX);
  assert.deepEqual([...catalog.SEMANTIC_MASCOT_IDS], SIX, "the UI catalog and the core agree");
  assert.deepEqual(SIX.map((m) => core.SEMANTIC_MASCOT_GROUPS[m].phase), ["reconnaissance", "coverage-led-hunting", "candidate-validation", "structured-output", "independent-verification", "reporting"]);

  // The six phases, by their stage ids (the two host phases have their own ids when a module names them).
  const phase = { reconnaissance: "atlas", hunting: "trace", refutation: "verdict", "structured-output": "fit", verification: "seal", reporting: "folio" };
  for (const [id, mascot] of Object.entries(phase)) assert.equal(core.mascotForStage({ id: `security-audit/${id}` }), mascot, id);
  // The real Cloudflare module: planning belongs to reconnaissance and the coverage critic to the hunting wave.
  const S = cloudflare.SECURITY_AUDIT_STAGES;
  const expected = { [S.recon]: "atlas", [S.plan]: "atlas", [S.hunt]: "trace", [S.critic]: "trace", [S.refute]: "verdict", [S.verify]: "seal" };
  for (const s of cloudflare.securityAuditModule().stages) assert.equal(core.mascotForStage({ id: `security-audit/${s.id}`, role: s.role, verify: s.verify }), expected[s.id], s.id);

  // General review and the context/review steps: the same rules as the four roles had.
  assert.deepEqual(executor.INVESTIGATION_MODULE.stages.map((s) => core.mascotForStage(s)), ["trace", "verdict"]);
  assert.equal(core.mascotForStage({ id: "semantic-context" }), "atlas");
  assert.equal(core.mascotForStage({ id: "semantic-review" }), "trace");
  // Stage ids nobody listed: by role and by the closest phase.
  const closest = {
    "scope-mapping": "atlas", "threat-analysis": "atlas", "deep-dive": "trace", "x-explore": "trace",
    "adversarial-pass": "verdict", "candidate-triage": "verdict", "schema-shaping": "fit", "format-records": "fit",
    "fresh-verify": "seal", "final-summary": "folio", "write-report": "folio",
  };
  for (const [id, mascot] of Object.entries(closest)) assert.equal(core.mascotForStage({ id: `other/${id}` }), mascot, id);
  assert.equal(core.mascotForStage({ id: "x-1", role: "validate" }), "verdict");
  assert.equal(core.mascotForStage({ id: "x-2", role: "explore" }), "trace");
  assert.equal(core.mascotForStage({ id: "x-3", role: "validate", verify: true }), "seal");

  // Old role ids of stored runs.
  const legacy = { scout: "atlas", tracker: "trace", challenger: "verdict", verifier: "seal" };
  for (const [old, now] of Object.entries(legacy)) {
    assert.equal(core.resolveSemanticMascot(old), now, `core: ${old}`);
    assert.equal(catalog.resolveSemanticMascot(old), now, `ui: ${old}`);
  }
  for (const id of SIX) assert.equal(core.resolveSemanticMascot(id), id);
  assert.equal(core.resolveSemanticMascot("quality"), null);
  assert.equal(catalog.resolveSemanticMascot("toString"), null);
});

test("V2-76: a full Cloudflare run shows the six phases done; the host phases follow the run", () => {
  const S = cloudflare.SECURITY_AUDIT_STAGES;
  const stage = (id, state) => ({ id: `security-audit/${id}`, state, required: true });
  const by = (snap) => Object.fromEntries(snap.mascots.map((m) => [m.mascot, m.state]));
  const done = core.projectSemanticMascots({ stages: Object.values(S).map((id) => stage(id, "completed")) });
  assert.deepEqual(done.mascots.map((m) => m.mascot), SIX);
  assert.deepEqual(by(done), Object.fromEntries(SIX.map((m) => [m, "done"])));
  // Running: the host phases wait for the model stages.
  const running = core.projectSemanticMascots({ running: true, stages: [stage(S.recon, "completed"), stage(S.plan, "completed"), stage(S.hunt, "running"), stage(S.critic, "pending")] });
  assert.deepEqual(by(running), { atlas: "done", trace: "working", verdict: "waiting", fit: "waiting", seal: "waiting", folio: "waiting" });
  // Settled with a stage short: the records and the report are incomplete, never done.
  const short = core.projectSemanticMascots({ stages: [stage(S.recon, "completed"), stage(S.plan, "completed"), stage(S.hunt, "completed"), stage(S.critic, "completed"), stage(S.refute, "budget-exhausted"), stage(S.verify, "not-run")] });
  assert.deepEqual(by(short), { atlas: "done", trace: "done", verdict: "incomplete", fit: "incomplete", seal: "incomplete", folio: "incomplete" });
  // A general review has no verification: Seal is incomplete, the host phases are done.
  const general = core.projectSemanticMascots({ stages: [{ id: "semantic-context", state: "completed" }, { id: "bounded-investigation/hunt", state: "completed", role: "explore" }, { id: "bounded-investigation/validate", state: "completed", role: "validate" }] });
  assert.deepEqual(by(general), { atlas: "done", trace: "done", verdict: "done", fit: "done", seal: "incomplete", folio: "done" });
  // Cancelled: nothing done, nothing waiting.
  const cancelled = core.projectSemanticMascots({ cancelled: true, running: true, stages: [stage(S.recon, "completed"), stage(S.hunt, "running")] });
  assert.deepEqual(by(cancelled), { atlas: "incomplete", trace: "cancelled", verdict: "cancelled", fit: "cancelled", seal: "cancelled", folio: "cancelled" });
});

test("V2-76: the mascot source is in the product with only the shipped models, appearance and construction", () => {
  const files = fs.readdirSync(uiMascots, { recursive: true }).map(String);
  const sources = files.filter((f) => /\.(js|ts|tsx|css)$/.test(f)).map((f) => [f, fs.readFileSync(path.join(uiMascots, f), "utf8")]);
  for (const [file, text] of sources) {
    assert.ok(!/mascotes-v2|[A-Z]:[\\/]/.test(text), `${file}: no path to the study folder or any drive`);
    assert.ok(!/\b(servo|automaton|hybrid|clay|silhouette|setMaterialMode|setProcess)\b/.test(text), `${file}: no other construction, appearance mode or fitting sequence`);
    assert.ok(!/renderSemanticMascotSvg|SEMANTIC_MASCOT_CSS|<svg class="sem-mascot/.test(text), `${file}: the SVG module is gone`);
  }
  const objects = fs.readFileSync(path.join(uiMascots, "objects.js"), "utf8");
  const shapes = [...objects.matchAll(/case '([\w-]+)':/g)].map((m) => m[1]).sort();
  assert.deepEqual(shapes, Object.values(catalog.SEMANTIC_MASCOT_MODELS).map((m) => m.shape).sort(), "only the shortlisted anatomies are built");
  assert.deepEqual(Object.values(catalog.SEMANTIC_MASCOT_MODELS).map((m) => m.study), ["01A", "02A", "03B", "04A", "05C", "06A"]);
  const indicators = fs.readFileSync(path.join(uiMascots, "indicators.js"), "utf8");
  assert.match(indicators, /clear-protective-capsule/);
  const models = fs.readFileSync(path.join(uiMascots, "models.js"), "utf8");
  assert.match(models, /createCapsule/);
  assert.ok(!fs.existsSync(path.join(uiMascots, "index.js")), "the SVG module file is removed");
  // Satin vinyl: the family material (roughness .32, clearcoat .48) of the shared helpers, imported from the product's copy.
  const geometry = fs.readFileSync(path.join(root, "jgates", "ui", "src", "mascots", "actors", "geometry.js"), "utf8");
  assert.match(geometry, /roughness: \.32, metalness: 0, clearcoat: \.48/);
  for (const [file, text] of sources) for (const m of text.matchAll(/from '(\.\.?\/[^']+)'/g)) assert.ok(fs.existsSync(path.resolve(uiMascots, path.dirname(file), m[1])), `${file}: ${m[1]} is in the product`);

  // One pre-rendered WebP per mascot, of a real size.
  for (const id of SIX) {
    const url = catalog.SEMANTIC_MASCOT_FALLBACKS[id];
    const file = fileURLToPath(url);
    assert.equal(path.dirname(file), path.join(uiMascots, "fallback"));
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "RIFF", `${id}: a RIFF container`);
    assert.equal(bytes.subarray(8, 12).toString("latin1"), "WEBP", `${id}: a WebP image`);
    assert.ok(bytes.length > 2000, `${id}: not an empty image`);
  }
  // Nothing in the UI or the core still renders the SVG characters.
  const uiSrc = path.join(root, "jgates", "ui", "src");
  const offenders = [];
  for (const f of fs.readdirSync(uiSrc, { recursive: true }).map(String).filter((f) => /\.(tsx?|js)$/.test(f))) {
    if (/renderSemanticMascotSvg|semanticMascotLabel|SEMANTIC_MASCOT_CSS|mascots\/semantic\/index/.test(fs.readFileSync(path.join(uiSrc, f), "utf8"))) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});
