/** Keep the fixed app shell inside the visible area while a keyboard opens. */
export function trackAppViewport(target: Window, style: CSSStyleDeclaration) {
  const viewport = target.visualViewport;
  if (!viewport) return;

  let frame: number | null = null;
  const update = () => {
    frame = null;
    // Pinch zoom should magnify the existing layout, not reflow it.
    if (Math.abs(viewport.scale - 1) > 0.01) return;

    const top = Math.max(0, viewport.offsetTop);
    const height = viewport.height;
    style.setProperty('--app-viewport-top', `${top}px`);
    style.setProperty('--app-viewport-height', `${height}px`);
  };
  const scheduleUpdate = () => {
    if (frame === null) frame = target.requestAnimationFrame(update);
  };

  // Safari can pan to the caret AFTER resizing for the keyboard. Tracking both
  // edges preserves the visible height during that scroll instead of lifting
  // the composer above the screen. Batch the two events into one layout update.
  viewport.addEventListener('resize', scheduleUpdate);
  viewport.addEventListener('scroll', scheduleUpdate);
  target.addEventListener('resize', scheduleUpdate);
  target.addEventListener('pageshow', scheduleUpdate);
  update();

  return () => {
    viewport.removeEventListener('resize', scheduleUpdate);
    viewport.removeEventListener('scroll', scheduleUpdate);
    target.removeEventListener('resize', scheduleUpdate);
    target.removeEventListener('pageshow', scheduleUpdate);
    if (frame !== null) target.cancelAnimationFrame(frame);
    style.removeProperty('--app-viewport-top');
    style.removeProperty('--app-viewport-height');
  };
}
