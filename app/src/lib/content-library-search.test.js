import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCoveletContent, visibleContentTagIds } from './content-search.js';

const navigation = [{ type: 'site', id: 's', name: 'Documentation', url: 'https://example.test/docs' },
  { type: 'site', id: 'hidden', name: 'Private reference', url: 'https://private.test/' }];
const tools = { notes: [{ id: 'n', title: 'Project notes', body: 'A saved solution.' }],
  reading: [{ id: 'r', title: 'Article', url: 'https://example.test/article' }] };
const library = { version: 1, tags: [{ id: 'dev', name: '开发' }, { id: 'project', name: '项目' }, { id: 'secret', name: 'Secret' }], items: {
  'site:s': { description: '解决登录回调问题', tagIds: ['dev', 'project'] },
  'site:hidden': { description: 'Only private material', tagIds: ['secret'] },
  'note:n': { description: '', tagIds: ['dev'] },
  'reading:r': { description: 'Review this authentication solution', tagIds: ['dev', 'project'] },
  'site:deleted': { description: '', tagIds: ['secret'] },
} };

test('a remembered description retrieves its exact site or reading item', () => {
  assert.equal(searchCoveletContent(navigation, tools, '登录 回调', { library })[0].key, 'site:s');
  assert.match(searchCoveletContent(navigation, tools, 'authentication', { library })[0].subtitle, /authentication/);
  assert.equal(searchCoveletContent(navigation, tools, 'authentication', { library })[0].url, tools.reading[0].url);
});

test('tag filters intersect across sites, notes and reading, including an empty text query', () => {
  assert.deepEqual(searchCoveletContent(navigation, tools, '', { library, tagIds: ['dev', 'project'] }).map((item) => item.key), ['site:s', 'reading:r']);
  assert.equal(searchCoveletContent(navigation, tools, '', { library, tagIds: ['dev'] }).length, 3);
  assert.equal(searchCoveletContent(navigation, tools, '', { library, tagIds: ['missing'] }).length, 0);
  assert.equal(searchCoveletContent(navigation, tools, 'Project', { library, tagIds: ['dev'] })[0].key, 'note:n');
  assert.equal(searchCoveletContent(navigation, tools, '开发', { library }).length, 3);
});

test('hidden and deleted metadata cannot contribute results or selectable tags', () => {
  const hiddenKeys = new Set(['site:hidden']);
  assert.deepEqual(searchCoveletContent(navigation, tools, 'private', { library, hiddenKeys }), []);
  assert.deepEqual(searchCoveletContent(navigation, tools, '', { library, hiddenKeys, tagIds: ['secret'] }), []);
  assert.deepEqual(visibleContentTagIds(navigation, tools, library, hiddenKeys), ['dev', 'project']);
  assert.deepEqual(visibleContentTagIds([], {}, library), []);
});

test('editing metadata invalidates search without mutating the source records', () => {
  const original = structuredClone({ navigation, tools, library });
  const changed = structuredClone(library);
  changed.items['site:s'].description = 'A different reason';
  assert.equal(searchCoveletContent(navigation, tools, '登录', { library: changed }).length, 0);
  assert.deepEqual({ navigation, tools, library }, original);
});
