/**
 * siemens-view.js — Siemens field devices on the 3D unit views.
 *
 * installSiemens(Ahu3DView, Terminal3DView) (called once at the end of
 * equip3d.js) puts on the prototypes:
 *   _materialsHook(m)   the sie_* materials join the view's material set (the
 *                       twin's shared set carries them to every embedded unit)
 *   _device(g, sfx, role, pose, caption) → { group, hub?, stem?, ports?, spec } | null
 *                       the one way a device gets built (integration plan §3.2)
 *   _afterBuild()       the single post-build pass: AHU / ERU / terminal poses
 *   _refreshDevices()   QMX3 display from its own points (lit only while ZNT is live)
 *   _animateDevices()   valve stems follow the damped valve %
 *   _disposeDevices()   per-view textures and materials; the geometry cache on a
 *                       top-level destroy
 *   deviceObjects()     what the twin hides on units that are not focused
 *   Terminal3DView._thermostat  the room's wall unit becomes a real QMX3
 * Without this module every hook in ahu3d.js is a no-op (the PPCL Simulator
 * port stays in step).
 *
 * Honesty: device bodies never encode a value. Hubs are parented to their
 * blade and so rest shut with it when a point is not live; stems rest at 0 %;
 * the QMX3 backlight is lit only while ZNT reads live and not during playback.
 */

import * as THREE from 'three';
import { buildDevice, mountDevice, siemensMaterials, drawQmx3Lcd, disposeDeviceCache, tubeMesh, serpentineMesh, reducerLen, specOf } from './siemens3d.js';
import { deviceMap, contextText, valveLabel, lookup } from '../../shared/siemens/parts.js';
import { defaultDevice, roomUnitOf } from '../../shared/siemens/select.js';

const PLANT = new Set(['hx', 'boiler', 'chiller-ac', 'chiller-wc', 'tower', 'booster']);
const FT2_PER_M2 = 10.7639;
const FR = { temp: 0.72, rh: 0.56, co2: 0.40, flow: 0.30, dp: 0.86 };   // mount height, fraction of the cabinet height
const DAMPER_CAP = { OAD: 'OUTSIDE AIR', RAD: 'RETURN AIR', MAD: 'RETURN AIR', EAD: 'RELIEF AIR', ECON: 'RELIEF AIR', RELD: 'RELIEF AIR' };

export function installSiemens(ViewClass, TerminalClass) {
  const P = ViewClass.prototype;
  if (P._siemens) return;
  P._siemens = true;
  P._materialsHook = function (m) { Object.assign(m, siemensMaterials()); };
  P._device = device;
  P._afterBuild = afterBuild;
  P._refreshDevices = refreshDevices;
  P._animateDevices = animateDevices;
  P._disposeDevices = disposeDevices;
  P.deviceObjects = deviceObjects;
  P._devSpan = devSpan;
  P._devTube = devTube;
  if (TerminalClass?.prototype?._thermostat) {
    const generic = TerminalClass.prototype._thermostat;
    TerminalClass.prototype._thermostat = function (g, tx, ty, zWall) { return roomUnit.call(this, generic, g, tx, ty, zWall); };
  }
}

// ---- the device builder (contract: integration plan §3.2) -------------------------------

const detailOf = (v) => (v.embedded || v.tier === 'low' ? 'embed' : 'full');
const areaOf = (d) => (d && Number.isFinite(d.depth) && Number.isFinite(d.height) ? d.depth * d.height * FT2_PER_M2 : undefined);

/** Normalise a part choice to { part, count, … } | { valve } | null. */
function choiceOf(x, def) {
  if (x == null) return null;
  if (x === 'none') return 'none';
  if (typeof x === 'string') return { part: x, count: def?.part === x ? def.count ?? 1 : 1, fail: def?.fail };
  if (typeof x === 'object' && !x.part && (x.series || x.family)) return { valve: x };
  if (typeof x === 'object' && x.part) {
    if (typeof x.part === 'object') return { valve: x.part };
    return { ...x, count: Math.max(1, Math.min(4, Number(x.count) || 1)) };
  }
  return null;
}

/**
 * Build one device into section group `g`.
 *   sfx     its suffix ('term.controller' is the only pseudo-suffix)
 *   role    'ahu.*' | 'term.controller' | 'term.damper' | 'term.valve' | 'term.dat' | 'term.pri.temp' | 'term.ent.temp'
 *   pose    { pos, normal, up, drives?, blade?, plate?, points?, span?, tubes?, lineR? } (metres, g's frame)
 *           drives: a damper record → the hub is parented to blades[blade ?? ⌊n/2⌋];
 *                   a coil record   → it gains { stem, stem0, stroke, stemSign }
 *           plate:  the pose used when the controller is not actuating
 * Returns null (draws nothing) when fieldDevices.show === false, the part is
 * 'none', or the suffix is not in the unit's map.
 */
