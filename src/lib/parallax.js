/**
 * Mouse parallax — applies a subtle cursor-driven offset to any
 * descendant of `scope` carrying [data-mouse]. Uses CSS variables
 * (--mx, --my) so it composes with whatever transform the layer
 * already has (e.g. the GSAP scroll tween on the parent).
 *
 * Disable from the caller for touch devices, small viewports,
 * and prefers-reduced-motion.
 */
export function initMouseParallax(scope) {
  const layers = scope.querySelectorAll('[data-mouse]');
  if (!layers.length) return () => {};

  let targetX = 0, targetY = 0;
  let currentX = 0, currentY = 0;
  let inView = true;
  let rafId = null;

  const onMove = (e) => {
    const rect = scope.getBoundingClientRect();
    targetX = ((e.clientX - rect.left) / rect.width  - 0.5) * 2;
    targetY = ((e.clientY - rect.top)  / rect.height - 0.5) * 2;
  };

  const onLeave = () => { targetX = 0; targetY = 0; };

  // Pause work when scene is offscreen
  const io = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
  }, { threshold: 0 });
  io.observe(scope);

  scope.addEventListener('mousemove', onMove, { passive: true });
  scope.addEventListener('mouseleave', onLeave, { passive: true });

  const tick = () => {
    if (inView) {
      currentX += (targetX - currentX) * 0.06;
      currentY += (targetY - currentY) * 0.06;
      for (const layer of layers) {
        const strength = parseFloat(layer.dataset.mouse) || 10;
        layer.style.setProperty('--mx', `${(currentX * strength).toFixed(2)}px`);
        layer.style.setProperty('--my', `${(currentY * strength).toFixed(2)}px`);
      }
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    io.disconnect();
    scope.removeEventListener('mousemove', onMove);
    scope.removeEventListener('mouseleave', onLeave);
  };
}
