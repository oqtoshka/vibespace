import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Maximize2 } from 'lucide-react';

import { useTheme } from '../../contexts/ThemeContext';
import DiagramCanvas from '../preview/DiagramCanvas';
import { usePreviewFullscreen } from '../preview/usePreviewFullscreen';

/**
 * Renders a ```mermaid fenced block as an inline diagram.
 *
 * Mermaid is loaded lazily (it's a multi-MB library) so it only lands in the
 * bundle chunk of whoever actually views a diagram. While the source is
 * invalid — e.g. a chat message still streaming in — the last good render
 * stays up; with nothing rendered yet, the `fallback` (the normal highlighted
 * code block) shows instead, so broken diagrams degrade to readable source.
 *
 * Inline, the diagram is capped to the message width — anything with more than
 * a few nodes is unreadable there — so it also opens fullscreen, where it gets
 * a pan/zoom canvas. The expanded copy renders from the same SVG string, so
 * opening it costs nothing.
 */

type MermaidDiagramProps = {
  source: string;
  fallback: ReactNode;
};

let mermaidModule: Promise<typeof import('mermaid')> | null = null;
const loadMermaid = () => {
  if (!mermaidModule) {
    mermaidModule = import('mermaid');
  }
  return mermaidModule;
};

// mermaid.render needs a document-unique element id per call.
let renderSequence = 0;

const RENDER_DEBOUNCE_MS = 300;

export default function MermaidDiagram({ source, fallback }: MermaidDiagramProps) {
  const { isDarkMode } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const { isFullscreen, toggleFullscreen } = usePreviewFullscreen();

  useEffect(() => {
    if (!source.trim()) {
      setSvg(null);
      setFailed(true);
      return undefined;
    }

    let cancelled = false;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const { default: mermaid } = await loadMermaid();
          if (cancelled) return;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: isDarkMode ? 'dark' : 'default',
          });
          const id = `mermaid-inline-${++renderSequence}`;
          const { svg: rendered } = await mermaid.render(id, source);
          if (cancelled) return;
          setSvg(rendered);
          setFailed(false);
        } catch {
          // A failed render can leave mermaid's error element behind in <body>.
          document.querySelector('[id^="dmermaid-inline-"]')?.remove();
          if (!cancelled) setFailed(true);
        }
      })();
    }, RENDER_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [source, isDarkMode]);

  if (!svg) {
    return failed ? <>{fallback}</> : (
      <div className="my-2 rounded-lg border border-border bg-background p-4 text-center text-sm text-muted-foreground">
        Rendering diagram…
      </div>
    );
  }

  return (
    <>
      <div className="group relative my-2">
        <div className="absolute left-3 top-2 z-10 text-xs font-medium uppercase text-gray-400 opacity-0 transition-opacity group-hover:opacity-100">
          mermaid
        </div>
        <button
          type="button"
          onClick={toggleFullscreen}
          title="Expand diagram"
          aria-label="Expand diagram"
          className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/90 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <div
          className="overflow-x-auto rounded-lg border border-border bg-background p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          // Mermaid output with securityLevel "strict": text is sanitized by
          // mermaid itself before SVG generation.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      {isFullscreen && (
        <DiagramCanvas fitKey={svg} isFullscreen onToggleFullscreen={toggleFullscreen}>
          <div
            // Mermaid caps its SVG with an inline max-width so it fits a text
            // column. On the canvas that cap is the wrong constraint — let it
            // take its natural size and have the canvas do the fitting.
            className="inline-block rounded-lg bg-background p-4 [&_svg]:h-auto [&_svg]:!w-auto [&_svg]:!max-w-none"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </DiagramCanvas>
      )}
    </>
  );
}
