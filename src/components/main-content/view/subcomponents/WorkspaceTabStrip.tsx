import {
  FileText,
  MessageSquare,
  Terminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, PillBar, Pill } from '../../../../shared/view/ui';
import type { Project } from '../../../../types/app';
import type { WorkspaceTab } from '../../../../types/workspace';
import type { WorkspaceApi } from '../../types/types';

type WorkspaceTabStripProps = {
  workspace: WorkspaceApi;
  selectedProject: Project;
  onCloseTab: (id: string) => void;
};

const TAB_ICONS: Record<WorkspaceTab['kind'], LucideIcon> = {
  chat: MessageSquare,
  shell: Terminal,
  file: FileText,
};

/** Resolves a chat tab's live title from project data, falling back to the
 * persisted snapshot so restored tabs render before sessions load. */
function resolveTabTitle(
  tab: WorkspaceTab,
  project: Project,
  newSessionLabel: string,
  shellLabel: string,
): string {
  if (tab.kind === 'file') {
    return tab.name;
  }
  if (tab.kind === 'shell') {
    return tab.title || shellLabel;
  }
  if (!tab.sessionId) {
    return newSessionLabel;
  }
  const sessionLists = [
    project.sessions,
    project.cursorSessions,
    project.codexSessions,
    project.geminiSessions,
    project.opencodeSessions,
  ];
  for (const sessions of sessionLists) {
    const session = sessions?.find((candidate) => candidate.id === tab.sessionId);
    if (session) {
      return (session.summary as string) || (session.name as string) || tab.title || newSessionLabel;
    }
  }
  return tab.title || newSessionLabel;
}

export default function WorkspaceTabStrip({
  workspace,
  selectedProject,
  onCloseTab,
}: WorkspaceTabStripProps) {
  const { t } = useTranslation();

  const newSessionLabel = t('mainContent.newSession');
  const shellLabel = t('tabs.shell');

  return (
    <PillBar>
      {workspace.tabs.map((tab) => {
        const isActive = tab.id === workspace.activeId;
        const Icon = TAB_ICONS[tab.kind];
        const title = resolveTabTitle(tab, selectedProject, newSessionLabel, shellLabel);

        return (
          <Tooltip key={tab.id} content={title} position="bottom">
            <Pill
              isActive={isActive}
              onClick={() => workspace.activateTab(tab.id)}
              className="px-2 py-[5px]"
            >
              <Icon className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
              {/* Tab titles stay visible on mobile — that's the point of tabs. */}
              <span className="max-w-[120px] truncate">{title}</span>
              <span
                role="button"
                tabIndex={-1}
                aria-label={t('mainContent.closeTab', { defaultValue: 'Close tab' })}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className="-mr-0.5 ml-0.5 rounded p-0.5 opacity-60 hover:bg-foreground/10 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </span>
            </Pill>
          </Tooltip>
        );
      })}
    </PillBar>
  );
}
