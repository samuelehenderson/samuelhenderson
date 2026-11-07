/**
 * Digital Twin units — one ClarityView model in the twin.
 *
 *   createHost(unit, ctx) → host
 *     host.steps: embed → measure → bake → freeze → finish (each its own task; bake
 *                 and freeze are generators that hand the thread back every `budget` ms)
 *     host.update(dt, now, f)   LOD choice + tick (LOD0 only); the tower plume
 *     host.pick(raycaster)      { id, d } against invisible boxes (unit, then sub-parts)
 *     host.boxOf(id)            level-local Box3 of the unit or a sub-part
 *     host.ports                { name: [x, y, z] } world, at the level's base height
 *     host.dispose()            everything under the holder, devices, air (never view.destroy())
 *
 * The view is built into a holder at the unit's placement (a curb under an AHU),
 * read through catalog accessFor() (has/resolve from sim.state), baked to LOD1
 * (curves at half the facets), frozen to LOD0, its materials patched for the
 * level's dissolve and the bloom gain, and picked against boxes, never its
 * triangles. Any failing step turns the unit into a proxy box with the same
 * id, pick and bounds.
 *
 * Port names (for sim layout.ports, checked in DEV): AHU sa / ra / hws / hwr /
 * chws / chwr; CT-1 cws (cold out) / cwr (hot in); chillers chws / chwr / cws (CW
 * in) / cwr (CW out); CWP-1 suction / discharge; HHW-1 hws / hwr.
 */
