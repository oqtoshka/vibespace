import { run } from '@softwaretechnik/dbml-renderer';

/**
 * Renders DBML source into an SVG string.
 *
 * Uses `@softwaretechnik/dbml-renderer` (the graphviz-via-wasm renderer that the
 * VSCode DBML extensions use) — pure JS/wasm, so it needs no native binary. The
 * call is synchronous and throws on a DBML parse/check error; callers should
 * catch and surface the message.
 *
 * @param {string} source - DBML document text.
 * @returns {string} SVG markup.
 */
export function renderDbmlToSvg(source) {
  return run(source, 'svg');
}
