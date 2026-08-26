import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the Claude Code default model (currently Opus 5 with 1M context)',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available',
      description: 'Use Fable 5 when available, otherwise the latest Opus model.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable 5',
      description: 'Fable 5 · Most capable, for the hardest, longest-running tasks',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Sonnet 5 · Efficient for routine tasks',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Sonnet 5 with 1M context · Efficient for routine tasks',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Opus 5 · Best for everyday, complex tasks',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Haiku 4.5 · Fastest for quick answers',
    },
    {
      value: 'opusplan',
      label: 'Opus Plan',
      description: 'Opus while planning, then Sonnet for execution',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
  ],
  DEFAULT: 'default',
};

/** @deprecated Pre-1.37 name; the catalog is now CLAUDE_PREDEFINED_MODELS. */
export const CLAUDE_FALLBACK_MODELS = CLAUDE_PREDEFINED_MODELS;

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
/**
 * Transcript rows record full model ids (`claude-fable-5`,
 * `claude-sonnet-4-6-...`) while the picker catalog uses short aliases
 * (`fable`, `sonnet`, ...). Collapse known ids onto their alias so the UI can
 * both display the truth and highlight the matching catalog card.
 */
const CLAUDE_MODEL_ID_ALIAS_PATTERNS: Array<[RegExp, string]> = [
  [/fable|mythos/i, 'fable'],
  [/opus/i, 'opus'],
  [/sonnet/i, 'sonnet'],
  [/haiku/i, 'haiku'],
];

export const normalizeClaudeModelToCatalogValue = (model: string): string => {
  const trimmed = model.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (CLAUDE_FALLBACK_MODELS.OPTIONS.some((option) => option.value === trimmed)) {
    return trimmed;
  }
  for (const [pattern, alias] of CLAUDE_MODEL_ID_ALIAS_PATTERNS) {
    if (pattern.test(trimmed)) {
      const withContext = /\[1m\]/i.test(trimmed) ? `${alias}[1m]` : alias;
      return CLAUDE_FALLBACK_MODELS.OPTIONS.some((option) => option.value === withContext)
        ? withContext
        : alias;
    }
  }
  return trimmed;
};

type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:'
  + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  + '|(?:[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel || null;
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    if (changedModel?.[1]?.trim()) {
      return changedModel[1].trim();
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag || null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

export class ClaudeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // claude creates a new jsonl file as a separate session for this request.
    // As a result, it lists the workspace where this is invoked when it shouldn't.
    //
    // Disabled for now:
    // const queryInstance = query({
    //   prompt: 'Get supported models',
    //   options: buildClaudeQueryOptions(),
    // });
    // const supportedModels = await queryInstance.supportedModels();
    // queryInstance.close();
    // return buildClaudeModelsDefinition(supportedModels);
    return CLAUDE_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      // The caller addresses sessions by the app-allocated id, but transcript
      // rows carry the provider-native id — matching against the wrong one
      // rejected every row and always reported the catalog default.
      const row = sessionsDb.getSessionById(sessionId)
        ?? sessionsDb.getSessionByProviderSessionId(sessionId);
      const jsonlPath = row?.jsonl_path;
      const transcriptSessionId = row?.provider_session_id ?? sessionId;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(transcriptSessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return { model: normalizeClaudeModelToCatalogValue(activeModel.model) };
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('claude', input);
  }
}
