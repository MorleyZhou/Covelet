import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCloudSync } from './cloud-sync.js';
import { createLocalData } from './local-data.js';
import { createEmptyState } from './model.js';
import { createSyncWasm } from './sync-wasm.js';
import { decryptCloudPayload } from './cloud-crypto.js';

const clone = (value) => structuredClone(value), encoder = new TextEncoder(), decoder = new TextDecoder();
const signer = await createSyncWasm(await readFile(new URL('../wasm/sync-core.wasm', import.meta.url)));
const png = new Uint8Array(await readFile(new URL('../../public/icons/icon-128.png', import.meta.url)));
const profile = { provider: 'github', owner: 'synthetic-full-sync', repo: 'private-synthetic', branch: 'main', prefix: 'facade-tests' };
const secrets = { token: 'SYNTHETIC-SESSION-TOKEN-DO-NOT-PERSIST' }, password = 'synthetic facade full data password';
const NAV = 'owntab.local.v1', TOOLS = 'covelet.tools.v1';
const emptyTools = () => ({ version: 3, revision: 0, notes: [], reading: [], snapshots: [], trash: [] });
const note = (id, body) => ({ id, title: id, body, revision: 1, createdAt: 1, updatedAt: 2, pinned: false });
const site = (id) => ({ id, type: 'site', name: id, url: `https://${id}.example/`, groupId: 'group-home', parentId: null,
  icon: { kind: 'letter', value: id.slice(0, 2) }, order: 0 });
let serial = 0;
function memory(initial = null) {
  let value = clone(initial);
  return { async read() { return clone(value); }, async write(next) { value = clone(next); }, async clear() { value = null; }, get value() { return clone(value); } };
}
function backend() {
  const records = new Map(); let key;
  return {
    records, getKey: async () => key, ensureKey: async (candidate) => key ||= candidate,
    get: async (id) => clone(records.get(id)),
    entries: async (space) => [...records.values()].filter((record) => space === undefined || record.space === space).map(clone),
    put: async (values) => { for (const record of values) records.set(record.id, clone(record)); },
    remove: async (ids) => { for (const id of ids) records.delete(id); },
    commit: async (values, ids) => {
      const next = new Map(records); for (const id of ids) next.delete(id); for (const record of values) next.set(record.id, clone(record));
      records.clear(); for (const [id, record] of next) records.set(id, record);
    },
  };
}
function remote() {
  const areas = new Map(), calls = [];
  const area = (prefix) => { if (!areas.has(prefix)) areas.set(prefix, new Map()); return areas.get(prefix); };
  return { areas, calls, factory(config, suppliedSecrets, { beforeRequest } = {}) {
    assert.equal(suppliedSecrets.token, secrets.token);
    const values = area(config.prefix);
    return {
      async list() { await beforeRequest?.(); calls.push([config.prefix, 'list']); return [...values].map(([name, bytes]) => ({ name, size: bytes.length })); },
      async read(name) { await beforeRequest?.(); calls.push([config.prefix, 'read', name]); return values.get(name)?.slice(); },
      async write(name, bytes) {
        await beforeRequest?.(); calls.push([config.prefix, 'write', name]);
        if (values.has(name)) assert.deepEqual(bytes, values.get(name), 'Immutable object retries cannot change ciphertext.');
        values.set(name, bytes.slice());
      },
    };
  } };
}
function device(cloud, actor, options = {}) {
  const disk = backend(), storage = createLocalData({ backend: disk, crypto: webcrypto, databaseName: `full-facade-${++serial}`,
    legacyLocal: null, localStorage: null, broadcastChannel: null, locks: null });
  const { localData } = storage, sessionStore = memory();
  const recordStore = (key) => ({ async read() { return (await localData.get(key))[key] ?? null; }, async write(value) { await localData.set({ [key]: value }); } });
  const stateStore = {
    async loadState() { return (await localData.get(NAV))[NAV]?.state || createEmptyState(); },
    async saveState(next, expectedRevision) {
      const envelope = (await localData.get(NAV))[NAV], previous = envelope?.state || createEmptyState();
      if (previous.revision !== expectedRevision) throw Object.assign(Error('revision conflict'), { code: 'REVISION_CONFLICT' });
      const state = { ...clone(next), revision: expectedRevision + 1 };
      await localData.set({ [NAV]: { version: 1, state, snapshots: [previous, ...(envelope?.snapshots || [])].slice(0, 3) } }); return state;
    },
    subscribeState(listener) { return localData.subscribe((changes) => { if (changes[NAV]) listener(changes[NAV].newValue?.state || createEmptyState()); }); },
  };
  const toolsStore = {
    async loadPersonalTools() { return (await localData.get(TOOLS))[TOOLS] || emptyTools(); },
    async applySyncedPersonalTools(value, { expectedRevision }) {
      const previous = await toolsStore.loadPersonalTools();
      if (previous.revision !== expectedRevision) throw Object.assign(Error('revision conflict'), { code: 'REVISION_CONFLICT' });
      const next = { ...previous, ...clone(value), revision: previous.revision + 1 }; await localData.set({ [TOOLS]: next }); return next;
    },
    subscribePersonalTools(listener) { return localData.subscribe((changes) => { if (changes[TOOLS]) listener(changes[TOOLS].newValue || emptyTools()); }); },
  };
  const configStore = recordStore('covelet.cloud.local.v1'), toolSyncStore = recordStore('covelet.tools.cloud.v1');
  const api = createCloudSync({ stateStore, configStore, sessionStore, toolSyncStore, toolsStore,
    snapshotStore: storage.syncDataStore, fullSyncStore: recordStore('covelet.data-sync.v1'), fullPendingStore: storage.createEncryptedStore('full-data-pending'),
    providerFactory: cloud.factory, signer, crypto: webcrypto, hasPermission: async () => true, uuid: () => actor.repeat(32), locks: null,
    eventWindow: null, eventDocument: null, ...options });
  return { api, ...storage, disk, sessionStore, configStore, toolSyncStore, toolsStore, stateStore };
}
const configure = (subject) => subject.api.saveCloudSyncSettings(profile, secrets, password);
const saved = async (subject) => { const result = await subject.api.syncCloudNow(); assert.equal(result.phase, 'saved', `${result.code}: ${result.message}`); return result; };
const valueOf = async (subject, key) => (await subject.localData.get(key))[key];

