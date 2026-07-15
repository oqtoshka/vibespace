import { parse as parseYaml } from 'yaml';

/**
 * Splits a YAML frontmatter block off the top of a markdown document so the
 * preview can render it as structured metadata instead of feeding the `---`
 * fences to the markdown renderer (which shows them as a thematic break plus
 * stray paragraph text).
 */

export type FrontmatterSplit = {
  /** Parsed frontmatter mapping, or null when the document has none. */
  frontmatter: Record<string, unknown> | null;
  /** Document content with the frontmatter block removed. */
  body: string;
};

// Opening fence must be the very first line: exactly `---` (trailing spaces
// tolerated). The block closes at the next `---` or `...` line, per YAML
// document-end conventions used by frontmatter processors.
const OPENING_FENCE = /^---[ \t]*\r?\n/;
const CLOSING_FENCE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;

export function splitMarkdownFrontmatter(content: string): FrontmatterSplit {
  const noFrontmatter: FrontmatterSplit = { frontmatter: null, body: content };

  const opening = OPENING_FENCE.exec(content);
  if (!opening) {
    return noFrontmatter;
  }

  const afterOpening = content.slice(opening[0].length);
  const closing = CLOSING_FENCE.exec(afterOpening);
  if (!closing) {
    return noFrontmatter;
  }

  const yamlSource = afterOpening.slice(0, closing.index);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlSource);
  } catch {
    // Malformed YAML — leave the document alone rather than hiding content.
    return noFrontmatter;
  }

  // Frontmatter is only meaningful as a key/value mapping; a scalar or list
  // between `---` fences is more likely a literal thematic break in prose.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return noFrontmatter;
  }

  const frontmatter = parsed as Record<string, unknown>;
  if (Object.keys(frontmatter).length === 0) {
    return { frontmatter: null, body: afterOpening.slice(closing.index + closing[0].length) };
  }

  return { frontmatter, body: afterOpening.slice(closing.index + closing[0].length) };
}
