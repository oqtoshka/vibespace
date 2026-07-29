import { useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Maximize, Maximize2, Minimize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import type { ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';

import PreviewControlButton, { PreviewControlCluster } from './PreviewControlButton';

/**
 * A pan/zoom surface for anything rendered as a picture — a PlantUML image, a
 * mermaid or DBML SVG, an image file. Wheel/pinch to zoom, drag to pan,
 * double-click to toggle, plus explicit zoom / fit / reset controls and an
 * optional expand-to-fullscreen button.
 *
 * Fullscreen is driven from outside (see `usePreviewFullscreen`) so the same
 * component serves both shapes it is needed in: an editor preview that toggles
 * between pane and fullscreen, and an inline chat diagram that only exists in
 * its expanded form.
 */

type DiagramCanvasProps = {
  children: ReactNode;
  /**
   * Changes whenever a freshly rendered diagram lands; the canvas refits to the
   * pane so a large diagram opens fully visible instead of top-left cropped.
   * Pass null while nothing is renderable yet.
   */
  fitKey?: string | number | null;
  /** Small hint painted top-left, e.g. a "Re-rendering…" badge. */
  note?: ReactNode;
  /** Omit to hide the fullscreen button (the host already has one). */
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
  /** Background of the scrollable area; light-canvas diagrams override it. */
  className?: string;
};

const MIN_SCALE = 0.05;
const MAX_SCALE = 6;
const ZOOM_STEP = 0.3;
// Breathing room kept around a fitted diagram, in px.
const FIT_PADDING = 32;

export default function DiagramCanvas({
  children,
  fitKey = null,
  note = null,
  onToggleFullscreen,
  isFullscreen = false,
  className = 'bg-background',
}: DiagramCanvasProps) {
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Fit means "make it all visible", never "blow a small diagram up to fill the
  // pane" — hence the 1 ceiling. zoomToElement would otherwise upscale, which
  // on a raster PlantUML render just makes it blurry.
  const fitToView = useCallback(() => {
    const wrapper = transformRef.current;
    const container = containerRef.current;
    const content = contentRef.current;
    if (!wrapper || !container || !content) return;

    // offsetWidth/Height are layout sizes, unaffected by the ancestor's zoom
    // transform, so this stays correct at any current scale.
    const contentWidth = content.offsetWidth;
    const contentHeight = content.offsetHeight;
    const paneWidth = container.clientWidth - FIT_PADDING;
    const paneHeight = container.clientHeight - FIT_PADDING;
    if (contentWidth <= 0 || contentHeight <= 0 || paneWidth <= 0 || paneHeight <= 0) {
      wrapper.resetTransform(0);
      return;
    }

    const scale = Math.max(
      MIN_SCALE,
      Math.min(1, paneWidth / contentWidth, paneHeight / contentHeight),
    );
    wrapper.zoomToElement(content, scale, 200);
  }, []);

  // Refit when a new diagram lands and when the pane itself changes size
  // (entering/leaving fullscreen). Both need the new layout, so run after paint.
  useEffect(() => {
    if (fitKey === null || fitKey === undefined) return undefined;
    const frame = requestAnimationFrame(() => fitToView());
    return () => cancelAnimationFrame(frame);
  }, [fitKey, fitToView, isFullscreen]);

  const containerClassName = isFullscreen
    ? `fixed inset-0 z-[10000] overflow-hidden ${className}`
    : `relative h-full w-full overflow-hidden ${className}`;

  return (
    <div ref={containerRef} className={containerClassName}>
      <TransformWrapper
        ref={transformRef}
        minScale={MIN_SCALE}
        maxScale={MAX_SCALE}
        limitToBounds={false}
        centerOnInit
        doubleClick={{ mode: 'toggle' }}
        wheel={{ step: 0.15 }}
        panning={{ velocityDisabled: true }}
      >
        <TransformComponent wrapperClass="!h-full !w-full" contentClass="">
          <div ref={contentRef} className="inline-block">
            {children}
          </div>
        </TransformComponent>
      </TransformWrapper>

      <PreviewControlCluster>
        <PreviewControlButton title="Zoom out" onClick={() => transformRef.current?.zoomOut(ZOOM_STEP)}>
          <Minus className="h-3.5 w-3.5" />
        </PreviewControlButton>
        <PreviewControlButton title="Zoom in" onClick={() => transformRef.current?.zoomIn(ZOOM_STEP)}>
          <Plus className="h-3.5 w-3.5" />
        </PreviewControlButton>
        <PreviewControlButton title="Fit to view" onClick={fitToView}>
          <Maximize className="h-3.5 w-3.5" />
        </PreviewControlButton>
        <PreviewControlButton title="Reset zoom (100%)" onClick={() => transformRef.current?.resetTransform(200)}>
          <RotateCcw className="h-3.5 w-3.5" />
        </PreviewControlButton>
        {onToggleFullscreen && (
          <PreviewControlButton
            title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
            onClick={onToggleFullscreen}
          >
            {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </PreviewControlButton>
        )}
      </PreviewControlCluster>

      {note && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
          {note}
        </div>
      )}
    </div>
  );
}
