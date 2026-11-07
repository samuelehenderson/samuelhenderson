/**
 * siemens3d.js — build Siemens field devices as three.js objects.
 *
 *   siemensMaterials()        fresh sie_* materials (one per FINISH token) + sie_vc
 *   buildDevice(part, opts)   → { group, hub?, stem?, stroke, stem0, lcd?, spec } | null
 *   mountDevice(parent, dev, { pos, normal, up })
 *   drawQmx3Lcd(lcd, fields, lit)
 *   disposeDeviceCache()
 *
 * Geometry comes from siemens-shapes.js (millimetres), is merged per material
 * (full detail) or into one vertex-coloured mesh plus the moving part (embed
 * detail), scaled to metres and cached per part | detail | variant | finish.
 * Cached geometry is flagged userData.shared = true; only disposeDeviceCache()
 * frees it (both top-level destroy()s call it). Materials are physical colours
 * (userData.physical), never themed, and never show a value or a status.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FINISH } from '../../shared/siemens/catalog.js';
import { lookup, lookupValve, valveLabel } from '../../shared/siemens/parts.js';
import { ARCHETYPES, globeBody, reducerLen, serpentine, tubeGeo } from './siemens-shapes.js';

const cache = new Map();          // key → { meshes: [{ geo, finish, anim }] }
let fallbackMats = null;

/** Fresh sie_* materials, one per finish token, plus sie_vc (vertex colours, embed detail). */
export function siemensMaterials() {
  const m = {};
  for (const [k, f] of Object.entries(FINISH)) {
    const mat = f.basic
      ? new THREE.MeshBasicMaterial({ color: f.color, toneMapped: k !== 'lcdLit' })
      : new THREE.MeshStandardMaterial({
        color: f.color, roughness: f.rough ?? 0.5, metalness: f.metal ?? 0,
        transparent: f.opacity != null, opacity: f.opacity ?? 1, depthWrite: f.opacity == null,
        // lit like the cabinet (its panels use 0.35): a white plastic must not bloom as if it were lit
        envMapIntensity: 0.32,
      });
    mat.name = `sie_${k}`;
    mat.userData.physical = true;
    m[mat.name] = mat;
  }
  const vc = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.55, envMapIntensity: 0.45 });
  vc.name = 'sie_vc';
  vc.userData.physical = true;
  m.sie_vc = vc;
  return m;
}

function materialsOf(m) {
  if (m && m.sie_vc) return m;
  fallbackMats ||= siemensMaterials();
  return fallbackMats;
}

// ---- geometry: prepare, merge, cache -----------------------------------------------

const _c = new THREE.Color();
function prep(g, colorHex, keepUv = false) {
  let n = g.index ? g.toNonIndexed() : g;
  if (n !== g) g.dispose();
  for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && !(keepUv && k === 'uv')) n.deleteAttribute(k);
  if (!n.attributes.normal) n.computeVertexNormals();
  n.clearGroups();
  if (colorHex) {
    _c.set(colorHex);
    const cnt = n.attributes.position.count, arr = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) { arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b; }
    n.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  return n;
}

function merge(list) {
  const g = list.length === 1 ? list[0] : mergeGeometries(list, false);
  if (list.length > 1) for (const x of list) x.dispose();
  g.scale(0.001, 0.001, 0.001);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  g.userData.shared = true;
  return g;
}

/**
 * Parts → cached meshes. Embed: every non-moving part merged into one mesh in
 * sie_vc (per-part colours baked into vertex colours), plus one mesh per moving
 * part; full-detail-only parts and long external parts (probes, tubes) dropped.
 * Full: one mesh per (moving part, finish).
 */
function assemble(parts, detail) {
  const embed = detail === 'embed';
  const keep = parts.filter((p) => (embed ? !p.full && (!p.ext || p.embed || p.anim) : !p.embed));
  const groups = new Map();
  for (const p of keep) {
    const fin = embed && p.anim !== 'display' ? 'vc' : p.finish;
    const key = `${p.anim || 'static'}|${fin}`;
    if (!groups.has(key)) groups.set(key, { finish: fin, anim: p.anim || null, geos: [] });
    // the display keeps its UVs: the QMX3 face is a texture
    groups.get(key).geos.push(prep(p.geo, fin === 'vc' ? (FINISH[p.finish]?.color || '#cbd0cc') : null, p.anim === 'display'));
  }
  return { meshes: [...groups.values()].map((g) => ({ geo: merge(g.geos), finish: g.finish, anim: g.anim })) };
}

