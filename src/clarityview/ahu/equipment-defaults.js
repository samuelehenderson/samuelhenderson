// Equipment default configs — the starting UNIT config for each HMI graphic
// type. All seven render on the SAME engine (web/ahu/engine.js); they differ only
// in their section list, sensors, shell, and zone/command wiring. A new unit is
// cloned from one of these, then the tech maps each symbol to a real point.
//
// Symbol names (RHV, ZNT, CCV…) are arbitrary handles; the "Map points" modal
// binds them to discovered points. Writable symbols command through the BACnet
// priority array; the rest drive the live display.

import { vavConfig } from './vav/vav-config.js'
// P2 PANELS: wall-hung field panels and VFDs (web/shared/siemens/panels.js, web/shared/drives.js)
import { DEFAULT_PANEL } from '../shared/siemens/panels.js'
import { DEFAULT_VFD } from '../shared/drives.js'
import { hhwConfig } from './hx/hhw.js' // P5 HX
export { DEFAULT_PANEL, DEFAULT_VFD }

// ─── AHU: full draw-through air handler (from the TresLeches design) ──────────
export const DEFAULT_AHU = {
  tag: 'AHU', service: 'Draw-Through', kind: 'ahu',
  // Header controls (Commander): a chip per bound point, beside the SA readout.
  controls: [
    { point: 'SAT_SP', label: 'SA setpoint', role: 'supply-sp' },
    { point: 'SSP_SP', label: 'Static SP', role: 'static-sp' },
    { point: 'OCC_CMD', label: 'Occupancy', role: 'occ' },
    { point: 'AHU_EN', label: 'Enable', role: 'enable' },
  ],
  mixing: { outsideDamper: 'OAD', returnDamper: 'MAD' },
  supply: [
    { device: 'damper', label: 'OA Damper', point: 'OAD', signal: '0-10' },
    { device: 'damper', label: 'Mixing', point: 'MAD', signal: '0-10' },
    { device: 'filter', label: 'Pre-Filter', point: 'PFIL' },
    { device: 'filter', label: 'Final Filter', point: 'FFIL', final: true },
    { device: 'coil', label: 'Heating Coil', variant: 'heat', point: 'PHCV', valve: true, valveType: 'electric-3way' },
    { device: 'coil', label: 'Cooling Coil', variant: 'cool', point: 'CCV', valve: true, valveType: 'electric-3way' },
    // Humidifier commands via its modulating output (.MOD on Siemens panels).
    { device: 'humidifier', label: 'Humidifier', point: 'HUM_MOD' },
    // Each fan is a full point set, matching real panel naming: latched
    // start/stop (.SS), proof (.STS), VFD speed (.SVD), fault (.FLT).
    // Same fan drawing on both decks: housed centrifugal, discharging with the
    // air (right on supply; the engine mirrors it to discharge left on return).
    {
      device: 'fan', label: 'Supply Fans', count: 2, fanType: 'housed-centrifugal', fans: [
        { cmd: 'SF1_SS', status: 'SF1_STS', speed: 'SF1_SVD', fault: 'SF1_FLT' },
        { cmd: 'SF2_SS', status: 'SF2_STS', speed: 'SF2_SVD', fault: 'SF2_FLT' },
      ],
    },
    { device: 'plenum', label: 'Discharge' },
  ],
  sensors: [
    { tag: 'OAT', label: 'OA Temp', at: 'oa' },
    { tag: 'MAT', label: 'Mixed Air', at: 'mixed', after: 'Mixing' },
    { tag: 'PHCT', label: 'Preheat Lvg', after: 'Heating Coil' },
    { tag: 'CCT', label: 'Cooling Lvg', after: 'Cooling Coil' },
    { tag: 'SAT', label: 'Supply Air', at: 'sa' },
    { tag: 'RAT', label: 'Return Air', deck: 'return', after: 'Return' },
  ],
  supplyStatic: { point: 'SSP' },
  airStations: [
    { tag: 'OACFM', after: 'OA Damper' },
    { tag: 'SACFM', after: 'Discharge' },
    { tag: 'RACFM', deck: 'return', after: 'Return Fan' },
  ],
  economizer: { label: 'Economizer', point: 'ECON', signal: '0-10' },
  return: [
    { device: 'plenum', label: 'Return', noLabel: true },
    {
      device: 'fan', label: 'Return Fan', count: 2, fanType: 'housed-centrifugal', fans: [
        { cmd: 'RF1_SS', status: 'RF1_STS', fault: 'RF1_FLT' },
        { cmd: 'RF2_SS', status: 'RF2_STS', fault: 'RF2_FLT' },
      ],
    },
    { device: 'damper', label: 'RA Damper', point: 'RAD', signal: 'binary' },
  ],
}

