import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

/**
 * Scene 2 — The Dive
 *
 * Sticky-stage transition. ScrollTrigger drives a single timeline
 * (0 → 1) across the scene's scroll range. Three phases:
 *
 *   0.00 → 0.35  push in — screen scales 0.32 → 1.0, residue fades,
 *                rain ramps up.
 *   0.35 → 0.75  inside — two HUD schematics flash; first caption
 *                lands; rain at peak intensity.
 *   0.75 → 1.00  emerge — rain dissipates, grid horizon fades in,
 *                second caption signals hand-off to project rooms.
 */

const DOMAIN_CHARS =
  'BACNETSIEMENSDESIGOPXCVFDHVACVAVAHUSETPTCO2TEMPCHWFCU0123456789ABCDEF{}[]()<>=+-*/';

class CodeRain {
  constructor(canvas, scene) {
    this.canvas = canvas;
    this.scene  = scene;
    this.ctx    = canvas.getContext('2d', { alpha: true });
    this.running = false;
    this.intensity = 0;
    this.rafId = null;
    this.handleResize = this.handleResize.bind(this);
    this.tick = this.tick.bind(this);
  }

  init() {
    this.handleResize();
    window.addEventListener('resize', this.handleResize, { passive: true });

    // Pause work whenever the scene is offscreen.
    this.io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) this.start();
      else this.stop();
    }, { threshold: 0 });
    this.io.observe(this.scene);
  }

  handleResize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width  = w;
    this.height = h;
    this.canvas.width  = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.fontSize = w < 720 ? 18 : 16;
    this.columns  = Math.ceil(w / this.fontSize);
    this.drops    = new Array(this.columns).fill(0).map(() => Math.random() * -120);
    this.speeds   = new Array(this.columns).fill(0).map(() => 0.55 + Math.random() * 1.1);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  setIntensity(v) {
    this.intensity = Math.max(0, Math.min(1, v));
  }

  tick() {
    if (!this.running) return;
    const { ctx, width, height, fontSize, columns, drops, speeds } = this;

    // Trail fade — semi-transparent overlay leaves a comet tail.
    ctx.fillStyle = 'rgba(4, 10, 20, 0.14)';
    ctx.fillRect(0, 0, width, height);

    if (this.intensity > 0.02) {
      ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, monospace`;
      ctx.textBaseline = 'top';

      for (let i = 0; i < columns; i++) {
        const head = DOMAIN_CHARS[(Math.random() * DOMAIN_CHARS.length) | 0];
        const x = i * fontSize;
        const y = drops[i] * fontSize;

        // Bright lead glyph
        ctx.fillStyle = `rgba(190, 222, 255, ${0.92 * this.intensity})`;
        ctx.fillText(head, x, y);

        // Dimmer trailing glyph one row up
        const trail = DOMAIN_CHARS[(Math.random() * DOMAIN_CHARS.length) | 0];
        ctx.fillStyle = `rgba(78, 168, 255, ${0.42 * this.intensity})`;
        ctx.fillText(trail, x, y - fontSize);

        drops[i] += speeds[i];
        if (y > height + 40 && Math.random() > 0.96) {
          drops[i] = -Math.random() * 30;
        }
      }
    }

    this.rafId = requestAnimationFrame(this.tick);
  }
}

export function initDive({ reducedMotion }) {
  const scene = document.querySelector('[data-scene="dive"]');
  if (!scene) return;

  const screen  = scene.querySelector('.dive__screen');
  const residue = scene.querySelector('.dive__residue');
  const canvas  = scene.querySelector('.dive__rain');
  const hudSvgs = scene.querySelectorAll('.dive__hud-svg');
  const grid    = scene.querySelector('.dive__grid');
  const capMid  = scene.querySelector('.dive__caption--mid');
  const capEnd  = scene.querySelector('.dive__caption--end');

  if (reducedMotion) {
    // CSS already handles the end-state; nothing more to do.
    return;
  }

  const rain = new CodeRain(canvas, scene);
  rain.init();
  const rainProxy = { intensity: 0 };

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: scene,
      start: 'top top',
      end: 'bottom bottom',
      scrub: 0.4,
      invalidateOnRefresh: true,
    },
    defaults: { ease: 'none' },
  });

  // ── Phase 1 (0 → 0.35) — push in ──────────────────────────────
  tl.to(screen,  { scale: 1, borderRadius: 0, duration: 0.35, ease: 'power1.in' }, 0)
    .to(residue, { opacity: 0, duration: 0.30, ease: 'power2.in' }, 0)
    .to(canvas,  { opacity: 1, duration: 0.20, ease: 'power1.out' }, 0.10)
    .to(rainProxy, {
      intensity: 1,
      duration: 0.25,
      ease: 'power1.out',
      onUpdate: () => rain.setIntensity(rainProxy.intensity),
    }, 0.10);

  // ── Phase 2 (0.35 → 0.75) — inside ────────────────────────────
  // Two HUD schematics flash through.
  hudSvgs.forEach((hud, i) => {
    const start = 0.40 + i * 0.16;
    tl.fromTo(hud, { opacity: 0 }, { opacity: 0.55, duration: 0.06, ease: 'power2.out' }, start)
      .to(hud, { opacity: 0, duration: 0.10, ease: 'power2.in' }, start + 0.10);
  });

  // Mid caption — "INTO THE SYSTEMS"
  tl.fromTo(capMid,
    { opacity: 0, y: 24 },
    { opacity: 1, y: 0, duration: 0.10, ease: 'power2.out' }, 0.40)
    .to(capMid,
    { opacity: 0, y: -16, duration: 0.10, ease: 'power2.in' }, 0.70);

  // ── Phase 3 (0.75 → 1.0) — emerge to grid ─────────────────────
  tl.to(rainProxy, {
    intensity: 0,
    duration: 0.22,
    ease: 'power2.in',
    onUpdate: () => rain.setIntensity(rainProxy.intensity),
  }, 0.72)
    .to(canvas, { opacity: 0, duration: 0.22, ease: 'power2.in' }, 0.78)
    .fromTo(grid,
      { opacity: 0, scale: 1.08 },
      { opacity: 1, scale: 1, duration: 0.28, ease: 'power2.out' }, 0.74);

  // End caption — "SELECTED WORK ↓" handoff to next scene
  tl.fromTo(capEnd,
    { opacity: 0, y: 24 },
    { opacity: 1, y: 0, duration: 0.10, ease: 'power2.out' }, 0.86);
}
