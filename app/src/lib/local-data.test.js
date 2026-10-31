import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createLocalData } from './local-data.js';
import { createEmptyState } from './model.js';

function memoryBackend() {
  const records = new Map(); let encryptionKey;
  return {
    records,
    getKey: async () => encryptionKey,
    ensureKey: async (candidate) => {
      if (!encryptionKey) {
        if (records.size) throw Object.assign(new Error('Device key missing.'), { code: 'LOCAL_DATA_KEY_MISSING' });
        encryptionKey = candidate;
      }
      return encryptionKey;
    },
    forgetKey: () => { encryptionKey = undefined; },
    get: async (id) => structuredClone(records.get(id)),
    entries: async (space) => [...records.values()].filter((record) => space === undefined || record.space === space).map((record) => structuredClone(record)),
    put: async (values) => { for (const value of values) records.set(value.id, structuredClone(value)); },
    remove: async (ids) => { for (const id of ids) records.delete(id); },
    commit: async (values, ids) => {
      const next = new Map(records);
      for (const id of ids) next.delete(id);
      for (const value of values) next.set(value.id, structuredClone(value));
      records.clear(); for (const [key, value] of next) records.set(key, value);
    },
  };
}
let count = 0;
function fixture(options = {}) {
  const backend = options.backend || memoryBackend();
  const storage = createLocalData({ crypto: webcrypto, databaseName: `encrypted-local-test-${++count}`, legacyLocal: null, localStorage: null, broadcastChannel: null, backend, ...options });
  return { ...storage, backend };
}
function legacyArea(initial) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(keys) { const names = keys === null ? [...values.keys()] : typeof keys === 'string' ? [keys] : keys; return Object.fromEntries(names.filter((name) => values.has(name)).map((name) => [name, structuredClone(values.get(name))])); },
    async remove(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) values.delete(key); },
  };
}
function legacyStorage(initial) {
  const values = new Map(Object.entries(initial));
  return { values, get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null, getItem: (key) => values.get(key) ?? null, removeItem: (key) => values.delete(key) };
}

test('JSON data, key names and URLs are encrypted; a second client reads the same non-extractable key', async () => {
  const backend = memoryBackend(), name = `shared-${++count}`;
  const first = fixture({ backend, databaseName: name }), second = fixture({ backend, databaseName: name });
  const value = { title: 'PRIVATE-SENTINEL', urls: ['https://private.example/path'], nested: { enabled: true, number: 2, absent: null } };
  await first.localData.set({ 'covelet.secret': value });
  assert.deepEqual(await second.localData.get('covelet.secret'), { 'covelet.secret': value });
  const record = [...backend.records.values()][0], key = await backend.getKey();
  assert.equal(key.extractable, false); assert.equal(key.algorithm.name, 'AES-GCM');
  assert.deepEqual(Object.keys(record).sort(), ['ciphertext', 'id', 'iv', 'space', 'version']);
  assert.equal(record.id.length, 64); assert.equal(record.iv.byteLength, 12);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE|private\.example|covelet\.secret/);
  assert.doesNotMatch(Buffer.from(record.ciphertext).toString('utf8'), /PRIVATE|private\.example|covelet\.secret/);
  await assert.rejects(webcrypto.subtle.exportKey('raw', key));
  const before = record.ciphertext;
  await first.localData.set({ 'covelet.secret': value });
  assert.notDeepEqual([...backend.records.values()][0].ciphertext, before, 'Each write has a fresh random IV.');
  await first.close(); await second.close();
});

