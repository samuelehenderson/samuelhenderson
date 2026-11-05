/**
 * Digital Twin — full-screen viewer (phones, tablets, weak hardware).
 *
 * On these devices the page never builds the WebGL scene while the visitor
 * scrolls: the section shows the blueprint and a "Launch live 3D" button, and
 * the button opens this overlay. Only then are three.js, the simulation and
 * the HUD loaded and the model built, in slices with a progress bar, so the
 * page stays responsive throughout. Closing tears the scene down again (GPU
 * memory freed) and puts the visitor back exactly where they were.
 *
 *   const viewer = createTwinViewer({ reducedMotion, coarsePointer, lenis, onError })
 *   viewer.open(opener)   opener: the element focus returns to
 *   viewer.close()        also the phone's Back gesture and Escape
 *   viewer.isOpen() · viewer.destroy()
 *
 * The overlay is a modal dialog: the rest of the page is inert while it is
 * open, the page can't scroll under it, and a history entry means Back closes
 * it rather than leaving the site.
 */

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// One yield per heavy step: let a frame paint (the progress bar moves) and
// input run, then carry on. The timeout keeps going where rAF is throttled.
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

const ICON_CLOSE =
  '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>';

function el(tag, cls, attrs = {}) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  return n;
}

export function createTwinViewer({ reducedMotion = false, coarsePointer = false, lenis = null, onError = null } = {}) {
  let root = null;
  let ui = null;
  let open = false;
  let session = null;
  let seq = 0;
  let opener = null;
  let saved = null; // where the page was: { y, width, anchorTop }
  let pushed = false;
  let ignorePops = 0;
  let inerted = [];
  let prevRestoration = null;

  /* ── DOM (built once, on first open) ─────────────────────── */

  function build() {
    // data-lenis-prevent: where smooth scroll runs (fine-pointer desktops), Lenis leaves the
    // viewer's own wheel and touch input alone (zoom, the sheet's and card's scrolling)
    root = el('div', 'twin-viewer', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'twv-title', 'data-lenis-prevent': '', hidden: '' });
    const bar = el('header', 'twv-bar');
    const titleWrap = el('div', 'twv-title');
    const title = el('h2', 'twv-title__name', { id: 'twv-title', text: 'Digital twin' });
    const status = el('div', 'twv-status');
    titleWrap.append(title, status);
    const close = el('button', 'twv-close', { type: 'button', 'aria-label': 'Close the live 3D model', html: `${ICON_CLOSE}<span>Close</span>` });
    bar.append(titleWrap, close);

    const loading = el('div', 'twv-loading', { role: 'status' });
    const loadLabel = el('p', 'twv-loading__label', { text: 'Loading the live model' });
    const loadPct = el('span', 'twv-loading__pct', { 'aria-hidden': 'true', text: '0%' });
    const loadTrack = el('div', 'twv-loading__bar', { 'aria-hidden': 'true' });
    loadTrack.append(el('i'));
    const loadHead = el('div', 'twv-loading__row');
    loadHead.append(loadLabel, loadPct);
    const loadNote = el('p', 'twv-loading__note', { text: 'A simulated building, assembled in your browser.' });
    loading.append(loadHead, loadTrack, loadNote);

    const error = el('div', 'twv-error', { role: 'alert', hidden: '' });
    const errText = el('p', 'twv-error__text', { text: "The live 3D model couldn't start on this device." });
    const errClose = el('button', 'twv-error__close', { type: 'button', text: 'Back to the page' });
    error.append(errText, errClose);

    root.append(bar, loading, error);
    document.body.append(root);

    close.addEventListener('click', () => close_());
    errClose.addEventListener('click', () => close_());
    ui = { bar, status, close, loading, loadLabel, loadPct, loadTrack, error, errText };
  }

  function setProgress(f, label) {
    if (!ui) return;
    const v = Math.max(0, Math.min(1, +f || 0));
    // never runs backwards (several steps report into the same bar)
    const cur = +ui.loading.style.getPropertyValue('--p') || 0;
    const next = Math.max(cur, v);
    ui.loading.style.setProperty('--p', next.toFixed(3));
    ui.loadPct.textContent = `${Math.round(next * 100)}%`;
    if (label && ui.loadLabel.textContent !== label) ui.loadLabel.textContent = label;
  }

  /* ── page lock: scroll, inert, history ───────────────────── */

  function lockPage() {
    const sect = document.getElementById('twin');
    saved = {
      y: window.scrollY,
      width: window.innerWidth,
      anchorTop: sect ? sect.getBoundingClientRect().top + window.scrollY : null,
    };
    lenis?.stop?.();
    const html = document.documentElement;
    const sbw = window.innerWidth - html.clientWidth;
    if (sbw > 0) html.style.setProperty('--twv-sbw', `${sbw}px`);
    html.classList.add('twin-viewer-open');
    inerted = [];
    for (const n of document.body.children) {
      if (n === root || n.inert || n.tagName === 'SCRIPT') continue;
      n.inert = true;
      inerted.push(n);
    }
  }

  function restoreScroll() {
    if (!saved) return;
    let y = saved.y;
    // the page re-laid itself out (a rotation while the viewer was open): keep the same spot in the section
    if (window.innerWidth !== saved.width && saved.anchorTop != null) {
      const sect = document.getElementById('twin');
      if (sect) y = sect.getBoundingClientRect().top + window.scrollY + (saved.y - saved.anchorTop);
    }
    if (Math.abs(window.scrollY - y) > 0.5) window.scrollTo({ top: y, left: 0, behavior: 'instant' });
  }

  function unlockPage() {
    const html = document.documentElement;
    html.classList.remove('twin-viewer-open');
    html.style.removeProperty('--twv-sbw');
    for (const n of inerted) n.inert = false;
    inerted = [];
    restoreScroll();
    lenis?.start?.();
  }

  const onPop = () => {
    if (ignorePops > 0) {
      // our own history.back() after a close: just make sure the page is where it was
      ignorePops--;
      restoreScroll();
      if (prevRestoration && !ignorePops) {
        try {
          history.scrollRestoration = prevRestoration;
        } catch {
          /* ignore */
        }
        prevRestoration = null;
      }
      return;
    }
    if (open) {
      pushed = false; // the browser already popped our entry
      close_();
    }
  };

  // Escape after the HUD has had its turn (menu → card → viewer)
  const onKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !open) return;
    e.preventDefault();
    close_();
  };

  const onVisibility = () => {
    if (session?.app) session.app.setVisible(!document.hidden);
  };

  /* ── session: load, build, run ───────────────────────────── */

  // Where the HUD leaves the building room: strip + bar on top, sheet at the bottom
  // (or at the side on short landscape screens). The collapsed sheet is the
  // reference; `card` is the bottom inset while a card is open.
  function insetsFor(s) {
    const r = root.getBoundingClientRect();
    const out = { top: 0, right: 0, bottom: 0, left: 0, card: 0 };
    const hud = s.hudRoot;
    const status = hud.querySelector('.thud-status');
    const sheet = hud.querySelector('.thud-sheet');
    const card = hud.querySelector('.thud-card.is-open');
    if (!status || !sheet) return out;
    const barB = ui.bar.getBoundingClientRect().bottom - r.top;
    if (!window.matchMedia('(max-width: 1099.98px)').matches) {
      out.top = barB;
      return out;
    }
    out.top = Math.max(barB, status.getBoundingClientRect().bottom - r.top) + 6;
    const collapsed = !hud.classList.contains('is-expanded') && !hud.classList.contains('has-card');
    if (collapsed || !s.sheetInset) {
      const sh = sheet.getBoundingClientRect();
      if (sh.width && sh.width < r.width * 0.6 && sh.left > r.width * 0.4) {
        // side column (short landscape): the building sits left of it
        s.sheetInset = { right: r.right - sh.left + 6, bottom: 8 };
      } else if (sh.height) {
        s.sheetInset = { right: 0, bottom: r.bottom - sh.top + 6 };
      }
    }
    if (s.sheetInset) {
      out.right = s.sheetInset.right;
      out.bottom = s.sheetInset.bottom;
    }
    // layout position (offsetTop), not the card's slide-in transform
    if (card && !out.right) out.card = r.height - card.offsetTop + 6;
    return out;
  }

  async function runSession(s) {
    const alive = () => session === s && !s.aborted;
    setProgress(0.03, 'Loading the 3D engine');
    // let the overlay paint before anything heavy starts
    await nextFrame();
    await nextFrame();
    if (!alive()) return;

    const hudP = import('../twin/hud.js');
    const simP = import('../twin/sim.js');
    const appP = import('../twin/app.js');
    for (const p of [hudP, simP, appP]) p.catch(() => {});
    let got = 0;
    for (const p of [hudP, simP, appP]) p.then(() => setProgress(0.04 + 0.08 * ++got), () => {});

    const [{ createHud }, { createSim }, { mountTwin }] = await Promise.all([hudP, simP, appP]);
    if (!alive()) return;
    await breathe();
    if (!alive()) return;

    s.hud = createHud(s.hudRoot, { reducedMotion, coarsePointer, viewer: true, headSlot: ui.status });
    s.hud.setIntroProgress(1);
    await breathe();
    if (!alive()) return;

    setProgress(0.15, 'Settling the building');
    s.sim = createSim({ seed: 7, startHour: 9.5, deferPreroll: true });
    if (s.sim.preroll) await s.sim.preroll(breathe, 80);
    if (!alive()) return;
    s.hud.setState(s.sim.state, s.sim.layout);
    await breathe();
    if (!alive()) return;

    s.app = await mountTwin({
      stage: s.stage,
      canvasHost: s.canvasHost,
      hud: s.hud,
      sim: s.sim,
      reducedMotion,
      coarsePointer,
      viewer: true,
      pause: breathe,
      signal: s,
      onProgress: (f, label) => alive() && setProgress(0.2 + 0.78 * f, label),
      frameInsets: () => insetsFor(s),
    });
    if (!alive()) {
      s.app?.destroy();
      s.app = null;
      return;
    }
    setProgress(1, 'Ready');
    s.hud.setReady();
    s.app.setVisible(!document.hidden);
    s.app.refreshFrame();
    s.app.playIntro(1700);
    root.classList.add('is-live');
    ui.loading.hidden = true;
    // the strip settles once the first readings are in: frame the building in what's left
    setTimeout(() => alive() && s.app?.refreshFrame(), 400);
  }

  function endSession() {
    const s = session;
    session = null;
    if (!s) return;
    s.aborted = true;
    try {
      s.app?.destroy();
    } catch {
      /* ignore */
    }
    try {
      s.hud?.destroy();
    } catch {
      /* ignore */
    }
    s.app = null;
    s.hud = null;
    s.sim = null;
    s.stage.remove();
    ui.status.replaceChildren();
  }

  /* ── open / close ────────────────────────────────────────── */

  function open_(from) {
    if (open) return;
    if (!root) build();
    open = true;
    opener = from || document.activeElement;

    lockPage();
    root.hidden = false;
    root.classList.remove('is-live', 'has-error');
    ui.error.hidden = true;
    ui.loading.hidden = false;
    ui.loading.style.setProperty('--p', '0');
    ui.loadPct.textContent = '0%';
    requestAnimationFrame(() => open && root.classList.add('is-open'));
    ui.close.focus({ preventScroll: true });

    try {
      prevRestoration = history.scrollRestoration;
      history.scrollRestoration = 'manual';
      history.pushState({ ...(history.state || {}), twinViewer: true }, '');
      pushed = true;
    } catch {
      pushed = false;
    }
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVisibility);

    // a fresh stage per session: nothing from an abandoned load can touch the next one
    const stage = el('div', 'twv-stage');
    const canvasHost = el('div', 'twin__canvas-host', {
      role: 'img',
      'aria-label': 'Interactive 3D model of a simulated six-storey office building. Drag to orbit, pinch to zoom, tap a zone or machine for its live readings.',
    });
    const hudRoot = el('div', 'twin__hud');
    stage.append(canvasHost, hudRoot);
    root.insertBefore(stage, ui.bar);
    const s = { id: ++seq, aborted: false, stage, canvasHost, hudRoot, hud: null, sim: null, app: null };
    session = s;
    runSession(s).catch((err) => {
      if (session !== s || s.aborted || err?.name === 'AbortError') return;
      console.warn('[twin] Live model unavailable in the viewer.', err);
      endSession();
      root.classList.add('has-error');
      ui.loading.hidden = true;
      ui.error.hidden = false;
      ui.error.querySelector('button')?.focus({ preventScroll: true });
      try {
        onError?.(err);
      } catch {
        /* ignore */
      }
    });
  }

  function close_() {
    if (!open) return;
    open = false;
    endSession();
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVisibility);
    root.classList.remove('is-open', 'is-live');
    root.hidden = true;
    unlockPage();
    if (pushed) {
      pushed = false;
      if (history.state?.twinViewer) {
        ignorePops++;
        history.back();
      }
    } else if (prevRestoration) {
      try {
        history.scrollRestoration = prevRestoration;
      } catch {
        /* ignore */
      }
      prevRestoration = null;
    }
    // popstate (ours) arrives after this; keep listening until it has
    if (!ignorePops) window.removeEventListener('popstate', onPop);
    const back = opener;
    opener = null;
    if (back && back.isConnected) back.focus({ preventScroll: true });
    // focus or a late layout pass must not have moved the page
    requestAnimationFrame(restoreScroll);
  }

  return {
    open: open_,
    close: close_,
    isOpen: () => open,
    destroy() {
      close_();
      window.removeEventListener('popstate', onPop);
      root?.remove();
      root = null;
      ui = null;
    },
  };
}
