import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { DEFAULT_BRANCH, RECENT_COMMITS_LIMIT } from '../constants/constants';
import type {
  GitApiErrorResponse,
  GitBranchesResponse,
  GitCommitSummary,
  GitCommitsResponse,
  GitDiffMap,
  GitDiffResponse,
  GitDiscoveredRepo,
  GitFileWithDiffResponse,
  GitGenerateMessageResponse,
  GitOperationResponse,
  GitPanelController,
  GitRemoteStatus,
  GitReposResponse,
  GitStatusResponse,
  GitWorktree,
  GitWorktreesResponse,
  UseGitPanelControllerOptions,
} from '../types/types';
import { getAllChangedFiles } from '../utils/gitPanelUtils';
import { useSelectedProvider } from './useSelectedProvider';
import { useActiveWorktree } from '../../../hooks/useActiveWorktree';

// ! use authenticatedFetch directly. fetchWithAuth is redundant 
const fetchWithAuth = authenticatedFetch as (url: string, options?: RequestInit) => Promise<Response>;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function readJson<T>(response: Response, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }

  const data = (await response.json()) as T;

  if (signal?.aborted) {
    throw new DOMException('Request aborted', 'AbortError');
  }

  return data;
}

// Remembers which sub-repo was selected per project across reloads.
const repoStorageKey = (projectId: string) => `git-selected-repo:${projectId}`;

function readStoredRepoPath(projectId: string): string | null {
  try {
    return localStorage.getItem(repoStorageKey(projectId));
  } catch {
    return null;
  }
}

function writeStoredRepoPath(projectId: string, relPath: string): void {
  try {
    localStorage.setItem(repoStorageKey(projectId), relPath);
  } catch {
    // Silently ignore storage errors
  }
}

