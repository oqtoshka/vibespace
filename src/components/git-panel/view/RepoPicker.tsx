import { Check, ChevronDown, FolderGit2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GitDiscoveredRepo } from '../types/types';

type RepoPickerProps = {
  isMobile: boolean;
  repos: GitDiscoveredRepo[];
  selectedRepoPath: string | null;
  onSelectRepo: (relPath: string) => void;
};

/**
 * Dropdown for choosing which discovered git repository the panel operates
 * on. Rendered only when the project root isn't a repo or when multiple
 * repos were discovered (VSCode-workspace-style sub-repos).
 */
export default function RepoPicker({ isMobile, repos, selectedRepoPath, onSelectRepo }: RepoPickerProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedRepo = repos.find((repo) => repo.relPath === (selectedRepoPath ?? ''));

  return (
    <div className={`flex items-center border-b border-border/60 ${isMobile ? 'px-3 py-1.5' : 'px-4 py-2'}`}>
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown((prev) => !prev)}
          className={`flex items-center rounded-lg transition-colors hover:bg-accent ${isMobile ? 'space-x-1 px-2 py-1' : 'space-x-2 px-3 py-1.5'}`}
          title="Select repository"
        >
          <FolderGit2 className={`text-muted-foreground ${isMobile ? 'h-3 w-3' : 'h-4 w-4'}`} />
          <span className={`font-medium ${isMobile ? 'text-xs' : 'text-sm'}`}>
            {selectedRepo?.name ?? 'Select repository'}
          </span>
          {selectedRepo && selectedRepo.relPath && selectedRepo.relPath !== selectedRepo.name && (
            <span className="text-xs text-muted-foreground">{selectedRepo.relPath}</span>
          )}
          <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
        </button>

        {showDropdown && (
          <div className="absolute left-0 top-full z-50 mt-1 w-64 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
            <div className="max-h-64 overflow-y-auto py-1">
              {repos.map((repo) => {
                const isSelected = repo.relPath === (selectedRepoPath ?? '');
                return (
                  <button
                    key={repo.relPath || '.'}
                    onClick={() => {
                      onSelectRepo(repo.relPath);
                      setShowDropdown(false);
                    }}
                    className={`w-full px-4 py-2 text-left text-sm transition-colors hover:bg-accent ${
                      isSelected ? 'bg-accent/50 text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    <span className="flex items-center space-x-2">
                      {isSelected && <Check className="h-3 w-3 text-primary" />}
                      <span className={isSelected ? 'font-medium' : ''}>{repo.name}</span>
                      {repo.relPath && repo.relPath !== repo.name && (
                        <span className="text-xs text-muted-foreground">{repo.relPath}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
