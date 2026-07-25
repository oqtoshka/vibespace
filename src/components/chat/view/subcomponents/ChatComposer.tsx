import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import { MessageSquareIcon, XIcon, Clock3, Loader2, PaperclipIcon, ChevronDown, Check, ArrowUpIcon, ActivityIcon, MoreHorizontalIcon } from 'lucide-react';

import type { QueuedMessage } from '../../hooks/useChatComposerState';

import { useToolbarOverflow } from '../../hooks/useToolbarOverflow';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { useVoiceAvailable } from '../../hooks/useVoiceAvailable';
import type { SessionActivity } from '../../../../hooks/useSessionProtection';
import type { PendingPermissionRequest, PermissionMode } from '../../types/types';
import type { ProviderModelOption } from '../../../../types/app';
import type { ContextUsage } from '../../../../stores/useSessionStore';
import {
  PromptInput,
  PromptInputHeader,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
} from '../../../../shared/view/ui';

import CommandMenu from './CommandMenu';
import ActivityIndicator from './ActivityIndicator';
import ImageAttachment from './ImageAttachment';
import VoiceInputButton from './VoiceInputButton';
import PermissionRequestsBanner from './PermissionRequestsBanner';
import TokenUsageSummary, { formatTokenCount, readUsedTokens, resolveContextGauge } from './TokenUsageSummary';
import { AnchoredPopover } from './AnchoredPopover';
import BackgroundTasksIndicator from './BackgroundTasksIndicator';
import SubagentsIndicator from './SubagentsIndicator';
import type { BackgroundTask } from '../../hooks/useBackgroundTasks';
import type { Subagent } from '../../hooks/useSubagents';

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ChatComposerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  activity: SessionActivity | null;
  isLoading: boolean;
  onAbortSession: () => void;
  permissionMode: PermissionMode | string;
  onModeSwitch: () => void;
  effort: string;
  availableEffortOptions: NonNullable<ProviderModelOption['effort']>['values'];
  onSelectEffort: (effort: string) => void;
  tokenBudget: Record<string, unknown> | null;
  contextUsage: ContextUsage | null;
  onShowTokenUsage: () => void;
  backgroundTasks: BackgroundTask[];
  backgroundRunningCount: number;
  subagents: Subagent[];
  subagentRunningCount: number;
  sessionId: string | null;
  slashCommandsCount: number;
  onToggleCommandMenu: () => void;
  hasInput: boolean;
  onClearInput: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement> | TouchEvent<HTMLButtonElement>) => void;
  isDragActive: boolean;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;
  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;
  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  openImagePicker: () => void;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  textareaRef: RefObject<HTMLTextAreaElement>;
  input: string;
  onVoiceTranscript?: (text: string, send?: boolean) => void;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  isInputFocused?: boolean;
  onInputFocusChange?: (focused: boolean) => void;
  placeholder: string;
  isTextareaExpanded: boolean;
  sendByCtrlEnter?: boolean;
  queuedMessages?: QueuedMessage[];
  onRemoveQueuedMessage?: (id: string) => void;
}