test('default cloud facade synchronizes every extension namespace and cached image through encrypted all-data directories', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20), close() {} };
  } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'createImageBitmap', descriptor); else delete globalThis.createImageBitmap; });
  const cloud = remote(), a = device(cloud, 'a'), b = device(cloud, 'b');
  const bytes = new Uint8Array(650 * 1024); bytes.set(png);
  const blob = new Blob([bytes], { type: 'image/png' }), icon = new Blob([png], { type: 'image/png' });
  const navigation = createEmptyState(); navigation.entries.push({ ...site('cached-site'), icon: { kind: 'image', value: 'portable-asset' } });
  await a.localData.set({
    [NAV]: { version: 1, state: { ...navigation, revision: 5 }, snapshots: [], sync: { opaqueLocalOnly: 'legacy-local-metadata' } },
    [TOOLS]: { ...emptyTools(), revision: 9, notes: [note('private-note', 'PRIVATE-FACADE-NOTE')],
      reading: [{ id: 'reading', title: 'reading', url: 'https://reading.example/?q=keep#hash', status: 'unread', revision: 1, createdAt: 1, updatedAt: 2 }],
      snapshots: [{ id: 'snapshot', title: 'snapshot', revision: 1, createdAt: 1, updatedAt: 2, tabs: [{ title: 'tab', url: 'https://tabs.example/', pinned: false }] }],
      trash: [{ id: 'trash', kind: 'notes', deletedAt: 2, record: note('trashed-note', 'TRASH-FACADE-NOTE') }] },
    'covelet.clock.v1.clock-one': { version: 1, revision: 4, mode: 'stopwatch', duration: 60000, notify: false,
      timer: { elapsed: 0, startedAt: 0, running: false, completed: false }, stopwatch: { elapsed: 1234, startedAt: 0, running: false } },
    'covelet.github.calendar.v1': {}, 'covelet.desktop-templates.v1': { version: 1, revision: 3, templates: [] },
    'covelet.content.preferences.v1': { version: 1, revision: 8, aliases: { 'site:cached-site': 'private alias' }, privateKeys: ['site:cached-site'], presentation: true },
    'covelet.privacy.lock.v1': { fakeVerifier: 'DEVICE-PASSWORD-MUST-STAY-HERE' },
    'covelet.recovery-point.v1': { version: 1, id: 'recovery-one', data: { label: 'RECOVERY-FACADE-SENTINEL' } },
    'covelet.future-extension.settings.v1': { enabled: true, preserved: 'FUTURE-FACADE-SENTINEL' },
  });
  await a.createEncryptedStore('assets').set('portable-asset', { id: 'portable-asset', blob, mime: blob.type, createdAt: 1 });
  await a.createEncryptedStore('navigation-icons').set('https://icons.example/app.png', { url: 'https://icons.example/app.png', blob: icon,
    width: 128, height: 128, adaptive: false, vector: false, updatedAt: 1 });
  await a.createEncryptedStore('provider-icons').set('https://search.example', { origin: 'https://search.example', blob: icon, updatedAt: 1 });
  await a.createEncryptedStore('wallpaper').set('current', { version: 1, attemptDay: '20261026', attemptAt: 1, blob: icon });
  await a.createEncryptedStore('future-plugin-cache').set('future-binary', { blob: new Blob(['future extension bytes']) });
  await configure(a); await configure(b); await saved(a); await saved(b); await saved(a);
  const aSnapshot = await a.syncDataStore.snapshot(), bSnapshot = await b.syncDataStore.snapshot();
  assert.equal(aSnapshot.token, bSnapshot.token, 'Device-only revisions, lock state and credentials do not split canonical content.');
  assert.equal((await valueOf(b, NAV)).state.entries[0].icon.value, 'portable-asset');
  assert.equal((await valueOf(b, TOOLS)).notes[0].body, 'PRIVATE-FACADE-NOTE');
  assert.equal((await valueOf(b, TOOLS)).snapshots[0].tabs[0].url, 'https://tabs.example/');
  assert.equal((await valueOf(b, TOOLS)).trash[0].record.body, 'TRASH-FACADE-NOTE');
  assert.equal((await valueOf(b, 'covelet.clock.v1.clock-one')).stopwatch.elapsed, 1234);
  assert.equal((await valueOf(b, 'covelet.content.preferences.v1')).presentation, false, 'Remote hiding never overwrites a device unlock state.');
  assert.equal(await valueOf(b, 'covelet.privacy.lock.v1'), undefined);
  assert.deepEqual(new Uint8Array(await (await b.createEncryptedStore('assets').get('portable-asset')).blob.arrayBuffer()), bytes);
  assert.equal(await (await b.createEncryptedStore('future-plugin-cache').get('future-binary')).blob.text(), 'future extension bytes');
  for (const namespace of ['assets', 'navigation-icons', 'provider-icons', 'wallpaper', 'future-plugin-cache']) assert.equal((await b.createEncryptedStore(namespace).entries()).length, 1);
  const writes = cloud.calls.filter(([, method]) => method === 'write');
  assert.ok(writes.some(([prefix]) => prefix === `${profile.prefix}/all-data-v1`));
  assert.ok(writes.some(([prefix]) => prefix === `${profile.prefix}/all-data-v1/blobs`));
  assert.ok(writes.every(([prefix]) => prefix.startsWith(`${profile.prefix}/all-data-v1`)), 'Default facade does not continue dual-publishing legacy protocols.');
  for (const values of cloud.areas.values()) for (const ciphertext of values.values()) {
    assert.doesNotMatch(decoder.decode(ciphertext), /PRIVATE-FACADE-NOTE|FUTURE-FACADE-SENTINEL|icons\.example/);
    const plaintext = decoder.decode(await decryptCloudPayload(ciphertext, password));
    for (const forbidden of [password, secrets.token, 'DEVICE-PASSWORD-MUST-STAY-HERE', 'legacy-local-metadata']) assert.equal(plaintext.includes(forbidden), false);
  }
  for (const subject of [a, b]) {
    assert.equal(subject.sessionStore.value.password, password);
    assert.equal(JSON.stringify(await subject.localData.get(null)).includes(secrets.token), false);
    assert.equal(JSON.stringify(await subject.localData.get(null)).includes(password), false);
    assert.equal(subject.api.getCloudSyncStatus().phase, 'saved');
  }
  const count = cloud.calls.filter(([, method]) => method === 'write').length; await saved(b);
  assert.equal(cloud.calls.filter(([, method]) => method === 'write').length, count, 'Repeated unchanged facade sync uploads no bytes.');
  await a.close(); await b.close();
});

