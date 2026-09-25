import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import type { WebSocket } from 'ws';

import { sessionsDb, userDb } from '@/modules/database/index.js';
import { sessionCapabilityExpiry, sideCapabilityExpiry } from '@/modules/session-capabilities/index.js';
import { sessionsService, permissionPreferencesService } from '@/modules/providers/index.js';
import { nativeModelOptions, nativePermissionOptions, setNativePermissionSelection, setNativeSelection, resolveNativeAttachments } from '@/modules/native-control/index.js';
import { isImageAttachmentDescriptor } from '@/shared/index.js';
import { voiceService } from '@/modules/voice/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/index.js';

import { handleChatConnection } from './chat-websocket.service.js';
import { chatRunRegistry } from './chat-run-registry.service.js';
import { scopeNativeCommand } from './native-chat-policy.service.js';
import { nativeBackgroundSnapshot } from './native-background.service.js';
import { NativeCapabilityLease } from './native-capability-lease.service.js';
import { sendNativeHistory } from './native-history-transport.service.js';
import { buildSideExcerpt, SIDE_EXCERPT_MAX_MESSAGES } from './native-side-excerpt.service.js';
import { nativeHistoryWithReceipts, retainNativeSend } from './native-send-journal.service.js';

const epoch = randomUUID();

/** An error the phone acts on by code rather than by reading the message. */
class NativeChatError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

/** Frames a native side question may send (FEAT-SESSION-030). */
const SIDE_ALLOWED = new Set(['native.history', 'native.background', 'native.options', 'chat.subscribe', 'chat.send', 'chat.abort']);

/**
 * First side send for a provider that cannot fork: prefix the parent's recent
 * visible messages. Claude forks the parent instead (see the runtime policy in
 * chat-websocket), so it gets no excerpt. A parent that turned private, or
 * one with no conversation yet, contributes nothing.
 */
async function withParentExcerpt(sessionId: string, provider: string, content: string): Promise<string> {
  if (provider === 'claude') return content;
  const parentId = sessionsDb.getSideParent(sessionId);
  const parent = parentId ? sessionsDb.getSessionById(parentId) : null;
  if (!parent || parent.is_private !== 0 || !parent.provider_session_id) return content;
  try {
    const page = await sessionsService.fetchHistory(parent.session_id, { limit: SIDE_EXCERPT_MAX_MESSAGES * 3, offset: 0 });
    const excerpt = buildSideExcerpt(page.messages as { kind?: unknown; role?: unknown; content?: unknown }[], parent.jsonl_path);
    return excerpt ? `${excerpt}\n${content}` : content;
  } catch {
    return content;
  }
}

/** Called only by the websocket composition root for /native-chat/<id>. Reuses
 * the runtime behind a socket facade that filters all global broadcasts. */
