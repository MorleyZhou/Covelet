import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { createStorage } from './storage.js';
import { createEmptyState, createInitialState, configureGitHubWidget, deleteEntry } from './model.js';
import { createReplica, portableState } from './sync.js';
import { createColorBackground } from './background-colors.js';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB0kAAAAASUVORK5CYII=', 'base64'));
const image = () => new Blob([PNG], { type: 'image/png' });
const mockImages = { validate: async () => ({ width: 1, height: 1 }), resize: async (blob) => blob };

test('multi-color background and custom curve survive local save and ZIP restoration without image assets', async () => {
  const subject = harness();
  const state = createEmptyState();
  state.settings.background = createColorBackground({ colors: ['#a8b0c4', '#e1c6b0', '#d4dfcf'], angle: 225, curve: [0.17, 0.1, 0.65, 0.9] });
  const saved = await subject.store.saveState(state, 0);
  assert.deepEqual((await subject.another().loadState()).settings.background, state.settings.background);
  const archive = await subject.store.exportBackup(saved);
  const plan = await subject.store.inspectBackup(archive);
  assert.equal(plan.assets.size, 0);
  const restored = await subject.store.restoreBackup(plan, saved.revision);
  assert.deepEqual(restored.settings.background, state.settings.background);
});

test('widget configuration survives ZIP backup/restore without calendar cache or credentials', async () => {
  const subject = harness();
  const state = configureGitHubWidget(createEmptyState(), { username: 'torvalds', size: 'small' });
  state.entries[0].page = 2;
  const archive = await subject.store.exportBackup(state);
  const plan = await subject.store.inspectBackup(archive);
  const restored = await subject.store.restoreBackup(plan, 0);
  assert.deepEqual(restored.entries, state.entries);
  assert.equal(plan.assets.size, 0);
  assert.deepEqual(Object.keys(restored.entries[0].config), ['username', 'size']);
});

test('fresh installation defaults remain deleted after reload and an existing empty desktop stays empty', async () => {
  const subject = harness({ initialState: createInitialState });
  const fresh = await subject.store.loadState();
  assert.equal(fresh.entries.length, 6);
  const deleted = await subject.store.saveState(deleteEntry(fresh, 'default-google'), fresh.revision);
  assert(!((await subject.another().loadState()).entries.some((entry) => entry.id === 'default-google')));
  await subject.store.saveState(createEmptyState(), deleted.revision);
  assert.equal((await subject.another().loadState()).entries.length, 0);
});

test('a fresh device cannot resurrect a deleted default or overwrite an edited default on its first sync', async () => {
  const remote = syncHarness();
  const a = harness({ initialState: createInitialState, syncStore: remote.adapter, device: 'zz-existing' }).store;
  const b = harness({ initialState: createInitialState, syncStore: remote.adapter, device: 'aa-fresh' }).store;
  const initial = await a.loadState();
  const edited = deleteEntry(initial, 'default-google');
  const github = edited.entries.find((entry) => entry.id === 'default-github');
  github.name = 'GitHub Work'; github.page = 2;
  await a.saveState(edited, initial.revision);
  await a.setSyncEnabled(true);
  assert.equal((await b.loadState()).entries.length, 6);
  await b.setSyncEnabled(true);
  const received = await b.loadState();
  assert(!received.entries.some((entry) => entry.id === 'default-google'));
  assert.equal(received.entries.find((entry) => entry.id === 'default-github').name, 'GitHub Work');
  assert.equal(received.entries.find((entry) => entry.id === 'default-github').page, 2);
  await a.syncNow();
  assert(!((await a.loadState()).entries.some((entry) => entry.id === 'default-google')));
});

