import { useEffect, useRef, useState } from 'react';
import { api } from '../../../../utils/api';

/**
 * Previews a custom-format source file (e.g. a `*.flow.json` flow spec) by
 * running the project's renderer server-side and showing the resulting
 * self-contained HTML in a sandboxed iframe. The live editor content is sent so
 * edits preview (debounced); the rendered HTML is self-contained, so a srcDoc
 * iframe with only `allow-scripts` is enough.
 */

type CustomRenderPreviewProps = {
  content: string;
  projectId?: string;
  path: string;
  /** Opens an in-project file — used by cross-flow links in the rendered output. */
  onFileOpen?: ((filePath: string) => void) | null;
};

const RENDER_DEBOUNCE_MS = 500;

export default function CustomRenderPreview({ content, projectId, path, onFileOpen = null }: CustomRenderPreviewProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // The rendered output postMessages cross-flow link clicks; open the target
  // file in vibespace. Scoped to this preview's iframe so multiple open flow
  // tabs don't each react.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (data?.type === 'vibespace:open-file' && typeof data.path === 'string') {
        onFileOpen?.(data.path);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onFileOpen]);

  useEffect(() => {
    if (!projectId || !path) {
      setStatus('error');
      setErrorMessage('No project context for preview.');
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
          const response = await api.renderCustom(projectId, { path, content, signal: controller.signal });
          if (controller.signal.aborted) return;
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            setStatus('error');
            setErrorMessage(body?.error || `Render failed (HTTP ${response.status}).`);
            return;
          }
          const data = await response.json();
          setHtml(data.html);
          setStatus('ready');
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') return;
          setStatus('error');
          setErrorMessage((err as Error)?.message || 'Render request failed.');
        }
      })();
    }, RENDER_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [content, path, projectId]);

  if (status === 'error') {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="max-w-lg whitespace-pre-wrap text-center text-sm text-gray-500 dark:text-gray-400">
          <p className="font-medium text-gray-700 dark:text-gray-300">Couldn’t render this file</p>
          <p className="mt-1">{errorMessage}</p>
          <p className="mt-1">Switch to the editor to check the source.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-white">
      {html !== null ? (
        <iframe
          ref={iframeRef}
          title="Custom render preview"
          srcDoc={html}
          sandbox="allow-scripts"
          className="h-full w-full border-0"
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-gray-400">Rendering…</div>
      )}
    </div>
  );
}
