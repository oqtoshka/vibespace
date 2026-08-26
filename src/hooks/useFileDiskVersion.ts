import { useCallback, useState } from 'react';

import { useFileChangeSignal } from './useFileChangeSignal';

/**
 * Returns a counter that increments whenever `filePath` is (re)written on disk.
 * Viewers that fetch the file's bytes themselves (blob-based image/PDF views,
 * the HTML preview iframe) include it in their load effect's deps to re-fetch
 * on external changes — text buffers instead live-reload through
 * `useCodeEditorDocument`, which owns the unsaved-edits guard these byte
 * viewers don't need. Both ride on `useFileChangeSignal`, so a file under an
 * ignored build dir or an additional root refreshes just the same.
 */
export function useFileDiskVersion(projectId: string | undefined, filePath: string | null | undefined): number {
  const [version, setVersion] = useState(0);

  const handleChange = useCallback((type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir') => {
    if (type === 'change' || type === 'add') {
      setVersion((previous) => previous + 1);
    }
  }, []);

  useFileChangeSignal(projectId, filePath, handleChange);

  return version;
}