function harness({ syncStore, device = 'new', syncMinInterval = 0, initialState } = {}) {
  let envelope = null;
  let writes = 0;
  let rejectWrite = false;
  const records = new Map();
  const listeners = new Set();
  let queue = Promise.resolve();
  let ids = 0;
  const configStore = {
    read: async () => structuredClone(envelope),
    async write(value) {
      if (rejectWrite) throw new Error('模拟存储额度不足');
      envelope = structuredClone(value);
      writes++;
      for (const listener of listeners) listener(structuredClone(value.state));
    },
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
  };
  const locks = {
    request(_name, _options, callback) {
      const result = queue.then(callback, callback);
      queue = result.catch(() => {});
      return result;
    },
  };
  const assetStore = {
    get: async (id) => records.get(id),
    async add(record) { assert.equal(records.has(record.id), false); records.set(record.id, record); },
    delete: async (id) => records.delete(id),
  };
  const options = { configStore, assetStore, locks, syncStore, initialState, syncDelay: 600_000, syncMinInterval, imageTools: mockImages, uuid: () => `${device}-${++ids}` };
  return {
    store: createStorage(options), another: () => createStorage(options), records,
    get writes() { return writes; }, get envelope() { return structuredClone(envelope); },
    failWrites() { rejectWrite = true; },
    seedEnvelope(value) { envelope = structuredClone(value); },
  };
}

function withImages() {
  const state = createEmptyState();
  state.settings.background = { kind: 'image', value: 'wallpaper' };
  state.entries.push(
    { id: 'folder', type: 'folder', name: '资料', groupId: 'group-home', parentId: null, icon: { kind: 'image', value: 'icon' }, order: 0 },
    { id: 'site', type: 'site', name: 'Example', url: 'https://example.com/', groupId: 'group-home', parentId: 'folder', icon: { kind: 'image', value: 'icon' }, iconBackground: '#cceeff', order: 0 },
  );
  return state;
}

async function backupWithImages(subject) {
  subject.records.set('wallpaper', { id: 'wallpaper', blob: image() });
  subject.records.set('icon', { id: 'icon', blob: image() });
  return subject.store.exportBackup(withImages());
}

async function rewriteBackup(blob, mutate) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  mutate(files);
  return new Blob([zipSync(files)], { type: 'application/zip' });
}

test('new ZIP exports omit legacy wallpapers, retain shared icons and restore with remapped icon IDs', async () => {
  const subject = harness();
  const backup = await backupWithImages(subject);
  const plan = await subject.store.inspectBackup(backup);
  assert.deepEqual(plan.summary, { sites: 1, folders: 1, groups: 1, assets: 1, bytes: backup.size });
  assert.deepEqual([...plan.assets.keys()], ['icon']);
  assert.equal(subject.writes, 0, 'inspection must not write configuration');
  const restored = await subject.store.restoreBackup(plan, 0);
  assert.equal(restored.revision, 1);
  assert.deepEqual(restored.settings.background, { kind: 'bing', value: 'daily' });
  assert.notEqual(restored.entries[0].icon.value, 'icon');
  assert.equal(restored.entries[0].icon.value, restored.entries[1].icon.value);
  assert.equal(restored.entries[1].iconBackground, '#cceeff', 'asset remapping preserves the independent icon background');
  assert.equal(subject.records.size, 3, 'old assets remain available for snapshots');
  assert.deepEqual([...new Uint8Array(await subject.records.get(restored.entries[0].icon.value).blob.arrayBuffer())], [...PNG]);
  assert.equal((await subject.store.inspectBackup(await subject.store.exportBackup(restored))).assets.size, 1);
});

