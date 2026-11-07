/**
 * Digital Twin — shared helpers for the three.js modules.
 *
 * Small, dependency-light pieces used by world/flows/fx/env:
 *   - level bookkeeping (index from a y value, exploded-view offsets)
 *   - the "materialise" dissolve used by the scroll intro
 *   - thermal colour ramp
 *   - procedural canvas textures (no external assets)
 */
import {
  CanvasTexture,
  Color,
  DataTexture,
  FloatType,
  LinearMipmapLinearFilter,
  NearestFilter,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInOutCubic = (t) => {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
/** Frame-rate independent exponential approach. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
export const finite = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Deterministic PRNG (mulberry32) so the model looks the same on every visit. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── palette (sRGB hex → linear via three's colour management) ───── */

export const PALETTE = {
  sa: new Color('#4ea8ff'),
  ra: new Color('#7c8aa5'),
  chws: new Color('#38e1ff'),
  chwr: new Color('#1fa6c9'),
  hws: new Color('#ff8a3d'),
  hwr: new Color('#c8642c'),
  cws: new Color('#2ad1a6'),
  cwr: new Color('#1d9e7f'),
  accent: new Color('#4ea8ff'),
  accentSoft: new Color('#7ec0ff'),
  alarm: new Color('#ff4d5e'),
  warm: new Color('#ffc58a'),
  cool: new Color('#3d8bff'),
  neutral: new Color('#cfe0f2'),
  amber: new Color('#ffb03b'),
  hot: new Color('#ff4a2e'),
};

export const RUN_KINDS = ['sa', 'ra', 'chws', 'chwr', 'hws', 'hwr', 'cws', 'cwr'];

/**
 * Thermal ramp: ≤ SP-3 °F cool blue → SP neutral pale → ≥ SP+3 °F warm amber/red.
 * The ends stay at ±3 °F (the spec). A ±0.75 °F comfort deadband keeps a zone
 * that is holding setpoint neutral (the ±1 °F a well-run floor wanders reads as
 * a faint hint), so warm and cool only stand out when a zone is really drifting.
 * Writes into `out` (a Color) and returns it.
 */
export const thermalDev = (a) => Math.pow(clamp((Math.abs(a) - 0.25) / 0.75, 0, 1), 0.75);
export function thermalColor(delta, out) {
  const t0 = clamp(delta / 3, -1, 1);
  const t = Math.sign(t0) * thermalDev(t0);
  if (t < 0) return out.copy(PALETTE.neutral).lerp(PALETTE.cool, Math.pow(-t, 0.8));
  if (t < 0.7) return out.copy(PALETTE.neutral).lerp(PALETTE.amber, t / 0.7);
  return out.copy(PALETTE.amber).lerp(PALETTE.hot, (t - 0.7) / 0.3);
}
/** GLSL twin of thermalDev(): a = (temp - SP) / 3, clamped to ±1. */
export const GLSL_THERMAL = /* glsl */ `
float thermalDev(float a) { return pow(clamp((abs(a) - 0.25) / 0.75, 0.0, 1.0), 0.75); }
`;

/* ── levels ──────────────────────────────────────────────────────── */

/**
 * Builds level bookkeeping from sim.layout.levels.
 * Exploded offsets pull the stack apart in three readable groups:
 * B1 plant · L1–L3 (AHU-1) · L4–L6 (AHU-2) · roof plant.
 */
export function makeLevels(layout) {
  const levels = [...layout.levels].sort((a, b) => a.y - b.y);
  const ys = levels.map((l) => l.y);
  const explode = [];
  let k = 0;
  let last = 0;
  for (const l of levels) {
    if (l.kind === 'plant') explode.push(-6.5);
    else if (l.kind === 'roof') explode.push(last + 5.5);
    else {
      // offices: 3.6 m apart, with a wider jump between the AHU-1 and AHU-2 groups
      last = k * 3.6 + (k >= 3 ? 2.6 : 0);
      explode.push(last);
      k++;
    }
  }
  while (explode.length < 8) explode.push(last);
  const index = (y) => {
    let k = 0;
    for (let i = 1; i < ys.length; i++) if (y >= ys[i] - 0.001) k = i;
    return k;
  };
  const byId = new Map(levels.map((l, i) => [l.id, i]));
  return { list: levels, ys, explode, index, byId, count: levels.length };
}

/** GLSL: per-level vertical shift used by meshes built in world space (runs, particles). */
export const GLSL_LEVELS = /* glsl */ `
uniform float uLevelY[8];
uniform float uLevelOff[8];
float levelShift(float y) {
  float o = uLevelOff[0];
  for (int i = 1; i < 8; i++) { if (y >= uLevelY[i] - 0.001) o = uLevelOff[i]; }
  return o;
}
`;

/* ── dissolve ("materialise") for the scroll intro ───────────────── */

export const GLSL_NOISE = /* glsl */ `
float bHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float bNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(bHash(i), bHash(i + vec3(1, 0, 0)), f.x), mix(bHash(i + vec3(0, 1, 0)), bHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(bHash(i + vec3(0, 0, 1)), bHash(i + vec3(1, 0, 1)), f.x), mix(bHash(i + vec3(0, 1, 1)), bHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float buildNoise(vec3 p) { return 0.62 * bNoise(p * 0.55) + 0.38 * bNoise(p * 1.9); }
`;

/**
 * Fragment snippet: discards unrevealed fragments, leaves `bEdge` (0..1 glow at the front).
 * The front is a construction scan: it rises bottom-up through each level's
 * height, jittered per 2 m structural bay, so a floor reads as being built
 * rather than as static. vBuildP is level-local (y ≈ -0.4 … 4.2).
 */
export const GLSL_DISSOLVE = /* glsl */ `
  float bEdge = 0.0;
  if (uReveal < 0.999) {
    float bn = 0.7 * clamp((vBuildP.y + 0.6) / 4.6, 0.0, 1.0) + 0.3 * bHash(vec3(floor(vBuildP.xz / 2.0), 7.0));
    float th = uReveal * 1.25 - 0.12;
    if (bn > th) discard;
    bEdge = 1.0 - smoothstep(0.0, 0.07, th - bn);
  }
`;

const DISSOLVE_GLOW = 'vec3(0.32, 0.68, 1.0) * 2.2';

/**
 * Patches a built-in material (MeshStandardMaterial etc.) so a level's
 * `uReveal` uniform can dissolve it in with a glowing front.
 */
export function patchReveal(material, revealUniform) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uReveal = revealUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBuildP;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 bP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          bP = instanceMatrix * bP;
        #endif
        vBuildP = bP.xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vBuildP;\nuniform float uReveal;\n${GLSL_NOISE}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${GLSL_DISSOLVE}`);
    if (shader.fragmentShader.includes('#include <emissivemap_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\n totalEmissiveRadiance += ${DISSOLVE_GLOW} * bEdge;`,
      );
    } else {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `outgoingLight += ${DISSOLVE_GLOW} * bEdge;\n#include <opaque_fragment>`,
      );
    }
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `reveal|${key ? key() : ''}`;
  return material;
}

