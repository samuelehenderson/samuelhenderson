// select.js — which Siemens part a unit gets by default. Pure; imports only
// ./catalog.js, so the main bundle (buildings.js, the unit editor, the 3D
// bridge) may use it.
//
// OWNER: SIEMENS (siemens-spec.md §3.2, I-2, as amended by the Pass 1
// integration plan §3). The Wave 0 signatures of roomUnitOf, roomUnitPick,
// controllerOf, controllerFamily and SIEMENS_DEFAULTS are frozen.
//
// Part choices follow the US catalogue 536-753A and the technical instructions
// cited in siemens-spec.md §3.3. Damper sizing: 4 lb-in per ft² of damper
// (331-547 p.B-2), GCA TI 155-173P25 Table 2 for tandem and master/slave.

import { ROOM_UNIT_MODELS, ROOM_UNIT_DEFAULT_H, PL_LINK } from './catalog.js'

/**
 * House defaults. VAV: the actuating DXR2 sits on the damper shaft; a box with
 * no shaft gets the E12P on its casing; a GDE131.1P drives the damper only when
 * the controller does not.
 */
export const SIEMENS_DEFAULTS = Object.freeze({
  vav: Object.freeze({ controller: 'DXR2.E10PL-102B', controllerNoShaft: 'DXR2.E12P-102B', damper: 'GDE131.1P', sensor: 'QAM2130.040' }),
  fcu: Object.freeze({ controller: 'DXR2.E18-101B', damper: 'GQD151.1P', sensor: 'QAM2130.040' }),
  ahu: Object.freeze({ temp: 'QAM2161.040', rh: 'QFM3160', co2: 'QPM2160', flow: 'QVM62.1-HU', mixed: 'QAM2120.600', coil: 'QAM2120.200', filter: 'SETRA-264-1', static: 'SETRA-264-5', frz: '134-1504' }),
})

/** Device roles (what a device does, whatever part fills it). */
export const ROLES = Object.freeze([
  'ahu.oa.temp', 'ahu.oa.rh', 'ahu.oa.flow', 'ahu.ma.temp', 'ahu.filter.dp', 'ahu.coil.lat', 'ahu.frz',
  'ahu.valve.heat', 'ahu.valve.cool', 'ahu.damper.oa', 'ahu.damper.ea', 'ahu.damper.ra',
  'ahu.sa.temp', 'ahu.sa.static', 'ahu.sa.flow', 'ahu.sa.rh', 'ahu.ra.temp', 'ahu.ra.rh', 'ahu.ra.co2', 'ahu.ra.flow',
  'ahu.ea.temp', 'ahu.ea.flow',
  'term.controller', 'term.damper', 'term.valve', 'term.dat', 'term.pri.temp', 'term.ent.temp', 'zone.roomUnit',
])

const zoneOf = (config) => (config?.supply || []).find((it) => it.device === 'zone') || null

/** The controller part a unit declares (VAV: config.terminal.controller.model), else the house default, else null. */
export function controllerOf(config) {
  return config?.terminal?.controller?.model ?? config?.fieldDevices?.controller ?? SIEMENS_DEFAULTS[config?.kind]?.controller ?? null
}

/** 'dxr2' | 'dxr1' | 'tec' | 'other' | null (null = nothing declared). */
export function controllerFamily(part) {
  if (!part) return null
  const p = String(part).toUpperCase()
  if (p.startsWith('DXR2')) return 'dxr2'
  if (p.startsWith('DXR1')) return 'dxr1'
  if (/^(A?TEC|PTEC)\b|^5[45]\d-/.test(p) || p.includes('TEC')) return 'tec'
  return 'other'
}

/**
 * The room unit a unit's zone gets: { model, caps, color, logo, h, family, compat } | null.
 * null when there is no zone, the zone says model 'none', or the unit is a CRAC.
 * An explicit zone.roomUnit.model always wins. TEC / ATEC / PTEC → QAA2280.FWSC.
 * DXR (or nothing declared) → QMX3 by the zone's points: CO₂ → P74, RH only → P44, else P34.
 * Any other controller → QMX3 by points with compat: false (QMX3 on a US PXC job is UNVERIFIED).
 */