test('legacy backup validates wallpaper before migration but does not store or restore that wallpaper', async () => {
  const subject = harness();
  const legacy = withImages();
  legacy.providers.push({ id: 'baidu', name: '百度', template: 'https://www.baidu.com/s?wd={query}' },
    { id: 'my-baidu', name: '百度', template: 'https://www.baidu.com/s?wd={query}' });
  delete legacy.settings.columns;
  delete legacy.settings.adaptiveWallpaper;
  delete legacy.settings.adaptIcons;
  legacy.settings.iconSize = 108;
  legacy.groups.push({ id: 'old-group', name: '旧分组' });
  legacy.entries.push({ id: 'old-site', type: 'site', name: '旧网址', url: 'https://legacy.example.com/', groupId: 'old-group', parentId: null, icon: { kind: 'preset', value: 'github' }, order: 0 });
  const data = strToU8(JSON.stringify(legacy));
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', PNG))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const manifest = { format: 'owntab-backup', version: 1, assets: ['wallpaper', 'icon'].map((id, index) => ({ id, path: `assets/${index}.png`, mime: 'image/png', bytes: PNG.length, sha256: digest })) };
  const backup = new Blob([zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'data.json': data, 'assets/0.png': PNG, 'assets/1.png': PNG })]);
  const plan = await subject.store.inspectBackup(backup);
  assert.equal(plan.assets.size, 2, 'inspection must check the complete old archive');
  assert.equal(plan.state.groups.length, 2, 'validate the original archive before applying migrations');
  const restored = await subject.store.restoreBackup(plan, 0);
  assert.deepEqual(restored.settings.background, { kind: 'bing', value: 'daily' });
  assert.equal(restored.settings.columns, 8, 'older backups acquire the new column preference');
  assert.equal(restored.settings.adaptiveWallpaper, false, 'older backups keep visual enhancements disabled');
  assert.equal(restored.settings.adaptIcons, false);
  assert.equal(restored.settings.iconSize, 108, 'existing layout choices remain intact');
  assert.equal(restored.providers.some((provider) => provider.id === 'baidu'), false, 'legacy archives do not restore the retired built-in');
  assert.equal(restored.providers.some((provider) => provider.id === 'my-baidu'), true, 'same-name and same-domain custom searches remain available');
  assert.deepEqual(restored.groups, [{ id: 'group-home', name: '桌面' }]);
  assert.ok(restored.entries.every((entry) => entry.groupId === 'group-home'));
  assert.equal(restored.entries.find((entry) => entry.id === 'site').parentId, 'folder');
  assert.equal(restored.entries.find((entry) => entry.id === 'old-site').order, 1);
  assert.deepEqual(restored.entries.find((entry) => entry.id === 'old-site').icon, { kind: 'letter', value: '旧网' }, 'old archives remain readable after retiring icon presets');
  assert.equal(restored.entries.find((entry) => entry.id === 'site').iconBackground, '#cceeff');
  assert.equal(subject.records.size, 1, 'only the icon is ingested');
  assert.equal(subject.envelope.state.settings.background.kind, 'bing');
  plan.assets.get('wallpaper').sha256 = '0'.repeat(64);
  await assert.rejects(subject.store.restoreBackup(plan, restored.revision), /校验/u);
  await assert.rejects(subject.store.putImage(image(), 'background'), /停用/u);
});

test('ZIP restores visual module switches and manual appearance while retaining original icon assets only', async () => {
  const subject = harness();
  const state = withImages();
  state.settings.background = { kind: 'bing', value: 'daily' };
  state.settings.adaptiveWallpaper = true; state.settings.adaptIcons = true;
  state.settings.shade = 53; state.settings.theme = 'dark';
  subject.records.set('icon', { id: 'icon', blob: image() });
  subject.records.set('unreferenced-derived-icon', { id: 'unreferenced-derived-icon', blob: image() });
  const backup = await subject.store.exportBackup(state);
  const files = unzipSync(new Uint8Array(await backup.arrayBuffer()));
  const data = JSON.parse(new TextDecoder().decode(files['data.json']));
  assert.equal(data.settings.adaptiveWallpaper, true);
  assert.equal(data.settings.adaptIcons, true);
  assert.deepEqual(Object.keys(files).sort(), ['assets/0.png', 'data.json', 'manifest.json']);
  assert.equal(new TextDecoder().decode(files['data.json']).includes('unreferenced-derived-icon'), false);
  const plan = await subject.store.inspectBackup(backup);
  assert.deepEqual([...plan.assets.keys()], ['icon']);
  const restored = await subject.store.restoreBackup(plan, 0);
  assert.equal(restored.settings.adaptiveWallpaper, true);
  assert.equal(restored.settings.adaptIcons, true);
  assert.equal(restored.settings.shade, 53);
  assert.equal(restored.settings.theme, 'dark');
  assert.equal(restored.entries[1].iconBackground, '#cceeff');
  const restoredAsset = subject.records.get(restored.entries[1].icon.value);
  assert.deepEqual([...new Uint8Array(await restoredAsset.blob.arrayBuffer())], [...PNG]);
});

