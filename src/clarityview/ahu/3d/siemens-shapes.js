/**
 * siemens-shapes.js — the Siemens field-device archetypes (siemens-spec.md §3.4).
 *
 * Each archetype turns a part record (web/shared/siemens/parts.js) into a list
 * of parts in MILLIMETRES, in the device's own frame:
 *   sensors, room units, controllers   origin = centre of the mounting face,
 *                                      +Z out of the surface, +Y up
 *   rotary actuators                   origin on the shaft axis, +Z along the
 *                                      shaft (out), the body hangs along −Y
 *   valve bodies, linear actuators     origin on the pipe centreline (actuators:
 *                                      the coupling face), +Y up the stem,
 *                                      +Z along the pipe
 * Part = { geo, finish, anim?: 'hub' | 'stem' | 'display', full?, embed?, ext? }
 *   full   only drawn at full detail          embed  only drawn at embed detail
 *   ext    outside the catalogue envelope (probes, flanges, tubes, glands,
 *          cables, reducers): excluded from the ±3 % size check
 * No state, no materials: siemens3d.js merges, caches and colours the parts.
 * Sizes are the datasheet numbers quoted in parts.js; shapes marked ≈ there
 * are drawn at the verified envelope with a plausible form.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let SEG = 1;                       // segment scale: 1 at full detail, lower at embed (set per build)
const sg = (n) => Math.max(5, Math.round(n * SEG));

// ---- primitives (mm) ----------------------------------------------------------

function box(w, h, d, x = 0, y = 0, z = 0) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}
/** Rounded box at full detail, plain box at embed. */
function rbox(w, h, d, r, x, y, z, full) {
  if (!full) return box(w, h, d, x, y, z);
  return new RoundedBoxGeometry(w, h, d, 1, Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01)).translate(x, y, z);
}
/** Cylinder along Y from y0 to y1. */
function cylY(r0, r1, y0, y1, seg, x = 0, z = 0) {
  return new THREE.CylinderGeometry(r1, r0, Math.abs(y1 - y0), sg(seg)).translate(x, (y0 + y1) / 2, z);
}
/** Cylinder along Z from z0 to z1 (r0 at z0). */
function cylZ(r0, r1, z0, z1, seg, x = 0, y = 0) {
  const g = new THREE.CylinderGeometry(r1, r0, Math.abs(z1 - z0), sg(seg)).rotateX(Math.PI / 2);
  return g.translate(x, y, (z0 + z1) / 2);
}
/** Cylinder along X from x0 to x1. */
function cylX(r0, r1, x0, x1, seg, y = 0, z = 0) {
  const g = new THREE.CylinderGeometry(r1, r0, Math.abs(x1 - x0), sg(seg)).rotateZ(-Math.PI / 2);
  return g.translate((x0 + x1) / 2, y, z);
}
/** A rounded rectangle w × h (corner radius r) in XY, extruded along Z from z0 by depth. */
function slab(w, h, r, depth, x = 0, y = 0, z0 = 0, seg = 3) {
  const s = new THREE.Shape();
  const rr = Math.min(r, w / 2, h / 2);
  const x0 = -w / 2, y0 = -h / 2;
  s.moveTo(x0 + rr, y0);
  s.lineTo(x0 + w - rr, y0); s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + rr);
  s.lineTo(x0 + w, y0 + h - rr); s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - rr, y0 + h);
  s.lineTo(x0 + rr, y0 + h); s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - rr);
  s.lineTo(x0, y0 + rr); s.quadraticCurveTo(x0, y0, x0 + rr, y0);
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: seg }).translate(x, y, z0);
}
/** A body w wide whose top is a half-round of radius w/2 centred on (0, 0); bottom at y = -below. */
function headSlab(w, below, depth, z0, seg) {
  const s = new THREE.Shape();
  const r = w / 2;
  s.moveTo(-r, -below);
  s.lineTo(r, -below);
  s.lineTo(r, 0);
  s.absarc(0, 0, r, 0, Math.PI, false);
  s.lineTo(-r, -below);
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: seg }).translate(0, 0, z0);
}
/** A flat plane facing +Z at z. */
function plane(w, h, x, y, z) {
  return new THREE.PlaneGeometry(w, h).translate(x, y, z);
}
/** Round tube through a polyline of [x, y, z] points (mm). */
export function tubeGeo(points, r, seg = 6) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const a = new THREE.Vector3(...points[i - 1]), b = new THREE.Vector3(...points[i]);
    const len = a.distanceTo(b);
    if (len < 1e-6) continue;
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.applyQuaternion(q).translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    out.push(g);
  }
  return out;
}

const P = (geo, finish, extra) => ({ geo, finish, ...extra });

// ---- sensors ------------------------------------------------------------------

