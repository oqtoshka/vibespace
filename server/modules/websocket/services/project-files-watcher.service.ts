import fs from 'node:fs';
import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';
import type { WebSocket } from 'ws';

import { projectsDb } from '@/modules/database/index.js';
import { validateAccessiblePath } from '@/utils/allowedPaths.js';
import { WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * On-demand project file watcher.
 *
 * The file-tree explorer (and any open editor) subscribes to a project over the
 * chat websocket (`files.subscribe`). The first subscriber for a project spins
 * up a native chokidar watcher on the project root; the last to leave tears it
 * down. Filesystem events are debounced and broadcast as a single
 * `files_changed` frame to that project's subscribers, who use it to refresh the
 * tree and reload any open file whose path changed.
 *
 * Paths in the broadcast are absolute — matching the `path` field the file-tree
 * REST listing produces (`path.join(root, name)`) and the editor's `file.path`,
 * so clients can match without any path juggling.
 */

type ChangeType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

type FileChange = { path: string; type: ChangeType };

type ProjectWatch = {
  watcher: FSWatcher;
  /**
   * Subscriber sockets with a reference count. The same socket can subscribe
   * more than once (the file tree and one or more open editors each want the
   * stream); we only stop delivering to it once every consumer has left.
   */
  subscribers: Map<WebSocket, number>;
  /** Coalesced changes since the last flush; last event per path wins. */
  pending: Map<string, ChangeType>;
  flushTimer: ReturnType<typeof setTimeout> | null;
};

// Mirrors the file-tree REST listing's IGNORED_DIRS so the watcher never wakes
// on (or even scans) churny build/VCS/cache dirs the explorer never shows.
// Skipping these — node_modules above all — is what keeps the polling scan cheap.
const IGNORED_DIR_NAMES = new Set<string>([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor', '.gradle', '.idea', 'coverage', '.nyc_output',
]);
const IGNORED_FILE_SUFFIXES = ['.tmp', '.swp'];

/**
 * chokidar v4 dropped glob-string support for `ignored`; it now takes a string,
 * RegExp, or predicate. A predicate is the only reliable cross-version option —
 * glob strings silently match nothing and the watcher ends up scanning
 * node_modules. Ignore a path if any segment is a build/VCS/cache dir (so the
 * whole subtree is pruned) or it's a junk file.
 */
function isIgnoredPath(targetPath: string): boolean {
  const segments = targetPath.split(path.sep);
  if (segments.some((segment) => IGNORED_DIR_NAMES.has(segment))) {
    return true;
  }
  const base = segments[segments.length - 1] ?? '';
  return base === '.DS_Store' || IGNORED_FILE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

const FLUSH_DEBOUNCE_MS = 300;
// Bound the watched subtree. Combined with the ignore globs this keeps the
// polling scan cheap and, critically, caps how many directories the watcher
// touches so it can't exhaust file descriptors on a deep tree.
const WATCH_DEPTH = 12;
// Cap per-frame change lists so a bulk operation (git checkout, npm install in a
// non-ignored dir) can't produce a multi-megabyte websocket frame.
const MAX_CHANGES_PER_FRAME = 500;

/** Active watchers keyed by DB projectId. */
const watches = new Map<string, ProjectWatch>();
/**
 * Reverse index (socket → projectId → ref count) so a disconnecting socket can
 * drop all of its subscriptions in one pass.
 */
const subscriptionsByClient = new Map<WebSocket, Map<string, number>>();

function broadcast(projectId: string, watch: ProjectWatch): void {
  if (watch.pending.size === 0) {
    return;
  }

  const changes: FileChange[] = [];
  for (const [filePath, type] of watch.pending) {
    changes.push({ path: filePath, type });
    if (changes.length >= MAX_CHANGES_PER_FRAME) {
      break;
    }
  }
  watch.pending.clear();

  const frame = JSON.stringify({
    kind: 'files_changed',
    projectId,
    changes,
    timestamp: new Date().toISOString(),
  });

  for (const ws of watch.subscribers.keys()) {
    if (ws.readyState === WS_OPEN_STATE) {
      ws.send(frame);
    }
  }
}

function scheduleFlush(projectId: string, watch: ProjectWatch): void {
  if (watch.flushTimer) {
    return;
  }
  watch.flushTimer = setTimeout(() => {
    watch.flushTimer = null;
    broadcast(projectId, watch);
  }, FLUSH_DEBOUNCE_MS);
}

function recordChange(projectId: string, type: ChangeType, filePath: string): void {
  const watch = watches.get(projectId);
  if (!watch) {
    return;
  }
  watch.pending.set(filePath, type);
  scheduleFlush(projectId, watch);
}

function createWatch(projectId: string, rootPath: string): ProjectWatch {
  const watcher = chokidar.watch(rootPath, {
    ignored: (targetPath: string) => isIgnoredPath(targetPath),
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    depth: WATCH_DEPTH,
    // Poll instead of native fs events. This host runs with `ignore-scripts`,
    // so chokidar's native macOS backend (`fsevents`) is never compiled; the
    // fs.watch fallback opens one descriptor per directory and exhausts the FD
    // limit on a real tree (EMFILE), wedging the whole server. Polling holds no
    // persistent descriptors. Mirrors the proven sessions watcher on this host.
    usePolling: true,
    interval: 2_500,
    binaryInterval: 4_000,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 100,
    },
  });

  const watch: ProjectWatch = {
    watcher,
    subscribers: new Map<WebSocket, number>(),
    pending: new Map<string, ChangeType>(),
    flushTimer: null,
  };

  watcher
    .on('add', (filePath: string) => recordChange(projectId, 'add', filePath))
    .on('change', (filePath: string) => recordChange(projectId, 'change', filePath))
    .on('unlink', (filePath: string) => recordChange(projectId, 'unlink', filePath))
    .on('addDir', (filePath: string) => recordChange(projectId, 'addDir', filePath))
    .on('unlinkDir', (filePath: string) => recordChange(projectId, 'unlinkDir', filePath))
    .on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[FilesWatcher] watcher error for project "${projectId}"`, { error: message });
    });

  return watch;
}

function teardownWatch(projectId: string): void {
  const watch = watches.get(projectId);
  if (!watch) {
    return;
  }
  if (watch.flushTimer) {
    clearTimeout(watch.flushTimer);
  }
  watches.delete(projectId);
  void watch.watcher.close().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FilesWatcher] failed to close watcher for project "${projectId}"`, { error: message });
  });
}

