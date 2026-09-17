/**
 * The environment handed to agent-spawned processes.
 *
 * Every command an agent runs is a child of this server, so without filtering it
 * inherits the server's whole environment. That is two problems, not one:
 *
 *   1. Secrets. VibeSpace's own auth material — the JWT signing key, the OIDC
 *      client secret, the worker token — would be readable by any dev server,
 *      npm lifecycle script or test an agent happens to run.
 *   2. Ports. `PORT` is the most generic variable in web tooling (Nest, Next,
 *      Vite, Rails and Django all read it), so an inherited `PORT` makes any dev
 *      server an agent starts bind VibeSpace's own port. That happened twice
 *      with an unrelated project before this filter existed.
 *
 * The filter is a denylist rather than an allowlist because forwarding host
 * variables is deliberate: ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN,
 * ANTHROPIC_BASE_URL and friends come from the operator's shell and the agent
 * genuinely needs them. That also rules out matching on name patterns like
 * /SECRET|TOKEN|KEY/ — it would strip exactly those credentials. So the rule is
 * narrower and checkable: what VibeSpace configures *for itself* stays with
 * VibeSpace.
 */

/** Keys VibeSpace reads as its own server configuration. */
const SERVER_ONLY_KEYS = new Set([
  // Listen configuration. See vibespace-wrapper.sh, which deliberately stops
  // exporting PORT for the same reason.
  'PORT',
  'SERVER_PORT',
  'HOST',
  'VITE_PORT',
  // VibeSpace's own auth material. JWT_SECRET is the sharpest of these: it signs
  // session tokens, so leaking it lets a child process forge authentication.
  'JWT_SECRET',
  'API_KEY',
  'VS_WORKER_TOKEN',
  // Upstream credentials VibeSpace proxies with on the user's behalf.
  'VOICE_API_KEY',
  'CLOUDCLI_BROWSER_USE_MCP_TOKEN',
  // Server-private state.
  'DATABASE_PATH',
]);

/** Whole families of server-only keys. */
const SERVER_ONLY_PREFIXES = ['VS_OIDC_'];

/**
 * Keys load-env.js injected into process.env from VibeSpace's own .env file (and
 * its own defaults). Registering them keeps this filter correct when someone adds
 * a new secret to .env without also editing the list above.
 */
const registeredServerConfigKeys = new Set<string>();

export function registerServerConfigKey(key: string): void {
  registeredServerConfigKeys.add(key);
}

export function isServerOnlyEnvKey(key: string): boolean {
  return (
    SERVER_ONLY_KEYS.has(key) ||
    registeredServerConfigKeys.has(key) ||
    SERVER_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * Build the environment for a process spawned on an agent's behalf.
 *
 * @param overrides applied after filtering, so a caller can still set a key
 *   deliberately (opencode's permission flags rely on this).
 * @param source defaults to process.env; injectable for tests.
 */
export function buildAgentEnv(
  overrides: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isServerOnlyEnvKey(key)) continue;
    env[key] = value;
  }

  return { ...env, ...overrides };
}

// ----------------- PER-SPAWN ENV CONTRIBUTORS ------------

/**
 * What a spawn is for, handed to every registered contributor so it can decide
 * whether to add anything.
 *
 * - `scope: 'session'` — a process that serves exactly one conversation (the
 *   Claude SDK subprocess, an OpenCode CLI run). `sessionId` is set when known.
 * - `scope: 'server'`  — a long-lived helper shared by every conversation of
 *   its kind (the Codex app-server, the OpenCode HTTP server). Such a server is
 *   spawned per *variant*: `private: true` names the variant that hosts private
 *   sessions, so a contributor can gate it without knowing about sessions.
 * - `private` is the user's choice to keep a conversation off external
 *   presence/notification channels; `ephemeral` marks an internal one-shot
 *   helper turn (title, recap, commit message) that is not a conversation at all.
 */
export type AgentEnvContext = {
  provider: 'claude' | 'codex' | 'opencode' | 'cursor';
  scope: 'session' | 'server';
  private?: boolean;
  ephemeral?: boolean;
  sessionId?: string | null;
  /**
   * The launch options the session was created with: option id → value, for
   * the options host plugins declared (see registerLaunchOption). Like
   * `private`, chosen at creation and fixed after. What an option means to the
   * harness — which variables, which tool server, which instructions — is the
   * declaring plugin's business (see collectAgentLaunchExtras).
   */
  launchOptions?: SessionLaunchOptions | null;
};

// ----------------- PLUGIN-DECLARED LAUNCH OPTIONS ------------

/** Option id → value: `true`, or a small JSON object the declaring plugin defines. */
export type SessionLaunchOptions = Record<string, unknown>;

/**
 * A launch-time choice a host plugin offers for new sessions. The host knows
 * nothing about what it means: it shows the toggle, stores the choice on the
 * session row and hands it to every env/launch contributor. With no plugin
 * declaring anything the composer shows nothing.
 */
export type LaunchOptionDeclaration = {
  /** Namespaced by the plugin, e.g. `acme.review-mode`. */
  id: string;
  /** Toggle text while on; `offLabel` while off (defaults to `label`). */
  label: string;
  offLabel?: string;
  tooltip?: string;
  /** One line under the composer while on / off. */
  hint?: string;
  offHint?: string;
  /** Shown in the header of a session that was started with the option. */
  badge?: string;
  badgeHint?: string;
  /** Providers the option applies to; all of them when omitted. */
  providers?: string[];
};

const launchOptionDeclarations = new Map<string, LaunchOptionDeclaration>();
const LAUNCH_OPTION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LAUNCH_OPTION_VALUE_LIMIT = 2048;

/** Declares a launch option; returns the unregister function. */
export function registerLaunchOption(declaration: LaunchOptionDeclaration): () => void {
  if (!declaration || !LAUNCH_OPTION_ID.test(declaration.id) || typeof declaration.label !== 'string' || !declaration.label.trim()) {
    throw new Error('A launch option needs an id ([a-z0-9._-]) and a label');
  }
  launchOptionDeclarations.set(declaration.id, { ...declaration });
  return () => {
    launchOptionDeclarations.delete(declaration.id);
  };
}

export function listLaunchOptions(): LaunchOptionDeclaration[] {
  return [...launchOptionDeclarations.values()].map((declaration) => ({ ...declaration }));
}

/**
 * Reduces a client's `launchOptions` to what may be stored: declared ids only,
 * each `true` or a small plain object. `null` when nothing is left. An unknown
 * id is dropped — or, under `strict`, refused, so a remote client learns that
 * the plugin it counts on is not installed here.
 */
export function normalizeLaunchOptions(input: unknown, { strict = false } = {}): SessionLaunchOptions | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid launch options');
  const out: SessionLaunchOptions = {};
  for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === false || value === null || value === undefined) continue;
    if (!launchOptionDeclarations.has(id)) {
      if (strict) throw new Error(`Unknown launch option: ${id}`);
      continue;
    }
    const plain = value === true || (typeof value === 'object' && !Array.isArray(value));
    if (!plain || JSON.stringify(value).length > LAUNCH_OPTION_VALUE_LIMIT) throw new Error(`Invalid launch option: ${id}`);
    out[id] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** Reads a stored `launch_options` cell; anything unreadable is no options. */
