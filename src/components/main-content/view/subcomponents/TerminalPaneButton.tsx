import { SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip, PillBar, Pill } from '../../../../shared/view/ui';

type TerminalPaneButtonProps = {
  isOpen: boolean;
  onToggle: () => void;
};

// Toggles the VS-Code-style terminal pane at the bottom of the main content
// area — a plain interactive shell cwd'd to the current project folder.
export default function TerminalPaneButton({ isOpen, onToggle }: TerminalPaneButtonProps) {
  const { t } = useTranslation();

  const label = isOpen
    ? t('tabs.hideTerminal', 'Hide terminal')
    : t('tabs.showTerminal', 'Show terminal');

  return (
    <Tooltip content={label} position="bottom">
      <PillBar>
        <Pill isActive={isOpen} onClick={onToggle} className="px-2.5 py-[5px]">
          <SquareTerminal className="h-3.5 w-3.5" strokeWidth={isOpen ? 2.2 : 1.8} />
          <span className="hidden lg:inline">{t('tabs.terminal', 'Terminal')}</span>
        </Pill>
      </PillBar>
    </Tooltip>
  );
}
