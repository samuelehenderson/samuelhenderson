import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

/**
 * Scene 3 — Horizontal Gallery (Project Rooms), played like a slide deck.
 *
 * Default markup is a vertical stack of <article class="room">. On capable
 * devices we add .gallery--horizontal, pin the section and cut its scroll
 * distance into one band per room. Scrolling never drags the track: the
 * scroll position only picks the active room, and one time-based, eased
 * move slides the track there. Scrolling on while a slide is moving
 * retargets that same move without a stop-and-go, parallax layers ride it
 * at their own depth, and each room's text builds in as its slide lands and
 * steps out as it leaves — nothing ever rests half-panned or half-faded.
 *
 * Page scrolling stays native / Lenis: no wheel or touch input is
 * prevented. Under prefers-reduced-motion the gallery stays a vertical
 * stack, fully readable.
 */

// ── Motion ────────────────────────────────────────────────────────────
const SLIDE_DURATION = 0.9;   // s — one room
const SLIDE_PER_ROOM = 0.15;  // s — added per extra room in one move
const SLIDE_MAX      = 1.35;  // s
const LEAVE_DURATION = 0.4;   // s — finishing a slide as the pin lets go
const GOTO_SCROLL    = 1.0;   // s — dot / keyboard page scroll

const REVEAL  = { duration: 0.42, each: 0.04, maxStagger: 0.18, x: 36, y: 10 };
const CONCEAL = { duration: 0.42, x: 20, stagger: 0.06 };

// ── Scroll bands ──────────────────────────────────────────────────────
const HYSTERESIS_PX = 24;  // scroll past a band edge before the room changes
const REST_MS       = 160; // scroll quiet this long = the gesture has ended
const REST_TOUCH_MS = 320; // … after a swipe (native momentum can stutter)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Slide ease: a short, firm acceleration (power2.in over the first 30 %)
// joined smoothly to a long power3.out landing. The slide answers the
// scroll at once and glides into place — none of an in-out ease's
// sluggish start, and a lower top speed for the same duration.
const SPLIT = 0.3;
const EASE_A = 2 / (SPLIT * (1 + SPLIT));
const EASE_B = 1 / ((1 - SPLIT) ** 3 * (1 + SPLIT));
const slideEase = (u) => (u <= SPLIT ? EASE_A * u * u : 1 - EASE_B * (1 - u) ** 4);
// Cubic from a starting slope k (0 … 3) to a flat landing.
const hermite = (k) => (u) => k * u * (1 - u) * (1 - u) + u * u * (3 - 2 * u);
const slideTime = (d) => clamp(SLIDE_DURATION + SLIDE_PER_ROOM * (Math.abs(d) - 1), 0.6, SLIDE_MAX);

