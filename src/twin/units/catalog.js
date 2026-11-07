/**
 * Digital Twin units — the catalogue (pure: no three, no DOM).
 *
 * One entry per ClarityView model the twin places: which view class draws it,
 * its config (a ClarityView default, trimmed to what the sim models), where it
 * sits, which sub-parts are picked on their own, and the binding table from
 * ClarityView point suffixes to the sim's state.
 *
 *   UNITS                 the seven model units, in build order
 *   VAV                   the one VAV terminal every zone's box is baked from
 *   accessFor(unit, ref)  { has, resolve } for embed(): ref.state is sim.state
 *
 * Binding contract: has(sfx) is the config's suffix map (geometry follows the
 * config, exactly as ClarityView's own bridge does) plus the two documented
 * role aliases; resolve(sfx) gives { value, status: 'normal' } for a bound
 * suffix with a finite value, { value: null, status: 'unbound' } for a
 * configured suffix the sim does not model (it drives no motion), and null for
 * anything else. The demo is labelled a simulation; it has no stale state.
 */
import { DEFAULT_AHU, DEFAULT_TOWER, DEFAULT_CHILLER_WC, DEFAULT_BOOSTER } from '../../clarityview/ahu/equipment-defaults.js';
import { hhwConfig } from '../../clarityview/ahu/hx/hhw.js';
import { vavConfig } from '../../clarityview/ahu/vav/vav-config.js';
import { suffixMap } from '../../clarityview/ahu/ahu3d-bridge.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const b01 = (v) => (v ? 1 : 0);

/* ── configs (built once) ────────────────────────────────────────── */

function ahuConfig(hand) {
  const c = clone(DEFAULT_AHU);
  c.supply = c.supply.filter((s) => s.device !== 'humidifier');
  c.sensors = c.sensors.filter((s) => ['OAT', 'MAT', 'SAT', 'RAT'].includes(s.tag));
  c.airStations = c.airStations.filter((s) => s.tag === 'OACFM' || s.tag === 'SACFM');
  const rf = c.return.find((s) => s.device === 'fan');
  rf.fans = [1, 2].map((n) => ({ cmd: `RF${n}_SS`, status: `RF${n}_STS`, speed: `RF${n}_SVD`, fault: `RF${n}_FLT` }));
  c.layout3d = { hand };
  return c;
}
function towerConfig() {
  const c = clone(DEFAULT_TOWER);
  const t = c.supply.find((s) => s.device === 'tower');
  t.cells = 1;
  t.fans = t.fans.slice(0, 1);
  for (const k of ['bypassPoint', 'heaterPoint', 'makeupPoint', 'vibPoint']) delete t[k];
  c.sensors = c.sensors.filter((s) => s.tag !== 'BSN_T');
  return c;
}
function chillerConfig() {
  const c = clone(DEFAULT_CHILLER_WC);
  // the condenser pump is the shared CWP-1: drawing one per chiller would show a pump that isn't there
  delete c.supply.find((s) => s.device === 'chiller').condPumpPoint;
  return c;
}
function cwpConfig() {
  const c = clone(DEFAULT_BOOSTER);
  const b = c.supply.find((s) => s.device === 'booster');
  b.pumps = b.pumps.slice(0, 1);
  c.service = 'Condenser Water Pump';
  c.sensors = [];
  return c;
}
const HHW_CONFIG = hhwConfig({ exchangers: 2, pumps: 2, valves: 'split', bypass: true, pumpProof: true, program: false }, { tag: 'HHW' });

/**
 * A small air handler built off-scene before AHU-1 (units/index.js warmUp): it takes the
 * one-time cost of ClarityView's builders and Siemens device geometry out of AHU-1's task.
 */
export const WARM = (() => {
  const c = clone(DEFAULT_AHU);
  const keep = ['OA Damper', 'Pre-Filter', 'Cooling Coil', 'Supply Fans', 'Discharge'];
  c.supply = c.supply.filter((s) => keep.includes(s.label));
  const fan = c.supply.find((s) => s.device === 'fan');
  fan.count = 1;
  fan.fans = fan.fans.slice(0, 1);
  delete c.return;
  c.sensors = c.sensors.filter((s) => s.tag === 'SAT');
  c.airStations = [];
  return { id: '__warm', config: c };
})();

