import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, letterIcon } from './model.js';
import { desktopDestinationValue, inheritedSitePrivacy, navigationDestination, prepareLayoutTransfer, previewLayoutTransfer, layoutTransferPreferences } from './navigation-destinations.js';

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
