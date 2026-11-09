import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from './model.js';
import { localData } from './local-data.js';
import { copyReadingToNavigation } from './reading-to-navigation.js';

const navigationKey = 'owntab.local.v1';
const preferencesKey = 'covelet.content.preferences.v1';
const toolsKey = 'covelet.tools.v1';
const reading = { id: 'reading-1', url: 'https://example.com/article', title: 'Example article',
  revision: 1, status: 'read', createdAt: 10, updatedAt: 20 };

function prepare(t, { locked = false, failWrite = false, source = reading } = {}) {
  const state = createEmptyState();
  state.settings.pages = [0, 1];
  const records = {
    [navigationKey]: { version: 1, state, snapshots: [] },
    [preferencesKey]: { version: 1, revision: 4, privateKeys: ['reading:reading-1'], aliases: {}, presentation: locked },
    [toolsKey]: { version: 3, revision: 5, notes: [], reading: [source], snapshots: [], trash: [] },
  };
  const held = [];
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    async request(name, options, run) {
      held.push(name);
      try { return await (run || options)(); }
      finally { assert.equal(held.pop(), name); }
    },
  } } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', navigatorDescriptor));
  t.mock.method(localData, 'get', async (key) => structuredClone({ [key]: records[key] }));
  const writes = t.mock.method(localData, 'set', async (patch) => {
    assert.deepEqual(held, ['owntab.local.write.v1', preferencesKey, toolsKey]);
    if (failWrite) throw Error('synthetic storage failure');
    Object.assign(records, structuredClone(patch));
  });
  return { records, writes };
}

test('a private reading record and its copied link preserve their state in one atomic write', async (t) => {
  const { records, writes } = prepare(t);
  const saved = await copyReadingToNavigation(reading, 'page:1', 0);
  const [site] = saved.entries;
  assert.equal(site.page, 1);
  assert.equal(site.url, reading.url);
  assert.deepEqual(records[toolsKey].reading, [reading]);
  assert.deepEqual(records[preferencesKey].privateKeys, ['reading:reading-1', `site:${site.id}`]);
  assert.deepEqual(Object.keys(writes.mock.calls[0].arguments[0]), [navigationKey, preferencesKey]);
  assert.equal(writes.mock.callCount(), 1);
  await assert.rejects(copyReadingToNavigation(reading, 'page:1', 1));
  assert.equal(writes.mock.callCount(), 1);
});

test('a lock or a changed reading revision rejects the copy before any write', async (t) => {
  const { records, writes } = prepare(t, { locked: true });
  await assert.rejects(copyReadingToNavigation(reading, 'page:1', 0));
  records[preferencesKey].presentation = false;
  records[toolsKey].reading[0] = { ...reading, revision: 2 };
  await assert.rejects(copyReadingToNavigation(reading, 'page:1', 0));
  await assert.rejects(copyReadingToNavigation(reading, 'page:2', 0), { code: 'TARGET_CHANGED' });
  assert.equal(writes.mock.callCount(), 0);
});

test('failed persistence leaves both navigation and the private marker unchanged', async (t) => {
  const { records } = prepare(t, { failWrite: true });
  const before = structuredClone(records);
  await assert.rejects(copyReadingToNavigation(reading, 'page:1', 0), /synthetic storage failure/);
  assert.deepEqual(records, before);
});
