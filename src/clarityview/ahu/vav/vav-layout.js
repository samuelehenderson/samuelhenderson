// vav-layout.js — one pure layout of an air terminal (inches, unit frame) that
// drives the 2D drawing, the 3D model, the plan footprint and the inlet anchors
// (vav-spec D2, §4.2–§4.4). Pure: no DOM, no three.js; copied into graphics-kit/.
//
// Unit frame: x along the airflow, origin midway between the upstream collar
// mouth and the downstream outlet face; y up from the casing bottom; z across,
// centred on the casing envelope (a parallel unit's fan box included); +z is
// the right hand (stand at the inlet, look downstream: RH = controls on your
// right). Every dimension comes from resolveDims(); topology from the set's
// arrangement. Nothing here holds a number of its own except drawing slack.
//
// Parts: { id, kind, sec, x0, x1, y0, y1, z0, z1, cyl?: { axis, r }, solid,
// foot, inside? }. foot = part of the air path (the footprint and bbox);
// enclosures, panels, piping, stubs and probes are foot: false (noFootprint).

import { resolveDims, IN } from './vav-geometry.js'
import { VAV_TYPES } from './vav-types.js'
import { terminalOf, normalizeTerminal } from './vav-config.js'

const r3 = (v) => Math.round(v * 1000) / 1000

/** Box part helper (inches). */
function box(id, kind, sec, x0, x1, y0, y1, z0, z1, extra = {}) {
  return { id, kind, sec, x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1), z0: Math.min(z0, z1), z1: Math.max(z0, z1), solid: true, foot: true, ...extra }
}

/**
 * The layout of a terminal (normalised terminal object, or a config with kind 'vav').
 * @returns {{ units:'in', type, reheat, hand, side, cside, dims, source, letter, set, unitSize, missing,
 *   arrangement, parts, sections, inlets, outlet, shafts, mounts, bbox, stream, notes, casingFace, casingEnd }}
 */