/** Record or valve package → its parts (mm) at a detail. */
function partsFor(spec, opts) {
  if (spec.kind === 'valve') {
    const { vm, body, size, actuator } = spec;
    const fin = vm.body === 'bronze' || size.body === 'bronze' ? 'bronze' : vm.body === 'brass' ? 'brass' : body.finish;
    const parts = globeBody(size, vm.ports === 3 ? 3 : 2, fin, opts);
    if (actuator && ARCHETYPES[actuator.shape]) {
      const foot = actuator.clTop ? actuator.clTop - actuator.dims.h : size.top;
      for (const p of ARCHETYPES[actuator.shape](actuator, opts)) { p.geo.translate(0, foot, 0); parts.push(p); }
    }
    return parts;
  }
  const fn = ARCHETYPES[spec.shape] || ARCHETYPES.plainBox;
  return fn(spec, opts);
}

/** Resolve a part (order code, record or valveModel object) to a spec. */
export function specOf(part) {
  if (!part) return null;
  if (typeof part === 'object' && !part.id && (part.series || part.family)) {
    const v = lookupValve(part);
    if (!v) return null;
    return { kind: 'valve', id: valveLabel(part), vm: part, body: v.body, size: v.size, sizeKey: v.sizeKey, actuator: v.actuator, stroke: v.actuator?.stroke ?? v.body.stroke, linear: true, actuating: false };
  }
  return typeof part === 'string' ? lookup(part) : part;
}

function cacheKey(spec, detail, opts) {
  if (spec.kind === 'valve') {
    const r = opts.lineR ? Math.round(opts.lineR * 1000) : 0;
    return `valve:${spec.vm.series}:${spec.sizeKey}:${spec.vm.ports}:${spec.vm.body || ''}|${detail}|r${r}|${spec.actuator?.id || '-'}`;
  }
  const fin = spec.shape === 'qmx3' ? `${opts.color === 'black' ? 'black' : 'white'}${opts.logo === false ? '' : '+logo'}` : 'std';
  return `${spec.id}|${detail}|-|${fin}`;
}

/** The parts of a device at a detail (mm; for checks: envelope, budgets). */
export function devicePartsOf(part, opts = {}) {
  const spec = specOf(part);
  return spec ? partsFor(spec, { detail: 'full', ...opts }) : [];
}

/** The catalogue envelope a device draws (mm, parts marked ext excluded). */
export function envelopeOf(part, opts = {}) {
  const box = new THREE.Box3();
  const detail = opts.detail || 'full';
  for (const p of devicePartsOf(part, opts)) {
    if (p.ext || (detail === 'embed' ? p.full : p.embed)) continue;
    p.geo.computeBoundingBox();
    box.union(p.geo.boundingBox);
    p.geo.dispose();
  }
  return box;
}

// ---- build + mount -----------------------------------------------------------------

/**
 * Build a device. opts: { m, detail: 'full' | 'embed', lineR (m), color, logo }.
 * → { group, hub, stem, stroke (m), stem0, lcd, spec, axis } | null
 * group.userData.axis: 'z' (sensors, controllers, rotary actuators) or 'y' (valves).
 */
