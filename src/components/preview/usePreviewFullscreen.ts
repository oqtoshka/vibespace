import { useCallback, useEffect, useState } from 'react';

/**
 * Fullscreen state for a rendered preview (diagram, page, table).
 *
 * "Fullscreen" here is an overlay the preview paints itself into — the same
 * `fixed inset-0` trick the editor and image viewer use — not the browser's
 * Fullscreen API. The point is that the preview's own container changes class
 * rather than the preview moving in the tree: re-parenting a `<iframe>` remounts
 * it (reload, lost scroll position) and re-parenting a canvas throws away its
 * zoom, so the node has to stay exactly where it is.
 */
export function usePreviewFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = useCallback(() => setIsFullscreen((previous) => !previous), []);

  useEffect(() => {
    if (!isFullscreen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The code editor closes the whole file on a bubbling Escape. Claim the
      // key first — while a preview is expanded, Escape means "collapse it".
      event.preventDefault();
      event.stopPropagation();
      setIsFullscreen(false);
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [isFullscreen]);

  return { isFullscreen, toggleFullscreen, setIsFullscreen };
}

export default usePreviewFullscreen;
