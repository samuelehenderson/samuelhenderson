/**
 * panel3d.js — wall-hung units in 3D: the Siemens field panel and the VFD.
 *
 *   export const { Panel3DView, Vfd3DView } = wallViewClasses(Family3DView)   (equip3d.js)
 *
 * A factory, so this module never imports equip3d.js (no cycle). Both views
 * are built from pure data (web/shared/siemens/panels.js, web/shared/drives.js)
 * in real millimetres and hang on a wall: the back of the unit is the wall
 * line (z = 0 on the unit page; in the building twin the model turns so its
 * front faces the placement's +x, which the plan editor points into the room),
 * its top at the mounting height (placement.mount, else 5'-0" panel / 5'-6" VFD).
 *
 * Field panel, built like the real ones (docs/graphic-references/field-panel-real-2/4):
 * a tall grey cabinet with a hinged door (click it: it swings open), a perforated
 * grey back plate framed by slotted duct (covers on), the controller at the top of
 * a vertical DIN rail with the TXS1.12F4 (grey) and the TX-I/O stacked below it
 * (dark terminal bases, grey covers, an LED column, wires with white markers
 * fanning into the side ducts), a second column when the rail runs out, and the
 * power column on the right: the Siemens power supply box (yellow warning label,
 * rocker, "120V FED FROM PNL … CKT …"), a duplex receptacle, 24 V terminal blocks
 * and optional RIBMN relays. Conduits come in through the top.
 *
 * Honesty: nothing is lit without live data. The controller's RUN LED and the
 * bus LEDs light only while a point of that panel reads live; a module's LED
 * only while one of its channels does; a channel LED only while its point is
 * live (digital channels: while live AND on). The VFD keypad shows output Hz
 * and run state only from live points, else "--" on a dark screen; RUN / ALM /
 * READY follow live points only. No particles, no motion but the door.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { panelLayout, panelChannels, MODULES, MODULE_H } from '../../shared/siemens/panels.js';
import { vfdOf, vfdFrame, VFD_MAKES, VFD_POINTS } from '../../shared/drives.js';
import { mountOf } from '../../shared/wall-units.js';

const MM = 0.001;
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const fin = Number.isFinite;
const DOOR_OPEN = 2.9;            // rad, how far the door swings (≈ 166°: wide open, back toward the wall)
const LED = { off: '#2e3438', green: '#3dff84', yellow: '#ffcf3a', blue: '#4dbbff', red: '#ff3b2a' };

// ---- small builders -----------------------------------------------------------------

/** Geometry collected per material, merged into one mesh each. */
class Batch {
  constructor() { this.m = new Map(); }
  add(key, g) { if (this.xf) g.applyMatrix4(this.xf); if (!this.m.has(key)) this.m.set(key, []); this.m.get(key).push(g.index ? g.toNonIndexed() : g); return g; }
  box(key, w, h, d, x, y, z) { const g = new THREE.BoxGeometry(Math.max(w, 1e-4), Math.max(h, 1e-4), Math.max(d, 1e-4)); g.translate(x, y, z); return this.add(key, g); }
  /** Cylinder along an axis ('x' | 'y' | 'z'), centred on (x, y, z). */
  cyl(key, r, len, axis, x, y, z, seg = 14) {
    const g = new THREE.CylinderGeometry(r, r, Math.max(len, 1e-4), seg);
    if (axis === 'x') g.rotateZ(Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    return this.add(key, g);
  }
  /** A straight tube between two points. */
  tube(key, a, b, r, seg = 6) {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const len = va.distanceTo(vb);
    if (len < 1e-5) return null;
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize()));
    const c = va.lerp(vb, 0.5);
    g.translate(c.x, c.y, c.z);
    return this.add(key, g);
  }
  flush(parent, mats, { shadow = false, receive = true } = {}) {
    const out = {};
    for (const [key, list] of this.m) {
      if (!list.length || !mats[key]) continue;
      const geo = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mats[key]);
      mesh.castShadow = shadow; mesh.receiveShadow = receive;
      mesh.name = key;
      parent.add(mesh);
      out[key] = mesh;
    }
    this.m.clear();
    return out;
  }
}

/** Text drawn once into one canvas; label planes take their UVs from it (one material). */
class Atlas {
  constructor(size = 1024) {
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    this.g = this.canvas.getContext('2d');
    this.x = 0; this.y = 0; this.row = 0;
  }
  add(text, { px = 26, weight = 700, color = '#2a2f33', bg = null, pad = 5, family = 'Manrope, Arial, sans-serif', minW = 0 } = {}) {
    const g = this.g;
    if (!g) return { u0: 0, v0: 0, u1: 0.001, v1: 0.001, aspect: Math.max(1, String(text).length * 0.6) };
    g.font = `${weight} ${px}px ${family}`;
    const tw = Math.ceil(g.measureText(String(text)).width) + pad * 2;
    const w = Math.max(tw, minW), h = Math.ceil(px * 1.25) + pad * 2;
    if (this.x + w > this.size) { this.x = 0; this.y += this.row + 2; this.row = 0; }
    if (this.y + h > this.size) return { u0: 0, v0: 0, u1: 0.001, v1: 0.001, aspect: w / h };
    if (bg) { g.fillStyle = bg; g.fillRect(this.x, this.y, w, h); }
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(text), this.x + w / 2, this.y + h / 2 + 1);
    const r = { u0: this.x / this.size, v0: 1 - (this.y + h) / this.size, u1: (this.x + w) / this.size, v1: 1 - this.y / this.size, aspect: w / h };
    this.x += w + 2; this.row = Math.max(this.row, h);
    return r;
  }
  /** Plane of height h (metres) showing rect r, centred on (x, y, z), facing +z (or rotated). */
  plane(r, h, x, y, z, { rotZ = 0, rotY = 0, w = null } = {}) {
    const g = new THREE.PlaneGeometry(w ?? h * r.aspect, h);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
    if (rotZ) g.rotateZ(rotZ);
    if (rotY) g.rotateY(rotY);
    g.translate(x, y, z);
    return g;
  }
  texture() {
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
}

/** Indicator LEDs: one instanced mesh, colour per instance (unlit, so a lit LED reads as light). */
class Leds {
  constructor() { this.list = []; }
  add(key, x, y, z, w = 0.003, h = 0.003, d = 0.0015, on = 'green') { this.list.push({ key, x, y, z, w, h, d, on }); return this.list.length - 1; }
  build(parent) {
    if (!this.list.length) return null;
    const mat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, this.list.length);
    const m4 = new THREE.Matrix4(), c = new THREE.Color(LED.off);
    this.list.forEach((l, i) => {
      m4.compose(new THREE.Vector3(l.x, l.y, l.z), new THREE.Quaternion(), new THREE.Vector3(l.w, l.h, l.d));
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, c);
    });
    mesh.userData.noFootprint = true;
    mesh.name = 'leds';
    parent.add(mesh);
    this.mesh = mesh;
    this.state = this.list.map(() => 'off');
    return mesh;
  }
  /** Light each LED by key: fn(key, led) → 'off' | colour name. Only touches the GPU when something changed. */
  set(fn) {
    if (!this.mesh) return;
    let dirty = false;
    const c = new THREE.Color();
    this.list.forEach((l, i) => {
      const s = fn(l.key, l) || 'off';
      if (s === this.state[i]) return;
      this.state[i] = s;
      this.mesh.setColorAt(i, c.set(LED[s] || LED.off));
      dirty = true;
    });
    if (dirty) this.mesh.instanceColor.needsUpdate = true;
  }
  lit(key) { const i = this.list.findIndex((l) => l.key === key); return i >= 0 ? this.state[i] : null; }
}

const pickProxy = (parent, w, h, d, x, y, z, pick) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ visible: false }));
  m.position.set(x, y, z);
  m.userData.pick = pick;
  m.userData.noFootprint = true;
  parent.add(m);
  return m;
};

/** A perforated-plate texture (1/4 in holes on a 1/2 in stagger), one per page. */
let PERF = null;
function perfTexture() {
  if (PERF) return PERF;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#3a4045';
    for (const [x, y] of [[16, 16], [48, 48], [48, -16], [-16, 48], [80, 48], [48, 80]]) { g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill(); }
  }
  PERF = new THREE.CanvasTexture(c);
  PERF.wrapS = PERF.wrapT = THREE.RepeatWrapping;
  PERF.colorSpace = THREE.SRGBColorSpace;
  PERF.anisotropy = 4;
  PERF.userData = { shared: true };
  return PERF;
}

