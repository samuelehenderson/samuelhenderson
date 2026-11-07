/**
 * equip3d.js — a 3D view for every equipment type, built on the air handler.
 *
 * Ahu3DView (ahu3d.js) owns the scene, the HUD, readouts, picking, trend
 * replay, quality tiers and the air streams (airflow3d.js). Each family below only
 * decides what gets built and how the stream moves through it:
 *
 *   Terminal3DView  VAV and FCU: a ceiling terminal — inlet, damper, filter,
 *                   coils, fan — discharging through a diffuser into the room
 *                   it serves, with the zone thermostat on the wall.
 *   Eru3DView       energy recovery unit: supply deck below, exhaust deck
 *                   above, the recovery wheel turning through both.
 *   Hx3DView        plate heat exchanger on a skid: primary control valve,
 *                   the plate pack, the secondary pump, two water loops.
 *   Boiler3DView    boiler on a skid: return pump, the vessel with its burner
 *                   flame and fire-tube coil, flue stack, supply header.
 *   AirChiller3DView        air-cooled chiller: V-coil condenser under a deck
 *                           of fans, scroll compressors in tandem per circuit,
 *                           the shell-and-tube evaporator, control panel.
 *   Booster3DView   chilled-water booster pumps: end-suction pumps between suction and
 *                   discharge headers, suction diffusers, triple-duty valves, VFDs.
 *   Tower3DView     multi-cell induced-draft cooling tower (the user's photo): panelised
 *                   casing on the basin, air-inlet louvres along both sides, fan deck
 *                   with handrail and caged ladder, per cell a fan stack with guard,
 *                   fan and the drive on its bridge.
 *   CentrifugalChiller3DView water-cooled centrifugal: evaporator and
 *                           condenser shells side by side between tube sheets,
 *                           waterboxes and nozzles, the compressor volute and
 *                           hermetic motor on top, suction and discharge
 *                           connections, economizer, starter and panel.
 *
 * AHU and CRAC keep the full air handler (Ahu3DView itself).
 *
 * Same honesty rules as the air handler: a point that is not live resolves
 * with a null value, its readout says why, and the part it drives rests —
 * wheels and pumps stop, valves close, the flame goes out.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { installSiemens } from './siemens-view.js';
import { Ahu3DView } from './ahu3d.js';
import { Rtu3DView } from './rtu3d.js';
import { ahuInventory, runSuffix, resolveSuffix } from './inventory.js';
import { viewFamily, kindOf } from '../ahu3d-bridge.js';
import { vavViewClass } from './vav3d.js';
import { vavFlowTarget } from '../vav/vav-live.js';
import { wallViewClasses } from './panel3d.js'; // P2 PANELS
import { hhwViewClass } from './hhw3d.js'; // P5 HX
import { isHhw } from '../hx/hhw.js'; // P5 HX

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const pick = (has, cands) => cands.find((s) => s && has(s)) || null;
const fin = Number.isFinite;

/** Is WebGL available here? */
export function webglOk() { return Ahu3DView.webglOk(); }

/** Does this EF config name one of the standalone fan shapes? */
export function efShaped(config) {
  const secs = (config && config.supply) || [];
  return secs.some((s) => s.device === 'fan' && (s.fanType === 'mixed-flow' || s.fanType === 'utility-set'))
    || secs.some((s) => s.device === 'stack');
}

/**
 * The right 3D view for a unit config.
 * @param {object} config  unit config (equipment-defaults.js shape)
 * @param {{title?:string, rhAfterFans?:boolean}} opts
 */
export function createView(config, { title = '', rhAfterFans = true } = {}) {
  const kind = kindOf(config);
  const fam = viewFamily(config);
  if (fam === 'terminal') return config?.kind === 'vav' ? new Vav3DView({ title, config, kind }) : new Terminal3DView({ title, config, kind });
  if (fam === 'eru') return new Eru3DView({ title, config, kind });
  if (fam === 'wall') return kind === 'vfd' ? new Vfd3DView({ title, config, kind }) : new Panel3DView({ title, config, kind }); // P2 PANELS
  if (fam === 'plant') {
    if (kind === 'hx' && isHhw(config)) return new Hhw3DView({ title, config, kind }); // P5 HX: heating hot water plant
    if (kind === 'tower') return new Tower3DView({ title, config, kind });
    if (kind === 'booster') return new Booster3DView({ title, config, kind });
    if (kind === 'chiller-ac') return new AirChiller3DView({ title, config, kind });
    if (kind === 'chiller-wc') return new CentrifugalChiller3DView({ title, config, kind });
    return kind === 'boiler' ? new Boiler3DView({ title, config, kind }) : new Hx3DView({ title, config, kind });
  }
  // An exhaust fan that says what shape it is gets drawn as that fan. One that
  // does not keeps the casing it has always had — an EF saved before these
  // shapes existed is never silently redrawn, the same rule VAVs follow.
  if (kind === 'ef' && efShaped(config)) return new Fan3DView({ title, config, kind });
  // a rooftop unit is an air handler with a condensing section (rtu3d.js)
  if (kind === 'ahu' && config?.form === 'rtu') return new Rtu3DView({ title, rhAfterFans, kind, config });
  return new Ahu3DView({ title, rhAfterFans, kind, config, eyebrow: kind === 'crac' ? 'Computer room AC' : kind === 'ef' ? 'Exhaust fan' : 'Air handling unit' });
}

/** Polylines → the {pts, seg, L, vw, legT, k} shape the air stream (airflow3d.js) reads. */
function finish(raw) {
  const out = {};
  for (const k of Object.keys(raw)) {
    const pts = raw[k];
    if (!pts) continue;
    let len = 0;
    const seg = [];
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
      seg.push(l); len += l;
    }
    out[k] = { pts, seg, L: len, vw: pts.vw || 0.8, oaLegs: pts.oaLegs || 0, retLegs: pts.retLegs || 0, legT: pts.legT || null, k: pts.k || null, water: pts.water, widthK: pts.widthK || 1, fadeEnd: pts.fadeEnd || 0, streakK: pts.streakK || 0, haze: pts.haze, taper: !!pts.taper, kEnd: pts.kEnd || 0 };
  }
  return out;
}

/** Filters the way the air handler reads them: PFIL / FFIL / AFIL, or one FLT. */
function filterList(has, inv) {
  const out = [];
  for (const b of ['PFIL', 'FFIL', 'AFIL']) {
    if (has(`${b}.ALM`) || has(b)) out.push({ alm: has(`${b}.ALM`) ? `${b}.ALM` : null, dp: has(b) ? b : null, cap: b[0] === 'P' ? 'PRE-FILTER' : b[0] === 'F' ? 'FINAL FILTER' : 'AFTER-FILTER' });
  }
  if (!out.length && inv.hasFilter) out.push({ alm: inv.fAlm, dp: inv.fDp, cap: 'FILTER' });
  return out;
}

/** Fans that exist in the config (the inventory pads a missing fan with SF1). */
const realFans = (has, bases) => bases.filter((b) => ['STS', 'SS', 'SVD', 'ENA', 'EN', 'VFD', 'PRF', 'RUN'].some((r) => has(`${b}.${r}`)));

// ---------------------------------------------------------------------------
// Shared plumbing for the families: section layout, camera moves, and the
// parts the air handler doesn't have (wheels, pumps, control valves, burners).
// ---------------------------------------------------------------------------

class Family3DView extends Ahu3DView {
  constructor(opts) {
    super(opts);
    this.hasLayoutOptions = false;
    this.airNeck = null;           // no duct-stub neck: terminals spread into the room, plant carries water
  }

  /** New unit group, sections laid out left to right in flow order. */
  _layRow(secs, { y = 0, cabinet = true } = {}) {
    let x = 0;
    for (const s of secs) { s.x0 = x; x += s.w; }
    const total = x;
    secs.forEach((s, i) => {
      s.i = i;
      s.baseX = -total / 2 + s.x0 + s.w / 2;
      s.group = new THREE.Group();
      s.group.position.set(s.baseX, y, 0);
      this.unit.add(s.group);
      s.open = new Set(s.open || []);
      if (cabinet && s.cabinet !== false) this._cabinet(s.group, s.w, this.DH, s);
    });
    return total;
  }

  _newUnit() {
    const unit = new THREE.Group();
    this.scene.add(unit);
    this.coilPorts = [];
    this.unit = unit;
    this.mixSec = null; this.econSec = null; this.retMod = null;
    return unit;
  }

  /** Fly the camera to a target (the tail of the air handler's presets). */
  _tween(name, tgt, cam, instant) {
    this.view = name;
    if (instant) {
      this.camera.position.copy(cam);
      this.controls.target.copy(tgt);
      this.camera.lookAt(tgt);
      this._pendingTarget = tgt;
      return;
    }
    this._camTween = { k: 0, p0: this.camera.position.clone(), p1: cam, t0: this.controls.target.clone(), t1: tgt };
  }

  _sec(kind) { return this.sections.find((s) => s.kind === kind) || null; }

  /** A straight pipe between two points (unit-local to `g`). */
  _pipe(g, a, b, r, mat) {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const len = va.distanceTo(vb);
    if (len < 1e-4) return null;
    const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14), mat);
    p.position.copy(va).lerp(vb, 0.5);
    p.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    p.castShadow = true;
    g.add(p);
    return p;
  }

  /**
   * Inline pump: volute facing the viewer with a glass face so the impeller
   * shows, motor behind it, a status band that lights with speed.
   */
  _pump(g, base, pos, title) {
    const has = this.has;
    const m = this.m;
    const pg = new THREE.Group();
    pg.position.set(...pos);
    g.add(pg);
    const casing = new THREE.MeshStandardMaterial({ color: '#2f6f8f', metalness: 0.55, roughness: 0.4 });
    const vol = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.16, 32), casing);
    vol.rotation.x = Math.PI / 2;
    vol.castShadow = true;
    pg.add(vol);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.17, 32), m.glass.clone());
    face.material.opacity = 0.18;
    face.position.z = 0.081;
    pg.add(face);
    const imp = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const piv = new THREE.Group();
      piv.rotation.z = (i * Math.PI) / 3;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.13, 0.1), m.blade);
      b.position.y = 0.07;
      b.rotation.z = 0.5;
      piv.add(b);
      imp.add(piv);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 12), m.brass);
    hub.rotation.x = Math.PI / 2;
    imp.add(hub);
    imp.position.z = 0.02;
    pg.add(imp);
    const mot = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.32, 24), m.dark);
    mot.rotation.x = Math.PI / 2;
    mot.position.z = -0.26;
    pg.add(mot);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.03, 24),
      new THREE.MeshStandardMaterial({ color: '#46d3e6', emissive: '#46d3e6', emissiveIntensity: 0 }));
    band.rotation.x = Math.PI / 2;
    band.position.z = -0.13;
    pg.add(band);
    const run = runSuffix(has, base);
    const spd = resolveSuffix(has, base, 'speed');
    const flt = resolveSuffix(has, base, 'fault');
    const cmd = resolveSuffix(has, base, 'command');
    this.parts.pumps.push({ run, spd, flt, imp, band, speed: 0 });
    pg.userData.pick = { title, points: [...new Set([cmd, spd, run, flt].filter((s) => s && has(s)))] };
    for (const sfx of [cmd, spd, run]) if (sfx && has(sfx)) this.anchors.set(sfx, pg);
    for (const sfx of [run, spd, flt]) if (sfx && has(sfx)) this._bind(sfx);
    return pg;
  }

  /** Globe control valve on a pipe: the stem rises with the valve position. */
  _cvalve(g, suffix, pos, title) {
    const m = this.m;
    const vg = new THREE.Group();
    vg.position.set(...pos);
    g.add(vg);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.095, 18, 14), m.brass);
    body.castShadow = true;
    vg.add(body);
    const bonnet = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.12, 14), m.steel);
    bonnet.position.y = 0.12;
    vg.add(bonnet);
    const yoke = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.03), m.rail);
    yoke.position.y = 0.23;
    vg.add(yoke);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 8), m.steel);
    const y0 = 0.25;
    stem.position.y = y0;
    vg.add(stem);
    const act = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.12, 20), m.dark);
    act.position.y = 0.38;
    vg.add(act);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.087, 0.008, 6, 24),
      new THREE.MeshStandardMaterial({ color: '#46d3e6', emissive: '#46d3e6', emissiveIntensity: 0 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.33;
    vg.add(ring);
    this.parts.cvalves.push({ suffix, stem, y0, ring, pct: 0 });
    vg.userData.pick = { title, points: [suffix].filter((s) => s && this.has(s)) };
    if (suffix && this.has(suffix)) { this.anchors.set(suffix, vg); this._bind(suffix); }
    return vg;
  }

  /** A steel skid plate under one section of plant equipment. */
  _skid(g, w) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w - 0.04, 0.06, this.D), this.m.floor);
    plate.position.y = 0.03;
    plate.receiveShadow = true;
    g.add(plate);
    for (const sz of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(w - 0.04, 0.08, 0.06), this.m.rail);
      rail.position.set(0, 0.04, sz * (this.D / 2 - 0.03));
      g.add(rail);
    }
  }

  // wheels, pumps, valves, burners: targets from the points (not live → rest)
  _refreshExtra() {
    const n = (s) => this._num(s);
    const runOf = (p) => {
      const run = n(p.run);
      const spd = p.spd ? n(p.spd) : NaN;
      const on = p.run === p.spd ? spd > 0 : run > 0;
      p.fault = p.flt ? n(p.flt) > 0 : false;
      return on && !p.fault ? (fin(spd) ? clamp(spd, 5, 100) : 100) : 0;
    };
    for (const w of this.parts.wheels) w.target = runOf(w);
    for (const p of this.parts.pumps) p.target = runOf(p);
    for (const v of this.parts.cvalves) v.target = clamp(n(v.suffix) || 0, 0, 100);
    for (const b of this.parts.burners) {
      const fire = b.fire ? n(b.fire) : NaN;
      const on = b.run ? n(b.run) > 0 : fin(fire) && fire > 0;
      b.fault = b.flt ? n(b.flt) > 0 : false;
      b.target = !on || b.fault ? 0 : fin(fire) ? clamp(fire, 0, 100) / 100 : 0.6;
    }
  }

  _frameParts(dt, now) {
    for (const w of this.parts.wheels) {
      w.speed = damp(w.speed, w.target ?? 0, 1.2, dt);
      // a recovery wheel turns slowly: ~20 rpm at full speed
      w.rotor.rotation.x += dt * (w.speed / 100) * Math.PI * 2 * 0.35;
      w.mat.emissive.set(w.fault ? '#ff3b2a' : '#46d3e6');
      w.mat.emissiveIntensity = w.fault ? 0.35 + 0.3 * Math.sin(now / 220) : (w.speed / 100) * 0.12;
    }
    for (const p of this.parts.pumps) {
      p.speed = damp(p.speed, p.target ?? 0, 1.6, dt);
      p.imp.rotation.z -= dt * (p.speed / 100) * Math.PI * 2 * 4;
      p.band.material.emissive.set(p.fault ? '#ff3b2a' : '#46d3e6');
      p.band.material.emissiveIntensity = p.fault ? 2 : (p.speed / 100) * 2.2;
    }
    for (const v of this.parts.cvalves) {
      v.pct = damp(v.pct, v.target ?? 0, 2.5, dt);
      v.stem.position.y = v.y0 + 0.07 * (v.pct / 100);
      v.ring.material.emissiveIntensity = (v.pct / 100) * 1.8;
    }
    for (const b of this.parts.burners) {
      b.level = damp(b.level, b.target ?? 0, 1.8, dt);
      const flick = 0.92 + 0.08 * Math.sin(now / 53) * Math.sin(now / 91);
      const k = b.level;
      b.flame.visible = k > 0.02;
      b.flame.scale.set(0.45 + 0.55 * k, (0.25 + 0.75 * k) * flick, 0.45 + 0.55 * k);
      b.flameMat.opacity = 0.3 + 0.55 * k;
      b.light.intensity = k * 7 * flick;
      b.coilMat.emissiveIntensity = k * 0.9;
      b.led.material.emissive.set(b.fault ? '#ff3b2a' : b.target > 0 ? '#3fe08a' : '#34444e');
      b.led.material.emissiveIntensity = b.fault ? 1.4 + Math.sin(now / 200) : 1.2;
    }
  }
}

// ---------------------------------------------------------------------------
// VAV / FCU: a ceiling terminal and the room it serves
// ---------------------------------------------------------------------------

export class Terminal3DView extends Family3DView {
  constructor(opts) {
    const vav = opts.kind === 'vav';
    super({
      ...opts,
      size: vav ? { h: 0.9, d: 1.1 } : { h: 1.1, d: 1.3 },
      eyebrow: vav ? 'VAV terminal' : 'Fan coil unit',
      presets: [['overview', 'Overview'], ['unit', 'Unit'], ['zone', 'Room']]
    });
    this.vav = vav;
    this.roomH = 2.6;               // floor to ceiling; the terminal sits above it
    this.roomD = this.D + 1.8;
  }

  _zoneCfg() { return (this.config?.supply || []).find((x) => x.device === 'zone') || null; }

  _buildUnit() {
    const has = this.has;
    const inv = ahuInventory(has);
    const fans = realFans(has, inv.fans);
    this.inv = { ...inv, fans, hasRet: false, rad: null, ead: null };
    const unit = this._newUnit();
    const secs = [];
    secs.push({ kind: 'tin', w: 0.7, cap: this.vav ? 'PRIMARY AIR' : 'ENTERING AIR' });
    for (const f of filterList(has, inv)) secs.push({ kind: 'filter', w: 0.45, cap: f.cap === 'FILTER' ? 'FILTER' : f.cap, f });
    const ct = { ph: pick(has, ['PHT', 'PHCT']), cc: pick(has, ['CCT']), rh: pick(has, ['RHT']) };
    const heatCap = this.vav ? 'REHEAT' : 'HEATING';
    if (inv.ph) secs.push({ kind: 'coil', w: 0.55, cap: inv.cc ? 'PREHEAT' : heatCap, v: inv.ph, heat: true, t: ct.ph });
    if (inv.cc) secs.push({ kind: 'coil', w: 0.6, cap: 'COOLING', v: inv.cc, heat: false, t: ct.cc });
    if (inv.rh) secs.push({ kind: 'coil', w: 0.55, cap: heatCap, v: inv.rh, heat: true, t: ct.rh });
    if (fans.length) secs.push({ kind: 'fans', w: 1.0, cap: fans.length > 1 ? 'FANS' : 'FAN' });
    secs.push({ kind: 'discharge', w: 0.6, cap: 'DISCHARGE' });
    // discharge temperature: SAT/DAT, else whatever leaves the last coil
    const coils = secs.filter((s) => s.kind === 'coil');
    this.datSfx = pick(has, ['SAT', 'DAT']) || coils[coils.length - 1]?.t || null;
    // The terminal hangs above the ceiling of the room it serves. The room is
    // part of the building, not of the unit, so it stays put when exploded.
    const unitW = secs.reduce((a, s) => a + s.w, 0);
    const pre = 0.5, beyond = 2.8;
    this.total = pre + unitW + beyond;
    this.roomX0 = -this.total / 2;
    this.roomX1 = this.total / 2;
    let x = this.roomX0 + pre;
    secs.forEach((s, i) => {
      s.i = i;
      s.baseX = x + s.w / 2;
      x += s.w;
      s.group = new THREE.Group();
      s.group.position.x = s.baseX;
      unit.add(s.group);
      s.open = new Set();
      this._cabinet(s.group, s.w, this.DH, s);
    });
    this.unitEnd = x;
    this.diffX = this.unitEnd + 0.8;
    this.sections = secs;
    // the primary-air inlet collar (see _duct): its outer face, centre and size,
    // in the unit's own frame — a building's ductwork connects exactly here
    const tin = secs[0], collar = Math.min(0.55, this.DH * 0.35);
    this.inletLocal = { x: tin.baseX - tin.w / 2 - collar, y: this.DH / 2, z: 0, w: this.D * 0.7, h: this.DH * 0.7 };
    for (const s of secs) { this._fillTerminal(s); this._sectionTag(s); }
    // in a building (embedded) the room is the building's floor, not ours
    if (!this.embedded) this._room();
    unit.position.y = this.roomH;
    this.foot = { zMin: -this.roomD / 2, zMax: this.roomD / 2 };
  }

  _fillTerminal(s) {
    const g = s.group, has = this.has, H = this.DH, Z = this.D / 2;
    if (s.kind === 'tin') {
      this._duct(g, -s.w / 2, H, -1);
      if (this.inv.oad) {
        const dm = this._damper(this.inv.oad, this.D - 0.2, H - 0.2, 5);
        dm.position.set(0, H / 2, 0);
        g.add(dm);
      }
      this._tag(g, [-s.w / 2 - 0.3, H + 0.35, Z], [['OAT', this.vav ? 'PRI TMP' : 'ENT TMP', '°F'],
        [this.inv.oad, this.vav ? 'DAMPER' : 'OA DMP', '%'], [pick(has, ['OA.CFM']), 'FLOW', 'cfm']]);
    } else if (s.kind === 'discharge') {
      this._tag(g, [0.1, H + 0.35, Z], [[this.datSfx, 'DA TMP', '°F'], [pick(has, ['SA.CFM', 'SA.FLW']), 'AIRFLOW', 'cfm'],
        [pick(has, ['SSP', 'DSP']), 'STATIC', 'inWC']]);
    } else {
      super._fill(s);    // filter, coil (with its valve), fans — same parts as the air handler
    }
  }

