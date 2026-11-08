// hhw.js — the heat-exchanger unit as a real heating hot water (HHW) plant, pure data.
//
// A steam-to-hot-water plant (the user's HHW panel 7061): horizontal shell-and-tube
// exchangers, steam in through the 1/3 + 2/3 control valves above them into each
// shell's steam nozzle, condensate out underneath; the hot water through the bundle head,
// with an isolation valve on each exchanger's hot-water connections; supply / return
// temperatures just downstream on the loop; the bypass valve returning hot water to the
// plant; VFD pumps; the loop dP.
//
// A unit of kind 'hx' with config.plant is drawn as a plant (hhw2d.js, 3d/hhw3d.js):
//
//   plant: {
//     exchangers: 1 | 2,          // plate HXs in parallel, each with its two isolation valves
//     pumps: 1 | 2 | 3,           // secondary pumps (VFD), in parallel
//     valves: 'split' | 'single', // steam control: a 1/3 + 2/3 pair, or one valve
//     bypass: true,               // loop bypass valve (command + feedback)
//     pumpProof: false,           // pumps report a run proof (P<n>_STS) — the 7061 panel does not
//     program: true,              // the panel's program values (lead/lag, ramps, PID gains…)
//   }
//
// Point symbols are fixed handles (HWS, HX1_ISO1, P2_SVD…) that Map points binds to
// real points; point-aliases.js knows the APOGEE names (GVL.CPPD.HHW.P1.SS …).
// Units saved without config.plant (the older single-HX section config) keep the
// section engine and Hx3DView untouched.

export const PLANT_DEFAULT = { exchangers: 2, pumps: 2, valves: 'split', bypass: true, pumpProof: false, program: true }

/** Is this unit drawn as an HHW plant? */
export const isHhw = (config) => config?.kind === 'hx' && !!config.plant && typeof config.plant === 'object'

/** config.plant, normalised. */
export function plantOf(config) {
  const p = config?.plant || {}
  const n = (v, lo, hi, d) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d }
  return {
    exchangers: n(p.exchangers, 1, 2, PLANT_DEFAULT.exchangers),
    pumps: n(p.pumps, 1, 3, PLANT_DEFAULT.pumps),
    valves: p.valves === 'single' ? 'single' : 'split',
    bypass: p.bypass !== false,
    pumpProof: !!p.pumpProof,
    program: p.program !== false,
  }
}

// kind → how a value reads: temp °F, pct %, psi, h, min, onoff (command/state), alm, gain (unitless), raw (as the panel reports it)
// unclear: meaning not certain from the name alone — drawn with its raw name, listed for the user
export function hhwPoints(config) {
  const P = plantOf(config)
  const out = []
  const add = (sym, label, kind, group, extra = {}) => out.push({ sym, label, kind, group, ...extra })
  // ---- loop ----
  add('HWS', 'HW supply temp', 'temp', 'loop')
  add('HWR', 'HW return temp', 'temp', 'loop')
  add('HWS_SP', 'HWS setpoint', 'temp', 'loop', { cmd: true, note: 'the panel reports this point in m² — read as °F' })
  add('DP', 'Loop dP', 'psi', 'loop')
  add('DP_SP', 'Loop dP setpoint', 'psi', 'loop', { cmd: true })
  add('OAT', 'Outside air temp', 'temp', 'loop')
  add('SYS_ENA', 'System enable', 'onoff', 'loop', { cmd: true })
  add('TMP_ALM', 'Temp alarm', 'alm', 'loop')
  add('HX_CHG_ALM', 'HX change alarm', 'alm', 'loop')
  add('MAX_VLV', 'Max valve position', 'pct', 'loop')
  add('MAX_VLV_SP', 'Max valve setpoint', 'pct', 'loop', { cmd: true })
  // ---- primary control valves + bypass ----
  if (P.valves === 'split') {
    add('CV1', '1/3 steam valve', 'pct', 'valves', { cmd: true })
    add('CV1_FB', '1/3 steam valve feedback', 'pct', 'valves')
    add('CV2', '2/3 steam valve', 'pct', 'valves', { cmd: true })
    add('CV2_FB', '2/3 steam valve feedback', 'pct', 'valves')
  } else {
    add('CV1', 'Steam control valve', 'pct', 'valves', { cmd: true })
    add('CV1_FB', 'Steam control valve feedback', 'pct', 'valves')
  }
  if (P.bypass) {
    add('BYP', 'HW bypass valve', 'pct', 'valves', { cmd: true })
    add('BYP_FB', 'HW bypass valve feedback', 'pct', 'valves')
  }
  // ---- exchangers ----
  for (let i = 1; i <= P.exchangers; i++) {
    add(`HX${i}_ISO1`, `HX-${i} isolation valve 1`, 'pct', `hx${i}`, { cmd: true, hx: i })
    add(`HX${i}_ISO2`, `HX-${i} isolation valve 2`, 'onoff', `hx${i}`, { cmd: true, hx: i })
    add(`HX${i}_RT`, `HX-${i} runtime`, 'h', `hx${i}`, { hx: i })
    if (P.program) {
      add(`HXS${i}`, `HXS${i}`, 'raw', `hx${i}`, { hx: i, unclear: true })
      add(`HXVS${i}`, `HXVS${i}`, 'raw', `hx${i}`, { hx: i, unclear: true })
      add(`HXR${i}`, `HXR${i}`, 'raw', `hx${i}`, { hx: i, unclear: true })
    }
  }
  // ---- pumps ----
  for (let i = 1; i <= P.pumps; i++) {
    add(`P${i}_SS`, `Pump ${i} start/stop`, 'onoff', `p${i}`, { cmd: true, pump: i })
    if (P.pumpProof) add(`P${i}_STS`, `Pump ${i} status`, 'onoff', `p${i}`, { pump: i })
    add(`P${i}_SVD`, `Pump ${i} speed`, 'pct', `p${i}`, { cmd: true, pump: i })
    add(`P${i}_FLT`, `Pump ${i} fault`, 'alm', `p${i}`, { pump: i })
    add(`P${i}_OVR`, `Pump ${i} override timer`, 'min', `p${i}`, { cmd: true, pump: i })
    add(`P${i}_RT`, `Pump ${i} runtime`, 'h', `p${i}`, { pump: i })
    if (P.program && i <= 2) {
      add(`PVC${i}`, `PVC${i}`, 'raw', `p${i}`, { pump: i, unclear: true })
      add(`PVR${i}`, `PVR${i}`, 'raw', `p${i}`, { pump: i, unclear: true })
    }
  }
  // ---- program values (the panel's own control logic) ----
  if (P.program) {
    add('HXLL', 'HXLL', 'raw', 'program', { unclear: true })
    add('HXV', 'HXV', 'raw', 'program', { unclear: true, note: 'the panel reports this point in m²' })
    add('PVL', 'PVL', 'raw', 'program', { unclear: true })
    add('PLL', 'PLL', 'raw', 'program', { unclear: true })
    add('HXT_PG', 'HX temp loop P gain', 'gain', 'program', { cmd: true })
    add('HXT_IG', 'HX temp loop I gain', 'gain', 'program', { cmd: true })
    add('DP_PG', 'dP loop P gain', 'gain', 'program', { cmd: true })
    add('DP_IG', 'dP loop I gain', 'gain', 'program', { cmd: true })
  }
  return out
}

