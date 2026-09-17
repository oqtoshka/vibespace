export {
  generateDisplayName,
  getProjectsWithSessions,
} from './services/projects-with-sessions-fetch.service.js';
export { updateProjectDisplayName } from './services/project-management.service.js';
// createProject: used by worktrees and native-control to register a switchable project directory.
export { createProject } from './services/project-management.service.js';
// deleteOrArchiveProject: used by Projects routes and Worktrees cleanup to hide or permanently remove a project.
export { deleteOrArchiveProject } from './services/project-delete.service.js';
// restoreArchivedProject: used by the worktrees module to re-activate an archived project when its worktree is reopened.
export { restoreArchivedProject } from './services/project-delete.service.js';
