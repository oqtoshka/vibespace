import { promises as fs, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Shared chat-attachment plumbing for every provider runtime.
 *
 * Uploaded chat files are persisted once in the global `~/.vibespace/assets`
 * folder and referenced by absolute path everywhere else:
 * - Claude: paths are read back into base64 `image` content blocks.
 * - Codex: paths become `local_image` input items.
 * - General files: verified paths are appended inside a `<files_input>` tag,
 *   which every provider history adapter strips back out for display.
 * - Cursor/OpenCode images: paths use the equivalent `<images_input>` tag.
 *
 * The chat UI loads them through dedicated `/api/assets/images/:filename` and
 * `/api/assets/files/:filename` routes, which serve only from this folder.
 */

/** Global storage folder for uploaded chat image attachments. */
export function getGlobalImageAssetsDir(): string {
  return path.join(os.homedir(), '.vibespace', 'assets');
}

export type ImageAttachmentDescriptor = {
  /** Project-relative (preferred) or absolute path to the stored image. */
  path: string;
  name?: string;
  mimeType?: string;
  size?: number;
};

/** Provider-neutral descriptor used for both image and non-image chat attachments. */
export type ChatAttachmentDescriptor = ImageAttachmentDescriptor;

const SAFE_INLINE_TOOL_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);

function readSafeImageDataUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^data:(image\/[a-z0-9.+-]+);base64,[a-z0-9+/=\s]+$/i.exec(value);
  return match && SAFE_INLINE_TOOL_IMAGE_TYPES.has(match[1].toLowerCase()) ? value : null;
}

/**
 * Extracts inline raster images from provider tool-result payloads. Codex,
 * Claude, Cursor, and OpenCode adapters use this at their normalization
 * boundary so provider-specific image block shapes become the shared
 * `images: [{ data }]` representation consumed by the chat UI.
 */
export function extractToolResultImages(value: unknown): Array<{ data: string }> | undefined {
  const images: Array<{ data: string }> = [];
  const seenData = new Set<string>();
  const seenObjects = new WeakSet<object>();

  const add = (candidate: unknown) => {
    const data = readSafeImageDataUrl(candidate);
    if (data && !seenData.has(data)) {
      seenData.add(data);
      images.push({ data });
    }
  };

  const visit = (candidate: unknown, depth: number) => {
    if (depth > 8 || images.length >= 10 || candidate == null) {
      return;
    }
    add(candidate);
    if (typeof candidate !== 'object') {
      return;
    }
    if (seenObjects.has(candidate)) {
      return;
    }
    seenObjects.add(candidate);

    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item, depth + 1);
      }
      return;
    }

    const record = candidate as Record<string, unknown>;
    add(record.image_url);
    const imageUrlRecord = record.image_url && typeof record.image_url === 'object'
      ? record.image_url as Record<string, unknown>
      : null;
    add(imageUrlRecord?.url);

    const source = record.source && typeof record.source === 'object'
      ? record.source as Record<string, unknown>
      : null;
    if (
      source?.type === 'base64'
      && typeof source.media_type === 'string'
      && SAFE_INLINE_TOOL_IMAGE_TYPES.has(source.media_type.toLowerCase())
      && typeof source.data === 'string'
    ) {
      add(`data:${source.media_type.toLowerCase()};base64,${source.data}`);
    }

    if (
      record.type === 'image'
      && typeof record.mimeType === 'string'
      && SAFE_INLINE_TOOL_IMAGE_TYPES.has(record.mimeType.toLowerCase())
      && typeof record.data === 'string'
    ) {
      add(`data:${record.mimeType.toLowerCase()};base64,${record.data}`);
    }

    for (const child of Object.values(record)) {
      visit(child, depth + 1);
    }
  };

  visit(value, 0);
  return images.length > 0 ? images : undefined;
}
/**
 * Ceiling for base64-inlining an image into a Claude message. Attachments may
 * be as large as the upload cap (200MB), and reading one of those into a ~4/3
 * sized base64 string would exhaust memory for a request the API would reject
 * anyway. Anything above this is handed over as a path instead, like a non-image
 * attachment. Set at the old upload cap so nothing that used to inline stopped.
 */
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/** Media types the Claude Messages API accepts for base64 image blocks. */
const CLAUDE_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const EXTENSION_TO_MEDIA_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Accepts a loosely typed chat attachment payload and returns only well-formed
 * descriptors. The websocket gateway and provider adapters use this to handle
 * current `attachments` payloads and legacy image path arrays consistently.
 */
