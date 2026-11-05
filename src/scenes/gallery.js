import { ScrollTrigger } from 'gsap/ScrollTrigger';

/**
 * Scene 3 — Horizontal Gallery (Project Rooms)
 *
 * Default markup is a vertical stack of <article class="room">. On
 * capable devices we add .gallery--horizontal: the section grows tall,
 * its inner stage sticks to the viewport (plain CSS sticky — no JS pin,
 * so nothing jumps when it engages) and vertical scroll pans the rooms
 * sideways.
 *
 * The picture is a pure function of the scroll position (render):
 *   - the rooms track moves 1:1 with the scroll;
 *   - the corner is a quarter-circle in velocity: over the last stretch
 *     of the approach the rooms' upward motion bends into the sideways
 *     pan at the same speed, so there is no stop and no lurch. The exit
 *     into Selected Work bends back the same way (with a radius small
 *     enough that the last room's text never crosses the screen edge),
 *     and both run in reverse;
 *   - while the gallery rises over the Dive's last frame it is see-through
 *     and fades in its backdrop together with the Dive's copy of it, so
 *     both sides of the rising edge always show the same picture.
 *
 * How the page moves through it is decided by a small controller, the
 * same idea on desktop (Lenis wheel) and phones (native touch): inside
 * the gallery the page only comes to rest on a "station" — the corner's
 * start, a room, or the corner's end. One gesture moves one station, as
 * one glide that starts at the speed the page already has and lands
 * exactly (never past it and back) — on desktop our own glide, on phones
 * the browser's own fling landing on CSS snap points (a hard flick the
 * finger has already dragged past a room lands on the next). A gesture
 * coming in from outside is landed on the first room it meets; a gesture
 * going out past an end station turns back into plain scrolling. A wheel
 * kept spinning walks on, room by room, straight through the corner.
 * Links and hash loads to the gallery land on its first room. Content
 * reveals once per room on arrival — time-based, never tied to scroll,
 * so text is never ghosted.
 *
 * Under prefers-reduced-motion the page keeps the vertical stack.
 */

const HALF_PI = Math.PI / 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Velocity-matched glide curve: starts at slope m0 (the speed the page
// already has, as a fraction of distance / duration), ends at rest with
// zero acceleration. m0 = 0 is smootherstep, m0 = 2 a pure, smooth
// deceleration; m0 < 0 (the page was moving the other way) first carries
// on a little before coming back.
const settleEase = (t, m0) =>
  m0 * t + (10 - 6 * m0) * t ** 3 + (8 * m0 - 15) * t ** 4 + (6 - 3 * m0) * t ** 5;
const MAX_M0 = 2;
const MIN_M0 = -1.5;
// the curve's top speed, as a multiple of distance / duration
const peakOf = (m0) => {
  let p = 0;
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    p = Math.max(p, m0 + 3 * (10 - 6 * m0) * u * u + 4 * (8 * m0 - 15) * u ** 3 + 5 * (6 - 3 * m0) * u ** 4);
  }
  return p;
};

const REVEAL_SEL =
  '.room__number, .room__heading, .room__lead, ' +
  '.room__chips > *, .room__cards > *, .room__timeline > *, .room__columns';

