/**
 * Digital Twin units — freeze (LOD0) and bake (LOD1) for an embedded ClarityView view.
 *
 *   probe(view)                         what moves / changes when the values move
 *   freeze(view, { canon })             merge every static mesh per (rigid body, material)
 *   bake(root, { mats })                everything at its current pose → ≤ 3 vertex-coloured draws
 *   expandInstances(mesh, fn)           helper: each instance's matrix
 *
 * Generic on purpose: nothing here enumerates a family's parts. The probe drives
 * the view's own resolver through four stimulus phases and watches transforms,
 * visibility and material state, so whatever ClarityView animates stays a rigid
 * body with its material identity intact, and everything else collapses.
 */
import {
  BufferAttribute,
  Color,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  DoubleSide,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const MAT_STATE = ['opacity', 'emissiveIntensity', 'visible', 'transparent', 'roughness', 'metalness'];
const MAPS = ['map', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'emissiveMap', 'envMap', 'lightMap', 'metalnessMap', 'normalMap', 'roughnessMap', 'specularMap', 'gradientMap', 'matcap'];
const DEFAULT_OBC = Material.prototype.onBeforeCompile;

function matState(m) {
  let s = '';
  for (const k of MAT_STATE) s += `${m[k]}|`;
  if (m.color) s += m.color.getHex() + '|';
  if (m.emissive) s += m.emissive.getHex();
  return s;
}
/** Dedupe signature of a material, or null when it must keep its identity. */
function signature(m) {
  if (m.isShaderMaterial || m.onBeforeCompile !== DEFAULT_OBC || m.userData?.noDedupe) return null;
  const p = [m.type, m.side, m.depthWrite, m.depthTest, m.blending, m.toneMapped, m.alphaTest, m.vertexColors, m.flatShading, m.wireframe,
    m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits, m.envMapIntensity, m.linewidth, m.fog, m.colorWrite, m.premultipliedAlpha,
    m.dithering, m.alphaToCoverage, m.sheen, m.clearcoat, m.transmission, m.ior, m.reflectivity, m.specularIntensity, m.emissiveIntensity, JSON.stringify(m.defines || null)];
  for (const k of MAPS) p.push(m[k]?.uuid || '');
  return p.join(',') + '#' + matState(m);
}
const matsOf = (o) => (Array.isArray(o.material) ? o.material : o.material ? [o.material] : []);

/**
 * Drive the view through extreme values; report the objects whose transform,
 * visibility or material reference changed, and the materials whose state changed.
 * Leaves the live resolver in place and the values marked dirty.
 */
export function probe(view) {
  const root = view.unit;
  const objs = [];
  root.traverse((o) => objs.push(o));
  const snap = new Map(objs.map((o) => [o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(), v: o.visible, m: o.material }]));
  const mats = new Set();
  for (const o of objs) for (const m of matsOf(o)) mats.add(m);
  const msnap = new Map([...mats].map((m) => [m, matState(m)]));
  const live = view._resolveLive;
  const showAir = view.showAir;
  view.showAir = false;
  let now = performance.now();
  const flt = /FLT|ALM|FAULT/;
  const phases = [
    (s) => ({ value: flt.test(s) ? 0 : 100, status: 'normal' }),
    () => ({ value: 0, status: 'normal' }),
    (s) => ({ value: flt.test(s) ? 1 : 50, status: 'normal' }),
    (s) => ({ value: flt.test(s) ? 0 : 35, status: 'normal' }),
  ];
  try {
    for (const ph of phases) {
      view._resolveLive = ph;
      view.dirty = true;
      view._lastValues = -1e9;
      for (let i = 0; i < 3; i++) {
        now += 400;
        view.tick(0.4, now);
      }
    }
  } finally {
    view._resolveLive = live;
    view.showAir = showAir;
    view.dirty = true;
    view._lastValues = -1e9;
  }
  // anything the probe added (it should add nothing: air is off) is treated as moving
  const moved = new Set();
  root.traverse((o) => {
    const a = snap.get(o);
    if (!a || !o.position.equals(a.p) || !o.quaternion.equals(a.q) || !o.scale.equals(a.s) || o.visible !== a.v || o.material !== a.m) moved.add(o);
  });
  const liveMats = new Set();
  for (const m of mats) if (matState(m) !== msnap.get(m)) liveMats.add(m);
  root.traverse((o) => {
    if (moved.has(o)) for (const m of matsOf(o)) liveMats.add(m);
  });
  return { moved, liveMats };
}

/** Settle the view on its live values (after a probe or before a bake). */
export function settle(view, n = 3) {
  view.dirty = true;
  view._lastValues = -1e9;
  let now = performance.now();
  const air = view.showAir;
  view.showAir = false;
  for (let i = 0; i < n; i++) {
    now += 300;
    view.tick(1.5, now);
  }
  view.showAir = air;
}

function attrSig(g) {
  const a = g.attributes;
  let s = '';
  for (const k of ['position', 'normal', 'uv', 'color']) if (a[k]) s += `${k}${a[k].itemSize}${a[k].normalized ? 'n' : ''};`;
  return s + (g.index ? 'I' : 'N');
}

