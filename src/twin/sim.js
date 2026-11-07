// src/twin/sim.js — headless, deterministic building simulation for the Digital Twin scene.
//
// Pure JS: no three.js, no DOM, no Math.random. The same seed always produces the same building.
// Geometry is in metres with three.js axes (x east, y up, z south), footprint 40 × 24 m centred on 0,0.
// State is in US BAS units: °F, %RH, cfm, in.WC, kW, tons, MBH.
//
// What it models (simplified but recognisable BAS sequences):
//   weather + sun → zone envelope / solar / internal gains → VAV PI (cooling flow, HW reheat)
//   → AHU duct-static fan control, economizer, SAT reset 55–60 °F, CHW / HW coil valves
//   → CHW plant (lead/lag chiller staging, soft-load, pumps) → condenser water + tower fan
//   → heating hot water plant HHW-1 (steam to hot water: OAT reset, split-range 1/3 + 2/3 steam
//     valves, two shell-and-tube exchangers staged on load, lead/lag VFD pumps on loop dP)
//   → building kW / kWh / plant COP → alarms.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
// first-order lag toward target, unconditionally stable for any dt
const relax = (cur, target, dt, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
// alarm-text temperatures: nearest 0.5 °F
const half = (v) => (Math.round(fin(v) * 2) / 2).toFixed(1);

function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------
const FLOOR_H = 4.0;
const SA_Y = 3.4;      // supply main / VAV centre line above floor
const RA_Y = 3.68;     // return main above floor
const HWS_Y = 3.0;     // reheat HW supply loop above floor
const HWR_Y = 2.78;    // reheat HW return loop above floor
const SA_RING = { x: 8, z: 6 };       // supply ring half-extents (around the core)
const RA_RING = { x: 17.5, z: 10 };   // return ring half-extents (perimeter plenum)
const HWS_RING = { x: 8.7, z: 6.7 };
const HWR_RING = { x: 9.1, z: 7.1 };

// Pipe risers (all inside the core, near its east/west edges)
const RISER = {
  chws: [5.3, -1.4], chwr: [5.3, -0.4], cws: [5.3, 0.6], cwr: [5.3, 1.6],
  hws: [-5.3, -0.5], hwr: [-5.3, 0.5],
};
// Duct risers per AHU: AHU-1 drops on the core's north edge, AHU-2 on its south edge
const DUCT_RISER = {
  'AHU-1': { sa: [-5, -3.4], ra: [5, -3.4], side: -1 },
  'AHU-2': { sa: [-5, 3.4], ra: [5, 3.4], side: 1 },
};

// chillers on B1 (origin z); each one's CHW pump is on its own skid
const CH_Z = [['CH-1', -8.2], ['CH-2', -4.0]];

const EXPOSURE = [['NW', 'N', 'N', 'NE'], ['W', null, null, 'E'], ['SW', 'S', 'S', 'SE']];
const TAG = [['NW', 'N1', 'N2', 'NE'], ['W', null, null, 'E'], ['SW', 'S1', 'S2', 'SE']];
const EXPOSURE_LONG = {
  N: 'North', S: 'South', E: 'East', W: 'West',
  NE: 'North-east', NW: 'North-west', SE: 'South-east', SW: 'South-west',
};

function zoneType(n, r, c) {
  if (n === 1) {
    return [['Café', 'Coworking', 'Mail & Copy', 'Fitness'],
      ['Security', null, null, 'Conference'],
      ['Retail', 'Lobby', 'Lobby', 'Retail']][r][c];
  }
  if (r === 1) return c === 0 ? 'Huddle Rooms' : (n === 6 ? 'Boardroom' : 'Conference');
  const corner = c === 0 || c === 3;
  if (corner) return n === 6 ? 'Executive Suite' : 'Corner Office';
  if (n === 6 && r === 0) return 'Studio';
  return 'Open Office';
}

// orthogonal branch from a rectangular ring (half extents hx, hz) out to (cx, cz)
function branchPts(cx, cz, hx, hz, y, endY = y) {
  const sx = clamp(cx, -hx, hx), sz = clamp(cz, -hz, hz);
  const pts = [[sx, y, sz]];
  if (Math.abs(cx) > hx && Math.abs(cz) > hz) pts.push([cx, y, sz]);
  pts.push([cx, y, cz]);
  if (endY !== y) pts.push([cx, endY, cz]);
  return pts;
}

function buildLayout() {
  const levels = [{ id: 'B1', name: 'B1 · Central plant', y: -4.5, height: 4.5, kind: 'plant' }];
  for (let n = 1; n <= 6; n++) {
    levels.push({ id: `L${n}`, name: n === 1 ? 'Level 1 · Lobby' : `Level ${n} · Offices`, y: (n - 1) * FLOOR_H, height: FLOOR_H, kind: 'office' });
  }
  levels.push({ id: 'RF', name: 'Roof · Plant deck', y: 24, height: 0, kind: 'roof' });

  const core = { x0: -6, x1: 6, z0: -4, z1: 4 };
  const XE = [-20, -10, 0, 10, 20], ZE = [-12, -4, 4, 12];
  const zones = [];
  const vavs = [];
  for (let n = 1; n <= 6; n++) {
    const y = (n - 1) * FLOOR_H;
    const ahu = n <= 3 ? 'AHU-1' : 'AHU-2';
    let k = 0;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        if (r === 1 && (c === 1 || c === 2)) continue; // core cells
        k++;
        const nn = String(k).padStart(2, '0');
        const x0 = XE[c], x1 = XE[c + 1], z0 = ZE[r], z1 = ZE[r + 1];
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        const id = `L${n}-${nn}`;
        const vav = `VAV-${n}-${nn}`;
        const zone = {
          id, level: `L${n}`, floor: n, name: `${zoneType(n, r, c)} ${n}-${TAG[r][c]}`,
          x0, x1, z0, z1, cx, cz, area: (x1 - x0) * (z1 - z0),
          exposure: EXPOSURE[r][c], vav, ahu, vavPos: [cx, y + SA_Y, cz],
        };
        zones.push(zone);
        vavs.push({ id: vav, zone: id, level: zone.level, ahu, x: cx, y: y + SA_Y, z: cz });
      }
    }
  }

  // Every unit is ClarityView's real-size model (the twin's units chunk draws it at this
  // origin and rotation; units.check (h) holds the two in step). x, z: the model's origin;
  // w × h × d: its measured size (labels, the footprint check, the fallback box). Pumps drawn
  // inside a unit (each chiller's skid pump, the plant's two HW pumps) name it as `parent`.
  // (AHU height includes its 0.3 m roof curb.)
  const equipment = [
    { id: 'AHU-1', kind: 'ahu', name: 'Air Handler AHU-1', level: 'RF', x: 0, y: 24, z: -8.5, w: 13.3, h: 3.04, d: 3.3, rotY: 0, serves: ['L1', 'L2', 'L3'] },
    { id: 'AHU-2', kind: 'ahu', name: 'Air Handler AHU-2', level: 'RF', x: 0, y: 24, z: 8.5, w: 13.3, h: 3.04, d: 3.3, rotY: Math.PI, serves: ['L4', 'L5', 'L6'] },
    { id: 'CT-1', kind: 'tower', name: 'Cooling Tower CT-1', level: 'RF', x: 13.6, y: 24, z: 0, w: 8.08, h: 6.33, d: 7.64, rotY: 0, serves: ['CH-1', 'CH-2'] },
    { id: 'CH-1', kind: 'chiller', name: 'Chiller CH-1', level: 'B1', x: 13.6, y: -4.5, z: -8.2, w: 7.69, h: 2.36, d: 2.45, rotY: 0, serves: ['AHU-1', 'AHU-2'] },
    { id: 'CH-2', kind: 'chiller', name: 'Chiller CH-2', level: 'B1', x: 13.6, y: -4.5, z: -4.0, w: 7.69, h: 2.36, d: 2.45, rotY: 0, serves: ['AHU-1', 'AHU-2'] },
    { id: 'HHW-1', kind: 'hhw', name: 'Heating Hot Water Plant HHW-1', level: 'B1', x: -13.0, y: -4.5, z: 3.4, w: 6.6, h: 2.43, d: 4.6, rotY: 0, serves: ['AHU-1', 'AHU-2', 'VAV reheat'] },
    { id: 'CHWP-1', kind: 'pump', name: 'CHW Pump CHWP-1', level: 'B1', x: 10.8, y: -4.5, z: -7.7, w: 0.9, h: 0.8, d: 0.6, rotY: 0, serves: ['CH-1'], parent: 'CH-1' },
    { id: 'CHWP-2', kind: 'pump', name: 'CHW Pump CHWP-2', level: 'B1', x: 10.8, y: -4.5, z: -3.5, w: 0.9, h: 0.8, d: 0.6, rotY: 0, serves: ['CH-2'], parent: 'CH-2' },
    { id: 'CWP-1', kind: 'pump', name: 'Condenser Pump CWP-1', level: 'B1', x: 10.9, y: -4.5, z: 1.55, w: 4.1, h: 2.13, d: 2.8, rotY: 0, serves: ['CH-1', 'CH-2', 'CT-1'] },
    { id: 'HWP-1', kind: 'pump', name: 'HW Pump HWP-1', level: 'B1', x: -13.55, y: -4.5, z: 5.2, w: 0.6, h: 1.0, d: 1.3, rotY: 0, serves: ['HHW-1'], parent: 'HHW-1' },
    { id: 'HWP-2', kind: 'pump', name: 'HW Pump HWP-2', level: 'B1', x: -12.35, y: -4.5, z: 5.2, w: 0.6, h: 1.0, d: 1.3, rotY: 0, serves: ['HHW-1'], parent: 'HHW-1' },
  ];

  // Where services meet the models (world, at the level's base height): the AHU discharge
  // collar and return-air end, the coil connections, the tower's CW nozzles, each chiller's
  // CHW and CW nozzles, the condenser pump's suction and discharge, the plant's HW supply and
  // return. Measured from the models; the units chunk compares them in DEV (port mismatch).
  const ports = {};
  for (const [ahu, s] of [['AHU-1', -1], ['AHU-2', 1]]) {
    ports[ahu] = {
      sa: [-6.65, 25.5, 8.5 * s], ra: [6.1, 25.5, 8.5 * s],
      hws: [-1.6, 24.66, 6.6 * s], hwr: [-1.6, 26.34, 6.6 * s],
      chws: [-2.5, 24.66, 6.6 * s], chwr: [-2.5, 26.34, 6.6 * s],
    };
  }
  ports['CT-1'] = { cws: [9.15, 24.6, -0.6], cwr: [9.15, 25.35, 0.6] };
  for (const [ch, cz] of CH_Z) {
    ports[ch] = { chws: [9.35, -3.64, cz + 0.5], chwr: [9.35, -4.08, cz + 0.5], cws: [9.35, -4.08, cz - 0.52], cwr: [9.35, -3.64, cz - 0.52] };
  }
  ports['CWP-1'] = { suction: [8.85, -3.9, 0.6], discharge: [12.95, -2.75, 0.6] };
  ports['HHW-1'] = { hws: [-14.75, -2.75, 6.4], hwr: [-9.9, -4.15, 5.95] };
  const port = (ref) => { const [id, k] = ref.split(':'); return ports[id][k].slice(); };

  const runs = [];
  // ends: [start, end] port refs ('AHU-1:sa') for a run that meets a model; the point there IS the port
  const add = (id, kind, level, serves, from, to, points, size, ends) => {
    const r = { id, kind, level, serves, from, to, points, size };
    if (ends) {
      r.ends = ends;
      if (ends[0]) points[0] = port(ends[0]);
      if (ends[1]) points[points.length - 1] = port(ends[1]);
    }
    runs.push(r);
  };

  // ---- air: supply + return risers, per-floor rings, branch to every VAV
  // (each AHU's discharge collar faces west and its return end east: the supply main runs
  // round the west end into the core, the return main round the east end)
  for (const ahu of ['AHU-1', 'AHU-2']) {
    const R = DUCT_RISER[ahu], s = R.side, az = 8.5 * s;
    const floors = ahu === 'AHU-1' ? [1, 2, 3] : [4, 5, 6];
    const low = (floors[0] - 1) * FLOOR_H;
    add(`sa-riser-${ahu}`, 'sa', null, ahu, ahu, `L${floors[0]}`,
      [[-6.65, 25.5, az], [-7.6, 25.5, az], [-7.6, 25.5, R.sa[1]], [R.sa[0], 25.5, R.sa[1]], [R.sa[0], low + SA_Y, R.sa[1]]], 1.3, [`${ahu}:sa`, null]);
    add(`ra-riser-${ahu}`, 'ra', null, ahu, `L${floors[0]}`, ahu,
      [[R.ra[0], low + RA_Y, R.ra[1]], [R.ra[0], 25.5, R.ra[1]], [7.4, 25.5, R.ra[1]], [7.4, 25.5, az], [6.1, 25.5, az]], 1.2, [null, `${ahu}:ra`]);
    for (const n of floors) {
      const y = (n - 1) * FLOOR_H, lv = `L${n}`;
      const ys = y + SA_Y, yr = y + RA_Y, rx = R.sa[0], rz = R.sa[1];
      const ez = SA_RING.z * s;
      add(`sa-${lv}`, 'sa', lv, ahu, ahu, lv, [[rx, ys, rz], [rx, ys, ez], [-SA_RING.x, ys, ez], [-SA_RING.x, ys, -ez],
        [SA_RING.x, ys, -ez], [SA_RING.x, ys, ez], [rx, ys, ez]], 0.55);
      const qz = RA_RING.z * s, qx = R.ra[0];
      add(`ra-${lv}`, 'ra', lv, ahu, lv, ahu, [[qx, yr, qz], [RA_RING.x, yr, qz], [RA_RING.x, yr, -qz], [-RA_RING.x, yr, -qz],
        [-RA_RING.x, yr, qz], [qx, yr, qz], [qx, yr, R.ra[1]]], 0.45);
    }
  }
  for (const z of zones) {
    const y = (z.floor - 1) * FLOOR_H;
    add(`sa-${z.id}`, 'sa', z.level, z.id, z.ahu, z.vav, branchPts(z.cx, z.cz, SA_RING.x, SA_RING.z, y + SA_Y), 0.32);
  }

  // ---- heating hot water: HHW-1 plant ↔ B1 headers ↔ riser, per-floor reheat loops + VAV branches, AHU coils
  add('hws-b1', 'hws', 'B1', 'HHW-1', 'HHW-1', 'riser-hws',
    [[-14.75, -2.75, 6.4], [-14.75, -2.75, 6.9], [-14.75, -0.9, 6.9], [-7.6, -0.9, 6.9], [-7.6, -0.9, RISER.hws[1]], [RISER.hws[0], -0.9, RISER.hws[1]]], 0.16, ['HHW-1:hws', null]);
  add('hwr-b1', 'hwr', 'B1', 'HHW-1', 'riser-hwr', 'HHW-1',
    [[RISER.hwr[0], -1.3, RISER.hwr[1]], [-8.2, -1.3, RISER.hwr[1]], [-8.2, -1.3, 5.95], [-8.2, -4.15, 5.95], [-9.9, -4.15, 5.95]], 0.16, [null, 'HHW-1:hwr']);
  add('hws-riser', 'hws', null, 'HHW-1', 'HHW-1', 'RF',
    [[RISER.hws[0], -0.9, RISER.hws[1]], [RISER.hws[0], 24.8, RISER.hws[1]]], 0.14);
  add('hwr-riser', 'hwr', null, 'HHW-1', 'RF', 'HHW-1',
    [[RISER.hwr[0], 24.5, RISER.hwr[1]], [RISER.hwr[0], -1.3, RISER.hwr[1]]], 0.14);
  for (let n = 1; n <= 6; n++) {
    const y = (n - 1) * FLOOR_H, lv = `L${n}`;
    const yh = y + HWS_Y, yq = y + HWR_Y, X = HWS_RING.x, Z = HWS_RING.z, Q = HWR_RING.x, W = HWR_RING.z;
    add(`hws-${lv}`, 'hws', lv, 'HHW-1', 'riser-hws', lv, [[RISER.hws[0], yh, RISER.hws[1]], [-X, yh, RISER.hws[1]], [-X, yh, -Z],
      [X, yh, -Z], [X, yh, Z], [-X, yh, Z], [-X, yh, RISER.hws[1]]], 0.08);
    add(`hwr-${lv}`, 'hwr', lv, 'HHW-1', lv, 'riser-hwr', [[-Q, yq, RISER.hwr[1]], [-Q, yq, W], [Q, yq, W], [Q, yq, -W],
      [-Q, yq, -W], [-Q, yq, RISER.hwr[1]], [RISER.hwr[0], yq, RISER.hwr[1]]], 0.08);
  }
  for (const z of zones) {
    const y = (z.floor - 1) * FLOOR_H;
    add(`hws-${z.id}`, 'hws', z.level, z.id, 'HHW-1', z.vav, branchPts(z.cx, z.cz, HWS_RING.x, HWS_RING.z, y + HWS_Y, y + SA_Y - 0.2), 0.04);
  }
  // AHU heating coil: supply into its bottom connection, return from its top (service side, facing the core)
  for (const [ahu, s] of [['AHU-1', -1], ['AHU-2', 1]]) {
    add(`hws-${ahu}`, 'hws', 'RF', ahu, 'riser-hws', ahu, [[RISER.hws[0], 24.8, RISER.hws[1]], [-6.6, 24.8, RISER.hws[1]],
      [-6.6, 24.8, 6.45 * s], [-6.6, 24.25, 6.45 * s], [-1.6, 24.25, 6.45 * s], [-1.6, 24.66, 6.45 * s], [-1.6, 24.66, 6.6 * s]], 0.1, [null, `${ahu}:hws`]);
    add(`hwr-${ahu}`, 'hwr', 'RF', ahu, ahu, 'riser-hwr', [[-1.6, 26.34, 6.6 * s], [-1.6, 26.34, 6.2 * s], [-1.6, 24.5, 6.2 * s],
      [-6.9, 24.5, 6.2 * s], [-6.9, 24.5, RISER.hwr[1]], [RISER.hwr[0], 24.5, RISER.hwr[1]]], 0.1, [`${ahu}:hwr`, null]);
  }

  // ---- chilled water: chillers ↔ B1 headers ↔ riser ↔ roof AHU cooling coils
  // (every chiller nozzle is on the pump-skid end, facing west: CHW on the core side, CW outboard;
  // the branches are sized close to the chiller's own nozzles, which are smaller than the risers)
  for (const [ch, cz] of CH_Z) {
    add(`chwr-${ch}`, 'chwr', 'B1', ch, 'riser-chwr', ch, [[RISER.chwr[0], -1.3, RISER.chwr[1]], [7.2, -1.3, RISER.chwr[1]],
      [7.2, -1.3, cz + 0.5], [7.2, -4.08, cz + 0.5], [9.35, -4.08, cz + 0.5]], 0.16, [null, `${ch}:chwr`]);
    add(`chws-${ch}`, 'chws', 'B1', ch, ch, 'riser-chws', [[9.35, -3.64, cz + 0.5], [8.4, -3.64, cz + 0.5], [8.4, -0.9, cz + 0.5],
      [8.4, -0.9, RISER.chws[1]], [RISER.chws[0], -0.9, RISER.chws[1]]], 0.16, [`${ch}:chws`, null]);
    // condenser water to / from this chiller (CWP-1's discharge header runs over the chillers); the
    // CW nozzles are stacked (in below, out above), so the supply drops beside the return's
    // take-off and slides in under it
    add(`cws-${ch}`, 'cws', 'B1', ch, 'CWP-1', ch, [[12.95, -2.75, 0.6], [13.6, -2.75, 0.6], [13.6, -1.0, 0.6], [13.6, -1.0, cz - 0.97],
      [8.9, -1.0, cz - 0.97], [8.9, -4.08, cz - 0.97], [8.9, -4.08, cz - 0.52], [9.35, -4.08, cz - 0.52]], 0.2, ['CWP-1:discharge', `${ch}:cws`]);
    add(`cwr-${ch}`, 'cwr', 'B1', ch, ch, 'riser-cwr', [[9.35, -3.64, cz - 0.52], [8.1, -3.64, cz - 0.52], [8.1, -1.6, cz - 0.52],
      [8.1, -1.6, RISER.cwr[1]], [RISER.cwr[0], -1.6, RISER.cwr[1]]], 0.2, [`${ch}:cwr`, null]);
  }
  add('chws-riser', 'chws', null, 'CH', 'B1', 'RF', [[RISER.chws[0], -0.9, RISER.chws[1]], [RISER.chws[0], 24.6, RISER.chws[1]]], 0.2);
  add('chwr-riser', 'chwr', null, 'CH', 'RF', 'B1', [[RISER.chwr[0], 24.9, RISER.chwr[1]], [RISER.chwr[0], -1.3, RISER.chwr[1]]], 0.2);
  // AHU cooling coil: supply into its bottom connection, return from its top
  for (const [ahu, s] of [['AHU-1', -1], ['AHU-2', 1]]) {
    add(`chws-${ahu}`, 'chws', 'RF', ahu, 'riser-chws', ahu, [[RISER.chws[0], 24.6, RISER.chws[1]], [6.6, 24.6, RISER.chws[1]],
      [6.6, 24.6, 6.45 * s], [6.6, 25.05, 6.45 * s], [-2.5, 25.05, 6.45 * s], [-2.5, 24.66, 6.45 * s], [-2.5, 24.66, 6.6 * s]], 0.16, [null, `${ahu}:chws`]);
    add(`chwr-${ahu}`, 'chwr', 'RF', ahu, ahu, 'riser-chwr', [[-2.5, 26.34, 6.6 * s], [-2.5, 26.34, 5.9 * s], [-2.5, 24.9, 5.9 * s],
      [6.9, 24.9, 5.9 * s], [6.9, 24.9, RISER.chwr[1]], [RISER.chwr[0], 24.9, RISER.chwr[1]]], 0.16, [`${ahu}:chwr`, null]);
  }

  // ---- condenser water: tower basin → riser → CWP-1 → chillers → riser → tower spray
  add('cws-riser', 'cws', null, 'CT-1', 'CT-1', 'B1', [[9.15, 24.6, -0.6], [8.6, 24.6, -0.6], [8.6, 25.6, -0.6], [8.6, 25.6, RISER.cws[1]],
    [RISER.cws[0], 25.6, RISER.cws[1]], [RISER.cws[0], -0.5, RISER.cws[1]]], 0.26, ['CT-1:cws', null]);
  add('cws-b1', 'cws', 'B1', 'CWP-1', 'riser-cws', 'CWP-1', [[RISER.cws[0], -0.5, RISER.cws[1]], [7.6, -0.5, RISER.cws[1]],
    [7.6, -3.9, RISER.cws[1]], [8.85, -3.9, RISER.cws[1]]], 0.26, [null, 'CWP-1:suction']);
  add('cwr-riser', 'cwr', null, 'CT-1', 'B1', 'CT-1', [[RISER.cwr[0], -1.6, RISER.cwr[1]], [RISER.cwr[0], 26.2, RISER.cwr[1]],
    [8.9, 26.2, RISER.cwr[1]], [8.9, 25.35, RISER.cwr[1]], [8.9, 25.35, 0.6], [9.15, 25.35, 0.6]], 0.26, [null, 'CT-1:cwr']);

  return {
    footprint: { w: 40, d: 24 },
    floorHeight: FLOOR_H,
    levels, core, zones, vavs, equipment, runs, ports,
    risers: { ...RISER, duct: DUCT_RISER },
  };
}

