import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, deleteEntry, letterIcon } from './model.js';
import { createReplica, recordChanges, combineReplicas, portableState, materializeState, syncConflicts, packReplica, readReplicas, publishReplica, assertSyncCapacity, SYNC_LIMITS } from './sync.js';
import { createColorBackground } from './background-colors.js';

const site = (id, name = id, order = 0) => ({ id, type: 'site', name, url: `https://${id}.example.com/`, groupId: 'group-home', parentId: null, icon: { kind: 'letter', value: '网' }, order });
const withSite = () => { const state = createEmptyState(); state.entries.push(site('alpha')); return state; };
const documents = (...replicas) => Object.fromEntries(replicas.map((replica) => [replica.actor, replica]));

test('custom gradient colors and Bezier curve travel together in one background sync record', async () => {
  const initial = createEmptyState(), changed = structuredClone(initial);
  changed.settings.background = createColorBackground({ colors: ['#a8b0c4', '#e1c6b0', '#d4dfcf'], angle: 225, curve: [0.17, 0.1, 0.65, 0.9] });
  const replica = recordChanges(createReplica('gradient-device'), initial, changed);
  assert.deepEqual(replica.records['s:background'].value, changed.settings.background);
  const packed = await packReplica(replica);
  const incoming = await readReplicas({ ...packed.chunks, [packed.key]: packed.head });
  const remote = materializeState(incoming.documents);
  assert.deepEqual(portableState(remote).settings.background, changed.settings.background);
});

test('causal registers merge independent records and setting fields without device clocks', () => {
  const baseline = createEmptyState();
  const first = withSite(); first.settings.width = 1200;
  const second = createEmptyState(); second.entries.push(site('beta')); second.settings.gap = 24;
  const a = recordChanges(createReplica('a'), baseline, first);
  const b = recordChanges(createReplica('b'), baseline, second);
  const merged = materializeState(documents(a, b));
  assert.deepEqual(merged.entries.map((entry) => entry.id), ['alpha', 'beta']);
  assert.equal(merged.settings.width, 1200);
  assert.equal(merged.settings.gap, 24);
  assert.equal(syncConflicts(documents(a, b)).length, 0);
  assert.deepEqual(materializeState(documents(b, a)).entries.map((entry) => entry.id), merged.entries.map((entry) => entry.id), 'ties are independent of read order');
});

test('column preference survives packed browser-sync round trips and legacy replicas use eight columns', async () => {
  const initial = createEmptyState();
  const changed = structuredClone(initial); changed.settings.columns = 10;
  const replica = recordChanges(createReplica('columns-device'), initial, changed);
  assert.equal(replica.records['s:columns'].value, 10);
  const packed = await packReplica(replica);
  const incoming = await readReplicas({ ...packed.chunks, [packed.key]: packed.head });
  const remote = materializeState(incoming.documents);
  assert.equal(remote.settings.columns, 10);
  assert.equal(portableState(remote).settings.columns, 10);
  const legacy = structuredClone(replica); delete legacy.records['s:columns'];
  assert.equal(materializeState(documents(legacy)).settings.columns, 8);
  const reset = structuredClone(remote); reset.settings.columns = 8;
  const resetReplica = recordChanges(replica, remote, reset, incoming.documents);
  assert.equal(materializeState(documents(resetReplica)).settings.columns, 8);
});

test('unified visual preference round trips without image results, preserves explicit disables and defaults missing legacy choices on', async () => {
  const initial = withSite();
  initial.settings.theme = 'dark'; initial.settings.shade = 42;
  initial.settings.visualEnhancement = false;
  initial.entries[0].icon = { kind: 'image', value: 'original-device-image' };
  initial.entries[0].iconBackground = '#aabbcc';
  const seed = recordChanges(createReplica('visual-device'), createEmptyState(), initial);
  const enabled = structuredClone(initial);
  enabled.settings.visualEnhancement = true;
  const replica = recordChanges(seed, initial, enabled, documents(seed));
  assert.deepEqual(Object.entries(replica.records).filter(([, operation]) => operation.n === replica.clock).map(([key]) => key).sort(), ['s:visualEnhancement']);
  const packed = await packReplica(replica);
  const incoming = await readReplicas({ ...packed.chunks, [packed.key]: packed.head });
  const remote = materializeState(incoming.documents);
  assert.equal(remote.settings.visualEnhancement, true);
  assert.equal(remote.settings.theme, 'dark');
  assert.equal(remote.settings.shade, 42);
  assert.equal(remote.entries[0].iconBackground, '#aabbcc');
  assert.equal(remote.entries[0].icon.kind, 'url');
  assert.equal(JSON.stringify(incoming.documents).includes('original-device-image'), false);
  assert.deepEqual(materializeState(incoming.documents, enabled).entries[0].icon, initial.entries[0].icon);
  const legacy = structuredClone(replica);
  delete legacy.records['s:visualEnhancement'];
  assert.equal(materializeState(documents(legacy)).settings.visualEnhancement, true);
  const disabled = structuredClone(remote);
  disabled.settings.visualEnhancement = false;
  const reset = recordChanges(replica, remote, disabled, incoming.documents);
  const final = materializeState(documents(reset), enabled);
  assert.equal(final.settings.visualEnhancement, false);
  assert.equal(final.settings.shade, 42);
  assert.deepEqual(final.entries[0].icon, initial.entries[0].icon);
});