/** The VAV terminal: ClarityView's 12" single-duct box with HW reheat on a DXR2. */
export const VAV = { config: vavConfig('single-duct', { reheat: 'hw', size: '12', hand: 'R', family: 'dxr2' }), kind: 'vav' };

/* ── sim state accessors ─────────────────────────────────────────── */

const P = (s) => s.plant;
const pump = (s, id) => s.plant.pumps[id];
const proven = (p) => (p ? b01(p.on && p.speed > 5) : NaN);

// INTERIM (builder 2 replaces the boiler with the steam-to-HW plant model, P.hhw):
// until the sim has P.hhw, the plant reads today's hot-water state: the boiler's
// firing rate stands in for the steam valve demand (split 1/3 then 2/3), HX-1 is
// in service while the loop is enabled, HWP-1 is plant pump P-1 and P-2 (no
// HWP-2 yet) reads unbound, so it never turns.
function interimHhw(s) {
  const B = s.plant.boiler || {};
  const hwp = s.plant.pumps['HWP-1'] || {};
  const en = !!hwp.on;
  const u = B.on ? clamp(B.fire || 0, 0, 100) : 0;
  const cv1 = clamp(3 * u, 0, 100);
  const cv2 = clamp(1.5 * (u - 33.33), 0, 100);
  return {
    enabled: en, hws: B.hws, hwr: B.hwr, dp: NaN, dpSp: NaN, tempAlarm: false,
    cv1, cv1Fb: cv1, cv2, cv2Fb: cv2, byp: 0, bypFb: 0,
    hx: [{ iso1: en ? 100 : 0, iso2: b01(en) }, { iso1: 0, iso2: 0 }],
  };
}
const HHW = (s) => s.plant.hhw || interimHhw(s);

/* ── binding tables (design §3) ──────────────────────────────────── */

function ahuBindings(id) {
  const A = (s) => s.ahus[id];
  const running = (a) => !!a.on;
  const q2 = (a) => {
    const d = a.cfmDesign > 0 ? a.cfm / a.cfmDesign : 0;
    return d * d;
  };
  // new sim fields (rad, ead, pfDp, ffDp, sfFault) are read when present, else derived the same way
  const pf = (a) => a.pfDp ?? 0.35 * q2(a);
  const ff = (a) => a.ffDp ?? 0.55 * q2(a);
  const sfFlt = (a) => b01(a.sfFault ?? a.alarm === 'Supply fan failure');
  const b = {
    OAD: (s) => A(s).oad,
    RAD: (s) => A(s).rad ?? 100 - A(s).oad,
    EAD: (s) => A(s).ead ?? (running(A(s)) ? clamp((A(s).oad - 20) / 0.8, 0, 100) : 0),
    PFIL: (s) => pf(A(s)),
    'PFIL.ALM': (s) => b01(pf(A(s)) > 1.5),
    FFIL: (s) => ff(A(s)),
    'FFIL.ALM': (s) => b01(ff(A(s)) > 1.5),
    PHV: (s) => A(s).hcv,
    CCV: (s) => A(s).ccv,
    'SAT.SP': (s) => A(s).satSp,
    OAT: (s) => s.oat,
    MAT: (s) => A(s).mat,
    SAT: (s) => A(s).sat,
    RAT: (s) => A(s).rat,
    SSP: (s) => A(s).ssp,
    'SA.CFM': (s) => A(s).cfm,
    'OA.CFM': (s) => (A(s).cfm * A(s).oad) / 100,
  };
  for (const n of [1, 2]) {
    b[`SF${n}.SS`] = (s) => b01(A(s).cmd);
    b[`SF${n}.STS`] = (s) => b01(A(s).on && A(s).sfSpeed > 5);
    b[`SF${n}.SVD`] = (s) => A(s).sfSpeed;
    b[`SF${n}.FLT`] = (s) => sfFlt(A(s));
    b[`RF${n}.SS`] = (s) => b01(A(s).cmd);
    b[`RF${n}.STS`] = (s) => b01(A(s).on && A(s).rfSpeed > 5);
    b[`RF${n}.SVD`] = (s) => A(s).rfSpeed;
  }
  return b;
}

const TOWER_BINDINGS = {
  'CTF1.SS': (s) => b01(P(s).tower.on),
  'CTF1.STS': (s) => b01(P(s).tower.on && P(s).tower.fan > 2),
  'CTF1.SVD': (s) => P(s).tower.fan,
  'CT.CWR': (s) => P(s).tower.cwr,
  'CT.CWS': (s) => P(s).tower.cws,
  'CT.SP': (s) => P(s).cwsSp,
  'CT.WB': (s) => s.wetBulb,
};

