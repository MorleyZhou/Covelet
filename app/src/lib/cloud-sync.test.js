import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWebdavProvider } from './cloud-webdav.js';
import { createCloudProvider } from './cloud-providers.js';
import { cloudProviderLabel, SYNC_PROVIDERS, SYNC_SETUP_STEPS } from './cloud-connection.js';
import { createCloudSync, supportsCloudSync } from './cloud-sync.js';
import { createSyncWasm } from './sync-wasm.js';
import { createEmptyState } from './model.js';
import { decryptCloudPayload, encryptCloudPayload } from './cloud-crypto.js';

const signer = await createSyncWasm(await readFile(new URL('../wasm/sync-core.wasm', import.meta.url)));
const encode = (value) => new TextEncoder().encode(value);
const decode = (value) => new TextDecoder().decode(value);
const clone = (value) => structuredClone(value);
const profile = { provider: 'github', owner: 'covelet-test', repo: 'private-sync', branch: 'main', prefix: 'test-directory' };
const secrets = { token: 'fake-test-token-never-persist' };
const password = 'private offline test passphrase';
const actor = (value) => value.repeat(32);
const site = (id, order = 0) => ({ id, type: 'site', name: id, url: `https://${id}.example/`, groupId: 'group-home', parentId: null, icon: { kind: 'letter', value: id.slice(0, 2) }, order });

function cloud() {
  const objects = new Map();
  const calls = [];
  let failWrites = false;
  let unknownWrite = false;
  const factory = () => ({
    async list() { calls.push(['list']); return [...objects].map(([name, bytes]) => ({ name, size: bytes.length })); },
    async read(name) { calls.push(['read', name]); return objects.get(name)?.slice(); },
    async write(name, bytes) {
      calls.push(['write', name, bytes.slice()]);
      if (failWrites) throw new Error(`network error ${secrets.token}`);
      if (objects.has(name)) assert.deepEqual(bytes, objects.get(name), 'an immutable object name must never change its body');
      objects.set(name, bytes.slice());
      if (unknownWrite) { unknownWrite = false; throw new Error(`unknown result ${secrets.token}`); }
    },
  });
  return { factory, objects, calls, set failWrites(value) { failWrites = value; }, set unknownWrite(value) { unknownWrite = value; } };
}

function memory(value = null) {
  let current = clone(value);
  return { async read() { return clone(current); }, async write(next) { current = clone(next); }, async clear() { current = null; }, get value() { return clone(current); } };
}

