import { useMemo } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import { splitMarkdownFrontmatter } from '../../../../../utils/markdownFrontmatter';
import { resolveMarkdownLinkPath } from '../../../../../utils/markdownLinks';

import FrontmatterCard from './FrontmatterCard';
import MarkdownCodeBlock from './MarkdownCodeBlock';

type MarkdownPreviewProps = {
  content: string;
  /** Path of the previewed file; relative links resolve against its directory. */
  currentFilePath?: string | null;
  /** Opens an in-project file when a relative/root-relative link is clicked. */
  onFileOpen?: ((filePath: string) => void) | null;
};

const ANCHOR_CLASS_NAME = 'text-blue-600 hover:underline dark:text-blue-400';

const staticMarkdownPreviewComponents: Components = {
  code: MarkdownCodeBlock,
  // MarkdownCodeBlock renders its own highlighted <pre>; passthrough prevents a
  // second Typography-styled <pre> shell from framing it.
  pre: ({ children }) => <>{children}</>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-4 border-border pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse border border-border">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-border px-3 py-2 text-left text-sm font-semibold">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-3 py-2 align-top text-sm">{children}</td>
  ),
};

export default function MarkdownPreview({ content, currentFilePath = null, onFileOpen = null }: MarkdownPreviewProps) {
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath], []);
  const rehypePlugins = useMemo(() => [rehypeKatex], []);
  const { frontmatter, body } = useMemo(() => splitMarkdownFrontmatter(content), [content]);

  const components: Components = useMemo(
    () => ({
      ...staticMarkdownPreviewComponents,
      a: ({ href, children }) => {
        // In-project link → open the target file instead of navigating the SPA
        // to a route that doesn't exist (404).
        const internalPath = onFileOpen ? resolveMarkdownLinkPath(href, currentFilePath) : null;
        if (internalPath) {
          return (
            <a
              href={href}
              className={ANCHOR_CLASS_NAME}
              onClick={(event) => {
                event.preventDefault();
                onFileOpen?.(internalPath);
              }}
            >
              {children}
            </a>
          );
        }

        // Same-document fragment: keep it in this tab.
        if (href?.startsWith('#')) {
          return (
            <a href={href} className={ANCHOR_CLASS_NAME}>
              {children}
            </a>
          );
        }

        return (
          <a href={href} className={ANCHOR_CLASS_NAME} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    [currentFilePath, onFileOpen],
  );

  return (
    <>
      {frontmatter && <FrontmatterCard frontmatter={frontmatter} />}
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {body}
      </ReactMarkdown>
    </>
  );
}
