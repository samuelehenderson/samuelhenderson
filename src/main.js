import './styles/tokens.css';
import './styles/base.css';
import './styles/scenes/hero.css';
import './styles/scenes/dive.css';
import './styles/scenes/gallery.css';
import './styles/scenes/selected.css';
import './styles/scenes/constellation.css';
import './styles/scenes/twin.css';
import './styles/scenes/contact.css';

import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

import { initHero } from './scenes/hero.js';
import { initDive } from './scenes/dive.js';
import { initGallery } from './scenes/gallery.js';
import { initConstellation } from './scenes/constellation.js';
import { initDaylight } from './scenes/daylight.js';
import { initTwin } from './scenes/twin.js';

gsap.registerPlugin(ScrollTrigger);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Phones and tablets: touch is their primary input
const touchFirst = window.matchMedia('(hover: none), (pointer: coarse)').matches;

// Smooth scroll for wheels — disabled under reduced-motion so we don't
// override the user's preference, and never created on touch-first devices:
// Lenis doesn't smooth touch anyway, but its non-passive window touch
// listeners would make every swipe wait on the main thread, so any busy
// moment would freeze scrolling. ScrollTrigger reads scroll position the
// same either way; native scroll just feeds it directly.
let lenis = null;
if (!reducedMotion && !touchFirst) {
  lenis = new Lenis({
    duration: 1.1,
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true,
  });

  lenis.on('scroll', ScrollTrigger.update);

  const raf = (time) => {
    lenis.raf(time);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);

  // Expose for debugging during development
  if (import.meta.env.DEV) window.__lenis = lenis;
}

// Boot scenes once DOM is parsed (script is type="module", so deferred).
initHero({ reducedMotion });
initDive({ reducedMotion });
initGallery({ reducedMotion, lenis });
initConstellation({ reducedMotion });
initTwin({ reducedMotion, lenis });
initDaylight({ reducedMotion });

// Route all in-page anchor clicks through Lenis so nav + skip link
// smooth-scroll to their targets instead of jumping. Falls back to
// native scrollIntoView when Lenis isn't active (reduced-motion).
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href^="#"]');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href || href === '#' || href.length < 2) return;
  const target = document.querySelector(href);
  if (!target) return;
  e.preventDefault();
  if (lenis) {
    lenis.scrollTo(target, {
      duration: 1.6,
      offset: -20,
      easing: (t) => 1 - Math.pow(1 - t, 3),
    });
  } else {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

// Recompute trigger positions after web fonts settle
window.addEventListener('load', () => ScrollTrigger.refresh());