// ---------------------------------------------------------------------------------------------
// Environment: weather, sun, occupancy schedules
// ---------------------------------------------------------------------------------------------
const LAT = 40 * DEG;         // mid-latitude site
const DECL = 16 * DEG;        // late-spring sun
const SOLAR_NOON = 13.1;      // daylight-saving clock
const DEW_F = 57;             // humid-ish summer dew point

// OAT: asymmetric daily curve, ≈62 °F at 05:00 → ≈88 °F at 15:00 (+ small seeded day-to-day offset)
function oatCurve(h) {
  const t = ((h % 24) + 24) % 24;
  let s; // 0 at min, 1 at max
  if (t >= 5 && t <= 15) s = 0.5 - 0.5 * Math.cos(((t - 5) / 10) * Math.PI);
  else {
    const u = t > 15 ? t - 15 : t + 9; // 0..14 hours after the peak
    s = 0.5 + 0.5 * Math.cos((u / 14) * Math.PI);
  }
  return 62 + 26 * s;
}

function rhFrom(tf, dewF) {
  const tc = (tf - 32) / 1.8, dc = (Math.min(dewF, tf) - 32) / 1.8;
  const es = Math.exp((17.625 * tc) / (243.04 + tc)), ed = Math.exp((17.625 * dc) / (243.04 + dc));
  return clamp((100 * ed) / es, 5, 100);
}

