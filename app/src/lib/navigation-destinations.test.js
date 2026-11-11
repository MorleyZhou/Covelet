import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, letterIcon } from './model.js';
import { desktopDestinationValue, inheritedSitePrivacy, navigationDestination, prepareLayoutTransfer, previewLayoutTransfer, layoutTransferPreferences, saveLayoutTransfer } from './navigation-destinations.js';
import { localData } from './local-data.js';

const preferences = { privateKeys: [], presentation: false };
const folder = { id: 'destination', type: 'folder', groupId: 'group-home', parentId: null, name: 'Folder', page: 1, order: 2, icon: letterIcon('F') };
const site = (id, order, page = 0, parentId = null) => ({
  id, type: 'site', groupId: 'group-home', parentId, page, order, name: id, url: `https://example.com/${id}`, icon: letterIcon(id),
  ...(parentId === null ? { position: { row: 0, column: order } } : {}),
});
function navigation() {
  const state = createEmptyState();
  state.settings.pages = [0, 1];
  state.entries = [site('a', 0), site('b', 1), structuredClone(folder), site('child', 0, 1, folder.id)];
  return state;
}
function saveHarness(t) {
  const preferenceKey = 'covelet.content.preferences.v1', navigationKey = 'owntab.local.v1';
  const records = { [navigationKey]: { version: 1, state: navigation(), snapshots: [] },
    [preferenceKey]: { version: 1, revision: 2, aliases: {}, privateKeys: [], presentation: false,
      library: { version: 1, tags: [{ id: 'tag-work', name: 'Work' }], items: { 'site:a': { description: 'Original reason', tagIds: ['tag-work'] } } } } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), held = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
    async request(name, options, run) { held.push(name); try { return await (run || options)(); } finally { assert.equal(held.pop(), name); } },
  } } });
  t.after(() => Object.defineProperty(globalThis, 'navigator', descriptor));
  t.mock.method(localData, 'get', async (key) => structuredClone({ [key]: records[key] }));
  const writes = t.mock.method(localData, 'set', async (patch) => {
    assert.deepEqual(held, ['owntab.local.write.v1', preferenceKey]);
    Object.assign(records, structuredClone(patch));
  });
  return { records, writes, preferenceKey, navigationKey };
}

test('named destination identity follows a renumbered desktop and hidden folders cannot be chosen', () => {
  const state = navigation();
  state.settings.desktopPages = { 1: { id: 'persistent-page', name: 'Project' } };
  assert.deepEqual(navigationDestination(state, 'page-id:persistent-page', preferences), { page: 1, parentId: null });
  state.settings.desktopPages = { 0: state.settings.desktopPages[1] };
  assert.deepEqual(navigationDestination(state, 'page-id:persistent-page', preferences), { page: 0, parentId: null });
  assert.throws(() => navigationDestination(state, 'folder:destination', { privateKeys: ['folder:destination'], presentation: true }), { code: 'TARGET_CHANGED' });
});

test('old folders without a page remain on the first screen and occupied undeclared pages are valid targets', () => {
  const state = navigation();
  state.settings.pages = [1];
  delete state.entries[2].page;
  state.entries[0].page = 4;
  assert.equal(desktopDestinationValue(state), 'page:0');
  assert.deepEqual(navigationDestination(state, 'folder:destination', preferences), { page: 0, parentId: folder.id });
  assert.deepEqual(navigationDestination(state, 'page:4', preferences), { page: 4, parentId: null });
  state.settings.desktopPages = { 1: { id: '4', name: 'Numeric identifier' } };
  assert.deepEqual(navigationDestination(state, 'page-id:4', preferences), { page: 1, parentId: null });
  assert.deepEqual(navigationDestination(state, 'page:4', preferences), { page: 4, parentId: null });
});

test('moving a bookmark out of a private folder preserves its effective privacy', () => {
  const current = { ...preferences, privateKeys: ['folder:destination', 'folder:another-private'] };
  const child = site('child', 0, 1, 'destination');
  assert.deepEqual(inheritedSitePrivacy(child, { page: 0, parentId: null }, current), ['site:child']);
  assert.deepEqual(inheritedSitePrivacy(child, { page: 1, parentId: 'public-folder' }, current), ['site:child']);
  assert.deepEqual(inheritedSitePrivacy(child, { page: 1, parentId: 'another-private' }, current), []);
  assert.deepEqual(inheritedSitePrivacy(child, { page: 1, parentId: 'destination' }, current), []);
  assert.deepEqual(inheritedSitePrivacy(undefined, { page: 0, parentId: null }, current), []);
});

test('bulk move is a draft-only operation preserving source order, IDs and unrelated positions', () => {
  const state = navigation(), original = structuredClone(state);
  const preview = previewLayoutTransfer(state, ['b', 'a'], 'folder:destination', preferences, 'move');
  const result = prepareLayoutTransfer(state, preview, 'move');
  assert.deepEqual(state, original);
  assert.deepEqual(result.ids, ['a', 'b']);
  assert.equal(result.copies.size, 0);
  const items = result.state.entries.filter((entry) => entry.parentId === folder.id);
  assert.deepEqual(items.map(({ id, order, page }) => [id, order, page]), [['child', 0, 1], ['a', 1, 1], ['b', 2, 1]]);
  assert(items.every((entry) => !entry.position));
});

