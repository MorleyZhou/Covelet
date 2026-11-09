import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { parseBookmarks, applyBookmarkImport, createEmptyState, validateState } from './model.js';
import { readBookmarkFile } from './bookmark-file.js';
import { prepareImport } from './import-plan.js';
import { createStorage } from './storage.js';
import { localData } from './local-data.js';
import { LANGUAGES, setLanguagePreference, tr } from '../i18n/index.js';
import messages from '../i18n/messages.js';

// An HTML5 DOM exercises optional DT/P end-tag handling. Resource loading and
// script execution are disabled. Separate unpacked-extension QA uses Chromium.
globalThis.DOMParser = new JSDOM('').window.DOMParser;
const fixture = (name) => readFile(new URL(`../../tests/fixtures/bookmarks/${name}.html`, import.meta.url), 'utf8');
const html = (body) => `<!DOCTYPE NETSCAPE-Bookmark-file-1><META charset="UTF-8"><DL><p>${body}</DL><p>`;
const link = (url, name = 'Link') => `<DT><A HREF="${url}">${name}</A>`;

for (const [browser, count, paths] of [
  ['chrome', 5, ['Bookmarks bar', 'Bookmarks bar / 开发', 'Bookmarks bar / 开发 / 参考', 'Other bookmarks']],
  ['firefox', 3, ['Bookmarks Toolbar', 'Bookmarks Toolbar / 研究 & 资料', 'Other Bookmarks']],
  ['edge', 3, ['Favorites bar', 'Favorites bar / 工作 / 文档', 'Other favorites']],
]) test(`${browser} export preserves folder paths and links with letter icons`, async () => {
  const plan = parseBookmarks(await fixture(browser));
  assert.equal(plan.sites.length, count);
  assert.deepEqual(plan.folders.map((folder) => folder.originalPath), paths);
  const prepared = prepareImport(createEmptyState(), plan);
  assert.equal(prepared.addedSites, browser === 'chrome' ? 4 : count);
  assert.ok(prepared.state.entries.every((entry) => entry.icon.kind === 'letter' && !entry.iconUrl && !entry.iconVariants));
  for (const row of prepared.rows.filter((row) => row.willAdd && row.folder !== null)) {
    const entry = prepared.state.entries.find((entry) => entry.id === row.entryId);
    assert.equal(prepared.state.entries.find((folder) => folder.id === entry.parentId).name, row.folder);
  }
  assert.doesNotThrow(() => validateState(prepared.state));
  if (browser === 'chrome') {
    assert.equal(plan.sites[0].name, 'Example & 本地');
    assert.equal(plan.sites[2].name, '查询 <参考>');
    assert.equal(plan.sites[2].url, 'https://example.org/search?q=one&lang=zh#part');
    assert.equal(plan.sites.at(-1).folder, null, 'toolbar scope must not leak to later root links');
    assert.equal(plan.duplicateCount, 1, 'count duplicates across folders');
  }
  if (browser === 'firefox') {
    assert.equal(plan.invalid.length, 1, 'place: smart bookmarks are not web URLs');
    assert.equal(plan.sites[1].url, new URL('https://例子.中国/文档?q=中文&view=full').href);
  }
  if (browser === 'edge') assert.equal(plan.sites[2].url, 'http://example.net:8080/path?q=a%2Fb#fragment');
});

test('original fixture and explicitly closed DT sibling lists retain folder scope', async () => {
  const legacy = parseBookmarks(await readFile(new URL('../../tests/fixtures/bookmarks.html', import.meta.url), 'utf8'));
  assert.equal(legacy.sites.length, 7);
  assert.equal(legacy.invalid.length, 1);
  assert.equal(legacy.duplicateCount, 2);
  const plan = parseBookmarks(html('<DT><H3>Parent</H3></DT><DL><DT><H3>Child</H3></DT><DL>' + link('https://nested.test/') + '</DT></DL></DL>' + link('https://root.test/')));
  assert.equal(plan.sites[0].folder, 'Parent / Child');
  assert.equal(plan.sites[1].folder, null);
});

