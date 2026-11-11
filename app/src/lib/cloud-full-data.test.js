import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createWebdavProvider } from './cloud-webdav.js';
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
    snapshotStore: storage.syncDataStore, fullHistoryStore: recordStore('covelet.data-sync.runs.v1'),
    fullPendingStore: storage.createEncryptedStore('full-data-pending'),
    providerFactory: cloud.factory, signer, crypto: webcrypto, hasPermission: async () => true, uuid: () => actor.repeat(32), locks: null,
    eventWindow: null, eventDocument: null, ...options });
  return { api, ...storage, disk, sessionStore, configStore, toolSyncStore, toolsStore, stateStore };
}
const configure = (subject) => subject.api.saveCloudSyncSettings(profile, secrets, password);
const saved = async (subject) => { const result = await subject.api.syncCloudNow(); assert.equal(result.phase, 'saved', `${result.code}: ${result.message}`); return result; };
const valueOf = async (subject, key) => (await subject.localData.get(key))[key];

test('encrypted full-data sync preserves metadata and rejects invalid libraries before any cloud publication', async () => {
  const cloud = remote(), a = device(cloud, 'a'), b = device(cloud, 'b'), key = 'covelet.content.preferences.v1';
  const library = { version: 1, tags: [{ id: 'tag-release', name: 'Release' }], items: {
    'site:a': { description: 'Deployment reference', tagIds: ['tag-release'] },
    'note:a': { description: '', tagIds: ['tag-release'] },
  } };
  await a.localData.set({ [key]: { version: 1, revision: 1, aliases: {}, privateKeys: [], presentation: false, library } });
  await configure(a); await configure(b); await saved(a); await saved(b);
  assert.deepEqual((await valueOf(b, key)).library, library);
  assert(![...cloud.areas.values()].some((objects) => [...objects.values()].some((bytes) => decoder.decode(bytes).includes('Deployment reference'))));
  const before = await valueOf(b, key), calls = cloud.calls.length;
  await b.localData.set({ [key]: { ...before, library: { ...library, version: 99 } } });
  const result = await b.api.syncCloudNow();
  assert.equal(result.phase, 'error');
  assert.equal(cloud.calls.slice(calls).filter((call) => call[1] === 'write').length, 0);
  assert.deepEqual((await valueOf(a, key)).library, library);
  await a.close(); await b.close();
});

test('metadata larger than the legacy 512 KiB envelope synchronizes through bounded full-data chunks', async () => {
  const cloud = remote(), a = device(cloud, 'a'), b = device(cloud, 'b'), key = 'covelet.content.preferences.v1';
  const library = { version: 1, tags: [], items: Object.fromEntries(Array.from({ length: 700 }, (_, index) => [`site:large-${index}`, { description: 'a'.repeat(1000), tagIds: [] }])) };
  assert(encoder.encode(JSON.stringify(library)).length > 512 * 1024);
  await a.localData.set({ [key]: { version: 1, revision: 1, aliases: {}, privateKeys: [], presentation: false, library } });
  await configure(a); await configure(b); await saved(a); await saved(b);
  assert.deepEqual((await valueOf(b, key)).library, library);
  assert([...cloud.areas.values()].some((objects) => objects.size > 3));
  await a.close(); await b.close();
});

test('a legacy connection remembers its credentials after a successful full-data sync only', async () => {
  const cloud = remote(), source = device(cloud, 'a'), legacy = device(cloud, 'b');
  const oldConfig = { version: 1, profile, autoSync: false, metadata: null };
  await legacy.configStore.write(oldConfig);
  await configure(source);
  await source.localData.set({ 'covelet.legacy-vault-test.v1': { value: 'remote record' } });
  await saved(source);

  await assert.rejects(legacy.api.unlockCloudSync(undefined, password), { code: 'CLOUD_CREDENTIALS_REQUIRED' });
  await legacy.api.unlockCloudSync(secrets, 'incorrect legacy password');
  assert.equal((await legacy.api.syncCloudNow()).code, 'CLOUD_DECRYPT');
  assert.deepEqual(await legacy.configStore.read(), oldConfig);
  assert.equal((await legacy.api.loadCloudSyncSettings()).credentialsStored, false);

  await legacy.api.lockCloudSync();
  await legacy.api.unlockCloudSync(secrets, password);
  await saved(legacy);
  assert.equal((await legacy.api.loadCloudSyncSettings()).credentialsStored, true);
  assert.deepEqual((await legacy.api.getCloudSyncRuns()).map(run => run.outcome), ['success', 'failure']);
  const config = await legacy.configStore.read();
  assert.equal(typeof config.credentialEnvelope, 'string');
  assert.ok(!JSON.stringify(config).includes(secrets.token));
  assert.ok(!JSON.stringify(config).includes(password));
  assert.ok(!(await legacy.syncDataStore.snapshot()).records.some(record => ['covelet.cloud.local.v1', 'covelet.data-sync.runs.v1'].includes(record.key)));
  await legacy.api.lockCloudSync();
  const requestCount = cloud.calls.length;
  assert.equal((await legacy.api.unlockCloudSync(undefined, password)).unlocked, true);
  assert.equal(cloud.calls.length, requestCount);
  assert.deepEqual(await valueOf(legacy, 'covelet.legacy-vault-test.v1'), { value: 'remote record' });
  await source.close(); await legacy.close();
});

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
  await saved(a); assert.equal((await b.api.syncCloudNow()).phase, 'conflict'); await saved(a);
  assert.equal(await valueOf(a, key), undefined); assert.equal((await valueOf(b, key)).body, 'offline recoverable body', 'unresolved conflict keeps the local record');
  const conflicts = await b.api.getCloudSyncConflicts();
  assert.equal(conflicts.length, 2); assert.ok(conflicts.every((item) => item.namespace === 'preferences' && item.key === key && !Object.hasOwn(item, 'value')));
  const preview = await b.api.previewCloudSyncConflict(conflicts.find(item => item.deleted).id);
  assert.equal(preview.remote.deleted, true); assert.equal(preview.local.value.body, 'offline recoverable body');
  assert.equal((await b.api.resolveCloudSyncConflicts('local')).phase, 'saved'); await saved(a);
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