test('copy skips duplicates in its target, preserves the source and protects descendant drafts', () => {
  const state = navigation();
  state.entries.at(-1).url = state.entries[0].url;
  const preview = previewLayoutTransfer(state, ['a', 'b'], 'folder:destination', preferences, 'copy');
  assert.equal(preview.duplicates, 1);
  const result = prepareLayoutTransfer(state, preview, 'copy', () => 'copy-of-b');
  assert.deepEqual(result.ids, ['copy-of-b']);
  assert.deepEqual(result.copies, new Map([['copy-of-b', 'b']]));
  assert.deepEqual(result.state.entries.find((entry) => entry.id === 'b'), state.entries[1]);
  const current = { ...preferences, privateKeys: ['site:b'], presentation: true };
  const copies = new Map([...result.copies, ['another-copy', 'copy-of-b']]);
  assert.deepEqual(layoutTransferPreferences(current, copies).privateKeys, ['site:b', 'site:copy-of-b', 'site:another-copy']);
  assert.deepEqual(previewLayoutTransfer(state, ['a', 'b'], 'folder:destination', current, 'copy').sources, []);
  const locked = { ...current, privateKeys: ['site:child'] };
  assert.equal(previewLayoutTransfer(state, ['a'], 'folder:destination', locked, 'copy').duplicates, 0, 'hidden target contents do not appear in preview counts');
});

test('a chain of copied sites retains independent descriptions and stable tag references', () => {
  const current = { ...preferences, library: { version: 1, tags: [{ id: 'dev', name: 'Development' }],
    items: { 'site:b': { description: 'Saved reason', tagIds: ['dev'] } } } };
  const before = structuredClone(current);
  const inherited = layoutTransferPreferences(current, new Map([['copy-b', 'b'], ['copy-again', 'copy-b']]));
  assert.deepEqual(inherited.library.items['site:copy-again'], current.library.items['site:b']);
  inherited.library.items['site:copy-b'].description = 'Another purpose';
  assert.equal(inherited.library.items['site:copy-again'].description, 'Saved reason');
  assert.deepEqual(current, before);
});

test('locking after a draft copy rejects hidden source and target copies without writing empty metadata', async (t) => {
  const { records, writes, preferenceKey, navigationKey } = saveHarness(t);
  const original = structuredClone(records[navigationKey].state);
  const draft = prepareLayoutTransfer(original, previewLayoutTransfer(original, ['a'], 'page:1', preferences, 'copy'), 'copy', () => 'copy-a');
  records[preferenceKey].privateKeys = ['site:a']; records[preferenceKey].presentation = true;
  let before = structuredClone(records);
  await assert.rejects(saveLayoutTransfer(draft.state, 0, draft.copies), { code: 'PRIVACY_LOCKED' });
  assert.deepEqual(records, before); assert.equal(writes.mock.callCount(), 0);
  records[preferenceKey].privateKeys = ['folder:destination'];
  draft.state.entries.find((entry) => entry.id === 'copy-a').parentId = 'destination';
  before = structuredClone(records);
  await assert.rejects(saveLayoutTransfer(draft.state, 0, draft.copies), { code: 'PRIVACY_LOCKED' });
  assert.deepEqual(records, before); assert.equal(writes.mock.callCount(), 0);
  const child = original.entries.find((entry) => entry.id === 'child'), childDraft = structuredClone(original);
  childDraft.entries = childDraft.entries.filter((entry) => entry.id !== child.id);
  childDraft.entries.push({ ...child, id: 'child-copy', parentId: null, page: 0, order: 3 });
  before = structuredClone(records);
  await assert.rejects(saveLayoutTransfer(childDraft, 0, new Map([['child-copy', 'child']])), { code: 'PRIVACY_LOCKED' });
  assert.deepEqual(records, before); assert.equal(writes.mock.callCount(), 0);
});

test('a surviving chained copy inherits raw metadata and private markings atomically after unlock', async (t) => {
  const { records, writes, preferenceKey, navigationKey } = saveHarness(t);
  const original = records[navigationKey].state.entries.find((entry) => entry.id === 'a');
  const draft = structuredClone(records[navigationKey].state);
  draft.entries.push({ ...original, id: 'final-copy', page: 1, order: 3 });
  const copies = new Map([['final-copy', 'undone-copy'], ['undone-copy', 'a']]);
  records[preferenceKey].privateKeys = ['site:a']; records[preferenceKey].presentation = true;
  const before = structuredClone(records);
  await assert.rejects(saveLayoutTransfer(draft, 0, copies), { code: 'PRIVACY_LOCKED' });
  assert.deepEqual(records, before);
  records[preferenceKey].presentation = false;
  await saveLayoutTransfer(draft, 0, copies);
  assert.equal(writes.mock.callCount(), 1);
  const saved = records[preferenceKey];
  assert.deepEqual(saved.privateKeys, ['site:a', 'site:final-copy']);
  assert.deepEqual(saved.library.items['site:final-copy'], saved.library.items['site:a']);
  assert.equal(Object.hasOwn(saved.library.items, 'site:undone-copy'), false);
  assert.deepEqual(Object.keys(writes.mock.calls[0].arguments[0]), [navigationKey, preferenceKey]);
});