test('empty, non-HTML, unrelated HTML, malformed and oversized files have readable errors', () => {
  for (const value of ['', ' \n\t\uFEFF']) assert.throws(() => parseBookmarks(value), /书签文件为空/);
  for (const value of [null, undefined, {}, 42, 'https://example.com/', '{"bookmarks":[]}', '%PDF-1.7', '<html><a href="https://example.com/">Unrelated page</a></html>', '<DL><DT><A HREF="']) {
    assert.throws(() => parseBookmarks(value), /书签 HTML 文件|没有可导入的书签/);
  }
  assert.throws(() => parseBookmarks(html('')), /没有可导入的书签/);
  assert.throws(() => parseBookmarks('x'.repeat(5 * 1024 * 1024 + 1)), /不能超过 5 MB/);
  assert.throws(() => parseBookmarks('中'.repeat(2 * 1024 * 1024)), /不能超过 5 MB/, 'count UTF-8 bytes');
});

test('unsafe and malformed URLs stay in invalid rows and never reach navigation', () => {
  const urls = ['javascript:alert(1)', 'jav&#x61;script:alert(1)', 'java&#9;script:alert(1)', 'data:text/html,evil', 'file:///tmp/private', 'ftp://example.com/', 'about:blank', 'chrome://settings/', 'place:type=6', '/relative', '', 'https://user:pass@example.com/', 'https://bad_host.test', 'https://example.com\\@evil.test', 'https://'];
  const plan = parseBookmarks(html(urls.map((url) => link(url)).join('') + link('https://safe.test/', 'Safe')));
  assert.equal(plan.invalid.length, urls.length);
  assert.equal(plan.sites.length, 1);
  assert.ok(plan.invalid.every((row) => row.reason === tr('书签地址无效，仅支持不含用户名和密码的 HTTP 或 HTTPS 网址。')));
  assert.deepEqual(prepareImport(createEmptyState(), plan).state.entries.map((entry) => entry.url), ['https://safe.test/']);
  const invalidOnly = parseBookmarks(html(link('javascript:alert(1)')));
  assert.equal(invalidOnly.sites.length, 0);
  assert.equal(invalidOnly.invalid.length, 1, 'show a rejected-URL preview for an invalid-only export');
});

test('file size is checked before reading; read failures are localized', async () => {
  let reads = 0;
  await assert.rejects(readBookmarkFile({ size: 5 * 1024 * 1024 + 1, text() { reads++; } }), /不能超过 5 MB/);
  assert.equal(reads, 0);
  await assert.rejects(readBookmarkFile({ size: 1, text() { throw Error('OS-specific error'); } }), /无法读取书签文件/);
  await assert.rejects(readBookmarkFile(new Blob(['not HTML'])), /书签 HTML 文件/);
  assert.equal((await readBookmarkFile(new Blob([html(link('https://safe.test/'))]))).sites.length, 1);
});

test('Markdown files group local links by headings and use the normal import preview', async () => {
  const source = [
    'https://root.example/',
    '# 工作',
    '- [设计](https://design.example/path_(x)?one=1&two=2 "Design")',
    '## 参考',
    '- <https://docs.example/page>',
    '- [重复](https://design.example/path_(x)?one=1&two=2)',
    '~~~md',
    '[代码示例](https://ignored.example/)',
    '~~~',
    '<!-- [注释](https://ignored.example/) -->',
    '示例 `[代码](https://ignored.example/)`',
    '![图片](https://ignored.example/p.png)',
    '- [危险](javascript:alert(1))',
    '- [凭据](https://user:password@private.example/)',
    '# 工作',
    'https://last.example/',
    '空标题',
    '======',
  ].join('\r\n');
  const plan = await readBookmarkFile(new File([`\uFEFF${source}`], 'Links.MD'));
  assert.deepEqual(plan.folders.map(({ name, originalPath }) => [name, originalPath]), [
    ['工作', '工作'], ['工作 / 参考', '工作 / 参考'], ['工作 (2)', '工作'],
  ]);
  assert.deepEqual(plan.sites.map(({ url, folder, line }) => [url, folder, line]), [
    ['https://root.example/', null, 1], ['https://design.example/path_(x)?one=1&two=2', '工作', 3],
    ['https://docs.example/page', '工作 / 参考', 5], ['https://design.example/path_(x)?one=1&two=2', '工作 / 参考', 6],
    ['https://last.example/', '工作 (2)', 16],
  ]);
  assert.deepEqual(plan.invalid.map(({ line }) => line), [13, 14]);
  assert.equal(plan.duplicateCount, 1);
  const prepared = prepareImport(createEmptyState(), plan);
  assert.equal(prepared.addedSites, 4);
  assert.equal(prepared.addedFolders, 3);
  assert.equal(prepared.skippedDuplicates, 1);
  assert.ok(prepared.state.entries.every((entry) => entry.icon.kind === 'letter'));
});

