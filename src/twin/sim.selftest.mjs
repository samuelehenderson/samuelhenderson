// Headless self-test for the Digital Twin building simulation.
// Run: node src/twin/sim.selftest.mjs   (plain node, no dependencies; exits 1 on any failure)
import { createSim } from './sim.js';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; if (failures.length < 40) failures.push(msg); }
}
function section(name) { console.log(`\n▸ ${name}`); }
const now = () => (globalThis.performance ? performance.now() : Date.now());

// advance a sim by `simSeconds` of simulated time using real-time steps of `dt` at `speed`
function run(sim, simSeconds, { speed = 60, dt = 0.1, each } = {}) {
  sim.speed = speed;
  const n = Math.ceil(simSeconds / (speed * dt));
  for (let i = 0; i < n; i++) { sim.step(dt); if (each) each(sim.state, i); }
}

// ---- deep finiteness walk
function allFinite(obj, path = 'state', bad = []) {
  if (bad.length > 5) return bad;
  if (typeof obj === 'number') { if (!Number.isFinite(obj)) bad.push(`${path}=${obj}`); return bad; }
  if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) allFinite(obj[k], `${path}.${k}`, bad);
  return bad;
}
const inR = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;
function saneRanges(sim) {
  const s = sim.state, e = [];
  const chk = (v, lo, hi, name) => { if (!inR(v, lo, hi)) e.push(`${name}=${v}`); };
  chk(s.hour, 0, 24, 'hour'); if (!Number.isInteger(s.day) || s.day < 0 || s.day > 6) e.push(`day=${s.day}`);
  chk(s.oat, 40, 115, 'oat'); chk(s.oah, 0, 100, 'oah'); chk(s.daylight, 0, 1, 'daylight');
  chk(s.occupancy, 0, 1, 'occupancy'); chk(s.kw, 0, 600, 'kw'); chk(s.kwh, 0, 6000, 'kwh'); chk(s.cop, 0, 12, 'cop');
  chk(s.sunAlt, -Math.PI / 2, Math.PI / 2, 'sunAlt'); chk(s.sunAz, 0, 2 * Math.PI, 'sunAz');
  for (const [id, z] of Object.entries(s.zones)) {
    chk(z.temp, 50, 100, `${id}.temp`); chk(z.sp, 60, 85, `${id}.sp`); chk(z.occ, 0, 1, `${id}.occ`);
    chk(z.damper, 0, 100, `${id}.damper`); chk(z.cfm, 0, z.cfmMax * 1.001, `${id}.cfm`); chk(z.reheat, 0, 100, `${id}.reheat`);
    if (typeof z.lights !== 'boolean') e.push(`${id}.lights`);
    if (!['ok', 'warm', 'cool', 'alarm'].includes(z.status)) e.push(`${id}.status=${z.status}`);
    if (!(z.alarm === null || typeof z.alarm === 'string')) e.push(`${id}.alarm`);
  }
  for (const [id, a] of Object.entries(s.ahus)) {
    for (const k of ['sfSpeed', 'rfSpeed', 'oad', 'ccv', 'hcv']) chk(a[k], 0, 100, `${id}.${k}`);
    for (const k of ['sat', 'satSp', 'mat', 'rat']) chk(a[k], 40, 110, `${id}.${k}`);
    for (const k of ['rad', 'ead']) chk(a[k], 0, 100, `${id}.${k}`);
    for (const k of ['pfDp', 'ffDp']) chk(a[k], 0, 3, `${id}.${k}`);
    if (typeof a.sfFault !== 'boolean') e.push(`${id}.sfFault`);
    chk(a.ssp, 0, 3, `${id}.ssp`); chk(a.sspSp, 0.5, 2, `${id}.sspSp`); chk(a.cfm, 0, a.cfmDesign * 1.1, `${id}.cfm`);
    if (typeof a.on !== 'boolean') e.push(`${id}.on`);
  }
  const P = s.plant;
  for (const [id, c] of Object.entries(P.chillers)) { chk(c.load, 0, 100, `${id}.load`); chk(c.chws, 35, 90, `${id}.chws`); chk(c.chwr, 35, 95, `${id}.chwr`); chk(c.kw, 0, 150, `${id}.kw`); chk(c.cwl, 50, 110, `${id}.cwl`); }
  const H = P.hhw;
  chk(H.hws, 60, 200, 'hhw.hws'); chk(H.hwr, 50, 200, 'hhw.hwr');
  for (const k of ['u', 'cv1', 'cv1Fb', 'cv2', 'cv2Fb', 'byp', 'bypFb']) chk(H[k], 0, 100, `hhw.${k}`);
  chk(H.dp, 0, 30, 'hhw.dp'); chk(H.load, 0, 1500, 'hhw.load'); chk(H.steam, 0, 1600, 'hhw.steam');
  H.hx.forEach((x, i) => { chk(x.iso1, 0, 100, `hhw.hx${i + 1}.iso1`); if (x.iso2 !== 0 && x.iso2 !== 1) e.push(`hhw.hx${i + 1}.iso2=${x.iso2}`); });
  if (H.hx.length !== 2) e.push(`hhw.hx.length=${H.hx.length}`);
  for (const k of ['enabled', 'lagHx', 'lagPump', 'tempAlarm']) if (typeof H[k] !== 'boolean') e.push(`hhw.${k}`);
  if (!['HWP-1', 'HWP-2'].includes(H.leadPump)) e.push(`hhw.leadPump=${H.leadPump}`);
  chk(P.tower.fan, 0, 100, 'tower.fan'); chk(P.tower.cws, 40, 110, 'tower.cws'); chk(P.tower.cwr, 40, 115, 'tower.cwr');
  for (const [id, p] of Object.entries(P.pumps)) chk(p.speed, 0, 100, `${id}.speed`);
  chk(P.chwsSp, 40, 50, 'chwsSp'); chk(P.hwsSp, 100, 180, 'hwsSp');
  for (const [id, f] of Object.entries(s.flows)) chk(f, 0, 1, `flow.${id}`);
  if (!Array.isArray(s.alarms) || !Array.isArray(s.faults)) e.push('alarms/faults arrays');
  return e;
}
const zonesOf = (sim, levels) => sim.layout.zones.filter((z) => levels.includes(z.level));
const avgT = (sim, zs) => zs.reduce((a, z) => a + sim.state.zones[z.id].temp, 0) / zs.length;
const hasAlarm = (sim, id) => sim.state.alarms.some((a) => a.id === id);