export function vavLayout(input) {
  const t = input?.kind === 'vav' ? terminalOf(input) : normalizeTerminal(input)
  const R = resolveDims(t)
  const d = { ...R.dims }
  const A = R.arrangement
  const type = t.type, T = VAV_TYPES[type]
  const side = t.hand === 'L' ? -1 : 1
  const cside = t.options.connHand === 'opposite' ? -side : side
  const notes = []
  const H = d.casingH, W = d.casingW
  const round = d.inletShape !== 'rect'
  const inH = round ? d.inletOD : d.inletH, inW = round ? d.inletOD : d.inletW
  const fanBox = type === 'parallel-fan' ? Math.min(Math.max(d.fanBoxW, 0), W - inW - 2) : 0
  const Wp = W - fanBox                                    // primary-air casing width
  const zp = side * fanBox / 2                             // primary casing centre (fan box on the far side)
  const airValve = t.options.airValve !== false
  const heatSec = t.reheat === 'hw' ? 'coil' : t.reheat === 'elec' ? 'heater' : null
  const coilL = t.options.heatRows >= 3 ? d.coilL34 : d.coilL12
  const attUp = A.attenuatorAt === 'upstream' && t.options.attenuator
  const attDown = !attUp && t.options.attenuator && ['single-duct', 'constant-volume', 'parallel-fan', 'exhaust'].includes(type)
  const dd = T.ducts.length === 2
  const coilAtFan = type === 'parallel-fan' && A.coilAt === 'fan-inlet' && heatSec === 'coil'

  // ---- along x: [attenuator↑] collar | casing | [attenuator↓] | [coil|heater] | outlet ----
  const upL = attUp ? d.attL : 0
  const tailL = (attDown ? d.attL : 0) + (heatSec === 'coil' && !coilAtFan ? coilL : heatSec === 'heater' ? d.heaterL : 0)
  const outL = dd ? d.dischCollarL : d.outletL
  const Ltot = upL + d.collarL + d.casingL + tailL + outL
  const x0 = -Ltot / 2
  const mouth = x0 + upL                                   // collar mouth
  const cf = mouth + d.collarL                             // casing face
  const ce = cf + d.casingL                                // casing end
  const parts = [], sections = [], shafts = [], inlets = []
  const sec = (kind, a, b) => sections.push({ kind, x0: a, x1: b })

  if (attUp) { sec('attenuator', x0, mouth); parts.push(box('att', 'attenuator', 'attenuator', x0, mouth, 0, H, -W / 2, W / 2)) }
  sec('inlet', mouth, cf)

  // ---- controls enclosure(s) on the hand side (dual duct: both sides) ----
  const encX0 = A.ctrlX === 'after-face' ? cf + d.ctrlOffset : cf - d.ctrlOffset
  const encY0 = A.enclosureV === 'bottom' ? 0 : A.enclosureV === 'top' ? H - d.ctrlH : H / 2 - d.ctrlH / 2
  const encSides = A.enclosures === 2 ? [side, -side] : [side]
  const style = t.enclosure.style
  const enclosures = encSides.map((s, i) => ({ side: s, x0: encX0, x1: encX0 + d.ctrlL, y0: encY0, y1: encY0 + d.ctrlH, zWall: s * W / 2, zOut: s * (W / 2 + d.ctrlD), duct: dd ? (i === 0 ? 'cold' : 'hot') : 'primary' }))
  if (style !== 'none') enclosures.forEach((e, i) => parts.push(box(`enc${i}`, 'enclosure', 'inlet', e.x0, e.x1, e.y0, e.y1, e.zWall, e.zOut, { foot: false, style, side: e.side })))

  // ---- inlet stacks: collar, flow cross, valve body, blade on its shaft ----
  const inletZs = dd ? [side * d.ddA / 2, -side * d.ddA / 2]
    : [A.inletZRef === 'far-wall' ? side * (d.inletZ - W / 2) : A.inletZRef === 'hand-wall' ? side * (W / 2 - d.inletZ) : zp]
  const ducts = dd ? ['cold', 'hot'] : [T.ducts[0]]
  inletZs.forEach((zc, i) => {
    const duct = ducts[i], tag = i ? '2' : ''
    const ws = dd ? (i === 0 ? side : -side) : side          // wall the shaft exits toward
    parts.push(box('collar' + tag, 'collar', 'inlet', mouth, cf, d.inletCy - inH / 2, d.inletCy + inH / 2, zc - inW / 2, zc + inW / 2, round ? { cyl: { axis: 'x', r: inH / 2 } } : {}))
    inlets.push({ duct, x: mouth, cy: d.inletCy, cz: zc, od: inH, w: inW, h: inH, shape: round ? 'round' : 'rect' })
    if (!airValve) return
    parts.push(box('cross' + tag, 'flowcross', 'inlet', mouth + d.sensorX - 0.1, mouth + d.sensorX + 0.1, d.inletCy - inH / 2 + 0.3, d.inletCy + inH / 2 - 0.3, zc - inW / 2 + 0.3, zc + inW / 2 - 0.3, { solid: false, inside: 'collar' }))
    let sx = mouth + d.shaftX
    const inCollar = d.shaftX < d.collarL
    const enc = enclosures.find((e) => e.side === ws)
    if (!inCollar && enc && style !== 'none' && (sx < enc.x0 + 1 || sx > enc.x1 - 1)) {
      const nx = Math.min(Math.max(sx, enc.x0 + 1), enc.x1 - 1)
      notes.push(`shaft moved ${r3(nx - sx)} in so it exits into the controls enclosure`)
      sx = nx
    }
    const vbL = Math.max(d.valveBodyL, sx - mouth + d.bladeR + d.clearGap - d.collarL)
    if (vbL > 0) parts.push(box('vbody' + tag, 'valvebody', 'inlet', cf, cf + vbL, d.inletCy - inH / 2, d.inletCy + inH / 2, zc - inW / 2, zc + inW / 2, { solid: false, inside: 'casing', ...(round ? { cyl: { axis: 'x', r: inH / 2 } } : {}) }))
    const zExit = inCollar ? zc + ws * inW / 2 : ws * W / 2
    const zEnd = zExit + ws * d.shaftStub
    parts.push(box('blade' + tag, 'blade', 'inlet', sx - d.bladeR, sx + d.bladeR, d.inletCy - d.bladeR, d.inletCy + d.bladeR, zc - (round ? d.bladeR : inW / 2 - d.bladeGap), zc + (round ? d.bladeR : inW / 2 - d.bladeGap), { solid: false, inside: 'collar', r: d.bladeR, shape: round ? 'disc' : 'rect' }))
    shafts.push({ duct, x: sx, y: d.inletCy, zc, zExit, zEnd, dir: ws, inCollar, dia: d.shaftDia, valveBodyL: vbL, bladeR: d.bladeR })
  })

  // ---- casing (and the parallel fan box beside it) ----
  sec('casing', cf, ce)
  if (type === 'parallel-fan') {
    parts.push(box('casing', 'casing', 'casing', cf, ce, 0, H, zp - Wp / 2, zp + Wp / 2))
    const fz0 = -side * W / 2, fz1 = -side * (W / 2 - fanBox), fzc = (fz0 + fz1) / 2
    parts.push(box('fanbox', 'fanbox', 'casing', cf, ce, 0, H, fz0, fz1))
    let rw = d.returnW, rh = d.returnH
    if (rw > fanBox - 1) { notes.push(`return opening trimmed ${r3(rw - (fanBox - 1))} in to fit the fan box`); rw = fanBox - 1 }
    if (rh > H - 1) { notes.push(`return opening trimmed ${r3(rh - (H - 1))} in to fit the height`); rh = H - 1 }
    parts.push(box('return', 'induced', 'casing', cf - 0.25, cf + 1, (H - rh) / 2, (H + rh) / 2, fzc - rw / 2, fzc + rw / 2, { solid: false, face: 'end', filter: true, role: 'return' }))
    const bx = cf + d.blowerXFrac * d.casingL
    const bdia = Math.min(d.blowerDia, H - 1), bw = Math.min(d.blowerW, fanBox - 1)
    parts.push(box('blower', 'blower', 'casing', bx - bdia / 2, bx + bdia / 2, H / 2 - bdia / 2, H / 2 + bdia / 2, fzc - bw / 2, fzc + bw / 2, { solid: false, inside: 'fanbox', axis: 'z', outlet: 'casing', r: bdia / 2 }))
    const bdw = Math.min(d.backdraftW, d.casingL - 2), bdh = Math.min(d.backdraftH, H - 1)
    parts.push(box('backdraft', 'backdraft', 'casing', bx - bdw / 2, bx + bdw / 2, (H - bdh) / 2, (H + bdh) / 2, fz1 - 0.25, fz1 + 0.25, { solid: false, inside: 'casing' }))
    if (A.hvbox === 'fanbox') parts.push(box('hvbox', 'hvbox', 'casing', ce - d.hvL - 1, ce - 1, H / 2 - d.hvH / 2, H / 2 + d.hvH / 2, fz0, fz0 - side * d.hvD, { foot: false }))
    if (coilAtFan) {
      parts.push(box('coil', 'coil', 'casing', cf - coilL, cf, (H - rh) / 2 - 0.5, (H + rh) / 2 + 0.5, fzc - rw / 2 - 0.5, fzc + rw / 2 + 0.5, { atFan: true }))
    }
  } else {
    parts.push(box('casing', 'casing', 'casing', cf, ce, 0, H, -W / 2, W / 2))
  }
  if (type === 'series-fan') {
    // induced-air opening with its filter, on the upstream end face, away from the primary inlet
    const zin = inletZs[0]
    let iw = Math.min(d.inducedW, W / 2 - 2), ih = Math.min(d.inducedH, H - 1)
    if (iw < d.inducedW) notes.push(`induced opening trimmed ${r3(d.inducedW - iw)} in to fit the half face`)
    const izc = A.inducedZ === 'center' ? 0 : -side * W / 4
    const face = A.inducedFace || 'end'
    if (face === 'end') parts.push(box('induced', 'induced', 'casing', cf - 0.25, cf + 1, (H - ih) / 2, (H + ih) / 2, izc - iw / 2, izc + iw / 2, { solid: false, face, filter: true, role: 'induced' }))
    else if (face === 'bottom') parts.push(box('induced', 'induced', 'casing', cf + 2, cf + 2 + ih, -0.25, 1, izc - iw / 2, izc + iw / 2, { solid: false, face, filter: true, role: 'induced' }))
    else parts.push(box('induced', 'induced', 'casing', cf + 2, cf + 2 + iw, (H - ih) / 2, (H + ih) / 2, -side * W / 2 - 0.25, -side * W / 2 + 1, { solid: false, face, filter: true, role: 'induced' }))
    if (Math.abs(izc - zin) < (iw + inW) / 2 && face === 'end') notes.push('induced opening overlaps the primary inlet on the end face')
    const bx = cf + (A.blowerX === 'center' ? 0.5 : d.blowerXFrac) * d.casingL
    const bdia = Math.min(d.blowerDia, H - 1), bw = Math.min(d.blowerW, W - 2)
    parts.push(box('blower', 'blower', 'casing', bx - bdia / 2, bx + bdia / 2, H / 2 - bdia / 2, H / 2 + bdia / 2, -bw / 2, bw / 2, { solid: false, inside: 'casing', axis: 'z', outlet: A.blowerOutlet, r: bdia / 2 }))
    if (A.hvbox === 'discharge-hand') parts.push(box('hvbox', 'hvbox', 'casing', ce - d.hvL - 2, ce - 2, H / 2 - d.hvH / 2, H / 2 + d.hvH / 2, side * W / 2, side * (W / 2 + d.hvD), { foot: false }))
  }

  // ---- downstream: attenuator, reheat, outlet ----
  let x = ce
  if (attDown) {
    sec('attenuator', x, x + d.attL)
    parts.push(box('att', 'attenuator', 'attenuator', x, x + d.attL, 0, H, zp - Wp / 2, zp + Wp / 2))
    x += d.attL
  }
  // outlet opening (dual duct: the discharge collar opening)
  let ow = dd ? d.dischW : d.outletW, oh = dd ? d.dischH : d.outletH
  if (ow > Wp) { notes.push(`outlet trimmed ${r3(ow - Wp)} in to fit the casing width`); ow = Wp }
  if (oh > H) { notes.push(`outlet trimmed ${r3(oh - H)} in to fit the casing height`); oh = H }
  const oy0 = dd ? Math.min(Math.max((H - oh) / 2, 0), H - oh) : Math.min(Math.max(d.outletY0 ?? (H - oh) / 2, 0), H - oh)
  const ozc = A.outletFixed ? (type === 'parallel-fan' ? zp : 0) : zp
  const fullFace = !outL && heatSec !== 'coil' && heatSec !== 'heater'
  let heatPart = null
  if (heatSec && !coilAtFan) {
    const L2 = heatSec === 'coil' ? coilL : d.heaterL
    // on a fan-powered unit the reheat sits on the discharge opening; on a single-duct box it is the casing section
    const fw = VAV_TYPES[type].fan ? Math.min(ow + 2, Wp) : Wp, fh = VAV_TYPES[type].fan ? Math.min(oh + 2, H) : H
    const fy0 = VAV_TYPES[type].fan ? Math.max(0, Math.min(oy0 - 1, H - fh)) : 0
    sec(heatSec, x, x + L2)
    heatPart = box(heatSec, heatSec, heatSec, x, x + L2, fy0, fy0 + fh, ozc - fw / 2, ozc + fw / 2)
    parts.push(heatPart)
    if (heatSec === 'heater') {
      const pl = Math.min(d.panelL, L2), xc = x + L2 / 2, zw = side * (fw / 2) + ozc
      parts.push(box('panel', 'heaterpanel', heatSec, xc - pl / 2, xc + pl / 2, fy0 + fh / 2 - d.panelH / 2, fy0 + fh / 2 + d.panelH / 2, zw, zw + side * d.panelD, { foot: false }))
    }
    x += L2
  }
  sec('outlet', x, x + outL)
  if (outL > 0) parts.push(box('outlet', 'outlet', 'outlet', x, x + outL, oy0, oy0 + oh, ozc - ow / 2, ozc + ow / 2, { fixed: !!A.outletFixed }))
  const outX = x + outL
  const outlet = { x: outX, y0: oy0, y1: oy0 + oh, z0: ozc - ow / 2, z1: ozc + ow / 2, w: ow, h: oh, zc: ozc, fullFace }

  // ---- off the air path: discharge stub, probes, piping ----
  parts.push(box('stub', 'stub', 'outlet', outX, outX + d.dischStubL, oy0, oy0 + oh, ozc - ow / 2, ozc + ow / 2, { foot: false, solid: false }))
  const mounts = {}
  const S0 = shafts[0]
  if (S0) mounts.controller = { hub: { pos: [S0.x, S0.y, S0.zEnd], normal: [0, 0, S0.dir], up: [0, 1, 0] } }
  const e0 = enclosures[0]
  const plate = { pos: [e0.x0 + d.ctrlPlateX, H / 2, e0.zWall], normal: [0, 0, e0.side], up: [0, 1, 0] }
  mounts.controller = { ...(mounts.controller || {}), plate }
  if (shafts[1]) mounts.damper2 = { hub: { pos: [shafts[1].x, shafts[1].y, shafts[1].zEnd], normal: [0, 0, shafts[1].dir], up: [0, 1, 0] } }
  if (t.reheat !== 'none') mounts.dat = { pos: [outX + d.datProbeX, oy0 + oh, ozc], normal: [0, 1, 0], up: [1, 0, 0] }
  if (t.options.changeover && inlets[0]) {
    const i0 = inlets[0]
    mounts.pat = { pos: [i0.x - d.patProbeX, i0.cy + i0.h / 2, i0.cz], normal: [0, 1, 0], up: [1, 0, 0] }
    parts.push(box('pristub', 'stub', 'inlet', i0.x - d.patProbeX - 3, i0.x, i0.cy - i0.h / 2, i0.cy + i0.h / 2, i0.cz - i0.w / 2, i0.cz + i0.w / 2, { foot: false, solid: false, ...(round ? { cyl: { axis: 'x', r: i0.h / 2 } } : {}) }))
  }
  let pipes = null
  if (t.reheat === 'hw') {
    const cp = heatPart || parts.find((p) => p.id === 'coil')
    const xc = (cp.x0 + cp.x1) / 2
    const zWall = cside > 0 ? cp.z1 : cp.z0                          // coil header side
    const zV = cside * (W / 2 + d.valveOff)                          // valve station
    const zEnd = zV + cside * 2.5                                     // where the building's pipe lands
    const supY = d.connY1, retY = d.connY2
    const valveY = t.options.valveOn === 'supply' ? supY : retY
    pipes = { x: xc, zWall, zValve: zV, zEnd, supY, retY, valveY, r: d.connOD / 2, side: cside, atFan: !!cp.atFan }
    parts.push(box('pipes', 'pipes', cp.sec === 'casing' ? 'casing' : 'coil', xc - d.connOD, xc + d.connOD, supY - d.connOD, retY + d.connOD, zWall, zEnd, { foot: false, solid: false }))
    mounts.valve = { pos: [xc, valveY, zV], normal: [0, 1, 0], up: [1, 0, 0] }
  }

  // ---- bbox = the air path only ----
  const foot = parts.filter((p) => p.foot)
  const bbox = {
    x0: Math.min(...foot.map((p) => p.x0)), x1: Math.max(...foot.map((p) => p.x1)),
    y0: Math.min(...foot.map((p) => p.y0)), y1: Math.max(...foot.map((p) => p.y1)),
    z0: Math.min(...foot.map((p) => p.z0)), z1: Math.max(...foot.map((p) => p.z1)),
  }

  // ---- the air stream (centre line), for chevrons and particles ----
  const i0 = inlets[0] || { x: mouth, cy: H / 2, cz: zp }
  const stream = [[i0.x - 6, i0.cy, i0.cz], [i0.x, i0.cy, i0.cz], [cf + Math.min(6, d.casingL / 3), i0.cy, i0.cz], [ce - 2, oy0 + oh / 2, ozc], [outX, oy0 + oh / 2, ozc], [outX + d.dischStubL, oy0 + oh / 2, ozc]]

  return {
    units: 'in', type, reheat: t.reheat, hand: t.hand, side, cside, terminal: t,
    dims: d, source: R.source, letter: R.letter, set: R.set, unitSize: R.unitSize, missing: R.missing, arrangement: A,
    parts, sections, inlets, outlet, shafts, enclosures, mounts, pipes, bbox, stream, notes,
    mouth, casingFace: cf, casingEnd: ce, W, Wp, zp, fanBox, H,
  }
}

