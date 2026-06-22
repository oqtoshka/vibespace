import { Download, Maximize2, Minimize2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../../utils/api';
import type { CodeEditorFile } from '../../types/types';

type CodeEditorPdfViewProps = {
  file: CodeEditorFile;
  isSidebar: boolean;
  isFullscreen: boolean;
  onClose: () => void;
  onToggleFullscreen: () => void;
};

/**
 * Renders a PDF inline using the browser's native PDF viewer.
 *
 * The file bytes are fetched through the authenticated blob endpoint
 * (`GET /api/projects/:id/files/content`) and turned into an object URL — an
 * `<iframe src>` can't carry the app's Bearer token, so we can't point it at the
 * API directly. The object URL is revoked on unmount / when the file changes.
 */
export default function CodeEditorPdfView({
  file,
  isSidebar,
  isFullscreen,
  onClose,
  onToggleFullscreen,
}: CodeEditorPdfViewProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const projectId = file.projectId;
  const filePath = file.path;

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setErrorMessage(null);

    (async () => {
      try {
        if (!projectId) throw new Error('Missing project identifier');
        const response = await api.readFileBlob(projectId, filePath);
        if (!response.ok) throw new Error(`Failed to load PDF (HTTP ${response.status})`);
        const blob = await response.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        setObjectUrl(url);
        setStatus('loaded');
      } catch (error) {
        if (cancelled) return;
        setStatus('error');
        setErrorMessage((error as Error)?.message || 'Could not load this PDF.');
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [projectId, filePath]);

  const handleDownload = () => {
    if (!objectUrl) return;
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  const body = (
    <div className="relative h-full w-full bg-muted">
      {status === 'error' ? (
        <div className="flex h-full w-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
          <div>
            <p className="font-medium text-foreground">Couldn’t display this PDF</p>
            <p className="mt-1">{errorMessage}</p>
          </div>
        </div>
      ) : status === 'loading' ? (
        <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
          Loading PDF…
        </div>
      ) : (
        <iframe
          key={objectUrl ?? ''}
          src={objectUrl ?? ''}
          title={file.name}
          className="h-full w-full border-0"
        />
      )}
    </div>
  );

  const headerButtons = (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        onClick={handleDownload}
        disabled={!objectUrl}
        className="flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
        title="Download file"
      >
        <Download className="h-4 w-4" />
      </button>
      {!isSidebar && (
        <button
          type="button"
          onClick={onToggleFullscreen}
          className="flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        className="flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
        title="Close"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  const header = (
    <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h3 className="truncate text-sm font-medium text-gray-900 dark:text-white">{file.name}</h3>
      </div>
      {headerButtons}
    </div>
  );

  if (isSidebar) {
    return (
      <div className="flex h-full w-full flex-col bg-background">
        {header}
        {body}
      </div>
    );
  }

  const containerClassName = isFullscreen
    ? 'fixed inset-0 z-[9999] bg-background flex flex-col'
    : 'fixed inset-0 z-[9999] md:bg-black/50 md:flex md:items-center md:justify-center md:p-4';

  const innerClassName = isFullscreen
    ? 'bg-background flex flex-col w-full h-full'
    : 'bg-background shadow-2xl flex flex-col w-full h-full md:rounded-lg md:shadow-2xl md:w-full md:max-w-6xl md:h-[85vh] md:max-h-[85vh]';

  return (
    <div className={containerClassName}>
      <div className={innerClassName}>
        {header}
        {body}
      </div>
    </div>
  );
}
