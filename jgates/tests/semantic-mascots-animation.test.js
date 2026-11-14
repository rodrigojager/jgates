import { test } from "node:test";
import assert from "node:assert/strict";

// The state animations of the six Semantic mascots (ui/src/mascots/semantic/actor.js), without a browser: every state
// of every mascot gives finite poses, a state other than "working" comes to rest in a pose that depends on the state
// alone (but for the compass that lost north), nothing jumps when the state changes, and each mascot acts its own phase
// with its own object. Verdict and Seal have two variants each; the first of the catalog is the one shown.

// The compass letters and the report title are drawn on a canvas; the poses do not need the drawing.
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: (_, key) => (key === "measureText" ? () => ({ width: 10 }) : () => {}), set: () => true }) }) };

const { SemanticActor, SETTLE_SECONDS } = await import("../ui/src/mascots/semantic/actor.js");
const { SEMANTIC_MASCOT_IDS: IDS, SEMANTIC_MASCOT_STATES: STATES, SEMANTIC_MASCOT_MODELS: MODELS } = await import("../ui/src/mascots/semantic/catalog.js");

/** Every mascot in every variant it has: [id, variant or undefined]. */
const BUILDS = IDS.flatMap((id) => (MODELS[id].variants ?? [undefined]).map((variant) => [id, variant]));
const make = (id, variant, options = {}) => new SemanticActor(id, { ...options, ...(variant ? { variant } : {}) });
const restless = (id, state) => id === "atlas" && state === "failed";
const advance = (actor, seconds, dt = 1 / 60) => { for (let t = 0; t < seconds; t += dt) actor.update(dt); };
/** The numbers of a pose, flattened, without the clocks. `fast: false` leaves out what moves fast on purpose. */
function pose(actor, { fast = true } = {}) {
  const { age: _age, work: _work, animating: _animating, ...rest } = actor.inspect();
  if (!fast) { delete rest.needle; delete rest.strike; }
  const numbers = [];
  JSON.stringify(rest, (_, value) => { if (typeof value === "number") numbers.push(value); return value; });
  return numbers;
}
const distance = (a, b) => Math.max(...a.map((n, i) => Math.abs(n - b[i])));

test("every mascot and variant gives finite poses in every state, with arched eyes when done and worried brows when failed", () => {
  assert.deepEqual(BUILDS.map(([id, v]) => `${id}${v ? `:${v}` : ""}`), ["atlas", "trace", "verdict:scales", "verdict:weigh", "fit", "seal:armless", "seal:arms", "folio"]);
  for (const [id, variant] of BUILDS) {
    const actor = make(id, variant);
    assert.equal(actor.inspect().variant, variant);
    for (const state of STATES) {
      actor.setState(state); advance(actor, 2.2);
      assert.equal(actor.inspect().state, state);
      assert.ok(actor.inspect().finite, `${id}/${state}`);
      assert.ok(pose(actor).every(Number.isFinite), `${id}/${state}`);
    }
    actor.setState("done"); advance(actor, 2.5); assert.ok(actor.inspect().expression.happy > .95, id);
    actor.setState("failed"); advance(actor, 1.5); assert.ok(actor.inspect().expression.worried > .95, id);
    assert.throws(() => actor.setState("passed"), /Unknown Semantic mascot state/);
    actor.dispose(); assert.throws(() => actor.setState("working"));
  }
  assert.throws(() => new SemanticActor("quality"), /Unknown Semantic mascot/);
  assert.throws(() => new SemanticActor("verdict", { variant: "armless" }), /Unknown variant/);
  // The default Seal has no arms; the other variant has the two of the family.
  assert.equal(make("seal").inspect().hands.length, 0);
  assert.equal(make("seal", "arms").inspect().hands.length, 2);
  assert.equal(make("verdict").inspect().variant, "scales");
});

