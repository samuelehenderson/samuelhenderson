// Generates the contact section's room (07 · Connect): the office at the end of
// the day, with depth from the monitor back to a panelled back wall and a
// recessed window onto a snowy range at blue hour. Writes the stage markup into
// index.html between the "CONTACT ROOM" markers. Dev-only; not part of the
// build. Run from the repo root:  node tools/contact-room-art.mjs
//
// One 3D room, one camera. Metres, eye at the origin, X right, Y up, Z ahead.
// Art frame: 1600x1000 units; contact.css fits it to the screen and crops it
// per breakpoint (desktop: whole frame; tablet / phone: around the window).
//   screen x = CX + F·X/Z,  y = CY − F·Y/Z
// The window's glass is an HTML box (.cx-window) behind the room SVG, so the
// view inside it can drift on its own and the snow canvas can sit on it.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CX = 742, CY = 372, F = 760;
const P = (X, Y, Z) => [CX + (F * X) / Z, CY - (F * Y) / Z];
const r1 = (v) => Math.round(v * 10) / 10;
const pt = ([x, y]) => `${r1(x)} ${r1(y)}`;
const poly = (a, close = true) => 'M' + a.map(pt).join('L') + (close ? 'Z' : '');
const polyI = (a, close = true) => 'M' + a.map(([x, y]) => `${Math.round(x)} ${Math.round(y)}`).join('L') + (close ? 'Z' : '');

// ── the room ──
const XL = -1.875, XR = 2.125;   // side walls (4.0 m wide; 32 boards of 125 mm)
const YF = -1.35, YC = 1.35;     // floor, ceiling (eye 1.35 m above the floor, 2.7 m room)
const ZB = 4.2;                  // back wall
const ZN = 0.55;                 // near cut (well outside the frame)
const BOARD = 0.125;
// window: opening on the wall face, edges and mullions on board seams (6 + 5 + 6 boards); glass 140 mm deeper
const WIN = { x0: -1.125, x1: 1.0, y0: -0.3, y1: 1.15, zg: ZB + 0.14, frame: 0.05, mull: [-0.375, 0.25], mw: 0.016 };
// desk + monitor (the hero's monitor, on an arm). The monitor is 2.7 m in front of the back wall:
// its left edge crosses the corner where the back wall meets the right wall (art x 1126.5) by
// ~60 units, so it overlaps the back wall and reads as nearer than it, not hung on the side wall.
// Its bottom sits ~20 units below the sill line, closer to the desk; the note's top on a
// 1280x720 screen is at ~455 art units, so it still clears the note there.
const DESK = { x0: -0.2, z0: 0.95, z1: 1.72, y: -0.61, t: 0.032 };
const MON = { x0: 0.66, x1: 1.3, z: 1.52 };
MON.y0 = (WIN.y0 * MON.z) / ZB - 0.04;     // 20 art units below the sill line
MON.y1 = MON.y0 + 0.38;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function ridge(ctrl, { step = 6, rough = 0.22, seed = 1 } = {}) {
  const R = rng(seed);
  const out = [ctrl[0]];
  const sub = (a, b) => {
    const dx = b[0] - a[0];
    if (dx <= step) { out.push(b); return; }
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + (R() - 0.5) * rough * dx];
    sub(a, m); sub(m, b);
  };
  for (let i = 1; i < ctrl.length; i++) sub(ctrl[i - 1], ctrl[i]);
  return out;
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

// glass rect (outer bounds of the panes) in art units
const G0 = P(WIN.x0 + WIN.frame, WIN.y1 - WIN.frame, WIN.zg);
const G1 = P(WIN.x1 - WIN.frame, WIN.y0 + WIN.frame, WIN.zg);
const GLASS = { x: G0[0], y: G0[1], w: G1[0] - G0[0], h: G1[1] - G0[1] };
// the view box overhangs the glass so the view can drift (contact.css: inset -15% -8%)
const VM = { x: 0.08, y: 0.15 };

