import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export function vinyl(color, options = {}) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: .32, metalness: 0, clearcoat: .48, clearcoatRoughness: .3, ...options });
}
export function mesh(geometry, material, parent, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(geometry, material);
  o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true;
  parent?.add(o); return o;
}
export function box(parent, size, mat, pos = [0, 0, 0], radius = .12) {
  const geo = new RoundedBoxGeometry(...size, 5, Math.min(radius, Math.min(...size) * .48));
  return mesh(geo, mat, parent, ...pos);
}
export function ball(parent, size, mat, pos = [0, 0, 0]) {
  const o = mesh(new THREE.SphereGeometry(1, 32, 24), mat, parent, ...pos);
  o.scale.set(...(Array.isArray(size) ? size : [size, size, size])); return o;
}
export function group(parent, pos = [0, 0, 0]) {
  const g = new THREE.Group(); g.position.set(...pos); parent?.add(g); return g;
}
export function extrusion(parent, shape, depth, mat, pos = [0, 0, 0], bevel = .06) {
  let geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 6, curveSegments: 28, steps: 1 });
  // ExtrudeGeometry duplicates face vertices. Weld before recomputing normals so
  // broad vinyl bevels shade continuously rather than as concentric flat strips.
  geo.deleteAttribute('normal'); geo.deleteAttribute('uv');
  const welded = mergeVertices(geo, .00001); geo.dispose(); geo = welded;
  geo.computeVertexNormals();
  geo.translate(0, 0, -depth / 2);
  return mesh(geo, mat, parent, ...pos);
}
export function deformable(o) {
  // Actual GPU morph target, authored procedurally; no external model.
  const p = o.geometry.attributes.position;
  const squash = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    squash[i * 3] = p.getX(i) * .055;
    squash[i * 3 + 1] = -p.getY(i) * .10;
    squash[i * 3 + 2] = p.getZ(i) * .055;
  }
  o.geometry.morphAttributes.position = [new THREE.BufferAttribute(squash, 3)];
  o.geometry.morphTargetsRelative = true; o.updateMorphTargets();
  return o;
}
export function tube(parent, points, radius, mat) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => V(...p)));
  return mesh(new THREE.TubeGeometry(curve, 18, radius, 7, false), mat, parent);
}
export function segment(parent, mat, radius) {
  const m = mesh(new THREE.CapsuleGeometry(radius, 1, 5, 10), mat, parent);
  const up = V(0, 1, 0), dir = V();
  return { mesh: m, set(a, b) {
    dir.copy(b).sub(a); const length = dir.length();
    m.position.copy(a).add(b).multiplyScalar(.5);
    m.scale.set(1, length / (1 + radius * 2), 1);
    if (length > .00001) m.quaternion.setFromUnitVectors(up, dir.normalize());
  } };
}
/** Architecture uses the broad rounded cuffs from V2. Their flat upper face
 * encloses the column ends, instead of slicing through a domed shoe. */
export function architectureBoot(parent, mat, pos) {
  return box(parent, [.78, .40, 1.0], mat, pos, .12);
}

/** Rounded toy boot with a broad toe, narrower ankle and a flattened sole. */
export function boot(parent, mat, pos, width = .57) {
  const geo = new THREE.SphereGeometry(1, 36, 28);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ankle = 1 - Math.max(0, y) * .20;
    p.setXYZ(i, x * width * .5 * ankle, Math.max(-.145, y * .235), z * .37 * ankle + .075 * (1 - y));
  }
  geo.computeVertexNormals();
  return mesh(geo, mat, parent, ...pos);
}

/**
 * The hand of a rubber-hose arm: a mitt with no thumb, flat, a little wider at the fingertips than at the wrist, with
 * three faint lines at the tips for the fingers. The lines are on both faces, so the hand reads the same whichever
 * way it is turned, and they are always at the end that points away from the arm: towards what the hand holds.
 */
function hoseHand(parent, mat) {
  const hand = group(parent), width = .158, length = .180, depth = .100;
  const geo = new THREE.SphereGeometry(1, 28, 20), p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setXYZ(i, p.getX(i) * width * (1 + .17 * y), y * length, p.getZ(i) * depth); }
  geo.computeVertexNormals();
  const palm = mesh(geo, mat, hand, 0, .05, 0); palm.name = 'rubber-hose-mitt';
  const crease = mat.clone(); crease.color.multiplyScalar(.80);
  for (const face of [1, -1]) for (const x of [-.058, 0, .058]) {
    const points = [];
    for (let k = 0; k <= 5; k++) {
      // From the tip a third of the way down, lying on the surface of the mitt.
      const y = .97 - k * .11, wide = width * (1 + .17 * y), across = x * (1 + .17 * y) / wide;
      points.push([across * wide, .05 + y * length, face * (depth * Math.sqrt(Math.max(.0004, 1 - across * across - y * y)) + .002)]);
    }
    tube(hand, points, .0065, crease);
  }
  return hand;
}

