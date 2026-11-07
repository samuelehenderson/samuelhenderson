// Bridge: a ClarityView equipment unit → its 3D view (web/ahu/3d/).
//
// The 3D views (the air handler is ported from the PPCL Simulator) find parts
// by point *suffix*: OAD, CCV, SF1.STS, SAT… A ClarityView unit instead names
// each part by a symbol handle in its config (OAD, PHCV, SF1_SS…) that the
// tech binds to a real point with "Map points". This module walks the unit
// config and gives every configured symbol the suffix the 3D view looks for,
// so the 3D unit is built from the same config and the same mappings as the
// 2D graphic.
//
// Every equipment type has a 3D family (see viewFamily):
//   ahu      AHU and CRAC — the full air handler
//   terminal VAV and FCU — a ceiling terminal feeding the room it serves
//   eru      energy recovery unit — stacked supply/exhaust decks and a wheel
//   plant    heat exchanger, boiler, chillers, cooling tower — hydronic plant
//
// Existence follows the config, not the mappings: a configured part is drawn
// even when nothing is attached yet, and its readout says "unbound", exactly
// as the 2D engine does. Values go through the shared live-status contract:
// anything that is not a fresh good reading resolves with value null plus the
// reason, so the 3D view never draws a stale value as if it were live.

import { sensorKind, kindSuffix } from '../shared/siemens/select.js'
import { statusOf, ageText } from '../shared/live-status.js'
import { vavSuffixes } from './vav/vav-map.js'
import { wallSuffixMap } from '../shared/wall-units.js' // P2 PANELS
import { isHhw, hhwSuffixMap } from './hx/hhw.js' // P5 HX

const WHY = {
  stale: 'Last good reading is old — this value is NOT live',
  offline: 'The device did not answer the last poll',
  unbound: 'No point is attached to this symbol (use Map points)',
  nodata: 'Attached, waiting for the first reading',
}

const FAMILY = { ahu: 'ahu', crac: 'ahu', ef: 'ahu', vav: 'terminal', fcu: 'terminal', eru: 'eru', hx: 'plant', boiler: 'plant', 'chiller-ac': 'plant', 'chiller-wc': 'plant', tower: 'plant', booster: 'plant', panel: 'wall', vfd: 'wall' } // wall: P2 PANELS (panel3d.js)

/** Which 3D family draws this unit, or null when none can. */
export function viewFamily(config) {
  if (!config) return null
  if (FAMILY[config.kind]) return FAMILY[config.kind]
  const supply = config.supply || []
  // hand-built configs without a known kind: infer from what they contain
  if (supply.some((it) => it.device === 'boiler' || it.device === 'chiller' || it.device === 'tower' || it.device === 'booster')) return 'plant'
  if (config.shell === 'plant') return supply.some((it) => it.device === 'hx') ? 'plant' : null
  if (supply.some((it) => it.device === 'wheel')) return 'eru'
  if (supply.some((it) => it.device === 'zone')) return 'terminal'
  return supply.some((it) => it.device === 'fan') ? 'ahu' : null
}

/** Can this unit be drawn in 3D? */
export function canShow3d(config) {
  return viewFamily(config) != null
}

/** The kind the 3D view is built as (config.kind, or inferred from the family). */
export function kindOf(config) {
  if (config && FAMILY[config.kind]) return config.kind
  const fam = viewFamily(config)
  if (fam === 'plant') {
    if ((config.supply || []).some((it) => it.device === 'tower')) return 'tower'
    if ((config.supply || []).some((it) => it.device === 'booster')) return 'booster'
    const ch = (config.supply || []).find((it) => it.device === 'chiller')
    if (ch) return ch.condenser === 'water' ? 'chiller-wc' : 'chiller-ac'
    return (config.supply || []).some((it) => it.device === 'boiler') ? 'boiler' : 'hx'
  }
  return { terminal: 'vav', eru: 'eru' }[fam] || 'ahu'
}

/**
 * Suffix → symbol for every part of the unit the 3D view can draw.
 * @param {object} config  unit config (equipment-defaults.js shape)
 * @param {(symbol:string)=>string|null} typeOf  BACnet object type of the
 *   point mapped to a symbol (e.g. 'BV', 'AI'), or null when unmapped
 * @returns {{ map: Map<string,{sym:string, derive?:(v:number)=>number}>, rhAfterFans: boolean }}
 */