// ─── RTU: packaged rooftop unit ────────────────────────────────────────────────
// An air handler on the roof: the same air side (2D graphic, points, recognition
// all as an AHU, kind 'ahu'); `form: 'rtu'` draws it in 3D as a rooftop unit with
// its condensing section, side discharge and return from the curb (3d/rtu3d.js).
// Points follow an RTU's usual set; anything the unit does not have stays unbound
// and is left out of the 3D view.
export const DEFAULT_RTU = {
  tag: 'RTU', service: 'Rooftop Unit', kind: 'ahu', form: 'rtu',
  controls: [
    { point: 'SAT_SP', label: 'SA setpoint', role: 'supply-sp' },
    { point: 'OCC_CMD', label: 'Occupancy', role: 'occ' },
    { point: 'AHU_EN', label: 'Enable', role: 'enable' },
  ],
  mixing: { outsideDamper: 'OAD', returnDamper: 'MAD' },
  supply: [
    { device: 'damper', label: 'OA Damper', point: 'OAD', signal: '0-10' },
    { device: 'damper', label: 'Mixing', point: 'MAD', signal: '0-10' },
    { device: 'filter', label: 'Filter', point: 'FFIL', final: true },
    { device: 'coil', label: 'Cooling Coil', variant: 'cool', point: 'CCV', valve: true, valveType: 'electric-3way' },
    { device: 'coil', label: 'Heating', variant: 'heat', point: 'HCV' },
    {
      device: 'fan', label: 'Supply Fan', count: 1, fanType: 'housed-centrifugal', fans: [
        { cmd: 'SF1_SS', status: 'SF1_STS', speed: 'SF1_SVD', fault: 'SF1_FLT' },
      ],
    },
    { device: 'plenum', label: 'Discharge' },
  ],
  sensors: [
    { tag: 'OAT', label: 'OA Temp', at: 'oa' },
    { tag: 'MAT', label: 'Mixed Air', at: 'mixed', after: 'Mixing' },
    { tag: 'SAT', label: 'Supply Air', at: 'sa' },
    { tag: 'RAT', label: 'Return Air', deck: 'return', after: 'Return' },
  ],
  economizer: { label: 'Economizer', point: 'ECON', signal: '0-10' },
  return: [
    { device: 'plenum', label: 'Return', noLabel: true },
    {
      device: 'fan', label: 'Return Fan', count: 1, fanType: 'housed-centrifugal', fans: [
        { cmd: 'RF1_SS', status: 'RF1_STS', fault: 'RF1_FLT' },
      ],
    },
  ],
}

// ─── RTU on chilled water: a rooftop air handler with no condensing section ──
// The same unit on the same curb, but cooled from a plant instead of making its
// own cooling: a modulating CHW valve, no compressors — and so nothing on the
// roof for propeller fans to sit on. `condenser: false` tells 3d/rtu3d.js to
// leave the condensing section off; the air side, the curb return and the end
// discharge transition are all as drawn. Checked against a roof photograph of
// the real units (2026-10-30): panelised top with access panels, a louvre at
// one end, the discharge transition at the other, control panel on the side.
export const DEFAULT_RTU_CHW = {
  ...JSON.parse(JSON.stringify(DEFAULT_RTU)),
  service: 'Rooftop Unit — chilled water',
  condenser: false,
}

