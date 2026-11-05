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
/** One closed padded mitten, shaped by its silhouette, rather than overlapping
 * spheres. The thumb grows sideways below the broad joined fingertips. */
export function mitten(parent, side, mat) {
  const g = group(parent);
  const outline = new THREE.Shape();
  outline.moveTo(-.075, -.185);
  outline.bezierCurveTo(-.12, -.16, -.16, -.12, -.17, -.055);
  outline.bezierCurveTo(-.205, -.025, -.23, .025, -.21, .065);
  outline.bezierCurveTo(-.19, .095, -.17, .095, -.15, .08);
  outline.bezierCurveTo(-.15, .14, -.14, .195, -.075, .215);
  outline.bezierCurveTo(-.005, .24, .10, .23, .145, .18);
  outline.bezierCurveTo(.19, .13, .19, .015, .16, -.075);
  outline.bezierCurveTo(.14, -.13, .115, -.17, .075, -.185);
  outline.quadraticCurveTo(0, -.205, -.075, -.185);
  const contour = outline.getSpacedPoints(80); contour.pop();
  if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  const around = contour.length, rings = 24, vertices = [0, .015, .172], indices = [];
  for (let ring = 1; ring < rings; ring++) {
    const angle = ring / rings * Math.PI, radius = Math.pow(Math.sin(angle), .85), depth = Math.cos(angle);
    for (const p of contour) {
      const x = p.x * radius, y = .015 + (p.y - .015) * radius;
      // A shallow sculpted fold joins the thumb into the palm. It is part of
      // the same surface, without an added bump or a separate finger cap.
      const fold = .012 * Math.exp(-Math.pow((x + .135) / .065, 2) - Math.pow((y - .015) / .07, 2));
      vertices.push(x, y, depth * (.172 - fold));
    }
  }
  const back = vertices.length / 3; vertices.push(0, .015, -.172);
  for (let j = 0; j < around; j++) {
    const next = (j + 1) % around;
    indices.push(0, 1 + j, 1 + next);
    for (let ring = 0; ring < rings - 2; ring++) {
      const a = 1 + ring * around + j, b = a + around;
      const c = 1 + ring * around + next, d = c + around;
      indices.push(a, b, c, b, d, c);
    }
    const last = 1 + (rings - 2) * around;
    indices.push(last + j, back, last + next);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geo.setIndex(indices); geo.computeVertexNormals();
  const glove = mesh(geo, mat, g); glove.name = 'continuous-mitten'; glove.scale.x = side;
  return g;
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

/** One smooth bendy arm, no exposed capsule ends or polygonal elbow. */
export function arm(parent, side, mat, shoulderX = .72, clearance = .48) {
  const sections = 24, sides = 14;
  const positions = new Float32Array((sections + 1) * (sides + 1) * 3);
  const normals = new Float32Array(positions.length), indices = [];
  for (let i = 0; i < sections; i++) for (let j = 0; j < sides; j++) {
    const a = i * (sides + 1) + j, b = a + sides + 1;
    indices.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(indices);
  const sleeve = mesh(geo, mat, parent); sleeve.frustumCulled = false;
  const hand = mitten(parent, side, mat);
  const anchor = V(side * shoulderX, -.10, 0), end = V(), c1 = V(), c2 = V();
  const curve = new THREE.CubicBezierCurve3(anchor, c1, c2, end);
  const point = V(), tangent = V(), normal = V(), binormal = V(), reference = V(0, 0, 1);
  return { side, parent, hand, anchor, sleeve, reach(x, y, z, roll = 0) {
    end.set(x, y, z);
    // Bend outside the silhouette. The forearm approaches carried objects from
    // the front, clearing the architecture's lower, wider blocks.
    const outside = Math.max(shoulderX + .40, Math.abs(x) + .22);
    c1.set(side * outside, anchor.y - .12, Math.max(.12, z * .35));
    c2.set(side * outside, y - .30, Math.max(z + .08, clearance));
    for (let i = 0; i <= sections; i++) {
      const u = i / sections;
      curve.getPoint(u, point); curve.getTangent(u, tangent).normalize();
      normal.crossVectors(tangent, reference).normalize();
      if (normal.lengthSq() < .01) normal.set(1, 0, 0);
      binormal.crossVectors(tangent, normal).normalize();
      const radius = .137 + Math.sin(u * Math.PI) * .014;
      for (let j = 0; j <= sides; j++) {
        const angle = j / sides * Math.PI * 2, cos = Math.cos(angle), sin = Math.sin(angle);
        const offset = (i * (sides + 1) + j) * 3;
        const nx = normal.x * cos + binormal.x * sin, ny = normal.y * cos + binormal.y * sin, nz = normal.z * cos + binormal.z * sin;
        positions[offset] = point.x + nx * radius; positions[offset + 1] = point.y + ny * radius; positions[offset + 2] = point.z + nz * radius;
        normals[offset] = nx; normals[offset + 1] = ny; normals[offset + 2] = nz;
      }
    }
    geo.attributes.position.needsUpdate = geo.attributes.normal.needsUpdate = true;
    hand.position.copy(end); hand.rotation.z = roll;
  } };
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