function chillerBindings(id, pumpId) {
  const C = (s) => P(s).chillers[id];
  const run = (c) => c.status === 'running';
  return {
    'CH.SS': (s) => b01(C(s).status !== 'off'),
    'CH.STS': (s) => b01(run(C(s))),
    'CH.LOAD': (s) => C(s).load,
    'CH.FLT': (s) => b01(C(s).status === 'tripped'),
    'CH.C1': (s) => b01(run(C(s))),
    'CH.FLOW': (s) => proven(pump(s, pumpId)),
    'CH.CWFLOW': (s) => b01(run(C(s)) && pump(s, 'CWP-1')?.on),
    'CH.PMP': (s) => b01(pump(s, pumpId)?.on),
    // role aliases the skid pump reads (resolveSuffix), not keys of the config's suffix map
    'CH.PMP.STS': (s) => proven(pump(s, pumpId)),
    'CH.PMP.SVD': (s) => pump(s, pumpId)?.speed,
    'CH.CHWS': (s) => C(s).chws,
    'CH.CHWR': (s) => C(s).chwr,
    'CH.SP': (s) => P(s).chwsSp,
    'CH.CWS': (s) => P(s).tower.cws,
    'CH.CWR': (s) => C(s).cwl ?? (run(C(s)) ? P(s).tower.cwr : P(s).tower.cws),
  };
}

const CWP_BINDINGS = {
  'BP1.SS': (s) => b01(pump(s, 'CWP-1')?.on),
  'BP1.STS': (s) => proven(pump(s, 'CWP-1')),
  'BP1.SVD': (s) => pump(s, 'CWP-1')?.speed,
};

const HHW_BINDINGS = (() => {
  const b = {
    'HHW.HWS': (s) => HHW(s).hws,
    'HHW.HWR': (s) => HHW(s).hwr,
    'HHW.HWS_SP': (s) => P(s).hwsSp,
    'HHW.DP': (s) => HHW(s).dp,
    'HHW.DP_SP': (s) => HHW(s).dpSp,
    'HHW.OAT': (s) => s.oat,
    'HHW.SYS_ENA': (s) => b01(HHW(s).enabled),
    'HHW.TMP_ALM': (s) => b01(HHW(s).tempAlarm),
    'HHW.CV1': (s) => HHW(s).cv1,
    'HHW.CV1_FB': (s) => HHW(s).cv1Fb,
    'HHW.CV2': (s) => HHW(s).cv2,
    'HHW.CV2_FB': (s) => HHW(s).cv2Fb,
    'HHW.BYP': (s) => HHW(s).byp,
    'HHW.BYP_FB': (s) => HHW(s).bypFb,
  };
  for (const i of [1, 2]) {
    b[`HHW.HX${i}_ISO1`] = (s) => HHW(s).hx?.[i - 1]?.iso1;
    b[`HHW.HX${i}_ISO2`] = (s) => HHW(s).hx?.[i - 1]?.iso2;
    b[`HHW.P${i}_SS`] = (s) => (pump(s, `HWP-${i}`) ? b01(pump(s, `HWP-${i}`).on) : NaN);
    b[`HHW.P${i}_STS`] = (s) => proven(pump(s, `HWP-${i}`));
    b[`HHW.P${i}_SVD`] = (s) => pump(s, `HWP-${i}`)?.speed;
  }
  return b;
})();

/* ── the units, in build order ───────────────────────────────────── */

/**
 * level/x/y/z/rotY: the holder's placement (y = level origin). curb: a steel
 * roof curb under the unit (metres). subs: sub-parts picked on their own, by
 * the ClarityView pick title on (an ancestor of) their meshes. aliases: layout
 * ids this unit stands in for (INTERIM: B-1 until the sim's layout says HHW-1).
 * unmapped: configured suffixes the sim does not model (resolve: unbound).
 */
