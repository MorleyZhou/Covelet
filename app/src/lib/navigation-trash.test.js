import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, deleteEntry, migrateNavigationState, moveEntry, NAVIGATION_TRASH_LIMITS } from './model.js';
import { prepareNavigationDeletion, prepareTrashRestore, restoreTrashItem, getNavigationTrash, cloneTrashForAppend } from './navigation-trash-core.js';
import { navigationResourceEntries, remapNavigationAssets } from './navigation-resources.js';
import { getContentTags, prepareContentPreferencesRestore, renameContentTag, deleteContentTag } from './content-preferences.js';
import { createStorage } from './storage.js';
import { localData } from './local-data.js';
import { commitTrashRestore, commitTrashDelete, purgeExpiredNavigationTrash } from './navigation-trash.js';
import { unzipSync, strFromU8 } from 'fflate';

const NAV = 'owntab.local.v1', PREFS = 'covelet.content.preferences.v1';
const NOW = Date.now();
const prefs = () => ({ version: 1, revision: 0, aliases: {}, privateKeys: [], presentation: false });
const site = (id, parentId = null, order = 0, page = 0) => ({ id, type: 'site', name: id, url: `https://example.test/${id}`, groupId: 'group-home', parentId, page, order, icon: { kind: 'letter', value: 'S' } });
function state() {
  const value = createEmptyState(); value.settings.pages = [0, 1]; value.settings.desktopPages = { 0: { id: 'desktop-a', name: 'First' }, 1: { id: 'desktop-b', name: 'Second' } };
  value.entries = [{ id: 'folder', type: 'folder', name: 'Folder', groupId: 'group-home', parentId: null, page: 0, order: 0, position: { row: 0, column: 0 }, icon: { kind: 'letter', value: 'F' } },
    site('a', 'folder', 0), site('b', 'folder', 1), site('root', null, 1, 1)];
  return migrateNavigationState(value);
}
const record = (entry, id = `trash-${entry.id}`, deletedAt = NOW) => ({ id, kind: entry.type, deletedAt,
  origin: { desktopId: 'desktop-a', page: 0, parentId: entry.parentId }, ownedEntries: [structuredClone(entry)], memberRefs: [] });
