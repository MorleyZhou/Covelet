import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolSync, validateToolReplica } from './tool-sync.js';
import { createCloudSync } from './cloud-sync.js';
import { decryptCloudPayload } from './cloud-crypto.js';
import { validatePersonalTools } from './personal-tools.js';
import { sameJson } from './json-equal.js';

const clone = (value) => structuredClone(value), encode = (value) => new TextEncoder().encode(value), decode = (value) => new TextDecoder().decode(value);
const password = 'private tool body test password', token = 'fake-token-never-upload';
const target = 'f'.repeat(64);
const note = (id = 'note-a', body = 'private note text') => ({ id, revision: 1, createdAt: 10, updatedAt: 10, title: id, body, pinned: false });
const reading = (id = 'reading-a') => ({ id, revision: 1, createdAt: 10, updatedAt: 10, title: id, url: `https://${id}.example/?keep=query#hash`, status: 'unread' });
function memory(value = null) {
  let state = clone(value);
  return { async read() { return clone(state); }, async write(next) { state = clone(next); }, async clear() { state = null; }, get value() { return clone(state); } };
}
function remoteStorage() {
  const objects = new Map(), calls = [];
  let unknown = false, offline = false;
  const provider = {
    async list() { calls.push(['list']); return [...objects].map(([name, bytes]) => ({ name, size: bytes.length })); },
    async read(name) { calls.push(['read', name]); return objects.get(name)?.slice(); },
    async write(name, bytes) {
      calls.push(['write', name, bytes.slice()]);
      if (offline) throw Error(`offline ${token}`);
      if (objects.has(name)) assert.deepEqual(bytes, objects.get(name), 'immutable retries must retain the exact ciphertext');
      objects.set(name, bytes.slice());
      if (unknown) { unknown = false; throw Error(`unknown write result ${token}`); }
    },
  };
  return { objects, calls, provider, set unknown(value) { unknown = value; }, set offline(value) { offline = value; } };
}
function device(remote, actor, options = {}) {
  let data = { version: 3, revision: 0, notes: [], reading: [], snapshots: [], trash: [] }, unlocked = true, race = false;
  const store = memory(), listeners = new Set();
  const tools = {
    async loadPersonalTools() { return clone(data); },
    subscribePersonalTools(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async applySyncedPersonalTools(incoming, { expectedRevision }) {
      if (race) { race = false; data.revision++; data.notes.push(note('racing-note', 'new unsaved elsewhere')); }
      if (data.revision !== expectedRevision) throw Object.assign(Error('revision race'), { code: 'REVISION_CONFLICT' });
      const next = validatePersonalTools({ ...data, ...clone(incoming) });
      for (const kind of ['notes', 'reading']) for (const record of next[kind]) {
        const old = data[kind].find((item) => item.id === record.id);
        if (old) record.revision = sameJson({ ...old, revision: 1 }, { ...record, revision: 1 }) ? old.revision : old.revision + 1;
      }
      data = { ...next, revision: data.revision + 1 }; for (const listener of listeners) listener(clone(data)); return clone(data);
    },
  };
  const api = createToolSync({ tools, store, locks: null, uuid: () => actor.repeat(32), eventWindow: null, eventDocument: null,
    autoDelay: options.autoDelay ?? 15000, pullInterval: options.pullInterval ?? 60000,
    access: async () => {
      const check = async () => { if (!unlocked) throw Object.assign(Error('locked'), { code: 'CLOUD_LOCKED' }); };
      await check(); return { target, password: options.password || password, provider: remote.provider, check, autoSync: options.autoSync || false };
    } });
  return { api, store, tools, get data() { return clone(data); }, set unlocked(value) { unlocked = value; }, set race(value) { race = value; },
    edit(update) { update(data); data.revision++; for (const listener of listeners) listener(clone(data)); } };
}
const enable = (subject) => subject.api.setToolSyncEnabled(true);

test('tool bodies are independently off by default and encrypted without secrets, snapshots or trash', async () => {
  const remote = remoteStorage(), a = device(remote, 'a');
  a.edit((data) => { data.notes.push(note()); data.reading.push(reading()); });
  assert.deepEqual(await a.api.loadToolSyncSettings(), { enabled: false });
  assert.equal((await a.api.syncToolCloudNow()).phase, 'disabled'); assert.equal(remote.calls.length, 0);
  await enable(a); assert.equal(remote.calls.length, 0, 'opt-in never makes a network request');
  assert.equal(a.api.getToolSyncStatus().pending, 2);
  assert.equal((await a.api.syncToolCloudNow()).phase, 'saved');
  assert.equal(a.api.getToolSyncStatus().pending, 0);
  assert.match(a.api.getToolSyncStatus().message, /其他设备|devices/);
  for (const bytes of remote.objects.values()) {
    assert.equal(decode(bytes).includes('private note text'), false);
    const plaintext = decode(await decryptCloudPayload(bytes, password));
    assert.equal(plaintext.includes('private note text'), true);
    for (const forbidden of [password, token, 'snapshots', 'trash']) assert.equal(plaintext.includes(forbidden), false);
  }
  for (const forbidden of [password, token]) assert.equal(JSON.stringify(a.store.value).includes(forbidden), false);
});

test('offline edits merge per record, deletion wins without resurrection and both concurrent bodies remain exportable', async () => {
  const remote = remoteStorage(), a = device(remote, 'a'), b = device(remote, 'b'), stale = device(remote, 'c');
  await enable(a); await enable(b); await enable(stale);
  a.edit((data) => { data.notes.push(note()); data.reading.push(reading()); });
  await a.api.syncToolCloudNow(); await b.api.syncToolCloudNow(); await stale.api.syncToolCloudNow();
  a.edit((data) => { data.notes[0].body = 'offline A'; data.notes[0].revision++; data.notes[0].updatedAt++; });
  b.edit((data) => { data.notes[0].body = 'offline B'; data.notes[0].revision++; data.notes[0].updatedAt++; });
  await a.api.syncToolCloudNow(); await b.api.syncToolCloudNow(); await a.api.syncToolCloudNow();
  const conflicts = await a.api.getToolSyncConflicts();
  assert.deepEqual(new Set(conflicts.map((item) => item.value.body)), new Set(['offline A', 'offline B']));
  const chosen = conflicts.find((item) => item.value.body === 'offline B');
  await a.api.useToolSyncConflict(chosen.id); await a.api.syncToolCloudNow(); await b.api.syncToolCloudNow();
  assert.equal(b.data.notes[0].body, 'offline B'); assert.equal((await b.api.getToolSyncConflicts()).length, 0);
  a.edit((data) => { data.notes = []; }); await a.api.syncToolCloudNow(); await b.api.syncToolCloudNow();
  await stale.api.syncToolCloudNow(); assert.equal(stale.data.notes.length, 0, 'an unchanged old device cannot revive a permanent tombstone');
  assert.equal(stale.data.reading.length, 1);
});

test('concurrent deletion preserves the competing edit and a deliberate recovery authors a new causal version', async () => {
  const remote = remoteStorage(), a = device(remote, 'a'), b = device(remote, 'b'); await enable(a); await enable(b);
  a.edit((data) => data.notes.push(note())); await a.api.syncToolCloudNow(); await b.api.syncToolCloudNow();
  a.edit((data) => { data.notes = []; }); b.edit((data) => { data.notes[0].body = 'offline surviving body'; data.notes[0].revision++; });
  await a.api.syncToolCloudNow(); await b.api.syncToolCloudNow(); assert.equal(b.data.notes.length, 0);
  const kept = (await b.api.getToolSyncConflicts()).find((item) => item.value.body === 'offline surviving body'); assert.ok(kept);
  await b.api.useToolSyncConflict(kept.id); await b.api.syncToolCloudNow(); await a.api.syncToolCloudNow();
  assert.equal(a.data.notes[0].body, 'offline surviving body');
});

test('unknown writes retry the exact persisted ciphertext, while new local edits retain separate operations', async () => {
  const remote = remoteStorage(), a = device(remote, 'a'); await enable(a); a.edit((data) => data.notes.push(note()));
  remote.unknown = true; const first = await a.api.syncToolCloudNow(); assert.equal(first.phase, 'error'); assert.equal(first.message.includes(token), false);
  const pending = a.store.value.metadata.pending; assert.ok(pending); assert.equal(first.pending, 1);
  a.edit((data) => data.notes.push(note('new-note'))); assert.equal((await a.api.syncToolCloudNow()).phase, 'saved');
  assert.deepEqual(remote.objects.get(pending.name), encode(pending.body)); assert.equal(a.store.value.metadata.pending, null);
  assert.equal(remote.objects.size, 2);
});

test('wrong passwords or corrupt latest ciphertext reject the entire incoming batch without local mutation', async () => {
  const remote = remoteStorage(), a = device(remote, 'a'), b = device(remote, 'b', { password: 'wrong but long test password' }); await enable(a); await enable(b);
  a.edit((data) => data.notes.push(note())); await a.api.syncToolCloudNow();
  assert.equal((await b.api.syncToolCloudNow()).code, 'CLOUD_DECRYPT'); assert.equal(b.data.notes.length, 0);
  const c = device(remote, 'c'); await enable(c); const [name, bytes] = remote.objects.entries().next().value; const broken = bytes.slice(); broken[10] ^= 1; remote.objects.set(name, broken);
  assert.equal((await c.api.syncToolCloudNow()).phase, 'error'); assert.equal(c.data.notes.length, 0); assert.equal(remote.objects.size, 1);
});

test('a revision race never overwrites edits made while network reads were in flight', async () => {
  const remote = remoteStorage(), a = device(remote, 'a'), b = device(remote, 'b'); await enable(a); await enable(b);
  a.edit((data) => data.notes.push(note())); await a.api.syncToolCloudNow(); b.race = true;
  assert.equal((await b.api.syncToolCloudNow()).code, 'REVISION_CONFLICT'); assert.deepEqual(b.data.notes.map((item) => item.id), ['racing-note']);
  await b.api.syncToolCloudNow(); assert.deepEqual(b.data.notes.map((item) => item.id).sort(), ['note-a', 'racing-note']);
});

test('locking during upload leaves a retryable pending version and never acknowledges success', async () => {
  const remote = remoteStorage(), a = device(remote, 'a'); await enable(a); a.edit((data) => data.notes.push(note()));
  const write = remote.provider.write; remote.provider.write = async (...args) => { await write(...args); a.unlocked = false; };
  const result = await a.api.syncToolCloudNow(); assert.equal(result.code, 'CLOUD_LOCKED'); assert.equal(result.lastSync, 0); assert.ok(a.store.value.metadata.pending);
  a.unlocked = true; remote.provider.write = write; assert.equal((await a.api.syncToolCloudNow()).phase, 'saved'); assert.equal(a.store.value.metadata.pending, null);
});

test('bounded documents fail safely, local-only record revisions do not author changes and duplicate reading URLs remain recoverable', async () => {
  const remote = remoteStorage(), a = device(remote, 'a'), b = device(remote, 'b'); await enable(a); await enable(b);
  a.edit((data) => { data.notes.push(note()); data.reading.push(reading('reading-a')); }); await a.api.syncToolCloudNow();
  const before = remote.objects.size; a.edit((data) => data.notes[0].revision++); await a.api.syncToolCloudNow(); assert.equal(remote.objects.size, before);
  b.edit((data) => data.reading.push({ ...reading('reading-b'), url: reading('reading-a').url }));
  await b.api.syncToolCloudNow(); assert.equal(b.data.reading.length, 1);
  const duplicate = (await b.api.getToolSyncConflicts()).find((item) => item.kind === 'reading'); assert.equal(duplicate.duplicate, true);
  await b.api.useToolSyncConflict(duplicate.id, { discard: true }); assert.equal((await b.api.getToolSyncConflicts()).length, 0);
  assert.throws(() => validateToolReplica({ version: 1, actor: 'a'.repeat(32), clock: 1, records: { 'notes:note-a': { n: 1, context: {}, value: { ...note(), revision: 999 } } } }));
  a.edit((data) => { data.notes = Array.from({ length: 10 }, (_, index) => note(`large-${index}`, 'x'.repeat(60000))); });
  assert.equal((await a.api.syncToolCloudNow()).code, 'TOOLS_SYNC_CAPACITY'); assert.equal(a.data.notes.length, 10);
});

test('turning tool sync off retains offline content and causal history; target changes cannot discard pending work', async () => {
  const remote = remoteStorage(), a = device(remote, 'a'); await enable(a); a.edit((data) => data.notes.push(note())); await a.api.syncToolCloudNow();
  await a.api.setToolSyncEnabled(false); const before = remote.calls.length;
  a.edit((data) => { data.notes[0].body = 'offline while disabled'; data.notes[0].revision++; });
  assert.equal((await a.api.syncToolCloudNow()).phase, 'disabled'); assert.equal(remote.calls.length, before);
  assert.equal(a.data.notes[0].body, 'offline while disabled');
  await assert.rejects(a.api.ensureToolTarget('e'.repeat(64)), { code: 'TOOLS_SYNC_TARGET' });
  await enable(a); await a.api.syncToolCloudNow(); await a.api.ensureToolTarget('e'.repeat(64));
  assert.equal(a.store.value.metadata.document.actor, 'a'.repeat(32));
});

test('automatic tool transfer requires both independent opt-in and the existing connection auto-sync setting', async () => {
  const remote = remoteStorage(), a = device(remote, 'a', { autoSync: true, autoDelay: 5 }), b = device(remote, 'b', { autoSync: false, autoDelay: 5 });
  const stopA = a.api.startToolSync(), stopB = b.api.startToolSync();
  try {
    a.edit((data) => data.notes.push(note())); await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(remote.calls.length, 0);
    await enable(b); b.edit((data) => data.notes.push(note('note-b'))); await new Promise((resolve) => setTimeout(resolve, 25)); assert.equal(remote.calls.length, 0);
    await enable(a);
    for (let tries = 0; tries < 200 && a.api.getToolSyncStatus().phase !== 'saved'; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(a.api.getToolSyncStatus().phase, 'saved'); assert.equal(remote.objects.size, 1);
  } finally { stopA(); stopB(); }
});

test('the existing cloud connection supplies a separate tools-v1 directory and the shared session password without new account storage', async () => {
  const remote = remoteStorage(), a = device(remote, 'a'), configStore = memory(), sessionStore = memory(), profiles = [];
  const signer = { async sha256(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join(''); } };
  const cloud = createCloudSync({ fullData: false, configStore, sessionStore, toolSyncStore: memory(), toolsStore: a.tools, signer, locks: null, hasPermission: async () => true,
    uuid: () => 'a'.repeat(32), eventWindow: null, eventDocument: null, providerFactory(profile) { profiles.push(clone(profile)); return remote.provider; } });
  const profile = { provider: 'github', owner: 'test-owner', repo: 'private-store', branch: 'main', prefix: 'test-only' };
  await cloud.saveCloudSyncSettings(profile, { token }, password); await cloud.setToolSyncEnabled(true); a.edit((data) => data.notes.push(note()));
  assert.equal((await cloud.syncToolCloudNow()).phase, 'saved'); assert.equal(profiles.at(-1).prefix, 'test-only/tools-v1');
  assert.equal(JSON.stringify(configStore.value).includes(token), false); assert.equal(sessionStore.value.password, password);
});

test('a missing tool directory is created only after independent opt-in and then strictly listed before any upload', async () => {
  const remote = remoteStorage(), a = device(remote, 'a');
  const list = remote.provider.list; let created = false, ensures = 0;
  remote.provider.list = async () => { if (!created) throw Object.assign(Error('missing tool child'), { code: 'CLOUD_NOT_FOUND' }); return list(); };
  remote.provider.ensureToolDirectory = async () => { ensures++; created = true; };
  a.edit((data) => data.notes.push(note())); await a.api.syncToolCloudNow(); assert.equal(ensures, 0);
  await enable(a); assert.equal(ensures, 0); assert.equal((await a.api.syncToolCloudNow()).phase, 'saved'); assert.equal(ensures, 1);
  assert.equal(remote.calls[0][0], 'list'); assert.equal(remote.objects.size, 1);
});