/** The parts of one kind. */
export const partsOf = (layout, kind) => layout.parts.filter((p) => p.kind === kind)

/**
 * The terminal's air-path footprint in metres, centred on its placement point, or null.
 * { len, wid, top, bottom, cx, cz, inlets: [{ duct, dx, dz, y, dia }], outlet: { dx, dz, y, w, h } | null, ctrlSide: 1 | -1 }
 * Heights (top, bottom, y) are above the floor: the box hangs at mount.ceiling + mount.gap.
 */
export function vavFootprint(config) {
  if (config?.kind !== 'vav') return null
  const L = vavLayout(config)
  const b = L.bbox, t = L.terminal
  const base = t.mount.ceiling + t.mount.gap
  const m = (v) => r3(v * IN)
  return {
    len: m(b.x1 - b.x0), wid: m(b.z1 - b.z0), top: r3(base + b.y1 * IN), bottom: r3(base + b.y0 * IN),
    cx: m((b.x0 + b.x1) / 2), cz: m((b.z0 + b.z1) / 2),
    inlets: L.inlets.map((i) => ({ duct: i.duct, dx: m(i.x), dz: m(i.cz), y: r3(base + i.cy * IN), dia: m(i.od) })),
    outlet: L.outlet ? { dx: m(L.outlet.x), dz: m(L.outlet.zc), y: r3(base + ((L.outlet.y0 + L.outlet.y1) / 2) * IN), w: m(L.outlet.w), h: m(L.outlet.h) } : null,
    ctrlSide: L.side,
  }
}