/** Materials for wall units, one set per material set (the twin shares them across units). */
function wallMaterials(m) {
  if (m.wall) return m.wall;
  const S = (o, cls = THREE.MeshStandardMaterial) => { const x = new cls(o); x.userData.physical = true; x.userData.shared = true; return x; };
  m.wall = {
    encl: S({ color: '#c6cbce', metalness: 0.18, roughness: 0.55, envMapIntensity: 0.35 }),
    enclIn: S({ color: '#b8bdc1', metalness: 0.15, roughness: 0.6 }),
    enclEdge: S({ color: '#a9aeb2', metalness: 0.2, roughness: 0.55 }),
    plate: S({ color: '#dcddd8', metalness: 0.05, roughness: 0.75, envMapIntensity: 0.4 }),
    patch: S({ color: '#8c9296', metalness: 0.05, roughness: 0.85, envMapIntensity: 0.3 }),   // backing board (painted)
    rail: S({ color: '#b7bec3', metalness: 0.85, roughness: 0.32 }),
    duct: S({ color: '#848a8f', metalness: 0.0, roughness: 0.8 }),
    ductCover: S({ color: '#9299a0', metalness: 0.0, roughness: 0.6 }),
    ductEdge: S({ color: '#5f666c', metalness: 0.0, roughness: 0.7 }),
    tx: S({ color: '#c6cbce', metalness: 0.02, roughness: 0.7 }),       // light-grey plastic (APOGEE Compact / Modular covers)
    txTermD: S({ color: '#434c55', metalness: 0.03, roughness: 0.62 }),  // TX-I/O terminal tiers on the dark PXC7 housing
    txWinD: S({ color: '#262c32', metalness: 0.0, roughness: 0.4 }),
    // real-panel look (docs/graphic-references/field-panel-real-2/4)
    perf: S({ color: '#b9bec2', metalness: 0.3, roughness: 0.55, map: perfTexture() }),
    plateEdge: S({ color: '#aab0b4', metalness: 0.35, roughness: 0.55 }),
    txBase: S({ color: '#3a424b', metalness: 0.03, roughness: 0.62 }),       // TX-I/O terminal bases (dark grey)
    txCover: S({ color: '#7f8b97', metalness: 0.05, roughness: 0.3 }),       // TX-I/O module covers (grey)
    txsGrey: S({ color: '#4f5964', metalness: 0.05, roughness: 0.6 }),       // TXS1 bus supply: the PXC7 / TX-I/O dark grey (user, 2026-09-30)
    pbox: S({ color: '#d3d6d4', metalness: 0.15, roughness: 0.55 }),         // Siemens power supply box, light grey steel
    pboxEdge: S({ color: '#b7bbb9', metalness: 0.15, roughness: 0.55 }),
    yellow: S({ color: '#f1d11d', metalness: 0, roughness: 0.6 }),
    black: S({ color: '#1b1c1e', metalness: 0.05, roughness: 0.5 }),
    rcptSlot: S({ color: '#050505', metalness: 0, roughness: 0.9 }),
    tbGrey: S({ color: '#8d9398', metalness: 0.02, roughness: 0.6 }),
    pcb: S({ color: '#1f7a3e', metalness: 0.1, roughness: 0.5 }),
    pcbPlug: S({ color: '#2fae5a', metalness: 0.02, roughness: 0.55 }),
    marker: S({ color: '#f2f2ee', metalness: 0, roughness: 0.7 }),
    sideRail: S({ color: '#b7bec3', metalness: 0.85, roughness: 0.32 }),
    txTerm: S({ color: '#a4abb0', metalness: 0.02, roughness: 0.72 }),
    txWin: S({ color: '#6f777c', metalness: 0.0, roughness: 0.5 }),
    screw: S({ color: '#8c969d', metalness: 0.85, roughness: 0.3 }),
    pxc: S({ color: '#4f5964', metalness: 0.05, roughness: 0.6 }),
    pxcCover: S({ color: '#46505a', metalness: 0.05, roughness: 0.55 }),
    lgrey: S({ color: '#d4d7d8', metalness: 0.02, roughness: 0.7 }),
    plug: S({ color: '#26292b', metalness: 0.05, roughness: 0.6 }),
    plugGreen: S({ color: '#20a773', metalness: 0.05, roughness: 0.55 }),
    plugOrange: S({ color: '#e2801c', metalness: 0.05, roughness: 0.55 }),
    plugGrey: S({ color: '#a7acaf', metalness: 0.05, roughness: 0.6 }),
    rj45: S({ color: '#b9bec2', metalness: 0.8, roughness: 0.3 }),
    teal: S({ color: '#009999', metalness: 0.05, roughness: 0.5 }),
    svc: S({ color: '#56708a', metalness: 0.1, roughness: 0.5 }),
    lcd: S({ color: '#26312b', metalness: 0.0, roughness: 0.3 }),
    xfmr: S({ color: '#1e2124', metalness: 0.35, roughness: 0.55 }),
    core: S({ color: '#61676c', metalness: 0.7, roughness: 0.4 }),
    brass: S({ color: '#c49b4a', metalness: 0.85, roughness: 0.3 }),
    white: S({ color: '#eceae4', metalness: 0.0, roughness: 0.8 }),
    conduit: S({ color: '#a2abb0', metalness: 0.8, roughness: 0.33 }),
    chrome: S({ color: '#d2d6d9', metalness: 0.95, roughness: 0.18 }),
    gasket: S({ color: '#1f2225', metalness: 0.0, roughness: 0.9 }),
    pocket: S({ color: '#3b4247', metalness: 0.0, roughness: 0.4, transparent: true, opacity: 0.55 }),
    wRed: S({ color: '#b3261e', roughness: 0.55 }), wBlack: S({ color: '#1c1d1f', roughness: 0.55 }),
    wWhite: S({ color: '#e4e2da', roughness: 0.55 }), wBlue: S({ color: '#2757a8', roughness: 0.55 }),
    wGreen: S({ color: '#2f8a3e', roughness: 0.55 }), wLan: S({ color: '#3a7fd6', roughness: 0.5 }),
    wall: S({ color: '#4d5359', metalness: 0.0, roughness: 0.92, envMapIntensity: 0.3 }),   // painted block, charcoal
    mortar: S({ color: '#3f454b', metalness: 0.0, roughness: 0.95 }),
    floor: S({ color: '#2c3136', metalness: 0.05, roughness: 0.85 }),
  };
  return m.wall;
}

// ---- the views -----------------------------------------------------------------------

/**
 * @param {typeof import('./equip3d.js').Family3DView} Base
 */
