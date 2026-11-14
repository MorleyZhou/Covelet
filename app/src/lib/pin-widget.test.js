import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createEmptyState } from './model.js';
import { defaultSavedFilters, validateSavedView } from './saved-views.js';
import { localData } from './local-data.js';
import { pinContentWidget } from './pin-widget.js';

const NAV = 'owntab.local.v1', PREFS = 'covelet.content.preferences.v1', TOOLS = 'covelet.tools.v1', WRITE = 'owntab.local.write.v1';
const note = (id, title) => ({ id, title, body: `${title} text`, pinned: false, revision: 1, createdAt: 10, updatedAt: 20 });

function fixture(t, { locked = false, failWrite = false, beforeWrite } = {}) {
  const state = createEmptyState(); state.settings.pages = [0, 1];
  const records = {
    [NAV]: { version: 1, state, snapshots: [] },
    [PREFS]: { version: 1, revision: 4, aliases: {}, presentation: locked, privateKeys: ['note:note-a', 'view:view-a'],
      library: { version: 1, tags: [], items: {}, views: [validateSavedView({ id: 'view-a', revision: 2, name: 'Project view', ...defaultSavedFilters(), type: 'note' })] } },
    [TOOLS]: { version: 3, revision: 5, notes: [note('note-a', 'Private project'), note('note-b', 'Public project')], reading: [], snapshots: [], trash: [] },
  };
  const context = new AsyncLocalStorage(), queues = new Map(), acquisitions = [];
  const locks = { async request(name, options, run) {
    const action = run || options, previous = queues.get(name) || Promise.resolve();
    let release; const gate = new Promise((resolve) => { release = resolve; });
    queues.set(name, previous.then(() => gate));
    await previous;
    const chain = [...(context.getStore() || []), name]; acquisitions.push(chain);
    try { return await context.run(chain, action); }
    finally { release(); }
  } };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', navigatorDescriptor));
  t.mock.method(localData, 'get', async (requested) => {
    const keys = Array.isArray(requested) ? requested : [requested];
    return structuredClone(Object.fromEntries(keys.filter((key) => Object.hasOwn(records, key)).map((key) => [key, records[key]])));
  });
  const writes = t.mock.method(localData, 'set', async (patch) => {
    assert.deepEqual(context.getStore(), [WRITE, PREFS, TOOLS], 'all target locks must remain held through the encrypted commit');
    await beforeWrite?.(patch, records);
    assert.deepEqual(context.getStore(), [WRITE, PREFS, TOOLS], 'an asynchronous writer cannot release the note target early');
    if (failWrite) throw Error('synthetic encrypted storage failure');
    Object.assign(records, structuredClone(patch));
  });
  const args = (patch = {}) => ({ kind: 'note', recordId: 'note-a', size: 'small', page: 1,
    expectedNavigationRevision: records[NAV].state.revision, expectedPreferencesRevision: records[PREFS].revision,
    expectedRecordRevision: 1, ...patch });
  return { records, writes, args, locks, acquisitions };
}

test('note pins add independent stable bindings and direct privacy in one encrypted write without copying content', async (t) => {
  const f = fixture(t), originalTools = structuredClone(f.records[TOOLS]);
  const first = await pinContentWidget(f.args());
  assert.equal(first.state.revision, 1);
  const entry = first.state.entries.find((item) => item.id === first.widgetId);
  assert.deepEqual(entry.config, { size: 'small', noteId: 'note-a' }); assert.equal(entry.page, 1);
  assert(!JSON.stringify(entry).includes('Private project')); assert(!JSON.stringify(entry).includes(' text'));
  assert(f.records[PREFS].privateKeys.includes(`widget:${entry.id}`));
  assert.deepEqual(Object.keys(f.writes.mock.calls[0].arguments[0]), [NAV, PREFS]); assert.equal(f.writes.mock.callCount(), 1);
  assert.deepEqual(f.acquisitions.slice(-3), [[WRITE], [WRITE, PREFS], [WRITE, PREFS, TOOLS]]);
  const second = await pinContentWidget(f.args({ size: 'mini' }));
  assert.notEqual(first.widgetId, second.widgetId); assert.equal(second.state.entries.length, 2);
  assert.deepEqual(f.records[TOOLS], originalTools);
  assert.equal(f.records[PREFS].privateKeys.filter((key) => key.startsWith('widget:')).length, 2);
});