export const UNITS = [
  {
    id: 'AHU-1', cls: 'ahu', kind: 'ahu', rhAfterFans: true, title: 'AHU-1', family: 'air',
    config: ahuConfig('left'), level: 'RF', x: 0, y: 24, z: -8.5, rotY: 0, curb: { w: 12.6, h: 0.3, d: 2.7 },
    bindings: ahuBindings('AHU-1'), unmapped: ['RF1.FLT', 'RF2.FLT'], subs: [], aliases: [],
  },
  {
    id: 'AHU-2', cls: 'ahu', kind: 'ahu', rhAfterFans: true, title: 'AHU-2', family: 'air',
    config: ahuConfig('right'), level: 'RF', x: 0, y: 24, z: 8.5, rotY: Math.PI, curb: { w: 12.6, h: 0.3, d: 2.7 },
    bindings: ahuBindings('AHU-2'), unmapped: ['RF1.FLT', 'RF2.FLT'], subs: [], aliases: [],
  },
  {
    // lodBias: the tower's live model differs from its baked copy only by the fan inside the
    // stack, so it goes live a little later than its size alone would say
    id: 'CT-1', cls: 'tower', kind: 'tower', title: 'CT-1', family: 'water', tower: true, lodBias: 0.8,
    config: towerConfig(), level: 'RF', x: 13.6, y: 24, z: 0, rotY: 0,
    bindings: TOWER_BINDINGS, unmapped: ['CTF1.FLT'], subs: [], aliases: [],
  },
  ...[['CH-1', -8.2, 'CHWP-1'], ['CH-2', -4.0, 'CHWP-2']].map(([id, z, p]) => ({
    id, cls: 'chiller', kind: 'chiller-wc', title: id, family: 'water',
    config: chillerConfig(), level: 'B1', x: 13.6, y: -4.5, z, rotY: 0,
    bindings: chillerBindings(id, p), unmapped: [], subs: [{ id: p, pickTitle: /^Chilled-water pump$/ }], aliases: [],
  })),
  {
    id: 'CWP-1', cls: 'booster', kind: 'booster', title: 'CWP-1', family: 'water',
    config: cwpConfig(), level: 'B1', x: 10.9, y: -4.5, z: 1.55, rotY: 0,
    bindings: CWP_BINDINGS, unmapped: ['BP1.FLT'], subs: [], aliases: [],
  },
  {
    id: 'HHW-1', cls: 'hhw', kind: 'hx', title: 'HHW-1', cardTitle: 'Heating hot water plant', family: 'water',
    config: HHW_CONFIG, level: 'B1', x: -13.0, y: -4.5, z: 3.4, rotY: 0,
    bindings: HHW_BINDINGS,
    unmapped: ['HHW.HX_CHG_ALM', 'HHW.MAX_VLV', 'HHW.MAX_VLV_SP', 'HHW.HX1_RT', 'HHW.HX2_RT', 'HHW.P1_FLT', 'HHW.P2_FLT', 'HHW.P1_OVR', 'HHW.P2_OVR', 'HHW.P1_RT', 'HHW.P2_RT'],
    subs: [{ id: 'HWP-1', pickTitle: /^Pump P-1$/ }, { id: 'HWP-2', pickTitle: /^Pump P-2$/ }],
    aliases: ['B-1'],
  },
];

/** Suffixes bound outside the config's suffix map: role aliases the views look up. */
export const ROLE_ALIASES = new Set(['CH.PMP.STS', 'CH.PMP.SVD']);

const maps = new Map();
/** The config's suffix map (cached per unit). */
export function mapOf(unit) {
  if (!maps.has(unit.id)) maps.set(unit.id, suffixMap(unit.config).map);
  return maps.get(unit.id);
}

/**
 * has / resolve for one unit, reading ref.state (sim.state, mutated in place by the sim).
 * resolve never throws: a binding that fails on a missing branch reads unbound.
 */
export function accessFor(unit, ref) {
  const map = mapOf(unit);
  const B = unit.bindings;
  const has = (sfx) => map.has(sfx) || Object.prototype.hasOwnProperty.call(B, sfx);
  const UNBOUND = Object.freeze({ value: null, status: 'unbound', label: 'unbound' });
  const resolve = (sfx) => {
    const fn = Object.prototype.hasOwnProperty.call(B, sfx) ? B[sfx] : null;
    if (!fn) return map.has(sfx) ? UNBOUND : null;
    let v = NaN;
    try {
      v = ref.state ? Number(fn(ref.state)) : NaN;
    } catch {
      v = NaN;
    }
    return Number.isFinite(v) ? { value: v, status: 'normal' } : UNBOUND;
  };
  return { has, resolve };
}
