import * as THREE from 'three';
import { group, box, mesh, line, disk, ring, vinyl, cylinder, circuitPath } from './sculpt.js';

// The AI construction of the Semantic mascots: the "clear brain capsule" of the "thinking team" study
// (src/indicators.js), the only construction shipped. A phase-colored electronic brain with printed tracks sits inside
// a squat clear capsule, on a physical socket with a sealed rim.

function hemisphere(parent, p, side) {
  const g = group(parent, [0, .34, 0]);
  // Each part is half of one broad cerebral volume, not an egg placed beside another.
  const geo = new THREE.SphereGeometry(1, 48, 36, -Math.PI / 2, Math.PI), pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ripple = 1 + .047 * Math.sin(y * 15 + Math.sin(z * 8)) * Math.cos(x * 11 + z * 4);
    pos.setXYZ(i, side * (.017 + Math.abs(x) * .46 * ripple), y * .29 * ripple, z * .32 * ripple);
  }
  if (side > 0) {
    const index = geo.index; for (let i = 0; i < index.count; i += 3) { const a = index.getX(i); index.setX(i, index.getX(i + 2)); index.setX(i + 2, a); }
  }
  geo.computeVertexNormals();
  const substrate = p.main.clone(); substrate.color.multiplyScalar(.58);
  mesh(geo, substrate, g);
  const cap = disk(g, .29, .015, substrate, [side * .017, 0, 0], .005); cap.rotation.y = Math.PI / 2; cap.scale.x = 1.10;
  const surface = (u, v) => [side * (.017 + u * .46), v * .29, Math.sqrt(Math.max(.01, 1 - u * u - v * v)) * .32 + .021];
  const routes = [[[.11, -.75], [.37, -.75], [.37, -.38], [.69, -.38], [.69, -.02], [.87, -.02]], [[.10, .01], [.30, .01], [.30, .39], [.59, .39], [.59, .64]], [[.14, .79], [.35, .79], [.35, .58]], [[.19, -.41], [.19, -.20], [.47, -.20], [.47, .15], [.71, .15]]];
  for (const route of routes) {
    const points = [];
    for (let i = 1; i < route.length; i++) for (let k = 0; k <= 5; k++) {
      const t = k / 5; points.push(surface(THREE.MathUtils.lerp(route[i - 1][0], route[i][0], t), THREE.MathUtils.lerp(route[i - 1][1], route[i][1], t)));
    }
    circuitPath(g, points, p.cream, .020);
    box(g, [.050, .040, .023], p.pale, points.at(-1), .006);
  }
  for (const x of [.13, .29]) line(g, [[side * x, .23, .13], [side * x, .28, 0], [side * x, .23, -.14], [side * x * .7, .09, -.30]], p.cream, .016);
}

/** The capsule, mounted on the model's crown (or on the support its anatomy names). */
export function createCapsule(mount, p) {
  const root = group(mount.body); root.name = 'ai-indicator-capsule';
  const g = group(root, mount.brainAt ?? [0, mount.top - .04, -.035]); g.name = 'brain-socket'; g.scale.setScalar(.85);
  cylinder(g, .31, .36, .15, p.main, [0, -.025, 0], 'y');
  box(g, [.72, .11, .52], p.dark, [0, .035, 0], .045);
  hemisphere(g, p, -1);
  hemisphere(g, p, 1);
  for (let i = 0; i < 5; i++) box(g, [.04, .06, .055], p.cream, [(i - 2) * .12, -.015, .27], .006);
  const shell = vinyl('#eff7ed', { transparent: true, opacity: .15, roughness: .30, clearcoat: .12, depthWrite: false });
  const profile = [[.48, .03], [.495, .12], [.495, .51], [.48, .60], [.44, .68], [.32, .74], [0, .75]].map(a => new THREE.Vector2(...a));
  const dome = mesh(new THREE.LatheGeometry(new THREE.SplineCurve(profile).getPoints(48), 64), shell, g); dome.name = 'clear-protective-capsule';
  cylinder(g, .47, .43, .07, p.main, [0, .012, 0], 'y');
  const rim = ring(g, .48, .035, p.pale, [0, .035, 0]); rim.rotation.x = Math.PI / 2;
  const cap = ring(g, .24, .025, p.pale, [0, .727, 0]); cap.rotation.x = Math.PI / 2;
  for (const side of [-1, 1]) box(g, [.07, .16, .11], p.main, [side * .47, .07, 0], .025);
  return root;
}