export function initGallery({ reducedMotion, lenis }) {
  const scene = document.querySelector('[data-scene="gallery"]');
  if (!scene || reducedMotion) return;

  const inner = scene.querySelector('.gallery__inner');
  const bg    = scene.querySelector('.gallery__bg');
  const bgArt = bg ? bg.querySelector('svg') : null;
  const track = scene.querySelector('.gallery__track');
  const rooms = [...scene.querySelectorAll('.room')];
  const progress = scene.querySelector('.gallery__progress');
  const cue   = scene.querySelector('.gallery__cue');
  if (!inner || !track || rooms.length === 0) return;
  // The Dive's copy of this backdrop (dive.js): faded in together with ours.
  const handoff = document.querySelector('[data-scene="dive"] .dive__handoff');

  scene.classList.add('gallery--horizontal');
  const N = rooms.length;

  // Scroll px per room, as a multiple of the room width. 1 = the pan moves
  // exactly as fast as the page did, which keeps the corner a true circle.
  let ROOM_SCROLL = 1;
  if (import.meta.env.DEV) {
    const r = parseFloat(new URLSearchParams(location.search).get('groom'));
    if (r > 0) ROOM_SCROLL = r;
  }

  rooms.forEach((room) => {
    room.querySelectorAll(REVEAL_SEL).forEach((el, i) => el.style.setProperty('--reveal-i', i));
  });
  const layers = rooms.map((room) =>
    [...room.querySelectorAll('[data-parallax]')].map((el) => ({ el, f: parseFloat(el.dataset.parallax) || 0 })),
  );

  let steer = null;
  const goTo = (station) => steer && steer.goTo(station);

  // ── progress dots → buttons that go to their room ──────────────
  let dots = [];
  if (progress) {
    dots = [...progress.querySelectorAll('.gallery__progress-dot')].map((old, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = old.className;
      btn.dataset.room = old.dataset.room || String(i + 1);
      const label = (rooms[i]?.querySelector('.room__number')?.textContent || '').split('·').pop().trim();
      btn.setAttribute('aria-label', `Room ${i + 1} of ${N}${label ? `: ${label}` : ''}`);
      btn.addEventListener('click', () => goTo(i + 1));
      old.replaceWith(btn);
      return btn;
    });
    progress.removeAttribute('aria-hidden');
    progress.setAttribute('role', 'group');
    progress.setAttribute('aria-label', 'Story rooms');
  }

  /* ── fit: a room whose content is taller than the screen is scaled to
     fit (around its own centre) rather than clipped or made scrollable.
     Also measures how far each room's text sits from its edges. ─────── */
  const contents = rooms.map((room) => room.querySelector('.room__content'));
  const fit = rooms.map(() => ({ s: 1, dx: 0 }));
  const margin = rooms.map(() => ({ left: 0, right: 0 }));
  function fitRooms() {
    contents.forEach((el, i) => {
      if (!el) return;
      el.style.transform = '';
      fit[i].s = 1;
      fit[i].dx = 0;
      const kids = [...el.children];
      if (!kids.length) return;
      const roomBox = rooms[i].getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const rs = kids.map((k) => k.getBoundingClientRect());
      margin[i].left = Math.min(...rs.map((r) => r.left)) - roomBox.left;
      margin[i].right = roomBox.right - Math.max(...rs.map((r) => r.right));
      const top = Math.min(...rs.map((r) => r.top));
      const bottom = Math.max(...rs.map((r) => r.bottom));
      const cs = getComputedStyle(el);
      const avail = box.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const h = bottom - top;
      if (h <= avail + 1) return;
      const s = Math.max(0.7, avail / h);
      fit[i].s = s;
      el.style.transformOrigin = `0 ${((top + bottom) / 2 - box.top).toFixed(1)}px`;
      el.style.transform = `scale(${s.toFixed(4)})`;
    });
  }
  // Sideways nudge of a room's text against its room (see render).
  function shiftContent(i, dx) {
    const el = contents[i];
    if (!el) return;
    dx = Math.round(dx * 10) / 10;
    if (dx === fit[i].dx) return;
    fit[i].dx = dx;
    const sc = fit[i].s < 1 ? `scale(${fit[i].s.toFixed(4)})` : '';
    el.style.transform = dx ? `translate3d(${dx}px, 0, 0) ${sc}` : sc;
  }

  /* ── geometry ───────────────────────────────────────────────
     s = scroll − top, where top is the scroll at which the stage sticks.
       corner in   s ∈ [−aIn, bIn]          rooms rise aIn px while drifting k·aIn px left
       room i      s = bIn + i·D            (the rests)
       corner out  s ∈ [sN, sN + LcOut]     rise aOut px while drifting k·aOut px left
     A quarter circle with unit speed covers a px vertically in Lc = π·a/2
     of scroll, so b = Lc − a; the stage stays stuck for run = bIn + (N−1)·D + bOut.
     The exit radius is sized so the last room's text never crosses the
     left edge; where even that is too much (phones) the text is held
     back against its room instead (render). */
  const G = { top: 0, W: 0 };
  function measure() {
    const W = rooms[0].offsetWidth || window.innerWidth;
    const H = window.innerHeight;
    const D = Math.round(W * ROOM_SCROLL);
    const k = W / D;
    fitRooms();
    const aIn = Math.round(Math.min(H * 0.24, W * 0.18));
    const textL = margin[N - 1].left;
    // where even 0.6·aIn would cut the text (phones: it fills the width)
    // the text is held back against its room instead, so keep the full curve
    const fitOut = (textL - 12) / k;
    const aOut = Math.round(fitOut >= 0.6 * aIn ? Math.min(aIn, fitOut) : aIn);
    const bIn = Math.round(aIn * (HALF_PI - 1));
    const bOut = Math.round(aOut * (HALF_PI - 1));
    const sN = bIn + (N - 1) * D;
    const run = sN + bOut;
    Object.assign(G, {
      W, H, D, k, aIn, bIn, LcIn: aIn + bIn, aOut, bOut, LcOut: aOut + bOut, sN, run,
      roomR: Math.max(0, margin[0].right - 8), // px the first room's text may drift right
      roomL: Math.max(0, textL - 12),          // px the last room's text may drift left
    });
    scene.style.setProperty('--gallery-run', `${run}px`);
    // the first room's rest is bIn below the section's top: a jump to the
    // section (#story, a hash load) lands on it, not in the corner
    scene.style.setProperty('--gallery-entry', `${bIn}px`);
  }

  // Stations, in page scroll px: 0 = the entry corner's start, 1..N the
  // rooms, N + 1 = the exit corner's end. 0 and N + 1 are "soft": a gesture
  // that keeps going past them just scrolls on.
  const restOf = (i) => G.top + G.bIn + i * G.D;
  function stations() {
    const S = [G.top - G.aIn];
    for (let i = 0; i < N; i++) S.push(restOf(i));
    S.push(G.top + G.sN + G.LcOut);
    return S;
  }
  const C = {
    G, N, stations, scene,
    isSoft: (i) => i === 0 || i === N + 1,
    inside: (p) => { const S = stations(); return p >= S[0] - 1 && p <= S[N + 1] + 1; },
    atStation: (p) => stations().some((v) => Math.abs(v - p) < 1.5),
    // first station strictly beyond p in direction dir (null: none)
    after(p, dir) {
      const S = stations();
      if (dir > 0) { for (let i = 0; i < S.length; i++) if (S[i] > p + 1.5) return i; }
      else { for (let i = S.length - 1; i >= 0; i--) if (S[i] < p - 1.5) return i; }
      return null;
    },
    // first station at or beyond p in direction dir
    atOrAfter(p, dir) {
      const S = stations();
      if (dir > 0) { for (let i = 0; i < S.length; i++) if (S[i] >= p - 1.5) return i; }
      else { for (let i = S.length - 1; i >= 0; i--) if (S[i] <= p + 1.5) return i; }
      return null;
    },
    // glide length: one room ≈ 0.95 s, shorter hops quicker
    slideT: (dist) => 0.55 + 0.4 * Math.min(1.25, Math.abs(dist) / G.D),
    refreshing: false,
  };

  /* ── render: everything is a pure function of the scroll ───── */
  let active = -1;
  let lastZone = NaN;
  const revealed = new Set();
  const styleCache = new WeakMap();
  const set = (el, prop, value) => {
    if (!el) return;
    let c = styleCache.get(el);
    if (!c) { c = {}; styleCache.set(el, c); }
    if (c[prop] === value) return;
    c[prop] = value;
    el.style[prop] = value;
  };
  function render(y) {
    const { W, H, k, aIn, bIn, LcIn, aOut, LcOut, sN, run } = G;
    if (!W) return;
    const s = y - G.top;
    // Far above or below nothing changes: draw that state once, then skip.
    const zone = s < -1.6 * H ? -1 : (s > run + 1.6 * H ? 1 : 0);
    if (zone !== 0 && zone === lastZone) return;
    lastZone = zone;

    const innerTop = s < 0 ? -s : (s > run ? run - s : 0);
    let x, ty;
    if (s <= -aIn) { x = k * aIn; ty = 0; }
    else if (s < bIn) {
      const th = ((s + aIn) / LcIn) * HALF_PI;
      x = k * aIn * Math.cos(th);
      ty = aIn * (1 - Math.sin(th)) - innerTop;
    } else if (s <= sN) { x = -k * (s - bIn); ty = 0; }
    else if (s < sN + LcOut) {
      const th = ((s - sN) / LcOut) * HALF_PI;
      x = -(N - 1) * W - k * aOut * Math.sin(th);
      ty = -aOut * (1 - Math.cos(th)) - innerTop;
    } else { x = -(N - 1) * W - k * aOut; ty = 0; }
    set(track, 'transform', `translate3d(${x.toFixed(2)}px, ${ty.toFixed(2)}px, 0)`);

    // Where a corner's sideways drift would push a room's text past the
    // screen edge (phones: the text fills the width), the text holds back
    // against its room; the room itself still takes the full curve.
    const lastLeft = (N - 1) * W + x;
    const in0 = x > G.roomR ? G.roomR - x : 0;
    const inN = -lastLeft > G.roomL ? -lastLeft - G.roomL : 0;
    if (N > 1) { shiftContent(0, in0); shiftContent(N - 1, inN); }
    else shiftContent(0, in0 + inN);

    // Backdrop. While the gallery rises over the Dive's last frame it is
    // see-through; its backdrop (base colour + grid, one layer) fades in
    // at exactly the same rate as the Dive's copy of it, so above and
    // below the rising edge the picture is identical at every moment. The
    // grid dims out as Selected Work rises (same base colour).
    const holdA = smoothstep(-0.7 * H, -0.15 * H, s);
    const dim = smoothstep(sN + 0.3 * LcOut, run + 0.35 * H, s);
    set(bg, 'opacity', holdA.toFixed(3));
    set(handoff, 'opacity', holdA.toFixed(3));
    set(bgArt, 'opacity', (0.7 * (1 - dim)).toFixed(3));

    // Dots and cue come in once the corner has turned; the cue goes as
    // the last room arrives (nothing further to the right).
    const hudOn = Math.min(smoothstep(-0.25 * aIn, bIn, s), 1 - smoothstep(sN, sN + 0.6 * LcOut, s));
    set(progress, 'opacity', hudOn.toFixed(3));
    set(progress, 'pointerEvents', hudOn > 0.6 ? 'auto' : 'none');
    const cueOn = hudOn * (1 - smoothstep(sN - 0.6 * G.D, sN - 0.2 * G.D, s));
    set(cue, 'opacity', cueOn.toFixed(3));

    // Per-room parallax: layers drift against the pan while a room crosses.
    rooms.forEach((room, i) => {
      const L = i * W + x;
      if (L <= -W || L >= W) return;
      layers[i].forEach(({ el, f }) => set(el, 'transform', `translate3d(${(-f * 0.5 * L).toFixed(2)}px, 0, 0)`));
      if (!revealed.has(i)) {
        const onScreenY = innerTop + ty;
        if (L < 0.72 * W && onScreenY < 0.8 * H && onScreenY > -0.8 * H) {
          revealed.add(i);
          room.classList.add('is-revealed');
        }
      }
    });

    const idx = clamp(Math.round(-x / W), 0, N - 1);
    if (idx !== active) {
      active = idx;
      dots.forEach((d, j) => {
        d.classList.toggle('is-active', j === idx);
        if (j === idx) d.setAttribute('aria-current', 'true');
        else d.removeAttribute('aria-current');
      });
      scene.classList.toggle('is-last-room', idx === N - 1);
    }
  }

  const scrollPos = () => (lenis ? lenis.animatedScroll : window.scrollY);
  // Render straight from the scroll source: Lenis emits after it has set
  // the scroll (wheel glides and native scrolls alike), so the picture is
  // never a frame behind or one event stale.
  if (lenis) lenis.on('scroll', () => render(lenis.animatedScroll));
  else window.addEventListener('scroll', () => render(window.scrollY), { passive: true });

  measure();

  // A refresh (resize, rotation, fonts) re-lays the page out, so the same
  // scroll offset would land somewhere else: remember where in the
  // gallery the page was (or the station it was gliding to) and put it
  // back there.
  let keep = null;
  const jumpTo = (y) => {
    if (lenis) lenis.scrollTo(y, { immediate: true, force: true });
    else window.scrollTo({ top: y, behavior: 'instant' });
  };
  ScrollTrigger.addEventListener('refreshInit', () => {
    C.refreshing = true;
    keep = null;
    if (G.W) {
      const S = stations();
      const p = (steer && steer.target()) ?? scrollPos();
      if (p >= S[0] - 1 && p <= S[N + 1] + 1) {
        let i = 0;
        while (i < N && p > S[i + 1]) i++;
        let f = clamp((p - S[i]) / (S[i + 1] - S[i]), 0, 1);
        if (f < 0.03) f = 0;      // on (or a hair off) a station: back onto it exactly
        else if (f > 0.97) f = 1;
        keep = { i, f };
      }
    }
    if (steer) steer.cancel();
    measure();
  });
  const st = ScrollTrigger.create({
    trigger: scene,
    start: 'top top',
    end: 'bottom bottom',
    onRefresh: (self) => { G.top = self.start; },
  });
  ScrollTrigger.addEventListener('refresh', () => {
    C.refreshing = false;
    G.top = st.start;
    if (keep) {
      const S = stations();
      const y = S[keep.i] + keep.f * (S[keep.i + 1] - S[keep.i]);
      keep = null;
      if (Math.abs(y - scrollPos()) > 0.5) jumpTo(y);
    }
    lastZone = NaN;
    render(scrollPos());
    if (steer && steer.layout) steer.layout();
  });
  G.top = st.start;
  render(scrollPos());

  steer = lenis ? wheelSteer(lenis, C) : touchSteer(C);

  // Keyboard: arrows, Page Up / Down and Space step one station while the
  // page is in the gallery; past the end stations the keys scroll the page.
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === ' ' && t && t.closest && t.closest('button, a, [role="button"]')) return;
    let dir = 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) dir = 1;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) dir = -1;
    if (!dir || (e.shiftKey && e.key !== ' ')) return;
    if (steer.step(dir)) e.preventDefault();
  });

  // A link to the gallery lands on its first room, in one glide (the
  // generic anchor scroll would stop 20 px short of it, in the corner).
  if (scene.id) {
    const href = `#${scene.id}`;
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || a.getAttribute('href') !== href) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      steer.cancel();
      const y = restOf(0);
      if (lenis) lenis.scrollTo(y, { duration: 1.6, easing: (t) => 1 - Math.pow(1 - t, 3), force: true });
      else window.scrollTo({ top: y, behavior: 'smooth' });
    });
  }

  // Tabbing into a room that isn't on screen brings it in.
  scene.addEventListener('focusin', (e) => {
    const j = rooms.findIndex((r) => r.contains(e.target));
    inner.scrollLeft = 0;
    if (j >= 0 && j !== active) goTo(j + 1);
  });

  if (import.meta.env.DEV) {
    window.__galleryRests = () => rooms.map((_, i) => restOf(i));
    window.__galleryStations = stations;
    window.__galleryGeom = () => ({ ...G });
  }
}

