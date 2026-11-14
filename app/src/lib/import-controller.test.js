import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { localData } from './local-data.js';
import { createEmptyState, letterIcon } from './model.js';
import { defaultSavedFilters, validateSavedView } from './saved-views.js';
import { commitImportedPlan } from './import-controller.js';
import { prepareImportWithMetadata } from './import-plan.js';
import { applyPreparedNavigationImport } from './storage.js';

const NAV = 'owntab.local.v1', PREFS = 'covelet.content.preferences.v1', WRITE = 'owntab.local.write.v1';
const shared = 'https://example.test/shared?x=1#section', fresh = 'https://example.test/new';
const site = (id, order) => ({ id, type: 'site', name: id, url: shared, groupId: 'group-home', parentId: null, page: order,
  order, icon: letterIcon(id) });
const plan = () => ({ source: { format: 'raindrop-html' }, folders: [], sites: [
  { name: 'New first', url: fresh, folder: null, metadata: { description: 'First source description', tagNames: ['Imported'] } },
  { name: 'New duplicate', url: fresh, folder: null, metadata: { description: 'Additional source description', tagNames: ['Extra'] } },
  { name: 'Existing duplicate', url: shared, folder: null, metadata: { description: 'Incoming local description', tagNames: ['Imported'] } },
], invalid: [], duplicateCount: 1 });
const choices = () => ({
  [fresh]: { targetKey: 'new:0', sourceIndices: [1], unionTags: true, description: 'append' },
  [shared]: { targetKey: 'site:existing-a', sourceIndices: [2], unionTags: true, description: 'append' },
});

function fixture(t, { failWrite = false, locked = false, beforeWrite } = {}) {
  const state = createEmptyState(); state.settings.pages = [0, 1]; state.entries = [site('existing-a', 0), site('existing-b', 1)];
  const records = {
    [NAV]: { version: 1, state, snapshots: [] },
    [PREFS]: { version: 1, revision: 4, presentation: locked, aliases: { 'site:existing-a': 'Existing alias' }, privateKeys: ['site:existing-b'],
      library: { version: 1, tags: [{ id: 'local-work', name: 'Work' }], items: {
        'site:existing-a': { description: 'Keep local', tagIds: ['local-work'] }, 'site:existing-b': { description: 'Different local', tagIds: [] },
      }, views: [validateSavedView({ id: 'existing-view', revision: 1, name: 'Existing view', ...defaultSavedFilters(), tagIds: ['local-work'] })] } },
  };
  const context = new AsyncLocalStorage(), queues = new Map(), acquisitions = [];
  const locks = { async request(name, options, run) {
    const action = run || options, previous = queues.get(name) || Promise.resolve();
    let release; const gate = new Promise((resolve) => { release = resolve; }); queues.set(name, previous.then(() => gate));
    await previous; const chain = [...(context.getStore() || []), name]; acquisitions.push(chain);
    try { return await context.run(chain, action); } finally { release(); }
  } };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', navigatorDescriptor));
  t.mock.method(localData, 'get', async (requested) => {
    const keys = Array.isArray(requested) ? requested : [requested];
    return structuredClone(Object.fromEntries(keys.filter((key) => Object.hasOwn(records, key)).map((key) => [key, records[key]])));
  });
  const writes = t.mock.method(localData, 'set', async (patch) => {
    assert.deepEqual(context.getStore(), [WRITE, PREFS]);
    await beforeWrite?.(patch, records); assert.deepEqual(context.getStore(), [WRITE, PREFS]);
    if (failWrite) throw Error('synthetic atomic import failure');
    Object.assign(records, structuredClone(patch));
  });
  const request = (patch = {}) => ({ plan: plan(), options: { selectedIndices: [0, 1, 2], page: 0, columns: 8,
    skipDuplicates: true, targetFolderId: null, includeMetadata: true, metadataChoices: choices() },
    expectedNavigationRevision: records[NAV].state.revision, expectedPreferencesRevision: records[PREFS].revision, ...patch });
  return { records, locks, acquisitions, writes, request };
}

