import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from './model.js';
import { DESKTOP_ROWS, layoutDesktop, placeDesktopEntries, placeDesktopEntry } from './desktop-layout.js';
import { applyDesktopDrop } from './desktop-edit.js';

const site = (id, slot, columns = 4, page = 0) => ({ id, type: 'site', name: id, url: `https://${id}.example/?keep=1#part`,
  groupId: 'group-home', parentId: null, page, order: slot, position: { row: Math.floor(slot / columns), column: slot % columns },
  icon: { kind: 'url', value: 'https://icons.example/original.png' }, iconBackground: '#abcdef' });
const stateOf = (entries, columns = 4) => ({ ...createEmptyState(), entries, settings: { ...createEmptyState().settings, columns,
  pages: [...new Set(entries.map((item) => item.page ?? 0))].sort((a, b) => a - b) } });
const ids = (entries, columns = 4, page = 0) => layoutDesktop(entries, columns).filter((screen) => screen.page === page).flatMap((screen) => screen.items.map((item) => item.id));
const slot = (entries, id, columns = 4) => { const item = entries.find((entry) => entry.id === id); return item.position.row * columns + item.position.column; };
const drop = (state, selected, targetSlot, columns = 4, page = 0) => applyDesktopDrop(state, selected,
  { kind: 'place', parentId: null, key: `${page}:0`, page, row: Math.floor(targetSlot / columns), column: targetSlot % columns }, columns, () => 'new-folder').state;
function noOverlap(entries, columns = 4) {
  for (const screen of layoutDesktop(entries, columns)) {
    assert.equal(screen.key, `${screen.page}:0`, 'intentional reflow must save overflow as explicit pages');
    const occupied = new Set();
    for (const position of screen.placements.values()) {
      assert(position.row + position.rows - 1 <= DESKTOP_ROWS && position.column + position.columns - 1 <= columns);
      for (let row = position.row; row < position.row + position.rows; row++) for (let column = position.column; column < position.column + position.columns; column++) {
        const key = `${row}:${column}`; assert(!occupied.has(key), `overlap at ${key}`); occupied.add(key);
      }
    }
  }
}

test('ordinary same-page icon drops insert both forwards and backwards rather than swapping endpoints', () => {
  const state = stateOf(['a', 'b', 'c', 'd'].map((id, index) => site(id, index))), original = structuredClone(state);
  assert.deepEqual(ids(drop(state, ['d'], 1).entries), ['a', 'd', 'b', 'c']);
  assert.deepEqual(ids(drop(state, ['a'], 2).entries), ['b', 'c', 'a', 'd']);
  assert.deepEqual(state, original, 'neither draft editing nor cancelled drag may mutate the source');
  const moved = drop(state, ['d'], 1).entries.find((item) => item.id === 'd');
  assert.equal(moved.url, original.entries[3].url); assert.deepEqual(moved.icon, original.entries[3].icon); assert.equal(moved.iconBackground, '#abcdef');
});

test('insertion continues in row-major order across a row boundary in both directions', () => {
  const state = stateOf(Array.from({ length: 10 }, (_, index) => site(`s${index}`, index)));
  const forward = drop(state, ['s1'], 7), backward = drop(state, ['s8'], 2);
  assert.deepEqual(ids(forward.entries), ['s0', 's2', 's3', 's4', 's5', 's6', 's7', 's1', 's8', 's9']);
  assert.deepEqual(ids(backward.entries), ['s0', 's1', 's8', 's2', 's3', 's4', 's5', 's6', 's7', 's9']);
  assert.equal(slot(forward.entries, 's1'), 7); assert.equal(slot(backward.entries, 's8'), 2);
  noOverlap(forward.entries); noOverlap(backward.entries);
});

test('occupied-seat insertion retains deliberate holes while dropping into an empty seat moves only the source', () => {
  const entries = [site('a', 0), site('b', 2), site('c', 4), site('d', 5)], original = structuredClone(entries);
  const inserted = placeDesktopEntry(entries, 'd', 0, { row: 0, column: 0 }, 4);
  assert.deepEqual(ids(inserted), ['d', 'a', 'b', 'c']);
  assert.deepEqual(inserted.map((item) => slot(inserted, item.id)).sort((a, b) => a - b), [0, 2, 4, 5]);
  const free = placeDesktopEntry(entries, 'd', 0, { row: 2, column: 2 }, 4);
  for (const item of original.slice(0, 3)) assert.deepEqual(free.find((entry) => entry.id === item.id), item);
  assert.equal(slot(free, 'd'), 10); assert.deepEqual(entries, original);
});

test('single-cell insertion skips a larger widget without moving its footprint', () => {
  const widget = { id: 'notes', type: 'widget', name: 'notes', extensionId: 'notes', groupId: 'group-home', parentId: null,
    page: 0, order: 1, position: { row: 0, column: 1 }, icon: { kind: 'letter', value: 'T' }, config: { size: 'small' } };
  const state = stateOf([site('a', 0), widget, site('b', 3), site('c', 4)]), moved = drop(state, ['c'], 0);
  assert.deepEqual(ids(moved.entries), ['c', 'notes', 'a', 'b']);
  assert.deepEqual(moved.entries.find((item) => item.id === 'notes').position, widget.position);
  assert.equal(slot(moved.entries, 'a'), 3); assert.equal(slot(moved.entries, 'b'), 4); noOverlap(moved.entries);
});

