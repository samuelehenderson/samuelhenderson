import './styles/tokens.css';
import './styles/base.css';
import './styles/scenes/hero.css';
import './styles/scenes/dive.css';
import './styles/scenes/gallery.css';

import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

import { initHero } from './scenes/hero.js';
import { initDive } from './scenes/dive.js';
import { initGallery } from './scenes/gallery.js';

gsap.registerPlugin(ScrollTrigger);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Smooth scroll — disabled under reduced-motion so we don't override
// the user's preference. ScrollTrigger reads scroll position the same
// either way; native scroll just feeds it directly.
let lenis = null;
if (!reducedMotion) {
  lenis = new Lenis({
    duration: 1.1,
    easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
    smoothWheel: true,
    smoothTouch: false, // native touch scroll feels better on phones
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

// Recompute trigger positions after web fonts settle
window.addEventListener('load', () => ScrollTrigger.refresh());
