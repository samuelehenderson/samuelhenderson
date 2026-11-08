/**
 * rtu3d.js — a packaged rooftop unit (config.form 'rtu') in 3D.
 *
 * An RTU's air side is an air handler: the same sections, parts, readouts, air
 * streams and honesty rules, all from Ahu3DView unchanged. What makes it a
 * rooftop unit is added here:
 *
 *   condensing section  at the discharge end: condenser coil on three faces
 *                       behind a hail guard, a tandem pair of scroll
 *                       compressors on the base, propeller fans on the top deck
 *   side discharge      the supply leaves through the back face (the end is
 *                       the condensing section), so the twin's ductwork starts
 *                       there (outletLocal points -z)
 *   return              defaults to the floor (from the curb) instead of the end
 *
 * The condenser fans do not turn: no point proves them running (a condenser fan
 * or compressor point is not part of an RTU's usual point set), and nothing on
 * a ClarityView graphic moves without a live point behind it.
 */

import * as THREE from 'three';
import { Ahu3DView } from './ahu3d.js';

const COND_W = 2.3;   // condensing section length, metres
const GAP = 0.8;      // explode spacing (ahu3d.js)

export class Rtu3DView extends Ahu3DView {
  constructor(opts = {}) {
    // lower and wider than an air handler: about 4 ft 9 in tall, 7 ft deep
    super({ ...opts, size: opts.size || { h: 1.45, d: 2.15 }, eyebrow: opts.eyebrow || 'Rooftop unit' });
    this.layout = { ...this.layout, ret: 'floor' };
    // A rooftop unit only has a condensing section if it makes its own cooling.
    // A unit fed from a chilled-water plant (a modulating CHW valve and no
    // compressors) has no condenser, so no coil, no scroll pair and — the bit
    // that shows — no propeller fans on the roof. Default stays DX so existing
    // units are unchanged; `condenser: false` draws the hydronic kind.
    this.condenser = opts.config?.condenser !== false;
  }

  _buildUnit() {
    // the end of the unit is closed on an RTU: return comes up from the curb,
    // and the swapped layout (outside air in the end) does not apply
    if (this.layout.ret === 'end') this.layout.ret = 'floor';
    this.layout.swap = false;
    super._buildUnit();

    // Without a condensing section the air side is the whole unit: it keeps the
    // end discharge an air handler already draws (a rooftop AHU goes up into its
    // own transition there), and only the curb return above still applies.
    if (!this.condenser) {
      if (!this.inv.oad && this.has('OAT')) {
        const f = this.sections[0];
        this._tag(f.group, [-f.w / 2 - 0.35, this.DH + 0.35, this.D / 2], [['OAT', 'OA TMP', '°F']]);
      }
      return;
    }

    const secs = this.sections;
    // make room for the condensing section after the last air section: slide
    // every section half its length to the left (sections, readouts and the air
    // streams all work from section positions, so they stay together)
    for (const s of secs) { s.baseX -= COND_W / 2; s.group.position.x = s.baseX; }
    const cond = new THREE.Group();
    this.condBase = this.total / 2;          // centre of the new end section
    cond.position.x = this.condBase;
    this.unit.add(cond);
    this._condensing(cond, COND_W);
    this.condSec = cond;
    this.total += COND_W;

    const dis = secs[secs.length - 1];
    if (dis.kind === 'discharge') {
      // swap the end duct for a side one; keep the discharge readouts, inside the section
      // (hidden, not removed: a removed readout would detach its label element)
      for (const o of dis.group.children) if (o.position.x > dis.w / 2 + 0.001) o.visible = false;
      this._faceDuct(dis.group, dis.w, 'back');
      const has = this.has;
      const pick = (c) => c.find((x) => x && has(x)) || null;
      this._tag(dis.group, [0, this.DH + 0.45, this.D / 2], [['SAT', 'SA TMP', '°F'], [pick(['SAT.SP', 'SATSP']), 'SA SP', '°F'],
        [pick(['SSP', 'SA.SP.PRES', 'DSP']), 'STATIC', 'inWC'], [pick(['SA.CFM', 'SA.FLW', 'SAF.CFM']), 'SA FLOW', 'cfm'],
        [pick(['SAH', 'SA.RH']), 'SA RH', '%']]);
      this.outletLocal = { x: dis.baseX, y: this.DH / 2, z: -this.D / 2 - 0.7, w: dis.w * 0.8, h: this.DH * 0.7, dir: [0, 0, -1] };
    }
    // outside-air temperature with no OA damper (no intake section to hang it on)
    if (!this.inv.oad && this.has('OAT')) {
      const first = secs[0];
      this._tag(first.group, [-first.w / 2 - 0.35, this.DH + 0.35, this.D / 2], [['OAT', 'OA TMP', '°F']]);
    }
  }

