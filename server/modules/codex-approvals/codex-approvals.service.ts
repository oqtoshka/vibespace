import { randomUUID } from 'node:crypto';

type Decision = { allow: boolean; updatedInput?: unknown };
type Binding = { sessionId: string; emit: (event: Record<string, unknown>) => void };
type Entry = { threadId: string; sessionId: string; event: Record<string, unknown>; answer: (decision: Decision) => void };
const bindings = new Map<string, Binding>();
const pending = new Map<string, Entry>();

/** Codex app-server and the provider dispatcher share pending human approvals.
 * No decision changes a session's permission mode or grants future approvals. */
export const codexApprovals = {
  bind(threadId: string, sessionId: string, emit: Binding['emit']) {
    const binding = { sessionId, emit }; bindings.set(threadId, binding);
    return () => {
      if (bindings.get(threadId) !== binding) return;
      bindings.delete(threadId);
      for (const item of [...pending.values()]) if (item.threadId === threadId) item.answer({ allow: false });
    };
  },
  list(sessionId: string) { return [...pending.values()].filter(item => item.sessionId === sessionId || item.threadId === sessionId).map(item => item.event); },
  resolve(id: string, decision: Decision) { pending.get(id)?.answer(decision); },
  request(threadId: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> | null {
    const binding = bindings.get(threadId);
    const question = method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput';
    if (!binding || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput'].includes(method)) return null;
    const questions = question && Array.isArray(params.questions) ? params.questions as { id: string; question: string; header?: string; options?: unknown }[] : [];
    const requestId = 'codex-' + randomUUID();
    const input = question ? { questions: questions.map(q => ({ question: q.question, header: q.header, options: q.options, multiSelect: false })) } : params;
    const event = { kind: 'permission_request', requestId, sessionId: binding.sessionId,
      toolName: question ? 'AskUserQuestion' : method.includes('commandExecution') ? 'Bash' : 'Edit files', input };
    return new Promise(resolve => {
      const timer = setTimeout(() => answer({ allow: false }), 10 * 60_000); timer.unref();
      const answer = (decision: Decision) => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        let result: Record<string, unknown> = { decision: decision.allow ? 'accept' : 'decline' };
        if (question) {
          const raw = decision.updatedInput as { answers?: Record<string, unknown> } | undefined;
          const answers: Record<string, { answers: string[] }> = {};
          if (decision.allow) for (const q of questions) {
            const value = raw?.answers?.[q.question];
            if (typeof value === 'string') answers[q.id] = { answers: [value] };
          }
          result = { answers };
        }
        resolve(result);
        binding.emit({ kind: 'permission_cancelled', requestId, sessionId: binding.sessionId });
      };
      pending.set(requestId, { threadId, sessionId: binding.sessionId, event, answer });
      binding.emit(event);
    });
  },
};
