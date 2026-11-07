/**
 * The hero window's live view — light snow falling past the glass in three
 * depth layers (near flakes larger, faster, softer; a slow wind sway), and a
 * few stars twinkling over the range.
 *
 * One small canvas, laid over the window's glass inside the sky layer so it
 * rides that layer's parallax. The mountains and sky stay static SVG; only
 * the flakes and twinkles are drawn per frame.
 *
 *  - starts after first paint (load → idle), never blocks the hero
 *  - devicePixelRatio capped, flake count scaled to the glass area, ~30 fps
 *  - paused while the hero is off screen or the tab is hidden
 *  - prefers-reduced-motion: one still, snow-dotted frame, no loop
 */

const VB_W = 1600;
const VB_H = 1000;
const LAYER_VH = 1.6;      // hero layers are 160vh tall (top/bottom -30vh)
const DRIFT_VH = 0.05;     // the view slides down past the wall on scroll (0.22 vs 0.16)
const MARGIN = 10;         // mouse parallax: view -3px, wall +4px
const PX_PER_FLAKE = 1700; // one flake per ~41×41 px of glass
const MAX_FLAKES = 170;
const FRAME_MS = 30;       // snow drifts slowly: ~30 draws a second is smooth and halves the compositing

// share, radius px, fall px/s, alpha, sway px, sway Hz, wind factor
const DEPTHS = [
  { share: 0.48, r: [0.7, 1.1], vy: [10, 15], a: [0.45, 0.65], amp: [2, 4],  hz: [0.3, 0.6],  wind: 0.5, soft: false },
  { share: 0.34, r: [1.2, 1.8], vy: [17, 25], a: [0.6, 0.8],   amp: [4, 8],  hz: [0.2, 0.45], wind: 0.8, soft: false },
  { share: 0.18, r: [2.4, 3.6], vy: [30, 44], a: [0.5, 0.72],  amp: [8, 14], hz: [0.15, 0.3], wind: 1.2, soft: true },
];

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

function sprite(soft) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  if (soft) {
    grad.addColorStop(0, 'rgba(240,246,255,0.95)');
    grad.addColorStop(0.45, 'rgba(225,236,255,0.4)');
    grad.addColorStop(1, 'rgba(225,236,255,0)');
  } else {
    grad.addColorStop(0, 'rgba(248,251,255,1)');
    grad.addColorStop(0.4, 'rgba(232,240,255,0.85)');
    grad.addColorStop(1, 'rgba(232,240,255,0)');
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return c;
}

export function initHeroWindow(scene, { reducedMotion }) {
  const host = scene.querySelector('.layer--sky .layer-inner');
  const view = host && host.querySelector('.hero__view');
  const room = scene.querySelector('.hero__room');
  if (!host || !view || !room) return;

  const twinkles = (view.dataset.twinkle || '')
    .split(' ')
    .filter(Boolean)
    .map((p) => p.split(',').map(Number));

  const begin = () => {
    try {
      start(host, room, twinkles, reducedMotion);
    } catch (err) {
      // the view still reads as a still night without the canvas
      if (import.meta.env.DEV) console.warn('hero window:', err);
    }
  };
  const idle = window.requestIdleCallback
    ? (cb) => window.requestIdleCallback(cb, { timeout: 1200 })
    : (cb) => setTimeout(cb, 120);
  if (document.readyState === 'complete') idle(begin);
  else window.addEventListener('load', () => idle(begin), { once: true });
}