function device(remote, id, options = {}) {
  let state = createEmptyState();
  const configStore = options.configStore || memory();
  const sessionStore = options.sessionStore || memory();
  // Every new tab shares this device's tool-sync settings too. Production now
  // persists them in encrypted IndexedDB, which these isolated replica tests
  // deliberately replace along with the navigation/session stores.
  const toolSyncStore = options.toolSyncStore || memory();
  const subscribers = new Set();
  let race = false;
  const stateStore = {
    async loadState() { return clone(state); },
    async saveState(next, revision) {
      if (race) { race = false; state.settings.width = 1440; state.revision++; }
      if (revision !== state.revision) throw Object.assign(new Error('revision conflict'), { code: 'REVISION_CONFLICT' });
      state = { ...clone(next), revision: revision + 1 };
      for (const listener of subscribers) listener(clone(state));
      return clone(state);
    },
    subscribeState(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
  };
  // These cases retain coverage of the legacy navigation protocol used for
  // upgrade imports. Unified encrypted namespaces have their own round trips.
  const make = () => createCloudSync({ fullData: false, stateStore, configStore, sessionStore, toolSyncStore, providerFactory: remote.factory, signer, hasPermission: async () => true,
    uuid: () => actor(id), eventWindow: null, eventDocument: null, ...options });
  return { api: make(), make, configStore, sessionStore, stateStore, get state() { return clone(state); },
    edit(update) { const next = clone(state); update(next); next.revision++; state = next; for (const listener of subscribers) listener(clone(state)); },
    set race(value) { race = value; } };
}

async function configure(subject, options = {}) { return subject.api.saveCloudSyncSettings(profile, secrets, password, options); }

test('worker sync status is displayed in the receiving page language', () => {
  const { api } = device(cloud(), 'a');
  api.acceptBackgroundCloudSyncStatus({
    phase: 'error', code: 'CLOUD_REQUEST_FAILED', message: 'The storage service couldn’t complete the request. Try again later.',
  });
  assert.equal(api.getCloudSyncStatus().message, '存储服务暂时无法完成请求。请稍后重试。');
  assert.equal(api.getCloudSyncStatus().code, 'CLOUD_REQUEST_FAILED');
});

test('local-only fallback clears shared secrets and auto sync while preserving pending ciphertext and local data', async () => {
  const remote = cloud(), subject = device(remote, 'a');
  await configure(subject, { autoSync: true });
  subject.edit(state => state.entries.push(site('offline')));
  remote.failWrites = true;
  assert.equal((await subject.api.syncCloudNow()).phase, 'error');
  const before = subject.configStore.value, local = subject.state, calls = remote.calls.length;
  assert.ok(before.metadata.pending);
  const fallback = await subject.api.useLocalOnlyCloudSync();
  assert.equal(fallback.autoSync, false);
  assert.equal(fallback.unlocked, false);
  assert.equal(fallback.connectionTest, null);
  assert.equal(subject.sessionStore.value, null);
  assert.deepEqual(subject.state, local);
  assert.deepEqual(subject.configStore.value, { ...before, autoSync: false });
  assert.equal(remote.calls.length, calls, 'fallback must not contact the failed provider');
  assert.equal((await subject.make().loadCloudSyncSettings()).unlocked, false, 'other tabs cannot reuse cleared credentials');
  assert.equal((await subject.api.syncCloudNow()).code, 'CLOUD_LOCKED');
  assert.equal(remote.calls.length, calls);
});

test('local-only fallback works before any connection has been saved and is repeatable', async () => {
  const remote = cloud(), subject = device(remote, 'a');
  await subject.api.useLocalOnlyCloudSync();
  const result = await subject.api.useLocalOnlyCloudSync();
  assert.equal(result.configured, false);
  assert.equal(result.autoSync, false);
  assert.equal(remote.calls.length, 0);
});

test('cloud settings persist an encrypted credential envelope and keep decrypted credentials in the session', async () => {
  const remote = cloud();
  const subject = device(remote, 'a');
  assert.equal(supportsCloudSync(), false);
  assert.deepEqual(await subject.api.loadCloudSyncSettings(), { profile: null, autoSync: false, configured: false, unlocked: false, credentialsStored: false, connectionTest: null });
  const result = await configure(subject);
  assert.equal(result.autoSync, false);
  assert.equal(result.unlocked, true);
  assert.equal(result.credentialsStored, true);
  assert.equal(remote.calls.length, 0, 'saving and unlocking make no network request');
  const local = JSON.stringify(subject.configStore.value);
  assert.equal(local.includes(secrets.token), false);
  assert.equal(local.includes(password), false);
  assert.equal(subject.sessionStore.value.password, password);
  assert.equal((await subject.make().loadCloudSyncSettings()).unlocked, true, 'a new tab reuses storage.session');
  await subject.api.lockCloudSync();
  assert.equal((await subject.make().loadCloudSyncSettings()).unlocked, false);
  assert.equal(subject.configStore.value.autoSync, false);
});

test('a restarted GitHub connection unlocks with only its sync password and rejects a wrong password or swapped envelope', async () => {
  const remote = cloud(), initial = device(remote, 'a');
  await configure(initial);
  const savedConfig = initial.configStore.value;
  const { salt, iv, ciphertext, kdf } = JSON.parse(savedConfig.credentialEnvelope);
  assert.equal(kdf, 'PBKDF2-SHA256');
  assert.ok(salt && iv && ciphertext);
  const resumed = device(remote, 'a', { configStore: initial.configStore, providerFactory(checked, credentials) {
    assert.equal(checked.provider, 'github');
    assert.equal(credentials.token, secrets.token);
    return remote.factory();
  } });
  assert.equal((await resumed.api.loadCloudSyncSettings()).unlocked, false);
  // Supplying provider credentials cannot bypass a bad password once the vault exists.
  await assert.rejects(resumed.api.unlockCloudSync(secrets, 'wrong long passphrase'), { code: 'CLOUD_CREDENTIAL_UNLOCK' });
  assert.equal(resumed.sessionStore.value, null);
  assert.deepEqual(resumed.configStore.value, savedConfig);
  const unlocked = await resumed.api.unlockCloudSync(undefined, password);
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.connectionTest, null);
  assert.deepEqual(resumed.sessionStore.value.secrets, secrets);
  assert.equal(remote.calls.length, 0, 'password-only unlock is local');
  assert.equal((await resumed.api.testCloudConnection()).scope, 'directory-read');

  const displaced = device(remote, 'b', { configStore: memory({ ...savedConfig, profile: { ...profile, prefix: 'another-target' } }) });
  await assert.rejects(displaced.api.unlockCloudSync(undefined, password), { code: 'CLOUD_CREDENTIAL_UNLOCK' });
  assert.equal(displaced.sessionStore.value, null);
});

