import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateHomeStartup, HOME_MIGRATION_KEY } from './home-migration.js';
import { createLegacySeedNavigation } from '../../tests/fixtures/navigation-state.mjs';
import { isSyncRecord } from './sync-data-rules.js';

const NAVIGATION = 'owntab.local.v1', PREFERENCES = 'covelet.content.preferences.v1';
function harness(values = {}) {
  let saved = structuredClone(values), rejected = false;
  const locks = [];
  return {
    get values() { return structuredClone(saved); },
    set rejected(value) { rejected = value; },
    locks: { async request(name, options, run) { locks.push(name); return run(); } },
    get lockNames() { return locks; },
    data: { async updateMany(keys, update) {
      const result = update(Object.fromEntries(keys.filter(key => key in saved).map(key => [key, structuredClone(saved[key])])));
      if (rejected) throw Error('synthetic atomic commit failure');
      assert.deepEqual(result.removals || [], []);
      saved = { ...saved, ...structuredClone(result.writes || {}) };
    } },
  };
}

test('startup retirement is atomic, protects alias/private markers, retains runtime data and a recovery snapshot, and runs once', async () => {
  const state = createLegacySeedNavigation(), runtime = { timer: { running: true, startedAt: 123 }, private: 'retained' };
  const value = harness({ [NAVIGATION]: { version: 1, state, snapshots: [], sync: { legacy: 'preserved' } },
    [PREFERENCES]: { version: 1, aliases: { 'site:default-google': 'personal search alias' }, privateKeys: ['site:default-github'] },
    'covelet.clock.v1.old-clock': runtime });
  value.rejected = true;
  await assert.rejects(migrateHomeStartup(value), /synthetic/);
  assert.equal(value.values[HOME_MIGRATION_KEY], undefined);
  assert.deepEqual(value.values[NAVIGATION].state, state);
  value.rejected = false;
  assert.equal(await migrateHomeStartup(value), true);
  assert.deepEqual(value.values[NAVIGATION].state.entries.map(entry => entry.id), ['default-google', 'default-github']);
  assert.equal(value.values[NAVIGATION].state.revision, state.revision + 1);
  assert.deepEqual(value.values[NAVIGATION].snapshots[0], state);
  assert.deepEqual(value.values[NAVIGATION].sync, { legacy: 'preserved' });
  assert.deepEqual(value.values['covelet.clock.v1.old-clock'], runtime);
  const once = value.values;
  assert.equal(await migrateHomeStartup(value), false);
  assert.deepEqual(value.values, once);
  assert.deepEqual(value.lockNames.slice(0, 3), ['covelet.complete-recovery.v1', 'owntab.local.write.v1', PREFERENCES]);
  assert.equal(isSyncRecord('preferences', HOME_MIGRATION_KEY), false, 'the one-time device marker must never travel through portable sync');
});

test('new installs get only a device marker and unknown privacy metadata never justifies deleting a site', async () => {
  const fresh = harness(); await migrateHomeStartup(fresh);
  assert.deepEqual(Object.keys(fresh.values), [HOME_MIGRATION_KEY]);
  const state = createLegacySeedNavigation(), cautious = harness({ [NAVIGATION]: { version: 1, state, snapshots: [] }, [PREFERENCES]: { version: 999 } });
  await migrateHomeStartup(cautious);
  assert.deepEqual(cautious.values[NAVIGATION].state, state);
  assert.deepEqual(cautious.values[HOME_MIGRATION_KEY], { version: 1 });
});
