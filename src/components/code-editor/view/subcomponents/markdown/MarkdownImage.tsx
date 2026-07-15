import { ImageOff } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useFileDiskVersion } from '../../../../../hooks/useFileDiskVersion';
import { api } from '../../../../../utils/api';

type MarkdownImageProps = {
  /** In-project path of the image, already resolved against the document. */
  filePath: string;
  projectId: string;
  alt?: string;
  title?: string;
};

/**
 * Renders an in-project image referenced from markdown. An `<img src>` can't
 * carry the app's Bearer token, so the bytes go through the authenticated
 * blob endpoint and reach the element as an object URL (same approach as
 * CodeEditorImageView). Re-fetches when the image is rewritten on disk; the
 * old frame stays up until the new bytes arrive (revoking an object URL
 * doesn't clear an already-decoded image).
 */
export default function MarkdownImage({ filePath, projectId, alt, title }: MarkdownImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const diskVersion = useFileDiskVersion(projectId, filePath);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setFailed(false);

    (async () => {
      try {
        const response = await api.readFileBlob(projectId, filePath);
        if (!response.ok) {
          throw new Error(`Failed to load image (HTTP ${response.status})`);
        }
        const blob = await response.blob();
        if (cancelled) {
          return;
        }
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [projectId, filePath, diskVersion]);

  // Placeholders must be phrasing content — react-markdown puts images inside
  // <p>, where a <div> would be invalid HTML.
  if (failed) {
    return (
      <span className="not-prose inline-flex items-center gap-1.5 rounded border border-dashed border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
        <ImageOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="break-all">{alt || filePath}</span>
      </span>
    );
  }

  if (!objectUrl) {
    return alt ? <span className="text-xs italic text-muted-foreground">{alt}</span> : null;
  }

  return <img src={objectUrl} alt={alt ?? ''} title={title} className="max-w-full" loading="lazy" />;
}