function device(g, sfx, role, pose = {}, caption = '') {
  const cfg = this.config || {};
  if (cfg.fieldDevices?.show === false || !g) return null;
  const pseudo = sfx === 'term.controller';
  if (!pseudo && !this.has?.(sfx)) return null;
  const has = (s) => !!s && !!this.has?.(s);
  const dm = (this._dm ||= deviceMap(cfg));
  const ent = dm.get(sfx);
  const drives = pose.drives || null;
  const damper = drives && Array.isArray(drives.blades) && drives.blades.length ? drives : null;
  const ctx = {
    kind: this.kind, config: cfg, valveType: ent?.src?.valveType, valveModel: ent?.src?.valveModel, variant: ent?.src?.variant,
    binary: ent?.src?.signal === 'binary', hasShaft: !!damper, area: areaOf(damper),
  };
  const def = defaultDevice(role, ctx);
  let ch = choiceOf(this.devOf?.(sfx, role) ?? null, def);
  let explicit = ch != null;
  if (ch == null && ent?.explicit && (ent.role === role || pseudo)) { ch = choiceOf(ent.part, def); explicit = true; }
  if (ch == null) { ch = choiceOf(def?.part != null ? def : null, def); explicit = false; }
  if (!ch || ch === 'none') return null;
  const detail = detailOf(this);
  const reg = (this.parts.devices ||= []);

  // ---- valve package on a coil ----
  if (ch.valve) {
    const dev = buildDevice(ch.valve, { m: this.m, detail, lineR: pose.lineR });
    if (!dev) return null;
    mountDevice(g, dev, pose);
    finishGroup(dev.group);
    if (drives && !damper) {
      drives.stem = dev.stem; drives.stem0 = dev.stem0; drives.stroke = dev.stroke;
      drives.stemSign = ch.valve.action === 'NC' ? -1 : 1;
    }
    const title = `${caption || sfx} · ${valveLabel(ch.valve)}`;
    dev.group.userData.pick = { title, points: pick(pose.points ?? [sfx], has), device: dev.spec.id, context: { device: contextText(ch.valve) } };
    const L = (dev.spec.size.len + 2 * reducerLen(dev.spec.size, pose.lineR)) / 1000;
    reg.push({ sfx, role, spec: dev.spec, group: dev.group, stem: dev.stem, valve: true, objects: [dev.group] });
    return { group: dev.group, stem: dev.stem, ports: { len: L }, spec: dev.spec };
  }

  let spec = specOf(ch.part);
  if (!spec) return null;
  // the default VAV controller: E10PL on a shaft, E12P on the casing — and an actuating part never floats
  if (role === 'term.controller' && spec.actuating && !damper) {
    if (explicit) return null;                          // "E10PL needs a damper shaft" (A6V11259958): not drawn
    spec = specOf(SIEMENS_NO_SHAFT);
    if (!spec) return null;
  }
  const onShaft = !!damper && (spec.rotary || spec.actuating);
  const where = !onShaft && pose.plate ? pose.plate : pose;
  const count = onShaft ? (ch.count || 1) : 1;
  const units = [];
  if (onShaft) {
    // hub on the shaft end; a tandem unit stacks outward; 3–4 units split across both ends of the same shaft
    const k = clampIdx(pose.blade ?? Math.floor(damper.n ?? damper.blades.length / 2), damper.blades.length);
    const blade = damper.blades[k];
    const n = new THREE.Vector3(...(where.normal || [0, 0, 1])).normalize();
    const p0 = new THREE.Vector3(...(where.pos || [0, 0, 0]));
    const step = (spec.dims?.d ?? 73) / 1000;
    // where the shaft axis crosses the mounting line, in g's frame (for the opposite end)
    blade.updateWorldMatrix(true, false);
    g.updateWorldMatrix(true, false);
    const pivot = g.worldToLocal(blade.getWorldPosition(new THREE.Vector3()));
    const along = p0.clone().sub(pivot).dot(n);
    for (let i = 0; i < count; i++) {
      const far = ch.ends === 2 && i >= Math.ceil(count / 2);
      const j = far ? i - Math.ceil(count / 2) : i;
      const nn = far ? n.clone().negate() : n;
      const base = far ? p0.clone().addScaledVector(n, -2 * along) : p0.clone();
      const pos = base.addScaledVector(nn, j * step);
      const dev = buildDevice(spec, { m: this.m, detail });
      if (!dev) continue;
      mountDevice(g, dev, { pos: pos.toArray(), normal: nn.toArray(), up: where.up || [0, 1, 0] });
      finishGroup(dev.group);
      if (dev.hub) {
        dev.hub.updateWorldMatrix(true, false);
        blade.attach(dev.hub);                        // hub = blade: it turns exactly with its blade
        dev.hub.updateMatrix();
        dev.hub.matrixAutoUpdate = false;
        dev.hub.userData.noFootprint = true;
      }
      units.push(dev);
    }
    if (!units.length) return null;
  } else {
    const dev = buildDevice(spec, { m: this.m, detail });
    if (!dev) return null;
    mountDevice(g, dev, where);
    finishGroup(dev.group);
    units.push(dev);
  }

  // title and pick
  const partTxt = count > 1 ? `${spec.id} ×${count} ${ch.masterSlave ? 'master/slave' : 'tandem'}` : spec.id;
  const sized = onShaft && !explicit && ctx.area ? ` · sized from the drawing (${Math.round(ctx.area)} ft²)` : '';
  const over = ch.oversize ? ' · damper needs sectioning (field practice, UNVERIFIED)' : '';
  const title = `${caption || sfx} · ${partTxt}${sized}${over}`;
  let ctxText = contextText(spec);
  if (count > 1) ctxText += ` · ×${count}${ch.bracket ? `, bracket ${ch.bracket}` : ''}${ch.masterSlave ? ', master/slave' : ', one shaft end'}`;
  let points = pose.points;
  if (!points) {
    if (role === 'term.controller') points = [damper?.suffix, 'SA.CFM', 'OA.CFM'];
    else if (onShaft) points = [damper.suffix];
    else if (role === 'ahu.filter.dp') points = [sfx, `${sfx}.ALM`];
    else points = [sfx];
  }
  const p = { title, points: pick(points, has), device: spec.id, context: { device: ctxText } };
  const objects = [];
  for (const u of units) {
    u.group.userData.pick = p;
    if (u.hub) u.hub.userData.pick = p;
    objects.push(u.group);
    if (u.hub) objects.push(u.hub);
  }
  if (onShaft && damper.g?.userData?.pick) damper.g.userData.pick = { ...damper.g.userData.pick, title, device: spec.id, context: { device: ctxText } };

  // external runs at full detail: averaging element / capillary across the section, dP tubes
  if (detail === 'full') {
    if (pose.span && (spec.averaging || spec.capillary)) objects.push(this._devSpan(g, spec, where, pose.span));
    if (pose.tubes?.length && (spec.shape === 'qbm' || spec.ports)) pose.tubes.forEach((t, i) => objects.push(this._devTube(g, units[0].group, t, spec.ports?.[i])));
  }
  const first = units[0];
  reg.push({ sfx, role, spec, group: first.group, hub: first.hub, hubs: units.map((u) => u.hub).filter(Boolean), objects, lcd: first.lcd });
  return { group: first.group, hub: first.hub, stem: first.stem, spec };
}

