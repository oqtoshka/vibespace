import { Loader2, Trash2 } from 'lucide-react';
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
            {/* Unread marker — stopped + unread rows are the ones floated to top. */}
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

          {canDelete && (
            <button
              type="button"
              className="touch:opacity-100 absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded opacity-0 transition-opacity hover:bg-red-50 group-hover:opacity-100 dark:hover:bg-red-900/20"
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
        );
      })}
    </div>
  );
}
