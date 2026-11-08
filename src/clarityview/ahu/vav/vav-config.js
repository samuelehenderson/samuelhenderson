// vav-config.js — air-terminal config: variants, handles, inference, conversion.
// Pure (no DOM, no three.js); copied into graphics-kit/.
//
// A terminal is still kind: 'vav'. What it is lives in config.terminal
// (vav-spec §5.1); config.supply stays the point-binding list — one section per
// point-bearing part plus the zone (D4) — so Map points, automap, the Lab and
// every existing consumer keep working. A VAV without config.terminal is a
// legacy unit: it is never rewritten; terminalOf() infers what it is.
//
// Frozen API (integration plan §3.1): isTerminalShell, terminalOf,
// describeTerminal, vavServices keep the Wave 0 signatures and shapes.

import { VAV_TYPES, REHEAT_SHORT, VAV_POINT_KEYS } from './vav-types.js'
import { sizesFor, unitSizesFor, DIM_DICTIONARY } from './vav-geometry.js'

/** Per-box fields: a Lab template push keeps each box's own values (vav-spec §5.6). */
export const PER_BOX_FIELDS = ['size', 'sizeSet', 'unitSize', 'hand', 'geometry', 'nameplate', 'mount']

/** Hang height: 9'-0" ceiling + 2" clearance to the box bottom (user decision). */
export const DEFAULT_MOUNT = Object.freeze({ ceiling: 2.743, gap: 0.05 })

export const DEFAULT_OPTIONS = Object.freeze({
  airValve: true, attenuator: false, heatRows: 1, heatStages: 2, scr: false, connHand: null, valveOn: 'return', valveAction: 'modulating',
  fanMotor: 'ecm', fanControl: 'constant', fanSpeedOut: false, inducedFace: null, coilAt: null,
  changeover: false, damperAction: 'nc', damperDir: 'cw', damperRot: 90, mixer: 'standard', flowSensors: 'inlets',
})
const OPTION_VALUES = {
  airValve: [true, false], attenuator: [true, false], scr: [true, false], changeover: [true, false], fanSpeedOut: [true, false],
  connHand: [null, 'same', 'opposite'], valveOn: ['return', 'supply'], valveAction: ['modulating', 'two-position'],
  fanMotor: ['ecm', 'psc'], fanControl: ['constant', 'variable'], inducedFace: [null, 'end', 'side', 'bottom'],
  coilAt: [null, 'discharge', 'fan-inlet'], damperAction: ['nc', 'no'], damperDir: ['cw', 'ccw'], damperRot: [90, 45],
  mixer: ['standard', 'high'], flowSensors: ['inlets', 'cold+discharge'],
}
const FAMILY_KEYS = ['dxr2', 'dxr1', 'tec']
const LEGACY_MODES = ['—', 'Comfort', 'Standby', 'Economy', 'Protection']

const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o)
const clone = (o) => JSON.parse(JSON.stringify(o))
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const sizeNum = (s) => parseFloat(String(s)) || 0

/** True for a VAV that carries the new terminal description (config.terminal). */
export function isTerminalShell(config) {
  return config?.kind === 'vav' && !!config.terminal
}

/**
 * A complete, valid terminal from whatever is stored: unknown type → single
 * duct, disallowed reheat → the type's default, size not offered → nearest,
 * enums clamped, missing options → defaults. Never mutates or writes back.
 */