const SIEMENS_NO_SHAFT = 'DXR2.E12P-102B';
const clampIdx = (k, n) => Math.max(0, Math.min(n - 1, k | 0));
const pick = (list, has) => [...new Set(list.filter(has))];

function finishGroup(group) {
  group.userData.noFootprint = true;
  group.updateMatrix();
  group.matrixAutoUpdate = false;
}

// ---- external runs --------------------------------------------------------------------------

/**
 * An averaging element (QAM2120.200/.600) or the freezestat capillary, laid
 * across the section plane `span = { x, w, h, y? }` (a Y–Z plane at x in g's
 * frame, centred on the cabinet), with a lead from the housing to it.
 */
function devSpan(g, spec, where, span) {
  const len = spec.probe?.len ?? spec.capillary?.len ?? 2000;
  const mat = this.m[`sie_${spec.capillary ? spec.finish.capillary : spec.finish.probe}`] || this.m.sie_pa66Black;
  const clip = spec.capillary ? this.m.sie_galv : this.m.sie_pa66Black;
  const grp = new THREE.Group();
  const s = serpentineMesh(len, { w: span.w, h: span.h }, spec.capillary ? 1.6 : 3, mat, clip);
  s.rotation.y = Math.PI / 2;                          // local X (the passes) runs across the cabinet depth
  s.position.set(span.x, span.y ?? this.DH / 2, 0);
  grp.add(s);
  // lead: from the housing's probe exit straight in, then along the section to the element start
  const [hx, hy, hz] = where.pos;
  const st = new THREE.Vector3(...s.userData.start).applyEuler(s.rotation).add(s.position);
  const inZ = hz - 0.08;
  grp.add(tubeMesh([[hx, hy, hz], [hx, hy, inZ], [st.x, hy, inZ], [st.x, st.y, st.z]], spec.capillary ? 0.0016 : 0.003, mat));
  grp.userData.noFootprint = true;
  g.add(grp);
  return grp;
}

