// wall-units.js — the glue for wall-hung units (field panels, VFDs), pure.
// The shared files (equipment-defaults, ahu3d-bridge, ahu-view symbolsOf,
// unit-hints, buildings, plan-geom) call these few functions and know nothing
// else about panels or drives.

import { panelChannels, panelHint, panelFoot, PANEL_DEFAULT_MOUNT } from './siemens/panels.js'
import { VFD_POINTS, vfdHint, vfdFoot, VFD_DEFAULT_MOUNT } from './drives.js'

export const WALL_KINDS = new Set(['panel', 'vfd'])
export const isWallUnit = (x) => WALL_KINDS.has(typeof x === 'string' ? x : x?.kind)

/** Floor → top of the unit (metres): the placement's own mount, else the kind's default. */
export function mountOf(kind, pl) {
  const m = Number(pl?.mount)
  if (Number.isFinite(m) && m > 0.3 && m < 6) return m
  return kind === 'vfd' ? VFD_DEFAULT_MOUNT : PANEL_DEFAULT_MOUNT
}
export const MOUNT_DEFAULT = { panel: PANEL_DEFAULT_MOUNT, vfd: VFD_DEFAULT_MOUNT }

/** Point symbols of a wall unit, in the order its points list shows them. */
export function wallSymbols(config) {
  if (config?.kind === 'panel') return panelChannels(config).map((c) => c.sym)
  if (config?.kind === 'vfd') return VFD_POINTS.map((p) => p.sym)
  return []
}

/** Suffix → symbol (ahu3d-bridge suffixMap) for a wall unit, or null for anything else. */
export function wallSuffixMap(config) {
  const map = new Map()
  if (config?.kind === 'panel') for (const c of panelChannels(config)) map.set(c.sfx, { sym: c.sym, ch: c })
  else if (config?.kind === 'vfd') for (const p of VFD_POINTS) map.set(p.sfx, { sym: p.sym })
  else return null
  return { map, rhAfterFans: false }
}

export function wallHint(config, sym) {
  if (config?.kind === 'panel') return panelHint(config, sym)
  if (config?.kind === 'vfd') return vfdHint(config, sym)
  return null
}

/** The plan footprint (buildings unitItems `foot`) of a wall unit, or null. */
export function wallFoot(config) {
  if (config?.kind === 'panel') return panelFoot(config)
  if (config?.kind === 'vfd') return vfdFoot(config)
  return null
}
