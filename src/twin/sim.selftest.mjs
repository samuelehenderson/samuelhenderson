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
    chk(a.ssp, 0, 3, `${id}.ssp`); chk(a.sspSp, 0.5, 2, `${id}.sspSp`); chk(a.cfm, 0, a.cfmDesign * 1.1, `${id}.cfm`);
    if (typeof a.on !== 'boolean') e.push(`${id}.on`);
  }
  const P = s.plant;
  for (const [id, c] of Object.entries(P.chillers)) { chk(c.load, 0, 100, `${id}.load`); chk(c.chws, 35, 90, `${id}.chws`); chk(c.chwr, 35, 95, `${id}.chwr`); chk(c.kw, 0, 150, `${id}.kw`); }
  chk(P.boiler.fire, 0, 100, 'boiler.fire'); chk(P.boiler.hws, 60, 200, 'boiler.hws'); chk(P.boiler.hwr, 50, 200, 'boiler.hwr');
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
  for (const id of ['AHU-1', 'AHU-2', 'CH-1', 'CH-2', 'B-1', 'CHWP-1', 'CHWP-2', 'HWP-1', 'CWP-1', 'CT-1']) ok(eq.has(id), `equipment ${id}`);
  for (const e of L.equipment) {
    ok(['ahu', 'chiller', 'boiler', 'pump', 'tower'].includes(e.kind), `kind ${e.id}`);
    ok([e.x, e.y, e.z, e.w, e.h, e.d, e.rotY].every(Number.isFinite), `finite geometry ${e.id}`);
    ok(Math.abs(e.x) + e.w / 2 <= 20.01 && Math.abs(e.z) + e.d / 2 <= 12.01, `${e.id} inside footprint`);
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
    && sim.describe('CH-2').kind === 'chiller' && sim.describe('B-1').kind === 'boiler' && sim.describe('CWP-1').kind === 'pump'
    && sim.describe('CT-1').kind === 'tower', 'describe kinds');
  const stuck = sim.state.faults.length && sim.layout.zones.find((z) => sim.state.zones[z.id].stuck);
  ok(stuck && sim.describe(stuck.id).rows.some((r) => r[3] === 'alarm'), 'stuck zone card shows an alarm row');
  console.log('  sample:', JSON.stringify(sim.describe('AHU-1').rows.slice(0, 4)));
  let fb = 0;
  for (const r of sim.layout.runs) { const f = sim.flowOf(r); if (!(f >= 0 && f <= 1)) fb++; if (sim.flowOf(r.id) !== f) fb++; }
  ok(fb === 0, 'flowOf() in [0,1] for every run (object or id)');
  ok(sim.flowOf('nope') === 0, 'flowOf(unknown) → 0');
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
