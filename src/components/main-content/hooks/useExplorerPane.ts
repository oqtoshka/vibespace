import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from 'react';

const VISIBLE_KEY = 'file-explorer-visible';
const WIDTH_KEY = 'file-explorer-width';
const MIN_WIDTH = 180;
const MAX_WIDTH_RATIO = 0.5;
const DEFAULT_WIDTH = 280;

export type ExplorerPane = {
  visible: boolean;
  width: number;
  isResizing: boolean;
  paneRef: MutableRefObject<HTMLDivElement | null>;
  toggle: () => void;
  hide: () => void;
  startResize: (event: ReactMouseEvent<HTMLDivElement>) => void;
};

/**
 * VSCode-like docked file explorer state: a toggleable, resizable pane on
 * the left edge of the main content. Visibility and width persist globally
 * (not per project), mirroring VSCode's window-level explorer.
 */
export function useExplorerPane({ isMobile }: { isMobile: boolean }): ExplorerPane {
  const [visible, setVisible] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(VISIBLE_KEY);
      if (stored !== null) {
        return stored === 'true';
      }
    } catch {
      // Storage unavailable.
    }
    // Default: open on desktop, closed on mobile (screen is too narrow).
    return !isMobile;
  });

  const [width, setWidth] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(stored) && stored >= MIN_WIDTH) {
        return stored;
      }
    } catch {
      // Storage unavailable.
    }
    return DEFAULT_WIDTH;
  });

  const [isResizing, setIsResizing] = useState(false);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const paneLeftRef = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(VISIBLE_KEY, String(visible));
    } catch {
      // Ignore storage errors.
    }
  }, [visible]);

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // Ignore storage errors.
    }
  }, [width]);

  const toggle = useCallback(() => setVisible((previous) => !previous), []);
  const hide = useCallback(() => setVisible(false), []);

  const startResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isMobile) {
        return;
      }
      paneLeftRef.current = paneRef.current?.getBoundingClientRect().left ?? 0;
      setIsResizing(true);
      event.preventDefault();
    },
    [isMobile],
  );

  useEffect(() => {
    if (!isResizing) {
      return undefined;
    }

    const handleMouseMove = (event: MouseEvent) => {
      const maxWidth = Math.floor(window.innerWidth * MAX_WIDTH_RATIO);
      const nextWidth = Math.min(maxWidth, Math.max(MIN_WIDTH, event.clientX - paneLeftRef.current));
      setWidth(nextWidth);
    };

    const handleMouseUp = () => setIsResizing(false);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  return { visible, width, isResizing, paneRef, toggle, hide, startResize };
}
