import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mesh, box, ball, group, extrusion, tube, vinyl } from '../actors/geometry.js';

// Sculpted parts of the six Semantic mascots, copied from the "thinking team" study (src/sculpt.js) with only what the
// shipped models use. The family helpers (vinyl, box, ball, extrusion, tube) are the product's copies in ../actors.

export { mesh, box, ball, group, extrusion, tube, vinyl };

export function disk(parent, radius, depth, mat, pos = [0, 0, 0], bevel = .025) {
  const s = new THREE.Shape(); s.absarc(0, 0, radius, 0, Math.PI * 2, false);
  return extrusion(parent, s, depth, mat, pos, bevel);
}
export function ring(parent, radius, thickness, mat, pos = [0, 0, 0], arc = Math.PI * 2) {
  return mesh(new THREE.TorusGeometry(radius, thickness, 12, 72, arc), mat, parent, ...pos);
}
export function polygon(parent, points, depth, mat, pos = [0, 0, 0], bevel = .015) {
  const s = new THREE.Shape(); s.moveTo(...points[0]); points.slice(1).forEach(p => s.lineTo(...p)); s.closePath();
  return extrusion(parent, s, depth, mat, pos, bevel);
}
export function cylinder(parent, front, back, length, mat, pos = [0, 0, 0], axis = 'z') {
  const m = mesh(new THREE.CylinderGeometry(front, back, length, 48, 1), mat, parent, ...pos);
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  return m;
}
export function line(parent, points, mat, radius = .023) { return tube(parent, points, radius, mat); }

