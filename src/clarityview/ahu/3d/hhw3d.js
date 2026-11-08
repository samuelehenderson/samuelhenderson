/**
 * hhw3d.js — the heating hot water plant in 3D (a unit of kind 'hx' with config.plant):
 * the user's steam-to-hot-water plant (docs/graphic-references/hx-shell-and-tube-steam.jpg,
 * hx-steam-skid-package.jpg).
 *
 *   export const Hhw3DView = hhwViewClass(Plant3DView)          (equip3d.js)
 *
 * A factory, so this module never imports equip3d.js. On a housekeeping pad: one or two
 * horizontal shell-and-tube exchangers on saddles (red-oxide shell, bolted bundle head with
 * the two hot-water nozzles, steam nozzle on top near the head, condensate nozzle underneath
 * at the far end, vent); the steam main coming in over the top through the 1/3 + 2/3 steam
 * control valves (Siemens Flowrite globe valves with their actuators, stems following the
 * valves' live feedback) and down into each steam nozzle; condensate down through a trap
 * to a header out the back; on the hot-water side the pumps (volute, coupling guard, motor)
 * from the return header, the discharge header into each bundle head through isolation valve
 * 1, isolation valve 2 on each outlet into the supply header, the bypass from supply back to
 * return, the loop dP transmitter, and the HWS / HWR wells just downstream on the loop.
 * Pipes coloured by service: steam aluminium jacket, condensate, hot water supply (the twin's
 * --svc-hw) and return.
 *
 * Honesty: valve stems and isolation discs rest until their point reads live; a pump turns
 * only on a live run proof — or, on panels with no proof point, while it is commanded on AND
 * the loop dP reads live above 1 psi (never on the command alone); a live fault stops it and
 * lights its band red. No particles.
 */

import * as THREE from 'three';
import { plantOf, hhwPoints } from '../hx/hhw.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const S = (sym) => `HHW.${sym}`;