// ─── VAV (legacy): hydronic reheat room terminal, the older AHU-style drawing ─
// Valve-only: primary air → reheat coil (HW valve %) → discharge → zone panel.
// No air damper/CFM (a cooling air-box adds a `damper` section + `airStation`).
// Kept (and exported) so VAVs saved in this shape keep loading and rendering
// unchanged; new VAVs are terminal shells (DEFAULT_VAV below, web/ahu/vav/).
export const LEGACY_VAV = {
  tag: 'VAV', service: 'Reheat Terminal', kind: 'vav',
  inletLabel: 'PRIMARY', outletLabel: 'TO ZONE →',
  supply: [
    { device: 'plenum', label: 'Primary Air' },
    { device: 'coil', label: 'Reheat Coil', variant: 'heat', point: 'RHV', valve: true, valveType: 'electric-3way' },
    { device: 'plenum', label: 'Discharge' },
    {
      device: 'zone', label: 'Zone / Room',
      tempPoint: 'ZNT', spDisplay: 'ZNSP_EFF', spCommand: 'ZNSP', occPoint: 'OCC',
      co2Point: 'CO2', humPoint: 'RH',
      modeDisplay: 'MODE_EFF', modeCommand: 'MODE',
      modeStates: ['—', 'Comfort', 'Standby', 'Economy', 'Protection'],
      spMin: 60, spMax: 85, spDecimals: 1, spLabel: 'Room Setpoint',
    },
  ],
  sensors: [
    { tag: 'DAT', label: 'Discharge Air', after: 'Reheat Coil' },
  ],
}

// ─── VAV / air terminal: single duct, hot-water reheat, 8 in, controls right,
// Siemens DXR2 (17 handles). The variant lives in config.terminal; see
// web/ahu/vav/vav-config.js (types, handles) and SCHEMATICS.md (geometry).
export const DEFAULT_VAV = vavConfig('single-duct', { reheat: 'hw', size: '8', hand: 'R', family: 'dxr2' })

// ─── FCU: 4-pipe fan coil (OA damper, filter, cooling + heating coils, fan) ───
export const DEFAULT_FCU = {
  tag: 'FCU', service: 'Fan Coil Unit', kind: 'fcu',
  inletLabel: 'ENTERING', outletLabel: 'SUPPLY →',
  supply: [
    { device: 'damper', label: 'OA Damper', point: 'OAD', signal: '0-10' },
    { device: 'filter', label: 'Filter', point: 'FIL' },
    { device: 'coil', label: 'Cooling Coil', variant: 'cool', point: 'CCV', valve: true, valveType: 'electric-3way' },
    { device: 'coil', label: 'Heating Coil', variant: 'heat', point: 'HCV', valve: true, valveType: 'electric-3way' },
    { device: 'fan', label: 'Fan', point: 'FAN', count: 1 },
    { device: 'plenum', label: 'Supply' },
    {
      device: 'zone', label: 'Zone', tempPoint: 'ZNT', spDisplay: 'ZNSP_EFF', spCommand: 'ZNSP', occPoint: 'OCC',
      modeDisplay: 'MODE_EFF', modeCommand: 'MODE',
      modeStates: ['—', 'Off', 'Fan Only', 'Cooling', 'Heating', 'Auto'],
      spMin: 60, spMax: 85, spDecimals: 1, spLabel: 'Zone Setpoint',
    },
  ],
  sensors: [
    { tag: 'EAT', label: 'Entering', at: 'oa' },
    { tag: 'DAT', label: 'Discharge', after: 'Fan' },
  ],
}

// ─── CRAC / Liebert: computer-room AC (return → filter → coil → hum → fans) ───
export const DEFAULT_CRAC = {
  tag: 'CRAC', service: 'Computer Room AC', kind: 'crac',
  inletLabel: 'RETURN', outletLabel: 'SUPPLY ↓',
  supply: [
    { device: 'filter', label: 'Filter', point: 'FIL' },
    { device: 'coil', label: 'Cooling Coil', variant: 'cool', point: 'CCV', valve: true, valveType: 'electric-3way' },
    { device: 'humidifier', label: 'Humidifier', point: 'HUM' },
    { device: 'fan', label: 'EC Fans', point: 'FAN', count: 2 },
    { device: 'plenum', label: 'Supply' },
    {
      device: 'zone', label: 'Room', tempPoint: 'RMT', spDisplay: 'RMT_SP', spCommand: 'RMT_SP_CMD',
      occPoint: 'UNIT_ON', occLabels: { on: 'RUNNING', off: 'OFF' }, humPoint: 'RMH',
      tempLabel: 'ROOM °F', spLabel: 'Room Temp Setpoint',
      modeDisplay: 'UNIT_MODE', modeCommand: 'UNIT_MODE_CMD',
      modeStates: ['—', 'Standby', 'Cooling', 'Dehumidify', 'Humidify', 'Reheat'],
      spMin: 60, spMax: 85, spDecimals: 1,
    },
  ],
  sensors: [
    { tag: 'RAT', label: 'Return', at: 'oa' },
    { tag: 'SAT', label: 'Supply', at: 'sa' },
  ],
}

