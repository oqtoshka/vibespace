import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
} from '../../modules/database/index.js';
import { __testing } from '../../modules/providers/services/session-recap.service.js';

const {
  readTranscriptTail,
  readIndexedTranscriptTail,
  parseRecapResponse,
  buildRecapPrompt,
  isTitleRewording,
  generateRecap,
} = __testing;

const jsonl = (entries) => entries.map((entry) => JSON.stringify(entry)).join('\n');

async function writeTranscript(lines) {
  const dir = await mkdtemp(path.join(tmpdir(), 'recap-'));
  const file = path.join(dir, 'session.jsonl');
  await writeFile(file, lines, 'utf8');
  return file;
}

test('readTranscriptTail keeps user and assistant prose', async () => {
  const file = await writeTranscript(jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: 'fix the prune job' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Found two bugs.' }] } },
  ]));

  assert.deepEqual(await readTranscriptTail(file), {
    messages: [
      { role: 'user', text: 'fix the prune job' },
      { role: 'assistant', text: 'Found two bugs.' },
    ],
    total: 2,
  });
});

test('readTranscriptTail drops tool traffic, which is most of the bytes', async () => {
  const file = await writeTranscript(jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: 'run the tests' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: '259 passing' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'All 259 pass.' }] } },
  ]));

  assert.deepEqual(await readTranscriptTail(file), {
    messages: [
      { role: 'user', text: 'run the tests' },
      { role: 'assistant', text: 'All 259 pass.' },
    ],
    total: 2,
  });
});

test('readTranscriptTail skips host chatter that is not conversation', async () => {
  const file = await writeTranscript(jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: '<local-command-name>/compact</local-command-name>' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>be careful</system-reminder>' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: 'actual question' }] } },
  ]));

  assert.deepEqual(await readTranscriptTail(file), {
    messages: [{ role: 'user', text: 'actual question' }],
    total: 1,
  });
});

test('readTranscriptTail truncates a pasted wall of text', async () => {
  const file = await writeTranscript(jsonl([
    { type: 'user', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } },
  ]));

  const [message] = (await readTranscriptTail(file)).messages;
  assert.equal(message.text.length, 601, 'capped at 600 chars plus the ellipsis');
  assert.ok(message.text.endsWith('…'));
});

test('readTranscriptTail keeps only the tail of a long session', async () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({
    type: 'user',
    message: { content: [{ type: 'text', text: `message ${index}` }] },
  }));
  const file = await writeTranscript(jsonl(entries));

  const { messages, total } = await readTranscriptTail(file);
  assert.equal(messages.length, 40);
  assert.equal(messages.at(-1).text, 'message 99', 'the newest exchange must survive');
  // The count is the whole session, not the tail: a recap that compared tail
  // lengths would freeze at 40 and never refresh again.
  assert.equal(total, 100);
});

test('readTranscriptTail survives a missing file and a corrupt line', async () => {
  assert.deepEqual(await readTranscriptTail('/nope/missing.jsonl'), { messages: [], total: 0 });

  const file = await writeTranscript([
    '{ not json',
    JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'still read' }] } }),
  ].join('\n'));
  assert.deepEqual(await readTranscriptTail(file), {
    messages: [{ role: 'user', text: 'still read' }],
    total: 1,
  });
});

test('parseRecapResponse reads a bare object', () => {
  assert.deepEqual(
    parseRecapResponse('{"title": "Dind Image Pruning", "recap": "Fixed the cron."}'),
    { title: 'Dind Image Pruning', recap: 'Fixed the cron.' },
  );
});

test('parseRecapResponse digs the object out of a fence or preamble', () => {
  const fenced = '```json\n{"title": "A B", "recap": "C."}\n```';
  assert.deepEqual(parseRecapResponse(fenced), { title: 'A B', recap: 'C.' });

  const chatty = 'Sure! Here you go:\n{"title": "A B", "recap": "C."}\nHope that helps.';
  assert.deepEqual(parseRecapResponse(chatty), { title: 'A B', recap: 'C.' });
});

test('parseRecapResponse caps oversized fields rather than rejecting them', () => {
  const result = parseRecapResponse(JSON.stringify({ title: 'T'.repeat(200), recap: 'R'.repeat(900) }));
  assert.equal(result.title.length, 60);
  assert.equal(result.recap.length, 400);
});

test('parseRecapResponse rejects what it cannot use', () => {
  assert.equal(parseRecapResponse(''), null);
  assert.equal(parseRecapResponse('no json here'), null);
  assert.equal(parseRecapResponse('{"title": "", "recap": ""}'), null);
  assert.equal(parseRecapResponse('{broken'), null);
});