test('view pins retain only the view identity and public note binding avoids an unrelated private marker', async (t) => {
  const f = fixture(t), originalView = structuredClone(f.records[PREFS].library.views[0]);
  const viewPin = await pinContentWidget(f.args({ kind: 'view', recordId: 'view-a', expectedRecordRevision: 2, size: 'medium' }));
  assert.deepEqual(viewPin.state.entries[0].config, { size: 'medium', viewId: 'view-a' });
  assert.deepEqual(f.records[PREFS].library.views[0], originalView);
  assert(f.records[PREFS].privateKeys.includes(`widget:${viewPin.widgetId}`));
  const beforePreferences = structuredClone(f.records[PREFS]);
  const publicPin = await pinContentWidget(f.args({ recordId: 'note-b' }));
  assert.deepEqual(f.records[PREFS], beforePreferences);
  assert.equal(f.records[PREFS].privateKeys.includes(`widget:${publicPin.widgetId}`), false);
  assert.deepEqual(Object.keys(f.writes.mock.calls.at(-1).arguments[0]), [NAV]);
});

test('retargeting reuses the widget identity and checks its original configuration before changing target', async (t) => {
  const f = fixture(t), initial = await pinContentWidget(f.args({ recordId: 'note-b' }));
  const originalConfig = structuredClone(initial.state.entries[0].config), before = structuredClone(f.records), writes = f.writes.mock.callCount();
  await assert.rejects(pinContentWidget(f.args({ widgetId: initial.widgetId, expectedConfig: { size: 'large', noteId: 'note-b' } })), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(f.records, before); assert.equal(f.writes.mock.callCount(), writes);
  const result = await pinContentWidget(f.args({ widgetId: initial.widgetId, expectedConfig: originalConfig }));
  assert.equal(result.widgetId, initial.widgetId); assert.equal(result.state.entries.length, 1);
  assert.equal(result.state.entries[0].config.noteId, 'note-a'); assert(f.records[PREFS].privateKeys.includes(`widget:${initial.widgetId}`));
});

test('stale navigation, preference, note and view revisions and missing/null targets never write', async (t) => {
  const f = fixture(t), before = structuredClone(f.records);
  for (const patch of [{ expectedNavigationRevision: 7 }, { expectedPreferencesRevision: 3 }, { expectedRecordRevision: 2 },
    { kind: 'view', recordId: 'view-a', expectedRecordRevision: 1 }, { recordId: 'missing-note' }, { recordId: null },
    { kind: 'view', recordId: 'missing-view', expectedRecordRevision: 1 }, { expectedRecordRevision: 0 }]) {
    await assert.rejects(pinContentWidget(f.args(patch)));
    assert.deepEqual(f.records, before); assert.equal(f.writes.mock.callCount(), 0);
  }
});

test('locked direct targets and conditional hidden-only views cannot publish a card or marker', async (t) => {
  const f = fixture(t, { locked: true }); let before = structuredClone(f.records);
  await assert.rejects(pinContentWidget(f.args()), { code: 'PRIVACY_LOCKED' });
  await assert.rejects(pinContentWidget(f.args({ kind: 'view', recordId: 'view-a', expectedRecordRevision: 2 })), { code: 'PRIVACY_LOCKED' });
  assert.deepEqual(f.records, before);
  f.records[PREFS].privateKeys = ['note:note-a'];
  f.records[PREFS].library.tags = [{ id: 'secret', name: 'Private-only project' }];
  f.records[PREFS].library.items['note:note-a'] = { description: '', tagIds: ['secret'] };
  f.records[PREFS].library.views[0].tagIds = ['secret']; before = structuredClone(f.records);
  await assert.rejects(pinContentWidget(f.args({ kind: 'view', recordId: 'view-a', expectedRecordRevision: 2 })), { code: 'PRIVACY_LOCKED' });
  assert.deepEqual(f.records, before); assert.equal(f.writes.mock.callCount(), 0);
});

test('failed persistence preserves navigation, reference content and every existing private marker', async (t) => {
  const f = fixture(t, { failWrite: true }), before = structuredClone(f.records);
  await assert.rejects(pinContentWidget(f.args()), /synthetic encrypted storage failure/);
  assert.deepEqual(f.records, before); assert.equal(f.writes.mock.callCount(), 1);
});

test('a competing note deletion cannot pass the held target lock before the pin commit completes', async (t) => {
  let enteredWrite, releaseWrite;
  const entered = new Promise((resolve) => { enteredWrite = resolve; }), release = new Promise((resolve) => { releaseWrite = resolve; });
  const f = fixture(t, { beforeWrite: async () => { enteredWrite(); await release; } });
  const pinning = pinContentWidget(f.args()); await entered;
  let deletionStarted = false;
  const deleting = f.locks.request(TOOLS, async () => { deletionStarted = true; f.records[TOOLS].notes = []; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(deletionStarted, false); assert.equal(f.writes.mock.callCount(), 1);
  releaseWrite(); const pinned = await pinning; await deleting;
  assert.equal(deletionStarted, true); assert.equal(pinned.state.entries[0].config.noteId, 'note-a');
  assert.equal(f.records[NAV].state.entries.length, 1);
});
