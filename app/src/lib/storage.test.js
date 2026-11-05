import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { createStorage } from './storage.js';
import { createEmptyState, createInitialState, configureGitHubWidget, deleteEntry } from './model.js';
import { createColorBackground } from './background-colors.js';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB0kAAAAASUVORK5CYII=', 'base64'));
const image = () => new Blob([PNG], { type: 'image/png' });
const mockImages = { validate: async () => ({ width: 1, height: 1 }), resize: async (blob) => blob };

test('local image reads reject corrupt stored bytes before exposing a URL, so a saved URL fallback can be selected', async () => {
  const subject = harness();
  subject.records.set('bad-header', { blob: new Blob(['not a picture'], { type: 'image/png' }) });
  await assert.rejects(subject.store.getAssetUrl('bad-header'), { code: 'INVALID_IMAGE' });
  const undecodable = harness({ imageTools: { ...mockImages, validate: async () => { throw Error('Stored image cannot decode'); } } });
  undecodable.records.set('bad-body', { blob: image() });
  await assert.rejects(undecodable.store.getAssetUrl('bad-body'), /cannot decode/);
  subject.records.set('valid', { blob: image() });
  const url = await subject.store.getAssetUrl('valid');
  assert(url.startsWith('blob:')); URL.revokeObjectURL(url);
  assert.equal(subject.writes, 0);
});

const iconResource = (url, adaptive = false) => ({ url, blob: image(), ...(adaptive ? { darkBlob: image() } : {}), width: 1, height: 1,
  vector: adaptive, adaptive, updatedAt: 123456 });
function withRemoteIcons() {
  const state = createEmptyState();
  state.entries.push({ id: 'remote', type: 'site', name: 'Remote', url: 'https://remote.example/', groupId: 'group-home', parentId: null,
    icon: { kind: 'letter', value: 'R' }, iconUrl: 'https://cdn.example/icon.png', iconVariants: {
      light: { url: 'https://cdn.example/light.png', fit: 'contain' }, dark: { url: 'https://cdn.example/dark.png', fit: 'cover' },
    }, order: 0 });
  state.entries.push({ ...state.entries[0], id: 'remote-two', url: 'https://two.example/', order: 1 });
  return state;
}

test('portable ZIP contains only referenced cached URL images and both adaptive schemes before publishing restored navigation', async () => {
  const source = harness(), state = withRemoteIcons();
  for (const url of ['https://cdn.example/icon.png', 'https://cdn.example/light.png', 'https://cdn.example/dark.png', 'https://unused.example/icon.png']) {
    source.icons.set(url, iconResource(url, url.includes('/light.')));
  }
  const archive = await source.store.exportBackup(state), files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  assert.equal(manifest.version, 2);
  assert.equal(manifest.icons.length, 3, 'shared URLs are stored once and unrelated cache records stay private');
  assert.equal(Object.keys(files).filter((path) => path.startsWith('icons/')).length, 4);
  assert.equal(source.writes, 0, 'export never changes navigation');
  const target = harness(), plan = await target.store.inspectBackup(archive);
  assert.equal(plan.icons.size, 3);
  assert.equal(target.icons.size, 0, 'inspection does not write image records');
  const saved = await target.store.restoreBackup(plan, 0);
  assert.deepEqual(saved.entries, state.entries, 'portable HTTP keys and per-scheme fits remain unchanged');
  assert.equal(target.icons.size, 3);
  assert.deepEqual(target.iconEvents.map((event) => event.kind), ['restore', 'restore', 'restore', 'publish']);
  assert.equal(target.iconEvents.at(-1).sources.length, 3, 'no navigation notification precedes its restored bytes');
  const adaptive = target.icons.get('https://cdn.example/light.png');
  assert.equal(adaptive.adaptive, true); assert.equal(adaptive.vector, true);
  assert.deepEqual(new Uint8Array(await adaptive.darkBlob.arrayBuffer()), PNG);
  assert.equal(adaptive.updatedAt, 123456);
});

test('old URL-only ZIP remains readable and hydration is an explicit restore action with revision and rollback guards', async () => {
  const source = harness(), archive = await source.store.exportBackup(withRemoteIcons());
  const legacy = await rewriteBackup(archive, (files) => {
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])); manifest.version = 1; delete manifest.icons;
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
  });
  let prepared = 0, results = 0;
  const target = harness({ iconResources: { read: async () => null, restore: async () => assert.fail('legacy ZIP has no bytes'),
    prepare: async (state, options) => { prepared++; assert.equal(state.entries.length, 2); options.onIconProgress?.({ completed: 1 }); return { ready: 1 }; } } });
  const plan = await target.store.inspectBackup(legacy);
  assert.equal(plan.icons.size, 0); assert.equal(prepared, 0, 'preview never visits imported websites');
  await assert.rejects(target.store.restoreBackup(plan, 7), { code: 'REVISION_CONFLICT' });
  assert.equal(prepared, 0, 'a stale import does not start downloads');
  await target.store.restoreBackup(plan, 0, { onIconProgress: (value) => assert.equal(value.completed, 1), onIconResult: (value) => { assert.equal(value.ready, 1); results++; } });
  assert.equal(prepared, 1); assert.equal(results, 1);
  await target.store.restoreBackup(plan, 1, { hydrateIcons: false });
  assert.equal(prepared, 1, 'automatic recovery rollback never downloads icons');
});