  /** The condensing section slides out with the others in the exploded view. */
  _frameFx(dt, now) {
    super._frameFx(dt, now);
    if (!this.condSec) return;
    const n = this.sections.length;
    const mid = this.exMid ?? (n - 1) / 2;
    this.condSec.position.x = this.condBase + (n - mid) * GAP * (this.explode || 0);
  }

  /** Supply turns out the back face through the side duct instead of the end. */
  _paths() {
    const out = super._paths();
    if (!this.condenser) return out;   // no condensing section: the air leaves by the end, as drawn
    const secs = this.sections;
    const dis = secs[secs.length - 1];
    if (dis.kind !== 'discharge') return out;
    const endX = dis.group.position.x + dis.w / 2 + 1.6;
    const dx = dis.group.position.x, y = this.DH / 2;
    for (const k of Object.keys(out)) {
      const pts = out[k].pts.map((p) => [...p]);
      const last = pts[pts.length - 1];
      if (Math.abs(last[0] - endX) > 1e-6) continue;
      pts.splice(pts.length - 1, 1, [dx, y, 0], [dx, y, -this.D / 2 - 1.6]);
      let L = 0;
      const seg = [];
      for (let i = 1; i < pts.length; i++) {
        const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
        seg.push(l); L += l;
      }
      out[k] = { ...out[k], pts, seg, L };
    }
    return out;
  }

  _condensing(g, L) {
    const H = this.DH, W = this.D, m = this.m;
    // panels follow the casing finish: dark steel with the clear casing, matte grey with grey
    const paint = new THREE.MeshStandardMaterial(this.casing === 'grey'
      ? { color: '#4a5258', metalness: 0.1, roughness: 0.85 }
      : { color: '#30373d', metalness: 0.55, roughness: 0.42 });
    const dark = new THREE.MeshStandardMaterial({ color: '#2a3036', metalness: 0.5, roughness: 0.45 });
    const box = (sx, sy, sz, x, y, z, mat = paint) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
      b.position.set(x, y, z); b.castShadow = true; b.receiveShadow = true; g.add(b); return b;
    };
    const x0 = -L / 2, x1 = L / 2;

    // base rail, corner posts
    box(L, 0.1, W, 0, 0.05, 0);
    for (const x of [x0 + 0.04, x1 - 0.04]) for (const z of [-W / 2 + 0.04, W / 2 - 0.04]) box(0.08, H, 0.08, x, H / 2, z);
    // compressor compartment: a solid lower band each side, access-panel handles
    const lowH = 0.42;
    for (const z of [W / 2 - 0.015, -W / 2 + 0.015]) box(L - 0.02, lowH, 0.03, 0, 0.1 + lowH / 2, z);
    for (const x of [-0.45, 0.45]) box(0.12, 0.03, 0.03, x, 0.1 + lowH / 2, W / 2 + 0.01, m.rail);

