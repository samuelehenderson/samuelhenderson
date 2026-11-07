/**
 * The contact room's window: light snow falling past the glass in three
 * depth layers (near flakes larger, faster, softer; a slow wind sway), and a
 * few early stars twinkling over the range.
 *
 * One small canvas inside the view (.cx-view__drift), so it rides the view's
 * own parallax; the window opening (.cx-window) clips it to the glass. The
 * mountains and sky stay static SVG; only flakes and twinkles are drawn.
 *
 *  - starts after load and the first contentful paint, in idle time; never
 *    blocks the page
 *  - devicePixelRatio capped, flake count scaled to the glass area (fewer on
 *    phones), ~30 draws a second
 *  - paused while the window is off screen or the tab is hidden
 *  - prefers-reduced-motion: one still, snow-dotted frame, no loop
 */

const PX_PER_FLAKE = 780;  // one flake per ~28×28 px of glass
const MAX_FLAKES = 170;
const MIN_FLAKES = 18;
const FRAME_MS = 30;

// share, radius (px at a 310 px wide glass), fall (glass heights / s), alpha, sway px, sway Hz, wind factor
const DEPTHS = [
  { share: 0.46, r: [0.6, 1.0], vy: [0.06, 0.085], a: [0.4, 0.62], amp: [1.5, 3.5], hz: [0.3, 0.6], wind: 0.45, soft: false },
  { share: 0.36, r: [1.1, 1.7], vy: [0.1, 0.14], a: [0.6, 0.85], amp: [3, 7], hz: [0.2, 0.45], wind: 0.8, soft: false },
  { share: 0.18, r: [2.2, 3.3], vy: [0.17, 0.24], a: [0.5, 0.75], amp: [7, 13], hz: [0.14, 0.3], wind: 1.25, soft: true },
];

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

function sprite(soft) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  if (soft) {
    grad.addColorStop(0, 'rgba(242,244,255,0.95)');
    grad.addColorStop(0.45, 'rgba(228,232,255,0.4)');
    grad.addColorStop(1, 'rgba(228,232,255,0)');
  } else {
    grad.addColorStop(0, 'rgba(250,251,255,1)');
    grad.addColorStop(0.4, 'rgba(236,240,255,0.85)');
    grad.addColorStop(1, 'rgba(236,240,255,0)');
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return c;
}

export function initContactWindow(scene, { reducedMotion }) {
  const win = scene.querySelector('.cx-window');
  const host = win && win.querySelector('.cx-view__drift');
  const art = host && host.querySelector('.cx-view__art');
  if (!win || !host || !art) return;

  const begin = () => {
    try {
      start(win, host, art, reducedMotion);
    } catch (err) {
      // the view still reads as a still evening without the canvas
      if (import.meta.env.DEV) console.warn('contact window:', err);
    }
  };
  const idle = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
    : (cb) => setTimeout(cb, 150);
  // after load AND the first contentful paint (on a busy machine the first
  // paint can land after load), then in idle time
  const loaded = () => afterFirstPaint(() => idle(begin));
  if (document.readyState === 'complete') loaded();
  else window.addEventListener('load', loaded, { once: true });
}

function afterFirstPaint(cb) {
  let done = false;
  const go = () => { if (!done) { done = true; cb(); } };
  try {
    if (performance.getEntriesByName('first-contentful-paint').length) { go(); return; }
    const po = new PerformanceObserver((list) => {
      if (list.getEntriesByName('first-contentful-paint').length) { po.disconnect(); go(); }
    });
    po.observe({ type: 'paint', buffered: true });
  } catch {
    // no paint timing here: two frames after load is the next best thing
    requestAnimationFrame(() => requestAnimationFrame(go));
  }
  setTimeout(go, 3000);  // never wait on paint timing forever
}