/**
 * A sensing tube from a dP transmitter's fitting to a point in g's frame. With
 * a port (mm, device frame: a fitting on the face) the tube leaves the fitting
 * straight out, then drops to the target's height and runs in to it.
 */
function devTube(g, body, target, port) {
  body.updateMatrix();
  const mat = this.m.sie_tube || this.m.sie_pcFrost;
  if (port) {
    const tip = new THREE.Vector3(port[0], port[1], port[2]).multiplyScalar(0.001).applyMatrix4(body.matrix);
    const out = new THREE.Vector3(port[0], port[1], port[2] + 28).multiplyScalar(0.001).applyMatrix4(body.matrix);
    const t = tubeMesh([tip.toArray(), out.toArray(), [out.x, target[1] + 0.05, out.z], [target[0], target[1] + 0.05, out.z], target], 0.0032, mat);
    g.add(t);
    return t;
  }
  const nip = new THREE.Vector3(0, -0.058, 0.025).applyMatrix4(body.matrix);
  const t = tubeMesh([nip.toArray(), [nip.x, target[1] + 0.05, nip.z], [target[0], target[1] + 0.05, nip.z], target], 0.0032, mat);
  g.add(t);
  return t;
}

// ---- the post-build pass --------------------------------------------------------------------

function afterBuild() {
  if (!this.parts) return;
  this._dm = null;
  if (this.devicePoses === 'self') return;              // VAV's view poses its own devices
  this.parts.devices ||= [];
  if (this.kind === 'crac' || PLANT.has(this.kind)) return;
  const terminal = this.kind === 'vav' || this.kind === 'fcu';
  if (!terminal) readoutRows.call(this);                // real points: shown whether or not devices are drawn
  if (this.config?.fieldDevices?.show === false) return;
  this.unit?.updateMatrixWorld(true);
  if (terminal) terminalPoses.call(this); else ahuPoses.call(this);
  valves.call(this, terminal);
}

const firstOf = (has, list) => list.find((s) => s && has(s)) || null;

/** RA CO2 at the return site; FREEZE on the first heating coil (only when their suffix exists). */
function readoutRows() {
  const has = this.has, H = this.DH, D = this.D;
  const frz = ['FRZ', 'LTD'].filter((s) => has(s));
  if (frz.length) {
    const c = this.sections.find((s) => s.kind === 'coil' && s.heat);
    if (c) this._tag(c.group, [c.w / 2 - 0.3, H + 0.35, D / 2 + 0.3], frz.map((s) => [s, s === 'LTD' ? 'LOW TEMP' : 'FREEZE', 'state', ['NORMAL', 'TRIP']]));
  }
  if (has('RA.CO2')) {
    const site = returnSite.call(this);
    if (site) this._tag(site.g, [site.x, site.y + 0.55, site.z + 0.3], [['RA.CO2', 'RA CO2', 'ppm']]);
  }
}

/** Where the return-air devices go: { g, x, y, z, dir } (the stub's outer face), or null. */
function returnSite() {
  const H = this.DH, D = this.D, len = Math.min(0.55, H * 0.35);
  const retin = this.sections.find((s) => s.kind === 'retin');
  if (retin) {
    if (this.layout?.ret === 'end') return { g: retin.group, x: -retin.w / 2 - len + 0.08, y: 0.85 * H - 0.1, z: 0.35 * D + 0.002, dir: +1, stub: true };
    return { g: retin.group, x: -0.25, y: FR.temp * H, z: D / 2 + 0.002, dir: +1, face: this.layout?.ret };
  }
  const exin = this.sections.find((s) => s.kind === 'exin');
  if (exin) return { g: exin.group, x: exin.w / 2 + len - 0.08, y: 0.85 * H - 0.1, z: 0.35 * D + 0.002, dir: -1, stub: true };
  if (this.retMod && this.mixSec) {
    const inG = returnModuleIn(this.mixSec);
    if (inG) return { g: inG.g, x: inG.w / 2 + len - 0.08, y: 0.85 * H - 0.1, z: 0.35 * D + 0.002, dir: -1, stub: true };
  }
  return null;
}

