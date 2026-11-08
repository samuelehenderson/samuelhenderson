// vav-types.js — the air-terminal families ClarityView knows: what each one is,
// which reheat it allows, which options apply, and which Siemens applications
// run it. Pure data (no DOM, no three.js); copied into graphics-kit/.
//
// Every air terminal stays kind: 'vav'; the family lives in config.terminal
// (vav-spec.md D1). Tier P0 families draw in 2D and 3D today; P1 families
// (dual duct, exhaust) ship as data and are drawn in a later pass.
//
// Siemens application numbers: TEC/PTEC/ATEC numbers are documented (125-5053,
// 140-1214, 125-5069); every DXR2 numeric application id is UNVERIFIED, so DXR2
// is named by its application family only.

export const FAMILIES = [
  ['dxr2', 'Siemens DXR2 (default)'],
  ['dxr1', 'Siemens DXR1'],
  ['tec', 'Siemens TEC / PTEC / ATEC'],
]
export const FAMILY_SHORT = { dxr2: 'DXR2', dxr1: 'DXR1', tec: 'TEC' }

export const REHEATS = [
  ['none', 'None (cooling only)'],
  ['hw', 'Hot water'],
  ['elec', 'Electric'],
]
export const REHEAT_SHORT = { none: 'cooling only', hw: 'HW reheat', elec: 'electric reheat' }

// Options a type may carry (vav-spec §3.4). Unlisted options are ignored.
const SD_OPTIONS = ['airValve', 'attenuator', 'heatRows', 'heatStages', 'scr', 'connHand', 'valveOn', 'valveAction', 'changeover', 'damperAction', 'damperDir', 'damperRot']
const CAV_OPTIONS = ['attenuator', 'heatRows', 'heatStages', 'scr', 'connHand', 'valveOn', 'valveAction', 'damperAction', 'damperDir', 'damperRot']
const FPB_OPTIONS = ['heatRows', 'heatStages', 'scr', 'connHand', 'valveOn', 'valveAction', 'fanMotor', 'fanControl', 'fanSpeedOut', 'inducedFace', 'damperAction', 'damperDir', 'damperRot']

