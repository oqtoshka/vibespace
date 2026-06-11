import { useCallback, useState } from 'react';
import type { Project, ProjectSession } from '../../../types/app';
import Shell, { type ShellController } from '../../shell/view/Shell';
import StandaloneShellEmptyState from './subcomponents/StandaloneShellEmptyState';
import StandaloneShellHeader from './subcomponents/StandaloneShellHeader';

type StandaloneShellProps = {
  project?: Project | null;
  session?: ProjectSession | null;
  command?: string | null;
  isPlainShell?: boolean | null;
  isActive?: boolean;
  autoConnect?: boolean;
  onComplete?: ((exitCode: number) => void) | null;
  onClose?: (() => void) | null;
  title?: string | null;
  className?: string;
  showHeader?: boolean;
  compact?: boolean;
  minimal?: boolean;
  /** Workspace shell-tab id; differentiates this shell's server PTY key. */
  shellId?: string | null;
  /** Lets the parent imperatively control the shell (kill-on-tab-close). */
  onRegisterController?: ((controller: ShellController | null) => void) | null;
};

export default function StandaloneShell({
  project = null,
  session = null,
  command = null,
  isPlainShell = null,
  isActive = true,
  autoConnect = true,
  onComplete = null,
  onClose = null,
  title = null,
  className = '',
  showHeader = true,
  compact = false,
  minimal = false,
  shellId = null,
  onRegisterController = null,
}: StandaloneShellProps) {
  const [isCompleted, setIsCompleted] = useState(false);

  // Keep `compact` in the public API for compatibility with existing callers.
  void compact;

  const shouldUsePlainShell = isPlainShell !== null ? isPlainShell : command !== null;

  const handleProcessComplete = useCallback(
    (exitCode: number) => {
      setIsCompleted(true);
      onComplete?.(exitCode);
    },
    [onComplete],
  );

  if (!project) {
    return <StandaloneShellEmptyState className={className} />;
  }

  return (
    <div className={`flex h-full w-full flex-col ${className}`}>
      {!minimal && showHeader && title && (
        <StandaloneShellHeader title={title} isCompleted={isCompleted} onClose={onClose} />
      )}

      <div className="min-h-0 w-full flex-1">
        <Shell
          selectedProject={project}
          selectedSession={session}
          initialCommand={command}
          isPlainShell={shouldUsePlainShell}
          isActive={isActive}
          onProcessComplete={handleProcessComplete}
          minimal={minimal}
          autoConnect={minimal ? true : autoConnect}
          shellId={shellId}
          onRegisterController={onRegisterController}
        />
      </div>
    </div>
  );
}
