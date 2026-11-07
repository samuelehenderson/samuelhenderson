// panels.js — Siemens field panels, pure data + layout (no DOM, no three.js).
//
// A field panel is a unit of kind 'panel', built like the real ones in
// docs/graphic-references/field-panel-real-2/4: a tall wall-hung steel cabinet,
// a perforated back plate framed by slotted duct, the automation station (PXC…)
// at the top of a VERTICAL DIN rail with its TX-I/O bus supply and I/O modules
// stacked below (a second column when they run out of rail), and a power column
// on the right (the Siemens power supply box, a duplex receptacle, terminal
// blocks, optional relays). Everything about it lives in config.panel:
//
//   panel: {
//     controller: 'PXC7',                    // CONTROLLERS key
//     modules: [{ type: 'TXS1.12F4' },       // rail order, left to right
//               { type: 'TXM1.8U', addr: 1 }, …],  // I/O modules carry their
//                                            // TX-I/O address (the address key):
//                                            // reordering keeps every mapping
//     enclosure: 'auto' | ENCLOSURES key,
//     transformer: 100,                      // VA (the power supply's Class 2 output)
//     relays: 0,                             // RIBMN-style relays in the power column
//     circuit: { pnl: '', ckt: '' },         // "120V FED FROM PNL __ CKT __"
//   }
//
// Point symbols: TX<addr>_<channel> for TX-I/O channels (TX-I/O addressing is
// module.channel, e.g. 3.4), IO_<n> for a controller's onboard I/O. The tech
// binds them with Map points like every other unit; nothing here reads a value.
//
// Sizes are millimetres. Parts no Siemens document at hand confirms are marked
// verified: false (≈ on screen): the housings are drawn from the reference
// photos in docs/graphic-references/ at their proportions.

export const PANEL_DEFAULT_MOUNT = 1.524          // floor → top of enclosure, 5'-0"

// ---- automation stations -------------------------------------------------------
// style: 'pxc' = the Desigo PXC4/5/7 housing (dark slate, raised front, teal
// badge, plugs on top and bottom edges); 'compact' / 'modular' = APOGEE, light grey.
export const CONTROLLERS = {
  PXC7: {
    key: 'PXC7', model: 'PXC7.E400S', label: 'PXC7 — Desigo system controller', family: 'Desigo PXC',
    style: 'pxc', w: 234, h: 138, d: 72, color: '#4f5964', cover: '#475059', txio: true, onboard: 0,
    leds: [['RUN', 'green'], ['CLOUD', 'blue'], ['BAT', 'off'], ['TXM', 'yellow'], ['SVC', 'off'], ['WLAN', 'off']],
    com: ['COM1', 'COM2', 'COM3', 'COM4'], lan: 2, mbus: true,
    verified: { dims: false, shape: true, finish: true }, note: 'housing from the PXC7 photo; size ≈',
  },
  PXC5: {
    key: 'PXC5', model: 'PXC5.E003', label: 'PXC5 — Desigo system controller', family: 'Desigo PXC',
    style: 'pxc', w: 180, h: 138, d: 72, color: '#4f5964', cover: '#475059', txio: true, onboard: 0,
    leds: [['RUN', 'green'], ['BAT', 'off'], ['TXM', 'yellow'], ['SVC', 'off']],
    com: ['COM1', 'COM2'], lan: 2, mbus: false,
    verified: { dims: false, shape: false, finish: true }, note: 'drawn in the PXC7 housing style ≈',
  },
  PXC4: {
    key: 'PXC4', model: 'PXC4.E16', label: 'PXC4 — Desigo controller, 16 onboard I/O', family: 'Desigo PXC',
    style: 'pxc', w: 216, h: 138, d: 72, color: '#4f5964', cover: '#475059', txio: true, onboard: 16,
    leds: [['RUN', 'green'], ['BAT', 'off'], ['TXM', 'yellow'], ['SVC', 'off']],
    com: ['COM1'], lan: 2, mbus: false,
    verified: { dims: false, shape: false, finish: true }, note: 'onboard I/O count from the model name; housing ≈',
  },
  'PXC-COMPACT': {
    key: 'PXC-COMPACT', model: 'PXC36-E.D', label: 'PXC Compact 36 — APOGEE, 36 onboard I/O', family: 'APOGEE PXC Compact',
    style: 'compact', w: 305, h: 150, d: 64, color: '#d4d7d8', cover: '#c8cccd', txio: false, onboard: 36,
    leds: [['RUN', 'green'], ['BAT', 'off'], ['ALN', 'yellow'], ['FLN', 'yellow']],
    com: ['FLN', 'ALN'], lan: 1, mbus: false,
    verified: { dims: false, shape: false, finish: false }, note: 'no TX-I/O modules on a Compact; size and look ≈',
  },
  'PXC-MODULAR': {
    key: 'PXC-MODULAR', model: 'PXC100-E.D', label: 'PXC Modular — APOGEE, TX-I/O', family: 'APOGEE PXC Modular',
    style: 'modular', w: 160, h: 138, d: 70, color: '#d4d7d8', cover: '#c8cccd', txio: true, onboard: 0,
    leds: [['RUN', 'green'], ['BAT', 'off'], ['ALN', 'yellow'], ['FLN', 'yellow']],
    com: ['FLN', 'ALN'], lan: 1, mbus: false,
    verified: { dims: false, shape: false, finish: false }, note: 'size and look ≈',
  },
}
export const CONTROLLER_KEYS = Object.keys(CONTROLLERS)

