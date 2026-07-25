import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

type UseToolbarOverflowArgs = {
  /** The row the toolbar has to fit inside (the composer footer). */
  containerRef: RefObject<HTMLElement>;
  /** The collapsible toolbar itself. */
  toolsRef: RefObject<HTMLElement>;
  /**
   * The controls that must never be pushed out or shrunk (mic + send). Their
   * measured width is what the toolbar is allowed to collide with.
   */
  actionsRef: RefObject<HTMLElement>;
  /**
   * Changes to anything that alters the toolbar's natural width but not the
   * container's — indicators appearing, labels changing with the locale.
   * A new value re-measures.
   */
  signature: string;
  /** Space between the toolbar and the actions, plus a little slack. */
  gap?: number;
};

/**
 * Reports whether the composer toolbar has to collapse into its overflow menu.
 *
 * Why measurement instead of `sm:`/`lg:` classes: the composer is not as wide
 * as the viewport. Opening the file pane (or the sidebar) narrows the chat
 * pane without changing the viewport at all, so a media query cannot see the
 * case where the toolbar actually stops fitting — a 1440px desktop with the
 * file pane open has less room than a 1024px tablet without it.
 *
 * How it stays stable: the hook only ever measures while the toolbar is
 * rendered expanded (`measuring`), so `scrollWidth` is always the *natural*
 * width rather than the width of an already-collapsed row. Collapsing does not
 * itself trigger a re-measure, so there is no expand/collapse oscillation; a
 * new measurement happens only when the container resizes or `signature`
 * changes. The state settles before paint (layout effect), so the expanded
 * probe never reaches the screen.
 */
export function useToolbarOverflow({
  containerRef,
  toolsRef,
  actionsRef,
  signature,
  gap = 20,
}: UseToolbarOverflowArgs): boolean {
  const [collapsed, setCollapsed] = useState(false);
  const [isMeasuring, setIsMeasuring] = useState(true);
  const lastWidthRef = useRef(-1);

  // Content changed shape — the previous verdict was about a different toolbar.
  useLayoutEffect(() => {
    setIsMeasuring(true);
  }, [signature]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      // Sub-pixel jitter (zoom, scrollbar) would otherwise re-measure forever.
      if (width === lastWidthRef.current) return;
      lastWidthRef.current = width;
      setIsMeasuring(true);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);

  useLayoutEffect(() => {
    if (!isMeasuring) return;

    const container = containerRef.current;
    const tools = toolsRef.current;
    const actions = actionsRef.current;
    if (!container || !tools || !actions) return;

    // `tools` is rendered expanded right now, so scrollWidth is its natural
    // width even though the element itself may be clipped.
    const required = tools.scrollWidth + actions.offsetWidth + gap;
    setCollapsed(required > container.clientWidth);
    setIsMeasuring(false);
    // Refs are stable and `isMeasuring` gates the body, so this settles in one
    // extra render rather than looping.
  }, [isMeasuring, containerRef, toolsRef, actionsRef, gap]);

  // Always expanded while probing, so the measurement above sees everything.
  return isMeasuring ? false : collapsed;
}
