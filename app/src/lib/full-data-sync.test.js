import test from 'node:test';
import assert from 'node:assert/strict';
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
  const store = options.store || memory(), pendingStore = options.pendingStore || pendingMemory(), listeners = new Set();
  const snapshotStore = {
    async snapshot() { return { version: 1, records: clone(records), token: String(revision) }; },
    async apply(next, { expectedToken }) {
      if (race) { race = false; records.push(record('covelet.racing.v1', { retained: true })); revision++; }
      if (expectedToken !== String(revision)) throw Object.assign(Error('synthetic CAS conflict'), { code: 'REVISION_CONFLICT' });
      records = clone(next.records); if (options.applyTransform) records = options.applyTransform(records);
      revision++; applied++; for (const listener of listeners) listener({ source: 'sync' });
      return snapshotStore.snapshot();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const access = async () => ({ target: activeTarget, password: activePassword, autoSync: false, provider: activeRemote.provider, assetProvider: activeRemote.assetProvider,
    async check() { if (!allowed) throw Object.assign(Error('locked'), { code: 'CLOUD_LOCKED' }); } });
  const make = () => createFullDataSync({ store, pendingStore, snapshotStore, access, uuid: () => actor.repeat(32), locks: null,
    eventWindow: null, eventDocument: null, ...options });
  return { api: make(), make, store, pendingStore, snapshotStore, get records() { return clone(records); }, get applied() { return applied; },
    edit(update) { const next = clone(records); update(next); records = next; revision++; for (const listener of listeners) listener({ source: 'local' }); },
    set race(value) { race = value; }, set password(value) { activePassword = value; }, set allowed(value) { allowed = value; },
    switchRemote(next, targetValue) { activeRemote = next; activeTarget = targetValue; } };
}
const saved = async (subject) => { const result = await subject.api.syncFullDataNow(); assert.equal(result.phase, 'saved', `${result.code}: ${result.message}`); return result; };
const find = (subject, key) => subject.records.find((record) => record.key === key);

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

test('offline edits of different records merge; concurrent delete/edit retains each local record until an explicit choice', async () => {
  const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.note-1.v1', { body: 'initial' })] }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit((records) => records.splice(0, 1)); b.edit((records) => { records[0].value.body = 'offline renamed'; records.push(record('covelet.extra.v1', { retained: true })); });
  await saved(a); await saved(b); await saved(a);
  assert.equal(find(a, 'covelet.note-1.v1'), undefined); assert.ok(find(a, 'covelet.extra.v1'));
  assert.equal(find(b, 'covelet.note-1.v1').value.body, 'offline renamed');
  const conflicts = await b.api.getFullDataConflicts();
  assert.equal(conflicts.length, 2); assert.ok(conflicts.some((item) => item.deleted));
  assert.ok(conflicts.every((item) => !own(item, 'value')), 'status does not expose private conflict content');
  await b.api.restoreFullDataConflict(conflicts.find((item) => !item.deleted).id); await saved(b); await saved(a);
  assert.equal(find(a, 'covelet.note-1.v1').value.body, 'offline renamed'); assert.equal((await a.api.getFullDataConflicts()).length, 0);
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

test('discarding a conflict keeps the currently materialized record and resolves all concurrent versions', async () => {
  const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.note.v1', { body: 'initial' })] }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit((records) => { records[0].value.body = 'A'; }); b.edit((records) => { records[0].value.body = 'B'; });
  await saved(a); await saved(b); await saved(a);
  const current = find(b, 'covelet.note.v1').value.body, conflicts = await b.api.getFullDataConflicts(); assert.equal(conflicts.length, 2);
  await b.api.restoreFullDataConflict(conflicts[1].id, { discard: true }); await saved(b); await saved(a);
  assert.equal(find(a, 'covelet.note.v1').value.body, current); assert.equal((await a.api.getFullDataConflicts()).length, 0);
});

test('unknown index and chunk write results retry the exact persisted ciphertext after restarting the engine', async () => {
  for (const area of ['index', 'chunk']) {
    const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.record.v1', { body: `retry-${area}` })] });
    if (area === 'index') cloud.unknownIndex = true; else cloud.unknownChunk = true;
    const failure = await a.api.syncFullDataNow(); assert.equal(failure.phase, 'error'); assert.ok(a.store.value.metadata.pending);
    const pending = a.store.value.metadata.pending, staged = clone([...a.pendingStore.values]); a.api = a.make();
    a.edit((records) => records.push(record('covelet.new-edit.v1', { retained: true })));
    await saved(a);
    assert.deepEqual(cloud.manifests.get(pending.name), new TextEncoder().encode(pending.body));
    for (const [name, body] of staged) assert.deepEqual(cloud.chunks.get(name), new TextEncoder().encode(body.body));
    assert.equal(a.store.value.metadata.pending, null); assert.ok(find(a, 'covelet.new-edit.v1'));
  }
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
    await saved(a); await saved(b); await saved(a);
    assert.deepEqual(find(a, key).value, { left: 'A', right: 'initial' });
    assert.deepEqual(find(b, key).value, { left: 'initial', right: 'B' });
    b.edit(records => { records[0].value.right = 'B after conflict'; });
    await saved(b); await saved(a); await saved(b);
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
  await saved(a); await saved(b);
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
  await saved(b);
  await assert.rejects(b.api.restoreFullDataConflict(preview.id, { choice: 'remote', token: preview.token }), error => error.code === 'DATA_SYNC_CONFLICT_STALE');
});

test('choosing one conflicted record leaves other conflicted records intact', async () => {
  const cloud = remote(), a = device(cloud, 'a', { records: [record('covelet.one.v1', 'initial'), record('covelet.two.v1', 'initial')] }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit(records => { for (const item of records) item.value = 'A'; }); b.edit(records => { for (const item of records) item.value = 'B'; });
  await saved(a); await saved(b);
  const one = (await b.api.getFullDataConflicts()).find(item => item.key === 'covelet.one.v1' && !item.local);
  const preview = await b.api.previewFullDataConflict(one.id);
  await b.api.restoreFullDataConflict(one.id, { choice: 'remote', token: preview.token });
  assert.equal(find(b, 'covelet.one.v1').value, 'A'); assert.equal(find(b, 'covelet.two.v1').value, 'B');
  await saved(b); assert.equal((await b.api.getFullDataConflicts()).length, 2);
});


test('a CAS rejection during an explicit choice cannot acknowledge the winning causal clock', async () => {
  const cloud = remote(), key = 'covelet.choice-race.v1';
  const a = device(cloud, 'a', { records: [record(key, 'initial')] }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit(records => { records[0].value = 'A'; }); b.edit(records => { records[0].value = 'B'; });
  await saved(a); await saved(b);
  const conflict = (await b.api.getFullDataConflicts()).find(item => !item.local), preview = await b.api.previewFullDataConflict(conflict.id), before = b.store.value;
  b.race = true;
  await assert.rejects(b.api.restoreFullDataConflict(conflict.id, { choice: 'remote', token: preview.token }), error => error.code === 'REVISION_CONFLICT');
  assert.deepEqual(b.store.value, before); assert.equal((await b.api.getFullDataConflicts()).length, 2);
  assert.equal(find(b, key).value, 'B'); assert.ok(find(b, 'covelet.racing.v1'));
});


test('a later local edit to an unresolved branch survives a remote choice that never observed it', async () => {
  const cloud = remote(), key = 'covelet.branch.v1', a = device(cloud, 'a', { records: [record(key, 'initial')] }), b = device(cloud, 'b');
  await saved(a); await saved(b); await saved(a);
  a.edit(records => { records[0].value = 'A'; }); b.edit(records => { records[0].value = 'B'; });
  await saved(a); await saved(b); await saved(a);
  b.edit(records => { records[0].value = 'B edited after conflict'; });
  const conflict = (await a.api.getFullDataConflicts()).find(item => !item.local), preview = await a.api.previewFullDataConflict(conflict.id);
  await a.api.restoreFullDataConflict(conflict.id, { choice: 'local', token: preview.token });
  await saved(a); await saved(b);
  assert.equal(find(b, key).value, 'B edited after conflict'); assert.equal((await b.api.getFullDataConflicts()).length, 2);
  await saved(a); assert.equal(find(a, key).value, 'A');
  const later = await a.api.previewFullDataConflict((await a.api.getFullDataConflicts()).find(item => !item.local).id);
  assert.equal(later.remote.value, 'B edited after conflict');
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
  a.edit(records => { records[0].value = 'A'; }); b.edit(records => { records[0].value = 'B'; }); await saved(a); await saved(b);
  const conflict = (await b.api.getFullDataConflicts()).find(item => !item.local), preview = await b.api.previewFullDataConflict(conflict.id);
  reordered = true;
  await b.api.restoreFullDataConflict(conflict.id, { choice: 'remote', token: preview.token });
  await saved(b); await saved(a); assert.equal(find(b, key).value, 'A');
  const metadata = disk.value; metadata.metadata.document.records[id(record(key))].value.digest = 'f'.repeat(64); await disk.write(metadata);
  assert.equal((await b.api.syncFullDataNow()).code, 'DATA_SYNC_INVALID');
  assert.equal(find(b, key).value, 'A');
});
