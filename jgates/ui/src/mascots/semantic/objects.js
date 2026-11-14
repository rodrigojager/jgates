import * as THREE from 'three';
import { mesh, box, ball, group, vinyl, disk, ring, polygon, cylinder, line, ink, page, rules, tick, sorterHousing, coiledHandle, gavel } from './sculpt.js';

// Object anatomy of the six Semantic mascots, from the "thinking team" study (src/objects.js) with only the shortlisted
// shapes. Object anatomy comes first; the family's eyes and limbs are attached afterwards (models.js). The pieces a state
// animation moves (actor.js) are named in `rig.parts`; built as they are here, each model is its resting pose.
// `variant` selects between two builds of a mascot that are being compared (catalog.js lists them, the first is used).

/** The three sockets of Fit, in the order its records are delivered. */
export const SORTER_SOCKETS = Object.freeze([
  Object.freeze({ kind: 'circle', x: .53, y: -.29, size: .25 }),
  Object.freeze({ kind: 'triangle', x: 0, y: -.29, size: .22 }),
  Object.freeze({ kind: 'square', x: -.51, y: -.29, size: .20 }),
]);
const RECORD_RADIUS = .205;

/** Distance from the center of a finished record to its outline at an angle, for each socket shape. */
function recordRadius(kind, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  if (kind === 'circle') return RECORD_RADIUS * 1.17;
  if (kind === 'square') return RECORD_RADIUS / Math.max(Math.abs(c), Math.abs(s));
  // The triangle of the socket (apex up), a little smaller: the nearest edge crossed by the ray from the center.
  const t = .225, points = [[0, t], [-t, -t], [t, -t]];
  let nearest = Infinity;
  for (let i = 0; i < 3; i++) {
    const [ax, ay] = points[i], [bx, by] = points[(i + 1) % 3];
    const nx = by - ay, ny = ax - bx, along = nx * c + ny * s;
    if (Math.abs(along) < 1e-9) continue;
    const distance = (nx * ax + ny * ay) / along;
    if (distance > 0) nearest = Math.min(nearest, distance);
  }
  return nearest;
}

/**
 * Models a record: at `blend` 0 it is a mass with no shape, at 1 the low prism that fits the socket `kind`; in between
 * it is that mass part of the way to that shape, so each kind has its own stages. `spin` turns the mass about the
 * depth axis.
 */
export function shapeRecord(record, kind, blend, spin = 0) {
  const key = `${kind}:${Math.round(blend * 500)}:${spin}`;
  if (record.userData.shape === key) return;
  record.userData.shape = key;
  const unit = record.userData.unit, attr = record.geometry.attributes.position, mix = THREE.MathUtils.lerp;
  for (let i = 0; i < attr.count; i++) {
    const x = unit[i * 3], y = unit[i * 3 + 1], z = unit[i * 3 + 2], rho = Math.hypot(x, y), angle = Math.atan2(y, x);
    // The finished record: the wall of the prism where the sphere is widest, its two flat faces towards the poles.
    const outline = recordRadius(kind, angle), wall = rho >= .8, spread = wall ? 1 : rho / .8;
    const px = Math.cos(angle) * outline * spread, py = Math.sin(angle) * outline * spread, pz = wall ? .12 * THREE.MathUtils.clamp(z / .6, -1, 1) : Math.sign(z) * .12;
    // The mass it starts as: a lump, wider here and thinner there.
    // (`spin` turns the lumps around the record: the same mass seen from another side.)
    const turned = angle + spin;
    const lump = RECORD_RADIUS * 1.10 * (1 + .17 * Math.sin(3 * turned + 1.1 + z * 1.6) * rho + .10 * Math.sin(5 * turned - 2.0) * rho + .07 * z);
    const squat = 1 - .10 * Math.abs(Math.sin(turned));
    attr.setXYZ(i, mix(x * lump * squat, px, blend), mix(y * lump * squat, py, blend), mix(z * RECORD_RADIUS * .78, pz, blend));
  }
  attr.needsUpdate = true;
  record.geometry.computeVertexNormals();
}

function record(parent, mat, position, kind) {
  const geo = new THREE.SphereGeometry(1, 40, 24); geo.rotateX(Math.PI / 2); // the poles face front and back
  const piece = mesh(geo, mat, parent, ...position);
  piece.userData.unit = Float32Array.from(geo.attributes.position.array);
  shapeRecord(piece, kind, 1);
  return piece;
}