export function suffixMap(config, typeOf = () => null) {
  const map = new Map()
  const put = (sfx, sym, extra) => { if (sfx && sym && !map.has(sfx)) map.set(sfx, { sym, ...extra }) }
  const isBinary = (sym) => /^B/i.test(typeOf(sym) || '')
  const supply = config.supply || []
  const ret = config.return || []
  const mix = config.mixing || {}
  const kind = kindOf(config)

  if (isHhw(config)) return hhwSuffixMap(config) // P5 HX: heating hot water plant (HHW.<symbol>)
  if (viewFamily(config) === 'plant' && kind === 'booster') return boosterMap(config, put, map)
  if (viewFamily(config) === 'plant') return kind === 'tower' ? towerMap(config, put, map) : kind.startsWith('chiller') ? chillerMap(config, put, map) : plantMap(config, kind, put, map)
  if (config?.kind === 'vav') { const r = vavSuffixes(config, put, { typeOf, map }); if (r) return r }
  if (viewFamily(config) === 'wall') return wallSuffixMap(config) // P2 PANELS: field panel / VFD

  // ---- dampers: outside air, return-to-mix, relief ----
  for (const it of supply.filter((x) => x.device === 'damper' && x.point)) {
    if (it.point === mix.outsideDamper) put('OAD', it.point, { src: it })
    else if (it.point === mix.returnDamper) put('RAD', it.point, { src: it })
  }
  for (const it of supply.filter((x) => x.device === 'damper' && x.point)) {
    if (it.point === mix.outsideDamper || it.point === mix.returnDamper) continue
    if (!map.has('OAD')) put('OAD', it.point, { src: it })
    else if (!map.has('RAD')) put('RAD', it.point, { src: it })
  }
  // Without the mixing roles, a return-deck damper is the only recirculation
  // path — except on an energy recovery unit, where it is the exhaust outlet.
  if (!mix.returnDamper) {
    const rd = ret.find((x) => x.device === 'damper' && x.point)
    if (rd) put(kind === 'eru' ? 'EAD' : 'RAD', rd.point, { src: rd })
  }
  if (config.economizer?.point) put('EAD', config.economizer.point, { src: config.economizer })

  // ---- filters: dP reading; alarm derived the way the 2D engine does ----
  const filters = supply.filter((x) => x.device === 'filter' && x.point)
  filters.forEach((f, i) => {
    const base = filters.length === 1 ? null : (f.final ? 'FFIL' : i === 0 ? 'PFIL' : 'AFIL')
    const hi = f.hiDp || 1.5
    if (base) { put(base, f.point, { src: f }); put(`${base}.ALM`, f.point, { derive: (v) => (v > hi ? 1 : 0), src: f }) }
    else { put('FLT.DP', f.point, { src: f }); put('FLT.ALM', f.point, { derive: (v) => (v > hi ? 1 : 0), src: f }) }
  })

  // ---- coils, in airflow order: heat ahead of cooling is preheat ----
  let sawCool = false, sawFan = false, rhAfterFans = true
  const coilTemp = {}
  for (const it of supply) {
    if (it.device === 'fan') sawFan = true
    if (it.device !== 'coil' || !it.point) continue
    if (it.variant === 'cool') { put('CCV', it.point, { src: it }); coilTemp[it.label] = 'CCT'; sawCool = true }
    else if (!sawCool && !map.has('PHV')) { put('PHV', it.point, { src: it }); coilTemp[it.label] = 'PHT' }
    else { put('RHV', it.point, { src: it }); coilTemp[it.label] = 'RHT'; rhAfterFans = sawFan }
  }

  // ---- energy recovery wheel (ERU): run command/proof, speed, bypass ----
  const wheel = supply.find((x) => x.device === 'wheel')
  if (wheel) {
    put('WHL.SS', wheel.point); put('WHL.STS', wheel.statusPoint); put('WHL.SVD', wheel.speedPoint)
    put('WHL.FLT', wheel.faultPoint); put('WHL.BYP', wheel.bypassPoint)
    coilTemp[wheel.label] = 'WHL.LAT'
  }

  // ---- humidifier: a binary point is its command, an analog one its output ----
  const hum = supply.find((x) => x.device === 'humidifier' && x.point)
  if (hum) put(isBinary(hum.point) ? 'HUM.SS' : 'HUH', hum.point)

  // ---- fans: one point set per fan (same expansion as engine.js fanSpecs) ----
  const fanSet = (it, base) => {
    const n = it.count || (Array.isArray(it.fans) ? it.fans.length : 1)
    for (let k = 0; k < n; k++) {
      const b = `${base}${k + 1}`
      if (Array.isArray(it.fans) && it.fans.length) {
        const s = it.fans[k] || it.fans[it.fans.length - 1]
        put(`${b}.SS`, s.cmd); put(`${b}.STS`, s.status); put(`${b}.SVD`, s.speed); put(`${b}.FLT`, s.fault)
      } else if (it.cmdPoint || it.statusPoint || it.speedPoint) {
        put(`${b}.SS`, it.cmdPoint); put(`${b}.STS`, it.statusPoint); put(`${b}.SVD`, it.speedPoint); put(`${b}.FLT`, it.faultPoint)
      } else if (it.point) {
        // one point drives the whole fan: on/off if binary, speed otherwise
        put(isBinary(it.point) ? `${b}.STS` : `${b}.SVD`, it.point)
        put(`${b}.FLT`, it.faultPoint)
      }
    }
  }
  const sf = supply.find((x) => x.device === 'fan')
  if (sf) fanSet(sf, 'SF')
  const rf = ret.find((x) => x.device === 'fan')
  // an ERU's return-deck fans blow the exhaust out, not back into a mixing box
  // a return-deck fan section labelled as a relief fan is drawn and captioned as one
  if (rf) fanSet(rf, kind === 'eru' ? 'EF' : /relief/i.test(rf.label || '') ? 'RLF' : 'RF')
  for (const c of config.controls || []) if (c.role === 'supply-sp') put('SAT.SP', c.point) // AHU header control → the 3D "SA SP" row

  // ---- sensors ----
  for (const s of config.sensors || []) {
    if (!s.tag) continue
    // what it measures picks the suffix (OA RH → OAH, FRZ, …); temperature keeps the chain below
    const sk = sensorKind(s)
    if (sk !== 'temp') { const k = kindSuffix(s, sk); if (k) put(k.sfx, s.tag, { derive: k.derive, src: s }); continue }
    if (s.at === 'oa') put('OAT', s.tag, { src: s })
    else if (s.at === 'mixed' || s.tag === 'MAT') put('MAT', s.tag, { src: s })
    else if (s.at === 'sa') put('SAT', s.tag, { src: s })
    else if (s.deck === 'return' && kind === 'eru' && /^(EAT|EXAT|EA_|EXH|ELT)/i.test(s.tag)) put('EAT', s.tag, { src: s })
    else if (s.deck === 'return' || s.tag === 'RAT') put('RAT', s.tag, { src: s })
    else if (coilTemp[s.after]) put(coilTemp[s.after], s.tag, { src: s })
    else if (s.tag === 'DAT') put('SAT', s.tag, { src: s })
    else if (['OAT', 'SAT', 'RMT', 'RMH'].includes(s.tag)) put(s.tag, s.tag, { src: s })
  }
  if (config.supplyStatic?.point) put('SSP', config.supplyStatic.point, { src: config.supplyStatic })
  for (const st of config.airStations || []) {
    const k = { OACFM: 'OA.CFM', SACFM: 'SA.CFM', RACFM: 'RA.FLW', EACFM: 'EA.FLW' }[st.tag]
    if (k) put(k, st.tag, { src: st })
  }
  // zone / room panel on a VAV, fan coil or CRAC. The setpoint and mode show
  // the effective value and command the writable one, as the 2D chips do.
  for (const it of supply.filter((x) => x.device === 'zone')) {
    const z = { src: it }
    put('ZNT', it.tempPoint, z); put('ZNH', it.humPoint, z); put('OCC', it.occPoint, z); put('CO2', it.co2Point, z)
    put('ZNSP', it.spDisplay || it.spCommand, z); put('ZNSP.CMD', it.spCommand, z)
    put('MODE', it.modeDisplay || it.modeCommand, z); put('MODE.CMD', it.modeCommand, z)
  }
  return { map, rhAfterFans }
}