  /** The room below the ceiling: duct run, diffuser, thermostat, occupant. */
  _room() {
    const m = this.m, has = this.has;
    const g = new THREE.Group();
    this.unit.add(g);
    const W = this.roomX1 - this.roomX0, H = this.roomH, Dr = this.roomD, h = this.DH;
    const wall = new THREE.MeshStandardMaterial({ color: '#1a2229', metalness: 0.1, roughness: 0.9, side: THREE.DoubleSide });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.05, Dr), m.floor);
    floor.position.y = -H + 0.025;
    floor.receiveShadow = true;
    g.add(floor);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wall);
    back.position.set(0, -H / 2, -Dr / 2);
    back.receiveShadow = true;
    g.add(back);
    const side = new THREE.Mesh(new THREE.PlaneGeometry(Dr, H), wall);
    side.rotation.y = -Math.PI / 2;
    side.position.set(W / 2, -H / 2, 0);
    g.add(side);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, Dr), m.glass.clone());
    ceil.rotation.x = -Math.PI / 2;
    ceil.position.y = -0.01;
    g.add(ceil);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, Dr)), m.edge);
    edges.position.y = -H / 2;
    g.add(edges);
    // supply duct above the ceiling, a drop, and a four-way diffuser
    const dx = this.diffX, runL = dx - this.unitEnd + 0.2;
    const run = new THREE.Mesh(new THREE.BoxGeometry(runL, h * 0.55, this.D * 0.55), m.glass.clone());
    run.position.set(this.unitEnd + runL / 2, h / 2, 0);
    g.add(run);
    const drop = new THREE.Mesh(new THREE.BoxGeometry(0.4, h / 2, 0.4), m.glass.clone());
    drop.position.set(dx, h / 4, 0);
    g.add(drop);
    for (const b of [run, drop]) {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(b.geometry), m.edge);
      e.position.copy(b.position);
      g.add(e);
    }
    const diff = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.03, 0.62), m.steel);
    diff.position.set(dx, -0.025, 0);
    g.add(diff);
    for (let i = 0; i < 3; i++) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.46 - i * 0.14, 0.032, 0.46 - i * 0.14), m.dark);
      slot.position.set(dx, -0.028, 0);
      slot.scale.y = 1 + i * 0.1;
      g.add(slot);
    }
    // thermostat on the back wall, with the zone readout above it
    const tx = Math.min(dx + 1.4, this.roomX1 - 0.45), ty = -H + 1.5;
    this._thermostat(g, tx, ty, -Dr / 2);
    // an occupant, shown only while occupancy reads live and on
    const person = new THREE.Group();
    const pm = new THREE.MeshStandardMaterial({ color: '#6f8796', metalness: 0.1, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.85, 4, 12), pm);
    body.position.y = 0.6;
    body.castShadow = true;
    person.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), pm);
    head.position.y = 1.36;
    head.castShadow = true;
    person.add(head);
    person.position.set(Math.min(dx + 0.7, this.roomX1 - 0.6), -H + 0.05, 0.35);
    person.visible = false;
    g.add(person);
    this.person = person;
    const cap = this._label((this._zoneCfg()?.label || 'Zone').toUpperCase(), 'a3-sec');
    cap.position.set((dx + this.roomX1) / 2, -H + 0.04, Dr / 2 + 0.2);
    g.add(cap);
  }

  /** The wall unit on the room's back wall (zWall), with the zone readout above it. */
  _thermostat(g, tx, ty, zWall) {
    const m = this.m, has = this.has;
    const stat = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.035), m.dark);
    stat.position.set(tx, ty, zWall + 0.02);
    g.add(stat);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.085, 0.06),
      new THREE.MeshStandardMaterial({ color: '#0b1116', emissive: '#46d3e6', emissiveIntensity: 0.8 }));
    screen.position.set(tx, ty + 0.03, zWall + 0.039);
    g.add(screen);
    stat.userData.pick = { title: 'Thermostat', points: ['ZNSP.CMD', 'MODE.CMD', 'OCC'].filter((x) => has(x)) };
    if (!stat.userData.pick.points.length) stat.userData.pick.points = ['ZNSP', 'MODE'].filter((x) => has(x));
    const z = this._zoneCfg();
    this._tag(g, [tx, ty + 0.55, zWall + 0.15], [
      ['ZNT', z?.tempLabel ? z.tempLabel.replace(/\s*°F/, '').toUpperCase() : 'ROOM TMP', '°F'],
      ['ZNSP', 'SETPOINT', '°F', null, 'ZNSP.CMD'],
      ['MODE', 'MODE', 'state', z?.modeStates || null, 'MODE.CMD'],
      ['OCC', 'OCCUPIED', 'onoff'], ['CO2', 'CO2', 'ppm'], ['ZNH', 'ROOM RH', '%']]);
    for (const sfx of ['ZNT', 'ZNSP', 'MODE']) if (has(sfx)) this.anchors.set(sfx, stat);
    return stat;
  }

  // the stream: through the unit, over the ceiling, down the diffuser, into the room
  get airSpan() {
    const secs = this.sections;
    const d = secs[secs.length - 1];
    return [secs[0].group.position.x - secs[0].w / 2, d.group.position.x + d.w / 2];
  }

  _paths() {
    const secs = this.sections;
    const d = secs[secs.length - 1];
    const first = secs[0].group.position.x - secs[0].w / 2;
    // the diffuser keeps its distance from the discharge (exploded or not)
    const dx = d.group.position.x + d.w / 2 + (this.diffX - this.unitEnd);
    const y = this.DH / 2, H = this.roomH;
    // down the drop, then along the ceiling (spreading sideways) and slowly down into the room
    const oa = [[first - 1.0, y, 0], [dx, y, 0], [dx, -0.08, 0], [dx + 1.0, -0.22, 0.1], [Math.max(dx + 1.6, this.roomX1 - 0.35), -H + 0.9, 0.25]];
    oa.vw = 0.35;
    oa.k = [1, 0.4, [1, 0.6, 5], [1, 3, 4]];
    oa.fadeEnd = 1.6;               // the supply air dissipates into the room
    return finish({ oa });
  }

  _shares() { return { oa: 1, rec: 0, rel: 0 }; }

  _flowTarget(fanSum, fanN) {
    // a VAV moves air only on a live airflow ≥ the sensor's minimum or a live fan proof (vav-live.js)
    if (this.vav) return vavFlowTarget(this, fanN ? fanSum / fanN / 100 : 0).target;
    if (fanN) return fanSum / fanN / 100;
    // no fan here: the damper sets the flow, else a measured airflow, else the
    // air arrives from an upstream air handler with nothing here to prove it
    if (this.inv.oad) { const d = this._num(this.inv.oad); return fin(d) ? clamp(d / 100, 0, 1) : 0; }
    const cfmS = pick(this.has, ['SA.CFM', 'SA.FLW']);
    if (cfmS) { const c = this._num(cfmS); return fin(c) && c > 5 ? 0.6 : 0; }
    return 0.5;
  }

  isRunning() {
    return super.isRunning() || (this.vav && vavFlowTarget(this).state.moving);
  }

  _refreshAir() {
    const n = (s) => this._num(s);
    const inT = n('OAT'), znt = n('ZNT'), dat = n(this.datSfx);
    this.vals = { oat: fin(inT) ? inT : (this.vav ? 55 : 72), rat: fin(znt) ? znt : 72 };
    this.vals.mix = this.vals.oat;
    const st = [];
    let cur = this.vals.oat;
    const coils = this.sections.filter((s) => s.kind === 'coil');
    const last = coils[coils.length - 1];
    for (const s of this.sections) {
      const x = s.group.position.x;
      if (s.kind === 'coil') {
        const lt = n(s.t), pct = n(s.v) || 0;
        if (fin(lt)) cur = lt;
        else if (s === last && fin(dat)) cur = dat;
        else cur = cur + (s.heat ? 1 : -1) * pct * 0.18;
        st.push({ x, t: cur, sec: s });
      }
      if (s.kind === 'discharge') {
        if (fin(dat)) st.push({ x: x - s.w / 2, t: dat, sec: s, dx: -s.w / 2 });
        // out of the diffuser the air mixes into the room
        const off = s.w / 2 + (this.diffX - this.unitEnd) + 0.05;
        st.push({ x: x + off + 0.6, t: this.vals.rat, sec: s, dx: off + 0.6, dir: 1 + 0.9 });   // mixes in over ~2 m
      }
    }
    this.tempStations = st;
    this._coilPhysics(st);
    this.occOn = n('OCC') > 0;
  }

  _frameParts(dt, now) {
    super._frameParts(dt, now);
    if (this.person) this.person.visible = !!this.occOn;
  }

  _presetView(name, instant = false) {
    if (name !== 'unit' && name !== 'zone') return super._presetView(name, instant);
    const secs = this.sections;
    if (name === 'unit') {
      const a = secs[0], b = secs[secs.length - 1];
      const x = (a.group.position.x + b.group.position.x) / 2;
      return this._tween(name, new THREE.Vector3(x, this.roomH + this.DH / 2, 0), new THREE.Vector3(x - 1.4, this.roomH + this.DH * 2.6, 3.6), instant);
    }
    const x = (this.diffX + this.roomX1) / 2;
    return this._tween(name, new THREE.Vector3(x, this.roomH * 0.42, 0), new THREE.Vector3(x + 1.0, this.roomH * 1.05, this.roomD / 2 + 3.4), instant);
  }

  _kpiDefs() {
    return [['ZNT', 'Space', '°F'], ['ZNSP', 'Setpoint', '°F'], [this.datSfx, 'Discharge', '°F'],
      ['OAT', this.vav ? 'Primary' : 'Entering', '°F'], [pick(this.has, ['SA.CFM', 'SA.FLW']), 'Airflow', 'cfm'], ['CO2', 'CO2', 'ppm']];
  }

  _modeDefs() {
    const fan = this.inv.fans[0] ? runSuffix(this.has, this.inv.fans[0]) : null;
    return [['OCC', 'Occupied'], [fan, 'Fan'], [this.inv.fans[0] ? resolveSuffix(this.has, this.inv.fans[0], 'fault') : null, 'Fan fault', 1]];
  }
}

// Every VAV (terminal shell or legacy, inferred) draws as a true-size air terminal; FCU keeps Terminal3DView.
export const Vav3DView = vavViewClass(Terminal3DView, { finish, realFans });
// P2 PANELS: wall-hung field panel and VFD (panel3d.js)
export const { Panel3DView, Vfd3DView } = wallViewClasses(Family3DView);

// ---------------------------------------------------------------------------
// ERU: supply deck below, exhaust deck above, the wheel turning through both
// ---------------------------------------------------------------------------

export class Eru3DView extends Family3DView {
  constructor(opts) {
    super({
      ...opts,
      size: { h: 2.0, d: 2.2 },
      eyebrow: 'Energy recovery unit',
      presets: [['overview', 'Overview'], ['intake', 'Outside air'], ['wheel', 'Wheel'], ['fans', 'Fans']]
    });
    this.gap = 0.14;                 // deck divider
    this.tall = 2 * this.DH + this.gap;
  }

  _buildUnit() {
    const has = this.has;
    const inv = ahuInventory(has);
    // the inventory counts exhaust fans as a return path; here they have their own deck
    this.inv = { ...inv, fans: inv.fans, hasRet: false, rad: null };
    this.efs = realFans(has, inv.efs.length ? inv.efs : ['EF1']);
    const unit = this._newUnit();
    const cols = [];
    cols.push({ w: 0.9, bot: { kind: 'intake', cap: 'OUTSIDE AIR' }, top: { kind: 'exout', cap: 'EXHAUST' } });
    for (const f of filterList(has, inv)) cols.push({ w: 0.7, bot: { kind: 'filter', cap: f.cap, f }, top: { kind: 'plen' } });
    cols.push({ w: 1.5, bot: { kind: 'wheel', cap: 'ENERGY WHEEL', open: ['roof'] }, top: { kind: 'wheelx', open: ['floor'] } });
    const ct = { ph: pick(has, ['PHT', 'PHCT']), cc: pick(has, ['CCT']), rh: pick(has, ['RHT']) };
    if (inv.ph) cols.push({ w: 0.8, bot: { kind: 'coil', cap: 'PREHEAT', v: inv.ph, heat: true, t: ct.ph }, top: { kind: 'plen' } });
    if (inv.cc) cols.push({ w: 1.0, bot: { kind: 'coil', cap: 'COOLING', v: inv.cc, heat: false, t: ct.cc }, top: { kind: 'plen' } });
    if (inv.rh) cols.push({ w: 0.8, bot: { kind: 'coil', cap: 'HEATING', v: inv.rh, heat: true, t: ct.rh }, top: { kind: 'plen' } });
    const nf = inv.fans.length, ne = this.efs.length;
    cols.push({ w: 1.9, bot: { kind: 'fans', cap: nf > 1 ? 'SUPPLY FANS' : 'SUPPLY FAN' },
      top: ne ? { kind: 'exfans', cap: ne > 1 ? 'EXHAUST FANS' : 'EXHAUST FAN' } : { kind: 'plen' } });
    cols.push({ w: 1.1, bot: { kind: 'discharge', cap: 'SUPPLY' }, top: { kind: 'exin', cap: 'RETURN' } });

    let x = 0;
    for (const c of cols) { c.x0 = x; x += c.w; }
    const total = x;
    const Y1 = this.DH + this.gap;
    const secs = [];
    cols.forEach((c, ci) => {
      for (const [row, sec] of [[0, c.bot], [1, c.top]]) {
        const s = { ...sec, w: c.w, row, col: ci, ex: ci };
        s.i = secs.length;
        s.baseX = -total / 2 + c.x0 + c.w / 2;
        s.group = new THREE.Group();
        s.group.position.set(s.baseX, row * Y1, 0);
        unit.add(s.group);
        s.open = new Set(s.open || []);
        this._cabinet(s.group, s.w, this.DH, s);
        secs.push(s);
      }
    });
    this.sections = secs;
    this.total = total;
    this.exMid = (cols.length - 1) / 2;
    for (const s of secs) {
      this._fillEru(s);
      if (s.cap) {
        const o = this._label(s.cap, 'a3-sec');
        o.position.set(0, s.row ? this.DH - 0.2 : 0.02, this.D / 2 + 0.25);
        s.group.add(o);
      }
    }
    // the divider between the decks
    const div = new THREE.Mesh(new THREE.BoxGeometry(total, this.gap, this.D), this.m.rail);
    div.position.y = this.DH + this.gap / 2;
    this.divider = div;
    unit.add(div);
  }

  _fillEru(s) {
    const g = s.group, has = this.has, H = this.DH, Z = this.D / 2, inv = this.inv;
    const low = 0.35 + (s.col % 2) * 0.55;       // readouts low on the front, staggered
    if (s.kind === 'intake') {
      if (inv.oad) {
        const dm = this._damper(inv.oad, this.D - 0.3, H - 0.3, 9);
        dm.position.set(-s.w / 2 + 0.1, H / 2, 0);
        g.add(dm);
      }
      this._hood(g, -s.w / 2, H, -1);
      this._tag(g, [-s.w / 2 - 0.35, H * 0.55, Z + 0.1], [['OAT', 'OA TMP', '°F'], [pick(has, ['OAH', 'OARH', 'OA.RH']), 'OA RH', '%'], [pick(has, ['OA.CFM']), 'OA FLOW', 'cfm']]);
      this._tag(g, [-s.w / 2 + 0.1, H * 0.15, Z + 0.05], [[inv.oad, 'OA DMP', '%']]);
    } else if (s.kind === 'filter') {
      const f = this._filter(s.f.alm);
      f.userData.pick = { title: s.cap, points: [s.f.alm, s.f.dp].filter(Boolean) };
      g.add(f);
      this._tag(g, [0, low, Z + 0.1], [[s.f.dp, 'DP', 'inWC'], [s.f.alm, 'ALARM', 'alm']]);
    } else if (s.kind === 'wheel') {
      this._wheel(s);
    } else if (s.kind === 'coil') {
      const c = this._coil(s.v, s.heat);
      if (s.t) c.userData.pick.points.push(s.t);
      c.userData.pick.title = `${s.cap} coil`;
      g.add(c);
      this._valve(g, s, s.heat);
      this._tag(g, [0, H * 0.62, Z + 0.15], [[s.t, s.heat ? 'LVG TMP' : 'CC TMP', '°F']]);
      this._tag(g, [0.05, 0.28, Z + 0.35], [[s.v, s.heat ? 'HW VLV' : 'CHW VLV', '%']]);
    } else if (s.kind === 'fans') {
      this._fanWall(g, inv.fans, H, 0, 1, 0.05, [0.35, H * 0.25, Z + 0.1]);
    } else if (s.kind === 'discharge') {
      this._duct(g, s.w / 2, H, +1);
      this._tag(g, [s.w / 2 + 0.55, H * 0.5, Z], [['SAT', 'SA TMP', '°F'], [pick(has, ['SA.CFM', 'SA.FLW']), 'SA FLOW', 'cfm'], [pick(has, ['SSP', 'DSP']), 'STATIC', 'inWC']]);
    } else if (s.kind === 'exin') {
      this._duct(g, s.w / 2, H, +1);
      this._tag(g, [s.w / 2 + 0.55, H * 0.6, Z], [['RAT', 'RA TMP', '°F'], [pick(has, ['RAH', 'RA.RH']), 'RA RH', '%'], [pick(has, ['RA.FLW', 'RA.CFM']), 'RA FLOW', 'cfm']]);
    } else if (s.kind === 'exfans') {
      this._fanWall(g, this.efs, H, 0, -1, -0.05, [-0.35, H * 0.8, Z + 0.1]);
    } else if (s.kind === 'exout') {
      const ead = pick(has, ['EAD', 'RELD']);
      if (ead) {
        const dm = this._damper(ead, this.D - 0.3, H - 0.3, 9);
        dm.position.set(-s.w / 2 + 0.1, H / 2, 0);
        g.add(dm);
        this._tag(g, [-s.w / 2 + 0.1, H * 0.88, Z + 0.05], [[ead, 'EA DMP', '%']]);
      }
      this._hood(g, -s.w / 2, H, -1, true);
      this._tag(g, [-s.w / 2 - 0.35, H * 0.55, Z + 0.1], [['EAT', 'EA TMP', '°F'], [pick(has, ['EA.FLW', 'EA.CFM']), 'EA FLOW', 'cfm']]);
    }
  }

