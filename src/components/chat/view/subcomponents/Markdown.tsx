import React, { createContext, memo, useContext, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useTranslation } from 'react-i18next';

import { normalizeInlineCodeFences } from '../../utils/chatFormatting';
import { authenticatedFetch } from '../../../../utils/api';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import {
  generatedImageArtifactUrl,
  projectImageArtifactUrl,
  resolveGeneratedImageArtifactPath,
  resolveProjectImagePath,
} from '../../../../utils/generatedImageArtifacts';
import { resolveMarkdownLinkPath } from '../../../../utils/markdownLinks';
import { projectFileExists } from '../../../../utils/projectFileLookup';
import { usePaletteOps } from '../../../../contexts/PaletteOpsContext';
import { useTheme } from '../../../../contexts/ThemeContext';
import MermaidDiagram from '../../../markdown/MermaidDiagram';
import PlantUmlDiagram from '../../../markdown/PlantUmlDiagram';

import { ImageLightbox } from './ChatMessageImages';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  /** Opens a relative or absolute workspace file when its link is clicked. */
  onFileOpen?: ((filePath: string) => void) | null;
  /** Enables clickable inline-code file paths (existence-checked per project). */
  projectId?: string | null;
  /** Absolute project root, used to relativize absolute paths the model emits. */
  projectPath?: string | null;
  /** Render single newlines as hard line breaks (for user-typed messages). */
  breaks?: boolean;
};

/**
 * Lets the statically-defined markdown component overrides (CodeBlock) reach
 * the per-message project context without threading props through
 * react-markdown.
 */
type MarkdownFileContextValue = {
  projectId: string | null;
  projectPath: string | null;
  openFile: ((filePath: string) => void) | null;
};

const MarkdownFileContext = createContext<MarkdownFileContextValue>({
  projectId: null,
  projectPath: null,
  openFile: null,
});

// Links to the wider web (or in-page anchors) keep normal browser navigation;
// everything else is treated as a workspace file reference.
const isExternalHref = (href?: string): boolean =>
  !!href && (/^(https?:|mailto:|tel:|data:)/i.test(href) || href.startsWith('#'));

// Strip a trailing `:line` / `:line:col` suffix (e.g. `src/foo.ts:130`).
const stripLineSuffix = (value: string): string => value.replace(/:\d+(?::\d+)?$/, '');

// A usable file path contains a separator or a filename with an extension.
const looksLikeFilePath = (value?: string): value is string => {
  if (!value) {
    return false;
  }
  const cleaned = stripLineSuffix(value.trim());
  if (!cleaned || cleaned === '#') {
    return false;
  }
  return /[\\/]/.test(cleaned) || /\.[a-z0-9]+$/i.test(cleaned);
};

// Extract plain text from link children so a reference rendered only as link
// text (e.g. `[src/foo.ts]()` with an empty href) can still be opened.
const childrenToText = (children: React.ReactNode): string => {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(childrenToText).join('');
  }
  if (React.isValidElement(children)) {
    return childrenToText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
};

