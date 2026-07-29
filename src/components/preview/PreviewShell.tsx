import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Maximize2, Minimize2, Minus, Plus, RotateCcw } from 'lucide-react';

import PreviewControlButton, { PreviewControlCluster } from './PreviewControlButton';

/**
 * Frame for a preview that renders its own layout — an HTML page, a flow chart,
 * a table — rather than a fixed-size picture. Adds fullscreen and, optionally,
 * zoom.
 *
 * A `DiagramCanvas`-style pan/zoom canvas is wrong for these: the content
 * reflows to its container, so it has no intrinsic size to fit to. Zoom is
 * applied the way a browser's own zoom works instead — scale the frame and
 * enlarge its layout box by the inverse, so the content keeps filling the pane
 * and simply gets more or fewer CSS pixels to lay out in.
 *
 * The children stay in one place in the tree across the fullscreen toggle
 * (only this container's classes change), which is what keeps an `<iframe>`
 * from reloading when the preview is expanded.
 */

type PreviewShellProps = {
  children: ReactNode;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Adds zoom controls. Off for content that is already text-reflowing. */
  zoomable?: boolean;
  className?: string;
};

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const ZOOM_STEP = 0.1;

const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(value.toFixed(2))));

export default function PreviewShell({
  children,
  isFullscreen,
  onToggleFullscreen,
  zoomable = false,
  className = 'bg-white',
}: PreviewShellProps) {
  const [scale, setScale] = useState(1);

  const zoomBy = useCallback((delta: number) => setScale((previous) => clamp(previous + delta)), []);

  const containerClassName = isFullscreen
    ? `fixed inset-0 z-[10000] overflow-hidden ${className}`
    : `relative h-full w-full overflow-hidden ${className}`;

  return (
    <div className={containerClassName}>
      <div className="h-full w-full overflow-hidden">
        <div
          className="h-full w-full"
          style={
            zoomable && scale !== 1
              ? {
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                width: `${100 / scale}%`,
                height: `${100 / scale}%`,
              }
              : undefined
          }
        >
          {children}
        </div>
      </div>

      <PreviewControlCluster>
        {zoomable && (
          <>
            <PreviewControlButton title="Zoom out" onClick={() => zoomBy(-ZOOM_STEP)}>
              <Minus className="h-3.5 w-3.5" />
            </PreviewControlButton>
            <PreviewControlButton title="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
              <Plus className="h-3.5 w-3.5" />
            </PreviewControlButton>
            <PreviewControlButton title="Reset zoom (100%)" onClick={() => setScale(1)}>
              <RotateCcw className="h-3.5 w-3.5" />
            </PreviewControlButton>
          </>
        )}
        <PreviewControlButton
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          onClick={onToggleFullscreen}
        >
          {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </PreviewControlButton>
      </PreviewControlCluster>
    </div>
  );
}
