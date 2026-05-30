import { Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { ProjectSession } from '../../../../types/app';
import type { ActivitySessionItem } from '../../types/types';
import { getSessionName, getSessionTime } from '../../utils/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

export type SidebarActivityListProps = {
  items: ActivitySessionItem[];
  selectedSession: ProjectSession | null;
  currentTime: Date;
  onSelectSession: (item: ActivitySessionItem) => void;
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

        return (
          <button
            key={`${project.projectId}-${session.__provider}-${session.id}`}
            className={cn(
              'group relative flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50',
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
        );
      })}
    </div>
  );
}