// ───────────────────────── THE VIEW (inside the glass) ─────────────────────────
// Its own frame: the glass spans x 0..1000; y 0..GH. The eye's horizon is where
// the room's horizon (CY) crosses the glass. Looking east at blue hour: the pink
// belt above Earth's shadow, alpenglow on the summits, a cloud deck letting a
// little snow down, mist in the valleys, a snowy treeline.
function view() {
  const GH = Math.round((1000 * GLASS.h) / GLASS.w);
  const HZ = Math.round(((CY - GLASS.y) / GLASS.h) * GH);
  const vb = { x: -Math.round(1000 * VM.x), y: -Math.round(GH * VM.y), w: Math.round(1000 * (1 + 2 * VM.x)), h: Math.round(GH * (1 + 2 * VM.y)) };
  const X0 = vb.x, X1 = vb.x + vb.w, Y0 = vb.y, Y1 = vb.y + vb.h;
  const R = rng(17);
  const s = [];
  s.push(`<defs>
<linearGradient id="cvSky" x1="0" x2="0" y1="${Y0}" y2="${HZ}" gradientUnits="userSpaceOnUse">${[[Y0, '#121842'], [HZ - 560, '#1a2358'], [HZ - 440, '#2a3880'], [HZ - 350, '#4a58a4'], [HZ - 300, '#8784bd'], [HZ - 262, '#d6a3ae'], [HZ - 226, '#f3bd95'], [HZ - 180, '#d49a98'], [HZ - 110, '#6a72b0'], [HZ, '#4b5596']].map(([yy, c]) => `<stop offset="${((yy - Y0) / (HZ - Y0)).toFixed(3)}" stop-color="${c}"/>`).join('')}</linearGradient>
<linearGradient id="cvCloud" x1="0" x2="0" y1="${Y0}" y2="${Math.round(GH * 0.3)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0e1338"/><stop offset="0.7" stop-color="#1b2257"/><stop offset="1" stop-color="#2a2f68"/></linearGradient>
<linearGradient id="cvCloudLit" x1="0" x2="0" y1="${Y0}" y2="${Math.round(GH * 0.3)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2a2f6a"/><stop offset="0.75" stop-color="#5b4f8f"/><stop offset="1" stop-color="#b98aa8"/></linearGradient>
<linearGradient id="cvFar" x1="0" x2="0" y1="${HZ - 340}" y2="${HZ - 120}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9a97c8"/><stop offset="1" stop-color="#7b7fb8"/></linearGradient>
<linearGradient id="cvSnowLit" x1="0" x2="0" y1="${HZ - 450}" y2="${HZ - 150}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffe6d6"/><stop offset="0.35" stop-color="#f6d0c6"/><stop offset="0.75" stop-color="#cdc6e2"/><stop offset="1" stop-color="#a9afd8"/></linearGradient>
<linearGradient id="cvShade" x1="0" x2="0" y1="${HZ - 450}" y2="${HZ}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2c3a86" stop-opacity="0.5"/><stop offset="0.6" stop-color="#26337a" stop-opacity="0.58"/><stop offset="1" stop-color="#1f2a68" stop-opacity="0.4"/></linearGradient>
<linearGradient id="cvRock" x1="0" x2="0" y1="${HZ - 300}" y2="${HZ}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2a336f"/><stop offset="0.6" stop-color="#36407e"/><stop offset="1" stop-color="#5a62a2"/></linearGradient>
<linearGradient id="cvMist" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#b6b4e0" stop-opacity="0"/><stop offset="0.55" stop-color="#aeb0de" stop-opacity="0.32"/><stop offset="1" stop-color="#8f96cf" stop-opacity="0.08"/></linearGradient>
<linearGradient id="cvGround" x1="0" x2="0" y1="${HZ + 30}" y2="${Y1}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#6d76b4"/><stop offset="0.45" stop-color="#525c9b"/><stop offset="1" stop-color="#3a4380"/></linearGradient>
<radialGradient id="cvStarGlow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff6e8" stop-opacity="0.9"/><stop offset="0.25" stop-color="#ffe9cc" stop-opacity="0.3"/><stop offset="1" stop-color="#ffe9cc" stop-opacity="0"/></radialGradient>
<filter id="cvSoft" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="7"/></filter>
<filter id="cvSoft2" x="-10%" y="-40%" width="120%" height="180%"><feGaussianBlur stdDeviation="3"/></filter>
</defs>`);
  s.push(`<rect x="${X0}" y="${Y0}" width="${vb.w}" height="${vb.h}" fill="url(#cvSky)"/>`);

  // a few early stars between the clouds; one bright planet
  const stars = [];
  for (let i = 0; i < 26; i++) {
    const x = Math.round(X0 + 30 + R() * (vb.w - 60));
    const y = Math.round(GH * 0.16 + Math.pow(R(), 1.6) * GH * 0.26);
    stars.push(`<circle cx="${x}" cy="${y}" r="${(0.9 + Math.pow(R(), 3) * 1.4).toFixed(1)}" opacity="${(0.25 + R() * 0.45).toFixed(2)}"/>`);
  }
  s.push(`<g fill="#eef0ff">${stars.join('')}</g>`);
  const planet = [790, Math.round(GH * 0.2)];
  s.push(`<circle cx="${planet[0]}" cy="${planet[1]}" r="16" fill="url(#cvStarGlow)"/><circle cx="${planet[0]}" cy="${planet[1]}" r="2.6" fill="#fff8ec"/>`);
  const twinkle = [planet, [212, Math.round(GH * 0.25)], [538, Math.round(GH * 0.19)], [930, Math.round(GH * 0.31)], [96, Math.round(GH * 0.36)]];
  s.push(`<g fill="#f4f2ff">${twinkle.slice(1).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.7"/>`).join('')}</g>`);

  // cloud deck: the snow falls from it; its underside catches the last pink light
  const deck = (y, amp, seed) => {
    const RC = rng(seed);
    const pts = [[X0 - 20, Y0 - 20], [X1 + 20, Y0 - 20]];
    for (let x = X1 + 20; x >= X0 - 20; x -= 40) pts.push([x, y + Math.sin(x / 97 + seed) * amp + Math.sin(x / 41) * amp * 0.45 + (RC() - 0.5) * amp * 0.8]);
    return pts;
  };
  const d0 = deck(GH * 0.25, 20, 7), d1 = deck(GH * 0.15, 24, 3), d2 = deck(GH * 0.06, 18, 5);
  s.push(`<g filter="url(#cvSoft)"><path d="${polyI(d0)}" fill="url(#cvCloudLit)" opacity="0.55"/><path d="${polyI(d1)}" fill="url(#cvCloud)" opacity="0.9"/><path d="${polyI(d2)}" fill="#0b1032" opacity="0.9"/></g>`);
  // a few wisps lower down, lit pink
  const wisp = (x, y, w, o) => `<ellipse cx="${x}" cy="${y}" rx="${w}" ry="${(w * 0.06).toFixed(1)}" fill="#e7aab4" opacity="${o}"/>`;
  s.push(`<g filter="url(#cvSoft2)">${wisp(160, GH * 0.47, 120, 0.18)}${wisp(720, GH * 0.44, 150, 0.16)}${wisp(980, GH * 0.5, 90, 0.14)}</g>`);

  // ── far range: palest, softest (atmospheric perspective)
  const far = ridge([[X0, HZ - 200], [30, HZ - 286], [130, HZ - 222], [210, HZ - 250], [360, HZ - 338], [430, HZ - 262], [560, HZ - 236], [700, HZ - 316], [770, HZ - 250], [880, HZ - 270], [1010, HZ - 300], [X1, HZ - 230]], { step: 12, rough: 0.3, seed: 11 });
  s.push(`<path id="cvFarR" d="${polyI([...far, [X1, HZ + 10], [X0, HZ + 10]])}" fill="url(#cvFar)"/>`);
  s.push(`<clipPath id="cvFarClip"><use href="#cvFarR"/></clipPath>`);
  const farSnow = ridge([[X0, HZ - 200], [300, HZ - 226], [600, HZ - 214], [900, HZ - 232], [X1, HZ - 206]], { step: 16, rough: 0.6, seed: 12 });
  s.push(`<path clip-path="url(#cvFarClip)" d="${polyI([[X0, HZ - 420], [X1, HZ - 420], ...farSnow.slice().reverse()])}" fill="#eadbe8" opacity="0.6"/>`);
  s.push(`<rect x="${X0}" y="${HZ - 250}" width="${vb.w}" height="110" fill="url(#cvMist)"/>`);

  // ── main range: the big peak sits in the middle pane. Light from the west,
  // behind the viewer and a little to the left: faces left of an arête are lit.
  const PK = [ // summit x, y (above the horizon), snow depth, arête lean
    [-40, HZ - 236, 44, 0.18], [118, HZ - 300, 52, 0.2], [262, HZ - 252, 44, 0.16], [476, HZ - 446, 96, 0.13],
    [610, HZ - 352, 70, 0.17], [800, HZ - 318, 60, 0.15], [946, HZ - 266, 50, 0.18], [1068, HZ - 222, 40, 0.2]];
  const mainCtrl = [[X0, HZ - 190], ...PK.flatMap(([x, y], i) => {
    if (i === PK.length - 1) return [[x, y]];
    const nx = PK[i + 1][0];
    const mid = (x + nx) / 2;
    return [[x, y], [mid - (nx - x) * 0.12, Math.max(y, PK[i + 1][1]) + 70 + R() * 40], [mid + (nx - x) * 0.08, Math.max(y, PK[i + 1][1]) + 50 + R() * 30]];
  }), [X1, HZ - 210]];
  mainCtrl.sort((a, b) => a[0] - b[0]);
  const main = ridge(mainCtrl, { step: 9, rough: 0.27, seed: 23 });
  s.push(`<path id="cvMainR" d="${polyI([...main, [X1, HZ + 40], [X0, HZ + 40]])}" fill="url(#cvRock)"/>`);
  s.push(`<clipPath id="cvMainClip"><use href="#cvMainR"/></clipPath>`);
  // snowline: deepest under each summit, tongues down the gullies
  const RS = rng(31);
  const snowline = [];
  for (let x = X0; x <= X1; x += 8) {
    let y = Math.min(...PK.map(([px, py, d]) => py + d * 2.3 + 0.36 * Math.abs(x - px)));
    y += Math.sin(x / 9.3) * 3 + Math.sin(x / 5.1) * 2;
    if (RS() < 0.16) y += 6 + RS() * 14;
    snowline.push([x, Math.min(y, HZ - 40)]);
  }
  const snowPoly = [[X0, HZ - 420], [X1, HZ - 420], ...snowline.slice().reverse()];
  s.push(`<path clip-path="url(#cvMainClip)" d="${polyI(snowPoly)}" fill="url(#cvSnowLit)"/>`);

  const RA = rng(41);
  const shade = [], rims = [], aretes = [], gul = [], streak = [];
  const lowest = (x0, x1) => main.filter(([x]) => x >= x0 && x <= x1).reduce((m, p) => (p[1] > m[1] ? p : m), [x0, 0]);
  PK.forEach(([px, py, d, lean], i) => {
    const saddleR = i === PK.length - 1 ? [X1, HZ - 210] : lowest(px, PK[i + 1][0]);
    const saddleL = i === 0 ? [X0, HZ - 190] : lowest(PK[i - 1][0], px);
    const ar = [[px, py]];
    for (let y = py + 14; y < HZ + 30; y += 14) ar.push([px + lean * (y - py) + 0.004 * (y - py) ** 2 + (RA() - 0.5) * 3, y]);
    aretes.push(ar.filter(([, y]) => y < py + d * 1.6));
    // shaded face: right of the arête down to the right saddle and the valley below it
    const valley = [];
    for (let y = saddleR[1] + 4; y < HZ + 40; y += 14) valley.push([saddleR[0] + 0.35 * (y - saddleR[1]) + (RA() - 0.5) * 4, y]);
    shade.push(polyI([...ar, ...valley.reverse(), [saddleR[0] + 2, saddleR[1]], [px + 2, py - 30]]));
    rims.push(main.filter(([x]) => x >= saddleL[0] && x <= px));
    // texture: dark gullies down the lit face, faint streaks across the shaded one
    const nLit = Math.max(2, Math.round((px - saddleL[0]) / 16));
    for (let k = 0; k < nLit; k++) {
      const x0 = saddleL[0] + (px - saddleL[0]) * (0.15 + (0.8 * (k + RA() * 0.6)) / nLit);
      const y0 = yAt(main, x0) + 3 + RA() * 4;
      const len = 10 + RA() * 26;
      const ang = -(0.18 + RA() * 0.3);
      gul.push([[x0, y0], [x0 + ang * len * 0.5 + (RA() - 0.5) * 2, y0 + len * 0.5], [x0 + ang * len, y0 + len]]);
    }
    const nSh = Math.max(1, Math.round((saddleR[0] - px) / 20));
    for (let k = 0; k < nSh; k++) {
      const x0 = px + (saddleR[0] - px) * (0.2 + (0.7 * (k + RA() * 0.6)) / nSh);
      const y0 = yAt(main, x0) + 4;
      const len = 10 + RA() * 18;
      streak.push([[x0, y0], [x0 + 0.3 * len, y0 + len]]);
    }
  });
  s.push(`<g clip-path="url(#cvMainClip)"><path d="${shade.join('')}" fill="url(#cvShade)"/></g>`);
  s.push(`<g clip-path="url(#cvMainClip)" fill="none" stroke-linecap="round"><path d="${gul.map((l) => polyI(l, false)).join('')}" stroke="#6e6fa8" stroke-width="1.6" stroke-opacity="0.45"/><path d="${streak.map((l) => polyI(l, false)).join('')}" stroke="#a3aad8" stroke-width="1.2" stroke-opacity="0.22"/></g>`);
  s.push(`<g fill="none" stroke-linejoin="round" stroke-linecap="round"><path d="${rims.map((r) => polyI(r, false)).join('')}" stroke="#fff1e6" stroke-width="1.6" stroke-opacity="0.75"/><path d="${aretes.map((r) => polyI(r, false)).join('')}" stroke="#ffe9dc" stroke-width="1.1" stroke-opacity="0.35"/></g>`);
  s.push(`<rect x="${X0}" y="${HZ - 150}" width="${vb.w}" height="130" fill="url(#cvMist)"/>`);

  // ── foothills, dusted with snow
  const hills = ridge([[X0, HZ - 50], [60, HZ - 70], [180, HZ - 46], [300, HZ - 64], [420, HZ - 40], [560, HZ - 58], [700, HZ - 36], [830, HZ - 62], [960, HZ - 44], [X1, HZ - 60]], { step: 14, rough: 0.18, seed: 61 });
  s.push(`<path id="cvHills" d="${polyI([...hills, [X1, HZ + 60], [X0, HZ + 60]])}" fill="#1c2458"/>`);
  s.push(`<clipPath id="cvHillsClip"><use href="#cvHills"/></clipPath>`);
  s.push(`<g clip-path="url(#cvHillsClip)"><path d="${polyI([...hills.map(([x, y]) => [x, y - 1]), ...hills.slice().reverse().map(([x, y]) => [x, y + 5 + Math.abs(Math.sin(x / 13)) * 6])])}" fill="#8b92c8" opacity="0.5"/></g>`);
  s.push(`<rect x="${X0}" y="${HZ - 40}" width="${vb.w}" height="56" fill="url(#cvMist)"/>`);

  // ── treeline across the valley, snow on the boughs
  const RT = rng(71);
  const q = (v) => Math.round(v);
  const tree = (x, base, h, w) =>
    `M${q(x)} ${q(base - h)}l${q(w * 0.3)} ${q(h * 0.42)}l${q(-w * 0.12)} 0l${q(w * 0.34)} ${q(h * 0.58)}l${q(-w * 0.44)} 3l${q(-w * 0.16)} 0l${q(-w * 0.44)} -3l${q(w * 0.34)} ${q(-h * 0.58)}l${q(-w * 0.12)} 0z`;
  let trees = '', snowy = '';
  for (let x = X0 + 4; x < X1;) {
    const h = 20 + RT() * 34 + (RT() < 0.1 ? 16 : 0);
    const w = h * (0.36 + RT() * 0.08);
    const base = HZ + 18 + RT() * 12;
    trees += tree(x, base, h, w);
    if (RT() < 0.5) snowy += `M${q(x)} ${q(base - h)}l${q(-w * 0.22)} ${q(h * 0.34)}M${q(x - w * 0.12)} ${q(base - h * 0.5)}l${q(-w * 0.3)} ${q(h * 0.28)}`;
    x += w * (0.6 + RT() * 0.6);
  }
  s.push(`<path d="${trees}" fill="#0d1234"/>`);
  s.push(`<path d="${snowy}" fill="none" stroke="#a7aedb" stroke-width="1.6" stroke-opacity="0.55" stroke-linecap="round"/>`);

  // ── the snowy field in front, two near firs framing the side panes
  const field = ridge([[X0, HZ + 24], [200, HZ + 34], [420, HZ + 26], [640, HZ + 40], [860, HZ + 28], [X1, HZ + 36]], { step: 20, rough: 0.12, seed: 81 });
  s.push(`<path d="${polyI([...field, [X1, Y1], [X0, Y1]])}" fill="url(#cvGround)"/>`);
  const drift = (y, seed) => polyI(ridge([[X0, y], [300, y + 6], [600, y - 4], [900, y + 5], [X1, y]], { step: 24, rough: 0.2, seed }), false);
  s.push(`<g fill="none" stroke="#8a93cc" stroke-opacity="0.25" stroke-width="1.4"><path d="${drift(HZ + 70, 91)}"/><path d="${drift(HZ + 112, 92)}"/></g>`);
  const fir = (x, base, h) => {
    let d = '';
    const tiers = 5;
    for (let t = 0; t < tiers; t++) {
      const top = base - h + (h * t) / tiers * 0.82;
      const w = h * (0.12 + 0.07 * t);
      d += `M${q(x)} ${q(top)}L${q(x + w)} ${q(top + h * 0.26)}L${q(x - w)} ${q(top + h * 0.26)}Z`;
    }
    return d + `M${q(x - 3)} ${q(base - h * 0.08)}h6v${q(h * 0.1)}h-6z`;
  };
  s.push(`<path d="${fir(-30, Y1 - 30, 230)}${fir(28, Y1 - 10, 150)}${fir(1032, Y1 - 24, 210)}" fill="#0a0e2a"/>`);
  s.push(`<path d="${fir(-30, Y1 - 30, 230)}${fir(28, Y1 - 10, 150)}${fir(1032, Y1 - 24, 210)}" fill="none" stroke="#7f88c2" stroke-opacity="0.35" stroke-width="1.2" stroke-dasharray="6 9"/>`);

  return { svg: s.join('\n'), vb, twinkle, GH, HZ };
}

// ───────────────────────── THE ROOM (walls, panelling, window) ─────────────────────────
function room() {
  const s = [];
  const cTop = P(0, YC, ZB)[1], cBot = P(0, YF, ZB)[1];
  const bx0 = P(XL, 0, ZB)[0], bx1 = P(XR, 0, ZB)[0];
  const far = { x0: -700, x1: 2300, y0: -500, y1: 1500 };
  s.push(`<defs>
