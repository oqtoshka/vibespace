/**
 * Imported FIRST by the peer outbox tests: points DATABASE_PATH at a
 * pre-created empty file before any module can open the default-path
 * `database/auth.db` at import time.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (!process.env.PEER_OUTBOX_KEEP_DATABASE_PATH) {
  const directory = mkdtempSync(path.join(tmpdir(), 'peer-outbox-import-'));
  const databasePath = path.join(directory, 'auth.db');
  writeFileSync(databasePath, '', { flag: 'wx' });
  process.env.DATABASE_PATH = databasePath;
}
