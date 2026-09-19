import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

// Read into consts at module load — set before the import.
process.env.VIBESPACE_TASK_NUDGE_MAX = '3';

const { planTaskContinuation, __clearTaskContinuationState, __setTaskLedgerReader } = await import('../../modules/task-continuation/index.js');
const { readOpenCodeTaskState } = await import('../../shared/opencode-todo-ledger.js');
const { readCodexPlanState, findCodexRolloutPath } = await import('../../shared/index.js');
const { readCursorTaskState } = await import('../../shared/cursor-todo-ledger.js');

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
    { id: '1', subject: 'first open', status: 'in_progress', waitingOnUser: false },
    { id: '2', subject: 'second open', status: 'pending', waitingOnUser: false },
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
  fs.writeFileSync(file, lines.map((l) => JSON.stringify({ timestamp: '2026-08-19T10:00:00Z', ...l })).join('\n'));
  return file;
}

const planCall = (plan) => ({
  type: 'response_item',
  payload: { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan }) },
});

test('the codex reader takes the newest plan, in every encoding, and filters to open steps', () => {
  const root = path.join(tmp, 'codex-sessions');
  writeRollout(root, 'sid-plan', [
    planCall([{ step: 'old world', status: 'pending' }]),
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } },
    // Older code-mode's direct custom_tool_call spelling is accepted.
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
    // Current code mode wraps the tool call in executable JavaScript. Newest
    // still wins, including bare keys and trailing commas in the object.
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: `const p = await tools.update_plan({
          explanation: "keep punctuation like {step: untouched inside strings",
          plan: [
            {step: "wrapped done", status: "completed"},
            {step: "wrapped active", status: "in_progress"},
            {step: "wrapped next", status: "pending"},
          ],
        }); text(p)`,
      },
    },
  ]);

  const state = readCodexPlanState('sid-plan', root);
  assert.deepEqual(state.open, [
    { id: '6', subject: 'wrapped active', status: 'in_progress', waitingOnUser: false },
    { id: '7', subject: 'wrapped next', status: 'pending', waitingOnUser: false },
  ]);
  assert.ok(state.activity >= 2, 'tool calls in the window are counted');

  assert.equal(findCodexRolloutPath('sid-unknown', root), null);
  assert.deepEqual(readCodexPlanState('sid-unknown', root), { open: [], activity: 0 });
});

// Codex 0.153 dropped its own plan tool; the MCP server that replaces it shows
// up as `tools.mcp__mc__update_plan` inside exec, plus a structured McpToolCall.
test('the codex reader follows the plan tool when an MCP server serves it', () => {
  const root = path.join(tmp, 'codex-sessions-mcp');
  writeRollout(root, 'sid-mcp-exec', [
    planCall([{ step: 'old world', status: 'pending' }]),
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: 'text(await tools.mcp__mc__update_plan({plan:[{step:"exec done",status:"completed"},{step:"exec open",status:"in_progress"}]}))',
      },
    },
  ]);
  assert.equal(readCodexPlanState('sid-mcp-exec', root).open[0].subject, 'old world');

  writeRollout(root, 'sid-mcp-item', [
    planCall([{ step: 'old world', status: 'pending' }]),
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'McpToolCall',
          server: 'mc',
          tool: 'update_plan',
          arguments: { plan: [{ step: 'item open', status: 'pending' }, { step: 'item done', status: 'completed' }] },
        },
      },
    },
  ]);
  assert.deepEqual(readCodexPlanState('sid-mcp-item', root).open, [
    { id: '2', subject: 'item open', status: 'pending', waitingOnUser: false },
  ]);
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
// Cursor ledger reader — against a store.db in cursor-agent's blob layout.
// --------------------------------------------------------------------------

const varint = (n) => {
  const bytes = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0);
  return Buffer.from(bytes);
};
const lengthDelimited = (field, value) => Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
const varintField = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);

