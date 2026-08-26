import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Terminal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ChatInterface from '../../chat/view/ChatInterface';
import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import ErrorBoundary from '../../main-content/view/ErrorBoundary';
import { Tooltip } from '../../../shared/view/ui';
import type { ChatInterfaceProps } from '../../chat/types/types';
import type { Project, ProjectSession } from '../../../types/app';
import { NEW_SESSION_KEY, type SessionView } from '../../../hooks/useSessionPane';

type SessionPaneProps = {
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  view: SessionView;
  onViewChange: (view: SessionView) => void;
  onClose: () => void;
  /** All props forwarded to the single mounted ChatInterface. */
  chatProps: ChatInterfaceProps;
};

/** Stable per-session shell id so a session's terminal reconnects to the same
 * server PTY across remounts; the pending "new session" shares one per project. */
function shellIdFor(projectId: string, sessionId: string | null): string {
  return sessionId ? `sh_sess_${sessionId}` : `sh_proj_${projectId}`;
}

function sessionKeyOf(session: ProjectSession | null): string {
  return session?.id ?? NEW_SESSION_KEY;
}

type MountedTerminal = {
  key: string;
  shellId: string;
  session: ProjectSession | null;
};

/**
 * The session pane: a per-session chat ⇄ terminal surface, separate from the
 * file tabs. The single ChatInterface instance stays mounted (so streaming
 * state survives view/session switches); terminals are mounted lazily on first
 * switch-to-terminal and kept mounted (within the project) so scrollback and
 * the live PTY survive switching between sessions.
 */
export default function SessionPane({
  selectedProject,
  selectedSession,
  view,
  onViewChange,
  onClose,
  chatProps,
}: SessionPaneProps) {
  const { t } = useTranslation();
  const currentKey = sessionKeyOf(selectedSession);

  // Terminals mounted for the *current* project, keyed by session key. Reset
  // when the project changes (old PTYs tear down with the unmounted Shells).
  const [terminals, setTerminals] = useState<MountedTerminal[]>([]);
  const projectRef = useRef<string>(selectedProject.projectId);
  if (projectRef.current !== selectedProject.projectId) {
    projectRef.current = selectedProject.projectId;
    setTerminals([]);
  }

  // Mount the current session's terminal the first time it's shown.
  useEffect(() => {
    if (view !== 'terminal') {
      return;
    }
    setTerminals((prev) => {
      if (prev.some((entry) => entry.key === currentKey)) {
        return prev;
      }
      return [
        ...prev,
        {
          key: currentKey,
          shellId: shellIdFor(selectedProject.projectId, selectedSession?.id ?? null),
          session: selectedSession,
        },
      ];
    });
  }, [view, currentKey, selectedProject.projectId, selectedSession]);

  // The header has room for the longer form, so prefer the generated recap and
  // fall back to the short label the lists use. A session that has not been
  // summarised yet (brand new, or one turn in) still shows something.
  const sessionTitle =
    (selectedSession?.summary as string) ||
    (selectedSession?.name as string) ||
    t('mainContent.newSession', { defaultValue: 'New session' });
  const sessionRecap = (selectedSession?.recap as string) || '';
  const hasRecap = Boolean(sessionRecap.trim());
  const sessionLabel = sessionRecap || sessionTitle;

  const isChat = view === 'chat';

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      {/* Pane header: chat ⇄ terminal switch + session label + close. */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-card/40 px-2 py-1.5">
        <div className="flex items-center rounded-lg bg-muted/60 p-0.5">
          <button
            type="button"
            onClick={() => onViewChange('chat')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              isChat ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <MessageSquare className="h-3.5 w-3.5" strokeWidth={isChat ? 2.2 : 1.8} />
            {t('tabs.chat', { defaultValue: 'Chat' })}
          </button>
          <button
            type="button"
            onClick={() => onViewChange('terminal')}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              !isChat ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Terminal className="h-3.5 w-3.5" strokeWidth={!isChat ? 2.2 : 1.8} />
            {t('tabs.terminal', { defaultValue: 'Terminal' })}
          </button>
        </div>

        {/* The recap is a sentence or two and the header is one truncated line,
            so the full text needs somewhere to go. A real tooltip rather than
            the native `title`: this pane is used on tablets, where `title`
            never fires, and Tooltip opens on long-press there. */}
        <Tooltip
          content={
            <div className="max-w-xs space-y-1 text-left">
              <div className="font-semibold">{sessionTitle}</div>
              {hasRecap && <div className="font-normal opacity-90">{sessionRecap}</div>}
            </div>
          }
          position="bottom"
          className="whitespace-normal leading-relaxed"
          containerClassName="block min-w-0 flex-1"
        >
          <span className="block truncate text-xs text-muted-foreground">
            {sessionLabel}
          </span>
        </Tooltip>

        <Tooltip content={t('sessionPane.close', { defaultValue: 'Hide session pane' })} position="bottom">
          <button
            type="button"
            onClick={onClose}
            aria-label={t('sessionPane.close', { defaultValue: 'Hide session pane' })}
            className="flex-shrink-0 rounded-md p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Bodies kept mounted; only the active view is visible. */}
      <div className="relative min-h-0 flex-1">
        <div className={`absolute inset-0 ${isChat ? 'block' : 'hidden'}`}>
          <ErrorBoundary showDetails>
            <ChatInterface {...chatProps} isActive={chatProps.isActive && isChat} />
          </ErrorBoundary>
        </div>

        {terminals.map((entry) => {
          const isVisible = !isChat && entry.key === currentKey;
          return (
            <div key={entry.key} className={`absolute inset-0 overflow-hidden ${isVisible ? 'block' : 'hidden'}`}>
              <StandaloneShell
                project={selectedProject}
                session={entry.session}
                shellId={entry.shellId}
                showHeader={false}
                isActive={isVisible}
                autoConnect
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
