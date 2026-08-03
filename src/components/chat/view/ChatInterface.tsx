import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon, TreePine } from 'lucide-react';

import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useActiveWorktree } from '../../../hooks/useActiveWorktree';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import PermissionContext from '../../../contexts/PermissionContext';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import type { ChatInterfaceProps, Provider  } from '../types/types';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useBackgroundTasks } from '../hooks/useBackgroundTasks';
import { useBtwSession } from '../hooks/useBtwSession';
import { useSubagents } from '../hooks/useSubagents';
import { useSessionActiveModel } from '../hooks/useSessionActiveModel';
import { BackgroundTasksProvider } from '../context/BackgroundTasksContext';
import { useSessionStore } from '../../../stores/useSessionStore';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import CommandResultModal from './subcomponents/CommandResultModal';
import BtwPanel from './subcomponents/BtwPanel';

function ChatInterface({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  // Streamed text per session id — several sessions can stream into this one
  // socket at a time (a background run, or a `/btw` side session).
  const accumulatedStreamRef = useRef(new Map<string, string>());
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current.clear();
  }, []);

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    opencodeModel,
    setOpenCodeModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    hardRefreshProviderModels,
    selectProviderModel,
    setStoredProviderEffort,
    resolvePermissionModeForProvider,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    historyLoadFailed,
    historyTranscriptMissing,
    retryLoadMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    isFarFromBottom,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    contextUsage,
    setContextUsage,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const { activeWorktree } = useActiveWorktree(selectedProject?.projectId ?? null);

  // `/btw` — a quick question answered in its own side session, so the turn
  // running in this conversation is neither interrupted nor queued behind.
  // It follows the visible session's working directory so answers are about
  // the tree the user is actually looking at.
  const [isBtwOpen, setIsBtwOpen] = useState(false);
  const btwCwd =
    (selectedSession?.worktreePath as string | null | undefined)
    || activeWorktree?.path
    || selectedProject?.fullPath
    || selectedProject?.path
    || '';
  // The provider's picker default — what a *new* conversation starts on.
  const providerDefaultModel = provider === 'cursor'
    ? cursorModel
    : provider === 'codex'
      ? codexModel
      : provider === 'opencode'
        ? opencodeModel
        : claudeModel;
  // The model the next turn will actually run on — shown in the composer
  // toolbar and used for /btw side questions. An existing session can be
  // pinned to something other than the picker default, and the server owns
  // that override, so the default is only a fallback here.
  const { activeModel: activeProviderModel, refresh: refreshActiveProviderModel } = useSessionActiveModel({
    provider,
    sessionId: currentSessionId || selectedSession?.id || null,
    fallbackModel: providerDefaultModel,
    isProcessing,
  });

  // Picking a model for a live session writes a server-side override rather
  // than touching the picker default, so the readout has to be re-read.
  const handleSelectProviderModel = useCallback<typeof selectProviderModel>(
    async (targetProvider, model, sessionId) => {
      const result = await selectProviderModel(targetProvider, model, sessionId);
      refreshActiveProviderModel();
      return result;
    },
    [selectProviderModel, refreshActiveProviderModel],
  );
  const btw = useBtwSession({
    selectedProject,
    provider,
    model: activeProviderModel,
    cwd: btwCwd,
  });
  const { ask: askBtw } = btw;

  const handleBtwCommand = useCallback(
    (question: string) => {
      setIsBtwOpen(true);
      // `/btw` with no question just opens the panel to type in.
      if (question.trim()) {
        void askBtw(question);
      }
    },
    [askBtw],
  );

  const handleBtwBranchOut = useCallback(async () => {
    const promotedSessionId = await btw.promote();
    if (!promotedSessionId) return;
    setIsBtwOpen(false);
    onNavigateToSession?.(promotedSessionId);
  }, [btw, onNavigateToSession]);

  const {
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
    filteredFiles,
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
    openImagePicker,
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
    showModelsModal,
    rewindMessage,
    queuedMessages,
    removeQueuedMessage,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    cursorModel,
    claudeModel,
    codexModel,
    effort: currentProviderEffort,
    opencodeModel,
    isLoading: isProcessing,
    canAbortSession,
    tokenBudget,
    contextUsage,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    onBtwCommand: handleBtwCommand,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    onRewindTruncate: (sessionId, messageUuid) => sessionStore.rewindTo(sessionId, messageUuid),
  });

  // On WebSocket reconnect, re-fetch the current session's messages from the
  // server so missed streaming events are shown, then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await sessionStore.refreshFromServer(selectedSession.id);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [selectedProject, selectedSession, sendMessage, sessionStore]);

  useChatRealtimeHandlers({
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    setContextUsage,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    sessionStore,
  });

  // Self-healing for stuck "Processing": a backgrounded/sleeping tab can miss
  // the terminal `complete` event, leaving the activity indicator hung. When
  // the tab becomes visible/focused again and we still believe a run is live,
  // re-subscribe — the `chat_subscribed` ack reports the true processing state
  // (clearing a stale indicator) and replays any events missed while hidden.
  useEffect(() => {
    if (!selectedSession || !isProcessing) {
      return undefined;
    }
    const recover = () => {
      if (document.visibilityState === 'visible') {
        void handleWebSocketReconnect();
      }
    };
    document.addEventListener('visibilitychange', recover);
    window.addEventListener('focus', recover);
    return () => {
      document.removeEventListener('visibilitychange', recover);
      window.removeEventListener('focus', recover);
    };
  }, [selectedSession, isProcessing, handleWebSocketReconnect]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
    permissionMode,
    setPermissionMode,
  }), [pendingPermissionRequests, handlePermissionDecision, permissionMode, setPermissionMode]);

  const { tasks: backgroundTasks, runningCount: backgroundRunningCount } = useBackgroundTasks(
    chatMessages,
    isProcessing,
    selectedSession?.id ?? null,
  );

  const { subagents, runningCount: subagentRunningCount } = useSubagents(chatMessages);

  const cancelBackgroundTask = useCallback(
    (taskId: string) => {
      const targetSessionId = selectedSession?.id;
      if (!targetSessionId || !taskId) return;
      sendMessage({ type: 'chat.stop-task', sessionId: targetSessionId, taskId });
    },
    [selectedSession?.id, sendMessage],
  );

  const backgroundTasksContextValue = useMemo(
    () => ({
      tasksById: new Map(backgroundTasks.map((task) => [task.id, task])),
      cancelTask: cancelBackgroundTask,
      // Only Claude's SDK exposes a task-level stop.
      canCancel: provider === 'claude',
    }),
    [backgroundTasks, cancelBackgroundTask, provider],
  );

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  if (!selectedProject) {
    const selectedProviderLabel =
      provider === 'cursor'
        ? t('messageTypes.cursor')
        : provider === 'codex'
          ? t('messageTypes.codex')
          : provider === 'opencode'
              ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
            : t('messageTypes.claude');

    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  // Worktree indicator: an existing session shows its pinned worktree; a pending
  // (new) session shows the project's active worktree it will run in.
  const sessionWorktreeBranch = (selectedSession?.worktreeBranch as string | null | undefined) ?? null;
  const worktreeLabel = selectedSession
    ? sessionWorktreeBranch
    : activeWorktree?.branch ?? (activeWorktree ? activeWorktree.path.split('/').pop() ?? null : null);

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <BackgroundTasksProvider value={backgroundTasksContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        {worktreeLabel && (
          <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-amber-500/20 bg-amber-500/5 px-3 py-1 text-xs text-amber-700 dark:text-amber-400">
            <TreePine className="h-3 w-3 flex-shrink-0" />
            <span className="text-amber-700/70 dark:text-amber-400/70">worktree</span>
            <span className="truncate font-medium">{worktreeLabel}</span>
          </div>
        )}
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isProcessing={isProcessing}
          historyLoadFailed={historyLoadFailed}
          historyTranscriptMissing={historyTranscriptMissing}
          onRetryLoadHistory={retryLoadMessages}
          hasActivityIndicator={hasActivityIndicator}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          providerModelCatalog={providerModelCatalog}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          onRewindMessage={rewindMessage}
          rewindDisabled={isProcessing}
        />

        <div className="relative flex-shrink-0">
          {isFarFromBottom && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          onModeSwitch={cyclePermissionMode}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={(nextEffort) => setStoredProviderEffort(provider, nextEffort)}
          tokenBudget={tokenBudget}
          contextUsage={contextUsage}
          onShowTokenUsage={showCostModal}
          activeModel={activeProviderModel}
          providerModelOptions={providerModelCatalog[provider]?.OPTIONS ?? []}
          onShowModels={showModelsModal}
          backgroundTasks={backgroundTasks}
          backgroundRunningCount={backgroundRunningCount}
          subagents={subagents}
          subagentRunningCount={subagentRunningCount}
          sessionId={selectedSession?.id ?? null}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          attachedImages={attachedImages}
          onRemoveImage={(index) =>
            setAttachedImages((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openImagePicker={openImagePicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', {
            provider:
              provider === 'cursor'
                ? t('messageTypes.cursor')
                : provider === 'codex'
                  ? t('messageTypes.codex')
                  : provider === 'opencode'
                      ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
                    : t('messageTypes.claude'),
          })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
          queuedMessages={queuedMessages}
          onRemoveQueuedMessage={removeQueuedMessage}
        />
        </div>
      </div>

      <QuickSettingsPanel />

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        onHardRefreshProviderModels={hardRefreshProviderModels}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={handleSelectProviderModel}
      />

      <BtwPanel
        isOpen={isBtwOpen}
        onClose={() => setIsBtwOpen(false)}
        exchanges={btw.exchanges}
        isStreaming={btw.isStreaming}
        canPromote={btw.canPromote}
        isPromoted={btw.isPromoted}
        onAsk={btw.ask}
        onAbort={btw.abort}
        onBranchOut={handleBtwBranchOut}
        projectId={selectedProject?.projectId ?? null}
        projectPath={selectedProject?.fullPath || selectedProject?.path || null}
      />
      </BackgroundTasksProvider>
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