test('unified WebDAV errors preserve actionable Chinese codes and copy through full-data status', async () => {
  const dav = { provider: 'webdav', endpoint: 'https://cloud.example.test/dav/', prefix: 'covelet' };
  for (const [status, code, text] of [[401, 'CLOUD_AUTH', /用户名和应用密码/], [403, 'CLOUD_FORBIDDEN', /无法访问此目录/]]) {
    const subject = device(remote(), 'a', { legacySeed: false, providerFactory: (profile, secrets, options) => createWebdavProvider(profile, secrets, {
      ...options, fetcher: async () => new Response('PRIVATE-RESPONSE', { status }),
    }) });
    await subject.api.saveCloudSyncSettings(dav, { username: 'fake', appPassword: 'fake-app-password' }, password);
    const result = await subject.api.syncCloudNow();
    assert.equal(result.code, code); assert.match(result.message, text); assert.ok(!result.message.includes('PRIVATE-RESPONSE'));
    await subject.close();
  }
});

test('a blocked active-privacy deletion leaves conflict clocks unresolved, then an explicit choice succeeds after local unlock', async () => {
  const cloud = remote(), a = device(cloud, 'a'), b = device(cloud, 'b'), key = 'covelet.content.preferences.v1';
  await a.localData.set({ [key]: { version: 1, revision: 1, presentation: false, aliases: {}, privateKeys: [] } });
  await configure(a); await configure(b); await saved(a); await saved(b); await saved(a);
  await a.localData.remove(key);
  await b.localData.set({ [key]: { version: 1, revision: 2, presentation: true, aliases: { 'site:one': 'private alias' }, privateKeys: ['site:one'] } });
  await saved(a); assert.equal((await b.api.syncCloudNow()).phase, 'conflict');
  const before = await valueOf(b, 'covelet.data-sync.v1');
  assert.equal((await b.api.resolveCloudSyncConflicts('remote')).code, 'LOCAL_DATA_PRIVACY_CONFLICT');
  assert.deepEqual(await valueOf(b, 'covelet.data-sync.v1'), before);
  assert.equal((await b.api.getCloudSyncConflicts()).length, 2); assert.equal((await valueOf(b, key)).presentation, true);
  await b.localData.set({ [key]: { ...await valueOf(b, key), presentation: false } });
  assert.equal((await b.api.resolveCloudSyncConflicts('remote')).phase, 'saved');
  assert.equal(await valueOf(b, key), undefined); await saved(a);
  assert.equal((await a.api.getCloudSyncConflicts()).length, 0);
  await a.close(); await b.close();
});