test('encrypted namespaces support Blob bytes directly and isolate identical keys', async () => {
  const storage = fixture(), icons = storage.createEncryptedStore('navigation-icons'), wallpaper = storage.createEncryptedStore('wallpaper');
  const blob = new Blob([new Uint8Array([0, 1, 2, 255, 128])], { type: 'image/png' });
  await icons.set('https://private.example/icon.png', { blob, mime: 'image/png', createdAt: 123 });
  await wallpaper.set('https://private.example/icon.png', { blob: new Blob(['different'], { type: 'image/webp' }) });
  const restored = await icons.get('https://private.example/icon.png');
  assert.equal(restored.mime, 'image/png'); assert.equal(restored.createdAt, 123);
  assert.equal(restored.blob.type, 'image/png'); assert.deepEqual(new Uint8Array(await restored.blob.arrayBuffer()), new Uint8Array(await blob.arrayBuffer()));
  const entries = await icons.entries(); assert.equal(entries.length, 1); assert.equal(entries[0][0], 'https://private.example/icon.png');
  assert.equal(await (await wallpaper.get(entries[0][0])).blob.text(), 'different');
  for (const record of storage.backend.records.values()) assert.doesNotMatch(JSON.stringify(record), /private\.example|image\/png/);
  await icons.remove(entries[0][0]); assert.equal(await icons.get(entries[0][0]), undefined); assert.equal((await wallpaper.entries()).length, 1);
  await storage.close();
});

test('a recovery-like JSON record beyond the former 16 MiB manifest limit round-trips', async () => {
  const storage = fixture();
  // A complete recovery point includes the ZIP as base64 text. This size is
  // valid for recovery and exercises its plain JSON path, not Blob framing.
  const navigation = 'A'.repeat(17 * 1024 * 1024);
  const point = { version: 1, id: 'large-recovery-point', status: 'complete', data: {
    format: 'covelet-complete-backup', version: 1, navigation, tools: { notes: [] },
  } };
  await storage.localData.set({ 'covelet.recovery-point.v1': point });
  const restored = (await storage.localData.get('covelet.recovery-point.v1'))['covelet.recovery-point.v1'];
  assert.equal(restored.id, point.id); assert.equal(restored.data.navigation.length, navigation.length);
  assert.equal(restored.data.navigation, navigation); assert.deepEqual(restored.data.tools, { notes: [] });
  await storage.close();
});

test('concurrent initialization and multi-key writes share a single usable key', async () => {
  const backend = memoryBackend(), databaseName = `concurrent-${++count}`;
  const clients = Array.from({ length: 6 }, () => fixture({ backend, databaseName }));
  await Promise.all(clients.map((client, index) => client.localData.set({ [`key-${index}`]: { value: index } })));
  const all = await clients[0].localData.get(null);
  assert.deepEqual(Object.keys(all).sort(), Array.from({ length: 6 }, (_, index) => `key-${index}`));
  for (let index = 0; index < 6; index++) assert.equal(all[`key-${index}`].value, index);
  await Promise.all(clients.map((client) => client.close()));
});

test('legacy native/localStorage values migrate only after ciphertext verification; session values stay outside', async () => {
  const area = legacyArea({ 'owntab.local.v1': { navigation: 'saved' }, 'covelet.cloud.session.v1': { password: 'session' }, unrelated: 'untouched' });
  const old = legacyStorage({ 'covelet.language.v1': 'zh-CN', 'covelet.tools.v1': JSON.stringify({ notes: [] }), unrelated: 'untouched' });
  const storage = fixture({ legacyLocal: area, localStorage: old });
  assert.deepEqual(await storage.localData.get(null), { 'owntab.local.v1': { navigation: 'saved' }, 'covelet.language.v1': 'zh-CN', 'covelet.tools.v1': { notes: [] } });
  assert.equal(area.values.has('owntab.local.v1'), false); assert.equal(old.values.has('covelet.language.v1'), false);
  assert.equal(area.values.has('covelet.cloud.session.v1'), true); assert.equal(area.values.has('unrelated'), true); assert.equal(old.values.has('unrelated'), true);
  assert.deepEqual(await storage.localData.get({ absent: 'default', 'covelet.language.v1': 'en' }), { absent: 'default', 'covelet.language.v1': 'zh-CN' });
  await storage.close();
});