test('two tabs cannot overwrite the same revision; retain only three snapshots and restore the previous state', async () => {
  const subject = harness();
  const first = createEmptyState(); first.settings.width = 1100;
  const second = createEmptyState(); second.settings.width = 1200;
  const results = await Promise.allSettled([subject.store.saveState(first, 0), subject.another().saveState(second, 0)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  let state = await subject.store.loadState();
  for (let revision = 2; revision <= 5; revision++) {
    state.settings.width = 1000 + revision * 10;
    state = await subject.store.saveState(state, state.revision);
  }
  assert.equal(subject.envelope.snapshots.length, 3);
  assert.deepEqual(subject.envelope.snapshots.map((item) => item.revision), [4, 3, 2]);
  const restored = await subject.store.restoreSnapshot(5);
  assert.equal(restored.revision, 6);
  assert.equal(restored.settings.width, 1040);
  await assert.rejects(subject.store.restoreSnapshot(5), { code: 'REVISION_CONFLICT' });
});

test('legacy local configuration, snapshots and newly exported backup all materialize one desktop', async () => {
  const subject = harness();
  const legacy = createEmptyState();
  legacy.groups = [{ id: 'old-a', name: '旧 A' }, { id: 'old-b', name: '旧 B' }];
  legacy.entries = [
    { id: 'a', type: 'site', name: 'A', url: 'https://a.example.com/', groupId: 'old-a', parentId: null, icon: { kind: 'letter', value: 'A' }, order: 0 },
    { id: 'b', type: 'site', name: 'B', url: 'https://b.example.com/', groupId: 'old-b', parentId: null, icon: { kind: 'letter', value: 'B' }, order: 0 },
  ];
  subject.seedEnvelope({ version: 1, state: legacy, snapshots: [legacy] });
  const loaded = await subject.store.loadState();
  assert.deepEqual(loaded.groups, [{ id: 'group-home', name: '桌面' }]);
  assert.deepEqual(loaded.entries.map((entry) => [entry.id, entry.groupId, entry.order]), [['a', 'group-home', 0], ['b', 'group-home', 1]]);
  const exported = await subject.store.inspectBackup(await subject.store.exportBackup(legacy));
  assert.deepEqual(exported.state, loaded);
  const restored = await subject.store.restoreSnapshot(loaded.revision);
  assert.deepEqual(restored.groups, loaded.groups);
  assert.deepEqual(restored.entries, loaded.entries);
  assert.equal(restored.revision, loaded.revision + 1);
});

test('failed restoration preserves current state and assets and removes only staged resources', async () => {
  const subject = harness();
  const plan = await subject.store.inspectBackup(await backupWithImages(subject));
  const current = await subject.store.saveState(createEmptyState(), 0);
  const originalEnvelope = subject.envelope;
  const originalIds = [...subject.records.keys()];
  subject.failWrites();
  await assert.rejects(subject.store.restoreBackup(plan, current.revision), /额度不足/u);
  assert.deepEqual(subject.envelope, originalEnvelope);
  assert.deepEqual([...subject.records.keys()], originalIds);
  assert.equal(subject.writes, 1);
  await assert.rejects(subject.store.saveState({ ...current, settings: { ...current.settings, theme: 'dark' } }, current.revision), /额度不足/u);
  assert.deepEqual(subject.envelope, originalEnvelope);
});

test('inspection rejects missing assets, tampered hashes, unknown files and versions without writing', async () => {
  const subject = harness();
  const backup = await backupWithImages(subject);
  const cases = [
    (files) => { delete files['assets/0.png']; },
    (files) => {
      const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
      manifest.assets[0].sha256 = '0'.repeat(64);
      files['manifest.json'] = strToU8(JSON.stringify(manifest));
    },
    (files) => { files['../escape.html'] = strToU8('<script>throw 1</script>'); },
    (files) => {
      const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])); manifest.version = 2;
      files['manifest.json'] = strToU8(JSON.stringify(manifest));
    },
    (files) => { files['surprise.js'] = strToU8('alert(1)'); },
  ];
  for (const mutate of cases) await assert.rejects(subject.store.inspectBackup(await rewriteBackup(backup, mutate)));
  assert.equal(subject.writes, 0);
  assert.equal(subject.records.size, 2);
  subject.records.delete('icon');
  await assert.rejects(subject.store.exportBackup(withImages()), { code: 'MISSING_ASSET' });
});

