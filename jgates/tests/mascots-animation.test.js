import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mascot } from '../ui/src/mascots/actors/characters.js';
import { DOMAINS, STATUSES } from '../ui/src/mascots/actors/status.js';
import { Spring, jugglePose, juggleHandPose, architecturePose, architectureOrder } from '../ui/src/mascots/actors/motion.js';
import { Vector3 } from 'three';

const advance = (actor, seconds, dt = 1 / 60) => { for (let t = 0; t < seconds; t += dt) actor.update(dt); };
test('all six procedural rigs have two arms, real morphs and finite poses across all statuses', () => {
  for (const domain of Object.keys(DOMAINS)) {
    const a = new Mascot(domain);
    assert.equal(a.rig.arms.length, 2, domain);
    assert.ok(a.rig.morphs.every(m => m.geometry.morphAttributes.position.length > 0), domain);
    for (const status of Object.keys(STATUSES)) {
      a.setStatus(status); advance(a, 1.6);
      assert.equal(a.inspect().status, status); assert.ok(a.inspect().finite, `${domain}/${status}`);
    }
    a.setStatus('passed'); advance(a, 1.5); assert.ok(a.inspect().expression.happy > .95);
    a.setStatus('failed'); advance(a, 1.5); assert.ok(a.inspect().expression.worried > .95);
    a.dispose(); assert.throws(() => a.setStatus('processing'));
  }
});

test('three boxes juggle, settle at rest without teleporting, and survive rapid interruptions', () => {
  const a = new Mascot('dependencies'); a.setStatus('processing'); advance(a, 2.1);
  const before = a.inspect().packages;
  advance(a, .3); assert.notDeepEqual(a.inspect().packages, before);
  a.setStatus('failed');
  let previous = a.inspect().packages;
  for (let frame = 0; frame < 240; frame++) {
    a.update(1 / 60); const next = a.inspect().packages;
    for (let i = 0; i < 3; i++) assert.ok(Math.hypot(...next[i].map((n, j) => n - previous[i][j])) < .40, 'no position teleport');
    previous = next;
  }
  const rest = [[-1.22, .28, .94], [.08, .28, 1.38], [1.10, .28, .70]];
  a.inspect().packages.forEach((p, i) => p.forEach((v, j) => assert.ok(Math.abs(v - rest[i][j]) < .03)));
  for (let i = 0; i < 30; i++) { a.setStatus(i % 2 ? 'passed' : 'processing'); advance(a, .1); }
  assert.ok(a.inspect().finite); a.dispose();
});

test('wrists share the real parcel position during every catch and throw', () => {
  const a = new Mascot('dependencies'); a.setStatus('processing');
  const catches = [0, 0];
  let previousHands = null;
  for (let frame = 0; frame < 720; frame++) {
    a.update(1 / 60);
    const hands = a.inspect().hands;
    if (previousHands) hands.forEach((point, i) => assert.ok(Math.hypot(...point.map((n, j) => n - previousHands[i][j])) < .16, 'no wrist teleport at catch or release'));
    previousHands = hands;
    for (let hand = 0; hand < 2; hand++) {
      const pose = juggleHandPose(a.actionTime, hand ? 1 : -1);
      if (pose.held < 0) continue;
      const box = a.rig.pieces.packages[pose.held].getWorldPosition(new Vector3());
      const palm = a.rig.arms[hand].hand.getWorldPosition(new Vector3());
      assert.ok(palm.distanceTo(box.clone().add(new Vector3(0, -.36, .015))) < .001, 'palm remains under held parcel');
      catches[hand]++;
    }
  }
  assert.ok(catches.every(n => n > 60)); a.dispose();
});

test('every architecture block emerges at the waist and is carried before stacking', () => {
  const a = new Mascot('architecture'); a.setStatus('processing');
  const carried = [0, 0, 0], pickedUp = [false, false, false];
  for (let frame = 0; frame < 650; frame++) {
    a.update(1 / 60);
    for (let i = 0; i < 3; i++) {
      const pose = architecturePose(a.actionTime, i);
      if (pose.phase === 'pickup') {
        pickedUp[i] = true; assert.ok(pose.position[1] < 0, 'pickup is at waist, not atop stack');
      }
      if (!pose.held) continue;
      carried[i]++;
      const block = a.rig.pieces.blocks[i];
      const grip = block.position.clone().add(new Vector3(block.userData.width * block.scale.x * .40, -.03, .57));
      const expected = a.rig.skin.localToWorld(grip);
      assert.ok(expected.distanceTo(a.rig.arms[1].hand.getWorldPosition(new Vector3())) < .001, `contact with block ${i}`);
      // The forearm is routed ahead of the front face of the lower blocks.
      const vertices = a.rig.arms[1].sleeve.geometry.attributes.position;
      for (let j = 0; j < vertices.count; j++) {
        const x = vertices.getX(j), y = vertices.getY(j), z = vertices.getZ(j);
        for (let k = 0; k < i; k++) {
          const lower = a.rig.pieces.blocks[k];
          if (Math.abs(y - lower.position.y) < .13 && Math.abs(x) < lower.userData.width / 2) assert.ok(z > .40, 'arm clears lower block front');
        }
      }
    }
  }
  assert.deepEqual(pickedUp, [true, true, true]); assert.ok(carried.every(n => n > 90)); a.dispose();
});

