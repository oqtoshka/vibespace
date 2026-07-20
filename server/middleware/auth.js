import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { userDb, appConfigDb } from '../modules/database/index.js';
import {
  IS_PLATFORM,
  IS_WORKER_MODE,
  WORKER_USER_HEADER,
  WORKER_TOKEN_HEADER
} from '../constants/config.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Usernames become filesystem-adjacent identifiers downstream, so keep them boring.
const WORKER_USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * Verifies the manager's shared secret in constant time.
 *
 * Reachability is not an authentication boundary here: on the target deployment
 * the agent gateway shares a network namespace with the manager and sibling
 * workers sit on the same bridge, so anyone who can route to a worker could
 * otherwise forge an identity header. When VS_WORKER_TOKEN is unset (laptop
 * runs, tests) the check is skipped.
 */
const hasValidWorkerToken = (req) => {
  const expected = process.env.VS_WORKER_TOKEN;
  if (!expected) return true;

  const presented = req.headers[WORKER_TOKEN_HEADER];
  if (typeof presented !== 'string') return false;

  const expectedBuf = Buffer.from(expected);
  const presentedBuf = Buffer.from(presented);
  if (expectedBuf.length !== presentedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, presentedBuf);
};

/**
 * Resolves the worker's single tenant, creating the row on first contact.
 *
 * Workers never run a login flow, so the stored hash is a placeholder that no
 * bcrypt comparison can ever match. The row is read back through getUserById so
 * `req.user` carries the same public columns the JWT path exposes.
 */
const ensureWorkerUser = (username) => {
  const existing = userDb.getUserByUsername(username);
  if (existing) return userDb.getUserById(existing.id);

  const created = userDb.createUser(username, 'managed:no-password');
  return userDb.getUserById(created.id);
};

/**
 * Reads the manager-stamped identity off a request, or null if it isn't
 * trustworthy. Shared by the HTTP middleware and the WebSocket verifier.
 */
const readWorkerIdentity = (req) => {
  if (!hasValidWorkerToken(req)) return null;

  const raw = req.headers[WORKER_USER_HEADER];
  const username = Array.isArray(raw) ? raw[0] : raw;
  if (typeof username !== 'string' || !WORKER_USERNAME_PATTERN.test(username)) {
    return null;
  }

  return ensureWorkerUser(username);
};

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  // Worker mode: the manager already authenticated the user and re-stamped the
  // identity header, so any Authorization header carries a manager-signed token
  // this process has no key for. Trust the header instead.
  if (IS_WORKER_MODE) {
    try {
      const user = readWorkerIdentity(req);
      if (!user) {
        return res.status(401).json({ error: 'Worker mode: missing or invalid managed identity' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Worker mode auth error:', error);
      return res.status(500).json({ error: 'Worker mode: failed to resolve user' });
    }
  }

  // Platform mode:  use single database user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token. User not found.' });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token) => {
  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    return { userId: user.id, username: user.username };
  } catch (error) {
    console.error('WebSocket token verification error:', error);
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  ensureWorkerUser,
  readWorkerIdentity,
  JWT_SECRET
};