function start(win, host, art, reducedMotion) {
  const canvas = document.createElement('canvas');
  canvas.className = 'cx-snow';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const vb = (art.getAttribute('viewBox') || '0 0 1000 1000').split(/[ ,]+/).map(Number);
  const twinkleUnits = (art.dataset.twinkle || '')
    .split(' ')
    .filter(Boolean)
    .map((p) => p.split(',').map(Number));
  const coarse = window.matchMedia('(pointer: coarse)').matches;

  const hard = sprite(false);
  const soft = sprite(true);
  let box = null;
  let flakes = [];
  let stars = [];
  let dpr = 1;
  let t = 0;

  function measure() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    const gw = win.clientWidth;
    const gh = win.clientHeight;
    if (!w || !h || !gw || !gh) return null;
    // the view SVG's slice mapping, to place the twinkles on its stars
    const s = Math.max(w / vb[2], h / vb[3]);
    return {
      w, h, gw, gh,
      s, ox: (w - vb[2] * s) / 2 - vb[0] * s, oy: (h - vb[3] * s) / 2 - vb[1] * s,
      k: gw / 310,
    };
  }

  function spawn(f, anywhere) {
    const d = DEPTHS[f.depth];
    f.r = rand(d.r[0], d.r[1]) * box.k;
    f.vy = rand(d.vy[0], d.vy[1]) * box.gh;
    f.a = rand(d.a[0], d.a[1]);
    f.amp = rand(d.amp[0], d.amp[1]) * box.k;
    f.hz = rand(d.hz[0], d.hz[1]);
    f.ph = Math.random() * Math.PI * 2;
    f.x = rand(-20, box.w + 20);
    f.y = anywhere ? rand(-10, box.h) : -f.r * 3 - Math.random() * 30;
  }

  function seed() {
    let n = Math.round((box.gw * box.gh) / PX_PER_FLAKE);
    if (coarse) n = Math.round(n * 0.7);
    n = Math.max(MIN_FLAKES, Math.min(MAX_FLAKES, n));
    flakes = [];
    let depth = 0;
    let acc = DEPTHS[0].share;
    for (let i = 0; i < n; i++) {
      while ((i + 0.5) / n > acc && depth < DEPTHS.length - 1) acc += DEPTHS[++depth].share;
      const f = { depth };
      spawn(f, true);
      flakes.push(f);
    }
    canvas.dataset.flakes = String(n);
    stars = twinkleUnits.map(([ux, uy], i) => ({
      x: box.ox + ux * box.s,
      y: box.oy + uy * box.s,
      big: i === 0,
      period: 2.8 + ((i * 7) % 5) * 0.9,
      ph: i * 1.9,
    }));
  }

  function layout() {
    const next = measure();
    if (!next) return false;
    const same = box && Math.abs(next.w - box.w) < 2 && Math.abs(next.h - box.h) < 2;
    if (same) return true;
    const prev = box;
    box = next;
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(box.w * dpr);
    canvas.height = Math.round(box.h * dpr);
    if (prev && flakes.length) {
      // keep the snow where it was (no visible reshuffle on resize)
      const sx = box.w / prev.w;
      const sy = box.h / prev.h;
      const keep = flakes;
      seed();
      for (let i = 0; i < flakes.length && i < keep.length; i++) {
        flakes[i].x = keep[i].x * sx;
        flakes[i].y = keep[i].y * sy;
      }
    } else {
      seed();
    }
    return true;
  }

  function step(dt) {
    t += dt;
    const wind = (4 + 3.5 * Math.sin(t * 0.11) + 2 * Math.sin(t * 0.37 + 1.3)) * box.k;
    const { w, h } = box;
    for (const f of flakes) {
      f.y += f.vy * dt;
      f.x += wind * DEPTHS[f.depth].wind * dt;
      if (f.y - f.r * 3 > h) spawn(f, false);
      if (f.x > w + 30) f.x -= w + 50;
    }
  }

  function draw(still) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
    if (!still) {
      for (const st of stars) {
        const v = Math.sin((t / st.period) * Math.PI * 2 + st.ph);
        const a = v > 0 ? Math.pow(v, 5) * (st.big ? 0.75 : 0.9) : 0;
        if (a < 0.02) continue;
        const R = (st.big ? 4.2 : 3) * box.k;
        ctx.globalAlpha = a;
        ctx.drawImage(hard, st.x - R, st.y - R, R * 2, R * 2);
        ctx.globalAlpha = a * 0.4;
        ctx.fillStyle = '#f2f0ff';
        ctx.fillRect(st.x - R * 1.4, st.y - 0.35, R * 2.8, 0.7);
        ctx.fillRect(st.x - 0.35, st.y - R * 1.4, 0.7, R * 2.8);
      }
    }
    for (const f of flakes) {
      const d = DEPTHS[f.depth];
      const x = f.x + Math.sin(t * f.hz * Math.PI * 2 + f.ph) * f.amp;
      const R = f.r * (d.soft ? 2.4 : 1.7);
      ctx.globalAlpha = f.a;
      ctx.drawImage(d.soft ? soft : hard, x - R, f.y - R, R * 2, R * 2);
    }
    ctx.globalAlpha = 1;
  }

  if (!layout()) return;
  host.appendChild(canvas);

  let raf = 0;
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (layout() && (reducedMotion || !raf)) draw(reducedMotion);
    }, 180);
  };
  window.addEventListener('resize', onResize, { passive: true });

  if (reducedMotion) {
    draw(true);
    canvas.dataset.running = '0';
    canvas.classList.add('is-on');
    return;
  }

  let last = 0;
  let lastDraw = 0;
  let inView = false;
  let shown = !document.hidden;

  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < FRAME_MS) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    lastDraw = now;
    step(dt);
    draw(false);
  };
  // data-running / data-flakes mirror the loop's state (read by the checks)
  const run = () => {
    if (raf || !inView || !shown) return;
    last = performance.now();
    lastDraw = 0;
    raf = requestAnimationFrame(frame);
    canvas.dataset.running = '1';
  };
  const halt = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    canvas.dataset.running = '0';
  };

  const io = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    if (inView) run();
    else halt();
  }, { threshold: 0 });
  io.observe(win);

  document.addEventListener('visibilitychange', () => {
    shown = !document.hidden;
    if (shown) run();
    else halt();
  });

  // first frame now, so the fade-in shows snow already in the air
  draw(false);
  canvas.dataset.running = '0';
  requestAnimationFrame(() => canvas.classList.add('is-on'));
}
