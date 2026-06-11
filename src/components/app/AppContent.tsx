import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import CommandPalette from '../command-palette/CommandPalette';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useWorkspaceTabs } from '../../hooks/useWorkspaceTabs';
import { useExplorerPane } from '../main-content/hooks/useExplorerPane';
import type { WorkspaceApi } from '../main-content/types/types';
import type { AppTab, Project, ProjectSession } from '../../types/app';

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function getSessionTitle(session: ProjectSession): string {
  if (session.__provider === 'cursor') {
    return (session.name as string) || 'Untitled Session';
  }
  return (session.summary as string) || 'New Session';
}

function AppContentInner() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage, latestMessage, isConnected } = useWebSocket();
  const wasConnectedRef = useRef(false);

  const {
    activeSessions,
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
  } = useSessionProtection();

  const {
    selectedProject,
    selectedSession,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    newSessionTrigger,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    isMobile,
    activeSessions,
  });

  const tabs = useWorkspaceTabs({ projectId: selectedProject?.projectId ?? null });
  const explorer = useExplorerPane({ isMobile });
  const {
    tabs: workspaceTabs,
    activeId,
    activeTab,
    activePanel,
    openChatTab,
    openShellTab,
    openFileTab,
    setActive,
    closeTab,
    adoptPendingSession,
    findChatTabBySession,
    closeTabsForSession,
  } = tabs;

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  /**
   * Imperative tab activation — the single user-driven path that keeps tab
   * and session selection in sync without reactive ping-pong. Activating a
   * chat tab navigates to its session (URL hydration then sets
   * selectedSession); activating the pending chat tab resets to the
   * new-session state.
   */
  const activateTab = useCallback(
    (id: string) => {
      setActive(id);
      const tab = workspaceTabs.find((candidate) => candidate.id === id);
      if (tab?.kind !== 'chat') {
        return;
      }
      if (tab.sessionId) {
        if (tab.sessionId !== selectedSession?.id) {
          navigate(`/session/${tab.sessionId}`);
        }
        return;
      }
      // Pending "New session" tab: clear the current session.
      if ((selectedSession || sessionId) && selectedProject) {
        handleNewSession(selectedProject);
      }
    },
    [handleNewSession, navigate, selectedProject, selectedSession, sessionId, setActive, workspaceTabs],
  );

  /** Sidebar session click: select + navigate, then open/focus its chat tab. */
  const handleSidebarSessionSelect = useCallback(
    (session: ProjectSession) => {
      handleSessionSelect(session);
      openChatTab(session.id, {
        provider: session.__provider,
        title: getSessionTitle(session),
        activate: true,
      });
    },
    [handleSessionSelect, openChatTab],
  );

  /** New-session actions (sidebar/palette): reset chat + focus a pending tab. */
  const startNewChat = useCallback(
    (project: Project) => {
      handleNewSession(project);
      openChatTab(null, { activate: true });
    },
    [handleNewSession, openChatTab],
  );

  /** Session deletion also closes any tabs pointing at the session. */
  const handleSessionDeleteWithTabs = useCallback(
    (sessionIdToDelete: string) => {
      closeTabsForSession(sessionIdToDelete);
      handleSessionDelete(sessionIdToDelete);
    },
    [closeTabsForSession, handleSessionDelete],
  );

  /**
   * Reactive sync (tab → session) for non-user-driven activations: restored
   * workspaces (reload / project switch) where the active chat tab points at
   * a session that isn't selected yet.
   */
  useEffect(() => {
    if (activeTab?.kind !== 'chat' || !activeTab.sessionId) {
      return;
    }
    if (activeTab.sessionId === selectedSession?.id || activeTab.sessionId === sessionId) {
      return;
    }
    navigate(`/session/${activeTab.sessionId}`);
  }, [activeTab, navigate, selectedSession?.id, sessionId]);

  /**
   * Reactive sync (session → tab): deep links and first-message adoption.
   * When a session becomes selected with no chat tab owning it, either adopt
   * the active pending tab (new-session flow) or open a tab for it.
   */
  useEffect(() => {
    const sid = selectedSession?.id;
    if (!sid) {
      return;
    }
    if (findChatTabBySession(sid)) {
      return;
    }
    const pending = workspaceTabs.find((tab) => tab.kind === 'chat' && tab.sessionId === null);
    if (pending && activeId === pending.id) {
      adoptPendingSession(sid, selectedSession.__provider, getSessionTitle(selectedSession));
      return;
    }
    openChatTab(sid, {
      provider: selectedSession.__provider,
      title: getSessionTitle(selectedSession),
      activate: true,
    });
  }, [activeId, adoptPendingSession, findChatTabBySession, openChatTab, selectedSession, workspaceTabs]);

  /** Command palette tab navigation mapped onto the workspace model. */
  const handleShowTab = useCallback(
    (tab: AppTab) => {
      if (tab === 'chat') {
        openChatTab(selectedSession?.id ?? null, { activate: true });
        return;
      }
      if (tab === 'shell') {
        openShellTab({
          sessionId: selectedSession?.id ?? null,
          provider: selectedSession?.__provider,
        });
        return;
      }
      if (tab === 'files') {
        explorer.toggle();
        return;
      }
      setActive(tab);
    },
    [explorer, openChatTab, openShellTab, selectedSession?.__provider, selectedSession?.id, setActive],
  );

  const workspace: WorkspaceApi = useMemo(
    () => ({
      tabs: workspaceTabs,
      activeId,
      activeTab,
      activePanel,
      activateTab,
      closeTab,
      openShellTab,
      openFileTab,
    }),
    [activateTab, activeId, activePanel, activeTab, closeTab, openFileTab, openShellTab, workspaceTabs],
  );

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        localStorage.setItem('selected-provider', message.provider);
      }

      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        // Focus (or create) the chat tab for the notified session.
        openChatTab(message.sessionId, { activate: true });
        navigate(`/session/${message.sessionId}`);
        return;
      }

      openChatTab(null, { activate: true });
      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, openChatTab, refreshProjectsSilently, setSidebarOpen]);

  // Permission recovery: query pending permissions on WebSocket reconnect or session change
  useEffect(() => {
    const isReconnect = isConnected && !wasConnectedRef.current;

    if (isReconnect) {
      wasConnectedRef.current = true;
    } else if (!isConnected) {
      wasConnectedRef.current = false;
    }

    if (isConnected && selectedSession?.id) {
      sendMessage({
        type: 'get-pending-permissions',
        sessionId: selectedSession.id
      });
    }
  }, [isConnected, selectedSession?.id, sendMessage]);

  // Adjust the app container to stay above the virtual keyboard on iOS Safari.
  // On Chrome for Android the layout viewport already shrinks when the keyboard opens,
  // so inset-0 adjusts automatically. On iOS the layout viewport stays full-height and
  // the keyboard overlays it — we use the Visual Viewport API to track keyboard height
  // and apply it as a CSS variable that shifts the container's bottom edge up.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Only resize matters — keyboard open/close changes vv.height.
      // Do NOT listen to scroll: on iOS Safari, scrolling content changes
      // vv.offsetTop which would make --keyboard-height fluctuate during
      // normal scrolling, causing the container to bounce up and down.
      const kb = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
    };
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  const sidebarProps = {
    ...sidebarSharedProps,
    onSessionSelect: handleSidebarSessionSelect,
    onNewSession: startNewChat,
    onSessionDelete: handleSessionDeleteWithTabs,
    processingSessions,
  };

  return (
    <div className="fixed inset-0 flex bg-background" style={{ bottom: 'var(--keyboard-height, 0px)' }}>
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Sidebar {...sidebarProps} />
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar {...sidebarProps} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <MainContent
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          workspace={workspace}
          explorer={explorer}
          ws={ws}
          sendMessage={sendMessage}
          latestMessage={latestMessage}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionActive={markSessionAsActive}
          onSessionInactive={markSessionAsInactive}
          onSessionProcessing={markSessionAsProcessing}
          onSessionNotProcessing={markSessionAsNotProcessing}
          processingSessions={processingSessions}
          onNavigateToSession={(targetSessionId: string, options) =>
            navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) })
          }
          onShowSettings={() => setShowSettings(true)}
          externalMessageUpdate={externalMessageUpdate}
          newSessionTrigger={newSessionTrigger}
        />
      </div>

      <CommandPalette
        selectedProject={selectedProject}
        onStartNewChat={startNewChat}
        onOpenSettings={() => openSettings()}
        onShowTab={handleShowTab}
      />
    </div>
  );
}
