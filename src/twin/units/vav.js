/**
 * Digital Twin units — the VAV terminal, built once and baked for all 60 zones.
 *
 *   buildVavGeometry(Vav3DView, mats, { tier }) → { geometry, far, box, tris, farTris, pieces }
 *
 * ClarityView's 12" single-duct HW-reheat terminal (catalog VAV) is embedded
 * into an off-scene group with no bindings (nothing moves, no air), then baked
 * into ONE indexed geometry in the terminal's frame with the inlet collar centre
 * at the origin and the air running along +x:
 *   aCol   the part's colour; the see-through twin casing becomes opaque
 *          galvanised sheet metal (it hangs in a ceiling, seen from outside)
 *   aPart  0 metal / devices, 1 the reheat coil (glows with reheat %),
 *          2 the diffuser neck and plate under the discharge (Airflow mode)
 * The damper blade inside the inlet is dropped (the casing and the branch hide
 * it). The world draws it with its per-level InstancedMesh and zone texture,
 * so every zone keeps its pick, hover, alarm and reheat glow, one draw per level.
 * Low tier keeps only parts with a bbox diagonal ≥ 0.12 m within 400 tris (the
 * finest detail is dropped first), else a box the size of the casing.
 * `far` is the distant copy (the world swaps a level's terminals to it once the
 * camera is well away, where a terminal is a few pixels): each big part
 * (diagonal ≥ 0.4 m: casing, coil, discharge plenum, inlet) as its own box in
 * its own colour and part, plus the diffuser; about 100 triangles.
 */