test('body connections track the deformed skin and moving server module', () => {
  for (const domain of Object.keys(DOMAINS)) {
    const a = new Mascot(domain); a.setStatus('passed');
    for (let frame = 0; frame < 90; frame++) {
      a.update(1 / 60);
      a.rig.legs.forEach((leg, i) => {
        const expected = a.rig.skin.localToWorld(leg.top.clone());
        const foot = a.rig.feet[i];
        const bottom = a.object.localToWorld(new Vector3(foot.position.x, foot.position.y + .10, foot.position.z - .05));
        const midpoint = leg.mesh.getWorldPosition(new Vector3());
        assert.ok(midpoint.distanceTo(expected.clone().add(bottom).multiplyScalar(.5)) < .001, `${domain} attached leg`);
      });
    }
    assert.ok(a.rig.arms.every(arm => arm.parent === (domain === 'infrastructure' ? a.rig.pieces.slabs[1] : a.rig.skin)));
    a.dispose();
  }
});

test('disabled and not applicable are gray and resting, then restore their palette', () => {
  for (const domain of Object.keys(DOMAINS)) {
    const a = new Mascot(domain), original = a.rig.mat.color.clone();
    for (const status of ['disabled', 'not_applicable']) {
      a.setStatus(status); advance(a, 3);
      assert.ok(a.inspect().gray > .99);
      const color = a.rig.mat.color;
      assert.ok(Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) < .08);
      const y = a.rig.body.position.y; advance(a, .6);
      assert.ok(Math.abs(a.rig.body.position.y - y) < .001, 'no active bounce');
      assert.ok(a.rig.body.position.y < a.rig.baseY - .17);
    }
    a.setStatus('processing'); advance(a, 3);
    assert.ok(Math.abs(a.rig.mat.color.r - original.r) + Math.abs(a.rig.mat.color.g - original.g) + Math.abs(a.rig.mat.color.b - original.b) < .001);
    assert.ok(a.inspect().gray < .001); a.dispose();
  }
});

test('server signals blink yellow or red while running and stay green or red at completion', () => {
  const a = new Mascot('infrastructure');
  for (const hasFindings of [false, true]) {
    a.setStatus('processing', { hasFindings }); const powers = [];
    for (let i = 0; i < 90; i++) { a.update(1 / 60); powers.push(a.inspect().leds[0].power); }
    assert.ok(Math.min(...powers) < .08 && Math.max(...powers) > .95, 'visible blink');
    assert.equal(a.inspect().leds[0].signal, hasFindings ? 'red' : 'yellow');
    assert.equal(a.status, 'processing');
  }
  for (const [status, signal] of [['passed', 'green'], ['failed', 'red']]) {
    a.setStatus(status); advance(a, 1);
    assert.ok(a.inspect().leds.every(led => led.signal === signal && led.power === 1));
  }
  a.dispose();
});

test('live findings keep marking and recycling lists, rotating the red cross between rows', () => {
  const a = new Mascot('tests');
  a.setStatus('processing', { hasFindings: true });
  const errorRows = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    advance(a, cycle * 4.5 + 2.9 - a.actionTime);
    const result = a.inspect();
    assert.equal(result.checkFailures.filter(Boolean).length, 1);
    errorRows.push(result.checkFailures.indexOf(true));
    assert.equal(result.checkResults.filter(r => r === 'passed').length, 2);
    assert.equal(result.checks.filter(n => n > .5).length, 2);
    const rows = result.checkRows;
    advance(a, .85); assert.notDeepEqual(a.inspect().checkRows, rows, 'new list keeps scrolling with findings');
    advance(a, .65); assert.ok(a.inspect().checks.every(n => n < .015), 'marks clear before next list');
    assert.ok(a.rig.pieces.rows.every(row => row.cross.scale.x < .015));
  }
  assert.deepEqual(errorRows, [0, 1, 2, 0, 1, 2]);
  assert.equal(a.status, 'processing'); assert.ok(a.inspect().expression.worried > .9);
  a.setStatus('failed'); advance(a, 1);
  assert.deepEqual(a.inspect().checkFailures, [true, true, true]); assert.ok(a.inspect().checks.every(n => n < .01));
  a.setStatus('processing'); assert.equal(a.hasFindings, false);
  a.setStage({ state: 'running', blockingViolations: 1 }); assert.equal(a.hasFindings, true); assert.equal(a.status, 'processing');
  assert.throws(() => a.setFindings('yes')); a.dispose();
});

