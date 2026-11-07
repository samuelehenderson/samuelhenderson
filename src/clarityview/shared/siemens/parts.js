// parts.js — the Siemens part records the 3D library draws (siemens-spec.md
// §3.2 / §3.3, I-3). Part of the 3D chunk: the main bundle never imports it
// (2D may load it with import()).
//
// Every record: kind, name, shape (archetype in web/ahu/3d/siemens-shapes.js),
// dims (mm, the ENVELOPE as drawn: w along the mounting face, h up, d out of
// the face; rotary actuators: w across, h along the body, d along the shaft),
// finish (catalog.js FINISH tokens), doc, region and verified { dims, shape,
// finish }. A field no Siemens document gives stays undefined; nothing is
// guessed. `verified: false` puts "≈" in the label.

import { ALIASES, decodeOpenAir } from './catalog.js'
import { defaultDevice, onReturn } from './select.js'
import { suffixMap, kindOf, viewFamily } from '../../ahu/ahu3d-bridge.js'

const V = (dims, shape, finish) => Object.freeze({ dims, shape, finish })

// The Powers low limits' housing finish, one switch: GREY per the user's reference photo (2026-09-30),
// pending the user's confirmation — flip to 'blackEnamel' for the earlier black answer.
export const FREEZESTAT_BODY = 'greyEnamel'
const US = Object.freeze(['us']), BOTH = Object.freeze(['us', 'intl']), INTL = Object.freeze(['intl'])

// ---- Symaro duct sensors (CE1N1761en / CE1N1762en / CE1N1882en / CE1N1962en) ----
const SYM_FIN = { base: 'ral7001', cover: 'ral7035', flange: 'pa66Black', probe: 'pa66Black', gland: 'ral7035' }
const FLANGE = { kind: 'flange', part: 'AQM63.0', plate: [80, 50], holes: 60, standoff: 40 }
const qam = (name, signal, d, probeLen, extra = {}) => ({
  kind: 'sensor', measures: ['temp'], line: 'symaro', name, signal, shape: 'symaro',
  dims: { w: 80, h: 60, d, step: 3.7 }, probe: { kind: 'flex', exit: 'back', len: probeLen, dia: 6 },
  mount: FLANGE, finish: SYM_FIN, region: BOTH, verified: V(true, true, true), ...extra,
})

