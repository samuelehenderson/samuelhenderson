/**
 * ahu3d.js — the 3D air handler (ported from the PPCL Simulator's Graphic tab).
 *
 * Builds the loaded unit out of real parts, in airflow order, from the same
 * inventory the 2D schematic uses (ahuInventory): outside-air and relief
 * dampers, the mixing box and its return drop, filters, each coil, a
 * humidifier, the supply fan array and the return fan section. Then it
 * drives every part off the PointDB:
 *
 *   dampers    blades rotate to the commanded %
 *   coils      glow red (heating) or blue (cooling) with valve %
 *   fans       spin with status, at the VFD speed
 *   filters    turn red on a filter alarm
 *   airflow    soft streams of air (airflow3d.js) move at fan speed and take
 *              the colour of the air temperature at each station
 *              (OAT → MAT → coil temps → SAT)
 *
 * Assembled / Exploded pulls the sections apart like a parts drawing.
 * Readouts float over the parts they belong to.
 *
 * UI only. It reads points; it never writes them (a click hands the part's
 * points to onPick, and the host page decides how to command them). Loaded on
 * demand so the 3D library stays out of the main bundle.
 *
 * In ClarityView the suffixes are virtual (see ../ahu3d-bridge.js). A point
 * that is not live (stale, offline, unbound, waiting) resolves with a null
 * value and its status: readouts say why instead of showing a number, and the
 * part it drives rests (fans stop, dampers and valves close) so nothing on the
 * drawing moves as if it were live.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ahuInventory, runSuffix, resolveSuffix, valueAt, returnFanCaption } from './inventory.js';
import './ahu3d.css';
import { AirFlow } from './airflow3d.js';
import { coilShader, Stratification, LinkPulses, dewPointF } from './ahu3d-fx.js';

// Quality tiers: what each costs, from most to least expensive.
const TIERS = {
  high: { air: 24000, pixel: 1.75, bloom: true, shadows: true, strat: 28, size: 0.06, bright: 1.0 },
  medium: { air: 9000, pixel: 1.25, bloom: true, shadows: false, strat: 14, size: 0.08, bright: 1.15 },
  low: { air: 2500, pixel: 1.0, bloom: false, shadows: false, strat: 0, size: 0.11, bright: 1.3 }
};
const TIER_ORDER = ['high', 'medium', 'low'];

// ---- dimensions: a full-size unit, in meters ----------------------------
// About an 8 ft x 8 ft cabinet, every section in one line in airflow order:
// return → return fans → economizer → mixing → filters → coils → fans → out.
const DH0 = 2.4;       // default cabinet height (a unit can set its own size)
const D0 = 2.4;        // default cabinet width (depth into the screen)
const GAP = 0.8;       // explode spacing between sections
const T = 0.05;        // frame rail thickness
const FT = 0.3048;     // one foot, for the bench ruler
const ABOVE = 1.8;     // how far above the roof outside/relief air is drawn

const pick = (has, cands) => cands.find((s) => has(s)) || null;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

// Air temperature → particle color. Cold is blue, neutral is near-white,
// hot is orange-red, so a trip through the unit reads at a glance.
const TEMP_STOPS = [
  [40, new THREE.Color('#2f7dff')],
  [55, new THREE.Color('#5cc8ff')],
  [68, new THREE.Color('#e6f3f7')],
  [80, new THREE.Color('#ffb25c')],
  [100, new THREE.Color('#ff4a2a')]
];
function tempColor(t, out) {
  if (!Number.isFinite(t)) return out.copy(TEMP_STOPS[2][1]);
  if (t <= TEMP_STOPS[0][0]) return out.copy(TEMP_STOPS[0][1]);
  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const [t1, c1] = TEMP_STOPS[i];
    const [t0, c0] = TEMP_STOPS[i - 1];
    if (t <= t1) return out.copy(c0).lerp(c1, (t - t0) / (t1 - t0));
  }
  return out.copy(TEMP_STOPS[TEMP_STOPS.length - 1][1]);
}

export class Ahu3DView {
  /**
   * Can this database be drawn as an air handler at all? Needs a fan or a coil.
   * @param {(suffix:string)=>boolean} has
   */
  static canRender(has) {
    const inv = ahuInventory(has);
    return !!(inv.cc || inv.ph || inv.rh || inv.oad || has('SAT') ||
      inv.fans.some((b) => runSuffix(has, b) !== `${b}.STS` || has(`${b}.STS`)));
  }

  /** WebGL present? (Old tablets, locked-down browsers.) */
  static webglOk() {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch { return false; }
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.title]         unit name for the HUD
   * @param {boolean} [opts.rhAfterFans]  draw the reheat coil downstream of the
   *   fans (draw-through AHU) rather than ahead of them (fan coil)
   */
  constructor({ title = '', rhAfterFans = true, kind = 'ahu', size = null, eyebrow = 'Air handling unit', legend = 'Air temp', presets = null, config = null } = {}) {
    this.title = title;
    this.rhAfterFans = rhAfterFans;
    this.kind = kind;                 // ahu | crac | vav | fcu | eru | hx | boiler (see equip3d.js)
    this.config = config;             // the unit config, for kind-specific labels
    this.DH = size?.h ?? DH0;         // cabinet height, metres
    this.D = size?.d ?? D0;           // cabinet depth, metres
    this.eyebrow = eyebrow;
    this.legend = legend;
    this.presets = presets || [['overview', 'Overview'], ['intake', 'Intake'], ['coils', 'Coils'], ['fans', 'Fans']];
    this.hasLayoutOptions = true;     // the Options ▾ opening/end choices (air handlers only)
    // where the openings go: outside air and relief in the roof or the back
    // wall, return air in the upstream end or the back wall
    // Where the openings go. OA and relief: roof / back / front / floor.
    // Return: end / roof / back / front / floor. swap: outside air comes in
    // the end and the return enters the mixing box through a face instead.
    // hand: which way the air runs when you stand at the service side (the
    // doors and the pipe connections, always the +z face). 'right' — the
    // default, and every unit saved before this — reads intake-left →
    // discharge-right. 'left' is the mirror-image unit: the same doors facing
    // you, supply on your left. It is a reflection, not a rotation: turning the
    // unit 180° would take the doors round the back with it.
    this.layout = { oa: 'roof', relief: 'roof', ret: 'end', swap: false, hand: 'right' };
    this.dirty = true;
    this.explode = 0;           // animated 0..1
    this.explodeTarget = 0;
    this.showLabels = true;
    this.showAir = true;
    this.parts = this._emptyParts();
    this.tags = [];             // { el, suffix, fmt }
    this.sections = [];
    this._raf = 0;
    this._last = 0;
    this._lastValues = 0;
    this._camTween = null;
    // the mixing box's stratification volume is an estimate: off until asked for (Options → Effects);
    // the air streams already show the two air streams meeting and blending
    this.fx = { thermal: false, loops: true };
    this.casing = 'clear';      // casing finish: 'clear' (default) | 'grey' — per browser, cv_ahu_casing
    this.playback = null;       // trend playback state, when active
    this.anchors = new Map();   // point suffix -> Object3D it is drawn on
    this.links = [];            // control links from the program
    this._frames = { n: 0, ms: 0, since: 0, slow: 0 };
  }

  _emptyParts() { return { dampers: [], coils: [], fans: [], filters: [], hums: [], wheels: [], pumps: [], burners: [], cvalves: [] }; }

  /**
   * Build the scene into `stage`.
   * @param {HTMLElement} stage
   * @param {string} prefix  e.g. "GVL.B1.AHU7."
   * @param {(suffix:string)=>boolean} has
   * @param {(suffix:string)=>object|null} resolve  point lookup by suffix
   * @returns {string[]} the full point names the view is bound to
   */
  mount(stage, prefix, has, resolve) {
    this.prefix = prefix;
    this.has = has;
    this.layout = { ...this.layout, ...this._loadLayout(), ...(this.config?.layout3d || {}) };
    const FACES = ['roof', 'back', 'front', 'floor'];
    if (!FACES.includes(this.layout.oa)) this.layout.oa = 'roof';
    if (!FACES.includes(this.layout.relief)) this.layout.relief = 'roof';
    if (!['end', ...FACES].includes(this.layout.ret)) this.layout.ret = 'end';
    this.layout.swap = !!this.layout.swap;
    this._resolveLive = resolve;
    // during trend playback, points come from the trend at the playback time
    this.resolve = (sfx) => (this.playback ? this._pbPoint(sfx) : this._resolveLive(sfx));
    this.quality = this._loadPref('quality', 'auto');
    this.casing = this._loadCasing();
    this.tier = this.quality === 'auto' ? this._guessTier() : this.quality;
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.bound = new Set();

    stage.innerHTML = '';
    const host = document.createElement('div');
    host.className = 'a3-host';
    stage.appendChild(host);
    this.host = host;

    // ---- renderer, label layer, camera ----
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TIERS[this.tier].pixel));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);
    this.renderer = renderer;

    const labels = new CSS2DRenderer();
    labels.domElement.className = 'a3-labels';
    host.appendChild(labels.domElement);
    this.labels = labels;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b1116');
    scene.fog = new THREE.Fog('#0b1116', 30, 95);
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = this.envTex;
    pmrem.dispose();
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 220);
    this.camera = camera;

    this._lights();
    this._materials();
    this._buildUnit();
    this._afterBuild?.();
    this._fitShadow();
    this._buildBench();
    this._buildAir();
    this.links3d = new LinkPulses();
    scene.add(this.links3d.group);

    // ---- controls ----
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = Math.min(2.5, Math.max(0.6, this.DH * 0.9));
    controls.maxDistance = 80;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.autoRotateSpeed = 0.5;
    controls.addEventListener('start', () => { this._camTween = null; this.userMoved = true; });
    this.controls = controls;
    this._presetView('overview', true);
    this._wirePicking(renderer.domElement);

    // ---- post: a restrained bloom so only the lit parts glow ----
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // only what glows blooms (coil glow, status bands): a lit light-grey part never does
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.5, 1.45);
    composer.addPass(this.bloom);
    this._applyTier();
    composer.addPass(new OutputPass());
    this.composer = composer;

    this._hud();
    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(host);

    this._refreshValues();
    this._last = performance.now();
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      this._frame(now);
    };
    this._raf = requestAnimationFrame(loop);
    return [...this.bound];
  }

  /**
   * Click a part to command it. A press that turns into an orbit drag is not a
   * click, so picking waits for the release and checks how far it moved.
   */
  _wirePicking(canvas) {
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downX = 0, downY = 0, lastHover = 0;
    const hit = (e) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      for (const h of ray.intersectObject(this.unit, true)) {
        for (let o = h.object; o; o = o.parent) if (o.userData.pick) return o.userData.pick;
      }
      return null;
    };
    canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
    canvas.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5 || e.button !== 0) return;
      const p = hit(e);
      if (p && p.points.length) this.onPick?.(p.title, p.points, e.clientX, e.clientY, p);
      else this.onPickNone?.();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.buttons || performance.now() - lastHover < 70) return;
      lastHover = performance.now();
      const p = hit(e);
      canvas.style.cursor = p ? 'pointer' : '';
      this.hoverPts = p ? p.points : null;
      if (this.hoverEl) {
        this.hoverEl.hidden = !p;
        if (p) this.hoverEl.textContent = `${p.title} · click to command`;
      }
    });
    canvas.addEventListener('pointerleave', () => { if (this.hoverEl) this.hoverEl.hidden = true; });
  }

  /** Point values changed — pick them up on the next frame (throttled). */
  update() { this.dirty = true; }

  destroy() {
    window.cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    this.controls?.dispose();
    this._disposeDevices?.();
    this.scene?.traverse((o) => {
      o.geometry?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose?.();
    });
    this.envTex?.dispose();
    this.air?.dispose();
    this.strat?.dispose();
    this.links3d?.dispose();
    this.composer?.dispose?.();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
    this.host?.remove();
    this.scene = null;
  }

  // ------------------------------------------------------------------------
  // Scene pieces
  // ------------------------------------------------------------------------

  _lights() {
    const s = this.scene;
    this.hemi = new THREE.HemisphereLight('#bcd6ff', '#1a1410', 0.35);
    s.add(this.hemi);
    const key = new THREE.DirectionalLight('#ffffff', 1.4);
    key.position.set(-6, 12, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    s.add(key);
    this.key = key;
    const rim = new THREE.DirectionalLight('#57d6ff', 0.9);
    this.rim = rim;
    rim.position.set(8, 5, -9);
    s.add(rim);
    const warm = new THREE.PointLight('#ffae5c', 14, 24, 2);
    warm.position.set(-5, 1.6, 4.5);
    s.add(warm);
  }

  /** Shadow box sized to the unit, however long it came out. */
  _fitShadow() {
    const c = this.key.shadow.camera;
    const half = this.total / 2 + (this.sections.length * GAP) / 2 + 3;
    c.left = -half; c.right = half; c.top = this.DH + 6; c.bottom = -6;
    c.updateProjectionMatrix();
  }

  _materials() {
    this.m = {
      rail: new THREE.MeshStandardMaterial({ color: '#2b333b', metalness: 0.75, roughness: 0.38 }),
      // casing: painted double-wall panels, a calm light grey; the interior face reads a shade darker in shadow
      // fan inlet plates and other sheet parts: a matte mid grey, never a white slab
      panel: new THREE.MeshStandardMaterial({ color: '#626b71', metalness: 0.2, roughness: 0.7, side: THREE.DoubleSide, envMapIntensity: 0.25 }),
      // the inside face of the casing: a darker galvanised liner, so the air reads against it
      liner: new THREE.MeshStandardMaterial({ color: '#343c43', metalness: 0.15, roughness: 0.75, envMapIntensity: 0.25 }),
      floor: new THREE.MeshStandardMaterial({ color: '#2e363c', metalness: 0.2, roughness: 0.7, envMapIntensity: 0.3 }),
      base: new THREE.MeshStandardMaterial({ color: '#30383f', metalness: 0.6, roughness: 0.45 }),
      hardware: new THREE.MeshStandardMaterial({ color: '#1d2227', metalness: 0.7, roughness: 0.4 }),
      // the clear front: barely there, neutral, so the parts and the air read crisp through it
      glass: new THREE.MeshStandardMaterial({ color: '#dfe7eb', metalness: 0, roughness: 0.15, transparent: true, opacity: 0.025, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.05 }),
      // the crisp dark outline every casing wears (panel seams, doors, box edges)
      outline: new THREE.LineBasicMaterial({ color: '#07090b', transparent: true, opacity: 0.92 }),
      // casing finishes (Options → Casing): CLEAR = barely-there neutral glass on every side, no
      // reflections or haze, so the parts and the air read; GREY = smooth matte grey, both faces
      casingClear: new THREE.MeshStandardMaterial({ color: '#c9d3d9', metalness: 0, roughness: 0.3, transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0 }),
      casingGrey: new THREE.MeshStandardMaterial({ color: '#434a50', metalness: 0.05, roughness: 0.9, side: THREE.DoubleSide, envMapIntensity: 0.12 }),
      edge: new THREE.LineBasicMaterial({ color: '#56656f', transparent: true, opacity: 0.55 }),
      steel: new THREE.MeshStandardMaterial({ color: '#8f99a3', metalness: 0.85, roughness: 0.28 }),
      dark: new THREE.MeshStandardMaterial({ color: '#15191d', metalness: 0.6, roughness: 0.5 }),
      brass: new THREE.MeshStandardMaterial({ color: '#d08a33', metalness: 0.9, roughness: 0.3, emissive: '#2a1400', emissiveIntensity: 0.3 }),
      copper: new THREE.MeshStandardMaterial({ color: '#b8733a', metalness: 0.9, roughness: 0.32 }),
      media: new THREE.MeshStandardMaterial({ color: '#a9a291', metalness: 0, roughness: 0.95, envMapIntensity: 0.4, emissive: '#ff2a1a', emissiveIntensity: 0, side: THREE.DoubleSide }),
      blade: new THREE.MeshStandardMaterial({ color: '#a5afb8', metalness: 0.8, roughness: 0.3 })
    };
    this._materialsHook?.(this.m);
  }

  /** Every section's parts, in airflow order, from what the database has. */
  _plan() {
    const has = this.has;
    const inv = ahuInventory(has);
    const filters = [];
    for (const b of ['PFIL', 'FFIL', 'AFIL']) {
      if (has(`${b}.ALM`) || has(b)) filters.push({ alm: has(`${b}.ALM`) ? `${b}.ALM` : null, dp: has(b) ? b : null, cap: b[0] === 'P' ? 'PRE-FILTER' : b[0] === 'F' ? 'FINAL FILTER' : 'AFTER-FILTER' });
    }
    if (!filters.length && inv.hasFilter) filters.push({ alm: inv.fAlm, dp: inv.fDp, cap: 'FILTER' });
    const hum = has('HUM.SS') || has('HUH') || has('HUM')
      ? { cmd: pick(has, ['HUM.SS', 'HUM']), out: pick(has, ['HUH', 'HUM.VLV', 'HUV']) } : null;
    return { inv, filters, hum };
  }

  _buildUnit() {
    const { inv, filters, hum } = this._plan();
    this.inv = inv;
    this.coilPorts = [];
    const unit = new THREE.Group();
    // A left-hand unit is this same model mirrored along its length. Doors and
    // pipe ports sit on +z and stay there; only the ends swap. Everything the
    // rest of the app reads back — coilPorts, outletLocal, openings — goes
    // through localToWorld on this group, so the anchors follow the mirror and
    // the duct router meets the unit where it really is. three.js flips the
    // winding order for a negative-determinant matrix, so lighting stays right,
    // and every readout is a DOM label projected from a world position, so no
    // lettering is reversed.
    unit.scale.x = this.handSign;
    this.scene.add(unit);
    this.unit = unit;

    const secs = [];
    const rf = inv.rfs.concat(inv.rlfs || [], inv.efs);
    const L = this.layout;
    this.swap = !!(L.swap && inv.hasRet && inv.oad);
    this.retFace = this.swap && L.ret === 'end' ? 'roof' : L.ret;
    if (inv.hasRet && !this.swap) {
      // Return air comes in the upstream end (or a face of the return
      // section); relief leaves the economizer and outside air enters the
      // mixing box through the faces chosen in Layout.
      secs.push({ kind: 'retin', w: 1.0, cap: 'RETURN', open: L.ret === 'end' ? [] : [L.ret] });
      if (rf.length) secs.push({ kind: 'retfans', w: rf.length > 4 ? 2.1 : 1.9, cap: returnFanCaption(inv), fans: rf });
      if (inv.ead || inv.rad) secs.push({ kind: 'econ', w: 1.5, cap: 'ECONOMIZER', open: inv.ead ? [L.relief] : [] });
      secs.push({ kind: 'mix', w: 1.5, cap: 'MIXING', open: inv.oad ? [L.oa] : [] });
    } else if (this.swap) {
      // Swapped: outside air in the end, return into the mixing box through a
      // face, with the return fans and relief in a return module on that side.
      secs.push({ kind: 'intake', w: 0.9, cap: this.kind === 'ef' ? 'FROM SPACE' : 'OUTSIDE AIR' });
      secs.push({ kind: 'mix', w: 1.5, cap: 'MIXING', open: [this.retFace] });
    } else {
      if (inv.oad) secs.push({ kind: 'intake', w: 0.9, cap: this.kind === 'ef' ? 'FROM SPACE' : 'OUTSIDE AIR' });
      if (inv.mat) secs.push({ kind: 'mix', w: 1.2, cap: 'MIXING' });
    }
    for (const f of filters) secs.push({ kind: 'filter', w: 0.7, cap: f.cap, f });
    const coilTemp = {
      ph: pick(this.has, ['PHT', 'PH.TMP', 'PHCT', 'HCT']),
      cc: pick(this.has, ['CCT', 'CC.TMP', 'CLG.TMP', 'CLT']),
      rh: pick(this.has, ['RHT', 'RH.TMP', 'DAT'])
    };
    if (inv.ph) secs.push({ kind: 'coil', w: 0.8, cap: 'PREHEAT', v: inv.ph, heat: true, t: coilTemp.ph });
    if (inv.cc) secs.push({ kind: 'coil', w: 1.0, cap: 'COOLING', v: inv.cc, heat: false, t: coilTemp.cc });
    if (hum) secs.push({ kind: 'hum', w: 1.2, cap: 'HUMIDIFIER', hum });
    if (inv.rh && !this.rhAfterFans) secs.push({ kind: 'coil', w: 0.8, cap: 'HEATING', v: inv.rh, heat: true, t: coilTemp.rh });
    const n = inv.fans.length;
    // an exhaust-fan unit (kind 'ef') is the same casing with one fan: exhaust, not supply
    secs.push({ kind: 'fans', w: n > 4 ? 2.1 : 1.9, cap: this.kind === 'ef' ? (n > 1 ? 'EXHAUST FANS' : 'EXHAUST FAN') : (n > 1 ? 'SUPPLY FANS' : 'SUPPLY FAN') });
    if (inv.rh && this.rhAfterFans) secs.push({ kind: 'coil', w: 0.8, cap: 'REHEAT', v: inv.rh, heat: true, t: coilTemp.rh });
    secs.push({ kind: 'discharge', w: 1.2, cap: this.kind === 'ef' ? 'EXHAUST' : 'DISCHARGE' });

    let x = 0;
    for (const s of secs) { s.x0 = x; x += s.w; }
    const total = x;
    const x0 = -total / 2;
    secs.forEach((s, i) => {
      s.i = i;
      s.baseX = x0 + s.x0 + s.w / 2;
      s.group = new THREE.Group();
      s.group.position.x = s.baseX;
      unit.add(s.group);
      s.open = new Set(s.open || []);
      this._cabinet(s.group, s.w, this.DH, s);
      this._fill(s);
      this._sectionTag(s);
    });
    this.sections = secs;
    this.total = total;
    // the supply outlet collar on the discharge (see _duct): outer face centre
    // and size in the unit's own frame — a building's ductwork starts exactly here
    const dis = secs[secs.length - 1], collar = Math.min(0.55, this.DH * 0.35);
    this.outletLocal = dis.kind === 'discharge' ? { x: dis.baseX + dis.w / 2 + collar, y: this.DH / 2, z: 0, w: this.D * 0.7, h: this.DH * 0.7 } : null;
    this.mixSec = secs.find((s) => s.kind === 'mix') || null;
    this.econSec = secs.find((s) => s.kind === 'econ') || null;
    this.retMod = null;
    if (this.swap && this.mixSec) this._buildReturnModule(this.mixSec, this.retFace);
    // a module under the unit lifts the whole unit onto it
    unit.position.y = this.retMod && this.retFace === 'floor' ? this.DH : 0;
  }

  /**
   * Swapped layout: the return fans and relief live in a return module on the
   * chosen side of the mixing box (above it, behind it, in front of it or
   * under it). Return air enters its far end, runs back toward the mixing box
   * through the fans, relieves out the module's outer face, and the rest
   * drops through the RA damper into the mixing box.
   */
  _buildReturnModule(mix, face) {
    const inv = this.inv;
    const has = this.has;
    const rf = inv.rfs.concat(inv.rlfs || [], inv.efs);
    const parts = [{ kind: 'drop', w: mix.w }];
    if (rf.length) parts.push({ kind: 'fans', w: rf.length > 4 ? 2.1 : 1.9 });
    parts.push({ kind: 'in', w: 0.9 });
    const Lr = parts.reduce((a, p) => a + p.w, 0);
    const off = { roof: [this.DH, 0], floor: [-this.DH, 0], back: [0, -this.D], front: [0, this.D] }[face];
    const outer = face === 'floor' ? 'back' : face;           // relief can't go into the ground
    const mod = new THREE.Group();
    mod.position.set(-mix.w / 2, off[0], off[1]);            // local to the mixing box
    mix.group.add(mod);
    let x = 0;
    for (const p of parts) {
      const g = new THREE.Group();
      g.position.x = x + p.w / 2;
      mod.add(g);
      x += p.w;
      const sec = { open: new Set(p.kind === 'drop' && inv.ead ? [outer] : []) };
      // the face shared with the mixing box is open (the RA damper sits in it)
      if (p.kind === 'drop') sec.open.add({ roof: 'floor', floor: 'roof', back: 'front', front: 'back' }[face]);
      this._cabinet(g, p.w, this.DH, sec);
      if (p.kind === 'drop' && inv.ead) {
        this._faceDamper(g, inv.ead, p.w, outer, true);
        this._tag(g, this._outPos(outer, 0.3), [[inv.ead, 'EA DMP', '%']]);
      }
      if (p.kind === 'fans') this._fanWall(g, rf, this.DH, 0, -1, 0, [0.35, this.DH + 0.3, this.D / 2]);
      if (p.kind === 'in') {
        this._duct(g, p.w / 2, this.DH, +1);
        this._tag(g, [p.w / 2 + 0.5, this.DH + 0.5, this.D / 2], [['RAT', 'RA TMP', '°F'], [pick(has, ['RAH', 'RA.RH']), 'RA RH', '%'],
          [pick(has, ['RA.FLW', 'RA.CFM']), 'RA FLOW', 'cfm']]);
      }
      const cap = this._label(p.kind === 'in' ? 'RETURN' : p.kind === 'fans' ? returnFanCaption(inv) : inv.ead ? 'RELIEF' : 'RETURN PLENUM', 'a3-sec');
      cap.position.set(0, 0.02, this.D / 2 + 0.25);
      g.add(cap);
    }
    this.retMod = { Lr, off, outer, face };
  }

  /**
   * One casing module, built like the real thing: painted double-wall panels
   * (back, roof) with their seams, a dark frame, a base rail, and the front
   * left clear so the parts and the air inside show — with the access door,
   * its hinges and latches, drawn where the door is. Every edge wears a crisp
   * dark outline. Frame, rail and hardware merge into one mesh each.
   */
  _cabinet(g, w, h, s) {
    const m = this.m, D = this.D, hw = w / 2, hd = D / 2;
    const open = (s && s.open) || new Set();   // faces with an opening in them
    const full = !this.embedded && this.tier !== 'low';
    const L = [];                               // outline segments, x0 y0 z0 x1 y1 z1
    const seg = (a, b) => L.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    const rect = (x0, y0, x1, y1, z) => { seg([x0, y0, z], [x1, y0, z]); seg([x1, y0, z], [x1, y1, z]); seg([x1, y1, z], [x0, y1, z]); seg([x0, y1, z], [x0, y0, z]); };
    const box = (list, sx, sy, sz, px, py, pz) => list.push(new THREE.BoxGeometry(sx, sy, sz).translate(px, py, pz));
    const frameG = [], baseG = [], hwG = [];
    // the back and the roof in the chosen finish: clear glass (default) or smooth matte grey;
    // no seams — the black border on every edge carries the shape
    const grey = this.casing === 'grey';
    const skins = [];
    const shell = (geo, pos, rotX = 0) => {
      const mesh = new THREE.Mesh(geo, grey ? m.casingGrey : m.casingClear.clone());
      mesh.position.set(...pos);
      mesh.rotation.x = rotX;
      if (grey) mesh.receiveShadow = true; else { mesh.renderOrder = 2; skins.push(mesh); }
      g.add(mesh);
    };
    if (!open.has('back')) shell(new THREE.PlaneGeometry(w, h), [0, h / 2, -hd]);
    // the roof does not cast: the key light still reaches the parts inside
    if (!open.has('roof')) shell(new THREE.PlaneGeometry(w, D), [0, h, 0], -Math.PI / 2);
    if (!open.has('floor')) {
      const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, D), m.floor);
      floor.position.y = 0.03;
      floor.receiveShadow = true;
      g.add(floor);
      // base rail: a channel under each long side, a little proud of the casing
      for (const zz of [-hd - 0.02, hd + 0.02]) { box(baseG, w, 0.13, 0.07, 0, 0.065, zz); rect(-hw, 0, hw, 0.13, zz + Math.sign(zz) * 0.036); }
    }
    // frame: posts and rails along every edge
    for (const zz of [-hd, hd]) {
      box(frameG, w, T, T, 0, h - T / 2, zz);
      box(frameG, w, T, T, 0, T / 2, zz);
      for (const xx of [-hw + T / 2, hw - T / 2]) box(frameG, T, h, T, xx, h / 2, zz);
    }
    for (const xx of [-hw + T / 2, hw - T / 2]) box(frameG, T, T, D, xx, h - T / 2, 0);
    // the box outline
    for (const zz of [-hd, hd]) rect(-hw, 0, hw, h, zz + Math.sign(zz) * 0.001);
    for (const xx of [-hw, hw]) for (const yy of [0, h]) seg([xx, yy, -hd], [xx, yy, hd]);
    // the front stays clear in both finishes (the view is into the unit), fading when exploded
    if (!open.has('front')) {
      const front = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.02, h - 0.02), m.casingClear.clone());
      front.position.set(0, h / 2, hd);
      front.renderOrder = 2;
      g.add(front); skins.push(front);
      // access door (or a bolted service panel) on this module's front
      const door = s && this._doorKind?.(s);
      if (door && w > 0.5 && h > 1) {
        const x0 = -hw + 0.09, x1 = hw - 0.09, y0 = 0.2, y1 = h - 0.14, z = hd + 0.003;
        rect(x0, y0, x1, y1, z);
        if (full && door === 'door') {
          // three hinges on the upstream edge, two latch handles on the other
          for (const f of [0.14, 0.5, 0.86]) {
            const y = y0 + (y1 - y0) * f;
            hwG.push(new THREE.CylinderGeometry(0.016, 0.016, 0.1, 10).translate(x0 - 0.004, y, z + 0.018));
            box(hwG, 0.05, 0.08, 0.006, x0 + 0.025, y, z + 0.004);
          }
          for (const f of [0.3, 0.72]) {
            const y = y0 + (y1 - y0) * f;
            box(hwG, 0.05, 0.13, 0.012, x1 - 0.05, y, z + 0.006);
            box(hwG, 0.024, 0.16, 0.026, x1 - 0.05, y - 0.03, z + 0.024);
          }
        } else if (full) {
          for (const [x, y] of [[x0 + 0.05, y0 + 0.05], [x1 - 0.05, y0 + 0.05], [x0 + 0.05, y1 - 0.05], [x1 - 0.05, y1 - 0.05]]) hwG.push(new THREE.CylinderGeometry(0.011, 0.011, 0.012, 8).rotateX(Math.PI / 2).translate(x, y, z + 0.006));
        }
      }
    }
    const merged = (list, mat, cast = true) => {
      if (!list.length) return;
      const mm = new THREE.Mesh(list.length === 1 ? list[0] : mergeGeometries(list, false), mat);
      if (list.length > 1) for (const x of list) x.dispose();
      mm.castShadow = cast;
      g.add(mm);
    };
    merged(frameG, m.rail);
    merged(baseG, m.base);
    merged(hwG, m.hardware, false);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(L, 3));
    g.add(new THREE.LineSegments(lg, m.outline));
    if (s) s.skins = skins;
  }

  /** Which modules have an access door on the front ('door'), a bolted panel ('panel'), or neither. */
  _doorKind(s) {
    if (this.kind !== 'ahu' && this.kind !== 'crac' && this.kind !== 'eru') return null;
    if (['mix', 'filter', 'fans', 'retfans', 'hum', 'econ', 'exfans', 'supfans'].includes(s.kind)) return 'door';
    if (s.kind === 'coil' || s.kind === 'wheel') return 'panel';
    return null;
  }

  _fill(s) {
    const g = s.group;
    const has = this.has;
    // readouts over neighbouring sections alternate height so they don't stack
    const topY = this.DH + 0.3 + (s.i % 2) * 0.6;
    if (s.kind === 'intake') {
      const dm = this._damper(this.inv.oad, this.D - 0.3, this.DH - 0.3, 9);
      dm.position.set(-s.w / 2 + 0.1, this.DH / 2, 0);
      g.add(dm);
      this._hood(g, -s.w / 2, this.DH, -1);
      this._tag(g, [-s.w / 2 - 0.35, this.DH + 0.35, this.D / 2], [[this.kind === 'ef' ? pick(has, ['EXAT', 'OAT']) : 'OAT', this.kind === 'ef' ? 'EA TMP' : 'OA TMP', '°F'], [pick(has, ['OAH', 'OARH', 'OA.RH']), 'OA RH', '%'], [pick(has, ['OA.CFM', 'OACFM', 'OA.FLW']), 'OA FLOW', 'cfm']]);
      this._tag(g, [-s.w / 2 + 0.1, this.DH * 0.2, this.D / 2 + 0.05], [[this.inv.oad, this.kind === 'ef' ? 'ISO DMP' : 'OA DMP', '%']]);
    } else if (s.kind === 'retin') {
      const face = this.layout.ret;
      if (face === 'end') this._duct(g, -s.w / 2, this.DH, -1);
      else this._faceDuct(g, s.w, face);
      this._tag(g, face === 'end' ? [-s.w / 2 - 0.4, this.DH + 0.5, this.D / 2] : this._outPos(face, 0.7),
        [['RAT', 'RA TMP', '°F'], [pick(has, ['RAH', 'RA.RH']), 'RA RH', '%'], [pick(has, ['RA.FLW', 'RA.CFM']), 'RA FLOW', 'cfm']]);
    } else if (s.kind === 'retfans') {
      this._fanWall(g, s.fans, this.DH, 0, 1, 0.05, [0.35, this.DH + 0.3, this.D / 2]);
    } else if (s.kind === 'econ') {
      if (this.inv.ead) {
        this._faceDamper(g, this.inv.ead, s.w, this.layout.relief, true);
        this._tag(g, this._outPos(this.layout.relief, 0.3), [[this.inv.ead, 'EA DMP', '%']]);
      }
      if (this.inv.rad) {
        const dm = this._damper(this.inv.rad, this.D - 0.3, this.DH - 0.3, 9);
        dm.position.set(s.w / 2 - 0.1, this.DH / 2, 0);
        g.add(dm);
        this._tag(g, [s.w / 2 - 0.1, this.DH * 0.22, this.D / 2 + 0.05], [[this.inv.rad, 'RA DMP', '%']]);
      }
    } else if (s.kind === 'mix') {
      if (this.swap) {
        // return drops in through the face the return module sits on
        if (this.inv.rad) {
          this._faceDamper(g, this.inv.rad, s.w, this.retFace, false, false);
          this._tag(g, this._outPos(this.retFace === 'roof' ? 'front' : this.retFace, 0.3), [[this.inv.rad, 'RA DMP', '%']]);
        }
      } else if (this.inv.hasRet && this.inv.oad) {
        const face = this.layout.oa;
        this._faceDamper(g, this.inv.oad, s.w, face, false);
        this._tag(g, this._outPos(face, 0.3), [[this.inv.oad, this.kind === 'ef' ? 'ISO DMP' : 'OA DMP', '%']]);
        this._tag(g, face === 'roof' ? [-0.2, this.DH + ABOVE * 0.75, this.D / 2] : this._outPos(face, ABOVE * 0.8),
          [[this.kind === 'ef' ? pick(has, ['EXAT', 'OAT']) : 'OAT', this.kind === 'ef' ? 'EA TMP' : 'OA TMP', '°F'], [pick(has, ['OAH', 'OARH', 'OA.RH']), 'OA RH', '%'], [pick(has, ['OA.CFM', 'OACFM', 'OA.FLW']), 'OA FLOW', 'cfm']]);
      }
      if (this.inv.mat) this._tag(g, [0.2, this.DH * 0.4, this.D / 2], [[this.inv.mat, 'MA TMP', '°F']]);
    } else if (s.kind === 'filter') {
      const f = this._filter(s.f.alm);
      f.userData.pick = { title: s.f.cap, points: [s.f.alm, s.f.dp].filter(Boolean) };
      g.add(f);
      this._tag(g, [0, topY, this.D / 2], [[s.f.dp, 'DP', 'inWC'], [s.f.alm, 'ALARM', 'alm']]);
    } else if (s.kind === 'coil') {
      const c = this._coil(s.v, s.heat);
      if (s.t) c.userData.pick.points.push(s.t);
      c.userData.pick.title = `${s.cap} coil`;
      g.add(c);
      this._valve(g, s, s.heat);
      this._tag(g, [0, topY, this.D / 2], [[s.t, s.heat ? 'LVG TMP' : 'CC TMP', '°F']]);
      this._tag(g, [0.05, 0.28, this.D / 2 + 0.35], [[s.v, s.heat ? 'HW VLV' : 'CHW VLV', '%']]);
    } else if (s.kind === 'hum') {
      this._humidifier(g, s.hum);
      this._tag(g, [0, topY, this.D / 2], [[s.hum.out, 'HUM', '%'], [s.hum.cmd, 'HUM', 'onoff']]);
    } else if (s.kind === 'fans') {
      this._fanWall(g, this.inv.fans, this.DH, 0, 1, 0.05, [0.35, this.DH + 0.2, this.D / 2]);
    } else if (s.kind === 'discharge') {
      this._duct(g, s.w / 2, this.DH, +1);
      this._tag(g, [s.w / 2 + 0.55, this.DH + 0.45, this.D / 2], [[this.kind === 'ef' ? pick(has, ['EXAT', 'SAT']) : 'SAT', this.kind === 'ef' ? 'EA TMP' : 'SA TMP', '°F'], [pick(has, ['SAT.SP', 'SATSP']), 'SA SP', '°F'],
        [pick(has, ['SSP', 'SA.SP.PRES', 'DSP']), 'STATIC', 'inWC'], [pick(has, ['SA.CFM', 'SA.FLW', 'SAF.CFM']), 'SA FLOW', 'cfm'],
        [pick(has, ['SAH', 'SA.RH']), 'SA RH', '%']]);
    }
  }

  /** Workbench plinth and a floor that fades into the dark. */
  _buildBench() {
    this._buildPlinth();
    this._buildFloor();
  }

  /** The plinth follows the unit's footprint, including a side return module. */
  _buildPlinth() {
    if (this.bench) {
      this.scene.remove(this.bench);
      this.bench.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    }
    const bench = new THREE.Group();
    this.bench = bench;
    this.scene.add(bench);
    const side = this.retMod && (this.retMod.face === 'back' || this.retMod.face === 'front') ? this.retMod.face : null;
    const zMin = this.foot?.zMin ?? (side === 'back' ? -1.5 * this.D : -this.D / 2), zMax = this.foot?.zMax ?? (side === 'front' ? 1.5 * this.D : this.D / 2);
    const depth = zMax - zMin + 1.1, zc = (zMin + zMax) / 2;
    const w = this.total + 2.6 + (this.explodeTarget ? this.sections.length * GAP : 0);
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(w, 0.28, depth),
      new THREE.MeshStandardMaterial({ color: '#171c21', metalness: 0.55, roughness: 0.45 }));
    plinth.position.set(0, -0.14, zc);
    plinth.receiveShadow = true;
    bench.add(plinth);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(w - 0.1, 0.025, 0.025),
      new THREE.MeshStandardMaterial({ color: '#46d3e6', emissive: '#46d3e6', emissiveIntensity: 0.7 }));
    strip.position.set(0, -0.06, zc + depth / 2 + 0.002);
    bench.add(strip);
    // ruler ticks along the plinth edge, a nod to the parts-bench look
    const ticks = new THREE.Group();
    const tm = new THREE.MeshBasicMaterial({ color: '#5d6a75' });
    // one tick per foot, a long one every 5 ft, so the unit reads at real size
    const nft = Math.floor((w - 0.6) / FT);
    for (let i = 0; i <= nft; i++) {
      const major = i % 5 === 0;
      const t = new THREE.Mesh(new THREE.PlaneGeometry(0.012, major ? 0.16 : 0.07), tm);
      t.rotation.x = -Math.PI / 2;
      t.position.set(-w / 2 + 0.3 + i * FT, 0.001, zc + depth / 2 - 0.1);
      ticks.add(t);
    }
    bench.add(ticks);
  }

  _buildFloor() {
    const floor = new THREE.Mesh(new THREE.CircleGeometry(90, 64),
      new THREE.MeshStandardMaterial({ color: '#0e1419', metalness: 0.2, roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.281;
    floor.receiveShadow = true;
    this.scene.add(floor);
    // The floor grid: drawn in the shader with anti-aliased lines that fade out
    // with distance and before they get finer than a pixel. (A GridHelper's far
    // lines alias into rows of dashes across the whole backdrop at a low camera.)
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uMinor: { value: new THREE.Color('#1a252d') }, uMajor: { value: new THREE.Color('#24333e') } },
      vertexShader: 'varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: `
        uniform vec3 uMinor, uMajor;
        varying vec3 vW;
        float gridLine(vec2 p, float s) {
          vec2 q = p / s;
          vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-4));
          return 1.0 - min(min(g.x, g.y), 1.0);
        }
        void main() {
          float fade = 1.0 - smoothstep(9.0, 30.0, length(vW.xz));
          float dens = max(fwidth(vW.x), fwidth(vW.z));          // metres per pixel here
          float minor = gridLine(vW.xz, 0.3048) * (1.0 - smoothstep(0.03, 0.08, dens));
          float major = gridLine(vW.xz, 1.524) * (1.0 - smoothstep(0.12, 0.3, dens));
          float a = max(minor * 0.35, major * 0.8) * fade;
          if (a < 0.01) discard;
          gl_FragColor = vec4(mix(uMinor, uMajor, major), a * 0.9);
        }`,
    }));
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = -0.279;
    grid.renderOrder = -1;
    this.scene.add(grid);
  }

  // ---- parts --------------------------------------------------------------

  /** Opposed-blade damper; blades rotate from flat (open) to vertical (shut). */
  _damper(suffix, depth, height, nBlades) {
    const g = new THREE.Group();
    const m = this.m;
    // frame as four bars so the opening stays open
    for (const sy of [-1, 1]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, depth + 0.1), m.rail);
      b.position.y = sy * (height / 2 + 0.02); g.add(b);
    }
    for (const sz of [-1, 1]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, height + 0.1, 0.05), m.rail);
      b.position.z = sz * (depth / 2 + 0.02); g.add(b);
    }
    const pitch = height / nBlades;
    const blades = [];
    for (let i = 0; i < nBlades; i++) {
      const piv = new THREE.Group();
      piv.position.y = -height / 2 + pitch * (i + 0.5);
      const bl = new THREE.Mesh(new THREE.BoxGeometry(pitch * 0.98, 0.018, depth - 0.02), m.blade);
      bl.castShadow = true;
      piv.add(bl);
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, depth + 0.06, 8), m.brass);
      axle.rotation.x = Math.PI / 2;
      piv.add(axle);
      piv.userData.dir = i % 2 ? 1 : -1;   // opposed blades
      g.add(piv);
      blades.push(piv);
    }
    this._outline(g, 0.1, height + 0.14, depth + 0.14);
    // blades start shut until the first read
    for (const b of blades) b.rotation.z = b.userData.dir * Math.PI / 2 * 0.95;
    this.parts.dampers.push({ suffix, blades, pos: 0, g, depth, height, n: nBlades });
    g.userData.pick = { title: `${suffix} · damper`, points: [suffix] };
    this.anchors.set(suffix, g);
    this._bind(suffix);
    return g;
  }

  /** Finned coil with copper return bends; glows with valve %. */
  _coil(suffix, heat) {
    const g = new THREE.Group();
    const w = Math.min(0.22, this.DH * 0.1), h = this.DH - Math.min(0.22, this.DH * 0.12), d = this.D - Math.min(0.16, this.D * 0.08);
    const finMat = new THREE.MeshStandardMaterial({
      color: '#aab4bd', metalness: 0.8, roughness: 0.35,
      emissive: heat ? '#ff5a1f' : '#1f9bff', emissiveIntensity: 0
    });
    const nFins = 46;
    const fins = new THREE.InstancedMesh(new THREE.BoxGeometry(w, h, 0.006), finMat, nFins);
    const mtx = new THREE.Matrix4();
    for (let i = 0; i < nFins; i++) {
      mtx.makeTranslation(0, this.DH / 2, -d / 2 + (d * (i + 0.5)) / nFins);
      fins.setMatrixAt(i, mtx);
    }
    fins.castShadow = true;
    g.add(fins);
    const tubeMat = this.m.copper.clone();
    tubeMat.emissive = new THREE.Color(heat ? '#ff4a14' : '#1a8cff');
    tubeMat.emissiveIntensity = 0;
    const rows = 9;
    for (let r = 0; r < rows; r++) {
      for (const xx of [-w / 4, w / 4]) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, d + 0.12, 10), tubeMat);
        t.rotation.x = Math.PI / 2;
        t.position.set(xx, 0.16 + (h - 0.05) * (r + 0.5) / rows, 0);
        g.add(t);
      }
      // return bends on the front face
      const bend = new THREE.Mesh(new THREE.TorusGeometry(w / 4, 0.016, 8, 16, Math.PI), tubeMat);
      bend.position.set(0, 0.16 + (h - 0.05) * (r + 0.5) / rows, d / 2 + 0.06);
      g.add(bend);
    }
    // casing sides
    for (const sy of [0.08, this.DH - 0.08]) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(w + 0.06, 0.05, d + 0.06), this.m.rail);
      c.position.y = sy; g.add(c);
    }
    this._outline(g, w + 0.06, h + 0.05, d + 0.06, 0, this.DH / 2, 0);
    const fx = coilShader(finMat);
    fx.uH.value = this.DH - 0.22;
    let pan = null;
    if (!heat) {
      // condensate drain pan: fills with a sheen of water while the coil is wet
      const tray = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.05, this.D - 0.1), this.m.rail);
      tray.position.y = 0.07;
      g.add(tray);
      pan = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.22, this.D - 0.2),
        new THREE.MeshStandardMaterial({ color: '#8fd3ff', metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0, envMapIntensity: 1.5 }));
      pan.rotation.x = -Math.PI / 2;
      pan.position.y = 0.1;
      g.add(pan);
    }
    this.parts.coils.push({ suffix, mats: [finMat, tubeMat], heat, pct: 0, fx, pan, wet: 0, frost: 0 });
    g.userData.pick = { title: `${suffix} · ${heat ? 'heating' : 'cooling'} coil`, points: [suffix] };
    this.anchors.set(suffix, g);
    this._bind(suffix);
    return g;
  }

  /** Supply / return piping out the front with a valve body and actuator. */
  _valve(g, s, heat) {
    const m = this.m;
    const H = this.DH, Z = this.D / 2;
    const lo = 0.15 * H, hi = 0.85 * H;            // pipe heights scale with the cabinet
    const r = Math.min(0.045, H * 0.02);
    const pipeMat = new THREE.MeshStandardMaterial({ color: heat ? '#8c3b2a' : '#27557d', metalness: 0.6, roughness: 0.4 });
    const pipes = [];
    for (const yy of [lo, hi]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.7, 12), pipeMat);
      p.rotation.x = Math.PI / 2;
      p.position.set(0, yy, Z + 0.35);
      g.add(p);
      pipes.push(p);
    }
    const riser = new THREE.Mesh(new THREE.CylinderGeometry(r, r, hi - lo, 12), pipeMat);
    riser.position.set(0, (lo + hi) / 2, Z + 0.7);
    g.add(riser);
    // where a building's supply pipe meets this coil: the valve-side pipe end,
    // out on the unit's +z side (building3d reads it through coilPorts)
    (this.coilPorts ||= []).push({ g, heat, local: [0, lo, Z + 0.7], retLocal: [0, hi, Z + 0.7], r });
    const k = Math.min(1, H / 2.4);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.1 * k, 16, 12), m.brass);
    body.position.set(0, lo, Z + 0.42);
    g.add(body);
    const act = new THREE.Mesh(new THREE.BoxGeometry(0.14 * k, 0.16 * k, 0.14 * k), m.dark);
    act.position.set(0, lo + 0.2 * k, Z + 0.42);
    g.add(act);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * k, 0.05 * k, 0.03 * k, 16), m.brass);
    cap.position.set(0, lo + 0.295 * k, Z + 0.42);
    g.add(cap);
    (this.parts.valves ||= []).push({ g, s, heat, lo, hi, Z, r, pipes, body, act, cap });
  }

  /** Pleated media: a zig-zag strip, instanced across the depth. */
  _filter(alm) {
    const g = new THREE.Group();
    const h = this.DH - 0.2, d = this.D - 0.12;
    const mat = this.m.media.clone();
    const n = 22;
    const pleat = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.19, h), mat, n * 2);
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1), mtx = new THREE.Matrix4();
    const ang = 0.9;
    for (let i = 0; i < n * 2; i++) {
      const zc = -d / 2 + (d * (i + 0.5)) / (n * 2);
      q.setFromEuler(new THREE.Euler(0, Math.PI / 2 + (i % 2 ? ang : -ang), 0));
      p.set(0, this.DH / 2, zc);
      mtx.compose(p, q, sc);
      pleat.setMatrixAt(i, mtx);
    }
    g.add(pleat);
    for (const sy of [0.08, this.DH - 0.08]) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, d + 0.08), this.m.rail);
      c.position.y = sy; g.add(c);
    }
    this._outline(g, 0.2, h + 0.05, d + 0.08, 0, this.DH / 2, 0);
    this.parts.filters.push({ suffix: alm, mat, alarm: 0 });
    if (alm) g.userData.pick = { title: 'Filter', points: [alm] };
    if (alm) this._bind(alm);
    return g;
  }

  /**
   * Lay out a fan array of any size on a wall `h` tall by the cabinet depth:
   * pick the rows × columns that give the biggest wheels, center a short last
   * row, and pin one readout listing every fan (one tag per fan gets
   * unreadable past four).
   */
  _fanWall(g, bases, h, y0, dir, x, tagPos) {
    const has = this.has;
    const n = bases.length;
    const W = this.D - 0.2, H = h - 0.2;
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const dia = Math.min(H / rows, W / cols) * 0.9;
      if (!best || dia > best.dia + 1e-6) best = { cols, rows, dia };
    }
    const { cols, rows } = best;
    const dia = Math.min(best.dia, n === 1 ? 1.9 : 1.25);
    const holes = [];
    bases.forEach((b, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
      const y = y0 + 0.1 + H * (rows - r - 0.5) / rows;       // first fans on top
      const z = -W / 2 + (W / cols) * (c + 0.5) + (W / cols) * (cols - inRow) / 2;
      const f = this._fan(b, dia, dir, true);
      f.position.set(x, y, z);
      g.add(f);
      holes.push({ y, z, hy: H / rows / 2, hz: W / cols / 2 });
    });
    this._bulkhead(g, holes, dia, dir, x, y0, h);
    if (n <= 4) {
      this._tag(g, tagPos, bases.map((b) => {
        const spd = resolveSuffix(has, b, 'speed');
        // an exhaust-fan unit's one fan is the unit itself: read "EF", not the SF1 the bridge files it under
        const cap = this.kind === 'ef' && n === 1 ? 'EF' : b;
        return [spd || runSuffix(has, b), cap, spd ? '%' : 'onoff'];
      }));
      return;
    }
    // Big arrays: one line — how many are running and their average speed.
    // Clicking it opens every fan's start/stop and speed in the command card.
    const title = dir > 0 ? 'Supply fans' : 'Return fans';
    const t = this._tag(g, tagPos, [[runSuffix(has, bases[0]), `${n} FANS`, 'fans']]);
    const entry = this.tags[this.tags.length - 1];
    entry.fans = bases.map((b) => ({ run: runSuffix(has, b), spd: resolveSuffix(has, b, 'speed') }));
    const all = [];
    for (const b of bases) {
      for (const sfx of [resolveSuffix(has, b, 'command'), resolveSuffix(has, b, 'speed')]) if (sfx) { all.push(sfx); this._bind(sfx); }
    }
    entry.row.onclick = null;
    entry.row.replaceWith(entry.row.cloneNode(true));
    const row = t.element.lastChild;
    entry.row = row; entry.el = row.lastChild;
    row.title = 'Click to command the fans';
    row.addEventListener('click', (ev) => this.onPick?.(title, all, ev.clientX, ev.clientY));
  }

  /**
   * The fan wall: one bulkhead across the whole section with a round inlet
   * opening behind each fan, concentric with it and sized to its inlet cone, a
   * bellmouth ring on the upstream face, the black border round the wall and
   * every opening. The air streams converge through the holes into the fans.
   */
  _bulkhead(g, holes, dia, dir, x, y0, h) {
    const m = this.m, D = this.D, r = dia / 2;
    const k = clamp(dia / 0.82, 0.35, 1.6);
    const xb = x - 0.32 * k * dir, t = 0.03, hr = r * 0.74;
    // shape in (u, v) = (−z, y); rotateY(π/2) takes it to the y–z plane, the extrusion along x
    const sh = new THREE.Shape();
    const z0 = -D / 2 + 0.03, z1 = D / 2 - 0.03, ya = y0 + 0.06, yb = y0 + h - 0.06;
    sh.moveTo(-z0, ya); sh.lineTo(-z1, ya); sh.lineTo(-z1, yb); sh.lineTo(-z0, yb); sh.lineTo(-z0, ya);
    for (const o of holes) { const p = new THREE.Path(); p.absarc(-o.z, o.y, hr, 0, Math.PI * 2, true); sh.holes.push(p); }
    const geo = new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false, curveSegments: 40 });
    geo.rotateY(Math.PI / 2);
    geo.translate(xb - t / 2, 0, 0);
    const wall = new THREE.Mesh(geo, m.panel);
    wall.receiveShadow = true;
    wall.castShadow = true;
    wall.userData.bulkhead = true;
    g.add(wall);
    const L = [];
    const ring = (xx, yy, zz, rr) => { for (let i = 0; i < 48; i++) { const a0 = (i / 48) * Math.PI * 2, a1 = ((i + 1) / 48) * Math.PI * 2; L.push(xx, yy + Math.cos(a0) * rr, zz + Math.sin(a0) * rr, xx, yy + Math.cos(a1) * rr, zz + Math.sin(a1) * rr); } };
    for (const xx of [xb - t / 2 - 0.001, xb + t / 2 + 0.001]) {
      for (const o of holes) ring(xx, o.y, o.z, hr);
      L.push(xx, ya, z0, xx, ya, z1, xx, ya, z1, xx, yb, z1, xx, yb, z1, xx, yb, z0, xx, yb, z0, xx, ya, z0);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(L, 3));
    g.add(new THREE.LineSegments(lg, m.outline));
    // the bellmouth ring round each opening, upstream face
    for (const o of holes) {
      const bm = new THREE.Mesh(new THREE.TorusGeometry(hr, 0.02 * k, 10, 48), m.steel);
      bm.rotation.y = Math.PI / 2;
      bm.position.set(xb - dir * (t / 2 + 0.01 * k), o.y, o.z);
      g.add(bm);
    }
    (this.fanHoles ||= []).push({ g, x: xb, r: hr, holes });
  }

  /** Plenum fan: inlet cone, wheel with backward-curved blades, motor. */
  _fan(base, dia, dir, onWall = false) {
    const has = this.has;
    const g = new THREE.Group();
    const m = this.m;
    const r = dia / 2;
    const k = clamp(dia / 0.82, 0.35, 1.6);   // depth offsets scale with the wheel
    // inlet plate + cone facing upstream
    if (!onWall) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.03, dia * 1.12, dia * 1.12), m.panel);
      plate.position.x = -0.32 * k * dir;
      g.add(plate);
    }
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.72, 0.18 * k, 32, 1, true), m.steel);
    cone.rotation.z = dir * Math.PI / 2;
    cone.position.x = -0.24 * k * dir;
    g.add(cone);
    // wheel
    const wheel = new THREE.Group();
    const ringMat = m.brass;
    const back = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.02, 40), m.steel);
    back.rotation.z = Math.PI / 2;
    back.position.x = 0.12 * k * dir;
    wheel.add(back);
    const shroud = new THREE.Mesh(new THREE.TorusGeometry(r * 0.92, 0.022 * k, 10, 48), ringMat);
    shroud.rotation.y = Math.PI / 2;
    shroud.position.x = -0.12 * k * dir;
    wheel.add(shroud);
    const nb = dia < 0.5 ? 8 : 12;
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * Math.PI * 2;
      const bl = new THREE.Mesh(new THREE.BoxGeometry(0.24 * k, r * 0.42, 0.012), m.blade);
      const piv = new THREE.Group();
      piv.rotation.x = a;
      bl.position.y = r * 0.7;
      bl.rotation.x = 0.55;       // backward curve, near enough
      piv.add(bl);
      wheel.add(piv);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.16, r * 0.16, 0.26 * k, 20), m.dark);
    hub.rotation.z = Math.PI / 2;
    wheel.add(hub);
    wheel.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.add(wheel);
    // motor behind the wheel
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.3, r * 0.3, 0.34 * k, 24), m.dark);
    motor.rotation.z = Math.PI / 2;
    motor.position.x = 0.36 * k * dir;
    g.add(motor);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.31, r * 0.31, 0.04 * k, 24),
      new THREE.MeshStandardMaterial({ color: '#46d3e6', emissive: '#46d3e6', emissiveIntensity: 0 }));
    band.rotation.z = Math.PI / 2;
    band.position.x = 0.46 * k * dir;
    g.add(band);

    const run = runSuffix(has, base);
    const spd = resolveSuffix(has, base, 'speed');
    const flt = resolveSuffix(has, base, 'fault');
    this.parts.fans.push({ base, run, spd, flt, wheel, band, dir, speed: 0 });
    const cmd = resolveSuffix(has, base, 'command');
    g.userData.pick = { title: base, points: [cmd, spd, run, flt].filter(Boolean) };
    for (const sfx of [cmd, spd, run]) if (sfx) this.anchors.set(sfx, g);
    this._bind(run); if (spd) this._bind(spd); if (flt) this._bind(flt);
    return g;
  }

  _humidifier(g, hum) {
    const m = this.m;
    const tubes = [];
    const mat = new THREE.MeshStandardMaterial({ color: '#8d989f', metalness: 0.7, roughness: 0.3, emissive: '#bfefff', emissiveIntensity: 0 });
    for (let i = 0; i < 6; i++) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, this.DH - 0.4, 10), mat);
      t.position.set(0, this.DH / 2, -this.D / 2 + 0.2 + i * ((this.D - 0.4) / 5));
      g.add(t);
      tubes.push(t);
    }
    const hdr = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, this.D - 0.2), m.rail);
    hdr.position.y = 0.2;
    g.add(hdr);
    this.parts.hums.push({ hum, mat, level: 0 });
    for (const t of tubes) t.userData.pick = { title: 'Humidifier', points: [hum.cmd, hum.out].filter(Boolean) };
    if (hum.cmd) this._bind(hum.cmd);
    if (hum.out) this._bind(hum.out);
  }

  /** A crisp dark outline round a box (the casing look carried onto the parts inside). */
  _outline(g, sx, sy, sz, px = 0, py = 0, pz = 0) {
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz)), this.m.outline);
    e.position.set(px, py, pz);
    g.add(e);
    return e;
  }

  /** A short duct stub leaving the cabinet end. */
  _duct(g, x, h, dir) {
    const len = Math.min(0.55, this.DH * 0.35);
    const box = new THREE.Mesh(new THREE.BoxGeometry(len, h * 0.7, this.D * 0.7), this.m.glass.clone());
    box.position.set(x + dir * len / 2, h / 2, 0);
    g.add(box);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), this.m.outline);
    e.position.copy(box.position);
    g.add(e);
    // the duct flange where the stub meets the ductwork
    const fl = new THREE.Mesh(new THREE.BoxGeometry(0.04, h * 0.7 + 0.08, this.D * 0.7 + 0.08), this.m.rail);
    fl.position.set(x + dir * (len - 0.02), h / 2, 0);
    g.add(fl);
  }

  /** Weather hood with slanted louvers on an intake or exhaust face. */
  _hood(g, x, h, dir, exhaust = false) {
    const hood = new THREE.Group();
    const n = Math.round(h / 0.16);
    for (let i = 0; i < n; i++) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.012, this.D - 0.1), this.m.rail);
      l.rotation.z = exhaust ? -0.6 : 0.6;
      l.position.set(dir * 0.13, 0.12 + i * ((h - 0.2) / Math.max(1, n - 1)), 0);
      hood.add(l);
    }
    hood.position.x = x;
    g.add(hood);
  }

  /**
   * A damper in one face of a section — 'roof', 'floor', 'back' or 'front' —
   * with a louvered weather hood outside it (not under the floor, and not
   * where the face opens into another module).
   */
  _faceDamper(g, suffix, w, face, exhaust, hood = true) {
    let dm;
    if (face === 'roof' || face === 'floor') {
      dm = this._damper(suffix, this.D - 0.3, w - 0.4, 6);
      dm.rotation.z = Math.PI / 2;           // blades stack along the unit
      dm.position.set(0, face === 'roof' ? this.DH - 0.08 : 0.12, 0);
    } else {
      dm = this._damper(suffix, w - 0.4, this.DH - 0.4, 9);
      dm.rotation.y = Math.PI / 2;           // blades span the section's length
      dm.position.set(0, this.DH / 2, (face === 'front' ? 1 : -1) * (this.D / 2 - 0.08));
    }
    g.add(dm);
    if (hood && face !== 'floor') g.add(this._faceHood(w, face, exhaust));
    return dm;
  }

  _faceHood(w, face, exhaust) {
    const hood = new THREE.Group();
    const rail = this.m.rail;
    if (face === 'roof') {
      const n = Math.max(3, Math.round((w - 0.3) / 0.16));
      for (let i = 0; i < n; i++) {
        const l = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.014, this.D - 0.3), rail);
        l.rotation.z = exhaust ? -0.7 : 0.7;
        l.position.set(-(w - 0.4) / 2 + i * ((w - 0.4) / (n - 1)), this.DH + 0.22, 0);
        hood.add(l);
      }
      for (const sz of [-1, 1]) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(w - 0.2, 0.34, 0.03), rail);
        side.position.set(0, this.DH + 0.17, sz * (this.D - 0.26) / 2);
        hood.add(side);
      }
    } else {
      const sz = face === 'front' ? 1 : -1;
      const n = Math.max(4, Math.round((this.DH - 0.4) / 0.16));
      for (let i = 0; i < n; i++) {
        const l = new THREE.Mesh(new THREE.BoxGeometry(w - 0.3, 0.014, 0.22), rail);
        l.rotation.x = (exhaust ? 0.7 : -0.7) * sz;
        l.position.set(0, 0.25 + i * ((this.DH - 0.5) / (n - 1)), sz * (this.D / 2 + 0.14));
        hood.add(l);
      }
      for (const sx of [-1, 1]) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(0.03, this.DH - 0.2, 0.3), rail);
        side.position.set(sx * (w - 0.24) / 2, this.DH / 2, sz * (this.D / 2 + 0.15));
        hood.add(side);
      }
    }
    return hood;
  }

  /** A return duct entering a section through a face. */
  _faceDuct(g, w, face) {
    const len = 0.7;
    let box;
    if (face === 'roof' || face === 'floor') {
      box = new THREE.Mesh(new THREE.BoxGeometry(w * 0.8, len, this.D * 0.7), this.m.glass.clone());
      box.position.set(0, face === 'roof' ? this.DH + len / 2 : -len / 2 + 0.02, 0);
    } else {
      box = new THREE.Mesh(new THREE.BoxGeometry(w * 0.8, this.DH * 0.7, len), this.m.glass.clone());
      box.position.set(0, this.DH / 2, (face === 'front' ? 1 : -1) * (this.D / 2 + len / 2));
    }
    g.add(box);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), this.m.outline);
    e.position.copy(box.position);
    g.add(e);
  }

  /** Where a readout for something on a face sits, `dist` out from it. */
  _outPos(face, dist) {
    if (face === 'roof') return [0, this.DH + 0.35 + dist, this.D / 2];
    if (face === 'floor') return [0, 0.35, this.D / 2 + 0.3];
    if (face === 'front') return [0, this.DH * 0.85, this.D / 2 + 0.2 + dist];
    return [0, this.DH * 0.85, -this.D / 2 - 0.2 - dist];
  }

  // ---- layout options -------------------------------------------------------

  /** -1 when this unit is the mirror-image (left-hand) build, else 1. */
  get handSign() { return this.layout?.hand === 'left' ? -1 : 1; }

  _layoutKey() { return `cv_ahu3d_layout:${this.prefix}`; }

  _loadLayout() {
    try { return JSON.parse(localStorage.getItem(this._layoutKey()) || '{}') || {}; } catch { return {}; }
  }

  _saveLayout() {
    try { localStorage.setItem(this._layoutKey(), JSON.stringify(this.layout)); } catch { /* the choice still applies now */ }
    // and into the unit itself, so the building twin and every browser draw it the same
    this.onLayout?.({ ...this.layout });
  }

  /** Tear down and rebuild the unit after a layout change (values carry over). */
  _rebuildUnit() {
    const old = this.unit;
    this.scene.remove(old);
    this._disposeDevices?.({ keepCache: true });
    old.traverse((o) => {
      if (o.isCSS2DObject && o.element && o.element.parentNode) o.element.parentNode.removeChild(o.element);
      if (!o.geometry?.userData.shared) o.geometry?.dispose?.();
    });
    this.parts = this._emptyParts();
    this.tags = [];
    this.anchors = new Map();
    this.fanHoles = [];
    if (this.strat) { this.strat.dispose(); this.strat = null; }
    this._buildUnit();
    this._afterBuild?.();
    this._buildStrat();
    this._buildLinks();
    this._fitShadow();
    this._buildPlinth();
    this._refreshValues();
    this._frame(performance.now());     // settle positions before the next paint
  }

  // ---- labels ---------------------------------------------------------------

  _label(text, cls) {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    return new CSS2DObject(el);
  }

  _sectionTag(s) {
    const o = this._label(s.cap, 'a3-sec');
    o.position.set(0, 0.02, this.D / 2 + 0.25);
    s.group.add(o);
  }

  /**
   * A readout pinned to a part. `rows` is [suffix, caption, unit, states?, cmd?]
   * (unit 'state' shows states[value]; cmd is the suffix a click commands); rows whose
   * point does not exist are dropped, and so is the tag if none are left.
   */
  _tag(parent, pos, rows) {
    const live = rows.filter(([sfx]) => sfx && this.has(sfx));
    if (!live.length) return null;
    const el = document.createElement('div');
    el.className = 'a3-tag';
    for (const [sfx, cap, unit, states, cmd] of live) {
      const row = document.createElement('div');
      row.className = 'a3-row';
      row.innerHTML = `<span class="a3-k"></span><span class="a3-v">--</span>`;
      row.firstChild.textContent = cap;
      el.appendChild(row);
      this.tags.push({ el: row.lastChild, row, sfx, unit, states });
      row.title = 'Click to command';
      // a row can show one point (an effective setpoint) but command another
      row.addEventListener('click', (ev) => this.onPick?.(cap, [cmd && this.has(cmd) ? cmd : sfx], ev.clientX, ev.clientY));
      this._bind(sfx);
    }
    const o = new CSS2DObject(el);
    o.position.set(pos[0], pos[1], pos[2]);
    parent.add(o);
    for (const [sfx] of live) if (!this.anchors.get(sfx)) this.anchors.set(sfx, o);
    return o;
  }

  _bind(sfx) { if (sfx) this.bound.add(this.prefix + sfx); }

  // ---- airflow ----------------------------------------------------------------

  _buildAir() {
    this.air = new AirFlow(TIERS[this.tier]?.air ?? TIERS.high.air);
    this.scene.add(this.air.points);
    // in the scene, not the unit: it carries the unit's mirror itself
    this.air.points.scale.x = this.handSign;
    this.airMix = { oa: 1 };
  }

  /**
   * Damper-driven split of the stream: outside air, recirculated, relieved.
   * Each leg follows its OWN damper, as a fraction of open, and only while that
   * damper reads live — a damper the unit has but cannot read moves no air, and
   * one that reads shut moves none either. Air never leaves through a closed
   * damper, and the split changes with how far each one is open.
   */
  _shares() {
    const hasRet = this.inv.hasRet && this.mixSec;
    if (!hasRet) return { oa: 1, rec: 0, rel: 0 };
    // undefined = this unit has no such damper; null = it has one, not live.
    const frac = (sym) => {
      if (!sym) return undefined;
      const v = this._num(sym);
      return Number.isFinite(v) ? clamp(v / 100, 0, 1) : null;
    };
    const oaD = frac(this.inv.oad), raD = frac(this.inv.rad), eaD = frac(this.inv.ead);
    // A damper this nearly shut passes nothing worth drawing (blade leakage).
    const SHUT = 0.02;
    // How much of the stream is outside air stays the OA damper's to set.
    let oa;
    if (oaD != null) oa = oaD;
    else if (raD != null) oa = 1 - raD;
    else oa = clamp(this.airMix.oa, 0, 1);
    if (oaD != null && oaD <= SHUT) oa = 0;          // shut: no outside air in
    let rec = 1 - oa;
    if (raD != null && raD <= SHUT) rec = 0;         // shut: nothing recirculates
    // Relief leaves through its own damper, scaled by how far it is open —
    // shut, or not readable at all, and nothing goes that way.
    const relPath = !!this.inv.ead && (this.econSec || this.swap);
    const rel = relPath && eaD != null && eaD > SHUT ? oa * eaD : 0;
    return { oa, rec, rel };
  }

  /**
   * Current 3D polylines for each airflow path (they follow the exploded parts
   * and the chosen layout). Points are [x, y, z]; y and z jitter spreads the
   * stream across the cabinet, and a segment that runs up or through the back
   * wall spreads along the section instead (vw).
   */
  _paths() {
    const secs = this.sections;
    const first = secs[0].group.position.x - secs[0].w / 2;
    const lastS = secs[secs.length - 1];
    const last = lastS.group.position.x + lastS.w / 2;
    const y = this.DH / 2;
    const L = this.layout;
    const out = {};
    // a point outside a face of the section centred at x (unit coordinates)
    const outside = (x, face, oy = 0, oz = 0) => ({
      roof: [x, oy + this.DH + ABOVE, oz], floor: [x, oy - 0.25, oz],
      back: [x, oy + y, oz - this.D / 2 - ABOVE], front: [x, oy + y, oz + this.D / 2 + ABOVE]
    }[face]);
    if (this.swap && this.mixSec) {
      // outside air straight in the end; return through the side module
      const mx = this.mixSec.group.position.x;
      const m = this.retMod;
      const [oy, oz] = m.off;
      const xe = mx - this.mixSec.w / 2 + m.Lr;              // module inlet end
      out.oa = [[first - 1.6, y, 0], [last + 1.6, y, 0]];
      out.rec = [[xe + 1.6, y + oy, oz], [mx, y + oy, oz], [mx, y, 0], [last + 1.6, y, 0]];
      out.rec.vw = this.mixSec.w - 0.5;
      if (this.inv.ead) {
        out.rel = [[xe + 1.6, y + oy, oz], [mx, y + oy, oz], outside(mx, m.outer, oy, oz)];
        out.rel.vw = this.mixSec.w - 0.5;
      }
      out.rec.retLegs = 2; if (out.rel) out.rel.retLegs = 3;
    } else if (this.inv.hasRet && this.mixSec) {
      const mx = this.mixSec.group.position.x;
      const retIn = secs.find((s) => s.kind === 'retin');
      const rx = retIn ? retIn.group.position.x : first;
      const start = L.ret !== 'end' && retIn ? [outside(rx, L.ret), [rx, y, 0]] : [[first - 1.6, y, 0]];
      out.oa = [outside(mx, L.oa), [mx, y, 0], [last + 1.6, y, 0]];
      out.oa.vw = this.mixSec.w - 0.5;
      out.oa.oaLegs = 1;
      out.rec = [...start, [last + 1.6, y, 0]];
      out.rec.vw = retIn ? retIn.w - 0.3 : 0.8;
      if (this.econSec) {
        const ex = this.econSec.group.position.x;
        out.rel = [...start, [ex, y, 0], outside(ex, L.relief)];
        out.rel.vw = this.econSec.w - 0.5;
      }
    } else {
      out.oa = [[first - 1.6, y, 0], [last + 1.6, y, 0]];
    }
    for (const k of Object.keys(out)) {
      const pts = out[k];
      let len = 0;
      const seg = [];
      for (let i = 1; i < pts.length; i++) {
        const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
        seg.push(l); len += l;
      }
      out[k] = { pts, seg, L: len, vw: pts.vw || 0.8, oaLegs: pts.oaLegs || 0, retLegs: pts.retLegs || 0, k: pts.k || null };
    }
    return out;
  }

  /** Temperature of the air at x, stepping at each station downstream of `base`. */
  _tempAt(x, base) {
    const st = this.tempStations || [];
    let t = base;
    for (const s of st) if (x >= s.x) t = s.t; else break;
    return t;
  }

  // ------------------------------------------------------------------------
  // Values → targets
  // ------------------------------------------------------------------------

  _num(sfx) {
    if (!sfx) return NaN;
    const p = this.resolve(sfx);
    if (!p || p.value == null) return NaN;
    const v = typeof p.value === 'boolean' ? (p.value ? 1 : 0) : Number(p.value);
    return Number.isFinite(v) ? v : NaN;
  }

  _refreshValues() {
    this.dirty = false;
    const n = (s) => this._num(s);
    for (const d of this.parts.dampers) d.target = clamp(n(d.suffix) || 0, 0, 100);
    for (const c of this.parts.coils) c.target = clamp(n(c.suffix) || 0, 0, 100);
    for (const f of this.parts.fans) {
      const run = n(f.run);
      const spd = f.spd ? n(f.spd) : NaN;
      const on = f.run === f.spd ? spd > 0 : run > 0;
      f.fault = f.flt ? n(f.flt) > 0 : false;
      f.target = on && !f.fault ? (Number.isFinite(spd) ? clamp(spd, 8, 100) : 100) : 0;
    }
    for (const fl of this.parts.filters) fl.target = fl.suffix && n(fl.suffix) > 0 ? 1 : 0;
    for (const h of this.parts.hums) {
      const cmd = h.hum.cmd ? n(h.hum.cmd) : 1;
      const out = h.hum.out ? n(h.hum.out) : (cmd > 0 ? 100 : 0);
      h.target = cmd > 0 ? clamp(out || 0, 0, 100) / 100 : 0;
    }
    // readouts
    for (const t of this.tags) {
      const p = this.resolve(t.sfx);
      let txt = '--', on = false;
      const dead = !p || p.value == null;
      t.row.classList.toggle('a3-notlive', dead);
      t.row.dataset.st = dead ? (p?.status || 'nodata') : '';
      if (dead) {
        txt = p?.label || (this.playback ? 'no trend' : 'waiting');
        t.row.title = p?.why || '';
        t.row.classList.remove('a3-manual');
      } else if (p) {
        const v = p.value;
        if (t.unit === 'fans') {
          let run = 0, sum = 0, cnt = 0;
          for (const f of t.fans) {
            const sp = f.spd ? this._num(f.spd) : NaN;
            const r = f.run === f.spd ? sp > 0 : this._num(f.run) > 0;
            if (r) run++;
            if (Number.isFinite(sp)) { sum += sp; cnt++; }
          }
          on = run > 0;
          txt = `${run}/${t.fans.length} ON${cnt ? ` · ${Math.round(sum / cnt)}%` : ''}`;
        } else if (t.unit === 'onoff') { on = !!Number(v); txt = on ? 'ON' : 'OFF'; }
        else if (t.unit === 'alm') { on = !!Number(v); txt = on ? 'ALARM' : 'NORMAL'; }
        else if (t.unit === 'state') txt = (t.states && t.states[Math.round(Number(v))]) || String(v);
        else if (typeof v === 'number') txt = `${Math.abs(v) >= 100 || t.unit === '%' ? Math.round(v) : v.toFixed(1)}${t.unit === '%' ? '%' : ` ${t.unit}`}`;
        else txt = String(v);
        t.row.classList.toggle('a3-manual', p.status === 'manual');
        t.row.title = p.status === 'manual' ? (p.why || 'Manual override') : 'Click to command';
      }
      t.el.textContent = txt;
      t.row.classList.toggle('a3-on', on && (t.unit === 'onoff' || t.unit === 'fans'));
      t.row.classList.toggle('a3-alarm', on && t.unit === 'alm');
    }
    this._refreshExtra();
    this._refreshAir();
    this._hudValues();
    if (this.playback) { this._sparklines(); this.onValues?.(); }
    this._refreshDevices?.();
  }


  /** Kind-specific parts (wheels, pumps, burners) read their targets here. */
  _refreshExtra() {}

  /**
   * Air temperatures along the unit → tempStations (for the particles and the
   * coil physics) and vals (oat/rat). Other unit families override this.
   */
  _refreshAir() {
    const n = (s) => this._num(s);
    // air temperatures along the unit
    const oat = n('OAT'), rat = n('RAT'), mat = n(this.inv.mat), sat = n('SAT');
    const oadPct = n(this.inv.oad);
    this.airMix.oa = this.inv.oad ? (Number.isFinite(oadPct) ? oadPct / 100 : 0.3) : (this.inv.hasRet ? 0 : 1);
    const v = this.vals = {
      oat: Number.isFinite(oat) ? oat : 70,
      rat: Number.isFinite(rat) ? rat : 72
    };
    const mixT = Number.isFinite(mat) ? mat : v.oat * this.airMix.oa + v.rat * (1 - this.airMix.oa);
    v.mix = mixT;
    const st = [];
    let cur = mixT;
    const coilSecs = this.sections.filter((s) => s.kind === 'coil');
    const lastCoil = coilSecs[coilSecs.length - 1];
    for (const s of this.sections) {
      const x = s.group.position.x;
      // the two streams keep their own colour into the box and blend across its downstream half
      if (s.kind === 'mix') st.push({ x: x + s.w * 0.3, t: cur, key: 'mix', sec: s, dx: s.w * 0.3 });
      if (s.kind === 'coil') {
        const lt = n(s.t);
        const pct = n(s.v) || 0;
        if (Number.isFinite(lt)) cur = lt;
        else if (s === lastCoil && Number.isFinite(sat)) cur = sat;
        else cur = cur + (s.heat ? 1 : -1) * pct * 0.18;
        st.push({ x, t: cur, sec: s });
      }
      if (s.kind === 'discharge' && Number.isFinite(sat)) st.push({ x: x - s.w / 2, t: sat, sec: s, dx: -s.w / 2 });
    }
    this.tempStations = st;
    this._coilPhysics(st);
    this._thermalPhysics();
  }

  /**
   * Is each coil wet, frosted, or neither? Dew point of the air reaching it
   * (from whatever RH is measured) against the coil's surface temperature.
   */
  _coilPhysics(st) {
    const n = (s) => this._num(s);
    const f = this.airMix.oa;
    const dpOA = dewPointF(n('OAT'), n(pick(this.has, ['OAH', 'OARH', 'OA.RH'])));
    const dpRA = dewPointF(n('RAT'), n(pick(this.has, ['RAH', 'RA.RH'])));
    const dpRM = dewPointF(n(pick(this.has, ['RMT', 'RMS', 'SPC.TMP', 'ZNT'])), n(pick(this.has, ['RMH', 'SPC.HUM', 'ZNH'])));
    let dp = NaN;
    if (Number.isFinite(dpOA) && Number.isFinite(dpRA)) dp = dpOA * f + dpRA * (1 - f);
    else dp = [dpRA, dpRM, dpOA].find(Number.isFinite);
    this.dewAssumed = !Number.isFinite(dp);
    this.dew = Number.isFinite(dp) ? dp : 55;       // no RH measured: assume a typical 55°F
    const coilSecs = this.sections.filter((s) => s.kind === 'coil');
    for (const c of this.parts.coils) {
      const sec = coilSecs.find((s) => s.v === c.suffix);
      const idx = st.findIndex((x) => x.sec === sec);
      const leave = idx >= 0 ? st[idx].t : NaN;
      const enter = idx > 0 ? st[idx - 1].t : this.vals.mix;
      const pct = n(c.suffix) || 0;
      if (!c.heat) {
        const surf = Number.isFinite(leave) ? leave - 2 : NaN;
        c.wetT = pct > 3 && Number.isFinite(surf) ? clamp((this.dew - surf) / 3, 0, 1) : 0;
        c.frostT = pct > 3 && Number.isFinite(surf) ? clamp((32 - surf) / 5, 0, 1) : 0;
      } else {
        // a heating coil ices when below-freezing air reaches it with the valve shut
        c.wetT = 0;
        c.frostT = Number.isFinite(enter) && pct < 10 ? clamp((32 - enter) / 6, 0, 1) : 0;
      }
    }
  }

  /** Mixing-box stratification: how cold the floor layer runs. */
  _thermalPhysics() {
    this.thermal = null;
    if (!this.mixSec || !this.inv.oad || !this.inv.hasRet) return;
    const f = this.airMix.oa;
    // whichever stream is colder is denser and pools on the floor
    const oaCold = this.vals.oat <= this.vals.rat;
    const cold = Math.min(this.vals.oat, this.vals.rat), warm = Math.max(this.vals.oat, this.vals.rat);
    const fc = oaCold ? f : 1 - f;                      // share of the cold stream
    const spread = warm - cold;
    // running fans always stir some; a big spread and low airflow stratify
    const mix = clamp(0.2 + 0.6 * (this.flow || 0) - spread / 90, (this.flow || 0) > 0.15 ? 0.25 : 0, 1);
    const amt = spread >= 8 && f > 0.05 ? clamp((spread - 8) / 15, 0.35, 1) : 0;
    const matv = this._num(this.inv.mat);
    const mean = Number.isFinite(matv) ? matv : cold * fc + warm * (1 - fc);
    const floor = cold * (1 - mix) + mean * mix;
    this.thermal = { cold, warm, layer: clamp(0.1 + fc * 0.75, 0.08, 0.85), mix, amt, floor };
    if (this.thermalTag) {
      const on = amt > 0 && this.fx.thermal;
      this.thermalTag.element.hidden = !on;
      if (on) {
        this.thermalTag.element.querySelector('.a3-v').textContent = `≈ ${floor.toFixed(0)} °F`;
        this.thermalTag.element.classList.toggle('a3-risk', floor < 38);
        this.thermalTag.element.querySelector('.a3-k').textContent = floor < 38 ? 'FLOOR · FREEZESTAT RISK' : 'FLOOR LAYER';
      }
    }
  }

  /** Per-frame effects: stratification volume, control-loop pulses, mode tint. */
  _frameFx(dt, now) {
    const t = now / 1000;
    if (this.strat) {
      const th = this.thermal;
      const on = th && this.fx.thermal && TIERS[this.tier].strat > 0;
      this.strat.update(this.camera, {
        time: t, cold: th ? th.cold : 60, warm: th ? th.warm : 70, layer: th ? th.layer : 0.3,
        mix: th ? th.mix : 1, flow: this.flow || 0, amt: on ? th.amt : 0
      });
    }
    if (this.links3d) {
      this.links3d.group.visible = this.fx.loops && this.links3d.items.length > 0;
      if (this.links3d.group.visible) {
        const hov = this.hoverPts;
        this.links3d.update(t, (it) => {
          const v = this._num(it.to);
          const prev = it.last;
          it.last = v;
          if (!Number.isFinite(v) || prev === undefined) return 0.3;
          // a loop that is moving its output pulses faster and brighter
          it.moving = damp(it.moving || 0, Math.abs(v - prev) > 0.05 ? 1 : 0, 2, dt);
          return 0.25 + 0.75 * it.moving;
        }, hov ? (it) => hov.includes(it.to) || hov.includes(it.from) : null);
      }
    }
    // mode tint: dimmer and cooler when unoccupied, a red pulse on a safety trip
    const alarm = (this.modes || []).some((m) => m.bad && m.el.classList.contains('on'));
    const occ = this.modes && this.modes.find((m) => m.occ);
    const unocc = !!occ && !occ.el.classList.contains('on');
    const pulse = alarm ? 0.5 + 0.5 * Math.sin(now / 260) : 0;
    this.rim.color.set(alarm ? '#ff3b2a' : '#57d6ff');
    this.rim.intensity = damp(this.rim.intensity, alarm ? 0.6 + 1.6 * pulse : 0.9, 4, dt);
    this.hemi.intensity = damp(this.hemi.intensity, unocc ? 0.18 : 0.35, 2, dt);
    this.renderer.toneMappingExposure = damp(this.renderer.toneMappingExposure, unocc ? 0.78 : 0.95, 2, dt);
  }

  // ------------------------------------------------------------------------
  // Quality tiers
  // ------------------------------------------------------------------------

  _guessTier() {
    const nav = typeof navigator === 'object' ? navigator : {};
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if ((nav.deviceMemory && nav.deviceMemory <= 4) || (nav.hardwareConcurrency && nav.hardwareConcurrency <= 4) || coarse) return 'medium';
    return 'high';
  }

  _applyTier() {
    const T = TIERS[this.tier];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, T.pixel));
    this.renderer.shadowMap.enabled = T.shadows;
    this.key.castShadow = T.shadows;
    if (this.bloom) this.bloom.enabled = T.bloom;
    this.air.setCount(T.air);
    this._buildStrat();
    if (this.labels) this._resize();
    this._syncOptionsUI();
  }

  /** Rebuild the stratification volume at the tier's step count. */
  _buildStrat() {
    if (this.strat) { this.strat.mesh.parent?.remove(this.strat.mesh); this.strat.dispose(); this.strat = null; }
    if (this.thermalTag) {
      this.thermalTag.element.remove();
      this.thermalTag.parent?.remove(this.thermalTag);
      this.thermalTag = null;
    }
    const steps = TIERS[this.tier].strat;
    const m = this.mixSec;
    if (!m || !this.inv.oad || !this.inv.hasRet) return;
    // the floor-layer readout exists on every tier; the volume only when affordable
    const el = document.createElement('div');
    el.className = 'a3-tag a3-thermal';
    el.innerHTML = '<div class="a3-row"><span class="a3-k">FLOOR LAYER</span><span class="a3-v">--</span></div>';
    el.hidden = true;
    const tag = new CSS2DObject(el);
    tag.position.set(0.45, this.DH * 0.62, this.D / 2 + 0.15);
    m.group.add(tag);
    this.thermalTag = tag;
    if (!steps) return;
    this.strat = new Stratification(m.w - 0.12, this.DH - 0.14, this.D - 0.14, steps);
    this.strat.mesh.position.y = this.DH / 2;
    m.group.add(this.strat.mesh);
  }

  /** Step down a tier when frames run long for a few seconds (auto only). */
  _watchFps(now) {
    const F = this._frames;
    if (!F.since) { F.since = now; F.prev = now; return; }
    const ms = now - F.prev;
    F.prev = now;
    if (ms > 1500) return;                // tab switch or a stall, not load
    F.n++; F.ms += ms;
    if (now - F.since < 2000) return;
    const avg = F.ms / F.n;
    F.n = 0; F.ms = 0; F.since = now;
    this.fps = 1000 / avg;
    if (this.fpsEl) this.fpsEl.textContent = `${Math.round(this.fps)} fps`;
    if (this.quality !== 'auto') return;
    F.slow = avg > 1000 / 45 ? F.slow + 1 : 0;
    const i = TIER_ORDER.indexOf(this.tier);
    if (F.slow >= 2 && i < TIER_ORDER.length - 1) {
      this.tier = TIER_ORDER[i + 1];
      F.slow = 0;
      this._applyTier();
    }
  }

  /** The casing finish for this browser: 'clear' (default) or 'grey'. */
  _loadCasing() { let v = null; try { v = localStorage.getItem('cv_ahu_casing'); } catch { /* default */ } return v === 'grey' ? 'grey' : 'clear'; }

  /** Switch the casing finish, remember it in this browser, rebuild the unit. */
  setCasing(v) {
    const c = v === 'grey' ? 'grey' : 'clear';
    if (c === this.casing) return;
    this.casing = c;
    try { localStorage.setItem('cv_ahu_casing', c); } catch { /* this visit only */ }
    if (this.unit && !this.embedded) this._rebuildUnit();
    this._syncOptionsUI();
  }

  _loadPref(k, d) { try { return localStorage.getItem(`cv_ahu3d_${k}`) || d; } catch { return d; } }
  _savePref(k, v) { try { localStorage.setItem(`cv_ahu3d_${k}`, v); } catch { /* per-session only */ } }

  // ------------------------------------------------------------------------
  // Control links from the program
  // ------------------------------------------------------------------------

  /** @param {Array<{from:string,to:string,kind:string}>} links  full point names */
  setLinks(links) {
    this.links = links || [];
    this._buildLinks();
  }

  _buildLinks() {
    if (!this.links3d) return;
    const sfxOf = (full) => {
      const f = String(full);
      if (this.prefix && f.toUpperCase().startsWith(this.prefix.toUpperCase())) return f.slice(this.prefix.length);
      const segs = f.split('.');
      for (let i = 1; i < segs.length; i++) {
        const s = segs.slice(i).join('.');
        if (this.anchors.get(s)) return s;
      }
      return null;
    };
    // Programs chain loops through virtual points (SAT -> LOOP -> VRT ->
    // TABLE -> CCV). Collapse each chain so the pulse runs from the real
    // sensor to the real device, skipping the in-between calculation points.
    const out = new Map();
    for (const l of this.links) {
      const k = String(l.from).toUpperCase();
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(l.to);
    }
    const drawn = (full) => { const s = sfxOf(full); return s && this.anchors.get(s) ? s : null; };
    const pairs = [], seen = new Set();
    for (const start of new Set(this.links.map((l) => l.from))) {
      const from = drawn(start);
      if (!from) continue;
      const stack = [[start, 0]], visited = new Set([String(start).toUpperCase()]);
      while (stack.length) {
        const [node, depth] = stack.pop();
        for (const nx of out.get(String(node).toUpperCase()) || []) {
          const key = String(nx).toUpperCase();
          if (visited.has(key)) continue;
          visited.add(key);
          const to = drawn(nx);
          if (to) {
            const a = this.anchors.get(from), b = this.anchors.get(to);
            const id = `${from}>${to}`;
            if (a !== b && !seen.has(id)) { seen.add(id); pairs.push({ a, b, from, to }); }
          } else if (depth < 4) stack.push([nx, depth + 1]);
        }
      }
    }
    this.links3d.build(pairs);
  }

  // ------------------------------------------------------------------------
  // Trend playback
  // ------------------------------------------------------------------------

  /**
   * Replay trend logs through the unit.
   * @param {Map<string,{t:number[],v:number[]}>} bySuffix  series keyed by point suffix
   * @param {string} label
   */
  startPlayback(bySuffix, label) {
    let t0 = Infinity, t1 = -Infinity;
    for (const s of bySuffix.values()) {
      if (!s.t.length) continue;
      t0 = Math.min(t0, s.t[0]); t1 = Math.max(t1, s.t[s.t.length - 1]);
    }
    if (!Number.isFinite(t0)) return false;
    // start where most trends overlap: the latest first-sample
    let start = t0;
    for (const s of bySuffix.values()) if (s.t.length) start = Math.max(start, Math.min(s.t[0], t1 - 3600e3));
    this.playback = { series: bySuffix, t0, t1, t: start, playing: true, speed: 600, label };
    this._pbBar();
    this.dirty = true;
    return true;
  }

  stopPlayback() {
    this.playback = null;
    const eb = this.hudEl?.querySelector('.a3-eyebrow');
    if (eb) eb.textContent = `${this.eyebrow} · live`;
    this.pbEl?.remove();
    this.pbEl = null;
    for (const t of this.tags) t.row.querySelector('.a3-spark')?.remove();
    this.dirty = true;
  }

  _pbPoint(sfx) {
    const s = this.playback.series.get(sfx);
    if (!s) return null;
    const v = valueAt(s, this.playback.t);
    return Number.isFinite(v) ? { value: v, status: 'normal', type: s.digital ? 'LDO' : 'LAO' } : null;
  }

  _pbBar() {
    this.pbEl?.remove();
    const pb = this.playback;
    const el = document.createElement('div');
    el.className = 'a3-pb';
    el.innerHTML = `
      <button class="a3-pb-play" aria-label="Play or pause">❚❚</button>
      <div class="a3-pb-mid">
        <div class="a3-pb-top"><span class="a3-pb-lbl"></span><span class="a3-pb-time"></span></div>
        <input class="a3-pb-range" type="range" min="0" max="100000" step="1" aria-label="Playback time">
        <canvas class="a3-pb-strip" height="18"></canvas>
      </div>
      <select class="a3-pb-speed" aria-label="Playback speed">
        <option value="60">1 min/s</option><option value="600" selected>10 min/s</option>
        <option value="3600">1 hr/s</option><option value="14400">4 hr/s</option>
      </select>
      <button class="a3-pb-x" title="Back to live">Live</button>`;
    el.querySelector('.a3-pb-lbl').textContent = `PLAYBACK · ${pb.label}`;
    const eb = this.hudEl?.querySelector('.a3-eyebrow');
    if (eb) eb.textContent = `${this.eyebrow} · trend playback`;
    this.host.appendChild(el);
    this.pbEl = el;
    const play = el.querySelector('.a3-pb-play');
    play.addEventListener('click', () => {
      if (pb.t >= pb.t1) pb.t = pb.t0;
      pb.playing = !pb.playing;
      this._pbUi();
    });
    const range = el.querySelector('.a3-pb-range');
    range.addEventListener('input', () => {
      pb.t = pb.t0 + (pb.t1 - pb.t0) * (Number(range.value) / 100000);
      this.dirty = true;
      this._pbUi();
    });
    el.querySelector('.a3-pb-speed').addEventListener('change', (e) => { pb.speed = Number(e.target.value); });
    el.querySelector('.a3-pb-x').addEventListener('click', () => this.onStopPlayback ? this.onStopPlayback() : this.stopPlayback());
    this._pbStrip();
    this._pbUi();
  }

  /** Mode bands under the scrubber: occupied / fan / dehum at a glance. */
  _pbStrip() {
    const pb = this.playback, cv = this.pbEl?.querySelector('.a3-pb-strip');
    if (!cv) return;
    const w = cv.clientWidth || 400;
    cv.width = w;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, 18);
    const lanes = [[pick(this.has, ['OCC.MOD', 'OCC']), '#2f7a4e'], [this.inv?.fans?.[0] ? runSuffix(this.has, this.inv.fans[0]) : null, '#46d3e6'],
      [pick(this.has, ['UNOC.DEHUM.MODE', 'DEHUM.MODE', 'DEHUM']), '#e8a665']].filter(([s]) => s && pb.series.get(s));
    const lh = lanes.length ? 18 / lanes.length : 18;
    lanes.forEach(([sfx, col], i) => {
      const s = pb.series.get(sfx);
      g.fillStyle = col;
      for (let x = 0; x < w; x++) {
        const t = pb.t0 + ((pb.t1 - pb.t0) * x) / w;
        if (valueAt(s, t) > 0) g.fillRect(x, i * lh + 1, 1, lh - 2);
      }
    });
  }

  _pbUi() {
    const pb = this.playback, el = this.pbEl;
    if (!pb || !el) return;
    el.querySelector('.a3-pb-play').textContent = pb.playing ? '❚❚' : '▶';
    const r = el.querySelector('.a3-pb-range');
    if (document.activeElement !== r) r.value = String(Math.round(((pb.t - pb.t0) / (pb.t1 - pb.t0 || 1)) * 100000));
    const d = new Date(pb.t);
    el.querySelector('.a3-pb-time').textContent = d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  /** The last two hours of each trended readout, drawn inside its row. */
  _sparklines() {
    const pb = this.playback;
    const span = 2 * 3600e3;
    for (const t of this.tags) {
      const s = pb.series.get(t.sfx);
      let cv = t.row.querySelector('.a3-spark');
      if (!s || t.unit === 'fans') { cv?.remove(); continue; }
      if (!cv) {
        cv = document.createElement('canvas');
        cv.className = 'a3-spark'; cv.width = 56; cv.height = 14;
        t.row.insertBefore(cv, t.el);
      }
      const g = cv.getContext('2d');
      g.clearRect(0, 0, 56, 14);
      const vals = [];
      for (let i = 0; i < 56; i++) vals.push(valueAt(s, pb.t - span + (span * i) / 55));
      const fin = vals.filter(Number.isFinite);
      if (!fin.length) continue;
      let lo = Math.min(...fin), hi = Math.max(...fin);
      if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
      g.strokeStyle = 'rgba(111,227,242,0.9)'; g.lineWidth = 1.2;
      g.beginPath();
      vals.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const y = 13 - ((v - lo) / (hi - lo)) * 12;
        if (i === 0) g.moveTo(i, y); else g.lineTo(i, y);
      });
      g.stroke();
      g.fillStyle = '#fff';
      g.fillRect(54, 13 - ((fin[fin.length - 1] - lo) / (hi - lo)) * 12 - 1, 2, 2);
    }
  }


  // ------------------------------------------------------------------------
  // Frame loop
  // ------------------------------------------------------------------------

  _frame(now) {
    if (!this.scene) return;
    const dt = Math.max(0, Math.min(0.05, (now - this._last) / 1000));   // a frame stamped before the last one must not run the easing backwards
    this._last = now;
    // skip work while the Graphic tab is hidden
    if (!this.host.isConnected || this.host.offsetParent === null || document.hidden) return;
    if (this.playback && this.playback.playing) {
      const pb = this.playback;
      pb.t = Math.min(pb.t1, pb.t + dt * 1000 * pb.speed);
      if (pb.t >= pb.t1) pb.playing = false;
      this.dirty = true;
      this._pbUi();
    }
    if (this.dirty && now - this._lastValues > 180) { this._lastValues = now; this._refreshValues(); }
    this._watchFps(now);

    // explode
    this.explode = damp(this.explode, this.explodeTarget, 5, dt);
    const e = this.explode;
    const mid = this.exMid ?? (this.sections.length - 1) / 2;
    for (const s of this.sections) {
      s.group.position.x = s.baseX + ((s.ex ?? s.i) - mid) * GAP * e;
      for (const sk of s.skins || []) sk.material.opacity = (sk.userData.op ??= sk.material.opacity) * (1 - e);
    }
    // temperature stations ride along with their (exploding) sections
    if (this.tempStations) for (const st of this.tempStations) if (st.sec) st.x = st.sec.group.position.x + (st.dx || 0);

    // parts
    this._animateParts(dt, now);

    // air
    this.air.points.visible = this.showAir;
    if (this.showAir && this.vals) this._updateAir(dt, now);

    this._frameFx(dt, now);

    // camera tween + controls
    if (this._camTween) {
      const t = this._camTween;
      t.k = Math.min(1, t.k + dt * 1.4);
      const s = t.k * t.k * (3 - 2 * t.k);
      this.camera.position.lerpVectors(t.p0, t.p1, s);
      this.controls.target.lerpVectors(t.t0, t.t1, s);
      if (t.k >= 1) this._camTween = null;
    }
    this.controls.update();
    this.composer.render();
    if (this.showLabels) { this.labels.render(this.scene, this.camera); this._clearHud(); }
  }

  /** Move every part toward its target and settle the stream speed (this.flow). */
  _animateParts(dt, now) {
    for (const d of this.parts.dampers) {
      d.pos = damp(d.pos, d.target ?? 0, 3, dt);
      const a = (1 - d.pos / 100) * Math.PI / 2 * 0.95;
      for (const b of d.blades) b.rotation.z = b.userData.dir * a;
    }
    for (const c of this.parts.coils) {
      c.pct = damp(c.pct, c.target ?? 0, 2.5, dt);
      const k = c.pct / 100;
      c.mats[0].emissiveIntensity = k * (c.heat ? 0.9 : 1.5);
      c.mats[1].emissiveIntensity = k * (c.heat ? 1.6 : 2.2);
      c.wet = damp(c.wet, c.wetT ?? 0, 0.6, dt);        // coils wet and dry slowly
      c.frost = damp(c.frost, c.frostT ?? 0, 0.3, dt);
      c.fx.uFlow.value = k;
      c.fx.uWet.value = c.wet;
      c.fx.uFrost.value = c.frost;
      c.fx.uTime.value = now / 1000;
      if (c.pan) c.pan.material.opacity = c.wet * 0.55;
    }
    let fanSum = 0, fanN = 0;
    for (const f of this.parts.fans) {
      f.speed = damp(f.speed, f.target ?? 0, 1.4, dt);
      f.wheel.rotation.x += f.dir * dt * (f.speed / 100) * Math.PI * 2 * 3.2;
      f.band.material.emissive.set(f.fault ? '#ff3b2a' : '#46d3e6');
      f.band.material.emissiveIntensity = f.fault ? 2 : (f.speed / 100) * 2.2;
      if (f.dir > 0) { fanSum += f.speed; fanN++; }
    }
    const blink = 0.5 + 0.5 * Math.sin(now / 220);
    for (const fl of this.parts.filters) fl.mat.emissiveIntensity = fl.target ? 0.35 + 0.5 * blink : 0;
    for (const h of this.parts.hums) {
      h.level = damp(h.level, h.target ?? 0, 2, dt);
      h.mat.emissiveIntensity = 0.15 + h.level * 0.9;
    }
    this._frameParts(dt, now);

    const flow = this._flowTarget(fanSum, fanN);
    this.flow = damp(this.flow || 0, flow, 1.5, dt);
    this._animateDevices?.(dt, now);
  }

  // ------------------------------------------------------------------------
  // Embedded: the unit built into someone else's scene (the Buildings twin)
  // ------------------------------------------------------------------------

  /**
   * Build this unit's model into `parent` (a THREE.Group in another scene) with
   * no renderer, HUD, bench or airflow of its own. The host calls tick() each
   * frame and update() when values change; readouts are CSS2D objects the host
   * shows or hides (tagObjects()).
   * @returns {THREE.Group} the unit group
   */
  embed(parent, prefix, has, resolve, materials = null) {
    this.embedded = true;
    // the same opening choices as its unit page: saved on the unit (config.layout3d)
    const L = { ...this.layout, ...(this.config?.layout3d || {}) };
    const FACES = ['roof', 'back', 'front', 'floor'];
    if (!FACES.includes(L.oa)) L.oa = 'roof';
    if (!FACES.includes(L.relief)) L.relief = 'roof';
    if (!['end', ...FACES].includes(L.ret)) L.ret = 'end';
    L.swap = !!L.swap;
    if (L.hand !== 'left') L.hand = 'right';
    this.layout = L;
    this.prefix = prefix;
    this.has = has;
    this._resolveLive = resolve;
    this.resolve = (sfx) => this._resolveLive(sfx);
    this.bound = new Set();
    this.tier = 'low';
    this.airMix = { oa: 1 };
    this.scene = parent;                 // _buildUnit adds the unit group to it
    if (materials) this.m = materials; else this._materials();
    this._buildUnit();
    this._afterBuild?.();
    this._refreshValues();
    this._lastValues = performance.now();
    return this.unit;
  }

  /** Embedded frame: values (throttled) and part motion; the host renders. */
  tick(dt, now) {
    if (this.dirty && now - this._lastValues > 250) { this._lastValues = now; this._refreshValues(); }
    this._animateParts(dt, now);
    if (this.vals && this.showAir !== false) this._updateAir(dt, now);   // the low-cost stream, live only
  }

  /** The readouts and section captions pinned to this unit. */
  tagObjects() {
    const out = [];
    this.unit?.traverse((o) => { if (o.isCSS2DObject) out.push(o); });
    return out;
  }

  /** Is anything on the unit moving air or water right now? */
  isRunning() {
    const p = this.parts;
    return p.fans.some((f) => (f.target || 0) > 0) || p.pumps.some((x) => (x.target || 0) > 0) ||
      p.wheels.some((w) => (w.target || 0) > 0) || p.burners.some((b) => (b.target || 0) > 0);
  }

  /** Does any fan / pump / wheel / burner report a fault? */
  hasFault() {
    const p = this.parts;
    return [...p.fans, ...p.pumps, ...p.wheels, ...p.burners].some((x) => x.fault);
  }

  /** Stream speed 0..1 from the supply fans; families without fans override. */
  _flowTarget(fanSum, fanN) { return fanN ? fanSum / fanN / 100 : 0; }

  /** Per-frame motion of kind-specific parts (wheels, pumps, burners). */
  _frameParts(dt, now) {}

  _updateAir(dt, now) {
    // live-only: with no air proven moving (fans, damper, airflow all read from
    // live points) the stream is not drawn at all
    if (!((this.flow || 0) > 0.02)) { if (this.air) this.air.points.visible = false; return; }
    if (!this.air) {
      // embedded (the building twin): the low-cost stream, made the first time air is proven moving
      if (!this.embedded || !this.unit) return;
      this.air = new AirFlow(0);
      this.unit.add(this.air.points); // inside the unit: the unit's matrix mirrors it
      this.air.points.scale.x = 1;
    }
    if (this.embedded) this.air.points.visible = true;
    const secs = this.sections;
    const first = secs[0].group.position.x - secs[0].w / 2;
    const lastS = secs[secs.length - 1];
    const last = lastS.group.position.x + lastS.w / 2;
    const filters = [], calm = [];
    for (const s of secs) {
      const x = s.group.position.x;
      // filters and coils straighten the stream
      if (s.kind === 'filter' || s.kind === 'coil') calm.push({ x0: x - s.w / 2, x1: x + s.w / 2 });
      if (s.kind !== 'filter' || !s.f) continue;
      const alm = s.f.alm ? this._num(s.f.alm) > 0 : false;
      const dp = s.f.dp ? this._num(s.f.dp) : NaN;
      // a filter at ~1 inWC (or in alarm) is loaded; clean media barely slows the air
      const load = alm ? 1 : Number.isFinite(dp) ? clamp((dp - 0.3) / 0.9, 0, 1) : 0;
      filters.push({ x: x - s.w / 2, load });
    }
    const fanZones = [];
    for (const s of secs) {
      if (s.kind !== 'fans' && s.kind !== 'retfans') continue;
      fanZones.push({ x: s.group.position.x + 0.3, str: 0.4 + 0.6 * (this.flow || 0) });
    }
    // the fan-wall openings, in the unit frame (sections slide when exploded)
    const fanHoles = [];
    for (const fh of this.fanHoles || []) {
      if (!this.sections.some((s) => s.group === fh.g)) continue;     // a return module's wall: not on the main stream
      for (const o of fh.holes) fanHoles.push({ x: fh.g.position.x + fh.x, y: o.y + fh.g.position.y, z: o.z + fh.g.position.z, r: fh.r, hy: o.hy, hz: o.hz });
    }
    const T = TIERS[this.tier] || TIERS.low;
    const inUnit = this.air.points.parent === this.unit;
    // Every lane above is in the unit's own frame. Inside the unit group it is
    // carried by the unit's matrix — mirror and all. Hanging in the scene it is
    // not, so it has to be lifted (below) AND mirrored here, or a left-hand
    // unit shows its air running the wrong way down the casing.
    this.air.points.scale.x = inUnit ? 1 : this.handSign;
    this.air.update({
      dt: dt * (this.reduced ? 0.5 : 1), time: now / 1000, flow: this.flow || 0,
      paths: this._paths(), share: this._shares(),
      stations: this.tempStations, oat: this.vals.oat, rat: this.vals.rat,
      filters, fanZones, calm, fanHoles,
      // the stream necks into the duct stubs at each end (families set airNeck = null)
      neck: this.airNeck === undefined ? 0.7 : this.airNeck,
      box: this.airBox || [this.DH, this.D], span: this.airSpan || [first, last],
      lift: inUnit ? 0 : this.unit.position.y,
      opacity: (0.35 + 0.65 * Math.min(1, (this.flow || 0) * 2.5)) * Math.min(1.15, T.bright) * (this.airGain ?? 0.72)
    });
  }

  // ------------------------------------------------------------------------
  // Camera, HUD, sizing
  // ------------------------------------------------------------------------

  _presetView(name, instant = false) {
    const secs = this.sections;
    const find = (k) => secs.find((s) => s.kind === k);
    const cx = (s) => (s ? s.group.position.x : 0);
    const lift = this.unit ? this.unit.position.y : 0;
    const tall = this.tall ?? (this.DH + lift + (this.retMod && this.retFace === 'roof' ? this.DH : 0));
    let tgt, cam;
    const span = this.total + (this.explodeTarget ? secs.length * GAP : 0);
    if (name === 'intake') {
      const e = find('econ'), m = find('mix') || find('intake') || secs[0];
      const x = e ? (cx(e) + cx(m)) / 2 : cx(m);
      tgt = new THREE.Vector3(x, tall * 0.6, 0);
      cam = new THREE.Vector3(x - 4.6, tall * 1.9, 6.4);
    } else if (name === 'coils') {
      const c = secs.filter((s) => s.kind === 'coil' || s.kind === 'filter');
      const x = c.length ? (cx(c[0]) + cx(c[c.length - 1])) / 2 : 0;
      tgt = new THREE.Vector3(x, this.DH * 0.5, 0);
      cam = new THREE.Vector3(x - 2.6, this.DH * 1.3, 6.6);
    } else if (name === 'fans') {
      const s = find('fans');
      tgt = new THREE.Vector3(cx(s), this.DH * 0.5, 0);
      cam = new THREE.Vector3(cx(s) + 3.8, this.DH * 1.2, 5.4);
    } else {
      // Fit the whole unit (plus duct stubs and readouts) to the panel, which
      // on a laptop is often much narrower than it is tall.
      tgt = new THREE.Vector3(0, tall * 0.45, this.retMod && this.retMod.off[1] ? this.retMod.off[1] / 2 : 0);
      const dir = new THREE.Vector3(-0.42, 0.36, 0.83).normalize();
      const vf = THREE.MathUtils.degToRad(this.camera.fov);
      const hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspect);
      const az = Math.atan2(-dir.x, dir.z);
      const w = (span + 4.2) * Math.cos(az) + (this.D + 1.2) * Math.sin(az);
      const dist = 1.04 * Math.max((w / 2) / Math.tan(hf / 2), (tall + ABOVE + 1) / 2 / Math.tan(vf / 2), 6);
      cam = tgt.clone().addScaledVector(dir, dist);
    }
    // Section positions above are read in the model's own frame; the unit on
    // screen is mirrored when it is left-hand, so the camera mirrors with it
    // and every preset still lands on the part it names.
    if (this.handSign < 0) { tgt.x = -tgt.x; cam.x = -cam.x; }
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

  _hud() {
    const tag = this.title || this.prefix.replace(/\.$/, '').split('.').pop() || 'AHU';
    const hud = document.createElement('div');
    hud.className = 'a3-hud';
    hud.innerHTML = `
      <div class="a3-title">
        <div class="a3-eyebrow"></div>
        <div class="a3-name"></div>
        <div class="a3-honesty" hidden></div>
        <div class="a3-kpis"></div>
        <div class="a3-modes"></div>
      </div>
      <div class="a3-panel" role="toolbar" aria-label="3D view controls">
        <div class="a3-grp a3-views" aria-label="View">
          ${this.presets.map(([k, l], i) => `<button data-view="${k}"${i === 0 ? ' class="on"' : ''}>${l}</button>`).join('')}
        </div>
        <div class="a3-grp a3-shows">
          <button data-tg="labels" class="on">Readouts</button><button data-tg="air" class="on" title="Air is drawn only while a live point proves it moving">Airflow</button>
          <button data-tg="layout" class="a3-more" aria-expanded="false">More ▾</button>
        </div>
        <div class="a3-layout" hidden>
          <div class="a3-grp"><span class="a3-gl">Unit</span><button data-ex="0" class="on">Assembled</button><button data-ex="1">Exploded</button></div>
          <div class="a3-grp" data-casing="1"><span class="a3-gl">Casing</span><button data-cv="clear">Clear</button><button data-cv="grey">Grey</button></div>
          <div class="a3-grp"><span class="a3-gl">Camera</span><button data-tg="spin">Orbit</button><button data-tg="trends" title="Replay this unit's recorded trends">Replay trends</button></div>
          <div class="a3-grp" data-fx="1"><span class="a3-gl">Effects</span><button data-fxk="thermal">Thermal</button><button data-fxk="loops">Loops</button></div>
          <div class="a3-grp"><span class="a3-gl">Picture</span><button data-pic="naked" title="Only the equipment: no readouts, captions, title or legend">Naked</button><button data-pic="save" title="Save the 3D view as a PNG (2x). Readouts are never in the picture.">Save PNG</button></div>
          <div class="a3-grp" data-q="1"><span class="a3-gl">Quality</span><button data-qv="auto">Auto</button><button data-qv="high">High</button><button data-qv="medium">Med</button><button data-qv="low">Low</button><span class="a3-fps"></span></div>
          <div class="a3-grp" data-opt="swap"><span class="a3-gl">Ends</span><button data-v="normal">Return at end</button><button data-v="swap">OA at end</button></div>
          <div class="a3-grp" data-opt="hand"><span class="a3-gl">Hand</span><button data-v="right" title="Standing at the doors: supply leaves to your right">Supply right</button><button data-v="left" title="Standing at the doors: supply leaves to your left — the mirror-image unit, doors still facing you">Supply left</button></div>
          <div class="a3-grp" data-opt="oa"><span class="a3-gl">OA in</span><button data-v="roof">Roof</button><button data-v="back">Back</button><button data-v="front">Front</button><button data-v="floor">Floor</button></div>
          <div class="a3-grp" data-opt="relief"><span class="a3-gl">Relief</span><button data-v="roof">Roof</button><button data-v="back">Back</button><button data-v="front">Front</button><button data-v="floor">Floor</button></div>
          <div class="a3-grp" data-opt="ret"><span class="a3-gl">Return</span><button data-v="end">End</button><button data-v="roof">Roof</button><button data-v="back">Back</button><button data-v="front">Front</button><button data-v="floor">Floor</button></div>
        </div>
      </div>
      <div class="a3-legend"><span>${this.legend}</span><i class="a3-grad"></i><span class="a3-lo">${this.legendRange?.[0] || '45°F'}</span><span class="a3-hi">${this.legendRange?.[1] || '95°F'}</span></div>
      <div class="a3-hint">Click a part to command it · drag to orbit · scroll to zoom · right-drag to pan</div>
      <div class="a3-hover" hidden></div>`;
    hud.querySelector('.a3-name').textContent = tag;
    hud.querySelector('.a3-eyebrow').textContent = `${this.eyebrow} · live`;
    this.host.appendChild(hud);
    this.hudEl = hud;
    this.hoverEl = hud.querySelector('.a3-hover');
    this.honestyEl = hud.querySelector('.a3-honesty');
    // control-loop pulses need the program's links; the thermal layer needs a mixing box
    if (!this.links.length) hud.querySelector('[data-fxk="loops"]')?.remove();
    if (!(this.mixSec && this.inv?.oad && this.inv?.hasRet)) hud.querySelector('[data-fxk="thermal"]')?.remove();
    if (!hud.querySelector('[data-fxk]')) hud.querySelector('[data-fx]')?.remove();
    const btns = (sel) => hud.querySelectorAll(sel);
    btns('[data-view]').forEach((b) => b.addEventListener('click', () => {
      btns('[data-view]').forEach((x) => x.classList.toggle('on', x === b));
      this.userMoved = false;
      this._presetView(b.dataset.view);
    }));
    btns('[data-ex]').forEach((b) => b.addEventListener('click', () => {
      btns('[data-ex]').forEach((x) => x.classList.toggle('on', x === b));
      this.explodeTarget = Number(b.dataset.ex);
      if (this.view === 'overview' && !this.userMoved) this._presetView('overview');
    }));
    btns('[data-tg]').forEach((b) => b.addEventListener('click', () => {
      const on = !b.classList.contains('on');
      b.classList.toggle('on', on);
      if (b.dataset.tg === 'labels') { this.showLabels = on; this.labels.domElement.hidden = !on; }
      if (b.dataset.tg === 'air') this.showAir = on;
      if (b.dataset.tg === 'spin') this.controls.autoRotate = on;
      if (b.dataset.tg === 'trends') { b.classList.remove('on'); this.onLoadTrends?.(); return; }
      if (b.dataset.tg === 'layout') {
        hud.querySelector('.a3-layout').hidden = !on;
        b.setAttribute('aria-expanded', String(on));
      }
    }));
    // Picture: a naked unit (equipment only) and a PNG of the 3D view, e.g. a
    // background for another front end. Readouts live in the label layer, not
    // the WebGL canvas, so a saved picture never carries a value.
    btns('[data-pic]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.pic === 'save') { this.savePicture(); return; }
      const on = !b.classList.contains('on');
      b.classList.toggle('on', on);
      this.host.classList.toggle('a3-naked', on);
    }));
    // Layout: only the openings this unit has; a choice rebuilds the unit
    // and is remembered for this unit in this browser.
    this._layoutUI = hud.querySelector('.a3-layout');
    hud.querySelectorAll('.a3-layout [data-opt]').forEach((grp) => {
      const key = grp.dataset.opt;
      grp.querySelectorAll('button').forEach((x) => x.addEventListener('click', () => {
        if (key === 'swap') this.layout.swap = x.dataset.v === 'swap';
        else this.layout[key] = x.dataset.v;
        this._saveLayout();
        this._rebuildUnit();
        this._syncLayoutUI();
      }));
    });
    this._syncLayoutUI();
    hud.querySelectorAll('[data-fxk]').forEach((b) => b.addEventListener('click', () => {
      this.fx[b.dataset.fxk] = !this.fx[b.dataset.fxk];
      this.dirty = true;
      this._syncOptionsUI();
    }));
    // the casing finish only where there is a casing (air handlers, CRAC, ERU, fan coils)
    if (!this.hasCasing && !this.sections.some((s) => s.skins?.length)) hud.querySelector('[data-casing]')?.remove();
    hud.querySelectorAll('[data-cv]').forEach((b) => b.addEventListener('click', () => this.setCasing(b.dataset.cv)));
    hud.querySelectorAll('[data-qv]').forEach((b) => b.addEventListener('click', () => {
      this.quality = b.dataset.qv;
      this._savePref('quality', this.quality);
      this.tier = this.quality === 'auto' ? this._guessTier() : this.quality;
      this._frames.slow = 0;
      this._applyTier();
    }));
    this.fpsEl = hud.querySelector('.a3-fps');
    this._syncOptionsUI();
    // KPI chips and mode pills — only what exists
    const kp = hud.querySelector('.a3-kpis');
    this.kpis = [];
    for (const [sfx, cap, unit] of this._kpiDefs()) {
      if (!sfx || !this.has(sfx)) continue;
      const d = document.createElement('div');
      d.className = 'a3-kpi';
      d.innerHTML = '<span class="a3-kk"></span><span class="a3-kv">--</span>';
      d.firstChild.textContent = cap;
      kp.appendChild(d);
      this.kpis.push({ sfx, unit, el: d.lastChild });
      this._bind(sfx);
    }
    const md = hud.querySelector('.a3-modes');
    this.modes = [];
    for (const [sfx, cap, bad] of this._modeDefs()) {
      if (!sfx || !this.has(sfx)) continue;
      const d = document.createElement('span');
      d.className = 'a3-mode' + (bad ? ' a3-bad' : '');
      d.textContent = cap;
      md.appendChild(d);
      this.modes.push({ sfx, el: d, bad: !!bad, occ: cap === 'Occupied' });
      this._bind(sfx);
    }
  }

  /** HUD chips: [suffix, caption, unit] — only the ones this unit has are shown. */
  _kpiDefs() {
    return [['SAT', 'Supply', '°F'], [pick(this.has, ['SAT.SP', 'SATSP']), 'Setpoint', '°F'],
      [pick(this.has, ['RMT', 'RMS', 'SPC.TMP', 'ZNT', 'ZN.TMP']), 'Space', '°F'], [pick(this.has, ['RMH', 'SPC.HUM', 'ZNH']), 'Space RH', '%'],
      // a CRAC's inlet sensor is room return air, not outside air
      [this.kind === 'ef' ? pick(this.has, ['EXAT', 'OAT']) : 'OAT', this.kind === 'crac' ? 'Return' : this.kind === 'ef' ? 'Exhaust' : 'Outside', '°F'], [pick(this.has, ['SSP', 'DSP']), 'Static', 'inWC']];
  }

  /** Mode pills: [suffix, caption, bad?] — lit when the point reads > 0. */
  _modeDefs() {
    return [[pick(this.has, ['OCC.MOD', 'OCC']), 'Occupied'], [pick(this.has, ['ECM', 'ENTH.ECM', 'ECON']), 'Economizer'],
      [pick(this.has, ['DEHUM', 'DEHUM.MODE']), 'Dehum'], [pick(this.has, ['UNOC.DEHUM.MODE', 'UNOCC.DEHUM']), 'Unocc dehum'], ['LTD', 'Low temp', 1], [pick(this.has, ['SSD', 'SD']), 'Shutdown', 1],
      ['FRZ', 'Freeze', 1], ['HSP', 'Hi static', 1]];
  }

  _syncOptionsUI() {
    const hud = this.hudEl;
    if (!hud) return;
    hud.querySelectorAll('[data-fxk]').forEach((b) => b.classList.toggle('on', !!this.fx[b.dataset.fxk]));
    hud.querySelectorAll('[data-cv]').forEach((b) => b.classList.toggle('on', b.dataset.cv === this.casing));
    hud.querySelectorAll('[data-qv]').forEach((b) => {
      b.classList.toggle('on', b.dataset.qv === this.quality);
      b.title = b.dataset.qv === 'auto' ? `Auto: running at ${this.tier}` : '';
    });
    const a = hud.querySelector('[data-qv="auto"]');
    if (a) a.textContent = this.quality === 'auto' ? `Auto · ${this.tier}` : 'Auto';
  }

  /** Show the Layout rows that apply to this unit right now, and mark choices. */
  _syncLayoutUI() {
    const ui = this._layoutUI;
    if (!ui) return;
    const inv = this.inv;
    const avail = {
      swap: inv.hasRet && !!inv.oad,
      oa: inv.hasRet && !!inv.oad && !this.swap,
      relief: !!inv.ead && !!this.econSec && !this.swap,
      ret: inv.hasRet,
      // Hand needs no particular opening — any unit with a casing can be the
      // mirror-image build, and it is how the unit really sits in the room.
      hand: true,
    };
    if (!this.hasLayoutOptions) avail.swap = avail.oa = avail.relief = avail.ret = avail.hand = false;
    ui.querySelectorAll('[data-opt]').forEach((grp) => {
      const key = grp.dataset.opt;
      grp.hidden = !avail[key];
      const cur = key === 'swap' ? (this.swap ? 'swap' : 'normal') : key === 'ret' ? this.retFace : this.layout[key];
      grp.querySelectorAll('button').forEach((x) => {
        x.classList.toggle('on', x.dataset.v === cur);
        // with OA at the end, the return can't also come in the end
        x.hidden = key === 'ret' && this.swap && x.dataset.v === 'end';
      });
    });
    // Options stays visible even with no layout choices: Effects and Quality live there too
  }

  _hudValues() {
    for (const k of this.kpis || []) {
      const v = this._num(k.sfx);
      const p = this.resolve(k.sfx);
      k.el.textContent = Number.isFinite(v) ? `${k.unit === 'inWC' ? v.toFixed(2) : v.toFixed(1)} ${k.unit}` : (p?.label || '--');
      k.el.parentElement.classList.toggle('a3-notlive', !Number.isFinite(v)); k.el.parentElement.dataset.st = !Number.isFinite(v) ? (p?.status || '') : '';
    }
    // how many readouts on the unit are not live right now
    if (this.honestyEl) {
      const n = this.playback ? 0 : new Set(this.tags.filter((t) => t.row.classList.contains('a3-notlive')).map((t) => t.sfx)).size;
      this.honestyEl.hidden = !n;
      this.honestyEl.textContent = n ? `${n} point${n === 1 ? '' : 's'} not live` : '';
    }
    for (const m of this.modes || []) m.el.classList.toggle('on', this._num(m.sfx) > 0);
  }

  /**
   * Keep readouts off the HUD (title + KPI strip, the view panel, the legend,
   * the hint, the playback bar): after CSS2DRenderer has placed every label,
   * any label box that overlaps a HUD box is nudged clear by the smallest move
   * that keeps it on screen, else hidden. Cheap: the HUD boxes and the label
   * sizes are measured every 30 frames (one read pass); every frame only
   * projects anchors and writes transforms — no reads in between writes.
   */
  _clearHud() {
    const host = this.host, root = this.labels?.domElement;
    if (!host || !root) return;
    const c = (this._hudClear ||= { n: 0, rects: [], items: [] });
    if (c.n++ % 30 === 0) {
      const hr = host.getBoundingClientRect();
      c.W = hr.width; c.H = hr.height;
      c.rects = [];
      for (const sel of ['.a3-title', '.a3-panel', '.a3-legend', '.a3-hint', '.a3-pb', '.a3-hover']) {
        for (const el of host.querySelectorAll(sel)) {
          if (el.hidden || !el.offsetParent) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) c.rects.push({ l: r.left - hr.left - 6, t: r.top - hr.top - 6, r: r.right - hr.left + 6, b: r.bottom - hr.top + 6 });
        }
      }
      c.items = [];
      this.scene.traverse((o) => {
        if (!o.isCSS2DObject || !o.element) return;
        c.items.push({ o, el: o.element, w: o.element.offsetWidth, h: o.element.offsetHeight });
      });
    }
    if (!c.rects.length) return;
    const v = this._hudV || (this._hudV = new THREE.Vector3());
    const W = c.W, H = c.H;
    for (const it of c.items) {
      const el = it.el;
      if (el.style.display === 'none' || !it.w) continue;
      it.o.getWorldPosition(v);
      v.project(this.camera);
      const cx = (v.x * 0.5 + 0.5) * W, cy = (-v.y * 0.5 + 0.5) * H;
      let l = cx - it.w / 2, t = cy - it.h / 2, dx = 0, dy = 0, hide = false;
      for (let pass = 0; pass < 2; pass++) {
        let moved = false;
        for (const r of c.rects) {
          const L = l + dx, T = t + dy, R = L + it.w, B = T + it.h;
          if (R <= r.l || L >= r.r || B <= r.t || T >= r.b) continue;
          // the smallest move out of this box that stays on screen
          const opts = [[0, r.b - T], [0, r.t - B], [r.l - R, 0], [r.r - L, 0]]
            .filter(([mx, my]) => L + mx >= 0 && R + mx <= W && T + my >= 0 && B + my <= H)
            .sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - Math.abs(b[0]) - Math.abs(b[1]));
          if (!opts.length) { hide = true; break; }
          dx += opts[0][0]; dy += opts[0][1]; moved = true;
        }
        if (hide || !moved) break;
        if (pass === 1) {
          // still on a HUD box after two passes: hide it rather than cover the HUD
          const L = l + dx, T = t + dy, R = L + it.w, B = T + it.h;
          hide = c.rects.some((r) => !(R <= r.l || L >= r.r || B <= r.t || T >= r.b));
        }
      }
      el.style.visibility = hide ? 'hidden' : '';
      if (!hide && (dx || dy)) el.style.transform += ` translate(${Math.round(dx)}px,${Math.round(dy)}px)`;
    }
  }

  /**
   * Save the 3D view as a PNG at `scale` × the panel size. Only the WebGL
   * canvas is drawn, so readouts and the HUD are never in it.
   */
  savePicture(scale = 2, name = null) {
    const r = this.renderer;
    if (!r || !this.composer) return null;
    const w = Math.max(200, this.host.clientWidth), h = Math.max(240, this.host.clientHeight);
    const pr = r.getPixelRatio();
    r.setPixelRatio(scale);
    this.composer.setPixelRatio?.(scale);
    this.composer.setSize(w, h);
    this.composer.render();
    const url = r.domElement.toDataURL('image/png');
    r.setPixelRatio(pr);
    this.composer.setPixelRatio?.(pr);
    this._resize();
    this.dirty = true;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(name || this.title || 'unit').replace(/[^\w.-]+/g, '_')}-3d.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return url;
  }

  _resize() {
    const w = Math.max(200, this.host.clientWidth);
    const h = Math.max(240, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.composer?.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this._pendingTarget && this.controls) { this.controls.target.copy(this._pendingTarget); this._pendingTarget = null; }
    // keep the overview framed as the panel resizes, until the user takes over
    if (this.controls && this.view === 'overview' && !this.userMoved && !this._camTween) this._presetView('overview', true);
    this.hudEl?.classList.toggle('a3-narrow', w < 640);
  }
}
