import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

/**
 * Scene 4 — Skills Constellation
 *
 * Sticky stage, vertical scroll. Three tiers of stars parallax at
 * different rates: tier 1 (primary skills) drifts up fastest as if
 * passing close to camera; tier 3 (supporting) barely moves. The
 * heading fades as the camera "passes through" the constellation;
 * a closing line lands at the bottom.
 */
export function initConstellation({ reducedMotion }) {
  const scene = document.querySelector('[data-scene="constellation"]');
  if (!scene) return;

  if (reducedMotion) return; // CSS handles the static fallback

  const t1 = scene.querySelectorAll('.star--t1');
  const t2 = scene.querySelectorAll('.star--t2');
  const t3 = scene.querySelectorAll('.star--t3');
  const lines   = scene.querySelector('.constellation__lines');
  const content = scene.querySelector('.constellation__content');
  const closing = scene.querySelector('.constellation__closing');

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: scene,
      start: 'top top',
      end: 'bottom top',
      scrub: 0.5,
      invalidateOnRefresh: true,
    },
    defaults: { ease: 'none' },
  });

  // Per-tier parallax — foreground moves fastest, background slowest.
  tl.to(t3, { y: () => -window.innerHeight * 0.30, duration: 1 }, 0)
    .to(t2, { y: () => -window.innerHeight * 0.70, duration: 1 }, 0)
    .to([t1, lines].filter(Boolean), {
      y: () => -window.innerHeight * 1.40,
      duration: 1,
    }, 0);

  // Heading fades and lifts as the camera pushes through
  tl.to(content, {
    opacity: 0,
    y: -60,
    duration: 0.45,
    ease: 'power2.in',
  }, 0.08);

  // Closing line lands near the end
  tl.fromTo(closing,
    { opacity: 0, y: 28 },
    { opacity: 1, y: 0, duration: 0.18, ease: 'power2.out' },
    0.72
  );
}
