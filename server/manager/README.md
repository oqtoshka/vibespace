# VibeSpace manager (multi-user mode)

The manager fronts a set of per-user **workers**. It owns the public port and
the login flow; each worker is the ordinary single-user VibeSpace server running
with its own database, home directory and workspace. The single-user assumption
stays true *inside* a worker — isolation comes from running one per user rather
than from row-level tenancy.

```
browser ──▶ manager :7000            (auth, static SPA, reverse proxy)
              ├──▶ worker "main"   :7100   HOME=/…/main    DATABASE_PATH=…
              └──▶ worker "sanyaz" :7100   HOME=/…/sanyaz  DATABASE_PATH=…
```

## Modes

`VIBESPACE_MODE` is normalized in `server/load-env.js`; anything unrecognized
falls back to `local`, so an unset value can never turn a single-user install
into one that trusts identity headers.

| value | meaning |
|---|---|
| `local` | single-user, password + JWT. The default. |
| `multi` | this process is the manager. |
| `worker` | this process serves one user behind a manager. |

## How a request is authenticated

1. The browser logs in against the manager and gets a JWT (also set as an
   httpOnly session cookie, so cookie-only requests such as preview-iframe
   subresources still route).
2. The manager verifies it, strips any client-supplied `X-Vibespace-User` and
   `X-Vibespace-Worker-Token`, and re-stamps both from the identity it just
   established.
3. The worker trusts `X-Vibespace-User` and auto-provisions the row on first
   contact. It never runs a login flow — `/api/auth/login` and `/register`
   return 403.

`VS_WORKER_TOKEN` is what makes step 3 safe. Reachability is not an
authentication boundary: sibling workers share a network, and in the openclaw
deployment the agent gateway shares the manager's network namespace. Without a
shared secret, anything that can route to a worker could name itself another
tenant. Set it in any deployment where a worker is reachable by something other
than the manager.

## Extension points

Both seams are selected by env and dispatched through a registry, so a
downstream deployment adds a file and a `case` rather than editing the proxy.

**Identity resolvers** (`resolvers/`, `VS_MANAGER_AUTH`) turn a request into
`{ userId, link }`. Upstream ships `password` and `oidc`. A deployment that
authenticates some other way — client certificates, a bespoke SSO — registers
its own resolver; the manager core never inspects a token itself. The session
half (JWT, cookie, refresh) is shared by all of them in `resolvers/session.js`,
so a new resolver only writes a login flow.

```
resolveUser(req, url)      -> { userId, link, refreshedToken? }
                            | { error: 'unauthenticated'|'unmapped'|'disabled'|'unavailable' }
resolveSessionCookie(req)  -> { userId, link } | null
router                     -> express.Router mounted at /api/auth, or null
```

**Worker backends** (`backends/`, `VS_WORKER_BACKEND`) map a link to a reachable
address. Upstream ships `static` (workers the deployment already runs). A
backend that owns worker processes — forking them, or starting a container per
tenant — implements the same interface. The manager calls every lifecycle hook
at the right point even though the static backend no-ops most of them, so such a
backend is a drop-in:

```
getOrStartWorker(link)            -> Promise<{ host, port, workerToken?, userId }>
touch(userId)                      — request activity, for idle tracking
noteWebSocketOpened/Closed(userId) — a worker with an open socket is in use
invalidateWorker(userId, entry)    — the proxy saw this worker fail
stopAll()                          — shutdown
```

`preAuthHandlers` in `index.js` is the insertion point for handlers that must
run before authentication (for example, manager-side egress proxies that stamp
credentials workers are not allowed to hold).

## Configuration

Manager:

| variable | default | purpose |
|---|---|---|
| `VS_MANAGER_USERS_B64` | — | base64 of the user map JSON (required) |
| `VS_MANAGER_USERS` | — | same map, unencoded; for local development |
| `VS_MANAGER_JWT_SECRET` | ephemeral | session signing key. Unset means sessions die with the process. |
| `VS_MANAGER_PORT` / `VS_MANAGER_HOST` | `7000` / `0.0.0.0` | bind |
| `VS_MANAGER_AUTH` | `password` | identity resolver |
| `VS_WORKER_BACKEND` | `static` | worker backend |
| `VS_MANAGER_COOKIE_SECURE` | `auto` | `auto` follows `X-Forwarded-Proto` |

The user map is base64-encoded because the raw JSON travels badly: bcrypt
hashes start with `$2b$`, which dotenv-style files expand, and CI secret
masking rejects values containing braces and quotes.

```json
{
  "main":   { "passwordHash": "$2b$12$…", "upstream": "http://127.0.0.1:7101", "workerToken": "…" },
  "sanyaz": { "passwordHash": "$2b$12$…", "upstream": "http://127.0.0.1:7102", "workerToken": "…", "enabled": false }
}
```

## Single sign-on (`VS_MANAGER_AUTH=oidc`)