test('the cursor reader walks the latest root blob to its open TodoWrite items', async () => {
  const { default: crypto } = await import('node:crypto');
  const home = path.join(tmp, 'cursor-home');
  const cwd = path.join(tmp, 'cursor-project');
  fs.mkdirSync(cwd, { recursive: true });
  const hash = crypto.createHash('md5').update(fs.realpathSync(cwd)).digest('hex');
  const dir = path.join(home, '.cursor', 'chats', hash, 'cursor-session-1');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'store.db'));
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);');
  const put = (data) => {
    const id = crypto.createHash('sha256').update(data).digest();
    db.prepare('INSERT INTO blobs VALUES (?, ?)').run(id.toString('hex'), data);
    return id;
  };
  const todo = (id, content, status) => put(Buffer.concat([
    lengthDelimited(1, Buffer.from(id)), lengthDelimited(2, Buffer.from(content)), varintField(3, status),
    varintField(4, 1789362313899),
  ]));
  const todos = [
    todo('a', 'finished', 3),
    todo('b', 'in flight', 2),
    todo('c', '[waiting on user] pick one', 1),
    todo('d', 'dropped', 4),
  ];
  const root = put(Buffer.concat([lengthDelimited(1, Buffer.from('[]')), ...todos.map((id) => lengthDelimited(3, id))]));
  put(Buffer.from('{"role":"tool","content":[]}'));
  put(Buffer.from('{"role":"assistant","content":[]}'));
  const meta = Buffer.from(JSON.stringify({ agentId: 'cursor-session-1', latestRootBlobId: root.toString('hex') })).toString('hex');
  db.prepare("INSERT INTO meta VALUES ('0', ?)").run(meta);
  db.close();

  assert.deepEqual(readCursorTaskState('cursor-session-1', cwd, home), {
    open: [
      { id: '2', subject: 'in flight', status: 'in_progress', waitingOnUser: false },
      { id: '3', subject: '[waiting on user] pick one', status: 'pending', waitingOnUser: true },
    ],
    activity: 1,
  });
  assert.deepEqual(readCursorTaskState('cursor-session-1', path.join(tmp, 'elsewhere'), home), { open: [], activity: 0 });
  assert.deepEqual(readCursorTaskState('../escape', cwd, home), { open: [], activity: 0 });
});

// --------------------------------------------------------------------------
// The planner — budget, stall detection, and the exit condition.
// --------------------------------------------------------------------------

test('the planner nudges while the ledger is open and stops when it closes', () => {
  __clearTaskContinuationState();
  let ledger = { open: [{ id: '1', subject: 'ship it', status: 'pending', waitingOnUser: false }], activity: 0 };
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

test('two no-progress nudges give up; productive activity renews the budget', () => {
  __clearTaskContinuationState();
  const open = [{ id: '1', subject: 'stuck', status: 'pending', waitingOnUser: false }];

  // No progress: unchanged ledger, unchanged activity → 2 nudges then null.
  let calls = 0;
  __setTaskLedgerReader('codex', () => { calls += 1; return { open, activity: 0 }; });
  try {
    assert.ok(planTaskContinuation({ provider: 'codex', sessionId: 'sid_stall' }));
    assert.ok(planTaskContinuation({ provider: 'codex', sessionId: 'sid_stall' }));
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: 'sid_stall' }), null, 'stall detector trips on the third look');

    // Real work can take arbitrarily more turns than the empty-loop budget (3).
    __clearTaskContinuationState();
    let activity = 0;
    __setTaskLedgerReader('codex', () => ({ open, activity: activity += 1 }));
    for (let turn = 0; turn < 12; turn += 1) {
      assert.ok(planTaskContinuation({ provider: 'codex', sessionId: 'sid_budget' }), 'productive work must not exhaust a lifetime budget');
    }
  } finally {
    __setTaskLedgerReader('codex', null);
  }
});