export function roomUnitOf(config) {
  if (!config || config.kind === 'crac') return null
  const zone = zoneOf(config)
  if (!zone) return null
  const ru = zone.roomUnit || {}
  if (ru.model === 'none') return null
  const family = config.terminal?.controller?.family ?? controllerFamily(controllerOf(config))
  let model = ru.model || null
  let compat = true
  if (!model) {
    if (family === 'tec') model = 'QAA2280.FWSC'
    else {
      model = zone.co2Point ? 'QMX3.P74' : zone.humPoint ? 'QMX3.P44' : 'QMX3.P34'
      if (family === 'other') compat = false
    }
  }
  const rec = ROOM_UNIT_MODELS.find((m) => m.model === model)
  const caps = rec ? [...rec.caps] : ['T']
  const color = ru.color === 'black' ? 'black' : 'white'
  const logo = rec?.logoFree && color === 'white' ? ru.logo !== false : true
  const h = Number.isFinite(Number(ru.h)) && ru.h != null ? Number(ru.h) : ROOM_UNIT_DEFAULT_H
  return { model, caps, color, logo, h, family: family ?? null, compat }
}

const CAP_WORDS = { T: 'temp', RH: 'RH', CO2: 'CO₂' }

/**
 * What a click on a placed room unit opens (COMMAND routes it; ZNT first).
 * dev: the placement device record; entry: { name, config, has(sfx) } of the owning unit.
 */
export function roomUnitPick(dev, entry, roomName) {
  const ru = roomUnitOf(entry?.config)
  const model = dev?.model && dev.model !== 'none' ? dev.model : (ru?.model ?? 'QMX3.P34')
  const caps = ROOM_UNIT_MODELS.find((m) => m.model === model)?.caps ?? ['T']
  const has = (s) => !!entry?.has?.(s)
  const points = ['ZNT', has('ZNSP.CMD') ? 'ZNSP.CMD' : 'ZNSP', has('MODE.CMD') ? 'MODE.CMD' : 'MODE', 'OCC']
  if (caps.includes('RH')) points.push('ZNH')
  if (caps.includes('CO2')) points.push('CO2')
  return {
    title: `${roomName || 'Room'} · ${model}`,
    points: points.filter(has),
    context: {
      title: `Room unit · ${entry?.name ?? ''}`.trim(),
      device: `Siemens ${model} · room unit, ${caps.map((c) => CAP_WORDS[c] || c).join(' / ')}`,
    },
    source: 'room-unit',
  }
}

// ---- sensors ----------------------------------------------------------------

const KINDS = new Set(['temp', 'rh', 'co2', 'static', 'flow', 'frz'])

/**
 * What a configured sensor measures: 'temp' | 'rh' | 'co2' | 'static' | 'flow' | 'frz'.
 * An explicit kind wins, then the unit, then the tag, then the label; else temp
 * (today's meaning). A bare "RH" is never read from a label (there it means reheat).
 */
export function sensorKind(s) {
  if (!s) return 'temp'
  if (KINDS.has(s.kind)) return s.kind
  const u = String(s.unit || '').trim().toUpperCase()
  if (u === '%RH' || u === '%') return 'rh'
  if (u === 'PPM') return 'co2'
  const t = String(s.tag || '').trim().toUpperCase()
  if (/^(OA|RA|SA|DA|EA|RM|ZN|SPC)?[ ._-]?(RH|HUM)$/.test(t) || ['OAH', 'RAH', 'SAH', 'RMH', 'ZNH'].includes(t)) return 'rh'
  if (t.includes('CO2')) return 'co2'
  if (/^(FRZ|LTD)([ ._-]?\d*)$|^(FRZ|FREEZE)[ ._-]?STAT$|^LOW[ ._-]?LIM(IT)?$/.test(t)) return 'frz'
  const l = String(s.label || '')
  if (/HUMID|%\s*RH|REL(ATIVE)?\s*HUM/i.test(l)) return 'rh'
  if (/CO2|CO₂/i.test(l)) return 'co2'
  return 'temp'
}

/** Is a sensor (or air station) on the return side? */
export function onReturn(s) {
  return s?.deck === 'return' || /^(ra|ret|return)$/i.test(String(s?.at || ''))
}

/**
 * The 3D suffix a non-temperature sensor maps to (ahu3d-bridge.js), or null.
 * FRZ / LTD read 1 = tripped everywhere: the default tripWhen 'inactive' (normally
 * closed) inverts the contact; tripWhen 'active' passes it through.
 * → { sfx, derive? } | null
 */
