// vav-parts.js — which Siemens part sits where on an air terminal, and how big
// its stand-in is until the SIEMENS field-device library draws the real thing.
// Pure; copied into graphics-kit/ (with web/shared/siemens/select.js + catalog.js).
//
// House default (user decision Q1, integration plan §3.2): the integrated
// DXR2.E10PL-102B controller + actuator on the damper shaft; a box with no
// damper gets the DXR2.E12P-102B on its casing. Label 'E' = BACnet/IP.
// SIEMENS owns the constant (SIEMENS_DEFAULTS.vav); this module only reads it.

import { SIEMENS_DEFAULTS } from '../../shared/siemens/select.js'

/** The controller part a terminal carries: its own model, else the house default for its family. null = not known (TEC with no model set). */
export function controllerPart(t) {
  if (t?.controller?.model) return t.controller.model
  const fam = t?.controller?.family || 'dxr2'
  if (fam === 'tec') return null
  const shaft = t?.options?.airValve !== false
  if (fam === 'dxr1') return shaft ? 'DXR1.E10PL' : 'DXR1.E12P'
  return shaft ? SIEMENS_DEFAULTS.vav.controller : SIEMENS_DEFAULTS.vav.controllerNoShaft
}

/** Does this controller part carry its own damper actuator (mounts on the shaft)? */
export function isActuatingPart(part) {
  return /\b(DXR[12]\.[EM]10PL|GDB181)/i.test(String(part || ''))
}

/** Short name for a drawing label: 'DXR2', 'DXR1', 'TEC', else the part's first token. */
export function partShort(part, family) {
  const p = String(part || '').toUpperCase()
  if (p.startsWith('DXR2')) return 'DXR2'
  if (p.startsWith('DXR1')) return 'DXR1'
  if (/TEC/.test(p) || family === 'tec') return 'TEC'
  return p.split(/[.\s-]/)[0] || '—'
}

/**
 * Catalogue housing sizes (mm: length along its mounting face × height × depth)
 * for the placeholder boxes drawn when the SIEMENS library has not drawn a part.
 */
export const PLACEHOLDER_MM = {
  'DXR2.E10PL': [201, 136.94, 81.72],
  'DXR2.M10PL': [201, 136.94, 81.72],
  'DXR1.E10PL': [201, 136.94, 81.72],
  'DXR2.E12P': [180, 104.5, 59.5],
  'DXR2.E17CX': [216, 104.5, 59.5],
  'DXR1.E12P': [180, 104.5, 59.5],
  'GDE131.1P': [137, 70, 60],
  'SAS81.03U': [151, 80, 93],
  'QAM2130': [80, 60, 31],
  TEC: [170, 110, 60],               // TEC / ATEC terminal controller, UNVERIFIED size
}

/** Placeholder size (mm) for a part string. */
export function placeholderMm(part, fallback = 'TEC') {
  const p = String(part || '').toUpperCase()
  const key = Object.keys(PLACEHOLDER_MM).find((k) => p.startsWith(k.toUpperCase()))
  return PLACEHOLDER_MM[key || fallback]
}

/** Default reheat valve actuator (2-way on the return line, user decision Q1c). */
export const DEFAULT_VALVE_ACTUATOR = 'SAS81.03U'
/** Default damper actuator behind a non-actuating controller. */
export const defaultDamperActuator = () => SIEMENS_DEFAULTS.vav.damper
