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

/** Claude and OpenCode/Cursor transports gate normalized output before any writer fan-out. */
export class BriefingOutputPolicy {
  private sessionId = '';
  private prompt = '';
  private turnId = '';
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
    if (!['text', 'stream_delta'].includes(message.kind ?? '') || !String(message.content ?? '').trim().length) return true;
    this.state.violation = true;
    return false;
  }
  get active() {
    if (!this.state.admitted) this.refreshAdmission();
    return this.role === 'main' && this.state.admitted;
  }
  complete(successful = true): { prompt?: string; exhausted?: string } {
    if (this.role !== 'main') return {};
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
      return { prompt: this.active ? BRIEFING_REPAIR_PROMPT + (ledger?.completion ? '\n' + ledger.completion.prompt : '') : ledger?.completion?.prompt };
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
