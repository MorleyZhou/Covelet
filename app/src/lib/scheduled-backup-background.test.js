import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { startScheduledBackupBackground, SCHEDULED_BACKUP_ALARM } from './scheduled-backup-background.js';

function event() {
  const listeners = new Set();
  return { addListener: (callback) => listeners.add(callback), removeListener: (callback) => listeners.delete(callback),
    emit: (...args) => [...listeners].map((callback) => callback(...args)), get size() { return listeners.size; } };
}
const sender = { id: 'fixture', url: 'chrome-extension://fixture/newtab.html' };
const status = { enabled: true, frequency: 'daily', directoryName: 'Backups', lastSuccess: 10, nextDue: 20,
  phase: 'ready', permission: 'granted', lastError: null, files: [{ name: 'backup.covelet', size: 123, createdAt: 10 }] };
function fixture(options = {}) {
  const calls = [], errors = [], broadcasts = [];
  const extension = { alarms: { onAlarm: event() }, runtime: { id: 'fixture', getURL: () => 'chrome-extension://fixture/',
    onMessage: event(), onStartup: event(), onInstalled: event(), async sendMessage(message) { broadcasts.push(message); } } };
  const controller = {
    async restoreSchedule() { calls.push(['restore']); return options.restore ? options.restore() : status; },
    async run(input) { calls.push(['run', input]); return options.run ? options.run(input) : status; },
    async getSettings() { return options.getSettings ? options.getSettings() : status; },
  };
  const stop = startScheduledBackupBackground(controller, { extension, ready: options.ready,
    reportError(error) { errors.push(error); } });
  return { calls, errors, broadcasts, extension, stop, request(message, requestSender = sender) {
    return new Promise((resolve) => { extension.runtime.onMessage.emit(message, requestSender, resolve); });
  } };
}
const flush = () => setImmediate();

test('fresh workers register alarm and runtime listeners before async initialization and restore missed schedules', async (t) => {
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const worker = fixture({ ready }); t.after(worker.stop);
  assert.equal(worker.extension.alarms.onAlarm.size, 1); assert.equal(worker.extension.runtime.onMessage.size, 1);
  assert.equal(worker.extension.runtime.onStartup.size, 1); assert.equal(worker.extension.runtime.onInstalled.size, 1);
  const requests = worker.extension.alarms.onAlarm.emit({ name: SCHEDULED_BACKUP_ALARM });
  await flush(); assert.equal(worker.calls.length, 0);
  release(); await Promise.all(requests); await flush();
  assert.deepEqual(worker.calls, [['restore'], ['run', { manual: false }]]);
});

test('startup and installation restore schedules and a restarted worker restores without a page timer', async () => {
  const first = fixture(); await flush();
  await Promise.all(first.extension.runtime.onStartup.emit());
  await Promise.all(first.extension.runtime.onInstalled.emit());
  assert.equal(first.calls.filter(([name]) => name === 'restore').length, 3);
  first.stop();
  assert.equal(first.extension.alarms.onAlarm.size, 0); assert.equal(first.extension.runtime.onMessage.size, 0);
  first.extension.alarms.onAlarm.emit({ name: SCHEDULED_BACKUP_ALARM }); await flush();
  assert.equal(first.calls.length, 3);
  const restarted = fixture(); await flush(); assert.deepEqual(restarted.calls, [['restore']]); restarted.stop();
});

test('only the exact backup alarm runs automatically while explicit run messages are manual', async (t) => {
  const worker = fixture(); t.after(worker.stop); await flush();
  worker.extension.alarms.onAlarm.emit({ name: 'covelet:sync:resume' });
  worker.extension.alarms.onAlarm.emit({ name: 'covelet:backup:due-other' }); await flush();
  assert.equal(worker.calls.length, 1);
  const reply = await worker.request({ type: 'covelet:backup:run' });
  assert.equal(reply.ok, true); assert.deepEqual(reply.status, status);
  assert.deepEqual(worker.calls.at(-1), ['run', { manual: true }]);
  const refresh = await worker.request({ type: 'covelet:backup:refresh' });
  assert.equal(refresh.ok, true); assert.deepEqual(worker.calls.at(-1), ['restore']);
});

test('runtime requests reject foreign senders and any capability, password or extra message parameter', async (t) => {
  const worker = fixture(); t.after(worker.stop); await flush();
  let replies = 0;
  for (const requestSender of [{ id: 'other', url: sender.url }, { id: sender.id, url: 'https://evil.test/' }, { id: sender.id },
    { id: sender.id, url: 'chrome-extension://fixture.evil/newtab.html' }]) {
    const results = worker.extension.runtime.onMessage.emit({ type: 'covelet:backup:run' }, requestSender, () => { replies++; });
    assert.deepEqual(results, [undefined]);
  }
  assert.equal(replies, 0); assert.equal(worker.calls.length, 1);
  for (const extra of [{ password: 'PRIVATE' }, { handle: {} }, { key: {} }, { manual: true }]) {
    const response = await worker.request({ type: 'covelet:backup:run', ...extra });
    assert.equal(response.ok, false); assert.equal(response.error.code, 'SCHEDULED_BACKUP_INVALID_REQUEST');
  }
  assert.equal(worker.calls.length, 1);
});