export const VAV_TYPES = {
  'single-duct': {
    key: 'single-duct', label: 'Single duct VAV', short: 'Single duct', group: 'Single duct', tier: 'P0',
    reheat: ['none', 'hw', 'elec'], defaultReheat: 'hw', ducts: ['primary'], fan: null, zone: true, cav: false,
    options: SD_OPTIONS, eyebrow: 'VAV terminal · single duct',
    sequences: ['G36 5.5 (cooling only)', 'G36 5.6 (with reheat)'],
    apps: {
      none: ['TEC 2020', 'PTEC 6600/6620', 'ATEC 6630', 'DXR2 "VAV Cooling Only"'],
      hw: ['TEC 2023', 'PTEC 6603/6623', 'ATEC 6633', 'DXR2 "VAV with Hot Water"'],
      elec: ['TEC 2022', 'PTEC 6602/6622', 'DXR2 "VAV with staged Electric Heat"'],
    },
    blurb: 'Round inlet with a flow cross, a single-blade damper on its shaft, lined casing, optional reheat at the discharge.',
  },
  'constant-volume': {
    key: 'constant-volume', label: 'Constant volume (CAV)', short: 'Constant volume', group: 'Single duct', tier: 'P0',
    reheat: ['none', 'hw', 'elec'], defaultReheat: 'none', ducts: ['primary'], fan: null, zone: true, cav: true,
    options: CAV_OPTIONS, eyebrow: 'Constant-volume terminal',
    sequences: [],
    apps: {
      none: ['TEC 2030', 'DXR2 "Constant volume flow"'],
      hw: ['DXR2 "Constant volume flow"'],
      elec: ['DXR2 "Constant volume flow"'],
    },
    blurb: 'The single-duct box holding a fixed occupied and unoccupied airflow.',
  },
  'series-fan': {
    key: 'series-fan', label: 'Series fan-powered (fan runs when occupied)', short: 'Series fan-powered', group: 'Fan-powered', tier: 'P0',
    reheat: ['none', 'hw', 'elec'], defaultReheat: 'hw', ducts: ['primary'], fan: 'series', zone: true, cav: false,
    options: FPB_OPTIONS, eyebrow: 'Series fan-powered terminal',
    sequences: ['G36 5.9 (constant fan)'],
    apps: {
      none: ['DXR2 "Series FPB"'],
      hw: ['TEC 2025', 'PTEC 6605/6625', 'DXR2 "Series FPB with Hot Water"'],
      elec: ['TEC 2024', 'PTEC 6604/6624', 'ATEC 6634', 'DXR2 "Series FPB with Electric Heat"'],
    },
    blurb: 'Primary valve and the induced-air opening on the upstream end, a blower in the downstream half that runs whenever the zone is occupied.',
  },
  'parallel-fan': {
    key: 'parallel-fan', label: 'Parallel fan-powered (fan runs for heating)', short: 'Parallel fan-powered', group: 'Fan-powered', tier: 'P0',
    reheat: ['none', 'hw', 'elec'], defaultReheat: 'hw', ducts: ['primary'], fan: 'parallel', zone: true, cav: false,
    options: [...FPB_OPTIONS, 'coilAt'], eyebrow: 'Parallel fan-powered terminal',
    sequences: ['G36 5.7 / 5.8'],
    apps: {
      none: ['DXR2 "Parallel FPB"'],
      hw: ['TEC 2027', 'PTEC 6607/6627', 'DXR2 "Parallel FPB with Hot Water"'],
      elec: ['TEC 2026', 'PTEC 6606/6626', 'ATEC 6636', 'DXR2 "Parallel FPB with Electric Heat"'],
    },
    blurb: 'Primary valve through the casing; a fan box beside it, opposite the controls, runs for heating and low primary flow through a backdraft damper.',
  },
  // ---- P1: data, handles and geometry ship now; drawings come with twin routing ----
  'dual-duct-mixing': {
    key: 'dual-duct-mixing', label: 'Dual duct, mixing', short: 'Dual duct (mixing)', group: 'Dual duct', tier: 'P1',
    reheat: ['none', 'hw', 'elec'], defaultReheat: 'none', ducts: ['cold', 'hot'], fan: null, zone: true, cav: false,
    options: ['heatRows', 'heatStages', 'connHand', 'valveOn', 'damperAction', 'damperDir', 'damperRot', 'mixer', 'flowSensors'],
    eyebrow: 'Dual-duct terminal · mixing',
    sequences: ['G36 5.12', 'G36 5.13', 'G36 5.14'],
    apps: { none: ['TEC 2237/2238 (CV)', 'TEC 2267/2268', 'TEC 2269 (changeover)', 'PTEC 6665–6669'], hw: ['PTEC 6665–6669'], elec: ['PTEC 6665–6669'] },
    blurb: 'Cold and hot collars side by side, each with its sensor and damper, one controller, a mixer ahead of the discharge.',
  },
  'dual-duct-nonmixing': {
    key: 'dual-duct-nonmixing', label: 'Dual duct, non-mixing', short: 'Dual duct (non-mixing)', group: 'Dual duct', tier: 'P1',
    reheat: ['none'], defaultReheat: 'none', ducts: ['cold', 'hot'], fan: null, zone: true, cav: false,
    options: ['damperAction', 'damperDir', 'damperRot', 'flowSensors'], eyebrow: 'Dual-duct terminal · non-mixing',
    sequences: ['G36 5.12'],
    apps: { none: ['PTEC 6665–6669'] },
    blurb: 'Two single-duct valves in a common casing and outlet, no mixer.',
  },
  exhaust: {
    key: 'exhaust', label: 'Exhaust / extract VAV', short: 'Exhaust', group: 'Exhaust', tier: 'P1',
    reheat: ['none'], defaultReheat: 'none', ducts: ['exhaust'], fan: null, zone: false, cav: false,
    options: ['attenuator', 'damperAction', 'damperDir', 'damperRot'], eyebrow: 'Exhaust air terminal',
    sequences: [],
    apps: { none: ['DXR2 "Extract air volume" (ExVav, UNVERIFIED)'] },
    blurb: 'Room-side exhaust branch through a collar, sensor and damper to the exhaust main. No zone.',
  },
}

export const TYPE_KEYS = Object.keys(VAV_TYPES)
export const P0_TYPES = TYPE_KEYS.filter((k) => VAV_TYPES[k].tier === 'P0')

/** The 12 drawn variants (P0 type × reheat), for pickers and checks. */
export const VAV_VARIANTS = P0_TYPES.flatMap((type) => VAV_TYPES[type].reheat.map((reheat) => ({
  key: `${type}/${reheat}`, type, reheat,
  label: `${VAV_TYPES[type].short} · ${reheat === 'none' ? 'cooling only' : reheat === 'hw' ? 'hot water' : 'electric'}`,
})))

