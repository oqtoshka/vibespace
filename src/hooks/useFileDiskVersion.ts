import { useCallback, useState } from 'react';
import { useProjectFilesWatch, type FileChange } from './useProjectFilesWatch';

/**
 * Returns a counter that increments whenever `filePath` is (re)written on disk,
 * per the project files watcher. Viewers that fetch the file's bytes themselves
 * (blob-based image/PDF views, the HTML preview iframe) include it in their
 * load effect's deps to re-fetch on external changes — text buffers instead
 * live-reload through `useCodeEditorDocument`, which owns the unsaved-edits
 * guard these byte viewers don't need.
 */
export function useFileDiskVersion(projectId: string | undefined, filePath: string | null | undefined): number {
  const [version, setVersion] = useState(0);

  const handleChanges = useCallback(
    (changes: FileChange[]) => {
      if (!filePath) {
        return;
      }
      const touched = changes.some(
        (change) => change.path === filePath && (change.type === 'change' || change.type === 'add'),
      );
      if (touched) {
        setVersion((previous) => previous + 1);
      }
    },
    [filePath],
  );

  useProjectFilesWatch(projectId, handleChanges);

  return version;
}
