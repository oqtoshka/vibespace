# Application control plane and gateway

`server/modules/app-deployments` supplies a manager-owned SQLite registry and
HTTP router, authenticated gateway and UI. It is disabled by default. A deployment
must provide a host runtime controller that satisfies the contract below before
enabling it; this repository does not grant workers container privileges. No Docker socket or signing
key belongs in a user's worker or application.

The service receives verified workspace links, an app-only domain and an
operator signing key. Every read/write resolves the current owner and workspace
identity. Switching a user's workspace never grants the new workspace access to
old deployments. Capacity includes removed apps with retained data (3 per owner,
24 total). Runtime integration must enforce the advertised 256 MiB storage and
memory limits before this API is exposed.

Create requires `name`, workspace-relative `source`, `runtime` (`node`/`python`)
and source-relative `entrypoint`. Hidden/traversing paths and arbitrary runtime
commands are rejected. These lexical checks do not replace the controller's
symlink-safe bounded source snapshot. Each create/start/stop/redeploy/remove
advances a desired generation. A pending generation rejects competing commands.
The controller must write observed state only for its claimed generation, use
leases, preserve the old snapshot on validation failure, retain database storage
on stop/remove, and keep stopped apps stopped across restart.

The router expects a verified `res.locals.workspaceUser`; never set it from a
request body. Configure the public workspace origin to reject sibling-origin
CSRF, including apps hosted under the same registrable domain. Responses are
`no-store`. Errors use 400/401/403/404/409 as appropriate.

Open grants expire after 60 seconds; explicit share grants after seven days.
Both use HMAC-SHA256 over a base64url JSON payload with app identity, access
version, kind, expiry and random nonce. The gateway must verify signature,
current app version, route ownership and controller lease; exchange grants for
host-only secure HTTP-only cookies; make private grants single-use; strip grants
from URLs; and never forward workspace identity/tokens/cookies to app code.
Revocation increments the access version and must close existing gateway streams
as well as reject new requests. An external runtime controller must maintain the route lease and ownership checks.

Tests cover owner/workspace isolation, path/runtime validation, serialized
operations, retained capacity, signed grant contents, revocation versions,
request validation and cross-origin denial.

The dedicated `server/app-gateway.ts` executable now implements grant exchange,
persistent single-use private nonces, host-only `__Host-vs-access` cookies,
credential filtering, HTTP/SSE/WebSocket proxying and active-stream revocation.
It consumes a controller-owned JSON file `{expiresAt, apps:[{id,hostname,address,
port:8080,version,status:"running"}]}`. An unreadable or expired registry denies
access. The gateway has no Docker or workspace access. The gateway bounds nonce storage and active streams. Runtime deployment is
an operator integration and must be tested separately with real storage and networks.

Cookie scoping follows [MDN's Set-Cookie reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).
A normal internal Docker bridge still exposes host services on the bridge;
the runtime needs Docker 28+ isolated gateway mode or equivalent tested firewall
rules, as described by [Docker gateway modes](https://docs.docker.com/engine/network/port-publishing/).

Manager integration is gated by `VS_APPS_ENABLED=true` and requires
`VS_APPS_CONTROL_DB`, `VS_APPS_DOMAIN`, and `VS_APPS_SIGNING_KEY_FILE`.
`VS_APPS_OWNER_LIMIT` / `VS_APPS_TOTAL_LIMIT` override the default 3/24 retained
application capacities. The UI remains hidden while the feature is disabled.
`AppControlPanel` supplies lifecycle actions, logs and explicit sharing/revocation.
Agent clients can call only this API with `X-Vibespace-App-Token` containing their
current worker token. The manager derives their owner from the live enabled
worker registry, rejects ambiguous mappings, and does not extend this auth method
to other manager endpoints. Workers receive no app signing key.

When hosting is enabled, the manager requires the exact public workspace origin
(`VS_APPS_WORKSPACE_ORIGIN`, or the origin of `VS_OIDC_REDIRECT_URI`). It rejects
other browser origins on **all** writes and WebSocket upgrades, including legacy
worker endpoints. Sibling app subdomains are same-site for cookies: SameSite
alone does not provide that boundary. Manager pages also restrict framing to their
own origin, so a sibling app cannot embed the workspace UI. Native token clients without Origin remain
supported. Use an app-only domain and do not weaken this gate at the edge.