const RECORDS = {
  'QAM2161.040': qam('Duct temp sensor, 0–10 V', '0-10V', 39, 400, { gland: { side: 'bottom', len: 28 }, doc: 'CE1N1762en; US cat. 536-753A E-23/24 "Premium"' }),
  'QAM2171.040': qam('Duct temp sensor, 4–20 mA', '4-20mA', 39, 400, { gland: { side: 'bottom', len: 28 }, doc: 'CE1N1762en; US cat. 536-753A E-23/24' }),
  'QAM2130.040': qam('Duct temp sensor, NTC 10k Type 2', 'NTC10k-T2', 31, 400, { doc: 'CE1N1761en; US cat. 536-753A E-24' }),
  'QAM2120.040': qam('Duct temp sensor, Nickel 1k @ 32F', 'Ni1000', 31, 400, { doc: 'CE1N1761en; US cat. 536-753A E-24' }),
  'QAM2120.200': qam('Averaging duct temp sensor 2 m, Nickel 1k @ 32F', 'Ni1000', 31, 2000, { averaging: true, clamps: 'AQM63.3', doc: 'CE1N1761en; US cat. 536-753A E-24' }),
  'QAM2120.600': qam('Averaging duct temp sensor 6 m, Nickel 1k @ 32F', 'Ni1000', 31, 6000, { averaging: true, clamps: 'AQM63.3', doc: 'CE1N1761en; US cat. 536-753A E-24' }),
  'QFM3160': {
    kind: 'sensor', measures: ['rh', 'temp'], line: 'symaro', name: 'Duct RH + temp sensor, 0–10 V, ±2 % RH', signal: '0-10V', shape: 'symaro',
    dims: { w: 80, h: 60, d: 39, step: 3.7 }, probe: { kind: 'rod', exit: 'back', len: 235, dia: 15 }, gland: { side: 'bottom', len: 28 },
    mount: FLANGE, finish: { ...SYM_FIN, probe: 'ral7001' }, doc: 'CE1N1882en; US cat. 536-753A E-27', region: BOTH, verified: V(true, true, true),
  },
  'QPM2160': {
    kind: 'sensor', measures: ['co2', 'temp'], line: 'symaro', name: 'Duct CO₂ + temp sensor, NDIR 0–2000 ppm, 0–10 V', signal: '0-10V', shape: 'symaro',
    // housing 80 × 60 × 38 ✓; the measuring chamber behind it (77 × 49, ≈ 43 deep) is UNVERIFIED depth, drawn as mount hardware
    dims: { w: 80, h: 60, d: 38, step: 3.7 }, chamber: { w: 77, h: 49, d: 43 }, probe: { kind: 'rod', exit: 'back', len: 150, dia: 15 },
    gland: { side: 'bottom', len: 28 }, mount: FLANGE, finish: { ...SYM_FIN, probe: 'ral7001', chamber: 'ral7001' },
    doc: 'CE1N1962en; US cat. 536-753A', region: BOTH, verified: V(true, true, true),
  },

  // ---- air dP. Default: Setra Model 264 class very-low-dP transmitter (user answer 2026-09-29; the user does
  // not use QBM3100U). Drawn as the grey-cover version in the user's photo (2026-09-30): a portrait cover,
  // two barbed fittings on the face (LOW above, HIGH below). Size NOT measured yet: every number is ≈.
  ...Object.fromEntries([['1', '0–1'], ['5', '0–5']].map(([r, t]) => [`SETRA-264-${r}`, {
    kind: 'sensor', measures: ['dp'], maker: 'Setra', name: `Setra Model 264 very-low dP transmitter, ${t} in. w.c. (range as ordered)`, signal: '4-20mA|0-5V|0-10V', shape: 'setra264',
    dims: { w: 84, h: 142, d: 54 }, ports: [[0, 47, 54], [0, 7, 54]],
    finish: { body: 'setraCover', grille: 'setraGrille', ink: 'ral7016', label: 'whiteLabel', nipple: 'brass', tube: 'tube' },
    doc: 'Setra Model 264 data sheet (dimensions not yet checked); grey cover per the user photo', region: US, verified: V(false, false, false),
  }])),
  ...Object.fromEntries([['3', '0–300 Pa'], ['5', '0–500 Pa'], ['10', '0–1000 Pa']].map(([r, t]) => [`QBM3020-${r}`, {
    kind: 'sensor', measures: ['dp'], name: `Air dP transmitter, ${t}, 0–10 V`, signal: '0-10V', shape: 'qbm',
    dims: { w: 80, h: 75, d: 49 }, fitting: 'none', finish: { body: 'pcFrost', label: 'labelSlate', nipple: 'pcFrost', tube: 'tube' },
    doc: 'CA1N1916en01 (US availability UNVERIFIED)', region: INTL, verified: V(true, false, false),
  }])),

  // ---- air velocity (A6V12409424; US catalogue lists it as "QVM62.1", exact US suffix UNVERIFIED) ----
  'QVM62.1-HU': {
    kind: 'sensor', measures: ['velocity'], name: 'Air velocity sensor, 0–10 V / 4–20 mA', signal: '0-10V|4-20mA', shape: 'qvm62',
    dims: { w: 86, h: 86, d: 43 }, stem: { dia: 12, len: 327 }, finish: { base: 'ral7001', cover: 'ral7035', stem: 'ral7001', flange: 'ral7001', cable: 'pa66Black' },
    doc: 'A6V12409424; US cat. 536-753A E-43 ("QVM62.1")', region: BOTH, verified: V(true, true, true),
  },

  // ---- Powers low limit (A6V11370657, US cat. D-15/16). Strap overhang and label text UNVERIFIED ----
  '134-1504': {
    kind: 'safety', measures: ['frz'], name: 'Low limit (freezestat), DPST, manual reset, 15–55 °F, 20 ft capillary', signal: 'DPST', shape: 'powersBox',
    dims: { w: 102, h: 83, d: 65 }, capillary: { len: 6096, dia: 3.2 }, label: 'POWERS',
    // grey per the user's photo (2026-09-30; this reverses the earlier "black" answer — to confirm)
    finish: { body: FREEZESTAT_BODY, label: 'whiteLabel', capillary: 'capCopper', strap: 'galv', dark: 'pa66Black', scale: 'scaleCream', band: 'powersTeal', screw: 'brass' },
    doc: 'A6V11370657 (US cat. D-15/16); grey housing, copper capillary, bracket per the user photo', region: US, verified: V(true, false, false),
  },
  '134-1510': {
    kind: 'safety', measures: ['frz'], name: 'Low limit, SPDT, auto reset, 35–45 °F', signal: 'SPDT', shape: 'powersBox',
    dims: { w: 59, h: 81, d: 59 }, capillary: { len: 6096, dia: 3.2 }, label: 'POWERS',
    finish: { body: FREEZESTAT_BODY, label: 'whiteLabel', capillary: 'capCopper', strap: 'galv', dark: 'pa66Black', scale: 'scaleCream', band: 'powersTeal', screw: 'brass' },
    doc: 'A6V11370657 (US cat. D-15/16)', region: US, verified: V(true, false, false),
  },
  '134-1511': {
    kind: 'safety', measures: ['frz'], name: 'Low limit, SPDT, manual reset, 35–45 °F', signal: 'SPDT', shape: 'powersBox',
    dims: { w: 59, h: 81, d: 59 }, capillary: { len: 6096, dia: 3.2 }, label: 'POWERS',
    finish: { body: FREEZESTAT_BODY, label: 'whiteLabel', capillary: 'capCopper', strap: 'galv', dark: 'pa66Black', scale: 'scaleCream', band: 'powersTeal', screw: 'brass' },
    doc: 'A6V11370657 (US cat. D-15/16)', region: US, verified: V(true, false, false),
  },

  // ---- room units (CM2N1602en_10, US 149-151) ----
  'QMX3.P34': {
    kind: 'roomUnit', caps: ['T'], name: 'Room operator unit, temp, backlit display', shape: 'qmx3',
    dims: { w: 88.4, h: 133.4, d: 18 }, plate: { w: 80.5, h: 115, d: 4 }, finish: { white: 'ral9010', black: 'ral9005', side: 'qmxSide' },
    doc: 'CM2N1602en_10; US 149-151 (S55624-H105)', region: BOTH, verified: V(true, true, true),
  },
  'QMX3.P44': {
    kind: 'roomUnit', caps: ['T', 'RH'], name: 'Room operator unit, temp / RH, backlit display', shape: 'qmx3',
    dims: { w: 88.4, h: 133.4, d: 18 }, plate: { w: 80.5, h: 115, d: 4 }, finish: { white: 'ral9010', black: 'ral9005', side: 'qmxSide' },
    doc: 'CM2N1602en_10; US 149-151 (S55624-H143-A)', region: BOTH, verified: V(true, true, true),
  },
  'QMX3.P74': {
    kind: 'roomUnit', caps: ['T', 'RH', 'CO2'], name: 'Room operator unit, temp / RH / CO₂, backlit display', shape: 'qmx3',
    dims: { w: 88.4, h: 133.4, d: 18 }, plate: { w: 80.5, h: 115, d: 4 }, finish: { white: 'ral9010', black: 'ral9005', side: 'qmxSide' },
    doc: 'CM2N1602en_10; US 149-151 (S55624-H106)', region: BOTH, verified: V(true, true, true),
  },
  'QAA2280.FWSC': {
    kind: 'roomUnit', caps: ['T'], name: 'Series 2200 room temperature sensor (TEC)', shape: 'plainBox',
    dims: { w: 70, h: 115, d: 30 }, finish: { base: 'whiteLabel' }, doc: '149-820', region: US, verified: V(true, false, false),
  },

  // ---- controllers (A6V10502844 / -848 / -834; A6V11259958; A6V13503270) ----
  ...ctrl('DXR2.E12P-102B', 'VAV room automation station, BACnet/IP, 0–500 Pa dP sensor', 'A6V10502844', true),
  ...ctrl('DXR2.M12P-102B', 'VAV room automation station, BACnet MS/TP, 0–500 Pa dP sensor', 'A6V10502844', true),
  ...ctrl('DXR2.E18-101B', 'Room automation station, fan coil / chilled beam, BACnet/IP', 'A6V10502848', false),
  ...ctrl('DXR2.M18-101B', 'Room automation station, fan coil / chilled beam, BACnet MS/TP', 'A6V10502848', false),
  ...ctrl('DXR2.M11-101B', 'Room automation station, BACnet MS/TP', 'A6V10502834', false),
  // the E17CX of the user's photo (027_dxr2.e17cx-103a): wider housing, more terminals; size ≈ from the photo
  ...ctrl('DXR2.E17CX-103A', 'Room automation station, BACnet/IP (photo)', 'photo 027_dxr2.e17cx-103a; size ≈', false, { w: 216, h: 104.5, d: 59.5 }, V(false, false, true)),
  'DXR2.E10PL-102B': {
    kind: 'controller', actuating: true, torqueNm: 10, runS: 90, protocol: 'BACnet/IP',
    name: 'VAV compact controller with 10 Nm damper actuator, BACnet/IP, 0–500 Pa dP sensor', shape: 'ctrlActuating',
    // 201 × 136.94 × 81.72 ✓; hub position on the actuator end is photo-derived (≈)
    dims: { w: 136.94, h: 201, d: 81.72 }, hub: { fromTop: 40, x: 0, dia: 34 }, module: 80,
      // P1+ / P1− pressure ports on the actuator module's end (photo ≈), tips in mm
      ports: [[80.5, 12, 0], [80.5, -12, 0]],
    finish: { body: 'dinGrey', hub: 'pa66Black', pointer: 'discYellow', disc: 'discYellow', clamp: 'galv', terminals: 'ral7016', label: 'whiteLabel', led: 'ledOff', nipple: 'pa66Black' },
    doc: 'A6V11259958 (US, BACnet/IP); A6V11339446; disc and ports per the user photo', region: BOTH, verified: V(true, false, true),
  },
  'DXR2.M10PL-102B': {
    kind: 'controller', actuating: true, torqueNm: 10, runS: 90, protocol: 'BACnet MS/TP',
    name: 'VAV compact controller with 10 Nm damper actuator, BACnet MS/TP, 0–500 Pa dP sensor', shape: 'ctrlActuating',
    dims: { w: 136.94, h: 201, d: 81.72 }, hub: { fromTop: 40, x: 0, dia: 34 }, module: 80,
      // P1+ / P1− pressure ports on the actuator module's end (photo ≈), tips in mm
      ports: [[80.5, 12, 0], [80.5, -12, 0]],
    finish: { body: 'dinGrey', hub: 'pa66Black', pointer: 'discYellow', disc: 'discYellow', clamp: 'galv', terminals: 'ral7016', label: 'whiteLabel', led: 'ledOff', nipple: 'pa66Black' },
    doc: 'A6V11339448', region: BOTH, verified: V(true, false, true),
  },
  'DXR1.E10PL-112/US': {
    kind: 'controller', actuating: true, torqueNm: 10, runS: 150, protocol: 'BACnet/IP',
    name: 'Zone controller VAV actuator, 10 Nm, BACnet/IP (Climatix app)', shape: 'ctrlActuating',
    // 137 (with clamp) × 143.1 × 82.1 ✓; hub 33.2 from the clamp edge, ≈ 32 below the top (drawing-scaled ±3)
    dims: { w: 137, h: 143.1, d: 82.1 }, hub: { fromTop: 32, x: -(137 / 2 - 33.2), dia: 34 }, module: 0,
    finish: { body: 'ral7035', hub: 'pa66Black', pointer: 'pointer', clamp: 'galv', terminals: 'ral7016', label: 'whiteLabel', led: 'ledOff' },
    doc: 'A6V13503270', region: US, verified: V(true, false, false),
  },
  'GDB181.1E/BA': {
    kind: 'controller', actuating: true, torqueNm: 5, protocol: 'BACnet MS/TP',
    name: 'Compact VAV controller, 5 Nm, BACnet MS/TP', shape: 'oaCompact', housing: 'GDB',
    dims: { w: 71, h: 158, d: 61 }, body: { h: 138 }, hub: { fromHead: 33.2 },
    finish: { body: 'plasticLt', clamp: 'galv', hub: 'pa66Black', pointer: 'pointer', label: 'labelBlue', override: 'override' },
    doc: 'A6V10631834', region: INTL, verified: V(true, false, false),
  },
  'GDB181.1E/3': {
    kind: 'controller', actuating: true, torqueNm: 5, runS: 150, protocol: 'DC 0–10 V',
    name: 'Compact VAV controller, 5 Nm, DC 0–10 V, 150 s', shape: 'oaCompact', housing: 'GDB',
    dims: { w: 71, h: 158, d: 61 }, body: { h: 138 }, hub: { fromHead: 33.2 },
    finish: { body: 'plasticLt', clamp: 'galv', hub: 'pa66Black', pointer: 'pointer', label: 'labelBlue', override: 'override' },
    doc: 'G..B181.1E/3 basic documentation', region: INTL, verified: V(true, false, false),
  },
  'ATEC 550-430PA': {
    kind: 'controller', actuating: true, torqueLbIn: 44, protocol: 'BACnet MS/TP',
    name: 'Actuating TEC VAV controller, 44 lb-in, BACnet MS/TP', shape: 'plainBox', rotary: true,
    // 5-9/16 H × 2-15/16 W × 4-3/16 D in ✓; drawn as a plain box on the shaft (shape UNVERIFIED)
    dims: { w: 75, h: 141, d: 106 }, hub: { fromTop: 33 }, finish: { base: 'plasticMid' },
    doc: 'ATEC 550-43xPA specification sheet', region: US, verified: V(true, false, false),
  },

  // ---- valve actuators ----
  'SKD62U': skd('Electro-hydraulic valve actuator, spring return, 0–10 V / 4–20 mA, 20 mm', 'spring return'),
  'SKD60U': skd('Electro-hydraulic valve actuator, 0–10 V / 4–20 mA, 20 mm', null),
  'SAX61.03U': sax('Electromotoric valve actuator, 800 N, 0–10 V, 20 mm, 30 s'),
  'SAX81.03U': sax('Electromotoric valve actuator, 800 N, 3-position, 20 mm'),
  'SAS81.03U': sas('Powermite valve actuator, 400 N, floating, 5.5 mm', 93),
  'SAS81.33U': sas('Powermite valve actuator, 400 N, floating, spring return, 5.5 mm', 106.5, true),
  'SAS61.03U': sas('Powermite valve actuator, 400 N, 0–10 V, 5.5 mm', 93),
  'SSB131.09U': ssb('Powermite MZ valve actuator, 200 N, 3-position, 5.5 mm'),
  'SSB161.05U': ssb('Powermite MZ valve actuator, 200 N, 0–10 V, 5.5 mm'),
  'SSE131.09U': zoneAct('Zone valve actuator, 3-position', 104.4, 118),
  'SSE161.05U': zoneAct('Zone valve actuator, 0–10 V, normally closed', 104.4, 118),
  'SSF161.05U': zoneAct('Zone valve actuator, 0–10 V, normally open', 104.4, 118),
  'SFA71U': zoneAct('Zone valve actuator, 24 V spring return, normally closed', 112, 112),
  'SFP71U': zoneAct('Zone valve actuator, 24 V spring return, normally open', 112, 112),
}