/* ── desktop: Lenis wheel ──────────────────────────────────────────
   Every wheel event is decided as it arrives (Lenis' virtualScroll hook):
   in free scrolling Lenis moves the page as usual; inside the gallery the
   event starts — or is absorbed by — a glide to the next station. A glide
   starts at the speed the page already has (read from Lenis' own running
   ease), so taking over from Lenis, handing back to it, and changing a
   glide's destination are all seamless. A wheel kept turning walks on
   from room to room — straight on from the corner too — at about the speed
   it is turned; a deliberate tick once the page rests always moves. */
function wheelSteer(lenis, C) {
  const { N } = C;
  const GAP_NOTCH = 420;      // ms between wheel notches that starts a new gesture (a turning wheel is uneven)
  const GAP_PAD = 260;        // … between small (trackpad) deltas
  const QUIET = 170;          // ms without input before a stray rest is settled
  const QUIET_NATIVE = 220;   // the same after native scrolling (scrollbar, find, focus)
  const LANDING = 150;        // ms before a glide lands from which a deliberate tick moves on
  const TICK_GAP = 200;       // ms since the last notch that makes a tick deliberate (not a spin)
  const dur = lenis.options.duration || 1;
  const ease = lenis.options.easing;
  const slope0 = typeof ease === 'function' ? Math.max(1, (ease(0.002) - ease(0)) / 0.002) : 6.9;
  // Lenis' wheel ease starts at (target − scroll) × slope0 / duration px/s.
  const CARRY = dur / slope0;
  const now = () => performance.now();

  let g = null;        // the current gesture (a burst of wheel events)
  let glide = null;    // our running glide
  let timer = 0;
  let held = false;
  let lastInput = -1e9;
  let lastDir = 1;
  let gid = 0;
  const hist = [];

  // The page's speed now (px/s): from Lenis' running ease (exact for its
  // own wheel eases and for our glides), else from the last frames.
  function velocity() {
    const a = lenis.animate;
    if (a && a.isRunning && a.duration && typeof a.easing === 'function') {
      const u = clamp(a.currentTime / a.duration, 0, 1);
      const u0 = Math.max(0, u - 0.003);
      const u1 = Math.min(1, u + 0.003);
      if (u1 > u0) return ((a.to - a.from) * (a.easing(u1) - a.easing(u0))) / (u1 - u0) / a.duration;
    }
    const t = now();
    if (hist.length < 2 || t - hist[hist.length - 1][0] > 60) return 0;
    const [t1, p1] = hist[Math.max(0, hist.length - 4)];
    const [t2, p2] = hist[hist.length - 1];
    return t2 > t1 ? ((p2 - p1) / (t2 - t1)) * 1000 : 0;
  }

  const log = import.meta.env.DEV ? (window.__steerLog = []) : null;
  const note = (...a) => { if (log) log.push([Math.round(now()), ...a]); };

  // cap: the most speed (px/s) the glide may build up on the way (0: none)
  function plan(idx, kind, seed = 0, cap = 0) {
    const to = C.stations()[idx];
    const P = lenis.animatedScroll;
    const X = to - P;
    const dist = Math.abs(X);
    if (dist < 0.5) { glide = null; return; }
    const dir = Math.sign(X);
    let v = velocity() * dir;
    if (seed > v) v = seed; // a wheel notch's own kick, as Lenis would give it
    let T = C.slideT(dist);
    // Landing a page that comes in from outside: one long, smooth
    // deceleration from the speed it has (no speeding up, no stop short).
    if (kind === 'capture' && v > 0) T = clamp((MAX_M0 * dist) / v, T, Math.max(T, 0.85));
    let m0 = (v * T) / dist;
    if (m0 > MAX_M0) { T = Math.max(0.18, (MAX_M0 * dist) / v); m0 = Math.min(MAX_M0, (v * T) / dist); }
    m0 = Math.max(MIN_M0, m0);
    // capped: take longer rather than speed up past it
    for (let k = 0; cap > 0 && k < 4; k++) {
      const peak = (peakOf(m0) * dist) / T;
      if (peak <= cap * 1.02 || T >= 2.4) break;
      T = Math.min(2.4, (T * peak) / cap);
      m0 = clamp((v * T) / dist, MIN_M0, MAX_M0);
    }
    const t0 = now();
    // g: the gesture that called it — the rest of that gesture belongs to
    // this glide even after it has landed (one gesture, one station).
    const me = { idx, to, dir, kind, soft: C.isSoft(idx), t0, T, X, v0: Math.max(0, v), tEnd: t0 + T * 1000, absorbed: 0, g: g ? g.id : 0, done: false };
    note('plan', kind, idx, Math.round(P), Math.round(v), +T.toFixed(3), +m0.toFixed(2));
    glide = me;
    lenis.targetScroll = P; // never equal to `to`, so Lenis always runs the ease
    lenis.scrollTo(to, {
      duration: T,
      easing: (u) => settleEase(u, m0),
      force: true,
      onComplete: () => { me.done = true; },
    });
  }
  const running = () => !!glide && !glide.done;

  // Back to plain Lenis scrolling, at the speed the page has now: Lenis'
  // next ease (this very event) starts from this target.
  function release() {
    const v = velocity();
    note('release', Math.round(lenis.animatedScroll), Math.round(v));
    glide = null;
    lenis.targetScroll = lenis.animatedScroll + v * CARRY;
  }

  function rate(t, win = 450) {
    let s = 0;
    for (const [ti, a] of g.ev) if (ti > t - win) s += a;
    return s / (win / 1000);
  }
  // A wheel still turning steadily (not a trackpad's decaying tail).
  const sustained = (t) => !!g && g.n >= 3 && t - g.last < 200 && rate(t) >= Math.max(250, 0.4 * g.peakRate);
  // A trackpad swipe begun while the last one's momentum tail still runs:
  // after the tail has decayed, the deltas climb well back up (two in a row).
  function swipeAgain(ad) {
    if (!g || g.ev.length < 8) return false;
    // the tail since the peak (never the swipe's own ramp-up)
    let k = 0;
    g.ev.forEach((e, j) => { if (e[1] >= g.ev[k][1]) k = j; });
    const tail = g.ev.slice(k + 1, -1);
    if (tail.length < 4) return false;
    const prev = g.ev[g.ev.length - 1][1];
    const floor = Math.min(...tail.map((e) => e[1]));
    const rise = 2.5 * floor + 3;
    return floor <= 0.45 * g.peakD && ad >= rise && prev >= rise;
  }
  const kick = (ad) => ad / CARRY;

  function walkDue(t) {
    if (!sustained(t)) return false;
    // A wheel still turning steadily half-way through the landing on the
    // first room (a capture) is not stopping there: carry straight on to
    // the next, from the speed the page has — no rest at the corner, no
    // input swallowed. (One that stops turning by then lands on it.)
    if (glide.kind === 'capture') return glide.absorbed >= 0.25 * C.G.D && t >= glide.t0 + 0.5 * glide.T * 1000;
    // In the rooms the next glide starts before this one lands, so a
    // turning wheel never sees the page stop.
    return glide.absorbed >= 0.3 * C.G.D && t >= Math.min(glide.tEnd - 110, glide.t0 + 0.8 * glide.T * 1000);
  }
  // A wheel kept turning pans the rooms at about the speed it is turned
  // (from the corner on, one continuous move): no surge past it.
  const walkCap = (t) => 1.3 * Math.max(rate(t), glide.kind === 'capture' ? glide.v0 : 0, Math.abs(velocity()));

  function absorb(event) {
    if (event.cancelable) event.preventDefault();
    return false;
  }

  function onWheel({ deltaY: d, event }) {
    if (!event || event.type !== 'wheel' || event.ctrlKey || !d || lenis.isStopped || C.refreshing) return true;
    const t = now();
    const dir = Math.sign(d);
    const ad = Math.abs(d);
    const P = lenis.animatedScroll;
    const gap = ad >= 40 ? GAP_NOTCH : GAP_PAD;
    // A wheel notch (as big as any in its gesture: not a trackpad's tail)
    // once the page has come to rest on a station — or is just landing on
    // it, after a deliberate pause — is a new push: every such tick moves.
    const notch = ad >= 40 && (!g || ad >= 0.6 * g.peakD);
    const landed = !!glide && (glide.done || (t >= glide.tEnd - LANDING && !!g && t - g.last > TICK_GAP));
    const fresh = !g || t - g.last > gap || dir !== g.dir || swipeAgain(ad) || (notch && landed);
    if (fresh) { g = { id: ++gid, dir, n: 0, last: t, ev: [], peakD: 0, peakRate: 0 }; note('gesture', dir, ad, Math.round(P)); }
    g.n += 1;
    g.last = t;
    g.ev.push([t, ad]);
    if (g.ev.length > 16) g.ev.shift();
    g.peakD = Math.max(g.peakD, ad);
    g.peakRate = Math.max(g.peakRate, rate(t));
    lastInput = t;
    lastDir = dir;
    arm(QUIET);

    // A landed glide still owns the rest of its gesture; a new gesture
    // starts afresh from wherever the page is.
    if (glide && glide.done && (fresh || glide.g !== g.id)) glide = null;
    if (glide) {
      if (dir !== glide.dir) {
        // turned back mid-glide: head for the station behind
        const i = C.after(P, dir);
        if (i == null) { release(); return true; }
        plan(i, 'slide', kick(ad));
        if (glide) glide.absorbed = ad;
        return absorb(event);
      }
      glide.absorbed += ad;
      // leaving: a push that carries on past an end station is plain scrolling
      if (glide.soft && glide.absorbed >= Math.max(120, 0.6 * Math.abs(glide.X))) { release(); return true; }
      const prog = (t - glide.t0) / (glide.T * 1000);
      // a new push once a glide is well under way: one more room
      if (fresh ? prog >= 0.5 : walkDue(t)) {
        const i = glide.idx + dir;
        if (i < 0 || i > N + 1) { release(); return true; }
        plan(i, 'slide', 0, fresh ? 0 : walkCap(t));
      } else if (fresh) {
        glide.g = g.id; // a second push right on top of the first: one move
      }
      return absorb(event);
    }

    const S = C.stations();
    const I = clamp(lenis.targetScroll + d, 0, lenis.limit);
    if (C.inside(P)) {
      const i = C.after(P, dir);
      if (i == null) return true;                              // past an end station: plain scrolling
      if (C.isSoft(i) && (I - S[i]) * dir >= 0) return true;  // already pushing past the corner
      plan(i, 'slide', kick(ad));
      if (glide) glide.absorbed = ad;
      return absorb(event);
    }
    // Coming in from outside: once Lenis would carry the page into the
    // corner, land it on the first room it meets, from the speed it has.
    if ((dir > 0 && P < S[0] && I >= S[0]) || (dir < 0 && P > S[N + 1] && I <= S[N + 1])) {
      plan(dir > 0 ? 1 : N, 'capture');
      return absorb(event);
    }
    return true;
  }
  lenis.options.virtualScroll = onWheel;

  // Native scrolling (scrollbar, keys outside, find-in-page, focus): once it
  // stops inside the gallery, glide on to the station ahead.
  lenis.on('scroll', () => {
    const t = now();
    const p = lenis.animatedScroll;
    if (hist.length && p !== hist[hist.length - 1][1] && lenis.isScrolling === 'native') lastDir = Math.sign(p - hist[hist.length - 1][1]);
    hist.push([t, p]);
    if (hist.length > 8) hist.shift();
    if (lenis.isScrolling === 'native' && !running()) { glide = null; lastInput = t; arm(QUIET_NATIVE); }
  });

  function arm(ms) { clearTimeout(timer); timer = setTimeout(onQuiet, ms); }
  function onQuiet() {
    timer = 0;
    if (running() || held || lenis.isStopped || C.refreshing) return;
    const since = now() - lastInput;
    if (since < QUIET - 5) { arm(QUIET - since); return; }
    const P = lenis.animatedScroll;
    const smooth = lenis.isScrolling === 'smooth';
    const heading = smooth ? lenis.targetScroll : P;
    if (!C.inside(heading)) return;                 // on its way out, or out
    if (C.atStation(heading)) return;               // already resting / landing on one
    const dir = Math.sign(heading - P) || lastDir;
    const i = C.atOrAfter(heading, dir);
    if (i != null) plan(i, 'settle');
  }

  // Grabbing the scrollbar stops a glide; letting go settles.
  window.addEventListener('pointerdown', (e) => {
    held = true;
    if (running() && e.target === document.documentElement) cancel();
  }, { capture: true, passive: true });
  window.addEventListener('pointerup', () => { held = false; arm(QUIET_NATIVE); }, { capture: true, passive: true });

  function cancel() {
    const was = running();
    glide = null;
    if (was) lenis.scrollTo(lenis.animatedScroll, { immediate: true, force: true });
  }

  return {
    goTo: (i) => plan(i, 'key'),
    step(dir) {
      const base = running() ? glide.to : lenis.animatedScroll;
      if (!C.inside(base)) return false;
      const i = C.after(base, dir);
      if (i == null) return false;
      plan(i, 'key');
      return true;
    },
    cancel,
    target: () => (running() ? glide.to : null),
  };
}