  /** Enthalpy wheel: a honeycomb rotor standing across both decks. */
  _wheel(s) {
    const g = s.group, m = this.m, has = this.has, H = this.DH;
    const R = H * 0.93;
    const wg = new THREE.Group();
    wg.position.set(0, H + this.gap / 2, 0);
    g.add(wg);
    const rotor = new THREE.Group();
    wg.add(rotor);
    const mat = new THREE.MeshStandardMaterial({ color: '#a8916a', metalness: 0.25, roughness: 0.75, emissive: '#46d3e6', emissiveIntensity: 0, envMapIntensity: 0.5 });
    const media = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.26, 72), mat);
    media.rotation.z = Math.PI / 2;
    media.castShadow = true;
    rotor.add(media);
    // face lattice suggests the honeycomb; spokes and rims make the rotation readable
    const lattice = new THREE.MeshBasicMaterial({ color: '#5a4a2e', wireframe: true, transparent: true, opacity: 0.55 });
    for (const sx of [-1, 1]) {
      const face = new THREE.Mesh(new THREE.CircleGeometry(R * 0.985, 40, 0, Math.PI * 2), lattice);
      face.rotation.y = sx * Math.PI / 2;
      face.position.x = sx * 0.132;
      rotor.add(face);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.035, 8, 72), m.rail);
      rim.rotation.y = Math.PI / 2;
      rim.position.x = sx * 0.13;
      rotor.add(rim);
      const inner = new THREE.Mesh(new THREE.TorusGeometry(R * 0.5, 0.02, 6, 48), m.rail);
      inner.rotation.y = Math.PI / 2;
      inner.position.x = sx * 0.133;
      rotor.add(inner);
      for (let i = 0; i < 6; i++) {
        const piv = new THREE.Group();
        piv.rotation.x = (i * Math.PI) / 6;
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, 2 * R, 0.04), m.rail);
        spoke.position.x = sx * 0.134;
        piv.add(spoke);
        rotor.add(piv);
      }
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.36, 20), m.dark);
    hub.rotation.z = Math.PI / 2;
    rotor.add(hub);
    // drive: motor in the lower corner and a belt around the rim
    const motor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 0.2), m.dark);
    motor.position.set(0, -R + 0.05, this.D / 2 - 0.3);
    wg.add(motor);
    const belt = new THREE.Mesh(new THREE.TorusGeometry(R + 0.012, 0.01, 4, 96), m.dark);
    belt.rotation.y = Math.PI / 2;
    wg.add(belt);
    const run = runSuffix(has, 'WHL'), spd = resolveSuffix(has, 'WHL', 'speed'), flt = resolveSuffix(has, 'WHL', 'fault');
    this.parts.wheels.push({ rotor, run, spd, flt, mat, speed: 0 });
    wg.userData.pick = { title: 'Energy wheel', points: ['WHL.SS', 'WHL.SVD', 'WHL.STS', 'WHL.BYP', 'WHL.FLT'].filter((x) => has(x)) };
    for (const sfx of ['WHL.SS', 'WHL.SVD', 'WHL.STS']) if (has(sfx)) this.anchors.set(sfx, wg);
    for (const sfx of [run, spd, flt]) if (sfx && has(sfx)) this._bind(sfx);
    this._tag(g, [0, 0.4, this.D / 2 + 0.3], [[spd && has(spd) ? spd : run, 'WHEEL', spd && has(spd) ? '%' : 'onoff'],
      ['WHL.BYP', 'BYPASS', '%'], ['WHL.LAT', 'WHL LVG', '°F'], ['WHL.FLT', 'FAULT', 'alm']]);
  }

  _row(r) { return this.sections.filter((s) => s.row === r); }

  _paths() {
    const row0 = this._row(0);
    const first = row0[0].group.position.x - row0[0].w / 2;
    const lastS = row0[row0.length - 1];
    const last = lastS.group.position.x + lastS.w / 2;
    const y0 = this.DH / 2, y1 = this.DH + this.gap + this.DH / 2;
    return finish({ oa: [[first - 1.6, y0, 0], [last + 1.6, y0, 0]], rec: [[last + 1.6, y1, 0], [first - 1.6, y1, 0]] });
  }

  _shares() { return { oa: 0.55, rec: 0.45, rel: 0 }; }

  _refreshAir() {
    const n = (s) => this._num(s);
    const oat = n('OAT'), rat = n('RAT'), eat = n('EAT'), lat = n('WHL.LAT'), sat = n('SAT');
    this.vals = { oat: fin(oat) ? oat : 50, rat: fin(rat) ? rat : 72 };
    // recovered heat: measured leaving temps when there are sensors, else a
    // typical 70% effective wheel at its speed, reduced by the bypass damper
    const w = this.parts.wheels[0];
    const spd = w ? (w.target || 0) / 100 : 0;
    const byp = n('WHL.BYP');
    const eff = 0.7 * spd * (fin(byp) ? 1 - clamp(byp, 0, 100) / 100 : 1);
    const dT = this.vals.rat - this.vals.oat;
    const latT = fin(lat) ? lat : this.vals.oat + eff * dT;
    const eatT = fin(eat) ? eat : this.vals.rat - eff * dT;
    const st = [];
    const ws = this.sections.find((s) => s.kind === 'wheel');
    const wx = this.sections.find((s) => s.kind === 'wheelx');
    if (ws) st.push({ x: ws.group.position.x + ws.w / 2, t: latT, sec: ws, dx: ws.w / 2 - 0.05, path: 0 });
    let cur = latT;
    const coils = this.sections.filter((s) => s.kind === 'coil');
    const lastCoil = coils[coils.length - 1];
    for (const s of this._row(0)) {
      if (s.kind === 'coil') {
        const lt = n(s.t), pct = n(s.v) || 0;
        if (fin(lt)) cur = lt;
        else if (s === lastCoil && fin(sat)) cur = sat;
        else cur = cur + (s.heat ? 1 : -1) * pct * 0.18;
        st.push({ x: s.group.position.x, t: cur, sec: s, path: 0 });
      }
      if (s.kind === 'discharge' && fin(sat)) st.push({ x: s.group.position.x - s.w / 2, t: sat, sec: s, dx: -s.w / 2, path: 0 });
    }
    // exhaust runs right to left: past the wheel's left face it has given up its heat
    if (wx) st.push({ x: wx.group.position.x - wx.w / 2, t: eatT, sec: wx, dx: -wx.w / 2 + 0.05, path: 1, dir: -1 });
    this.vals.mix = latT;
    this.tempStations = st;
    this._coilPhysics(st);
  }

  _frameParts(dt, now) {
    super._frameParts(dt, now);
    // the divider stretches with the exploded columns
    if (this.divider) {
      const row0 = this._row(0);
      const a = row0[0].group.position.x - row0[0].w / 2, b = row0[row0.length - 1].group.position.x + row0[row0.length - 1].w / 2;
      this.divider.visible = this.explode < 0.05;
      this.divider.scale.x = (b - a) / this.total;
    }
  }

  _presetView(name, instant = false) {
    if (name !== 'wheel') return super._presetView(name, instant);
    const ws = this.sections.find((s) => s.kind === 'wheel');
    const x = ws ? ws.group.position.x : 0;
    return this._tween(name, new THREE.Vector3(x, this.DH + this.gap / 2, 0), new THREE.Vector3(x - 3.4, this.DH * 1.7, 6.4), instant);
  }

  _kpiDefs() {
    return [['SAT', 'Supply', '°F'], ['OAT', 'Outside', '°F'], ['RAT', 'Return', '°F'], ['EAT', 'Exhaust', '°F'],
      ['WHL.LAT', 'Wheel lvg', '°F'], [pick(this.has, ['SA.CFM', 'SA.FLW']), 'Airflow', 'cfm']];
  }

  _modeDefs() {
    const w = this.parts.wheels[0];
    return [['OCC', 'Occupied'], [w && this.has(w.run) ? w.run : null, 'Wheel'], ['WHL.FLT', 'Wheel fault', 1]];
  }
}

// ---------------------------------------------------------------------------
// Hydronic plant: equipment on a skid, water loops instead of an air stream
// ---------------------------------------------------------------------------

class Plant3DView extends Family3DView {
  constructor(opts) {
    super({ ...opts, size: opts.size || { h: 1.6, d: 1.0 }, legend: 'Water temp' });
    // the particle colour ramp is built for air (40–100 °F); water is shifted
    // 80 °F down so a 120–180 °F loop spans the same blue → red
    this.shift = 80;
    this.legendRange = ['120°F', '180°F'];
    this.loY = 0.42;
    this.hiY = 1.22;
    this.pipeR = 0.06;
  }

  get airBox() { return [0.56, 0.56]; }          // pipe-thin streams
  get airSpan() { return [-1e4, -1e4 + 1]; }      // no cabinet interior to clamp to

  _w(t) { return fin(t) ? t - this.shift : NaN; }

  _pipeMats() {
    return {
      hot: new THREE.MeshStandardMaterial({ color: '#8c3b2a', metalness: 0.55, roughness: 0.42 }),
      warm: new THREE.MeshStandardMaterial({ color: '#9a5a33', metalness: 0.55, roughness: 0.42 }),
      cool: new THREE.MeshStandardMaterial({ color: '#27557d', metalness: 0.55, roughness: 0.42 })
    };
  }

  /** Pipe stands so the loops don't float. */
  _stands(g, w, top) {
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, top, 8), this.m.rail);
      post.position.set(sx * w * 0.32, top / 2, -0.12);
      g.add(post);
      for (const y of [this.loY, this.hiY].filter((yy) => yy <= top + 0.01)) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.14), this.m.rail);
        arm.position.set(sx * w * 0.32, y - this.pipeR - 0.015, -0.06);
        g.add(arm);
      }
    }
  }

  _flowTarget() {
    const p = this.parts.pumps[0];
    const v = this.parts.cvalves[0];
    const b = this.parts.burners[0];
    let f = 0;
    if (p) f = Math.max(f, (p.target || 0) / 100);
    if (v) f = Math.max(f, (v.target || 0) / 100 * 0.8);
    if (!p && b) f = Math.max(f, b.target > 0 ? 0.5 : 0);
    if (!p && !v && !b) f = 0.5;
    return f;
  }
}

export class Hx3DView extends Plant3DView {
  constructor(opts) {
    super({ ...opts, eyebrow: 'Heat exchanger', presets: [['overview', 'Overview'], ['unit', 'Plates'], ['pump', 'Pump']] });
  }

  _buildUnit() {
    const has = this.has;
    this.inv = { hasRet: false, fans: [], oad: null, ead: null };
    this._newUnit();
    const secs = [
      { kind: 'pri', w: 1.4, cap: 'PRIMARY', cabinet: false },
      { kind: 'hx', w: 1.1, cap: 'PLATE HX', cabinet: false },
      { kind: 'sec', w: 1.4, cap: 'SECONDARY', cabinet: false }
    ];
    this.total = this._layRow(secs, { cabinet: false });
    this.sections = secs;
    const pm = this._pipeMats();
    const { loY, hiY, pipeR: r } = this;
    for (const s of secs) {
      const g = s.group, w = s.w;
      this._skid(g, w);
      this._sectionTag(s);
      if (s.kind === 'pri') {
        this._stands(g, w, hiY);
        this._pipe(g, [-w / 2 - 0.6, hiY, 0], [w / 2, hiY, 0], r, pm.hot);
        this._pipe(g, [-w / 2 - 0.6, loY, 0], [w / 2, loY, 0], r, pm.warm);
        if (has('PRI.VLV')) {
          this._cvalve(g, 'PRI.VLV', [0.1, hiY, 0], 'Primary control valve');
          this._tag(g, [0.1, hiY + 0.72, 0.1], [['PRI.VLV', 'PRI VLV', '%']]);
        }
        this._tag(g, [-w / 2 - 0.35, hiY + 0.32, 0.12], [['PRI.IN', 'PRI IN', '°F']]);
        this._tag(g, [-w / 2 - 0.35, loY - 0.28, 0.12], [['PRI.OUT', 'PRI LVG', '°F']]);
      } else if (s.kind === 'hx') {
        this._plates(s, pm);
      } else {
        this._stands(g, w, hiY);
        this._pipe(g, [-w / 2, hiY, 0], [w / 2 + 0.6, hiY, 0], r, pm.warm);
        this._pipe(g, [-w / 2, loY, 0], [w / 2 + 0.6, loY, 0], r, pm.cool);
        if (has('SEC.PMP')) {
          this._pump(g, 'SEC.PMP', [0.15, loY, 0], 'Secondary pump');
          const run = runSuffix(has, 'SEC.PMP');
          this._tag(g, [0.15, loY + 0.42, 0.2], [[run, 'PUMP', 'onoff'], [resolveSuffix(has, 'SEC.PMP', 'speed'), 'SPEED', '%']]);
        }
        this._tag(g, [w / 2 + 0.35, hiY + 0.32, 0.12], [['SEC.OUT', 'SEC SUP', '°F']]);
        this._tag(g, [w / 2 + 0.35, loY - 0.28, 0.12], [['SEC.IN', 'SEC RTN', '°F']]);
        // the building's hot water: secondary supply out the top line, return into the bottom one
        this.outletLocal = { x: s.baseX + w / 2 + 0.6, y: hiY, z: 0, w: r * 2.2, h: r * 2.2, dir: [1, 0, 0] };
        this.returnLocal = { x: s.baseX + w / 2 + 0.6, y: loY, z: 0, r, dir: [1, 0, 0] };
      }
    }
  }

  /** Gasketed plate pack between a fixed and a moving frame, four nozzles. */
  _plates(s, pm) {
    const g = s.group, m = this.m, has = this.has;
    const { loY, hiY, pipeR: r } = this;
    const frameMat = new THREE.MeshStandardMaterial({ color: '#2d5a78', metalness: 0.45, roughness: 0.45 });
    const yc = (loY + hiY) / 2 + 0.02, hh = hiY - loY + 0.5;
    for (const sx of [-1, 1]) {
      const fr = new THREE.Mesh(new THREE.BoxGeometry(0.14, hh + 0.1, 0.8), frameMat);
      fr.position.set(sx * 0.42, yc, 0);
      fr.castShadow = true;
      g.add(fr);
      for (const y of [loY, hiY]) {
        const noz = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.012, r + 0.012, 0.14, 16), m.steel);
        noz.rotation.z = Math.PI / 2;
        noz.position.set(sx * 0.55, y, 0);
        g.add(noz);
      }
    }
    const plateMat = new THREE.MeshStandardMaterial({ color: '#9aa6ae', metalness: 0.85, roughness: 0.3, emissive: '#ff6a2a', emissiveIntensity: 0 });
    const n = 30;
    const plates = new THREE.InstancedMesh(new THREE.BoxGeometry(0.011, hh - 0.08, 0.7), plateMat, n);
    const mtx = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      mtx.makeTranslation(-0.33 + (0.66 * (i + 0.5)) / n, yc, 0);
      plates.setMatrixAt(i, mtx);
    }
    plates.castShadow = true;
    g.add(plates);
    for (const y of [yc - hh / 2 + 0.06, yc + hh / 2 - 0.06]) {
      for (const z of [-0.36, 0.36]) {
        const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 1.02, 8), m.steel);
        bolt.rotation.z = Math.PI / 2;
        bolt.position.set(0, y, z);
        g.add(bolt);
      }
    }
    const carry = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 0.08), m.rail);
    carry.position.set(0, yc + hh / 2 + 0.06, 0);
    g.add(carry);
    this.plateMat = plateMat;
    plates.userData.pick = { title: 'Heat exchanger', points: ['PRI.VLV', 'SEC.PMP'].filter((x) => has(x)) };
    this._tag(g, [0, yc + hh / 2 + 0.45, 0.1], [['HX.SP', 'SETPOINT', '°F'], ['HX.PRESS', 'PRESSURE', 'psi']]);
  }

  _paths() {
    const pri = this._sec('pri'), hx = this._sec('hx'), sec = this._sec('sec');
    const first = pri.group.position.x - pri.w / 2 - 0.6, last = sec.group.position.x + sec.w / 2 + 0.6;
    const hxX = hx.group.position.x;
    const { loY, hiY } = this;
    const W = this.water || {};
    // primary: in along the top, down through the left half of the pack, out along the bottom
    const oa = [[first, hiY, 0], [hxX - 0.2, hiY, 0], [hxX - 0.2, loY, 0], [first, loY, 0]];
    oa.vw = 0.32;
    oa.legT = [W.pIn, (W.pIn + W.pOut) / 2, W.pOut];
    // secondary: counter-flow — in along the bottom, up through the right half, out along the top
    const rec = [[last, loY, 0], [hxX + 0.2, loY, 0], [hxX + 0.2, hiY, 0], [last, hiY, 0]];
    rec.vw = 0.32;
    rec.legT = [W.sIn, (W.sIn + W.sOut) / 2, W.sOut];
    return finish({ oa, rec });
  }

  _shares() { return { oa: 0.5, rec: 0.5, rel: 0 }; }

  _refreshAir() {
    const n = (s) => this._num(s);
    const pIn = n('PRI.IN'), pOut = n('PRI.OUT'), sIn = n('SEC.IN'), sOut = n('SEC.OUT');
    // colours only: estimate any temperature that isn't measured from the ones that are
    const PI = fin(pIn) ? pIn : 180, SI = fin(sIn) ? sIn : 140;
    const v = this.parts.cvalves[0];
    const k = v ? (v.target || 0) / 100 : 0.5;
    const PO = fin(pOut) ? pOut : PI - k * (PI - SI) * 0.6;
    const SO = fin(sOut) ? sOut : SI + k * (PI - SI) * 0.5;
    this.water = { pIn: this._w(PI), pOut: this._w(PO), sIn: this._w(SI), sOut: this._w(SO) };
    this.vals = { oat: this.water.pIn, rat: this.water.sIn, mix: this.water.pIn };
    this.tempStations = [];
    if (this.plateMat) this.plateMat.emissiveIntensity = 0.22 * k;
  }

  _presetView(name, instant = false) {
    const s = name === 'unit' ? this._sec('hx') : name === 'pump' ? this._sec('sec') : null;
    if (!s) return super._presetView(name, instant);
    const x = s.group.position.x;
    return this._tween(name, new THREE.Vector3(x, 0.85, 0), new THREE.Vector3(x + (name === 'pump' ? 1.2 : -1.0), 1.9, 3.2), instant);
  }

  _kpiDefs() {
    return [['PRI.IN', 'Pri in', '°F'], ['PRI.OUT', 'Pri lvg', '°F'], ['SEC.IN', 'Sec rtn', '°F'], ['SEC.OUT', 'Sec sup', '°F'],
      ['HX.SP', 'Setpoint', '°F'], ['PRI.VLV', 'Valve', '%']];
  }

  _modeDefs() {
    const p = this.parts.pumps[0];
    return [[p && this.has(p.run) ? p.run : null, 'Pump'], [p && p.flt && this.has(p.flt) ? p.flt : null, 'Pump fault', 1]];
  }
}

export class Boiler3DView extends Plant3DView {
  constructor(opts) {
    super({ ...opts, eyebrow: 'Boiler', presets: [['overview', 'Overview'], ['unit', 'Boiler'], ['pump', 'Pump']] });
  }

  _buildUnit() {
    const has = this.has;
    this.inv = { hasRet: false, fans: [], oad: null, ead: null };
    this._newUnit();
    const secs = [
      { kind: 'ret', w: 1.3, cap: 'RETURN', cabinet: false },
      { kind: 'blr', w: 1.6, cap: 'BOILER', cabinet: false },
      { kind: 'sup', w: 1.2, cap: 'SUPPLY', cabinet: false }
    ];
    this.total = this._layRow(secs, { cabinet: false });
    this.sections = secs;
    const pm = this._pipeMats();
    const { loY, hiY, pipeR: r } = this;
    for (const s of secs) {
      const g = s.group, w = s.w;
      this._skid(g, w);
      this._sectionTag(s);
      if (s.kind === 'ret') {
        this._stands(g, w, loY + 0.1);
        this._pipe(g, [-w / 2 - 0.6, loY, 0], [w / 2, loY, 0], r, pm.cool);
        if (has('BLR.PMP')) {
          this._pump(g, 'BLR.PMP', [0.05, loY, 0], 'Boiler pump');
          this._tag(g, [0.05, loY + 0.45, 0.2], [[runSuffix(has, 'BLR.PMP'), 'PUMP', 'onoff'], [resolveSuffix(has, 'BLR.PMP', 'speed'), 'SPEED', '%']]);
        }
        this._tag(g, [-w / 2 - 0.35, loY + 0.32, 0.12], [['BLR.RWT', 'HW RTN', '°F']]);
        // the hot-water return comes into the return pipe at the far (left) end
        this.returnLocal = { x: s.baseX - w / 2 - 0.6, y: loY, z: 0, r, dir: [-1, 0, 0] };
      } else if (s.kind === 'blr') {
        this._vessel(s, pm);
      } else {
        this._stands(g, w, hiY);
        this._pipe(g, [-w / 2, hiY, 0], [w / 2 + 0.6, hiY, 0], r, pm.hot);
        this._tag(g, [w / 2 + 0.35, hiY + 0.32, 0.12], [['BLR.SWT', 'HW SUP', '°F'], ['BLR.SP', 'SETPOINT', '°F'], ['BLR.PRESS', 'PRESSURE', 'psi']]);
        this.outletLocal = { x: s.baseX + w / 2 + 0.6, y: hiY, z: 0, w: r * 2.2, h: r * 2.2, dir: [1, 0, 0] };
      }
    }
  }