function ctrl(id, name, doc, nipples, dims = { w: 180, h: 104.5, d: 59.5 }, verified = V(true, false, true)) {
  return { [id]: {
    kind: 'controller', actuating: false, name, shape: 'ctrlBox', protocol: /\.E/.test(id) ? 'BACnet/IP' : 'BACnet MS/TP',
    // P1+ / P1− under the lower tier, left of centre (photo); tips in mm
    dims, nipples, ports: nipples ? [[-dims.w * 0.18, -dims.h / 2 - 12, dims.d * 0.35], [-dims.w * 0.1, -dims.h / 2 - 12, dims.d * 0.35]] : null,
    // the light grey DIN housing of the photos, green KNX and orange 24 V plugs, metal RJ45 shields
    finish: { body: 'dinGrey', terminals: 'termGrey', screw: 'galv', knx: 'knxGreen', jack: 'galv', port: 'pa66Black', power: 'plugOrange', mark: 'pa66Black', label: 'termGrey', led: 'pa66Black', nipple: 'pa66Black' },
    doc, region: BOTH, verified,
  } }
}
function skd(name, fail) {
  return {
    kind: 'valveActuator', linear: true, stroke: 20, name, fail, shape: 'skd',
    // 300 tall ✓, crown ø127, box 120 wide, 64 behind + 105 in front of the stem axis ✓ (155-180P25 Fig. 17; 155-184P25 Table 10)
    dims: { w: 127, h: 300, d: 169 }, depth: { back: 64, front: 105 }, yoke: 123, foot: [65, 44],
    finish: { box: 'skdBox', body: 'dieAlu', yoke: 'skdYoke', crown: 'crown', stem: 'stemSteel', foot: 'dieAlu' },
    doc: '155-180P25; CM1N4561en (colours from the EU photo, US colour UNVERIFIED)', region: US, verified: V(true, true, false),
  }
}
function sax(name) {
  return {
    kind: 'valveActuator', linear: true, stroke: 20, name, shape: 'sax',
    dims: { w: 124, h: 242, d: 150 }, depth: { back: 68, front: 82 },
    finish: { head: 'sieLight', band: 'anthracite', knob: 'ral5014', ring: 'pointer', yoke: 'dieAlu', clamp: 'ral5014', stem: 'stemSteel' },
    doc: 'CE1N4501en; US TB255', region: US, verified: V(true, true, false),
  }
}
function sas(name, d, spring = false) {
  return {
    kind: 'valveActuator', linear: true, stroke: 5.5, name, shape: 'sasBox', spring,
    // 151 H × 80 W × 93 D (106.5 with the spring pod) ✓, 21.9 in front of the stem axis; CL → top 191 (155-196P25 Table 9)
    dims: { w: 80, h: 151, d }, depth: { front: 21.9, back: d - 21.9 }, nut: { dia: 29.9, h: 21.8 }, clTop: 191,
    finish: { head: 'sieLight', band: 'anthracite', skirt: 'skirt', knob: 'ral5014', ring: 'pointer', nut: 'stemSteel', stem: 'stemSteel' },
    doc: '155-681; 155-196P25', region: US, verified: V(true, true, false),
  }
}
function ssb(name) {
  return {
    kind: 'valveActuator', linear: true, stroke: 5.5, name, shape: 'sasBox', shoe: true,
    // 83 L × 48 W × 81.4 H is the EU SSB (CA1N4891en); the US body is UNVERIFIED
    dims: { w: 83, h: 81.4, d: 48 }, depth: { front: 24, back: 24 }, nut: { dia: 29.9, h: 18 },
    finish: { head: 'ral7035', band: 'ral7035', skirt: 'ral7035', knob: 'ral7035', ring: 'ral7035', nut: 'stemSteel', stem: 'stemSteel' },
    doc: '154-012P25; CA1N4891en', region: US, verified: V(false, false, true),
  }
}
function zoneAct(name, width, clTop) {
  return {
    kind: 'valveActuator', linear: true, stroke: 2.5, name, shape: 'zoneAct',
    // width and centreline → top ✓ (TB254); depth and shape UNVERIFIED
    dims: { w: width, h: clTop - 39.5, d: 70 }, clTop, coupling: 25,
    finish: { body: 'ral7035', coupling: 'ral7035', stem: 'stemSteel' },
    doc: 'TB254 (155-291)', region: US, verified: V(false, false, false),
  }
}

