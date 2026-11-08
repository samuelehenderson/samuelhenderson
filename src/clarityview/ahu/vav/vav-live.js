// vav-live.js — when is air moving through a terminal? The honesty rule for
// every VAV drawing (vav-spec D7, CLAUDE.md "Live-only, by decision"):
//
//   Air moves (2D chevrons, 3D particles, twin "Running") ONLY on a LIVE airflow
//   reading at or above the sensor's measurable minimum, or a LIVE fan proof.
//   Stale, offline, unbound or no-data values never move anything.
//
// Pure (no DOM, no three.js); copied into graphics-kit/.
//   2D reads through the engine's read(sym) (statusOf → kind 'live' only);
//   3D reads through the bridge-backed view._num(sfx), which is NaN for anything
//   not live (ahu3d-bridge.js resolves non-live values to null).

import { resolveDims } from './vav-geometry.js'
import { terminalOf } from './vav-config.js'

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const fin = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * The lowest airflow the inlet sensor can measure: the controller's digital
 * minimum at 0.02 in. w.g. (Price SDV), or K·√0.02, whichever is higher.
 * Size 8: max(125, 904·√0.02 = 127.8) = 127.8 cfm.
 */
export function proofCfm(dims) {
  const byK = fin(dims?.k) ? dims.k * Math.sqrt(0.02) : 0
  return Math.max(fin(dims?.minCfm) ? dims.minCfm : 0, byK)
}

/**
 * The airflow that counts as "full" for the stream speed: live active max
 * (CTL FLOW MAX), else live cooling max, else the nameplate, else the catalogue max.
 * num(key) returns a finite number only for a live value.
 */
export function refMaxCfm(term, dims, num) {
  for (const k of ['ctlMax', 'clgMax']) { const v = num(k); if (fin(v) && v > 0) return v }
  if (fin(term?.nameplate?.maxCfm) && term.nameplate.maxCfm > 0) return term.nameplate.maxCfm
  return fin(dims?.maxCfm) && dims.maxCfm > 0 ? dims.maxCfm : 1
}

/**
 * { moving, frac, belowRange, measured } from one reading of the airflow.
 *   flow: live cfm or NaN · proof: proofCfm · maxRef: refMaxCfm · fanProven: live proof ON
 */
export function flowState({ flow, proof, maxRef, fanProven = false }) {
  const measured = fin(flow)
  const above = measured && flow >= proof
  const frac = above && maxRef > 0 ? clamp(flow / maxRef, 0, 1) : 0
  return { moving: above || !!fanProven, frac, belowRange: measured && flow < proof, measured }
}

/** 2D: a number only when the symbol reads live (the engine's read() → statusOf). */
export function makeLiveNum2d(read) {
  return (sym) => {
    if (!sym) return null
    const st = read(sym)
    if (!st || st.kind !== 'live' || st.value == null) return null
    const v = typeof st.value === 'boolean' ? (st.value ? 1 : 0) : Number(st.value)
    return Number.isFinite(v) ? v : null
  }
}

/**
 * 2D flow gate for a legacy VAV (no config.terminal): its fans' strict live
 * proof, or a live airflow station at or above the measurable minimum.
 * api: { liveNum, unit }; fans: engine fan clusters; strictRun(fc) → boolean.
 */
export function vavLegacyFlow(api, fans, strictRun) {
  if (fans.some((fc) => strictRun(fc))) return true
  const t = terminalOf(api.unit)
  const proof = proofCfm(resolveDims(t).dims)
  for (const st of api.unit?.airStations || []) {
    if (st.tag !== 'SACFM' && st.tag !== 'OACFM') continue
    const v = api.liveNum(st.tag)
    if (v != null && v >= proof) return true
  }
  return false
}

/** The suffix a 3D view reads the primary airflow from (terminal shells and legacy alike). */
export function flowSuffix(has) {
  return ['VAV.FLOW', 'CD.FLOW', 'EX.FLOW', 'TOT.FLOW', 'SA.CFM', 'SA.FLW'].find((s) => has(s)) || null
}

/**
 * 3D: the stream speed 0..1 for a terminal view (a Vav3DView, or a Terminal3DView
 * of kind 'vav'). 0 whenever nothing is live. fanFrac: the supply fans' damped
 * speed fraction (only fans with a live proof ever turn).
 * @returns {{ target, state }}
 */
export function vavFlowTarget(view, fanFrac = 0) {
  const has = view.has || (() => false)
  const n = (s) => (s && has(s) ? view._num(s) : NaN)
  const term = view.term || terminalOf(view.config) || terminalOf({ kind: 'vav' })
  const dims = view.vavDims || resolveDims(term).dims
  const flow = n(flowSuffix(has))
  const maxRef = refMaxCfm(term, dims, (k) => n(k === 'ctlMax' ? 'VAV.FLOW.MAX' : 'VAV.CLG.MAX'))
  const proof = proofCfm(dims)
  const fanProven = n('SF1.STS') > 0
  const state = flowState({ flow, proof, maxRef, fanProven })
  const target = Math.max(state.frac, fanProven ? clamp(fanFrac, 0, 1) : 0)
  return { target: state.moving ? target : 0, state }
}

/** Is a damper / valve position the controller's estimate from actuator run time? */
export function isEstimated(section) {
  if (!section) return false
  if (section.posCalc === false) return false
  // null = auto: an OpenAir feedback potentiometer would make it measured (SIEMENS decodeOpenAir, later pass)
  return true
}