test('post-first-sync auto-enable changes only the active settings and cannot revive a locked or replaced session', async () => {
  const remote = cloud(), subject = device(remote, 'a');
  await configure(subject);
  const original = subject.configStore.value;
  const enable = () => subject.api.saveCloudSyncSettings(profile, secrets, password, { autoSync: true, onlyIfCurrent: true });
  await enable();
  assert.deepEqual(subject.configStore.value, { ...original, autoSync: true });
  await subject.api.lockCloudSync();
  await assert.rejects(enable(), { code: 'CLOUD_LOCKED' });
  assert.equal(subject.sessionStore.value, null);
  await subject.api.saveCloudSyncSettings({ ...profile, prefix: 'replacement-target' }, secrets, password);
  const replacement = subject.configStore.value;
  await assert.rejects(enable(), { code: 'CLOUD_LOCKED' });
  assert.deepEqual(subject.configStore.value, replacement);
  assert.equal(remote.calls.length, 0);
});

test('two devices merge portable navigation, keep original local icons and never upload credentials or image references', async () => {
  const remote = cloud();
  const a = device(remote, 'a'), b = device(remote, 'b');
  await configure(a); await configure(b);
  a.edit((state) => { state.entries.push({ ...site('alpha'), icon: { kind: 'image', value: 'original-image-only-on-a' }, iconBackground: '#123456' }); state.settings.visualEnhancement = false; });
  assert.equal((await a.api.syncCloudNow()).phase, 'saved');
  assert.equal((await b.api.syncCloudNow()).phase, 'saved');
  assert.equal(b.state.entries[0].name, 'alpha');
  assert.deepEqual(b.state.entries[0].icon, { kind: 'url', value: 'https://alpha.example/favicon.ico' });
  assert.equal(b.state.settings.visualEnhancement, false);
  a.edit((state) => { state.entries.push(site('local-a', 1)); });
  b.edit((state) => { state.entries.push(site('local-b', 1)); });
  await a.api.syncCloudNow(); await b.api.syncCloudNow(); await a.api.syncCloudNow();
  assert.deepEqual(a.state.entries.map((entry) => entry.id).sort(), ['alpha', 'local-a', 'local-b']);
  assert.deepEqual(a.state.entries[0].icon, { kind: 'image', value: 'original-image-only-on-a' });
  for (const [name, bytes] of remote.objects) {
    assert.match(name, /^covelet-[a-f0-9]{32}-[1-9][0-9]*-[a-f0-9]{64}\.json$/);
    const envelope = decode(bytes);
    assert.equal(envelope.includes('alpha'), false);
    const plain = decode(await decryptCloudPayload(bytes, password));
    for (const forbidden of [secrets.token, password, 'original-image-only-on-a', 'private-sync', 'test-directory']) assert.equal(plain.includes(forbidden), false);
  }
});

test('offline concurrent edits stay recoverable, including a deletion, and a selected recovery converges', async () => {
  const remote = cloud();
  const a = device(remote, 'a'), b = device(remote, 'b');
  await configure(a); await configure(b);
  a.edit((state) => { state.entries.push(site('alpha')); });
  await a.api.syncCloudNow(); await b.api.syncCloudNow(); await a.api.syncCloudNow();
  a.edit((state) => { state.entries = []; });
  b.edit((state) => { state.entries[0].name = 'offline renamed'; });
  await a.api.syncCloudNow(); await b.api.syncCloudNow(); await a.api.syncCloudNow();
  assert.equal(a.state.entries.length, 0);
  assert.equal(b.state.entries.length, 0);
  const conflicts = await b.api.getCloudSyncConflicts();
  const renamed = conflicts.find((conflict) => conflict.value?.name === 'offline renamed');
  assert.ok(renamed, 'an offline rename is not falsely treated as observing the deletion');
  await b.api.restoreCloudSyncConflict(renamed.id);
  await b.api.syncCloudNow(); await a.api.syncCloudNow();
  assert.equal(a.state.entries[0].name, 'offline renamed');
  assert.equal((await a.api.getCloudSyncConflicts()).length, 0);
});

test('an unknown write result retries exactly one persisted ciphertext and never reuses a name with another body', async () => {
  const remote = cloud(); const a = device(remote, 'a');
  await configure(a);
  a.edit((state) => { state.entries.push(site('alpha')); });
  remote.unknownWrite = true;
  const failed = await a.api.syncCloudNow();
  assert.equal(failed.phase, 'error');
  assert.equal(failed.message.includes(secrets.token), false);
  const pending = a.configStore.value.metadata.pending;
  assert.ok(pending);
  const pendingClock = a.configStore.value.metadata.document.clock;
  const writesBefore = remote.calls.filter(([method]) => method === 'write').length;
  a.edit((state) => { state.settings.columns = 10; });
  assert.equal((await a.api.syncCloudNow()).phase, 'saved');
  assert.equal(a.configStore.value.metadata.pending, null);
  assert.ok(a.configStore.value.metadata.document.clock > pendingClock);
  assert.deepEqual(remote.objects.get(pending.name), encode(pending.body));
  assert.equal(remote.calls.filter(([method]) => method === 'write').length, writesBefore + 1, 'the already committed pending version is read and verified rather than replaced');
});

