import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { initMouseParallax } from '../lib/parallax.js';

/**
 * Scene 6 — Contact / Daylight
 *
 * The camera pulls back to the workshop, now lit by morning sun.
 * Sticky-stage vertical scroll with 5 parallax layers echoing the
 * Hero. The paper-note contact form and content grid ride above.
 * Mirror of Hero's setup, warm palette instead of dim monitor glow.
 */
export function initDaylight({ reducedMotion }) {
  const scene = document.querySelector('[data-scene="contact"]');
  if (!scene) return;

  const stage   = scene.querySelector('.contact__stage');
  const content = scene.querySelector('.contact__content');
  const note    = scene.querySelector('.contact__note');
  const reveal  = scene.querySelectorAll(
    '.contact__number, .contact__heading, .contact__lead, .contact__actions, .contact__note'
  );

  // Reveal on entry — runs even under reduced-motion (opacity only there)
  if (reducedMotion) {
    gsap.set(reveal, { opacity: 1, y: 0 });
    return;
  }

  gsap.from(reveal, {
    opacity: 0,
    y: 24,
    duration: 1.0,
    ease: 'power3.out',
    stagger: 0.12,
    scrollTrigger: {
      trigger: scene,
      start: 'top 70%',
      once: true,
    },
  });

  // Skip parallax when the section falls back to auto-height on mobile
  if (!stage || window.matchMedia('(max-width: 900px)').matches) return;

  // Scroll-driven per-layer parallax
  const layers = stage.querySelectorAll('[data-parallax]');
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

  // Subtle mouse parallax — desktop pointer only
  const isCoarse = window.matchMedia('(pointer: coarse)').matches;
  if (!isCoarse && window.innerWidth >= 900) {
    initMouseParallax(scene);
  }

  // Note "settling" — as the camera settles, the paper straightens slightly
  gsap.fromTo(note,
    { rotation: -3.2, y: 40 },
    {
      rotation: -1.6,
      y: 0,
      ease: 'power2.out',
      scrollTrigger: {
        trigger: scene,
        start: 'top 60%',
        end: 'top 10%',
        scrub: 0.5,
      },
    }
  );
}
