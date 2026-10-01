import { randomBytes } from 'node:crypto';
import { buildAgentEnv, collectAgentEnv } from '../shared/agent-env.js';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

/**
 * Lazily-booted `opencode serve` process, shared by interactive OpenCode turns.
 *
 * The server's durable prompt API is also OpenCode's mid-turn steering
 * transport. Separately, `opencode run` cannot put an image in front of the model. Its read tool
 * returns images as part of a *tool result*, and an OpenAI-compatible transport
 * flattens tool results to plain text, while `--file` labels every attachment
 * `text/plain` (upstream anomalyco/opencode#16723). The HTTP server is the only
 * OpenCode interface that accepts an image as a part of the *user* message,
 * which is the one shape every vision model actually reads.
 *
 * The sessions it creates are ordinary sessions in the same opencode.db that
 * `run` writes, so the two interfaces interoperate: a conversation started here
 * can be continued by `opencode run --session <id>` and the other way round.
 * That is what keeps this to an extra transport rather than a second runtime.
 */

const BOOT_TIMEOUT_MS = 30_000;
const LISTENING_PATTERN = /listening on\s+(https?:\/\/\S+)/i;

/**
 * Where the server process itself is parked.
 *
 * Its own working directory should be immaterial — every turn names its
 * directory in `location.directory` — but it is not: a server started inside
 * this app's own repository answers text prompts and then hangs forever on any
 * prompt carrying an attachment, with nothing logged and no assistant message
 * ever created. Started anywhere else, the identical request is answered. An
 * empty directory of our own keeps the server away from whatever it is in a
 * project tree that it trips over.
 */
function getServerWorkspace() {
  return path.join(os.homedir(), '.vibespace', 'opencode-server');
}

/**
 * One server per variant.
 *
 * Anything that reads the server process's environment when it loads (an
 * OpenCode plugin, say) sees the same values for every session that server
 * hosts, so a session hosted by the ordinary server cannot be told apart from
 * the rest whatever its row says. A private session is therefore routed to a
 * second server spawned with whatever host plugins contribute for the private
 * variant (see collectAgentEnv); every private session shares that one, and
 * the ordinary server is untouched.
 *
 * `extraEnv` is evaluated at spawn time, not at load: contributors register
 * during boot, after this module is imported.
 *
 * variant -> { bootPromise, serverProcess, extraEnv }
 */
const instances = {
  shared: { bootPromise: null, serverProcess: null, extraEnv: () => ({}) },
  private: {
    bootPromise: null,
    serverProcess: null,
    extraEnv: () => collectAgentEnv({ provider: 'opencode', scope: 'server', private: true }),
  },
};
let exitHooksInstalled = false;

function variantFor(options) {
  return options?.private ? 'private' : 'shared';
}

/**
 * Reserves a free loopback port by binding one and letting go again.
 *
 * `opencode serve --port 0` does not mean "pick one" — it falls through to the
 * configured default (4096), which collides with a server the user is already
 * running. Choosing the port here keeps this instance out of everyone's way.
 */
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : null;
      probe.close(() => (port ? resolve(port) : reject(new Error('Could not reserve a port for the OpenCode server'))));
    });
  });
}

function isAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

/**
 * Waits until the server can actually resolve a model.
 *
 * "listening on ..." is not readiness: for the first second or two the model
 * catalog is still being assembled and `/api/model` is empty. A prompt sent
 * into that window is accepted, then dropped — the run fails with
 * `ModelUnavailableError` in opencode's own log, publishes no event, and
 * produces no assistant message, so the chat simply hangs. Polling until a
 * catalog exists is what closes that window.
 */
