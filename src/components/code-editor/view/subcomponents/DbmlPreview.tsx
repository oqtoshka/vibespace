import DOMPurify from 'dompurify';
import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../../../../utils/api';
import DiagramCanvas from '../../../preview/DiagramCanvas';
import { usePreviewFullscreen } from '../../../preview/usePreviewFullscreen';

/**
 * Renders a DBML source file as an ER diagram, mirroring the PlantUML preview.
 *
 * Rendering goes through the backend (`POST /api/projects/:id/dbml`), which uses
 * @softwaretechnik/dbml-renderer to produce an SVG. We send the live editor
 * `content` so unsaved edits preview. The returned SVG is sanitized with
 * DOMPurify before being injected.
 *
 * The SVG sits in a shared `DiagramCanvas`: wheel/pinch zoom, drag to pan, and
 * expand to fullscreen.
 */

type DbmlPreviewProps = {
  content: string;
  projectId?: string;
  path: string;
};

const RENDER_DEBOUNCE_MS = 400;

export default function DbmlPreview({ content, projectId, path }: DbmlPreviewProps) {
  const [svg, setSvg] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { isFullscreen, toggleFullscreen } = usePreviewFullscreen();

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
    <DiagramCanvas
      fitKey={sanitizedSvg}
      note={status === 'loading' ? 'Re-rendering…' : null}
      isFullscreen={isFullscreen}
      onToggleFullscreen={toggleFullscreen}
    >
      {sanitizedSvg && (
        <div
          className="inline-block rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700"
           
          dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
        />
      )}
    </DiagramCanvas>
  );
}