test('failed encryption persistence or readback never deletes legacy data or falls back to plaintext', async () => {
  const area = legacyArea({ 'owntab.local.v1': { title: 'preserve' } }), backend = memoryBackend();
  backend.put = async () => { throw new Error('Quota exhausted.'); };
  const storage = fixture({ backend, legacyLocal: area });
  await assert.rejects(storage.localData.get('owntab.local.v1'), /Quota/);
  assert.deepEqual(area.values.get('owntab.local.v1'), { title: 'preserve' }); assert.equal(backend.records.size, 0);
  await assert.rejects(storage.localData.set({ another: 'preserve' }), /Quota/);
  assert.equal(area.values.has('another'), false);
  const old = legacyStorage({ 'covelet.tools.v1': '{"notes":[]}' }), corrupt = memoryBackend(), put = corrupt.put;
  corrupt.put = async (records) => { const copies = structuredClone(records); new Uint8Array(copies[0].ciphertext)[0] ^= 1; await put(copies); };
  const second = fixture({ backend: corrupt, localStorage: old });
  await assert.rejects(second.localData.get('covelet.tools.v1'), { code: 'LOCAL_DATA_DECRYPT_FAILED' });
  assert.equal(old.values.get('covelet.tools.v1'), '{"notes":[]}');
  await storage.close(); await second.close();
});

test('conflicting encrypted/native/localStorage copies and concurrent legacy edits are preserved', async () => {
  const area = legacyArea({ 'covelet.tools.v1': { notes: [] } }), old = legacyStorage({ 'covelet.tools.v1': '{"notes":[]}' });
  const storage = fixture({ legacyLocal: area, localStorage: old });
  await storage.localData.get('covelet.tools.v1');
  assert.equal(area.values.size, 0); assert.equal(old.values.size, 0, 'Identical duplicate plaintext copies are both removed.');
  area.values.set('covelet.tools.v1', { notes: ['old page edit'] });
  await assert.rejects(storage.localData.get('covelet.tools.v1'), { code: 'LOCAL_DATA_MIGRATION_CONFLICT' });
  assert.deepEqual(area.values.get('covelet.tools.v1'), { notes: ['old page edit'] });
  assert.equal(storage.backend.records.size, 1);
  area.values.delete('covelet.tools.v1');
  assert.deepEqual(await storage.localData.get('covelet.tools.v1'), { 'covelet.tools.v1': { notes: [] } });
  const differingArea = legacyArea({ 'covelet.language.v1': 'zh-CN' }), differingOld = legacyStorage({ 'covelet.language.v1': 'en' });
  const conflicting = fixture({ legacyLocal: differingArea, localStorage: differingOld });
  await assert.rejects(conflicting.localData.get(null), { code: 'LOCAL_DATA_MIGRATION_CONFLICT' });
  assert.equal(differingArea.values.get('covelet.language.v1'), 'zh-CN'); assert.equal(differingOld.values.get('covelet.language.v1'), 'en');
  const racing = legacyArea({ 'covelet.language.v1': 'zh-CN' }), originalGet = racing.get;
  let reads = 0;
  racing.get = async (keys) => { if (++reads === 2) racing.values.set('covelet.language.v1', 'en'); return originalGet(keys); };
  const concurrent = fixture({ legacyLocal: racing });
  await assert.rejects(concurrent.localData.get('covelet.language.v1'), { code: 'LOCAL_DATA_MIGRATION_CONFLICT' });
  assert.equal(racing.values.get('covelet.language.v1'), 'en'); assert.equal(concurrent.backend.records.size, 1);
  await storage.close(); await conflicting.close(); await concurrent.close();
});