export function wallViewClasses(Base) {
  class Wall3DView extends Base {
    constructor(opts) {
      super(opts);
      this.devicePoses = 'self';     // no Siemens duct devices on a wall unit
      this.hasLayoutOptions = false;
      this.wallHung = true;
      this.mountTop = mountOf(opts.kind, null);
      this.explodeTarget = 0;
    }

    /** The twin hands over the placement: its mounting height (floor → top). */
    setMount(pl) { this.mountTop = mountOf(this.kind, pl); }

    _prep() {
      this.inv = { hasRet: false, fans: [], oad: null, ead: null };
      this.parts.wall = {};
      const unit = this._newUnit();
      this.wm = wallMaterials(this.m);
      return unit;
    }

    /** Hang the built body: top at the mounting height; in the twin its front faces +x. */
    _hang(bodyGroup, W, H) {
      const unit = this.unit;
      unit.position.y = this.mountTop - H;
      if (this.embedded) {
        unit.rotation.y = Math.PI / 2;
        // the twin draws rooms as outlines: a small backing board on the wall line behind
        // the unit (75 mm proud all round), not a slab from the floor
        const patch = new THREE.Mesh(new THREE.BoxGeometry(W + 0.15, H + 0.15, 0.019), this.wm.patch);
        patch.position.set(0, H / 2, -0.0105);
        patch.userData.noFootprint = true;
        patch.receiveShadow = true;
        unit.add(patch);
      }
      const sec = { kind: this.kind, group: bodyGroup, w: W, baseX: 0, i: 0, x0: 0 };
      this.sections = [sec];
      this.total = W;
    }

    // no air, no plinth: a painted block wall and a floor on the unit page
    _buildBench() {
      const g = new THREE.Group();
      const m = this.wm;
      const wallH = 3.2, wallW = 4.2;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(wallW, wallH, 0.2), m.wall);
      wall.position.set(0, wallH / 2, -0.1);
      wall.receiveShadow = true;
      g.add(wall);
      // block coursing: 8 × 16 in, running bond
      const B = new Batch();
      for (let y = 0.2032; y < wallH; y += 0.2032) B.box('mortar', wallW, 0.008, 0.004, 0, y, 0.001);
      for (let r = 0, y = 0; y < wallH; r++, y += 0.2032) for (let x = -wallW / 2 + (r % 2 ? 0.2032 : 0); x < wallW / 2; x += 0.4064) B.box('mortar', 0.008, 0.2032, 0.004, x, y + 0.1016, 0.001);
      B.flush(g, m);
      const floor = new THREE.Mesh(new THREE.BoxGeometry(wallW, 0.06, 3.2), m.floor);
      floor.position.set(0, -0.03, 1.5);
      floor.receiveShadow = true;
      g.add(floor);
      this.scene.add(g);
      this.bench = g;
    }
    // a mech-room light: soft sky fill, one key from the front-left, a cool rim; no warm AHU glow
    _lights() {
      const s = this.scene;
      this.hemi = new THREE.HemisphereLight('#dfe8f0', '#2a2622', 0.45);
      s.add(this.hemi);
      const key = new THREE.DirectionalLight('#fff6ec', 1.05);
      key.position.set(-2.2, 4.5, 6);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.bias = -0.0004;
      s.add(key);
      this.key = key;
      this.rim = new THREE.DirectionalLight('#a9dcff', 0.35);
      this.rim.position.set(4, 3, 2);
      s.add(this.rim);
    }
    _applyTier() {
      super._applyTier();
      // only LEDs and lit screens glow: a light grey housing never blooms
      if (this.bloom) { this.bloom.strength = 0.22; this.bloom.threshold = 1.45; this.bloom.radius = 0.2; }
    }
    _frameFx() { if (this.renderer) this.renderer.toneMappingExposure = 0.8; }
    _buildAir() { super._buildAir(); this.air.points.visible = false; }
    _updateAir() { if (this.air) this.air.points.visible = false; }
    _refreshAir() { this.vals = {}; this.tempStations = []; }
    _flowTarget() { return 0; }
    _fitShadow() {
      const c = this.key.shadow.camera;
      c.left = -3; c.right = 3; c.top = 4; c.bottom = -2;
      c.updateProjectionMatrix();
    }
    _kpiDefs() { return []; }
    _modeDefs() { return []; }

    /** Live reading of a suffix, or null (not live: unbound, waiting, stale, no response). */
    _live(sfx) {
      const p = this.resolve?.(sfx);
      if (!p || p.value == null) return null;
      const v = typeof p.value === 'boolean' ? (p.value ? 1 : 0) : Number(p.value);
      return fin(v) ? v : null;
    }

    _hud() {
      super._hud();
      const hud = this.hudEl;
      hud.querySelector('.a3-legend')?.remove();
      hud.querySelector('[data-tg="air"]')?.remove();
      hud.querySelector('[data-ex]')?.parentElement?.remove();
      const grp = document.createElement('div');
      grp.className = 'a3-grp';
      grp.innerHTML = '<span class="a3-gl">Door</span><button data-door="0" class="on">Closed</button><button data-door="1">Open</button>';
      if (this.kind === 'panel') hud.querySelector('.a3-panel')?.insertBefore(grp, hud.querySelector('.a3-panel').children[1] || null);
      grp.querySelectorAll('[data-door]').forEach((b) => b.addEventListener('click', () => this.setDoor(b.dataset.door === '1')));
      this.doorBtns = grp;
      const k = hud.querySelector('.a3-kpis');
      const d = document.createElement('div');
      d.className = 'a3-kpi a3-notlive';
      d.innerHTML = '<span class="a3-kk"></span><span class="a3-kv">--</span>';
      k?.appendChild(d);
      this.liveKpi = d;
      hud.querySelector('.a3-hint').textContent = this.kind === 'panel'
        ? 'Click the door to open it · click the controller or a module for its points · drag to orbit'
        : 'Click the drive for its points · drag to orbit · scroll to zoom';
      this._hudValues();
    }

    _wirePicking(canvas) {
      super._wirePicking(canvas);
      // a part with an action (the door) acts on click instead of listing points
      const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
      let dx = 0, dy = 0;
      const hit = (e) => {
        const r = canvas.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, this.camera);
        for (const h of ray.intersectObject(this.unit, true)) for (let o = h.object; o; o = o.parent) if (o.userData.pick) return o.userData.pick;
        return null;
      };
      canvas.addEventListener('pointerdown', (e) => { dx = e.clientX; dy = e.clientY; });
      canvas.addEventListener('pointerup', (e) => {
        if (Math.hypot(e.clientX - dx, e.clientY - dy) > 5 || e.button !== 0) return;
        const p = hit(e);
        if (p?.action) p.action();
      });
      canvas.addEventListener('pointermove', (e) => {
        if (e.buttons) return;
        const p = hit(e);
        if (p?.action && this.hoverEl) { this.hoverEl.hidden = false; this.hoverEl.textContent = p.hover || p.title; }
      });
    }

    setDoor(open) {
      const w = this.parts.wall;
      if (!w.door) return;
      w.door.open = !!open;
      this.doorBtns?.querySelectorAll('[data-door]').forEach((b) => b.classList.toggle('on', (b.dataset.door === '1') === !!open));
    }
    toggleDoor() { this.setDoor(!this.parts.wall?.door?.open); }
    get doorOpen() { return !!this.parts.wall?.door?.open; }

    _frameParts(dt, now) {
      const d = this.parts.wall?.door;
      if (d) {
        d.a = damp(d.a, d.open ? 1 : 0, 3.2, dt);
        if (Math.abs(d.a - (d.open ? 1 : 0)) < 1e-4) d.a = d.open ? 1 : 0;
        d.g.rotation.y = -d.a * DOOR_OPEN;
      }
    }

    _presetView(name, instant = false) {
      const H = this.bodyH, W = this.bodyW, D = this.bodyD;
      const y0 = this.mountTop - H;
      const c = new THREE.Vector3(0, y0 + H / 2, D / 2);
      const vf = THREE.MathUtils.degToRad(this.camera.fov);
      const fitD = (size, k = 1.2) => (size / 2) / Math.tan(vf / 2) * k + D;
      if (name === 'inside') {
        if (this.kind === 'panel') this.setDoor(true);
        return this._tween(name, c.clone().add(new THREE.Vector3(W * 0.02, 0, 0)), c.clone().add(new THREE.Vector3(W * 0.12, 0.02, fitD(Math.max(H * 1.05, (W * 1.08) / Math.max(0.6, this.camera.aspect)), 1.0))), instant);
      }
      if (name === 'side') return this._tween(name, c.clone().add(new THREE.Vector3(W * 0.3, H * 0.1, 0)), c.clone().add(new THREE.Vector3(fitD(H) * 0.8, H * 0.35, fitD(H) * 0.65)), instant);
      const dir = new THREE.Vector3(-0.5, 0.18, 1).normalize();
      const size = Math.max(H * 1.45, (W * 1.5) / Math.max(0.5, this.camera.aspect));
      return this._tween('overview', c.clone(), c.clone().addScaledVector(dir, fitD(size)), instant);
    }
  }

  // =====================================================================================
  // Field panel
  // =====================================================================================
  class Panel3DView extends Wall3DView {
    constructor(opts) {
      const L = panelLayout(opts.config);
      super({ ...opts, size: { h: L.H * MM, d: L.D * MM }, eyebrow: 'Field panel', legend: '', presets: [['overview', 'Overview'], ['inside', 'Inside'], ['column', 'I/O'], ['side', 'Power']] });
      this.lay = L;
      this.bodyW = L.W * MM; this.bodyH = L.H * MM; this.bodyD = L.D * MM;
      this.channels = panelChannels(opts.config);
    }

    _buildUnit() {
      const unit = this._prep();
      const L = this.lay, m = this.wm, full = !this.embedded;
      const W = L.W * MM, H = L.H * MM, D = L.D * MM, t = 0.0015;
      const X = (x) => (x - L.W / 2) * MM;            // layout mm (from the left wall) → metres
      const Y = (y) => (L.H - y) * MM;                // layout mm (down from the top) → metres
      const ZP = 0.016;                               // back plate front face (on standoffs)
      const DD = 0.09;                                // duct depth, 3.5 in
      const body = new THREE.Group();
      unit.add(body);
      const B = new Batch(), A = new Atlas(1024), leds = new Leds();
      const labels = [];
      const v3 = new THREE.Vector3();
      const xfP = (x, y, z) => (B.xf ? v3.set(x, y, z).applyMatrix4(B.xf).toArray() : [x, y, z]);
      const label = (text, opts, h, x, y, z, o = {}) => { const r = A.add(text, opts); const g = A.plane(r, h, x, y, z, o); if (B.xf) g.applyMatrix4(B.xf); labels.push(g); return r; };
      const led = (key, x, y, z, w, h, d, on) => { const [px, py, pz] = xfP(x, y, z); const rot = !!B.xf; leds.add(key, px, py, pz, rot ? h : w, rot ? w : h, d, on); };
      const picks = [];
      const chByOwner = new Map();
      for (const c of this.channels) { const k = c.owner; if (!chByOwner.has(k)) chByOwner.set(k, []); chByOwner.get(k).push(c); }
      const C = L.controller;
      const colOf = (i) => L.columns[i];
      // wires: a terminal, then out sideways to the duct beside its column (fan), marker sleeve near the terminal
      const fan = [];                                  // { p: [x,y,z], side: -1 | 1, col, r?, mark? }
      const fanAt = (x, y, z, side, colIdx, col, r, mark = true) => fan.push({ p: xfP(x, y, z), side, colIdx, col, r, mark });

      // ---- the enclosure: back, sides, flanged opening, knockouts ----
      B.box('encl', W, H, t, 0, H / 2, t / 2);
      B.box('encl', W, t, D, 0, H - t / 2, D / 2);
      B.box('encl', W, t, D, 0, t / 2, D / 2);
      B.box('encl', t, H, D, -W / 2 + t / 2, H / 2, D / 2);
      B.box('encl', t, H, D, W / 2 - t / 2, H / 2, D / 2);
      const lip = 0.016;
      for (const [w, h, x, y] of [[W, lip, 0, H - lip / 2], [W, lip, 0, lip / 2], [lip, H, -W / 2 + lip / 2, H / 2], [lip, H, W / 2 - lip / 2, H / 2]]) B.box('enclEdge', w, h, 0.002, x, y, D - 0.001);
      const ko = (x, y, z, r0 = 0.0142) => {
        for (const r of [r0, r0 * 1.24]) { const g = new THREE.TorusGeometry(r, 0.0007, 4, 28); g.rotateX(Math.PI / 2); g.translate(x, y, z); B.add('enclEdge', g); }
      };
      const used = new Set(L.conduits.map((c) => Math.round(c.x / 40)));
      for (let x = 60; x < L.W - 40; x += 80) { if (!used.has(Math.round(x / 40))) ko(X(x), H + 0.0004, D * 0.5); ko(X(x), -0.0004, D * 0.5); }

      // ---- perforated back plates (grey, 1/4 in holes) ----
      for (const pl of L.plates) {
        const w = pl.w * MM, h = pl.h * MM, cx = X(pl.x + pl.w / 2), cy = Y(pl.y + pl.h / 2);
        B.box('plateEdge', w, h, 0.0025, cx, cy, ZP - 0.0014);
        const g = new THREE.PlaneGeometry(w, h);
        const uv = g.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 0.0127, uv.getY(i) * h / 0.0127);
        g.translate(cx, cy, ZP + 0.0001);
        B.add('perf', g);
      }

      // ---- the duct frame: slotted grey duct, covers on (own batch: it casts shadows on the plate) ----
      const B0 = B;
      { const B = new Batch();
      for (const d of L.ducts) {
        const x0 = X(d.x), x1 = X(d.x + d.w), y0 = Y(d.y + d.h), y1 = Y(d.y);
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = x1 - x0, h = y1 - y0;
        B.box('duct', w, h, 0.002, cx, cy, ZP + 0.001);
        const along = d.dir === 'h' ? w : h, across = d.dir === 'h' ? h : w;
        for (const s of [-1, 1]) {
          if (full) {
            const pitch = 0.0125, fw = 0.0068;
            for (let a = -along / 2 + fw / 2 + 0.003; a <= along / 2 - fw / 2; a += pitch) {
              if (d.dir === 'h') B.box('duct', fw, 0.0024, DD - 0.006, cx + a, cy + s * (across / 2 - 0.0012), ZP + DD / 2);
              else B.box('duct', 0.0024, fw, DD - 0.006, cx + s * (across / 2 - 0.0012), cy + a, ZP + DD / 2);
            }
            if (d.dir === 'h') B.box('duct', w, 0.0024, 0.014, cx, cy + s * (across / 2 - 0.0012), ZP + 0.007);
            else B.box('duct', 0.0024, h, 0.014, cx + s * (across / 2 - 0.0012), cy, ZP + 0.007);
          } else if (d.dir === 'h') B.box('duct', w, 0.0024, DD, cx, cy + s * (across / 2 - 0.0012), ZP + DD / 2);
          else B.box('duct', 0.0024, h, DD, cx + s * (across / 2 - 0.0012), cy, ZP + DD / 2);
        }
        B.box('ductCover', w + 0.004, h + 0.004, 0.003, cx, cy, ZP + DD + 0.0015);     // snap-on cover
        for (const s of [-1, 1]) if (d.dir === 'h') B.box('ductEdge', w + 0.004, 0.0015, 0.0005, cx, cy + s * (h / 2 + 0.0012), ZP + DD + 0.0032);
        else B.box('ductEdge', 0.0015, h + 0.004, 0.0005, cx + s * (w / 2 + 0.0012), cy, ZP + DD + 0.0032);
        for (const s of [-1, 1]) if (d.dir === 'h') B.box('ductCover', w + 0.004, 0.003, 0.012, cx, cy + s * (h / 2 + 0.0015), ZP + DD - 0.004);
        else B.box('ductCover', 0.003, h + 0.004, 0.012, cx + s * (w / 2 + 0.0015), cy, ZP + DD - 0.004);
      }
      B.flush(body, m, { shadow: full, receive: true }); }
      void B0;

      // ---- one vertical DIN rail per column (slotted, zinc) ----
      for (const r of L.rails) {
        const x = X(r.x), y0 = Y(r.y1), y1 = Y(r.y0);
        B.box('rail', 0.035, y1 - y0, 0.0075, x, (y0 + y1) / 2, ZP + 0.00375);
        for (const s of [-1, 1]) B.box('rail', 0.005, y1 - y0, 0.002, x + s * 0.015, (y0 + y1) / 2, ZP + 0.0085);
        for (let y = y0 + 0.012; y < y1 - 0.01; y += 0.025) B.box('plug', 0.005, 0.012, 0.0005, x, y, ZP + 0.0078);
      }

      // ---- the column parts ----
      const WIRE = ['wWhite', 'wRed', 'wWhite', 'wBlack', 'wWhite', 'wRed', 'wGreen', 'wWhite'];
      for (const it of L.items.filter((i) => !i.power)) {
        const cx = X(it.x + it.w / 2), cy = Y(it.y + it.h / 2), w = it.w * MM, h = it.h * MM, d = it.d * MM;
        if (it.kind === 'controller') {
          // built in its own frame (native: long side across), then turned -90° onto the vertical rail:
          // its LED block ends up at the top, the LAN / KNX / 24 V plugs on the right, COM on the left (photo 2)
          B.xf = new THREE.Matrix4().makeTranslation(cx, cy, 0).multiply(new THREE.Matrix4().makeRotationZ(-Math.PI / 2));
          this._controller(B, { label, led, fanAt, colIdx: it.col, ZP, onb: chByOwner.get('controller') || [], C, full });
          B.xf = null;
          const pts = [...(chByOwner.get('controller') || []), ...this.channels.filter((c) => c.owner !== 'controller')].map((c) => c.sfx);
          picks.push(pickProxy(body, w, h, 0.01, cx, cy, ZP + d * 0.9, { title: `${C.model} · controller`, points: pts, hover: `${C.model} · click for its points` }));
          continue;
        }
        // TX-I/O on the vertical rail: terminal bases both sides (dark), the cover in the middle
        const T = MODULES[it.type], io = T.kind === 'io';
        const left = cx - w / 2, top = cy + h / 2;
        if (!io) {
          // bus supply / bus connection: the same dark grey as the PXC7 and the TX-I/O, SIEMENS, 24 V LED, vents
          B.box('txsGrey', w - 0.001, h - 0.0008, d * 0.78, cx, cy, ZP + d * 0.39);
          B.box('txsGrey', w * 0.56, h * 0.82, 0.012, cx, cy, ZP + d * 0.78 + 0.006);
          for (let k = 0; k < 4; k++) B.box('txWinD', 0.0012, h * 0.5, 0.0008, cx + w * 0.3 + k * 0.0028, cy, ZP + d * 0.78 + 0.0004);
          for (const s of [-1, 1]) {
            B.box('txBase', w * 0.16, h * 0.9, d * 0.62, cx + s * (w / 2 - w * 0.08), cy, ZP + d * 0.31);
            for (let k = 0; k < 3; k++) {
              const y = top - h * (0.25 + k * 0.25), x = cx + s * (w / 2 - w * 0.08);
              if (full) B.cyl('screw', 0.0017, 0.0012, 'z', x, y, ZP + d * 0.62 + 0.0006, 10);
            }
          }
          label('SIEMENS', { px: 22, weight: 800, color: '#e3e7ea' }, 0.005, cx - w * 0.02, cy - h * 0.05, ZP + d * 0.78 + 0.0125, { rotZ: Math.PI / 2 });
          label(it.type, { px: 18, weight: 700, color: '#c9d0d5' }, 0.004, cx - w * 0.2, top - 0.012, ZP + d * 0.78 + 0.0004);
          led(`bus:${it.index ?? 'auto' + it.col}`, cx + w * 0.18, top - 0.008, ZP + d * 0.78 + 0.0132, 0.003, 0.003, 0.0008, 'green');
          if (it.type === 'TXS1.12F4') B.box('plug', 0.012, 0.008, 0.012, cx + w * 0.3, top - 0.01, ZP + d * 0.9);
          // 24 V in on the right (from the power column, through the duct); bus on to the modules below
          for (const [k, col] of [[0, 'wRed'], [1, 'wBlue']]) fanAt(cx + w / 2 - w * 0.08, top - h * (0.25 + k * 0.25), ZP + d * 0.62 + 0.001, 1, it.col, col, 0.0011, false);
          picks.push(pickProxy(body, w, h, 0.01, cx, cy, ZP + d, { title: `${it.type}${it.auto ? ' (bus connection)' : ''}`, points: [], hover: `${it.type} · ${MODULES[it.type].label}` }));
          continue;
        }
        const tw = w * 0.13;                                          // one terminal tier's width
        B.box('txBase', w - 0.0006, h - 0.0006, d * 0.42, cx, cy, ZP + d * 0.21);
        for (const s of [-1, 1]) {
          B.box('txBase', tw, h - 0.001, d * 0.62, cx + s * (w / 2 - tw / 2), cy, ZP + d * 0.31);          // outer tier
          B.box('txBase', tw * 0.8, h - 0.001, d * 0.8, cx + s * (w / 2 - tw - tw * 0.4), cy, ZP + d * 0.4); // inner tier
        }
        const cw = w - 4 * tw + tw * 0.4;
        B.box('txCover', cw, h - 0.0016, d * 0.98, cx, cy, ZP + d * 0.49);                      // grey cover
        B.box('txWinD', cw + 0.001, 0.0008, d * 0.99, cx, top - 0.0004, ZP + d * 0.495);         // the seam to the module above
        const zc = ZP + d * 0.98;
        const n = Math.max(T.n, 8), pitch = (h - 0.004) / n;
        const chs = chByOwner.get(it.index) || [];
        for (let k = 0; k < n; k++) {
          const y = top - 0.002 - pitch * (k + 0.5);
          for (const s of [-1, 1]) {
            const xo = cx + s * (w / 2 - tw / 2), xi = cx + s * (w / 2 - tw - tw * 0.4);
            if (full) { B.cyl('screw', 0.0016, 0.0012, 'z', xo, y, ZP + d * 0.62 + 0.0006, 8); B.cyl('screw', 0.0016, 0.0012, 'z', xi, y, ZP + d * 0.8 + 0.0006, 8); }
            if (k < T.n) fanAt(xo, y, ZP + d * 0.62 + 0.0012, s, it.col, s < 0 ? WIRE[k % WIRE.length] : WIRE[(k + 3) % WIRE.length]);
          }
          // the channel LED column down the cover's left edge (dark unless its point is live)
          const c = chs[k];
          if (k < T.n) led(c ? `ch:${c.sfx}` : `nc:${it.index}:${k}`, cx - cw / 2 + 0.004, y, zc + 0.0012, 0.0026, 0.0022, 0.0008, 'green');
        }
        if (T.lcd) B.box('lcd', cw * 0.5, h * 0.62, 0.0012, cx + cw * 0.12, cy, zc + 0.0006);
        if (T.manual) for (let k = 0; k < T.n; k++) B.box('plug', 0.004, 0.0025, 0.003, cx + cw * 0.3, top - 0.002 - pitch * (k + 0.5), zc + 0.0015);
        led(`mod:${it.index}`, cx + cw / 2 - 0.004, top - 0.005, zc + 0.0012, 0.0025, 0.0025, 0.0008, 'green');
        label(it.type, { px: 18, weight: 700, color: '#e3e7ea' }, 0.0042, cx + cw * 0.16, cy - h * 0.1, zc + 0.0003, { rotZ: Math.PI / 2 });
        label(String(it.addr), { px: 22, weight: 800, color: '#1d2226', bg: '#f1f1ec', pad: 3, minW: 30 }, 0.005, cx + cw * 0.18, top - 0.006, zc + 0.0003);
        picks.push(pickProxy(body, w, h, 0.01, cx, cy, ZP + d, { title: `TX ${it.addr} · ${it.type}`, points: chs.map((c) => c.sfx), hover: `TX ${it.addr} · ${it.type} · click for its points` }));
      }
      // end stops under the last part of each column
      for (const c of L.columns) {
        const last = c.items[c.items.length - 1];
        if (last) B.box('plugGrey', 0.045, 0.008, 0.03, X(c.cx), Y(last.y + last.h) - 0.006, ZP + 0.015);
      }

      // ---- the power column: supply box, receptacle, 24 V terminal blocks, relays ----
      const sideT = {};
      for (const it of L.power.items) {
        const cx = X(it.x + it.w / 2), cy = Y(it.y + it.h / 2), w = it.w * MM, h = it.h * MM, d = it.d * MM;
        const top = cy + h / 2, bot = cy - h / 2, zf = ZP + d;
        if (it.kind === 'powerbox') {
          // light grey steel box: lid, hinge line, yellow warning label on the top, rocker, circuit label
          B.box('pbox', w, h, d, cx, cy, ZP + d / 2);
          B.box('pboxEdge', w + 0.002, 0.004, d + 0.002, cx, top - h * 0.3, ZP + d / 2);                   // lid seam
          B.box('yellow', w * 0.9, h * 0.2, 0.0008, cx, top - h * 0.12, zf + 0.0004);
          for (let k = 0; k < 7; k++) B.box('black', w * (0.8 - (k % 3) * 0.08), 0.0011, 0.0003, cx - w * 0.02, top - h * (0.045 + k * 0.022), zf + 0.0009);
          B.box('black', 0.0065, 0.0065, 0.0003, cx - w * 0.38, top - h * 0.05, zf + 0.001);
          for (const k of [-1, 1]) B.cyl('chrome', 0.0035, 0.003, 'z', cx + k * w * 0.12, top - h * 0.26, zf + 0.0015, 12);
          // the rocker switch: bezel + rocker, ON / OFF
          B.box('black', 0.03, 0.05, 0.008, cx - w * 0.12, top - h * 0.48, zf + 0.004);
          B.box('plug', 0.02, 0.022, 0.006, cx - w * 0.12, top - h * 0.46, zf + 0.009);
          label('ON', { px: 18, weight: 800, color: '#e8e8e8' }, 0.004, cx - w * 0.12, top - h * 0.43, zf + 0.0121);
          label('OFF', { px: 18, weight: 800, color: '#e8e8e8' }, 0.004, cx - w * 0.12, top - h * 0.53, zf + 0.0081);
          // the white circuit label (editable in Properties)
          B.box('white', w * 0.8, h * 0.11, 0.0008, cx, top - h * 0.695, zf + 0.0004);
          it.circuit.forEach((line, k) => label(line, { px: 26, weight: 800, color: '#1d2226' }, 0.0085, cx, top - h * (0.675 + k * 0.04), zf + 0.0009));
          label('SIEMENS', { px: 20, weight: 800, color: '#6c7479' }, 0.005, cx + w / 2 + 0.0004, cy, ZP + d * 0.5, { rotY: Math.PI / 2, rotZ: Math.PI / 2 });
          // ventilation louvres across the bottom of the front (two rows of slanted slots, as in the photo)
          for (let r = 0; r < 2; r++) for (let k = 0; k < 7; k++) {
            const g = new THREE.BoxGeometry(0.0045, 0.02, 0.0006).rotateZ(-0.55);
            B.add('black', g.translate(cx - w * 0.36 + k * w * 0.12, bot + h * (0.1 + r * 0.06), zf + 0.0004));
          }
          for (const s of [-1, 1]) B.cyl('chrome', 0.004, 0.004, 'z', cx + s * w * 0.4, bot + 0.012, zf + 0.002, 12);
          sideT.box = { x: cx, bot, z: ZP + d * 0.5 };
          picks.push(pickProxy(body, w, h, d, cx, cy, ZP + d / 2, { title: `${it.label} · ${it.va} VA 24 V`, points: [], hover: `Siemens power supply · ${it.circuit.join(' ')}` }));
        } else if (it.kind === 'rcpt') {
          B.box('pbox', w, h, d, cx, cy, ZP + d / 2);
          B.box('pboxEdge', w * 0.66, h * 0.8, 0.003, cx + w * 0.08, cy, zf + 0.0015);                           // device plate
          for (const s of [1, -1]) {
            const y = cy + s * h * 0.2;
            B.box('black', w * 0.36, h * 0.28, 0.006, cx + w * 0.08, y, zf + 0.004);
            for (const dx of [-0.006, 0.006]) B.box('rcptSlot', 0.0018, 0.008, 0.001, cx + w * 0.08 + dx, y + 0.004, zf + 0.0072);
            B.cyl('rcptSlot', 0.0022, 0.001, 'z', cx + w * 0.08, y - 0.007, zf + 0.0072, 10);
          }
          for (const s of [-1, 1]) B.cyl('chrome', 0.0025, 0.003, 'z', cx + w * 0.08, cy + s * h * 0.42, zf + 0.004, 10);
          sideT.rcpt = { x: cx - w / 2, y: cy, z: ZP + d * 0.5 };
        } else if (it.kind === 'tb') {
          // grey terminal blocks stacked on a short vertical rail
          B.box('rail', 0.035, h + 0.02, 0.0075, cx, cy, ZP + 0.00375);
          const nb = Math.floor(h / 0.0062);
          for (let k = 0; k < nb; k++) {
            const y = top - 0.0031 - k * 0.0062;
            B.box(k % 4 === 3 ? 'wBlue' : 'tbGrey', w, 0.0056, d * 0.8, cx, y, ZP + d * 0.4);
            if (full) for (const s of [-1, 1]) B.cyl('screw', 0.0017, 0.0015, 'z', cx + s * w * 0.3, y, ZP + d * 0.8 + 0.0008, 8);
          }
          label('24 V', { px: 20, weight: 800, color: '#2a2f33', bg: '#f3f1e8', pad: 3 }, 0.0055, cx, top + 0.008, ZP + d * 0.8);
          sideT.tb = { x0: cx - w / 2, x1: cx + w / 2, top, bot, z: ZP + d * 0.8 + 0.001 };
        } else if (it.kind === 'relay') {
          // RIBMN-style relay: green PCB on standoffs, relay cube, green plugs top and bottom, white label
          B.box('pcb', w, h, 0.0018, cx, cy, ZP + 0.009);
          for (const s of [-1, 1]) for (const r of [-1, 1]) B.cyl('chrome', 0.002, 0.008, 'z', cx + s * w * 0.44, cy + r * h * 0.4, ZP + 0.004, 8);
          B.box('black', w * 0.26, h * 0.34, 0.016, cx + w * 0.2, cy, ZP + 0.018);
          for (const s of [-1, 1]) for (let k = 0; k < 4; k++) B.box('pcbPlug', w * 0.14, h * 0.2, 0.012, cx - w * 0.36 + k * w * 0.24, cy + s * (h / 2 - h * 0.12), ZP + 0.016);
          B.box('white', w * 0.3, h * 0.16, 0.0008, cx - w * 0.18, cy, ZP + 0.0104);
          label('RIBMN', { px: 20, weight: 800, color: '#1d2226' }, 0.0045, cx - w * 0.18, cy, ZP + 0.0110);
          picks.push(pickProxy(body, w, h, 0.03, cx, cy, ZP + 0.015, { title: `${it.label}`, points: [], hover: 'Relay (RIBMN style ≈) · no point of its own here' }));
        }
      }

      // ---- the clean wire job ----
      const seg = full ? 6 : 4, wr = 0.0009;
      // module / controller conductors: out sideways into the duct beside the column, a white marker sleeve on each
      for (const f of fan) {
        const c = colOf(f.colIdx);
        if (!c) continue;
        const edge = f.side < 0 ? X(c.x0) + 0.004 : X(c.x1) - 0.004;
        const [x, y, z] = f.p;
        const r = f.r || wr;
        const k = Math.abs(x - edge);
        const p1 = [x + f.side * Math.min(0.012, k * 0.2), y, z + 0.002];
        const p2 = [edge - f.side * 0.012, y - 0.004 * Math.min(1, k / 0.05), ZP + DD * 0.6];
        const p3 = [edge + f.side * 0.01, p2[1], ZP + DD * 0.55];
        B.tube(f.col, [x, y, z], p1, r, seg); B.tube(f.col, p1, p2, r, seg); B.tube(f.col, p2, p3, r, seg);
        if (f.mark && full) { const mx = x + f.side * Math.min(0.03, k * 0.45); B.cyl('marker', r * 2.6, 0.009, 'x', mx, y + (p2[1] - y) * (Math.abs(mx - x) / Math.max(1e-4, Math.abs(p2[0] - x))), z + 0.002 + (p2[2] - z) * 0.3, 8); }
      }
      // power: supply box → 24 V terminals (red / blue) → into the main frame's right-hand duct (to the TXS1.12F4 and
      // the controller through the duct); box → receptacle (black / white); 120 V feed from the top conduit into the box
      if (sideT.box && sideT.tb) {
        const path = (col, pts, r = 0.0012) => { for (let i = 1; i < pts.length; i++) B.tube(col, pts[i - 1], pts[i], r, seg); return pts; };
        const b = sideT.box, tb = sideT.tb, rduct = L.ducts.filter((d) => d.dir === 'v').slice(-1)[0];
        const xr = rduct ? X(rduct.x + rduct.w) - 0.006 : tb.x0 - 0.05;
        this.parts.wall.run24 = [];
        ;[['wRed', 0], ['wBlue', 1]].forEach(([col, k]) => {
          const x = b.x - 0.02 + k * 0.012;
          path(col, [[x, b.bot, b.z], [x, b.bot - 0.01, b.z], [tb.x0 - 0.008 - k * 0.004, tb.top - 0.004 - k * 0.0062, tb.z + 0.004], [tb.x0 + 0.004, tb.top - 0.004 - k * 0.0062, tb.z]]);
          const y = tb.bot + 0.02 + k * 0.0062;
          this.parts.wall.run24.push(path(col, [[tb.x0 + 0.004, y, tb.z], [tb.x0 - 0.012, y, tb.z + 0.004], [xr, y - 0.004, ZP + DD * 0.55]]));
        });
        if (sideT.rcpt) for (const [col, k] of [['wBlack', 0], ['wWhite', 1]]) path(col, [[b.x + 0.02 + k * 0.01, b.bot, b.z], [sideT.rcpt.x + 0.004, sideT.rcpt.y + 0.02 - k * 0.01, sideT.rcpt.z]]);
      }

      // ---- conduits into the top: connector + locknut, EMT up to ~10 ft ----
      const outer = new THREE.Group();
      outer.userData.noFootprint = true;
      body.add(outer);
      const OB = new Batch();
      const topY = Math.max(H + 0.3, 3.0 - this.mountTop + H);
      for (const c of L.conduits) {
        const x = X(c.x), r = c.power ? 0.0117 : 0.0147, z = D * 0.5;
        OB.cyl('chrome', r + 0.005, 0.012, 'y', x, H + 0.006, z, 18);
        OB.cyl('chrome', r + 0.006, 0.004, 'y', x, H - t - 0.003, z, 18);
        OB.cyl('conduit', r, topY - H - 0.012, 'y', x, (topY + H + 0.012) / 2, z, 16);
        if (c.power && sideT.box) B.tube('wBlack', [x, H - t - 0.006, z], [x, Y(L.power.items[0].y) + 0.004, sideT.box.z], 0.0014, seg);
      }
      OB.flush(outer, m, { shadow: full });
      // ground stud
      B.cyl('brass', 0.004, 0.008, 'z', X(L.power.x1) - 0.02, 0.04, ZP + 0.004, 10);

      // ---- flush the static interior ----
      B.flush(body, m, { shadow: false });
      const tex = A.texture();
      this._labelTex = tex;
      const labMat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.3, roughness: 0.8, metalness: 0, color: '#c4c4c4' });
      if (labels.length) {
        const lg = mergeGeometries(labels.map((g) => g.index ? g.toNonIndexed() : g), false);
        labels.forEach((g) => g.dispose());
        const lm = new THREE.Mesh(lg, labMat);
        lm.userData.noFootprint = true;
        lm.name = 'labels';
        body.add(lm);
      }
      leds.build(body);
      this.parts.wall.leds = leds;
      this._door(body, W, H, D, full);
      this.parts.wall.picks = picks;
      // one detached readout row per channel: never drawn, but the unit page's honesty count and the
      // twin's status (offline when bound points exist and none reads live) see every point
      for (const c of this.channels) {
        const row = document.createElement('div');
        row.innerHTML = '<span></span><span></span>';
        this.tags.push({ el: row.lastChild, row, sfx: c.sfx, unit: '' });
        this._bind(c.sfx);
      }
      this._hang(body, W, H);
    }

    /** The controller in its own (native) frame, centred on 0,0: B.xf turns it onto the vertical rail. */
    _controller(B, { label, led, fanAt, colIdx, ZP, onb, C, full }) {
      const pxc = C.style === 'pxc';
      const w = C.w * MM, h = C.h * MM, d = C.d * MM, cx = 0, cy = 0;
      const top = h / 2, bot = -h / 2, left = -w / 2;
      const bodyK = pxc ? 'pxc' : 'lgrey', coverK = pxc ? 'pxcCover' : 'tx';
      B.box(bodyK, w, h * 0.6, d * 0.86, cx, cy, ZP + d * 0.43);
      B.box(bodyK, w - 0.004, h * 0.2, d * 0.55, cx, top - h * 0.1, ZP + d * 0.275);
      B.box(bodyK, w - 0.004, h * 0.2, d * 0.55, cx, bot + h * 0.1, ZP + d * 0.275);
      B.box(coverK, w * 0.32, h * 0.44, 0.006, left + w * 0.2, cy + h * 0.02, ZP + d * 0.86 + 0.003);
      B.box(coverK, w * 0.6, h * 0.44, 0.003, left + w * 0.68, cy + h * 0.02, ZP + d * 0.86 + 0.0015);
      for (const fx of [-0.4, 0, 0.4]) for (const s of [-1, 1]) B.box('plug', 0.012, 0.008, 0.01, cx + fx * w, cy + s * (h / 2 + 0.003), ZP + 0.006);
      const zf = ZP + d * 0.86 + 0.0065;
      label('SIEMENS', { px: 44, weight: 800, color: '#ffffff', bg: '#009999', pad: 10 }, h * 0.13, left + w * 0.84, cy + h * 0.08, zf - 0.0028);
      label(C.key.replace('PXC-', 'PXC '), { px: 30, weight: 600, color: pxc ? '#d9dee2' : '#3a3f43' }, h * 0.07, left + w * 0.53, cy + h * 0.1, zf - 0.0028);
      label(C.model, { px: 18, weight: 600, color: pxc ? '#aab3ba' : '#5a6065' }, h * 0.045, left + w * 0.1, bot + h * 0.235, ZP + d * 0.86 + 0.0003);
      C.leds.forEach(([name], i) => {
        const ly = cy + h * 0.2 - i * h * 0.062;
        led(`ctl:${name}`, left + w * 0.07, ly, zf + 0.0006, 0.0034, 0.0026, 0.0012, 'green');
        label(name, { px: 18, weight: 700, color: pxc ? '#dfe3e6' : '#34383b' }, h * 0.04, left + w * 0.12, ly, zf + 0.0002);
      });
      if (pxc) {
        ;[...C.com, 'KNX'].forEach((name, i) => {
          const ly = cy + h * 0.2 - i * h * 0.062;
          led(`ctl:TX:${name}`, left + w * 0.235, ly, zf + 0.0006, 0.003, 0.0024, 0.0012, 'yellow');
          led(`ctl:RX:${name}`, left + w * 0.27, ly, zf + 0.0006, 0.003, 0.0024, 0.0012, 'yellow');
          label(name, { px: 18, weight: 700, color: '#dfe3e6' }, h * 0.036, left + w * 0.31, ly, zf + 0.0002);
        });
        B.box('svc', 0.012, 0.009, 0.004, left + w * 0.08, cy - h * 0.2, zf + 0.001);
      }
      // native top edge (turned to the right): LAN, KNX (green), 24 V (orange), D (grey); bottom edge (left): COM
      const yT = top - h * 0.1, zT = ZP + d * 0.55;
      const plugs = [];
      for (let k = 0; k < C.lan; k++) { B.box('rj45', 0.0165, 0.014, 0.022, left + w * (0.1 + k * 0.1), yT, zT + 0.004); B.box('plug', 0.012, 0.004, 0.001, left + w * (0.1 + k * 0.1), yT - 0.002, zT + 0.0152); }
      const plugRow = (key, n, x, y, up) => {
        const pw2 = n * 0.005 + 0.003;
        B.box(key, pw2, 0.012, 0.014, x, y, zT + 0.007);
        for (let k = 0; k < n; k++) if (full) B.cyl('screw', 0.0017, 0.002, 'z', x - pw2 / 2 + 0.003 + k * 0.005, y + (up ? 0.001 : -0.001), zT + 0.0145, 10);
        plugs.push({ x, y, n, up, w: pw2 });
      };
      if (pxc) {
        plugRow('plugGreen', 2, left + w * 0.38, yT, true);
        plugRow('plugOrange', 3, left + w * 0.52, yT, true);
        plugRow('plugGrey', 2, left + w * 0.65, yT, true);
        if (C.mbus) plugRow('plugGreen', 2, left + w * 0.3, bot + h * 0.1, false);
        C.com.forEach((name, k) => plugRow('plug', 3, left + w * (0.42 + k * 0.14), bot + h * 0.1, false));
      } else {
        plugRow('plugOrange', 3, left + w * 0.12, yT, true);
        C.com.forEach((name, k) => plugRow('plug', 3, left + w * (0.3 + k * 0.12), yT, true));
      }
      if (onb.length) {
        const perRow = Math.ceil(onb.length / 2);
        for (const [ri, up] of [[0, true], [1, false]]) {
          const y = up ? yT : bot + h * 0.1;
          const x0 = left + w * (pxc ? 0.72 : 0.5), span = w * (pxc ? 0.26 : 0.46);
          B.box(pxc ? 'plugGrey' : 'txTerm', span, 0.011, 0.012, x0 + span / 2, y, zT + 0.006);
          for (let k = 0; k < perRow; k++) {
            const x = x0 + (span / perRow) * (k + 0.5);
            if (full) B.cyl('screw', 0.0014, 0.002, 'z', x, y, zT + 0.0125, 8);
            fanAt(x, y + (up ? 0.006 : -0.006), zT + 0.0125, up ? 1 : -1, colIdx, (k + ri) % 2 ? 'wBlack' : 'wWhite');
          }
        }
      }
      // its wiring leaves sideways into the ducts: 24 V / KNX / LAN to the right, COM trunks to the left
      for (const p of plugs) for (let k = 0; k < p.n; k++) {
        const x = p.x - p.w / 2 + 0.003 + k * 0.005;
        const col = p.up ? (p.n === 3 ? ['wRed', 'wBlue', 'wGreen'][k] : 'wWhite') : ['wBlack', 'wWhite', 'wBlack'][k % 3];
        fanAt(x, p.y + (p.up ? 0.007 : -0.007), zT + 0.012, p.up ? 1 : -1, colIdx, col, 0.0009, false);
      }
      for (let k = 0; k < C.lan; k++) fanAt(left + w * (0.1 + k * 0.1), yT + 0.008, zT + 0.012, 1, colIdx, 'wLan', 0.0025, false);
    }

    /** The door: hinged on the left, key lock on the right, badge. */
    _door(body, W, H, D, full) {
      const m = this.wm;
      const door = new THREE.Group();
      door.position.set(-W / 2 - 0.001, 0, D + 0.001);
      body.add(door);
      const DB = new Batch(), DA = new Atlas(512), dl = [];
      const dt = 0.02;
      DB.box('encl', W + 0.002, H + 0.002, 0.0015, W / 2, H / 2, dt);
      for (const [w, h, x, y] of [[W + 0.002, 0.0015, W / 2, H + 0.0005], [W + 0.002, 0.0015, W / 2, -0.0005], [0.0015, H, 0.0005, H / 2], [0.0015, H, W + 0.0005, H / 2]]) DB.box('encl', w, h, dt, x, y, dt / 2);
      for (const [w, h, x, y] of [[W - 0.03, 0.01, W / 2, H - 0.02], [W - 0.03, 0.01, W / 2, 0.02], [0.01, H - 0.03, 0.02, H / 2], [0.01, H - 0.03, W - 0.02, H / 2]]) DB.box('gasket', w, h, 0.006, x, y, dt - 0.004);
      DB.box('pocket', W * 0.42, H * 0.22, 0.012, W * 0.6, H * 0.3, dt - 0.009);
      for (const k of [0.12, 0.5, 0.88]) DB.cyl('enclEdge', 0.0045, 0.06, 'y', -0.004, H * k, dt * 0.4, 12);
      for (const k of [0.5]) { DB.cyl('chrome', 0.011, 0.01, 'z', W - 0.045, H * k, dt + 0.005, 24); DB.box('gasket', 0.0022, 0.013, 0.001, W - 0.045, H * k, dt + 0.0105); }
      const badge = DA.add('SIEMENS', { px: 64, weight: 800, color: '#ffffff', bg: '#009999', pad: 14 });
      const bh = Math.min(0.05, H * 0.05);
      dl.push(DA.plane(badge, bh, 0.05 + bh * badge.aspect / 2, H - 0.06 - bh / 2, dt + 0.0012));
      const doorMeshes = DB.flush(door, m, { shadow: full });
      const dtex = DA.texture();
      this._doorTex = dtex;
      const dmesh = new THREE.Mesh(mergeGeometries(dl.map((g) => g.index ? g.toNonIndexed() : g), false), new THREE.MeshStandardMaterial({ map: dtex, alphaTest: 0.3, roughness: 0.7, color: '#bdbdbd' }));
      dl.forEach((g) => g.dispose());
      door.add(dmesh);
      door.userData.pick = { title: 'Door', points: [], action: () => this.toggleDoor(), hover: 'Door · click to open or close' };
      for (const o of Object.values(doorMeshes)) o.castShadow = full;
      this.parts.wall.door = { g: door, open: false, a: 0 };
    }

    /** I/O: the first module column, close. Power: the power column, close. */
    _presetView(name, instant = false) {
      if ((name !== 'side' && name !== 'column') || !this.camera) return super._presetView(name, instant);
      this.setDoor(true);
      const L = this.lay, D = this.bodyD, y0 = this.mountTop - this.bodyH;
      if (this.controls) this.controls.minDistance = 0.2;
      const X = (x) => (x - L.W / 2) * MM, Y = (y) => y0 + (L.H - y) * MM;
      if (name === 'side') {
        const tgt = new THREE.Vector3(X((L.power.x0 + L.power.x1) / 2), Y(L.H * 0.36), D * 0.4);
        return this._tween(name, tgt, tgt.clone().add(new THREE.Vector3(-0.16, 0.04, 0.72)), instant);
      }
      const c = L.columns[0], mods = c.items.filter((it) => it.kind === 'module');
      const yc = mods.length ? (mods[0].y + mods[mods.length - 1].y + mods[mods.length - 1].h) / 2 : L.H / 2;
      const tgt = new THREE.Vector3(X(c.cx), Y(yc), D * 0.4);
      return this._tween(name, tgt, tgt.clone().add(new THREE.Vector3(0.1, 0.05, 0.62)), instant);
    }

    _refreshExtra() {
      const w = this.parts.wall;
      if (!w?.leds) return;
      const live = new Map();
      for (const c of this.channels) { const v = this._live(c.sfx); if (v != null) live.set(c.sfx, v); }
      const any = live.size > 0;
      const tx = [...live.keys()].some((s) => s.startsWith('PNL.TX'));
      const modLive = new Set(this.channels.filter((c) => live.has(c.sfx) && c.owner !== 'controller').map((c) => c.owner));
      const chOf = new Map(this.channels.map((c) => [c.sfx, c]));
      w.leds.set((key) => {
        if (key === 'ctl:RUN') return any ? 'green' : 'off';
        if (key === 'ctl:TXM') return any && tx ? 'yellow' : 'off';
        if (key.startsWith('ctl:')) return 'off';                        // BAT, SVC, COM traffic: nothing proves them
        if (key.startsWith('bus:')) return tx ? 'green' : 'off';         // bus powered: a TX-I/O point reads live
        if (key.startsWith('mod:')) return modLive.has(Number(key.slice(4))) ? 'green' : 'off';
        if (key.startsWith('ch:')) {
          const sfx = key.slice(3), c = chOf.get(sfx);
          if (!live.has(sfx)) return 'off';
          if (c.ch === 'DI' || c.ch === 'DO') return live.get(sfx) > 0 ? 'green' : 'off';   // digital: live AND on
          return 'green';                                                // analog channel: live signal
        }
        return 'off';
      });
      w.anyLive = any;
      w.nLive = live.size;
    }

    _hudValues() {
      super._hudValues();
      const w = this.parts.wall;
      if (!this.liveKpi || !w) return;
      const n = this.channels.length;
      this.liveKpi.firstChild.textContent = `${this.lay.controller.model}`;
      this.liveKpi.lastChild.textContent = !n ? 'no points' : w.anyLive ? `${w.nLive}/${n} live` : 'no live data';
      this.liveKpi.classList.toggle('a3-notlive', !w.anyLive);
      if (this.honestyEl) { this.honestyEl.hidden = !!w.anyLive; this.honestyEl.textContent = w.anyLive ? '' : 'LEDs dark: no live point from this panel'; }
    }

    isRunning() { return !!this.parts.wall?.anyLive; }
    hasFault() { return false; }

    destroy() { this._labelTex?.dispose(); this._doorTex?.dispose(); super.destroy(); }
  }

  // =====================================================================================
  // VFD
  // =====================================================================================
  class Vfd3DView extends Wall3DView {
    constructor(opts) {
      const f = vfdFrame(opts.config), v = vfdOf(opts.config);
      super({ ...opts, size: { h: f.H * MM, d: f.D * MM }, eyebrow: `${VFD_MAKES[v.make].maker} ${VFD_MAKES[v.make].model} drive`, legend: '', presets: [['overview', 'Overview'], ['inside', 'Keypad'], ['side', 'Side']] });
      this.frame = f; this.vfd = v; this.make = VFD_MAKES[v.make];
      this.bodyW = f.W * MM; this.bodyH = f.H * MM; this.bodyD = f.D * MM;
    }

    _buildUnit() {
      const unit = this._prep();
      const m = this.wm, M = this.make, full = !this.embedded;
      const W = this.bodyW, H = this.bodyH, D = this.bodyD;
      const body = new THREE.Group();
      unit.add(body);
      const mats = {
        ...m,
        // calm, matte plastic: the warm light grey of the photos, not a white that blooms
        body: new THREE.MeshStandardMaterial({ color: M.body, metalness: 0.02, roughness: 0.7, envMapIntensity: 0.3 }),
        side: new THREE.MeshStandardMaterial({ color: M.side, metalness: 0.02, roughness: 0.72, envMapIntensity: 0.3 }),
        fins: new THREE.MeshStandardMaterial({ color: M.fins, metalness: 0.75, roughness: 0.35 }),
        bezel: new THREE.MeshStandardMaterial({ color: M.bezel, metalness: 0.0, roughness: 0.45, envMapIntensity: 0.15 }),
        clear: new THREE.MeshStandardMaterial({ color: '#dfe8ee', metalness: 0, roughness: 0.05, transparent: true, opacity: 0.06, depthWrite: false, envMapIntensity: 0.05 }),
      };
      this._vfdMats = mats;
      const B = new Batch(), A = new Atlas(512), leds = new Leds(), labels = [];
      const label = (text, o, h, x, y, z, extra) => { const r = A.add(text, o); labels.push(A.plane(r, h, x, y, z, extra)); return r; };
      const hv = this.vfd.make === 'hv600';
      // heatsink at the back, fins down the side, mounting flanges top and bottom
      const hsD = D * 0.42;
      B.box('fins', W * 0.96, H * 0.96, 0.01, 0, H / 2, 0.005);
      const nf = Math.max(6, Math.round((hsD - 0.01) / 0.007));
      for (const s of [-1, 1]) for (let k = 0; k < nf; k++) B.box('fins', 0.012, H * 0.92, 0.0022, s * (W / 2 + 0.004), H / 2, 0.012 + k * ((hsD - 0.014) / nf));
      for (const y of [-0.012, H + 0.012]) B.box('fins', W * 0.7, 0.024, 0.003, 0, y, 0.0015);
      for (const y of [-0.012, H + 0.012]) for (const s of [-1, 1]) B.cyl('gasket', 0.0035, 0.004, 'z', s * W * 0.25, y, 0.004, 12);
      // body shell (front part), front cover split into upper and lower
      B.box('side', W, H, D - hsD, 0, H / 2, hsD + (D - hsD) / 2);
      const zF = D + 0.001;
      if (hv) {
        B.box('body', W * 0.99, H * 0.995, 0.004, 0, H / 2, D - 0.001);
        B.box('body', W * 0.97, H * 0.03, 0.008, 0, H * 0.985, D - 0.003);        // rounded-top cap
        // keypad bezel (black, upper), clear hinged cover over it
        const kw = W * 0.7, kh = H * 0.42, ky = H * 0.62;          // the black keypad frame (photo)
        B.box('bezel', kw, kh, 0.01, W * 0.02, ky, zF + 0.005);
        B.box('clear', kw * 1.12, kh * 1.1, 0.02, W * 0.02, ky, zF + 0.012);
        for (const s of [1, -1]) B.box('side', 0.006, kh * 0.25, 0.012, W * 0.02 - s * kw * 0.58, ky + s * kh * 0.3, zF + 0.012);
        // LCD, buttons, the LED ring RUN / ALM / READY, the badge
        this._lcd = { w: kw * 0.62, h: kh * 0.26, x: W * 0.02, y: ky + kh * 0.28, z: zF + 0.0102 };
        const bx = W * 0.02, by = ky - kh * 0.04;
        for (const [dx, dy] of [[0, 0.045], [0, -0.045], [-0.045, 0], [0.045, 0], [0, 0]]) B.box('lgrey', 0.018 * kw / 0.1, 0.012 * kw / 0.1, 0.004, bx + dx * kw, by + dy * kh * 0.9, zF + 0.012);
        B.box('wGreen', kw * 0.16, kh * 0.06, 0.004, bx + kw * 0.3, by + kh * 0.08, zF + 0.012);
        B.box('wRed', kw * 0.16, kh * 0.07, 0.004, bx + kw * 0.3, by - kh * 0.1, zF + 0.012);
        B.box('wBlue', kw * 0.16, kh * 0.07, 0.004, bx - kw * 0.3, by - kh * 0.1, zF + 0.012);
        for (const k of [-1, 0, 1]) B.box('lgrey', kw * 0.14, kh * 0.04, 0.003, bx + k * kw * 0.26, by + kh * 0.12, zF + 0.012);
        const ry = ky - kh * 0.2;
        leds.add('RUN', bx - kw * 0.12, ry + kh * 0.03, zF + 0.0115, kw * 0.1, kh * 0.02, 0.002, 'green');
        leds.add('ALM', bx + kw * 0.12, ry + kh * 0.03, zF + 0.0115, kw * 0.1, kh * 0.02, 0.002, 'red');
        leds.add('READY', bx, ry - kh * 0.04, zF + 0.0115, kw * 0.18, kh * 0.02, 0.002, 'blue');
        label('RUN   ALM/ERR', { px: 18, weight: 700, color: '#d9dde0' }, kh * 0.035, bx, ry + kh * 0.075, zF + 0.0104);
        label('READY', { px: 18, weight: 700, color: '#d9dde0' }, kh * 0.03, bx, ry - kh * 0.085, zF + 0.0104);
        const bd = A.add('YASKAWA', { px: 40, weight: 900, color: '#ffffff', bg: '#1f4f9a', pad: 8 });
        labels.push(A.plane(bd, kh * 0.09, bx, ky - kh * 0.34, zF + 0.0104));
        const hvl = A.add('HV600', { px: 26, weight: 700, color: '#1d2226', bg: '#e9eaea', pad: 4 });
        labels.push(A.plane(hvl, kh * 0.06, bx, ky - kh * 0.435, zF + 0.0104));
        // nameplate, CHARGE lamp, the warning label, the cover screw
        B.box('white', W * 0.5, H * 0.03, 0.001, W * 0.02, ky - kh * 0.6, zF + 0.0005);
        label(`HV600 · ${this.vfd.hp} HP · ${this.vfd.volts} V`, { px: 18, weight: 700, color: '#2a2f33' }, H * 0.018, W * 0.02, ky - kh * 0.6, zF + 0.0011);
        B.box('lgrey', W * 0.1, W * 0.1, 0.003, -W * 0.3, H * 0.22, zF + 0.0015);
        B.box('lgrey', W * 0.55, H * 0.12, 0.001, W * 0.08, H * 0.1, zF + 0.0005);
        label('⚠ WARNING', { px: 20, weight: 800, color: '#2a2f33' }, H * 0.02, W * 0.0, H * 0.14, zF + 0.0011);
        label('Risk of electric shock', { px: 16, weight: 600, color: '#2a2f33' }, H * 0.014, W * 0.05, H * 0.11, zF + 0.0011);
        B.cyl('chrome', 0.005, 0.004, 'z', W * 0.06, H * 0.035, zF + 0.002, 14);
      } else {
        // ABB ACH580-01: louvred left front, control panel right, lower cover with the HVAC label
        B.box('body', W * 0.99, H * 0.995, 0.004, 0, H / 2, D - 0.001);
        const lx = -W * 0.2, lw = W * 0.4;
        const nL = Math.max(10, Math.round(H * 0.55 / 0.012));
        for (let k = 0; k < nL; k++) B.box('side', lw, 0.0045, 0.006, lx, H * 0.4 + k * (H * 0.55 / nL), zF + 0.002);
        B.box('gasket', lw * 1.02, H * 0.56, 0.002, lx, H * 0.67, zF + 0.0004);
        const px = W * 0.26, pw = W * 0.38, ph = H * 0.3, py = H * 0.72;
        B.box('lgrey', pw, ph, 0.012, px, py, zF + 0.006);
        this._lcd = { w: pw * 0.82, h: ph * 0.34, x: px, y: py + ph * 0.24, z: zF + 0.0122 };
        for (const [dx, dy] of [[0, 0.06], [0, -0.06], [-0.1, 0], [0.1, 0]]) B.box('white', pw * 0.12, ph * 0.06, 0.004, px + dx * pw * 2, py - ph * 0.12 + dy * ph * 1.2, zF + 0.013);
        B.box('wRed', pw * 0.16, ph * 0.08, 0.004, px - pw * 0.3, py - ph * 0.34, zF + 0.013);
        B.box('white', pw * 0.16, ph * 0.08, 0.004, px, py - ph * 0.34, zF + 0.013);
        B.box('white', pw * 0.16, ph * 0.08, 0.004, px + pw * 0.3, py - ph * 0.34, zF + 0.013);
        leds.add('RUN', px - pw * 0.38, py - ph * 0.02, zF + 0.0132, pw * 0.05, pw * 0.03, 0.002, 'green');
        leds.add('ALM', px - pw * 0.38, py - ph * 0.08, zF + 0.0132, pw * 0.05, pw * 0.03, 0.002, 'red');
        const abb = A.add('ABB', { px: 52, weight: 900, color: '#ff000f' });
        labels.push(A.plane(abb, H * 0.035, px - pw * 0.25, H * 0.93, zF + 0.0012));
        // lower cover: a step, the HVAC label, the hazard triangle
        B.box('body', W * 0.97, H * 0.3, 0.006, 0, H * 0.16, zF + 0.003);
        const hv2 = A.add('HVAC', { px: 30, weight: 700, color: '#ffffff', bg: '#2c6fb7', pad: 6 });
        labels.push(A.plane(hv2, H * 0.03, W * 0.3, H * 0.34, zF + 0.0012));
        const tri = A.add('⚠', { px: 44, weight: 900, color: '#111111', bg: '#f2cf1d', pad: 4 });
        labels.push(A.plane(tri, H * 0.04, W * 0.3, H * 0.08, zF + 0.0062));
        label(`ACH580-01 · ${this.frame.frame} · ${this.vfd.hp} HP`, { px: 18, weight: 700, color: '#3b4146' }, H * 0.016, -W * 0.1, H * 0.2, zF + 0.0062);
      }
      // conduit entries at the bottom: line, load, control
      const OB = new Batch();
      const outer = new THREE.Group();
      outer.userData.noFootprint = true;
      body.add(outer);
      const nC = 3;
      for (let k = 0; k < nC; k++) {
        const x = -W * 0.3 + (W * 0.6 / (nC - 1)) * k, r = k === 2 ? 0.0105 : Math.min(0.02, 0.009 + W * 0.02);
        OB.cyl('chrome', r + 0.004, 0.012, 'y', x, -0.006, D * 0.55, 16);
        OB.cyl('conduit', r, 0.36, 'y', x, -0.012 - 0.18, D * 0.55, 16);
      }
      OB.flush(outer, mats, { shadow: full });
      B.flush(body, mats, { shadow: full });
      // live LCD: a canvas the keypad draws, updated only when the text changes
      const lc = document.createElement('canvas');
      lc.width = 256; lc.height = 160;
      this._lcdCanvas = lc;
      this._lcdTex = new THREE.CanvasTexture(lc);
      this._lcdTex.colorSpace = THREE.SRGBColorSpace;
      const L = this._lcd;
      const lcdMesh = new THREE.Mesh(new THREE.PlaneGeometry(L.w, L.h), new THREE.MeshBasicMaterial({ map: this._lcdTex, color: '#ffffff' }));
      lcdMesh.position.set(L.x, L.y, L.z);
      lcdMesh.userData.noFootprint = true;
      body.add(lcdMesh);
      this._lcdMesh = lcdMesh;
      this._lcdKey = null;
      if (labels.length) {
        const lt = A.texture();
        this._labelTex = lt;
        const lm = new THREE.Mesh(mergeGeometries(labels.map((g) => g.index ? g.toNonIndexed() : g), false), new THREE.MeshStandardMaterial({ map: lt, alphaTest: 0.3, roughness: 0.7 }));
        labels.forEach((g) => g.dispose());
        lm.userData.noFootprint = true;
        body.add(lm);
      }
      leds.build(body);
      this.parts.wall.leds = leds;
      const pts = VFD_POINTS.map((p) => p.sfx).filter((s) => this.has(s));
      const title = `${M.maker} ${M.model} · ${this.vfd.hp} hp${this.vfd.drives?.name ? ` · drives ${this.vfd.drives.name}${this.vfd.drives.fan ? ' ' + this.vfd.drives.fan : ''}` : ''}`;
      pickProxy(body, W, H, D, 0, H / 2, D / 2, { title, points: pts, hover: `${title} · click for its points` }).userData.noFootprint = false;
      // readouts (unit page and twin): only real points, "--" until live
      this._tag(body, [W / 2 + 0.12, H * 0.8, D], [['VFD.HZ', 'OUTPUT', 'Hz'], ['VFD.STS', 'STATUS', 'onoff'], ['VFD.SPD', 'SPEED CMD', '%'], ['VFD.AMPS', 'CURRENT', 'A'], ['VFD.FLT', 'FAULT', 'alm']]);
      if (this.vfd.drives?.name) {
        const cap = this._label(`DRIVES ${String(this.vfd.drives.name).toUpperCase()}${this.vfd.drives.fan ? ' · ' + String(this.vfd.drives.fan).toUpperCase() : ''}`, 'a3-sec');
        cap.position.set(0, -0.08, D + 0.05);
        body.add(cap);
      }
      this._hang(body, W, H);
      this._drawLcd();
    }

    /** What the keypad can honestly say right now. */
    _presetView(name, instant = false) {
      if (name !== 'inside' || !this.camera) return super._presetView(name, instant);
      // the keypad, straight on
      const y = this.mountTop - this.bodyH * 0.34, D = this.bodyD;
      const vf = THREE.MathUtils.degToRad(this.camera.fov);
      const dist = (this.bodyH * 0.32) / Math.tan(vf / 2) + D;
      return this._tween(name, new THREE.Vector3(0, y, D), new THREE.Vector3(this.bodyW * 0.25, y + 0.03, dist), instant);
    }

    _state() {
      const hz = this._live('VFD.HZ'), sts = this._live('VFD.STS'), flt = this._live('VFD.FLT'), spd = this._live('VFD.SPD'), amps = this._live('VFD.AMPS');
      const any = [hz, sts, flt, spd, amps, this._live('VFD.KW'), this._live('VFD.SS')].some((v) => v != null);
      const fault = flt != null && flt > 0;
      const running = !fault && (sts != null ? sts > 0 : hz != null ? hz > 0.5 : false);
      return { hz, sts, flt, spd, amps, any, fault, running };
    }

    _drawLcd() {
      const s = this._state();
      const key = JSON.stringify([s.hz?.toFixed(1), s.sts, s.flt, s.amps?.toFixed(1), s.any]);
      if (key === this._lcdKey) return;
      this._lcdKey = key;
      const c = this._lcdCanvas, g = c?.getContext('2d');
      const hv = this.vfd.make === 'hv600';
      if (g) {
        const bg = !s.any ? '#141a1f' : hv ? '#b9dcf4' : '#dfe4e2';
        const fg = !s.any ? '#7b8791' : '#0f1a24';   // no backlight: dim grey dashes
        g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = fg; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
        g.font = '700 58px JetBrains Mono, monospace';
        g.fillText(s.hz != null ? s.hz.toFixed(1) : '--', 200, 92);
        g.font = '700 26px JetBrains Mono, monospace';
        g.fillText('Hz', 248, 92);
        g.textAlign = 'left';
        g.font = '700 22px JetBrains Mono, monospace';
        g.fillText(s.fault ? 'FAULT' : s.sts != null ? (s.sts > 0 ? 'RUN' : 'STOP') : '--', 12, 132);
        g.textAlign = 'right';
        g.fillText(s.amps != null ? `${s.amps.toFixed(1)} A` : '', 248, 132);
        g.textAlign = 'left';
        g.font = '600 18px JetBrains Mono, monospace';
        g.fillText(s.any ? 'LIVE' : 'NO LIVE DATA', 12, 28);
      }
      if (this._lcdTex) this._lcdTex.needsUpdate = true;
      if (this._lcdMesh) this._lcdMesh.material.color.set(s.any ? '#ffffff' : '#7a838a');
      this.parts.wall.lcdText = s.hz != null ? `${s.hz.toFixed(1)} Hz` : '-- Hz';
      this.parts.wall.lcdLit = s.any;
    }

    _refreshExtra() {
      const w = this.parts.wall;
      if (!w?.leds) return;
      const s = this._state();
      w.state = s;
      w.leds.set((k) => (k === 'RUN' ? (s.running ? 'green' : 'off') : k === 'ALM' ? (s.fault ? 'red' : 'off') : k === 'READY' ? (s.any && !s.fault ? 'blue' : 'off') : 'off'));
      this._drawLcd();
    }

    _hudValues() {
      super._hudValues();
      const s = this.parts.wall?.state;
      if (!this.liveKpi || !s) return;
      this.liveKpi.firstChild.textContent = 'Output';
      this.liveKpi.lastChild.textContent = s.hz != null ? `${s.hz.toFixed(1)} Hz` : s.any ? 'Hz not live' : 'no live data';
      this.liveKpi.classList.toggle('a3-notlive', s.hz == null);
    }

    isRunning() { return !!this.parts.wall?.state?.running; }
    hasFault() { return !!this.parts.wall?.state?.fault; }
    destroy() { this._lcdTex?.dispose(); this._labelTex?.dispose(); super.destroy(); }
  }

  return { Panel3DView, Vfd3DView };
}
