/**
 * airflow3d.js — air drawn as air: soft, structured streams, not particles.
 *
 * Each airflow path of a unit (outside air, recirculated, relieved — or a
 * water loop on plant) becomes a bundle of lanes: smooth streamlines laid
 * through the unit's real air path (the path's corners are filleted, and a
 * rotation-minimising frame carries every lane round a bend so the inside of
 * the turn stays inside). Each lane is a thin camera-facing ribbon; its shader
 * scrolls soft, irregular streaks along the lane and fades at the lane's ends
 * and edges, so the bundle reads as a moving translucent sheet of air.
 *
 * What each effect means (nothing decorative):
 *   speed        the streaks travel at the live fan speed (flow 0..1)
 *   lane share   how many lanes of each path are drawn follows the damper
 *                split (OA / recirculated / relieved): two streams converge
 *                and blend in the mixing box, relief peels off
 *   calm         through filters and coils the lanes run straight and a
 *                little slower (laminar)
 *   wake         behind a fan wall the lanes twist into a swirl and speed up
 *                (streaks stretch), with a gentle time-varying wobble
 *   bunching     upstream of a loaded filter the stream slows (streaks bunch)
 *   discharge    the stream necks into a duct stub, or spreads out of a
 *                diffuser (per-leg spread factors from the view)
 *   colour       the air (or water) temperature at each station, on the same
 *                blue → white → orange scale as the particles it replaces
 *
 * Honesty lives with the caller: the views hide `points` unless a live point
 * proves air moving (see Ahu3DView._updateAir); this module never animates on
 * its own. API matches the old AirField so every view keeps working:
 *   new AirFlow(budget)   points (the Object3D to add)   setCount(budget)
 *   update(q)             dispose()
 * Geometry is rebuilt only when a path, the tier or a live loading changes;
 * per frame only a handful of uniforms move.
 */

import * as THREE from 'three';

const MAXP = 3;        // paths: 0 outside air, 1 recirculated, 2 relieved (or one water loop)
const MAXV = 10;       // legs per path we colour by leg (water loops, stacked decks)
const MAXST = 12;      // temperature stations
const PERIOD = 289;    // noise period, in streak cells (travel wraps on it: seamless)

/** Particle budget (the old AirField tiers) → lanes per path. */
export function lanesFor(budget) {
  if (budget >= 20000) return 22;
  if (budget >= 8000) return 12;
  if (budget >= 2000) return 7;
  return 3;
}