// Hydronic plant (heat exchanger, boiler). Sensors are placed by where the
// config puts them — at the inlet/outlet or after a named section — with the
// tag name as the fallback, so hand-built plant configs still land sensibly.
function plantMap(config, kind, put, map) {
  const isB = kind === 'boiler'
  const after = {} // section label -> the water temperature leaving it
  let valves = 0
  for (const it of config.supply || []) {
    if (it.device === 'boiler') {
      put('BLR.SS', it.point); put('BLR.STS', it.statusPoint); put('BLR.FIRE', it.firePoint)
      put('BLR.FLT', it.faultPoint); put('BLR.FLAME', it.flamePoint); put('BLR.PMP', it.pumpPoint)
      after[it.label] = 'BLR.SWT'
    } else if (it.device === 'hx') {
      after[it.label] = 'SEC.IN'
    } else if (it.device === 'coil') {
      if (it.valve && it.point) {
        put(isB ? 'BLR.VLV' : (valves++ ? 'SEC.VLV' : 'PRI.VLV'), it.point)
        after[it.label] = isB ? 'BLR.RWT' : (valves === 1 ? 'PRI.OUT' : 'SEC.OUT')
      }
      if (it.pump && (it.pumpPoint || it.point)) {
        put(isB ? 'BLR.PMP' : 'SEC.PMP', it.pumpPoint || it.point)
        if (!after[it.label]) after[it.label] = isB ? 'BLR.RWT' : 'SEC.OUT'
      }
    }
  }
  const byTag = (tag) => {
    const t = String(tag).toUpperCase()
    if (/STACK|FLUE/.test(t)) return 'BLR.STACK'
    if (/PRESS|PSI/.test(t)) return isB ? 'BLR.PRESS' : 'HX.PRESS'
    if (/(^|[^A-Z])(SP|STPT|SETPT|SETPOINT)$|_SP$|SP_EFF$/.test(t)) return isB ? 'BLR.SP' : 'HX.SP'
    if (isB) {
      if (/RWT|RTN|RET/.test(t)) return 'BLR.RWT'
      if (/SWT|SUP|HWS/.test(t)) return 'BLR.SWT'
      return null
    }
    if (/PRI.*(IN|ENT)/.test(t)) return 'PRI.IN'
    if (/PRI.*(OUT|LVG)/.test(t)) return 'PRI.OUT'
    if (/SEC.*(IN|RTN|RET)/.test(t)) return 'SEC.IN'
    if (/SEC.*(OUT|SUP)/.test(t)) return 'SEC.OUT'
    return null
  }
  for (const s of config.sensors || []) {
    if (!s.tag) continue
    // an explicit name (stack, pressure, setpoint) wins over position
    const named = byTag(s.tag)
    if (named && /STACK|PRESS|SP$/.test(named)) { put(named, s.tag); continue }
    if (s.at === 'oa') put(isB ? 'BLR.RWT' : 'PRI.IN', s.tag)
    else if (s.at === 'sa') put(isB ? 'BLR.SWT' : 'SEC.OUT', s.tag)
    else if (s.after && after[s.after] && !map.has(after[s.after])) put(after[s.after], s.tag)
    else if (named) put(named, s.tag)
  }
  if (config.setpoint?.point) put(isB ? 'BLR.SP' : 'HX.SP', config.setpoint.point)
  return { map, rhAfterFans: false }
}

