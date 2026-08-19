import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

// Read into consts at module load — set before the import.
process.env.VIBESPACE_TASK_NUDGE_MAX = '3';

const { planTaskContinuation, __clearTaskContinuationState, __setTaskLedgerReader } = await import('../task-continuation.js');
const { readOpenCodeTaskState } = await import('../../shared/opencode-todo-ledger.js');
const { readCodexPlanState, findCodexRolloutPath } = await import('../../shared/codex-plan-ledger.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibespace-task-continuation-'));

// --------------------------------------------------------------------------
// OpenCode ledger reader — against a real sqlite file in opencode's schema.
// --------------------------------------------------------------------------

function makeOpenCodeDb(name) {
  const dbPath = path.join(tmp, name);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE todo (
      session_id text NOT NULL, content text NOT NULL, status text NOT NULL,
      priority text NOT NULL, position integer NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL,
      CONSTRAINT todo_pk PRIMARY KEY(session_id, position)
    );
    CREATE TABLE part (
      id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
    );
  `);
  return { dbPath, db };
}

test('the opencode reader returns open todos in order plus a tool-activity count', () => {
  const { dbPath, db } = makeOpenCodeDb('opencode-read.db');
  const addTodo = db.prepare('INSERT INTO todo VALUES (?, ?, ?, ?, ?, 0, 0)');
  addTodo.run('ses_1', 'second open', 'pending', 'medium', 2);
  addTodo.run('ses_1', 'first open', 'in_progress', 'high', 1);
  addTodo.run('ses_1', 'already done', 'completed', 'low', 0);
  addTodo.run('ses_other', 'not ours', 'pending', 'low', 0);
  const addPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, 0, 0, ?)');
  addPart.run('p1', 'm1', 'ses_1', JSON.stringify({ type: 'tool', tool: 'bash' }));
  addPart.run('p2', 'm1', 'ses_1', JSON.stringify({ type: 'text', text: 'hi' }));
  addPart.run('p3', 'm2', 'ses_other', JSON.stringify({ type: 'tool', tool: 'read' }));
  db.close();

  const state = readOpenCodeTaskState('ses_1', dbPath);
  assert.deepEqual(state.open, [
    { id: '1', subject: 'first open', status: 'in_progress' },
    { id: '2', subject: 'second open', status: 'pending' },
  ]);
  assert.equal(state.activity, 1, 'only this session\'s tool parts count');

  assert.deepEqual(readOpenCodeTaskState('ses_1', path.join(tmp, 'missing.db')), { open: [], activity: 0 });
  assert.deepEqual(readOpenCodeTaskState('', dbPath), { open: [], activity: 0 });
});

// --------------------------------------------------------------------------
// Codex ledger reader — against a rollout transcript in codex's layout.
// --------------------------------------------------------------------------

function writeRollout(root, sessionId, lines) {
  const dir = path.join(root, '2026', '08', '19');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-19T10-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

const planCall = (plan) => ({
  type: 'response_item',
  payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan }) },
});

test('the codex reader takes the newest plan, in either encoding, and filters to open steps', () => {
  const root = path.join(tmp, 'codex-sessions');
  writeRollout(root, 'sid-plan', [
    planCall([{ step: 'old world', status: 'pending' }]),
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
    // Newest plan wins, and code-mode's custom_tool_call spelling is accepted.
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'update_plan',
        input: JSON.stringify({ plan: [
          { step: 'done already', status: 'completed' },
          { step: 'the real work', status: 'in_progress' },
          { step: 'and then this', status: 'pending' },
        ] }),
      },
    },
  ]);

  const state = readCodexPlanState('sid-plan', root);
  assert.deepEqual(state.open, [
    { id: '2', subject: 'the real work', status: 'in_progress' },
    { id: '3', subject: 'and then this', status: 'pending' },
  ]);
  assert.ok(state.activity >= 2, 'tool calls in the window are counted');

  assert.equal(findCodexRolloutPath('sid-unknown', root), null);
  assert.deepEqual(readCodexPlanState('sid-unknown', root), { open: [], activity: 0 });
});

test('a codex session with no plan, or an all-closed plan, reads as nothing open', () => {
  const root = path.join(tmp, 'codex-sessions-2');
  writeRollout(root, 'sid-noplan', [
    { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
  ]);
  assert.deepEqual(readCodexPlanState('sid-noplan', root).open, []);

  writeRollout(root, 'sid-closed', [planCall([{ step: 'all done', status: 'completed' }])]);
  assert.deepEqual(readCodexPlanState('sid-closed', root).open, []);
});

// --------------------------------------------------------------------------
// The planner — budget, stall detection, and the exit condition.
// --------------------------------------------------------------------------

test('the planner nudges while the ledger is open and stops when it closes', () => {
  __clearTaskContinuationState();
  let ledger = { open: [{ id: '1', subject: 'ship it', status: 'pending' }], activity: 0 };
  __setTaskLedgerReader('opencode', () => ledger);
  try {
    const prompt = planTaskContinuation({ provider: 'opencode', sessionId: 'ses_plan' });
    assert.ok(prompt.includes('ship it'), 'the nudge names the open item');
    assert.ok(prompt.includes('todo list'), 'the nudge speaks the provider\'s ledger language');

    // The model closes the ledger — the loop ends, whatever the budget says.
    ledger = { open: [], activity: 5 };
    assert.equal(planTaskContinuation({ provider: 'opencode', sessionId: 'ses_plan' }), null);
  } finally {
    __setTaskLedgerReader('opencode', null);
  }
});

test('two no-progress nudges give up; activity resets the stall but not the budget', () => {
  __clearTaskContinuationState();
  const open = [{ id: '1', subject: 'stuck', status: 'pending' }];

  // No progress: unchanged ledger, unchanged activity → 2 nudges then null.
  let calls = 0;
  __setTaskLedgerReader('codex', () => { calls += 1; return { open, activity: 0 }; });
  try {
    assert.ok(planTaskContinuation({ provider: 'codex', sessionId: 'sid_stall' }));
    assert.ok(planTaskContinuation({ provider: 'codex', sessionId: 'sid_stall' }));
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: 'sid_stall' }), null, 'stall detector trips on the third look');

    // Real work every turn: activity moves, so only the budget (3) bounds it.
    __clearTaskContinuationState();
    let activity = 0;
    __setTaskLedgerReader('codex', () => ({ open, activity: activity += 1 }));
    assert.ok(planTaskContinuation({ provider: 'codex', sessionId: 'sid_budget' }));
    assert.ok(planTaskContinuation({ provider: 'codex', sessionId: 'sid_budget' }));
    assert.ok(planTaskContinuation({ provider: 'codex', sessionId: 'sid_budget' }));
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: 'sid_budget' }), null, 'budget exhausted');
  } finally {
    __setTaskLedgerReader('codex', null);
  }
});

test('unknown providers and missing session ids are ignored', () => {
  __clearTaskContinuationState();
  assert.equal(planTaskContinuation({ provider: 'claude', sessionId: 'x' }), null);
  assert.equal(planTaskContinuation({ provider: 'opencode', sessionId: '' }), null);
});
