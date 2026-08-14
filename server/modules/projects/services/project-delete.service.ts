import { projectsDb } from '@/modules/database/index.js';
import { deleteSessionsForProjectPath } from '@/modules/providers/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * - **Soft delete** (`force` false): set `isArchived` on the `projects` row (hide from the active list; DB only).
 * - **Force** (`force` true): permanently delete every session in the project — transcript file, the
 *   provider's own copy of the conversation, and the app row — then the `projects` row.
 */
export async function deleteOrArchiveProject(projectId: string, force: boolean): Promise<void> {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (!force) {
    projectsDb.updateProjectIsArchivedById(projectId, true);
    return;
  }

  // Deleting the app's session rows on its own is not enough: providers that
  // keep every conversation in one shared store still hold theirs, and the next
  // synchronizer pass re-imports them — which re-creates this project row too.
  await deleteSessionsForProjectPath(row.project_path);
  projectsDb.deleteProjectById(projectId);
}

/**
 * Restores one archived project row back into the active project list.
 */
export function restoreArchivedProject(projectId: string): void {
  const row = projectsDb.getProjectById(projectId);
  if (!row) {
    throw new AppError(`Unknown projectId: ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  projectsDb.updateProjectIsArchivedById(projectId, false);
}
