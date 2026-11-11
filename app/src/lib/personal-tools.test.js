import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONAL_TRASH_LIMITS, validatePersonalTools, loadPersonalTools, replacePersonalTools, mergePersonalTools,
  deletePersonalRecord, restoreTrashedPersonalRecord, permanentlyDeletePersonalTrash, emptyPersonalTrash,
  applySyncedPersonalTools, exportPersonalTools, importPersonalTools, saveReadingItem,
} from './personal-tools.js';
import { createContentTag, getContentMetadata, loadContentPreferences, saveContentMetadata, saveContentSettings, saveSavedView } from './content-preferences.js';
import { localData } from './local-data.js';

const key = 'covelet.tools.v1', values = new Map();
const now = Date.now();
const note = (id = 'note-a', body = 'saved body', revision = 1) => ({ id, title: id, body, revision, pinned: false, createdAt: now - 1000, updatedAt: now - 500 });
const reading = (id = 'reading-a', url = 'https://example.com/a') => ({ id, title: id, url, status: 'unread', revision: 1, createdAt: now - 1000, updatedAt: now - 500 });
const snapshot = () => ({ id: 'snapshot-a', title: 'Saved tabs', revision: 1, createdAt: now - 1000, updatedAt: now - 500, tabs: [{ url: 'https://example.com/', title: 'Example', pinned: true }] });
const state = (patch = {}) => ({ version: 3, revision: 0, notes: [], reading: [], snapshots: [], trash: [], ...patch });
function installLocks(t) {
  const originalNavigator = globalThis.navigator, queues = new Map(), lockOrder = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    request(name, options, callback) {
      const action = callback || options; lockOrder.push(name);
      const next = (queues.get(name) || Promise.resolve()).then(action); queues.set(name, next.catch(() => {})); return next;
    },
  } } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator }));
  return lockOrder;
}
beforeEach((t) => {
  values.clear();
  t.mock.method(localData, 'get', async (requested) => {
    const keys = requested == null ? [...values.keys()] : Array.isArray(requested) ? requested : [requested];
    return Object.fromEntries(keys.filter((name) => values.has(name)).map((name) => [name, JSON.parse(values.get(name))]));
  });
  t.mock.method(localData, 'set', async (patch) => {
    const serialized = Object.entries(patch).map(([name, value]) => [name, JSON.stringify(value)]);
    for (const [name, value] of serialized) values.set(name, value);
  });
  t.mock.method(localData, 'remove', async (requested) => {
    for (const name of Array.isArray(requested) ? requested : [requested]) values.delete(name);
  });
});

