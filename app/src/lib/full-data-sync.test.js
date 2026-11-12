import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFullDataSync } from './full-data-sync.js';
import { encryptCloudPayload } from './cloud-crypto.js';

const clone = (value) => structuredClone(value), password = 'full data synthetic test passphrase';
const target = 'a'.repeat(64), id = (record) => JSON.stringify([record.namespace, record.key]);
const record = (key, value, namespace = 'preferences') => ({ namespace, key, value });
function memory(initial = null) {
  let value = clone(initial);
  return { async read() { return clone(value); }, async write(next) { value = clone(next); }, get value() { return clone(value); } };
}
function pendingMemory() {
  const values = new Map();
  return { async get(key) { return clone(values.get(key)); }, async set(key, value) { values.set(key, clone(value)); }, async remove(key) { values.delete(key); },
    async entries() { return clone([...values]); }, values };
}
function remote() {
  const manifests = new Map(), chunks = new Map(), calls = [];
  let unknownIndex = false, unknownChunk = false, failWrites = false;
  const provider = (area, values) => ({
    async list() { calls.push([area, 'list']); return [...values].map(([name, bytes]) => ({ name, size: bytes.length })); },
    async read(name) { calls.push([area, 'read', name]); return values.get(name)?.slice(); },
    async write(name, bytes) {
      calls.push([area, 'write', name, bytes.slice()]);
      if (failWrites) throw Error('offline synthetic fake-access-token');
      if (values.has(name)) assert.deepEqual(bytes, values.get(name), 'immutable filename cannot be reused for another ciphertext');
      values.set(name, bytes.slice());
      if (area === 'indexes' && unknownIndex) { unknownIndex = false; throw Error('unknown write'); }
      if (area === 'chunks' && unknownChunk) { unknownChunk = false; throw Error('unknown chunk write'); }
    },
  });
  return { manifests, chunks, calls, provider: provider('indexes', manifests), assetProvider: provider('chunks', chunks),
    set unknownIndex(value) { unknownIndex = value; }, set unknownChunk(value) { unknownChunk = value; }, set failWrites(value) { failWrites = value; } };
}
function device(remote, actor, options = {}) {
  let records = clone(options.records || []), revision = 0, race = false, activePassword = password, allowed = true, applied = 0, activeRemote = remote, activeTarget = target;
  const store = options.store || memory(), historyStore = options.historyStore || memory(), pendingStore = options.pendingStore || pendingMemory(), listeners = new Set();
  const snapshotStore = {
    syncMetadataStore: store,
    async snapshot() { return { version: 1, records: clone(records), token: String(revision) }; },
    async apply(next, { expectedToken, syncMetadata }) {
      if (race) { race = false; records.push(record('covelet.racing.v1', { retained: true })); revision++; }
      if (expectedToken !== String(revision)) throw Object.assign(Error('synthetic CAS conflict'), { code: 'REVISION_CONFLICT' });
      if (syncMetadata !== undefined) await store.write(syncMetadata);
      records = clone(next.records); if (options.applyTransform) records = options.applyTransform(records);
      revision++; applied++; for (const listener of listeners) listener({ source: 'sync' });
      return snapshotStore.snapshot();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const access = async (request) => {
    options.onAccess?.(request);
    return { target: activeTarget, password: activePassword, autoSync: false, provider: activeRemote.provider, assetProvider: activeRemote.assetProvider,
      githubV2: activeRemote.githubV2,
      async check() { if (!allowed) throw Object.assign(Error('locked'), { code: 'CLOUD_LOCKED' }); } };
  };
  const make = () => createFullDataSync({ store, historyStore, pendingStore, snapshotStore, access, currentTarget: () => activeTarget, uuid: () => actor.repeat(32), locks: null,
    eventWindow: null, eventDocument: null, ...options });
  return { api: make(), make, store, historyStore, pendingStore, snapshotStore, get records() { return clone(records); }, get applied() { return applied; },
    edit(update) { const next = clone(records); update(next); records = next; revision++; for (const listener of listeners) listener({ source: 'local' }); },
    set race(value) { race = value; }, set password(value) { activePassword = value; }, set allowed(value) { allowed = value; },
    switchRemote(next, targetValue) { activeRemote = next; activeTarget = targetValue; } };
}
const saved = async (subject) => { const result = await subject.api.syncFullDataNow(); assert.equal(result.phase, 'saved', `${result.code}: ${result.message}`); return result; };
const conflicted = async (subject, options) => { const result = await subject.api.syncFullDataNow(options); assert.equal(result.phase, 'conflict', `${result.code}: ${result.message}`); return result; };
const find = (subject, key) => subject.records.find((record) => record.key === key);

test('run history records each completed flight once, including no-op and failed syncs', async () => {
  const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.run.v1', { body: 'private history fixture' })] });
  const originalList = cloud.provider.list;
  let beginList, releaseList;
  const listStarted = new Promise(resolve => { beginList = resolve; });
  const gate = new Promise(resolve => { releaseList = resolve; });
  cloud.provider.list = async () => { beginList(); await gate; return originalList(); };
  const first = a.api.syncFullDataNow(), sameFlight = a.api.syncFullDataNow();
  await listStarted;
  assert.deepEqual(await a.api.getFullDataRuns(target), [], 'unfinished transfer has no terminal record');
  releaseList();
  assert.deepEqual(await first, await sameFlight);
  const [firstRun] = await a.api.getFullDataRuns(target);
  assert.equal(firstRun.outcome, 'success');
  assert.ok(firstRun.startedAt <= firstRun.finishedAt);
  assert.equal((await a.api.getFullDataRuns(target)).length, 1);
  const writeCount = cloud.calls.filter(([, method]) => method === 'write').length;
  await saved(a);
  assert.equal(cloud.calls.filter(([, method]) => method === 'write').length, writeCount);
  assert.deepEqual((await a.api.getFullDataRuns(target)).map(run => run.outcome), ['success', 'success']);

  a.edit(records => { records[0].value.body = 'new private body'; });
  cloud.failWrites = true;
  assert.equal((await a.api.syncFullDataNow()).phase, 'error');
  a.api = a.make();
  const history = await a.api.getFullDataRuns(target);
  assert.deepEqual(history.map(run => run.outcome), ['failure', 'success', 'success']);
  assert.equal(new Set(history.map(run => run.id)).size, 3);
  assert.deepEqual(await a.api.getFullDataRuns('b'.repeat(64)), []);
  assert.doesNotMatch(JSON.stringify(a.historyStore.value), /private|token/);
});

test('sync history retains only the latest twenty terminal attempts for the active target', async () => {
  const a = device(remote(), 'a');
  a.allowed = false;
  for (let index = 0; index < 21; index++) assert.equal((await a.api.syncFullDataNow()).phase, 'locked');
  const history = await a.api.getFullDataRuns(target);
  assert.equal(history.length, 20);
  assert.ok(history.every(run => run.outcome === 'failure'));
  const nextTarget = 'b'.repeat(64);
  a.switchRemote(remote(), nextTarget);
  assert.deepEqual(await a.api.getFullDataRuns(nextTarget), []);
  assert.equal((await a.api.syncFullDataNow()).phase, 'locked');
  assert.deepEqual(await a.api.getFullDataRuns(target), []);
  assert.equal((await a.api.getFullDataRuns(nextTarget)).length, 1);
});

test('all namespaces, extension records and a Blob exceeding the old document limit cross devices without plaintext or repeat upload', async () => {
  const cloud = remote(), bytes = new Uint8Array(650 * 1024).map((_, index) => index % 251);
  const initial = [record('owntab.local.v1', { state: { entries: [{ id: 'site-with-local-asset' }] } }),
    record('covelet.tools.v1', { notes: [{ body: 'PRIVATE-NOTE-SENTINEL' }], snapshots: [{ tabs: ['private.example'] }], trash: [] }),
    record('covelet.clock.v1.widget-1', { elapsed: 1234 }), record('covelet.github.calendar.v1', { calendar: [1, 2, 3] }),
    record('covelet.desktop-templates.v1', { templates: [] }), record('covelet.recovery-point.v1', { previous: 'recovery sentinel' }),
    record('custom-image', { blob: new Blob([bytes], { type: 'image/png' }), empty: new Blob([]) }, 'assets'),
    record('https://icons.example/a.png', { blob: new Blob([bytes.slice(0, 128)], { type: 'image/png' }) }, 'navigation-icons'),
    record('https://search.example', { blob: new Blob([bytes.slice(0, 128)], { type: 'image/png' }) }, 'provider-icons'),
    record('current', { blob: new Blob([bytes.slice(0, 128)], { type: 'image/png' }) }, 'wallpaper')];
  const a = device(cloud, 'a', { records: initial }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  assert.deepEqual(a.records.map(id).sort(), b.records.map(id).sort());
  assert.deepEqual(new Uint8Array(await find(b, 'custom-image').value.blob.arrayBuffer()), bytes);
  assert.equal(find(b, 'custom-image').value.blob.type, 'image/png'); assert.equal(find(b, 'custom-image').value.empty.size, 0);
  for (const bytes of [...cloud.manifests.values(), ...cloud.chunks.values()]) {
    const body = new TextDecoder().decode(bytes); assert.equal(body.includes('PRIVATE-NOTE-SENTINEL'), false); assert.equal(body.includes('icons.example'), false);
  }
  for (const [name, bytes] of cloud.chunks) {
    const cipherHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    assert.equal(name.split('-')[1], cipherHash.slice(0, 32), 'public chunk names derive only from randomized ciphertext, never a plaintext dictionary hash');
  }
  const writes = cloud.calls.filter(([, method]) => method === 'write').length;
  await saved(a); assert.equal(cloud.calls.filter(([, method]) => method === 'write').length, writes, 'unchanged data/images are not uploaded again');
  assert.equal(a.pendingStore.values.size, 0, 'acknowledged ciphertext staging is removed');
});

test('concurrent delete/edit holds the complete local snapshot and never publishes it until an explicit choice', async () => {
  const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.note-1.v1', { body: 'initial' })] }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit((records) => records.splice(0, 1)); b.edit((records) => { records[0].value.body = 'offline renamed'; records.push(record('covelet.extra.v1', { retained: true })); });
  await saved(a);
  const writes = cloud.calls.filter(([, method]) => method === 'write').length;
  await conflicted(b); await saved(a);
  assert.equal(cloud.calls.filter(([, method]) => method === 'write').length, writes);
  assert.equal(find(a, 'covelet.note-1.v1'), undefined); assert.equal(find(a, 'covelet.extra.v1'), undefined);
  assert.equal(find(b, 'covelet.note-1.v1').value.body, 'offline renamed');
  const conflicts = await b.api.getFullDataConflicts();
  assert.equal(conflicts.length, 2); assert.ok(conflicts.some((item) => item.deleted));
  assert.ok(conflicts.every((item) => !own(item, 'value')), 'status does not expose private conflict content');
  const [conflictRun] = await b.api.getFullDataRuns(target);
  assert.equal(conflictRun.outcome, 'conflict'); assert.equal(conflictRun.conflictCount, 1);
  assert.equal(conflictRun.newConflictCount, 1, 'two candidates form a single conflict group');
  const attribution = { id: conflictRun.id, startedAt: conflictRun.startedAt };
  assert.ok(conflicts.every((item) => JSON.stringify(item.discoveredIn) === JSON.stringify(attribution)));
  await conflicted(b);
  assert.equal((await b.api.getFullDataRuns(target))[0].newConflictCount, 0);
  assert.deepEqual((await b.api.getFullDataConflicts())[0].discoveredIn, attribution);
  await b.historyStore.write(null);
  await conflicted(b);
  assert.equal((await b.api.getFullDataRuns(target))[0].newConflictCount, 0, 'upgrade does not assign an existing conflict to a new run');
  assert.equal((await b.api.getFullDataConflicts())[0].discoveredIn, null);
  assert.equal((await b.api.resolveFullDataConflicts('local')).phase, 'saved'); await saved(a);
  assert.equal(find(a, 'covelet.note-1.v1').value.body, 'offline renamed'); assert.equal((await a.api.getFullDataConflicts()).length, 0);
  assert.ok(find(a, 'covelet.extra.v1'));
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

test('discarding a conflict keeps the currently materialized record and resolves all concurrent versions', async () => {
  const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.note.v1', { body: 'initial' })] }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit((records) => { records[0].value.body = 'A'; }); b.edit((records) => { records[0].value.body = 'B'; });
  await saved(a); await conflicted(b); await saved(a);
  const current = find(b, 'covelet.note.v1').value.body, conflicts = await b.api.getFullDataConflicts(); assert.equal(conflicts.length, 2);
  await b.api.restoreFullDataConflict(conflicts[1].id, { discard: true }); await saved(b); await saved(a);
  assert.equal(find(a, 'covelet.note.v1').value.body, current); assert.equal((await a.api.getFullDataConflicts()).length, 0);
});

test('each bulk choice replaces the entire snapshot, including one-sided records and untouched shared records', async () => {
  for (const choice of ['local', 'remote']) {
    const cloud = remote(), key = 'covelet.bulk.main', common = 'covelet.bulk.common';
    const a = device(cloud, 'a', { records: [record(key, 'initial'), record(common, 'shared')] }), b = device(cloud, 'b');
    await saved(a); await saved(b); await saved(a);
    a.edit(records => { records.find(item => item.key === key).value = 'cloud'; records.push(record('cloud-only', 'cloud asset', 'future-assets')); });
    b.edit(records => { records.find(item => item.key === key).value = 'local'; records.push(record('local-only', 'local asset', 'future-assets')); });
    await saved(a);
    const oldIndexes = cloud.manifests.size, before = b.records;
    const detection = { taskId: '1'.repeat(32), expectedTarget: target };
    await conflicted(b, detection); await conflicted(b, detection);
    assert.deepEqual(b.records, before);
    assert.equal(cloud.manifests.size, oldIndexes);
    assert.equal((await b.api.getFullDataRuns(target)).filter(run => run.id === detection.taskId).length, 1);
    assert.equal((await b.api.getFullDataRuns(target))[0].newConflictCount, 1);
    const options = { taskId: '2'.repeat(32), expectedTarget: target };
    assert.equal((await b.api.resolveFullDataConflicts(choice, options)).phase, 'saved');
    assert.equal(cloud.manifests.size, oldIndexes + 1);
    assert.equal((await b.api.resolveFullDataConflicts(choice, options)).phase, 'saved');
    assert.equal(cloud.manifests.size, oldIndexes + 1);
    const winner = choice === 'local' ? 'local' : 'cloud', loser = winner === 'local' ? 'cloud' : 'local';
    await saved(a); await saved(b);
    for (const subject of [a, b]) {
      assert.equal(find(subject, key).value, winner);
      assert.equal(find(subject, common).value, 'shared');
      assert.equal(find(subject, winner + '-only').value, winner + ' asset');
      assert.equal(find(subject, loser + '-only'), undefined);
      assert.equal((await subject.api.getFullDataConflicts()).length, 0);
    }
    assert.equal(cloud.manifests.size, oldIndexes + 1, 'previous immutable artifacts remain and no extra resolution is published');
  }
});

async function indexCleanupFixture() {
  const cloud = remote(), key = 'covelet.bulk.cleanup';
  const asset = record('selected-image', { blob: new Blob(['selected bytes'], { type: 'image/png' }) }, 'assets');
  const a = device(cloud, 'a', { records: [record(key, 'initial')] }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit(records => { records[0].value = 'cloud'; records.push(record('cloud-only', 'old data')); });
  b.edit(records => { records[0].value = 'local'; records.push(asset); });
  await saved(a); await conflicted(b);
  const head = 'f'.repeat(40), obsolete = [...cloud.manifests.keys()], pinnedReads = [], prunes = [];
  cloud.provider.pinIndexes = async () => head;
  for (const [area, provider] of [['indexes', cloud.provider], ['chunks', cloud.assetProvider]]) {
    const read = provider.read;
    provider.read = async (name, ref) => { if (ref) pinnedReads.push({ area, name, ref }); return read(name); };
  }
  cloud.provider.pruneIndexes = async (ref, names) => {
    prunes.push({ ref, names, readsBeforePrune: pinnedReads.slice() });
    for (const name of names) cloud.manifests.delete(name);
  };
  return { cloud, a, b, head, obsolete, prunes, key };
}

test('local replacement restores all selected data from a pinned remote commit before pruning its obsolete indexes', async () => {
  const { cloud, a, b, head, obsolete, prunes, key } = await indexCleanupFixture();
  const retainedChunks = [...cloud.chunks.keys()];
  const options = { taskId: '4'.repeat(32) };
  const result = await b.api.resolveFullDataConflicts('local', options);
  assert.equal(result.phase, 'saved'); assert.equal(result.cleanup, 'indexes-cleaned');
  assert.equal(prunes.length, 1);
  assert.deepEqual(prunes[0].names, obsolete);
  assert.equal(prunes[0].ref, head);
  assert.ok(prunes[0].readsBeforePrune.every(({ ref }) => ref === head));
  assert.equal(prunes[0].readsBeforePrune.filter(({ area }) => area === 'indexes').length, obsolete.length + 1);
  assert.ok(prunes[0].readsBeforePrune.filter(({ area }) => area === 'chunks').length >= 3);
  assert.equal(cloud.manifests.size, 1);
  assert.ok(retainedChunks.every(name => cloud.chunks.has(name)), 'older clients may still reference the blobs');
  b.api = b.make();
  assert.equal((await b.api.resolveFullDataConflicts('local', options)).cleanup, 'indexes-cleaned');
  assert.equal(prunes.length, 1);
  const fresh = device(cloud, 'c');
  await saved(fresh); await saved(a);
  for (const subject of [fresh, a]) {
    assert.equal(find(subject, key).value, 'local');
    assert.equal(find(subject, 'cloud-only'), undefined);
    assert.equal(await find(subject, 'selected-image').value.blob.text(), 'selected bytes');
  }
});

test('failed pinned restore verification retains every cloud index despite successful replacement upload', async () => {
  const { cloud, b, head, obsolete, prunes } = await indexCleanupFixture();
  const read = cloud.assetProvider.read;
  cloud.assetProvider.read = (name, ref) => ref === head ? undefined : read(name, ref);
  const result = await b.api.resolveFullDataConflicts('local');
  assert.equal(result.phase, 'saved'); assert.equal(result.cleanup, 'retained');
  assert.deepEqual(prunes, []);
  assert.equal(cloud.manifests.size, obsolete.length + 1);
  assert.equal(b.store.value.metadata.cleanup, undefined);
});

test('an index that appeared before restore verification prevents all obsolete-index deletions', async () => {
  const { cloud, b, obsolete, prunes } = await indexCleanupFixture();
  const list = cloud.provider.list;
  const newIndex = obsolete[0].replace(/[a-f0-9]{64}\.json$/, `${'f'.repeat(64)}.json`);
  cloud.provider.list = async ref => {
    if (ref) cloud.manifests.set(newIndex, new Uint8Array([1]));
    return list();
  };
  const result = await b.api.resolveFullDataConflicts('local');
  assert.equal(result.phase, 'saved'); assert.equal(result.cleanup, 'retained');
  assert.deepEqual(prunes, []);
  assert.equal(cloud.manifests.size, obsolete.length + 2);
});

test('interrupted cleanup reuses the same verified replacement after a restart', async () => {
  const { cloud, b, head, obsolete, prunes } = await indexCleanupFixture();
  cloud.provider.pinIndexes = async () => { throw Object.assign(Error('timeout'), { code: 'CLOUD_TIMEOUT' }); };
  const options = { taskId: '5'.repeat(32) };
  const deferred = await b.api.resolveFullDataConflicts('local', options);
  assert.equal(deferred.phase, 'saved'); assert.equal(deferred.cleanup, 'deferred');
  assert.deepEqual(prunes, []);
  assert.equal(cloud.manifests.size, obsolete.length + 1);
  const plan = b.store.value.metadata.cleanup;
  assert.deepEqual(plan.obsolete, obsolete);
  cloud.provider.pinIndexes = async () => head;
  b.api = b.make();
  const resumed = await b.api.resolveFullDataConflicts('local', options);
  assert.equal(resumed.phase, 'saved'); assert.equal(resumed.cleanup, 'indexes-cleaned');
  assert.deepEqual([...cloud.manifests.keys()], [plan.index]);
  assert.equal(prunes.length, 1);
});

function githubRemote() {
  const cloud = remote(), staged = new Map(), commits = new Map(), calls = [];
  const live = { epoch: null, v1: { index: cloud.manifests, blob: cloud.chunks }, v2: { index: new Map(), blob: new Map() } };
  let sequence = 0, head, fault;
  const oid = () => (++sequence).toString(16).padStart(40, '0');
  function commit(state) { const sha = oid(); commits.set(sha, clone(state)); return sha; }
  head = commit(live);
  const current = ref => ref ? commits.get(ref) : live;
  const names = (files) => [...files].map(([name, bytes]) => ({ name, size: bytes.length }));
  const pinnedProvider = (layout, kind) => ({
    async list(ref) { return names(current(ref)[layout][kind]); },
    async read(name, ref) { calls.push({ action: 'read', layout, kind, name, ref }); return current(ref)[layout][kind].get(name)?.slice(); },
  });
  for (const [kind, provider] of [['index', cloud.provider], ['blob', cloud.assetProvider]]) {
    const write = provider.write;
    Object.assign(provider, pinnedProvider('v1', kind), {
      async write(name, bytes) { assert.equal(live.epoch, null, 'v1 sealed'); await write(name, bytes); head = commit(live); },
    });
  }
  cloud.githubV2 = { provider: pinnedProvider('v2', 'index'), assetProvider: pinnedProvider('v2', 'blob') };
  cloud.provider.githubStorage = {
    async pin(ref = head) { assert.ok(commits.has(ref)); return { head: ref }; },
    async readLayout(pin) { const epoch = current(pin?.head).epoch; return { layout: epoch ? 'v2' : 'v1', epoch }; },
    async files(pin, layout) { const { index, blob } = current(pin.head)[layout]; return { indexes: names(index), blobs: names(blob) }; },
    async uploadBlob(bytes) { const sha = oid(); staged.set(sha, bytes.slice()); calls.push({ action: 'upload', sha }); return sha; },
    async prepare(pin, { additions, deletions = [], seal }) {
      const candidate = clone(current(pin.head));
      for (const { kind, name, sha } of additions) candidate.v2[kind].set(name, staged.get(sha));
      for (const { kind, name } of deletions) assert.ok(candidate.v2[kind].delete(name));
      if (seal) { candidate.epoch = seal; candidate.v1.index.clear(); candidate.v1.blob.clear(); }
      if (fault === 'verify') {
        fault = null;
        const [name, bytes] = candidate.v2.blob.entries().next().value;
        candidate.v2.blob.set(name, bytes.map((byte, index) => index === 0 ? byte ^ 1 : byte));
      }
      const ref = commit(candidate);
      calls.push({ action: 'prepare', head: pin.head, ref, seal });
      return ref;
    },
    async advance(pin, ref) {
      calls.push({ action: 'advance', head: pin.head, ref });
      if (fault === 'stale') { fault = null; head = commit(live); }
      if (pin.head !== head) throw Object.assign(Error('test branch changed'), { code: 'CLOUD_STALE_HEAD' });
      const next = current(ref);
      live.epoch = next.epoch;
      live.v1.index.clear(); live.v1.blob.clear();
      for (const [name, bytes] of next.v1.index) live.v1.index.set(name, bytes);
      for (const [name, bytes] of next.v1.blob) live.v1.blob.set(name, bytes);
      live.v2 = clone(next.v2); head = ref;
      if (fault === 'lost') { fault = null; throw Object.assign(Error('test response lost'), { code: 'CLOUD_NETWORK' }); }
    },
  };
  return { cloud, live, calls, set fault(value) { fault = value; }, get head() { return head; } };
}

const githubDevice = (cloud, actor, records = []) => {
  let sequence = 0;
  return device(cloud, actor, { records, uuid: () => actor.repeat(16) + (++sequence).toString(16).padStart(16, '0') });
};
const githubKey = 'covelet.github-reset.test';
const githubImage = (key, text) => record(key, { blob: new Blob([text], { type: 'image/png' }) }, 'assets');
async function githubConflict() {
  const git = githubRemote();
  const a = githubDevice(git.cloud, 'a', [record(githubKey, 'initial')]), b = githubDevice(git.cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit(records => { records[0].value = 'cloud'; records.push(githubImage('old-image', 'obsolete bytes')); });
  b.edit(records => { records[0].value = 'local'; records.push(githubImage('chosen-image', 'selected bytes')); });
  await saved(a); await conflicted(b);
  return { git, a, b };
}

test('GitHub reset verifies the detached restore before cleanup and reconciles a lost branch update after restart', async () => {
  const { git, a, b } = await githubConflict();
  const previous = git.head, oldFiles = git.cloud.chunks.size;
  const options = { taskId: '8'.repeat(32) };
  git.fault = 'lost';
  assert.equal((await b.api.resolveFullDataConflicts('local', options)).phase, 'error');
  const plan = b.store.value.metadata.gitReset;
  assert.ok(plan.candidate);
  assert.equal(plan.head, previous);
  assert.equal(git.head, plan.candidate);
  const advance = git.calls.findIndex(item => item.action === 'advance');
  const reads = git.calls.slice(0, advance).filter(item => item.ref === plan.candidate && item.action === 'read');
  assert.ok(reads.some(item => item.kind === 'index' && item.name === plan.pending.name));
  assert.equal(new Set(reads.filter(item => item.kind === 'blob').map(item => item.name)).size, git.live.v2.blob.size);
  assert.ok(oldFiles > 0);
  assert.equal(git.cloud.manifests.size + git.cloud.chunks.size, 0);
  assert.equal(git.live.v2.index.size, 1);
  b.api = b.make();
  assert.equal((await b.api.resolveFullDataConflicts('local', options)).cleanup, 'files-cleaned');
  assert.equal(git.calls.filter(item => item.action === 'advance').length, 1);
  const fresh = githubDevice(git.cloud, 'c');
  await saved(fresh); await saved(a);
  for (const subject of [fresh, a]) {
    assert.equal(find(subject, githubKey).value, 'local');
    assert.equal(find(subject, 'old-image'), undefined);
    assert.equal(await find(subject, 'chosen-image').value.blob.text(), 'selected bytes');
  }
});

test('a cloud choice after a lost GitHub reset response adopts subsequent cloud edits instead of replaying the old reset', async () => {
  const { git, a, b } = await githubConflict();
  git.fault = 'lost';
  assert.equal((await b.api.resolveFullDataConflicts('local')).phase, 'error');
  const plan = b.store.value.metadata.gitReset;
  assert.ok(plan);
  assert.equal(git.live.epoch, plan.pending.name, 'the reset was published despite its lost response');
  await saved(a);
  a.edit(records => {
    records.find(item => item.key === githubKey).value = 'subsequent cloud edit';
    records.splice(records.findIndex(item => item.key === 'chosen-image'), 1);
    records.push(record('subsequent-cloud-only', 'latest record'), githubImage('subsequent-cloud-image', 'latest image bytes'));
  });
  await saved(a);
  const latest = a.records, head = git.head;
  const result = await b.api.resolveFullDataConflicts('remote');
  assert.equal(result.phase, 'saved', `${result.code}: ${result.message}`);
  assert.deepEqual(orderedRecords(b.records), orderedRecords(latest));
  assert.equal(await find(b, 'subsequent-cloud-image').value.blob.text(), 'latest image bytes');
  assert.equal(find(b, 'chosen-image'), undefined);
  assert.equal(b.store.value.metadata.gitReset, undefined);
  assert.equal(git.head, head, 'adopting the latest cloud snapshot must not republish the old reset');
});

test('a second GitHub reset removes all previous v2 indexes and blob files', async () => {
  const { git, a, b } = await githubConflict();
  assert.equal((await b.api.resolveFullDataConflicts('local')).cleanup, 'files-cleaned');
  await saved(a);
  a.edit(records => { records.find(item => item.key === githubKey).value = 'cloud again'; records.push(githubImage('old-image', 'more obsolete bytes')); });
  b.edit(records => { records.splice(records.findIndex(item => item.key === 'chosen-image'), 1); records.find(item => item.key === githubKey).value = 'local again'; });
  await saved(a); await conflicted(b);
  const obsolete = new Set([...git.live.v2.index.keys(), ...git.live.v2.blob.keys()]);
  const status = await b.api.resolveFullDataConflicts('local');
  assert.equal(status.cleanup, 'files-cleaned', `${status.code}: ${status.message}`);
  assert.equal(git.live.v2.index.size, 1);
  assert.ok([...git.live.v2.index.keys(), ...git.live.v2.blob.keys()].every(name => !obsolete.has(name)));
  const fresh = githubDevice(git.cloud, 'c'); await saved(fresh);
  assert.deepEqual(fresh.records, [record(githubKey, 'local again')]);
});

test('a GitHub reset cannot prune after a concurrent branch update', async () => {
  const { git, b } = await githubConflict();
  const before = clone(git.live), previous = git.head;
  git.fault = 'stale';
  assert.equal((await b.api.resolveFullDataConflicts('local')).phase, 'error');
  assert.notEqual(git.head, previous);
  assert.deepEqual(git.live, before);
  assert.equal(b.store.value.metadata.gitReset, undefined);
});

test('a corrupt detached GitHub reset candidate cannot prune any current cloud data', async () => {
  const { git, b } = await githubConflict();
  const before = clone(git.live), previous = git.head;
  git.fault = 'verify';
  assert.equal((await b.api.resolveFullDataConflicts('local')).phase, 'error');
  assert.equal(git.head, previous);
  assert.deepEqual(git.live, before);
  assert.equal(git.calls.filter(item => item.action === 'advance').length, 0);
  assert.equal(b.store.value.metadata.gitReset, undefined);
  assert.equal((await b.api.getFullDataConflicts()).length, 2);
});

test('a device crossing a GitHub reset still holds locally staged edits from an interrupted upload', async () => {
  const git = githubRemote(), a = githubDevice(git.cloud, 'a', [record(githubKey, 'initial')]);
  const b = githubDevice(git.cloud, 'b'), c = githubDevice(git.cloud, 'c');
  await saved(a); await saved(b); await saved(c); await saved(a);
  c.edit(records => { records[0].value = 'offline pending'; });
  git.cloud.failWrites = true;
  assert.equal((await c.api.syncFullDataNow()).phase, 'error');
  assert.ok(c.store.value.metadata.pending);
  git.cloud.failWrites = false;
  a.edit(records => { records[0].value = 'cloud'; });
  b.edit(records => { records[0].value = 'chosen'; });
  await saved(a); await conflicted(b);
  assert.equal((await b.api.resolveFullDataConflicts('local')).cleanup, 'files-cleaned');
  await conflicted(c);
  assert.equal(find(c, githubKey).value, 'offline pending');
});

async function githubReplacedEpoch({ pending = false } = {}) {
  const git = githubRemote();
  const a = githubDevice(git.cloud, 'a', [record(githubKey, 'initial'), record('shared-record', 'untouched'), githubImage('initial-image', 'initial image bytes')]);
  const b = githubDevice(git.cloud, 'b'), c = githubDevice(git.cloud, 'c');
  await saved(a); await saved(b); await saved(c); await saved(a);
  a.edit(records => { records.find(item => item.key === githubKey).value = 'old cloud'; records.push(githubImage('obsolete-image', 'obsolete bytes')); });
  b.edit(records => {
    records.find(item => item.key === githubKey).value = 'new cloud';
    records.splice(records.findIndex(item => item.key === 'initial-image'), 1);
    records.push(record('cloud-only', 'new cloud record'), githubImage('cloud-image', 'new cloud bytes'));
  });
  c.edit(records => {
    records.find(item => item.key === githubKey).value = 'offline local';
    records.push(record('offline-only', 'offline record'), githubImage('offline-image', 'offline bytes'));
  });
  if (pending) {
    git.cloud.failWrites = true;
    assert.equal((await c.api.syncFullDataNow()).phase, 'error');
    assert.ok(c.store.value.metadata.pending);
    git.cloud.failWrites = false;
  }
  await saved(a); await conflicted(b);
  if (!pending) await conflicted(c);
  const local = c.records;
  assert.equal((await b.api.resolveFullDataConflicts('local')).phase, 'saved');
  const cloud = b.records;
  const previousEpoch = c.store.value.metadata.gitEpoch;
  assert.notEqual(previousEpoch, git.live.epoch);
  assert.equal(git.cloud.manifests.size + git.cloud.chunks.size, 0, 'the old epoch data is no longer available remotely');
  return { git, a, b, c, local, cloud };
}

const orderedRecords = records => records.toSorted((a, b) => id(a).localeCompare(id(b)));
for (const choice of ['local', 'remote']) for (const pending of [false, true]) test(`an explicit ${choice} choice replaces the complete snapshot across a GitHub reset with ${pending ? 'an interrupted upload' : 'unsynced edits'}`, async () => {
  const { git, c, local, cloud } = await githubReplacedEpoch({ pending });
  const result = await c.api.resolveFullDataConflicts(choice);
  assert.equal(result.phase, 'saved', `${result.code}: ${result.message}`);
  assert.equal(result.conflicts, 0);
  const expected = choice === 'local' ? local : cloud;
  assert.deepEqual(orderedRecords(c.records), orderedRecords(expected), 'the first explicit choice must apply without a second click');
  assert.equal((await c.api.getFullDataConflicts()).length, 0);
  const fresh = githubDevice(git.cloud, 'd'); await saved(fresh);
  assert.deepEqual(orderedRecords(fresh.records), orderedRecords(expected), 'a fresh installation reads the same complete selected snapshot');
  const imageKey = choice === 'local' ? 'offline-image' : 'cloud-image';
  assert.equal(await find(fresh, imageKey).value.blob.text(), choice === 'local' ? 'offline bytes' : 'new cloud bytes');
  assert.equal(find(fresh, choice === 'local' ? 'cloud-only' : 'offline-only'), undefined);
});

test('ordinary sync across a GitHub reset retains unsynced records and images until an explicit choice', async () => {
  const { git, c, local } = await githubReplacedEpoch();
  const before = git.head;
  await conflicted(c);
  assert.deepEqual(c.records, local);
  assert.equal(await find(c, 'offline-image').value.blob.text(), 'offline bytes');
  assert.equal(git.head, before, 'ordinary sync must not publish an implicit overwrite');
  assert.ok((await c.api.getFullDataConflicts()).length > 0);
});

test('a stale local snapshot prevents a cross-epoch cloud choice from discarding local data or its sync checkpoint', async () => {
  const { git, c, local, cloud } = await githubReplacedEpoch();
  const checkpoint = c.store.value, head = git.head;
  c.race = true;
  const result = await c.api.resolveFullDataConflicts('remote');
  assert.equal(result.phase, 'error');
  assert.equal(result.code, 'REVISION_CONFLICT');
  assert.deepEqual(c.store.value, checkpoint, 'the failed atomic apply retains the previous epoch checkpoint');
  assert.deepEqual(orderedRecords(c.records), orderedRecords([...local, record('covelet.racing.v1', { retained: true })]));
  assert.equal(git.head, head);
  assert.equal((await c.api.resolveFullDataConflicts('remote')).phase, 'saved');
  assert.deepEqual(orderedRecords(c.records), orderedRecords(cloud));
});

test('a restarted cloud choice resumes the same pending revision without replacing a subsequent local edit', async () => {
  const cloud = remote(), key = 'covelet.bulk.resume', a = device(cloud, 'a', { records: [record(key, 'initial')] }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit(records => { records[0].value = 'cloud'; }); b.edit(records => { records[0].value = 'local'; });
  await saved(a); await conflicted(b);
  const options = { taskId: '3'.repeat(32), expectedTarget: target };
  cloud.unknownIndex = true;
  assert.equal((await b.api.resolveFullDataConflicts('remote', options)).phase, 'error');
  assert.equal(find(b, key).value, 'cloud');
  const pending = b.store.value.metadata.pending, indexes = cloud.manifests.size;
  assert.ok(pending);
  b.edit(records => { records[0].value = 'edited after reset'; });
  b.api = b.make();
  assert.equal((await b.api.resolveFullDataConflicts('remote', options)).phase, 'saved');
  assert.equal(cloud.manifests.size, indexes);
  assert.deepEqual(cloud.manifests.get(pending.name), new TextEncoder().encode(pending.body));
  assert.equal(b.store.value.metadata.pending, null);
  assert.equal(find(b, key).value, 'edited after reset');
  assert.deepEqual((await b.api.getFullDataRuns(target)).filter(run => run.id === options.taskId).map(run => run.outcome), ['success']);
});

test('cloud choice discards a previously published divergent local branch and preserves its shared ancestor', async () => {
  const cloud = remote(), key = 'covelet.bulk.legacy', shared = 'covelet.bulk.legacy-shared';
  const b = device(cloud, 'b', { records: [record(key, 'initial'), record(shared, 'from B before the divergence')] }), a = device(cloud, 'a');
  await saved(b); await saved(a); await saved(b);
  a.edit(records => { records.find(item => item.key === key).value = 'cloud'; records.push(record('cloud-only', 'cloud asset', 'future-assets')); });
  b.edit(records => { records.find(item => item.key === key).value = 'local'; records.push(record('local-only', 'local asset', 'future-assets')); });
  const originalList = cloud.provider.list;
  let release, listed = 0;
  const gate = new Promise(resolve => { release = resolve; });
  cloud.provider.list = async () => {
    const snapshot = await originalList();
    if (++listed === 2) release();
    await gate;
    return snapshot;
  };
  await Promise.all([saved(a), saved(b)]);
  cloud.provider.list = originalList;
  await conflicted(b);
  assert.equal((await b.api.resolveFullDataConflicts('remote')).phase, 'saved');
  assert.equal(find(b, key).value, 'cloud');
  assert.equal(find(b, shared).value, 'from B before the divergence');
  assert.equal(find(b, 'local-only'), undefined);
  assert.equal(find(b, 'cloud-only').value, 'cloud asset');
  await saved(a); assert.equal(find(a, 'local-only'), undefined);
});

test('unknown index and chunk write results retry the exact persisted ciphertext after restarting the engine', async () => {
  for (const area of ['index', 'chunk']) {
    const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.record.v1', { body: `retry-${area}` })] });
    if (area === 'index') cloud.unknownIndex = true; else cloud.unknownChunk = true;
    const failure = await a.api.syncFullDataNow(); assert.equal(failure.phase, 'error'); assert.ok(a.store.value.metadata.pending);
    const pending = a.store.value.metadata.pending, staged = clone([...a.pendingStore.values].filter(([, value]) => typeof value.body === 'string')); a.api = a.make();
    a.edit((records) => records.push(record('covelet.new-edit.v1', { retained: true })));
    await saved(a);
    assert.deepEqual(cloud.manifests.get(pending.name), new TextEncoder().encode(pending.body));
    for (const [name, body] of staged) assert.deepEqual(cloud.chunks.get(name), new TextEncoder().encode(body.body));
    assert.equal(a.store.value.metadata.pending, null); assert.ok(find(a, 'covelet.new-edit.v1'));
  }
});

test('a restarted transfer skips acknowledged chunks and verifies the unknown result with the original ciphertext', async () => {
  const cloud = remote(), bytes = new Uint8Array(650 * 1024).map((_, index) => index % 251);
  const a = device(cloud, 'a', { records: [record('large', new Blob([bytes]), 'future-assets')] });
  let attempt = 0;
  const write = cloud.assetProvider.write;
  cloud.assetProvider.write = async (name, data) => {
    if (++attempt === 2) cloud.unknownChunk = true;
    return write(name, data);
  };
  assert.equal((await a.api.syncFullDataNow()).phase, 'error');
  const pending = a.store.value.metadata.pending;
  assert.deepEqual(await a.pendingStore.get(pending.name), { acknowledged: 1 });
  const before = cloud.calls.length;
  a.api = a.make();
  await saved(a);
  const uploads = cloud.calls.slice(before).filter(([area, method]) => area === 'chunks' && method === 'write');
  assert.ok(uploads.every(([, , name]) => name !== pending.uploads[0].name));
  assert.equal(uploads[0][2], pending.uploads[1].name);
  assert.deepEqual(uploads[0][3], cloud.chunks.get(pending.uploads[1].name));
  assert.equal(a.pendingStore.values.size, 0);
});

test('wrong password and a corrupt referenced chunk reject the whole batch without applying or uploading local data', async () => {
  const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.private.v1', { secret: 'source data' })] }); await saved(a);
  const b = device(cloud, 'b', { records: [record('covelet.local-only.v1', { retained: true })] }), before = b.records;
  b.password = 'incorrect synthetic long password'; const writes = cloud.calls.filter(([, method]) => method === 'write').length;
  assert.equal((await b.api.syncFullDataNow()).code, 'CLOUD_DECRYPT'); assert.deepEqual(b.records, before); assert.equal(b.applied, 0);
  b.password = password; const name = cloud.chunks.keys().next().value, original = cloud.chunks.get(name); cloud.chunks.set(name, original.slice(0, original.length - 1));
  assert.equal((await b.api.syncFullDataNow()).phase, 'error'); assert.deepEqual(b.records, before); assert.equal(b.applied, 0);
  assert.equal(cloud.calls.filter(([, method]) => method === 'write').length, writes);
});

test('CAS failure keeps local edits, does not acknowledge received versions and retries staged chunks without dangling references', async () => {
  const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.remote.v1', { value: 'remote' })] }), b = device(cloud, 'b', { records: [record('covelet.local.v1', { value: 'local' })] });
  await saved(a); b.race = true;
  assert.equal((await b.api.syncFullDataNow()).code, 'REVISION_CONFLICT'); assert.equal(b.applied, 0); assert.ok(find(b, 'covelet.racing.v1'));
  assert.equal(Object.hasOwn(b.store.value.metadata.documents, 'a'.repeat(32)), false, 'uncommitted received causal clocks stay unobserved');
  b.api = b.make(); await saved(b); await saved(a);
  for (const key of ['covelet.local.v1', 'covelet.remote.v1', 'covelet.racing.v1']) assert.ok(find(a, key));
});

test('repeated pre-commit validation failures reclaim unreferenced staging while pending and persisted CAS references remain protected', async () => {
  const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.valid.v1', { retained: true }), record('covelet.privacy.lock.v1', { invalid: 'device only' })] });
  let previousNames = [];
  for (let retry = 0; retry < 3; retry++) {
    assert.equal((await a.api.syncFullDataNow()).phase, 'error'); assert.equal(a.store.value, null);
    const names = [...a.pendingStore.values.keys()]; assert.equal(names.length, 1, 'each retry leaves at most its own uncommitted staged chunk');
    for (const previous of previousNames) assert.equal(a.pendingStore.values.has(previous), false, 'prior failed attempt ciphertext is removed');
    previousNames = names;
  }
  a.edit((records) => records.pop()); cloud.unknownChunk = true;
  assert.equal((await a.api.syncFullDataNow()).phase, 'error');
  const pendingNames = a.store.value.metadata.pending.uploads.map((chunk) => chunk.name);
  assert.ok(pendingNames.length > 0); a.api = a.make(); await saved(a);
  for (const name of pendingNames) assert.ok(cloud.chunks.has(name), 'unknown-write pending chunks survive start-of-run cleanup');
  const b = device(cloud, 'b', { records: [record('covelet.local.v1', { staged: 'CAS-safe' })] }); b.race = true;
  assert.equal((await b.api.syncFullDataNow()).code, 'REVISION_CONFLICT');
  const protectedReferences = Object.values(b.store.value.metadata.document.records).flatMap((operation) => operation.value?.chunks || []);
  assert.ok(protectedReferences.length); b.api = b.make(); await saved(b);
  for (const chunk of protectedReferences) assert.ok(cloud.chunks.has(chunk.name), 'persisted authored references survive cleanup after CAS failure');
});

test('first empty target seeds the logical snapshot once and imports it with the original CAS token', async () => {
  const cloud = remote(); let seeds = 0;
  const a = device(cloud, 'a', { records: [record('covelet.local.v1', { retained: true })], seed: async (actual) => {
    seeds++; return { version: 1, records: [...actual.records, record('covelet.legacy.v1', { body: 'legacy imported' })] };
  } });
  await saved(a); await saved(a); assert.equal(seeds, 1); assert.ok(find(a, 'covelet.legacy.v1'));
  const b = device(cloud, 'b', { seed: async () => { throw Error('must not inspect legacy target once unified revisions exist'); } });
  await saved(b); assert.ok(find(b, 'covelet.legacy.v1'));
});

test('switching to a new empty target runs that target legacy seed even when the previous target had metadata', async () => {
  const oldCloud = remote(), newCloud = remote(); let seeds = 0;
  const a = device(oldCloud, 'a', { seed: async (actual) => ({ version: 1, records: [...actual.records, record(`covelet.seed-${++seeds}.v1`, { retained: true })] }) });
  await saved(a); assert.equal(seeds, 1); a.switchRemote(newCloud, 'b'.repeat(64)); await saved(a);
  assert.equal(seeds, 2); assert.ok(find(a, 'covelet.seed-2.v1')); assert.equal(a.store.value.metadata.target, 'b'.repeat(64));
  const b = device(newCloud, 'b'); b.switchRemote(newCloud, 'b'.repeat(64)); await saved(b); assert.ok(find(b, 'covelet.seed-2.v1'));
});

test('a seed rejected by CAS remains staged and can be imported after restart without being mistaken for a local deletion', async () => {
  const cloud = remote(); let seeds = 0;
  const a = device(cloud, 'a', { seed: async (actual) => { seeds++; return { version: 1, records: [...actual.records, record('covelet.legacy.v1', { preserved: true })] }; } });
  a.race = true; assert.equal((await a.api.syncFullDataNow()).code, 'REVISION_CONFLICT');
  assert.equal(find(a, 'covelet.legacy.v1'), undefined); a.api = a.make(); await saved(a);
  assert.equal(seeds, 1); assert.ok(find(a, 'covelet.legacy.v1')); assert.ok(find(a, 'covelet.racing.v1'));
  const b = device(cloud, 'b'); await saved(b); assert.ok(find(b, 'covelet.legacy.v1'));
});

test('a protected local privacy union is authored on the following sync and converges without an endless feedback loop', async () => {
  const key = 'covelet.content.preferences.v1', cloud = remote(), a = device(cloud, 'a', { records: [record(key, { privateKeys: [] })] });
  await saved(a);
  const b = device(cloud, 'b', { applyTransform: (records) => records.map((item) => item.key === key
    ? { ...item, value: { privateKeys: [...new Set([...item.value.privateKeys, 'site:protected'])].sort() } } : item) });
  assert.equal((await saved(b)).pending, 1, 'protected local state remains visibly pending until causally authored');
  assert.equal((await saved(b)).pending, 0); await saved(a);
  assert.deepEqual(find(a, key).value.privateKeys, ['site:protected']);
  const writes = cloud.calls.filter(([, method]) => method === 'write').length;
  assert.equal((await saved(b)).pending, 0); assert.equal(cloud.calls.filter(([, method]) => method === 'write').length, writes);
});

test('credentials, device-only verifiers and sync-control namespaces are rejected before any remote publication', async () => {
  for (const forbidden of [record('covelet.privacy.lock.v1', { verifier: 'never export' }), record('covelet.cloud.local.v1', {}),
    record('covelet.data-sync.v1', {}), record('covelet.tools.cloud.v1', {}), record('covelet.cloud.session.v1', {}), record('pending', {}, 'full-data-pending')]) {
    const cloud = remote(), a = device(cloud, 'a', { records: [forbidden] });
    assert.equal((await a.api.syncFullDataNow()).phase, 'error'); assert.equal(cloud.manifests.size, 0); assert.equal(cloud.chunks.size, 0);
  }
});

test('future cloud business keys and old demo records use the same inclusion policy as the encrypted snapshot adapter', async () => {
  const cloud = remote(), records = [record('covelet.cloud.future-extension.v1', { retained: true }), record('covelet.tools.demo.v1', { retained: true }), record('future-record', { retained: true }, 'data-sync-pending')];
  const a = device(cloud, 'a', { records }), b = device(cloud, 'b'); await saved(a); await saved(b);
  assert.deepEqual(b.records.map(id).sort(), records.map(id).sort());
});

test('target switching is blocked with local edits or recoverable conflicts, and lock errors remain explicit', async () => {
  const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.note.v1', { text: 'initial' })] }); await saved(a);
  await a.api.guardFullDataTarget('b'.repeat(64), async () => 'allowed');
  a.edit((records) => { records[0].value.text = 'unpublished'; });
  await assert.rejects(a.api.guardFullDataTarget('b'.repeat(64), async () => {}), { code: 'DATA_SYNC_TARGET' });
  a.allowed = false; assert.equal((await a.api.syncFullDataNow()).phase, 'locked');
});


test('whole-record choices never synthesize a field merge, and ordinary sync or edits cannot silently resolve a conflict', async () => {
  for (const choice of ['local', 'remote']) {
    const cloud = remote(), key = 'covelet.whole-record.v1';
    const a = device(cloud, 'a', { records: [record(key, { left: 'initial', right: 'initial' })] }), b = device(cloud, 'b');
    await saved(a); await saved(b); await saved(a);
    a.edit(records => { records[0].value.left = 'A'; }); b.edit(records => { records[0].value.right = 'B'; });
    await saved(a); await conflicted(b); await saved(a);
    assert.deepEqual(find(a, key).value, { left: 'A', right: 'initial' });
    assert.deepEqual(find(b, key).value, { left: 'initial', right: 'B' });
    b.edit(records => { records[0].value.right = 'B after conflict'; });
    await conflicted(b); await saved(a); await conflicted(b);
    assert.equal((await b.api.getFullDataConflicts()).length, 2, 'autosync and local edits do not acknowledge a whole-record choice');
    const remoteConflict = (await b.api.getFullDataConflicts()).find(item => !item.local);
    const preview = await b.api.previewFullDataConflict(remoteConflict.id);
    assert.deepEqual(preview.local.value, { left: 'initial', right: 'B after conflict' });
    assert.deepEqual(preview.remote.value, { left: 'A', right: 'initial' });
    await b.api.restoreFullDataConflict(preview.id, { choice, token: preview.token });
    const expected = choice === 'local' ? preview.local.value : preview.remote.value;
    assert.deepEqual(find(b, key).value, expected);
    await saved(b); await saved(a);
    assert.deepEqual(find(a, key).value, expected); assert.equal((await a.api.getFullDataConflicts()).length, 0);
  }
});

test('conflict preview rejects stale local snapshots, stale causal documents, missing choices, expiry and locked access', async () => {
  const cloud = remote(), key = 'covelet.stale.v1'; let time = 1000;
  const a = device(cloud, 'a', { records: [record(key, { body: 'initial' })] }), b = device(cloud, 'b', { now: () => time });
  await saved(a); await saved(b); await saved(a);
  a.edit(records => { records[0].value.body = 'A'; }); b.edit(records => { records[0].value.body = 'B'; });
  await saved(a); await conflicted(b);
  const conflict = (await b.api.getFullDataConflicts()).find(item => !item.local);
  let preview = await b.api.previewFullDataConflict(conflict.id);
  await assert.rejects(b.api.restoreFullDataConflict(preview.id, { token: preview.token }), error => error.code === 'DATA_SYNC_CONFLICT_STALE');
  b.edit(records => { records[0].value.body = 'B later'; });
  await assert.rejects(b.api.restoreFullDataConflict(preview.id, { choice: 'remote', token: preview.token }), error => error.code === 'DATA_SYNC_CONFLICT_STALE');
  assert.equal(find(b, key).value.body, 'B later');
  preview = await b.api.previewFullDataConflict(conflict.id); time += 600001;
  await assert.rejects(b.api.restoreFullDataConflict(preview.id, { choice: 'remote', token: preview.token }), error => error.code === 'DATA_SYNC_CONFLICT_STALE');
  preview = await b.api.previewFullDataConflict(conflict.id); b.allowed = false;
  await assert.rejects(b.api.restoreFullDataConflict(preview.id, { choice: 'remote', token: preview.token }), error => error.code === 'CLOUD_LOCKED');
  b.allowed = true;
  preview = await b.api.previewFullDataConflict(conflict.id);
  await conflicted(b);
  await assert.rejects(b.api.restoreFullDataConflict(preview.id, { choice: 'remote', token: preview.token }), error => error.code === 'DATA_SYNC_CONFLICT_STALE');
});

test('icon conflict previews are opt-in reads and compare validated regular and dark artwork', async (t) => {
  const png = await readFile(new URL('../../public/icons/icon-32.png', import.meta.url));
  const [key, darkKey, invalidKey] = ['icon', 'adaptive', 'invalid'].map(name => `https://assets.example/${name}.png`);
  const icon = new Blob([png], { type: 'image/png' });
  const dark = new Blob([png, Uint8Array.of(0)], { type: 'image/png' });
  const malformed = new Blob(['not a PNG'], { type: 'image/png' });
  const input = [key, darkKey, invalidKey].map(url => record(url, { url, blob: icon, width: 32, height: 32, updatedAt: 1, adaptive: false }, 'navigation-icons'));
  const cloud = remote(), requestedAccess = [], a = device(cloud, 'a', { records: input }), b = device(cloud, 'b', { onAccess: request => requestedAccess.push(request) });
  await saved(a); await saved(b); await saved(a);
  a.edit(records => {
    for (const item of records) item.value.updatedAt = 2;
    Object.assign(records.find(item => item.key === darkKey).value, { adaptive: true, darkBlob: dark });
    records.find(item => item.key === invalidKey).value.blob = malformed;
  });
  b.edit(records => {
    for (const item of records) item.value.updatedAt = 3;
    Object.assign(records.find(item => item.key === darkKey).value, { adaptive: true, darkBlob: icon });
  });
  await saved(a); await conflicted(b);
  const previousDecode = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  let decoded = 0, closed = 0, lockWhileDecoding = false;
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => {
    if (lockWhileDecoding) b.allowed = false;
    decoded++; return { width: 32, height: 32, close() { closed++; } };
  } });
  t.after(() => { if (previousDecode) Object.defineProperty(globalThis, 'createImageBitmap', previousDecode); else delete globalThis.createImageBitmap; });
  const before = cloud.calls.length;
  const conflicts = await b.api.getFullDataConflicts();
  assert.equal(cloud.calls.length, before, 'listing conflicts does not make network calls');
  assert.equal(decoded, 0);
  const preview = async key => b.api.previewFullDataConflict(conflicts.find(item => item.key === key && !item.local).id);
  const same = await preview(key);
  assert.equal(same.local.value.updatedAt, 3);
  assert.equal(same.remote.value.updatedAt, 2);
  assert.equal(same.mediaEqual, true);
  assert.equal(same.mediaMetadataEqual, false);
  assert.equal(same.local.media.width, 32);
  assert.deepEqual(Buffer.from(await same.remote.media.blob.arrayBuffer()), png);
  const different = await preview(darkKey);
  assert.equal(different.mediaEqual, false);
  assert.deepEqual(Buffer.from(await different.remote.media.darkBlob.arrayBuffer()), Buffer.concat([png, Buffer.of(0)]));
  const unavailable = await preview(invalidKey);
  assert.equal(unavailable.remote.media, undefined);
  assert.equal(unavailable.mediaEqual, undefined);
  assert.equal(unavailable.remote.value.updatedAt, 2);
  assert.equal(decoded, 7, 'invalid raster bytes never reach the decoder');
  assert.equal(closed, decoded);
  assert.ok(cloud.calls.slice(before).every(([area, method]) => area === 'chunks' && method === 'read'));
  assert.deepEqual(requestedAccess.slice(-3), [{ readOnly: true }, { readOnly: true }, { readOnly: true }]);
  b.edit(records => { records.find(item => item.key === key).value.updatedAt = 2; });
  const currentEqual = await preview(key);
  assert.equal(currentEqual.mediaEqual, true);
  assert.equal(currentEqual.mediaMetadataEqual, true);
  lockWhileDecoding = true;
  await assert.rejects(preview(key), { code: 'CLOUD_LOCKED' });
});

test('choosing one conflicted record leaves other conflicted records intact', async () => {
  const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.one.v1', 'initial'), record('covelet.two.v1', 'initial')] }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit(records => { for (const item of records) item.value = 'A'; }); b.edit(records => { for (const item of records) item.value = 'B'; });
  await saved(a); await conflicted(b);
  const one = (await b.api.getFullDataConflicts()).find(item => item.key === 'covelet.one.v1' && !item.local);
  await b.api.restoreFullDataConflict(one.id, { discard: false });
  await assert.rejects(b.api.restoreFullDataConflict(one.id, { discard: false }), { code: 'DATA_SYNC_CONFLICT_STALE' });
  assert.equal(find(b, 'covelet.one.v1').value, 'A'); assert.equal(find(b, 'covelet.two.v1').value, 'B');
  await conflicted(b); assert.equal((await b.api.getFullDataConflicts()).length, 2);
});


test('a CAS rejection during a direct choice cannot acknowledge the winning causal clock', async () => {
  const cloud = remote(), key = 'covelet.choice-race.v1';
  const a = device(cloud, 'a', { records: [record(key, 'initial')] }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit(records => { records[0].value = 'A'; }); b.edit(records => { records[0].value = 'B'; });
  await saved(a); await conflicted(b);
  const conflict = (await b.api.getFullDataConflicts()).find(item => !item.local), before = b.store.value;
  b.race = true;
  await assert.rejects(b.api.restoreFullDataConflict(conflict.id, { discard: false }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(b.store.value, before); assert.equal((await b.api.getFullDataConflicts()).length, 2);
  assert.equal(find(b, key).value, 'B'); assert.ok(find(b, 'covelet.racing.v1'));
});


test('a later local edit to an unresolved branch survives a remote choice that never observed it', async () => {
  const cloud = remote(), key = 'covelet.branch.v1', a = device(cloud, 'a', { records: [record(key, 'initial')] }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit(records => { records[0].value = 'A'; }); b.edit(records => { records[0].value = 'B'; });
  await saved(a); await conflicted(b);
  a.edit(records => { records[0].value = 'A edited after conflict'; });
  assert.equal((await b.api.resolveFullDataConflicts('local')).phase, 'saved');
  await conflicted(a);
  assert.equal(find(a, key).value, 'A edited after conflict'); assert.equal((await a.api.getFullDataConflicts()).length, 2);
  const later = await a.api.previewFullDataConflict((await a.api.getFullDataConflicts()).find(item => !item.local).id);
  assert.equal(later.remote.value, 'B');
});

test('a JSON-reserialized device accepts the same immutable remote clock and reuses pending ciphertext', async () => {
  const cloud = remote(), disk = memory();
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  let reserialized = false;
  const store = { read: async () => reserialized ? reorder(await disk.read()) : disk.read(), write: value => disk.write(value) };
  const a = device(cloud, 'a', { store, records: [record('covelet.reloaded.v1', { body: 'retained' })] });
  await saved(a); reserialized = true;
  const writes = cloud.calls.filter(([, method]) => method === 'write').length;
  await saved(a);
  assert.equal(cloud.calls.filter(([, method]) => method === 'write').length, writes);
  a.edit(records => { records[0].value.body = 'pending'; }); cloud.failWrites = true;
  assert.equal((await a.api.syncFullDataNow()).phase, 'error');
  const pending = disk.value.metadata.pending; assert.ok(pending);
  cloud.failWrites = false;
  await saved(a);
  assert.equal(new TextDecoder().decode(cloud.manifests.get(pending.name)), pending.body);
  const b = device(cloud, 'b'); await saved(b);
  assert.equal(find(b, 'covelet.reloaded.v1').value.body, 'pending');
});

// A pre-0.2.2 all-data payload, including the accidentally portable language.
async function legacyLanguageIndex(cloud) {
  const encoder = new TextEncoder(), staged = new Map(), actor = 'a'.repeat(32);
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  const tree = value => value === null ? [0] : typeof value === 'string' ? [3, value] : typeof value === 'number' ? [2, value]
    : Array.isArray(value) ? [4, value.map(tree)] : [5, Object.entries(value).map(([key, item]) => [key, tree(item)])];
  const frame = value => {
    const manifest = encoder.encode(JSON.stringify([1, tree(value), []])), bytes = new Uint8Array(8 + manifest.length);
    bytes.set([67, 70, 83, 49]); new DataView(bytes.buffer).setUint32(4, manifest.length); bytes.set(manifest, 8); return bytes;
  };
  const stage = async bytes => {
    const encrypted = await encryptCloudPayload(bytes, password), digest = await hash(encrypted), plainHash = await hash(bytes);
    const chunk = { hash: plainHash, size: bytes.length, name: `covelet-${digest.slice(0, 32)}-1-${digest}.json` };
    cloud.chunks.set(chunk.name, encrypted); staged.set(chunk.name, { body: new TextDecoder().decode(encrypted) });
    return { digest: plainHash, size: bytes.length, chunks: [chunk] };
  };
  const languageKey = id(record('covelet.language.v1', 'zh-CN')), businessKey = id(record('covelet.legacy-business.v1', 'portable'));
  const language = await stage(frame('zh-CN')), business = await stage(frame('portable'));
  const document = { version: 1, actor, clock: 1, records: {
    [languageKey]: { n: 1, context: { [actor]: 0 }, value: language },
    [businessKey]: { n: 1, context: { [actor]: 0 }, value: business },
  } };
  const reference = await stage(encoder.encode(JSON.stringify(document)));
  const encrypted = await encryptCloudPayload(encoder.encode(JSON.stringify({ format: 'covelet-all-data', version: 1, actor, clock: 1, createdAt: 1, document: reference })), password);
  const pending = { name: `covelet-${actor}-1-${await hash(encrypted)}.json`, body: new TextDecoder().decode(encrypted), uploads: [...language.chunks, ...business.chunks, ...reference.chunks] };
  cloud.manifests.set(pending.name, encrypted);
  return { document, pending, staged, base: { [languageKey]: language.digest, [businessKey]: business.digest } };
}

test('pre-0.2.2 language history and persisted pending indexes remain readable without importing device preferences', async () => {
  for (const pendingRetry of [false, true]) {
    const cloud = remote(), legacy = await legacyLanguageIndex(cloud);
    if (pendingRetry) {
      cloud.manifests.clear(); cloud.chunks.clear();
      const disk = memory({ version: 1, metadata: { target, document: legacy.document, documents: { [legacy.document.actor]: legacy.document },
        base: legacy.base, pending: legacy.pending, publishedClock: 0, lastSync: 0 } });
      const pendingStore = pendingMemory(); for (const [name, body] of legacy.staged) await pendingStore.set(name, body);
      const a = device(cloud, 'a', { store: disk, pendingStore, records: [record('covelet.legacy-business.v1', 'portable')] });
      await saved(a);
      assert.equal(new TextDecoder().decode(cloud.manifests.get(legacy.pending.name)), legacy.pending.body, 'old pending index keeps its exact ciphertext');
    }
    const b = device(cloud, 'b'); await saved(b);
    assert.equal(find(b, 'covelet.legacy-business.v1').value, 'portable');
    assert.equal(find(b, 'covelet.language.v1'), undefined);
    assert.deepEqual(await b.api.getFullDataConflicts(), []);
  }
});

test('conflict preview survives JSON field reordering, but a changed same-clock document still fails', async () => {
  const cloud = remote(), disk = memory(); let reordered = false;
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  const store = { read: async () => reordered ? reorder(await disk.read()) : disk.read(), write: value => disk.write(value) };
  const key = 'covelet.order-conflict.v1', a = device(cloud, 'a', { records: [record(key, 'initial')] }), b = device(cloud, 'b', { store });
  await saved(a); await saved(b); await saved(a);
  a.edit(records => { records[0].value = 'A'; }); b.edit(records => { records[0].value = 'B'; }); await saved(a); await conflicted(b);
  const conflict = (await b.api.getFullDataConflicts()).find(item => !item.local), preview = await b.api.previewFullDataConflict(conflict.id);
  reordered = true;
  await b.api.restoreFullDataConflict(conflict.id, { choice: 'remote', token: preview.token });
  await saved(b); await saved(a); assert.equal(find(b, key).value, 'A');
  const metadata = disk.value; metadata.metadata.document.records[id(record(key))].value.digest = 'f'.repeat(64); await disk.write(metadata);
  assert.equal((await b.api.syncFullDataNow()).code, 'DATA_SYNC_INVALID');
  assert.equal(find(b, key).value, 'A');
});
