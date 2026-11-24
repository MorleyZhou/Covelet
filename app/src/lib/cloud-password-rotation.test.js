import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { createCloudSync } from './cloud-sync.js';
import { createLocalData } from './local-data.js';
import { createEmptyState } from './model.js';
import { createSyncWasm } from './sync-wasm.js';
import { decryptCloudPayload } from './cloud-crypto.js';
import { parseCloudSnapshotName } from './cloud-providers.js';

const signer = await createSyncWasm(await readFile(new URL('../wasm/sync-core.wasm', import.meta.url)));
const copy = (value) => structuredClone(value), decoder = new TextDecoder();
const profile = { provider: 'r2', endpoint: 'https://rotation.r2.example.test', bucket: 'rotation-tests', prefix: 'password-tests' };
const secrets = { accessKeyId: 'SYNTHETIC-ACCESS', secretAccessKey: 'SYNTHETIC-SECRET' };
const oldPassword = 'original synthetic sync passphrase', newPassword = 'replacement synthetic sync passphrase';
const NAV = 'owntab.local.v1', TOOLS = 'covelet.tools.v1';
const note = (id, body = id) => ({ id, title: id, body, revision: 1, createdAt: 1, updatedAt: 2, pinned: false });
const emptyTools = () => ({ version: 3, revision: 0, notes: [], reading: [], snapshots: [], trash: [] });
const site = (id) => ({ id, type: 'site', name: id, url: `https://${id}.example/`, groupId: 'group-home', parentId: null,
  icon: { kind: 'letter', value: id.slice(0, 2) }, order: 0 });

