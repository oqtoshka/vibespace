import { sessionsDb } from '@/modules/database/index.js';
import type { ProviderPermissionDecision } from '@/shared/index.js';

type Question = { question: string; header?: string; options: { label: string; description?: string }[]; multiple?: boolean };
type Request = { id: string; sessionID: string; questions: Question[] };
type Pending = { sessionId: string; event: Record<string, unknown>; resolve: (decision: ProviderPermissionDecision) => Promise<void> };
const pending = new Map<string, Pending>();

/** The HTTP runner publishes OpenCode questions through the same prompt channel
 * consumed by web/native chat. The provider dispatcher routes answers and replays
 * outstanding prompts on reconnect, including app-to-provider session id mapping. */
export const opencodeQuestions = {
  list(sessionId: string) {
    if (pending.size === 0) return [];
    const providerId = sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId;
    return [...pending.values()].filter(item => item.sessionId === providerId).map(item => item.event);
  },
  resolve(requestId: string, decision: ProviderPermissionDecision) {
    void pending.get(requestId)?.resolve(decision);
  },
  bind(sessionId: string, emit: (event: Record<string, unknown>) => void,
    reply: (id: string, answers: string[][] | null) => Promise<unknown>) {
    const owned = new Set<string>();
    const remove = (id: string) => {
      const key = `opencode-question-${id}`;
      if (!owned.delete(key)) return;
      pending.delete(key);
      emit({ kind: 'permission_cancelled', requestId: key, sessionId, provider: 'opencode' });
    };
    return {
      request(request: Request) {
        if (request.sessionID !== sessionId || !request.id || !Array.isArray(request.questions)) return;
        const requestId = `opencode-question-${request.id}`;
        if (pending.has(requestId)) return;
        const event = { kind: 'permission_request', requestId, sessionId, provider: 'opencode', toolName: 'AskUserQuestion',
          input: { questions: request.questions.map(q => ({ ...q, multiSelect: q.multiple === true })) } };
        let sending = false;
        owned.add(requestId);
        pending.set(requestId, { sessionId, event, resolve: async decision => {
          if (sending) return;
          sending = true;
          const input = decision.updatedInput as { answers?: Record<string, unknown> } | undefined;
          const answers = request.questions.map(q => {
            const answer = input?.answers?.[q.question];
            if (typeof answer !== 'string' || !answer) return [];
            // The shared question panel joins multiple selections with comma-space.
            return q.multiple ? answer.split(', ') : [answer];
          });
          try {
            await reply(request.id, decision.allow ? answers : null);
            remove(request.id);
          } catch (error) {
            sending = false;
            emit({ kind: 'error', sessionId, provider: 'opencode', content: `Could not send answer: ${error instanceof Error ? error.message : String(error)}` });
            emit(event); // Keep the question answerable after a failed request.
          }
        } });
        emit(event);
      },
      remove,
      close() { for (const key of [...owned]) remove(key.slice('opencode-question-'.length)); },
    };
  },
};
