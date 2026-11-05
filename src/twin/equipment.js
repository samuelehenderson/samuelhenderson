/**
 * Digital Twin — mechanical equipment models built from primitives.
 *
 *   buildEquipment(eq, ctx) → { group, update(state, dt, t, opts), dispose }
 *
 * eq comes straight from sim.layout.equipment (origin = centre of the base,
 * w along x, d along z). Moving parts and glows read live sim state:
 * AHU fans by fan speed, coil windows by valve %, tower fan by tower fan %,
 * chillers by load (red when tripped), boiler flame by firing rate.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  RepeatWrapping,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Points,
  BufferGeometry,
  Float32BufferAttribute,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE, clamp, damp, finite, glowTexture, louverTexture, panelTexture, patchReveal } from './shared.js';

const STATUS = {
  run: new Color('#2ad1a6'),
  off: new Color('#3a4250'),
  alarm: new Color('#ff4d5e'),
  warn: new Color('#ffb547'),
};

/** Cylinder whose axis runs along x / y / z, centred at (x, y, z). */
function cyl(r, len, axis, x, y, z, seg = 20, open = false) {
  const g = new CylinderGeometry(r, r, len, seg, 1, open);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}
const box = (w, h, d, x, y, z) => new BoxGeometry(w, h, d).translate(x, y, z);

