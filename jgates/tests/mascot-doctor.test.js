import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DoctorMascot} from '../ui/src/mascots/doctor/doctor.js';
import {auscultationPose,LISTENING_POINTS} from '../ui/src/mascots/doctor/motion.js';
import {Vector3} from 'three';
import {armClearanceProbe} from './fixtures/doctor-clearance.mjs';

const advance=(actor,seconds)=>{for(let t=0;t<seconds-1e-8;t+=1/60)actor.update(Math.min(1/60,seconds-t));};

test('rigid ear tubes clear both sleeves and gloves throughout the performances',()=>{
  const a=new DoctorMascot(),probe=armClearanceProbe(a);
  for(const state of ['checking','needs-you','ok','error','checking','error','needs-you','ok']){
    a.setState(state);
    for(let frame=0;frame<420;frame++){
      a.update(1/60);if(frame%5)continue;
      const gap=probe();assert.ok(gap.minimum>.015,`${state}, frame ${frame}: ${gap.part}, clearance ${gap.minimum}`);
    }
  }
  a.dispose();
});

test('the opaque hose faces outward and the cross keeps its base material in every state',()=>{
  const a=new DoctorMascot(),material=a.rig.lampMaterial;
  const pigment=material.color.getHex(),shading=material.toneMapped;
  const v0=new Vector3(),v1=new Vector3(),v2=new Vector3(),normal=new Vector3(),edge=new Vector3();
  for(const state of ['checking','needs-you','ok','error']){
    a.setState(state);advance(a,1.6);
    assert.equal(material.color.getHex(),pigment);assert.equal(material.toneMapped,shading);
    assert.equal(material.emissiveIntensity,0,'the halo lights up; the base cross material is unchanged');
    const hose=a.rig.hose.mesh;assert.equal(hose.material.transparent,false);assert.equal(hose.material.opacity,1);
    const {index,attributes:{position,normal:normals}}=hose.geometry;
    for(let i=0;i<index.count;i+=3*91){
      const j=index.getX(i),k=index.getX(i+1),l=index.getX(i+2);
      v0.fromBufferAttribute(position,j);v1.fromBufferAttribute(position,k);v2.fromBufferAttribute(position,l);
      normal.fromBufferAttribute(normals,j);
      edge.subVectors(v1,v0).cross(v2.sub(v0));
      assert.ok(edge.dot(normal)>0,`inward-facing hose triangle in ${state}`);
    }
  }
  a.dispose();
});

test('the moving hose clears both rigid ear tubes in every pose and transition',()=>{
  const a=new DoctorMascot();
  const archPoints=a.rig.binaurals.flatMap(m=>m.geometry.parameters.path.getPoints(120));
  const radii=a.rig.hose.radius+a.rig.binaurals[0].geometry.parameters.radius;
  for(const state of ['checking','needs-you','ok','error','checking','error','needs-you','ok']){
    a.setState(state);
    for(let frame=0;frame<420;frame++){
      a.update(1/60);if(frame%5)continue;
      for(const p of a.rig.hose.curve.getPoints(90))for(const q of archPoints){
        assert.ok(p.distanceTo(q)-radii>.035,`hose intersects an ear tube in ${state} at frame ${frame}`);
      }
    }
  }
  a.dispose();
});

test('both ends of the stethoscope stay attached during every state and rapid interruptions',()=>{
  const a=new DoctorMascot();
  const ids=[];a.object.traverse(o=>{if(o.geometry)ids.push(o.geometry.uuid);});
  for(let cycle=0;cycle<3;cycle++)for(const state of ['checking','needs-you','ok','error']){
    a.setState(state);
    for(let i=0;i<25;i++){
      a.update(1/60);const s=a.inspect();
      assert.ok(s.finite);assert.equal(s.arms,2);assert.equal(s.earTips,2);
      assert.ok(s.instrument.outletGap<1e-7);assert.ok(s.instrument.inletGap<1e-7);
      assert.ok(s.instrument.hoseMinY>-.85,'hose stays above the case bottom, away from the crotch');
      const tips=s.instrument.tips;assert.ok(Math.hypot(...tips[0].map((n,j)=>n-tips[1][j]))>.20,'ear tips remain visibly separate');
      const disc=s.instrument.disc,hand=s.instrument.hands[1];
      assert.ok(Math.hypot(...disc.map((n,j)=>n-hand[j]))<.4,'disc stays supported by the hand');
    }
  }
  const after=[];a.object.traverse(o=>{if(o.geometry)after.push(o.geometry.uuid);});
  assert.deepEqual(after,ids,'animation reuses its authored geometry');a.dispose();
});