/* ── touch: native scrolling ───────────────────────────────────────
   The finger drags the page 1:1 and the browser's own momentum carries
   it on; CSS scroll snapping decides where that momentum comes to rest.
   Every room is a snap point with scroll-snap-stop: always, so a fling,
   however hard, decelerates onto the next room in its direction (the
   browser's own snap curve: no flying past and being dragged back, no
   stop at speed); a room the finger itself dragged past lands on the next.

   Snapping is switched on only while a touch gesture is in, or heading
   into, the gallery, and only ever while the page is moving (being dragged
   or flung) or resting exactly on a room — switched on with the page at
   rest anywhere else, mandatory snapping would jump it to a room at once.
   It is off again once the page rests, so links, keys and find are never
   pulled at.
     - From a room: snapping on. Once the finger has dragged the page a
       little, the room it started from stops being a snap point, so even
       a slow drag lets go onto the next room (one swipe, one room) — unless
       the finger is heading back to it.
     - Out of the gallery (back from the first room, on from the last):
       snapping off; the fling carries straight on round the corner.
     - In from outside: snapping on once the swipe will reach the corner
       (finger position + a generous estimate of the fling's reach), so the
       fling lands on the first room it meets.
   A page left between stations (a corner, a resize) glides on by script,
   as do keys and dots. All listeners are passive. */