/**
 * LOD0: merge every static Mesh / LineSegments under view.unit per (nearest
 * moving ancestor, material, kind, shadow flags, render order, culling,
 * attribute set). CSS2D readouts and never-visible static meshes are removed;
 * empty static groups are pruned. `canon` is a Map shared by every unit on a
 * level: identical untouched materials collapse to one.
 */
export function freeze(view, { canon = new Map() } = {}) {
  const root = view.unit;
  const t0 = performance.now();
  const { moved, liveMats } = probe(view);
  const probeMs = performance.now() - t0;
  root.updateMatrixWorld(true);
  const isBody = (o) => o === root || moved.has(o);
  const canonOf = (m) => {
    if (liveMats.has(m)) return m;
    const sig = signature(m);
    if (!sig) return m;
    if (!canon.has(sig)) canon.set(sig, m);
    return canon.get(sig);
  };
  const buckets = new Map();
  const victims = [];
  let before = 0;
  root.traverse((o) => {
    if (o.isCSS2DObject) {
      victims.push(o);
      return;
    }
    if (o.userData?.air) return;
    const merge = (o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh) || o.isLineSegments;
    if (!merge || moved.has(o) || Array.isArray(o.material) || !o.material) return;
    const g = o.geometry;
    if (!g?.attributes?.position || o.morphTargetInfluences || Object.keys(g.morphAttributes || {}).length) return;
    // the nearest moving ancestor (or the unit itself)
    let b = o.parent;
    let hidden = !o.visible;
    while (b && !isBody(b)) {
      if (!b.visible) hidden = true;
      b = b.parent;
    }
    if (!b) return;
    before++;
    if (hidden || o.material.visible === false) {
      // a static part that is never shown
      victims.push(o);
      return;
    }
    const mat = canonOf(o.material);
    const line = !!o.isLineSegments;
    const sig = attrSig(g);
    const key = `${b.uuid}|${mat.uuid}|${line ? 'L' : 'M'}|${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}|${o.renderOrder}|${o.frustumCulled ? 1 : 0}|${sig}`;
    let bk = buckets.get(key);
    if (!bk) buckets.set(key, (bk = { b, mat, line, cast: o.castShadow, recv: o.receiveShadow, order: o.renderOrder, culled: o.frustumCulled, list: [] }));
    bk.list.push(o);
  });
  const inv = new Matrix4();
  const rel = new Matrix4();
  let after = 0;
  for (const bk of buckets.values()) {
    const only = bk.list.length === 1 ? bk.list[0] : null;
    if (only && only.parent === bk.b && only.material === bk.mat) {
      after++;
      continue;
    }
    inv.copy(bk.b.matrixWorld).invert();
    const geos = [];
    for (const o of bk.list) {
      const g = o.geometry.clone();
      g.clearGroups();
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) g.deleteAttribute(k);
      if (bk.line) for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'color') g.deleteAttribute(k);
      rel.multiplyMatrices(inv, o.matrixWorld);
      g.applyMatrix4(rel);
      if (!bk.line) fixWinding(g, rel);
      geos.push(g);
    }
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos);
    if (geos.length > 1) geos.forEach((g) => g.dispose());
    if (!merged) {
      after += bk.list.length;
      continue;
    }
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    const mesh = bk.line ? new LineSegments(merged, bk.mat) : new Mesh(merged, bk.mat);
    mesh.castShadow = bk.cast;
    mesh.receiveShadow = bk.recv;
    mesh.renderOrder = bk.order;
    mesh.frustumCulled = bk.culled;
    mesh.userData.frozen = true;
    for (const o of bk.list) victims.push(o);
    bk.b.add(mesh);
    after++;
  }
  for (const o of victims) o.removeFromParent();
  // prune now-empty static groups
  const prune = (o) => {
    for (const c of [...o.children]) prune(c);
    if (o !== root && !isBody(o) && o.type === 'Group' && o.children.length === 0) o.removeFromParent();
  };
  prune(root);
  return { moved, liveMats, probeMs: +probeMs.toFixed(1), totalMs: +(performance.now() - t0).toFixed(1), meshesBefore: before, meshesAfter: after };
}

/**
 * A piece moved into another frame by a mirroring matrix keeps its triangles'
 * winding, so once merged with unmirrored pieces it would render inside out:
 * flip its triangles back (indexed: swap two corners; non-indexed: two vertices).
 */