// ---- OpenAir housings: a record for every listed part; any other OpenAir number decodes onto its family ----
const OA_HOUSING = {
  GCA: {
    shape: 'oaXL', dims: { w: 121, h: 305, d: 73 }, body: { w: 100, h: 300, d: 68 }, hub: { fromTop: 78 },
    finish: { body: 'oaAlu', hub: 'pa66Black', pointer: 'pointer', clamp: 'galv' }, doc: '155-173P25', verified: V(true, true, false),
  },
  GMA: {
    shape: 'oaTall', dims: { w: 83, h: 212, d: 68 }, hub: { fromTop: 42 },
    finish: { body: 'oaAlu', hub: 'pa66Black', pointer: 'pointer', clamp: 'galv' }, doc: '155-315P25', verified: V(true, true, true),
  },
  GDE: {
    shape: 'oaCompact', dims: { w: 71, h: 157, d: 61 }, body: { h: 137 }, hub: { fromHead: 33.2 },
    finish: { body: 'plasticLt', clamp: 'galv', hub: 'pa66Black', pointer: 'pointer', label: 'labelBlue', override: 'override' }, doc: '155-188P25', verified: V(true, true, true),
  },
  GDEen: {
    shape: 'oaCompact', dims: { w: 68, h: 166.7, d: 59.2 }, body: { h: 137 }, hub: { fromHead: 33.2 }, enhanced: true,
    finish: { body: 'plasticEn', clamp: 'galv', hub: 'pa66Black', pointer: 'pointer', label: 'labelBlueEn', override: 'override' }, doc: '155-784', verified: V(true, true, true),
  },
  GQD: {
    shape: 'oaMini', dims: { w: 69, h: 120, d: 63 }, hub: { fromHead: 22.5 },
    finish: { body: 'plasticLt', hub: 'pa66Black', pointer: 'pointer', clamp: 'pa66Black' }, doc: '331-547 p.B-3…5', verified: V(true, true, false),
  },
}
OA_HOUSING.GLB = { ...OA_HOUSING.GDE, doc: '155-188P25' }
OA_HOUSING.GLBen = { ...OA_HOUSING.GDEen, doc: '155-785' }

