// catalog.js — small Siemens field-device data that the main bundle may import.
// NO IMPORTS in this file, ever (the floor plan editor imports it and must stay
// bundler-free and three-free).
//
// OWNER: SIEMENS (siemens-spec.md §3.2, I-1). The heavy part records live in
// parts.js (3D chunk, lazy). Everything here is frozen plain data plus the
// OpenAir part-number decoder.
//
// Sources: CM2N1602en_10 / US 149-151 (QMX3), OpenAir catalogue 331-547 p.B-46
// (nomenclature key), GCA TI 155-173P25 Table 1, A6V11259958 / A6V10502844
// (PL-Link budgets). RAL → sRGB values are approximate; "photo" colours are
// sampled from Siemens product photos. Anything no Siemens document confirms
// is marked UNVERIFIED next to it.

export const ROOM_UNIT_MODELS = Object.freeze([
  { model: 'QMX3.P34', label: 'QMX3.P34 · temp, display', caps: ['T'], mA: 7.5, logoFree: true },
  { model: 'QMX3.P44', label: 'QMX3.P44 · temp, RH, display', caps: ['T', 'RH'], mA: 10, logoFree: false },
  { model: 'QMX3.P74', label: 'QMX3.P74 · temp, RH, CO₂, display', caps: ['T', 'RH', 'CO2'], mA: 15, logoFree: true },
])

/** Floor to the CENTRE of a room unit, metres (3'-9": keys stay under ADA's 48 in). */
export const ROOM_UNIT_DEFAULT_H = 1.15

export const ROOM_UNIT_H_PRESETS = Object.freeze([
  { key: 'ada', h: 1.15, label: 'US · ADA (top ≤ 48 in)' },
  { key: 'siemens', h: 1.50, label: 'Siemens datasheet · 1.50 m to centre' },
])

/** Half the QMX3 housing height (133.4 mm / 2), metres. */
export const ROOM_UNIT_HALF_H = 0.0667

/** Display unit by sensor kind. */
export const KIND_UNIT = Object.freeze({ temp: '°F', rh: '%', co2: 'ppm', static: 'in. w.c.', flow: 'cfm', frz: 'state' })

/** KNX PL-Link bus supply of a controller, mA (A6V11259958, A6V10502844). Others UNVERIFIED. */
export const PL_LINK = Object.freeze({ 'DXR2.E10PL-102B': 50, 'DXR2.M10PL-102B': 50, 'DXR2.E12P-102B': 50 })

/** Short names → full order codes. No GDB181 alias: /3 and /BA are different products. */
export const ALIASES = Object.freeze({
  'DXR2.E10PL': 'DXR2.E10PL-102B', 'DXR2.M10PL': 'DXR2.M10PL-102B', 'DXR2.E12P': 'DXR2.E12P-102B', 'DXR2.E17CX': 'DXR2.E17CX-103A',
  'DXR2.M12P': 'DXR2.M12P-102B', 'DXR2.E18': 'DXR2.E18-101B', 'DXR2.M18': 'DXR2.M18-101B', 'DXR2.M11': 'DXR2.M11-101B',
  'DXR1.E10PL': 'DXR1.E10PL-112/US', 'QVM62.1': 'QVM62.1-HU', 'QAA2280': 'QAA2280.FWSC',
})

/**
 * Physical finishes (material colours, never UI tokens, never themed). Every
 * 3D material built from these is named sie_<token> and flagged physical.
 * rough/metal feed MeshStandardMaterial; basic = MeshBasicMaterial (displays).
 */