<linearGradient id="crCeil" x1="0" x2="0" y1="${far.y0}" y2="${r1(cTop)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#03040d"/><stop offset="0.7" stop-color="#070a1c"/><stop offset="1" stop-color="#0c1129"/></linearGradient>
<linearGradient id="crFloor" x1="0" x2="0" y1="${r1(cBot)}" y2="1250" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0d1230"/><stop offset="0.4" stop-color="#090d24"/><stop offset="1" stop-color="#04060f"/></linearGradient>
<linearGradient id="crFallL" x1="${r1(bx0)}" x2="-200" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#03040c" stop-opacity="0.15"/><stop offset="0.55" stop-color="#03040c" stop-opacity="0.45"/><stop offset="1" stop-color="#03040c" stop-opacity="0.78"/></linearGradient>
<linearGradient id="crFallR" x1="${r1(bx1)}" x2="1800" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#03040c" stop-opacity="0.2"/><stop offset="0.6" stop-color="#03040c" stop-opacity="0.35"/><stop offset="1" stop-color="#03040c" stop-opacity="0.55"/></linearGradient>
<linearGradient id="crBackTB" x1="0" x2="0" y1="${r1(cTop)}" y2="${r1(cBot)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#02030a" stop-opacity="0.6"/><stop offset="0.16" stop-color="#02030a" stop-opacity="0.12"/><stop offset="0.55" stop-color="#02030a" stop-opacity="0"/><stop offset="0.86" stop-color="#02030a" stop-opacity="0.22"/><stop offset="1" stop-color="#02030a" stop-opacity="0.55"/></linearGradient>
<radialGradient id="crWinWash" cx="${r1(GLASS.x + GLASS.w / 2)}" cy="${r1(GLASS.y + GLASS.h * 0.62)}" r="${r1(GLASS.w * 1.05)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8a8ad8" stop-opacity="0.26"/><stop offset="0.45" stop-color="#7474c6" stop-opacity="0.1"/><stop offset="1" stop-color="#6f74c4" stop-opacity="0"/></radialGradient>
<radialGradient id="crMonWash" cx="${r1(P((MON.x0 + MON.x1) / 2, 0, MON.z)[0])}" cy="${r1(P(0, (MON.y0 + MON.y1) / 2, MON.z)[1])}" r="620" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4ea8ff" stop-opacity="0.3"/><stop offset="0.3" stop-color="#3f8fe6" stop-opacity="0.13"/><stop offset="0.65" stop-color="#2f6cc0" stop-opacity="0.03"/><stop offset="1" stop-color="#2f6cc0" stop-opacity="0"/></radialGradient>
<linearGradient id="crRakeL" x1="${r1(bx0)}" x2="${r1(P(XL, 0, 2.4)[0])}" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9d9be6" stop-opacity="0.24"/><stop offset="0.5" stop-color="#9d9be6" stop-opacity="0.07"/><stop offset="1" stop-color="#8f96e0" stop-opacity="0"/></linearGradient>
<linearGradient id="crPatch" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#b1a8ea" stop-opacity="0.22"/><stop offset="1" stop-color="#9aa2e8" stop-opacity="0.02"/></linearGradient>
<linearGradient id="crAO" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#010208" stop-opacity="0.7"/><stop offset="1" stop-color="#010208" stop-opacity="0"/></linearGradient>
<linearGradient id="crSillSnow" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#dfe0f6"/><stop offset="1" stop-color="#8d94c8"/></linearGradient>
<linearGradient id="crGlassLow" x1="0" x2="0" y1="0" y2="1"><stop offset="0.6" stop-color="#05071a" stop-opacity="0"/><stop offset="1" stop-color="#05071a" stop-opacity="0.3"/></linearGradient>
<linearGradient id="crSheen" x1="0" x2="1" y1="0" y2="0.6"><stop offset="0.2" stop-color="#dfe6ff" stop-opacity="0"/><stop offset="0.3" stop-color="#dfe6ff" stop-opacity="0.05"/><stop offset="0.36" stop-color="#dfe6ff" stop-opacity="0"/><stop offset="0.62" stop-color="#dfe6ff" stop-opacity="0"/><stop offset="0.69" stop-color="#dfe6ff" stop-opacity="0.035"/><stop offset="0.73" stop-color="#dfe6ff" stop-opacity="0"/></linearGradient>
<radialGradient id="crMonRefl" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#4ea8ff" stop-opacity="0.16"/><stop offset="1" stop-color="#4ea8ff" stop-opacity="0"/></radialGradient>
<radialGradient id="crFrost" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#e6ecff" stop-opacity="0.38"/><stop offset="0.4" stop-color="#ccd6f6" stop-opacity="0.14"/><stop offset="1" stop-color="#ccd6f6" stop-opacity="0"/></radialGradient>
${frostTuft('crFrostA', 5)}
${frostTuft('crFrostB', 9)}
<filter id="crBlur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10"/></filter>
</defs>`);

  // ceiling, floor, side walls: all converge on the eye's vanishing point
  const corner = (X, Y) => [P(X, Y, ZB), P(X, Y, ZN)];
  const [cLB, cLN] = corner(XL, YC), [cRB, cRN] = corner(XR, YC), [fLB, fLN] = corner(XL, YF), [fRB, fRN] = corner(XR, YF);
  s.push(`<path d="${poly([cLB, cRB, cRN, cLN])}" fill="url(#crCeil)"/>`);
  s.push(`<path d="${poly([fLB, fRB, fRN, fLN])}" fill="url(#crFloor)"/>`);
  // floor: wide planks running away from us
  let planks = '';
  for (let X = XL + 0.22; X < XR; X += 0.22) planks += poly([P(X, YF, ZB), P(X, YF, ZN)], false);
  s.push(`<path d="${planks}" stroke="#05070f" stroke-width="1.4" fill="none" opacity="0.8"/>`);
  // window light on the floor (sky light falls in steeply, soft at dusk)
  const fall = (X, Y) => { const t = (Y - YF) / 1.05; return P(X + 0.1 * t, YF, ZB - t); };
  s.push(`<path d="${poly([fall(WIN.x0, WIN.y0), fall(WIN.x1, WIN.y0), fall(WIN.x1, WIN.y1), fall(WIN.x0, WIN.y1)])}" fill="url(#crPatch)" filter="url(#crBlur)"/>`);

  // side walls
  const wallQuad = (X) => [P(X, YC, ZB), P(X, YF, ZB), P(X, YF, ZN), P(X, YC, ZN)];
  // boards on a side wall: a seam every 125 mm back from the corner, foreshortened
  const sideBoards = (X, mirror) => {
    const g = [];
    let seams = '', lit = '', tone = '';
    let k = 0;
    for (let Z = ZB; Z > 0.9; Z -= BOARD, k++) {
      const Zn = Z - BOARD;
      if (k % 3 === 1) tone += poly([P(X, YC, Z), P(X, YF, Z), P(X, YF, Zn), P(X, YC, Zn)]);
      const [x, yt] = P(X, YC, Z);
      const yb = P(X, YF, Z)[1];
      const w = Math.max(0.6, (F * 0.007) / Z);
      seams += `M${r1(x)} ${r1(yt)}V${r1(yb)}`;
      // the seam's near lip catches light (monitor / room side)
      const dx = (mirror ? 1 : -1) * w * 0.9;
      lit += `M${r1(x + dx)} ${r1(yt)}V${r1(yb)}`;
      g.push(w);
    }
    return { seams, lit, tone, w: g };
  };
  for (const [X, mirror] of [[XL, false], [XR, true]]) {
    const b = sideBoards(X, mirror);
    s.push(`<path d="${poly(wallQuad(X))}" fill="#141b3f"/>`);
    s.push(`<path d="${b.tone}" fill="#171f48" opacity="0.6"/>`);
    s.push(`<path d="${b.seams}" stroke="#070a1c" stroke-width="2.2" fill="none"/>`);
    s.push(`<path d="${b.lit}" stroke="${mirror ? '#3c6fd0' : '#4a54a0'}" stroke-width="0.9" stroke-opacity="${mirror ? 0.42 : 0.3}" fill="none"/>`);
    // shadow gap under the ceiling and a dark skirting
    s.push(`<path d="${poly([P(X, YC, ZB), P(X, YC - 0.03, ZB), P(X, YC - 0.03, ZN), P(X, YC, ZN)])}" fill="#05070f"/>`);
    s.push(`<path d="${poly([P(X, YF + 0.08, ZB), P(X, YF, ZB), P(X, YF, ZN), P(X, YF + 0.08, ZN)])}" fill="#080b1c"/>`);
  }
  // window light raking along the left wall's panelling near the back corner
  s.push(`<path d="${poly(wallQuad(XL))}" fill="url(#crRakeL)"/>`);
  // light falls off toward us on the side walls; corners occluded
  s.push(`<path d="${poly(wallQuad(XL))}" fill="url(#crFallL)"/>`);
  s.push(`<path d="${poly(wallQuad(XR))}" fill="url(#crFallR)"/>`);

  // back wall with the window opening cut out (trim outer edge)
  const trim = 0.07;
  const O0 = P(WIN.x0 - trim, WIN.y1 + trim, ZB), O1 = P(WIN.x1 + trim, WIN.y0, ZB);
  const backD = `${poly([cLB, cRB, fRB, fLB])}${poly([O0, [O1[0], O0[1]], O1, [O0[0], O1[1]]])}`;
  s.push(`<clipPath id="crBackClip"><path clip-rule="evenodd" d="${backD}"/></clipPath>`);
  const back = [];
  // boards: alternate tones, 32 across, seams on the window's edges and mullion lines
  let bTone = '', bSeam = '', bLitL = '', bLitR = '', bLitM = '';
  const winC = (WIN.x0 + WIN.x1) / 2;
  for (let k = 0; k <= 32; k++) {
    const X = XL + k * BOARD;
    const [x] = P(X, 0, ZB);
    if (k < 32 && k % 3 === 1) bTone += `M${r1(x)} ${r1(cTop)}H${r1(P(X + BOARD, 0, ZB)[0])}V${r1(cBot)}H${r1(x)}Z`;
    if (k === 0 || k === 32) continue;
    bSeam += `M${r1(x)} ${r1(cTop)}V${r1(cBot)}`;
    // the seam's lip facing the window (or the monitor, on the right) catches light
    if (X >= 0.9) bLitM += `M${r1(x - 1.1)} ${r1(cTop)}V${r1(cBot)}`;
    else if (X < winC) bLitR += `M${r1(x + 1.1)} ${r1(cTop)}V${r1(cBot)}`;
    else bLitL += `M${r1(x - 1.1)} ${r1(cTop)}V${r1(cBot)}`;
  }
  back.push(`<rect x="${r1(bx0)}" y="${r1(cTop)}" width="${r1(bx1 - bx0)}" height="${r1(cBot - cTop)}" fill="#141b40"/>`);
  back.push(`<path d="${bTone}" fill="#18204a" opacity="0.55"/>`);
  back.push(`<path d="${bSeam}" stroke="#070a1d" stroke-width="1.6" fill="none"/>`);
  back.push(`<path d="${bLitR}${bLitL}" stroke="#5961b0" stroke-width="0.7" stroke-opacity="0.38" fill="none"/>`);
  back.push(`<path d="${bLitM}" stroke="#4ea8ff" stroke-width="0.7" stroke-opacity="0.3" fill="none"/>`);
  back.push(`<rect x="${r1(bx0)}" y="${r1(cTop)}" width="${r1(bx1 - bx0)}" height="5" fill="#05070f"/>`);
  back.push(`<rect x="${r1(bx0)}" y="${r1(P(0, YF + 0.08, ZB)[1])}" width="${r1(bx1 - bx0)}" height="${r1(cBot - P(0, YF + 0.08, ZB)[1])}" fill="#080b1c"/>`);
  back.push(`<rect x="${r1(bx0)}" y="${r1(cTop)}" width="${r1(bx1 - bx0)}" height="${r1(cBot - cTop)}" fill="url(#crWinWash)"/>`);
  back.push(`<rect x="${r1(bx0)}" y="${r1(cTop)}" width="${r1(bx1 - bx0)}" height="${r1(cBot - cTop)}" fill="url(#crBackTB)"/>`);
  s.push(`<g clip-path="url(#crBackClip)">${back.join('')}</g>`);
  // ambient occlusion in the two back corners and along the ceiling line
  const aoW = 46;
  s.push(`<rect x="${r1(bx0)}" y="${r1(cTop)}" width="${aoW}" height="${r1(cBot - cTop)}" fill="url(#crAO)" opacity="0.8"/>`);
  s.push(`<rect x="${r1(bx1)}" y="${r1(cTop)}" width="${aoW}" height="${r1(cBot - cTop)}" fill="url(#crAO)" opacity="0.8" transform="translate(${r1(2 * bx1)} 0) scale(-1 1)"/>`);
  s.push(`<path d="M${r1(bx0)} ${r1(cTop)}V${r1(cBot)}M${r1(bx1)} ${r1(cTop)}V${r1(cBot)}" stroke="#04050e" stroke-width="2" fill="none"/>`);
  s.push(`<path d="M${r1(bx0)} ${r1(cTop)}H${r1(bx1)}M${r1(bx0)} ${r1(cBot)}H${r1(bx1)}" stroke="#04050e" stroke-width="1.6" fill="none"/>`);
  // perspective edges where walls meet ceiling and floor
  s.push(`<path d="${poly([cLB, cLN], false)}${poly([cRB, cRN], false)}${poly([fLB, fLN], false)}${poly([fRB, fRN], false)}" stroke="#04050e" stroke-width="2" fill="none"/>`);
  // the monitor's light on the walls and ceiling (it falls off with distance)
  s.push(`<rect x="${far.x0}" y="${far.y0}" width="${far.x1 - far.x0}" height="${far.y1 - far.y0}" fill="url(#crMonWash)"/>`);

  // ── the window: reveals (all four faces show: the eye is inside the opening's span)
  const Wf = (X, Y) => P(X, Y, ZB), Wg = (X, Y) => P(X, Y, WIN.zg);
  const { x0, x1, y0, y1 } = WIN;
  s.push(`<path d="${poly([Wf(x0, y1), Wg(x0, y1), Wg(x0, y0), Wf(x0, y0)])}" fill="#1d2552"/>`);   // left jamb: faces the room's light
  s.push(`<path d="${poly([Wf(x1, y1), Wg(x1, y1), Wg(x1, y0), Wf(x1, y0)])}" fill="#121939"/>`);   // right jamb
  s.push(`<path d="${poly([Wf(x0, y1), Wf(x1, y1), Wg(x1, y1), Wg(x0, y1)])}" fill="#070a1a"/>`);  // head soffit, in shadow
  s.push(`<path d="${poly([Wf(x0, y0), Wf(x1, y0), Wg(x1, y0), Wg(x0, y0)])}" fill="#2a3266"/>`);  // sill board, sky-lit
  // jamb light: the sky glow grazing the left jamb, darker toward the room
  s.push(`<path d="${poly([Wf(x0, y1), Wg(x0, y1), Wg(x0, y0), Wf(x0, y0)])}" fill="#8f8fd0" opacity="0.12"/>`);

  // frame + mullions at the glass plane; the panes stay open (the HTML view shows through)
  const fr = WIN.frame;
  const panes = [];
  const edges = [x0 + fr, ...WIN.mull.flatMap((m) => [m - WIN.mw, m + WIN.mw]), x1 - fr];
  for (let i = 0; i < edges.length; i += 2) panes.push([edges[i], edges[i + 1]]);
  const paneRects = panes.map(([a, b]) => [Wg(a, y1 - fr), Wg(b, y0 + fr)]);
  // snow drifted on the outside sill, against the bottom of each pane
  const RS = rng(97);
  let sill = '';
  for (const [[ax, ay], [bx, by]] of paneRects) {
    const top = [];
    const n = Math.max(4, Math.round((bx - ax) / 8));
    for (let i = 0; i <= n; i++) {
      const x = ax + ((bx - ax) * i) / n;
      const edge = Math.min(i, n - i) / n;
      top.push([x, by - 3.2 - Math.min(1, edge * 6) * (2.4 + RS() * 2.2)]);
    }
    sill += poly([[ax, by + 1], ...top, [bx, by + 1]]);
  }
  s.push(`<path d="${sill}" fill="url(#crSillSnow)"/>`);
  // glass: monitor reflection, sheen, darker low glass, frost in the corners
  const frost = [];
  const corners = [];
  paneRects.forEach(([[ax, ay], [bx, by]], i) => {
    const big = i === 0 || i === paneRects.length - 1;
    corners.push([ax, ay, big && i === 0 ? 46 : 22, 1, 1], [bx, ay, big && i === paneRects.length - 1 ? 42 : 22, -1, 1], [ax, by, big && i === 0 ? 58 : 28, 1, -1], [bx, by, big && i === paneRects.length - 1 ? 54 : 28, -1, -1]);
  });
  corners.forEach(([cx, cy, r, sx, sy], i) => {
    const k = Math.round((r / 40) * 100) / 100;
    frost.push(`<use href="#crFrost${i % 2 ? 'B' : 'A'}" transform="translate(${r1(cx)} ${r1(cy)}) scale(${r1(sx * k * 100) / 100} ${r1(sy * k * 100) / 100})"/>`);
  });
  const gx = r1(GLASS.x), gy = r1(GLASS.y), gw = r1(GLASS.w), gh = r1(GLASS.h);
  s.push(`<clipPath id="crGlass"><path d="${paneRects.map(([[ax, ay], [bx, by]]) => `M${r1(ax)} ${r1(ay)}H${r1(bx)}V${r1(by)}H${r1(ax)}Z`).join('')}"/></clipPath>`);
  const mref = [gx + gw * 0.88, gy + gh * 0.72];
  s.push(`<g clip-path="url(#crGlass)"><ellipse cx="${r1(mref[0])}" cy="${r1(mref[1])}" rx="${r1(gw * 0.2)}" ry="${r1(gh * 0.22)}" fill="url(#crMonRefl)"/><rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" fill="url(#crSheen)"/><rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" fill="url(#crGlassLow)"/>${frost.join('')}</g>`);
  let frame = poly([Wg(x0, y1), Wg(x1, y1), Wg(x1, y0), Wg(x0, y0)]);
  for (const [[ax, ay], [bx, by]] of paneRects) frame += `M${r1(ax)} ${r1(ay)}V${r1(by)}H${r1(bx)}V${r1(ay)}Z`;
  s.push(`<path fill-rule="evenodd" d="${frame}" fill="#0c1128"/>`);
  // the frame's inner lip catches the sky; mullion faces
  s.push(`<path d="${paneRects.map(([[ax, ay], [bx, by]]) => `M${r1(ax)} ${r1(by)}V${r1(ay)}H${r1(bx)}`).join('')}" fill="none" stroke="#3a4384" stroke-width="0.9" stroke-opacity="0.8"/>`);
  for (const m of WIN.mull) {
    const [mx] = Wg(m, 0);
    s.push(`<rect x="${r1(mx - 0.5)}" y="${gy}" width="1" height="${gh}" fill="#4b55a0" opacity="0.5"/>`);
  }
  // casing trim on the wall face (head + jambs), stool and apron
  const T0 = P(x0 - trim, y1 + trim, ZB), T1 = P(x1 + trim, y0, ZB);
  const I0 = Wf(x0, y1), I1 = Wf(x1, y0);
  s.push(`<path fill-rule="evenodd" d="${poly([T0, [T1[0], T0[1]], T1, [T0[0], T1[1]]])}${poly([I0, [I1[0], I0[1]], I1, [I0[0], I1[1]]])}" fill="#10163a"/>`);
  s.push(`<path d="M${r1(I0[0] - 0.6)} ${r1(I1[1])}V${r1(I0[1] - 0.6)}H${r1(I1[0] + 0.6)}V${r1(I1[1])}" fill="none" stroke="#2a3270" stroke-width="1" stroke-opacity="0.9"/>`);
  s.push(`<path d="M${r1(T0[0])} ${r1(T1[1])}V${r1(T0[1])}H${r1(T1[0])}V${r1(T1[1])}" fill="none" stroke="#04050e" stroke-width="1.6"/>`);
  // stool: a ledge proud of the wall; we look down on its top
  const sx0 = x0 - trim - 0.04, sx1 = x1 + trim + 0.04, sz = ZB - 0.07, st = 0.03;
  s.push(`<path d="${poly([P(sx0, y0, ZB), P(sx1, y0, ZB), P(sx1, y0, sz), P(sx0, y0, sz)])}" fill="#262e62"/>`);
  s.push(`<path d="${poly([P(sx0, y0, sz), P(sx1, y0, sz), P(sx1, y0 - st, sz), P(sx0, y0 - st, sz)])}" fill="#0e1433"/>`);
  s.push(`<path d="${poly([P(x0 - trim, y0 - st, ZB), P(x1 + trim, y0 - st, ZB), P(x1 + trim, y0 - st - 0.07, ZB), P(x0 - trim, y0 - st - 0.07, ZB)])}" fill="#0d1230"/>`);
  // the stool's soft shadow on the wall below it
  const sh0 = P(sx0, y0 - st - 0.07, ZB), sh1 = P(sx1, y0 - st - 0.26, ZB);
  s.push(`<rect x="${r1(sh0[0])}" y="${r1(sh0[1])}" width="${r1(sh1[0] - sh0[0])}" height="${r1(sh1[1] - sh0[1])}" fill="#02030a" opacity="0.4" filter="url(#crBlur)"/>`);

  return s.join('\n');
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
  return `<g id="${id}"><circle r="40" fill="url(#crFrost)"/><path d="${d}" fill="none" stroke="#eef2ff" stroke-width="0.5" stroke-opacity="0.18" stroke-linecap="round"/></g>`;
}

