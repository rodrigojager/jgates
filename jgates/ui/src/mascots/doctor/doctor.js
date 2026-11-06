import * as THREE from 'three';
import { V, vinyl, box, ball, group, extrusion, deformable, tube, arm, boot, segment, face, disposeTree } from './family-geometry.js';
import { Spring, clamp, pulse, auscultationPose } from './motion.js';

export const DOCTOR_STATES = Object.freeze({
  checking: { label: 'Checking the environment', short: 'Checking', symbol: '...', description: 'Moving, pausing and listening at different points.' },
  'needs-you': { label: 'Needs your attention', short: 'Needs you', symbol: '!', description: 'A pulsing red cross asks for your attention.' },
  ok: { label: 'Ready for quality checks', short: 'Ready', symbol: 'ok', description: 'The environment is ready. Quality checks can begin.' },
  error: { label: 'Unable to diagnose', short: 'Diagnostic error', symbol: 'x', description: 'A steady illuminated X: the diagnosis could not finish.' }
});

function roundedShape(width, height, radius, centerY = 0) {
  const s = new THREE.Shape(), x = -width / 2, y = centerY - height / 2, r = radius;
  s.moveTo(x + r, y); s.lineTo(x + width - r, y);
  s.quadraticCurveTo(x + width, y, x + width, y + r); s.lineTo(x + width, y + height - r);
  s.quadraticCurveTo(x + width, y + height, x + width - r, y + height); s.lineTo(x + r, y + height);
  s.quadraticCurveTo(x, y + height, x, y + height - r); s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y); return s;
}

/** A continuous tube updated in place: no geometry/material allocation per frame. */
class FlexibleTube {
  constructor(parent, points, radius, material) {
    this.points = points.map(p => V(...p));
    this.curve = new THREE.CubicBezierCurve3(...this.points);
    this.geometry = new THREE.TubeGeometry(this.curve, 54, radius, 12, false);
    // Our radial frame uses +cos, while TubeGeometry authors -cos. Reverse the
    // inherited winding once so the opaque hose renders its OUTSIDE surface.
    const indices=this.geometry.index;
    for(let i=0;i<indices.count;i+=3){const b=indices.getX(i+1);indices.setX(i+1,indices.getX(i+2));indices.setX(i+2,b);}
    this.geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
    this.geometry.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    this.mesh = new THREE.Mesh(this.geometry, material); this.mesh.name = 'continuous-stethoscope-hose';
    this.mesh.frustumCulled = false; parent.add(this.mesh);
    this.radius = radius; this.p = V(); this.t = V(); this.n = V(); this.b = V(); this.reference = V(0, 0, 1);
  }
  update(points) {
    points.forEach((p, i) => this.points[i].copy(p)); this.curve.updateArcLengths();
    const position = this.geometry.attributes.position, normal = this.geometry.attributes.normal;
    for (let i = 0; i <= 54; i++) {
      this.curve.getPointAt(i / 54, this.p); this.curve.getTangentAt(i / 54, this.t).normalize();
      this.n.crossVectors(this.t, this.reference).normalize();
      if (this.n.lengthSq() < .001) this.n.set(1, 0, 0);
      this.b.crossVectors(this.t, this.n).normalize();
      for (let j = 0; j <= 12; j++) {
        const a = j / 12 * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), k = i * 13 + j;
        const nx = this.n.x * c + this.b.x * s, ny = this.n.y * c + this.b.y * s, nz = this.n.z * c + this.b.z * s;
        position.setXYZ(k, this.p.x + nx * this.radius, this.p.y + ny * this.radius, this.p.z + nz * this.radius);
        normal.setXYZ(k, nx, ny, nz);
      }
    }
    position.needsUpdate = normal.needsUpdate = true;
  }
}