export function hhwViewClass(Base) {
  return class Hhw3DView extends Base {
    constructor(opts) {
      super({ ...opts, size: { h: 2.5, d: 4.6 }, eyebrow: 'Heating hot water plant · steam to hot water', presets: [['overview', 'Overview'], ['unit', 'Exchangers'], ['pump', 'Pumps'], ['valves', 'Steam valves']] });
      this.plant = plantOf(opts.config);
      this.shift = 80;
      this.legendRange = ['120°F', '180°F'];
      this.pipeR = 0.075;
      this.keyReading = ['HHW.HWS', 'HWS', '°F'];     // the twin's label reading
      this.devicePoses = 'self';
      const pts = new Map(hhwPoints(opts.config).map((p) => [p.sym, p]));
      this.pt = pts;
    }

    _buildUnit() {
      const has = this.has, m = this.m, P = this.plant, full = !this.embedded;
      this.inv = { hasRet: false, fans: [], oad: null, ead: null };
      this._newUnit();
      this.parts.hhw = { pumps: [], valves: [], isos: [] };
      const nx = P.exchangers, np = P.pumps;
      const zk = nx === 2 ? [-0.55, 0.55] : [0];
      const pxs = Array.from({ length: np }, (_, i) => -0.8 + i * 1.2);
      const xL = -3.4, xR = Math.max(2.9, pxs[np - 1] + 0.9);
      const L = xR - xL;
      const secs = [{ kind: 'hhw', w: L, cap: 'HEATING HOT WATER PLANT · STEAM TO HOT WATER', cabinet: false }];
      this.total = this._layRow(secs, { cabinet: false });
      this.sections = secs;
      const s = secs[0], g = s.group;
      const ox = -(xL + xR) / 2;
      const X = (x) => x + ox;
      const r = this.pipeR;
      const M = (o) => new THREE.MeshStandardMaterial(o);
      // pipes by service: steam (aluminium jacket), condensate, hot water supply (the twin's --svc-hw) and return
      const stm = M({ color: '#d6d9dc', metalness: 0.55, roughness: 0.35 });
      const cnd = M({ color: '#7d8a6f', metalness: 0.4, roughness: 0.5 });
      const hws = M({ color: '#e8743a', metalness: 0.25, roughness: 0.5 });
      const hwr = M({ color: '#b0592f', metalness: 0.25, roughness: 0.5 });
      const shellM = M({ color: '#8a4b33', metalness: 0.35, roughness: 0.55 });   // red-oxide shell (reference photo)
      const casing = M({ color: '#2f6f8f', metalness: 0.5, roughness: 0.42 });
      const motorM = M({ color: '#2f5f8a', metalness: 0.5, roughness: 0.45 });
      const guardM = M({ color: '#e0a526', metalness: 0.3, roughness: 0.5 });
      const pipe = (a, b, mat, rr = r) => this._pipe(g, [X(a[0]), a[1], a[2]], [X(b[0]), b[1], b[2]], rr, mat);
      const run = (pts, mat, rr = r) => { for (let i = 1; i < pts.length; i++) pipe(pts[i - 1], pts[i], mat, rr); for (let i = 1; i < pts.length - 1; i++) this._elbow(g, [X(pts[i][0]), pts[i][1], pts[i][2]], rr * 1.12, mat); };
      const cyl = (rad, len, axis, p, mat, seg = 24) => {
        const o = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, seg), mat);
        if (axis === 'x') o.rotation.z = Math.PI / 2; else if (axis === 'z') o.rotation.x = Math.PI / 2;
        o.position.set(X(p[0]), p[1], p[2]); o.castShadow = true; g.add(o); return o;
      };
      const pad = new THREE.Mesh(new THREE.BoxGeometry(L + 0.3, 0.15, 4.6), M({ color: '#6c6862', roughness: 0.95 }));
      pad.position.set(0, 0.075, 0.7); pad.receiveShadow = true; g.add(pad);
      this._sectionTag(s);

      // ---- horizontal shell-and-tube exchangers: bolted bundle head with the two hot-water nozzles,
      // steam nozzle on top near the head, condensate underneath at the far end, vent on top ----
      const R = 0.26, yc = 0.95, xs0 = -1.2, xs1 = 1.2, xSt = -0.7, xCd = 0.95;
      zk.forEach((z, k) => {
        const i = k + 1;
        const shell = cyl(R, xs1 - xs0, 'x', [(xs0 + xs1) / 2, yc, z], shellM, 32);
        const cap = new THREE.Mesh(new THREE.SphereGeometry(R, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), shellM);
        cap.rotation.z = -Math.PI / 2; cap.scale.set(0.45, 1, 1); cap.position.set(X(xs1), yc, z); g.add(cap);
        cyl(R + 0.004, 0.012, 'x', [xs1 - 0.12, yc, z], shellM, 32);                       // girth seam
        for (const fx of [xs0 - 0.01, xs0 - 0.05]) cyl(R + 0.07, 0.035, 'x', [fx, yc, z], shellM, 32);   // flange pair
        cyl(R * 0.9, 0.2, 'x', [xs0 - 0.17, yc, z], shellM, 28);                             // bundle head (bonnet)
        cyl(R * 0.9, 0.02, 'x', [xs0 - 0.27, yc, z], shellM, 28);
        if (full) for (let b = 0; b < 12; b++) { const a = (b / 12) * Math.PI * 2; cyl(0.011, 0.09, 'x', [xs0 - 0.03, yc + Math.cos(a) * (R + 0.045), z + Math.sin(a) * (R + 0.045)], m.dark, 8); }
        for (const [dy] of [[0.1], [-0.1]]) { cyl(r * 1.05, 0.12, 'x', [xs0 - 0.33, yc + dy, z], shellM, 16); cyl(r * 1.7, 0.02, 'x', [xs0 - 0.39, yc + dy, z], shellM, 18); }
        cyl(r * 1.25, 0.2, 'y', [xSt, yc + R + 0.08, z], shellM, 18); cyl(r * 2.0, 0.03, 'y', [xSt, yc + R + 0.19, z], shellM, 22);   // steam nozzle
        cyl(r * 0.8, 0.14, 'y', [xCd, yc - R - 0.05, z], shellM, 14);                            // condensate nozzle
        cyl(0.018, 0.07, 'y', [xs1 - 0.2, yc + R + 0.03, z], shellM, 10);                        // vent
        for (const sx of [-0.7, 0.8]) { const sd = new THREE.Mesh(new THREE.BoxGeometry(0.12, yc - 0.15, R * 1.7), M({ color: '#3a4046', metalness: 0.4, roughness: 0.55 })); sd.position.set(X(sx), (yc - 0.15) / 2 + 0.15, z); g.add(sd); }
        const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.08), M({ color: '#e8e6e0', roughness: 0.7 }));
        plate.position.set(X(-0.35), yc, z + R + 0.002); g.add(plate);
        const pts = [`HX${i}_ISO1`, `HX${i}_ISO2`, `HX${i}_RT`, `HXS${i}`, `HXVS${i}`, `HXR${i}`].map(S).filter((x) => has(x));
        shell.userData.pick = { title: `HX-${i} · shell-and-tube, steam to hot water`, points: pts };
        this._tag(g, [X(0.5), yc + R + 0.3, z], [[S(`HX${i}_RT`), `HX-${i} RUNTIME`, 'h']]);   // its program values are on the pick list
      });

      // ---- steam: main in at the top left, 1/3 + 2/3 control valves ABOVE, header, drops into each steam nozzle ----
      const yS = 2.35, xIn = xL + 0.1, zMid = 0;
      const xa = -2.75, xb = -1.35;
      if (P.valves === 'split') {
        run([[xIn, yS, zMid], [xa, yS, zMid]], stm);
        for (const [dz, sym, cap] of [[-0.32, 'CV1', '1/3 steam valve'], [0.32, 'CV2', '2/3 steam valve']]) {
          run([[xa, yS, zMid], [xa, yS, zMid + dz], [xb, yS, zMid + dz], [xb, yS, zMid]], stm, r * 0.8);
          this._controlValve(g, sym, [X((xa + xb) / 2), yS, zMid + dz], cap, r * 0.8);
        }
      } else {
        run([[xIn, yS, zMid], [xb, yS, zMid]], stm);
        this._controlValve(g, 'CV1', [X((xa + xb) / 2), yS, zMid], 'Steam control valve', r);
      }
      run([[xb, yS, zMid], [xSt, yS, zMid]], stm);
      if (nx === 2) run([[xSt, yS, zk[0]], [xSt, yS, zk[1]]], stm);
      zk.forEach((z) => run([[xSt, yS, z], [xSt, yc + R + 0.2, z]], stm, r * 0.85));
      this._endLabel(g, 'STEAM IN', [X(xIn), yS + 0.3, zMid]);
      // condensate: down from each shell, through a trap, to a header out the back
      const yC = 0.3, zCb = -1.5;
      zk.forEach((z) => {
        run([[xCd, yc - R - 0.12, z], [xCd, yC, z]], cnd, r * 0.6);
        const trap = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.1), M({ color: '#3e4a55', metalness: 0.5, roughness: 0.45 }));
        trap.position.set(X(xCd), 0.45, z); g.add(trap);
      });
      run([[xCd, yC, zk[nx - 1]], [xCd, yC, zCb]], cnd, r * 0.6);
      this._endLabel(g, 'CONDENSATE', [X(xCd), yC + 0.3, zCb]);

      // ---- hot water: pumps → discharge header → ISO1 → bundle head; ISO2 → supply header; bypass; dP ----
      const xSup = -2.0, yHS = 1.75, xDis = -2.25, yD = yc - 0.1, zOut = 3.0;
      const zV = 2.0, zHR = 2.55, yHR = 0.35, yDR = 1.2, zDR = 1.25;
      zk.forEach((z, k) => {
        const i = k + 1, xn = xs0 - 0.4;
        run([[xn, yc + 0.1, z], [xSup, yc + 0.1, z], [xSup, yHS, z]], hws, r * 0.85);
        this._iso(g, `HX${i}_ISO2`, [X((xn + xSup) / 2), yc + 0.1, z], 'x', `HX-${i} isolation valve 2 (supply)`, r * 0.85);
        run([[xDis, yD, z], [xn, yD, z]], hwr, r * 0.85);
        this._iso(g, `HX${i}_ISO1`, [X((xn + xDis) / 2 + 0.05), yD, z], 'x', `HX-${i} isolation valve 1 (return)`, r * 0.85);
      });
      run([[xSup, yHS, zk[0]], [xSup, yHS, zOut]], hws);
      this._cap(g, [X(xSup), yHS, zk[0]]);
      run([[pxs[np - 1], yDR, zDR], [xDis, yDR, zDR], [xDis, yD, zDR], [xDis, yD, zk[0]]], hwr);
      this._cap(g, [X(pxs[np - 1]), yDR, zDR]);
      run([[xR - 0.05, yHR, zHR], [xSup, yHR, zHR]], hwr);
      pxs.forEach((px, k) => this._pumpSet(g, k + 1, X(px), { yRH: yHR, zR: zHR, yDH: yDR, zS: zDR, zV, casing, motorM, guardM, insR: hwr, full }));
      this._endLabel(g, 'HW SUPPLY →', [X(xSup), yHS + 0.3, zOut]);
      this._endLabel(g, '← HW RETURN', [X(xR - 0.1), yHR + 0.3, zHR]);
      // bypass: hot water from the supply header straight back to the return (the plant loop)
      if (has(S('BYP'))) {
        run([[xSup, yHS, zHR], [xSup, yHR, zHR]], hwr, r * 0.75);
        this._controlValve(g, 'BYP', [X(xSup), (yHS + yHR) / 2 + 0.1, zHR], 'HW bypass valve', r * 0.75, 'y');
      }
      this._dpt(g, [X(xSup - 0.55), 1.05, zHR + 0.05], [X(xSup), yHS - r, zHR - 0.25], [X(xSup) + 0.35, yHR + r, zHR]);
      // supply / return temperatures, just downstream on the loop
      this._well(g, 'HWS', [X(xSup), yHS + r, zDR + 0.35], 'HWS');
      this._well(g, 'HWR', [X(xR - 0.55), yHR + r, zHR], 'HWR');
      this._tag(g, [X(xL) + 0.3, 1.25, -1.2], [[S('SYS_ENA'), 'SYSTEM', 'onoff'], [S('MAX_VLV'), 'MAX VLV', '%'], [S('HXLL'), 'HX LEAD (HXLL)', ''], [S('PLL'), 'PUMP LEAD (PLL)', '']]);
      // where the building's hot water connects (pipe router): supply out the front, return in at the right
      this.outletLocal = { x: X(xSup) + s.baseX, y: yHS, z: zOut, w: r * 2.2, h: r * 2.2, dir: [0, 0, 1] };
      this.returnLocal = { x: X(xR - 0.05) + s.baseX, y: yHR, z: zHR, r, dir: [1, 0, 0] };
      this.hhwDims = { hxX: [X(0)], zk, pxs: pxs.map(X), xL: X(xL), xR: X(xR), steam: [X((xa + xb) / 2), yS, 0] };
    }

    _endLabel(g, text, pos) { const o = this._label(text, 'a3-sec'); o.position.set(...pos); g.add(o); }

    _elbow(g, p, rr, mat) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(rr, 14, 10), mat);
      b.position.set(...p); g.add(b);
    }
    _cap(g, p) { this._elbow(g, p, this.pipeR * 1.1, this.m.steel); }

    /** A Siemens globe control valve (library) on the line, stem following its live feedback; generic if the library draws nothing. */
    _controlValve(g, sym, pos, caption, lineR, axis = 'x') {
      const has = this.has, cmd = S(sym), fb = S(`${sym}_FB`);
      if (!has(cmd)) return;
      const rec = { sfx: has(fb) ? fb : cmd, pct: 0, target: 0 };
      const up = axis === 'y' ? [0, 1, 0] : [1, 0, 0], normal = axis === 'y' ? [0, 0, 1] : [0, 1, 0];
      let dev = null;
      try { dev = this._device?.(g, cmd, 'ahu.valve.heat', { pos, normal, up, drives: rec, lineR, points: [cmd, fb].filter(has) }, caption); } catch { dev = null; }
      if (!dev) {
        const vg = this._cvalve(g, cmd, pos, caption);
        vg.userData.pick = { title: caption, points: [cmd, fb].filter(has) };
        vg.userData.noFootprint = true;                 // like the library valve: the pipe is the footprint
        this.parts.cvalves.at(-1).suffix = rec.sfx;
      } else this.parts.hhw.valves.push(rec);
      const tagPos = axis === 'y' ? [pos[0] + 0.35, pos[1] + 0.2, pos[2]] : [pos[0], pos[1] + 0.62, pos[2]];
      this._tag(g, tagPos, [[cmd, caption.toUpperCase(), '%'], [fb, 'FEEDBACK', '%']]);
    }

    /** A butterfly isolation valve: lug body, disc (turns with a live position), actuator. */
    _iso(g, sym, pos, axis, caption, lineR) {
      const has = this.has, sfx = S(sym);
      if (!has(sfx)) return;
      const m = this.m, vg = new THREE.Group();
      vg.position.set(...pos);
      if (axis === 'y') vg.rotation.z = Math.PI / 2;           // pipe vertical: the body's bore runs along y
      g.add(vg);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(lineR * 1.9, lineR * 1.9, 0.07, 22), new THREE.MeshStandardMaterial({ color: '#3e4a55', metalness: 0.5, roughness: 0.45 }));
      body.rotation.z = Math.PI / 2; vg.add(body);
      const pivot = new THREE.Group();                        // the stem axis (local z): the disc turns about it
      vg.add(pivot);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(lineR * 0.95, lineR * 0.95, 0.012, 20), m.steel);
      disc.rotation.z = Math.PI / 2; pivot.add(disc);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.12, 10), m.steel);
      neck.position.set(0, 0, lineR * 1.9 + 0.05); neck.rotation.x = Math.PI / 2; vg.add(neck);
      const act = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.1), new THREE.MeshStandardMaterial({ color: '#8f9aa3', metalness: 0.2, roughness: 0.55 }));
      act.position.set(0, 0, lineR * 1.9 + 0.16); vg.add(act);
      const binary = this.pt.get(sym)?.kind === 'onoff';
      this.parts.hhw.isos.push({ sfx, disc, pivot, binary, pct: 0, target: 0 });
      vg.userData.pick = { title: caption, points: [sfx] };
      this._tag(g, [pos[0] + (axis === 'y' ? 0.3 : 0), pos[1] + 0.05, pos[2] + 0.25], [[sfx, sym.replace(/^HX(\d)_/, 'HX-$1 '), binary ? 'onoff' : '%']]);
    }

    /** One pump: suction from the return header, volute, coupling under a guard, motor; discharge up into the header. */
    _pumpSet(g, i, x, { yRH, zR, yDH, zS, zV = 1.45, casing, motorM, guardM, insR, full }) {
      const m = this.m, has = this.has, r = this.pipeR * 0.8;
      const ys = 0.55;
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.1, 1.25), m.rail);
      base.position.set(x, 0.2, zV - 0.2); g.add(base);
      const vol = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.2, 30), casing);
      vol.rotation.x = Math.PI / 2; vol.position.set(x, ys, zV); vol.castShadow = true; g.add(vol);
      const scroll = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.06, 10, 28, Math.PI * 1.4), casing);
      scroll.position.set(x, ys, zV); g.add(scroll);
      this._pipe(g, [x, yRH, zR], [x, ys, zR], r, insR);
      this._pipe(g, [x, ys, zR], [x, ys, zV + 0.1], r, insR);
      this._elbow(g, [x, ys, zR], r * 1.1, insR);
      this._pipe(g, [x, ys + 0.24, zV], [x, yDH, zV], r, insR);
      this._pipe(g, [x, yDH, zV], [x, yDH, zS], r, insR);
      this._elbow(g, [x, yDH, zV], r * 1.1, insR);
      const tdv = new THREE.Mesh(new THREE.SphereGeometry(r * 1.4, 14, 10), m.brass);
      tdv.position.set(x, ys + 0.5, zV); g.add(tdv);
      const coup = new THREE.Group();
      coup.position.set(x, ys, zV - 0.3);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.12, 16), m.steel);
      hub.rotation.x = Math.PI / 2; coup.add(hub);
      for (let k = 0; k < 4; k++) { const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.1), m.dark); jaw.position.set(Math.cos(k * Math.PI / 2) * 0.07, Math.sin(k * Math.PI / 2) * 0.07, 0); coup.add(jaw); }
      g.add(coup);
      for (const dx of [-0.13, 0.13]) { const bar = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.26, 0.22), guardM); bar.position.set(x + dx, ys, zV - 0.3); g.add(bar); }
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.55, 24), motorM);
      motor.rotation.x = Math.PI / 2; motor.position.set(x, ys, zV - 0.72); motor.castShadow = true; g.add(motor);
      if (full) for (let k = 0; k < 6; k++) { const rib = new THREE.Mesh(new THREE.TorusGeometry(0.192, 0.008, 6, 24), m.dark); rib.position.set(x, ys, zV - 0.94 + k * 0.08); g.add(rib); }
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.012, 8, 32), new THREE.MeshStandardMaterial({ color: '#1d2a30', emissive: '#46d3e6', emissiveIntensity: 0 }));
      band.position.set(x, ys, zV - 1.0); g.add(band);
      const sfx = (k) => S(`P${i}_${k}`);
      const pts = ['SS', 'STS', 'SVD', 'FLT', 'OVR', 'RT'].map(sfx).concat([S(`PVC${i}`), S(`PVR${i}`)]).filter((s) => has(s));
      for (const o of [vol, motor]) o.userData.pick = { title: `Pump P-${i}`, points: pts };
      this.parts.hhw.pumps.push({ i, coup, band, speed: 0, target: 0, fault: false });
      this._tag(g, [x + 0.42, 1.0, zV + 0.2], [[sfx('SS'), `P-${i} CMD`, 'onoff'], [sfx('STS'), 'STATUS', 'onoff'], [sfx('SVD'), 'SPEED', '%'], [sfx('FLT'), 'FAULT', 'alm']]);
    }

    /** dP transmitter on a stand, sensing tubes to the supply and return headers. */
    _dpt(g, pos, hi, lo) {
      const has = this.has, m = this.m;
      if (!has(S('DP'))) return;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.09), new THREE.MeshStandardMaterial({ color: '#b9bec2', metalness: 0.1, roughness: 0.6 }));
      box.position.set(...pos); g.add(box);
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.03, pos[1] - 0.15, 0.03), m.rail);
      stand.position.set(pos[0], (pos[1] - 0.15) / 2 + 0.15, pos[2] - 0.06); g.add(stand);
      const tube = new THREE.MeshStandardMaterial({ color: '#c49b4a', metalness: 0.8, roughness: 0.3 });
      for (const [t, dx] of [[hi, -0.04], [lo, 0.04]]) {
        const a = [pos[0] + dx, pos[1] + (t[1] > pos[1] ? 0.09 : -0.09), pos[2]];
        const bend = [pos[0] + dx, t[1], pos[2]];
        this._pipe(g, a, bend, 0.005, tube);
        this._pipe(g, bend, [t[0] + dx, t[1], t[2]], 0.005, tube);
      }
      box.userData.pick = { title: 'Loop dP transmitter', points: [S('DP'), S('DP_SP')].filter(has) };
      this._tag(g, [pos[0] - 0.25, pos[1] + 0.1, pos[2]], [[S('DP'), 'LOOP DP', 'psi'], [S('DP_SP'), 'DP SP', 'psi']]);
    }

    _well(g, sym, pos, cap) {
      const has = this.has, sfx = S(sym);
      if (!has(sfx)) return;
      const well = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 10), this.m.brass);
      well.position.set(pos[0], pos[1] + 0.06, pos[2]); g.add(well);
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 14), new THREE.MeshStandardMaterial({ color: '#d9dcde', roughness: 0.6 }));
      head.position.set(pos[0], pos[1] + 0.14, pos[2]); g.add(head);
      head.userData.pick = { title: `${cap} temperature`, points: [sfx] };
      this._tag(g, [pos[0], pos[1] + 0.32, pos[2]], [[sfx, cap, '°F']]);
    }

    // ---- values → motion (live only) ----
    _refreshExtra() {
      super._refreshExtra();
      const n = (sfx) => (this.has(sfx) ? this._num(sfx) : NaN);
      const fin = Number.isFinite;
      const dp = n(S('DP'));
      for (const p of this.parts.hhw?.pumps || []) {
        const sts = n(S(`P${p.i}_STS`)), ss = n(S(`P${p.i}_SS`)), spd = n(S(`P${p.i}_SVD`)), flt = n(S(`P${p.i}_FLT`));
        p.fault = flt > 0;
        const proven = fin(sts) ? sts > 0 : !this.plant.pumpProof && ss > 0 && fin(dp) && dp > 1;
        p.target = proven && !p.fault ? (fin(spd) ? clamp(spd, 10, 100) : 100) : 0;
      }
      for (const v of this.parts.hhw?.valves || []) v.target = clamp(n(v.sfx) || 0, 0, 100);
      for (const v of this.parts.hhw?.isos || []) { const x = n(v.sfx); v.target = fin(x) ? (v.binary ? (x > 0 ? 100 : 0) : clamp(x, 0, 100)) : 0; }
    }

    _frameParts(dt, now) {
      super._frameParts(dt, now);
      for (const p of this.parts.hhw?.pumps || []) {
        p.speed = damp(p.speed, p.target, 1.6, dt);
        p.coup.rotation.z += dt * (p.speed / 100) * Math.PI * 2 * 6;
        p.band.material.emissive.set(p.fault ? '#ff3b2a' : '#46d3e6');
        p.band.material.emissiveIntensity = p.fault ? 1.2 + Math.sin(now / 200) : (p.speed / 100) * 1.4;
      }
      for (const v of this.parts.hhw?.valves || []) {
        v.pct = damp(v.pct, v.target, 2.5, dt);
        if (v.stem) v.stem.position.y = (v.stem0 || 0) + (v.stemSign || 1) * (v.pct / 100) * (v.stroke || 0);
      }
      for (const v of this.parts.hhw?.isos || []) {
        v.pct = damp(v.pct, v.target, 2.5, dt);
        v.pivot.rotation.z = -(v.pct / 100) * Math.PI / 2;           // 0 % = disc across the bore (shut), 100 % = edge-on (open)
      }
    }

    isRunning() { return (this.parts.hhw?.pumps || []).some((p) => p.target > 0); }
    hasFault() { return (this.parts.hhw?.pumps || []).some((p) => p.fault); }
    _flowTarget() { return 0; }
    _updateAir() { if (this.air) this.air.points.visible = false; }
    _refreshAir() { this.water = { s: this._w(150) }; this.vals = { oat: this.water.s, rat: this.water.s, mix: this.water.s }; this.tempStations = []; }

    _presetView(name, instant = false) {
      const d = this.hhwDims;
      if (!d || name === 'overview') return super._presetView(name, instant);
      if (name === 'unit') return this._tween(name, new THREE.Vector3(d.hxX[0], 1.1, 0.2), new THREE.Vector3(d.hxX[0] - 2.2, 2.6, 4.4), instant);
      if (name === 'pump') { const x = (d.pxs[0] + d.pxs[d.pxs.length - 1]) / 2; return this._tween(name, new THREE.Vector3(x, 0.8, 1.9), new THREE.Vector3(x + 1.2, 2.1, 5.2), instant); }
      const [x, y, z] = d.steam;
      return this._tween(name, new THREE.Vector3(x + 0.3, y - 0.3, z), new THREE.Vector3(x - 0.9, y + 0.9, z + 2.6), instant);
    }

    _kpiDefs() { return [[S('HWS'), 'HWS', '°F'], [S('HWS_SP'), 'HWS SP', '°F'], [S('HWR'), 'HWR', '°F'], [S('DP'), 'Loop dP', 'psi'], [S('DP_SP'), 'dP SP', 'psi'], [S('OAT'), 'OAT', '°F']]; }
    _modeDefs() {
      const out = [[S('SYS_ENA'), 'Enabled'], [S('TMP_ALM'), 'Temp alarm', 1], [S('HX_CHG_ALM'), 'HX changeover alarm', 1]];
      for (let i = 1; i <= this.plant.pumps; i++) out.push([S(`P${i}_FLT`), `P-${i} fault`, 1]);
      return out.filter(([s]) => this.has(s));
    }
  };
}
