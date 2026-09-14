# Native workspace preview

A native client can embed the same read-only file renderers used by the web editor. Build them with `npm run build:native-viewer`: `dist-native-viewer/viewer.js` and its CSS are standalone resources. The native host supplies an index page, installs a promise-reply `workspace` bridge, and calls `mcOpen` with a document. No web login, browser JWT or session capability is bundled.

The host must accept bridge operations only from its trusted main frame. Project HTML runs in a separate origin/frame, including its CSS, scripts, fonts and images. The renderer reuses Markdown, images/PDF/media, CSV/TSV, PlantUML/DBML, API specifications and configured project renderers. Standard API specification viewers and PlantUML retain their existing network dependencies. Sources are read only.

`POST /api/native-workspace/sessions/:id` is a federation-only route. It rejects browser Origin headers and requires the existing native-control federation credential and single active operator. Each call resolves an ordinary, non-private, non-side session again, obtains its canonical project root, and validates every requested file and asset through realpath. A caller cannot supply a root, upstream URL, shell command or filesystem write. Existing project renderer commands come only from project configuration.

Operations are `context`, `list`, `read`, `html`, `asset`, `render` and `stat`. Files are bounded to 32 MiB, directory listings to 2,000 entries and stat batches to 128 paths. HTML aliases must resolve within the session root. Missing files, unavailable assets and disconnected services return explicit errors. File-based PlantUML includes are independently root checked; inline diagram snippets cannot include files.

A native client owns session selection, project-scoped file tabs, polling and input. `mcChanged` refreshes the selected document, while `mcSuspend` clears it. The existing web editor is unaffected unless the host explicitly installs `setNativeViewerTransport`.

Verification: module service and HTTP tests exercise populated content, directory traversal, symlink escape, HTML/CSS assets, filesystem changes, federation authentication, Origin rejection and private/side sessions. A browser fixture also checks Markdown links/images, HTML scripts/forms, CSV populated values, DBML, OpenAPI and read-only code.
