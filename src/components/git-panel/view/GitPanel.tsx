import { useCallback, useEffect, useState } from 'react';
import { useGitPanelController } from '../hooks/useGitPanelController';
import { useRevertLocalCommit } from '../hooks/useRevertLocalCommit';
import type { ConfirmationRequest, GitPanelProps, GitPanelView } from '../types/types';
import { getChangedFileCount } from '../utils/gitPanelUtils';
import ChangesView from '../view/changes/ChangesView';
import HistoryView from '../view/history/HistoryView';
import BranchesView from '../view/branches/BranchesView';
import WorktreesView from '../view/worktrees/WorktreesView';
import GitPanelHeader from '../view/GitPanelHeader';
import GitRepositoryErrorState from '../view/GitRepositoryErrorState';
import GitViewTabs from '../view/GitViewTabs';
import ConfirmActionModal from '../view/modals/ConfirmActionModal';
import RepoPicker from '../view/RepoPicker';
import WorktreePicker from '../view/WorktreePicker';

// Remembers which tab (changes/history/branches) was open per project, so
// closing and reopening the panel lands back where the user was.
const viewStorageKey = (projectId: string) => `git-panel-view:${projectId}`;

function readStoredView(projectId: string | undefined): GitPanelView {
  if (!projectId) return 'changes';
  try {
    const stored = localStorage.getItem(viewStorageKey(projectId));
    if (stored === 'changes' || stored === 'history' || stored === 'branches' || stored === 'worktrees') {
      return stored;
    }
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return 'changes';
}

export default function GitPanel({
  selectedProject,
  isMobile = false,
  onFileOpen,
  onProjectSelect,
  onProjectsRefresh,
}: GitPanelProps) {
  const [activeView, setActiveViewState] = useState<GitPanelView>(() => readStoredView(selectedProject?.projectId));

  // Re-read the remembered tab when the panel switches to another project.
  useEffect(() => {
    setActiveViewState(readStoredView(selectedProject?.projectId));
  }, [selectedProject?.projectId]);

  const setActiveView = useCallback((view: GitPanelView) => {
    setActiveViewState(view);
    if (selectedProject?.projectId) {
      try {
        localStorage.setItem(viewStorageKey(selectedProject.projectId), view);
      } catch {
        // Storage unavailable — the tab just won't persist.
      }
    }
  }, [selectedProject?.projectId]);
  const [wrapText, setWrapText] = useState(true);
  const [hasExpandedFiles, setHasExpandedFiles] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmationRequest | null>(null);

  const {
    gitStatus,
    gitDiff,
    isLoading,
    discoveredRepos,
    selectedRepoPath,
    rootIsRepo,
    selectRepo,
    isLoadingCommits,
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
    activeWorktreePath,
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
    commitChanges,
    createInitialCommit,
    initRepository,
    openFile,
  } = useGitPanelController({
    selectedProject,
    activeView,
    onFileOpen,
  });

  const { isRevertingLocalCommit, revertLatestLocalCommit } = useRevertLocalCommit({
    // `projectId` (DB primary key) is forwarded to the revert API which uses it
    // as the `project` body param.
    projectId: selectedProject?.projectId ?? null,
    repoPath: selectedRepoPath,
    onSuccess: refreshAll,
  });

  const executeConfirmedAction = useCallback(async (useAlternateConfirmation = false) => {
    if (!confirmAction) return;
    const actionToExecute = confirmAction;
    setConfirmAction(null);
    try {
      const confirmationHandler = useAlternateConfirmation
        ? actionToExecute.alternateConfirmation?.onConfirm ?? actionToExecute.onConfirm
        : actionToExecute.onConfirm;
      await confirmationHandler();
    } catch (error) {
      console.error('Error executing confirmation action:', error);
    }
  }, [confirmAction]);

  const changeCount = getChangedFileCount(gitStatus);
  // Surface the picker whenever there's an actual choice to make: the root
  // isn't a repo (sub-repos drive the panel) or several repos were found.
  const showRepoPicker = !rootIsRepo || discoveredRepos.length > 1;
  // Scopes per-repo UI state (changes view, commit message draft) to the
  // selected repository.
  const repoScopePath = selectedRepoPath
    ? `${selectedProject?.fullPath ?? ''}/${selectedRepoPath}`
    : selectedProject?.fullPath ?? '';
  // Without a repository the branch/fetch/refresh header controls are all
  // meaningless — hide the whole header and let the init state own the panel.
  const isMissingRepository = Boolean(gitStatus?.notGitRepository);

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>Select a project to view source control</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {showRepoPicker && (
        <RepoPicker
          isMobile={isMobile}
          repos={discoveredRepos}
          selectedRepoPath={selectedRepoPath}
          onSelectRepo={selectRepo}
        />
      )}

      {worktrees.length > 0 && (
        <WorktreePicker
          isMobile={isMobile}
          worktrees={worktrees}
          branches={localBranches}
          activeWorktreePath={activeWorktreePath}
          onSelect={selectWorktree}
          onAdd={addWorktree}
          onRemove={removeWorktree}
        />
      )}

      {!isMissingRepository && (
        <GitPanelHeader
          isMobile={isMobile}
          currentBranch={currentBranch}
          branches={branches}
          remoteStatus={remoteStatus}
          isLoading={isLoading}
          isCreatingBranch={isCreatingBranch}
          isFetching={isFetching}
          isPulling={isPulling}
          isPushing={isPushing}
          isPublishing={isPublishing}
          isRevertingLocalCommit={isRevertingLocalCommit}
          operationError={operationError}
          onRefresh={refreshAll}
          onRevertLocalCommit={revertLatestLocalCommit}
          onSwitchBranch={switchBranch}
          onCreateBranch={createBranch}
          onFetch={handleFetch}
          onPull={handlePull}
          onPush={handlePush}
          onPublish={handlePublish}
          onClearError={clearOperationError}
          onRequestConfirmation={setConfirmAction}
        />
      )}

      {gitStatus?.error ? (
        <GitRepositoryErrorState
          error={gitStatus.error}
          details={gitStatus.details}
          canInitRepository={isMissingRepository}
          isInitializingRepository={isInitializingRepository}
          initError={isMissingRepository ? operationError : null}
          onInitRepository={() => {
            clearOperationError();
            void initRepository();
          }}
        />
      ) : (
        <>
          <GitViewTabs
            activeView={activeView}
            isHidden={hasExpandedFiles}
            changeCount={changeCount}
            onChange={setActiveView}
          />

          {activeView === 'changes' && (
            <ChangesView
              key={repoScopePath}
              isMobile={isMobile}
              projectPath={repoScopePath}
              gitStatus={gitStatus}
              gitDiff={gitDiff}
              isLoading={isLoading}
              wrapText={wrapText}
              isCreatingInitialCommit={isCreatingInitialCommit}
              onWrapTextChange={setWrapText}
              onCreateInitialCommit={createInitialCommit}
              onOpenFile={openFile}
              onDiscardFile={discardChanges}
              onDeleteFile={deleteUntrackedFile}
              onStageFiles={stageFiles}
              onUnstageFiles={unstageFiles}
              onCommitChanges={commitChanges}
              onRequestConfirmation={setConfirmAction}
              onExpandedFilesChange={setHasExpandedFiles}
            />
          )}

          {activeView === 'history' && (
            <HistoryView
              isMobile={isMobile}
              // Treat an in-flight commits request as loading only while the
              // list is empty, so "No commits found" never flashes before the
              // first response and refetches don't blank an existing list.
              isLoading={isLoading || (recentCommits.length === 0 && isLoadingCommits)}
              recentCommits={recentCommits}
              commitDiffs={commitDiffs}
              wrapText={wrapText}
              storageScope={repoScopePath}
              onFetchCommitDiff={fetchCommitDiff}
              onOpenFile={openFile}
            />
          )}

          {activeView === 'worktrees' && (
            <WorktreesView
              key={selectedProject.fullPath}
              isMobile={isMobile}
              selectedProject={selectedProject}
              localBranches={localBranches}
              onProjectSelect={onProjectSelect}
              onProjectsRefresh={onProjectsRefresh}
            />
          )}

          {activeView === 'branches' && (
            <BranchesView
              isMobile={isMobile}
              isLoading={isLoading}
              currentBranch={currentBranch}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              remoteStatus={remoteStatus}
              isCreatingBranch={isCreatingBranch}
              onSwitchBranch={switchBranch}
              onCreateBranch={createBranch}
              onDeleteBranch={deleteBranch}
              onRequestConfirmation={setConfirmAction}
            />
          )}
        </>
      )}

      <ConfirmActionModal
        action={confirmAction}
        onCancel={() => setConfirmAction(null)}
        onConfirm={(useAlternateConfirmation) => {
          void executeConfirmedAction(useAlternateConfirmation);
        }}
      />
    </div>
  );
}