test('ZIP source and declared expansion limits apply before inflation; forged tiny sizes stop streamed expansion', async () => {
  const subject = harness();
  await assert.rejects(subject.store.inspectBackup(new Blob([new Uint8Array(30 * 1024 * 1024 + 1)])), /30 MiB/u);
  const zipped = zipSync({ 'manifest.json': strToU8('{}'), 'data.json': new Uint8Array(3 * 1024 * 1024).fill(65) });
  await assert.rejects(subject.store.inspectBackup(new Blob([zipped])), /大小限制/u);
  const forged = zipped.slice();
  const view = new DataView(forged.buffer);
  // Lie consistently in both directory and local header: output must still be bounded.
  for (let offset = 0; offset < forged.length - 46; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const length = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(forged.subarray(offset + 46, offset + 46 + length));
    if (name === 'data.json') {
      const local = view.getUint32(offset + 42, true);
      view.setUint32(offset + 24, 64, true);
      view.setUint32(local + 22, 64, true);
    }
  }
  await assert.rejects(subject.store.inspectBackup(new Blob([forged])), /实际解压大小/u);
  assert.equal(subject.writes, 0);
});

test('image ingestion validates MIME, byte and pixel limits before decoding; change subscriptions unsubscribe', async () => {
  const subject = harness();
  assert.equal(await subject.store.putImage(image(), 'icon'), 'new-1');
  await assert.rejects(subject.store.putImage(new Blob([PNG], { type: 'image/svg+xml' })), { code: 'INVALID_IMAGE' });
  await assert.rejects(subject.store.putImage(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' })), { code: 'INVALID_IMAGE' });
  const huge = PNG.slice(); new DataView(huge.buffer).setUint32(16, 40_000_001);
  await assert.rejects(subject.store.putImage(new Blob([huge], { type: 'image/png' })), { code: 'INVALID_IMAGE' });
  const revisions = [];
  const stop = subject.store.subscribeState((state) => revisions.push(state.revision));
  await subject.store.saveState(createEmptyState(), 0);
  stop();
  await subject.store.saveState(createEmptyState(), 1);
  assert.deepEqual(revisions, [1]);
});

function syncHarness() {
  let items = {};
  let failure = false;
  let writes = 0;
  const listeners = new Set();
  const emit = () => { for (const listener of listeners) queueMicrotask(listener); };
  return {
    adapter: {
      get: async () => structuredClone(items),
      async set(values) { if (failure) throw new Error('模拟浏览器同步不可用'); Object.assign(items, structuredClone(values)); writes++; emit(); },
      async remove(keys) { for (const key of keys) delete items[key]; emit(); },
      subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    },
    get writes() { return writes; }, get items() { return structuredClone(items); }, fail(value) { failure = value; },
  };
}

const site = (id, label = id, order = 0) => ({ id, type: 'site', name: label, url: `https://${id}.example.com/`, groupId: 'group-home', parentId: null, icon: { kind: 'letter', value: '网' }, order });

test('native sync is opt-in, publishes portable configuration, retries failures and disabling keeps local changes', async () => {
  const remote = syncHarness();
  const subject = harness({ syncStore: remote.adapter, device: 'device-a' });
  let state = await subject.store.loadState();
  state.entries.push(site('private'));
  state = await subject.store.saveState(state, state.revision);
  assert.equal(remote.writes, 0);
  assert.equal(subject.envelope.sync.enabled, false);
  remote.fail(true);
  assert.equal((await subject.store.setSyncEnabled(true)).phase, 'error');
  assert.equal((await subject.store.loadState()).entries[0].id, 'private');
  remote.fail(false);
  assert.equal((await subject.store.syncNow()).phase, 'saved');
  assert.ok(remote.writes > 0);
  await subject.store.setSyncEnabled(false);
  state = await subject.store.loadState();
  state.entries[0].name = '关闭期间修改';
  await subject.store.saveState(state, state.revision);
  const writes = remote.writes;
  assert.equal((await subject.store.syncNow()).phase, 'disabled');
  assert.equal(remote.writes, writes);
  assert.equal((await subject.store.setSyncEnabled(true)).phase, 'saved');
  assert.equal((await subject.store.loadState()).entries[0].name, '关闭期间修改');
});

test('native-sync storage adapters carry only visual preferences and preserve local original icons when switching off', async () => {
  const remote = syncHarness();
  const a = harness({ syncStore: remote.adapter, device: 'visual-a' });
  const b = harness({ syncStore: remote.adapter, device: 'visual-b' });
  let original = await a.store.loadState();
  original.settings.adaptiveWallpaper = true; original.settings.adaptIcons = true;
  original.settings.shade = 36; original.settings.theme = 'dark';
  original.entries.push({ ...site('original'), icon: { kind: 'image', value: 'device-original-image' }, iconBackground: '#cceeff' });
  a.records.set('device-original-image', { id: 'device-original-image', blob: image() });
  await a.store.saveState(original, original.revision);
  assert.equal(remote.writes, 0, 'saving module switches does not opt the user into native sync');
  await a.store.setSyncEnabled(true); await b.store.setSyncEnabled(true);
  let incoming = await b.store.loadState();
  assert.equal(incoming.settings.adaptiveWallpaper, true);
  assert.equal(incoming.settings.adaptIcons, true);
  assert.equal(incoming.settings.shade, 36);
  assert.equal(incoming.settings.theme, 'dark');
  assert.equal(incoming.entries[0].iconBackground, '#cceeff');
  assert.equal(incoming.entries[0].icon.kind, 'letter');
  assert.equal(JSON.stringify(remote.items).includes('device-original-image'), false);
  assert.equal(b.records.size, 0, 'native sync does not copy any image or derived image');
  incoming.settings.adaptiveWallpaper = false; incoming.settings.adaptIcons = false;
  incoming = await b.store.saveState(incoming, incoming.revision);
  await b.store.syncNow(); await a.store.syncNow();
  const restored = await a.store.loadState();
  assert.equal(restored.settings.adaptiveWallpaper, false);
  assert.equal(restored.settings.adaptIcons, false);
  assert.equal(restored.settings.shade, 36);
  assert.equal(restored.entries[0].iconBackground, '#cceeff');
  assert.deepEqual(restored.entries[0].icon, original.entries[0].icon);
  assert.deepEqual([...new Uint8Array(await a.records.get('device-original-image').blob.arrayBuffer())], [...PNG]);
});

test('two native sync devices merge independent edits, preserve conflicts and publish a chosen recovery', async () => {
  const remote = syncHarness();
  const a = harness({ syncStore: remote.adapter, device: 'device-a' }).store;
  const b = harness({ syncStore: remote.adapter, device: 'device-b' }).store;
  await a.setSyncEnabled(true); await b.setSyncEnabled(true);
  let first = await a.loadState(); let second = await b.loadState();
  first.entries.push(site('alpha')); second.entries.push(site('beta'));
  await a.saveState(first, first.revision); await b.saveState(second, second.revision);
  await Promise.all([a.syncNow(), b.syncNow()]);
  const notifications = [];
  const stop = b.subscribeState((value) => notifications.push(value));
  await a.syncNow(); await b.syncNow();
  first = await a.loadState(); second = await b.loadState();
  assert.deepEqual(first.entries.map((entry) => entry.id).sort(), ['alpha', 'beta']);
  assert.deepEqual(second.entries.map((entry) => entry.id).sort(), ['alpha', 'beta']);
  assert.ok(notifications.some((value) => value.entries.length === 2));
  stop();
  first.entries.find((entry) => entry.id === 'alpha').name = '设备 A';
  second.entries.find((entry) => entry.id === 'alpha').name = '设备 B';
  await a.saveState(first, first.revision); await b.saveState(second, second.revision);
  await Promise.all([a.syncNow(), b.syncNow()]); await a.syncNow(); await b.syncNow();
  const conflicts = await a.getSyncConflicts();
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'entry');
  const recovered = await a.restoreSyncConflict(conflicts[0].id);
  assert.equal(recovered.entries.find((entry) => entry.id === 'alpha').name, conflicts[0].name);
  await a.syncNow(); await b.syncNow();
  assert.equal((await b.loadState()).entries.find((entry) => entry.id === 'alpha').name, conflicts[0].name);
  assert.equal((await b.getSyncConflicts()).length, 0);
  const stableWrites = remote.writes;
  await a.syncNow(); await b.syncNow();
  assert.equal(remote.writes, stableWrites, 'a clean pull must not publish a new generation or loop');
});

test('preview cannot enable native sync and quota errors retain the complete local configuration', async () => {
  const preview = harness({ syncStore: null }).store;
  await preview.loadState();
  assert.equal(preview.getSyncStatus().phase, 'preview');
  await assert.rejects(preview.setSyncEnabled(true), { code: 'SYNC_UNAVAILABLE' });
  const remote = syncHarness();
  const subject = harness({ syncStore: remote.adapter, device: 'device-large' });
  let state = await subject.store.loadState();
  for (let index = 0; index < 300; index++) state.entries.push({ ...site(`site-${index}`, `网站 ${index}`, index), url: `https://example.com/${'a'.repeat(500)}?id=${index}` });
  state = await subject.store.saveState(state, state.revision);
  assert.equal((await subject.store.setSyncEnabled(true)).phase, 'error');
  assert.equal((await subject.store.loadState()).entries.length, 300);
  assert.equal(remote.writes, 0, 'no truncated or partial configuration is uploaded');
});

test('sync publication throttle persists across new pages and keeps edits locally while waiting', async () => {
  const remote = syncHarness();
  const subject = harness({ syncStore: remote.adapter, device: 'device-throttle', syncMinInterval: 10000 });
  assert.equal((await subject.store.setSyncEnabled(true)).phase, 'saved');
  const firstWrites = remote.writes;
  let state = await subject.store.loadState();
  state.entries.push(site('waiting'));
  state = await subject.store.saveState(state, state.revision);
  assert.equal((await subject.store.syncNow()).phase, 'pending');
  const anotherPage = subject.another();
  assert.equal((await anotherPage.syncNow()).phase, 'pending');
  assert.equal(remote.writes, firstWrites);
  assert.equal((await anotherPage.loadState()).entries[0].id, 'waiting');
  assert.ok(subject.envelope.sync.lastPublishedAt > 0);
});

test('exhausted sync history pauses synchronization without rejecting or reverting valid local edits', async () => {
  const remote = syncHarness();
  const subject = harness({ syncStore: remote.adapter, device: 'device-full' });
  const state = createEmptyState();
  const document = createReplica('device-full');
  document.clock = 1;
  for (let index = 0; index < 10000; index++) document.records[`e:old-${index}`] = { n: 1, context: { 'device-full': 0 }, value: null };
  subject.seedEnvelope({ version: 1, state, snapshots: [], sync: { version: 1, enabled: true, dirty: false,
    document, documents: { 'device-full': document }, base: portableState(state), lastPublishedAt: 0 } });
  let current = await subject.store.loadState();
  current.entries.push(site('untracked'));
  current = await subject.store.saveState(current, current.revision);
  assert.equal(current.entries[0].id, 'untracked');
  assert.equal(current.revision, 1);
  assert.ok(subject.envelope.sync.blockedError);
  assert.equal(Object.keys(subject.envelope.sync.document.records).length, 10000);
  assert.equal(subject.envelope.sync.base.entries.length, 0, 'retain the last fully tracked baseline');
  assert.equal(subject.store.getSyncStatus().phase, 'error');
  current.entries[0].name = '未同步的后续本地修改';
  current = await subject.store.saveState(current, current.revision);
  assert.ok(subject.envelope.sync.blockedError, 'a later edit must also include the previously untracked addition');
  assert.equal((await subject.store.syncNow()).phase, 'error');
  assert.equal((await subject.store.loadState()).entries[0].name, '未同步的后续本地修改');
  const anotherPage = subject.another();
  assert.equal((await anotherPage.syncNow()).phase, 'error');
  assert.equal((await anotherPage.loadState()).entries[0].name, '未同步的后续本地修改');
  assert.equal(remote.writes, 0, 'never materialize or publish the stale replica over untracked local edits');
  current.entries = [];
  current = await subject.store.saveState(current, current.revision);
  assert.equal(subject.envelope.sync.blockedError, null, 'returning to a trackable baseline can clear the protocol block');
  const previous = subject.envelope;
  subject.failWrites();
  current.settings.width = 1200;
  await assert.rejects(subject.store.saveState(current, current.revision), /额度不足/u);
  assert.deepEqual(subject.envelope, previous, 'an actual local storage failure still rejects and preserves the previous valid state');
});