/** The balance Verdict holds like a torch: a post in the fist, a beam that tips on its top, two pans and a token for each. */
function scales(parent, p) {
  const root = group(parent); root.name = 'balance'; root.scale.setScalar(.95);
  const brass = p.cream, shade = p.dark;
  cylinder(root, .028, .034, .52, shade, [0, .30, 0], 'y');
  ball(root, [.05, .05, .05], brass, [0, .575, 0]);
  const beam = group(root, [0, .56, 0]); beam.name = 'balance-beam';
  box(beam, [1.0, .04, .05], shade, [0, 0, 0], .018);
  const pans = [-1, 1].map(side => {
    // A pan hangs from its end of the beam and stays level while the beam tips.
    const pan = group(beam, [side * .47, 0, 0]);
    for (const x of [-.14, .14]) line(pan, [[0, 0, 0], [x, -.29, 0]], brass, .011);
    cylinder(pan, .185, .13, .045, brass, [0, -.305, 0], 'y');
    return pan;
  });
  // What is weighed: the candidate on one pan, the evidence against it on the other; two cubes of the same color.
  // (Each in a group of its own, which is what appears and disappears.)
  const tokens = pans.map(pan => {
    const token = group(pan, [0, -.215, 0]); token.visible = false;
    box(token, [.14, .14, .14], p.main, [0, 0, 0], .025);
    return token;
  });
  return { root, beam, pans, tokens };
}

