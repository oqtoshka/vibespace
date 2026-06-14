import { useEffect, useState } from 'react';

/**
 * Renders an HTML file as a live page, mirroring the markdown/PlantUML preview.
 *
 * The content is rendered inside a sandboxed iframe via `srcdoc`. The sandbox
 * grants `allow-scripts` (so dynamic pages render) but deliberately omits
 * `allow-same-origin`, so the page runs in an opaque origin and can't reach the
 * app's DOM, cookies, or storage. Relative resource links (`./style.css`) don't
 * resolve under `srcdoc` — self-contained pages and absolute/CDN URLs work.
 */

type HtmlPreviewProps = {
  content: string;
};

const RENDER_DEBOUNCE_MS = 300;

export default function HtmlPreview({ content }: HtmlPreviewProps) {
  // Debounce so typing in the editor doesn't re-run scripts / flicker on every
  // keystroke; the preview settles shortly after edits stop.
  const [srcDoc, setSrcDoc] = useState(content);

  useEffect(() => {
    const handle = setTimeout(() => setSrcDoc(content), RENDER_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [content]);

  return (
    <div className="h-full w-full bg-white">
      <iframe
        title="HTML preview"
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-popups allow-forms allow-modals"
        className="h-full w-full border-0"
      />
    </div>
  );
}