/** One continuous rounded block, with blind sockets and a solid rear surface. */
export function sorterHousing(parent, mat, holes) {
  const vertices = [], indices = [];
  const perimeter = (inset, z) => {
    const points = [], r = .13 - inset, x = .86 - inset, y = .78 - inset;
    for (const [cx, cy, start] of [[x - r, y - r, 0], [-x + r, y - r, Math.PI / 2], [-x + r, -y + r, Math.PI], [x - r, -y + r, Math.PI * 1.5]]) {
      for (let i = 0; i <= 10; i++) { const a = start + i * Math.PI / 20; points.push(new THREE.Vector3(cx + r * Math.cos(a), cy + r * Math.sin(a), z)); }
    }
    return points;
  };
  const aperture = (hole, inset, z) => {
    const s = hole.size - inset;
    const points = hole.kind === 'circle' ? Array.from({ length: 64 }, (_, i) => [Math.cos(i * Math.PI / 32) * s, Math.sin(i * Math.PI / 32) * s]) : hole.kind === 'triangle' ? [[0, s], [-s, -s], [s, -s]] : [[-s, -s], [s, -s], [s, s], [-s, s]];
    return points.map(([x, y]) => new THREE.Vector3(x + hole.x, y + hole.y, z));
  };
  const add = points => { const first = vertices.length / 3; points.forEach(p => vertices.push(p.x, p.y, p.z)); return first; };
  const face = (outer, inner = [], reverse = false) => {
    const points = [...outer, ...inner.flat()], start = add(points);
    for (const triangle of THREE.ShapeUtils.triangulateShape(outer.map(p => new THREE.Vector2(p.x, p.y)), inner.map(loop => loop.map(p => new THREE.Vector2(p.x, p.y))))) {
      indices.push(...(reverse ? triangle.reverse() : triangle).map(i => start + i));
    }
  };
  const strip = (loops, inward = false) => {
    const start = add(loops.flat()), n = loops[0].length;
    for (let row = 1; row < loops.length; row++) for (let i = 0; i < n; i++) {
      const a = start + (row - 1) * n + i, b = start + (row - 1) * n + (i + 1) % n, c = start + row * n + i, d = start + row * n + (i + 1) % n;
      indices.push(...(inward ? [a, b, d, a, d, c] : [a, d, b, a, c, d]));
    }
  };
  const front = perimeter(.055, .43), back = perimeter(.055, -.47);
  face(front, holes.map(h => aperture(h, 0, .43)));
  const outer = [];
  for (let i = 0; i <= 6; i++) { const a = i * Math.PI / 12; outer.push(perimeter(.055 * (1 - Math.sin(a)), .375 + .055 * Math.cos(a))); }
  for (let i = 0; i <= 6; i++) { const a = i * Math.PI / 12; outer.push(perimeter(.055 * (1 - Math.cos(a)), -.415 - .055 * Math.sin(a))); }
  strip(outer); face(back, [], true);
  for (const hole of holes) {
    const opening = aperture(hole, 0, .43), wall = aperture(hole, .015, .39), floor = aperture(hole, .015, -.30);
    strip([opening, wall, floor], true); face(floor);
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geo.setIndex(indices); geo.computeVertexNormals();
  const housing = mesh(geo, mat, parent); housing.name = 'closed-sorter-housing';
  return housing;
}

/** New-family hand: a padded palm and integrated thumb with a narrow wrist. */
function mascotHand(parent, side, mat) {
  const hand = group(parent), s = new THREE.Shape();
  s.moveTo(-.065, -.18); s.quadraticCurveTo(0, -.195, .065, -.18);
  s.bezierCurveTo(.095, -.13, .15, -.07, .15, .055);
  s.bezierCurveTo(.15, .18, .085, .23, -.025, .23);
  s.bezierCurveTo(-.13, .23, -.16, .15, -.15, .065);
  s.bezierCurveTo(-.205, .09, -.25, .045, -.225, -.015);
  s.bezierCurveTo(-.21, -.065, -.15, -.07, -.115, -.09);
  s.quadraticCurveTo(-.085, -.12, -.065, -.18); s.closePath();
  const outline = s.getSpacedPoints(80); outline.pop(); if (THREE.ShapeUtils.isClockWise(outline)) outline.reverse();
  const around = outline.length, rings = 24, vertices = [0, .018, .145], indices = [];
  for (let ring = 1; ring < rings; ring++) {
    const angle = ring / rings * Math.PI, spread = Math.pow(Math.sin(angle), .85);
    for (const point of outline) vertices.push(point.x * spread, .018 + (point.y - .018) * spread, Math.cos(angle) * .145);
  }
  const back = vertices.length / 3; vertices.push(0, .018, -.145);
  for (let j = 0; j < around; j++) {
    const next = (j + 1) % around; indices.push(0, 1 + j, 1 + next);
    for (let ring = 0; ring < rings - 2; ring++) { const a = 1 + ring * around + j, b = a + around, c = 1 + ring * around + next, d = c + around; indices.push(a, b, c, b, d, c); }
    const last = 1 + (rings - 2) * around; indices.push(last + j, back, last + next);
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geo.setIndex(indices); geo.computeVertexNormals();
  const palm = mesh(geo, mat, hand); palm.scale.x = side; palm.name = 'new-family-palm';
  return hand;
}

/** Wrist, terminal forearm tangent and finger axis share the same direction. */
export function mascotArm(parent, side, mat, anchorAt, { direction = [side * .20, -1, 0] } = {}) {
  const anchor = new THREE.Vector3(...anchorAt), hand = mascotHand(parent, side, mat), wrist = new THREE.Vector3();
  const fingerDirection = new THREE.Vector3(...direction).normalize();
  const sections = 32, sides = 16;
  const g = new THREE.BufferGeometry(), indices = [];
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((sections + 1) * (sides + 1) * 3), 3));
  for (let i = 0; i < sections; i++) for (let j = 0; j < sides; j++) { const a = i * (sides + 1) + j, b = a + sides + 1; indices.push(a, a + 1, b, b, a + 1, b + 1); }
  g.setIndex(indices);
  const sleeve = mesh(g, mat, parent); sleeve.frustumCulled = false;
  return { side, anchor, hand, sleeve, wrist, reach(x, y, z, nextDirection) {
    if (nextDirection) fingerDirection.set(...nextDirection).normalize();
    const right = fingerDirection.clone().cross(new THREE.Vector3(0, 0, 1)).normalize();
    const normal = right.clone().cross(fingerDirection).normalize();
    hand.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, fingerDirection, normal)); hand.position.set(x, y, z);
    wrist.copy(hand.position).addScaledVector(fingerDirection, -.135);
    const c1 = anchor.clone().add(new THREE.Vector3(side * .28, -.08, .035));
    const straightStart = wrist.clone().addScaledVector(fingerDirection, -.12);
    const c2 = straightStart.clone().addScaledVector(fingerDirection, -.20);
    const curve = new THREE.CurvePath(); curve.add(new THREE.CubicBezierCurve3(anchor, c1, c2, straightStart)); curve.add(new THREE.LineCurve3(straightStart, wrist));
    const frames = curve.computeFrenetFrames(sections, false), positions = sleeve.geometry.attributes.position;
    for (let i = 0; i <= sections; i++) {
      const t = i / sections, point = curve.getPointAt(t);
      const radius = THREE.MathUtils.lerp(.122, .088, THREE.MathUtils.smoothstep(t, .50, 1));
      for (let j = 0; j <= sides; j++) {
        const a = j / sides * Math.PI * 2, vertex = point.clone().addScaledVector(frames.normals[i], Math.cos(a) * radius).addScaledVector(frames.binormals[i], Math.sin(a) * radius);
        positions.setXYZ(i * (sides + 1) + j, vertex.x, vertex.y, vertex.z);
      }
    }
    positions.needsUpdate = true; sleeve.geometry.computeVertexNormals();
  } };
}

