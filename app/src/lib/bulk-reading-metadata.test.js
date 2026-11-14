import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkReadingItems } from './personal-tools.js';
import { createEmptyState, letterIcon } from './model.js';
import { localData } from './local-data.js';

const navigationKey = 'owntab.local.v1', preferencesKey = 'covelet.content.preferences.v1', toolsKey = 'covelet.tools.v1';
const reading = (id, patch = {}) => ({ id, revision: 1, createdAt: 10, updatedAt: 20, title: id,
  url: `https://example.com/${id}`, status: 'unread', ...patch });
const metadata = (tagIds = [], description = '') => ({ description, tagIds });
const tag = (id) => ({ id, name: id });

function setup(t, { tags = ['old', 'new'], items = {}, readingItems = [reading('a'), reading('b')],
  beforeNavigation, failWrite = false } = {}) {
  const records = {
    [navigationKey]: { version: 1, state: createEmptyState(), snapshots: [] },
    [preferencesKey]: { version: 1, revision: 4, aliases: {}, privateKeys: [], presentation: false,
      library: { version: 1, tags: tags.map(tag), items } },
    [toolsKey]: { version: 3, revision: 5, notes: [], reading: readingItems, snapshots: [], trash: [] },
  };
  const held = [], calls = [], descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    async request(name, options, callback) {
      if (name === 'owntab.local.write.v1') await beforeNavigation?.(records);
      held.push(name); calls.push(name);
      try { return await (callback || options)(); }
      finally { assert.equal(held.pop(), name); }
    },
  } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'navigator', descriptor) : delete globalThis.navigator);
  t.mock.method(localData, 'get', async (key) => structuredClone({ [key]: records[key] }));
  const writes = t.mock.method(localData, 'set', async (patch) => {
    assert.deepEqual(held, ['owntab.local.write.v1', preferencesKey, toolsKey]);
    if (failWrite) throw Error('synthetic quota exceeded');
    Object.assign(records, structuredClone(patch));
  });
  const options = (ids = ['a', 'b']) => ({ expectedRevision: records[toolsKey].revision,
    expectedPreferencesRevision: records[preferencesKey].revision,
    expectedRecordRevisions: Object.fromEntries(ids.map((id) => [id, records[toolsKey].reading.find((item) => item.id === id).revision])),
    expectedMetadata: Object.fromEntries(ids.map((id) => [`reading:${id}`, structuredClone(records[preferencesKey].library.items[`reading:${id}`] || metadata())])),
  });
  return { records, writes, calls, options };
}

test('tag union commits tools and metadata together and bumps only the changed record', async (t) => {
  const { records, writes, options } = setup(t, { items: { 'reading:a': metadata(['old'], 'keep description'), 'reading:b': metadata(['new'], 'second') },
    readingItems: [reading('a', { status: 'read', revisitOn: '2026-11-19' }), reading('b')] });
  const before = structuredClone(records);
  assert.deepEqual(await bulkReadingItems(['a', 'b'], 'tags', { ...options(), operation: 'add', tagIds: ['new'] }), { count: 1, ids: ['a'] });
  assert.equal(writes.mock.callCount(), 1);
  assert.deepEqual(Object.keys(writes.mock.calls[0].arguments[0]), [toolsKey, preferencesKey]);
  assert.equal(records[toolsKey].revision, 6); assert.equal(records[preferencesKey].revision, 5);
  assert.deepEqual(records[preferencesKey].library.items['reading:a'], metadata(['old', 'new'], 'keep description'));
  assert.deepEqual(records[toolsKey].reading[0], { ...before[toolsKey].reading[0], revision: 2, updatedAt: records[toolsKey].reading[0].updatedAt });
  assert(records[toolsKey].reading[0].updatedAt > 20);
  assert.deepEqual(records[toolsKey].reading[1], before[toolsKey].reading[1]);
  assert.deepEqual(records[navigationKey], before[navigationKey]);
  assert.deepEqual(records[preferencesKey].library.tags, before[preferencesKey].library.tags);
});