function useAuthenticatedImageSrc(
  requestUrl: string,
  enabled = true,
): { src: string | null; failed: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const controller = new AbortController();
    let objectUrl: string | null = null;

    setSrc(null);
    setFailed(false);
    void authenticatedFetch(requestUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Generated image request failed with ${response.status}`);
        }
        const blob = await response.blob();
        if (!blob.type.startsWith('image/')) {
          throw new Error('Generated artifact is not an image');
        }
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((error) => {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          setFailed(true);
        }
      });

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [enabled, requestUrl]);

  return { src, failed };
}

/**
 * Keeps a Markdown image link as text while loading an authenticated preview
 * on first hover/focus. Project images still open in the file editor; generated
 * artifacts open in the existing image lightbox because they live outside the
 * active project and cannot be represented by a project file tab.
 */
function AuthenticatedImageLink({
  href,
  requestUrl,
  filename,
  children,
  onOpen,
}: {
  href?: string;
  requestUrl: string;
  filename: string;
  children?: React.ReactNode;
  onOpen?: () => void;
}) {
  const [loadRequested, setLoadRequested] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { src, failed } = useAuthenticatedImageSrc(requestUrl, loadRequested);
  const label = childrenToText(children).trim() || filename;

  const showPreview = () => {
    setLoadRequested(true);
    setPreviewVisible(true);
  };

  return (
    <>
      <span className="relative inline-block">
        <a
          href={href}
          className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400"
          onMouseEnter={showPreview}
          onMouseLeave={() => setPreviewVisible(false)}
          onFocus={showPreview}
          onBlur={() => setPreviewVisible(false)}
          onClick={(event) => {
            event.preventDefault();
            if (onOpen) {
              onOpen();
              return;
            }
            setLoadRequested(true);
            setPreviewVisible(false);
            setExpanded(true);
          }}
        >
          {children}
        </a>
        {previewVisible && (
          <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 block -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-xl">
            {failed ? (
              <span className="block w-48 px-2 py-3 text-xs text-muted-foreground">
                Could not load image preview
              </span>
            ) : src ? (
              <img src={src} alt="" className="max-h-72 max-w-80 rounded-lg object-contain" />
            ) : (
              <span className="block h-32 w-48 animate-pulse rounded-lg bg-muted" />
            )}
          </span>
        )}
      </span>
      {expanded && src && (
        <ImageLightbox src={src} alt={label} onClose={() => setExpanded(false)} />
      )}
    </>
  );
}

/** Inline preview for links into Codex's generated-image artifact directory. */
function AuthenticatedMarkdownImage({
  requestUrl,
  filename,
  alt,
}: {
  requestUrl: string;
  filename: string;
  alt: string;
}) {
  const { src, failed } = useAuthenticatedImageSrc(requestUrl);
  const [expanded, setExpanded] = useState(false);
  const label = alt.trim() || filename;

  if (failed) {
    return (
      <span className="my-2 block rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        Could not load image: <code>{filename}</code>
      </span>
    );
  }

  if (!src) {
    return <span className="my-2 block h-40 w-full animate-pulse rounded-xl border border-border/50 bg-muted" />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label={`Expand ${label}`}
        className="my-2 block max-w-full overflow-hidden rounded-xl border border-border/50 bg-muted/20 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
      >
        <img src={src} alt={label} className="max-h-[32rem] max-w-full cursor-zoom-in object-contain" />
      </button>
      {expanded && <ImageLightbox src={src} alt={label} onClose={() => setExpanded(false)} />}
    </>
  );
}

/**
 * Reduces an inline-code span to a project-root-relative path candidate, or
 * null when the text can't be a workspace file reference. Deliberately strict
 * (no spaces, no parens, no out-of-project absolutes) — whatever passes is
 * still verified against the real file tree before becoming clickable.
 */
function extractInlinePathCandidate(raw: string, projectPath?: string | null): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512 || /\s/.test(trimmed)) {
    return null;
  }

  let cleaned = stripLineSuffix(trimmed).replace(/\\/g, '/');
  if (isExternalHref(cleaned) || /["'`<>|()]/.test(cleaned)) {
    return null;
  }

  if (projectPath) {
    const normalizedRoot = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalizedRoot && cleaned.startsWith(`${normalizedRoot}/`)) {
      cleaned = cleaned.slice(normalizedRoot.length + 1);
    }
  }

  // Home-anchored or absolute paths that didn't match the project root can't
  // be resolved by the project file API.
  if (cleaned.startsWith('~') || cleaned.startsWith('/')) {
    return null;
  }

  cleaned = cleaned.replace(/^\.\//, '');
  if (!cleaned || cleaned.endsWith('/') || cleaned.split('/').includes('..')) {
    return null;
  }

  // Must read as a path: contain a separator or end in a file extension.
  if (!cleaned.includes('/') && !/\.[a-z0-9]{1,8}$/i.test(cleaned)) {
    return null;
  }

  return cleaned;
}

const INLINE_CODE_CLASS =
  'whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-gray-100 px-1.5 py-0.5 font-mono text-[0.9em] text-gray-900 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-100';

type InlineCodeProps = {
  codeText: string;
  className?: string;
  children?: React.ReactNode;
};

/**
 * Inline code span that turns into a file link when its text names a real
 * project file (agents reference files as `src/foo.ts` far more often than as
 * markdown links). Existence is verified through a cached directory listing,
 * so `Object.keys`-style tokens stay plain code.
 */