function fanGeometry(radius, blades = 6, pitch = 0.42) {
  const parts = [cyl(radius * 0.2, 0.14, 'y', 0, 0, 0, 16)];
  for (let i = 0; i < blades; i++) {
    const b = new BoxGeometry(radius * 0.8, 0.03, radius * 0.3);
    b.rotateX(pitch);
    b.translate(radius * 0.58, 0, 0);
    b.rotateY((i / blades) * Math.PI * 2);
    parts.push(b);
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  parts.forEach((p) => p.dispose());
  return g;
}

function guardGeometry(radius) {
  const parts = [new TorusGeometry(radius, 0.025, 6, 40).rotateX(Math.PI / 2), new TorusGeometry(radius * 0.55, 0.02, 6, 32).rotateX(Math.PI / 2)];
  parts.push(new BoxGeometry(radius * 2, 0.03, 0.04), new BoxGeometry(0.04, 0.03, radius * 2));
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  parts.forEach((p) => p.dispose());
  return g;
}

function merged(parts) {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  parts.forEach((p) => p.dispose());
  return g;
}

export function buildEquipment(eq, ctx) {
  const builders = { ahu: buildAhu, tower: buildTower, chiller: buildChiller, boiler: buildBoiler, pump: buildPump };
  const fn = builders[eq.kind];
  if (!fn) return null;
  const group = new Group();
  group.name = eq.id;
  const own = ctx.own;
  const mats = [];
  const std = (opts) => {
    const m = patchReveal(new MeshStandardMaterial(opts), ctx.reveal);
    mats.push(m);
    return own(m);
  };
  const basic = (color, extra = {}) => {
    const m = new MeshBasicMaterial({ color, toneMapped: true, ...extra });
    mats.push(m);
    return own(m);
  };
  const add = (geo, mat, { cast = true, receive = false } = {}) => {
    own(geo);
    const m = new Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    group.add(m);
    return m;
  };
  const tex = ctx.tex || ((key, f) => own(f()));
  const api = fn(eq, { group, std, basic, add, tex, own, quality: ctx.quality });
  return { group, update: api.update, dispose: api.dispose, setPixelRatio: api.setPixelRatio };
}

/* ── rooftop air handler ───────────────────────────────────────── */
function buildAhu(eq, k) {
  const { std, basic, add, tex, own } = k;
  const w = eq.w;
  const d = eq.d;
  const h = eq.h;
  const casingTex = tex('ahuPanel', () => panelTexture({ base: '#b9c1cc', seams: 7, rows: 1 }));
  const louvTex = tex('louver', () => louverTexture({ base: '#4f5967', slats: 16 }));
  const casing = std({ color: '#c3cad4', map: casingTex, roughness: 0.48, metalness: 0.35 });
  const dark = std({ color: '#262d37', roughness: 0.5, metalness: 0.6 });
  const steel = std({ color: '#8d96a2', roughness: 0.32, metalness: 0.85 });
  const louver = std({ color: '#ffffff', map: louvTex, roughness: 0.6, metalness: 0.4 });

  const baseH = 0.24;
  const ch = h - baseH - 0.1;
  add(box(w + 0.12, baseH, d + 0.12, 0, baseH / 2, 0), dark, { receive: true });
  add(box(w, ch, d, 0, baseH + ch / 2, 0), casing, { receive: true });
  add(box(w + 0.14, 0.09, d + 0.14, 0, baseH + ch + 0.045, 0), steel);
  // outside-air intake hood + louvre on the return/mixing end (+x)
  const lv = new PlaneGeometry(d - 0.4, ch * 0.62);
  lv.rotateY(Math.PI / 2);
  lv.translate(w / 2 + 0.012, baseH + ch * 0.55, 0);
  add(lv, louver, { cast: false });
  const hood = box(0.55, 0.08, d - 0.2, w / 2 + 0.27, baseH + ch * 0.9, 0);
  hood.rotateZ(0);
  add(hood, dark);
  // section seams (thin dark frames) to read as modules
  const frames = [];
  for (const x of [-w / 2 + 2.2, -0.9, 1.9, w / 2 - 1.5]) frames.push(box(0.06, ch + 0.02, d + 0.03, x, baseH + ch / 2, 0));
  add(merged(frames), dark, { cast: false });

  // coil windows on both long sides (CHW cyan, HW orange), glow by valve %
  const chwMat = basic(PALETTE.chws.clone());
  const hwMat = basic(PALETTE.hws.clone());
  const finTex = tex('fins', () => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 16;
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, 64, 16);
    x.fillStyle = 'rgba(0,0,0,0.55)';
    for (let i = 0; i < 64; i += 4) x.fillRect(i, 0, 1.5, 16);
    const t = new CanvasTexture(c);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.set(3, 1);
    return t;
  });
  chwMat.map = finTex;
  hwMat.map = finTex;
  for (const side of [1, -1]) {
    const p1 = new PlaneGeometry(1.1, ch * 0.62);
    if (side < 0) p1.rotateY(Math.PI);
    p1.translate(0.75, baseH + ch * 0.5, side * (d / 2 + 0.012));
    add(p1, chwMat, { cast: false });
    const p2 = new PlaneGeometry(0.7, ch * 0.62);
    if (side < 0) p2.rotateY(Math.PI);
    p2.translate(-0.3, baseH + ch * 0.5, side * (d / 2 + 0.012));
    add(p2, hwMat, { cast: false });
  }

  // fans on top: supply (west, -x) and return/relief (east, +x)
  const fanR = 0.82;
  const top = baseH + ch + 0.09;
  const fans = [];
  const fanGeo = own(fanGeometry(fanR * 0.92, 7));
  const guardGeo = own(guardGeometry(fanR));
  const fanMat = steel;
  for (const [x, key] of [
    [-w / 2 + 1.35, 'sfSpeed'],
    [w / 2 - 2.3, 'rfSpeed'],
  ]) {
    const shroud = cyl(fanR + 0.06, 0.5, 'y', x, top + 0.25, 0, 32, true);
    const m = add(shroud, dark);
    m.material = dark;
    const ring = cyl(fanR + 0.14, 0.06, 'y', x, top + 0.03, 0, 32);
    add(ring, dark);
    const rotor = new Mesh(fanGeo, fanMat);
    rotor.position.set(x, top + 0.3, 0);
    rotor.castShadow = false;
    k.group.add(rotor);
    const guard = new Mesh(guardGeo, dark);
    guard.position.set(x, top + 0.5, 0);
    k.group.add(guard);
    fans.push({ rotor, key, speed: 0 });
  }
  dark.side = DoubleSide;

  // status lamp
  const lampMat = basic(STATUS.run.clone());
  add(box(0.18, 0.1, 0.05, -w / 2 + 0.5, baseH + ch - 0.25, d / 2 + 0.03), lampMat, { cast: false });
  add(box(0.18, 0.1, 0.05, -w / 2 + 0.5, baseH + ch - 0.25, -d / 2 - 0.03), lampMat, { cast: false });

  let chw = 0;
  let hw = 0;
  return {
    update(state, dt, t, { reducedMotion }) {
      const a = state?.ahus?.[eq.id] || {};
      const pace = reducedMotion ? 0.3 : 1;
      for (const f of fans) {
        const target = a.on === false ? 0 : clamp(finite(a[f.key], 0) / 100, 0, 1);
        f.speed = damp(f.speed, target, 1.2, dt);
        f.rotor.rotation.y -= f.speed * 16 * pace * dt;
      }
      chw = damp(chw, clamp(finite(a.ccv, 0) / 100, 0, 1), 3, dt);
      hw = damp(hw, clamp(finite(a.hcv, 0) / 100, 0, 1), 3, dt);
      chwMat.color.copy(PALETTE.chws).multiplyScalar(0.12 + 2.4 * chw);
      hwMat.color.copy(PALETTE.hws).multiplyScalar(0.12 + 2.4 * hw);
      const alarm = !!a.alarm;
      const on = a.on !== false;
      const pulse = 0.5 + 0.5 * Math.sin(t * 6);
      if (alarm) lampMat.color.copy(STATUS.alarm).multiplyScalar(1 + 2.5 * pulse);
      else lampMat.color.copy(on ? STATUS.run : STATUS.off).multiplyScalar(on ? 2.4 : 1);
    },
  };
}

