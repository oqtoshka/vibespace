import fs from 'node:fs/promises';
import path from 'node:path';

import { validateAccessiblePath } from '@/utils/allowedPaths.js';

import {
  resolvePreviewAssetPath,
  resolvePreviewModel,
} from './html-preview-rendering.service.js';

type PreviewAliases = Record<string, string>;

type AccessiblePathResult = {
  valid: boolean;
  resolved?: string;
  error?: string;
  outsideProject?: boolean;
};

type PreviewModel = {
  webRoot: string;
  aliases: PreviewAliases;
  entryRel: string;
};

type HtmlPreviewDependencies = {
  validatePath: (projectRoot: string, targetPath: string) => Promise<AccessiblePathResult>;
  resolveModel: (entryPath: string, previewRoot: string) => Promise<PreviewModel>;
};

type HtmlPreviewEntryResult =
  | {
      valid: true;
      webRoot: string;
      aliases: PreviewAliases;
      entryRel: string;
      previewRoot: string;
      resourceRoots: string[];
    }
  | {
      valid: false;
      error: string;
    };

type PreviewAssetClaims = {
  webRoot: string;
  aliases?: PreviewAliases;
  previewRoot?: string;
};

type HtmlPreviewAssetDependencies = {
  validatePath: (projectRoot: string, targetPath: string) => Promise<AccessiblePathResult>;
  resolveAssetPath: (
    requestPath: string,
    webRoot: string,
    aliases: PreviewAliases,
    previewRoot: string,
  ) => string | null;
};

const defaultEntryDependencies: HtmlPreviewDependencies = {
  validatePath: validateAccessiblePath,
  resolveModel: resolvePreviewModel,
};

const defaultAssetDependencies: HtmlPreviewAssetDependencies = {
  validatePath: validateAccessiblePath,
  resolveAssetPath: resolvePreviewAssetPath,
};

async function findExternalPreviewRoot(
  entryPath: string,
  projectRoot: string,
  validatePath: HtmlPreviewDependencies['validatePath'],
): Promise<string> {
  const entryDirectory = path.dirname(entryPath);
  let candidate = entryDirectory;

  // Worktrees have a `.git` file rather than a directory. Walking only through
  // currently accessible ancestors preserves the same filesystem boundary as
  // the file API while giving relative assets a stable repository-rooted URL.
  for (let depth = 0; depth < 40; depth += 1) {
    const access = await validatePath(projectRoot, candidate);
    if (!access.valid) break;

    try {
      await fs.stat(path.join(candidate, '.git'));
      return candidate;
    } catch {
      // Keep walking toward the configured workspace boundary.
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }

  return entryDirectory;
}

/**
 * Resolves an HTML entry for the server preview route. Files opened from an
 * approved sibling worktree use that worktree's accessible Git root as the
 * preview boundary; project files retain their project root and configuration.
 */
export async function resolveHtmlPreviewEntry(
  projectRoot: string,
  filePath: string,
  dependencies: HtmlPreviewDependencies = defaultEntryDependencies,
): Promise<HtmlPreviewEntryResult> {
  const validation = await dependencies.validatePath(projectRoot, filePath);
  if (!validation.valid || !validation.resolved) {
    return {
      valid: false,
      error: validation.error || 'Path is not accessible',
    };
  }

  // An external worktree must not inherit the active project's serving model.
  // Its own Git root keeps nested entry paths intact, so imports such as
  // `../../_kit/x.js` remain inside the preview route instead of escaping it.
  const previewRoot = validation.outsideProject
    ? await findExternalPreviewRoot(validation.resolved, projectRoot, dependencies.validatePath)
    : path.resolve(projectRoot);
  const { webRoot, aliases, entryRel } = await dependencies.resolveModel(
    validation.resolved,
    previewRoot,
  );
  const resourceRoots = [...new Set([
    webRoot,
    ...Object.values(aliases).map((target) => path.resolve(webRoot, target)),
  ])];

  return {
    valid: true,
    webRoot,
    aliases,
    entryRel,
    previewRoot,
    resourceRoots,
  };
}

/**
 * Authorizes one iframe asset for the server preview route. The signed preview
 * boundary blocks traversal, while current accessible-path validation prevents
 * stale cookies or symlinks from escaping the configured workspace roots.
 */
export async function resolveHtmlPreviewAsset(
  requestPath: string,
  claims: PreviewAssetClaims,
  projectRoot: string,
  dependencies: HtmlPreviewAssetDependencies = defaultAssetDependencies,
): Promise<string | null> {
  const previewRoot = claims.previewRoot || projectRoot;
  const target = dependencies.resolveAssetPath(
    requestPath,
    claims.webRoot,
    claims.aliases || {},
    previewRoot,
  );
  if (!target) {
    return null;
  }

  const validation = await dependencies.validatePath(projectRoot, target);
  return validation.valid ? target : null;
}