export function buildDevice(part, opts = {}) {
  const spec = specOf(part);
  if (!spec) return null;
  const detail = opts.detail === 'embed' ? 'embed' : 'full';
  const mats = materialsOf(opts.m);
  const key = cacheKey(spec, detail, opts);
  let entry = cache.get(key);
  if (!entry) {
    entry = assemble(partsFor(spec, { ...opts, detail }), detail);
    cache.set(key, entry);
  }
  const group = new THREE.Group();
  group.name = `sie:${spec.id}`;
  const linear = spec.kind === 'valve' || spec.linear;
  group.userData.axis = linear ? 'y' : 'z';
  let hub = null, stem = null, lcd = null;
  for (const e of entry.meshes) {
    let mat;
    if (e.anim === 'display') {
      lcd = makeLcd(mats, opts);
      mat = lcd.mat;
    } else mat = e.finish === 'vc' ? mats.sie_vc : (mats[`sie_${e.finish}`] || mats.sie_ral7035);
    const mesh = new THREE.Mesh(e.geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    if (e.anim === 'hub') { hub ||= new THREE.Group(); hub.add(mesh); }
    else if (e.anim === 'stem') { stem ||= new THREE.Group(); stem.add(mesh); }
    else group.add(mesh);
    if (e.anim === 'display') lcd.mesh = mesh;
  }
  if (hub) { hub.name = 'hub'; group.add(hub); }
  if (stem) { stem.name = 'stem'; group.add(stem); }
  for (const o of group.children) {
    if (o === stem) continue;
    o.updateMatrix();
    o.matrixAutoUpdate = false;
    for (const c of o.children || []) { c.updateMatrix(); c.matrixAutoUpdate = false; }
  }
  const stroke = (spec.stroke ?? spec.actuator?.stroke ?? 0) / 1000;
  return { group, hub, stem, stroke, stem0: 0, lcd, spec, axis: group.userData.axis };
}

const _n = new THREE.Vector3(), _u = new THREE.Vector3(), _x = new THREE.Vector3(), _m4 = new THREE.Matrix4();

/**
 * Place a built device: its primary axis (+Z, or +Y for valves) along `normal`,
 * its secondary axis (+Y, or +Z for valves) toward `up`. pose in parent's frame, metres.
 */
export function mountDevice(parent, dev, { pos = [0, 0, 0], normal = [0, 0, 1], up = [0, 1, 0] } = {}) {
  const g = dev.group || dev;
  _n.set(...normal).normalize();
  _u.set(...up);
  _u.addScaledVector(_n, -_u.dot(_n));
  if (_u.lengthSq() < 1e-8) {                // up along the normal: any perpendicular will do
    if (Math.abs(_n.y) < 0.9) _u.set(0, 1, 0); else _u.set(1, 0, 0);
    _u.addScaledVector(_n, -_u.dot(_n));
  }
  _u.normalize();
  if (g.userData.axis === 'y') {
    _x.crossVectors(_n, _u);               // X = Y × Z with Y = normal, Z = up
    _m4.makeBasis(_x, _n, _u);
  } else {
    _x.crossVectors(_u, _n);               // X = Y × Z with Y = up, Z = normal
    _m4.makeBasis(_x, _u, _n);
  }
  g.quaternion.setFromRotationMatrix(_m4);
  g.position.set(...pos);
  parent.add(g);
  g.updateMatrix();
  return g;
}

// ---- external runs (per view, not cached): tubes, averaging elements, capillaries ----

/** Merge metre-space geometries into one mesh, flagged ext + noFootprint. Per-view: freed with the unit. */
export function extMesh(geos, mat) {
  const list = geos.map((g) => prep(g, null));
  const g = list.length === 1 ? list[0] : mergeGeometries(list, false);
  if (list.length > 1) for (const x of list) x.dispose();
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = false;
  mesh.userData.ext = true;
  mesh.userData.noFootprint = true;
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** A tube (metres) through [x, y, z] points. */
export function tubeMesh(points, r, mat) {
  return extMesh(tubeGeo(points.map((p) => p.map((v) => v * 1000)), r * 1000, 6).map((g) => g.scale(0.001, 0.001, 0.001)), mat);
}

/** An averaging element / capillary serpentine across `span` (metres) in its local X–Y plane. */
export function serpentineMesh(lenMm, span, rMm, mat, clipMat) {
  const s = serpentine(lenMm, span, rMm, !!clipMat);
  const g = new THREE.Group();
  g.add(extMesh(s.tube, mat));
  if (clipMat && s.clips.length) g.add(extMesh(s.clips, clipMat));
  g.userData.start = s.start;
  g.userData.noFootprint = true;
  return g;
}

// ---- QMX3 face ------------------------------------------------------------------------
//
// The whole front of the room unit is one canvas (the user's QMX3.P34 white
// photo): the SIEMENS wordmark, the Green Leaf, the LCD window with its two °F
// lines and icon row, and the soft key marks down each side. The face is white
// (black only when a unit is set to black); the shell's grey sides are the
// thin bezel. Honesty: the backlight — and the Green Leaf — light only while
// ZNT reads live (never during playback); unlit, the window is a dim grey-green.

const PX = 5;                                        // canvas pixels per mm
const FACE_W = 86.4, FACE_H = 131.4;                 // the face plane (1 mm inside the 88.4 × 133.4 shell)
const LCD_W = Math.round(FACE_W * PX), LCD_H = Math.round(FACE_H * PX);
const WIN = { w: 53 * PX, h: 50.8 * PX, cx: LCD_W / 2, cy: LCD_H / 2 - 30.4 * PX };   // CM2N1602 window, centre +30.4 mm

function makeLcd(mats, opts = {}) {
  let canvas = null, ctx = null;
  try {
    canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (canvas) { canvas.width = LCD_W; canvas.height = LCD_H; ctx = canvas.getContext('2d'); }
  } catch { ctx = null; }
  let tex = null, mat;
  if (ctx) {
    tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    mat = new THREE.MeshBasicMaterial({ color: '#ffffff', map: tex, toneMapped: false });
  } else {
    mat = new THREE.MeshBasicMaterial({ color: FINISH.lcdOff.color });
  }
  mat.name = 'sie_lcd';
  mat.userData.physical = true;
  const lcd = { canvas, ctx, tex, mat, key: '', fields: null, lit: false, face: { black: opts.color === 'black', logo: opts.logo !== false } };
  drawQmx3Lcd(lcd, { a: '--.-', b: '--.-', mode: null, caps: ['T'], occ: false }, false);
  return lcd;
}

/**
 * Paint the QMX3 face (CM2N1602 p.12 layout, the user's photo): row A the room
 * temperature (ZNT), row B the setpoint in large digits with ◀ ▶, then the
 * icon row (thermometer, drop for RH, CO₂, the operating-mode glyph) and
 * presence. Redraws only when a rendered string changes. Glyph art is
 * UNVERIFIED (plain pictograms, not Siemens' icons).
 */
export function drawQmx3Lcd(lcd, fields, lit) {
  if (!lcd) return false;
  const key = `${lit ? 1 : 0}|${fields.a}|${fields.b}|${fields.mode || ''}|${(fields.caps || []).join(',')}|${fields.occ ? 1 : 0}`;
  lcd.fields = { ...fields };
  lcd.lit = !!lit;
  if (key === lcd.key) return false;
  lcd.key = key;
  const g = lcd.ctx;
  if (!g) {
    lcd.mat.color.set(lit ? FINISH.lcdLit.color : FINISH.lcdOff.color);
    return true;
  }
  const W = LCD_W, H = LCD_H, face = lcd.face || {};
  const black = !!face.black;
  // bezel grey in the corners, the face as a rounded plate
  g.fillStyle = FINISH.qmxSide.color;
  g.fillRect(0, 0, W, H);
  g.fillStyle = black ? '#141517' : '#F3F4F2';
  rr(g, 0, 0, W, H, 3 * PX);
  g.fill();
  // SIEMENS wordmark above the window
  if (face.logo !== false) {
    g.fillStyle = black ? '#E8ECEC' : '#3F7F8C';
    g.font = `700 ${Math.round(4.1 * PX)}px "Manrope", "Arial", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    spaced(g, 'SIEMENS', W / 2, (WIN.cy - WIN.h / 2) / 2 + 2, 1.4);
  }
  // Green Leaf, top right: green only while the display is lit (live)
  leaf(g, W / 2 + 35.3 * PX, H / 2 - 55.2 * PX, 2.6 * PX, lit ? '#62B23A' : (black ? '#56605A' : '#B9C3B6'));
  // soft key marks, four each side
  g.strokeStyle = black ? '#3A3F43' : '#DADDDA';
  g.lineWidth = 0.35 * PX;
  for (const sx of [-1, 1]) for (const y of [49.5, 36.8, 24.1, 11.4]) {
    const cx = W / 2 + sx * 34.7 * PX, cy = H / 2 - y * PX;
    for (const dy of [-0.55, 0.55]) { g.beginPath(); g.moveTo(cx - 3.1 * PX, cy + dy * PX); g.lineTo(cx + 3.1 * PX, cy + dy * PX); g.stroke(); }
  }
  // the LCD window
  const x0 = WIN.cx - WIN.w / 2, y0 = WIN.cy - WIN.h / 2, ww = WIN.w, hh = WIN.h;
  g.fillStyle = black ? '#050606' : '#C9CDCB';
  g.fillRect(x0 - 3, y0 - 3, ww + 6, hh + 6);
  g.fillStyle = lit ? FINISH.lcdLit.color : '#7D8784';
  g.fillRect(x0, y0, ww, hh);
  const ink = lit ? FINISH.lcdSeg.color : '#3E4745';
  const faint = lit ? 'rgba(17,19,21,0.3)' : 'rgba(40,48,46,0.45)';
  g.fillStyle = ink;
  g.strokeStyle = ink;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const u = ww / 256;                                 // layout unit: the window is 256 u wide
  // top-left: room-temperature icon (a framed thermometer)
  g.lineWidth = 3 * u;
  g.strokeRect(x0 + 10 * u, y0 + 10 * u, 22 * u, 26 * u);
  thermo(g, x0 + 21 * u, y0 + 27 * u, u * 0.55);
  // row A: room temperature, °F
  g.textBaseline = 'alphabetic';
  g.textAlign = 'right';
  g.font = `700 ${Math.round(46 * u)}px "JetBrains Mono", monospace`;
  g.fillText(fields.a, x0 + ww - 46 * u, y0 + 56 * u);
  g.textAlign = 'left';
  g.font = `700 ${Math.round(15 * u)}px "JetBrains Mono", monospace`;
  g.fillText('°F', x0 + ww - 42 * u, y0 + 30 * u);
  g.lineWidth = 2.4 * u;
  line(g, x0 + 8 * u, y0 + 70 * u, x0 + ww - 8 * u, y0 + 70 * u);
  // row B: setpoint, large, with ◀ ▶
  g.textAlign = 'right';
  g.font = `700 ${Math.round(72 * u)}px "JetBrains Mono", monospace`;
  g.fillText(fields.b, x0 + ww - 40 * u, y0 + 146 * u);
  g.textAlign = 'left';
  g.font = `700 ${Math.round(15 * u)}px "JetBrains Mono", monospace`;
  g.fillText('°F', x0 + ww - 36 * u, y0 + 100 * u);
  tri(g, x0 + 8 * u, y0 + 118 * u, -1, 6 * u, faint);
  tri(g, x0 + ww - 8 * u, y0 + 118 * u, 1, 6 * u, faint);
  g.fillStyle = ink;
  g.lineWidth = 2.4 * u;
  line(g, x0 + 8 * u, y0 + 186 * u, x0 + ww - 8 * u, y0 + 186 * u);
  // icon row: drop (RH), thermometer (selected), CO₂, the operating-mode glyph; presence on the right
  const caps = fields.caps || ['T'];
  const iy = y0 + 218 * u;
  let x = x0 + 58 * u;
  if (caps.includes('RH')) { drop(g, x - 8 * u, iy, u * 0.55); drop(g, x + 4 * u, iy - 5 * u, u * 0.55); x += 30 * u; }
  thermo(g, x, iy, u * 0.8);
  g.fillRect(x - 12 * u, iy + 16 * u, 24 * u, 3 * u);
  x += 32 * u;
  if (caps.includes('CO2')) { g.font = `700 ${Math.round(17 * u)}px "JetBrains Mono", monospace`; g.textAlign = 'left'; g.fillText('CO₂', x - 12 * u, iy + 7 * u); x += 40 * u; }
  g.lineWidth = 2.6 * u;
  modeGlyph(g, fields.mode, x + 4 * u, iy - 2 * u, u * 0.62);
  if (fields.occ) person(g, x0 + ww - 34 * u, iy, u * 0.7);
  tri(g, x0 + 8 * u, iy, -1, 6 * u, faint);
  tri(g, x0 + ww - 8 * u, iy, 1, 6 * u, faint);
  if (lcd.tex) lcd.tex.needsUpdate = true;
  return true;
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}
function spaced(g, text, cx, cy, gapPx) {
  const ws = [...text].map((ch) => g.measureText(ch).width);
  const total = ws.reduce((a, b) => a + b, 0) + gapPx * (text.length - 1);
  let x = cx - total / 2;
  g.textAlign = 'left';
  [...text].forEach((ch, i) => { g.fillText(ch, x, cy); x += ws[i] + gapPx; });
}
function line(g, x0, y0, x1, y1) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
function tri(g, x, y, dir, s, col) { const f = g.fillStyle; g.fillStyle = col; g.beginPath(); g.moveTo(x + dir * s, y); g.lineTo(x - dir * s * 0.2, y - s); g.lineTo(x - dir * s * 0.2, y + s); g.closePath(); g.fill(); g.fillStyle = f; }
function leaf(g, x, y, s, col) {
  g.save();
  g.strokeStyle = col; g.lineWidth = s * 0.28; g.lineCap = 'round';
  g.beginPath();
  g.moveTo(x - s, y + s);
  g.quadraticCurveTo(x - s * 1.1, y - s * 0.9, x + s, y - s);
  g.quadraticCurveTo(x + s * 0.9, y + s * 1.05, x - s, y + s);
  g.stroke();
  g.beginPath(); g.moveTo(x - s * 1.25, y + s * 1.25); g.lineTo(x + s * 0.35, y - s * 0.35); g.stroke();
  g.restore();
}
function modeGlyph(g, mode, x, y, k = 1) {
  g.beginPath();
  if (mode === 'comfort' || !mode) { g.arc(x, y, 9 * k * 1.3, 0, Math.PI * 2); for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4; g.moveTo(x + Math.cos(a) * 16 * k, y + Math.sin(a) * 16 * k); g.lineTo(x + Math.cos(a) * 23 * k, y + Math.sin(a) * 23 * k); } }
  else if (mode === 'standby') { g.arc(x, y, 16 * k, 0, Math.PI * 2); g.moveTo(x, y - 16 * k); g.lineTo(x, y); g.lineTo(x + 10 * k, y + 6 * k); }
  else if (mode === 'economy') { g.arc(x, y, 16 * k, Math.PI * 0.35, Math.PI * 1.65); g.arc(x + 9 * k, y, 12 * k, Math.PI * 1.45, Math.PI * 0.55, true); }
  else if (mode === 'protection') { g.moveTo(x, y - 20 * k); g.lineTo(x + 16 * k, y - 12 * k); g.lineTo(x + 14 * k, y + 6 * k); g.lineTo(x, y + 20 * k); g.lineTo(x - 14 * k, y + 6 * k); g.lineTo(x - 16 * k, y - 12 * k); g.closePath(); }
  else if (mode === 'heat') { g.moveTo(x - 8 * k, y + 16 * k); g.quadraticCurveTo(x - 18 * k, y - 2 * k, x, y - 20 * k); g.quadraticCurveTo(x + 18 * k, y - 2 * k, x + 8 * k, y + 16 * k); g.closePath(); }
  else if (mode === 'cool') { for (let i = 0; i < 3; i++) { const a = (i * Math.PI) / 3; g.moveTo(x - Math.cos(a) * 20 * k, y - Math.sin(a) * 20 * k); g.lineTo(x + Math.cos(a) * 20 * k, y + Math.sin(a) * 20 * k); } }
  if (mode) g.stroke();
  else { const a = g.globalAlpha; g.globalAlpha = 0.25; g.stroke(); g.globalAlpha = a; }
}
function thermo(g, x, y, k = 1) { const lw = g.lineWidth; g.lineWidth = 5 * k; g.beginPath(); g.moveTo(x, y - 22 * k); g.lineTo(x, y); g.stroke(); g.beginPath(); g.arc(x, y + 4 * k, 7 * k, 0, Math.PI * 2); g.fill(); g.lineWidth = lw; }
function drop(g, x, y, k = 1) { g.beginPath(); g.moveTo(x, y - 18 * k); g.quadraticCurveTo(x + 12 * k, y, x, y + 8 * k); g.quadraticCurveTo(x - 12 * k, y, x, y - 18 * k); g.fill(); }
function person(g, x, y, k = 1) {
  const lw = g.lineWidth; g.lineWidth = 3 * k;
  g.strokeRect(x - 16 * k, y - 22 * k, 32 * k, 40 * k);
  g.beginPath(); g.arc(x, y - 11 * k, 5 * k, 0, Math.PI * 2); g.fill();
  g.fillRect(x - 6 * k, y - 4 * k, 12 * k, 20 * k);
  g.lineWidth = lw;
}

// ---- disposal ----------------------------------------------------------------------------

/** Free every cached geometry (the top-level destroy()s call this; embedded views never do). */
export function disposeDeviceCache() {
  for (const e of cache.values()) for (const m of e.meshes) m.geo.dispose();
  cache.clear();
}

/** How many cached device geometries exist (checks). */
export function deviceCacheSize() { return cache.size; }

export { reducerLen };