/** Solid octagonal routes look like printed tracks rather than soft molecular links. */
export function circuitPath(parent, points, mat, width = .018) {
  const segments = [];
  for (let i = 1; i < points.length; i++) {
    const a = new THREE.Vector3(...points[i - 1]), b = new THREE.Vector3(...points[i]);
    if (a.distanceToSquared(b) < .0000001) continue;
    const bar = new THREE.BoxGeometry(width, a.distanceTo(b) + width, width);
    const center = a.clone().add(b).multiplyScalar(.5);
    bar.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize())); bar.translate(...center.toArray());
    segments.push(bar);
  }
  if (!segments.length) return;
  const geometry = mergeGeometries(segments); segments.forEach(g => g.dispose());
  return mesh(geometry, mat, parent);
}

export function gavel(parent, p, position = [0, 0, 0], scale = 1) {
  const g = group(parent, position); g.scale.setScalar(scale);
  cylinder(g, .30, .30, 1.20, p.main, [0, .48, 0], 'x');
  for (const side of [-1, 1]) {
    cylinder(g, .35, .35, .16, p.dark, [side * .56, .48, 0], 'x');
    cylinder(g, .31, .31, .07, p.pale, [side * .68, .48, 0], 'x');
  }
  cylinder(g, .11, .16, .96, p.main, [0, -.20, 0], 'y');
  ball(g, [.15, .18, .15], p.main, [0, -.69, 0]);
  return g;
}

/** One S-curved snake continues directly from the straight handle into a low loop. */
export function coiledHandle(parent, p) {
  const v = a => new THREE.Vector3(...a), curve = new THREE.CurvePath();
  curve.add(new THREE.LineCurve3(v([0, -.06, .02]), v([0, -.40, .02])));
  const bends = [
    [[0, -.40, .02], [0, -.66, .02], [-.38, -.58, .04], [-.38, -.88, .08]],
    [[-.38, -.88, .08], [-.38, -1.14, .12], [-.10, -1.17, .25], [.29, -1.13, .20]],
    [[.29, -1.13, .20], [.72, -1.09, .15], [.72, -1.08, -.38], [.23, -1.09, -.42]],
    [[.23, -1.09, -.42], [-.43, -1.11, -.48], [-.90, -1.13, -.13], [-.63, -1.15, .28]],
    [[-.63, -1.15, .28], [-.40, -1.16, .65], [.35, -1.17, .66], [.73, -1.02, .44]],
    [[.73, -1.02, .44], [.94, -.94, .37], [.86, -.72, .35], [.94, -.64, .35]]
  ];
  bends.forEach(points => curve.add(new THREE.CubicBezierCurve3(...points.map(v))));
  const radius = t => THREE.MathUtils.lerp(.113, .178, THREE.MathUtils.smoothstep(t, .07, .25)) * (1 - .64 * THREE.MathUtils.smoothstep(t, .72, 1));
  const steps = 220, sides = 24, geo = new THREE.TubeGeometry(curve, steps, 1, sides, false), attr = geo.attributes.position;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, center = curve.getPointAt(t), r = radius(t);
    for (let j = 0; j <= sides; j++) {
      const n = i * (sides + 1) + j; attr.setXYZ(n, center.x + (attr.getX(n) - center.x) * r, center.y + (attr.getY(n) - center.y) * r, center.z + (attr.getZ(n) - center.z) * r);
    }
  }
  geo.computeVertexNormals(); const snake = mesh(geo, p.main, parent); snake.name = 'continuous-scaled-snake';
  const surface = (t, angle, offset = .005) => {
    const center = curve.getPointAt(t), tangent = curve.getTangentAt(t).normalize();
    const front = v([0, 0, 1]).addScaledVector(tangent, -tangent.z).normalize(), across = tangent.clone().cross(front).normalize();
    return center.addScaledVector(front, Math.cos(angle) * (radius(t) + offset)).addScaledVector(across, Math.sin(angle) * (radius(t) + offset));
  };
  // A single inset belly strip and transverse scutes follow the neck's curvature.
  const bellyVertices = [], bellyIndices = [], rows = 65, columns = 8;
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= columns; j++) bellyVertices.push(...surface(.015 + i / rows * .36, (j / columns - .5) * 1.05, .006).toArray());
  for (let i = 0; i < rows; i++) for (let j = 0; j < columns; j++) { const a = i * (columns + 1) + j, b = a + columns + 1; bellyIndices.push(a, a + 1, b, a + 1, b + 1, b); }
  const bellyGeo = new THREE.BufferGeometry(); bellyGeo.setAttribute('position', new THREE.Float32BufferAttribute(bellyVertices, 3)); bellyGeo.setIndex(bellyIndices); bellyGeo.computeVertexNormals();
  const bellyMat = p.pale.clone(); bellyMat.side = THREE.DoubleSide; mesh(bellyGeo, bellyMat, parent).name = 'snake-belly';
  const marking = p.main.clone(); marking.color.multiplyScalar(.83);
  for (let row = 0; row < 15; row++) {
    const t = .025 + row * .023, points = []; for (let j = 0; j <= 8; j++) points.push(surface(t, (j / 8 - .5) * 1.02, .009).toArray());
    line(parent, points, marking, .0065);
  }
  // Raised diamond scales are merged into one lightweight mesh.
  const scaleVertices = [], scaleIndices = [];
  for (let row = 0; row < 34; row++) for (const angle of [-1.12, 1.12, 2.25, -2.25]) {
    const t = .12 + row * .024 + (angle > 0 ? .010 : 0); if (t > .92) continue;
    const points = [surface(t - .007, angle), surface(t, angle - .24), surface(t + .007, angle), surface(t, angle + .24), surface(t, angle, .012)];
    const start = scaleVertices.length / 3; points.forEach(point => scaleVertices.push(...point.toArray()));
    for (let k = 0; k < 4; k++) scaleIndices.push(start + k, start + (k + 1) % 4, start + 4);
  }
  const scales = new THREE.BufferGeometry(); scales.setAttribute('position', new THREE.Float32BufferAttribute(scaleVertices, 3)); scales.setIndex(scaleIndices); scales.computeVertexNormals();
  const scaleMat = marking.clone(); scaleMat.side = THREE.DoubleSide; mesh(scales, scaleMat, parent).name = 'snake-diamond-scales';
  const rattle = group(parent, curve.getPointAt(1).toArray()); rattle.name = 'segmented-tail-rattle';
  rattle.quaternion.setFromUnitVectors(v([0, 1, 0]), curve.getTangentAt(1).normalize());
  const profile = [[.065, -.025], [.105, .035], [.108, .075], [.067, .11], [.10, .15], [.097, .195], [.06, .22], [.085, .255], [.08, .30], [.048, .32], [.063, .35], [.04, .39], [0, .40]].map(point => new THREE.Vector2(...point));
  mesh(new THREE.LatheGeometry(new THREE.SplineCurve(profile).getPoints(64), 32), p.pale, rattle);
  for (const y of [.11, .22, .32]) { const seam = ring(rattle, y === .32 ? .048 : .063, .008, marking, [0, y, 0]); seam.rotation.x = Math.PI / 2; }
}