  /** Condensing boiler: glass-front cabinet, fire-tube coil, burner flame, flue. */
  _vessel(s, pm) {
    const g = s.group, m = this.m, has = this.has;
    const { loY, hiY, pipeR: r } = this;
    const BW = 1.1, BH = 1.55, BD = 0.9, by = 0.08;
    const shell = new THREE.MeshStandardMaterial({ color: '#1d262d', metalness: 0.5, roughness: 0.5, side: THREE.DoubleSide });
    const box = new THREE.Group();
    box.position.y = by;
    g.add(box);
    const panel = (w, h, pos, rot) => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), shell);
      p.position.set(...pos);
      if (rot) p.rotation.set(...rot);
      p.receiveShadow = true;
      box.add(p);
    };
    panel(BW, BH, [0, BH / 2, -BD / 2]);
    panel(BD, BH, [-BW / 2, BH / 2, 0], [0, Math.PI / 2, 0]);
    panel(BD, BH, [BW / 2, BH / 2, 0], [0, Math.PI / 2, 0]);
    panel(BW, BD, [0, BH, 0], [Math.PI / 2, 0, 0]);
    const front = new THREE.Mesh(new THREE.PlaneGeometry(BW - 0.02, BH - 0.02), m.glass.clone());
    front.material.opacity = 0.08;
    front.position.set(0, BH / 2, BD / 2);
    box.add(front);
    s.skins = [front];
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(BW, BH, BD)), m.edge);
    edges.position.y = BH / 2;
    box.add(edges);
    // fire-tube coil: stacked copper rings around the burner
    const coilMat = m.copper.clone();
    coilMat.emissive = new THREE.Color('#ff5a1f');
    coilMat.emissiveIntensity = 0;
    for (let i = 0; i < 8; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.034, 10, 40), coilMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.28 + i * 0.13;
      ring.castShadow = true;
      box.add(ring);
    }
    // burner tube from the top, flame hanging from it
    const burner = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.42, 20), m.steel);
    burner.position.y = BH - 0.25;
    box.add(burner);
    const flameMat = new THREE.MeshBasicMaterial({ color: '#ff8a2a', transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.75, 24, 1, true), flameMat);
    flame.rotation.x = Math.PI;
    flame.position.y = BH - 0.46 - 0.375;
    flame.visible = false;
    box.add(flame);
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: '#5cc8ff', transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    flame.add(inner);             // rides inside the outer flame, scales with it
    inner.position.set(0, 0.12, 0);
    const light = new THREE.PointLight('#ff8a3a', 0, 3.5, 2);
    light.position.y = 0.8;
    box.add(light);
    // flue stack
    const flue = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.9, 20), m.steel);
    flue.position.set(0.3, BH + 0.45, -0.2);
    flue.castShadow = true;
    box.add(flue);
    const capM = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.12, 20), m.rail);
    capM.position.set(0.3, BH + 0.98, -0.2);
    box.add(capM);
    // gas train into the burner
    const gas = new THREE.MeshStandardMaterial({ color: '#c9a21c', metalness: 0.6, roughness: 0.4 });
    this._pipe(box, [-0.42, -by, -0.3], [-0.42, BH + 0.12, -0.3], 0.025, gas);
    this._pipe(box, [-0.42, BH + 0.12, -0.3], [0, BH + 0.12, -0.3], 0.025, gas);
    this._pipe(box, [0, BH + 0.12, -0.3], [0, BH - 0.05, 0], 0.025, gas);
    // control panel with a status light
    const cp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.18, 0.03), m.dark);
    cp.position.set(-0.28, BH - 0.16, BD / 2 + 0.02);
    box.add(cp);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 8), new THREE.MeshStandardMaterial({ color: '#111', emissive: '#34444e', emissiveIntensity: 1.2 }));
    led.position.set(-0.17, BH - 0.16, BD / 2 + 0.04);
    box.add(led);
    // water: return into the lower left, supply out the upper right
    this._pipe(g, [-s.w / 2, loY, 0], [-BW / 2, loY, 0], r, pm.cool);
    this._pipe(g, [BW / 2, hiY, 0], [s.w / 2, hiY, 0], r, pm.hot);
    const run = pick(has, ['BLR.STS', 'BLR.SS']);
    this.parts.burners.push({ fire: has('BLR.FIRE') ? 'BLR.FIRE' : null, run, flt: has('BLR.FLT') ? 'BLR.FLT' : null,
      flame, flameMat, inner, light, coilMat, led, level: 0 });
    const pts = ['BLR.SS', 'BLR.FIRE', 'BLR.STS', 'BLR.FLT'].filter((x) => has(x));
    for (const o of [box]) o.userData.pick = { title: 'Boiler', points: pts };
    for (const sfx of ['BLR.SS', 'BLR.STS', 'BLR.FIRE']) if (has(sfx)) this.anchors.set(sfx, box);
    for (const sfx of pts) this._bind(sfx);
    this._tag(g, [-0.05, by + BH + 0.35, BD / 2 + 0.1], [[pick(has, ['BLR.STS', 'BLR.SS']), 'BOILER', 'onoff'], ['BLR.FIRE', 'FIRING', '%'],
      ['BLR.FLAME', 'FLAME', 'onoff'], ['BLR.FLT', 'FAULT', 'alm']]);
    this._tag(g, [0.3, by + BH + 1.2, -0.2], [['BLR.STACK', 'STACK', '°F']]);
  }

  _paths() {
    const ret = this._sec('ret'), blr = this._sec('blr'), sup = this._sec('sup');
    const first = ret.group.position.x - ret.w / 2 - 0.6, last = sup.group.position.x + sup.w / 2 + 0.6;
    const bx = blr.group.position.x;
    const W = this.water || {};
    // return along the bottom, up through the coil around the flame, supply out the top
    const oa = [[first, this.loY, 0], [bx, this.loY, 0], [bx, this.hiY, 0], [last, this.hiY, 0]];
    oa.vw = 0.5;
    oa.legT = [W.r, (W.r + W.s) / 2, W.s];
    return finish({ oa });
  }

  _shares() { return { oa: 1, rec: 0, rel: 0 }; }

  _refreshAir() {
    const n = (s) => this._num(s);
    const rwt = n('BLR.RWT'), swt = n('BLR.SWT');
    const b = this.parts.burners[0];
    const k = b ? b.target || 0 : 0;
    const R = fin(rwt) ? rwt : 150;
    const S = fin(swt) ? swt : R + 20 * k;
    this.water = { r: this._w(R), s: this._w(S) };
    this.vals = { oat: this.water.r, rat: this.water.s, mix: this.water.r };
    this.tempStations = [];
  }

  _presetView(name, instant = false) {
    const s = name === 'unit' ? this._sec('blr') : name === 'pump' ? this._sec('ret') : null;
    if (!s) return super._presetView(name, instant);
    const x = s.group.position.x;
    return this._tween(name, new THREE.Vector3(x, 0.9, 0), new THREE.Vector3(x + (name === 'pump' ? -1.0 : 1.2), 2.1, 3.4), instant);
  }

  _kpiDefs() {
    return [['BLR.SWT', 'Supply', '°F'], ['BLR.SP', 'Setpoint', '°F'], ['BLR.RWT', 'Return', '°F'], ['BLR.FIRE', 'Firing', '%'],
      ['BLR.STACK', 'Stack', '°F'], ['BLR.PRESS', 'Pressure', 'psi']];
  }

  _modeDefs() {
    const p = this.parts.pumps[0];
    return [[pick(this.has, ['BLR.STS', 'BLR.SS']), 'Enabled'], ['BLR.FLAME', 'Flame'], ['BLR.FLT', 'Fault', 1],
      [p && this.has(p.run) ? p.run : null, 'Pump']];
  }
}

// ---------------------------------------------------------------------------
// Chillers. Both share the machine's point set (CH.* — see chillerMap in
// ahu3d-bridge.js): enable/run, % load, alarm, flow proofs, compressors, pumps.
// Water colours use the air ramp unshifted: 44 °F chilled water reads blue,
// 85–95 °F condenser water reads warm.
// ---------------------------------------------------------------------------

class Chiller3DView extends Plant3DView {
  constructor(opts) {
    super(opts);
    this.shift = 0;
    this.legendRange = ['40°F', '100°F'];
    this.pipeR = 0.075;
  }

  /** Chiller state from its points: on (proven), fault, load 0..1. */
  _state() {
    const n = (s) => this._num(s);
    const has = this.has;
    const sts = has('CH.STS') ? n('CH.STS') : NaN;
    const en = has('CH.SS') ? n('CH.SS') : NaN;
    const load = n('CH.LOAD');
    const fault = has('CH.FLT') ? n('CH.FLT') > 0 : false;
    const on = fin(sts) ? sts > 0 : fin(load) ? load > 0 : fin(en) ? en > 0 : false;
    const k = !on || fault ? 0 : fin(load) ? clamp(load, 0, 100) / 100 : 0.6;
    return { on: on && !fault, fault, k };
  }

  /** Compressors: their own status points, else staged on by load. */
  _compTargets(st) {
    const cs = this.parts.comps || [];
    const known = cs.filter((c) => c.sfx && this.has(c.sfx));
    cs.forEach((c, i) => {
      if (known.length) c.target = c.sfx && this.has(c.sfx) ? (this._num(c.sfx) > 0 && !st.fault ? 1 : 0) : (st.on ? 1 : 0);
      else c.target = st.on && st.k > (i / cs.length) * 0.9 ? 1 : 0;
    });
  }

  _refreshExtra() {
    super._refreshExtra();
    this.st = this._state();
    this._compTargets(this.st);
  }

  _frameParts(dt, now) {
    super._frameParts(dt, now);
    const st = this.st || { on: false, fault: false, k: 0 };
    for (const c of this.parts.comps || []) {
      c.level = damp(c.level || 0, c.target || 0, 2.2, dt);
      c.band.material.emissive.set(st.fault ? '#ff3b2a' : '#3fe08a');
      c.band.material.emissiveIntensity = st.fault ? 0.8 + 0.6 * Math.sin(now / 200) : c.level * 1.6;
      // a running scroll hums: a hair of vibration
      if (c.body) c.body.position.x = c.x0 + (c.level > 0.5 ? Math.sin(now / 9 + c.x0 * 7) * 0.0012 : 0);
    }
    if (this.statusLed) {
      this.statusLed.material.emissive.set(st.fault ? '#ff3b2a' : st.on ? '#3fe08a' : '#34444e');
      this.statusLed.material.emissiveIntensity = st.fault ? 1.4 + Math.sin(now / 200) : 1.3;
    }
    if (this.screen) this.screen.material.emissiveIntensity = st.on ? 0.9 : 0.45;
  }

  isRunning() { return !!this.st?.on || super.isRunning(); }
  hasFault() { return !!this.st?.fault || super.hasFault(); }

  _flowTarget() {
    const p = this.parts.pumps[0];
    if (p) return (p.target || 0) / 100;
    return this.st?.on ? 0.7 : 0; // off or not live: the stream stops (no idle drift)
  }

  _chwTemps() {
    const n = (s) => this._num(s);
    const k = this.st?.k ?? 0;
    const R = fin(n('CH.CHWR')) ? n('CH.CHWR') : 56;
    const S = fin(n('CH.CHWS')) ? n('CH.CHWS') : R - 12 * (k || 0.1);
    return { R, S };
  }

  /** A grooved (Victaulic-style) nozzle stub with its coupling. */
  _nozzle(g, a, b, r, mat) {
    this._pipe(g, a, b, r, mat);
    const cp = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.22, r * 1.22, 0.07, 18), this.m.dark);
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    cp.position.copy(vb);
    cp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    g.add(cp);
  }

  /** Control panel with a touchscreen and a status light, facing +z. */
  _panel(g, pos, w = 0.6, h = 0.85, d = 0.24) {
    const m = this.m;
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: '#8e989f', metalness: 0.45, roughness: 0.5 }));
    box.position.set(...pos);
    box.castShadow = true;
    g.add(box);
    const door = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(w - 0.06, h - 0.06)), new THREE.LineBasicMaterial({ color: '#4a545b' }));
    door.position.set(pos[0], pos[1], pos[2] + d / 2 + 0.002);
    g.add(door);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.52, h * 0.3),
      new THREE.MeshStandardMaterial({ color: '#0b1a2a', emissive: '#1e6fb8', emissiveIntensity: 0.45, roughness: 0.2 }));
    screen.position.set(pos[0], pos[1] + h * 0.18, pos[2] + d / 2 + 0.004);
    g.add(screen);
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 8), new THREE.MeshStandardMaterial({ color: '#111', emissive: '#34444e', emissiveIntensity: 1.3 }));
    led.position.set(pos[0] - w * 0.3, pos[1] - h * 0.12, pos[2] + d / 2 + 0.01);
    g.add(led);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.14, 0.03), m.steel);
    handle.position.set(pos[0] + w * 0.38, pos[1], pos[2] + d / 2 + 0.02);
    g.add(handle);
    this.statusLed = led;
    this.screen = screen;
    return box;
  }

  /** Pick + anchors + bindings for the machine's point set on `obj`. */
  _machinePick(obj, title) {
    const has = this.has;
    const pts = ['CH.SS', 'CH.STS', 'CH.LOAD', 'CH.FLT', 'CH.FLOW', 'CH.CWFLOW', 'CH.SP'].filter((x) => has(x));
    obj.userData.pick = { title, points: pts };
    for (const sfx of ['CH.SS', 'CH.STS', 'CH.LOAD']) if (has(sfx)) this.anchors.set(sfx, obj);
    for (const sfx of pts) this._bind(sfx);
    for (const c of this.parts.comps || []) if (c.sfx && has(c.sfx)) this._bind(c.sfx);
    if (has('CH.CF')) this._bind('CH.CF');
  }

  _kpiDefs() {
    return [['CH.CHWS', 'CHW supply', '°F'], ['CH.SP', 'Setpoint', '°F'], ['CH.CHWR', 'CHW return', '°F'], ['CH.LOAD', 'Load', '%'],
      ...(this.kind === 'chiller-wc' ? [['CH.CWS', 'CW entering', '°F'], ['CH.CWR', 'CW leaving', '°F']] : [['CH.OAT', 'Ambient', '°F']])];
  }

  _modeDefs() {
    const p = this.parts.pumps[0];
    return [[pick(this.has, ['CH.STS', 'CH.SS']), 'Running'], ['CH.FLOW', 'CHW flow'], ['CH.CWFLOW', 'CW flow'], ['CH.FLT', 'Alarm', 1],
      [p && this.has(p.run) ? p.run : null, 'Pump']];
  }
}

// Air-cooled: two long V-coil condenser slabs under a deck of fans (two rows),
// the lower bay holding the scroll compressors (tandem pair per circuit) and
// the insulated shell-and-tube evaporator, the control panel at the far end.
// Chilled water connects at the evaporator end, left.
export class AirChiller3DView extends Chiller3DView {
  constructor(opts) {
    super({ ...opts, size: { h: 2.35, d: 2.2 }, eyebrow: 'Air-cooled chiller', presets: [['overview', 'Overview'], ['unit', 'Compressors'], ['fans', 'Condenser fans']] });
    this.loY = 0.3;
    this.hiY = 0.62;
  }

  _buildUnit() {
    const has = this.has;
    this.inv = { hasRet: false, fans: [], oad: null, ead: null };
    this.parts.comps = [];
    this.parts.condFans = [];
    this._newUnit();
    const secs = [
      { kind: 'pipe', w: 1.2, cap: 'CHW', cabinet: false },
      { kind: 'ch', w: 5.2, cap: 'CHILLER', cabinet: false },
    ];
    this.total = this._layRow(secs, { cabinet: false });
    this.sections = secs;
    const pm = this._pipeMats();
    const { loY, hiY, pipeR: r } = this;
    const zW = 0.42; // the evaporator (and its nozzles) sit toward the front
    for (const s of secs) {
      const g = s.group, w = s.w;
      this._sectionTag(s);
      if (s.kind === 'pipe') {
        this._skid(g, w);
        this._stands(g, w, hiY);
        this._pipe(g, [-w / 2 - 0.6, loY, zW], [w / 2, loY, zW], r, pm.warm);
        this._pipe(g, [-w / 2 - 0.6, hiY, zW], [w / 2, hiY, zW], r, pm.cool);
        if (has('CH.PMP')) {
          this._pump(g, 'CH.PMP', [0, loY, zW], 'Chilled-water pump');
          this._tag(g, [0, loY + 0.5, zW + 0.2], [[runSuffix(has, 'CH.PMP'), 'CHW PUMP', 'onoff']]);
        }
        this._tag(g, [-w / 2 - 0.3, loY - 0.26, zW + 0.12], [['CH.CHWR', 'CHW RTN', '°F']]);
        this._tag(g, [-w / 2 - 0.3, hiY + 0.3, zW + 0.12], [['CH.CHWS', 'CHW SUP', '°F'], ['CH.SP', 'SETPOINT', '°F']]);
        // where a building's chilled-water pipe starts: the supply end, pointing out -x
        this.outletLocal = { x: s.baseX - w / 2 - 0.6, y: hiY, z: zW, w: r * 2.2, h: r * 2.2, dir: [-1, 0, 0] };
        this.returnLocal = { x: s.baseX - w / 2 - 0.6, y: loY, z: zW, r };
      } else this._body(s, pm, zW);
    }
  }