// ───────────────────────── THE DESK (and the hero's monitor on it) ─────────────────────────
function desk() {
  const s = [];
  const { x0, z0, z1, y, t } = DESK;
  const XE = XR; // the desk runs to the right wall
  const mcx = P((MON.x0 + MON.x1) / 2, 0, MON.z)[0];
  const [mx0, my1] = P(MON.x0, MON.y1, MON.z), [mx1, my0] = P(MON.x1, MON.y0, MON.z);
  s.push(`<defs>
<linearGradient id="cdTop" x1="0" x2="0" y1="${r1(P(0, y, z1)[1])}" y2="${r1(P(0, y, z0)[1])}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#11173a"/><stop offset="1" stop-color="#1a2150"/></linearGradient>
<radialGradient id="cdPool" cx="${r1(mcx)}" cy="${r1(P(0, y, 1.28)[1])}" r="560" gradientTransform="translate(${r1(mcx)} ${r1(P(0, y, 1.28)[1])}) scale(1 0.32) translate(${r1(-mcx)} ${r1(-P(0, y, 1.28)[1])})" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4ea8ff" stop-opacity="0.34"/><stop offset="0.4" stop-color="#3d8ae0" stop-opacity="0.12"/><stop offset="1" stop-color="#3d8ae0" stop-opacity="0"/></radialGradient>
<linearGradient id="cdRefl" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#b4aee8" stop-opacity="0.2"/><stop offset="0.5" stop-color="#9c9ade" stop-opacity="0.07"/><stop offset="1" stop-color="#9c9ade" stop-opacity="0"/></linearGradient>
<linearGradient id="cdScreen" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#0d1c33"/><stop offset="1" stop-color="#050f20"/></linearGradient>
<radialGradient id="cdMonGlow" cx="0.5" cy="0.5" r="0.5"><stop offset="0.5" stop-color="#4ea8ff" stop-opacity="0.22"/><stop offset="0.75" stop-color="#4ea8ff" stop-opacity="0.07"/><stop offset="1" stop-color="#4ea8ff" stop-opacity="0"/></radialGradient>

<radialGradient id="cdShadow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#010208" stop-opacity="0.75"/><stop offset="0.6" stop-color="#010208" stop-opacity="0.3"/><stop offset="1" stop-color="#010208" stop-opacity="0"/></radialGradient>
<linearGradient id="cdMug" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#9aa3c8"/><stop offset="0.45" stop-color="#d8dcf0"/><stop offset="0.8" stop-color="#c3cdee"/><stop offset="1" stop-color="#8ea6d8"/></linearGradient>
<filter id="cdBlur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6"/></filter>
</defs>`);
  // the desk itself and the monitor's arm (hidden on tablet / phone, where the copy stacks over them)
  s.push('<g class="cx-deskbody">');
  // under the desk: deep shadow on the floor, slim legs
  const legs = [[x0 + 0.05, z0 + 0.06], [x0 + 0.05, z1 - 0.06]];
  s.push(`<path d="${poly([P(x0 - 0.1, YF, z0 + 0.1), P(XE, YF, z0 + 0.1), P(XE, YF, z1 + 0.15), P(x0 - 0.1, YF, z1 + 0.15)])}" fill="#010207" opacity="0.75" filter="url(#cdBlur)"/>`);
  for (const [lx, lz] of legs) {
    const a = P(lx - 0.02, y - t, lz), b = P(lx + 0.02, YF, lz);
    s.push(`<rect x="${r1(a[0])}" y="${r1(a[1])}" width="${r1(b[0] - a[0])}" height="${r1(b[1] - a[1])}" fill="#05071a"/>`);
  }
  // modesty panel set back under the top
  s.push(`<path d="${poly([P(x0 + 0.08, y - t, z1 - 0.12), P(XE, y - t, z1 - 0.12), P(XE, y - 0.42, z1 - 0.12), P(x0 + 0.08, y - 0.42, z1 - 0.12)])}" fill="#070a1d"/>`);
  // top surface, front edge (it catches the monitor's light)
  s.push(`<path d="${poly([P(x0, y, z0), P(XE, y, z0), P(XE, y, z1), P(x0, y, z1)])}" fill="url(#cdTop)"/>`);
  s.push(`<path d="${poly([P(x0, y, z0), P(XE, y, z0), P(XE, y, z1), P(x0, y, z1)])}" fill="url(#cdPool)"/>`);
  // the window reflected in the glossy top (mirror the glass across the desk plane), clipped to the top
  const topQuad = poly([P(x0, y, z0), P(XE, y, z0), P(XE, y, z1), P(x0, y, z1)]);
  const my0r = 2 * y - (WIN.y1 - WIN.frame), my1r = 2 * y - (WIN.y0 + WIN.frame);
  const ra = P(WIN.x0 + WIN.frame, my1r, WIN.zg), rb = P(WIN.x1 - WIN.frame, my0r, WIN.zg);
  s.push(`<clipPath id="cdTopClip"><path d="${topQuad}"/></clipPath>`);
  s.push(`<g clip-path="url(#cdTopClip)"><rect x="${r1(ra[0])}" y="${r1(ra[1])}" width="${r1(rb[0] - ra[0])}" height="${r1(rb[1] - ra[1])}" fill="url(#cdRefl)" filter="url(#cdBlur)"/></g>`);
  s.push(`<path d="${poly([P(x0, y, z0), P(XE, y, z0), P(XE, y - t, z0), P(x0, y - t, z0)])}" fill="#0b0f26"/>`);
  s.push(`<path d="${poly([P(x0, y, z0), P(XE, y, z0)], false)}" stroke="#4ea8ff" stroke-width="1.6" stroke-opacity="0.45" fill="none"/>`);
  s.push(`<path d="${poly([P(x0, y, z1), P(x0, y, z0)], false)}" stroke="#2a3672" stroke-width="1" stroke-opacity="0.8" fill="none"/>`);

  // monitor arm: a pole clamped at the desk's back edge, right of the screen, and an arm reaching
  // in behind the panel (the monitor floats at eye height, so it reads as mounted, not stranded)
  const PX = MON.x1 + 0.2, PZ = z1 - 0.06, PR = 0.017;
  const YA = MON.y0 + 0.13, YT = MON.y0 + 0.2, AH = 0.034;
  // clamp block on the desk and its contact shadow
  const cb = [P(PX - 0.05, y, PZ - 0.04), P(PX + 0.05, y, PZ + 0.05)];
  s.push(`<ellipse cx="${r1((cb[0][0] + cb[1][0]) / 2)}" cy="${r1(P(PX, y, PZ)[1] + 2)}" rx="${r1((cb[1][0] - cb[0][0]) * 0.9)}" ry="${r1(Math.abs(cb[0][1] - cb[1][1]) * 0.9 + 4)}" fill="url(#cdShadow)"/>`);
  s.push(`<path d="${poly([P(PX - 0.04, y + 0.03, PZ - 0.035), P(PX + 0.04, y + 0.03, PZ - 0.035), P(PX + 0.04, y, PZ - 0.035), P(PX - 0.04, y, PZ - 0.035)])}" fill="#0a0e22"/>`);
  s.push(`<path d="${poly([P(PX - 0.04, y + 0.03, PZ - 0.035), P(PX + 0.04, y + 0.03, PZ - 0.035), P(PX + 0.04, y + 0.03, PZ + 0.045), P(PX - 0.04, y + 0.03, PZ + 0.045)])}" fill="#151b3c"/>`);
  // the pole (round: a lit edge on the side facing the screen)
  const p0 = P(PX - PR, YT, PZ), p1 = P(PX + PR, y + 0.03, PZ);
  s.push(`<rect x="${r1(p0[0])}" y="${r1(p0[1])}" width="${r1(p1[0] - p0[0])}" height="${r1(p1[1] - p0[1])}" rx="${r1((p1[0] - p0[0]) / 2)}" fill="#11173a"/>`);
  s.push(`<rect x="${r1(p0[0] + 1)}" y="${r1(p0[1] + 3)}" width="1.6" height="${r1(p1[1] - p0[1] - 3)}" fill="#4ea8ff" opacity="0.35"/>`);
  s.push(`<rect x="${r1(p1[0] - 2.4)}" y="${r1(p0[1] + 3)}" width="1.2" height="${r1(p1[1] - p0[1] - 3)}" fill="#03040c" opacity="0.6"/>`);
  // collar + arm running in behind the monitor (the panel hides its far end)
  const c0 = P(PX - PR - 0.006, YA + 0.025, PZ), c1 = P(PX + PR + 0.006, YA - AH - 0.012, PZ);
  const ex = MON.x1 - 0.1, ez = MON.z + 0.09;
  s.push(`<path d="${poly([P(PX, YA, PZ), P(ex, YA, ez), P(ex, YA - AH, ez), P(PX, YA - AH, PZ)])}" fill="#0d1128"/>`);
  s.push(`<path d="${poly([P(PX, YA, PZ), P(ex, YA, ez)], false)}" stroke="#4ea8ff" stroke-opacity="0.3" stroke-width="1" fill="none"/>`);
  s.push(`<rect x="${r1(c0[0])}" y="${r1(c0[1])}" width="${r1(c1[0] - c0[0])}" height="${r1(c1[1] - c0[1])}" rx="2" fill="#10152f"/>`);
  s.push(`<rect x="${r1(c0[0])}" y="${r1(c0[1])}" width="${r1(c1[0] - c0[0])}" height="1.2" fill="#7ec0ff" opacity="0.3"/>`);

  s.push('</g>');

  // the monitor: same bezel and screen as the hero's, a thin side showing its depth
  s.push(`<ellipse cx="${r1(mcx)}" cy="${r1((my0 + my1) / 2)}" rx="${r1((mx1 - mx0) * 0.95)}" ry="${r1((my0 - my1) * 1.25)}" fill="url(#cdMonGlow)"/>`);
  const d = 0.035;
  s.push('<g class="cx-monitor">');
  s.push(`<path d="${poly([P(MON.x0, MON.y1, MON.z), P(MON.x0, MON.y1, MON.z + d), P(MON.x0, MON.y0, MON.z + d), P(MON.x0, MON.y0, MON.z)])}" fill="#121733"/>`);
  const bw = mx1 - mx0, bh = my0 - my1;
  s.push(`<rect x="${r1(mx0)}" y="${r1(my1)}" width="${r1(bw)}" height="${r1(bh)}" rx="${r1(bw * 0.022)}" fill="#0a0d13"/>`);
  const pad = bw * 0.027;
  const sx = mx0 + pad, sy = my1 + pad, sw = bw - 2 * pad, shh = bh - 2 * pad;
  s.push(`<rect x="${r1(sx)}" y="${r1(sy)}" width="${r1(sw)}" height="${r1(shh)}" rx="${r1(bw * 0.01)}" fill="url(#cdScreen)"/>`);
  // the hero's code lines + chart, scaled into this screen (same monitor, end of the day)
  const k = sw / 568;
  const H = (x, yv) => [sx + (x - 516) * k, sy + (yv - 296) * k];
  const lines = [[540, 320, 120, '#4ea8ff', 0.8], [540, 340, 220, '#7ec0ff', 0.45], [560, 360, 180, '#4ea8ff', 0.6], [560, 380, 240, '#7ec0ff', 0.38], [580, 400, 160, '#4ea8ff', 0.65], [540, 430, 200, '#7ec0ff', 0.42], [540, 450, 280, '#4ea8ff', 0.55], [560, 470, 140, '#7ec0ff', 0.45], [540, 500, 240, '#4ea8ff', 0.65], [560, 520, 180, '#7ec0ff', 0.38], [540, 550, 160, '#4ea8ff', 0.5], [560, 570, 220, '#7ec0ff', 0.35]];
  s.push(`<g>${lines.map(([lx, ly, lw, c, o]) => { const [ax, ay] = H(lx, ly); return `<rect x="${r1(ax)}" y="${r1(ay)}" width="${r1(lw * k)}" height="${r1(8 * k)}" fill="${c}" opacity="${o}"/>`; }).join('')}</g>`);
  const [cx0, cy0] = H(860, 320);
  s.push(`<rect x="${r1(cx0)}" y="${r1(cy0)}" width="${r1(200 * k)}" height="${r1(180 * k)}" fill="#0a1426" stroke="#4ea8ff" stroke-opacity="0.4" stroke-width="1"/>`);
  s.push(`<polyline points="${[[870, 470], [900, 440], [930, 450], [960, 400], [990, 420], [1020, 360], [1050, 380]].map(([a, b]) => pt(H(a, b))).join(' ')}" fill="none" stroke="#4ea8ff" stroke-width="${r1(2 * k * 1.2)}" opacity="0.85"/>`);
  // a cursor blinking-still at the end of a line, and a faint screen sheen
  const [cux, cuy] = H(724, 548);
  s.push(`<rect x="${r1(cux)}" y="${r1(cuy)}" width="${r1(3 * k)}" height="${r1(12 * k)}" fill="#cfe6ff" opacity="0.8"/>`);
  s.push(`<path d="${poly([[sx, sy], [sx + sw * 0.42, sy], [sx + sw * 0.2, sy + shh], [sx, sy + shh]])}" fill="#ffffff" opacity="0.025"/>`);
  s.push(`<rect x="${r1(mx0)}" y="${r1(my1)}" width="${r1(bw)}" height="1.4" fill="#7ec0ff" opacity="0.22"/>`);
  s.push('</g>');

  // props (hidden on tablet / phone, where they would sit behind the copy)
  s.push('<g class="cx-props">');
  // keyboard in front of the monitor (mostly behind the note on desktop)
  const ka = MON.x0 + 0.06, kz = MON.x0 + 0.56;   // centred under the screen
  const kb = [P(ka, y + 0.012, 1.08), P(kz, y + 0.012, 1.08), P(kz, y + 0.012, 1.24), P(ka, y + 0.012, 1.24)];
  s.push(`<path d="${poly([P(ka, y, 1.08), P(kz, y, 1.08), P(kz, y, 1.24), P(ka, y, 1.24)])}" fill="#010208" opacity="0.5" filter="url(#cdBlur)"/>`);
  s.push(`<path d="${poly(kb)}" fill="#080b1a"/><path d="${poly([kb[0], kb[1]], false)}" stroke="#4ea8ff" stroke-opacity="0.35" stroke-width="1" fill="none"/>`);

  // notebook + pen lying on the desk under the window (perspective quads), mug with steam
  const nb = [P(0.08, y + 0.008, 1.12), P(0.4, y + 0.008, 1.1), P(0.42, y + 0.008, 1.36), P(0.1, y + 0.008, 1.38)];
  s.push(`<path d="${poly([P(0.06, y, 1.14), P(0.44, y, 1.12), P(0.46, y, 1.4), P(0.08, y, 1.42)])}" fill="#010208" opacity="0.55" filter="url(#cdBlur)"/>`);
  s.push(`<path d="${poly(nb)}" fill="#b9c0e2"/>`);
  s.push(`<path d="${poly([nb[3], nb[0], P(0.08, y + 0.008, 1.12), P(0.12, y + 0.008, 1.38)])}" fill="#4ea8ff"/>`);
  let ruled = '';
  for (let i = 1; i < 6; i++) { const zz = 1.12 + 0.04 * i; ruled += poly([P(0.16, y + 0.009, zz), P(0.38, y + 0.009, zz - 0.004)], false); }
  s.push(`<path d="${ruled}" stroke="#55628f" stroke-width="0.8" stroke-opacity="0.6" fill="none"/>`);
  s.push(`<path d="${poly([P(0.2, y + 0.02, 1.06), P(0.44, y + 0.02, 1.0)], false)}" stroke="#05071a" stroke-width="4.5" stroke-linecap="round" fill="none"/>`);
  // the mug (the hero's, now a little colder in the evening light)
  const mz = 1.3, mxc = -0.05, mr = 0.045, mh = 0.1;
  const [mcx2, mby] = P(mxc, y, mz), [, mty] = P(mxc, y + mh, mz);
  const mw = (F * mr) / mz;
  s.push(`<ellipse cx="${r1(mcx2 + 4)}" cy="${r1(mby + 2)}" rx="${r1(mw * 1.6)}" ry="${r1(mw * 0.45)}" fill="url(#cdShadow)"/>`);
  s.push(`<path d="M${r1(mcx2 + mw)} ${r1(mty + (mby - mty) * 0.22)}q${r1(mw * 0.8)} ${r1((mby - mty) * 0.08)} ${r1(mw * 0.8)} ${r1((mby - mty) * 0.32)}t${r1(-mw * 0.8)} ${r1((mby - mty) * 0.32)}" fill="none" stroke="#a7b3df" stroke-width="${r1(mw * 0.22)}"/>`);
  s.push(`<path d="M${r1(mcx2 - mw)} ${r1(mty)}V${r1(mby - mw * 0.14)}a${r1(mw)} ${r1(mw * 0.28)} 0 0 0 ${r1(2 * mw)} 0V${r1(mty)}Z" fill="url(#cdMug)"/>`);
  s.push(`<ellipse cx="${r1(mcx2)}" cy="${r1(mty)}" rx="${r1(mw)}" ry="${r1(mw * 0.28)}" fill="#e3e7f7"/><ellipse cx="${r1(mcx2)}" cy="${r1(mty + 0.8)}" rx="${r1(mw * 0.86)}" ry="${r1(mw * 0.22)}" fill="#2a1d18"/>`);
  s.push(`<g fill="none" stroke="#dfe6ff" stroke-linecap="round"><path d="M${r1(mcx2 - mw * 0.3)} ${r1(mty - 6)}q${r1(-mw * 0.25)} -14 ${r1(mw * 0.06)} -26t${r1(-mw * 0.06)} -26" stroke-width="1.6" opacity="0.32"/><path d="M${r1(mcx2 + mw * 0.25)} ${r1(mty - 6)}q${r1(mw * 0.25)} -16 ${r1(-mw * 0.06)} -30t${r1(mw * 0.1)} -26" stroke-width="1.4" opacity="0.24"/></g>`);
  s.push('</g>');
  return s.join('\n');
}

