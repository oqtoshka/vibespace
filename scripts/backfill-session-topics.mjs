#!/usr/bin/env node
/** Resume historical topics without starting foreground sessions. Build the server before running. */
import '../dist-server/server/load-env.js';
import fs from 'node:fs';
import { initializeDatabase, sessionsDb, getConnection } from '../dist-server/server/modules/database/index.js';
import { generateSessionRecap } from '../dist-server/server/modules/providers/index.js';
import { queryCodex } from '../dist-server/server/openai-codex.js';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const limit = Number(option('--limit', '20'));
const ids = option('--ids', '');
const model = option('--model', 'gpt-5.6-luna');
const locale = option('--locale', 'ru');
const selected = ids ? JSON.parse(fs.readFileSync(ids, 'utf8')) : null;
await initializeDatabase();
const rows = getConnection().prepare(`SELECT session_id FROM sessions
  WHERE is_private=0 AND is_side=0 AND provider_session_id IS NOT NULL
  ORDER BY updated_at DESC LIMIT ?`).all(selected ? -1 : limit)
  .filter(row => !selected || selected.includes(row.session_id));
let failed = 0;
async function processSession({ session_id: sessionId }) {
  const row = sessionsDb.getSessionById(sessionId);
  try {
    let more;
    do {
      more = await generateSessionRecap({ sessionId, cwd: row.project_path && fs.existsSync(row.project_path) ? row.project_path : process.cwd(),
        locale, model, fallbackModel: null, useIndexedHistory: row.provider !== 'claude', topicBatchChars: 50000,
        runQuery: (prompt, options, writer) => queryCodex(prompt, { ...options, permissionMode: 'default', ephemeral: true }, writer),
      });
      const memory = JSON.parse(sessionsDb.getSessionById(sessionId)?.topic_memory || 'null');
      console.log(JSON.stringify({ sessionId, cursor: memory?.cursor, topics: memory?.topics.length, more: Boolean(more) }));
    } while (more);
    const after = sessionsDb.getSessionById(sessionId)?.topic_memory;
    if (!after || JSON.parse(after).total === undefined || JSON.parse(after).cursor < JSON.parse(after).total) failed++;
  } catch (error) { failed++; console.error(JSON.stringify({ sessionId, error: error.message })); }
}
const concurrency = Math.max(1, Math.min(4, Number(option('--concurrency', '3'))));
let index = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (index < rows.length) await processSession(rows[index++]);
}));
console.log(JSON.stringify({ finished: true, sessions: rows.length, failed }));
process.exit(failed ? 1 : 0);
