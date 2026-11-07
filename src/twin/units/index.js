/**
 * Digital Twin units — entry of the lazy units chunk (the only importer of the
 * ClarityView mirror in src/clarityview/).
 *
 *   createUnits({ layout, levels, world, tier, reducedMotion, ref, dev }) → units
 *     units.build(yieldFn)          every model as its own tasks, yielding between steps
 *     units.update(dt, now, f)      LOD + tick per host (f: camera, selected, hover, …)
 *     units.pick(raycaster)         { id, d } | null   (boxes, never triangles)
 *     units.bboxFor(id, c, s)       a unit's or sub-part's world box
 *     units.owner(id)               the host for a unit, alias or sub-part id
 *     units.setTier(t) / setPixelRatio(px) / afterCompile() / dispose()
 *
 * ref.state is sim.state (the sim mutates it in place). Build order: AHU-1,
 * AHU-2, CT-1, CH-1, CH-2, CWP-1, HHW-1, then the VAV terminal. Each step is a
 * performance.measure('twin:unit:<id>:<step>') (kept in production; cheap).
 */
import { Box3, Vector3 } from 'three';
import { Ahu3DView } from '../../clarityview/ahu/3d/ahu3d.js';
import { Tower3DView, CentrifugalChiller3DView, Booster3DView, Hhw3DView, Vav3DView } from '../../clarityview/ahu/3d/equip3d.js';
import { AirFlow } from '../../clarityview/ahu/3d/airflow3d.js';
import { disposeDeviceCache } from '../../clarityview/ahu/3d/siemens3d.js';
import { UNITS } from './catalog.js';
import { createHost, levelMaterials, pickMaterial } from './host.js';
import { bakeMaterials } from './freeze.js';
import { buildVavGeometry } from './vav.js';

const CLASSES = { ahu: Ahu3DView, tower: Tower3DView, chiller: CentrifugalChiller3DView, booster: Booster3DView, hhw: Hhw3DView };

const mark = (name) => {
  try {
    performance.mark(name);
  } catch {
    /* ignore */
  }
};
const measure = (name, a, b) => {
  try {
    performance.measure(name, a, b);
  } catch {
    /* ignore */
  }
};

