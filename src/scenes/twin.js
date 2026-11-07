import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

/**
 * Scene 6 — Digital Twin
 *
 * A live, simulated office building in WebGL. This module is only the
 * loader and conductor; the heavy parts arrive lazily:
 *
 *   ../twin/hud.js  DOM heads-up display (tiny)
 *   ../twin/sim.js  headless building simulation
 *   ../twin/app.js  three.js scene
 *   ../twin/units/  ClarityView's equipment models (the units chunk; three is shared with app.js)
 *
 * Nothing loads until the section is within one viewport of the screen,
 * so the initial bundle doesn't grow.
 *
 * Scroll progress p ∈ [0, 1] across the sticky stage drives the intro:
 *   0.00–0.45  the building assembles (app.setScrollProgress)
 *   0.28–0.50  the intro copy fades and lifts away
 *   0.44–0.62  the HUD fades in (hud.setIntroProgress)
 *   ≥ 0.55     fully live and interactive
 *
 * Reduced motion: the model mounts assembled (p is pinned at 1 for the app)
 * and the copy/HUD cross-fade by opacity only. Without WebGL, or if anything
 * throws, the blueprint poster stays up and nothing reaches the console
 * unhandled.
 */

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// three.js (r163+) only runs on WebGL2: probe exactly that, so a WebGL1-only
// browser gets the blueprint without downloading three at all
function hasWebGL() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

// The lead's last sentence, by situation
const LEAD_TAIL = {
  live: 'Scroll to build it, then take the controls.',
  reduced: 'Scroll on to take the controls.',
  fallback: 'Open this page in a WebGL-capable browser to run it live.',
  'save-data': 'Load the live model below to run it.',
};

const FALLBACK_COPY = {
  webgl: "The live 3D model needs WebGL, which isn't available here, so this is the blueprint of the same building.",
  error: "The live 3D model couldn't start on this device, so this is the blueprint of the same building.",
  'save-data': 'Data Saver is on, so the live 3D model (three.js plus the simulation) hasn’t been downloaded. This is its blueprint.',
};

export function initTwin({ reducedMotion = false } = {}) {
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
  // Reduced motion mounts the model already built: don't promise a build
  if (reducedMotion) {
    setLeadTail('reduced');
    const cueText = cue?.querySelector('span:not(.twin__cue-line)');
    if (cueText) cueText.textContent = 'Scroll for the controls';
  }

  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  stage.classList.add('is-js');
  if (reducedMotion) stage.classList.add('is-reduced');

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

  const onHudFocus = () => {
    if (state === 'fallback' || progress >= 0.6) return;
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
    // the equipment models download in parallel with the app (mountTwin awaits them)
    const unitsP = import('../twin/units/index.js');
    // Mark as handled up front; failures are caught where they're awaited.
    for (const p of [hudP, simP, appP, unitsP]) p.catch(() => {});

    try {
      const { createHud } = await hudP;
      if (destroyed) return;
      hud = createHud(hudRoot, { reducedMotion, coarsePointer });
      wireHud(hud);
      let frac = 0.08;
      const bump = (d) => {
        frac = Math.min(0.94, frac + d);
        if (state === 'loading') hud?.setLoading(frac);
      };
      hud.setLoading(frac);
      hud.setIntroProgress(progress);
      simP.then(() => bump(0.12), () => {});
      appP.then(() => bump(0.4), () => {});
      unitsP.then(() => bump(0.15), () => {});

      const [{ createSim }, { mountTwin }] = await Promise.all([simP, appP]);
      if (destroyed) return;

      sim = createSim({ seed: 7, startHour: 9.5 });
      hud.setState(sim.state, sim.layout);

      const mounted = await mountTwin({ stage, canvasHost, hud, sim, reducedMotion, coarsePointer, unitsP });
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
      if (destroyed) return;
      console.warn('[twin] Live model unavailable; showing the blueprint instead.', err);
      showFallback('error');
    }
  }

  const loadIO = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      loadIO.disconnect();
      start();
    },
    { rootMargin: '100% 0px' },
  );
  loadIO.observe(section);
  offs.push(() => loadIO.disconnect());

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
