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

  // Wire the contact form to submit inline via fetch instead of a full
  // page redirect to the Web3Forms thank-you page. Visitor stays on
  // the site and gets a clean "note received" confirmation.
  if (note && note.tagName === 'FORM') {
    initFormHandler(note);
  }

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

/**
 * Contact form — inline fetch submission to Web3Forms.
 * On success: replace form contents with a "note received" confirmation.
 * On error: show an inline note that keeps the form intact.
 */
function initFormHandler(form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const button = form.querySelector('.note__send');
    if (!button) return;

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Sending…';
    removeError(form);

    try {
      const formData = new FormData(form);
      const response = await fetch(form.action, {
        method: 'POST',
        body: formData,
        headers: { Accept: 'application/json' },
      });

      let payload = {};
      try { payload = await response.json(); } catch { /* non-JSON response */ }

      if (response.ok && payload.success !== false) {
        showSentState(form);
      } else {
        showError(form, payload.message || "Message didn't go through. Email works too — samuelehenderson@gmail.com.");
        button.disabled = false;
        button.textContent = originalLabel;
      }
    } catch (err) {
      showError(form, "Network issue reaching the mail service. Email works too — samuelehenderson@gmail.com.");
      button.disabled = false;
      button.textContent = originalLabel;
    }
  });
}

function showSentState(form) {
  form.classList.add('is-sent');
  form.innerHTML = `
    <p class="note__salutation">Note received.</p>
    <p class="note__body">Thanks for reaching out — I'll get back to you personally, usually within a business day.</p>
    <p class="note__signoff">— Sam</p>
  `;
}

function showError(form, message) {
  let el = form.querySelector('.note__error');
  if (!el) {
    el = document.createElement('p');
    el.className = 'note__error';
    el.setAttribute('role', 'alert');
    const button = form.querySelector('.note__send');
    if (button) button.insertAdjacentElement('afterend', el);
    else form.appendChild(el);
  }
  el.textContent = message;
}

function removeError(form) {
  const el = form.querySelector('.note__error');
  if (el) el.remove();
}