export function createUnits({ layout, levels, world, tier = 'high', reducedMotion = false, ref, dev = false }) {
  const hosts = [];
  const byId = new Map();
  const shared = new Map(); // level index → per-level material set, bake mats, dedupe map, uniforms
  const glow = { value: tier === 'high' ? 0.5 : 1 };
  const pickMat = pickMaterial();
  let curTier = tier;
  let vav = null;
  const timings = [];
  let disposed = false;

  function sharedFor(li) {
    if (!shared.has(li)) {
      const ls = world.levelState[li];
      const bakeMats = bakeMaterials();
      shared.set(li, { mats: levelMaterials(Ahu3DView), bakeMats, canon: new Map(), reveal: ls.reveal, levelY: ls.levelY, glow, pickMat });
    }
    return shared.get(li);
  }

  async function step(id, name, fn, yieldFn) {
    const a = `twin:unit:${id}:${name}:a`;
    const b = `twin:unit:${id}:${name}:b`;
    mark(a);
    const t0 = performance.now();
    try {
      fn();
    } finally {
      const ms = performance.now() - t0;
      mark(b);
      measure(`twin:unit:${id}:${name}`, a, b);
      timings.push({ id, step: name, ms: +ms.toFixed(1) });
    }
    if (yieldFn) await yieldFn();
  }

  async function build(yieldFn) {
    const t0 = performance.now();
    for (const unit of UNITS) {
      if (disposed) return;
      const li = levels.byId.get(unit.level);
      if (li === undefined) continue;
      const level = levels.list[li];
      const host = createHost(unit, {
        classes: CLASSES,
        li,
        level,
        shared: sharedFor(li),
        ref,
        levelGroup: world.levelGroups[li],
        reducedMotion,
        AirFlow,
      });
      try {
        for (const [name, fn] of host.steps) await step(unit.id, name, fn, yieldFn);
      } catch (err) {
        if (dev) console.warn('[twin units]', unit.id, err);
        host.toProxy(err);
      }
      if (disposed) return;
      hosts.push(host);
      for (const id of [unit.id, ...(unit.aliases || []), ...host.subs.map((s) => s.id)]) byId.set(id, host);
      world.addUnit(host);
      host.setLod(curTier === 'high' ? 0 : 1, performance.now());
    }
    // the VAV terminal, baked once for every zone
    try {
      const li = levels.list.findIndex((l) => l.kind === 'office');
      await step('VAV', 'bake', () => {
        vav = buildVavGeometry(Vav3DView, sharedFor(Math.max(0, li)).mats, { tier: curTier });
        world.setVavGeometry(vav.geometry, vav.box);
      }, yieldFn);
    } catch (err) {
      if (dev) console.warn('[twin units]', 'VAV', err);
    }
    // B1 x-ray silhouettes from the real geometry
    try {
      world.setPlantXray(hosts.filter((h) => h.xray).map((h) => ({ li: h.li, geometry: h.xray })));
    } catch (err) {
      if (dev) console.warn('[twin units]', 'x-ray', err);
    }
    timings.push({ id: 'all', step: 'wall', ms: +(performance.now() - t0).toFixed(1) });
    if (dev) checkPorts();
  }

  /** DEV: the live models' nozzles and collars against the sim's layout.ports. */
  function checkPorts() {
    const lp = layout.ports;
    if (!lp) return;
    for (const h of hosts) {
      const want = lp[h.id];
      if (!want || h.proxy) continue;
      for (const [name, p] of Object.entries(want)) {
        const got = h.ports[name];
        if (!got) {
          console.warn('[twin units] port mismatch', h.id, name, 'model has no such port', p);
          continue;
        }
        const d = Math.hypot(got[0] - p[0], got[1] - p[1], got[2] - p[2]);
        if (d > 0.05) console.warn('[twin units] port mismatch', h.id, name, got, p);
      }
    }
  }

  const tmp = new Vector3();
  function update(dt, now, f) {
    for (const h of hosts) {
      const li = h.li;
      const ls = world.levelState[li];
      f.levelY = world.levelGroups[li].position.y;
      f.revealDone = ls.reveal.value >= 0.999;
      f.airOk = curTier === 'high' && f.revealDone && !f.reducedMotion;
      f.tier = curTier;
      h.update(dt, now, f);
    }
  }

  function pick(raycaster) {
    let best = null;
    for (const h of hosts) {
      const r = h.pick(raycaster);
      if (r && (!best || r.d < best.d)) best = r;
    }
    return best;
  }

  function bboxFor(id, c, s) {
    const h = byId.get(id);
    if (!h) return false;
    const b = h.boxOf(id);
    if (!b || b.isEmpty()) return false;
    b.getCenter(tmp);
    // level-local box, unrotated in the holder: rotate the holder frame into the level
    const box = new Box3().copy(b).applyMatrix4(h.holder.matrix);
    box.getCenter(c);
    box.getSize(s);
    c.y += world.levelGroups[h.li].position.y;
    return true;
  }

  return {
    hosts,
    timings,
    get vav() {
      return vav;
    },
    build,
    update,
    pick,
    bboxFor,
    owner: (id) => byId.get(id) || null,
    has: (id) => byId.has(id),
    setTier(t) {
      curTier = t;
      glow.value = t === 'high' ? 0.5 : 1;
    },
    setPixelRatio(px) {
      for (const h of hosts) h.setPixelRatio(px);
    },
    /** The compile pass forced everything visible: put each host's LOD back. */
    afterCompile(now = performance.now()) {
      for (const h of hosts) {
        const n = h.lod;
        h.lod = -1;
        if (n >= 0) h.setLod(n, now);
      }
    },
    dispose() {
      disposed = true;
      for (const h of hosts) h.dispose();
      for (const s of shared.values()) {
        for (const m of Object.values(s.mats)) m.dispose?.();
        for (const m of Object.values(s.bakeMats)) m.dispose?.();
      }
      pickMat.dispose();
      vav?.geometry?.dispose?.();
      try {
        disposeDeviceCache();
      } catch {
        /* ignore */
      }
      hosts.length = 0;
      byId.clear();
    },
  };
}