test("working animates without end; any other state plays a reaction and then holds a pose that depends on the state alone", () => {
  for (const [id, variant] of BUILDS) {
    for (const state of STATES.filter((s) => s !== "working" && s !== "waiting" && !restless(id, s))) {
      // Reached from the middle of the work...
      const played = make(id, variant, { state: "working" }); advance(played, 3.7);
      assert.equal(played.animating, true, `${id}: working animates`);
      played.setState(state);
      assert.equal(played.animating, true, `${id}/${state}: the reaction animates`);
      advance(played, SETTLE_SECONDS + .1);
      assert.equal(played.animating, false, `${id}/${state}: the reaction ends`);
      // ...or shown as it is, the pose is the same.
      const shown = make(id, variant, { state });
      assert.equal(shown.animating, false);
      assert.ok(distance(pose(played), pose(shown)) < 1e-6, `${id}/${state}: ${distance(pose(played), pose(shown))}`);
      const settled = make(id, variant, { state: "working" }); advance(settled, 1.3); settled.setState(state, { settled: true });
      assert.equal(settled.animating, false);
      assert.ok(distance(pose(settled), pose(shown)) < 1e-6, `${id}/${state} settled`);
      const still = pose(played); advance(played, 1); assert.deepEqual(pose(played), still, `${id}/${state}: nothing moves afterwards`);
    }
    const working = make(id, variant, { state: "working" }); advance(working, 30);
    assert.equal(working.animating, true);
    const before = pose(working); advance(working, .4);
    assert.ok(distance(pose(working), before) > .003, `${id}: the work moves`);
  }
});

test("the compass that lost north never stops spinning, at a speed that keeps changing", () => {
  const atlas = make("atlas", undefined, { state: "failed" });
  assert.equal(atlas.animating, true, "also when it is first shown in that state");
  const speeds = [];
  let previous = atlas.inspect().needle;
  for (let second = 0; second < 30; second++) { advance(atlas, 1); const now = atlas.inspect().needle; speeds.push(now - previous); previous = now; }
  assert.equal(atlas.animating, true);
  assert.ok(previous > 100, "it went around many times");
  assert.ok(Math.max(...speeds) - Math.min(...speeds) > 3, "now faster, now slower");
  atlas.setState("done"); advance(atlas, SETTLE_SECONDS + .1);
  assert.ok(Math.abs(atlas.inspect().needle) < 1e-6, "and comes back to north from where it pointed, without unwinding");
  assert.equal(atlas.animating, false);
});

test("reduced motion shows a still pose for every state", () => {
  for (const [id, variant] of BUILDS) for (const state of STATES) {
    const actor = make(id, variant, { state, reducedMotion: true });
    assert.equal(actor.animating, false);
    const before = pose(actor); advance(actor, 2);
    assert.deepEqual(pose(actor), before, `${id}/${state}`);
    actor.setState(state === "done" ? "failed" : "done"); advance(actor, .1);
    assert.equal(actor.animating, false);
  }
});

test("no piece jumps when the state changes at any moment of the work", () => {
  const dt = 1 / 60;
  for (const [id, variant] of BUILDS) for (const state of STATES.filter((s) => s !== "working")) for (const at of [.9, 2.3, 3.5, 5.1, 9.2]) {
    const actor = make(id, variant, { state: "working" }); advance(actor, at, dt);
    let previous = pose(actor, { fast: false }), widest = 0;
    actor.setState(state);
    for (let frame = 0; frame < 90; frame++) { actor.update(dt); const now = pose(actor, { fast: false }); widest = Math.max(widest, distance(now, previous)); previous = now; }
    // Left out: the compass needle, which turns fast on purpose, and the ring of a strike, which appears at the impact.
    // The fastest of the rest is a strike coming down (the stamp, or the gavel tipping onto the block): under a
    // quarter of a unit a frame.
    assert.ok(widest < .25, `${id}${variant ? `:${variant}` : ""} working→${state} at ${at}s: ${widest}`);
    actor.setState("working"); previous = pose(actor, { fast: false }); widest = 0;
    for (let frame = 0; frame < 60; frame++) { actor.update(dt); const now = pose(actor, { fast: false }); widest = Math.max(widest, distance(now, previous)); previous = now; }
    assert.ok(widest < .25, `${id}${variant ? `:${variant}` : ""} ${state}→working: ${widest}`);
  }
});