const OA_NAMES = { C: 'spring return', M: 'spring return', Q: 'spring return', P: 'spring return', G: 'fire / smoke, spring return', N: 'spring return' }
function openAirRecord(pn, housingKey, inCatalog = true, extra = {}) {
  const d = decodeOpenAir(pn)
  if (!d) return null
  const h = OA_HOUSING[housingKey]
  const sig = d.signal === '2-position' ? '2-position' : d.signal === 'floating' ? 'floating' : d.signal === '0-10V|2-10V' ? '0/2–10 V, master/slave' : d.signal === '2-10V' ? '2–10 V' : d.signal === '0-10V' ? '0–10 V' : d.signal
  const kind = OA_NAMES[pn[1]] || 'non-spring return'
  return {
    kind: 'actuator', rotary: true, name: `OpenAir damper actuator, ${kind}, ${d.torqueLbIn} lb-in, ${sig}`,
    shape: h.shape, dims: h.dims, body: h.body, hub: h.hub, enhanced: !!h.enhanced, finish: h.finish, doc: h.doc,
    region: US, verified: h.verified, decode: d, inCatalog, cable: d.cable, ...extra,
  }
}
for (const pn of ['GCA161.1U', 'GCA121.1U', 'GCA131.1U', 'GCA151.1U']) RECORDS[pn] = openAirRecord(pn, 'GCA')
for (const pn of ['GMA161.1U', 'GMA121.1U', 'GMA151.1U']) RECORDS[pn] = openAirRecord(pn, 'GMA')
RECORDS['GDE131.1P'] = openAirRecord('GDE131.1P', 'GDE')
for (const pn of ['GDE141.1P', 'GDE161.1P']) RECORDS[pn] = openAirRecord(pn, 'GDEen')
RECORDS['GLB131.1P'] = openAirRecord('GLB131.1P', 'GLB')
RECORDS['GLB161.1P'] = openAirRecord('GLB161.1P', 'GLBen')
for (const pn of ['GQD151.1P', 'GQD121.1P']) RECORDS[pn] = openAirRecord(pn, 'GQD')

