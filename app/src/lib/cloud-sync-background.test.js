import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { startCloudSyncBackground } from './cloud-sync-background.js';
import { isSyncRecord, SYNC_JOB_KEY } from './sync-data-rules.js';

const target = 'a'.repeat(64);
const id = 'b'.repeat(32);
const sender = { id: 'fixture', url: 'chrome-extension://fixture/newtab.html' };
const pausedJob = { version: 1, id, target, choice: 'remote' };
const saved = { phase: 'saved', conflicts: 0 };

function event() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => [...listeners].map(listener => listener(...args)),
  };
}

function memoryStore(value) {
  return {
    async read() { return structuredClone(value); },
    async write(job) { value = structuredClone(job); },
    async clear() { value = undefined; },
  };
}

function fixture(options = {}) {
  let enabled = options.autoSync ?? false;
  let unlocked = options.unlocked ?? true;
  let alarm;
  let state = { phase: unlocked ? 'idle' : 'locked', conflicts: 0 };
  const calls = [], broadcasts = [];
  const statusChanged = event(), settingsChanged = event();
  const store = options.store || memoryStore();
  const extension = {
    runtime: { id: 'fixture', getURL: () => 'chrome-extension://fixture/', onMessage: event(), onStartup: event(), onInstalled: event(),
      async sendMessage(message) { broadcasts.push(message); } },
    alarms: { onAlarm: event(), async get() { return alarm; }, async create(name, info) { alarm = { name, ...info }; }, async clear() { alarm = undefined; } },
    storage: { onChanged: event() },
  };
  function publish(next) { state = next; statusChanged.emit(next); }
  async function run(choice, syncOptions) {
    calls.push({ choice, options: syncOptions, job: await store.read() });
    publish({ phase: 'syncing', conflicts: 0 });
    if (options.reject) throw Error('Synthetic execution failure');
    const result = await (typeof options.result === 'function' ? options.result(choice) : options.result || saved);
    publish(result);
    return result;
  }
  const controller = {
    async loadCloudSyncSettings() { return { configured: true, unlocked, autoSync: enabled }; },
    async getCloudSyncTarget() { return options.target || target; },
    getCloudSyncStatus: () => state,
    subscribeCloudSyncStatus(listener) { statusChanged.addListener(listener); return () => statusChanged.removeListener(listener); },
    syncCloudNow: options => run(null, options),
    resolveCloudSyncConflicts: run,
  };
  const stop = startCloudSyncBackground(controller, {
    extension, store, uuid: options.uuid || (() => id),
    subscribeSettings(listener) { settingsChanged.addListener(listener); return () => settingsChanged.removeListener(listener); },
  });
  return { store, extension, calls, broadcasts, stop, get alarm() { return alarm; },
    run(choice) { return new Promise(resolve => extension.runtime.onMessage.emit({ type: 'covelet:sync:run', choice }, sender, resolve)); },
    unlock() { unlocked = true; extension.storage.onChanged.emit({ 'covelet.cloud.session.v1': { newValue: {} } }, 'session'); },
    enableAutoSync() { enabled = true; settingsChanged.emit(); },
  };
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await condition()) return;
    await setImmediate();
  }
  assert.fail('Expected the background operation to settle');
}

test('the worker persists a single device-only task and alarm before sending a manual sync', async t => {
  const terminal = Promise.withResolvers();
  const worker = fixture({ result: terminal.promise });
  t.after(worker.stop);
  const first = worker.run(), duplicate = worker.run();
  await waitFor(() => worker.calls.length === 1);
  assert.deepEqual(worker.calls[0], { choice: null, options: { taskId: id, expectedTarget: target }, job: { ...pausedJob, choice: null } });
  assert.ok(worker.alarm);
  assert.equal(isSyncRecord('preferences', SYNC_JOB_KEY), false);
  terminal.resolve(saved);
  assert.deepEqual(await Promise.all([first, duplicate]), [saved, saved]);
  await waitFor(() => !worker.alarm);
  assert.equal(await worker.store.read(), undefined);
  assert.deepEqual(worker.broadcasts.map(message => message.status.phase), ['syncing', 'saved']);
});

test('a restarted locked browser resumes the same bulk choice after session unlock', async t => {
  const worker = fixture({ unlocked: false, store: memoryStore(pausedJob) });
  t.after(worker.stop);
  await setImmediate();
  assert.deepEqual(worker.calls, []);
  assert.deepEqual(await worker.store.read(), pausedJob);
  assert.equal(worker.alarm, undefined);
  worker.unlock();
  await waitFor(async () => worker.calls.length === 1 && !await worker.store.read());
  assert.deepEqual(worker.calls[0], { choice: 'remote', options: { taskId: id, expectedTarget: target }, job: pausedJob });
});

