import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';

import { authenticatedFetch } from '../../../utils/api';
import { downscaleImageFiles } from '../../../utils/imageDownscale';
import { readActiveWorktree, bindSessionCwd, getSessionCwd } from '../../../hooks/useActiveWorktree';
import type { MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import { grantClaudeToolPermission } from '../utils/chatPermissions';
import { safeLocalStorage } from '../utils/chatStorage';
import type {
  ChatMessage,
  PendingPermissionRequest,
  PermissionMode,
  SessionEstablishedContext,
} from '../types/types';
import type { Project, ProjectSession, LLMProvider, ProviderModelsCacheInfo } from '../../../types/app';
import { escapeRegExp } from '../utils/chatFormatting';

import { useFileMentions } from './useFileMentions';
import { type SlashCommand, useSlashCommands } from './useSlashCommands';

interface UseChatComposerStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  cursorModel: string;
  claudeModel: string;
  codexModel: string;
  geminiModel: string;
  opencodeModel: string;
  isLoading: boolean;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  sendByCtrlEnter?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /**
   * Optimistically drops the rewound message and everything after it from the
   * visible transcript before the edited message is resent. Wired to the
   * session store's `rewindTo`.
   */
  onRewindTruncate?: (sessionId: string, messageUuid: string) => void;
}

interface MentionableFile {
  name: string;
  path: string;
}

/** A message captured while a run was processing, awaiting auto-send when idle. */
export interface QueuedMessage {
  id: string;
  content: string;
  /** How many images the queued message carries (already uploaded server-side). */
  imageCount: number;
}

// Cap the pending queue so a runaway loop can't accumulate unbounded sends.
const MAX_QUEUED_MESSAGES = 20;

// Attachment caps — mirrored by the server's upload-images endpoint limits.
const MAX_ATTACHMENT_MB = 20;
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 10;

interface CommandExecutionResult {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
}

export type ModelCommandData = {
  current?: {
    provider?: string;
    providerLabel?: string;
    model?: string;
  };
  available?: Partial<Record<LLMProvider, string[]>>;
  availableModels?: string[];
  availableOptions?: Array<{
    value: string;
    label?: string;
    description?: string;
  }>;
  defaultModel?: string;
  cache?: ProviderModelsCacheInfo;
};

export type CostCommandData = {
  tokenUsage?: {
    used?: number;
    total?: number;
  };
  tokenBreakdown?: {
    input?: number;
    output?: number;
  };
  provider?: string;
  model?: string;
};

export type StatusCommandData = {
  version?: string;
  packageName?: string;
  uptime?: string;
  model?: string;
  provider?: string;
  nodeVersion?: string;
  platform?: string;
  pid?: number;
  memoryUsage?: {
    rssMb?: number;
    heapUsedMb?: number;
    heapTotalMb?: number;
  };
};

export type HelpCommandData = {
  content?: string;
  format?: string;
  commands?: Array<{
    name: string;
    description?: string;
    namespace?: string;
  }>;
};

export type CommandModalKind = 'help' | 'models' | 'cost' | 'status';