// Stull (2011) wet-bulb approximation, °F in / out
function wetBulb(tf, rh) {
  const T = (tf - 32) / 1.8;
  const w = T * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(T + rh) - Math.atan(rh - 1.676331)
    + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
  return w * 1.8 + 32;
}

function sunPos(h, out) {
  const H = (h - SOLAR_NOON) * 15 * DEG;
  const sinAlt = Math.sin(LAT) * Math.sin(DECL) + Math.cos(LAT) * Math.cos(DECL) * Math.cos(H);
  const alt = Math.asin(clamp(sinAlt, -1, 1));
  // azimuth clockwise from north: 0 N, π/2 E, π S, 3π/2 W
  let az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(DECL) * Math.cos(LAT)) + Math.PI;
  az = ((az % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  out.alt = alt; out.az = az;
  const ca = Math.cos(alt);
  out.dx = ca * Math.sin(az);     // east
  out.dy = Math.sin(alt);         // up
  out.dz = -ca * Math.cos(az);    // south (north is -z)
  return out;
}

// weekday office occupancy profile (fraction of design head-count)
const OCC_TABLE = [[0, 0], [6, 0], [6.75, 0.08], [7.5, 0.35], [8.5, 0.82], [9.5, 0.92], [11.75, 0.9], [12.25, 0.66],
  [13.0, 0.7], [13.75, 0.88], [15.5, 0.86], [16.5, 0.7], [17.25, 0.42], [18.0, 0.18], [19.0, 0.06], [20.5, 0.02], [21.5, 0], [24, 0]];
const LOBBY_TABLE = [[0, 0], [6, 0.02], [7.25, 0.3], [8.25, 0.85], [9.25, 0.35], [11.75, 0.45], [12.25, 0.8], [13.25, 0.4],
  [16.75, 0.45], [17.5, 0.75], [18.5, 0.25], [20, 0.05], [22, 0], [24, 0]];
function table(tab, h) {
  for (let i = 1; i < tab.length; i++) {
    if (h <= tab[i][0]) {
      const [h0, v0] = tab[i - 1], [h1, v1] = tab[i];
      return lerp(v0, v1, (h - h0) / (h1 - h0 || 1));
    }
  }
  return tab[tab.length - 1][1];
}

const FACADE = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
function facadesOf(exp) {
  if (exp.length === 1) return [{ n: FACADE[exp], w: 1 }];
  return [{ n: FACADE[exp[0]], w: 0.65 }, { n: FACADE[exp[1]], w: 0.65 }];
}

// ---------------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------------
const K_AIR = 0.6;          // °F/h per °F of supply ΔT at full design flow
const K_MIX = 0.15;         // inter-zone / plenum mixing, 1/h
const VAV_KP = 60, VAV_KI = 120;   // zone PI: % per °F, % per °F·h
const MIN_FLOW = 0.3, HEAT_FLOW = 0.35;
const CH_CAP = 100;         // tons per chiller
// heating hot water plant HHW-1: steam to hot water
const STEAM_CAP = 1200;     // MBH with both steam valves full open (1/3 valve 400, 2/3 valve 800)
const HX_CAP = 450;         // MBH per shell-and-tube exchanger at design flow
const PUMP_FLOW = 0.6;      // loop flow fraction one HW pump gives at 100 % speed
const HW_PUMPS = ['HWP-1', 'HWP-2'];
const STEAM_RAMP = 100 / 600; // steam valve demand opens at most 10 %/min (warm-up without water hammer)
const SUB_DT = 15;          // max internal step, sim seconds
const MAX_SUB = 40;
const ALARM_HOLD = 45 * 60; // s after a mode change / time jump before space alarms arm
const FAULT_KINDS = ['vav-stuck', 'chiller-trip', 'fan-fail', 'hot-day'];

export function createSim({ seed = 7, startHour = 9.5 } = {}) {
  const rand = mulberry32(seed);
  const layout = buildLayout();
  const zoneById = new Map(layout.zones.map((z) => [z.id, z]));
  const vavById = new Map(layout.vavs.map((v) => [v.id, v]));
  const eqById = new Map(layout.equipment.map((e) => [e.id, e]));
  const runById = new Map(layout.runs.map((r) => [r.id, r]));
  const levelById = new Map(layout.levels.map((l) => [l.id, l]));
  const dayOffset = []; // seeded day-to-day weather wobble
  for (let i = 0; i < 7; i++) dayOffset.push((rand() - 0.5) * 3);

  // ---------- state skeleton
  const state = {
    hour: 0, day: 1, time: 0, timeLabel: '',
    oat: 70, oah: 50, wetBulb: 60, sunAlt: 0, sunAz: 0, sunDir: [0, -1, 0], daylight: 0,
    occupancy: 0, occupiedMode: false,
    zones: {}, ahus: {},
    plant: {
      chillers: {},
      hhw: {
        enabled: false, hws: 110, hwr: 106, u: 0,
        cv1: 0, cv1Fb: 0, cv2: 0, cv2Fb: 0, byp: 0, bypFb: 0,
        dp: 0, dpSp: 8, load: 0, steam: 0,
        hx: [{ iso1: 100, iso2: 1 }, { iso1: 0, iso2: 0 }],
        lagHx: false, leadPump: 'HWP-1', lagPump: false, tempAlarm: false,
      },
      tower: { on: false, fan: 0, cws: 72, cwr: 72, heat: 0 },
      pumps: {}, chwsSp: 44, hwsSp: 140, chwLoad: 0, hwLoad: 0, cwsSp: 75, chws: 66, chwr: 66.5,
    },
    kw: 0, kwh: 0, cop: 0,
    kwBreakdown: { fans: 0, chillers: 0, pumps: 0, lights: 0, plug: 0 },
    alarms: [], alarmsVersion: 0, faults: [],
    flows: {},
  };
  const P = state.plant;

  // ---------- per-zone model parameters (internal)
  const Z = layout.zones.map((z) => {
    const corner = z.exposure.length === 2;
    const lobby = z.name.startsWith('Lobby');
    const cfmMax = Math.round((lobby ? 1600 : corner ? 1400 : z.exposure === 'N' || z.exposure === 'S' ? 1200 : 1000) * (0.95 + rand() * 0.1) / 10) * 10;
    const s = {
      temp: 72 + (rand() - 0.5) * 1.5, sp: 72, spHeat: 71, spCool: 73, occ: 0, damper: 0, damperCmd: 0, cfm: 0, cfmMax,
      flowSp: 0, reheat: 0, dat: 72, solar: 0, lights: false, alarm: null, status: 'ok', stuck: false,
    };
    state.zones[z.id] = s;
    return {
      z, s, ahuIdx: z.ahu === 'AHU-1' ? 0 : 1, floorIdx: z.floor - 1,
      facades: facadesOf(z.exposure).map((f) => ({ n: f.n, w: f.w * (lobby ? 1.25 : 1) })),
      kEnv: (corner ? 0.07 : 0.05) + (z.floor === 6 ? 0.03 : 0) + (lobby ? 0.02 : 0),
      occF: lobby ? 1 : 0.75 + rand() * 0.35,
      gainF: 0.85 + rand() * 0.3,
      phase: rand() * Math.PI * 2, phase2: rand() * Math.PI * 2,
      lightsOn: 6.3 + rand() * 1.3,
      lightsOff: 17.4 + Math.pow(rand(), 2.2) * 4.6,
      lightKw: (z.area * (lobby ? 12 : 9)) / 1000,
      lobby, I: 0, hiT: 0, loT: 0,
    };
  });
  const floorAvg = new Float64Array(6).fill(72);

  // ---------- AHUs
  const AHU_IDS = ['AHU-1', 'AHU-2'];
  const A = AHU_IDS.map((id, i) => {
    const zs = Z.filter((q) => q.ahuIdx === i);
    const design = zs.reduce((a, q) => a + q.s.cfmMax, 0);
    const s = {
      on: false, cmd: false, sfSpeed: 0, rfSpeed: 0, oad: 0, ccv: 0, hcv: 0, sat: 70, satSp: 57, mat: 72, rat: 73,
      ssp: 0, sspSp: 1.5, cfm: 0, cfmDesign: design, econ: false, alarm: null, kw: 0, coilTons: 0, coilMbh: 0,
      rad: 100, ead: 0, pfDp: 0, ffDp: 0, sfFault: false,
    };
    state.ahus[id] = s;
    return { id, s, zs, design, failed: false, runT: 0, satHiT: 0 };
  });

  // ---------- plant
  const CH_IDS = ['CH-1', 'CH-2'];
  const C = CH_IDS.map((id) => {
    const s = { on: false, load: 0, chws: 66, chwr: 66, cwl: 72, kw: 0, tons: 0, status: 'off', lead: id === 'CH-1' };
    P.chillers[id] = s;
    return { id, s, limit: 0, timer: 0, tripped: false, share: 0 };
  });
  for (const id of ['CHWP-1', 'CHWP-2', 'HWP-1', 'HWP-2', 'CWP-1']) P.pumps[id] = { on: false, speed: 0, kw: 0 };
  const plantCtl = { enabled: false, offT: 0, runT: 0, lagWanted: false, lagT: 0, lagOffT: 0, chwsHiT: 0 };
  // HHW-1 sequence timers (internal): pump lag on / off, HX-2 in / out, plant run time, HWS-low debounce
  const hwCtl = { lagT: 0, lagOffT: 0, hxInT: 0, hxOutT: 0, runT: 0, lowT: 0 };

  // ---------- faults & alarms (internal)
  const faults = { stuckZone: null, trip: false, fanFail: false, hotDay: false, hotBoost: 0 };
  const alarmMap = new Map();
  let alarmsDirty = true;
  let alarmHoldUntil = 0;
  let lastOccMode = null;
  let kwh = 0;
  const kwHist = new Float64Array(24).fill(0);
  let clk = 0;          // absolute sim clock in hours (day*24 + hour)
  let t = 0;            // monotonic sim seconds (timers)
  let relaxBoost = 1;   // >1 only while setHour() pre-rolls
  const sun = { alt: 0, az: 0, dx: 0, dy: -1, dz: 0 };

  function raise(id, severity, text, target) {
    const a = alarmMap.get(id);
    if (a) { if (a.text !== text) { a.text = text; alarmsDirty = true; } return a; }
    const n = { id, severity, text, target, since: t, sinceLabel: label() };
    alarmMap.set(id, n);
    alarmsDirty = true;
    return n;
  }
  function drop(id) { if (alarmMap.delete(id)) alarmsDirty = true; }
  function label() {
    const h = state.hour, hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    return `${DAYS[state.day]} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  // per-zone alarm ids (precomputed; no string building in the hot loop)
  for (const q of Z) { q.hiId = `hi-temp:${q.z.id}`; q.loId = `lo-temp:${q.z.id}`; q.gain = 0; q.reheatMbh = 0; q.u = 0; }
  for (const a of A) { a.nightRun = false; a.satHiId = `sat-high:${a.id}`; }
  let curDayAbs = 0;
  let reheatRise = 0;     // °F of discharge rise at 100 % reheat (depends on HWS)
  let chwFlowing = false, hwFlowing = false;
  let beam = 0;

  // ---------- one internal integration step of dt simulated seconds
  function sub(dt) {
    const dh = dt / 3600;
    t += dt;
    clk += dh;
    const dAbs = Math.floor(clk / 24);
    if (dAbs !== curDayAbs) { curDayAbs = dAbs; kwh = 0; }
    const hour = clk - dAbs * 24;
    const day = ((dAbs % 7) + 7) % 7;
    state.hour = hour; state.day = day;
    const weekday = day <= 4;

    // ---- weather + sun
    faults.hotBoost = relax(faults.hotBoost, faults.hotDay ? 12 : 0, dt, 600);
    const oat = oatCurve(hour) + lerp(dayOffset[day], dayOffset[(day + 1) % 7], hour / 24) + faults.hotBoost;
    const rh = rhFrom(oat, DEW_F + faults.hotBoost * 0.25);
    const wb = wetBulb(oat, rh);
    state.oat = oat; state.oah = rh; state.wetBulb = wb;
    sunPos(hour, sun);
    state.sunAlt = sun.alt; state.sunAz = sun.az;
    const daylight = sstep(-6, 8, sun.alt / DEG);
    state.daylight = daylight;
    beam = daylight * clamp(Math.sin(sun.alt) * 2.5, 0, 1);

    // ---- schedule
    const occMode = weekday && hour >= 6 && hour < 19;
    if (occMode !== lastOccMode) { lastOccMode = occMode; alarmHoldUntil = Math.max(alarmHoldUntil, t + ALARM_HOLD); }
    state.occupiedMode = occMode;
    const occBase = weekday ? table(OCC_TABLE, hour) : 0;
    const lobbyBase = weekday ? table(LOBBY_TABLE, hour) : 0;
    const cleanFloor = weekday && hour >= 20 && hour < 23 ? 5 - Math.floor((hour - 20) * 2) : -1;

    // ---- zone loads (°F/h) from envelope, sun, people, lights, plug loads, neighbours
    let occSum = 0, areaSum = 0;
    for (let i = 0; i < Z.length; i++) {
      const q = Z[i], z = q.s;
      let occ = 0;
      if (weekday) {
        const wob = 1 + 0.12 * Math.sin(hour * 1.7 + q.phase) + 0.06 * Math.sin(hour * 4.3 + q.phase2);
        occ = clamp((q.lobby ? lobbyBase : occBase) * q.occF * wob, 0, 1);
      } else if (q.phase < 0.55 && hour > 10 && hour < 15) occ = 0.06; // a few weekend workers
      z.occ = occ;
      occSum += occ * q.z.area; areaSum += q.z.area;
      let lit = weekday ? hour >= q.lightsOn && hour < q.lightsOff : occ > 0.01;
      if (!lit && q.floorIdx === cleanFloor) lit = true;            // cleaning crew sweeps L6 → L1, 20:00–23:00
      if (q.lobby && hour >= 5.5 && hour < 23) lit = true;           // lobby lit all evening
      z.lights = lit;
      let irr = 0.18 * daylight;
      for (let f = 0; f < q.facades.length; f++) {
        const F = q.facades[f];
        const dot = sun.dx * F.n[0] + sun.dz * F.n[1];
        if (dot > 0) irr += F.w * dot * beam;
      }
      if (q.floorIdx === 5) irr += 0.25 * beam * Math.max(0, sun.dy);
      z.solar = irr;
      q.gain = q.kEnv * (oat - z.temp) + 3.6 * irr
        + (occ * 2.6 + (lit ? 0.7 : 0) + 0.35) * q.gainF
        + K_MIX * (floorAvg[q.floorIdx] - z.temp)
        + (q.floorIdx === 0 ? 0.02 * (68 - z.temp) : 0);
    }
    state.occupancy = areaSum > 0 ? occSum / areaSum : 0;

    // ---- air handlers + their VAVs
    const hws = P.hhw.hws;
    for (let ai = 0; ai < A.length; ai++) {
      const a = A[ai], s = a.s, zs = a.zs;
      let maxT = -1e9, minT = 1e9;
      for (let i = 0; i < zs.length; i++) { const T = zs[i].s.temp; if (T > maxT) maxT = T; if (T < minT) minT = T; }
      if (occMode) a.nightRun = false;
      else if (maxT > 85.5 || minT < 59.5) a.nightRun = true;          // unoccupied setback cycle
      else if (maxT < 83 && minT > 62) a.nightRun = false;
      s.cmd = occMode || a.nightRun;
      const running = s.cmd && !a.failed;

      // VAV PI loops (they keep controlling even when the fan has failed — dampers drive open)
      let demand = 0, maxFlowSp = 0, c1 = 0, c2 = 0, c3 = 0;
      for (let i = 0; i < zs.length; i++) {
        const q = zs[i], z = q.s;
        if (occMode) { z.spHeat = 71; z.spCool = 73; z.sp = 72; }
        else { z.spHeat = 60; z.spCool = 85; z.sp = clamp(z.temp, 60, 85); }
        let flowSp = 0, heat = 0;
        if (s.cmd) {
          const T = z.temp;
          const e = T > z.spCool ? T - z.spCool : T < z.spHeat ? T - z.spHeat : 0;
          let I = q.I + VAV_KI * e * dh * relaxBoost;
          I = clamp(I, -100 - VAV_KP * e, 100 - VAV_KP * e);
          q.I = clamp(I, -100, 100);
          const u = clamp(VAV_KP * e + q.I, -100, 100);
          q.u = u;
          const cool = u > 0 ? u : 0;
          heat = u < 0 ? -u : 0;
          const minF = occMode ? MIN_FLOW : 0;
          flowSp = heat > 0 ? Math.max(minF, HEAT_FLOW) : minF + (1 - minF) * cool / 100;
          if (cool > c1) { c3 = c2; c2 = c1; c1 = cool; } else if (cool > c2) { c3 = c2; c2 = cool; } else if (cool > c3) c3 = cool;
        } else { q.I = relax(q.I, 0, dt, 600); q.u = 0; }
        z.flowSp = flowSp;
        z.reheat = relax(z.reheat, heat, dt, 30);
        demand += flowSp * z.cfmMax;
        if (flowSp > maxFlowSp) maxFlowSp = flowSp;
      }

      // supply fan on duct static (static reset 1.0–1.5 in.WC by the widest-open box)
      const D = demand / a.design;
      s.sspSp = relax(s.sspSp, lerp(1.0, 1.5, clamp((maxFlowSp - 0.55) / 0.35, 0, 1)), dt, 300);
      if (running) {
        const sReq = clamp(Math.sqrt(0.75 * D * D + 0.25 * (s.sspSp / 1.5)), 0.3, 1);
        s.sfSpeed = relax(s.sfSpeed, sReq * 100, dt, 25);
      } else s.sfSpeed = relax(s.sfSpeed, 0, dt, a.failed ? 8 : 15);
      const sp = s.sfSpeed / 100;
      s.ssp = running ? clamp(6 * (sp * sp - 0.75 * D * D), 0, 3) : relax(s.ssp, 0, dt, 8);
      const ff = running ? clamp(Math.sqrt(s.ssp / s.sspSp), 0, 1) : 0;
      const kS = Math.sqrt(1.5 / s.sspSp);

      // pressure-independent VAV boxes: damper follows flow setpoint / available static
      let sumCfm = 0, sumCfmT = 0, sumT = 0;
      for (let i = 0; i < zs.length; i++) {
        const z = zs[i].s;
        const cmdD = clamp((100 * z.flowSp * kS) / Math.max(0.25, ff), 0, 100);
        z.damperCmd = cmdD;
        z.damper = z.stuck ? 0 : relax(z.damper, cmdD, dt, 20);
        let frac = 0;
        if (running) frac = z.stuck ? 0.02 * ff : Math.min(z.flowSp, (z.damper / 100) * ff / kS);
        z.cfm = z.cfmMax * frac;
        sumCfm += z.cfm; sumCfmT += z.cfm * z.temp; sumT += z.temp;
      }
      s.cfm = running ? sumCfm * 1.03 : 0;
      s.rat = relax(s.rat, sumCfm > 1 ? sumCfmT / sumCfm + 1.2 : sumT / zs.length + 0.8, dt, 120);

      // economizer: dry-bulb high limit 65 °F, modulate OA to hold MAT at SAT SP less fan heat
      const fanHeat = 1.5 * sp;
      const oaMin = running && occMode ? 0.2 : 0;
      s.econ = running && oat < 65 && oat < s.rat - 1;
      let oaReq = oaMin;
      if (s.econ) oaReq = clamp((s.rat - (s.satSp - fanHeat)) / Math.max(0.5, s.rat - oat), oaMin, 1);
      s.oad = relax(s.oad, running ? oaReq * 100 : 0, dt, 40);
      // return damper linked to the OA damper; relief opens once OA is above the 20 % minimum
      s.rad = 100 - s.oad;
      s.ead = running ? clamp((s.oad - 20) / 0.8, 0, 100) : 0;
      const oaf = s.oad / 100;
      s.mat = relax(s.mat, running ? oaf * oat + (1 - oaf) * s.rat : lerp(s.rat, oat, 0.5), dt, running ? 30 : 600);

      // SAT reset 55–60 °F on the three most-demanding zones' cooling loops
      s.satSp = relax(s.satSp, 60 - 5 * clamp(((c1 + c2 + c3) / 3 - 35) / 50, 0, 1), dt, 600);

      // CHW + HW coil valves holding SAT
      const ent = s.mat + fanHeat;
      const coolMax = chwFlowing ? clamp((ent - P.chws) * 0.8, 0, 45) : 0;
      const heatMax = hwFlowing ? clamp((hws - ent) * 0.45, 0, 60) : 0;
      let ccvReq = 0, hcvReq = 0;
      if (running) {
        const need = ent - s.satSp;
        if (need > 0.2) ccvReq = coolMax > 0.1 ? clamp((need / coolMax) * 100, 0, 100) : 100;
        else if (need < -0.2) hcvReq = heatMax > 0.1 ? clamp((-need / heatMax) * 100, 0, 100) : 100;
      }
      s.ccv = relax(s.ccv, ccvReq, dt, 40);
      s.hcv = relax(s.hcv, hcvReq, dt, 40);
      const dCool = (coolMax * s.ccv) / 100, dHeat = (heatMax * s.hcv) / 100;
      s.sat = relax(s.sat, running ? ent - dCool + dHeat : lerp(s.mat, oat, 0.3), dt, running ? 60 : 900);
      s.coilTons = running ? (s.cfm * 1.08 * dCool / 12000) * 1.25 : 0;
      s.coilMbh = running ? (s.cfm * 1.08 * dHeat) / 1000 : 0;
      // return fan tracks the supply fan, and works harder as the economizer
      // opens (more of the return has to leave through the relief dampers)
      s.rfSpeed = relax(s.rfSpeed, running ? clamp(s.sfSpeed * 0.86 + (s.oad - 20) * 0.05, 15, 100) : 0, dt, a.failed ? 8 : 20);
      s.on = running;
      // filter dP (in.WC) rises with the square of the airflow: pre-filter and final filter
      const qf = s.cfm / a.design;
      s.pfDp = 0.35 * qf * qf;
      s.ffDp = 0.55 * qf * qf;
      s.sfFault = a.failed;
      const rp = s.rfSpeed / 100;
      s.kw = 22 * sp * sp * sp + 7.5 * rp * rp * rp;
      a.runT = running ? a.runT + dt : 0;
    }

    // ---- zone temperatures
    let hwLoad = 0, hwDemand = 0, lightsKw = 3; // 3 kW core / corridor lighting
    const fsum = [0, 0, 0, 0, 0, 0], fn = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < Z.length; i++) {
      const q = Z[i], z = q.s, as = A[q.ahuIdx].s;
      const rise = as.on ? (reheatRise * z.reheat) / 100 : 0;
      z.dat = as.on ? as.sat + rise : relax(z.dat, z.temp, dt, 300);
      const frac = z.cfm / z.cfmMax;
      const dT = q.gain + K_AIR * frac * (z.dat - z.temp);
      z.temp = clamp(z.temp + dT * dh * relaxBoost, 45, 110);
      q.reheatMbh = (1.08 * z.cfm * rise) / 1000;
      hwLoad += q.reheatMbh;
      hwDemand += (z.reheat / 100) * 1.08 * Math.max(z.cfm, as.cmd ? z.cfmMax * HEAT_FLOW : 0) * 30 / 1000;
      if (z.lights) lightsKw += q.lightKw;
      fsum[q.floorIdx] += z.temp; fn[q.floorIdx]++;
    }
    for (let f = 0; f < 6; f++) floorAvg[f] = fn[f] ? fsum[f] / fn[f] : 72;
    for (let ai = 0; ai < A.length; ai++) {
      const s = A[ai].s;
      hwLoad += s.coilMbh;
      hwDemand += (s.hcv / 100) * (s.cfm * 1.08 * 25) / 1000;
    }

    // ---- chilled water plant: lead / lag staging with start delay and soft-load
    const chwLoad = A[0].s.coilTons + A[1].s.coilTons;
    P.chwLoad = chwLoad;
    P.chwsSp = 44 + 2 * clamp((68 - oat) / 10, 0, 1);
    const coolCall = (A[0].s.on && A[0].s.ccv > 3) || (A[1].s.on && A[1].s.ccv > 3);
    if (coolCall && (oat > 52 || chwLoad > 2)) { plantCtl.enabled = true; plantCtl.offT = 0; }
    else if (plantCtl.enabled) { plantCtl.offT += dt; if (plantCtl.offT > 300) plantCtl.enabled = false; }
    plantCtl.runT = plantCtl.enabled ? plantCtl.runT + dt : 0;
    const leadIdx = C[0].tripped ? 1 : 0;
    const lagIdx = leadIdx === 0 ? 1 : -1;
    const lead = C[leadIdx];
    if (lagIdx >= 0 && plantCtl.enabled && lead.s.status === 'running' && lead.limit > 0.98
      && (lead.s.tons / CH_CAP > 0.95 || P.chws > P.chwsSp + 2.5)) plantCtl.lagT += dt;
    else plantCtl.lagT = 0;
    if (plantCtl.lagT > 300) plantCtl.lagWanted = true;
    if (plantCtl.lagWanted && chwLoad < 0.6 * CH_CAP && lead.s.status === 'running') plantCtl.lagOffT += dt;
    else plantCtl.lagOffT = 0;
    if (plantCtl.lagOffT > 600 || !plantCtl.enabled) plantCtl.lagWanted = false;
    let capAvail = 0, nP = 0;
    for (let i = 0; i < 2; i++) {
      const c = C[i], cs = c.s;
      const want = !c.tripped && plantCtl.enabled && (i === leadIdx || (i === lagIdx && plantCtl.lagWanted));
      if (c.tripped) { cs.status = 'tripped'; c.limit = 0; c.timer = 0; }
      else if (!want) { cs.status = 'off'; c.limit = 0; c.timer = 0; }
      else if (cs.status === 'off' || cs.status === 'tripped') { cs.status = 'starting'; c.timer = 0; }
      else if (cs.status === 'starting') { c.timer += dt; if (c.timer >= 120) { cs.status = 'running'; c.limit = 0.2; } }
      else c.limit = Math.min(1, c.limit + dt / 240);
      cs.on = cs.status === 'running' || cs.status === 'starting';
      cs.lead = i === leadIdx;
      if (cs.status === 'running') capAvail += CH_CAP * c.limit;
      const pump = P.pumps[i === 0 ? 'CHWP-1' : 'CHWP-2'];
      pump.on = cs.on;
      if (pump.on) nP++;
    }
    const delivered = Math.min(chwLoad, capAvail);
    const pumpTarget = 35 + 65 * clamp(chwLoad / (CH_CAP * Math.max(1, nP)), 0, 1);
    let pumpSpd = 0;
    for (const id of ['CHWP-1', 'CHWP-2']) {
      const p = P.pumps[id];
      p.speed = relax(p.speed, p.on ? pumpTarget : 0, dt, 20);
      p.kw = 7.5 * Math.pow(p.speed / 100, 3);
      if (p.on) pumpSpd = Math.max(pumpSpd, p.speed);
    }
    chwFlowing = nP > 0;
    if (chwFlowing) {
      const short = capAvail <= 0.01 ? 1 : chwLoad > 0.5 ? clamp(1 - delivered / chwLoad, 0, 1) : 0;
      P.chws = relax(P.chws, clamp(P.chwsSp + (P.chwr - P.chwsSp) * short, 38, 80), dt, 180);
      const dTchw = clamp((10 * chwLoad) / (CH_CAP * nP * Math.max(0.35, pumpSpd / 100)), 0, 16);
      P.chwr = relax(P.chwr, P.chws + dTchw, dt, 90);
    } else {
      P.chws = relax(P.chws, 68, dt, 5400);
      P.chwr = relax(P.chwr, 68.5, dt, 5400);
    }
    let chKw = 0, nCh = 0, condTons = 0;
    for (let i = 0; i < 2; i++) {
      const c = C[i], cs = c.s;
      const share = cs.status === 'running' && capAvail > 0 ? (delivered * CH_CAP * c.limit) / capAvail : 0;
      c.share = share;
      const plr = share / CH_CAP;
      cs.tons = share;
      cs.load = clamp(plr * 100, 0, 100);
      const kwpt = clamp(0.5 + 0.22 * (1 - plr) * (1 - plr) + 0.012 * (P.tower.cws - 75), 0.35, 1.3);
      cs.kw = cs.status === 'running' ? share * kwpt + 2 : cs.status === 'starting' ? 3 : 0;
      cs.kwPerTon = share > 0.5 ? cs.kw / share : 0;
      if (cs.on) { cs.chws = relax(cs.chws, P.chws + (cs.status === 'running' ? 0 : 3), dt, 60); cs.chwr = relax(cs.chwr, P.chwr, dt, 60); nCh++; }
      else { cs.chws = relax(cs.chws, 68, dt, 1800); cs.chwr = relax(cs.chwr, 68.5, dt, 1800); }
      chKw += cs.kw;
      condTons += share + cs.kw / 3.517;
    }

    // ---- condenser water + cooling tower (fan holds CWS at wet-bulb + 7 °F)
    const T = P.tower;
    T.on = nCh > 0;
    T.heat = condTons;
    P.cwsSp = clamp(wb + 7, 65, 85);
    if (T.on) {
      const hf = condTons / 250;
      const fanReq = clamp((1 - (P.cwsSp - wb - 3) / Math.max(0.01, 16 * hf)) / 0.65, 0, 1);
      T.fan = relax(T.fan, fanReq * 100, dt, 30);
      T.cws = relax(T.cws, wb + 3 + 16 * hf * (1 - 0.65 * T.fan / 100), dt, 240);
      T.cwr = relax(T.cwr, T.cws + clamp((10 * condTons) / (100 * Math.max(1, nCh)), 0.5, 14), dt, 90);
    } else {
      T.fan = relax(T.fan, 0, dt, 20);
      T.cws = relax(T.cws, (wb + oat) / 2, dt, 3600);
      T.cwr = relax(T.cwr, T.cws, dt, 1800);
    }
    // condenser water leaving each chiller (its own rejected heat over the tower's supply)
    for (let i = 0; i < 2; i++) {
      const c = C[i], cs = c.s;
      const tgt = cs.status === 'running' ? T.cws + clamp((10 * (c.share + cs.kw / 3.517)) / CH_CAP, 0.5, 14) : T.cws;
      cs.cwl = relax(cs.cwl, tgt, dt, 90);
    }
    const cwp = P.pumps['CWP-1'];
    cwp.on = T.on;
    cwp.speed = relax(cwp.speed, T.on ? 70 + 15 * nCh : 0, dt, 20);
    cwp.kw = 11 * Math.pow(cwp.speed / 100, 3);

    // ---- heating hot water plant HHW-1: steam to hot water
    // OAT reset 160 → 120 °F; enabled while occupied or while anything calls for heat
    const H = P.hhw;
    P.hwsSp = clamp(160 - ((oat - 40) * 40) / 35, 120, 160);
    const hwEnable = occMode || hwDemand > 5;
    H.enabled = hwEnable;
    hwCtl.runT = hwEnable ? hwCtl.runT + dt : 0;

    // pumps: lead / lag VFD pumps on loop dP; the lead alternates daily (HWP-1 on even days)
    const leadId = day % 2 === 0 ? 'HWP-1' : 'HWP-2';
    const lagId = leadId === 'HWP-1' ? 'HWP-2' : 'HWP-1';
    const leadP = P.pumps[leadId], lagP = P.pumps[lagId];
    H.leadPump = leadId;
    const open = 0.25 + 0.75 * clamp(hwDemand / 400, 0, 1);   // how open the loop's valves are
    const fReq = Math.sqrt((H.dpSp * open) / 14);              // flow that holds the dP setpoint
    if (!hwEnable) { H.lagPump = false; hwCtl.lagT = 0; hwCtl.lagOffT = 0; }
    else if (!H.lagPump) {
      hwCtl.lagT = leadP.speed > 92 ? hwCtl.lagT + dt : 0;
      if (hwCtl.lagT >= 300) { H.lagPump = true; hwCtl.lagT = 0; hwCtl.lagOffT = 0; }
    } else {
      hwCtl.lagOffT = leadP.speed < 45 && lagP.speed < 45 ? hwCtl.lagOffT + dt : 0;
      if (hwCtl.lagOffT >= 600) { H.lagPump = false; hwCtl.lagOffT = 0; }
    }
    leadP.on = hwEnable;
    lagP.on = hwEnable && H.lagPump;
    const nRun = (leadP.on ? 1 : 0) + (lagP.on ? 1 : 0);
    const spdTarget = nRun ? clamp((100 * fReq) / (PUMP_FLOW * nRun), 30, 100) : 0;
    let flow = 0;
    for (const id of HW_PUMPS) {
      const p = P.pumps[id];
      p.speed = relax(p.speed, p.on ? spdTarget : 0, dt, 20);
      p.kw = 3.7 * Math.pow(p.speed / 100, 3);
      if (p.on && p.speed > 5) flow += (PUMP_FLOW * p.speed) / 100;
    }
    H.dp = relax(H.dp, flow > 0 ? (14 * flow * flow) / open : 0, dt, 10);
    const flowing = flow > 0.05;

    // steam valves, split range on HWS: feedforward on load + loss, plus P on the HWS error;
    // the demand opens at STEAM_RAMP; the 1/3 valve opens fully before the 2/3 valve moves,
    // and the 2/3 valve is held shut until the 1/3 valve's feedback proves it open
    const loss = (40 * (H.hws - 75)) / 85;
    const uReq = hwEnable ? clamp(((hwLoad + loss) / STEAM_CAP) * 100 + 6 * (P.hwsSp - H.hws), 0, 100) : 0;
    H.u = hwEnable ? Math.min(uReq, H.u + STEAM_RAMP * dt) : 0;
    H.cv1 = clamp(3 * H.u, 0, 100);
    H.cv1Fb = relax(H.cv1Fb, H.cv1, dt, 6);
    H.cv2 = H.cv1Fb >= 99 ? clamp(1.5 * (H.u - 100 / 3), 0, 100) : 0;
    H.cv2Fb = relax(H.cv2Fb, H.cv2, dt, 6);
    const qValves = STEAM_CAP * (H.cv1Fb / 300 + H.cv2Fb / 150);

    // exchangers: HX-1 always lead; HX-2 comes in on sustained steam demand above 85 % of
    // one exchanger and goes out once one exchanger carries the load at under 70 %
    if (!hwEnable) { H.lagHx = false; hwCtl.hxInT = 0; hwCtl.hxOutT = 0; }
    else if (!H.lagHx) {
      hwCtl.hxInT = qValves > 0.85 * HX_CAP ? hwCtl.hxInT + dt : 0;
      if (hwCtl.hxInT >= 300) { H.lagHx = true; hwCtl.hxInT = 0; hwCtl.hxOutT = 0; }
    } else {
      hwCtl.hxOutT = H.load < 0.7 * HX_CAP ? hwCtl.hxOutT + dt : 0;
      if (hwCtl.hxOutT >= 600) { H.lagHx = false; hwCtl.hxOutT = 0; }
    }
    let nIn = 0;
    for (let i = 0; i < 2; i++) {
      const x = H.hx[i], want = hwEnable && (i === 0 || H.lagHx);
      x.iso1 = relax(x.iso1, want ? 100 : 0, dt, 10);   // AO: the butterfly disc turns
      x.iso2 = want ? 1 : 0;                            // BO
      if (x.iso1 > 90 && x.iso2) nIn++;
    }

    // heat to the loop: what the steam valves pass, up to what the exchangers in service can move
    const qHx = HX_CAP * nIn * clamp(flow / 0.3, 0, 1);
    const qHw = Math.min(qValves, qHx);
    H.load = qHw;
    H.steam = (qHw * 1000) / 970;
    H.hws = clamp(H.hws + ((qHw - hwLoad - (flowing ? loss : loss * 0.5)) / 250) * (dt / 60), 60, 200);
    H.hwr = relax(H.hwr, flowing ? H.hws - clamp(3 + (25 * hwLoad) / 500, 2, 30) : H.hws - 1, dt, 60);
    P.hwLoad = hwLoad;

    // bypass: opens at low demand to keep minimum flow through the exchangers
    H.byp = hwEnable ? clamp(((0.4 - open) / 0.15) * 100, 0, 100) : 0;
    H.bypFb = relax(H.bypFb, H.byp, dt, 6);
    hwFlowing = flowing;
    reheatRise = hwFlowing ? 35 * clamp((H.hws - 85) / 70, 0, 1) : 0;

    // ---- energy
    const fansKw = A[0].s.kw + A[1].s.kw + 11 * Math.pow(T.fan / 100, 3);
    const pumpsKw = P.pumps['CHWP-1'].kw + P.pumps['CHWP-2'].kw + P.pumps['HWP-1'].kw + P.pumps['HWP-2'].kw + cwp.kw;
    // plug + base load: IT closets, lifts, exhaust, exit lighting, receptacles
    // (≈ 20 kW overnight for ~62,000 ft², rising with the people in it)
    const plugKw = 20 + 48 * state.occupancy;
    const kw = fansKw + chKw + pumpsKw + lightsKw + plugKw;
    const K = state.kwBreakdown;
    K.fans = fansKw; K.chillers = chKw; K.pumps = pumpsKw; K.lights = lightsKw; K.plug = plugKw;
    state.kw = kw;
    kwh += kw * dh;
    state.kwh = kwh;
    const hb = Math.min(23, Math.floor(hour));
    kwHist[hb] = relax(kwHist[hb], kw, dt, 600);
    const plantKw = chKw + P.pumps['CHWP-1'].kw + P.pumps['CHWP-2'].kw + cwp.kw + 11 * Math.pow(T.fan / 100, 3);
    state.cop = delivered > 1 && plantKw > 0.5 ? clamp((delivered * 3.517) / plantKw, 0, 12) : 0;

    // ---- alarms (debounced; consequential space alarms suppressed under a failed AHU)
    const armedT = t >= alarmHoldUntil;
    for (let i = 0; i < Z.length; i++) {
      const q = Z[i], z = q.s;
      const armed = armedT && occMode && !A[q.ahuIdx].failed;
      // alarm texts carry the live temperature (to 0.5 °F, so they change rarely)
      if (armed && z.temp > z.sp + 3) {
        q.hiT += dt;
        if (q.hiT >= 120 || alarmMap.has(q.hiId)) raise(q.hiId, 'medium', `${q.z.id} space temp high · ${half(z.temp)} °F (SP ${z.sp.toFixed(0)})`, q.z.id);
      } else {
        q.hiT = 0;
        if (!armed || z.temp < z.sp + 2) drop(q.hiId);
        else if (alarmMap.has(q.hiId)) raise(q.hiId, 'medium', `${q.z.id} space temp high · ${half(z.temp)} °F (SP ${z.sp.toFixed(0)})`, q.z.id);
      }
      if (armed && z.temp < z.sp - 3) {
        q.loT += dt;
        if (q.loT >= 120 || alarmMap.has(q.loId)) raise(q.loId, 'low', `${q.z.id} space temp low · ${half(z.temp)} °F (SP ${z.sp.toFixed(0)})`, q.z.id);
      } else {
        q.loT = 0;
        if (!armed || z.temp > z.sp - 2) drop(q.loId);
        else if (alarmMap.has(q.loId)) raise(q.loId, 'low', `${q.z.id} space temp low · ${half(z.temp)} °F (SP ${z.sp.toFixed(0)})`, q.z.id);
      }
      const a = z.stuck ? alarmMap.get(`vav-stuck:${q.z.vav}`) : null;
      const h = alarmMap.get(q.hiId) || alarmMap.get(q.loId);
      z.alarm = h ? h.text : a ? a.text : null;
      const hi = occMode ? z.sp + 1.5 : 85, lo = occMode ? z.sp - 1.5 : 60;
      z.status = z.alarm ? 'alarm' : z.temp > hi ? 'warm' : z.temp < lo ? 'cool' : 'ok';
    }
    for (let ai = 0; ai < A.length; ai++) {
      const a = A[ai], s = a.s;
      if (s.on && a.runT > 900 && s.sat > s.satSp + 4) {
        a.satHiT += dt;
        if (a.satHiT >= 300 || alarmMap.has(a.satHiId)) raise(a.satHiId, 'medium', `${a.id} supply air temp high · ${half(s.sat)} °F`, a.id);
      } else {
        a.satHiT = 0;
        if (!s.on || s.sat < s.satSp + 2.5) drop(a.satHiId);
        else if (alarmMap.has(a.satHiId)) raise(a.satHiId, 'medium', `${a.id} supply air temp high · ${half(s.sat)} °F`, a.id);
      }
      s.alarm = a.failed ? 'Supply fan failure' : alarmMap.has(a.satHiId) ? 'Supply air temp high' : null;
    }
    if (plantCtl.enabled && plantCtl.runT > 600 && P.chws > P.chwsSp + 5) {
      plantCtl.chwsHiT += dt;
      if (plantCtl.chwsHiT >= 60 || alarmMap.has('chws-high')) raise('chws-high', 'medium', `CHW supply high · ${half(P.chws)} °F (SP ${P.chwsSp.toFixed(0)})`, C[leadIdx].id);
    } else {
      plantCtl.chwsHiT = 0;
      if (!plantCtl.enabled || P.chws < P.chwsSp + 3) drop('chws-high');
      else if (alarmMap.has('chws-high')) raise('chws-high', 'medium', `CHW supply high · ${half(P.chws)} °F (SP ${P.chwsSp.toFixed(0)})`, C[leadIdx].id);
    }
    for (let i = 0; i < 2; i++) C[i].s.alarm = C[i].tripped ? 'Tripped · compressor fault' : null;
    // HW supply low: armed after the mode-change hold and 30 min of plant run (the morning pull-up)
    const hwText = () => `HW supply low · ${half(H.hws)} °F (SP ${P.hwsSp.toFixed(0)})`;
    if (hwEnable && armedT && hwCtl.runT > 1800 && H.hws < P.hwsSp - 15) {
      hwCtl.lowT += dt;
      if (hwCtl.lowT >= 600 || alarmMap.has('hws-low')) raise('hws-low', 'medium', hwText(), 'HHW-1');
    } else {
      hwCtl.lowT = 0;
      if (!hwEnable || H.hws > P.hwsSp - 10) drop('hws-low');
      else if (alarmMap.has('hws-low')) raise('hws-low', 'medium', hwText(), 'HHW-1');
    }
    H.tempAlarm = alarmMap.has('hws-low');
  }

  // ---------- run flow intensity (0..1) for the 3D flow animation
  const FLOW = layout.runs.map((r) => {
    let type = 0, ref = null;
    const zs = state.zones[r.serves], ah = state.ahus[r.serves], ch = P.chillers[r.serves];
    if (r.kind === 'sa') { if (zs) { type = 1; ref = zs; } else { type = 2; ref = ah; } }
    else if (r.kind === 'ra') { type = 3; ref = ah; }
    else if (r.kind === 'chws' || r.kind === 'chwr') {
      if (ah) { type = 4; ref = ah; } else if (ch) { type = 5; ref = P.pumps[r.serves === 'CH-1' ? 'CHWP-1' : 'CHWP-2']; } else type = 6;
    } else if (r.kind === 'hws' || r.kind === 'hwr') {
      if (zs) { type = 7; ref = zs; } else if (ah) { type = 8; ref = ah; } else type = 9;
    } else if (ch) { type = 10; ref = ch; } else type = 11;
    return { id: r.id, type, ref };
  });
  const flowIdx = new Map(FLOW.map((f, i) => [f.id, i]));
  // fastest proven HW pump
  function hwPumpSpeed() {
    let v = 0;
    for (const id of HW_PUMPS) { const p = P.pumps[id]; if (p.on && p.speed > 5 && p.speed > v) v = p.speed; }
    return v;
  }
  function flowVal(f) {
    const r = f.ref;
    switch (f.type) {
      case 1: return r.cfm > 1 ? clamp(0.25 + (0.75 * r.cfm) / r.cfmMax, 0, 1) : 0;
      case 2: return r.on ? clamp(r.sfSpeed / 100, 0, 1) : 0;
      case 3: return r.on ? clamp(r.rfSpeed / 100, 0, 1) : 0;
      case 4: return chwFlowing && r.on && r.ccv > 1 ? clamp(0.25 + (0.75 * r.ccv) / 100, 0, 1) : 0;
      case 5: return r.on ? clamp(r.speed / 100, 0, 1) : 0;
      case 6: return chwFlowing ? clamp(Math.max(P.pumps['CHWP-1'].speed, P.pumps['CHWP-2'].speed) / 100, 0, 1) : 0;
      case 7: return hwFlowing && r.reheat > 1 ? clamp(0.25 + (0.75 * r.reheat) / 100, 0, 1) : 0;
      case 8: return hwFlowing && r.on && r.hcv > 1 ? clamp(0.25 + (0.75 * r.hcv) / 100, 0, 1) : 0;
      case 9: return hwFlowing ? clamp(hwPumpSpeed() / 100, 0, 1) : 0;
      case 10: return r.status === 'running' && P.pumps['CWP-1'].on ? clamp(P.pumps['CWP-1'].speed / 100, 0, 1) : 0;
      default: return P.pumps['CWP-1'].on ? clamp(P.pumps['CWP-1'].speed / 100, 0, 1) : 0;
    }
  }
  function flowOf(runOrId) {
    const id = typeof runOrId === 'string' ? runOrId : runOrId && runOrId.id;
    const i = flowIdx.get(id);
    return i === undefined ? 0 : flowVal(FLOW[i]);
  }

  const SEV = { high: 0, medium: 1, low: 2 };
  function finalize() {
    state.time = t;
    state.timeLabel = label();
    state.sunDir[0] = sun.dx; state.sunDir[1] = sun.dy; state.sunDir[2] = sun.dz;
    for (let i = 0; i < FLOW.length; i++) state.flows[FLOW[i].id] = flowVal(FLOW[i]);
    if (alarmsDirty) {
      alarmsDirty = false;
      const list = [...alarmMap.values()].sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.since - a.since);
      state.alarms.length = 0;
      for (const a of list) state.alarms.push(a);
      state.alarmsVersion++;
    }
  }

  // ---------- faults
  function injectFault(kind) {
    if (!FAULT_KINDS.includes(kind)) return null;
    let a;
    if (kind === 'vav-stuck') {
      let q = faults.stuckZone;
      if (!q) {
        let bestG = -Infinity;
        if (state.daylight > 0.15) {
          for (const c of Z) {
            if (c.floorIdx !== 2) continue; // pick on L3
            const g = 3.6 * c.s.solar + c.kEnv * (state.oat - c.s.temp);
            if (g > bestG) { bestG = g; q = c; }
          }
        }
        if (!q) q = Z.find((c) => c.z.id === 'L3-07');
        faults.stuckZone = q;
        q.s.stuck = true;
        q.s.damper = 0;
      }
      // the alarm list already names the zone next to this text
      a = raise(`vav-stuck:${q.z.vav}`, 'medium', `${q.z.vav} damper not responding · stuck closed`, q.z.id);
    } else if (kind === 'chiller-trip') {
      // only claim CH-2 is carrying load if the plant is actually running
      const running = plantCtl.enabled && C[0].s.on;
      C[0].tripped = true;
      // the trip is immediate: the card must not read "Running" until the next step
      C[0].s.status = 'tripped';
      C[0].s.on = false;
      C[0].s.load = 0;
      C[0].limit = 0;
      plantCtl.lagWanted = true;
      a = raise('chiller-trip:CH-1', 'high', running ? 'CH-1 tripped · compressor fault — CH-2 taking the load' : 'CH-1 locked out · compressor fault — CH-2 now lead', 'CH-1');
    } else if (kind === 'fan-fail') {
      // a proof-of-flow failure needs a start command; otherwise the fan is locked out
      const commanded = A[1].s.cmd;
      A[1].failed = true;
      A[1].s.on = false;
      a = raise('fan-fail:AHU-2', 'high', commanded ? 'AHU-2 supply fan failure · L4–L6 airflow lost' : 'AHU-2 supply fan locked out · will not start at next occupancy', 'AHU-2');
    } else {
      faults.hotDay = true;
      a = raise('hot-day:OAT', 'low', 'Heat wave · outside air 12 °F above normal', 'CT-1');
    }
    if (!state.faults.includes(kind)) state.faults.push(kind);
    finalize();
    return { alarmId: a.id, target: a.target, text: a.text };
  }

  function clearFaults() {
    if (faults.stuckZone) { faults.stuckZone.s.stuck = false; faults.stuckZone = null; }
    if (C[0].tripped) { C[0].tripped = false; C[0].s.status = 'off'; if (C[1].s.on) plantCtl.lagWanted = true; }
    if (A[1].failed) { A[1].failed = false; alarmHoldUntil = Math.max(alarmHoldUntil, t + 1800); }
    faults.hotDay = false;
    for (const id of [...alarmMap.keys()]) if (/^(vav-stuck|chiller-trip|fan-fail|hot-day):/.test(id)) drop(id);
    state.faults.length = 0;
    finalize();
  }

  // ---------- time control
  function setHour(h) {
    let hh = fin(Number(h), state.hour);
    hh = ((hh % 24) + 24) % 24;
    const target = Math.floor(clk / 24) * 24 + hh;
    clk = target - 0.5;
    curDayAbs = Math.floor(clk / 24);
    const hs = clk - curDayAbs * 24, hi = Math.min(23, Math.floor(hs));
    let e = 0;
    for (let i = 0; i < hi; i++) e += kwHist[i];
    kwh = e + (hs - hi) * kwHist[hi];
    alarmHoldUntil = Math.max(alarmHoldUntil, t + 1800 + ALARM_HOLD);
    relaxBoost = 3;
    for (let i = 0; i < 60; i++) sub(30);
    relaxBoost = 1;
    clk = target;
    const d = Math.floor(clk / 24);
    if (d !== curDayAbs) { curDayAbs = d; kwh = 0; }
    state.hour = clk - d * 24;
    state.day = ((d % 7) + 7) % 7;
    state.kwh = kwh;
    finalize();
    return state;
  }

  function step(dtReal) {
    let dtr = Number(dtReal);
    if (!(dtr > 0)) return state;
    if (dtr > 1) dtr = 1; // a stalled tab must not fast-forward the building
    const spd = clamp(fin(Number(sim.speed), 60), 0, 3600);
    const simDt = dtr * spd;
    if (!(simDt > 0)) return state;
    let n = Math.ceil(simDt / SUB_DT);
    if (n > MAX_SUB) n = MAX_SUB;
    const d = simDt / n;
    for (let i = 0; i < n; i++) sub(d);
    finalize();
    return state;
  }

  // ---------- describe(): info-card content, values pre-formatted
  const f0 = (v) => fin(v).toFixed(0), f1 = (v) => fin(v).toFixed(1), f2 = (v) => fin(v).toFixed(2);
  const commas = (v) => String(Math.round(fin(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const row = (label, value, unit, status) => {
    const r = [label, String(value)];
    if (unit !== undefined || status !== undefined) r.push(unit || '');
    if (status !== undefined) r.push(status);
    return r;
  };
  const zIdx = new Map(Z.map((q, i) => [q.z.id, i]));
  function tempStatus(z) {
    if (z.alarm && !z.stuck) return 'alarm';
    if (!state.occupiedMode) return z.temp > 85 || z.temp < 60 ? 'warn' : 'ok';
    const d = Math.abs(z.temp - z.sp);
    return d > 3 ? 'alarm' : d > 1.5 ? 'warn' : 'ok';
  }
  const spText = (z) => (state.occupiedMode ? f1(z.sp) : '60 – 85');

  function describeZone(id) {
    const z = state.zones[id], L = zoneById.get(id), a = state.ahus[L.ahu];
    const rows = [
      row('Space temp', f1(z.temp), '°F', tempStatus(z)),
      row('Setpoint', spText(z), '°F'),
      row('Mode', state.occupiedMode ? 'Occupied' : 'Unoccupied · setback'),
      row('Occupancy', f0(z.occ * 100), '%'),
      row('Supply airflow', `${commas(z.cfm)} / ${commas(z.cfmMax)}`, 'cfm', a.alarm === 'Supply fan failure' ? 'alarm' : undefined),
      row('VAV damper', z.stuck ? `${f0(z.damper)} · cmd ${f0(z.damperCmd)}` : f0(z.damper), '%', z.stuck ? 'alarm' : 'ok'),
      row('Reheat valve', f0(z.reheat), '%'),
      row('Discharge air', f1(z.dat), '°F'),
      row('Lights', z.lights ? 'On' : 'Off'),
      row('Sun on glass', f0(z.solar * 800), 'W/m²'),
      row('Served by', `${L.vav} · ${L.ahu}`),
    ];
    if (z.alarm) rows.push(row('Alarm', z.alarm, '', 'alarm'));
    return { id, kind: 'zone', title: L.name, subtitle: `${id} · Level ${L.floor} · ${EXPOSURE_LONG[L.exposure]} exposure`, status: z.status, rows };
  }

  function describeVav(vid) {
    const v = vavById.get(vid), L = zoneById.get(v.zone), z = state.zones[v.zone], a = state.ahus[v.ahu];
    const minF = state.occupiedMode ? MIN_FLOW : 0;
    const rows = [
      row('Airflow', commas(z.cfm), 'cfm', z.stuck || a.alarm === 'Supply fan failure' ? 'alarm' : 'ok'),
      row('Flow setpoint', commas(z.flowSp * z.cfmMax), 'cfm'),
      row('Max / min flow', `${commas(z.cfmMax)} / ${commas(z.cfmMax * minF)}`, 'cfm'),
      row('Damper', z.stuck ? `${f0(z.damper)} · cmd ${f0(z.damperCmd)}` : f0(z.damper), '%', z.stuck ? 'alarm' : 'ok'),
      row('Reheat valve', f0(z.reheat), '%'),
      row('Discharge air', f1(z.dat), '°F'),
      row('Zone temp / SP', `${f1(z.temp)} / ${spText(z)}`, '°F', tempStatus(z)),
      row('Inlet static', f2(a.on ? a.ssp * 0.55 : 0), 'in.WC'),
      row('Controller', 'DXR2 · BACnet/IP'),
      row('Air handler', v.ahu),
    ];
    if (z.stuck) rows.push(row('Alarm', 'Damper not responding · stuck closed', '', 'alarm'));
    return { id: vid, kind: 'vav', title: vid, subtitle: `VAV box · HW reheat · serves ${L.name}`, status: z.stuck ? 'alarm' : z.status, rows };
  }

  function describeAhu(e) {
    const a = state.ahus[e.id], ai = A.findIndex((x) => x.id === e.id);
    const failed = A[ai].failed;
    const satSt = !a.on ? undefined : a.sat > a.satSp + 4 ? 'alarm' : a.sat > a.satSp + 2 ? 'warn' : 'ok';
    const rows = [
      row('Status', failed ? (a.cmd ? 'FAILED · no fan status' : 'Locked out · fan fault') : a.on ? 'Running' : a.cmd ? 'Starting' : 'Off · unoccupied', '', failed ? 'alarm' : a.on ? 'ok' : undefined),
      row('Supply fan', f0(a.sfSpeed), '%'),
      row('Return fan', f0(a.rfSpeed), '%'),
      row('Supply air / SP', `${f1(a.sat)} / ${f1(a.satSp)}`, '°F', satSt),
      row('Mixed air', f1(a.mat), '°F'),
      row('Return air', f1(a.rat), '°F'),
      row('Outside air damper', f0(a.oad), '%'),
      row('Return / relief dampers', `${f0(a.rad)} / ${f0(a.ead)}`, '%'),
      row('Economizer', a.econ ? 'Active · free cooling' : !a.on ? 'Off' : state.oat >= 65 ? 'Locked out · OAT high' : 'Minimum OA'),
      row('CHW valve', f0(a.ccv), '%'),
      row('HW valve', f0(a.hcv), '%'),
      row('Duct static / SP', `${f2(a.ssp)} / ${f2(a.sspSp)}`, 'in.WC'),
      row('Filter dP (pre / final)', `${f2(a.pfDp)} / ${f2(a.ffDp)}`, 'in.WC', a.pfDp > 1.5 || a.ffDp > 1.5 ? 'warn' : undefined),
      row('Airflow', commas(a.cfm), 'cfm'),
      row('Coil load', f1(a.coilTons), 'tons'),
      row('Fan power', f1(a.kw), 'kW'),
    ];
    if (a.alarm) rows.push(row('Alarm', a.alarm, '', 'alarm'));
    const floors = e.serves;
    return {
      id: e.id, kind: 'ahu', title: `${e.id} · Air handler`,
      subtitle: `Roof · serves ${floors[0]}–${floors[floors.length - 1]} · ${A[ai].zs.length} VAVs · ${commas(A[ai].design)} cfm`,
      status: failed || a.alarm ? 'alarm' : a.on ? 'ok' : 'off', rows,
    };
  }

  function describeChiller(e) {
    const c = P.chillers[e.id];
    const pid = e.id === 'CH-1' ? 'CHWP-1' : 'CHWP-2', pmp = P.pumps[pid];
    const st = { running: 'Running', starting: 'Starting · 2 min delay', off: 'Off · standby', tripped: 'TRIPPED' }[c.status];
    const rows = [
      row('Status', st, '', c.status === 'tripped' ? 'alarm' : c.on ? 'ok' : undefined),
      row('Load', f0(c.load), '%'),
      row('Cooling', f1(c.tons), 'tons'),
      row('CHW supply / SP', `${f1(c.chws)} / ${f1(P.chwsSp)}`, '°F', c.on && c.chws > P.chwsSp + 3 ? 'warn' : undefined),
      row('CHW return', f1(c.chwr), '°F'),
      row('CHW pump', pmp.on ? `${pid} · ${f0(pmp.speed)}` : `${pid} · off`, pmp.on ? '%' : ''),
      row('Power', f1(c.kw), 'kW'),
      row('Efficiency', c.kwPerTon > 0 ? f2(c.kwPerTon) : '—', 'kW/ton'),
      row('Condenser water in', f1(P.tower.cws), '°F'),
      row('Condenser water out', f1(c.cwl), '°F'),
      row('Staging', c.lead ? 'Lead' : 'Lag'),
    ];
    if (c.alarm) rows.push(row('Alarm', c.alarm, '', 'alarm'));
    return { id: e.id, kind: 'chiller', title: `${e.id} · Water-cooled chiller`, subtitle: `B1 · ${CH_CAP} ton centrifugal · ${c.lead ? 'lead' : 'lag'}`, status: c.status === 'tripped' ? 'alarm' : c.on ? 'ok' : 'off', rows };
  }

  function describeHhw(e) {
    const H = P.hhw;
    const heating = H.enabled && H.load > 5;
    const inService = H.hx.map((x, i) => (x.iso1 > 90 && x.iso2 ? `HX-${i + 1}` : null)).filter(Boolean);
    const pumpText = HW_PUMPS.map((id) => {
      const p = P.pumps[id], role = id === H.leadPump ? 'lead' : 'lag';
      return p.on ? `${id} ${role} ${f0(p.speed)} %` : `${id} off`;
    }).join(' · ');
    const rows = [
      row('Status', heating ? 'Heating' : H.enabled ? 'Enabled · idle' : 'Off', '', H.tempAlarm ? 'alarm' : H.enabled ? 'ok' : undefined),
      row('HW supply / SP', `${f1(H.hws)} / ${f1(P.hwsSp)}`, '°F', H.enabled && H.hws < P.hwsSp - 15 ? 'warn' : undefined),
      row('HW return', f1(H.hwr), '°F'),
      row('Steam valves 1/3 · 2/3', `${f0(H.cv1Fb)} · ${f0(H.cv2Fb)}`, '%'),
      row('Exchangers in service', inService.length ? inService.join(' + ') : 'None'),
      row('Pumps', pumpText),
      row('Loop dP / SP', `${f1(H.dp)} / ${f1(H.dpSp)}`, 'psi', H.enabled && H.dp < H.dpSp - 2 ? 'warn' : undefined),
      row('Bypass valve', f0(H.bypFb), '%'),
      row('Heat to loop', f0(H.load), 'MBH'),
      row('Steam', commas(H.steam), 'lb/h'),
      row('OA reset', `${f0(state.oat)} °F OAT → ${f0(P.hwsSp)} °F HWS`),
    ];
    const al = alarmMap.get('hws-low');
    if (al) rows.push(row('Alarm', al.text, '', 'alarm'));
    return {
      id: e.id, kind: 'hw plant', title: `${e.id} · Heating hot water plant`,
      subtitle: 'B1 · steam to hot water · 2 shell-and-tube HXs · 1/3 + 2/3 steam valves',
      status: H.tempAlarm ? 'alarm' : H.enabled ? 'ok' : 'off', rows,
    };
  }

  const PUMP_DUTY = {
    'CHWP-1': "Chilled water · on CH-1's pump skid", 'CHWP-2': "Chilled water · on CH-2's pump skid",
    'HWP-1': 'Heating hot water · lead/lag on loop dP', 'HWP-2': 'Heating hot water · lead/lag on loop dP',
    'CWP-1': 'Condenser water · tower ↔ chillers',
  };
  function describePump(e) {
    const p = P.pumps[e.id];
    const hw = HW_PUMPS.includes(e.id);
    const H = P.hhw;
    const rows = [
      row('Status', p.on ? 'Running' : hw && H.enabled ? 'Off · standby' : 'Off', '', p.on ? 'ok' : undefined),
      row('VFD speed', f0(p.speed), '%'),
      row('Power', f1(p.kw), 'kW'),
    ];
    if (hw) {
      const lead = e.id === H.leadPump;
      rows.push(row('Staging', lead ? 'Lead · alternates daily' : H.lagPump ? 'Lag · running on loop dP' : 'Lag · starts on loop dP'));
      rows.push(row('Loop dP / SP', `${f1(H.dp)} / ${f1(H.dpSp)}`, 'psi'));
    }
    rows.push(row('Serves', e.serves.join(', ')));
    return { id: e.id, kind: 'pump', title: `${e.id} · Pump`, subtitle: `B1 · ${PUMP_DUTY[e.id]}`, status: p.on ? 'ok' : 'off', rows };
  }

  function describeTower(e) {
    const T = P.tower;
    const rows = [
      row('Status', T.on ? 'Running' : 'Off', '', T.on ? 'ok' : undefined),
      row('Fan speed', f0(T.fan), '%'),
      row('Leaving water / SP', `${f1(T.cws)} / ${f1(P.cwsSp)}`, '°F', T.on && T.cws > P.cwsSp + 4 ? 'warn' : undefined),
      row('Entering water', f1(T.cwr), '°F'),
      row('Wet bulb', f1(state.wetBulb), '°F'),
      row('Approach', f1(T.cws - state.wetBulb), '°F'),
      row('Heat rejected', f0(T.heat), 'tons'),
      row('Outside air', `${f1(state.oat)} °F · ${f0(state.oah)} %RH`),
    ];
    return { id: e.id, kind: 'tower', title: `${e.id} · Cooling tower`, subtitle: 'Roof · induced draft · condenser water', status: T.on ? 'ok' : 'off', rows };
  }

  function describeLevel(id) {
    const lv = levelById.get(id);
    if (lv.kind !== 'office') {
      const eqs = layout.equipment.filter((e) => e.level === id);
      const rows = eqs.map((e) => {
        const d = describe(e.id);
        return row(e.id, d.rows[0][1], '', d.rows[0][3]);
      });
      return { id, kind: 'level', title: lv.name, subtitle: `${eqs.length} pieces of equipment`, status: 'ok', rows };
    }
    const zs = Z.filter((q) => q.z.level === id);
    let tSum = 0, oSum = 0, lit = 0, cfm = 0, al = 0;
    for (const q of zs) { tSum += q.s.temp; oSum += q.s.occ; if (q.s.lights) lit++; cfm += q.s.cfm; if (q.s.alarm) al++; }
    const ahu = zs[0].z.ahu;
    const rows = [
      row('Average temp', f1(tSum / zs.length), '°F'),
      row('Occupancy', f0((oSum / zs.length) * 100), '%'),
      row('Zones lit', `${lit} / ${zs.length}`),
      row('Supply airflow', commas(cfm), 'cfm'),
      row('Zones in alarm', String(al), '', al ? 'alarm' : 'ok'),
      row('Air handler', ahu),
    ];
    return { id, kind: 'level', title: lv.name, subtitle: `${zs.length} VAV zones · ${ahu}`, status: al ? 'alarm' : 'ok', rows };
  }

  function describeBuilding() {
    const rows = [
      row('Outside air', `${f1(state.oat)} °F · ${f0(state.oah)} %RH`),
      row('Building power', f0(state.kw), 'kW'),
      row('Energy today', commas(state.kwh), 'kWh'),
      row('Plant COP', state.cop > 0 ? f1(state.cop) : '—'),
      row('Occupancy', f0(state.occupancy * 100), '%'),
      row('CHW supply', f1(P.chws), '°F'),
      row('HW supply', f1(P.hhw.hws), '°F'),
      row('Active alarms', String(state.alarms.length), '', state.alarms.length ? 'alarm' : 'ok'),
    ];
    return { id: 'building', kind: 'building', title: 'Office tower · digital twin', subtitle: `Simulated building · ${state.timeLabel}`, status: state.alarms.length ? 'alarm' : 'ok', rows };
  }

  const KIND_NAME = { sa: 'Supply air', ra: 'Return air', chws: 'Chilled water supply', chwr: 'Chilled water return', hws: 'Hot water supply', hwr: 'Hot water return', cws: 'Condenser water supply', cwr: 'Condenser water return' };
  function describeRun(id) {
    const r = runById.get(id), fl = flowOf(id);
    const rows = [row('Flow', fl > 0 ? `${f0(fl * 100)}` : 'No flow', fl > 0 ? '%' : '', fl > 0 ? 'ok' : undefined), row('From', String(r.from)), row('To', String(r.to))];
    return { id, kind: 'run', title: KIND_NAME[r.kind], subtitle: `${id}${r.level ? ` · ${r.level}` : ' · riser'}`, status: fl > 0 ? 'ok' : 'off', rows };
  }

  function describeRaw(id) {
    if (zIdx.has(id)) return describeZone(id);
    if (vavById.has(id)) return describeVav(id);
    const e = eqById.get(id);
    if (e) {
      if (e.kind === 'ahu') return describeAhu(e);
      if (e.kind === 'chiller') return describeChiller(e);
      if (e.kind === 'hhw') return describeHhw(e);
      if (e.kind === 'pump') return describePump(e);
      return describeTower(e);
    }
    if (levelById.has(id)) return describeLevel(id);
    if (id === 'building') return describeBuilding();
    if (runById.has(id)) return describeRun(id);
    return null;
  }

  // The card's chip is never calmer than its worst row, or than an active alarm
  // on this id (or on the zone ↔ VAV pair it belongs to).
  const RANK = { alarm: 3, warn: 2, warm: 2, cool: 2 };
  function describe(id) {
    if (typeof id !== 'string') return null;
    let d;
    try {
      d = describeRaw(id);
    } catch (err) {
      return { id, kind: 'unknown', title: id, subtitle: 'Unavailable', status: 'off', rows: [] };
    }
    if (!d || d.kind === 'level' || d.kind === 'building') return d;
    const related = new Set([id]);
    const zone = zoneById.get(id);
    if (zone) related.add(zone.vav);
    const vav = vavById.get(id);
    if (vav) related.add(vav.zone);
    let worst = RANK[d.status] || 0;
    let worstName = d.status;
    for (const r of d.rows) {
      const st = r[3];
      if ((RANK[st] || 0) > worst) { worst = RANK[st]; worstName = st === 'alarm' ? 'alarm' : 'warn'; }
    }
    if (worst < 3) for (const a of state.alarms) if (related.has(a.target)) { worst = 3; worstName = 'alarm'; break; }
    if (worstName !== d.status) d.status = worstName;
    return d;
  }

  const sim = {
    layout, state, speed: 60, seed,
    step, setHour, injectFault, clearFaults, describe, flowOf,
    faultKinds: FAULT_KINDS.slice(),
  };

  // ---------- pre-roll from Mon 23:00 to Tue startHour so the first frame is a settled building
  for (let i = 0; i < 24; i++) kwHist[i] = i >= 6 && i < 19 ? 200 : 60;
  const sh = ((fin(Number(startHour), 9.5) % 24) + 24) % 24;
  clk = 23; curDayAbs = 0;
  const preH = sh + 1, nPre = Math.max(1, Math.ceil(preH * 60));
  for (let i = 0; i < nPre; i++) sub((preH * 3600) / nPre);
  clk = 24 + sh;
  state.hour = sh; state.day = 1;
  finalize();
  return sim;
}

export const TWIN_FAULTS = FAULT_KINDS;
