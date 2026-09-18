import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { AppError } from '@/shared/index.js';

import { isOfficeFile } from '../../../shared/office-formats.js';

function fail(message: string, statusCode: number, code: string): never {
  throw new AppError(message, { statusCode, code });
}

/** Used by the Office Preview router/composition and tests. Converts only authorized project files. */
export class OfficePreviewService {
  private active = 0;
  private cache = new Map<string, { pdf: Buffer; expires: number }>();
  private cacheBytes = 0;
  constructor(private readonly options: {
    projectPath: (id: string) => string | null | undefined | Promise<string | null | undefined>;
    converterUrl?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  }) {}

  async preview(projectId: string, filename: string, signal?: AbortSignal): Promise<Buffer> {
    if (!isOfficeFile(filename)) fail('Unsupported office format.', 415, 'OFFICE_FORMAT');
    if (!this.options.converterUrl) fail('Office preview is not configured on this server.', 503, 'OFFICE_UNAVAILABLE');
    if (this.active >= 2) fail('Office preview is busy. Try again shortly.', 429, 'OFFICE_BUSY');
    this.active++;
    try {
      const project = await this.options.projectPath(projectId);
      if (!project) fail('Project not found.', 404, 'OFFICE_NOT_FOUND');
      const root = await realpath(project);
      const resolved = await realpath(path.resolve(root, filename));
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
        fail('File is outside the project.', 403, 'OFFICE_FORBIDDEN');
      }
      // Open the validated canonical file without following a replaced final symlink.
      const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let input: Buffer;
      try {
        if (process.platform === 'linux') {
          const opened = await realpath(`/proc/self/fd/${file.fd}`);
          const inside = path.relative(root, opened);
          if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) fail('File is outside the project.', 403, 'OFFICE_FORBIDDEN');
        }
        const stat = await file.stat();
        if (!stat.isFile()) fail('Not a regular file.', 400, 'OFFICE_FORMAT');
        if (stat.size > 25 * 1024 * 1024) fail('Office preview supports files up to 25 MiB.', 413, 'OFFICE_TOO_LARGE');
        // Bounded read even if a file grows after stat; never read an unlimited stream.
        input = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < input.length) {
          const { bytesRead } = await file.read(input, offset, input.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await file.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail('File changed during reading. Try again.', 409, 'OFFICE_CHANGED');
        if (offset !== stat.size) fail('File changed during reading. Try again.', 409, 'OFFICE_CHANGED');
        input = input.subarray(0, offset);
      } finally { await file.close(); }
      const extension = path.extname(filename).toLowerCase();
      const zip = input.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]));
      const ole = input.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11e1', 'hex'));
      if (!zip && !ole) fail('The file is not a readable Office document.', 422, 'OFFICE_INVALID');
      const key = createHash('sha256').update(extension).update(input).digest('hex');
      const now = Date.now();
      for (const [entry, value] of this.cache) if (value.expires < now) {
        this.cacheBytes -= value.pdf.length; this.cache.delete(entry);
      }
      const cached = this.cache.get(key);
      if (cached) return cached.pdf;
      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(input)]), 'document' + extension);
      // Keep print layout for spreadsheets; do not squeeze an unbounded sheet onto one page.
      form.append('exportBookmarks', 'false');
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60000);
      const response = await (this.options.fetch ?? globalThis.fetch)(this.options.converterUrl, {
        method: 'POST', body: form, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([400, 422].includes(response.status)) fail('Cannot preview this document. It may be damaged or password-protected.', 422, 'OFFICE_INVALID');
        fail('Office conversion is unavailable or busy. Try again shortly.', 503, 'OFFICE_UNAVAILABLE');
      }
      if (!response.body) fail('Empty converter response.', 502, 'OFFICE_INVALID_RESULT');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 64 * 1024 * 1024) fail('Converted preview is too large.', 413, 'OFFICE_TOO_LARGE');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const pdf = Buffer.concat(chunks);
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('Invalid converter response.', 502, 'OFFICE_INVALID_RESULT');
      if (pdf.length <= 32 * 1024 * 1024) {
        while (this.cacheBytes + pdf.length > 32 * 1024 * 1024 || this.cache.size >= 16) {
          const oldest = this.cache.keys().next().value!;
          this.cacheBytes -= this.cache.get(oldest)!.pdf.length; this.cache.delete(oldest);
        }
        const previous = this.cache.get(key);
        if (previous) this.cacheBytes -= previous.pdf.length;
        this.cache.set(key, { pdf, expires: now + 300000 }); this.cacheBytes += pdf.length;
      }
      return pdf;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('File not found.', 404, 'OFFICE_NOT_FOUND');
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('File changed during reading.', 403, 'OFFICE_FORBIDDEN');
      if (signal?.aborted) throw error;
      fail('Office conversion failed or timed out. Try again shortly.', 503, 'OFFICE_UNAVAILABLE');
    } finally { this.active--; }
  }
}