test('tag removal preserves descriptions and a no-op neither writes nor prunes expired trash', async (t) => {
  const { records, writes, options } = setup(t, { items: { 'reading:a': metadata(['old', 'new'], 'retained') } });
  assert.deepEqual(await bulkReadingItems(['a', 'b'], 'tags', { ...options(), operation: 'remove', tagIds: ['new'] }), { count: 1, ids: ['a'] });
  assert.deepEqual(records[preferencesKey].library.items['reading:a'], metadata(['old'], 'retained'));
  records[toolsKey].trash = [{ id: 'expired', kind: 'reading', deletedAt: Date.now() - 31 * 86400000, record: reading('old-trash') }];
  const before = structuredClone(records), baseline = options();
  assert.deepEqual(await bulkReadingItems(['a', 'b'], 'tags', { ...baseline, operation: 'remove', tagIds: ['new'] }), { count: 0, ids: [] });
  assert.deepEqual(records, before); assert.equal(writes.mock.callCount(), 1);
  baseline.expectedMetadata['reading:a'].description = 'stale';
  await assert.rejects(bulkReadingItems(['a', 'b'], 'tags', { ...baseline, operation: 'remove', tagIds: ['new'] }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(records, before); assert.equal(writes.mock.callCount(), 1);
});

test('revisit sets and clears only dates, preserving status and all metadata', async (t) => {
  const { records, writes, options } = setup(t, { items: { 'reading:a': metadata(['old'], 'keep') },
    readingItems: [reading('a', { status: 'archived', revisitOn: '2026-11-19' }), reading('b', { status: 'read' })] });
  const originalPreferences = structuredClone(records[preferencesKey]);
  assert.deepEqual(await bulkReadingItems(['a', 'b'], 'revisit', { ...options(), revisitOn: '2026-11-19' }), { count: 1, ids: ['b'] });
  assert.equal(records[toolsKey].reading[0].revision, 1); assert.equal(records[toolsKey].reading[1].revision, 2);
  assert.deepEqual(records[toolsKey].reading.map((item) => item.status), ['archived', 'read']);
  assert.deepEqual(records[preferencesKey], originalPreferences);
  assert.deepEqual(Object.keys(writes.mock.calls[0].arguments[0]), [toolsKey]);
  assert.deepEqual(await bulkReadingItems(['a', 'b'], 'revisit', { ...options(), revisitOn: null }), { count: 2, ids: ['a', 'b'] });
  assert(records[toolsKey].reading.every((item) => !Object.hasOwn(item, 'revisitOn')));
  const before = structuredClone(records);
  assert.deepEqual(await bulkReadingItems(['a', 'b'], 'revisit', { ...options(), revisitOn: null }), { count: 0, ids: [] });
  assert.deepEqual(records, before); assert.equal(writes.mock.callCount(), 2);
});

test('all revision and metadata baselines, missing records and hidden records reject the complete batch', async (t) => {
  const { records, writes, options } = setup(t, { items: { 'reading:a': metadata(['old'], 'kept') } });
  const baseline = options(), before = structuredClone(records);
  for (const patch of [
    { expectedRevision: 0 }, { expectedPreferencesRevision: 0 }, { expectedPreferencesRevision: undefined },
    { expectedRecordRevisions: { a: 1, b: 9 } }, { expectedMetadata: { 'reading:a': metadata(), 'reading:b': metadata() } },
    { expectedMetadata: { 'reading:a': metadata(['old'], 'kept') } },
  ]) await assert.rejects(bulkReadingItems(['a', 'b'], 'tags', { ...baseline, operation: 'add', tagIds: ['new'], ...patch }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(records, before);
  records[toolsKey].reading.pop();
  const removed = structuredClone(records);
  await assert.rejects(bulkReadingItems(['a', 'b'], 'revisit', { ...baseline, revisitOn: '2026-11-19' }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(records, removed);
  records[toolsKey] = before[toolsKey]; records[preferencesKey].presentation = true; records[preferencesKey].privateKeys = ['reading:b'];
  const hidden = structuredClone(records);
  await assert.rejects(bulkReadingItems(['a', 'b'], 'tags', { ...baseline, operation: 'add', tagIds: ['new'] }), { code: 'PRIVACY_LOCKED' });
  await assert.rejects(bulkReadingItems(['a', 'b'], 'revisit', { ...baseline, revisitOn: null }), { code: 'PRIVACY_LOCKED' });
  assert.deepEqual(records, hidden); assert.equal(writes.mock.callCount(), 0);
});

test('a tag moved into a hidden navigation folder cannot be used from a stale visible-tag snapshot', async (t) => {
  const { records, writes, options, calls } = setup(t, { tags: ['secret'], items: { 'site:source': metadata(['secret']) },
    beforeNavigation(current) { Object.assign(current[navigationKey].state.entries.find((item) => item.id === 'source'), { parentId: 'private-folder', order: 0 }); } });
  records[preferencesKey].presentation = true; records[preferencesKey].privateKeys = ['folder:private-folder'];
  records[navigationKey].state.entries = [
    { id: 'private-folder', type: 'folder', name: 'Private', groupId: 'group-home', parentId: null, page: 0, order: 0, icon: letterIcon('P') },
    { id: 'source', type: 'site', name: 'Source', url: 'https://example.com/source', groupId: 'group-home', parentId: null, page: 0, order: 1, icon: letterIcon('S') },
  ];
  const beforeTools = structuredClone(records[toolsKey]), beforePreferences = structuredClone(records[preferencesKey]);
  await assert.rejects(bulkReadingItems(['a', 'b'], 'tags', { ...options(), operation: 'add', tagIds: ['secret'] }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(calls, ['owntab.local.write.v1', preferencesKey, toolsKey]);
  assert.deepEqual(records[toolsKey], beforeTools); assert.deepEqual(records[preferencesKey], beforePreferences); assert.equal(writes.mock.callCount(), 0);
});

test('tag limits, removed tags and invalid dates never leave partial metadata or record writes', async (t) => {
  const tags = Array.from({ length: 21 }, (_, index) => `tag-${index}`);
  const { records, writes, options } = setup(t, { tags, items: { 'reading:a': metadata(tags.slice(0, 20)), 'reading:b': metadata(['tag-20']) } });
  const before = structuredClone(records);
  await assert.rejects(bulkReadingItems(['a', 'b'], 'tags', { ...options(), operation: 'add', tagIds: ['tag-20'] }), /备注和标签无效/);
  for (const tagIds of [['removed'], ['tag-0', 'tag-0'], []]) {
    await assert.rejects(bulkReadingItems(['a', 'b'], 'tags', { ...options(), operation: 'remove', tagIds }), { code: 'REVISION_CONFLICT' });
  }
  for (const revisitOn of [undefined, '', '2026-02-29', '2026-11-19T00:00:00Z']) {
    await assert.rejects(bulkReadingItems(['a', 'b'], 'revisit', { ...options(), revisitOn }), { code: 'READING_REVISIT' });
  }
  assert.deepEqual(records, before); assert.equal(writes.mock.callCount(), 0);
});

test('quota failure preserves both records and preferences', async (t) => {
  const { records, writes, options } = setup(t, { failWrite: true });
  const before = structuredClone(records);
  await assert.rejects(bulkReadingItems(['a', 'b'], 'tags', { ...options(), operation: 'add', tagIds: ['new'] }), /存储空间已满/);
  assert.deepEqual(records, before); assert.equal(writes.mock.callCount(), 1);
});

test('caller mutation while waiting for navigation cannot replace the IDs, tags or baselines being committed', async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { records, options } = setup(t, { beforeNavigation: () => waiting });
  const ids = ['a'], input = { ...options(ids), operation: 'add', tagIds: ['new'] };
  const saving = bulkReadingItems(ids, 'tags', input);
  ids[0] = 'b'; input.tagIds[0] = 'missing'; input.expectedRecordRevisions.a = 9;
  input.expectedMetadata['reading:a'].description = 'changed'; input.expectedPreferencesRevision = 99;
  release();
  assert.deepEqual(await saving, { count: 1, ids: ['a'] });
  assert.deepEqual(records[preferencesKey].library.items['reading:a'], metadata(['new']));
  assert.equal(records[toolsKey].reading[0].revision, 2); assert.equal(records[toolsKey].reading[1].revision, 1);
});