// Real WebDAV adapter, independent encrypted devices, in-memory HTTPS responses.
function strictWebdav() {
  const base = 'https://dav.example.test/dav/', prefix = 'acceptance';
  const directories = new Set([new URL(prefix + '/', base).pathname]), objects = new Map(), calls = [];
  let unknownPut = false;
  const row = (path, bytes) => `<d:response><d:href>${path}</d:href><d:propstat><d:prop><d:resourcetype>${bytes ? '' : '<d:collection/>'}</d:resourcetype>${bytes ? `<d:getcontentlength>${bytes.length}</d:getcontentlength>` : ''}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const fetcher = async (address, request) => {
    const url = new URL(address), name = url.pathname;
    calls.push({ url: address, method: request.method, body: request.body?.slice() });
    assert.equal(url.origin, 'https://dav.example.test');
    assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error'); assert.equal(request.referrer, '');
    if (request.method === 'PROPFIND') {
      if (!directories.has(name)) return new Response('', { status: 404 });
      let rows = row(name);
      if (request.headers.depth === '1') {
        for (const [path, bytes] of objects) if (path.startsWith(name) && !path.slice(name.length).includes('/')) rows += row(path, bytes);
        for (const path of directories) if (path !== name && path.startsWith(name) && !path.slice(name.length, -1).includes('/')) rows += row(path);
      }
      return new Response(`<d:multistatus xmlns:d="DAV:">${rows}</d:multistatus>`, { status: 207 });
    }
    if (request.method === 'MKCOL') {
      if (directories.has(name)) return new Response('', { status: 405 });
      if (!directories.has(name.slice(0, -1).replace(/[^/]+$/, ''))) return new Response('', { status: 409 });
      directories.add(name); return new Response('', { status: 201 });
    }
    if (request.method === 'GET') return new Response(objects.get(name) || '', { status: objects.has(name) ? 200 : 404 });
    assert.equal(request.method, 'PUT'); assert.equal(request.headers['if-none-match'], '*');
    if (!directories.has(name.replace(/[^/]+$/, ''))) return new Response('', { status: 409 });
    if (objects.has(name)) return new Response('', { status: 412 });
    objects.set(name, request.body.slice());
    if (unknownPut) { unknownPut = false; throw new TypeError('synthetic response lost after server commit'); }
    return new Response('', { status: 201 });
  };
  return { calls, objects, profile: { provider: 'webdav', endpoint: base, prefix },
    secrets: { username: 'SYNTHETIC-USER', appPassword: 'SYNTHETIC-APP-PASSWORD' },
    factory: (profile, secrets, options) => createWebdavProvider(profile, secrets, { ...options, fetcher }),
    set unknownPut(value) { unknownPut = value; } };
}

test('two encrypted WebDAV devices exchange edits, offline deletion, explicit conflicts and session retry ciphertext', async () => {
  const cloud = strictWebdav(), a = device(cloud, 'a'), b = device(cloud, 'b');
  try {
    const navigation = createEmptyState(); navigation.entries.push(site('dual-device'));
    await a.localData.set({ [NAV]: { version: 1, state: navigation, snapshots: [] } });
    for (const subject of [a, b]) await subject.api.saveCloudSyncSettings(cloud.profile, cloud.secrets, password);
    await saved(a); await saved(b);
    assert.equal((await valueOf(b, NAV)).state.entries[0].id, 'dual-device');
    const next = await b.stateStore.loadState(); next.entries[0].name = 'Edited on B';
    await b.stateStore.saveState(next, next.revision); await saved(b); await saved(a);
    assert.equal((await valueOf(a, NAV)).state.entries[0].name, 'Edited on B');
    await a.localData.set({ 'covelet.offline.v1': { body: 'initial' } }); await saved(a); await saved(b);
    await a.localData.remove('covelet.offline.v1'); await b.localData.set({ 'covelet.offline.v1': { body: 'offline B' } });
    await saved(a); assert.equal((await b.api.syncCloudNow()).phase, 'conflict');
    assert.equal((await valueOf(b, 'covelet.offline.v1')).body, 'offline B');
    assert.equal((await b.api.resolveCloudSyncConflicts('remote')).phase, 'saved'); await saved(a);
    assert.equal(await valueOf(a, 'covelet.offline.v1'), undefined); assert.equal(await valueOf(b, 'covelet.offline.v1'), undefined);
    await b.localData.set({ 'covelet.retry.v1': { body: 'retry after lost response' } }); cloud.unknownPut = true;
    assert.equal((await b.api.syncCloudNow()).phase, 'error');
    assert.ok((await valueOf(b, 'covelet.data-sync.v1')).metadata.pending);
    await b.api.lockCloudSync(); await b.sessionStore.clear();
    assert.equal((await b.api.loadCloudSyncSettings()).unlocked, false);
    await b.api.unlockCloudSync(cloud.secrets, password); await saved(b); await saved(a);
    assert.equal((await valueOf(a, 'covelet.retry.v1')).body, 'retry after lost response');
    assert.equal((await valueOf(b, 'covelet.data-sync.v1')).metadata.pending, null);
    const putCount = cloud.calls.filter(call => call.method === 'PUT').length;
    await saved(a); await saved(b);
    assert.equal(cloud.calls.filter(call => call.method === 'PUT').length, putCount, 'unchanged repeated sync writes nothing');
  } finally { await a.close(); await b.close(); }
});

test('different device languages cannot create sync conflicts or overwrite either device preference', async () => {
  const cloud = strictWebdav(), a = device(cloud, 'a'), b = device(cloud, 'b');
  try {
    await a.localData.set({ 'covelet.language.v1': 'zh-CN', 'covelet.shared.v1': 'portable' });
    await b.localData.set({ 'covelet.language.v1': 'en' });
    for (const subject of [a, b]) await subject.api.saveCloudSyncSettings(cloud.profile, cloud.secrets, password);
    await saved(a); await saved(b); await saved(a);
    assert.deepEqual(await a.api.getCloudSyncConflicts(), []);
    assert.deepEqual(await b.api.getCloudSyncConflicts(), []);
    assert.equal(await valueOf(a, 'covelet.language.v1'), 'zh-CN');
    assert.equal(await valueOf(b, 'covelet.language.v1'), 'en');
    assert.equal(await valueOf(b, 'covelet.shared.v1'), 'portable');
    assert.ok((await a.syncDataStore.snapshot()).records.every(item => item.key !== 'covelet.language.v1'));
  } finally { await a.close(); await b.close(); }
});
