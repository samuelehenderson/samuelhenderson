/**
 * inventory.js — what an air handler holds, by role, from point suffixes.
 *
 * Ported from the PPCL Simulator (src/ui/schematics.js ahuInventory,
 * src/sim/aliases.js, src/sim/trendplay.js valueAt) so the 3D air handler reads
 * a unit the same way there and here. In ClarityView the suffixes are virtual:
 * ahu3d-bridge.js names each configured symbol with the suffix the 3D view
 * looks for (OAD, CCV, SF1.STS…), so real point names never matter here.
 */

// A logical role (command / status / speed / fault) and the suffixes that mean it.
export const SUFFIX_ALIASES = {
  command: ['SS', 'ENA', 'EN', 'CMD', 'START', 'STRT', 'C', 'O'],
  status: ['STS', 'PRF', 'PROOF', 'ST', 'STAT', 'FB', 'RUN', 'OP', 'OPN', 'OPEN'],
  speed: ['SVD', 'VFD', 'SPD', 'SPEED', 'VFO', 'SO'],
  fault: ['FLT', 'FAULT', 'ALM', 'ALARM', 'TRIP', 'FAIL.ALM', 'FAIL'],
}

/** First existing `<base>.<alias>` suffix for a role, or null. */
export function resolveSuffix(has, base, role) {
  for (const a of SUFFIX_ALIASES[role] || []) {
    const suf = `${base}.${a}`
    if (has(suf)) return suf
  }
  for (const a of SUFFIX_ALIASES[role] || []) {
    const suf = `${base}${a}`
    if (has(suf)) return suf
  }
  if (role === 'command' && has(base)) return base
  return null
}

/** Best "is it running" indicator: status, then command, then speed. */
export function runSuffix(has, base) {
  return (
    resolveSuffix(has, base, 'status') ||
    resolveSuffix(has, base, 'command') ||
    resolveSuffix(has, base, 'speed') ||
    `${base}.STS`
  )
}

const FAN_ROLES = ['STS', 'SS', 'ENA', 'EN', 'VFD', 'SVD', 'PRF', 'RUN']
const deviceExists = (has, base) => FAN_ROLES.some((r) => has(`${base}.${r}`))
const pick = (has, cands) => cands.find((s) => has(s)) || null

/** Numbered + bare device bases that exist, e.g. findFans(has,['SF']) -> ['SF1','SF2']. */
function findFans(has, bases, max = 8) {
  const out = []
  for (const base of bases) {
    const numbered = []
    for (let i = 1; i <= max; i++) if (deviceExists(has, `${base}${i}`)) numbered.push(`${base}${i}`)
    if (numbered.length) out.push(...numbered)
    else if (deviceExists(has, base)) out.push(base)
  }
  return out
}

// Fan families on the return deck. Relief fans are their own family (RLF is
// the common APOGEE spelling; RELF older) so the drawing can say RELIEF, not
// EXHAUST or RETURN.
export const RETURN_FAN_BASES = ['RF', 'RAF', 'RETF']
export const RELIEF_FAN_BASES = ['RLF', 'RELF', 'RLFN']
export const EXHAUST_FAN_BASES = ['EF', 'EAF', 'GEF', 'EXF']

/** What the return-deck fans are called: RETURN / RELIEF / EXHAUST FAN(S), or a mix. */
export function returnFanCaption(inv) {
  const n = { RETURN: inv.rfs?.length || 0, RELIEF: inv.rlfs?.length || 0, EXHAUST: inv.efs?.length || 0 }
  const kinds = Object.keys(n).filter((k) => n[k])
  const total = n.RETURN + n.RELIEF + n.EXHAUST
  if (kinds.length === 1) return `${kinds[0]} FAN${total > 1 ? 'S' : ''}`
  return kinds.length ? `${kinds.join(' / ')} FANS` : 'RETURN FAN'
}

/**
 * Dampers, fans, filter, each coil's valve, and whether there is a return path.
 * @param {(suffix:string)=>boolean} has
 *   A host whose `has` also finds points one level up (shared site points such
 *   as the outdoor air temperature) sets `has.own` to the unit-only test: fans
 *   are only ever looked for inside the unit, so a building's exhaust fan
 *   (GVL.B1.EF1) is never drawn inside an air handler (GVL.B1.AHU7).
 */
export function ahuInventory(has) {
  const own = typeof has.own === 'function' ? has.own : has
  const oad = pick(has, ['OAD', 'OAR'])
  const rad = pick(has, ['RAD'])
  const ead = pick(has, ['EAD', 'RELD', 'READ', 'RLD'])
  const sf = findFans(own, ['SF', 'SAF'], 16)
  const fans = sf.length ? sf : ['SF1']
  const rfs = findFans(own, RETURN_FAN_BASES, 16)
  const rlfs = findFans(own, RELIEF_FAN_BASES, 16)
  const efs = findFans(own, EXHAUST_FAN_BASES, 16)
  const fAlm = pick(has, ['FLT.ALM', 'FILT.ALM', 'DFA'])
  const fDp = pick(has, ['FLT.DP', 'FILT.DP', 'FDP'])
  const ph = pick(has, ['PHV', 'PHC', 'PHCV', 'PHTV'])
  const cc = pick(has, ['CCV', 'CHV', 'CWV', 'CLV', 'CLGV', 'CHWV'])
  const rh = pick(has, ['HCV', 'RHV', 'RHC', 'HV', 'HTV', 'HWV', 'RHTV'])
  const mat = has('MAT') ? 'MAT' : null
  const hasRet = !!(rfs.length || rlfs.length || efs.length || rad || ead)
  const hasFilter = !!(fAlm || fDp)
  return { oad, rad, ead, fans, rfs, rlfs, efs, fAlm, fDp, ph, cc, rh, mat, hasRet, hasFilter }
}

/** Last value at or before t (NaN before the first sample). Binary search. */
export function valueAt(s, t) {
  const a = s.t
  if (!a.length || t < a[0]) return NaN
  let lo = 0, hi = a.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (a[mid] <= t) lo = mid; else hi = mid - 1
  }
  return s.v[lo]
}