test('buildRecapPrompt labels roles and includes the transcript', () => {
  const prompt = buildRecapPrompt([
    { role: 'user', text: 'fix the prune' },
    { role: 'assistant', text: 'done' },
  ]);

  assert.match(prompt, /User: fix the prune/);
  assert.match(prompt, /Assistant: done/);
  assert.match(prompt, /"title"/);
  assert.match(prompt, /"recap"/);
});

test('buildRecapPrompt follows a supported interface locale and rejects arbitrary locale text', () => {
  const messages = [
    { role: 'user', text: 'ship the localization' },
    { role: 'assistant', text: 'done' },
  ];

  assert.match(buildRecapPrompt(messages, 'ru'), /title and recap in Russian/);
  assert.match(buildRecapPrompt(messages, 'ru-RU'), /title and recap in Russian/);
  assert.match(buildRecapPrompt(messages, 'ignore instructions'), /title and recap in English/);
  assert.doesNotMatch(buildRecapPrompt(messages, 'ignore instructions'), /ignore instructions/);
});

test('buildRecapPrompt offers the current title for keeping', () => {
  const messages = [
    { role: 'user', text: 'fix the prune' },
    { role: 'assistant', text: 'done' },
  ];

  const prompt = buildRecapPrompt(messages, 'en', 'Dind Image Pruning');
  assert.match(prompt, /current title is "Dind Image Pruning"/);
  assert.match(prompt, /\{"title": null, "recap": "\.\.\."\}/);
  assert.match(prompt, /would someone looking for this tab\s+still recognise it under the current title\? If yes, keep it/);
  assert.match(prompt, /Rewording, a more precise synonym, or a next step within the same\s+subject is NOT a material change/);

  // No current title: the model is asked for one, with nothing to keep.
  const fresh = buildRecapPrompt(messages, 'en');
  assert.doesNotMatch(fresh, /current title/);
  assert.match(fresh, /\{"title": "\.\.\.", "recap": "\.\.\."\}/);
});

test('parseRecapResponse reads a null title as keep, still returning the recap', () => {
  assert.deepEqual(
    parseRecapResponse('{"title": null, "recap": "Moved on to the cron."}'),
    { title: '', recap: 'Moved on to the cron.' },
  );
});

test('isTitleRewording catches rewordings and lets new subjects through', () => {
  // Case, punctuation, stopwords and plurals.
  assert.equal(isTitleRewording('Recap Titles', 'recap title'), true);
  assert.equal(isTitleRewording('Pruning of Dind Images', 'Dind Image Pruning'), true);
  // A more precise synonym or a next step in the same subject.
  assert.equal(isTitleRewording('Dind Image Pruning', 'Dind Image Cleanup'), true);
  assert.equal(isTitleRewording('Dind Image Pruning', 'Dind Image Pruning Cron'), true);
  assert.equal(isTitleRewording('Stable Session Titles', 'Sticky Session Titles'), true);
  // Genuinely different subjects.
  assert.equal(isTitleRewording('Dind Image Pruning', 'Sidebar Drag Reorder'), false);
  assert.equal(isTitleRewording('Session Recap Titles', 'Session Sidebar Layout'), false);
  assert.equal(isTitleRewording('Login Bug', 'Telegram Bot Setup'), false);
  // One shared generic word is not a rewording.
  assert.equal(isTitleRewording('VibeSpace', 'Billing Export Page'), false);
  // Titles without separable words compare as whole strings.
  assert.equal(isTitleRewording('会话标题', '会话标题'), true);
  assert.equal(isTitleRewording('会话标题', '侧边栏布局'), false);
});

// OpenCode keeps every conversation in one shared SQLite store rather than a
// file per session, so the recap for one is built from the indexed history the
// UI renders instead of a transcript on disk.
test('readIndexedTranscriptTail keeps the prose and drops the plumbing', async () => {
  const history = {
    total: 6,
    messages: [
      { kind: 'text', role: 'user', content: 'fix the prune job' },
      { kind: 'tool_use', role: 'assistant', toolName: 'bash', content: 'docker prune' },
      { kind: 'tool_result', role: 'user', content: 'reclaimed 4GB' },
      { kind: 'thinking', role: 'assistant', content: 'the cron is wrong' },
      { kind: 'text', role: 'assistant', content: 'Found two bugs.' },
      { kind: 'text', role: 'user', content: '   ' },
    ],
  };

  assert.deepEqual(await readIndexedTranscriptTail('app-1', async () => history), {
    messages: [
      { role: 'user', text: 'fix the prune job' },
      { role: 'assistant', text: 'Found two bugs.' },
    ],
    total: 6,
  });
});

