import * as THREE from 'three';
import { mesh, box, ball, group, vinyl, disk, ring, polygon, cylinder, line, ink, page, rules, tick, sorterHousing, coiledHandle, gavel } from './sculpt.js';

// Object anatomy of the six Semantic mascots, copied from the "thinking team" study (src/objects.js) with only the
// shortlisted shapes. Object anatomy comes first; the family's eyes and limbs are attached afterwards (models.js).
export function buildObject(body, p, shape) {
  const { main, dark, cream, pale } = p;
  const rig = { faceHost: body, eyes: { y: .18, z: .4, spacing: .25 }, top: .9, shoulder: .72, bottom: -.70, footX: .43,
    hands: [[-1.03, -.42, .26], [1.03, -.25, .35]] };
  switch (shape) {
    case 'compass': {
      const north = vinyl('#d53d3d'), northShade = vinyl('#b62e34');
      disk(body, .89, .45, main, [0, .02, 0]); disk(body, .76, .035, pale, [0, .02, .28], .018);
      ring(body, .80, .045, dark, [0, .02, .285]);
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, length = i % 2 ? .24 : .36;
        const g = group(body, [0, -.27, .325]); g.rotation.z = -a;
        polygon(g, [[0, length], [-.048, .04], [0, 0]], .014, i === 0 ? northShade : dark, [0, 0, 0], .005);
        polygon(g, [[0, length], [.048, .04], [0, 0]], .014, i === 0 ? north : main, [0, 0, .002], .005);
      }
      for (const [letter, x, y] of [['N', 0, .65], ['S', 0, -.64], ['E', .64, -.03], ['W', -.64, -.03]]) ink(body, letter, .095, .12, [x, y, .33], '#3a7062');
      polygon(body, [[0, .28], [-.05, 0], [.05, 0]], .025, north, [0, -.27, .36], .008).name = 'red-north-pointer';
      disk(body, .043, .025, dark, [0, -.27, .38], .005);
      rig.eyes = { y: .25, z: .34, spacing: .24 }; rig.top = .90; rig.bottom = -.65;
      rig.anchors = [[-.76, -.20, 0], [.76, -.20, 0]]; rig.hands = [[-1.06, -.61, .17], [1.06, -.61, .17]];
      break;
    }
    case 'lenscoil': {
      coiledHandle(body, p);
      ring(body, .66, .12, main, [0, .68, .02]); ring(body, .54, .024, dark, [0, .68, .07]);
      // The straight handle and S-curved body are one uninterrupted surface.
      const lensMat = vinyl('#e8dfd5', { transparent: true, opacity: .30, roughness: .19, clearcoat: .32, metalness: .02, depthWrite: false });
      const lens = ball(body, [.524, .524, .073], lensMat, [0, .68, .026]); lens.name = 'convex-optical-lens';
      ring(body, .515, .011, pale, [0, .68, .062]); ring(body, .54, .018, dark, [0, .68, -.065]);
      rig.eyes = { y: .73, z: .125, spacing: .22 }; rig.noFeet = true; rig.noArms = true; rig.top = 1.37;
      break;
    }
    case 'gavel': {
      const hammer = gavel(body, p, [0, .04, 0], 1.15);
      rig.faceHost = hammer; rig.eyes = { y: .49, z: .30, spacing: .23 };
      rig.noFeet = true; rig.bodyY = 1.25; rig.top = .98;
      cylinder(body, .59, .67, .20, dark, [0, -1.07, .03], 'y');
      cylinder(body, .53, .56, .09, pale, [0, -.94, .03], 'y');
      box(body, [.26, .29, .28], main, [0, -.78, 0], .09);
      rig.shoulder = .09; rig.anchors = [[-.09, -.21, 0], [.09, -.21, 0]];
      rig.hands = [[-.63, -.50, .12], [.63, -.50, .12]];
      break;
    }
    case 'shape-sorter': {
      const holes = [{ kind: 'square', x: -.51, y: -.29, size: .20 }, { kind: 'triangle', x: 0, y: -.29, size: .22 }, { kind: 'circle', x: .53, y: -.29, size: .25 }];
      sorterHousing(body, main, holes);
      // The study's static pose (the start of its optional fitting sequence, which is not shipped): the square record
      // waits in the right hand, outside the housing.
      const geo = new THREE.CylinderGeometry(.205, .205, .24, 64, 1); geo.rotateX(Math.PI / 2);
      const attr = geo.attributes.position;
      for (let i = 0; i < attr.count; i++) {
        const x = attr.getX(i), y = attr.getY(i), r = Math.hypot(x, y), square = r > .001 ? r / Math.max(Math.abs(x), Math.abs(y)) : 1;
        attr.setXYZ(i, x * square, y * square, attr.getZ(i));
      }
      geo.computeVertexNormals();
      const piece = mesh(geo, pale, body, 1.10, -.13, .87); piece.name = 'reformable-record';
      rig.pose = arms => arms[1].reach(piece.position.x + .14, piece.position.y - .19, piece.position.z + .03, [.18, 1, 0]);
      rig.eyes = { y: .37, z: .465, spacing: .24 }; rig.top = .80; rig.shoulder = .77;
      rig.hands = [[-1.11, -.56, .21], [1.24, -.32, .90]]; rig.handDirections = [[-.20, -1, 0], [.18, 1, 0]];
      break;
    }
    case 'stamp': {
      // Turned handle, narrow neck and a distinct rubber printing surface.
      const points = [[.23, -.53], [.20, -.28], [.23, .02], [.46, .28], [.49, .51], [.34, .77], [.09, .83], [0, .84]].map(v => new THREE.Vector2(...v));
      mesh(new THREE.LatheGeometry(new THREE.SplineCurve(points).getPoints(64), 64), main, body);
      box(body, [1.44, .26, .91], main, [0, -.61, .01], .085);
      box(body, [1.31, .16, .80], dark, [0, -.81, .01], .04);
      const receipt = page(body, p, { width: 1.85, height: 1.35, position: [.12, -.915, .22], fold: .16 }); receipt.rotation.x = -Math.PI / 2; receipt.rotation.z = -.10;
      ring(receipt, .18, .015, main, [.57, -.35, .045]); tick(receipt, main, [.57, -.35, .055], .40);
      rig.bodyY = .97; rig.noFeet = true;
      rig.eyes = { y: .40, z: .49, spacing: .21 }; rig.top = .86; rig.shoulder = .32;
      rig.anchors = [[-.29, .25, 0], [.29, .25, 0]];
      rig.hands = [[-.73, -.16, .14], [.73, -.16, .14]];
      break;
    }
    case 'folio': {
      box(body, [1.48, 1.88, .16], main, [0, 0, -.05], .09);
      for (let i = 0; i < 3; i++) page(body, p, { width: 1.31, height: 1.66, position: [i * .018, -i * .018, .065 + i * .025], fold: .20 });
      box(body, [.65, .24, .20], dark, [0, .88, .10], .055); box(body, [.44, .10, .08], cream, [0, .88, .23], .035);
      line(body, [[-.15, .94, .16], [-.15, 1.06, .10], [.15, 1.06, .10], [.15, .94, .16]], cream, .024);
      ink(body, 'REPORT', .92, .17, [0, .61, .16], '#476783');
      rules(body, p, { y: -.10, z: .17, width: .91, count: 2, mat: dark });
      for (let i = 0; i < 3; i++) box(body, [.15, .14 + i * .10, .025], [pale, main, dark][i], [-.32 + i * .25, -.55 + i * .05, .18], .015);
      box(body, [.94, .016, .025], dark, [0, -.66, .18], .004);
      rig.eyes = { y: .28, z: .185, spacing: .21 }; rig.faceScale = .85; rig.top = 1.11; rig.bottom = -.79;
      for (const side of [-1, 1]) {
        ball(body, [.16, .19, .145], main, [side * .70, -.12, -.055]);
        box(body, [.35, .25, .28], main, [side * .43, -.85, -.055], .085);
      }
      rig.anchors = [[-.70, -.12, -.055], [.70, -.12, -.055]];
      rig.hands = [[-1.06, -.59, .12], [1.06, -.59, .12]];
      rig.legTops = [[-.43, -.85, -.055], [.43, -.85, -.055]];
      // A saddle fixed to the clipboard's back supports the wider capsule.
      box(body, [.63, .38, .18], main, [0, .87, -.17], .065);
      box(body, [.78, .13, .55], main, [0, 1.015, -.12], .05);
      rig.brainAt = [0, 1.10, -.12];
      break;
    }
    default: throw new Error(`Unknown Semantic mascot anatomy: ${shape}`);
  }
  return rig;
}
