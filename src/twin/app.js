/**
 * Digital Twin — three.js app (the only module that imports three).
 *
 *   mountTwin({ stage, canvasHost, hud, sim, reducedMotion, coarsePointer }) → app
 *   app.setScrollProgress(p)  scroll intro: 0–0.45 the building assembles,
 *                             ≥ 0.55 live and interactive (idempotent, cheap)
 *   app.setVisible(bool)      pause / resume rendering and the simulation
 *   app.destroy()             dispose everything, remove listeners
 *
 * The app owns the render loop and steps the sim; the HUD drives it through
 * events (mode, time, play, speed, fault, clear, zoom, reset, explore,
 * select, close-card). Helpers: world.js (building), units/ (the lazy chunk
 * with ClarityView's equipment models), flows.js (service runs), env.js (sky,
 * ground, light), fx.js (brackets, alarms), labels.js (DOM tags), shared.js.
 */
import {
  NeutralToneMapping,
  Color,
  HalfFloatType,
  PCFSoftShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  Raycaster,
  SRGBColorSpace,
  Scene,
  Spherical,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { clamp, damp, easeInOutCubic, finite, lerp, makeLevels, smoothstep } from './shared.js';
import { createWorld } from './world.js';
import { createFlows } from './flows.js';
import { createEnv } from './env.js';
import { createExterior, EXTERIOR_LEVELS } from './exterior.js';
import { createFx } from './fx.js';
import { createLabels } from './labels.js';

const MODES = ['live', 'thermal', 'airflow', 'exploded'];
const FOV = 30;
const LIVE_AT = 0.55;
const EXPLODE_LIFT = 10.5; // m the camera target rises in Exploded mode
const EXPLODE_ZOOM = 0.52; // extra distance in Exploded mode

function pickTier(coarsePointer) {
  const small = Math.min(window.innerWidth, window.innerHeight) < 640;
  const mem = navigator.deviceMemory;
  const cores = navigator.hardwareConcurrency;
  // weak devices start low; anything else starts high and the watchdog steps down if needed
  if (coarsePointer || small || (mem && mem < 4) || (cores && cores < 4)) return 'low';
  return 'high';
}

const wrapAngle = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};

// one task per unit build step: let input and scrolling through between them
const yieldTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r, 0)));