function start(host, room, twinkleUnits, reducedMotion) {
  const canvas = document.createElement('canvas');
  canvas.className = 'hero__snow';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const hard = sprite(false);
  const soft = sprite(true);
  let box = null;       // canvas rect in host px + viewBox mapping
  let flakes = [];
  let stars = [];
  let dpr = 1;
  let t = 0;

  // Where the glass is: the crop that is showing (wide / mid / narrow) says so.
  function measure() {
    const W = host.clientWidth;
    const H = host.clientHeight;
    if (!W || !H) return null;
    const win = [...room.querySelectorAll('[data-glass]')]
      .find((g) => getComputedStyle(g).display !== 'none');
    if (!win) return null;
    const [x0, y0, x1, y1] = win.dataset.glass.split(' ').map(Number);
    const s = Math.max(W / VB_W, H / VB_H);
    const ox = (W - VB_W * s) / 2;
    const oy = (H - VB_H * s) / 2;
    const vh = H / LAYER_VH;
    const left = Math.floor(ox + x0 * s - MARGIN);
    const top = Math.floor(oy + y0 * s - MARGIN - DRIFT_VH * vh);
    const right = Math.ceil(ox + x1 * s + MARGIN);
    const bottom = Math.ceil(oy + y1 * s + MARGIN);
    return {
      left, top, w: right - left, h: bottom - top,
      s, ox, oy,
      glassArea: (x1 - x0) * (y1 - y0) * s * s,
    };
  }

  function spawn(f, w, h, anywhere) {
    const d = DEPTHS[f.depth];
    const k = box.s / 1.44; // speeds are tuned at 1440×900
    f.r = rand(d.r[0], d.r[1]);
    f.vy = rand(d.vy[0], d.vy[1]) * k;
    f.a = rand(d.a[0], d.a[1]);
    f.amp = rand(d.amp[0], d.amp[1]);
    f.hz = rand(d.hz[0], d.hz[1]);
    f.ph = Math.random() * Math.PI * 2;
    f.x = rand(-20, w + 20);
    f.y = anywhere ? rand(-10, h) : -f.r * 3 - Math.random() * 30;
  }

  function seed() {
    const n = Math.max(14, Math.min(MAX_FLAKES, Math.round(box.glassArea / PX_PER_FLAKE)));
    flakes = [];
    let depth = 0;
    let acc = DEPTHS[0].share;
    for (let i = 0; i < n; i++) {
      while ((i + 0.5) / n > acc && depth < DEPTHS.length - 1) acc += DEPTHS[++depth].share;
      const f = { depth };
      spawn(f, box.w, box.h, true);
      flakes.push(f);
    }
    stars = twinkleUnits
      .map(([ux, uy], i) => ({
        x: box.ox + ux * box.s - box.left,
        y: box.oy + uy * box.s - box.top,
        period: 2.6 + ((i * 7) % 5) * 0.8,
        ph: i * 1.7,
      }))
      .filter((st) => st.x > 0 && st.x < box.w && st.y > 0 && st.y < box.h);
  }

  function layout() {
    const next = measure();
    if (!next) return false;
    const same = box && Math.abs(next.w - box.w) < 2 && Math.abs(next.h - box.h) < 2
      && Math.abs(next.left - box.left) < 2 && Math.abs(next.top - box.top) < 2;
    if (same) return true;
    const prev = box;
    box = next;
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.style.left = `${box.left}px`;
    canvas.style.top = `${box.top}px`;
    canvas.style.width = `${box.w}px`;
    canvas.style.height = `${box.h}px`;
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
    const wind = 5 + 4 * Math.sin(t * 0.11) + 2 * Math.sin(t * 0.37 + 1.3);
    const k = box.s / 1.44;
    const { w, h } = box;
    for (const f of flakes) {
      f.y += f.vy * dt;
      f.x += wind * DEPTHS[f.depth].wind * k * dt;
      if (f.y - f.r * 3 > h) spawn(f, w, h, false);
      if (f.x > w + 30) f.x -= w + 50;
    }
  }

  function draw(still) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
    if (!still) {
      for (const st of stars) {
        const v = Math.sin((t / st.period) * Math.PI * 2 + st.ph);
        const a = v > 0 ? Math.pow(v, 6) * 0.95 : 0;
        if (a < 0.02) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(hard, st.x - 3.2, st.y - 3.2, 6.4, 6.4);
        ctx.globalAlpha = a * 0.45;
        ctx.fillStyle = '#eef3ff';
        ctx.fillRect(st.x - 4, st.y - 0.35, 8, 0.7);
        ctx.fillRect(st.x - 0.35, st.y - 4, 0.7, 8);
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
    t = 0;
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
  // data-running mirrors the loop's state (read by the perf checks)
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
  io.observe(canvas);

  document.addEventListener('visibilitychange', () => {
    shown = !document.hidden;
    if (shown) run();
    else halt();
  });

  // first frame now so the fade-in shows snow already in the air
  draw(false);
  requestAnimationFrame(() => canvas.classList.add('is-on'));
}