export function kindSuffix(s, kind = sensorKind(s)) {
  const tag = String(s?.tag || '').toUpperCase()
  const ret = onReturn(s)
  if (kind === 'rh') {
    if (tag === 'RMH') return { sfx: 'RMH' }
    if (s.at === 'oa') return { sfx: 'OAH' }
    if (s.at === 'sa') return { sfx: 'SAH' }
    return ret ? { sfx: 'RAH' } : null
  }
  if (kind === 'co2') return ret ? { sfx: 'RA.CO2' } : null
  if (kind === 'frz') {
    // usually wired normally closed: BI 1 = normal, 0 = tripped (tripWhen 'inactive', the default); 'active' per point
    const sfx = /^LTD/.test(tag) ? 'LTD' : 'FRZ'
    return s.tripWhen === 'active' ? { sfx } : { sfx, derive: (v) => (v ? 0 : 1) }
  }
  if (kind === 'static') return { sfx: 'SSP' }
  if (kind === 'flow') return s.at === 'oa' ? { sfx: 'OA.CFM' } : s.at === 'sa' ? { sfx: 'SA.CFM' } : ret ? { sfx: 'RA.FLW' } : null
  return null
}

/**
 * Renaming a section keeps its sensors attached: rewrite sensors[].after and
 * airStations[].after that pointed at the old label. Returns how many changed.
 */
export function renameSectionRefs(config, from, to) {
  if (!config || !from || from === to) return 0
  let n = 0
  for (const list of [config.sensors, config.airStations]) {
    for (const s of list || []) if (s && s.after === from) { s.after = to; n++ }
  }
  return n
}

// ---- dampers ----------------------------------------------------------------

/** lb-in of torque per ft² of damper (331-547 p.B-2). The damper maker's rating should override it. */
export const LBIN_PER_FT2 = 4

/**
 * OpenAir actuators for a damper of `areaFt2` (GCA TI 155-173P25 Table 2).
 * → { part, count, torqueLbIn, bracket?, ends?, masterSlave?, oversize? }
 * Mechanically coupled actuators are always the same part.
 */
export function actuatorFor(areaFt2, { binary = false } = {}) {
  const torque = Math.max(0, Number(areaFt2) || 0) * LBIN_PER_FT2
  const torqueLbIn = Math.round(torque)
  if (torque <= 62) return { part: binary ? 'GMA121.1U' : 'GMA161.1U', count: 1, torqueLbIn }
  if (torque <= 160) return { part: binary ? 'GCA121.1U' : 'GCA161.1U', count: 1, torqueLbIn }
  if (torque <= 320) return { part: binary ? 'GCA121.1U' : 'GCA161.1U', count: 2, torqueLbIn, bracket: binary ? 'ASK73.1' : 'ASK73.2U', ends: 1 }
  const count = Math.min(4, Math.ceil(torque / 160))
  // "tandem application tested for up to four actuators": two per shaft end, same shaft
  const out = binary
    ? { part: 'GCA121.1U', count, torqueLbIn, ends: 2 }
    : { part: 'GCA151.1U', count, torqueLbIn, masterSlave: true, ends: 2 }
  if (torque > 640) out.oversize = true
  return out
}

// ---- valves -----------------------------------------------------------------

const THREE_WAY = new Set(['3way', 'electric-3way'])
const GLOBE_OK = new Set([undefined, null, '', 'classic', '2way', '3way', 'electric-3way'])

/**
 * The valve package a coil section gets: a valveModel object, 'none', or null
 * when the section asks for a valve type this library does not draw yet
 * (ball, butterfly → the generic 3D valve stays).
 */
export function valveFor(section, unitKind) {
  if (!section) return null
  const vm = section.valveModel
  if (vm === 'none') return 'none'
  if (vm && typeof vm === 'object') return vm
  if (!GLOBE_OK.has(section.valveType)) return null
  const three = THREE_WAY.has(section.valveType)
  const heat = section.variant !== 'cool'
  if (unitKind === 'vav') {
    return three
      ? { family: 'globe', series: 'Powermite MZ', ports: 3, action: 'mix', size: '1/2', cv: 2.5, ends: 'npt', body: 'brass', actuator: { model: 'SSB131.09U', mount: 'bonnet5' } }
      : { family: 'globe', series: 'Powermite MT', ports: 2, action: 'NO', size: '1/2', cv: 2.5, ends: 'npt', body: 'brass', actuator: { model: 'SAS81.03U', mount: 'bonnet5' } }
  }
  if (unitKind === 'fcu') {
    return three
      ? { family: 'zone', series: '599 zone', ports: 3, action: 'div', size: '1/2', cv: 2.5, ends: 'npt', body: 'brass', actuator: { model: 'SSE131.09U', mount: 'zone' } }
      : { family: 'zone', series: '599 zone', ports: 2, action: 'NO', size: '1/2', cv: 2.5, ends: 'npt', body: 'brass', actuator: { model: 'SSE131.09U', mount: 'zone' } }
  }
  return {
    family: 'globe', series: 'Flowrite 599', ports: three ? 3 : 2, action: three ? 'mix' : 'NO', size: '2', cv: 40, ends: 'npt', body: 'bronze',
    actuator: { model: heat ? 'SKD62U' : 'SAX61.03U', mount: 'bonnet20' },
  }
}

