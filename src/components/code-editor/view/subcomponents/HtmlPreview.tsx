import { useEffect, useState } from 'react';
import { api } from '../../../../utils/api';
import { useFileDiskVersion } from '../../../../hooks/useFileDiskVersion';

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
 * When the entry file itself is rewritten on disk (a save here, or an agent
 * editing it), the iframe reloads with a fresh cache-buster; subresource-only
 * changes still need a manual preview re-toggle.
 */

type HtmlPreviewProps = {
  projectId?: string;
  path: string;
};

export default function HtmlPreview({ projectId, path }: HtmlPreviewProps) {
  const [entryUrl, setEntryUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const diskVersion = useFileDiskVersion(projectId, path);

  useEffect(() => {
    if (!projectId || !path) {
      setError('No project context for preview.');
      return;
    }
    let active = true;
    setError(null);
    setEntryUrl(null);
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
  }, [projectId, path, diskVersion]);

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
    <div className="h-full w-full bg-white">
      {entryUrl && (
        <iframe
          key={entryUrl}
          title="HTML preview"
          src={entryUrl}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
          className="h-full w-full border-0"
        />
      )}
    </div>
  );
}