test("each mascot acts its phase: the final poses tell the outcome", () => {
  const settle = (id, state, variant) => make(id, variant, { state }).inspect();
  // Atlas: north found when done, off north when incomplete.
  assert.ok(Math.abs(settle("atlas", "done").needle) < 1e-6);
  assert.ok(Math.abs(settle("atlas", "incomplete").needle) > .5);
  // Trace: the head hangs to one side when the trail was lost.
  assert.ok(settle("trace", "incomplete").head < -.05);
  assert.ok(Math.abs(settle("trace", "done").head) < 1e-6);
  // Verdict with its balance: after the verdict it stays as it struck (beside the block, its head down on it) with the
  // balance level under both loads; one pan down with the candidate alone when incomplete, hanging to one side and empty
  // when failed, empty and level while waiting.
  const verdict = (state) => { const v = settle("verdict", state); return { rock: v.rock, beam: v.beam, tokens: v.tokens, stand: v.stand }; };
  assert.ok(Math.abs(verdict("done").rock + .72) < 1e-6 && Math.abs(verdict("done").stand + .88) < 1e-9 && verdict("done").beam === 0); assert.deepEqual(verdict("done").tokens, [1, 1]);
  assert.equal(verdict("waiting").stand, 0, "on the block otherwise");
  assert.ok(verdict("incomplete").beam > .2); assert.deepEqual(verdict("incomplete").tokens, [1, 0]);
  assert.ok(verdict("failed").beam < -.4 && verdict("failed").rock < -.2); assert.deepEqual(verdict("failed").tokens, [0, 0]);
  assert.ok(Math.abs(verdict("waiting").beam) < .04, "it only sways a little"); assert.deepEqual(verdict("waiting").tokens, [0, 0]);
  // The other Verdict: upright after the last strike, still leaning without a verdict, askew when it failed.
  assert.ok(Math.abs(settle("verdict", "done", "weigh").rock) < 1e-6);
  assert.ok(settle("verdict", "incomplete", "weigh").rock > .1);
  assert.ok(settle("verdict", "failed", "weigh").rock < -.2);
  // Fit: every socket holds its record when done; one seated and one half modelled when incomplete; the finished
  // square jammed at the triangular socket when failed; a mass with no shape on the hand while waiting.
  assert.deepEqual(settle("fit", "done").records.map((r) => [r.scale, r.blend]), [[.86, 1], [.86, 1], [.86, 1]]);
  assert.deepEqual(settle("fit", "incomplete").records.map((r) => [r.scale, r.blend]), [[.86, 1], [1, .5], [0, 0]]);
  const jammed = settle("fit", "failed").records;
  assert.deepEqual(jammed.map((r) => r.scale), [.9, 0, 0]);
  assert.ok(jammed[0].blend === 1 && jammed[0].x === 0 && jammed[0].z > .45, "the square record stays outside the triangular socket");
  assert.deepEqual(settle("fit", "waiting").records.map((r) => [r.scale, r.blend]), [[1, 0], [0, 0], [0, 0]]);
  // Seal: three marks when done, one when incomplete, the refusal mark alone when failed, a blank receipt while waiting.
  assert.deepEqual([settle("seal", "done").marks, settle("seal", "done").refusal], [[1, 1, 1], 0]);
  assert.deepEqual(settle("seal", "incomplete").marks, [1, 0, 0]);
  assert.deepEqual([settle("seal", "failed").marks, settle("seal", "failed").refusal], [[0, 0, 0], 1]);
  assert.deepEqual(settle("seal", "waiting").marks, [0, 0, 0]);
  // Folio: the whole report when done, half of it when incomplete, a collapsed chart when failed, an empty page waiting.
  assert.deepEqual([settle("folio", "done").lines, settle("folio", "done").bars], [[1, 1], [1, 1, 1]]);
  assert.deepEqual([settle("folio", "incomplete").lines, settle("folio", "incomplete").bars], [[1, .35], [1, .45, 0]]);
  assert.ok(settle("folio", "failed").bars.every((b) => Math.abs(b - .1) < 1e-9));
  assert.deepEqual([settle("folio", "waiting").lines, settle("folio", "waiting").bars], [[0, 0], [0, 0, 0]]);
  // The brain: currents on its tracks while working and only then; lit after success, dark after a failure or a
  // cancellation.
  for (const id of IDS) {
    assert.ok(settle(id, "done").brain > .4, id);
    assert.equal(settle(id, "done").currents, 0, id);
    assert.equal(settle(id, "cancelled").brain, 0, id);
    const working = make(id, undefined, { state: "working" }); advance(working, 1.5);
    assert.ok(working.inspect().brain > .2 && working.inspect().currents > .9, id);
    working.setState("failed"); advance(working, SETTLE_SECONDS + .1);
    assert.ok(working.inspect().brain < .01 && working.inspect().currents < .01, id);
  }
});

