import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createFullDataSync } from './full-data-sync.js';
import { createLocalData } from './local-data.js';
import { createEmptyState } from './model.js';

const target = 'a'.repeat(64), password = 'record merge integration passphrase';
const TOOLS = 'covelet.tools.v1', NAV = 'owntab.local.v1', PREFS = 'covelet.content.preferences.v1';
const copy = (value) => structuredClone(value);
const record = (key, value) => ({ namespace: 'preferences', key, value });
const note = (id, body = id) => ({ id, title: id, body, pinned: false, revision: 1, createdAt: 1, updatedAt: 1 });
const site = (id, order = 0, parentId = null) => ({ id, type: 'site', name: id, url: `https://${id}.example/`, groupId: 'group-home', parentId, order, icon: { kind: 'letter', value: id } });
const initial = () => {
  const navigation = createEmptyState();
  navigation.entries = [site('shared-site')];
  return [record(NAV, { version: 1, state: navigation, snapshots: [] }),
    record(TOOLS, { version: 3, revision: 0, notes: [note('shared-note')], reading: [], snapshots: [], trash: [] })];
};

function remote() {
  const indexes = new Map(), blobs = new Map();
  const at = (values) => ({
    async list() { return [...values].map(([name, bytes]) => ({ name, size: bytes.length })); },
    async read(name) { return values.get(name)?.slice(); },
    async write(name, bytes) {
      if (values.has(name)) assert.deepEqual(values.get(name), bytes, 'Remote filenames remain immutable.');
      values.set(name, bytes.slice());
    },
  });
  return { provider: at(indexes), assetProvider: at(blobs), indexes, blobs };
}

async function device(t, cloud, actor, records = []) {
  const encrypted = new Map(); let deviceKey, failCommit = false, raceApply = false;
  const backend = {
    getKey: async () => deviceKey,
    ensureKey: async (candidate) => deviceKey ||= candidate,
    get: async (id) => copy(encrypted.get(id)),
    entries: async (space) => [...encrypted.values()].filter((item) => space === undefined || item.space === space).map(copy),
    put: async (values) => { for (const value of values) encrypted.set(value.id, copy(value)); },
    remove: async (ids) => { for (const id of ids) encrypted.delete(id); },
    commit: async (values, ids) => {
      if (failCommit) { failCommit = false; throw Error('Synthetic atomic commit failure'); }
      const next = new Map(encrypted);
      for (const id of ids) next.delete(id);
      for (const value of values) next.set(value.id, copy(value));
      encrypted.clear(); for (const [id, value] of next) encrypted.set(id, value);
    },
  };
  const persistence = createLocalData({ backend, databaseName: `record-integration-${webcrypto.randomUUID()}`, crypto: webcrypto,
    legacyLocal: null, localStorage: null, broadcastChannel: null, locks: null });
  const { localData, syncDataStore } = persistence;
  t.after(() => persistence.close());
  for (const item of records) await localData.set({ [item.key]: item.value });
  await localData.set({ 'covelet.language.v1': actor === 'a' ? 'zh-CN' : 'en', 'covelet.privacy.lock.v1': { verifier: `${actor}-device-secret` } });
  const snapshotStore = { ...syncDataStore,
    async apply(next, options) {
      if (raceApply && options.mergeRecovery) {
        raceApply = false;
        await localData.set({ 'covelet.racing.v1': { retained: true } });
      }
      return syncDataStore.apply(next, options);
    },
  };
  const store = syncDataStore.syncMetadataStore;
  const api = createFullDataSync({ snapshotStore, store, currentTarget: () => target, uuid: () => actor.repeat(32), crypto: webcrypto,
    access: async () => ({ target, password, autoSync: false, ...cloud, async check() {} }),
    pendingStore: persistence.createEncryptedStore('full-data-pending'),
    historyStore: { async read() { return (await localData.get('covelet.data-sync.runs.v1'))['covelet.data-sync.runs.v1'] || null; },
      async write(value) { await localData.set({ 'covelet.data-sync.runs.v1': value }); } },
    locks: null, eventWindow: null, eventDocument: null,
  });
  return { api, store, syncDataStore, localData,
    value: async (key) => (await localData.get(key))[key],
    async edit(key, update) { const value = (await localData.get(key))[key]; update(value); await localData.set({ [key]: value }); },
    set failCommit(value) { failCommit = value; }, set raceApply(value) { raceApply = value; },
  };
}

