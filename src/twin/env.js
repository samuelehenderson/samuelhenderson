/**
 * Digital Twin — environment: sky dome, x-ray ground grid with the basement
 * cut-away, shadow catcher, a slow scan pulse, sun / moon / sky light.
 * Everything here is driven by sim.state (sunDir, daylight, hour).
 */
import {
  BackSide,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  Path,
  PlaneGeometry,
  ShaderMaterial,
  ShadowMaterial,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { PALETTE, clamp, finite, lerp, smoothstep } from './shared.js';

const C = (hex) => new Color(hex);
const SKY = {
  topNight: C('#020409'),
  topDay: C('#0a1a33'),
  horNight: C('#060c17'),
  horDay: C('#1b3352'),
  horGold: C('#3b2a26'),
  below: C('#04070d'),
  sunWarm: C('#ffb36b'),
  sunHigh: C('#fff1dc'),
  groundNight: C('#05080e'),
  groundDay: C('#0a111c'),
};

export function createEnv({ scene, layout, quality }) {
  const disposables = [];
  const keep = (...xs) => (disposables.push(...xs), xs[0]);
  const hx = layout.footprint.w / 2;
  const hz = layout.footprint.d / 2;

  /* ── sky dome ─────────────────────────────────────────────── */
  const skyU = {
    uTop: { value: SKY.topNight.clone() },
    uHor: { value: SKY.horNight.clone() },
    uBelow: { value: SKY.below.clone() },
    uSunDir: { value: new Vector3(0.5, 0.5, 0.5).normalize() },
    uSunCol: { value: SKY.sunHigh.clone() },
    uSunVis: { value: 1 },
    uGold: { value: 0 },
    uNight: { value: 0 },
  };
  const skyMat = keep(
    new ShaderMaterial({
      uniforms: skyU,
      side: BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop, uHor, uBelow, uSunDir, uSunCol;
        uniform float uSunVis, uGold, uNight;
        varying vec3 vDir;
        float h31(vec3 p) { p = fract(p * vec3(.1031, .1030, .0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = h > 0.0
            ? mix(uHor, uTop, pow(clamp(h, 0.0, 1.0), 0.42))
            : mix(uHor, uBelow, pow(clamp(-h * 5.0, 0.0, 1.0), 0.55));
          vec2 sd2 = normalize(uSunDir.xz + 1e-4);
          float az = max(dot(normalize(d.xz + 1e-4), sd2), 0.0);
          float band = exp(-abs(h) * 9.0);
          col += uSunCol * pow(az, 5.0) * band * (0.10 + 0.32 * uGold) * uSunVis;
          float s = max(dot(d, uSunDir), 0.0);
          col += uSunCol * (pow(s, 2400.0) * 6.0 + pow(s, 60.0) * 0.06) * uSunVis * step(-0.02, h);
          if (uNight > 0.01 && h > 0.03) {
            vec3 q = floor(d * 380.0);
            float r = h31(q);
            float star = smoothstep(0.9965, 1.0, r);
            col += vec3(0.75, 0.85, 1.0) * star * uNight * smoothstep(0.03, 0.35, h) * 0.9;
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    }),
  );
  const sky = new Mesh(keep(new SphereGeometry(900, 48, 24)), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  /* ── fog ──────────────────────────────────────────────────── */
  scene.fog = new FogExp2(SKY.horNight.clone(), 0.006);

  /* ── ground: grid, x-ray cut around the basement, glow pool ─ */
  const groundU = {
    uBase: { value: SKY.groundNight.clone() },
    uLine: { value: PALETTE.accent.clone().multiplyScalar(0.5) },
    uAccent: { value: PALETTE.accent.clone() },
    uFogCol: { value: SKY.horNight.clone() },
    uFogDensity: { value: 0.0062 },
    uRect: { value: new Vector3(hx, hz, 11) },
    uIntro: { value: 1 },
    uXray: { value: 1 },
    uTime: { value: 0 },
    uPulse: { value: 1 },
  };
  const groundMat = keep(
    new ShaderMaterial({
      uniforms: groundU,
      transparent: true,
      depthWrite: false,
      extensions: { derivatives: true },
      vertexShader: /* glsl */ `
        varying vec3 vWP;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWP = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uBase, uLine, uAccent, uFogCol, uRect;
        uniform float uFogDensity, uIntro, uXray, uTime, uPulse;
        varying vec3 vWP;
        float grid(vec2 p, float s, float w) {
          vec2 g = abs(fract(p / s - 0.5) - 0.5) * s;
          vec2 fw = fwidth(p) * w;
          vec2 l = 1.0 - smoothstep(vec2(0.0), fw, g);
          return max(l.x, l.y);
        }
        void main() {
          vec2 p = vWP.xz;
          float dist = length(p);
          vec2 q = abs(p) - uRect.xy;
          float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
          float sdp = max(sd, 0.0);
          float fade = 1.0 - smoothstep(14.0, 120.0, sdp);
          fade *= fade;
          // grid draws outward from the site during the intro
          float introR = mix(0.0, 160.0, uIntro);
          float introMask = 1.0 - smoothstep(introR - 24.0, introR, sdp);
          float minor = grid(p, 4.0, 1.0);
          float major = grid(p, 20.0, 1.5);
          // x-ray: the ground thins out around the footprint so the basement reads
          float xr = smoothstep(0.0, uRect.z, sd);
          vec3 col = uBase;
          col += uLine * (minor * 0.09 + major * 0.24) * fade * introMask * mix(0.35, 1.0, xr);
          // soft light pool around the building (echoes the page backdrop glow)
          col += uAccent * 0.03 * exp(-sdp * 0.06);
          float alpha = mix(mix(0.97, 0.16, uXray), 0.97, xr);
          // excavation outline + a fainter offset line, like a section cut
          float rim = 1.0 - smoothstep(0.0, fwidth(sd) * 1.5, abs(sd));
          float rim2 = 1.0 - smoothstep(0.0, fwidth(sd) * 1.2, abs(sd - uRect.z));
          col += uAccent * (rim * 0.5 + rim2 * 0.06) * uIntro;
          alpha = max(alpha, rim * 0.8);
          // a slow scan ring sweeping out from the building
          float ph = fract(uTime / 7.0);
          float ringR = ph * 110.0;
          float ring = exp(-abs(sdp - ringR) * 0.35) * (1.0 - ph) * smoothstep(0.0, 0.08, ph);
          col += uAccent * ring * 0.09 * uPulse * uIntro * step(0.0, sd);
          float camD = distance(cameraPosition, vWP);
          float f = 1.0 - exp(-pow(uFogDensity * camD, 2.0));
          col = mix(col, uFogCol, f);
          alpha = mix(alpha, 1.0, f);
          gl_FragColor = vec4(col, alpha);
        }`,
    }),
  );
  const groundGeo = keep(new PlaneGeometry(1800, 1800, 1, 1));
  groundGeo.rotateX(-Math.PI / 2);
  const ground = new Mesh(groundGeo, groundMat);
  ground.renderOrder = 4;
  ground.name = 'ground';
  scene.add(ground);

  // shadow catcher: a ring around the building (so it never z-fights the L1 floor)
  const ringShape = new Shape();
  ringShape.moveTo(-160, -160);
  ringShape.lineTo(160, -160);
  ringShape.lineTo(160, 160);
  ringShape.lineTo(-160, 160);
  ringShape.lineTo(-160, -160);
  const hole = new Path();
  const m = 0.32;
  hole.moveTo(-hx - m, -hz - m);
  hole.lineTo(-hx - m, hz + m);
  hole.lineTo(hx + m, hz + m);
  hole.lineTo(hx + m, -hz - m);
  hole.lineTo(-hx - m, -hz - m);
  ringShape.holes.push(hole);
  const shadowGeo = keep(new ShapeGeometry(ringShape));
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMat = keep(new ShadowMaterial({ color: 0x000000, opacity: 0.55, depthWrite: false }));
  const shadowCatcher = new Mesh(shadowGeo, shadowMat);
  shadowCatcher.position.y = 0.012;
  shadowCatcher.receiveShadow = true;
  shadowCatcher.renderOrder = 5;
  scene.add(shadowCatcher);

  /* ── lights ───────────────────────────────────────────────── */
  const sun = new DirectionalLight(0xffffff, 2.4);
  sun.position.set(60, 80, 40);
  sun.target.position.set(0, 6, 0);
  scene.add(sun, sun.target);
  const sc = sun.shadow.camera;
  sc.left = -42;
  sc.right = 42;
  sc.top = 42;
  sc.bottom = -42;
  sc.near = 10;
  sc.far = 320;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;

  const moon = new DirectionalLight(C('#8fb2e6'), 0.35);
  moon.position.set(-50, 70, -30);
  scene.add(moon);

  const hemi = new HemisphereLight(C('#6a8bb8'), C('#0a0d12'), 0.4);
  scene.add(hemi);

  /* ── per-frame update ─────────────────────────────────────── */
  const tmpDir = new Vector3();
  const cTop = new Color();
  const cHor = new Color();
  const cSun = new Color();
  const env = {
    sun,
    moon,
    hemi,
    sky,
    ground,
    groundU,
    skyU,
    shadowCatcher,
    daylight: 0,
    night: 1,
    gold: 0,
    sunDir: new Vector3(0.4, 0.6, 0.5).normalize(),
    horizon: SKY.horNight.clone(),
    sunColor: SKY.sunHigh.clone(),
    lastShadowDir: new Vector3(),
    setShadows(on) {
      sun.castShadow = !!on;
      shadowCatcher.visible = !!on;
    },
    update(state, dt, t) {
      const sd = state?.sunDir;
      if (Array.isArray(sd) && sd.length === 3 && sd.every(Number.isFinite)) tmpDir.set(sd[0], sd[1], sd[2]);
      else {
        const alt = finite(state?.sunAlt, 0.6);
        const az = finite(state?.sunAz, 2);
        tmpDir.set(Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az));
      }
      if (tmpDir.lengthSq() < 1e-6) tmpDir.set(0.4, 0.6, 0.5);
      tmpDir.normalize();
      env.sunDir.copy(tmpDir);
      const alt = Math.asin(clamp(tmpDir.y, -1, 1));
      const day = smoothstep(-0.1, 0.22, alt);
      const night = 1 - smoothstep(-0.2, 0.04, alt);
      const gold = smoothstep(0.42, 0.04, alt) * smoothstep(-0.14, 0.02, alt);
      env.daylight = day;
      env.night = night;
      env.gold = gold;

      cTop.copy(SKY.topNight).lerp(SKY.topDay, day);
      cHor.copy(SKY.horNight).lerp(SKY.horDay, day).lerp(SKY.horGold, gold * 0.55);
      cSun.copy(SKY.sunHigh).lerp(SKY.sunWarm, smoothstep(0.55, 0.05, alt));
      env.horizon.copy(cHor);
      env.sunColor.copy(cSun);

      skyU.uTop.value.copy(cTop);
      skyU.uHor.value.copy(cHor);
      skyU.uSunDir.value.copy(tmpDir);
      skyU.uSunCol.value.copy(cSun);
      skyU.uSunVis.value = smoothstep(-0.08, 0.04, alt);
      skyU.uGold.value = gold;
      skyU.uNight.value = night;

      scene.fog.color.copy(cHor).lerp(SKY.below, 0.55);
      groundU.uFogCol.value.copy(scene.fog.color);
      groundU.uBase.value.copy(SKY.groundNight).lerp(SKY.groundDay, day);

      // sun: only when it's up; warm and low in the morning/evening
      const sunUp = smoothstep(-0.02, 0.12, alt);
      sun.position.copy(tmpDir).multiplyScalar(140).add(sun.target.position);
      sun.intensity = 3.1 * sunUp;
      sun.color.copy(cSun);
      sun.visible = sunUp > 0.001;
      moon.intensity = lerp(0.22, 0.55, night);
      hemi.intensity = lerp(0.32, 0.95, day);
      hemi.color.copy(SKY.horDay).lerp(C('#8fb0d8'), day * 0.6);
      scene.environmentIntensity = lerp(0.18, 0.55, day);

      groundU.uTime.value = t;
    },
    /** True when the sun moved enough that the shadow map should refresh. */
    shadowDirty() {
      if (env.lastShadowDir.distanceToSquared(env.sunDir) > 2e-6) {
        env.lastShadowDir.copy(env.sunDir);
        return true;
      }
      return false;
    },
    dispose() {
      scene.remove(sky, ground, shadowCatcher, sun, sun.target, moon, hemi);
      sun.shadow.map?.dispose();
      for (const d of disposables) d?.dispose?.();
      scene.fog = null;
    },
  };
  return env;
}
