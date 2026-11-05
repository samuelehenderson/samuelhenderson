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
 * select, close-card). Helpers: world.js (building), equipment.js, flows.js
 * (service runs), env.js (sky, ground, light), fx.js (brackets, alarms),
 * labels.js (DOM tags), shared.js.
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
import { createFx } from './fx.js';
import { createLabels } from './labels.js';

const MODES = ['live', 'thermal', 'airflow', 'exploded'];
const FOV = 30;
const LIVE_AT = 0.55;

function pickTier(coarsePointer) {
  const small = Math.min(window.innerWidth, window.innerHeight) < 640;
  const mem = navigator.deviceMemory;
  const cores = navigator.hardwareConcurrency;
  if (coarsePointer || small || (mem && mem <= 4) || (cores && cores <= 4)) return 'low';
  return 'high';
}

const wrapAngle = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};

export async function mountTwin({ stage, canvasHost, hud, sim, reducedMotion = false, coarsePointer = false }) {
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
  const samplesFor = () => (W * H * pixelRatio * pixelRatio > 2.6e6 ? 2 : 4);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(W, H, false);

  const scene = new Scene();
  scene.background = null;
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  room.dispose?.();
  scene.environment = envRT.texture;

  const camera = new PerspectiveCamera(FOV, W / H, 0.5, 2400);
  const ctrlCam = camera.clone();

  const rt = new WebGLRenderTarget(Math.round(W * pixelRatio), Math.round(H * pixelRatio), { type: HalfFloatType, samples: samplesFor() });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(W, H);
  const renderPass = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(new Vector2(W, H), 0.62, 0.55, 0.86);
  const output = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(output);

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
  const flows = createFlows({ layout, levels, levelU, modeU, ctxU, quality: tier });
  scene.add(flows.group);
  const fx = createFx({ scene });
  const labels = createLabels({ host: canvasHost, layout, levels, coarsePointer });

  env.groundU.uPulse.value = reducedMotion ? 0 : 1;
  const applyTier = () => {
    bloom.enabled = tier === 'high';
    env.setShadows(tier === 'high');
    renderer.shadowMap.needsUpdate = true;
  };
  applyTier();

  /* ── camera rig ──────────────────────────────────────────── */
  const hero = { target: new Vector3(), theta: 0.74, phi: 1.2, radius: 120 };
  function computeHero() {
    const aspect = W / H;
    const tanV = Math.tan(((FOV / 2) * Math.PI) / 180);
    const portrait = aspect < 0.85;
    const vFill = portrait ? 0.46 : 0.6;
    const hFill = portrait ? 1.0 : 0.62;
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
  function stepTween(now) {
    if (!tween) return false;
    const k = easeInOutCubic(clamp((now - tween.t0) / tween.ms, 0, 1));
    const { from, to } = tween;
    const tgt = new Vector3().lerpVectors(from.target, to.target, k);
    placeCtrlCam(tgt, lerp(from.theta, to.theta, k), lerp(from.phi, to.phi, k), lerp(from.radius, to.radius, k));
    if (k >= 1) tween = null;
    return true;
  }
  function currentRig() {
    sph.setFromVector3(new Vector3().subVectors(ctrlCam.position, controls.target));
    return { target: controls.target, theta: sph.theta, phi: sph.phi, radius: sph.radius };
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
    cardTimer = 0;
    if (focus && world.bboxFor(id, tmpC, tmpS)) {
      const size = Math.max(tmpS.x, tmpS.y, tmpS.z);
      const r = currentRig();
      const isZone = world.zoneIndex.has(id) || world.vavIndex.has(id);
      tweenTo(
        {
          target: tmpC.clone(),
          radius: isZone ? clamp(size * 2.2 + 44, 40, 110) : clamp(size * 2.6 + 32, 34, 100),
          phi: clamp(r.phi, 0.55, 1.22),
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
    mode = m;
    hud.setMode?.(m);
    labels.setMode(m);
    if (m === 'exploded' && !userMoved) tweenTo({ phi: 1.16 }, 900);
  }
  on('mode', setMode);
  on('time', (h) => {
    const v = finite(+h, NaN);
    if (Number.isFinite(v)) sim.setHour(clamp(v, 0, 24));
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
    if (res?.target) select(res.target, { focus: true });
  });
  on('clear', () => {
    sim.clearFaults();
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
    camera.aspect = W / H;
    ctrlCam.aspect = W / H;
    ctrlCam.updateProjectionMatrix();
    world.setLineResolution(W, H);
    fx.setResolution(W, H);
    flows.setPixelRatio(pr * (H / 900));
    world.setPixelRatio(pr * (H / 900));
    const prevHero = { ...hero, target: hero.target.clone() };
    computeHero();
    if (!userMoved && !tween) {
      const r = currentRig();
      if (Math.abs(r.radius - prevHero.radius) > 0.5) placeCtrlCam(hero.target, hero.theta, hero.phi, hero.radius);
    }
  }
  world.setLineResolution(W, H);
  fx.setResolution(W, H);
  flows.setPixelRatio(pixelRatio * (H / 900));
  world.setPixelRatio(pixelRatio * (H / 900));
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvasHost);

  /* ── view framing (lens shift keeps orbiting centred) ────── */
  function applyViewOffset(introW) {
    const portrait = W / H < 0.85;
    const wide = W >= 900;
    let sx = 0;
    let sy = 0;
    if (portrait) {
      sy = lerp(-0.13, 0.1, introW) * H;
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
    uTarget.y += ex * 10.5;
    const uRadius = r.radius * (1 + ex * 0.52);

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
  function watchPerf(dtMs, dt) {
    emaFrame = lerp(emaFrame, Math.min(dtMs, 250), 0.08);
    if (!autoQuality || tier === 'low') return;
    visibleFor += dt;
    if (visibleFor < 3) return;
    if (emaFrame > 26) slowFor += dt;
    else slowFor = Math.max(0, slowFor - dt * 0.5);
    if (slowFor > 2.5) {
      tier = 'low';
      pixelRatio = 0; // force resize to pick up the new cap
      resize();
      applyTier();
    }
  }

  /* ── frame ───────────────────────────────────────────────── */
  let simErrLogged = false;
  let shadowTick = 0;
  let alarmSig = '';
  function frame(now) {
    raf = requestAnimationFrame(frame);
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
    env.groundU.uRect.value.z = 22 + 20 * mix.explode;
    env.groundU.uXray.value = 1 + 0.4 * mix.explode;

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
    const seen = new Set();
    for (const a of alarms) {
      const id = a?.target;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const c = new Vector3();
      const s = new Vector3();
      if (world.bboxFor(id, c, s)) list.push({ key: id, center: c, size: s });
      if (list.length >= 6) break;
    }
    fx.setAlarms(progress >= 0.4 ? list : [], selected);
    const sig = list.map((x) => x.key).join('|');
    if (sig !== alarmSig) alarmSig = sig;
    fx.update(clock, dt, { reducedMotion, scale: W / H < 0.85 ? 1.35 : 1 });

    labels.update(camera, world, { progress, W, H, mix, state });

    // shadows: refresh when the sun moves or geometry is animating
    shadowTick++;
    const animating = Math.abs(mix.explode - prevEx) > 1e-4 || world.levelState.some((l) => l.reveal.value > 0 && l.reveal.value < 1);
    if (tier === 'high' && (env.shadowDirty() || (animating && shadowTick % 2 === 0) || shadowTick % 90 === 0)) renderer.shadowMap.needsUpdate = true;

    composer.render(dt);
    watchPerf(dtMs, dt);
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
    renderer.shadowMap.needsUpdate = true;
    if (visible) start();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  // first frame: compile shaders up front so the intro doesn't hitch
  applyIntro();
  updateCamera(0, performance.now());
  try {
    const all = world.levelState.map((l) => l.reveal.value);
    world.levelState.forEach((l) => (l.reveal.value = 1));
    world.root.traverse((o) => (o.visible = true));
    await Promise.race([renderer.compileAsync(scene, camera), new Promise((r) => setTimeout(r, 2500))]);
    world.levelState.forEach((l, i) => (l.reveal.value = all[i]));
  } catch {
    /* compile errors surface on first render; nothing to do here */
  }
  introDirty = true;
  if (destroyed) return null;
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
      safe(() => world.dispose());
      safe(() => env.dispose());
      safe(() => bloom.dispose());
      safe(() => output.dispose());
      safe(() => renderPass.dispose?.());
      safe(() => composer.dispose());
      safe(() => rt.dispose());
      safe(() => envRT.dispose());
      safe(() => pmrem.dispose());
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
    api.debugInfo = () => ({ tier, pixelRatio, W, H, progress, mode, frame: emaFrame });
    api._dbg = { world, flows, env, scene, camera, renderer };
    window.__twinApp = api;
  }
  return api;
}