function memory(initial = null) {
  let value = copy(initial);
  return { async read() { return copy(value); }, async write(next) { value = copy(next); }, async clear() { value = null; }, get value() { return copy(value); } };
}
function backend() {
  const records = new Map(); let key;
  return {
    records, getKey: async () => key, ensureKey: async (candidate) => key ||= candidate,
    get: async (id) => copy(records.get(id)),
    entries: async (space) => [...records.values()].filter((record) => space === undefined || record.space === space).map(copy),
    put: async (values) => { for (const record of values) records.set(record.id, copy(record)); },
    remove: async (ids) => { for (const id of ids) records.delete(id); },
    commit: async (values, ids) => {
      const next = new Map(records);
      for (const id of ids) next.delete(id);
      for (const record of values) next.set(record.id, copy(record));
      records.clear(); for (const [id, record] of next) records.set(id, record);
    },
  };
}
function remote() {
  const areas = new Map(), controls = new Map(), calls = [];
  let failWrites = false, loseControlReply = false;
  const area = (prefix) => { if (!areas.has(prefix)) areas.set(prefix, new Map()); return areas.get(prefix); };
  const cloud = { areas, controls, calls, area,
    get writes() { return calls.filter((call) => ['write', 'createPasswordEpoch', 'ensurePasswordEpochDirectory'].includes(call[1])); },
    set failWrites(value) { failWrites = value; }, set loseControlReply(value) { loseControlReply = value; },
    factory(config, suppliedSecrets, { beforeRequest } = {}) {
      assert.equal(suppliedSecrets?.accessKeyId, secrets.accessKeyId);
      assert.equal(suppliedSecrets?.secretAccessKey, secrets.secretAccessKey);
      if (suppliedSecrets.sessionToken !== undefined) assert.equal(suppliedSecrets.sessionToken, '');
      const values = area(config.prefix), controlPath = `${config.prefix.replace(/\/all-data-v[12]$/, '')}/password-epoch-v1.json`;
      const before = async (method, name) => { await beforeRequest?.(); calls.push([config.prefix, method, name]); };
      return {
        async list() { await before('list'); return [...values].map(([name, bytes]) => ({ name, size: bytes.length })); },
        async read(name) { await before('read', name); return values.get(name)?.slice(); },
        async write(name, input) {
          await before('write', name);
          if (failWrites) throw Error('Synthetic upload interrupted');
          const bytes = new Uint8Array(input);
          if (values.has(name)) assert.deepEqual(values.get(name), bytes, 'Immutable retries must preserve ciphertext.');
          values.set(name, bytes.slice());
          await cloud.onWrite?.(config.prefix, name, values);
        },
        async readPasswordEpoch() { await before('readPasswordEpoch'); return controls.get(controlPath)?.slice() || null; },
        async createPasswordEpoch(input) {
          await before('createPasswordEpoch');
          if (failWrites) throw Error('Synthetic control creation interrupted');
          const bytes = new Uint8Array(input);
          if (controls.has(controlPath)) assert.deepEqual(controls.get(controlPath), bytes, 'The epoch control is create-once.');
          controls.set(controlPath, bytes.slice());
          if (loseControlReply) { loseControlReply = false; throw Error('Synthetic response lost after control commit'); }
        },
        async ensurePasswordEpochDirectory(id) {
          await before('ensurePasswordEpochDirectory', id);
          assert.match(id, /^[a-f0-9]{32}$/);
        },
      };
    },
  };
  return cloud;
}
async function device(t, cloud, actor) {
  let sequence = 0;
  const disk = backend(), persistence = createLocalData({ backend: disk, crypto: webcrypto, databaseName: `password-rotation-${webcrypto.randomUUID()}`,
    legacyLocal: null, localStorage: null, broadcastChannel: null, locks: null });
  t.after(() => persistence.close());
  const { localData } = persistence, sessionStore = memory();
  const recordStore = (key) => ({ async read() { return (await localData.get(key))[key] ?? null; }, async write(value) { await localData.set({ [key]: value }); } });
  const stateStore = {
    async loadState() { return (await localData.get(NAV))[NAV]?.state || createEmptyState(); },
    async saveState(next, expectedRevision) {
      const envelope = (await localData.get(NAV))[NAV], previous = envelope?.state || createEmptyState();
      if (previous.revision !== expectedRevision) throw Object.assign(Error('revision conflict'), { code: 'REVISION_CONFLICT' });
      const state = { ...copy(next), revision: expectedRevision + 1 };
      await localData.set({ [NAV]: { version: 1, state, snapshots: [previous, ...(envelope?.snapshots || [])].slice(0, 3) } }); return state;
    },
    subscribeState(listener) { return localData.subscribe((changes) => { if (changes[NAV]) listener(changes[NAV].newValue?.state || createEmptyState()); }); },
  };
  const toolsStore = {
    async loadPersonalTools() { return (await localData.get(TOOLS))[TOOLS] || emptyTools(); },
    async applySyncedPersonalTools(value, { expectedRevision }) {
      const previous = await toolsStore.loadPersonalTools();
      if (previous.revision !== expectedRevision) throw Object.assign(Error('revision conflict'), { code: 'REVISION_CONFLICT' });
      const next = { ...previous, ...copy(value), revision: previous.revision + 1 }; await localData.set({ [TOOLS]: next }); return next;
    },
    subscribePersonalTools(listener) { return localData.subscribe((changes) => { if (changes[TOOLS]) listener(changes[TOOLS].newValue || emptyTools()); }); },
  };
  const configStore = recordStore('covelet.cloud.local.v1'), toolSyncStore = recordStore('covelet.tools.cloud.v1');
  const make = () => createCloudSync({ stateStore, configStore, sessionStore, toolSyncStore, toolsStore,
    snapshotStore: persistence.syncDataStore, fullHistoryStore: recordStore('covelet.data-sync.runs.v1'),
    fullPendingStore: persistence.createEncryptedStore('full-data-pending'),
    providerFactory: cloud.factory, signer, crypto: webcrypto, hasPermission: async () => true,
    uuid: () => actor.repeat(16) + (++sequence).toString(16).padStart(16, '0'), locks: null,
    eventWindow: null, eventDocument: null });
  return { api: make(), make, ...persistence, disk, configStore, sessionStore, stateStore,
    value: async (key) => (await localData.get(key))[key],
    async editNote(body) { const tools = (await localData.get(TOOLS))[TOOLS]; tools.notes[0].body = body; await localData.set({ [TOOLS]: tools }); },
  };
}
async function saved(peer) {
  const result = await peer.api.syncCloudNow();
  assert.equal(result.phase, 'saved', `${result.code}: ${result.message}`);
}
async function ready(t, second = false, configuredSecrets = secrets) {
  const cloud = remote(), a = await device(t, cloud, 'a');
  const state = createEmptyState(); state.entries = [site('shared-site')];
  await a.localData.set({ [NAV]: { version: 1, state, snapshots: [] }, [TOOLS]: { ...emptyTools(), notes: [note('shared-note', 'Original body')] },
    'covelet.language.v1': 'ja', 'covelet.search.engine.v1': 'google', 'covelet.privacy.lock.v1': { verifier: 'synthetic-local-privacy-verifier' } });
  await a.api.saveCloudSyncSettings(profile, configuredSecrets, oldPassword); await saved(a);
  if (!second) return { cloud, a };
  const b = await device(t, cloud, 'b'); await b.api.saveCloudSyncSettings(profile, secrets, oldPassword);
  await saved(b); await saved(a); return { cloud, a, b };
}
async function checkpoint(peer) {
  return { snapshot: await peer.syncDataStore.snapshot(), config: await peer.configStore.read(),
    syncMetadata: await peer.syncDataStore.syncMetadataStore.read(), session: peer.sessionStore.value,
    recovery: await peer.syncDataStore.readMergeRecovery() };
}
async function unchanged(peer, before) {
  assert.deepEqual(await checkpoint(peer), before);
}

