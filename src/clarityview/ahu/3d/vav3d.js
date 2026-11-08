/**
 * vav3d.js — every VAV / air terminal in 3D at true size (vav-spec §8.4).
 *
 *   export const Vav3DView = vavViewClass(Terminal3DView, { finish, realFans })   (equip3d.js)
 *
 * A factory, so this module never imports equip3d.js (no cycle). The view is
 * built from vavLayout() — the same pure layout the 2D drawing and the plan
 * footprint use — so the box is centred on its placement, hangs at
 * mount.ceiling + mount.gap, and every part sits where the geometry set says.
 *
 * Honesty: nothing moves without live data. The blade (and a SIEMENS hub
 * parented to it) turns only on a live position; the blower only on a live
 * proof; heater stages glow only while their command reads live ON; the air
 * stream runs only on a live airflow ≥ the sensor's measurable minimum or a
 * live fan proof (vav-live.js, inherited _flowTarget / isRunning).
 *
 * Siemens devices come from the SIEMENS library through this._device(g, sfx,
 * role, pose, caption) (integration plan §3.2); when it is absent or returns
 * null a neutral placeholder of catalogue size is drawn instead. Enclosures,
 * panels, piping, stubs, probes and devices carry userData.noFootprint.
 */

import * as THREE from 'three';
import { vavLayout } from '../vav/vav-layout.js';
import { terminalOf } from '../vav/vav-config.js';
import { VAV_TYPES } from '../vav/vav-types.js';
import { flowSuffix } from '../vav/vav-live.js';
import { controllerPart, isActuatingPart, placeholderMm, DEFAULT_VALVE_ACTUATOR, defaultDamperActuator } from '../vav/vav-parts.js';
import { IN, vavMaterials, noFootprint, boxGeo, cylGeo, endFaceGeo, mergeStatic, placeholder, orient, blower } from './vav-parts3d.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const fin = Number.isFinite;
const SHEET = 0.0008;

/** Polyline → a CurvePath with each corner bent to radius r (shrunk where the legs are short). */
function rounded(pts, r) {
  const path = new THREE.CurvePath();
  let cur = pts[0].clone();
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (i === pts.length - 1) { if (cur.distanceTo(p) > 1e-5) path.add(new THREE.LineCurve3(cur, p.clone())); break; }
    const a = p.clone().sub(pts[i - 1]), b = pts[i + 1].clone().sub(p);
    const la = a.length(), lb = b.length();
    if (la < 1e-5 || lb < 1e-5) continue;
    const rr = Math.min(r, la * 0.45, lb * 0.45);
    const A = p.clone().addScaledVector(a.normalize(), -rr), B = p.clone().addScaledVector(b.normalize(), rr);
    if (cur.distanceTo(A) > 1e-5) path.add(new THREE.LineCurve3(cur, A));
    path.add(new THREE.QuadraticBezierCurve3(A, p.clone(), B));
    cur = B;
  }
  return path;
}

const CAPS = { inlet: 'AIR VALVE', casing: 'CASING', attenuator: 'ATTENUATOR', coil: 'REHEAT COIL', heater: 'ELECTRIC HEAT', outlet: 'DISCHARGE' };

/**
 * @param {typeof import('./equip3d.js').Terminal3DView} Base
 * @param {{ finish: Function, realFans: Function }} helpers
 */