for (const [id, r] of Object.entries(RECORDS)) Object.freeze(Object.assign(r, { id }))

/** Every record by order code. */
export const SIEMENS_DEVICES = Object.freeze(RECORDS)

// ---- valve bodies (mm; per size: len = end to end, top = CL → bonnet top, bot = CL → bottom, od = pipe-end OD) ----
// Flowrite 2-way: 155-184P25 Table 11 (½ in ✓; the other rows' column alignment in the extracted text is ≈).
// Flowrite 3-way: 155-185P25 Table 8 (A end to end, B, C ✓). Powermite MT/MZ: 155-196P25, 154-012P25. Zone: TB254.
const NPT_OD = { '1/2': 21.3, '3/4': 26.7, '1': 33.4, '1-1/4': 42.2, '1-1/2': 48.3, '2': 60.3 }
export const VALVE_BODIES = Object.freeze({
  'Flowrite 599': Object.freeze({
    shape: 'flowrite', finish: 'bronze', stroke: 20, doc2: '155-184P25', doc3: '155-185P25', name: 'Flowrite 599 bronze globe valve',
    sizes: {
      '1/2': { len: 72, top: 74, bot: 31, bot3: 68, v2: true }, '3/4': { len: 86, top: 99, bot: 36, bot3: 69 }, '1': { len: 100, top: 96, bot: 32, bot3: 72 },
      '1-1/4': { len: 124, top: 108, bot: 51, bot3: 74 }, '1-1/2': { len: 130, top: 108, bot: 51, bot3: 76 }, '2': { len: 158, top: 116, bot: 57, bot3: 81 },
    },
  }),
  'Powermite MT': Object.freeze({
    shape: 'powermite', finish: 'brass', stroke: 5.5, doc2: '155-196P25', name: 'Powermite MT terminal valve',
    sizes: { '1/2': { len: 70, top: 57, bot: 24, v2: true }, '3/4': { len: 76, top: 57, bot: 26 }, '1': { len: 90, top: 60, bot: 30, body: 'bronze' } },
  }),
  'Powermite MZ': Object.freeze({
    shape: 'powermite', finish: 'brass', stroke: 5.5, doc2: '154-012P25', doc3: '154-012P25', name: 'Powermite MZ valve',
    sizes: { '1/2': { len: 70, top: 57, bot: 24, bot3: 33, v2: true, v3: true }, '3/4': { len: 76, top: 57, bot: 26, bot3: 35 }, '1': { len: 90, top: 60, bot: 30, bot3: 38 } },
  }),
  '599 zone': Object.freeze({
    shape: 'powermite', finish: 'brass', stroke: 2.5, zone: true, doc2: 'TB254 (599-0021x)', doc3: 'TB254 (599-0023x)', name: '599 zone valve',
    sizes: { '1/2': { len: 70, top: 39.5, bot: 20, bot3: 30, v2: true }, '3/4': { len: 70, top: 42.5, bot: 22, bot3: 32, v2: true }, '1': { len: 89, top: 46.5, bot: 26, bot3: 36, v2: true } },
  }),
})
for (const b of Object.values(VALVE_BODIES)) for (const [s, r] of Object.entries(b.sizes)) r.od = NPT_OD[s] ?? 21.3

