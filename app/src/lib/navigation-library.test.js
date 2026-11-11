import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, letterIcon } from './model.js';
import { localData } from './local-data.js';
import { commitNavigationTags, commitNavigationTransfer } from './navigation-library.js';

function setup(t) {
  const navKey = 'owntab.local.v1', prefsKey = 'covelet.content.preferences.v1';
  const state = createEmptyState(); state.settings.pages = [0, 1];
  state.entries = [
    { id: 'folder-a', type: 'folder', name: 'Source', groupId: 'group-home', parentId: null, page: 0, order: 0, icon: letterIcon('S') },
    { id: 'folder-b', type: 'folder', name: 'Destination', groupId: 'group-home', parentId: null, page: 1, order: 1, icon: letterIcon('D') },
    { id: 'child', type: 'site', name: 'Child', groupId: 'group-home', parentId: 'folder-a', page: 0, order: 0, url: 'https://example.test/child', icon: letterIcon('C') },
    { id: 'root', type: 'site', name: 'Root', groupId: 'group-home', parentId: null, page: 0, order: 2, url: 'https://example.test/root', icon: letterIcon('R') },
  ];
  const records = {
    [navKey]: { version: 1, state, snapshots: [structuredClone(state)] },
    [prefsKey]: { version: 1, revision: 2, aliases: {}, presentation: false, privateKeys: ['folder:folder-a'],
      library: { version: 1, tags: [{ id: 'tag-a', name: 'Alpha' }, { id: 'tag-b', name: 'Beta' }], items: {
        'site:child': { description: 'Private child reason', tagIds: ['tag-a'] },
        'site:root': { description: 'Keep description', tagIds: ['tag-b'] },
      } } },
  };
  const held = [], original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { async request(key, options, run) {
    held.push(key); try { return await (run || options)(); } finally { assert.equal(held.pop(), key); }
  } } } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', original));
  t.mock.method(localData, 'get', async (key) => structuredClone({ [key]: records[key] }));
  let failWrite = false;
  const writes = t.mock.method(localData, 'set', async (patch) => {
    assert.deepEqual(held, ['owntab.local.write.v1', prefsKey]);
    if (failWrite) throw Error('synthetic storage failure');
    Object.assign(records, structuredClone(patch));
  });
  const options = () => ({ expectedNavigationRevision: records[navKey].state.revision, expectedPreferencesRevision: records[prefsKey].revision });
  return { records, navKey, prefsKey, writes, options, fail() { failWrite = true; } };
}

test('list moves folder children without dissolving the source, preserving metadata and inherited privacy', async (t) => {
  const h = setup(t);
  const result = await commitNavigationTransfer({ ids: ['child'], operation: 'move', destinationValue: 'page:1', ...h.options() });
  assert.equal(result.state.entries.find((item) => item.id === 'child').parentId, null);
  assert.equal(result.state.entries.find((item) => item.id === 'child').page, 1);
  assert(result.state.entries.some((item) => item.id === 'folder-a'));
  assert(h.records[h.prefsKey].privateKeys.includes('site:child'));
  assert.equal(h.records[h.prefsKey].library.items['site:child'].description, 'Private child reason');
  assert.equal(h.writes.mock.callCount(), 1);
});

test('list copies retain source and independent metadata in the same write', async (t) => {
  const h = setup(t);
  const result = await commitNavigationTransfer({ ids: ['child'], operation: 'copy', destinationValue: 'folder:folder-b', ...h.options() });
  const [id] = result.ids;
  assert.notEqual(id, 'child');
  assert.equal(result.state.entries.find((item) => item.id === 'child').parentId, 'folder-a');
  assert.equal(result.state.entries.find((item) => item.id === id).parentId, 'folder-b');
  assert.deepEqual(h.records[h.prefsKey].library.items[`site:${id}`], h.records[h.prefsKey].library.items['site:child']);
  assert(h.records[h.prefsKey].privateKeys.includes(`site:${id}`));
  h.records[h.prefsKey].library.items[`site:${id}`].tagIds.push('tag-b');
  assert.deepEqual(h.records[h.prefsKey].library.items['site:child'].tagIds, ['tag-a']);
});

test('batch tags preserve descriptions, unrelated labels and navigation history', async (t) => {
  const h = setup(t), originalNavigation = structuredClone(h.records[h.navKey]);
  let expectedMetadata = { 'site:root': structuredClone(h.records[h.prefsKey].library.items['site:root']) };
  await commitNavigationTags({ ids: ['root'], operation: 'add', tagIds: ['tag-a'], expectedMetadata, ...h.options() });
  assert.deepEqual(h.records[h.prefsKey].library.items['site:root'], { description: 'Keep description', tagIds: ['tag-b', 'tag-a'] });
  assert.deepEqual(h.records[h.navKey], originalNavigation);
  expectedMetadata = { 'site:root': structuredClone(h.records[h.prefsKey].library.items['site:root']) };
  await commitNavigationTags({ ids: ['root'], operation: 'remove', tagIds: ['tag-b'], expectedMetadata, ...h.options() });
  assert.deepEqual(h.records[h.prefsKey].library.items['site:root'], { description: 'Keep description', tagIds: ['tag-a'] });
  assert.deepEqual(h.records[h.navKey], originalNavigation);
});

test('locked inherited sources, hidden targets and stale revisions never partially transfer', async (t) => {
  const h = setup(t); h.records[h.prefsKey].presentation = true;
  await assert.rejects(commitNavigationTransfer({ ids: ['child'], operation: 'move', destinationValue: 'page:1', ...h.options() }), { code: 'PRIVACY_LOCKED' });
  await assert.rejects(commitNavigationTransfer({ ids: ['root'], operation: 'copy', destinationValue: 'folder:folder-a', ...h.options() }), { code: 'TARGET_CHANGED' });
  await assert.rejects(commitNavigationTransfer({ ids: ['root'], operation: 'copy', destinationValue: 'page:1', expectedNavigationRevision: 9, expectedPreferencesRevision: 2 }), { code: 'REVISION_CONFLICT' });
  assert.equal(h.writes.mock.callCount(), 0);
});

test('stale per-item baselines and storage failure preserve every selected item', async (t) => {
  const h = setup(t), before = structuredClone(h.records);
  await assert.rejects(commitNavigationTags({ ids: ['root'], operation: 'add', tagIds: ['tag-a'], expectedMetadata: { 'site:root': { description: 'stale', tagIds: ['tag-b'] } }, ...h.options() }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(h.records, before);
  h.fail();
  await assert.rejects(commitNavigationTransfer({ ids: ['child'], operation: 'copy', destinationValue: 'page:1', ...h.options() }), /synthetic storage failure/);
  assert.deepEqual(h.records, before);
});
