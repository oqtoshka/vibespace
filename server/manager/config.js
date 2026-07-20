import crypto from 'crypto';

/**
 * Manager configuration, assembled from the environment.
 *
 * The user map arrives base64-encoded (`VS_MANAGER_USERS_B64`) because the raw
 * JSON travels badly: bcrypt hashes start with `$2b$`, which dotenv-style files
 * expand, and CI secret masking rejects values containing braces and quotes.
 * The plain form is still accepted for local development.
 */

const DEFAULT_PORT = 7000;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function parseUserMap(env) {
  const encoded = env.VS_MANAGER_USERS_B64;
  const plain = env.VS_MANAGER_USERS;

  if (!encoded && !plain) {
    throw new Error('Manager requires VS_MANAGER_USERS_B64 (or VS_MANAGER_USERS) to be set.');
  }

  let raw = plain;
  if (encoded) {
    try {
      raw = Buffer.from(encoded, 'base64').toString('utf8');
    } catch {
      throw new Error('VS_MANAGER_USERS_B64 is not valid base64.');
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Manager user map is not valid JSON: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Manager user map must be a JSON object keyed by username.');
  }

  const credentials = new Map();
  const links = new Map();

  for (const [username, entry] of Object.entries(parsed)) {
    if (!USERNAME_PATTERN.test(username)) {
      throw new Error(`Invalid username in manager user map: "${username}".`);
    }
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Manager user "${username}" must map to an object.`);
    }
    if (typeof entry.passwordHash !== 'string' || !entry.passwordHash) {
      throw new Error(`Manager user "${username}" is missing passwordHash.`);
    }
    if (typeof entry.upstream !== 'string' || !entry.upstream) {
      throw new Error(`Manager user "${username}" is missing upstream.`);
    }

    try {
      // Fail at boot rather than on the first proxied request.
      new URL(entry.upstream);
    } catch {
      throw new Error(`Manager user "${username}" has an invalid upstream URL: ${entry.upstream}`);
    }

    credentials.set(username, entry.passwordHash);
    links.set(username, {
      user_id: username,
      upstream: entry.upstream,
      workerToken: typeof entry.workerToken === 'string' ? entry.workerToken : null,
      workspace_dir: typeof entry.workspaceDir === 'string' ? entry.workspaceDir : null,
      enabled: entry.enabled !== false,
    });
  }

  if (links.size === 0) {
    throw new Error('Manager user map is empty — no users could log in.');
  }

  return { credentials, links };
}

function resolveJwtSecret(env) {
  if (env.VS_MANAGER_JWT_SECRET) return env.VS_MANAGER_JWT_SECRET;

  // Falling back keeps `vibespace manager` runnable for a quick local try, but
  // every restart invalidates outstanding sessions — never what you want in a
  // deployment, hence the noise.
  console.warn(
    '[WARN] VS_MANAGER_JWT_SECRET is not set — generating an ephemeral secret. ' +
    'All sessions will be invalidated when this process restarts. Set it in production.'
  );
  return crypto.randomBytes(48).toString('hex');
}

export function loadManagerConfig(env = process.env) {
  const { credentials, links } = parseUserMap(env);

  return {
    credentials,
    links,
    jwtSecret: resolveJwtSecret(env),
    port: Number.parseInt(env.VS_MANAGER_PORT || String(DEFAULT_PORT), 10),
    host: env.VS_MANAGER_HOST || env.HOST || '0.0.0.0',
    authKind: env.VS_MANAGER_AUTH || 'password',
    backendKind: env.VS_WORKER_BACKEND || 'static',
    cookieSecure: env.VS_MANAGER_COOKIE_SECURE || 'auto',
  };
}
