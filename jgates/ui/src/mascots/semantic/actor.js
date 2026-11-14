import * as THREE from 'three';
import { Spring, clamp, mix, smooth, smoother, pulse, mod } from '../actors/motion.js';
import { V, disposeTree } from '../actors/geometry.js';
import { SEMANTIC_MASCOT_IDS, SEMANTIC_MASCOT_MODELS, SEMANTIC_MASCOT_STATES } from './catalog.js';
import { createModel } from './models.js';
import { SORTER_SOCKETS, shapeRecord } from './objects.js';

// The state animations of the six Semantic mascots. They speak the language of the Quality mascots (../actors): eased
// phases and damped springs, never a linear move; anticipation before a strike and settling after it; a small hop and
// arched eyes for success, a recoil and worried brows for failure, a lean and a half-closed eye for doubt. What each one
// does while it works is its phase of the audit, acted with its own object:
//   Atlas (compass)   looks for north: the needle swings a little to one side and the other, never far from it.
//   Trace (serpent)   hunts: the lens sways along a trail, darts at a find and the rattle shakes.
//   Verdict (gavel)   holds a balance and weighs a candidate against the evidence until the beam is level
//                     (the other variant: it weighs with its palms and strikes the sound block).
//   Fit (sorter)      takes a mass with no shape, models it with three pats into the shape of a socket and seats it there.
//   Seal (stamp)      stamps one approval mark after another along the receipt.
//   Folio (clipboard) writes the lines of the report and raises the bars of its chart.
// While a mascot works, currents run along the tracks of the brain in the capsule, each track at its own speed and some
// against the others, on a clock that all the mascots of a page share.
//
// A state other than "working" plays a reaction of a few seconds and then holds a pose that depends on the state alone,
// so the picture of a settled mascot is always the same and needs no animation loop. The one exception is Atlas after a
// failure, whose needle never stops spinning. Reduced motion shows the still pose (for "working", one moment of the
// action) and nothing moves.

/** Seconds after which the reaction of a state is over. */
export const SETTLE_SECONDS = 4.5;

const HOP = { compass: .34, 'shape-sorter': .30, folio: .22 };
/** The moment of the working action shown when nothing may move. */
const KEY_MOMENT = { compass: 1.1, lenscoil: 1.0, gavel: 1.3, 'shape-sorter': 1.9, stamp: .3, folio: 3.4 };
const RECORD_HOME = [1.10, -.13, .87], RECORD_BENCH = [.12, -.42, .92];
/** How each new mass is turned about the depth axis, one after the other: no two in a row look the same. */
const MASS_SPINS = [0, 2.2, 4.1, 1.2, 5.3, 3.3];
const STAMP_LIFT = .42;
/**
 * The strike of the gavel with its own head. It leaps off the block to where a hand would hold a gavel (`air`: its
 * foot level with the face of the head on the block), already tipping (`lean`), and comes down turning about its
 * foot, so the head travels the arc of a gavel in a hand and its whole face lands flat on the block (`flat`). Then
 * it relaxes: the foot drops to the ground beside the block (`foot`) and it stays leaning on the block, head down
 * (`rest`). The picture is only so wide: the balance is carried in front of the body (`carry`) meanwhile.
 */
const STRIKE = { air: [-1.34, -.065], lean: -.25, flat: -Math.PI / 2, foot: [-.88, -1.08], rest: -.72, carry: [-.25, .20, .50] };

/** 0 to 1 between a and b, slow at both ends. */
const ramp = (t, a, b) => smoother((t - a) / (b - a));
/** 0 to 1 and back to 0 between a and b. */
const bell = (t, a, b) => Math.sin(clamp((t - a) / (b - a)) * Math.PI);
const lerp3 = (a, b, u) => a.map((n, i) => mix(n, b[i], u));
const wrapAngle = a => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
const UP = new THREE.Vector3(0, 1, 0), AXIS = new THREE.Vector3();
/** How Folio holds its pencil: the direction of its body from the point, and where the hand grips it (from the point). */
const PENCIL_AXIS = new THREE.Vector3(.50, .78, .38).normalize().toArray();
const GRIP = PENCIL_AXIS.map((n, axis) => n * .20 + [0, -.03, .04][axis]);

// The swings of the compass needle while Atlas works: each to a side and an angle taken from a fixed scramble (the same
// on every run, never a random number per frame), at most 20 degrees from north, each with its own duration and followed by a small quiver, as a needle on its pivot.
const scramble = n => { const v = Math.sin(n * 12.9898 + 4.1) * 43758.5453; return v - Math.floor(v); };
const SWINGS = Array.from({ length: 13 }, (_, k) => ({ angle: (scramble(k * 2) < .5 ? -1 : 1) * (.06 + .24 * scramble(k * 2 + 1)), time: .9 + .9 * scramble(k * 3 + 7) }));
const SWING_CYCLE = SWINGS.reduce((sum, s) => sum + s.time, 0);
function needleBearing(work) {
  let t = mod(work, SWING_CYCLE);
  for (let k = 0; k < SWINGS.length; k++) {
    const swing = SWINGS[k];
    if (t < swing.time) {
      const from = SWINGS[(k + SWINGS.length - 1) % SWINGS.length].angle, move = swing.time * .6, since = t - move;
      if (since < 0) return mix(from, swing.angle, smoother(t / move));
      // Arrived: it overshoots a little and quivers to rest before the next swing.
      return swing.angle + (swing.angle - from) * .10 * Math.exp(-5.5 * since) * Math.sin(20 * since) * (1 - smooth(since / (swing.time - move)));
    }
    t -= swing.time;
  }
  return 0;
}

