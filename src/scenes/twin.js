import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { createTwinViewer } from './twin-viewer.js';

/**
 * Scene 6 — Digital Twin
 *
 * A live, simulated office building in WebGL. This module is only the
 * loader and conductor; the heavy parts arrive lazily:
 *
 *   ../twin/hud.js  DOM heads-up display (tiny)
 *   ../twin/sim.js  headless building simulation
 *   ../twin/app.js  three.js scene (the only module that imports three)
 *
 * Two presentations, picked once at load:
 *
 * Inline (desktop, fine pointer): a tall section with a sticky stage. Nothing
 * loads until the section is near; then the model is built in slices (a
 * yield between every heavy step) and scroll progress p ∈ [0, 1] drives the
 * intro:
 *   0.00–0.45  the building assembles (app.setScrollProgress)
 *   0.28–0.50  the intro copy fades and lifts away
 *   0.44–0.62  the HUD fades in (hud.setIntroProgress)
 *   ≥ 0.55     fully live and interactive
 *
 * Launch (phones, tablets, any touch-first screen, narrow windows, weak
 * hardware): the section is short and in normal flow. The blueprint poster is
 * the hero (it draws itself in as it scrolls into view, CSS/SVG only) with a
 * "Launch live 3D" button; WebGL never runs while the page scrolls. Launch
 * opens the full-screen viewer (./twin-viewer.js), which builds the model
 * there and tears it down again on close.
 *
 * Reduced motion: the model mounts assembled (p is pinned at 1 for the app)
 * and the copy/HUD cross-fade by opacity only; the poster is drawn from the
 * start. Without WebGL, or if anything throws, the blueprint poster stays up
 * and nothing reaches the console unhandled.
 *
 * ?twin=inline / ?twin=launch forces a presentation (testing).
 */

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// three.js (r163+) only runs on WebGL2. A real probe would create (and throw
// away) a whole GL context on the main thread; the renderer's own creation is
// already guarded, so the interface check is enough to skip the download.
const hasWebGL = () => typeof window.WebGL2RenderingContext !== 'undefined';

// One yield between heavy steps of the inline mount (see app.js)
const breathe = () =>
  new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 120);
  });

/** 'inline' | 'launch' */
function pickPresentation() {
  try {
    const q = new URLSearchParams(window.location.search).get('twin');
    if (q === 'inline' || q === 'launch') return q;
  } catch {
    /* ignore */
  }
  const mm = (q) => window.matchMedia(q).matches;
  const touchFirst = mm('(pointer: coarse)') || mm('(hover: none)');
  const narrow = window.innerWidth < 720;
  const mem = navigator.deviceMemory;
  const cores = navigator.hardwareConcurrency;
  const weak = (mem && mem < 4) || (cores && cores < 4);
  return touchFirst || narrow || weak ? 'launch' : 'inline';
}

// The lead's last sentence, by situation
const LEAD_TAIL = {
  live: 'Scroll to build it, then take the controls.',
  reduced: 'Scroll on to take the controls.',
  fallback: 'Open this page in a WebGL-capable browser to run it live.',
  'save-data': 'Load the live model below to run it.',
  launch: 'Launch it full-screen to take the controls.',
};

const FALLBACK_COPY = {
  webgl: "The live 3D model needs WebGL, which isn't available here, so this is the blueprint of the same building.",
  error: "The live 3D model couldn't start on this device, so this is the blueprint of the same building.",
  'save-data': 'Data Saver is on, so the live 3D model (three.js plus the simulation) hasn’t been downloaded. This is its blueprint.',
};

const ICON_LAUNCH =
  '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 2.6 16.6 6.3v7.4L10 17.4 3.4 13.7V6.3z"/><path d="M3.6 6.4 10 10l6.4-3.6M10 10v7.2"/></g></svg>';