// =============================================================================================
section('layout');
{
  const sim = createSim();
  const L = sim.layout;
  ok(L.footprint.w === 40 && L.footprint.d === 24, 'footprint 40×24');
  ok(L.levels.map((l) => l.id).join() === 'B1,L1,L2,L3,L4,L5,L6,RF', 'levels B1..RF');
  ok(L.levels.find((l) => l.id === 'B1').y === -4.5 && L.levels.find((l) => l.id === 'RF').y === 24, 'level elevations');
  ok(L.core.x0 === -6 && L.core.x1 === 6 && L.core.z0 === -4 && L.core.z1 === 4, 'core extents');
  ok(L.zones.length === 60, `60 zones (got ${L.zones.length})`);
  for (let n = 1; n <= 6; n++) ok(L.zones.filter((z) => z.level === `L${n}`).length === 10, `10 zones on L${n}`);
  const ids = new Set();
  for (const z of L.zones) {
    ids.add(z.id);
    ok(/^L[1-6]-(0[1-9]|10)$/.test(z.id), `zone id format ${z.id}`);
    ok(z.vav === `VAV-${z.id.slice(1, 2)}-${z.id.slice(3)}`, `vav id for ${z.id}`);
    ok(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW'].includes(z.exposure), `exposure ${z.id}`);
    ok(!(z.x0 >= -10 && z.x1 <= 10 && z.z0 >= -4 && z.z1 <= 4), `zone ${z.id} not in core`);
    ok(typeof z.name === 'string' && z.name.length > 3, `name ${z.id}`);
    ok(sim.state.zones[z.id] !== undefined, `state for ${z.id}`);
  }
  ok(ids.size === 60, 'zone ids unique');
  ok(L.zones.filter((z) => z.level === 'L1' && z.name.startsWith('Lobby')).length === 2, 'L1 has two lobby cells');
  ok(L.zones.find((z) => z.id === 'L3-07').exposure === 'SW', 'L3-07 is the SW corner');
  const eq = new Map(L.equipment.map((e) => [e.id, e]));
  const EQ_IDS = ['AHU-1', 'AHU-2', 'CH-1', 'CH-2', 'HHW-1', 'CHWP-1', 'CHWP-2', 'HWP-1', 'HWP-2', 'CWP-1', 'CT-1'];
  for (const id of EQ_IDS) ok(eq.has(id), `equipment ${id}`);
  ok(L.equipment.length === EQ_IDS.length, `exactly ${EQ_IDS.length} pieces of equipment (got ${L.equipment.length})`);
  const json = JSON.stringify(L);
  ok(!json.includes('"B-1"') && !/boiler/i.test(json), 'the layout has no B-1 / boiler');
  for (const e of L.equipment) {
    ok(['ahu', 'chiller', 'hhw', 'pump', 'tower'].includes(e.kind), `kind ${e.id}`);
    if (e.parent !== undefined) ok(eq.has(e.parent) && eq.get(e.parent).level === e.level && e.kind === 'pump', `${e.id}: parent ${e.parent} exists on the same level`);
    ok([e.x, e.y, e.z, e.w, e.h, e.d, e.rotY].every(Number.isFinite), `finite geometry ${e.id}`);
    ok(Math.abs(e.x) + e.w / 2 <= 20.01 && Math.abs(e.z) + e.d / 2 <= 12.01, `${e.id} inside footprint`);
    ok(e.w > 0 && e.h > 0 && e.d > 0, `${e.id} has a real size`);
    ok(e.y === L.levels.find((l) => l.id === e.level).y, `${e.id} sits on its level`);
  }
  const KINDS = ['sa', 'ra', 'chws', 'chwr', 'hws', 'hwr', 'cws', 'cwr'];
  const runIds = new Set();
  for (const r of L.runs) {
    runIds.add(r.id);
    ok(KINDS.includes(r.kind), `run kind ${r.id}`);
    ok(Array.isArray(r.points) && r.points.length >= 2, `run ${r.id} has ≥2 points`);
    ok(r.points.every((p) => p.length === 3 && p.every(Number.isFinite)), `run ${r.id} finite points`);
    ok(r.points.every((p) => Math.abs(p[0]) <= 20 && Math.abs(p[2]) <= 12 && p[1] >= -4.5 && p[1] <= 28), `run ${r.id} inside building envelope`);
    ok(Number.isFinite(r.size) && r.size > 0, `run ${r.id} size`);
    ok(r.level === null || L.levels.some((l) => l.id === r.level), `run ${r.id} level`);
  }
  ok(runIds.size === L.runs.length, 'run ids unique');
  for (const z of L.zones) {
    const sa = L.runs.find((r) => r.id === `sa-${z.id}`);
    ok(sa && sa.serves === z.id && sa.kind === 'sa', `supply branch to ${z.vav}`);
    if (sa) {
      const end = sa.points[sa.points.length - 1];
      ok(Math.abs(end[0] - z.vavPos[0]) < 1e-9 && Math.abs(end[1] - z.vavPos[1]) < 1e-9 && Math.abs(end[2] - z.vavPos[2]) < 1e-9, `branch ends at ${z.vav}`);
      ok(Math.abs(end[1] - ((z.floor - 1) * 4 + 3.4)) < 1e-9, `branch at ceiling height ${z.id}`);
    }
    ok(L.runs.some((r) => r.id === `hws-${z.id}` && r.kind === 'hws'), `HW branch to ${z.vav}`);
  }
  for (let n = 1; n <= 6; n++) {
    ok(L.runs.some((r) => r.id === `sa-L${n}` && r.kind === 'sa'), `supply ring L${n}`);
    ok(L.runs.some((r) => r.id === `ra-L${n}` && r.kind === 'ra'), `return main L${n}`);
    ok(L.runs.some((r) => r.id === `hws-L${n}`) && L.runs.some((r) => r.id === `hwr-L${n}`), `HW loops L${n}`);
  }
  for (const k of KINDS) ok(L.runs.some((r) => r.kind === k), `has ${k} runs`);
  ok(['CHWP-1', 'CHWP-2'].every((id, i) => eq.get(id).parent === `CH-${i + 1}`) && ['HWP-1', 'HWP-2'].every((id) => eq.get(id).parent === 'HHW-1'), 'skid / plant pumps name their unit as parent');
  ok(eq.get('AHU-2').rotY === Math.PI && eq.get('AHU-1').rotY === 0, 'AHU-2 turned 180° (both discharge west, service sides to the core)');
  for (const k of ['sa', 'ra', 'chws', 'chwr', 'hws', 'hwr', 'cws', 'cwr']) ok(L.runs.some((r) => r.kind === k && r.level === null), `${k} riser`);
  console.log(`  ${L.runs.length} runs, ${L.equipment.length} equipment, ${L.zones.length} zones`);
}

// =============================================================================================
section('24 h at several speeds — finite, in range');
for (const [speed, dt] of [[60, 0.1], [600, 1 / 60], [3600, 0.25], [3600, 1], [10, 1]]) {
  const sim = createSim({ seed: 11, startHour: 0.25 });
  const hours = speed === 10 ? 2 : 24;
  let badF = null, badR = null, i = 0;
  run(sim, hours * 3600, {
    speed, dt,
    each: () => {
      if (i++ % 7 !== 0) return;
      if (!badF) { const b = allFinite(sim.state); if (b.length) badF = b; }
      if (!badR) { const r = saneRanges(sim); if (r.length) badR = r; }
    },
  });
  ok(!badF, `finite @${speed}× dt=${dt}: ${badF}`);
  ok(!badR, `ranges @${speed}× dt=${dt}: ${badR && badR.slice(0, 5)}`);
  ok(allFinite(sim.state).length === 0 && saneRanges(sim).length === 0, `final state sane @${speed}×`);
  console.log(`  ${speed}× dt=${dt.toFixed(3)} → ${sim.state.timeLabel}, kWh ${sim.state.kwh.toFixed(0)}, alarms ${sim.state.alarms.length}`);
}
{
  // a normal weekday with no faults should not raise space or equipment alarms
  const sim = createSim({ seed: 7, startHour: 5 });
  let maxAlarms = 0, ids = new Set();
  run(sim, 16 * 3600, { speed: 600, dt: 1 / 30, each: (s) => { maxAlarms = Math.max(maxAlarms, s.alarms.length); for (const a of s.alarms) ids.add(a.id); } });
  ok(maxAlarms === 0, `no alarms on a normal weekday (saw ${[...ids].join(', ')})`);
}

// =============================================================================================
section('occupied vs unoccupied');
{
  const sim = createSim({ seed: 7, startHour: 10 });
  const s = sim.state;
  ok(s.timeLabel.startsWith('Tue 10:00'), `starts Tue 10:00 (${s.timeLabel})`);
  ok(s.occupiedMode === true, 'occupied at Tue 10:00');
  ok(s.occupancy > 0.5, `occupancy > 50% (${s.occupancy.toFixed(2)})`);
  ok(s.ahus['AHU-1'].on && s.ahus['AHU-2'].on, 'AHUs running');
  ok(s.ahus['AHU-1'].cfm > 8000 && s.ahus['AHU-2'].cfm > 8000, 'AHU airflow');
  ok(Math.abs(s.ahus['AHU-1'].ssp - s.ahus['AHU-1'].sspSp) < 0.15, 'duct static at setpoint');
  ok(Math.abs(s.ahus['AHU-1'].sat - s.ahus['AHU-1'].satSp) < 1.0, 'SAT at setpoint');
  ok(s.ahus['AHU-1'].satSp >= 55 && s.ahus['AHU-1'].satSp <= 60, 'SAT SP within 55–60 reset');
  ok(Object.values(s.plant.chillers).some((c) => c.on && c.load > 10), 'a chiller is carrying load');
  ok(Math.abs(s.plant.chws - s.plant.chwsSp) < 1.0, `CHWS at setpoint (${s.plant.chws.toFixed(1)})`);
  ok(s.plant.tower.on && s.plant.pumps['CWP-1'].on, 'tower + condenser pump on with chillers');
  const zt = Object.values(s.zones);
  ok(zt.every((z) => Math.abs(z.temp - z.sp) < 2.5), `zones within SP ±2.5 (${Math.min(...zt.map((z) => z.temp)).toFixed(1)}–${Math.max(...zt.map((z) => z.temp)).toFixed(1)})`);
  ok(zt.filter((z) => z.lights).length >= 50, 'lights on when occupied');
  ok(zt.every((z) => z.cfm > 0), 'every VAV has airflow');
  ok(s.kw > 60 && s.kw < 300, `daytime kW plausible (${s.kw.toFixed(0)})`);
  ok(s.cop > 2.5 && s.cop < 8, `plant COP plausible (${s.cop.toFixed(2)})`);
  ok(sim.layout.runs.filter((r) => r.kind === 'sa').every((r) => s.flows[r.id] > 0), 'all supply runs flowing');
  const dayKw = s.kw;

  sim.setHour(3);
  ok(Math.abs(s.hour - 3) < 1e-6, `setHour(3) → ${s.hour}`);
  ok(s.occupiedMode === false, 'unoccupied at 03:00');
  ok(s.occupancy < 0.02, 'nobody in at 03:00');
  ok(!s.ahus['AHU-1'].on && !s.ahus['AHU-2'].on, 'AHUs off at night');
  ok(s.ahus['AHU-1'].cfm === 0 && Object.values(s.zones).every((z) => z.cfm === 0), 'no airflow at night');
  ok(sim.layout.runs.filter((r) => r.kind === 'sa' || r.kind === 'ra').every((r) => s.flows[r.id] === 0), 'air runs stopped at night');
  ok(Object.values(s.plant.chillers).every((c) => !c.on), 'chillers off at night');
  ok(s.kw < dayKw * 0.3, `night kW well below day (${s.kw.toFixed(1)} vs ${dayKw.toFixed(1)})`);
  ok(s.daylight === 0 && s.sunAlt < 0, 'sun down at 03:00');
  ok(Object.values(s.zones).every((z) => z.temp > 60 && z.temp < 85), 'zones inside setback band');

  sim.setHour(14);
  ok(s.occupiedMode && s.ahus['AHU-2'].on && s.daylight > 0.9, 'setHour(14) back to occupied, sunny');
  ok(allFinite(s).length === 0 && saneRanges(sim).length === 0, 'state sane after jumps');
  // jump all around the clock
  let bad = 0;
  for (let h = 0; h <= 24; h += 0.75) { sim.setHour(h); if (allFinite(s).length || saneRanges(sim).length) bad++; }
  ok(bad === 0, `setHour sweep keeps state sane (${bad} bad)`);
  sim.setHour(NaN); sim.setHour('x'); sim.setHour(-5); sim.setHour(99);
  ok(allFinite(s).length === 0, 'setHour garbage input is harmless');
  sim.step(NaN); sim.step(-1); sim.step(1e9); sim.speed = NaN; sim.step(0.1); sim.speed = 60;
  ok(allFinite(s).length === 0 && saneRanges(sim).length === 0, 'step garbage input is harmless');

  // weekend: fast-forward to Saturday 10:00
  const w = createSim({ seed: 7, startHour: 10 });
  run(w, 4 * 24 * 3600, { speed: 3600, dt: 1 });
  ok(w.state.day === 5 && Math.abs(w.state.hour - 10) < 0.05, `fast-forward to Sat 10:00 (${w.state.timeLabel})`);
  ok(w.state.occupiedMode === false, 'Saturday is unoccupied');
  ok(w.state.occupancy < 0.1, 'Saturday occupancy is low');
  ok(allFinite(w.state).length === 0 && saneRanges(w).length === 0, 'state sane after 4 days at 3600×');
}

// =============================================================================================
section('faults');
{
  // vav-stuck on a sunny afternoon
  const sim = createSim({ seed: 7, startHour: 14.5 });
  const r = sim.injectFault('vav-stuck');
  ok(r && typeof r.alarmId === 'string' && typeof r.target === 'string' && typeof r.text === 'string', 'vav-stuck returns {alarmId,target,text}');
  const zid = r.target, z = sim.state.zones[zid];
  ok(!!z, `vav-stuck target is a zone (${zid})`);
  ok(zid.startsWith('L3-'), 'vav-stuck picks a zone on L3');
  ok(hasAlarm(sim, r.alarmId), 'vav-stuck alarm appears');
  ok(sim.state.faults.includes('vav-stuck'), 'faults lists vav-stuck');
  const sp = z.sp;
  let crossedAt = -1, k = 0;
  run(sim, 3600, { speed: 60, dt: 0.1, each: (s) => { k++; if (crossedAt < 0 && s.zones[zid].temp > sp + 3) crossedAt = k * 6; } });
  ok(z.damper === 0 && z.cfm < 0.05 * z.cfmMax, 'stuck damper stays shut, no airflow');
  ok(crossedAt > 0, `stuck zone > SP+3 within a sim hour (now ${z.temp.toFixed(1)} °F)`);
  ok(hasAlarm(sim, `hi-temp:${zid}`), 'high-temp alarm raised for stuck zone');
  ok(z.status === 'alarm' && typeof z.alarm === 'string', 'zone status = alarm');
  ok(z.damperCmd > 50, 'VAV loop is calling for more air');
  console.log(`  ${zid} (${sim.layout.zones.find((q) => q.id === zid).name}) crossed SP+3 after ${(crossedAt / 60).toFixed(0)} sim min`);
  const others = Object.entries(sim.state.zones).filter(([id]) => id !== zid);
  ok(others.every(([, q]) => Math.abs(q.temp - q.sp) < 2.5), 'other zones unaffected');
  sim.clearFaults();
  ok(!hasAlarm(sim, r.alarmId) && sim.state.faults.length === 0, 'clearFaults removes vav-stuck alarm');
  run(sim, 3600, { speed: 600, dt: 1 / 30 });
  ok(z.temp < z.sp + 2 && z.cfm > 0, `stuck zone recovers after clear (${z.temp.toFixed(1)} °F)`);
  ok(!hasAlarm(sim, `hi-temp:${zid}`), 'high-temp alarm clears after recovery');
}
{
  // chiller-trip in the afternoon (both chillers running) and in the morning (lag off)
  for (const h of [14.5, 9.25]) {
    const sim = createSim({ seed: 7, startHour: h });
    const P = sim.state.plant;
    const ch2WasOn = P.chillers['CH-2'].on;
    const r = sim.injectFault('chiller-trip');
    ok(r && r.target === 'CH-1' && hasAlarm(sim, r.alarmId), `chiller-trip alarm @${h}`);
    let maxChws = P.chws;
    run(sim, 25 * 60, { speed: 60, dt: 0.1, each: (s) => { maxChws = Math.max(maxChws, s.plant.chws); } });
    const c1 = P.chillers['CH-1'], c2 = P.chillers['CH-2'];
    ok(c1.status === 'tripped' && !c1.on && c1.load === 0 && c1.kw === 0, `CH-1 tripped and unloaded @${h}`);
    ok(c2.on && c2.status === 'running' && c2.load > 30 && c2.lead, `CH-2 lead and loaded (${c2.load.toFixed(0)}%) @${h}`);
    ok(maxChws > P.chwsSp + (ch2WasOn ? 0.2 : 2), `CHWS rose transiently (${maxChws.toFixed(1)} °F) @${h}`);
    if (ch2WasOn) ok(P.chws < P.chwsSp + 4, `CHWS held near SP with CH-2 alone at full load (${P.chws.toFixed(1)}) @${h}`);
    else ok(P.chws < maxChws - 2 && P.chws < P.chwsSp + 1.5, `CHWS recovered after CH-2 started (${P.chws.toFixed(1)}) @${h}`);
    console.log(`  @${h}: CH-2 ${ch2WasOn ? 'already running' : 'started'}, CHWS peak ${maxChws.toFixed(1)} °F, now ${P.chws.toFixed(1)} °F, CH-2 ${c2.load.toFixed(0)}%`);
    sim.clearFaults();
    ok(!hasAlarm(sim, r.alarmId), 'chiller-trip alarm cleared');
    run(sim, 20 * 60, { speed: 60, dt: 0.1 });
    ok(P.chillers['CH-1'].status === 'running' && P.chillers['CH-1'].lead, `CH-1 back as lead after clear @${h}`);
  }
}
{
  // fan-fail: AHU-2 supply fan
  const sim = createSim({ seed: 7, startHour: 14.5 });
  const upper = zonesOf(sim, ['L4', 'L5', 'L6']), lower = zonesOf(sim, ['L1', 'L2', 'L3']);
  const t0 = avgT(sim, upper), l0 = avgT(sim, lower);
  const r = sim.injectFault('fan-fail');
  ok(r && r.target === 'AHU-2' && hasAlarm(sim, r.alarmId), 'fan-fail alarm');
  run(sim, 120, { speed: 60, dt: 0.1 });
  const a2 = sim.state.ahus['AHU-2'];
  ok(!a2.on && a2.sfSpeed < 1 && a2.cfm === 0 && a2.ssp < 0.05, 'AHU-2 stopped, no flow / static');
  ok(typeof a2.alarm === 'string', 'AHU-2 alarm field set');
  ok(upper.every((z) => sim.state.zones[z.id].cfm === 0), 'L4–L6 VAV airflow is zero');
  const a2runs = sim.layout.runs.filter((q) => (q.kind === 'sa' || q.kind === 'ra') && (q.serves === 'AHU-2' || upper.some((z) => z.id === q.serves)));
  ok(a2runs.length >= 30 && a2runs.every((q) => sim.state.flows[q.id] === 0 && sim.flowOf(q) === 0), 'AHU-2 air runs stop flowing');
  ok(sim.state.ahus['AHU-1'].on && sim.state.flows['sa-riser-AHU-1'] > 0, 'AHU-1 unaffected');
  run(sim, 3600, { speed: 60, dt: 0.1 });
  const t1 = avgT(sim, upper), l1 = avgT(sim, lower);
  ok(t1 > t0 + 2, `L4–L6 drift warm (${t0.toFixed(1)} → ${t1.toFixed(1)} °F)`);
  ok(Math.abs(l1 - l0) < 1.5, `L1–L3 hold (${l0.toFixed(1)} → ${l1.toFixed(1)} °F)`);
  ok(upper.some((z) => sim.state.zones[z.id].status === 'warm'), 'upper zones show warm');
  ok(upper.every((z) => sim.state.zones[z.id].damper > 90), 'starved VAVs drive dampers open');
  console.log(`  L4–L6 avg ${t0.toFixed(1)} → ${t1.toFixed(1)} °F in 1 sim h`);
  sim.clearFaults();
  run(sim, 2 * 3600, { speed: 600, dt: 1 / 30 });
  ok(sim.state.ahus['AHU-2'].on && sim.state.ahus['AHU-2'].cfm > 8000, 'AHU-2 restarts after clear');
  ok(avgT(sim, upper) < t0 + 1, `L4–L6 recover (${avgT(sim, upper).toFixed(1)} °F)`);
  ok(sim.state.alarms.length === 0, `no alarms left after recovery (${sim.state.alarms.map((a) => a.id)})`);
}
{
  // hot-day: compare against an identical twin without the fault
  const a = createSim({ seed: 3, startHour: 13 }), b = createSim({ seed: 3, startHour: 13 });
  const r = b.injectFault('hot-day');
  ok(r && hasAlarm(b, r.alarmId) && b.state.faults.includes('hot-day'), 'hot-day alarm');
  run(a, 40 * 60, { speed: 60, dt: 0.1 }); run(b, 40 * 60, { speed: 60, dt: 0.1 });
  ok(b.state.oat - a.state.oat > 9, `hot-day raises OAT (+${(b.state.oat - a.state.oat).toFixed(1)} °F)`);
  ok(b.state.plant.chwLoad > a.state.plant.chwLoad, 'hot-day raises CHW load');
  ok(b.state.kw > a.state.kw, 'hot-day raises building kW');
  b.clearFaults();
  run(a, 60 * 60, { speed: 60, dt: 0.1 }); run(b, 60 * 60, { speed: 60, dt: 0.1 });
  ok(Math.abs(b.state.oat - a.state.oat) < 0.5, `OAT back to normal after clear (Δ ${(b.state.oat - a.state.oat).toFixed(2)})`);
}
{
  // all four at once, then clear
  const sim = createSim({ seed: 9, startHour: 15 });
  const res = ['vav-stuck', 'chiller-trip', 'fan-fail', 'hot-day'].map((k) => sim.injectFault(k));
  ok(res.every((x) => x && hasAlarm(sim, x.alarmId)), 'all four fault alarms present');
  ok(sim.state.faults.length === 4, 'four faults listed');
  ok(sim.injectFault('vav-stuck').alarmId === res[0].alarmId, 're-injecting is idempotent');
  ok(sim.injectFault('nope') === null, 'unknown fault → null');
  ok(sim.state.alarms[0].severity === 'high', 'alarms sorted by severity');
  const v0 = sim.state.alarmsVersion;
  run(sim, 1800, { speed: 600, dt: 1 / 30 });
  ok(allFinite(sim.state).length === 0 && saneRanges(sim).length === 0, 'state sane with all faults');
  sim.clearFaults();
  ok(sim.state.faults.length === 0 && res.every((x) => !hasAlarm(sim, x.alarmId)), 'clearFaults removes every fault alarm');
  ok(sim.state.alarmsVersion > v0, 'alarmsVersion bumps on change');
  run(sim, 2 * 3600, { speed: 600, dt: 1 / 30 });
  ok(sim.state.alarms.length === 0, `quiet after clear + 2 h (${sim.state.alarms.map((a) => a.id)})`);
}

// =============================================================================================
section('describe() + flowOf()');
{
  const sim = createSim({ seed: 7, startHour: 15 });
  sim.injectFault('vav-stuck');
  const ids = [...sim.layout.zones.map((z) => z.id), ...sim.layout.vavs.map((v) => v.id), ...sim.layout.equipment.map((e) => e.id),
    ...sim.layout.levels.map((l) => l.id), 'building', sim.layout.runs[0].id];
  let bad = [];
  for (const id of ids) {
    const d = sim.describe(id);
    const okShape = d && typeof d.title === 'string' && d.title && typeof d.subtitle === 'string' && typeof d.kind === 'string'
      && Array.isArray(d.rows) && d.rows.length > 0
      && d.rows.every((r) => Array.isArray(r) && r.length >= 2 && r.length <= 4 && typeof r[0] === 'string' && typeof r[1] === 'string'
        && (r.length < 3 || typeof r[2] === 'string') && (r.length < 4 || ['ok', 'warn', 'alarm'].includes(r[3])));
    const text = JSON.stringify(d);
    if (!okShape || /NaN|undefined|Infinity|null/.test(text)) bad.push(id);
  }
  ok(bad.length === 0, `describe() well-formed for all ${ids.length} ids (bad: ${bad.slice(0, 5)})`);
  ok(sim.describe('nope') === null && sim.describe(42) === null, 'describe(unknown) → null');
  ok(sim.describe('L3-07').kind === 'zone' && sim.describe('VAV-3-07').kind === 'vav' && sim.describe('AHU-1').kind === 'ahu'
    && sim.describe('CH-2').kind === 'chiller' && sim.describe('HHW-1').kind === 'hw plant' && sim.describe('CWP-1').kind === 'pump'
    && sim.describe('HWP-2').kind === 'pump' && sim.describe('CHWP-1').kind === 'pump' && sim.describe('CT-1').kind === 'tower', 'describe kinds');
  ok(sim.describe('B-1') === null, 'B-1 is gone (describe → null)');
  const hd = sim.describe('HHW-1');
  ok(hd.title === 'HHW-1 · Heating hot water plant' && /steam to hot water/.test(hd.subtitle), `HHW-1 card title / subtitle (${hd.title} / ${hd.subtitle})`);
  const hrows = hd.rows.map((r) => r[0]);
  for (const k of ['Status', 'HW supply / SP', 'HW return', 'Steam valves 1/3 · 2/3', 'Exchangers in service', 'Pumps', 'Loop dP / SP', 'Bypass valve', 'Heat to loop', 'Steam', 'OA reset']) ok(hrows.includes(k), `HHW-1 card row ${k}`);
  ok(sim.describe('AHU-1').rows.some((r) => r[0] === 'Return / relief dampers') && sim.describe('AHU-1').rows.some((r) => r[0] === 'Filter dP (pre / final)'), 'AHU card: dampers + filter dP rows');
  ok(sim.describe('CH-1').rows.some((r) => r[0] === 'CHW pump') && sim.describe('CH-1').rows.some((r) => r[0] === 'Condenser water out'), 'chiller card: CHW pump + CW out rows');
  ok(/pump skid/.test(sim.describe('CHWP-1').subtitle) && sim.describe('HWP-1').rows.some((r) => r[0] === 'Staging'), 'pump cards: skid subtitle, HW staging row');
  console.log('  HHW-1:', JSON.stringify(hd.rows.map((r) => `${r[0]}: ${r[1]}${r[2] ? ' ' + r[2] : ''}`)));
  const stuck = sim.state.faults.length && sim.layout.zones.find((z) => sim.state.zones[z.id].stuck);
  ok(stuck && sim.describe(stuck.id).rows.some((r) => r[3] === 'alarm'), 'stuck zone card shows an alarm row');
  console.log('  sample:', JSON.stringify(sim.describe('AHU-1').rows.slice(0, 4)));
  let fb = 0;
  for (const r of sim.layout.runs) { const f = sim.flowOf(r); if (!(f >= 0 && f <= 1)) fb++; if (sim.flowOf(r.id) !== f) fb++; }
  ok(fb === 0, 'flowOf() in [0,1] for every run (object or id)');
  ok(sim.flowOf('nope') === 0, 'flowOf(unknown) → 0');
}

// =============================================================================================
section('AHU dampers, filters, fan fault; chiller condenser water out');
{
  const sim = createSim({ seed: 7, startHour: 11 });
  let bad = [];
  run(sim, 2 * 3600, {
    speed: 60, dt: 0.1,
    each: (st, i) => {
      if (i % 5) return;
      for (const [id, a] of Object.entries(st.ahus)) {
        if (a.rad !== 100 - a.oad) bad.push(`${id} rad ${a.rad} vs oad ${a.oad}`);
        if (a.oad <= 20 && a.ead !== 0) bad.push(`${id} ead ${a.ead.toFixed(2)} at oad ${a.oad.toFixed(1)}`);
        const q = a.cfm / a.cfmDesign;
        if (Math.abs(a.pfDp - 0.35 * q * q) > 1e-9 || Math.abs(a.ffDp - 0.55 * q * q) > 1e-9) bad.push(`${id} filter dP vs (cfm/design)²`);
      }
    },
  });
  ok(bad.length === 0, `return damper = 100 − OA; relief shut at minimum OA; filter dP ∝ (cfm/design)² (${bad.slice(0, 3)})`);
  // the morning economizer opens the relief dampers (OA above the 20 % minimum)
  const m = createSim({ seed: 7, startHour: 7.5 });
  const ead = Math.max(m.state.ahus['AHU-1'].ead, m.state.ahus['AHU-2'].ead);
  ok(m.state.ahus['AHU-1'].econ || m.state.ahus['AHU-2'].econ ? ead > 0 : true, `relief opens with the economizer (ead ${ead.toFixed(0)} %)`);
  const a1 = sim.state.ahus['AHU-1'];
  ok(a1.pfDp > 0.05 && a1.ffDp > a1.pfDp && a1.ffDp < 1.5, `filter dP plausible at noon (${a1.pfDp.toFixed(2)} / ${a1.ffDp.toFixed(2)} in.WC)`);
  ok(!a1.sfFault && !sim.state.ahus['AHU-2'].sfFault, 'no fan fault without the fault');
  const P = sim.state.plant;
  const run1 = Object.values(P.chillers).filter((c) => c.status === 'running');
  ok(run1.length > 0 && run1.every((c) => c.cwl > P.tower.cws + 0.4 && c.cwl < P.tower.cws + 14.5), `running chiller's CW out above tower supply (${run1.map((c) => c.cwl.toFixed(1))} vs ${P.tower.cws.toFixed(1)})`);
  sim.injectFault('fan-fail');
  ok(sim.state.ahus['AHU-2'].on === false, 'fan-fail stops AHU-2');
  run(sim, 60, { speed: 60, dt: 0.1 });
  ok(sim.state.ahus['AHU-2'].sfFault === true && sim.state.ahus['AHU-1'].sfFault === false, 'fan-fail sets AHU-2 sfFault only');
  sim.clearFaults();
  run(sim, 60, { speed: 60, dt: 0.1 });
  ok(sim.state.ahus['AHU-2'].sfFault === false, 'clearFaults clears sfFault');
  const n = createSim({ seed: 7, startHour: 2 });
  ok(Object.values(n.state.plant.chillers).every((c) => Math.abs(c.cwl - n.state.plant.tower.cws) < 0.5), 'idle chillers: CW out = tower supply');
}

// =============================================================================================
section('HHW plant sequences');
{
  const proven = (P, id) => P.pumps[id].on && P.pumps[id].speed > 5;
  // (a) the morning warm-up (Tue): the plant enables at the 06:00 occupied start
  const sim = createSim({ seed: 7, startHour: 5.2 });
  const s = sim.state, P = s.plant, H = P.hhw;
  ok(!H.enabled && !P.pumps['HWP-1'].on && !P.pumps['HWP-2'].on, 'warm-up: plant off before 06:00');
  let order = 0, cv1AtCv2 = null, tCv1 = null, tCv2 = null, tHx2 = null, tLag = null, at7 = null, maxIso = 0, bothHx = false, maxQ = 0;
  const T = (st) => st.hour;
  run(sim, (7.5 - 5.2) * 3600, {
    speed: 60, dt: 0.1,
    each: (st) => {
      if (H.cv2 > 0 && H.cv1Fb < 99) order++;
      if (tCv1 === null && H.cv1Fb >= 99) tCv1 = T(st);
      if (tCv2 === null && H.cv2Fb > 1) { tCv2 = T(st); cv1AtCv2 = H.cv1Fb; }
      if (tHx2 === null && H.hx[1].iso1 > 90 && H.hx[1].iso2) tHx2 = T(st);
      if (tLag === null && proven(P, 'HWP-1') && proven(P, 'HWP-2')) tLag = T(st);
      if (H.hx[0].iso1 > 90 && H.hx[1].iso1 > 90) bothHx = true;
      maxIso = Math.max(maxIso, H.hx[1].iso1);
      maxQ = Math.max(maxQ, H.load);
      if (at7 === null && st.hour >= 7) at7 = { hws: H.hws, sp: P.hwsSp };
    },
  });
  const hh = (h) => (h === null ? 'never' : `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`);
  ok(order === 0, `split range: the 2/3 valve never opens before the 1/3 valve is proven open (${order} steps)`);
  ok(tCv1 !== null && tCv2 !== null && tCv1 <= tCv2 && cv1AtCv2 >= 99, `1/3 valve open (${hh(tCv1)}) before the 2/3 valve moves (${hh(tCv2)}, 1/3 valve then ${cv1AtCv2 && cv1AtCv2.toFixed(1)} %)`);
  ok(tCv1 !== null && tCv1 >= 6 && tCv1 < 6.25, `warm-up starts with the occupied start (1/3 valve open ${hh(tCv1)})`);
  ok(tHx2 !== null && bothHx && maxIso > 90, `HX-2 staged in on the warm-up (${hh(tHx2)})`);
  ok(H.hx[1].iso1 < 10 && H.hx[1].iso2 === 0 && !H.lagHx, `HX-2 back out by 07:30 (iso1 ${H.hx[1].iso1.toFixed(0)})`);
  ok(H.hx[0].iso1 > 90 && H.hx[0].iso2 === 1, 'HX-1 stays in service (lead)');
  ok(tLag !== null, `lag pump proven on the warm-up (${hh(tLag)})`);
  ok(at7 && Math.abs(at7.hws - at7.sp) < 6, `HWS within 6 °F of SP by 07:00 (${at7 && at7.hws.toFixed(1)} / ${at7 && at7.sp.toFixed(1)})`);
  ok(maxQ > 1.5 * 450 && maxQ <= 900.001, `both exchangers carry the pull-up (peak ${maxQ.toFixed(0)} MBH, ≤ 2 × 450)`);
  console.log(`  warm-up: CV1 open ${hh(tCv1)}, CV2 moving ${hh(tCv2)}, HX-2 in ${hh(tHx2)}, lag pump ${hh(tLag)}, HWS at 07:00 ${at7 && at7.hws.toFixed(1)} / ${at7 && at7.sp.toFixed(0)} °F`);

  // (b) noon (Tue): one pump on loop dP, the 1/3 valve modulating, the 2/3 valve shut
  const n = createSim({ seed: 7, startHour: 12 });
  const nP = n.state.plant, nH = nP.hhw;
  const bad = { pumps: 0, cv: 0, hws: 0, dp: 0 };
  let k = 0;
  run(n, 3600, {
    speed: 60, dt: 0.1,
    each: () => {
      if (k++ % 5) return;
      if ((proven(nP, 'HWP-1') ? 1 : 0) + (proven(nP, 'HWP-2') ? 1 : 0) !== 1) bad.pumps++;
      if (!(nH.cv2 === 0 && nH.cv2Fb < 0.5 && nH.cv1 > 0 && nH.cv1 < 100)) bad.cv++;
      if (Math.abs(nH.hws - nP.hwsSp) >= 4) bad.hws++;
      if (Math.abs(nH.dp - nH.dpSp) >= 1) bad.dp++;
    },
  });
  ok(bad.pumps === 0, `noon: exactly one HW pump proven (${bad.pumps} bad samples)`);
  ok(bad.cv === 0, `noon: 2/3 valve shut, 1/3 valve between 0 and 100 % (${bad.cv} bad; cv1 ${nH.cv1.toFixed(1)} %)`);
  ok(bad.hws === 0, `noon: HWS within 4 °F of SP (${bad.hws} bad; ${nH.hws.toFixed(1)} / ${nP.hwsSp.toFixed(1)})`);
  ok(bad.dp === 0, `noon: loop dP within 1 psi of SP (${bad.dp} bad; ${nH.dp.toFixed(2)} / ${nH.dpSp})`);
  ok(nH.hx[1].iso1 < 1 && !nH.lagHx && !nH.lagPump, 'noon: HX-2 and the lag pump out');
  ok(nH.bypFb > 50, `noon: bypass open at low demand (${nH.bypFb.toFixed(0)} %)`);
  ok(nH.steam > 0 && Math.abs(nH.steam - (nH.load * 1000) / 970) < 1e-6, 'steam lb/h follows the heat to the loop');
  console.log(`  noon: ${['HWP-1', 'HWP-2'].find((id) => proven(nP, id))} at ${Math.max(nP.pumps['HWP-1'].speed, nP.pumps['HWP-2'].speed).toFixed(0)} %, CV1 ${nH.cv1.toFixed(1)} %, dP ${nH.dp.toFixed(2)} psi, HWS ${nH.hws.toFixed(1)} / ${nP.hwsSp.toFixed(1)} °F, bypass ${nH.bypFb.toFixed(0)} %`);

  // (c) 02:00 unoccupied: everything off and shut
  for (const mk of [() => createSim({ seed: 7, startHour: 2 }), () => { const x = createSim({ seed: 7, startHour: 12 }); x.setHour(2); return x; }]) {
    const u = mk(), uP = u.state.plant, uH = uP.hhw;
    ok(!uH.enabled && !uP.pumps['HWP-1'].on && !uP.pumps['HWP-2'].on && uP.pumps['HWP-1'].speed < 0.5 && uP.pumps['HWP-2'].speed < 0.5, '02:00: plant disabled, both pumps off');
    ok([uH.cv1, uH.cv1Fb, uH.cv2, uH.cv2Fb, uH.byp].every((v) => v < 0.5) && uH.hx.every((x) => x.iso2 === 0 && x.iso1 < 0.5) && uH.dp < 0.1 && uH.load === 0, `02:00: valves shut, dP ${uH.dp.toFixed(3)}`);
    ok(u.flowOf('hws-b1') === 0 && u.flowOf('hws-riser') === 0 && u.state.flows['hwr-b1'] === 0, '02:00: no HW flow');
  }

  // (d) the lead pump alternates daily
  const d = createSim({ seed: 7, startHour: 9.5 });
  const lead1 = d.state.plant.hhw.leadPump, p1 = proven(d.state.plant, lead1);
  run(d, 24 * 3600, { speed: 3600, dt: 0.5 });
  const lead2 = d.state.plant.hhw.leadPump, p2 = proven(d.state.plant, lead2);
  ok(d.state.timeLabel.startsWith('Wed 09:'), `(d) a day on (${d.state.timeLabel})`);
  ok(lead1 === 'HWP-2' && lead2 === 'HWP-1' && p1 && p2, `lead pump Tue ${lead1} → Wed ${lead2}, each proven`);

  // (e) a normal day raises no HWS-low alarm (weekday and the Saturday after a cold start)
  for (const [seed, h, hours] of [[7, 0.1, 24], [3, 0.1, 24], [7, 5.5, 72]]) {
    const e = createSim({ seed, startHour: h });
    let seen = 0, tempAl = 0;
    run(e, hours * 3600, { speed: 600, dt: 1 / 30, each: (st) => { if (st.alarms.some((a) => a.id === 'hws-low')) seen++; if (st.plant.hhw.tempAlarm) tempAl++; } });
    ok(seen === 0 && tempAl === 0, `no hws-low over ${hours} h (seed ${seed}, from ${h})`);
  }
  // the alarm path: a loop dumped 60 °F under SP mid-morning (armed, plant long running) stays
  // more than 15 °F low for over 10 min, alarms on HHW-1, and clears once HWS recovers
  const lo = createSim({ seed: 7, startHour: 10 });
  lo.state.plant.hhw.hws = lo.state.plant.hwsSp - 60;
  let raisedAt = null, k2 = 0;
  run(lo, 20 * 60, { speed: 60, dt: 0.1, each: (st) => { k2++; if (raisedAt === null && st.alarms.some((a) => a.id === 'hws-low' && a.target === 'HHW-1')) raisedAt = k2 * 6; } });
  ok(raisedAt !== null && raisedAt >= 600, `hws-low raised on HHW-1 after the 10 min debounce (${raisedAt} s)`);
  ok(raisedAt === null || /^HW supply low · \d+\.\d °F \(SP \d+\)$/.test(lo.state.alarms.find((a) => a.id === 'hws-low')?.text || 'HW supply low · 0.0 °F (SP 0)'), 'hws-low text');
  ok(lo.describe('HHW-1').status === 'alarm' || !lo.state.plant.hhw.tempAlarm, 'HHW-1 card in alarm while hws-low is up');
  run(lo, 40 * 60, { speed: 60, dt: 0.1 });
  ok(!lo.state.alarms.some((a) => a.id === 'hws-low') && !lo.state.plant.hhw.tempAlarm, `hws-low clears once HWS recovers (${lo.state.plant.hhw.hws.toFixed(1)} / ${lo.state.plant.hwsSp.toFixed(1)})`);
}

// =============================================================================================
section('ports and routes');
{
  const sim = createSim();
  const L = sim.layout;
  const eq = new Map(L.equipment.map((e) => [e.id, e]));
  // which way each port faces (design §2.3): the last leg of a run leaves the port along it
  const FACE = { sa: [-1, 0, 0], ra: [1, 0, 0] };
  const faceOf = (id, k) => {
    if (id.startsWith('AHU')) return FACE[k] || [0, 0, id === 'AHU-1' ? 1 : -1]; // coil connections face the core
    if (id === 'CWP-1') return k === 'suction' ? [-1, 0, 0] : [1, 0, 0];
    if (id === 'HHW-1') return k === 'hws' ? [0, 0, 1] : [1, 0, 0];
    return [-1, 0, 0]; // tower and chiller nozzles face west, toward the risers
  };
  ok(L.ports && typeof L.ports === 'object', 'layout.ports');
  const want = ['AHU-1', 'AHU-2', 'CT-1', 'CH-1', 'CH-2', 'CWP-1', 'HHW-1'];
  ok(want.every((id) => L.ports[id]) && Object.keys(L.ports).length === want.length, `ports for ${want.join(', ')}`);
  const used = new Map();
  let nEnds = 0;
  for (const r of L.runs) {
    ok(r.points.every((p, i) => i === 0 || [0, 1, 2].filter((a) => Math.abs(p[a] - r.points[i - 1][a]) > 1e-9).length === 1), `run ${r.id}: every segment axis-aligned, none zero-length`);
    if (!r.ends) continue;
    ok(Array.isArray(r.ends) && r.ends.length === 2 && r.ends.some(Boolean), `run ${r.id}: ends [start, end]`);
    r.ends.forEach((ref, side) => {
      if (!ref) return;
      nEnds++;
      const [id, k] = ref.split(':');
      const p = L.ports[id]?.[k];
      ok(!!p && eq.has(id), `run ${r.id}: port ${ref} exists`);
      if (!p) return;
      used.set(ref, (used.get(ref) || 0) + 1);
      const end = side === 0 ? r.points[0] : r.points[r.points.length - 1];
      const nxt = side === 0 ? r.points[1] : r.points[r.points.length - 2];
      ok(end.every((v, a) => Math.abs(v - p[a]) < 1e-6), `run ${r.id} ${side ? 'ends' : 'starts'} at ${ref}`);
      ok((side === 0 ? r.from : r.to) === id, `run ${r.id}: ${side ? 'to' : 'from'} is ${id}`);
      const f = faceOf(id, k);
      const d = [0, 1, 2].map((a) => nxt[a] - end[a]);
      const along = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
      const len = Math.hypot(...d);
      ok(along > 0.05 && Math.abs(along - len) < 1e-9, `run ${r.id}: the leg at ${ref} leaves square to the port face`);
    });
  }
  // every port is met once; CWP-1's discharge header feeds both chillers
  for (const [id, ps] of Object.entries(L.ports)) for (const k of Object.keys(ps)) ok(used.get(`${id}:${k}`) === (id === 'CWP-1' && k === 'discharge' ? 2 : 1), `port ${id}:${k} is met by ${used.get(`${id}:${k}`) || 0} run(s)`);
  // every run that serves a model's own connection meets it (no free end at a model)
  for (const id of ['hws-b1', 'hwr-b1', 'cws-riser', 'cwr-riser', 'cws-b1', 'sa-riser-AHU-1', 'ra-riser-AHU-2', 'chws-CH-1', 'cwr-CH-2', 'cws-CH-1'])
    ok(L.runs.find((r) => r.id === id)?.ends, `${id} meets its model at a port`);
  // clearance: every run touching a port against every run of another kind, as drawn by flows.js
  // (ducts are their boxes, pipes their cylinders + elbows; corner run-ons except at a port)
  const boxes = (r) => {
    const air = r.kind === 'sa' || r.kind === 'ra';
    const w = Math.max(0.28, r.size), h = Math.max(0.22, r.size * 0.62), rr = Math.max(0.065, r.size * 0.55);
    const ext = air ? w / 2 : rr * 0.2;
    const out = [];
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1], b = r.points[i];
      const ax = [0, 1, 2].find((k) => Math.abs(b[k] - a[k]) > 1e-9);
      const lo = [0, 1, 2].map((k) => Math.min(a[k], b[k])), hi = [0, 1, 2].map((k) => Math.max(a[k], b[k]));
      const eA = i === 1 && r.ends?.[0] ? 0 : ext, eB = i === r.points.length - 1 && r.ends?.[1] ? 0 : ext;
      const sgn = b[ax] > a[ax] ? 1 : -1;
      lo[ax] -= sgn > 0 ? eA : eB; hi[ax] += sgn > 0 ? eB : eA;
      let half = [0, 0, 0];
      if (air) half = ax === 1 ? [w / 2, 0, (w * 0.85) / 2] : ax === 0 ? [0, h / 2, w / 2] : [w / 2, h / 2, 0];
      out.push({ lo: lo.map((v, k) => v - half[k]), hi: hi.map((v, k) => v + half[k]), r: air ? 0 : rr * 1.08, seg: i });
    }
    return out;
  };
  const gap = (A, B) => Math.hypot(...[0, 1, 2].map((k) => Math.max(0, A.lo[k] - B.hi[k], B.lo[k] - A.hi[k]))) - A.r - B.r;
  const all = L.runs.map((r) => ({ r, b: boxes(r) }));
  const clash = [];
  let minGap = Infinity, minPair = '';
  for (const P of all.filter((x) => x.r.ends)) {
    for (const Q of all) {
      if (Q.r.kind === P.r.kind || Q.r === P.r) continue;
      for (const A of P.b) for (const B of Q.b) {
        const g = gap(A, B);
        if (g < minGap) { minGap = g; minPair = `${P.r.id}#${A.seg} / ${Q.r.id}#${B.seg}`; }
        if (g < 0.02) clash.push(`${P.r.id}#${A.seg}~${Q.r.id}#${B.seg} ${g.toFixed(3)}`);
      }
    }
  }
  ok(clash.length === 0, `port runs clear every other service by ≥ 20 mm (${clash.slice(0, 6).join(', ')})`);
  ok(nEnds === 27, `27 port ends (got ${nEnds})`);
  console.log(`  ${nEnds} port ends on ${L.runs.filter((r) => r.ends).length} runs; tightest clearance ${(minGap * 1000).toFixed(0)} mm (${minPair})`);
}