export type CommandModalPayload = {
  kind: CommandModalKind;
  data: HelpCommandData | ModelCommandData | CostCommandData | StatusCommandData;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  cursorModel,
  claudeModel,
  codexModel,
  geminiModel,
  opencodeModel,
  isLoading,
  canAbortSession,
  tokenBudget,
  sendMessage,
  sendByCtrlEnter,
  onSessionProcessing,
  onSessionEstablished,
  onInputFocusChange,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
  onRewindTruncate,
}: UseChatComposerStateArgs) {
  const [input, setInput] = useState(() => {
    if (typeof window !== 'undefined' && selectedProject) {
      // Draft inputs are keyed by the DB projectId so per-project drafts
      // survive display-name changes.
      return safeLocalStorage.getItem(`draft_input_${selectedProject.projectId}`) || '';
    }
    return '';
  });
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [uploadingImages, setUploadingImages] = useState<Map<string, number>>(new Map());
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  // Lets handleBuiltInCommand (defined earlier) dispatch a provider-native
  // command without re-entering the slash interception in handleSubmit.
  const runSubmitRef = useRef<((content: string, images: File[]) => Promise<boolean>) | null>(null);
  const handleSubmitRef = useRef<
    ((event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  // Last send dispatched to the backend, kept so it can be re-queued (rather
  // than lost) if the server rejects it with RUN_IN_PROGRESS — a state-desync
  // where the client thought the session idle. Consumed one-shot by the
  // 'vibespace:run-in-progress' listener below.
  const lastSubmittedRef = useRef<{ sessionId: string; content: string; images: File[] } | null>(null);
  const selectedProjectId = selectedProject?.projectId;

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        case 'passthrough': {
          // Provider-native command (e.g. /compact): send it verbatim as the
          // next prompt — the provider CLI executes it itself.
          const prompt = typeof data?.prompt === 'string' ? data.prompt : '';
          if (prompt) {
            void runSubmitRef.current?.(prompt, []);
          }
          break;
        }

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent());
      }
    }, 0);
  }, [addMessage]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId,
          provider,
          model: provider === 'cursor'
            ? cursorModel
            : provider === 'codex'
              ? codexModel
              : provider === 'gemini'
                ? geminiModel
                : provider === 'opencode'
                  ? opencodeModel
                  : claudeModel,
          tokenUsage: tokenBudget,
        };

        const response = await authenticatedFetch('/api/commands/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            commandName: command.name,
            commandPath: command.path,
            args,
            context,
          }),
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      claudeModel,
      codexModel,
      currentSessionId,
      cursorModel,
      geminiModel,
      opencodeModel,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      addMessage,
      tokenBudget,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  // Any file type is attachable (claude reads them from temp paths, opencode
  // takes them via `-f`); oversized images still get downscaled before upload.
  const handleImageFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (!file.size || file.size > MAX_ATTACHMENT_BYTES) {
          const fileName = file.name || 'Unknown file';
          setImageErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, `File too large (max ${MAX_ATTACHMENT_MB}MB)`);
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedImages((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (item.kind !== 'file') {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleImageFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        handleImageFiles(Array.from(event.clipboardData.files));
      }
    },
    [handleImageFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_BYTES,
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleImageFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Reset the composer fields after a message is captured for sending/queueing.
  const clearComposer = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    setAttachedImages([]);
    setUploadingImages(new Map());
    setImageErrors(new Map());
    setIsTextareaExpanded(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    if (selectedProjectId) {
      safeLocalStorage.removeItem(`draft_input_${selectedProjectId}`);
    }
  }, [resetCommandMenuState, selectedProjectId]);

  // Composer-level model preference for the active provider. Sent with every
  // turn (live send or queued) as an option; the backend resolves the rest.
  const activeModel = useMemo(() => {
    switch (provider) {
      case 'cursor':
        return cursorModel;
      case 'codex':
        return codexModel;
      case 'gemini':
        return geminiModel;
      case 'opencode':
        return opencodeModel;
      default:
        return claudeModel;
    }
  }, [provider, cursorModel, codexModel, geminiModel, opencodeModel, claudeModel]);

  const getToolsSettings = useCallback(() => {
    try {
      const settingsKey =
        provider === 'cursor'
          ? 'cursor-tools-settings'
          : provider === 'codex'
            ? 'codex-settings'
            : provider === 'gemini'
              ? 'gemini-settings'
              : provider === 'opencode'
                ? 'opencode-settings'
                : 'claude-settings';
      const savedSettings = safeLocalStorage.getItem(settingsKey);
      if (savedSettings) {
        return JSON.parse(savedSettings);
      }
    } catch (error) {
      console.error('Error loading tools settings:', error);
    }

    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
    };
  }, [provider]);

  // Upload composer attachments and return the server-side image descriptors
  // (empty when there are none). Returns null on failure after surfacing an
  // error bubble, so callers can abort without clearing the composer.
  const uploadAttachedImages = useCallback(
    async (images: File[]): Promise<unknown[] | null> => {
      if (images.length === 0 || !selectedProject) {
        return [];
      }
      // Phone photos routinely exceed the 5MB cap and the proxy body limit.
      // Re-encode/bound them client-side before upload (no-op when already
      // small, original kept on any decode/encode failure).
      const filesToUpload = await downscaleImageFiles(images);
      const formData = new FormData();
      filesToUpload.forEach((file) => {
        formData.append('images', file);
      });

      try {
        const response = await authenticatedFetch(`/api/projects/${selectedProject.projectId}/upload-images`, {
          method: 'POST',
          headers: {},
          body: formData,
        });
        if (!response.ok) {
          throw new Error('Failed to upload images');
        }
        const result = await response.json();
        return result.images;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Image upload failed:', error);
        addMessage({
          type: 'error',
          content: `Failed to upload images: ${message}`,
          timestamp: new Date(),
        });
        return null;
      }
    },
    [selectedProject, addMessage],
  );

  /**
   * Core send: uploads attachments, resolves (or allocates) the session, marks
   * it processing, and dispatches the unified chat.send. Returns false when the
   * send could not be started (upload/session-creation failure) so the caller
   * can keep the composer contents instead of clearing them.
   */
  const runSubmit = useCallback(
    async (content: string, images: File[]): Promise<boolean> => {
      if (!selectedProject) {
        return false;
      }

      const uploadedImages = await uploadAttachedImages(images);
      if (uploadedImages === null) {
        return false;
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, content);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
        try {
          const response = await authenticatedFetch('/api/providers/sessions', {
            method: 'POST',
            body: JSON.stringify({
              provider,
              projectPath: resolvedProjectPath,
            }),
          });
          if (!response.ok) {
            throw new Error(`Failed to create session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return false;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return false;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: sessionSummary,
        });
      }

      // Worktree-aware cwd. An existing session resolves to its pinned worktree
      // (or a stable binding made earlier this page session); a brand-new
      // session resolves to the project's active worktree. bindSessionCwd keeps
      // the cwd stable across a session's messages before the server-synced
      // worktreePath is available. `null` worktree falls back to the project.
      const isExistingSession = Boolean(selectedSession?.id || currentSessionId);
      const sessionWorktreePath = (selectedSession?.worktreePath as string | null | undefined) ?? null;
      const effectiveCwd =
        getSessionCwd(targetSessionId) ||
        (isExistingSession
          ? sessionWorktreePath || resolvedProjectPath
          : readActiveWorktree(selectedProject.projectId)?.path || resolvedProjectPath);
      bindSessionCwd(targetSessionId, effectiveCwd);

      const userMessage: ChatMessage = {
        type: 'user',
        content,
        images: uploadedImages as any,
        timestamp: new Date(),
      };

      addMessage(userMessage);
      // Mark this request as processing in the per-session activity map (the
      // single source of truth the indicator derives from). The id is always
      // concrete at this point — no pending placeholder exists anymore.
      onSessionProcessing?.(targetSessionId, {
        statusText: null,
        canInterrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      const toolsSettings = getToolsSettings();
      const model = activeModel;

      // Remember this send so the RUN_IN_PROGRESS recovery below can re-queue
      // it if the backend rejects it (the client believed the session idle but
      // a run was actually active). The original File[] is kept so a re-send
      // re-uploads cleanly.
      lastSubmittedRef.current = { sessionId: targetSessionId, content, images };

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      sendMessage({
        type: 'chat.send',
        sessionId: targetSessionId,
        content,
        options: {
          cwd: effectiveCwd,
          model,
          // Codex has no plan mode; downgrade rather than sending an
          // unsupported value to its runtime.
          permissionMode: provider === 'codex' && permissionMode === 'plan' ? 'default' : permissionMode,
          toolsSettings,
          skipPermissions: toolsSettings?.skipPermissions || false,
          sessionSummary,
          images: uploadedImages,
        },
      });

      return true;
    },
    [
      selectedSession,
      activeModel,
      getToolsSettings,
      uploadAttachedImages,
      currentSessionId,
      onSessionProcessing,
      onSessionEstablished,
      permissionMode,
      provider,
      scrollToBottom,
      selectedProject,
      sendMessage,
      addMessage,
      setIsUserScrolledUp,
    ],
  );

  /**
   * Queue a message on the server for this session (shared across all clients
   * viewing it; the server drains it when the current run finishes). Uploads
   * attachments first, then dispatches `chat.queue-add` with the same options a
   * live send would carry. Optimistically shows the item; the server's
   * `queue_updated` broadcast reconciles it (matched by id).
   */
  const enqueueMessage = useCallback(
    async (content: string, images: File[]): Promise<void> => {
      const targetSessionId = selectedSession?.id || currentSessionId;
      if (!targetSessionId || !selectedProject) {
        return;
      }

      const uploadedImages = await uploadAttachedImages(images);
      if (uploadedImages === null) {
        return;
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionWorktreePath = (selectedSession?.worktreePath as string | null | undefined) ?? null;
      const effectiveCwd =
        getSessionCwd(targetSessionId) ||
        sessionWorktreePath ||
        readActiveWorktree(selectedProject.projectId)?.path ||
        resolvedProjectPath;

      const toolsSettings = getToolsSettings();
      const id = `queued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Optimistic: show it immediately; the broadcast will replace this list.
      setQueuedMessages((previous) =>
        [...previous, { id, content, imageCount: images.length }].slice(-MAX_QUEUED_MESSAGES),
      );

      sendMessage({
        type: 'chat.queue-add',
        sessionId: targetSessionId,
        id,
        content,
        options: {
          cwd: effectiveCwd,
          model: activeModel,
          permissionMode: provider === 'codex' && permissionMode === 'plan' ? 'default' : permissionMode,
          toolsSettings,
          skipPermissions: toolsSettings?.skipPermissions || false,
          sessionSummary: getNotificationSessionSummary(selectedSession, content),
          images: uploadedImages,
        },
      });
    },
    [
      selectedSession,
      currentSessionId,
      selectedProject,
      uploadAttachedImages,
      getToolsSettings,
      activeModel,
      permissionMode,
      provider,
      sendMessage,
    ],
  );

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
    ) => {
      event.preventDefault();
      const currentInput = inputValueRef.current;
      if (!currentInput.trim() || !selectedProject) {
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      if (commandInput.startsWith('/') || isHelpAlias) {
        const firstSpace = commandInput.indexOf(' ');
        const commandName = isHelpAlias
          ? '/help'
          : firstSpace > 0 ? commandInput.slice(0, firstSpace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        if (matchedCommand && matchedCommand.type !== 'skill') {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          clearComposer();
          return;
        }
      }

      // While a run is processing, queue the message on the server instead of
      // dropping it; the server sends queued items in order once the run
      // finishes, and the queue is shared across every client viewing the
      // session. The composer clears immediately so the user can keep typing.
      if (isLoading) {
        void enqueueMessage(currentInput, attachedImages);
        clearComposer();
        return;
      }

      const content = currentInput;
      const images = attachedImages;
      clearComposer();
      const ok = await runSubmit(content, images);
      if (!ok) {
        // Restore the unsent text/attachments so a failed send isn't lost.
        setInput(content);
        inputValueRef.current = content;
        setAttachedImages(images);
      }
    },
    [
      attachedImages,
      clearComposer,
      enqueueMessage,
      executeCommand,
      isLoading,
      runSubmit,
      selectedProject,
      slashCommands,
    ],
  );

  // The server owns queue draining now: it sends the next queued message when a
  // run completes (chaining until the queue empties), so there is no client
  // auto-send effect. The client only adds/removes items and renders the
  // server's `queue_updated` snapshot.

  // Recover from a RUN_IN_PROGRESS rejection: the realtime handler marks the
  // session processing again and fires this event. Re-queue the just-rejected
  // send on the server so it isn't lost — the server then sends it once the
  // (genuinely active) run completes. One-shot per rejection.
  useEffect(() => {
    const onRunInProgress = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      const pending = lastSubmittedRef.current;
      if (!pending || !detail?.sessionId || detail.sessionId !== pending.sessionId) {
        return;
      }
      lastSubmittedRef.current = null;
      void enqueueMessage(pending.content, pending.images);
    };
    window.addEventListener('vibespace:run-in-progress', onRunInProgress);
    return () => window.removeEventListener('vibespace:run-in-progress', onRunInProgress);
  }, [enqueueMessage]);

  // Render the server-owned queue for the currently-viewed session. The
  // realtime handler forwards both the `chat_subscribed` snapshot and live
  // `queue_updated` broadcasts here; ignore events for other sessions.
  useEffect(() => {
    const activeSessionId = selectedSession?.id || currentSessionId || null;
    const onQueueUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; queue?: Array<{ id: string; content: string; imageCount?: number }> }>).detail;
      if (!detail?.sessionId || detail.sessionId !== activeSessionId) {
        return;
      }
      const queue = Array.isArray(detail.queue) ? detail.queue : [];
      setQueuedMessages(
        queue.map((item) => ({
          id: item.id,
          content: item.content,
          imageCount: typeof item.imageCount === 'number' ? item.imageCount : 0,
        })),
      );
    };
    window.addEventListener('vibespace:queue-updated', onQueueUpdated);
    return () => window.removeEventListener('vibespace:queue-updated', onQueueUpdated);
  }, [selectedSession?.id, currentSessionId]);

  // Clear the visible queue when switching sessions; the new session's
  // `chat_subscribed` snapshot repopulates it.
  useEffect(() => {
    setQueuedMessages([]);
  }, [selectedSession?.id, currentSessionId]);

  const removeQueuedMessage = useCallback(
    (id: string) => {
      const targetSessionId = selectedSession?.id || currentSessionId;
      // Optimistic removal; the server broadcasts the authoritative queue.
      setQueuedMessages((previous) => previous.filter((message) => message.id !== id));
      if (targetSessionId) {
        sendMessage({ type: 'chat.queue-remove', sessionId: targetSessionId, id });
      }
    },
    [selectedSession?.id, currentSessionId, sendMessage],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
    runSubmitRef.current = runSubmit;
  }, [handleSubmit, runSubmit]);

  /**
   * Rewind / edit-in-place: re-send an edited past user message, dropping that
   * message and everything after it. Only Claude and OpenCode sessions support
   * it (their transcripts can be truncated in place); other providers never
   * surface the affordance because their messages carry no `uuid` anchor. The
   * `rewind` anchor rides in the chat.send options; the backend truncates the
   * transcript at the anchor, then resumes in-place from that point.
   */
  const rewindMessage = useCallback(
    (message: ChatMessage, newContent: string) => {
      const rewindUuid = typeof message.uuid === 'string' ? message.uuid : null;
      const content = newContent.trim();
      if (!rewindUuid || !content || !selectedProject) {
        return;
      }
      if (provider !== 'claude' && provider !== 'opencode') {
        return;
      }

      // Rewind only makes sense for an already-persisted session.
      const effectiveSessionId = selectedSession?.id || currentSessionId || null;
      if (!effectiveSessionId) {
        return;
      }

      // Carry the original attachments over unchanged (already data URLs).
      const images = Array.isArray(message.images) ? message.images : [];

      // Optimistically drop the edited message + its responses from the view,
      // then show the edited message as the new tail.
      onRewindTruncate?.(effectiveSessionId, rewindUuid);
      addMessage({
        type: 'user',
        content,
        images: images as ChatMessage['images'],
        timestamp: new Date(),
      });
      onSessionProcessing?.(effectiveSessionId, { statusText: null, canInterrupt: true });
      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      let toolsSettings: Record<string, unknown> = {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      };
      try {
        const settingsKey = provider === 'opencode' ? 'opencode-settings' : 'claude-settings';
        const saved = safeLocalStorage.getItem(settingsKey);
        if (saved) {
          toolsSettings = JSON.parse(saved);
        }
      } catch (error) {
        console.error('Error loading tools settings:', error);
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, content);
      const sessionWorktreePath = (selectedSession?.worktreePath as string | null | undefined) ?? null;
      const effectiveCwd =
        getSessionCwd(effectiveSessionId) || sessionWorktreePath || resolvedProjectPath;
      bindSessionCwd(effectiveSessionId, effectiveCwd);

      const model = provider === 'opencode' ? opencodeModel : claudeModel;

      // Same unified shape as handleSubmit's chat.send, plus the `rewind` anchor.
      sendMessage({
        type: 'chat.send',
        sessionId: effectiveSessionId,
        content,
        options: {
          cwd: effectiveCwd,
          model,
          permissionMode,
          toolsSettings,
          skipPermissions: Boolean(toolsSettings?.skipPermissions),
          sessionSummary,
          images,
          rewind: rewindUuid,
        },
      });
    },
    [
      selectedProject,
      selectedSession,
      currentSessionId,
      provider,
      claudeModel,
      opencodeModel,
      permissionMode,
      onRewindTruncate,
      onSessionProcessing,
      addMessage,
      sendMessage,
      scrollToBottom,
      setIsUserScrolledUp,
    ],
  );

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    const savedInput = safeLocalStorage.getItem(`draft_input_${selectedProjectId}`) || '';
    setInput((previous) => {
      const next = previous === savedInput ? previous : savedInput;
      inputValueRef.current = next;
      return next;
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }
    if (input !== '') {
      safeLocalStorage.setItem(`draft_input_${selectedProjectId}`, input);
    } else {
      safeLocalStorage.removeItem(`draft_input_${selectedProjectId}`);
    }
  }, [input, selectedProjectId]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if (event.nativeEvent.isComposing) {
          return;
        }

        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !sendByCtrlEnter) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleClearInput = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    resetCommandMenuState();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
    setIsTextareaExpanded(false);
  }, [resetCommandMenuState]);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
      onInputFocusChange?.(focused);
    },
    [onInputFocusChange],
  );

  return {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker: open,
    handleSubmit,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    rewindMessage,
    queuedMessages,
    removeQueuedMessage,
  };
}