// ─── Heat Exchanger: plate HX on the hydronic (plant) shell ───────────────────
// Primary (hot) side control valve → HX block → building side pump. Four water
// temps around it. Uses shell:'plant' (no air hoods, blue loop-flow arrows).
// The older single-exchanger section config: units saved in this shape keep loading and drawing
// (section engine + Hx3DView). New heat exchangers are HHW plants (DEFAULT_HX below, hx/hhw.js).
export const LEGACY_HX = {
  tag: 'HX', service: 'Heat Exchanger', kind: 'hx', shell: 'plant',
  inletLabel: 'PRIMARY', outletLabel: 'SECONDARY →',
  supply: [
    { device: 'plenum', label: 'Primary In' },
    { device: 'coil', label: 'Primary Side', variant: 'heat', point: 'PRIVLV', valve: true, valveType: 'electric-3way' },
    { device: 'hx', label: 'Heat Exchanger', point: 'PRIVLV' },
    { device: 'coil', label: 'Building Side', variant: 'heat', point: 'SECPMP', pump: true, pumpPoint: 'SECPMP', pumpCommand: true },
    { device: 'plenum', label: 'Secondary Out' },
  ],
  sensors: [
    { tag: 'PRIT_IN', label: 'Pri In', at: 'oa' },
    { tag: 'PRIT_OUT', label: 'Pri Lvg', after: 'Primary Side' },
    { tag: 'SECT_IN', label: 'Sec Rtn', after: 'Heat Exchanger' },
    { tag: 'SECT_OUT', label: 'Sec Sup', at: 'sa' },
  ],
}

// ─── Heat exchanger / HHW plant: two plate HXs (each with 2 isolation valves), a 1/3 + 2/3
// primary valve pair, loop bypass, two VFD pumps, supply/return temps, loop dP (hx/hhw.js).
export const DEFAULT_HX = hhwConfig()

// ─── Boiler: hot-water boiler on the hydronic (plant) shell ───────────────────
// One section carries the boiler's point set: enable (commanded), status/proof,
// firing rate, fault, and its circulating pump. Return water in on the left,
// supply out on the right, with the stack and setpoint beside the vessel.
export const DEFAULT_BOILER = {
  tag: 'BLR', service: 'Hot Water Boiler', kind: 'boiler', shell: 'plant',
  inletLabel: 'HW RETURN', outletLabel: 'HW SUPPLY →',
  supply: [
    { device: 'plenum', label: 'Return In' },
    {
      device: 'boiler', label: 'Boiler', point: 'BLR_EN', statusPoint: 'BLR_STS',
      firePoint: 'BLR_FIRE', faultPoint: 'BLR_FLT', pumpPoint: 'BLR_PMP',
    },
    { device: 'plenum', label: 'Supply Out' },
  ],
  sensors: [
    { tag: 'HWR', label: 'HW Return', at: 'oa' },
    { tag: 'STACK', label: 'Stack', after: 'Boiler' },
    { tag: 'HWS_SP', label: 'HWS Setpoint', after: 'Boiler' },
    { tag: 'HWS', label: 'HW Supply', at: 'sa' },
  ],
}

