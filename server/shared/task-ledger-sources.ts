/**
 * Task ledgers kept outside the agent runtime.
 *
 * The session supervisor normally reads the runtime's own task list (Claude's
 * TaskCreate files, OpenCode's todo table, Codex's plan). A host plugin may
 * keep the session's task list somewhere else instead — and then also takes
 * the runtime's own list away (see `disallowedTools` in agent-env.ts), because
 * a session with two lists finishes one and leaves the other open, and the
 * supervisor can only watch the one it reads.
 *
 * A source answers for one session, synchronously: `null` means "not mine,
 * read the native ledger"; an object — even one with nothing open — REPLACES
 * the native ledger for that session. Sources are consulted in registration
 * order; the first answer wins. A throwing source is logged and skipped.
 */

export type ExternalTaskLedgerItem = {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress';
  /** Parked on the user's answer: open, but a nudge cannot advance it. */
  waitingOnUser: boolean;
  /** When the item was last parked (ms); the Claude supervisor ignores a mark older than the user's last turn. */
  updatedAt: number | null;
};

export type ExternalTaskLedger = {
  /** What the nudge calls the list, e.g. "card plan". */
  listName: string;
  /**
   * How to close, re-scope and park items in this list — the nudge's closing
   * paragraph. It names the tools, since the runtime's own are gone.
   */
  guidance: string;
  open: ExternalTaskLedgerItem[];
  /** A counter that moves whenever the list is written; stall detection compares it. */
  activity: number;
  /** Optional missing-report checkpoint, distinct from open tasks. The turn supervisor repairs it within the per-turn repair budget (BRIEFING_REPAIRS_PER_TURN); never a session failure. */
  completion?: { turnId: string; prompt: string };
  /** Opt-in main-session behavior: reject agent prose, preserving tools and system events. */
  agentTextPolicy?: 'reject';
};

export type TaskLedgerSourceContext = {
  provider: 'claude' | 'codex' | 'opencode' | 'cursor';
  /** The provider-native session id — the one the runtime writes its own ledger under. */
  sessionId: string;
  /** Begin is invoked before tool execution with the exact arriving prompt. Omitted/complete is the existing completion read. */
  phase?: 'begin' | 'complete';
  /** Begin-only transient input: never persisted or logged by the public host. */
  prompt?: string;
  /** Begin-only unique host turn identity, stable through the corresponding completion check. */
  turnId?: string;
  /** Observed entrypoint role, never inferred from transcript or session naming. */
  sessionRole?: 'main' | 'side' | 'helper';
  /** Persisted launch context supplied by the host; plugins own its meaning. */
  launchOptions?: Record<string, unknown> | null;
  private?: boolean;
  ephemeral?: boolean;
};

export type TaskLedgerSource = (context: TaskLedgerSourceContext) => ExternalTaskLedger | null | undefined | void;

const sources = new Set<TaskLedgerSource>();

/** Registers a task-ledger source; returns the unregister function. */
export function registerTaskLedgerSource(source: TaskLedgerSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

function isLedger(value: unknown): value is ExternalTaskLedger {
  const ledger = value as ExternalTaskLedger;
  return Boolean(ledger) && typeof ledger === 'object'
    && typeof ledger.listName === 'string' && typeof ledger.guidance === 'string'
    && Array.isArray(ledger.open);
}

/** The external ledger for this session, or null when the native one applies. */
export function readExternalTaskLedger(context: TaskLedgerSourceContext): ExternalTaskLedger | null {
  if (!context.sessionId) return null;
  for (const source of sources) {
    let answer: unknown;
    try {
      answer = source(context);
    } catch (error) {
      console.warn('[task-ledger] source threw:', error instanceof Error ? error.message : error);
      continue;
    }
    if (answer === null || answer === undefined) continue;
    if (!isLedger(answer)) {
      console.warn('[task-ledger] source returned a malformed ledger — ignored');
      continue;
    }
    const open = answer.open
      .filter((item) => item && (item.status === 'pending' || item.status === 'in_progress'))
      .map((item) => ({
        id: String(item.id),
        subject: typeof item.subject === 'string' && item.subject ? item.subject : '(untitled)',
        status: item.status,
        waitingOnUser: Boolean(item.waitingOnUser),
        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : null,
      }));
    return {
      listName: answer.listName,
      guidance: answer.guidance,
      open,
      activity: Number.isFinite(answer.activity) ? answer.activity : 0,
      ...(answer.agentTextPolicy === 'reject' ? { agentTextPolicy: 'reject' as const } : {}),
      ...(answer.completion && typeof answer.completion.turnId === 'string' && answer.completion.turnId.trim()
        && answer.completion.turnId.length <= 200 && typeof answer.completion.prompt === 'string'
        && answer.completion.prompt.trim() && answer.completion.prompt.length <= 4000
        ? { completion: { turnId: answer.completion.turnId, prompt: answer.completion.prompt } } : {}),
    };
  }
  return null;
}