export function initGallery({ reducedMotion, lenis }) {
  const scene = document.querySelector('[data-scene="gallery"]');
  if (!scene || reducedMotion) return;

  const track = scene.querySelector('.gallery__track');
  const rooms = [...scene.querySelectorAll('.room')];
  if (!track || rooms.length === 0) return;
  const count = rooms.length;

  // Switch the layout to horizontal-pin mode, and force the reflow now so
  // the pin below is measured — and ordered — before the later scenes'
  // triggers (they start below this pin's spacer).
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
  let band = bandLength();   // px of page scroll per room
  let roomWidth = rooms[0].getBoundingClientRect().width || window.innerWidth;

  function bandLength() {
    const vh = window.innerHeight;
    // The scroll it takes, from a settled room, to call the next one:
    // about three wheel notches on a desktop, one normal swipe on a phone.
    const reach = coarse.matches ? clamp(vh * 0.42, 260, 400) : clamp(vh * 0.3, 220, 320);
    return Math.round(2 * (reach - HYSTERESIS_PX));
  }

  function measure() {
    roomWidth = rooms[0].getBoundingClientRect().width || window.innerWidth;
    parts.forEach(fitRoom);
    render();
  }

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

  // ── Slide engine ────────────────────────────────────────────────────
  // The track position (in rooms) is `base` plus the moves still running,
  // each easing its own distance over its own time on GSAP's clock.
  // Calling further rooms in the direction of travel adds a move to the
  // running ones, so the track keeps its speed and simply goes further
  // (no restart, no stop-and-go). Turning back, or finishing quickly as the
  // pin lets go, folds them into one move that starts at the current speed.
  // Either way the speed never jumps, and every move lands on a whole room.
  let base = 0;    // where the finished moves have taken the track
  let moves = [];  // { d, t0, T, ease, carry }
  let pos = 0;     // rendered position, in rooms (0 … count-1)
  let ticking = false;
  const now = () => gsap.ticker.time;

  function offsetAt(t) {
    let x = 0;
    for (const m of moves) {
      const u = clamp((t - m.t0) / m.T, 0, 1);
      x += m.d * m.ease(u) + m.carry * u * (1 - u) * (1 - u);
    }
    return x;
  }
  const velocityAt = (t) => (offsetAt(t + 0.004) - offsetAt(t - 0.004)) / 0.008; // rooms / s
  const destination = () => moves.reduce((x, m) => x + m.d, base);
  const landingIn = (t) => moves.reduce((l, m) => Math.max(l, m.t0 + m.T - t), 0);

  function tick() {
    const t = now();
    pos = base + offsetAt(t);
    moves = moves.filter((m) => {
      if (t - m.t0 < m.T) return true;
      base += m.d;
      return false;
    });
    if (!moves.length) {
      pos = base;
      ticking = false;
      gsap.ticker.remove(tick);
    }
    render();
  }

  // Slide to room `target`; returns the seconds until the track lands.
  function slideTo(target, { duration } = {}) {
    const t = now();
    const x = base + offsetAt(t);
    const v = velocityAt(t);
    const dest = destination();
    const along = Math.sign(dest - x) || Math.sign(v);
    const d = target - dest;

    if (duration == null && (!moves.length || (along && Math.sign(d) === along))) {
      // From rest, or further the same way: add this stretch as its own move.
      if (Math.abs(d) < 1e-6) return landingIn(t);
      moves.push({ d, t0: t, T: slideTime(d), ease: slideEase, carry: 0 });
    } else {
      // Turning back or finishing fast: one move from here, starting at the
      // current speed (it brakes first if that speed points the other way).
      const D = target - x;
      const T = duration ?? slideTime(D);
      base = x;
      if (Math.abs(D) < 1e-4 && Math.abs(v) < 0.01) moves = [];
      else if (duration != null && Math.abs(D) > 1e-4 && v * D >= 0) {
        moves = [{ d: D, t0: t, T, ease: hermite(clamp((v * T) / D, 0, 3)), carry: 0 }];
      } else {
        moves = [{ d: D, t0: t, T, ease: slideEase, carry: v * T }];
      }
    }
    if (!ticking && moves.length) { ticking = true; gsap.ticker.add(tick); }
    tick();
    return landingIn(t);
  }

  function jumpTo(target) {
    moves = [];
    base = pos = target;
    if (ticking) { ticking = false; gsap.ticker.remove(tick); }
    render();
  }

  function render() {
    track.style.transform = `translate3d(${(-pos * roomWidth).toFixed(2)}px, 0, 0)`;
    // Parallax: each layer drifts by its depth factor as its room crosses
    // the viewport (rel = +1 waiting on the right … -1 gone to the left),
    // so depth shows during the move and settles to 0 when the slide lands.
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
  function showContent(part, { dir = 1, delay = 0, instant = false } = {}) {
    part.shown = true;
    const { items } = part;
    if (!items.length) return;
    gsap.killTweensOf(items);
    if (instant) { gsap.set(items, { opacity: 1, x: 0, y: 0 }); return; }
    // Only items that are fully out start from the side; anything still
    // fading out turns around from where it is, at once (no flicker or
    // freeze when the reader turns back mid-slide).
    let resuming = false;
    items.forEach((el) => {
      if (gsap.getProperty(el, 'opacity') < 0.02) gsap.set(el, { x: REVEAL.x * dir, y: REVEAL.y });
      else resuming = true;
    });
    gsap.to(items, {
      opacity: 1, x: 0, y: 0,
      duration: REVEAL.duration,
      ease: 'power3.out',
      delay: resuming ? 0 : delay,
      stagger: { amount: Math.min(REVEAL.maxStagger, REVEAL.each * (items.length - 1)) },
      overwrite: true,
    });
  }

  function hideContent(part, { dir = 1, instant = false } = {}) {
    part.shown = false;
    const { items } = part;
    if (!items.length) return;
    gsap.killTweensOf(items);
    if (instant) { gsap.set(items, { opacity: 0, x: 0, y: 0 }); return; }
    gsap.to(items, {
      opacity: 0,
      x: -CONCEAL.x * dir,
      duration: CONCEAL.duration,
      ease: 'power1.in', // rides out with its slide, gone before it is
      stagger: { amount: CONCEAL.stagger },
      overwrite: true,
    });
  }

  // ── Active room ─────────────────────────────────────────────────────
  let active = -1;

  function setActive(next, { instant = false, duration } = {}) {
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
    const landing = slideTo(next, { duration });
    parts.forEach((p) => { if (p.index !== next && p.shown) hideContent(p, { dir }); });
    // The text lands with the slide: start it so it finishes as the move does.
    showContent(parts[next], { dir, delay: clamp(landing - 0.7, 0, 0.9) });
  }

  // ── Scroll → room ───────────────────────────────────────────────────
  let pending = null;      // room asked for by a dot / key while its scroll runs
  let pendingTimer = 0;
  let settleNeeded = false;
  let restTimer = 0;
  let touching = false;
  let gesture = null;      // a touch gesture (finger + its momentum): { room, y }
  let keepRoom = null;     // room to hold across a layout refresh

  const st = ScrollTrigger.create({
    trigger: scene,
    pin: true,
    start: 'top top',
    end: () => { band = bandLength(); return `+=${band * count}`; },
    anticipatePin: 1,
    invalidateOnRefresh: true,
    onRefresh: (self) => {
      measure();
      if (keepRoom !== null) return; // re-centred once the refresh is done
      const want = indexAt(window.scrollY, self);
      if (want !== active) setActive(want, { instant: true });
    },
    // A slide still moving as the pin lets go finishes quickly (from its
    // current speed), so the section barely travels diagonally on the way out.
    onLeave:     () => hurry(),
    onLeaveBack: () => hurry(),
  });

  // A resize re-lays the page out (the scenes above are sized in vh), so the
  // same scroll offset would land in another room: keep the reader's room
  // and re-centre the scroll on it in the new geometry instead.
  ScrollTrigger.addEventListener('refreshInit', () => {
    const y = window.scrollY;
    keepRoom = active >= 0 && y > st.start && y < st.end ? active : null;
  });
  ScrollTrigger.addEventListener('refresh', () => {
    if (keepRoom === null) return;
    const room = keepRoom;
    keepRoom = null;
    const centre = Math.round(st.start + (room + 0.5) * band);
    if (Math.abs(window.scrollY - centre) > 1) {
      if (lenis) lenis.scrollTo(centre, { immediate: true, force: true });
      else window.scrollTo({ top: centre, behavior: 'instant' });
    }
    if (room !== active) setActive(room, { instant: true });
  });

  function indexAt(y, self = st) {
    return clamp(Math.floor((y - self.start) / band), 0, count - 1);
  }

  // Where the scroll is heading: while Lenis smooths a wheel gesture its
  // target is already known, so the slide starts on the notch that calls
  // it rather than a second later. Only used while the pin holds the
  // section, so the pan never starts before the section has stopped.
  function intendedY() {
    const y = window.scrollY;
    if (lenis && lenis.isScrolling === 'smooth' && y >= st.start && y <= st.end) {
      return lenis.targetScroll;
    }
    return y;
  }

  function decide() {
    if (ScrollTrigger.isRefreshing) return;
    const y = window.scrollY;
    const inPin = y >= st.start && y <= st.end;
    let next = active;
    let passing = false;
    if (pending !== null && inPin) {
      next = pending;
    } else {
      const iy = intendedY();
      const p = (iy - st.start) / band;
      const h = HYSTERESIS_PX / band;
      if (p >= active + 1 + h) next = Math.floor(p - h);
      else if (p < active - h) next = Math.floor(p + h);
      // One swipe, one room: a touch gesture — finger plus native momentum,
      // whose length varies a lot between phones — moves on a single room
      // unless it is a long fling (≈2.5+ rooms of travel moves several).
      if (gesture && inPin) {
        const travel = Math.abs(y - gesture.y) / band;
        const reach = Math.max(1, Math.floor(travel - 0.5));
        next = clamp(next, gesture.room - reach, gesture.room + reach);
      }
      next = clamp(next, 0, count - 1);
      // Heading straight out of the gallery: land the end room quickly so
      // the slide is done before the section scrolls away.
      passing = inPin && (iy > st.end || iy < st.start);
    }
    if (next !== active) {
      setActive(next, passing ? { duration: LEAVE_DURATION } : undefined);
      if (pending === null) settleNeeded = true;
    } else if (passing) {
      hurry();
    }
  }

  // Finish a slide that would otherwise still be moving as the section
  // scrolls away (from its current speed, no jump).
  function hurry() {
    if (moves.length && landingIn(now()) > LEAVE_DURATION + 0.05) {
      slideTo(active, { duration: LEAVE_DURATION });
    }
  }

  // After a gesture that changed the room comes to rest, re-centre the
  // page scroll inside that room's band. The pinned picture does not move
  // (it is invisible), but the next swipe or few notches always needs the
  // same distance to call the next room — one normal gesture, one room.
  //
  // A swipe has ended only when its native momentum has: trust the
  // browser's scrollend where there is one (a busy main thread can go
  // quiet mid-fling), the quiet timer elsewhere.
  const hasScrollEnd = 'onscrollend' in window;
  let nativeEnded = false;
  window.addEventListener('scrollend', (e) => {
    if (e.detail?.lenisScrollEnd) return;
    nativeEnded = true;
    if (gesture && !touching) { clearTimeout(restTimer); restTimer = setTimeout(onRest, 40); }
  }, { passive: true });

  let lastScrollAt = 0;
  function onScrollActivity() {
    lastScrollAt = performance.now();
    nativeEnded = false;
    decide();
    clearTimeout(restTimer);
    restTimer = setTimeout(onRest, REST_MS);
  }

  function onRest() {
    const quiet = performance.now() - lastScrollAt;
    const need = gesture ? REST_TOUCH_MS : REST_MS;
    const flinging = gesture && hasScrollEnd && !nativeEnded && quiet < 1500;
    if (touching || (lenis && lenis.isScrolling === 'smooth') || quiet < need || flinging) {
      restTimer = setTimeout(onRest, Math.max(40, need - quiet));
      return;
    }
    gesture = null;
    if (!settleNeeded) return;
    settleNeeded = false;
    const y = window.scrollY;
    if (y <= st.start + 1 || y >= st.end - 1) return;
    const centre = Math.round(st.start + (active + 0.5) * band);
    if (Math.abs(centre - y) < 2) return;
    if (lenis) lenis.scrollTo(centre, { immediate: true, force: true });
    else window.scrollTo({ top: centre, behavior: 'instant' });
  }

  function clearPending() {
    pending = null;
    clearTimeout(pendingTimer);
  }

  // Dots, keys and focus: scroll the page to the middle of a room's band
  // and slide straight there (no sweep through the rooms in between).
  function goTo(j) {
    j = clamp(j, 0, count - 1);
    const y = Math.round(st.start + (j + 0.5) * band);
    gesture = null;
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
    decide();
  }

  if (lenis) {
    lenis.on('scroll', onScrollActivity);
    // Any wheel or touch input from the reader overrides a dot's target.
    lenis.on('virtual-scroll', () => { if (pending !== null) clearPending(); });
  } else {
    window.addEventListener('scroll', onScrollActivity, { passive: true });
  }
  window.addEventListener('touchstart', () => {
    touching = true;
    clearPending();
    gesture = { room: active, y: window.scrollY };
  }, { passive: true });
  const touchEnd = () => { touching = false; clearTimeout(restTimer); restTimer = setTimeout(onRest, REST_MS); };
  window.addEventListener('touchend', touchEnd, { passive: true });
  window.addEventListener('touchcancel', touchEnd, { passive: true });

  // Keyboard: arrows and Page Up / Down step one room while pinned. At the
  // first / last room the keys fall through to the page, so the reader
  // scrolls on out of the gallery as usual.
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (t && t !== document.body && t !== document.documentElement && !scene.contains(t)) return;
    const y = window.scrollY;
    if (y < st.start || y > st.end) return;
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

  // Initial state: the room the page is on (usually the first), settled.
  measure();
  setActive(indexAt(window.scrollY), { instant: true });
}
