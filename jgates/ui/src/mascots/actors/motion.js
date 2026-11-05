export const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };
export const smoother = t => { t = clamp(t); return t * t * t * (t * (t * 6 - 15) + 10); };
export const pulse = (t, center, width) => Math.exp(-Math.pow((t - center) / width, 2));
export const mod = (a, b) => ((a % b) + b) % b;

/** Three synchronized flashes, then three complete ordinary inspection cycles. */
export function inspectionAlert(time, frequency = 1.7) {
  const period = 2 * Math.PI / frequency, burst = 2.15;
  const phase = mod(Math.max(0, time), burst + 3 * period);
  const alert = phase < burst;
  const flashPhase = mod(phase - .35, .6);
  const power = phase >= .35 && alert ? smooth(flashPhase / .07) * (1 - smooth((flashPhase - .32) / .10)) : 0;
  return { alert, power, phase, scanTime: Math.max(0, phase - burst) };
}

/** Recovery is a short, eased performance, with the dropped parcel on the
 * left throughout. Remaining parcels are gathered in the opposite hand. */
export function droppedParcelPose(time, starts) {
  const lerp = (a, b, u) => a.map((n, i) => mix(n, b[i], smoother(u)));
  const floor = [-1.21, .30, .83], lifted = [-1.06, 1.31, .83];
  let dropped, phase;
  if (time < .68) {
    const u = clamp(time / .68);
    dropped = [mix(starts[0][0], floor[0], smooth(u)), mix(starts[0][1], floor[1], u * u), mix(starts[0][2], floor[2], u)]; phase = 'fall';
  } else if (time < 1.80) { dropped = [...floor]; dropped[1] += .055 * pulse(time, .81, .07); phase = time < 1.5 ? 'reach' : 'grip'; }
  else if (time < 3.15) { dropped = lerp(floor, lifted, (time - 1.80) / 1.35); phase = 'lift'; }
  else { dropped = lifted; phase = 'resume'; }
  const positions = [dropped];
  for (let i = 1; i < 3; i++) {
    const held = [1.03, 1.30 + (i - 1) * .53, .80];
    positions[i] = lerp(starts[i], held, time / 1.15);
  }
  return { positions, phase };
}

export const FALLEN_PARCELS = Object.freeze([
  Object.freeze([-1.22, .28, .94]), Object.freeze([.08, .28, 1.38]), Object.freeze([1.10, .28, .70])
]);

/** Final failure releases all parcels from their actual pose and velocity.
 * Gravity, a small impact bounce, then a permanent scattered ground pose. */
export function fallenParcelPose(time, start, velocity, index) {
  const end = FALLEN_PARCELS[index], gravity = 11.5;
  const vy = clamp(velocity[1], -5, 5), height = Math.max(0, start[1] - end[1]);
  const impact = Math.max(.16, (vy + Math.sqrt(vy * vy + 2 * gravity * height)) / gravity);
  const u = clamp(time / impact), h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2;
  const position = start.map((n, axis) => axis === 1 ? Math.max(end[1], n + vy * time - gravity * time * time / 2)
    : h00 * n + h10 * impact * clamp(velocity[axis], -1.8, 1.8) + h01 * end[axis]);
  const after = time - impact;
  if (after >= 0) position[1] = end[1] + (after < .8 ? .10 * Math.exp(-6 * after) * Math.abs(Math.sin(after * 13)) : 0);
  return { position, impact, turn: smoother(time / (impact * .9)), settled: after >= .8 };
}

/** Stable substepped damped spring. State carries velocity across interruptions. */
export class Spring {
  constructor(value = 0, stiffness = 125, damping = 18) {
    this.value = value; this.velocity = 0; this.acceleration = 0;
    this.stiffness = stiffness; this.damping = damping;
  }
  step(target, delta) {
    const dt = Math.min(Math.max(delta, 0), .08);
    const count = Math.max(1, Math.ceil(dt / (1 / 240)));
    for (let i = 0; i < count; i++) {
      this.acceleration = this.stiffness * (target - this.value) - this.damping * this.velocity;
      this.velocity += this.acceleration * dt / count;
      this.value += this.velocity * dt / count;
    }
    return this.value;
  }
  snap(value) { this.value = value; this.velocity = this.acceleration = 0; return value; }
}