// ---- lookup / labels ----------------------------------------------------------

/** A part record by order code: alias → exact → OpenAir decode onto its family housing (inCatalog: false) → null. */
export function lookup(part) {
  if (!part || typeof part !== 'string') return null
  const id = ALIASES[part] ?? part
  if (RECORDS[id]) return RECORDS[id]
  const d = decodeOpenAir(id)
  if (!d) return null
  const fam = d.family === 'GDE' || d.family === 'GLB' ? d.family : d.family === 'GCA' || d.family === 'GMA' || d.family === 'GQD' ? d.family : null
  if (!fam) return null
  const rec = openAirRecord(id, fam, false)
  return rec ? Object.freeze({ ...rec, id }) : null
}

/** A valve package (config valveModel) resolved: { vm, body, size, sizeKey, actuator } | null. */
export function lookupValve(vm) {
  if (!vm || typeof vm !== 'object') return null
  const body = VALVE_BODIES[vm.series] ?? (vm.family === 'zone' ? VALVE_BODIES['599 zone'] : VALVE_BODIES['Flowrite 599'])
  const sizeKey = body.sizes[vm.size] ? String(vm.size) : Object.keys(body.sizes)[0]
  const actuator = vm.actuator && vm.actuator !== 'none' ? lookup(typeof vm.actuator === 'string' ? vm.actuator : vm.actuator.model) : null
  return { vm, body, size: body.sizes[sizeKey], sizeKey, actuator }
}

const approx = (r) => (r?.verified && (!r.verified.dims || !r.verified.shape) ? ' ≈' : '')
const intl = (r) => (r?.region && !r.region.includes('us') ? ' (intl)' : '')
const inch = (s) => `${String(s).replace('-', ' ')}″`

/** One-line label: 'QAM2161.040 · Duct temp sensor, 0–10 V' (+ ≈ when a size or shape is unconfirmed, + (intl)). */
export function describe(part) {
  if (part && typeof part === 'object' && !part.id) return describeValve(part)
  const r = typeof part === 'string' ? lookup(part) : part
  if (!r) return part ? String(part) : ''
  return `${r.id} · ${r.name}${approx(r)}${intl(r)}${r.inCatalog === false ? ' (decoded from the part number)' : ''}`
}

/** 'Flowrite 599 2″ 3-way + SKD62U' */
export function valveLabel(vm) {
  const v = lookupValve(vm)
  if (!v) return ''
  const ports = vm.ports === 3 ? ' 3-way' : ''
  return `${vm.series || v.body.name} ${inch(v.sizeKey)}${ports}${v.actuator ? ` + ${v.actuator.id}` : ''}`
}

