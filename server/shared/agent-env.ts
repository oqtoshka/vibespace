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
};

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