// Booster pumps: each pump as a point set BP<n>.SS / .STS / .SVD / .FLT, and
// the station's readings by name (loop DP and setpoint, flow, suction and
// discharge pressure).
function boosterMap(config, put, map) {
  for (const it of config.supply || []) {
    if (it.device !== 'booster') continue
    ;(it.pumps || []).forEach((f, i) => {
      const b = `BP${i + 1}`
      put(`${b}.SS`, f.cmd); put(`${b}.STS`, f.status); put(`${b}.SVD`, f.speed); put(`${b}.FLT`, f.fault)
    })
  }
  for (const s of config.sensors || []) {
    if (!s.tag) continue
    const t = String(s.tag).toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (/DP.*(SP|STPT|SETPOINT)/.test(t)) put('BP.DPSP', s.tag)
    else if (/DP|DIFF/.test(t)) put('BP.DP', s.tag)
    else if (/FLOW|GPM/.test(t)) put('BP.FLOW', s.tag)
    else if (/SUC|INLET/.test(t) || s.at === 'oa') put('BP.SUC', s.tag)
    else if (/DIS|OUTLET/.test(t) || s.at === 'sa') put('BP.DIS', s.tag)
  }
  return { map, rhAfterFans: false }
}

// Cooling tower: each cell's fan as a point set CTF<n>.SS / .STS / .SVD /
// .FLT (the same roles a fan has), the tower's own points, and the water
// temperatures by name (CWR in hot, CWS out cold, basin, wet bulb, setpoint).
function towerMap(config, put, map) {
  for (const it of config.supply || []) {
    if (it.device !== 'tower') continue
    ;(it.fans || []).forEach((f, i) => {
      const b = `CTF${i + 1}`
      put(`${b}.SS`, f.cmd); put(`${b}.STS`, f.status); put(`${b}.SVD`, f.speed); put(`${b}.FLT`, f.fault)
    })
    put('CT.BYP', it.bypassPoint); put('CT.HTR', it.heaterPoint); put('CT.MU', it.makeupPoint); put('CT.VIB', it.vibPoint)
  }
  for (const s of config.sensors || []) {
    if (!s.tag) continue
    const t = String(s.tag).toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (/SP|STPT|SETPOINT/.test(t)) put('CT.SP', s.tag)
    else if (/WB|WETBULB/.test(t)) put('CT.WB', s.tag)
    else if (/BSN|BASIN|SUMP/.test(t)) put('CT.BSN', s.tag)
    else if (/CWR|CWRT|RTN|RETURN/.test(t) || s.at === 'oa') put('CT.CWR', s.tag)
    else if (/CWS|CWST|SUP/.test(t) || s.at === 'sa') put('CT.CWS', s.tag)
  }
  return { map, rhAfterFans: false }
}