export const FINISH = Object.freeze({
  ral7001: { color: '#8F999F', rough: 0.55 },              // RAL 7001, stated (Symaro base, QVM62)
  ral7035: { color: '#CBD0CC', rough: 0.62 },               // RAL 7035, stated (Symaro cover, DXR2 housings)
  ral9010: { color: '#F1EDE1', rough: 0.6 },              // QMX3 titanium white ≈ RAL 9010
  ral9005: { color: '#0E0E10', rough: 0.4 },               // QMX3 black ≈ RAL 9005
  qmxSide: { color: '#B8BCBE', rough: 0.5 },               // photo, UNVERIFIED
  ral7016: { color: '#383E42', rough: 0.6 },               // controller terminal strips
  oaAlu: { color: '#9A9A9A', metal: 0.7, rough: 0.45 },    // OpenAir die-cast aluminium (photo colour)
  dieAlu: { color: '#B0B5B8', metal: 0.45, rough: 0.4 },   // SKD rear body, SAX yoke
  skdBox: { color: '#6C84A4', rough: 0.6 },                // SKD front housing box: between the photo's lit (#7B94B4) and shade (#586B85) faces; RAL and US colour UNVERIFIED
  skdYoke: { color: '#8E959A', metal: 0.3, rough: 0.5 },   // photo ≈
  crown: { color: '#BAC5CD', rough: 0.72 },                 // SKD knurled crown, photo
  plasticLt: { color: '#E0E2E3', rough: 0.65 },             // GDE / GLB classic, GQD (≈)
  plasticEn: { color: '#E6E5E1', rough: 0.65 },             // GDE / GLB enhanced
  plasticMid: { color: '#A39F98', rough: 0.55 },           // ATEC mid warm grey, photo UNVERIFIED
  sieLight: { color: '#D3D1CC', rough: 0.75 },              // SAX / SAS head top
  anthracite: { color: '#3E3A37', rough: 0.55 },           // SAX / SAS head band
  skirt: { color: '#A7AAAC', rough: 0.55 },                // SAS lower skirt, photo UNVERIFIED
  ral5014: { color: '#637D96', rough: 0.5 },               // SAX / SAS knob and clamp
  pa66Black: { color: '#1E1F21', rough: 0.7 },             // flanges, probes, OpenAir hubs
  pcFrost: { color: '#D9E0E4', rough: 0.6, opacity: 0.6 }, // QBM body, photo
  labelSlate: { color: '#6F86A6', rough: 0.6 },            // QBM label, photo UNVERIFIED
  labelBlue: { color: '#7EB8E6', rough: 0.6 },             // GDE classic label, photo
  labelBlueEn: { color: '#536A86', rough: 0.6 },           // GDE enhanced label, photo
  pointer: { color: '#C9B458', rough: 0.5 },               // OpenAir pointers, desaturated by decision
  override: { color: '#B0705F', rough: 0.5 },              // GDE override button, desaturated by decision
  galv: { color: '#A9AEB1', metal: 0.7, rough: 0.4 },      // galvanised clamps
  coilSilver: { color: '#C9CDD0', metal: 0.7, rough: 0.35 }, // 134 capillary
  brass: { color: '#B08D57', metal: 0.85, rough: 0.35 },   // C37700 forged brass
  bronze: { color: '#8C6B45', metal: 0.8, rough: 0.4 },    // CA844 bronze
  stemSteel: { color: '#B9BDC0', metal: 0.8, rough: 0.3 }, // stainless stems
  greyEnamel: { color: '#727D84', rough: 0.5 },            // Powers grey baked enamel (the user's photo, 2026-09-30)
  blackEnamel: { color: '#1B1C1E', rough: 0.55 },          // kept for a 134 the user orders black (earlier answer 2026-09-29)
  capCopper: { color: '#B87940', metal: 0.8, rough: 0.35 }, // low-limit capillary, copper (photo)
  scaleCream: { color: '#E6DFC6', rough: 0.6 },            // Powers DEG FAHR scale window (photo)
  powersTeal: { color: '#3E9DB0', rough: 0.55 },           // POWERS label band (photo)
  setraCover: { color: '#737A7F', rough: 0.62 },            // Setra 264 grey cover (the user's photo)
  setraGrille: { color: '#666D72', rough: 0.72 },           // its ribbed lower panel
  dinGrey: { color: '#AEB2B0', rough: 0.66 },              // DXR2 housing, light grey (photos)
  termGrey: { color: '#B8BCBA', rough: 0.6 },              // DXR2 screw-terminal blocks
  knxGreen: { color: '#3FA34D', rough: 0.5 },              // KNX plug (photo)
  plugOrange: { color: '#E07B22', rough: 0.5 },            // 24 V plug (photo)
  jackMetal: { color: '#B9BEC1', metal: 0.7, rough: 0.35 }, // RJ45 shields
  discYellow: { color: '#E2B91F', rough: 0.45 },           // E10PL position-disc tips (photo)
  whiteLabel: { color: '#F2F2EE', rough: 0.6 },            // labels
  tube: { color: '#C8D2D6', rough: 0.4, opacity: 0.75 },   // PVC sensing tube
  lcdLit: { color: '#C4E8DE', basic: true },               // QMX3 backlight, only when live (mint, photo)
  lcdSeg: { color: '#111315', basic: true },               // QMX3 segments
  lcdOff: { color: '#5E686C', basic: true },               // QMX3 display when not live
  ledOff: { color: '#34444E', rough: 0.5 },                // every LED at rest
  wordmark: { color: '#88999F', rough: 0.5 },              // QMX3 "SIEMENS"
  ruBody: { color: '#FFFFFF', rough: 0.45 },               // twin room units: instanceColor carries the finish
})