/** The swapped layout's return-module inlet part (its group and width). */
function returnModuleIn(mix) {
  const mod = mix.group.children.find((o) => o.isGroup && o.children.length >= 2 && Math.abs(o.position.x + mix.w / 2) < 1e-6);
  const parts = mod ? mod.children.filter((o) => o.isGroup) : [];
  const last = parts[parts.length - 1];
  return last ? { g: last, w: 0.9 } : null;
}

function ahuPoses() {
  const has = this.has, H = this.DH, D = this.D;
  const Z = D / 2 + 0.002;
  const skin = (x, frac) => ({ pos: [x, frac * H, Z], normal: [0, 0, 1], up: [0, 1, 0] });
  const len = Math.min(0.55, H * 0.35);
  const stubZ = 0.35 * D + 0.002;
  const sfx = {
    oaT: 'OAT', oaH: firstOf(has, ['OAH', 'OARH', 'OA.RH']), oaF: firstOf(has, ['OA.CFM', 'OACFM', 'OA.FLW']),
    saT: 'SAT', saH: firstOf(has, ['SAH', 'SA.RH']), saS: firstOf(has, ['SSP', 'DSP', 'SA.SP.PRES']), saF: firstOf(has, ['SA.CFM', 'SA.FLW']),
    raT: 'RAT', raH: firstOf(has, ['RAH', 'RA.RH']), raC: 'RA.CO2', raF: firstOf(has, ['RA.FLW', 'RA.CFM']),
    eaT: 'EAT', eaF: firstOf(has, ['EA.FLW', 'EA.CFM']),
  };
  const oaStation = (g, x) => {
    this._device(g, sfx.oaT, 'ahu.oa.temp', skin(x, FR.temp), 'OA TMP');
    this._device(g, sfx.oaH, 'ahu.oa.rh', skin(x, FR.rh), 'OA RH');
    this._device(g, sfx.oaF, 'ahu.oa.flow', skin(x + 0.25, FR.flow), 'OA FLOW');
  };
  // a station on a duct stub's +z face; dir +1 = the unit lies toward +x from the outer end
  const stubStation = (g, xOuter, dir, list) => {
    const at = (dx, y) => ({ pos: [xOuter + dir * dx, y, stubZ], normal: [0, 0, 1], up: [0, 1, 0] });
    for (const [s, role, dx, y, cap, extra] of list) this._device(g, s, role, { ...at(dx, y), ...(extra || {}) }, cap);
  };
  const returnStation = (site) => {
    if (!site) return;
    if (site.stub) {
      stubStation(site.g, site.x, site.dir, [
        [sfx.raT, 'ahu.ra.temp', 0, 0.85 * H - 0.1, 'RA TMP'], [sfx.raH, 'ahu.ra.rh', 0, 0.45 * H, 'RA RH'],
        [sfx.raC, 'ahu.ra.co2', 0.18, 0.62 * H, 'RA CO2'], [sfx.raF, 'ahu.ra.flow', 0.36, 0.3 * H, 'RA FLOW'],
      ]);
      return;
    }
    const face = site.face;
    if (face === 'roof') {
      const at = (x, y) => ({ pos: [x, H + y, stubZ], normal: [0, 0, 1], up: [0, 1, 0] });
      this._device(site.g, sfx.raT, 'ahu.ra.temp', at(-0.2, 0.5), 'RA TMP');
      this._device(site.g, sfx.raH, 'ahu.ra.rh', at(-0.2, 0.28), 'RA RH');
      this._device(site.g, sfx.raC, 'ahu.ra.co2', at(0.05, 0.4), 'RA CO2');
      this._device(site.g, sfx.raF, 'ahu.ra.flow', at(0.3, 0.35), 'RA FLOW');
    } else if (face === 'front') {
      const w = this.sections.find((s) => s.kind === 'retin')?.w ?? 1;
      const at = (z, frac) => ({ pos: [-w / 2 - 0.002, frac * H, z], normal: [-1, 0, 0], up: [0, 1, 0] });
      this._device(site.g, sfx.raT, 'ahu.ra.temp', at(0.1, FR.temp), 'RA TMP');
      this._device(site.g, sfx.raH, 'ahu.ra.rh', at(0.1, FR.rh), 'RA RH');
      this._device(site.g, sfx.raC, 'ahu.ra.co2', at(-0.15, FR.co2), 'RA CO2');
      this._device(site.g, sfx.raF, 'ahu.ra.flow', at(-0.4, FR.flow), 'RA FLOW');
    } else {
      this._device(site.g, sfx.raT, 'ahu.ra.temp', skin(-0.25, FR.temp), 'RA TMP');
      this._device(site.g, sfx.raH, 'ahu.ra.rh', skin(-0.25, FR.rh), 'RA RH');
      this._device(site.g, sfx.raC, 'ahu.ra.co2', skin(0, FR.co2), 'RA CO2');
      this._device(site.g, sfx.raF, 'ahu.ra.flow', skin(0.25, FR.flow), 'RA FLOW');
    }
  };

  let frzDone = false;
  for (const s of this.sections) {
    const g = s.group;
    if (s.kind === 'intake') oaStation(g, -s.w / 2 + 0.3);
    else if (s.kind === 'exout') {
      this._device(g, sfx.eaT, 'ahu.ea.temp', skin(-s.w / 2 + 0.3, FR.temp), 'EA TMP');
      this._device(g, sfx.eaF, 'ahu.ea.flow', skin(-s.w / 2 + 0.55, FR.flow), 'EA FLOW');
    } else if (s.kind === 'mix') {
      if (!this.swap && this.inv.hasRet && this.inv.oad) oaStation(g, -0.2);
      const mat = this.inv.mat;
      if (mat) this._device(g, mat, 'ahu.ma.temp', { ...skin(0.2, FR.temp), span: { x: s.w / 2 - 0.1, w: D - 0.2, h: H - 0.2 } }, 'MA TMP');
    } else if (s.kind === 'filter') {
      const f = s.f || {};
      const dp = f.dp || f.alm;
      if (dp) this._device(g, dp, 'ahu.filter.dp', { ...skin(0, FR.dp), tubes: [[-0.15, 0.5 * H, Z - 0.1], [0.15, 0.5 * H, Z - 0.1]] }, `${s.cap} DP`);
    } else if (s.kind === 'coil') {
      if (s.t) this._device(g, s.t, 'ahu.coil.lat', { ...skin(s.w / 2 - 0.15, FR.temp), span: { x: 0.16, w: D - 0.2, h: H - 0.2 } }, s.heat ? `${s.cap} LVG TMP` : 'CC TMP');
      if (s.heat && !frzDone) {
        frzDone = true;
        // the freezestat is drawn only when an FRZ or LTD point is actually mapped (user answer 2026-09-29)
        const fz = ['FRZ', 'LTD'].find((x) => has(x) && this.resolve?.(x)?.status !== 'unbound');
        if (fz) this._device(g, fz, 'ahu.frz', { ...skin(s.w / 2 - 0.3, FR.dp), span: { x: 0.21, w: D - 0.2, h: H - 0.25 } }, fz === 'LTD' ? 'LOW LIMIT' : 'FREEZESTAT');
      }
    } else if (s.kind === 'discharge') {
      const xo = s.w / 2 + len - 0.08;
      stubStation(g, xo, -1, [
        [sfx.saT, 'ahu.sa.temp', 0, 0.85 * H - 0.1, 'SA TMP'], [sfx.saH, 'ahu.sa.rh', 0, 0.45 * H, 'SA RH'],
        [sfx.saS, 'ahu.sa.static', 0.18, 0.6 * H, 'STATIC', { tubes: [[xo - 0.18, 0.5 * H, 0.1]] }],
        [sfx.saF, 'ahu.sa.flow', 0.36, 0.3 * H, 'SA FLOW'],
      ]);
    }
  }
  returnStation(returnSite.call(this));

  // OpenAir actuators on every damper: hub on the middle blade's shaft end
  for (const d of this.parts.dampers) {
    if (!d.g || !d.blades?.length) continue;
    const role = /^(RAD|MAD)$/.test(d.suffix) ? 'ahu.damper.ra' : /^(EAD|ECON|RELD)$/.test(d.suffix) ? 'ahu.damper.ea' : 'ahu.damper.oa';
    const cap = this.kind === 'eru' && role === 'ahu.damper.ea' ? 'EXHAUST AIR' : (DAMPER_CAP[d.suffix] || d.suffix);
    this._device(d.g, d.suffix, role, shaftPose(d), `${cap} damper`);
  }
}

