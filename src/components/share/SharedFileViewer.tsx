import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import DOMPurify from 'dompurify';
import { AlertCircle, Code2, Download, Eye, FileWarning, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api } from '../../utils/api';
import { getLanguageExtensions } from '../code-editor/utils/editorExtensions';
import MarkdownPreview from '../code-editor/view/subcomponents/markdown/MarkdownPreview';

type ShareMeta = { name: string; size: number; mime: string; expiresAt: string | null };
type RenderResult =
  | { type: 'svg'; svg: string }
  | { type: 'url'; url: string }
  | { type: 'html'; url: string };

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const DIAGRAM_EXTS = new Set(['puml', 'plantuml', 'iuml', 'wsd', 'dbml']);

function isTextMime(mime: string | undefined): boolean {
  if (!mime) return false;
  return mime.startsWith('text/') || /(json|xml|javascript|ecmascript|x-sh|yaml|sql|csv|typescript)/.test(mime);
}

export default function SharedFileViewer() {
  const { shareId = '' } = useParams();
  const [meta, setMeta] = useState<ShareMeta | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [render, setRender] = useState<RenderResult | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorInfo, setErrorInfo] = useState<{ code: number; message: string } | null>(null);
  const [mode, setMode] = useState<'rendered' | 'raw'>('rendered');

  const isDark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  const ext = (meta?.name.split('.').pop() ?? '').toLowerCase();
  const isPdf = ext === 'pdf';
  const isImage = IMAGE_EXTS.has(ext);
  const isMarkdown = ext === 'md' || ext === 'markdown';
  const isDiagram = DIAGRAM_EXTS.has(ext);
  const isHtml = ext === 'html' || ext === 'htm';
  const isText = isMarkdown || isDiagram || isHtml || isTextMime(meta?.mime);
  const isPreviewable = isPdf || isImage || isMarkdown || isDiagram || isHtml;

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setErrorInfo(null);
    setMeta(null);
    setContent(null);
    setRender(null);
    setMode('rendered');

    (async () => {
      try {
        const metaRes = await api.shareMeta(shareId);
        if (!metaRes.ok) {
          const body = await metaRes.json().catch(() => ({}));
          if (cancelled) return;
          setErrorInfo({ code: metaRes.status, message: body?.error || 'This link is unavailable.' });
          setStatus('error');
          return;
        }
        const metaData: ShareMeta = await metaRes.json();
        if (cancelled) return;
        setMeta(metaData);

        const e = (metaData.name.split('.').pop() ?? '').toLowerCase();
        const diagram = DIAGRAM_EXTS.has(e);
        const pdf = e === 'pdf';
        const image = IMAGE_EXTS.has(e);
        const html = e === 'html' || e === 'htm';
        const text = e === 'md' || e === 'markdown' || diagram || html || isTextMime(metaData.mime);

        // Diagrams and HTML: ask the server for the rendered artifact. For HTML
        // this is the preview entry URL whose `/kit/...` resources resolve
        // server-side (sketch-style pages aren't self-contained).
        if (diagram || html) {
          const renderRes = await api.shareRender(shareId);
          if (!cancelled && renderRes.ok) {
            setRender(await renderRes.json());
          }
        }

        // Text-ish files: pull the source for raw/highlighted/markdown views.
        if (!pdf && !image && text) {
          const contentRes = await fetch(api.shareContentUrl(shareId));
          if (!cancelled && contentRes.ok) {
            setContent(await contentRes.text());
          }
        }

        if (!cancelled) setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        setErrorInfo({ code: 0, message: (e as Error).message || 'Failed to load.' });
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [shareId]);

  const sanitizedSvg = useMemo(
    () =>
      render?.type === 'svg'
        ? DOMPurify.sanitize(render.svg, { USE_PROFILES: { svg: true, svgFilters: true } })
        : null,
    [render],
  );

  const languageExtensions = useMemo(
    () => (meta ? getLanguageExtensions(meta.name) : []),
    [meta],
  );

  // Images referenced from shared markdown load through the public
  // share-preview route (the viewer has no auth token to fetch blobs with).
  const resolveShareImageUrl = useCallback(
    (assetPath: string) => api.sharePreviewUrl(shareId, assetPath),
    [shareId],
  );

  if (status === 'loading') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }

  if (status === 'error') {
    const gone = errorInfo?.code === 410;
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        {gone ? (
          <FileWarning className="h-10 w-10 text-amber-500" />
        ) : (
          <AlertCircle className="h-10 w-10 text-red-500" />
        )}
        <h1 className="text-lg font-semibold text-foreground">
          {gone ? 'File no longer available' : 'Link unavailable'}
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          {errorInfo?.message || 'This link is invalid or has expired.'}
        </p>
      </div>
    );
  }

  const showToggle = (isMarkdown || isDiagram || isHtml) && content !== null;
  const downloadUrl = api.shareContentUrl(shareId, { download: true });

  return (
    <div className="flex h-screen w-screen flex-col bg-background">
      <header className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-medium text-foreground">{meta?.name}</h1>
          {meta?.expiresAt && (
            <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              Expires {new Date(meta.expiresAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showToggle && (
            <button
              type="button"
              onClick={() => setMode((m) => (m === 'rendered' ? 'raw' : 'rendered'))}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
              title={mode === 'rendered' ? 'View source' : 'View rendered'}
            >
              {mode === 'rendered' ? <Code2 className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              {mode === 'rendered' ? 'Source' : 'Rendered'}
            </button>
          )}
          <a
            href={downloadUrl}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
            title="Download file"
          >
            <Download className="h-4 w-4" /> Download
          </a>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        {/* PDF */}
        {isPdf && (
          <iframe src={api.shareContentUrl(shareId)} title={meta?.name} className="h-full w-full border-0" />
        )}

        {/* Image */}
        {isImage && (
          <div className="flex h-full w-full items-center justify-center bg-muted p-6">
            <img src={api.shareContentUrl(shareId)} alt={meta?.name} className="max-h-full max-w-full" />
          </div>
        )}

        {/* Markdown */}
        {isMarkdown && mode === 'rendered' && content !== null && (
          <div className="h-full overflow-y-auto bg-white dark:bg-gray-900">
            <div className="prose prose-sm mx-auto max-w-none px-8 py-6 dark:prose-invert prose-headings:font-semibold prose-a:text-blue-600 prose-code:text-sm prose-pre:bg-gray-900 prose-img:rounded-lg dark:prose-a:text-blue-400">
              <MarkdownPreview
                content={content}
                currentFilePath={null}
                onFileOpen={null}
                resolveImageUrl={resolveShareImageUrl}
              />
            </div>
          </div>
        )}

        {/* Diagram (PlantUML / DBML) */}
        {isDiagram && mode === 'rendered' && (
          <div className="flex min-h-full items-start justify-center bg-white p-6 dark:bg-gray-900">
            {render?.type === 'url' && (
              <div className="inline-block rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700">
                <img src={render.url} alt={meta?.name} className="max-w-full" />
              </div>
            )}
            {sanitizedSvg && (
              <div
                className="inline-block rounded-lg bg-white p-4 shadow-sm ring-1 ring-gray-200 dark:ring-gray-700 [&_svg]:max-w-full"
                 
                dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
              />
            )}
            {!render && (
              <p className="mt-12 text-sm text-muted-foreground">Couldn’t render this diagram.</p>
            )}
          </div>
        )}

        {/* HTML: render through the server preview route so sketch-style pages
            resolve their root-absolute `/kit/...` resources. Falls back to a
            srcDoc iframe for self-contained HTML if the render call didn't land. */}
        {isHtml && mode === 'rendered' && (
          render?.type === 'html' ? (
            <iframe
              title={meta?.name}
              src={render.url}
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
              className="h-full w-full border-0 bg-white"
            />
          ) : content !== null ? (
            <iframe
              title={meta?.name}
              srcDoc={content}
              sandbox="allow-scripts allow-popups allow-forms allow-modals"
              className="h-full w-full border-0 bg-white"
            />
          ) : null
        )}

        {/* Source / code highlight */}
        {((isText && !isMarkdown && !isDiagram && !isHtml) ||
          ((isMarkdown || isDiagram || isHtml) && mode === 'raw')) &&
          content !== null && (
            <CodeMirror
              value={content}
              extensions={languageExtensions}
              theme={isDark ? oneDark : undefined}
              editable={false}
              height="100%"
              style={{ height: '100%' }}
              basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: false }}
            />
          )}

        {/* Unsupported binary: download only */}
        {!isPreviewable && !isText && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background px-6 text-center text-muted-foreground">
            <Download className="h-10 w-10" />
            <p className="text-sm">This file can’t be previewed. Use the download button above.</p>
          </div>
        )}
      </main>
    </div>
  );
}
