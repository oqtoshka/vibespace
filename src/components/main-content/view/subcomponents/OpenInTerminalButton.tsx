import { useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, PillBar, Pill } from '../../../../shared/view/ui';
import { api } from '../../../../utils/api';
import { isMacOsDesktop } from '../../../../utils/platform';
import type { Project, ProjectSession } from '../../../../types/app';

type OpenInTerminalButtonProps = {
  selectedProject: Project;
  selectedSession: ProjectSession | null;
};

// Launches the current session in Terminal.app on the host Mac. Only rendered
// when the client itself is a macOS desktop (see isMacOsDesktop) — opening a
// desktop terminal is meaningless from an iPad or phone browsing in remotely.
export default function OpenInTerminalButton({
  selectedProject,
  selectedSession,
}: OpenInTerminalButtonProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'idle' | 'opening' | 'error'>('idle');

  if (!isMacOsDesktop()) {
    return null;
  }

  const projectPath = selectedProject.path || selectedProject.fullPath;
  const sessionId = selectedSession?.id;
  const provider = selectedSession?.__provider || 'claude';

  const handleClick = async () => {
    if (!projectPath || status === 'opening') {
      return;
    }
    setStatus('opening');
    try {
      const res = await api.openInTerminal({ projectPath, sessionId, provider });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setStatus('idle');
    } catch {
      setStatus('error');
      setTimeout(() => setStatus('idle'), 2500);
    }
  };

  const label =
    status === 'error'
      ? t('tabs.openInTerminalError', 'Could not open Terminal')
      : t('tabs.openInTerminal', 'Open in desktop Terminal');

  return (
    <Tooltip content={label} position="bottom">
      <PillBar>
        <Pill
          isActive={false}
          onClick={handleClick}
          className={`px-2.5 py-[5px] ${status === 'error' ? 'text-red-500' : ''}`}
        >
          <SquareTerminal
            className="h-3.5 w-3.5"
            strokeWidth={1.8}
          />
          <span className="hidden lg:inline">{t('tabs.terminal', 'Terminal')}</span>
        </Pill>
      </PillBar>
    </Tooltip>
  );
}