function touchSteer(C) {
  const { N } = C;
  const root = document.documentElement;
  const V_MOVE = 60;        // px/s: the finger is still moving
  const V_FLING = 220;      // px/s at release: below this the finger just let go
  const COMMIT = 24;        // px the finger drags from a room before that room stops holding it
  const now = () => performance.now();
  // Roughly where a fling released at v px/s comes to rest (browsers coast
  // 0.45–0.8 s of it); generous on purpose: one that falls a little short
  // of the corner is still caught by the first room.
  const reach = (v) => (Math.abs(v) < V_FLING ? 0 : Math.max((v * v) / 2800, 0.45 * Math.abs(v)));

  let touching = false;
  let g = null;             // { from, origin, y0, finger: [[t, y]], scrolled }
  let glide = null;
  let quiet = 0;
  let lastDir = 1;
  let lastScrollAt = -1e9;
  const fr = [];

  // one snap point per room (placed after every layout)
  const pts = [];
  for (let i = 0; i < N; i++) {
    const el = document.createElement('i');
    el.className = 'gallery__snap';
    el.setAttribute('aria-hidden', 'true');
    C.scene.appendChild(el);
    pts.push(el);
  }
  function layout() {
    const top = C.scene.getBoundingClientRect().top + window.scrollY;
    const S = C.stations();
    pts.forEach((el, i) => { el.style.top = `${(S[i + 1] - top).toFixed(2)}px`; });
  }
  layout();

  let snapOn = false;
  let skip = -1;
  const tlog = import.meta.env.DEV ? (window.__touchLog = []) : null;
  function setSnap(on, sk = -1) {
    if (!on) sk = -1;
    if (tlog && (on !== snapOn || sk !== skip)) tlog.push([Math.round(now()), 'snap', on ? 1 : 0, sk, Math.round(window.scrollY)]);
    if (sk !== skip) {
      if (skip >= 0) pts[skip].classList.remove('is-off');
      if (sk >= 0) pts[sk].classList.add('is-off');
      skip = sk;
    }
    if (on !== snapOn) {
      root.classList.toggle('gallery-snap', on);
      snapOn = on;
    }
  }
  const roomAt = (p) => {
    const S = C.stations();
    for (let i = 1; i <= N; i++) if (Math.abs(S[i] - p) < 1.5) return i - 1;
    return -1;
  };

  function stop() {
    if (!glide) return;
    cancelAnimationFrame(glide.raf);
    glide = null;
  }

  // Scripted glide to a station (keys, dots, a page left between stations).
  function glideTo(idx, v0 = 0) {
    stop();
    setSnap(false);
    if (tlog) tlog.push([Math.round(now()), 'glide', idx, Math.round(window.scrollY)]);
    const to = C.stations()[idx];
    const me = { idx, to, raf: 0, written: null, t0: null };
    glide = me;
    let from, X, T, m0;
    const step = () => {
      if (glide !== me) return;
      const y = window.scrollY;
      if (me.t0 == null) {
        from = y;
        X = to - from;
        const dist = Math.abs(X);
        if (dist < 1) { stop(); return; }
        const v = v0 * Math.sign(X);
        T = C.slideT(dist);
        m0 = (v * T) / dist;
        if (m0 > MAX_M0) { T = Math.max(0.16, (MAX_M0 * dist) / v); m0 = Math.min(MAX_M0, (v * T) / dist); }
        m0 = Math.max(MIN_M0, m0);
        me.t0 = now() - 16;
      } else if (Math.abs(y - me.written) > 2) {
        stop(); // someone else is scrolling: let them
        return;
      }
      const u = clamp((now() - me.t0) / 1000 / T, 0, 1);
      me.written = from + X * settleEase(u, m0);
      window.scrollTo({ top: me.written, behavior: 'instant' });
      if (u < 1) me.raf = requestAnimationFrame(step);
      else stop();
    };
    me.raf = requestAnimationFrame(step);
  }

  function fingerVelocity(tEnd) {
    const f = g ? g.finger : [];
    if (f.length < 2 || tEnd - f[f.length - 1][0] > 60) return 0;
    const [t2, y2] = f[f.length - 1];
    let j = f.length - 2;
    while (j > 0 && t2 - f[j][0] < 50) j--;
    const [t1, y1] = f[j];
    return t2 > t1 ? (-(y2 - y1) / (t2 - t1)) * 1000 : 0; // page px/s (finger up = +)
  }

  // Snapping for the gesture so far: est = where the finger has put the
  // page (main-thread scrollY lags the compositor in a fast drag; the
  // finger does not), v = the finger's speed now (page px/s).
  function plan(est, v) {
    const S = C.stations();
    const disp = est - g.from;
    // the way the page is heading: the finger's motion while it moves, else
    // the way it has been dragged
    const m = Math.abs(v) >= V_MOVE ? Math.sign(v) : (Math.abs(disp) > 6 ? Math.sign(disp) : 0);
    if (!m) return;
    lastDir = m;
    const o = g.origin;
    const S1 = S[1];
    const SN = S[N];
    let on;
    if (m < 0 && est < S1 + 1 && (o <= 0 || est < S1 - 1)) on = false;            // back out past the first room
    else if (m > 0 && est > SN - 1 && (o < 0 || o === N - 1 || est > SN + 1)) on = false; // on out past the last
    else if (est < S1) on = m > 0 && est + reach(v) >= S[0] - 40; // in from above: once it will reach the corner
    else if (est > SN) on = m < 0 && est - reach(v) <= S[N + 1] + 40;
    else on = true;
    // one swipe, one room: once dragged a little away from the room it
    // started on (and not heading back), that room no longer holds it
    const sk = on && o >= 0 && Math.abs(disp) >= COMMIT && Math.sign(disp) === m ? o : -1;
    setSnap(on, sk);
  }

  function arm(ms = 120) { clearTimeout(quiet); quiet = setTimeout(onQuiet, ms); }
  function onQuiet() {
    if (touching || glide) return;
    if (now() - lastScrollAt < 110) { arm(); return; }
    const y0 = window.scrollY;
    // still for two frames (a busy main thread can hold back scroll events)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (touching || glide) return;
      if (Math.abs(window.scrollY - y0) > 0.5 || now() - lastScrollAt < 110) { arm(); return; }
      setSnap(false); // at rest: snapping off again
      const P = window.scrollY;
      if (!C.inside(P) || C.atStation(P)) return;
      const i = C.atOrAfter(P, lastDir);
      if (i != null) glideTo(i, 0);
    }));
  }

  window.addEventListener('touchstart', (e) => {
    touching = true;
    stop();
    clearTimeout(quiet);
    const t = e.touches[0];
    const P = window.scrollY;
    const o = roomAt(P);
    g = { from: P, origin: o, y0: t ? t.clientY : 0, finger: t ? [[e.timeStamp, t.clientY]] : [], scrolled: false };
    // resting on a room is a valid snap position: switching on moves nothing
    if (o >= 0) setSnap(true, -1);
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (!g || !t || e.touches.length > 1) return;
    g.finger.push([e.timeStamp, t.clientY]);
    while (g.finger.length > 3 && e.timeStamp - g.finger[0][0] > 120) g.finger.shift();
    // change snapping only once the page is really being dragged (the
    // browser's scroll gesture has begun): before that the page is at rest
    if (!g.scrolled) {
      if (Math.abs(window.scrollY - g.from) < 2) return;
      g.scrolled = true;
    }
    plan(g.from + (g.y0 - t.clientY), fingerVelocity(e.timeStamp));
  }, { passive: true });
  const end = (e) => {
    if (e.touches && e.touches.length) return;
    touching = false;
    if (g) {
      if (!g.scrolled) {
        // a tap: nothing to land (and a link it opens must not be snapped)
        if (roomAt(window.scrollY) >= 0) setSnap(false);
      } else {
        const v = fingerVelocity(e.timeStamp);
        // a fling starts: last word on where it may land. (A slow release
        // keeps what the drag decided: the browser settles it now.)
        if (Math.abs(v) >= V_FLING) {
          const f = g.finger[g.finger.length - 1];
          plan(g.from + (g.y0 - f[1]), v);
        }
      }
    }
    g = null;
    arm();
  };
  window.addEventListener('touchend', end, { passive: true });
  window.addEventListener('touchcancel', end, { passive: true });
  window.addEventListener('wheel', () => { stop(); setSnap(false); arm(); }, { passive: true });
  // an in-page link scrolls by script: never snapped
  document.addEventListener('click', (e) => {
    if (snapOn && e.target && e.target.closest && e.target.closest('a[href^="#"]')) setSnap(false);
  }, { capture: true, passive: true });
  window.addEventListener('scroll', () => {
    const t = now();
    const y = window.scrollY;
    if (fr.length && y !== fr[fr.length - 1][1]) lastDir = Math.sign(y - fr[fr.length - 1][1]);
    fr.push([t, y]);
    if (fr.length > 8) fr.shift();
    lastScrollAt = t;
    if (glide) return; // the glide checks its own position each frame
    if (!touching) arm();
  }, { passive: true });

  return {
    goTo: (i) => glideTo(i, 0),
    step(dir) {
      const base = glide ? glide.to : window.scrollY;
      if (!C.inside(base)) return false;
      const i = C.after(base, dir);
      if (i == null) return false;
      glideTo(i, 0);
      return true;
    },
    cancel() { stop(); setSnap(false); },
    layout,
    target: () => (glide ? glide.to : null),
  };
}
