import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createScheduledBackups, SCHEDULED_BACKUP_ALARM } from './scheduled-backup.js';
import { createScheduledBackupStore } from './scheduled-backup-store.js';
import { decryptCompleteBackup, isEncryptedBackup, PASSWORD_BACKUP_LIMITS } from './password-backup.js';

const password = 'separate scheduled backup password';
const DAY = 86400000, start = 1795478400000;
const missing = () => new DOMException('Synthetic missing file', 'NotFoundError');
const cloneState = (state) => state ? { ...structuredClone({ ...state, directory: null }), directory: state.directory } : null;
function memoryStore() {
  let state = null, failNextWrite = false;
  return {
    async read() { return cloneState(state); },
    async write(next) {
      if (failNextWrite) { failNextWrite = false; throw new DOMException('Synthetic IndexedDB full', 'QuotaExceededError'); }
      state = cloneState(next);
    },
    get value() { return cloneState(state); }, set failNextWrite(value) { failNextWrite = value; },
  };
}
function directory(name = 'Backups') {
  const files = new Map(), writes = [], removals = [];
  let permission = 'granted', writeError, closeError, removeError, corrupt = false, aborted = 0;
  const handle = {
    kind: 'directory', name,
    async isSameEntry(other) { return other === handle; },
    async queryPermission(info) { assert.deepEqual(info, { mode: 'readwrite' }); return permission; },
    async requestPermission() { assert.fail('Background controller never requests permission.'); },
    async getFileHandle(filename, { create = false } = {}) {
      if (!files.has(filename)) { if (!create) throw missing(); files.set(filename, new Blob()); }
      return {
        kind: 'file', name: filename,
        async getFile() { if (!files.has(filename)) throw missing(); return files.get(filename); },
        async createWritable(options) {
          assert.equal(options.mode, 'exclusive'); assert.equal(options.keepExistingData, false);
          let staged;
          return {
            async write(blob) {
              assert.ok(blob instanceof Blob); assert.equal(await isEncryptedBackup(blob), true, 'The filesystem only receives encrypted .covelet bytes.');
              writes.push(blob);
              if (writeError) throw writeError;
              staged = blob;
            },
            async close() {
              if (closeError) throw closeError;
              if (corrupt) { const bytes = new Uint8Array(await staged.arrayBuffer()); bytes[bytes.length - 1] ^= 1; files.set(filename, new Blob([bytes])); }
              else files.set(filename, staged);
            },
            async abort() { aborted++; },
          };
        },
      };
    },
    async removeEntry(filename) {
      removals.push(filename); if (removeError) throw removeError;
      if (!files.has(filename)) throw missing(); files.delete(filename);
    },
  };
  return { handle, files, writes, removals, get aborted() { return aborted; },
    set permission(value) { permission = value; }, set writeError(value) { writeError = value; }, set closeError(value) { closeError = value; },
    set removeError(value) { removeError = value; }, set corrupt(value) { corrupt = value; } };
}
function fixture(options = {}) {
  const store = options.store || memoryStore(), dir = options.dir || directory();
  let clock = start, count = 0, alarm;
  const alarms = { async get(name) { assert.equal(name, SCHEDULED_BACKUP_ALARM); return alarm; },
    async create(name, info) { assert.equal(name, SCHEDULED_BACKUP_ALARM); alarm = { name, scheduledTime: info.when }; },
    async clear(name) { assert.equal(name, SCHEDULED_BACKUP_ALARM); alarm = undefined; } };
  const capture = options.capture || (async () => new Blob([JSON.stringify({ format: 'covelet-complete-backup', version: 1,
    hiddenNote: 'PRIVATE-SCHEDULED-BACKUP-CONTENT', sequence: ++count })], { type: 'application/json' }));
  const make = () => createScheduledBackups({ store, alarms, capture, crypto: webcrypto, locks: null, now: () => clock, ...options.controller });
  return { store, dir, alarms, make, api: make(), get alarm() { return alarm; }, loseAlarm() { alarm = undefined; },
    get captures() { return count; }, advance(amount = DAY) { clock += amount; }, get now() { return clock; },
    configure(frequency = 'daily') { return this.api.configure({ directory: dir.handle, password, frequency }); } };
}
const run = (subject) => subject.api.run({ manual: true });

