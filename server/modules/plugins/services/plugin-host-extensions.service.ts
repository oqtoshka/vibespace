import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

import express, { type RequestHandler, type Router } from 'express';

import { registerAgentEnvContributor, type AgentEnvContributor } from '@/shared/agent-env.js';

/**
 * In-process plugin host modules.
 *
 * The plugin system runs plugin *servers* as separate processes proxied over
 * HTTP/WS, which is right for anything self-contained. Integrations that need
 * the running server itself — spawn a session from a boot-time watcher, answer
 * an authenticated callback about a session row, tag agent subprocesses with an
 * environment variable — cannot live behind a proxy. For those a plugin
 * manifest names a `hostModule`: an ES module loaded into this process at boot
 * whose `activate(host)` receives the narrow API below.
 *
 * Trust model: unchanged. A plugin server subprocess already runs arbitrary
 * code as this user; a host module just runs it in-process.
 *
 * Deliberately narrow: what `PluginHost` exposes is the contract. Widen it on
 * demand rather than handing out the express app or the database.
 */

//----------------- HOST API ------------

/** The session row fields a host module may read. */
export type HostSessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  isArchived: boolean;
};

/**
 * What `activate(host)` receives. Everything a host module can do to VibeSpace
 * goes through here.
 */
export type PluginHost = {
  /** Manifest name, e.g. "dudin-integrations". */
  pluginName: string;
  /** Absolute plugin directory (realpath). */
  pluginDir: string;
  /** Prefixed console logger. */
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  /** A fresh express Router (plugins have no express of their own to import). */
  createRouter: () => Router;
  /**
   * Mounts an express router at an absolute path (e.g. `/api/mission-control`).
   * The router is reachable exactly like a core route, ahead of the SPA
   * catch-all; the plugin decides authentication (see `auth`).
   */
  mountRouter: (mountPath: string, router: Router) => void;
  auth: {
    /** The app's bearer-token middleware, for routes browsers call. */
    authenticateToken: RequestHandler;
  };
  sessions: {
    getById: (sessionId: string) => HostSessionRow | null;
    /** Creates an app session row; returns its id. */
    createAppSession: (provider: string, cwd: string) => { sessionId: string };
    /** Archives (or with `force`, deletes) a session through the ordinary service path. */
    deleteOrArchiveById: (
      sessionId: string,
      options?: { force?: boolean; deletedFromDisk?: boolean },
    ) => Promise<void>;
  };
  /**
   * Pushes a prompt into a session through the server-owned queue, so a run
   * starts with no browser attached. Returns false if the session vanished.
   */
  enqueueMessage: (
    sessionId: string,
    prompt: string,
    options?: Record<string, unknown>,
  ) => boolean;
  /**
   * HMAC-SHA256 of `input` under VibeSpace's own signing secret (base64url).
   * Lets a plugin verify a capability minted by something that shares that
   * secret without ever seeing the secret itself.
   */
  hmacSha256: (input: string) => string;
  /** See shared/agent-env.ts — add variables to agent-spawned processes. */
  registerAgentEnvContributor: (contributor: AgentEnvContributor) => () => void;
  /** Runs on server shutdown and on deactivation, in registration order. */
  onShutdown: (callback: () => void | Promise<void>) => void;
};

/** What a host module exports. `deactivate` is optional. */
export type PluginHostModule = {
  activate: (host: PluginHost) => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
};

//----------------- WIRING ------------

/**
 * What the server entrypoint hands the loader. Injected rather than imported
 * so this service depends on no other module's barrel and stays trivially
 * testable; the entrypoint already has every one of these in hand.
 */
export type HostExtensionDependencies = {
  scanPlugins: () => Array<{ name: string; dirName: string; enabled: boolean; hostModule: string | null }>;
  getPluginsDir: () => string;
  authenticateToken: RequestHandler;
  getSigningSecret: () => string;
  sessions: PluginHost['sessions'];
  enqueueMessage: PluginHost['enqueueMessage'];
};

type ActiveExtension = {
  name: string;
  module: PluginHostModule;
  shutdownCallbacks: Array<() => void | Promise<void>>;
  unregisterContributors: Array<() => void>;
};