export function vavViewClass(Base, { finish, realFans }) {
  return class Vav3DView extends Base {
    constructor(opts) {
      super({ ...opts, kind: 'vav' });
      const t = terminalOf(opts.config) || terminalOf({ kind: 'vav' });
      this.term = t;
      this.lay = vavLayout(t);
      this.vavDims = this.lay.dims;
      const L = this.lay, T = VAV_TYPES[t.type];
      this.DH = L.H * IN;
      this.D = L.W * IN;
      this.eyebrow = T.eyebrow;
      const zone = T.zone && (opts.config?.supply || []).some((x) => x.device === 'zone');
      const phone = typeof matchMedia === 'function' && !!matchMedia('(max-width: 767px)').matches;
      this.presets = [['overview', 'Overview'], ['unit', 'Box'], ...(phone ? [] : [['controls', 'Controls']]), ...(zone ? [['zone', 'Room']] : [])];
      this.hasZone = zone;
      this.roomH = t.mount.ceiling + t.mount.gap;
      this.roomD = Math.max(2.4, (L.bbox.z1 - L.bbox.z0) * IN + 1.8);
      this.devicePoses = 'self';
      this.hasLayoutOptions = false;
      this.hasCasing = true;           // More → Casing: Clear | Grey, like the air handler
      this.vp = { heaters: [], backdraft: null, blades: [] };
      const inlet = (opts.config?.supply || []).find((x) => x.device === 'vavinlet') || null;
      const coil = (opts.config?.supply || []).find((x) => x.device === 'coil' && x.variant !== 'cool') || null;
      // SIEMENS asks which part a slot carries: the terminal's own choice first
      this.devOf = (sfx, role) => {
        if (role === 'term.controller') return this.term.controller.model ?? null;
        if (role === 'term.valve') return coil?.valveModel ?? null;
        if (role === 'term.damper') return inlet?.actuator ?? null;
        return null;
      };
    }

    get _devicesOff() { return this.config?.fieldDevices?.show === false; }

    _buildUnit() {
      const has = this.has, L = this.lay, t = this.term, d = L.dims;
      const V = vavMaterials(this.m);
      const full = !this.embedded;
      this.vp = { heaters: [], backdraft: null, blades: [] };
      this.inv = { oad: null, rad: null, ead: null, fans: realFans(has, ['SF1']), rfs: [], efs: [], hasRet: false, hasFilter: false, mat: null, cc: null, ph: null, rh: null, fAlm: null, fDp: null };
      const unit = this._newUnit();
      const pick = (cands) => cands.find((s) => s && has(s)) || null;
      const flowS = flowSuffix(has);
      const dmpS = pick(['VAV.DMP.POS', 'VAV.DMP', 'CD.DMP.POS', 'CD.DMP', 'EX.DMP.POS', 'EX.DMP']);
      const dmpCmd = pick(['VAV.DMP', 'CD.DMP', 'EX.DMP']);
      this.vavSfx = { flow: flowS, dmp: dmpS, dmpCmd };

      // ---- sections along x (explode moves each as a unit) ----
      const secs = L.sections.map((s, i) => {
        const w = Math.max((s.x1 - s.x0) * IN, 0.001);
        const baseX = ((s.x0 + s.x1) / 2) * IN;
        const group = new THREE.Group();
        group.position.x = baseX;
        unit.add(group);
        return { kind: s.kind, x0: s.x0, x1: s.x1, w, baseX, i, ex: i * 0.3, group, cap: s.kind === 'inlet' && !L.shafts.length ? 'INLET' : CAPS[s.kind] || s.kind.toUpperCase(), open: new Set() };
      });
      this.sections = secs;
      this.exMid = 0.3 * (secs.length - 1) / 2;
      const secOf = (kind) => secs.find((s) => s.kind === kind) || secs.find((s) => s.kind === 'casing');
      const lx = (s, xin) => xin * IN - s.baseX;
      const nf = new Map();                        // section → its noFootprint subgroup
      const nfOf = (s) => { if (!nf.has(s)) { const g = noFootprint(new THREE.Group()); g.name = 'vav-nf'; s.group.add(g); nf.set(s, g); } return nf.get(s); };
      // static geometry buckets: one merged mesh per (section, material, footprint)
      const buckets = new Map();
      const geo = (s, mat, g, footprint = true, picked = null) => {
        const key = `${s.kind}|${mat.uuid}|${footprint ? 1 : 0}|${picked || ''}`;
        if (!buckets.has(key)) buckets.set(key, { s, mat, footprint, geos: [], picked });
        buckets.get(key).geos.push(g);
      };
      const PICK = {};
      // the crisp dark outline (one LineSegments per section, like the air handler's casing)
      const lines = new Map();
      const lineOf = (s) => { if (!lines.has(s)) lines.set(s, []); return lines.get(s); };
      const boxLines = (s, x0, x1, y0, y1, z0, z1) => {
        const L2 = lineOf(s);
        const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
        for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) L2.push(...c[a], ...c[b]);
      };
      const ringLines = (s, x, yc, zc, r, n = 32) => {
        const L2 = lineOf(s);
        for (let k = 0; k < n; k++) {
          const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
          L2.push(x, yc + Math.cos(a0) * r, zc + Math.sin(a0) * r, x, yc + Math.cos(a1) * r, zc + Math.sin(a1) * r);
        }
      };

      // ---- inlets: collar, flow cross, valve body, blade on its shaft ----
      const inletSec = secOf('inlet');
      PICK.inlet = { title: t.type === 'exhaust' ? 'Exhaust air valve' : 'Primary air valve', points: [dmpCmd, dmpS, flowS, pick(['VAV.FLOW.SP', 'CD.FLOW.SP', 'EX.FLOW.SP'])].filter(Boolean) };
      for (const p of L.parts) {
        const s = secOf(p.sec);
        const xc = lx(s, (p.x0 + p.x1) / 2), yc = ((p.y0 + p.y1) / 2) * IN, zc = ((p.z0 + p.z1) / 2) * IN;
        const sx = (p.x1 - p.x0) * IN, sy = (p.y1 - p.y0) * IN, sz = (p.z1 - p.z0) * IN;
        if (p.kind === 'collar') {
          if (p.cyl) {
            if (full) for (const xe of [xc - sx / 2, xc + sx / 2]) ringLines(s, xe, yc, zc, p.cyl.r * IN);
            geo(s, V.galv, cylGeo(p.cyl.r * IN, sx, 'x', xc, yc, zc, full ? 32 : 18, true), true, 'inlet');
            if (full) { const b = new THREE.TorusGeometry(p.cyl.r * IN, 0.002, 6, 32); b.rotateY(Math.PI / 2); b.translate(lx(s, p.x0 + Math.min(1.1, (p.x1 - p.x0) * 0.4)), yc, zc); geo(s, V.galv, b, true, 'inlet'); }
          } else {
            for (const [a, b2] of [[0, 1], [1, 0]]) {
              geo(s, V.galv, boxGeo(sx, SHEET, sz, xc, a ? p.y0 * IN + SHEET / 2 : p.y1 * IN - SHEET / 2, zc), true, 'inlet');
              geo(s, V.galv, boxGeo(sx, sy, SHEET, xc, yc, b2 ? p.z0 * IN + SHEET / 2 : p.z1 * IN - SHEET / 2), true, 'inlet');
            }
          }
        } else if (p.kind === 'flowcross' && full) {
          const r = Math.min(sy, sz) / 2;
          geo(s, V.tube, cylGeo(0.003, 2 * r, 'y', xc, yc, zc, 8), true, 'inlet');
          geo(s, V.tube, cylGeo(0.003, 2 * r, 'z', xc, yc, zc, 8), true, 'inlet');
          geo(s, V.tube, cylGeo(0.008, 0.012, 'x', xc, yc, zc, 10), true, 'inlet');
        } else if (p.kind === 'valvebody' && full) {
          if (p.cyl) geo(s, V.galvDark, cylGeo(p.cyl.r * IN * 0.995, sx, 'x', xc, yc, zc, 28, true), true, 'inlet');
        }
      }
      for (const [i, S] of L.shafts.entries()) {
        const s = inletSec;
        const pivot = new THREE.Group();
        pivot.position.set(lx(s, S.x), S.y * IN, S.zc * IN);
        pivot.userData.dir = (t.options.damperRot || 90) / 90;
        s.group.add(pivot);
        let bladeMesh = null;
        if (full) {
          bladeMesh = new THREE.Mesh(new THREE.CylinderGeometry(S.bladeR * IN, S.bladeR * IN, 0.002, 36), V.blade);
          bladeMesh.castShadow = true;
          pivot.add(bladeMesh);
          const gk = new THREE.Mesh(new THREE.TorusGeometry(S.bladeR * IN, 0.0018, 6, 36), V.gasket);
          gk.rotation.x = Math.PI / 2;
          pivot.add(gk);
          this.vp.blades.push({ mesh: bladeMesh, gasket: gk });
        }
        const zFar = -S.dir * (L.inlets[i]?.w ?? 8) / 2 * IN;
        const zOut = (S.zEnd - S.zc) * IN;
        const shaft = noFootprint(new THREE.Mesh(cylGeo(S.dia / 2 * IN, Math.abs(zOut - zFar), 'z', 0, 0, (zOut + zFar) / 2, 10), V.steel));
        pivot.add(shaft);
        for (const b of pivot.children) b.userData.pick = PICK.inlet;
        pivot.rotation.z = pivot.userData.dir * Math.PI / 2 * 0.95;     // shut until the first live read
        const suffix = i === 0 ? dmpS : pick(['HD.DMP.POS', 'HD.DMP']);
        const rec = { suffix, blades: [pivot], pos: 0, g: s.group, depth: (L.inlets[i]?.w ?? 8) * IN, height: (L.inlets[i]?.h ?? 8) * IN, n: 1 };
        this.parts.dampers.push(rec);
        S.rec = rec; S.pivot = pivot;
        if (suffix) { this.anchors.set(suffix, pivot); this._bind(suffix); }
      }

      // ---- casing (+ parallel fan box), attenuator, reheat, outlet ----
      const cs = secOf('casing');
      const P = Object.fromEntries(L.parts.map((p) => [p.id, p]));
      const faceHoles = (x, zLo, zHi) => {
        const holes = [];
        for (const c of L.parts.filter((p) => p.kind === 'collar')) if (Math.abs(c.x1 - x) < 0.01 && c.z0 >= zLo - 0.01 && c.z1 <= zHi + 0.01) holes.push(c.cyl ? { kind: 'circle', z: ((c.z0 + c.z1) / 2) * IN, y: ((c.y0 + c.y1) / 2) * IN, r: c.cyl.r * IN } : { kind: 'rect', z0: c.z0 * IN, z1: c.z1 * IN, y0: c.y0 * IN, y1: c.y1 * IN });
        for (const o of L.parts.filter((p) => p.kind === 'induced' && p.face === 'end')) if (o.z0 >= zLo - 0.01 && o.z1 <= zHi + 0.01) holes.push({ kind: 'rect', z0: o.z0 * IN, z1: o.z1 * IN, y0: o.y0 * IN, y1: o.y1 * IN });
        return holes;
      };
      // The casing in the air handler's finish (More → Casing, cv_ahu_casing): CLEAR glass on every
      // side (default) or smooth matte GREY with the hand side left clear; the black border on every
      // edge either way. Only the parts that are metal in the photo stay metal: the round inlet
      // collar, the valve body, the controls enclosure, the discharge collar.
      // in the twin a clear box a foot long would vanish against the floor: a denser tint of the same glass
      if (this.embedded && !this.m.casingTwin) {
        this.m.casingTwin = this.m.casingClear.clone();
        this.m.casingTwin.color.set('#a9b6bd'); this.m.casingTwin.opacity = 0.3; this.m.casingTwin.userData.shared = true;
      }
      const skin = this.casing === 'grey' ? this.m.casingGrey : this.embedded ? this.m.casingTwin : this.m.casingClear;
      const clear = this.m.casingClear;
      const shell = (p, s, { handGlass = true, ends = true, outHole = null } = {}) => {
        const x0 = lx(s, p.x0), x1 = lx(s, p.x1), xc = (x0 + x1) / 2, len = x1 - x0;
        const y0 = p.y0 * IN, y1 = p.y1 * IN, z0 = p.z0 * IN, z1 = p.z1 * IN, zc = (z0 + z1) / 2, wid = z1 - z0, hgt = (p.y1 - p.y0) * IN, yc = (y0 + y1) / 2;
        boxLines(s, x0, x1, y0, y1, z0, z1);
        if (!full) { geo(s, skin, boxGeo(len, hgt, wid, xc, yc, zc)); return; }
        const handZ = L.side > 0 ? z1 : z0, farZ = L.side > 0 ? z0 : z1;
        geo(s, skin, boxGeo(len, SHEET, wid, xc, y0 + SHEET / 2, zc));                                   // bottom
        geo(s, skin, boxGeo(len, SHEET, wid, xc, y1 - SHEET / 2, zc));                                   // top
        geo(s, skin, boxGeo(len, hgt, SHEET, xc, yc, farZ - Math.sign(farZ - zc || 1) * SHEET / 2));     // far side
        geo(s, handGlass ? clear : skin, boxGeo(len, hgt, SHEET, xc, yc, handZ - Math.sign(handZ - zc || 1) * SHEET / 2));
        if (ends) geo(s, skin, endFaceGeo(x0, z0, z1, y0, y1, faceHoles(p.x0, p.z0, p.z1)));
        if (outHole) geo(s, skin, endFaceGeo(x1, z0, z1, y0, y1, outHole === true ? [] : outHole));
      };
      const fpb = !!VAV_TYPES[t.type].fan;
      const outHoleOf = (p) => {
        const o = L.outlet;
        if (!fpb || o.z0 < p.z0 - 0.01 || o.z1 > p.z1 + 0.01) return null;
        return [{ kind: 'rect', z0: o.z0 * IN, z1: o.z1 * IN, y0: o.y0 * IN, y1: o.y1 * IN }];
      };
      shell(P.casing, cs, { outHole: outHoleOf(P.casing) });
      if (P.fanbox) shell(P.fanbox, cs, { handGlass: false, outHole: true });
      if (P.fanbox && full && P.backdraft) {
        // the shared wall between the fan box and the casing, with the backdraft opening
        const b = P.backdraft, zw = (b.z0 + b.z1) / 2 * IN;
        const sh = new THREE.Shape();
        const x0 = lx(cs, P.casing.x0), x1 = lx(cs, P.casing.x1);
        sh.moveTo(x0, 0); sh.lineTo(x1, 0); sh.lineTo(x1, L.H * IN); sh.lineTo(x0, L.H * IN); sh.lineTo(x0, 0);
        const hole = new THREE.Path();
        hole.moveTo(lx(cs, b.x0), b.y0 * IN); hole.lineTo(lx(cs, b.x1), b.y0 * IN); hole.lineTo(lx(cs, b.x1), b.y1 * IN); hole.lineTo(lx(cs, b.x0), b.y1 * IN); hole.lineTo(lx(cs, b.x0), b.y0 * IN);
        sh.holes.push(hole);
        const g = new THREE.ShapeGeometry(sh); g.translate(0, 0, zw);
        geo(cs, V.galv, g);
        // three blades on pivots, opening only on a live fan proof
        const blades = [];
        const pitch = (b.y1 - b.y0) * IN / 3;
        for (let k = 0; k < 3; k++) {
          const pv = new THREE.Group();
          pv.position.set((lx(cs, b.x0) + lx(cs, b.x1)) / 2, b.y0 * IN + pitch * (k + 0.5), zw);
          const bl = new THREE.Mesh(new THREE.BoxGeometry((b.x1 - b.x0) * IN - 0.004, pitch * 0.96, 0.001), V.blade);
          pv.add(bl); cs.group.add(pv); blades.push(pv);
        }
        this.vp.backdraft = { blades, open: 0, target: 0 };
      }
      if (P.att) {
        const s = secOf('attenuator');
        shell(P.att, s, { handGlass: false, ends: false });
        if (full) for (const f of [0.33, 0.66]) geo(s, V.media, boxGeo((P.att.x1 - P.att.x0) * IN * 0.9, (P.att.y1 - P.att.y0) * IN * 0.9, 0.012, lx(s, (P.att.x0 + P.att.x1) / 2), (P.att.y0 + P.att.y1) / 2 * IN, (P.att.z0 + (P.att.z1 - P.att.z0) * f) * IN));
      }
      // induced / return opening: filter frame and media in the opening
      for (const o of L.parts.filter((p) => p.kind === 'induced')) {
        const s = cs, x0 = Math.max(o.x0, L.casingFace);
        const fx = lx(s, x0 + 0.5), yc = (o.y0 + o.y1) / 2 * IN, zc = (o.z0 + o.z1) / 2 * IN, w = (o.z1 - o.z0) * IN, h = (o.y1 - o.y0) * IN;
        if (o.face === 'end') {
          geo(s, V.media, boxGeo(0.02, h * 0.96, w * 0.96, fx, yc, zc));
          if (full) for (const [a, b2] of [[0, 1], [1, 0]]) { geo(s, V.galvDark, boxGeo(0.025, 0.012, w, fx, a ? o.y0 * IN + 0.006 : o.y1 * IN - 0.006, zc)); geo(s, V.galvDark, boxGeo(0.025, h, 0.012, fx, yc, b2 ? o.z0 * IN + 0.006 : o.z1 * IN - 0.006)); }
        } else geo(s, V.media, boxGeo((o.x1 - o.x0) * IN, Math.max(0.02, (o.y1 - o.y0) * IN), (o.z1 - o.z0) * IN, lx(s, (o.x0 + o.x1) / 2), yc, zc));
      }
      // blower (records a fan the base animates; it turns only on a live proof)
      if (P.blower) {
        const b = P.blower;
        const bw = (b.axis === 'z' ? b.z1 - b.z0 : b.x1 - b.x0) * IN;
        const fb = blower(cs.group, { r: b.r * IN, w: bw, axis: b.axis === 'z' ? 'z' : 'x', mats: V, full });
        fb.g.position.set(lx(cs, (b.x0 + b.x1) / 2), (b.y0 + b.y1) / 2 * IN, (b.z0 + b.z1) / 2 * IN);
        if (P.fanbox) fb.g.rotation.y = 0; // parallel: axis along x, blowing through the backdraft
        const run = has('SF1.STS') ? 'SF1.STS' : null;         // proof only — a command never spins it
        const spd = has('SF1.SVD') ? 'SF1.SVD' : null, flt = has('SF1.FLT') ? 'SF1.FLT' : null;
        this.parts.fans.push({ base: 'SF1', run, spd, flt, wheel: fb.wheel, band: fb.band, dir: 1, speed: 0 });
        const pk = { title: 'Fan', points: ['SF1.SS', 'SF1.STS', 'SF1.SVD', 'SF1.FLT'].filter((x) => has(x)) };
        fb.g.traverse((o) => { if (o.isMesh) o.userData.pick = pk; });
        for (const x of [run, spd, flt]) if (x) this._bind(x);
        if (has('SF1.SS')) this.anchors.set('SF1.SS', fb.g);
      }
      // reheat
      let coilRec = null, coilSec = null;
      if (P.coil) {
        const p = P.coil, s = P.coil.atFan ? cs : secOf('coil');
        coilSec = s;
        const x0 = lx(s, p.x0), x1 = lx(s, p.x1), xc = (x0 + x1) / 2, len = x1 - x0;
        const y0 = p.y0 * IN, y1 = p.y1 * IN, z0 = p.z0 * IN, z1 = p.z1 * IN, zc = (z0 + z1) / 2;
        if (!p.atFan) shell(p, s, { handGlass: false, ends: false });
        const finMat = new THREE.MeshStandardMaterial({ color: '#aab4bd', metalness: 0.8, roughness: 0.35, emissive: '#ff5a1f', emissiveIntensity: 0 });
        const tubeMat = new THREE.MeshStandardMaterial({ color: '#b8733a', metalness: 0.9, roughness: 0.32, emissive: '#ff4a14', emissiveIntensity: 0 });
        const nFins = full ? 48 : 16;
        // the fin geometry sits at the coil centre (a footprint read from geometry bounds stays inside the section)
        const finGeo = new THREE.BoxGeometry(len * 0.82, (y1 - y0) * 0.9, full ? 0.0004 : 0.002);
        finGeo.translate(xc, (y0 + y1) / 2, zc);
        const fins = new THREE.InstancedMesh(finGeo, finMat, nFins);
        const mtx = new THREE.Matrix4();
        for (let k = 0; k < nFins; k++) { mtx.makeTranslation(0, 0, z0 + (z1 - z0) * (k + 0.5) / nFins - zc); fins.setMatrixAt(k, mtx); }
        fins.castShadow = true;
        s.group.add(fins);
        const tubes = [];
        if (full) {
          const rows = t.options.heatRows || 1;
          for (let r = 0; r < rows; r++) for (let k = 0; k < 4; k++) tubes.push(cylGeo(0.0048, (z1 - z0) + 0.01, 'z', x0 + len * (r + 0.5) / rows, y0 + (y1 - y0) * (k + 0.5) / 4, zc, 10));
        }
        const tubeMesh = tubes.length ? mergeStatic(s.group, tubeMat, tubes) : null;
        const pk = { title: 'Reheat coil', points: ['RHV', 'RHV.POS', 'DAT'].filter((x) => has(x)) };
        fins.userData.pick = pk; if (tubeMesh) tubeMesh.userData.pick = pk;
        coilRec = { suffix: 'RHV', mats: [finMat, tubeMat], heat: true, pct: 0, fx: { uFlow: { value: 0 }, uWet: { value: 0 }, uFrost: { value: 0 }, uTime: { value: 0 }, uH: { value: 0 } }, pan: null, wet: 0, frost: 0 };
        this.parts.coils.push(coilRec);
        s.v = 'RHV'; s.heat = true; s.t = has('DAT') ? 'DAT' : null;
        if (has('RHV')) { this.anchors.set('RHV', fins); this._bind('RHV'); }
      }
      if (P.heater) {
        const p = P.heater, s = secOf('heater');
        shell(p, s, { handGlass: false, ends: false });
        const x0 = lx(s, p.x0), len = (p.x1 - p.x0) * IN, y0 = p.y0 * IN, y1 = p.y1 * IN, z0 = p.z0 * IN, z1 = p.z1 * IN;
        const inl = (this.config?.supply || []).find((x) => x.device === 'eheat');
        const syms = inl?.scr ? ['EH.SCR'] : ['EH1', 'EH2', 'EH3'].filter((x, k) => k < (inl?.stages || t.options.heatStages || 1));
        syms.forEach((sfx, k) => {
          const mat = new THREE.MeshStandardMaterial({ color: '#6b747b', metalness: 0.6, roughness: 0.45, emissive: '#ff5a1f', emissiveIntensity: 0 });
          const xk = x0 + len * (k + 1) / (syms.length + 1);
          const pts = [];
          const turns = full ? 9 : 3;
          for (let q = 0; q <= turns; q++) pts.push(new THREE.Vector3(xk + (q % 2 ? 0.015 : -0.015), y0 + (y1 - y0) * (0.12 + 0.76 * q / turns), (z0 + z1) / 2));
          const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), full ? 48 : 12, 0.004, full ? 6 : 4, false);
          // stretch across the width: one element per stage, spanning z
          g.translate(0, 0, 0);
          const el = new THREE.Mesh(g, mat);
          el.scale.set(1, 1, 1);
          s.group.add(el);
          const rack = new THREE.Mesh(boxGeo(0.01, 0.01, (z1 - z0) * 0.92, xk, y0 + (y1 - y0) * 0.5, (z0 + z1) / 2), mat);
          s.group.add(rack);
          const pk = { title: inl?.scr ? 'Electric heat (SCR)' : `Heat stage ${k + 1}`, points: [sfx, 'EH.FLT', 'DAT'].filter((x) => has(x)) };
          el.userData.pick = pk; rack.userData.pick = pk;
          this.vp.heaters.push({ sfx, mat, level: 0, target: 0, scr: !!inl?.scr });
          if (has(sfx)) this._bind(sfx);
        });
        if (P.panel) {
          const q = P.panel, g = nfOf(s);
          const pm = new THREE.Mesh(boxGeo((q.x1 - q.x0) * IN, (q.y1 - q.y0) * IN, (q.z1 - q.z0) * IN, lx(s, (q.x0 + q.x1) / 2), (q.y0 + q.y1) / 2 * IN, (q.z0 + q.z1) / 2 * IN), V.galv);
          g.add(pm);
          if (full) g.add(new THREE.Mesh(boxGeo(0.03, 0.05, 0.02, lx(s, q.x0 + 2), (q.y0 + q.y1) / 2 * IN, (L.side > 0 ? q.z1 : q.z0) * IN + L.side * 0.01), V.dark));
          pm.userData.pick = { title: 'Heater control panel', points: ['EH1', 'EH2', 'EH3', 'EH.SCR', 'EH.FS', 'EH.FLT'].filter((x) => has(x)) };
        }
      }
      // the discharge plenum: the same casing as the rest of the box (one manufactured unit)
      if (P.outlet) shell(P.outlet, secOf('outlet'), { ends: false });
      // a slip-on duct flange round the discharge opening (and at the stub end): the box's dark frame
      const flange = (s, xAt, p, footprint) => {
        const w = (p.z1 - p.z0) * IN, h = (p.y1 - p.y0) * IN, yc = (p.y0 + p.y1) / 2 * IN, zc = (p.z0 + p.z1) / 2 * IN, b = 0.022, d = 0.012;
        for (const [sx, sy, sz, oy, oz] of [[d, b, w + 2 * b, h / 2 + b / 2, 0], [d, b, w + 2 * b, -h / 2 - b / 2, 0], [d, h, b, 0, w / 2 + b / 2], [d, h, b, 0, -w / 2 - b / 2]]) geo(s, this.m.rail, boxGeo(sx, sy, sz, xAt, yc + oy, zc + oz), footprint);
        if (full) boxLines(s, xAt - d / 2, xAt + d / 2, yc - h / 2 - b, yc + h / 2 + b, zc - w / 2 - b, zc + w / 2 + b);
      };
      if (P.hvbox) {
        const q = P.hvbox, s = secOf(q.sec), g = nfOf(s);
        const m = new THREE.Mesh(boxGeo((q.x1 - q.x0) * IN, (q.y1 - q.y0) * IN, (q.z1 - q.z0) * IN, lx(s, (q.x0 + q.x1) / 2), (q.y0 + q.y1) / 2 * IN, (q.z0 + q.z1) / 2 * IN), V.galv);
        m.userData.pick = { title: 'Fan high-voltage enclosure', points: ['SF1.SS', 'SF1.STS'].filter((x) => has(x)) };
        g.add(m);
      }
      // discharge stub (off the footprint) and the primary stub a PAT probe sits on
      // the discharge duct stub: the same finish, flanged at the box and at its end (not a grey block)
      for (const p of L.parts.filter((x) => x.kind === 'stub')) {
        const s = secOf(p.sec);
        const x0 = lx(s, p.x0), x1 = lx(s, p.x1), xc = (x0 + x1) / 2, sx = x1 - x0, w = (p.z1 - p.z0) * IN, h = (p.y1 - p.y0) * IN, yc = (p.y0 + p.y1) / 2 * IN, zc = (p.z0 + p.z1) / 2 * IN;
        if (p.cyl) { geo(s, skin, cylGeo(p.cyl.r * IN, sx, 'x', xc, yc, zc, 24, true), false); continue; }
        for (const gg of full ? [boxGeo(sx, SHEET * 2, w, xc, p.y0 * IN, zc), boxGeo(sx, SHEET * 2, w, xc, p.y1 * IN, zc), boxGeo(sx, h, SHEET * 2, xc, yc, p.z0 * IN), boxGeo(sx, h, SHEET * 2, xc, yc, p.z1 * IN)] : [boxGeo(sx, h, w, xc, yc, zc)]) geo(s, skin, gg, false);
        if (full) boxLines(s, x0, x1, p.y0 * IN, p.y1 * IN, p.z0 * IN, p.z1 * IN);
        flange(s, x0 + 0.006, p, false);
        if (full) flange(s, x1 - 0.006, p, false);
      }
      this._encArgs = { inletSec, lx, nfOf, boxLines, dmpCmd, flowS };

      { const o = L.outlet, s = secOf('outlet'); flange(s, lx(s, o.x) - 0.006, o, false); }
      for (const [s, arr] of lines) {
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        const ls = new THREE.LineSegments(lg, this.m.outline || this.m.edge);
        ls.name = 'vav-outline';
        nfOf(s).add(ls);
      }

      // ---- merge the static geometry ----
      for (const b of buckets.values()) {
        const parent = b.footprint ? b.s.group : nfOf(b.s);
        const mesh = mergeStatic(parent, b.mat, b.geos, { name: `vav-${b.s.kind}` });
        if (mesh && b.mat.transparent) { mesh.castShadow = false; mesh.renderOrder = 2; }
        if (mesh) mesh.userData.pick = b.picked === 'inlet' ? PICK.inlet : b.s.kind === 'casing' ? { title: 'Casing', points: [flowS, dmpCmd].filter(Boolean) } : { title: CAPS[b.s.kind] ? CAPS[b.s.kind].toLowerCase().replace(/^./, (c) => c.toUpperCase()) : b.s.kind, points: [] };
      }
      for (const s of secs) for (const o of s.group.children) if (o.userData.pick && !o.userData.pick.points.length) delete o.userData.pick;

      // ---- piping and the reheat valve (HW), anchors the twin routes to ----
      this.coilPorts = [];
      if (L.pipes && coilSec) {
        const pp = L.pipes, s = coilSec, g = nfOf(s);
        const xl = lx(s, pp.x), r = pp.r * IN;
        const zA = pp.zWall * IN, zB = pp.zEnd * IN;
        const pipes = [cylGeo(r, Math.abs(zB - zA), 'z', xl, pp.supY * IN, (zA + zB) / 2, 12), cylGeo(r, Math.abs(zB - zA), 'z', xl, pp.retY * IN, (zA + zB) / 2, 12)];
        if (full) pipes.push(cylGeo(r * 1.6, (pp.retY - pp.supY) * IN + r * 4, 'y', xl, (pp.supY + pp.retY) / 2 * IN, zA + pp.side * r * 2, 12));
        const pm = mergeStatic(g, V.copper, pipes, { name: 'pipes' });
        pm.userData.pick = { title: 'Reheat piping', points: ['RHV'].filter((x) => has(x)) };
        // the building's hot-water supply lands on the supply pipe end; return on the other
        this.coilPorts.push({ g: s.group, heat: true, local: [xl, pp.supY * IN, zB], retLocal: [xl, pp.retY * IN, zB], r, dir: [0, 0, pp.side] });
      }

      // ---- readouts ----
      this._vavTags(secs, secOf, lx);

      // ---- Siemens devices (SIEMENS library, else placeholders), then the enclosure sized round them ----
      this._vavDevices(secOf, lx, nfOf, coilRec, coilSec);
      for (const e of L.enclosures) this._vavEnclosure(e, this._encArgs, full);
      this._encArgs = null;

      // ---- captions, frames, anchors for the twin and the room ----
      if (full) for (const s of secs) if (s.x1 - s.x0 > 0.5) this._vavCaption(s);
      if (!t.sizeSet || t.inferred) {
        const tag = this._label(t.inferred ? 'size not set · from its sections' : 'size not set', 'a3-sec vav3-size');
        tag.position.set(0, L.H * IN + 0.06, 0);
        cs.group.add(tag);
      }
      const b = L.bbox;
      const len = (b.x1 - b.x0) * IN, wid = (b.z1 - b.z0) * IN;
      const i0 = L.inlets[0];
      this.inletLocal = i0 ? { x: i0.x * IN, y: i0.cy * IN, z: i0.cz * IN, w: i0.w * IN, h: i0.h * IN, shape: i0.shape, dia: i0.shape === 'round' ? i0.od * IN : null } : null;
      if (L.inlets[1]) { const i1 = L.inlets[1]; this.inlet2Local = { x: i1.x * IN, y: i1.cy * IN, z: i1.cz * IN, w: i1.w * IN, h: i1.h * IN, shape: i1.shape, dia: i1.shape === 'round' ? i1.od * IN : null }; }
      const o = L.outlet;
      this.outletLocal = { x: o.x * IN, y: (o.y0 + o.y1) / 2 * IN, z: o.zc * IN, w: o.w * IN, h: o.h * IN };
      this.unitEnd = (o.x + d.dischStubL) * IN;
      this.diffX = o.x * IN + 0.8 + d.dischStubL * IN * 0;
      if (this.diffX < this.unitEnd + 0.3) this.diffX = this.unitEnd + 0.3;
      this.roomX1 = Math.max(this.diffX + 2.0, Math.abs(b.x0 * IN) + 0.5);
      this.roomX0 = -this.roomX1;
      this.total = this.embedded ? len : this.roomX1 - this.roomX0;
      this.airBox = [this.DH, this.D];
      if (!this.embedded && this.hasZone) this._room();
      unit.position.y = this.roomH;
      this.foot = this.embedded ? { zMin: b.z0 * IN, zMax: b.z1 * IN } : { zMin: -this.roomD / 2, zMax: this.roomD / 2 };
      this.vavSize = { len, wid, ht: L.H * IN };
    }

    /**
     * The room under the box, drawn like the air handler's casing: a dark floor, a back wall and
     * an end wall that fade away when the camera is behind them (so no view is ever blocked), a
     * clear ceiling, a black outline; the discharge duct and drop (clear, outlined) to a square
     * ceiling diffuser; the room unit on the back wall; an occupant only while OCC reads live.
     */
    _room() {
      const m = this.m;
      const g = new THREE.Group();
      g.name = 'vav-room';
      this.unit.add(g);
      const x0 = this.roomX0, x1 = this.roomX1, Wr = x1 - x0, xc = (x0 + x1) / 2, H = this.roomH, Dr = this.roomD;
      const wall = () => new THREE.MeshStandardMaterial({ color: '#1a2026', metalness: 0, roughness: 0.95, envMapIntensity: 0.15, transparent: true, opacity: 1, side: THREE.DoubleSide });
      const floor = new THREE.Mesh(new THREE.BoxGeometry(Wr, 0.05, Dr), m.floor);
      floor.position.set(xc, -H + 0.025, 0);
      floor.receiveShadow = true;
      g.add(floor);
      const back = new THREE.Mesh(new THREE.PlaneGeometry(Wr, H), wall());
      back.position.set(xc, -H / 2, -Dr / 2);
      back.receiveShadow = true;
      g.add(back);
      const end = new THREE.Mesh(new THREE.PlaneGeometry(Dr, H), wall());
      end.rotation.y = -Math.PI / 2;
      end.position.set(x1, -H / 2, 0);
      end.receiveShadow = true;
      g.add(end);
      this._cut = { g, walls: [{ mesh: back, axis: 'z', at: -Dr / 2, sign: -1, k: 1 }, { mesh: end, axis: 'x', at: x1, sign: 1, k: 1 }] };
      const ceil = new THREE.Mesh(new THREE.PlaneGeometry(Wr, Dr), m.casingClear);
      ceil.rotation.x = -Math.PI / 2;
      ceil.position.set(xc, -0.01, 0);
      ceil.renderOrder = 2;
      g.add(ceil);
      const L2 = [];
      const seg = (a, b) => L2.push(...a, ...b);
      const bx = (ax0, ax1, ay0, ay1, az0, az1) => {
        const c = [[ax0, ay0, az0], [ax1, ay0, az0], [ax1, ay1, az0], [ax0, ay1, az0], [ax0, ay0, az1], [ax1, ay0, az1], [ax1, ay1, az1], [ax0, ay1, az1]];
        for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) seg(c[a], c[b]);
      };
      bx(x0, x1, -H, -0.01, -Dr / 2, Dr / 2);
      // discharge duct from the outlet collar to the diffuser neck, then the drop to the ceiling
      const o = this.outletLocal, dx = this.diffX, zO = o.z;
      const dh = Math.max(0.12, o.h), dw = Math.max(0.15, o.w);
      const runL = Math.max(0.05, dx - this.unitEnd + dw * 0.35);
      const run = new THREE.Mesh(new THREE.BoxGeometry(runL, dh, dw), m.casingClear);
      run.position.set(this.unitEnd + runL / 2, o.y, zO);
      run.renderOrder = 2;
      g.add(run);
      bx(this.unitEnd, this.unitEnd + runL, o.y - dh / 2, o.y + dh / 2, zO - dw / 2, zO + dw / 2);
      const nw = 0.3, neckTop = o.y - dh / 2;
      if (neckTop > 0.02) {
        const neck = new THREE.Mesh(new THREE.BoxGeometry(nw, neckTop, nw), m.casingClear);
        neck.position.set(dx, neckTop / 2, zO);
        neck.renderOrder = 2;
        g.add(neck);
        bx(dx - nw / 2, dx + nw / 2, 0, neckTop, zO - nw / 2, zO + nw / 2);
      }
      // a 24 × 24 in square-cone ceiling diffuser: matte white-grey face, the cones as outlines
      const S = 0.6;
      const face = new THREE.Mesh(new THREE.BoxGeometry(S, 0.02, S), new THREE.MeshStandardMaterial({ color: '#7f888e', metalness: 0.1, roughness: 0.7, envMapIntensity: 0.2 }));
      face.position.set(dx, -0.02, zO);
      g.add(face);
      for (const f of [1, 0.74, 0.5, 0.28]) for (const y of [-0.031, -0.009]) { const h = (S * f) / 2; seg([dx - h, y, zO - h], [dx + h, y, zO - h]); seg([dx + h, y, zO - h], [dx + h, y, zO + h]); seg([dx + h, y, zO + h], [dx - h, y, zO + h]); seg([dx - h, y, zO + h], [dx - h, y, zO - h]); }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(L2, 3));
      const lines = new THREE.LineSegments(lg, m.outline);
      lines.name = 'vav-room-outline';
      g.add(lines);
      this.diffZ = zO;
      // the room unit on the back wall, the zone readout above it
      const tx = Math.min(dx + 1.4, x1 - 0.45);
      this._thermostat(g, tx, -H + 1.5, -Dr / 2);
      // an occupant, shown only while occupancy reads live and on
      const person = new THREE.Group();
      const pm = new THREE.MeshStandardMaterial({ color: '#6f8796', metalness: 0.1, roughness: 0.8 });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.85, 4, 12), pm);
      body.position.y = 0.6; body.castShadow = true; person.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), pm);
      head.position.y = 1.36; head.castShadow = true; person.add(head);
      person.position.set(Math.min(dx + 0.7, x1 - 0.6), -H + 0.05, 0.35);
      person.visible = false;
      g.add(person);
      this.person = person;
      const cap = this._label((this._zoneCfg()?.label || 'Zone').toUpperCase(), 'a3-sec');
      cap.position.set((dx + x1) / 2, -H + 0.04, Dr / 2 + 0.2);
      g.add(cap);
    }

    /** Section caption on the floor side of the box (full detail only). */
    _vavCaption(s) {
      const o = this._label(s.cap, 'a3-sec');
      o.visible = false;
      (this.vavCaps ||= []).push(o);
      o.position.set(0, -0.03, (this.lay.side > 0 ? -1 : 1) * (this.D / 2 + 0.06));
      s.group.add(o);
    }

    /** Readouts pinned to the parts (vav-spec §8.4 tags). */
    _vavTags(secs, secOf, lx) {
      const has = this.has, L = this.lay, t = this.term, IN_ = IN;
      const pick = (c) => c.find((x) => x && has(x)) || null;
      const inS = secOf('inlet'), i0 = L.inlets[0];
      const far = -L.side;
      const top = L.H * IN_ + 0.08;
      if (i0) {
        const est = has('VAV.DMP.POS');
        const spUnit = this.config?.supply?.find((x) => x.device === 'vavinlet')?.flowSpUnits === '%' ? '%' : 'cfm';
        // one tag for the air valve, high over the inlet on the far side
        this._tag(inS.group, [lx(inS, i0.x) - 0.1, top + 0.14, (i0.cz + far * i0.w * 0.4) * IN_], [
          [this.vavSfx.flow, 'AIRFLOW', 'cfm'],
          [pick(['VAV.FLOW.SP', 'CD.FLOW.SP', 'EX.FLOW.SP']), 'FLOW SP', spUnit],
          [this.vavSfx.dmp, est ? 'DAMPER calc' : 'DAMPER', '%', null, this.vavSfx.dmpCmd],
          ['PAT', 'PRI TMP', '°F'],
          [pick(['VAV.FLOW.MIN', 'VAV.CLG.MIN', 'EX.CLG.MIN']), 'MIN', 'cfm', null, pick(['VAV.CLG.MIN', 'EX.CLG.MIN'])],
          [pick(['VAV.FLOW.MAX', 'VAV.CLG.MAX', 'EX.CLG.MAX', 'CD.CLG.MAX']), 'MAX', 'cfm', null, pick(['VAV.CLG.MAX', 'EX.CLG.MAX', 'CD.CLG.MAX'])],
          [pick(['VAV.HTG.MAX']), 'HTG MAX', 'cfm', null, 'VAV.HTG.MAX'],
          [pick(['VAV.OCC.FLOW']), 'OCC FLOW', 'cfm', null, 'VAV.OCC.FLOW'],
          [pick(['VAV.UNOCC.FLOW']), 'UNOCC FLOW', 'cfm', null, 'VAV.UNOCC.FLOW'],
        ]);
      }
      const hs = secs.find((s) => s.kind === 'coil' || s.kind === 'heater');
      if (hs) {
        const x = lx(hs, (hs.x0 + hs.x1) / 2);
        const rows = hs.kind === 'coil' ? [['RHV', 'HW VLV cmd', '%', null, 'RHV'], ['RHV.POS', 'HW VLV pos', '%']]
          : [['EH1', 'STAGE 1 cmd', 'onoff', null, 'EH1'], ['EH2', 'STAGE 2 cmd', 'onoff', null, 'EH2'], ['EH3', 'STAGE 3 cmd', 'onoff', null, 'EH3'], ['EH.SCR', 'HEAT SCR cmd', '%', null, 'EH.SCR'], ['EH.FLT', 'HEATER', 'alm']];
        // heat and discharge together, over the heat section on the connection side
        this._tag(hs.group, [x + 0.08, top + 0.06, L.cside * (L.W / 2 + 6) * IN_], [...rows, ['DAT', 'DA TMP', '°F']]);
      }
      if (has('SF1.STS') || has('SF1.SS')) {
        const cs = secOf('casing'), b = L.parts.find((p) => p.kind === 'blower');
        const pos = b ? [lx(cs, (b.x0 + b.x1) / 2), top + 0.14, (b.z0 + b.z1) / 2 * IN_] : [0, top + 0.14, 0];
        this._tag(cs.group, pos, has('SF1.STS')
          ? [['SF1.STS', 'FAN', 'onoff', null, 'SF1.SS'], ['SF1.SVD', 'SPEED', '%'], ['SF1.FLT', 'FAN', 'alm']]
          : [['SF1.SS', 'FAN cmd', 'onoff', null, 'SF1.SS'], ['SF1.SVD', 'SPEED', '%']]);
      }
      if (!hs) { const os = secOf('outlet'); this._tag(os.group, [lx(os, L.outlet.x + 6), top, L.outlet.zc * IN_], [['DAT', 'DA TMP', '°F']]); }
      if (!i0) this._tag(inS.group, [0, top, 0], [['PAT', 'PRI TMP', '°F']]);
    }

    /** Controller, damper actuator, reheat valve, duct probes: SIEMENS parts or placeholders. */
    _vavDevices(secOf, lx, nfOf, coilRec, coilSec) {
      const has = this.has, L = this.lay, t = this.term, V = this.m.vav;
      const off = this._devicesOff;
      const inS = secOf('inlet');
      const S = L.shafts[0];
      const P = (s, [x, y, z]) => [lx(s, x), y * IN, z * IN];
      const plateM = L.mounts.controller.plate;
      const plate = { pos: P(inS, plateM.pos), normal: plateM.normal, up: plateM.up };
      const hub = S ? { pos: P(inS, [S.x, S.y, S.zEnd]), normal: [0, 0, S.dir], up: [0, 1, 0] } : null;
      const part = controllerPart(t);
      const flowS = this.vavSfx.flow, dmpCmd = this.vavSfx.dmpCmd;
      const ctlPick = { title: `${part || 'TEC controller (model not set)'} · ${this.title || this.config?.tag || 'VAV'}`, points: [dmpCmd, flowS, has('VAV.FLOW.SP') ? 'VAV.FLOW.SP' : null].filter(Boolean), device: part || 'TEC' };
      const tagDev = (o, pk) => { if (!o) return; noFootprint(o); o.traverse((x) => { if (x.isMesh || x.isGroup) x.userData.pick = pk; }); };
      const call = (g, sfx, role, pose, caption) => (typeof this._device === 'function' ? this._device(g, sfx, role, pose, caption) : null);
      // placeholders join the device registry too, so the twin hides them on unfocused units like real parts
      const reg = (sfx, objects, extra = {}) => (this.parts.devices ||= []).push({ sfx, role: sfx, placeholder: true, group: objects[0], objects, ...extra });
      // controller: on the shaft when it actuates, else on the enclosure back plate
      const ctlPose = hub ? { ...hub, drives: S.rec, blade: 0, plate, points: ctlPick.points } : { ...plate, points: ctlPick.points };
      const built = call(inS.group, 'term.controller', 'term.controller', ctlPose, 'Controller');
      if (built?.group && built.spec?.ports && !this.embedded) this._vavTubes(inS, lx, built);
      if (built) {
        if (built.group) noFootprint(built.group);            // SIEMENS titles and picks its own part
        if (built.spec && built.spec.actuating === false && hub && dmpCmd) {
          const dmp = call(inS.group, dmpCmd, 'term.damper', { ...hub, drives: S.rec, blade: 0, points: [dmpCmd, this.vavSfx.dmp].filter(Boolean) }, 'Primary damper');
          if (dmp?.group) noFootprint(dmp.group);
          else if (!dmp && !off) this._vavHub(inS, hub, S, defaultDamperActuator(), V.actuator, { title: 'Primary damper actuator', points: [dmpCmd].filter(Boolean) });
        }
      } else if (!off && this.devOf('term.controller', 'term.controller') !== 'none') {
        if (hub && isActuatingPart(part)) {
          this._vavHub(inS, hub, S, part, V.ral7035, ctlPick);
        } else {
          const g = placeholder(nfOf(inS), placeholderMm(part || 'TEC'), plate, V.ral7035, part || 'TEC');
          tagDev(g, ctlPick);
          reg('term.controller', [g]);
          if (hub) this._vavHub(inS, hub, S, t.controller.family === 'tec' ? 'GDE131.1P' : defaultDamperActuator(), V.actuator, { title: 'Primary damper actuator', points: [dmpCmd].filter(Boolean) });
        }
      }
      // reheat valve on the return line, connection side (2-way, SAS81 on a Powermite body)
      if (L.pipes && coilSec && has('RHV')) {
        const pp = L.pipes;
        const pose = { pos: P(coilSec, [pp.x, pp.valveY, pp.zValve]), normal: [0, 1, 0], up: [1, 0, 0], drives: coilRec, lineR: pp.r * IN, points: ['RHV', 'RHV.POS'].filter((x) => has(x)) };
        const vb = call(coilSec.group, 'RHV', 'term.valve', pose, 'Reheat valve');
        const vpk = { title: 'Reheat valve', points: ['RHV', 'RHV.POS'].filter((x) => has(x)) };
        if (vb?.group) noFootprint(vb.group);
        else if (!vb && !off && this.devOf('RHV', 'term.valve') !== 'none') {
          const g = nfOf(coilSec);
          const body = new THREE.Mesh(boxGeo(0.045, 0.04, 0.045, pose.pos[0], pose.pos[1], pose.pos[2]), V.brass);
          g.add(body);
          const act = placeholder(g, placeholderMm(DEFAULT_VALVE_ACTUATOR), { pos: [pose.pos[0], pose.pos[1] + 0.02, pose.pos[2]], normal: [0, 1, 0], up: [1, 0, 0] }, V.ral7035, DEFAULT_VALVE_ACTUATOR);
          tagDev(body, vpk); tagDev(act, vpk);
          reg('RHV', [body, act], { valve: true });
        }
      }
      // duct temperature probes
      for (const [key, sfx, role, caption] of [['dat', 'DAT', 'term.dat', 'Discharge air'], ['pat', 'PAT', 'term.pri.temp', 'Primary air']]) {
        const m = L.mounts[key];
        if (!m || !has(sfx)) continue;
        const s = key === 'dat' ? secOf('outlet') : inS;
        const pose = { pos: P(s, m.pos), normal: m.normal, up: m.up };
        const pb = call(s.group, sfx, role, pose, caption);
        const pk = { title: caption + ' temperature', points: [sfx] };
        if (pb?.group) noFootprint(pb.group);
        else if (!pb && !off) {
          const g = placeholder(nfOf(s), placeholderMm('QAM2130'), pose, V.ral7035, 'QAM2130');
          const probe = new THREE.Mesh(cylGeo(0.003, 0.1, 'y', 0, 0, -0.05, 8), V.steel);
          probe.rotation.x = Math.PI / 2;
          g.add(probe);
          tagDev(g, pk);
          reg(sfx, [g]);
        }
      }
    }

    /**
     * The controls enclosure, a real sheet-metal box on the side of the casing,
     * sized to just fit what it houses (the controller from its catalogue size,
     * plus the shaft end and its actuator when the shaft exits inside it) and
     * never bigger than the geometry set's enclosure: folded walls with return
     * lips round the open face, a knockout with a conduit connector and a stub
     * of EMT on top, and the cover — folded edges, two captive screws, a label
     * plate — hinged at the bottom and hanging open so the controller shows.
     * In the twin: one plain box.
     */
    _vavEnclosure(e, A, full) {
      const t = this.term, L = this.lay;
      if (t.enclosure.style === 'none') return;
      const s = A.inletSec, g = A.nfOf(s), V = this.m.vav, MM = 0.001 / IN;    // mm → inches
      const S = L.shafts[0], ctl = (this.parts.devices || []).find((d) => d.role === 'term.controller');
      const part = controllerPart(t), act = isActuatingPart(part);
      const box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, d: 0 };
      const take = (x0, x1, y0, y1, d) => { box.x0 = Math.min(box.x0, x0); box.x1 = Math.max(box.x1, x1); box.y0 = Math.min(box.y0, y0); box.y1 = Math.max(box.y1, y1); box.d = Math.max(box.d, d); };
      const shaftIn = S && S.x > e.x0 && S.x < e.x1;
      const reach = S ? Math.abs(S.zEnd - e.zWall) : 0;
      if (act && shaftIn) {
        // the actuating controller on the shaft: 137 × 201 × 82 mm, its hub 40 mm below the top
        const d = ctl?.spec?.dims || { w: 137, h: 201, d: 82 }, top = ctl?.spec?.hub?.fromTop ?? 40;
        take(S.x - (d.w / 2 + 25) * MM, S.x + (d.w / 2 + 25) * MM, S.y - (d.h - top + 25) * MM, S.y + (top + 25) * MM, reach + (d.d / 2 + 22) * MM);
      } else {
        const mm = ctl?.spec?.dims ? [ctl.spec.dims.w, ctl.spec.dims.h, ctl.spec.dims.d] : placeholderMm(part || 'TEC');
        const p = L.mounts.controller.plate.pos;
        take(p[0] - (mm[0] / 2 + 35) * MM, p[0] + (mm[0] / 2 + 35) * MM, p[1] - (mm[1] / 2 + 45) * MM, p[1] + (mm[1] / 2 + 35) * MM, (mm[2] + 28) * MM);
        // a damper actuator on a shaft that exits inside the enclosure
        if (shaftIn) take(S.x - 45 * MM, S.x + 45 * MM, S.y - 135 * MM, S.y + 45 * MM, reach + 40 * MM);
      }
      // never bigger than the geometry set's enclosure — except to house an actuating controller whole
      const grow = act && shaftIn;
      const x0 = grow ? box.x0 : Math.max(e.x0, box.x0), x1 = grow ? box.x1 : Math.min(e.x1, box.x1);
      const y0 = grow ? box.y0 : Math.max(e.y0, box.y0), y1 = grow ? box.y1 : Math.min(e.y1, box.y1);
      const dep = (grow ? Math.max(box.d, 2.5) : Math.min(Math.abs(e.zOut - e.zWall), Math.max(box.d, 2.5))) * IN;
      const X0 = A.lx(s, x0), X1 = A.lx(s, x1), xc = (X0 + X1) / 2, len = X1 - X0;
      const Y0 = y0 * IN, Y1 = y1 * IN, yc = (Y0 + Y1) / 2, hgt = Y1 - Y0;
      const zW = e.zWall * IN, side = e.side, zO = zW + side * dep, zc = (zW + zO) / 2;
      this.encBox = { x0, x1, y0, y1, zOut: zO / IN };
      const pick = { title: 'Controls enclosure', points: [A.dmpCmd, A.flowS].filter(Boolean) };
      if (!full) {
        const m = mergeStatic(g, V.galv, [boxGeo(len, hgt, dep, xc, yc, zc)], { name: 'enclosure' });
        m.userData.pick = pick;
        return;
      }
      const T2 = 0.0012, lip = 0.012;
      const walls = [
        boxGeo(len, T2, dep, xc, Y0 + T2 / 2, zc), boxGeo(len, T2, dep, xc, Y1 - T2 / 2, zc),
        boxGeo(T2, hgt, dep, X0 + T2 / 2, yc, zc), boxGeo(T2, hgt, dep, X1 - T2 / 2, yc, zc),
        boxGeo(len, hgt, T2, xc, yc, zW + side * T2 / 2),                                        // back plate on the casing
        // return lips round the open face
        boxGeo(len, lip, T2, xc, Y0 + lip / 2, zO - side * T2 / 2), boxGeo(len, lip, T2, xc, Y1 - lip / 2, zO - side * T2 / 2),
        boxGeo(lip, hgt, T2, X0 + lip / 2, yc, zO - side * T2 / 2), boxGeo(lip, hgt, T2, X1 - lip / 2, yc, zO - side * T2 / 2),
      ];
      const em = mergeStatic(g, V.galv, walls, { name: 'enclosure' });
      em.userData.pick = pick;
      // knockout + conduit connector + a stub of EMT on top (where the power and the bus come in)
      const kx = X1 - Math.min(0.05, len * 0.25), kz = zc;
      const fit = mergeStatic(g, V.steel, [cylGeo(0.014, 0.008, 'y', kx, Y1 + 0.004, kz, 16), cylGeo(0.011, 0.02, 'y', kx, Y1 + 0.018, kz, 16), cylGeo(0.009, 0.055, 'y', kx, Y1 + 0.0555, kz, 14)], { name: 'conduit' });
      fit.userData.pick = pick;
      const L2 = [];
      const bx = (ax0, ax1, ay0, ay1, az0, az1) => {
        const c = [[ax0, ay0, az0], [ax1, ay0, az0], [ax1, ay1, az0], [ax0, ay1, az0], [ax0, ay0, az1], [ax1, ay0, az1], [ax1, ay1, az1], [ax0, ay1, az1]];
        for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) L2.push(...c[i], ...c[j]);
      };
      bx(X0, X1, Y0, Y1, Math.min(zW, zO), Math.max(zW, zO));
      const ls = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(L2, 3)), this.m.outline || this.m.edge);
      g.add(ls);
      if (t.enclosure.style === 'closed') { g.add(new THREE.Mesh(boxGeo(len, hgt, T2, xc, yc, zO), V.galv)); return; }
      // the cover: folded on all four edges, two captive screws, a label plate; hinged at the bottom, hanging open
      const lid = new THREE.Group();
      lid.position.set(xc, Y0, zO);
      const fold = lip * 1.2;
      const cg = [
        boxGeo(len + 0.004, hgt + 0.004, T2, 0, hgt / 2, 0),
        boxGeo(len + 0.004, T2, fold, 0, T2 / 2, -side * fold / 2), boxGeo(len + 0.004, T2, fold, 0, hgt - T2 / 2, -side * fold / 2),
        boxGeo(T2, hgt, fold, -len / 2, hgt / 2, -side * fold / 2), boxGeo(T2, hgt, fold, len / 2, hgt / 2, -side * fold / 2),
      ];
      const lm = mergeStatic(lid, V.galv, cg, { name: 'enclosure-cover' });
      lm.userData.pick = pick;
      for (const sx of [-1, 1]) lid.add(new THREE.Mesh(cylGeo(0.0055, 0.006, 'z', sx * len * 0.36, hgt - 0.016, side * 0.003, 12), V.steel));
      const label = new THREE.Mesh(boxGeo(Math.min(0.07, len * 0.4), 0.022, 0.0008, 0, hgt * 0.62, side * 0.0012), new THREE.MeshStandardMaterial({ color: '#d8dad6', roughness: 0.7, envMapIntensity: 0.2 }));
      lid.add(label);
      const LL = [];
      const lb = (ax0, ax1, ay0, ay1, az0, az1) => {
        const c = [[ax0, ay0, az0], [ax1, ay0, az0], [ax1, ay1, az0], [ax0, ay1, az0], [ax0, ay0, az1], [ax1, ay0, az1], [ax1, ay1, az1], [ax0, ay1, az1]];
        for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) LL.push(...c[i], ...c[j]);
      };
      lb(-len / 2, len / 2, 0, hgt, Math.min(0, -side * fold), Math.max(0, -side * fold));
      lid.add(new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(LL, 3)), this.m.outline || this.m.edge));
      // hinges at the bottom edge
      for (const sx of [-1, 1]) lid.add(new THREE.Mesh(cylGeo(0.004, 0.03, 'x', sx * len * 0.32, 0, 0, 10), V.steel));
      lid.rotation.x = side * 1.62;
      g.add(lid);
    }

    /**
     * The flow sensor's sensing tubes (the pressure-independent VAV photo): two
     * pickup fittings seated ON the inlet collar's surface (total pressure P1+
     * red, static P1− blue), the tubes leaving along the collar, stepping onto
     * the casing side, running flat on it with even-radius bends, clipped, and
     * entering the controller's P1+ / P1− ports square. Nothing passes through
     * the duct wall.
     */
    _vavTubes(inS, lx, dev) {
      const L = this.lay, fc = L.parts.find((p) => p.kind === 'flowcross'), V = this.m.vav;
      if (!fc || !dev.spec?.ports) return;
      const xc = lx(inS, (fc.x0 + fc.x1) / 2), yc = ((fc.y0 + fc.y1) / 2) * IN, zc = ((fc.z0 + fc.z1) / 2) * IN;
      const r = Math.min((fc.y1 - fc.y0), (fc.z1 - fc.z0)) / 2 * IN;
      const side = L.side || 1;
      const xFace = lx(inS, L.casingFace ?? fc.x1);
      const zWall = side * (L.W / 2) * IN;
      dev.group.updateMatrix();
      const q = new THREE.Quaternion().setFromRotationMatrix(dev.group.matrix);
      const g = new THREE.Group();
      g.name = 'vav-tubes';
      noFootprint(g);
      const R = 0.0032, off = 0.0045;                       // tube radius; the tube lies on the surface
      const ang = 0.55;                                     // pickups a little above the side of the collar, toward the controls
      const ny = Math.sin(ang), nz = side * Math.cos(ang);
      const clips = [];
      dev.spec.ports.slice(0, 2).forEach((port, k) => {
        const mat = k === 0 ? V.tubeRed : V.tubeBlue;
        const xk = xc + (k === 0 ? -0.016 : 0.016);
        // the pickup: a boss seated on the collar and a barbed elbow turned along the collar
        const base = new THREE.Vector3(xk, yc + ny * r, zc + nz * r);
        const nrm = new THREE.Vector3(0, ny, nz);
        const boss = new THREE.Mesh(cylGeo(0.006, 0.006, 'y', 0, 0, 0, 12), V.brass);
        boss.position.copy(base).addScaledVector(nrm, 0.003);
        boss.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), nrm);
        g.add(boss);
        const p0 = base.clone().addScaledVector(nrm, 0.009);                    // the elbow's outlet, just off the surface
        // the controller's port (tip) and the direction a tube must arrive along
        const tip = new THREE.Vector3(...port).multiplyScalar(0.001).applyMatrix4(dev.group.matrix);
        const pdir = (Math.abs(port[0]) > Math.abs(port[1]) ? new THREE.Vector3(Math.sign(port[0]), 0, 0) : new THREE.Vector3(0, Math.sign(port[1]) || -1, 0)).applyQuaternion(q).normalize();
        const appr = tip.clone().addScaledVector(pdir, 0.03);
        const zRun = zWall + side * (off + 0.002 + k * 0.0075);                 // flat on the casing side, side by side
        const yRun = Math.min(appr.y, yc - r * 0.2) - 0.02 - k * 0.0075;        // the run along the casing, below the port
        const pts = [
          p0,
          new THREE.Vector3(xk + (side > 0 ? 0 : 0), p0.y + 0.012, p0.z),                 // up off the elbow
          new THREE.Vector3(xFace - 0.03, p0.y + 0.012, p0.z),                          // along the collar
          new THREE.Vector3(xFace + 0.025, p0.y + 0.012, zRun),                         // onto the casing side
          new THREE.Vector3(xFace + 0.05, yRun, zRun),                                  // down the casing side
          new THREE.Vector3(appr.x, yRun, zRun),                                        // along under the controller
          new THREE.Vector3(appr.x, appr.y, appr.z + (zRun - appr.z) * 0.0),            // out to the port
          tip,
        ];
        const curve = rounded(pts, 0.022);
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, R, 8, false), mat);
        tube.castShadow = true;
        g.add(tube);
        clips.push([xFace + 0.12, yRun, zRun], [(xFace + appr.x) / 2 + 0.06, yRun, zRun]);
      });
      // clips: small black saddles over the run
      for (const [x, y, z] of clips) { const c = new THREE.Mesh(boxGeo(0.008, 0.014, 0.004, x, y, z + side * 0.004), this.m.vav.dark); g.add(c); }
      g.traverse((o) => { if (o.isMesh) o.userData.pick = { title: 'Flow sensor tubes (P1+ / P1−)', points: [this.vavSfx.flow].filter(Boolean) }; });
      inS.group.add(g);
      (this.parts.devices ||= []).push({ sfx: 'term.tubes', role: 'term.tubes', placeholder: true, group: g, objects: [g] });
    }

    /** A shaft-mounted placeholder: the body fixed to the casing, a clamp hub that turns with the blade. */
    _vavHub(s, hub, S, part, mat, pk) {
      const g = placeholder(s.group, placeholderMm(part, 'DXR2.E10PL'), hub, mat, part);
      g.traverse((o) => { if (o.isMesh) o.userData.pick = pk; });
      const clamp3 = noFootprint(new THREE.Mesh(cylGeo(0.012, 0.02, 'z', 0, 0, (S.zEnd - S.zc) * IN + 0.01 * S.dir, 12), this.m.vav.steel));
      S.pivot.add(clamp3);
      clamp3.userData.pick = pk;
      (this.parts.devices ||= []).push({ sfx: 'term.hub', role: 'term.hub', placeholder: true, group: g, objects: [g, clamp3] });
      return g;
    }

    // ---- values → targets ----------------------------------------------------

    _refreshExtra() {
      super._refreshExtra();
      const n = (s) => this._num(s);
      for (const h of this.vp.heaters) {
        const v = n(h.sfx);
        h.target = h.scr ? (fin(v) ? clamp(v / 100, 0, 1) : 0) : (v > 0 ? 1 : 0);
      }
      if (this.vp.backdraft) this.vp.backdraft.target = n('SF1.STS') > 0 && !(n('SF1.FLT') > 0) ? 1 : 0;
      const live = fin(n(this.vavSfx?.dmp));
      for (const b of this.vp.blades) b.mesh.material = live ? this.m.vav.blade : this.m.vav.ghost;
    }

    _frameParts(dt, now) {
      super._frameParts(dt, now);
      for (const h of this.vp.heaters) {
        h.level = damp(h.level, h.target, 2.2, dt);
        h.mat.emissiveIntensity = h.level * 1.4;
      }
      // section captions only while exploded; room walls fade when the camera is behind them
      const ex = (this.explode || 0) > 0.5;
      for (const c of this.vavCaps || []) c.visible = ex;
      if (this._cut && this.camera) {
        const cam = this._cut.g.worldToLocal(this.camera.position.clone());
        for (const w of this._cut.walls) {
          const behind = (w.axis === 'z' ? cam.z - w.at : cam.x - w.at) * w.sign > -0.05;
          w.k = damp(w.k, behind ? 0.05 : 1, 6, dt);
          w.mesh.material.opacity = w.k;
          w.mesh.material.depthWrite = w.k > 0.9;
          w.mesh.visible = w.k > 0.02;
        }
      }
      const bd = this.vp.backdraft;
      if (bd) {
        bd.open = damp(bd.open, bd.target, 3, dt);
        for (const p of bd.blades) p.rotation.x = bd.open * 1.1;
      }
    }

    /** Neutral temperatures unless PAT / DAT read live (no fabricated 55 °F). */
    _refreshAir() {
      const n = (s) => this._num(s);
      const pat = n('PAT'), dat = n('DAT'), znt = n('ZNT');
      const neutral = 72;
      this.vals = { oat: fin(pat) ? pat : fin(dat) ? dat : neutral, rat: fin(znt) ? znt : neutral };
      this.vals.mix = this.vals.oat;
      const st = [];
      const hs = this.sections.find((s) => s.kind === 'coil' || s.kind === 'heater');
      if (hs && fin(dat)) st.push({ x: hs.group.position.x + hs.w / 2, t: dat, sec: hs, dx: hs.w / 2 });
      const last = this.sections[this.sections.length - 1];
      const off = (this.diffX || 0) - last.baseX + 0.05;
      st.push({ x: last.group.position.x + off + 0.6, t: this.vals.rat, sec: last, dx: off + 0.6, dir: 1 + 0.9 });   // mixes in over ~2 m
      this.tempStations = st;
      this._coilPhysics(st);
      this.occOn = n('OCC') > 0;
      const leg = this.hudEl?.querySelector('.a3-legend span');
      if (leg) leg.textContent = fin(pat) || fin(dat) ? 'Air temp' : 'Air temp — not measured';
    }

    hasFault() {
      return super.hasFault() || this._num('EH.FLT') > 0;
    }

    /** The stream only while air is proven moving (vav-live.js); airflow3d.js scales it to the box. */
    _updateAir(dt, now) {
      if (!((this.flow || 0) > 0.02)) { if (this.air) this.air.points.visible = false; return; }
      super._updateAir(dt, now);
    }

    // ---- the stream: into the collar, through the box, over the ceiling, down the diffuser ----
    get airSpan() {
      const a = this.sections[0], b = this.sections[this.sections.length - 1];
      return [a.group.position.x - a.w / 2, b.group.position.x + b.w / 2];
    }

    _paths() {
      const L = this.lay;
      const first = this.sections[0], last = this.sections[this.sections.length - 1];
      const offA = first.group.position.x - first.baseX, offB = last.group.position.x - last.baseX;
      const i0 = L.inlets[0], o = L.outlet;
      const yI = (i0 ? i0.cy : L.H / 2) * IN, zI = (i0 ? i0.cz : 0) * IN, yO = (o.y0 + o.y1) / 2 * IN, zO = o.zc * IN;
      const start = [((i0 ? i0.x : L.bbox.x0) - 10) * IN + offA, yI, zI];
      // through the round collar (narrow), into the casing (full width), out the discharge
      const face = [(L.casingFace ?? (i0 ? i0.x : L.bbox.x0)) * IN + offA, yI, zI];
      const endBox = [this.unitEnd + offB, yO, zO];
      const kIn = i0 ? clamp(0.95 * Math.min(i0.w / L.W, i0.h / L.H), 0.2, 1) : 1;
      let pts;
      if (this.hasZone) {
        const dx = this.diffX + offB, H = this.roomH;
        // out of the diffuser the air hugs the ceiling, spreading sideways, then settles slowly into the room
        // along the duct, down the neck, out of the diffuser along the ceiling (Coanda), then settling
        const zD = this.diffZ ?? zO;
        pts = [start, face, endBox, [dx, yO, zD], [dx, -0.1, zD], [dx + 1.3, -0.18, zD + 0.1], [Math.max(dx + 1.9, this.roomX1 - 0.35), -0.6, zD + 0.2]];
        // a thin sheet under the ceiling that widens sideways (never up through the ceiling)
        pts.k = [kIn, 1, 0.75, 0.55, [1, 0.35, 4], [1, 0.6, 4.5]];
        pts.fadeEnd = 1.8;                   // dissipating into the room
        pts.taper = true;
        void H;
      } else {
        pts = [start, face, endBox, [endBox[0] + 0.6, yO, zO]];
        pts.k = [kIn, 1, 0.9];
      }
      pts.vw = 0.2;
      return finish({ oa: pts });
    }

    // ---- camera presets: the box, its controls, the room ----
    _presetView(name, instant = false) {
      const L = this.lay, v = this.vavSize || { len: 0.6, wid: 0.4, ht: 0.3 };
      const lift = this.unit ? this.unit.position.y : this.roomH;
      const aspect = this.camera?.aspect || 1.6;
      const fitW = aspect < 1 ? 1 / Math.max(0.45, aspect) : 1;
      if (this.embedded || !this.camera) return super._presetView(name, instant);
      const sz = L.side > 0 ? 1 : -1;
      if (name === 'overview') {
        // the box, its duct and the diffuser, from the controls side and above
        const xa = L.bbox.x0 * IN - 0.3, xb = this.hasZone ? (this.diffX || 0) + 1.2 : L.bbox.x1 * IN + 0.4;
        const tgt = new THREE.Vector3((xa + xb) / 2, lift - (this.hasZone ? 0.25 : -v.ht / 2), 0);
        const dist = clamp(1.25 * (xb - xa) + 1.6, 2.2, 8) * fitW;
        const dir = new THREE.Vector3(-0.42, 0.42, 0.8 * sz).normalize();
        return this._tween(name, tgt, tgt.clone().addScaledVector(dir, dist), instant);
      }
      if (name === 'zone' && this.hasZone) {
        // the room from its open front: the diffuser, the air along the ceiling, the room unit
        const dx = this.diffX || 0, tx = Math.min(dx + 1.4, this.roomX1 - 0.45), xm = (dx + tx) / 2;
        const tgt = new THREE.Vector3(xm, lift * 0.48, -this.roomD * 0.15);
        return this._tween(name, tgt, new THREE.Vector3(xm - 0.8, lift * 0.88, this.roomD / 2 + 3.2), instant);
      }
      if (name === 'controls') {
        const S = L.shafts[0], e = L.enclosures[0];
        const inS = this.sections.find((s) => s.kind === 'inlet');
        const off = inS ? inS.group.position.x - inS.baseX : 0;
        const p = S ? [S.x, S.y, S.zEnd] : e ? [(e.x0 + e.x1) / 2, L.H / 2, e.zOut] : [0, L.H / 2, L.side * L.W / 2];
        const tgt = new THREE.Vector3(p[0] * IN + off, lift + p[1] * IN, p[2] * IN);
        const dist = clamp(1.4 * Math.max(v.ht, 0.3), 0.5, 1.2) * fitW;
        const cam = tgt.clone().add(new THREE.Vector3(-0.45 * dist, 0.5 * dist, L.side * 0.85 * dist));
        return this._tween(name, tgt, cam, instant);
      }
      const box = name === 'unit';
      const tgt = new THREE.Vector3(box ? 0 : 0.6, box ? lift + v.ht / 2 : lift * 0.62, 0);
      const dist = (box ? clamp(2.4 * Math.max(v.len, v.wid, v.ht) + 0.5, 1.4, 3.6) : clamp(3.4 * Math.max(v.len, v.wid, v.ht) + 1.6, 3, 7)) * fitW;
      // the box from the controls side, a little above: through the clear casing and into the open enclosure
      const dir = new THREE.Vector3(-0.38, box ? 0.52 : 0.36, L.side > 0 ? 0.76 : -0.76).normalize();
      return this._tween(name, tgt, tgt.clone().addScaledVector(dir, dist), instant);
    }

    _kpiDefs() {
      const has = this.has;
      const sp = ['VAV.FLOW.SP'].find((x) => has(x));
      const spU = this.config?.supply?.find((x) => x.device === 'vavinlet')?.flowSpUnits === '%' ? '%' : 'cfm';
      return [['ZNT', 'Room', '°F'], ['ZNSP', 'Setpoint', '°F'], [this.vavSfx?.flow, 'Airflow', 'cfm'], [sp, 'Flow SP', spU], [this.vavSfx?.dmp, 'Damper', '%'], ['DAT', 'Discharge', '°F']];
    }

    _modeDefs() {
      return [['OCC', 'Occupied'], [this.has('SF1.STS') ? 'SF1.STS' : null, 'Fan'], ['SF1.FLT', 'Fan fault', 1], ['EH.FLT', 'Heater fault', 1]];
    }

    _hudValues() {
      for (const k of this.kpis || []) {
        const v = this._num(k.sfx);
        const p = this.resolve(k.sfx);
        const txt = !fin(v) ? (p?.label || '--') : k.unit === 'cfm' ? `${Math.round(v).toLocaleString('en-US')} cfm` : k.unit === '%' ? `${Math.round(v)}%` : `${v.toFixed(1)} ${k.unit}`;
        k.el.textContent = txt;
        k.el.parentElement.classList.toggle('a3-notlive', !fin(v)); k.el.parentElement.dataset.st = !fin(v) ? (p?.status || '') : '';
      }
      if (this.honestyEl) {
        const n = this.playback ? 0 : new Set(this.tags.filter((t) => t.row.classList.contains('a3-notlive')).map((t) => t.sfx)).size;
        this.honestyEl.hidden = !n;
        this.honestyEl.textContent = n ? `${n} point${n === 1 ? '' : 's'} not live` : '';
      }
      for (const m of this.modes || []) m.el.classList.toggle('on', this._num(m.sfx) > 0);
    }
  };
}