test('four portable encrypted runs keep the newest three managed files and include hidden content without retaining the password', async () => {
  const f = fixture(); await f.configure();
  assert.equal(f.alarm.scheduledTime, start + DAY); assert.equal(f.captures, 0);
  const owned = [];
  for (let index = 1; index <= 4; index++) {
    f.advance(); const status = await run(f); assert.equal(status.phase, 'saved');
    const latest = status.files.at(-1); owned.push(latest.name);
    const blob = f.dir.files.get(latest.name), plain = JSON.parse(await (await decryptCompleteBackup(blob, password)).text());
    assert.equal(plain.hiddenNote, 'PRIVATE-SCHEDULED-BACKUP-CONTENT'); assert.equal(plain.sequence, index);
    await assert.rejects(decryptCompleteBackup(blob, 'incorrect backup password'), { code: 'BACKUP_DECRYPT_FAILED' });
  }
  const status = await f.api.getSettings();
  assert.equal(status.files.length, 3); assert.equal(f.dir.files.size, 3);
  assert.deepEqual(f.dir.removals, [owned[0]]); assert.deepEqual(status.files.map((file) => file.name), owned.slice(1));
  assert.doesNotMatch(JSON.stringify(status), /CryptoKey|key|salt|directoryHandle|separate scheduled backup password|PRIVATE-SCHEDULED/);
  const persisted = f.store.value;
  assert.equal(persisted.key.extractable, false); assert.equal(persisted.key.algorithm.name, 'AES-GCM');
  assert.deepEqual(persisted.key.usages, ['encrypt']); await assert.rejects(webcrypto.subtle.exportKey('raw', persisted.key));
  assert.doesNotMatch(JSON.stringify(persisted), /separate scheduled backup password|PRIVATE-SCHEDULED/);
  const headers = await Promise.all(f.dir.writes.map(async (blob) => new Uint8Array(await blob.slice(0, 48).arrayBuffer())));
  for (const header of headers) assert.deepEqual(header.slice(20, 36), persisted.salt);
  assert.equal(new Set(headers.map((header) => Buffer.from(header.slice(36, 48)).toString('hex'))).size, 4);
});

test('a restored controller uses its cloned nonextractable key and alarm without saving a password or capturing before due', async () => {
  const f = fixture(); await f.configure('weekly');
  const key = f.store.value.key; assert.notEqual(f.store.value.key, key, 'Native CryptoKey structured cloning is exercised by the store fixture.');
  f.loseAlarm(); f.api = f.make(); await f.api.restoreSchedule();
  assert.equal(f.alarm.scheduledTime, start + 7 * DAY);
  await f.api.run({ manual: false }); assert.equal(f.captures, 0);
  f.advance(7 * DAY); await f.api.run({ manual: false });
  assert.equal(f.captures, 1); const latest = (await f.api.getSettings()).files[0];
  assert.equal(JSON.parse(await (await decryptCompleteBackup(f.dir.files.get(latest.name), password)).text()).sequence, 1);
});

test('directory permission loss pauses without a prompt or file mutation and exposes a persistent safe error', async () => {
  const f = fixture(); await f.configure(); for (let index = 0; index < 3; index++) { f.advance(); await run(f); }
  const before = [...f.dir.files.entries()], writes = f.dir.writes.length;
  f.dir.permission = 'prompt';
  await assert.rejects(run(f), { code: 'SCHEDULED_BACKUP_PERMISSION' });
  const status = await f.make().getSettings();
  assert.equal(status.phase, 'error'); assert.equal(status.lastError.code, 'SCHEDULED_BACKUP_PERMISSION'); assert.equal(status.permission, 'prompt');
  assert.equal(f.dir.writes.length, writes); assert.deepEqual([...f.dir.files.entries()], before); assert.equal(f.dir.removals.length, 0);
  f.dir.permission = 'granted'; await f.configure(); assert.equal((await f.api.getSettings()).files.length, 3);
});

