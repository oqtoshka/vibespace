import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The restore registry lives under DATABASE_PATH's directory. Set before import.
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cursor-continuation-'));
process.env.DATABASE_PATH = path.join(tempRoot, 'data', 'auth.db');

const { spawnCursor } = await import('./cursor-cli.js');
const { __clearTaskContinuationState, __setTaskLedgerReader } = await import('./services/task-continuation.js');

/** A fake cursor-agent: records its argv, reports a session, a result, exits. */
async function installFakeCursorAgent() {
  const binDir = path.join(tempRoot, 'bin');
  await import('node:fs/promises').then((fs) => fs.mkdir(binDir, { recursive: true }));
  const script = path.join(binDir, 'cursor-agent');
  await writeFile(script, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(path.join(tempRoot, 'calls.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-native-1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success' }) + '\\n');
`, 'utf8');
  await chmod(script, 0o755);
  return binDir;
}

const context = {
  // A brand-new conversation: the row has no provider id until cursor reports one.
  resolveProviderSessionId: () => null,
  resolveResumeModel: async (_id, model) => model || null,
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

test('a Cursor turn that ends with open TodoWrite items resumes itself, and completes once', async () => {
  const binDir = await installFakeCursorAgent();
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  __clearTaskContinuationState();
  let reads = 0;
  __setTaskLedgerReader('cursor', (sessionId, { cwd }) => {
    reads += 1;
    assert.equal(sessionId, 'cursor-native-1');
    assert.equal(cwd, tempRoot);
    return reads === 1
      ? { open: [{ id: '1', subject: 'ship the fix', status: 'in_progress', waitingOnUser: false }], activity: 1 }
      : { open: [], activity: 2 };
  });

  const sent = [];
  const writer = { send: (message) => sent.push(message), setSessionId: () => {}, userId: null };
  try {
    await spawnCursor('do the work', { sessionId: 'app-session-1', cwd: tempRoot, skipPermissions: true }, writer, context);

    const calls = (await readFile(path.join(tempRoot, 'calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 2, 'one continuation turn');
    assert.ok(calls[1].includes('--resume=cursor-native-1'), 'the continuation resumes the provider session');
    const prompt = calls[1][calls[1].indexOf('-p') + 1];
    assert.match(prompt, /ship the fix/);
    assert.match(prompt, /TodoWrite/);

    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1, 'the chain ends with exactly one complete');
    assert.ok(sent.some((message) => message.kind === 'status' && /open tasks remain/.test(message.text)));
  } finally {
    process.env.PATH = previousPath;
    __setTaskLedgerReader('cursor', null);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
