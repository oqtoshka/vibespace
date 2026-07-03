import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../utils/api';

/**
 * Renders a ```plantuml / ```puml fenced block as an inline diagram.
 *
 * The backend encodes the snippet and returns a URL on the configured PlantUML
 * server (`PLANTUML_SERVER_URL`) — mirroring the .puml file preview, minus the
 * `!include` resolution a bare snippet has no directory for. While the source
 * is invalid — e.g. a chat message still streaming in — the last good render
 * stays up; with nothing rendered yet, the `fallback` (the normal highlighted
 * code block) shows instead.
 */

type PlantUmlDiagramProps = {
  source: string;
  fallback: ReactNode;
};

const RENDER_DEBOUNCE_MS = 400;

export default function PlantUmlDiagram({ source, fallback }: PlantUmlDiagramProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!source.trim()) {
      setUrl(null);
      setFailed(true);
      return undefined;
    }

    const handle = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      // Fenced snippets often omit the @startuml/@enduml wrapper models and
      // humans skip in markdown; the render server requires it.
      const content = /@start\w+/.test(source) ? source : `@startuml\n${source}\n@enduml`;
      void (async () => {
        try {
          const response = await api.renderInlinePlantUml({ content, signal: controller.signal });
          if (controller.signal.aborted) return;
          if (!response.ok) {
            setFailed(true);
            return;
          }
          const data = await response.json();
          setUrl(data.url);
          setFailed(false);
        } catch (error) {
          if ((error as { name?: string })?.name === 'AbortError') return;
          setFailed(true);
        }
      })();
    }, RENDER_DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [source]);

  if (!url) {
    return failed ? <>{fallback}</> : (
      <div className="my-2 rounded-lg border border-border bg-background p-4 text-center text-sm text-muted-foreground">
        Rendering diagram…
      </div>
    );
  }

  return (
    <div className="group relative my-2">
      <div className="absolute left-3 top-2 z-10 text-xs font-medium uppercase text-gray-400 opacity-0 transition-opacity group-hover:opacity-100">
        plantuml
      </div>
      {/* PlantUML draws for a light canvas, so the card stays white in dark mode. */}
      <div className="overflow-x-auto rounded-lg border border-border bg-white p-4 text-center">
        <img
          key={url}
          src={url}
          alt="PlantUML diagram"
          className="inline-block max-w-full"
          onError={() => {
            setUrl(null);
            setFailed(true);
          }}
        />
      </div>
    </div>
  );
}