test('tampered ciphertext, moved records and missing keys fail closed without overwriting saved records', async () => {
  const storage = fixture(); await storage.localData.set({ first: { content: 'secret' }, second: 'other' });
  const records = [...storage.backend.records.values()], first = records[0];
  const secondCiphertext = records[1].ciphertext;
  records[1].ciphertext = first.ciphertext;
  await assert.rejects(storage.localData.get('second'), { code: 'LOCAL_DATA_DECRYPT_FAILED' });
  records[1].ciphertext = secondCiphertext;
  new Uint8Array(first.ciphertext)[5] ^= 2;
  await assert.rejects(storage.localData.get('first'), { code: 'LOCAL_DATA_DECRYPT_FAILED' });
  assert.equal(storage.backend.records.size, 2);
  storage.backend.forgetKey();
  await assert.rejects(storage.localData.get('second'), { code: 'LOCAL_DATA_KEY_MISSING' });
  await assert.rejects(storage.localData.set({ newRecord: 'wrong key' }), { code: 'LOCAL_DATA_KEY_MISSING' });
  assert.equal(storage.backend.records.size, 2); await storage.close();
});

test('subscriptions report committed changes and broadcasts contain only encrypted envelopes', async () => {
  const messages = [], channels = [], backend = memoryBackend(), databaseName = `channels-${++count}`;
  const broadcastChannel = () => {
    const channel = { onmessage: null, postMessage(value) { messages.push(structuredClone(value)); for (const other of channels) if (other !== channel) other.onmessage?.({ data: structuredClone(value) }); }, close() {} };
    channels.push(channel); return channel;
  };
  const first = fixture({ backend, databaseName, broadcastChannel }), second = fixture({ backend, databaseName, broadcastChannel });
  const local = [], remote = [];
  const stop = first.localData.subscribe((changes) => local.push(changes));
  second.localData.subscribe((changes) => remote.push(changes));
  await first.localData.set({ 'covelet.secret': 'PRIVATE-MESSAGE' });
  await second.localData.get('covelet.secret'); // Drain remote receiver's serialized work.
  assert.deepEqual(local[0], { 'covelet.secret': { oldValue: undefined, newValue: 'PRIVATE-MESSAGE' } });
  assert.deepEqual(remote[0], local[0]);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE-MESSAGE|covelet\.secret/);
  await first.localData.remove('covelet.secret'); await second.localData.get('covelet.secret');
  assert.deepEqual(remote[1], { 'covelet.secret': { oldValue: 'PRIVATE-MESSAGE', newValue: undefined } });
  stop(); await first.localData.set({ 'covelet.secret': 'after-stop' }); assert.equal(local.length, 2);
  await first.close(); await second.close();
});

test('invalid input is rejected before an atomic write and get results do not share persistent references', async () => {
  const storage = fixture(), circular = {}; circular.self = circular;
  await storage.localData.set({ good: { number: 1 } });
  for (const bad of [undefined, NaN, Infinity, circular, new Date(), { get value() { throw new Error('Never execute.'); } }]) await assert.rejects(storage.localData.set({ good: 'replacement', bad }), { code: 'LOCAL_DATA_INVALID' });
  const restored = await storage.localData.get(['good']); restored.good.number = 99;
  assert.deepEqual(await storage.localData.get(['good']), { good: { number: 1 } });
  await assert.rejects(storage.localData.remove(null), { code: 'LOCAL_DATA_INVALID' });
  await storage.close();
});