test('an incorrect current password stops rotation without changing local state or writing remote data', async (t) => {
  const { cloud, a } = await ready(t), before = await checkpoint(a), writes = cloud.writes.length;
  await assert.rejects(a.api.changeCloudSyncPassword('incorrect synthetic current password', newPassword));
  await unchanged(a, before); assert.equal(cloud.writes.length, writes);
});

test('corrupt current or retained historical cloud indexes abort the complete rotation preflight before remote writes', async (t) => {
  for (const history of [false, true]) await t.test(history ? 'retained history' : 'current index', async (subtest) => {
    const { cloud, a } = await ready(subtest);
    if (history) { await a.editNote('A later synchronized body'); await saved(a); }
    const indexes = cloud.area(`${profile.prefix}/all-data-v1`), names = [...indexes.keys()];
    const name = history ? names[0] : names.at(-1), bytes = indexes.get(name).slice();
    bytes[bytes.length - 10] ^= 1; indexes.set(name, bytes);
    const before = await checkpoint(a), writes = cloud.writes.length;
    await assert.rejects(a.api.changeCloudSyncPassword(oldPassword, newPassword));
    await unchanged(a, before); assert.equal(cloud.writes.length, writes);
  });
});

test('successful rotation reencrypts the active generation and local credential envelope, then requires explicit new-password unlock', async (t) => {
  const { cloud, a } = await ready(t), before = await a.syncDataStore.snapshot();
  const envelope = (await a.configStore.read()).credentialEnvelope;
  await a.api.changeCloudSyncPassword(oldPassword, newPassword);
  assert.equal(a.sessionStore.value, null);
  assert.equal((await a.api.loadCloudSyncSettings()).unlocked, false);
  assert.deepEqual((await a.syncDataStore.snapshot()).records, before.records);
  const nextEnvelope = (await a.configStore.read()).credentialEnvelope;
  assert.notEqual(nextEnvelope, envelope);
  await decryptCloudPayload(new TextEncoder().encode(nextEnvelope), newPassword);
  await assert.rejects(decryptCloudPayload(new TextEncoder().encode(nextEnvelope), oldPassword));
  const control = JSON.parse(decoder.decode(cloud.controls.get(`${profile.prefix}/password-epoch-v1.json`)));
  assert.equal(control.format, 'covelet-password-epoch'); assert.equal(control.version, 1);
  assert.equal(control.previous, null); assert.match(control.next, /^[a-f0-9]{32}$/);
  const active = [...cloud.areas].filter(([prefix]) => prefix.includes(control.next) && /\/all-data-v1(?:\/blobs)?$/.test(prefix));
  assert.equal(active.length, 2); assert.ok(active.every(([, values]) => values.size > 0));
  for (const [, values] of active) for (const bytes of values.values()) {
    await decryptCloudPayload(bytes, newPassword);
    await assert.rejects(decryptCloudPayload(bytes, oldPassword));
  }
  await assert.rejects(a.api.unlockCloudSync(undefined, oldPassword)); assert.equal(a.sessionStore.value, null);
  assert.equal((await a.api.unlockCloudSync(undefined, newPassword)).unlocked, true);
  await saved(a);
  assert.deepEqual((await a.syncDataStore.snapshot()).records, before.records);
  assert.equal(await a.value('covelet.language.v1'), 'ja'); assert.equal(await a.value('covelet.search.engine.v1'), 'google');
  assert.deepEqual(await a.value('covelet.privacy.lock.v1'), { verifier: 'synthetic-local-privacy-verifier' });
  assert.ok(!JSON.stringify(await a.configStore.read()).includes(secrets.secretAccessKey));
});