export function handleNativeChat(ws: WebSocket, request: AuthenticatedWebSocketRequest,
  dependencies: Parameters<typeof handleChatConnection>[2]): void {
  const sessionId = new URL(request.url ?? '/', 'http://localhost').pathname.slice('/native-chat/'.length);
  const user = userDb.getSingleActiveUser();
  const credential = request.headers['x-vibespace-session-capability'];
  // A native side question (FEAT-SESSION-030) is reachable only under its own
  // send-only credential; an owner capability never opens it and it never
  // opens anything else. The row decides which grammar applies.
  const initial = sessionsDb.getSessionById(sessionId);
  const side = initial?.is_side === 1;
  const verify = (value: unknown) => side ? sideCapabilityExpiry(sessionId, value) : sessionCapabilityExpiry(sessionId, value);
  const expires = verify(credential);
  if (!user || request.headers.origin || expires === null) {
    ws.close(4403, 'Native chat authentication failed'); return;
  }
  const row = sessionsDb.getSessionById(sessionId);
  if (!row || row.is_private !== 0 || row.is_side !== (side ? 1 : 0)) { ws.close(4404, 'Session no longer exists'); return; }
  const lease = new NativeCapabilityLease(credential, expires, value => {
    const current = sessionsDb.getSessionById(sessionId);
    return current && current.is_private === 0 && current.is_side === (side ? 1 : 0) && userDb.getSingleActiveUser()
      ? verify(value) : null;
  }, () => ws.close(1012, 'Session authorization expired; reconnect'));
  ws.on('close', () => lease.stop());
  const send = (payload: Record<string, unknown>) => {
    if (lease.active() && ws.readyState === 1 && ws.bufferedAmount < 12 * 1024 * 1024) ws.send(JSON.stringify({ ...payload, sessionId }));
  };
  const facade = new EventEmitter() as EventEmitter & { readyState: number; send: (raw: string) => void };
  const pendingSends = new Map<string, { content: string; options: { images?: unknown[]; files?: unknown[] } }>();
  Object.defineProperty(facade, 'readyState', { get: () => ws.readyState });
  facade.send = raw => {
    try {
      const event = JSON.parse(raw);
      if (event.sessionId !== sessionId && !(event.kind === 'protocol_error' && !event.sessionId)) return;
      if (event.kind === 'send_ack') {
        const pending = pendingSends.get(event.clientMsgId);
        if (pending) {
          if (!sessionsDb.getSessionById(sessionId)?.provider_session_id) {
            retainNativeSend(sessionId, event.clientMsgId, pending.content, pending.options);
          }
          pendingSends.delete(event.clientMsgId);
        }
      }
      send({ ...event, nativeRunId: chatRunRegistry.getRun(sessionId)?.startedAt ?? null });
    } catch { /* Non-JSON/global frames are outside the scoped protocol. */ }
  };
  request.user = { id: user.id, userId: user.id, username: user.username };
  handleChatConnection(facade as unknown as WebSocket, request, dependencies);
  const runState = () => {
    const run = chatRunRegistry.getRun(sessionId);
    return `${run?.startedAt ?? ''}:${run?.status ?? ''}`;
  };
  let lastRunState = runState();
  // An idle native viewer also needs to discover a turn started in the browser.
  // Consult only the in-memory run registry; history is fetched on changes.
  const stateTimer = setInterval(() => {
    const next = runState();
    if (next !== lastRunState) { lastRunState = next; send({ kind: 'native.session-state' }); }
  }, 1000);
  stateTimer.unref();
  ws.on('close', () => { clearInterval(stateTimer); facade.emit('close'); });
  let historyBusy = false;
  let voiceBusy = false;
  ws.on('message', async raw => {
    let requestId: unknown;
    try {
      if (!lease.active()) return;
      if (raw.toString().length > 6 * 1024 * 1024) throw new Error('Payload too large');
      const data = JSON.parse(raw.toString());
      if (data.type === 'native.renew') { if (!side) lease.renew(data.capability); return; }
      requestId = typeof data.requestId === 'string' ? data.requestId.slice(0, 100) : undefined;
      const current = sessionsDb.getSessionById(sessionId);
      if (!current || current.is_private || current.is_side !== (side ? 1 : 0)) throw new Error('Session no longer exists');
      // Side question: reads of its own session, then send and stop only. No
      // queue, no permission answers, no selection, voice or rewind, and never
      // anything addressed to the parent (scopeNativeCommand pins the id).
      if (side && !SIDE_ALLOWED.has(String(data.type))) {
        throw new NativeChatError('A side question can only send and stop', 'SIDE_SEND_ONLY');
      }
      if (side && data.type === 'chat.send' && (data.rewind !== undefined || (Array.isArray(data.attachments) && data.attachments.length))) {
        throw new NativeChatError('A side question takes text only', 'SIDE_SEND_ONLY');
      }
      if (data.type === 'native.history') {
        if (historyBusy) throw new Error('History is already loading');
        const limit = Math.min(100, Math.max(1, Number(data.limit) || 50));
        const offset = Math.min(1_000_000, Math.max(0, Number(data.offset) || 0));
        if (!Number.isInteger(limit) || !Number.isInteger(offset)) throw new Error('Invalid page');
        historyBusy = true;
        try {
          const page = nativeHistoryWithReceipts(sessionId, await sessionsService.fetchHistory(sessionId, { limit, offset }));
          const run = chatRunRegistry.getRun(sessionId);
          await sendNativeHistory(ws, { kind: 'native.history', sessionId, requestId, ...page, runId: run?.startedAt ?? null,
            running: run?.status === 'running', archived: Boolean(current.isArchived),
            replay: run?.status === 'running' ? chatRunRegistry.replayEvents(sessionId, 0) : [] }, data.chunked === true, () => lease.active());
        } finally { historyBusy = false; }
        return;
      }
      if (data.type === 'native.background') {
        send({ requestId, ...nativeBackgroundSnapshot(sessionId, current) });
        return;
      }
      if (data.type === 'native.transcribe') {
        if (voiceBusy) throw new Error('Transcription is already running');
        if (typeof data.audio !== 'string' || data.audio.length > 5_600_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.audio)) throw new Error('Invalid audio');
        const bytes = Buffer.from(data.audio, 'base64');
        if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('Recording exceeds 4 MiB');
        voiceBusy = true;
        try {
          const result = await voiceService.transcribe({ userId: user.id, audio: { bytes, mimeType: 'audio/mp4', fileName: 'recording.m4a' } });
          if (!result.ok) throw new Error(result.error);
          send({ kind: 'native.transcript', requestId, ...result.value });
        } finally { voiceBusy = false; }
        return;
      }
      if (data.type === 'native.options' || data.type === 'native.select') {
        if (data.type === 'native.select') {
          // These values are read when a provider run starts. Persisting a new
          // selection during the current run therefore changes only the next
          // turn — exactly what Stop followed by a continuation needs.
          // Store permissions before the asynchronous model-catalog lookup so
          // a Stop/send frame arriving directly behind this one cannot start
          // with the old mode. The two selections are independent validated
          // settings, so a later model error must not roll the permission back.
          if (data.permissionMode !== undefined) setNativePermissionSelection(sessionId, data.permissionMode);
          await setNativeSelection(sessionId, data.model, data.effort || '');
        }
        const latest = sessionsDb.getSessionById(sessionId)!;
        const provider = latest.provider as Parameters<typeof nativeModelOptions>[0];
        send({ kind: 'native.options', requestId, ...await nativeModelOptions(provider), model: latest.model, effort: latest.effort, ...nativePermissionOptions(provider, sessionId) });
        return;
      }
      const command = scopeNativeCommand(data, sessionId);
      if (current.isArchived && command.type !== 'chat.subscribe') throw new Error('Session is archived; reopen it in VibeSpace');
      if (command.type === 'chat.permission-response') {
        const pending = dependencies.runtime.getPendingApprovalsForSession(sessionId);
        const approval = pending.find(p => p !== null && typeof p === 'object' && 'requestId' in p && p.requestId === command.requestId) as { toolName?: string; input?: { questions?: { question: string }[] } } | undefined;
        if (!approval) throw new NativeChatError('Permission request is no longer pending in this session', 'PERMISSION_NOT_PENDING');
        if (data.answers !== undefined) {
          if (approval.toolName !== 'AskUserQuestion' || !data.answers || typeof data.answers !== 'object' || Array.isArray(data.answers)) throw new Error('This permission does not accept question answers');
          const questions = approval.input?.questions;
          if (!Array.isArray(questions) || Object.keys(data.answers).some(key => !questions.some(q => q.question === key)) ||
            Object.values(data.answers).some(value => typeof value !== 'string' || value.length > 4000)) throw new Error('Invalid question answers');
          command.updatedInput = { ...approval.input, answers: data.answers };
        }
      }
      if (command.type === 'chat.send' || command.type === 'chat.queue-add') {
        if (command.rewind !== undefined) {
          if (!['claude', 'opencode', 'codex'].includes(current.provider)) throw new Error('This provider does not support rewind');
          if (chatRunRegistry.isProcessing(sessionId) || chatRunRegistry.getQueueForClient(sessionId).length) throw new Error('Stop the response and clear the queue before editing');
        }
        // Preserve descriptors until the shared runtime boundary. Flattening
        // them into <files_input> here discarded MIME information, so a native
        // PNG reached providers and history as a generic downloadable file.
        // A side send with attachments was refused above; the phone still sends
        // `attachments: []`, and the resolver's session guard rejects side rows.
        const attachments = side || data.attachments === undefined
          ? []
          : resolveNativeAttachments(sessionId, data.attachments);
        command.options = {
          ...(command.rewind === undefined ? {} : { rewind: command.rewind }),
          attachments,
          images: attachments.filter(isImageAttachmentDescriptor),
          files: attachments.filter(attachment => !isImageAttachmentDescriptor(attachment)),
          permissionMode: side ? 'plan' : permissionPreferencesService.get(user.id, current.provider, sessionId).permissionMode,
          ...(current.model ? { model: current.model } : {}),
          ...(current.effort ? { reasoningEffort: current.effort, effort: current.effort } : {}),
        };
      }
      if (command.type === 'chat.send' && typeof command.clientMsgId === 'string') {
        pendingSends.set(command.clientMsgId, { content: String(command.content ?? ''), options: command.options as { images?: unknown[]; files?: unknown[] } });
      }
      if (side && command.type === 'chat.send') {
        sessionsDb.touchSideSession(sessionId);
        if (!current.provider_session_id && !chatRunRegistry.isProcessing(sessionId)) {
          command.content = await withParentExcerpt(sessionId, current.provider, String(command.content));
        }
      }
      facade.emit('message', JSON.stringify(command));
    } catch (error) {
      send({ kind: 'native.error', requestId, error: error instanceof Error ? error.message : 'Native chat failed',
        ...(error instanceof NativeChatError ? { code: error.code } : {}) });
    }
  });
  send({ kind: 'native.hello', version: 1, epoch, provider: row.provider, rewind: !side && ['claude', 'opencode', 'codex'].includes(row.provider), ...(side ? { side: true } : {}), archived: Boolean(row.isArchived), voice: voiceService.getHealth() });
}
