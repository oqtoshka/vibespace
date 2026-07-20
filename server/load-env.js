// Load environment variables from .env before other imports execute.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findAppRoot, getModuleDir } from './utils/runtime-paths.js';

const __dirname = getModuleDir(import.meta.url);
// Resolve the repo/app root via the nearest /server folder so this file keeps finding the
// same top-level .env file from both /server/load-env.js and /dist-server/server/load-env.js.
const APP_ROOT = findAppRoot(__dirname);

try {
  const envPath = path.join(APP_ROOT, '.env');
  const envFile = fs.readFileSync(envPath, 'utf8');
  envFile.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const [key, ...valueParts] = trimmedLine.split('=');
      if (key && valueParts.length > 0 && !process.env[key]) {
        process.env[key] = valueParts.join('=').trim();
      }
    }
  });
} catch (e) {
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
