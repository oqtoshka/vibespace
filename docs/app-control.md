# Application control plane (runtime integration in progress)

`server/modules/app-deployments` supplies a manager-owned SQLite registry and
HTTP router. It is not mounted by default and does not yet deploy containers.
A deployment needs the external runtime controller, authenticated gateway and
UI/agent integration before enabling this feature. No Docker socket or signing
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
as well as reject new requests. Generating a grant does not make an unimplemented
gateway secure: these are required integration checks, not completed claims.

Tests cover owner/workspace isolation, path/runtime validation, serialized
operations, retained capacity, signed grant contents, revocation versions,
request validation and cross-origin denial.