  _body(s, pm, zW) {
    const g = s.group, m = this.m, has = this.has;
    const L = s.w - 0.2, W = this.D, H = this.DH;
    const x0 = -L / 2, x1 = L / 2;
    const galv = new THREE.MeshStandardMaterial({ color: '#8e979d', metalness: 0.7, roughness: 0.42 });
    const frame = new THREE.MeshStandardMaterial({ color: '#9fa7ac', metalness: 0.4, roughness: 0.55 });
    const box = (sx, sy, sz, x, y, z, mat = frame) => { const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat); b.position.set(x, y, z); b.castShadow = true; b.receiveShadow = true; g.add(b); return b; };
    // base rails and cross members
    for (const z of [-W / 2 + 0.06, W / 2 - 0.06]) box(L, 0.12, 0.1, 0, 0.06, z, galv);
    for (let x = x0 + 0.1; x <= x1; x += L / 4) box(0.08, 0.08, W - 0.1, x, 0.05, 0, galv);
    // corner posts, the mid-height deck the coils stand on, the top frame
    const bay = 0.95;
    for (const x of [x0 + 0.04, x1 - 0.04]) for (const z of [-W / 2 + 0.04, W / 2 - 0.04]) box(0.08, H, 0.08, x, H / 2, z);
    box(L, 0.05, W, 0, bay, 0, galv);
    for (const z of [-W / 2 + 0.04, W / 2 - 0.04]) box(L, 0.08, 0.08, 0, H - 0.04, z);
    // lower bay: louvred back, glass front so the compressors show
    const louv = new THREE.MeshStandardMaterial({ color: '#7f888e', metalness: 0.45, roughness: 0.5, side: THREE.DoubleSide });
    for (let y = 0.18; y < bay - 0.05; y += 0.07) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(L - 0.12, 0.05, 0.01), louv);
      l.rotation.x = 0.5;
      l.position.set(0, y, -W / 2 + 0.02);
      g.add(l);
    }
    const front = new THREE.Mesh(new THREE.PlaneGeometry(L - 0.1, bay - 0.14), m.glass.clone());
    front.material.opacity = 0.07;
    front.position.set(0, (bay + 0.12) / 2, W / 2 - 0.01);
    g.add(front);
    s.skins = [front];

    // ---- the evaporator: insulated shell-and-tube, CHW nozzles at the left end ----
    const evL = Math.min(2.6, L * 0.5), evR = 0.27, evY = (this.loY + this.hiY) / 2;
    const insul = new THREE.MeshStandardMaterial({ color: '#111417', metalness: 0.02, roughness: 0.95, envMapIntensity: 0.3 });
    const ev = new THREE.Mesh(new THREE.CylinderGeometry(evR, evR, evL, 32), insul);
    ev.rotation.z = Math.PI / 2;
    ev.position.set(x0 + 0.25 + evL / 2, evY, zW);
    ev.castShadow = true;
    g.add(ev);
    for (const t of [0.2, 0.5, 0.8]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(evR + 0.004, 0.006, 6, 32), m.steel);
      band.rotation.y = Math.PI / 2;
      band.position.set(x0 + 0.25 + evL * t, evY, zW);
      g.add(band);
    }
    for (const sx of [0, 1]) {
      const head = new THREE.Mesh(new THREE.SphereGeometry(evR, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), insul);
      head.scale.set(1, 0.35, 1);
      head.rotation.z = sx ? -Math.PI / 2 : Math.PI / 2;
      head.position.set(sx ? x0 + 0.25 + evL : x0 + 0.25, evY, zW);
      g.add(head);
    }
    // CHW nozzles out through the end panel, to the section edge
    const { loY, hiY, pipeR: r } = this;
    this._nozzle(g, [x0 + 0.3, loY, zW], [-s.w / 2, loY, zW], r, pm.warm);
    this._nozzle(g, [x0 + 0.3, hiY, zW], [-s.w / 2, hiY, zW], r, pm.cool);
    this._tag(g, [x0 + 0.25 + evL / 2, evY + 0.5, zW + 0.3], [['CH.FLOW', 'CHW FLOW', 'onoff']]);

    // ---- compressors: a tandem pair of scrolls per circuit along the back ----
    const circuits = Math.max(1, Math.min(4, (this.config?.supply || []).find((it) => it.device === 'chiller')?.compressors?.length || 2));
    const compMat = new THREE.MeshStandardMaterial({ color: '#2a3036', metalness: 0.5, roughness: 0.45 });
    const zc = -W / 2 + 0.5;
    const span = L - 1.4, pitch = span / circuits;
    for (let c = 0; c < circuits; c++) {
      const cx = x0 + 0.7 + pitch * (c + 0.5);
      const sfx = `CH.C${c + 1}`;
      const leds = [];
      for (const dx of [-0.22, 0.22]) {
        const body = new THREE.Group();
        const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.5, 24), compMat);
        shell.position.y = 0.25;
        shell.castShadow = true;
        body.add(shell);
        const dome = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), compMat);
        dome.position.y = 0.5;
        body.add(dome);
        const tb = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.08), m.dark);
        tb.position.set(0, 0.34, 0.16);
        body.add(tb);
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.152, 0.152, 0.025, 24),
          new THREE.MeshStandardMaterial({ color: '#3fe08a', emissive: '#3fe08a', emissiveIntensity: 0 }));
        band.position.y = 0.42;
        body.add(band);
        // discharge line up into the coil header, suction in from the side
        const dl = this._pipe(body, [0, 0.6, 0], [0, bay - 0.16, 0], 0.022, m.copper);
        void dl;
        body.position.set(cx + dx, 0.16, zc);
        g.add(body);
        this.parts.comps.push({ sfx: has(sfx) ? sfx : null, band, body, x0: cx + dx, level: 0 });
        leds.push(band);
      }
      // the circuit's suction header back to the evaporator (insulated)
      this._pipe(g, [cx - 0.22, 0.45, zc + 0.18], [cx - 0.22, 0.45, zW - evR - 0.02], 0.035, insul);
      this._tag(g, [cx, 0.95 - 0.12, zc + 0.1], [[sfx, `COMP ${c + 1}`, 'onoff']]);
    }

    // ---- condenser: two long V-coil slabs, fins with copper return bends ----
    const finTex = (() => {
      const cv = document.createElement('canvas');
      cv.width = 64; cv.height = 8;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#7d8990'; cx.fillRect(0, 0, 64, 8);
      cx.fillStyle = '#48535a';
      for (let i = 0; i < 64; i += 2) cx.fillRect(i, 0, 1, 8);
      const t = new THREE.CanvasTexture(cv);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(24, 1);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const finMat = new THREE.MeshStandardMaterial({ color: '#c8d0d4', map: finTex, metalness: 0.5, roughness: 0.55 });
    this._finTex = finTex;
    const Lc = L - 0.2, yb = bay + 0.06, yt = H - 0.1;
    for (const side of [-1, 1]) {
      const zb = side * 0.14, zt = side * (W / 2 - 0.08);
      const dz = zt - zb, dy = yt - yb, sl = Math.hypot(dz, dy);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(Lc, sl, 0.09), finMat);
      slab.rotation.x = Math.atan2(dz, dy) * -1;
      slab.position.set(0, (yb + yt) / 2, (zb + zt) / 2);
      slab.castShadow = true;
      g.add(slab);
      // coil face frame
      const fr = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(Lc, sl, 0.09)), new THREE.LineBasicMaterial({ color: '#7d8a93' }));
      fr.rotation.copy(slab.rotation);
      fr.position.copy(slab.position);
      g.add(fr);
      // return bends at both ends of the slab
      const nb = 9;
      for (const ex of [-1, 1]) {
        for (let i = 0; i < nb; i++) {
          const t = (i + 0.5) / nb;
          const bend = new THREE.Group();
          const u = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.009, 6, 10, Math.PI), m.copper);
          u.rotation.z = ex > 0 ? -Math.PI / 2 : Math.PI / 2;
          bend.add(u);
          bend.rotation.x = slab.rotation.x;
          bend.position.set(ex * (Lc / 2 + 0.005), yb + dy * t, zb + dz * t);
          g.add(bend);
        }
      }
    }
    // V end plates (the air only goes through the coils)
    const vPlate = new THREE.Shape([new THREE.Vector2(-0.14, yb), new THREE.Vector2(0.14, yb), new THREE.Vector2(W / 2 - 0.08, yt), new THREE.Vector2(-(W / 2 - 0.08), yt)]);
    const vGeo = new THREE.ShapeGeometry(vPlate);
    for (const ex of [x0 + 0.06, x1 - 0.06]) {
      const p = new THREE.Mesh(vGeo, new THREE.MeshStandardMaterial({ color: '#8f989e', metalness: 0.4, roughness: 0.55, side: THREE.DoubleSide }));
      p.rotation.y = Math.PI / 2;
      p.position.x = ex;
      g.add(p);
    }

    // ---- fan deck: two rows of propeller fans in venturi shrouds, with guards ----
    const deckY = H;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(L, 0.04, W), new THREE.MeshStandardMaterial({ color: '#848d93', metalness: 0.45, roughness: 0.5 }));
    deck.position.set(0, deckY, 0);
    deck.receiveShadow = true;
    g.add(deck);
    const nPer = Math.max(2, Math.floor(L / 1.12));
    const fanR = Math.min(0.46, (W / 2 - 0.1) / 2 + 0.04);
    const shroudMat = new THREE.MeshStandardMaterial({ color: '#2c3339', metalness: 0.4, roughness: 0.55, side: THREE.DoubleSide });
    const bladeMat = new THREE.MeshStandardMaterial({ color: '#39424a', metalness: 0.3, roughness: 0.5 });
    const guardMat = new THREE.MeshStandardMaterial({ color: '#15191d', metalness: 0.6, roughness: 0.4 });
    for (let i = 0; i < nPer; i++) {
      for (const zr of [-W / 4, W / 4]) {
        const fx = x0 + (L / nPer) * (i + 0.5);
        const fan = new THREE.Group();
        fan.position.set(fx, deckY, zr);
        g.add(fan);
        const hole = new THREE.Mesh(new THREE.CircleGeometry(fanR, 32), new THREE.MeshBasicMaterial({ color: '#07090b' }));
        hole.rotation.x = -Math.PI / 2;
        hole.position.y = 0.022;
        fan.add(hole);
        const shroud = new THREE.Mesh(new THREE.CylinderGeometry(fanR + 0.02, fanR + 0.05, 0.28, 36, 1, true), shroudMat);
        shroud.position.y = 0.16;
        fan.add(shroud);
        const lip = new THREE.Mesh(new THREE.TorusGeometry(fanR + 0.03, 0.02, 8, 36), shroudMat);
        lip.rotation.x = Math.PI / 2;
        lip.position.y = 0.3;
        fan.add(lip);
        const rotor = new THREE.Group();
        rotor.position.y = 0.14;
        for (let b = 0; b < 5; b++) {
          const piv = new THREE.Group();
          piv.rotation.y = (b / 5) * Math.PI * 2;
          const blade = new THREE.Mesh(new THREE.BoxGeometry(fanR * 0.78, 0.012, 0.17), bladeMat);
          blade.position.x = fanR * 0.48;
          blade.rotation.x = 0.42;          // pitch
          piv.add(blade);
          rotor.add(piv);
        }
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.1, 16), m.dark);
        rotor.add(hub);
        fan.add(rotor);
        const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 16), m.dark);
        motor.position.y = 0.04;
        fan.add(motor);
        // wire guard: rings and spokes over the top
        for (const rr of [fanR * 0.35, fanR * 0.68, fanR + 0.01]) {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.006, 4, 32), guardMat);
          ring.rotation.x = Math.PI / 2;
          ring.position.y = 0.33;
          fan.add(ring);
        }
        for (let k = 0; k < 8; k++) {
          const sp = new THREE.Mesh(new THREE.BoxGeometry(fanR * 2, 0.008, 0.008), guardMat);
          sp.rotation.y = (k / 8) * Math.PI;
          sp.position.y = 0.33;
          fan.add(sp);
        }
        this.parts.condFans.push({ rotor, speed: 0, target: 0, order: this.parts.condFans.length });
      }
    }
    this._tag(g, [0, deckY + 0.7, 0], [['CH.CF', 'COND FANS', 'onoff'], ['CH.OAT', 'AMBIENT', '°F']]);

    // ---- control panel at the far end, front ----
    const panel = this._panel(g, [x1 - 0.45, 0.55, W / 2 - 0.16], 0.62, 0.72, 0.22);
    this._machinePick(panel, 'Chiller');
    for (const o of [deck]) o.userData.pick = panel.userData.pick;
    this._tag(g, [x1 - 0.45, 1.35, W / 2 + 0.05], [[pick(has, ['CH.STS', 'CH.SS']), 'CHILLER', 'onoff'], ['CH.LOAD', 'LOAD', '%'], ['CH.FLT', 'ALARM', 'alm']]);
    this.evapX = [s.baseX + x0 + 0.25, s.baseX + x0 + 0.25 + evL];
    this.zW = zW;
  }

  _refreshExtra() {
    super._refreshExtra();
    const st = this.st;
    // condenser fans stage with load; a fan point that reads off stops them all
    const cf = this.has('CH.CF') ? this._num('CH.CF') : NaN;
    const fans = this.parts.condFans || [];
    const nOn = !st.on || (fin(cf) && cf <= 0) ? 0 : Math.max(1, Math.ceil(fans.length * clamp(st.k + 0.15, 0, 1)));
    for (const f of fans) f.target = f.order < nOn ? 100 : 0;
  }

  _frameParts(dt, now) {
    super._frameParts(dt, now);
    for (const f of this.parts.condFans || []) {
      f.speed = damp(f.speed, f.target, 1.1, dt);
      f.rotor.rotation.y -= dt * (f.speed / 100) * Math.PI * 2 * 3.5;
    }
  }

  _paths() {
    const pipe = this._sec('pipe');
    const first = pipe.group.position.x - pipe.w / 2 - 0.6;
    const [ea, eb] = this.evapX;
    const { loY, hiY, zW } = this;
    const W = this.water || {};
    // return in along the bottom, through the evaporator and back, out along the top
    const oa = [[first, loY, zW], [ea, loY, zW], [eb, loY, zW], [eb, hiY, zW], [ea, hiY, zW], [first, hiY, zW]];
    oa.vw = 0.3;
    oa.legT = [W.r, W.r, (W.r + W.s) / 2, W.s, W.s];
    return finish({ oa });
  }

  _shares() { return { oa: 1, rec: 0, rel: 0 }; }

  _refreshAir() {
    const { R, S } = this._chwTemps();
    this.water = { r: this._w(R), s: this._w(S) };
    this.vals = { oat: this.water.r, rat: this.water.s, mix: this.water.r };
    this.tempStations = [];
  }

  _presetView(name, instant = false) {
    const s = this._sec('ch');
    if (!s || (name !== 'unit' && name !== 'fans')) return super._presetView(name, instant);
    const x = s.group.position.x;
    if (name === 'fans') return this._tween(name, new THREE.Vector3(x, this.DH, 0), new THREE.Vector3(x - 2.2, this.DH + 3.4, 3.6), instant);
    return this._tween(name, new THREE.Vector3(x, 0.5, -0.3), new THREE.Vector3(x + 1.4, 1.5, 3.8), instant);
  }
}

// Water-cooled centrifugal: evaporator (insulated) and condenser shells side by
// side between two tube sheets; waterboxes and the four nozzles at the left
// end; on top, the compressor — inlet guide vane housing, impeller volute —
// driven by the hermetic motor, with the suction elbow down to the evaporator
// and the discharge into the condenser; economizer, oil sump, the starter
// cabinet at the right end and the control panel on the evaporator side.
export class CentrifugalChiller3DView extends Chiller3DView {
  constructor(opts) {
    super({ ...opts, size: { h: 2.9, d: 2.2 }, eyebrow: 'Centrifugal chiller', presets: [['overview', 'Overview'], ['unit', 'Compressor'], ['pump', 'Pumps']] });
    this.loY = 0.42;
    this.hiY = 0.86;
  }

  _buildUnit() {
    const has = this.has;
    this.inv = { hasRet: false, fans: [], oad: null, ead: null };
    this.parts.comps = [];
    this._newUnit();
    const secs = [
      { kind: 'pipe', w: 1.5, cap: 'PUMPS', cabinet: false },
      { kind: 'ch', w: 5.8, cap: 'CHILLER', cabinet: false },
    ];
    this.total = this._layRow(secs, { cabinet: false });
    this.sections = secs;
    const pm = this._pipeMats();
    this.zE = 0.5;      // evaporator on the front
    this.zC = -0.52;    // condenser behind it
    const { loY, hiY, pipeR: r, zE, zC } = this;
    const cw = { hot: new THREE.MeshStandardMaterial({ color: '#8a6a3a', metalness: 0.5, roughness: 0.45 }) };
    for (const s of secs) {
      const g = s.group, w = s.w;
      this._sectionTag(s);
      if (s.kind === 'pipe') {
        this._skid(g, w);
        for (const z of [zE, zC]) {
          for (const x of [-w * 0.32, w * 0.32]) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, hiY, 8), this.m.rail);
            post.position.set(x, hiY / 2, z - 0.16);
            g.add(post);
          }
        }
        // chilled water (front) and condenser water (back), returns low, supplies high
        this._pipe(g, [-w / 2 - 0.6, loY, zE], [w / 2, loY, zE], r, pm.warm);
        this._pipe(g, [-w / 2 - 0.6, hiY, zE], [w / 2, hiY, zE], r, pm.cool);
        this._pipe(g, [-w / 2 - 0.6, loY, zC], [w / 2, loY, zC], r, pm.warm);
        this._pipe(g, [-w / 2 - 0.6, hiY, zC], [w / 2, hiY, zC], r, cw.hot);
        if (has('CH.PMP')) {
          this._pump(g, 'CH.PMP', [0.1, loY, zE], 'Chilled-water pump');
          this._tag(g, [0.1, loY + 0.5, zE + 0.25], [[runSuffix(has, 'CH.PMP'), 'CHW PUMP', 'onoff']]);
        }
        if (has('CH.CWP')) {
          this._pump(g, 'CH.CWP', [-0.2, loY, zC], 'Condenser-water pump');
          this._tag(g, [-0.2, loY + 0.5, zC - 0.25], [[runSuffix(has, 'CH.CWP'), 'CW PUMP', 'onoff']]);
        }
        this._tag(g, [-w / 2 - 0.35, loY - 0.26, zE + 0.12], [['CH.CHWR', 'CHW RTN', '°F']]);
        this._tag(g, [-w / 2 - 0.35, hiY + 0.3, zE + 0.12], [['CH.CHWS', 'CHW SUP', '°F'], ['CH.SP', 'SETPOINT', '°F']]);
        this._tag(g, [-w / 2 - 0.35, loY - 0.26, zC - 0.12], [['CH.CWS', 'CW ENT', '°F']]);
        this._tag(g, [-w / 2 - 0.35, hiY + 0.3, zC - 0.12], [['CH.CWR', 'CW LVG', '°F']]);
        this.outletLocal = { x: s.baseX - w / 2 - 0.6, y: hiY, z: zE, w: r * 2.2, h: r * 2.2, dir: [-1, 0, 0] };
        this.returnLocal = { x: s.baseX - w / 2 - 0.6, y: loY, z: zE, r };
        // condenser water from the tower comes in here (the CW entering line's open end), leaves from the CW leaving line
        this.coilPorts.push({ g, cond: true, local: [-w / 2 - 0.6, loY, zC], retLocal: [-w / 2 - 0.6, hiY, zC], r, dir: [-1, 0, 0] });
      } else this._body(s, pm, cw);
    }
  }

  _body(s, pm, cw) {
    const g = s.group, m = this.m, has = this.has;
    const { loY, hiY, pipeR: r, zE, zC } = this;
    const tubeL = 4.0, xa = -s.w / 2 + 0.65, xb = xa + tubeL; // tube sheet positions
    const rE = 0.5, rC = 0.46, yE = 0.64, yC = 0.66;
    const paint = new THREE.MeshStandardMaterial({ color: '#40607a', metalness: 0.45, roughness: 0.45 });
    const insul = new THREE.MeshStandardMaterial({ color: '#1a1e22', metalness: 0.05, roughness: 0.9 });
    const cyl = (rad, len, mat, x, y, z, seg = 40) => {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, seg), mat);
      c.rotation.z = Math.PI / 2;
      c.position.set(x, y, z);
      c.castShadow = true; c.receiveShadow = true;
      g.add(c);
      return c;
    };
    // shells
    const evap = cyl(rE, tubeL, insul, (xa + xb) / 2, yE, zE);
    const cond = cyl(rC, tubeL, paint, (xa + xb) / 2, yC, zC);
    for (const t of [0.15, 0.38, 0.62, 0.85]) {
      const seam = new THREE.Mesh(new THREE.TorusGeometry(rE + 0.004, 0.007, 6, 40), m.steel);
      seam.rotation.y = Math.PI / 2;
      seam.position.set(xa + tubeL * t, yE, zE);
      g.add(seam);
    }
    // tube sheets holding both shells, and the feet under them
    for (const x of [xa, xb]) {
      const ts = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.36, 2.12), paint);
      ts.position.set(x, 0.7, (zE + zC) / 2);
      ts.castShadow = true;
      g.add(ts);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 2.2), m.rail);
      foot.position.set(x, 0.04, (zE + zC) / 2);
      g.add(foot);
    }
    // waterboxes: compact dished heads bolted on — nozzles at the left end,
    // return heads (2-pass) at the right
    const bolts = (x, y, z, rad) => {
      const fl = new THREE.Mesh(new THREE.TorusGeometry(rad + 0.03, 0.035, 8, 40), paint);
      fl.rotation.y = Math.PI / 2;
      fl.position.set(x, y, z);
      g.add(fl);
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.1, 6), m.steel);
        b.rotation.z = Math.PI / 2;
        b.position.set(x, y + Math.sin(a) * (rad + 0.03), z + Math.cos(a) * (rad + 0.03));
        g.add(b);
      }
    };
    for (const [z, y, rad, mat] of [[zE, yE, rE, insul], [zC, yC, rC, paint]]) {
      for (const [x, dir] of [[xa, -1], [xb, 1]]) {
        const box = cyl(rad, 0.22, dir < 0 ? paint : mat, x + dir * 0.14, y, z);
        void box;
        const dish = new THREE.Mesh(new THREE.SphereGeometry(rad, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), paint);
        dish.scale.set(1, 0.28, 1);
        dish.rotation.z = dir < 0 ? Math.PI / 2 : -Math.PI / 2;
        dish.position.set(x + dir * 0.25, y, z);
        g.add(dish);
        bolts(x + dir * 0.035, y, z, rad);
      }
    }
    // nozzles out of the left waterboxes (grooved, with couplings), to the section edge
    const left = -s.w / 2;
    this._nozzle(g, [xa - 0.2, loY, zE], [left, loY, zE], r, pm.warm);
    this._nozzle(g, [xa - 0.2, hiY, zE], [left, hiY, zE], r, pm.cool);
    this._nozzle(g, [xa - 0.2, loY, zC], [left, loY, zC], r, pm.warm);
    this._nozzle(g, [xa - 0.2, hiY, zC], [left, hiY, zC], r, cw.hot);

    // ---- the compressor and motor on top ----
    const top = Math.max(yE + rE, yC + rC);
    const yK = top + 0.62, zK = -0.05;
    const cast = new THREE.MeshStandardMaterial({ color: '#4a6883', metalness: 0.55, roughness: 0.4 });
    // saddle the compressor sits on
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 1.1), paint);
    saddle.position.set(xa + 2.0, top + 0.02, zK);
    g.add(saddle);
    // impeller volute (a scroll-shaped casing) and its inlet guide vane housing
    const xV = xa + 1.35;
    const vol = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.2, 16, 40), cast);
    vol.rotation.y = Math.PI / 2;
    vol.position.set(xV, yK, zK);
    vol.castShadow = true;
    g.add(vol);
    const disc = cyl(0.42, 0.34, cast, xV, yK, zK);
    void disc;
    const igv = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 0.42, 32), cast);
    igv.rotation.z = Math.PI / 2;
    igv.position.set(xV - 0.38, yK, zK);
    g.add(igv);
    const igvAct = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.16, 0.12), m.dark);
    igvAct.position.set(xV - 0.4, yK + 0.3, zK);
    g.add(igvAct);
    // suction: elbow from the inlet down into the top of the evaporator
    const suction = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(xV - 0.6, yK, zK), new THREE.Vector3(xV - 1.05, yK, zK), new THREE.Vector3(xV - 1.05, yE + rE - 0.05, zE));
    const sp = new THREE.Mesh(new THREE.TubeGeometry(suction, 24, 0.19, 20, false), paint);
    sp.castShadow = true;
    g.add(sp);
    // discharge: off the volute rim, over and down into the condenser
    const discharge = new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(xV, yK + 0.32, zK - 0.25), new THREE.Vector3(xV + 0.35, yK + 0.5, zC), new THREE.Vector3(xV + 0.55, yC + rC - 0.05, zC));
    const dp = new THREE.Mesh(new THREE.TubeGeometry(discharge, 24, 0.15, 18, false), paint);
    dp.castShadow = true;
    g.add(dp);
    // hermetic motor behind the compressor, with cooling ribs and terminal box
    const xM = xV + 0.95;
    const motor = cyl(0.38, 0.95, new THREE.MeshStandardMaterial({ color: '#2e3a45', metalness: 0.5, roughness: 0.45 }), xM, yK, zK);
    for (let k = 0; k < 7; k++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.385, 0.012, 6, 36), m.dark);
      rib.rotation.y = Math.PI / 2;
      rib.position.set(xM - 0.4 + k * 0.133, yK, zK);
      g.add(rib);
    }
    const tbox = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.22, 0.3), m.dark);
    tbox.position.set(xM, yK + 0.44, zK);
    g.add(tbox);
    // the running band on the motor end (lights with load)
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.05, 36),
      new THREE.MeshStandardMaterial({ color: '#3fe08a', emissive: '#3fe08a', emissiveIntensity: 0 }));
    band.rotation.z = Math.PI / 2;
    band.position.set(xM + 0.5, yK, zK);
    g.add(band);
    this.parts.comps.push({ sfx: has('CH.C1') ? 'CH.C1' : null, band, body: null, x0: 0, level: 0 });
    // oil sump and pump under the compressor
    const sump = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.28, 0.42), m.dark);
    sump.position.set(xV + 0.2, top + 0.22, zK + 0.45);
    g.add(sump);
    // economizer (flash tank) between the shells at the right
    const eco = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.9, 24), paint);
    eco.position.set(xb - 0.55, top + 0.35, zK);
    eco.castShadow = true;
    g.add(eco);
    for (const y of [top + 0.8, top - 0.1]) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), paint);
      cap.scale.y = 0.4;
      if (y < top) cap.rotation.x = Math.PI;
      cap.position.set(xb - 0.55, y, zK);
      g.add(cap);
    }
    // liquid line: condenser bottom → economizer → evaporator
    this._pipe(g, [xb - 0.8, yC - rC + 0.05, zC], [xb - 0.8, yC - rC - 0.06, zC], 0.045, m.copper);
    this._pipe(g, [xb - 0.8, yC - rC - 0.06, zC], [xb - 0.8, yC - rC - 0.06, zE], 0.045, m.copper);
    // relief valves on the shells
    for (const [x, z, y] of [[xa + 0.6, zC, yC + rC], [xa + 3.2, zE, yE + rE]]) {
      const rv = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.18, 12), m.brass);
      rv.position.set(x, y + 0.09, z);
      g.add(rv);
    }
    // starter (VFD) cabinet at the right end, control panel on the evaporator side
    const starter = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.9, 1.05), new THREE.MeshStandardMaterial({ color: '#9aa3a9', metalness: 0.4, roughness: 0.5 }));
    starter.position.set(xb + 0.62, 0.95, zC + 0.2);
    starter.castShadow = true;
    g.add(starter);
    for (let k = 0; k < 5; k++) {
      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.04, 0.6), m.dark);
      vent.position.set(xb + 0.94, 1.4 + k * 0.08, zC + 0.2);
      g.add(vent);
    }
    const panel = this._panel(g, [xa + 1.0, 1.45, zE + rE + 0.2], 0.6, 0.8, 0.2);
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.12), m.rail);
    bracket.position.set(xa + 1.0, 1.0, zE + rE + 0.1);
    g.add(bracket);
    this._machinePick(panel, 'Chiller');
    for (const o of [motor, vol, starter]) o.userData.pick = panel.userData.pick;
    this._tag(g, [xM, yK + 0.85, zK], [[pick(has, ['CH.STS', 'CH.SS']), 'CHILLER', 'onoff'], ['CH.LOAD', 'LOAD', '%'], ['CH.FLT', 'ALARM', 'alm']]);
    this._tag(g, [(xa + xb) / 2, yE - 0.1, zE + rE + 0.15], [['CH.FLOW', 'CHW FLOW', 'onoff']]);
    this._tag(g, [(xa + xb) / 2, yC + 0.2, zC - rC - 0.15], [['CH.CWFLOW', 'CW FLOW', 'onoff']]);
    this.evapX = [s.baseX + xa, s.baseX + xb];
    this.kY = yK;
    void evap; void cond;
  }

  _paths() {
    const pipe = this._sec('pipe');
    const first = pipe.group.position.x - pipe.w / 2 - 0.6;
    const [ea, eb] = this.evapX;
    const { loY, hiY, zE, zC } = this;
    const W = this.water || {};
    const loop = (z) => [[first, loY, z], [ea, loY, z], [eb, loY, z], [eb, hiY, z], [ea, hiY, z], [first, hiY, z]];
    const oa = loop(zE);
    oa.vw = 0.3;
    oa.legT = [W.r, W.r, (W.r + W.s) / 2, W.s, W.s];
    const rec = loop(zC);
    rec.vw = 0.3;
    rec.legT = [W.ce, W.ce, (W.ce + W.cl) / 2, W.cl, W.cl];
    return finish({ oa, rec });
  }

  _shares() { return { oa: 0.5, rec: 0.5, rel: 0 }; }

  _refreshAir() {
    const n = (s) => this._num(s);
    const { R, S } = this._chwTemps();
    const k = this.st?.k ?? 0;
    const CE = fin(n('CH.CWS')) ? n('CH.CWS') : 85;
    const CL = fin(n('CH.CWR')) ? n('CH.CWR') : CE + 10 * (k || 0.1);
    this.water = { r: this._w(R), s: this._w(S), ce: this._w(CE), cl: this._w(CL) };
    this.vals = { oat: this.water.r, rat: this.water.s, mix: this.water.r };
    this.tempStations = [];
  }

  _presetView(name, instant = false) {
    const s = name === 'unit' ? this._sec('ch') : name === 'pump' ? this._sec('pipe') : null;
    if (!s) return super._presetView(name, instant);
    const x = s.group.position.x;
    if (name === 'unit') return this._tween(name, new THREE.Vector3(x - 0.4, this.kY || 1.8, 0), new THREE.Vector3(x + 1.6, (this.kY || 1.8) + 1.6, 4.2), instant);
    return this._tween(name, new THREE.Vector3(x, 0.7, 0), new THREE.Vector3(x - 1.4, 2.0, 3.6), instant);
  }
}

