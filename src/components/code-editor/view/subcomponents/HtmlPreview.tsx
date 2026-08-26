import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../../utils/api';
import { useFileDiskVersion } from '../../../../hooks/useFileDiskVersion';
import { useProjectFilesWatch, type FileChange } from '../../../../hooks/useProjectFilesWatch';
import PreviewShell from '../../../preview/PreviewShell';
import { usePreviewFullscreen } from '../../../preview/usePreviewFullscreen';

/**
 * Renders an HTML file as a live page, mirroring the markdown/PlantUML preview.
 *
 * Sketch-style HTML isn't self-contained — it loads resources from root-absolute
 * paths (`/kit/...`) a dev server maps to project dirs. So rather than a `srcDoc`
 * iframe (which has no origin for those paths to resolve against), we ask the
 * backend to resolve the serving model and serve the file + its resources, then
 * point the iframe at that URL. The backend sets a path-scoped cookie so the
 * iframe's subresource requests authenticate.
 *
 * The served page renders from disk, so unsaved editor edits show after a save.
 * The page reloads by itself when the entry file is rewritten (a save here, or
 * an agent editing it — `useFileDiskVersion`, which also covers files under
 * ignored build dirs) and when a resource under one of the serving roots
 * changes (the project watcher). The reader's scroll position survives the
 * reload: the iframe is same-origin, so it is read before and restored after.
 */

type HtmlPreviewProps = {
  projectId?: string;
  path: string;
};

// Subresource kinds worth a reload. Anything else changing under the web root
// (a .md next to the page, an editor swap file) is noise.
const RESOURCE_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'svg', 'xml',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'woff', 'woff2', 'ttf', 'otf',
]);
// A burst of resource writes (a build emitting a dozen files) becomes one reload.
const RESOURCE_RELOAD_DEBOUNCE_MS = 400;

const extensionOf = (filePath: string) => filePath.split('.').pop()?.toLowerCase() ?? '';
const isUnder = (root: string, filePath: string) => filePath === root || filePath.startsWith(`${root}/`);

export default function HtmlPreview({ projectId, path }: HtmlPreviewProps) {
  const [entryUrl, setEntryUrl] = useState<string | null>(null);
  const [resourceRoots, setResourceRoots] = useState<string[]>([]);
  const [resourceVersion, setResourceVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const diskVersion = useFileDiskVersion(projectId, path);
  const { isFullscreen, toggleFullscreen } = usePreviewFullscreen();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const savedScrollRef = useRef<{ x: number; y: number } | null>(null);
  const resourceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Remember where the reader is before the iframe navigates away.
  const rememberScroll = useCallback(() => {
    try {
      const win = iframeRef.current?.contentWindow;
      if (win) {
        savedScrollRef.current = { x: win.scrollX, y: win.scrollY };
      }
    } catch {
      // Cross-origin (shouldn't happen — we serve it) — just lose the position.
    }
  }, []);

  const handleResourceChanges = useCallback(
    (changes: FileChange[]) => {
      if (resourceRoots.length === 0) return;
      const relevant = changes.some(
        (change) =>
          (change.type === 'change' || change.type === 'add') &&
          change.path !== path &&
          RESOURCE_EXTENSIONS.has(extensionOf(change.path)) &&
          resourceRoots.some((root) => isUnder(root, change.path)),
      );
      if (!relevant) return;
      if (resourceTimerRef.current) clearTimeout(resourceTimerRef.current);
      resourceTimerRef.current = setTimeout(() => {
        resourceTimerRef.current = null;
        rememberScroll();
        setResourceVersion((previous) => previous + 1);
      }, RESOURCE_RELOAD_DEBOUNCE_MS);
    },
    [path, rememberScroll, resourceRoots],
  );
  useProjectFilesWatch(projectId, handleResourceChanges);

  useEffect(() => () => {
    if (resourceTimerRef.current) clearTimeout(resourceTimerRef.current);
  }, []);

  useEffect(() => {
    if (!projectId || !path) {
      setError('No project context for preview.');
      return;
    }
    let active = true;
    setError(null);
    if (diskVersion > 0) {
      rememberScroll();
    }
    void (async () => {
      try {
        const response = await api.resolveHtmlPreview(projectId, { path });
        if (!active) return;
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          setError(body?.error || `Preview failed (HTTP ${response.status}).`);
          return;
        }
        const data = await response.json();
        setResourceRoots(Array.isArray(data.resourceRoots) ? data.resourceRoots : []);
        // Cache-bust so a re-open after editing/saving reloads fresh content.
        setEntryUrl(`${data.entryUrl}?v=${Date.now()}`);
      } catch (err) {
        if (!active) return;
        setError((err as Error)?.message || 'Preview request failed.');
      }
    })();
    return () => {
      active = false;
    };
    // resourceVersion is a deliberate reload trigger, not data the request uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, path, diskVersion, resourceVersion]);

  const restoreScroll = useCallback(() => {
    const saved = savedScrollRef.current;
    if (!saved) return;
    savedScrollRef.current = null;
    try {
      iframeRef.current?.contentWindow?.scrollTo(saved.x, saved.y);
    } catch {
      // Same as above: lose the position, never the page.
    }
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="max-w-md text-center text-sm text-gray-500 dark:text-gray-400">
          <p className="font-medium text-gray-700 dark:text-gray-300">Couldn’t preview this page</p>
          <p className="mt-1">{error}</p>
          <p className="mt-1">Switch to the editor to view the source.</p>
        </div>
      </div>
    );
  }

  return (
    <PreviewShell zoomable isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen}>
      {entryUrl && (
        <iframe
          ref={iframeRef}
          title="HTML preview"
          src={entryUrl}
          onLoad={restoreScroll}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
          className="h-full w-full border-0"
        />
      )}
    </PreviewShell>
  );
}
