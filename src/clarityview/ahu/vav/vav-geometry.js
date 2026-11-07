// vav-geometry.js — every air-terminal dimension as data: the dictionary of
// named dimensions, the arrangement (topology) schema, the geometry sets, and
// the resolver/validator that turn a terminal into resolved inches.
//
// Pure data + functions (no DOM, no three.js); copied into graphics-kit/.
// Nothing downstream holds a dimension: vav-layout.js builds every part from
// what resolveDims() returns, so a new geometry set (the friend's schematics)
// changes numbers, never code. How to add one: web/ahu/vav/SCHEMATICS.md.
//
// Resolution order for each dimension (vav-spec §4.1):
//   1. terminal.geometry[dim]          per-unit override, inches
//   2. the chosen set (terminal.geometrySet ?? DEFAULT_SET):
//        type size row → type unit-size row → type dims → set inlet row
//   3. the 'generic' set, same order
//   4. DIM_DICTIONARY[dim].derive(d, ctx)
// Every value comes back in inches with its source ('unit' | 'set:<name>' |
// 'derived') and the winning set's callout letter for that type.
//
// UNVERIFIED marks a generic value no primary drawing confirmed.

export const IN = 0.0254            // metres per inch
export const MM_PER_IN = 25.4
export const DEFAULT_SET = 'generic'

const SD = 'single-duct', CAV = 'constant-volume', SER = 'series-fan', PAR = 'parallel-fan'
const DDM = 'dual-duct-mixing', DDN = 'dual-duct-nonmixing', EX = 'exhaust'
const ALL = [SD, CAV, SER, PAR, DDM, DDN, EX]
const FPB = [SER, PAR]
const DD = [DDM, DDN]

const hw = (c) => c.reheat === 'hw'
const elec = (c) => c.reheat === 'elec'
const heat = (c) => c.reheat === 'hw' || c.reheat === 'elec'

