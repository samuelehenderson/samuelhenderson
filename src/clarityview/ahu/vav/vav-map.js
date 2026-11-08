// vav-map.js — the 3D suffixes of an air terminal (vav-spec §7.3). Pure;
// called from ahu3d-bridge.js suffixMap() through one hook:
//
//   if (config?.kind === 'vav') { const r = vavSuffixes(config, put, { typeOf, map }); if (r) return r }
//
// A terminal shell (config.terminal) returns its own complete map — inlets,
// reheat, fan, temperatures and zone — so the generic AHU loops never touch it.
// A legacy VAV puts its VAV.* aliases first and returns null, falling through
// to the unchanged generic loops (its old suffixes stay exactly as they were).
// Every entry carries { src: <config object> } so other modules can find the
// section or sensor record a suffix came from.

import { isTerminalShell } from './vav-config.js'

const PREFIX = { primary: 'VAV', cold: 'CD', hot: 'HD', exhaust: 'EX', vent: 'VD' }

function inletSuffixes(it, put) {
  const P = PREFIX[it.duct] || 'VAV'
  const src = it
  put(`${P}.DMP`, it.point, { src })
  put(`${P}.DMP.POS`, it.posPoint, { src })
  put(`${P}.FLOW`, it.flowPoint, { src })
  put(`${P}.FLOW.SP`, it.flowSpPoint, { src, units: it.flowSpUnits || 'cfm' })
  put(`${P}.FLOW.MIN`, it.ctlMinPoint, { src })
  put(`${P}.FLOW.MAX`, it.ctlMaxPoint, { src })
  put(`${P}.CLG.MIN`, it.clgMinPoint, { src })
  put(`${P}.CLG.MAX`, it.clgMaxPoint, { src })
  put(`${P}.HTG.MIN`, it.htgMinPoint, { src })
  put(`${P}.HTG.MAX`, it.htgMaxPoint, { src })
  put(`${P}.DP`, it.vpPoint, { src })
  put(`${P}.OCC.FLOW`, it.occFlowPoint, { src })
  put(`${P}.UNOCC.FLOW`, it.unoccFlowPoint, { src })
  put('TOT.FLOW', it.totFlowPoint, { src })
  put('TOT.FLOW.SP', it.totFlowSpPoint, { src })
  put('TOT.FLOW.MIN', it.totMinPoint, { src })
  put('TOT.FLOW.MAX', it.totMaxPoint, { src })
}

/**
 * @param {object} config  unit config (kind 'vav')
 * @param {(sfx, sym, extra?) => void} put  the bridge's put (first entry wins)
 * @param {{ typeOf?, map: Map }} ctx
 * @returns {{ map: Map, rhAfterFans: boolean } | null}  null = legacy: continue with the generic loops
 */
export function vavSuffixes(config, put, { map } = {}) {
  const supply = config.supply || []
  const sensors = config.sensors || []
  if (!isTerminalShell(config)) {
    // legacy VAV: its parts under the VAV names first, everything else as before
    const dmp = supply.find((x) => x.device === 'damper' && x.point)
    if (dmp) put('VAV.DMP', dmp.point, { src: dmp })
    const st = (config.airStations || []).find((s) => s.tag === 'SACFM' || s.tag === 'OACFM')
    if (st) put('VAV.FLOW', st.tag, { src: st })
    const coil = supply.find((x) => x.device === 'coil' && x.variant !== 'cool' && x.point)
    if (coil) put('RHV', coil.point, { src: coil })
    for (const s of sensors) {
      if (!s.tag) continue
      if (s.at === 'oa' || s.at === 'primary') put('PAT', s.tag, { src: s })
      else if (s.tag === 'DAT' || s.at === 'sa' || s.at === 'discharge' || (coil && s.after === coil.label)) put('DAT', s.tag, { src: s })
    }
    return null
  }

  for (const it of supply) {
    if (it.device === 'vavinlet') inletSuffixes(it, put)
    else if (it.device === 'coil' && it.variant !== 'cool') { put('RHV', it.point, { src: it }); put('RHV.POS', it.posPoint, { src: it }) }
    else if (it.device === 'eheat') {
      put('EH1', it.stage1Point, { src: it }); put('EH2', it.stage2Point, { src: it }); put('EH3', it.stage3Point, { src: it })
      put('EH.SCR', it.scrPoint, { src: it }); put('EH.FS', it.flowSwitchPoint, { src: it }); put('EH.FLT', it.faultPoint, { src: it })
    } else if (it.device === 'fan') {
      put('SF1.SS', it.cmdPoint, { src: it }); put('SF1.STS', it.statusPoint, { src: it })
      put('SF1.SVD', it.speedPoint, { src: it }); put('SF1.FLT', it.faultPoint, { src: it })
    }
  }
  for (const s of sensors) {
    if (!s.tag) continue
    if (s.at === 'primary' || s.tag === 'PAT') put('PAT', s.tag, { src: s })
    else put('DAT', s.tag, { src: s })
  }
  for (const z of supply.filter((x) => x.device === 'zone')) {
    // TEC DAY.NGT is active = NIGHT: the 3D OCC reads 1 = occupied
    put('OCC', z.occPoint, z.occInvert ? { src: z, derive: (v) => (v > 0 ? 0 : 1) } : { src: z })
    put('ZNT', z.tempPoint, { src: z }); put('ZNH', z.humPoint, { src: z }); put('CO2', z.co2Point, { src: z })
    put('ZNSP', z.spDisplay || z.spCommand, { src: z }); put('ZNSP.CMD', z.spCommand, { src: z })
    put('MODE', z.modeDisplay || z.modeCommand, { src: z }); put('MODE.CMD', z.modeCommand, { src: z })
    put('CLG.SP', z.clgSpPoint, { src: z }); put('HTG.SP', z.htgSpPoint, { src: z })
  }
  return { map, rhAfterFans: true }
}
