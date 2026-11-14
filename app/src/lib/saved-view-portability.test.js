import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createLocalData, localData } from './local-data.js';
import { createRecoveryCenter } from './recovery-center.js';
import { createEmptyState } from './model.js';
import { defaultSavedFilters, resolveSavedView, validateSavedView } from './saved-views.js';
import { validateContentPreferences } from './content-preferences.js';

const NAV = 'owntab.local.v1', PREFS = 'covelet.content.preferences.v1', TOOLS = 'covelet.tools.v1', TEMPLATES = 'covelet.desktop-templates.v1';
const today = '2026-11-14';
const clone = (value) => structuredClone(value);

function encryptedDevice(name) {
  const records = new Map(); let key, writes = 0;
  const backend = {
    get writes() { return writes; },
    getKey: async () => key, ensureKey: async (candidate) => key ||= candidate,
    get: async (id) => clone(records.get(id)),
    entries: async (space) => [...records.values()].filter((record) => space === undefined || record.space === space).map(clone),
    put: async (values) => { writes++; for (const record of values) records.set(record.id, clone(record)); },
    remove: async (ids) => { writes++; for (const id of ids) records.delete(id); },
    commit: async (values, ids) => {
      writes++; const next = new Map(records);
      for (const id of ids) next.delete(id);
      for (const record of values) next.set(record.id, clone(record));
      records.clear(); for (const [id, record] of next) records.set(id, record);
    },
  };
  return { backend, ...createLocalData({ backend, crypto: webcrypto, databaseName: name,
    legacyLocal: null, localStorage: null, broadcastChannel: null, locks: null }) };
}

function sourceData() {
  const tag = (kind) => `source-${kind}`;
  const dates = ['2026-11-13', today, '2026-11-20', '2026-11-21', '2026-11-15'];
  const reading = dates.map((date, index) => ({ id: `reading-${index}`, title: `Article ${index}`, url: `https://example.test/${index}`,
    revision: 1, createdAt: 1, updatedAt: 2, status: index === 2 ? 'read' : 'unread', revisitOn: date }));
  const filters = { ...defaultSavedFilters(), type: 'reading', tagMode: 'any', tagIds: [tag('work'), tag('design')], excludeTagIds: [tag('done')] };
  const preferences = validateContentPreferences({ version: 1, revision: 0, presentation: false, privateKeys: [], aliases: {}, library: {
    version: 1, tags: [{ id: tag('work'), name: 'Work' }, { id: tag('design'), name: 'Design' }, { id: tag('done'), name: 'Done' }],
    items: Object.fromEntries(reading.map((record, index) => [`reading:${record.id}`, { description: `Preserved ${index}`,
      tagIds: index === 4 ? [tag('work'), tag('done')] : [index === 2 || index === 3 ? tag('design') : tag('work')] }])),
    views: [validateSavedView({ id: 'week-view', revision: 1, name: 'Next seven days', ...filters, revisit: 'next7d' }),
      validateSavedView({ id: 'today-view', revision: 1, name: 'Today', ...filters, revisit: 'today' })],
  } });
  return { [NAV]: { version: 1, state: createEmptyState(), snapshots: [] }, [PREFS]: preferences,
    [TOOLS]: { version: 3, revision: 0, notes: [], reading, snapshots: [], trash: [] }, [TEMPLATES]: { version: 1, revision: 0, templates: [] } };
}

function assertViewResults(preferences, tools) {
  const environment = { navigation: createEmptyState(), tools, preferences, today };
  assert.deepEqual(resolveSavedView(preferences.library.views.find((view) => view.id === 'week-view'), environment).rows.map((row) => row.id), ['reading-1', 'reading-2']);
  assert.deepEqual(resolveSavedView(preferences.library.views.find((view) => view.id === 'today-view'), environment).rows.map((row) => row.id), ['reading-1']);
}

test('encrypted full-data snapshot transfer preserves ANY/exclusion/date semantics on a different device key', async () => {
  const source = encryptedDevice('view-source-sync'), target = encryptedDevice('view-target-sync');
  try {
    const data = sourceData(); await source.localData.set(data);
    const snapshot = await source.syncDataStore.snapshot(), before = await target.syncDataStore.snapshot();
    await target.syncDataStore.apply(snapshot, { expectedToken: before.token });
    const received = await target.localData.get([PREFS, TOOLS]);
    assert.deepEqual(received[PREFS].library, data[PREFS].library);
    assertViewResults(received[PREFS], received[TOOLS]);
    assert.notEqual(await source.backend.getKey(), await target.backend.getKey());
  } finally { await source.close(); await target.close(); }
});

test('password backup append retains relative ANY views and remaps both included and excluded same-name tags', async (t) => {
  const source = encryptedDevice('view-source-backup'), target = encryptedDevice('view-target-backup');
  let active = source;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), queues = new Map();
  const locks = { request(name, options, run) {
    const action = run || options, pending = (queues.get(name) || Promise.resolve()).then(action);
    queues.set(name, pending.catch(() => {})); return pending;
  } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', navigatorDescriptor));
  t.mock.method(localData, 'get', (...args) => active.localData.get(...args));
  t.mock.method(localData, 'set', (...args) => active.localData.set(...args));
  try {
    await source.localData.set(sourceData());
    const sourceCenter = createRecoveryCenter({ locks }), beforeWrites = source.backend.writes;
    const file = await sourceCenter.exportEncryptedBackup('synthetic view portability password');
    assert.equal(source.backend.writes, beforeWrites, 'export must not rewrite portable records');
    active = target;
    const initial = sourceData(); initial[TOOLS].reading = [];
    initial[PREFS] = validateContentPreferences({ version: 1, revision: 0, aliases: {}, privateKeys: [], presentation: false,
      library: { version: 1, tags: [{ id: 'local-work', name: 'work' }, { id: 'local-design', name: 'design' }, { id: 'local-done', name: 'done' }], items: {}, views: [] } });
    await target.localData.set(initial);
    const targetCenter = createRecoveryCenter({ locks }), plan = await targetCenter.previewEncryptedBackup(file, 'synthetic view portability password');
    await targetCenter.restore(plan, { mode: 'append' });
    const restored = await target.localData.get([PREFS, TOOLS]);
    for (const view of restored[PREFS].library.views) {
      assert.equal(view.tagMode, 'any'); assert.deepEqual(view.tagIds, ['local-work', 'local-design']); assert.deepEqual(view.excludeTagIds, ['local-done']);
    }
    assertViewResults(restored[PREFS], restored[TOOLS]);
    const point = await targetCenter.getRecoveryPoint(); assert.equal(point.status, 'complete');
    const prior = await targetCenter.previewRecoveryPoint(point.id);
    assert.deepEqual(prior.preferences.library.views, []); assert.deepEqual(prior.preferences.library.tags.map((tag) => tag.id), ['local-work', 'local-design', 'local-done']);
  } finally { await source.close(); await target.close(); }
});
