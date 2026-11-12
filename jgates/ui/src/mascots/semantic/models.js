import * as THREE from 'three';
import { vinyl, group, boot, segment, face, V } from '../actors/geometry.js';
import { buildObject } from './objects.js';
import { createCapsule } from './indicators.js';
import { mascotArm } from './sculpt.js';

// Family assembly of one Semantic mascot, copied from the "thinking team" study (src/models.js) for the shipped
// appearance only: satin vinyl (roughness .32, clearcoat .48), palette direction B and the clear brain capsule. The other
// appearance modes, constructions and Fit's fitting sequence are not part of the product.

/** Builds the static model of one mascot from its catalog entry ({ shape, color, bodyColor | bodyHue }). */
export function createModel(spec) {
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
  const rig = buildObject(body, p, spec.shape);
  body.position.y = rig.bodyY ?? 1.40;

  const features = face(rig.faceHost, rig.eyes);
  features.group.scale.setScalar(rig.faceScale ?? 1);
  const arms = (rig.noArms ? [] : [-1, 1]).map((side, i) => mascotArm(body, side, main, rig.anchors?.[i] ?? [side * rig.shoulder, -.10, 0], { direction: rig.handDirections?.[i] }));
  arms.forEach((a, i) => { a.sleeve.name = `arm-${i}`; a.hand.name = `mitten-${i}`; a.reach(...rig.hands[i]); });
  rig.pose?.(arms);
  for (const side of rig.noFeet ? [] : [-1, 1]) {
    const foot = boot(root, main, [side * rig.footX, .20, .09], .58); foot.name = `boot-${side}`;
    const top = rig.legTops?.[side < 0 ? 0 : 1] ?? [side * rig.footX, rig.bottom, 0];
    const leg = segment(root, main, .17); leg.set(V(side * rig.footX, .27, .03), V(top[0], body.position.y + top[1], top[2]));
  }
  createCapsule({ ...rig, body }, p);
  return root;
}