// ---------------------------------------------------------------------------
// Cooling tower: induced-draft crossflow, one fan per cell (BAC Series 3000 /
// Marley NC style). Air is pulled in through the louvres on both long sides,
// across the fill the hot water falls through, and up out of the fan stack.
// ---------------------------------------------------------------------------

export class Tower3DView extends Plant3DView {
  constructor(opts) {
    super({ ...opts, size: { h: 6.6, d: 7.4 }, eyebrow: 'Cooling tower', presets: [['overview', 'Overview'], ['unit', 'Fans'], ['pump', 'Basin']] });
    this.shift = 0;
    this.legendRange = ['40°F', '100°F'];
    this.pipeR = 0.16;
    this.loY = 0.6;
    this.hiY = 1.35;
  }

  _buildUnit() {
    const has = this.has;
    this.inv = { hasRet: false, fans: [], oad: null, ead: null };
    this.parts.towerFans = [];
    this.films = [];
    this._newUnit();
    const tw = (this.config?.supply || []).find((it) => it.device === 'tower') || {};
    this.cells = Math.max(1, Math.min(4, tw.cells || (tw.fans || []).length || 1));
    const cellL = 4.9;
    const secs = [
      { kind: 'pipe', w: 1.6, cap: 'CW', cabinet: false },
      { kind: 'ct', w: this.cells * cellL + 1.2, cap: 'COOLING TOWER', cabinet: false },
    ];
    this.total = this._layRow(secs, { cabinet: false });
    this.sections = secs;
    const pm = this._pipeMats();
    const cwPaint = new THREE.MeshStandardMaterial({ color: '#3f7d5a', metalness: 0.4, roughness: 0.5 });
    const cwHot = new THREE.MeshStandardMaterial({ color: '#7d6a3f', metalness: 0.4, roughness: 0.5 });
    const { loY, hiY, pipeR: r } = this;
    for (const s of secs) {
      const g = s.group, w = s.w;
      this._sectionTag(s);
      if (s.kind === 'pipe') {
        this._skid(g, w);
        // CW return (hot, from the chillers) in high, CW supply (cold, to them) out low
        this._pipe(g, [-w / 2 - 0.6, hiY, 0.6], [w / 2, hiY, 0.6], r, cwHot);
        this._pipe(g, [-w / 2 - 0.6, loY, -0.6], [w / 2, loY, -0.6], r, cwPaint);
        for (const [y, z] of [[hiY, 0.6], [loY, -0.6]]) for (const x of [-w * 0.3, w * 0.3]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, y, 8), this.m.rail);
          post.position.set(x, y / 2, z);
          g.add(post);
        }
        if (has('CT.BYP')) {
          this._cvalve(g, 'CT.BYP', [0.1, hiY, 0.6], 'Tower bypass valve');
          this._tag(g, [0.1, hiY + 0.75, 0.7], [['CT.BYP', 'BYPASS', '%']]);
        }
        this._tag(g, [-w / 2 - 0.3, hiY + 0.4, 0.7], [['CT.CWR', 'CW RTN', '°F']]);
        this._tag(g, [-w / 2 - 0.3, loY - 0.3, -0.7], [['CT.CWS', 'CW SUP', '°F'], ['CT.SP', 'SETPOINT', '°F']]);
        this.outletLocal = { x: s.baseX - w / 2 - 0.6, y: loY, z: -0.6, w: r * 2.2, h: r * 2.2, dir: [-1, 0, 0] };
        this.returnLocal = { x: s.baseX - w / 2 - 0.6, y: hiY, z: 0.6, r };
      } else this._tower(s, cellL, pm, cwPaint, cwHot);
    }
  }

  /**
   * A multi-cell induced-draft tower, as in the user's photo: a panelised
   * casing (crisp seams and outline) on the cold-water basin, air-inlet
   * louvres in a band along both long sides with the rain zone behind them, a
   * fan deck with a handrail all round and a caged ladder, and per cell a
   * fan stack with its guard, the fan inside and the drive on a bridge at the
   * centre. The fans turn only on a live proof (_refreshExtra); water shows
   * falling behind the louvres only while the tower is proven rejecting heat.
   */
  _tower(s, cellL, pm, cwPaint, cwHot) {
    const g = s.group, m = this.m, has = this.has;
    const n = this.cells, L = n * cellL, W = this.D;
    const x0 = -L / 2, x1 = L / 2;
    const H = 4.4, yb = 0.35, basinTop = 0.95, louvTop = 2.25;
    const full = !this.embedded && this.tier !== 'low';
    const casing = new THREE.MeshStandardMaterial({ color: '#7f9db2', metalness: 0.15, roughness: 0.68 });
    const louvM = new THREE.MeshStandardMaterial({ color: '#6f8a9c', metalness: 0.2, roughness: 0.6 });
    const deck = new THREE.MeshStandardMaterial({ color: '#7d93a3', metalness: 0.2, roughness: 0.7 });
    const basinM = new THREE.MeshStandardMaterial({ color: '#7f8589', metalness: 0.1, roughness: 0.85 });
    const galv = new THREE.MeshStandardMaterial({ color: '#b3babf', metalness: 0.65, roughness: 0.4 });
    const steel = new THREE.MeshStandardMaterial({ color: '#3a4550', metalness: 0.6, roughness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: '#1f272d', metalness: 0.2, roughness: 0.8 });
    const lines = [];
    const seg = (a, b) => lines.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    const rectX = (x, y0, y1, z0, z1) => { seg([x, y0, z0], [x, y0, z1]); seg([x, y0, z1], [x, y1, z1]); seg([x, y1, z1], [x, y1, z0]); seg([x, y1, z0], [x, y0, z0]); };
    const rectZ = (z, y0, y1, xa, xb) => { seg([xa, y0, z], [xb, y0, z]); seg([xb, y0, z], [xb, y1, z]); seg([xb, y1, z], [xa, y1, z]); seg([xa, y1, z], [xa, y0, z]); };
    const merge = {};                                   // material name → geometries (one mesh each)
    const add = (mat, geo) => { (merge[mat.uuid] ||= { mat, geos: [] }).geos.push(geo); };
    const box = (sx, sy, sz, x, y, z, mat) => add(mat, new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z));

    // dunnage steel and the cold-water basin
    for (const z of [-W / 2 + 0.4, 0, W / 2 - 0.4]) box(L + 0.5, 0.3, 0.22, 0, 0.15, z, steel);
    box(L + 0.24, basinTop - yb, W + 0.24, 0, (yb + basinTop) / 2, 0, basinM);
    rectZ(W / 2 + 0.121, yb, basinTop, x0 - 0.12, x1 + 0.12); rectZ(-W / 2 - 0.121, yb, basinTop, x0 - 0.12, x1 + 0.12);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(L - 0.1, W - 0.1),
      new THREE.MeshStandardMaterial({ color: '#1f6f9a', metalness: 0.2, roughness: 0.15, transparent: true, opacity: 0.8 }));
    water.rotation.x = -Math.PI / 2;
    water.position.y = basinTop - 0.12;
    g.add(water);
    this.basinWater = water;

    // casing: end walls full height, long sides above the louvre band; panels about 1.2 m wide, seams outlined
    const bays = Math.max(2, Math.round(L / 1.25));
    const bw = L / bays;
    for (const side of [-1, 1]) {
      const z = side * W / 2;
      box(L, H - louvTop, 0.06, 0, (louvTop + H) / 2, z - side * 0.03, casing);
      rectZ(z + side * 0.002, louvTop, H, x0, x1);
      for (let i = 1; i < bays; i++) seg([x0 + i * bw, louvTop, z + side * 0.002], [x0 + i * bw, H, z + side * 0.002]);
      seg([x0, (louvTop + H) / 2, z + side * 0.002], [x1, (louvTop + H) / 2, z + side * 0.002]);
    }
    for (const x of [x0, x1]) {
      box(0.06, H - basinTop, W, x, (H + basinTop) / 2, 0, casing);
      const sx = Math.sign(x) * 0.002;
      rectX(x + sx, basinTop, H, -W / 2, W / 2);
      const nb = Math.max(2, Math.round(W / 1.25));
      for (let i = 1; i < nb; i++) seg([x + sx, basinTop, -W / 2 + (W * i) / nb], [x + sx, H, -W / 2 + (W * i) / nb]);
      for (const y of [louvTop, (louvTop + H) / 2]) seg([x + sx, y, -W / 2], [x + sx, y, W / 2]);
    }
    // corner posts
    for (const x of [x0, x1]) for (const z of [-W / 2, W / 2]) box(0.1, H - basinTop, 0.1, x, (H + basinTop) / 2, z, galv);

    // air-inlet louvres along both long sides: blades in bays, mullions between, the dark rain zone behind
    const louvH = louvTop - basinTop - 0.1;
    const nBl = full ? Math.round(louvH / 0.16) : 3;
    for (const side of [-1, 1]) {
      const z = side * (W / 2 - 0.03);
      box(L - 0.1, louvH, 0.04, 0, basinTop + 0.05 + louvH / 2, side * (W / 2 - 0.5), dark);        // rain zone backdrop
      for (let i = 0; i <= bays; i++) box(0.06, louvH + 0.08, 0.14, x0 + i * bw, basinTop + 0.05 + louvH / 2, z, galv);
      for (let k = 0; k < nBl; k++) {
        const bl = new THREE.BoxGeometry(L - 0.12, 0.018, 0.22).rotateX(side * 0.62).translate(0, basinTop + 0.12 + (k + 0.5) * (louvH / nBl), z);
        add(louvM, bl);
      }
      rectZ(side * W / 2 + side * 0.08, basinTop + 0.05, louvTop - 0.05, x0, x1);
    }

    // falling water in the rain zone, seen through the louvres (only while proven rejecting heat)
    const filmTex = (() => {
      const cv = document.createElement('canvas');
      cv.width = 32; cv.height = 128;
      const c2 = cv.getContext('2d');
      for (let i = 0; i < 40; i++) {
        const x = (i * 7.3) % 32, y = (i * 29.1) % 128, len = 8 + ((i * 13) % 20);
        const gr = c2.createLinearGradient(0, y, 0, y + len);
        gr.addColorStop(0, 'rgba(180,225,255,0)'); gr.addColorStop(1, 'rgba(180,225,255,0.9)');
        c2.fillStyle = gr; c2.fillRect(x, y, 1.5, len);
      }
      const t = new THREE.CanvasTexture(cv);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return t;
    })();
    this._texes = [filmTex];
    const fillY = basinTop + 0.05 + louvH / 2;
    for (const side of [-1, 1]) {
      const tex = filmTex.clone(); tex.needsUpdate = true; tex.repeat.set(L / 1.2, louvH / 2.4);
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const film = new THREE.Mesh(new THREE.PlaneGeometry(L - 0.12, louvH - 0.05), mat);
      film.position.set(0, fillY, side * (W / 2 - 0.4));
      if (side < 0) film.rotation.y = Math.PI;
      g.add(film);
      this.films.push({ tex, mat });
    }

    // the fan deck
    box(L + 0.1, 0.1, W + 0.1, 0, H + 0.05, 0, deck);
    rectZ(W / 2 + 0.051, H, H + 0.1, x0 - 0.05, x1 + 0.05); rectZ(-W / 2 - 0.051, H, H + 0.1, x0 - 0.05, x1 + 0.05);
    for (let i = 1; i < n; i++) seg([x0 + i * cellL, H + 0.101, -W / 2], [x0 + i * cellL, H + 0.101, W / 2]);

    // per cell: fan stack, guard, fan, drive on its bridge
    const fr = 1.75, stackH = 1.0, top = H + 0.1 + stackH;
    const stackMat = new THREE.MeshStandardMaterial({ color: '#a9b8c3', metalness: 0.3, roughness: 0.55, side: THREE.DoubleSide });
    const bladeMat = new THREE.MeshStandardMaterial({ color: '#2f363c', metalness: 0.4, roughness: 0.5 });
    const driveMat = new THREE.MeshStandardMaterial({ color: '#c3a46a', metalness: 0.45, roughness: 0.45 });
    for (let i = 0; i < n; i++) {
      const xc = x0 + cellL * (i + 0.5);
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(fr + 0.08, fr + 0.14, stackH, full ? 56 : 24, 1, true), stackMat);
      stack.position.set(xc, H + 0.1 + stackH / 2, 0);
      stack.castShadow = true;
      g.add(stack);
      for (const y of [H + 0.12, top]) { const ring = new THREE.TorusGeometry(fr + (y === top ? 0.1 : 0.15), 0.035, 6, full ? 56 : 24).rotateX(Math.PI / 2).translate(xc, y, 0); add(stackMat, ring); }
      const hole = new THREE.Mesh(new THREE.CircleGeometry(fr + 0.05, full ? 48 : 20), new THREE.MeshBasicMaterial({ color: '#0a0d10' }));
      hole.rotation.x = -Math.PI / 2;
      hole.position.set(xc, H + 0.11, 0);
      g.add(hole);
      // fan guard over the stack: radial spokes and rings
      if (full) {
        for (let k = 0; k < 16; k++) add(galv, new THREE.BoxGeometry(fr, 0.018, 0.018).translate(fr / 2 + 0.05, 0, 0).rotateY((k / 16) * Math.PI * 2).translate(xc, top + 0.02, 0));
        for (const rr of [0.55, 1.0, 1.45]) add(galv, new THREE.TorusGeometry(rr, 0.01, 4, 40).rotateX(Math.PI / 2).translate(xc, top + 0.02, 0));
      }
      // the fan: blades on a hub, low in the stack
      const rotor = new THREE.Group();
      rotor.position.set(xc, H + 0.45, 0);
      const nb = full ? 8 : 4;
      for (let b = 0; b < nb; b++) {
        const piv = new THREE.Group();
        piv.rotation.y = (b / nb) * Math.PI * 2;
        const blade = new THREE.Mesh(new THREE.BoxGeometry(fr - 0.35, 0.03, 0.3), bladeMat);
        blade.position.x = (fr - 0.35) / 2 + 0.3;
        blade.rotation.x = 0.3;
        blade.castShadow = true;
        piv.add(blade);
        rotor.add(piv);
      }
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.26, 24), m.dark);
      rotor.add(hub);
      g.add(rotor);
      // drive: a bridge across the stack, the gear/motor on it at the centre (photo), driveshaft down to the fan
      box(2 * fr + 0.3, 0.14, 0.18, xc, top + 0.1, 0, steel);
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.62, 24), driveMat);
      motor.position.set(xc, top + 0.48, 0);
      motor.castShadow = true;
      g.add(motor);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.05, 24), driveMat);
      cap.position.set(xc, top + 0.8, 0);
      g.add(cap);
      this._pipe(g, [xc, H + 0.58, 0], [xc, top + 0.17, 0], 0.045, m.steel);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.305, 0.305, 0.05, 24), new THREE.MeshStandardMaterial({ color: '#46d3e6', emissive: '#46d3e6', emissiveIntensity: 0 }));
      band.position.set(xc, top + 0.26, 0);
      g.add(band);
      const base = `CTF${i + 1}`;
      const run = runSuffix(has, base), spd = resolveSuffix(has, base, 'speed'), flt = resolveSuffix(has, base, 'fault'), cmd = resolveSuffix(has, base, 'command');
      this.parts.towerFans.push({ rotor, band, run, spd, flt, speed: 0, target: 0 });
      const pts = [...new Set([cmd, spd, run, flt].filter((x) => x && has(x)))];
      for (const o of [stack, motor, hub]) o.userData.pick = { title: `Tower fan ${i + 1}`, points: pts };
      for (const sfx of [cmd, spd, run]) if (sfx && has(sfx)) this.anchors.set(sfx, stack);
      for (const sfx of pts) this._bind(sfx);
      this._tag(g, [xc, top + 1.4, 0], [[run, n > 1 ? `FAN ${i + 1}` : 'FAN', 'onoff'], [spd, 'SPEED', '%'], [flt, 'FAULT', 'alm']]);
    }

    // handrail round the deck (galvanised, as in the photo): posts, top and mid rails, toe board
    const ez = W / 2 - 0.05, ex = L / 2 - 0.05;
    const railAt = (a, b) => { for (const dy of [0.55, 1.07]) add(galv, cyl(a[0], H + 0.1 + dy, a[1], b[0], H + 0.1 + dy, b[1], 0.022)); };
    const cyl = (ax, ay, az, bx, by, bz, r) => {
      const va = new THREE.Vector3(ax, ay, az), vb = new THREE.Vector3(bx, by, bz), len = va.distanceTo(vb);
      const c = new THREE.CylinderGeometry(r, r, len, 8);
      c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize()));
      return c.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    };
    railAt([-ex, -ez], [ex, -ez]); railAt([-ex, ez], [ex, ez]); railAt([-ex, -ez], [-ex, ez]); railAt([ex, -ez], [ex, ez]);
    const nPost = Math.max(2, Math.round(L / 1.5));
    for (let k = 0; k <= nPost; k++) for (const z of [-ez, ez]) add(galv, cyl(-ex + (2 * ex * k) / nPost, H + 0.1, z, -ex + (2 * ex * k) / nPost, H + 1.17, z, 0.024));
    for (let k = 1; k < Math.round(W / 1.5); k++) for (const x of [-ex, ex]) add(galv, cyl(x, H + 0.1, -ez + (2 * ez * k) / Math.round(W / 1.5), x, H + 1.17, -ez + (2 * ez * k) / Math.round(W / 1.5), 0.024));
    for (const z of [-ez, ez]) box(L - 0.1, 0.1, 0.012, 0, H + 0.15, z, galv);
    for (const x of [-ex, ex]) box(0.012, 0.1, W - 0.1, x, H + 0.15, 0, galv);
    // caged access ladder up the far end
    const lx = x1 + 0.35, lz = W / 2 - 1.0;
    for (const dz of [-0.23, 0.23]) add(galv, cyl(lx, 0, lz + dz, lx, H + 1.17, lz + dz, 0.025));
    for (let y = 0.3; y < H + 1.0; y += 0.3) add(galv, cyl(lx, y, lz - 0.23, lx, y, lz + 0.23, 0.015));
    if (full) for (let y = 2.2; y < H + 1.1; y += 0.7) add(galv, new THREE.TorusGeometry(0.38, 0.015, 6, 20, Math.PI).rotateX(Math.PI / 2).rotateY(-Math.PI / 2).translate(lx + 0.0, y, lz));

    // piping: CW return up the near end into the distribution header under the deck; CW supply out of the basin
    const hx = x0 - 0.35, hiY = this.hiY, loY = this.loY, r = this.pipeR;
    const left = -s.w / 2;
    const hy = H - 0.6;
    this._pipe(g, [left, hiY, 0.6], [hx, hiY, 0.6], r, cwHot);
    this._pipe(g, [hx, hiY, 0.6], [hx, hy, 0.6], r, cwHot);
    this._pipe(g, [hx, hy, 0.6], [x0, hy, 0.6], r, cwHot);
    const fv = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), m.brass);
    fv.position.set(hx, hy - 0.5, 0.6);
    g.add(fv);
    this._pipe(g, [left, loY, -0.6], [x0, loY, -0.6], r, cwPaint);
    // makeup water line with its float valve, basin heater, at the far end
    this._pipe(g, [x1 + 0.2, 0.2, -W / 2 + 0.8], [x1 + 0.2, basinTop + 0.25, -W / 2 + 0.8], 0.04, m.copper);
    this._pipe(g, [x1 + 0.2, basinTop + 0.25, -W / 2 + 0.8], [x1 - 0.5, basinTop + 0.25, -W / 2 + 0.8], 0.04, m.copper);
    const mu = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 10), m.brass);
    mu.position.set(x1 - 0.55, basinTop + 0.1, -W / 2 + 0.8);
    g.add(mu);
    const htr = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.2), steel);
    htr.position.set(x1 + 0.2, yb + 0.35, W / 2 - 1.8);
    g.add(htr);
    for (const [o, sfx, t] of [[mu, 'CT.MU', 'Makeup valve'], [htr, 'CT.HTR', 'Basin heater']]) if (has(sfx)) { o.userData.pick = { title: t, points: [sfx] }; this._bind(sfx); }
    this._tag(g, [x1 + 0.3, basinTop + 0.6, -W / 2 + 0.8], [['CT.MU', 'MAKEUP', 'onoff'], ['CT.HTR', 'HEATER', 'onoff'], ['CT.BSN', 'BASIN', '°F']]);
    this._tag(g, [x0 - 0.1, H + 1.4, -W / 2 + 0.3], [['CT.WB', 'WET BULB', '°F'], ['CT.VIB', 'VIBRATION', 'alm']]);
    if (has('CT.VIB')) this._bind('CT.VIB');

    // merged static meshes, and the outline
    for (const { mat, geos } of Object.values(merge)) {
      const mm = new THREE.Mesh(geos.length === 1 ? geos[0] : mergeGeometries(geos.map((x) => (x.index ? x.toNonIndexed() : x)), false), mat);
      mm.castShadow = true; mm.receiveShadow = true;
      g.add(mm);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    g.add(new THREE.LineSegments(lg, m.outline || m.edge));
    const bz = W / 2 - 0.9;
    this.towerDims = { x0: s.baseX + x0, x1: s.baseX + x1, H, fillY, basinTop, bz, hx: s.baseX + hx, hy, louvTop, top, cellL, W };
  }

  _refreshExtra() {
    super._refreshExtra();
    const n = (s) => this._num(s);
    let on = 0;
    for (const f of this.parts.towerFans) {
      const run = n(f.run), spd = f.spd ? n(f.spd) : NaN;
      const going = f.run === f.spd ? spd > 0 : run > 0;
      f.fault = f.flt ? n(f.flt) > 0 : false;
      f.target = going && !f.fault ? (fin(spd) ? clamp(spd, 10, 100) : 100) : 0;
      if (f.target > 0) on++;
    }
    this.vib = this.has('CT.VIB') ? n('CT.VIB') > 0 : false;
    // water is falling through the fill whenever the tower is rejecting heat
    const cwr = n('CT.CWR'), cws = n('CT.CWS');
    this.wet = on ? 1 : fin(cwr) && fin(cws) && cwr - cws > 1 ? 0.6 : 0;
  }

  _frameParts(dt, now) {
    super._frameParts(dt, now);
    for (const f of this.parts.towerFans || []) {
      f.speed = damp(f.speed, f.target, 0.8, dt);           // a big fan spins up slowly
      f.rotor.rotation.y -= dt * (f.speed / 100) * Math.PI * 2 * 2.2;
      f.band.material.emissive.set(f.fault ? '#ff3b2a' : '#46d3e6');
      f.band.material.emissiveIntensity = f.fault ? 1.5 + Math.sin(now / 200) : (f.speed / 100) * 2;
    }
    this.wetK = damp(this.wetK || 0, this.wet || 0, 1.2, dt);
    for (const fl of this.films || []) {
      fl.tex.offset.y += dt * 0.9 * this.wetK;
      fl.mat.opacity = 0.55 * this.wetK;
    }
    if (this.basinWater) this.basinWater.position.y = (this.towerDims?.basinTop ?? 0.95) - 0.12 + Math.sin(now / 700) * 0.004 * this.wetK;
  }

  isRunning() { return (this.parts.towerFans || []).some((f) => f.target > 0) || super.isRunning(); }
  hasFault() { return !!this.vib || (this.parts.towerFans || []).some((f) => f.fault) || super.hasFault(); }
  _flowTarget() { return this.wet ? 0.7 : 0; } // no idle drift: nothing moves without live data

  _paths() {
    const pipe = this._sec('pipe');
    const first = pipe.group.position.x - pipe.w / 2 - 0.6;
    const d = this.towerDims;
    const W = this.water || {};
    const xm = (d.x0 + d.x1) / 2;
    // hot water in, up the riser into the distribution header, spread, falls through the fill to the basin, out cold
    // the water is drawn inside the casing only (header → spread → falling through the fill → basin),
    // seen through the louvres; the pipes carry it out of sight
    void first;
    const oa = [[d.x0 + 0.3, d.hy, 0.3], [xm, d.hy - 0.2, 0], [xm, d.basinTop + 0.1, 0], [d.x0 + 0.4, d.basinTop - 0.1, -0.3]];
    oa.vw = 0.5;
    oa.legT = [W.r, (W.r + W.s) / 2, W.s];
    oa.streakK = 0.25; oa.haze = 0.24;      // water falls as a soft sheet, not drops
    // air: in through the louvres of a middle cell on each side, up through the fill and the fan, out of the stack
    const A = this.airT || { wb: 75, la: 85 };
    const c0 = Math.floor((this.cells - 1) / 2), c1 = this.cells > 1 ? c0 + 1 : c0;
    const air = (c, side) => {
      const x = d.x0 + d.cellL * (c + 0.5), y = (d.basinTop + d.louvTop) / 2;
      // starts inside the louvres (the casing hides the inlet), rises through the fan, spreads out of the stack
      const p = [[x, y, side * d.W * 0.4], [x, y, side * d.W * 0.12], [x, d.H + 0.3, 0], [x, d.top + 0.1, 0], [x, d.top + 3.2, 0]];
      // a soft rising plume: the stack's width at its mouth, spreading as it rises (taper), long streaks, mostly haze
      p.vw = 1.4; p.k = [1.5, 1.8, 0.9, 1.0]; p.kEnd = 3.0; p.taper = true;
      p.water = false; p.widthK = 16; p.fadeEnd = 3.0; p.streakK = 0.125; p.haze = 0.3;
      p.legT = [A.wb, A.wb, (A.wb + A.la) / 2, A.la, A.la];
      return p;
    };
    return finish({ oa, rec: air(c0, 1), rel: air(c1, -1) });
  }

  // water while the tower is proven rejecting heat; air only through a fan proven running
  _shares() {
    const fans = (this.parts.towerFans || []).some((f) => f.target > 0) ? 1 : 0;
    return { oa: this.wet ? 1 : 0, rec: fans, rel: fans };
  }

  _refreshAir() {
    const n = (s) => this._num(s);
    const R = fin(n('CT.CWR')) ? n('CT.CWR') : 95;
    const S = fin(n('CT.CWS')) ? n('CT.CWS') : R - 10 * (this.wet || 0.2);
    this.water = { r: this._w(R), s: this._w(S) };
    // the air's colour: in at the wet bulb (else a few degrees under the cold water), out near saturation
    const wb = fin(n('CT.WB')) ? n('CT.WB') : S - 7;
    this.airT = { wb, la: (wb + R) / 2 + 2 };
    this.vals = { oat: this.water.r, rat: this.water.s, mix: this.water.r };
    this.tempStations = [];
  }

  _presetView(name, instant = false) {
    const s = this._sec('ct'), d = this.towerDims;
    if (!s || !d || (name !== 'unit' && name !== 'pump')) return super._presetView(name, instant);
    const x = s.group.position.x;
    if (name === 'unit') return this._tween(name, new THREE.Vector3(x, d.H + 1.0, 0), new THREE.Vector3(x - 4, d.H + 6.5, 8.5), instant);
    return this._tween(name, new THREE.Vector3(d.x1 - 1, 1.2, -1), new THREE.Vector3(d.x1 + 4, 3.2, -6), instant);
  }

  _kpiDefs() {
    const f = this.parts.towerFans?.[0];
    return [['CT.CWS', 'CW supply', '°F'], ['CT.SP', 'Setpoint', '°F'], ['CT.CWR', 'CW return', '°F'], ['CT.WB', 'Wet bulb', '°F'],
      ['CT.BSN', 'Basin', '°F'], [f?.spd || null, 'Fan speed', '%']];
  }

  _modeDefs() {
    const f = this.parts.towerFans || [];
    return [...f.map((x, i) => [x.run && this.has(x.run) ? x.run : null, f.length > 1 ? `Fan ${i + 1}` : 'Fan']),
      ['CT.HTR', 'Heater'], ['CT.VIB', 'Vibration', 1]];
  }
}