function harness(t, initial = state(), preferences = prefs()) {
  const records = new Map([[NAV, { version: 1, state: structuredClone(initial), snapshots: [] }], [PREFS, structuredClone(preferences)]]), writes = [], assets = new Map(), icons = new Map(), held = [];
  let failed = false, sequence = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const locks = { async request(key, options, action) { held.push(key); try { return await (action || options)(); } finally { assert.equal(held.pop(), key); } } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', original));
  const write = (patch) => {
    if (failed) throw Error('synthetic quota');
    writes.push({ patch: structuredClone(patch), locks: [...held] });
    for (const [key, value] of Object.entries(patch)) records.set(key, structuredClone(value));
  };
  t.mock.method(localData, 'get', async (requested) => {
    const keys = Array.isArray(requested) ? requested : [requested];
    return structuredClone(Object.fromEntries(keys.filter((key) => records.has(key)).map((key) => [key, records.get(key)])));
  });
  t.mock.method(localData, 'set', async (patch) => write(patch));
  const store = createStorage({ locks, configStore: { read: async () => structuredClone(records.get(NAV)), write: async (envelope, additional) => write({ [NAV]: envelope, ...additional }), subscribe: () => () => {} },
    assetStore: { get: async (id) => assets.get(id), add: async (asset) => assets.set(asset.id, asset), delete: async (id) => assets.delete(id) },
    iconResources: { read: async (url) => icons.get(url) || null, restore: async (item) => { icons.set(item.url, item); return item; }, prepare: async () => ({ completed: 0 }) },
    imageTools: { validate: async () => ({ width: 1, height: 1 }) }, uuid: () => `asset-${++sequence}` });
  return { records, writes, assets, icons, store, fail(value = true) { failed = value; }, options() { return { expectedNavigationRevision: records.get(NAV).state.revision, expectedPreferencesRevision: records.get(PREFS).revision }; } };
}

test('trash capture distinguishes a site, dissolved members and truly deleted folder children without changing drafts', () => {
  const before = state(), original = structuredClone(before);
  assert.equal(Object.hasOwn(prepareNavigationDeletion(before, before, prefs()).state, 'trash'), false);
  const single = prepareNavigationDeletion(before, deleteEntry(before, 'root'), prefs(), { now: NOW }).state;
  assert.deepEqual(single.trash.items[0].ownedEntries.map((entry) => entry.id), ['root']);
  const dissolved = prepareNavigationDeletion(before, deleteEntry(before, 'folder'), prefs(), { now: NOW }).state;
  assert.deepEqual(dissolved.trash.items[0].ownedEntries.map((entry) => entry.id), ['folder']);
  assert.deepEqual(dissolved.trash.items[0].memberRefs.map((entry) => entry.id), ['a', 'b']);
  const whole = { ...before, entries: before.entries.filter((entry) => !['folder', 'a', 'b'].includes(entry.id)).map((entry, order) => ({ ...entry, order })) };
  const grouped = prepareNavigationDeletion(before, whole, prefs(), { now: NOW }).state;
  assert.deepEqual(grouped.trash.items[0].ownedEntries.map((entry) => entry.id), ['folder', 'a', 'b']);
  assert.deepEqual(grouped.trash.items[0].memberRefs, []);
  const cleaned = prepareNavigationDeletion(before, deleteEntry(before, 'a'), prefs(), { now: NOW }).state;
  assert.deepEqual(cleaned.trash.items[0].ownedEntries.map((entry) => entry.id), ['folder', 'a']);
  assert.deepEqual(cleaned.trash.items[0].memberRefs.map((entry) => entry.id), ['b']);
  const recovered = restoreTrashItem(cleaned, prefs(), cleaned.trash.items[0].id);
  assert.deepEqual(recovered.state.entries.filter((entry) => entry.parentId === 'folder').map((entry) => entry.id).sort(), ['a', 'b']);
  assert.deepEqual(before, original);
});

test('a removed empty folder never owns or reattaches children that moved into another folder', () => {
  const before = state(); before.entries.push({ ...before.entries[0], id: 'destination', name: 'Destination', page: 1, order: 2 });
  let moved = moveEntry(before, 'a', { parentId: 'destination' }); moved = moveEntry(moved, 'b', { parentId: 'destination' });
  const captured = prepareNavigationDeletion(before, moved, prefs(), { now: NOW }).state, event = captured.trash.items[0];
  assert.deepEqual(event.ownedEntries.map((entry) => entry.id), ['folder']); assert.deepEqual(event.memberRefs, []);
  const restored = restoreTrashItem(captured, prefs(), event.id);
  assert(restored.state.entries.filter((entry) => ['a', 'b'].includes(entry.id)).every((entry) => entry.parentId === 'destination'));
  const movedOnPage = moveEntry(state(), 'a', { parentId: null, page: 0 });
  movedOnPage.entries.find((entry) => entry.id === 'a').position = { row: 0, column: 2 };
  const samePage = prepareNavigationDeletion(state(), movedOnPage, prefs()).state.trash.items[0];
  assert.deepEqual(samePage.memberRefs.map((entry) => entry.id), ['b']);
});

test('restore previews retain invalid destinations, skip moved members and consume only their own event', () => {
  const before = state(); let current = prepareNavigationDeletion(before, deleteEntry(before, 'folder'), prefs(), { now: NOW }).state;
  current = moveEntry(current, 'a', { page: 1 });
  const event = current.trash.items[0], preview = prepareTrashRestore(current, prefs(), event.id);
  assert.equal(preview.status, 'ready'); assert(preview.skippedMemberIds.includes('a')); assert(!preview.reattachIds.includes('a'));
  const restored = restoreTrashItem(current, prefs(), event.id);
  assert.equal(restored.state.entries.find((entry) => entry.id === 'a').page, 1); assert.equal(restored.state.trash.items.length, 0);
  const missing = structuredClone(current); delete missing.settings.desktopPages[0];
  assert.equal(prepareTrashRestore(missing, prefs(), event.id).status, 'needs-destination');
  assert.equal(prepareTrashRestore(missing, prefs(), event.id, { destinationValue: 'folder:not-here' }).status, 'needs-destination');
  assert.equal(prepareTrashRestore(missing, prefs(), event.id, { destinationValue: 'page-id:desktop-b' }).status, 'ready');
});

test('strict trash validation bounds ownership, events, resource fields and historical member references', () => {
  const base = state(), valid = prepareNavigationDeletion(base, deleteEntry(base, 'root'), prefs(), { now: NOW }).state;
  const corruptions = [
    (value) => { value.trash.version = 2; }, (value) => { value.trash.items[0].unknown = true; },
    (value) => { value.trash.items[0].ownedEntries[0].id = 'a'; }, (value) => { value.trash.items[0].ownedEntries[0].url = 'javascript:alert(1)'; },
    (value) => { value.trash.items[0].ownedEntries[0].icon = { kind: 'image', value: 'https://unsafe.test/' }; },
  ];
  for (const corrupt of corruptions) { const value = structuredClone(valid); corrupt(value); assert.throws(() => migrateNavigationState(value)); }
  const full = state(); full.trash = { version: 1, items: Array.from({ length: NAVIGATION_TRASH_LIMITS.events }, (_, index) => record(site(`old-${index}`))) };
  assert.throws(() => prepareNavigationDeletion(full, deleteEntry(full, 'root'), prefs()), /回收站/);
  assert.equal(full.trash.items.length, 200);
});

test('deleted inherited-private metadata stays hidden and global tag rename/delete reaches orphan metadata', async (t) => {
  const initial = state(), preferences = { ...prefs(), privateKeys: ['folder:folder'], aliases: { 'site:a': 'saved alias' }, library: { version: 1, tags: [{ id: 'tag-a', name: 'Secret' }], items: {
    'site:a': { description: 'why saved', tagIds: ['tag-a'] },
  } } };
  const h = harness(t, initial, preferences);
  const desired = { ...initial, entries: initial.entries.filter((entry) => entry.id !== 'a').map((entry) => entry.id === 'b' ? { ...entry, order: 0 } : entry) };
  const saved = await h.store.saveStateWithTrash(desired, initial.revision);
  assert.equal(h.writes.length, 1); assert.deepEqual(h.writes[0].locks, ['owntab.local.write.v1', PREFS]);
  assert(h.records.get(PREFS).privateKeys.includes('site:a')); assert.equal(h.records.get(PREFS).aliases['site:a'], 'saved alias');
  await renameContentTag('tag-a', 'Renamed'); assert.equal(h.records.get(PREFS).library.tags[0].name, 'Renamed');
  await deleteContentTag('tag-a'); assert.deepEqual(h.records.get(PREFS).library.items['site:a'], { description: 'why saved', tagIds: [] });
  const locked = { ...h.records.get(PREFS), presentation: true };
  assert.deepEqual(getNavigationTrash(saved, locked), []); assert.deepEqual(getContentTags(locked), []);
});

test('public restore/delete use two fresh revisions and permanent purge frees orphan metadata without clearing private tombstones', async (t) => {
  const initial = state(), deleted = prepareNavigationDeletion(initial, deleteEntry(initial, 'root'), prefs(), { now: NOW }).state;
  const event = deleted.trash.items[0], preferences = { ...prefs(), aliases: { 'site:root': 'orphan' }, privateKeys: [], library: { version: 1, tags: [], items: { 'site:root': { description: 'old reason', tagIds: [] } } } };
  const h = harness(t, deleted, preferences), plan = prepareTrashRestore(deleted, preferences, event.id);
  await assert.rejects(commitTrashRestore({ ...plan, expectedPreferencesRevision: 99 }), { code: 'REVISION_CONFLICT' }); assert.equal(h.writes.length, 0);
  const restored = await commitTrashRestore(plan); assert(restored.state.entries.some((entry) => entry.id === 'root'));
  assert.equal(h.records.get(PREFS).library.items['site:root'].description, 'old reason');
  const again = await h.store.saveStateWithTrash(deleteEntry(restored.state, 'root'), restored.state.revision), id = again.trash.items[0].id;
  const result = await commitTrashDelete([id], h.options()); assert.equal(result.count, 1); assert.equal(result.state.trash.items.length, 0);
  assert(!Object.hasOwn(h.records.get(PREFS).library.items, 'site:root')); assert(!Object.hasOwn(h.records.get(PREFS).aliases, 'site:root'));
});

test('expiry reads never write or release owned resources before a locked purge commits', async (t) => {
  const initial = state(); initial.trash = { version: 1, items: [record(site('expired'), 'trash-expired', NOW - 31 * 86400000)] };
  const h = harness(t, initial);
  assert.deepEqual(getNavigationTrash(initial, prefs()), []); assert.equal(h.writes.length, 0);
  assert(navigationResourceEntries(initial).some((entry) => entry.id === 'expired'));
  const result = await purgeExpiredNavigationTrash(); assert.equal(result.count, 1); assert.equal(result.state.trash.items.length, 0); assert.equal(h.writes.length, 1);
});

test('a full expired trash is maintained in the same atomic deletion write, with resources retained until commit and failures leaving both records intact', async (t) => {
  const initial = state();
  initial.trash = { version: 1, items: Array.from({ length: 200 }, (_, index) => record(site(`expired-${index}`), `trash-expired-${index}`, NOW - 31 * 86400000)) };
  initial.trash.items[0].ownedEntries[0].icon = { kind: 'image', value: 'expired-image' };
  const preferences = { ...prefs(), aliases: Object.fromEntries(initial.trash.items.map((item) => [`site:${item.ownedEntries[0].id}`, 'old alias'])), privateKeys: ['site:expired-0'], library: { version: 1, tags: [{ id: 'old-tag', name: 'Old tag' }], items: Object.fromEntries(initial.trash.items.map((item) => [`site:${item.ownedEntries[0].id}`, { description: 'old metadata', tagIds: ['old-tag'] }])) } };
  const h = harness(t, initial, preferences), expected = structuredClone(Object.fromEntries(h.records));
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB0kAAAAASUVORK5CYII=', 'base64'));
  h.assets.set('expired-image', { id: 'expired-image', blob: new Blob([png], { type: 'image/png' }) });
  assert.deepEqual(getNavigationTrash(initial, preferences), []);
  const archive = unzipSync(new Uint8Array(await (await h.store.exportBackup(initial)).arrayBuffer()));
  assert.equal(JSON.parse(strFromU8(archive['manifest.json'])).assets.length, 1);
  assert.equal(h.writes.length, 0, 'reading and exporting expired-but-stored entries do not maintain them');
  const desired = deleteEntry(initial, 'root');
  const forged = structuredClone(desired); forged.trash.items = [];
  await assert.rejects(h.store.saveStateWithTrash(forged, initial.revision), { code: 'REVISION_CONFLICT' });
  await assert.rejects(h.store.saveStateWithTrash(desired, initial.revision, { expectedPreferencesRevision: 99 }), { code: 'REVISION_CONFLICT' });
  h.fail(); await assert.rejects(h.store.saveStateWithTrash(desired, initial.revision, { expectedPreferencesRevision: preferences.revision }), /synthetic quota/);
  assert.deepEqual(Object.fromEntries(h.records), expected); assert.equal(h.writes.length, 0);
  h.fail(false);
  const saved = await h.store.saveStateWithTrash(desired, initial.revision, { expectedPreferencesRevision: preferences.revision,
    metadata: [{ key: 'site:a', description: 'atomic current metadata', tagIds: ['old-tag'] }] });
  assert.equal(saved.revision, initial.revision + 1); assert.equal(saved.trash.items.length, 1); assert.equal(saved.trash.items[0].ownedEntries[0].id, 'root');
  assert.equal(h.writes.length, 1); assert.deepEqual(h.writes[0].locks, ['owntab.local.write.v1', PREFS]);
  assert.deepEqual(h.records.get(PREFS).aliases, {}); assert.deepEqual(h.records.get(PREFS).library.items, { 'site:a': { description: 'atomic current metadata', tagIds: ['old-tag'] } });
  assert.deepEqual(h.records.get(PREFS).privateKeys, ['site:expired-0']); assert.equal(h.records.get(PREFS).revision, preferences.revision + 1);
  assert(!navigationResourceEntries(saved).some((entry) => entry.id === 'expired-0'));
  assert(navigationResourceEntries(h.records.get(NAV).snapshots[0]).some((entry) => entry.id === 'expired-0'), 'the prior navigation snapshot still retains its resource owner');
  assert.equal(initial.trash.items.length, 200, 'caller draft and original snapshot remain immutable');
});

test('append remaps active/trash/orphan collisions and missing source desktop/member IDs without borrowing local identities', () => {
  const target = state(), source = createEmptyState(); source.settings.desktopPages = { 0: { id: 'desktop-source', name: 'Source' } };
  source.entries = [site('a')]; source.trash = { version: 1, items: [record(site('root'), 'event-old')] };
  source.trash.items[0].origin.desktopId = 'desktop-a'; // deleted in source, exists only on target
  let counter = 0;
  const appended = cloneTrashForAppend(target, source, { activeIdMap: new Map(), reservedPreferenceKeys: ['site:root'], makeId: () => `new-${++counter}` });
  const imported = appended.state.trash.items[0];
  assert.notEqual(imported.ownedEntries[0].id, 'root'); assert.equal(appended.preferenceKeyMap.get('site:root'), `site:${imported.ownedEntries[0].id}`);
  assert.notEqual(imported.origin.desktopId, 'desktop-a'); assert(imported.origin.desktopId.startsWith('missing-desktop-'));
  assert.notEqual(appended.referenceIdMap.get('a'), 'a'); assert(!appended.preferenceKeyMap.has('site:a'));
  assert.equal(prepareTrashRestore(appended.state, prefs(), imported.id).status, 'needs-destination');
  let calls = 0; assert.throws(() => cloneTrashForAppend(target, source, { makeId: () => { calls++; return ''; } }), { code: 'REVISION_CONFLICT' });
  assert(calls <= 102);
});

test('asset remapping traverses active and stored owned entries and preserves shared resource identities', () => {
  const current = state(); current.entries[3].icon = { kind: 'image', value: 'shared-icon' };
  current.trash = { version: 1, items: [record({ ...site('gone'), icon: { kind: 'image', value: 'shared-icon' } })] };
  const remapped = remapNavigationAssets(current, new Map([['shared-icon', 'restored-icon']]));
  assert.deepEqual(navigationResourceEntries(remapped).filter((entry) => entry.icon.kind === 'image').map((entry) => entry.icon.value), ['restored-icon', 'restored-icon']);
  assert.equal(current.trash.items[0].ownedEntries[0].icon.value, 'shared-icon');
});
