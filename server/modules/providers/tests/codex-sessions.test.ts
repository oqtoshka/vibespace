import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-provider-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('Codex history reads completed user items once, preserves repeated turns and excludes injected context', { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-modern-history-'));
  const transcript = path.join(root, 'rollout.jsonl');
  const entries = [
    { type: 'event_msg', payload: { type: 'user_message', message: 'Legacy question' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Injected instructions' }] } },
    ...['turn-1', 'turn-2'].flatMap(turnId => [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Same question' }] } },
      { type: 'event_msg', payload: { type: 'item_completed', turn_id: turnId, item: { type: 'UserMessage', content: [{ type: 'text', text: 'Same question' }] } } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] } },
    ]),
  ];
  try {
    await writeFile(transcript, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    await withIsolatedDatabase(async () => {
      const id = sessionsDb.createSession('modern-provider', 'codex', root, 'Modern test', undefined, undefined, transcript);
      const history = await new CodexSessionsProvider().fetchHistory(id);
      assert.deepEqual(history.messages.filter(m => m.role === 'user').map(m => m.content),
        ['Legacy question', 'Same question', 'Same question']);
      assert.equal(history.messages.filter(m => m.role === 'assistant').length, 2);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex history preserves images on current completed user items, including image-only turns', { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-modern-image-history-'));
  const transcript = path.join(root, 'rollout.jsonl');
  const imagePath = path.join(root, 'native-image.png');
  const entries = [
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [
      { type: 'text', text: 'Describe this image' }, { type: 'local_image', path: imagePath },
    ] } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [
      { type: 'local_image', path: imagePath },
    ] } } },
  ];
  try {
    await writeFile(transcript, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await withIsolatedDatabase(async () => {
      const id = sessionsDb.createSession('modern-images', 'codex', root, 'Modern images', undefined, undefined, transcript);
      const history = await new CodexSessionsProvider().fetchHistory(id);
      assert.deepEqual(history.messages.map(message => ({
        content: message.content,
        images: message.images,
      })), [
        { content: 'Describe this image', images: [{ path: imagePath }] },
        { content: '', images: [{ path: imagePath }] },
      ]);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex assistant history retains live item identity across reads and repeated text', { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-assistant-identity-'));
  const transcript = path.join(root, 'rollout.jsonl');
  const text = 'Checking the avatar pipeline.\n';
  const entries = ['msg-first', 'msg-repeat'].map(id => ({
    type: 'response_item', timestamp: '2026-09-12T17:41:58.887Z',
    payload: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }] },
  }));
  try {
    await writeFile(transcript, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    await withIsolatedDatabase(async () => {
      const id = sessionsDb.createSession('assistant-identity', 'codex', root, 'Identity test', undefined, undefined, transcript);
      const provider = new CodexSessionsProvider();
      const live = provider.normalizeMessage({ type: 'item', itemType: 'agent_message', uuid: 'msg-first',
        timestamp: '2026-09-12T17:41:58.888Z', message: { role: 'assistant', content: text } }, id)[0];
      for (let read = 0; read < 2; read += 1) {
        const history = await provider.fetchHistory(id);
        assert.deepEqual(history.messages.map(message => message.id), ['msg-first', 'msg-repeat']);
        assert.equal(history.messages[0].id, live.id);
        assert.notEqual(history.messages[0].timestamp, live.timestamp);
      }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

/**
 * Writes one Codex rollout transcript. `firstUserMessage` mirrors the
 * `event_msg`/`user_message` payload the runtime records for the prompt the
 * user typed; omitting it produces a transcript with no user turn.
 */
const writeCodexTranscript = async (
  homeDir: string,
  codexSessionId: string,
  workspacePath: string,
  firstUserMessage?: string,
): Promise<string> => {
  const sessionsDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '07');
  await mkdir(sessionsDir, { recursive: true });

  const lines: string[] = [
    JSON.stringify({ type: 'session_meta', payload: { id: codexSessionId, cwd: workspacePath } }),
  ];
  if (firstUserMessage !== undefined) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: firstUserMessage } }));
  }

  const filePath = path.join(sessionsDir, `rollout-${codexSessionId}.jsonl`);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