/** Every point symbol of a plant, in the order its point list shows them. */
export const hhwSymbols = (config) => (isHhw(config) ? hhwPoints(config).map((p) => p.sym) : [])

/** The raw-named points, with what the name suggests — for the user to confirm. */
export const UNCLEAR = {
  HXS: 'HXS<n>: per exchanger, % — maybe the HX\'s valve signal/share or a status; shown as the raw name',
  HXVS: 'HXVS<n>: per exchanger, % — maybe the HX valve setpoint or valve select; shown as the raw name',
  HXR: 'HXR<n>: per exchanger, % — maybe a ramp or reset value; shown as the raw name',
  PVC: 'PVC<n>: per pump, % — maybe the pump VFD command before ramping; shown as the raw name',
  PVR: 'PVR<n>: per pump, % — maybe the pump VFD ramp output; shown as the raw name',
  PVL: 'PVL: % — maybe the pump VFD low limit / minimum speed; shown as the raw name',
  PLL: 'PLL: unitless — likely pump lead/lag selection (which pump leads); shown as the raw name',
  HXLL: 'HXLL: unitless — likely heat exchanger lead/lag selection; shown as the raw name',
  HXV: 'HXV: reports m² (wrong unit) — maybe a combined HX valve output; shown as the raw name',
  ISO: 'HX<n>.ISO1 (AO, %) / HX<n>.ISO2 (BO): both drawn as the exchanger hot-water isolation valves — ISO1 on the return (inlet), ISO2 on the supply (outlet); which side each is on is not confirmed',
}

/** A new plant config. */
export function hhwConfig(plant = {}, { tag = 'HX' } = {}) {
  return {
    tag, service: 'Heating Hot Water Plant', kind: 'hx', shell: 'plant',
    inletLabel: 'PRIMARY', outletLabel: 'HW SUPPLY →',
    plant: plantOf({ plant }),
  }
}

/** Suffix → symbol for the 3D bridge (HHW.<symbol>). */
export function hhwSuffixMap(config) {
  const map = new Map()
  for (const p of hhwPoints(config)) map.set(`HHW.${p.sym}`, { sym: p.sym, pt: p })
  return { map, rhAfterFans: false }
}

/** The Commander's words for a symbol. */
export function hhwHint(config, sym) {
  if (!isHhw(config)) return null
  const p = hhwPoints(config).find((x) => x.sym === sym)
  if (!p) return null
  const h = { label: p.label }
  const P = plantOf(config)
  if (/^P\d_SS$/.test(sym)) Object.assign(h, { role: 'pump-ss', proof: P.pumpProof ? sym.replace(/_SS$/, '_STS') : undefined })
  else if (/^P\d_SVD$/.test(sym)) h.role = 'speed'
  else if (/^(CV\d|BYP|HX\d_ISO1)$/.test(sym)) h.role = 'valve'
  else if (sym === 'SYS_ENA') h.role = 'enable'
  if (h.proof === undefined) delete h.proof
  return h
}