export function normalizeTerminal(t0) {
  const t = isObj(t0) ? t0 : {}
  const type = VAV_TYPES[t.type] ? t.type : 'single-duct'
  const T = VAV_TYPES[type]
  const reheat = T.reheat.includes(t.reheat) ? t.reheat : T.defaultReheat
  const ctl = isObj(t.controller) ? t.controller : {}
  const family = FAMILY_KEYS.includes(ctl.family) ? ctl.family : 'dxr2'
  const geometrySet = typeof t.geometrySet === 'string' && t.geometrySet ? t.geometrySet : null
  const sizes = sizesFor(type, geometrySet)
  let size = String(t.size ?? '8').trim().toLowerCase().replace(/\s*[×x]\s*/, 'x')
  if (sizes.length && !sizes.includes(size)) {
    const want = sizeNum(size)
    size = sizes.reduce((best, s) => (Math.abs(sizeNum(s) - want) < Math.abs(sizeNum(best) - want) ? s : best), sizes[0])
  }
  const options = { ...DEFAULT_OPTIONS }
  const o = isObj(t.options) ? t.options : {}
  for (const k of Object.keys(DEFAULT_OPTIONS)) {
    if (!(k in o)) continue
    if (k === 'heatRows') options[k] = Math.max(1, Math.min(4, Math.round(Number(o[k]) || 1)))
    else if (k === 'heatStages') options[k] = Math.max(1, Math.min(3, Math.round(Number(o[k]) || 2)))
    else if (OPTION_VALUES[k].includes(o[k])) options[k] = o[k]
  }
  const us = unitSizesFor(type, geometrySet)
  let unitSize = t.unitSize != null ? String(t.unitSize) : null
  if (unitSize && !(us.rows[unitSize] && (us.rows[unitSize].inlets || []).map(String).includes(size))) unitSize = null
  const geometry = {}
  if (isObj(t.geometry)) for (const [k, v] of Object.entries(t.geometry)) if (DIM_DICTIONARY[k] && finite(v) != null && v >= 0) geometry[k] = v
  const np = isObj(t.nameplate) ? t.nameplate : {}
  const m = isObj(t.mount) ? t.mount : {}
  const enc = isObj(t.enclosure) ? t.enclosure : {}
  const out = {
    v: 1, type, reheat,
    controller: { family, model: typeof ctl.model === 'string' && ctl.model ? ctl.model : null },
    enclosure: { mount: 'side', style: ['open', 'closed', 'none'].includes(enc.style) ? enc.style : 'open' },
    geometrySet, options,
    size, sizeSet: t.sizeSet !== false, unitSize, hand: t.hand === 'L' ? 'L' : 'R', geometry,
    nameplate: { maxCfm: finite(np.maxCfm), minCfm: finite(np.minCfm), fanCfm: finite(np.fanCfm) },
    mount: { ceiling: finite(m.ceiling) ?? DEFAULT_MOUNT.ceiling, gap: finite(m.gap) ?? DEFAULT_MOUNT.gap },
  }
  if (t.inferred) out.inferred = true
  return out
}

// ---------------------------------------------------------------------------
// Sections: the default handles for a terminal (vav-spec §3.2)
// ---------------------------------------------------------------------------

function inletSections(t) {
  const tec = t.controller.family === 'tec'
  const heatV = t.reheat !== 'none'
  if (t.type === 'exhaust') {
    return [{ device: 'vavinlet', label: 'Exhaust Air Valve', duct: 'exhaust', point: 'EX_DMPR', posPoint: 'EX_DMPR_POS', posCalc: null,
      flowPoint: 'EX_FLOW', flowSpPoint: 'EX_FLOW_SP', flowSpWritable: false, flowSpUnits: 'cfm', clgMinPoint: 'EX_MIN', clgMaxPoint: 'EX_MAX' }]
  }
  if (t.type === 'dual-duct-mixing' || t.type === 'dual-duct-nonmixing') {
    const outlet = t.options.flowSensors === 'cold+discharge'
    const cold = { device: 'vavinlet', label: 'Cold Duct Valve', duct: 'cold', point: 'CLG_DMPR', posPoint: 'CLG_DMPR_POS', posCalc: null,
      flowPoint: 'CLG_FLOW', flowSpPoint: 'CLG_FLOW_SP', flowSpWritable: false, flowSpUnits: 'cfm', clgMaxPoint: 'CLG_FLOW_MAX', totMinPoint: 'TOT_FLOW_MIN' }
    const hot = { device: 'vavinlet', label: 'Hot Duct Valve', duct: 'hot', point: 'HTG_DMPR', posPoint: 'HTG_DMPR_POS', posCalc: null }
    if (outlet) Object.assign(cold, { totFlowPoint: 'TOT_FLOW', totFlowSpPoint: 'TOT_FLOW_SP', totMaxPoint: 'TOT_FLOW_MAX' })
    else Object.assign(hot, { flowPoint: 'HTG_FLOW', flowSpPoint: 'HTG_FLOW_SP', flowSpWritable: false, flowSpUnits: 'cfm', htgMaxPoint: 'HTG_FLOW_MAX' })
    // TEC dual-duct active limits per inlet: names UNVERIFIED
    if (tec) { Object.assign(cold, { ctlMinPoint: 'CLG_CTL_MIN', ctlMaxPoint: 'CLG_CTL_MAX' }); Object.assign(hot, { ctlMinPoint: 'HTG_CTL_MIN', ctlMaxPoint: 'HTG_CTL_MAX' }) }
    return [cold, hot]
  }
  if (!t.options.airValve) return []   // valve-only box: collar, no damper, no flow sensor
  const s = { device: 'vavinlet', label: 'Primary Air Valve', duct: 'primary', point: 'DMPR', posPoint: 'DMPR_POS', posCalc: null, flowPoint: 'AIRFLOW' }
  if (t.type === 'constant-volume') return [Object.assign(s, { occFlowPoint: 'OCC_FLOW', unoccFlowPoint: 'UNOCC_FLOW' })]
  if (tec) Object.assign(s, { flowSpPoint: 'FLOW_STPT', flowSpWritable: false, flowSpUnits: '%', ctlMinPoint: 'CTL_MIN', ctlMaxPoint: 'CTL_MAX' })
  else Object.assign(s, { flowSpPoint: 'AIRFLOW_SP', flowSpWritable: false, flowSpUnits: 'cfm' })
  Object.assign(s, { clgMinPoint: 'CLG_MIN', clgMaxPoint: 'CLG_MAX' })
  if (heatV) s.htgMaxPoint = 'HTG_MAX'
  return [s]
}

