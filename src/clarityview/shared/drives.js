// drives.js — wall-hung variable frequency drives, pure data (no DOM, no three.js).
//
// A VFD is a unit of kind 'vfd'; what it is lives in config.vfd:
//   vfd: { make: 'hv600' | 'ach580', hp: 10, volts: 460, drives?: { unitId, fan } }
// Point symbols (bound with Map points): VFD_SS start/stop, VFD_STS run status,
// VFD_SPD speed command %, VFD_HZ output frequency, VFD_AMPS, VFD_KW, VFD_FLT
// fault. The keypad and LEDs show only what these points prove live.
//
// Frame sizes (H × W × D mm, UL Type 1) by horsepower at 460 V. None is
// checked against a manufacturer's dimension sheet here: all ≈.

export const VFD_DEFAULT_MOUNT = 1.676   // floor → top of drive, 5'-6"

export const VFD_MAKES = {
  hv600: {
    key: 'hv600', maker: 'Yaskawa', model: 'HV600', label: 'Yaskawa HV600 (HVAC drive)',
    body: '#c9c4ba', side: '#b2ada3', fins: '#8f8d87', bezel: '#141618', accent: '#1f4f9a',   // warm light grey (photo PH.HV600.06)
    frames: [ // [max hp, H, W, D]
      [3, 260, 140, 176], [7.5, 300, 140, 202], [15, 360, 180, 202], [25, 440, 220, 227],
      [40, 550, 254, 258], [75, 650, 279, 258], [150, 800, 330, 300], [300, 1000, 400, 350],
    ],
    verified: { dims: false, shape: true, finish: true },
  },
  ach580: {
    key: 'ach580', maker: 'ABB', model: 'ACH580-01', label: 'ABB ACH580-01 (HVAC drive)',
    body: '#e3e5e6', side: '#c9cdcf', fins: '#a8adb0', bezel: '#c9cccd', accent: '#2c6fb7',
    frames: [ // R1 … R9
      [5, 373, 125, 223, 'R1'], [10, 473, 125, 229, 'R2'], [25, 454, 203, 237, 'R3'], [40, 600, 203, 257, 'R4'],
      [60, 732, 203, 295, 'R5'], [100, 727, 252, 369, 'R6'], [150, 880, 284, 370, 'R7'], [250, 965, 300, 393, 'R8'], [350, 955, 380, 418, 'R9'],
    ],
    verified: { dims: false, shape: true, finish: true },
  },
}
export const VFD_MAKE_KEYS = Object.keys(VFD_MAKES)
export const VFD_HP = [1, 2, 3, 5, 7.5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300]

export const VFD_POINTS = [
  { sym: 'VFD_SS', sfx: 'VFD.SS', label: 'Start / stop' },
  { sym: 'VFD_STS', sfx: 'VFD.STS', label: 'Run status' },
  { sym: 'VFD_SPD', sfx: 'VFD.SPD', label: 'Speed command' },
  { sym: 'VFD_HZ', sfx: 'VFD.HZ', label: 'Output frequency' },
  { sym: 'VFD_AMPS', sfx: 'VFD.AMPS', label: 'Output current' },
  { sym: 'VFD_KW', sfx: 'VFD.KW', label: 'Output power' },
  { sym: 'VFD_FLT', sfx: 'VFD.FLT', label: 'Fault' },
]

/** config.vfd, normalised. */
export function vfdOf(config) {
  const v = config?.vfd || {}
  const make = VFD_MAKES[v.make] ? v.make : 'hv600'
  const hp = Number(v.hp) > 0 ? Number(v.hp) : 10
  const volts = [208, 230, 460, 575].includes(Number(v.volts)) ? Number(v.volts) : 460
  const drives = v.drives && (v.drives.unitId != null || v.drives.fan) ? { unitId: v.drives.unitId ?? null, name: v.drives.name ? String(v.drives.name) : null, fan: String(v.drives.fan || '') } : null
  return { make, hp, volts, drives }
}

/** The frame a make + hp falls in: { H, W, D, frame } (mm). */
export function vfdFrame(config) {
  const v = vfdOf(config)
  const F = VFD_MAKES[v.make].frames
  const f = F.find((r) => v.hp <= r[0]) || F[F.length - 1]
  return { H: f[1], W: f[2], D: f[3], frame: f[4] || `${f[0]} hp frame`, maxHp: f[0] }
}

export function vfdConfig({ make = 'hv600', hp = 10, volts = 460, tag = 'VFD', drives = null } = {}) {
  return { tag, service: 'Variable Frequency Drive', kind: 'vfd', vfd: vfdOf({ vfd: { make, hp, volts, drives } }) }
}
export const DEFAULT_VFD = vfdConfig()

export function vfdLabel(config) {
  const v = vfdOf(config), M = VFD_MAKES[v.make]
  return `${M.maker} ${M.model} · ${v.hp} hp · ${v.volts} V`
}

export function vfdFoot(config, mount = VFD_DEFAULT_MOUNT) {
  const f = vfdFrame(config)
  const d = f.D / 1000, w = f.W / 1000
  return { len: d, wid: w, cx: d / 2, cz: 0, top: mount }
}

export function vfdHint(config, sym) {
  const p = VFD_POINTS.find((x) => x.sym === sym)
  if (!p) return null
  if (sym === 'VFD_SS') return { label: p.label, proof: 'VFD_STS' }
  return { label: p.label }
}