/**
 * The unit (ClarityView model) variant of patchReveal: the dissolve front is
 * measured in world space less the level's current origin (uLevelY, updated
 * with the intro drop and Exploded), so nested moving parts dissolve with the
 * casing instead of in their own local frame; and emissive radiance is scaled
 * by uUnitGlow (0.5 under bloom) so ClarityView's status bands read as small
 * lights. The program key keeps the material's own key (or its original
 * onBeforeCompile source) so two different original shaders never share a
 * program. Idempotent per material; returns the patch record.
 */
const UNIT_PATCHED = new WeakMap();
export function unitPatchOf(material) {
  return UNIT_PATCHED.get(material) || null;
}
export function patchUnitMaterial(material, { reveal, levelY, glow, level = 0, orig = null }) {
  const had = UNIT_PATCHED.get(material);
  if (had) return had;
  // capture the original before patching (a clone for another level passes the first one's)
  const base = orig || { obc: material.onBeforeCompile, key: material.customProgramCacheKey() };
  const prev = base.obc;
  material.onBeforeCompile = function (shader, renderer) {
    prev.call(this, shader, renderer);
    shader.uniforms.uReveal = reveal;
    shader.uniforms.uLevelY = levelY;
    shader.uniforms.uUnitGlow = glow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBuildP;\nuniform float uLevelY;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 bP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          bP = instanceMatrix * bP;
        #endif
        vBuildP = (modelMatrix * bP).xyz - vec3(0.0, uLevelY, 0.0);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vBuildP;\nuniform float uReveal;\nuniform float uUnitGlow;\n${GLSL_NOISE}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${GLSL_DISSOLVE}`);
    if (shader.fragmentShader.includes('#include <emissivemap_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\n totalEmissiveRadiance *= uUnitGlow;\n totalEmissiveRadiance += ${DISSOLVE_GLOW} * bEdge;`,
      );
    } else {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `outgoingLight += ${DISSOLVE_GLOW} * bEdge;\n#include <opaque_fragment>`,
      );
    }
  };
  material.customProgramCacheKey = () => `unit|${base.key}`;
  material.needsUpdate = true;
  const rec = { level, reveal, base };
  UNIT_PATCHED.set(material, rec);
  return rec;
}

/* ── data textures ───────────────────────────────────────────────── */