test('dropping into a larger widget pushes the stable neighbor sequence forward without an endpoint swap', () => {
  const widget = { id: 'notes', type: 'widget', name: 'notes', extensionId: 'notes', groupId: 'group-home', parentId: null,
    page: 0, order: 1, position: { row: 0, column: 1 }, icon: { kind: 'letter', value: 'T' }, config: { size: 'small' } };
  const state = stateOf([site('a', 0), widget, site('b', 3), site('c', 4)]), moved = drop(state, ['a'], 1);
  assert.equal(slot(moved.entries, 'a'), 1); assert.equal(slot(moved.entries, 'notes'), 2);
  assert.equal(slot(moved.entries, 'b'), 4); assert.equal(slot(moved.entries, 'c'), 5);
  assert.deepEqual(ids(moved.entries), ['a', 'notes', 'b', 'c']); noOverlap(moved.entries);
});

test('moving a multi-cell widget preserves unselected visual order and leaves its old free cells alone', () => {
  const widget = { id: 'notes', type: 'widget', name: 'notes', extensionId: 'notes', groupId: 'group-home', parentId: null,
    page: 0, order: 0, position: { row: 0, column: 0 }, icon: { kind: 'letter', value: 'T' }, config: { size: 'small' } };
  const state = stateOf([widget, ...[2, 3, 6, 7, 8, 9].map((value) => site(`s${value}`, value))]), moved = drop(state, ['notes'], 6);
  assert.equal(slot(moved.entries, 'notes'), 6);
  assert.deepEqual(ids(moved.entries).filter((id) => id !== 'notes'), ['s2', 's3', 's6', 's7', 's8', 's9']);
  assert.equal(slot(moved.entries, 's2'), 2); assert.equal(slot(moved.entries, 's3'), 3);
  noOverlap(moved.entries);
});

test('multi-selection retains original visual order even when the gesture lists its grabbed item first', () => {
  const state = stateOf(Array.from({ length: 8 }, (_, index) => site(`s${index}`, index))), moved = drop(state, ['s3', 's1'], 5);
  assert.equal(slot(moved.entries, 's1'), 5); assert.equal(slot(moved.entries, 's3'), 6);
  assert.deepEqual(ids(moved.entries), ['s0', 's2', 's4', 's1', 's3', 's5', 's6', 's7']);
  assert.deepEqual(moved.entries.filter((item) => ['s0', 's2', 's4'].includes(item.id)).map((item) => item.position), [{ row: 0, column: 0 }, { row: 0, column: 2 }, { row: 1, column: 0 }]);
  noOverlap(moved.entries);
});

test('a full destination page shifts into a new appended page without backfilling source or unrelated pages', () => {
  const state = stateOf([...Array.from({ length: 24 }, (_, index) => site(`s${index}`, index)), site('incoming', 0, 4, 1), site('unrelated', 5, 4, 2)]);
  const originalOther = structuredClone(state.entries.at(-1)), moved = drop(state, ['incoming'], 1);
  assert.deepEqual(ids(moved.entries), ['s0', 'incoming', ...Array.from({ length: 22 }, (_, index) => `s${index + 1}`)]);
  assert.equal(moved.entries.find((item) => item.id === 's23').page, 3); assert.equal(slot(moved.entries, 's23'), 0);
  const unrelated = moved.entries.find((item) => item.id === 'unrelated');
  assert.deepEqual(unrelated, { ...originalOther, order: unrelated.order }, 'global root-order numbering is derived; the other page and all content stay unchanged');
  assert(moved.settings.pages.includes(1) && moved.settings.pages.includes(3));
  assert.equal(new Set(moved.entries.map((item) => item.id)).size, state.entries.length); noOverlap(moved.entries);
});

test('an exhausted page limit rejects overflow without modifying any source record', () => {
  const entries = [...Array.from({ length: 24 }, (_, index) => site(`s${index}`, index)), site('incoming', 0, 4, 1999)], before = structuredClone(entries);
  assert.throws(() => placeDesktopEntries(entries, ['incoming'], 0, { row: 0, column: 0 }, 4), /主屏幕数量/);
  assert.deepEqual(entries, before);
});

test('overflow appends after saved empty pages and respects an empty final page at the limit', () => {
  const state = stateOf([...Array.from({ length: 24 }, (_, index) => site(`s${index}`, index)), site('incoming', 0, 4, 1)]);
  state.settings.pages = [0, 1, 7];
  const moved = drop(state, ['incoming'], 1);
  assert.equal(moved.entries.find((item) => item.id === 's23').page, 8);
  assert.deepEqual(moved.settings.pages, [0, 1, 7, 8]);
  const atLimit = structuredClone(state); atLimit.settings.pages.push(1999);
  const before = structuredClone(atLimit);
  assert.throws(() => drop(atLimit, ['incoming'], 1), /主屏幕数量/);
  assert.deepEqual(atLimit, before);
});

test('taking a site out of a two-child folder cleans up the folder and inserts at the occupied root seat', () => {
  const folder = { id: 'folder', type: 'folder', name: 'Folder', groupId: 'group-home', parentId: null, page: 0, order: 0,
    icon: { kind: 'letter', value: 'F' }, position: { row: 0, column: 0 } };
  const child = (id, order) => { const item = { ...site(id, order), parentId: 'folder', order }; delete item.position; return item; };
  const state = stateOf([folder, child('a', 0), child('b', 1), site('c', 1)]), moved = drop(state, ['a'], 1);
  assert(!moved.entries.some((item) => item.id === 'folder'));
  assert.deepEqual(ids(moved.entries), ['b', 'a', 'c']);
  assert.equal(slot(moved.entries, 'a'), 1); assert.equal(slot(moved.entries, 'c'), 2); noOverlap(moved.entries);
});
