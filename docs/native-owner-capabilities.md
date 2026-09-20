# Native owner capability lookup

Federation clients can call
`GET /api/native-control/sessions/:id/owner-capability` before an owner action.
The existing federation credential and single active operator are required;
browser Origin requests are refused. Responses must not be cached.
IDs use the existing viewer grammar (1–120 ASCII letters, digits, dots, underscores
or hyphens), including imported OpenCode IDs; they are not limited to app UUIDs.

A successful lookup echoes `sessionId` and returns `state: active` or
`state: archived` with a session capability. Only ordinary sessions with known
non-private, non-side metadata qualify. Invalid IDs and private/side sessions
are refused. An authoritative database lookup finding no row returns
`state: missing` without a capability. Database errors and network failures do
not mean missing and must not trigger deletion of the client's projection.

The describe endpoint and owner lookup now issue v2 capabilities. Each lasts
fifteen minutes and is signed with a separate random installation secret in
`app_config.mc_session_capability_secret_v2`. Browser JWT rotation neither mints
nor revokes session capabilities. Invalid signing state fails closed; it is not
a reason to overwrite the existing key. Rotating that dedicated secret revokes
old capabilities. No v1 fallback exists in an upgraded core.

Native chat verifies authorization on input/output and closes expired idle
channels with retryable code1012. A backend-only `native.renew` frame can extend
a still-valid lease with a newer same-session credential. It cannot revive an
expired channel or authorize a private/side/missing session. Disconnecting the
viewer does not abort the agent. Mission Control must deploy proactive renewal
and block client-originated renewal frames before this owner upgrade.

Plugin hosts expose `verifySessionCapability(sessionId, supplied)`. Integration
routes must delegate to it without retrying legacy HMAC on refusal. Upgrade the
private integration plugin before switching the core issuer. Reporter snapshots
are no longer an authorization source; removing their old JWT-secret reads is a
separate client migration and must not grant them the new signing secret.