test('an import recomputes generated identities under both locks and commits navigation with metadata once', async (t) => {
  const f = fixture(t), request = f.request(), beforePreferences = structuredClone(f.records[PREFS]);
  const preview = prepareImportWithMetadata(f.records[NAV].state, f.records[PREFS], request.plan, request.options);
  const result = await commitImportedPlan(request), added = result.rows.find((row) => row.index === 0).entryId;
  assert.notEqual(added, preview.rows.find((row) => row.index === 0).entryId, 'opaque preview IDs are never a commit input');
  assert.equal(result.addedSites, 1); assert.equal(result.updatedSites, 1); assert.equal(result.preferencesChanged, true);
  assert.equal(result.state.entries.find((entry) => entry.id === added).url, fresh);
  assert.equal(result.nextPreferences.revision, beforePreferences.revision + 1);
  assert.equal(f.records[PREFS].library.items[`site:${added}`].description, 'First source description\n\nAdditional source description');
  const tagNames = (key) => f.records[PREFS].library.items[key].tagIds.map((id) => f.records[PREFS].library.tags.find((tag) => tag.id === id).name);
  assert.deepEqual(tagNames(`site:${added}`), ['Imported', 'Extra']);
  assert.deepEqual(tagNames('site:existing-a'), ['Work', 'Imported']);
  assert.equal(f.records[PREFS].library.items['site:existing-a'].description, 'Keep local\n\nIncoming local description');
  assert.deepEqual(f.records[PREFS].library.items['site:existing-b'], beforePreferences.library.items['site:existing-b']);
  assert.deepEqual(f.records[PREFS].aliases, beforePreferences.aliases); assert.deepEqual(f.records[PREFS].privateKeys, beforePreferences.privateKeys);
  assert.deepEqual(f.records[PREFS].library.views, beforePreferences.library.views);
  assert.equal(f.writes.mock.callCount(), 1); assert.deepEqual(Object.keys(f.writes.mock.calls[0].arguments[0]), [NAV, PREFS]);
  assert.deepEqual(f.acquisitions, [[WRITE], [WRITE, PREFS]]);
});

test('metadata-only merging preserves navigation layout/revision while updating only the chosen local copy', async (t) => {
  const f = fixture(t), before = structuredClone(f.records[NAV]);
  const source = { folders: [], sites: [plan().sites[2]], source: { format: 'raindrop-html' } };
  const result = await commitImportedPlan(f.request({ plan: source, options: { selectedIndices: [0], metadataChoices: {
    [shared]: { targetKey: 'site:existing-b', sourceIndices: [0], unionTags: true, description: 'append' },
  } } }));
  assert.equal(result.addedSites, 0); assert.equal(result.updatedSites, 1); assert.equal(result.preferencesChanged, true);
  assert.deepEqual(f.records[NAV], before);
  assert.equal(f.records[PREFS].library.items['site:existing-a'].description, 'Keep local');
  assert.equal(f.records[PREFS].library.items['site:existing-b'].description, 'Different local\n\nIncoming local description');
  assert.deepEqual(f.records[PREFS].privateKeys, ['site:existing-b']);
});

test('cancelled/empty selection, all-skipped imports and stale navigation/preferences leave both domains unchanged', async (t) => {
  const f = fixture(t), before = structuredClone(f.records);
  for (const request of [f.request({ expectedNavigationRevision: 9 }), f.request({ expectedPreferencesRevision: 3 }),
    f.request({ options: { selectedIndices: [], metadataChoices: {} } }),
    f.request({ plan: { folders: [], sites: [plan().sites[2]] }, options: { selectedIndices: [0], metadataChoices: {} } })]) {
    await assert.rejects(commitImportedPlan(request));
    assert.deepEqual(f.records, before); assert.equal(f.writes.mock.callCount(), 0);
  }
});

test('wrong URL/target mappings, unselected source choices and metadata limits cannot produce partial additions', async (t) => {
  const f = fixture(t), before = structuredClone(f.records);
  const otherTarget = 'https://example.test/not-the-group';
  const invalidChoices = [
    { [fresh]: { targetKey: 'site:existing-a', sourceIndices: [0], unionTags: true, description: 'append' } },
    { [otherTarget]: { targetKey: 'site:existing-a', sourceIndices: [2], unionTags: true, description: 'append' } },
    { [shared]: { targetKey: 'site:missing-target', sourceIndices: [2], unionTags: true, description: 'append' } },
  ];
  for (const metadataChoices of invalidChoices) {
    await assert.rejects(commitImportedPlan(f.request({ options: { selectedIndices: [0, 1, 2], metadataChoices } })));
    assert.deepEqual(f.records, before);
  }
  await assert.rejects(commitImportedPlan(f.request({ options: { selectedIndices: [0], metadataChoices: choices() } })));
  const oversized = plan(); oversized.sites[0].metadata.description = 'x'.repeat(1001);
  await assert.rejects(commitImportedPlan(f.request({ plan: oversized })));
  assert.deepEqual(f.records, before); assert.equal(f.writes.mock.callCount(), 0);
});