/**
 * Router every host module mounts into. It is attached to the app once, early
 * (ahead of the SPA catch-all); routers added to it later are still reached,
 * because express walks a router's stack at request time.
 */
const extensionRouter: Router = express.Router();
const active = new Map<string, ActiveExtension>();

// getHostExtensionRouter: used by the server entrypoint to attach plugin routes to the app.
export function getHostExtensionRouter(): Router {
  return extensionRouter;
}

function buildHost(name: string, pluginDir: string, deps: HostExtensionDependencies, state: ActiveExtension): PluginHost {
  const prefix = `[Plugin:${name}]`;
  return {
    pluginName: name,
    pluginDir,
    log: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    createRouter: () => express.Router(),
    mountRouter: (mountPath, router) => {
      if (typeof mountPath !== 'string' || !mountPath.startsWith('/')) {
        throw new Error(`${prefix} mountRouter: path must be absolute, got "${mountPath}"`);
      }
      extensionRouter.use(mountPath, router);
      console.log(`${prefix} mounted ${mountPath}`);
    },
    auth: { authenticateToken: deps.authenticateToken },
    sessions: deps.sessions,
    enqueueMessage: deps.enqueueMessage,
    hmacSha256: (input) =>
      crypto.createHmac('sha256', deps.getSigningSecret()).update(input).digest('base64url'),
    registerAgentEnvContributor: (contributor) => {
      const unregister = registerAgentEnvContributor(contributor);
      state.unregisterContributors.push(unregister);
      return unregister;
    },
    onShutdown: (callback) => {
      state.shutdownCallbacks.push(callback);
    },
  };
}

/**
 * Loads and activates the host module of every enabled plugin that declares
 * one. Used by the server entrypoint once the session/queue machinery is up
 * (a host module may spawn sessions from `activate`). A plugin that fails to
 * load is logged and skipped; it never takes the server down.
 */
export async function activateHostExtensions(deps: HostExtensionDependencies): Promise<string[]> {
  const activated: string[] = [];
  for (const plugin of deps.scanPlugins()) {
    if (!plugin.enabled || !plugin.hostModule || active.has(plugin.name)) continue;

    const pluginDir = path.join(deps.getPluginsDir(), plugin.dirName);
    const modulePath = path.resolve(pluginDir, plugin.hostModule);
    const state: ActiveExtension = {
      name: plugin.name,
      module: { activate: () => undefined },
      shutdownCallbacks: [],
      unregisterContributors: [],
    };
    try {
      const loaded = (await import(pathToFileURL(modulePath).href)) as Partial<PluginHostModule>;
      if (typeof loaded.activate !== 'function') {
        throw new Error(`${plugin.hostModule} exports no activate()`);
      }
      state.module = loaded as PluginHostModule;
      active.set(plugin.name, state);
      await loaded.activate(buildHost(plugin.name, pluginDir, deps, state));
      activated.push(plugin.name);
      console.log(`[Plugins] host module active for "${plugin.name}"`);
    } catch (error) {
      active.delete(plugin.name);
      for (const unregister of state.unregisterContributors) unregister();
      console.error(`[Plugins] host module for "${plugin.name}" failed:`, (error as Error)?.message ?? error);
    }
  }
  return activated;
}

/**
 * Runs every host module's shutdown callbacks and `deactivate`, then drops its
 * env contributors. Used by the server entrypoint during shutdown. Mounted
 * routes stay mounted — express has no unmount — which is fine for a process
 * that is exiting.
 */
export async function deactivateHostExtensions(): Promise<void> {
  for (const [name, state] of [...active.entries()].reverse()) {
    for (const callback of state.shutdownCallbacks) {
      try {
        await callback();
      } catch (error) {
        console.error(`[Plugins] shutdown hook of "${name}" failed:`, (error as Error)?.message ?? error);
      }
    }
    try {
      await state.module.deactivate?.();
    } catch (error) {
      console.error(`[Plugins] deactivate of "${name}" failed:`, (error as Error)?.message ?? error);
    }
    for (const unregister of state.unregisterContributors) unregister();
    active.delete(name);
  }
}

// activeHostExtensionNames: used by tests and the plugins route to report which host modules are live.
export function activeHostExtensionNames(): string[] {
  return [...active.keys()];
}
