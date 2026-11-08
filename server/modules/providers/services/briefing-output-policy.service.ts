import { randomUUID } from 'node:crypto';

import { collectAgentLaunchExtras, createNormalizedMessage, readExternalTaskLedger } from '../../../shared/index.js';

type Provider = 'claude' | 'opencode' | 'cursor';
type State = { admitted: boolean; repairs: number; violation: boolean; completedTurnId?: string };
type Options = { ephemeral?: boolean; backgroundHelper?: boolean; sideSession?: unknown; appSessionId?: string | null; sessionId?: string | null; launchOptions?: Record<string, unknown> | null; private?: boolean };
/**
 * Repair turns one briefing turn may receive. A violation never ends the
 * session: past this cap the rejected text is dropped, the turn settles idle
 * and the next turn starts with a fresh budget. The cap only stops a model that
 * keeps writing prose from burning tokens in a loop inside a single turn.
 */
export const BRIEFING_REPAIRS_PER_TURN = 3;
export const BRIEFING_REPAIR_PROMPT = '[session supervisor] Session behavior invariant violated: plain assistant text is not shown in this main briefing session (commentary, acknowledgements, final answers, even after a card reply). Use only the existing card tools for every operator-facing answer and reply in all requested threads. Continue authorized work through tools. The card is the visible output, including when a harness reminder asks for an update. Once reporting is current, end the turn silently; the host accepts that completion. On unchanged status/state, yield unless work remains. Do not repeat a card call merely to end a turn. This ends the turn, never the session. Do not acknowledge this message in text.';
/**
 * Longest closing line a final-line harness may end a briefing turn with. One
 * line of this size is a sign-off, not a report, and is never shown in chat.
 */
export const BRIEFING_FINAL_LINE_MAX = 200;
/**
 * Harnesses whose turn ends only when the model answers without a tool call
 * (OpenCode's run loop). Forbidding every final text there left a model that
 * had finished its work no way to stop: it called a no-op tool after each
 * reasoning step instead (90+ steps, 2026-11-08). For these providers one short
 * final line, or an empty answer, after the last tool call is the accepted end.
 */
const FINAL_LINE_PROVIDERS: ReadonlySet<Provider> = new Set(['opencode']);
/** Appended to the repair prompt on final-line harnesses, so the repair names the one way out. */
export const BRIEFING_FINAL_LINE_RULE = `On this harness a turn ends only on an answer without tool calls: once reporting is current, end with one short final line (one line, at most ${BRIEFING_FINAL_LINE_MAX} characters) or an empty answer, and make no further tool call. Never call a no-op tool such as \`true\` to end the turn.`;

/** One line, at most BRIEFING_FINAL_LINE_MAX characters, after trimming. */
function isShortFinalLine(text: string) {
  const line = text.trim();
  return line.length <= BRIEFING_FINAL_LINE_MAX && !/[\r\n]/.test(line);
}

