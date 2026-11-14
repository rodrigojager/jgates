import * as THREE from 'three';
import { vinyl, group, boot, segment, face, V } from '../actors/geometry.js';
import { buildObject } from './objects.js';
import { createCapsule } from './indicators.js';
import { mascotArm } from './sculpt.js';

// Family assembly of one Semantic mascot, from the "thinking team" study (src/models.js) for the shipped appearance
// only: satin vinyl (roughness .32, clearcoat .48), palette direction B and the clear brain capsule. The other
// appearance modes and constructions are not part of the product. The arms are rubber hoses with a plain mitt, in the
// color of the body. As built, a model is its resting pose; the handles a state animation needs (actor.js) are left in
// `root.userData.rig`.

/**
 * Builds the model of one mascot from its catalog entry ({ shape, color, bodyColor | bodyHue, variants? }). `variant`
 * picks one of the entry's variants; the first is the default.
 */
export function createModel(spec, { variant = spec.variants?.[0] } = {}) {
  const root = group(); root.name = `semantic-mascot-${spec.shape}`;
  const body = group(root, [0, 1.40, 0]);
  const main = vinyl(spec.bodyColor ?? spec.color), dark = main.clone(); dark.color.multiplyScalar(.73);
  const cream = vinyl('#eee3c9');
  const pale = main.clone(); pale.color.lerp(new THREE.Color('#fff2da'), .33);
  if (Number.isFinite(spec.bodyHue)) {
    // Rotate in display-space HSL, not linear RGB, retaining each tonal material's S/L.
    const source = main.color.getHSL({}, THREE.SRGBColorSpace), offset = spec.bodyHue / 360 - source.h;
    for (const material of [main, dark, pale]) {
      const { h, s, l } = material.color.getHSL({}, THREE.SRGBColorSpace);
      material.color.setHSL(THREE.MathUtils.euclideanModulo(h + offset, 1), s, l, THREE.SRGBColorSpace);
    }
  }
  const p = { main, dark, cream, pale, paper: vinyl('#fff5df', { roughness: .55, clearcoat: .12 }), ink: vinyl('#243d35') };
  const rig = buildObject(body, p, spec.shape, variant);
  body.position.y = rig.bodyY ?? 1.40;
  root.scale.setScalar(rig.scale ?? 1);

  const features = face(rig.faceHost, rig.eyes);
  features.group.scale.setScalar(rig.faceScale ?? 1);
  // The arms belong to the part that carries them (the body, or the piece that moves on it).
  const armHost = rig.armHost ?? body;
  const arms = (rig.noArms ? [] : [-1, 1]).map((side, i) => {
    const arm = mascotArm(armHost, side, main, rig.anchors?.[i] ?? [side * rig.shoulder, -.10, 0], { girth: rig.armGirth, flare: rig.armFlare, body: rig.armBody });
    arm.sleeve.name = `arm-${i}`; arm.hand.name = `hand-${i}`;
    arm.rest = [...(rig.hang?.[i] ?? rig.hands[i])];
    arm.rests(...arm.rest);
    arm.reach(...rig.hands[i]);
    return arm;
  });
  const feet = [], legs = [];
  for (const side of rig.noFeet ? [] : [-1, 1]) {
    const foot = boot(root, main, [side * rig.footX, .20, .09], .58); foot.name = `boot-${side}`;
    const top = rig.legTops?.[side < 0 ? 0 : 1] ?? [side * rig.footX, rig.bottom, 0];
    const leg = segment(root, main, .17); leg.set(V(side * rig.footX, .27, .03), V(top[0], body.position.y + top[1], top[2]));
    feet.push(foot); legs.push({ segment: leg, top: V(...top), x: side * rig.footX });
  }
  const capsule = createCapsule({ ...rig, body: rig.capsuleHost ?? body }, p);
  root.userData.rig = { shape: spec.shape, variant, color: spec.color, body, baseY: body.position.y, face: features, arms, armHost, feet, legs, parts: rig.parts, brain: capsule.userData.brain };
  return root;
}