// ---------------------------------------------------------------------------
// Named dimensions (vav-spec §4.5). Order matters: a derivation may only read
// dimensions listed above it. unit: 'in' converts from a set in mm; anything
// else (cfm, K-factor, fraction, enum) is taken as is.
// ---------------------------------------------------------------------------
export const DIM_DICTIONARY = {
  inletNom: { meaning: 'Nominal inlet size', applies: ALL, unit: 'in', req: true },
  inletShape: { meaning: 'Inlet shape: round | oval | rect', applies: ALL, unit: 'enum', values: ['round', 'oval', 'rect'], derive: () => 'round' },
  inletOD: { meaning: 'Inlet collar outside diameter (round)', applies: ALL, unit: 'in', derive: (d) => (d.inletShape === 'rect' ? null : d.inletNom - 0.125) },
  inletW: { meaning: 'Inlet collar outside width (rect / oval)', applies: ALL, unit: 'in', derive: (d) => d.inletOD },
  inletH: { meaning: 'Inlet collar outside height (rect / oval)', applies: ALL, unit: 'in', derive: (d) => d.inletOD },
  casingH: { meaning: 'Casing height', applies: ALL, unit: 'in', req: true },
  casingW: { meaning: 'Casing width across the airflow (parallel: includes the fan box)', applies: ALL, unit: 'in', req: true },
  casingL: { meaning: 'Casing length along the airflow', applies: ALL, unit: 'in', req: true },
  collarL: { meaning: 'Inlet collar projection upstream of the casing face', applies: ALL, unit: 'in', req: true },
  sensorX: { meaning: 'Flow-cross plane from the collar mouth (UNVERIFIED)', applies: ALL, unit: 'in', derive: () => 1.0 },
  bladeGap: { meaning: 'Blade-to-wall gap (UNVERIFIED)', applies: ALL, unit: 'in', derive: () => 0.06 },
  clearGap: { meaning: 'Cross / blade / wall clearance (UNVERIFIED)', applies: ALL, unit: 'in', derive: () => 0.5 },
  bladeR: { meaning: 'Blade radius (derived)', applies: ALL, unit: 'in', derive: (d) => d.inletH / 2 - d.bladeGap },
  shaftX: { meaning: 'Damper shaft from the collar mouth (derived: clears the flow cross)', applies: ALL, unit: 'in', derive: (d) => d.sensorX + d.clearGap + d.bladeR },
  valveBodyL: { meaning: 'Round valve body continuing into the casing (derived: holds the swept blade)', applies: ALL, unit: 'in', derive: (d) => Math.max(0, d.shaftX + d.bladeR + d.clearGap - d.collarL) },
  shaftStub: { meaning: 'Shaft beyond the wall it exits (E10PL needs ≥ ¾ in, UNVERIFIED)', applies: ALL, unit: 'in', derive: () => 0.75 },
  shaftDia: { meaning: 'Damper shaft diameter (UNVERIFIED)', applies: ALL, unit: 'in', derive: () => 0.5 },
  inletZ: { meaning: 'Inlet centre measured from the inletZRef wall', applies: [SD, CAV, SER, EX], unit: 'in', derive: (d, c) => (c.arrangement?.inletZRef === 'center' ? 0 : d.casingW / 2) },
  inletCy: { meaning: 'Inlet centre height above the casing bottom', applies: ALL, unit: 'in', derive: (d) => d.casingH / 2 },
  ctrlOffset: { meaning: 'Controls enclosure start relative to the casing face (see ctrlX)', applies: ALL, unit: 'in', req: true },
  ctrlL: { meaning: 'Controls enclosure length', applies: ALL, unit: 'in', req: true },
  ctrlH: { meaning: 'Controls enclosure height', applies: ALL, unit: 'in', req: true },
  ctrlD: { meaning: 'Controls enclosure projection from the casing', applies: ALL, unit: 'in', req: true },
  ctrlPlateX: { meaning: 'Non-actuating controller centre along the enclosure (UNVERIFIED)', applies: ALL, unit: 'in', derive: (d) => d.ctrlL / 2 },
  coilL12: { meaning: 'Hot-water coil section length, 1–2 row', applies: [SD, CAV, SER, PAR, DDM], unit: 'in', req: hw, when: hw },
  coilL34: { meaning: 'Hot-water coil section length, 3–4 row', applies: [SD, CAV, SER, PAR, DDM], unit: 'in', req: hw, when: hw },
  connOD: { meaning: 'Coil sweat connection OD', applies: [SD, CAV, SER, PAR, DDM], unit: 'in', when: hw, derive: (d, c) => (d.inletNom >= 9 ? 0.875 : (c.options?.heatRows ?? 1) >= 2 ? 0.625 : 0.5) },
  connY1: { meaning: 'Coil supply connection height (UNVERIFIED)', applies: [SD, CAV, SER, PAR, DDM], unit: 'in', when: hw, derive: (d) => 0.25 * d.casingH },
  connY2: { meaning: 'Coil return connection height (UNVERIFIED)', applies: [SD, CAV, SER, PAR, DDM], unit: 'in', when: hw, derive: (d) => 0.75 * d.casingH },
  valveOff: { meaning: 'Reheat valve offset out from the casing side (UNVERIFIED)', applies: [SD, CAV, SER, PAR, DDM], unit: 'in', when: hw, derive: () => 4 },
  heaterL: { meaning: 'Electric heater section length', applies: [SD, CAV, SER, PAR, DDM], unit: 'in', req: elec, when: elec },
  panelL: { meaning: 'Heater control panel length (UNVERIFIED)', applies: [SD, CAV, SER, PAR, DDM], unit: 'in', when: elec, derive: (d) => d.heaterL - 2 },
  panelH: { meaning: 'Heater control panel height', applies: [SD, CAV, SER, PAR, DDM], unit: 'in', when: elec, derive: () => 12 },
  panelD: { meaning: 'Heater control panel projection', applies: [SD, CAV, SER, PAR, DDM], unit: 'in', when: elec, derive: () => 6.25 },
  attL: { meaning: 'Attenuator section length (UNVERIFIED)', applies: [SD, CAV, PAR, EX], unit: 'in', derive: () => 24 },
  outletL: { meaning: 'Discharge collar / flange length', applies: ALL, unit: 'in', derive: (d, c) => (FPB.includes(c.type) ? 1.5 : 0) },
  outletW: { meaning: 'Discharge opening width', applies: ALL, unit: 'in', derive: (d, c) => (c.type === PAR ? d.casingW * 0.55 - 2 : d.casingW) },
  outletH: { meaning: 'Discharge opening height', applies: ALL, unit: 'in', derive: (d) => d.casingH },
  outletY0: { meaning: 'Discharge opening bottom above the casing bottom', applies: ALL, unit: 'in', derive: (d) => Math.max(0, (d.casingH - d.outletH) / 2) },
  dischStubL: { meaning: 'Discharge duct stub drawn after the outlet (UNVERIFIED)', applies: ALL, unit: 'in', derive: () => 12 },
  datProbeX: { meaning: 'DAT probe station along the discharge stub (UNVERIFIED)', applies: ALL, unit: 'in', derive: () => 8 },
  patProbeX: { meaning: 'PAT probe station upstream of the collar mouth (UNVERIFIED)', applies: ALL, unit: 'in', derive: () => 6 },
  inducedW: { meaning: 'Induced-air opening width (across the airflow)', applies: [SER], unit: 'in', req: true },
  inducedH: { meaning: 'Induced-air opening height', applies: [SER], unit: 'in', req: true },
  blowerDia: { meaning: 'Blower scroll diameter (UNVERIFIED)', applies: FPB, unit: 'in', derive: (d, c) => 0.8 * d.casingH },
  blowerW: { meaning: 'Blower housing width (UNVERIFIED)', applies: FPB, unit: 'in', derive: (d, c) => (c.type === PAR ? 0.7 * (d.fanBoxW ?? d.casingW * 0.45) : 0.5 * d.casingW) },
  blowerXFrac: { meaning: 'Blower centre as a fraction of the casing length (UNVERIFIED)', applies: FPB, unit: 'frac', derive: (d, c) => (c.type === PAR ? 0.5 : 0.7) },
  fanBoxW: { meaning: 'Parallel fan-box width within the total casing width (UNVERIFIED)', applies: [PAR], unit: 'in', derive: (d) => 0.45 * d.casingW },
  returnW: { meaning: 'Parallel fan-box return opening width', applies: [PAR], unit: 'in', req: true },
  returnH: { meaning: 'Parallel fan-box return opening height', applies: [PAR], unit: 'in', req: true },
  backdraftW: { meaning: 'Backdraft damper width on the shared wall (UNVERIFIED)', applies: [PAR], unit: 'in', derive: (d) => Math.min(d.returnW, d.casingL - 6) },
  backdraftH: { meaning: 'Backdraft damper height (UNVERIFIED)', applies: [PAR], unit: 'in', derive: (d) => Math.min(d.returnH, d.casingH - 2) },
  hvL: { meaning: 'High-voltage (fan) enclosure length (UNVERIFIED)', applies: FPB, unit: 'in', derive: () => 12 },
  hvH: { meaning: 'High-voltage enclosure height (UNVERIFIED)', applies: FPB, unit: 'in', derive: () => 10 },
  hvD: { meaning: 'High-voltage enclosure projection (UNVERIFIED)', applies: FPB, unit: 'in', derive: () => 5 },
  ddA: { meaning: 'Dual-duct inlet spacing (centre to centre)', applies: DD, unit: 'in', req: (c) => c.type === DDM, derive: (d) => d.casingW / 2 },
  dischCollarL: { meaning: 'Dual-duct discharge collar length', applies: DD, unit: 'in', derive: () => 4 },
  dischW: { meaning: 'Dual-duct discharge opening width', applies: DD, unit: 'in', derive: (d) => d.casingW - 2 },
  dischH: { meaning: 'Dual-duct discharge opening height', applies: DD, unit: 'in', derive: (d) => d.casingH - 2 },
  dischK: { meaning: 'Dual-duct discharge opening offset', applies: DD, unit: 'in', derive: () => 0 },
  mixerL: { meaning: 'Dual-duct mixer length (inside the casing)', applies: [DDM], unit: 'in', derive: (d) => d.casingL },
  ratedCfm: { meaning: 'AHRI rated airflow', applies: ALL, unit: 'cfm', req: true },
  maxCfm: { meaning: 'Top of the catalogue airflow range', applies: ALL, unit: 'cfm', req: true },
  minCfm: { meaning: 'Digital controller minimum (0.02 in. w.g.)', applies: ALL, unit: 'cfm', req: true },
  k: { meaning: 'Inlet flow-sensor K-factor (cfm at 1 in. w.g.)', applies: ALL, unit: 'k' },
  kDisch: { meaning: 'Dual-duct discharge sensor K-factor', applies: DD, unit: 'k' },
  fanMaxCfm: { meaning: 'Fan-powered unit maximum fan airflow', applies: FPB, unit: 'cfm' },
}

