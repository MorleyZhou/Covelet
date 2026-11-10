import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { bookmarkExportScopes, serializeBookmarkExport } from './bookmark-export.js';
import { createEmptyState, parseBookmarks } from './model.js';

globalThis.DOMParser = new JSDOM('').window.DOMParser;

const site = (id, name, url, page, order, parentId = null) => ({ id, name, url, page, order, parentId, type: 'site' });
const folder = (id, name, page, order) => ({ id, name, page, order, parentId: null, type: 'folder' });
const pageLabel = (page) => ['Work & tools', '个人', 'Empty'][page];

function fixture() {
  const state = createEmptyState();
  state.settings.pages = [0, 1, 2];
  state.entries = [
    site('root', '<script> & "文档"', 'https://example.com/?one=1&two=2', 0, 0),
    folder('work', '资料 <参考>', 0, 1),
    site('first', '常用', 'https://first.example/', 0, 0, 'work'),
    site('private-site', '隐藏网站', 'https://hidden.example/', 0, 1, 'work'),
    folder('private-folder', '隐藏文件夹', 0, 2),
    site('nested-private', '文件夹内链接', 'https://nested-private.example/', 0, 0, 'private-folder'),
    site('unsafe', 'Unsafe', 'javascript:alert(1)', 0, 3),
    site('credentials', 'Credentials', 'https://person:token@secret.example/', 0, 4),
    site('personal', '个人链接', 'https://personal.example/', 1, 0),
  ];
  return state;
}

const hiddenKeys = new Set(['folder:private-folder', 'site:private-site']);

test('export restores desktop/folder hierarchy and omits marked-hidden names and URLs', () => {
  const state = fixture();
  const scopes = bookmarkExportScopes(state, hiddenKeys, pageLabel);
  assert.deepEqual(scopes.map((option) => option.value), ['all', 'page:0', 'page:1', 'page:2', 'folder:work']);
  const html = serializeBookmarkExport(state, { scope: 'all', hiddenKeys, pageLabel });
  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /one=1&amp;two=2/);
  assert.match(html, /&lt;script&gt; &amp; &quot;文档&quot;/);
  assert.doesNotMatch(html, /<script>|hidden\.example|nested-private|隐藏文件夹|隐藏网站|Empty|javascript:|person:token/);
  const plan = parseBookmarks(html);
  assert.deepEqual(plan.folders.map(({ originalPath }) => originalPath), ['Work & tools', 'Work & tools / 资料 <参考>', '个人']);
  assert.deepEqual(plan.sites.map(({ url }) => url), ['https://example.com/?one=1&two=2', 'https://first.example/', 'https://personal.example/']);
  assert.equal(plan.sites[0].name, '<script> & "文档"');
});

test('page and folder scopes export only their own links and reject empty or hidden scopes', () => {
  const state = fixture();
  const read = (scope) => parseBookmarks(serializeBookmarkExport(state, { scope, hiddenKeys, pageLabel }));
  assert.deepEqual(read('page:1').sites.map(({ name }) => name), ['个人链接']);
  assert.deepEqual(read('folder:work').sites.map(({ name }) => name), ['常用']);
  for (const scope of ['page:2', 'folder:private-folder', 'folder:missing']) assert.throws(() => read(scope), /没有可导出的网站/);
});