export async function mountTwin({ stage, canvasHost, hud, sim, reducedMotion = false, coarsePointer = false, unitsP = null }) {
  if (!canvasHost || !sim?.layout) throw new Error('mountTwin: missing host or sim');
  const layout = sim.layout;
  const levels = makeLevels(layout);

  let forced = null;
  try {
    const q = new URLSearchParams(window.location.search).get('twinq');
    if (q === 'high' || q === 'low') forced = q;
  } catch {
    /* ignore */
  }
  let tier = forced || pickTier(coarsePointer);
  const autoQuality = !forced;

  /* ── renderer + composer ─────────────────────────────────── */
  const canvas = document.createElement('canvas');
  canvas.className = 'twin3d-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  canvasHost.append(canvas);

  let renderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
  } catch (err) {
    canvas.remove();
    throw err;
  }
  renderer.outputColorSpace = SRGBColorSpace;
  // Khronos PBR Neutral keeps the site's accent hues true under bloom
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.setClearColor(0x04070d, 1);

  const dprCap = () => (tier === 'high' ? 1.75 : 1.25);
  let pixelRatio = Math.min(window.devicePixelRatio || 1, dprCap());
  let W = Math.max(1, canvasHost.clientWidth);
  let H = Math.max(1, canvasHost.clientHeight);
  // MSAA on the HalfFloat target is the biggest single frame cost: none on the
  // low tier, fewer samples on big canvases, none at all on very dense ones
  // (DPR ≥ 1.5 already smooths edges there)
  const samplesFor = () => {
    if (tier === 'low') return 0;
    const px = W * H * pixelRatio * pixelRatio;
    if (px > 6e6 && pixelRatio >= 1.5) return 0;
    return px > 2.6e6 ? 2 : 4;
  };
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(W, H, false);

  const scene = new Scene();
  scene.background = null;
  // the PMREM environment is GPU-generated: it has to be rebuilt after a context restore
  function makeEnvMap() {
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const rt = pmrem.fromScene(room, 0.04);
    room.dispose?.();
    pmrem.dispose();
    return rt;
  }
  let envRT = makeEnvMap();
  scene.environment = envRT.texture;

  const camera = new PerspectiveCamera(FOV, W / H, 0.5, 2400);
  const ctrlCam = camera.clone();

  const rt = new WebGLRenderTarget(Math.round(W * pixelRatio), Math.round(H * pixelRatio), { type: HalfFloatType, samples: samplesFor() });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(W, H);
  const renderPass = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(new Vector2(W, H), 0.72, 0.6, 0.85);
  const output = new OutputPass();
  // OutputPass is last and draws to the screen; RenderPass and the bloom work in
  // readBuffer, so no swap is ever needed and the second target is never allocated
  output.needsSwap = false;
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(output);
  function syncSamples() {
    const n = samplesFor();
    for (const t of [composer.renderTarget1, composer.renderTarget2]) {
      if (t && t.samples !== n) {
        t.samples = n;
        t.dispose(); // three re-allocates it with the new sample count on next use
      }
    }
  }

  /* ── shared uniforms ─────────────────────────────────────── */
  const ctxU = {
    time: { value: 0 },
    day: { value: 0 },
    night: { value: 1 },
    sunDir: { value: new Vector3(0.4, 0.6, 0.5).normalize() },
    sunCol: { value: new Color(1, 1, 1) },
    skyTop: { value: new Color() },
    skyHor: { value: new Color() },
  };
  const modeU = { thermal: { value: 0 }, air: { value: 0 } };
  const levelY = new Array(8).fill(1e6);
  levels.ys.forEach((y, i) => i < 8 && (levelY[i] = y));
  const levelOff = new Array(8).fill(0);
  const levelU = { uLevelY: { value: levelY }, uLevelOff: { value: levelOff } };

  /* ── content ─────────────────────────────────────────────── */
  const env = createEnv({ scene, layout, quality: tier });
  const world = createWorld({ layout, levels, quality: tier, modeU, ctxU });
  scene.add(world.root);
  // the skin the visitor can wrap round the model (HUD: Exterior). Starts at "facade", one wall open.
  const exterior = createExterior({ layout, quality: tier });
  scene.add(exterior.group);
  {
    // ?exterior=off|shell|facade|site and ?inside=0 set the opening state (handy for sharing a look)
    let q = null;
    try { q = new URLSearchParams(window.location.search); } catch { /* no window */ }
    const want = EXTERIOR_LEVELS.indexOf(q?.get('exterior') ?? '');
    exterior.setLevel(want >= 0 ? want : 2);
    exterior.setInside(q?.get('inside') !== '0');
  }
  const flows = createFlows({ layout, levels, levelU, modeU, ctxU, quality: tier });
  scene.add(flows.group);
  const fx = createFx({ scene });
  const labels = createLabels({ host: canvasHost, layout, levels, coarsePointer });

  // ClarityView's equipment models (the lazy units chunk, downloaded alongside this one)
  let units = null;
  try {
    const mod = await (unitsP || import('./units/index.js'));
    units = mod.createUnits({
      layout,
      levels,
      world,
      tier,
      reducedMotion,
      ref: {
        get state() {
          return sim.state;
        },
      },
      dev: !!import.meta.env?.DEV,
    });
    world.attachUnits(units);
    await units.build(yieldTask);
  } catch (err) {
    if (import.meta.env?.DEV) console.warn('[twin units] unavailable; drawing proxy boxes', err);
  }
  // anything without a model (the chunk failed to load) is a neutral box with the same id
  world.addProxyEquipment();

  env.groundU.uPulse.value = reducedMotion ? 0 : 1;
  const applyTier = () => {
    units?.setTier(tier);
    bloom.enabled = tier === 'high';
    env.setShadows(tier === 'high');
    renderer.shadowMap.needsUpdate = true;
    syncSamples();
  };
  applyTier();

  /* ── camera rig ──────────────────────────────────────────── */
  const hero = { target: new Vector3(), theta: 0.74, phi: 1.2, radius: 120 };
  function computeHero() {
    const aspect = W / H;
    const tanV = Math.tan(((FOV / 2) * Math.PI) / 180);
    const portrait = aspect < 0.85;
    // tablets in portrait are height-limited: fill a little more of it
    const vFill = portrait ? (aspect > 0.6 ? 0.53 : 0.47) : 0.6;
    const hFill = portrait ? 1.04 : 0.62;
    const Rv = 22 / (tanV * vFill);
    const Rh = 27 / (tanV * aspect * hFill);
    hero.radius = clamp(Math.max(Rv, Rh), 70, 260);
    hero.target.set(0, portrait ? 9 : 10, 0);
    hero.theta = portrait ? 0.62 : 0.72;
    hero.phi = portrait ? 1.33 : 1.36;
  }
  computeHero();
  const sph = new Spherical();
  function placeCtrlCam(target, theta, phi, radius) {
    controlsTarget().copy(target);
    sph.set(radius, phi, theta);
    ctrlCam.position.setFromSpherical(sph).add(target);
    ctrlCam.lookAt(target);
  }

  const controls = new OrbitControls(ctrlCam, canvas);
  canvas.style.touchAction = ''; // the stylesheet decides (pan-y until "Explore 3D")
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enableZoom = false; // the wheel keeps scrolling the page
  controls.enablePan = !coarsePointer;
  controls.rotateSpeed = 0.55;
  controls.panSpeed = 0.6;
  controls.minDistance = 16;
  controls.maxDistance = 300;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = 1.52;
  controls.autoRotate = false;
  controls.autoRotateSpeed = 0;
  controls.enabled = false;
  const controlsTarget = () => controls.target;
  placeCtrlCam(hero.target, hero.theta, hero.phi, hero.radius);
  controls.update();

  let lastInteract = performance.now();
  let userMoved = false;
  const onCtrlStart = () => {
    lastInteract = performance.now();
    userMoved = true;
    tween = null;
  };
  controls.addEventListener('start', onCtrlStart);

  // tweens move the rig (focus / zoom / reset)
  let tween = null;
  function tweenTo({ target, theta, phi, radius }, ms = 1100) {
    const offset = new Vector3().subVectors(ctrlCam.position, controls.target);
    sph.setFromVector3(offset);
    const from = { target: controls.target.clone(), theta: sph.theta, phi: sph.phi, radius: sph.radius };
    const to = {
      target: (target || from.target).clone(),
      theta: theta ?? from.theta,
      phi: phi ?? from.phi,
      radius: clamp(radius ?? from.radius, controls.minDistance, controls.maxDistance),
    };
    to.theta = from.theta + wrapAngle(to.theta - from.theta);
    tween = { from, to, t0: performance.now(), ms: reducedMotion ? 1 : ms };
    lastInteract = performance.now();
  }
  const tweenTgt = new Vector3();
  const rigOff = new Vector3();
  const rig = { target: null, theta: 0, phi: 0, radius: 0 };
  function stepTween(now) {
    if (!tween) return false;
    const k = easeInOutCubic(clamp((now - tween.t0) / tween.ms, 0, 1));
    const { from, to } = tween;
    tweenTgt.lerpVectors(from.target, to.target, k);
    placeCtrlCam(tweenTgt, lerp(from.theta, to.theta, k), lerp(from.phi, to.phi, k), lerp(from.radius, to.radius, k));
    if (k >= 1) tween = null;
    return true;
  }
  /** The rig as target + spherical angles (a shared object: read it, don't keep it). */
  function currentRig() {
    sph.setFromVector3(rigOff.subVectors(ctrlCam.position, controls.target));
    rig.target = controls.target;
    rig.theta = sph.theta;
    rig.phi = sph.phi;
    rig.radius = sph.radius;
    return rig;
  }
  function zoomBy(dir) {
    const r = currentRig();
    tweenTo({ radius: r.radius * (dir > 0 ? 0.74 : 1.35) }, 520);
  }
  function resetView() {
    computeHero();
    tweenTo({ target: hero.target, theta: hero.theta, phi: hero.phi, radius: hero.radius }, 1200);
    userMoved = false;
  }

  /* ── state ───────────────────────────────────────────────── */
  let progress = reducedMotion ? 1 : 0;
  let visible = true;
  let destroyed = false;
  let playing = true;
  let exploring = false;
  let mode = 'live';
  const mix = { thermal: 0, air: 0, explode: 0 };
  let selected = null;
  let hoverId = null;
  let raf = 0;
  let last = performance.now();
  let clock = 0;
  let cardTimer = 0;
  let introDirty = true;
  let lastIntroA = -1;
  let cut = 0; // basement section cut (0..1)

  function interactive() {
    return progress >= LIVE_AT;
  }
  function syncControls() {
    const canDrag = visible && interactive() && (!coarsePointer || exploring);
    controls.enabled = canDrag && !destroyed;
    controls.enableZoom = coarsePointer && exploring; // pinch only while exploring on touch
    canvas.style.cursor = canDrag ? (hoverId ? 'pointer' : 'grab') : hoverId ? 'pointer' : '';
  }

  /* ── intro ───────────────────────────────────────────────── */
  function applyIntro() {
    introDirty = false;
    const a = clamp(progress / 0.45, 0, 1);
    // past the assembly nothing here changes: don't redraw the shadow map on every scroll frame
    if (a === lastIntroA) return;
    lastIntroA = a;
    const n = levels.count;
    for (let i = 0; i < n; i++) {
      const start = (i / n) * 0.66;
      const r = clamp((a - start) / 0.26, 0, 1);
      world.setLevelIntro(i, r, 9);
    }
    flows.setReveal(clamp((a - 0.5) / 0.5, 0, 1) * 1.02);
    env.groundU.uIntro.value = 0.18 + 0.82 * smoothstep(0, 0.55, a);
    renderer.shadowMap.needsUpdate = true;
  }

  /* ── selection / picking ─────────────────────────────────── */
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const tmpC = new Vector3();
  const tmpS = new Vector3();
  let pointer = null;
  let pickDirty = false;

  function pickAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    let best = null;
    // equipment: invisible boxes per unit and sub-part (never the models' triangles)
    const eq = world.pickEquipment(raycaster);
    if (eq) best = { id: eq.id, d: eq.d, kind: 'eq' };
    // zones (storey-height boxes) and VAVs
    let zoneHit = null;
    for (const m of world.pickZoneMeshes) {
      if (!m.parent?.visible) continue;
      const hits = raycaster.intersectObject(m, false);
      if (hits.length && (!zoneHit || hits[0].distance < zoneHit.d)) zoneHit = { id: m.userData.pickZones[hits[0].instanceId], d: hits[0].distance };
    }
    let vavHit = null;
    for (const m of world.pickVavMeshes) {
      if (!m.parent?.visible) continue;
      const hits = raycaster.intersectObject(m, false);
      if (hits.length && (!vavHit || hits[0].distance < vavHit.d)) vavHit = { id: m.userData.pickVavs[hits[0].instanceId], d: hits[0].distance };
    }
    if (zoneHit && (!best || zoneHit.d < best.d)) {
      const zone = layout.zones[world.zoneIndex.get(zoneHit.id)];
      if (vavHit && zone && zone.vav === vavHit.id) return vavHit.id;
      return zoneHit.id;
    }
    return best ? best.id : null;
  }

  function cardPos(clientX, clientY) {
    const r = (stage || canvasHost).getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  /**
   * The card for an id: the sim's description; a sub-part the sim does not
   * describe shows its unit's card.
   */
  function describe(id) {
    const d = safe(() => sim.describe(id));
    if (d || !units) return d;
    const h = units.owner(id);
    if (!h || id === h.id) return null;
    return describe(h.id);
  }

  function select(id, { focus = false, pos = null } = {}) {
    if (!id) return clearSelection();
    const desc = describe(id);
    if (!desc) return clearSelection();
    selected = id;
    world.setSelected(id);
    hud.showCard(desc, pos);
    cardTimer = 0;
    if (focus && world.bboxFor(id, tmpC, tmpS)) {
      const size = Math.max(tmpS.x, tmpS.y, tmpS.z);
      const r = currentRig();
      const isZone = world.zoneIndex.has(id) || world.vavIndex.has(id);
      const below = tmpC.y < 0;
      const ex = mix.explode;
      // the rig is framed before the exploded-view lift, so take it back out
      const target = tmpC.clone();
      target.y -= ex * EXPLODE_LIFT;
      const radius = (isZone ? clamp(size * 2.2 + 44, 40, 110) : clamp(size * 2.6 + 32, 34, 100)) / (1 + ex * EXPLODE_ZOOM);
      tweenTo(
        {
          target,
          radius,
          // plant in the basement is seen through the cut-away, from low down
          phi: below ? 1.38 : clamp(r.phi, 0.55, 1.22),
        },
        1300,
      );
    }
  }
  function clearSelection(hideCard = true) {
    selected = null;
    world.setSelected(null);
    if (hideCard) hud.showCard(null, null);
  }

  const onPointerMove = (e) => {
    if (e.pointerType !== 'mouse') return;
    pointer = { x: e.clientX, y: e.clientY };
    pickDirty = true;
  };
  const onPointerLeave = () => {
    pointer = null;
    pickDirty = true;
  };
  let down = null;
  const onPointerDown = (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    lastInteract = performance.now();
  };
  const onPointerUp = (e) => {
    if (!down || down.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 650;
    down = null;
    if (moved > 6 || !quick || !interactive()) return;
    const id = pickAt(e.clientX, e.clientY);
    if (id) select(id, { pos: cardPos(e.clientX, e.clientY) });
    else if (selected) clearSelection();
  };
  const onPointerCancel = () => {
    down = null;
  };
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  /* ── HUD wiring ──────────────────────────────────────────── */
  const offs = [];
  const on = (ev, fn) => {
    const off = hud?.on?.(ev, (v) => {
      if (destroyed) return;
      try {
        fn(v);
      } catch (err) {
        if (import.meta.env?.DEV) console.warn('[twin app]', ev, err);
      }
    });
    if (typeof off === 'function') offs.push(off);
  };
  function setMode(m) {
    if (!MODES.includes(m)) return;
    const prev = mode;
    mode = m;
    hud.setMode?.(m);
    labels.setMode(m);
    if (m === prev) return;
    // Thermal / Airflow / Exploded are whole-building views: ease back out to the
    // overview (keeping the visitor's angle if they orbited, and any open card),
    // unless they're mid-explore on a touch screen
    if (m !== 'live' && !exploring) {
      computeHero();
      tweenTo(
        {
          target: hero.target,
          radius: hero.radius,
          theta: userMoved ? undefined : hero.theta,
          phi: m === 'exploded' ? 1.18 : userMoved ? clamp(currentRig().phi, 0.9, hero.phi) : hero.phi,
        },
        1000,
      );
    } else if (m === 'live' && prev === 'exploded' && !userMoved && !selected && !exploring) {
      tweenTo({ phi: hero.phi }, 900);
    }
  }
  on('mode', setMode);
  on('exterior', (id) => {
    const n = EXTERIOR_LEVELS.indexOf(id);
    if (n >= 0) exterior.setLevel(n);
  });
  on('inside', (b) => exterior.setInside(!!b));
  hud.setExterior?.(EXTERIOR_LEVELS[exterior.level], exterior.inside);
  // the slider's right end is the end of today, not midnight of the same day. While dragging, each
  // frame settles quickly; letting go on an early-morning hour replays the night (sim.setHour)
  on('time', (h) => {
    const v = finite(+h, NaN);
    if (Number.isFinite(v)) sim.setHour(clamp(v, 0, 23.99), { quick: true });
  });
  on('timeset', (h) => {
    const v = finite(+h, NaN);
    if (Number.isFinite(v)) sim.setHour(clamp(v, 0, 23.99));
  });
  on('play', (b) => {
    playing = !!b;
  });
  on('speed', (n) => {
    const v = finite(+n, 60);
    sim.speed = clamp(v, 0, 3600);
  });
  on('fault', (kind) => {
    const res = sim.injectFault(kind);
    if (kind === 'hot-day') {
      // a heat wave is a whole-building story: frame the tower and show the heat map
      clearSelection();
      if (mode === 'thermal' || exploring) resetView();
      else {
        userMoved = false;
        setMode('thermal');
      }
      return;
    }
    if (res?.target) select(res.target, { focus: true });
  });
  on('clear', () => {
    sim.clearFaults();
    clearSelection();
    resetView();
  });
  on('zoom', (d) => zoomBy(+d > 0 ? 1 : -1));
  on('reset', () => {
    clearSelection();
    resetView();
  });
  on('explore', (b) => {
    exploring = !!b;
    syncControls();
  });
  on('close-card', () => clearSelection(false));
  on('select', (id) => select(id, { focus: true }));

  /* ── sizing ──────────────────────────────────────────────── */
  function resize() {
    const w = Math.max(1, canvasHost.clientWidth);
    const h = Math.max(1, canvasHost.clientHeight);
    const pr = Math.min(window.devicePixelRatio || 1, dprCap());
    if (w === W && h === H && pr === pixelRatio) return;
    W = w;
    H = h;
    pixelRatio = pr;
    renderer.setPixelRatio(pr);
    renderer.setSize(W, H, false);
    composer.setPixelRatio(pr);
    composer.setSize(W, H);
    syncSamples();
    camera.aspect = W / H;
    ctrlCam.aspect = W / H;
    ctrlCam.updateProjectionMatrix();
    world.setLineResolution(W, H);
    fx.setResolution(W, H);
    flows.setPixelRatio(pr * (H / 900));
    world.setPixelRatio(pr * (H / 900));
    units?.setPixelRatio(pr * (H / 900));
    const prevHero = { ...hero, target: hero.target.clone() };
    computeHero();
    // follow a changed hero framing only while the rig still sits on the old one
    // (never yank the camera off a focused selection or a mode's framing)
    if (!userMoved && !tween && !selected) {
      const r = currentRig();
      const atHero = Math.abs(r.radius - prevHero.radius) < 1;
      if (atHero && Math.abs(hero.radius - prevHero.radius) > 0.5) placeCtrlCam(hero.target, hero.theta, hero.phi, hero.radius);
    }
  }
  world.setLineResolution(W, H);
  fx.setResolution(W, H);
  flows.setPixelRatio(pixelRatio * (H / 900));
  world.setPixelRatio(pixelRatio * (H / 900));
  units?.setPixelRatio(pixelRatio * (H / 900));
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvasHost);

  /* ── view framing (lens shift keeps orbiting centred) ────── */
  function applyViewOffset(introW) {
    const portrait = W / H < 0.85;
    const wide = W >= 900;
    let sx = 0;
    let sy = 0;
    if (reducedMotion) {
      // one static composition that clears both the intro copy and the HUD
      if (portrait) sy = -0.11 * H; // low enough that the roof clears the intro chip on phones
      else {
        sx = wide ? -0.115 * W : 0;
        sy = -0.02 * H;
      }
    } else if (portrait) {
      // live: sit a touch higher, between the KPI strip and the controls sheet
      sy = lerp(-0.13, 0.012, introW) * H;
    } else {
      sx = wide ? lerp(-0.2, 0, introW) * W : 0;
      sy = lerp(0.02, -0.035, introW) * H;
    }
    camera.setViewOffset(W, H, sx, sy, W, H);
  }

  /* ── camera pose: intro path blended into the user's rig ─── */
  const pose = { target: new Vector3() };
  const introTarget = new Vector3();
  function updateCamera(dt, now) {
    const w = smoothstep(0.42, 0.56, progress);
    const u = easeInOutCubic(clamp(progress / 0.5, 0, 1));
    introTarget.set(0, lerp(1, hero.target.y, u), 0);
    const iTheta = hero.theta - lerp(1.05, 0, u);
    const iPhi = lerp(0.46, hero.phi, u);
    const iRadius = hero.radius * lerp(1.55, 1, u);

    const r = currentRig();
    const ex = mix.explode;
    const uTarget = tmpC.copy(r.target);
    uTarget.y += ex * EXPLODE_LIFT;
    const uRadius = r.radius * (1 + ex * EXPLODE_ZOOM);

    pose.target.lerpVectors(introTarget, uTarget, w);
    const theta = iTheta + wrapAngle(r.theta - iTheta) * w;
    const phi = lerp(iPhi, r.phi, w);
    const radius = lerp(iRadius, uRadius, w);
    sph.set(radius, phi, theta);
    camera.position.setFromSpherical(sph).add(pose.target);
    camera.lookAt(pose.target);
    camera.fov = FOV;
    camera.near = Math.max(0.5, radius * 0.02);
    camera.far = 2400;
    applyViewOffset(w);
    camera.updateProjectionMatrix();
  }

  /* ── performance watchdog ────────────────────────────────── */
  let emaFrame = 16;
  let slowFor = 0;
  let visibleFor = 0;
  function watchPerf(dtMs) {
    // real elapsed time (not the sim's capped dt), ignoring long stalls such as tab switches
    const el = Math.min(dtMs, 1000) / 1000;
    emaFrame = lerp(emaFrame, Math.min(dtMs, 250), 0.08);
    if (!autoQuality || tier === 'low') return;
    visibleFor += el;
    if (visibleFor < 3) return;
    if (emaFrame > 26) slowFor += el;
    else slowFor = Math.max(0, slowFor - el * 0.5);
    if (slowFor > 2.5) {
      tier = 'low';
      pixelRatio = 0; // force resize to pick up the new cap
      resize();
      applyTier();
      // there's no way back up: free the high-tier GPU resources now
      safe(() => {
        env.sun.shadow.map?.dispose();
        env.sun.shadow.map = null;
      });
      safe(() => bloom.dispose());
      safe(() => flows.setQuality?.('low'));
      safe(() => units?.setTier('low'));
    }
  }

  /* ── frame ───────────────────────────────────────────────── */
  let simErrLogged = false;
  let unitErrLogged = false;
  const unitFrame = { camera, tanHalf: Math.tan(((FOV / 2) * Math.PI) / 180), selected: null, hover: null, reducedMotion, clock: 0 };
  let shadowTick = 0;
  const alarmPool = Array.from({ length: 6 }, () => ({ key: '', center: new Vector3(), size: new Vector3() }));
  if (import.meta.env?.DEV) renderer.info.autoReset = false;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (import.meta.env?.DEV) renderer.info.reset();
    const dtMs = Math.max(0, now - last);
    const dt = Math.min(0.1, dtMs / 1000);
    last = now;
    clock += dt;
    ctxU.time.value = clock;

    if (playing) {
      try {
        sim.step(dt);
      } catch (err) {
        if (!simErrLogged && import.meta.env?.DEV) console.warn('[twin] sim.step failed', err);
        simErrLogged = true;
      }
    }
    const state = sim.state;
    hud.setState?.(state, layout);

    env.update(state, dt, clock);
    ctxU.day.value = env.daylight;
    ctxU.night.value = env.night;
    ctxU.sunDir.value.copy(env.sunDir);
    ctxU.sunCol.value.copy(env.sunColor);
    ctxU.skyTop.value.copy(env.skyU.uTop.value);
    ctxU.skyHor.value.copy(env.skyU.uHor.value);

    // modes
    const rate = reducedMotion ? 14 : 3.2;
    const prevEx = mix.explode;
    mix.thermal = damp(mix.thermal, mode === 'thermal' ? 1 : 0, rate, dt);
    mix.air = damp(mix.air, mode === 'airflow' ? 1 : 0, rate, dt);
    mix.explode = damp(mix.explode, mode === 'exploded' ? 1 : 0, reducedMotion ? 14 : 2.2, dt);
    modeU.thermal.value = mix.thermal;
    modeU.air.value = mix.air;
    for (let i = 0; i < 8; i++) levelOff[i] = (levels.explode[i] || 0) * mix.explode;
    if (introDirty) applyIntro();
    world.applyLevelTransforms(levels.explode, mix.explode);
    world.setModeVisuals({ thermal: mix.thermal, air: mix.air, explode: mix.explode, xray: mix.explode });
    flows.setModeVisuals({ thermal: mix.thermal, air: mix.air });
    // the exterior steps aside while the model assembles or is exploded, and opens a wall in the see-in modes
    exterior.update(dt, camera, {
      reducedMotion,
      shown: progress >= 0.45 && mode !== 'exploded',
      forceOpen: mode === 'thermal' || mode === 'airflow',
      night: env.night,
    });
    env.groundU.uRect.value.z = 22 + 20 * mix.explode;
    env.groundU.uXray.value = 1 + 0.4 * mix.explode;

    // basement focus: cut away the L1–L2 interiors in front of the plant
    const cutWant = selected && mix.explode < 0.5 && world.bboxFor(selected, tmpC, tmpS) && tmpC.y < 0 ? 1 : 0;
    if (cut !== cutWant) {
      let next = damp(cut, cutWant, reducedMotion ? 14 : 3, dt);
      if (Math.abs(next - cutWant) < 0.01) next = cutWant;
      cut = next;
      world.setSectionCut(cut);
    }

    world.update(state, dt, clock, { reducedMotion, mode });
    flows.update(state, dt, { reducedMotion });

    // camera
    if (!stepTween(now) && controls.enabled) {
      const idle = now - lastInteract > 7000 && !selected && !reducedMotion && interactive();
      controls.autoRotate = idle;
      controls.autoRotateSpeed = damp(controls.autoRotateSpeed, idle ? 0.32 : 0, 1.5, dt);
      controls.update(dt);
    } else if (!tween && !reducedMotion && interactive() && !selected && now - lastInteract > 7000 && (!coarsePointer || !exploring)) {
      // touch, not exploring: still drift gently
      controls.autoRotate = true;
      controls.autoRotateSpeed = damp(controls.autoRotateSpeed, 0.32, 1.5, dt);
      controls.update(dt);
    }
    updateCamera(dt, now);
    // the VAV terminals' distance LOD, and the plant x-ray off while the camera is in the plant room
    world.updateForCamera(camera.position);

    // units: LOD by screen size (the selected / hovered one always full), live ticks on LOD0
    if (units) {
      try {
        unitFrame.camera = camera;
        unitFrame.selected = selected;
        unitFrame.hover = hoverId;
        unitFrame.clock = clock;
        units.update(dt, now, unitFrame);
      } catch (err) {
        if (!unitErrLogged && import.meta.env?.DEV) console.warn('[twin units] update failed', err);
        unitErrLogged = true;
      }
    }

    // hover
    if (pickDirty && interactive() && !coarsePointer) {
      pickDirty = false;
      const id = pointer && !down ? pickAt(pointer.x, pointer.y) : null;
      if (id !== hoverId) {
        hoverId = id;
        world.setHover(id);
        syncControls();
      }
    } else if (!interactive() && hoverId) {
      hoverId = null;
      world.setHover(null);
    }
    if (hoverId && hoverId !== selected && world.bboxFor(hoverId, tmpC, tmpS)) fx.setHover(tmpC, tmpS);
    else fx.setHover(null);
    if (selected && world.bboxFor(selected, tmpC, tmpS)) fx.setSelect(tmpC, tmpS);
    else fx.setSelect(null);

    // refresh the open card with live values (~4 Hz)
    if (selected) {
      cardTimer += dt;
      if (cardTimer > 0.25) {
        cardTimer = 0;
        const desc = describe(selected);
        if (desc) hud.showCard(desc, null);
      }
    }

    // alarm markers
    const alarms = Array.isArray(state?.alarms) ? state.alarms : [];
    const list = [];
    for (const a of alarms) {
      const id = a?.target;
      if (!id || list.some((x) => x.key === id)) continue;
      const slot = alarmPool[list.length];
      if (world.bboxFor(id, slot.center, slot.size)) {
        slot.key = id;
        list.push(slot);
      }
      if (list.length >= alarmPool.length) break;
    }
    fx.setAlarms(progress >= 0.4 ? list : [], selected);
    fx.update(clock, dt, { reducedMotion, scale: W / H < 0.85 ? 1.35 : 1, camera });

    labels.update(camera, world, { progress, W, H, mix, state });

    // shadows: refresh when the sun moves or geometry is animating
    shadowTick++;
    const animating = Math.abs(mix.explode - prevEx) > 1e-4 || world.levelState.some((l) => l.reveal.value > 0 && l.reveal.value < 1);
    if (tier === 'high' && env.sunUp > 0.001 && (env.shadowDirty() || (animating && shadowTick % 2 === 0) || shadowTick % 90 === 0)) renderer.shadowMap.needsUpdate = true;

    composer.render(dt);
    watchPerf(dtMs);
  }

  function safe(fn) {
    try {
      return fn();
    } catch {
      return null;
    }
  }

  function start() {
    if (raf || destroyed) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // context loss: pause, and resume when the browser gives it back
  const onLost = (e) => {
    e.preventDefault();
    stop();
  };
  const onRestored = () => {
    safe(() => {
      const next = makeEnvMap();
      safe(() => envRT.dispose());
      envRT = next;
      scene.environment = envRT.texture;
    });
    lastIntroA = -1;
    introDirty = true;
    renderer.shadowMap.needsUpdate = true;
    if (visible) start();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  // first frame: compile shaders up front so the intro doesn't hitch
  applyIntro();
  updateCamera(0, performance.now());
  // (both unit LODs and the hidden air streams included; whatever was hidden is hidden again after)
  let compiledPrograms = null;
  const hidden = [];
  world.root.traverse((o) => {
    if (!o.visible) hidden.push(o);
  });
  try {
    const all = world.levelState.map((l) => l.reveal.value);
    world.levelState.forEach((l) => (l.reveal.value = 1));
    world.root.traverse((o) => (o.visible = true));
    fx.group.traverse((o) => (o.visible = true)); // fx.update() re-hides what isn't in use
    // compile for the target the scene really renders into (the composer's buffer: linear, no
    // tone mapping), or every program is compiled twice: once here, again on the first frame
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(composer.readBuffer);
    let compiling;
    try {
      compiling = renderer.compileAsync(scene, camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
    }
    if (import.meta.env?.DEV) compiledPrograms = renderer.info.programs?.length;
    await Promise.race([compiling, new Promise((r) => setTimeout(r, 2500))]);
    world.levelState.forEach((l, i) => (l.reveal.value = all[i]));
  } catch {
    /* compile errors surface on first render; nothing to do here */
  }
  for (const o of hidden) o.visible = false;
  safe(() => units?.afterCompile());
  // the compile pass forced everything visible: re-apply the intro state
  world.resetIntro();
  lastIntroA = -1;
  introDirty = true;
  syncControls();
  start();

  const api = {
    setScrollProgress(p) {
      const v = reducedMotion ? 1 : clamp(finite(+p, 0), 0, 1);
      if (v === progress) return;
      const wasLive = interactive();
      progress = v;
      introDirty = true;
      if (wasLive !== interactive()) {
        syncControls();
        if (!interactive()) {
          if (selected) clearSelection();
          hoverId = null;
          world.setHover(null);
        }
      }
    },
    setVisible(v) {
      visible = !!v;
      if (visible) start();
      else stop();
      syncControls();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      offs.forEach((off) => safe(off));
      ro.disconnect();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      controls.removeEventListener('start', onCtrlStart);
      controls.dispose();
      safe(() => labels.destroy());
      safe(() => fx.dispose());
      safe(() => flows.dispose());
      safe(() => units?.dispose());
      safe(() => exterior.dispose());
      safe(() => world.dispose());
      safe(() => env.dispose());
      safe(() => bloom.dispose());
      safe(() => output.dispose());
      safe(() => renderPass.dispose?.());
      safe(() => composer.dispose());
      safe(() => rt.dispose());
      safe(() => envRT.dispose());
      scene.environment = null;
      safe(() => renderer.renderLists.dispose());
      safe(() => renderer.dispose());
      safe(() => renderer.forceContextLoss());
      canvas.remove();
      if (import.meta.env?.DEV && window.__twinApp === api) delete window.__twinApp;
    },
  };
  // dev-only hook for scripted screenshots (stripped from production builds)
  if (import.meta.env?.DEV) {
    api.debugView = (v) => {
      tween = null;
      userMoved = true;
      // scripted close-ups may come nearer than a visitor can orbit (restored by a pose without it)
      controls.minDistance = v.minDistance ?? 16;
      const r = currentRig();
      placeCtrlCam(v.target ? new Vector3(...v.target) : r.target.clone(), v.theta ?? r.theta, v.phi ?? r.phi, v.radius ?? r.radius);
    };
    api.debugInfo = () => ({ tier, pixelRatio, W, H, progress, mode, frame: emaFrame, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, geos: renderer.info.memory.geometries, texs: renderer.info.memory.textures, progs: renderer.info.programs?.length });
    api._dbg = { world, flows, env, scene, camera, renderer, sim, units, compiledPrograms, exterior };
    api.debugSelect = (id) => select(id, { focus: true });
    api.debugPick = (x, y) => pickAt(x, y);
    window.__twinApp = api;
  }
  return api;
}