test('architecture keeps building five incorrect orders with findings, and preserves the final error', () => {
  const a = new Mascot('architecture'); a.setStatus('processing', { hasFindings: true });
  const observed = new Set();
  for (let cycle = 0; cycle < 5; cycle++) {
    const target = a.architectureEpoch + cycle * 10.8 + 8.95;
    advance(a, target - a.actionTime);
    const state = a.inspect();
    assert.notDeepEqual(state.blockOrder, [0, 1, 2]);
    const physicalOrder = [0, 1, 2].sort((i, j) => state.blocks[i][1] - state.blocks[j][1]);
    assert.deepEqual(physicalOrder, state.blockOrder, 'geometry follows chosen order, not only metadata');
    assert.ok(state.blockScales.every(n => n > .99));
    observed.add(state.blockOrder.join(','));
  }
  assert.equal(observed.size, 5);
  const wrong = a.inspect().blockOrder;
  a.setStatus('failed'); advance(a, 2);
  assert.deepEqual(a.inspect().blockOrder, wrong);
  assert.deepEqual([0, 1, 2].sort((i, j) => a.inspect().blocks[i][1] - a.inspect().blocks[j][1]), wrong);
  advance(a, 3); assert.deepEqual(a.inspect().blockOrder, wrong, 'failed stack remains wrong');
  a.setStatus('passed'); advance(a, 2); assert.deepEqual(a.inspect().blockOrder, [0, 1, 2]);
  a.dispose();
  for (let cycle = 0; cycle < 50; cycle++) assert.notDeepEqual(architectureOrder(cycle * 10.8 + 1, true), [0, 1, 2]);
  const direct = new Mascot('architecture', { status: 'failed' }); assert.notDeepEqual(direct.inspect().blockOrder, [0, 1, 2]); direct.dispose();
});

test('security scan is a visible moving line and glow', () => {
  const a = new Mascot('security'); a.setStatus('processing'); advance(a, .7);
  const heights = [];
  for (let frame = 0; frame < 120; frame++) { a.update(1 / 60); heights.push(a.inspect().scan.y); }
  assert.ok(a.inspect().scan.opacity > .90); assert.ok(Math.max(...heights) - Math.min(...heights) > .7);
  assert.ok(a.rig.pieces.scanGlow.material.opacity > .20);
  a.setStatus('disabled'); advance(a, 2); assert.ok(a.inspect().scan.opacity < .001); a.dispose();
});

test('architecture stacks, checklist advances and actual progress stops the decorative cycle', () => {
  const arch = new Mascot('architecture'); arch.setStatus('processing'); advance(arch, 1.1); const first = arch.inspect().blocks; advance(arch, 3.9); assert.notDeepEqual(arch.inspect().blocks, first); arch.dispose();
  const a = new Mascot('tests'); a.setStatus('processing'); advance(a, 2.7); assert.ok(a.inspect().checks.some(n => n > .50));
  a.setProgress({ completed: 0, total: 10 }); advance(a, 1); assert.ok(a.inspect().checks.every(n => n < .01));
  a.setProgress({ completed: 10, total: 10 }); advance(a, 1); assert.ok(a.inspect().checks.every(n => n > .50));
  assert.throws(() => a.setProgress({ completed: 11, total: 10 })); a.dispose();
});

test('reduced motion is static; easing springs settle across frame rates', () => {
  const a = new Mascot('dependencies', { reducedMotion: true }); a.setStatus('processing'); a.update(.016); const first = a.inspect(); advance(a, 2); assert.deepEqual(a.inspect(), first); a.dispose();
  for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
    const s = new Spring(0); for (let t = 0; t < 3; t += dt) s.step(1, dt);
    assert.ok(Math.abs(s.value - 1) < .001);
  }
  for (let i = 0; i < 3; i++) for (let t = 0; t < 10; t += .02) {
    const p = jugglePose(t, i); assert.ok([p.x, p.y, p.z].every(Number.isFinite)); assert.ok(p.y >= 1.16 && p.y < 3.1);
  }
});