/** Symaro duct sensors: base tray + cover on an AQM63.0 flange; flex probe, rod, or chamber + rod. */
function symaro(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims, step = rec.dims.step || 3.7;
  const so = rec.mount?.standoff ?? 40;
  const parts = [];
  let z0 = so;
  if (rec.chamber) {
    const c = rec.chamber;
    parts.push(P(rbox(c.w, c.h, c.d, 4, 0, 0, so + c.d / 2, full), f.chamber || f.base, { ext: true }));
    z0 = so + c.d;
  }
  // housing: rounded vertical edges (a rounded rectangle in X–Z, extruded up Y)
  const tray = slab(w, step, 8, h, 0, 0, 0, full ? 3 : 1).rotateX(-Math.PI / 2).translate(0, -h / 2, z0 + step / 2);
  parts.push(P(tray, f.base));
  const cd = d - step;
  const cover = slab(w, cd, 8, h, 0, 0, 0, full ? 3 : 1).rotateX(-Math.PI / 2).translate(0, -h / 2, z0 + step + cd / 2);
  parts.push(P(cover, f.cover));
  if (full) {
    // crowned face: a low pad on the cover front, and the SIEMENS mark top-left
    parts.push(P(box(w - 16, h - 14, 0.6, 0, 0, z0 + d - 0.3), f.cover, { full: true }));
    parts.push(P(plane(20, 3, -w / 2 + 16, h / 2 - 7, z0 + d + 0.05), 'wordmark', { full: true }));
  }
  if (rec.gland) parts.push(P(cylY(8, 9, -h / 2 - rec.gland.len, -h / 2, 8, 0, z0 + d / 2), f.gland, { ext: true, full: true }));
  // AQM63.0 flange on the duct: plate, cone, clamp sleeve up to the housing
  parts.push(P(box(80, 50, 3, 0, 0, 1.5), f.flange, { ext: true, full: true }));
  parts.push(P(cylZ(20, 10, 3, 20, 12), f.flange, { ext: true, full: true }));
  parts.push(P(cylZ(10, 10, 20, so, 10), f.flange, { ext: true, full: true }));
  const pr = rec.probe || { kind: 'flex', len: 400, dia: 6 };
  if (pr.kind === 'flex') {
    const len = rec.averaging ? 150 : pr.len;            // the averaging element is drawn across the section by the view
    const r = pr.dia / 2;
    parts.push(P(cylZ(r, r, z0, z0 - len + 30, 8), f.probe, { ext: true, full: true }));
    if (!rec.averaging) parts.push(P(tubeGeo([[0, 0, z0 - len + 30], [0, -12, z0 - len + 8], [0, -30, z0 - len]], r, 6).reduce(mergeInto), f.probe, { ext: true, full: true }));
  } else {
    const r = pr.dia / 2;
    parts.push(P(cylZ(r, r, z0, z0 - pr.len + 12, 10), f.probe, { ext: true, full: true }));
    parts.push(P(cylZ(r + 1, r + 1, z0 - pr.len + 12, z0 - pr.len, 10), f.probe, { ext: true, full: true }));
  }
  // embed: the body and a short stub of the probe
  parts.push(P(cylZ(4, 4, z0, 0, 6), f.flange, { ext: true, embed: true }));
  return parts;
}

/** Air dP transmitter: frosted body, slate label, two nipples pointing down. */
function qbm(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims;
  const bw = rec.fitting === 'right' ? w - 20 : w;
  const bx = rec.fitting === 'right' ? -10 : 0;
  const parts = [P(rbox(bw, h, d, 5, bx, 0, d / 2, full), f.body)];
  if (rec.fitting === 'right') parts.push(P(cylX(10, 11, bx + bw / 2, w / 2, 8, 12, d / 2), f.fitting || f.body));
  if (full) parts.push(P(plane(bw * 0.38, 12, bx - bw * 0.22, -h / 2 + 12, d + 0.1), f.label, { full: true }));
  for (const sx of [-9, 9]) parts.push(P(cylY(3.1, 3.1, -h / 2 - 11, -h / 2, 6, bx + sx, d / 2), f.nipple, { ext: true }));
  return parts;
}

/** Air velocity sensor: □86 transducer; the ø12 stem goes into the duct through its own flange below. */
function qvm62(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims;
  const parts = [
    P(rbox(w, h, 10, 3, 0, 0, 5, full), f.base),
    P(rbox(w - 2, h - 2, d - 10, 4, 0, 0, 10 + (d - 10) / 2, full), f.cover),
  ];
  if (full) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(P(cylZ(3, 3, d, d + 0.8, 6, sx * (w / 2 - 8), sy * (h / 2 - 8)), f.base, { full: true }));
    parts.push(P(cylY(5, 6, h / 2, h / 2 + 12, 8, 0, d / 2), f.cover, { ext: true, full: true }));      // Pg9 top
    parts.push(P(cylY(7, 6, -h / 2 - 12, -h / 2, 8, 0, d / 2), f.cover, { ext: true, full: true }));    // Pg11 bottom
  }
  const sy = -h / 2 - 60;                        // stem flange below the transducer
  const s = rec.stem || { dia: 12, len: 327 };
  parts.push(P(box(55, 42, 3, 0, sy, 1.5), f.flange, { ext: true, full: true }));
  parts.push(P(cylZ(20, 20, 3, 14, 12, 0, sy), f.flange, { ext: true, full: true }));
  parts.push(P(cylZ(s.dia / 2, s.dia / 2, 14, -s.len + 20, 8, 0, sy), f.stem, { ext: true }));
  parts.push(P(cylZ(s.dia / 2 + 2, s.dia / 2 + 2, -s.len + 20, -s.len, 8, 0, sy), f.cover, { ext: true, full: true }));
  if (full) parts.push(P(tubeGeo([[0, -h / 2 - 12, d / 2], [0, sy + 20, d / 2], [0, sy + 20, 14]], 2.5, 5).reduce(mergeInto), f.cable, { ext: true, full: true }));
  return parts;
}

