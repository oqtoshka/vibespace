import { IS_PLATFORM } from "../constants/config";

import { persistAuthToken } from "./authToken";
import { AUTH_TOKEN_REFRESHED_EVENT, AUTH_SESSION_EXPIRED_EVENT } from "./authEvents";

/**
 * Decide whether a failed response means the JWT session itself is dead (vs a
 * route-level authorization error). The auth middleware answers 401 for a
 * missing/unknown-user token and 403 with `{ error: 'Invalid token' }` for an
 * expired/invalid one; other 403s (path outside project, permission denied, …)
 * must NOT log the user out.
 */
const detectExpiredSession = async (response) => {
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  try {
    const body = await response.clone().json();
    return body?.error === 'Invalid token';
  } catch {
    return false;
  }
};

// Only accept a refreshed token that has this app's issued JWT shape
// (three base64url segments). An attacker-injected/malformed header value
// must never overwrite the stored auth token.
/**
 * @param {unknown} token
 * @returns {token is string}
 */
export const isValidRefreshedToken = (token) =>
  typeof token === 'string' &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

// Utility function for authenticated API calls
export const authenticatedFetch = (url, options = {}) => {
  const token = localStorage.getItem('auth-token');

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then(async (response) => {
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (isValidRefreshedToken(refreshedToken)) {
      persistAuthToken(refreshedToken);
      // Let AuthContext pick up the rotated token so consumers holding the
      // React copy (e.g. the WebSocket URL) don't keep using the stale one
      // until it expires and every reconnect starts failing.
      window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, { detail: refreshedToken }));
    }
    if (!IS_PLATFORM && !response.ok && await detectExpiredSession(response)) {
      // The stored token is dead — every subsequent call would fail the same
      // way, leaving hollow UI (empty chat history, dead websocket). Surface
      // it once so AuthContext can clear the session and show the login form.
      window.dispatchEvent(new CustomEvent(AUTH_SESSION_EXPIRED_EVENT));
    }
    return response;
  });
};

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    user: () => authenticatedFetch('/api/auth/user'),
    logout: () => authenticatedFetch('/api/auth/logout', { method: 'POST' }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  projects: () => authenticatedFetch('/api/projects'),
  archivedProjects: () => authenticatedFetch('/api/projects/archived'),
  projectSessions: (projectId, { limit = 20, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    return authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/sessions?${params.toString()}`);
  },
  projectTaskmaster: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/taskmaster`),
  // Unified endpoint for persisted session messages.
  // Provider/project metadata are resolved by the backend from sessionId.
  unifiedSessionMessages: (sessionId, _provider = 'claude', { limit = null, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', String(limit));
      params.append('offset', String(offset));
    }
    const queryString = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${queryString ? `?${queryString}` : ''}`);
  },
  renameProject: (projectId, displayName) =>
    authenticatedFetch(`/api/projects/${projectId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  restoreProject: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/restore`, {
      method: 'POST',
    }),
  // Session deletion now mirrors project deletion:
  // - default: archive only (`isArchived = 1`)
  // - hardDelete: remove the row and, by default, its persisted transcript file
  deleteSession: (sessionId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) {
      params.set('force', 'true');
    }
    const qs = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${sessionId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  getArchivedSessions: () =>
    authenticatedFetch('/api/providers/sessions/archived'),
  runningSessions: () =>
    authenticatedFetch('/api/providers/sessions/running'),
  restoreSession: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}/restore`, {
      method: 'POST',
    }),
  renameSession: (sessionId, summary) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ summary }),
    }),
  // `hardDelete` => server `?force=true` (remove DB row + Claude *.jsonl + sessions rows for path).
  deleteProject: (projectId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) params.set('force', 'true');
    const qs = params.toString();
    return authenticatedFetch(`/api/projects/${projectId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  searchConversationsUrl: (query, limit = 50) => {
    const token = localStorage.getItem('auth-token');
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (token) params.set('token', token);
    return `/api/providers/search/sessions?${params.toString()}`;
  },
  createProject: (projectData) =>
    authenticatedFetch('/api/projects/create-project', {
      method: 'POST',
      body: JSON.stringify(projectData),
    }),
  migrateLegacyProjectStars: (projectIds) =>
    authenticatedFetch('/api/projects/migrate-legacy-stars', {
      method: 'POST',
      body: JSON.stringify({ projectIds }),
    }),
  toggleProjectStar: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/toggle-star`, {
      method: 'POST',
    }),
  readFile: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/file?filePath=${encodeURIComponent(filePath)}`),
  readFileBlob: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`),
  saveFile: (projectId, filePath, content) =>
    authenticatedFetch(`/api/projects/${projectId}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  // Resolves a .puml file's local includes server-side and returns a render
  // URL for the configured PlantUML server.
  renderPlantUml: (projectId, { path, content, signal } = {}) =>
    authenticatedFetch(`/api/projects/${projectId}/plantuml`, {
      method: 'POST',
      body: JSON.stringify({ path, content }),
      signal,
    }),
  // Encodes an inline PlantUML snippet (markdown/chat fenced block) into a
  // render URL for the configured PlantUML server. No include resolution.
  renderInlinePlantUml: ({ content, signal } = {}) =>
    authenticatedFetch('/api/plantuml', {
      method: 'POST',
      body: JSON.stringify({ content }),
      signal,
    }),
  // Renders a .dbml file's schema into an ER diagram (SVG) server-side.
  renderDbml: (projectId, { path, content, signal } = {}) =>
    authenticatedFetch(`/api/projects/${projectId}/dbml`, {
      method: 'POST',
      body: JSON.stringify({ path, content }),
      signal,
    }),
  // Resolves an HTML file's serving model (web root + aliases), sets a
  // path-scoped preview cookie, and returns the URL to load in the iframe.
  resolveHtmlPreview: (projectId, { path, signal } = {}) =>
    authenticatedFetch(`/api/projects/${projectId}/html-preview`, {
      method: 'POST',
      body: JSON.stringify({ path }),
      signal,
    }),
  // Runs a project renderer for a custom format (e.g. *.flow.json) and returns
  // self-contained HTML to display in a srcDoc iframe.
  renderCustom: (projectId, { path, content, signal } = {}) =>
    authenticatedFetch(`/api/projects/${projectId}/render-custom`, {
      method: 'POST',
      body: JSON.stringify({ path, content }),
      signal,
    }),
  // Reads a background task's output file.
  taskOutput: (filePath, { signal } = {}) =>
    authenticatedFetch(`/api/tasks/output?path=${encodeURIComponent(filePath)}`, { signal }),
  // Authoritative set of background jobs still running for a session (ground
  // truth the client reconciles its message-derived tasks against).
  backgroundTasks: (sessionId, { signal } = {}) =>
    authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/background-tasks`, { signal }),
  // Reads a subagent's full conversation transcript for the thread viewer.
  subagentConversation: (sessionId, agentId, { signal } = {}) =>
    authenticatedFetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}`,
      { signal },
    ),
  // `dir` scopes the listing to a subdirectory (lazy tree loading), `depth`
  // bounds the walk (omit for the full deep tree), `meta: 0` skips per-entry
  // stat metadata for path-only consumers.
  getFiles: (projectId, options = {}) => {
    const { dir, depth, meta, ...fetchOptions } = options;
    const params = new URLSearchParams();
    if (dir !== undefined) params.set('dir', dir);
    if (depth !== undefined) params.set('depth', String(depth));
    if (meta !== undefined) params.set('meta', String(meta));
    const query = params.toString();
    return authenticatedFetch(`/api/projects/${projectId}/files${query ? `?${query}` : ''}`, fetchOptions);
  },

  // File share links (authenticated management).
  createShare: (projectId, { path, expiresIn } = {}) =>
    authenticatedFetch(`/api/projects/${projectId}/share`, {
      method: 'POST',
      body: JSON.stringify({ path, expiresIn: expiresIn ?? null }),
    }),
  listShares: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/shares?path=${encodeURIComponent(filePath)}`),
  deleteShare: (projectId, shareId) =>
    authenticatedFetch(`/api/projects/${projectId}/shares/${encodeURIComponent(shareId)}`, {
      method: 'DELETE',
    }),

  // Public share access (no auth) — used by the standalone /share/:shareId page.
  shareMeta: (shareId) => fetch(`/api/share/${encodeURIComponent(shareId)}/meta`),
  shareRender: (shareId) => fetch(`/api/share/${encodeURIComponent(shareId)}/render`),
  shareContentUrl: (shareId, { download = false } = {}) =>
    `/api/share/${encodeURIComponent(shareId)}/content${download ? '?download' : ''}`,
  // URL for an asset referenced by a shared file (e.g. an image linked from
  // shared markdown); the server resolves it relative to the shared file and
  // constrains it to the project root.
  sharePreviewUrl: (shareId, assetPath) =>
    `/api/share/${encodeURIComponent(shareId)}/preview/${assetPath
      .replace(/^\/+/, '')
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,

  // File operations
  createFile: (projectId, { path, type, name }) =>
    authenticatedFetch(`/api/projects/${projectId}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path, type, name }),
    }),

  renameFile: (projectId, { oldPath, newName }) =>
    authenticatedFetch(`/api/projects/${projectId}/files/rename`, {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName }),
    }),
  moveFiles: (projectId, { sourcePaths, targetDir }) =>
    authenticatedFetch(`/api/projects/${projectId}/files/move`, {
      method: 'POST',
      body: JSON.stringify({ sourcePaths, targetDir }),
    }),

  deleteFile: (projectId, { path, type }) =>
    authenticatedFetch(`/api/projects/${projectId}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path, type }),
    }),

  uploadFiles: (projectId, formData) =>
    authenticatedFetch(`/api/projects/${projectId}/files/upload`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // TaskMaster endpoints — all addressed by DB projectId post-migration.
  taskmaster: {
    // Initialize TaskMaster in a project
    init: (projectId) =>
      authenticatedFetch(`/api/taskmaster/init/${projectId}`, {
        method: 'POST',
      }),

    // Add a new task
    addTask: (projectId, { prompt, title, description, priority, dependencies }) =>
      authenticatedFetch(`/api/taskmaster/add-task/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ prompt, title, description, priority, dependencies }),
      }),

    // Parse PRD to generate tasks
    parsePRD: (projectId, { fileName, numTasks, append }) =>
      authenticatedFetch(`/api/taskmaster/parse-prd/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ fileName, numTasks, append }),
      }),

    // Get available PRD templates
    getTemplates: () =>
      authenticatedFetch('/api/taskmaster/prd-templates'),

    // Apply a PRD template
    applyTemplate: (projectId, { templateId, fileName, customizations }) =>
      authenticatedFetch(`/api/taskmaster/apply-template/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({ templateId, fileName, customizations }),
      }),

    // Update a task
    updateTask: (projectId, taskId, updates) =>
      authenticatedFetch(`/api/taskmaster/update-task/${projectId}/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),
  },

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
  },

  // Open a session in the host machine's desktop Terminal (macOS host only).
  openInTerminal: ({ projectPath, sessionId, provider }) =>
    authenticatedFetch('/api/open-in-terminal', {
      method: 'POST',
      body: JSON.stringify({ projectPath, sessionId, provider }),
    }),

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};