function fanSection(t) {
  if (!VAV_TYPES[t.type].fan) return null
  const tec = t.controller.family === 'tec'
  const f = { device: 'fan', role: 'fpb', label: 'Fan', count: 1, fanType: 'housed-centrifugal', cmdPoint: 'FAN_CMD', proofDelayS: 30 }
  if (!tec) f.statusPoint = 'FAN_STS'                         // DXR2 FPB proof name UNVERIFIED; TEC has none
  if (tec ? t.options.fanSpeedOut : t.options.fanMotor === 'ecm') f.speedPoint = 'FAN_SPD'
  return f
}

function reheatSection(t) {
  if (t.reheat === 'hw') return { device: 'coil', role: 'reheat', label: 'Reheat Coil', variant: 'heat', point: 'RHV', valve: true, valveType: '2way', valveAction: t.options.valveAction }
  if (t.reheat === 'elec') {
    const e = { device: 'eheat', label: 'Electric Heat', stages: t.options.scr ? 0 : t.options.heatStages, scr: !!t.options.scr }
    if (t.options.scr) e.scrPoint = 'EH_SCR'
    else for (let i = 1; i <= t.options.heatStages; i++) e[`stage${i}Point`] = `EH${i}`
    return e
  }
  return null
}

function zoneSection(t) {
  if (!VAV_TYPES[t.type].zone) return null
  const tec = t.controller.family === 'tec'
  const z = { device: 'zone', label: 'Zone / Room', tempPoint: 'ZNT', spDisplay: 'ZNSP_EFF' }
  if (tec) Object.assign(z, { clgSpPoint: 'CLG_SP', htgSpPoint: 'HTG_SP' })
  else z.spCommand = 'ZNSP'
  z.occPoint = 'OCC'
  if (tec) z.occInvert = true                                     // DAY.NGT: active = NIGHT
  Object.assign(z, { co2Point: 'CO2', humPoint: 'RH' })
  if (tec) Object.assign(z, { modeDisplay: 'HEAT_COOL', modeStates: ['COOL', 'HEAT'], modeLabel: 'Heat/cool' })
  else Object.assign(z, { modeDisplay: 'MODE_EFF', modeCommand: 'MODE', modeStates: [...LEGACY_MODES] })
  Object.assign(z, { spMin: 60, spMax: 85, spDecimals: 1, spLabel: 'Room Setpoint', roomUnit: { model: null } })
  return z
}

function sensorList(t) {
  const out = []
  if (t.reheat !== 'none') out.push({ tag: 'DAT', label: 'Discharge Air', at: 'discharge' })
  if (t.options.changeover) out.push({ tag: 'PAT', label: 'Primary Air', at: 'primary' })
  return out
}