test('write, disk quota and close failures retain the prior three good files and never write plaintext', async (t) => {
  for (const kind of ['write', 'quota', 'close']) await t.test(kind, async () => {
    const f = fixture(); await f.configure(); for (let index = 0; index < 3; index++) { f.advance(); await run(f); }
    const before = (await f.api.getSettings()).files, bytes = new Map(f.dir.files);
    if (kind === 'close') f.dir.closeError = Error('Synthetic private filesystem path must not appear');
    else f.dir.writeError = kind === 'quota' ? new DOMException('Synthetic disk full', 'QuotaExceededError') : Error('Synthetic private filesystem path must not appear');
    f.advance(); await assert.rejects(run(f), { code: kind === 'quota' ? 'SCHEDULED_BACKUP_QUOTA' : 'SCHEDULED_BACKUP_WRITE' });
    const status = await f.api.getSettings(); assert.equal(status.phase, 'error'); assert.equal(status.files.length, 3);
    for (const file of before) assert.equal(f.dir.files.get(file.name), bytes.get(file.name));
    assert.equal(f.dir.removals.length, 0); assert.ok(f.dir.aborted > 0);
    assert.doesNotMatch(status.lastError.message, /private|Synthetic|path/);
  });
});

test('a corrupted readback is not counted as a successful backup and leaves previous files intact', async () => {
  const f = fixture(); await f.configure(); for (let index = 0; index < 3; index++) { f.advance(); await run(f); }
  const good = new Map(f.dir.files); f.dir.corrupt = true; f.advance();
  await assert.rejects(run(f), { code: 'SCHEDULED_BACKUP_VERIFY' });
  assert.equal((await f.api.getSettings()).files.length, 3); assert.equal(f.dir.removals.length, 0);
  for (const [name, blob] of good) assert.equal(f.dir.files.get(name), blob);
});

test('unrelated files and modified formerly owned backups are never deleted by rotation', async () => {
  const f = fixture(); await f.configure(); for (let index = 0; index < 3; index++) { f.advance(); await run(f); }
  const oldest = (await f.api.getSettings()).files[0];
  const modified = new Blob(['USER-MODIFIED-BACKUP']); f.dir.files.set(oldest.name, modified);
  const unrelated = new Blob(['DO-NOT-DELETE']);
  f.dir.files.set('Covelet-complete-backup.covelet', unrelated);
  f.dir.files.set(`Covelet-auto-${'f'.repeat(32)}-${start}-${'e'.repeat(32)}.covelet`, unrelated);
  f.advance(); await assert.rejects(run(f), { code: 'SCHEDULED_BACKUP_CHANGED' });
  assert.equal(f.dir.files.get(oldest.name), modified); assert.equal(f.dir.removals.length, 0);
  assert.equal(f.dir.files.get('Covelet-complete-backup.covelet'), unrelated);
  assert.equal((await f.api.getSettings()).files.length, 3, 'The changed file is disowned, rather than treated as deletable backup data.');
});

test('an interrupted four-file ledger is repaired before any further capture and resumes after deletion permission recovers', async () => {
  const f = fixture(); await f.configure(); for (let index = 0; index < 3; index++) { f.advance(); await run(f); }
  f.dir.removeError = new DOMException('Synthetic revoked delete permission', 'NotAllowedError'); f.advance();
  await assert.rejects(run(f), { code: 'SCHEDULED_BACKUP_PERMISSION' });
  assert.equal((await f.api.getSettings()).files.length, 4); assert.equal(f.dir.files.size, 4);
  const captures = f.captures; f.api = f.make();
  await assert.rejects(run(f), { code: 'SCHEDULED_BACKUP_PERMISSION' });
  assert.equal(f.captures, captures, 'No fifth file is prepared while pruning remains unfinished.');
  f.dir.removeError = null; await run(f);
  assert.equal(f.dir.files.size, 3); assert.equal((await f.api.getSettings()).files.length, 3);
});

test('a complete file with an interrupted ledger commit is recovered before the next backup', async () => {
  const f = fixture(); await f.configure(); await run(f);
  const state = f.store.value, existing = state.files[0];
  state.files = []; state.pending = { file: existing }; state.phase = 'running'; await f.store.write(state);
  f.api = f.make(); f.advance(); await run(f);
  const settings = await f.api.getSettings(); assert.equal(settings.files.length, 2);
  assert.ok(settings.files.some((file) => file.name === existing.name)); assert.equal(f.store.value.pending, null);
});