export function useGitPanelController({
  selectedProject,
  activeView,
  onFileOpen,
}: UseGitPanelControllerOptions): GitPanelController {
  const [gitStatus, setGitStatus] = useState<GitStatusResponse | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffMap>({});
  const [isLoading, setIsLoading] = useState(false);
  const [currentBranch, setCurrentBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [recentCommits, setRecentCommits] = useState<GitCommitSummary[]>([]);
  // Separate from `isLoading` (status) so History never flashes "No commits
  // found" while the commits request is still in flight.
  const [isLoadingCommits, setIsLoadingCommits] = useState(false);
  const [hasLoadedCommits, setHasLoadedCommits] = useState(false);
  const [commitDiffs, setCommitDiffs] = useState<GitDiffMap>({});
  const [remoteStatus, setRemoteStatus] = useState<GitRemoteStatus | null>(null);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isCreatingInitialCommit, setIsCreatingInitialCommit] = useState(false);
  const [isInitializingRepository, setIsInitializingRepository] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  // Sub-repo discovery: when the project root isn't a git repo, the panel can
  // operate on a repository nested in a subfolder. `selectedRepoPath` is the
  // project-relative path of that repo ('' = project root, null = discovery
  // still pending).
  const [discoveredRepos, setDiscoveredRepos] = useState<GitDiscoveredRepo[]>([]);
  const [selectedRepoPath, setSelectedRepoPath] = useState<string | null>(null);
  const [rootIsRepo, setRootIsRepo] = useState(true);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  // Which worktree new chat sessions run in (shared with the composer).
  const { activeWorktree, setActiveWorktree } = useActiveWorktree(selectedProject?.projectId ?? null);

  const clearOperationError = useCallback(() => setOperationError(null), []);
  // Tracks the DB projectId so async requests can detect stale responses when
  // the user switches projects mid-flight.
  const selectedProjectIdRef = useRef<string | null>(selectedProject?.projectId ?? null);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProject?.projectId ?? null;
  }, [selectedProject]);

  const provider = useSelectedProvider();

  // Centralized repoPath threading: every git API call goes through one of
  // these so the whole panel transparently targets the selected sub-repo.
  const withRepoParam = useCallback(
    (url: string) => (selectedRepoPath ? `${url}&repoPath=${encodeURIComponent(selectedRepoPath)}` : url),
    [selectedRepoPath],
  );

  const repoBody = useCallback(
    () => (selectedRepoPath ? { repoPath: selectedRepoPath } : {}),
    [selectedRepoPath],
  );

  const fetchFileDiff = useCallback(
    async (filePath: string, signal?: AbortSignal) => {
      if (!selectedProject) {
        return;
      }

      // Git endpoints receive the DB projectId via the `project` query param.
      const projectId = selectedProject.projectId;

      try {
        const response = await fetchWithAuth(
          withRepoParam(`/api/git/diff?project=${encodeURIComponent(projectId)}&file=${encodeURIComponent(filePath)}`),
          { signal },
        );
        const data = await readJson<GitDiffResponse>(response, signal);

        if (
          signal?.aborted ||
          selectedProjectIdRef.current !== projectId
        ) {
          return;
        }

        if (!data.error && data.diff) {
          setGitDiff((previous) => ({
            ...previous,
            [filePath]: data.diff as string,
          }));
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return;
        }

        console.error('Error fetching file diff:', error);
      }
    },
    [selectedProject, withRepoParam],
  );

  const fetchGitStatus = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject) {
      return;
    }

    // `project` query param carries the DB projectId everywhere now.
    const projectId = selectedProject.projectId;

    setIsLoading(true);
    try {
      const response = await fetchWithAuth(withRepoParam(`/api/git/status?project=${encodeURIComponent(projectId)}`), { signal });
      const data = await readJson<GitStatusResponse>(response, signal);

      if (
        signal?.aborted ||
        selectedProjectIdRef.current !== projectId
      ) {
        return;
      }

      if (data.error) {
        // A missing repository is an expected state, not an error.
        if (!data.notGitRepository) {
          console.error('Git status error:', data.error);
        }
        setGitStatus({
          error: data.error,
          details: data.details,
          notGitRepository: data.notGitRepository,
        });
        setCurrentBranch('');
        return;
      }

      setGitStatus(data);
      setCurrentBranch(data.branch || DEFAULT_BRANCH);

      const changedFiles = getAllChangedFiles(data);
      changedFiles.forEach((filePath) => {
        void fetchFileDiff(filePath, signal);
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }

      if (
        selectedProjectIdRef.current !== projectId
      ) {
        return;
      }

      console.error('Error fetching git status:', error);
      setGitStatus({ error: 'Git operation failed', details: String(error) });
      setCurrentBranch('');
    } finally {
      setIsLoading(false);
    }
  }, [fetchFileDiff, selectedProject, withRepoParam]);

  const fetchBranches = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    try {
      const response = await fetchWithAuth(withRepoParam(`/api/git/branches?project=${encodeURIComponent(selectedProject.projectId)}`));
      const data = await readJson<GitBranchesResponse>(response);

      if (!data.error && data.branches) {
        setBranches(data.branches);
        setLocalBranches(data.localBranches ?? data.branches);
        setRemoteBranches(data.remoteBranches ?? []);
        return;
      }

      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    } catch (error) {
      console.error('Error fetching branches:', error);
      setBranches([]);
      setLocalBranches([]);
      setRemoteBranches([]);
    }
  }, [selectedProject, withRepoParam]);

  const fetchRemoteStatus = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    try {
      const response = await fetchWithAuth(withRepoParam(`/api/git/remote-status?project=${encodeURIComponent(selectedProject.projectId)}`));
      const data = await readJson<GitRemoteStatus | GitApiErrorResponse>(response);

      if (!data.error) {
        setRemoteStatus(data as GitRemoteStatus);
        return;
      }

      setRemoteStatus(null);
    } catch (error) {
      console.error('Error fetching remote status:', error);
      setRemoteStatus(null);
    }
  }, [selectedProject, withRepoParam]);

  const switchBranch = useCallback(
    async (branchName: string) => {
      if (!selectedProject) {
        return false;
      }

      try {
        const response = await fetchWithAuth('/api/git/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            branch: branchName,
            ...repoBody(),
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          console.error('Failed to switch branch:', data.error);
          return false;
        }

        setCurrentBranch(branchName);
        void fetchGitStatus();
        return true;
      } catch (error) {
        console.error('Error switching branch:', error);
        return false;
      }
    },
    [fetchGitStatus, repoBody, selectedProject],
  );

  const createBranch = useCallback(
    async (branchName: string) => {
      const trimmedBranchName = branchName.trim();
      if (!selectedProject || !trimmedBranchName) {
        return false;
      }

      setIsCreatingBranch(true);
      try {
        const response = await fetchWithAuth('/api/git/create-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            branch: trimmedBranchName,
            ...repoBody(),
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          console.error('Failed to create branch:', data.error);
          return false;
        }

        setCurrentBranch(trimmedBranchName);
        void fetchBranches();
        void fetchGitStatus();
        return true;
      } catch (error) {
        console.error('Error creating branch:', error);
        return false;
      } finally {
        setIsCreatingBranch(false);
      }
    },
    [fetchBranches, fetchGitStatus, repoBody, selectedProject],
  );

  const deleteBranch = useCallback(
    async (branchName: string, force = false) => {
      if (!selectedProject) return false;

      try {
        const response = await fetchWithAuth('/api/git/delete-branch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: selectedProject.projectId, branch: branchName, force, ...repoBody() }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Delete branch failed');
          return false;
        }

        void fetchBranches();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Delete branch failed');
        return false;
      }
    },
    [fetchBranches, repoBody, selectedProject],
  );

  const handleFetch = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsFetching(true);
    try {
      const response = await fetchWithAuth('/api/git/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
          ...repoBody(),
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        void fetchBranches();
        return;
      }

      setOperationError(data.error ?? 'Fetch failed');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Fetch failed');
    } finally {
      setIsFetching(false);
    }
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, repoBody, selectedProject]);

  const handlePull = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPulling(true);
    try {
      const response = await fetchWithAuth('/api/git/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
          ...repoBody(),
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      setOperationError(data.error ?? 'Pull failed');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Pull failed');
    } finally {
      setIsPulling(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, repoBody, selectedProject]);

  const handlePush = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPushing(true);
    try {
      const response = await fetchWithAuth('/api/git/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
          ...repoBody(),
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      setOperationError(data.error ?? 'Push failed');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : 'Push failed');
    } finally {
      setIsPushing(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, repoBody, selectedProject]);

  const handlePublish = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    setIsPublishing(true);
    try {
      const response = await fetchWithAuth('/api/git/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
          branch: currentBranch,
          ...repoBody(),
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return;
      }

      console.error('Publish failed:', data.error);
    } catch (error) {
      console.error('Error publishing branch:', error);
    } finally {
      setIsPublishing(false);
    }
  }, [currentBranch, fetchGitStatus, fetchRemoteStatus, repoBody, selectedProject]);

  const discardChanges = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await fetchWithAuth('/api/git/discard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            file: filePath,
            ...repoBody(),
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        console.error('Discard failed:', data.error);
      } catch (error) {
        console.error('Error discarding changes:', error);
      }
    },
    [fetchGitStatus, repoBody, selectedProject],
  );

  const deleteUntrackedFile = useCallback(
    async (filePath: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await fetchWithAuth('/api/git/delete-untracked', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            file: filePath,
            ...repoBody(),
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          return;
        }

        console.error('Delete failed:', data.error);
      } catch (error) {
        console.error('Error deleting untracked file:', error);
      }
    },
    [fetchGitStatus, repoBody, selectedProject],
  );

  const stageFiles = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return false;
      }

      try {
        const response = await fetchWithAuth('/api/git/stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            files,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Stage failed');
          return false;
        }

        // Refresh so the Staged section re-syncs from the real index.
        await fetchGitStatus();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Stage failed');
        return false;
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const unstageFiles = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return false;
      }

      try {
        const response = await fetchWithAuth('/api/git/unstage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            files,
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (!data.success) {
          setOperationError(data.error ?? 'Unstage failed');
          return false;
        }

        await fetchGitStatus();
        return true;
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : 'Unstage failed');
        return false;
      }
    },
    [fetchGitStatus, selectedProject],
  );

  const fetchRecentCommits = useCallback(async () => {
    if (!selectedProject) {
      return;
    }

    const projectId = selectedProject.projectId;

    setIsLoadingCommits(true);
    try {
      const response = await fetchWithAuth(
        withRepoParam(`/api/git/commits?project=${encodeURIComponent(projectId)}&limit=${RECENT_COMMITS_LIMIT}`),
      );
      const data = await readJson<GitCommitsResponse>(response);

      if (selectedProjectIdRef.current !== projectId) {
        return;
      }

      if (!data.error && data.commits) {
        setRecentCommits(data.commits);
      }
    } catch (error) {
      console.error('Error fetching commits:', error);
    } finally {
      if (selectedProjectIdRef.current === projectId) {
        setIsLoadingCommits(false);
        setHasLoadedCommits(true);
      }
    }
  }, [selectedProject, withRepoParam]);

  const fetchCommitDiff = useCallback(
    async (commitHash: string) => {
      if (!selectedProject) {
        return;
      }

      try {
        const response = await fetchWithAuth(
          withRepoParam(`/api/git/commit-diff?project=${encodeURIComponent(selectedProject.projectId)}&commit=${commitHash}`),
        );
        const data = await readJson<GitDiffResponse>(response);

        if (!data.error && data.diff) {
          setCommitDiffs((previous) => ({
            ...previous,
            [commitHash]: data.diff as string,
          }));
        }
      } catch (error) {
        console.error('Error fetching commit diff:', error);
      }
    },
    [selectedProject, withRepoParam],
  );

  const generateCommitMessage = useCallback(
    async (files: string[]) => {
      if (!selectedProject || files.length === 0) {
        return null;
      }

      try {
        const response = await authenticatedFetch('/api/git/generate-commit-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            files,
            provider,
            ...repoBody(),
          }),
        });

        const data = await readJson<GitGenerateMessageResponse>(response);
        if (data.message) {
          return data.message;
        }

        console.error('Failed to generate commit message:', data.error);
        return null;
      } catch (error) {
        console.error('Error generating commit message:', error);
        return null;
      }
    },
    [provider, repoBody, selectedProject],
  );

  const commitChanges = useCallback(
    async (message: string, files: string[]) => {
      if (!selectedProject || !message.trim() || files.length === 0) {
        return false;
      }

      try {
        const response = await fetchWithAuth('/api/git/commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            message,
            files,
            ...repoBody(),
          }),
        });

        const data = await readJson<GitOperationResponse>(response);
        if (data.success) {
          void fetchGitStatus();
          void fetchRemoteStatus();
          return true;
        }

        console.error('Commit failed:', data.error);
        return false;
      } catch (error) {
        console.error('Error committing changes:', error);
        return false;
      }
    },
    [fetchGitStatus, fetchRemoteStatus, repoBody, selectedProject],
  );

  const createInitialCommit = useCallback(async () => {
    if (!selectedProject) {
      throw new Error('No project selected');
    }

    setIsCreatingInitialCommit(true);
    try {
      const response = await fetchWithAuth('/api/git/initial-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject.projectId,
          ...repoBody(),
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (data.success) {
        void fetchGitStatus();
        void fetchRemoteStatus();
        return true;
      }

      throw new Error(data.error || 'Failed to create initial commit');
    } catch (error) {
      console.error('Error creating initial commit:', error);
      throw error;
    } finally {
      setIsCreatingInitialCommit(false);
    }
  }, [fetchGitStatus, fetchRemoteStatus, repoBody, selectedProject]);

  const initRepository = useCallback(async () => {
    if (!selectedProject) {
      return false;
    }
    const projectId = selectedProject.projectId;

    setIsInitializingRepository(true);
    try {
      const response = await fetchWithAuth('/api/git/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: projectId,
        }),
      });

      const data = await readJson<GitOperationResponse>(response);
      if (selectedProjectIdRef.current !== projectId) {
        return false;
      }
      if (!data.success) {
        setOperationError(data.error ?? 'Failed to initialize repository');
        return false;
      }

      void fetchGitStatus();
      void fetchBranches();
      void fetchRemoteStatus();
      return true;
    } catch (error) {
      if (selectedProjectIdRef.current === projectId) {
        setOperationError(error instanceof Error ? error.message : 'Failed to initialize repository');
      }
      return false;
    } finally {
      setIsInitializingRepository(false);
    }
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, selectedProject]);

  const openFile = useCallback(
    async (filePath: string) => {
      if (!onFileOpen) {
        return;
      }

      if (!selectedProject) {
        onFileOpen(filePath);
        return;
      }

      // Git reports repo-relative paths, but the editor (tab identity,
      // breadcrumbs, sibling browsing) expects an absolute path — a relative
      // one renders truncated crumbs whose menus fail to load. Resolve against
      // the active repo root (`selectedRepoPath` is project-relative; '' means
      // the project root itself).
      const projectRoot = (selectedProject.fullPath || '').replace(/\/+$/, '');
      const repoRoot = selectedRepoPath ? `${projectRoot}/${selectedRepoPath}` : projectRoot;
      const absolutePath = filePath.startsWith('/') || !repoRoot
        ? filePath
        : `${repoRoot}/${filePath}`;

      try {
        const response = await fetchWithAuth(
          withRepoParam(`/api/git/file-with-diff?project=${encodeURIComponent(selectedProject.projectId)}&file=${encodeURIComponent(filePath)}`),
        );
        const data = await readJson<GitFileWithDiffResponse>(response);

        if (data.error) {
          console.error('Error fetching file with diff:', data.error);
          onFileOpen(absolutePath);
          return;
        }

        onFileOpen(absolutePath, {
          old_string: data.oldContent || '',
          new_string: data.currentContent || '',
        });
      } catch (error) {
        console.error('Error opening file:', error);
        onFileOpen(absolutePath);
      }
    },
    [onFileOpen, selectedProject, selectedRepoPath, withRepoParam],
  );

  const refreshAll = useCallback(() => {
    void fetchGitStatus();
    void fetchBranches();
    void fetchRemoteStatus();
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus]);

  // Discover git repositories for the project: the root itself and/or repos
  // nested in subfolders. Resolves `selectedRepoPath`, which then unblocks the
  // status/branches/remote fetch effect below.
  const discoverRepos = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject) {
      return;
    }

    const projectId = selectedProject.projectId;
    let isRepo = true;
    let repos: GitDiscoveredRepo[] = [];

    try {
      const response = await fetchWithAuth(`/api/git/repos?project=${encodeURIComponent(projectId)}`, { signal });
      const data = await readJson<GitReposResponse>(response, signal);
      if (!data.error) {
        isRepo = Boolean(data.isRepo);
        repos = data.repos ?? [];
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }
      // Discovery failures fall back to root-repo behavior: the status fetch
      // surfaces whatever error there is, exactly like before this feature.
      console.error('Error discovering git repos:', error);
    }

    if (signal?.aborted || selectedProjectIdRef.current !== projectId) {
      return;
    }

    const stored = readStoredRepoPath(projectId);
    const storedIsValid = stored !== null
      && ((stored === '' && isRepo) || repos.some((repo) => repo.relPath === stored));

    let nextRepoPath = '';
    if (storedIsValid) {
      nextRepoPath = stored;
    } else if (!isRepo && repos.length > 0) {
      nextRepoPath = repos[0].relPath;
    }

    setRootIsRepo(isRepo);
    setDiscoveredRepos(repos);
    setSelectedRepoPath(nextRepoPath);
  }, [selectedProject]);

  const selectRepo = useCallback(
    (relPath: string) => {
      if (!selectedProject || relPath === selectedRepoPath) {
        return;
      }
      writeStoredRepoPath(selectedProject.projectId, relPath);
      setSelectedRepoPath(relPath);
    },
    [selectedProject, selectedRepoPath],
  );

  // Worktrees for the current repo. Selecting one sets the project's active
  // worktree (drives where new chat sessions run); it does not change the
  // panel's own git views in this version.
  const fetchWorktrees = useCallback(async (signal?: AbortSignal) => {
    if (!selectedProject) {
      return;
    }
    const projectId = selectedProject.projectId;
    try {
      const response = await fetchWithAuth(
        withRepoParam(`/api/git/worktrees?project=${encodeURIComponent(projectId)}`),
        { signal },
      );
      const data = await readJson<GitWorktreesResponse>(response, signal);
      if (signal?.aborted || selectedProjectIdRef.current !== projectId) {
        return;
      }
      setWorktrees(data.worktrees ?? []);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        return;
      }
      console.error('Error fetching worktrees:', error);
    }
  }, [selectedProject, withRepoParam]);

  const selectWorktree = useCallback(
    (worktree: GitWorktree | null) => {
      // The main checkout (isMain) means "no worktree override".
      if (!worktree || worktree.isMain) {
        setActiveWorktree(null);
      } else {
        setActiveWorktree({ path: worktree.path, branch: worktree.branch });
      }
    },
    [setActiveWorktree],
  );

  const addWorktree = useCallback(
    async ({ branch, createBranch: createNew, base = null }: { branch: string; createBranch: boolean; base?: string | null }) => {
      const trimmed = branch.trim();
      if (!selectedProject || !trimmed) {
        return false;
      }
      try {
        const response = await fetchWithAuth('/api/git/worktrees/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            branch: trimmed,
            createBranch: createNew,
            base: base || undefined,
            ...repoBody(),
          }),
        });
        const data = await readJson<{ success?: boolean; worktree?: GitWorktree; error?: string }>(response);
        if (!data.success) {
          setOperationError(data.error || 'Failed to create worktree');
          return false;
        }
        await fetchWorktrees();
        // Activate the new worktree so new sessions land in it.
        if (data.worktree) {
          setActiveWorktree({ path: data.worktree.path, branch: data.worktree.branch });
        }
        return true;
      } catch (error) {
        console.error('Error creating worktree:', error);
        setOperationError(error instanceof Error ? error.message : 'Failed to create worktree');
        return false;
      }
    },
    [fetchWorktrees, repoBody, selectedProject, setActiveWorktree],
  );

  const removeWorktree = useCallback(
    async (worktreePath: string) => {
      if (!selectedProject || !worktreePath) {
        return false;
      }
      try {
        const response = await fetchWithAuth('/api/git/worktrees/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: selectedProject.projectId,
            worktreePath,
            force: true,
            ...repoBody(),
          }),
        });
        const data = await readJson<{ success?: boolean; error?: string }>(response);
        if (!data.success) {
          setOperationError(data.error || 'Failed to remove worktree');
          return false;
        }
        if (activeWorktree?.path === worktreePath) {
          setActiveWorktree(null);
        }
        await fetchWorktrees();
        return true;
      } catch (error) {
        console.error('Error removing worktree:', error);
        setOperationError(error instanceof Error ? error.message : 'Failed to remove worktree');
        return false;
      }
    },
    [activeWorktree, fetchWorktrees, repoBody, selectedProject, setActiveWorktree],
  );

  // Project change: reset everything and kick off repo discovery.
  useEffect(() => {
    const controller = new AbortController();

    // Reset repository-scoped state when project changes to avoid stale UI.
    setCurrentBranch('');
    setBranches([]);
    setLocalBranches([]);
    setRemoteBranches([]);
    setGitStatus(null);
    setRemoteStatus(null);
    setGitDiff({});
    setRecentCommits([]);
    setCommitDiffs({});
    setIsLoading(false);
    setIsLoadingCommits(false);
    setHasLoadedCommits(false);
    setOperationError(null);
    setDiscoveredRepos([]);
    setSelectedRepoPath(null);
    setRootIsRepo(true);

    if (!selectedProject) {
      return () => {
        controller.abort();
      };
    }

    void discoverRepos(controller.signal);

    return () => {
      controller.abort();
    };
  }, [discoverRepos, selectedProject]);

  // Repo resolved (initially or via the picker): clear repo-scoped data and
  // load the panel. `null` means discovery hasn't completed yet.
  useEffect(() => {
    if (!selectedProject || selectedRepoPath === null) {
      return;
    }

    const controller = new AbortController();

    setGitDiff({});
    setRecentCommits([]);
    setCommitDiffs({});

    void fetchGitStatus(controller.signal);
    void fetchBranches();
    void fetchRemoteStatus();
    void fetchWorktrees(controller.signal);

    return () => {
      controller.abort();
    };
  }, [fetchBranches, fetchGitStatus, fetchRemoteStatus, fetchWorktrees, selectedProject, selectedRepoPath]);

  useEffect(() => {
    if (!selectedProject || activeView !== 'history') {
      return;
    }
    void fetchRecentCommits();
  }, [activeView, fetchRecentCommits, selectedProject]);

  return {
    gitStatus,
    gitDiff,
    isLoading,
    discoveredRepos,
    selectedRepoPath,
    rootIsRepo,
    selectRepo,
    // History is "loading" until the first commits response for this project
    // lands, so an empty list never renders before the data exists.
    isLoadingCommits: isLoadingCommits || !hasLoadedCommits,
    currentBranch,
    branches,
    localBranches,
    remoteBranches,
    recentCommits,
    commitDiffs,
    remoteStatus,
    isCreatingBranch,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    isCreatingInitialCommit,
    isInitializingRepository,
    operationError,
    clearOperationError,
    refreshAll,
    worktrees,
    activeWorktreePath: activeWorktree?.path ?? null,
    selectWorktree,
    addWorktree,
    removeWorktree,
    switchBranch,
    createBranch,
    deleteBranch,
    handleFetch,
    handlePull,
    handlePush,
    handlePublish,
    discardChanges,
    deleteUntrackedFile,
    stageFiles,
    unstageFiles,
    fetchCommitDiff,
    generateCommitMessage,
    commitChanges,
    createInitialCommit,
    initRepository,
    openFile,
  };
}