function buildSections(t) {
  const supply = [...inletSections(t), fanSection(t), reheatSection(t), zoneSection(t)].filter(Boolean)
  return { supply, sensors: sensorList(t) }
}

/** Stored form of a terminal (normalised, without the inferred flag). */
function stored(t) {
  const { inferred, ...rest } = t
  return clone(rest)
}

/** 'Single duct · HW reheat' — the unit's service line. */
export function serviceOf(t) {
  return `${VAV_TYPES[t.type].short} · ${REHEAT_SHORT[t.reheat]}`
}

/**
 * A new terminal config. opts: { reheat, size, unitSize, hand, family, model,
 * options, geometrySet, tag } — anything omitted takes the type's default.
 */
export function vavConfig(type = 'single-duct', opts = {}) {
  const t = normalizeTerminal({
    type, reheat: opts.reheat, size: opts.size, unitSize: opts.unitSize, hand: opts.hand, geometrySet: opts.geometrySet,
    controller: { family: opts.family, model: opts.model }, options: opts.options, sizeSet: opts.sizeSet,
  })
  const { supply, sensors } = buildSections(t)
  return { tag: opts.tag || 'VAV', service: serviceOf(t), kind: 'vav', inletLabel: 'PRIMARY', outletLabel: 'TO ZONE →', terminal: stored(t), supply, sensors }
}

// ---------------------------------------------------------------------------
// Reading a config
// ---------------------------------------------------------------------------

/** What a legacy VAV (no config.terminal) is, from its sections. Fresh object; input untouched. */
export function inferTerminal(config) {
  const supply = config?.supply || []
  const stations = config?.airStations || []
  const hasFan = supply.some((it) => it.device === 'fan')
  const heatCoil = supply.some((it) => it.device === 'coil' && it.variant !== 'cool')
  const airValve = supply.some((it) => it.device === 'damper') || stations.some((s) => s.tag === 'SACFM' || s.tag === 'OACFM')
  return normalizeTerminal({
    type: hasFan ? 'series-fan' : 'single-duct', reheat: heatCoil ? 'hw' : 'none',
    options: { airValve }, size: '8', hand: 'R', sizeSet: false, controller: { family: 'dxr2' }, inferred: true,
  })
}

/** The normalised (or inferred) terminal of a VAV config, or null. Never mutates its input. */
export function terminalOf(config) {
  if (config?.kind !== 'vav') return null
  return config.terminal ? normalizeTerminal(config.terminal) : inferTerminal(config)
}

/** One line for lists and side panels, e.g. 'Single duct · HW reheat · 8 in · controls right', or null (not known). */
export function describeTerminal(config) {
  const t = terminalOf(config)
  if (!t) return null
  const parts = [VAV_TYPES[t.type].short, REHEAT_SHORT[t.reheat]]
  if (t.sizeSet) {
    const nom = /x/.test(t.size) ? t.size.replace('x', ' × ') : t.size
    const us = VAV_TYPES[t.type].fan ? unitSizesFor(t.type, t.geometrySet) : null
    const u = us && us.keys.length ? (t.unitSize || us.keys.find((k) => (us.rows[k].inlets || []).map(String).includes(t.size))) : null
    parts.push(`${nom} in${u ? ` (unit ${u})` : ''}`)
  }
  if (!t.inferred) parts.push(`controls ${t.hand === 'L' ? 'left' : 'right'}`)
  if (!t.options.airValve) parts.push('no damper')
  return parts.join(' · ')
}

/**
 * What a terminal needs from the building's services, or null (not known — callers fall back).
 * { air: 'supply' | 'exhaust' | 'none', airInlets: 1 | 2, hw: boolean }
 */