test('capture limits and local persistence failures stop before creating any filesystem backup', async (t) => {
  await t.test('capture limit', async () => {
    const f = fixture({ capture: async () => new Blob([new Uint8Array(PASSWORD_BACKUP_LIMITS.plaintext + 1)]) }); await f.configure();
    await assert.rejects(run(f), { code: 'SCHEDULED_BACKUP_CAPACITY' }); assert.equal(f.dir.files.size, 0);
  });
  await t.test('local store failure', async () => {
    const f = fixture(); await f.configure(); f.store.failNextWrite = true;
    await assert.rejects(run(f), { code: 'SCHEDULED_BACKUP_QUOTA' }); assert.equal(f.dir.files.size, 0);
    assert.equal((await f.api.getSettings()).phase, 'error');
  });
});

test('directory changes establish new ownership and disabling clears retained handles and keys without deleting backups', async () => {
  const f = fixture(); await f.configure(); await run(f);
  const previousOwner = f.store.value.owner, original = new Map(f.dir.files);
  await f.configure('weekly'); assert.equal(f.store.value.owner, previousOwner); assert.equal((await f.api.getSettings()).files.length, 1);
  const another = directory('Other backups');
  await f.api.configure({ directory: another.handle, frequency: 'daily', password });
  assert.notEqual(f.store.value.owner, previousOwner); assert.equal((await f.api.getSettings()).files.length, 0);
  assert.deepEqual([...f.dir.files], [...original]);
  await run(f); const retained = new Map(another.files); await f.api.disable();
  assert.equal(f.alarm, undefined); assert.equal(f.store.value.key, null); assert.equal(f.store.value.directory, null); assert.equal(f.store.value.salt, null);
  assert.deepEqual([...another.files], [...retained]); assert.equal((await f.api.getSettings()).enabled, false);
});

test('concurrent manual requests serialize to one writer and native-store failures have no fallback', async () => {
  const f = fixture(); await f.configure();
  await Promise.all([run(f), run(f), run(f), run(f)]);
  assert.equal(f.captures, 4); assert.equal(f.dir.files.size, 3);
  const unavailable = createScheduledBackupStore({ indexedDB: null });
  await assert.rejects(unavailable.read(), { code: 'SCHEDULED_BACKUP_STORAGE' });
  await assert.rejects(unavailable.write({ password: 'do-not-persist' }), { code: 'SCHEDULED_BACKUP_STORAGE' });
});

test('clock rollback never deletes the newest backup because verified append order controls retention', async () => {
  const f = fixture(); await f.configure();
  const names = [];
  for (let index = 0; index < 3; index++) { f.advance(); names.push((await run(f)).files.at(-1).name); }
  f.advance(-2 * DAY);
  const result = await run(f), newest = result.files.at(-1);
  assert.ok(f.dir.files.has(newest.name)); assert.deepEqual(result.files.slice(0, 2).map((file) => file.name), names.slice(1));
  assert.deepEqual(f.dir.removals, [names[0]]);
  assert.equal(JSON.parse(await (await decryptCompleteBackup(f.dir.files.get(newest.name), password)).text()).sequence, 4);
});

test('worker restart exposes interrupted work and missing directory grants instead of reporting false completion', async () => {
  const f = fixture(); await f.configure(); await run(f);
  const state = f.store.value; state.phase = 'running'; await f.store.write(state);
  f.api = f.make();
  const restored = await f.api.restoreSchedule();
  assert.equal(restored.phase, 'error'); assert.equal(restored.lastError.code, 'SCHEDULED_BACKUP_INTERRUPTED');
  assert.equal(f.alarm.scheduledTime, f.now + 1000); assert.equal(f.captures, 1);
  f.dir.permission = 'prompt';
  await assert.rejects(f.api.restoreSchedule(), { code: 'SCHEDULED_BACKUP_PERMISSION' });
  assert.equal((await f.api.getSettings()).lastError.code, 'SCHEDULED_BACKUP_PERMISSION');
  assert.equal(f.captures, 1); assert.equal(f.dir.files.size, 1);
});