/** The hub pose on the +z end of blade ⌊n/2⌋; the body hangs away from the damper's middle. */
function shaftPose(d, blade) {
  const k = blade ?? Math.floor((d.n ?? d.blades.length) / 2);
  const y = d.blades[k].position.y;
  return { pos: [0, y, (d.depth ?? 0) / 2 + 0.06], normal: [0, 0, 1], up: [0, y < -1e-6 ? -1 : 1, 0], drives: d, blade: k };
}

/** Legacy terminals (valve-only DXR2 boxes) and fan coils: §4.2 generic poses. */
function terminalPoses() {
  const has = this.has, H = this.DH, D = this.D, vav = this.kind === 'vav';
  const Z = D / 2 + 0.002;
  const skin = (x, frac) => ({ pos: [x, frac * H, Z], normal: [0, 0, 1], up: [0, 1, 0] });
  const tin = this.sections.find((s) => s.kind === 'tin');
  const dis = this.sections.find((s) => s.kind === 'discharge');
  if (tin && has('OAT')) this._device(tin.group, 'OAT', vav ? 'term.pri.temp' : 'term.ent.temp', skin(0.12, FR.temp), vav ? 'PRI TMP' : 'ENT TMP');
  if (dis && this.datSfx) this._device(dis.group, this.datSfx, 'term.dat', skin(0.1, FR.temp), 'DA TMP');
  const dmp = this.parts.dampers.find((d) => d.suffix === this.inv?.oad && d.g);
  const plate = tin ? skin(-0.08, 0.3) : null;
  if (!tin) return;
  if (vav && dmp) {
    const hub = shaftPose(dmp);
    const r = this._device(dmp.g, 'term.controller', 'term.controller', { ...hub, plate: toFrame(tin.group, dmp.g, plate) }, 'Controller');
    if (!r?.spec?.actuating) this._device(dmp.g, dmp.suffix, 'term.damper', hub, 'PRIMARY AIR damper');
  } else {
    this._device(tin.group, 'term.controller', 'term.controller', plate, 'Controller');
    if (dmp) this._device(dmp.g, dmp.suffix, 'term.damper', shaftPose(dmp), vav ? 'PRIMARY AIR damper' : 'OUTSIDE AIR damper');
  }
}