test('Markdown files with no links, unsafe-only links or too many entries remain bounded', async () => {
  await assert.rejects(readBookmarkFile(new File(['# Empty\nText only.'], 'empty.md')), /没有可导入的网址/);
  const rejected = await readBookmarkFile(new File(['[Local](file:///example)'], 'blocked.md'));
  assert.equal(rejected.sites.length, 0);
  assert.equal(rejected.invalid.length, 1);
  await assert.rejects(readBookmarkFile(new File(['https://example.com/\n'.repeat(2001)], 'large.md')), /导入条目不能超过 2000/);
});

test('entry counts, invalid counts and deep nesting fail cleanly', () => {
  assert.throws(() => parseBookmarks(html(link('https://safe.test/').repeat(2001))), /导入条目不能超过 2000/);
  assert.throws(() => parseBookmarks(html(link('javascript:alert(1)').repeat(2001))), /无效书签不能超过 2000/);
  assert.throws(() => parseBookmarks(html('<DT><H3>Empty</H3><DL></DL>'.repeat(2001))), /导入条目不能超过 2000/);
  assert.throws(() => parseBookmarks(html('<DT><H3>Deep</H3><DL>'.repeat(70) + link('https://safe.test/') + '</DL>'.repeat(70))), /书签文件夹层级过深/);
});

test('long/colliding folder names stay unique and empty folders are omitted', () => {
  const title = '长'.repeat(240);
  const plan = parseBookmarks(html(`<DT><H3>${title}</H3><DL>${link('https://one.test/', 'A\nB')}</DL><DT><H3>${title}</H3><DL>${link('https://two.test/')}</DL><DT><H3>Empty</H3><DL></DL>`));
  assert.equal(plan.folders.length, 2);
  assert.equal(new Set(plan.folders.map((folder) => folder.name)).size, 2);
  assert.ok(plan.folders.every((folder) => folder.name.length <= 200));
  assert.equal(plan.sites[0].name, 'A B');
  assert.doesNotThrow(() => prepareImport(createEmptyState(), plan));
});

test('default conflict policy keeps local metadata across folders and skips file duplicates', () => {
  const initial = prepareImport(createEmptyState(), parseBookmarks(html('<DT><H3>Local</H3><DL>' + link('https://example.com/', 'Local title') + '</DL>'))).state;
  initial.entries[1].iconBackground = '#123456';
  initial.entries[1].iconUrl = 'https://icons.test/kept.png';
  const before = structuredClone(initial);
  const plan = parseBookmarks(html(link('https://EXAMPLE.com:443/', 'Changed title') + '<DT><H3>Duplicate only</H3><DL>' + link('https://example.com/') + '</DL><DT><H3>New</H3><DL>' + link('https://new.test/') + link('https://new.test') + '</DL>'));
  const prepared = prepareImport(initial, plan);
  assert.deepEqual(initial, before);
  assert.deepEqual(prepared.state.entries.slice(0, before.entries.length), before.entries);
  assert.equal(prepared.addedSites, 1);
  assert.equal(prepared.addedFolders, 1);
  assert.equal(prepared.skippedDuplicates, 3);
  assert.equal(prepared.state.entries.some((entry) => entry.name === 'Duplicate only'), false);
  const repeat = prepareImport(prepared.state, plan);
  assert.equal(repeat.addedSites, 0);
  assert.equal(repeat.skippedDuplicates, 4);
  assert.deepEqual(repeat.state.entries, prepared.state.entries);
  const compatibility = applyBookmarkImport(initial, plan);
  assert.deepEqual(compatibility.entries.slice(0, before.entries.length), before.entries);
  assert.equal(compatibility.entries.filter((entry) => entry.type === 'site').length, 2);
  assert.equal(compatibility.entries.some((entry) => entry.name === 'Duplicate only'), false);
  const append = prepareImport(initial, plan, { skipDuplicates: false });
  assert.deepEqual(append.state.entries.slice(0, before.entries.length), before.entries, 'duplicate copies never overwrite local content');
  assert.equal(append.addedSites, 4);
});