/**
 * Setra 264 with its grey cover (the user's photo): a rounded portrait cover,
 * the ribbed lower panel with the setra mark, a white range label between two
 * brass barbed pressure fittings on the face (LOW above, HIGH below), the
 * conduit opening in the bottom end. rec.ports gives the fittings' tips (mm)
 * so the sensing tubes land on them. Every size ≈ until measured.
 */
function setra264(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims;
  const bd = d - 10;                                   // cover depth; the fittings reach d
  const parts = [P(rbox(w, h, bd, 7, 0, 0, bd / 2, full), f.body)];
  if (full) {
    // ribbed lower panel with the mark
    parts.push(P(box(w - 16, h * 0.4, 1.2, 0, -h * 0.24, bd + 0.6), f.grille, { full: true }));
    for (let i = 0; i < 7; i++) parts.push(P(box(w - 22, 1.6, 1.4, 0, -h * 0.07 - i * (h * 0.36 / 6), bd + 1.3), f.body, { full: true }));
    parts.push(P(plane(w * 0.46, 8, 0, -h * 0.24, bd + 2.05), f.ink, { full: true }));
    parts.push(P(plane(w * 0.5, 14, 0, h * 0.19, bd + 0.1), f.label, { full: true }));
    parts.push(P(box(18, 0.8, 16, 0, -h / 2 + 0.2, bd / 2), f.ink, { full: true }));      // conduit opening
  }
  for (const [, py] of rec.ports || [[0, h * 0.33], [0, h * 0.05]]) {
    parts.push(P(cylZ(3.2, 3.2, bd, d - 4, 8, 0, py), f.nipple));
    parts.push(P(cylZ(3.9, 2.2, d - 4, d, 8, 0, py), f.nipple));
  }
  return parts;
}

/**
 * Powers (Siemens) low limit, as in the user's photo: a grey enamel housing on
 * its galvanised bracket, the DEG FAHR scale window on the left, the POWERS
 * label with the black PUSH TO RESET block and its white button on the right,
 * the adjusting screw and a terminal post on top, the capillary gland below.
 */
function powersBox(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims;
  const bd = d - 2;
  const parts = [P(rbox(w, h, bd, 3, 0, 0, bd / 2, full), f.body)];
  parts.push(P(box(w * 0.34, h + 64, 2.5, 0, 0, -1.25), f.strap, { ext: true, full: true }));            // bracket (photo)
  parts.push(P(cylY(7, 4.5, -h / 2 - 14, -h / 2, 10, 0, bd * 0.45), f.capillary, { ext: true }));         // capillary gland
  if (full) {
    // scale window: dark rim, cream DEG FAHR scale
    parts.push(P(box(w * 0.27, h * 0.52, 1.2, -w * 0.25, h * 0.06, bd + 0.6), f.dark, { full: true }));
    parts.push(P(plane(w * 0.22, h * 0.46, -w * 0.25, h * 0.06, bd + 1.25), f.scale, { full: true }));
    // label: white plate, the POWERS band, the black reset block with its button
    parts.push(P(plane(w * 0.42, h * 0.56, w * 0.2, h * 0.04, bd + 0.1), f.label, { full: true }));
    parts.push(P(plane(w * 0.38, h * 0.17, w * 0.2, h * 0.22, bd + 0.15), f.band, { full: true }));
    parts.push(P(plane(w * 0.16, h * 0.2, w * 0.1, -h * 0.1, bd + 0.15), f.dark, { full: true }));
    parts.push(P(cylZ(w * 0.04, w * 0.04, bd, d, 12, w * 0.3, -h * 0.1), f.label, { full: true }));
    parts.push(P(cylZ(2.5, 2.5, bd, bd + 1.2, 8, 0, -h * 0.36), f.strap, { full: true }));                  // cover screw
    parts.push(P(cylY(3.8, 3.8, h / 2, h / 2 + 12, 8, w * 0.12, bd * 0.5), f.screw, { ext: true, full: true }));   // adjusting screw
    parts.push(P(cylY(2.6, 2.6, h / 2, h / 2 + 8, 8, -w * 0.3, bd * 0.5), f.strap, { ext: true, full: true }));    // terminal post
  }
  return parts;
}

