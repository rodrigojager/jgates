import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mascot } from '../ui/src/mascots/actors/characters.js';
import { jugglePose, restartCascadePose } from '../ui/src/mascots/actors/motion.js';
import { Vector3, Box3 } from 'three';
const advance = (a,s) => {for(let t=0;t<s-1e-7;t+=1/60)a.update(Math.min(1/60,s-t));};

test('inspection alert flashes exactly three times and returns to three complete green scans', () => {
  const a = new Mascot('security'); a.setStatus('processing', {hasFindings:true});
  let flashes=0, wasOn=false, green=0; const heights=[];
  const duration=2.15+3*2*Math.PI/1.7;
  for(let t=0;t<duration-.01;t+=1/120){
    a.update(1/120); const s=a.inspect().scan;
    if(s.red){ const on=s.opacity>.45; if(on&&!wasOn)flashes++;wasOn=on;
      assert.ok(Math.abs(s.textOpacity/ .98-s.opacity/.94)<1e-7,'word and line blink together');
      if(s.power>.4) assert.ok(Math.abs(s.y-.03)<.025,'laser pauses at center before flashing');
    }else{green++;heights.push(s.y);}
  }
  assert.equal(flashes,3);assert.ok(green>1200);assert.ok(Math.max(...heights)-Math.min(...heights)>1);
  advance(a,.15);assert.ok(a.inspect().scan.red,'red alert repeats after green scans');
  a.setFindings(false);advance(a,.3);assert.equal(a.inspect().scan.textOpacity,0);assert.equal(a.inspect().scan.red,false);
  a.setStatus('failed');advance(a,.7);assert.equal(a.inspect().scan.red,true);assert.ok(a.inspect().scan.textOpacity>.9);
  a.setStatus('disabled');advance(a,2);assert.ok(a.inspect().scan.opacity<.001);assert.equal(a.inspect().scan.textOpacity,0);a.dispose();
});

test('dependency drops touch the floor, use the same-side hand, recover and repeat after 2 or 3 loops',()=>{
  for(let cycle=1;cycle<100;cycle++)assert.equal(jugglePose(cycle*3.3-1e-12,0).hand,-1,'rounding at a catch never swaps the pickup side');
  const a=new Mascot('dependencies');a.setStatus('processing',{hasFindings:true});
  const phases=new Set(), drops=[], recoveries=[];let previous=a.inspect(),lastCount=0;
  for(let frame=0;frame<2700;frame++){
    a.update(1/60);const s=a.inspect(), d=s.packageDrop;phases.add(d.phase);
    if(d.phase==='fall'&&previous.packageDrop.phase==='juggling'){drops.push(d.juggleTime);assert.equal(jugglePose(d.juggleTime,0).hand,-1,'drop uses the left catch');}
    if(d.count>lastCount){recoveries.push(d.juggleTime);lastCount=d.count;}
    s.packages.forEach((p,i)=>assert.ok(Math.hypot(...p.map((v,j)=>v-previous.packages[i][j]))<.4,'no parcel teleport'));
    if(frame>0) s.hands.forEach((p,i)=>assert.ok(Math.hypot(...p.map((v,j)=>v-previous.hands[i][j]))<.18,'no wrist teleport'));
    if(['reach','grip'].includes(d.phase)&&d.elapsed>1){assert.ok(s.packages[0][1]>=.295&&s.packages[0][1]<.34,'parcel rests on floor');}
    if(['grip','lift'].includes(d.phase)){
      const box=a.rig.pieces.packages[0].getWorldPosition(new Vector3()), hand=a.rig.arms[0].hand.getWorldPosition(new Vector3());
      assert.ok(hand.x<0&&box.x<0,'left hand retrieves left parcel');assert.ok(hand.distanceTo(box)<.39,'hand stays in contact during pickup');
    }
    assert.ok(s.finite);previous=s;
  }
  assert.ok(['fall','reach','grip','lift','resume','juggling'].every(p=>phases.has(p)));assert.ok(drops.length>=3);assert.ok(recoveries.length>=3);
  for(let i=1;i<drops.length;i++)assert.ok([6.6,9.9].some(n=>Math.abs(n-(drops[i]-recoveries[i-1]))<.03),'2 or 3 full left/right cycles after recovery');
  a.setFindings(false);advance(a,15);assert.equal(a.inspect().packageDrop.phase,'juggling');a.dispose();
});