// ─── Chillers: the chilled-water plant on the hydronic (plant) shell ─────────
// One 'chiller' section carries the machine's point set, the way a BAS sees a
// chiller over BACnet: enable (commanded), run status, % load (capacity or
// % RLA), common alarm, evaporator flow proof, the compressors' run status and
// the chilled-water pump. Chilled water returns in on the left and leaves as
// supply on the right.
//
// Air-cooled (scroll/screw, roof or pad mounted): condenser fans on V-coils.
export const DEFAULT_CHILLER_AC = {
  tag: 'CH', service: 'Air-Cooled Chiller', kind: 'chiller-ac', shell: 'plant',
  inletLabel: 'CHW RETURN', outletLabel: 'CHW SUPPLY →',
  supply: [
    { device: 'plenum', label: 'CHW Return' },
    {
      device: 'chiller', label: 'Chiller', condenser: 'air',
      point: 'CH_EN', statusPoint: 'CH_STS', loadPoint: 'CH_LOAD', faultPoint: 'CH_FLT',
      flowPoint: 'CHW_FLOW', pumpPoint: 'CHWP', compressors: ['C1_STS', 'C2_STS'], condFanPoint: 'CF_STS',
    },
    { device: 'plenum', label: 'CHW Supply' },
  ],
  sensors: [
    { tag: 'CHWR', label: 'CHW Return', at: 'oa' },
    { tag: 'CHWS_SP', label: 'CHWS Setpoint', after: 'Chiller' },
    { tag: 'OAT', label: 'Ambient', after: 'Chiller' },
    { tag: 'CHWS', label: 'CHW Supply', at: 'sa' },
  ],
}

// Water-cooled (centrifugal, in the plant room): evaporator and condenser
// shells, compressor and motor on top. The return deck is the condenser-water
// loop to and from the cooling tower (right to left, under the same machine),
// so the chiller is drawn once across both decks.
export const DEFAULT_CHILLER_WC = {
  tag: 'CH', service: 'Water-Cooled Chiller', kind: 'chiller-wc', shell: 'plant',
  inletLabel: 'CHW RETURN', outletLabel: 'CHW SUPPLY →',
  returnLabel: 'TO TOWER ←', returnInLabel: 'FROM TOWER',
  supply: [
    { device: 'plenum', label: 'CHW Return' },
    {
      device: 'chiller', label: 'Chiller', condenser: 'water',
      point: 'CH_EN', statusPoint: 'CH_STS', loadPoint: 'CH_LOAD', faultPoint: 'CH_FLT',
      flowPoint: 'CHW_FLOW', condFlowPoint: 'CW_FLOW', pumpPoint: 'CHWP', condPumpPoint: 'CWP',
      compressors: ['COMP_STS'],
    },
    { device: 'plenum', label: 'CHW Supply' },
  ],
  return: [
    { device: 'plenum', label: 'CW Leaving' },
    { device: 'plenum', label: 'Condenser', w: 3.0, noLabel: true },
    { device: 'plenum', label: 'CW Entering' },
  ],
  sensors: [
    { tag: 'CHWR', label: 'CHW Return', at: 'oa' },
    { tag: 'CHWS_SP', label: 'CHWS Setpoint', after: 'Chiller' },
    { tag: 'CHWS', label: 'CHW Supply', at: 'sa' },
    { tag: 'CWS', label: 'CW Entering', deck: 'return', after: 'Condenser' },
    { tag: 'CWR', label: 'CW Leaving', deck: 'return', after: 'CW Leaving' },
  ],
}

// ─── Cooling tower: induced-draft crossflow, one fan per cell ─────────────────
// Condenser water comes back hot from the chillers (CWR), is spread over the
// fill from the hot-water basins on top, cooled by the air the fans pull in
// through the louvers, and leaves cold from the basin (CWS). Each cell's fan
// is a full point set (start/stop, proof, VFD speed, fault); the tower adds
// its bypass valve, basin heater, makeup valve and vibration switch.
export const DEFAULT_TOWER = {
  tag: 'CT', service: 'Cooling Tower', kind: 'tower', shell: 'plant',
  inletLabel: 'CW RETURN', outletLabel: 'CW SUPPLY →',
  supply: [
    { device: 'plenum', label: 'CW Return' },
    {
      device: 'tower', label: 'Cooling Tower', cells: 2,
      fans: [
        { cmd: 'CTF1_SS', status: 'CTF1_STS', speed: 'CTF1_SVD', fault: 'CTF1_FLT' },
        { cmd: 'CTF2_SS', status: 'CTF2_STS', speed: 'CTF2_SVD', fault: 'CTF2_FLT' },
      ],
      bypassPoint: 'CT_BYP', heaterPoint: 'BSN_HTR', makeupPoint: 'MU_VLV', vibPoint: 'CT_VIB',
    },
    { device: 'plenum', label: 'CW Supply' },
  ],
  sensors: [
    { tag: 'CWR', label: 'CW Return', at: 'oa' },
    { tag: 'CWS_SP', label: 'CWS Setpoint', after: 'Cooling Tower' },
    { tag: 'OAWB', label: 'Wet Bulb', after: 'Cooling Tower' },
    { tag: 'BSN_T', label: 'Basin', after: 'Cooling Tower' },
    { tag: 'CWS', label: 'CW Supply', at: 'sa' },
  ],
}