test('full sync discovers future namespaces after restart, transfers Blob bytes and retains every device-only key', async () => {
  const source = fixture(), future = source.createEncryptedStore('future-built-in-extension');
  await source.localData.set({ 'covelet.future.settings.v1': { enabled: true, label: 'all-extension-content' }, 'covelet.cloud.local.v1': { target: 'source-target' }, 'covelet.privacy.lock.v1': { verifier: 'never-portable' }, 'covelet.language.v1': 'zh-CN' });
  await future.set('private-key', { palette: [1, 2], image: new Blob([new Uint8Array([2, 3, 255])], { type: 'image/png' }) });
  await source.createEncryptedStore('full-data-pending').set('pending', { ciphertext: 'never-sync-recursively' });
  const reopened = fixture({ backend: source.backend }), portable = await reopened.syncDataStore.snapshot();
  assert.equal(portable.records.length, 2, 'Unknown namespaces are found without registering them in the new context.');
  assert.ok(portable.records.some((record) => record.namespace === 'future-built-in-extension'));
  assert.doesNotMatch(JSON.stringify(portable), /source-target|never-portable|never-sync-recursively/);
  const destination = fixture();
  await destination.localData.set({ 'covelet.cloud.local.v1': { target: 'destination-target' }, 'covelet.tools.cloud.v1': { enabled: false },
    'covelet.data-sync.v1': { actor: 'destination' }, 'covelet.cloud.session.v1': { secret: 'session-only' }, 'covelet.privacy.lock.v1': { verifier: 'destination-password' }, 'covelet.language.v1': 'en', 'covelet.obsolete': { remove: true } });
  const before = await destination.syncDataStore.snapshot(), result = await destination.syncDataStore.apply(portable, { expectedToken: before.token });
  assert.equal(result.token, portable.token); assert.equal(result.changed, 3, 'Two additions and one deletion commit together.');
  const restored = await destination.createEncryptedStore('future-built-in-extension').get('private-key');
  assert.equal(restored.image.type, 'image/png'); assert.deepEqual([...new Uint8Array(await restored.image.arrayBuffer())], [2, 3, 255]);
  const persisted = await destination.localData.get(null);
  assert.deepEqual(persisted['covelet.cloud.local.v1'], { target: 'destination-target' });
  assert.equal(persisted['covelet.privacy.lock.v1'].verifier, 'destination-password');
  assert.equal(persisted['covelet.language.v1'], 'en');
  assert.equal(persisted['covelet.data-sync.v1'].actor, 'destination'); assert.equal(persisted['covelet.obsolete'], undefined);
  const unchanged = await destination.syncDataStore.apply(portable, { expectedToken: result.token });
  assert.equal(unchanged.changed, 0); assert.equal(unchanged.token, result.token);
  await source.close(); await reopened.close(); await destination.close();
});

test('full sync CAS, complete validation and a failed atomic commit preserve all existing namespaces', async () => {
  const storage = fixture(); await storage.localData.set({ 'covelet.future': { keep: true } });
  await storage.createEncryptedStore('future-images').set('same', new Blob(['old']));
  const before = await storage.syncDataStore.snapshot();
  const incoming = { version: 1, records: [{ namespace: 'preferences', key: 'covelet.future', value: { replace: true } }, { namespace: 'future-images', key: 'same', value: new Blob(['new']) }] };
  await storage.localData.set({ 'covelet.racing-tab': { saved: 'later' } });
  await assert.rejects(storage.syncDataStore.apply(incoming, { expectedToken: before.token }), { code: 'REVISION_CONFLICT' });
  assert.equal((await storage.localData.get('covelet.future'))['covelet.future'].keep, true);
  const current = await storage.syncDataStore.snapshot();
  for (const bad of [
    { version: 1, records: [...incoming.records, { namespace: 'preferences', key: 'covelet.content.preferences.v1', value: { version: 999 } }] },
    { version: 1, records: [...incoming.records, incoming.records[0]] },
    { version: 1, records: [{ namespace: 'preferences', key: 'covelet.privacy.lock.v1', value: { replace: 'password' } }] },
    { version: 1, records: [{ namespace: 'full-data-pending', key: 'recursive', value: 'forbidden' }] },
  ]) await assert.rejects(storage.syncDataStore.apply(bad, { expectedToken: current.token }));
  assert.equal((await storage.syncDataStore.snapshot()).token, current.token);
  const original = storage.backend.commit; storage.backend.commit = async () => { throw new Error('Quota exhausted before committing.'); };
  await assert.rejects(storage.syncDataStore.apply(incoming, { expectedToken: current.token }), /Quota/);
  assert.equal((await storage.syncDataStore.snapshot()).token, current.token);
  assert.equal(await (await storage.createEncryptedStore('future-images').get('same')).text(), 'old');
  storage.backend.commit = original;
  await storage.syncDataStore.apply(incoming, { expectedToken: current.token });
  assert.equal(await (await storage.createEncryptedStore('future-images').get('same')).text(), 'new');
  assert.equal((await storage.localData.get('covelet.racing-tab'))['covelet.racing-tab'], undefined);
  await storage.close();
});