test('deletion tombstones suppress older writes; concurrent edit remains recoverable', () => {
  const baseline = createEmptyState(); const initial = withSite();
  const a1 = recordChanges(createReplica('a'), baseline, initial);
  const edited = structuredClone(initial); edited.entries[0].name = '离线修改';
  const b1 = recordChanges(createReplica('b'), initial, edited, documents(a1));
  const removed = deleteEntry(initial, 'alpha');
  const a2 = recordChanges(a1, initial, removed, documents(a1));
  assert.equal(materializeState(documents(a2, b1)).entries.length, 0);
  const conflict = syncConflicts(documents(a2, b1))[0];
  assert.equal(conflict.name, '离线修改');
  assert.equal(conflict.deleted, false);
  const recovered = recordChanges(a2, removed, removed, documents(a2, b1), { [conflict.key]: conflict.value });
  assert.equal(materializeState(documents(recovered, b1)).entries[0].name, '离线修改');
  assert.equal(syncConflicts(documents(recovered, b1)).length, 0);
  const observedDelete = recordChanges(a1, edited, removed, documents(a1, b1));
  assert.equal(materializeState(documents(observedDelete, b1)).entries.length, 0);
  assert.equal(syncConflicts(documents(observedDelete, b1)).length, 0, 'an observed edit is causally superseded rather than resurrected');
});

test('deleted folders retain concurrently added sites in the desktop', () => {
  const baseline = createEmptyState();
  const grouped = withSite(); grouped.groups.push({ id: 'other', name: '其他' });
  grouped.entries[0].groupId = 'other';
  grouped.entries[0].parentId = 'folder';
  grouped.entries.unshift({ id: 'folder', type: 'folder', name: '资料', groupId: 'other', parentId: null, icon: { kind: 'letter', value: '资' }, order: 0 });
  const a = recordChanges(createReplica('a'), baseline, grouped);
  const empty = createEmptyState();
  const b = recordChanges(createReplica('b'), grouped, empty, documents(a));
  const concurrent = structuredClone(grouped); concurrent.entries.push({ ...site('beta'), groupId: 'other', parentId: 'folder', order: 1 });
  const c = recordChanges(createReplica('c'), grouped, concurrent, documents(a));
  const merged = materializeState(documents(a, b, c));
  assert.deepEqual(merged.entries.map((entry) => entry.id), ['beta']);
  assert.equal(merged.entries[0].parentId, null);
  assert.equal(merged.entries[0].groupId, 'group-home');
});