function describeValve(vm) {
  const v = lookupValve(vm)
  if (!v) return ''
  const cv = vm.cv != null ? `, Cv ${vm.cv}` : ''
  const act = v.actuator ? ` + ${v.actuator.id} (${v.actuator.name})` : ''
  return `${v.body.name} ${inch(v.sizeKey)} ${vm.ports === 3 ? '3-way' : '2-way'}${vm.action && vm.ports !== 3 ? ` ${vm.action}` : ''}${cv}${act}`
}

/** COMMAND's point-list subtitle: 'Siemens QAM2161.040 · Duct temp sensor, 0–10 V'. */
export function contextText(part) {
  const d = describe(part)
  const r = typeof part === 'string' ? lookup(part) : part
  return d ? `${r?.maker || 'Siemens'} ${d}` : ''
}

// ---- deviceMap: which part each suffix of a unit gets ---------------------------

const AHU_ROLES = {
  OAT: 'ahu.oa.temp', OAH: 'ahu.oa.rh', 'OA.CFM': 'ahu.oa.flow', MAT: 'ahu.ma.temp',
  PHT: 'ahu.coil.lat', CCT: 'ahu.coil.lat', RHT: 'ahu.coil.lat', FRZ: 'ahu.frz', LTD: 'ahu.frz',
  PHV: 'ahu.valve.heat', RHV: 'ahu.valve.heat', CCV: 'ahu.valve.cool',
  OAD: 'ahu.damper.oa', EAD: 'ahu.damper.ea', RAD: 'ahu.damper.ra',
  SAT: 'ahu.sa.temp', SSP: 'ahu.sa.static', 'SA.CFM': 'ahu.sa.flow', SAH: 'ahu.sa.rh',
  RAT: 'ahu.ra.temp', RAH: 'ahu.ra.rh', 'RA.CO2': 'ahu.ra.co2', 'RA.FLW': 'ahu.ra.flow',
  EAT: 'ahu.ea.temp', 'EA.FLW': 'ahu.ea.flow',
  PFIL: 'ahu.filter.dp', FFIL: 'ahu.filter.dp', AFIL: 'ahu.filter.dp', 'FLT.DP': 'ahu.filter.dp',
}
const TERM_ROLES = { SAT: 'term.dat', OAD: 'term.damper', RHV: 'term.valve', PHV: 'term.valve', CCV: 'term.valve' }

/** The device role a suffix plays on a unit of this kind, or null. */
export function roleOf(sfx, kind) {
  if (kind === 'vav' || kind === 'fcu') {
    if (sfx === 'OAT') return kind === 'vav' ? 'term.pri.temp' : 'term.ent.temp'
    return TERM_ROLES[sfx] ?? null
  }
  return AHU_ROLES[sfx] ?? null
}

/** The part a config entry names explicitly for its suffix: string | object | 'none' | null. */
function explicitOf(sfx, src, role) {
  if (!src || typeof src !== 'object') return null
  if (role?.includes('.valve')) return src.valveModel ?? null
  if (role?.includes('.damper')) return src.actuator ?? null
  if (role === 'ahu.filter.dp') return src.dpModel ?? null
  return src.model ?? null
}

/**
 * Map suffix → { part, role, explicit, src, …defaults } for every suffix of a
 * unit that carries a Siemens device (explicit config first, else the house
 * default; damper actuators are sized from the drawing, so their default part
 * is null here). Adds 'term.controller' for terminals.
 */
export function deviceMap(config) {
  const out = new Map()
  if (!config) return out
  const kind = kindOf(config)
  if (viewFamily(config) === 'plant' || kind === 'crac') return out
  const { map } = suffixMap(config)
  for (const [sfx, e] of map) {
    const role = roleOf(sfx, kind)
    if (!role) continue
    const src = e.src ?? null
    const explicit = explicitOf(sfx, src, role)
    if (explicit != null) { out.set(sfx, { part: explicit, role, explicit: true, src }); continue }
    if (role.includes('.damper') && role.startsWith('ahu.')) { out.set(sfx, { part: null, role, explicit: false, src, sized: 'drawing' }); continue }
    const def = defaultDevice(role, { kind, config, valveType: src?.valveType, variant: src?.variant, binary: src?.signal === 'binary', ret: onReturn(src) })
    out.set(sfx, { ...(def || {}), part: def?.part ?? null, role, explicit: false, src })
  }
  if (kind === 'vav' || kind === 'fcu') {
    const model = config.terminal?.controller?.model ?? config.fieldDevices?.controller ?? null
    out.set('term.controller', model ? { part: model, role: 'term.controller', explicit: true, src: config.terminal?.controller ?? config.fieldDevices }
      : { ...(defaultDevice('term.controller', { kind, config, hasShaft: map.has('OAD') }) || { part: null }), role: 'term.controller', explicit: false, src: null })
  }
  return out
}
