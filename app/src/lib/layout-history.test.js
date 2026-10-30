import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, configureGitHubWidget, deleteEntry } from './model.js';
import { beginDesktopEdit, addDesktopScreen, removeDesktopScreen, applyDesktopDrop, deleteDesktopEntries } from './desktop-edit.js';
import { LAYOUT_HISTORY_LIMIT, createLayoutHistory, updateLayoutHistoryView, recordLayoutHistory,
  undoLayoutHistory, redoLayoutHistory, layoutHistoryScreen, layoutHistoryShortcut } from './layout-history.js';

const columns = 8;
const start = () => beginDesktopEdit(createInitialState(), columns).state;
const frame = (draft, selectedIds = [], activeKey = '0:0') => ({ draft, selectedIds, activeKey });

test('inserting a dragged icon records all intervening seats in one undoable layout transaction', () => {
  const original = start();
  const moved = applyDesktopDrop(original, ['default-grok'], { kind: 'place', page: 0, key: '0:0', row: 0, column: 1 }, columns, () => 'unused-folder').state;
  const expected = ['default-google', 'default-grok', 'default-youtube', 'default-github', 'default-x', 'default-chatgpt'];
  assert.deepEqual(moved.entries.filter((entry) => entry.parentId === null).sort((a, b) => a.order - b.order).map((entry) => entry.id), expected);
  let history = createLayoutHistory(frame(original));
  history = recordLayoutHistory(history, frame(moved, ['default-grok']));
  assert.equal(history.past.length, 1, 'the entire insertion is one gesture');
  history = undoLayoutHistory(history);
  assert.deepEqual(history.present.draft, original, 'undo restores every displaced icon and its metadata');
  history = redoLayoutHistory(history);
  assert.deepEqual(history.present.draft, moved);
  assert.deepEqual(history.present.selectedIds, ['default-grok']);
});

test('a folder transaction undoes and redoes every selected site with original metadata and selection', () => {
  const original = start(), selected = ['default-google', 'default-github'];
  let history = createLayoutHistory(frame(original, selected));
  const grouped = applyDesktopDrop(original, selected, { kind: 'combine', id: 'default-youtube', page: 0, key: '0:0' }, columns, () => 'history-folder');
  history = recordLayoutHistory(history, frame(grouped.state, [grouped.revealId]));
  assert.deepEqual(history.present.draft.entries.filter((entry) => entry.parentId === 'history-folder').map((entry) => entry.id), ['default-google', 'default-youtube', 'default-github']);
  history = undoLayoutHistory(history);
  assert.deepEqual(history.present.draft, original);
  assert.equal(history.present.draft.revision, original.revision);
  assert.deepEqual(history.present.selectedIds, selected);
  history = redoLayoutHistory(history);
  assert.deepEqual(history.present.draft, grouped.state);
  assert.deepEqual(history.present.selectedIds, ['history-folder']);
  assert.equal(history.present.draft.revision, grouped.state.revision, 'history never adds a revision of its own');
});

test('deletion and folder dissolution are reversible independent transactions', () => {
  const original = start();
  const grouped = applyDesktopDrop(original, ['default-google'], { kind: 'combine', id: 'default-youtube', key: '0:0', page: 0 }, columns, () => 'history-folder').state;
  let history = createLayoutHistory(frame(grouped, ['history-folder']));
  const dissolved = deleteEntry(grouped, 'history-folder');
  history = recordLayoutHistory(history, frame(dissolved, ['default-google']));
  const deleted = deleteDesktopEntries(dissolved, ['default-google'], columns);
  history = recordLayoutHistory(history, frame(deleted));
  history = undoLayoutHistory(history);
  assert.deepEqual(history.present.draft, dissolved);
  history = undoLayoutHistory(history);
  assert.deepEqual(history.present.draft, grouped);
  assert.deepEqual(history.present.selectedIds, ['history-folder']);
  history = redoLayoutHistory(redoLayoutHistory(history));
  assert.deepEqual(history.present.draft, deleted);
});

test('page deletion restores detached widget identity, configuration and the previous active page', () => {
  const original = start(), added = addDesktopScreen(original, columns);
  const configured = configureGitHubWidget(added.state, { username: 'torvalds', size: 'small' }, undefined, { page: added.page });
  const widgetId = configured.entries.find((entry) => entry.type === 'widget').id;
  const edited = beginDesktopEdit(configured, columns).state;
  let history = createLayoutHistory(frame(edited, [widgetId], '1:0'));
  const removed = removeDesktopScreen(edited, '1:0', columns);
  history = recordLayoutHistory(history, frame(removed.state, [widgetId], removed.key));
  assert.equal(history.present.draft.entries.find((entry) => entry.id === widgetId).detached, true);
  assert.deepEqual(history.present.selectedIds, [], 'detached widgets cannot remain selected');
  history = undoLayoutHistory(history);
  assert.deepEqual(history.present.draft, edited);
  assert.equal(history.present.activeKey, '1:0');
  assert.deepEqual(history.present.selectedIds, [widgetId]);
  history = redoLayoutHistory(history);
  assert.deepEqual(history.present.draft, removed.state);
  assert.equal(history.present.activeKey, removed.key);
});