// ───────────────────────── a few motes in the monitor's light (foreground) ─────────────────────────
function fore() {
  const R = rng(5);
  const [mx] = P((MON.x0 + MON.x1) / 2, 0, MON.z);
  let d = '';
  for (let i = 0; i < 16; i++) {
    const x = mx - 380 + R() * 620, y = 240 + R() * 520;
    d += `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(0.8 + R() * 1.4)}" opacity="${(0.25 + R() * 0.4).toFixed(2)}"/>`;
  }
  return `<g fill="#bfe0ff">${d}</g>`;
}

// ───────────────────────── write index.html ─────────────────────────
const v = view();
const pct = (n) => `${Math.round(n * 1000) / 1000}`;
const winVars = `--gx:${pct(GLASS.x)};--gy:${pct(GLASS.y)};--gw:${pct(GLASS.w)};--gh:${pct(GLASS.h)}`;
const ART = 'viewBox="0 0 1600 1000" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"';
const ind = (n, t) => t.split('\n').map((l) => ' '.repeat(n) + l).join('\n');
const block = `            <!-- CONTACT ROOM: generated by tools/contact-room-art.mjs (do not edit by hand; edit the tool and re-run it).
                 The office at the end of the day: a panelled room with real depth from the monitor (right) back to the
                 back wall, and a recessed window slightly left of centre onto a snowy range at blue hour.
                 contact.css fits the 1600x1000 art frame (.cx-art) to the screen; contact-window.js adds the falling snow. -->
            <div class="contact-layer contact-layer--room" data-parallax="0.06">
              <div class="layer-inner" data-mouse="4">
                <div class="cx-art">
                  <div class="cx-window" style="${winVars}">
                    <div class="cx-view" data-parallax="0.04">
                      <div class="cx-view__drift" data-mouse="-7">
                        <svg class="cx-view__art" viewBox="${v.vb.x} ${v.vb.y} ${v.vb.w} ${v.vb.h}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" data-twinkle="${v.twinkle.map(([x, y]) => `${x},${y}`).join(' ')}">
${ind(26, v.svg)}
                        </svg>
                      </div>
                    </div>
                  </div>
                  <svg class="cx-room" ${ART}>
${ind(20, room())}
                  </svg>
                </div>
              </div>
            </div>
            <div class="contact-layer contact-layer--desk" data-parallax="-0.04">
              <div class="layer-inner" data-mouse="10">
                <div class="cx-art">
                  <svg class="cx-desk" ${ART}>
${ind(20, desk())}
                  </svg>
                </div>
              </div>
            </div>
            <div class="contact-layer contact-layer--fore" data-parallax="-0.1" data-contact-mobile-hide>
              <div class="layer-inner" data-mouse="18">
                <div class="cx-art">
                  <svg class="cx-fore" ${ART}>
${ind(20, fore())}
                  </svg>
                </div>
              </div>
            </div>
            <!-- /CONTACT ROOM -->
`;

