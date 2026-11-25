import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { PresentationContext } from './presentation.js';
import { LANGUAGES } from '../i18n/index.js';
import catalog from '../i18n/catalog.json' with { type: 'json' };

const appRoot = fileURLToPath(new URL('../../', import.meta.url)), outputRoot = resolve(appRoot, '../output/playwright');
const record = { id: 'reading-one', url: 'https://article.example/story', title: 'Saved link', revision: 1 };
const paragraph = 'Alpha selection beta. <script>literal</script>';
const article = () => ({ id: record.id, url: record.url, title: 'Local article', text: `${paragraph}\n\nIllustration`, revision: 1, createdAt: 1, updatedAt: 1, highlights: [],
  blocks: [{ type: 'paragraph', text: paragraph, start: 0, end: paragraph.length }, { type: 'image', text: 'Illustration', url: 'https://images.example/one.png', start: paragraph.length + 2, end: paragraph.length + 14 }] });
const library = () => ({ version: 1, revision: 1, articles: { [record.id]: article() }, settings: { fontSize: 18, lineHeight: 1.8, theme: 'system' } });
test('local reader and RSS inbox keep network explicit, annotations guarded and private content hidden', async t => {
  await mkdir(outputRoot, { recursive: true }); const temporary = await mkdtemp(join(outputRoot, '.reading-reader-ui-')), output = join(temporary, 'reader.mjs');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://covelet.test/', pretendToBeVisual: true }), globals = new Map();
  for (const key of ['window', 'document', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'DocumentFragment', 'MutationObserver', 'CustomEvent']) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key] });
  }
  for (const [key, value] of Object.entries({ getComputedStyle: dom.window.getComputedStyle.bind(dom.window), getSelection: dom.window.getSelection.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL, revoked = []; let blobId = 0;
  URL.createObjectURL = () => `blob:reader-test-${++blobId}`; URL.revokeObjectURL = url => revoked.push(url);
  t.after(async () => { dom.window.close(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } assert.equal(dirname(temporary), outputRoot); assert.ok(basename(temporary).startsWith('.reading-reader-ui-')); await rm(temporary, { recursive: true, force: true }); });
  await build({ stdin: { contents: "export {default as ReadingReader} from './src/components/ReadingReader.jsx';export {default as RssInbox} from './src/components/RssInbox.jsx';", resolveDir: appRoot }, outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' },
    plugins: [{ name: 'reader-test-domain', setup(builder) {
      builder.onResolve({ filter: /(?:reading-library|site-info|markdown-library|rss-inbox)\.js$/ }, () => ({ path: 'domain', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const loadReadingLibrary=()=>{},subscribeReadingLibrary=()=>()=>{},saveReadingArticle=()=>{},addReadingHighlight=()=>{},updateReadingHighlight=()=>{},deleteReadingHighlight=()=>{},saveReadingSettings=()=>{},fetchReadingImage=()=>{},removeReadingArticle=()=>{},requestSiteAccess=()=>{},exportReadingMarkdown=()=>{},rssInbox={};export const rssFeedOrigin=url=>new URL(url).origin;`, loader: 'js' }));
      builder.onResolve({ filter: /PromptDialog\.jsx$/ }, () => ({ path: 'prompt', namespace: 'prompt' }));
      builder.onLoad({ filter: /.*/, namespace: 'prompt' }, () => ({ contents: "import React from 'react';export default function Prompt({children,action,onConfirm,onCancel}){return React.createElement('div',{role:'alertdialog'},children,React.createElement('button',{onClick:onCancel},'取消'),React.createElement('button',{onClick:onConfirm},action));}", loader: 'js' }));
      builder.onResolve({ filter: /presentation\.js$/ }, () => ({ path: new URL('./presentation.js', import.meta.url).href, external: true }));
      builder.onResolve({ filter: /i18n\/index\.js$/ }, () => ({ path: new URL('../i18n/index.js', import.meta.url).href, external: true }));
      builder.onResolve({ filter: /^[^./][^:]*$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
    } }],
  });
  const { ReadingReader, RssInbox } = await import(pathToFileURL(output).href), { createRoot } = await import('react-dom/client');
  function Dialog({ title, children }) { return React.createElement('section', { role: 'dialog', 'aria-label': title }, children); }
  const button = (text, scope = document) => [...scope.querySelectorAll('button')].find(element => element.textContent.trim() === text);
  let gesture = false;
  async function click(control) { assert.ok(control, 'expected control'); assert.equal(control.disabled, false); await act(async () => { gesture = true; control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); gesture = false; }); }
  async function fill(control, value) { await act(async () => { Object.getOwnPropertyDescriptor(control.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype, 'value').set.call(control, value); control.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
  async function mount(Component, props) {
    document.body.innerHTML = '<div id="root"></div>'; const root = createRoot(document.querySelector('#root')); let current = props, context = { active: false, hiddenKeys: new Set() };
    async function render(patch = {}, privacy) { current = { ...current, ...patch }; if (privacy) context = { ...context, ...privacy }; await act(async () => root.render(React.createElement(PresentationContext.Provider, { value: context }, React.createElement(Component, { Dialog, ...current })))); }
    await render(); return { render, close: async () => act(async () => root.unmount()) };
  }
  async function reader(options = {}) {
    let state = options.library || library(); const listeners = new Set(), calls = { requests: [], images: [], adds: [], updates: [], deletes: [], removes: [], exports: 0, saves: 0, closed: 0 };
    const publish = () => { for (const listener of listeners) listener(structuredClone(state)); };
    const mutate = update => { update(state.articles[record.id]); state.articles[record.id].revision++; state.revision++; publish(); };
    const props = { record, preferencesRevision: 3, loadLibrary: options.load || (async () => structuredClone(state)), subscribeLibrary: callback => { listeners.add(callback); return () => listeners.delete(callback); },
      requestAccess: url => { calls.requests.push({ url, gesture }); return Promise.resolve(true); }, fetchImage: async (url, opts) => { calls.images.push({ url, aborted: opts.signal.aborted }); return new Blob(['synthetic'], { type: 'image/png' }); },
      addHighlight: async (id, value, guard) => { calls.adds.push({ id, value, guard }); mutate(article => article.highlights.push({ ...value, id: 'highlight-one', revision: 1, createdAt: 1, updatedAt: 1 })); },
      updateHighlight: async (id, highlightId, value, guard) => { calls.updates.push({ id, highlightId, value, guard }); mutate(article => { const item = article.highlights.find(item => item.id === highlightId); item.note = value.note; item.revision++; }); },
      deleteHighlight: async (id, highlightId, guard) => { calls.deletes.push({ id, highlightId, guard }); mutate(article => { article.highlights = article.highlights.filter(item => item.id !== highlightId); }); },
      removeArticle: async (id, guard) => { calls.removes.push({ id, guard }); delete state.articles[id]; state.revision++; publish(); },
      saveSettings: async patch => { state.settings = { ...state.settings, ...patch }; state.revision++; publish(); }, saveArticle: async () => { calls.saves++; return null; }, exportMarkdown: async () => { calls.exports++; }, onClose: () => { calls.closed++; }, ...options.props };
    const ui = await mount(ReadingReader, props); return { ...ui, calls, get state() { return state; }, publish: async () => act(async () => publish()) };
  }
  function select(start, end) {
    const text = document.querySelector('[data-reading-block-text] span').firstChild, range = document.createRange(); range.setStart(text, start); range.setEnd(text, end);
    const selection = dom.window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.querySelector('.reading-reader-article').dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  }
  await t.test('opening cached body is local, HTML stays literal, and images load only after an exact-origin click', async () => {
    const ui = await reader();
    try { assert.equal(ui.calls.requests.length, 0); assert.equal(ui.calls.images.length, 0); assert.equal(document.querySelectorAll('img,script,iframe').length, 0); assert.match(document.body.textContent, /<script>literal<\/script>/);
      await click(button('点击加载图片')); assert.deepEqual(ui.calls.requests, [{ url: 'https://images.example/one.png', gesture: true }]); assert.equal(ui.calls.images.length, 1); assert.match(document.querySelector('img').src, /^blob:/);
    } finally { await ui.close(); } assert.ok(revoked.length > 0);
  });
  await t.test('selection offsets, note editing and deletion use revision guards without losing a dirty note to a new selection', async () => {
    const ui = await reader();
    try { await act(async () => select(6, 15)); await fill(document.querySelector('textarea[aria-label="批注"]'), 'Unsaved note');
      await act(async () => select(0, 5)); assert.equal(document.querySelector('.reading-reader-annotation-draft blockquote').textContent, 'selection'); assert.equal(document.querySelector('textarea').value, 'Unsaved note');
      await click(button('保存高亮')); assert.deepEqual(ui.calls.adds[0], { id: record.id, value: { start: 6, end: 15, quote: 'selection', note: 'Unsaved note' }, guard: { expectedRevision: 1, expectedPreferencesRevision: 3, expectedReadingRevision: 1 } });
      assert.equal(document.querySelectorAll('mark').length, 1); await click(button('编辑批注')); await fill(document.querySelector('textarea'), 'Updated note'); await click(button('编辑批注')); assert.equal(document.querySelector('textarea').value, 'Updated note'); await click(button('保存批注'));
      assert.equal(ui.calls.updates[0].guard.expectedHighlightRevision, 1); assert.equal(ui.state.articles[record.id].highlights[0].note, 'Updated note'); await click(button('编辑批注')); await click(button('删除高亮')); assert.equal(ui.calls.deletes[0].guard.expectedHighlightRevision, 2); assert.equal(document.querySelector('textarea'), null); assert.equal(document.querySelectorAll('mark').length, 0);
    } finally { await ui.close(); }
  });
  await t.test('a mismatched old URL can be removed explicitly without changing the saved link or requesting network', async () => {
    const state = library(); state.articles[record.id].url = 'https://old.example/story'; const ui = await reader({ library: state });
    try { assert.match(document.body.textContent, /尚未保存正文/); assert.equal(document.querySelector('.reading-reader-article'), null); await click(button('移除本机正文')); assert.equal(ui.calls.removes.length, 0); await click(button('移除正文', document.querySelector('[role=alertdialog]'))); assert.equal(ui.calls.removes[0].guard.expectedRevision, 1); assert.equal(ui.calls.requests.length, 0); assert.equal(record.url, 'https://article.example/story'); assert.ok(button('提取正文')); }
    finally { await ui.close(); }
  });
  await t.test('delayed library reads cannot reveal a hidden reader, and marked-private export stays disabled', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; }); const ui = await reader({ load: () => gate });
    try { await ui.render({}, { active: true, hiddenKeys: new Set([`reading:${record.id}`]) }); await act(async () => release(library())); assert.equal(document.querySelector('[role=dialog]'), null); assert.doesNotMatch(document.body.textContent, /Local article|Alpha selection/); }
    finally { release(library()); await ui.close(); }
    const guarded = await reader({ props: { exportBlocked: true } }); try { assert.equal(button('导出 Markdown').disabled, true); assert.equal(guarded.calls.exports, 0); } finally { await guarded.close(); }
  });
  await t.test('a newer local library notification cannot be overwritten by the older opening read', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; }); const ui = await reader({ load: () => gate });
    try { ui.state.articles[record.id].title = 'Latest event title'; await ui.publish(); assert.equal(document.querySelector('.reading-reader-article h1').textContent, 'Latest event title');
      await act(async () => release(library())); assert.equal(document.querySelector('.reading-reader-article h1').textContent, 'Latest event title'); assert.equal(ui.calls.requests.length, 0);
    } finally { release(library()); await ui.close(); }
  });
  await t.test('RSS is plain text, filters hidden reading URLs before display and delegates refresh to background', async () => {
    const state = { version: 1, revision: 1, feeds: [{ id: 'feed-one', title: 'Test feed', lastSuccess: 0, lastError: null }], items: [{ id: 'item-private', feedId: 'feed-one', url: 'https://hidden.example/private', title: 'HIDDEN TITLE', summary: 'PRIVATE SUMMARY', savedReadingId: null, receivedAt: 1 }, { id: 'item-visible', feedId: 'feed-one', url: record.url, title: 'Visible item', summary: '<img src="https://tracker.example/pixel">', savedReadingId: null, receivedAt: 1 }] };
    const messages = [], saved = [], accesses = [], opened = [];
    const ui = await mount(RssInbox, { hiddenReadingUrls: new Set(['https://hidden.example/private']), inbox: { load: async () => state, subscribe: () => () => {}, save: async id => { saved.push(id); return record; } }, sendMessage: async message => { messages.push(message); return { ok: true, status: state }; }, requestAccess: url => { accesses.push({ url, gesture }); return Promise.resolve(false); }, saveArticle: async () => { throw Error('Denied permission must not fetch article'); }, onOpenReading: value => opened.push(value) });
    try { assert.equal(accesses.length, 0); assert.doesNotMatch(document.body.textContent, /HIDDEN TITLE|PRIVATE SUMMARY/); assert.equal(document.querySelectorAll('.rss-inbox-items article').length, 1); assert.equal(document.querySelectorAll('img,iframe,script').length, 0); await click(button('更新订阅')); assert.deepEqual(messages, [{ type: 'covelet:rss:refresh' }]); await click(button('保存并阅读')); assert.deepEqual(saved, ['item-visible']); assert.deepEqual(accesses, [{ url: record.url, gesture: true }]); assert.equal(opened[0].id, record.id); }
    finally { await ui.close(); }
  });
});

test('reader, RSS and related failure messages have all packaged translations', async () => {
  const keys = new Set();
  for (const file of ['../components/ReadingReader.jsx', '../components/RssInbox.jsx', './reading-library.js', './rss-inbox.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8'); for (const match of source.matchAll(/tr\(['"]([^'"]+)['"]/g)) keys.add(match[1]);
    if (file.includes('rss-inbox')) for (const match of source.matchAll(/RSS_[A-Z_]+:\s*'([^']+)'/g)) keys.add(match[1]);
  }
  for (const key of keys) for (const { value: language } of LANGUAGES.filter(item => item.value !== 'zh-CN')) { assert.equal(typeof catalog[key]?.[language], 'string', `${language}: ${key}`); assert.ok(catalog[key][language].trim()); }
});