test('legacy devices cannot reintroduce groups through incoming replicas or portable exports', () => {
  const legacy = createEmptyState();
  legacy.groups = [{ id: 'old-b', name: '旧 B' }, { id: 'old-a', name: '旧 A' }];
  legacy.entries = [
    { ...site('alpha'), groupId: 'old-a' },
    { ...site('beta'), groupId: 'old-b' },
    { id: 'folder', type: 'folder', name: '资料', groupId: 'old-a', parentId: null, icon: { kind: 'letter', value: '资' }, order: 1 },
    { ...site('child'), groupId: 'old-a', parentId: 'folder' },
  ];
  const incoming = createReplica('old-device'); incoming.clock = 1;
  const operation = (value) => ({ n: 1, context: {}, value });
  legacy.groups.forEach((group, position) => { incoming.records[`g:${group.id}`] = operation({ ...group, position }); });
  legacy.entries.forEach((entry) => { incoming.records[`e:${entry.id}`] = operation(entry); });
  const merged = materializeState(documents(incoming));
  assert.deepEqual(merged.groups, [{ id: 'group-home', name: '桌面' }]);
  assert.deepEqual(merged.entries.filter((entry) => entry.parentId === null).sort((a, b) => a.order - b.order).map((entry) => entry.id), ['beta', 'alpha', 'folder']);
  assert.equal(merged.entries.find((entry) => entry.id === 'child').parentId, 'folder');
  assert.ok(merged.entries.every((entry) => entry.groupId === 'group-home'));
  const portable = portableState(legacy);
  assert.deepEqual(portable.groups, merged.groups);
  assert.deepEqual(portable.entries.map((entry) => [entry.id, entry.parentId, entry.order]), legacy.entries.map((entry) => [entry.id, entry.parentId, entry.id === 'alpha' ? 1 : entry.id === 'folder' ? 2 : 0]));
  const outgoing = recordChanges(createReplica('new-device'), createEmptyState(), legacy);
  assert.equal(Object.keys(outgoing.records).some((key) => key.startsWith('g:old-')), false);
  assert.ok(Object.entries(outgoing.records).filter(([key]) => key.startsWith('e:')).every(([, record]) => record.value.groupId === 'group-home'));
  const competing = structuredClone(incoming);
  competing.actor = 'another-old-device';
  competing.records['g:old-b'].value.name = '另一台设备的旧分组名';
  assert.equal(syncConflicts(documents(incoming, competing)).length, 0, 'retired group names must not appear as recoverable product conflicts');
});

test('portable synchronization removes image IDs while preserving unchanged icons on their original device', () => {
  const baseline = createEmptyState(); const local = withSite();
  local.entries[0].icon = { kind: 'image', value: 'local-only-asset-id' };
  local.entries[0].iconBackground = '#b6d8fa';
  local.settings.background = { kind: 'image', value: 'old-wallpaper-id' };
  const portable = portableState(local);
  assert.deepEqual(portable.entries[0].icon, { kind: 'url', value: 'https://alpha.example.com/favicon.ico' });
  assert.equal(portable.entries[0].iconBackground, '#b6d8fa');
  assert.deepEqual(portable.settings.background, createEmptyState().settings.background);
  const replica = recordChanges(createReplica('a'), baseline, local);
  const packedText = JSON.stringify(replica);
  assert.equal(packedText.includes('local-only-asset-id'), false);
  assert.equal(packedText.includes('old-wallpaper-id'), false);
  assert.equal(materializeState(documents(replica), local).entries[0].icon.kind, 'image');
  assert.equal(materializeState(documents(replica)).entries[0].icon.kind, 'url');
  const remote = materializeState(documents(replica));
  remote.entries[0].iconBackground = '#112233';
  const recolored = recordChanges(createReplica('b'), materializeState(documents(replica)), remote, documents(replica));
  const merged = materializeState(documents(replica, recolored), local);
  assert.deepEqual(merged.entries[0].icon, local.entries[0].icon, 'editing the portable background does not discard the original local image');
  assert.equal(merged.entries[0].iconBackground, '#112233');
  assert.equal(materializeState(documents(replica, recolored)).entries[0].iconBackground, '#112233');
  const oldReplica = structuredClone(replica); oldReplica.records['e:alpha'].value.icon = { kind: 'letter', value: 'a' };
  assert.deepEqual(materializeState(documents(oldReplica), local).entries[0].icon, local.entries[0].icon, 'an unchanged one-character fallback from a v1 device still restores its local image');
});

test('remote name changes preserve a local site image while changing the URL origin drops the stale image', () => {
  const local = withSite(); local.entries[0].icon = { kind: 'image', value: 'local-original-icon' };
  const a = recordChanges(createReplica('image-device'), createEmptyState(), local);
  const remote = materializeState(documents(a));
  const renamed = structuredClone(remote);
  renamed.entries[0].name = '重命名网站';
  renamed.entries[0].icon = letterIcon(renamed.entries[0].name);
  const b = recordChanges(createReplica('text-device'), remote, renamed, documents(a));
  const merged = materializeState(documents(a, b), local);
  assert.equal(merged.entries[0].name, '重命名网站');
  assert.deepEqual(merged.entries[0].icon, local.entries[0].icon, 'a remote label edit did not change the same-origin image');
  const redirected = structuredClone(renamed);
  redirected.entries[0].url = 'https://different.example.com/';
  delete redirected.entries[0].iconUrl;
  const moved = recordChanges(b, renamed, redirected, documents(a, b));
  const latest = materializeState(documents(a, moved), merged);
  assert.deepEqual(latest.entries[0].icon, { kind: 'url', value: 'https://different.example.com/favicon.ico' }, 'a new origin derives its own portable address instead of reusing the old local image');
  assert.equal(local.entries[0].icon.value, 'local-original-icon', 'the source configuration is not mutated or deleted');
});

