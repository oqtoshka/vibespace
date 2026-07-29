import { useEffect, useMemo, useState } from 'react';

import type { ApiSpecKind } from '../../utils/apiSpec';
import PreviewShell from '../../../preview/PreviewShell';
import { usePreviewFullscreen } from '../../../preview/usePreviewFullscreen';

/**
 * Renders an OpenAPI/Swagger or AsyncAPI document with the standard viewers
 * (swagger-ui, @asyncapi/react-component standalone), mirroring the other
 * file previews.
 *
 * Both viewers run inside a sandboxed `srcDoc` iframe with their assets pulled
 * from jsDelivr: it keeps their multi-MB bundles out of the app chunk, and it
 * fully isolates their (notoriously leaky) global CSS. The spec itself is
 * embedded into the document, so nothing but the viewer code leaves the app —
 * the same trust model as the default remote PlantUML server. Live editor
 * content re-renders debounced, like the PlantUML/DBML previews.
 */

type ApiSpecPreviewProps = {
  content: string;
  kind: ApiSpecKind;
};

const RENDER_DEBOUNCE_MS = 700;

// Embeds untrusted spec text as a JS string literal: JSON escaping plus `<`
// escaping so a literal `</script>` in the spec can't break out of the tag.
const toJsStringLiteral = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c');

const buildOpenApiDoc = (spec: string) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
<style>html, body { margin: 0; background: #fff; }</style>
</head>
<body>
<div id="root"></div>
<script src="https://cdn.jsdelivr.net/npm/js-yaml@4/dist/js-yaml.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
(function () {
  var raw = ${toJsStringLiteral(spec)};
  var showError = function (error) {
    var pre = document.createElement('pre');
    pre.style.cssText = 'padding:16px;color:#b91c1c;white-space:pre-wrap;font:13px/1.5 monospace;';
    pre.textContent = String(error);
    document.body.replaceChildren(pre);
  };
  try {
    var spec = jsyaml.load(raw);
    SwaggerUIBundle({ spec: spec, dom_id: '#root', deepLinking: false });
  } catch (error) {
    showError(error);
  }
})();
</script>
</body>
</html>`;

const buildAsyncApiDoc = (spec: string) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@asyncapi/react-component@2/styles/default.min.css">
<style>html, body { margin: 0; background: #fff; }</style>
</head>
<body>
<div id="root"></div>
<script src="https://cdn.jsdelivr.net/npm/@asyncapi/react-component@2/browser/standalone/index.js"></script>
<script>
(function () {
  var raw = ${toJsStringLiteral(spec)};
  try {
    AsyncApiStandalone.render({ schema: raw, config: { show: { sidebar: true } } }, document.getElementById('root'));
  } catch (error) {
    var pre = document.createElement('pre');
    pre.style.cssText = 'padding:16px;color:#b91c1c;white-space:pre-wrap;font:13px/1.5 monospace;';
    pre.textContent = String(error);
    document.body.replaceChildren(pre);
  }
})();
</script>
</body>
</html>`;

export default function ApiSpecPreview({ content, kind }: ApiSpecPreviewProps) {
  // Rebuilding srcDoc reloads the whole viewer, so debounce live edits harder
  // than the image-based previews.
  const [debouncedContent, setDebouncedContent] = useState(content);
  const { isFullscreen, toggleFullscreen } = usePreviewFullscreen();

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedContent(content), RENDER_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [content]);

  const srcDoc = useMemo(
    () => (kind === 'asyncapi' ? buildAsyncApiDoc(debouncedContent) : buildOpenApiDoc(debouncedContent)),
    [debouncedContent, kind],
  );

  // The viewers draw for a light canvas; the surrounding chrome follows the theme.
  return (
    <PreviewShell
      isFullscreen={isFullscreen}
      onToggleFullscreen={toggleFullscreen}
      className="bg-background"
    >
      <iframe
        title={kind === 'asyncapi' ? 'AsyncAPI preview' : 'OpenAPI preview'}
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-popups"
        className="h-full w-full border-0 bg-white"
      />
    </PreviewShell>
  );
}
