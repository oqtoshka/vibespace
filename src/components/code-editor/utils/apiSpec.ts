export type ApiSpecKind = 'openapi' | 'asyncapi';

const SPEC_EXTENSIONS = new Set(['yaml', 'yml', 'json']);

/**
 * Detects OpenAPI/Swagger/AsyncAPI documents among plain .yaml/.yml/.json
 * files. The extension alone can't tell a spec from any other config file, so
 * this sniffs for the spec's mandatory version field: a top-level `openapi:`,
 * `swagger:` or `asyncapi:` key whose value starts with a version number.
 */
export function detectApiSpecKind(fileName: string, content: string): ApiSpecKind | null {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (!extension || !SPEC_EXTENSIONS.has(extension) || !content) {
    return null;
  }

  if (extension === 'json') {
    if (/"asyncapi"\s*:\s*"\d/.test(content)) return 'asyncapi';
    if (/"(openapi|swagger)"\s*:\s*"\d/.test(content)) return 'openapi';
    return null;
  }

  // YAML: unindented key → top level; value may be quoted or bare.
  if (/^["']?asyncapi["']?\s*:\s*["']?\d/m.test(content)) return 'asyncapi';
  if (/^["']?(openapi|swagger)["']?\s*:\s*["']?\d/m.test(content)) return 'openapi';
  return null;
}