/** Lets the serpent's neck follow the head: two morph targets (sideways, forward) that leave the coil on the ground. */
function bendNeck(meshes) {
  for (const m of meshes) {
    const pos = m.geometry.attributes.position, side = new Float32Array(pos.count * 3), forward = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const weight = smooth((y + .98) / .88) * (1 - smooth((Math.hypot(x + .15, z - .05) - .45) / .30));
      side[i * 3] = weight; forward[i * 3 + 2] = weight;
    }
    m.geometry.morphAttributes.position = [new THREE.BufferAttribute(side, 3), new THREE.BufferAttribute(forward, 3)];
    m.geometry.morphTargetsRelative = true; m.updateMorphTargets();
  }
}

/** One Semantic mascot and its state. No rendering, DOM or network: `update(dt)` moves the model in `object`. */
export class SemanticActor {
  constructor(id, { state = 'waiting', reducedMotion = false, variant } = {}) {
    const spec = SEMANTIC_MASCOT_MODELS[id];
    if (!spec) throw new TypeError(`Unknown Semantic mascot: ${id}`);
    if (!SEMANTIC_MASCOT_STATES.includes(state)) throw new TypeError(`Unknown Semantic mascot state: ${state}`);
    if (variant !== undefined && !spec.variants?.includes(variant)) throw new TypeError(`Unknown variant of ${id}: ${variant}`);
    this.id = id; this.shape = spec.shape; this.object = createModel(spec, { variant }); this.rig = this.object.userData.rig;
    this.state = state; this.reducedMotion = reducedMotion; this.disposed = false;
    this.time = 0; this.work = 0; this.age = SETTLE_SECONDS;
    this.springs = new Map(); this.out = {}; this.entry = {}; this.snapNext = true;
    // Each mascot breathes and blinks on its own beat; the brains run on the shared clock of update.
    this.phase = SEMANTIC_MASCOT_IDS.indexOf(id) * .73;
    this.glow = new THREE.Color(spec.color); this.spark = this.glow.clone().lerp(new THREE.Color('#ffffff'), .6); this.alarm = new THREE.Color('#ff4a3d');
    if (this.shape === 'lenscoil') { bendNeck(this.rig.parts.neck); this.rattleRest = this.rig.parts.rattle.quaternion.clone(); }
    this.update(0);
  }

  /** A state whose animation has no end besides "working": the compass that lost north keeps spinning. */
  get restless() { return this.shape === 'compass' && this.state === 'failed'; }
  /** True while the picture changes from frame to frame. */
  get animating() {
    return !this.disposed && !this.reducedMotion && (this.state === 'working' || this.restless || this.age < SETTLE_SECONDS);
  }

  /** Enters a state and plays its reaction; `settled` shows the state as it is once the reaction is over. */
  setState(state, { settled = false } = {}) {
    if (this.disposed) throw new Error('Semantic mascot was disposed');
    if (!SEMANTIC_MASCOT_STATES.includes(state)) throw new TypeError(`Unknown Semantic mascot state: ${state}`);
    if (state !== this.state) {
      this.state = state; this.age = 0; this.entry = { ...this.out };
      if (state === 'working') this.work = 0; // the action starts from its beginning
      // An angle that went around more than once continues from where it points, not from how far it turned.
      for (const [key, spring] of this.springs) if (/^turn\d$/.test(key) || (key === 'needle' && Math.abs(spring.value) > 4)) { spring.snap(wrapAngle(spring.value)); this.entry[key] = spring.value; }
    }
    if (settled) { this.age = SETTLE_SECONDS; this.snapNext = true; this.update(0); }
    return this;
  }
  /** Plays the reaction of the current state again. */
  replay() { this.age = 0; this.entry = { ...this.out }; return this; }
  setReducedMotion(enabled) { this.reducedMotion = !!enabled; this.snapNext = true; this.update(0); return this; }

  /**
   * A value that follows `target`: through a damped spring, or exactly (`direct`, for a timed phase that is already
   * eased). Either way it starts from where the previous state left it, so no piece jumps when the state changes.
   */
  value(key, target, f, { direct = false, k = 135, c = 20 } = {}) {
    let s = this.springs.get(key);
    if (!s) { s = new Spring(target, k, c); this.springs.set(key, s); }
    let v;
    if (this.snap) v = s.snap(target);
    else if (direct) v = s.snap(f.age < .3 && key in this.entry ? mix(this.entry[key], target, smooth(f.age / .3)) : target);
    else v = s.step(target, f.dt);
    this.out[key] = v;
    return v;
  }

