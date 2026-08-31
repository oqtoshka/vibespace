export type FlatFileTreeEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory';
};

const normalize = (value: string): string => value.replace(/\\/g, '/');

/** Finds the file-tree entry represented by a bare, partial, or absolute path reference. */
export function resolveFileTreeReference(
  entries: FlatFileTreeEntry[],
  ref: string,
): FlatFileTreeEntry | null {
  const target = normalize(ref).replace(/^\.\//, '').replace(/^\/+/, '');
  if (!target) {
    return null;
  }

  const suffixMatch = entries.find((entry) => {
    const entryPath = normalize(entry.path);
    return entryPath === target || entryPath.endsWith(`/${target}`);
  });
  if (suffixMatch) {
    return suffixMatch;
  }

  const base = target.split('/').pop() || target;
  return entries.find((entry) => entry.name === base) ?? null;
}