test("the work of each mascot goes through its cycle", () => {
  // Atlas looks for north: the needle goes to one side and the other, never more than 20 degrees from it.
  const atlas = make("atlas", undefined, { state: "working" });
  const bearings = [];
  for (let i = 0; i < 400; i++) { advance(atlas, .1); bearings.push(atlas.inspect().needle); }
  assert.ok(Math.max(...bearings.map(Math.abs)) <= Math.PI / 9 + 1e-9, "at most 20 degrees");
  assert.ok(Math.min(...bearings) < -.15 && Math.max(...bearings) > .15, "to both sides");
  assert.ok(new Set(bearings.map((b) => Math.round(b * 50))).size > 12, "at many different angles");
  // After each swing the needle overshoots a little and quivers to rest: around a stop it passes its target both ways.
  const swing = make("atlas", undefined, { state: "working" });
  const trace = [];
  for (let i = 0; i < 1500; i++) { swing.update(1 / 60); trace.push(swing.inspect().needle); }
  let turns = 0;
  for (let i = 2; i < trace.length; i++) if ((trace[i] - trace[i - 1]) * (trace[i - 1] - trace[i - 2]) < 0) turns++;
  assert.ok(turns > 30, `the needle quivers (${turns} changes of direction in 25 s)`);
  // Fit: no two masses in a row look the same (each is turned another way about the depth axis).
  const masses = make("fit", undefined, { state: "working" });
  const outline = () => { const p = masses.rig.parts.records.find((r) => r.visible).geometry.attributes.position; return [p.getX(7), p.getY(7), p.getX(200), p.getY(200)].map((n) => Math.round(n * 1000)); };
  advance(masses, .6); const first = outline();
  advance(masses, 4.2); const second = outline();
  assert.notDeepEqual(second, first);
  // Fit models each record in three pats (a third of the way to its shape at each), seats it, and starts again after three.
  const fit = make("fit", undefined, { state: "working" });
  advance(fit, .8); assert.equal(fit.inspect().records[0].blend, 0, "it arrives as a mass with no shape");
  advance(fit, .7); assert.ok(Math.abs(fit.inspect().records[0].blend - 1 / 3) < .03, "first pat");
  advance(fit, .6); assert.ok(Math.abs(fit.inspect().records[0].blend - 2 / 3) < .03, "second pat");
  advance(fit, .6); assert.ok(fit.inspect().records[0].blend > .99, "third pat");
  advance(fit, 1.3); assert.ok(fit.inspect().records[0].z < .3 && fit.inspect().records[1].scale === 0, "the first record is seated");
  advance(fit, 8.4); assert.deepEqual(fit.inspect().records.map((r) => r.scale > .8), [true, true, true]);
  advance(fit, .95); assert.ok(fit.inspect().records[2].scale < .1, "the batch leaves and a new one starts");
  // Verdict: the candidate tips the balance, the evidence swings it back, and it comes to rest level.
  const verdict = make("verdict", undefined, { state: "working" });
  advance(verdict, 1.3); assert.ok(verdict.inspect().tokens[0] > .8 && verdict.inspect().tokens[1] === 0 && verdict.inspect().beam > .15, "one pan down");
  advance(verdict, 1.0); assert.ok(verdict.inspect().tokens[1] > .8, "the evidence is on the other pan");
  advance(verdict, 2.2); assert.ok(Math.abs(verdict.inspect().beam) < .08, "level");
  // When it is done it leaps off the block, comes down turning about its foot until the whole face of its head is flat
  // on the block (a quarter turn), and then lets itself down to rest leaning on the block.
  verdict.setState("done");
  advance(verdict, .6); assert.ok(verdict.inspect().stand < -1.3 && verdict.inspect().rock < -.2 && verdict.inspect().rock > -.4, "in the air beside the block, already tipping");
  advance(verdict, .32); assert.ok(Math.abs(verdict.inspect().rock + Math.PI / 2) < .06 && verdict.inspect().strike > .3, "flat on the block, and the strike rings");
  advance(verdict, 4); assert.ok(Math.abs(verdict.inspect().rock + .72) < 1e-6 && Math.abs(verdict.inspect().stand + .88) < 1e-6 && verdict.inspect().strike === 0, "and there it rests");
  // The other Verdict leans to one side, to the other, and leaves the block to strike it.
  const weigher = make("verdict", "weigh", { state: "working" });
  advance(weigher, 1.0); assert.ok(weigher.inspect().rock > .15);
  advance(weigher, 1.4); assert.ok(weigher.inspect().rock < -.15);
  advance(weigher, 1.1); assert.ok(weigher.inspect().hop > .15, "in the air");
  advance(weigher, .3); assert.ok(weigher.inspect().hop === 0 && weigher.inspect().strike > .2, "the strike rings");
  // Seal: a mark per strike.
  const seal = make("seal", undefined, { state: "working" });
  advance(seal, .45); assert.ok(seal.inspect().lift > .4, "lifted before the strike");
  advance(seal, .6); assert.ok(seal.inspect().lift === 0 && seal.inspect().marks[0] > .8 && seal.inspect().marks[1] === 0);
  advance(seal, 2.2); assert.ok(seal.inspect().marks.every((m) => m > .8));
  // Folio writes the two lines, then raises the bars.
  const folio = make("folio", undefined, { state: "working" });
  advance(folio, 1.0); assert.ok(folio.inspect().lines[0] > .95 && folio.inspect().lines[1] < .05 && folio.inspect().bars[0] < .05);
  advance(folio, 3.0); assert.ok(folio.inspect().lines[1] > .95 && folio.inspect().bars.every((b) => b > .9));
});