test('screen navigation and a structurally equal draft retain redo; a real new branch clears it', () => {
  const original = start(), added = addDesktopScreen(original, columns);
  let history = recordLayoutHistory(createLayoutHistory(frame(original)), frame(added.state, [], '1:0'));
  history = undoLayoutHistory(history);
  history = updateLayoutHistoryView(history, { selectedIds: ['default-google'], activeKey: '0:0' });
  const reorderedKeys = { entries: structuredClone(original.entries), settings: structuredClone(original.settings), providers: structuredClone(original.providers),
    groups: structuredClone(original.groups), revision: original.revision, version: original.version };
  history = recordLayoutHistory(history, frame(reorderedKeys, ['default-google']));
  history = recordLayoutHistory(history, frame({ ...reorderedKeys, revision: original.revision + 1 }, ['default-google']));
  assert.equal(history.past.length, 0);
  assert.equal(history.future.length, 1);
  history = redoLayoutHistory(history);
  assert.equal(history.present.activeKey, '1:0');
  history = undoLayoutHistory(history);
  const deleted = deleteDesktopEntries(original, ['default-google'], columns);
  history = recordLayoutHistory(history, frame(deleted));
  assert.equal(history.future.length, 0);
  assert.equal(redoLayoutHistory(history), history);
});

test('only the latest 50 transactions are retained and snapshots are isolated from caller mutation', () => {
  const original = start();
  let history = createLayoutHistory(frame(original));
  original.entries[0].name = 'caller mutation';
  assert.notEqual(history.present.draft.entries[0].name, 'caller mutation');
  for (let index = 1; index <= LAYOUT_HISTORY_LIMIT + 7; index++) {
    const draft = structuredClone(history.present.draft);
    draft.entries[0].name = `edit ${index}`;
    history = recordLayoutHistory(history, frame(draft));
    draft.entries[0].name = 'later caller mutation';
  }
  assert.equal(history.past.length, LAYOUT_HISTORY_LIMIT);
  assert.equal(history.present.draft.entries[0].name, 'edit 57');
  for (let index = 0; index < LAYOUT_HISTORY_LIMIT; index++) history = undoLayoutHistory(history);
  assert.equal(history.present.draft.entries[0].name, 'edit 7');
  assert.equal(undoLayoutHistory(history), history);
  assert.equal(history.future.length, LAYOUT_HISTORY_LIMIT);
  for (let index = 0; index < LAYOUT_HISTORY_LIMIT; index++) history = redoLayoutHistory(history);
  assert.equal(history.present.draft.entries[0].name, 'edit 57');
  assert.equal(redoLayoutHistory(history), history);
});

test('a new editing session cannot recover history or selection from a prior one', () => {
  const original = start();
  const prior = recordLayoutHistory(createLayoutHistory(frame(original, ['default-google'])), frame(addDesktopScreen(original, columns).state));
  const next = createLayoutHistory(frame(prior.present.draft));
  assert.equal(next.past.length, 0);
  assert.equal(next.future.length, 0);
  assert.deepEqual(next.present.selectedIds, []);
});

test('saved screen keys remain valid after responsive overflow changes or a removed screen', () => {
  const original = start();
  original.entries.push({ ...original.entries[0], id: 'seventh-site', order: 6, position: { row: 0, column: 6 } });
  assert.equal(layoutHistoryScreen(original, '0:1', 1), '0:1');
  assert.equal(layoutHistoryScreen(original, '0:1', columns), '0:0');
  assert.equal(layoutHistoryScreen(original, '99:0', columns), '0:0');
});

test('undo shortcuts support Windows and macOS while leaving text, modal and IME editing alone', () => {
  const event = { key: 'z', ctrlKey: true };
  assert.equal(layoutHistoryShortcut(event), 'undo');
  assert.equal(layoutHistoryShortcut({ key: 'Z', metaKey: true, shiftKey: true }), 'redo');
  assert.equal(layoutHistoryShortcut({ key: 'y', ctrlKey: true }), 'redo');
  for (const detail of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { altKey: true },
    { target: { closest: () => ({}) } }, { ctrlKey: false }]) assert.equal(layoutHistoryShortcut({ ...event, ...detail }), null);
  assert.equal(layoutHistoryShortcut({ key: 'y', metaKey: true }), null);
});