/** Three-prop cascade: finite-speed throws and ballistically accelerated flight.
 * Positions meet at catch/launch; the actor's springs soften the impulse.
 */
function cascadePhase(time, index) {
  const phase = time / 1.65 + index * 2 / 3, nearest = Math.round(phase);
  // Recovery resumes exactly at a catch. Decimal clock accumulation must not
  // classify that catch as the final nanosecond of the opposite-hand flight.
  return Math.abs(phase - nearest) < 1e-9 ? nearest : phase;
}
export function jugglePose(time, index) {
  const duration = 1.65;
  const phase = cascadePhase(time, index);
  const leg = Math.floor(phase);
  const p = mod(phase, 1);
  const side = leg % 2 === 0 ? -1 : 1;
  const dwell = .19;
  if (p < dwell) {
    const u = p / dwell;
    return { x: side * mix(.88, .66, smooth(u)), y: 1.3 - .13 * Math.sin(u * Math.PI), z: .76, rotation: leg * Math.PI * 2, hand: side, dwell: true, nextCatch: (leg + 1 - index * 2 / 3) * duration };
  }
  const u = (p - dwell) / (1 - dwell);
  return { x: mix(side * .66, -side * .88, u), y: 1.3 + 6.7 * u * (1 - u), z: .76 - .09 * Math.sin(u * Math.PI), rotation: (leg + smoother(u)) * Math.PI * 2, hand: side, dwell: false, nextCatch: (leg + 1 - index * 2 / 3) * duration };
}

/** The same catch/dip/throw cycle drives each wrist, including its recovery. */
export function juggleHandPose(time, side) {
  const poses = [0, 1, 2].map(i => jugglePose(time, i));
  const held = poses.findIndex(p => p.hand === side && p.dwell);
  if (held >= 0) return { ...poses[held], y: poses[held].y - .36, held, roll: -side * .08 };
  let sinceLaunch = Infinity, outgoing = -1, incoming = -1, untilCatch = Infinity;
  for (let i = 0; i < 3; i++) {
    const phase = cascadePhase(time, i), leg = Math.floor(phase), p = mod(phase, 1);
    const source = leg % 2 === 0 ? -1 : 1;
    if (source === side && p >= .19 && (p - .19) * 1.65 < sinceLaunch) {
      sinceLaunch = (p - .19) * 1.65; outgoing = i;
    }
    if (source === -side && poses[i].nextCatch - time < untilCatch) { untilCatch = poses[i].nextCatch - time; incoming = i; }
  }
  const follow = smooth(sinceLaunch / .13) * (1 - smooth((sinceLaunch - .13) / .34));
  return { x: side * mix(.88, .54, follow), y: .94 + follow * .45, z: .79, held: -1, roll: -side * follow * .32,
    outgoing, release: 1 - smooth(sinceLaunch / .16), incoming, anticipation: smooth((.32 - untilCatch) / .32) };
}

/** Seed a real cascade from one parcel on the left and a two-parcel stack on
 * the right. The top parcel receives the first right-hand impulse; the lower
 * parcel stays supported. Every parcel is held until its own launch, follows
 * a ballistic first flight, and joins the ordinary cascade only at a catch.
 * base must put parcel 2 at a right-hand catch (2.75 + N * 3.3 seconds). */