// ---- TX-I/O --------------------------------------------------------------------
// kind: 'supply' (bus supply / bus connection, no I/O) or 'io'. ch: channel type
// U universal (AI / AO / DI), X super-universal, DI digital in, DO relay out.
// The modules are drawn GREY — the enclosure's grey — as the user asked.
export const MODULES = {
  'TXS1.12F4': { type: 'TXS1.12F4', kind: 'supply', w: 100, label: 'Power supply 1.2 A, 24 V AC fused 4 A', verified: { dims: false, shape: true } },
  'TXS1.EF4': { type: 'TXS1.EF4', kind: 'supply', w: 64, label: 'Bus connection module, 24 V AC fused 4 A', verified: { dims: false, shape: false } },
  'TXM1.8D': { type: 'TXM1.8D', kind: 'io', n: 8, ch: 'DI', w: 64, label: '8 digital inputs', verified: { dims: false, shape: true } },
  'TXM1.16D': { type: 'TXM1.16D', kind: 'io', n: 16, ch: 'DI', w: 64, label: '16 digital inputs', verified: { dims: false, shape: true } },
  'TXM1.8U': { type: 'TXM1.8U', kind: 'io', n: 8, ch: 'U', w: 64, label: '8 universal I/O', verified: { dims: false, shape: true } },
  'TXM1.8U-ML': { type: 'TXM1.8U-ML', kind: 'io', n: 8, ch: 'U', w: 64, lcd: true, label: '8 universal I/O, LCD + local override', verified: { dims: false, shape: true } },
  'TXM1.8X': { type: 'TXM1.8X', kind: 'io', n: 8, ch: 'X', w: 64, label: '8 super-universal I/O', verified: { dims: false, shape: true } },
  'TXM1.8X-ML': { type: 'TXM1.8X-ML', kind: 'io', n: 8, ch: 'X', w: 64, lcd: true, label: '8 super-universal I/O, LCD + local override', verified: { dims: false, shape: true } },
  'TXM1.6R': { type: 'TXM1.6R', kind: 'io', n: 6, ch: 'DO', w: 64, label: '6 relay outputs', verified: { dims: false, shape: true } },
  'TXM1.6R-M': { type: 'TXM1.6R-M', kind: 'io', n: 6, ch: 'DO', w: 64, manual: true, label: '6 relay outputs, manual override', verified: { dims: false, shape: true } },
}
export const MODULE_KEYS = Object.keys(MODULES)
export const MODULE_H = 90      // TX-I/O module height incl. terminal rows ≈
export const MODULE_D = 70
export const CH_WORD = { U: 'universal', X: 'super-universal', DI: 'digital in', DO: 'relay out' }

/** The default fill: bus supply + a sensible AHU-sized module set. */
export const DEFAULT_MODULES = ['TXS1.12F4', 'TXM1.8U', 'TXM1.8U', 'TXM1.8X', 'TXM1.8D', 'TXM1.6R']

