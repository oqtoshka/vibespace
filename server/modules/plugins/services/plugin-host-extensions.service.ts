import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

import express, { type RequestHandler, type Router } from 'express';

import {
  subscribeSessionMetadataChanges,
  type SessionMetadataChange,
} from '@/modules/plugins/services/session-metadata-events.service.js';
import {
  registerAgentEnvContributor,
  registerAgentLaunchContributor,
  registerLaunchOption,
  type AgentEnvContributor,
  type AgentLaunchContributor,
  type LaunchOptionDeclaration,
} from '@/shared/agent-env.js';
import type {
  CheckedEnqueueResult,
  PeerAdmissionInput,
  PeerAdmissionResult,
  PeerOutboxRecord,
} from '@/shared/types.js';

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

/**
 * The session row fields a host module may read.
 *
 * `project_path` is the directory the session belongs to: written when the row
 * is created, and thereafter refreshed by the synchronizer from the *first*
 * valid record of the provider transcript. A per-turn `cwd` override is used
 * for the run and never written back here, so this stays the launch directory
 * for the life of the session — which is what makes it safe to group by.
 *
 * `is_private` is SQLite's 0/1. Absent or anything else means *unknown*, and a
 * reader that cannot prove a session is public must treat it as private. Both
 * fields were always returned at runtime; declaring them stops a plugin having
 * to reach past the type to see what it is already being handed.
 */
export type HostSessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  /** JSON of the launch options VibeSpace stored at creation (null for disk-discovered sessions). */
  launch_options?: string | null;
  project_path: string | null;
  is_private: number;
  /** The raw SQLite integer (0/1) from `sessions.getById`; a boolean elsewhere. */
  isArchived: boolean | 0 | 1;
};

/** What a host module may see of a session's run. */
export type HostRunView = {
  status: 'running' | 'completed';
  providerSessionId: string | null;
  lastAssistantText: string;
};

/** A turn-admission lease granted by `runs.reserve`. */
export type HostRunLease = {
  sessionId: string;
  providerSessionId: string;
  purpose: string;
  resource: { id: string; generation: string };
  /** Epoch ms, on this process's clock (the plugin runs in-process). */
  expiresAt: number;
  /** See `runs.reserve`: operator-approved, native terminal turns excepted. */
  coversAllRunStarts: true;
  /** Idempotent; only this lease's own token can end it. */
  release: () => void;
};

/** A prompt a session is parked on until somebody answers it (a plan to approve, a question). */
export type HostPendingInteraction = {
  requestId: string;
  toolName: string;
  input: unknown;
  receivedAt: Date;
};

/** The answer to a parked prompt — the same shape a chat client sends. */
export type HostInteractionDecision = {
  allow: boolean;
  /** Shown to the agent when the prompt is refused. */
  message?: string;
  updatedInput?: unknown;
  /** Approving the end of plan mode: the mode the session continues in. */
  permissionMode?: string;
};

/**
 * What `activate(host)` receives. Everything a host module can do to VibeSpace
 * goes through here.
 */