export function normalizeAttachmentDescriptors(attachments: unknown): ChatAttachmentDescriptor[] {
  if (!Array.isArray(attachments)) {
    return [];
  }

  const descriptors: ChatAttachmentDescriptor[] = [];
  for (const entry of attachments) {
    if (typeof entry === 'string' && entry.trim()) {
      descriptors.push({ path: entry.trim() });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const entryPath = typeof record.path === 'string' ? record.path.trim() : '';
      if (!entryPath) {
        continue;
      }
      const descriptor: ChatAttachmentDescriptor = { path: entryPath };
      if (typeof record.name === 'string') {
        descriptor.name = record.name;
      }
      if (typeof record.mimeType === 'string') {
        descriptor.mimeType = record.mimeType;
      }
      if (typeof record.size === 'number' && Number.isFinite(record.size)) {
        descriptor.size = record.size;
      }
      descriptors.push(descriptor);
    }
  }
  return descriptors;
}

/** Backward-compatible image-specific alias used by existing provider adapters. */
export function normalizeImageDescriptors(images: unknown): ImageAttachmentDescriptor[] {
  return normalizeAttachmentDescriptors(images);
}

const IMAGE_FILE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/**
 * Determines whether the websocket gateway should route an attachment through
 * provider-native image input instead of the general file reference channel.
 */
export function isImageAttachmentDescriptor(descriptor: ChatAttachmentDescriptor): boolean {
  if (descriptor.mimeType && CLAUDE_IMAGE_MEDIA_TYPES.has(descriptor.mimeType)) {
    return true;
  }
  return IMAGE_FILE_EXTENSIONS.has(path.extname(descriptor.path).toLowerCase());
}

/** Normalizes Windows separators so stored references stay portable. */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Resolves a project-relative image path against the run's working directory. */
export function resolveImageAbsolutePath(cwd: string | undefined, imagePath: string): string {
  if (path.isAbsolute(imagePath)) {
    return imagePath;
  }
  return path.resolve(cwd || process.cwd(), imagePath);
}

function isPathInsideDirectory(candidate: string, directory: string): boolean {
  // resolve + startsWith(root + separator) is the containment idiom CodeQL
  // recognizes as a path-injection barrier, and matches the check used by
  // resolveImageAssetFile in the assets module. The root itself never
  // matches (no trailing separator after resolve), only entries below it.
  const resolvedRoot = path.resolve(directory) + path.sep;
  return path.resolve(candidate).startsWith(resolvedRoot);
}

function getDirectoryPathVariants(directory: string): string[] {
  const resolvedDirectory = path.resolve(directory);
  try {
    const canonicalDirectory = path.resolve(realpathSync(directory));
    return canonicalDirectory === resolvedDirectory
      ? [resolvedDirectory]
      : [resolvedDirectory, canonicalDirectory];
  } catch {
    return [resolvedDirectory];
  }
}

/**
 * Second layer of the image trust boundary (the first is the chat.send filter
 * in the websocket gateway): provider builders only reference files that live
 * in the global upload store or inside the run's working directory — places
 * the agent could already access on its own. Anything else (e.g. `~/.ssh`) is
 * refused, so a caller-supplied descriptor can never leak arbitrary files.
 */
export function isAllowedImageSourcePath(resolvedPath: string, cwd?: string): boolean {
  return [getGlobalImageAssetsDir(), cwd || process.cwd()].some((directory) =>
    getDirectoryPathVariants(directory).some((directoryVariant) =>
      isPathInsideDirectory(resolvedPath, directoryVariant)
    )
  );
}

/**
 * Resolves the media type for one image, preferring the uploaded mime type and
 * falling back to the file extension.
 */
export function resolveImageMediaType(descriptor: ImageAttachmentDescriptor): string | null {
  if (descriptor.mimeType) {
    return descriptor.mimeType;
  }
  const extension = path.extname(descriptor.path).toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE[extension] || null;
}

const IMAGES_INPUT_TAG_PATTERN = /\s*<images_input>([\s\S]*?)<\/images_input>\s*/g;

// One image reference recovered from an <images_input> block: the stored
// asset path plus the user's original filename when it was recorded.
export type ParsedImageAttachment = {
  path: string;
  name?: string;
};

// Result of stripping an <images_input> block out of persisted prompt text.
// `imagePaths` mirrors `attachments` for callers that only need paths.
export type ParsedImagesInput = {
  text: string;
  imagePaths: string[];
  attachments: ParsedImageAttachment[];
};

