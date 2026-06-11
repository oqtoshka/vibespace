import { useTranslation } from 'react-i18next';

import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { Project, ProjectSession } from '../../../../types/app';
import type { WorkspacePanel } from '../../../../types/workspace';
import type { WorkspaceApi } from '../../types/types';
import { usePlugins } from '../../../../contexts/PluginsContext';

type MainContentTitleProps = {
  workspace: WorkspaceApi;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
};

function getPanelTitle(panel: WorkspacePanel, shouldShowTasksTab: boolean, t: (key: string) => string, pluginDisplayName?: string) {
  if (panel.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (panel === 'git') {
    return t('tabs.git');
  }

  if (panel === 'tasks' && shouldShowTasksTab) {
    return 'TaskMaster';
  }

  if (activeTab === 'browser') {
    return t('tabs.browser');
  }

  return 'Project';
}

function getSessionTitle(session: ProjectSession): string {
  if (session.__provider === 'cursor') {
    return (session.name as string) || 'Untitled Session';
  }

  return (session.summary as string) || 'New Session';
}

export default function MainContentTitle({
  workspace,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
}: MainContentTitleProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const activeTab = workspace.activeTab;
  const activePanel = workspace.activePanel;

  const pluginDisplayName = activePanel?.startsWith('plugin:')
    ? plugins.find((p) => p.name === activePanel.replace('plugin:', ''))?.displayName
    : undefined;

  const isChat = activeTab?.kind === 'chat';
  const showSessionIcon = isChat && Boolean(selectedSession);
  const showChatNewSession = isChat && !selectedSession;

  // Non-chat selections: shell/file tabs show their own titles; panels keep
  // the legacy panel titles.
  const plainTitle =
    activeTab?.kind === 'shell'
      ? activeTab.title || t('tabs.shell')
      : activeTab?.kind === 'file'
        ? activeTab.name
        : activePanel
          ? getPanelTitle(activePanel, shouldShowTasksTab, t, pluginDisplayName)
          : 'Project';

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {showSessionIcon && (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <SessionProviderLogo provider={selectedSession?.__provider} className="h-4 w-4" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {isChat && selectedSession ? (
          <div className="min-w-0">
            <h2 title={getSessionTitle(selectedSession)} className="truncate text-sm font-semibold leading-tight text-foreground">
              {getSessionTitle(selectedSession)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : showChatNewSession ? (
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="truncate text-xs leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight text-foreground">
              {plainTitle}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        )}
      </div>
    </div>
  );
}