/* ── cooling tower ─────────────────────────────────────────────── */
function buildTower(eq, k) {
  const { std, basic, add, tex, own, group } = k;
  const w = eq.w;
  const d = eq.d;
  const h = eq.h;
  const louvTex = tex('towerLouver', () => louverTexture({ base: '#6f7a88', slats: 22 }));
  const body = std({ color: '#ffffff', map: louvTex, roughness: 0.65, metalness: 0.25 });
  const frame = std({ color: '#2a313b', roughness: 0.5, metalness: 0.6 });
  const steel = std({ color: '#9aa3ae', roughness: 0.3, metalness: 0.85 });
  const basinH = 0.55;
  const bodyH = h - basinH - 0.9;
  add(box(w, basinH, d, 0, basinH / 2, 0), frame, { receive: true });
  add(box(w - 0.08, bodyH, d - 0.08, 0, basinH + bodyH / 2, 0), body, { receive: true });
  // corner posts
  const posts = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) posts.push(box(0.14, bodyH + 0.02, 0.14, (sx * (w - 0.1)) / 2, basinH + bodyH / 2, (sz * (d - 0.1)) / 2));
  add(merged(posts), frame);
  const deckY = basinH + bodyH;
  add(box(w + 0.08, 0.16, d + 0.08, 0, deckY + 0.08, 0), frame);
  const R = Math.min(w, d) * 0.36;
  const stack = cyl(R + 0.05, 0.8, 'y', 0, deckY + 0.16 + 0.4, 0, 40, true);
  frame.side = DoubleSide;
  add(stack, frame);
  add(cyl(R + 0.14, 0.08, 'y', 0, deckY + 0.16 + 0.8, 0, 40), frame);
  const fanGeo = own(fanGeometry(R * 0.95, 8, 0.36));
  const rotor = new Mesh(fanGeo, steel);
  rotor.position.set(0, deckY + 0.55, 0);
  group.add(rotor);
  const guard = new Mesh(own(guardGeometry(R + 0.05)), frame);
  guard.position.set(0, deckY + 0.98, 0);
  group.add(guard);
  // water curtain glow inside the louvres (teal by condenser heat)
  const curtain = basic(PALETTE.cws.clone(), { transparent: true, opacity: 0.6, depthWrite: false });
  for (const side of [1, -1]) {
    const p = new PlaneGeometry(w - 0.5, bodyH * 0.85);
    if (side < 0) p.rotateY(Math.PI);
    p.translate(0, basinH + bodyH / 2, side * (d / 2 - 0.25));
    add(p, curtain, { cast: false });
    const q = new PlaneGeometry(d - 0.5, bodyH * 0.85);
    q.rotateY(side * (Math.PI / 2));
    q.translate(side * (w / 2 - 0.25), basinH + bodyH / 2, 0);
    add(q, curtain, { cast: false });
  }

  // vapour plume (soft additive sprites rising from the fan stack)
  const n = k.quality === 'low' ? 24 : 44;
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  for (let i = 0; i < n; i++) seed[i] = i / n + Math.random() * 0.02;
  const pg = own(new BufferGeometry());
  pg.setAttribute('position', new Float32BufferAttribute(pos, 3));
  pg.setAttribute('aSeed', new Float32BufferAttribute(seed, 1));
  const plumeMat = own(
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uAmt: { value: 0 },
        uR: { value: R },
        uMap: { value: tex('glow', glowTexture) },
        uPx: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime, uAmt, uR, uPx;
        varying float vA;
        void main() {
          float t = fract(uTime * 0.07 + aSeed);
          float a = aSeed * 43.0;
          vec3 p = vec3(cos(a) * uR * 0.6 * (0.3 + t), t * 9.0, sin(a) * uR * 0.6 * (0.3 + t));
          p.x += t * t * 2.5;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (3.5 + t * 11.0) * uPx * 120.0 / -mv.z;
          vA = uAmt * smoothstep(0.0, 0.15, t) * (1.0 - t);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying float vA;
        void main() {
          float m = texture2D(uMap, gl_PointCoord).r;
          gl_FragColor = vec4(vec3(0.75, 0.85, 1.0) * m * m * vA * 0.1, 1.0);
        }`,
    }),
  );
  const plume = new Points(pg, plumeMat);
  plume.position.set(0, deckY + 0.9, 0);
  plume.frustumCulled = false;
  plume.renderOrder = 7;
  group.add(plume);

  let speed = 0;
  let amt = 0;
  return {
    update(state, dt, t, { reducedMotion }) {
      const tw = state?.plant?.tower || {};
      const on = !!tw.on;
      speed = damp(speed, on ? clamp(finite(tw.fan, 0) / 100, 0, 1) : 0, 1.0, dt);
      rotor.rotation.y += speed * 10 * (reducedMotion ? 0.3 : 1) * dt;
      const heat = clamp(finite(tw.heat, 0) / 140, 0, 1);
      amt = damp(amt, on ? 0.35 + 0.65 * heat : 0, 1.5, dt);
      plumeMat.uniforms.uTime.value = reducedMotion ? t * 0.3 : t;
      plumeMat.uniforms.uAmt.value = amt;
      curtain.color.copy(PALETTE.cws).multiplyScalar(0.05 + 0.5 * amt);
    },
    setPixelRatio(px) {
      plumeMat.uniforms.uPx.value = px;
    },
  };
}

/* ── water-cooled chiller ──────────────────────────────────────── */
function buildChiller(eq, k) {
  const { std, basic, add, group } = k;
  const w = eq.w;
  const d = eq.d;
  const paint = std({ color: '#5f7488', roughness: 0.42, metalness: 0.45 });
  const shell = std({ color: '#7f93a8', roughness: 0.38, metalness: 0.5 });
  const dark = std({ color: '#222a33', roughness: 0.5, metalness: 0.6 });
  const steel = std({ color: '#a7b0bb', roughness: 0.28, metalness: 0.85 });
  add(box(w, 0.2, d, 0, 0.1, 0), dark, { receive: true });
  const L = w - 1.0;
  const r = 0.5;
  // evaporator (front, +z) and condenser (back)
  add(cyl(r, L, 'x', 0, 0.78, d * 0.22, 28), shell);
  add(cyl(r * 0.92, L, 'x', 0, 0.72, -d * 0.22, 28), shell);
  // water boxes at both ends
  const boxes = [];
  for (const sx of [-1, 1])
    for (const [zz, rr, yy] of [
      [d * 0.22, r + 0.04, 0.78],
      [-d * 0.22, r * 0.92 + 0.04, 0.72],
    ])
      boxes.push(cyl(rr, 0.28, 'x', sx * (L / 2 + 0.14), yy, zz, 28));
  add(merged(boxes), paint);
  // supports
  const sup = [];
  for (const sx of [-0.35, 0.35]) sup.push(box(0.18, 0.5, d * 0.9, sx * L, 0.45, 0));
  add(merged(sup), dark);
  // compressor + motor on top
  add(cyl(0.44, 1.6, 'x', 0.55, 1.78, 0, 24), paint);
  add(cyl(0.38, 1.2, 'x', -0.9, 1.78, 0, 24), steel);
  add(cyl(0.2, 0.7, 'y', 0.9, 1.35, 0, 16), paint);
  // control panel
  add(box(0.95, 1.45, 0.38, -w / 2 + 0.75, 1.0, d / 2 - 0.12), paint);
  const screen = basic(PALETTE.chws.clone());
  add(box(0.5, 0.32, 0.02, -w / 2 + 0.75, 1.35, d / 2 + 0.08), screen, { cast: false });
  // load glow: light strips along the evaporator
  const glow = basic(PALETTE.chws.clone());
  const strips = [];
  for (const yy of [0.5, 1.06]) strips.push(box(L * 0.9, 0.035, 0.03, 0, yy, d * 0.22 + r + 0.005));
  for (let i = 0; i < 4; i++) strips.push(cyl(r + 0.012, 0.05, 'x', -L * 0.36 + i * L * 0.24, 0.78, d * 0.22, 28));
  add(merged(strips), glow, { cast: false });
  group.userData.glowMat = glow;

  let load = 0;
  return {
    update(state, dt, t) {
      const c = state?.plant?.chillers?.[eq.id] || {};
      const st = c.status || (c.on ? 'running' : 'off');
      load = damp(load, c.on ? clamp(finite(c.load, 0) / 100, 0, 1) : 0, 2, dt);
      const pulse = 0.5 + 0.5 * Math.sin(t * 6);
      if (st === 'tripped' || c.alarm) {
        glow.color.copy(PALETTE.alarm).multiplyScalar(0.4 + 2.2 * pulse);
        screen.color.copy(PALETTE.alarm).multiplyScalar(1 + 2 * pulse);
      } else if (st === 'starting') {
        glow.color.copy(STATUS.warn).multiplyScalar(0.6 + 1.6 * pulse);
        screen.color.copy(STATUS.warn).multiplyScalar(1.6);
      } else {
        glow.color.copy(PALETTE.chws).multiplyScalar(0.05 + 0.85 * load);
        screen.color.copy(c.on ? PALETTE.chws : STATUS.off).multiplyScalar(c.on ? 1.8 : 0.8);
      }
    },
  };
}

/* ── fire-tube boiler ──────────────────────────────────────────── */
function buildBoiler(eq, k) {
  const { std, basic, add, group, tex } = k;
  const w = eq.w;
  const d = eq.d;
  const h = eq.h;
  const body = std({ color: '#4f5e70', roughness: 0.42, metalness: 0.4 });
  const steel = std({ color: '#a9b1bb', roughness: 0.3, metalness: 0.85 });
  const dark = std({ color: '#232a33', roughness: 0.5, metalness: 0.6 });
  add(box(w, 0.16, d, 0, 0.08, 0), dark, { receive: true });
  const R = Math.min(h, d) * 0.43;
  const len = w - 0.9;
  add(cyl(R, len, 'x', -0.25, R + 0.2, 0, 32), body);
  add(cyl(R + 0.04, 0.12, 'x', -0.25 - len / 2, R + 0.2, 0, 32), steel);
  add(cyl(R + 0.04, 0.12, 'x', -0.25 + len / 2, R + 0.2, 0, 32), steel);
  // burner housing on the +x end with a flame window
  const bx = -0.25 + len / 2 + 0.33;
  add(box(0.55, 0.95, 0.95, bx, R + 0.2, 0), dark);
  const flame = basic(new Color('#ff7a2a'));
  const win = new PlaneGeometry(0.34, 0.34);
  win.rotateY(Math.PI / 2);
  win.translate(bx + 0.28, R + 0.2, 0);
  add(win, flame, { cast: false });
  // stack to the ceiling
  add(cyl(0.22, 4.3 - (2 * R + 0.2), 'y', -0.25 - len / 2 + 0.6, 2 * R + 0.2 + (4.3 - (2 * R + 0.2)) / 2, 0, 16), steel);
  // glow sprite in front of the burner
  const spriteMat = new SpriteMaterial({ map: tex('glow', glowTexture), color: new Color('#ff8a3d'), blending: AdditiveBlending, depthWrite: false, transparent: true });
  k.own(spriteMat);
  const glow = new Sprite(spriteMat);
  glow.position.set(bx + 0.55, R + 0.2, 0);
  glow.scale.setScalar(1.8);
  glow.renderOrder = 7;
  group.add(glow);
  let fire = 0;
  return {
    update(state, dt, t, { reducedMotion }) {
      const b = state?.plant?.boiler || {};
      fire = damp(fire, b.on ? clamp(0.25 + finite(b.fire, 0) / 100, 0, 1.25) : 0, 3, dt);
      const flick = reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(t * 23.0) * Math.sin(t * 7.3 + 1.0);
      flame.color.set('#ff7a2a').multiplyScalar(0.12 + 3.2 * fire * flick);
      spriteMat.opacity = clamp(fire * 0.85 * flick, 0, 1);
      glow.visible = fire > 0.02;
      glow.scale.setScalar(1.2 + fire * 1.4);
    },
  };
}

/* ── inline pump ───────────────────────────────────────────────── */
function buildPump(eq, k) {
  const { std, basic, add, group } = k;
  const tint = eq.id.startsWith('HWP') ? '#a85a2c' : eq.id.startsWith('CWP') ? '#2c8f78' : '#2b88a6';
  const motor = std({ color: tint, roughness: 0.42, metalness: 0.45 });
  const dark = std({ color: '#262d36', roughness: 0.5, metalness: 0.6 });
  const steel = std({ color: '#a4adb8', roughness: 0.3, metalness: 0.85 });
  add(box(eq.w, 0.12, eq.d, 0, 0.06, 0), dark, { receive: true });
  add(cyl(0.24, 0.62, 'x', -0.28, 0.44, 0, 20), motor);
  add(cyl(0.3, 0.26, 'z', 0.36, 0.44, 0, 24), steel);
  add(cyl(0.1, 0.5, 'y', 0.36, 0.8, 0, 12), steel);
  const coupling = new Mesh(k.own(merged([cyl(0.12, 0.09, 'x', 0, 0, 0, 16), box(0.1, 0.06, 0.26, 0, 0, 0)])), steel);
  coupling.position.set(0.08, 0.44, 0);
  group.add(coupling);
  const lamp = basic(STATUS.run.clone());
  add(box(0.06, 0.06, 0.06, -0.55, 0.25, eq.d / 2 - 0.05), lamp, { cast: false });
  let speed = 0;
  return {
    update(state, dt, t, { reducedMotion }) {
      const p = state?.plant?.pumps?.[eq.id] || {};
      speed = damp(speed, p.on ? clamp(finite(p.speed, 0) / 100, 0, 1) : 0, 1.5, dt);
      coupling.rotation.x += speed * 22 * (reducedMotion ? 0.25 : 1) * dt;
      lamp.color.copy(p.on ? STATUS.run : STATUS.off).multiplyScalar(p.on ? 2.6 : 1);
    },
  };
}