test('Codex synchronizer preserves the title assigned when CloudCLI creates a session', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-app-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await writeCodexTranscript(tempRoot, 'codex-app-1', workspacePath, 'Provider transcript title must not win');
    await withIsolatedDatabase(async () => {
      // The app allocates its own id and later maps the provider id onto it,
      // exactly as a message sent from cloudcli does.
      sessionsDb.createAppSession('app-1', 'codex', workspacePath, 'Fix the login redirect');
      sessionsDb.assignProviderSessionId('app-1', 'codex-app-1');

      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('app-1')?.custom_name, 'Fix the login redirect');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer skips sub-agent rollout files', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-subagent-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // Codex >=0.144 spawn_agent threads write their own rollout files into the
    // same sessions tree, marked via thread_source/source in session_meta.
    const sessionsDir = path.join(tempRoot, '.codex', 'sessions', '2026', '07', '07');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      path.join(sessionsDir, 'rollout-codex-subagent-1.jsonl'),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'codex-subagent-1',
          cwd: workspacePath,
          thread_source: 'subagent',
          parent_thread_id: 'codex-parent-1',
          source: { subagent: { thread_spawn: { parent_thread_id: 'codex-parent-1', depth: 1 } } },
        },
      })}\n`,
      'utf8'
    );
    await writeCodexTranscript(tempRoot, 'codex-parent-1', workspacePath);

    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      const processed = await synchronizer.synchronize();

      assert.equal(processed, 1);
      assert.ok(sessionsDb.getSessionById('codex-parent-1'));
      assert.equal(sessionsDb.getSessionById('codex-subagent-1'), null);
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex synchronizer leaves indexed sessions untitled when no name is available', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-session-sync-indexed-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // A CLI-created session has no app row; its first user message must NOT be
    // used as the title, preserving the existing indexing behavior.
    await writeCodexTranscript(tempRoot, 'codex-indexed-1', workspacePath, 'This prompt should be ignored');
    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      await synchronizer.synchronize();

      assert.equal(sessionsDb.getSessionById('codex-indexed-1')?.custom_name, 'Untitled Codex Session');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Codex history preserves wrapped exec tool calls and results', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-exec-history-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    const providerSessionId = 'codex-exec-1';
    const transcriptPath = await writeCodexTranscript(tempRoot, providerSessionId, workspacePath);
    const imageDataUrl = 'data:image/png;base64,aGVsbG8=';
    type WrappedCall = {
      callId: string;
      input: string;
      expectedToolName?: string;
      expectedToolInput?: string;
      output?: unknown;
      expectedImages?: Array<{ data: string }>;
    };
    const wrappedCalls: WrappedCall[] = [
      {
        callId: 'shell-command-1',
        input: 'const cmds = ["echo one", "echo two"]; await Promise.all(cmds.map(command => tools.shell_command({ command })));',
        expectedToolName: 'Bash',
        expectedToolInput: JSON.stringify({ command: 'echo one\necho two' }),
      },
      {
        callId: 'json-shell-command-1',
        input: 'const r = await tools.shell_command({"command":"Get-Content -Raw README.md","workdir":"C:\\\\workspace","timeout_ms":10000}); text(r)',
        expectedToolName: 'Bash',
        expectedToolInput: JSON.stringify({ command: 'Get-Content -Raw README.md' }),
      },
      {
        callId: 'exec-command-1',
        input: 'await tools.exec_command({"command":"echo current"});',
        expectedToolName: 'Bash',
        expectedToolInput: JSON.stringify({ command: 'echo current' }),
      },
      { callId: 'apply-patch-1', input: 'await tools.apply_patch("*** Begin Patch\\n*** End Patch");' },
      { callId: 'web-run-1', input: 'await tools.web__run({ search_query: [{ q: "Codex" }] });' },
      { callId: 'update-plan-1', input: 'await tools.update_plan({ plan: [] });' },
      { callId: 'unknown-1', input: 'await tools.unknown_wrapper({ value: true });' },
      {
        callId: 'image-output-1',
        input: 'const result = await tools.view_image({ path: "/tmp/image.png" }); image(result.image_url);',
        output: [{ type: 'input_image', image_url: imageDataUrl }],
        expectedImages: [{ data: imageDataUrl }],
      },
    ];
    const transcriptLines = [
      JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: workspacePath } }),
    ];
    for (const call of wrappedCalls) {
      transcriptLines.push(
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'custom_tool_call', name: 'exec', call_id: call.callId, input: call.input },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: call.callId,
            output: call.output ?? `result:${call.callId}`,
          },
        }),
      );
    }
    await writeFile(transcriptPath, `${transcriptLines.join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      sessionsDb.createAppSession('app-exec-1', 'codex', workspacePath);
      sessionsDb.assignProviderSessionId('app-exec-1', providerSessionId);
      await new CodexSessionSynchronizer().synchronize();

      const history = await new CodexSessionsProvider().fetchHistory('app-exec-1');
      const toolUses = history.messages.filter((message) => message.kind === 'tool_use');
      const toolResults = history.messages.filter((message) => message.kind === 'tool_result');
      const toolUsesById = new Map(toolUses.map((message) => [message.toolId, message]));
      const toolResultsById = new Map(toolResults.map((message) => [message.toolId, message]));

      assert.equal(toolUses.length, wrappedCalls.length);
      assert.equal(toolResults.length, wrappedCalls.length);
      for (const call of wrappedCalls) {
        const toolUse = toolUsesById.get(call.callId);
        assert.ok(toolUse);
        assert.equal(toolUse.toolName, call.expectedToolName || 'exec');
        assert.equal(toolUse.toolInput, call.expectedToolInput || call.input);
        const expectedContent = call.output === undefined ? `result:${call.callId}` : '';
        assert.equal(toolUse.toolResult?.content, expectedContent);
        assert.deepEqual(toolUse.toolResult?.images, call.expectedImages);
        assert.equal(toolResultsById.get(call.callId)?.content, expectedContent);
        assert.deepEqual(toolResultsById.get(call.callId)?.images, call.expectedImages);
      }
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
