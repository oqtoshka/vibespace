import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { MessageSquare, FileCode } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import GitPanel from '../../git-panel/view/GitPanel';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import { BrowserUsePanel } from '../../browser-use';
import SessionPane from '../../session-pane/view/SessionPane';
import type { MainContentProps } from '../types/types';
import type { ChatInterfaceProps } from '../../chat/types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { SESSION_PANE_MIN_WIDTH } from '../../../hooks/useSessionPane';
import CodeEditor from '../../code-editor/view/CodeEditor';
import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import type { CodeEditorDiffInfo } from '../../code-editor/types/types';
import type { Project } from '../../../types/app';
import { TaskMasterPanel } from '../../task-master';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

/** Minimum width the files pane keeps when the split is active. */
const FILES_PANE_MIN_WIDTH = 260;

/** Bottom terminal pane height bounds + persistence. */
const TERMINAL_PANE_MIN_HEIGHT = 120;
const TERMINAL_PANE_DEFAULT_HEIGHT = 280;
const TERMINAL_PANE_HEIGHT_KEY = 'terminal-pane-height';

function readStoredTerminalPaneHeight(): number {
  try {
    const stored = Number(window.localStorage.getItem(TERMINAL_PANE_HEIGHT_KEY));
    if (Number.isFinite(stored) && stored >= TERMINAL_PANE_MIN_HEIGHT) {
      return stored;
    }
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return TERMINAL_PANE_DEFAULT_HEIGHT;
}

/** Draggable row resizer above the bottom terminal pane. */
function TerminalPaneDivider({ onHeightChange }: { onHeightChange: (height: number) => void }) {
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const terminalPane = event.currentTarget.nextElementSibling as HTMLElement | null;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Best-effort capture.
    }
    dragRef.current = {
      startY: event.clientY,
      startHeight: terminalPane?.getBoundingClientRect().height ?? TERMINAL_PANE_DEFAULT_HEIGHT,
    };
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const max = Math.max(TERMINAL_PANE_MIN_HEIGHT, window.innerHeight * 0.7);
      const next = Math.min(max, Math.max(TERMINAL_PANE_MIN_HEIGHT, drag.startHeight + (drag.startY - event.clientY)));
      onHeightChange(next);
    },
    [onHeightChange],
  );

  const onPointerEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <div
      className="relative z-10 flex h-1.5 flex-shrink-0 cursor-row-resize touch-none items-center justify-center bg-border/40 hover:bg-accent/60"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div className="h-0.5 w-8 rounded-full bg-muted-foreground/50" />
    </div>
  );
}

/** Draggable column resizer between the session and files panes. */
function PaneDivider({
  containerRef,
  onWidthChange,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onWidthChange: (width: number) => void;
}) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const sessionPane = event.currentTarget.previousElementSibling as HTMLElement | null;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Best-effort capture.
    }
    dragRef.current = {
      startX: event.clientX,
      startWidth: sessionPane?.getBoundingClientRect().width ?? SESSION_PANE_MIN_WIDTH,
    };
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const total = containerRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      const max = Math.max(SESSION_PANE_MIN_WIDTH, total - FILES_PANE_MIN_WIDTH);
      const next = Math.min(max, Math.max(SESSION_PANE_MIN_WIDTH, drag.startWidth + (event.clientX - drag.startX)));
      onWidthChange(next);
    },
    [containerRef, onWidthChange],
  );

  const onPointerEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <div
      className="relative z-10 flex w-1.5 flex-shrink-0 cursor-col-resize touch-none items-center justify-center bg-border/40 hover:bg-accent/60"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div className="h-8 w-0.5 rounded-full bg-muted-foreground/50" />
    </div>
  );
}

