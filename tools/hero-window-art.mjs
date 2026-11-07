// Generates the hero's room, window and snowy mountain view as inline SVG and
// writes it into index.html (the .layer--sky, .layer--room and .layer--shelves
// blocks, from the "THE VIEW" comment up to the desk layer). Dev-only; not part
// of the build. Run from the repo root:  node tools/hero-window-art.mjs
//
// Shared frame: viewBox 1600x1000, xMidYMid slice (same as every hero layer).
// One-point perspective: eye / vanishing point VP = (800, 420), f = 750 units per metre at 1 m.
// Room: back wall at Z = 3.0 m, side walls at X = ±1.6 m, ceiling 1.08 m above the eye.
//   back wall x 400..1200, y 150..720. Window opening on it: head y 238, sill y 448.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const VP = { x: 800, y: 420 };
const F = 750;
const r1 = (v) => Math.round(v * 10) / 10;
const pathOf = (a, close = true) => 'M' + a.map(([x, y]) => `${r1(x)} ${r1(y)}`).join('L') + (close ? 'Z' : '');
// the far view is noisy terrain: whole units are plenty (1 unit ≈ 1.4–1.7 css px)
const pathI = (a, close = true) => 'M' + a.map(([x, y]) => `${Math.round(x)} ${Math.round(y)}`).join('L') + (close ? 'Z' : '');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Midpoint displacement between control points.
function ridge(ctrl, { step = 6, rough = 0.22, seed = 1 } = {}) {
  const R = rng(seed);
  const outPts = [ctrl[0]];
  const sub = (a, b) => {
    const dx = b[0] - a[0];
    if (dx <= step) { outPts.push(b); return; }
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + (R() - 0.5) * rough * dx];
    sub(a, m); sub(m, b);
  };
  for (let i = 1; i < ctrl.length; i++) sub(ctrl[i - 1], ctrl[i]);
  return outPts;
}
const yAt = (line, x) => {
  for (let i = 1; i < line.length; i++) {
    if (line[i][0] >= x) {
      const [x0, y0] = line[i - 1], [x1, y1] = line[i];
      return y0 + (y1 - y0) * ((x - x0) / (x1 - x0 || 1));
    }
  }
  return line[line.length - 1][1];
};