test('items parked on the user are not nudged, and a fully parked ledger stands down quietly', () => {
  __clearTaskContinuationState();
  let ledger = {
    open: [
      { id: '1', subject: '[waiting on user] pick a pricing tier', status: 'pending', waitingOnUser: true },
      { id: '2', subject: 'write the migration', status: 'in_progress', waitingOnUser: false },
    ],
    activity: 0,
  };
  __setTaskLedgerReader('codex', () => ledger);
  try {
    const prompt = planTaskContinuation({ provider: 'codex', sessionId: 'sid_parked' });
    assert.ok(prompt.includes('write the migration'));
    assert.ok(!prompt.includes('pick a pricing tier'), 'a parked item is not pressed');
    assert.ok(prompt.includes('[waiting on user]'), 'the nudge teaches the marker');

    ledger = { open: [ledger.open[0]], activity: 0 };
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: 'sid_parked' }), null);
    // Standing down is not a stall: a later actionable item starts a fresh budget.
    ledger = { open: [{ id: '3', subject: 'new work', status: 'pending', waitingOnUser: false }], activity: 0 };
    assert.ok(planTaskContinuation({ provider: 'codex', sessionId: 'sid_parked' }));
  } finally {
    __setTaskLedgerReader('codex', null);
  }
});

test('both readers recognise the waiting-on-user prefix', () => {
  const { dbPath, db } = makeOpenCodeDb('opencode-parked.db');
  db.prepare('INSERT INTO todo VALUES (?, ?, ?, ?, ?, 0, 0)').run('ses_p', '[Waiting on the user] approve deploy', 'pending', 'high', 0);
  db.close();
  assert.equal(readOpenCodeTaskState('ses_p', dbPath).open[0].waitingOnUser, true);

  const root = path.join(tmp, 'codex-sessions-parked');
  writeRollout(root, 'sid-parked', [planCall([
    { step: '[waiting on user] confirm the schema', status: 'pending' },
    { step: 'not waiting on user yet', status: 'pending' },
  ])]);
  assert.deepEqual(readCodexPlanState('sid-parked', root).open.map((t) => t.waitingOnUser), [true, false]);
});

test('unknown providers and missing session ids are ignored', () => {
  __clearTaskContinuationState();
  assert.equal(planTaskContinuation({ provider: 'claude', sessionId: 'x' }), null);
  assert.equal(planTaskContinuation({ provider: 'opencode', sessionId: '' }), null);
});


test('completed turn with mc.plan work resumes; cumulative updates cannot hide omitted work', () => {
  const root = path.join(tmp, 'briefing-regression');
  const call = (args, status = 'completed', server = 'mc') => ({
    timestamp: '2026-09-20T00:00:00Z', type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'McpToolCall', server, tool: 'plan', arguments: args, status } },
  });
  const records = [
    call({ steps: [{ content: 'Repair supervisor', status: 'in_progress' }, { content: 'Verify restore', status: 'pending' }] }),
    call({ steps: [{ content: 'Repair supervisor', status: 'done' }] }),
    call({ steps: [], replace: true }, 'failed'),
    call({ steps: [], replace: true }, 'completed', 'another-server'),
  ];
  writeRollout(root, 'briefing', records);
  __clearTaskContinuationState();
  __setTaskLedgerReader('codex', id => readCodexPlanState(id, root));
  try {
    assert.match(planTaskContinuation({ provider: 'codex', sessionId: 'briefing' }), /Verify restore/);
    records.push(call({ steps: [{ content: 'Verify restore', status: 'skipped' }] }));
    writeRollout(root, 'briefing', records);
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: 'briefing' }), null);
    records.push(call({ steps: [{ content: '[waiting on user] Choose scope', status: 'pending' }] }));
    writeRollout(root, 'briefing', records);
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: 'briefing' }), null);
    records.push(call({ steps: [{ content: 'Fresh work', status: 'pending' }], replace: true }));
    writeRollout(root, 'briefing', records);
    assert.match(planTaskContinuation({ provider: 'codex', sessionId: 'briefing' }), /Fresh work/);
    records.push(call({ steps: [], remove: ['Fresh work'] }));
    writeRollout(root, 'briefing', records);
    assert.equal(planTaskContinuation({ provider: 'codex', sessionId: 'briefing' }), null);
  } finally { __setTaskLedgerReader('codex', null); __clearTaskContinuationState(); }
});