function MainContent({
  selectedProject,
  selectedSession,
  workspace,
  ws,
  sendMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
  sessionView,
  onSessionViewChange,
  sessionPaneOpen,
  onOpenSessionPane,
  onCloseSessionPane,
  sessionPaneWidth,
  onSessionPaneWidthChange,
}: MainContentProps) {
  const { t } = useTranslation();
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);

  const { activePanel, activeId } = workspace;

  // Mobile shows one pane at a time, switched from the header.
  const [mobileView, setMobileView] = useState<'session' | 'files'>('session');

  // Bottom terminal pane: a plain interactive shell in the project folder.
  // Once opened it stays mounted (hidden on close) so the PTY survives toggles.
  const [terminalPaneOpen, setTerminalPaneOpen] = useState(false);
  const [terminalPaneMounted, setTerminalPaneMounted] = useState(false);
  const [terminalPaneHeight, setTerminalPaneHeight] = useState(readStoredTerminalPaneHeight);

  const toggleTerminalPane = useCallback(() => {
    setTerminalPaneOpen((previous) => {
      if (!previous) {
        setTerminalPaneMounted(true);
      }
      return !previous;
    });
  }, []);

  const handleTerminalPaneHeightChange = useCallback((height: number) => {
    setTerminalPaneHeight(height);
    try {
      window.localStorage.setItem(TERMINAL_PANE_HEIGHT_KEY, String(Math.round(height)));
    } catch {
      // Storage unavailable — height just won't persist.
    }
  }, []);

  const handleFileOpen = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null) => {
      workspace.openFileTab(filePath, undefined, diffInfo);
      if (isMobile) {
        setMobileView('files');
      }
    },
    [workspace, isMobile],
  );

  useEffect(() => {
    const selectedProjectId = selectedProject?.projectId;
    const currentProjectId = currentProject?.projectId;
    if (selectedProject && selectedProjectId !== currentProjectId) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.projectId, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activePanel === 'tasks') {
      const firstTab = workspace.tabs[0];
      if (firstTab) {
        workspace.activateTab(firstTab.id);
      }
    }
  }, [shouldShowTasksTab, activePanel, workspace]);

  usePaletteOpsRegister({
    openFile: handleFileOpen,
    // In this layout the files pane *is* the editor, so markdown file links
    // (which call the palette's openFileInEditor) open a file tab the same way.
    openFileInEditor: handleFileOpen,
  });

  const containerRef = useRef<HTMLDivElement>(null);

  const chatProps: ChatInterfaceProps | null = useMemo(() => {
    if (!selectedProject) {
      return null;
    }
    return {
      selectedProject,
      selectedSession,
      ws,
      sendMessage,
      onFileOpen: handleFileOpen,
      onInputFocusChange,
      onSessionProcessing,
      onSessionIdle,
      processingSessions,
      onNavigateToSession,
      onShowSettings,
      showRawParameters,
      showThinking,
      sendByCtrlEnter,
      externalMessageUpdate,
      newSessionTrigger,
      onShowAllTasks: tasksEnabled ? () => workspace.activateTab('tasks') : null,
    };
  }, [
    selectedProject, selectedSession, ws, sendMessage, handleFileOpen, onInputFocusChange,
    onSessionProcessing, onSessionIdle, processingSessions, onNavigateToSession, onShowSettings,
    showRawParameters, showThinking, sendByCtrlEnter,
    externalMessageUpdate, newSessionTrigger, tasksEnabled, workspace,
  ]);

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject || !chatProps) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  const rightHasContent = workspace.tabs.length > 0 || activePanel !== null;

  // Pane visibility. Desktop: session pane shown when open; files pane shown
  // when it has content. Mobile: exactly one shown, governed by the switch.
  const sessionVisible = isMobile ? mobileView === 'session' : sessionPaneOpen;
  const filesVisible = isMobile ? mobileView === 'files' : rightHasContent;
  const showDivider = !isMobile && sessionPaneOpen && rightHasContent;

  // Desktop session-pane width: fixed basis only when both panes share the row.
  const sessionStyle =
    !isMobile && sessionPaneOpen && rightHasContent && sessionPaneWidth !== null
      ? { flex: `0 0 ${sessionPaneWidth}px` }
      : undefined;
  const sessionGrow = !sessionStyle; // fill remaining space when alone

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        workspace={workspace}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onCloseTab={workspace.closeTab}
        sessionPaneOpen={sessionPaneOpen}
        onToggleSessionPane={sessionPaneOpen ? onCloseSessionPane : onOpenSessionPane}
        terminalPaneOpen={terminalPaneOpen}
        onToggleTerminalPane={toggleTerminalPane}
      />

      {isMobile && (
        <div className="flex flex-shrink-0 gap-1 border-b border-border/60 bg-card/40 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setMobileView('session')}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium ${
              mobileView === 'session' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {t('sessionPane.session', { defaultValue: 'Session' })}
          </button>
          <button
            type="button"
            onClick={() => setMobileView('files')}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium ${
              mobileView === 'files' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
          >
            <FileCode className="h-3.5 w-3.5" />
            {t('sessionPane.files', { defaultValue: 'Files' })}
          </button>
        </div>
      )}

      <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
        {/* SESSION PANE — kept mounted so chat/terminal state survives toggles. */}
        <div
          className={`min-h-0 min-w-0 ${sessionGrow ? 'flex-1' : ''} ${sessionVisible ? 'flex' : 'hidden'}`}
          style={sessionStyle}
        >
          <SessionPane
            selectedProject={selectedProject}
            selectedSession={selectedSession}
            view={sessionView}
            onViewChange={onSessionViewChange}
            onClose={onCloseSessionPane}
            chatProps={chatProps}
          />
        </div>

        {showDivider && <PaneDivider containerRef={containerRef} onWidthChange={onSessionPaneWidthChange} />}

        {/* FILES PANE — file tabs + singleton panels. */}
        <div className={`min-h-0 min-w-[200px] flex-1 flex-col overflow-hidden ${filesVisible ? 'flex' : 'hidden'}`}>
          {workspace.tabs.map((tab) => {
            const isTabActive = activeId === tab.id;
            return (
              <div key={tab.id} className={`h-full overflow-hidden ${isTabActive ? 'block' : 'hidden'}`}>
                <CodeEditor
                  file={{
                    name: tab.name,
                    path: tab.path,
                    projectId: selectedProject.projectId,
                    diffInfo: tab.diffInfo ?? null,
                  }}
                  onClose={() => workspace.closeTab(tab.id)}
                  projectPath={selectedProject.path}
                  isSidebar
                  onFileOpen={handleFileOpen}
                />
              </div>
            );
          })}

          {activePanel === 'git' && (
            <div className="h-full overflow-hidden">
              <GitPanel selectedProject={selectedProject} isMobile={isMobile} onFileOpen={handleFileOpen} />
            </div>
          )}

          {shouldShowTasksTab && <TaskMasterPanel isVisible={activePanel === 'tasks'} />}

          {activePanel === 'browser' && (
            <div className="h-full overflow-hidden">
              <BrowserUsePanel isVisible onShowSettings={onShowSettings} />
            </div>
          )}

          <div className={`h-full overflow-hidden ${activePanel === 'preview' ? 'block' : 'hidden'}`} />

          {activePanel?.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <PluginTabContent
                pluginName={activePanel.replace('plugin:', '')}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
              />
            </div>
          )}
        </div>

        {/* Both panes hidden (session closed + nothing open): offer a way back. */}
        {!sessionVisible && !filesVisible && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <p className="text-sm">{t('sessionPane.allHidden', { defaultValue: 'Nothing open' })}</p>
            <button
              type="button"
              onClick={onOpenSessionPane}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-foreground/5"
            >
              <MessageSquare className="h-4 w-4" />
              {t('sessionPane.show', { defaultValue: 'Show session' })}
            </button>
          </div>
        )}
      </div>

      {/* BOTTOM TERMINAL PANE — plain interactive shell in the project folder. */}
      {terminalPaneMounted && (
        <>
          {terminalPaneOpen && <TerminalPaneDivider onHeightChange={handleTerminalPaneHeightChange} />}
          <div
            className={`flex-shrink-0 overflow-hidden border-t border-border/60 ${terminalPaneOpen ? '' : 'hidden'}`}
            style={{ height: terminalPaneHeight }}
          >
            <StandaloneShell
              key={selectedProject.projectId}
              project={selectedProject}
              isPlainShell
              isActive={terminalPaneOpen}
              title={t('tabs.terminal', { defaultValue: 'Terminal' })}
              onClose={toggleTerminalPane}
              shellId={`sh_term_${selectedProject.projectId}`}
            />
          </div>
        </>
      )}
    </div>
  );
}

export default React.memo(MainContent);
