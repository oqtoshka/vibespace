import { useEffect, useRef, useState } from 'react';

import { api } from '../../../../utils/api';
import DiagramCanvas from '../../../preview/DiagramCanvas';
import { usePreviewFullscreen } from '../../../preview/usePreviewFullscreen';

/**
 * Renders a PlantUML source file as a diagram, mirroring the markdown preview.
 *
 * Rendering goes through the backend (`POST /api/projects/:id/plantuml`), which
 * resolves the file's local `!include`s against the project tree — a remote
 * PlantUML server can't reach those — and returns a render URL for the
 * configured server (`PLANTUML_SERVER_URL`, default plantuml.com). We send the
 * live editor `content` so unsaved edits preview, and the file `path` so
 * includes resolve relative to its directory.
 *
 * The image sits in a shared `DiagramCanvas`: wheel/pinch zoom, drag to pan,
 * and expand to fullscreen — sequence diagrams in particular render far wider
 * than any editor pane.
 */

type PlantUmlPreviewProps = {
  content: string;
  projectId?: string;
  path: string;
};

const RENDER_DEBOUNCE_MS = 400;

export default function PlantUmlPreview({ content, projectId, path }: PlantUmlPreviewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { isFullscreen, toggleFullscreen } = usePreviewFullscreen();

  // Ask the backend for a render URL whenever the source (or file) changes,
  // debounced so live editing doesn't hammer the endpoint.
  useEffect(() => {
    if (!projectId || !content.trim()) {
      setUrl(null);
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
          const response = await api.renderPlantUml(projectId, { path, content, signal: controller.signal });
          if (controller.signal.aborted) return;
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            setStatus('error');
            setErrorMessage(body?.error || `Render failed (HTTP ${response.status}).`);
            return;
          }
          const data = await response.json();
          setUrl(data.url);
          // status flips to 'loaded' on the <img> onLoad below.
        } catch (error) {
          if ((error as { name?: string })?.name === 'AbortError') return;
          setStatus('error');
          setErrorMessage((error as Error)?.message || 'Render request failed.');
        }
      })();
    }, RENDER_DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [content, path, projectId]);

  if (status === 'error') {
    return (
      <div className="flex h-full items-start justify-center overflow-auto bg-background p-6">
        <div className="mt-12 max-w-md text-center text-sm text-gray-500 dark:text-gray-400">
          <p className="font-medium text-gray-700 dark:text-gray-300">Couldn’t render this diagram</p>
          <p className="mt-1">{errorMessage || 'The PlantUML server returned an error or is unreachable.'}</p>
          <p className="mt-1">Switch to the editor to check the source.</p>
        </div>
      </div>
    );
  }

  if (!url) {
    return (
      <div className="flex h-full items-start justify-center bg-background p-6">
        <div className="py-8 text-center text-sm text-gray-400">Rendering diagram…</div>
      </div>
    );
  }

  return (
    <DiagramCanvas
      // Only fit once the bytes are in: an <img> has no size before it loads,
      // so fitting any earlier measures an empty box.
      fitKey={status === 'loaded' ? url : null}
      note={status === 'loading' ? 'Re-rendering…' : null}
      isFullscreen={isFullscreen}
      onToggleFullscreen={toggleFullscreen}
    >
      {/* PlantUML draws for a light canvas, so the card stays white in dark mode. */}
      <div className="inline-block rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700">
        <img
          key={url}
          src={url}
          alt="PlantUML diagram"
          className={status === 'loaded' ? 'max-w-none' : 'max-w-none opacity-0'}
          onLoad={() => setStatus('loaded')}
          onError={() => {
            setStatus('error');
            setErrorMessage('The diagram server rejected this source (a syntax error or an unreachable include).');
          }}
        />
      </div>
    </DiagramCanvas>
  );
}