/** Every point-handle key a terminal section may carry (flat `…Point` keys, see layout-editor usedHandles). */
export const VAV_POINT_KEYS = {
  vavinlet: ['point', 'posPoint', 'flowPoint', 'flowSpPoint', 'ctlMinPoint', 'ctlMaxPoint', 'clgMinPoint', 'clgMaxPoint', 'htgMinPoint', 'htgMaxPoint',
    'vpPoint', 'occFlowPoint', 'unoccFlowPoint', 'totMinPoint', 'totFlowPoint', 'totFlowSpPoint', 'totMaxPoint'],
  eheat: ['stage1Point', 'stage2Point', 'stage3Point', 'scrPoint', 'flowSwitchPoint', 'faultPoint'],
  coil: ['point', 'posPoint'],
  fan: ['cmdPoint', 'statusPoint', 'speedPoint', 'faultPoint'],
  zone: ['tempPoint', 'spDisplay', 'spCommand', 'clgSpPoint', 'htgSpPoint', 'occPoint', 'co2Point', 'humPoint', 'modeDisplay', 'modeCommand'],
}

/** Documented Siemens application numbers → variant (vav-spec §3.5; UI in a later pass). */
export const VAV_APPS = {
  2020: { type: 'single-duct', reheat: 'none', family: 'tec' },
  6600: { type: 'single-duct', reheat: 'none', family: 'tec' },
  6620: { type: 'single-duct', reheat: 'none', family: 'tec' },
  6630: { type: 'single-duct', reheat: 'none', family: 'tec' },
  2021: { type: 'single-duct', reheat: 'none', family: 'tec', options: { changeover: true } },
  6601: { type: 'single-duct', reheat: 'none', family: 'tec', options: { changeover: true } },
  6621: { type: 'single-duct', reheat: 'none', family: 'tec', options: { changeover: true } },
  6631: { type: 'single-duct', reheat: 'none', family: 'tec', options: { changeover: true } },
  2022: { type: 'single-duct', reheat: 'elec', family: 'tec' },
  6602: { type: 'single-duct', reheat: 'elec', family: 'tec' },
  6622: { type: 'single-duct', reheat: 'elec', family: 'tec' },
  2023: { type: 'single-duct', reheat: 'hw', family: 'tec' },
  6603: { type: 'single-duct', reheat: 'hw', family: 'tec' },
  6623: { type: 'single-duct', reheat: 'hw', family: 'tec' },
  6633: { type: 'single-duct', reheat: 'hw', family: 'tec' },
  2024: { type: 'series-fan', reheat: 'elec', family: 'tec' },
  6604: { type: 'series-fan', reheat: 'elec', family: 'tec' },
  6624: { type: 'series-fan', reheat: 'elec', family: 'tec' },
  6634: { type: 'series-fan', reheat: 'elec', family: 'tec' },
  2025: { type: 'series-fan', reheat: 'hw', family: 'tec' },
  6605: { type: 'series-fan', reheat: 'hw', family: 'tec' },
  6625: { type: 'series-fan', reheat: 'hw', family: 'tec' },
  2026: { type: 'parallel-fan', reheat: 'elec', family: 'tec' },
  6606: { type: 'parallel-fan', reheat: 'elec', family: 'tec' },
  6626: { type: 'parallel-fan', reheat: 'elec', family: 'tec' },
  6636: { type: 'parallel-fan', reheat: 'elec', family: 'tec' },
  2027: { type: 'parallel-fan', reheat: 'hw', family: 'tec' },
  6607: { type: 'parallel-fan', reheat: 'hw', family: 'tec' },
  6627: { type: 'parallel-fan', reheat: 'hw', family: 'tec' },
  6657: { type: 'series-fan', reheat: 'elec', family: 'tec', options: { fanMotor: 'ecm', fanSpeedOut: true, heatStages: 3 } },
  2030: { type: 'constant-volume', reheat: 'none', family: 'tec' },
  2237: { type: 'dual-duct-mixing', reheat: 'none', family: 'tec' },
  6665: { type: 'dual-duct-mixing', reheat: 'none', family: 'tec', options: { flowSensors: 'inlets' } },
  2238: { type: 'dual-duct-mixing', reheat: 'none', family: 'tec' },
  6666: { type: 'dual-duct-mixing', reheat: 'none', family: 'tec', options: { flowSensors: 'cold+discharge' } },
  2267: { type: 'dual-duct-mixing', reheat: 'none', family: 'tec', options: { flowSensors: 'inlets' } },
  6667: { type: 'dual-duct-mixing', reheat: 'none', family: 'tec', options: { flowSensors: 'inlets' } },
  2268: { type: 'dual-duct-mixing', reheat: 'none', family: 'tec', options: { flowSensors: 'cold+discharge' } },
  6668: { type: 'dual-duct-mixing', reheat: 'none', family: 'tec', options: { flowSensors: 'cold+discharge' } },
  2269: { type: 'dual-duct-mixing', reheat: 'none', family: 'tec', options: { changeover: true } },
  6669: { type: 'dual-duct-mixing', reheat: 'none', family: 'tec', options: { changeover: true } },
}

/** The type record for a key (unknown → single duct). */
export function vavType(key) {
  return VAV_TYPES[key] || VAV_TYPES['single-duct']
}
