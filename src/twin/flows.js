/**
 * Digital Twin — service runs (ducts and pipes) with live flow.
 *
 * Every run in sim.layout.runs becomes ducts (air) or pipes (water) merged
 * into two meshes: one draw call for air, one for water. Each vertex knows
 * its run index and arc length; a 256×1 float texture carries every run's
 * live flow (0..1) and its integrated phase, so the comet-like pulses travel
 * at a speed proportional to the fan/pump and stop dead when it stops.
 *
 * The same texture drives the diffuser "air puffs" below each VAV (Airflow
 * mode). Exploded mode shifts vertices per level in the vertex shader.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  GreaterDepth,
  Group,
  Mesh,
  Points,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLSL_LEVELS, PALETTE, RUN_KINDS, clamp, finite, glowTexture, makeDataTexture } from './shared.js';

const AIR = new Set(['sa', 'ra']);
const SPACING = { sa: 3.4, ra: 4.2, chws: 2.4, chwr: 2.4, hws: 2.2, hwr: 2.2, cws: 2.6, cwr: 2.6 };
const SPEED = { sa: 7.5, ra: 5.5, chws: 4.2, chwr: 4.2, hws: 3.6, hwr: 3.6, cws: 4.6, cwr: 4.6 };
// Live-mode emphasis per kind (RUN_KINDS order): the water services need a lift
// to hold their own next to the big supply-air ducts
const LIVE_EMPH = [1, 1, 1.4, 1.15, 1.4, 1.15, 1, 1];

function revealWindow(run, levels) {
  const lvl = run.level;
  const li = lvl ? levels.byId.get(lvl) ?? 0 : 0;
  if (lvl === 'B1') return [0.0, 0.22];
  if (!lvl) return [0.12, 0.34];
  if (lvl === 'RF') return [0.42, 0.2];
  const branch = /-L\d+-\d+$/.test(run.id);
  if (branch) return [0.52 + li * 0.045, 0.14];
  return [0.32 + li * 0.05, 0.2];
}

export async function createFlows({ layout, levels, levelU, modeU, ctxU, quality, pause = null }) {
  // `pause` (optional) yields to the browser between the heavy merges
  const breathe = async () => {
    if (typeof pause === 'function') await pause();
  };
  const group = new Group();
  group.name = 'services';
  const disposables = [];
  const runs = layout.runs;
  const runIndex = new Map(runs.map((r, i) => [r.id, i]));
  const flowTex = makeDataTexture(256, 1);
  disposables.push(flowTex);
  const fdata = flowTex.image.data;
  const phase = new Float32Array(runs.length);
  // how strongly each run shows through walls and slabs (x-ray pass)
  runs.forEach((r, i) => {
    let w = 0;
    if (!r.level) w = 1;
    else if (r.level === 'B1') w = 0.9;
    else if (r.level === 'RF') w = 0.6;
    else if (/-L\d+-\d+$/.test(r.id)) w = 0;
    else if (r.kind === 'sa') w = 0.5;
    else if (r.kind === 'ra') w = 0.22;
    else if (r.kind === 'hws' || r.kind === 'hwr') w = 0.3; // per-floor reheat loops
    else w = 0.14;
    fdata[i * 4 + 2] = w;
  });
  const flowNow = new Float32Array(runs.length);

  const up = new Vector3(0, 1, 0);
  const q = new Quaternion();
  const a = new Vector3();
  const b = new Vector3();
  const dir = new Vector3();

  function buildKind(isAir) {
    const parts = [];
    runs.forEach((run, ri) => {
      if (AIR.has(run.kind) !== isAir) return;
      const kindIdx = RUN_KINDS.indexOf(run.kind);
      const pts = run.points;
      if (!Array.isArray(pts) || pts.length < 2) return;
      let total = 0;
      for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
      if (!(total > 0)) return;
      const [rs, rd] = revealWindow(run, levels);
      const size = finite(run.size, 0.2);
      let s0 = 0;
      for (let i = 1; i < pts.length; i++) {
        a.fromArray(pts[i - 1]);
        b.fromArray(pts[i]);
        const len = a.distanceTo(b);
        if (len < 1e-4) continue;
        dir.subVectors(b, a).normalize();
        let geo;
        let ext;
        if (isAir) {
          const wDim = Math.max(0.28, size);
          const hDim = Math.max(0.22, size * 0.62);
          ext = wDim / 2;
          const L = len + ext * 2;
          if (Math.abs(dir.y) > 0.9) geo = new BoxGeometry(wDim, L, wDim * 0.85);
          else if (Math.abs(dir.x) > 0.9) geo = new BoxGeometry(L, hDim, wDim);
          else geo = new BoxGeometry(wDim, hDim, L);
        } else {
          const r = Math.max(0.065, size * 0.55);
          ext = r * 0.2;
          geo = new CylinderGeometry(r, r, len + ext * 2, 10, 1, false);
          q.setFromUnitVectors(up, dir);
          geo.applyQuaternion(q);
        }
        const mid = a.clone().add(b).multiplyScalar(0.5);
        geo.translate(mid.x, mid.y, mid.z);
        const g2 = geo.toNonIndexed();
        geo.dispose();
        tagSegment(g2, a, dir, s0, ri, kindIdx, rs, rd, total);
        parts.push(g2);
        // elbows on pipes
        if (!isAir && i < pts.length - 1) {
          const r = Math.max(0.065, size * 0.55);
          const sph = new SphereGeometry(r * 1.08, 10, 6).translate(b.x, b.y, b.z).toNonIndexed();
          tagSegment(sph, b, dir, s0 + len, ri, kindIdx, rs, rd, total, true);
          parts.push(sph);
        }
        s0 += len;
      }
    });
    if (!parts.length) return null;
    const g = mergeGeometries(parts);
    parts.forEach((p) => p.dispose());
    return g;
  }

  function tagSegment(g, origin, d, s0, ri, kindIdx, rs, rd, total, fixed = false) {
    const pos = g.attributes.position;
    const n = pos.count;
    const aS = new Float32Array(n);
    const aRev = new Float32Array(n);
    const v = new Vector3();
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i);
      const s = fixed ? s0 : s0 + v.sub(origin).dot(d);
      aS[i] = s;
      aRev[i] = rs + rd * clamp(s / total, 0, 1);
    }
    g.setAttribute('aS', new BufferAttribute(aS, 1));
    g.setAttribute('aRev', new BufferAttribute(aRev, 1));
    g.setAttribute('aRun', new BufferAttribute(new Float32Array(n).fill(ri), 1));
    g.setAttribute('aKind', new BufferAttribute(new Float32Array(n).fill(kindIdx), 1));
    if (g.attributes.uv) g.deleteAttribute('uv');
  }

  const colors = RUN_KINDS.map((k) => PALETTE[k].clone());
  const spacing = RUN_KINDS.map((k) => SPACING[k]);
  const emph = RUN_KINDS.map(() => 1);
  const sharedU = {
    uFlowTex: { value: flowTex },
    uColors: { value: colors },
    uSpacing: { value: spacing },
    uEmph: { value: emph },
    uReveal: { value: 1 },
    uDay: ctxU.day,
    uTime: ctxU.time,
    uLevelY: levelU.uLevelY,
    uLevelOff: levelU.uLevelOff,
    uHi: { value: -1 },
  };

  const RUN_VERT = /* glsl */ `
        attribute float aRun, aS, aRev, aKind;
        uniform sampler2D uFlowTex;
        ${GLSL_LEVELS}
        varying vec3 vN; varying vec3 vWP; varying float vS; varying float vFlow; varying float vRev; varying float vKind; varying float vRun; varying float vXw;
        void main() {
          vec3 p = position;
          p.y += levelShift(position.y);
          vec4 f = texture2D(uFlowTex, vec2((aRun + 0.5) / 256.0, 0.5));
          vFlow = f.r;
          vXw = f.b;
          vS = aS - f.g;
          vRev = aRev;
          vKind = aKind;
          vRun = aRun;
          vN = normal;
          vWP = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`;
  function runMaterial() {
    return new ShaderMaterial({
      uniforms: { ...sharedU, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: true,
      vertexShader: RUN_VERT,
      fragmentShader: /* glsl */ `
        uniform vec3 uColors[8];
        uniform float uSpacing[8];
        uniform float uEmph[8];
        uniform float uReveal, uDay, uTime, uOpacity, uHi;
        varying vec3 vN; varying vec3 vWP; varying float vS; varying float vFlow; varying float vRev; varying float vKind; varying float vRun; varying float vXw;
        void main() {
          if (vRev > uReveal) discard;
          int k = int(vKind + 0.5);
          vec3 c = uColors[k];
          float em = uEmph[k];
          vec3 N = normalize(vN);
          vec3 V = normalize(cameraPosition - vWP);
          float diff = 0.5 + 0.5 * max(dot(N, normalize(vec3(0.35, 1.0, 0.45))), 0.0);
          float rim = pow(1.0 - abs(dot(N, V)), 2.0);
          float on = smoothstep(0.02, 0.18, vFlow);
          vec3 col = c * (0.16 + 0.3 * diff) * (0.25 + 0.75 * on) + c * rim * (0.3 + 0.4 * on);
          float d = fract(vS / uSpacing[k]);
          float comet = pow(d, 5.0) * (1.0 - smoothstep(0.965, 1.0, d));
          col += c * comet * (0.4 + 0.6 * vFlow) * on * 4.2;
          // hot water carries a little warmth of its own
          if (k == 4 || k == 5) col += c * (0.08 + 0.14 * on);
          // condenser water is dashed (marching with the flow) so it never reads as chilled water
          if (k >= 6) col *= mix(0.28, 1.0, step(0.5, fract(vS / 1.1)));
          // drawing-in tip during the intro
          if (uReveal < 0.999) col += c * 4.0 * smoothstep(uReveal - 0.025, uReveal, vRev);
          col *= em;
          if (abs(vRun - uHi) < 0.5) col += c * 0.8;
          gl_FragColor = vec4(col, uOpacity);
        }`,
    });
  }

  // x-ray: the parts of every run hidden behind slabs and walls still read
  // as faint moving light (drawn only where something else is in front)
  function xrayMaterial() {
    return new ShaderMaterial({
      uniforms: { ...sharedU, uXray: { value: 1 } },
      transparent: true,
      depthWrite: false,
      depthFunc: GreaterDepth,
      blending: AdditiveBlending,
      vertexShader: RUN_VERT,
      fragmentShader: /* glsl */ `
        uniform vec3 uColors[8];
        uniform float uSpacing[8];
        uniform float uEmph[8];
        uniform float uReveal, uXray;
        varying vec3 vN; varying vec3 vWP; varying float vS; varying float vFlow; varying float vRev; varying float vKind; varying float vRun; varying float vXw;
        void main() {
          if (vRev > uReveal || vXw < 0.01) discard;
          int k = int(vKind + 0.5);
          vec3 c = uColors[k];
          float on = smoothstep(0.02, 0.18, vFlow);
          float d = fract(vS / uSpacing[k]);
          float comet = pow(d, 5.0) * (1.0 - smoothstep(0.965, 1.0, d));
          vec3 col = c * (0.03 + 0.02 * on + comet * on * 0.42) * uEmph[k] * uXray * vXw;
          if (k >= 6) col *= mix(0.28, 1.0, step(0.5, fract(vS / 1.1)));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
  }

  const airGeo = buildKind(true);
  await breathe();
  const waterGeo = buildKind(false);
  await breathe();
  const airMat = runMaterial();
  const waterMat = runMaterial();
  const airX = xrayMaterial();
  const waterX = xrayMaterial();
  disposables.push(airMat, waterMat, airX, waterX);
  let airMesh = null;
  let waterMesh = null;
  if (airGeo) {
    airMesh = new Mesh(airGeo, airMat);
    airMesh.frustumCulled = false;
    airMesh.renderOrder = 1;
    group.add(airMesh);
    const x = new Mesh(airGeo, airX);
    x.frustumCulled = false;
    x.renderOrder = 9;
    group.add(x);
    disposables.push(airGeo);
  }
  if (waterGeo) {
    waterMesh = new Mesh(waterGeo, waterMat);
    waterMesh.frustumCulled = false;
    waterMesh.renderOrder = 1;
    group.add(waterMesh);
    const x = new Mesh(waterGeo, waterX);
    x.frustumCulled = false;
    x.renderOrder = 9;
    group.add(x);
    disposables.push(waterGeo);
  }

  /* ── diffuser puffs under each VAV ─────────────────────────── */
  // Laid out puff-major (all zones' first puff, then all zones' second …) with
  // interleaved phases, so the low tier simply draws the first half.
  const per = 12;
  const zones = layout.zones;
  const count = zones.length * per;
  const base = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const runA = new Float32Array(count);
  zones.forEach((z, zi) => {
    const p = z.vavPos || [(z.x0 + z.x1) / 2, 3.4, (z.z0 + z.z1) / 2];
    const ri = runIndex.get(`sa-${z.id}`) ?? 0;
    for (let k = 0; k < per; k++) {
      const i = k * zones.length + zi;
      const slot = k < per / 2 ? 2 * k : 2 * (k - per / 2) + 1;
      base[i * 3] = p[0] + 0.2;
      base[i * 3 + 1] = p[1] - 0.45;
      base[i * 3 + 2] = p[2];
      seed[i] = (slot + Math.random() * 0.6) / per;
      runA[i] = ri;
    }
  });
  const pg = new BufferGeometry();
  pg.setAttribute('position', new Float32BufferAttribute(base, 3));
  pg.setAttribute('aSeed', new Float32BufferAttribute(seed, 1));
  pg.setAttribute('aRun', new Float32BufferAttribute(runA, 1));
  const glow = glowTexture();
  const puffMat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uFlowTex: { value: flowTex },
      uTime: ctxU.time,
      uAmt: { value: 0 },
      uPx: { value: 1 },
      uMap: { value: glow },
      uColor: { value: new Color('#9ccfff') },
      uLevelY: levelU.uLevelY,
      uLevelOff: levelU.uLevelOff,
      uPace: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed, aRun;
      uniform sampler2D uFlowTex;
      uniform float uTime, uAmt, uPx, uPace;
      ${GLSL_LEVELS}
      varying float vA;
      void main() {
        float flow = texture2D(uFlowTex, vec2((aRun + 0.5) / 256.0, 0.5)).r;
        float t = fract(uTime * (0.22 + 0.35 * flow) * uPace + aSeed);
        float ang = aSeed * 91.7 + floor(uTime * 0.3 + aSeed) * 2.4;
        float r = (0.15 + t * 1.9);
        vec3 p = position + vec3(cos(ang) * r, -t * 2.4, sin(ang) * r);
        p.y += levelShift(position.y);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (1.0 + t * 3.0) * uPx * 90.0 / -mv.z;
        vA = uAmt * flow * smoothstep(0.0, 0.12, t) * (1.0 - t);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform vec3 uColor;
      varying float vA;
      void main() {
        float m = texture2D(uMap, gl_PointCoord).r;
        gl_FragColor = vec4(uColor * m * vA * 0.9, 1.0);
      }`,
  });
  const setQuality = (q) => pg.setDrawRange(0, q === 'low' ? zones.length * (per / 2) : Infinity);
  setQuality(quality);
  const puffs = new Points(pg, puffMat);
  puffs.frustumCulled = false;
  puffs.renderOrder = 6;
  group.add(puffs);
  disposables.push(pg, puffMat, glow);

  /* ── per-frame ─────────────────────────────────────────────── */
  const flows = {
    group,
    runIndex,
    flowTex,
    airMesh,
    waterMesh,
    setReveal(v) {
      sharedU.uReveal.value = clamp(v, 0, 1);
    },
    setPixelRatio(px) {
      puffMat.uniforms.uPx.value = px;
    },
    setQuality,
    setHighlightRun(id) {
      sharedU.uHi.value = id != null && runIndex.has(id) ? runIndex.get(id) : -1;
    },
    /** mode weights: thermal, air (airflow mode) in 0..1 */
    setModeVisuals({ thermal, air }) {
      for (let i = 0; i < RUN_KINDS.length; i++) {
        const isAir = i < 2;
        let e = (LIVE_EMPH[i] + (1 - LIVE_EMPH[i]) * air) * (1 - 0.62 * thermal);
        if (isAir) e *= 1 + 0.45 * air;
        else e *= 1 - 0.55 * air;
        emph[i] = e;
      }
      const wo = 1 - 0.86 * air;
      waterMat.uniforms.uOpacity.value = wo;
      waterMat.depthWrite = wo > 0.95;
      airMat.uniforms.uOpacity.value = 1;
      airX.uniforms.uXray.value = (1 + 1.4 * air) * (1 - 0.7 * thermal);
      waterX.uniforms.uXray.value = 1.2 * (1 - air) * (1 - 0.7 * thermal);
      puffMat.uniforms.uAmt.value = clamp(0.18 * (1 - thermal) + air * 1.1, 0, 1.2);
    },
    update(state, dt, opts) {
      const f = state?.flows || {};
      const pace = opts?.reducedMotion ? 0.3 : 1;
      puffMat.uniforms.uPace.value = pace;
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        const target = clamp(finite(f[r.id], 0), 0, 1);
        // ease flow changes so pulses spin up / coast down like real fans
        flowNow[i] += (target - flowNow[i]) * (1 - Math.exp(-2.2 * dt));
        const sp = SPACING[r.kind] || 3;
        phase[i] = (phase[i] + flowNow[i] * (SPEED[r.kind] || 4) * pace * dt) % (sp * 64);
        fdata[i * 4] = flowNow[i];
        fdata[i * 4 + 1] = phase[i];
      }
      flowTex.needsUpdate = true;
    },
    dispose() {
      for (const d of disposables) d?.dispose?.();
      group.removeFromParent();
    },
  };
  return flows;
}