test('local edits, an interrupted pending upload, and unresolved conflicts each block rotation without writing another generation', async (t) => {
  for (const condition of ['local edit', 'pending upload', 'conflict']) await t.test(condition, async (subtest) => {
    const { cloud, a, b } = await ready(subtest, condition === 'conflict');
    let subject = a;
    await a.editNote('Unsynchronized local body');
    if (condition === 'pending upload') {
      cloud.failWrites = true;
      assert.equal((await a.api.syncCloudNow()).phase, 'error'); cloud.failWrites = false;
      assert.ok((await a.syncDataStore.syncMetadataStore.read()).metadata.pending);
    } else if (condition === 'conflict') {
      await b.editNote('Concurrent other-device body'); await saved(a);
      assert.equal((await b.api.syncCloudNow()).phase, 'conflict'); subject = b;
    }
    const before = await checkpoint(subject), writes = cloud.writes.length;
    await assert.rejects(subject.api.changeCloudSyncPassword(oldPassword, newPassword));
    await unchanged(subject, before); assert.equal(cloud.writes.length, writes);
  });
});

test('a lost control-create reply is recoverable with the new password and never leaves an unlocked old-password session', async (t) => {
  const { cloud, a } = await ready(t), before = await a.syncDataStore.snapshot();
  cloud.loseControlReply = true;
  try { await a.api.changeCloudSyncPassword(oldPassword, newPassword); } catch { /* A committed cutover may require explicit recovery. */ }
  assert.equal(cloud.controls.size, 1, 'The remote create committed despite its lost response.');
  assert.equal(a.sessionStore.value, null);
  a.api = a.make();
  await assert.rejects(a.api.unlockCloudSync(undefined, oldPassword));
  assert.equal((await a.api.unlockCloudSync(undefined, newPassword)).unlocked, true);
  await saved(a);
  assert.deepEqual((await a.syncDataStore.snapshot()).records, before.records);
  assert.equal(cloud.controls.size, 1, 'Recovery reuses the existing cutover.');
});

test('another device cannot unlock a stale credential envelope with the old password and can rebind with new password plus provider credentials', async (t) => {
  const { cloud, a, b } = await ready(t, true), before = await b.syncDataStore.snapshot();
  await a.api.changeCloudSyncPassword(oldPassword, newPassword);
  await b.api.lockCloudSync();
  const writes = cloud.writes.length;
  await assert.rejects(b.api.unlockCloudSync(undefined, oldPassword), { code: 'CLOUD_PASSWORD_CHANGED' });
  assert.equal(b.sessionStore.value, null); assert.equal(cloud.writes.length, writes);
  await assert.rejects(b.api.unlockCloudSync(undefined, newPassword));
  assert.equal((await b.api.unlockCloudSync(secrets, newPassword)).unlocked, true);
  await saved(b);
  assert.deepEqual((await b.syncDataStore.snapshot()).records, before.records);
  await decryptCloudPayload(new TextEncoder().encode((await b.configStore.read()).credentialEnvelope), newPassword);
});

test('a local checkpoint failure after remote cutover keeps its journal and recovers only after explicit new-password unlock', async (t) => {
  const { cloud, a } = await ready(t), before = await checkpoint(a), commit = a.disk.commit;
  let failed = false;
  a.disk.commit = async (values, ids) => {
    if (cloud.controls.size && !failed) { failed = true; throw Error('Synthetic post-cutover local checkpoint failure'); }
    return commit(values, ids);
  };
  await assert.rejects(a.api.changeCloudSyncPassword(oldPassword, newPassword));
  assert.equal(failed, true); assert.equal(cloud.controls.size, 1); assert.equal(a.sessionStore.value, null);
  assert.deepEqual(await a.syncDataStore.snapshot(), before.snapshot);
  assert.deepEqual(await a.configStore.read(), before.config);
  assert.deepEqual(await a.syncDataStore.syncMetadataStore.read(), before.syncMetadata);
  assert.ok(await a.syncDataStore.readPasswordRotation());
  a.disk.commit = commit; a.api = a.make();
  await assert.rejects(a.api.unlockCloudSync(undefined, oldPassword));
  assert.equal((await a.api.unlockCloudSync(undefined, newPassword)).unlocked, true);
  assert.equal(await a.syncDataStore.readPasswordRotation(), null);
  await saved(a); assert.deepEqual((await a.syncDataStore.snapshot()).records, before.snapshot.records);
});