/** Keys a size / unit-size row may carry besides dimensions. */
const ROW_KEYS = new Set(['inlets', 'note', 'hp'])

// ---------------------------------------------------------------------------
// Arrangement schema (vav-spec §4.3). Unknown flags or values fail validateSet.
// ---------------------------------------------------------------------------
export const ARRANGEMENT_SCHEMA = {
  inlets: { values: [1, 2], meaning: 'One primary inlet, or cold + hot / cold + vent' },
  inletFace: { values: ['end'], meaning: 'Face the inlet(s) enter (side inlets: later pass)' },
  inletZRef: { values: ['center', 'far-wall', 'hand-wall'], meaning: 'What inletZ is measured from (DESV C: far wall; TFS A: hand wall)' },
  controlsFace: { values: ['side', 'bottom'], meaning: 'Enclosure face (bottom: later pass)' },
  ctrlX: { values: ['before-face', 'after-face'], meaning: 'Enclosure starts ctrlOffset upstream (DESV G, DEDV M) or downstream (TFS N) of the casing face' },
  enclosureV: { values: ['center', 'bottom', 'top'], meaning: 'Enclosure vertical alignment on the casing' },
  enclosures: { values: [1, 2], meaning: 'Dual duct: one per side' },
  inducedFace: { values: [null, 'end', 'side', 'bottom'], meaning: 'Fan-powered induced / return opening' },
  inducedZ: { values: ['opposite', 'center'], meaning: 'Induced opening on the half away from the primary inlet, or centred' },
  fanBoxSide: { values: [null, 'opposite', 'same'], meaning: 'Parallel fan box relative to the controls' },
  blowers: { values: [0, 1, 2], meaning: 'Blower count (two-blower sizes are not seeded)' },
  blowerX: { values: ['downstream', 'center'], meaning: 'Blower centre, with blowerXFrac' },
  blowerOutlet: { values: ['+x', '+y', 'casing'], meaning: 'Blower outlet direction (casing = through the backdraft into the casing)' },
  coilAt: { values: ['discharge', 'fan-inlet'], meaning: 'Reheat location' },
  hvbox: { values: ['none', 'discharge-hand', 'fanbox'], meaning: 'High-voltage (fan) enclosure' },
  outletFixed: { values: [true, false], meaning: 'LH mirrors everything except the outlet' },
  mixer: { values: [true, false], meaning: 'Dual-duct mixing section' },
  attenuatorAt: { values: ['downstream', 'upstream'], meaning: 'Attenuator after the casing (supply) or ahead of the collar (exhaust)' },
}

// ---------------------------------------------------------------------------
// The generic set. Sources: Titus DESV-BCE-1.0 (2019) / DESV-1.0 (2025) /
// DESV-3.0, TFS and TFS-IAQ submittals, DEDV, EDV basic dims, K-factor IOM;
// Price SDV (digital minimum at 0.02 in. w.g.), FDV catalog page.
// ---------------------------------------------------------------------------