// ---------------------------------------------------------------------------
// Booster pumps: a chilled-water pump station on a housekeeping pad. Base-
// mounted end-suction pumps in parallel: each takes water from the suction
// header through its suction diffuser into the eye of the volute, and sends
// it up through its triple-duty valve into the discharge header. A VFD per
// pump on the stand in front; the CHW return passes straight through behind.
// ---------------------------------------------------------------------------

export class Booster3DView extends Plant3DView {
  constructor(opts) {
    super({ ...opts, size: { h: 2.2, d: 2.8 }, eyebrow: 'Booster pumps', presets: [['overview', 'Overview'], ['unit', 'Pumps'], ['pump', 'Headers']] });
    this.shift = 0;
    this.legendRange = ['40°F', '100°F'];
    this.pipeR = 0.12;
  }

  _buildUnit() {
    const has = this.has;
    this.inv = { hasRet: false, fans: [], oad: null, ead: null };
    this.parts.boosters = [];
    this._newUnit();
    const bp = (this.config?.supply || []).find((it) => it.device === 'booster') || {};
    const n = Math.max(1, Math.min(4, (bp.pumps || []).length || 2));
    this.nPumps = n;
    const secs = [{ kind: 'bp', w: n * 1.5 + 1.4, cap: 'BOOSTER PUMPS', cabinet: false }];
    this.total = this._layRow(secs, { cabinet: false });
    this.sections = secs;
    const s = secs[0], g = s.group, m = this.m, L = s.w;
    this._sectionTag(s);
    const r = this.pipeR;
    const ys = 0.6, yd = 1.75, zH = -0.95, zR = -1.4, zP = -0.35;
    const cold = new THREE.MeshStandardMaterial({ color: '#aeb9bf', metalness: 0.05, roughness: 0.75 }); // insulated CHW
    const steelBlue = new THREE.MeshStandardMaterial({ color: '#2f5f8a', metalness: 0.5, roughness: 0.45 });
    const casing = new THREE.MeshStandardMaterial({ color: '#2f6f8f', metalness: 0.55, roughness: 0.4 });
    const guard = new THREE.MeshStandardMaterial({ color: '#e0a526', metalness: 0.3, roughness: 0.5 });
    // housekeeping pad
    const pad = new THREE.Mesh(new THREE.BoxGeometry(L, 0.15, this.D), new THREE.MeshStandardMaterial({ color: '#6c6862', roughness: 0.95 }));
    pad.position.set(0, 0.075, -0.25);
    pad.receiveShadow = true;
    g.add(pad);
    const edge = -L / 2 - 0.6, edgeR = L / 2 + 0.6;
    // headers: suction (in from the left, capped right), discharge (capped left, out to the right), return straight through
    this._pipe(g, [edge, ys, zH], [L / 2 - 0.35, ys, zH], r, cold);
    this._pipe(g, [-L / 2 + 0.35, yd, zH], [edgeR, yd, zH], r, cold);
    this._pipe(g, [edgeR, ys, zR], [edge, ys, zR], r, cold);
    for (const [x, y] of [[L / 2 - 0.35, ys], [-L / 2 + 0.35, yd]]) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), cold);
      cap.rotation.z = x > 0 ? -Math.PI / 2 : Math.PI / 2;
      cap.position.set(x, y, zH);
      g.add(cap);
    }
    // header supports
    for (let x = -L / 2 + 0.4; x <= L / 2 - 0.3; x += 1.2) for (const [y, z] of [[yd, zH], [ys, zH], [ys, zR]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, y - 0.15, 8), m.rail);
      post.position.set(x, 0.15 + (y - 0.15) / 2, z);
      g.add(post);
    }
    // pressure gauges on the headers
    for (const [x, y] of [[edge + 0.8, ys], [edgeR - 0.8, yd]]) {
      this._pipe(g, [x, y + r, zH], [x, y + r + 0.14, zH], 0.012, m.brass);
      const dial = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.03, 20), m.steel);
      dial.rotation.x = Math.PI / 2;
      dial.position.set(x, y + r + 0.2, zH + 0.02);
      g.add(dial);
    }
    for (let i = 0; i < n; i++) {
      const px = -L / 2 + 0.7 + 1.5 * (i + 0.5);
      // baseplate, volute (axis along z: suction in at the -z eye), motor behind the coupling
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 1.2), m.rail);
      base.position.set(px, 0.2, 0.05);
      g.add(base);
      const vol = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.2, 32), casing);
      vol.rotation.x = Math.PI / 2;
      vol.position.set(px, ys, zP);
      vol.castShadow = true;
      g.add(vol);
      const scroll = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.06, 10, 28, Math.PI * 1.4), casing);
      scroll.position.set(px, ys, zP);
      g.add(scroll);
      const ped = new THREE.Mesh(new THREE.BoxGeometry(0.18, ys - 0.25, 0.16), casing);
      ped.position.set(px, 0.25 + (ys - 0.25) / 2, zP);
      g.add(ped);
      const bracket = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.25, 20), casing);
      bracket.rotation.x = Math.PI / 2;
      bracket.position.set(px, ys, zP + 0.22);
      g.add(bracket);
      // coupling under an open guard (the coupling turns), then the motor
      const coup = new THREE.Group();
      coup.position.set(px, ys, zP + 0.45);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.12, 16), m.steel);
      hub.rotation.x = Math.PI / 2;
      coup.add(hub);
      for (let k = 0; k < 4; k++) {
        const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.1), m.dark);
        jaw.position.set(Math.cos(k * Math.PI / 2) * 0.07, Math.sin(k * Math.PI / 2) * 0.07, 0);
        coup.add(jaw);
      }
      g.add(coup);
      for (const dx of [-0.13, 0.13]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.26, 0.22), guard);
        bar.position.set(px + dx, ys, zP + 0.45);
        g.add(bar);
      }
      const gtop = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.02, 0.22), guard);
      gtop.position.set(px, ys + 0.13, zP + 0.45);
      g.add(gtop);
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.55, 24), steelBlue);
      motor.rotation.x = Math.PI / 2;
      motor.position.set(px, ys, zP + 0.85);
      motor.castShadow = true;
      g.add(motor);
      for (let k = 0; k < 6; k++) {
        const rib = new THREE.Mesh(new THREE.TorusGeometry(0.192, 0.008, 6, 24), m.dark);
        rib.position.set(px, ys, zP + 0.63 + k * 0.08);
        g.add(rib);
      }
      // a thin running ring round the motor's end (not a lit disc)
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.012, 8, 32), new THREE.MeshStandardMaterial({ color: '#1d2a30', emissive: '#46d3e6', emissiveIntensity: 0 }));
      band.position.set(px, ys, zP + 1.1);
      g.add(band);
      const tbox = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.16), m.dark);
      tbox.position.set(px + 0.2, ys + 0.1, zP + 0.85);
      g.add(tbox);
      // suction: header → isolation valve → suction diffuser (strainer body) → the volute's eye
      this._pipe(g, [px, ys, zH], [px, ys, zP - 0.1], r * 0.8, cold);
      const diff = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.3, r * 1.3, 0.28, 20), casing);
      diff.rotation.x = Math.PI / 2;
      diff.position.set(px, ys, zP - 0.3);
      g.add(diff);
      const bfv = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.1, r * 1.1, 0.06, 20), m.dark);
      bfv.rotation.x = Math.PI / 2;
      bfv.position.set(px, ys, zH + 0.25);
      g.add(bfv);
      const lever = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.22), m.brass);
      lever.position.set(px, ys + r + 0.05, zH + 0.25);
      g.add(lever);
      // discharge: up out of the volute through the triple-duty valve, over into the header
      this._pipe(g, [px, ys + 0.24, zP], [px, yd, zP], r * 0.75, cold);
      this._pipe(g, [px, yd, zP], [px, yd, zH], r * 0.75, cold);
      const tdv = new THREE.Mesh(new THREE.SphereGeometry(r * 1.25, 16, 12), m.brass);
      tdv.position.set(px, ys + 0.6, zP);
      g.add(tdv);
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.012, 6, 16), m.dark);
      wheel.position.set(px, ys + 0.6 + 0.2, zP);
      wheel.rotation.x = Math.PI / 2;
      g.add(wheel);
      // VFD on the stand in front of its pump
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.4, 0.05), m.rail);
      stand.position.set(px, 0.85, 0.95);
      g.add(stand);
      const vfd = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.62, 0.22), new THREE.MeshStandardMaterial({ color: '#8e989f', metalness: 0.45, roughness: 0.5 }));
      vfd.position.set(px, 1.3, 0.95);
      vfd.castShadow = true;
      g.add(vfd);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.08), new THREE.MeshStandardMaterial({ color: '#0b1a2a', emissive: '#1e6fb8', emissiveIntensity: 0.5 }));
      screen.position.set(px, 1.42, 1.063);
      g.add(screen);
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), new THREE.MeshStandardMaterial({ color: '#111', emissive: '#34444e', emissiveIntensity: 1.3 }));
      led.position.set(px - 0.12, 1.2, 1.065);
      g.add(led);
      const base0 = `BP${i + 1}`;
      const run = runSuffix(has, base0), spd = resolveSuffix(has, base0, 'speed'), flt = resolveSuffix(has, base0, 'fault'), cmd = resolveSuffix(has, base0, 'command');
      this.parts.boosters.push({ coup, band, led, run, spd, flt, speed: 0, target: 0 });
      const pts = [...new Set([cmd, spd, run, flt].filter((x) => x && has(x)))];
      for (const o of [vol, motor, vfd]) o.userData.pick = { title: `Booster pump ${i + 1}`, points: pts };
      for (const sfx of [cmd, spd, run]) if (sfx && has(sfx)) this.anchors.set(sfx, motor);
      for (const sfx of pts) this._bind(sfx);
      this._tag(g, [px, 1.95, 1.0], [[run, `PUMP ${i + 1}`, 'onoff'], [spd, 'SPEED', '%'], [flt, 'FAULT', 'alm']]);
    }
    this._tag(g, [edge + 0.3, ys - 0.35, zH + 0.1], [['BP.SUC', 'SUCTION', 'psi']]);
    this._tag(g, [edgeR - 0.3, yd + 0.4, zH + 0.1], [['BP.DIS', 'DISCHARGE', 'psi'], ['BP.DP', 'LOOP DP', 'psi'], ['BP.DPSP', 'DP SP', 'psi'], ['BP.FLOW', 'FLOW', 'gpm']]);
    // where the building's chilled water connects: suction in at the left, discharge out at
    // the right, the return straight through (in at the right, out at the left)
    const X = (x) => s.baseX + x;
    this.outletLocal = { x: X(edgeR), y: yd, z: zH, w: r * 2.2, h: r * 2.2, dir: [1, 0, 0] };
    this.returnLocal = { x: X(edgeR), y: ys, z: zR, r };
    this.coilPorts.push({ g, heat: false, local: [edge, ys, zH], retLocal: [edge, ys, zR], r, dir: [-1, 0, 0] });
    this.bpDims = { edge: X(edge), edgeR: X(edgeR), ys, yd, zH, zP, px0: X(-L / 2 + 0.7 + 0.75) };
  }

  _refreshExtra() {
    super._refreshExtra();
    const n = (sfx) => this._num(sfx);
    for (const p of this.parts.boosters || []) {
      const run = n(p.run), spd = p.spd ? n(p.spd) : NaN;
      const going = p.run === p.spd ? spd > 0 : run > 0;
      p.fault = p.flt ? n(p.flt) > 0 : false;
      p.target = going && !p.fault ? (fin(spd) ? clamp(spd, 10, 100) : 100) : 0;
    }
  }

  _frameParts(dt, now) {
    super._frameParts(dt, now);
    for (const p of this.parts.boosters || []) {
      p.speed = damp(p.speed, p.target, 1.6, dt);
      p.coup.rotation.z += dt * (p.speed / 100) * Math.PI * 2 * 6;
      p.band.material.emissive.set(p.fault ? '#ff3b2a' : '#46d3e6');
      p.band.material.emissiveIntensity = p.fault ? 1.2 + Math.sin(now / 200) : (p.speed / 100) * 1.4;
      p.led.material.emissive.set(p.fault ? '#ff3b2a' : p.target > 0 ? '#3fe08a' : '#34444e');
    }
  }

  isRunning() { return (this.parts.boosters || []).some((p) => p.target > 0) || super.isRunning(); }
  hasFault() { return (this.parts.boosters || []).some((p) => p.fault) || super.hasFault(); }
  _flowTarget() { const on = (this.parts.boosters || []).filter((p) => p.target > 0); return on.length ? on.reduce((t, p) => t + p.target, 0) / on.length / 100 : 0; }

  _paths() {
    const d = this.bpDims;
    const W = this.water || {};
    const oa = [[d.edge, d.ys, d.zH], [d.px0, d.ys, d.zH], [d.px0, d.ys, d.zP], [d.px0, d.yd, d.zP], [d.px0, d.yd, d.zH], [d.edgeR, d.yd, d.zH]];
    oa.vw = 0.3;
    oa.legT = [W.s, W.s, W.s, W.s, W.s];
    return finish({ oa });
  }

  _shares() { return { oa: 1, rec: 0, rel: 0 }; }

  _refreshAir() {
    this.water = { s: this._w(44) };
    this.vals = { oat: this.water.s, rat: this.water.s, mix: this.water.s };
    this.tempStations = [];
  }

  _presetView(name, instant = false) {
    const s = this._sec('bp');
    if (!s || (name !== 'unit' && name !== 'pump')) return super._presetView(name, instant);
    const x = s.group.position.x;
    if (name === 'unit') return this._tween(name, new THREE.Vector3(x, 0.7, 0), new THREE.Vector3(x + 1.5, 2.2, 3.6), instant);
    return this._tween(name, new THREE.Vector3(x, 1.2, -1), new THREE.Vector3(x - 2, 3, -4.5), instant);
  }

  _kpiDefs() {
    const p = this.parts.boosters?.[0];
    return [['BP.DP', 'Loop DP', 'psi'], ['BP.DPSP', 'DP setpoint', 'psi'], ['BP.FLOW', 'Flow', 'gpm'], ['BP.SUC', 'Suction', 'psi'], ['BP.DIS', 'Discharge', 'psi'], [p?.spd || null, 'Pump speed', '%']];
  }

  _modeDefs() {
    const b = this.parts.boosters || [];
    return b.map((x, i) => [x.run && this.has(x.run) ? x.run : null, `Pump ${i + 1}`]).concat(b.map((x, i) => [x.flt && this.has(x.flt) ? x.flt : null, `Pump ${i + 1} fault`, 1]));
  }
}