// ---- enclosures (portrait, W × H × D inches; light grey powder coat) ------------
// Real Siemens panels (docs/graphic-references/field-panel-real-*.jpg): a tall grey
// cabinet, a perforated grey back plate framed by slotted duct, the controller at the
// top of a VERTICAL DIN rail with the TX-I/O stacked below it, and a power column on
// the right. Sizes are common wall-mount steps ≈.
export const ENCLOSURES = {
  '24x36': { key: '24x36', w: 610, h: 914, d: 203, label: '24 × 36 × 8 in' },
  '30x36': { key: '30x36', w: 762, h: 914, d: 203, label: '30 × 36 × 8 in' },
  '30x42': { key: '30x42', w: 762, h: 1067, d: 203, label: '30 × 42 × 8 in' },
  '30x48': { key: '30x48', w: 762, h: 1219, d: 203, label: '30 × 48 × 8 in' },
  '36x42': { key: '36x42', w: 914, h: 1067, d: 203, label: '36 × 42 × 8 in' },
  '42x42': { key: '42x42', w: 1067, h: 1067, d: 203, label: '42 × 42 × 8 in' },
  '42x48': { key: '42x48', w: 1067, h: 1219, d: 203, label: '42 × 48 × 8 in' },
  '42x60': { key: '42x60', w: 1067, h: 1524, d: 254, label: '42 × 60 × 10 in' },
  '54x60': { key: '54x60', w: 1372, h: 1524, d: 254, label: '54 × 60 × 10 in' },
}
export const ENCLOSURE_KEYS = Object.keys(ENCLOSURES)
export const TRANSFORMERS = [50, 75, 100]  // VA, the power supply's Class 2 output
export const RELAYS_MAX = 8

// layout constants (mm)
const M = 20        // enclosure wall → back plate
const DV = 76       // vertical slotted duct, 3 in
const DH = 76       // horizontal duct (top and bottom runs)
const CW = 260      // a module column: the rail and the wire fan-out either side, between two ducts
const GAP = 20      // duct → first part, and main frame → power column
const SPARE = 60    // auto size keeps at least this much spare rail under the last part
export const PW = 165   // the power column on the right (slim: the supply box is about the PXC7's width)
export const POWER = {
  box: { w: 140, h: 420, d: 110 },       // Siemens power supply enclosure: tall and slim, about the PXC7's width (user photo) — warning label, rocker, circuit label, vents at the bottom
  rcpt: { w: 132, h: 170, d: 70 },       // duplex 120 V receptacle box, as wide as the supply box above it
  tb: { w: 64, h: 110, d: 50 },          // grey terminal-block strip on a short vertical rail
  relay: { w: 140, h: 80, d: 34, gap: 10 },  // RIBMN-style relay on its green PCB
}
export const MODULE_W = 90   // a TX-I/O module across the vertical rail (its height as drawn)

