import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { initMouseParallax } from '../lib/parallax.js';

/**
 * Scene 1 — Hero / The Workshop
 *
 * Vertical scroll. Layered SVG dioramas translate at different
 * speeds (data-parallax). Title block fades out as the camera
 * pushes through. Mouse parallax composes on top via .layer-inner.
 */
export function initHero({ reducedMotion }) {
  const scene = document.querySelector('[data-scene="hero"]');
  if (!scene) return;

  const content = scene.querySelector('.hero__content');
  const cue     = scene.querySelector('.hero__cue');
  const reveal  = scene.querySelectorAll('.hero__eyebrow, .hero__title span, .hero__subtitle');

  // Initial reveal — runs even under reduced-motion (opacity only there).
  if (reducedMotion) {
    gsap.set(reveal, { opacity: 1, y: 0 });
  } else {
    gsap.from(reveal, {
      opacity: 0,
      y: 28,
      duration: 1.1,
      ease: 'power3.out',
      stagger: 0.12,
      delay: 0.15,
    });
  }

  if (reducedMotion) return;

  // Scroll-driven layer parallax
  const layers = scene.querySelectorAll('[data-parallax]');
  layers.forEach((layer) => {
    const factor = parseFloat(layer.dataset.parallax) || 0;
    gsap.to(layer, {
      y: () => factor * window.innerHeight,
      ease: 'none',
      scrollTrigger: {
        trigger: scene,
        start: 'top top',
        end: 'bottom top',
        scrub: true,
        invalidateOnRefresh: true,
      },
    });
  });

  // Title fades + lifts as the camera pushes in
  gsap.to(content, {
    opacity: 0,
    y: -60,
    ease: 'none',
    scrollTrigger: {
      trigger: scene,
      start: 'top top',
      end: '55% top',
      scrub: true,
    },
  });

  // Scroll cue disappears almost immediately
  if (cue) {
    gsap.to(cue, {
      opacity: 0,
      ease: 'none',
      scrollTrigger: {
        trigger: scene,
        start: 'top -10',
        end: 'top -200',
        scrub: true,
      },
    });
  }

  // Mouse parallax — desktop pointer only
  const isCoarse  = window.matchMedia('(pointer: coarse)').matches;
  const wideEnough = window.innerWidth >= 900;
  if (!isCoarse && wideEnough) {
    initMouseParallax(scene);
  }
}