test('portable ZIP rejects tampered URL icon bytes, references, paths and dimensions before writing any data', async () => {
  const source = harness(), state = withRemoteIcons();
  source.icons.set('https://cdn.example/light.png', iconResource('https://cdn.example/light.png', true));
  const archive = await source.store.exportBackup(state), target = harness();
  const mutations = [
    (item) => { item.blob.sha256 = '0'.repeat(64); },
    (item) => { item.url = 'https://unreferenced.example/icon.png'; },
    (item) => { item.width = 2; },
    (item) => { delete item.darkBlob; },
    (item) => { item.darkBlob.path = item.blob.path; },
    (item) => { item.blob.path = 'assets/0.png'; },
    (item) => { item.blob.extra = 'unexpected'; },
    (item) => { item.adaptive = false; },
  ];
  for (const mutate of mutations) await assert.rejects(target.store.inspectBackup(await rewriteBackup(archive, (files) => {
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])); mutate(manifest.icons[0]);
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
  })));
  await assert.rejects(target.store.inspectBackup(await rewriteBackup(archive, (files) => {
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])); manifest.icons.push(manifest.icons[0]);
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
  })));
  const plan = await target.store.inspectBackup(archive); plan.icons.get('https://cdn.example/light.png').width = 2;
  await assert.rejects(target.store.restoreBackup(plan, 0));
  assert.equal(target.writes, 0); assert.equal(target.icons.size, 0); assert.equal(target.records.size, 0);
});

test('included image persistence failure aborts restoration before hydration or navigation writes', async () => {
  const source = harness(), state = withRemoteIcons();
  source.icons.set('https://cdn.example/icon.png', iconResource('https://cdn.example/icon.png'));
  let preparations = 0;
  const target = harness({ iconResources: { read: async () => null, restore: async () => null,
    prepare: async () => { preparations++; throw Error('included bytes must never be downloaded again'); } } });
  const plan = await target.store.inspectBackup(await source.store.exportBackup(state));
  await assert.rejects(target.store.restoreBackup(plan, 0), { code: 'MISSING_ASSET' });
  assert.equal(preparations, 0); assert.equal(target.writes, 0); assert.equal(target.records.size, 0);
  assert.equal((await target.store.loadState()).entries.length, 0);
});

test('image-only sync cancellation aborts restore even when navigation revision is unchanged', async () => {
  const source = harness(), state = withImages();
  state.entries.push({ ...withRemoteIcons().entries[0], order: 1 });
  source.records.set('icon', { id: 'icon', blob: image() });
  let preparations = 0;
  const target = harness({ iconResources: { read: async () => null, restore: async () => assert.fail('no URL icon bytes in this archive'),
    prepare: async () => { preparations++; return { total: 3, completed: 1, cancelled: true, missing: [] }; } } });
  const before = await target.store.loadState(), plan = await target.store.inspectBackup(await source.store.exportBackup(state));
  await assert.rejects(target.store.restoreBackup(plan, before.revision), { code: 'REVISION_CONFLICT' });
  assert.equal(preparations, 1);
  assert.equal(target.writes, 0, 'an unchanged navigation revision cannot authorize stale image preparation after sync');
  assert.equal(target.records.size, 0, 'cancelled preparation does not stage uploaded icon assets');
  assert.deepEqual(await target.store.loadState(), before);
});

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

test('fresh installations and saved empty desktops stay empty after reload', async () => {
  const subject = harness({ initialState: createInitialState });
  const fresh = await subject.store.loadState();
  assert.equal(fresh.entries.length, 0);
  const minimal = { ...fresh, settings: { ...fresh.settings, minimal: true, showClock: false } };
  const saved = await subject.store.saveState(minimal, fresh.revision);
  assert.equal((await subject.another().loadState()).settings.minimal, true);
  assert.equal((await subject.another().loadState()).settings.showClock, false);
  await subject.store.saveState(createEmptyState(), saved.revision);
  assert.equal((await subject.another().loadState()).entries.length, 0);
});

