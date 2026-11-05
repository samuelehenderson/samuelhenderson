/**
 * Digital Twin — three.js app (the only module that imports three).
 *
 *   mountTwin({ stage, canvasHost, hud, sim, reducedMotion, coarsePointer,
 *               viewer, pause, signal, onProgress, frameInsets }) → Promise<app>
 *   app.setScrollProgress(p)  scroll intro: 0–0.45 the building assembles,
 *                             ≥ 0.55 live and interactive (idempotent, cheap)
 *   app.playIntro(ms)         the same assembly on a timer (the full-screen viewer)
 *   app.refreshFrame()        re-read frameInsets() and re-frame the overview
 *   app.setVisible(bool)      pause / resume rendering and the simulation
 *   app.destroy()             dispose everything, remove listeners
 *
 * Mounting never holds the main thread for long: `pause()` (supplied by the
 * page) is awaited between every heavy step, shaders are compiled for the
 * render target the frames really use and warmed up a level at a time, so the
 * first visible frame doesn't stall on shader links either.
 *
 * `viewer: true` is the phone / tablet / weak-hardware presentation: a
 * full-screen overlay with no page scroll to share, so the camera is always
 * interactive (one-finger orbit, pinch zoom, tap to pick), the render is crisp
 * (DPR up to 2 with MSAA where the GPU supports it), the frame rate is capped
 * at 30 fps while nobody is touching it, and desks / occupants only appear
 * once the camera is close enough for them to read.
 *
 * The app owns the render loop and steps the sim; the HUD drives it through
 * events (mode, time, play, speed, fault, clear, zoom, reset, explore,
 * select, close-card). Helpers: world.js (building), equipment.js, flows.js
 * (service runs), env.js (sky, ground, light), fx.js (brackets, alarms),
 * labels.js (DOM tags), shared.js.
 */
