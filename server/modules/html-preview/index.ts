// HTML preview routes use these services to authorize entries and every iframe asset.
export {
  resolveHtmlPreviewAsset,
  resolveHtmlPreviewEntry,
} from './services/html-preview.service.js';

// Legacy server and share routes consume the preview rendering primitives through this module.
export {
  isTextAsset,
  resolveCustomRenderer,
  resolvePreviewAssetPath,
  resolvePreviewModel,
  rewriteAssetReferences,
  wireFlowCrossLinks,
} from './services/html-preview-rendering.service.js';
