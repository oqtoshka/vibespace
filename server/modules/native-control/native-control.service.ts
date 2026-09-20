import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { appConfigDb, getConnection, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { permissionPreferencesService, providerModelsService, sessionConversationsSearchService, sessionsService } from '@/modules/providers/index.js';
import { ensureImageAssetsDir, openStoredAttachmentAsset } from '@/modules/assets/index.js';
import { voiceService } from '@/modules/voice/index.js';
import { createProject } from '@/modules/projects/index.js';
import type { LLMProvider } from '@/shared/index.js';
import { normalizeLaunchOptions, parseStoredLaunchOptions } from '@/shared/agent-env.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const providers = ['claude', 'codex', 'opencode'] as const;
type CreateInput = { requestId: string; projectId: string; provider: LLMProvider; title?: string; model?: string; effort?: string; permissionMode?: string; launchOptions?: unknown };
type Upload = { id: string; sessionId: string; path: string; name: string; mimeType: string; size: number };

/** MC's instance credential is separate from browser JWTs and per-session capabilities.
 * Consumed by native-control and native-workspace routers; never returned to a phone or an agent. */
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

/** Permission choices are resolved on the VibeSpace that will execute the turn. */
export function nativePermissionOptions(provider: LLMProvider, sessionId?: string) {
  const user = userDb.getSingleActiveUser();
  if (!user) throw new Error('Operator is unavailable');
  return permissionPreferencesService.get(Number(user.id), provider, sessionId);
}

/** Validates and records a session-local model selection; does not edit global defaults. */
export async function setNativeSelection(id: string, model: unknown, effort: unknown) {
  const row = session(id);
  if (row.isArchived) throw new Error('Session is archived');
  const catalog = await nativeModelOptions(row.provider as LLMProvider);
  if (typeof model !== 'string' || !catalog.options.some(option => option.value === model)) throw new Error('Choose a model from this provider');
  const chosen = catalog.options.find(option => option.value === model);
  if (effort && !chosen?.effort?.values.some(option => option.value === effort)) throw new Error('This model does not support that effort');
  if (typeof effort !== 'string' || effort.length > 64) throw new Error('Invalid reasoning effort');
  providerModelsService.setSessionModel(row.provider as LLMProvider, id, model);
  // The change file outranks the row when a session resumes or starts a turn, so
  // a pick recorded only on the row lost to any older override from the web picker:
  // the phone showed Opus while every turn ran on the stale Fable pick.
  await providerModelsService.changeActiveModel(row.provider as LLMProvider, { sessionId: id, model });
  const selectedEffort = effort || chosen?.effort?.default || '';
  sessionsDb.setSessionEffort(id, selectedEffort);
  return { model, effort: selectedEffort };
}

/** Sets or clears only this conversation's override; provider defaults remain settings-owned. */
export function setNativePermissionSelection(id: string, mode: unknown) {
  const row = session(id);
  if (row.isArchived) throw new Error('Session is archived');
  if (mode !== null && typeof mode !== 'string') throw new Error('Invalid permission mode');
  const user = userDb.getSingleActiveUser();
  if (!user) throw new Error('Operator is unavailable');
  return permissionPreferencesService.update(Number(user.id), row.provider, id, { sessionMode: mode });
}

/** Native-control router owns the instance catalog; project paths are always resolved
 * from registered IDs and cannot be supplied by a client to escape into another cwd. */
export const nativeControlService = {
  async createProject(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid project request');
    const { path: directory, name } = input as Record<string, unknown>;
    if (typeof directory !== 'string' || !path.isAbsolute(directory.trim()) || directory.length > 4000 ||
        typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Choose a name and an absolute project folder');
    try {
      return await createProject({ projectPath: directory.trim(), customName: name.trim() });
    } catch (error) {
      // A lost response may be retried: registration of the same active folder is idempotent.
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'PROJECT_ALREADY_EXISTS') throw error;
      const existing = projectsDb.getProjectPath(path.resolve(directory.trim()));
      if (!existing) throw error;
      return { outcome: 'existing', project: { projectId: existing.project_id, path: existing.project_path, displayName: existing.custom_project_name || path.basename(existing.project_path), isArchived: Boolean(existing.isArchived) } };
    }
  },
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
    const settings = await nativeModelOptions(input.provider);
    // The phone's "Default" choice is an empty string, not an absent field.
    const model = input.model || settings.defaultModel;
    if (!settings.options.some(option => option.value === model)) throw new Error('Invalid model');
    const selectedModel = settings.options.find(option => option.value === model);
    const effort = input.effort ?? selectedModel?.effort?.default ?? '';
    if (effort && !selectedModel?.effort?.values.some(option => option.value === effort)) throw new Error('This model does not support that effort');
    if (input.effort !== undefined && (typeof input.effort !== 'string' || input.effort.length > 64)) throw new Error('Invalid effort');
    const permissions = nativePermissionOptions(input.provider);
    const permissionMode = input.permissionMode ?? permissions.permissionMode;
    if (!permissions.permissionModes.includes(permissionMode)) throw new Error('Invalid permission mode');
    // The remote client's launch choices, the same shape the browser composer sends:
    // fixed at creation and read by the launch, like `private`. An option no plugin
    // here declares is refused rather than dropped — the caller counts on it.
    const launchOptions = normalizeLaunchOptions(input.launchOptions, { strict: true });
    const digest = createHash('sha256').update(JSON.stringify([input.projectId, input.provider, input.title || '', model, effort, permissionMode, launchOptions])).digest('hex');
    const receiptKey = `native_create:${input.requestId}`;
    const id = getConnection().transaction(() => {
      const previous = appConfigDb.get(receiptKey);
      if (previous) {
        const receipt = JSON.parse(previous);
        if (receipt.digest !== digest) throw new Error('This request ID was already used for different content');
        session(receipt.id); return receipt.id as string;
      }
      const created = sessionsService.createAppSession(input.provider, project.project_path, false, false, input.title, launchOptions);
      providerModelsService.setSessionModel(input.provider, created.sessionId, model);
      providerModelsService.setSessionEffort(input.provider, created.sessionId, effort);
      sessionsDb.setSessionPermissionMode(created.sessionId, permissionMode);
      appConfigDb.set(receiptKey, JSON.stringify({ id: created.sessionId, digest }));
      return created.sessionId;
    })();
    return this.describe(id);
  },
  async search(input: Parameters<typeof sessionConversationsSearchService.searchPage>[0]) {
    return sessionConversationsSearchService.searchPage(input);
  },
  async transcribe(bytes: Buffer) {
    const user = userDb.getSingleActiveUser();
    if (!user) throw new Error('Operator is unavailable');
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
      throw new Error('Recording must be between 1 byte and 8 MiB');
    }
    const result = await voiceService.transcribe({
      userId: Number(user.id),
      audio: { bytes, mimeType: 'audio/mp4', fileName: 'recording.m4a' },
    });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  describe(id: string) {
    const row = session(id);
    const capability = createHmac('sha256', appConfigDb.getOrCreateJwtSecret())
      .update(`mission-control:vibespace-session:v1:${id}`).digest('base64url');
    return { sessionId: id, provider: row.provider, title: row.custom_name, projectPath: row.project_path,
      model: row.model, effort: row.effort, permissionMode: sessionsDb.getSessionPermissionMode(id),
      launchOptions: parseStoredLaunchOptions(row.launch_options),
      archived: Boolean(row.isArchived), capability };
  },
  /** Federation clients renew before owner actions; a failed read must never mean missing. */
  ownerCapability(id: string) {
    // Imported OpenCode sessions predate app UUIDs; preserve the viewer ID grammar.
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(id)) throw new Error('Invalid session ID');
    const row = sessionsDb.getSessionById(id);
    if (!row) return { sessionId: id, state: 'missing' as const };
    if (row.is_private !== 0 || row.is_side !== 0) throw new Error('Session is unavailable');
    return { sessionId: id, state: row.isArchived ? 'archived' as const : 'active' as const,
      capability: this.describe(id).capability };
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
  /** Lets Mission Control redisplay attachments uploaded by the browser. The
   * assets module accepts only a basename directly inside ~/.vibespace/assets;
   * checking the requested session first preserves private/side-session scope. */
  async storedAsset(sessionId: string, filename: string) {
    session(sessionId);
    return openStoredAttachmentAsset(filename);
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