// ---- OpenAir part numbers (331-547 p.B-46) --------------------------------
// G <type> <run> <volts> <function> <option> . <action> <cable> [/B]
export const OPENAIR = Object.freeze({
  // type letter → [torque lb-in, spring return, note]
  type: Object.freeze({
    A: [53, false, 'lab fail-in-place'], B: [221, false], C: [160, true], D: [44, false], E: [132, false],
    G: [142, true, 'fire and smoke'], I: [310, false], L: [88, false], M: [62, true],
    N: [53, true, 'fire and smoke or lab fail-safe'], P: [35, true], Q: [20, true], S: [20, false],
  }),
  // run letter → [runS (60 Hz), runS50 (50 Hz), springS]; springS only where a TI states it (GQD 331-547 B-4)
  run: Object.freeze({ A: [90, 90], B: [125, 150], C: [60, 60], D: [30, 30, 15], E: [90, 108], P: [2, 2] }),
  volts: Object.freeze({ 1: '24V', 2: '120V', 3: '100-240V' }),
  fn: Object.freeze({ 2: '2-position', 3: 'floating', 4: '2-position|floating', 5: 'mod', 6: '0-10V', 9: 'multi' }),
  option: Object.freeze({ 1: 'standard', 2: 'pot 1k', 3: 'signal adjust', 4: 'switches + signal adjust', 6: 'switches' }),
  cable: Object.freeze({ U: 'standard', P: 'plenum', Q: 'plenum-6ft' }),
})

/**
 * Decode an OpenAir damper-actuator part number, e.g. 'GCA161.1U'.
 * → { family, torqueLbIn, torqueNm, springReturn, runS, runS50, springS?, volts,
 *     signal, inversion, masterSlave, feedbackPot, options, action, cable, bulk } | null
 */
export function decodeOpenAir(pn) {
  const m = /^G([A-Z])([A-Z])([1-3])(\d)(\d)\.([12])([UPQ])?(\/B)?$/.exec(String(pn || '').trim().toUpperCase())
  if (!m) return null
  const [, t, r, v, f, o, act, cab, bulk] = m
  const type = OPENAIR.type[t], run = OPENAIR.run[r]
  if (!type || !run) return null
  const family = `G${t}${r}`
  let signal = OPENAIR.fn[f] ?? null, inversion = false, masterSlave = false
  if (f === '5') {
    inversion = true
    if (family === 'GCA') { signal = '0-10V|2-10V'; masterSlave = true }
    else if (family === 'GMA' || family === 'GQD') signal = '2-10V'
    else signal = 'mod-0/2-10V'
  }
  const out = {
    family, torqueLbIn: type[0], torqueNm: Math.round(type[0] * 0.112985), springReturn: type[1],
    runS: run[0], runS50: run[1], volts: OPENAIR.volts[v] ?? null, signal, inversion, masterSlave,
    feedbackPot: o === '2' || (family === 'GCA' && (f === '5' || f === '6')),
    options: OPENAIR.option[o] ?? null, action: act === '2' ? 'linear' : 'rotary',
    cable: cab ? OPENAIR.cable[cab] : null, bulk: !!bulk,
  }
  if (run[2]) out.springS = run[2]
  if (type[2]) out.note = type[2]
  return out
}