function construct() {
  const root = group(); root.name = 'jgates-doctor';
  const body = group(root, [0, 1.46, 0]), skin = group(body);
  const red = vinyl('#c2443c'), ivory = vinyl('#f4e5cd'), amber = vinyl('#e8b85e');
  const burgundy = vinyl('#874d60', { roughness: .52, clearcoat: .12 });
  const pale = vinyl('#e4dfd8', { roughness: .38, clearcoat: .24 });
  const gray = vinyl('#b8bec1', { roughness: .48, clearcoat: .16 });
  const morphs = [];
  const shell = deformable(box(skin, [2.16, 1.92, .90], red, [0, 0, 0], .28)); shell.name = 'medical-case-shell'; morphs.push(shell);
  const panel = deformable(extrusion(skin, roundedShape(1.92, 1.72, .28), .08, ivory, [0, 0, .46], .065));
  panel.name = 'ivory-case-front'; morphs.push(panel);
  // A shallow inlay reads as the lid seam without splitting the face into slabs.
  tube(skin, [[-.95, .43, .565], [0, .43, .565], [.95, .43, .565]], .012, vinyl('#bda497', { roughness: .6 }));
  const handleShape = roundedShape(1.15, .65, .20, 1.14);
  const hole = roundedShape(.78, .34, .11, 1.15);
  handleShape.holes.push(new THREE.Path(hole.getPoints(30).reverse()));
  const handle = extrusion(skin, handleShape, .25, red, [0, 0, -.02], .055); handle.name = 'case-handle';
  for (const side of [-1, 1]) box(skin, [.20, .26, .105], amber, [side * .62, .43, .62], .045);
  const plus = new THREE.Shape();
  [[-.065,.21],[.065,.21],[.065,.065],[.21,.065],[.21,-.065],[.065,-.065],[.065,-.21],[-.065,-.21],[-.065,-.065],[-.21,-.065],[-.21,.065],[-.065,.065]].forEach(([x,y],i) => i ? plus.lineTo(x,y) : plus.moveTo(x,y));
  plus.closePath();
  const emblem=group(skin,[0,.68,.60]);emblem.name='illuminated-medical-emblem';emblem.scale.setScalar(.8);
  const lampMaterial=red.clone();lampMaterial.emissiveIntensity=0;
  extrusion(emblem,plus,.05,lampMaterial,[0,0,0],.025);
  // A separate halo lights the surround without replacing the lens's red pigment.
  const pixels=new Uint8Array(64*64*4);
  for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    const px=Math.abs((x/63-.5)*.8),py=Math.abs((y/63-.5)*.8);
    const d=Math.min(Math.hypot(Math.max(0,px-.065),Math.max(0,py-.21)),Math.hypot(Math.max(0,px-.21),Math.max(0,py-.065)));
    const k=(y*64+x)*4;pixels[k]=pixels[k+1]=pixels[k+2]=255;pixels[k+3]=Math.round(210*Math.exp(-((d/.085)**2)));
  }
  const glowTexture=new THREE.DataTexture(pixels,64,64);glowTexture.needsUpdate=true;glowTexture.magFilter=glowTexture.minFilter=THREE.LinearFilter;
  const halo=new THREE.Mesh(new THREE.PlaneGeometry(.8,.8),new THREE.MeshBasicMaterial({map:glowTexture,color:'#ff1a0b',transparent:true,opacity:0,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false}));
  halo.position.z=-.025;emblem.add(halo);
  const eyes = face(skin, { z: .60, y: -.08, spacing: .27 });
  const arms = [-1, 1].map(side => arm(skin, side, red, 1.0, .53));
  arms.forEach(a => { a.anchor.y = -.16; a.anchor.z = .04; a.hand.scale.setScalar(1.10); });
  const feet = [-1, 1].map(side => boot(root, red, [side * .56, .16, .10], .75));
  const legs = [-1, 1].map(side => ({ ...segment(root, red, .19), side, top: V(side * .56, -.78, 0) }));
  // Wear the olives at the two sides of the head. There are no anatomical ears.
  const ears = group(skin); ears.name = 'worn-stethoscope-binaural-assembly';
  const earTips = [], binaurals = [];
  for (const side of [-1, 1]) {
    binaurals.push(tube(ears, [[side*1.16,.15,.14],[side*1.19,.10,.43],[side*1.10,-.23,.78],[side*.78,-.60,.78],[side*.16,-.61,.78]], .043, pale));
    const tip = ball(ears, [.075,.085,.075], ivory, [side*1.16,.15,.14]); tip.name = `ear-tip-${side < 0 ? 'left' : 'right'}`; earTips.push(tip);
    tube(ears, [[side*.16,-.61,.78],[side*.08,-.67,.79],[0,-.70,.80]], .055, burgundy);
  }
  const joint = group(ears, [0,-.70,.80]); joint.name = 'stethoscope-y-outlet';
  const junction=ball(ears,.071,burgundy,[0,-.70,.80]);junction.name='solid-y-junction';
  const puck = group(skin); puck.name = 'auscultation-chestpiece';
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(.225,.225,.09,48), ivory); rim.rotation.x = Math.PI / 2; puck.add(rim);
  const diaphragm = new THREE.Mesh(new THREE.CylinderGeometry(.183,.183,.014,48), gray); diaphragm.rotation.x = Math.PI / 2; diaphragm.position.z = .052; puck.add(diaphragm);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.184,.010,10,48), pale); ring.position.z = .063; puck.add(ring);
  // The hose and the curved terminal stem are ONE surface. No separately joined elbow.
  const inlet = group(puck, [-.205,-.01,0]); inlet.name = 'chestpiece-hose-inlet';
  const socket=tube(puck,[[-.27,-.01,0],[-.205,-.01,0],[-.17,-.01,0]],.064,gray);socket.name='chestpiece-solid-hose-socket';
  const endGuide=group(puck,[-.48,-.01,0]);
  const hosePoints = Array.from({length:4},()=>V());
  const hose = new FlexibleTube(skin, [[0,-.55,.71],[-.10,-.87,.83],[.7,-.3,.8],[1.2,.1,.8]], .052, burgundy);
  return { root, body, skin, morphs, arms, feet, legs, eyes, ears, earTips, binaurals, joint, puck, inlet, endGuide, hose, hosePoints, emblem, lampMaterial, halo, glowTexture };
}

