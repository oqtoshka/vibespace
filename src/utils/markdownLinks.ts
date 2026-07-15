/**
 * Helpers for making links in rendered markdown navigate inside the app
 * (open the target file in the editor) instead of hitting the SPA server
 * and 404ing.
 */

const EXTERNAL_HREF_REGEX = /^[a-z][a-z0-9+.-]*:/i;

/** True for links with a scheme (`https:`, `mailto:`, …) or protocol-relative `//`. */
export function isExternalHref(href: string): boolean {
  return EXTERNAL_HREF_REGEX.test(href) || href.startsWith('//');
}

/**
 * Resolves a markdown link target to a file path the project file API
 * understands, or `null` when the link should keep default anchor behavior.
 *
 * - External (`https:`, `mailto:`, …) and `#fragment`-only links → `null`.
 * - Root-relative links (`/docs/x.md`) are treated GitHub-style as
 *   project-root-relative; the server resolves non-absolute paths against
 *   the project root (see `server/index.js` file endpoint).
 * - Relative links resolve against the directory of `currentFilePath`,
 *   preserving its absolute/relative form. Query strings and fragments are
 *   stripped; percent-encoding (e.g. `%20`) is decoded.
 */
/** Strips the query string / fragment and decodes percent-encoding. */
export function stripHrefDecorations(href: string): string | null {
  let target = href.split('#')[0].split('?')[0];
  if (!target) {
    return null;
  }

  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep the raw value when the href contains stray percent signs.
  }

  return target || null;
}

export function resolveMarkdownLinkPath(
  href: string | undefined,
  currentFilePath?: string | null,
): string | null {
  if (!href || href.startsWith('#') || isExternalHref(href)) {
    return null;
  }

  const target = stripHrefDecorations(href);
  if (!target) {
    return null;
  }

  if (target.startsWith('/')) {
    return target.replace(/^\/+/, '');
  }

  const normalizedBase = (currentFilePath ?? '').replace(/\\/g, '/');
  const isAbsoluteBase = normalizedBase.startsWith('/');
  // For an absolute base the leading '' segment preserves the root slash
  // when re-joined; never pop past it while applying '..'.
  const segments = normalizedBase ? normalizedBase.split('/').slice(0, -1) : [];

  for (const part of target.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      if (segments.length > (isAbsoluteBase ? 1 : 0)) {
        segments.pop();
      }
      continue;
    }
    segments.push(part);
  }

  const joined = segments.join('/');
  return joined || null;
}
