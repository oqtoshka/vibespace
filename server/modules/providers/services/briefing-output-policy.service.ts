import { randomUUID } from 'node:crypto';

import { collectAgentLaunchExtras, createNormalizedMessage, readExternalTaskLedger } from '../../../shared/index.js';

type Provider = 'claude' | 'opencode' | 'cursor';
type State = { admitted: boolean; repairUsed: boolean; violation: boolean };
type Options = { ephemeral?: boolean; backgroundHelper?: boolean; sideSession?: unknown; appSessionId?: string | null; sessionId?: string | null; launchOptions?: Record<string, unknown> | null; private?: boolean };
const repairPrompt = '[session supervisor] Session behavior invariant violated: use only the existing card tools for every operator-facing answer and reply in all requested threads. Plain agent commentary and final answers are forbidden, even after a card reply. Continue authorized work through tools. This is the single bounded repair; another violation ends this run with AGENT_TEXT_POLICY_VIOLATION.';

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
    this.state = state ?? { admitted: false, repairUsed: false, violation: false };
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
  complete(): { prompt?: string; failure?: string } {
    if (this.role !== 'main') return {};
    const ledger = this.sessionId ? readExternalTaskLedger({ provider: this.provider, sessionId: this.sessionId, phase: 'complete', sessionRole: this.role, ...this.launchContext }) : null;
    if (!this.state.violation && !ledger?.completion && (!this.state.admitted || ledger)) return {};
    if (!this.state.repairUsed) {
      this.state.repairUsed = true;
      this.state.violation = false;
      return { prompt: this.active ? repairPrompt + (ledger?.completion ? '\n' + ledger.completion.prompt : '') : ledger?.completion?.prompt };
    }
    return { failure: 'AGENT_TEXT_POLICY_VIOLATION: the briefing run still violates its card reporting invariant after the single bounded repair.' };
  }
  failureMessage(failure: string) {
    return createNormalizedMessage({ kind: 'error', content: failure, sessionId: this.sessionId, provider: this.provider });
  }
}
