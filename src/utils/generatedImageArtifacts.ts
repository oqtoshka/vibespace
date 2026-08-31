const GENERATED_IMAGES_SEGMENT = '/generated_images/';
const SAFE_RASTER_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const SAFE_PROJECT_IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function containsParentTraversal(value: string): boolean {
  return decodePathname(value).replace(/\\/g, '/').split('/').includes('..');
}

/**
 * Converts a browser-facing Codex generated-image URL back to the path segment
 * relative to `generated_images`. Same-origin HTTP URLs, root-absolute paths,
 * and file URLs are accepted; remote URLs and unsafe/non-raster paths are not.
 */
export function resolveGeneratedImageArtifactPath(
  source: string | undefined,
  currentOrigin?: string,
): string | null {
  const trimmed = source?.trim();
  if (!trimmed) {
    return null;
  }
  if (containsParentTraversal(trimmed)) {
    return null;
  }

  const origin = currentOrigin
    ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
  let pathname: string;

  if (/^[a-z]:[\\/]/i.test(trimmed)) {
    pathname = `/${trimmed.replace(/\\/g, '/')}`;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed, origin || 'http://vibespace.invalid');
    } catch {
      return null;
    }

    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      if (!origin || parsed.origin !== origin) {
        return null;
      }
    } else if (parsed.protocol !== 'file:') {
      return null;
    }
    pathname = parsed.pathname;
  }

  const decodedPath = decodePathname(pathname).replace(/\\/g, '/');
  const markerIndex = decodedPath.lastIndexOf(GENERATED_IMAGES_SEGMENT);
  if (markerIndex < 0) {
    return null;
  }

  const relativePath = decodedPath.slice(markerIndex + GENERATED_IMAGES_SEGMENT.length);
  const segments = relativePath.split('/');
  if (
    !SAFE_RASTER_EXTENSION.test(relativePath)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }

  return relativePath;
}

/** Builds the authenticated API URL used to fetch one generated image. */
export function generatedImageArtifactUrl(relativePath: string): string {
  return `/api/assets/generated-images?path=${encodeURIComponent(relativePath)}`;
}

/**
 * Resolves a local Markdown image reference to a project-relative path. This
 * provider-neutral path is served by the existing project file API, so every
 * CLI can display images it writes inside the active project.
 */
export function resolveProjectImagePath(
  source: string | undefined,
  projectPath?: string | null,
  currentOrigin?: string,
): string | null {
  const trimmed = source?.trim();
  if (!trimmed) {
    return null;
  }
  if (containsParentTraversal(trimmed)) {
    return null;
  }

  const origin = currentOrigin
    ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
  const windowsAbsolute = /^[a-z]:[\\/]/i.test(trimmed);
  let pathname: string;
  let fileUrl = false;

  if (windowsAbsolute) {
    pathname = `/${trimmed.replace(/\\/g, '/')}`;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed, origin || 'http://vibespace.invalid');
    } catch {
      return null;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      if (!origin || parsed.origin !== origin) {
        return null;
      }
    } else if (parsed.protocol === 'file:') {
      fileUrl = true;
    } else {
      return null;
    }
    pathname = parsed.pathname;
  }

  let normalized = decodePathname(pathname).replace(/\\/g, '/');
  const normalizedProjectRoot = projectPath?.replace(/\\/g, '/').replace(/\/+$/, '') || '';
  if (normalizedProjectRoot && normalized.startsWith(`${normalizedProjectRoot}/`)) {
    normalized = normalized.slice(normalizedProjectRoot.length + 1);
  } else if (fileUrl || windowsAbsolute || /^\/(?:Users|home|private|var)\//.test(normalized)) {
    return null;
  } else {
    normalized = normalized.replace(/^\/+/, '');
  }

  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      return null;
    }
    segments.push(segment);
  }

  const relativePath = segments.join('/');
  return relativePath && SAFE_PROJECT_IMAGE_EXTENSION.test(relativePath) ? relativePath : null;
}

/** Builds the authenticated project-file URL used for an inline image. */
export function projectImageArtifactUrl(projectId: string, relativePath: string): string {
  return `/api/file-tree/projects/${encodeURIComponent(projectId)}/files/content?path=${encodeURIComponent(relativePath)}`;
}
