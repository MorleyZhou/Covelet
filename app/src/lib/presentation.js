import { createContext, useContext, useMemo } from 'react';
import { navigationResourceEntries } from './navigation-resources.js';

export const PresentationContext = createContext({ active: false, hiddenKeys: new Set(), requestUnlock: () => {} });
export function usePresentedTools(data) {
  const { active, hiddenKeys } = useContext(PresentationContext);
  return useMemo(() => !active || !data ? data : { ...data,
    notes: data.notes.filter((item) => !hiddenKeys.has(`note:${item.id}`)),
    reading: data.reading.filter((item) => !hiddenKeys.has(`reading:${item.id}`)),
    trash: (data.trash || []).filter((item) => ['notes', 'reading'].includes(item.kind) && !hiddenKeys.has(`${item.kind === 'notes' ? 'note' : 'reading'}:${item.record.id}`)),
  }, [data, active, hiddenKeys]);
}

export function privateContentKeys(navigation, preferences) {
  const keys = new Set(preferences.privateKeys || []);
  for (const entry of navigationResourceEntries(navigation)) {
    if (entry.parentId && keys.has(`folder:${entry.parentId}`)) keys.add(`site:${entry.id}`);
  }
  return keys;
}
