import { Check, Edit2, Loader2, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { ProjectSession, LLMProvider } from '../../../../types/app';
import type { ActivitySessionItem } from '../../types/types';
import { getSessionName, getSessionTime } from '../../utils/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

export type SidebarActivityListProps = {
  items: ActivitySessionItem[];
  selectedSession: ProjectSession | null;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectId: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onSelectSession: (item: ActivitySessionItem) => void;
  onDeleteSession: (
    projectId: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  t: TFunction;
};

/**
 * Compact relative age for activity rows: <1m, Xm, Xhr, Xd.
 */
const formatCompactAge = (dateString: string, currentTime: Date): string => {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const diffInMinutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / (1000 * 60));
  if (diffInMinutes < 1) {
    return '<1m';
  }
  if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours}hr`;
  }

  return `${Math.floor(diffInHours / 24)}d`;
};

export default function SidebarActivityList({
  items,
  selectedSession,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onSelectSession,
  onDeleteSession,
  t,
}: SidebarActivityListProps) {
  if (items.length === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <p className="text-sm text-muted-foreground">
          {t('activity.empty', 'No sessions yet')}
        </p>
      </div>
    );
  }

  return (
    <div className="pb-safe-area-inset-bottom md:space-y-0.5">
      {items.map(({ session, project, isUnread, isRunning }) => {
        const isSelected = selectedSession?.id === session.id;
        const sessionName = getSessionName(session, t);
        const compactAge = formatCompactAge(getSessionTime(session), currentTime);

        const canDelete = session.__provider !== 'cursor';
        const isEditing = editingSession === session.id;
        const saveEditedSession = () =>
          onSaveEditingSession(project.projectId, session.id, editingSessionName, session.__provider);

        if (isEditing) {
          return (
            <div
              key={`${project.projectId}-${session.__provider}-${session.id}`}
              className="flex items-center gap-2 rounded-md px-2 py-2"
            >
              <SessionProviderLogo provider={session.__provider} className="h-3.5 w-3.5 flex-shrink-0" />
              <input
                type="text"
                value={editingSessionName}
                onChange={(event) => onEditingSessionNameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    saveEditedSession();
                  } else if (event.key === 'Escape') {
                    onCancelEditingSession();
                  }
                }}
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                style={{ fontSize: '16px' }}
                autoFocus
              />
              <button
                type="button"
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
                onClick={saveEditedSession}
                title={t('tooltips.save')}
              >
                <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
              </button>
              <button
                type="button"
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                onClick={onCancelEditingSession}
                title={t('tooltips.cancel')}
              >
                <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
              </button>
            </div>
          );
        }

        return (
          <div
            key={`${project.projectId}-${session.__provider}-${session.id}`}
            className="group relative"
          >
          <button
            className={cn(
              'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50',
              isSelected && 'bg-accent text-accent-foreground',
            )}
            onClick={() => onSelectSession({ session, project, isUnread, isRunning })}
          >
            {/* Unread marker. Ordering is strictly by recency — this dot is the
                only thing that distinguishes an unread row, it does not move it. */}
            <span className="mt-1.5 flex h-2 w-2 flex-shrink-0 items-center justify-center">
              {isUnread && !isRunning && (
                <span className="h-2 w-2 rounded-full bg-primary" aria-label={t('activity.unread', 'Unread')} />
              )}
            </span>

            <SessionProviderLogo provider={session.__provider} className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'truncate text-xs text-foreground',
                    isUnread && !isRunning ? 'font-semibold' : 'font-medium',
                  )}
                >
                  {sessionName}
                </span>
                {isRunning ? (
                  <Loader2 className="ml-auto h-3 w-3 flex-shrink-0 animate-spin text-green-500" />
                ) : (
                  compactAge && (
                    <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">{compactAge}</span>
                  )
                )}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground/70" title={project.fullPath}>
                {project.displayName || project.projectId}
              </div>
            </div>
          </button>

          <div className="touch:opacity-100 absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded hover:bg-accent"
              onClick={(event) => {
                event.stopPropagation();
                onStartEditingSession(session.id, sessionName);
              }}
              title={t('tooltips.editSessionName')}
              aria-label={t('tooltips.editSessionName')}
            >
              <Edit2 className="h-3 w-3 text-gray-600 dark:text-gray-400" />
            </button>
            {canDelete && (
              <button
                type="button"
                className="flex h-6 w-6 items-center justify-center rounded hover:bg-red-50 dark:hover:bg-red-900/20"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteSession(project.projectId, session.id, sessionName, session.__provider);
                }}
                title={t('tooltips.deleteSessionOptions', 'Archive or permanently delete this session')}
                aria-label={t('tooltips.deleteSessionOptions', 'Archive or permanently delete this session')}
              >
                <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
              </button>
            )}
          </div>
          </div>
        );
      })}
    </div>
  );
}
