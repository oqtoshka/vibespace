import path from 'node:path';

/**
 * Builds the read/edit allow-list consumed by the legacy File Tree routes in
 * the server composition root. Registered projects are already independently
 * exposed by project id, so allowing links between them widens no filesystem
 * boundary while still rejecting paths outside configured or known projects.
 */
export function buildFileAccessRoots(
  configuredRoots: string[],
  registeredProjectPaths: string[],
): string[] {
  return [...new Set(
    [...configuredRoots, ...registeredProjectPaths]
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => path.resolve(root)),
  )];
}
