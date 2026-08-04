import { useEffect } from 'react';
import type { TFunction } from 'i18next';

import { APP_TITLE } from '../constants/config';
import { setBasePageTitle } from '../utils/pageTitleNotification';
import type { Project, ProjectSession } from '../types/app';

const TITLE_SEPARATOR = ' · ';

type UsePageTitleArgs = {
  project: Project | null;
  session: ProjectSession | null;
  t: TFunction;
};

/**
 * Names the browser tab after what it is showing: `<project> · <session>`.
 *
 * The session part is the short auto-generated `summary`, not the `recap` — a
 * recap is a sentence or two and would be truncated to nothing useful in a tab
 * strip. `APP_TITLE` only stands in when there is no project to name, since a
 * row of identical "VibeSpace" tabs is exactly what makes them unpickable.
 */
export function usePageTitle({ project, session, t }: UsePageTitleArgs): void {
  const projectName = project?.displayName?.trim();
  // Depend on the resolved string, not the session object: the object is
  // replaced on every poll, while its label changes only when the summary is
  // (re)generated.
  const sessionName = session
    ? (session.summary?.trim() || session.name?.trim() || t('projects.newSession'))
    : '';

  useEffect(() => {
    const parts = [projectName, sessionName].filter(Boolean);
    setBasePageTitle(parts.length > 0 ? parts.join(TITLE_SEPARATOR) : APP_TITLE);
  }, [projectName, sessionName]);
}
