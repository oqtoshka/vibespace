import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../utils/api';
import type { FileTreeNode } from '../file-tree/types/types';

type Policy = { root: string; rules: Array<{ path: string; hidden?: boolean; readOnly?: boolean; displayName?: string; description?: string }> };
type Preferences = { showHidden: boolean; hidden: string[] };
const eventName = 'workspace-appearance-changed';
const contains = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + '/');

/** Account-scoped local appearance preferences, independent of server-enforced protection. */
export function useWorkspaceAppearance() {
  const { user } = useAuth();
  const key = `workspace-appearance:${encodeURIComponent(user?.username || '')}`;
  const [revision, setRevision] = useState(0);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [policyError, setPolicyError] = useState(false);
  useEffect(() => {
    const changed = () => setRevision(value => value + 1);
    window.addEventListener(eventName, changed);
    window.addEventListener('storage', changed);
    return () => { window.removeEventListener(eventName, changed); window.removeEventListener('storage', changed); };
  }, []);
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const response = await api.get('/workspace-policy');
        if (!response.ok) throw new Error('Policy unavailable');
        const value = await response.json();
        if (active) { setPolicy(value); setPolicyError(false); }
      } catch { if (active) setPolicyError(true); }
    };
    void read();
    window.addEventListener('focus', read);
    return () => { active = false; window.removeEventListener('focus', read); };
  }, [key]);
  const preferences = useMemo<Preferences>(() => {
    // Revision invalidates browser-local state after either tab changes it.
    void revision;
    try {
      const value = JSON.parse(localStorage.getItem(key) || '{}');
      return { showHidden: value.showHidden === true, hidden: Array.isArray(value.hidden) ? value.hidden.filter((entry: unknown) => typeof entry === 'string') : [] };
    } catch { return { showHidden: false, hidden: [] }; }
  }, [key, revision]);
  const update = useCallback((change: (value: Preferences) => Preferences) => {
    localStorage.setItem(key, JSON.stringify(change(preferences)));
    window.dispatchEvent(new Event(eventName));
  }, [key, preferences]);
  const setShowHidden = useCallback((showHidden: boolean) => update(value => ({...value, showHidden})), [update]);
  const toggleHidden = useCallback((candidate: string) => update(value => ({ ...value, hidden: value.hidden.includes(candidate) ? value.hidden.filter(entry => entry !== candidate) : [...value.hidden, candidate] })), [update]);
  const decorate = useCallback((nodes: FileTreeNode[]): FileTreeNode[] => {
    const walk = (entries: FileTreeNode[]): FileTreeNode[] => entries.flatMap(node => {
      const rules = policy?.rules.map(rule => ({...rule, fullPath: `${policy.root.replace(/\/$/, '')}/${rule.path}`})) || [];
      const ancestors = rules.filter(rule => contains(rule.fullPath, node.path));
      const exact = ancestors.find(rule => rule.fullPath === node.path);
      const userHidden = preferences.hidden.some(entry => contains(entry, node.path));
      const hidden = userHidden || ancestors.some(rule => rule.hidden);
      if (hidden && !preferences.showHidden) return [];
      return [{ ...node,
        displayName: exact?.displayName,
        policyDescription: exact?.description,
        managedReadOnly: policyError || ancestors.some(rule => rule.readOnly),
        protectedDescendants: rules.some(rule => rule.readOnly && contains(node.path, rule.fullPath)),
        hiddenInWorkspace: hidden,
        userHidden: preferences.hidden.includes(node.path),
        ...(node.children ? {children: walk(node.children)} : {}),
      }];
    });
    return walk(nodes);
  }, [policy, preferences, policyError]);
  return { showHidden: preferences.showHidden, setShowHidden, toggleHidden, decorate, policyError };
}