test('selection, folder destinations and existing occupied seats survive import', async () => {
  const initial = prepareImport(createEmptyState(), parseBookmarks(html(link('https://local.test/', 'Local')))).state;
  const before = structuredClone(initial);
  const plan = parseBookmarks(await fixture('edge'));
  const prepared = prepareImport(initial, plan, { selectedIndices: [1], page: 0, columns: 8 });
  assert.equal(prepared.addedSites, 1);
  assert.deepEqual(prepared.state.entries[0], before.entries[0]);
  assert.notDeepEqual(prepared.state.entries[1].position, before.entries[0].position);
  const folderId = prepared.state.entries.find((entry) => entry.type === 'folder').id;
  const targeted = prepareImport(prepared.state, plan, { selectedIndices: [0], targetFolderId: folderId });
  assert.equal(targeted.addedFolders, 0);
  assert.equal(targeted.state.entries.at(-1).parentId, folderId);
  const duplicates = parseBookmarks(html(link('https://same.test/') + link('https://same.test/')));
  assert.equal(prepareImport(createEmptyState(), duplicates, { selectedIndices: [1] }).addedSites, 1, 'an unchecked first copy cannot block a selected copy');
  assert.throws(() => prepareImport(initial, plan, { selectedIndices: [-1] }), /导入选择无效/);
});

test('file → parse → prepare → save/reload makes no fetch or XHR, including hostile resource markup', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', (...args) => { requests.push(args); throw Error('Network forbidden'); });
  const originalXHR = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class { constructor() { requests.push('XHR'); throw Error('Network forbidden'); } };
  t.after(() => { if (originalXHR === undefined) delete globalThis.XMLHttpRequest; else globalThis.XMLHttpRequest = originalXHR; });
  const markup = html('<script>globalThis.bookmarkExecuted=true</script><img src="https://tracker.test/pixel"><iframe src="https://tracker.test/frame"></iframe><link rel="stylesheet" href="https://tracker.test/style"><DD><A HREF="https://description.test/">Description</A>' + link('https://safe.test/', '&lt;img src=x onerror=alert(1)&gt;'));
  const plan = await readBookmarkFile(new Blob([markup]));
  assert.equal(plan.sites.length, 1);
  assert.equal(globalThis.bookmarkExecuted, undefined);
  let envelope;
  const config = { async read() { return structuredClone(envelope); }, async write(value) { envelope = structuredClone(value); }, subscribe() { return () => {}; } };
  const storage = createStorage({ configStore: config, initialState: createEmptyState });
  const prepared = prepareImport(await storage.loadState(), plan);
  const saved = await storage.saveState(prepared.state, prepared.sourceRevision);
  assert.deepEqual(await createStorage({ configStore: config, initialState: createEmptyState }).loadState(), saved);
  assert.equal(saved.entries[0].name, '<img src=x onerror=alert(1)>');
  await assert.rejects(storage.saveState(prepared.state, prepared.sourceRevision), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(requests, []);
});

const importMessages = [
  '请选择浏览器导出的书签 HTML 文件。', '书签文件为空，请选择浏览器导出的 HTML 文件。', '文件中没有可导入的书签。',
  '书签文件夹层级过深，请减少层级后重试。', '无法读取书签文件，请重新选择。', '书签地址无效，仅支持不含用户名和密码的 HTTP 或 HTTPS 网址。',
  '未命名文件夹', '导入书签 HTML 文件', '导入网址与书签 HTML', '支持 Chrome、Firefox 和 Edge 导出的书签 HTML 文件，仅在本机处理。',
  '已导入 {0} 个网址，跳过 {1} 条重复网址。', '导入条目不能超过 {0}', '无效书签不能超过 {0}', '当前环境不能解析书签 HTML', '书签文件不能超过 5 MB',
];
test('import strings cover eight locales with matching parameters and localized errors', async (t) => {
  t.mock.method(localData, 'set', async () => {});
  for (const { value: locale } of LANGUAGES) {
    for (const key of importMessages) {
      if (locale === 'zh-CN') continue; // Simplified Chinese uses the source phrase.
      assert.ok(messages[key]?.[locale], `${locale}: ${key}`);
      assert.deepEqual([...messages[key][locale].matchAll(/\{\d+\}/g)].map(([value]) => value).sort(), [...key.matchAll(/\{\d+\}/g)].map(([value]) => value).sort());
    }
    await setLanguagePreference(locale);
    assert.throws(() => parseBookmarks(''), { message: tr('书签文件为空，请选择浏览器导出的 HTML 文件。') });
    assert.throws(() => parseBookmarks('not HTML'), { message: tr('请选择浏览器导出的书签 HTML 文件。') });
  }
  await setLanguagePreference('zh-CN');
});
