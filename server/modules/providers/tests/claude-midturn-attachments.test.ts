import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A scratch home, Claude config dir and database before the runtime loads:
// the assets store, the model-override file and the session rows a turn's end
// reads live there.
const homeDir = await mkdtemp(path.join(os.tmpdir(), 'claude-midturn-home-'));
const configDir = await mkdtemp(path.join(os.tmpdir(), 'claude-midturn-config-'));
process.env.HOME = homeDir;
process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.DATABASE_PATH = path.join(homeDir, 'auth.db');

// eslint-disable-next-line boundaries/no-unknown -- The persistent Claude runtime, driven by a scripted SDK query.
const { queryClaudeSDK, injectClaudeMessage, abortClaudeSDKSession, __setClaudeQueryImpl } = await import('../../../claude-sdk.js');
const { initializeDatabase, closeConnection } = await import('../../database/index.js');

test.before(() => initializeDatabase());
test.after(async () => {
  closeConnection();
  await rm(homeDir, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

type PushedMessage = { uuid?: string; message: { role: string; content: any } };

/**
 * A runtime that advertises `msg_lifecycle_v1` and holds its first turn open
 * until a message is injected into it, then folds that message in the way the
 * CLI does: `command_lifecycle` started, a reply, completed, the turn's result.
 */
function midTurnRuntime(sessionId: string, received: PushedMessage[], onTurnOpen: () => void) {
  return ({ prompt }: { prompt: AsyncIterable<PushedMessage> }) => {
    const reader = prompt[Symbol.asyncIterator]();
    const gen: any = (async function* () {
      received.push((await reader.next()).value);
      yield { type: 'system', subtype: 'init', session_id: sessionId, capabilities: ['msg_lifecycle_v1'] };
      onTurnOpen();
      const injected = (await reader.next()).value;
      received.push(injected);
      yield { type: 'command_lifecycle', command_uuid: injected.uuid, state: 'started' };
      yield { type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'read it' }] } };
      yield { type: 'command_lifecycle', command_uuid: injected.uuid, state: 'completed' };
      yield { type: 'result', subtype: 'success', session_id: sessionId };
      // Idle until the session is torn down.
      await reader.next();
    })();
    gen.interrupt = async () => {};
    return gen;
  };
}

/** Opens a turn, injects one message into it while it runs, and waits for the turn to end. */
async function sendMidTurn(sessionId: string, cwd: string, firstTurn: Record<string, unknown>, injected: Record<string, unknown>) {
  const received: PushedMessage[] = [];
  const sent: any[] = [];
  let markTurnOpen!: () => void;
  const turnOpen = new Promise<void>((resolve) => { markTurnOpen = resolve; });
  __setClaudeQueryImpl(midTurnRuntime(sessionId, received, markTurnOpen));

  const writer = { send: (message: any) => sent.push(message), setSessionId() {}, userId: null };
  const turn = queryClaudeSDK('first', { sessionId, cwd, ...firstTurn }, writer);
  await turnOpen;
  const uuid = await injectClaudeMessage(sessionId, 'second', { cwd, ...injected });
  assert.ok(uuid, 'a live session with msg_lifecycle_v1 takes the message mid-turn');
  await turn;
  assert.equal(received.length, 2);
  return { uuid, newTurn: received[0], midTurn: received[1], echo: sent.find((message) => message.id === uuid) };
}

const BUILD_LOG = { path: path.join(homeDir, '.vibespace', 'assets', 'build.log'), name: 'build.log', mimeType: 'text/plain' };

test('a file sent while Claude is mid-turn reaches the agent in the same <files_input> block a new turn carries', { timeout: 15000 }, async () => {
  const sessionId = 'claude-midturn-files';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-midturn-project-'));
  try {
    const { uuid, newTurn, midTurn, echo } = await sendMidTurn(sessionId, cwd, { files: [BUILD_LOG] }, { files: [BUILD_LOG] });

    assert.equal(midTurn.uuid, uuid);
    const content = midTurn.message.content;
    assert.equal(typeof content, 'string');
    assert.match(content, /^second\n\n<files_input>\n/);
    assert.ok(content.includes(`1. ${BUILD_LOG.path} (original name: build.log)`), content);
    assert.equal(content.replace(/^second/, ''), newTurn.message.content.replace(/^first/, ''));

    // The live bubble shows the file before the transcript reload replaces it.
    assert.equal(echo?.content, 'second');
    assert.deepEqual(echo?.files?.map((file: any) => file.path), [BUILD_LOG.path]);
  } finally {
    await abortClaudeSDKSession(sessionId);
    __setClaudeQueryImpl(null);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a picture and a file sent mid-turn: the picture is read from the project, the file is listed for the agent', { timeout: 15000 }, async () => {
  const sessionId = 'claude-midturn-picture-and-file';
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-midturn-project-'));
  const pictureBytes = Buffer.from('not really a png');
  await writeFile(path.join(cwd, 'shot.png'), pictureBytes);
  const picture = { path: 'shot.png', name: 'shot.png', mimeType: 'image/png' };
  try {
    const { midTurn, echo } = await sendMidTurn(sessionId, cwd, {}, { images: [picture], files: [BUILD_LOG] });

    const content = midTurn.message.content;
    assert.ok(Array.isArray(content), 'a message with a picture is a content list');
    assert.equal(content.length, 2);
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text, /^second\n\n<files_input>\n/);
    assert.ok(content[0].text.includes(BUILD_LOG.path));
    // A project-relative picture resolves against the session's project.
    assert.deepEqual(content[1], {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: pictureBytes.toString('base64') },
    });

    assert.deepEqual(echo?.images?.map((image: any) => image.path), ['shot.png']);
    assert.deepEqual(echo?.files?.map((file: any) => file.path), [BUILD_LOG.path]);
  } finally {
    await abortClaudeSDKSession(sessionId);
    __setClaudeQueryImpl(null);
    await rm(cwd, { recursive: true, force: true });
  }
});