const VERT = /* glsl */`
  #define MAXP ${MAXP}
  #define MAXV ${MAXV}
  #define MAXST ${MAXST}
  attribute vec3 tang;
  attribute vec4 aT;   // tau (flow-time coordinate, m), from start (m), to end (m), side (-1 | 1)
  attribute vec4 aL;   // lane index in its path, seed, leg (fractional on bends), path
  attribute vec4 aW;   // wobble direction, turbulence
  attribute float aK;  // ribbon width factor here (wider where the stream spreads out)
  uniform float uTravel, uTime, uFlow, uWidth, uLift, uFreq, uFade, uBlend, uAmp;
  uniform float uShareN[MAXP];
  uniform float uWK[MAXP];       // ribbon width factor per path (a tower's plume is wider than its pipes)
  uniform float uFE[MAXP];       // how far from its end a path fades out (air dissipating into a room)
  uniform float uSK[MAXP];       // streak length per path: 1, 1/2, 1/4, 1/8 (longer = a continuous plume)
  uniform float uHZ[MAXP];       // the steady haze under the streaks (a plume is mostly haze)
  uniform vec4 uSt[MAXST];       // x, temperature, path (-1 = all), dir (+1 / -1)
  uniform float uStN;
  uniform float uOat, uRat;
  uniform float uRetLegs[MAXP];
  uniform float uOaLegs[MAXP];
  uniform float uLegMode[MAXP];
  uniform float uLegT[MAXP * MAXV];
  varying vec3 vCol;
  varying float vA;
  varying float vPhase;
  varying float vSide;
  varying float vHz;

  vec3 tempCol(float t) {
    vec3 c0 = vec3(0.184, 0.490, 1.0), c1 = vec3(0.361, 0.784, 1.0), c2 = vec3(0.902, 0.953, 0.969);
    vec3 c3 = vec3(1.0, 0.698, 0.361), c4 = vec3(1.0, 0.290, 0.165);
    if (t <= 40.0) return c0;
    if (t <= 55.0) return mix(c0, c1, (t - 40.0) / 15.0);
    if (t <= 68.0) return mix(c1, c2, (t - 55.0) / 13.0);
    if (t <= 80.0) return mix(c2, c3, (t - 68.0) / 12.0);
    if (t <= 100.0) return mix(c3, c4, (t - 80.0) / 20.0);
    return c4;
  }

  float legT(int path, float legf) {
    float i0 = floor(legf), f = legf - i0;
    float a = uOat, b = uOat;
    for (int p = 0; p < MAXP; p++) {
      if (p != path) continue;
      for (int k = 0; k < MAXV; k++) {
        if (float(k) == i0) a = uLegT[p * MAXV + k];
        if (float(k) == min(i0 + 1.0, float(MAXV - 1))) b = uLegT[p * MAXV + k];
      }
    }
    return mix(a, b, f);
  }

  void main() {
    int path = int(aL.w + 0.5);
    float share = 0.0, retL = 0.0, oaL = 0.0, legMode = 0.0, wk = 1.0, fe = 0.0;
    float sk = 1.0;
    vHz = 0.06;
    for (int i = 0; i < MAXP; i++) if (i == path) { share = uShareN[i]; retL = uRetLegs[i]; oaL = uOaLegs[i]; legMode = uLegMode[i]; wk = uWK[i]; fe = uFE[i]; sk = uSK[i]; vHz = uHZ[i]; }

    // gentle, time-varying wobble: strong in a fan's wake, nil through coils
    vec3 p = position;
    float w = sin(aT.x * 1.9 - uTime * (1.1 + uFlow) + aL.y * 6.2832) * 0.6
            + sin(aT.x * 3.3 + uTime * 0.8 + aL.y * 17.0) * 0.4;
    p += aW.xyz * w * aW.w * uAmp;

    // temperature: by leg (water loops), else return / outside legs, else stations along x
    float T;
    float leg = floor(aL.z + 0.5);
    if (legMode > 0.5) T = legT(path, aL.z);
    else if (path == 2 || leg < retL) T = uRat;
    else if (leg < oaL) T = uOat;
    else {
      T = (path == 1) ? uRat : uOat;
      for (int i = 0; i < MAXST; i++) {
        if (float(i) >= uStN) break;
        vec4 st = uSt[i];
        if (st.z >= 0.0 && int(st.z + 0.5) != path) continue;
        // |dir| = 1 blends over uBlend; |dir| = 1 + b blends over b metres (supply air mixing into a room)
        float bw = abs(st.w) > 1.001 ? abs(st.w) - 1.0 : uBlend;
        float k = st.w < 0.0 ? smoothstep(st.x + bw, st.x - bw, p.x) : smoothstep(st.x - bw, st.x + bw, p.x);
        T = mix(T, st.y, k);
      }
    }
    vCol = tempCol(T);

    // lanes beyond the damper share are not drawn (the last one fades by its fraction)
    float vis = clamp(share - aL.x, 0.0, 1.0);
    vA = vis * smoothstep(0.0, uFade, aT.y) * smoothstep(0.0, max(uFade, fe), aT.z);
    vPhase = (aT.x - uTravel) * uFreq * sk + aL.y * 97.0;
    vSide = aT.w;

    // a ribbon that always faces the camera, uWidth wide (in world units, whatever the parent scale)
    vec4 mv = modelViewMatrix * vec4(p.x, p.y + uLift, p.z, 1.0);
    vec3 tv = (modelViewMatrix * vec4(tang, 0.0)).xyz;
    float sc = length(tv);
    tv = sc > 1e-6 ? tv / sc : vec3(1.0, 0.0, 0.0);
    vec3 sv = cross(tv, normalize(-mv.xyz));
    float sl = length(sv);
    sv = sl > 1e-4 ? sv / sl : vec3(0.0, 1.0, 0.0);
    // a ribbon seen end-on flips its side vector: fade it there instead of drawing a knot
    vA *= smoothstep(0.12, 0.45, sl);
    mv.xyz += sv * aT.w * uWidth * wk * aK * 0.5 * sc;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  uniform float uOpacity;
  varying vec3 vCol;
  varying float vA;
  varying float vPhase;
  varying float vSide;
  varying float vHz;
  float hash(float n) { return fract(sin(mod(n, ${PERIOD}.0)) * 43758.5453); }
  float noise1(float x) {
    float i = floor(x), f = fract(x);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(hash(i), hash(i + 1.0), u);
  }
  void main() {
    if (vA <= 0.002) discard;
    float e = 1.0 - vSide * vSide;                       // 0 at the ribbon's edges
    float edge = e * e;
    float n = noise1(vPhase) * 0.62 + noise1(vPhase * 2.37 + 17.0) * 0.38;
    float streak = smoothstep(0.38, 0.92, n);
    float a = (vHz + (0.9 - vHz) * streak) * edge * vA * uOpacity;
    gl_FragColor = vec4(vCol * (0.8 + 0.45 * streak), a);
  }
`;

