import { createRequire } from 'node:module';
import path from 'node:path';
import readline from 'node:readline';

import crossSpawn from 'cross-spawn';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Resolve the same pinned Codex executable that @openai/codex-sdk used.
 *
 * VIBESPACE_CODEX_PATH is primarily useful for packaged deployments and for
 * transport tests. A JavaScript entry point is launched with the current Node
 * executable; native binaries/shims are launched directly.
 */
function resolveCodexCommand() {
  const override = process.env.VIBESPACE_CODEX_PATH?.trim();
  const sdkRequire = createRequire(import.meta.resolve('@openai/codex-sdk'));
  const executable = override || path.join(
    path.dirname(sdkRequire.resolve('@openai/codex/package.json')),
    'bin',
    'codex.js',
  );

  return executable.endsWith('.js')
    ? { command: process.execPath, args: [executable] }
    : { command: executable, args: [] };
}

function rpcError(message) {
  const detail = message?.error;
  const text = detail?.message || 'Codex app-server request failed';
  const error = new Error(text);
  error.code = detail?.code;
  error.data = detail?.data;
  return error;
}

/**
 * Minimal JSON-RPC client for Codex app-server's stdio transport.
 *
 * The public TypeScript SDK runs one `codex exec` process per turn, which
 * cannot receive `turn/steer`. app-server keeps the active turn loaded and is
 * therefore the provider-owned transport for true mid-turn messages.
 */
export class CodexAppServerClient {
  /**
   * @param {{ env?: NodeJS.ProcessEnv }} [options] - `env` replaces the
   *   process environment for the child; the default is `process.env` itself,
   *   untouched, which is what every ordinary session has always run under.
   */
  constructor({ env = process.env } = {}) {
    const resolved = resolveCodexCommand();
    this.child = crossSpawn(
      resolved.command,
      [...resolved.args, 'app-server', '--listen', 'stdio://'],
      { stdio: ['pipe', 'pipe', 'pipe'], env },
    );
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 1;
    this.closed = false;
    this.stderr = '';

    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
    });

    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#handleLine(line));

    this.child.once('error', (error) => this.#close(error));
    this.child.once('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      const stderr = this.stderr.trim();
      this.#close(new Error(`Codex app-server exited with ${detail}${stderr ? `: ${stderr}` : ''}`));
    });

    this.ready = this.#initialize();
  }

  async #initialize() {
    await this.#requestDirect('initialize', {
      clientInfo: {
        name: 'vibespace',
        title: 'VibeSpace',
        version: '1',
      },
    });
    this.#send({ method: 'initialized' });
  }

  #send(message) {
    if (this.closed || !this.child.stdin?.writable) {
      throw new Error('Codex app-server is not running');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #requestDirect(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, timeoutMs);
      timeout.unref?.();

      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.#send({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    await this.ready;
    return this.#requestDirect(method, params, timeoutMs);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(rpcError(message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Server-initiated requests must always receive an answer. The previous
    // non-interactive `codex exec` transport could not show these prompts, so
    // retain that behavior: deny approvals and cancel interactive questions.
    if (message.id !== undefined && message.method) {
      const result = (() => {
        switch (message.method) {
          case 'item/commandExecution/requestApproval':
          case 'item/fileChange/requestApproval':
            return { decision: 'decline' };
          case 'item/permissions/requestApproval':
            return { permissions: {} };
          case 'tool/requestUserInput':
            return { answers: {} };
          case 'mcpServer/elicitation/request':
            return { action: 'cancel' };
          default:
            return null;
        }
      })();

      if (result === null) {
        this.#send({
          id: message.id,
          error: { code: -32601, message: `Unsupported server request: ${message.method}` },
        });
      } else {
        this.#send({ id: message.id, result });
      }
      return;
    }

    if (message.method) {
      for (const listener of this.listeners) {
        try {
          listener(message.method, message.params || {});
        } catch (error) {
          console.error('[Codex] App-server notification handler failed:', error);
        }
      }
    }
  }

  #close(error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) {
      try {
        listener('transport/closed', { error });
      } catch {
        // The transport is already gone; there is nowhere useful to report a
        // secondary listener failure.
      }
    }
  }

  stop() {
    if (this.closed) {
      return;
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      // Process already exited.
    }
  }
}

/**
 * One shared app-server per variant.
 *
 * A Codex session is hosted by whichever app-server started its thread, and
 * the presence reporter's gate (`MC_DISABLE`) is read from that server's own
 * environment — so a private session cannot share the ordinary server. It
 * gets a second one, spawned with the gate set, and every private session
 * shares that. The ordinary variant is exactly the single server that existed
 * before privacy did: same command, same `process.env`.
 */
const VARIANTS = {
  shared: { env: () => undefined },
  // Read at spawn time, not at load: the host env can change after import
  // (tests set the capture path late), and `process.env` is copied anyway.
  private: { env: () => ({ ...process.env, MC_DISABLE: '1' }) },
};

/** variant -> { instance, promise } */
const clients = new Map();
let exitHookInstalled = false;

function variantFor(options) {
  return options?.private ? 'private' : 'shared';
}

/**
 * @param {{ private?: boolean }} [options] - `private` selects the app-server
 *   spawned with `MC_DISABLE=1`.
 */
export async function getCodexAppServer(options = {}) {
  const variant = variantFor(options);
  const existing = clients.get(variant);
  if (existing?.promise && existing.instance && !existing.instance.closed) {
    return existing.promise;
  }

  const env = VARIANTS[variant].env();
  const candidate = env ? new CodexAppServerClient({ env }) : new CodexAppServerClient();
  const entry = { instance: candidate, promise: null };
  entry.promise = candidate.ready.then(() => candidate).catch((error) => {
    if (clients.get(variant) === entry) {
      clients.delete(variant);
    }
    throw error;
  });
  clients.set(variant, entry);

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const { instance } of clients.values()) instance?.stop();
    });
  }

  return entry.promise;
}

/** Stops and forgets every shared transport. Exported for tests and shutdowns. */
export function stopCodexAppServer() {
  for (const { instance } of clients.values()) instance?.stop();
  clients.clear();
}