  update(delta = 0, clock) {
    if (this.disposed) return;
    const still = this.reducedMotion, dt = still ? 0 : Math.min(Math.max(delta, 0), .05);
    this.time += dt; this.age += dt;
    const state = this.state, working = state === 'working', waiting = state === 'waiting';
    if (working) this.work += dt;
    const settled = still || (!working && !waiting && !this.restless && this.age >= SETTLE_SECONDS);
    this.snap = this.snapNext || settled; this.snapNext = false;
    const r = this.rig, alive = !still && (working || waiting);
    const f = {
      dt, state, working, waiting, still, done: state === 'done', incomplete: state === 'incomplete', failed: state === 'failed', cancelled: state === 'cancelled',
      t: still ? 1.2 : this.time, age: settled ? SETTLE_SECONDS : this.age, work: still ? KEY_MOMENT[this.shape] : this.work,
      clock: still ? 1.2 : clock ?? this.time,
      breath: alive ? Math.sin(this.time * 1.7 + this.phase) * .018 : 0,
      gazeX: 0, gazeY: 0, bodyY: 0, lean: 0, pitch: 0, yaw: 0, hands: [null, null], gesture: 1,
    };
    f.celebrate = f.done && f.age < 1.04 ? Math.max(0, Math.sin(clamp((f.age - .16) / .88) * Math.PI)) : 0;
    f.recoil = f.failed ? pulse(f.age, .18, .17) : 0;

    this[this.shape](f);

    // Body: the mascots that stand on boots breathe, hop and lean as a whole; the others act through their own piece.
    if (r.feet.length) {
      r.body.position.y = this.value('bodyY', r.baseY + f.breath + f.bodyY + f.celebrate * HOP[this.shape] - f.recoil * .075 - (f.cancelled ? .06 : 0), f, { k: 150, c: 18 });
      r.body.rotation.z = this.value('lean', f.incomplete ? -.105 : f.failed ? -.055 : f.cancelled ? .045 : f.lean, f, { k: 95, c: 17 });
      r.body.rotation.x = this.value('pitch', (f.failed ? .055 : 0) - f.recoil * .1 + f.pitch, f);
      r.body.rotation.y = this.value('yaw', f.yaw, f, { k: 40, c: 11 });
      const motion = this.springs.get('bodyY');
      const elastic = this.value('squash', clamp(motion.acceleration * -.005 + f.recoil * .22 + (f.celebrate > .01 ? -.10 : f.done ? pulse(f.age, 1.08, .13) * .16 : 0), -.26, .32), f, { k: 160, c: 14 });
      r.body.scale.set(1 + elastic * .045, 1 - elastic * .065, 1 + elastic * .025);
      r.feet.forEach((foot, i) => {
        foot.position.y = .20 + this.value(`foot${i}`, f.celebrate * (i ? .16 : .10), f);
        foot.rotation.z = this.value(`footTurn${i}`, f.done ? (i ? -.06 : .06) : 0, f);
      });
    }

    // Hands: what the action asked for, or the family's gesture for the state on the hand that is free (the same
    // gestures as the Quality mascots: raised for success, held up for doubt, half raised for trouble, low at rest).
    // The arm is a hose that arcs from the shoulder to the hand (sculpt.js); `lift` is for a hand that comes down on
    // something.
    r.arms.forEach((a, i) => {
      let hand = f.hands[i];
      if (!hand) {
        const [x, y, z] = a.rest, free = i === f.gesture && !working && !waiting;
        if (free && f.done) hand = { at: [x * 1.04, y + 1.05 + f.celebrate * .23, z + .04] };
        else if (free && f.incomplete) hand = { at: [x * .92, y + .95, z + .04] };
        else if (free && f.failed) hand = { at: [x * 1.02, y + .46, z + .08] };
        else if (f.cancelled) hand = { at: [x * .96, y - .03, z + .03] };
        else hand = { at: a.rest };
      }
      const at = hand.at.map((n, axis) => this.value(`hand${i}-${axis}`, n, f, { direct: hand.direct, k: 230, c: 27 }));
      a.reach(...at, { lift: clamp(this.value(`lift${i}`, hand.lift ?? 0, f, { k: 110, c: 20 })), straight: clamp(this.value(`stretch${i}`, hand.straight ?? 0, f, { direct: hand.direct })) });
    });
    if (this.shape === 'folio') this.holdPencil();
    if (r.legs.length) {
      this.object.updateMatrixWorld(true);
      r.legs.forEach((leg, i) => {
        const top = this.object.worldToLocal(r.body.localToWorld(leg.top.clone()));
        leg.segment.set(V(leg.x, r.feet[i].position.y + .07, .03), top);
      });
    }

    // Face: gaze, blink, arched eyes for success, brows for trouble, a half-closed eye for doubt.
    const face = r.face;
    face.group.position.x = face.baseX + this.value('gazeX', f.gazeX + (f.incomplete ? -.035 : 0), f, { k: 90, c: 18 });
    face.group.position.y = face.baseY + this.value('gazeY', f.gazeY + (f.failed ? -.035 : f.cancelled ? -.025 : 0), f);
    const blink = alive ? 1 - pulse(mod(this.time + this.phase, 4.6), .28, .075) * .94 : 1;
    const happy = this.value('happy', f.done ? 1 : 0, f, { k: 100, c: 18 });
    const worried = this.value('worried', f.failed ? 1 : f.incomplete ? .65 : 0, f);
    face.eyes.forEach((eye, i) => {
      const open = f.cancelled ? .48 : f.incomplete && i === 0 ? .68 : 1;
      eye.scale.y = Math.max(.04, blink * open * (1 - happy * .94));
      eye.rotation.z = (i ? -1 : 1) * worried * .19;
      face.happy[i].material.opacity = happy;
      face.brows[i].material.opacity = worried * .9;
      face.brows[i].rotation.z = (i ? -1 : 1) * .37 * worried;
    });

    // Brain: currents on the tracks while it thinks; a steady glow once done; three slow sparks (under three flashes a
    // second) and dark when it failed.
    const thinking = still ? .58 : .50 + .16 * Math.sin(f.clock * 3.4);
    const sparks = f.failed && f.age < 1.2 ? .9 * Math.abs(Math.sin(f.age * 8)) * (1 - ramp(f.age, .5, 1.2)) : 0;
    const power = this.value('brain', working ? thinking : f.done ? .45 : f.incomplete ? .18 : f.failed ? sparks : waiting && !still ? .08 + .05 * Math.sin(f.clock * 1.2) : waiting ? .08 : 0, f, { direct: working || sparks > 0, k: 90, c: 16 });
    const tint = sparks > 0 ? this.alarm : this.glow;
    for (const [material, gain] of [[r.brain.substrate, .85], [r.brain.track, .9], [r.brain.pad, 1.4]]) { material.emissive.copy(tint); material.emissiveIntensity = power * gain; }
    const current = r.brain.current;
    current.time.value = f.clock;
    current.power.value = this.value('currents', working ? 1 : 0, f, { k: 60, c: 14 });
    current.color.value.copy(this.spark);
    this.power = power;
    this.object.updateMatrixWorld(true);
  }