export type PluginHost = {
  /** Manifest name, e.g. "acme-integrations". */
  pluginName: string;
  /** Absolute plugin directory (realpath). */
  pluginDir: string;
  /** Prefixed console logger. */
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  /** A fresh express Router (plugins have no express of their own to import). */
  createRouter: () => Router;
  /**
   * Mounts an express router at an absolute path (e.g. `/api/acme`).
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
    /**
     * The non-archived, non-side sessions of one project, newest first, capped
     * at `limit`. Bounded on purpose: this is how an integration finds the
     * sessions alongside it, not a way to walk the whole database.
     *
     * The caller passes a `project_path` it already holds — normally the one on
     * its own row — so no path from a request body needs to be trusted.
     *
     * Optional so a plugin written against this contract still loads on a host
     * that predates it; a plugin must treat its absence as "cannot observe",
     * not as "there are none".
     */
    listByProjectPath?: (projectPath: string, limit: number) => HostSessionRow[];
    /** Creates an app session row; returns its id. */
    createAppSession: (provider: string, cwd: string) => { sessionId: string };
    /** Archives (or with `force`, deletes) a session through the ordinary service path. */
    deleteOrArchiveById: (
      sessionId: string,
      options?: { force?: boolean; deletedFromDisk?: boolean },
    ) => Promise<void>;
    /** Sets the title shown in the sidebar (cosmetic; never affects the run). */
    rename: (sessionId: string, title: string) => void;
    /**
     * Subscribes to deduplicated title/recap changes after VibeSpace stores
     * them. Optional integrations use this instead of polling the database.
     */
    onMetadataChanged: (callback: (change: SessionMetadataChange) => void) => () => void;
  };
  /** The live run of a session this plugin drives, and the one thing it may do to it. */
  runs: {
    /**
     * null when the session has no run in the registry (never started, or
     * evicted a few minutes after completion). `lastAssistantText` is the
     * newest assistant text of the buffered run, for a plugin that has to
     * report how a headless run ended.
     */
    get: (sessionId: string) => HostRunView | null;
    /** Cancels a running turn as `chat.abort` would; false if nothing was running. */
    abort: (sessionId: string) => Promise<boolean>;
    /**
     * Holds the session's turn admission for a bounded mutation (the Janitor's
     * resource cleanup): while the lease is held no VibeSpace turn starts —
     * `chat.send` is refused as RUN_ADMISSION_RESERVED and re-queued by the
     * client, the queue drain and the peer outbox wait, and a Claude background
     * auto-resume or open-task nudge is parked — and its release or expiry
     * re-drains all of them. Null when a run is active, anything is queued, a
     * lease is already held, the TTL is not in (0, 60s], or the session is not
     * bound to `providerSessionId`.
     *
     * `coversAllRunStarts: true` is an operator-approved attestation, not a
     * technical absolute: a native CLI resumed from a terminal runs outside this
     * process and cannot be refused. The operator accepted that gap on
     * 2026-09-24 because the Janitor only ever acts for VibeSpace-created
     * briefing sessions, which are driven from VibeSpace. Optional: absent on a
     * host that predates it (the plugin then keeps cleanup disabled).
     */
    reserve?: (sessionId: string, input: {
      providerSessionId: string;
      purpose: string;
      resource: { id: string; generation: string };
      ttlMs: number;
    }) => HostRunLease | null;
    /**
     * Run-completion hint for one session (fired after the queue drain). Never
     * idle authority: a subscriber re-derives everything it acts on. Returns
     * the unsubscribe. Optional: absent on a host that predates it.
     */
    onCompleted?: (callback: (sessionId: string) => void) => () => void;
  };
  /**
   * The prompts a session is parked on, and answering one from outside the
   * chat — an integration whose own surface shows the plan or the question.
   * Optional: absent on a host that predates it.
   */
  interactions?: {
    getPending: (sessionId: string) => HostPendingInteraction[];
    /** False when the prompt is gone (answered elsewhere, turn ended) or not this session's. */
    resolve: (sessionId: string, requestId: string, decision: HostInteractionDecision) => boolean;
  };
  /**
   * The permission mode the operator's new sessions of a provider start in —
   * what an integration that ends plan mode should continue in. Null when unknown.
   */
  getDefaultPermissionMode?: (provider: string) => string | null;
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
   * Like `enqueueMessage`, but refuses — queueing nothing — when the session's
   * provider runtime is unavailable or its queue is at the cap, instead of
   * accepting an item the drain would drop or evict. `accepted` is in-memory
   * only: not a delivery, and lost on a server restart.
   */
  enqueueMessageChecked?: (
    sessionId: string,
    prompt: string,
    options?: Record<string, unknown>,
  ) => CheckedEnqueueResult;
  /**
   * Admits a background follow-up only with an observed completed run bound to
   * `expectedProviderSessionId`, an empty queue, no turn-admission reservation
   * and no pending permission. False includes unavailable evidence. Optional:
   * plugins must not fall back to an unconditional enqueue when it is absent.
   */
  enqueueMessageIfIdle?: (
    sessionId: string,
    expectedProviderSessionId: string,
    prompt: string,
    options?: Record<string, unknown>,
  ) => boolean;
  /**
   * Durable, idempotent outbox for cross-session peer messages. `admit`
   * persists an accepted message keyed on (sender, requestId) and dispatches
   * it only while the recipient is eligible; `get` reads a row back so a
   * replay reports the original state. See the websocket module's outbox.
   */
  peerOutbox?: {
    admit: (input: PeerAdmissionInput) => PeerAdmissionResult;
    get: (senderSessionId: string, requestId: string) => PeerOutboxRecord | null;
  };
  /**
   * HMAC-SHA256 of `input` under VibeSpace's own signing secret (base64url).
   * Lets a plugin verify a capability minted by something that shares that
   * secret without ever seeing the secret itself.
   */
  hmacSha256: (input: string) => string;
  /** See shared/agent-env.ts — add variables to agent-spawned processes. */
  registerAgentEnvContributor: (contributor: AgentEnvContributor) => () => void;
  /** See shared/agent-env.ts — add instructions and MCP servers to a session's launch. */
  registerAgentLaunchContributor?: (contributor: AgentLaunchContributor) => () => void;
  /**
   * See shared/agent-env.ts — offer a launch-time choice for new sessions. The
   * host shows and stores it; contributors read it from `context.launchOptions`.
   */
  registerLaunchOption?: (declaration: LaunchOptionDeclaration) => () => void;
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
  sessions: Omit<PluginHost['sessions'], 'onMetadataChanged'>;
  runs: PluginHost['runs'];
  interactions?: PluginHost['interactions'];
  getDefaultPermissionMode?: PluginHost['getDefaultPermissionMode'];
  enqueueMessage: PluginHost['enqueueMessage'];
  enqueueMessageChecked?: PluginHost['enqueueMessageChecked'];
  enqueueMessageIfIdle?: PluginHost['enqueueMessageIfIdle'];
  peerOutbox?: PluginHost['peerOutbox'];
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
    sessions: {
      ...deps.sessions,
      onMetadataChanged: (callback) => {
        const unregister = subscribeSessionMetadataChanges(callback);
        state.unregisterContributors.push(unregister);
        return unregister;
      },
    },
    runs: {
      ...deps.runs,
      // A completion subscription is dropped with the plugin, like a contributor.
      ...(deps.runs.onCompleted ? {onCompleted: (callback: (sessionId: string) => void) => {
        const unregister = deps.runs.onCompleted!(callback);
        state.unregisterContributors.push(unregister);
        return unregister;
      }} : {}),
    },
    interactions: deps.interactions,
    getDefaultPermissionMode: deps.getDefaultPermissionMode,
    enqueueMessage: deps.enqueueMessage,
    enqueueMessageChecked: deps.enqueueMessageChecked,
    enqueueMessageIfIdle: deps.enqueueMessageIfIdle,
    peerOutbox: deps.peerOutbox,
    hmacSha256: (input) =>
      crypto.createHmac('sha256', deps.getSigningSecret()).update(input).digest('base64url'),
    registerAgentEnvContributor: (contributor) => {
      const unregister = registerAgentEnvContributor(contributor);
      state.unregisterContributors.push(unregister);
      return unregister;
    },
    registerAgentLaunchContributor: (contributor) => {
      const unregister = registerAgentLaunchContributor(contributor);
      state.unregisterContributors.push(unregister);
      return unregister;
    },
    registerLaunchOption: (declaration) => {
      const unregister = registerLaunchOption(declaration);
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