export function makeDataTexture(width, height) {
  const data = new Float32Array(width * height * 4);
  const tex = new DataTexture(data, width, height, RGBAFormat, FloatType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* ── procedural canvas textures ──────────────────────────────────── */

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function finishTex(c, { repeat = false, srgb = true, aniso = 4 } = {}) {
  const t = new CanvasTexture(c);
  if (srgb) t.colorSpace = SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

function speckle(ctx, w, h, count, alpha, rand, light = false) {
  for (let i = 0; i < count; i++) {
    const v = light ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},${(alpha * rand()).toFixed(3)})`;
    ctx.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2);
  }
}

/** Board-formed concrete with faint tie holes. */
export function concreteTexture() {
  const [c, x] = canvas(256, 256);
  const r = rng(11);
  x.fillStyle = '#8a8f96';
  x.fillRect(0, 0, 256, 256);
  speckle(x, 256, 256, 2600, 0.12, r);
  speckle(x, 256, 256, 1400, 0.1, r, true);
  x.strokeStyle = 'rgba(0,0,0,0.12)';
  x.lineWidth = 1;
  for (let i = 0; i <= 256; i += 64) {
    x.beginPath();
    x.moveTo(0, i + 0.5);
    x.lineTo(256, i + 0.5);
    x.stroke();
  }
  x.fillStyle = 'rgba(0,0,0,0.2)';
  for (let yy = 32; yy < 256; yy += 64) for (let xx = 32; xx < 256; xx += 64) x.fillRect(xx - 1.5, yy - 1.5, 3, 3);
  return finishTex(c, { repeat: true });
}

/** Painted sheet-metal casing with panel seams and latches (AHUs, chillers). */
export function panelTexture({ base = '#aab3bf', seams = 6, rows = 1 } = {}) {
  const [c, x] = canvas(512, 256);
  const r = rng(21);
  x.fillStyle = base;
  x.fillRect(0, 0, 512, 256);
  speckle(x, 512, 256, 1800, 0.05, r);
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, 'rgba(255,255,255,0.07)');
  g.addColorStop(1, 'rgba(0,0,0,0.12)');
  x.fillStyle = g;
  x.fillRect(0, 0, 512, 256);
  for (let i = 1; i < seams; i++) {
    const px = Math.round((i / seams) * 512);
    x.fillStyle = 'rgba(0,0,0,0.32)';
    x.fillRect(px - 1, 0, 2, 256);
    x.fillStyle = 'rgba(255,255,255,0.18)';
    x.fillRect(px + 1, 0, 1, 256);
    // latches
    x.fillStyle = 'rgba(20,24,30,0.55)';
    x.fillRect(px - 10, 110, 6, 18);
    x.fillRect(px - 10, 150, 6, 18);
  }
  for (let j = 1; j < rows + 1; j++) {
    const py = Math.round((j / (rows + 1)) * 256);
    x.fillStyle = 'rgba(0,0,0,0.22)';
    x.fillRect(0, py, 512, 2);
  }
  x.strokeStyle = 'rgba(0,0,0,0.35)';
  x.lineWidth = 4;
  x.strokeRect(2, 2, 508, 252);
  return finishTex(c);
}

/** Horizontal louvre slats (cooling tower sides, AHU outside-air intake). */
export function louverTexture({ base = '#5b6573', slats = 18 } = {}) {
  const [c, x] = canvas(128, 256);
  x.fillStyle = base;
  x.fillRect(0, 0, 128, 256);
  const step = 256 / slats;
  for (let i = 0; i < slats; i++) {
    const y = i * step;
    const g = x.createLinearGradient(0, y, 0, y + step);
    g.addColorStop(0, 'rgba(255,255,255,0.22)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.02)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0.25)');
    x.fillStyle = g;
    x.fillRect(0, y, 128, step);
  }
  x.fillStyle = 'rgba(0,0,0,0.4)';
  x.fillRect(0, 0, 3, 256);
  x.fillRect(125, 0, 3, 256);
  return finishTex(c, { repeat: true });
}

/** Roof membrane with seams and a walkway grid. */
export function roofTexture() {
  const [c, x] = canvas(256, 256);
  const r = rng(5);
  x.fillStyle = '#41464f';
  x.fillRect(0, 0, 256, 256);
  speckle(x, 256, 256, 2200, 0.1, r);
  speckle(x, 256, 256, 900, 0.06, r, true);
  x.fillStyle = 'rgba(0,0,0,0.25)';
  for (let i = 0; i < 256; i += 32) x.fillRect(0, i, 256, 1);
  return finishTex(c, { repeat: true });
}

/** Soft radial glow sprite. */
export function glowTexture() {
  const [c, x] = canvas(128, 128);
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return finishTex(c, { srgb: false });
}

/** Alarm callout icon: ring + exclamation, drawn white (tinted by material). */
export function alarmIconTexture() {
  const [c, x] = canvas(128, 128);
  x.strokeStyle = '#fff';
  x.lineWidth = 7;
  x.beginPath();
  x.arc(64, 64, 44, 0, Math.PI * 2);
  x.stroke();
  x.fillStyle = 'rgba(255,255,255,0.18)';
  x.beginPath();
  x.arc(64, 64, 40, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = '#fff';
  x.beginPath();
  x.roundRect(58, 34, 12, 38, 6);
  x.fill();
  x.beginPath();
  x.arc(64, 87, 7, 0, Math.PI * 2);
  x.fill();
  return finishTex(c, { srgb: false });
}