test('candidate corruption is detected from remote readback and never publishes the password control', async (t) => {
  const { cloud, a } = await ready(t), before = await checkpoint(a);
  let corrupted = false;
  cloud.onWrite = async (prefix, name, values) => {
    if (!corrupted && prefix.includes('/key-') && prefix.endsWith('/blobs')) {
      corrupted = true; const bytes = values.get(name).slice(); bytes[bytes.length - 10] ^= 1; values.set(name, bytes);
    }
  };
  await assert.rejects(a.api.changeCloudSyncPassword(oldPassword, newPassword));
  assert.equal(corrupted, true, 'The failure comes from a real candidate readback, after upload.');
  assert.equal(cloud.controls.size, 0);
  assert.deepEqual(await a.syncDataStore.snapshot(), before.snapshot); assert.deepEqual(await a.configStore.read(), before.config);
  assert.deepEqual(await a.syncDataStore.syncMetadataStore.read(), before.syncMetadata);
});

test('a local edit during candidate upload stops cutover and preserves the newer local body', async (t) => {
  const { cloud, a } = await ready(t), before = await checkpoint(a);
  let edited = false;
  cloud.onWrite = async (prefix) => {
    if (!edited && prefix.includes('/key-')) { edited = true; await a.editNote('Later local body during reencrypt'); }
  };
  await assert.rejects(a.api.changeCloudSyncPassword(oldPassword, newPassword));
  assert.equal(edited, true); assert.equal(cloud.controls.size, 0);
  assert.equal((await a.value(TOOLS)).notes[0].body, 'Later local body during reencrypt');
  assert.deepEqual(await a.configStore.read(), before.config); assert.deepEqual(await a.syncDataStore.syncMetadataStore.read(), before.syncMetadata);
  assert.equal(a.sessionStore.value, null);
});

test('another device publishing during candidate upload prevents a stale cloud cutover', async (t) => {
  const { cloud, a, b } = await ready(t, true), before = await checkpoint(a);
  let edited = false;
  cloud.onWrite = async (prefix) => {
    if (!edited && prefix.includes('/key-')) {
      edited = true; await b.editNote('Later remote body during reencrypt'); await saved(b);
    }
  };
  await assert.rejects(a.api.changeCloudSyncPassword(oldPassword, newPassword));
  assert.equal(edited, true); assert.equal(cloud.controls.size, 0);
  assert.equal((await b.value(TOOLS)).notes[0].body, 'Later remote body during reencrypt');
  assert.deepEqual(await a.syncDataStore.snapshot(), before.snapshot); assert.deepEqual(await a.configStore.read(), before.config);
  assert.deepEqual(await a.syncDataStore.syncMetadataStore.read(), before.syncMetadata);
});

test('the retired root receives a valid snapshot-name guard that the old password cannot decrypt', async (t) => {
  const { cloud, a } = await ready(t), indexes = cloud.area(`${profile.prefix}/all-data-v1`), oldNames = new Set(indexes.keys());
  await a.api.changeCloudSyncPassword(oldPassword, newPassword);
  const additions = [...indexes].filter(([name]) => !oldNames.has(name));
  assert.equal(additions.length, 1);
  const [name, bytes] = additions[0]; assert.ok(parseCloudSnapshotName(name));
  await assert.rejects(decryptCloudPayload(bytes, oldPassword));
  const payload = JSON.parse(decoder.decode(await decryptCloudPayload(bytes, newPassword)));
  assert.equal(payload.format, 'covelet-password-retired'); assert.equal(payload.version, 1);
  assert.equal(parseCloudSnapshotName(name).actor, payload.epoch);
});