/**
 * Appends the `<images_input>` reference block used by the Cursor and
 * OpenCode CLIs. The block carries one numbered line per attachment with
 * the stored file path (quote-free on purpose — Windows .cmd shims mangle
 * quoted text) and the user's original filename, plus an explicit instruction
 * to read the files and keep the block out of the reply. The same block is
 * stripped back out of persisted history by {@link parseImagesInputTag}.
 */
export function appendImagesInputTag(prompt: string, images: unknown): string {
  const descriptors = normalizeImageDescriptors(images);
  if (descriptors.length === 0) {
    return prompt;
  }

  const entryLines = descriptors.map((descriptor, index) => {
    const entryPath = toPosixPath(descriptor.path);
    // Parentheses and newlines would break the "(original name: ...)" suffix
    // the parser looks for, so drop them from the display name.
    const cleanName = descriptor.name?.replace(/[()\r\n]/g, '').trim();
    return cleanName
      ? `${index + 1}. ${entryPath} (original name: ${cleanName})`
      : `${index + 1}. ${entryPath}`;
  });

  return [
    prompt,
    '',
    '<images_input>',
    `The user attached ${descriptors.length} file(s) to this message. Read each file listed below with your file/image reading tool and use what you see to answer the prompt above. Respond as if the files were attached directly. Do not mention this block or the file paths unless the user asks about them.`,
    ...entryLines,
    '</images_input>',
  ].join('\n');
}

const FILES_INPUT_TAG_PATTERN = /\s*<files_input>([\s\S]*?)<\/files_input>\s*/g;

/**
 * Appends a provider-neutral file reference block to a prompt. Provider agents
 * receive only server-validated paths from the global attachment store and can
 * inspect each file with their normal filesystem tools.
 */
export function appendFilesInputTag(prompt: string, files: unknown): string {
  const descriptors = normalizeAttachmentDescriptors(files);
  if (descriptors.length === 0) {
    return prompt;
  }

  const entryLines = descriptors.map((descriptor, index) => {
    const entryPath = toPosixPath(descriptor.path);
    const cleanName = descriptor.name?.replace(/[()\r\n]/g, '').trim();
    return cleanName
      ? `${index + 1}. ${entryPath} (original name: ${cleanName})`
      : `${index + 1}. ${entryPath}`;
  });

  return [
    prompt,
    '',
    '<files_input>',
    `The user attached ${descriptors.length} file(s) to this message. Read each file listed below with your file reading tools and use its contents to answer the prompt above. Do not mention this block or the file paths unless the user asks about them.`,
    ...entryLines,
    '</files_input>',
  ].join('\n');
}

// Matches one numbered attachment entry inside the tag body. Works for both
// the multi-line block and the Windows-flattened single-line form, where the
// next ` N. ` marker (or the end of the body) delimits each entry.
const IMAGES_INPUT_ENTRY_PATTERN = /\d+\.\s+(.+?)(?=\s+\d+\.\s+|\s*$)/g;

const ORIGINAL_NAME_SUFFIX_PATTERN = /\(original name: ([^)]*)\)\s*$/;

function parseNumberedImageEntries(inner: string): ParsedImageAttachment[] {
  const attachments: ParsedImageAttachment[] = [];
  for (const entryMatch of inner.matchAll(IMAGES_INPUT_ENTRY_PATTERN)) {
    let entryText = entryMatch[1].trim();
    let name: string | undefined;

    const nameMatch = ORIGINAL_NAME_SUFFIX_PATTERN.exec(entryText);
    if (nameMatch) {
      name = nameMatch[1].trim() || undefined;
      entryText = entryText.slice(0, nameMatch.index).trim();
    }

    if (entryText) {
      attachments.push(name ? { path: toPosixPath(entryText), name } : { path: toPosixPath(entryText) });
    }
  }
  return attachments;
}

/**
 * Strips the last provider-neutral file reference block from persisted prompt
 * text and restores its attachment descriptors for chat history.
 */
