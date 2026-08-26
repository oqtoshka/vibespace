// Load environment variables from .env before other imports execute.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { registerServerConfigKey } from './shared/agent-env.js';

// This bootstrap cannot import shared/utils.ts: that module reads environment
// defaults during evaluation, before this file has loaded `.env`.
function getBootstrapApplicationRoot(importMetaUrl: string) {
  const moduleDirectory = path.dirname(fileURLToPath(importMetaUrl));
  let serverRoot = moduleDirectory;
  while (path.basename(serverRoot) !== 'server') {
    const parent = path.dirname(serverRoot);
    if (parent === serverRoot) throw new Error('Could not resolve server root');
    serverRoot = parent;
  }
  const parent = path.dirname(serverRoot);
  return path.basename(parent) === 'dist-server' ? path.dirname(parent) : parent;
}

// Resolve the repo/app root via the nearest /server folder so this file keeps finding the
// same top-level .env file from both /server/load-env.ts and /dist-server/server/load-env.js.
const APP_ROOT = getBootstrapApplicationRoot(import.meta.url);

// libuv runs every async filesystem call on a thread pool that defaults to
// four threads, and this server is almost entirely filesystem work: transcript
// reads, watcher syncs, static assets. Four is enough to be saturated by a
// burst of session indexing, and once it is, unrelated reads — including the
// one that answers `GET /` — wait behind the whole queue. That is what a
// wedged-looking server with an idle CPU actually is.
//
// libuv sizes the pool the first time something uses it, so this has to be set
// before any async work starts: this file is the process's first import and
// only reads synchronously.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}

try {
  const envPath = path.join(APP_ROOT, '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && valueParts.length > 0) {
        // Presence in .env marks a key as VibeSpace's own configuration, whether or
        // not this file is the one that wins — so it is registered before the
        // assignment check. That keeps agent-spawned processes free of new secrets
        // added to .env later, with no second list to keep in sync.
        registerServerConfigKey(key);
        if (!process.env[key]) {
          process.env[key] = valueParts.join('=').trim();
        }
      }
    }
  });
} catch (e: any) {
  console.error('No .env file found or error reading it:', e.message);
}

// Keep the default database in a stable user-level location so rebuilding dist-server
// never changes where the backend stores auth.db when DATABASE_PATH is not set explicitly.
const DEFAULT_DATABASE_PATH = path.join(os.homedir(), '.vibespace', 'auth.db');

if (!process.env.DATABASE_PATH) {
  process.env.DATABASE_PATH = DEFAULT_DATABASE_PATH;
}

// Deployment mode, normalized here so every later import sees one canonical value:
//   local  — single-user, password+JWT auth. The default, and what a laptop install runs.
//   multi  — the manager process fronting per-user workers.
//   worker — one per-user server behind a manager; identity arrives as a header.
// Anything unrecognized falls back to "local" so an unset or typo'd value can never
// silently turn a single-user install into one that trusts identity headers.
const VIBESPACE_MODES = ['local', 'multi', 'worker'];
const rawMode = (process.env.VIBESPACE_MODE || 'local').trim().toLowerCase();

if (!VIBESPACE_MODES.includes(rawMode)) {
  console.warn(
    `[WARN] Unknown VIBESPACE_MODE "${process.env.VIBESPACE_MODE}", falling back to "local". ` +
    `Expected one of: ${VIBESPACE_MODES.join(', ')}.`
  );
}

process.env.VIBESPACE_MODE = VIBESPACE_MODES.includes(rawMode) ? rawMode : 'local';
registerServerConfigKey('VIBESPACE_MODE');
