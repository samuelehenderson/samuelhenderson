/**
 * ahu3d-fx.js — the physically driven effects on the 3D air handler.
 *
 *   coilShader()      fin material that shows what the coil is doing to the air:
 *                     a water-side temperature gradient (steep at low flow,
 *                     flat at full flow), condensation beading and running
 *                     down when the fins are below the air's dew point, and
 *                     frost creeping in when they are near freezing.
 *   Stratification    a ray-marched temperature volume in the mixing box: cold
 *                     outside air pooling on the floor under warm return air
 *                     when the streams don't mix — the cause of nuisance
 *                     freezestat trips.
 *   LinkPulses        the program's control loops drawn as pulses running from
 *                     the sensor to the device it drives.
 *   dewPointF()       Magnus-formula dew point, °F.
 */

import * as THREE from 'three';

/** Dew point (°F) from dry bulb (°F) and relative humidity (%). */
export function dewPointF(tF, rh) {
  if (!Number.isFinite(tF) || !Number.isFinite(rh) || rh <= 0) return NaN;
  const tc = (tF - 32) / 1.8;
  const g = Math.log(Math.min(100, rh) / 100) + (17.62 * tc) / (243.12 + tc);
  return ((243.12 * g) / (17.62 - g)) * 1.8 + 32;
}

const NOISE = /* glsl */`
  float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float n3(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  // distance to the nearest random bead in a jittered grid
  float beads(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    float d = 1.0;
    for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) {
      vec3 o = vec3(float(x), float(y), 0.0);
      vec3 c = o + vec3(h3(i + o), h3(i + o + 7.1), 0.5) - f;
      d = min(d, length(c.xy));
    }
    return d;
  }
`;

/**
 * Patch a MeshStandardMaterial so it can show gradient / wet / frost.
 * @returns {object} uniforms you drive per frame:
 *   uFlow (0..1 valve), uWet (0..1), uFrost (0..1), uTime, uH (coil height)
 */