// ─── Booster pumps: a chilled-water pump station, duty / standby ─────────────
// Pumps in parallel between a suction and a discharge header, each a full
// point set (start/stop, proof, VFD speed, fault), controlled to the loop
// differential pressure. It sits inline: chiller → suction, discharge → coils.
export const DEFAULT_BOOSTER = {
  tag: 'BP', service: 'CHW Booster Pumps', kind: 'booster', shell: 'plant',
  inletLabel: 'SUCTION', outletLabel: 'DISCHARGE →',
  supply: [
    { device: 'plenum', label: 'Suction' },
    {
      device: 'booster', label: 'Booster Pumps',
      pumps: [
        { cmd: 'BP1_SS', status: 'BP1_STS', speed: 'BP1_SVD', fault: 'BP1_FLT' },
        { cmd: 'BP2_SS', status: 'BP2_STS', speed: 'BP2_SVD', fault: 'BP2_FLT' },
      ],
    },
    { device: 'plenum', label: 'Discharge' },
  ],
  sensors: [
    { tag: 'SUC_P', label: 'Suction', at: 'oa', unit: 'psi' },
    { tag: 'DP', label: 'Loop DP', after: 'Booster Pumps', unit: 'psi' },
    { tag: 'DP_SP', label: 'DP Setpoint', after: 'Booster Pumps', unit: 'psi' },
    { tag: 'CHW_FLOW', label: 'Flow', after: 'Booster Pumps', unit: 'gpm' },
    { tag: 'DIS_P', label: 'Discharge', at: 'sa', unit: 'psi' },
  ],
}

// ─── ERU: energy recovery unit (supply deck + exhaust deck + wheel) ───────────
// Outside air → filter → energy wheel → supply fan; return air → exhaust fan →
// the other half of the wheel → exhaust damper. The return deck lists its
// sections left to right with the same widths as the supply deck, so the
// wheel spacer (w 1.6) lines up under the wheel and the 2D wheel spans both.
export const DEFAULT_ERU = {
  tag: 'ERU', service: 'Energy Recovery Unit', kind: 'eru',
  inletLabel: 'OA IN', outletLabel: 'SA →',
  supply: [
    { device: 'damper', label: 'OA Damper', point: 'OAD', signal: '0-10' },
    { device: 'filter', label: 'OA Filter', point: 'FIL' },
    {
      device: 'wheel', label: 'Energy Wheel', point: 'WHL_SS', statusPoint: 'WHL_STS',
      speedPoint: 'WHL_SVD', faultPoint: 'WHL_FLT', bypassPoint: 'WHL_BYP',
    },
    {
      device: 'fan', label: 'Supply Fan', count: 1, fanType: 'housed-centrifugal', fans: [
        { cmd: 'SF1_SS', status: 'SF1_STS', speed: 'SF1_SVD', fault: 'SF1_FLT' },
      ],
    },
    { device: 'plenum', label: 'Discharge' },
  ],
  return: [
    { device: 'damper', label: 'EA Damper', point: 'EAD', signal: '0-10' },
    { device: 'plenum', label: 'Exhaust', w: 1.5 },
    { device: 'plenum', label: 'Wheel (exhaust side)', w: 1.6, noLabel: true },
    {
      device: 'fan', label: 'Exhaust Fan', count: 1, fanType: 'housed-centrifugal', fans: [
        { cmd: 'EF1_SS', status: 'EF1_STS', speed: 'EF1_SVD', fault: 'EF1_FLT' },
      ],
    },
    { device: 'plenum', label: 'Return' },
  ],
  sensors: [
    { tag: 'OAT', label: 'OA Temp', at: 'oa' },
    { tag: 'WLAT', label: 'Wheel Lvg', after: 'Energy Wheel' },
    { tag: 'SAT', label: 'Supply Air', at: 'sa' },
    { tag: 'RAT', label: 'Return Air', deck: 'return', after: 'Return' },
    { tag: 'EXAT', label: 'Exhaust Air', deck: 'return', after: 'Exhaust' },
  ],
  airStations: [
    { tag: 'SACFM', after: 'Discharge' },
  ],
}