import {
  AdditiveBlending,
  Box3,
  BoxGeometry,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { accessFor } from './catalog.js';
import { bakeIter, cluster, freezeIter, settle, eachInstance } from './freeze.js';
import { patchUnitMaterial, unitPatchOf } from '../shared.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const PROXY_COLOR = { air: '#6d7c8c', water: '#5f7488' };
const LOD_IN = 0.18;
const LOD_OUT = 0.14;
// x-ray silhouettes (B1, seen through the ground): only parts at least this big
const XRAY_MIN = 0.8;
const XRAY_CELL = 0.15;
const AIR_IN = 0.3;
const AIR_OUT = 0.25;

const noFoot = (o, stop) => {
  for (let a = o; a && a !== stop; a = a.parent) if (a.userData?.noFootprint || a.userData?.air) return true;
  return false;
};

/** Union bbox (in `frame`'s space) of the visible meshes under `root`, instanced meshes expanded. */
function meshBox(root, frame, { all = false } = {}) {
  frame.updateMatrixWorld(true);
  const inv = new Matrix4().copy(frame.matrixWorld).invert();
  const rel = new Matrix4();
  const m = new Matrix4();
  const box = new Box3();
  const b = new Box3();
  const visit = (o) => {
    if (!o.isMesh || noFoot(o, frame)) return;
    const g = o.geometry;
    if (!g?.attributes?.position) return;
    if (!g.boundingBox) g.computeBoundingBox();
    rel.multiplyMatrices(inv, o.matrixWorld);
    eachInstance(o, (im) => {
      b.copy(g.boundingBox).applyMatrix4(im ? m.multiplyMatrices(rel, im) : rel);
      box.union(b);
    });
  };
  if (all) root.traverse(visit);
  else root.traverseVisible(visit);
  return box;
}

export function createHost(unit, ctx) {
  const { classes, li, level, shared, ref, levelGroup } = ctx;
  const host = {
    id: unit.id,
    unit,
    li,
    level,
    holder: new Group(),
    seat: new Group(),
    view: null,
    lod0: null,
    lod1: null,
    lod: -1,
    box: new Box3(),
    subs: [],
    ports: {},
    casters: [],
    xray: null,
    proxy: null,
    failed: null,
    plume: null,
    stats: {},
    pickUnit: null,
    pickSubs: [],
  };
  const { holder, seat } = host;
  holder.name = `unit-${unit.id}`;
  holder.position.set(unit.x, unit.y - level.y, unit.z);
  holder.rotation.y = unit.rotY || 0;
  holder.userData.pickId = unit.id;
  holder.add(seat);
  levelGroup.add(holder);
  const access = accessFor(unit, ref);
  const airUnit = unit.cls === 'ahu';
  let towerFan = null;

  /* ── steps ─────────────────────────────────────────────────── */

  function embed() {
    if (unit.curb) {
      const c = unit.curb;
      const geo = new BoxGeometry(c.w, c.h, c.d).translate(0, c.h / 2, 0);
      const curb = new Mesh(geo, shared.mats.rail);
      curb.castShadow = true;
      curb.userData.curb = true;
      holder.add(curb);
      host.curb = curb;
      seat.position.y = c.h;
    }
    const Cls = classes[unit.cls];
    if (!Cls) throw new Error(`no view class for ${unit.cls}`);
    const opts = { title: unit.title, config: unit.config, kind: unit.kind };
    if (unit.cls === 'ahu') Object.assign(opts, { rhAfterFans: unit.rhAfterFans !== false, eyebrow: 'Air handling unit' });
    const view = new Cls(opts);
    view.embed(seat, `${unit.id}.`, access.has, access.resolve, shared.mats);
    view.showAir = false;
    view.reduced = !!ctx.reducedMotion;
    view.airGain = 0.45;
    host.view = view;
    host.lod0 = view.unit;
  }

  function measure() {
    const view = host.view;
    holder.updateMatrixWorld(true);
    // sub-parts: meshes under (or at) an object whose pick title matches
    for (const s of unit.subs || []) {
      const box = new Box3();
      view.unit.traverse((o) => {
        if (!s.pickTitle.test(o.userData?.pick?.title || '')) return;
        box.union(meshBox(o, holder, { all: true }));
      });
      if (!box.isEmpty()) host.subs.push({ id: s.id, box: box.expandByScalar(0.1) });
    }
    // the unit's own bounds: visible meshes, instanced meshes by their instances
    host.box.copy(meshBox(view.unit, holder));
    if (host.curb) host.box.union(new Box3().setFromObject(host.curb).applyMatrix4(new Matrix4().copy(holder.matrixWorld).invert()));
    if (host.box.isEmpty()) throw new Error('empty model');
    // the tower's fan stack: where the demo's vapour plume rises from
    if (unit.tower) {
      const b = new Box3();
      view.unit.traverse((o) => {
        if (/^Tower fan 1$/.test(o.userData?.pick?.title || '') && o.isMesh) b.union(meshBox(o, holder, { all: true }));
      });
      if (!b.isEmpty()) towerFan = { c: b.getCenter(new Vector3()), top: b.max.y, r: Math.max(0.6, (b.max.x - b.min.x) / 2 - 0.1) };
    }
    measurePorts();
  }

  function measurePorts() {
    const view = host.view;
    levelGroup.updateMatrixWorld(true);
    const toLevel = new Matrix4().copy(levelGroup.matrixWorld).invert();
    const p = new Vector3();
    const at = (obj, local) => {
      p.set(local[0], local[1], local[2]);
      obj.localToWorld(p).applyMatrix4(toLevel);
      return [+(p.x).toFixed(3), +(p.y + level.y).toFixed(3), +(p.z).toFixed(3)];
    };
    const lp = (q) => (q ? [q.x, q.y, q.z] : null);
    const P = host.ports;
    const out = lp(view.outletLocal);
    const ret = lp(view.returnLocal);
    const coils = view.coilPorts || [];
    if (unit.cls === 'ahu') {
      if (out) P.sa = at(view.unit, out);
      const s0 = view.sections?.[0];
      if (s0) P.ra = at(view.unit, [s0.group.position.x - s0.w / 2, out ? out[1] : view.DH / 2, 0]);
      for (const c of coils) {
        const [s, r] = c.heat ? ['hws', 'hwr'] : ['chws', 'chwr'];
        P[s] = at(c.g, c.local);
        P[r] = at(c.g, c.retLocal);
      }
    } else if (unit.cls === 'tower') {
      if (out) P.cws = at(view.unit, out);
      if (ret) P.cwr = at(view.unit, ret);
    } else if (unit.cls === 'chiller') {
      if (out) P.chws = at(view.unit, out);
      if (ret) P.chwr = at(view.unit, ret);
      const c = coils.find((x) => x.cond);
      if (c) {
        P.cws = at(c.g, c.local);
        P.cwr = at(c.g, c.retLocal);
      }
    } else if (unit.cls === 'booster') {
      if (coils[0]) P.suction = at(coils[0].g, coils[0].local);
      if (out) P.discharge = at(view.unit, out);
    } else if (unit.cls === 'hhw') {
      if (out) P.hws = at(view.unit, out);
      if (ret) P.hwr = at(view.unit, ret);
    }
  }

  function* doFreeze(budget) {
    const r = yield* freezeIter(host.view, { canon: shared.canon, budget });
    host.liveMats = r.liveMats;
    host.stats.freeze = { probeMs: r.probeMs, ms: r.totalMs, before: r.meshesBefore, after: r.meshesAfter, moved: r.moved.size, liveMats: r.liveMats.size };
  }

  function* doBake(budget) {
    const view = host.view;
    settle(view);
    const r = yield* bakeIter(view.unit, { mats: shared.bakeMats, xrayMin: level.kind === 'plant' ? XRAY_MIN : 0, budget, coarse: true });
    const g = new Group();
    g.name = `lod1-${unit.id}`;
    g.position.copy(view.unit.position);
    g.quaternion.copy(view.unit.quaternion);
    g.scale.copy(view.unit.scale);
    for (const k of ['solid', 'glass', 'line']) if (r[k]) g.add(r[k]);
    view.unit.parent.add(g);
    host.lod1 = g;
    if (r.xray) {
      // the x-ray silhouette in level-local space: holder → seat → unit frame
      holder.updateMatrix();
      seat.updateMatrix();
      g.updateMatrix();
      // (vertex-clustered to a 0.1 m grid: the rim shader needs only the silhouette)
      host.xray = cluster(r.xray, XRAY_CELL);
      r.xray.dispose();
      host.xray.applyMatrix4(new Matrix4().multiplyMatrices(holder.matrix, new Matrix4().multiplyMatrices(seat.matrix, g.matrix)));
    }
    host.stats.bake = { draws: r.draws, tris: r.tris };
  }

  function finish() {
    const view = host.view;
    // dissolve + bloom gain on every material (LOD0, LOD1, curb); materials another
    // level already patched are cloned for this level unless the view animates them
    const clones = new Map();
    const patch = (o) => {
      const one = (m) => {
        if (!m || m.isShaderMaterial) return m;
        const rec = unitPatchOf(m);
        if (!rec) {
          patchUnitMaterial(m, { reveal: shared.reveal, levelY: shared.levelY, glow: shared.glow, level: li });
          return m;
        }
        // patched for this level (this mount) already, or animated by the view: keep it
        if (rec.reveal === shared.reveal || host.liveMats?.has(m)) return m;
        if (!clones.has(m)) {
          const c = m.clone();
          patchUnitMaterial(c, { reveal: shared.reveal, levelY: shared.levelY, glow: shared.glow, level: li, orig: rec.base });
          clones.set(m, c);
        }
        return clones.get(m);
      };
      if (Array.isArray(o.material)) o.material = o.material.map(one);
      else if (o.material) o.material = one(o.material);
    };
    holder.traverse((o) => {
      if (o.isMesh || o.isLine) patch(o);
    });
    // shadows: ClarityView's flags, except see-through parts (no solid black boxes from clear
    // casings). The sun never reaches the basement plant room: nothing there casts at all.
    const below = level.kind === 'plant';
    holder.traverse((o) => {
      if (!o.isMesh || !o.castShadow) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (below || (m?.transparent && m.opacity < 0.6)) o.castShadow = false;
      else host.casters.push(o);
    });
    // the air handlers' air stream, made now (hidden) so its program compiles with the rest.
    // Only the AHUs draw one: the plant families' streams (white ribbons in the pump headers)
    // read as air and bloom; their water already moves in the service runs and the pumps turn
    if (ctx.AirFlow && airUnit && !view.air) {
      view.air = new ctx.AirFlow(0);
      view.unit.add(view.air.points);
      view.air.points.scale.x = 1;
      view.air.points.visible = false;
    }
    if (unit.tower) buildPlume();
    buildPicks();
    host.lod = -1;
  }

  /** The proxy box: same id, pick and bounds, a neutral family colour. */
  function toProxy(err) {
    host.failed = String(err?.message || err);
    try {
      if (host.lod0) host.lod0.removeFromParent();
      if (host.lod1) host.lod1.removeFromParent();
    } catch {
      /* ignore */
    }
    host.view = null;
    host.lod0 = null;
    host.lod1 = null;
    host.casters.length = 0;
    host.subs.length = 0;
    if (host.box.isEmpty()) {
      const w = unit.w || 3;
      const h = unit.h || 2;
      const d = unit.d || 2;
      host.box.set(new Vector3(-w / 2, 0, -d / 2), new Vector3(w / 2, h, d / 2));
    }
    const size = host.box.getSize(new Vector3());
    const mat = new MeshStandardMaterial({ color: PROXY_COLOR[unit.family] || PROXY_COLOR.water, roughness: 0.6, metalness: 0.3 });
    patchUnitMaterial(mat, { reveal: shared.reveal, levelY: shared.levelY, glow: shared.glow, level: li });
    const proxy = new Mesh(new BoxGeometry(size.x, size.y, size.z), mat);
    host.box.getCenter(proxy.position);
    proxy.castShadow = level.kind !== 'plant';
    holder.add(proxy);
    host.proxy = proxy;
    if (proxy.castShadow) host.casters.push(proxy);
    buildPicks();
  }

  function buildPicks() {
    const mk = (box, id) => {
      const s = box.getSize(new Vector3());
      const m = new Mesh(new BoxGeometry(Math.max(0.05, s.x), Math.max(0.05, s.y), Math.max(0.05, s.z)), shared.pickMat);
      box.getCenter(m.position);
      m.userData.pickId = id;
      m.frustumCulled = false;
      holder.add(m);
      return m;
    };
    if (host.pickUnit) host.pickUnit.removeFromParent();
    for (const p of host.pickSubs) p.removeFromParent();
    host.pickUnit = mk(host.box, unit.id);
    host.pickSubs = host.subs.map((s) => mk(s.box, s.id));
  }

  /* ── the demo's white vapour plume over the tower (ClarityView's air stays off) ── */
  function buildPlume() {
    const n = 14;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) seed[i] = i / n + ((i * 7919) % 13) / 433; // deterministic jitter
    const pg = new BufferGeometry();
    pg.setAttribute('position', new Float32BufferAttribute(pos, 3));
    pg.setAttribute('aSeed', new Float32BufferAttribute(seed, 1));
    const R = towerFan?.r ?? 1.7;
    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uAmt: { value: 0 }, uR: { value: R }, uPx: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime, uAmt, uR, uPx;
        varying float vA;
        void main() {
          float t = fract(uTime * 0.05 + aSeed);
          float a = aSeed * 43.0;
          vec3 p = vec3(cos(a) * uR * 0.4 * (0.35 + t), t * 9.0, sin(a) * uR * 0.4 * (0.35 + t));
          p.x += t * t * 3.0;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (20.0 + t * 38.0) * uPx * 120.0 / -mv.z;
          vA = uAmt * smoothstep(0.0, 0.25, t) * (1.0 - t) * (1.0 - t);
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(q, q);
          if (r2 > 1.0) discard;
          float m = exp(-r2 * 3.2) * (1.0 - r2);
          gl_FragColor = vec4(vec3(0.75, 0.85, 1.0) * m * vA * 0.055, 1.0);
        }`,
    });
    const plume = new Points(pg, mat);
    if (towerFan) plume.position.set(towerFan.c.x, towerFan.top + 0.1, towerFan.c.z);
    else plume.position.set(0, (host.box.max.y || 6) + 0.1, 0);
    plume.frustumCulled = false;
    plume.renderOrder = 7;
    holder.add(plume);
    host.plume = { mesh: plume, mat, amt: 0 };
  }

  /* ── LOD ───────────────────────────────────────────────────── */

  function setLod(n, now) {
    if (host.proxy || !host.lod0) return;
    if (host.lod === n) return;
    const was = host.lod;
    host.lod = n;
    host.lod0.visible = n === 0;
    if (host.lod1) host.lod1.visible = n === 1;
    const view = host.view;
    if (n === 0 && was !== 0) {
      // pick values up at once and settle the parts, so nothing visibly spins up
      const air = view.showAir;
      view.showAir = false;
      view.dirty = true;
      view._lastValues = -Infinity;
      view.tick(1.5, now);
      view.dirty = true;
      view._lastValues = -Infinity;
      view.tick(1.5, now + 300);
      view.showAir = air;
    }
    if (n !== 0 && view?.air) view.air.points.visible = false;
  }

  const wc = new Vector3();
  let center = null; // level-local centre of the unit's box (the holder never moves)
  let radius = 1;
  /**
   * f: { camera, tanHalf, tier, selected, hover, levelY, revealDone, reducedMotion, airOk }
   *
   * LOD: the selected unit is always the live model (every tier); on the low
   * tier everything else is the baked copy; on the high tier the hovered unit is
   * live and the rest go by screen size (live at frac ≥ 0.18, back at < 0.14).
   * Air streams (air handlers only) only on the high tier, after the level has
   * revealed, without reduced motion, and only in a close-up: the unit selected
   * or hovered, or filling a good part of the view (frac ≥ 0.3).
   */
  function update(dt, now, f) {
    const vis = holder.parent?.visible !== false && holder.visible;
    if (host.plume) {
      const T = ref.state?.plant?.tower || {};
      const on = !!T.on && vis && f.revealDone;
      const heat = clamp((Number(T.heat) || 0) / 140, 0, 1);
      host.plume.amt = damp(host.plume.amt, on ? 0.35 + 0.65 * heat : 0, 1.5, dt);
      host.plume.mat.uniforms.uTime.value = f.reducedMotion ? f.clock * 0.3 : f.clock;
      host.plume.mat.uniforms.uAmt.value = host.plume.amt;
      host.plume.mesh.visible = host.plume.amt > 0.002;
    }
    if (!vis || host.proxy || !host.view) return;
    if (!center) {
      holder.updateMatrix();
      center = host.box.getCenter(new Vector3()).applyMatrix4(holder.matrix);
      radius = host.box.getSize(new Vector3()).length() / 2;
    }
    wc.copy(center);
    wc.y += f.levelY;
    const d = Math.max(0.01, wc.distanceTo(f.camera.position));
    // (unit.lodBias < 1: a unit whose live model adds little at a distance goes live later)
    const frac = (radius / (d * f.tanHalf)) * (unit.lodBias || 1);
    host.frac = frac;
    const sel = mine(f.selected);
    const hov = mine(f.hover);
    let want;
    if (sel) want = 0;
    else if (f.tier !== 'high') want = 1;
    else if (hov) want = 0;
    else want = host.lod === 0 ? (frac < LOD_OUT ? 1 : 0) : frac >= LOD_IN ? 0 : 1;
    setLod(want, now);
    if (host.lod !== 0) return;
    const view = host.view;
    const close = sel || hov || (host.airClose ? frac >= AIR_OUT : frac >= AIR_IN);
    host.airClose = close;
    view.showAir = !!f.airOk && close && airUnit;
    if (!view.showAir && view.air) view.air.points.visible = false;
    view.update();
    view.tick(dt * (f.reducedMotion ? 0.3 : 1), now);
  }
  const mine = (id) => !!id && (id === unit.id || host.subs.some((s) => s.id === id));

  function pick(raycaster) {
    if (!host.pickUnit || holder.parent?.visible === false || !holder.visible) return null;
    const hit = raycaster.intersectObject(host.pickUnit, false)[0];
    if (!hit) return null;
    let id = unit.id;
    let best = Infinity;
    for (const p of host.pickSubs) {
      const h = raycaster.intersectObject(p, false)[0];
      if (h && h.distance < best) {
        best = h.distance;
        id = p.userData.pickId;
      }
    }
    return { id, d: hit.distance, unit: unit.id };
  }

  function boxOf(id) {
    if (!id) return null;
    if (id === unit.id) return host.box;
    return host.subs.find((s) => s.id === id)?.box || null;
  }

  function setPixelRatio(px) {
    if (host.plume) host.plume.mat.uniforms.uPx.value = px;
  }

  function dispose() {
    const v = host.view;
    try {
      v?._disposeDevices?.();
    } catch {
      /* ignore */
    }
    try {
      v?.air?.dispose?.();
    } catch {
      /* ignore */
    }
    // everything under the holder (both LODs, curb, picks, plume): the world no longer reaches it
    const res = new Set();
    holder.traverse((o) => {
      if (o.geometry) res.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) res.add(m);
    });
    for (const r of res) {
      try {
        r.dispose();
      } catch {
        /* ignore */
      }
    }
    host.xray?.dispose?.();
    holder.removeFromParent();
  }

  Object.assign(host, {
    steps: [
      ['embed', embed],
      ['measure', measure],
      // the bake reads the parts as ClarityView made them (its coarser curves need their
      // parameters), so it runs before freeze merges the static ones
      ['bake', doBake],
      ['freeze', doFreeze],
      ['finish', finish],
    ],
    toProxy,
    setLod,
    update,
    pick,
    boxOf,
    setPixelRatio,
    dispose,
  });
  return host;
}

/** Shared per-level material set for embedded units (like ClarityView's Buildings twin). */
export function levelMaterials(Ahu3DView) {
  const probe = new Ahu3DView({ config: { kind: 'ahu', supply: [{ device: 'fan', label: 'Fan' }] } });
  probe._materials();
  for (const m of Object.values(probe.m)) m.userData.shared = true;
  return probe.m;
}

export const pickMaterial = () => new MeshBasicMaterial({ visible: false });