test("no arm goes through the body it belongs to, in any state, at any moment", async () => {
  const { Vector3 } = await import("three");
  // The solid of each body in the space its arms live in: how deep a point is inside it (negative outside).
  const solids = {
    compass: (p) => Math.min(.89 - Math.hypot(p.x, p.y - .02), p.z + .22, .30 - p.z),
    "shape-sorter": (p) => Math.min(.86 - Math.abs(p.x), .78 - Math.abs(p.y), p.z + .47, .43 - p.z),
    folio: (p) => Math.min(.74 - Math.abs(p.x), .94 - Math.abs(p.y), p.z + .13, .16 - p.z),
    gavel: (p) => Math.max(Math.min(.15 - Math.hypot(p.x, p.z), p.y - .10, .90 - p.y), Math.min(.345 - Math.hypot(p.y - 1.342, p.z), .82 - Math.abs(p.x))),
    stamp: (p) => Math.max(Math.min(.72 - Math.abs(p.x), p.y + .89, -.48 - p.y, p.z + .44, .46 - p.z), Math.min(.40 - Math.hypot(p.x, p.z), p.y + .5, .80 - p.y)),
  };
  const point = new Vector3();
  for (const [id, variant] of BUILDS) for (const from of ["waiting", "working"]) for (const state of STATES) {
    const actor = make(id, variant, { state: from }); advance(actor, 3, 1 / 30);
    actor.setState(state);
    const solid = solids[actor.shape];
    for (let t = 0; t < (state === "working" ? 15 : 5); t += 1 / 30) {
      actor.update(1 / 30);
      for (const arm of actor.rig.arms) {
        // The first quarter of the hose is the shoulder, which is sunk in the body. The axis of the rest may graze a
        // corner (the hose is .09 thick), never go into it.
        for (let k = 5; k <= 20; k++) assert.ok(solid(arm.curve.getPoint(k / 20, point)) < .02, `${id}${variant ? `:${variant}` : ""} ${from}→${state} at ${t.toFixed(2)}s: the arm is ${solid(point).toFixed(3)} inside the body`);
      }
    }
  }
});
