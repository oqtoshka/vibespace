# Read-only Office preview

Open PPT/PPTX, DOC/DOCX, XLS/XLSX or ODP/ODT/ODS from the file tree or a chat
file link. VibeSpace converts the document to PDF and uses its built-in browser
PDF viewer: pages, zoom and printing. Download original keeps the original
format. Slides are static; spreadsheets follow their print layout. Animations,
editing, embedded media and interactive spreadsheet controls are not supported.
Fonts and pagination can differ from Microsoft Office. Password-protected and
malformed documents display an error with retry and original download available.

## Server configuration

Set `VS_OFFICE_CONVERTER_URL` to a trusted self-hosted Gotenberg LibreOffice
conversion endpoint, for example `http://office-converter:3000/forms/libreoffice/convert`.
The server sends one multipart field `files` with a neutral filename; no user
paths or workspace credentials are forwarded. This is an optional server feature:
without configuration the UI explains that preview is unavailable and offers the
original. No documents are sent to Microsoft, Google or an external viewer.

Use Gotenberg 8.34+ with macro execution disabled (the default), linked content
blocked, all LibreOffice outbound URLs denied, downloadFrom and webhooks disabled,
and Chromium/PDF-engine routes disabled. Run it unprivileged with no workspace
mounts, bounded RAM/CPU/tmp storage and an isolated network. Expose its conversion
route only to VibeSpace, behind deployment-owned authentication where needed.
The converter URL is operator configuration and must not be user-controlled.
See https://gotenberg.dev/docs/configuration and
https://gotenberg.dev/docs/convert-with-libreoffice/convert-to-pdf.

`GET /api/office-preview/:projectId?path=...` requires the normal file API
authentication. Absolute or relative paths must resolve inside that project's
canonical root; symlink escapes, non-regular files and unsupported extensions
are rejected. Original bytes are never modified. File size limit: 25 MiB;
converted result: 64 MiB; deadline: 60 seconds; two in-flight requests per worker.
The private worker cache holds up to 16 PDFs / 32 MiB for five minutes, keyed by
source content and format; authorization is checked again before cache lookup.
Responses use `Cache-Control: no-store`. Closing the viewer aborts the request.

The converter is a trusted document parser. Treat its patching and process/network
isolation as part of operating this feature, not as a substitute for path checks.