test('wrong decryption passwords and one corrupt latest document reject the entire batch without local edits or uploads', async () => {
  const remote = cloud(); const a = device(remote, 'a'), b = device(remote, 'b');
  await configure(a);
  await b.api.saveCloudSyncSettings(profile, secrets, 'wrong but long password');
  a.edit((state) => { state.entries.push(site('alpha')); }); await a.api.syncCloudNow();
  assert.equal((await b.api.syncCloudNow()).code, 'CLOUD_DECRYPT');
  assert.equal(b.state.entries.length, 0);
  assert.equal(remote.objects.size, 1);
  await b.api.saveCloudSyncSettings(profile, secrets, password);
  const badDocument = { version: 1, actor: actor('c'), clock: 1, records: {} };
  const bytes = await encryptCloudPayload(encode(JSON.stringify(badDocument)), password);
  const name = `covelet-${actor('c')}-1-${await signer.sha256(bytes)}.json`;
  bytes[bytes.length - 10] ^= 1;
  remote.objects.set(name, bytes);
  const before = b.state;
  assert.equal((await b.api.syncCloudNow()).code, 'CLOUD_INTEGRITY');
  assert.deepEqual(b.state, before);
  assert.equal(remote.objects.size, 2);
});

test('host permission checks guard every operation and local revision races preserve the later tab edit', async () => {
  const remote = cloud(); const a = device(remote, 'a');
  let permitted = false;
  const b = device(remote, 'b', { hasPermission: async () => permitted });
  await configure(a); await configure(b);
  assert.equal((await b.api.syncCloudNow()).code, 'CLOUD_PERMISSION');
  assert.equal(remote.calls.length, 0);
  a.edit((state) => { state.entries.push(site('alpha')); }); await a.api.syncCloudNow();
  permitted = true; b.race = true;
  const beforeObjects = remote.objects.size;
  assert.equal((await b.api.syncCloudNow()).code, 'REVISION_CONFLICT');
  assert.equal(b.state.settings.width, 1440);
  assert.equal(b.state.entries.length, 0);
  assert.equal(remote.objects.size, beforeObjects, 'a conflicting local commit never publishes a partial merge');
  assert.equal((await b.api.syncCloudNow()).phase, 'saved');
  assert.equal(b.state.settings.width, 1440);
  assert.equal(b.state.entries[0].name, 'alpha');
});

test('failed publication retains local edits and bounded cloud listings fail before any reads or partial merge', async () => {
  const remote = cloud(); const a = device(remote, 'a');
  await configure(a); a.edit((state) => { state.settings.columns = 12; });
  remote.failWrites = true;
  assert.equal((await a.api.syncCloudNow()).phase, 'error');
  assert.equal(a.state.settings.columns, 12);
  assert.ok(a.configStore.value.metadata.pending);
  remote.failWrites = false;
  assert.equal((await a.api.syncCloudNow()).phase, 'saved');
  const tooMany = device(remote, 'b', { providerFactory: () => ({ async list() { return Array.from({ length: 2001 }, () => ({ name: 'invalid' })); }, async read() { assert.fail('must reject listing before reads'); } }) });
  await configure(tooMany);
  assert.equal((await tooMany.api.syncCloudNow()).code, 'CLOUD_CAPACITY');
  assert.equal(tooMany.state.entries.length, 0);
});

test('duplicate same-clock ciphertext and too many actors are rejected before downloading a partial batch', async () => {
  const remote = cloud();
  const make = (listing) => device(remote, 'a', { providerFactory: () => ({ async list() { return listing; }, async read() { assert.fail('must reject before reads'); } }) });
  const duplicate = make([
    { name: `covelet-${actor('b')}-1-${'a'.repeat(64)}.json`, size: 100 },
    { name: `covelet-${actor('b')}-1-${'b'.repeat(64)}.json`, size: 100 },
  ]);
  await configure(duplicate);
  assert.equal((await duplicate.api.syncCloudNow()).code, 'CLOUD_INTEGRITY');
  const actors = make(Array.from({ length: 101 }, (_, index) => ({ name: `covelet-${index.toString(16).padStart(32, '0')}-1-${'a'.repeat(64)}.json`, size: 100 })));
  await configure(actors);
  assert.equal((await actors.api.syncCloudNow()).code, 'CLOUD_CAPACITY');
});