export function parseFilesInputTag(text: string): {
  text: string;
  filePaths: string[];
  attachments: ParsedImageAttachment[];
} {
  if (typeof text !== 'string' || !text.includes('<files_input>')) {
    return { text, filePaths: [], attachments: [] };
  }

  let lastMatch: RegExpExecArray | null = null;
  FILES_INPUT_TAG_PATTERN.lastIndex = 0;
  for (let match = FILES_INPUT_TAG_PATTERN.exec(text); match; match = FILES_INPUT_TAG_PATTERN.exec(text)) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return { text, filePaths: [], attachments: [] };
  }

  const attachments = parseNumberedImageEntries(lastMatch[1]);
  const stripped = (
    text.slice(0, lastMatch.index) + '\n' + text.slice(lastMatch.index + lastMatch[0].length)
  ).trim();

  return {
    text: stripped,
    filePaths: attachments.map((attachment) => attachment.path),
    attachments,
  };
}

/**
 * Strips one `<images_input>` block from persisted prompt text and returns
 * the clean text plus the referenced attachments (path and original name).
 *
 * Only the LAST block in the text is treated as the attachment carrier — the
 * composer always appends it at the end, so a user who literally typed
 * `<images_input>` earlier in their prompt keeps that text intact.
 *
 * Understands the numbered-line body in both its multi-line and
 * Windows-flattened single-line forms.
 */
export function parseImagesInputTag(text: string): ParsedImagesInput {
  if (typeof text !== 'string' || !text.includes('<images_input>')) {
    return { text, imagePaths: [], attachments: [] };
  }

  let lastMatch: RegExpExecArray | null = null;
  IMAGES_INPUT_TAG_PATTERN.lastIndex = 0;
  for (let match = IMAGES_INPUT_TAG_PATTERN.exec(text); match; match = IMAGES_INPUT_TAG_PATTERN.exec(text)) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return { text, imagePaths: [], attachments: [] };
  }

  const attachments = parseNumberedImageEntries(lastMatch[1]);

  const stripped = (
    text.slice(0, lastMatch.index) + '\n' + text.slice(lastMatch.index + lastMatch[0].length)
  ).trim();

  return {
    text: stripped,
    imagePaths: attachments.map((attachment) => attachment.path),
    attachments,
  };
}

/** Maps raw image paths to the attachment shape carried by NormalizedMessage.images. */
export function toImageAttachments(imagePaths: string[]): Array<{ path: string }> {
  return imagePaths.map((imagePath) => ({ path: toPosixPath(imagePath) }));
}

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * Builds the Claude user-message content list: the prompt text followed by one
 * base64 `image` block per attachment. Images the Claude API cannot accept
 * (e.g. SVG) or that fail to read are skipped with a warning so the prompt
 * itself still goes through.
 */