test('sync imports rebase domain revisions without loops and cannot disable an active local privacy lock', async () => {
  const note = (title, revision) => ({ id: 'note-one', title, body: title, revision, pinned: false, createdAt: 1, updatedAt: 2 });
  const tools = (title, revision, noteRevision) => ({ version: 3, revision, notes: [note(title, noteRevision)], reading: [], snapshots: [], trash: [] });
  const clock = (duration, revision) => ({ version: 1, revision, mode: 'clock', duration, notify: false,
    timer: { elapsed: 0, startedAt: 0, running: false, completed: false }, stopwatch: { elapsed: 12, startedAt: 0, running: false } });
  const source = fixture(), destination = fixture(), nav = createEmptyState();
  await source.localData.set({ 'owntab.local.v1': { version: 1, state: { ...nav, revision: 2 }, snapshots: [], sync: { sourceOnly: true } },
    'covelet.content.preferences.v1': { version: 1, revision: 2, presentation: false, aliases: { 'site:one': 'new alias' }, privateKeys: ['site:remote'] },
    'covelet.tools.v1': tools('remote note', 1, 1), 'covelet.clock.v1.test-clock': clock(60000, 1), 'covelet.desktop-templates.v1': { version: 1, revision: 1, templates: [] } });
  const localNav = { ...createEmptyState(), revision: 30 }; localNav.settings.width = 1200;
  await destination.localData.set({ 'owntab.local.v1': { version: 1, state: localNav, snapshots: [], sync: { localOpaque: true } },
    'covelet.content.preferences.v1': { version: 1, revision: 40, presentation: true, aliases: {}, privateKeys: ['site:protected'] },
    'covelet.tools.v1': tools('local note', 50, 7), 'covelet.clock.v1.test-clock': clock(30000, 60), 'covelet.desktop-templates.v1': { version: 1, revision: 70, templates: [] } });
  const portable = await source.syncDataStore.snapshot();
  const entry = (key) => portable.records.find((record) => record.key === key).value;
  assert.equal(entry('owntab.local.v1').state.revision, 0); assert.equal(Object.hasOwn(entry('owntab.local.v1'), 'sync'), false);
  assert.equal(entry('covelet.tools.v1').notes[0].revision, 1); assert.equal(Object.hasOwn(entry('covelet.content.preferences.v1'), 'presentation'), false);
  const initial = await destination.syncDataStore.snapshot();
  const applied = await destination.syncDataStore.apply(portable, { expectedToken: initial.token }), saved = await destination.localData.get(null);
  assert.equal(saved['owntab.local.v1'].state.revision, 31); assert.deepEqual(saved['owntab.local.v1'].sync, { localOpaque: true });
  assert.equal(saved['covelet.tools.v1'].revision, 51); assert.equal(saved['covelet.tools.v1'].notes[0].revision, 8);
  assert.equal(saved['covelet.clock.v1.test-clock'].revision, 61);
  assert.equal(saved['covelet.content.preferences.v1'].revision, 41); assert.equal(saved['covelet.content.preferences.v1'].presentation, true);
  assert.deepEqual(saved['covelet.content.preferences.v1'].privateKeys.sort(), ['site:protected', 'site:remote']);
  assert.equal(saved['covelet.desktop-templates.v1'].revision, 70, 'A semantically identical domain does not churn revisions.');
  const again = await destination.syncDataStore.apply(portable, { expectedToken: applied.token });
  assert.equal(again.changed, 0, 'Protected flags do not cause endless rewrites on every sync.');
  assert.equal((await destination.localData.get('covelet.content.preferences.v1'))['covelet.content.preferences.v1'].revision, 41);
  const noPrefs = { ...portable, records: portable.records.filter((record) => record.key !== 'covelet.content.preferences.v1') };
  await destination.syncDataStore.apply(noPrefs, { expectedToken: again.token });
  const retained = (await destination.localData.get('covelet.content.preferences.v1'))['covelet.content.preferences.v1'];
  assert.equal(retained.presentation, true); assert.deepEqual(retained.privateKeys.sort(), ['site:protected', 'site:remote']);
  await source.close(); await destination.close();
});