function harness({ syncStore, device = 'new', initialState, iconResources, imageTools = mockImages } = {}) {
  let envelope = null;
  let writes = 0;
  let rejectWrite = false;
  const records = new Map();
  const icons = new Map(), iconEvents = [];
  const listeners = new Set();
  let queue = Promise.resolve();
  let ids = 0;
  const configStore = {
    read: async () => structuredClone(envelope),
    async write(value) {
      if (rejectWrite) throw new Error('模拟存储额度不足');
      iconEvents.push({ kind: 'publish', sources: [...icons.keys()] });
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
  const iconAdapter = iconResources || {
    read: async (source) => icons.get(source) || null,
    restore: async (record) => {
      iconEvents.push({ kind: 'restore', source: record.url });
      if (!icons.has(record.url)) icons.set(record.url, structuredClone(record));
      return icons.get(record.url);
    },
  };
  const options = { configStore, assetStore, iconResources: iconAdapter, locks, syncStore, initialState, imageTools, uuid: () => `${device}-${++ids}` };
  return {
    store: createStorage(options), another: () => createStorage(options), records, icons, iconEvents,
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
  delete legacy.settings.visualEnhancement;
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
  assert.equal(restored.settings.visualEnhancement, true, 'missing legacy choices acquire the current unified default');
  assert.equal(Object.hasOwn(restored.settings, 'adaptiveWallpaper'), false);
  assert.equal(Object.hasOwn(restored.settings, 'adaptIcons'), false);
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
  await assert.rejects(subject.store.restoreBackup(plan, restored.revision), /图片无法读取/u);
  await assert.rejects(subject.store.putImage(image(), 'background'), /停用/u);
});

test('ZIP restores visual module switches and manual appearance while retaining original icon assets only', async () => {
  const subject = harness();
  const state = withImages();
  state.settings.background = { kind: 'bing', value: 'daily' };
  state.settings.visualEnhancement = true;
  state.settings.shade = 53; state.settings.theme = 'dark';
  subject.records.set('icon', { id: 'icon', blob: image() });
  subject.records.set('unreferenced-derived-icon', { id: 'unreferenced-derived-icon', blob: image() });
  const backup = await subject.store.exportBackup(state);
  const files = unzipSync(new Uint8Array(await backup.arrayBuffer()));
  const data = JSON.parse(new TextDecoder().decode(files['data.json']));
  assert.equal(data.settings.visualEnhancement, true);
  assert.equal(Object.hasOwn(data.settings, 'adaptIcons'), false);
  assert.deepEqual(Object.keys(files).sort(), ['assets/0.png', 'data.json', 'manifest.json']);
  assert.equal(new TextDecoder().decode(files['data.json']).includes('unreferenced-derived-icon'), false);
  const plan = await subject.store.inspectBackup(backup);
  assert.deepEqual([...plan.assets.keys()], ['icon']);
  const restored = await subject.store.restoreBackup(plan, 0);
  assert.equal(restored.settings.visualEnhancement, true);
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

test('snapshot restoration prepares historical icons once and rejects a concurrent edit without holding the navigation lock', async () => {
  let subject, mutateDuringPrepare = false, prepared = 0;
  subject = harness({ iconResources: { read: async () => null, restore: async () => null, prepare: async (state) => {
    prepared++; assert.equal(state.entries.length, 2);
    if (mutateDuringPrepare) { const current = await subject.store.loadState(); current.settings.width = 1370; await subject.store.saveState(current, current.revision); }
    return { completed: 2 };
  } } });
  const saved = await subject.store.saveState(withRemoteIcons(), 0);
  await subject.store.saveState(createEmptyState(), saved.revision);
  mutateDuringPrepare = true;
  await assert.rejects(subject.store.restoreSnapshot(2), { code: 'REVISION_CONFLICT' });
  assert.equal(prepared, 1); assert.equal((await subject.store.loadState()).settings.width, 1370);
  assert.equal((await subject.store.loadState()).entries.length, 0);
  await assert.rejects(subject.store.restoreSnapshot(2), { code: 'REVISION_CONFLICT' });
  assert.equal(prepared, 1, 'a stale snapshot action does not fetch again');
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
      const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])); manifest.version = 99;
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

const site = (id, label = id, order = 0) => ({ id, type: 'site', name: label, url: `https://${id}.example.com/`, groupId: 'group-home', parentId: null, icon: { kind: 'letter', value: '网' }, order });

function retiredNativeStore() {
  const calls = [];
  const existing = { 'owntab.sync.v1.old.head': { clock: 18 }, 'owntab.sync.v1.old.18': 'remote data stays untouched' };
  const adapter = Object.fromEntries(['get', 'set', 'remove', 'subscribe'].map((method) => [method, () => {
    calls.push(method); throw Error('Retired native sync must never run.');
  }]));
  return { adapter, calls, existing };
}

test('retired browser sync performs no startup, reads, writes, subscriptions or remote cleanup', async () => {
  const remote = retiredNativeStore();
  const beforeRemote = structuredClone(remote.existing);
  const subject = harness({ syncStore: remote.adapter });
  const state = createEmptyState(); state.entries.push(site('local'));
  const legacy = { version: 1, enabled: true, dirty: true, document: { actor: 'legacy-device', clock: 27 },
    documents: { preserved: { records: { 'e:old': { value: 'retained conflict metadata' } } } },
    base: { retained: true }, blockedError: 'old quota error', lastPublishedAt: 123 };
  subject.seedEnvelope({ version: 1, state, snapshots: [], sync: legacy });
  const loaded = await subject.store.loadState();
  assert.equal(loaded.entries[0].id, 'local');
  const statuses = [];
  const stop = subject.store.subscribeSyncStatus((value) => statuses.push(value));
  assert.equal(subject.store.getSyncStatus().enabled, false);
  assert.equal((await subject.store.syncNow()).phase, 'disabled');
  assert.equal((await subject.store.setSyncEnabled(false)).phase, 'disabled');
  await assert.rejects(subject.store.setSyncEnabled(true), { code: 'SYNC_UNAVAILABLE' });
  await assert.rejects(subject.store.setSyncEnabled('true'), { code: 'SYNC_INVALID' });
  await assert.rejects(subject.store.restoreSyncConflict('legacy-conflict'), { code: 'SYNC_UNAVAILABLE' });
  assert.deepEqual(await subject.store.getSyncConflicts(), []);
  stop();
  assert.deepEqual(statuses.map(({ phase, enabled }) => [phase, enabled]), [['disabled', false]]);
  assert.equal(subject.writes, 0, 'compatibility calls must not rewrite local data or old metadata');
  loaded.entries[0].name = '本机继续编辑';
  const saved = await subject.store.saveState(loaded, loaded.revision);
  assert.equal((await subject.another().loadState()).entries[0].name, '本机继续编辑');
  assert.deepEqual(subject.envelope.sync, legacy);
  const restored = await subject.store.restoreSnapshot(saved.revision);
  assert.equal(restored.entries[0].name, 'local');
  assert.deepEqual(subject.envelope.sync, legacy, 'snapshot restore preserves retired metadata verbatim');
  assert.deepEqual(remote.calls, []);
  assert.deepEqual(remote.existing, beforeRemote);
});

test('local navigation above native-sync quota saves, reloads and restores through ZIP without truncation', async () => {
  const remote = retiredNativeStore();
  const subject = harness({ syncStore: remote.adapter });
  let state = await subject.store.loadState();
  for (let index = 0; index < 300; index++) state.entries.push({ ...site(`site-${index}`, `网站 ${index}`, index),
    url: `https://example.com/${'a'.repeat(500)}?id=${index}` });
  assert(Buffer.byteLength(JSON.stringify(state)) > 100 * 1024, 'fixture must exceed the removed native sync quota');
  state = await subject.store.saveState(state, state.revision);
  assert.equal((await subject.another().loadState()).entries.length, 300);
  assert.equal(Object.hasOwn(subject.envelope, 'sync'), false, 'new local envelopes create no browser-sync history');
  const archive = await subject.store.exportBackup(state);
  const plan = await subject.store.inspectBackup(archive);
  const restored = await subject.store.restoreBackup(plan, state.revision);
  assert.deepEqual(restored.entries, state.entries);
  assert.equal(restored.entries.length, 300);
  assert.deepEqual(remote.calls, []);
});

test('exhausted or malformed retired native metadata cannot block valid local edits', async () => {
  const remote = retiredNativeStore();
  const subject = harness({ syncStore: remote.adapter });
  const state = createEmptyState();
  const retired = { version: 99, enabled: true, dirty: true, blockedError: 'native history exhausted',
    document: { clock: 1, records: Object.fromEntries(Array.from({ length: 10001 }, (_, index) => [`e:old-${index}`, null])) },
    unknownLegacyField: { retain: ['all', 'original', 'metadata'] } };
  subject.seedEnvelope({ version: 1, state, snapshots: [], sync: retired });
  let current = await subject.store.loadState();
  current.entries.push(site('unlimited-local'));
  current = await subject.store.saveState(current, current.revision);
  assert.equal(current.revision, 1);
  assert.deepEqual(subject.envelope.sync, retired);
  current.entries[0].name = '继续保存在本机';
  current = await subject.store.saveState(current, current.revision);
  assert.equal((await subject.another().loadState()).entries[0].name, '继续保存在本机');
  assert.deepEqual(subject.envelope.sync, retired);
  const previous = subject.envelope;
  subject.failWrites();
  current.settings.width = 1200;
  await assert.rejects(subject.store.saveState(current, current.revision), /额度不足/u);
  assert.deepEqual(subject.envelope, previous, 'actual local persistence failures still preserve the last valid envelope');
  assert.deepEqual(remote.calls, []);
});