/**
 * Subscribes a socket to filesystem changes for a project, lazily creating the
 * underlying watcher on the first subscriber.
 */
export async function subscribeProjectFiles(ws: WebSocket, projectId: string): Promise<void> {
  if (!projectId) {
    return;
  }

  let watch = watches.get(projectId);
  if (!watch) {
    const rootPath = await projectsDb.getProjectPathById(projectId);
    if (!rootPath) {
      return;
    }
    // A concurrent subscribe may have created the watch while we awaited the
    // path lookup; reuse it rather than spawning a second watcher.
    watch = watches.get(projectId);
    if (!watch) {
      watch = createWatch(projectId, rootPath);
      watches.set(projectId, watch);
    }
  }

  watch.subscribers.set(ws, (watch.subscribers.get(ws) ?? 0) + 1);

  let clientSubs = subscriptionsByClient.get(ws);
  if (!clientSubs) {
    clientSubs = new Map<string, number>();
    subscriptionsByClient.set(ws, clientSubs);
  }
  clientSubs.set(projectId, (clientSubs.get(projectId) ?? 0) + 1);
}

/**
 * Drops one project subscription. The watcher is torn down only once the last
 * reference from the last socket is gone.
 */
export function unsubscribeProjectFiles(ws: WebSocket, projectId: string): void {
  const watch = watches.get(projectId);
  if (watch) {
    const count = watch.subscribers.get(ws) ?? 0;
    if (count <= 1) {
      watch.subscribers.delete(ws);
    } else {
      watch.subscribers.set(ws, count - 1);
    }
    if (watch.subscribers.size === 0) {
      teardownWatch(projectId);
    }
  }

  const clientSubs = subscriptionsByClient.get(ws);
  if (clientSubs) {
    const count = clientSubs.get(projectId) ?? 0;
    if (count <= 1) {
      clientSubs.delete(projectId);
    } else {
      clientSubs.set(projectId, count - 1);
    }
    if (clientSubs.size === 0) {
      subscriptionsByClient.delete(ws);
    }
  }
}

/** Drops every subscription held by a socket (call on disconnect). */
export function unsubscribeAllProjectFiles(ws: WebSocket): void {
  const clientSubs = subscriptionsByClient.get(ws);
  if (!clientSubs) {
    return;
  }
  // Fully detach the socket from each watcher regardless of ref count.
  for (const projectId of [...clientSubs.keys()]) {
    const watch = watches.get(projectId);
    if (watch) {
      watch.subscribers.delete(ws);
      if (watch.subscribers.size === 0) {
        teardownWatch(projectId);
      }
    }
  }
  subscriptionsByClient.delete(ws);
}

// ----------------- SINGLE-FILE WATCHES ------------

/**
 * Per-file watches, alongside the per-project watcher above.
 *
 * The project watcher is what keeps the file tree honest, but an open viewer
 * cares about exactly one file, and the project watcher can miss it: the file
 * may sit under an ignored directory (`dist/`, `build/` — where generated
 * reports and rendered HTML tend to land), deeper than WATCH_DEPTH, or outside
 * the project root altogether (an additional file root). So a viewer also asks
 * for its own file by path, and we stat-poll just that path with
 * `fs.watchFile` — no descriptor is held, so this scales to every open tab
 * without touching the FD limit the polling project watcher exists to respect.
 *
 * Broadcast as `file_changed` frames carrying the client's own `path` string,
 * so matching on the client is a string compare.
 */

