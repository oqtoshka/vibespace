import { History, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GitDiffMap, GitCommitSummary } from '../../types/types';
import { computeCommitGraph } from '../../utils/commitGraph';
import CommitHistoryItem from './CommitHistoryItem';

type HistoryViewProps = {
  isMobile: boolean;
  isLoading: boolean;
  recentCommits: GitCommitSummary[];
  commitDiffs: GitDiffMap;
  wrapText: boolean;
  /** Scopes the persisted expanded-commit set (per project/sub-repo). */
  storageScope?: string;
  onFetchCommitDiff: (commitHash: string) => Promise<void>;
  onOpenFile: (filePath: string) => void;
};

// Remembers which commits were expanded per repo, so closing and reopening the
// git panel doesn't force re-finding the commit and its files.
const expandedStorageKey = (scope: string) => `git-history-expanded:${scope}`;

function readStoredExpanded(scope: string | undefined): Set<string> {
  if (!scope) return new Set();
  try {
    const raw = localStorage.getItem(expandedStorageKey(scope));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((item): item is string => typeof item === 'string'));
    }
  } catch {
    // Storage unavailable / corrupt — start collapsed.
  }
  return new Set();
}

function writeStoredExpanded(scope: string | undefined, expanded: Set<string>): void {
  if (!scope) return;
  try {
    localStorage.setItem(expandedStorageKey(scope), JSON.stringify([...expanded]));
  } catch {
    // Storage unavailable — expansion just won't persist.
  }
}

export default function HistoryView({
  isMobile,
  isLoading,
  recentCommits,
  commitDiffs,
  wrapText,
  storageScope,
  onFetchCommitDiff,
  onOpenFile,
}: HistoryViewProps) {
  const [expandedCommits, setExpandedCommits] = useState<Set<string>>(() => readStoredExpanded(storageScope));

  // Re-read the persisted set when the panel switches to another repo scope.
  useEffect(() => {
    setExpandedCommits(readStoredExpanded(storageScope));
  }, [storageScope]);

  // Diffs live in parent state and die with the panel; restored expanded
  // commits therefore need their diffs re-fetched on mount / refresh.
  useEffect(() => {
    if (expandedCommits.size === 0 || recentCommits.length === 0) return;
    for (const commit of recentCommits) {
      if (expandedCommits.has(commit.hash) && !commitDiffs[commit.hash]) {
        onFetchCommitDiff(commit.hash).catch((err) => {
          console.error('Failed to fetch commit diff:', err);
        });
      }
    }
    // Deliberately not keyed on commitDiffs: each fetch fills its own entry and
    // re-running on every diff arrival would only re-scan; recentCommits changing
    // (load/refresh) is the signal that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentCommits, expandedCommits]);

  // Lane layout for the commit graph; rows align 1:1 with recentCommits.
  // Older API responses without `parents` degrade to plain rows (no strip).
  const graphRows = useMemo(() => {
    if (!recentCommits.some((commit) => commit.parents !== undefined)) {
      return null;
    }
    return computeCommitGraph(recentCommits);
  }, [recentCommits]);

  const toggleCommitExpanded = useCallback(
    (commitHash: string) => {
      const isExpanding = !expandedCommits.has(commitHash);

      setExpandedCommits((previous) => {
        const next = new Set(previous);
        if (next.has(commitHash)) {
          next.delete(commitHash);
        } else {
          next.add(commitHash);
        }
        writeStoredExpanded(storageScope, next);
        return next;
      });

      // Load commit diff lazily only the first time a commit is expanded.
      if (isExpanding && !commitDiffs[commitHash]) {
        onFetchCommitDiff(commitHash).catch((err) => {
          console.error('Failed to fetch commit diff:', err);
        });
      }
    },
    [commitDiffs, expandedCommits, onFetchCommitDiff, setExpandedCommits, storageScope],
  );

  return (
    <div className="flex-1 overflow-y-auto">
      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : recentCommits.length === 0 ? (
        <div className="flex h-32 flex-col items-center justify-center text-muted-foreground">
          <History className="mb-2 h-10 w-10 opacity-40" />
          <p className="text-sm">No commits found</p>
        </div>
      ) : (
        <div className={isMobile ? 'pb-4' : ''}>
          {recentCommits.map((commit, index) => (
            <CommitHistoryItem
              key={commit.hash}
              commit={commit}
              isExpanded={expandedCommits.has(commit.hash)}
              diff={commitDiffs[commit.hash]}
              isMobile={isMobile}
              wrapText={wrapText}
              graphRow={graphRows?.[index]}
              onToggle={() => toggleCommitExpanded(commit.hash)}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}
