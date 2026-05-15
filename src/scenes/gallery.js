import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

/**
 * Scene 3 — Horizontal Gallery (Project Rooms)
 *
 * Default markup is a vertical stack of <article class="room">. On
 * capable devices we add .gallery--horizontal and wire ScrollTrigger
 * to convert vertical scroll into horizontal panning. Per-room
 * parallax sublayers ride the master tween via containerAnimation.
 *
 * Under prefers-reduced-motion or in browsers without GSAP wiring,
 * the page falls back to the vertical stack — fully readable.
 */
export function initGallery({ reducedMotion, lenis }) {
  const scene = document.querySelector('[data-scene="gallery"]');
  if (!scene || reducedMotion) return;

  const track = scene.querySelector('.gallery__track');
  const rooms = scene.querySelectorAll('.room');
  const dots  = scene.querySelectorAll('.gallery__progress-dot');
  if (!track || rooms.length === 0) return;

  // Switch the layout to horizontal-pin mode
  scene.classList.add('gallery--horizontal');

  // Wait a frame so the layout reflows before measuring
  requestAnimationFrame(() => {
    const getDistance = () =>
      track.scrollWidth - window.innerWidth;

    // Snap to each room center — prevents stopping mid-pan between rooms.
    // 5 rooms = 4 equal segments between snap points = 1/4.
    const snapStep = 1 / (rooms.length - 1);

    // Master horizontal tween — drives everything else
    const horizontalTween = gsap.to(track, {
      x: () => -getDistance(),
      ease: 'none',
      scrollTrigger: {
        trigger: scene,
        pin: true,
        scrub: 1,
        start: 'top top',
        end: () => `+=${getDistance()}`,
        invalidateOnRefresh: true,
        anticipatePin: 1,
        snap: {
          snapTo: snapStep,
          duration: { min: 0.25, max: 0.55 },
          delay: 0.08,
          ease: 'power2.inOut',
          directional: false,
          // Pause Lenis during the snap tween so the smooth-scroller
          // doesn't fight ScrollTrigger's programmatic scrollTo.
          onStart:     () => { if (lenis) lenis.stop(); },
          onComplete:  () => { if (lenis) lenis.start(); },
          onInterrupt: () => { if (lenis) lenis.start(); },
        },
      },
    });

    // Per-room parallax — sub-layers shift relative to the room
    // as it crosses the viewport horizontally.
    rooms.forEach((room) => {
      const layers = room.querySelectorAll('[data-parallax]');
      layers.forEach((layer) => {
        const factor = parseFloat(layer.dataset.parallax) || 0;
        gsap.fromTo(layer,
          { xPercent: factor * 50 * -1 },
          {
            xPercent: factor * 50,
            ease: 'none',
            scrollTrigger: {
              trigger: room,
              containerAnimation: horizontalTween,
              start: 'left right',
              end: 'right left',
              scrub: true,
            },
          }
        );
      });

      // Content reveal — staggers in as room pans toward center
      const reveal = room.querySelectorAll(
        '.room__number, .room__heading, .room__lead, ' +
        '.room__chips > *, .room__cards > *, .room__timeline > *, .room__columns'
      );
      gsap.from(reveal, {
        opacity: 0,
        x: 60,
        ease: 'power2.out',
        stagger: 0.05,
        scrollTrigger: {
          trigger: room,
          containerAnimation: horizontalTween,
          start: 'left 75%',
          end: 'left 30%',
          scrub: 0.5,
        },
      });

      // Active-dot toggle when a room is centered
      const idx = parseInt(room.dataset.roomIndex, 10) - 1;
      ScrollTrigger.create({
        trigger: room,
        containerAnimation: horizontalTween,
        start: 'left center',
        end: 'right center',
        onEnter:     () => setActive(idx),
        onEnterBack: () => setActive(idx),
      });
    });

    function setActive(i) {
      dots.forEach((d, j) => d.classList.toggle('is-active', i === j));
    }
    setActive(0);
  });
}
