/**
 * HTML live-preview support.
 *
 * Sketch-style HTML (e.g. the oqto design sketches) isn't self-contained: it
 * loads React/Babel/CSS from root-absolute paths (`/kit/...`, `/static/...`)
 * that a dev server maps to project directories. To render these in vibespace
 * we serve the file and its resources ourselves through an authenticated route,
 * applying the same path aliases and rewriting root-absolute references so they
 * point back at the route.
 *
 * The serving model (web root + alias map) is per project, read from an optional
 * `.vibespace/preview.json`, with a sensible default for the `_kit`-served-at-
 * `/kit` convention so the sketches work with no config.
 */

import path from 'path';
import { promises as fsPromises } from 'fs';

// Default aliases for the sketcher convention: a `_kit/` dir served at `/kit`,
// fonts under `_assets/fonts` at `/fonts`, and the whole web root at `/static`.
const DEFAULT_ALIASES = {
  '/kit': '_kit',
  '/fonts': '_assets/fonts',
  '/static': '.',
};

const TEXT_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.json', '.svg', '.xml', '.txt', '.map',
]);

/** Reads `.vibespace/preview.json` if present. Returns null when absent/invalid. */
async function readPreviewConfig(projectRoot) {
  try {
    const raw = await fsPromises.readFile(path.join(projectRoot, '.vibespace', 'preview.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.html && typeof parsed.html === 'object' ? parsed.html : parsed;
  } catch {
    return null;
  }
}

/** Walks up from `startDir` (inclusive) to `projectRoot` looking for a `_kit` dir. */
async function detectKitRoot(startDir, projectRoot) {
  const normalizedRoot = path.resolve(projectRoot);
  let dir = path.resolve(startDir);
  for (let i = 0; i < 40; i += 1) {
    try {
      const stat = await fsPromises.stat(path.join(dir, '_kit'));
      if (stat.isDirectory()) {
        return dir;
      }
    } catch {
      // keep walking
    }
    if (dir === normalizedRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolves the serving model for previewing `entryAbsPath`.
 * @returns {Promise<{ webRoot: string, aliases: Record<string,string>, entryRel: string }>}
 */
export async function resolvePreviewModel(entryAbsPath, projectRoot) {
  const config = await readPreviewConfig(projectRoot);

  let webRoot;
  let aliases;
  if (config?.root) {
    webRoot = path.resolve(projectRoot, config.root);
    aliases = config.aliases && typeof config.aliases === 'object' ? config.aliases : DEFAULT_ALIASES;
  } else {
    const kitRoot = await detectKitRoot(path.dirname(entryAbsPath), projectRoot);
    if (kitRoot) {
      webRoot = kitRoot;
      aliases = DEFAULT_ALIASES;
    } else {
      // No sketcher convention — serve relative to the file's own directory.
      webRoot = path.dirname(entryAbsPath);
      aliases = {};
    }
  }

  const entryRel = path.relative(webRoot, entryAbsPath).split(path.sep).join('/');
  return { webRoot, aliases, entryRel };
}

/**
 * Maps a request path (e.g. `/kit/tokens.css`) to an absolute file under the
 * web root, applying aliases. Returns null when the resolved path escapes the
 * project root.
 */
export function resolvePreviewAssetPath(reqPath, webRoot, aliases, projectRoot) {
  const normalizedReq = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;

  // Longest alias prefix first so `/static` doesn't shadow a more specific one.
  const prefixes = Object.keys(aliases).sort((a, b) => b.length - a.length);
  let target = null;
  for (const prefix of prefixes) {
    if (normalizedReq === prefix || normalizedReq.startsWith(`${prefix}/`)) {
      const rest = normalizedReq.slice(prefix.length).replace(/^\//, '');
      target = path.resolve(webRoot, aliases[prefix], rest);
      break;
    }
  }
  if (target === null) {
    target = path.resolve(webRoot, normalizedReq.replace(/^\//, ''));
  }

  const normalizedProjectRoot = path.resolve(projectRoot) + path.sep;
  if (!`${target}${path.sep}`.startsWith(normalizedProjectRoot) && target !== path.resolve(projectRoot)) {
    return null;
  }
  return target;
}

export function isTextAsset(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Matches a basename against a simple `*.ext`/`*.a.b` or exact-name glob. */
function matchesGlob(basename, pattern) {
  if (pattern.startsWith('*')) {
    return basename.endsWith(pattern.slice(1));
  }
  return basename === pattern;
}

/**
 * Resolves the command that renders a custom-format file to self-contained HTML.
 *
 * Order: an explicit `renderers` entry in `.vibespace/preview.json` (each
 * `{ match, command }`, command is an argv array with `{input}`/`{output}`
 * placeholders), then the built-in convention — a `*.flow.json` whose sibling
 * `_kit/render.mjs` exists is rendered with `node render.mjs <in> <out>`.
 *
 * @returns {Promise<{ bin: string, args: string[] } | null>} argv template with
 *   `{input}`/`{output}` still in `args`, or null when nothing renders it.
 */
export async function resolveCustomRenderer(absFilePath, projectRoot, nodeBin) {
  const basename = path.basename(absFilePath);

  const config = await readPreviewConfig(projectRoot);
  const renderers = Array.isArray(config?.renderers) ? config.renderers : [];
  for (const entry of renderers) {
    if (entry?.match && Array.isArray(entry.command) && entry.command.length > 0 && matchesGlob(basename, entry.match)) {
      const [bin, ...args] = entry.command;
      const resolvedBin = bin === 'node' ? nodeBin : bin;
      return { bin: resolvedBin, args };
    }
  }

  // Built-in: `*.flow.json` with a sibling `_kit/render.mjs`.
  if (basename.endsWith('.flow.json')) {
    const renderer = path.join(path.dirname(absFilePath), '_kit', 'render.mjs');
    try {
      const stat = await fsPromises.stat(renderer);
      if (stat.isFile()) {
        return { bin: nodeBin, args: [renderer, '{input}', '{output}'] };
      }
    } catch {
      // no sibling renderer
    }
  }

  return null;
}

/**
 * Rewrites root-absolute alias references inside a served text asset so they
 * point at the preview route (`assetBase` = `/api/projects/:id/preview-fs`).
 * e.g. `/kit/x` → `/api/projects/:id/preview-fs/kit/x`.
 */
export function rewriteAssetReferences(text, aliases, assetBase) {
  let out = text;
  for (const prefix of Object.keys(aliases)) {
    // Match the alias prefix only at a URL boundary (after quote, paren, `=`,
    // whitespace, or comma) to avoid mangling unrelated substrings.
    const re = new RegExp(`([\\"'\\(=,\\s])${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'g');
    out = out.replace(re, `$1${assetBase}${prefix}/`);
  }
  return out;
}
