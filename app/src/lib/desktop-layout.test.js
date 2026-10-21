import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutDesktop, desktopFootprint, nextDesktopPage, WIDGET_SIZES } from './desktop-layout.js';
import { createEmptyState, createInitialState, createDemoState, validateState, migrateNavigationState, configureGitHubWidget, moveEntry, combineEntries, deleteEntry } from './model.js';
import { createReplica, recordChanges, packReplica, readReplicas, materializeState, portableState } from './sync.js';

test('widget dimensions are rows by columns and bounded by the available columns', () => {
  assert.deepEqual(WIDGET_SIZES, { small: { rows: 2, columns: 2 }, medium: { rows: 2, columns: 4 }, large: { rows: 4, columns: 4 } });
  assert.deepEqual(desktopFootprint({ type: 'widget', config: { size: 'medium' } }, 3), { rows: 2, columns: 3 });
  assert.deepEqual(desktopFootprint({ type: 'site' }, 8), { rows: 1, columns: 1 });
});

test('mixed paged layouts preserve every root exactly once, reading order and non-overlapping bounds', () => {
  const initial = createInitialState();
  const items = Array.from({ length: 97 }, (_, order) => order % 9 === 0
    ? { id: `widget-${order}`, type: 'widget', parentId: null, order, config: { size: ['small', 'medium', 'large'][Math.floor(order / 9) % 3] }, page: order > 80 ? 2 : 0 }
    : { ...initial.entries[order % 6], id: `site-${order}`, order, page: order > 80 ? 2 : 0 });
  items.push({ ...initial.entries[0], id: 'folder-child', parentId: 'not-a-root', order: 0 });
  const before = structuredClone(items);
  for (let columns = 1; columns <= 12; columns++) {
    const screens = layoutDesktop(items, columns);
    assert.deepEqual(screens.flatMap((screen) => screen.items.map((entry) => entry.id)), items.filter((entry) => entry.parentId === null).map((entry) => entry.id));
    for (const screen of screens) {
      const occupied = new Set();
      for (const placement of screen.placements.values()) {
        assert(placement.column >= 1 && placement.row >= 1);
        assert(placement.column + placement.columns - 1 <= columns);
        assert(placement.row + placement.rows - 1 <= 4);
        for (let row = placement.row; row < placement.row + placement.rows; row++) for (let col = placement.column; col < placement.column + placement.columns; col++) {
          const key = `${row}:${col}`;
          assert(!occupied.has(key), `overlap at ${key}`); occupied.add(key);
        }
      }
    }
  }
  assert.deepEqual(items, before, 'responsive overflow must not rewrite saved pages');
});

test('a full large widget starts a new screen after preceding icons rather than overflowing or backfilling', () => {
  const state = configureGitHubWidget(createInitialState(), { username: 'torvalds', size: 'large' });
  const screens = layoutDesktop(state.entries, 8);
  assert.equal(screens.length, 2);
  assert.equal(screens[0].items.length, 6);
  assert.deepEqual(screens[1].placements.values().next().value, { row: 1, column: 1, rows: 4, columns: 4 });
  assert.equal(layoutDesktop(state.entries, 3).flatMap((screen) => screen.items).length, 7);
  assert.deepEqual(layoutDesktop(state.entries, 8), screens, 'a narrow-window layout does not change the wide layout');
});

test('saved page order takes precedence over the shared root order while order within each page is preserved', () => {
  const state = moveEntry(createInitialState(), 'default-google', { page: 2, index: 0 });
  const screens = layoutDesktop(state.entries, 8);
  assert.deepEqual(screens.map((screen) => screen.page), [0, 2]);
  assert.deepEqual(screens[0].items.map((entry) => entry.name), ['YouTube', 'GitHub', 'X', 'ChatGPT', 'Grok']);
  assert.deepEqual(screens[1].items.map((entry) => entry.name), ['Google']);
  assert.equal(screens.flatMap((screen) => screen.items).length, state.entries.length);
});

test('fresh defaults are ordinary removable sites; migrations and empty sync never reseed them', () => {
  const state = createInitialState();
  assert.deepEqual(state.entries.map((entry) => entry.name), ['Google', 'YouTube', 'GitHub', 'X', 'ChatGPT', 'Grok']);
  const deleted = state.entries.reduce((next, entry) => deleteEntry(next, entry.id), state);
  assert.equal(migrateNavigationState(deleted).entries.length, 0);
  assert.equal(materializeState({}).entries.length, 0);
  assert.equal(createEmptyState().entries.length, 0);
  assert.equal(nextDesktopPage(state.entries), 1);
  assert.equal(layoutDesktop(state.entries, 8, 1).length, 2);
  assert.equal(layoutDesktop(state.entries, 8).length, 1, 'an unused draft page is not persisted');
});

test('page assignments survive folder creation, cross-screen movement, dissolving and legacy migration', () => {
  const initial = createDemoState();
  const moved = moveEntry(initial, 'site-github', { page: 3 });
  const grouped = combineEntries(moved, 'site-figma', 'site-github', { folderId: 'pages-folder' });
  assert.equal(grouped.entries.find((entry) => entry.id === 'pages-folder').page, 3);
  const folderMoved = moveEntry(grouped, 'pages-folder', { page: 1 });
  assert(folderMoved.entries.filter((entry) => entry.parentId === 'pages-folder').every((entry) => entry.page === 1));
  const dissolved = deleteEntry(folderMoved, 'pages-folder');
  assert(dissolved.entries.filter((entry) => ['site-github', 'site-figma'].includes(entry.id)).every((entry) => entry.page === 1 && entry.parentId === null));
  assert.deepEqual(migrateNavigationState(initial), initial, 'old entries without page keep their data and read as page zero');
  for (const page of [-1, 2000, 1.5, '1', null]) {
    assert.throws(() => moveEntry(initial, 'site-github', { page }), /主屏幕位置/);
    assert.throws(() => validateState({ ...initial, entries: initial.entries.map((entry, index) => index ? entry : { ...entry, page }) }), /主屏幕位置/);
  }
});

test('saved screen assignments and deletion of a default survive native-sync packing', async () => {
  const initial = createEmptyState();
  const defaults = createInitialState();
  const state = moveEntry(deleteEntry(defaults, 'default-google'), 'default-github', { page: 2 });
  const replica = recordChanges(createReplica('paged-device'), initial, state);
  const packed = await packReplica(replica);
  const received = await readReplicas({ ...packed.chunks, [packed.key]: packed.head });
  assert.deepEqual(portableState(materializeState(received.documents)), portableState(state));
});