export function initTwin({ reducedMotion = false, lenis = null } = {}) {
  const section = document.querySelector('[data-scene="twin"]');
  if (!section) return () => {};

  const stage = section.querySelector('.twin__stage');
  const canvasHost = section.querySelector('.twin__canvas-host');
  const hudRoot = section.querySelector('[data-twin-hud]');
  const intro = section.querySelector('.twin__intro');
  const cue = section.querySelector('.twin__cue');
  const lead = section.querySelector('.twin__lead');
  const note = section.querySelector('[data-twin-fallback-note]');
  if (!stage || !canvasHost || !hudRoot) return () => {};

  const setLeadTail = (key) => {
    if (!lead) return;
    const tails = Object.values(LEAD_TAIL);
    const text = lead.textContent.trim();
    const cur = tails.find((t) => text.endsWith(t));
    const base = cur ? text.slice(0, -cur.length).trimEnd() : text;
    lead.textContent = `${base} ${LEAD_TAIL[key]}`;
  };

  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  stage.classList.add('is-js');
  if (reducedMotion) stage.classList.add('is-reduced');

  if (pickPresentation() === 'launch') return initLaunch();
  return initInline();

  /* ═══════════════════════════════════════════════════════════
     Launch: blueprint hero + a button that opens the viewer
     ═══════════════════════════════════════════════════════════ */

  function initLaunch() {
    const offs = [];
    section.classList.add('is-launch');
    stage.classList.add('is-launch');
    setLeadTail('launch');

    // the action sits under the poster
    const launch = document.createElement('div');
    launch.className = 'twin__launch';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'twin__launch-btn';
    btn.innerHTML = `${ICON_LAUNCH}<span>Launch live 3D</span>`;
    const launchNote = document.createElement('p');
    launchNote.className = 'twin__launch-note';
    launchNote.textContent = 'A live simulated building. It opens full-screen, right in your browser.';
    launch.append(btn, launchNote);
    stage.append(launch);

    const showUnavailable = (reason) => {
      btn.remove();
      launch.classList.add('is-unavailable');
      launchNote.textContent = FALLBACK_COPY[reason] || FALLBACK_COPY.error;
      setLeadTail('fallback');
    };

    let viewer = null;
    if (!hasWebGL()) {
      showUnavailable('webgl');
    } else {
      viewer = createTwinViewer({
        reducedMotion,
        coarsePointer,
        lenis,
        onError: () => showUnavailable('error'),
      });
      btn.addEventListener('click', () => viewer.open(btn));
      offs.push(() => viewer.destroy());
    }

    /* scroll-linked draw-in of the blueprint (style only: one custom property) */
    const poster = section.querySelector('.twin-poster');
    if (poster) {
      // every animated stroke measures 1 so its dash offset reads as "fraction drawn"
      const slabs = [...poster.querySelectorAll('.twin-poster__slab')];
      const runs = [...poster.querySelectorAll('.twin-poster__run')];
      [...slabs, ...runs].forEach((p) => p.setAttribute('pathLength', '1'));
      // slabs draw bottom-up (their document order), the services after
      slabs.forEach((p, i) => p.style.setProperty('--d', (i * 0.07).toFixed(3)));
      runs.forEach((p, i) => p.style.setProperty('--d', (0.34 + (i % 9) * 0.03).toFixed(3)));
      poster.classList.add('is-drawable');

      const setDraw = (p) => {
        const v = clamp01(p);
        poster.style.setProperty('--draw', v.toFixed(3));
        poster.classList.toggle('is-drawn', v >= 0.98);
      };
      if (reducedMotion) {
        setDraw(1);
      } else {
        setDraw(0);
        let st = null;
        const raf = requestAnimationFrame(() => {
          st = ScrollTrigger.create({
            trigger: poster,
            start: 'top 96%',
            end: 'center 52%',
            onUpdate: (self) => setDraw(self.progress),
            onRefresh: (self) => setDraw(self.progress),
          });
        });
        offs.push(() => {
          cancelAnimationFrame(raf);
          st?.kill();
        });
      }
      // the poster's looping flow / fan / alarm animations only run while it is on screen
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) poster.classList.toggle('is-inview', e.isIntersecting);
      });
      io.observe(poster);
      offs.push(() => io.disconnect());
    }

    return function destroy() {
      offs.forEach((off) => {
        try {
          off();
        } catch {
          /* ignore */
        }
      });
      launch.remove();
    };
  }

  /* ═══════════════════════════════════════════════════════════
     Inline: the sticky, scroll-built stage (desktop)
     ═══════════════════════════════════════════════════════════ */

  function initInline() {
    // Reduced motion mounts the model already built: don't promise a build
    if (reducedMotion) {
      setLeadTail('reduced');
      const cueText = cue?.querySelector('span:not(.twin__cue-line)');
      if (cueText) cueText.textContent = 'Scroll for the controls';
    }

    let hud = null;
    let sim = null;
    let app = null;
    let progress = 0;
    let inView = false;
    let state = 'idle'; // idle → loading → ready | fallback
    let destroyed = false;
    const offs = [];

    const safe = (fn) => {
      try {
        return fn();
      } catch (err) {
        if (import.meta.env.DEV) console.warn('[twin]', err);
        return undefined;
      }
    };

    /* ── scroll progress ───────────────────────────────────────── */

    function applyProgress(p) {
      progress = clamp01(p);
      if (state !== 'fallback') {
        if (intro) {
          const t = smoothstep(0.28, 0.5, progress);
          intro.style.opacity = (1 - t).toFixed(3);
          intro.style.transform = reducedMotion || t === 0 ? '' : `translate3d(0, ${(-56 * t).toFixed(1)}px, 0)`;
        }
        if (cue) cue.style.opacity = (1 - smoothstep(0.02, 0.16, progress)).toFixed(3);
      }
      if (hud) safe(() => hud.setIntroProgress(progress));
      if (app) safe(() => app.setScrollProgress(reducedMotion ? 1 : progress));
    }

    // Created a frame late and refreshed last: the gallery above pins itself
    // inside a requestAnimationFrame, and this section's start must include
    // that pin's spacer.
    let trigger = null;
    let tween = null;
    const createTrigger = () => {
      if (destroyed) return;
      const st = {
        trigger: section,
        start: 'top top',
        end: 'bottom bottom',
        refreshPriority: -1,
        invalidateOnRefresh: true,
      };
      if (reducedMotion) {
        trigger = ScrollTrigger.create({
          ...st,
          onUpdate: (self) => applyProgress(self.progress),
          onRefresh: (self) => applyProgress(self.progress),
        });
      } else {
        const proxy = { p: 0 };
        tween = gsap.to(proxy, {
          p: 1,
          ease: 'none',
          onUpdate: () => applyProgress(proxy.p),
          scrollTrigger: { ...st, scrub: 0.6 },
        });
        trigger = tween.scrollTrigger;
      }
      // A refreshPriority makes ScrollTrigger re-sort every trigger into page
      // order on its next full refresh (normally the one main.js runs on
      // 'load'). If the page has already loaded, run that refresh now so the
      // order never depends on load timing.
      if (document.readyState === 'complete') ScrollTrigger.refresh();
      applyProgress(trigger?.progress ?? 0);
    };
    const triggerRaf = requestAnimationFrame(createTrigger);
    offs.push(() => {
      cancelAnimationFrame(triggerRaf);
      tween?.kill();
      trigger?.kill();
    });
    applyProgress(0);

    /* ── visibility: render only while on screen and the tab is visible ── */

    function syncVisible() {
      const visible = inView && !document.hidden;
      if (app) safe(() => app.setVisible(visible));
    }

    const visIO = new IntersectionObserver(
      (entries) => {
        for (const e of entries) inView = e.isIntersecting;
        syncVisible();
        // Leaving the section always hands scrolling back to touch users.
        if (!inView && hud?.isExploring?.()) safe(() => hud.setExploring(false, true));
      },
      { threshold: 0 },
    );
    visIO.observe(section);
    offs.push(() => visIO.disconnect());

    const onVisibility = () => syncVisible();
    document.addEventListener('visibilitychange', onVisibility);
    offs.push(() => document.removeEventListener('visibilitychange', onVisibility));

    /* ── keyboard: tabbing into the HUD jumps to the live, built model ── */

    // Keyboard focus only: a tapped or clicked button also takes focus, and that
    // must never yank the page forward (or keep the HUD lit after scrolling back).
    const onHudFocus = () => {
      if (state === 'fallback' || progress >= 0.6) return;
      if (!hudRoot.querySelector(':focus-visible')) return;
      const r = section.getBoundingClientRect();
      const top = window.scrollY + r.top + 0.65 * Math.max(0, section.offsetHeight - window.innerHeight);
      window.scrollTo({ top, behavior: 'instant' });
    };
    hudRoot.addEventListener('focusin', onHudFocus);
    offs.push(() => hudRoot.removeEventListener('focusin', onHudFocus));

    /* ── fallback (no WebGL, Data Saver, or a failure) ─────────── */

    function showFallback(reason) {
      state = 'fallback';
      stage.classList.remove('is-loading', 'is-ready', 'is-exploring');
      stage.classList.add('is-fallback');
      setLeadTail(reason === 'save-data' ? 'save-data' : 'fallback');
      // the section shrinks to one screen (twin.css): re-measure the triggers below it
      requestAnimationFrame(() => safe(() => ScrollTrigger.refresh()));
      if (app) safe(() => app.destroy());
      app = null;
      if (hud) safe(() => hud.destroy());
      hud = null;
      if (intro) {
        intro.style.opacity = '';
        intro.style.transform = '';
      }
      if (cue) cue.style.opacity = '';
      if (!note) return;
      note.textContent = FALLBACK_COPY[reason] || FALLBACK_COPY.error;
      if (reason === 'save-data') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'twin__fallback-load';
        btn.textContent = 'Load live model →';
        btn.addEventListener('click', () => {
          stage.classList.remove('is-fallback');
          setLeadTail(reducedMotion ? 'reduced' : 'live');
          state = 'idle';
          requestAnimationFrame(() => safe(() => ScrollTrigger.refresh()));
          start({ force: true });
        });
        note.append(document.createElement('br'), btn);
      }
    }

    /* ── hud ↔ page wiring ─────────────────────────────────────── */

    function wireHud(h) {
      // Touch: the canvas only captures one-finger drags while exploring.
      h.on('explore', (on) => stage.classList.toggle('is-exploring', !!on));
      // Everything else (mode, time, play, speed, faults, camera, cards) is
      // handled by app.js, which subscribes to the same HUD.
    }

    /* ── lazy load + mount ─────────────────────────────────────── */

    const signal = {
      get aborted() {
        return destroyed;
      },
    };

    async function start({ force = false } = {}) {
      if (state !== 'idle' || destroyed) return;
      if (!hasWebGL()) {
        showFallback('webgl');
        return;
      }
      if (!force && navigator.connection?.saveData === true) {
        showFallback('save-data');
        return;
      }

      state = 'loading';
      stage.classList.add('is-loading');

      const hudP = import('../twin/hud.js');
      const simP = import('../twin/sim.js');
      const appP = import('../twin/app.js');
      // Mark as handled up front; failures are caught where they're awaited.
      for (const p of [hudP, simP, appP]) p.catch(() => {});

      try {
        const { createHud } = await hudP;
        if (destroyed) return;
        hud = createHud(hudRoot, { reducedMotion, coarsePointer });
        wireHud(hud);
        let frac = 0.06;
        const bump = (f) => {
          frac = Math.min(0.97, Math.max(frac, f));
          if (state === 'loading') hud?.setLoading(frac);
        };
        hud.setLoading(frac);
        hud.setIntroProgress(progress);
        simP.then(() => bump(0.1), () => {});
        appP.then(() => bump(0.2), () => {});

        const [{ createSim }, { mountTwin }] = await Promise.all([simP, appP]);
        if (destroyed) return;

        await breathe();
        sim = createSim({ seed: 7, startHour: 9.5, deferPreroll: true });
        if (sim.preroll) await sim.preroll(breathe, 120);
        if (destroyed) return;
        hud.setState(sim.state, sim.layout);
        bump(0.25);

        const mounted = await mountTwin({
          stage,
          canvasHost,
          hud,
          sim,
          reducedMotion,
          coarsePointer,
          pause: breathe,
          signal,
          onProgress: (f) => bump(0.25 + 0.72 * f),
        });
        if (destroyed) {
          safe(() => mounted?.destroy?.());
          return;
        }
        if (!mounted || typeof mounted.setScrollProgress !== 'function') throw new Error('mountTwin returned no app');
        app = mounted;

        state = 'ready';
        stage.classList.remove('is-loading');
        stage.classList.add('is-ready');
        hud.setReady();
        applyProgress(progress);
        syncVisible();
      } catch (err) {
        if (destroyed || err?.name === 'AbortError') return;
        console.warn('[twin] Live model unavailable; showing the blueprint instead.', err);
        showFallback('error');
      }
    }

    // Start a little ahead of the section, when the browser is idle, so the
    // (already sliced) build is done before the visitor gets there.
    let idleId = 0;
    const kick = () => {
      if (destroyed) return;
      if ('requestIdleCallback' in window) idleId = window.requestIdleCallback(() => start(), { timeout: 600 });
      else start();
    };
    const loadIO = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        loadIO.disconnect();
        kick();
      },
      { rootMargin: '150% 0px' },
    );
    loadIO.observe(section);
    offs.push(() => {
      loadIO.disconnect();
      if (idleId) window.cancelIdleCallback?.(idleId);
    });

    return function destroy() {
      destroyed = true;
      offs.forEach((off) => safe(off));
      if (app) safe(() => app.destroy());
      if (hud) safe(() => hud.destroy());
      app = null;
      hud = null;
      sim = null;
    };
  }
}