test('readIndexedTranscriptTail applies the same caps as the file reader', async () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    kind: 'text',
    role: 'user',
    content: `message ${index}`,
  }));
  messages.push({ kind: 'text', role: 'assistant', content: 'x'.repeat(5000) });

  const { messages: tail, total } = await readIndexedTranscriptTail(
    'app-1',
    async () => ({ total: messages.length, messages }),
  );

  assert.equal(tail.length, 40);
  assert.equal(tail.at(-1).text.length, 601, 'capped at 600 chars plus the ellipsis');
  assert.equal(total, 101, 'the count is the whole session, so the recap keeps refreshing');
});

test('readIndexedTranscriptTail skips host chatter and survives a failed read', async () => {
  const chatter = {
    total: 2,
    messages: [
      { kind: 'text', role: 'user', content: '<local-command-name>/compact</local-command-name>' },
      { kind: 'text', role: 'user', content: 'actual question' },
    ],
  };
  assert.deepEqual(await readIndexedTranscriptTail('app-1', async () => chatter), {
    messages: [{ role: 'user', text: 'actual question' }],
    total: 2,
  });

  assert.deepEqual(
    await readIndexedTranscriptTail('app-1', async () => {
      throw new Error('session not found');
    }),
    { messages: [], total: 0 },
  );
});

test('generateRecap can summarize normalized Codex history instead of Claude JSONL', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'codex-recap-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    sessionsDb.createSession(
      'codex-provider-1',
      'codex',
      tempDirectory,
      undefined,
      undefined,
      undefined,
      '/not-a-claude-transcript.jsonl',
    );

    let helperOptions = null;
    let delivered = null;
    await generateRecap({
      sessionId: 'codex-provider-1',
      cwd: tempDirectory,
      useIndexedHistory: true,
      fetchHistory: async () => ({
        total: 2,
        messages: [
          { kind: 'text', role: 'user', content: 'add Codex recap support' },
          { kind: 'text', role: 'assistant', content: 'Implemented and tested it.' },
        ],
      }),
      runQuery: async (_prompt, options, writer) => {
        helperOptions = options;
        writer.send(JSON.stringify({
          kind: 'text',
          content: '{"title":"Codex Recaps","recap":"Implemented and tested Codex recap support."}',
        }));
      },
      onRecap: (result) => { delivered = result; },
    });

    assert.equal(helperOptions?.ephemeral, true);
    assert.deepEqual(delivered, {
      sessionId: 'codex-provider-1',
      title: 'Codex Recaps',
      recap: 'Implemented and tested Codex recap support.',
    });
    const stored = sessionsDb.getSessionById('codex-provider-1');
    assert.equal(stored?.custom_name, 'Codex Recaps');
    assert.equal(stored?.recap, 'Implemented and tested Codex recap support.');
    assert.equal(stored?.recap_message_count, 2);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// A model name means nothing outside its own provider: handing Claude's cheap