export function restartCascadePose(time, base) {
  const launches = [.8635, 1.4135, .3135], flight = 1.3365;
  const right = time < .3135
    ? { x: mix(1.03, .66, smooth(time / .3135)), y: .94 - .13 * Math.sin(clamp(time / .3135) * Math.PI), z: mix(.815, .775, smooth(time / .3135)), held: 1, roll: -.08 }
    : time < 1.1
      ? { x: mix(.66, .88, smooth((time - .3135) / .7865)), y: .94 + .15 * Math.sin(clamp((time - .3135) / .7865) * Math.PI), z: .775, held: 1, roll: -.08 }
      : juggleHandPose(base + time, 1);
  const left = time < .55
    ? { x: mix(-1.06, -.88, smoother(time / .55)), y: mix(.95, .94, smoother(time / .55)), z: mix(.845, .775, smoother(time / .55)), held: 0, roll: .08 }
    : juggleHandPose(base + time, -1);
  if (time >= .55 && left.held >= 0) left.z += .015;
  if (time >= 1.1 && right.held >= 0) right.z += .015;
  const parcels = [0, 1, 2].map(i => {
    const launch = launches[i], side = i === 0 ? -1 : 1;
    if (time < launch) {
      const hand = side < 0 ? left : right;
      return { x: hand.x, y: hand.y + .36 + (i === 2 ? .53 : 0), z: hand.z - .015, rotation: 0, state: 'held', hand: side, support: i === 2 ? 1 : null };
    }
    if (time < launch + flight) {
      const u = (time - launch) / flight, height = i === 2 ? 1.83 : 1.3;
      return { x: mix(side * .66, -side * .88, u), y: mix(height, 1.3, u) + 6.7 * u * (1 - u), z: .76 - .09 * Math.sin(u * Math.PI), rotation: smoother(u) * 2 * Math.PI, state: 'flight', hand: side, support: null };
    }
    return { ...jugglePose(base + time, i), state: 'cascade', support: null };
  });
  return { parcels, hands: [left, right], launches };
}

const CORRECT_BLOCK_ORDER = Object.freeze([0, 1, 2]);
const INCORRECT_BLOCK_ORDERS = Object.freeze([
  Object.freeze([1, 2, 0]), Object.freeze([2, 0, 1]), Object.freeze([0, 2, 1]),
  Object.freeze([1, 0, 2]), Object.freeze([2, 1, 0])
]);

/** IDs refer to size: 0 large, 1 medium, 2 small. All five error permutations
 * are deliberately wrong. One lookup per cycle replaces per-frame randomness. */
export function architectureOrder(time, hasFindings = false) {
  return hasFindings ? INCORRECT_BLOCK_ORDERS[mod(Math.floor(Math.max(0, time) / 10.8), INCORRECT_BLOCK_ORDERS.length)] : CORRECT_BLOCK_ORDER;
}

/** Every block is picked up at the waist, carried around the outside and set
 * down. Only the block at the pocket may emerge from the body. */
export function architecturePose(time, index, order = CORRECT_BLOCK_ORDER) {
  const rank = order.indexOf(index);
  const cycle = mod(time, 10.8), slot = cycle - .35 - rank * 2.8;
  const targetY = .98 + rank * .26;
  const pocket = [1.28, -.38, .71], outside = [1.50, targetY + .43, .71], over = [0, targetY + .43, 0], placed = [0, targetY, 0];
  const lerp = (a, b, u) => a.map((n, i) => mix(n, b[i], smoother(u)));
  let position = pocket, scale = 0, held = false, phase = 'waiting';
  if (slot >= 0 && slot < .42) { scale = smoother((slot - .16) / .26); held = slot > .15; phase = 'pickup'; }
  else if (slot < 1.18 && slot >= .42) { position = lerp(pocket, outside, (slot - .42) / .76); scale = 1; held = true; phase = 'lift'; }
  else if (slot < 1.95 && slot >= 1.18) { position = lerp(outside, over, (slot - 1.18) / .77); scale = 1; held = true; phase = 'carry'; }
  else if (slot < 2.35 && slot >= 1.95) { position = lerp(over, placed, (slot - 1.95) / .40); scale = 1; held = true; phase = 'place'; }
  else if (slot >= 2.35) { position = placed; scale = 1; phase = 'stacked'; }
  if (cycle > 9.2) {
    const recycle = smoother((cycle - 9.2 - rank * .18) / .75);
    position = lerp(placed, [0, .23, 0], recycle); scale = 1 - recycle; held = false; phase = 'recycle';
  }
  return { position, scale: Math.max(.001, scale), held, phase, slot, cycle };
}
