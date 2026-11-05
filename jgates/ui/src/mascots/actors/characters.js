import * as THREE from 'three';
import { DOMAINS, assertStatus, fromJGatesStage, fromJGatesDecision } from './status.js';
import { Spring, clamp, mix, smooth, smoother, pulse, mod, jugglePose, juggleHandPose, architecturePose, architectureOrder, inspectionAlert, droppedParcelPose, restartCascadePose, fallenParcelPose } from './motion.js';
import { V, vinyl, box, ball, group, extrusion, deformable, arm, boot, architectureBoot, segment, face, shieldShape, braceShape, starShape, archShape, check, cross, disposeTree } from './geometry.js';

function parcel(parent, mat, cream) {
  const g = group(parent);
  const core = deformable(box(g, [.49, .49, .49], mat, [0, 0, 0], .075));
  box(g, [.11, .50, .013], cream, [0, 0, .25], .005);
  box(g, [.11, .014, .50], cream, [0, .25, 0], .005);
  g.userData.core = core; return g;
}

function laserHalo() {
  const width = 64, height = 32, pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
    pixels[i + 3] = Math.round(255 * Math.exp(-Math.pow((y / (height - 1) - .5) / .20, 2)) * Math.pow(Math.sin(Math.PI * x / (width - 1)), .3));
  }
  const map = new THREE.DataTexture(pixels, width, height); map.needsUpdate = true;
  map.magFilter = map.minFilter = THREE.LinearFilter;
  return new THREE.MeshBasicMaterial({ color: '#4dffc5', map, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
}

// Uppercase laser lettering, drawn as two merged stroke meshes. No font,
// canvas, download or extra rendering library is required, including in Node.
function laserError(parent) {
  const word = group(parent, [0, .14, .585]);
  word.userData.text = 'ERROR';
  const glyphs = {
    E: [[[2, 0], [0, 0], [0, 3], [2, 3]], [[0, 1.5], [1.7, 1.5]]],
    R: [[[0, 0], [0, 3], [1.6, 3], [2, 2.6], [2, 1.9], [1.6, 1.5], [0, 1.5]], [[.8, 1.5], [2, 0]]],
    O: [[[.4, 0], [0, .4], [0, 2.6], [.4, 3], [1.6, 3], [2, 2.6], [2, .4], [1.6, 0], [.4, 0]]]
  };
  const layers = [.029, .010].map((width, layer) => {
    const vertices = [];
    [...'ERROR'].forEach((letter, i) => glyphs[letter].forEach(path => {
      for (let j = 1; j < path.length; j++) {
        const [ax, ay] = path[j - 1], [bx, by] = path[j];
        const x0 = (i * 3 + ax - 7) * .062, x1 = (i * 3 + bx - 7) * .062;
        const y0 = ay * .045, y1 = by * .045, length = Math.hypot(x1 - x0, y1 - y0);
        const nx = -(y1 - y0) / length * width / 2, ny = (x1 - x0) / length * width / 2;
        const a = [x0 + nx, y0 + ny, 0], b = [x0 - nx, y0 - ny, 0], c = [x1 + nx, y1 + ny, 0], d = [x1 - nx, y1 - ny, 0];
        vertices.push(...a, ...b, ...c, ...b, ...d, ...c);
      }
    }));
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const material = new THREE.MeshBasicMaterial({ color: layer ? '#ffc1b8' : '#ff1731', transparent: true, opacity: 0, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material); mesh.position.z = layer * .001; word.add(mesh); return mesh;
  });
  word.userData.layers = layers; return word;
}

/** Every mascot has exactly two arms. All pieces are generated in code. */
function construct(domain) {
  const root = group(); root.name = `jgates-${domain}`;
  const body = group(root, [0, 1.45, 0]);
  const skin = group(body);
  const mat = vinyl(DOMAINS[domain].color), light = vinyl('#fff0c5'), dark = mat.clone(); dark.color.multiplyScalar(.77);
  const gold = vinyl('#ffca58', { emissive: '#ffb12d', emissiveIntensity: .04 });
  const rig = { root, body, skin, mat, light, dark, gold, morphs: [], domain, pieces: {} };
  let faceOptions = {}, shoulder = .70;
  if (domain === 'quality') {
    rig.morphs.push(deformable(box(skin, [1.55, 1.65, .78], mat, [0, 0, 0], .25)));
    rig.pieces.braces = [-1, 1].map(side => {
      const b = group(skin, [side * .57, 0, .40]);
      extrusion(b, braceShape(), .17, mat); if (side === 1) b.scale.x = -1;
      return b;
    });
    const star = group(skin, [.75, 1.05, .57]); extrusion(star, starShape(), .10, gold, [0, 0, 0], .035); rig.pieces.star = star;
    faceOptions = { z: .43, y: .06, spacing: .29 }; shoulder = .72;
  } else if (domain === 'security') {
    rig.morphs.push(deformable(extrusion(skin, shieldShape(), .53, dark, [0, .06, 0], .09)));
    extrusion(skin, shieldShape(.86), .08, mat, [0, .07, .34], .055);
    ball(skin, [.105, .105, .04], light, [0, -.34, .47]);
    const key = new THREE.Shape(); key.moveTo(-.048, -.36); key.lineTo(-.075, -.60); key.lineTo(.075, -.60); key.lineTo(.048, -.36); key.closePath();
    extrusion(skin, key, .045, light, [0, 0, .46], .012);
    const laser = new THREE.MeshBasicMaterial({ color: '#d5fff0', transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
    const glow = laserHalo();
    rig.pieces.scan = box(skin, [1.24, .032, .018], laser, [0, -.1, .56], .008);
    rig.pieces.scanGlow = new THREE.Mesh(new THREE.PlaneGeometry(1.40, .23), glow);
    rig.pieces.scanGlow.position.set(0, -.1, .55); skin.add(rig.pieces.scanGlow);
    rig.pieces.scanError = laserError(skin);
    faceOptions = { z: .47, y: .28, spacing: .27 }; shoulder = .70;
  } else if (domain === 'dependencies') {
    rig.morphs.push(deformable(box(skin, [1.40, 1.40, .85], mat, [0, -.03, 0], .23)));
    box(skin, [.22, .025, .85], light, [0, .68, 0], .01);
    box(skin, [.22, .24, .018], light, [0, .57, .438], .012);
    rig.pieces.packages = Array.from({ length: 3 }, () => parcel(root, mat, light));
    faceOptions = { z: .46, y: .04, spacing: .26 }; shoulder = .61;
  } else if (domain === 'tests') {
    rig.morphs.push(deformable(box(skin, [1.48, 1.90, .76], mat, [0, .07, 0], .24)));
    faceOptions = { z: .43, x: .27, y: .30, spacing: .17 }; shoulder = .65;
    rig.pieces.rows = [];
    for (let i = 0; i < 3; i++) {
      const row = group(skin, [-.39, .60 - i * .53, .43]);
      const fill = vinyl('#549653');
      box(row, [.40, .40, .055], dark, [0, 0, 0], .065);
      const tile = box(row, [.33, .33, .04], fill, [0, 0, .035], .05);
      const tick = check(row, light, [0, 0, .08], .55);
      const x = cross(row, light, [0, 0, .09], .55); x.visible = false;
      rig.pieces.rows.push({ group: row, tile, tick, cross: x, fill });
    }
    rig.pieces.handCheck = check(skin, light, [.65, -.50, .57], .6);
  } else if (domain === 'architecture') {
    body.position.y = 1.13;
    rig.morphs.push(deformable(extrusion(skin, archShape(), .63, mat, [0, 0, 0], .075)));
    rig.pieces.blocks = [[1.65, .24, .79], [1.20, .24, .72], [.77, .24, .64]].map((size, i) => {
      const g = group(skin, [0, .98 + i * .26, 0]); box(g, size, mat, [0, 0, 0], .09); g.userData.width = size[0]; return g;
    });
    faceOptions = { z: .41, y: .53, spacing: .27 }; shoulder = .80;
  } else if (domain === 'infrastructure') {
    rig.pieces.slabs = [];
    rig.pieces.leds = [];
    for (let i = 0; i < 3; i++) {
      const g = group(skin, [0, (i - 1) * .53, 0]);
      rig.morphs.push(deformable(box(g, [1.83, .49, .81], mat, [0, 0, 0], .14)));
      if (i < 2) {
        ball(g, [.104, .104, .026], dark, [.33, 0, .429]);
        const ledmat = vinyl('#ffd14a', { emissive: '#ffd14a', emissiveIntensity: 1, toneMapped: false });
        const led = ball(g, [.077, .077, .035], ledmat, [.33, 0, .46]);
        const halo = ball(g, [.12, .12, .014], new THREE.MeshBasicMaterial({ color: '#ffd14a', transparent: true, opacity: .2, depthWrite: false, toneMapped: false }), [.33, 0, .45]);
        box(g, [.23, .053, .04], light, [.61, 0, .43], .02); rig.pieces.leds.push({ mesh: led, mat: ledmat, halo });
      }
      rig.pieces.slabs.push(g);
    }
    faceOptions = { z: .45, y: .04, spacing: .27 }; shoulder = .81;
  }
  rig.face = face(domain === 'infrastructure' ? rig.pieces.slabs[2] : skin, faceOptions);
  const armParent = domain === 'infrastructure' ? rig.pieces.slabs[1] : skin;
  rig.arms = [-1, 1].map(side => arm(armParent, side, mat, shoulder, domain === 'architecture' ? .98 : .48));
  const footX = domain === 'architecture' ? .68 : .43;
  rig.feet = [-1, 1].map(side => domain === 'architecture'
    ? architectureBoot(root, mat, [side * footX, .22, .08])
    : boot(root, mat, [side * footX, .20, .08], .58));
  const legTop = { quality: -.68, security: -.52, dependencies: -.57, tests: -.71, architecture: -.63, infrastructure: -.60 }[domain];
  rig.legs = [-1, 1].map(side => ({ ...segment(root, mat, .185), top: V(side * footX, legTop, 0), side }));
  const materials = new Set();
  root.traverse(o => { if (o.material) materials.add(o.material); });
  rig.materials = [...materials].map(material => ({ material, color: material.color.clone(), emissive: material.emissive?.clone(), intensity: material.emissiveIntensity }));
  rig.baseY = body.position.y;
  return rig;
}

export class Mascot extends EventTarget {
  constructor(domain, { status = 'waiting', reducedMotion = false, elasticity = 1 } = {}) {
    super();
    if (!Object.hasOwn(DOMAINS, domain)) throw new TypeError(`Unknown domain: ${domain}`);
    this.domain = domain; this.rig = construct(domain); this.object = this.rig.root;
    this.status = assertStatus(status); this.time = 0; this.age = 10; this.actionTime = 0;
    this.reducedMotion = reducedMotion; this.elasticity = elasticity; this.progress = null;
    this.hasFindings = false;
    this.architectureEpoch = 0; this.architectureFinalOrder = null;
    this.alertEpoch = 0; this.juggleTime = 0; this.drop = null; this.dropCount = 0; this.dropDue = Infinity;
    this.springs = new Map(); this.settles = []; this.disposed = false;
    this.parcelFall = null;
    if (domain === 'dependencies' && ['failed', 'error', 'timeout'].includes(status)) this.beginParcelFall(true);
    this.phaseOffset = Object.keys(DOMAINS).indexOf(domain) * .73;
    this.update(0);
  }
  spring(key, target, dt, stiffness = 135, damping = 20) {
    let s = this.springs.get(key);
    if (!s) { s = new Spring(target, stiffness, damping); this.springs.set(key, s); }
    return this.reducedMotion || this.settledFrame ? s.snap(target) : s.step(target, dt);
  }
  beginParcelFall(immediate = false) {
    this.parcelFall = { time: immediate ? 4 : 0, starts: this.rig.pieces.packages.map(p => p.position.toArray()),
      velocities: [0, 1, 2].map(i => [0, 1, 2].map(axis => this.springs.get(`pkg${i}-${axis}`)?.velocity ?? 0)),
      rotations: this.rig.pieces.packages.map(p => p.quaternion.clone()) };
    this.settles = []; this.drop = null;
  }
  setStatus(status, { progress = this.progress, reason = '', hasFindings = status === this.status ? this.hasFindings : false, settled = false } = {}) {
    if (this.disposed) throw new Error('Mascot was disposed');
    assertStatus(status);
    if (typeof hasFindings !== 'boolean') throw new TypeError('hasFindings must be a boolean');
    this.setProgress(progress);
    if (status !== this.status) {
      if (this.domain === 'architecture') {
        if (status === 'processing') { this.architectureEpoch = this.actionTime; this.architectureFinalOrder = null; }
        else if (['failed', 'error', 'timeout'].includes(status) || (this.hasFindings && ['finished', 'incomplete', 'blocked', 'cancelled'].includes(status))) {
          this.architectureFinalOrder = [...architectureOrder(this.actionTime - this.architectureEpoch, true)];
        } else this.architectureFinalOrder = null;
      }
      if (this.domain === 'dependencies' && this.status === 'processing') {
        this.settles = this.drop ? [] : [0, 1, 2].map(i => jugglePose(this.juggleTime, i).nextCatch);
        this.drop = null;
      }
      if (this.domain === 'dependencies') {
        if (['failed', 'error', 'timeout'].includes(status)) this.beginParcelFall();
        else this.parcelFall = null;
      }
      if (status === 'processing') this.settles = [];
      this.previousStatus = this.status; this.status = status; this.age = 0;
    }
    this.settledFrame = settled;
    if (settled) { this.age = 4; if (this.parcelFall) this.parcelFall.time = 4; }
    this.reason = reason;
    this.setFindings(hasFindings);
    this.dispatchEvent(new CustomEvent('statuschange', { detail: { domain: this.domain, status, progress: this.progress, hasFindings, reason } }));
    return this;
  }
  setFindings(hasFindings) {
    if (typeof hasFindings !== 'boolean') throw new TypeError('hasFindings must be a boolean');
    if (this.domain === 'architecture' && this.status === 'processing' && hasFindings !== this.hasFindings) {
      // Reabsorb the previous stack before starting a new pickup cycle. No
      // block swaps places through the other blocks when findings change.
      this.architectureEpoch = this.actionTime + .8;
    }
    if (hasFindings !== this.hasFindings) {
      this.alertEpoch = this.actionTime;
      if (this.domain === 'dependencies') this.dropDue = hasFindings ? Math.ceil((this.juggleTime + 6.6) / 3.3) * 3.3 : Infinity;
    }
    this.hasFindings = hasFindings;
    this.dispatchEvent(new CustomEvent('findingschange', { detail: { hasFindings } }));
    return this;
  }
  setProgress(progress) {
    if (progress === null || progress === undefined) { this.progress = null; this.dispatchEvent(new Event('progresschange')); return this; }
    const { completed, total } = progress;
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(completed) || completed < 0 || completed > total) throw new TypeError('Progress requires 0 <= completed <= total, total > 0');
    this.progress = { completed, total }; this.dispatchEvent(new Event('progresschange')); return this;
  }
  setStage(stage, options) { return this.setStatus(fromJGatesStage(stage, options), { reason: stage.reason ?? '', hasFindings: stage.state === 'running' && Number.isFinite(stage.blockingViolations) && stage.blockingViolations > 0 }); }
  setDecision(result) { return this.setStatus(fromJGatesDecision(result)); }
  replay() { this.age = 0; return this; }
  update(delta) {
    if (this.disposed) return;
    const dt = Math.min(delta, .05);
    if (!this.reducedMotion) { this.time += dt; this.age += dt; }
    const resting = ['disabled', 'not_applicable'].includes(this.status);
    const t = this.reducedMotion || resting ? 1.2 : this.time;
    const age = this.reducedMotion ? 3 : this.age;
    const processing = this.status === 'processing';
    if (!this.reducedMotion && (processing || this.settles.some(n => n > this.juggleTime))) this.actionTime += dt;
    const activity = this.spring('activity', processing ? 1 : 0, dt, 90, 18);
    const success = this.status === 'passed';
    const partialFailure = processing && this.hasFindings;
    const trouble = this.status === 'failed' || partialFailure;
    const uncertain = ['blocked', 'incomplete', 'invalid'].includes(this.status);
    const technical = this.status === 'error' || this.status === 'timeout';
    const muted = ['disabled', 'not_applicable', 'cancelled'].includes(this.status);
    const r = this.rig;
    // Start from each authored palette every frame; temporary gray never
    // accumulates or destroys the specialty's original colors.
    r.materials.forEach(({ material, color, emissive, intensity }) => {
      material.color.copy(color); if (emissive) material.emissive.copy(emissive);
      if (intensity !== undefined) material.emissiveIntensity = intensity;
    });
    const celebrate = success && !this.reducedMotion ? Math.max(0, Math.sin(clamp((age - .16) / .88) * Math.PI)) * (age < 1.04 ? 1 : 0) : 0;
    const recoil = (trouble || technical) ? pulse(age, .18, .17) : 0;
    const idle = this.reducedMotion || resting ? 0 : Math.sin(t * 1.7 + this.phaseOffset) * .018;
    const bounce = activity * (this.reducedMotion ? 0 : Math.sin(this.actionTime * 3.5) * .035);
    r.body.position.y = this.spring('bodyY', r.baseY + idle + bounce + celebrate * .34 - recoil * .075 - (resting ? .19 : muted ? .06 : 0), dt, 150, 18);
    r.body.rotation.z = this.spring('lean', uncertain ? -.105 : trouble ? -.055 : muted ? .045 : Math.sin(t * 1.5) * activity * .025, dt, 95, 17);
    r.body.rotation.x = this.spring('pitch', resting ? -.10 : (trouble ? .055 : 0) - recoil * .1, dt);
    const motion = this.springs.get('bodyY');
    const elastic = this.spring('squash', this.elasticity * clamp((motion?.acceleration ?? 0) * -.005 + recoil * .22 + (celebrate > .01 ? -.10 : pulse(age, 1.08, .13) * (success ? .16 : 0)), -.26, .32), dt, 160, 14);
    r.skin.scale.set(1 + elastic * .045, 1 - elastic * .065, 1 + elastic * .025);
    r.morphs.forEach(m => { m.morphTargetInfluences[0] = elastic * .6; });
    for (const [i, f] of r.feet.entries()) {
      f.position.y = (this.domain === 'architecture' ? .22 : .20) + this.spring(`foot${i}`, celebrate * (i ? .16 : .10) + (processing && this.domain === 'tests' ? Math.max(0, Math.sin(t * 3 + i * Math.PI)) * .055 : 0), dt);
      f.rotation.z = this.spring(`footR${i}`, success ? (i ? -.06 : .06) : 0, dt);
      f.position.z = this.spring(`footZ${i}`, resting ? (this.domain === 'architecture' ? .15 : .32) : .08, dt);
      f.rotation.x = this.spring(`footPitch${i}`, resting && this.domain !== 'architecture' ? -.12 : 0, dt);
    }
    // Default hand poses, overridden by each functional action below.
    const handTargets = [[-1.05, -.45, .25], [1.05, -.35, .30]];
    if (uncertain) handTargets[1] = [.87, .47, .30];
    if (trouble) handTargets[1] = [1.01, -.03, .38];
    if (success) handTargets[1] = [.99, .46 + celebrate * .23, .25];
    if (technical) handTargets[1] = [.9, .15, .40];
    if (muted) { handTargets[0] = [-.93, -.51, .38]; handTargets[1] = [.93, -.51, .38]; }
    const exactHands = [null, null], handRolls = [0, 0];
    let gazeX = 0, gazeY = 0;
    if (this.domain === 'quality') {
      const alert = inspectionAlert(this.actionTime - this.alertEpoch, 2.2);
      const stopped = partialFailure && alert.alert || this.status === 'failed' || technical;
      const power = this.reducedMotion || !processing ? 1 : alert.power;
      this.reviewAlert = { active: stopped, power: stopped ? power : 0 };
      r.pieces.braces.forEach((b, i) => {
        const sign = i ? 1 : -1;
        b.position.x = this.spring(`brace${i}`, sign * (stopped ? .50 - power * .035 : .57 + activity * (.04 + .065 * Math.sin(t * 2.2 + i * .5))), dt, 110, 16);
        b.rotation.z = this.spring(`braceR${i}`, stopped ? sign * power * .045 : activity * sign * Math.sin(t * 2.2) * .035, dt);
      });
      r.pieces.star.position.x = this.spring('starX', stopped ? .86 : .75, dt);
      r.pieces.star.position.y = this.spring('starY', stopped ? -.30 : 1.05, dt);
      r.pieces.star.position.z = this.spring('starZ', stopped ? .67 : .57, dt);
      r.pieces.star.rotation.z = this.spring('starR', stopped ? .12 : t * .12 + activity * Math.sin(t * 2) * .15 + celebrate * 1.1, dt);
      r.pieces.star.scale.setScalar(1 + celebrate * .13 + (stopped ? power * .07 : 0));
      if (stopped) { r.gold.color.set('#f44b55').multiplyScalar(.48 + .52 * power); r.gold.emissive.set('#ff1434'); r.gold.emissiveIntensity = .12 + power * 1.15; }
      if (processing) { handTargets[1] = [1.08, .22 + Math.sin(t * 2.2) * .12, .36]; gazeX = Math.sin(t * 2.2) * .055; }
      if (stopped) { handTargets[1] = [1.16, -.32, .54]; gazeX = .045; gazeY = -.055; }
    } else if (this.domain === 'security') {
      const scan = r.pieces.scan, glow = r.pieces.scanGlow;
      const alert = inspectionAlert(this.actionTime - this.alertEpoch);
      const red = partialFailure && (this.reducedMotion || alert.alert) || this.status === 'failed' || technical;
      const power = red ? (this.reducedMotion || !processing ? 1 : alert.power) : 1;
      const scanTime = partialFailure ? alert.scanTime : t;
      const targetY = red ? .03 : .03 + Math.sin(scanTime * 1.7) * .57;
      scan.position.y = this.spring('scanY', targetY, dt, 240, 30);
      scan.material.opacity = (red ? 1 : clamp(activity)) * .94 * power;
      scan.material.color.set(red ? '#ffc0b5' : '#d5fff0');
      scan.scale.x = .77 + .23 * smooth((scan.position.y + .5) / .75);
      glow.position.y = scan.position.y; glow.scale.x = scan.scale.x;
      glow.material.color.set(red ? '#ff1738' : '#4dffc5'); glow.material.opacity = (red ? .90 : activity * .40) * power;
      r.pieces.scanError.userData.layers.forEach((mesh, i) => { mesh.material.opacity = red ? power * (i ? .98 : .45) : 0; });
      this.scanAlert = { red, power, phase: alert.phase, textOpacity: r.pieces.scanError.userData.layers[1].material.opacity };
      if (processing) { handTargets[1] = [.98, .13, .42]; gazeY = Math.sin(t * 1.7) * .035; }
      if (trouble || technical) handTargets[1] = [1.08, .32, .56];
      if (red) gazeY = .20;
    } else if (this.domain === 'dependencies') {
      const finalFall = this.parcelFall;
      if (finalFall) finalFall.time = this.reducedMotion ? Math.max(4, finalFall.time) : finalFall.time + dt;
      if (!this.reducedMotion && (processing || this.settles.some(n => n > this.juggleTime))) {
        if (this.drop) {
          this.drop.time += dt;
          if (this.drop.time >= 7.0) {
            this.juggleTime = this.drop.restartBase + this.drop.time - 3.15;
            const catchAnchor = this.drop.restartBase + 3.85;
            this.drop = null; this.dropCount++;
            this.dropDue = this.hasFindings ? catchAnchor + (this.dropCount % 2 ? 9.9 : 6.6) : Infinity;
          }
        } else {
          this.juggleTime += dt;
          if (partialFailure && this.juggleTime >= this.dropDue) {
            this.juggleTime = this.dropDue;
            this.drop = { time: 0, restartBase: this.juggleTime + 2.75, starts: r.pieces.packages.map(p => p.position.toArray()), hands: r.arms.map(a => r.root.worldToLocal(a.hand.getWorldPosition(V())).toArray()) };
          }
        }
      }
      const restart = this.drop && this.drop.time >= 3.15 ? restartCascadePose(this.drop.time - 3.15, this.drop.restartBase) : null;
      const recovery = this.drop ? droppedParcelPose(this.drop.time, this.drop.starts) : null;
      if (restart) recovery.positions = restart.parcels.map(p => [p.x, p.y, p.z]);
      if (recovery) { this.drop.phase = recovery.phase; r.body.rotation.z -= smooth(this.drop.time / .6) * (1 - smooth((this.drop.time - 2.8) / .8)) * .09; }
      const rest = resting ? [[-1.12, .36, .67], [1.12, .36, .67], [-1.12, .88, .67]] : [[-1.00, 1.25, .76], [1.00, 1.27, .76], [-1.00, 1.78, .76]];
      for (let i = 0; i < 3; i++) {
        const p = r.pieces.packages[i];
        if (finalFall) {
          const fallen = fallenParcelPose(this.reducedMotion ? 4 : finalFall.time, finalFall.starts[i], finalFall.velocities[i], i);
          p.position.set(...fallen.position.map((n, axis) => {
            const key = `pkg${i}-${axis}`;
            if (!this.springs.has(key)) this.springs.set(key, new Spring(n));
            return this.springs.get(key).snap(n);
          }));
          const landed = new THREE.Quaternion().setFromEuler(new THREE.Euler(i === 1 ? -Math.PI / 2 : Math.PI / 2, [-.38, .27, -.58][i], 0, 'YXZ'));
          p.quaternion.copy(finalFall.rotations[i]).slerp(landed, fallen.turn);
          p.userData.core.morphTargetInfluences[0] = this.reducedMotion ? 0 : this.elasticity * .5 * pulse(finalFall.time, fallen.impact + .03, .08);
          continue;
        }
        const stillFlying = !this.reducedMotion && this.settles[i] > this.juggleTime;
        const j = jugglePose(this.juggleTime, i);
        const target = recovery ? recovery.positions[i] : (processing && !this.reducedMotion) || stillFlying ? [j.x, j.y, j.z] : rest[i];
        p.position.set(...target.map((n, axis) => this.spring(`pkg${i}-${axis}`, n, dt, 260, 25)));
        if (recovery && i === 0 && p.position.y < .295) { p.position.y = .295; this.springs.get(`pkg${i}-1`).snap(.295); }
        // Quaternions follow the target by shortest arc; catch does not unwind previous turns.
        const angle = restart ? restart.parcels[i].rotation : recovery ? (i === 0 && this.drop.time < .68 ? (1 - smooth(this.drop.time / .68)) * -.28 : 0) : (processing && !this.reducedMotion) || stillFlying ? j.rotation : 0;
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, .12, angle));
        p.quaternion.slerp(q, this.reducedMotion ? 1 : 1 - Math.exp(-dt * 17));
        p.userData.core.morphTargetInfluences[0] = this.reducedMotion ? 0 : this.elasticity * (recovery && i === 0 ? pulse(this.drop.time, .78, .11) * .65 : pulse(mod(this.juggleTime / 1.65 + i * 2 / 3, 1), .04, .05) * .4);
      }
      handTargets[0] = [-1, -.55, .77]; handTargets[1] = [1, -.53, .77];
      if ((processing || this.settles.some(n => n > this.juggleTime)) && !this.reducedMotion) {
        for (let a = 0; a < 2; a++) {
          const side = a ? 1 : -1;
          const wrist = juggleHandPose(this.juggleTime, side);
          if (wrist.held >= 0) {
            const held = r.pieces.packages[wrist.held].position;
            exactHands[a] = { point: held.clone().add(V(0, -.36, .015)), space: r.root };
          } else {
            const point = V(wrist.x, wrist.y, wrist.z);
            if (wrist.outgoing >= 0 && wrist.release > 0) point.lerp(r.pieces.packages[wrist.outgoing].position.clone().add(V(0, -.36, .015)), wrist.release);
            if (wrist.incoming >= 0 && wrist.anticipation > 0) point.lerp(r.pieces.packages[wrist.incoming].position.clone().add(V(0, -.36, .015)), wrist.anticipation);
            exactHands[a] = { point, space: r.root };
          }
          handRolls[a] = wrist.roll;
        }
        const high = r.pieces.packages.reduce((a, b) => a.position.y > b.position.y ? a : b);
        gazeX = high.position.x * .045; gazeY = .035;
        if (recovery) {
          const elapsed = this.drop.time, actual = r.pieces.packages[0].position;
          const offset = elapsed < 1.80 ? [.24, 0, .015] : [mix(.24, 0, smoother((elapsed - 2.35) / .8)), mix(0, -.36, smoother((elapsed - 2.35) / .8)), .015];
          const left = V(...this.drop.hands[0]).lerp(V(-.97, .30, .845), smoother((elapsed - .65) / .85));
          if (elapsed >= 1.5) left.copy(actual).add(V(...offset));
          exactHands[0] = { point: left, space: r.root };
          const right = V(...this.drop.hands[1]);
          const firstHeld = r.pieces.packages[1].position.clone().add(V(0, -.36, .015));
          right.lerp(firstHeld, smoother(elapsed / 1.15));
          exactHands[1] = { point: right, space: r.root };
          handRolls[0] = -.10; handRolls[1] = .08;
          gazeX = -.055; gazeY = -.10 * (1 - smooth((elapsed - 2.4) / .8));
        }
        if (restart) {
          for (let a = 0; a < 2; a++) {
            const wrist = restart.hands[a];
            let point = V(wrist.x, wrist.y, wrist.z);
            if (wrist.held >= 0) point = r.pieces.packages[wrist.held].position.clone().add(V(0, -.36, .015));
            else {
              if (wrist.outgoing >= 0 && wrist.release > 0) point.lerp(r.pieces.packages[wrist.outgoing].position.clone().add(V(0, -.36, .015)), wrist.release);
              if (wrist.incoming >= 0 && wrist.anticipation > 0) point.lerp(r.pieces.packages[wrist.incoming].position.clone().add(V(0, -.36, .015)), wrist.anticipation);
            }
            exactHands[a] = { point, space: r.root }; handRolls[a] = wrist.roll;
          }
          gazeX = 0; gazeY = .035;
        }
      } else if (!resting && !finalFall) {
        for (let a = 0; a < 2; a++) exactHands[a] = { point: r.pieces.packages[a].position.clone().add(V(0, -.36, .015)), space: r.root };
      }
      if (finalFall) { handTargets[0] = [-1.05, -.56, .38]; handTargets[1] = [1.05, -.54, .38]; gazeY = -.08; }
    } else if (this.domain === 'tests') {
      const cycle = mod(this.actionTime, 4.5);
      const failureRow = this.progress ? 0 : Math.floor(this.actionTime / 4.5) % 3;
      const scroll = processing && !this.progress ? smoother((cycle - 3.25) / 1.25) * 1.59 : 0;
      r.pieces.rows.forEach((row, i) => {
        const y = mod(.60 - i * .53 + scroll + .795, 1.59) - .795;
        row.group.position.y = this.spring(`rowY${i}`, processing ? y : .60 - i * .53, dt, 240, 28);
        const edge = processing ? clamp((.81 - Math.abs(y)) / .11) : 1;
        row.group.scale.setScalar(Math.max(.001, edge));
        let marked = success ? 1 : 0;
        if (this.progress) marked = clamp(this.progress.completed / this.progress.total * 3 - i);
        else if (processing) marked = smooth((cycle - .35 - i * .85) / .32) * (1 - smoother((cycle - 3.4) / .7));
        const finalFailure = this.status === 'failed' || technical;
        const failed = finalFailure || (partialFailure && i === failureRow);
        const tick = failed ? 0 : marked;
        const errorMark = finalFailure ? 1 : failed ? marked : 0;
        row.tick.scale.setScalar(.55 * Math.max(.001, this.spring(`check${i}`, tick, dt, 200, 17)));
        row.cross.visible = errorMark > .01;
        row.cross.scale.setScalar(.55 * Math.max(.001, this.spring(`cross${i}`, errorMark, dt, 200, 17)));
        row.tile.material.color.set(errorMark > .5 ? '#d64b52' : tick > .5 ? '#5d9d54' : '#ecdfb2');
        row.result = errorMark > .5 ? 'failed' : tick > .5 ? 'passed' : 'pending';
      });
      r.pieces.handCheck.visible = processing;
      r.pieces.handCheck.position.y = -.50 + Math.sin(t * 2.8) * .12;
      if (processing) { handTargets[1] = [.72, -.43 + Math.sin(t * 2.8) * .12, .55]; gazeY = -.035; }
    } else if (this.domain === 'architecture') {
      const architectureTime = this.actionTime - this.architectureEpoch;
      const order = processing ? architectureOrder(architectureTime, partialFailure)
        : this.architectureFinalOrder ?? architectureOrder(architectureTime, this.status === 'failed' || technical);
      this.blockOrder = order;
      const poses = [0, 1, 2].map(i => architectureTime < 0
        ? { position: [0, .23, 0], scale: .001, held: false, phase: 'recycle', slot: -1 }
        : architecturePose(architectureTime, i, order));
      let held = -1;
      r.pieces.blocks.forEach((b, i) => {
        const pose = processing && !this.reducedMotion ? poses[i] : { position: [0, .98 + order.indexOf(i) * .26, 0], scale: 1, held: false, phase: 'stacked' };
        b.position.set(...pose.position.map((n, axis) => this.spring(`block${i}-${axis}`, n, dt, 230, 27)));
        b.scale.setScalar(Math.max(.001, this.spring(`blockScale${i}`, pose.scale, dt, 190, 27)));
        b.rotation.z = this.spring(`blockR${i}`, pose.held ? -.045 * Math.sin(Math.max(0, poses[i].slot) * 2) : 0, dt, 100, 18);
        b.userData.phase = pose.phase;
        if (pose.held) held = i;
      });
      if (processing && !this.reducedMotion) {
        handTargets[0] = [-1.03, -.38, .43];
        if (held >= 0) {
          const b = r.pieces.blocks[held];
          // Grip the front-right corner, with the entire forearm in front of
          // the stacked blocks. Use the actual smoothed transform, not a second
          // independently delayed target.
          exactHands[1] = { point: b.position.clone().add(V(b.userData.width * b.scale.x * .40, -.03, .57)), space: r.skin };
          handRolls[1] = -.14;
          gazeY = .04; gazeX = b.position.x * .035;
        } else {
          const active = poses.find(p => p.slot >= 0 && p.slot < 2.8);
          const reach = active && active.slot < .16 ? smoother(active.slot / .16) : 1;
          handTargets[1] = [mix(1.08, 1.28, reach), mix(-.15, -.40, reach), .77];
        }
      }
    } else if (this.domain === 'infrastructure') {
      r.pieces.slabs.forEach((b, i) => {
        const wave = activity * Math.sin(t * 2.8 - i * .8);
        b.position.y = this.spring(`slabY${i}`, (i - 1) * .53 + wave * .075, dt, 125, 16);
        b.rotation.z = this.spring(`slabR${i}`, wave * .035 + (uncertain && i === 2 ? -.06 : 0), dt);
      });
      r.pieces.leds.forEach((led, i) => {
        const failed = trouble || technical;
        const color = failed ? '#ff3549' : success ? '#37e783' : '#ffca35';
        const blink = this.reducedMotion ? 1 : smooth((Math.sin(t * Math.PI * 2 * 1.35 - i * .45) + .12) * 4);
        const power = resting ? .03 : processing ? mix(.035, 1, blink) : (success || failed) ? 1 : .13;
        led.mat.color.set(color).multiplyScalar(power);
        led.mat.emissive.set(color); led.mat.emissiveIntensity = power * 1.6;
        led.halo.material.color.set(color); led.halo.material.opacity = resting ? 0 : power * .23;
        led.mesh.userData.power = power; led.mesh.userData.signal = resting ? 'off' : failed ? 'red' : success ? 'green' : 'yellow';
      });
      if (processing) gazeX = Math.sin(t * 1.4) * .025;
    }
    this.object.updateMatrixWorld(true);
    for (let i = 0; i < 2; i++) {
      const a = r.arms[i], exact = exactHands[i];
      let target = handTargets[i], direct = false;
      if (exact) {
        target = a.parent.worldToLocal(exact.space.localToWorld(exact.point.clone())).toArray();
        direct = !exact.spring;
      }
      // Keep wrist spring state synchronized while gripping, so release carries
      // on from the contact point instead of snapping to a stale hand pose.
      const coordinates = target.map((n, axis) => {
        const key = `hand${i}-${axis}`;
        if (!direct) return this.spring(key, n, dt, 230, 27);
        if (!this.springs.has(key)) this.springs.set(key, new Spring(n, 230, 27));
        return this.springs.get(key).snap(n);
      });
      a.reach(...coordinates, handRolls[i]);
      const leg = r.legs[i], foot = r.feet[i];
      const top = r.root.worldToLocal(r.skin.localToWorld(leg.top.clone()));
      leg.set(top, V(foot.position.x, foot.position.y + .10, foot.position.z - .05));
    }
    const f = r.face;
    f.group.position.x = f.baseX + this.spring('gazeX', gazeX + (uncertain ? -.035 : 0), dt, 90, 18);
    f.group.position.y = f.baseY + this.spring('gazeY', gazeY + (trouble ? -.035 : muted ? -.025 : 0), dt);
    const blinkPhase = mod(t + this.phaseOffset, 4.6);
    const blink = this.reducedMotion ? 1 : 1 - pulse(blinkPhase, .28, .075) * .94;
    const happy = this.spring('happy', success ? 1 : 0, dt, 100, 18);
    const worried = this.spring('worried', trouble ? 1 : uncertain ? .65 : technical ? .9 : 0, dt);
    f.eyes.forEach((eye, i) => {
      const open = technical ? 1.22 : resting ? .20 : muted ? .48 : uncertain && i === 0 ? .68 : 1;
      eye.scale.y = Math.max(.04, blink * open * (1 - happy * .94));
      eye.rotation.z = this.spring(`eyeAngle${i}`, (i ? -1 : 1) * worried * .19, dt);
      f.happy[i].material.opacity = happy;
      f.brows[i].material.opacity = worried * .9;
      f.brows[i].rotation.z = (i ? -1 : 1) * .37 * worried;
    });
    const gray = this.spring('gray', resting ? 1 : 0, dt, 95, 21);
    if (gray > .0001) r.materials.forEach(({ material }) => {
      const isInk = material.color.getHSL({}).l < .08;
      material.color.lerp(new THREE.Color(isInk ? '#46494f' : '#91959c'), gray);
      if (material.emissive) material.emissive.multiplyScalar(1 - gray);
    });
    this.object.updateMatrixWorld(true);
    this.settledFrame = false;
  }
  inspect() {
    return { domain: this.domain, status: this.status, hasFindings: this.hasFindings, time: this.time, actionTime: this.actionTime, age: this.age, armCount: this.rig.arms.length, morphs: this.rig.morphs.length,
      bodyY: this.rig.body.position.y, expression: { happy: this.springs.get('happy')?.value, worried: this.springs.get('worried')?.value },
      packages: this.rig.pieces.packages?.map(p => p.position.toArray()), blocks: this.rig.pieces.blocks?.map(p => p.position.toArray()),
      checks: this.rig.pieces.rows?.map(r => r.tick.scale.x), slabs: this.rig.pieces.slabs?.map(s => s.position.y),
      hands: this.rig.arms.map(a => a.hand.getWorldPosition(V()).toArray()),
      gray: this.springs.get('gray')?.value,
      blocksPhase: this.rig.pieces.blocks?.map(b => b.userData.phase),
      architectureTime: this.domain === 'architecture' ? this.actionTime - this.architectureEpoch : undefined,
      blockOrder: this.blockOrder ? [...this.blockOrder] : undefined,
      blockScales: this.rig.pieces.blocks?.map(b => b.scale.x),
      checkFailures: this.rig.pieces.rows?.map(row => row.cross.visible),
      checkResults: this.rig.pieces.rows?.map(row => row.result),
      checkRows: this.rig.pieces.rows?.map(row => row.group.position.y),
      packageDrop: this.domain === 'dependencies' ? { phase: this.drop?.phase ?? 'juggling', elapsed: this.drop?.time ?? 0, side: -1, count: this.dropCount, juggleTime: this.juggleTime,
        restart: this.drop && this.drop.time >= 3.15 ? restartCascadePose(this.drop.time - 3.15, this.drop.restartBase).parcels.map(p => ({ state: p.state, hand: p.hand, support: p.support })) : null } : undefined,
      parcelsOnGround: this.domain === 'dependencies' ? !!this.parcelFall && this.rig.pieces.packages.every(p => Math.abs(p.position.y - .28) < .001) : undefined,
      reviewAlert: this.reviewAlert,
      leds: this.rig.pieces.leds?.map(led => ({ power: led.mesh.userData.power, signal: led.mesh.userData.signal })),
      scan: this.rig.pieces.scan ? { opacity: this.rig.pieces.scan.material.opacity, y: this.rig.pieces.scan.position.y, text: this.rig.pieces.scanError.userData.text, textY: this.rig.pieces.scanError.position.y, ...this.scanAlert } : undefined,
      finite: [...this.springs.values()].every(s => Number.isFinite(s.value) && Number.isFinite(s.velocity)) };
  }
  dispose() { if (this.disposed) return; this.rig.pieces.scanGlow?.material.map?.dispose(); disposeTree(this.object); this.object.removeFromParent(); this.disposed = true; }
}