Authorization code flow with PKCE against any OpenID Connect provider. The
provider proves *who* someone is; the user map still decides *whether* they get
in and which worker they land on — an identity provider usually serves more
than this one application, so "authenticated" is not "authorized". A user the
provider knows but the map does not gets `unmapped`, exactly as a stale session
would. Under `oidc` the map's `passwordHash` becomes optional and the entry
degenerates to an allow-list plus a worker address.

Once the callback succeeds the session is the ordinary manager JWT — same
cookie, same refresh, same proxy path. Nothing downstream of login changes, and
workers stay unaware there is an identity provider at all.

| variable | purpose |
|---|---|
| `VS_OIDC_ISSUER` | e.g. `https://auth.example.com/application/o/vibespace/` — keep the trailing slash Authentik gives you |
| `VS_OIDC_CLIENT_ID` / `VS_OIDC_CLIENT_SECRET` | provider credentials; the secret is optional (public client + PKCE) |
| `VS_OIDC_REDIRECT_URI` | must match the provider's registration exactly; derived from the request when unset |
| `VS_OIDC_USERNAME_CLAIM` | default `preferred_username`; must resolve to a username-shaped value, since it is the map key and the `X-Vibespace-User` value |
| `VS_OIDC_ALLOWED_USERS` | optional extra allow-list; the user map is already the authority here |
| `VS_OIDC_LABEL` | button text — "Continue with Authentik" |
| `VS_OIDC_SCOPES` | default `openid profile email` |
| `VS_OIDC_END_SESSION_ON_LOGOUT` | also end the provider's session, so logout is not undone by a silent re-login |

`/api/auth/login` and `/register` stay mounted and answer 403: a live password
endpoint would be a way around SSO, not a fallback for it.

### Authentik setup

1. Create an **OAuth2/OpenID Provider**: authorization code flow, client type
   confidential, redirect URI `https://<host>/api/auth/oidc/callback` (exact
   match, no trailing slash).
2. Sign it to an **Application** and copy the *OpenID Configuration Issuer*
   from the provider page into `VS_OIDC_ISSUER`.
3. Make sure the username Authentik sends matches a key in the user map. If
   your usernames are email addresses, point `VS_OIDC_USERNAME_CLAIM` at a
   claim that is not — a value like `you@example.com` is refused rather than
   sanitized, because rewriting it would route the login to a tenant nobody
   named.
4. Bind whatever policy decides who may use VibeSpace to the application; the
   user map is a second gate, not the first one.

The single-user server (`VIBESPACE_MODE=local`) reads the same `VS_OIDC_*`
variables and needs no `VS_MANAGER_AUTH`. There `VS_OIDC_ALLOWED_USERS` is
**required** — it is the only allow-list, since there is no user map — and the
first successful sign-in provisions the one local user row.

Worker: `VIBESPACE_MODE=worker`, `SERVER_PORT`, `VS_WORKER_TOKEN`, plus the
ordinary `DATABASE_PATH`, `HOME` and `WORKSPACES_ROOT` — pointed somewhere
different for each user, which is what actually separates the tenants.

## Running it locally

```bash
npm run build

# one worker per user
VIBESPACE_MODE=worker SERVER_PORT=7101 HOST=127.0.0.1 \
  DATABASE_PATH=/tmp/vs-main/auth.db HOME=/tmp/vs-main WORKSPACES_ROOT=/tmp/vs-main/workspace \
  VS_WORKER_TOKEN=tok-main node dist-server/server/index.js

# the manager
VIBESPACE_MODE=multi VS_MANAGER_PORT=7000 VS_MANAGER_JWT_SECRET=dev \
  VS_MANAGER_USERS_B64="$(node -e "
    const bcrypt=require('bcrypt');
    console.log(Buffer.from(JSON.stringify({
      main:{passwordHash:bcrypt.hashSync('pw',12),upstream:'http://127.0.0.1:7101',workerToken:'tok-main'}
    })).toString('base64'));
  ")" \
  vibespace manager
```

## Share links

Public share links (`/api/share/:shareId/…`) carry no identity, so there is no
session to route them by. The manager asks instead: on a cache miss it probes
every enabled worker's `/api/share/:shareId/meta` and forwards to the one that
answers 200 (or 410 — the link is real, its file is gone). Ownership is fixed
at mint time, so a hit is cached; expiry and revocation are still decided by
the owning worker on every request.

The shareId is 24 random bytes and is itself the capability, so offering it to
each worker discloses nothing its holder does not already have. A share no
worker claims gets the same 404 the owning worker would have returned.

## Limitations

- `/api/agent` (API-key auth) and browser-use MCP bridges authenticate with
  schemes the manager does not understand; those clients must reach a worker
  directly on the internal network.
- A worker updated via `/api/system/update` updates only itself. Deployments
  that build a worker image should roll the image instead.
