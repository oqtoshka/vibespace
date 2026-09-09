import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appConfigDb, getConnection, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { providerModelsService, sessionsService } from '@/modules/providers/index.js';
import { ensureImageAssetsDir } from '@/modules/assets/index.js';
import type { LLMProvider } from '@/shared/index.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const providers = ['claude', 'codex', 'opencode'] as const;
type CreateInput = { requestId: string; projectId: string; provider: LLMProvider; title?: string; model?: string; effort?: string };
type Upload = { id: string; sessionId: string; path: string; name: string; mimeType: string; size: number };

/** MC's instance credential is separate from browser JWTs and per-session capabilities.
 * Consumed by the native-control router; never returned to a phone or an agent. */
export function authenticateNativeControl(supplied: unknown): boolean {
  const expected = appConfigDb.get('mc_federation_token');
  if (!expected || expected.length < 32 || typeof supplied !== 'string' || !userDb.getSingleActiveUser()) return false;
  const actual = Buffer.from(supplied); const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function session(id: string) {
  const row = sessionsDb.getSessionById(id);
  if (!row || row.is_private || row.is_side) throw new Error('Session is unavailable');
  return row;
}

/** Scoped options used by native session chat and the creation catalog. */
export async function nativeModelOptions(provider: LLMProvider) {
  const result = await providerModelsService.getProviderModels(provider);
  return { provider, options: result.models.OPTIONS, defaultModel: result.models.DEFAULT };
}

/** Validates and records a session-local model selection; does not edit global defaults. */
export async function setNativeSelection(id: string, model: unknown, effort: unknown) {
  const row = session(id);
  if (row.isArchived) throw new Error('Session is archived');
  const catalog = await nativeModelOptions(row.provider as LLMProvider);
  if (typeof model !== 'string' || !catalog.options.some(option => option.value === model)) throw new Error('Choose a model from this provider');
  const chosen = catalog.options.find(option => option.value === model);
  if (effort && !chosen?.effort?.values.some(option => option.value === effort)) throw new Error('This model does not support that effort');
  if (typeof effort !== 'string' || !['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('Invalid reasoning effort');
  providerModelsService.setSessionModel(row.provider as LLMProvider, id, model);
  if (effort) providerModelsService.setSessionEffort(row.provider as LLMProvider, id, effort);
  return { model, effort: effort || row.effort };
}

/** Native-control router owns the instance catalog; project paths are always resolved
 * from registered IDs and cannot be supplied by a client to escape into another cwd. */
export const nativeControlService = {
  catalog() {
    return {
      projects: projectsDb.getProjectPaths().map(project => ({ id: project.project_id,
        name: project.custom_project_name || path.basename(project.project_path), path: project.project_path,
        starred: Boolean(project.isStarred) })), providers,
    };
  },
  async create(input: CreateInput) {
    if (!input || !uuid.test(input.requestId) || !providers.includes(input.provider as typeof providers[number])) throw new Error('Invalid session request');
    const project = projectsDb.getProjectById(input.projectId);
    if (!project || project.isArchived) throw new Error('Project is unavailable');
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 1000)) throw new Error('Invalid title');
    const settings = input.model ? await nativeModelOptions(input.provider) : null;
    if (input.model && !settings?.options.some(option => option.value === input.model)) throw new Error('Invalid model');
    if (input.effort && !settings?.options.find(option => option.value === input.model)?.effort?.values.some(option => option.value === input.effort)) throw new Error('This model does not support that effort');
    if (input.effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.effort)) throw new Error('Invalid effort');
    const digest = createHash('sha256').update(JSON.stringify([input.projectId, input.provider, input.title || '', input.model || '', input.effort || ''])).digest('hex');
    const receiptKey = `native_create:${input.requestId}`;
    const id = getConnection().transaction(() => {
      const previous = appConfigDb.get(receiptKey);
      if (previous) {
        const receipt = JSON.parse(previous);
        if (receipt.digest !== digest) throw new Error('This request ID was already used for different content');
        session(receipt.id); return receipt.id as string;
      }
      const created = sessionsService.createAppSession(input.provider, project.project_path, false, false, input.title);
      if (input.model) providerModelsService.setSessionModel(input.provider, created.sessionId, input.model);
      if (input.effort) providerModelsService.setSessionEffort(input.provider, created.sessionId, input.effort);
      appConfigDb.set(receiptKey, JSON.stringify({ id: created.sessionId, digest }));
      return created.sessionId;
    })();
    return this.describe(id);
  },
  describe(id: string) {
    const row = session(id);
    const capability = createHmac('sha256', appConfigDb.getOrCreateJwtSecret())
      .update(`mission-control:vibespace-session:v1:${id}`).digest('base64url');
    return { sessionId: id, provider: row.provider, title: row.custom_name, projectPath: row.project_path,
      model: row.model, effort: row.effort, archived: Boolean(row.isArchived), capability };
  },
  async upload(id: string, name: string, mimeType: string, bytes: Buffer) {
    const row = session(id);
    if (row.isArchived) throw new Error('Session is archived');
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 10 * 1024 * 1024) throw new Error('File must be between 1 byte and 10 MiB');
    if (!name || name.length > 250 || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(mimeType)) throw new Error('Invalid file metadata');
    const assetId = randomUUID();
    const filePath = path.join(await ensureImageAssetsDir(), `native-${assetId}-${path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')}`);
    await fs.writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 });
    const record: Upload = { id: assetId, sessionId: id, path: filePath, name: path.basename(name), mimeType, size: bytes.length };
    try { appConfigDb.set(`native_asset:${assetId}`, JSON.stringify(record)); }
    catch (error) { await fs.unlink(filePath); throw error; }
    return { id: record.id, name: record.name, mimeType: record.mimeType, size: record.size };
  },
  async asset(sessionId: string, assetId: string) {
    const record = resolveNativeAttachments(sessionId, [assetId])[0];
    return { bytes: await fs.readFile(record.path), mimeType: record.mimeType };
  },
};

/** WebSocket module resolves opaque uploaded IDs only for their bound session.
 * Caller-controlled filesystem paths are never accepted as native attachments. */
export function resolveNativeAttachments(sessionId: string, ids: unknown): Upload[] {
  session(sessionId);
  if (!Array.isArray(ids) || ids.length > 10) throw new Error('At most 10 attachments');
  return ids.map(id => {
    if (typeof id !== 'string' || !uuid.test(id)) throw new Error('Invalid attachment');
    const raw = appConfigDb.get(`native_asset:${id}`);
    if (!raw) throw new Error('Attachment is no longer available');
    const record = JSON.parse(raw) as Upload;
    if (record.sessionId !== sessionId) throw new Error('Attachment belongs to another session');
    return record;
  });
}