test('a second password change follows the immutable epoch chain and accepts only the final password', async (t) => {
  const { cloud, a } = await ready(t), before = await a.syncDataStore.snapshot(), thirdPassword = 'third synthetic sync passphrase';
  await a.api.changeCloudSyncPassword(oldPassword, newPassword);
  const first = JSON.parse(decoder.decode(cloud.controls.get(`${profile.prefix}/password-epoch-v1.json`)));
  await a.api.unlockCloudSync(undefined, newPassword); await saved(a);
  await a.api.changeCloudSyncPassword(newPassword, thirdPassword);
  assert.equal(a.sessionStore.value, null);
  const next = JSON.parse(decoder.decode(cloud.controls.get(`${profile.prefix}/key-${first.next}/password-epoch-v1.json`)));
  assert.equal(next.previous, first.next); assert.notEqual(next.next, first.next); assert.match(next.next, /^[a-f0-9]{32}$/);
  await assert.rejects(a.api.unlockCloudSync(undefined, oldPassword));
  await assert.rejects(a.api.unlockCloudSync(undefined, newPassword));
  assert.equal((await a.api.unlockCloudSync(undefined, thirdPassword)).unlocked, true);
  await saved(a); assert.deepEqual((await a.syncDataStore.snapshot()).records, before.records);
  const active = [...cloud.areas].filter(([prefix]) => prefix.includes(next.next) && /\/all-data-v1(?:\/blobs)?$/.test(prefix));
  assert.equal(active.length, 2);
  for (const [, values] of active) for (const bytes of values.values()) {
    await decryptCloudPayload(bytes, thirdPassword); await assert.rejects(decryptCloudPayload(bytes, newPassword));
  }
});

test('editing a saved connection cannot bypass reencryption by replacing the same-target synchronization password', async (t) => {
  const { cloud, a } = await ready(t), before = await checkpoint(a), writes = cloud.writes.length;
  await assert.rejects(a.api.saveCloudSyncSettings(profile, secrets, newPassword));
  await unchanged(a, before); assert.equal(cloud.writes.length, writes);
});

test('partial transport-cache cleanup failure keeps rotation locked and can resume after some staged ciphertext was removed', async (t) => {
  const { cloud, a } = await ready(t), before = await a.syncDataStore.snapshot();
  const pending = a.createEncryptedStore('full-data-pending'), remove = pending.remove;
  let removed = 0, failed = false;
  pending.remove = async (name) => {
    if (cloud.controls.size && removed === 1 && !failed) { failed = true; throw Error('Synthetic staging cleanup failure'); }
    await remove(name);
    if (cloud.controls.size) removed++;
  };
  await assert.rejects(a.api.changeCloudSyncPassword(oldPassword, newPassword));
  assert.equal(failed, true); assert.equal(removed, 1, 'One encrypted staged object was removed before cleanup failed.');
  assert.equal(cloud.controls.size, 1); assert.equal(a.sessionStore.value, null);
  assert.ok(await a.syncDataStore.readPasswordRotation()); assert.ok((await pending.entries()).length > 0);
  assert.deepEqual(await a.syncDataStore.snapshot(), before);
  pending.remove = remove; a.api = a.make();
  await assert.rejects(a.api.unlockCloudSync(undefined, oldPassword));
  assert.equal((await a.api.unlockCloudSync(undefined, newPassword)).unlocked, true);
  assert.equal(await a.syncDataStore.readPasswordRotation(), null);
  assert.equal((await pending.entries()).length, 0);
  await saved(a); assert.deepEqual((await a.syncDataStore.snapshot()).records, before.records);
});