test('unified facade exposes and deliberately restores all-data concurrent conflicts without the legacy tool opt-in', async () => {
  const cloud = remote(), a = device(cloud, 'a'), b = device(cloud, 'b'), key = 'covelet.future-extension.settings.v1';
  await a.localData.set({ [key]: { body: 'initial' } }); await configure(a); await configure(b);
  await saved(a); await saved(b); await saved(a);
  await a.localData.remove(key); await b.localData.set({ [key]: { body: 'offline recoverable body' } });
  await saved(a); await saved(b); await saved(a);
  assert.equal(await valueOf(a, key), undefined); assert.equal(await valueOf(b, key), undefined);
  const conflicts = await b.api.getCloudSyncConflicts();
  assert.equal(conflicts.length, 2); assert.ok(conflicts.every((item) => item.namespace === 'preferences' && item.key === key && !Object.hasOwn(item, 'value')));
  await b.api.restoreCloudSyncConflict(conflicts.find((item) => !item.deleted).id); await saved(b); await saved(a);
  assert.equal((await valueOf(a, key)).body, 'offline recoverable body'); assert.equal((await a.api.getCloudSyncConflicts()).length, 0);
  assert.equal((await a.toolSyncStore.read())?.enabled || false, false, 'All-data sync does not need the retired independent tools checkbox.');
  await a.close(); await b.close();
});