// ---- room units -------------------------------------------------------------------

/**
 * QMX3 (CM2N1602en_10 drawing 1602m01): back plate recessed at the wall, the
 * 88.4 × 133.4 × 18 front shell (corner r 3), the LCD window, the Green Leaf
 * LED (drawn unlit, neutral), wordmark and touchkey ticks at full detail.
 */
function qmx3(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims, pl = rec.plate || { w: 80.5, h: 115, d: 4 };
  const face = opts.color === 'black' ? f.black : f.white;
  // the shell's sides read as the thin grey bezel of the photo; the front is the face texture
  const parts = [
    P(box(pl.w, pl.h, pl.d, 0, 0, pl.d / 2), f.side, { full: true }),
    P(rbox(w, h, d - (full ? pl.d : 0), 3, 0, 0, full ? pl.d + (d - pl.d) / 2 : d / 2, full), full ? f.side : face),
    // the whole front face (1 mm inside the bezel): wordmark, Green Leaf, LCD window, key marks
    P(plane(w - 2, h - 2, 0, 0, d + 0.1), 'lcdOff', { anim: 'display' }),
  ];
  return parts;
}

/** A box at the record's envelope: the fallback for any record with no archetype yet. */
function plainBox(rec) {
  const { w, h, d } = rec.dims;
  const fin = rec.finish?.base || rec.finish?.body || 'ral7035';
  if (rec.rotary) {
    const top = rec.hub?.fromTop ?? h / 2;
    return [
      P(box(w, h, d, 0, top - h / 2, 0), fin),
      P(cylZ(12, 12, -d / 2, d / 2 + 0.5, 10), 'pa66Black', { anim: 'hub' }),
    ];
  }
  return [P(box(w, h, d, 0, 0, d / 2), fin)];
}

// ---- controllers -----------------------------------------------------------------

/**
 * DXR2 room automation station, as in the E12P / E17CX photos: the stepped
 * DIN housing (a deep centre cover over two terminal tiers), mounting ears,
 * the green KNX plug, two RJ45 jacks, the upper screw-terminal row and the
 * USB-B port on the top tier; the orange 24 V plug and the lower terminal
 * rows below; the SIEMENS mark, vent slots, RUN LED and SVC button on the
 * cover; the P1+ / P1− pressure ports (VAV types) under the lower tier.
 */
function ctrlBox(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims;
  const tier = d * 0.7, coverH = h * 0.44;
  const parts = [
    P(rbox(w, h - 7, tier, 3, 0, 0, tier / 2, full), f.body),                    // the two tiers
    P(rbox(w - 4, coverH, d, 4, 0, 0, d / 2, full), f.body),                     // the centre cover
  ];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(P(box(11, 7, 3, sx * w * 0.36, sy * (h / 2 - 3.5), 1.5), f.body));   // DIN ears
  if (full) {
    const up = h / 2 - 3.5 - (h / 2 - 3.5 - coverH / 2) / 2, lo = -up;           // tier centre lines
    const scr = (x0, n, y) => { for (let i = 0; i < n; i++) parts.push(P(cylZ(2.2, 2.2, tier + 7, tier + 8.2, 8, x0 + i * 6.2, y), f.screw, { full: true })); };
    const block = (x0, n, y) => { parts.push(P(box(n * 6.2 + 3, 11, 8, x0 + (n - 1) * 3.1, y, tier + 4), f.terminals, { full: true })); scr(x0, n, y); };
    // top tier: KNX (green), RJ45 × 2, terminals, USB-B
    parts.push(P(box(15, 11, 11, -w * 0.4, up, tier + 5.5), f.knx, { full: true }));
    for (const x of [-w * 0.22, -w * 0.12]) {
      parts.push(P(box(15, 12, 10, x, up, tier + 5), f.jack, { full: true }));
      parts.push(P(plane(10, 6, x, up - 1, tier + 10.1), f.port, { full: true }));
    }
    const nTop = Math.max(6, Math.round((w - 120) / 6.2));
    block(-w * 0.02, Math.min(nTop, 11), up);
    parts.push(P(box(12, 11, 8, w * 0.4, up, tier + 4), f.port, { full: true }));
    // bottom tier: 24 V (orange), terminal rows
    parts.push(P(box(16, 11, 11, -w * 0.4, lo, tier + 5.5), f.power, { full: true }));
    const nLo = Math.max(9, Math.round((w - 60) / 6.2));
    block(-w * 0.2, Math.ceil(nLo * 0.62), lo);
    block(-w * 0.2 + (Math.ceil(nLo * 0.62) + 1) * 6.2, Math.floor(nLo * 0.38), lo);
    // cover: mark, vents, RUN, SVC
    parts.push(P(plane(24, 3.6, -w * 0.3, coverH * 0.28, d + 0.1), f.mark, { full: true }));
    parts.push(P(plane(w * 0.24, coverH * 0.2, -w * 0.26, -coverH * 0.02, d + 0.1), f.label, { full: true }));
    for (const x of [-w / 2 + 7, -w / 2 + 11]) parts.push(P(plane(1.6, coverH * 0.5, x, 0, d + 0.1), f.port, { full: true }));
    parts.push(P(cylZ(1.6, 1.6, d, d + 0.8, 8, w * 0.36, coverH * 0.15), f.led, { full: true }));
    parts.push(P(cylZ(3.4, 3.4, d, d + 1, 12, w * 0.36, -coverH * 0.18), f.port, { full: true }));
  }
  // P1+ / P1− pressure ports under the lower tier (VAV types): rec.ports are their tips
  if (rec.nipples) for (const [x, y, z] of rec.ports) parts.push(P(cylY(2.6, 2.6, y, -h / 2 + 3.5, 8, x, z), f.nipple, { ext: true }));
  return parts;
}