test('legacy preset sync preserves committed bytes and causal identity while active state uses text icons', async () => {
  const legacy = createReplica('legacy-preset'); legacy.clock = 1;
  legacy.records['e:alpha'] = { n: 1, context: {}, value: { ...site('alpha', 'GitHub'), icon: { kind: 'preset', value: 'github' } } };
  const packed = await packReplica(legacy);
  const incoming = await readReplicas({ ...packed.chunks, [packed.key]: packed.head });
  assert.deepEqual(incoming.documents[legacy.actor], legacy, 'wire validation must not rewrite data covered by the hash');
  assert.doesNotThrow(() => combineReplicas(documents(legacy), incoming.documents));
  const active = materializeState(incoming.documents);
  assert.deepEqual(active.entries[0].icon, { kind: 'letter', value: 'Gi' });
  assert.equal(legacy.records['e:alpha'].value.icon.kind, 'preset');
  const unchanged = recordChanges(createReplica('new-device'), active, active, incoming.documents);
  assert.equal(unchanged.clock, 0, 'loading an old preset is not itself an authored user edit');
  active.entries[0].iconBackground = '#fef0cc';
  const edited = recordChanges(unchanged, materializeState(incoming.documents), active, incoming.documents);
  const merged = materializeState(combineReplicas(incoming.documents, documents(edited)));
  assert.equal(merged.entries[0].iconBackground, '#fef0cc');
  assert.deepEqual(merged.entries[0].icon, { kind: 'url', value: 'https://alpha.example.com/favicon.ico' });
  assert.equal(syncConflicts(combineReplicas(incoming.documents, documents(edited))).length, 0);
});

test('retired built-in search is omitted from active sync without rewriting old replicas or creating an edit', async () => {
  const builtin = { id: 'baidu', name: '百度', template: 'https://www.baidu.com/s?wd={query}' };
  const custom = { ...builtin, id: 'my-baidu', name: '自定义百度' };
  const before = createEmptyState(); before.providers.push(builtin, custom);
  const legacy = createReplica('legacy-search'); legacy.clock = 1;
  legacy.records['p:baidu'] = { n: 1, context: {}, value: { ...builtin, position: 3 } };
  legacy.records['p:my-baidu'] = { n: 1, context: {}, value: { ...custom, position: 4 } };
  const packed = await packReplica(legacy);
  const incoming = await readReplicas({ ...packed.chunks, [packed.key]: packed.head });
  assert.deepEqual(incoming.documents[legacy.actor], legacy, 'the committed legacy bytes and identity remain intact');
  assert.doesNotThrow(() => combineReplicas(documents(legacy), incoming.documents));
  const active = materializeState(incoming.documents);
  assert.deepEqual(active.providers, [...createEmptyState().providers, custom]);
  assert.equal(portableState(before).providers.some((provider) => provider.id === 'baidu'), false);
  const local = createReplica('current-search');
  assert.deepEqual(recordChanges(local, before, active, incoming.documents), local, 'migrating the retired built-in is not an authored sync operation');
  assert.deepEqual(materializeState(documents(legacy)).providers, active.providers, 'an unchanged older device cannot reintroduce the built-in');
});

test('sync commits require every hashed shard; missing or tampered data cannot replace a committed replica', async () => {
  const state = createEmptyState();
  for (let index = 0; index < 80; index++) state.entries.push(site(`site-${index}`, `测试站点 ${index} 🌍`, index));
  const replica = recordChanges(createReplica('device-a'), createEmptyState(), state);
  const packed = await packReplica(replica);
  assert.ok(Object.keys(packed.chunks).length > 1);
  const items = { ...packed.chunks, [packed.key]: packed.head };
  const parsed = await readReplicas(items);
  assert.deepEqual(parsed.documents['device-a'], replica);
  const partial = structuredClone(items); delete partial[packed.head.parts[0]];
  const missing = await readReplicas(partial);
  assert.deepEqual(missing.incomplete, ['device-a']);
  assert.equal(Object.keys(missing.documents).length, 0);
  const repair = {
    async set(values) { Object.assign(partial, values); },
    async remove(keys) { for (const key of keys) delete partial[key]; },
  };
  assert.equal((await publishReplica(repair, replica, structuredClone(partial))).written, true, 'an owner can repair missing shards even if the commit head already matches');
  assert.deepEqual((await readReplicas(partial)).documents['device-a'], replica);
  const tampered = structuredClone(items); tampered[packed.head.parts[0]] += ' ';
  await assert.rejects(readReplicas(tampered), /校验/u);
  for (const [key, value] of Object.entries(items)) assert.ok(Buffer.byteLength(key + JSON.stringify(value), 'utf8') <= SYNC_LIMITS.item);
});

