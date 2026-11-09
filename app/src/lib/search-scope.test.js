import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCoveletContent } from './content-search.js';
import { navigationResultPath, scopeSearchContent } from './search-scope.js';

const folder = { type: 'folder', id: 'folder', name: 'Work', page: 2 };
const child = { type: 'site', id: 'child', name: 'Docs', parentId: folder.id, page: 0 };
const unrelated = { type: 'site', id: 'other', name: 'Docs', page: 0 };
const navigation = { entries: [folder, child, unrelated] };
const tools = { notes: [{ id: 'note', title: 'Docs', body: 'Read later' }], reading: [{ id: 'read', title: 'Docs' }] };

test('search scopes the source before the result limit and follows a child’s folder page', () => {
  const { entries, tools: currentTools } = scopeSearchContent(navigation, tools, 'current', 2);
  assert.deepEqual(entries, [folder, child]);
  assert.equal(currentTools, null);
  assert.deepEqual(searchCoveletContent(entries, currentTools, 'Docs', { limit: 1 }).map(({ id }) => id), ['child']);
  assert.deepEqual(scopeSearchContent(navigation, tools, 'all', 2), { entries: navigation.entries, tools });
  assert.deepEqual(scopeSearchContent(navigation, tools, 'site', 2), { entries: [child, unrelated], tools: null });
  assert.deepEqual(scopeSearchContent(navigation, tools, 'desktop', 2), { entries: [], tools: null });
  assert.deepEqual(scopeSearchContent(navigation, tools, 'note', 2), { entries: [], tools: { notes: tools.notes } });
  assert.deepEqual(scopeSearchContent(navigation, tools, 'reading', 2), { entries: [], tools: { reading: tools.reading } });
});

test('navigation paths distinguish screens and folders without exposing locked paths', () => {
  const name = (page) => `Screen ${page}`;
  const result = { key: 'site:child', type: 'site', entry: child };
  assert.equal(navigationResultPath(result, navigation, new Set(), name), 'Screen 2 › Work');
  assert.equal(navigationResultPath(result, navigation, new Set(['folder:folder']), name), '');
  assert.equal(navigationResultPath(result, navigation, new Set(['site:child']), name), '');
  assert.equal(navigationResultPath({ key: 'site:other', type: 'site', entry: unrelated }, navigation, new Set(), name), 'Screen 0');
  assert.equal(navigationResultPath({ key: 'note:note', type: 'note' }, navigation, new Set(), name), '');
});