/** Hub parts shared by the OpenAir actuators and the actuating controllers: bushing, pointers, clamp. */
function hubParts(f, r, z0, z1, clamp) {
  const out = [
    P(cylZ(r, r, z0, z1, 14), f.hub, { anim: 'hub' }),
    P(box(3, r * 0.9, 1.2, 0, r * 0.62, z1 + 0.6), f.pointer, { anim: 'hub' }),
    P(box(3, r * 0.9, 1.2, 0, -r * 0.62, z1 + 0.6), f.pointer, { anim: 'hub' }),
  ];
  if (clamp) out.push(P(clamp, f.clamp || 'galv', { anim: 'hub' }));
  return out;
}

/** DXR2.E10PL / M10PL and DXR1.E10PL: the controller body on the damper shaft; the hub is the shaft clamp. */
function ctrlActuating(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims;
  const top = rec.hub?.fromTop ?? 40, hx = rec.hub?.x ?? 0;
  const bx = -hx;                              // the body sits off the hub by the hub's offset
  const mod = rec.module || 0;
  const parts = [];
  if (mod > 0) {
    parts.push(P(rbox(w, mod, d, 4, bx, top - mod / 2, 0, full), f.body));                           // actuator module (full depth)
    const cl = h - mod, cd = d * 0.74;
    parts.push(P(rbox(w, cl, cd, 4, bx, top - mod - cl / 2, -d / 2 + cd / 2, full), f.body));        // controller section (lower)
    if (full) {
      parts.push(P(box(w * 0.8, 9, 3, bx, top - h + 10, -d / 2 + cd + 1.5), f.terminals, { full: true }));
      parts.push(P(plane(w * 0.4, cl * 0.3, bx - w * 0.15, top - mod - cl * 0.45, -d / 2 + cd + 0.1), f.label, { full: true }));
      parts.push(P(cylZ(2, 2, d / 2, d / 2 + 1, 8, bx + w * 0.3, top - mod * 0.3), f.led, { full: true }));
    }
  } else {
    parts.push(P(rbox(w, h, d, 5, bx, top - h / 2, 0, full), f.body));
    if (full) {
      parts.push(P(box(w * 0.7, 9, 3, bx, top - h + 10, d / 2 + 1.5 - 3), f.terminals, { full: true }));
      parts.push(P(plane(w * 0.35, h * 0.2, bx + w * 0.15, top - h * 0.62, d / 2 + 0.1), f.label, { full: true }));
    }
  }
  const r = (rec.hub?.dia ?? 34) / 2;
  const clampGeo = box(r * 1.9, 7, d * 0.5, 0, r + 4, d * 0.1);
  parts.push(...hubParts(f, r, -d / 2, d / 2 - 0.5, clampGeo));
  if (f.disc) {
    // the position disc of the photo: black, with the two yellow tips (they turn with the blade)
    parts.push(P(cylZ(r * 1.45, r * 1.45, d / 2 - 0.5, d / 2 + 0.2, 20), f.hub, { anim: 'hub' }));
    for (const sy of [-1, 1]) parts.push(P(box(r * 0.9, r * 0.5, 0.9, 0, sy * r * 1.05, d / 2 + 0.5).rotateZ(sy > 0 ? 0 : 0), f.disc, { anim: 'hub' }));
  }
  if (rec.ports) for (const [x, y, z] of rec.ports) parts.push(P(cylX(2.6, 2.6, bx + w / 2 - 1, x, 8, y, z), f.nipple || f.hub, { ext: true, full: true }));
  return parts;
}

// ---- OpenAir damper actuators -------------------------------------------------------

