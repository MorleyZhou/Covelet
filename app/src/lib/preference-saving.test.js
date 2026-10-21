import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreferenceSaver } from './preference-saving.js';

const initial = () => ({ revision: 1, entries: [{ id: 'site-a' }], providers: [], settings: { columns: 8, theme: 'system', gap: 24 } });
function fixture(options = {}) {
  let stored = initial(), writes = 0;
  const saver = createPreferenceSaver({ initial: stored, delay: 60_000,
    read: async () => structuredClone(stored),
    write: async (next, revision) => {
      assert.equal(revision, stored.revision);
      writes++;
      if (options.beforeWrite) await options.beforeWrite(writes);
      stored = { ...next, revision: revision + 1 };
      return stored;
    }, ...options });
  return { saver, get state() { return stored; }, get writes() { return writes; }, external(patch) { stored = { ...stored, ...patch, revision: stored.revision + 1 }; } };
}

test('rapid settings changes coalesce and preserve newer navigation and untouched settings', async () => {
  const f = fixture();
  f.saver.queue({ settings: { columns: 9 } });
  f.saver.queue({ settings: { columns: 10, gap: 28 } });
  f.external({ entries: [{ id: 'new-site' }], settings: { ...f.state.settings, theme: 'dark' } });
  await f.saver.flush();
  assert.equal(f.writes, 1);
  assert.deepEqual(f.state.entries, [{ id: 'new-site' }]);
  assert.deepEqual(f.state.settings, { columns: 10, theme: 'dark', gap: 28 });
});

test('changes made during a write are serialized against the saved revision', async () => {
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const f = fixture({ beforeWrite: async (count) => { if (count === 1) { entered(); await blocked; } } });
  f.saver.queue({ settings: { columns: 9 } });
  const save = f.saver.flush();
  await started;
  f.saver.queue({ settings: { columns: 11 } });
  release();
  await save;
  assert.equal(f.state.settings.columns, 11);
  assert.equal(f.writes, 2);
});

test('a concurrent edit of the same field is never silently overwritten', async () => {
  const f = fixture();
  f.saver.queue({ settings: { columns: 10 } });
  f.external({ settings: { ...f.state.settings, columns: 12 } });
  await assert.rejects(f.saver.flush(), { code: 'PREFERENCE_CONFLICT' });
  assert.equal(f.writes, 0);
  const latest = await f.saver.reload();
  assert.equal(latest.settings.columns, 12);
  f.saver.queue({ settings: { columns: 9 } });
  await f.saver.flush();
  assert.equal(f.state.settings.columns, 9);
});

test('failed writes retain the latest draft for an explicit retry', async () => {
  const f = fixture({ beforeWrite: async (count) => { if (count === 1) throw Error('Disk unavailable'); } });
  f.saver.queue({ settings: { columns: 9 } });
  await assert.rejects(f.saver.flush(), /Disk unavailable/);
  f.saver.queue({ settings: { columns: 10 } });
  await f.saver.retry();
  assert.equal(f.state.settings.columns, 10);
});

test('flushing on close saves pending preferences without waiting for the debounce', async () => {
  const f = fixture();
  f.saver.queue({ settings: { theme: 'light' } });
  await f.saver.flush();
  assert.equal(f.state.settings.theme, 'light');
  assert.equal(f.writes, 1);
});

test('search engine edits preserve navigation and detect an external engine edit', async () => {
  const f = fixture();
  f.saver.queue({ providers: [{ id: 'engine-a' }] });
  f.external({ entries: [{ id: 'new-site' }] });
  await f.saver.flush();
  assert.equal(f.state.entries[0].id, 'new-site');
  f.saver.queue({ providers: [] });
  f.external({ providers: [{ id: 'engine-b' }] });
  await assert.rejects(f.saver.flush(), { code: 'PREFERENCE_CONFLICT' });
  await f.saver.reload();
  assert.equal(f.state.providers[0].id, 'engine-b');
});
