export const clamp = (n, min = 0, max = 1) => Math.min(max, Math.max(min, n));
export const mix = (a, b, t) => a + (b - a) * t;
export const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };
export const pulse = (t, center, width) => Math.exp(-(((t - center) / width) ** 2));

export const LISTENING_POINTS=Object.freeze([
  Object.freeze([.60,-.46,1.22]),
  Object.freeze([1.25,.12,1.20]),
  Object.freeze([1.25,-.42,1.24])
]);

/** Travel with zero endpoint velocity, then hold at three separate listening positions. */
export function auscultationPose(time) {
  const duration=2.10, travel=.80, clock=((time%(duration*3))+duration*3)%(duration*3);
  const index=Math.floor(clock/duration), phase=clock-index*duration;
  const from=LISTENING_POINTS[(index+2)%3],to=LISTENING_POINTS[index];
  const u=clamp(phase/travel),e=u*u*u*(u*(u*6-15)+10);
  return {index,holding:phase>=travel,position:phase>=travel?[...to]:from.map((v,i)=>mix(v,to[i],e))};
}

/** Same substepped, velocity-preserving spring used by the original family. */
export class Spring {
  constructor(value, stiffness = 125, damping = 20) {
    this.value = value; this.velocity = 0; this.acceleration = 0;
    this.stiffness = stiffness; this.damping = damping;
  }
  step(target, delta) {
    const dt = clamp(delta, 0, .05), steps = Math.max(1, Math.ceil(dt * 240));
    for (let i = 0; i < steps; i++) {
      this.acceleration = this.stiffness * (target - this.value) - this.damping * this.velocity;
      this.velocity += this.acceleration * dt / steps;
      this.value += this.velocity * dt / steps;
    }
    return this.value;
  }
  snap(target) { this.value = target; this.velocity = this.acceleration = 0; return target; }
}
