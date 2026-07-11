import DOMPurify from 'dompurify';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize, Minus, Plus, RotateCcw } from 'lucide-react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import type { ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';

import { api } from '../../../../utils/api';

/**
 * Renders a DBML source file as an ER diagram, mirroring the PlantUML preview.
 *
 * Rendering goes through the backend (`POST /api/projects/:id/dbml`), which uses
 * @softwaretechnik/dbml-renderer to produce an SVG. We send the live editor
 * `content` so unsaved edits preview. The returned SVG is sanitized with
 * DOMPurify before being injected.
 *
 * The SVG sits inside a react-zoom-pan-pinch canvas: wheel/pinch zoom, drag to
 * pan, plus explicit controls. On every (re)render the diagram is fitted to
 * the pane, so large schemas open fully visible instead of top-left cropped.
 */

type DbmlPreviewProps = {
  content: string;
  projectId?: string;
  path: string;
};

const RENDER_DEBOUNCE_MS = 400;
const MIN_SCALE = 0.05;
const MAX_SCALE = 6;

function ZoomControlButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

export default function DbmlPreview({ content, projectId, path }: DbmlPreviewProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const diagramRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!projectId || !content.trim()) {
      setSvg(null);
      setStatus(content.trim() ? 'error' : 'loading');
      setErrorMessage(content.trim() ? 'No project context for rendering.' : null);
      return;
    }

    setStatus('loading');
    setErrorMessage(null);
    const handle = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      void (async () => {
        try {
          const response = await api.renderDbml(projectId, { path, content, signal: controller.signal });
          if (controller.signal.aborted) return;
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            setStatus('error');
            setErrorMessage(body?.error || `Render failed (HTTP ${response.status}).`);
            return;
          }
          const data = await response.json();
          setSvg(typeof data.svg === 'string' ? data.svg : null);
          setStatus('loaded');
        } catch (error) {
          if ((error as { name?: string })?.name === 'AbortError') return;
          setStatus('error');
          setErrorMessage((error as Error)?.message || 'Render request failed.');
        }
      })();
    }, RENDER_DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [content, path, projectId]);

  const sanitizedSvg = useMemo(
    () => (svg ? DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) : null),
    [svg],
  );

  const fitToView = useCallback(() => {
    const wrapper = transformRef.current;
    const diagram = diagramRef.current;
    if (wrapper && diagram) {
      wrapper.zoomToElement(diagram, undefined, 200);
    }
  }, []);

  // Fit whenever a fresh diagram lands (initial open and live re-renders):
  // zoomToElement needs the new SVG's layout, so run after paint.
  useEffect(() => {
    if (status !== 'loaded' || !sanitizedSvg) return;
    const frame = requestAnimationFrame(() => fitToView());
    return () => cancelAnimationFrame(frame);
  }, [fitToView, sanitizedSvg, status]);

  if (status === 'error') {
    return (
      <div className="flex h-full items-start justify-center overflow-auto bg-background p-6">
        <div className="mt-12 max-w-md text-center text-sm text-gray-500 dark:text-gray-400">
          <p className="font-medium text-gray-700 dark:text-gray-300">Couldn’t render this diagram</p>
          <p className="mt-1">{errorMessage || 'The DBML source could not be parsed.'}</p>
          <p className="mt-1">Switch to the editor to check the source.</p>
        </div>
      </div>
    );
  }

  if (status === 'loading' && !sanitizedSvg) {
    return (
      <div className="flex h-full items-start justify-center bg-background p-6">
        <div className="py-8 text-center text-sm text-gray-400">Rendering diagram…</div>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-hidden bg-background">
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
          {sanitizedSvg && (
            <div
              ref={diagramRef}
              className="inline-block rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
            />
          )}
        </TransformComponent>
      </TransformWrapper>

      {/* Zoom controls */}
      <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/95 p-0.5 shadow-sm backdrop-blur">
        <ZoomControlButton title="Zoom out" onClick={() => transformRef.current?.zoomOut(0.3)}>
          <Minus className="h-3.5 w-3.5" />
        </ZoomControlButton>
        <ZoomControlButton title="Zoom in" onClick={() => transformRef.current?.zoomIn(0.3)}>
          <Plus className="h-3.5 w-3.5" />
        </ZoomControlButton>
        <ZoomControlButton title="Fit to view" onClick={fitToView}>
          <Maximize className="h-3.5 w-3.5" />
        </ZoomControlButton>
        <ZoomControlButton title="Reset zoom (100%)" onClick={() => transformRef.current?.resetTransform(200)}>
          <RotateCcw className="h-3.5 w-3.5" />
        </ZoomControlButton>
      </div>

      {status === 'loading' && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
          Re-rendering…
        </div>
      )}
    </div>
  );
}