export function fixWinding(g, m) {
  if (m.determinant() >= 0) return;
  if (g.index) {
    const a = g.index.array;
    for (let i = 0; i + 2 < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
    g.index.needsUpdate = true;
    return;
  }
  for (const attr of Object.values(g.attributes)) {
    const a = attr.array;
    const s = attr.itemSize;
    for (let v = 0; v + 2 < attr.count; v += 3) {
      for (let k = 0; k < s; k++) {
        const i1 = (v + 1) * s + k;
        const i2 = (v + 2) * s + k;
        const t = a[i1];
        a[i1] = a[i2];
        a[i2] = t;
      }
    }
    attr.needsUpdate = true;
  }
}

/** Calls fn(matrix) for each instance of an InstancedMesh (or once with identity for a plain mesh). */
const _im = new Matrix4();
export function eachInstance(o, fn) {
  if (!o.isInstancedMesh) return fn(null);
  for (let i = 0; i < o.count; i++) {
    o.getMatrixAt(i, _im);
    fn(_im);
  }
}

/**
 * Per-level bake materials: opaque vertex colour, faint glass, dark outlines.
 * Shared by every unit on a level (and patched once per level by the host).
 */
export function bakeMaterials() {
  return {
    solid: new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.35, envMapIntensity: 0.6 }),
    glass: new MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0, transparent: true, opacity: 0.06, depthWrite: false, side: DoubleSide }),
    line: new LineBasicMaterial({ color: '#07090b', transparent: true, opacity: 0.9 }),
  };
}

const _col = new Color();
/**
 * Prepares one mesh's geometry for a bake, in `root`'s frame: position, normal
 * (meshes) and a colour attribute from the material (times the geometry's own
 * colours where the material uses them). Emissive state is NOT baked in: LOD1
 * is a static copy and never claims a running fan or an open valve.
 * Returns an indexed geometry (or null).
 */
export function bakePiece(o, rel, { line = false, colorOverride = null } = {}) {
  const m = Array.isArray(o.material) ? o.material[0] : o.material;
  const src = o.geometry;
  if (!src?.attributes?.position) return null;
  const g = src.clone();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
  for (const k of Object.keys(g.morphAttributes || {})) delete g.morphAttributes[k];
  g.clearGroups();
  if (line) {
    for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  } else {
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    _col.copy(colorOverride || m?.color || _col.set(1, 1, 1));
    const vc = !colorOverride && m?.vertexColors && src.attributes.color;
    const sc = vc ? src.attributes.color : null;
    for (let i = 0; i < n; i++) {
      let r = _col.r;
      let gg = _col.g;
      let b = _col.b;
      if (sc) {
        r *= sc.getX(i);
        gg *= sc.getY(i);
        b *= sc.getZ(i);
      }
      c[i * 3] = r;
      c[i * 3 + 1] = gg;
      c[i * 3 + 2] = b;
    }
    g.setAttribute('color', new Float32BufferAttribute(c, 3));
  }
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new BufferAttribute(idx, 1));
  }
  g.applyMatrix4(rel);
  if (!line) fixWinding(g, rel);
  return g;
}

/**
 * LOD1: every visible mesh and line under root (moving parts at their current
 * pose, instanced meshes expanded) merged into at most three objects in root's
 * own frame: opaque, glass (opacity < 0.6) and outlines. The caller gives the
 * returned group root's local transform (a mirrored unit stays mirrored in its
 * object matrix, where three fixes the winding).
 * Also returns `xray`: the opaque parts with a bbox diagonal ≥ xrayMin, position + normal only.
 */
export function bake(root, { mats, xrayMin = 0.25, skip = null } = {}) {
  root.updateMatrixWorld(true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const rel = new Matrix4();
  const relI = new Matrix4();
  const groups = { solid: [], glass: [], line: [], xray: [] };
  root.traverseVisible((o) => {
    if (o === root || o.userData?.air || o.isPoints || o.isCSS2DObject) return;
    if (skip && skip(o)) return;
    if (!(o.isMesh || o.isLineSegments)) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || m.visible === false || m.isShaderMaterial) return;
    const kind = o.isLineSegments ? 'line' : m.transparent && m.opacity < 0.6 ? 'glass' : 'solid';
    rel.multiplyMatrices(inv, o.matrixWorld);
    eachInstance(o, (im) => {
      const r = im ? relI.multiplyMatrices(rel, im) : rel;
      const g = bakePiece(o, r, { line: kind === 'line' });
      if (!g) return;
      groups[kind].push(g);
      if (kind === 'solid' && xrayMin > 0) {
        g.computeBoundingBox();
        const bb = g.boundingBox;
        const diag = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
        if (diag >= xrayMin) groups.xray.push(g);
      }
    });
  });
  const out = { solid: null, glass: null, line: null, xray: null, tris: 0, draws: 0 };
  for (const k of ['solid', 'glass', 'line']) {
    const list = groups[k];
    if (!list.length) continue;
    const g = list.length === 1 ? list[0] : mergeGeometries(list);
    if (!g) continue;
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const o = k === 'line' ? new LineSegments(g, mats.line) : new Mesh(g, mats[k]);
    o.userData.baked = k;
    if (k === 'solid') o.castShadow = true;
    if (k === 'glass') o.renderOrder = 2;
    out[k] = o;
    out.draws++;
    if (k !== 'line') out.tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
  if (groups.xray.length) {
    const pieces = groups.xray.map((g) => {
      const x = g.clone();
      x.deleteAttribute('color');
      return x;
    });
    out.xray = pieces.length === 1 ? pieces[0] : mergeGeometries(pieces);
    pieces.forEach((p) => p !== out.xray && p.dispose());
  }
  for (const k of ['solid', 'glass', 'line']) for (const g of groups[k]) if (groups[k].length > 1) g.dispose();
  out.tris = Math.round(out.tris);
  return out;
}