function InlineCode({ codeText, className, children, ...props }: InlineCodeProps) {
  const { projectId, projectPath, openFile } = useContext(MarkdownFileContext);
  const candidate = useMemo(
    () => (projectId && openFile ? extractInlinePathCandidate(codeText, projectPath) : null),
    [codeText, openFile, projectId, projectPath],
  );
  const [verifiedPath, setVerifiedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!candidate || !projectId) {
      setVerifiedPath(null);
      return;
    }
    let cancelled = false;
    void projectFileExists(projectId, candidate).then((exists) => {
      if (!cancelled) {
        setVerifiedPath(exists ? candidate : null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [candidate, projectId]);

  if (!verifiedPath || !openFile) {
    return (
      <code className={`${INLINE_CODE_CLASS} ${className || ''}`} {...props}>
        {children}
      </code>
    );
  }

  return (
    <code
      className={`${INLINE_CODE_CLASS} cursor-pointer underline decoration-dotted underline-offset-2 hover:text-blue-600 dark:hover:text-blue-400 ${className || ''}`}
      role="link"
      tabIndex={0}
      title={verifiedPath}
      onClick={() => openFile(verifiedPath)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openFile(verifiedPath);
        }
      }}
      {...props}
    >
      {children}
    </code>
  );
}

type CodeBlockProps = {
  node?: any;
  className?: string;
  children?: React.ReactNode;
  /** Set by the custom `pre` renderer: this code element is a fenced/indented block. */
  forceBlock?: boolean;
};

// `node` is destructured out so react-markdown's hast node never reaches the DOM.
const CodeBlock = ({ node: _node, className, children, forceBlock, ...props }: CodeBlockProps) => {
  const { t } = useTranslation('chat');
  const { isDarkMode } = useTheme();
  const [copied, setCopied] = useState(false);
  // Fenced blocks carry a trailing newline in the tree; trim it so the
  // highlighter doesn't render an empty final line.
  const raw = (Array.isArray(children) ? children.join('') : String(children ?? '')).replace(/\n$/, '');
  // react-markdown v9+ dropped the `inline` prop: block code is whatever the
  // `pre` renderer hands us (forceBlock). Multiline is kept as a safety net.
  const shouldInline = !forceBlock && !/[\r\n]/.test(raw);

  if (shouldInline) {
    return (
      <InlineCode codeText={raw} className={className} {...props}>
        {children}
      </InlineCode>
    );
  }

  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';
  const languageLabel = language.charAt(0).toUpperCase() + language.slice(1);

  const highlightedBlock = (
    <div className="group my-3 overflow-hidden rounded-xl border border-border bg-muted/50 shadow-sm dark:bg-zinc-900">
      {/* Label row shares the block's background — no divider, ChatGPT-style */}
      <div className="flex items-center justify-between px-4 pt-2">
        <span className="select-none text-xs text-muted-foreground">{languageLabel}</span>
        <button
          type="button"
          onClick={() =>
            copyTextToClipboard(raw).then((success) => {
              if (success) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            })
          }
          className={`rounded-md p-1 transition-opacity focus-visible:opacity-100 ${copied
            ? 'text-green-600 opacity-100 dark:text-green-500'
            : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100'
            }`}
          title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
          aria-label={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
        >
          {copied ? (
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
            </svg>
          )}
        </button>
      </div>

      <SyntaxHighlighter
        language={language}
        style={isDarkMode ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          borderRadius: 0,
          fontSize: '0.8125rem',
          lineHeight: 1.6,
          padding: '0.5rem 1rem 1rem',
          // The container owns the background so the label row and code read as one panel.
          background: 'transparent',
        }}
        codeTagProps={{
          style: {
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            background: 'transparent',
          },
        }}
      >
        {raw}
      </SyntaxHighlighter>
    </div>
  );

  // Diagram fences render as diagrams; invalid source (e.g. a message still
  // streaming in) falls back to the highlighted block above.
  if (language === 'mermaid') {
    return <MermaidDiagram source={raw} fallback={highlightedBlock} />;
  }
  if (language === 'plantuml' || language === 'puml') {
    return <PlantUmlDiagram source={raw} fallback={highlightedBlock} />;
  }

  return highlightedBlock;
};

const markdownComponents = {
  code: CodeBlock,
  // Fenced/indented code arrives as <pre><code>. Re-render the child CodeBlock
  // with `forceBlock` so it always gets the block treatment (react-markdown v9+
  // no longer passes an `inline` flag), and skip the outer <pre> so Tailwind
  // Typography doesn't wrap the highlighter in a second dark shell.
  pre: ({ children }: { children?: React.ReactNode }) => {
    const child = Array.isArray(children) ? children.find(React.isValidElement) : children;
    if (React.isValidElement(child) && child.type === CodeBlock) {
      return <CodeBlock {...(child.props as CodeBlockProps)} forceBlock />;
    }
    return <>{children}</>;
  },
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-3 border-l-2 border-primary/50 pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-t border-border" />,
  p: ({ children }: { children?: React.ReactNode }) => <div className="mb-2 last:mb-0">{children}</div>,
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-2 list-outside list-disc space-y-1 pl-5 marker:text-current last:mb-0">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-2 list-outside list-decimal space-y-1 pl-5 marker:text-current last:mb-0">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li className="[&>div:last-child]:mb-0 [&>div]:mb-1">{children}</li>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      {/* my-0 cancels Tailwind Typography's table margin, which would show as blank bands inside the border */}
      <table className="my-0 min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-muted/60">{children}</thead>,
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="[&:last-child>td]:border-b-0">{children}</tr>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border-b border-border px-3 py-2 text-left font-semibold text-foreground">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border-b border-border/60 px-3 py-2 align-top">{children}</td>
  ),
};