// A.1 — inlets: nominal, OD, K (inlet / DD discharge), AHRI rated, range max, digital minimum
const INLETS = {
  4: { inletNom: 4, inletOD: 3.875, k: 273, kDisch: 240, ratedCfm: 150, maxCfm: 225, minCfm: 45 },
  5: { inletNom: 5, inletOD: 4.875, k: 390, kDisch: 384, ratedCfm: 250, maxCfm: 350, minCfm: 60 },
  6: { inletNom: 6, inletOD: 5.875, k: 448, kDisch: 538, ratedCfm: 400, maxCfm: 500, minCfm: 65 },
  7: { inletNom: 7, inletOD: 6.875, k: 667, kDisch: 733, ratedCfm: 550, maxCfm: 650, minCfm: 95 },
  8: { inletNom: 8, inletOD: 7.875, k: 904, kDisch: 997, ratedCfm: 700, maxCfm: 900, minCfm: 125 },
  9: { inletNom: 9, inletOD: 8.875, k: 1167, kDisch: 1254, ratedCfm: 900, maxCfm: 1050, minCfm: 160 },
  10: { inletNom: 10, inletOD: 9.875, k: 1436, kDisch: 1640, ratedCfm: 1100, maxCfm: 1400, minCfm: 210 },
  12: { inletNom: 12, inletOD: 11.875, k: 1891, kDisch: 2619, ratedCfm: 1600, maxCfm: 2000, minCfm: 300 },
  14: { inletNom: 14, inletOD: 13.875, k: 3015, kDisch: 3808, ratedCfm: 2100, maxCfm: 3000, minCfm: 430 },
  16: { inletNom: 16, inletOD: 15.875, k: 3839, kDisch: 4810, ratedCfm: 2800, maxCfm: 4000, minCfm: 575 },
  '24x16': { inletNom: 24, inletShape: 'rect', inletW: 23.875, inletH: 15.875, ratedCfm: 5300, maxCfm: 8000, minCfm: 1185 },
}

// A.2 — single duct / CAV / exhaust: Titus DESV standard casing. C (inletZ) is
// measured from the wall opposite the controls ("Right hand unit shown").
const DESV = {
  4: { casingH: 8, casingW: 12, casingL: 15.5, collarL: 5.375, ctrlOffset: 7.375, inletZ: 6.5 },
  5: { casingH: 8, casingW: 12, casingL: 15.5, collarL: 5.375, ctrlOffset: 7.375, inletZ: 6.5 },
  6: { casingH: 8, casingW: 12, casingL: 15.5, collarL: 3.375, ctrlOffset: 7.375, inletZ: 6.5 },
  7: { casingH: 10, casingW: 12, casingL: 15.5, collarL: 3.375, ctrlOffset: 7.375, inletZ: 6 },
  8: { casingH: 10, casingW: 12, casingL: 15.5, collarL: 3.375, ctrlOffset: 7.375, inletZ: 6 },
  9: { casingH: 12.5, casingW: 14, casingL: 15.5, collarL: 3.375, ctrlOffset: 5.375, inletZ: 7 },
  10: { casingH: 12.5, casingW: 14, casingL: 15.5, collarL: 3.375, ctrlOffset: 5.375, inletZ: 7 },
  12: { casingH: 15, casingW: 16, casingL: 15.5, collarL: 3.375, ctrlOffset: 5.375, inletZ: 8 },
  14: { casingH: 17.5, casingW: 20, casingL: 15.5, collarL: 3.375, ctrlOffset: 3.375, inletZ: 10.5, coilL12: 7.5, coilL34: 9.75 },
  16: { casingH: 18, casingW: 24, casingL: 15.5, collarL: 3.375, ctrlOffset: 3.375, inletZ: 13.5, coilL12: 7.5, coilL34: 9.75 },
  '24x16': { casingH: 18, casingW: 38, casingL: 15, collarL: 3.375, ctrlOffset: 5.375, inletZ: 19, coilL12: 7.5, coilL34: 9.75 },
}
const DESV_DIMS = { ctrlL: 18, ctrlH: 12.25, ctrlD: 6.5, coilL12: 5, coilL34: 7.25, heaterL: 24, panelH: 12, panelD: 6.25, attL: 24 }
// exhaust: the DESV casing without reheat
const noHeat = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !/^(coilL|heaterL|panel)/.test(k)))
const EX_ROWS = Object.fromEntries(Object.entries(DESV).map(([s, row]) => [s, noHeat(row)]))
const DESV_LETTERS = { inletOD: 'D', collarL: 'M', ctrlOffset: 'G', inletZ: 'C', casingH: 'H', casingW: 'W', casingL: 'L', ctrlL: 'CL', ctrlH: 'CH', ctrlD: 'CW' }
const SD_ARR = { inlets: 1, inletFace: 'end', inletZRef: 'far-wall', controlsFace: 'side', ctrlX: 'before-face', enclosureV: 'center', enclosures: 1, inducedFace: null, fanBoxSide: null, blowers: 0, coilAt: 'discharge', hvbox: 'none', outletFixed: false, mixer: false, attenuatorAt: 'downstream' }