test('locked import gating happens before running the preparation factory or exposing duplicate groups', async (t) => {
  const f = fixture(t, { locked: true }), before = structuredClone(f.records); let calls = 0;
  await assert.rejects(applyPreparedNavigationImport({ expectedNavigationRevision: 0, expectedPreferencesRevision: 4 }, () => { calls++; return {}; }), { code: 'PRIVACY_LOCKED' });
  assert.equal(calls, 0);
  await assert.rejects(commitImportedPlan(f.request()), { code: 'PRIVACY_LOCKED' });
  assert.deepEqual(f.records, before); assert.equal(f.writes.mock.callCount(), 0);
});

test('a failed encrypted write leaves newly allocated tags, merged metadata, private markers and navigation unpublished', async (t) => {
  const f = fixture(t, { failWrite: true }), before = structuredClone(f.records);
  await assert.rejects(commitImportedPlan(f.request()), /synthetic atomic import failure/);
  assert.deepEqual(f.records, before); assert.equal(f.writes.mock.callCount(), 1);
});

test('caller mutations while waiting for the navigation lock cannot replace confirmed source rows or decisions', async (t) => {
  const f = fixture(t); let entered, release;
  const acquired = new Promise((resolve) => { entered = resolve; }), blocked = new Promise((resolve) => { release = resolve; });
  const blocker = f.locks.request(WRITE, async () => { entered(); await blocked; }); await acquired;
  const request = f.request(), pending = commitImportedPlan(request);
  request.plan.sites[0].url = 'https://unconfirmed.test/'; request.plan.sites[0].metadata.description = 'Unconfirmed change';
  request.options.selectedIndices.length = 0; request.options.metadataChoices[shared].targetKey = 'site:existing-b';
  release(); await blocker; const result = await pending;
  assert.equal(result.addedSites, 1); assert(result.state.entries.some((entry) => entry.url === fresh));
  assert(!result.state.entries.some((entry) => entry.url === 'https://unconfirmed.test/'));
  assert.equal(f.records[PREFS].library.items['site:existing-a'].description, 'Keep local\n\nIncoming local description');
  assert.equal(f.records[PREFS].library.items['site:existing-b'].description, 'Different local');
});

test('prepared React state/preferences payloads are refused and deliberate metadata exclusion creates no tags', async (t) => {
  const f = fixture(t), before = structuredClone(f.records);
  await assert.rejects(commitImportedPlan({ ...f.request(), state: createEmptyState(), nextPreferences: {} }), { code: 'IMPORT_PLAN_INVALID' });
  assert.deepEqual(f.records, before);
  const result = await commitImportedPlan(f.request({ options: { selectedIndices: [0], includeMetadata: false, metadataChoices: {} } }));
  assert.equal(result.preferencesChanged, false); assert.deepEqual(f.records[PREFS], before[PREFS]);
  assert.deepEqual(Object.keys(f.writes.mock.calls[0].arguments[0]), [NAV]);
});

test('storage validates metadata baselines and final navigation before publishing either domain', async (t) => {
  const f = fixture(t), before = structuredClone(f.records), request = f.request();
  const prepare = () => prepareImportWithMetadata(f.records[NAV].state, f.records[PREFS], request.plan, request.options);
  const options = { expectedNavigationRevision: 0, expectedPreferencesRevision: 4 };
  await assert.rejects(applyPreparedNavigationImport(options, () => {
    const result = prepare(); result.expectedMetadata[0].description = 'Stale baseline'; return result;
  }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(applyPreparedNavigationImport(options, () => {
    const result = prepare(); result.state.entries[0].name = ''; return result;
  }));
  await assert.rejects(applyPreparedNavigationImport(options, () => {
    const result = prepare(); result.preferencesChanged = false; return result;
  }), { code: 'IMPORT_PLAN_INVALID' });
  assert.deepEqual(f.records, before); assert.equal(f.writes.mock.callCount(), 0);
});

test('unavailable browser locks refuse an import without publishing navigation or preferences', async (t) => {
  const f = fixture(t), before = structuredClone(f.records); navigator.locks = undefined;
  await assert.rejects(commitImportedPlan(f.request()), /浏览器无法锁定本机内容偏好/);
  assert.deepEqual(f.records, before); assert.equal(f.writes.mock.callCount(), 0);
});