import {
  NeutralToneMapping,
  NoToneMapping,
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
import { createFx } from './fx.js';
import { createLabels } from './labels.js';

const MODES = ['live', 'thermal', 'airflow', 'exploded'];
const FOV = 30;
const LIVE_AT = 0.55;
const EXPLODE_LIFT = 10.5; // m the camera target rises in Exploded mode
const EXPLODE_ZOOM = 0.52; // extra distance in Exploded mode
// full-screen viewer: render quality steps, best first (the watchdog walks down them)
const VIEWER_STEPS = [
  { dpr: 2, msaa: 4 },
  { dpr: 1.75, msaa: 2 },
  { dpr: 1.5, msaa: 2 },
  { dpr: 1.25, msaa: 0 },
];
const VIEWER_PX_BUDGET = 3.4e6; // device pixels: keeps tablets' render targets sane
const DETAIL_IN = 60; // m: desks / occupants appear when the camera is this close…
const DETAIL_OUT = 70; // …and go again past this (hysteresis)
const IDLE_FRAME_MS = 1000 / 30 - 3; // 30 fps while nobody is interacting

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

export async function mountTwin({
  stage,
  canvasHost,
  hud,
  sim,
  reducedMotion = false,
  coarsePointer = false,
  viewer = false,
  pause: yieldFn = null,
  signal = null,
  onProgress = null,
  frameInsets = null,
}) {
  if (!canvasHost || !sim?.layout) throw new Error('mountTwin: missing host or sim');
  const layout = sim.layout;
  const levels = makeLevels(layout);

  // Between heavy steps: report progress, let the browser paint and handle
  // input, and stop if the page no longer wants the model.
  const report = (f, label) => {
    try {
      onProgress?.(f, label);
    } catch {
      /* ignore */
    }
  };
  const aborted = () => !!signal?.aborted;
  const breathe = async (f, label) => {
    if (f != null) report(f, label);
    if (typeof yieldFn === 'function') await yieldFn();
    if (aborted()) throw new DOMException('Twin mount cancelled', 'AbortError');
  };

  let forced = null;
  try {
    const q = new URLSearchParams(window.location.search).get('twinq');
    if (q === 'high' || q === 'low') forced = q;
  } catch {
    /* ignore */
  }
  // the viewer never draws bloom or shadow maps: it spends its budget on resolution instead
  let tier = viewer ? 'low' : forced || pickTier(coarsePointer);
  const autoQuality = !forced;
  // phones (and other small or touch screens) hide interior detail at overview distance
  const lod = viewer && (coarsePointer || Math.min(window.innerWidth, window.innerHeight) < 640);
  const capFps = viewer;
  // index into VIEWER_STEPS (?twinq=high pins the best step, ?twinq=low the lightest)
  let vStep = forced === 'low' ? VIEWER_STEPS.length - 1 : 0;

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
  // three's per-program error checks block on every shader link (getProgramInfoLog…):
  // development only
  renderer.debug.checkShaderErrors = !!import.meta.env?.DEV;
  // anything an abort or a failure part-way through the build has to undo
  let labels = null;
  const bail = () => {
    safe(() => labels?.destroy());
    safe(() => renderer.dispose());
    safe(() => renderer.forceContextLoss());
    canvas.remove();
  };
  try {
    await breathe(0.08, 'Starting the renderer');
  } catch (err) {
    bail();
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

  let W = Math.max(1, canvasHost.clientWidth);
  let H = Math.max(1, canvasHost.clientHeight);
  // MSAA on a HalfFloat target needs float colour buffers to be renderable
  const msaaOK = !!(renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float'));
  const maxSamples = renderer.capabilities.maxSamples || 0;
  const dprCap = () => {
    if (!viewer) return tier === 'high' ? 1.75 : 1.25;
    // crisp on phones (≤ 2), but never past the pixel budget on big tablets
    const budget = Math.sqrt(VIEWER_PX_BUDGET / Math.max(1, W * H));
    return Math.max(1, Math.min(VIEWER_STEPS[vStep].dpr, budget));
  };
  let pixelRatio = Math.min(window.devicePixelRatio || 1, dprCap());
  // MSAA on the HalfFloat target is the biggest single frame cost: none on the
  // low tier, fewer samples on big canvases, none at all on very dense ones
  // (DPR ≥ 1.5 already smooths edges there)
  const samplesFor = () => {
    const px = W * H * pixelRatio * pixelRatio;
    if (viewer) {
      // the viewer has no bloom or shadows to pay for: anti-alias instead
      if (!msaaOK) return 0;
      const want = px > 3.6e6 ? 0 : px > 1.8e6 ? Math.min(2, VIEWER_STEPS[vStep].msaa) : VIEWER_STEPS[vStep].msaa;
      return Math.min(want, maxSamples);
    }
    if (tier === 'low') return 0;
    if (px > 6e6 && pixelRatio >= 1.5) return 0;
    return px > 2.6e6 ? 2 : 4;
  };
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(W, H, false);

  const scene = new Scene();
  scene.background = null;
  const camera = new PerspectiveCamera(FOV, W / H, 0.5, 2400);
  const ctrlCam = camera.clone();

  // A tiny target in the composer's format: programs depend on the target's
  // colour space / tone mapping, not its size, so shaders compiled and warmed up
  // against it are exactly the ones the real frames use, for almost no raster cost.
  const warmRT = new WebGLRenderTarget(4, 4, { type: HalfFloatType });

  // the PMREM environment is GPU-generated: it has to be rebuilt after a context restore
  function makeEnvMap() {
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const rt = pmrem.fromScene(room, 0.04);
    room.dispose?.();
    pmrem.dispose();
    return rt;
  }
  let envRT = null;
  let rt = null;
  let composer = null;
  let renderPass = null;
  let bloom = null;
  let output = null;
  let env = null;
  let world = null;
  let flows = null;
  let fx = null;
  try {
    // draw the environment's room once on its own first (as fromScene() will:
    // linear target, no tone mapping), so its shaders' first-use cost is one
    // step and the PMREM blur's is the next, rather than both in one long task
    const tm = renderer.toneMapping;
    try {
      const room = new RoomEnvironment();
      renderer.toneMapping = NoToneMapping;
      renderer.setRenderTarget(warmRT);
      renderer.render(room, camera);
      room.dispose?.();
    } catch {
      /* fromScene() below does the same work anyway */
    } finally {
      renderer.setRenderTarget(null);
      renderer.toneMapping = tm;
    }
    await breathe(0.14, 'Lighting the scene');
    envRT = makeEnvMap();
    scene.environment = envRT.texture;
    await breathe(0.24);

    rt = new WebGLRenderTarget(Math.round(W * pixelRatio), Math.round(H * pixelRatio), { type: HalfFloatType, samples: samplesFor() });
    composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(W, H);
    renderPass = new RenderPass(scene, camera);
    bloom = new UnrealBloomPass(new Vector2(W, H), 0.72, 0.6, 0.85);
    output = new OutputPass();
    // OutputPass is last and draws to the screen; RenderPass and the bloom work in
    // readBuffer, so no swap is ever needed and the second target is never allocated
    output.needsSwap = false;
    composer.addPass(renderPass);
    composer.addPass(bloom);
    composer.addPass(output);
  } catch (err) {
    safe(() => envRT?.dispose());
    safe(() => warmRT.dispose());
    bail();
    throw err;
  }
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

  /* ── content (built in slices: a yield between levels and modules) ── */
  const disposeContent = () => {
    safe(() => fx?.dispose());
    safe(() => flows?.dispose());
    safe(() => world?.dispose());
    safe(() => env?.dispose());
    safe(() => bloom?.dispose());
    safe(() => output?.dispose());
    safe(() => composer?.dispose());
    safe(() => rt?.dispose());
    safe(() => envRT?.dispose());
    safe(() => warmRT.dispose());
  };
  try {
    env = createEnv({ scene, layout, quality: tier });
    await breathe(0.3, 'Building the tower');
    let levelsBuilt = 0;
    const levelPause = async () => {
      levelsBuilt++;
      await breathe(0.3 + 0.32 * (levelsBuilt / Math.max(1, levels.count)));
    };
    world = await createWorld({ layout, levels, quality: tier, modeU, ctxU, pause: levelPause });
    scene.add(world.root);
    await breathe(0.64, 'Routing the services');
    flows = await createFlows({ layout, levels, levelU, modeU, ctxU, quality: tier, pause: () => breathe() });
    scene.add(flows.group);
    fx = createFx({ scene });
    labels = createLabels({ host: canvasHost, layout, levels, coarsePointer });
    await breathe(0.72, 'Compiling shaders');
  } catch (err) {
    disposeContent();
    bail();
    throw err;
  }

  env.groundU.uPulse.value = reducedMotion ? 0 : 1;
  const applyTier = () => {
    bloom.enabled = tier === 'high';
    env.setShadows(tier === 'high');
    renderer.shadowMap.needsUpdate = true;
    syncSamples();
  };
  applyTier();

  /* ── camera rig ──────────────────────────────────────────── */
  const hero = { target: new Vector3(), theta: 0.74, phi: 1.2, radius: 120 };
  // the viewer frames the building in the part of the screen its HUD leaves free
  // (card: the bottom inset while a card is open; only the lens shift follows it)
  const insets = { top: 0, right: 0, bottom: 0, left: 0, card: 0 };
  function readInsets() {
    if (typeof frameInsets !== 'function') return;
    const r = safe(() => frameInsets());
    if (!r) return;
    insets.top = clamp(finite(+r.top, 0), 0, H * 0.45);
    insets.bottom = clamp(finite(+r.bottom, 0), 0, H * 0.45);
    insets.left = clamp(finite(+r.left, 0), 0, W * 0.5);
    insets.right = clamp(finite(+r.right, 0), 0, W * 0.5);
    insets.card = clamp(finite(+r.card, 0), 0, H * 0.7);
  }
  function computeHero() {
    const aspect = W / H;
    const tanV = Math.tan(((FOV / 2) * Math.PI) / 180);
    if (viewer) {
      const bandW = Math.max(W * 0.4, W - insets.left - insets.right);
      const bandH = Math.max(H * 0.4, H - insets.top - insets.bottom);
      const tall = bandW / bandH < 1;
      // portrait: a steeper, more side-on angle reads taller (the footprint is 40 × 24 m),
      // and with no idle spin the tighter framing never clips
      // docked HUD (strip + sheet): the band is all the building's; the desktop
      // HUD's corner panels need the margin
      const dockedHud = insets.bottom > 0 || insets.right > 0;
      const vFill = tall ? 0.8 : dockedHud ? 0.86 : 0.66;
      const hFill = tall ? 1.08 : dockedHud ? 0.95 : 0.7;
      const Rv = 22 / (tanV * vFill * (bandH / H));
      const Rh = 27 / (tanV * aspect * hFill * (bandW / W));
      hero.radius = clamp(Math.max(Rv, Rh), 60, 300);
      hero.target.set(0, tall ? 9.5 : 10, 0);
      hero.theta = tall ? 1.05 : 0.72;
      hero.phi = tall ? 1.12 : 1.3;
      return;
    }
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
  readInsets();
  computeHero();
  const sph = new Spherical();
  function placeCtrlCam(target, theta, phi, radius) {
    controlsTarget().copy(target);
    sph.set(radius, phi, theta);
    ctrlCam.position.setFromSpherical(sph).add(target);
    ctrlCam.lookAt(target);
  }

  const controls = new OrbitControls(ctrlCam, canvas);
  canvas.style.touchAction = ''; // the stylesheet decides (pan-y inline, none in the viewer)
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enableZoom = viewer; // inline, the wheel keeps scrolling the page; the viewer has no page to scroll
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
  let lastRelease = 0;
  let userMoved = false;
  const onCtrlStart = () => {
    lastInteract = performance.now();
    userMoved = true;
    tween = null;
  };
  const onCtrlEnd = () => {
    lastRelease = performance.now();
  };
  controls.addEventListener('start', onCtrlStart);
  controls.addEventListener('end', onCtrlEnd);

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
  let introAnim = null; // viewer: the assembly on a timer
  let lastRender = 0;
  let detailOn = true;
  let insetsDirty = 0;

  function interactive() {
    return progress >= LIVE_AT;
  }
  function syncControls() {
    // inline on touch the canvas only orbits while exploring; the viewer always does
    const canDrag = visible && interactive() && (viewer || !coarsePointer || exploring);
    controls.enabled = canDrag && !destroyed;
    controls.enableZoom = viewer || (coarsePointer && exploring); // pinch only while exploring inline
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
    // equipment
    for (const [id, item] of world.equipment) {
      if (!item.group.parent?.visible) continue;
      const hits = raycaster.intersectObject(item.group, true);
      if (hits.length && (!best || hits[0].distance < best.d)) best = { id, d: hits[0].distance, kind: 'eq' };
    }
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

  function select(id, { focus = false, pos = null } = {}) {
    if (!id) return clearSelection();
    const desc = safe(() => sim.describe(id));
    if (!desc) return clearSelection();
    selected = id;
    world.setSelected(id);
    hud.showCard(desc, pos);
    insetsDirty = 2;
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
    insetsDirty = 2;
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
  // a pinch is never a tap: any gesture that had a second finger down picks nothing
  const pointersDown = new Set();
  let multiTouch = false;
  const onPointerDown = (e) => {
    pointersDown.add(e.pointerId);
    if (pointersDown.size > 1) multiTouch = true;
    // event time, not handler time: a tap is still a tap when a slow frame delays its handlers
    down = { x: e.clientX, y: e.clientY, t: e.timeStamp || performance.now(), id: e.pointerId };
    lastInteract = performance.now();
  };
  const onPointerUp = (e) => {
    pointersDown.delete(e.pointerId);
    lastRelease = performance.now();
    const multi = multiTouch;
    if (!pointersDown.size) multiTouch = false;
    if (!down || down.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = (e.timeStamp || performance.now()) - down.t < 650;
    down = null;
    if (multi || moved > 6 || !quick || !interactive()) return;
    const id = pickAt(e.clientX, e.clientY);
    if (id) select(id, { pos: cardPos(e.clientX, e.clientY) });
    else if (selected) clearSelection();
  };
  const onPointerCancel = (e) => {
    pointersDown.delete(e?.pointerId);
    if (!pointersDown.size) multiTouch = false;
    lastRelease = performance.now();
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
  on('time', (h) => {
    const v = finite(+h, NaN);
    // the slider's right end is the end of today, not midnight of the same day
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
    const sameSize = w === W && h === H;
    W = w;
    H = h;
    const pr = Math.min(window.devicePixelRatio || 1, dprCap());
    if (sameSize && pr === pixelRatio) return;
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
    if (!sameSize) reframe();
  }
  /** Follow a changed hero framing, but only while the rig still sits on the old one
   *  (never yank the camera off a focused selection, a mode's framing or the visitor's own view). */
  function reframe() {
    const prevHero = { ...hero, target: hero.target.clone() };
    readInsets();
    computeHero();
    if (!userMoved && !tween && !selected) {
      const r = currentRig();
      const atHero = Math.abs(r.radius - prevHero.radius) < 1;
      const changed = Math.abs(hero.radius - prevHero.radius) > 0.5 || Math.abs(hero.theta - prevHero.theta) > 1e-3 || Math.abs(hero.phi - prevHero.phi) > 1e-3;
      if (atHero && changed) placeCtrlCam(hero.target, hero.theta, hero.phi, hero.radius);
    }
  }
  world.setLineResolution(W, H);
  fx.setResolution(W, H);
  flows.setPixelRatio(pixelRatio * (H / 900));
  world.setPixelRatio(pixelRatio * (H / 900));
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvasHost);

  /* ── view framing (lens shift keeps orbiting centred) ────── */
  const viewOff = { x: 0, y: 0, set: false };
  const selC = new Vector3();
  const selS = new Vector3();
  function applyViewOffset(introW, dt = 0) {
    const portrait = W / H < 0.85;
    const wide = W >= 900;
    let sx = 0;
    let sy = 0;
    if (viewer) {
      // centre the building in the band the HUD leaves free (lens shift, so orbiting stays centred)
      const tx = (insets.right - insets.left) / 2;
      let ty = (insets.bottom - insets.top) / 2;
      if (selected && insets.card > insets.bottom && world.bboxFor(selected, selC, selS)) {
        // a card is up: lift what was tapped into the room above it
        selC.project(camera);
        const yBase = (-selC.y * 0.5 + 0.5) * H + viewOff.y; // its screen y with no lens shift
        const mid = (insets.top + (H - insets.card)) / 2;
        ty = clamp(yBase - mid, ty, ty + H * 0.3);
      }
      if (!viewOff.set || reducedMotion) {
        viewOff.x = tx;
        viewOff.y = ty;
        viewOff.set = true;
      } else {
        viewOff.x = damp(viewOff.x, tx, 6, dt);
        viewOff.y = damp(viewOff.y, ty, 6, dt);
      }
      sx = viewOff.x;
      sy = viewOff.y;
    } else if (reducedMotion) {
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
    applyViewOffset(w, dt);
    camera.updateProjectionMatrix();
  }

  /* ── performance watchdog ────────────────────────────────── */
  let emaFrame = 16;
  let slowFor = 0;
  let visibleFor = 0;
  let overrun = 1;
  const markQuality = () => {
    canvas.dataset.q = `${tier} dpr${pixelRatio.toFixed(2)} msaa${composer.renderTarget1?.samples ?? 0}${lod ? (detailOn ? ' detail' : ' lod') : ''}`;
  };
  // viewer: step resolution / MSAA down while frames keep missing their (capped) interval
  function watchViewer(dtMs, active) {
    if (!autoQuality || vStep >= VIEWER_STEPS.length - 1) return;
    if (dtMs > 1000 || introAnim) return; // a tab switch or the assembly says nothing
    const d = Math.min(dtMs, 250);
    const el = d / 1000;
    visibleFor += el;
    const target = active || !capFps ? 1000 / 60 : 1000 / 30;
    overrun = lerp(overrun, d / target, 0.06);
    if (visibleFor < 2.5) return;
    if (overrun > 1.4) slowFor += el;
    else slowFor = Math.max(0, slowFor - el * 0.5);
    if (slowFor > 2) {
      vStep++;
      slowFor = 0;
      visibleFor = 1;
      overrun = 1;
      pixelRatio = 0; // force resize to pick up the new cap
      resize();
      syncSamples();
      markQuality();
    }
  }
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
    }
  }

  /* ── frame ───────────────────────────────────────────────── */
  let simErrLogged = false;
  let shadowTick = 0;
  const alarmPool = Array.from({ length: 6 }, () => ({ key: '', center: new Vector3(), size: new Vector3() }));
  if (import.meta.env?.DEV) renderer.info.autoReset = false;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    // viewer: 30 fps while nobody is touching it (less heat, longer battery),
    // every frame while a finger, a tween or the camera's damping is moving
    const active = !!(down || tween || introAnim || now - Math.max(lastInteract, lastRelease) < 1400);
    if (capFps && !active && now - lastRender < IDLE_FRAME_MS) return;
    lastRender = now;
    if (import.meta.env?.DEV) renderer.info.reset();
    const dtMs = Math.max(0, now - last);
    const dt = Math.min(0.1, dtMs / 1000);
    last = now;
    clock += dt;
    ctxU.time.value = clock;

    if (introAnim) {
      const k = clamp((now - introAnim.t0) / introAnim.ms, 0, 1);
      setProgress(lerp(introAnim.from, 1, easeInOutCubic(k)));
      if (k >= 1) introAnim = null;
    }

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

    // camera (the viewer never spins on its own: the visitor drives it)
    if (!stepTween(now) && controls.enabled) {
      const idle = !viewer && now - lastInteract > 7000 && !selected && !reducedMotion && interactive();
      controls.autoRotate = idle;
      controls.autoRotateSpeed = damp(controls.autoRotateSpeed, idle ? 0.32 : 0, 1.5, dt);
      controls.update(dt);
    } else if (!viewer && !tween && !reducedMotion && interactive() && !selected && now - lastInteract > 7000 && (!coarsePointer || !exploring)) {
      // touch, not exploring: still drift gently
      controls.autoRotate = true;
      controls.autoRotateSpeed = damp(controls.autoRotateSpeed, 0.32, 1.5, dt);
      controls.update(dt);
    }
    if (viewer && insetsDirty && --insetsDirty === 0) readInsets();
    updateCamera(dt, now);
    if (lod) {
      // desks and occupants read as noise at overview distance on a phone: only close up
      const r = currentRig().radius * (1 + mix.explode * EXPLODE_ZOOM);
      const want = detailOn ? r < DETAIL_OUT : r < DETAIL_IN;
      if (want !== detailOn) {
        detailOn = want;
        world.setInteriorDetail(want);
        markQuality();
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
        const desc = safe(() => sim.describe(selected));
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
    if (viewer) watchViewer(dtMs, active);
    else watchPerf(dtMs);
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

  /* ── shaders, before the first visible frame ─────────────────
     Every program is compiled for the target the frames really render into
     (the composer's linear HalfFloat buffer, not the tone-mapped screen), a
     chunk at a time, and then drawn once per chunk into a tiny target of the
     same format. Each step does only its own share of the driver's first-use
     work, so neither the mount nor the first frame on screen stalls on links. */
  const warmCam = new PerspectiveCamera(60, 1, 1, 4000);
  warmCam.position.set(260, 220, 260);
  warmCam.lookAt(0, 8, 0);
  warmCam.updateMatrixWorld();
  const parallel = renderer.extensions.has('KHR_parallel_shader_compile');
  async function warmUp() {
    const reveals = world.levelState.map((l) => l.reveal.value);
    world.levelState.forEach((l) => (l.reveal.value = 1));
    world.root.traverse((o) => (o.visible = true));
    fx.group.traverse((o) => (o.visible = true)); // fx.update() re-hides what isn't in use
    const chunks = [...world.levelGroups, flows.group, fx.group];
    const others = scene.children.filter((c) => c !== world.root && c !== flows.group && c !== fx.group);
    const materials = new Set();
    const compileInto = (obj) => {
      renderer.setRenderTarget(warmRT);
      try {
        for (const m of renderer.compile(obj, camera, scene)) materials.add(m);
      } finally {
        renderer.setRenderTarget(null);
      }
    };
    try {
      // 1. hand the GPU every program (with KHR_parallel_shader_compile they link in parallel)
      for (const o of others) compileInto(o);
      for (let i = 0; i < chunks.length; i++) {
        compileInto(chunks[i]);
        await breathe(0.74 + 0.08 * ((i + 1) / chunks.length));
      }
      // 2. give the links a moment to finish off the main thread
      if (parallel) {
        const t0 = performance.now();
        const pending = () => [...materials].some((m) => !renderer.properties.get(m).currentProgram?.isReady?.());
        while (pending() && performance.now() - t0 < 2500) await breathe();
      } else {
        await breathe(0.83);
        await breathe();
      }
      // 3. first draws, a program at a time, into the tiny target. The driver
      //    finishes each pipeline on its first draw, so this is where the cost
      //    lands; one program per step keeps every step short. Camera layers
      //    pick the objects (lights on every layer, so the light setup — and so
      //    the programs — stay exactly the ones the real frames use).
      const byProgram = new Map();
      scene.traverse((o) => {
        if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          const prog = m && renderer.properties.get(m).currentProgram;
          if (!prog) continue;
          if (!byProgram.has(prog)) byProgram.set(prog, new Set());
          byProgram.get(prog).add(o);
        }
      });
      const progs = [...byProgram.values()];
      const per = Math.max(1, Math.ceil(progs.length / 29)); // layers 1–30 (31: the shadow pass)
      const lights = [];
      scene.traverse((o) => o.isLight && lights.push([o, o.layers.mask]));
      lights.forEach(([l]) => l.layers.enableAll());
      try {
        for (let i = 0, k = 1; i < progs.length; i += per, k++) {
          const objs = new Set();
          for (const set of progs.slice(i, i + per)) for (const o of set) objs.add(o);
          for (const o of objs) o.layers.enable(k);
          warmCam.layers.set(k);
          renderer.setRenderTarget(warmRT);
          try {
            renderer.render(scene, warmCam);
          } finally {
            renderer.setRenderTarget(null);
            for (const o of objs) o.layers.disable(k);
          }
          await breathe(0.84 + 0.12 * Math.min(1, (i + per) / progs.length));
        }
        // the shadow pass's depth programs (high tier): one draw with every caster
        //    (every level's casters, though the intro hasn't switched most of them on yet)
        if (tier === 'high' && renderer.shadowMap.enabled) {
          const all = new Set(world.casters);
          scene.traverse((o) => o.castShadow && (o.isMesh || o.isPoints) && all.add(o));
          const was = new Map([...all].map((o) => [o, o.castShadow]));
          for (const o of all) {
            o.castShadow = true;
            o.layers.enable(31);
          }
          warmCam.layers.set(31);
          renderer.shadowMap.needsUpdate = true;
          renderer.setRenderTarget(warmRT);
          try {
            renderer.render(scene, warmCam);
          } finally {
            renderer.setRenderTarget(null);
            for (const o of all) {
              o.castShadow = was.get(o);
              o.layers.disable(31);
            }
          }
          await breathe();
        }
      } finally {
        lights.forEach(([l, mask]) => (l.layers.mask = mask));
      }
    } finally {
      world.levelState.forEach((l, i) => (l.reveal.value = reveals[i]));
      renderer.setRenderTarget(null);
    }
  }

  applyIntro();
  updateCamera(0, performance.now());
  try {
    await warmUp();
  } catch (err) {
    if (err?.name === 'AbortError') {
      offs.forEach((off) => safe(off));
      safe(() => controls.dispose());
      safe(() => ro.disconnect());
      disposeContent();
      bail();
      throw err;
    }
    /* compile errors surface on first render; nothing to do here */
  }
  // the warm-up forced everything visible: re-apply the intro state
  world.resetIntro();
  lastIntroA = -1;
  introDirty = true;
  renderer.shadowMap.needsUpdate = true;
  if (lod) {
    detailOn = false;
    world.setInteriorDetail(false);
  }
  // the post passes, one shader at a time, so the loop's first frame is an
  // ordinary one: bloom's (high tier) into the tiny target like the scene's,
  // and the output pass last, to the screen, since its program is the screen variant
  async function warmPasses() {
    const quad = bloom.fsQuad;
    const prev = quad?.material;
    if (tier === 'high' && quad) {
      for (const m of [bloom.materialHighPassFilter, ...(bloom.separableBlurMaterials || []), bloom.compositeMaterial, bloom.blendMaterial]) {
        if (!m) continue;
        quad.material = m;
        renderer.setRenderTarget(warmRT);
        try {
          quad.render(renderer);
        } finally {
          renderer.setRenderTarget(null);
          quad.material = prev;
        }
        await breathe();
      }
    }
    const toScreen = output.renderToScreen;
    output.renderToScreen = true;
    try {
      output.render(renderer, null, warmRT);
    } finally {
      output.renderToScreen = toScreen;
    }
  }
  try {
    await warmPasses();
  } catch (err) {
    if (err?.name === 'AbortError') {
      offs.forEach((off) => safe(off));
      safe(() => controls.dispose());
      safe(() => ro.disconnect());
      disposeContent();
      bail();
      throw err;
    }
  }
  markQuality();
  syncControls();
  start();

  function setProgress(v) {
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
  }

  const api = {
    setScrollProgress(p) {
      introAnim = null;
      setProgress(reducedMotion ? 1 : clamp(finite(+p, 0), 0, 1));
    },
    /** The scroll assembly on a timer (the full-screen viewer has no scroll to drive it). */
    playIntro(ms = 1700) {
      if (reducedMotion || !(ms > 0)) {
        introAnim = null;
        setProgress(1);
        return;
      }
      introAnim = { t0: performance.now(), ms, from: Math.min(progress, 0.06) };
    },
    /** Re-read frameInsets() and re-frame the overview (the HUD's size changed). */
    refreshFrame() {
      reframe();
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
      controls.removeEventListener('end', onCtrlEnd);
      controls.dispose();
      safe(() => labels.destroy());
      safe(() => fx.dispose());
      safe(() => flows.dispose());
      safe(() => world.dispose());
      safe(() => env.dispose());
      safe(() => bloom.dispose());
      safe(() => output.dispose());
      safe(() => renderPass.dispose?.());
      safe(() => composer.dispose());
      safe(() => rt.dispose());
      safe(() => warmRT.dispose());
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
      const r = currentRig();
      placeCtrlCam(v.target ? new Vector3(...v.target) : r.target.clone(), v.theta ?? r.theta, v.phi ?? r.phi, v.radius ?? r.radius);
    };
    api.debugInfo = () => ({ tier, viewer, vStep, detailOn, samples: composer.renderTarget1?.samples, insets: { ...insets }, hero: { theta: hero.theta, phi: hero.phi, radius: hero.radius }, pixelRatio, W, H, progress, mode, frame: emaFrame, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, geos: renderer.info.memory.geometries, texs: renderer.info.memory.textures, progs: renderer.info.programs?.length });
    api._dbg = { world, flows, env, scene, camera, renderer, sim };
    window.__twinApp = api;
  }
  return api;
}