export default function ChatComposer({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  activity,
  isLoading,
  onAbortSession,
  permissionMode,
  onModeSwitch,
  effort,
  availableEffortOptions,
  onSelectEffort,
  tokenBudget,
  contextUsage,
  backgroundTasks,
  backgroundRunningCount,
  subagents,
  subagentRunningCount,
  sessionId,
  onShowTokenUsage,
  slashCommandsCount,
  onToggleCommandMenu,
  hasInput,
  onClearInput,
  onSubmit,
  isDragActive,
  attachedImages,
  onRemoveImage,
  uploadingImages,
  imageErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  getRootProps,
  getInputProps,
  openImagePicker,
  inputHighlightRef,
  renderInputWithMentions,
  textareaRef,
  input,
  onVoiceTranscript,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  isInputFocused = false,
  onInputFocusChange,
  placeholder,
  isTextareaExpanded,
  sendByCtrlEnter,
  queuedMessages,
  onRemoveQueuedMessage,
}: ChatComposerProps) {
  const { t, i18n } = useTranslation('chat');
  const commandMenuPosition = useMemo(() => {
    if (!isCommandMenuOpen) {
      return { top: 0, left: 16, bottom: 90 };
    }
    const textareaRect = textareaRef.current?.getBoundingClientRect();
    return {
      top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
      left: textareaRect ? textareaRect.left : 16,
      bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
    };
  }, [isCommandMenuOpen, textareaRef]);

  // Voice state is hosted here (not in the mic button) so the main Send button can stop
  // recording and send the transcript in one tap, the way the mic button drops it in the box.
  const voiceAvailable = useVoiceAvailable();
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleVoiceError = useCallback((msg: string) => {
    setVoiceError(msg);
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
    voiceErrorTimer.current = setTimeout(() => setVoiceError(null), 4000);
  }, []);
  useEffect(() => () => {
    if (voiceErrorTimer.current) clearTimeout(voiceErrorTimer.current);
  }, []);
  const noopTranscript = useCallback(() => {}, []);
  const { state: voiceState, toggle: voiceToggle, stop: voiceStop } = useVoiceInput(
    onVoiceTranscript ?? noopTranscript,
    handleVoiceError,
  );
  const isRecording = voiceState === 'recording';
  const isTranscribing = voiceState === 'transcribing';
  // "…" menu holding the secondary controls whenever they don't fit inline.
  const [isOverflowOpen, setIsOverflowOpen] = useState(false);
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  const footerActionsRef = useRef<HTMLDivElement | null>(null);
  const [isEffortDropdownOpen, setIsEffortDropdownOpen] = useState(false);
  const effortDropdownRef = useRef<HTMLDivElement | null>(null);
  const effortDropdownMenuRef = useRef<HTMLDivElement | null>(null);
  const effortDropdownButtonRef = useRef<HTMLButtonElement | null>(null);
  const [effortDropdownPosition, setEffortDropdownPosition] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);
  const effortOptions = useMemo(
    () => [{ value: 'default' }, ...availableEffortOptions],
    [availableEffortOptions],
  );
  const selectedEffortLabel = effort === 'default' ? 'Default' : effort;

  const hasBackgroundTasks = backgroundTasks.length > 0;
  const hasSubagents = subagents.length > 0;
  // Everything that changes the toolbar's natural width without changing the
  // footer's — the live indicators are the usual cause, since they appear
  // mid-run and are exactly what pushed send off the edge before.
  const toolbarSignature = [
    hasBackgroundTasks ? backgroundRunningCount || backgroundTasks.length : 0,
    hasSubagents ? subagentRunningCount || subagents.length : 0,
    hasInput ? 1 : 0,
    effortOptions.length,
    permissionMode,
    selectedEffortLabel,
    slashCommandsCount,
    i18n.language,
  ].join('|');

  const isToolbarCollapsed = useToolbarOverflow({
    containerRef: footerRef,
    toolsRef,
    actionsRef: footerActionsRef,
    signature: toolbarSignature,
  });

  // The "…" button unmounts when the row expands again (widened window, an
  // indicator finishing) — drop the open state with it so the menu doesn't
  // reappear already-open the next time the row collapses.
  useEffect(() => {
    if (!isToolbarCollapsed) {
      setIsOverflowOpen(false);
    }
  }, [isToolbarCollapsed]);
  const updateEffortDropdownPosition = useCallback(() => {
    const rect = effortDropdownButtonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    setEffortDropdownPosition({
      left: rect.left,
      top: rect.top - 8,
      maxHeight: Math.max(96, rect.top - 16),
    });
  }, []);

  useEffect(() => {
    if (!isEffortDropdownOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !effortDropdownRef.current?.contains(target)
        && !effortDropdownMenuRef.current?.contains(target)
      ) {
        setIsEffortDropdownOpen(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setIsEffortDropdownOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updateEffortDropdownPosition);
    window.addEventListener('scroll', updateEffortDropdownPosition, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    updateEffortDropdownPosition();

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updateEffortDropdownPosition);
      window.removeEventListener('scroll', updateEffortDropdownPosition, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isEffortDropdownOpen, updateEffortDropdownPosition]);

  // Detect if the AskUserQuestion interactive panel is active
  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion'
  );

  // Hide the thinking/status bar while any permission request is pending
  const hasPendingPermissions = pendingPermissionRequests.length > 0;
  const hasActivityIndicator = Boolean(activity && !hasPendingPermissions);

  const hasQueuedDraft = (queuedMessages?.length ?? 0) > 0;
  const canQueueDraft = isLoading && Boolean(input.trim());
  const submitHint = canQueueDraft
    ? hasQueuedDraft
      ? t('input.hintText.updateQueued', { defaultValue: 'Enter to update queued message' })
      : t('input.hintText.queue', { defaultValue: 'Enter to queue your next message' })
    : sendByCtrlEnter
      ? t('input.hintText.ctrlEnter')
      : t('input.hintText.enter');
  const submitAriaLabel = canQueueDraft
    ? hasQueuedDraft
      ? t('input.queue.update', { defaultValue: 'Update queued message' })
      : t('input.queue.sendNext', { defaultValue: 'Queue next message' })
    : isLoading
      ? t('input.stop')
      : t('input.send');

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-2 pt-0 sm:px-4 sm:pb-4 md:px-4 md:pb-6">
      {!hasPendingPermissions && (
        <div className="pointer-events-none absolute bottom-full left-1/2 z-10 w-[calc(100%-1rem)] max-w-[54.25rem] -translate-x-1/2 translate-y-px bg-transparent sm:w-[calc(100%-2rem)]">
          <ActivityIndicator activity={activity} onAbort={onAbortSession} isInputFocused={isInputFocused} />
        </div>
      )}

      {pendingPermissionRequests.length > 0 && (
        <div className="mx-auto mb-3 max-w-[54.25rem]">
          <PermissionRequestsBanner
            pendingPermissionRequests={pendingPermissionRequests}
            handlePermissionDecision={handlePermissionDecision}
            handleGrantToolPermission={handleGrantToolPermission}
          />
        </div>
      )}

      {!hasQuestionPanel && <div className="relative mx-auto max-w-[54.25rem]">
        {showFileDropdown && filteredFiles.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border/50 bg-card/95 shadow-lg backdrop-blur-md">
            {filteredFiles.map((file, index) => (
              <div
                key={file.path}
                className={`cursor-pointer touch-manipulation border-b border-border/30 px-4 py-3 last:border-b-0 ${
                  index === selectedFileIndex
                    ? 'bg-primary/8 text-primary'
                    : 'text-foreground hover:bg-accent/50'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectFile(file);
                }}
              >
                <div className="text-sm font-medium">{file.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{file.path}</div>
              </div>
            ))}
          </div>
        )}

        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={onCommandSelect}
          onClose={onCloseCommandMenu}
          position={commandMenuPosition}
          isOpen={isCommandMenuOpen}
          frequentCommands={frequentCommands}
        />

        <PromptInput
          onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
          status={isLoading ? 'streaming' : 'ready'}
          className={[
            isTextareaExpanded ? 'chat-input-expanded' : '',
            hasActivityIndicator ? 'rounded-t-none' : '',
          ].filter(Boolean).join(' ')}
          {...getRootProps()}
        >
          {isDragActive && (
            <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/15">
              <div className="rounded-xl border border-border/30 bg-card p-4 shadow-lg">
                <svg className="mx-auto mb-2 h-8 w-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
                <p className="text-sm font-medium">Drop files here</p>
              </div>
            </div>
          )}

          {queuedMessages && queuedMessages.length > 0 && (
            <PromptInputHeader>
              <div className="space-y-1 rounded-xl bg-muted/40 p-2">
                {queuedMessages.map((queued) => (
                  <div
                    key={queued.id}
                    className="flex items-center gap-2 rounded-lg bg-background/60 px-2 py-1 text-xs text-muted-foreground"
                  >
                    <Clock3 className="h-3 w-3 flex-shrink-0 opacity-70" />
                    <span className="min-w-0 flex-1 truncate" title={queued.content}>
                      {queued.content}
                    </span>
                    {queued.imageCount > 0 && (
                      <span className="flex-shrink-0 opacity-70">
                        {queued.imageCount}
                        <PaperclipIcon className="ml-0.5 inline h-3 w-3" />
                      </span>
                    )}
                    {onRemoveQueuedMessage && (
                      <button
                        type="button"
                        onClick={() => onRemoveQueuedMessage(queued.id)}
                        className="flex-shrink-0 rounded p-0.5 hover:bg-muted"
                        aria-label={t('queue.remove', { defaultValue: 'Remove queued message' })}
                      >
                        <XIcon className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </PromptInputHeader>
          )}

          {attachedImages.length > 0 && (
            <PromptInputHeader>
              <div className="rounded-xl bg-muted/40 p-2">
                <div className="flex flex-wrap gap-2">
                  {attachedImages.map((file, index) => (
                    <ImageAttachment
                      key={index}
                      file={file}
                      onRemove={() => onRemoveImage(index)}
                      uploadProgress={uploadingImages.get(file.name)}
                      error={imageErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            </PromptInputHeader>
          )}

          <input {...getInputProps()} />

          <PromptInputBody>
            <div ref={inputHighlightRef} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
              <div className="chat-input-placeholder block w-full whitespace-pre-wrap break-words px-4 py-2 text-sm leading-6 text-transparent">
                {renderInputWithMentions(input)}
              </div>
            </div>

            <PromptInputTextarea
              ref={textareaRef}
              // Without an explicit rows the browser default is 2, leaving a
              // permanent empty line under the placeholder; autosize takes over
              // as soon as there is content.
              rows={1}
              dir="auto"
              value={input}
              onChange={onInputChange}
              onClick={onTextareaClick}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              onScroll={(event) => onTextareaScrollSync(event.target as HTMLTextAreaElement)}
              onFocus={() => onInputFocusChange?.(true)}
              onBlur={() => onInputFocusChange?.(false)}
              onInput={onTextareaInput}
              placeholder={placeholder}
            />
        </PromptInputBody>

        <PromptInputFooter ref={footerRef} className="gap-3">
          {/* Shrink priority, in order: the hint text truncates, then the
              toolbar clips (and collapses into "…" before it gets that far).
              Mic and send never shrink and never leave the box — a clipped
              send button is the one failure the user cannot work around. */}
          <PromptInputTools ref={toolsRef} className="min-w-0 shrink overflow-hidden">
            <PromptInputButton
              tooltip={{ content: t('input.attachFiles', { defaultValue: 'Attach files' }) }}
              onClick={openImagePicker}
            >
              <PaperclipIcon />
            </PromptInputButton>

            <button
              type="button"
              onClick={onModeSwitch}
              className={`inline-flex h-8 items-center rounded-lg border px-2 text-xs font-medium transition-all duration-200 sm:px-2.5 ${
                permissionMode === 'default'
                  ? 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted'
                  : permissionMode === 'acceptEdits'
                    ? 'border-green-300/60 bg-green-50 text-green-700 hover:bg-green-100 dark:border-green-600/40 dark:bg-green-900/15 dark:text-green-300 dark:hover:bg-green-900/25'
                    : permissionMode === 'auto'
                      ? 'border-blue-300/60 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-600/40 dark:bg-blue-900/15 dark:text-blue-300 dark:hover:bg-blue-900/25'
                      : permissionMode === 'bypassPermissions'
                        ? 'border-orange-300/60 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-600/40 dark:bg-orange-900/15 dark:text-orange-300 dark:hover:bg-orange-900/25'
                        : 'border-primary/20 bg-primary/5 text-primary hover:bg-primary/10'
              }`}
              title={t('input.clickToChangeMode')}
            >
              <div className="flex items-center gap-1.5">
                <div
                  className={`h-2.5 w-2.5 rounded-full sm:h-1.5 sm:w-1.5 ${
                    permissionMode === 'default'
                      ? 'bg-muted-foreground'
                      : permissionMode === 'acceptEdits'
                        ? 'bg-green-500'
                        : permissionMode === 'auto'
                          ? 'bg-blue-500'
                          : permissionMode === 'bypassPermissions'
                            ? 'bg-orange-500'
                            : 'bg-primary'
                  }`}
                />
                <span className="hidden whitespace-nowrap sm:inline">
                  {permissionMode === 'default' && t('codex.modes.default')}
                  {permissionMode === 'acceptEdits' && t('codex.modes.acceptEdits')}
                  {permissionMode === 'auto' && t('codex.modes.auto')}
                  {permissionMode === 'bypassPermissions' && t('codex.modes.bypassPermissions')}
                  {permissionMode === 'plan' && t('codex.modes.plan')}
                </span>
              </div>
            </button>

            {availableEffortOptions.length > 0 && !isToolbarCollapsed && (
              <div ref={effortDropdownRef} className="relative">
                <button
                  ref={effortDropdownButtonRef}
                  type="button"
                  onClick={() => {
                    updateEffortDropdownPosition();
                    setIsEffortDropdownOpen((current) => !current);
                  }}
                  className="flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-all duration-200 hover:bg-muted"
                  aria-haspopup="menu"
                  aria-expanded={isEffortDropdownOpen}
                  aria-label="Select reasoning effort"
                  title="Select reasoning effort"
                >
                  <span className="hidden text-[11px] text-muted-foreground sm:inline">Effort</span>
                  <span className="max-w-16 truncate capitalize sm:max-w-20">{selectedEffortLabel}</span>
                  <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${isEffortDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                {isEffortDropdownOpen && effortDropdownPosition && createPortal(
                  <div
                    ref={effortDropdownMenuRef}
                    className="fixed z-[100] min-w-36 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg"
                    style={{
                      left: effortDropdownPosition.left,
                      top: effortDropdownPosition.top,
                      maxHeight: effortDropdownPosition.maxHeight,
                      transform: 'translateY(-100%)',
                    }}
                    role="menu"
                  >
                    {effortOptions.map((option) => {
                      const isSelected = option.value === effort;
                      const label = option.value === 'default' ? 'Default' : option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          onClick={() => {
                            onSelectEffort(option.value);
                            setIsEffortDropdownOpen(false);
                          }}
                          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs capitalize transition-colors ${
                            isSelected
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
                          }`}
                        >
                          <span className="flex h-3 w-3 items-center justify-center">
                            {isSelected && <Check className="h-3 w-3 text-primary" />}
                          </span>
                          <span>{label}</span>
                        </button>
                      );
                    })}
                  </div>,
                  document.body,
                )}
              </div>
            )}

            {!isToolbarCollapsed && (
              <TokenUsageSummary usage={tokenBudget} contextUsage={contextUsage} onClick={onShowTokenUsage} />
            )}

            <BackgroundTasksIndicator tasks={backgroundTasks} runningCount={backgroundRunningCount} />
            <SubagentsIndicator subagents={subagents} runningCount={subagentRunningCount} sessionId={sessionId} />

            {!isToolbarCollapsed && (
            <PromptInputButton
              tooltip={{ content: t('input.showAllCommands') }}
              onClick={onToggleCommandMenu}
              className="relative"
            >
              <MessageSquareIcon />
              {slashCommandsCount > 0 && (
                <span
                  className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
                >
                  {slashCommandsCount}
                </span>
              )}
            </PromptInputButton>
            )}

            {hasInput && !isToolbarCollapsed && (
              <PromptInputButton
                tooltip={{ content: t('input.clearInput', { defaultValue: 'Clear input' }) }}
                onClick={onClearInput}
              >
                <XIcon />
              </PromptInputButton>
            )}

            {/* Secondary controls collapse into this "…" menu whenever the row
                would otherwise overflow — on a phone, on a tablet, and on a
                wide desktop whose chat pane is narrowed by the file pane.
                Attach, mode and the live indicators stay inline: they are the
                status you watch while a run is going. */}
            {isToolbarCollapsed && (
            <div className="relative">
              <PromptInputButton
                ref={overflowButtonRef}
                tooltip={{ content: t('input.moreOptions', { defaultValue: 'More options' }) }}
                onClick={() => setIsOverflowOpen((current) => !current)}
                aria-haspopup="menu"
                aria-expanded={isOverflowOpen}
              >
                <MoreHorizontalIcon />
              </PromptInputButton>

              <AnchoredPopover
                anchorRef={overflowButtonRef}
                open={isOverflowOpen}
                onClose={() => setIsOverflowOpen(false)}
                align="left"
                className="w-56 max-w-[85vw] overflow-hidden rounded-xl border border-border bg-card p-1 shadow-lg"
              >
                {availableEffortOptions.length > 0 && (
                  <>
                    <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
                      {t('input.effort', { defaultValue: 'Reasoning effort' })}
                    </div>
                    {effortOptions.map((option) => {
                      const isSelected = option.value === effort;
                      const label = option.value === 'default' ? 'Default' : option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          onClick={() => {
                            onSelectEffort(option.value);
                            setIsOverflowOpen(false);
                          }}
                          className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm capitalize transition-colors ${
                            isSelected
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground'
                          }`}
                        >
                          <span className="flex h-3.5 w-3.5 items-center justify-center">
                            {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
                          </span>
                          <span>{label}</span>
                        </button>
                      );
                    })}
                    <div className="my-1 border-t border-border/50" />
                  </>
                )}

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onShowTokenUsage();
                    setIsOverflowOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent/70"
                >
                  <ActivityIcon className="h-4 w-4 text-primary" />
                  <span className="flex-1">{t('input.tokenUsage', { defaultValue: 'Token usage' })}</span>
                  <span className="text-xs text-muted-foreground">
                    {(() => {
                      // Mobile has no room for the bar, so the percentage is
                      // the whole reading here.
                      const gauge = resolveContextGauge(tokenBudget, contextUsage);
                      return gauge
                        ? `${formatTokenCount(gauge.used)} · ${Math.round(gauge.percentage)}%`
                        : formatTokenCount(readUsedTokens(tokenBudget));
                    })()}
                  </span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onToggleCommandMenu();
                    setIsOverflowOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent/70"
                >
                  <MessageSquareIcon className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1">{t('input.showAllCommands')}</span>
                  {slashCommandsCount > 0 && (
                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                      {slashCommandsCount}
                    </span>
                  )}
                </button>

                {hasInput && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onClearInput();
                      setIsOverflowOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent/70"
                  >
                    <XIcon className="h-4 w-4 text-muted-foreground" />
                    <span>{t('input.clearInput', { defaultValue: 'Clear input' })}</span>
                  </button>
                )}
              </AnchoredPopover>
            </div>
            )}

          </PromptInputTools>

          {/* Three flat siblings — toolbar, hint, actions — deliberately not
              nested. Wrapping the hint and the actions in one group made that
              group's min-content (the hint's full nowrap text) the floor for
              the whole right side, which starved the toolbar even when there
              was plenty of room. As siblings each carries its own priority:
              the hint grows into leftover space only (`basis-0`) and truncates
              to nothing, the toolbar takes its natural width and clips only as
              a last resort, and the actions never shrink at all. */}
          <div
            className={`hidden min-w-0 flex-1 basis-0 truncate whitespace-nowrap text-right text-xs text-muted-foreground/50 transition-opacity duration-200 lg:block ${
              input.trim() && !canQueueDraft ? 'opacity-0' : 'opacity-100'
            }`}
            title={submitHint}
          >
            {submitHint}
          </div>

          {/* The width the toolbar must not collide with — measured, so the
              overflow check stays correct as the mic comes and goes. */}
          <div ref={footerActionsRef} className="flex shrink-0 items-center gap-2">
            {onVoiceTranscript && voiceAvailable && (
              <VoiceInputButton
                state={voiceState}
                onToggle={voiceToggle}
                errorMsg={voiceError}
                className="h-10 w-10 shrink-0 rounded-lg border border-border/60 bg-muted/40 hover:bg-muted [&_svg]:size-5"
              />
            )}
            <PromptInputSubmit
              onClick={
                canQueueDraft
                  ? (e: MouseEvent<HTMLButtonElement>) => {
                      e.preventDefault();
                      onSubmit(e);
                    }
                  : isLoading
                    ? onAbortSession
                    : isRecording
                      ? (e: MouseEvent<HTMLButtonElement>) => {
                          e.preventDefault();
                          voiceStop({ send: true });
                        }
                      : undefined
              }
              disabled={isLoading ? false : isRecording ? false : isTranscribing ? true : !input.trim()}
              aria-label={submitAriaLabel}
              title={submitAriaLabel}
              className="h-10 w-10 sm:h-10 sm:w-10"
            >
              {isTranscribing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : canQueueDraft ? (
                <ArrowUpIcon className="h-4 w-4" />
              ) : undefined}
            </PromptInputSubmit>
          </div>
        </PromptInputFooter>
      </PromptInput>
      </div>}
    </div>
  );
}