  /** Atlas looks for north: the needle swings a little to one side and the other, never far from it. */
  compass(f) {
    const { needle } = this.rig.parts;
    let target, direct = false;
    if (f.working) { direct = true; target = needleBearing(f.work); }
    else if (f.done) target = 0; // north found: the needle swings home and settles
    else if (f.incomplete) target = .9 + Math.sin(f.age * 5.2) * .26 * (1 - ramp(f.age, 1.0, 2.8)); // wavers, then stops off north
    else if (f.failed) { direct = true; target = f.still ? 2.4 : 8 * this.age + 3.2 * Math.sin(1.1 * this.age) + 1.3 * Math.sin(2.9 * this.age + .7); } // lost: it spins without end like a haunted compass, now racing, now almost stopping
    else if (f.cancelled) target = -.35;
    else target = f.still ? 0 : Math.sin(f.t * .9 + this.phase) * .06;
    const angle = this.value('needle', target, f, { direct, k: 38, c: 5.2 });
    needle.rotation.z = angle;
    if (f.working) { f.yaw = -Math.sin(angle) * .10; f.gazeX = -Math.sin(angle) * .05; f.gazeY = -.02; }
    this.detail = { needle: angle };
  }

  /** Trace hunts: the lens sways along a trail, darts at a find and the rattle shakes. */
  lenscoil(f) {
    const { head, neck, rattle, glint, joint } = this.rig.parts;
    let x = 0, z = 0, tilt = 0, pitch = 0, yaw = 0, shake = 0, glintX = 0, shine = 0;
    if (f.working) {
      const w = f.work, c = mod(w, 3.2), dart = pulse(c, 2.55, .17);
      x = Math.sin(w * 1.15) * .19; tilt = -Math.sin(w * 1.15 - .6) * .15; yaw = Math.sin(w * 1.15 - .3) * .26;
      z = .04 + .15 * dart; pitch = .05 + .20 * dart; shake = pulse(c, 2.78, .26);
      const sweep = mod(w / 2.1, 1); glintX = mix(-.30, .30, smooth(sweep)); shine = Math.sin(sweep * Math.PI) * .5;
      f.gazeX = Math.sin(w * 1.15 - .3) * .05; f.gazeY = -.03 * dart;
    } else if (f.done) { // a proud nod, a flash across the lens and a shake of the rattle
      pitch = .22 * bell(f.age, .25, 1.0); shake = pulse(f.age, .8, .3);
      glintX = mix(-.30, .30, ramp(f.age, .3, 1.3)); shine = bell(f.age, .3, 1.3) * .7;
    } else if (f.incomplete) { x = -.07; tilt = -.24; } // the head tilts: the trail was lost
    else if (f.failed) { // rears back, then hangs its head
      z = -.15 * pulse(f.age, .22, .18) + .08 * ramp(f.age, .5, 1.4); pitch = .24 * ramp(f.age, .5, 1.5); x = .05;
      shake = .5 * (1 - ramp(f.age, .3, 2.0));
    } else if (f.cancelled) { pitch = .12; z = .03; }
    else if (!f.still) { x = Math.sin(f.t * .8 + this.phase) * .035; tilt = -x * .5; }
    // The head turns where the lens meets the neck, so the two stay joined whatever the pose.
    const sx = this.value('neckX', x, f, { k: 60, c: 11 }), sz = this.value('neckZ', z, f, { k: 60, c: 11 });
    head.position.set(sx, joint, sz);
    head.rotation.set(this.value('headPitch', pitch, f, { k: 60, c: 11 }), this.value('headYaw', yaw, f, { k: 60, c: 11 }), this.value('headTilt', tilt, f, { k: 50, c: 10 }));
    for (const m of neck) { m.morphTargetInfluences[0] = sx; m.morphTargetInfluences[1] = sz; }
    const rattling = this.value('rattle', shake, f, { k: 200, c: 24 });
    rattle.quaternion.copy(this.rattleRest).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.sin(f.t * 44) * .30 * rattling));
    glint.position.x = glintX; glint.material.opacity = this.value('glint', shine, f, { direct: true });
    this.detail = { head: sx, rattle: rattling };
  }

  gavel(f) { return this.rig.variant === 'scales' ? this.balance(f) : this.weigh(f); }

  /** The ring a strike sends across the sound block, `since` seconds after the blow (negative: none). */
  ring(since) {
    const { shock } = this.rig.parts, wave = since >= 0 ? clamp(since / .55) : 1;
    shock.scale.setScalar(mix(.45, 1.3, 1 - (1 - wave) ** 2)); shock.material.opacity = .85 * (1 - wave) ** 2;
    return shock.material.opacity;
  }

  /**
   * Verdict holds a balance like a torch. A candidate lands on one pan, the evidence against it on the other, and the
   * beam swings less and less until it is level: the verdict. When the phase is done it gives the verdict as a gavel
   * does: it leaps, strikes the block with the whole face of its head, and stays leaning on the block (STRIKE).
   */
  balance(f) {
    const { rocker, balance } = this.rig.parts, [holder, free] = this.rig.arms;
    let tip = 0, rock = 0, shown = [0, 0], swing = 0, blow = -1, lower = 0, crouch = 0, place = [0, -.75];
    if (f.working) {
      const c = mod(f.work, 5.4);
      shown = [c >= .3 && c < 4.7 ? 1 : 0, c >= 1.6 && c < 4.7 ? 1 : 0];
      tip = c < .3 ? 0 : c < 1.6 ? .34 : c < 2.6 ? -.14 : 0; // the candidate weighs, the evidence outweighs it, then they settle
      rock = .05 * bell(c, 4.15, 4.6); // a nod once it is level
    } else if (f.done) {
      shown = [1, 1];
      // A crouch, the leap (leaning back at first, then tipping), the blow about the foot, faster and faster, the
      // whole face on the block with a small rebound, and then it lets itself down to rest.
      const a = f.age, leap = clamp((a - .18) / .44), since = a - .88, ease = ramp(a, 1.02, 1.62);
      const up = 1 - (1 - leap) ** 2;
      place = [mix(mix(0, STRIKE.air[0], smooth(leap)), STRIKE.foot[0], ease), mix(mix(-.75, STRIKE.air[1], up), STRIKE.foot[1], ease) + .05 * Math.sin(Math.PI * ease)];
      swing = a < .62 ? STRIKE.lean * smooth(leap) + .10 * Math.sin(Math.PI * clamp(leap * 2))
        : a < .88 ? mix(STRIKE.lean, STRIKE.flat, ((a - .62) / .26) ** 2)
        : mix(STRIKE.flat + .05 * Math.exp(-9 * since) * Math.abs(Math.sin(16 * since)), STRIKE.rest, ease);
      rock = 0; crouch = bell(a, 0, .24) * .08; blow = since;
    } else if (f.incomplete) { shown = [1, 0]; tip = .26; rock = .10; } // one pan still down: no verdict
    else if (f.failed) { // the beam swings wildly and hangs to one side; what was on the pans is gone
      const calm = ramp(f.age, .9, 1.4);
      tip = .5 * Math.sin(f.age * 9) * (1 - calm) - .5 * calm; rock = -.22 + .10 * Math.exp(-3 * f.age) * Math.sin(f.age * 11);
    } else if (f.cancelled) { rock = .04; lower = .10; }
    else if (!f.still) tip = Math.sin(f.t * 1.1 + this.phase) * .03;
    const beam = this.value('beam', tip, f, { k: 26, c: 2.6 });
    const tilt = this.value('rock', rock - beam * (f.working ? .3 : 0), f, { k: 120, c: 16 }) + this.value('swing', swing, f, { direct: true });
    const squash = this.value('gavelSquash', crouch + (blow >= 0 ? pulse(blow, .03, .06) * .14 : 0) + f.recoil * .12, f, { k: 260, c: 22 });
    rocker.rotation.z = tilt;
    rocker.scale.set(1 + squash * .5, 1 - squash, 1 + squash * .5);
    rocker.position.set(this.value('standX', place[0], f, { direct: true }), this.value('standY', place[1], f, { direct: true }), 0);
    const strike = this.ring(blow);
    // The balance obeys gravity, not the hand: the beam is as level as its load, and the pans hang straight down.
    const grip = (f.done ? STRIKE.carry : [holder.rest[0], holder.rest[1] - lower, holder.rest[2]]).map((n, axis) => this.value(`grip${axis}`, n, f, { k: 90, c: 17 }));
    f.hands[0] = { at: grip, direct: true }; // the mitt under the post
    balance.root.position.set(grip[0], grip[1] + .12, grip[2]);
    balance.beam.rotation.z = beam - tilt;
    balance.pans.forEach(pan => { pan.rotation.z = -beam; });
    const sizes = balance.tokens.map((token, i) => {
      const size = this.value(`token${i}`, shown[i], f, { k: 210, c: 13 });
      token.visible = size > .02; token.scale.setScalar(Math.max(size, .001));
      return size;
    });
    // The other hand steadies the air beside the balance.
    const [fx, fy, fz] = free.rest;
    if (f.working) f.hands[1] = { at: [fx + .22, fy + .36 + beam * .5, fz + .10] };
    else if (f.done) f.hands[1] = { at: f.age > 1.3 ? [.30, .69, .32] : free.rest }; // it comes to rest on the block, beside the head
    else if (f.incomplete) f.hands[1] = { at: [fx + .16, fy + .62, fz + .04] };
    else if (f.failed) f.hands[1] = { at: [fx + .22, fy + .52, fz + .08] };
    f.gazeX = f.working || f.incomplete ? -.05 : 0; f.gazeY = f.working ? beam * .12 : 0;
    this.detail = { rock: tilt, beam, tokens: sizes, stand: rocker.position.x, strike };
  }

  /** The other Verdict: it weighs one side, then the other, with its palms, and hops to strike the sound block. */
  weigh(f) {
    const { rocker } = this.rig.parts;
    let rock = 0, c = -1; // c: the time inside a strike (crouch at 3.0, off the block at 3.3, back on it at 3.72)
    if (f.working) { c = mod(f.work, 4.4); rock = .20 * (ramp(c, 0, .5) - 2 * ramp(c, 1.3, 1.9) + ramp(c, 2.6, 3.05)); }
    else if (f.done) c = Math.min(f.age + 3.0, 4.4); // one last strike closes the case
    else if (f.incomplete) rock = .16; // still leaning to one side: no verdict
    else if (f.failed) rock = -.24 + .10 * Math.exp(-3 * f.age) * Math.sin(f.age * 11); // knocked askew
    else if (f.cancelled) rock = .05;
    else if (!f.still) rock = Math.sin(f.t * .9 + this.phase) * .012;
    const u = (c - 3.3) / .42, hop = c >= 0 && u > 0 && u < 1 ? .26 * 4 * u * (1 - u) : 0;
    const crouch = c >= 0 ? bell(c, 3.0, 3.34) : 0, hit = c >= 0 ? pulse(c, 3.77, .06) : 0;
    const tilt = this.value('rock', rock, f, { k: 120, c: 16 });
    const squash = this.value('gavelSquash', crouch * .07 + hit * .16 + f.recoil * .12, f, { k: 260, c: 22 });
    rocker.rotation.z = tilt;
    rocker.scale.set(1 + squash * .5, 1 - squash, 1 + squash * .5);
    const air = this.value('gavelHop', hop, f, { direct: true });
    rocker.position.set(0, -.75 + air, 0);
    const strike = this.ring(c >= 3.72 ? c - 3.72 : -1);
    // "On one hand... on the other hand": the palm on the side it leans to rises.
    const weight = [clamp(tilt / .2), clamp(-tilt / .2)];
    if (f.incomplete) weight[0] = .8;
    this.rig.arms.forEach((a, i) => {
      const [x, y, z] = a.rest, w = f.failed || f.cancelled ? 0 : weight[i];
      f.hands[i] = { at: [x + a.side * .26 * w, y + .62 * w + air * .4, z + .08 * w] };
    });
    if (f.done && f.age > .75) f.hands[1] = { at: [.82, .92, .30] };
    if (f.failed) f.hands[1] = { at: [.62, .62, .34] };
    f.gazeX = -tilt * .25;
    this.detail = { rock: tilt, hop: air, strike };
  }

  /** Fit takes a mass with no shape, models it with three pats into the shape of a socket and seats it there. */
  'shape-sorter'(f) {
    const { records } = this.rig.parts, [patter, carrier] = this.rig.arms;
    const seat = k => [SORTER_SOCKETS[k].x, SORTER_SOCKETS[k].y, .25];
    const hidden = { at: RECORD_HOME, scale: 0, blend: 0, turn: 0 }, seated = k => ({ at: seat(k), scale: .86, blend: 1, turn: 0 });
    let poses, held = -1, direct = false, press = 0, patting = 0;
    if (f.working) {
      direct = true;
      const c = mod(f.work, 13.5);
      poses = records.map((_, k) => {
        const s = c - 4.2 * k, leaving = 1 - ramp(c, 12.6 + k * .1, 13.2 + k * .1);
        if (s < 0) return hidden;
        if (s >= 3.7) return { ...seated(k), scale: .86 * leaving };
        // Appears on the hand as a mass, is brought to the front, takes its shape in three pats (a third of the way
        // at each), travels in an arc to its socket and is pushed in.
        const carry = ramp(s, 2.6, 3.3), push = smooth((s - 3.3) / .40);
        const at = lerp3(lerp3(RECORD_HOME, RECORD_BENCH, ramp(s, .4, .9)), [SORTER_SOCKETS[k].x, SORTER_SOCKETS[k].y, .80], carry);
        at[1] += .22 * Math.sin(carry * Math.PI); at[2] = mix(at[2], .25, push);
        held = k;
        press = Math.max(bell(s, 1.05, 1.45), bell(s, 1.65, 2.05), bell(s, 2.25, 2.65));
        patting = ramp(s, .85, 1.05) * (1 - ramp(s, 2.6, 2.85));
        return { at, scale: smoother(s / .4) * mix(1, .86, carry), blend: (ramp(s, 1.1, 1.4) + ramp(s, 1.7, 2.0) + ramp(s, 2.3, 2.6)) / 3, turn: 0, spin: MASS_SPINS[(Math.floor(f.work / 13.5) * 3 + k) % MASS_SPINS.length] };
      });
      f.bodyY = .05 * bell(c, 12.6, 13.3);
    } else if (f.done) poses = records.map((_, k) => seated(k)); // every socket holds its record
    else if (f.incomplete) { poses = [seated(0), { at: RECORD_HOME, scale: 1, blend: .5, turn: 0 }, hidden]; held = 1; } // one seated, one half modelled
    else if (f.failed) { // the square record does not enter the triangular socket: two knocks, and it stays jammed
      const knock = .16 * Math.abs(Math.sin(f.age * Math.PI / .42)) * (1 - ramp(f.age, .85, 1.3));
      poses = [{ at: [0, -.29, .50 + knock], scale: .9, blend: 1, turn: .35, kind: 'square' }, hidden, hidden]; held = 0;
    } else if (f.cancelled) { poses = [{ at: [1.10, -.23, .87], scale: 1, blend: 0, turn: 0 }, hidden, hidden]; held = 0; }
    else { poses = [{ at: RECORD_HOME, scale: 1, blend: 0, turn: 0 }, hidden, hidden]; held = 0; } // waiting: a mass on the hand
    const now = records.map((record, k) => {
      const pose = poses[k], options = { direct, k: 110, c: 17 };
      const at = pose.at.map((n, axis) => this.value(`record${k}-${axis}`, n, f, options));
      const scale = this.value(`recordSize${k}`, pose.scale, f, options), blend = clamp(this.value(`recordShape${k}`, pose.blend, f, options));
      const squeeze = k === held ? press : 0, size = Math.max(scale, .001);
      record.position.set(...at); record.rotation.z = this.value(`turn${k}`, pose.turn, f, options);
      record.visible = scale > .01; record.scale.set(size * (1 + .08 * squeeze), size * (1 - .16 * squeeze), size);
      shapeRecord(record, pose.kind ?? SORTER_SOCKETS[k].kind, blend, pose.spin ?? 0);
      return { at, scale, blend };
    });
    // One hand carries the record from below and stops at the face of the housing; the other pats it from above, flat,
    // and is the one that gestures.
    f.gesture = 0;
    if (held >= 0) {
      const [x, y, z] = now[held].at;
      f.hands[1] = { at: [x + .05, y - .20, Math.max(z + .03, .62)], direct: f.working && now[held].scale > .5 };
      if (patting > .001) {
        const over = [x - .03, y + .30 - .15 * press, z + .02];
        f.hands[0] = { at: lerp3(patter.rest, over, patting), lift: patting, direct: true };
      }
      f.gazeX = clamp(x * .05, -.05, .05); f.gazeY = -.03;
    } else f.hands[1] = { at: carrier.rest };
    this.detail = { records: now.map(n => ({ scale: n.scale, blend: n.blend, x: n.at[0], z: n.at[2] })) };
  }

  /** Seal stamps one approval mark after another along the receipt. */
  stamp(f) {
    const { press, marks, cross } = this.rig.parts;
    // One strike: up with a slow start, a pause at the top, down faster and faster, onto the paper at .70 s.
    const strike = s => s < 0 ? 0 : s < .42 ? STAMP_LIFT * smooth(s / .42) : s < .55 ? STAMP_LIFT : s < .70 ? STAMP_LIFT * (1 - ((s - .55) / .15) ** 2) : 0;
    let lift = 0, x = 0, tilt = 0, hit = 0, refused = 0, shown = [0, 0, 0];
    if (f.working) {
      const c = mod(f.work, 3.9), j = Math.min(2, Math.floor(c / 1.1)), s = c - j * 1.1;
      if (c < 3.3) { lift = strike(s); hit = pulse(s, .74, .06); }
      x = [-.30, 0, .30][j];
      shown = c >= 3.45 ? [0, 0, 0] : [0, 1, 2].map(k => (c >= k * 1.1 + .70 ? 1 : 0));
      f.gazeY = lift < .05 ? -.04 : 0;
    } else if (f.done) { lift = strike(f.age); hit = pulse(f.age, .74, .06); shown = [1, 1, f.age >= .70 ? 1 : 0]; } // the last mark completes the row
    else if (f.incomplete) { lift = .10; tilt = -.07; shown = [1, 0, 0]; } // hovers over a receipt with one mark
    else if (f.failed) { const s = f.age + .2; lift = strike(s); hit = pulse(s, .74, .06); refused = s >= .70 ? 1 : 0; tilt = -.05 * ramp(f.age, .6, 1.2); } // the mark it leaves is a refusal
    const breathe = f.waiting && !f.still ? Math.sin(f.t * 1.7 + this.phase) * .008 : 0;
    const height = 1 - this.value('stampSquash', hit * .14 + f.recoil * .08 - breathe, f, { k: 260, c: 22 });
    press.scale.set(1 + (1 - height) * .5, height, 1 + (1 - height) * .5);
    // The rubber face (.89 below the press's origin) stays on the paper while the press is squashed.
    press.position.set(this.value('stampX', x, f, { k: 70, c: 14 }), this.value('stampLift', lift, f, { direct: true }) - .89 * (1 - height), 0);
    press.rotation.z = this.value('stampTilt', tilt, f);
    const sizes = marks.map((mark, k) => {
      const size = this.value(`mark${k}`, shown[k], f, { k: 210, c: 13 });
      mark.visible = size > .02; mark.scale.setScalar(Math.max(size, .001));
      return size;
    });
    const refusal = this.value('refusal', refused, f, { k: 210, c: 13 });
    cross.visible = refusal > .02; cross.scale.setScalar(Math.max(refusal, .001));
    this.detail = { lift: this.out.stampLift, marks: sizes, refusal };
  }

  /**
   * Folio writes the lines of the report with its pencil and raises the bars of its chart. The hand holds the pencil:
   * the pencil is placed from where the hand really is (holdPencil, after the arms), and a line is as long as the
   * point of the pencil has travelled, so hand, pencil and writing are one movement.
   */
  folio(f) {
    const { lines, bars } = this.rig.parts;
    let written = [0, 0], raised = [0, 0, 0], direct = false, nib = null;
    if (f.working) {
      direct = true;
      const c = mod(f.work, 6.6), turned = 1 - ramp(c, 5.6, 6.2); // the page is turned and the next one starts empty
      const start = j => [lines[j].left, lines[j].mesh.position.y, .185], end = j => [lines[j].left + lines[j].width, lines[j].mesh.position.y, .185];
      const top = i => [bars[i].mesh.position.x, bars[i].floor + bars[i].height, .20];
      // Where the point of the pencil is asked to be: along the first line, across to the second, along it, then from
      // bar to bar with a small hop. Every leg is eased; the hand follows it through its spring.
      if (c < 1.0) nib = lerp3(start(0), end(0), ramp(c, .15, .92));
      else if (c < 1.9) nib = c < 1.12 ? lerp3(end(0), start(1), ramp(c, 1.0, 1.12)) : lerp3(start(1), end(1), ramp(c, 1.12, 1.72));
      else if (c < 3.6) {
        const tap = Math.min(2, Math.max(0, Math.floor((c - 2.1) / .5))), since = c - (2.1 + tap * .5);
        const before = tap === 0 ? end(1) : top(tap - 1), travel = tap === 0 ? ramp(c, 1.9, 2.1) : ramp(since, -.16, 0);
        nib = lerp3(before, top(tap), travel); nib[1] += .06 * Math.sin(Math.PI * travel);
      }
      if (c < .1) this.wrote = [0, 0];
      // A line is as long as the pencil has gone along it (never shorter again while it is being written).
      const tip = this.tip, wrote = this.wrote ??= [0, 0];
      if (tip && c >= .15 && c < 1.0) wrote[0] = Math.max(wrote[0], clamp((tip[0] - lines[0].left) / lines[0].width));
      if (c >= 1.0) wrote[0] = 1;
      if (tip && c >= 1.12 && c < 1.9) wrote[1] = Math.max(wrote[1], clamp((tip[0] - lines[1].left) / lines[1].width));
      if (c >= 1.9) wrote[1] = 1;
      written = [wrote[0] * turned, wrote[1] * turned];
      raised = bars.map((_, i) => (c >= 2.1 + i * .5 && c < 5.6 ? 1 : 0));
      f.pitch = -.07 * bell(c, 5.55, 6.25);
      if (nib) { f.hands[1] = { at: [nib[0] + GRIP[0], nib[1] + GRIP[1], nib[2] + GRIP[2]] }; f.gazeX = clamp(nib[0] * .06, -.05, .05); f.gazeY = -.03; }
    } else if (f.done) { written = [1, 1]; raised = bars.map((_, i) => 1 + .2 * bell(f.age, .3 + i * .13, .85 + i * .13)); } // the finished report: the bars cheer
    else if (f.incomplete) { written = [1, .35]; raised = [1, .45, 0]; } // a report that stops halfway
    else if (f.failed) { written = [.55, .2]; raised = bars.map((_, i) => (f.age > i * .14 ? .1 : this.out[`bar${i}`] ?? 1)); } // the chart collapses, bar after bar
    else if (f.cancelled) written = [1, 0];
    if (!f.working) this.wrote = null;
    const lengths = lines.map((line, j) => {
      const length = clamp(this.value(`line${j}`, written[j], f, { direct, k: 100, c: 18 }));
      line.mesh.visible = length > .01; line.mesh.scale.x = Math.max(length, .001); line.mesh.position.x = line.left + line.width * length / 2;
      return length;
    });
    const heights = bars.map((bar, i) => {
      const height = Math.max(0, this.value(`bar${i}`, raised[i], f, { k: 190, c: 12 }));
      bar.mesh.visible = height > .01; bar.mesh.scale.y = Math.max(height, .001); bar.mesh.position.y = bar.floor + bar.height * height / 2;
      return height;
    });
    this.writing = !!nib;
    this.pencilHeld = this.value('pencil', nib ? 1 : 0, f, { k: 160, c: 18 });
    this.detail = { lines: lengths, bars: heights, pencil: this.pencilHeld };
  }

  /** The pencil goes where the hand is: gripped a little above its point, its body rising over the hand. */
  holdPencil() {
    const { pencil } = this.rig.parts, hand = this.rig.arms[1].hand.position, held = this.pencilHeld ?? 0;
    pencil.visible = held > .02; pencil.scale.setScalar(Math.max(held, .001) * 1.25);
    pencil.position.set(hand.x - GRIP[0], hand.y - GRIP[1], hand.z - GRIP[2]);
    pencil.quaternion.setFromUnitVectors(UP, AXIS.set(...PENCIL_AXIS));
    this.tip = this.writing ? pencil.position.toArray() : null;
  }

  /** What the tests read: the state, the clocks and the pieces of the action. */
  inspect() {
    const r = this.rig;
    return { id: this.id, state: this.state, variant: r.variant, age: this.age, work: this.work, animating: this.animating, reducedMotion: this.reducedMotion,
      bodyY: r.body.position.y, brain: this.power, currents: r.brain.current.power.value, expression: { happy: this.out.happy, worried: this.out.worried },
      hands: r.arms.map(a => a.hand.position.toArray()), ...this.detail,
      finite: [...this.springs.values()].every(s => Number.isFinite(s.value) && Number.isFinite(s.velocity)) };
  }

  dispose() {
    if (this.disposed) return;
    this.object.traverse(o => { if (o.material?.map) o.material.map.dispose(); });
    disposeTree(this.object); this.object.removeFromParent(); this.disposed = true;
  }
}