async function waitForModelCatalog(baseUrl, authorization, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/model`, { headers: { Authorization: authorization } });
      if (response.ok) {
        const payload = await response.json();
        const models = payload?.data ?? payload;
        if (Array.isArray(models) && models.length > 0) {
          return;
        }
      }
    } catch {
      // Not accepting connections yet; the deadline is the only limit.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error('OpenCode server started but never published a model catalog');
}

/**
 * Makes the server load its configured plugins.
 *
 * OpenCode (measured on 1.18.18) loads plugins only when it boots a project
 * instance, and only the v1 routes boot one: a server driven purely through
 * `/api/*`, as this app drives it, never loads a single plugin, so their
 * hooks and subscriptions stay silent however many turns run. One v1 request
 * boots the instance for the server's own workspace. A failure here costs the
 * plugins, not the chat, so it is never fatal.
 */
async function loadPlugins(baseUrl, authorization) {
  try {
    const response = await fetch(`${baseUrl}/path`, { headers: { Authorization: authorization } });
    await response.body?.cancel();
  } catch {
    // Plugins are an extra; the server works without them.
  }
}

function installExitHooks() {
  if (exitHooksInstalled) {
    return;
  }

  exitHooksInstalled = true;
  // The server is ours, so it goes when we go. Without this it would outlive
  // every restart of the app and hold both its port and an opencode.db handle.
  const stopOnExit = () => stopOpenCodeServer();
  process.once('exit', stopOnExit);
  process.once('SIGINT', stopOnExit);
  process.once('SIGTERM', stopOnExit);
}

function bootServer(slot) {
  return new Promise((resolve, reject) => {
    void (async () => {
      let port;
      try {
        port = await reserveFreePort();
      } catch (error) {
        reject(error);
        return;
      }

      // Unauthenticated, the server would hand every local process the same
      // filesystem and shell access the agent has. It only speaks Basic auth,
      // and only the password half is checked.
      const password = randomBytes(24).toString('hex');
      const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

      const workspace = getServerWorkspace();
      mkdirSync(workspace, { recursive: true });

      const child = crossSpawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
        cwd: workspace,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Filtered: every tool shell OpenCode runs inherits this server's env.
        env: buildAgentEnv({
          ...slot.extraEnv(),
          ...(process.env.VS_OPENCODE_SERVER_CONFIG_DIR
            ? { OPENCODE_CONFIG_DIR: process.env.VS_OPENCODE_SERVER_CONFIG_DIR }
            : {}),
          OPENCODE_SERVER_PASSWORD: password,
        }),
      });

      let settled = false;
      let stderrText = '';

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill('SIGTERM');
        reject(new Error(`OpenCode server did not start within ${BOOT_TIMEOUT_MS / 1000}s`));
      }, BOOT_TIMEOUT_MS);
      // A pending boot must never be the reason the process refuses to exit.
      timeout.unref?.();

      const settle = (outcome, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        outcome(value);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        const match = LISTENING_PATTERN.exec(chunk);
        if (!match || settled) {
          return;
        }

        const baseUrl = match[1].replace(/\/$/, '');
        slot.serverProcess = child;
        installExitHooks();
        void waitForModelCatalog(baseUrl, authorization, Date.now() + BOOT_TIMEOUT_MS)
          .then(() => loadPlugins(baseUrl, authorization))
          .then(() => settle(resolve, { baseUrl, authorization }))
          .catch((error) => {
            child.kill('SIGTERM');
            settle(reject, error);
          });
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        // Kept only to explain a boot that never reaches "listening on".
        stderrText = `${stderrText}${chunk}`.slice(-2_000);
      });

      child.on('error', (error) => {
        slot.bootPromise = null;
        settle(reject, error);
      });

      child.on('exit', (code, signal) => {
        if (slot.serverProcess === child) {
          slot.serverProcess = null;
        }
        // Force the next caller to boot a fresh one rather than hand out the
        // address of a process that is no longer listening.
        slot.bootPromise = null;
        settle(
          reject,
          new Error(
            `OpenCode server exited (${signal || `code ${code}`})${stderrText.trim() ? `: ${stderrText.trim()}` : ''}`,
          ),
        );
      });
    })();
  });
}

/**
 * The stub a test put in place of the shared server, or null.
 *
 * @type {null | ((options: { private?: boolean }) => { baseUrl: string, authorization: string } | Promise<{ baseUrl: string, authorization: string }>)}
 */
let injectedServer = null;

/**
 * True inside a test run: `npm test` sets NODE_ENV=test, and node's test
 * runner sets NODE_TEST_CONTEXT in every file it runs, so a file started with
 * `tsx --test <file>` directly is covered too.
 */
function isTestProcess() {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
}

/**
 * Points every interactive OpenCode turn at a stub server instead of booting
 * `opencode serve`. Returns a function that removes the stub again.
 *
 * Test-only seam (opencode-runtime.provider.test.js,
 * opencode-compact-command.test.ts): a test that runs an HTTP turn starts its
 * own loopback fake and hands its address here. Without one, a test process is
 * refused a server outright (see ensureOpenCodeServer) — booting one resolves
 * `opencode` from PATH, and a test whose fake had already been taken off PATH
 * reached the operator's real OpenCode and left "Greeting" sessions in it.
 *
 * @param {{ baseUrl: string, authorization: string } | ((options: { private?: boolean }) => { baseUrl: string, authorization: string } | Promise<{ baseUrl: string, authorization: string }>)} server
 * @returns {() => void}
 */
export function injectOpenCodeServerForTests(server) {
  const resolver = typeof server === 'function' ? server : () => server;
  injectedServer = resolver;
  return () => {
    if (injectedServer === resolver) injectedServer = null;
  };
}

/**
 * Returns `{ baseUrl, authorization }` for the shared server, booting it if it
 * is not already running.
 *
 * Under test (NODE_ENV=test or node's test runner) it never boots or reaches a
 * real server: it answers with the stub from injectOpenCodeServerForTests, and
 * without one it throws.
 *
 * @param {{ private?: boolean }} [options] - `private` selects the server
 *   spawned with the private-variant env (see collectAgentEnv).
 */
export async function ensureOpenCodeServer(options = {}) {
  if (injectedServer) {
    return injectedServer(options);
  }
  if (isTestProcess()) {
    throw new Error(
      'Refusing to boot `opencode serve` under test (NODE_ENV=test / NODE_TEST_CONTEXT): '
      + 'it would reach the real OpenCode. Inject a stub with injectOpenCodeServerForTests().',
    );
  }

  const slot = instances[variantFor(options)];
  if (slot.bootPromise && isAlive(slot.serverProcess)) {
    return slot.bootPromise;
  }

  if (slot.bootPromise && !slot.serverProcess) {
    // A boot that is still in flight: nothing has been published yet, so there
    // is no liveness to check and starting a second one would waste the port.
    return slot.bootPromise;
  }

  slot.bootPromise = bootServer(slot);
  return slot.bootPromise;
}

/** Stops every shared server. Safe to call when nothing is running. */
export function stopOpenCodeServer() {
  for (const slot of Object.values(instances)) {
    const child = slot.serverProcess;
    slot.serverProcess = null;
    slot.bootPromise = null;
    if (isAlive(child)) {
      child.kill('SIGTERM');
    }
  }
}
