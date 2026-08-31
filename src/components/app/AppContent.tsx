import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import CommandPalette from '../command-palette/CommandPalette';
import { QuickSettingsPanel } from '../quick-settings-panel';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { PaletteOpsProvider, usePaletteOpsRegister } from '../../contexts/PaletteOpsContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useUiPreferences } from '../../hooks/useUiPreferences';
import { usePageTitle } from '../../hooks/usePageTitle';
import { useProjectsState } from '../../hooks/useProjectsState';
import { useWorkspaceTabs } from '../../hooks/useWorkspaceTabs';
import { useSessionPane, NEW_SESSION_KEY, type SessionView } from '../../hooks/useSessionPane';
import { dbg } from '../../utils/debugLog';
import type { WorkspaceApi } from '../main-content/types/types';
import type { SidebarView } from '../sidebar/types/types';
import type { AppTab, Project, ProjectSession } from '../../types/app';

const SIDEBAR_VIEW_KEY = 'sidebar-view';

function readPersistedSidebarView(): SidebarView {
  try {
    return localStorage.getItem(SIDEBAR_VIEW_KEY) === 'files' ? 'files' : 'sessions';
  } catch {
    return 'sessions';
  }
}

/**
 * Drag-adjustable width shared by the mobile drawer and the desktop sidebar.
 * Pointer-events based so it works with touch (tablets) and mouse; the width
 * persists per storage key. `width` is null until the user adjusts it (CSS
 * defaults apply).
 */
function useAdjustableWidth(storageKey: string, minWidth: number, maxWidthRatio: number) {
  const [width, setWidth] = useState<number | null>(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      return Number.isFinite(stored) && stored >= minWidth ? stored : null;
    } catch {
      return null;
    }
  });
  const targetRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (width === null) {
      return;
    }
    try {
      localStorage.setItem(storageKey, String(Math.round(width)));
    } catch {
      // Ignore storage errors.
    }
  }, [storageKey, width]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; move events still target the grabber.
    }
    dragRef.current = {
      startX: event.clientX,
      startWidth: targetRef.current?.getBoundingClientRect().width ?? 0,
    };
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      const maxWidth = Math.round(window.innerWidth * maxWidthRatio);
      setWidth(Math.min(maxWidth, Math.max(minWidth, drag.startWidth + (event.clientX - drag.startX))));
    },
    [maxWidthRatio, minWidth],
  );

  const onPointerEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  return { width, targetRef, onPointerDown, onPointerMove, onPointerEnd };
}

type AdjustableWidth = ReturnType<typeof useAdjustableWidth>;

/** Visible capsule handle on the pane's right edge; 40px touch target
 * straddling the border. touch-none so pointermove fires instead of scroll. */
function WidthGrabber({ control }: { control: AdjustableWidth }) {
  return (
    <div
      className="absolute inset-y-0 -right-4 z-30 flex w-10 cursor-col-resize touch-none items-center justify-center"
      onPointerDown={control.onPointerDown}
      onPointerMove={control.onPointerMove}
      onPointerUp={control.onPointerEnd}
      onPointerCancel={control.onPointerEnd}
    >
      <div className="flex h-20 w-5 items-center justify-center rounded-full border border-border/60 bg-background/95 shadow-md">
        <div className="h-10 w-1 rounded-full bg-muted-foreground/70" />
      </div>
    </div>
  );
}

export default function AppContent() {
  return (
    <PaletteOpsProvider>
      <AppContentInner />
    </PaletteOpsProvider>
  );
}

