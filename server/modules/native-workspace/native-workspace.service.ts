import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import mime from 'mime-types';
import { encodePlantUmlSource, renderDbmlToSvg } from '@/shared/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import { resolveHtmlPreviewEntry, resolveHtmlPreviewAsset, resolveCustomRenderer, resolvePreviewModel, wireFlowCrossLinks } from '@/modules/html-preview/index.js';

const run = promisify(execFile);
const LIMIT = 32 * 1024 * 1024;
const MAX_ENTRIES = 2000;
type SessionRoot = (id: string) => string | null;

function contained(root: string, target: string) {
  return target === root || target.startsWith(root + path.sep);
}

/** Native workspace routes call this service after federation authentication.
 * Every operation re-resolves the selected session and its canonical root. No
 * caller-supplied project ID, root, shell command, or write operation is accepted. */
export class NativeWorkspaceService {
  constructor(private readonly sessionRoot: SessionRoot = id => {
    const row = sessionsDb.getSessionById(id);
    return row && !row.is_private && !row.is_side ? row.project_path : null;
  }) {}

  private async root(id: string) {
    const directory = this.sessionRoot(id);
    if (!directory) throw new Error('This session has no available workspace');
    return fs.realpath(directory);
  }

  private async target(root: string, value: unknown) {
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new Error('Invalid file path');
    const lexical = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    if (!contained(root, lexical)) throw new Error('File is outside the session workspace');
    const real = await fs.realpath(lexical);
    if (!contained(root, real)) throw new Error('File is outside the session workspace');
    return real;
  }

