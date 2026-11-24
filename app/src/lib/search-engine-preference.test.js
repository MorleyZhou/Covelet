import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createLocalData } from './local-data.js';
import { createSearchEnginePreference, SEARCH_ENGINE_KEY } from './search-engine-preference.js';
import { isSyncRecord } from './sync-data-rules.js';

function fixture() {
  const records = new Map(); let deviceKey;
  const backend = {
    getKey: async () => deviceKey,
    ensureKey: async (candidate) => deviceKey ||= candidate,
    get: async (id) => structuredClone(records.get(id)),
    entries: async (space) => [...records.values()].filter((record) => space === undefined || record.space === space).map((record) => structuredClone(record)),
    put: async (values) => { for (const record of values) records.set(record.id, structuredClone(record)); },
    remove: async (ids) => { for (const id of ids) records.delete(id); },
    commit: async (values, ids) => {
      for (const id of ids) records.delete(id);
      for (const record of values) records.set(record.id, structuredClone(record));
    },
  };
  const storage = createLocalData({ backend, crypto: webcrypto, databaseName: `search-engine-${webcrypto.randomUUID()}`,
    legacyLocal: null, localStorage: null, broadcastChannel: null, locks: null });
  return { storage, records, preference: createSearchEnginePreference(storage.localData) };
}

test('search engine selection survives a newly mounted reader and can return to browser default', async () => {
  const { storage, preference, records } = fixture();
  try {
    assert.equal(await preference.read(), 'browser');
    await preference.write('duckduckgo');
    const reopened = createSearchEnginePreference(storage.localData);
    assert.equal(await reopened.read(), 'duckduckgo');
    assert.doesNotMatch(JSON.stringify([...records.values()]), /duckduckgo|covelet\.search\.engine/);
    await reopened.write('browser');
    assert.equal(await preference.read(), 'browser');
  } finally { await storage.close(); }
});

test('selection changes notify other mounted readers only after a successful save', async () => {
  const { storage, preference } = fixture(), observed = [];
  const stop = createSearchEnginePreference(storage.localData).subscribe((value) => observed.push(value));
  try {
    await preference.write('google');
    await preference.write('bing');
    assert.deepEqual(observed, ['google', 'bing']);
    stop();
    await preference.write('browser');
    assert.deepEqual(observed, ['google', 'bing']);
  } finally { stop(); await storage.close(); }
});

test('search selection and language remain device-local through snapshot application', async () => {
  const { storage, preference } = fixture();
  try {
    await preference.write('google');
    await storage.localData.set({ 'covelet.language.v1': 'ja', 'covelet.shared.example': 'before' });
    const before = await storage.syncDataStore.snapshot();
    assert.deepEqual(before.records.map(({ key }) => key), ['covelet.shared.example']);
    assert.equal(isSyncRecord('preferences', SEARCH_ENGINE_KEY), false);
    await storage.syncDataStore.apply({ version: 1, records: [{ namespace: 'preferences', key: 'covelet.shared.example', value: 'after' }] }, { expectedToken: before.token });
    assert.equal(await preference.read(), 'google');
    assert.equal((await storage.localData.get('covelet.language.v1'))['covelet.language.v1'], 'ja');
  } finally { await storage.close(); }
});

test('invalid stored selections fall back safely and malformed new values cannot replace a saved engine', async () => {
  const { storage, preference } = fixture();
  try {
    await storage.localData.set({ [SEARCH_ENGINE_KEY]: { id: 'google' } });
    assert.equal(await preference.read(), 'browser');
    await preference.write('google');
    for (const invalid of [null, '', 'bad id', 'x\n', 'x'.repeat(201)]) {
      await assert.rejects(preference.write(invalid), TypeError);
      assert.equal(await preference.read(), 'google');
    }
  } finally { await storage.close(); }
});