// Chillers: the machine's point set, then the water temperatures — by name
// first (CHWS, CWR, …), else by where the config puts the sensor.
//   CH.SS enable · CH.STS run · CH.LOAD % load · CH.FLT alarm · CH.FLOW /
//   CH.CWFLOW flow proofs · CH.PMP / CH.CWP pumps · CH.C1… compressors ·
//   CH.CF condenser fans · CH.CHWS / CH.CHWR / CH.SP · CH.CWS / CH.CWR · CH.OAT
function chillerMap(config, put, map) {
  for (const it of config.supply || []) {
    if (it.device !== 'chiller') continue
    put('CH.SS', it.point); put('CH.STS', it.statusPoint); put('CH.LOAD', it.loadPoint); put('CH.FLT', it.faultPoint)
    put('CH.FLOW', it.flowPoint); put('CH.CWFLOW', it.condFlowPoint); put('CH.PMP', it.pumpPoint); put('CH.CWP', it.condPumpPoint)
    put('CH.CF', it.condFanPoint)
    ;(it.compressors || []).forEach((c, i) => put(`CH.C${i + 1}`, c))
  }
  const byTag = (tag) => {
    const t = String(tag).toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (/CHW.*(SP|STPT|SETPT|SETPOINT)|LCHWTSP|ACTIVESP/.test(t)) return 'CH.SP'
    if (/CHWR|ECHW|CHWRT|EVAPENT/.test(t)) return 'CH.CHWR'
    if (/CHWS|LCHW|CHWST|EVAPLVG/.test(t)) return 'CH.CHWS'
    if (/(^|[^H])CW(R|RT)|CDWR|LCWT|CONDLVG/.test(t)) return 'CH.CWR'
    if (/(^|[^H])CW(S|ST)|CDWS|ECWT|CONDENT/.test(t)) return 'CH.CWS'
    if (/OAT|AMB/.test(t)) return 'CH.OAT'
    return null
  }
  for (const s of config.sensors || []) {
    if (!s.tag) continue
    const named = byTag(s.tag)
    if (named) put(named, s.tag)
    else if (s.at === 'oa') put('CH.CHWR', s.tag)
    else if (s.at === 'sa') put('CH.CHWS', s.tag)
  }
  if (config.setpoint?.point) put('CH.SP', config.setpoint.point)
  return { map, rhAfterFans: false }
}

/**
 * What the 3D view needs to read a unit: has(suffix), resolve(suffix), and the
 * reverse lookup from a picked suffix back to its symbol.
 * @param {object} o
 * @param {Map} o.map             from suffixMap()
 * @param {(sym:string)=>number|null} o.pointIdOf   mapped point id for a symbol
 * @param {(pid:number)=>object|null} o.liveOf      latest socket update for a point
 */
export function bridge({ map, pointIdOf, liveOf }) {
  const has = (sfx) => map.has(sfx)
  const symOf = (sfx) => map.get(sfx)?.sym ?? null
  function resolve(sfx) {
    const e = map.get(sfx)
    if (!e) return null
    const pid = pointIdOf(e.sym)
    const st = statusOf(pid == null ? null : liveOf(pid), { bound: pid != null })
    if (st.kind !== 'live') {
      if (st.kind === 'stale') {
        // not updating for over a minute: show its last value (red, and it drives no motion)
        let last = st.value
        if (typeof last === 'boolean') last = last ? 1 : 0
        if (e.derive && last != null) last = e.derive(Number(last))
        const label = last == null ? '--' : Number.isInteger(Number(last)) ? String(last) : Number(last).toFixed(1)
        return { value: null, status: 'stale', label, last, why: 'Last reading ' + ageText(st) + ' — not updating' }
      }
      const label = { offline: 'no resp', unbound: 'unbound', nodata: 'waiting' }[st.kind]
      return { value: null, status: st.kind, label, why: WHY[st.kind] }
    }
    let v = st.value
    if (typeof v === 'boolean') v = v ? 1 : 0
    if (e.derive) v = e.derive(Number(v))
    return st.override
      ? { value: v, status: 'manual', why: `Manual override at priority ${st.override.priority}` }
      : { value: v, status: 'normal' }
  }
  return { has, resolve, symOf }
}
