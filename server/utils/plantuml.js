/**
 * PlantUML rendering helpers.
 *
 * The browser can't reach a project's local `!include` files, so diagrams that
 * pull in a shared theme/skin (most real-world ones) fail to render against a
 * remote PlantUML server. We resolve those includes here on the server (which
 * has filesystem access, bounded to the project root), inline them, then encode
 * the combined source for the PlantUML server's URL transport.
 *
 * Encoding: raw DEFLATE + PlantUML's base64 variant, served at `/svg/<code>`
 * (the server's default, compression-friendly transport — keeps URLs short).
 */

import zlib from 'zlib';
import path from 'path';
import { promises as fsPromises } from 'fs';

const MAX_INCLUDE_DEPTH = 20;

function encode6bit(b) {
  if (b < 10) return String.fromCharCode(48 + b);
  b -= 10;
  if (b < 26) return String.fromCharCode(65 + b);
  b -= 26;
  if (b < 26) return String.fromCharCode(97 + b);
  b -= 26;
  if (b === 0) return '-';
  if (b === 1) return '_';
  return '?';
}

function append3bytes(b1, b2, b3) {
  const c1 = b1 >> 2;
  const c2 = ((b1 & 0x3) << 4) | (b2 >> 4);
  const c3 = ((b2 & 0xF) << 2) | (b3 >> 6);
  const c4 = b3 & 0x3F;
  return encode6bit(c1 & 0x3F) + encode6bit(c2 & 0x3F) + encode6bit(c3 & 0x3F) + encode6bit(c4 & 0x3F);
}

/** PlantUML base64 variant over arbitrary bytes. */
function encodePlantUmlBytes(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    if (i + 2 === bytes.length) {
      result += append3bytes(bytes[i], bytes[i + 1], 0);
    } else if (i + 1 === bytes.length) {
      result += append3bytes(bytes[i], 0, 0);
    } else {
      result += append3bytes(bytes[i], bytes[i + 1], bytes[i + 2]);
    }
  }
  return result;
}

/** Encodes PlantUML source into the server's `/svg/<code>` path segment. */
export function encodePlantUmlSource(source) {
  const deflated = zlib.deflateRawSync(Buffer.from(source, 'utf8'), { level: 9 });
  return encodePlantUmlBytes(deflated);
}

// Matches `!include`, `!include_once`, `!include_many`, `!includesub` with a
// path argument. Built-in spec like `!theme name` or `!include <std/...>` (angle
// brackets = stdlib) are left untouched — those resolve on the server itself.
const INCLUDE_RE = /^(\s*)!(include(?:_once|_many|sub)?)\s+(.+?)\s*$/i;

function isLocalIncludeTarget(target) {
  const trimmed = target.trim();
  if (!trimmed) return false;
  // <...> is a stdlib import resolved by the PlantUML server.
  if (trimmed.startsWith('<')) return false;
  // URLs are fetched by the server.
  if (/^https?:\/\//i.test(trimmed)) return false;
  return true;
}

/**
 * Recursively inlines local `!include` directives in `source`. Each include is
 * resolved relative to `baseDir` and must stay within `projectRoot`. A path can
 * carry a `!subpart`/index suffix (`file.puml!id`) — we strip it and inline the
 * whole file (good enough for preview). Missing/forbidden includes are replaced
 * with a comment so the rest of the diagram still renders.
 *
 * @param {string} source
 * @param {string} baseDir - directory the includes resolve against
 * @param {string} projectRoot
 * @param {Set<string>} seen - absolute paths already inlined (cycle guard)
 * @param {number} depth
 * @returns {Promise<string>}
 */
export async function inlinePlantUmlIncludes(source, baseDir, projectRoot, seen = new Set(), depth = 0) {
  if (depth > MAX_INCLUDE_DEPTH) {
    return source;
  }
  const normalizedRoot = path.resolve(projectRoot) + path.sep;
  const lines = source.split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    const match = line.match(INCLUDE_RE);
    if (!match) {
      out.push(line);
      continue;
    }

    const rawTarget = match[3];
    if (!isLocalIncludeTarget(rawTarget)) {
      out.push(line);
      continue;
    }

    // Strip an optional `!subpart`/`!index` suffix and surrounding quotes.
    const targetPath = rawTarget.replace(/!.*$/, '').replace(/^["']|["']$/g, '').trim();
    const resolved = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(baseDir, targetPath);

    if (!resolved.startsWith(normalizedRoot)) {
      out.push(`' [include skipped — outside project: ${targetPath}]`);
      continue;
    }
    if (seen.has(resolved)) {
      // Already inlined; PlantUML's include_once semantics — skip silently.
      continue;
    }

    try {
      const included = await fsPromises.readFile(resolved, 'utf8');
      seen.add(resolved);
      const nested = await inlinePlantUmlIncludes(
        included,
        path.dirname(resolved),
        projectRoot,
        seen,
        depth + 1,
      );
      // Drop the included file's own @startuml/@enduml wrappers so the combined
      // document stays a single diagram.
      const body = nested
        .split(/\r?\n/)
        .filter((l) => !/^\s*@(start|end)uml\b/i.test(l))
        .join('\n');
      out.push(body);
    } catch (error) {
      out.push(`' [include not found: ${targetPath}]`);
    }
  }

  return out.join('\n');
}