/** GCA (and GBB / GIB): 300 × 100 × 68 die-cast body, hub 78 below the top, 100 mm foot. */
function oaXL(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, b = rec.body || { w: 100, h: 300, d: 68 };
  const top = rec.hub?.fromTop ?? 78;
  const env = rec.dims;
  const parts = [
    P(slab(b.w, b.h, 12, b.d, 0, top - b.h / 2, -b.d / 2, full ? 3 : 1), f.body),
    P(box(b.w - 8, env.h - b.h, b.d - 12, 0, top - b.h - (env.h - b.h) / 2, 0), f.body),             // conduit foot
  ];
  if (full) {
    parts.push(P(plane(b.w * 0.6, 34, 0, top - b.h * 0.7, b.d / 2 + 0.1), 'whiteLabel', { full: true }));
    parts.push(P(cylZ(5, 5, b.d / 2, b.d / 2 + 1, 6, -b.w * 0.25, top - b.h * 0.42), 'pa66Black', { full: true }));   // manual override socket
  }
  const zc = env.d / 2;
  const bolt = cylX(5, 5, b.w / 2 - 4, env.w - b.w / 2, 8, 0, zc - 10);                             // clamp bolt: sticks out 20 mm
  parts.push(...hubParts(f, 20, -zc, zc - 1.2, bolt));
  return parts;
}

/** GMA (and GEB): 212 × 83 × 68, a half-round head concentric with the hub 42 below the top. */
function oaTall(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims;
  const top = rec.hub?.fromTop ?? 42;
  const parts = [P(headSlab(w, h - top, d, -d / 2, full ? 16 : 6), f.body)];
  if (full) parts.push(P(plane(w * 0.7, 28, 0, top - h * 0.72, d / 2 + 0.1), 'whiteLabel', { full: true }));
  parts.push(...hubParts({ ...f, hub: f.clamp || 'galv' }, 15, -d / 2 + 4, d / 2 - 1.2, box(8, 8, 10, 15, 0, d / 2 - 8)));
  return parts;
}

/** GDE / GLB / GDB181: the compact plastic body along the shaft side, galvanised clamp by the hub. */
function oaCompact(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims;
  const bh = rec.body?.h ?? 137, head = rec.hub?.fromHead ?? 33.2;
  const clampH = 10, tail = h - bh - clampH;                   // clamp beyond the head end; cable / adapter beyond the far end
  const bd = d - 1;
  const parts = [P(rbox(w, bh, bd, 5, 0, head - bh / 2, -0.5, full), f.body)];
  parts.push(P(box(22, tail, 18, 0, head - bh - tail / 2, -d / 2 + 14), 'pa66Black'));              // cable / conduit adapter
  if (full) {
    parts.push(P(plane(w - 12, bh * 0.45, 0, head - bh * 0.72, bd / 2 - 0.5 + 0.1), f.label, { full: true }));
    parts.push(P(box(10, 12, 1, w / 2 - 9, head - bh * 0.84, bd / 2 - 0.5 + 0.5), f.override, { full: true }));
  }
  const clampGeo = box(34, clampH, 30, 0, head + clampH / 2, -4);
  parts.push(...hubParts(f, 14, -d / 2, d / 2 - 1.2, clampGeo));
  return parts;
}

/** GQD: two plastic shells lying flat, hub 22.5 from one end under a black square clamp collar. */
function oaMini(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims;
  const head = rec.hub?.fromHead ?? 22.5;
  const sd = d - 6;
  const parts = [
    P(rbox(w, h, sd * 0.5, 4, 0, head - h / 2, -d / 2 + sd * 0.25, full), f.body),
    P(rbox(w - 2, h - 2, sd * 0.5, 6, 0, head - h / 2, -d / 2 + sd * 0.75, full), f.body),
  ];
  const collar = box(24, 24, 6, 0, 0, -d / 2 + sd + 3);
  parts.push(...hubParts(f, 9, -d / 2, -d / 2 + sd + 0.2, collar));
  return parts;
}

// ---- valve actuators (origin at the coupling face, +Y up the stem) ------------------

/** SKD: foot ring, grey ribbed yoke, stem, die-cast rear body, the big blue housing box, knurled crown. */
function skd(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h } = rec.dims, back = rec.depth?.back ?? 64, front = rec.depth?.front ?? 105;
  const yoke = rec.yoke ?? 123, bodyW = 120, crownR = w / 2;
  const bodyTop = h - 38;
  const parts = [
    P(cylY(32.5, 30, 0, 16, 12), f.foot),
    P(box(16, yoke - 16, 22, -38, 16 + (yoke - 16) / 2, 0), f.yoke),
    P(box(16, yoke - 16, 22, 38, 16 + (yoke - 16) / 2, 0), f.yoke),
    P(box(92, 12, 26, 0, yoke - 6, 0), f.yoke),
    P(box(bodyW, bodyTop - yoke, back, 0, (yoke + bodyTop) / 2, -back / 2), f.body),
    P(rbox(bodyW, bodyTop - yoke - 8, front + 12, 10, 0, (yoke + bodyTop) / 2 - 2, front / 2 - 6, full), f.box),
    P(cylY(58, 58, bodyTop, bodyTop + 10, 16), f.box),
    P(cylY(crownR, crownR - 2, bodyTop + 10, h, 20), f.crown),
    P(cylY(5, 5, 8, 110, 8), f.stem, { anim: 'stem' }),
    P(box(22, 14, 14, 0, 62, 0), f.stem, { anim: 'stem' }),
  ];
  if (full) for (const sx of [-38, 38]) for (let i = 0; i < 4; i++) parts.push(P(box(18, 3, 24, sx, 36 + i * 20, 0), f.yoke, { full: true }));
  return parts;
}