export function vavServices(config) {
  const t = terminalOf(config)
  if (!t) return null
  const ducts = VAV_TYPES[t.type].ducts
  const hw = config.terminal ? t.reheat === 'hw' : (config.supply || []).some((it) => it.device === 'coil' && it.variant !== 'cool')
  return { air: t.type === 'exhaust' ? 'exhaust' : 'supply', airInlets: ducts.length === 2 ? 2 : 1, hw }
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

/** The handles a VAV-specific section carries beyond the generic keys symbolsOf reads. */
export function vavSymbols(it) {
  if (!it || typeof it !== 'object') return []
  const keys = it.device === 'vavinlet' ? VAV_POINT_KEYS.vavinlet
    : it.device === 'eheat' ? VAV_POINT_KEYS.eheat
      : it.device === 'zone' ? ['clgSpPoint', 'htgSpPoint']
        : it.device === 'coil' ? ['posPoint'] : []
  const out = []
  for (const k of keys) if (typeof it[k] === 'string' && it[k] && !out.includes(it[k])) out.push(it[k])
  return out
}

/** Every handle of a VAV config, in section order (same set as ahu-view symbolsOf). */
export function terminalSymbols(config) {
  const out = []
  const push = (s) => { if (s && typeof s === 'string' && !out.includes(s)) out.push(s) }
  for (const it of [...(config?.supply || []), ...(config?.return || [])]) {
    push(it.point); push(it.pumpPoint)
    if (it.device === 'zone') for (const k of VAV_POINT_KEYS.zone) push(it[k])
    if (it.device === 'fan') {
      const specs = Array.isArray(it.fans) && it.fans.length ? it.fans : [{ cmd: it.cmdPoint, status: it.statusPoint, speed: it.speedPoint, fault: it.faultPoint }]
      for (const s of specs) { push(s.cmd); push(s.status); push(s.speed); push(s.fault) }
    }
    for (const s of vavSymbols(it)) push(s)
  }
  for (const s of config?.sensors || []) push(s.tag)
  for (const st of config?.airStations || []) push(st.tag)
  push(config?.supplyStatic?.point); push(config?.economizer?.point); push(config?.setpoint?.point)
  return out
}

// ---------------------------------------------------------------------------
// Changing a terminal, converting a legacy VAV, Lab merge
// ---------------------------------------------------------------------------

/** Role key: which old section a new one inherits from (primary ≡ cold, vav-spec §5.5). */
function roleKey(it) {
  if (it.device === 'vavinlet') return 'vavinlet:' + (it.duct === 'cold' || !it.duct ? 'primary' : it.duct)
  if (it.device === 'coil') return it.variant === 'cool' ? 'coil:cool' : 'coil:reheat'
  if (it.device === 'eheat') return 'eheat'
  if (it.device === 'fan') return 'fan:fpb'
  if (it.device === 'zone') return 'zone'
  return null
}
const HANDLE_KEY = /Point$|^point$|^spDisplay$|^spCommand$|^modeDisplay$|^modeCommand$/
const ZONE_KEEP = ['spMin', 'spMax', 'spDecimals', 'spLabel', 'modeStates', 'modeLabel', 'roomUnit', 'occInvert', 'occLabels', 'tempLabel']
const SECTION_KEEP = ['label', 'actuator', 'valveModel', 'valveSpec', 'posCalc', 'flowSpWritable', 'valveType', 'proofDelayS', 'kw']

/**
 * Change a terminal (type, reheat, size, family…) keeping every surviving handle
 * and its mapping. Returns { config, added, removed } (handles); nothing saved.
 */
export function setTerminal(config, patch = {}) {
  const cur = terminalOf(config) || normalizeTerminal({})
  const { inferred, ...base } = cur
  const next = normalizeTerminal({
    ...base, ...patch,
    controller: { ...base.controller, ...(patch.controller || {}) },
    options: { ...base.options, ...(patch.options || {}) },
    enclosure: { ...base.enclosure, ...(patch.enclosure || {}) },
    sizeSet: patch.sizeSet ?? (patch.size != null ? true : base.sizeSet),
  })
  const fresh = buildSections(next)
  const old = config?.supply || []
  const used = new Set()
  for (const it of fresh.supply) {
    const key = roleKey(it)
    const prev = old.find((o, i) => !used.has(i) && roleKey(o) === key && (used.add(i) || true))
    if (!prev) continue
    for (const k of Object.keys(it)) if (HANDLE_KEY.test(k) && typeof prev[k] === 'string' && prev[k]) it[k] = prev[k]
    for (const k of SECTION_KEEP) if (prev[k] !== undefined) it[k] = clone(prev[k])
    if (it.device === 'zone') {
      // occupancy polarity and mode names belong to the controller family: kept
      // only while the family stays TEC (or stays DXR); a family change takes the new defaults
      const sameKind = (cur.controller.family === 'tec') === (next.controller.family === 'tec')
      for (const k of ZONE_KEEP) {
        if (prev[k] === undefined) continue
        if (!sameKind && (k === 'occInvert' || k === 'modeStates' || k === 'modeLabel')) continue
        it[k] = clone(prev[k])
      }
    }
  }
  // sensors: the same role keeps its old tag (a renamed DAT stays renamed)
  const oldSensors = config?.sensors || []
  const sensorRole = (s) => (s.at === 'discharge' || (s.tag === 'DAT' && s.at !== 'primary') ? 'dat' : s.at === 'primary' || s.tag === 'PAT' ? 'pat' : null)
  const sensors = fresh.sensors.map((s) => {
    const prev = oldSensors.find((o) => sensorRole(o) === sensorRole(s))
    return prev ? { ...s, tag: prev.tag, label: prev.label || s.label } : s
  })
  const out = clone(config || {})
  const autoService = cur && serviceOf(cur) === config?.service
  out.kind = 'vav'
  out.terminal = stored(next)
  out.supply = fresh.supply
  out.sensors = sensors
  if (!out.service || autoService) out.service = serviceOf(next)
  const before = terminalSymbols(config || {}), after = terminalSymbols(out)
  return { config: out, added: after.filter((s) => !before.includes(s)), removed: before.filter((s) => !after.includes(s)) }
}

/**
 * Convert a legacy VAV to a terminal shell (the Convert action; the button is a
 * later pass). Every handle is kept; nothing is saved here.
 */
export function upgradeVav(config, { size = '8', hand = 'R' } = {}) {
  const inf = inferTerminal(config)
  const { inferred, ...t0 } = inf
  const t = normalizeTerminal({ ...t0, size, hand, sizeSet: true })
  const out = clone(config)
  const supply = []
  const stations = [...(out.airStations || [])]
  const flowSt = stations.find((s) => s.tag === 'SACFM' || s.tag === 'OACFM')
  const damper = (out.supply || []).find((it) => it.device === 'damper')
  if (damper || flowSt) {
    const inlet = { device: 'vavinlet', label: damper?.label || 'Primary Air Valve', duct: 'primary', posCalc: null }
    if (damper?.point) inlet.point = damper.point
    if (flowSt) { inlet.flowPoint = flowSt.tag; stations.splice(stations.indexOf(flowSt), 1) }
    supply.push(inlet)
  }
  for (const it of out.supply || []) {
    if (it.device === 'plenum' || it === damper || (damper && it.device === 'damper' && it.point === damper.point)) continue
    if (it.device === 'coil' && it.variant !== 'cool') { supply.push({ ...it, role: 'reheat' }); continue }
    if (it.device === 'fan') { supply.push({ ...it, role: 'fpb' }); continue }
    if (it.device === 'zone') { supply.push({ ...it, roomUnit: it.roomUnit || { model: null } }); continue }
    supply.push(it)
  }
  out.supply = supply
  out.sensors = (out.sensors || []).map((s) => (s.tag === 'DAT' || /reheat/i.test(s.after || '')) && !s.at ? { tag: s.tag, label: s.label, at: 'discharge' } : s)
  if (stations.length) out.airStations = stations; else delete out.airStations
  out.terminal = stored(t)
  return out
}

/**
 * A template pushed onto a box (Lab): the template's type-level fields win; the
 * box keeps its per-box fields (size, hand, geometry, nameplate, mount). A box
 * without a terminal takes the template's per-box fields marked size-not-set.
 */
export function mergeTerminal(templateCfg, boxCfg) {
  const out = clone(templateCfg)
  if (!isTerminalShell(out)) return out
  if (isTerminalShell(boxCfg)) {
    for (const k of PER_BOX_FIELDS) if (boxCfg.terminal[k] !== undefined) out.terminal[k] = clone(boxCfg.terminal[k])
    out.terminal = stored(normalizeTerminal(out.terminal))
  } else {
    out.terminal.sizeSet = false
  }
  return out
}