test('auto sync remains opt-in, debounces edits, and locking stops later I/O while retaining settings', async () => {
  const remote = cloud(); const a = device(remote, 'a', { autoDelay: 10 });
  const stop = a.api.startCloudSync();
  await configure(a);
  a.edit((state) => { state.settings.columns = 10; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(remote.calls.length, 0, 'the native and cloud defaults stay off');
  await configure(a, { autoSync: true });
  a.edit((state) => { state.settings.columns = 11; });
  a.edit((state) => { state.settings.columns = 12; });
  for (let retry = 0; retry < 50 && !remote.objects.size; retry++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(remote.objects.size, 1);
  for (let retry = 0; retry < 50 && a.api.getCloudSyncStatus().phase === 'syncing'; retry++) await new Promise((resolve) => setTimeout(resolve, 10));
  await a.api.lockCloudSync();
  const calls = remote.calls.length;
  a.edit((state) => { state.settings.columns = 8; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(remote.calls.length, calls);
  assert.equal(a.configStore.value.profile.repo, profile.repo);
  assert.equal(a.configStore.value.autoSync, true);
  assert.equal(a.state.settings.columns, 8);
  stop();
});

test('session locking or a target change during a read prevents the stale result from being committed locally', async () => {
  const remote = cloud(); const a = device(remote, 'a');
  await configure(a); a.edit((state) => { state.entries.push(site('alpha')); }); await a.api.syncCloudNow();
  const b = device(remote, 'b'); await configure(b);
  const factory = remote.factory;
  const blocked = device(remote, 'b', { configStore: b.configStore, sessionStore: b.sessionStore,
    providerFactory: (...args) => {
      const provider = factory(...args);
      return { ...provider, async read(name) { const bytes = await provider.read(name); await b.sessionStore.clear(); return bytes; } };
    } });
  assert.equal((await blocked.api.syncCloudNow()).code, 'CLOUD_LOCKED');
  assert.equal(blocked.state.entries.length, 0);
  assert.equal(blocked.configStore.value.profile.repo, profile.repo);
  await b.api.unlockCloudSync(secrets, password);
  const changed = device(remote, 'b', { configStore: b.configStore, sessionStore: b.sessionStore,
    providerFactory: (...args) => {
      const provider = factory(...args);
      return { ...provider, async read(name) {
        const bytes = await provider.read(name);
        const config = await b.configStore.read(); config.profile.repo = 'another-target'; await b.configStore.write(config);
        return bytes;
      } };
    } });
  assert.equal((await changed.api.syncCloudNow()).code, 'CLOUD_LOCKED');
  assert.equal(changed.state.entries.length, 0);
  assert.equal(changed.configStore.value.profile.repo, 'another-target');
});

test('changing a target preserves an unpublished offline rename and its conflict after another device deletes the site', async () => {
  const remote = cloud(); const a = device(remote, 'a'), b = device(remote, 'b');
  await configure(a); await configure(b);
  a.edit((state) => { state.entries.push(site('alpha')); });
  await a.api.syncCloudNow(); await b.api.syncCloudNow(); await a.api.syncCloudNow();
  a.edit((state) => { state.entries[0].name = 'the only offline rename'; });
  b.edit((state) => { state.entries = []; });
  await b.api.syncCloudNow();
  remote.failWrites = true;
  assert.equal((await a.api.syncCloudNow()).phase, 'error');
  assert.equal(a.state.entries.length, 0, 'the concurrent deletion is visible after merging');
  assert.ok(a.configStore.value.metadata.pending, 'the rename still exists in the unpublished local replica');
  assert.ok((await a.api.getCloudSyncConflicts()).some((item) => item.value?.name === 'the only offline rename'));
  const nextProfile = { ...profile, repo: 'another-target' };
  const nextSecrets = { token: 'replacement-credentials-must-not-win' };
  const beforeConfig = JSON.stringify(a.configStore.value);
  const beforeSession = JSON.stringify(a.sessionStore.value);
  await assert.rejects(a.api.saveCloudSyncSettings(nextProfile, nextSecrets, 'a different long password', { autoSync: true }), { code: 'CLOUD_TARGET_PENDING' });
  assert.equal(JSON.stringify(a.configStore.value), beforeConfig, 'a rejected switch must not alter any persisted metadata byte');
  assert.equal(JSON.stringify(a.sessionStore.value), beforeSession, 'the old unlock credentials must remain available');
  remote.failWrites = false;
  assert.equal((await a.api.syncCloudNow()).phase, 'saved');
  assert.equal(a.configStore.value.metadata.pending, null);
  const uploadedConfig = JSON.stringify(a.configStore.value);
  const uploadedSession = JSON.stringify(a.sessionStore.value);
  await assert.rejects(a.api.saveCloudSyncSettings(nextProfile, nextSecrets, 'a different long password'), { code: 'CLOUD_TARGET_CONFLICTS' });
  assert.equal(JSON.stringify(a.configStore.value), uploadedConfig);
  assert.equal(JSON.stringify(a.sessionStore.value), uploadedSession);
  const conflict = (await a.api.getCloudSyncConflicts()).find((item) => item.value?.name === 'the only offline rename');
  await a.api.restoreCloudSyncConflict(conflict.id);
  await a.api.syncCloudNow();
  assert.equal(a.state.entries[0].name, 'the only offline rename');
  assert.equal((await a.api.getCloudSyncConflicts()).length, 0);
  assert.equal((await a.api.saveCloudSyncSettings(nextProfile, nextSecrets, 'a different long password')).profile.repo, 'another-target');
});

test('locking between a provider existence check and its PUT blocks the second request and retains the exact pending payload', async () => {
  const remote = cloud();
  let releaseCheck;
  let enteredCheck;
  const checked = new Promise((resolve) => { enteredCheck = resolve; });
  const release = new Promise((resolve) => { releaseCheck = resolve; });
  let waiting = true;
  let puts = 0;
  const subject = device(remote, 'a', { providerFactory: (_profile, _secrets, options) => ({
    async list() { await options.beforeRequest(); return [...remote.objects].map(([name, bytes]) => ({ name, size: bytes.length })); },
    async read(name) { await options.beforeRequest(); return remote.objects.get(name).slice(); },
    async write(name, bytes) {
      await options.beforeRequest(); // provider-internal existence GET
      if (waiting) { waiting = false; enteredCheck(); await release; }
      await options.beforeRequest(); // provider-internal PUT, rechecked after signing/GET
      puts++; remote.objects.set(name, bytes.slice());
    },
  }) });
  await configure(subject); subject.edit((state) => { state.entries.push(site('alpha')); });
  const syncing = subject.api.syncCloudNow();
  await checked;
  const pending = JSON.stringify(subject.configStore.value.metadata.pending);
  await subject.api.lockCloudSync();
  releaseCheck();
  assert.equal((await syncing).phase, 'locked');
  assert.equal(subject.api.getCloudSyncStatus().unlocked, false);
  assert.equal(puts, 0);
  assert.equal(remote.objects.size, 0);
  assert.equal(JSON.stringify(subject.configStore.value.metadata.pending), pending);
  await subject.api.unlockCloudSync(secrets, password);
  assert.equal((await subject.api.syncCloudNow()).phase, 'saved');
  assert.equal(puts, 1);
});

test('a completed in-flight PUT after locking cannot clear pending state or report saved/unlocked', async () => {
  const remote = cloud();
  let releaseResponse;
  let enteredPut;
  const sent = new Promise((resolve) => { enteredPut = resolve; });
  const response = new Promise((resolve) => { releaseResponse = resolve; });
  let waitOnce = true;
  const subject = device(remote, 'a', { providerFactory: (_profile, _secrets, options) => ({
    async list() { await options.beforeRequest(); return [...remote.objects].map(([name, bytes]) => ({ name, size: bytes.length })); },
    async read(name) { await options.beforeRequest(); return remote.objects.get(name).slice(); },
    async write(name, bytes) {
      await options.beforeRequest();
      remote.objects.set(name, bytes.slice()); // the already-sent PUT may commit
      if (waitOnce) { waitOnce = false; enteredPut(); await response; }
    },
  }) });
  await configure(subject); subject.edit((state) => { state.settings.columns = 10; });
  const syncing = subject.api.syncCloudNow();
  await sent;
  const pending = JSON.stringify(subject.configStore.value.metadata.pending);
  await subject.api.lockCloudSync();
  releaseResponse();
  const result = await syncing;
  assert.equal(result.phase, 'locked'); assert.equal(result.unlocked, false);
  assert.equal(JSON.stringify(subject.configStore.value.metadata.pending), pending);
  assert.equal(subject.configStore.value.metadata.publishedClock, 0);
  assert.equal(subject.configStore.value.metadata.lastSync, 0);
  assert.equal(remote.objects.size, 1, 'an already committed request is not claimed to be undone');
  await subject.api.unlockCloudSync(secrets, password);
  assert.equal((await subject.api.syncCloudNow()).phase, 'saved');
  assert.equal(subject.configStore.value.metadata.pending, null);
  assert.equal(remote.objects.size, 1, 'unlocking verifies the existing ciphertext instead of publishing another name');
});


test('connection testing is independent of saving and the sync password; proof follows only the tested target and credentials', async () => {
  const remote = cloud(), subject = device(remote, 'a');
  const result = await subject.api.testCloudConnection(profile, secrets);
  assert.equal(result.scope, 'directory-read'); assert.ok(result.testedAt > 0);
  assert.equal(subject.configStore.value, null, 'test does not save or unlock');
  assert.equal(subject.sessionStore.value, null);
  assert.deepEqual(remote.calls.map(call => call[0]), ['list']);
  const settings = await configure(subject);
  assert.deepEqual(settings.connectionTest, result);
  assert.equal(remote.calls.length, 1, 'saving never probes the network');
  await subject.api.lockCloudSync();
  assert.equal((await subject.api.loadCloudSyncSettings()).connectionTest, null);
  await subject.api.unlockCloudSync(secrets, password);
  assert.equal((await subject.api.loadCloudSyncSettings()).connectionTest, null, 'unlocking does not verify credentials');
  await subject.api.testCloudConnection();
  assert.ok((await subject.api.loadCloudSyncSettings()).connectionTest);
  const restarted = device(remote, 'a', { configStore: subject.configStore });
  assert.equal((await restarted.api.loadCloudSyncSettings()).connectionTest, null, 'restart loses session proof');
  await subject.api.saveCloudSyncSettings(profile, { token: 'other fake token' }, password);
  assert.equal((await subject.api.loadCloudSyncSettings()).connectionTest, null, 'credential changes invalidate a test');
  await subject.api.testCloudConnection(profile, secrets);
  await subject.api.saveCloudSyncSettings({ ...profile, prefix: 'another-directory' }, secrets, password);
  assert.equal((await subject.api.loadCloudSyncSettings()).connectionTest, null, 'target changes invalidate a test');
});

test('failed retests invalidate verification; locking or denied site access prevents test results from reviving a session', async () => {
  const remote = cloud(); let fails = false, during;
  const subject = device(remote, 'a', { providerFactory: (...args) => ({ ...remote.factory(...args),
    async testConnection() { if (during) await during(); if (fails) throw Error('PRIVATE-CREDENTIAL'); },
  }) });
  await configure(subject); await subject.api.testCloudConnection();
  fails = true; await assert.rejects(subject.api.testCloudConnection());
  assert.equal((await subject.api.loadCloudSyncSettings()).connectionTest, null);
  fails = false; during = () => subject.api.lockCloudSync();
  await assert.rejects(subject.api.testCloudConnection(), error => error.code === 'CLOUD_LOCKED');
  assert.equal(subject.sessionStore.value, null);
  const denied = device(remote, 'b', { hasPermission: async () => false });
  await assert.rejects(denied.api.testCloudConnection(profile, secrets), error => error.code === 'CLOUD_PERMISSION');
  assert.equal(remote.calls.length, 0);
});

test('an explicit same-target and same-credential failed retest clears saved proof', async () => {
  const remote = cloud(); let fails = false;
  const subject = device(remote, 'a', { providerFactory: (...args) => ({ ...remote.factory(...args),
    async testConnection() { if (fails) throw Error('offline'); },
  }) });
  await configure(subject); await subject.api.testCloudConnection();
  const verified = (await subject.api.loadCloudSyncSettings()).connectionTest;
  fails = true;
  await assert.rejects(subject.api.testCloudConnection({ ...profile, prefix: 'another-directory' }, secrets));
  assert.deepEqual((await subject.api.loadCloudSyncSettings()).connectionTest, verified, 'an unrelated draft cannot invalidate the saved connection');
  await assert.rejects(subject.api.testCloudConnection(profile, secrets));
  assert.equal((await subject.api.loadCloudSyncSettings()).connectionTest, null);
  assert.equal((await subject.api.loadCloudSyncSettings()).unlocked, true);
});

test('a denied-permission retest clears saved proof before any provider request', async () => {
  for (const explicit of [false, true]) {
    const remote = cloud(); let allowed = true;
    const subject = device(remote, 'a', { hasPermission: async () => allowed });
    await configure(subject); await subject.api.testCloudConnection();
    assert.ok((await subject.api.loadCloudSyncSettings()).connectionTest);
    const calls = remote.calls.length;
    allowed = false;
    await assert.rejects(explicit ? subject.api.testCloudConnection(profile, secrets) : subject.api.testCloudConnection(), { code: 'CLOUD_PERMISSION' });
    const settings = await subject.api.loadCloudSyncSettings();
    assert.equal(settings.connectionTest, null);
    assert.equal(settings.unlocked, true);
    assert.equal(remote.calls.length, calls, 'permission denial must precede provider I/O');
  }
});

test('locking during a test fingerprint cancels session and draft proof without reviving secrets', async () => {
  for (const draft of [false, true]) {
    const remote = cloud(); let armed = false, subject;
    const checkedSigner = { ...signer, async sha256(value) {
      if (armed && JSON.parse(decode(value)).secrets) {
        armed = false;
        await subject.api.lockCloudSync();
      }
      return signer.sha256(value);
    } };
    subject = device(remote, 'a', { signer: checkedSigner });
    if (!draft) await configure(subject);
    armed = true;
    await assert.rejects(draft ? subject.api.testCloudConnection(profile, secrets) : subject.api.testCloudConnection(), { code: 'CLOUD_LOCKED' });
    assert.equal(subject.sessionStore.value, null);
    assert.equal(remote.calls.length, 0, 'cancellation before the probe prevents provider I/O');
    const settings = await configure(subject);
    assert.equal(settings.connectionTest, null, 'a later deliberate save cannot reuse cancelled test proof');
    assert.equal(remote.calls.length, 0, 'saving still performs no connection test');
  }
});

test('locking during a session write keeps an in-flight save or unlock locked', async () => {
  for (const action of ['save', 'unlock']) {
    const remote = cloud(), disk = memory(); let subject, lockDuringWrite = false;
    const sessionStore = { ...disk, async write(value) {
      if (lockDuringWrite) {
        lockDuringWrite = false;
        await subject.api.lockCloudSync();
      }
      await disk.write(value);
    } };
    subject = device(remote, 'a', { sessionStore });
    if (action === 'unlock') { await configure(subject); await subject.api.lockCloudSync(); }
    lockDuringWrite = true;
    await assert.rejects(action === 'save' ? configure(subject) : subject.api.unlockCloudSync(secrets, password), { code: 'CLOUD_LOCKED' });
    assert.equal(disk.value, null, 'a completed stale write cannot retain credentials after locking');
    const settings = await subject.api.loadCloudSyncSettings();
    assert.equal(settings.unlocked, false); assert.equal(settings.connectionTest, null);
    assert.equal(remote.calls.length, 0);
  }
});

test('safe WebDAV status and transport messages survive the public sync boundary without untrusted details', async () => {
  const dav = { provider: 'webdav', endpoint: 'https://cloud.example.test/dav/', prefix: 'covelet' };
  const credentials = { username: 'fake', appPassword: 'fake-app-password' };
  for (const [status, code, text] of [[401, 'CLOUD_AUTH', /用户名和应用密码/], [403, 'CLOUD_FORBIDDEN', /无法访问此目录/], [404, 'CLOUD_NOT_FOUND', /找不到保存目录/]]) {
    const subject = device(cloud(), 'a', { providerFactory: (profile, secrets, options) => createWebdavProvider(profile, secrets, {
      ...options, fetcher: async () => new Response('PRIVATE-RESPONSE', { status }),
    }) });
    await subject.api.saveCloudSyncSettings(dav, credentials, password);
    await assert.rejects(subject.api.testCloudConnection(), error => {
      assert.equal(error.code, code); assert.match(error.message, text); assert.ok(!error.message.includes('PRIVATE-RESPONSE')); return true;
    });
  }
});

test('WebDAV remains the default channel and only OSS retains an individual Beta label; setup exposes independent steps', () => {
  assert.equal(SYNC_PROVIDERS[0], 'webdav'); assert.equal(cloudProviderLabel('webdav'), 'WebDAV');
  assert.equal(cloudProviderLabel('oss'), '阿里云 OSS（Beta）');
  for (const provider of ['r2', 'github', 'gitlab']) assert.doesNotMatch(cloudProviderLabel(provider), /Beta/);
  assert.deepEqual(SYNC_SETUP_STEPS, ['channel', 'connection-test', 'sync-password', 'first-sync']);
});

test('safe adapter transport errors survive the public connection-test boundary for all four storage channels', async () => {
  const profiles = [profile,
    { provider: 'gitlab', endpoint: 'https://git.example.test', project: 'qa/project', branch: 'main', prefix: 'qa' },
    { provider: 'r2', endpoint: 'https://r2.example.test', bucket: 'qa-bucket', prefix: 'qa' },
    { provider: 'oss', endpoint: 'https://oss.example.test', bucket: 'qa-bucket', region: 'cn-hangzhou', prefix: 'qa' }];
  for (const selected of profiles) {
    const credentials = { ...secrets, accessKeyId: 'SYNTHETIC-ACCESS', secretAccessKey: 'SYNTHETIC-SECRET' };
    const subject = device(cloud(), 'a', { providerFactory: (profile, secrets, options) => createCloudProvider(profile, secrets, {
      ...options, fetcher: async () => { throw new TypeError('PRIVATE-TRANSPORT-DETAILS'); },
    }) });
    await subject.api.saveCloudSyncSettings(selected, credentials, password);
    await assert.rejects(subject.api.testCloudConnection(), error => {
      assert.equal(error.code, 'CLOUD_NETWORK'); assert.doesNotMatch(error.message, /PRIVATE|SYNTHETIC|fake-test/); return true;
    });
  }
});
