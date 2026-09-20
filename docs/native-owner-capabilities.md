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

This is an additive protocol for staged client renewal. The existing describe
endpoint remains compatible. It does not yet change the v1 capability format,
give it an expiry time, or separate its signing secret from browser JWTs.