test('a publication failure preserves the previous commit and staged capacity includes old chunks', async () => {
  const first = recordChanges(createReplica('a'), createEmptyState(), withSite());
  const packed = await packReplica(first);
  let items = { ...packed.chunks, [packed.key]: packed.head };
  const changed = withSite(); changed.entries[0].name = '第二版';
  const next = recordChanges(first, withSite(), changed, documents(first));
  const store = {
    async set(values) { if (Object.hasOwn(values, packed.key)) throw new Error('提交头写入失败'); Object.assign(items, values); },
    async remove(keys) { for (const key of keys) delete items[key]; },
  };
  await assert.rejects(publishReplica(store, next, structuredClone(items)), /写入失败/u);
  assert.deepEqual((await readReplicas(items)).documents.a, first);
  const almostFull = {};
  for (let index = 0; index < 13; index++) almostFull[`unrelated-${index}`] = 'x'.repeat(7550);
  Object.assign(almostFull, items);
  assertSyncCapacity(almostFull);
  const larger = withSite(); larger.entries[0].url += 'q'.repeat(3000);
  const largeNext = recordChanges(next, changed, larger, documents(next));
  let calls = 0;
  await assert.rejects(publishReplica({ set: async () => { calls++; }, remove: async () => { calls++; } }, largeNext, almostFull), { code: 'SYNC_CAPACITY' });
  assert.equal(calls, 0, 'capacity must be checked before mutating the old commit');
  assert.throws(() => assertSyncCapacity({ unicode: '中'.repeat(3000) }), { code: 'SYNC_CAPACITY' });
  assert.throws(() => assertSyncCapacity(Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`k${index}`, '']))), { code: 'SYNC_CAPACITY' });
});

test('same installation clock collisions and invalid record identities fail closed', () => {
  const a = recordChanges(createReplica('a'), createEmptyState(), withSite());
  const conflicting = structuredClone(a); conflicting.records['e:alpha'].value.name = '不同提交';
  assert.throws(() => combineReplicas(documents(a), documents(conflicting)), { code: 'SYNC_DEVICE_CONFLICT' });
  const wrongId = structuredClone(a); wrongId.records['e:alpha'].value.id = 'beta';
  assert.throws(() => combineReplicas(documents(wrongId)), /标识/u);
});

test('a committed generation retries failed old-chunk cleanup without rewriting the same head', async () => {
  const first = recordChanges(createReplica('a'), createEmptyState(), withSite());
  const before = await packReplica(first);
  const other = await packReplica(createReplica('other-device'));
  const items = { ...before.chunks, [before.key]: before.head, ...other.chunks, [other.key]: other.head };
  const changed = withSite(); changed.entries[0].name = '更新版本';
  const next = recordChanges(first, withSite(), changed, documents(first));
  let sets = 0;
  let removals = 0;
  let failCleanup = true;
  const store = {
    async set(values) { sets++; Object.assign(items, values); },
    async remove(keys) {
      removals++;
      if (failCleanup) throw new Error('临时清理失败');
      assert.ok(keys.every((key) => key.startsWith('owntab.sync.v1.a.')), 'never remove another installation’s keys');
      for (const key of keys) delete items[key];
    },
  };
  await assert.rejects(publishReplica(store, next, structuredClone(items)), /临时清理失败/u);
  assert.equal(sets, 2, 'chunks and head were committed before cleanup failed');
  assert.equal(items[before.key].clock, next.clock);
  assert.ok(Object.keys(before.chunks).every((key) => Object.hasOwn(items, key)));
  failCleanup = false;
  const result = await publishReplica(store, next, structuredClone(items));
  assert.equal(result.written, false);
  assert.equal(sets, 2, 'matching complete commit is not written again');
  assert.equal(removals, 2, 'cleanup is retried');
  assert.ok(Object.keys(before.chunks).every((key) => !Object.hasOwn(items, key)));
  assert.deepEqual(items[other.key], other.head);
  assert.ok(Object.keys(other.chunks).every((key) => Object.hasOwn(items, key)));
  assert.equal(result.bytes, assertSyncCapacity(items));
  assert.deepEqual((await readReplicas(items)).documents.a, next);
});