// ---- geometry helpers ---------------------------------------------------------

const V3 = THREE.Vector3;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Halton low-discrepancy sequence: the first k lanes are always well spread. */
function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}

/**
 * A path polyline → a dense, filleted centreline.
 * Returns { c: Vector3[], legf: number[] } (legf: the leg each sample is on;
 * fractional round a bend, so colours and widths blend through it).
 */
function centreline(pts, rmax, step, taper = false) {
  const P = pts.map((p) => new V3(p[0], p[1], p[2]));
  const n = P.length;
  const c = [], legf = [];
  if (n < 2) return { c, legf };
  const r = new Array(n).fill(0), din = [], dout = [];
  for (let i = 1; i < n - 1; i++) {
    const a = P[i].clone().sub(P[i - 1]), b = P[i + 1].clone().sub(P[i]);
    const la = a.length(), lb = b.length();
    if (la < 1e-6 || lb < 1e-6) continue;
    a.divideScalar(la); b.divideScalar(lb);
    din[i] = a; dout[i] = b;
    if (a.dot(b) > 0.9995) continue;
    r[i] = Math.min(rmax, 0.45 * la, 0.45 * lb);
  }
  const push = (v, l) => { c.push(v); legf.push(l); };
  let cur = P[0].clone();
  push(cur.clone(), 0);
  for (let i = 1; i < n; i++) {
    // straight run on leg i-1 up to the start of the bend at vertex i
    const end = i < n - 1 && r[i] > 0 ? P[i].clone().addScaledVector(din[i], -r[i]) : P[i].clone();
    const L = cur.distanceTo(end);
    const k = Math.max(1, Math.ceil(L / step));
    // taper: widths (and leg colours) ease along each straight leg instead of stepping at its end
    for (let j = 1; j <= k; j++) push(cur.clone().lerp(end, j / k), i - 1 + (taper ? 0.999 * (j / k) : 0));
    cur = end;
    if (i < n - 1 && r[i] > 0) {
      // the bend: a quadratic curve from A through the corner's pull to B
      const A = cur, B = P[i].clone().addScaledVector(dout[i], r[i]), Cc = P[i];
      const kk = Math.max(3, Math.ceil((r[i] * 1.6) / step));
      for (let j = 1; j <= kk; j++) {
        const t = j / kk, u = 1 - t;
        push(new V3(u * u * A.x + 2 * u * t * Cc.x + t * t * B.x, u * u * A.y + 2 * u * t * Cc.y + t * t * B.y, u * u * A.z + 2 * u * t * Cc.z + t * t * B.z), taper ? i - 0.001 : i - 1 + t);   // tapered: the bend holds the width the leg reached
      }
      cur = B.clone();
    }
  }
  return { c, legf };
}

