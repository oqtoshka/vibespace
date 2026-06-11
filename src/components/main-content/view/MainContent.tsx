import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import ChatInterface from '../../chat/view/ChatInterface';
import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import GitPanel from '../../git-panel/view/GitPanel';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import { BrowserUsePanel } from '../../browser-use';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { usePaletteOpsRegister } from '../../../contexts/PaletteOpsContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useFileOpenResolver } from '../../../hooks/useFileOpenResolver';
import { authenticatedFetch } from '../../../utils/api';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import CodeEditor from '../../code-editor/view/CodeEditor';
import type { CodeEditorDiffInfo } from '../../code-editor/types/types';
import type { ShellController } from '../../shell/view/Shell';
import type { Project, ProjectSession } from '../../../types/app';
import { TaskMasterPanel } from '../../task-master';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

function MainContent({
  selectedProject,
  selectedSession,
  workspace,
  filesSidebarActive,
  onShowFilesSidebar,
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
  onSessionEstablished,
  onShowSettings,
  externalMessageUpdate,
  newSessionTrigger,
}: MainContentProps) {
  const { preferences } = useUiPreferences();
  const { showRawParameters, showThinking, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;
  const [browserUseEnabled, setBrowserUseEnabled] = useState(false);

  const shouldShowTasksTab = Boolean(tasksEnabled && isTaskMasterInstalled);
  const shouldShowBrowserTab = browserUseEnabled;

  const { activeTab, activePanel, activeId } = workspace;

  // Imperative shell controllers so closing a shell tab can kill its PTY
  // before the Shell component unmounts.
  const shellControllersRef = useRef(new Map<string, ShellController>());

  // Tabs the user has visited this app run. Hidden shell tabs restored from
  // localStorage don't auto-connect until first activated (avoids a WS/PTY
  // reattach storm on reload); mutated during render so the activating tab
  // connects on the same pass.
  const activatedTabIdsRef = useRef(new Set<string>());
  if (activeId) {
    activatedTabIdsRef.current.add(activeId);
  }

  const handleFileOpen = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null) => {
      workspace.openFileTab(filePath, undefined, diffInfo);
    },
    [workspace],
  );

  const handleCloseTab = useCallback(
    (id: string) => {
      const tab = workspace.tabs.find((candidate) => candidate.id === id);
      if (tab?.kind === 'shell') {
        shellControllersRef.current.get(id)?.kill();
      }
      workspace.closeTab(id);
    },
    [workspace],
  );

  const handleNewShell = useCallback(() => {
    workspace.openShellTab({
      sessionId: selectedSession?.id ?? null,
      provider: selectedSession?.__provider,
    });
  }, [selectedSession?.__provider, selectedSession?.id, workspace]);

  // Synthetic per-tab sessions: each shell tab is pinned to the session it
  // was opened with (immutable), so useShellRuntime's session-change
  // disconnect never fires for a given tab.
  const shellTabSessions = useMemo(() => {
    const sessions = new Map<string, ProjectSession | null>();
    for (const tab of workspace.tabs) {
      if (tab.kind !== 'shell') {
        continue;
      }
      sessions.set(
        tab.id,
        tab.sessionId
          ? { id: tab.sessionId, __provider: tab.provider, summary: tab.title ?? '' }
          : null,
      );
    }
    return sessions;
  }, [workspace.tabs]);

  // Resolves bare/partial file references (e.g. links inside chat messages) to
  // real project files before opening them in the in-app editor.
  const resolvedFileOpen = useFileOpenResolver(selectedProject, handleFileOpen);

  useEffect(() => {
    // Identify projects by DB `projectId`; the TaskMaster context uses the
    // same identifier to key its internal maps.
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

  const loadBrowserUseSettings = useCallback(async () => {
    try {
      const response = await authenticatedFetch('/api/browser-use/settings');
      const data = await response.json();
      setBrowserUseEnabled(Boolean(response.ok && data?.success !== false && data?.data?.settings?.enabled));
    } catch {
      setBrowserUseEnabled(false);
    }
  }, []);

  useEffect(() => {
    void loadBrowserUseSettings();
    window.addEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
    return () => window.removeEventListener('browserUseSettingsChanged', loadBrowserUseSettings);
  }, [loadBrowserUseSettings]);

  useEffect(() => {
    if (!shouldShowBrowserTab && activeTab === 'browser') {
      setActiveTab('chat');
    }
  }, [shouldShowBrowserTab, activeTab, setActiveTab]);

  usePaletteOpsRegister({
    openFile: handleFileOpen,
    // Opens files from the palette in a workspace file tab, same as openFile.
    openFileInEditor: (filePath: string) => {
      resolvedFileOpen(filePath);
    },
  });

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        workspace={workspace}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        shouldShowBrowserTab={shouldShowBrowserTab}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onCloseTab={handleCloseTab}
        onNewShell={handleNewShell}
        filesSidebarActive={filesSidebarActive}
        onShowFilesSidebar={onShowFilesSidebar}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-[200px] flex-1 flex-col overflow-hidden">
          {/* Single chat surface: every chat tab points into this instance,
              driven by selectedSession. Kept mounted so chat state survives
              tab switches. */}
          <div className={`h-full ${activeTab?.kind === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                onFileOpen={handleFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionProcessing={onSessionProcessing}
                onSessionIdle={onSessionIdle}
                processingSessions={processingSessions}
                onNavigateToSession={onNavigateToSession}
                onSessionEstablished={onSessionEstablished}
                onShowSettings={onShowSettings}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                newSessionTrigger={newSessionTrigger}
                onShowAllTasks={tasksEnabled ? () => workspace.activateTab('tasks') : null}
              />
            </ErrorBoundary>
          </div>

          {/* All shell tabs stay mounted (live PTYs); only the active one is
              visible. Hidden tabs skip terminal fitting (0×0 guard). */}
          {workspace.tabs.map((tab) => {
            if (tab.kind !== 'shell') {
              return null;
            }
            const isTabActive = activeId === tab.id;
            return (
              <div key={tab.id} className={`h-full w-full overflow-hidden ${isTabActive ? 'block' : 'hidden'}`}>
                <StandaloneShell
                  project={selectedProject}
                  session={shellTabSessions.get(tab.id) ?? null}
                  shellId={tab.shellId}
                  showHeader={false}
                  isActive={isTabActive}
                  autoConnect={activatedTabIdsRef.current.has(tab.id)}
                  onRegisterController={(controller) => {
                    if (controller) {
                      shellControllersRef.current.set(tab.id, controller);
                    } else {
                      shellControllersRef.current.delete(tab.id);
                    }
                  }}
                />
              </div>
            );
          })}

          {/* File tabs: kept-mounted editors so unsaved edits survive tab
              switches (lost on close — accepted for now). */}
          {workspace.tabs.map((tab) => {
            if (tab.kind !== 'file') {
              return null;
            }
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
                  onClose={() => handleCloseTab(tab.id)}
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
      </div>
    </div>
  );
}

export default React.memo(MainContent);