/** Ink is a local canvas decal, not a fetched font or a substitute for object geometry. */
export function ink(parent, text, width, height, pos, color = '#25423c') {
  const canvas = document.createElement('canvas');
  // Match the decal's aspect ratio: a wide texture on a square cardinal letter
  // selects a very low vertical mip level and smears the letter at UI scale.
  canvas.width = Math.max(64, Math.round(512 * Math.min(1, width / height)));
  canvas.height = Math.max(64, Math.round(512 * Math.min(1, height / width)));
  const ctx = canvas.getContext('2d'); ctx.fillStyle = color;
  ctx.font = `700 ${canvas.height * .74}px Arial, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.translate(canvas.width / 2, canvas.height * .52); ctx.scale(canvas.width * .90 / Math.max(1, ctx.measureText(text).width), 1); ctx.fillText(text, 0, 0);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const m = mesh(new THREE.PlaneGeometry(width, height), material, parent, ...pos);
  m.userData.decal = true; return m;
}

export function page(parent, p, { width = 1.35, height = 1.65, position = [0, 0, 0], color = p.paper, fold = .24, depth = .045 } = {}) {
  const g = group(parent, position), x = width / 2, y = height / 2;
  polygon(g, [[-x, -y], [x, -y], [x, y - fold], [x - fold, y], [-x, y]], depth, color, [0, 0, 0], .012);
  polygon(g, [[x - fold, y], [x - fold, y - fold], [x, y - fold]], .018, p.cream, [0, 0, depth / 2 + .028], .008);
  return g;
}
export function rules(parent, p, { x = 0, y = 0, z = .05, width = .78, count = 3, gap = .13, mat = p.ink } = {}) {
  for (let i = 0; i < count; i++) box(parent, [width * (i === count - 1 ? .66 : 1), .022, .012], mat, [x - (i === count - 1 ? width * .17 : 0), y - i * gap, z], .005);
}
export function tick(parent, mat, pos, scale = 1) {
  const g = group(parent, pos); g.scale.setScalar(scale);
  line(g, [[-.19, 0, 0], [-.045, -.15, 0], [.24, .22, 0]], mat, .055); return g;
}
