/**
 * Remark plugin that turns file references agents write as plain text into
 * links the chat renderer can open:
 *
 * - `MEDIA:<path>` lines (the Telegram attachment convention agents also use
 *   in the web chat) become links flagged as attachments, rendered as a file
 *   card with Open and Download.
 * - Bare absolute paths under the project root (`/workspace/out/report.xlsx`)
 *   become ordinary file links.
 *
 * Code spans, fenced code and existing links are left untouched.
 */

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
};

export const ATTACHMENT_LINK_ATTRIBUTE = 'data-vs-attachment';

const SKIP_TYPES = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'html', 'math', 'inlineMath']);

// Paths end at whitespace or at characters that close a sentence or bracket.
const PATH_CHARS = String.raw`[^\s<>"'\`()\[\]{}]+`;
const TRAILING_PUNCTUATION = /[.,;:!?»”]+$/;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildPattern = (projectRoot: string | null): RegExp => {
  const media = String.raw`MEDIA:\s*(${PATH_CHARS})`;
  if (!projectRoot) {
    return new RegExp(media, 'g');
  }
  // Only paths under the project root: anything else is not openable here.
  const bare = String.raw`(?<![\w/.~-])(${escapeRegExp(projectRoot)}/${PATH_CHARS})`;
  return new RegExp(`${media}|${bare}`, 'g');
};

const linkNode = (path: string, attachment: boolean): MdNode => ({
  type: 'link',
  url: path,
  children: [{ type: 'text', value: attachment ? path.split('/').filter(Boolean).pop() || path : path }],
  data: attachment ? { hProperties: { [ATTACHMENT_LINK_ATTRIBUTE]: 'true' } } : undefined,
});

const splitText = (value: string, pattern: RegExp): MdNode[] | null => {
  pattern.lastIndex = 0;
  const parts: MdNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const attachment = match[1] !== undefined;
    let path = attachment ? match[1] : match[2];
    const trailing = path.match(TRAILING_PUNCTUATION)?.[0] ?? '';
    path = path.slice(0, path.length - trailing.length);
    // A lone root (`/workspace/`) or an empty MEDIA target is not a file.
    if (!path || path.endsWith('/')) {
      continue;
    }
    const start = match.index;
    const end = start + match[0].length - trailing.length;
    if (start > cursor) {
      parts.push({ type: 'text', value: value.slice(cursor, start) });
    }
    parts.push(linkNode(path, attachment));
    cursor = end;
  }
  if (!parts.length) {
    return null;
  }
  if (cursor < value.length) {
    parts.push({ type: 'text', value: value.slice(cursor) });
  }
  return parts;
};

const walk = (node: MdNode, pattern: RegExp) => {
  if (!node.children || SKIP_TYPES.has(node.type)) {
    return;
  }
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && child.value) {
      const replaced = splitText(child.value, pattern);
      if (replaced) {
        next.push(...replaced);
        continue;
      }
    } else {
      walk(child, pattern);
    }
    next.push(child);
  }
  node.children = next;
};

export function remarkWorkspaceFileLinks(options: { projectRoot?: string | null } = {}) {
  const root = options.projectRoot?.replace(/\\/g, '/').replace(/\/+$/, '') || null;
  const pattern = buildPattern(root && root !== '' ? root : null);
  return (tree: MdNode) => {
    walk(tree, pattern);
  };
}