import { Box3, BoxGeometry, BufferAttribute, Color, Group, Matrix4, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { VAV, mapOf } from './catalog.js';
import { bakePiece, eachInstance } from './freeze.js';

const GALV = new Color('#8f99a3');
const DIFFUSER = new Color('#a6b0bb');
const LOW_DIAG = 0.12;
const LOW_TRIS = 400;
const FAR_DIAG = 0.4;

function withPart(g, part) {
  const n = g.attributes.position.count;
  g.setAttribute('aPart', new BufferAttribute(new Float32Array(n).fill(part), 1));
  return g;
}
function asCol(g) {
  g.setAttribute('aCol', g.attributes.color);
  g.deleteAttribute('color');
  return g;
}
const trisOf = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

export function buildVavGeometry(Vav3DView, mats, { tier = 'high' } = {}) {
  const map = mapOf({ id: '__vav', config: VAV.config });
  const view = new Vav3DView({ title: 'VAV', config: VAV.config, kind: VAV.kind });
  const g = new Group();
  view.embed(g, 'vav.', (s) => map.has(s), () => null, mats);
  g.updateMatrixWorld(true);
  const unit = view.unit;
  const inlet = view.inletLocal || { x: 0, y: 0, z: 0 };
  const out = view.outletLocal || { x: 0.3, y: inlet.y, z: 0, w: 0.4 };
  const coilMats = new Set(view.parts.coils[0]?.mats || []);
  // the round damper blade(s) inside the inlet: hidden by the opaque casing and the branch duct
  const blades = (view.parts.dampers[0]?.blades || []).filter(Boolean);
  const under = (o, anc) => {
    for (let a = o; a; a = a.parent) if (a === anc) return true;
    return false;
  };
  // the reheat coil's section: its fins sit inside the (now opaque) shell, so the
  // shell itself carries the reheat glow (aPart 1) and the fins are dropped
  let coilSec = null;
  unit.traverse((o) => {
    if (!coilSec && o.isMesh && coilMats.has(Array.isArray(o.material) ? o.material[0] : o.material)) coilSec = o.parent;
  });
  // unit frame, shifted so the inlet collar centre is the origin
  const inv = new Matrix4().copy(unit.matrixWorld).invert();
  const shift = new Matrix4().makeTranslation(-inlet.x, -inlet.y, -inlet.z);
  const rel = new Matrix4();
  const relI = new Matrix4();
  const pieces = [];
  const bb = new Box3();
  unit.traverseVisible((o) => {
    if (!o.isMesh || o.userData?.air) return;
    if (blades.some((b) => under(o, b))) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m || m.visible === false || m.isShaderMaterial) return;
    if (coilMats.has(m) && o.isInstancedMesh) return; // the fins, inside the coil shell
    const see = m.transparent && m.opacity < 0.6;
    const part = coilMats.has(m) || (see && coilSec && under(o, coilSec)) ? 1 : 0;
    rel.multiplyMatrices(shift, rel.multiplyMatrices(inv, o.matrixWorld));
    eachInstance(o, (im) => {
      const p = bakePiece(o, im ? relI.multiplyMatrices(rel, im) : rel, { colorOverride: see ? GALV : null });
      if (!p) return;
      p.computeBoundingBox();
      bb.copy(p.boundingBox);
      const diag = bb.max.distanceTo(bb.min);
      const col = p.attributes.color ? [p.attributes.color.getX(0), p.attributes.color.getY(0), p.attributes.color.getZ(0)] : [0.56, 0.6, 0.64];
      pieces.push({ g: withPart(asCol(p), part), bb: bb.clone(), col, part, diag, tris: trisOf(p), name: o.userData?.pick?.title || o.name || m.name || m.color?.getHexString?.() });
    });
  });
  // casing extents (for the low-tier fallback box and the pick box)
  const box = new Box3();
  for (const p of pieces) {
    p.g.computeBoundingBox();
    box.union(p.g.boundingBox);
  }
  // the demo's diffuser: a neck down from the discharge plenum to a ceiling plate 0.44 m under the centre line
  const dx = out.x - inlet.x + 0.15;
  const dz = out.z - inlet.z;
  const yb = box.isEmpty() ? -0.2 : box.min.y;
  const plateY = out.y - inlet.y - 0.44;
  const neckH = Math.max(0.05, yb - (plateY + 0.025));
  const diff = [
    new BoxGeometry(0.22, neckH, 0.22).translate(dx, plateY + 0.025 + neckH / 2, dz),
    new BoxGeometry(0.62, 0.05, 0.62).translate(dx, plateY, dz),
  ].map((d) => {
    const n = d.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) DIFFUSER.toArray(c, i * 3);
    d.deleteAttribute('uv');
    d.setAttribute('aCol', new BufferAttribute(c, 3));
    return withPart(d, 2);
  });
  let keep = pieces;
  if (tier === 'low') {
    // big parts first; the finest detail (most triangles per metre) goes first when over budget
    keep = pieces.filter((p) => p.diag >= LOW_DIAG).sort((a, b) => a.tris / a.diag - b.tris / b.diag);
    let t = 24; // the diffuser
    keep = keep.filter((p) => (t + p.tris <= LOW_TRIS ? ((t += p.tris), true) : false));
    if (!keep.some((p) => p.name === 'Casing')) {
      // too fine even filtered: one box the size of the casing
      const s = box.getSize(new Vector3());
      const c = box.getCenter(new Vector3());
      const b = new BoxGeometry(s.x, s.y, s.z).translate(c.x, c.y, c.z);
      b.deleteAttribute('uv');
      const n = b.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) GALV.toArray(col, i * 3);
      b.setAttribute('aCol', new BufferAttribute(col, 3));
      keep = [{ g: withPart(b, 0) }];
    }
  }
  const all = [...keep.map((p) => p.g), ...diff];
  // the distant copy: the big parts as boxes (their own colour and part) and the diffuser
  const farParts = pieces
    .filter((p) => p.diag >= FAR_DIAG)
    .map((p) => {
      const s = p.bb.getSize(new Vector3()).max(new Vector3(0.02, 0.02, 0.02));
      const c = p.bb.getCenter(new Vector3());
      const b = new BoxGeometry(s.x, s.y, s.z).translate(c.x, c.y, c.z);
      b.deleteAttribute('uv');
      const n = b.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set(p.col, i * 3);
      b.setAttribute('aCol', new BufferAttribute(col, 3));
      return withPart(b, p.part);
    });
  const far = mergeGeometries([...farParts, ...diff]);
  farParts.forEach((b) => b.dispose());
  far.computeBoundingBox();
  far.computeBoundingSphere();
  const geometry = mergeGeometries(all);
  for (const p of pieces) p.g.dispose();
  diff.forEach((d) => d.dispose());
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const full = geometry.boundingBox.clone();
  // free what the off-scene build made (its geometry is not shared with anything drawn)
  try {
    view._disposeDevices?.();
  } catch {
    /* ignore */
  }
  g.traverse((o) => {
    if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose();
  });
  return { geometry, far, box: full, tris: trisOf(geometry), farTris: trisOf(far), pieces: keep.length };
}