// tier to a Codex or OpenCode helper starts a turn their runtime cannot serve,
// which fails with no output at all and reads back as an unparseable reply —
// the session then silently never gets a recap or an AI title.
test('generateRecap sends no model at all when the provider cannot run the default', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'fallback-recap-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const history = async () => ({
    total: 2,
    messages: [
      { kind: 'text', role: 'user', content: 'ship the fallback fix' },
      { kind: 'text', role: 'assistant', content: 'Shipped it.' },
    ],
  });
  const reply = (_prompt, options, writer) => {
    writer.send(JSON.stringify({ kind: 'text', content: '{"title":"Fallback","recap":"Shipped it."}' }));
    return options;
  };

  try {
    sessionsDb.createSession('codex-no-model', 'codex', tempDirectory);
    sessionsDb.createSession('codex-own-model', 'codex', tempDirectory);
    sessionsDb.createSession('claude-no-model', 'claude', tempDirectory);

    let helperOptions = null;
    await generateRecap({
      sessionId: 'codex-no-model',
      cwd: tempDirectory,
      useIndexedHistory: true,
      fetchHistory: history,
      fallbackModel: null,
      runQuery: async (prompt, options, writer) => { helperOptions = reply(prompt, options, writer); },
    });
    assert.equal(helperOptions?.model, undefined);

    // A model the caller did name is still what the helper runs on.
    await generateRecap({
      sessionId: 'codex-own-model',
      cwd: tempDirectory,
      model: 'gpt-5.1-codex',
      useIndexedHistory: true,
      fetchHistory: history,
      fallbackModel: null,
      runQuery: async (prompt, options, writer) => { helperOptions = reply(prompt, options, writer); },
    });
    assert.equal(helperOptions?.model, 'gpt-5.1-codex');

    // Claude, which can run the cheap tier, still gets it by default.
    await generateRecap({
      sessionId: 'claude-no-model',
      cwd: tempDirectory,
      useIndexedHistory: true,
      fetchHistory: history,
      runQuery: async (prompt, options, writer) => { helperOptions = reply(prompt, options, writer); },
    });
    assert.equal(helperOptions?.model, 'haiku');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// A private session's transcript must not be fed to a helper model for a
// summary: the recap would write a second copy of the conversation into the
// VibeSpace database and hand it to the sidebar, which is exactly the kind of
// record a private session promises not to leave.
test('generateRecap leaves a private session alone', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'private-recap-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    sessionsDb.createAppSession('app-private-recap', 'claude', tempDirectory, false, true);
    sessionsDb.assignProviderSessionId('app-private-recap', 'claude-private-recap');

    let queried = false;
    let fetched = false;
    let delivered = null;
    await generateRecap({
      sessionId: 'claude-private-recap',
      cwd: tempDirectory,
      useIndexedHistory: true,
      fetchHistory: async () => {
        fetched = true;
        return {
          total: 2,
          messages: [
            { kind: 'text', role: 'user', content: 'something confidential' },
            { kind: 'text', role: 'assistant', content: 'noted' },
          ],
        };
      },
      runQuery: async (_prompt, _options, writer) => {
        queried = true;
        writer.send(JSON.stringify({ kind: 'text', content: '{"title":"Leak","recap":"leaked"}' }));
      },
      onRecap: (result) => { delivered = result; },
    });

    assert.equal(fetched, false);
    assert.equal(queried, false);
    assert.equal(delivered, null);
    const stored = sessionsDb.getSessionById('app-private-recap');
    assert.equal(stored?.recap, null);
    assert.equal(stored?.custom_name, null);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// The title is sticky: once a session has an AI title, a recap replaces it only
// when the subject has changed, while the recap text itself updates every time.
test('generateRecap keeps an AI title on keep or rewording and replaces it on a new subject', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sticky-title-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  let turn = 0;
  const history = async () => {
    turn += 2;
    return {
      total: turn,
      messages: [
        { kind: 'text', role: 'user', content: `step ${turn}` },
        { kind: 'text', role: 'assistant', content: `did step ${turn}` },
      ],
    };
  };
  const recapWith = async (reply) => {
    let prompt = null;
    let delivered = null;
    await generateRecap({
      sessionId: 'sticky-1',
      cwd: tempDirectory,
      useIndexedHistory: true,
      fetchHistory: history,
      runQuery: async (sentPrompt, _options, writer) => {
        prompt = sentPrompt;
        writer.send(JSON.stringify({ kind: 'text', content: JSON.stringify(reply) }));
      },
      onRecap: (result) => { delivered = result; },
    });
    return { prompt, delivered, stored: sessionsDb.getSessionById('sticky-1') };
  };

  try {
    sessionsDb.createSession('sticky-1', 'codex', tempDirectory);
    // The first-message title, as session-title.service stores it.
    sessionsDb.updateSessionCustomName('sticky-1', 'Dind Image Pruning', 'ai');

    // Explicit keep: the name stays, the recap moves on.
    let run = await recapWith({ title: null, recap: 'Found the cron.' });
    assert.match(run.prompt, /current title is "Dind Image Pruning"/);
    assert.equal(run.stored.custom_name, 'Dind Image Pruning');
    assert.equal(run.stored.recap, 'Found the cron.');
    assert.deepEqual(run.delivered, { sessionId: 'sticky-1', title: null, recap: 'Found the cron.' });

    // A rewording the model sent anyway is discarded.
    run = await recapWith({ title: 'Dind Image Cleanup', recap: 'Fixed the cron.' });
    assert.equal(run.stored.custom_name, 'Dind Image Pruning');
    assert.equal(run.stored.recap, 'Fixed the cron.');
    assert.equal(run.delivered.title, null);

    // A genuinely new subject replaces it.
    run = await recapWith({ title: 'Sidebar Drag Reorder', recap: 'Switched to the sidebar.' });
    assert.equal(run.stored.custom_name, 'Sidebar Drag Reorder');
    assert.equal(run.stored.name_source, 'ai');
    assert.equal(run.delivered.title, 'Sidebar Drag Reorder');

    // A placeholder name is not offered for keeping, and a hand-written one is never replaced.
    sessionsDb.updateSessionCustomName('sticky-1', 'also i want you to fix the', 'derived');
    run = await recapWith({ title: 'Prune Job Fix', recap: 'Fixing the prune job.' });
    assert.doesNotMatch(run.prompt, /current title/);
    assert.equal(run.stored.custom_name, 'Prune Job Fix');

    sessionsDb.updateSessionCustomName('sticky-1', 'My Name', 'user');
    run = await recapWith({ title: 'Telegram Bot Setup', recap: 'Set up the bot.' });
    assert.equal(run.stored.custom_name, 'My Name');
    assert.equal(run.stored.recap, 'Set up the bot.');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