/** Rotation-minimising frames (double reflection) along a sampled curve. */
function frames(c) {
  const n = c.length;
  const T = [], N = [], B = [];
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(n - 1, i + 1)];
    const t = b.clone().sub(a);
    T.push(t.lengthSq() > 1e-12 ? t.normalize() : (T[i - 1] ? T[i - 1].clone() : new V3(1, 0, 0)));
  }
  const up = Math.abs(T[0].y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
  N.push(up.clone().addScaledVector(T[0], -up.dot(T[0])).normalize());
  for (let i = 0; i < n - 1; i++) {
    const v1 = c[i + 1].clone().sub(c[i]);
    const c1 = v1.dot(v1);
    if (c1 < 1e-12) { N.push(N[i].clone()); continue; }
    const rL = N[i].clone().addScaledVector(v1, (-2 / c1) * v1.dot(N[i]));
    const tL = T[i].clone().addScaledVector(v1, (-2 / c1) * v1.dot(T[i]));
    const v2 = T[i + 1].clone().sub(tL);
    const c2 = v2.dot(v2);
    const nn = c2 < 1e-12 ? rL : rL.addScaledVector(v2, (-2 / c2) * v2.dot(rL));
    N.push(nn.addScaledVector(T[i + 1], -nn.dot(T[i + 1])).normalize());
  }
  for (let i = 0; i < n; i++) B.push(new V3().crossVectors(T[i], N[i]));
  return { T, N, B };
}

/** Leg direction → the stream's width across each world axis (x, y, z), metres. */
function legExtent(a, b, H, W, vw) {
  const d = [Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2])];
  const ax = d[0] >= d[1] && d[0] >= d[2] ? 0 : d[1] >= d[2] ? 1 : 2;
  const eH = H - 2 * Math.min(0.36, 0.2 * H), eW = W - 2 * Math.min(0.36, 0.2 * W);
  if (ax === 0) return [0, eH, eW];
  if (ax === 1) return [vw, 0, eW];
  return [vw, eH, 0];
}