test('sync signals cross tabs without content identifiers and exclude synchronization bookkeeping', async () => {
  const messages = [], channels = [], backend = memoryBackend(), databaseName = `sync-signals-${++count}`;
  const broadcastChannel = () => {
    const channel = { onmessage: null, postMessage(value) { messages.push(structuredClone(value)); for (const other of channels) if (other !== channel) other.onmessage?.({ data: structuredClone(value) }); }, close() {} };
    channels.push(channel); return channel;
  };
  const first = fixture({ backend, databaseName, broadcastChannel }), second = fixture({ backend, databaseName, broadcastChannel });
  const local = [], remote = []; first.syncDataStore.subscribe((event) => local.push(event)); second.syncDataStore.subscribe((event) => remote.push(event));
  await first.localData.set({ 'covelet.data-sync.v1': { privateMetadata: 'never-trigger-sync' }, 'covelet.cloud.local.v1': { configured: true } });
  await first.createEncryptedStore('full-data-pending').set('chunk', new Blob(['encrypted-pending']));
  assert.equal(local.length, 0); assert.equal(remote.length, 0);
  await first.createEncryptedStore('future-icons').set('private-origin', new Blob(['PRIVATE-IMAGE-BYTES']));
  assert.deepEqual(local, [{ source: 'local' }]); assert.deepEqual(remote, [{ source: 'local' }]);
  const before = await first.syncDataStore.snapshot();
  await first.syncDataStore.apply({ version: 1, records: [] }, { expectedToken: before.token });
  assert.deepEqual(local.at(-1), { source: 'sync' }); assert.deepEqual(remote.at(-1), { source: 'sync' });
  const signals = messages.filter((message) => message.type === 'data-change');
  assert.equal(signals.length, 2); assert.doesNotMatch(JSON.stringify(signals), /private-origin|future-icons|PRIVATE|bookkeeping/);
  await first.close(); await second.close();
});

test('an old v1 two-field ciphertext is still enumerable by full sync and guarded stale cache writes do nothing', async () => {
  const storage = fixture(); await storage.localData.set({ 'covelet.old-record.v1': { body: 'legacy' } });
  const record = [...storage.backend.records.values()][0], encryptionKey = await storage.backend.getKey();
  const aad = new TextEncoder().encode(`covelet.encrypted.local.v1:1:${record.space}:${record.id}`);
  const bytes = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: aad, tagLength: 128 }, encryptionKey, record.ciphertext));
  const length = new DataView(bytes.buffer).getUint32(4), oldManifest = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length)));
  oldManifest[1][1].shift(); // Legacy framing stored [key,value] without namespace.
  const manifest = new TextEncoder().encode(JSON.stringify(oldManifest)), legacy = new Uint8Array(8 + manifest.length + bytes.length - 8 - length);
  legacy.set(bytes.subarray(0, 4)); new DataView(legacy.buffer).setUint32(4, manifest.length); legacy.set(manifest, 8); legacy.set(bytes.subarray(8 + length), 8 + manifest.length);
  record.iv = webcrypto.getRandomValues(new Uint8Array(12)).buffer;
  record.ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: record.iv, additionalData: aad, tagLength: 128 }, encryptionKey, legacy);
  const restored = await storage.syncDataStore.snapshot();
  assert.deepEqual(restored.records, [{ namespace: 'preferences', key: 'covelet.old-record.v1', value: { body: 'legacy' } }]);
  const events = []; storage.syncDataStore.subscribe((event) => events.push(event));
  const future = storage.createEncryptedStore('future-cache'); let guards = 0;
  const skipped = await future.set('stale-url', new Blob(['stale result']), { shouldWrite: () => { guards++; return false; } });
  assert.equal(skipped, false); assert.equal(guards, 1); assert.equal(await future.get('stale-url'), undefined); assert.equal(events.length, 0);
  await future.set('fresh-url', new Blob(['fresh result']), { shouldWrite: () => true });
  assert.equal(await (await future.get('fresh-url')).text(), 'fresh result'); assert.deepEqual(events, [{ source: 'local' }]);
  await storage.close();
});