test('new content and its metadata commit atomically and stale metadata never changes either record', async (t) => {
  const lockOrder = installLocks(t);
  const tag = await createContentTag('reading tag');
  let preferences = await loadContentPreferences(), writes = [];
  t.mock.method(localData, 'set', async (patch) => {
    writes.push(Object.keys(patch));
    const serialized = Object.entries(patch).map(([name, value]) => [name, JSON.stringify(value)]);
    for (const [name, value] of serialized) values.set(name, value);
  });
  const saved = await saveReadingItem({ title: 'Article', url: 'https://example.com/article' }, {
    metadata: { description: 'for next release', tagIds: [tag.id] }, expectedPreferencesRevision: preferences.revision,
  });
  assert.deepEqual(writes, [[key, 'covelet.content.preferences.v1']]);
  assert.deepEqual(lockOrder.slice(-2), ['covelet.content.preferences.v1', key]);
  preferences = await loadContentPreferences();
  assert.deepEqual(getContentMetadata(preferences, `reading:${saved.id}`), { description: 'for next release', tagIds: [tag.id] });
  const baseline = getContentMetadata(preferences, `reading:${saved.id}`);
  await saveContentMetadata(`reading:${saved.id}`, { description: 'other editor' });
  await createContentTag('unrelated tag');
  preferences = await loadContentPreferences();
  const before = new Map(values);
  await assert.rejects(saveReadingItem({ ...saved, title: 'stale title' }, {
    metadata: baseline, expectedPreferencesRevision: preferences.revision, expectedMetadata: baseline,
  }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(values, before);
  t.mock.method(localData, 'set', async () => { throw Error('synthetic failed commit'); });
  await assert.rejects(saveReadingItem({ title: 'Failed', url: 'https://example.com/failed' }, { metadata: { description: 'atomic', tagIds: [] } }), /未能保存/);
  assert.deepEqual(values, before);
});

test('tools export v4 carries scoped metadata and imports it atomically without replacing duplicates', async (t) => {
  installLocks(t);
  await replacePersonalTools(state({ notes: [note()], reading: [reading()] }));
  const tag = await createContentTag('Work');
  await saveContentMetadata('note:note-a', { tagIds: [tag.id] });
  await saveContentMetadata('reading:reading-a', { description: 'read for release', tagIds: [tag.id] });
  await saveContentSettings('note:note-a', { alias: 'project', private: true });
  await saveContentMetadata('site:unrelated', { description: 'navigation-only secret', tagIds: [tag.id] });
  await saveSavedView({ name: 'Private view' }, { private: true });
  const file = await exportPersonalTools(), envelope = JSON.parse(await file.text());
  assert.equal(envelope.version, 4); assert.equal(envelope.data.version, 3);
  assert.deepEqual(Object.keys(envelope.preferences.library.items).sort(), ['note:note-a', 'reading:reading-a']);
  assert(!JSON.stringify(envelope).includes('navigation-only secret'));
  assert(!JSON.stringify(envelope).includes('Private view')); assert.equal(Object.hasOwn(envelope.preferences.library, 'views'), false);
  values.clear();
  const localTag = await createContentTag('work'), localView = await saveSavedView({ name: 'Existing local view' }, { private: true }), writes = [];
  t.mock.method(localData, 'set', async (patch) => {
    writes.push(Object.keys(patch));
    const serialized = Object.entries(patch).map(([name, value]) => [name, JSON.stringify(value)]);
    for (const [name, value] of serialized) values.set(name, value);
  });
  assert.equal(await importPersonalTools(file), 2);
  assert.deepEqual(writes, [[key, 'covelet.content.preferences.v1']]);
  let preferences = await loadContentPreferences();
  assert.deepEqual(getContentMetadata(preferences, 'reading:reading-a'), { description: 'read for release', tagIds: [localTag.id] });
  assert.deepEqual(preferences.privateKeys, [`view:${localView.id}`, 'note:note-a']); assert.equal(preferences.aliases['note:note-a'], 'project');
  assert.deepEqual(preferences.library.views, [localView]);
  await saveContentMetadata('reading:reading-a', { description: 'keep new local description' });
  assert.equal(await importPersonalTools(file), 0);
  preferences = await loadContentPreferences();
  assert.equal(getContentMetadata(preferences, 'reading:reading-a').description, 'keep new local description');
  const malformed = structuredClone(envelope);
  malformed.preferences.library.items['site:other'] = { description: 'must not enter navigation', tagIds: [] };
  const before = new Map(values);
  await assert.rejects(importPersonalTools(new Blob([JSON.stringify(malformed)])), /格式不支持/);
  const unsupportedViews = structuredClone(envelope);
  unsupportedViews.preferences.library.views = [localView];
  await assert.rejects(importPersonalTools(new Blob([JSON.stringify(unsupportedViews)])), /格式不支持/);
  assert.deepEqual(values, before);
  t.mock.method(localData, 'set', async () => { throw Error('synthetic failed commit'); });
  await assert.rejects(importPersonalTools(file), /未能保存/); assert.deepEqual(values, before);
});

test('v1/v2 tools migrate to v3 and trash records are strictly bounded and validated', () => {
  for (const version of [1, 2]) {
    const migrated = validatePersonalTools({ version, revision: 9, notes: [note()], reading: [reading()], snapshots: [snapshot()] });
    assert.equal(migrated.version, 3); assert.equal(migrated.revision, 9); assert.deepEqual(migrated.trash, []);
  }
  const item = { id: 'trash-a', kind: 'notes', deletedAt: now, record: note() };
  const valid = validatePersonalTools(state({ trash: [item] }));
  valid.trash[0].record.body = 'changed copy'; assert.equal(item.record.body, 'saved body');
  for (const patch of [{ kind: 'unsupported' }, { deletedAt: -1 }, { record: { ...note(), secret: 'unknown' } }]) assert.throws(() => validatePersonalTools(state({ trash: [{ ...item, ...patch }] })));
  assert.throws(() => validatePersonalTools(state({ trash: [item, item] })), /重复/);
  assert.throws(() => validatePersonalTools(state({ trash: Array.from({ length: PERSONAL_TRASH_LIMITS.maxRecords + 1 }, (_, index) => ({ ...item, id: `trash-${index}` })) })));
  assert.throws(() => validatePersonalTools({ version: 2, revision: 0, notes: [], reading: [], snapshots: [], trash: [] }));
});

test('deleting and restoring notes and reading preserves IDs and content', async () => {
  const initial = state({ notes: [note()], reading: [reading()], snapshots: [snapshot()] });
  await replacePersonalTools(initial, { expectedRevision: 0 });
  for (const kind of ['notes', 'reading']) {
    const record = initial[kind][0];
    await deletePersonalRecord(kind, record.id, record.revision);
    const deleted = await loadPersonalTools(), item = deleted.trash.find((item) => item.kind === kind);
    assert.equal(deleted[kind].length, 0); assert.deepEqual(item.record, record);
    const restored = await restoreTrashedPersonalRecord(item.id, { expectedRevision: deleted.revision });
    assert.equal(restored.id, record.id); assert.equal(restored.revision, record.revision + 1);
    assert.deepEqual(restored.body ?? restored.url ?? restored.tabs, record.body ?? record.url ?? record.tabs);
  }
  assert.equal((await loadPersonalTools()).trash.length, 0);
});

test('trash restoration rejects active ID or URL collisions without overwriting either record', async () => {
  await replacePersonalTools(state({ notes: [note()] })); await deletePersonalRecord('notes', 'note-a', 1);
  let data = await loadPersonalTools(), trashId = data.trash[0].id;
  await replacePersonalTools({ ...data, notes: [note('note-a', 'new content', 5)] }, { expectedRevision: data.revision });
  await assert.rejects(restoreTrashedPersonalRecord(trashId), /未覆盖/);
  data = await loadPersonalTools(); assert.equal(data.notes[0].body, 'new content'); assert.equal(data.trash[0].record.body, 'saved body');
  assert.equal(data.notes[0].revision, 5);
  await replacePersonalTools(state({ reading: [reading()], trash: [{ id: 'trash-url', kind: 'reading', deletedAt: now, record: reading('different-id') }] }));
  await assert.rejects(restoreTrashedPersonalRecord('trash-url'), /稍后读/);
});

test('expired records are removed on locked read while fresh records remain and destructive actions guard revisions', async () => {
  values.set(key, JSON.stringify(state({ revision: 12, trash: [
    { id: 'expired', kind: 'notes', deletedAt: now - 31 * 86400000, record: note() },
    { id: 'fresh', kind: 'notes', deletedAt: now, record: note('fresh-note') },
  ] })));
  let data = await loadPersonalTools(); assert.equal(data.revision, 13); assert.deepEqual(data.trash.map((item) => item.id), ['fresh']);
  assert.equal(JSON.parse(values.get(key)).trash.length, 1);
  await assert.rejects(emptyPersonalTrash({ expectedRevision: 12 }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(permanentlyDeletePersonalTrash('fresh', { expectedRevision: 12 }), { code: 'REVISION_CONFLICT' });
  await permanentlyDeletePersonalTrash('fresh', { expectedRevision: 13 });
  data = await loadPersonalTools(); assert.equal(data.trash.length, 0);
});

test('full trash rejects deletion atomically and never evicts an unexpired record', async () => {
  const trash = Array.from({ length: PERSONAL_TRASH_LIMITS.maxRecords }, (_, index) => ({ id: `trash-${index}`, kind: 'notes', deletedAt: now, record: note(`old-${index}`) }));
  await replacePersonalTools(state({ notes: [note()], trash }));
  const before = values.get(key);
  await assert.rejects(deletePersonalRecord('notes', 'note-a', 1), /回收站已满/);
  assert.equal(values.get(key), before);
  await emptyPersonalTrash(); await deletePersonalRecord('notes', 'note-a', 1);
  assert.equal((await loadPersonalTools()).trash.length, 1);
});

test('scoped empty removes only selected trash entries and an empty scope preserves every record', async () => {
  const trash = [
    { id: 'public-note-trash', kind: 'notes', deletedAt: now, record: note('public-note') },
    { id: 'hidden-note-trash', kind: 'notes', deletedAt: now, record: note('hidden-note', 'keep private content') },
    { id: 'public-reading-trash', kind: 'reading', deletedAt: now, record: reading('public-reading') },
    { id: 'hidden-snapshot-trash', kind: 'snapshots', deletedAt: now, record: snapshot() },
  ];
  let data = await replacePersonalTools(state({ trash }));
  assert.equal(await emptyPersonalTrash({ expectedRevision: data.revision, ids: ['public-note-trash', 'public-reading-trash'] }), 2);
  data = await loadPersonalTools();
  assert.deepEqual(data.trash, [trash[1], trash[3]]);
  assert.equal(await emptyPersonalTrash({ expectedRevision: data.revision, ids: [] }), 0);
  assert.deepEqual((await loadPersonalTools()).trash, [trash[1], trash[3]]);
  assert.equal(await emptyPersonalTrash(), 2, 'omitting ids preserves the existing full-clear behavior');
  assert.deepEqual((await loadPersonalTools()).trash, []);
});

test('scoped empty rejects malformed, excessive or stale IDs without deleting any records', async () => {
  const data = await replacePersonalTools(state({ trash: [
    { id: 'retained-trash', kind: 'notes', deletedAt: now, record: note() },
  ] }));
  const before = values.get(key);
  for (const ids of [null, 'retained-trash', [null], ['bad/id'], ['a'.repeat(101)], ['retained-trash', 'retained-trash'],
    Array.from({ length: PERSONAL_TRASH_LIMITS.maxRecords + 1 }, (_, index) => `trash-${index}`)]) {
    await assert.rejects(async () => emptyPersonalTrash({ expectedRevision: data.revision, ids }));
    assert.equal(values.get(key), before);
  }
  await assert.rejects(emptyPersonalTrash({ expectedRevision: data.revision, ids: ['retained-trash', 'removed-trash'] }), /移除或过期/);
  assert.equal(values.get(key), before, 'a stale ID does not partially delete other selected records');
});

test('scoped empty requires the observed revision and rejects concurrent changes atomically', async () => {
  const data = await replacePersonalTools(state({ trash: [
    { id: 'retained-trash', kind: 'notes', deletedAt: now, record: note() },
  ] }));
  const ids = ['retained-trash'], before = values.get(key);
  for (const expectedRevision of [undefined, -1, 0, data.revision + 1, 1.5, String(data.revision), NaN]) {
    await assert.rejects(async () => emptyPersonalTrash({ expectedRevision, ids }), { code: 'REVISION_CONFLICT' });
    assert.equal(values.get(key), before);
  }
  await saveReadingItem({ url: 'https://example.com/concurrent', title: 'Concurrent addition' });
  const concurrent = values.get(key);
  await assert.rejects(emptyPersonalTrash({ expectedRevision: data.revision, ids }), { code: 'REVISION_CONFLICT' });
  assert.equal(values.get(key), concurrent);
});

test('replacement and sync protect open-editor revisions, preserve snapshots and trash, and reject stale network applies', async () => {
  let data = await replacePersonalTools(state({ notes: [note()], reading: [reading()], snapshots: [snapshot()] }));
  const synced = await applySyncedPersonalTools({ notes: [note('note-a', 'remote content')], reading: [] }, { expectedRevision: data.revision });
  assert.equal(synced.notes[0].revision, 2); assert.equal(synced.notes[0].body, 'remote content');
  assert.deepEqual(synced.snapshots, [snapshot()]); assert.equal(synced.trash[0].record.id, 'reading-a');
  await assert.rejects(applySyncedPersonalTools({ notes: [], reading: [] }, { expectedRevision: data.revision }), { code: 'REVISION_CONFLICT' });
  data = await replacePersonalTools({ ...synced, notes: [note('note-a', 'backup content', 1)] }, { expectedRevision: synced.revision });
  assert.equal(data.notes[0].revision, 3);
  const same = await applySyncedPersonalTools({ notes: [{ ...data.notes[0], revision: 100 }], reading: [] }, { expectedRevision: data.revision });
  assert.equal(same.notes[0].revision, 3);
  await deletePersonalRecord('notes', 'note-a', 3);
  const restoredFromBackup = await replacePersonalTools(state({ notes: [note('note-a', 'old backup', 1)] }));
  assert.equal(restoredFromBackup.notes[0].revision, 4, 'backup resurrection cannot make an old deleted editor current again');
});

test('tool backup v3 round-trips trash and old imports merge without replacing edited local records', async () => {
  await replacePersonalTools(state({ notes: [note()], reading: [reading()] })); await deletePersonalRecord('notes', 'note-a', 1);
  const blob = await exportPersonalTools(), exported = JSON.parse(await blob.text());
  assert.equal(exported.version, 3); assert.equal(exported.data.trash.length, 1);
  values.clear(); assert.equal(await importPersonalTools(blob), 2);
  const loaded = await loadPersonalTools(); assert.equal(loaded.trash.length, 1); assert.equal(loaded.reading.length, 1);
  const old = { format: 'covelet-personal-tools', version: 1, data: { version: 1, revision: 0, notes: [note('note-b')], reading: [reading('other-reading')], snapshots: [] } };
  assert.equal(await importPersonalTools(new Blob([JSON.stringify(old)])), 1);
  const merged = await mergePersonalTools(state({ notes: [note('note-b', 'must not replace')], reading: [reading('reading-b', 'https://example.com/new')] }));
  assert.equal(merged.notes.find((item) => item.id === 'note-b').body, 'saved body'); assert.equal(merged.reading.length, 2);
});

test('parallel local mutations share a queue and record deletion rejects a stale editor revision', async () => {
  await Promise.all([saveReadingItem({ url: 'https://example.com/one', title: 'one' }), saveReadingItem({ url: 'https://example.com/two', title: 'two' })]);
  const data = await loadPersonalTools(); assert.equal(data.reading.length, 2); assert.equal(data.revision, 2);
  await assert.rejects(deletePersonalRecord('reading', data.reading[0].id, 2), /其他页面修改/);
  assert.equal((await loadPersonalTools()).reading.length, 2);
});


test('A+ retains legacy snapshot bytes for export but blocks import and record restoration', async () => {
  const legacyTrash = { id: 'legacy-snapshot-trash', kind: 'snapshots', deletedAt: now, record: snapshot() };
  await replacePersonalTools(state({ snapshots: [snapshot()], trash: [legacyTrash] }));
  await assert.rejects(async () => deletePersonalRecord('snapshots', 'snapshot-a', 1));
  await assert.rejects(restoreTrashedPersonalRecord(legacyTrash.id));
  const exported = await exportPersonalTools();
  assert.deepEqual(JSON.parse(await exported.text()).data.snapshots, [snapshot()]);
  values.clear();
  await importPersonalTools(exported);
  let data = await loadPersonalTools();
  assert.deepEqual(data.snapshots, []); assert.deepEqual(data.trash, []);
  await mergePersonalTools(state({ snapshots: [snapshot()], trash: [legacyTrash], notes: [note()] }));
  data = await loadPersonalTools();
  assert.deepEqual(data.snapshots, []); assert.deepEqual(data.trash, []); assert.equal(data.notes.length, 1);
});