export class AirFlow {
  /** @param {number} budget  the tier's particle budget (lanes follow it) */
  constructor(budget = 24000) {
    this.lanes = lanesFor(budget);
    const zeros = (n, v = 0) => new Array(n).fill(v);
    this.u = {
      uTravel: { value: 0 }, uTime: { value: 0 }, uFlow: { value: 0 },
      uWidth: { value: 0.2 }, uLift: { value: 0 }, uFreq: { value: 1.2 }, uFade: { value: 0.6 }, uBlend: { value: 0.3 }, uAmp: { value: 0.3 },
      uShareN: { value: zeros(MAXP) }, uWK: { value: zeros(MAXP, 1) }, uFE: { value: zeros(MAXP) }, uSK: { value: zeros(MAXP, 1) }, uHZ: { value: zeros(MAXP, 0.06) },
      uSt: { value: zeros(MAXST).map(() => new THREE.Vector4(1e6, 0, -1, 1)) },
      uStN: { value: 0 },
      uOat: { value: 70 }, uRat: { value: 72 },
      uRetLegs: { value: zeros(MAXP) }, uOaLegs: { value: zeros(MAXP) },
      uLegMode: { value: zeros(MAXP) }, uLegT: { value: zeros(MAXP * MAXV, 70) },
      uOpacity: { value: 0.85 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.material.name = 'airflow';
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;               // after the glass skins
    this.mesh.name = 'airflow';
    this.mesh.userData.noFootprint = true;
    this.mesh.userData.air = true;
    // `points` is the Object3D a view adds and hides (the AirField name, kept)
    this.points = this.mesh;
    this.travel = 0;
    this.key = '';
    this.builtAt = -1e9;
    this.share = [0, 0, 0];
    this.laneCount = [0, 0, 0];
    this.vertexCount = 0;
  }

  /** Change the tier: fewer lanes on slower devices (rebuilt on the next update). */
  setCount(budget) {
    const l = lanesFor(budget);
    if (l !== this.lanes) { this.lanes = l; this.key = ''; }
  }

  /**
   * @param {object} q  {dt, time, flow, paths, share:{oa,rec,rel}, stations, oat, rat,
   *   filters:[{x,load}], fanZones:[{x,str}], calm?:[{x0,x1}], neck?, box:[H,W], span:[x0,x1],
   *   lift, opacity}
   *   paths[k] = {pts, seg, L, vw, oaLegs, retLegs, legT?, k?} — k: per-leg width factors
   *   (spread out of a diffuser, neck into a collar).
   */
  update(q) {
    const u = this.u;
    const H = q.box[0], W = q.box[1];
    const minHW = Math.max(0.05, Math.min(H, W));
    const scale = Math.min(1, Math.max(0.1, minHW / 2.4));
    // travel in metres of stream; the streak pattern repeats every PERIOD cells, so wrap there
    const freq = 0.8 / scale;                     // longer, calmer streaks
    const speed = Math.min(1, Math.max(0.3, Math.sqrt(scale)));
    this.travel += (0.25 + 2.3 * (q.flow || 0)) * speed * (q.dt || 0);
    const wrap = (8 * PERIOD) / freq;
    if (this.travel > wrap) this.travel -= wrap;
    u.uTravel.value = this.travel;
    u.uTime.value = q.time || 0;
    u.uFlow.value = q.flow || 0;
    u.uFreq.value = freq;
    u.uFade.value = Math.min(0.8, Math.max(0.04, minHW * 0.3));
    u.uBlend.value = Math.max(0.03, 0.3 * scale);
    u.uAmp.value = 0.08 * minHW;
    const lanes = this.lanes;
    u.uWidth.value = Math.min(0.13, Math.max(0.008, minHW * 0.05)) * (lanes <= 3 ? 2.4 : lanes <= 7 ? 1.5 : lanes <= 12 ? 1.2 : 1);
    u.uLift.value = q.lift || 0;
    u.uOpacity.value = q.opacity ?? 0.85;

    // geometry: rebuild only when the paths (or what shapes the lanes) change
    const key = this._key(q);
    const now = typeof performance === 'object' ? performance.now() : Date.now();
    if (key !== this.key && (!this.key || now - this.builtAt > 70)) {
      this._build(q, H, W, minHW, scale);
      this.key = key;
      this.builtAt = now;
    }

    // lanes drawn per path follow the damper split (damped so a damper move glides)
    // Two streams that end together (an air handler's outside and return air)
    // split the lanes between them; independent streams (an ERU's two decks,
    // two water loops) each draw every lane.
    const po = q.paths.oa?.pts, pr = q.paths.rec?.pts;
    const mixing = !!(po && pr) && Math.hypot(...[0, 1, 2].map((a) => po[po.length - 1][a] - pr[pr.length - 1][a])) < 0.02;
    const raw = [q.share.oa || 0, q.share.rec || 0, q.share.rel || 0];
    const want = raw.map((s) => (mixing ? Math.min(1, Math.max(0, s)) : s > 0 ? 1 : 0));
    const k = this._shareInit ? 1 - Math.exp(-3 * (q.dt || 0.016)) : 1;
    for (let i = 0; i < MAXP; i++) {
      this.share[i] += (want[i] - this.share[i]) * k;
      u.uShareN.value[i] = this.share[i] * this.laneCount[i];
    }
    this._shareInit = true;

    const keys = ['oa', 'rec', 'rel'];
    keys.forEach((kk, pi) => {
      const P = q.paths[kk];
      u.uRetLegs.value[pi] = P?.retLegs || 0;
      u.uOaLegs.value[pi] = P?.oaLegs || 0;
      u.uLegMode.value[pi] = P?.legT ? 1 : 0;
      u.uWK.value[pi] = P?.widthK || 1;
      u.uFE.value[pi] = P?.fadeEnd || 0;
      u.uSK.value[pi] = P?.streakK || (P?.water ?? P?.legT ? 0.5 : 1);
      u.uHZ.value[pi] = P?.haze ?? (P?.water ?? P?.legT ? 0.18 : 0.06);
      if (P?.legT) for (let i = 0; i < MAXV; i++) u.uLegT.value[pi * MAXV + i] = Number.isFinite(P.legT[i]) ? P.legT[i] : (P.legT[P.legT.length - 1] ?? 70);
    });
    const st = q.stations || [];
    for (let i = 0; i < MAXST; i++) {
      if (i < st.length) u.uSt.value[i].set(st[i].x, st[i].t, st[i].path ?? -1, st[i].dir ?? 1);
      else u.uSt.value[i].set(1e6, 0, -1, 1);
    }
    u.uStN.value = Math.min(MAXST, st.length);
    u.uOat.value = q.oat; u.uRat.value = q.rat;
  }

  _key(q) {
    const r = (v) => Math.round(v * 200) / 200;
    let s = `${this.lanes}|${r(q.box[0])},${r(q.box[1])}|${r(q.span[0])},${r(q.span[1])}|${q.neck ?? ''}|`;
    for (const k of ['oa', 'rec', 'rel']) {
      const P = q.paths[k];
      if (!P) { s += '-;'; continue; }
      for (const p of P.pts) s += `${r(p[0])},${r(p[1])},${r(p[2])} `;
      s += `v${r(P.vw || 0)}${P.legT ? 'w' : ''}${P.k ? JSON.stringify(P.k) : ''};`;
    }
    for (const z of q.fanZones || []) s += `f${r(z.x)}`;
    for (const h of q.fanHoles || []) s += `h${r(h.x)},${r(h.y)},${r(h.z)}`;
    for (const c of q.calm || []) s += `c${r(c.x0)}:${r(c.x1)}`;
    for (const f of q.filters || []) s += `F${r(f.x)}:${Math.round((f.load || 0) * 5)}`;
    return s;
  }

  _build(q, H, W, minHW, scale) {
    const lanesMax = this.lanes;
    const step = Math.min(0.14, Math.max(0.012, minHW * 0.05)) * (lanesMax <= 3 ? 2 : lanesMax <= 7 ? 1.5 : lanesMax <= 12 ? 1.2 : 1);
    const rmax = Math.max(0.03, 0.42 * minHW);
    const span = q.span || [-1e4, 1e4];
    const fans = (q.fanZones || []).filter((z) => z.str > 0);
    const calm = q.calm || [];
    const filters = (q.filters || []).filter((f) => f.load > 0);
    const holes = q.fanHoles || [];
    const holesByX = [];
    for (const h of holes) { let s = holesByX.find((x) => Math.abs(x.x - h.x) < 0.01); if (!s) holesByX.push(s = { x: h.x, L: Math.max(0.12, 0.45 * h.r), list: [] }); s.list.push(h); }
    const wakeL = 1.6 * scale;
    const pos = [], tan = [], aT = [], aL = [], aW = [], aK = [], idx = [];
    let vtx = 0;
    const keys = ['oa', 'rec', 'rel'];
    keys.forEach((kk, pi) => {
      const P = q.paths[kk];
      this.laneCount[pi] = 0;
      if (!P || !P.pts || P.pts.length < 2) return;
      const water = P.water ?? !!P.legT;
      const nL = water ? Math.min(lanesMax, 5) : lanesMax;
      this.laneCount[pi] = nL;
      const { c, legf } = centreline(P.pts, water ? rmax * 0.4 : rmax, step, !!P.taper);
      if (c.length < 2) return;
      const { T, N, B } = frames(c);
      const legs = [];
      for (let i = 1; i < P.pts.length; i++) {
        const e = legExtent(P.pts[i - 1], P.pts[i], H, W, P.vw || 0.8);
        // a leg's width factor: one number, or per world axis [x, y, z] (air hugging a ceiling spreads sideways, not down)
        const kk = P.k?.[i - 1] ?? 1, wf = water ? 0.35 : 1;
        legs.push(e.map((v, ai) => v * (Array.isArray(kk) ? kk[ai] : kk) * wf));
      }
      // a tapered path eases its last leg toward kEnd (a plume spreading as it rises)
      if (P.taper && P.kEnd) { const last = legs[legs.length - 1], k0 = P.k?.[legs.length - 1] ?? 1; legs.push(last.map((v, ai) => (v / ((Array.isArray(k0) ? k0[ai] : k0) || 1)) * P.kEnd)); }
      // per sample: widths along N and B, the swirl angle, turbulence, local speed
      const n = c.length;
      const eN = new Float32Array(n), eB = new Float32Array(n), twist = new Float32Array(n), turb = new Float32Array(n), vel = new Float32Array(n), wk = new Float32Array(n);
      const sc = new Float32Array(n), passed = fans.map(() => null);
      const tmp = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const lf = legf[i], i0 = Math.min(legs.length - 1, Math.floor(lf)), i1 = Math.min(legs.length - 1, i0 + 1), f = lf - Math.floor(lf);
        for (let a = 0; a < 3; a++) tmp[a] = legs[i0][a] * (1 - f) + legs[i1][a] * f;
        const km = (x) => (Array.isArray(x) ? Math.max(...x) : x ?? 1);
        const kk = km(P.k?.[i0]) * (1 - f) + km(P.k?.[i1]) * f;
        wk[i] = Math.min(1.8, Math.max(1, Math.sqrt(kk)));
        const x = c[i].x;
        let k = 1;
        if (q.neck != null && !water) {
          const out = Math.max(span[0] - x, x - span[1]);
          k = 1 + (q.neck - 1) * smooth(-0.2 * scale, 0.9 * Math.max(0.3, scale), out);
        }
        eN[i] = k * (Math.abs(N[i].x) * tmp[0] + Math.abs(N[i].y) * tmp[1] + Math.abs(N[i].z) * tmp[2]);
        eB[i] = k * (Math.abs(B[i].x) * tmp[0] + Math.abs(B[i].y) * tmp[1] + Math.abs(B[i].z) * tmp[2]);
        let tw = 0, tb = water ? 0.02 : 0.07, v = 1;
        if (i > 0) sc[i] = sc[i - 1] + c[i].distanceTo(c[i - 1]);
        const alongX = Math.abs(T[i].x) > 0.7;
        if (!water) {
          // a fan's wake belongs to the lanes that went through the fan: from where
          // this path crossed the fan wall, the lanes twist a quarter turn into a
          // swirl, run fast and turbulent, then settle (the twist stays)
          fans.forEach((z, zi) => {
            if (passed[zi] == null && i > 0 && alongX && c[i - 1].x < z.x && x >= z.x) passed[zi] = sc[i];
            if (passed[zi] == null) return;
            const u = Math.min(1, (sc[i] - passed[zi]) / wakeL), r = 1 - u;
            tw += 0.6 * z.str * (1 - r * r);
            if (u < 1) { tb = Math.max(tb, z.str * r * r * 0.9); v = Math.max(v, 1 + 0.7 * z.str * r * r); }
          });
        }
        if (!water && alongX) {
          for (const r of calm) if (x > r.x0 && x < r.x1) { tb = Math.min(tb, 0.005); v = Math.min(v, 0.82); }
          for (const fl of filters) if (x > fl.x - 0.9 * scale && x < fl.x) v = Math.min(v, 1 - 0.6 * fl.load * (1 - (fl.x - x) / (0.9 * scale)));
        }
        twist[i] = tw; turb[i] = tb; vel[i] = Math.max(0.25, v);
      }
      for (let j = 0; j < nL; j++) {
        const hi = pi === 2 ? 4 * j + 3 : 2 * j + 1 + pi;
        const a0 = halton(hi, 2) - 0.5, b0 = halton(hi, 3) - 0.5;
        const seed = halton(hi + 7, 5);
        const phi = seed * Math.PI * 2;
        const lane = new Array(n);
        for (let i = 0; i < n; i++) {
          const th = twist[i];
          let a = a0, b = b0;
          if (th) { const cs = Math.cos(th), sn = Math.sin(th); a = Math.max(-0.5, Math.min(0.5, a0 * cs - b0 * sn)); b = Math.max(-0.5, Math.min(0.5, a0 * sn + b0 * cs)); }
          lane[i] = c[i].clone().addScaledVector(N[i], a * eN[i]).addScaledVector(B[i], b * eB[i]);
        }
        // arc length and flow-time along this lane
        const sArr = new Float32Array(n), tau = new Float32Array(n);
        for (let i = 1; i < n; i++) {
          const ds = lane[i].distanceTo(lane[i - 1]);
          sArr[i] = sArr[i - 1] + ds;
          tau[i] = tau[i - 1] + ds / (0.5 * (vel[i] + vel[i - 1]));
        }
        const len = sArr[n - 1];
        // a fan-wall bulkhead: the lanes converge through the round opening of the fan in their cell
        if (holes.length) for (let i = 0; i < n; i++) {
          const p = lane[i];
          for (const hset of holesByX) {
            const f = Math.exp(-Math.pow((p.x - hset.x) / hset.L, 2));
            if (f < 0.01) continue;
            let best = null, bd = 1e9;
            for (const o of hset.list) { const d = Math.abs(p.y - o.y) / o.hy + Math.abs(p.z - o.z) / o.hz; if (d < bd) { bd = d; best = o; } }
            const dy = Math.max(-1, Math.min(1, (p.y - best.y) / best.hy)), dz = Math.max(-1, Math.min(1, (p.z - best.z) / best.hz));
            const ty = best.y + dy * best.r * 0.72, tz = best.z + dz * best.r * 0.72;
            p.y += (ty - p.y) * f; p.z += (tz - p.z) * f;
          }
        }
        for (let i = 0; i < n; i++) {
          const pa = lane[Math.max(0, i - 1)], pb = lane[Math.min(n - 1, i + 1)];
          let tx = pb.x - pa.x, ty = pb.y - pa.y, tz = pb.z - pa.z;
          const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
          const wx = N[i].x * Math.cos(phi) + B[i].x * Math.sin(phi), wy = N[i].y * Math.cos(phi) + B[i].y * Math.sin(phi), wz = N[i].z * Math.cos(phi) + B[i].z * Math.sin(phi);
          for (const side of [-1, 1]) {
            pos.push(lane[i].x, lane[i].y, lane[i].z);
            tan.push(tx, ty, tz);
            aT.push(tau[i], sArr[i], len - sArr[i], side);
            aL.push(j, seed, legf[i], pi);
            aW.push(wx, wy, wz, turb[i]);
            aK.push(wk[i]);
          }
          if (i > 0) {
            const b = vtx + (i - 1) * 2;
            idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
          }
        }
        vtx += n * 2;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('tang', new THREE.Float32BufferAttribute(tan, 3));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 4));
    g.setAttribute('aL', new THREE.Float32BufferAttribute(aL, 4));
    g.setAttribute('aW', new THREE.Float32BufferAttribute(aW, 4));
    g.setAttribute('aK', new THREE.Float32BufferAttribute(aK, 1));
    g.setIndex(vtx > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.vertexCount = vtx;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