type FileWatch = {
  /** The path exactly as the client sent it (echoed back in frames). */
  clientPath: string;
  resolved: string;
  subscribers: Map<WebSocket, number>;
};

const FILE_POLL_INTERVAL_MS = 1_000;

/** Active single-file watches keyed by `${projectId}\0${clientPath}`. */
const fileWatches = new Map<string, FileWatch>();
/** Reverse index (socket → watch key → ref count) for disconnect cleanup. */
const fileWatchesByClient = new Map<WebSocket, Map<string, number>>();

const fileWatchKey = (projectId: string, clientPath: string) => `${projectId}\0${clientPath}`;

function broadcastFileChange(projectId: string, watch: FileWatch, type: ChangeType, mtimeMs: number): void {
  const frame = JSON.stringify({
    kind: 'file_changed',
    projectId,
    path: watch.clientPath,
    type,
    mtimeMs,
    timestamp: new Date().toISOString(),
  });
  for (const ws of watch.subscribers.keys()) {
    if (ws.readyState === WS_OPEN_STATE) {
      ws.send(frame);
    }
  }
}

/**
 * Starts stat-polling one file for a socket. The path must be readable through
 * the file API's own containment rules (project root or an additional root);
 * anything else is silently ignored, exactly like a read of it would 403.
 */
export async function subscribeFilePath(ws: WebSocket, projectId: string, clientPath: string): Promise<void> {
  if (!projectId || !clientPath) {
    return;
  }
  const key = fileWatchKey(projectId, clientPath);
  let watch = fileWatches.get(key);
  if (!watch) {
    const rootPath = await projectsDb.getProjectPathById(projectId);
    if (!rootPath) {
      return;
    }
    const validation = await validateAccessiblePath(rootPath, clientPath);
    if (!validation.valid || !validation.resolved) {
      return;
    }
    // A concurrent subscribe may have created the watch while we awaited.
    watch = fileWatches.get(key);
    if (!watch) {
      const created: FileWatch = { clientPath, resolved: validation.resolved, subscribers: new Map() };
      fs.watchFile(created.resolved, { interval: FILE_POLL_INTERVAL_MS, persistent: false }, (curr, prev) => {
        // nlink 0 is fs.watchFile's "does not exist" marker.
        if (curr.nlink === 0 && prev.nlink === 0) return;
        const type: ChangeType = curr.nlink === 0 ? 'unlink' : prev.nlink === 0 ? 'add' : 'change';
        if (type === 'change' && curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
        broadcastFileChange(projectId, created, type, curr.mtimeMs);
      });
      fileWatches.set(key, created);
      watch = created;
    }
  }

  watch.subscribers.set(ws, (watch.subscribers.get(ws) ?? 0) + 1);
  let clientKeys = fileWatchesByClient.get(ws);
  if (!clientKeys) {
    clientKeys = new Map<string, number>();
    fileWatchesByClient.set(ws, clientKeys);
  }
  clientKeys.set(key, (clientKeys.get(key) ?? 0) + 1);
}

function dropFileSubscriber(ws: WebSocket, key: string): void {
  const watch = fileWatches.get(key);
  if (!watch) {
    return;
  }
  const count = watch.subscribers.get(ws) ?? 0;
  if (count <= 1) {
    watch.subscribers.delete(ws);
  } else {
    watch.subscribers.set(ws, count - 1);
  }
  if (watch.subscribers.size === 0) {
    fs.unwatchFile(watch.resolved);
    fileWatches.delete(key);
  }
}

/** Drops one file subscription; the poll stops with the last subscriber. */
export function unsubscribeFilePath(ws: WebSocket, projectId: string, clientPath: string): void {
  const key = fileWatchKey(projectId, clientPath);
  dropFileSubscriber(ws, key);
  const clientKeys = fileWatchesByClient.get(ws);
  if (clientKeys) {
    const count = clientKeys.get(key) ?? 0;
    if (count <= 1) {
      clientKeys.delete(key);
    } else {
      clientKeys.set(key, count - 1);
    }
    if (clientKeys.size === 0) {
      fileWatchesByClient.delete(ws);
    }
  }
}

/** Drops every file subscription held by a socket (call on disconnect). */
export function unsubscribeAllFilePaths(ws: WebSocket): void {
  const clientKeys = fileWatchesByClient.get(ws);
  if (!clientKeys) {
    return;
  }
  for (const key of clientKeys.keys()) {
    const watch = fileWatches.get(key);
    if (!watch) continue;
    watch.subscribers.delete(ws);
    if (watch.subscribers.size === 0) {
      fs.unwatchFile(watch.resolved);
      fileWatches.delete(key);
    }
  }
  fileWatchesByClient.delete(ws);
}

// activeFileWatchCount: used by tests to prove polls stop with their last subscriber.
export function activeFileWatchCount(): number {
  return fileWatches.size;
}
