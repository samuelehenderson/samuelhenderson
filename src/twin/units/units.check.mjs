#!/usr/bin/env node
/**
 * Digital Twin units — node check (no three, no DOM, no browser).
 *
 *   node src/twin/units/units.check.mjs [path/to/Clarityview]
 *
 *   (a) every file in src/clarityview/MANIFEST.json still has its sha256 (no hand
 *       edits) and the mirror holds nothing the manifest does not list
 *   (b) every bound suffix is in the unit config's suffixMap, or is one of the
 *       documented role aliases (CH.PMP.STS / CH.PMP.SVD)
 *   (c) every configured suffix that is not bound is in the unit's documented
 *       unmapped list (it reads unbound and drives no motion)
 *   (d) every binding gives a finite number on a fresh sim at 05:30, 12:00, 02:00
 *   (e) the sim's layout has no B-1 / boiler
 *   (f) nothing outside src/twin/units/ imports the mirror
 *   (g) with a ClarityView checkout: the mirror is byte-identical to the commit
 *       in VERSION
 *
 * INTERIM (until the sim replaces the boiler with the HHW-1 plant model, which
 * is builder 2's half of this change): while sim.state.plant.hhw is absent, (d)
 * lets the plant values the boiler cannot stand in for read non-finite (they
 * read unbound on the model: no loop dP, no second pump) and (e) reports
 * instead of failing. Both turn strict by themselves once the sim has P.hhw /
 * HHW-1. Exit code 1 on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UNITS, ROLE_ALIASES, mapOf } from './catalog.js';
import { createSim } from '../sim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const MIRROR = path.join(ROOT, 'src', 'clarityview');
let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${msg}`);
  }
};
const note = (msg) => console.log(`  NOTE ${msg}`);

/* (a) manifest */
console.log('(a) mirror manifest');
const manifest = JSON.parse(fs.readFileSync(path.join(MIRROR, 'MANIFEST.json'), 'utf8'));
const listed = Object.keys(manifest.files);
ok(listed.length > 0, 'MANIFEST lists files');
for (const rel of listed) {
  const f = path.join(MIRROR, rel);
  if (!fs.existsSync(f)) {
    ok(false, `${rel} is missing`);
    continue;
  }
  const h = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  ok(h === manifest.files[rel], `${rel} was edited (sha256 differs from MANIFEST); re-run tools/sync-clarityview.mjs instead`);
}
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const extra = walk(MIRROR)
  .map((f) => path.relative(MIRROR, f).split(path.sep).join('/'))
  .filter((r) => !['VERSION', 'README.md', 'MANIFEST.json'].includes(r) && !manifest.files[r]);
ok(extra.length === 0, `files in the mirror the manifest does not list: ${extra.join(', ')}`);

/* (b) (c) bindings against each config's suffix map */
console.log('(b, c) bindings vs suffixMap');
for (const u of UNITS) {
  const map = mapOf(u);
  for (const s of Object.keys(u.bindings)) ok(map.has(s) || ROLE_ALIASES.has(s), `${u.id}: bound suffix ${s} is not in the config's suffix map`);
  for (const s of map.keys()) if (!(s in u.bindings)) ok(u.unmapped.includes(s), `${u.id}: configured suffix ${s} is neither bound nor documented as unmapped`);
  for (const s of u.unmapped) ok(map.has(s) && !(s in u.bindings), `${u.id}: documented unmapped ${s} is not a configured, unbound suffix`);
}

/* (d) finite values on a fresh sim */
console.log('(d) bindings finite on a fresh sim');
const INTERIM_NONFINITE = new Set(['HHW-1:HHW.DP', 'HHW-1:HHW.DP_SP', 'HHW-1:HHW.P2_SS', 'HHW-1:HHW.P2_STS', 'HHW-1:HHW.P2_SVD']);
let hasHhw = false;
for (const hour of [5.5, 12, 2]) {
  const sim = createSim({ seed: 7, startHour: hour });
  hasHhw = !!sim.state.plant.hhw;
  const pending = [];
  for (const u of UNITS) {
    for (const [s, fn] of Object.entries(u.bindings)) {
      let v = NaN;
      try {
        v = Number(fn(sim.state));
      } catch {
        v = NaN;
      }
      if (Number.isFinite(v)) {
        pass++;
        continue;
      }
      if (!hasHhw && INTERIM_NONFINITE.has(`${u.id}:${s}`)) pending.push(s);
      else ok(false, `${u.id}: ${s} is not finite at ${hour}:00 (${v})`);
    }
  }
  if (pending.length) note(`${hour}h: ${pending.join(', ')} read unbound until the sim has the HHW-1 plant model (P.hhw)`);
}

/* (e) layout */
console.log('(e) layout has no B-1 / boiler');
const layout = createSim({ seed: 7, startHour: 9.5 }).layout;
const json = JSON.stringify(layout);
const clean = !json.includes('"B-1"') && !/boiler/i.test(json);
if (clean || hasHhw) ok(clean, 'the sim layout still mentions B-1 / boiler');
else note('the sim layout still has B-1 (the boiler): pending the HHW-1 plant model in sim.js');

/* (f) only src/twin/units imports the mirror */
console.log('(f) the mirror is imported only by src/twin/units/');
const SRC = path.join(ROOT, 'src');
for (const f of walk(SRC)) {
  if (!/\.(m?js)$/.test(f) || f.startsWith(MIRROR + path.sep) || f.startsWith(HERE + path.sep)) continue;
  const src = fs.readFileSync(f, 'utf8');
  ok(!/from\s+['"][^'"]*clarityview\/|import\(\s*['"][^'"]*clarityview\//.test(src), `${path.relative(ROOT, f)} imports the ClarityView mirror (only src/twin/units/ may)`);
}

/* (g) byte-identical to the ClarityView commit (needs a checkout) */
const CV = process.argv[2] || process.env.CLARITYVIEW_DIR || path.join(ROOT, '..', 'Clarityview');
if (fs.existsSync(path.join(CV, 'web'))) {
  console.log(`(g) mirror vs ClarityView ${manifest.commit} (${CV})`);
  for (const rel of listed) {
    let src = null;
    try {
      src = execSync(`git show ${manifest.commit}:web/${rel}`, { cwd: CV, maxBuffer: 64 << 20 });
    } catch {
      src = null;
    }
    ok(src && Buffer.compare(src, fs.readFileSync(path.join(MIRROR, rel))) === 0, `${rel} differs from ClarityView ${manifest.commit}`);
  }
} else note(`(g) skipped: no ClarityView checkout at ${CV}`);

console.log(`\nunits.check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