// ─── EF: an exhaust fan as a unit of its own ─────────────────────────────────
// The commonest piece of equipment on a site and the smallest: an isolation
// damper, one fan (start/stop, proof, VFD speed, fault) and the exhaust static
// it is often controlled to. Points are the bare suffixes under the tag
// (GVL.B1.4.EF176.STS, EF176.ISO, EF176.EVD); on APOGEE EF plants the bare tag
// itself is the start/stop. Drawn on the same engine as the AHU: a short
// casing, air in from the space on the left, out to atmosphere on the right.
export const DEFAULT_EF = {
  tag: 'EF', service: 'Exhaust Fan', kind: 'ef',
  inletLabel: 'FROM SPACE', outletLabel: 'EXHAUST →',
  controls: [
    { point: 'EF_SP', label: 'Static SP', role: 'static-sp' },
    { point: 'EF_SS', label: 'Start / stop', role: 'enable' },
  ],
  supply: [
    { device: 'damper', label: 'Isolation Damper', point: 'EF_ISO', signal: 'binary' },
    {
      device: 'fan', label: 'Exhaust Fan', count: 1, fanType: 'housed-centrifugal', fans: [
        { cmd: 'EF_SS', status: 'EF_STS', speed: 'EF_SVD', fault: 'EF_FLT' },
      ],
    },
    { device: 'plenum', label: 'Discharge' },
  ],
  sensors: [
    { tag: 'EXAT', label: 'Exhaust Air', at: 'oa' },
  ],
  supplyStatic: { point: 'EF_PRESS' },
}

// Registry driving the "New equipment" type picker and the list badges.
export const EQUIPMENT_TYPES = [
  { key: 'ahu', label: 'AHU — Air Handler', prefix: 'AHU', config: DEFAULT_AHU },
  { key: 'rtu', label: 'RTU — Rooftop Unit', prefix: 'RTU', config: DEFAULT_RTU },
  { key: 'rtu-chw', label: 'RTU — Rooftop, chilled water', prefix: 'RTU', config: DEFAULT_RTU_CHW },
  { key: 'vav', label: 'VAV / Air terminal', prefix: 'VAV', config: DEFAULT_VAV, variants: true },
  { key: 'fcu', label: 'FCU — Fan Coil Unit', prefix: 'FCU', config: DEFAULT_FCU },
  { key: 'crac', label: 'CRAC / Liebert', prefix: 'CRAC', config: DEFAULT_CRAC },
  { key: 'hx', label: 'Heat Exchanger — HHW plant', prefix: 'HX', config: DEFAULT_HX, lab: false },
  { key: 'boiler', label: 'Boiler', prefix: 'BLR', config: DEFAULT_BOILER },
  { key: 'ef', label: 'EF — Exhaust Fan', prefix: 'EF', config: DEFAULT_EF },
  { key: 'eru', label: 'ERU — Energy Recovery', prefix: 'ERU', config: DEFAULT_ERU },
  { key: 'chiller-ac', label: 'Chiller — Air-Cooled', prefix: 'CH', config: DEFAULT_CHILLER_AC },
  { key: 'chiller-wc', label: 'Chiller — Water-Cooled (Centrifugal)', prefix: 'CH', config: DEFAULT_CHILLER_WC },
  { key: 'tower', label: 'Cooling Tower', prefix: 'CT', config: DEFAULT_TOWER },
  { key: 'booster', label: 'Booster Pumps — Chilled Water', prefix: 'BP', config: DEFAULT_BOOSTER },
  // P2 PANELS: wall-hung (mech rooms)
  { key: 'panel', label: 'Field Panel — Siemens PXC + TX-I/O', prefix: 'FP', config: DEFAULT_PANEL, wall: true },
  { key: 'vfd', label: 'VFD — Variable Frequency Drive', prefix: 'VFD', config: DEFAULT_VFD, wall: true },
]

export function typeOf(config) {
  // a form (an RTU is kind 'ahu', form 'rtu') names its own type
  const key = (config && config.form) || (config && config.kind)
  return EQUIPMENT_TYPES.find((t) => t.key === key) || EQUIPMENT_TYPES.find((t) => t.key === config?.kind) || EQUIPMENT_TYPES[0]
}
