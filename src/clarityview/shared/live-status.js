// ONE live-status contract for every consumer of point updates — the generic
// live-SVG binder, the AHU/HMI engine, and dashboard tiles — so the same point
// looks the same everywhere. Never show a stale or missing value as if it were
// live; and keep "not attached", "device didn't answer", and "went quiet"
// visually distinct, because a tech fixes each of those differently.
//
// Input is the poller's update object { id, value, ts, ok, pollMs, override }.

export const STALE_FACTOR = 3 // stale = no update within 3x the poll interval …
export const STALE_MIN_MS = 60000 // … and never before a minute without one (user, 2026-09-30)
/** How long a point may go without an update before it counts as stale. */
export const staleAfterMs = (pollMs) => Math.max(STALE_MIN_MS, STALE_FACTOR * (Number(pollMs) || 0))

// kind: 'unbound' | 'nodata' | 'offline' | 'stale' | 'live'
//   unbound — the symbol/element has no point attached (config problem)
//   nodata  — attached, but no reading has arrived yet
//   offline — the device did not answer the last poll (ok: false)
//   stale   — last good reading is older than staleAfterMs(pollMs): 3x the poll
//             interval, at least a minute; its last value still shows (in red)
//   live    — fresh, good reading
export function statusOf(u, { bound = true } = {}) {
  if (!bound) return { kind: 'unbound', value: null, ok: false, override: null, ageMs: null }
  if (!u) return { kind: 'nodata', value: null, ok: false, override: null, ageMs: null }
  const ageMs = u.ts ? Date.now() - u.ts : null
  const override = u.override ?? null
  if (!u.ok) return { kind: 'offline', value: null, ok: false, override, ageMs }
  const stale = ageMs != null && u.pollMs > 0 && ageMs > staleAfterMs(u.pollMs)
  return { kind: stale ? 'stale' : 'live', value: u.value, ok: true, override, ageMs }
}

// Same predicate live-svg has always used: anything but a fresh good reading.
export function isStale(u) {
  return statusOf(u).kind !== 'live'
}

export function ageText(st) {
  const ms = st?.ageMs
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.round(s / 60) + 'm ago'
  return Math.round(s / 3600) + 'h ago'
}
