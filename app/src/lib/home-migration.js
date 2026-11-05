import { localData } from './local-data.js';
import { retirePristineInitialSites } from './model.js';
import { sameJson } from './json-equal.js';

export const HOME_MIGRATION_KEY = 'covelet.home-migration.v1';
const NAVIGATION = 'owntab.local.v1', PREFERENCES = 'covelet.content.preferences.v1';
const DOMAIN_LOCKS = ['covelet.complete-recovery.v1', 'owntab.local.write.v1', PREFERENCES];

// Runs once per device, before the UI reads navigation. The marker and updated
// envelope are committed together under the existing domain/persistence locks.
// Retain the prior navigation as a normal local snapshot, including all clocks.
export async function migrateHomeStartup({ data = localData, locks = globalThis.navigator?.locks } = {}) {
  if (!locks?.request && globalThis.chrome?.runtime?.id) return false;
  let applied = false;
  const run = () => data.updateMany([HOME_MIGRATION_KEY, NAVIGATION, PREFERENCES], (values) => {
    if (values[HOME_MIGRATION_KEY]?.version === 1) return {};
    const envelope = values[NAVIGATION], writes = { [HOME_MIGRATION_KEY]: { version: 1 } };
    if (envelope) {
      if (envelope.version !== 1 || !Array.isArray(envelope.snapshots) || envelope.snapshots.length > 3) {
        throw Object.assign(Error('Local navigation cannot be migrated safely.'), { code: 'LOCAL_DATA_MIGRATION_FAILED' });
      }
      const preferences = values[PREFERENCES], protectedIds = new Set();
      if (preferences) {
        // Unknown preference shapes cannot justify deleting an apparent seed.
        if (!preferences.aliases || typeof preferences.aliases !== 'object' || Array.isArray(preferences.aliases)
          || !Array.isArray(preferences.privateKeys)) {
          for (const entry of envelope.state.entries) protectedIds.add(entry.id);
        } else {
          for (const key of [...Object.keys(preferences.aliases), ...preferences.privateKeys]) {
            if (typeof key === 'string' && key.startsWith('site:')) protectedIds.add(key.slice(5));
          }
        }
      }
      const state = retirePristineInitialSites(envelope.state, { protectedIds });
      if (!sameJson(state, envelope.state)) {
        if (state.revision >= Number.MAX_SAFE_INTEGER) throw Object.assign(Error('Navigation revision is exhausted.'), { code: 'LOCAL_DATA_MIGRATION_CONFLICT' });
        state.revision++;
        writes[NAVIGATION] = { ...envelope, state, snapshots: [structuredClone(envelope.state), ...envelope.snapshots].slice(0, 3) };
      }
    }
    applied = true;
    return { writes };
  });
  const acquire = (index) => locks?.request && index < DOMAIN_LOCKS.length
    ? locks.request(DOMAIN_LOCKS[index], { mode: 'exclusive' }, () => acquire(index + 1)) : run();
  await acquire(0);
  return applied;
}