export class DoctorMascot extends EventTarget {
  constructor({ state = 'checking', reducedMotion = false, elasticity = 1 } = {}) {
    super();
    if (!Object.hasOwn(DOCTOR_STATES,state)) throw new TypeError(`Unknown Doctor state: ${state}`);
    if (!Number.isFinite(elasticity)) throw new TypeError('Elasticity must be finite');
    this.rig = construct(); this.object = this.rig.root;
    this.state = 'checking'; this.reason = ''; this.reducedMotion = !!reducedMotion;
    this.elasticity = clamp(elasticity,0,1.5); this.time = 0; this.age = 10; this.examTime=0;
    this.springs = new Map(); this.disposed = false; this.snapNext = true;
    this.setState(state); this.update(0);
  }
  setState(state, { reason = '' } = {}) {
    if (this.disposed) throw new Error('Doctor is disposed');
    if (!Object.hasOwn(DOCTOR_STATES, state)) throw new TypeError(`Unknown Doctor state: ${state}`);
    const changed = state !== this.state; this.reason = String(reason);
    if (changed) { this.state = state; this.age = 0; if(state==='checking')this.examTime=0; }
    if (this.reducedMotion) this.snapNext = true;
    if (changed) this.dispatchEvent(new CustomEvent('statechange', { detail: { state, reason: this.reason } }));
    return this;
  }
  setReducedMotion(value) { this.reducedMotion = !!value; this.snapNext = true; this.update(0); return this; }
  replay() { if (this.disposed) throw new Error('Doctor is disposed'); this.age = 0; return this; }
  spring(key, target, dt, stiffness = 125, damping = 20) {
    let s = this.springs.get(key);
    if (!s) { s = new Spring(target, stiffness, damping); this.springs.set(key, s); }
    return this.snapNext || this.reducedMotion ? s.snap(target) : s.step(target, dt);
  }
  update(delta) {
    if (this.disposed) return;
    if (!Number.isFinite(delta) || delta < 0) throw new TypeError('Delta must be a finite non-negative number');
    const dt = Math.min(delta,.05), reduced = this.reducedMotion;
    if (!reduced) { this.time += dt; this.age += dt; }
    const t = reduced ? 1.3 : this.time, age = reduced ? 10 : this.age;
    const checking = this.state === 'checking', help = this.state === 'needs-you', ok = this.state === 'ok', error = this.state === 'error';
    const r = this.rig;
    if(checking&&!reduced)this.examTime+=dt;
    this.listening=auscultationPose(reduced?1.4:this.examTime);
    const jump = ok && age < 1.15 && !reduced ? Math.sin(Math.PI * clamp((age - .26)/.72)) ** 2 * .19 : 0;
    const anticipation = ok && !reduced ? pulse(age,.17,.10) * -.055 : 0;
    const recoil = error && !reduced ? pulse(age,.24,.15) : 0;
    const breathe = reduced ? 0 : Math.sin(t*1.65)*.014;
    const listen = checking && !reduced ? (pulse(t%4.8,1.25,.15)+pulse(t%4.8,1.63,.15)) : 0;
    r.body.position.y = this.spring('body-y',1.46+breathe+jump+anticipation-recoil*.065,dt,150,20);
    r.body.rotation.z = this.spring('body-roll',help ? .065 : error ? -.065 : checking ? -.018+Math.sin(t*1.1)*.018 : -.02,dt,100,18);
    r.body.rotation.x = this.spring('body-pitch',error ? .035+recoil*.045 : checking ? .015+listen*.014 : 0,dt);
    const acceleration = this.springs.get('body-y')?.acceleration ?? 0;
    const squash = this.spring('squash',reduced ? 0 : clamp(-acceleration*.004 + listen*.035,-.18,.22)*this.elasticity,dt,155,18);
    r.skin.scale.set(1+squash*.045,1-squash*.06,1+squash*.025);
    r.morphs.forEach(m => { m.morphTargetInfluences[0] = squash*.55; });
    for (let i=0;i<2;i++) {
      r.feet[i].position.y = this.spring(`foot-y-${i}`,.16+jump*.92,dt,175,22);
      r.feet[i].rotation.z = this.spring(`foot-roll-${i}`,ok ? (i ? -.05:.05) : 0,dt);
    }
    const wave = help && !reduced ? Math.sin(t*3.6)*Math.exp(-1.25*(t%5.4)) : 0;
    const leftRest=this.spring('left-rest',checking?1:0,dt,155,22);
    const leftTarget = help ? [-1.57,.50,.58] : ok ? [-1.57,.17,.49] : error ? [-1.57,.02,.57] : [-1.36,-.74,.38];
    const rightTarget = checking ? this.listening.position.map((n,i)=>n-[.025,.255,.105][i]) : [1.40,error ? -.12:.10,1.15];
    [leftTarget,rightTarget].forEach((target,i) => {
      const xyz = target.map((n,j) => this.spring(`hand-${i}-${j}`,n,dt,155,22));
      // Keep the lifting/lowering path outside the ear tubes, then settle close
      // to the body. The free hand's fingers point down in its resting pose.
      if(!i)xyz[0]-=.16*4*leftRest*(1-leftRest);
      const roll = this.spring(`wrist-${i}`,i ? -.20 : help ? -.33+wave*.20 : ok ? -.58 : error ? -.28 : Math.PI-.08,dt);
      r.arms[i].reach(...xyz,roll,i?0:leftRest);
      if(!i)r.arms[i].hand.rotation.y=leftRest*.35;
    });
    // The disc rests on the upper edge of the mitten. Its lateral inlet stays exposed.
    r.puck.position.copy(r.arms[1].hand.position).add(V(.025,.255,.105));
    r.puck.rotation.set(0,-.10,error ? -.15 : -.06);
    // The worn binaural assembly follows the head exactly; it does not swing off its contact points.
    r.root.updateMatrixWorld(true);
    for (let i=0;i<2;i++) {
      const leg = r.legs[i], foot = r.feet[i];
      const top = r.root.worldToLocal(r.skin.localToWorld(leg.top.clone()));
      leg.set(top,V(foot.position.x,foot.position.y+.10,foot.position.z-.05));
    }
    r.root.updateMatrixWorld(true);
    const start = r.skin.worldToLocal(r.joint.getWorldPosition(V()));
    const end = r.skin.worldToLocal(r.inlet.getWorldPosition(V()));
    const p = r.hosePoints;
    // A single cubic sag avoids knots or hairpin bends as the hand changes position.
    // Its final tangent is authored in the chestpiece frame, so it enters the rim smoothly.
    // Move forward before crossing the lower binaural arch, rather than intersecting it.
    p[0].copy(start);p[1].copy(start).add(V(0,-.30,.42));
    p[2].copy(r.skin.worldToLocal(r.endGuide.getWorldPosition(V())));p[3].copy(end);
    r.hose.update(p);
    const lampPulse=help ? (reduced?.9:.06+.94*((1-Math.cos(t*Math.PI*2/1.65))/2)**2) : error?.95:0;
    const power=this.spring('lamp-power',lampPulse,dt,150,23);
    r.emblem.rotation.z=this.spring('emblem-turn',error?Math.PI/4:0,dt,95,20);
    r.emblem.scale.setScalar(.8*this.spring('emblem-size',error?1.20:1,dt,120,21));
    // The lens keeps exactly the same material in all states. Animate only the
    // separate surrounding glow, not the lens's pigment, emission or tone mapping.
    r.halo.material.opacity=power*1.10;
    const f = r.eyes;
    f.group.position.x = f.baseX + this.spring('gaze-x',checking ? this.listening.position[0]*.05-.02 : help ? -.045 : error ? -.025 : 0,dt,90,19);
    f.group.position.y = f.baseY + this.spring('gaze-y',checking ? this.listening.position[1]*.055 : help ? .035 : error ? -.035 : .01,dt);
    const blink = reduced ? 1 : 1-pulse(t%4.7,.32,.07)*.94;
    const happy = this.spring('happy',ok ? 1:0,dt,100,20);
    const worried = this.spring('worried',error ? .80 : help ? .30 : 0,dt);
    f.eyes.forEach((eye,i) => {
      eye.scale.y = Math.max(.04,blink*(error ? 1.1 : checking ? .88 : help && !i ? .86 : 1)*(1-happy*.94));
      eye.rotation.z = this.spring(`eye-roll-${i}`,(i ? -1:1)*worried*.16,dt);
      f.happy[i].material.opacity = happy;
      f.brows[i].material.opacity = error ? worried*.72 : 0;
      f.brows[i].rotation.z = (i ? -1:1)*.30*worried;
    });
    this.snapNext = false; r.root.updateMatrixWorld(true);
  }
  inspect() {
    const r = this.rig, start = r.skin.localToWorld(r.hose.points[0].clone()), end = r.skin.localToWorld(r.hose.points.at(-1).clone());
    return { state:this.state, reducedMotion:this.reducedMotion, age:this.age, time:this.time,
      listening:{...this.listening},emblem:{angle:r.emblem.rotation.z,scale:r.emblem.scale.x,light:this.springs.get('lamp-power')?.value},
      arms:r.arms.length, earTips:r.earTips.length, bodyY:r.body.position.y,
      expression:{ happy:this.springs.get('happy')?.value, worried:this.springs.get('worried')?.value },
      instrument:{ outletGap:start.distanceTo(r.joint.getWorldPosition(V())), inletGap:end.distanceTo(r.inlet.getWorldPosition(V())),
        hoseMinY:Math.min(...r.hose.curve.getPoints(24).map(p=>p.y)), tips:r.earTips.map(o=>o.getWorldPosition(V()).toArray()),
        disc:r.puck.getWorldPosition(V()).toArray(), hands:r.arms.map(a=>a.hand.getWorldPosition(V()).toArray()) },
      finite:[...this.springs.values()].every(s=>Number.isFinite(s.value)&&Number.isFinite(s.velocity)) };
  }
  dispose() { if (!this.disposed) { disposeTree(this.object);this.rig.glowTexture.dispose(); this.springs.clear(); this.disposed=true; } }
}