export function coilShader(mat) {
  const u = { uFlow: { value: 0 }, uWet: { value: 0 }, uFrost: { value: 0 }, uTime: { value: 0 }, uH: { value: 2.2 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying float vHn;\nuniform float uH;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 wp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
        #endif
        vHn = clamp((wp.y - 0.11) / uH, 0.0, 1.0);
        vWp = (modelMatrix * wp).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWp;
        varying float vHn;
        uniform float uFlow, uWet, uFrost, uTime;
        ${NOISE}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        // condensation: beads that slide down the fins
        float bead = 0.0;
        if (uWet > 0.001) {
          vec3 q = vec3(vWp.x * 9.0 + vWp.z * 6.0, vWp.y * 9.0 + uTime * 0.35, 0.0);
          bead = smoothstep(0.32, 0.18, beads(q)) * uWet;
          roughnessFactor = mix(roughnessFactor, 0.04, max(bead, uWet * 0.5));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55 + vec3(0.04, 0.07, 0.10), uWet * 0.6);
        }
        // frost: a crystalline white crust, thickest low where cold air pools
        if (uFrost > 0.001) {
          float fr = smoothstep(0.35, 0.75, n3(vWp * 22.0) * 0.6 + n3(vWp * 5.0) * 0.4 + (1.0 - vHn) * 0.25) * uFrost;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.95, 1.0), fr);
          roughnessFactor = mix(roughnessFactor, 0.95, fr);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // water gives up its heat as it runs up the circuit: at low flow the
        // far end of the coil barely changes the air; at full flow it's even
        totalEmissiveRadiance *= mix(1.0, 1.0 - 0.85 * vHn, 1.0 - uFlow);`);
  };
  mat.customProgramCacheKey = () => 'ahu3d-coil';
  return u;
}

/**
 * Temperature volume inside the mixing box. Rendered only when the physics
 * says it matters: an outside/return spread of 8°F or more with outside air
 * coming in.
 */
export class Stratification {
  constructor(w, h, d, steps) {
    this.u = {
      uCam: { value: new THREE.Vector3() },
      uSize: { value: new THREE.Vector3(w, h, d) },
      uTime: { value: 0 },
      uCold: { value: 40 }, uWarm: { value: 72 },
      uLayer: { value: 0.3 },      // cold-layer height, fraction of H
      uMix: { value: 0.5 },        // 0 = fully stratified, 1 = fully mixed
      uFlow: { value: 0 },
      uAmt: { value: 0 }           // overall visibility (0 hides)
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      transparent: true, depthWrite: false, side: THREE.BackSide,
      defines: { STEPS: steps },
      vertexShader: /* glsl */`
        varying vec3 vLocal;
        void main() { vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uCam, uSize;
        uniform float uTime, uCold, uWarm, uLayer, uMix, uFlow, uAmt;
        varying vec3 vLocal;
        ${NOISE}
        vec3 tempCol(float t) {
          vec3 c0 = vec3(0.184, 0.490, 1.0), c1 = vec3(0.361, 0.784, 1.0), c2 = vec3(0.902, 0.953, 0.969);
          vec3 c3 = vec3(1.0, 0.698, 0.361), c4 = vec3(1.0, 0.290, 0.165);
          if (t <= 40.0) return c0;
          if (t <= 55.0) return mix(c0, c1, (t - 40.0) / 15.0);
          if (t <= 68.0) return mix(c1, c2, (t - 55.0) / 13.0);
          if (t <= 80.0) return mix(c2, c3, (t - 68.0) / 12.0);
          return mix(c3, c4, clamp((t - 80.0) / 20.0, 0.0, 1.0));
        }
        void main() {
          vec3 half_ = uSize * 0.5;
          vec3 ro = uCam, rd = normalize(vLocal - uCam);
          // entry point of the ray into the box (exit is this back face)
          vec3 t0 = (-half_ - ro) / rd, t1 = (half_ - ro) / rd;
          vec3 tmin = min(t0, t1);
          float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
          float tf = length(vLocal - ro);
          float dt = (tf - tn) / float(STEPS);
          vec4 acc = vec4(0.0);
          float mean = mix(uCold, uWarm, 0.5);
          for (int i = 0; i < STEPS; i++) {
            vec3 p = ro + rd * (tn + dt * (float(i) + 0.5));
            float y = (p.y + half_.y) / uSize.y;               // 0 floor .. 1 roof
            // the interface between the layers wobbles and is torn up by flow
            float n = n3(vec3(p.x * 1.6 - uTime * (0.3 + uFlow), p.y * 2.0, p.z * 1.6)) - 0.5;
            float edge = uLayer + n * (0.10 + 0.25 * uMix);
            float cold = smoothstep(edge + 0.08 + 0.3 * uMix, edge - 0.08, y);
            float T = mix(mix(uWarm, uCold, cold), mean, uMix * 0.6);
            float dev = clamp(abs(T - mean) / 12.0, 0.0, 1.0);
            float a = dev * (5.0 / float(STEPS)) * uAmt * (0.6 + 0.8 * n3(p * 3.0 + uTime * 0.2));
            vec3 col = tempCol(T);
            acc.rgb += (1.0 - acc.a) * col * a;
            acc.a += (1.0 - acc.a) * a;
          }
          gl_FragColor = acc;
        }`
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    this.mesh.renderOrder = 2;
    this._inv = new THREE.Matrix4();
  }

  /** Ray-march from the camera, in the box's own coordinates. */
  update(camera, q) {
    this.mesh.updateWorldMatrix(true, false);
    this._inv.copy(this.mesh.matrixWorld).invert();
    this.u.uCam.value.copy(camera.position).applyMatrix4(this._inv);
    this.u.uTime.value = q.time;
    this.u.uCold.value = q.cold; this.u.uWarm.value = q.warm;
    this.u.uLayer.value = q.layer; this.u.uMix.value = q.mix;
    this.u.uFlow.value = q.flow; this.u.uAmt.value = q.amt;
    this.mesh.visible = q.amt > 0.01;
  }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

/**
 * Control loops as light: a curved line from each sensor to the device it
 * drives, with a pulse travelling along it. Brighter while the loop is
 * working the output (the output is moving).
 */
export class LinkPulses {
  constructor() {
    this.group = new THREE.Group();
    this.items = [];
    this.u = { uTime: { value: 0 } };
  }

  /** @param {Array<{a:THREE.Object3D,b:THREE.Object3D,label:string}>} pairs */
  build(pairs) {
    this.clear();
    for (const p of pairs) {
      const n = 48;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const u = new Float32Array(n);
      for (let i = 0; i < n; i++) u[i] = i / (n - 1);
      geo.setAttribute('u', new THREE.BufferAttribute(u, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: this.u.uTime, uAct: { value: 0.3 }, uSel: { value: 0 }, uPhase: { value: Math.random() } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: `attribute float u; varying float vU; void main(){ vU = u; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform float uTime, uAct, uSel, uPhase; varying float vU;
          void main(){
            float head = fract(uTime * (0.25 + 0.5 * uAct) + uPhase);
            float d = vU - head; d = d < 0.0 ? d + 1.0 : d;
            float pulse = exp(-d * 14.0) * (0.9 + 1.2 * uAct);
            float base = 0.28 + 0.4 * uSel;
            vec3 c = mix(vec3(0.27, 0.83, 0.90), vec3(1.0, 0.85, 0.4), uSel);
            gl_FragColor = vec4(c * (base + pulse), base + pulse);
          }`
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      this.group.add(line);
      this.items.push({ ...p, line, mat, geo, n, act: 0.3 });
    }
  }

  clear() {
    for (const it of this.items) { this.group.remove(it.line); it.geo.dispose(); it.mat.dispose(); }
    this.items = [];
  }

  update(time, activity, selected) {
    this.u.uTime.value = time;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (const it of this.items) {
      it.a.getWorldPosition(A); it.b.getWorldPosition(B);
      // arc up and over, higher for longer links
      C.copy(A).add(B).multiplyScalar(0.5);
      C.y += 0.6 + A.distanceTo(B) * 0.25;
      const pos = it.geo.attributes.position.array;
      for (let i = 0; i < it.n; i++) {
        const t = i / (it.n - 1), s = 1 - t;
        pos[i * 3] = s * s * A.x + 2 * s * t * C.x + t * t * B.x;
        pos[i * 3 + 1] = s * s * A.y + 2 * s * t * C.y + t * t * B.y;
        pos[i * 3 + 2] = s * s * A.z + 2 * s * t * C.z + t * t * B.z;
      }
      it.geo.attributes.position.needsUpdate = true;
      const act = activity(it) ?? 0.3;
      it.act += (act - it.act) * 0.1;
      it.mat.uniforms.uAct.value = it.act;
      it.mat.uniforms.uSel.value = selected && selected(it) ? 1 : 0;
    }
  }

  dispose() { this.clear(); }
}