const clone = (x) => JSON.parse(JSON.stringify(x))
const cleanText = (s) => String(s ?? '').replace(/[^\w .\-/#]/g, '').slice(0, 16)

/** A panel config, normalised: unknown controller → PXC7, unknown modules dropped, addresses filled. */
export function panelOf(config) {
  const p = config?.panel || {}
  const controller = CONTROLLERS[p.controller] ? p.controller : 'PXC7'
  const used = new Set()
  const mods = (Array.isArray(p.modules) ? p.modules : []).map((m) => (typeof m === 'string' ? { type: m } : { ...m })).filter((m) => MODULES[m.type])
  for (const m of mods) if (MODULES[m.type].kind === 'io' && Number.isInteger(m.addr) && m.addr > 0 && !used.has(m.addr)) used.add(m.addr); else delete m.addr
  let next = 1
  for (const m of mods) {
    if (MODULES[m.type].kind !== 'io' || m.addr) continue
    while (used.has(next)) next++
    m.addr = next; used.add(next)
  }
  const tv = Number(p.transformer)
  const rl = Math.round(Number(p.relays))
  return {
    controller,
    modules: CONTROLLERS[controller].txio ? mods : [],
    enclosure: ENCLOSURES[p.enclosure] ? p.enclosure : 'auto',
    transformer: TRANSFORMERS.includes(tv) ? tv : 100,
    relays: Number.isFinite(rl) ? Math.max(0, Math.min(RELAYS_MAX, rl)) : 0,
    circuit: { pnl: cleanText(p.circuit?.pnl), ckt: cleanText(p.circuit?.ckt) },
  }
}

/** A new field-panel unit config. */
export function panelConfig({ controller = 'PXC7', modules = DEFAULT_MODULES, enclosure = 'auto', transformer = 100, relays = 0, circuit = null, tag = 'FP' } = {}) {
  const cfg = { tag, service: 'Field Panel', kind: 'panel', panel: { controller, modules: modules.map((t) => ({ type: t })), enclosure, transformer, relays, circuit } }
  cfg.panel = panelOf(cfg)
  return cfg
}
export const DEFAULT_PANEL = panelConfig()

/** The white label on the power supply: "120V FED FROM / PNL __ CKT __". */
export function circuitLabel(panel) {
  const c = panel?.circuit || {}
  return ['120V FED FROM', `PNL ${c.pnl || '____'} CKT ${c.ckt || '__'}`]
}

/** Add a module (at `index`, default the end) with the next free address. Returns a new panel object. */
export function addModule(panel, type, index = null) {
  const p = clone(panel)
  if (!MODULES[type]) return p
  const m = { type }
  if (MODULES[type].kind === 'io') {
    const used = new Set(p.modules.filter((x) => x.addr).map((x) => x.addr))
    let a = 1
    while (used.has(a)) a++
    m.addr = a
  }
  const i = index == null ? p.modules.length : Math.max(0, Math.min(p.modules.length, index))
  p.modules.splice(i, 0, m)
  return p
}
export function removeModule(panel, index) { const p = clone(panel); p.modules.splice(index, 1); return p }
export function moveModule(panel, index, by) {
  const p = clone(panel)
  const j = index + by
  if (j < 0 || j >= p.modules.length) return p
  ;[p.modules[index], p.modules[j]] = [p.modules[j], p.modules[index]]
  return p
}

/** Every point symbol of a panel, in order: onboard I/O, then TX-I/O by rail order. */
export function panelChannels(config) {
  const p = panelOf(config)
  const C = CONTROLLERS[p.controller]
  const out = []
  for (let i = 1; i <= C.onboard; i++) out.push({ sym: `IO_${i}`, sfx: `PNL.IO.${i}`, owner: 'controller', ch: 'U', n: i, label: `${C.key} IO ${i}` })
  p.modules.forEach((m, mi) => {
    const T = MODULES[m.type]
    if (T.kind !== 'io') return
    for (let c = 1; c <= T.n; c++) out.push({ sym: `TX${m.addr}_${c}`, sfx: `PNL.TX${m.addr}.${c}`, owner: mi, addr: m.addr, ch: T.ch, n: c, label: `TX ${m.addr}.${c} · ${T.type} ${T.ch}${c}` })
  })
  return out
}

/** The panel's layout: enclosure, duct frame, module columns, power column and every part's box
 *  (mm; x right from the left inner wall, y down from the top inner wall). */
export function panelLayout(config) {
  const p = panelOf(config)
  const C = CONTROLLERS[p.controller]
  const want = p.enclosure
  const order = want !== 'auto' ? [want] : ENCLOSURE_KEYS
  let lay = null
  for (const k of order) { lay = layoutIn(p, C, ENCLOSURES[k]); if (want !== 'auto' || lay.comfy) break }
  lay.auto = want === 'auto'
  lay.panel = p
  lay.controller = C
  return lay
}

function layoutIn(p, C, E) {
  const W = E.w, H = E.h, D = E.d
  const yTop = M + DH + GAP, yEnd = H - M - DH - GAP      // a column's rail: first part → last usable mm
  const limit = yEnd - SPARE                                // parts stop here, leaving spare rail below
  const items = [], columns = []
  // ---- pack the column(s): controller on top, bus supply, modules; overflow starts a new column ----
  let col = null, y = yTop
  const newCol = () => { col = { index: columns.length, items: [] }; columns.push(col); y = yTop }
  const put = (it) => { it.col = col.index; it.y = y; y += it.h; items.push(it); col.items.push(it); return it }
  newCol()
  put({ kind: 'controller', w: C.h, h: C.w, d: C.d, label: C.model, vertical: true })
  let overflow = y > yEnd
  p.modules.forEach((m, mi) => {
    const T = MODULES[m.type]
    if (y + T.w > limit) {
      newCol()
      // a new column's bus starts with a bus connection module (auto), as in the photos
      if (T.kind !== 'supply') put({ kind: 'module', type: 'TXS1.EF4', auto: true, w: MODULE_W, h: MODULES['TXS1.EF4'].w, d: MODULE_D, label: 'TXS1.EF4' })
    }
    put({ kind: 'module', type: m.type, addr: m.addr ?? null, index: mi, w: MODULE_W, h: T.w, d: MODULE_D, label: m.type })
    if (y > yEnd) overflow = true
  })
  // ---- the duct frame: a vertical duct either side of every column, top and bottom runs ----
  const n = columns.length
  // the columns share the width up to the power column (at least CW each), like the photos
  const px0 = W - M - PW
  const cw = Math.max(CW, (px0 - GAP - M - DV * (n + 1)) / n)
  const frameR = M + DV + n * (cw + DV)
  const ducts = [], rails = []
  for (let i = 0; i <= n; i++) ducts.push({ dir: 'v', x: M + i * (cw + DV), y: M, w: DV, h: H - 2 * M, col: i })
  ducts.push({ dir: 'h', x: M + DV, y: M, w: frameR - M - 2 * DV, h: DH, top: true })
  ducts.push({ dir: 'h', x: M + DV, y: H - M - DH, w: frameR - M - 2 * DV, h: DH, bottom: true })
  for (const c of columns) {
    c.x0 = M + DV + c.index * (cw + DV); c.x1 = c.x0 + cw; c.cx = (c.x0 + c.x1) / 2
    for (const it of c.items) it.x = c.cx - it.w / 2
    c.yTop = yTop; c.yEnd = yEnd; c.used = c.items.length ? c.items[c.items.length - 1].y + c.items[c.items.length - 1].h : yTop
    rails.push({ col: c.index, x: c.cx, y0: yTop - 12, y1: yEnd + 6 })
  }
  // ---- the power column on the right: supply box, receptacle, terminal blocks, relays ----
  const px1 = W - M, pcx = (px0 + px1) / 2
  const power = { x0: px0, x1: px1, items: [] }
  let py = M + 12
  const pput = (it) => { it.x = pcx - it.w / 2; it.y = py; py += it.h + 16; it.power = true; items.push(it); power.items.push(it); return it }
  pput({ kind: 'powerbox', ...POWER.box, label: 'Power supply', va: p.transformer, circuit: circuitLabel(p) })
  pput({ kind: 'rcpt', ...POWER.rcpt, label: 'Duplex receptacle 120 V' })
  pput({ kind: 'tb', ...POWER.tb, label: '24 V terminal blocks' })
  for (let i = 0; i < p.relays; i++) { const r = pput({ kind: 'relay', ...POWER.relay, n: i + 1, label: `Relay ${i + 1} (RIBMN) ≈` }); py -= 16 - POWER.relay.gap; void r }
  power.used = py
  // the back plates: perforated behind the frame; the power column's plate under its boxes
  const plates = [{ x: M, y: M, w: frameR - M, h: H - 2 * M, perf: true }, { x: px0, y: M, w: PW, h: H - 2 * M, perf: true, power: true }]
  // conduits: connectors in the top, over the columns (field wiring) and over the power box (120 V feed)
  const conduits = []
  for (const c of columns) for (const f of [0.28, 0.72]) conduits.push({ x: c.x0 + cw * f, size: 'field' })
  conduits.push({ x: pcx, size: 'power', power: true })
  const fitsW = frameR + GAP <= px0
  const fitsH = !overflow && power.used <= H - M
  const used = Math.max(...columns.map((c) => c.used))
  return {
    enclosure: E, W, H, D, columns, rails, ducts, items, power, plates, conduits,
    frame: { x0: M, x1: frameR, y0: M, y1: H - M },
    fits: fitsW && fitsH, comfy: fitsW && fitsH && columns.every((c) => c.used <= limit + 0.01), used,
  }
}

/** Wall-hung footprint for the plan: the box in front of the wall line (x 0 → depth), across its width. */
export function panelFoot(config, mount = PANEL_DEFAULT_MOUNT) {
  const L = panelLayout(config)
  const d = L.D / 1000, w = L.W / 1000
  return { len: d, wid: w, cx: d / 2, cz: 0, top: mount }
}

/** The part a channel symbol belongs to, for the hint the Commander shows. */
export function panelHint(config, sym) {
  const ch = panelChannels(config).find((c) => c.sym === sym)
  if (!ch) return null
  return { label: ch.label }
}
