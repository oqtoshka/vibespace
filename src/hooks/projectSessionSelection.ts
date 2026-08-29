import type { LLMProvider, ProjectSession } from '../types/app';

const serialize = (value: unknown) => JSON.stringify(value ?? null);

/**
 * Reconciles the independently stored active-session snapshot with its latest
 * project-list row. Session metadata changes (notably generated titles and
 * recaps) must replace the snapshot even when the session id/provider did not
 * change; otherwise the sidebar updates while the open pane stays stale.
 */
export const reconcileSelectedSession = (
  selectedSession: ProjectSession | null,
  projectSession: ProjectSession,
  provider: LLMProvider,
): ProjectSession => {
  const normalizedSession = projectSession.__provider === provider
    ? projectSession
    : { ...projectSession, __provider: provider };

  return serialize(normalizedSession) === serialize(selectedSession)
    ? (selectedSession ?? normalizedSession)
    : normalizedSession;
};