test('a published local choice retains the same worker task until deferred cleanup completes', async t => {
  let attempts = 0;
  const worker = fixture({ result: () => ({ ...saved, cleanup: attempts++ === 0 ? 'deferred' : 'indexes-cleaned' }) });
  t.after(worker.stop);
  assert.deepEqual(await worker.run('local'), { ...saved, cleanup: 'deferred' });
  const job = { ...pausedJob, choice: 'local' };
  assert.deepEqual(await worker.store.read(), job);
  assert.equal(worker.calls.length, 1);
  worker.extension.alarms.onAlarm.emit(worker.alarm);
  await waitFor(async () => worker.calls.length === 2 && !await worker.store.read());
  assert.deepEqual(worker.calls[1], { choice: 'local', options: { taskId: id, expectedTarget: target }, job });
});

test('the worker drops a job for a changed target and ignores untrusted messages', async t => {
  const worker = fixture({ target: 'f'.repeat(64), store: memoryStore(pausedJob) });
  t.after(worker.stop);
  await waitFor(async () => !await worker.store.read());
  assert.deepEqual(worker.calls, []);
  const respond = () => assert.fail('Untrusted messages must not receive a response');
  worker.extension.runtime.onMessage.emit({ type: 'covelet:sync:run' }, { ...sender, url: 'https://example.com' }, respond);
  worker.extension.runtime.onMessage.emit({ type: 'covelet:sync:run', choice: 'both' }, sender, respond);
  await setImmediate();
  assert.deepEqual(worker.calls, []);
});

test('only opted-in automatic sync runs on alarms and pauses at a whole-data conflict', async t => {
  const worker = fixture({ result: { phase: 'conflict', conflicts: 2 } });
  t.after(worker.stop);
  worker.enableAutoSync();
  await waitFor(() => worker.alarm);
  assert.deepEqual(worker.calls, []);
  worker.extension.alarms.onAlarm.emit(worker.alarm);
  await waitFor(() => worker.calls.length === 1 && !worker.alarm);
  assert.equal(await worker.store.read(), undefined);
});

test('an unexpected controller exception ends the task without an immediate retry loop', async t => {
  const worker = fixture({ reject: true });
  t.after(worker.stop);
  assert.deepEqual(await worker.run(), { phase: 'error', code: 'DATA_SYNC_LOCAL' });
  await waitFor(() => !worker.alarm);
  assert.equal(await worker.store.read(), undefined);
  assert.equal(worker.calls.length, 1);
});

test('a choice received during the preceding sync runs in a separate persisted task', async t => {
  const sync = Promise.withResolvers();
  const nextId = 'c'.repeat(32);
  const ids = [id, nextId];
  const worker = fixture({ uuid: () => ids.shift(), result: choice => choice ? saved : sync.promise });
  t.after(worker.stop);
  const running = worker.run();
  await waitFor(() => worker.calls.length === 1);
  const selected = worker.run('remote');
  sync.resolve({ phase: 'conflict', conflicts: 2 });
  assert.equal((await running).phase, 'conflict');
  assert.equal((await selected).phase, 'saved');
  assert.deepEqual(worker.calls.map(({ choice, job }) => [choice, job.id]), [[null, id], ['remote', nextId]]);
});

test('a transport timeout waits for the alarm and resumes the exact same job', async t => {
  let attempts = 0;
  const timeout = { phase: 'error', code: 'CLOUD_TIMEOUT' };
  const worker = fixture({ result: () => attempts++ === 0 ? timeout : saved });
  t.after(worker.stop);
  assert.deepEqual(await worker.run('remote'), timeout);
  await setImmediate();
  assert.equal(worker.calls.length, 1);
  assert.deepEqual(await worker.store.read(), pausedJob);
  worker.extension.alarms.onAlarm.emit(worker.alarm);
  await waitFor(async () => worker.calls.length === 2 && !await worker.store.read());
  assert.deepEqual(worker.calls[1], worker.calls[0]);
});

test('a queued choice does not immediately retry an interrupted sync', async t => {
  const sync = Promise.withResolvers();
  const worker = fixture({ result: sync.promise });
  t.after(worker.stop);
  const running = worker.run();
  await waitFor(() => worker.calls.length === 1);
  const choice = worker.run('remote');
  const timeout = { phase: 'error', code: 'CLOUD_TIMEOUT' };
  sync.resolve(timeout);
  assert.deepEqual(await Promise.all([running, choice]), [timeout, timeout]);
  assert.equal(worker.calls.length, 1);
  assert.deepEqual(await worker.store.read(), { ...pausedJob, choice: null });
});