function MarkdownBase({
  children,
  className,
  breaks = false,
  onFileOpen = null,
  projectId = null,
  projectPath = null,
}: MarkdownProps) {
  const content = normalizeInlineCodeFences(String(children ?? ''));
  const remarkPlugins = useMemo(
    () => (breaks
      ? [remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkBreaks]
      : [remarkGfm, [remarkMath, { singleDollarTextMath: false }]]) as any,
    [breaks],
  );
  const rehypePlugins = useMemo(() => [rehypeKatex], []);
  const { openFileInEditor } = usePaletteOps();

  const fileContext = useMemo<MarkdownFileContextValue>(
    () => ({
      projectId,
      projectPath,
      openFile: onFileOpen ?? openFileInEditor ?? null,
    }),
    [onFileOpen, openFileInEditor, projectId, projectPath],
  );

  const components = useMemo(
    () => ({
      ...markdownComponents,
      img: ({ src, alt }: { src?: string; alt?: string }) => {
        const artifactPath = resolveGeneratedImageArtifactPath(src);
        if (artifactPath) {
          return (
            <AuthenticatedMarkdownImage
              requestUrl={generatedImageArtifactUrl(artifactPath)}
              filename={artifactPath.split('/').pop() || 'Generated image'}
              alt={alt || ''}
            />
          );
        }
        const projectImagePath = projectId ? resolveProjectImagePath(src, projectPath) : null;
        if (projectId && projectImagePath) {
          return (
            <AuthenticatedMarkdownImage
              requestUrl={projectImageArtifactUrl(projectId, projectImagePath)}
              filename={projectImagePath.split('/').pop() || 'Project image'}
              alt={alt || ''}
            />
          );
        }
        return <img src={src} alt={alt || ''} className="my-2 max-w-full rounded-lg" loading="lazy" />;
      },
      a: ({ href, children: linkChildren }: { href?: string; children?: React.ReactNode }) => {
        const artifactPath = resolveGeneratedImageArtifactPath(href);
        if (artifactPath) {
          return (
            <AuthenticatedImageLink
              href={href}
              requestUrl={generatedImageArtifactUrl(artifactPath)}
              filename={artifactPath.split('/').pop() || 'Generated image'}
            >
              {linkChildren}
            </AuthenticatedImageLink>
          );
        }

        const projectImagePath = projectId ? resolveProjectImagePath(href, projectPath) : null;
        if (projectId && projectImagePath) {
          return (
            <AuthenticatedImageLink
              href={href}
              requestUrl={projectImageArtifactUrl(projectId, projectImagePath)}
              filename={projectImagePath.split('/').pop() || 'Project image'}
              onOpen={() => (onFileOpen ?? openFileInEditor)(projectImagePath)}
            >
              {linkChildren}
            </AuthenticatedImageLink>
          );
        }

        // Chat messages have no source file, so relative links resolve against
        // the project root. Preserve absolute paths so the editor can pass them
        // to the server's configured-workspace path validator unchanged.
        const internalPath = onFileOpen ? resolveMarkdownLinkPath(href, null, true) : null;
        if (internalPath) {
          return (
            <a
              href={href}
              className="text-blue-600 hover:underline dark:text-blue-400"
              onClick={(event) => {
                event.preventDefault();
                onFileOpen?.(internalPath);
              }}
            >
              {linkChildren}
            </a>
          );
        }

        // No onFileOpen (or the href didn't resolve): fall back to the palette
        // route. Prefer the href when it is a real path; otherwise the link
        // text, since models often emit `[src/foo.ts]()` with an empty href.
        const linkText = childrenToText(linkChildren);
        const fileRef = looksLikeFilePath(href) ? href : looksLikeFilePath(linkText) ? linkText : undefined;

        if (fileRef && !isExternalHref(href)) {
          return (
            <a
              href={href || fileRef}
              className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400"
              onClick={(event) => {
                event.preventDefault();
                openFileInEditor(stripLineSuffix(fileRef));
              }}
            >
              {linkChildren}
            </a>
          );
        }

        return (
          <a href={href} className="text-blue-600 hover:underline dark:text-blue-400" target="_blank" rel="noopener noreferrer">
            {linkChildren}
          </a>
        );
      },
    }),
    [onFileOpen, openFileInEditor, projectId, projectPath],
  );

  return (
    <MarkdownFileContext.Provider value={fileContext}>
      <div className={className}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components as any}>
          {content}
        </ReactMarkdown>
      </div>
    </MarkdownFileContext.Provider>
  );
}

// The remark/rehype/Prism pipeline is the priciest render in the transcript;
// all props are primitives or stable references, so memo lets unchanged
// messages skip the re-parse when a parent re-renders.
export const Markdown = memo(MarkdownBase);
