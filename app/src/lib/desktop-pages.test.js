import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, letterIcon, migrateNavigationState } from './model.js';
import { beginDesktopEdit, moveDesktopPage, removeDesktopScreen, renameDesktopPage } from './desktop-edit.js';
import { defaultDesktopPage, namedDesktopRecords } from './desktop-pages.js';
import { exactDesktopMatches, searchCoveletContent } from './content-search.js';
import { DEFAULT_DESKTOP_KEY, isSyncRecord } from './sync-data-rules.js';

test('only the original logical page keeps its name across overflow, reorder and removal', () => {
  const old = createEmptyState();
  old.settings.pages = [0, 1];
  old.entries = Array.from({ length: 7 }, (_, index) => ({ id: `s${index}`, type: 'site', name: `Site ${index}`,
    url: `https://example.invalid/${index}`, groupId: 'group-home', parentId: null, page: 0, order: index, icon: letterIcon('S') }));
  const named = renameDesktopPage(renameDesktopPage(old, 0, '个人'), 1, '工作');
  const id = named.settings.desktopPages[1].id;
  const { state, keys } = beginDesktopEdit(named, 1);
  assert.equal(keys.get('1:0'), '2:0');
  assert.equal(state.settings.desktopPages[0].name, '个人');
  assert.equal(state.settings.desktopPages[1], undefined);
  assert.equal(defaultDesktopPage(state, id), 2);
  const moved = moveDesktopPage(state, 2, -1, '2:0', 1);
  assert.equal(moved.key, '1:0');
  assert.equal(defaultDesktopPage(moved.state, id), 1);
  const removed = removeDesktopScreen(moved.state, '1:0', 1);
  assert.equal(defaultDesktopPage(removed.state, id), 0);
  assert.equal(named.settings.desktopPages[1].name, '工作');
  assert.equal(migrateNavigationState(old).settings.desktopPages, undefined);
  assert.equal(isSyncRecord('preferences', DEFAULT_DESKTOP_KEY), false);
});

test('duplicate desktop names remain separately selectable and an empty name keeps the page identity', () => {
  const state = createEmptyState();
  state.settings.pages = [0, 1];
  const named = renameDesktopPage(renameDesktopPage(state, 0, 'Work'), 1, 'ｗｏｒｋ');
  const results = namedDesktopRecords(named.settings);
  assert.deepEqual(exactDesktopMatches(results, 'work').map((item) => item.page), [0, 1]);
  assert.deepEqual(searchCoveletContent(named, null, 'work', { desktops: results }).map((item) => item.record.page), [0, 1]);
  const id = named.settings.desktopPages[1].id;
  const cleared = renameDesktopPage(named, 1, ' ');
  assert.deepEqual(cleared.settings.desktopPages[1], { id });
  assert.equal(defaultDesktopPage(cleared, id), 1);
});