export const GEOMETRY_SETS = {
  generic: {
    label: 'Generic catalogue (Titus DESV / TFS / DEDV / EDV, Price FDV)',
    units: 'in',
    source: {
      [SD]: 'Titus DESV-BCE-1.0 (2019), DESV-1.0 (2025), DESV-3.0 (electric)',
      [CAV]: 'as single duct (Titus DESV)',
      [SER]: 'Titus TFS / TFS-IAQ submittal, unit sizes B–E',
      [PAR]: 'Price FDV catalog page (controls enclosure reuses DESV, UNVERIFIED)',
      [DDM]: 'Titus DEDV submittal',
      [DDN]: 'Titus EDV basic dimensions (H grouping UNVERIFIED)',
      [EX]: 'as single duct (Titus DESV); attenuator ahead of the collar',
    },
    letters: {
      [SD]: DESV_LETTERS,
      [CAV]: DESV_LETTERS,
      [EX]: DESV_LETTERS,
      [SER]: { inletOD: 'D', inletZ: 'A', inletCy: 'B', ctrlOffset: 'N', inducedW: 'C', inducedH: 'E', outletW: 'F', outletH: 'J', outletY0: 'K', casingH: 'H', casingW: 'W', casingL: 'L' },
      [PAR]: { inletOD: 'A − ⅛', returnW: 'D', returnH: 'E', outletW: 'B', outletH: 'C', casingW: 'W', casingH: 'H', casingL: 'L' },
      [DDM]: { ddA: 'A', collarL: 'G', casingH: 'H', casingL: 'L', casingW: 'L (= W)', ctrlOffset: 'M', dischW: 'E', dischH: 'F', dischK: 'K' },
      [DDN]: { casingH: 'H', casingW: 'W', casingL: 'L' },
    },
    inlets: INLETS,
    types: {
      [SD]: { dims: DESV_DIMS, sizes: DESV },
      [CAV]: { dims: DESV_DIMS, sizes: DESV },
      [EX]: { dims: noHeat(DESV_DIMS), sizes: EX_ROWS },
      // A.3 — Titus TFS sizes B–E. Induced opening C × E, discharge F × J at K
      // from the bottom (both from the TFS table); coil / heater lengths UNVERIFIED.
      [SER]: {
        dims: { collarL: 3.375, ctrlL: 20, ctrlH: 12, ctrlD: 6.25, coilL12: 5, coilL34: 7.25, heaterL: 12 },
        sizes: {
          6: { ctrlOffset: 2.875, inletZ: 6 },
          8: { ctrlOffset: 2.875, inletZ: 6 },
          10: { ctrlOffset: 4.875, inletZ: 7 },
          12: { ctrlOffset: 4.875, inletZ: 8 },
          14: { ctrlOffset: 6.875, inletZ: 10 },
          16: { ctrlOffset: 6.875, inletZ: 11 },
        },
        unitSizes: {
          B: { inlets: ['6', '8', '10', '12'], casingH: 16, casingW: 37, casingL: 43, inducedW: 12.5, inducedH: 14.25, outletW: 14.125, outletH: 11.125, outletY0: 2.25, hp: 'PSC 1/6 · ECM 1/3' },
          C: { inlets: ['6', '8', '10', '12'], casingH: 16, casingW: 37, casingL: 43, inducedW: 12.5, inducedH: 14.25, outletW: 14.125, outletH: 11.125, outletY0: 2.25, hp: 'PSC 1/4 · ECM 1/3' },
          D: { inlets: ['10', '12', '14', '16'], casingH: 20, casingW: 39, casingL: 47.5, inducedW: 12, inducedH: 18.25, outletW: 16.5, outletH: 14.625, outletY0: 2, hp: 'PSC 1/3 · ECM 1/2' },
          E: { inlets: ['12', '14', '16'], casingH: 20, casingW: 39, casingL: 47.5, inducedW: 12, inducedH: 18.25, outletW: 16.5, outletH: 14.625, outletY0: 2, hp: 'PSC 3/4 · ECM 3/4' },
        },
      },
      // A.4 — Price FDV (W includes the fan box). Collar 9½ in, 11½ in for
      // inlet diameters 14 and 16. Openings as listed; the layout keeps them
      // inside their face and reports any it had to trim.
      [PAR]: {
        dims: { ctrlOffset: 0, ctrlL: 18, ctrlH: 12.25, ctrlD: 6.5, coilL12: 5, coilL34: 7.25, heaterL: 12 },
        sizes: { 6: { collarL: 9.5 }, 8: { collarL: 9.5 }, 10: { collarL: 9.5 }, 12: { collarL: 9.5 }, 14: { collarL: 11.5 }, 16: { collarL: 11.5 } },
        unitSizes: {
          20: { inlets: ['6', '8', '10'], casingW: 31, casingH: 17.5, casingL: 25.5, returnW: 12, returnH: 15.5, outletW: 14, outletH: 12.5, fanMaxCfm: 750 },
          30: { inlets: ['8', '10', '12'], casingW: 31, casingH: 17.5, casingL: 25.5, returnW: 12, returnH: 15.5, outletW: 14, outletH: 12.5, fanMaxCfm: 1350 },
          40: { inlets: ['10', '12', '14'], casingW: 35, casingH: 17.5, casingL: 29.5, returnW: 16, returnH: 15.5, outletW: 16, outletH: 15, fanMaxCfm: 2000 },
          50: { inlets: ['12', '14', '16'], casingW: 42.25, casingH: 20, casingL: 35, returnW: 21, returnH: 18, outletW: 20, outletH: 17.5, fanMaxCfm: 2400 },
          60: { inlets: ['14', '16'], casingW: 42.25, casingH: 20, casingL: 36.25, returnW: 21, returnH: 18, outletW: 24, outletH: 18, fanMaxCfm: 3000 },
        },
      },
      // A.5 — Titus DEDV (data only in Pass 1; drawn with twin routing later)
      [DDM]: {
        dims: { ctrlL: 18, ctrlH: 12.25, ctrlD: 6.5, dischCollarL: 4, coilL12: 5, coilL34: 7.25, heaterL: 24 },
        sizes: {
          4: { ddA: 8.875, collarL: 5.375, casingH: 8.25, casingW: 19, casingL: 19, ctrlOffset: 7.4375, dischW: 5.875, dischH: 5.875, dischK: 2 },
          5: { ddA: 8.875, collarL: 5.375, casingH: 8.25, casingW: 19, casingL: 19, ctrlOffset: 7.4375, dischW: 5.875, dischH: 5.875, dischK: 2 },
          6: { ddA: 8.875, collarL: 3.375, casingH: 8.25, casingW: 19, casingL: 19, ctrlOffset: 7.4375, dischW: 5.875, dischH: 5.875, dischK: 2 },
          7: { ddA: 10.875, collarL: 5.375, casingH: 10.25, casingW: 23, casingL: 23, ctrlOffset: 7.3125, dischW: 7.125, dischH: 8.125, dischK: 1 },
          8: { ddA: 10.875, collarL: 3.375, casingH: 10.25, casingW: 23, casingL: 23, ctrlOffset: 7.3125, dischW: 7.125, dischH: 8.125, dischK: 1 },
          9: { ddA: 12.875, collarL: 5.375, casingH: 12.75, casingW: 27, casingL: 27, ctrlOffset: 5.4375, dischW: 10.125, dischH: 11.125 },
          10: { ddA: 12.875, collarL: 3.375, casingH: 12.75, casingW: 27, casingL: 27, ctrlOffset: 5.4375, dischW: 10.125, dischH: 11.125 },
          12: { ddA: 14.875, collarL: 3.375, casingH: 15.125, casingW: 31, casingL: 31, ctrlOffset: 5.4375, dischW: 11.125, dischH: 13.125 },
          14: { ddA: 16.875, collarL: 3.375, casingH: 18.125, casingW: 35, casingL: 35, ctrlOffset: 3.4375, dischW: 12.5, dischH: 16.125 },
          16: { ddA: 18.875, collarL: 3.375, casingH: 18.125, casingW: 38, casingL: 38, ctrlOffset: 3.4375, dischW: 15.125, dischH: 16.125 },
        },
      },
      // A.6 — Titus EDV basic, L = 15.5; W = 2 × DESV W + ⅛; collar / enclosure reuse DESV
      [DDN]: {
        dims: { casingL: 15.5, ctrlL: 18, ctrlH: 12.25, ctrlD: 6.5, dischCollarL: 0 },
        sizes: {
          4: { casingH: 8, casingW: 24.125, collarL: 5.375, ctrlOffset: 7.375 },
          5: { casingH: 8, casingW: 24.125, collarL: 5.375, ctrlOffset: 7.375 },
          6: { casingH: 8, casingW: 24.125, collarL: 3.375, ctrlOffset: 7.375 },
          7: { casingH: 10, casingW: 24.125, collarL: 3.375, ctrlOffset: 7.375 },
          8: { casingH: 10, casingW: 24.125, collarL: 3.375, ctrlOffset: 7.375 },
          9: { casingH: 12.5, casingW: 28.125, collarL: 3.375, ctrlOffset: 5.375 },
          10: { casingH: 12.5, casingW: 28.125, collarL: 3.375, ctrlOffset: 5.375 },
          12: { casingH: 15, casingW: 32.125, collarL: 3.375, ctrlOffset: 5.375 },
          14: { casingH: 17.5, casingW: 40.125, collarL: 3.375, ctrlOffset: 3.375 },
          16: { casingH: 18, casingW: 48.125, collarL: 3.375, ctrlOffset: 3.375 },
        },
      },
    },
    arrangement: {
      [SD]: SD_ARR,
      [CAV]: SD_ARR,
      [EX]: { ...SD_ARR, attenuatorAt: 'upstream' },
      [SER]: { inlets: 1, inletFace: 'end', inletZRef: 'hand-wall', controlsFace: 'side', ctrlX: 'after-face', enclosureV: 'center', enclosures: 1, inducedFace: 'end', inducedZ: 'opposite', fanBoxSide: null, blowers: 1, blowerX: 'downstream', blowerOutlet: '+x', coilAt: 'discharge', hvbox: 'discharge-hand', outletFixed: true, mixer: false },
      [PAR]: { inlets: 1, inletFace: 'end', inletZRef: 'center', controlsFace: 'side', ctrlX: 'before-face', enclosureV: 'center', enclosures: 1, inducedFace: 'end', inducedZ: 'center', fanBoxSide: 'opposite', blowers: 1, blowerX: 'center', blowerOutlet: 'casing', coilAt: 'discharge', hvbox: 'fanbox', outletFixed: false, mixer: false },
      [DDM]: { inlets: 2, inletFace: 'end', inletZRef: 'center', controlsFace: 'side', ctrlX: 'before-face', enclosureV: 'center', enclosures: 2, inducedFace: null, fanBoxSide: null, blowers: 0, coilAt: 'discharge', hvbox: 'none', outletFixed: false, mixer: true },
      [DDN]: { inlets: 2, inletFace: 'end', inletZRef: 'center', controlsFace: 'side', ctrlX: 'before-face', enclosureV: 'center', enclosures: 2, inducedFace: null, fanBoxSide: null, blowers: 0, coilAt: 'discharge', hvbox: 'none', outletFixed: false, mixer: false },
    },
  },
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const sizeKey = (s) => String(s ?? '').trim().toLowerCase().replace(/\s*[×x]\s*/, 'x')
const sizeNum = (s) => { const n = parseFloat(String(s)); return Number.isFinite(n) ? n : 0 }
const setOf = (name) => GEOMETRY_SETS[name] || GEOMETRY_SETS[DEFAULT_SET]
/** The set chain for a terminal: its set, then 'generic'. */
export function setChain(name) {
  const own = name && GEOMETRY_SETS[name] ? name : DEFAULT_SET
  return own === 'generic' ? ['generic'] : [own, 'generic']
}

/** Inlet sizes a type offers in a set (falling back to generic), smallest first. */
export function sizesFor(type, setName = null) {
  for (const sn of setChain(setName)) {
    const T = setOf(sn).types?.[type]
    if (!T) continue
    const keys = new Set(Object.keys(T.sizes || {}))
    for (const us of Object.values(T.unitSizes || {})) for (const s of us.inlets || []) keys.add(String(s))
    if (keys.size) return [...keys].sort((a, b) => sizeNum(a) - sizeNum(b) || a.length - b.length)
  }
  return []
}

/** Unit-size keys (fan-powered) in order, from the first set in the chain that has them. */
export function unitSizesFor(type, setName = null) {
  for (const sn of setChain(setName)) {
    const us = setOf(sn).types?.[type]?.unitSizes
    if (us && Object.keys(us).length) return { set: sn, keys: Object.keys(us), rows: us }
  }
  return { set: null, keys: [], rows: {} }
}

/** The smallest unit size whose inlets contain `inletSize` (or null). */
export function unitSizeFor(type, inletSize, setName = null) {
  const { keys, rows } = unitSizesFor(type, setName)
  const want = sizeKey(inletSize)
  return keys.find((k) => (rows[k].inlets || []).map(sizeKey).includes(want)) || null
}

/** The arrangement flags for a terminal: its set's (else generic), with option overrides. */
export function arrangementOf(terminal) {
  const t = terminal || {}
  let base = null
  for (const sn of setChain(t.geometrySet)) { base = setOf(sn).arrangement?.[t.type]; if (base) break }
  const a = { ...(base || SD_ARR) }
  const o = t.options || {}
  if (o.inducedFace != null) a.inducedFace = o.inducedFace
  if (o.coilAt != null) a.coilAt = o.coilAt
  return a
}

const applies = (def, ctx) => (def.applies || ALL).includes(ctx.type) && (!def.when || def.when(ctx))
const isReq = (def, ctx) => applies(def, ctx) && (typeof def.req === 'function' ? !!def.req(ctx) : !!def.req)
const toIn = (units, def, v) => (def.unit === 'in' && units === 'mm' && typeof v === 'number' ? v / MM_PER_IN : v)

/**
 * Every dimension of a terminal in inches.
 * @returns {{ dims, source, letter, set, unitSize, units: 'in', missing: string[], arrangement }}
 */
export function resolveDims(terminal) {
  const t = terminal || {}
  const type = t.type || SD
  const size = sizeKey(t.size ?? '8')
  const chain = setChain(t.geometrySet)
  const setName = chain[0]
  const us = unitSizesFor(type, setName)
  let unitSize = null
  if (us.keys.length) {
    const pinned = t.unitSize != null ? String(t.unitSize) : null
    unitSize = pinned && us.rows[pinned] && (us.rows[pinned].inlets || []).map(sizeKey).includes(size) ? pinned : unitSizeFor(type, size, setName)
  }
  const arrangement = arrangementOf(t)
  const ctx = { type, reheat: t.reheat || 'none', options: t.options || {}, arrangement, size, unitSize }
  const dims = {}, source = {}, letter = {}
  const letterOf = (sn, k) => setOf(sn).letters?.[type]?.[k] ?? null
  for (const [k, v] of Object.entries(t.geometry || {})) {
    if (DIM_DICTIONARY[k] && (typeof v === 'number' ? Number.isFinite(v) : v != null)) { dims[k] = v; source[k] = 'unit'; letter[k] = letterOf(setName, k) }
  }
  for (const sn of chain) {
    const S = setOf(sn)
    const T = S.types?.[type] || {}
    const layers = [T.sizes?.[size], unitSize ? T.unitSizes?.[unitSize] : null, T.dims, S.inlets?.[size]]
    for (const layer of layers) {
      if (!layer) continue
      for (const [k, v] of Object.entries(layer)) {
        const def = DIM_DICTIONARY[k]
        if (!def || k in dims || v == null) continue
        dims[k] = toIn(S.units, def, v); source[k] = `set:${sn}`; letter[k] = letterOf(sn, k)
      }
    }
  }
  for (const [k, def] of Object.entries(DIM_DICTIONARY)) {
    if (k in dims || !def.derive || !applies(def, ctx)) continue
    const v = def.derive(dims, ctx)
    if (v != null && !(typeof v === 'number' && !Number.isFinite(v))) { dims[k] = v; source[k] = 'derived'; letter[k] = null }
  }
  const missing = Object.entries(DIM_DICTIONARY).filter(([k, def]) => isReq(def, ctx) && !(k in dims)).map(([k]) => k)
  return { dims, source, letter, set: setName, unitSize, units: 'in', missing, arrangement }
}

// ---------------------------------------------------------------------------
// Validation (npm run check:vav; the friend's set must pass before use)
// ---------------------------------------------------------------------------

/** Problems with a geometry set, as sentences ([] = valid). */
export function validateSet(set, name = 'set') {
  const out = []
  const bad = (m) => out.push(`${name}: ${m}`)
  if (!set || typeof set !== 'object') return [`${name}: not an object`]
  if (!['in', 'mm'].includes(set.units)) bad(`units must be 'in' or 'mm' (got ${JSON.stringify(set.units)})`)
  const types = set.types || {}
  const checkRow = (where, row, type) => {
    for (const [k, v] of Object.entries(row || {})) {
      if (ROW_KEYS.has(k)) {
        if (k === 'inlets' && !(Array.isArray(v) && v.every((s) => sizeKey(s)))) bad(`${where}.inlets must be a list of inlet sizes`)
        continue
      }
      const def = DIM_DICTIONARY[k]
      if (!def) { bad(`${where}: unknown dimension '${k}'`); continue }
      if (type && !(def.applies || ALL).includes(type)) bad(`${where}: '${k}' does not apply to ${type}`)
      if (def.unit === 'enum') { if (!def.values.includes(v)) bad(`${where}.${k}: '${v}' is not one of ${def.values.join(' | ')}`) }
      else if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${where}.${k}: not a number`)
      else if (v < 0) bad(`${where}.${k}: negative (${v})`)
    }
  }
  for (const [type, T] of Object.entries(types)) {
    if (!ALL.includes(type)) { bad(`unknown terminal type '${type}'`); continue }
    checkRow(`types.${type}.dims`, T.dims, type)
    for (const [s, row] of Object.entries(T.sizes || {})) checkRow(`types.${type}.sizes.${s}`, row, type)
    for (const [u, row] of Object.entries(T.unitSizes || {})) {
      checkRow(`types.${type}.unitSizes.${u}`, row, type)
      if (!Array.isArray(row.inlets) || !row.inlets.length) bad(`types.${type}.unitSizes.${u}: needs inlets: [...]`)
    }
  }
  for (const [s, row] of Object.entries(set.inlets || {})) checkRow(`inlets.${s}`, row, null)
  for (const [type, L] of Object.entries(set.letters || {})) {
    if (!ALL.includes(type)) { bad(`letters: unknown terminal type '${type}'`); continue }
    for (const k of Object.keys(L || {})) if (!DIM_DICTIONARY[k]) bad(`letters.${type}: letter for unknown dimension '${k}'`)
  }
  for (const [type, A] of Object.entries(set.arrangement || {})) {
    if (!ALL.includes(type)) { bad(`arrangement: unknown terminal type '${type}'`); continue }
    for (const [k, v] of Object.entries(A || {})) {
      const sc = ARRANGEMENT_SCHEMA[k]
      if (!sc) bad(`arrangement.${type}: unknown flag '${k}'`)
      else if (!sc.values.includes(v)) bad(`arrangement.${type}.${k}: '${v}' is not one of ${sc.values.map(String).join(' | ')}`)
    }
  }
  if (set.source && typeof set.source !== 'object') bad('source must be { [type]: "sheet, rev" }')
  return out
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const FRAC = { 0.125: '⅛', 0.25: '¼', 0.375: '⅜', 0.5: '½', 0.625: '⅝', 0.75: '¾', 0.875: '⅞' }
/** Inches as a builder writes them: 15.5 → '15½', 7.875 → '7⅞', 7.4375 → '7.44'. */
export function fmtIn(v) {
  if (!Number.isFinite(v)) return '—'
  const whole = Math.floor(v + 1e-9), f = Math.round((v - whole) * 1000) / 1000
  if (f === 0) return String(whole)
  if (FRAC[f]) return (whole ? String(whole) : '') + FRAC[f]
  return String(Math.round(v * 100) / 100)
}

/** 'Inlet size' picker rows: [key, '8 in — up to 900 cfm'] for a type. */
export function sizeOptions(type, setName = null) {
  const generic = setChain(setName)[0] === 'generic'
  return sizesFor(type, setName).map((s) => {
    const { dims } = resolveDims({ type, size: s, geometrySet: setName })
    const nom = /x/.test(s) ? s.replace('x', ' × ') : s
    return [s, `${nom} in — up to ${Number(dims.maxCfm || 0).toLocaleString('en-US')} cfm${generic ? ' (generic sizes)' : ''}`]
  })
}

/** 'Unit size' picker rows for fan-powered types: [key, 'B — 16 × 37 × 43 in · inlets 6–12']. */
export function unitSizeOptions(type, setName = null) {
  const { keys, rows } = unitSizesFor(type, setName)
  return keys.map((k) => {
    const r = rows[k], ins = (r.inlets || []).map(String)
    return [k, `${k} — ${fmtIn(r.casingH)} × ${fmtIn(r.casingW)} × ${fmtIn(r.casingL)} in · inlets ${ins[0]}–${ins[ins.length - 1]}`]
  })
}