test('the response boundary never serializes key material, handles, passwords or unrelated controller fields', async (t) => {
  const unsafe = { ...status, password: 'PRIVATE', key: { algorithm: 'AES-GCM' }, salt: [1], handle: { name: 'PRIVATE' },
    files: [{ ...status.files[0], handle: { secret: 'PRIVATE' } }], lastError: { code: 'SAFE', message: 'safe', at: 1, input: 'PRIVATE' } };
  const worker = fixture({ run: async () => unsafe }); t.after(worker.stop); await flush();
  const response = await worker.request({ type: 'covelet:backup:run' });
  assert.equal(response.ok, true); assert.doesNotMatch(JSON.stringify(response), /PRIVATE|algorithm|handle|password|salt/);
  assert.deepEqual(response.status.files, status.files); assert.deepEqual(response.status.lastError, { code: 'SAFE', message: 'safe', at: 1 });
});

test('recorded scheduler failures and unexpected initialization errors stay observable without exposing raw errors', async (t) => {
  const worker = fixture({ run: async () => { throw Object.assign(Error('PRIVATE password or filesystem path'), { code: 'BACKUP_PERMISSION_REQUIRED' }); } });
  t.after(worker.stop); await flush();
  const response = await worker.request({ type: 'covelet:backup:run' });
  assert.equal(response.ok, false); assert.equal(response.error.code, 'BACKUP_PERMISSION_REQUIRED');
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE|filesystem/);
  assert.deepEqual(worker.errors, [{ operation: 'run', code: 'BACKUP_PERMISSION_REQUIRED' }]);
  const early = fixture({ ready: Promise.reject(Error('PRIVATE startup failure')) }); t.after(early.stop); await flush();
  assert.deepEqual(early.errors, [{ operation: 'refresh', code: 'SCHEDULED_BACKUP_FAILED' }]);
  assert.equal(early.calls.length, 0);
});

test('simultaneous restore wakeups share initialization and async message channels stay open until completion', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = fixture({ restore: async () => { await gate; return status; } }); t.after(worker.stop);
  const replies = [], returns = worker.extension.runtime.onMessage.emit({ type: 'covelet:backup:refresh' }, sender, (value) => replies.push(value));
  worker.extension.runtime.onStartup.emit(); worker.extension.runtime.onInstalled.emit(); await flush();
  assert.deepEqual(returns, [true]); assert.equal(worker.calls.length, 1); assert.equal(replies.length, 0);
  release(); await flush(); assert.equal(replies[0].ok, true); assert.deepEqual(replies[0].status, status);
});

test('automatic alarm failures broadcast the persisted safe status without private capabilities or raw filesystem errors', async (t) => {
  const persisted = { ...status, phase: 'error', lastError: { code: 'SCHEDULED_BACKUP_PERMISSION', message: 'Choose the directory again.', at: 40 },
    key: { private: 'PRIVATE' }, password: 'PRIVATE', directory: { private: 'PRIVATE' } };
  const worker = fixture({ run: async () => { throw Object.assign(Error('PRIVATE filesystem path'), { code: 'SCHEDULED_BACKUP_PERMISSION' }); },
    getSettings: async () => persisted }); t.after(worker.stop); await flush();
  await Promise.all(worker.extension.alarms.onAlarm.emit({ name: SCHEDULED_BACKUP_ALARM }));
  const event = worker.broadcasts.at(-1);
  assert.equal(event.type, 'covelet:backup:status'); assert.equal(event.status.phase, 'error');
  assert.deepEqual(event.status.lastError, persisted.lastError);
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE|filesystem|directory":|password|"key"/);
  assert.deepEqual(worker.errors, [{ operation: 'run', code: 'SCHEDULED_BACKUP_PERMISSION' }]);
});

test('unreadable failure state still emits a bounded generic error and absent UI receivers do not fail backups', async (t) => {
  const worker = fixture({ run: async () => { throw Error('PRIVATE'); }, getSettings: async () => { throw Error('PRIVATE status'); } });
  t.after(worker.stop); await flush(); await worker.request({ type: 'covelet:backup:run' });
  const fallback = worker.broadcasts.at(-1).status;
  assert.equal(fallback.phase, 'error'); assert.equal(fallback.lastError.code, 'SCHEDULED_BACKUP_FAILED');
  assert.ok(Number.isSafeInteger(fallback.lastError.at)); assert.doesNotMatch(JSON.stringify(fallback), /PRIVATE/);
  worker.extension.runtime.sendMessage = async () => { throw Error('No receiving extension page'); };
  const successful = fixture(); t.after(successful.stop);
  successful.extension.runtime.sendMessage = worker.extension.runtime.sendMessage;
  const response = await successful.request({ type: 'covelet:backup:run' });
  assert.equal(response.ok, true); assert.equal(successful.errors.length, 0);
});