test('first unified facade sync imports existing v1 navigation and tools while retaining local-only tool collections', async () => {
  const cloud = remote(), legacy = device(cloud, 'c', { fullData: false }), upgraded = device(cloud, 'd');
  const navigation = createEmptyState(); navigation.entries.push(site('legacy-site'));
  await legacy.stateStore.saveState(navigation, 0);
  await legacy.localData.set({ [TOOLS]: { ...emptyTools(), notes: [note('legacy-note', 'LEGACY-REMOTE-NOTE')] } });
  await configure(legacy); await saved(legacy); await legacy.api.setToolSyncEnabled(true);
  assert.equal((await legacy.api.syncToolCloudNow()).phase, 'saved');
  assert.ok(cloud.areas.get(profile.prefix)?.size); assert.ok(cloud.areas.get(`${profile.prefix}/tools-v1`)?.size);
  await upgraded.localData.set({ [TOOLS]: { ...emptyTools(), snapshots: [{ id: 'local-snapshot', title: 'local snapshot', revision: 1,
    createdAt: 1, updatedAt: 2, tabs: [{ title: 'kept local tab', url: 'https://local-tabs.example/', pinned: false }] }] } });
  await configure(upgraded); await saved(upgraded);
  assert.equal((await valueOf(upgraded, NAV)).state.entries[0].id, 'legacy-site');
  const tools = await valueOf(upgraded, TOOLS);
  assert.equal(tools.notes[0].body, 'LEGACY-REMOTE-NOTE'); assert.equal(tools.snapshots[0].id, 'local-snapshot');
  const fresh = device(cloud, 'e'); await configure(fresh); await saved(fresh);
  assert.equal((await valueOf(fresh, NAV)).state.entries[0].id, 'legacy-site');
  assert.equal((await valueOf(fresh, TOOLS)).notes[0].body, 'LEGACY-REMOTE-NOTE');
  const legacyWrites = cloud.calls.filter(([prefix, method]) => method === 'write' && [profile.prefix, `${profile.prefix}/tools-v1`].includes(prefix)).length;
  await saved(upgraded); assert.equal(cloud.calls.filter(([prefix, method]) => method === 'write' && [profile.prefix, `${profile.prefix}/tools-v1`].includes(prefix)).length, legacyWrites);
  for (const subject of [legacy, upgraded, fresh]) await subject.close();
});