/**
 * A rubber-hose arm, as in the cartoons the family comes from: one hose of even thickness that never shows an elbow.
 * It leaves the shoulder and reaches the hand in a single smooth arc; the arc is the slack of the hose (the nearer the
 * hand is to the shoulder, the more it bows) and it bows away from the body and downwards, or round the front of the
 * body when the hand crosses it. The mitt continues the end of the hose, whatever the pose. `lift` (0 to 1) makes the
 * arc bow upwards instead, for a hand that comes down on something; `straight` (0 to 1) pulls the hose taut. `body`
 * is the solid the hose and the mitt must stay out of: its half width (a number, or a function of the height for a
 * round body), how far forward its front is, and its bottom and top. `flare` widens the hose where it leaves a body
 * thinner than itself, so that it grows out of the body instead of being stuck on it. `push: false` leaves the
 * mitt exactly where it is asked to be (for poses authored against the things the hand holds); `free` says the same
 * for one reach.
 */
export function hoseArm(parent, side, mat, anchorAt, { girth = 1, flare = 0, push = true, body = { half: .72, front: .40, bottom: -.8, top: .8 } } = {}) {
  const anchor = new THREE.Vector3(...anchorAt), hand = hoseHand(parent, mat);
  // A thick hose gets a mitt to match: the end of the hose must fit inside it.
  const grip = girth < 1 ? .80 + .20 * girth : 1 + .75 * (girth - 1);
  hand.scale.setScalar(grip);
  const sections = 28, sides = 14;
  const positions = new Float32Array((sections + 1) * (sides + 1) * 3), normals = new Float32Array(positions.length), indices = [];
  for (let i = 0; i < sections; i++) for (let j = 0; j < sides; j++) { const a = i * (sides + 1) + j, b = a + sides + 1; indices.push(a, a + 1, b, b, a + 1, b + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(indices);
  const sleeve = mesh(g, mat, parent); sleeve.frustumCulled = false;
  const wrist = new THREE.Vector3(), c1 = new THREE.Vector3(), c2 = new THREE.Vector3(), at = new THREE.Vector3(), fingers = new THREE.Vector3();
  const chord = new THREE.Vector3(), bow = new THREE.Vector3();
  const curve = new THREE.CubicBezierCurve3(anchor, c1, c2, wrist);
  const point = new THREE.Vector3(), tangent = new THREE.Vector3(), normal = new THREE.Vector3(), binormal = new THREE.Vector3(), reference = new THREE.Vector3(0, 0, 1);
  const palm = new THREE.Vector3(), across = new THREE.Vector3(), basis = new THREE.Matrix4();
  const arm = { side, parent, anchor, hand, sleeve, wrist, curve, length: .70,
    /** The length of the hose: a little more than the reach of the resting pose, so that it hangs with a slight bow. */
    rests(x, y, z) { arm.length = Math.hypot(x - anchor.x, y - anchor.y, z - anchor.z) * 1.08 + .03; },
    reach(x, y, z, { lift = 0, straight = 0, free = push } = {}) {
      // A mitt asked to be inside the body stays on its surface instead: on the way from one side of a corner to the
      // other it slides round the corner.
      const wide = typeof body.half === 'function' ? body.half(y) : body.half, margin = .10 + .035 * girth;
      if (free && y > body.bottom - margin && y < body.top + margin && Math.abs(x) < wide + margin && z < body.front + margin) {
        // Pushed out along the ray from a point well behind the body, so that neighbouring positions stay neighbours
        // (the nearest face would jump at the corner); less and less towards the top and the bottom of the body.
        const behind = -1, grow = Math.min(Math.abs(x) > 1e-6 ? (wide + margin) / Math.abs(x) : Infinity, (body.front + margin - behind) / (z - behind));
        const full = THREE.MathUtils.smoothstep(y, body.bottom - margin, body.bottom) * (1 - THREE.MathUtils.smoothstep(y, body.top, body.top + margin));
        x = THREE.MathUtils.lerp(x, x * grow, full); z = THREE.MathUtils.lerp(z, behind + (z - behind) * grow, full);
      }
      // (For a body whose width changes with the height, the widest part the hose passes by.)
      const half = typeof body.half === 'function' ? Math.max(body.half(anchor.y), body.half(y), body.half((anchor.y + y) / 2)) : body.half;
      at.set(x, y, z); chord.copy(at).sub(anchor);
      const distance = chord.length(), inward = THREE.MathUtils.clamp((Math.abs(anchor.x) - side * x) / (Math.abs(anchor.x) + .5), 0, 1);
      // The slack of the hose is its bow; even a taut hose keeps a trace of it, so it never looks like a rod.
      const slack = (Math.sqrt(Math.max(0, arm.length * arm.length - distance * distance)) * .46 + .035) * (1 - straight);
      bow.set(side * (1 - .75 * inward), THREE.MathUtils.lerp(-.8, .9, lift), .12 + 1.15 * inward);
      if (distance > 1e-4) bow.addScaledVector(chord, -bow.dot(chord) / (distance * distance));
      if (bow.lengthSq() < 1e-4) bow.set(side, 0, 0);
      bow.normalize().multiplyScalar(slack * 1.2);
      c1.copy(anchor).addScaledVector(chord, 1 / 3).add(bow); c2.copy(anchor).addScaledVector(chord, 2 / 3).add(bow);
      // Out of the body before anything else: the hose leaves the shoulder sideways, past the surface.
      c1.x = side * Math.max(side * c1.x, half + .06 + .092 * girth);
      // A hand in front of the body: the hose goes round the corner, first outside and then across the front.
      // (How much depends on how far forward the hand is, and hardly on how far to the side: a hand that moves in
      // front of the body, as in juggling, keeps one route instead of swinging between two.)
      const wrap = THREE.MathUtils.smoothstep(z, body.front * .5, body.front + .2) * (1 - THREE.MathUtils.smoothstep(side * x, half + .25, half + .65)) * (1 - straight);
      if (wrap > 0) {
        c1.lerp(point.set(side * (half + .21 + .092 * girth), THREE.MathUtils.lerp(anchor.y, y, .3) + bow.y * .5, body.front * .85), wrap);
        c2.lerp(point.set(side * (half + .01 + .092 * girth), THREE.MathUtils.lerp(anchor.y, y, .8) + bow.y * .8, Math.max(z - .05, body.front + .30)), wrap);
      }
      // The mitt continues the end of the hose, flat towards the front.
      fingers.copy(at).sub(c2).normalize();
      palm.set(0, 0, 1).addScaledVector(fingers, -fingers.z);
      if (palm.lengthSq() < .02) palm.set(0, 1, 0).addScaledVector(fingers, -fingers.y);
      palm.normalize(); across.crossVectors(fingers, palm);
      hand.position.copy(at); hand.quaternion.setFromRotationMatrix(basis.makeBasis(across, fingers, palm));
      wrist.copy(at).addScaledVector(fingers, -.02 * grip);
      const even = .092 * girth;
      for (let i = 0; i <= sections; i++) {
        // (It narrows into the wrist, so that its open end is inside the mitt and never shows.)
        const u = i / sections, radius = even * (1 + flare * (1 - THREE.MathUtils.smoothstep(u, 0, .24))) * (1 - .32 * THREE.MathUtils.smoothstep(u, .74, 1));
        curve.getPoint(u, point); curve.getTangent(u, tangent).normalize();
        normal.crossVectors(tangent, reference).normalize();
        if (normal.lengthSq() < .01) normal.set(1, 0, 0);
        binormal.crossVectors(tangent, normal).normalize();
        for (let j = 0; j <= sides; j++) {
          const a = j / sides * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), offset = (i * (sides + 1) + j) * 3;
          const nx = normal.x * ca + binormal.x * sa, ny = normal.y * ca + binormal.y * sa, nz = normal.z * ca + binormal.z * sa;
          positions[offset] = point.x + nx * radius; positions[offset + 1] = point.y + ny * radius; positions[offset + 2] = point.z + nz * radius;
          normals[offset] = nx; normals[offset + 1] = ny; normals[offset + 2] = nz;
        }
      }
      g.attributes.position.needsUpdate = g.attributes.normal.needsUpdate = true;
    } };
  return arm;
}

export function shieldShape(scale = 1) {
  const s = new THREE.Shape();
  s.moveTo(0, 1.05); s.bezierCurveTo(.22, .86, .58, .82, .87, .77);
  s.bezierCurveTo(.95, .10, .72, -.62, 0, -1.03);
  s.bezierCurveTo(-.72, -.62, -.95, .10, -.87, .77);
  s.bezierCurveTo(-.58, .82, -.22, .86, 0, 1.05);
  if (scale !== 1) {
    const points = s.getPoints(44).map(p => p.multiplyScalar(scale));
    return new THREE.Shape(points);
  }
  return s;
}
export function braceShape() {
  const s = new THREE.Shape();
  s.moveTo(.22, .94); s.lineTo(-.02, .94);
  s.bezierCurveTo(-.36, .94, -.34, .64, -.34, .39);
  s.bezierCurveTo(-.34, .19, -.38, .13, -.55, .08);
  s.lineTo(-.55, -.10);
  s.bezierCurveTo(-.38, -.15, -.34, -.21, -.34, -.41);
  s.bezierCurveTo(-.34, -.66, -.36, -.94, -.02, -.94);
  s.lineTo(.22, -.94); s.lineTo(.22, -.70); s.lineTo(.05, -.70);
  s.bezierCurveTo(-.09, -.70, -.08, -.56, -.08, -.34);
  s.bezierCurveTo(-.08, -.14, -.16, -.04, -.30, 0);
  s.bezierCurveTo(-.16, .04, -.08, .14, -.08, .34);
  s.bezierCurveTo(-.08, .56, -.09, .70, .05, .70);
  s.lineTo(.22, .70); s.closePath(); return s;
}
export function starShape() {
  const s = new THREE.Shape();
  s.moveTo(0, .30); s.quadraticCurveTo(.06, .07, .27, 0);
  s.quadraticCurveTo(.06, -.06, 0, -.30); s.quadraticCurveTo(-.06, -.06, -.27, 0);
  s.quadraticCurveTo(-.06, .07, 0, .30); return s;
}
export function archShape() {
  const s = new THREE.Shape();
  // End the columns inside their boot cuffs. The hidden extra .10 previously
  // protruded through the shoe during squash and the lowered resting pose.
  s.moveTo(-.92, -.72); s.lineTo(-.92, .68); s.quadraticCurveTo(-.92, .83, -.75, .83);
  s.lineTo(.75, .83); s.quadraticCurveTo(.92, .83, .92, .68); s.lineTo(.92, -.72);
  s.lineTo(.43, -.72); s.lineTo(.43, -.20); s.bezierCurveTo(.43, .38, -.43, .38, -.43, -.20);
  s.lineTo(-.43, -.72); s.closePath(); return s;
}
export function check(parent, mat, pos, scale = 1) {
  const g = group(parent, pos); g.scale.setScalar(scale);
  const a = box(g, [.13, .31, .07], mat, [-.09, -.035, 0], .045); a.rotation.z = .76;
  const b = box(g, [.13, .52, .07], mat, [.10, .04, 0], .045); b.rotation.z = -.65;
  return g;
}

export function cross(parent, mat, pos, scale = 1) {
  const g = group(parent, pos); g.scale.setScalar(scale);
  for (const sign of [-1, 1]) {
    const bar = box(g, [.115, .49, .07], mat, [0, 0, 0], .045); bar.rotation.z = sign * Math.PI / 4;
  }
  return g;
}

export function face(parent, { z = .49, x = 0, y = .14, spacing = .29 } = {}) {
  const g = group(parent, [x, y, z]);
  const ink = vinyl('#171b23', { roughness: .32, clearcoat: .15 });
  const eyes = [], happy = [], brows = [];
  for (const side of [-1, 1]) {
    const eye = box(g, [.145, .30, .065], ink, [side * spacing, 0, 0], .045); eyes.push(eye);
    const h = tube(g, [[side * spacing - .095, -.01, .01], [side * spacing, .065, .01], [side * spacing + .095, -.01, .01]], .035, ink.clone());
    h.material.transparent = true; h.material.opacity = 0; happy.push(h);
    const brow = box(g, [.23, .055, .055], ink.clone(), [side * spacing, .265, .015], .023);
    brow.material.transparent = true; brow.material.opacity = 0; brows.push(brow);
  }
  return { group: g, eyes, happy, brows, baseX: x, baseY: y, spacing };
}

export function disposeTree(root) {
  const geometries = new Set(), materials = new Set();
  root.traverse(o => {
    if (o.geometry) geometries.add(o.geometry);
    for (const m of o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : []) materials.add(m);
  });
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
}