export function parseStoredLaunchOptions(cell: unknown): SessionLaunchOptions | null {
  if (typeof cell !== 'string' || !cell) return null;
  try {
    const parsed = JSON.parse(cell);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * What a contributor may add to a session's launch beyond environment
 * variables: text appended to the system prompt (or, for a runtime with no
 * system-prompt channel, put ahead of the first prompt), and MCP servers the
 * session should have. Both are merged over the user's own configuration and
 * never replace it.
 */
export type AgentLaunchExtras = {
  instructions?: string;
  mcpServers?: Record<string, unknown>;
  /**
   * Exact tool names the session may call without a permission prompt —
   * normally the tools of the MCP server the same contributor adds. Without
   * this a session outside bypassPermissions stops on a prompt for every call
   * to a tool the operator never configured and cannot see coming.
   */
  allowedTools?: string[];
};
export type AgentLaunchContributor = (context: AgentEnvContext) => AgentLaunchExtras | null | undefined | void;

const agentLaunchContributors = new Set<AgentLaunchContributor>();

/** Registers a contributor of launch extras; returns the unregister function. */
export function registerAgentLaunchContributor(contributor: AgentLaunchContributor): () => void {
  agentLaunchContributors.add(contributor);
  return () => {
    agentLaunchContributors.delete(contributor);
  };
}

/**
 * Collects every launch contributor's extras for one spawn: instruction blocks
 * are concatenated in registration order, MCP servers merged (later wins on a
 * name clash). A throwing contributor is logged and skipped, never fatal.
 */
export function collectAgentLaunchExtras(context: AgentEnvContext): { instructions: string; mcpServers: Record<string, unknown>; allowedTools: string[] } {
  const blocks: string[] = [];
  let mcpServers: Record<string, unknown> = {};
  const allowedTools = new Set<string>();
  for (const contributor of agentLaunchContributors) {
    let extra: AgentLaunchExtras | null | undefined | void;
    try {
      extra = contributor(context);
    } catch (error) {
      console.warn('[agent-env] launch contributor threw:', error instanceof Error ? error.message : error);
      continue;
    }
    if (!extra) continue;
    if (typeof extra.instructions === 'string' && extra.instructions.trim()) blocks.push(extra.instructions.trim());
    if (extra.mcpServers && typeof extra.mcpServers === 'object') mcpServers = { ...mcpServers, ...extra.mcpServers };
    if (Array.isArray(extra.allowedTools)) {
      for (const tool of extra.allowedTools) if (typeof tool === 'string' && tool) allowedTools.add(tool);
    }
  }
  return { instructions: blocks.join('\n\n'), mcpServers, allowedTools: [...allowedTools] };
}

/**
 * Returns extra variables for a spawn, or nothing. Contributors are consulted in
 * registration order; a later one may override an earlier one's key.
 */
export type AgentEnvContributor = (context: AgentEnvContext) => NodeJS.ProcessEnv | null | undefined | void;

const agentEnvContributors = new Set<AgentEnvContributor>();

/**
 * Registers a contributor that may add variables to agent-spawned processes.
 * Used by plugin host modules (see modules/plugins) — for example to set the
 * presence-reporter opt-out on private and ephemeral spawns — so VibeSpace core
 * carries no knowledge of any particular external integration. Returns the
 * unregister function.
 */
export function registerAgentEnvContributor(contributor: AgentEnvContributor): () => void {
  agentEnvContributors.add(contributor);
  return () => {
    agentEnvContributors.delete(contributor);
  };
}

/**
 * Collects every contributor's variables for one spawn. Used by each provider
 * runtime right where it assembles the child environment; the result is merged
 * over the filtered host env, so contributors can only add or override, never
 * remove.
 */
export function collectAgentEnv(context: AgentEnvContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const contributor of agentEnvContributors) {
    let extra: NodeJS.ProcessEnv | null | undefined | void;
    try {
      extra = contributor(context);
    } catch (error) {
      console.warn('[agent-env] contributor failed:', (error as Error)?.message ?? error);
      continue;
    }
    if (!extra) continue;
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  return env;
}