    // condenser coil on three faces above the compressors, hail guard slats outside
    const finTex = (() => {
      const cv = document.createElement('canvas');
      cv.width = 64; cv.height = 8;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#8b969c'; cx.fillRect(0, 0, 64, 8);
      cx.fillStyle = '#4b555b';
      for (let i = 0; i < 64; i += 2) cx.fillRect(i, 0, 1, 8);
      const t = new THREE.CanvasTexture(cv);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const slatMat = new THREE.MeshStandardMaterial({ color: '#8d928c', metalness: 0.3, roughness: 0.6 });
    const yb = 0.1 + lowH, yt = H - 0.06, ch = yt - yb;
    const coil = (len, rotY, x, z) => {
      const tex = finTex.clone(); tex.needsUpdate = true; tex.repeat.set(len * 14, 1);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(len, ch, 0.07),
        new THREE.MeshStandardMaterial({ color: '#cfd6d9', map: tex, metalness: 0.5, roughness: 0.55 }));
      slab.rotation.y = rotY;
      slab.position.set(x, yb + ch / 2, z);
      slab.castShadow = true;
      g.add(slab);
      const slats = new THREE.Group();
      for (let y = 0.05; y < ch - 0.02; y += 0.12) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(len - 0.06, 0.018, 0.01), slatMat);
        s.position.set(0, y - ch / 2, 0.075);
        slats.add(s);
      }
      slats.rotation.y = rotY;
      slats.position.copy(slab.position);
      g.add(slats);
    };
    coil(L - 0.14, 0, 0, W / 2 - 0.06);
    coil(L - 0.14, Math.PI, 0, -W / 2 + 0.06);
    coil(W - 0.14, Math.PI / 2, x1 - 0.06, 0);
    for (const z of [W / 2 - 0.06, -W / 2 + 0.06]) {
      for (let i = 0; i < 8; i++) {
        const u = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.008, 6, 10, Math.PI), m.copper);
        u.rotation.y = Math.PI / 2;
        u.position.set(x0 + 0.05, yb + ch * (i + 0.5) / 8, z);
        g.add(u);
      }
    }

    // scroll compressors (a tandem pair) with their discharge lines
    for (const dx of [-0.3, 0.3]) {
      const c = new THREE.Group();
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.48, 24), dark);
      shell.position.y = 0.24; shell.castShadow = true; c.add(shell);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), dark);
      dome.position.y = 0.48; c.add(dome);
      const tb = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.08), m.dark);
      tb.position.set(0, 0.32, 0.16); c.add(tb);
      c.position.set(dx, 0.1, 0);
      g.add(c);
      const line = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, yb + 0.1 - 0.68, 10), m.copper);
      line.position.set(dx, (0.68 + yb + 0.1) / 2, 0);
      g.add(line);
    }

    // top deck: two propeller fans in venturi shrouds, wire guards
    box(L, 0.04, W, 0, H, 0);
    const fanR = Math.min(0.5, W / 2 - 0.2);
    const shroudMat = new THREE.MeshStandardMaterial({ color: '#2c3339', metalness: 0.4, roughness: 0.55, side: THREE.DoubleSide });
    const bladeMat = new THREE.MeshStandardMaterial({ color: '#3a434b', metalness: 0.3, roughness: 0.5 });
    const guardMat = new THREE.MeshStandardMaterial({ color: '#15191d', metalness: 0.6, roughness: 0.4 });
    for (const fx of [-L / 4, L / 4]) {
      const fan = new THREE.Group();
      fan.position.set(fx, H, 0);
      g.add(fan);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(fanR, 36), new THREE.MeshBasicMaterial({ color: '#07090b' }));
      hole.rotation.x = -Math.PI / 2; hole.position.y = 0.022; fan.add(hole);
      const shroud = new THREE.Mesh(new THREE.CylinderGeometry(fanR + 0.02, fanR + 0.05, 0.24, 40, 1, true), shroudMat);
      shroud.position.y = 0.14; fan.add(shroud);
      const lip = new THREE.Mesh(new THREE.TorusGeometry(fanR + 0.03, 0.02, 8, 40), shroudMat);
      lip.rotation.x = Math.PI / 2; lip.position.y = 0.26; fan.add(lip);
      const rotor = new THREE.Group();
      rotor.position.y = 0.12;
      for (let b = 0; b < 4; b++) {
        const piv = new THREE.Group();
        piv.rotation.y = (b / 4) * Math.PI * 2 + 0.3;
        const blade = new THREE.Mesh(new THREE.BoxGeometry(fanR * 0.8, 0.012, 0.2), bladeMat);
        blade.position.x = fanR * 0.47; blade.rotation.x = 0.42;
        piv.add(blade); rotor.add(piv);
      }
      rotor.add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.1, 16), m.dark));
      fan.add(rotor);
      for (const rr of [fanR * 0.35, fanR * 0.68, fanR + 0.01]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.006, 4, 36), guardMat);
        ring.rotation.x = Math.PI / 2; ring.position.y = 0.29; fan.add(ring);
      }
      for (let k = 0; k < 8; k++) {
        const sp = new THREE.Mesh(new THREE.BoxGeometry(fanR * 2, 0.008, 0.008), guardMat);
        sp.rotation.y = (k / 8) * Math.PI; sp.position.y = 0.29; fan.add(sp);
      }
    }
  }
}