const INDEX = fileURLToPath(new URL('../index.html', import.meta.url));
const html = readFileSync(INDEX, 'utf8');
let start = html.search(/^ *<!-- CONTACT ROOM:/m);
let end = html.search(/^ *<!-- \/CONTACT ROOM -->\n/m);
if (start >= 0 && end > start) {
  end += html.slice(end).indexOf('\n') + 1;
} else {
  // first run: replace the old placeholder layers inside .contact__stage
  const st = html.indexOf('<div class="contact__stage" aria-hidden="true">');
  const wrap = html.indexOf('<div class="contact__wrap">', st);
  if (st < 0 || wrap < 0) throw new Error('index.html: contact stage not found');
  start = html.indexOf('\n', st) + 1;
  // the stage's own closing tag sits on the line before .contact__wrap
  end = html.lastIndexOf('\n', html.lastIndexOf('</div>', wrap)) + 1;
}
writeFileSync(INDEX, html.slice(0, start) + block + html.slice(end));
console.log(`contact room written to index.html (glass ${r1(GLASS.x)},${r1(GLASS.y)} ${r1(GLASS.w)}x${r1(GLASS.h)}; view ${v.vb.w}x${v.vb.h}, horizon ${v.HZ})`);
console.log('monitor (side face to bezel)', [r1(P(MON.x0, 0, MON.z + 0.035)[0]), r1(P(0, MON.y1, MON.z)[1])], P(MON.x1, MON.y0, MON.z).map(r1), 'back wall', P(XL, YC, ZB).map(r1), P(XR, YF, ZB).map(r1));
// contact.css keeps the copy and the note clear of these (.contact__wrap --win-l / --win-r / --win-b)
const sx0 = P(WIN.x0 - 0.07 - 0.04, 0, ZB)[0], sx1 = P(WIN.x1 + 0.07 + 0.04, 0, WIN.zg)[0];
console.log(`window outer, art units: left ${Math.floor(P(WIN.x0 - 0.11, 0, ZB - 0.07)[0])}, right ${Math.ceil(P(WIN.x1 + 0.11, 0, ZB - 0.07)[0])}, bottom ${Math.ceil(P(0, WIN.y0 - 0.03 - 0.26, ZB)[1])} (stool shadow), top ${Math.floor(P(0, WIN.y1 + 0.07, ZB)[1])}`);