export async function buildClaudeUserContent(
  prompt: string,
  images: unknown,
  cwd?: string,
): Promise<ClaudeContentBlock[]> {
  const blocks: ClaudeContentBlock[] = [{ type: 'text', text: prompt }];
  // Attachments Claude can't ingest as image blocks (PDFs, logs, archives —
  // or an image type outside CLAUDE_IMAGE_MEDIA_TYPES like SVG) are handed
  // over as file paths for the agent to read with its own tools.
  const fileReferences: string[] = [];

  for (const descriptor of normalizeImageDescriptors(images)) {
    const resolvedPath = resolveImageAbsolutePath(cwd, descriptor.path);
    if (!isAllowedImageSourcePath(resolvedPath, cwd)) {
      console.warn(`[Images] Refusing to read attachment outside allowed roots: ${descriptor.path}`);
      continue;
    }

    const mediaType = resolveImageMediaType(descriptor);
    if (!mediaType || !CLAUDE_IMAGE_MEDIA_TYPES.has(mediaType)) {
      fileReferences.push(
        descriptor.name ? `${resolvedPath} (original name: ${descriptor.name})` : resolvedPath,
      );
      continue;
    }

    try {
      const canonicalPath = await fs.realpath(resolvedPath);
      if (!isAllowedImageSourcePath(canonicalPath, cwd)) {
        console.warn(`[Images] Refusing to read symlinked image outside allowed roots: ${descriptor.path}`);
        continue;
      }

      const { size } = await fs.stat(canonicalPath);
      if (size > MAX_INLINE_IMAGE_BYTES) {
        fileReferences.push(
          descriptor.name ? `${resolvedPath} (original name: ${descriptor.name})` : resolvedPath,
        );
        continue;
      }

      const bytes = await fs.readFile(canonicalPath);
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: bytes.toString('base64'),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Images] Failed to read image ${descriptor.path}: ${message}`);
    }
  }

  if (fileReferences.length > 0) {
    blocks.push({
      type: 'text',
      text: [
        '[The user attached the following file(s) to this message. Read them with your file reading tool if relevant:]',
        ...fileReferences.map((reference, index) => `${index + 1}. ${reference}`),
      ].join('\n'),
    });
  }

  return blocks;
}

/** One attachment as OpenCode's HTTP prompt API takes it. */
export type OpenCodePromptFile = {
  uri: string;
  name?: string;
};

export type OpenCodePromptAttachments = {
  /** Images inlined as `data:` URIs, ready for `prompt.files`. */
  files: OpenCodePromptFile[];
  /** Everything that could not be inlined, to be listed for the agent to read. */
  passthrough: ImageAttachmentDescriptor[];
};

/**
 * Splits chat attachments for an OpenCode HTTP turn.
 *
 * Images are inlined as `data:` URIs because that is the only form the server
 * turns into a real image part: a `file://` URI is rejected outright by the
 * OpenAI-compatible transport ("media must contain valid base64"), and the
 * read-it-from-disk route loses the image to tool-result flattening.
 *
 * Anything that is not an inlineable image — a PDF, a log, an oversized photo —
 * is handed back untouched so the caller can list it for the agent to open with
 * its own tools, exactly as the `run` transport does.
 */
export async function buildOpenCodePromptAttachments(
  images: unknown,
  cwd?: string,
): Promise<OpenCodePromptAttachments> {
  const files: OpenCodePromptFile[] = [];
  const passthrough: ImageAttachmentDescriptor[] = [];

  for (const descriptor of normalizeImageDescriptors(images)) {
    const resolvedPath = resolveImageAbsolutePath(cwd, descriptor.path);
    if (!isAllowedImageSourcePath(resolvedPath, cwd)) {
      // Same trust boundary as every other provider builder: only the upload
      // store and the run's own directory.
      console.warn(`[Images] Refusing to attach file outside allowed roots: ${descriptor.path}`);
      continue;
    }

    const mediaType = resolveImageMediaType(descriptor);
    if (!mediaType || !mediaType.startsWith('image/')) {
      passthrough.push(descriptor);
      continue;
    }

    try {
      const canonicalPath = await fs.realpath(resolvedPath);
      if (!isAllowedImageSourcePath(canonicalPath, cwd)) {
        console.warn(`[Images] Refusing to attach symlinked image outside allowed roots: ${descriptor.path}`);
        continue;
      }

      const { size } = await fs.stat(canonicalPath);
      if (size > MAX_INLINE_IMAGE_BYTES) {
        passthrough.push(descriptor);
        continue;
      }

      const bytes = await fs.readFile(canonicalPath);
      files.push({
        uri: `data:${mediaType};base64,${bytes.toString('base64')}`,
        name: descriptor.name || path.basename(resolvedPath),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Images] Failed to read image ${descriptor.path}: ${message}`);
      passthrough.push(descriptor);
    }
  }

  return { files, passthrough };
}

type CodexInputItem =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string };

/**
 * Builds the Codex `runStreamed` input list: prompt text plus one
 * `local_image` item per attachment, resolved to absolute paths so the Codex
 * runtime can read them regardless of its own working directory handling.
 */
export function buildCodexInputItems(prompt: string, images: unknown, cwd?: string): CodexInputItem[] {
  const items: CodexInputItem[] = [{ type: 'text', text: prompt }];
  const fileReferences: string[] = [];
  for (const descriptor of normalizeImageDescriptors(images)) {
    const resolvedPath = resolveImageAbsolutePath(cwd, descriptor.path);
    if (!isAllowedImageSourcePath(resolvedPath, cwd)) {
      // Same trust boundary as buildClaudeUserContent — the Codex runtime
      // reads this file, so it must stay within the allowed roots.
      console.warn(`[Images] Refusing to attach file outside allowed roots: ${descriptor.path}`);
      continue;
    }
    const mediaType = resolveImageMediaType(descriptor);
    if (mediaType && mediaType.startsWith('image/')) {
      items.push({
        type: 'local_image',
        path: resolvedPath,
      });
    } else {
      // Codex only ingests images natively; other files go as a read-me note.
      fileReferences.push(
        descriptor.name ? `${resolvedPath} (original name: ${descriptor.name})` : resolvedPath,
      );
    }
  }
  if (fileReferences.length > 0) {
    items.push({
      type: 'text',
      text: [
        '[The user attached the following file(s) to this message. Read them with your file reading tool if relevant:]',
        ...fileReferences.map((reference, index) => `${index + 1}. ${reference}`),
      ].join('\n'),
    });
  }
  return items;
}