// ---- defaults per role ----------------------------------------------------------

const AHU_ROLE = {
  'ahu.oa.temp': 'temp', 'ahu.sa.temp': 'temp', 'ahu.ra.temp': 'temp', 'ahu.ea.temp': 'temp',
  'ahu.oa.rh': 'rh', 'ahu.sa.rh': 'rh', 'ahu.ra.rh': 'rh', 'ahu.ra.co2': 'co2',
  'ahu.oa.flow': 'flow', 'ahu.sa.flow': 'flow', 'ahu.ra.flow': 'flow', 'ahu.ea.flow': 'flow',
  'ahu.ma.temp': 'mixed', 'ahu.coil.lat': 'coil', 'ahu.filter.dp': 'filter', 'ahu.sa.static': 'static', 'ahu.frz': 'frz',
}

/**
 * The house default for a role.
 * ctx: { kind, valveType, variant, binary, area, hasShaft, config }
 * → { part, count?, bracket?, ends?, fail?, masterSlave?, torqueLbIn? } | { part: valveModel } | null
 */
export function defaultDevice(role, ctx = {}) {
  const kind = ctx.kind
  if (AHU_ROLE[role]) return { part: SIEMENS_DEFAULTS.ahu[AHU_ROLE[role]] }
  if (role === 'ahu.valve.heat' || role === 'ahu.valve.cool') {
    const v = valveFor({ valveType: ctx.valveType, valveModel: ctx.valveModel, variant: role === 'ahu.valve.cool' ? 'cool' : 'heat' }, 'ahu')
    return v && v !== 'none' ? { part: v } : null
  }
  if (role === 'ahu.damper.oa' || role === 'ahu.damper.ea' || role === 'ahu.damper.ra') {
    return { ...actuatorFor(ctx.area, { binary: !!ctx.binary }), fail: role === 'ahu.damper.ra' ? 'open' : 'closed' }
  }
  if (role === 'term.pri.temp' || role === 'term.ent.temp' || role === 'term.dat') return { part: (SIEMENS_DEFAULTS[kind] || SIEMENS_DEFAULTS.vav).sensor }
  if (role === 'term.controller') {
    if (kind === 'vav') {
      const declared = ctx.config?.terminal?.controller?.model ?? ctx.config?.fieldDevices?.controller ?? null
      if (declared) return { part: declared }
      // no model declared: the family's actuating controller on a shaft, else the casing-mounted DXR2
      const fam = ctx.config?.terminal?.controller?.family
      if (fam === 'dxr1') return ctx.hasShaft ? { part: 'DXR1.E10PL-112/US' } : null
      if (fam === 'tec') return ctx.hasShaft ? { part: 'ATEC 550-430PA' } : null
      return { part: ctx.hasShaft ? SIEMENS_DEFAULTS.vav.controller : SIEMENS_DEFAULTS.vav.controllerNoShaft }
    }
    const c = ctx.config ? controllerOf(ctx.config) : SIEMENS_DEFAULTS[kind]?.controller
    return c ? { part: c } : null
  }
  if (role === 'term.damper') {
    if (kind === 'fcu') return { part: SIEMENS_DEFAULTS.fcu.damper, count: 1, fail: 'closed' }
    return { part: SIEMENS_DEFAULTS.vav.damper, count: 1 }
  }
  if (role === 'term.valve') {
    const v = valveFor({ valveType: ctx.valveType, valveModel: ctx.valveModel, variant: ctx.variant }, kind === 'fcu' ? 'fcu' : 'vav')
    return v && v !== 'none' ? { part: v } : null
  }
  if (role === 'zone.roomUnit') {
    const ru = ctx.config ? roomUnitOf(ctx.config) : null
    return ru ? { part: ru.model } : null
  }
  return null
}

/**
 * KNX PL-Link load of a controller's room units: { mA, maxMA | null, over }.
 * devices: placement devices ({ kind: 'room-unit', model? }); unknown kinds ignored.
 */
export function plLinkLoad(config, devices = []) {
  const ctl = controllerOf(config)
  const maxMA = (ctl && PL_LINK[ctl]) ?? null
  const def = roomUnitOf(config)?.model ?? 'QMX3.P34'
  let mA = 0
  for (const d of devices || []) {
    if (d?.kind !== 'room-unit' || d.model === 'none') continue
    mA += ROOM_UNIT_MODELS.find((m) => m.model === (d.model || def))?.mA ?? 0
  }
  return { mA, maxMA, over: maxMA != null && mA > maxMA }
}