// =============================================================================================
section('determinism');
{
  const a = createSim({ seed: 5, startHour: 11 }), b = createSim({ seed: 5, startHour: 11 }), c = createSim({ seed: 6, startHour: 11 });
  for (const s of [a, b, c]) { run(s, 3600, { speed: 600, dt: 1 / 60 }); s.injectFault('chiller-trip'); run(s, 900, { speed: 60, dt: 0.1 }); }
  ok(JSON.stringify(a.state) === JSON.stringify(b.state), 'same seed → identical state');
  ok(JSON.stringify(a.layout) === JSON.stringify(b.layout), 'same seed → identical layout');
  ok(JSON.stringify(a.state.zones) !== JSON.stringify(c.state.zones), 'different seed → different building');
}

// =============================================================================================
section('performance');
{
  for (const [speed, dt] of [[60, 1 / 60], [600, 1 / 60], [3600, 1 / 60]]) {
    const sim = createSim({ seed: 7, startHour: 8 });
    sim.speed = speed;
    for (let i = 0; i < 200; i++) sim.step(dt); // warm up JIT
    const n = 3000, t0 = now();
    for (let i = 0; i < n; i++) sim.step(dt);
    const ms = (now() - t0) / n;
    ok(ms < 1, `step() < 1 ms at ${speed}× (${ms.toFixed(4)} ms)`);
    console.log(`  ${speed}×: ${ms.toFixed(4)} ms / step`);
  }
  const sim = createSim();
  let t0 = now();
  for (let h = 0; h < 24; h += 0.25) sim.setHour(h);
  const sh = (now() - t0) / 96;
  ok(sh < 5, `setHour() cheap enough to scrub (${sh.toFixed(3)} ms)`);
  t0 = now();
  for (let i = 0; i < 5; i++) createSim({ seed: i });
  const cs = (now() - t0) / 5;
  ok(cs < 100, `createSim() fast (${cs.toFixed(1)} ms)`);
  console.log(`  setHour ${sh.toFixed(3)} ms, createSim ${cs.toFixed(1)} ms`);
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log('  ✗ ' + f); process.exit(1); }
