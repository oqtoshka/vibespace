import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { appConfigDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { sessionsService, permissionPreferencesService } from '@/modules/providers/index.js';
import { nativeModelOptions, setNativeSelection, resolveNativeAttachments } from '@/modules/native-control/index.js';
import { appendFilesInputTag } from '@/shared/index.js';
import { voiceService } from '@/modules/voice/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/index.js';
import { handleChatConnection } from './chat-websocket.service.js';
import { chatRunRegistry } from './chat-run-registry.service.js';
import { scopeNativeCommand, validNativeCapability } from './native-chat-policy.service.js';

const epoch = randomUUID();

/** Called only by the websocket composition root for /native-chat/<id>. Reuses
 * the runtime behind a socket facade that filters all global broadcasts. */
export function handleNativeChat(ws: WebSocket, request: AuthenticatedWebSocketRequest,
  dependencies: Parameters<typeof handleChatConnection>[2]): void {
  const sessionId = new URL(request.url ?? '/', 'http://localhost').pathname.slice('/native-chat/'.length);
  const user = userDb.getSingleActiveUser();
  if (!user || request.headers.origin || !validNativeCapability(sessionId,
    request.headers['x-vibespace-session-capability'], appConfigDb.getOrCreateJwtSecret())) {
    ws.close(4403, 'Native chat authentication failed'); return;
  }
  const row = sessionsDb.getSessionById(sessionId);
  if (!row || row.is_private || row.is_side) { ws.close(4404, 'Session no longer exists'); return; }
  const send = (payload: Record<string, unknown>) => {
    if (ws.readyState === 1 && ws.bufferedAmount < 12 * 1024 * 1024) ws.send(JSON.stringify({ ...payload, sessionId }));
  };
  const facade = new EventEmitter() as EventEmitter & { readyState: number; send: (raw: string) => void };
  Object.defineProperty(facade, 'readyState', { get: () => ws.readyState });
  facade.send = raw => {
    try {
      const event = JSON.parse(raw);
      if (event.sessionId !== sessionId && !(event.kind === 'protocol_error' && !event.sessionId)) return;
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
      if (raw.toString().length > 6 * 1024 * 1024) throw new Error('Payload too large');
      const data = JSON.parse(raw.toString());
      requestId = typeof data.requestId === 'string' ? data.requestId.slice(0, 100) : undefined;
      const current = sessionsDb.getSessionById(sessionId);
      if (!current || current.is_private || current.is_side) throw new Error('Session no longer exists');
      if (data.type === 'native.history') {
        if (historyBusy) throw new Error('History is already loading');
        const limit = Math.min(100, Math.max(1, Number(data.limit) || 50));
        const offset = Math.min(1_000_000, Math.max(0, Number(data.offset) || 0));
        if (!Number.isInteger(limit) || !Number.isInteger(offset)) throw new Error('Invalid page');
        historyBusy = true;
        try {
          const page = await sessionsService.fetchHistory(sessionId, { limit, offset });
          const run = chatRunRegistry.getRun(sessionId);
          send({ kind: 'native.history', requestId, ...page, runId: run?.startedAt ?? null,
            running: run?.status === 'running', archived: Boolean(current.isArchived),
            replay: run?.status === 'running' ? chatRunRegistry.replayEvents(sessionId, 0) : [] });
        } finally { historyBusy = false; }
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
          if (chatRunRegistry.isProcessing(sessionId)) throw new Error('Change the model after the current response finishes');
          await setNativeSelection(sessionId, data.model, data.effort || '');
        }
        const latest = sessionsDb.getSessionById(sessionId)!;
        send({ kind: 'native.options', requestId, ...await nativeModelOptions(latest.provider as Parameters<typeof nativeModelOptions>[0]), model: latest.model, effort: latest.effort, ...permissionPreferencesService.get(user.id, latest.provider, sessionId) });
        return;
      }
      const command = scopeNativeCommand(data, sessionId);
      if (current.isArchived && command.type !== 'chat.subscribe') throw new Error('Session is archived; reopen it in VibeSpace');
      if (command.type === 'chat.permission-response') {
        const pending = dependencies.runtime.getPendingApprovalsForSession(sessionId);
        const approval = pending.find(p => p !== null && typeof p === 'object' && 'requestId' in p && p.requestId === command.requestId) as { toolName?: string; input?: { questions?: { question: string }[] } } | undefined;
        if (!approval) throw new Error('Permission request is no longer pending in this session');
        if (data.answers !== undefined) {
          if (approval.toolName !== 'AskUserQuestion' || !data.answers || typeof data.answers !== 'object' || Array.isArray(data.answers)) throw new Error('This permission does not accept question answers');
          const questions = approval.input?.questions;
          if (!Array.isArray(questions) || Object.keys(data.answers).some(key => !questions.some(q => q.question === key)) ||
            Object.values(data.answers).some(value => typeof value !== 'string' || value.length > 4000)) throw new Error('Invalid question answers');
          command.updatedInput = { ...approval.input, answers: data.answers };
        }
      }
      if (command.type === 'chat.send' || command.type === 'chat.queue-add') {
        if (data.attachments !== undefined) command.content = appendFilesInputTag(String(command.content), resolveNativeAttachments(sessionId, data.attachments));
        command.options = {
        permissionMode: permissionPreferencesService.get(user.id, current.provider, sessionId).permissionMode,
        ...(current.model ? { model: current.model } : {}), ...(current.effort ? { reasoningEffort: current.effort, effort: current.effort } : {}),
      };
      }
      facade.emit('message', JSON.stringify(command));
    } catch (error) { send({ kind: 'native.error', requestId, error: error instanceof Error ? error.message : 'Native chat failed' }); }
  });
  send({ kind: 'native.hello', version: 1, epoch, provider: row.provider, archived: Boolean(row.isArchived), voice: voiceService.getHealth() });
}