test('state changes preserve the current pose and settle smoothly',()=>{
  const a=new DoctorMascot();advance(a,.4);const before=a.inspect();
  a.setState('needs-you');assert.deepEqual(a.inspect().instrument.hands,before.instrument.hands);
  a.update(1/60);const after=a.inspect();
  assert.ok(Math.abs(before.bodyY-after.bodyY)<.025);
  assert.ok(Math.hypot(...after.instrument.hands[0].map((n,j)=>n-before.instrument.hands[0][j]))<.06);
  advance(a,2);assert.equal(a.state,'needs-you');assert.ok(a.inspect().finite);a.dispose();
});

test('ready celebrates once; repeated host notifications do not restart it',()=>{
  const a=new DoctorMascot();a.setState('ok');let peak=0;
  for(let i=0;i<120;i++){a.update(1/60);peak=Math.max(peak,a.inspect().bodyY);}
  assert.ok(peak>1.58);const age=a.age;a.setState('ok');assert.equal(a.age,age);
  advance(a,2);assert.ok(a.inspect().bodyY<1.50);assert.ok(a.inspect().expression.happy>.99);
  a.replay();assert.equal(a.age,0);advance(a,.65);assert.ok(a.inspect().bodyY>1.56);a.dispose();
});

test('reduced motion switches immediately to a stable, expressive pose',()=>{
  const a=new DoctorMascot({reducedMotion:true});
  for(const state of ['checking','needs-you','ok','error']){
    a.setState(state);a.update(0);const before=a.inspect();advance(a,.4);
    assert.deepEqual(a.inspect(),before);
    if(state==='ok')assert.equal(before.expression.happy,1);
    if(state==='error')assert.ok(before.expression.worried>.7);
  }
  a.setReducedMotion(false);advance(a,.3);assert.ok(a.time>0);a.dispose();
});

test('invalid input is rejected before modifying the current state',()=>{
  const a=new DoctorMascot();assert.throws(()=>a.setState('passed'),/Unknown Doctor state/);assert.equal(a.state,'checking');
  assert.throws(()=>a.update(NaN),/finite/);assert.throws(()=>a.update(-1),/finite/);
  a.dispose();a.dispose();assert.throws(()=>a.setState('ok'),/disposed/);
});

test('checking visits three separate points and dwells at each before returning',()=>{
  for(let i=0;i<3;i++){
    const early=auscultationPose(i*2.1+1.0),late=auscultationPose(i*2.1+1.8);
    assert.ok(early.holding&&late.holding);assert.deepEqual(early.position,LISTENING_POINTS[i]);assert.deepEqual(late.position,LISTENING_POINTS[i]);
  }
  assert.deepEqual(auscultationPose(1).position,auscultationPose(7.3).position);
  const a=new DoctorMascot();const positions=[];
  for(let i=0;i<3;i++){
    advance(a,i===0?1.8:2.1);positions.push(a.inspect().instrument.disc);
  }
  assert.ok(Math.hypot(...positions[0].map((n,j)=>n-positions[1][j]))>.45);
  assert.ok(Math.hypot(...positions[1].map((n,j)=>n-positions[2][j]))>.35);a.dispose();
});

test('attention pulses the cross; diagnostic error holds a larger illuminated X',()=>{
  const a=new DoctorMascot();a.setState('needs-you');advance(a,1);const values=[];
  for(let i=0;i<100;i++){a.update(1/60);values.push(a.inspect().emblem.light);}
  assert.ok(Math.max(...values)-Math.min(...values)>.6);assert.ok(Math.abs(a.inspect().emblem.angle)<.01);
  a.setState('error');advance(a,2);const before=a.inspect().emblem;advance(a,.8);const after=a.inspect().emblem;
  assert.ok(Math.abs(after.angle-Math.PI/4)<.002);assert.ok(after.scale>.94);assert.ok(after.light>.9);
  assert.ok(Math.abs(before.light-after.light)<.001,'error illumination does not blink');
  a.setState('checking');advance(a,2);assert.ok(a.inspect().emblem.light<.001);assert.ok(Math.abs(a.inspect().emblem.angle)<.002);a.dispose();
});
