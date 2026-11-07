/**
 * vav-parts3d.js — the parts an air terminal is built from, in three.js.
 *
 * Every size and position comes from vav-layout.js (inches, unit frame); this
 * file only knows how a collar, a blade, a casing or a coil LOOKS. The only
 * numbers here are rendering constants that never move a part (sheet
 * thickness, tube and bead sizes, fin count).
 *
 * Materials: vavMaterials(m) builds one set per material set (m.vav) and flags
 * each material userData.physical = true (never themed) and userData.shared =
 * true (the building twin's disposal leaves them alone). Per-unit materials —
 * coil fins/tubes, heater stages, the fan band — are created per build and
 * disposed with the unit.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const IN = 0.0254;
const SHEET = 0.0008;          // galvanised sheet, 0.8 mm (rendering only)

/** The shared VAV materials, built once per material set. */
export function vavMaterials(m) {
  if (m.vav) return m.vav;
  const S = (o) => {
    const mat = new THREE.MeshStandardMaterial(o);
    mat.userData.physical = true;
    mat.userData.shared = true;
    return mat;
  };
  m.vav = {
    // galvanised sheet (collar, valve body, controls enclosure): a calm mid grey, not a white glare
    galv: S({ color: '#7b8489', metalness: 0.45, roughness: 0.55, envMapIntensity: 0.22, side: THREE.DoubleSide }),
    galvDark: S({ color: '#59636a', metalness: 0.45, roughness: 0.6, envMapIntensity: 0.22, side: THREE.DoubleSide }),
    liner: S({ color: '#1c2630', metalness: 0.0, roughness: 0.95, side: THREE.DoubleSide }),
    blade: S({ color: '#98a4ab', metalness: 0.65, roughness: 0.35, envMapIntensity: 0.5, side: THREE.DoubleSide }),
    ghost: S({ color: '#9fb0ba', metalness: 0.2, roughness: 0.6, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
    gasket: S({ color: '#15191d', metalness: 0.1, roughness: 0.8 }),
    steel: S({ color: '#8f99a3', metalness: 0.85, roughness: 0.28 }),
    copper: S({ color: '#b8733a', metalness: 0.9, roughness: 0.32 }),
    brass: S({ color: '#c98a3c', metalness: 0.85, roughness: 0.32 }),
    ral7035: S({ color: '#aeb3af', metalness: 0.05, roughness: 0.7, envMapIntensity: 0.4 }),
    actuator: S({ color: '#7f898f', metalness: 0.1, roughness: 0.65, envMapIntensity: 0.4 }),
    media: S({ color: '#a9a291', metalness: 0.0, roughness: 0.95, side: THREE.DoubleSide }),
    dark: S({ color: '#1b2025', metalness: 0.55, roughness: 0.5 }),
    element: S({ color: '#6b747b', metalness: 0.6, roughness: 0.45 }),
    tube: S({ color: '#8f99a3', metalness: 0.4, roughness: 0.5 }),
    // the flow cross's sensing tubes (photo): total pressure red, static blue — physical colours, never a status
    tubeRed: S({ color: '#C94A33', metalness: 0.05, roughness: 0.45 }),
    tubeBlue: S({ color: '#3673B8', metalness: 0.05, roughness: 0.45 }),
  };
  return m.vav;
}

/** Hide a subtree from the building twin's footprint (enclosures, piping, devices…). */
export function noFootprint(o) { o.userData.noFootprint = true; return o; }

// ---- geometry helpers (all in metres, built in a section group's frame) ----

/** Box geometry centred on (cx, cy, cz). */
export function boxGeo(sx, sy, sz, cx, cy, cz) {
  const g = new THREE.BoxGeometry(Math.max(sx, 1e-4), Math.max(sy, 1e-4), Math.max(sz, 1e-4));
  g.translate(cx, cy, cz);
  return g;
}

/** Cylinder along an axis ('x' | 'y' | 'z'), centred on (cx, cy, cz). */
export function cylGeo(r, len, axis, cx, cy, cz, seg = 20, open = false) {
  const g = new THREE.CylinderGeometry(r, r, Math.max(len, 1e-4), seg, 1, open);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(cx, cy, cz);
  return g;
}

/**
 * A flat panel in the plane x = px (an end face), spanning z0..z1 × y0..y1,
 * with round / rect holes: [{ kind: 'circle', z, y, r } | { kind: 'rect', z0, z1, y0, y1 }].
 */
export function endFaceGeo(px, z0, z1, y0, y1, holes = []) {
  // shape coordinates (u, v) = (-z, y); rotateY(π/2) maps (u, v, 0) → (0, v, -u)
  const sh = new THREE.Shape();
  sh.moveTo(-z0, y0); sh.lineTo(-z1, y0); sh.lineTo(-z1, y1); sh.lineTo(-z0, y1); sh.lineTo(-z0, y0);
  for (const h of holes) {
    const p = new THREE.Path();
    if (h.kind === 'circle') p.absarc(-h.z, h.y, h.r, 0, Math.PI * 2, true);
    else { p.moveTo(-h.z0, h.y0); p.lineTo(-h.z0, h.y1); p.lineTo(-h.z1, h.y1); p.lineTo(-h.z1, h.y0); p.lineTo(-h.z0, h.y0); }
    sh.holes.push(p);
  }
  const g = new THREE.ShapeGeometry(sh, 24);
  g.rotateY(Math.PI / 2);
  g.translate(px, 0, 0);
  return g;
}

/** Merge static geometries that share a material into one mesh (fewer draw calls). */
export function mergeStatic(parent, mat, geos, { shadow = true, name = '' } = {}) {
  const list = geos.filter(Boolean).map((g) => (g.index ? g : g.toNonIndexed ? g : g));
  if (!list.length) return null;
  const sameIndex = list.every((g) => !!g.index) || list.every((g) => !g.index);
  const norm = sameIndex ? list : list.map((g) => (g.index ? g.toNonIndexed() : g));
  // every geometry needs the same attributes (position, normal, uv)
  for (const g of norm) if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  const merged = norm.length === 1 ? norm[0] : mergeGeometries(norm, false);
  if (norm.length > 1) for (const g of norm) g.dispose();
  const mesh = new THREE.Mesh(merged, mat);
  mesh.name = name;
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** A placeholder device: a housing of catalogue size (mm) oriented by a pose. */
export function placeholder(parent, mm, pose, mat, label = '') {
  const g = new THREE.Group();
  g.name = 'placeholder' + (label ? `:${label}` : '');
  const [l, h, d] = mm.map((v) => v / 1000);
  // local frame: +z = the pose normal (out of the mounting face), +y = pose.up
  const body = new THREE.Mesh(new THREE.BoxGeometry(l, h, d), mat);
  body.position.z = d / 2;
  body.castShadow = false;
  g.add(body);
  orient(g, pose);
  parent.add(noFootprint(g));
  return g;
}

/** Place a group at pose.pos with its +z along pose.normal and +y along pose.up. */
export function orient(g, pose) {
  const n = new THREE.Vector3(...pose.normal).normalize();
  const up = new THREE.Vector3(...(pose.up || [0, 1, 0])).normalize();
  const x = new THREE.Vector3().crossVectors(up, n).normalize();
  const y = new THREE.Vector3().crossVectors(n, x).normalize();
  g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, n));
  g.position.set(...pose.pos);
  return g;
}

/** Forward-curved blower: scroll, wheel of thin blades (instanced), motor with a status band. */
export function blower(parent, { r, w, axis, mats, full }) {
  const g = new THREE.Group();
  const holder = new THREE.Group();
  if (axis === 'z') holder.rotation.y = Math.PI / 2;      // the wheel turns about its local x
  g.add(holder);
  const scroll = new THREE.Mesh(cylGeo(r, w, 'x', 0, 0, 0, 28, false), mats.galvDark);
  scroll.castShadow = true;
  holder.add(scroll);
  const wheel = new THREE.Group();
  holder.add(wheel);
  if (full) {
    const n = 28, rr = r * 0.78;
    const bl = new THREE.InstancedMesh(new THREE.BoxGeometry(w * 0.86, r * 0.22, 0.0025), mats.blade, n);
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1), mtx = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      p.set(0, Math.cos(a) * rr, Math.sin(a) * rr);
      q.setFromEuler(new THREE.Euler(a + 0.6, 0, 0));
      mtx.compose(p, q, sc);
      bl.setMatrixAt(i, mtx);
    }
    wheel.add(bl);
  } else {
    const hubM = new THREE.Mesh(cylGeo(r * 0.72, w * 0.8, 'x', 0, 0, 0, 12, true), mats.blade);
    wheel.add(hubM);
  }
  const motorM = new THREE.Mesh(cylGeo(r * 0.36, w * 0.3, 'x', -(w / 2 + w * 0.15), 0, 0, 16), mats.dark);
  holder.add(motorM);
  const band = new THREE.Mesh(cylGeo(r * 0.37, w * 0.04, 'x', -(w / 2 + w * 0.26), 0, 0, 16),
    new THREE.MeshStandardMaterial({ color: '#46d3e6', emissive: '#46d3e6', emissiveIntensity: 0 }));
  holder.add(band);
  parent.add(g);
  return { g, wheel, band };
}
