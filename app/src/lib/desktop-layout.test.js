import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_ROWS, layoutDesktop, desktopFootprint, nextDesktopPage, WIDGET_SIZES } from './desktop-layout.js';
import { createEmptyState, createInitialState, createDemoState, validateState, migrateNavigationState, configureGitHubWidget, moveEntry, combineEntries, deleteEntry } from './model.js';
import { createReplica, recordChanges, packReplica, readReplicas, materializeState, portableState } from './sync.js';
import { createConfiguredNavigation } from '../../tests/fixtures/navigation-state.mjs';

test('widget dimensions are rows by columns and bounded by the available columns', () => {
  assert.equal(DESKTOP_ROWS, 6);
  assert.deepEqual(WIDGET_SIZES, { mini: { rows: 1, columns: 1 }, small: { rows: 2, columns: 2 }, medium: { rows: 2, columns: 4 }, large: { rows: 4, columns: 4 } });
  assert.deepEqual(desktopFootprint({ type: 'widget', config: { size: 'mini' } }, 3), { rows: 1, columns: 1 });
  assert.deepEqual(desktopFootprint({ type: 'widget', config: { size: 'medium' } }, 3), { rows: 2, columns: 3 });
  assert.deepEqual(desktopFootprint({ type: 'site' }, 8), { rows: 1, columns: 1 });
});

test('mixed paged layouts preserve every root exactly once, spatial reading order and non-overlapping bounds', () => {
  const initial = createConfiguredNavigation();
  const items = Array.from({ length: 97 }, (_, order) => order % 9 === 0
    ? { id: `widget-${order}`, type: 'widget', parentId: null, order, config: { size: ['small', 'medium', 'large'][Math.floor(order / 9) % 3] }, page: order > 80 ? 2 : 0 }
    : { ...initial.entries[order % 6], id: `site-${order}`, order, page: order > 80 ? 2 : 0 });
  items.push({ ...initial.entries[0], id: 'folder-child', parentId: 'not-a-root', order: 0 });
  const before = structuredClone(items);
  for (let columns = 1; columns <= 12; columns++) {
    const screens = layoutDesktop(items, columns);
    assert.deepEqual(screens.flatMap((screen) => screen.items.map((entry) => entry.id)).sort(),
      items.filter((entry) => entry.parentId === null).map((entry) => entry.id).sort());
    for (const screen of screens) {
      const occupied = new Set();
      let previousSeat = -1;
      for (const entry of screen.items) {
        const placement = screen.placements.get(entry.id), seat = (placement.row - 1) * columns + placement.column - 1;
        assert(seat > previousSeat, 'DOM order follows the actual visual seats, including gaps next to larger widgets');
        previousSeat = seat;
      }
      for (const placement of screen.placements.values()) {
        assert(placement.column >= 1 && placement.row >= 1);
        assert(placement.column + placement.columns - 1 <= columns);
        assert(placement.row + placement.rows - 1 <= DESKTOP_ROWS);
        for (let row = placement.row; row < placement.row + placement.rows; row++) for (let col = placement.column; col < placement.column + placement.columns; col++) {
          const key = `${row}:${col}`;
          assert(!occupied.has(key), `overlap at ${key}`); occupied.add(key);
        }
      }
    }
  }
  assert.deepEqual(items, before, 'responsive overflow must not rewrite saved pages');
});

test('large widgets use the six-row capacity and start a new screen when the remaining rows cannot fit', () => {
  const state = configureGitHubWidget(createConfiguredNavigation(), { username: 'torvalds', size: 'large' });
  const screens = layoutDesktop(state.entries, 8);
  assert.equal(screens.length, 1);
  const widget = state.entries.find((entry) => entry.type === 'widget');
  assert.equal(screens[0].items.length, 7);
  assert.deepEqual(screens[0].placements.get(widget.id), { row: 2, column: 1, rows: 4, columns: 4 });
  assert.equal(layoutDesktop(state.entries, 3).flatMap((screen) => screen.items).length, 7);
  assert.deepEqual(layoutDesktop(state.entries, 8), screens, 'a narrow-window layout does not change the wide layout');
  const crowded = createConfiguredNavigation(), originals = crowded.entries;
  crowded.entries = Array.from({ length: 24 }, (_, order) => ({ ...originals[order % originals.length], id: `crowded-${order}`, order }));
  const overflow = configureGitHubWidget(crowded, { username: 'torvalds', size: 'large' });
  const paged = layoutDesktop(overflow.entries, 8);
  assert.equal(paged.length, 2);
  assert.equal(paged[0].items.length, 24);
  assert.deepEqual(paged[1].placements.values().next().value, { row: 1, column: 1, rows: 4, columns: 4 });
});

test('saved page order takes precedence over the shared root order while order within each page is preserved', () => {
  const state = moveEntry(createConfiguredNavigation(), 'default-google', { page: 2, index: 0 });
  const screens = layoutDesktop(state.entries, 8);
  assert.deepEqual(screens.map((screen) => screen.page), [0, 2]);
  assert.deepEqual(screens[0].items.map((entry) => entry.name), ['YouTube', 'GitHub', 'X', 'ChatGPT', 'Grok']);
  assert.deepEqual(screens[1].items.map((entry) => entry.name), ['Google']);
  assert.equal(screens.flatMap((screen) => screen.items).length, state.entries.length);
});

test('fresh installations and empty sync stay empty; configured sites remain removable', () => {
  assert.equal(createInitialState().entries.length, 0);
  const state = createConfiguredNavigation();
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
  const defaults = createConfiguredNavigation();
  const state = moveEntry(deleteEntry(defaults, 'default-google'), 'default-github', { page: 2 });
  const replica = recordChanges(createReplica('paged-device'), initial, state);
  const packed = await packReplica(replica);
  const received = await readReplicas({ ...packed.chunks, [packed.key]: packed.head });
  assert.deepEqual(portableState(materializeState(received.documents)), portableState(state));
});
