/**
 * HTML live-preview rendering support.
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

import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

type PreviewAliases = Record<string, string>;

type PreviewConfig = {
  root?: string;
  aliases?: PreviewAliases;
  renderers?: unknown[];
};

type PreviewModel = {
  webRoot: string;
  aliases: PreviewAliases;
  entryRel: string;
};

type RendererCommand = {
  bin: string;
  args: string[];
};

// Default aliases for the sketcher convention: a `_kit/` dir served at `/kit`,
// fonts under `_assets/fonts` at `/fonts`, and the whole web root at `/static`.
const DEFAULT_ALIASES: PreviewAliases = {
  '/kit': '_kit',
  '/fonts': '_assets/fonts',
  '/static': '.',
};

const TEXT_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.json', '.svg', '.xml', '.txt', '.map',
]);

/** Reads `.vibespace/preview.json` if present. Returns null when absent/invalid. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readAliases(value: unknown): PreviewAliases | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

/** Reads preview configuration for the HTML-preview rendering service. */
async function readPreviewConfig(projectRoot: string): Promise<PreviewConfig | null> {
  try {
    const raw = await fsPromises.readFile(path.join(projectRoot, '.vibespace', 'preview.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const selected = isRecord(parsed) && isRecord(parsed.html) ? parsed.html : parsed;
    if (!isRecord(selected)) return null;
    return {
      root: typeof selected.root === 'string' ? selected.root : undefined,
      aliases: readAliases(selected.aliases),
      renderers: Array.isArray(selected.renderers) ? selected.renderers : undefined,
    };
  } catch {
    return null;
  }
}

/** Walks up from `startDir` (inclusive) to `projectRoot` looking for a `_kit` dir. */
async function detectKitRoot(startDir: string, projectRoot: string): Promise<string | null> {
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
 * Resolves the serving model used by the HTML-preview module routes for
 * previewing `entryAbsPath`.
 */
export async function resolvePreviewModel(
  entryAbsPath: string,
  projectRoot: string,
): Promise<PreviewModel> {
  const config = await readPreviewConfig(projectRoot);

  let webRoot: string;
  let aliases: PreviewAliases;
  if (config?.root) {
    webRoot = path.resolve(projectRoot, config.root);
    aliases = config.aliases || DEFAULT_ALIASES;
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
 * project root. Used by authenticated and shared HTML-preview asset routes.
 */
export function resolvePreviewAssetPath(
  reqPath: string,
  webRoot: string,
  aliases: PreviewAliases,
  projectRoot: string,
): string | null {
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

/** Tells HTML-preview routes which assets require URL rewriting before serving. */
export function isTextAsset(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Wires a rendered flow's cross-flow links to open the target `.flow.json` in
 * vibespace instead of navigating the iframe to a dead docs URL.
 *
 * The flow renderer emits links as `DOCSIFY_BASE_URL_PLACEHOLDER/diagrams/<ref>.html`
 * (the docs build substitutes the placeholder; we run the renderer raw, so the
 * link 404s). We resolve `<ref>` to the source `.flow.json` under the project's
 * `diagrams/` dir, replace the href with a data attribute, and inject a click
 * interceptor that postMessages the path up to the parent (which opens the file).
 */
export function wireFlowCrossLinks(
  html: string,
  currentFileAbs: string,
  projectRoot: string,
): string {
  const diagSegment = `${path.sep}diagrams${path.sep}`;
  const diagIdx = currentFileAbs.indexOf(diagSegment);
  const diagramsRoot = diagIdx >= 0
    ? currentFileAbs.slice(0, diagIdx + `${path.sep}diagrams`.length)
    : path.dirname(currentFileAbs);
  const normalizedProjectRoot = path.resolve(projectRoot) + path.sep;

  let out = html.replace(
    /href="DOCSIFY_BASE_URL_PLACEHOLDER\/diagrams\/([^"']+?)\.html"/g,
    (match: string, ref: string) => {
      const target = path.resolve(diagramsRoot, `${ref}.flow.json`);
      if (!`${target}${path.sep}`.startsWith(normalizedProjectRoot)) {
        return match; // outside project — leave untouched
      }
      const safe = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return `href="#" data-vibespace-flow="${safe}"`;
    },
  );
  // Drop any other unsubstituted placeholders so stray links don't misnavigate.
  out = out.replace(/DOCSIFY_BASE_URL_PLACEHOLDER/g, '');

  const interceptor =
    `<script>document.addEventListener('click',function(e){` +
    `var a=e.target&&e.target.closest?e.target.closest('[data-vibespace-flow]'):null;` +
    `if(a){e.preventDefault();try{parent.postMessage({type:'vibespace:open-file',path:a.getAttribute('data-vibespace-flow')},'*');}catch(_){}}` +
    `},true);</script>`;
  return out.includes('</body>') ? out.replace('</body>', `${interceptor}</body>`) : out + interceptor;
}

/** Matches a basename against a simple `*.ext`/`*.a.b` or exact-name glob. */
function matchesGlob(basename: string, pattern: string): boolean {
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
 * Returns an argv template with `{input}`/`{output}` still in `args`, or null
 * when nothing renders it. The custom-preview route consumes this command.
 */
export async function resolveCustomRenderer(
  absFilePath: string,
  projectRoot: string,
  nodeBin: string,
): Promise<RendererCommand | null> {
  const basename = path.basename(absFilePath);

  const config = await readPreviewConfig(projectRoot);
  const renderers = Array.isArray(config?.renderers) ? config.renderers : [];
  for (const entry of renderers) {
    if (!isRecord(entry) || typeof entry.match !== 'string' || !Array.isArray(entry.command)) continue;
    if (entry.command.length > 0 && entry.command.every((argument) => typeof argument === 'string') && matchesGlob(basename, entry.match)) {
      const [bin, ...args] = entry.command;
      const resolvedBin = bin === 'node' ? nodeBin : bin;
      return { bin: resolvedBin, args };
    }
  }

  // Built-in: `*.flow.json` rendered by the nearest ancestor `_kit/render.mjs`.
  // Flows are organized in subfolders (auth/, event/, …) while the renderer
  // lives once at the flows root, so walk up rather than only checking siblings.
  if (basename.endsWith('.flow.json')) {
    const normalizedRoot = path.resolve(projectRoot);
    let dir = path.dirname(path.resolve(absFilePath));
    for (let i = 0; i < 40; i += 1) {
      const renderer = path.join(dir, '_kit', 'render.mjs');
      try {
        const stat = await fsPromises.stat(renderer);
        if (stat.isFile()) {
          return { bin: nodeBin, args: [renderer, '{input}', '{output}'] };
        }
      } catch {
        // keep walking up
      }
      if (dir === normalizedRoot) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  return null;
}

/**
 * Rewrites root-absolute alias references inside a served text asset so they
 * point at the preview route (`assetBase` = `/api/projects/:id/preview-fs`).
 * e.g. `/kit/x` → `/api/projects/:id/preview-fs/kit/x`. HTML-preview routes use
 * this for text entry files and subresources.
 */
export function rewriteAssetReferences(
  text: string,
  aliases: PreviewAliases,
  assetBase: string,
): string {
  let out = text;
  for (const prefix of Object.keys(aliases)) {
    // Match the alias prefix only at a URL boundary (after quote, paren, `=`,
    // whitespace, or comma) to avoid mangling unrelated substrings.
    const re = new RegExp(`([\\"'\\(=,\\s])${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'g');
    out = out.replace(re, `$1${assetBase}${prefix}/`);
  }
  return out;
}
