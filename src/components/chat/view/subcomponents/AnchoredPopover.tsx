import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

type AnchoredPopoverProps = {
  /** The trigger the popover is anchored above (bottom-right aligned by default). */
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** 'right' (default) grows leftward from the anchor's right edge; use 'left'
      for anchors near the left screen edge so the popover grows rightward. */
  align?: 'left' | 'right';
  className?: string;
  children: ReactNode;
};

/**
 * A popover portaled to <body> and positioned with `fixed` coordinates from the
 * anchor's rect. Portaling is required because the composer's backdrop-blur
 * forms a containing block + stacking context that would otherwise trap an
 * absolutely-positioned popover *behind* the chat pane (z-index can't escape a
 * lower stacking context). Closes on outside-click, Escape, and reflows on
 * scroll/resize.
 */
export function AnchoredPopover({ anchorRef, open, onClose, align = 'right', className, children }: AnchoredPopoverProps) {
  const popRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ bottom: number; left?: number; right?: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const bottom = window.innerHeight - rect.top + 8;
      setCoords(
        align === 'left'
          ? { bottom, left: rect.left }
          : { bottom, right: window.innerWidth - rect.right },
      );
    };
    update();
    window.addEventListener('resize', update);
    // Capture-phase: catch scrolls in any nested container, not just the window.
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !coords) return null;

  return createPortal(
    <div
      ref={popRef}
      style={{ position: 'fixed', bottom: coords.bottom, left: coords.left, right: coords.right, zIndex: 100 }}
      className={className}
    >
      {children}
    </div>,
    document.body,
  );
}