/** Claude and OpenCode/Cursor transports gate normalized output before any writer fan-out. */
export class BriefingOutputPolicy {
  private sessionId = '';
  private prompt = '';
  private turnId = '';
  /** Withheld text since this run's last tool call; judged at completion on final-line harnesses. */
  private finalText = '';
  private refreshAdmission() {
    if (!this.sessionId || !this.turnId) return;
    const ledger = readExternalTaskLedger({ provider: this.provider, sessionId: this.sessionId, phase: 'begin', prompt: this.prompt, turnId: this.turnId, sessionRole: this.role, ...this.launchContext });
    if (this.role === 'main' && ledger?.agentTextPolicy === 'reject') this.state.admitted = true;
  }
  private readonly role: 'main' | 'side' | 'helper';
  readonly state: State;
  private readonly launchContext: { launchOptions: Record<string, unknown> | null; private: boolean; ephemeral: boolean };
  constructor(private readonly provider: Provider, options: Options, state?: State) {
    this.role = options.ephemeral || options.backgroundHelper ? 'helper' : options.sideSession ? 'side' : 'main';
    this.state = state ?? { admitted: false, repairs: 0, violation: false };
    this.launchContext = { launchOptions: options.launchOptions ?? null, private: Boolean(options.private), ephemeral: this.role === 'helper' };
    const extras = collectAgentLaunchExtras({ provider, scope: 'session', sessionId: options.appSessionId ?? options.sessionId ?? null, sessionRole: this.role, ...this.launchContext });
    if (this.role === 'main' && extras.agentTextPolicy === 'reject') this.state.admitted = true;
  }
  begin(sessionId: string | null | undefined, prompt: string, newHuman = false) {
    // Capture the human turn before native identity exists; bind the native id
    // when the transport learns it without inventing a reporter session.
    if (sessionId) this.sessionId = sessionId;
    if (newHuman || this.prompt !== prompt || !this.turnId) {
      this.prompt = prompt;
      this.turnId = randomUUID();
      delete this.state.completedTurnId;
    }
    this.refreshAdmission();
  }
  accepts(message: { kind?: string; role?: string; content?: unknown }) {
    // Hooks may publish the briefing sidecar after the initial start. Re-read the
    // same transient begin identity before output, without resetting repair budget.
    if (!this.state.admitted) this.refreshAdmission();
    if (this.role !== 'main' || !this.state.admitted || message.role === 'user') return true;
    const finalLine = FINAL_LINE_PROVIDERS.has(this.provider);
    if (finalLine && message.kind === 'tool_use') {
      // Text followed by another tool call was commentary, not the closing line.
      if (this.finalText.trim()) this.state.violation = true;
      this.finalText = '';
    }
    if (!['text', 'stream_delta'].includes(message.kind ?? '')) return true;
    if (finalLine) this.finalText += String(message.content ?? '');
    if (!String(message.content ?? '').trim().length) return true;
    if (!finalLine) this.state.violation = true;
    return false;
  }
  get active() {
    if (!this.state.admitted) this.refreshAdmission();
    return this.role === 'main' && this.state.admitted;
  }
  complete(successful = true): { prompt?: string; exhausted?: string } {
    if (this.role !== 'main') return {};
    // The closing text of a final-line harness: one short line passes, anything longer is prose.
    if (this.finalText.trim() && !isShortFinalLine(this.finalText)) this.state.violation = true;
    this.finalText = '';
    if (!successful) {
      delete this.state.completedTurnId;
      return {};
    }
    const ledger = this.sessionId ? readExternalTaskLedger({ provider: this.provider, sessionId: this.sessionId, phase: 'complete', turnId: this.turnId, sessionRole: this.role, ...this.launchContext }) : null;
    if (!this.state.violation && ledger?.turnComplete) {
      this.state.completedTurnId = ledger.turnComplete.turnId;
      return {};
    }
    if (!this.state.violation && !ledger?.completion && (!this.state.admitted || ledger)) return {};
    this.state.violation = false;
    if (this.state.repairs < BRIEFING_REPAIRS_PER_TURN) {
      this.state.repairs += 1;
      const repair = BRIEFING_REPAIR_PROMPT + (FINAL_LINE_PROVIDERS.has(this.provider) ? ' ' + BRIEFING_FINAL_LINE_RULE : '');
      return { prompt: this.active ? repair + (ledger?.completion ? '\n' + ledger.completion.prompt : '') : ledger?.completion?.prompt };
    }
    // Never a session failure: the text was already withheld; settle idle.
    const exhausted = `Briefing reporting policy: ${BRIEFING_REPAIRS_PER_TURN} repair turns used this turn; further assistant text was dropped and the turn ends idle. The session stays open.`;
    console.warn(`[briefing policy] ${this.provider} session ${this.sessionId || '(unbound)'}: repair budget (${BRIEFING_REPAIRS_PER_TURN}) exhausted — text dropped, turn settles idle`);
    return { exhausted };
  }
  /** A new turn (human or server-started) gets a fresh repair budget; a steer inside a turn does not. */
  resetRepairs() {
    this.state.repairs = 0;
    this.state.violation = false;
  }
  noticeMessage(notice: string) {
    return createNormalizedMessage({ kind: 'status', text: 'agent_text_policy_exhausted', content: notice, sessionId: this.sessionId, provider: this.provider });
  }
  failureMessage(failure: string) {
    return createNormalizedMessage({ kind: 'error', content: failure, sessionId: this.sessionId, provider: this.provider });
  }
}