/** A pose in `from`'s frame re-expressed in `to`'s frame. */
function toFrame(from, to, pose) {
  if (!pose || from === to) return pose;
  from.updateWorldMatrix(true, false);
  to.updateWorldMatrix(true, false);
  const inv = to.matrixWorld.clone().invert();
  const m = inv.multiply(from.matrixWorld);
  const p = new THREE.Vector3(...pose.pos).applyMatrix4(m);
  const rot = new THREE.Matrix3().setFromMatrix4(m);
  const n = new THREE.Vector3(...pose.normal).applyMatrix3(rot).normalize();
  const u = new THREE.Vector3(...pose.up).applyMatrix3(rot).normalize();
  return { ...pose, pos: p.toArray(), normal: n.toArray(), up: u.toArray() };
}

/** Coil valves: the Siemens body + actuator replaces the generic sphere and box; the pipe gets a gap for it. */
function valves(terminal) {
  for (const v of this.parts.valves || []) {
    if (!v.g || !v.s) continue;
    const role = terminal ? 'term.valve' : v.heat ? 'ahu.valve.heat' : 'ahu.valve.cool';
    const coil = this.parts.coils.find((c) => c.suffix === v.s.v);
    const zc = v.Z + 0.42;
    const r = this._device(v.g, v.s.v, role, { pos: [0, v.lo, zc], normal: [0, 1, 0], up: [0, 0, 1], drives: coil, lineR: v.r }, `${v.s.cap} valve`);
    if (!r) continue;
    // the generic body, actuator box and cap go; the lower pipe splits around the valve
    for (const o of [v.body, v.act, v.cap]) { if (o) { o.parent?.remove(o); o.geometry?.dispose?.(); } }
    const p0 = v.pipes?.[0];
    if (p0) {
      const a = zc - r.ports.len / 2, b = zc + r.ports.len / 2;
      p0.parent?.remove(p0);
      p0.geometry.dispose();
      for (const [z0, z1] of [[v.Z, a], [b, v.Z + 0.7]]) {
        if (z1 - z0 < 0.002) continue;
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(v.r, v.r, z1 - z0, 12), p0.material);
        seg.rotation.x = Math.PI / 2;
        seg.position.set(0, v.lo, (z0 + z1) / 2);
        v.g.add(seg);
      }
    }
  }
}

// ---- the room unit on a terminal's room wall (unit page) --------------------------------------