test('an interrupted candidate cannot resume over a later old-generation edit and the still-current password can abandon and retry safely', async (t) => {
  const { cloud, a, b } = await ready(t, true), before = await checkpoint(a);
  cloud.failWrites = true;
  await assert.rejects(a.api.changeCloudSyncPassword(oldPassword, newPassword));
  cloud.failWrites = false;
  assert.equal(cloud.controls.size, 0); assert.equal(a.sessionStore.value, null);
  assert.ok(await a.syncDataStore.readPasswordRotation());
  await b.editNote('Later synchronized body after rotation interruption'); await saved(b);
  const latest = await b.syncDataStore.snapshot();
  a.api = a.make();
  await assert.rejects(a.api.unlockCloudSync(undefined, newPassword));
  assert.equal(cloud.controls.size, 0, 'Resume must compare the old generation again before committing its control.');
  assert.equal(a.sessionStore.value, null); assert.ok(await a.syncDataStore.readPasswordRotation());
  assert.deepEqual(await a.syncDataStore.snapshot(), before.snapshot);
  assert.deepEqual(await a.configStore.read(), before.config);
  assert.deepEqual(await a.syncDataStore.syncMetadataStore.read(), before.syncMetadata);
  assert.equal((await a.api.unlockCloudSync(undefined, oldPassword)).unlocked, true);
  assert.equal(await a.syncDataStore.readPasswordRotation(), null, 'An uncommitted journal can be abandoned with the still-current password.');
  await saved(a); await saved(b);
  assert.deepEqual((await a.syncDataStore.snapshot()).records, latest.records);
  assert.equal((await a.value(TOOLS)).notes[0].body, 'Later synchronized body after rotation interruption');
  await a.api.changeCloudSyncPassword(oldPassword, newPassword);
  assert.equal(cloud.controls.size, 1); assert.equal(a.sessionStore.value, null);
  await a.api.unlockCloudSync(undefined, newPassword); await saved(a);
  assert.deepEqual((await a.syncDataStore.snapshot()).records, latest.records);
});

test('a losing interrupted rotation rebinds to the authenticated winning password without overwriting local business data', async (t) => {
  const { cloud, a, b } = await ready(t, true), before = await a.syncDataStore.snapshot();
  const winningPassword = 'different winning synthetic passphrase';
  cloud.failWrites = true;
  await assert.rejects(a.api.changeCloudSyncPassword(oldPassword, newPassword));
  cloud.failWrites = false;
  const losingJournal = await a.syncDataStore.readPasswordRotation();
  assert.ok(losingJournal); assert.equal(cloud.controls.size, 0); assert.equal(a.sessionStore.value, null);
  await b.api.changeCloudSyncPassword(oldPassword, winningPassword);
  assert.equal(cloud.controls.size, 1);
  const winner = JSON.parse(decoder.decode(cloud.controls.get(`${profile.prefix}/password-epoch-v1.json`)));
  assert.notEqual(winner.next, losingJournal.epoch);
  const writes = cloud.writes.length;
  assert.equal((await a.api.unlockCloudSync(secrets, winningPassword)).unlocked, true);
  assert.equal(await a.syncDataStore.readPasswordRotation(), null);
  assert.deepEqual((await a.syncDataStore.snapshot()).records, before.records);
  assert.equal(cloud.writes.length, writes, 'Rebinding does not overwrite the winning cloud generation.');
  const envelope = new TextEncoder().encode((await a.configStore.read()).credentialEnvelope);
  await decryptCloudPayload(envelope, winningPassword);
  await assert.rejects(decryptCloudPayload(envelope, newPassword));
  await saved(a); assert.deepEqual((await a.syncDataStore.snapshot()).records, before.records);
  await a.api.lockCloudSync();
  await assert.rejects(a.api.unlockCloudSync(secrets, newPassword));
  assert.equal(a.sessionStore.value, null);
  await a.api.unlockCloudSync(undefined, winningPassword); await saved(a);
  assert.deepEqual((await a.syncDataStore.snapshot()).records, before.records);
});

test('UI-shaped credentials with empty unrelated fields rotate into a provider-scoped envelope and unlock using only the new password after restart', async (t) => {
  const uiSecrets = { ...secrets, sessionToken: '', token: '', username: '', appPassword: '' };
  const { a } = await ready(t, false, uiSecrets), before = await a.syncDataStore.snapshot();
  assert.deepEqual(a.sessionStore.value.secrets, uiSecrets, 'The starting session retains the actual multi-provider form shape.');
  await a.api.changeCloudSyncPassword(oldPassword, newPassword);
  assert.equal(a.sessionStore.value, null);
  const envelope = new TextEncoder().encode((await a.configStore.read()).credentialEnvelope);
  const payload = JSON.parse(decoder.decode(await decryptCloudPayload(envelope, newPassword)));
  assert.deepEqual(payload.credentials, { ...secrets, sessionToken: '' });
  a.api = a.make();
  await assert.rejects(a.api.unlockCloudSync(undefined, oldPassword));
  assert.equal(a.sessionStore.value, null);
  assert.equal((await a.api.unlockCloudSync(undefined, newPassword)).unlocked, true);
  await saved(a); assert.deepEqual((await a.syncDataStore.snapshot()).records, before.records);
});
