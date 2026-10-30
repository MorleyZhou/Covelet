import { useSyncExternalStore } from 'react';
import { syncDataStore } from './local-data.js';

let revision = 0;
const listeners = new Set();
// Imports can replace image bytes without changing their URL or a widget's
// configuration. Publish only a revision; content stays in encrypted storage.
syncDataStore.subscribe(({ source }) => {
  if (source !== 'sync') return;
  revision++;
  for (const listener of listeners) { try { listener(); } catch { /* Other mounted consumers must still refresh. */ } }
});

export const subscribeSyncedData = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export const getSyncedDataRevision = () => revision;
export const useSyncedDataRevision = () => useSyncExternalStore(subscribeSyncedData, getSyncedDataRevision, getSyncedDataRevision);
export const useSyncedData = useSyncedDataRevision;
