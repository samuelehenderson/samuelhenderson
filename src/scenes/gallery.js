import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

/**
 * Scene 3 — Horizontal Gallery (Project Rooms), played like a slide deck.
 *
 * Default markup is a vertical stack of <article class="room">. On capable
 * devices we add .gallery--horizontal: the section becomes a tall runway
 * with a sticky 100vh stage, and the page scroll drives the stage like this:
 *
 *   corner in   The first scroll px inside the stage run the track sideways
 *               1:1 with the scroll, so the motion carried in from The Dive
 *               turns the corner at the same speed, then eases onto the first room
 *               over the last stretch (it never stops dead, never lurches).
 *   rooms       Each room after that is one eased, time-based slide, called
 *               by the scroll (one wheel notch / one swipe is enough). A
 *               slide called while the track is moving starts from the
 *               track's current speed, so nothing ever jumps or stalls.
 *   corner out  The mirror of the way in: the last room runs sideways 1:1
 *               with the scroll and hands the same speed to the page as it
 *               turns back down into Selected Work. Both corners work the
 *               same in reverse.
 *
 * Page scrolling stays native / Lenis. One gesture moves one room: the rest
 * of that gesture (a trackpad's momentum tail, a phone's fling) is soaked
 * up while the stage holds, and the page scroll is re-centred on the new
 * room so the next gesture always needs the same small push; a mouse wheel
 * kept spinning walks on room by room. On phones the end rooms' text steps
 * out while the page is outside the stage and builds in round the corner.
 * Under prefers-reduced-motion the gallery stays a vertical stack.
 */

// ── Motion ────────────────────────────────────────────────────────────
const SLIDE_DURATION = 0.9;   // s — one room
const SLIDE_PER_ROOM = 0.15;  // s — added per extra room in one move
const SLIDE_MAX      = 1.35;  // s
const LEAVE_DURATION = 0.42;  // s — finishing a slide as the page heads out
const GOTO_SCROLL    = 1.0;   // s — dot / keyboard page scroll

const REVEAL  = { duration: 0.42, each: 0.04, maxStagger: 0.18, x: 36, y: 10 };
const CONCEAL = { duration: 0.42, x: 20, stagger: 0.06 };

// ── Input ─────────────────────────────────────────────────────────────
const GESTURE_GAP_MS = 220;  // wheel quiet this long = the next input is a new gesture
const STEP_PX        = 60;   // wheel travel that calls the next room (less than one notch)
const STEP_TOUCH_PX  = 56;   // finger travel that calls the next room
const HELD_STEP_S    = 0.42; // a held wheel spin calls the next room no sooner than this
const ENTRY_STEP_S   = 0.12; // … or than this after it turned the corner into the stage
const REST_MS        = 240;  // scroll quiet this long = at rest (wheel / Lenis)
const REST_TOUCH_MS  = 320;  // … after a swipe (native momentum can stutter)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const now = () => performance.now();
// Lenis's own wheel easing (main.js); its starting slope is 10·ln2.
const lenisEase = (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t));
const LENIS_SLOPE = 10 * Math.LN2;
const sineInOut = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