// ───────────────────────── VIEW (sky layer) ─────────────────────────
function view() {
  const R = rng(7);
  const s = [];
  s.push(`<defs>
<linearGradient id="vSky" x1="0" x2="0" y1="0" y2="1000" gradientUnits="userSpaceOnUse"><stop offset="0.12" stop-color="#03060d"/><stop offset="0.25" stop-color="#060e21"/><stop offset="0.33" stop-color="#0b1732"/><stop offset="0.405" stop-color="#16274a"/><stop offset="0.46" stop-color="#0d1830"/><stop offset="0.6" stop-color="#070d1a"/></linearGradient>
<radialGradient id="vMoonGlow" cx="856" cy="279" r="190" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#cfdcff" stop-opacity="0.34"/><stop offset="0.1" stop-color="#9fb6ec" stop-opacity="0.2"/><stop offset="0.38" stop-color="#5f7cc0" stop-opacity="0.08"/><stop offset="1" stop-color="#3a5590" stop-opacity="0"/></radialGradient>
<linearGradient id="vFarHaze" x1="0" x2="0" y1="318" y2="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2b4170" stop-opacity="0"/><stop offset="0.55" stop-color="#2b4170" stop-opacity="0.45"/><stop offset="1" stop-color="#22355c" stop-opacity="0.9"/></linearGradient>
<linearGradient id="vMist1" x1="0" x2="0" y1="336" y2="396" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6d86b8" stop-opacity="0"/><stop offset="0.55" stop-color="#6d86b8" stop-opacity="0.17"/><stop offset="1" stop-color="#4a6396" stop-opacity="0.05"/></linearGradient>
<linearGradient id="vMist2" x1="0" x2="0" y1="372" y2="414" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#5c76a8" stop-opacity="0"/><stop offset="0.6" stop-color="#5c76a8" stop-opacity="0.16"/><stop offset="1" stop-color="#3b5182" stop-opacity="0"/></linearGradient>
<linearGradient id="vSnowLit" x1="0" x2="0" y1="284" y2="356" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#d4e0f4"/><stop offset="0.5" stop-color="#a9bcdd"/><stop offset="1" stop-color="#7488b2"/></linearGradient>
<linearGradient id="vShade" x1="0" x2="0" y1="284" y2="404" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0a1636" stop-opacity="0.66"/><stop offset="0.45" stop-color="#0a1636" stop-opacity="0.46"/><stop offset="1" stop-color="#0a1636" stop-opacity="0.1"/></linearGradient>
<linearGradient id="vDawn" x1="0" x2="0" y1="250" y2="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#e88aa0" stop-opacity="0"/><stop offset="0.7" stop-color="#e88aa0" stop-opacity="0.16"/><stop offset="1" stop-color="#f2a98a" stop-opacity="0.3"/></linearGradient>
<linearGradient id="vDusk" x1="0" x2="0" y1="250" y2="420" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6a4fb0" stop-opacity="0"/><stop offset="0.7" stop-color="#7a58b8" stop-opacity="0.18"/><stop offset="1" stop-color="#c0709a" stop-opacity="0.26"/></linearGradient>
</defs>`);
  s.push(`<rect width="1600" height="1000" fill="url(#vSky)"/>`);
  // dawn / dusk sky band (shown by [data-sky] on #hero)
  s.push(`<rect class="view-tint view-tint--dawn" x="0" y="240" width="1600" height="200" fill="url(#vDawn)"/>`);
  s.push(`<rect class="view-tint view-tint--dusk" x="0" y="240" width="1600" height="200" fill="url(#vDusk)"/>`);

  // stars: static field, a few brighter ones (the canvas twinkles some of them)
  const stars = [[], [], []];
  for (let i = 0; i < 80; i++) {
    const x = Math.round(430 + R() * 740), y = Math.round(196 + Math.pow(R(), 1.25) * 140);
    if (Math.hypot(x - 856, y - 279) < 46) continue;
    const r = (0.4 + Math.pow(R(), 3) * 0.9).toFixed(1);
    stars[Math.floor(R() * 3)].push(`<circle cx="${x}" cy="${y}" r="${r}"/>`);
  }
  s.push(`<g fill="#dfe8ff">` + stars.map((g, i) => `<g opacity="${[0.4, 0.6, 0.85][i]}">${g.join('')}</g>`).join('') + `</g>`);
  // bright twinkle candidates: in the sky band of every window variant (x 716..884 is the phone window)
  const tw = [[734, 262], [781, 271], [829, 258], [878, 307], [700, 289], [622, 266], [956, 263], [1068, 286], [534, 283], [1101, 258], [489, 262], [668, 276]];
  s.push(`<g fill="#eef3ff">` + tw.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.95"/>`).join('') + `</g>`);

  // moon with a faint 22° ice halo
  s.push(`<circle cx="856" cy="279" r="190" fill="url(#vMoonGlow)"/>`);
  s.push(`<circle cx="856" cy="279" r="52" fill="none" stroke="#b9cbf4" stroke-opacity="0.09" stroke-width="5"/>`);
  s.push(`<circle cx="856" cy="279" r="52" fill="none" stroke="#dbe5ff" stroke-opacity="0.07" stroke-width="1.2"/>`);
  s.push(`<circle cx="856" cy="279" r="9.6" fill="#f4f7ff"/><circle cx="853.6" cy="277.4" r="2.2" fill="#cdd7ee" opacity="0.32"/><circle cx="859" cy="281.6" r="1.5" fill="#cdd7ee" opacity="0.28"/><circle cx="857.6" cy="275.4" r="0.9" fill="#cdd7ee" opacity="0.25"/>`);

  // ── far range: palest, bluest
  const farCtrl = [[420, 338], [468, 346], [522, 326], [580, 340], [640, 322], [700, 336], [748, 326], [802, 334], [846, 318], [900, 328], [952, 320], [1010, 336], [1066, 322], [1124, 340], [1186, 328], [1250, 348], [1190, 336]];
  const far = ridge(farCtrl, { step: 5, rough: 0.2, seed: 11 });
  const farPoly = [...far, [1190, 440], [420, 440]];
  s.push(`<path id="vFar" d="${pathI(farPoly)}" fill="#22355c"/>`);
  // far snow caps (above a wavy snowline) — clipped to the ridge
  s.push(`<clipPath id="vFarClip"><use href="#vFar"/></clipPath>`);
  const farSnowline = ridge([[420, 342], [560, 346], [720, 338], [880, 344], [1040, 338], [1190, 345]], { step: 10, rough: 0.5, seed: 12 });
  s.push(`<path clip-path="url(#vFarClip)" d="${pathI([[420, 300], [1190, 300], ...farSnowline.slice().reverse()])}" fill="#687ea9" opacity="0.5"/>`);
  s.push(`<use href="#vFar" fill="url(#vFarHaze)"/>`);

  // ── main range: hand-placed peaks. The moon is up-right, so right faces are lit
  // and every face left of an arête is in shadow.
  const P = [ // summit x, y, snow depth, arête lean
    [486, 330, 20, 0.16], [560, 312, 26, 0.1], [640, 302, 30, 0.14], [762, 284, 46, 0.1],
    [948, 300, 34, 0.12], [1040, 314, 26, 0.12], [1112, 326, 20, 0.16]];
  const mainCtrl = [[420, 352], [452, 346], [486, 330], [522, 342], [560, 312], [600, 334], [640, 302], [676, 324], [700, 330], [728, 314], [748, 300], [762, 284], [782, 302], [806, 318], [848, 346], [896, 332], [948, 300], [990, 330], [1040, 314], [1076, 334], [1112, 326], [1160, 346], [1196, 342]];
  const main = ridge(mainCtrl, { step: 4, rough: 0.2, seed: 23 });
  const mainPoly = [...main, [1196, 460], [420, 460]];
  s.push(`<path id="vMain" d="${pathI(mainPoly)}" fill="#121e38"/>`);
  s.push(`<clipPath id="vMainClip"><use href="#vMain"/></clipPath>`);
  // snowline: deepest under each summit, rising toward the saddles, with tongues down the gullies
  const RS = rng(31);
  const snowline = [];
  for (let x = 420; x <= 1196; x += 4) {
    let y = Math.min(...P.map(([px, py, d]) => py + d + 0.32 * Math.abs(x - px)));
    y += Math.sin(x / 11.3) * 2 + Math.sin(x / 4.7) * 1.2;
    if (RS() < 0.09) y += 4 + RS() * 7;
    snowline.push([x, y]);
  }
  const snowPoly = [[420, 270], [1196, 270], ...snowline.slice().reverse()];
  s.push(`<path id="vSnow" clip-path="url(#vMainClip)" d="${pathI(snowPoly)}" fill="url(#vSnowLit)"/>`);
  // alpenglow on the snow (dawn / dusk only)
  s.push(`<g class="view-tint view-tint--dawn" clip-path="url(#vMainClip)" opacity="0.24"><path d="${pathI(snowPoly)}" fill="#ff9fae"/></g>`);
  s.push(`<g class="view-tint view-tint--dusk" clip-path="url(#vMainClip)" opacity="0.16"><path d="${pathI(snowPoly)}" fill="#c79bff"/></g>`);

  const RA = rng(41);
  const shade = [];
  const rims = [];
  const aretes = [];
  const strokesDark = [];
  const strokesLight = [];
  const lowest = (x0, x1) => main.filter(([x]) => x >= x0 && x <= x1).reduce((m, p) => (p[1] > m[1] ? p : m), [x0, 0]);
  P.forEach(([px, py, d, lean], i) => {
    const saddleL = i === 0 ? [420, 352] : lowest(P[i - 1][0], px);
    const saddleR = i === P.length - 1 ? [1196, 342] : lowest(px, P[i + 1][0]);
    const ar = [[px, py]];
    for (let y = py + 7; y < py + 130; y += 7) ar.push([px + lean * (y - py) + 0.006 * (y - py) ** 2 + (RA() - 0.5) * 2.4, y]);
    aretes.push(ar.filter(([, y]) => y < py + d * 0.75));
    const end = ar[ar.length - 1];
    // valley line from the saddle: wanders down and widens the shadow toward the valley floor
    const valley = [];
    for (let y = saddleL[1] + 4; y < 470; y += 6) valley.push([saddleL[0] - 0.5 * (y - saddleL[1]) + (RA() - 0.5) * 3, y]);
    shade.push(pathI([[saddleL[0] - 2, 262], [px, 262], ...ar, [end[0], 470], ...valley.reverse(), [saddleL[0] - 2, saddleL[1]]]));
    rims.push(main.filter(([x]) => x >= px && x <= saddleR[0]));
    // texture: dark gullies down the lit face, faint snow streaks across the shaded one
    const nLit = Math.max(2, Math.round((saddleR[0] - px) / 14));
    for (let k = 0; k < nLit; k++) {
      const x0 = px + (saddleR[0] - px) * (0.12 + 0.8 * (k + RA() * 0.6) / nLit);
      const y0 = yAt(main, x0) + 2 + RA() * 3;
      const len = 7 + RA() * 18;
      const ang = 0.25 + RA() * 0.35;
      strokesDark.push([[x0, y0], [x0 + ang * len * 0.5 + (RA() - 0.5) * 2, y0 + len * 0.5], [x0 + ang * len, y0 + len]]);
    }
    const nSh = Math.max(1, Math.round((px - saddleL[0]) / 18));
    for (let k = 0; k < nSh; k++) {
      const x0 = saddleL[0] + (px - saddleL[0]) * (0.25 + 0.7 * (k + RA() * 0.6) / nSh);
      const y0 = yAt(main, x0) + 3;
      const len = 8 + RA() * 14;
      strokesLight.push([[x0, y0], [x0 - 0.3 * len, y0 + len]]);
    }
  });
  s.push(`<g clip-path="url(#vMainClip)"><path d="${shade.join('')}" fill="url(#vShade)"/></g>`);
  s.push(`<g clip-path="url(#vMainClip)" fill="none" stroke-linecap="round"><path d="${strokesDark.map((l) => pathI(l, false)).join('')}" stroke="#4d6290" stroke-width="0.9" stroke-opacity="0.4"/><path d="${strokesLight.map((l) => pathI(l, false)).join('')}" stroke="#8ea2c9" stroke-width="0.7" stroke-opacity="0.22"/></g>`);
  s.push(`<g fill="none" stroke="#e9f0ff" stroke-linejoin="round" stroke-linecap="round"><path d="${rims.map((r) => pathI(r, false)).join('')}" stroke-width="0.9" stroke-opacity="0.55"/><path d="${aretes.map((r) => pathI(r, false)).join('')}" stroke-width="0.7" stroke-opacity="0.2"/></g>`);

  // mist pooled under the main range
  s.push(`<rect x="420" y="336" width="780" height="60" fill="url(#vMist1)"/>`);

  // ── foothills: dark, a little snow on the tops
  const hillsCtrl = [[420, 376], [430, 372], [500, 384], [566, 370], [640, 381], [712, 368], [790, 380], [862, 372], [934, 384], [1004, 370], [1080, 382], [1150, 368], [1196, 378]];
  const hills = ridge(hillsCtrl, { step: 7, rough: 0.16, seed: 61 });
  const hillsPoly = [...hills, [1196, 470], [420, 470]];
  s.push(`<path id="vHills" d="${pathI(hillsPoly)}" fill="#0b1427"/>`);
  s.push(`<clipPath id="vHillsClip"><use href="#vHills"/></clipPath>`);
  s.push(`<g clip-path="url(#vHillsClip)"><path d="${pathI([...hills.map(([x, y]) => [x, y - 1]), ...hills.slice().reverse().map(([x, y]) => [x, y + 2.2 + Math.abs(Math.sin(x / 9)) * 2.4])])}" fill="#3d5079" opacity="0.4"/></g>`);
  s.push(`<rect x="420" y="372" width="780" height="42" fill="url(#vMist2)"/>`);

  // ── treeline: conifers, moonlit on their right edges
  const RT = rng(71);
  let trees = '', lit = '';
  const q = (v) => Math.round(v * 2) / 2;
  for (let x = 430; x < 1192;) {
    const h = 12 + RT() * 26 + (RT() < 0.1 ? 10 : 0);
    const w = h * (0.34 + RT() * 0.08);
    const base = 432 + RT() * 10;
    // tip, right tier notch, right base, trunk, left base, left tier notch
    trees += `M${q(x)} ${q(base - h)}l${q(w * 0.3)} ${q(h * 0.45)}l${q(-w * 0.12)} 0l${q(w * 0.32)} ${q(h * 0.55)}l${q(-w * 0.42)} 3l${q(-w * 0.16)} 0l${q(-w * 0.42)} -3l${q(w * 0.32)} ${q(-h * 0.55)}l${q(-w * 0.12)} 0z`;
    if (RT() < 0.55) lit += `M${q(x)} ${q(base - h)}l${q(w * 0.24)} ${q(h * 0.36)}`;
    x += w * (0.45 + RT() * 0.5);
  }
  s.push(`<path d="M420 470V438H1200V470Z" fill="#050913"/>`);
  s.push(`<path d="${trees}" fill="#050a14"/>`);
  s.push(`<path d="${lit}" fill="none" stroke="#5a6f99" stroke-width="0.9" stroke-opacity="0.6" stroke-linecap="round"/>`);
  s.push(`<rect x="0" y="470" width="1600" height="530" fill="#050913"/>`);

  return { svg: s.join('\n'), twinkle: tw };
}

// ───────────────────────── ROOM (back wall, window) ─────────────────────────
const scaleToVP = (x, y, k) => [VP.x + (x - VP.x) * k, VP.y + (y - VP.y) * k];

function windowParts(name, O, mullionXs) {
  // O: opening on the wall face {x0,y0,x1,y1}. Glass sits 4.5% deeper (k = 0.955 toward VP).
  const k = 0.955;
  const [fx0, fy0] = scaleToVP(O.x0, O.y0, k);
  const [fx1, fy1] = scaleToVP(O.x1, O.y1, k);
  const fr = 6.5; // frame
  const G = { x0: fx0 + fr, y0: fy0 + fr, x1: fx1 - fr, y1: fy1 - 6.5 };
  const trim = 12;
  const s = [];
  const id = (n) => `${name}${n}`;
  // wall with the opening cut out (evenodd), its slat texture, glow, and the monitor's shadow
  const wallD = `M400 150H1200V720H400Z M${r1(O.x0 - trim)} ${r1(O.y0 - trim)}V${r1(O.y1)}H${r1(O.x1 + trim)}V${r1(O.y0 - trim)}Z`;
  s.push(`<clipPath id="${id('Wall')}"><path clip-rule="evenodd" d="${wallD}"/></clipPath>`);
  s.push(`<g clip-path="url(#${id('Wall')})"><rect x="400" y="150" width="800" height="570" fill="url(#rSlats)"/><rect x="400" y="150" width="800" height="570" fill="url(#rWallGlow)"/><rect x="${r1(601)}" y="${r1(402)}" width="450" height="290" rx="16" fill="#02040a" opacity="0.5" filter="url(#rSoft)"/><rect x="400" y="150" width="800" height="570" fill="url(#rWallFall)"/></g>`);
  // glass: outside snow on the sill, then reflections + frost on the inner face
  const panes = [];
  const edges = [G.x0, ...mullionXs.flatMap((m) => [m - 4, m + 4]), G.x1];
  for (let i = 0; i < edges.length; i += 2) panes.push([edges[i], edges[i + 1]]);
  const RS = rng(name.length * 97 + 5);
  let sill = '';
  for (const [a, b] of panes) {
    const top = [];
    for (let x = a; x <= b + 0.01; x += Math.min(9, (b - a) / 3)) top.push([Math.min(x, b), G.y1 - 5.2 - RS() * 3.6]);
    sill += pathOf([[a, G.y1 + 1], [a, G.y1 - 2.5], ...top, [b, G.y1 - 2.5], [b, G.y1 + 1]]);
  }
  s.push(`<path d="${sill}" fill="url(#rSillSnow)"/>`);
  s.push(`<clipPath id="${id('Glass')}"><path d="${panes.map(([a, b]) => `M${r1(a)} ${r1(G.y0)}H${r1(b)}V${r1(G.y1)}H${r1(a)}Z`).join('')}"/></clipPath>`);
  const frost = [];
  const corners = [[G.x0, G.y0, 44], [G.x1, G.y0, 40], [G.x0, G.y1, 52], [G.x1, G.y1, 52]];
  for (const m of mullionXs) corners.push([m - 4, G.y0, 18], [m + 4, G.y0, 18], [m - 4, G.y1, 22], [m + 4, G.y1, 22]);
  corners.forEach(([cx, cy, r], i) => {
    const sx = cx < (G.x0 + G.x1) / 2 ? 1 : -1;
    const sy = cy < (G.y0 + G.y1) / 2 ? 1 : -1;
    // mullion corners: the tuft grows away from the mullion
    const fx = mullionXs.some((m) => Math.abs(cx - m) < 6) ? (mullionXs.some((m) => Math.abs(cx - (m + 4)) < 0.1) ? 1 : -1) : sx;
    const k = r1(r / 40 * 100) / 100;
    frost.push(`<use href="#rFrost${i % 2 ? 'B' : 'A'}" transform="translate(${r1(cx)} ${r1(cy)}) scale(${r1(fx * k * 100) / 100} ${r1(sy * k * 100) / 100})"/>`);
  });
  s.push(`<g clip-path="url(#${id('Glass')})"><rect x="${r1(G.x0)}" y="${r1(G.y0)}" width="${r1(G.x1 - G.x0)}" height="${r1(G.y1 - G.y0)}" fill="url(#rGlassGlow)"/><rect x="${r1(G.x0)}" y="${r1(G.y0)}" width="${r1(G.x1 - G.x0)}" height="${r1(G.y1 - G.y0)}" fill="url(#rSheen)"/><rect x="${r1(G.x0)}" y="${r1(G.y0)}" width="${r1(G.x1 - G.x0)}" height="${r1(G.y1 - G.y0)}" fill="url(#rGlassLow)"/>${frost.join('')}</g>`);
  // frame + mullions
  let frame = `M${r1(fx0)} ${r1(fy0)}H${r1(fx1)}V${r1(fy1)}H${r1(fx0)}Z` + panes.map(([a, b]) => `M${r1(a)} ${r1(G.y0)}V${r1(G.y1)}H${r1(b)}V${r1(G.y0)}Z`).join('');
  s.push(`<path fill-rule="evenodd" d="${frame}" fill="#0b111d"/>`);
  s.push(`<path d="${panes.map(([a, b]) => `M${r1(a)} ${r1(G.y1)}V${r1(G.y0)}H${r1(b)}`).join('')}" fill="none" stroke="#1d2b45" stroke-width="1"/>`);
  for (const m of mullionXs) s.push(`<rect x="${r1(m - 1)}" y="${r1(G.y0)}" width="1.1" height="${r1(G.y1 - G.y0)}" fill="#22324f" opacity="0.8"/>`);
  // reveals: jambs catch the monitor's glow, the head is in shadow
  s.push(`<path d="${pathOf([[O.x0, O.y0], [fx0, fy0], [fx0, fy1], [O.x0, O.y1]])}" fill="#0f182a"/>`);
  s.push(`<path d="${pathOf([[O.x1, O.y0], [fx1, fy0], [fx1, fy1], [O.x1, O.y1]])}" fill="#0e1727"/>`);
  s.push(`<path d="${pathOf([[O.x0, O.y0], [O.x1, O.y0], [fx1, fy0], [fx0, fy0]])}" fill="#060a12"/>`);
  // casing trim (head + jambs), stool and apron
  s.push(`<path fill-rule="evenodd" d="M${r1(O.x0 - trim)} ${r1(O.y0 - trim)}H${r1(O.x1 + trim)}V${r1(O.y1)}H${r1(O.x0 - trim)}Z M${r1(O.x0)} ${r1(O.y0)}H${r1(O.x1)}V${r1(O.y1)}H${r1(O.x0)}Z" fill="#0d1423"/>`);
  s.push(`<path d="M${r1(O.x0 - 0.5)} ${r1(O.y1)}V${r1(O.y0 - 0.5)}H${r1(O.x1 + 0.5)}V${r1(O.y1)}" fill="none" stroke="#1a2741" stroke-width="1.2"/>`);
  s.push(`<path d="M${r1(O.x0 - trim)} ${r1(O.y1)}V${r1(O.y0 - trim)}H${r1(O.x1 + trim)}V${r1(O.y1)}" fill="none" stroke="#04070d" stroke-width="1.6"/>`);
  const sx0 = O.x0 - trim - 4, sx1 = O.x1 + trim + 4;
  const [fsx0, fsy] = scaleToVP(sx0, O.y1, 1 / 0.965);
  const [fsx1] = scaleToVP(sx1, O.y1, 1 / 0.965);
  s.push(`<path d="${pathOf([[sx0, O.y1], [sx1, O.y1], [fsx1, fsy], [fsx0, fsy]])}" fill="#16223a"/>`);
  s.push(`<rect x="${r1(fsx0)}" y="${r1(fsy)}" width="${r1(fsx1 - fsx0)}" height="6.5" fill="#0c1321"/>`);
  s.push(`<rect x="${r1(O.x0 - trim)}" y="${r1(fsy + 6.5)}" width="${r1(O.x1 - O.x0 + 2 * trim)}" height="9" fill="#0a101c"/>`);
  return { svg: s.join('\n'), glass: [G.x0, G.y0, G.x1, G.y1].map(r1) };
}

function frostTuft(id, seed) {
  // haze + crystal ferns growing in from a corner at (0,0); nominal radius 40
  const RF = rng(seed);
  let d = '';
  for (let j = 0; j < 17; j++) {
    const sx0 = RF() < 0.5 ? RF() * 20 : RF() * 6;
    const sy0 = RF() < 0.5 ? RF() * 6 : RF() * 20;
    const ang = Math.atan2(0.3 + RF(), 0.3 + RF());
    const len = 40 * (0.12 + RF() * 0.3);
    const x2 = sx0 + Math.cos(ang) * len, y2 = sy0 + Math.sin(ang) * len;
    const mx = (sx0 + x2) / 2, my = (sy0 + y2) / 2, b = len * 0.28;
    d += `M${r1(sx0)} ${r1(sy0)}L${r1(x2)} ${r1(y2)}M${r1(mx)} ${r1(my)}l${r1(Math.cos(ang + 0.7) * b)} ${r1(Math.sin(ang + 0.7) * b)}M${r1(mx)} ${r1(my)}l${r1(Math.cos(ang - 0.7) * b)} ${r1(Math.sin(ang - 0.7) * b)}`;
  }
  return `<g id="${id}"><circle r="40" fill="url(#rFrost)"/><path d="${d}" fill="none" stroke="#e3edff" stroke-width="0.4" stroke-opacity="0.16" stroke-linecap="round"/></g>`;
}

function room() {
  const s = [];
  s.push(`<defs>
<pattern id="rSlats" width="15" height="40" patternUnits="userSpaceOnUse"><rect width="15" height="40" fill="#0a1019"/><rect x="11" width="4" height="40" fill="#060a11"/><rect width="1" height="40" fill="#101827"/></pattern>
<radialGradient id="rWallGlow" cx="800" cy="545" r="470" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4ea8ff" stop-opacity="0.3"/><stop offset="0.32" stop-color="#3f8fe0" stop-opacity="0.15"/><stop offset="0.62" stop-color="#2f6cb0" stop-opacity="0.05"/><stop offset="1" stop-color="#2f6cb0" stop-opacity="0"/></radialGradient>
<linearGradient id="rWallFall" x1="0" x2="0" y1="150" y2="720" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#03050a" stop-opacity="0.55"/><stop offset="0.3" stop-color="#03050a" stop-opacity="0"/></linearGradient>
<linearGradient id="rSideL" x1="0" x2="400" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#04070c"/><stop offset="0.6" stop-color="#070b13"/><stop offset="1" stop-color="#0c1422"/></linearGradient>
<linearGradient id="rSideR" x1="1600" x2="1200" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#04070c"/><stop offset="0.6" stop-color="#070b13"/><stop offset="1" stop-color="#0c1422"/></linearGradient>
<linearGradient id="rCeil" x1="0" x2="0" y1="-120" y2="150" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#03050a"/><stop offset="1" stop-color="#080c15"/></linearGradient>
<radialGradient id="rFrost" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#dfeaff" stop-opacity="0.34"/><stop offset="0.4" stop-color="#c7d8f6" stop-opacity="0.13"/><stop offset="1" stop-color="#c7d8f6" stop-opacity="0"/></radialGradient>
<radialGradient id="rGlassGlow" cx="800" cy="470" r="300" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4ea8ff" stop-opacity="0.1"/><stop offset="0.6" stop-color="#4ea8ff" stop-opacity="0.03"/><stop offset="1" stop-color="#4ea8ff" stop-opacity="0"/></radialGradient>
<linearGradient id="rSheen" x1="0" x2="1" y1="0" y2="0.55"><stop offset="0.18" stop-color="#cfe0ff" stop-opacity="0"/><stop offset="0.3" stop-color="#cfe0ff" stop-opacity="0.045"/><stop offset="0.36" stop-color="#cfe0ff" stop-opacity="0"/><stop offset="0.62" stop-color="#cfe0ff" stop-opacity="0"/><stop offset="0.7" stop-color="#cfe0ff" stop-opacity="0.03"/><stop offset="0.74" stop-color="#cfe0ff" stop-opacity="0"/></linearGradient>
<linearGradient id="rSillSnow" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8fa2c6"/><stop offset="1" stop-color="#3f5177"/></linearGradient>
<linearGradient id="rGlassLow" x1="0" x2="0" y1="0" y2="1"><stop offset="0.55" stop-color="#03060c" stop-opacity="0"/><stop offset="1" stop-color="#03060c" stop-opacity="0.38"/></linearGradient>
${frostTuft('rFrostA', 5)}
${frostTuft('rFrostB', 9)}
<filter id="rSoft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
</defs>`);
  // ceiling, side walls, floor — all converge on the vanishing point
  s.push(`<path d="M0 -120H1600L1200 150H400Z" fill="url(#rCeil)"/>`);
  s.push(`<path d="M0 -120L400 150V720L0 1020Z" fill="url(#rSideL)"/>`);
  s.push(`<path d="M1600 -120L1200 150V720L1600 1020Z" fill="url(#rSideR)"/>`);
  s.push(`<path d="M400 720H1200L1600 1020H0Z" fill="#04060b"/>`);
  // side-wall perspective lines: crown, chair rail
  const side = (Y, col, w, op) => {
    const yb = VP.y - (F * Y) / 3.0; // at the back wall
    const yn = VP.y + (yb - VP.y) * 2; // at x = 0 (Z = 1.5)
    return `<path d="M0 ${r1(yn)}L400 ${r1(yb)}M1600 ${r1(yn)}L1200 ${r1(yb)}" stroke="${col}" stroke-width="${w}" stroke-opacity="${op}" fill="none"/>`;
  };
  s.push(side(1.0, '#16213a', 2, 0.9));
  s.push(side(-0.25, '#121c30', 1.4, 0.7));
  // corners
  s.push(`<path d="M400 150V720M1200 150V720" stroke="#0f1828" stroke-width="2" fill="none"/>`);
  s.push(`<path d="M400 150H1200" stroke="#121b2c" stroke-width="2" fill="none"/>`);
  const wide = windowParts('rw', { x0: 455, y0: 238, x1: 1145, y1: 448 }, [575, 1025]);
  const mid = windowParts('rm', { x0: 575, y0: 238, x1: 1025, y1: 448 }, [731, 869]);
  const narrow = windowParts('rn', { x0: 705, y0: 238, x1: 895, y1: 448 }, []);
  s.push(`<g class="room-win room-win--wide" data-glass="${wide.glass.join(' ')}">\n${wide.svg}\n</g>`);
  s.push(`<g class="room-win room-win--mid" data-glass="${mid.glass.join(' ')}">\n${mid.svg}\n</g>`);
  s.push(`<g class="room-win room-win--narrow" data-glass="${narrow.glass.join(' ')}">\n${narrow.svg}\n</g>`);
  return s.join('\n');
}

// ───────────────────────── SHELVES on the side walls ─────────────────────────
function shelves() {
  const xL = (Z) => VP.x - (F * 1.6) / Z;
  const yAtZ = (Y, Z) => VP.y - (F * Y) / Z;
  const Z0 = 2.12, Z1 = 2.94;
  const boards = [0.98, 0.728, 0.32, -0.08, -0.48];
  const s = [];
  const book = (za, zb, yb, h, fill, op) => [[xL(za), yAtZ(yb, za)], [xL(za), yAtZ(yb + h, za)], [xL(zb), yAtZ(yb + h, zb)], [xL(zb), yAtZ(yb, zb)]];
  const side = (mirror, seed) => {
    const R = rng(seed);
    const M = (p) => p.map(([x, y]) => [mirror ? 1600 - x : x, y]);
    const g = [];
    // carcass back panel on the wall
    g.push(`<path d="${pathOf(M([[xL(Z0), yAtZ(1.02, Z0)], [xL(Z1), yAtZ(1.02, Z1)], [xL(Z1), yAtZ(-1.2, Z1)], [xL(Z0), yAtZ(-1.2, Z0)]]))}" fill="#080c14"/>`);
    // books
    const books = [];
    for (let b = 1; b < boards.length; b++) {
      const yb = boards[b];
      const room = boards[b - 1] - boards[b] - 0.03;
      let z = Z0 + 0.03 + R() * 0.03;
      while (z < Z1 - 0.06) {
        const t = 0.025 + R() * 0.03;
        if (R() < 0.12) { z += 0.06 + R() * 0.06; continue; }
        const h = room * (0.62 + R() * 0.33);
        const c = R();
        const fill = c < 0.1 ? '#4ea8ff' : c < 0.38 ? '#22324a' : c < 0.66 ? '#2b3a55' : c < 0.85 ? '#1a2436' : '#33476a';
        const op = c < 0.1 ? 0.5 : 1;
        books.push(`<path d="${pathOf(M(book(z, z + t, yb, h)))}" fill="${fill}"${op < 1 ? ` opacity="${op}"` : ''}/>`);
        z += t + 0.003;
      }
    }
    g.push(books.join(''));
    // shelf boards: the head and sill boards run into the window's head and sill lines at the corner
    g.push(`<path d="${boards.map((Y) => pathOf(M([[xL(Z0), yAtZ(Y, Z0)], [xL(Z1), yAtZ(Y, Z1)]]), false)).join('')}" stroke="#1a2030" stroke-width="3" fill="none"/>`);
    g.push(`<path d="${boards.map((Y) => pathOf(M([[xL(Z0), yAtZ(Y, Z0) - 1.6], [xL(Z1), yAtZ(Y, Z1) - 1.2]]), false)).join('')}" stroke="#25324c" stroke-width="0.8" fill="none" opacity="0.8"/>`);
    // end panel facing the room
    const ex = xL(Z0);
    g.push(`<path d="${pathOf(M([[ex - 7, yAtZ(1.02, Z0) - 2], [ex, yAtZ(1.02, Z0)], [ex, 1000], [ex - 7, 1000]]))}" fill="#0a0d13"/>`);
    return g.join('\n');
  };
  s.push(side(false, 101));
  s.push(side(true, 202));
  s.push(`<defs><linearGradient id="sDimL" x1="0" x2="400" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0.45" stop-color="#03050a" stop-opacity="0.55"/><stop offset="1" stop-color="#03050a" stop-opacity="0.12"/></linearGradient><linearGradient id="sDimR" x1="1600" x2="1200" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0.45" stop-color="#03050a" stop-opacity="0.55"/><stop offset="1" stop-color="#03050a" stop-opacity="0.12"/></linearGradient></defs>`);
  s.push(`<rect x="0" y="0" width="400" height="1000" fill="url(#sDimL)"/><rect x="1200" y="0" width="400" height="1000" fill="url(#sDimR)"/>`);
  return s.join('\n');
}

const v = view();
const INDEX = fileURLToPath(new URL('../index.html', import.meta.url));
const ind = ' '.repeat(18);
const indent = (t) => t.split('\n').map((l) => ind + l).join('\n');
const SVG = 'viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg"';
const block = `            <!-- THE VIEW: a snowy range under a moonlit night sky — farthest layer, so it drifts a little more than the wall.
                 hero-window.js adds the falling snow (canvas) over the glass and twinkles the stars listed in data-twinkle. -->
            <div class="layer layer--sky" data-parallax="0.22">
              <div class="layer-inner" data-mouse="-3">
                <svg class="hero__view" ${SVG} data-twinkle="${v.twinkle.map(([x, y]) => `${x},${y}`).join(' ')}">
${indent(v.svg)}
                </svg>
              </div>
            </div>
            <!-- THE ROOM: back wall 1.8 m behind the desk, side walls / ceiling / floor converging on the monitor's axis (vanishing point 800,420).
                 The window is set into the wall (reveals, sill, slim mullions); one of three crops shows per viewport shape (hero.css). -->
            <div class="layer layer--room" data-parallax="0.16">
              <div class="layer-inner" data-mouse="4">
                <svg class="hero__room" ${SVG}>
${indent(room())}
                </svg>
              </div>
            </div>
            <!-- Bookshelves against the side walls; their head and sill boards run into the window's head and sill lines -->
            <div class="layer layer--shelves" data-parallax="0.16" data-mobile-hide>
              <div class="layer-inner" data-mouse="6">
                <svg ${SVG}>
${indent(shelves())}
                </svg>
              </div>
            </div>
`;
const html = readFileSync(INDEX, 'utf8');
const start = html.search(/^ *<!-- THE VIEW:/m);
const end = html.search(/^ *<!-- PLACEHOLDER: desk surface/m);
if (start < 0 || end < start) throw new Error('index.html: hero layer markers not found');
writeFileSync(INDEX, html.slice(0, start) + block + html.slice(end));
console.log('hero window art written to index.html');