/** SAX: open cast yoke, light head with the anthracite band, window ring and blue-grey knob on top. */
function sax(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h } = rec.dims, back = rec.depth?.back ?? 68, front = rec.depth?.front ?? 82;
  const dd = back + front, zc = (front - back) / 2;
  const headY = 108, bandH = 40;
  const parts = [
    P(cylY(40, 36, 0, 20, 12), f.yoke),
    P(box(16, 20, 18, 48, 10, 0), f.clamp),
    P(box(15, headY - 20, 18, -32, 20 + (headY - 20) / 2, 0), f.yoke),
    P(box(15, headY - 20, 18, 32, 20 + (headY - 20) / 2, 0), f.yoke),
    P(cylY(13, 13, 60, headY, 10), f.yoke),
    P(box(w, bandH, dd, 0, headY + bandH / 2, zc), f.band),
    P(rbox(w, h - headY - bandH - 12, dd, 8, 0, headY + bandH + (h - headY - bandH - 12) / 2, zc, full), f.head),
    P(cylY(30, 30, h - 12, h - 7, 16), f.ring),
    P(cylY(21, 21, h - 7, h, 12), f.knob),
    P(cylY(4.5, 4.5, 8, 70, 8), f.stem, { anim: 'stem' }),
  ];
  if (full) for (const sx of [-38, 0, 38]) parts.push(P(cylZ(9, 9, front - 5, front + 0.2 - 0.2, 10, sx, headY + bandH / 2), f.band, { full: true }));
  return parts;
}

/** SAS (Powermite MT) and SSB (Powermite MZ shoe): knurled nut, skirt, anthracite band, light top, window + knob. */
function sasBox(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims;
  const nut = rec.nut || { dia: 29.9, h: 21.8 };
  const front = rec.depth?.front ?? d / 2, back = rec.depth?.back ?? d / 2;
  const zc = (front - back) / 2;
  const parts = [P(cylY(nut.dia / 2, nut.dia / 2, 0, nut.h, 12), f.nut), P(cylY(2.5, 2.5, -10, 4, 6), f.stem, { anim: 'stem', ext: true })];
  if (rec.shoe) {
    const top = h - 6;
    parts.push(P(rbox(w, top - nut.h, d, 6, 0, (nut.h + top) / 2, zc, full), f.head));
    parts.push(P(cylY(20, 20, top, h, 14), f.knob));
    return parts;
  }
  const kH = 12, bodyTop = h - kH;
  const skirtH = 30, bandH = 30;
  parts.push(P(rbox(w, skirtH, d, 6, 0, nut.h + skirtH / 2, zc, full), f.skirt));
  parts.push(P(box(w, bandH, d, 0, nut.h + skirtH + bandH / 2, zc), f.band));
  parts.push(P(rbox(w, bodyTop - nut.h - skirtH - bandH, d, 8, 0, (nut.h + skirtH + bandH + bodyTop) / 2, zc, full), f.head));
  parts.push(P(cylY(14, 14, bodyTop, bodyTop + 5, 14), f.ring));
  parts.push(P(cylY(10, 10, bodyTop + 5, h, 12), f.knob));
  if (full) for (const sx of [-18, 18]) parts.push(P(cylZ(6, 6, front - 3, front, 10, sx, nut.h + skirtH + bandH / 2), f.band, { full: true }));
  return parts;
}

/** 599 zone-valve actuators (SSE / SSF / SFA / SFP): a rounded box on a 25 mm coupling (shape ≈). */
function zoneAct(rec, opts) {
  const full = opts.detail !== 'embed';
  const f = rec.finish, { w, h, d } = rec.dims, c = rec.coupling ?? 25;
  return [
    P(cylY(15, 15, 0, c, 12), f.coupling),
    P(rbox(w, h - c, d, 10, 0, c + (h - c) / 2, 0, full), f.body),
    P(cylY(2, 2, -6, 4, 6), f.stem, { anim: 'stem', ext: true }),
  ];
}

// ---- valve bodies (origin on the pipe centreline, +Y stem, +Z pipe) ------------------

/**
 * Globe body: a round belly, hex pipe ends, bonnet to the verified height, a
 * bottom port on 3-way bodies; reducers (ext) out to the line pipe.
 * size: { len, top, bot, bot3, od } mm; opts.lineR metres (line pipe radius).
 */