export function buildObject(body, p, shape, variant) {
  const { main, dark, cream, pale } = p;
  const rig = { faceHost: body, eyes: { y: .18, z: .4, spacing: .25 }, top: .9, shoulder: .72, bottom: -.70, footX: .43,
    hands: [[-1.05, -.45, .25], [1.05, -.35, .30]], parts: {} };
  switch (shape) {
    case 'compass': {
      const north = vinyl('#d53d3d'), northShade = vinyl('#b62e34'), south = vinyl('#f4ead2'), southShade = vinyl('#d3c7ab');
      disk(body, .89, .45, main, [0, .02, 0]); disk(body, .76, .035, pale, [0, .02, .28], .018);
      ring(body, .80, .045, dark, [0, .02, .285]);
      // The rose: eight fixed points of the same colors. The needle turns over its north and south.
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, length = i % 2 ? .24 : .36;
        const g = group(body, [0, -.27, .325]); g.rotation.z = -a;
        polygon(g, [[0, length], [-.048, .04], [0, 0]], .014, dark, [0, 0, 0], .005);
        polygon(g, [[0, length], [.048, .04], [0, 0]], .014, main, [0, 0, .002], .005);
      }
      for (const [letter, x, y] of [['N', 0, .65], ['S', 0, -.64], ['E', .64, -.03], ['W', -.64, -.03]]) ink(body, letter, .095, .12, [x, y, .33], '#3a7062');
      // The needle turns about the hub: a red half for north and a light half for south, longer and wider than the rose.
      const needle = group(body, [0, -.27, .334]); needle.name = 'compass-needle';
      for (const [tip, left, right] of [[.47, northShade, north], [-.41, south, southShade]]) {
        polygon(needle, [[0, tip], [-.078, 0], [0, 0]], .02, left, [0, 0, 0], .005);
        polygon(needle, [[0, tip], [.078, 0], [0, 0]], .02, right, [0, 0, .002], .005);
      }
      disk(body, .05, .03, dark, [0, -.27, .365], .005);
      rig.parts = { needle };
      rig.eyes = { y: .25, z: .34, spacing: .24 }; rig.top = .90; rig.bottom = -.65;
      rig.anchors = [[-.76, -.20, 0], [.76, -.20, 0]]; rig.hands = [[-1.02, -.80, .14], [1.02, -.80, .14]]; rig.armBody = { half: y => Math.sqrt(Math.max(0, .89 * .89 - (y - .02) ** 2)), front: .30, bottom: -.87, top: .91 };
      break;
    }
    case 'lenscoil': {
      coiledHandle(body, p);
      // Everything built so far is the serpent: its neck bends under the lens while the coil stays on the ground.
      const rattle = body.children.find(o => o.name === 'segmented-tail-rattle');
      const neck = body.children.filter(o => o.isMesh);
      // The lens, the face and the brain capsule ride on the head, which turns where the lens meets the neck (so the
      // two never part) and sways with it.
      const joint = -.08, up = .68 - joint;
      const head = group(body, [0, joint, 0]); head.name = 'lens-head';
      ring(head, .66, .12, main, [0, up, .02]); ring(head, .54, .024, dark, [0, up, .07]);
      // The straight handle and S-curved body are one uninterrupted surface.
      const lensMat = vinyl('#e8dfd5', { transparent: true, opacity: .30, roughness: .19, clearcoat: .32, metalness: .02, depthWrite: false });
      const lens = ball(head, [.524, .524, .073], lensMat, [0, up, .026]); lens.name = 'convex-optical-lens';
      ring(head, .515, .011, pale, [0, up, .062]); ring(head, .54, .018, dark, [0, up, -.065]);
      // A highlight that crosses the lens while it searches; invisible in the resting pose.
      const glint = mesh(new THREE.PlaneGeometry(.085, .46), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, toneMapped: false }), head, 0, up, .105);
      glint.rotation.z = -.5; glint.name = 'lens-glint';
      rig.parts = { head, neck, rattle, glint, joint };
      rig.faceHost = head; rig.eyes = { y: up + .05, z: .125, spacing: .22 }; rig.noFeet = true; rig.noArms = true; rig.top = 1.37;
      rig.capsuleHost = head; rig.brainAt = [0, rig.top - .04 - joint, -.035];
      break;
    }
    case 'gavel': {
      // The gavel rocks, hops and tips over on the foot of its handle, which rests in the socket of the sound block.
      const rocker = group(body, [0, -.75, 0]); rocker.name = 'gavel-rocker';
      const hammer = gavel(rocker, p, [0, .79, 0], 1.15);
      rig.faceHost = hammer; rig.eyes = { y: .49, z: .30, spacing: .23 };
      rig.noFeet = true; rig.bodyY = 1.25; rig.top = .98;
      cylinder(body, .59, .67, .20, dark, [0, -1.07, .03], 'y');
      cylinder(body, .53, .56, .09, pale, [0, -.94, .03], 'y');
      // The foot of the handle goes where the gavel goes (it stands in the middle of the block, or beside it).
      box(rocker, [.26, .29, .28], main, [0, -.03, 0], .09);
      // The ring a strike sends across the sound block; invisible in the resting pose.
      const shock = ring(body, .50, .028, new THREE.MeshBasicMaterial({ color: '#fff5df', transparent: true, opacity: 0, depthWrite: false, toneMapped: false }), [0, -.885, .03]);
      shock.rotation.x = Math.PI / 2; shock.name = 'strike-ring';
      rig.parts = { rocker, shock };
      rig.armHost = rocker; rig.capsuleHost = rocker; rig.brainAt = [0, rig.top - .04 + .75, -.035];
      // Slim arms for a slim handle.
      rig.shoulder = .09; rig.anchors = [[-.09, .54, 0], [.09, .54, 0]]; rig.armGirth = .74; rig.armBody = { half: .16, front: .16, bottom: .05, top: .92 };
      rig.hands = [[-.34, -.02, .16], [.34, -.02, .16]];
      if (variant === 'scales') {
        rig.parts.balance = scales(rocker, p);
        // The balance stands in the fist of the hand that is on the left of the picture.
        // The two arms are the same length: the balance is held close.
        rig.hands[0] = [-.74, .24, .38];
        rig.parts.balance.root.position.set(-.74, .36, .38);
      }
      break;
    }
    case 'shape-sorter': {
      const holes = [{ kind: 'square', x: -.51, y: -.29, size: .20 }, { kind: 'triangle', x: 0, y: -.29, size: .22 }, { kind: 'circle', x: .53, y: -.29, size: .25 }];
      sorterHousing(body, main, holes);
      // The resting pose: a square record waits on the right hand, outside the housing. The two other records exist
      // only while a state shows them (a record is modelled into the shape of its socket and seated there).
      const records = SORTER_SOCKETS.map((_, i) => record(body, pale, [1.10, -.13, .87], i ? SORTER_SOCKETS[i].kind : 'square'));
      records[0].name = 'reformable-record';
      records[1].visible = records[2].visible = false;
      rig.parts = { records };
      rig.eyes = { y: .37, z: .465, spacing: .24 }; rig.top = .80; rig.shoulder = .77; rig.armBody = { half: .86, front: .43, bottom: -.78, top: .78 };
      rig.hands = [[-1.02, -.72, .16], [1.24, -.34, .88]];
      // (The right hand carries a record in the resting pose; this is where it hangs when it carries nothing.)
      rig.hang = [[-1.02, -.72, .16], [1.02, -.72, .16]];
      break;
    }
    case 'stamp': {
      // Turned handle, narrow neck and a distinct rubber printing surface: the press, which lifts off the receipt.
      const press = group(body); press.name = 'stamp-press';
      const points = [[.23, -.53], [.20, -.28], [.23, .02], [.46, .28], [.49, .51], [.34, .77], [.09, .83], [0, .84]].map(v => new THREE.Vector2(...v));
      mesh(new THREE.LatheGeometry(new THREE.SplineCurve(points).getPoints(64), 64), main, press);
      box(press, [1.44, .26, .91], main, [0, -.61, .01], .085);
      box(press, [1.31, .16, .80], dark, [0, -.81, .01], .04);
      const receipt = page(body, p, { width: 1.85, height: 1.35, position: [.12, -.915, .22], fold: .16 }); receipt.rotation.x = -Math.PI / 2; receipt.rotation.z = -.10;
      // Three approval marks in a row along the front of the receipt; the resting pose shows the last one.
      const marks = [-.45, .06, .57].map(x => {
        const mark = group(receipt, [x, -.35, 0]);
        ring(mark, .18, .015, main, [0, 0, .045]); tick(mark, main, [0, 0, .055], .40);
        return mark;
      });
      marks[0].visible = marks[1].visible = false;
      // The mark of a verification that failed; invisible in the resting pose.
      const refusal = vinyl('#d53d3d');
      const cross = group(receipt, [.06, -.35, .05]); cross.visible = false; cross.name = 'refusal-mark';
      for (const sign of [-1, 1]) { const bar = box(cross, [.07, .40, .03], refusal, [0, 0, 0], .012); bar.rotation.z = sign * Math.PI / 4; }
      rig.parts = { press, receipt, marks, cross };
      // The stamp is a short object: enlarged to stand as tall as the others.
      rig.bodyY = .97; rig.noFeet = true; rig.scale = 1.2;
      rig.faceHost = press; rig.armHost = press; rig.capsuleHost = press;
      rig.eyes = { y: .40, z: .49, spacing: .21 }; rig.top = .86; rig.shoulder = .32;
      rig.noArms = variant !== 'arms';
      rig.anchors = [[-.29, .25, 0], [.29, .25, 0]]; rig.armBody = { half: y => (y < -.48 ? .72 : .44), front: .46, bottom: -.89, top: .80 };
      rig.hands = [[-.56, -.30, .18], [.56, -.30, .18]];
      break;
    }
    case 'folio': {
      box(body, [1.48, 1.88, .16], main, [0, 0, -.05], .09);
      for (let i = 0; i < 3; i++) page(body, p, { width: 1.31, height: 1.66, position: [i * .018, -i * .018, .065 + i * .025], fold: .20 });
      box(body, [.65, .24, .20], dark, [0, .88, .10], .055); box(body, [.44, .10, .08], cream, [0, .88, .23], .035);
      line(body, [[-.15, .94, .16], [-.15, 1.06, .10], [.15, 1.06, .10], [.15, .94, .16]], cream, .024);
      ink(body, 'REPORT', .92, .17, [0, .61, .16], '#476783');
      // The report's content, written and drawn by the working state: two lines of text and a chart of three bars.
      const written = body.children.length;
      rules(body, p, { y: -.10, z: .17, width: .91, count: 2, mat: main });
      const lines = body.children.slice(written).map((bar, i) => { const width = .91 * (i === 1 ? .66 : 1); return { mesh: bar, left: bar.position.x - width / 2, width }; });
      const bars = [0, 1, 2].map(i => ({ mesh: box(body, [.15, .14 + i * .10, .025], [pale, main, dark][i], [-.32 + i * .25, -.55 + i * .05, .18], .015), height: .14 + i * .10, floor: -.62 }));
      box(body, [.94, .016, .025], dark, [0, -.66, .18], .004);
      // The pencil it writes with, in the color of its body, which is the color of what it writes. Built point down
      // from its own origin, so that the point can be put on the page; out of sight in the resting pose.
      const pencil = group(body); pencil.name = 'pencil'; pencil.visible = false;
      const point = mesh(new THREE.ConeGeometry(.032, .075, 18), pale, pencil, 0, .0375, 0); point.rotation.x = Math.PI;
      const lead = mesh(new THREE.ConeGeometry(.013, .030, 12), main, pencil, 0, .015, 0); lead.rotation.x = Math.PI;
      cylinder(pencil, .032, .032, .30, main, [0, .225, 0], 'y');
      cylinder(pencil, .034, .034, .035, dark, [0, .392, 0], 'y');
      cylinder(pencil, .030, .030, .035, pale, [0, .427, 0], 'y');
      rig.parts = { lines, bars, pencil };
      rig.eyes = { y: .28, z: .185, spacing: .21 }; rig.faceScale = .85; rig.top = 1.11; rig.bottom = -.79;
      // (No ball at the shoulder: the hose widens where it leaves the thin board, as an arm grows out of a body.)
      for (const side of [-1, 1]) box(body, [.35, .25, .28], main, [side * .43, -.85, -.055], .085);
      rig.armFlare = .45;
      rig.anchors = [[-.66, -.12, -.03], [.66, -.12, -.03]]; rig.armBody = { half: .74, front: .16, bottom: -.94, top: .94 };
      rig.hands = [[-.94, -.74, .10], [.94, -.74, .10]];
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