test('restart holds each parcel until a hand impulse and joins the cascade only after ballistic catches',()=>{
  const base=9.35, launch=[.8635,1.4135,.3135], flight=1.3365;
  for(let t=0;t<3.85;t+=1/240){
    const pose=restartCascadePose(t,base);
    pose.parcels.forEach((p,i)=>{
      if(t<launch[i]){
        assert.equal(p.state,'held');const hand=pose.hands[p.hand<0?0:1];
        assert.ok(Math.hypot(p.x-hand.x,p.y-hand.y-.36-(i===2?.53:0),p.z-hand.z+.015)<1e-9,'supported by the wrist or the box in that wrist');
      }else if(t<launch[i]+flight)assert.equal(p.state,'flight');else{
        assert.equal(p.state,'cascade');const normal=jugglePose(base+t,i);assert.ok(Math.hypot(p.x-normal.x,p.y-normal.y,p.z-normal.z)<1e-9);
      }
    });
  }
  for(let i=0;i<3;i++){
    const before=restartCascadePose(launch[i]-1e-6,base).parcels[i],after=restartCascadePose(launch[i]+1e-6,base).parcels[i];
    assert.ok(Math.hypot(before.x-after.x,before.y-after.y,before.z-after.z)<.00002,'launch begins at actual support position');
    const t=launch[i]+.6, h=.001, a=restartCascadePose(t-h,base).parcels[i],b=restartCascadePose(t,base).parcels[i],c=restartCascadePose(t+h,base).parcels[i];
    assert.ok(Math.abs((a.y-2*b.y+c.y)/(h*h)+13.4/(flight*flight))<1e-6,'released parcel accelerates downwards instead of easing into thin air');
  }
  const a=new Mascot('security');a.setStatus('failed');advance(a,1);
  assert.equal(a.inspect().scan.text,'ERROR');assert.ok(a.inspect().scan.textY-a.inspect().scan.y>.1,'visible margin above laser');a.dispose();
});

test('drop interruptions settle without a teleport, and new alerts respect reduced motion and pause',()=>{
  for(const time of [6.8,8.3,9.2,10.8]){
    const a=new Mascot('dependencies');a.setStatus('processing',{hasFindings:true});advance(a,time);const before=a.inspect().packages;
    a.setStatus('failed');a.update(1/60);assert.ok(a.inspect().packages.every((p,i)=>Math.hypot(...p.map((n,j)=>n-before[i][j]))<.4));advance(a,3);assert.ok(a.inspect().finite);a.dispose();
  }
  for(const domain of ['dependencies','security','quality']){
    const a=new Mascot(domain,{reducedMotion:true});a.setStatus('processing',{hasFindings:true});a.update(.016);const first=a.inspect();advance(a,2);assert.deepEqual(a.inspect(),first);a.dispose();
    const b=new Mascot(domain);b.setStatus('processing',{hasFindings:true});advance(b,8.3);const paused=b.inspect();for(let i=0;i<20;i++)b.update(0);assert.deepEqual(b.inspect(),paused);b.dispose();
  }
});

test('code review star stops at a brace, pulses red three times and resumes inspecting',()=>{
  const a=new Mascot('quality');a.setStatus('processing',{hasFindings:true});let count=0,was=false;
  for(let t=0;t<2.15;t+=1/120){a.update(1/120);const s=a.inspect().reviewAlert,on=s.power>.5;if(on&&!was)count++;was=on;}
  assert.equal(count,3);assert.ok(a.rig.pieces.star.position.y<.05);assert.ok(a.inspect().expression.worried>.9);
  advance(a,.8);assert.equal(a.inspect().reviewAlert.active,false);assert.ok(a.rig.pieces.star.position.y>1);
  assert.equal(a.rig.gold.color.getHexString(),'ffca58');
  advance(a,3*2*Math.PI/2.2);assert.equal(a.inspect().reviewAlert.active,true);
  a.setStatus('passed');advance(a,1);assert.equal(a.inspect().reviewAlert.active,false);a.dispose();
});

test('final dependency failure releases all three parcels to the ground from juggling, pickup or restart',()=>{
  for(const status of ['failed','error','timeout'])for(const before of [2.1,8.25,10.8]){
    const a=new Mascot('dependencies');a.setStatus('processing',{hasFindings:before>6});advance(a,before);
    let previous=a.inspect().packages;a.setStatus(status);a.update(0);assert.deepEqual(a.inspect().packages,previous,'no teleport when failure arrives');
    for(let frame=0;frame<240;frame++){
      a.update(1/60);const s=a.inspect();s.packages.forEach((p,i)=>{assert.ok(Math.hypot(...p.map((n,j)=>n-previous[i][j]))<.4,'fall remains continuous');assert.ok(p[1]>=.28,'never sink below floor');});previous=s.packages;
    }
    assert.ok(a.inspect().parcelsOnGround);const settled=a.inspect().packages;advance(a,1);assert.deepEqual(a.inspect().packages,settled,'all parcels stay down');
    a.rig.pieces.packages.forEach(p=>{const bounds=new Box3().setFromObject(p);assert.ok(bounds.min.y>=.012&&bounds.min.y<.065,'fallen box rests above floor with a flat side');});
    assert.ok(a.inspect().hands.every(h=>h[1]>.5),'hands do not keep holding fallen parcels');
    a.setStatus('passed');advance(a,2);assert.equal(a.inspect().parcelsOnGround,false);assert.ok(a.inspect().packages.every(p=>p[1]>1));a.dispose();
  }
  for(const status of ['failed','error','timeout']){
    const a=new Mascot('dependencies',{status,reducedMotion:true});assert.ok(a.inspect().parcelsOnGround);const s=a.inspect();advance(a,2);assert.deepEqual(a.inspect(),s);a.dispose();
  }
  const a=new Mascot('dependencies');a.setStatus('processing');advance(a,1);a.setStatus('failed');advance(a,.1);
  a.reducedMotion=true;a.update(0);assert.ok(a.inspect().parcelsOnGround);a.reducedMotion=false;advance(a,.1);assert.ok(a.inspect().parcelsOnGround,'disabling reduced motion never relaunches fallen boxes');a.dispose();
});