async function saved(peer) {
  const result = await peer.api.syncFullDataNow();
  assert.equal(result.phase, 'saved', `${result.code}: ${result.message}`);
}
async function peers(t, records = initial()) {
  const cloud = remote(), a = await device(t, cloud, 'a', records), b = await device(t, cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  return { cloud, a, b };
}
async function conflict(peer) {
  const result = await peer.api.syncFullDataNow();
  assert.equal(result.phase, 'conflict', `${result.code}: ${result.message}`);
}
async function conflictingPeers(t) {
  const group = await peers(t), { a, b } = group;
  await a.edit(TOOLS, (value) => { value.notes[0].body = 'A body'; value.notes.push(note('only-a')); });
  await b.edit(TOOLS, (value) => { value.notes[0].body = 'B body'; value.notes.push(note('only-b')); });
  await a.edit(NAV, (value) => { value.state.entries[0].name = 'A site'; value.state.entries.push(site('site-a', 1)); });
  await b.edit(NAV, (value) => { value.state.entries[0].name = 'B site'; value.state.entries.push(site('site-b', 1)); });
  await saved(a); await conflict(b);
  return group;
}
const stale = (error) => error.code === 'DATA_SYNC_CONFLICT_STALE';

test('record merge previews both additions and concurrent edits, applies per-record choices and converges without lost records', async (t) => {
  const { cloud, a, b } = await conflictingPeers(t);
  const before = await b.syncDataStore.snapshot(), metadata = await b.store.read(), count = cloud.indexes.size;
  const preview = await b.api.previewFullDataMerge();
  assert.deepEqual(await b.syncDataStore.snapshot(), before, 'Preview does not alter local data.');
  assert.deepEqual(await b.store.read(), metadata, 'Preview does not advance causal metadata.');
  const sharedNote = preview.rows.find((row) => row.kind === 'note' && row.local?.id === 'shared-note');
  const sharedSite = preview.rows.find((row) => row.kind === 'navigation' && row.local?.id === 'shared-site');
  assert.equal(sharedNote.status, 'both'); assert.equal(sharedNote.conflict, true);
  assert.equal(sharedSite.status, 'both'); assert.equal(sharedSite.conflict, true);
  assert.deepEqual(preview.rows.filter((row) => row.kind === 'note' && row.status === 'one').map((row) => (row.local || row.remote).id).sort(), ['only-a', 'only-b']);
  await b.api.applyFullDataMerge({ token: preview.token, choices: { [sharedNote.id]: 'remote', [sharedSite.id]: 'local' } });
  assert.equal(cloud.indexes.size, count, 'Applying publishes locally before later synchronization.');
  const tools = await b.value(TOOLS), navigation = await b.value(NAV);
  assert.deepEqual(tools.notes.map((item) => item.id).sort(), ['only-a', 'only-b', 'shared-note']);
  assert.equal(tools.notes.find((item) => item.id === 'shared-note').body, 'A body');
  assert.deepEqual(navigation.state.entries.map((item) => item.id).sort(), ['shared-site', 'site-a', 'site-b']);
  assert.equal(navigation.state.entries.find((item) => item.id === 'shared-site').name, 'B site');
  assert.equal(await b.api.getFullDataMergeRecovery(), true);
  assert.deepEqual((await b.syncDataStore.readMergeRecovery()).snapshot, before);
  await saved(b); await saved(a); await saved(b);
  assert.deepEqual((await a.syncDataStore.snapshot()).records, (await b.syncDataStore.snapshot()).records);
  assert.equal(await a.value('covelet.language.v1'), 'zh-CN'); assert.equal(await b.value('covelet.language.v1'), 'en');
  assert.deepEqual(await b.value('covelet.privacy.lock.v1'), { verifier: 'b-device-secret' });
  for (const bytes of [...cloud.indexes.values(), ...cloud.blobs.values()]) assert.doesNotMatch(new TextDecoder().decode(bytes), /A body|B body|device-secret|only-a|only-b/);
});

test('a trusted causal baseline distinguishes deletion from missing additions and retains a concurrently modified note', async (t) => {
  const records = initial(); records.find((item) => item.key === TOOLS).value.notes.push(note('delete-unchanged'));
  const { a, b } = await peers(t, records);
  await a.edit(TOOLS, (value) => { value.notes = []; });
  await b.edit(TOOLS, (value) => { value.notes[0].body = 'Edited after shared baseline'; value.notes.push(note('only-b')); });
  await saved(a); await conflict(b);
  const preview = await b.api.previewFullDataMerge();
  const changed = preview.rows.find((row) => row.kind === 'note' && row.local?.id === 'shared-note');
  const unchanged = preview.rows.find((row) => row.kind === 'note' && row.local?.id === 'delete-unchanged');
  assert.equal(changed.status, 'deleted'); assert.equal(changed.conflict, true); assert.equal(changed.choice, 'local');
  assert.equal(unchanged.status, 'deleted'); assert.equal(unchanged.conflict, false);
  await b.api.applyFullDataMerge({ token: preview.token });
  assert.deepEqual((await b.value(TOOLS)).notes.map((item) => item.id).sort(), ['only-b', 'shared-note']);
  await saved(b); await saved(a);
  assert.deepEqual((await a.syncDataStore.snapshot()).records, (await b.syncDataStore.snapshot()).records);
});

test('tag rename and folder movement combine with independent metadata and folder-name edits through encrypted snapshots', async (t) => {
  const records = initial(), nav = records.find((item) => item.key === NAV).value.state;
  nav.entries = [{ ...site('folder'), type: 'folder' }, site('child', 0, 'folder')]; delete nav.entries[0].url;
  records.push(record(PREFS, { version: 1, revision: 0, aliases: {}, privateKeys: [], library: { version: 1,
    tags: [{ id: 'stable-tag', name: 'Original' }], items: { 'note:shared-note': { description: 'Original description', tagIds: ['stable-tag'] } } } }));
  const { a, b } = await peers(t, records);
  await a.edit(PREFS, (value) => { value.library.tags[0].name = 'Renamed tag'; });
  await b.edit(PREFS, (value) => { value.library.items['note:shared-note'].description = 'Other device description'; });
  await a.edit(NAV, (value) => { value.state.entries[0].page = 1; value.state.entries[0].position = { row: 1, column: 2 }; });
  await b.edit(NAV, (value) => { value.state.entries[0].name = 'Renamed folder'; });
  await saved(a); await conflict(b);
  const preview = await b.api.previewFullDataMerge();
  const folderRow = preview.rows.find((row) => row.kind === 'navigation' && row.local?.id === 'folder');
  assert.equal(folderRow.status, 'both'); assert.equal(folderRow.conflict, false); assert.equal(folderRow.choice, 'merged');
  assert.ok(preview.rows.some((row) => row.kind === 'tag' && row.status === 'one'));
  await b.api.applyFullDataMerge({ token: preview.token });
  const mergedNav = await b.value(NAV), mergedPrefs = await b.value(PREFS);
  const folder = mergedNav.state.entries.find((entry) => entry.id === 'folder');
  assert.equal(folder.name, 'Renamed folder'); assert.equal(folder.page, 1); assert.deepEqual(folder.position, { row: 1, column: 2 });
  assert.equal(mergedNav.state.entries.find((entry) => entry.id === 'child').parentId, 'folder');
  assert.deepEqual(mergedPrefs.library.tags, [{ id: 'stable-tag', name: 'Renamed tag' }]);
  assert.deepEqual(mergedPrefs.library.items['note:shared-note'], { description: 'Other device description', tagIds: ['stable-tag'] });
  await saved(b); await saved(a);
  assert.deepEqual((await a.syncDataStore.snapshot()).records, (await b.syncDataStore.snapshot()).records);
});

test('local edits and later remote revisions invalidate a merge preview without committing any choice', async (t) => {
  const { a, b } = await conflictingPeers(t);
  const localPreview = await b.api.previewFullDataMerge();
  await b.edit(TOOLS, (value) => { value.notes[0].title = 'Later local edit'; });
  const local = await b.syncDataStore.snapshot(), metadata = await b.store.read();
  await assert.rejects(b.api.applyFullDataMerge({ token: localPreview.token }), stale);
  assert.deepEqual(await b.syncDataStore.snapshot(), local); assert.deepEqual(await b.store.read(), metadata);
  const remotePreview = await b.api.previewFullDataMerge();
  await a.edit(TOOLS, (value) => { value.notes[0].title = 'Later remote edit'; }); await saved(a);
  await assert.rejects(b.api.applyFullDataMerge({ token: remotePreview.token }), stale);
  assert.deepEqual(await b.syncDataStore.snapshot(), local); assert.deepEqual(await b.store.read(), metadata);
  assert.equal(await b.api.getFullDataMergeRecovery(), false);
});

test('a late CAS race and a failed atomic commit preserve metadata and leave no misleading recovery point', async (t) => {
  const { b } = await conflictingPeers(t);
  const preview = await b.api.previewFullDataMerge(), before = await b.syncDataStore.snapshot(), metadata = await b.store.read();
  b.failCommit = true;
  await assert.rejects(b.api.applyFullDataMerge({ token: preview.token }));
  assert.deepEqual(await b.syncDataStore.snapshot(), before); assert.deepEqual(await b.store.read(), metadata);
  assert.equal(await b.api.getFullDataMergeRecovery(), false);
  const racedPreview = await b.api.previewFullDataMerge();
  b.raceApply = true;
  await assert.rejects(b.api.applyFullDataMerge({ token: racedPreview.token }));
  const raced = await b.syncDataStore.snapshot();
  assert.deepEqual(raced.records.filter((item) => item.key !== 'covelet.racing.v1'), before.records);
  assert.deepEqual(await b.value('covelet.racing.v1'), { retained: true });
  assert.deepEqual(await b.store.read(), metadata); assert.equal(await b.api.getFullDataMergeRecovery(), false);
});

test('undo after publication restores the pre-merge snapshot with a new causal clock and converges', async (t) => {
  const { a, b } = await conflictingPeers(t), before = await b.syncDataStore.snapshot();
  const preview = await b.api.previewFullDataMerge();
  await b.api.applyFullDataMerge({ token: preview.token });
  const mergedClock = (await b.store.read()).metadata.document.clock;
  await saved(b); await saved(a); await saved(b);
  assert.equal(await b.api.getFullDataMergeRecovery(), true);
  await b.api.undoFullDataMerge();
  assert.deepEqual((await b.syncDataStore.snapshot()).records, before.records);
  assert.ok((await b.store.read()).metadata.document.clock > mergedClock);
  assert.equal(await b.api.getFullDataMergeRecovery(), false);
  await saved(b); await saved(a); await saved(b);
  assert.deepEqual((await a.syncDataStore.snapshot()).records, before.records);
});

test('undo remains unavailable after a later edit and retains both that edit and the recovery point', async (t) => {
  const { b } = await conflictingPeers(t);
  const preview = await b.api.previewFullDataMerge(); await b.api.applyFullDataMerge({ token: preview.token });
  await b.edit(TOOLS, (value) => { value.notes[0].body = 'Do not overwrite this later edit'; });
  const later = await b.syncDataStore.snapshot(), metadata = await b.store.read(), recovery = await b.syncDataStore.readMergeRecovery();
  await assert.rejects(b.api.undoFullDataMerge(), stale);
  assert.deepEqual(await b.syncDataStore.snapshot(), later); assert.deepEqual(await b.store.read(), metadata);
  assert.deepEqual(await b.syncDataStore.readMergeRecovery(), recovery);
});

test('undo refuses a later remote revision while preserving its local merge and recovery point', async (t) => {
  const { a, b } = await conflictingPeers(t);
  const preview = await b.api.previewFullDataMerge(); await b.api.applyFullDataMerge({ token: preview.token });
  const merged = await b.syncDataStore.snapshot(), metadata = await b.store.read(), recovery = await b.syncDataStore.readMergeRecovery();
  await a.edit(TOOLS, (value) => { value.notes[0].body = 'A later remote change'; }); await saved(a);
  await assert.rejects(b.api.undoFullDataMerge(), stale);
  assert.deepEqual(await b.syncDataStore.snapshot(), merged); assert.deepEqual(await b.store.read(), metadata);
  assert.deepEqual(await b.syncDataStore.readMergeRecovery(), recovery);
});

test('a merge cannot append index 2001 and preserves all local content, causal metadata and recovery', async (t) => {
  const { cloud, a, b } = await peers(t);
  // Produce a real, authenticated latest index with enough lower causal clock
  // numbers to fill the directory without inventing a newer encrypted document.
  const config = await a.store.read(), actor = config.metadata.document.actor;
  config.metadata.document.clock = 1999;
  config.metadata.publishedClock = 1999;
  config.metadata.documents[actor] = copy(config.metadata.document);
  await a.store.write(config);
  await a.edit(TOOLS, (value) => { value.notes[0].body = 'Remote revision at clock 2000'; });
  await b.edit(TOOLS, (value) => { value.notes[0].body = 'Retain local revision'; value.notes.push(note('only-b')); });
  await saved(a);
  assert.equal((await a.store.read()).metadata.document.clock, 2000);
  for (let clock = 2; cloud.indexes.size < 2000; clock++) {
    assert.ok(clock < 2000);
    cloud.indexes.set(`covelet-${actor}-${clock}-${clock.toString(16).padStart(64, '0')}.json`, new Uint8Array([1]));
  }
  await conflict(b);
  const preview = await b.api.previewFullDataMerge(), before = await b.syncDataStore.snapshot(), metadata = await b.store.read();
  const recovery = await b.syncDataStore.readMergeRecovery(), blobs = cloud.blobs.size;
  await assert.rejects(b.api.applyFullDataMerge({ token: preview.token }), { code: 'DATA_SYNC_CAPACITY' });
  assert.deepEqual(await b.syncDataStore.snapshot(), before); assert.deepEqual(await b.store.read(), metadata);
  assert.deepEqual(await b.syncDataStore.readMergeRecovery(), recovery);
  assert.equal(cloud.indexes.size, 2000); assert.equal(cloud.blobs.size, blobs, 'No partial remote upload occurs.');
});

function fillRemoteBlobs(cloud) {
  for (let sequence = 1; cloud.blobs.size < 2000; sequence++) {
    // Existing unreferenced encrypted objects count toward the directory limit.
    // They have valid immutable names but are never selected or decoded.
    cloud.blobs.set(`covelet-${'f'.repeat(32)}-1-${sequence.toString(16).padStart(64, '0')}.json`, new Uint8Array([1]));
  }
}

test('a merge stops before adding chunks beyond 2000 even when only asset capacity changes after preview', async (t) => {
  const { cloud, b } = await conflictingPeers(t);
  const preview = await b.api.previewFullDataMerge(), before = await b.syncDataStore.snapshot(), metadata = await b.store.read();
  const recovery = await b.syncDataStore.readMergeRecovery(), indexes = cloud.indexes.size;
  fillRemoteBlobs(cloud);
  await assert.rejects(b.api.applyFullDataMerge({ token: preview.token }), { code: 'DATA_SYNC_CAPACITY' });
  assert.deepEqual(await b.syncDataStore.snapshot(), before); assert.deepEqual(await b.store.read(), metadata);
  assert.deepEqual(await b.syncDataStore.readMergeRecovery(), recovery);
  assert.equal(cloud.blobs.size, 2000); assert.equal(cloud.indexes.size, indexes);
});

test('undo retains the merged state and recovery copy if its new causal index would exceed chunk capacity', async (t) => {
  const { cloud, b } = await conflictingPeers(t);
  const preview = await b.api.previewFullDataMerge(); await b.api.applyFullDataMerge({ token: preview.token });
  await saved(b);
  const before = await b.syncDataStore.snapshot(), metadata = await b.store.read(), recovery = await b.syncDataStore.readMergeRecovery();
  const indexes = cloud.indexes.size;
  fillRemoteBlobs(cloud);
  await assert.rejects(b.api.undoFullDataMerge(), { code: 'DATA_SYNC_CAPACITY' });
  assert.deepEqual(await b.syncDataStore.snapshot(), before); assert.deepEqual(await b.store.read(), metadata);
  assert.deepEqual(await b.syncDataStore.readMergeRecovery(), recovery);
  assert.equal(cloud.blobs.size, 2000); assert.equal(cloud.indexes.size, indexes);
});

test('a deleted folder with a retained modified child stops atomically until its folder choice is repaired', async (t) => {
  const records = initial(), navigation = records.find(item => item.key === NAV).value.state;
  const folder = { ...site('folder'), type: 'folder' }; delete folder.url;
  navigation.entries = [folder, site('child', 0, 'folder')];
  const { a, b } = await peers(t, records);
  await a.edit(NAV, value => { value.state.entries = []; });
  await b.edit(NAV, value => { value.state.entries.find(item => item.id === 'child').name = 'Keep edited child'; });
  await saved(a); await conflict(b);
  const preview = await b.api.previewFullDataMerge(), before = await b.syncDataStore.snapshot(), checkpoint = await b.store.read();
  await assert.rejects(b.api.applyFullDataMerge({ token: preview.token }), error => error.code === 'DATA_SYNC_INVALID');
  assert.deepEqual(await b.syncDataStore.snapshot(), before); assert.deepEqual(await b.store.read(), checkpoint);
  assert.equal(await b.api.getFullDataMergeRecovery(), false);
  const folderRow = preview.rows.find(row => row.local?.id === 'folder');
  await b.api.applyFullDataMerge({ token: preview.token, choices: { [folderRow.id]: 'local' } });
  await saved(b); await saved(a);
  assert.equal((await a.value(NAV)).state.entries.find(item => item.id === 'child').name, 'Keep edited child');
  assert.deepEqual((await a.syncDataStore.snapshot()).records, (await b.syncDataStore.snapshot()).records);
});
