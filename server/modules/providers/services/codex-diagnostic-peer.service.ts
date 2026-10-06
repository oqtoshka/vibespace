import { codexApprovals } from '../../codex-approvals/index.js';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

// No production route constructs this peer. Its ordinary interface remains
// inspection-only; only the dormant verified-transfer factory claims execution.
const ALLOWED = new Set(['initialize', 'thread/loaded/list', 'thread/read']);

/** The internal diagnostic binding service and its real stdio tests use this pinned standby transport. */
export class CodexDiagnosticPeer {
  readonly child: ReturnType<typeof spawn>;
  readonly ready: Promise<void>;
  closed = false;
  private sequence = 0;
  private ownedThread: string | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private lines: readline.Interface;
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor(executable: string, environment: NodeJS.ProcessEnv) {
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://'], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin!.on('error', () => undefined);
    // Drain stderr without retaining provider/private payloads in diagnostics.
    this.child.stderr!.resume();
    this.lines = readline.createInterface({ input: this.child.stdout! });
    this.lines.on('line', line => {
      let message: { id?: number | string; result?: unknown; error?: unknown; method?: string; params?: Record<string, unknown> };
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.stop(); return; }
      if (message.id !== undefined && typeof message.method === 'string') {
        this.serverRequest(message.id, message.method, message.params ?? {}); return;
      }
      if (message.id !== undefined) {
        if (typeof message.id !== 'number') return;
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(message.id);
        if (message.error !== undefined) request.reject(new Error('diagnostic-peer-request-failed'));
        else request.resolve(message.result);
      } else if (typeof message.method === 'string') {
        for (const listener of this.listeners) {
          try { listener(message.method, message.params ?? {}); } catch { this.stop(); return; }
        }
      }
    });
    this.child.once('error', () => this.stop());
    this.child.once('exit', () => { if (this.killTimer) clearTimeout(this.killTimer); this.close(); });
    this.ready = this.send('initialize', { clientInfo: { name: 'diagnostic-standby', version: '1' } }, 1500)
      .then(() => { this.child.stdin!.write(JSON.stringify({ method: 'initialized' }) + '\n'); })
      .catch(error => { this.stop(); throw error; });
  }

  subscribe(listener: (method: string, params: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = 1500): Promise<unknown> {
    if (!ALLOWED.has(method) || method === 'initialize') throw new Error('diagnostic-transfer-unavailable');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('diagnostic-peer-timeout-bound');
    await this.ready;
    return this.send(method, params, Math.min(timeoutMs, 1500));
  }


  // Only the dormant routing service calls this after verified old-owner release.
  // The ordinary standby request() stays inspection-only.
  execution(threadId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(threadId)
      || (this.ownedThread !== null && this.ownedThread !== threadId)) throw new Error('diagnostic-execution-owner');
    this.ownedThread = threadId;
    return Object.freeze({
      request: async (method: string, params: Record<string, unknown>, timeoutMs = 1500) => {
        const allowed = ['thread/resume', 'thread/unsubscribe', 'thread/turns/list', 'turn/start', 'turn/steer', 'turn/interrupt'];
        if (!allowed.includes(method) || params.threadId !== threadId || this.ownedThread !== threadId) throw new Error('diagnostic-execution-scope');
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) throw new Error('diagnostic-peer-timeout-bound');
        await this.ready; return this.send(method, params, timeoutMs);
      },
      revoke: () => { if (this.ownedThread === threadId) this.ownedThread = null; },
    });
  }

  private serverRequest(id: number | string, method: string, params: Record<string, unknown>) {
    const reply = (result: Record<string, unknown>) => { if (!this.closed) this.child.stdin!.write(JSON.stringify({ id, result }) + '\n'); };
    const approval = this.ownedThread !== null && params.threadId === this.ownedThread
      ? codexApprovals.request(this.ownedThread, method, params) : null;
    if (approval) { void approval.then(reply).catch(() => reply({ decision: 'decline' })); return; }
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval': reply({ decision: 'decline' }); break;
      case 'item/permissions/requestApproval': reply({ permissions: {} }); break;
      case 'item/tool/requestUserInput':
      case 'tool/requestUserInput': reply({ answers: {} }); break;
      case 'mcpServer/elicitation/request': reply({ action: 'cancel' }); break;
      default: if (!this.closed) this.child.stdin!.write(JSON.stringify({ id, error: { code: -32601, message: 'Unsupported diagnostic server request' } }) + '\n');
    }
  }

  private send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('diagnostic-peer-closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('diagnostic-peer-timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  private close() {
    if (this.closed) return;
    this.closed = true; this.ownedThread = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('diagnostic-peer-closed')); }
    this.pending.clear(); this.listeners.clear(); this.lines.close();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream?.destroy();
  }

  stop() {
    this.close();
    if (this.child.exitCode !== null || this.child.signalCode !== null || this.killTimer) return;
    this.child.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    }, 1000);
    this.killTimer.unref();
  }
}