export function globeBody(size, ports, finish, opts) {
  const full = opts.detail !== 'embed';
  SEG = full ? 1 : 0.5;
  const seg = full ? 14 : 8;
  const od = size.od, half = size.len / 2;
  const belly = Math.max(od * 0.95, size.len * 0.26);
  const parts = [
    P(new THREE.SphereGeometry(belly, seg, full ? 10 : 4).scale(1, 0.9, 1.25), finish),
    P(cylZ(od * 0.62, od * 0.62, -half, -half + Math.max(10, od * 0.45), 6), finish),
    P(cylZ(od * 0.62, od * 0.62, half - Math.max(10, od * 0.45), half, 6), finish),
    P(cylY(od * 0.5, od * 0.42, belly * 0.6, size.top - Math.max(8, od * 0.25), seg), finish),
    P(cylY(od * 0.6, od * 0.6, size.top - Math.max(8, od * 0.25), size.top, 6), finish),
  ];
  if (ports === 3) {
    const b = size.bot3 ?? size.bot ?? od;
    parts.push(P(cylY(od * 0.5, od * 0.5, -b + Math.max(10, od * 0.4), -belly * 0.5, seg), finish));
    parts.push(P(cylY(od * 0.62, od * 0.62, -b, -b + Math.max(10, od * 0.4), 6), finish));
  } else if (size.bot) {
    parts.push(P(cylY(od * 0.36, od * 0.4, -size.bot, -belly * 0.6, seg), finish));
  }
  const lineR = opts.lineR ? opts.lineR * 1000 : null;
  if (lineR && Math.abs(lineR - od / 2) > 0.5) {
    const red = clamp(od * 0.6, 14, 40);
    parts.push(P(cylZ(od * 0.55, lineR, half, half + red, seg), finish, { ext: true }));
    parts.push(P(cylZ(lineR, od * 0.55, -half - red, -half, seg), finish, { ext: true }));
  }
  SEG = 1;
  return parts;
}

/** Room for the reducers beyond each body end, mm. */
export function reducerLen(size, lineR) {
  if (!lineR || Math.abs(lineR * 1000 - size.od / 2) <= 0.5) return 0;
  return clamp(size.od * 0.6, 14, 40);
}

function mergeInto(a, b) {
  // two tube segments → one geometry (only used for tiny ext tubes)
  const pos = [...a.toNonIndexed().attributes.position.array, ...b.toNonIndexed().attributes.position.array];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Archetype name → builder. */
const withSeg = (fn) => (rec, opts = {}) => { SEG = opts.detail === 'embed' ? 0.5 : 1; try { return fn(rec, opts); } finally { SEG = 1; } };
export const ARCHETYPES = Object.freeze(Object.fromEntries(Object.entries({
  symaro, qbm, setra264, qvm62, powersBox, qmx3, plainBox, ctrlBox, ctrlActuating,
  oaXL, oaTall, oaCompact, oaMini, skd, sax, sasBox, zoneAct,
}).map(([k, fn]) => [k, withSeg(fn)])));

/**
 * The averaging element (QAM2120.200 / .600) or a capillary (134-1504): a
 * serpentine of `lenMm` across a span { w, h } (metres) in the X–Y plane,
 * centred. passes = clamp(ceil(len / span.w), 2, 8), segment = len / passes,
 * so the horizontal runs add up to the element length. Clips every other pass.
 * Returns { tube: BufferGeometry[], clips: BufferGeometry[] } in METRES.
 */
export function serpentine(lenMm, span, rMm = 3, clips = true) {
  const len = lenMm / 1000, r = rMm / 1000;
  const passes = clamp(Math.ceil(len / Math.max(0.05, span.w)), 2, 8);
  const seg = Math.min(len / passes, span.w);
  const pts = [];
  const pitch = span.h / passes, br = pitch / 2;
  for (let i = 0; i < passes; i++) {
    const y = span.h / 2 - (span.h * (i + 0.5)) / passes;
    const a = i % 2 ? seg / 2 : -seg / 2, b = -a;
    pts.push([a, y, 0], [b, y, 0]);
    if (i < passes - 1) {
      // a U-bend down to the next pass, centred beyond the pass end
      const dir = Math.sign(b) || 1;
      for (let k = 1; k < 8; k++) { const t = (k / 8) * Math.PI; pts.push([b + dir * br * Math.sin(t) * 0.9, y - br + br * Math.cos(t), 0]); }
    }
  }
  const tube = [];
  for (let i = 1; i < pts.length; i++) tube.push(...tubeGeo([pts[i - 1], pts[i]], r, 5));
  const cl = [];
  if (clips) for (let i = 0; i < passes; i += 2) for (const x of [-seg / 2, seg / 2]) cl.push(new THREE.BoxGeometry(0.014, 0.02, 0.012).translate(x * 0.96, span.h / 2 - (span.h * (i + 0.5)) / passes, 0));
  return { tube, clips: cl, start: pts[0], passes, seg };
}
