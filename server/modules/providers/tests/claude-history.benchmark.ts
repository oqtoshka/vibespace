import { appendFile } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import { sessionsDb } from '@/modules/database/index.js';

import { ClaudeSessionsProvider } from '../list/claude/claude-sessions.provider.js';
import { generateClaudeHistory, syntheticSessionId, syntheticTurn } from '../../../../scripts/generate-claude-history.mjs';

import { referenceClaudeHistory } from './claude-history-reference.js';

const directory = process.argv[2];
if (!directory) throw new Error('Supply a scratch directory');
const { file, bytes, turns } = await generateClaudeHistory(directory, Number(process.argv[3] || 320));
// Isolate the benchmark from any application database or installation settings.
sessionsDb.getSessionById = (() => ({ jsonl_path: file })) as unknown as typeof sessionsDb.getSessionById;
const provider = new ClaudeSessionsProvider();
const reference = process.argv.includes('--reference');
const read = () => reference
  ? referenceClaudeHistory(syntheticSessionId, { limit: 100, offset: 0 })
  : provider.fetchHistory(syntheticSessionId, { limit: 100, offset: 0 });
console.log(JSON.stringify({ transcriptBytes: bytes, turns, reference }));
async function measure(name: string, run: () => Promise<unknown>) {
  global.gc?.();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  await new Promise(resolve => setTimeout(resolve, 30));
  const before = process.memoryUsage().heapUsed;
  const rssBefore = process.memoryUsage().rss;
  const start = performance.now();
  const result = await run();
  const wallMs = performance.now() - start;
  await new Promise(resolve => setTimeout(resolve, 30));
  delay.disable();
  console.log(JSON.stringify({ name, wallMs: +wallMs.toFixed(2), maxEventLoopDelayMs: +(delay.max / 1e6).toFixed(2), heapBefore: before, heapAfter: process.memoryUsage().heapUsed, rssBefore, rssAfter: process.memoryUsage().rss,
    messages: Array.isArray(result) ? result.length : (result as { messages?: unknown[] })?.messages?.length }));
}
await measure('first', read);
await measure('unchanged', read);
await appendFile(file, '\n' + syntheticTurn(turns).map(row => JSON.stringify(row)).join('\n') + '\n');
await measure('append', read);
await measure('concurrent-3', () => Promise.all([read(), read(), read()]));
