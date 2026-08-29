import { randomBytes } from 'node:crypto';
import fsSync from 'node:fs';

import Database from 'better-sqlite3';

import { appendImagesInputTag } from '../shared/image-attachments.js';
import { getOpenCodeDatabasePath } from '../shared/utils.js';

/**
 * Writes a turn that ran over the HTTP server into opencode.db.
 *
 * `opencode run` records every exchange in that database; the standalone server
 * does not — it creates the session row and keeps the conversation to itself.
 * Nothing else reads the server's copy: the sidebar, the transcript view and
 * `opencode run --session` all read opencode.db, so a turn left unwritten is a
 * turn that answers the user once and is gone by the next page load, in a
 * conversation the CLI then continues with no memory of it.
 *
 * The rows mirror what the CLI writes for the same exchange, so a session stays
 * readable and resumable no matter which transport produced which message.
 * Deleting from these same tables is already how session removal and rewind
 * work, so this is the existing relationship with the store, not a new one.
 */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateId(prefix) {
  const bytes = randomBytes(24);
  let id = '';
  for (const byte of bytes) {
    id += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return `${prefix}_${id}`;
}

/**
 * Appends one turn to a session's history, including user messages steered
 * into the agent loop before its final answer.
 *
 * Best effort by design: the answer has already been streamed to the user and
 * is not worth losing to a locked database, so a failure is logged and the turn
 * carries on.
 */
export function persistOpenCodeTurn(turn) {
  const {
    sessionId,
    cwd,
    providerId,
    modelId,
    agent = 'build',
    promptText,
    images,
    injectedMessages = [],
    assistantMessageId,
    text,
    tools = [],
    tokens,
    finish = 'stop',
    startedAt,
    endedAt,
  } = turn ?? {};
  const databasePath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(databasePath)) {
    return;
  }

  let db = null;
  try {
    db = new Database(databasePath, { fileMustExist: true });
    // The store is shared with every other opencode process on the machine, so
    // a short wait beats failing the write outright.
    db.pragma('busy_timeout = 5000');

    const created = startedAt ?? Date.now();
    // The transcript is ordered by `(time_created, id)`, and ids are random, so
    // a turn that starts and finishes inside the same millisecond can be read
    // back with the answer above the question. One millisecond of separation is
    // what keeps the pair in the order it happened.
    const lastInjectedAt = injectedMessages.reduce(
      (latest, message) => Math.max(latest, Number(message?.createdAt) || 0),
      created,
    );
    const completed = Math.max(endedAt ?? Date.now(), lastInjectedAt + 1);
    const userMessageId = generateId('msg');
    const assistantId = assistantMessageId ?? generateId('msg');
    const usage = tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    const total = Number(usage.input || 0)
      + Number(usage.output || 0)
      + Number(usage.reasoning || 0)
      + Number(usage.cache?.read || 0)
      + Number(usage.cache?.write || 0);

    const insertMessage = db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
    );
    const insertPart = db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
    );

    db.transaction(() => {
      insertMessage.run(userMessageId, sessionId, created, created, JSON.stringify({
        role: 'user',
        time: { created },
        agent,
        model: { providerID: providerId, modelID: modelId },
        summary: { diffs: [] },
      }));

      // Attachments are recorded in the prompt text the way the CLI records
      // them, because that `<images_input>` block is what the transcript reader
      // turns back into the thumbnails under the user's message.
      insertPart.run(generateId('prt'), userMessageId, sessionId, created, created, JSON.stringify({
        type: 'text',
        text: appendImagesInputTag(promptText ?? '', images),
      }));

      let parentMessageId = userMessageId;
      for (const injected of injectedMessages) {
        const injectedAt = Math.max(Number(injected?.createdAt) || created, created);
        const injectedMessageId = generateId('msg');
        insertMessage.run(injectedMessageId, sessionId, injectedAt, injectedAt, JSON.stringify({
          role: 'user',
          time: { created: injectedAt },
          agent,
          model: { providerID: providerId, modelID: modelId },
          summary: { diffs: [] },
        }));
        insertPart.run(generateId('prt'), injectedMessageId, sessionId, injectedAt, injectedAt, JSON.stringify({
          type: 'text',
          text: appendImagesInputTag(injected?.promptText ?? '', injected?.images),
        }));
        parentMessageId = injectedMessageId;
      }

      insertMessage.run(assistantId, sessionId, completed, completed, JSON.stringify({
        parentID: parentMessageId,
        role: 'assistant',
        mode: agent,
        agent,
        path: { cwd, root: '/' },
        cost: 0,
        tokens: {
          total,
          input: Number(usage.input || 0),
          output: Number(usage.output || 0),
          reasoning: Number(usage.reasoning || 0),
          cache: { write: Number(usage.cache?.write || 0), read: Number(usage.cache?.read || 0) },
        },
        modelID: modelId,
        providerID: providerId,
        time: { created, completed },
        finish,
      }));

      let partTime = completed;
      const nextPartTime = () => (partTime += 1);

      insertPart.run(generateId('prt'), assistantId, sessionId, nextPartTime(), partTime, JSON.stringify({
        type: 'step-start',
      }));

      for (const tool of tools) {
        insertPart.run(generateId('prt'), assistantId, sessionId, nextPartTime(), partTime, JSON.stringify({
          type: 'tool',
          tool: tool.name,
          callID: tool.callId,
          state: {
            status: tool.isError ? 'error' : 'completed',
            input: tool.input ?? {},
            ...(tool.isError ? { error: tool.output } : { output: tool.output }),
          },
        }));
      }

      if (text && text.trim()) {
        insertPart.run(generateId('prt'), assistantId, sessionId, nextPartTime(), partTime, JSON.stringify({
          type: 'text',
          text,
          time: { start: created, end: completed },
        }));
      }

      insertPart.run(generateId('prt'), assistantId, sessionId, nextPartTime(), partTime, JSON.stringify({
        type: 'step-finish',
        reason: finish,
        cost: 0,
        tokens: {
          total,
          input: Number(usage.input || 0),
          output: Number(usage.output || 0),
          reasoning: Number(usage.reasoning || 0),
          cache: { write: Number(usage.cache?.write || 0), read: Number(usage.cache?.read || 0) },
        },
      }));
    })();
  } catch (error) {
    console.warn('[OpenCode] Could not record the turn in opencode.db:', error?.message || error);
  } finally {
    db?.close();
  }
}