function AppContentInner() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { ws, sendMessage } = useWebSocket();

  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
  } = useSessionProtection();

  // The sidebar and project-state guard consume a plain Set of active session
  // ids; upstream's session-activity hook keys a richer Map. Derive the Set
  // once per change for those consumers (the chat path uses the Map directly).
  const activeSessions = useMemo(() => new Set(processingSessions.keys()), [processingSessions]);

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
    handleProjectSelect,
  } = useProjectsState({
    sessionId,
    navigate,
    isMobile,
    activeSessions,
  });

  const tabs = useWorkspaceTabs({ projectId: selectedProject?.projectId ?? null });
  const sessionPane = useSessionPane(selectedProject?.projectId ?? null);

  usePageTitle({ project: selectedProject, session: selectedSession, t });

  // Trace the upstream selection drivers so the debug log shows what changed
  // before each tab/expand reaction (helps spot project/session ping-pong).
  useEffect(() => {
    dbg('state.selection', {
      project: selectedProject?.projectId ?? null,
      session: selectedSession?.id?.slice(0, 8) ?? null,
      urlSession: sessionId?.slice(0, 8) ?? null,
    });
  }, [selectedProject?.projectId, selectedSession?.id, sessionId]);

  // The main sidebar switches between the sessions list and the project file
  // tree (VSCode-style); the header's files button and the command palette
  // drive it from outside the sidebar.
  const [sidebarView, setSidebarViewState] = useState<SidebarView>(readPersistedSidebarView);
  const setSidebarView = useCallback((next: SidebarView) => {
    setSidebarViewState(next);
    try {
      localStorage.setItem(SIDEBAR_VIEW_KEY, next);
    } catch {
      // Ignore storage errors.
    }
  }, []);

  // Mobile drawer: default 85vw, drag-adjustable up to full width.
  // Desktop/tablet sidebar: default 288px, drag-adjustable up to 60vw.
  const drawer = useAdjustableWidth('mobile-drawer-width', 260, 1);
  const desktopSidebar = useAdjustableWidth('desktop-sidebar-width', 220, 0.6);
  // The collapsed rail sizes itself; only apply widths when expanded.
  const { preferences: uiPreferences } = useUiPreferences();
  const sidebarExpanded = uiPreferences.sidebarVisible;

  const showFilesSidebar = useCallback(() => {
    if (isMobile) {
      // On mobile always open the drawer in files view.
      setSidebarView('files');
      setSidebarOpen(true);
      return;
    }
    // On desktop the button toggles between the two views.
    setSidebarView(sidebarView === 'files' ? 'sessions' : 'files');
  }, [isMobile, setSidebarOpen, setSidebarView, sidebarView]);
  // At mobile/tablet widths the main area shows one pane at a time and the
  // sidebar is a drawer. Keep the two in step: picking Files should leave the
  // drawer on the file tree, picking Session on the session list, so opening
  // the drawer never lands on the list belonging to the pane you just left.
  const handleMobilePaneChange = useCallback(
    (pane: 'session' | 'files') => {
      setSidebarView(pane === 'files' ? 'files' : 'sessions');
    },
    [setSidebarView],
  );

  const {
    tabs: workspaceTabs,
    activeId,
    activeTab,
    activePanel,
    openFileTab,
    setActive,
    closeTab,
    closePanel,
  } = tabs;

  // Current session's chat/terminal view (remembered per session).
  const currentSessionKey = selectedSession?.id ?? NEW_SESSION_KEY;
  const sessionView = sessionPane.getView(currentSessionKey);
  const onSessionViewChange = useCallback(
    (view: SessionView) => sessionPane.setView(currentSessionKey, view),
    [sessionPane, currentSessionKey],
  );

  usePaletteOpsRegister({
    openSettings,
    refreshProjects: refreshProjectsSilently,
  });

  /** Sidebar session click: select + navigate, and reveal the session pane. */
  const handleSidebarSessionSelect = useCallback(
    (session: ProjectSession) => {
      handleSessionSelect(session);
      sessionPane.setOpen(true);
    },
    [handleSessionSelect, sessionPane],
  );

  /** New-session actions (sidebar/palette): reset chat + reveal session pane. */
  const startNewChat = useCallback(
    (project: Project) => {
      handleNewSession(project);
      sessionPane.setView(NEW_SESSION_KEY, 'chat');
      sessionPane.setOpen(true);
    },
    [handleNewSession, sessionPane],
  );

  /** Command palette navigation mapped onto the new session-pane / tab model. */
  const handleShowTab = useCallback(
    (tab: AppTab) => {
      if (tab === 'chat') {
        sessionPane.setView(currentSessionKey, 'chat');
        sessionPane.setOpen(true);
        return;
      }
      if (tab === 'shell') {
        sessionPane.setView(currentSessionKey, 'terminal');
        sessionPane.setOpen(true);
        return;
      }
      if (tab === 'files') {
        showFilesSidebar();
        return;
      }
      setActive(tab);
    },
    [sessionPane, currentSessionKey, setActive, showFilesSidebar],
  );

  const workspace: WorkspaceApi = useMemo(
    () => ({
      tabs: workspaceTabs,
      activeId,
      activeTab,
      activePanel,
      activateTab: setActive,
      closeTab,
      closePanel,
      openFileTab,
    }),
    [activeId, activePanel, activeTab, closePanel, closeTab, openFileTab, setActive, workspaceTabs],
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
      sessionPane.setOpen(true);

      if (typeof message.sessionId === 'string' && message.sessionId) {
        // Reveal the notified session in the session pane.
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setSidebarOpen, sessionPane]);

  // Permission recovery is handled by upstream's chat.subscribe flow: the
  // `chat_subscribed` ack carries pending approvals on session open and on
  // reconnect, so no separate request is needed here.

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
    onSessionDelete: handleSessionDelete,
    view: sidebarView,
    onViewChange: setSidebarView,
    onFileOpen: (filePath: string) => {
      openFileTab(filePath);
      // The drawer covers the content on mobile — reveal the opened tab.
      if (isMobile) {
        setSidebarOpen(false);
      }
    },
  };

  return (
    <div className="fixed inset-0 flex bg-background" style={{ bottom: 'var(--keyboard-height, 0px)' }}>
      {!isMobile ? (
        <div
          ref={desktopSidebar.targetRef}
          className={`relative h-full flex-shrink-0 border-r border-border/50 ${sidebarExpanded ? 'w-72' : ''}`}
          style={sidebarExpanded && desktopSidebar.width !== null
            ? { width: `${Math.min(desktopSidebar.width, window.innerWidth * 0.6)}px` }
            : undefined}
        >
          <Sidebar {...sidebarProps} />
          {sidebarExpanded && <WidthGrabber control={desktopSidebar} />}
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
            ref={drawer.targetRef}
            className={`relative h-full w-[85vw] transform border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            style={drawer.width !== null ? { width: `${Math.min(drawer.width, window.innerWidth)}px` } : undefined}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar {...sidebarProps} />
            <WidthGrabber control={drawer} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <MainContent
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          workspace={workspace}
          ws={ws}
          sendMessage={sendMessage}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionProcessing={markSessionProcessing}
          onSessionIdle={markSessionIdle}
          processingSessions={processingSessions}
          onNavigateToSession={(targetSessionId: string, options) =>
            navigate(`/session/${targetSessionId}`, { replace: Boolean(options?.replace) })
          }
          onShowSettings={() => setShowSettings(true)}
          externalMessageUpdate={externalMessageUpdate}
          newSessionTrigger={newSessionTrigger}
          sessionView={sessionView}
          onSessionViewChange={onSessionViewChange}
          sessionPaneOpen={sessionPane.isOpen}
          onOpenSessionPane={() => sessionPane.setOpen(true)}
          onCloseSessionPane={() => sessionPane.setOpen(false)}
          sessionPaneWidth={sessionPane.width}
          onSessionPaneWidthChange={sessionPane.setWidth}
          onMobilePaneChange={handleMobilePaneChange}
          onProjectSelect={handleProjectSelect}
          onProjectsRefresh={() => void refreshProjectsSilently()}
        />
      </div>

      <CommandPalette
        selectedProject={selectedProject}
        onStartNewChat={startNewChat}
        onOpenSettings={() => openSettings()}
        onShowTab={handleShowTab}
      />

      <QuickSettingsPanel />
    </div>
  );
}
