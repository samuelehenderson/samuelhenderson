/**
 * Digital Twin — overlays in 3D: hover / selection corner brackets and
 * floating alarm markers (pulsing callout + beam down to the target).
 */
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { PALETTE, alarmIconTexture, damp, glowTexture } from './shared.js';

function bracketPositions(f = 0.24) {
  const out = [];
  for (const sx of [-0.5, 0.5])
    for (const sy of [-0.5, 0.5])
      for (const sz of [-0.5, 0.5]) {
        out.push(sx, sy, sz, sx - Math.sign(sx) * f, sy, sz);
        out.push(sx, sy, sz, sx, sy - Math.sign(sy) * f, sz);
        out.push(sx, sy, sz, sx, sy, sz - Math.sign(sz) * f);
      }
  return out;
}

export function createFx({ scene }) {
  const group = new Group();
  group.name = 'fx';
  scene.add(group);
  const disposables = [];
  const bracketGeo = new LineSegmentsGeometry();
  bracketGeo.setPositions(bracketPositions());
  disposables.push(bracketGeo);

  function makeBracket(color, width, opacity) {
    const mat = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthTest: false, depthWrite: false });
    disposables.push(mat);
    const l = new LineSegments2(bracketGeo, mat);
    l.renderOrder = 20;
    l.visible = false;
    l.frustumCulled = false;
    group.add(l);
    return { line: l, mat, vis: 0, target: 0, center: new Vector3(), size: new Vector3(1, 1, 1) };
  }
  const hover = makeBracket(PALETTE.accentSoft.clone().multiplyScalar(1.4), 1.6, 0.7);
  const select = makeBracket(PALETTE.accent.clone().multiplyScalar(2.2), 2.2, 1);
  const lineMats = [hover.mat, select.mat];

  // alarm markers
  const icon = alarmIconTexture();
  const glow = glowTexture();
  disposables.push(icon, glow);
  const beamGeo = new CylinderGeometry(0.035, 0.035, 1, 6, 1, true);
  beamGeo.translate(0, 0.5, 0);
  disposables.push(beamGeo);
  const markers = [];
  function makeMarker() {
    const g = new Group();
    const iconMat = new SpriteMaterial({ map: icon, color: PALETTE.alarm.clone().multiplyScalar(2.2), depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true });
    const haloMat = new SpriteMaterial({ map: glow, color: PALETTE.alarm.clone().multiplyScalar(1.6), depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true, blending: AdditiveBlending });
    const beamMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      uniforms: { uColor: { value: PALETTE.alarm.clone() }, uA: { value: 1 } },
      vertexShader: 'varying float vY; void main(){ vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 uColor; uniform float uA; varying float vY; void main(){ gl_FragColor = vec4(uColor * (0.25 + 1.4 * vY) * uA, 1.0); }',
    });
    disposables.push(iconMat, haloMat, beamMat);
    const iconS = new Sprite(iconMat);
    const halo = new Sprite(haloMat);
    const beam = new Mesh(beamGeo, beamMat);
    iconS.renderOrder = 22;
    halo.renderOrder = 21;
    beam.renderOrder = 21;
    beam.frustumCulled = false;
    g.add(beam, halo, iconS);
    const br = makeBracket(PALETTE.alarm.clone().multiplyScalar(2.0), 1.6, 0.9);
    lineMats.push(br.mat);
    g.visible = false;
    group.add(g);
    return { g, icon: iconS, halo, beam, iconMat, haloMat, beamMat, br, key: null, vis: 0, center: new Vector3(), size: new Vector3(), phase: Math.random() * 6 };
  }
  for (let i = 0; i < 6; i++) markers.push(makeMarker());

  function placeBracket(b, center, size, pad = 0.35) {
    b.center.copy(center);
    b.size.set(size.x + pad, size.y + pad, size.z + pad);
  }

  return {
    group,
    lineMats,
    setHover(center, size) {
      if (center) {
        placeBracket(hover, center, size);
        hover.target = 1;
      } else hover.target = 0;
    },
    setSelect(center, size) {
      if (center) {
        placeBracket(select, center, size, 0.6);
        select.target = 1;
      } else select.target = 0;
    },
    /** list: [{ key, center: Vector3, size: Vector3 }] */
    setAlarms(list, selectedId = null) {
      for (const m of markers) m.hideBracket = !!selectedId && m.key === selectedId;
      const keys = new Set(list.map((a) => a.key));
      for (const m of markers) if (m.key && !keys.has(m.key)) m.key = null;
      for (const a of list) {
        let m = markers.find((x) => x.key === a.key);
        if (!m) m = markers.find((x) => !x.key && x.vis < 0.02) || markers.find((x) => !x.key);
        if (!m) continue;
        m.key = a.key;
        m.hideBracket = !!selectedId && a.key === selectedId;
        m.center.copy(a.center);
        m.size.copy(a.size);
      }
    },
    update(t, dt, { reducedMotion = false, scale = 1 } = {}) {
      for (const b of [hover, select]) {
        b.vis = damp(b.vis, b.target, 14, dt);
        b.line.visible = b.vis > 0.01;
        if (!b.line.visible) continue;
        const grow = 1 + (1 - b.vis) * 0.12;
        b.line.position.copy(b.center);
        b.line.scale.copy(b.size).multiplyScalar(grow);
        b.mat.opacity = b.vis * (b === hover ? 0.75 : 1);
      }
      for (const m of markers) {
        m.vis = damp(m.vis, m.key ? 1 : 0, 6, dt);
        m.g.visible = m.vis > 0.01;
        m.br.line.visible = m.g.visible && !m.hideBracket;
        if (!m.g.visible) continue;
        const pulse = reducedMotion ? 0.75 : 0.5 + 0.5 * Math.sin(t * 4.2 + m.phase);
        const topY = m.center.y + m.size.y / 2;
        const lift = 2.6;
        m.icon.position.set(m.center.x, topY + lift, m.center.z);
        m.halo.position.copy(m.icon.position);
        const s = 0.024 * scale;
        m.icon.scale.set(s, s, 1);
        const hs = s * (1.9 + (reducedMotion ? 0 : pulse * 0.7));
        m.halo.scale.set(hs, hs, 1);
        m.iconMat.opacity = m.vis;
        m.haloMat.opacity = m.vis * (0.25 + 0.35 * pulse);
        m.beam.position.set(m.center.x, m.center.y, m.center.z);
        m.beam.scale.set(1, topY + lift - m.center.y, 1);
        m.beamMat.uniforms.uA.value = m.vis * (0.5 + 0.5 * pulse);
        m.br.line.position.copy(m.center);
        m.br.line.scale.set(m.size.x + 0.4, m.size.y + 0.4, m.size.z + 0.4);
        m.br.mat.opacity = m.vis * (0.45 + 0.55 * pulse);
      }
    },
    setResolution(w, h) {
      for (const m of lineMats) m.resolution.set(w, h);
    },
    dispose() {
      for (const d of disposables) d?.dispose?.();
      group.removeFromParent();
    },
  };
}