export function initGallery({ reducedMotion, lenis }) {
  const scene = document.querySelector('[data-scene="gallery"]');
  if (!scene || reducedMotion) return;

  const track = scene.querySelector('.gallery__track');
  const rooms = [...scene.querySelectorAll('.room')];
  if (!track || rooms.length === 0) return;
  const count = rooms.length;

  // Horizontal mode. Force the reflow now so the runway below is measured —
  // and the later scenes' triggers start below it.
  scene.classList.add('gallery--horizontal');
  void track.offsetWidth;

  const coarse = window.matchMedia('(pointer: coarse)');

  // ── Per-room parts ──────────────────────────────────────────────────
  const parts = rooms.map((room, index) => {
    const content = room.querySelector('.room__content');
    // A body wrapper lets a tall room scale down to fit its slide instead
    // of turning into a nested scroller that eats the page's swipes.
    let body = null;
    if (content) {
      body = document.createElement('div');
      body.className = 'room__body';
      while (content.firstChild) body.appendChild(content.firstChild);
      content.appendChild(body);
    }
    const items = [...room.querySelectorAll(
      '.room__number, .room__heading, .room__lead, ' +
      '.room__chips > *, .room__cards > *, .room__timeline > *, .room__columns'
    )];
    const layers = [...room.querySelectorAll('[data-parallax]')].map((el) => ({
      el, factor: parseFloat(el.dataset.parallax) || 0, last: NaN,
    }));
    const label = (room.querySelector('.room__number')?.textContent || '')
      .split('·').pop().trim();
    return { room, index, content, body, items, layers, label, shown: false };
  });

  // ── Progress dots → buttons that go to their room ───────────────────
  const progress = scene.querySelector('.gallery__progress');
  const dots = progress ? [...progress.querySelectorAll('.gallery__progress-dot')].map((old, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gallery__progress-dot';
    btn.dataset.room = old.dataset.room || String(i + 1);
    btn.setAttribute('aria-label', `Room ${i + 1} of ${count}${parts[i]?.label ? `: ${parts[i].label}` : ''}`);
    btn.addEventListener('click', () => goTo(i));
    old.replaceWith(btn);
    return btn;
  }) : [];
  if (progress) {
    progress.removeAttribute('aria-hidden');
    progress.setAttribute('role', 'group');
    progress.setAttribute('aria-label', 'Story rooms');
  }

  // ── Geometry ────────────────────────────────────────────────────────
  // The runway, in page-scroll px from the stage's first held position S:
  //   [S, A0]          corner in  (zone px)
  //   A0 … A(n-1)      one anchor per room, `band` px apart
  //   [A(n-1), E]      corner out (zone px)
  let vw = window.innerWidth;
  let roll = 0;     // scroll px over which a corner eases onto its room
  const cin = { lead: 0, zone: 0 };  // corner in:  px the track runs sideways, scroll px it takes
  const cout = { lead: 0, zone: 0 }; // corner out
  let band = 0;     // scroll px between two rooms' anchors
  let S = 0;        // page scroll where the stage starts to hold
  let hideOutside = false; // phones: end rooms' text steps out while the page is outside the stage

  function layout() {
    vw = rooms[0].getBoundingClientRect().width || window.innerWidth;
    const vh = window.innerHeight;
    const touch = coarse.matches;
    hideOutside = touch;
    if (touch) {
      // A phone's room is all text, so the end rooms' text steps out while
      // the page is outside the stage and builds in as the corner turns;
      // the corners can then run further, which a fast swipe needs to
      // ease off in rather than stop short.
      roll = Math.round(clamp(vh * 0.18, 130, 180));
      cin.lead = cout.lead = Math.round(vw * 0.42);
      band = Math.round(clamp(vh * 0.95, 640, 1000));
    } else {
      roll = 90;
      cin.lead = Math.round(vw * 0.2);
      // On the way out the room runs off to the left: never so far that
      // its text is cut by the edge of the screen.
      const content = parts[count - 1]?.content;
      const textLeft = content ? content.offsetLeft + parseFloat(getComputedStyle(content).paddingLeft) : vw * 0.1;
      cout.lead = Math.round(clamp(textLeft - 12, roll / 2 + 20, vw * 0.2));
      band = Math.round(clamp(vh * 0.7, 560, 760));
    }
    cin.zone = cin.lead + roll / 2;
    cout.zone = cout.lead + roll / 2;
    scene.style.setProperty('--gallery-run', `${Math.round(runLength())}px`);
  }
  const runLength = () => cin.zone + cout.zone + (count - 1) * band;
  const anchor = (k) => S + cin.zone + k * band;
  const endY = () => S + runLength();

  // Sideways px through a corner, d scroll px out from its room: a short
  // ease off the room, then exactly 1:1 with the scroll up to the corner.
  function cornerPx(c, d) {
    if (d <= 0) return 0;
    if (d >= c.zone) return c.lead;
    return d < roll ? (d * d) / (2 * roll) : d - roll / 2;
  }
  const cornerSlope = (c, d) => (d <= 0 || d >= c.zone ? 0 : Math.min(1, d / roll));
  function leadAt(y) { // rooms
    const a0 = anchor(0), aN = anchor(count - 1);
    if (y < a0) return -cornerPx(cin, a0 - y) / vw;
    if (y > aN) return cornerPx(cout, y - aN) / vw;
    return 0;
  }
  function leadSlope(y) { // rooms per scroll px
    const a0 = anchor(0), aN = anchor(count - 1);
    if (y < a0) return cornerSlope(cin, a0 - y) / vw;
    if (y > aN) return cornerSlope(cout, y - aN) / vw;
    return 0;
  }
  const inRooms = (y) => y >= anchor(0) - 0.5 && y <= anchor(count - 1) + 0.5;

  function fitRoom(part) {
    const { content, body } = part;
    if (!content || !body) return;
    body.style.transform = '';
    const cs = getComputedStyle(content);
    const avail = content.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const need = body.offsetHeight;
    const s = need > 0 && avail > 0 ? clamp(avail / need, 0.6, 1) : 1;
    if (s < 0.999) body.style.transform = `scale(${s.toFixed(3)})`;
  }

  // ── Page scroll ─────────────────────────────────────────────────────
  const scrollPos = () => (lenis ? lenis.animatedScroll : window.scrollY);
  let lastY = scrollPos();
  let lastYAt = now();
  let scrollVel = 0; // px/s, lightly smoothed

  // Move the page scroll by d px while the stage holds (nothing on screen
  // changes). With Lenis the smooth scroll in flight keeps its speed and
  // simply lands d px further on.
  function shiftScroll(d) {
    if (!d) return;
    if (lenis) {
      const a = lenis.animate;
      if (a && a.isRunning) { a.from += d; a.to += d; a.value += d; }
      lenis.animatedScroll += d;
      lenis.targetScroll += d;
      lenis.setScroll(lenis.animatedScroll);
      lenis.preventNextNativeScrollEvent?.();
    } else {
      window.scrollTo({ top: window.scrollY + d, behavior: 'instant' });
    }
    lastY += d;
  }

  // ── Slide engine ────────────────────────────────────────────────────
  // One move at a time: a cubic from the track's current position and
  // speed to a whole room, landing flat. Calling another room mid-move
  // starts a new cubic from where the track is, at the speed it has, so
  // the speed never jumps (no stacked eases, no dip or surge).
  let move = null; // { x0, v0, x1, t0, T } — rooms, rooms/s, seconds
  let rest = 0;    // slide position when no move runs
  let ticking = false;
  const clock = () => now() / 1000;

  function slideAt(t) {
    if (!move) return [rest, 0];
    const { x0, v0, x1, t0, T } = move;
    const u = clamp((t - t0) / T, 0, 1);
    const D = x1 - x0;
    const x = x0 + v0 * T * u * (1 - u) * (1 - u) + D * u * u * (3 - 2 * u);
    const v = u >= 1 ? 0 : v0 * (1 - 4 * u + 3 * u * u) + (D / T) * 6 * u * (1 - u);
    return [x, v];
  }

  function slideTime(D, v0) {
    let T = clamp(SLIDE_DURATION + SLIDE_PER_ROOM * (Math.abs(D) - 1), 0.5, SLIDE_MAX);
    // Keep the cubic from overshooting when it starts fast toward a near room.
    if (v0 * D > 0) T = clamp(Math.min(T, (2.4 * Math.abs(D)) / Math.abs(v0)), 0.28, T);
    return T;
  }

  // Start a move to room `target` from (x0, v0); returns seconds to landing.
  function startMove(target, x0, v0, duration) {
    const D = target - x0;
    if (Math.abs(D) < 1e-4 && Math.abs(v0) < 1e-3) {
      move = null;
      rest = target;
      render();
      return 0;
    }
    const T = duration ?? slideTime(D, v0);
    move = { x0, v0, x1: target, t0: clock(), T };
    if (!ticking) { ticking = true; gsap.ticker.add(tick); }
    render();
    return T;
  }

  function slideTo(target, { duration } = {}) {
    const [x, v] = slideAt(clock());
    return startMove(target, x, v, duration);
  }

  // Hand the track's whole motion — slide plus a corner still running with
  // the scroll — to one move: the page scroll is re-centred on the new
  // room (invisible while held) and the move starts where the track is,
  // at the speed it is going. From rest it starts at (part of) the speed
  // the reader is scrolling, so the slide answers the gesture at once.
  // `I` is where the page is heading (Lenis's target, including a wheel
  // event about to be applied).
  function handOff(target, I) {
    const [xs, vs] = slideAt(clock());
    const y = scrollPos();
    const total = xs + leadAt(y);
    let vel = vs + leadSlope(y) * scrollVel;
    const dir = Math.sign(target - total);
    const input = Math.max(scrollVel * dir, inputSpeed());
    if (Math.abs(vel) < 0.05 && input > 0) vel = dir * Math.min((input / vw) * 0.75, 0.7);
    if (lenis) shiftScroll(anchor(target) - (I ?? lenis.targetScroll));
    const y2 = scrollPos();
    const x0 = total - leadAt(y2);
    const v0 = vel - leadSlope(y2) * scrollVel;
    // Carrying on from a moving scroll (a spin through a corner, a held
    // wheel): pace the slide to that speed — its peak stays near twice
    // what the reader is scrolling at instead of leaping ahead of it.
    let T;
    const carried = Math.abs(v0) * vw;
    if (carried > 150) T = clamp((1.5 * Math.abs(target - x0) * vw) / (2.1 * carried), SLIDE_DURATION, SLIDE_MAX);
    return startMove(target, x0, v0, T);
  }

  function tick() {
    if (move && clock() - move.t0 >= move.T) {
      rest = move.x1;
      move = null;
    }
    render();
    if (!move) { ticking = false; gsap.ticker.remove(tick); }
  }

  function jumpTo(target) {
    move = null;
    rest = target;
    render();
  }

  function render() {
    const pos = slideAt(clock())[0] + leadAt(scrollPos());
    track.style.transform = `translate3d(${(-pos * vw).toFixed(2)}px, 0, 0)`;
    // Parallax: each layer drifts by its depth factor as its room crosses
    // the viewport (rel = +1 waiting on the right … -1 gone to the left),
    // so depth shows during the move and settles to 0 when it lands.
    for (const part of parts) {
      const rel = clamp(part.index - pos, -1, 1);
      for (const layer of part.layers) {
        const xp = -layer.factor * 50 * rel;
        if (Math.abs(xp - layer.last) < 0.005) continue;
        layer.last = xp;
        layer.el.style.transform = `translate3d(${xp.toFixed(3)}%, 0, 0)`;
      }
    }
  }

  // ── Room content: build in on arrival, step out on departure ────────
  function showContent(part, { dir = 1, delay = 0, instant = false, quick = false } = {}) {
    part.shown = true;
    const { items } = part;
    if (!items.length) return;
    gsap.killTweensOf(items);
    if (instant) { gsap.set(items, { opacity: 1, x: 0, y: 0 }); return; }
    // Only items that are fully out start from the side; anything still
    // fading out turns around from where it is, at once.
    let resuming = false;
    items.forEach((el) => {
      if (gsap.getProperty(el, 'opacity') < 0.02) gsap.set(el, { x: REVEAL.x * dir, y: REVEAL.y });
      else resuming = true;
    });
    gsap.to(items, {
      opacity: 1, x: 0, y: 0,
      duration: quick ? REVEAL.duration * 0.8 : REVEAL.duration,
      ease: 'power3.out',
      delay: resuming ? 0 : delay,
      stagger: { amount: Math.min(quick ? 0.1 : REVEAL.maxStagger, REVEAL.each * (items.length - 1)) },
      overwrite: true,
    });
  }

  function hideContent(part, { dir = 1, instant = false, quick = false } = {}) {
    part.shown = false;
    const { items } = part;
    if (!items.length) return;
    gsap.killTweensOf(items);
    if (instant) { gsap.set(items, { opacity: 0, x: 0, y: 0 }); return; }
    gsap.to(items, {
      opacity: 0,
      x: -CONCEAL.x * dir,
      // rides out with its slide, gone before it is (or, leaving the stage
      // round a corner, gone at once as the page turns)
      duration: quick ? 0.28 : CONCEAL.duration,
      ease: quick ? 'power2.out' : 'power1.in',
      stagger: { amount: quick ? 0.03 : CONCEAL.stagger },
      overwrite: true,
    });
  }

  // ── Active room ─────────────────────────────────────────────────────
  let active = -1;

  function setActive(next, { instant = false, duration, handoff = false, intent: I } = {}) {
    const prev = active;
    active = next;
    scene.classList.toggle('is-last-room', next === count - 1);
    dots.forEach((d, j) => {
      const on = j === next;
      d.classList.toggle('is-active', on);
      if (on) d.setAttribute('aria-current', 'true');
      else d.removeAttribute('aria-current');
    });

    if (instant || prev < 0) {
      jumpTo(next);
      parts.forEach((p) => (p.index === next ? showContent(p, { instant: true }) : hideContent(p, { instant: true })));
      return;
    }
    const dir = next > prev ? 1 : -1;
    const landing = handoff ? handOff(next, I) : slideTo(next, { duration });
    parts.forEach((p) => { if (p.index !== next && p.shown) hideContent(p, { dir }); });
    // The text lands with the slide: start it so it finishes as the move does.
    showContent(parts[next], { dir, delay: clamp(landing - 0.7, 0, 0.9) });
  }

  // Finish a move that would still be running as the page turns the corner
  // out of the stage (from its current speed, no jump).
  function hurry() {
    if (!move) return;
    const left = move.t0 + move.T - clock();
    if (left > LEAVE_DURATION + 0.04) slideTo(move.x1, { duration: LEAVE_DURATION });
  }

  // ── Input: gestures ─────────────────────────────────────────────────
  // g: the reader's current gesture — a burst of wheel events, or a touch
  // from finger-down to the end of its momentum.
  //   steps    rooms it has called (turning a corner into the stage counts)
  //   ref      intent position the next step is measured from
  //   held     a mouse wheel kept spinning (it may walk on, room by room)
  let g = null;
  let pending = null;   // room a dot / key is heading to
  let pendingTimer = 0;
  let touching = false;
  let restTimer = 0;
  let keepRoom = null;  // room to hold across a layout refresh

  const intent = () => (lenis && lenis.isScrolling === 'smooth' ? lenis.targetScroll : scrollPos());

  function newGesture(dir, extra) {
    g = { dir, t0: now(), last: now(), steps: 0, ref: intent(), stepAt: -1e9, n: 0, pad: 0, entered: false, hist: [], peakD: 0, ...extra };
    return g;
  }

  // How fast the reader's wheel input is arriving (px/s over the last
  // ~100 ms; 0 for a single notch).
  function inputSpeed() {
    if (!g || g.touch || g.hist.length < 2) return 0;
    const t = now();
    const recent = g.hist.filter((h) => t - h[0] <= 110);
    if (recent.length < 2) return 0;
    const span = Math.max(16, recent[recent.length - 1][0] - recent[0][0]);
    return (recent.slice(1).reduce((a, h) => a + h[1], 0) / span) * 1000;
  }

  // A mouse wheel kept turning (big, evenly spaced notches) walks on room
  // by room; a trackpad gesture (small, dense deltas, then a decaying
  // momentum tail) is one gesture, one room.
  function heldSpin(gs) {
    return gs && !gs.touch && gs.n >= 3 && gs.pad * 2 < gs.n && now() - gs.last < 170;
  }

  function onWheel(data) {
    const { deltaY, event } = data;
    if (!event || event.type !== 'wheel' || event.ctrlKey) return true;
    const t = now();
    const dir = Math.sign(deltaY);
    if (!dir) return true;
    if (pending !== null) clearPending();
    const gap = g ? t - g.last : Infinity;
    // A trackpad swipe begun while the last one's momentum is still
    // running: after the tail has decayed, the deltas climb well back up
    // and stay up. (One big delta alone can be two tail events merged on
    // a busy page; it takes two in a row.)
    const d = Math.abs(deltaY);
    let swipeAgain = false;
    if (g && !g.touch && g.hist.length >= 10) {
      const prev = g.hist[g.hist.length - 1][1];
      const floor = Math.min(...g.hist.slice(-9, -1).map((h) => h[1]));
      const rise = 2.5 * floor + 3;
      swipeAgain = floor <= 0.45 * g.peakD && d >= rise && prev >= rise;
    }
    if (!g || g.touch || gap > GESTURE_GAP_MS || dir !== g.dir || swipeAgain) newGesture(dir);
    g.peakD = Math.max(g.peakD, d);
    g.n += 1;
    if (Math.abs(deltaY) < 50 || gap < 30) g.pad += 1;
    g.last = t;
    g.hist.push([t, Math.abs(deltaY)]);
    if (g.hist.length > 12) g.hist.shift();

    if (veto(deltaY)) {
      if (event.cancelable) event.preventDefault();
      return false;
    }
    // Decide on the position this event will send the page to.
    decide(lenis.targetScroll + deltaY);
    return true;
  }

  // Soak up the rest of a gesture that has already moved a room — the
  // stage holds, so the reader sees nothing of it, and the page never
  // drifts on into the next room or out of the gallery by itself.
  function veto(deltaY) {
    if (!g || g.steps === 0 || heldSpin(g)) return false;
    const T = lenis.targetScroll;
    const T2 = T + deltaY;
    if (T < S - 1 || T > endY() + 1) return false;
    if (g.entered) {
      // Still running through the corner it came in by: let it flow.
      if (g.dir > 0 && T2 < anchor(0)) return false;
      if (g.dir < 0 && T2 > anchor(count - 1)) return false;
    }
    return true;
  }

  // Where the page is heading → which room.
  function decide(I = intent()) {
    if (ScrollTrigger.isRefreshing || keepRoom !== null) return;
    const y = scrollPos();
    const E = endY();
    const heading = g ? g.dir : Math.sign(y - lastY);

    if (pending !== null) {
      if (pending !== active && y >= S - 1 && y <= E + 1) setActive(pending);
      return;
    }
    // Outside the stage, and in its corners, only the end rooms can show;
    // a slide still running as the page heads out lands quickly.
    const inEntry = y < anchor(0) - 0.5;
    const inExit = y > anchor(count - 1) + 0.5;
    if (inEntry && active !== 0) { setActive(0, { duration: LEAVE_DURATION }); return; }
    if (inExit && active !== count - 1) { setActive(count - 1, { duration: LEAVE_DURATION }); return; }
    if ((inEntry && heading < 0) || (inExit && heading > 0)) hurry();
    if (y < S || y > E) return;
    if (!g) {
      // The page moved by itself (scrollbar, Space, a link): follow it.
      if (inRooms(y)) {
        const want = roomAt(y);
        if (want !== active && Math.abs(y - anchor(want)) < band * 0.4) setActive(want);
      }
      return;
    }
    if (!g.dir) return;

    const travel = (I - g.ref) * g.dir;
    let want = 0;
    if (g.touch) {
      // One swipe, one room: once the finger lifts, its fling is held (see
      // holdFling). Where a browser won't let a fling be held, a very long
      // one may walk on a room per two bands of travel.
      if (g.steps === 0 && travel >= STEP_TOUCH_PX) want = 1;
      else if (g.steps > 0 && !g.held && travel >= 2 * band) want = 1;
    } else if (g.steps === 0) {
      if (travel >= STEP_PX) want = 1;
    } else if (heldSpin(g)) {
      const since = (now() - g.stepAt) / 1000;
      // Spinning on through the corner: hand over to the next room before
      // the corner starts to ease off, so the speed carries straight on.
      if (g.entered && g.steps === 1 && since >= ENTRY_STEP_S && travel >= -20) want = 1;
      else if (since >= HELD_STEP_S && travel >= 0.5 * band) want = 1;
    }
    if (!want) return;
    const next = active + g.dir;
    if (next < 0 || next >= count) return; // past an end room: the corner out takes it
    g.steps += 1;
    g.stepAt = now();
    setActive(next, { handoff: true, intent: I });
    g.ref = lenis ? anchor(next) : I;
  }

  // ── Scroll → stage ──────────────────────────────────────────────────

  function onScroll() {
    const y = scrollPos();
    const t = now();
    const dt = Math.max(1, t - lastYAt);
    const v = ((y - lastY) / dt) * 1000;
    scrollVel = dt > 60 ? v : scrollVel * 0.35 + v * 0.65;
    // A swipe's direction is known once the page moves.
    if (g?.touch && !g.dir && Math.abs(y - g.ref) > 2) g.dir = Math.sign(y - g.ref);

    // Turning a corner into the stage counts as the gesture's first room.
    const a0 = S, aE = endY();
    if (g && ((lastY < a0 && y >= a0) || (lastY > aE && y <= aE))) {
      g.steps = Math.max(g.steps, 1);
      g.entered = true;
      g.stepAt = t;
      g.ref = lastY < a0 ? anchor(0) : anchor(count - 1);
    }
    lastY = y;
    lastYAt = t;
    render();
    if (!lenis) holdFling(y);
    decide();
    syncEndText(scrollPos());
    clearTimeout(restTimer);
    restTimer = setTimeout(onRest, g?.touch ? REST_TOUCH_MS : REST_MS);
  }

  // Phones: an end room's text is out while the page is outside the stage
  // (a corner's sideways run would cut it at the screen edge) and builds
  // in as the page turns the corner — the same arrival as any slide.
  const TEXT_PAD = 48;
  function syncEndText(y, instant = false) {
    if (!hideOutside || active < 0) return;
    const part = parts[active];
    const E = endY();
    const outside = y < S - TEXT_PAD || y > E + TEXT_PAD;
    const inside = y > S + 2 && y < E - 2;
    if (outside && part.shown) hideContent(part, { dir: y < S ? -1 : 1, instant, quick: true });
    else if (inside && !part.shown) showContent(part, { dir: y < (S + E) / 2 ? 1 : -1, instant, quick: true });
  }

  // Phones: a swipe that has called its room stops there — its native
  // momentum would otherwise run on invisibly through the stage (and, on a
  // hard flick, out of the gallery). A programmatic smooth scroll replaces
  // the fling; sent to the room's anchor, it re-centres the page there too.
  // The stage holds throughout, so nothing on screen changes.
  function holdFling(y) {
    if (!g || !g.touch || touching || g.held || g.steps === 0) return;
    if (y <= anchor(0) + 2 || y >= anchor(count - 1) - 2) return;
    g.held = true;
    window.scrollTo({ top: Math.round(anchor(active)), behavior: 'smooth' });
  }

  // At rest: put the page scroll back on the active room's anchor (the
  // stage holds, so nothing moves), so the next gesture needs the same
  // push as any other. A gesture that ran out inside a corner is carried
  // on to the corner's end in the direction it was going.
  const hasScrollEnd = 'onscrollend' in window;
  let nativeEnded = false;
  function onRest() {
    const busy = touching || (lenis && lenis.isScrolling === 'smooth');
    const flinging = g?.touch && hasScrollEnd && !nativeEnded && now() - lastYAt < 1500;
    if (busy || flinging || now() - lastYAt < (g?.touch ? REST_TOUCH_MS : REST_MS) - 5) {
      restTimer = setTimeout(onRest, 60);
      return;
    }
    const dir = g?.dir || 0;
    g = null;
    const y = scrollPos();
    const a0 = anchor(0), aN = anchor(count - 1), E = endY();
    if (inRooms(y)) {
      const c = Math.round(anchor(active));
      if (Math.abs(c - y) >= 1) {
        if (lenis) lenis.scrollTo(c, { immediate: true, force: true });
        else window.scrollTo({ top: c, behavior: 'instant' });
        lastY = scrollPos();
      }
      return;
    }
    let dest = null;
    if (y > S + 0.5 && y < a0 - 0.5) dest = dir < 0 ? S : a0;
    else if (y > aN + 0.5 && y < E - 0.5) dest = dir > 0 ? E : aN;
    if (dest === null) return;
    glideTo(dest);
  }

  function glideTo(dest) {
    const d = Math.abs(dest - scrollPos());
    if (d < 1) return;
    if (lenis) {
      lenis.scrollTo(dest, { duration: clamp(0.4 + d / 700, 0.45, 0.9), easing: sineInOut, force: true });
    } else {
      window.scrollTo({ top: dest, behavior: 'smooth' });
    }
  }

  // A wheel gesture that runs out inside a corner: carry it on to the
  // corner's end now, at the speed the page is already moving.
  let gestureEndTimer = 0;
  function onGestureQuiet() {
    if (!lenis || !g || g.touch || now() - g.last < GESTURE_GAP_MS - 5) return;
    const T = lenis.targetScroll;
    const y = scrollPos();
    const a0 = anchor(0), aN = anchor(count - 1), E = endY();
    let dest = null;
    if (T > S + 0.5 && T < a0 - 0.5) dest = g.dir < 0 ? S : a0;
    else if (T > aN + 0.5 && T < E - 0.5) dest = g.dir > 0 ? E : aN;
    if (dest === null) return;
    const dist = dest - y;
    const v = scrollVel;
    if (Math.abs(dist) < 1) return;
    if (v * dist > 0 && Math.abs(v) > 60) {
      lenis.scrollTo(dest, { duration: clamp((LENIS_SLOPE * Math.abs(dist)) / Math.abs(v), 0.35, 1.8), easing: lenisEase, force: true });
    } else {
      glideTo(dest);
    }
  }

  function clearPending() {
    pending = null;
    clearTimeout(pendingTimer);
  }

  // Dots, keys and focus: scroll the page to a room's anchor and slide
  // straight there (no sweep through the rooms in between).
  function goTo(j) {
    j = clamp(j, 0, count - 1);
    const y = Math.round(anchor(j));
    g = null;
    pending = j;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(clearPending, (GOTO_SCROLL + 0.6) * 1000);
    if (lenis) {
      lenis.scrollTo(y, {
        duration: GOTO_SCROLL,
        easing: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
        force: true,
        onComplete: () => { clearPending(); decide(); },
      });
    } else {
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
    if (active !== j && window.scrollY >= S - 1 && window.scrollY <= endY() + 1) setActive(j);
  }

  // ── Wiring ──────────────────────────────────────────────────────────
  const st = ScrollTrigger.create({
    trigger: scene,
    start: 'top top',
    end: () => `+=${Math.round(runLength())}`,
    invalidateOnRefresh: true,
    onRefresh: (self) => {
      S = self.start;
      parts.forEach(fitRoom);
      lastY = scrollPos();
      render();
    },
  });

  // A resize re-lays the page out, so the same scroll offset would land
  // somewhere else: keep the reader's room and put the scroll back on it.
  ScrollTrigger.addEventListener('refreshInit', () => {
    const y = scrollPos();
    keepRoom = active >= 0 && y >= S && y <= endY() ? active : null;
    layout();
  });
  ScrollTrigger.addEventListener('refresh', () => {
    S = st.start;
    if (keepRoom === null) {
      const want = roomAt(scrollPos());
      if (want !== active) setActive(want, { instant: true });
      else render();
      return;
    }
    const room = keepRoom;
    keepRoom = null;
    const c = Math.round(anchor(room));
    if (Math.abs(scrollPos() - c) > 1) {
      if (lenis) lenis.scrollTo(c, { immediate: true, force: true });
      else window.scrollTo({ top: c, behavior: 'instant' });
    }
    lastY = scrollPos();
    if (room !== active) setActive(room, { instant: true });
    else render();
    syncEndText(scrollPos(), true);
  });

  function roomAt(y) {
    if (y <= anchor(0)) return 0;
    if (y >= anchor(count - 1)) return count - 1;
    return clamp(Math.round((y - anchor(0)) / band), 0, count - 1);
  }

  if (lenis) {
    lenis.options.virtualScroll = onWheel;
    lenis.on('scroll', onScroll);
    // A gesture ends GESTURE_GAP_MS after its last wheel event.
    window.addEventListener('wheel', () => {
      clearTimeout(gestureEndTimer);
      gestureEndTimer = setTimeout(onGestureQuiet, GESTURE_GAP_MS);
    }, { passive: true });
  } else {
    window.addEventListener('scroll', onScroll, { passive: true });
  }
  window.addEventListener('scrollend', (e) => {
    if (e.detail?.lenisScrollEnd) return;
    nativeEnded = true;
    if (g?.touch && !touching) { clearTimeout(restTimer); restTimer = setTimeout(onRest, 40); }
  }, { passive: true });
  window.addEventListener('touchstart', () => {
    touching = true;
    nativeEnded = false;
    clearPending();
    newGesture(0, { touch: true, ref: window.scrollY });
  }, { passive: true });
  const touchEnd = () => { touching = false; clearTimeout(restTimer); restTimer = setTimeout(onRest, REST_TOUCH_MS); };
  window.addEventListener('touchend', touchEnd, { passive: true });
  window.addEventListener('touchcancel', touchEnd, { passive: true });

  // Keyboard: arrows and Page Up / Down step one room while the stage
  // holds. At the first / last room the keys fall through to the page.
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (t && t !== document.body && t !== document.documentElement && !scene.contains(t)) return;
    const y = scrollPos();
    if (y < S || y > endY()) return;
    let step = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') step = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') step = -1;
    if (!step) return;
    const j = (pending ?? active) + step;
    if (j < 0 || j >= count) return;
    e.preventDefault();
    goTo(j);
  });

  // Tabbing into a room that isn't on screen brings its slide in.
  scene.addEventListener('focusin', (e) => {
    const part = parts.find((p) => p.room.contains(e.target));
    if (part && part.index !== active && part.index !== pending) goTo(part.index);
  });

  coarse.addEventListener?.('change', () => ScrollTrigger.refresh());

  if (import.meta.env.DEV) {
    window.__gallery = {
      anchors: () => Array.from({ length: count }, (_, k) => Math.round(anchor(k))),
      state: () => ({ S, E: endY(), cin, cout, roll, band, active, move, rest, g, pending }),
    };
  }

  // Initial state: the room the page is on (usually the first), settled.
  layout();
  S = scene.getBoundingClientRect().top + window.scrollY;
  parts.forEach(fitRoom);
  setActive(roomAt(scrollPos()), { instant: true });
  syncEndText(scrollPos(), true);
}