  private async read(root: string, target: string) {
    const file = await this.target(root, target);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('Not a regular file');
    if (stat.size > LIMIT) throw new Error('File exceeds the 32 MiB preview limit');
    const bytes = await fs.readFile(file);
    if (bytes.length > LIMIT) throw new Error('File exceeds the 32 MiB preview limit');
    return { name: path.basename(file), path: path.relative(root, file), mime: mime.lookup(file) || 'application/octet-stream',
      size: bytes.length, stamp: `${stat.mtimeMs}:${stat.size}`, version: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
  }

  private async include(root: string, file: string, content: string, seen: Set<string>, depth = 0): Promise<string> {
    if (depth > 20 || seen.size > 100) throw new Error('Diagram include limit exceeded');
    const lines = [];
    for (const line of content.split(/\r?\n/)) {
      const match = /^\s*!include(?:_once|_many|sub)?\s+(.+?)\s*$/i.exec(line);
      if (!match || match[1].startsWith('<') || /^https?:/.test(match[1])) { lines.push(line); continue; }
      const name = match[1].replace(/!.*$/, '').replace(/^['"]|['"]$/g, '');
      const target = await this.target(root, path.resolve(path.dirname(file), name));
      if (seen.has(target)) continue;
      seen.add(target);
      const data = await this.read(root, target);
      const nested = await this.include(root, target, Buffer.from(data.base64, 'base64').toString('utf8'), seen, depth + 1);
      lines.push(nested.split('\n').filter(l => !/^\s*@(start|end)uml\b/i.test(l)).join('\n'));
    }
    return lines.join('\n');
  }

  async request(id: string, input: unknown): Promise<Record<string, unknown>> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid workspace request');
    const request = input as Record<string, unknown>;
    const root = await this.root(id);
    if (request.op === 'context') {
      let branch = '';
      try { branch = (await run('git', ['-C', root, 'branch', '--show-current'], { timeout: 2000 })).stdout.trim(); } catch { /* Non-git workspace. */ }
      return { root, name: path.basename(root), branch, key: createHash('sha256').update(root).digest('hex'), limitBytes: LIMIT };
    }
    if (request.op === 'list') {
      const directory = await this.target(root, request.path ?? '.');
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const visible = entries.filter(e => !['.git', 'node_modules', '.DS_Store'].includes(e.name)).sort((a, b) => a.name.localeCompare(b.name));
      const nodes = [];
      for (const entry of visible.slice(0, MAX_ENTRIES)) {
        try {
          const target = await this.target(root, path.join(directory, entry.name));
          const stat = await fs.stat(target);
          if (!stat.isFile() && !stat.isDirectory()) continue;
          nodes.push({ name: entry.name, path: path.relative(root, path.join(directory, entry.name)), directory: stat.isDirectory(), size: stat.size });
        } catch { /* Inaccessible links are never listed as usable files. */ }
      }
      nodes.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      return { nodes, truncated: visible.length > MAX_ENTRIES };
    }
    if (request.op === 'stat') {
      if (!Array.isArray(request.paths) || request.paths.length > 128) throw new Error('Invalid watch paths');
      const nodes = await Promise.all(request.paths.map(async value => {
        try { const file = await this.target(root, value); const stat = await fs.stat(file);
          return { path: value, stamp: `${stat.mtimeMs}:${stat.size}`, exists: true }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: value, exists: false }; throw error; }
      }));
      return { nodes };
    }
    if (request.op === 'read') {
      const file = await this.target(root, request.path);
      return { ...await this.read(root, file), customRenderer: !!await resolveCustomRenderer(file, root, process.execPath) };
    }
    if (request.op === 'html' || request.op === 'asset') {
      const entry = await this.target(root, request.op === 'html' ? request.path : request.entry);
      if (!/\.html?$/i.test(entry)) throw new Error('Not an HTML entry');
      const preview = await resolveHtmlPreviewEntry(root, entry, {
        validatePath: async (_, value) => { try { return { valid: true, resolved: await this.target(root, value) }; } catch { return { valid: false, error: 'Asset is outside the session workspace' }; } },
        resolveModel: resolvePreviewModel,
      });
      if (!preview.valid) throw new Error(preview.error);
      if (request.op === 'html') return { entryRel: preview.entryRel, resourceRoots: preview.resourceRoots };
      if (typeof request.path !== 'string') throw new Error('Invalid asset path');
      const asset = await resolveHtmlPreviewAsset(request.path, preview, root);
      if (!asset) throw new Error('Asset is unavailable');
      return this.read(root, await this.target(root, asset));
    }
    if (request.op === 'render') {
      const file = await this.target(root, request.path);
      const data = await this.read(root, file);
      const content = Buffer.from(data.base64, 'base64').toString('utf8');
      if (request.kind === 'inline-plantuml') {
        if (typeof request.content !== 'string' || request.content.length > 256 * 1024) throw new Error('Inline diagram exceeds the preview limit');
        // Inline snippets cannot read the host filesystem. File diagrams use the
        // separate root-checked include resolver below.
        if (/^\s*!include/m.test(request.content)) throw new Error('Inline diagrams cannot include files');
        const server = (process.env.PLANTUML_SERVER_URL || 'https://www.plantuml.com/plantuml').replace(/\/+$/, '');
        return { url: server + '/svg/' + encodePlantUmlSource(request.content) };
      }
      if (request.kind === 'dbml') return { svg: renderDbmlToSvg(content) };
      if (request.kind === 'plantuml') {
        const included = await this.include(root, file, content, new Set([file]));
        const server = (process.env.PLANTUML_SERVER_URL || 'https://www.plantuml.com/plantuml').replace(/\/+$/, '');
        return { url: server + '/svg/' + encodePlantUmlSource(included) };
      }
      if (request.kind === 'custom') {
        const renderer = await resolveCustomRenderer(file, root, process.execPath);
        if (!renderer) throw new Error('No project renderer is configured for this file');
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-preview-'));
        try {
          const inputFile = path.join(directory, path.basename(file)), output = path.join(directory, 'result.html');
          await fs.writeFile(inputFile, content);
          await run(renderer.bin, renderer.args.map(a => a.replace('{input}', inputFile).replace('{output}', output)),
            { cwd: root, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
          const html = await fs.readFile(output, 'utf8');
          if (html.length > 8 * 1024 * 1024) throw new Error('Renderer output is too large');
          return { html: wireFlowCrossLinks(html, file, root) };
        } finally { await fs.rm(directory, { recursive: true, force: true }); }
      }
      throw new Error('Unsupported renderer');
    }
    throw new Error('Unsupported workspace operation');
  }
}