const MODE_GLYPH = [
  [/pre[- ]?comfort|standby/i, 'standby'], [/comfort/i, 'comfort'], [/economy|eco\b/i, 'economy'],
  [/protect/i, 'protection'], [/^heat/i, 'heat'], [/^cool/i, 'cool'],
];

function roomUnit(generic, g, tx, ty, zWall) {
  const ru = this.config?.fieldDevices?.show === false ? null : roomUnitOf(this.config);
  const rec = ru ? lookup(ru.model) : null;
  if (!ru || !rec) return generic.call(this, g, tx, ty, zWall);
  const has = this.has;
  const y = -this.roomH + ru.h;                        // centre at the mounting height above the floor
  const dev = buildDevice(rec, { m: this.m, detail: 'full', color: ru.color, logo: ru.logo });
  if (!dev) return generic.call(this, g, tx, ty, zWall);
  mountDevice(g, dev, { pos: [tx, y, zWall + 0.0005], normal: [0, 0, 1], up: [0, 1, 0] });
  finishGroup(dev.group);
  let points = ['ZNSP.CMD', 'MODE.CMD', 'OCC'].filter((x) => has(x));
  if (!points.length) points = ['ZNSP', 'MODE'].filter((x) => has(x));
  const note = ru.compat ? '' : ' · QMX3 is sold for DXR controllers in the US (149-151); check PXC support';
  dev.group.userData.pick = { title: `Room unit · ${ru.model}`, points, device: ru.model, context: { device: `${contextText(rec)}${note}` } };
  const z = this._zoneCfg?.();
  this._tag(g, [tx, y + 0.35, zWall + 0.15], [
    ['ZNT', z?.tempLabel ? z.tempLabel.replace(/\s*°F/, '').toUpperCase() : 'ROOM TMP', '°F'],
    ['ZNSP', 'SETPOINT', '°F', null, 'ZNSP.CMD'],
    ['MODE', 'MODE', 'state', z?.modeStates || null, 'MODE.CMD'],
    ['OCC', 'OCCUPIED', 'onoff'], ['CO2', 'CO2', 'ppm'], ['ZNH', 'ROOM RH', '%']]);
  for (const sfx of ['ZNT', 'ZNSP', 'MODE']) if (has(sfx)) this.anchors.set(sfx, dev.group);
  (this.parts.devices ||= []).push({ sfx: 'zone.roomUnit', role: 'zone.roomUnit', spec: rec, group: dev.group, lcd: dev.lcd, ru, objects: [dev.group], room: true });
  return dev.group;
}

/** The QMX3 fields, each from its own point: '--.-' unless that point reads live. */
function lcdFields(view, ru) {
  const num = (sfx) => {
    const p = view.resolve?.(sfx);
    const v = p && p.value != null ? Number(p.value) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const a = num('ZNT'), b = num('ZNSP'), m = num('MODE'), occ = num('OCC');
  let mode = null;
  if (m != null) {
    const states = view._zoneCfg?.()?.modeStates;
    const txt = states?.[Math.round(m)] ?? '';
    mode = MODE_GLYPH.find(([re]) => re.test(txt))?.[1] ?? null;
  }
  return {
    a: a == null ? '--.-' : a.toFixed(1), b: b == null ? '--.-' : b.toFixed(1),
    mode, caps: ru?.caps || ['T'], occ: occ != null && occ > 0,
  };
}

function refreshDevices() {
  for (const d of this.parts?.devices || []) {
    if (!d.lcd) continue;
    const zLive = this.resolve?.('ZNT')?.value != null;
    drawQmx3Lcd(d.lcd, lcdFields(this, d.ru), zLive && !this.playback);
  }
}

function animateDevices() {
  for (const c of this.parts?.coils || []) {
    if (!c.stem) continue;
    c.stem.position.y = (c.stem0 || 0) + (c.stemSign || 1) * ((c.pct || 0) / 100) * (c.stroke || 0);
  }
}

function disposeDevices({ keepCache = false } = {}) {
  for (const d of this.parts?.devices || []) {
    if (d.lcd) { d.lcd.tex?.dispose(); d.lcd.mat?.dispose(); d.lcd = null; }
  }
  if (this.parts) this.parts.devices = [];
  this._dm = null;
  if (!keepCache && !this.embedded) disposeDeviceCache();
}

/** Device objects the twin shows only on the focused unit (valves stay: they are part of the pipe). */
function deviceObjects() {
  const out = [];
  for (const d of this.parts?.devices || []) if (!d.valve) out.push(...(d.objects || [d.group]));
  return out;
}
