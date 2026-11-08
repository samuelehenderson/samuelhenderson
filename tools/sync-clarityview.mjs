#!/usr/bin/env node
// Mirror ClarityView's 3D equipment models into the portfolio's Digital Twin, byte for byte.
//
//   node tools/sync-clarityview.mjs [path/to/Clarityview]   (default: $CLARITYVIEW_DIR, else ../Clarityview)
//
// The twin's air handlers, cooling tower, chillers, condenser pump, heating hot water
// plant and VAV terminals are ClarityView's own models. This copies the modules the
// twin imports (and every module they import, static or `import('./x.js')`) from
// ClarityView's web/ folder into src/clarityview/, keeping the folder layout so the
// relative imports work unchanged. Nothing in src/clarityview/ is ever edited here:
// change it in ClarityView, run this again, and commit.
//
// It also writes:
//   src/clarityview/VERSION        the ClarityView commit + both three versions
//   src/clarityview/README.md      do-not-edit notice + the file list
//   src/clarityview/MANIFEST.json  { commit, files: { "<rel path>": "<sha256>" } }
//                                  (src/twin/units/units.check.mjs fails on a hand edit)
//
// The twin's own adapter lives in src/twin/units/ (the only importer of the mirror).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CV = path.resolve(process.argv[2] || process.env.CLARITYVIEW_DIR || path.join(ROOT, '..', 'Clarityview'));
const WEB = path.join(CV, 'web');
const OUT = path.join(ROOT, 'src', 'clarityview');
// what src/twin/units imports (plus the pure modules the node check reads)
const ENTRIES = [
  'ahu/3d/equip3d.js',
  'ahu/3d/ahu3d.js',
  'ahu/3d/siemens-view.js',
  'ahu/equipment-defaults.js',
  'ahu/ahu3d-bridge.js',
  'ahu/hx/hhw.js',
  'ahu/vav/vav-config.js',
];
// the only bare imports the models may use: three and its examples
const EXTERNAL_OK = (spec) => spec === 'three' || spec.startsWith('three/examples/jsm/');

if (!fs.existsSync(path.join(WEB, ENTRIES[0]))) {
  console.error(`No ClarityView checkout at ${CV} (looked for web/${ENTRIES[0]}). Pass its path as the first argument.`);
  process.exit(1);
}

// ---- walk the import graph from the entries
const STATIC = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const DYNAMIC = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const files = new Set();
const external = new Set();
function walk(abs, from) {
  if (!abs.startsWith(WEB + path.sep)) throw new Error(`${from} imports ${path.relative(CV, abs)}, outside web/: cannot mirror it`);
  if (!fs.existsSync(abs)) throw new Error(`${from} imports ${path.relative(WEB, abs)}, which does not exist`);
  if (files.has(abs)) return;
  files.add(abs);
  if (!abs.endsWith('.js')) return;
  const src = fs.readFileSync(abs, 'utf8');
  const specs = [...src.matchAll(STATIC)].map((m) => m[1] || m[2]).concat([...src.matchAll(DYNAMIC)].map((m) => m[1]));
  for (const spec of specs) {
    if (!spec.startsWith('.')) { external.add(spec); continue; }
    walk(path.resolve(path.dirname(abs), spec), path.relative(WEB, abs));
  }
}
for (const e of ENTRIES) walk(path.join(WEB, e), '(entry)');
const bad = [...external].filter((x) => !EXTERNAL_OK(x));
if (bad.length) {
  console.error(`The 3D modules import ${bad.map((b) => `"${b}"`).join(', ')}; add it to package.json (and this tool's allow-list) first.`);
  process.exit(1);
}

// ---- three drift check: ClarityView's declared range vs the site's installed copy
const minorOf = (v) => {
  const m = String(v || '').match(/(\d+)\.(\d+)/);
  return m ? Number(m[2]) + 1000 * Number(m[1]) : NaN;
};
let cvThree = 'unknown';
let siteThree = 'unknown';
try { cvThree = JSON.parse(fs.readFileSync(path.join(CV, 'package.json'), 'utf8')).dependencies?.three || 'unknown'; } catch { /* no package.json */ }
try { siteThree = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'three', 'package.json'), 'utf8')).version || 'unknown'; } catch { /* not installed */ }
const cvMinor = minorOf(cvThree);
const siteMinor = minorOf(siteThree);
if (Number.isFinite(cvMinor) && Number.isFinite(siteMinor)) {
  if (siteMinor < cvMinor) {
    console.error(`three: ClarityView needs ${cvThree} but the site has ${siteThree}. Upgrade the site's three first.`);
    process.exit(1);
  }
  if (siteMinor - cvMinor > 2) console.warn(`three: the site (${siteThree}) is more than 2 minors ahead of ClarityView (${cvThree}); re-run the twin's visual acceptance.`);
} else console.warn(`three: could not compare versions (clarityview ${cvThree} / site ${siteThree})`);

// ---- replace the mirror wholesale so files ClarityView dropped do not linger
fs.rmSync(OUT, { recursive: true, force: true });
const rel = [...files].map((f) => path.relative(WEB, f).split(path.sep).join('/')).sort();
const hashes = {};
for (const r of rel) {
  const src = path.join(WEB, r);
  const dst = path.join(OUT, r);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  hashes[r] = crypto.createHash('sha256').update(fs.readFileSync(dst)).digest('hex');
}

let commit = 'unknown';
try { commit = execSync('git log -1 --format="%h %cs %s"', { cwd: CV, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
const threeLine = `three: clarityview ${cvThree} / site ${siteThree}`;
fs.writeFileSync(path.join(OUT, 'VERSION'), `${commit}\n${threeLine}\n`);
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), `${JSON.stringify({ commit: commit.split(' ')[0], files: hashes }, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'README.md'), `# Mirrored from ClarityView — do not edit

These files are ClarityView's 3D equipment models, copied unchanged by
\`node tools/sync-clarityview.mjs\` from ClarityView's \`web/\` folder (same
relative layout). Edit them in ClarityView and re-run the sync.
\`MANIFEST.json\` holds each file's sha256; \`src/twin/units/units.check.mjs\`
fails if any of them is edited here. The twin's adapter is \`src/twin/units/\`.
\`ahu3d.css\` is mirrored but never bundled (vite.config.js drops CSS imported
from this folder).

ClarityView commit: ${commit}
${threeLine}

${rel.map((r) => `- ${r}`).join('\n')}
`);
console.log(`Mirrored ${rel.length} files from ClarityView (${commit}) into src/clarityview/`);
console.log(threeLine);