// P5 HX: the heating hot water plant, built on the plant family (hhw3d.js)
export const Hhw3DView = hhwViewClass(Plant3DView);

// Siemens field devices on every unit view (siemens-view.js); the hooks in ahu3d.js stay no-ops without it.
installSiemens(Ahu3DView, Terminal3DView);

// ---------------------------------------------------------------------------
// Exhaust fans that are units in their own right.
//
// An EF used to be drawn as the air handler casing with one fan in it, because
// the only fan shapes were the ones that live INSIDE a casing. A real exhaust
// fan is its own object: a tapered tube hung in a ceiling space, or a bare
// scroll standing on rails, throwing through a stack above the roof.
//
// Three shapes from one class, because they share everything that matters: an
// isolation damper, a wheel that turns only on a live proof, and a discharge.
//
//   mixed-flow    tapered tube in a round duct, hung on rods (config fanType)
//   utility-set   scroll on a base rail, belt guard and motor outside the air
//   stack         the nozzle it throws through; plume only when proven running
//
// An EF whose config says none of this keeps the old casing view, the same way
// a VAV saved before config.terminal keeps its older drawing.
// ---------------------------------------------------------------------------
export class Fan3DView extends Plant3DView {
  constructor(opts) {
    const cfg = opts.config || {};
    const fan = (cfg.supply || []).find((s) => s.device === 'fan') || {};
    const scroll = fan.fanType === 'utility-set';
    super({
      ...opts,
      size: { h: scroll ? 2.6 : 1.9, d: scroll ? 2.4 : 1.6 },
      eyebrow: scroll ? 'Utility set' : 'Inline exhaust fan',
      presets: [['overview', 'Overview'], ['unit', 'Fan'], ['pump', 'Discharge']],
    });
    this.scroll = scroll;
    this.shift = 0;
    this.legendRange = ['40°F', '100°F'];
  }

  _buildUnit() {
    const cfg = this.config || {};
    this.inv = { hasRet: false, fans: [], oad: null, ead: null };
    this.parts.efFans = [];
    this.plume = null;
    this.dmpBlades = null;
    this._newUnit();

    const fanCfg = (cfg.supply || []).find((s) => s.device === 'fan') || {};
    const dmpCfg = (cfg.supply || []).find((s) => s.device === 'damper') || null;
    const stackCfg = (cfg.supply || []).find((s) => s.device === 'stack') || null;
    const spec = (fanCfg.fans && fanCfg.fans[0]) || {};
    this.spec = {
      cmd: spec.cmd || 'EF_SS', status: spec.status || 'EF_STS',
      speed: spec.speed || 'EF_SVD', fault: spec.fault || 'EF_FLT',
    };
    this.dmpSym = dmpCfg ? dmpCfg.point : null;
    this.stackCfg = stackCfg;

    const secs = [{ kind: 'in', w: 1.1, cap: 'FROM SPACE', cabinet: false }];
    if (dmpCfg) secs.push({ kind: 'dmp', w: 0.6, cap: 'ISO', cabinet: false });
    secs.push({ kind: 'fan', w: 2.6, cap: this.scroll ? 'UTILITY SET' : 'MIXED-FLOW FAN', cabinet: false });
    secs.push(stackCfg
      ? { kind: 'stack', w: 1.5, cap: 'STACK', cabinet: false }
      : { kind: 'out', w: 1.1, cap: 'EXHAUST', cabinet: false });

    this.total = this._layRow(secs, { cabinet: false });
    this.sections = secs;

    const steel = new THREE.MeshStandardMaterial({ color: '#99a6ae', metalness: 0.55, roughness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: '#4f5a62', metalness: 0.5, roughness: 0.55 });
    const rod = new THREE.MeshStandardMaterial({ color: '#6f7b82', metalness: 0.7, roughness: 0.4 });
    // The casing and the duct read as shell, not as a solid block: you have to
    // see the wheel turn and the air go through. Same idea as the air handler's
    // casing, and they go in s.skins so Cutaway fades them with everything else.
    const shell = new THREE.MeshStandardMaterial({
      color: '#aab6bd', metalness: 0.3, roughness: 0.35,
      transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide,
    });
    const duct = new THREE.MeshStandardMaterial({
      color: '#8d989e', metalness: 0.4, roughness: 0.45,
      transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide,
    });
    this.fanMats = { steel, dark, duct, rod, shell };

    const R = 0.34;
    const BODY = 0.46;

    for (const s of secs) {
      const g = s.group, w = s.w;
      s.skins = [];
      if (s.kind === 'in' || s.kind === 'out') {
        const d = new THREE.Mesh(new THREE.CylinderGeometry(R, R, w, 20), duct);
        d.rotation.z = Math.PI / 2;
        g.add(d);
        s.skins.push(d);
      } else if (s.kind === 'dmp') {
        const frame = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.04, R + 0.04, w, 20), dark);
        frame.rotation.z = Math.PI / 2;
        g.add(frame);
        this.dmpBlades = [];
        for (let i = -1; i <= 1; i++) {
          const b = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, R * 0.62, 0.02), steel);
          b.position.set(0, i * R * 0.6, 0);
          g.add(b);
          this.dmpBlades.push(b);
        }
      } else if (s.kind === 'fan') {
        if (this.scroll) this._buildScroll(g, w, R, s);
        else this._buildTube(g, w, R, BODY, s);
      } else if (s.kind === 'stack') {
        this._buildStack(g, w, R);
      }
    }

    const fanSec = secs.find((s) => s.kind === 'fan');
    this._tag(fanSec.group, [0, this.scroll ? 2.1 : 1.0, 0.5], [
      [this.spec.status, 'PROOF', ''],
      [this.spec.speed, 'SPEED', '%'],
    ]);
    const dmpSec = secs.find((s) => s.kind === 'dmp');
    if (this.dmpSym && dmpSec) this._tag(dmpSec.group, [0, 0.9, 0.5], [[this.dmpSym, 'ISO DMP', '%']]);
  }

  /** Mixed-flow: tapered tube hung on rods, wheel on a motor pod inside. */
  _buildTube(g, w, R, BODY, sec) {
    const { steel, dark, rod, shell } = this.fanMats;
    const skins = sec.skins;
    const bodyL = w * 0.56, taper = (w - bodyL) / 2;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(BODY, BODY, bodyL, 24), shell);
    body.rotation.z = Math.PI / 2;
    g.add(body);
    skins.push(body);
    for (const sgn of [-1, 1]) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(BODY, R, taper, 24, 1, true), shell);
      t.rotation.z = sgn * Math.PI / 2;
      t.position.x = sgn * (bodyL / 2 + taper / 2);
      g.add(t);
      skins.push(t);
    }
    for (const sgn of [-1, 1]) {
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.0, 8), rod);
      r.position.set(sgn * bodyL * 0.3, BODY + 0.5, 0);
      g.add(r);
    }
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.34, 16), dark);
    pod.rotation.z = Math.PI / 2;
    pod.position.x = -0.22;
    g.add(pod);
    this._wheel(g, 0.16, BODY * 0.78, 7, 'x');
  }

  /** Utility set: volute on a base rail, inlet eye on the side, discharge up. */
  _buildScroll(g, w, R, sec) {
    const { steel, dark, rod } = this.fanMats;
    const rail = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 0.1, 1.3), dark);
    rail.position.y = 0.05;
    g.add(rail);
    for (const sgn of [-1, 1]) {
      const iso = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.16), rod);
      iso.position.set(sgn * w * 0.34, -0.02, 0);
      g.add(iso);
    }
    const vol = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.66, 28), this.fanMats.shell);
    vol.rotation.x = Math.PI / 2;
    vol.position.set(-w * 0.16, 0.78, 0);
    g.add(vol);
    sec.skins.push(vol);
    const eye = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.2, 20), dark);
    eye.rotation.x = Math.PI / 2;
    eye.position.set(-w * 0.16, 0.78, 0.42);
    g.add(eye);
    const out = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.9, 0.56), steel);
    out.position.set(-w * 0.16, 1.55, 0);
    g.add(out);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.56, 0.16), rod);
    guard.position.set(w * 0.12, 0.5, 0);
    g.add(guard);
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.44, 18), dark);
    motor.rotation.z = Math.PI / 2;
    motor.position.set(w * 0.33, 0.42, 0);
    g.add(motor);
    this._wheel(g, 0.44, 0.5, 8, 'z', [-w * 0.16, 0.78, 0.2]);
  }

  /** The stack it throws through. The plume is proof-gated, like all air here. */
  _buildStack(g, w, R) {
    const { steel, dark } = this.fanMats;
    const plume = this.stackCfg && this.stackCfg.plume !== false;
    const base = new THREE.Mesh(new THREE.BoxGeometry(w * 0.8, 0.5, 0.9), dark);
    base.position.y = 0.25;
    g.add(base);
    if (plume) {
      for (let i = 0; i < 3; i++) {
        const l = new THREE.Mesh(new THREE.BoxGeometry(w * 0.76, 0.04, 0.02), steel);
        l.position.set(0, 0.14 + i * 0.12, 0.46);
        l.rotation.x = -0.4;
        g.add(l);
      }
    }
    const h = plume ? 2.3 : 1.2;
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.78, R, h, 20), steel);
    stack.position.y = 0.5 + h / 2;
    g.add(stack);
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.84, R * 0.74, 0.1, 20), dark);
    nozzle.position.y = 0.5 + h + 0.05;
    g.add(nozzle);

    const pm = new THREE.MeshBasicMaterial({ color: '#48c9ff', transparent: true, opacity: 0, depthWrite: false });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(R * 0.9, 1.2, 16, 1, true), pm);
    cone.position.y = 0.5 + h + 0.72;
    g.add(cone);
    this.plume = { mesh: cone, mat: pm, k: 0 };
  }

  /** A wheel that turns only when something proves it is turning. */
  _wheel(g, bladeLen, radius, blades, axis, at) {
    const rotor = new THREE.Group();
    const p = at || [0, 0, 0];
    rotor.position.set(p[0], p[1], p[2]);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.26, radius * 0.26, 0.1, 14),
      new THREE.MeshStandardMaterial({ color: '#123c62', metalness: 0.6, roughness: 0.4 }));
    const bm = new THREE.MeshStandardMaterial({ color: '#6f7b82', metalness: 0.5, roughness: 0.5 });
    if (axis === 'x') hub.rotation.z = Math.PI / 2;
    else hub.rotation.x = Math.PI / 2;
    rotor.add(hub);
    for (let i = 0; i < blades; i++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.02, bladeLen, radius * 0.5), bm);
      const a = (i / blades) * Math.PI * 2;
      if (axis === 'x') {
        b.position.set(0, Math.cos(a) * radius * 0.6, Math.sin(a) * radius * 0.6);
        b.rotation.x = -a;
      } else {
        b.position.set(Math.cos(a) * radius * 0.6, Math.sin(a) * radius * 0.6, 0);
        b.rotation.z = -a;
        b.rotation.y = 0.4;
      }
      rotor.add(b);
    }
    g.add(rotor);
    this.parts.efFans.push({ rotor, axis, speed: 0, target: 0, fault: false });
  }

  _refreshExtra() {
    super._refreshExtra();
    const n = (s) => this._num(s);
    const run = n(this.spec.status);
    const spd = this.has(this.spec.speed) ? n(this.spec.speed) : NaN;
    const fault = this.has(this.spec.fault) ? n(this.spec.fault) > 0 : false;
    // Proof is what turns the wheel: a command without a proof turns nothing.
    const going = fin(run) ? run > 0 : false;
    for (const f of this.parts.efFans || []) {
      f.fault = fault;
      f.target = going && !fault ? (fin(spd) && spd > 0 ? clamp(spd, 10, 100) : 100) : 0;
    }
    this.dmpPos = this.dmpSym && this.has(this.dmpSym) ? n(this.dmpSym) : NaN;
    this.blowing = going && !fault;
  }

  _frameParts(dt, now) {
    super._frameParts(dt, now);
    for (const f of this.parts.efFans || []) {
      f.speed = damp(f.speed, f.target, 1.4, dt);
      const w = dt * (f.speed / 100) * Math.PI * 2 * 3.2;
      if (f.axis === 'x') f.rotor.rotation.x -= w;
      else f.rotor.rotation.z -= w;
    }
    if (this.dmpBlades) {
      const open = fin(this.dmpPos) ? clamp(this.dmpPos, 0, 100) / 100 : 0;
      this.dmpK = damp(this.dmpK || 0, open, 2.2, dt);
      for (const b of this.dmpBlades) b.rotation.x = this.dmpK * Math.PI / 2;
    }
    if (this.plume) {
      this.plume.k = damp(this.plume.k, this.blowing ? 1 : 0, 1.6, dt);
      this.plume.mat.opacity = 0.3 * this.plume.k;
      this.plume.mesh.scale.y = 0.6 + this.plume.k * 0.8;
    }
  }


  /**
   * The air this fan moves, as one lane along its real path: in from the
   * space, through the isolation damper, through the wheel, and then either
   * up the stack and away above the roof, or straight out of the discharge.
   *
   * It is drawn at all only while _flowTarget() is above zero, and that
   * returns zero unless a live proof says the fan is running — so an unbound,
   * stale, stopped or faulted fan moves no air here, the same rule every other
   * unit in this engine follows.
   */
  _paths() {
    const secs = this.sections;
    const first = secs[0].group.position.x - secs[0].w / 2;
    const y = this.scroll ? 0.78 : this.DH / 2;
    const stackSec = secs.find((s) => s.kind === 'stack');

    if (stackSec) {
      // up and out: the plume leaves above the nozzle and dissipates
      const sx = stackSec.group.position.x;
      const plume = this.stackCfg && this.stackCfg.plume !== false;
      const top = 0.5 + (plume ? 2.3 : 1.2);
      const oa = [
        [first - 0.9, y, 0],
        [sx - stackSec.w * 0.2, y, 0],
        [sx, y, 0],
        [sx, top + 0.3, 0],
        [sx + 0.18, top + 1.5, 0.1],
      ];
      oa.vw = 0.2;
      oa.k = [1, 0.5, [1, 0.5, 4], [1, 2.2, 3]];
      oa.fadeEnd = 1.1;            // it disperses once it is clear of the stack
      return finish({ oa });
    }

    if (this.scroll) {
      // a utility set takes air in at the eye and throws it up out of the volute
      const fanSec = secs.find((s) => s.kind === 'fan');
      const fx = fanSec.group.position.x - fanSec.w * 0.16;
      const oa = [
        [first - 0.9, y, 0],
        [fx, y, 0],
        [fx, 1.55, 0],
        [fx, 2.5, 0],
      ];
      oa.vw = 0.22;
      oa.k = [1, 0.5, [1, 0.6, 4]];
      oa.fadeEnd = 0.9;
      return finish({ oa });
    }

    // straight through: in one duct, out the other
    const lastS = secs[secs.length - 1];
    const last = lastS.group.position.x + lastS.w / 2;
    const oa = [[first - 0.9, y, 0], [last + 0.9, y, 0]];
    oa.vw = 0.2;
    oa.k = [1, 0.5];
    return finish({ oa });
  }

  // One fan, one stream: nothing is recirculated or relieved here.
  _shares() { return { oa: 1, rec: 0, rel: 0 }; }

  isRunning() { return (this.parts.efFans || []).some((f) => f.target > 0) || super.isRunning(); }
  hasFault() { return (this.parts.efFans || []).some((f) => f.fault) || super.hasFault(); }
  // No idle drift: with nothing proving the fan runs, no air moves at all.
  // The speed read back sets how fast it moves, so the stream matches the VFD.
  _flowTarget() {
    if (!this.blowing) return 0;
    const f = (this.parts.efFans || [])[0];
    return f && f.target > 0 ? clamp(f.target / 100, 0.15, 1) : 0.8;
  }
}
