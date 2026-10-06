import { access, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
  sanitizeLeafDirectoryName,
} from '@/shared/utils.js';

/**
 * Curated Cursor catalog shipped as immutable CloudCLI defaults.
 *
 * Unlike every other provider here, Cursor bakes the reasoning effort into the
 * model id (`gpt-5.6-sol-high`, not `gpt-5.6-sol` + effort `high`) and rejects
 * a bare family name outright — `Cannot use this model: gpt-5.6-sol`. There is
 * no `effort` block on these options for the same reason: `cursor-cli.js` only
 * ever passes `--model`, and `getCurrentActiveModel` below reads Cursor's own
 * `lastUsedModel`, which is already suffixed. Keeping the suffix inside `value`
 * is what lets the picker round-trip with what Cursor persists.
 */
export const CURSOR_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'auto', label: 'Auto', description: 'Let Cursor choose the model.' },
    {
      value: 'composer-2.5-fast',
      label: 'Composer 2.5 Fast',
      description: 'Cursor Composer 2.5 with faster inference.',
    },
    {
      value: 'composer-2.5',
      label: 'Composer 2.5',
      description: 'Cursor model for efficient, long-running coding tasks.',
    },
    { value: 'gpt-5.6-sol-medium', label: 'GPT-5.6 Sol' },
    { value: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol High' },
    { value: 'gpt-5.6-sol-xhigh', label: 'GPT-5.6 Sol XHigh' },
    { value: 'gpt-5.6-sol-max', label: 'GPT-5.6 Sol Max' },
    { value: 'gpt-5.6-terra-medium', label: 'GPT-5.6 Terra' },
    { value: 'gpt-5.6-terra-high', label: 'GPT-5.6 Terra High' },
    { value: 'gpt-5.6-luna-medium', label: 'GPT-5.6 Luna' },
    { value: 'gpt-5.6-luna-high', label: 'GPT-5.6 Luna High' },
    { value: 'gpt-5.5-medium', label: 'GPT-5.5' },
    { value: 'gpt-5.5-high', label: 'GPT-5.5 High' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { value: 'gpt-5.3-codex-high', label: 'GPT-5.3 Codex High' },
    { value: 'claude-opus-5-medium', label: 'Claude Opus 5' },
    { value: 'claude-opus-5-thinking-high', label: 'Claude Opus 5 Thinking' },
    { value: 'claude-opus-5-thinking-max', label: 'Claude Opus 5 Thinking Max' },
    { value: 'claude-fable-5-1-high', label: 'Claude Fable 5.1' },
    { value: 'claude-fable-5-1-thinking-high', label: 'Claude Fable 5.1 Thinking' },
    { value: 'claude-sonnet-5-medium', label: 'Claude Sonnet 5' },
    { value: 'claude-sonnet-5-thinking-high', label: 'Claude Sonnet 5 Thinking' },
    { value: 'cursor-grok-4.6-medium', label: 'Grok 4.6' },
    { value: 'cursor-grok-4.6-high', label: 'Grok 4.6 High' },
    { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash' },
    { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { value: 'kimi-k3-high', label: 'Kimi K3' },
    { value: 'glm-5.2-high', label: 'GLM 5.2' },
  ],
  DEFAULT: 'auto',
};

const CURSOR_CHATS_ROOT = path.join(os.homedir(), '.cursor', 'chats');

const resolveCursorSessionStorePath = async (sessionId: string): Promise<string | null> => {
  const safeSessionId = sanitizeLeafDirectoryName(sessionId, 'cursor session id');

  try {
    const workspaceEntries = await readdir(CURSOR_CHATS_ROOT, { withFileTypes: true });
    for (const workspaceEntry of workspaceEntries) {
      if (!workspaceEntry.isDirectory()) {
        continue;
      }

      const storeDbPath = path.join(CURSOR_CHATS_ROOT, workspaceEntry.name, safeSessionId, 'store.db');
      try {
        await access(storeDbPath);
        return storeDbPath;
      } catch {
        // Keep scanning sibling workspaces until the matching session directory is found.
      }
    }
  } catch {
    return null;
  }

  return null;
};

/** Provider registry model adapter for Cursor predefined models and session metadata. */
export class CursorProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return CURSOR_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(CURSOR_PREDEFINED_MODELS);
    }

    try {
      const storeDbPath = await resolveCursorSessionStorePath(sessionId);
      if (!storeDbPath) {
        return buildDefaultProviderCurrentActiveModel(CURSOR_PREDEFINED_MODELS);
      }

      const { default: Database } = await import('better-sqlite3');
      const db = new Database(storeDbPath, { readonly: true, fileMustExist: true });

      try {
        const row = db.prepare(`SELECT value FROM meta WHERE key='0' LIMIT 1;`).get() as {
          value?: Buffer | string;
        } | undefined;
        const metadataText = Buffer.isBuffer(row?.value)
          ? row.value.toString('utf8')
          : typeof row?.value === 'string' && row.value.trim()
            ? Buffer.from(row.value.trim(), 'hex').toString('utf8')
            : '';
        if (!metadataText) {
          return buildDefaultProviderCurrentActiveModel(CURSOR_PREDEFINED_MODELS);
        }

        const metadata = JSON.parse(metadataText) as { lastUsedModel?: string };
        if (typeof metadata.lastUsedModel === 'string' && metadata.lastUsedModel.trim()) {
          return {
            model: metadata.lastUsedModel.trim(),
          };
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to the curated default when Cursor metadata cannot be read.
    }

    return buildDefaultProviderCurrentActiveModel(CURSOR_PREDEFINED_MODELS);
  }

  /** Records a per-session model override in the change file (see shared/utils). */
  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('cursor', input);
  }
}
