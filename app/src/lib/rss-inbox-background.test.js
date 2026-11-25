import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { RSS_ALARM } from './rss-inbox.js';
import { startRssInboxBackground } from './rss-inbox-background.js';

function event() {
  const listeners = new Set();
  return { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => [...listeners].map((listener) => listener(...args)), get size() { return listeners.size; } };
}
const sender = { id: 'fixture', url: 'chrome-extension://fixture/newtab.html' };
function fixture(options = {}) {
  const calls = [], errors = [], status = { feeds: [], items: [], revision: 1 };
  const extension = { alarms: { onAlarm: event() }, runtime: { id: 'fixture', getURL: () => 'chrome-extension://fixture/', onMessage: event(), onStartup: event(), onInstalled: event() } };
  const controller = Object.fromEntries(['restoreSchedule', 'refresh', 'refreshDue'].map((name) => [name, async (id) => { calls.push([name, id]); return options[name] ? options[name](id) : status; }]));
  const stop = startRssInboxBackground(controller, { extension, ready: options.ready, reportError: (code) => errors.push(code) });
  return { calls, errors, extension, stop, status, request: (message) => new Promise((resolve) => extension.runtime.onMessage.emit(message, sender, resolve)) };
}

test('RSS worker registers synchronously, restores only schedules and awaits shared language initialization', async (t) => {
  let release; const ready = new Promise((resolve) => { release = resolve; }); const f = fixture({ ready }); t.after(f.stop);
  assert.equal(f.extension.alarms.onAlarm.size, 1); assert.equal(f.extension.runtime.onMessage.size, 1);
  const pending = f.extension.alarms.onAlarm.emit({ name: RSS_ALARM }); await setImmediate(); assert.equal(f.calls.length, 0);
  release(); await Promise.all(pending); await setImmediate();
  assert.deepEqual(f.calls, [['restoreSchedule', undefined], ['refreshDue', undefined]]);
});

test('only the exact alarm fetches due subscriptions and restart/installation only restore scheduling', async (t) => {
  const f = fixture(); t.after(f.stop); await setImmediate();
  f.extension.alarms.onAlarm.emit({ name: `${RSS_ALARM}-other` }); f.extension.alarms.onAlarm.emit({ name: 'covelet:backup:due' });
  await Promise.all(f.extension.runtime.onStartup.emit()); await Promise.all(f.extension.runtime.onInstalled.emit());
  assert.deepEqual(f.calls.map(([name]) => name), ['restoreSchedule', 'restoreSchedule', 'restoreSchedule']);
  await Promise.all(f.extension.alarms.onAlarm.emit({ name: RSS_ALARM })); assert.equal(f.calls.at(-1)[0], 'refreshDue');
  f.stop(); assert.equal(f.extension.alarms.onAlarm.size, 0); assert.equal(f.extension.runtime.onMessage.size, 0);
});

test('explicit extension messages refresh the selected source and keep the response channel open', async (t) => {
  const f = fixture(); t.after(f.stop); await setImmediate();
  const response = await f.request({ type: 'covelet:rss:refresh', feedId: 'feed-1' });
  assert.deepEqual(response, { ok: true, status: f.status }); assert.deepEqual(f.calls.at(-1), ['refresh', 'feed-1']);
  await f.request({ type: 'covelet:rss:refresh' }); assert.deepEqual(f.calls.at(-1), ['refresh', undefined]);
});

test('RSS runtime accepts only extension pages and a bounded feed identity, never a remote URL or secret parameter', async (t) => {
  const f = fixture(); t.after(f.stop); await setImmediate(); let replies = 0;
  for (const invalid of [{ id: 'other', url: sender.url }, { id: sender.id, url: 'https://evil.example/' }, { id: sender.id },
    { id: sender.id, url: 'chrome-extension://fixture.evil/newtab.html' }]) {
    assert.deepEqual(f.extension.runtime.onMessage.emit({ type: 'covelet:rss:refresh' }, invalid, () => replies++), [undefined]);
  }
  assert.equal(replies, 0);
  for (const input of [{ url: 'https://unsubscribed.example/' }, { password: 'PRIVATE' }, { feedId: {} }, { feedId: 'x'.repeat(101) }]) {
    const reply = await f.request({ type: 'covelet:rss:refresh', ...input }); assert.equal(reply.ok, false); assert.equal(reply.error.code, 'RSS_MISSING');
  }
  assert.equal(f.calls.length, 1);
});

test('unexpected worker failures remain observable and never expose raw credentials or network messages', async (t) => {
  const f = fixture({ refresh: async () => { throw Error('PRIVATE password'); }, refreshDue: async () => { throw Object.assign(Error('PRIVATE URL'), { code: 'RSS_STORAGE' }); } }); t.after(f.stop); await setImmediate();
  const reply = await f.request({ type: 'covelet:rss:refresh' }); assert.equal(reply.ok, false); assert.equal(reply.error.code, 'RSS_NETWORK');
  assert.doesNotMatch(JSON.stringify(reply), /PRIVATE|password/);
  await Promise.all(f.extension.alarms.onAlarm.emit({ name: RSS_ALARM })); assert.deepEqual(f.errors, ['RSS_NETWORK', 'RSS_STORAGE']);
  const early = fixture({ ready: Promise.reject(Error('PRIVATE initialization')) }); t.after(early.stop); await setImmediate();
  assert.equal(early.calls.length, 0); assert.deepEqual(early.errors, ['RSS_NETWORK']);
});