test('full import waits for existing domain writers and rejects a snapshot made before their final write', async () => {
  const queues = new Map();
  const locks = { request(name, options, callback) {
    const action = typeof options === 'function' ? options : callback, previous = queues.get(name) || Promise.resolve();
    const task = previous.catch(() => {}).then(action); queues.set(name, task); return task;
  } };
  const storage = fixture({ locks }); await storage.localData.set({ 'covelet.future.v1': { value: 'before' } });
  const before = await storage.syncDataStore.snapshot(); let begin, finish;
  const started = new Promise((resolve) => { begin = resolve; }), unblock = new Promise((resolve) => { finish = resolve; });
  const writer = locks.request('covelet.tools.v1', async () => { begin(); await unblock; await storage.localData.set({ 'covelet.future.v1': { value: 'writer-finished' } }); });
  await started;
  const applying = storage.syncDataStore.apply({ version: 1, records: [{ namespace: 'preferences', key: 'covelet.future.v1', value: { value: 'remote' } }] }, { expectedToken: before.token });
  finish(); await writer;
  await assert.rejects(applying, { code: 'REVISION_CONFLICT' });
  assert.deepEqual((await storage.localData.get('covelet.future.v1'))['covelet.future.v1'], { value: 'writer-finished' });
  await storage.close();
});

test('local hiding, rebased revisions and set ordering do not create new synchronized content', async () => {
  const storage = fixture(), preferences = { version: 1, revision: 3, aliases: {}, privateKeys: ['site:second', 'site:first'], presentation: false };
  await storage.localData.set({ 'covelet.content.preferences.v1': preferences });
  const initial = await storage.syncDataStore.snapshot();
  await storage.localData.set({ 'covelet.content.preferences.v1': { ...preferences, revision: 999, presentation: true, privateKeys: ['site:first', 'site:second'] } });
  const updated = await storage.syncDataStore.snapshot();
  assert.equal(updated.token, initial.token); assert.deepEqual(updated.records, initial.records);
  assert.deepEqual(updated.records[0].value.privateKeys, ['site:first', 'site:second']);
  await storage.close();
});


test('explicit whole-record conflict choices replace portable privacy fields without changing the local lock or password', async () => {
  const storage = fixture(), key = 'covelet.content.preferences.v1';
  const local = { version: 1, revision: 1, presentation: true, aliases: { 'site:local': 'local alias' }, privateKeys: ['site:local'] };
  await storage.localData.set({ [key]: local, 'covelet.privacy.lock.v1': { verifier: 'local-password-verifier' } });
  const before = await storage.syncDataStore.snapshot();
  const remote = { version: 1, revision: 0, aliases: { 'site:remote': 'remote alias' }, privateKeys: ['site:remote'] };
  await storage.syncDataStore.apply({ version: 1, records: [{ namespace: 'preferences', key, value: remote }] },
    { expectedToken: before.token, wholeRecord: { namespace: 'preferences', key } });
  const values = await storage.localData.get([key, 'covelet.privacy.lock.v1']);
  assert.equal(values[key].presentation, true); assert.deepEqual(values[key].privateKeys, ['site:remote']);
  assert.deepEqual(values[key].aliases, remote.aliases); assert.equal(values['covelet.privacy.lock.v1'].verifier, 'local-password-verifier');
  const current = await storage.syncDataStore.snapshot();
  await assert.rejects(storage.syncDataStore.apply({ version: 1, records: [] }, { expectedToken: current.token, wholeRecord: { namespace: 'preferences', key } }),
    error => error.code === 'LOCAL_DATA_PRIVACY_CONFLICT');
  assert.deepEqual(await storage.syncDataStore.snapshot(), current, 'blocked deletion leaves the whole snapshot untouched');
  await storage.close();
});
