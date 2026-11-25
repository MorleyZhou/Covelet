import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { PresentationContext } from './presentation.js';
import { createEmptyState } from './model.js';
import { LANGUAGES } from '../i18n/index.js';
import catalog from '../i18n/catalog.json' with { type: 'json' };

const appRoot = fileURLToPath(new URL('../../', import.meta.url)), outputRoot = resolve(appRoot, '../output/playwright');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const session = (id, title, count = 30) => ({ id, title, revision: 1, createdAt: 1, updatedAt: 1,
  tabs: Array.from({ length: count }, (_, index) => ({ url: `https://${id}.example/${index}`, title: `${title} ${index}`, pinned: false })) });

test('command palette keeps browser grants explicit, keyboard safe and session restores reviewable', async t => {
  await mkdir(outputRoot, { recursive: true }); const temporary = await mkdtemp(join(outputRoot, '.command-palette-ui-')), output = join(temporary, 'palette.mjs');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://covelet.test/', pretendToBeVisual: true }), previous = new Map();
  for (const key of ['window', 'document', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement', 'DocumentFragment', 'MutationObserver', 'CustomEvent']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key] });
  }
  for (const [key, value] of Object.entries({ getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(async () => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } assert.equal(dirname(temporary), outputRoot); assert.ok(basename(temporary).startsWith('.command-palette-ui-')); await rm(temporary, { recursive: true, force: true }); });
  await build({ stdin: { contents: "export {default as CommandPalette} from './src/components/CommandPalette.jsx';", resolveDir: appRoot }, outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty', '.wasm': 'dataurl' }, plugins: [{ name: 'command-test-domain', setup(builder) {
    builder.onResolve({ filter: /browser-(?:command|sessions)\.js$/ }, () => ({ path: 'domain', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const unused=true;', loader: 'js' }));
    builder.onResolve({ filter: /PromptDialog\.jsx$/ }, () => ({ path: 'prompt', namespace: 'prompt' }));
    builder.onLoad({ filter: /.*/, namespace: 'prompt' }, () => ({ contents: "import React from 'react';export default function Prompt({children,action,onConfirm,onCancel,busy}){return React.createElement('div',{role:'alertdialog'},children,React.createElement('button',{disabled:busy,onClick:onCancel},'取消'),React.createElement('button',{disabled:busy,onClick:onConfirm},action));}", loader: 'js' }));
    for (const name of ['presentation', 'i18n/index']) builder.onResolve({ filter: name === 'presentation' ? /presentation\.js$/ : /i18n\/index\.js$/ }, () => ({ path: new URL(name === 'presentation' ? './presentation.js' : '../i18n/index.js', import.meta.url).href, external: true }));
    builder.onResolve({ filter: /^[^./][^:]*$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
  } }] });
  const { CommandPalette } = await import(pathToFileURL(output).href), { createRoot } = await import('react-dom/client');
  const button = (text, scope = document) => [...scope.querySelectorAll('button')].find(control => control.textContent.trim() === text);
  let gesture = false;
  async function click(control) { assert.ok(control, 'expected control'); assert.equal(control.disabled, false); await act(async () => { gesture = true; control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); gesture = false; }); }
  async function fill(control, value) { assert.ok(control); await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(control, value); control.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
  async function key(control, name, options = {}) { await act(async () => control.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options }))); }
  const flush = () => act(async () => wait(150));
  function Dialog({ children, onClose, onEscapeKeyDown, closeDisabled }) {
    React.useEffect(() => { const escape = event => { if (event.key === 'Escape') { onEscapeKeyDown?.(event); if (!event.defaultPrevented && !closeDisabled) onClose(); } }; document.addEventListener('keydown', escape, true); return () => document.removeEventListener('keydown', escape, true); }, [onClose, onEscapeKeyDown, closeDisabled]);
    return React.createElement('section', { role: 'dialog' }, React.createElement('button', { 'aria-label': '关闭', disabled: closeDisabled, onClick: onClose }, '×'), children);
  }
  async function fixture(options = {}) {
    const calls = { permissions: [], requests: [], searches: [], closes: [], activates: [], opens: [], closed: 0, commands: [], content: [], loads: 0, captures: [], capturePreviews: 0, previews: [], batches: [], cancelled: [], renames: [], deletes: [] };
    const permissions = new Set(), subscriptions = new Set(); let granted = options.granted ?? true, library = { version: 1, revision: 1, sessions: [session('alpha', 'Alpha'), session('beta', 'Beta')] };
    let rows = [{ id: 'one', source: 'tabs', tabId: 1, windowId: 1, title: 'Tab one', url: 'https://one.example/' }, { id: 'two', source: 'tabs', tabId: 2, windowId: 1, title: 'Tab two', url: 'https://two.example/' }];
    const browserApi = {
      async browserCommandPermissions(source) { calls.permissions.push(source); return { available: true, granted, permission: source }; },
      requestBrowserCommandPermission(source) { calls.requests.push({ source, gesture }); granted = true; return Promise.resolve(true); },
      subscribeBrowserCommandPermissions(listener) { permissions.add(listener); return () => permissions.delete(listener); },
      async searchBrowserCommands(source, query, guard) { calls.searches.push({ source, query, ...guard }); return options.search ? options.search(source, query, guard) : rows; },
      async activateBrowserTab(row, guard) { calls.activates.push({ row, ...guard }); if (options.activate) await options.activate(row, guard); },
      async closeBrowserTab(row, guard) { calls.closes.push({ row, ...guard }); rows = rows.filter(item => item !== row); },
      async openBrowserCommand(row, guard) { calls.opens.push({ row, ...guard }); },
    };
    const capturePreview = Object.freeze({ tabs: [session('saved', 'Captured', 1).tabs[0]], supported: 1, duplicates: 1, unsupported: 1, total: 3 });
    const plans = new WeakMap();
    function progress(entries, record) { const count = status => entries.filter(entry => entry.status === status).length; return { sessionId: record.id, title: record.title, revision: record.revision, tabs: structuredClone(entries), opened: count('opened'), skipped: count('skipped'), failed: count('failed'), pending: count('pending'), complete: !count('pending') && !count('failed') }; }
    const sessionsApi = {
      async loadBrowserSessions() { calls.loads++; return options.load ? options.load(calls.loads, library) : structuredClone(library); },
      subscribeBrowserSessions(listener) { subscriptions.add(listener); return () => subscriptions.delete(listener); },
      async previewCurrentBrowserSession() { calls.capturePreviews++; return options.capturePreview ? options.capturePreview() : capturePreview; },
      async captureCurrentBrowserSession(value, guard) { calls.captures.push({ value, guard }); library = { ...library, revision: library.revision + 1, sessions: [...library.sessions, session('captured', value.title, 1)] }; },
      async renameBrowserSession(id, title, guard) { calls.renames.push({ id, title, guard }); library.sessions.find(item => item.id === id).title = title; library.revision++; },
      async deleteBrowserSession(id, guard) { calls.deletes.push({ id, guard }); library.sessions = library.sessions.filter(item => item.id !== id); library.revision++; },
      async previewBrowserSessionRestore(id, guard) {
        calls.previews.push({ id, guard }); if (options.restorePreview) return options.restorePreview(id, guard);
        const record = library.sessions.find(item => item.id === id), entries = record.tabs.filter(tab => !guard.selectedUrls || guard.selectedUrls.includes(tab.url)).map(tab => ({ ...tab, status: 'pending' }));
        const preview = Object.freeze(progress(entries, record)); plans.set(preview, { entries, record }); return preview;
      },
      async restoreBrowserSessionBatch(original, guard) {
        calls.batches.push({ original, guard }); const plan = plans.get(original); assert.ok(plan, 'preserve the original opaque preview');
        for (const entry of plan.entries.filter(item => item.status === 'pending' || guard.retryFailed && item.status === 'failed').slice(0, 10)) entry.status = 'opened';
        const result = progress(plan.entries, plan.record);
        if (options.partialFailure && calls.batches.length === 1) throw Object.assign(Error('PRIVATE ERROR'), { progress: result });
        return result;
      },
      cancelBrowserSessionRestore(preview) { calls.cancelled.push(preview); },
    };
    const props = { Dialog, navigation: createEmptyState(), tools: { notes: [{ id: 'visible', title: 'Visible note', body: 'Body', updatedAt: 1 }], reading: [], trash: [] },
      preferences: { version: 1, revision: 0, aliases: {}, privateKeys: [], presentation: false }, hiddenKeys: [], today: '2026-11-25', browserApi, sessionsApi,
      actions: [{ id: 'first', title: 'First action', run: () => calls.commands.push('first') }, { id: 'second', title: 'Second action', run: () => calls.commands.push('second') }],
      onClose: () => { calls.closed++; }, onSearch() {}, onOpen: item => calls.content.push(item), ...options.props };
    document.body.innerHTML = '<div id="root"></div>'; const root = createRoot(document.querySelector('#root')); let context = { active: false, hiddenKeys: new Set() };
    async function render(privacy) { if (privacy) context = { ...context, ...privacy }; await act(async () => root.render(React.createElement(PresentationContext.Provider, { value: context }, React.createElement(CommandPalette, props)))); }
    await render();
    return { calls, browserApi, sessionsApi, capturePreview, render, get library() { return library; },
      async source(source) { await act(async () => { const select = document.querySelector('select[aria-label="搜索来源"]'); select.value = source; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); await flush(); },
      async permission(value) { granted = value; await act(async () => { for (const listener of permissions) listener(); }); },
      async publish() { await act(async () => { for (const listener of subscriptions) listener(); }); },
      close: () => act(async () => root.unmount()) };
  }
  await t.test('default content preserves structured local search without reading browser sources', async () => {
    const ui = await fixture(); try {
      await flush(); assert.equal(ui.calls.permissions.length, 0); assert.equal(ui.calls.searches.length, 0);
      await fill(document.querySelector('[role=combobox]'), 'type:note');
      assert.match(document.querySelector('.command-results').textContent, /Visible note/); assert.doesNotMatch(document.querySelector('.command-results').textContent, /First action/);
      await key(document.querySelector('[role=combobox]'), 'Enter'); assert.equal(ui.calls.content.length, 1); assert.equal(ui.calls.content[0].id, 'visible');
    } finally { await ui.close(); }
  });
  await t.test('source grants happen only on a click and tab rows have separate close and switch actions', async () => {
    const ui = await fixture({ granted: false }); try {
      await ui.source('tabs'); assert.equal(ui.calls.requests.length, 0); assert.equal(ui.calls.searches.length, 0);
      await click(button('授权此来源')); await flush(); assert.deepEqual(ui.calls.requests, [{ source: 'tabs', gesture: true }]);
      assert.equal(document.querySelectorAll('button button').length, 0);
      await click(button('关闭标签页')); await flush(); assert.equal(ui.calls.closes.length, 1); assert.equal(ui.calls.closes[0].row.tabId, 1);
      await key(document.querySelector('[role=combobox]'), 'Enter'); assert.equal(ui.calls.activates[0].row.tabId, 2); assert.equal(ui.calls.closed, 1);
    } finally { await ui.close(); }
  });
  await t.test('late browser queries cannot replace a newer query or expose results after hiding', async () => {
    const old = deferred(), fresh = deferred(), ui = await fixture({ search: (_, query) => query === 'old' ? old.promise : query === 'fresh' ? fresh.promise : [] });
    try {
      await ui.source('tabs'); await fill(document.querySelector('[role=combobox]'), 'old'); await flush(); await fill(document.querySelector('[role=combobox]'), 'fresh'); await flush();
      await act(async () => fresh.resolve([{ id: 'fresh', title: 'Fresh result', url: 'https://fresh.example/' }]));
      await act(async () => old.resolve([{ id: 'old', title: 'PRIVATE OLD', url: 'https://private.example/' }]));
      assert.match(document.body.textContent, /Fresh result/); assert.doesNotMatch(document.body.textContent, /PRIVATE OLD/);
      await ui.render({ active: true }); assert.doesNotMatch(document.body.textContent, /Fresh result|fresh\.example|当前匹配/);
    } finally { await ui.close(); }
  });
  await t.test('hiding aborts an in-flight destructive browser action before its live checks finish', async () => {
    const pending = deferred(), ui = await fixture({ activate: async (_, { signal }) => { await pending.promise; assert.equal(signal.aborted, true); } });
    try {
      await ui.source('tabs'); await click(document.querySelector('.command-result-open')); assert.equal(ui.calls.activates.length, 1);
      await ui.render({ active: true }); assert.equal(ui.calls.activates[0].signal.aborted, true);
      await act(async () => pending.resolve()); assert.equal(ui.calls.closed, 0); assert.doesNotMatch(document.body.textContent, /Tab one|one\.example/);
    } finally { await ui.close(); }
  });
  await t.test('IME key 229 and composition Enter or Escape never execute or close the palette', async () => {
    const ui = await fixture(); try {
      const input = document.querySelector('[role=combobox]');
      await key(input, 'Enter', { keyCode: 229 }); await key(input, 'Enter', { isComposing: true }); await key(input, 'Escape', { keyCode: 229 }); await key(input, 'Escape', { isComposing: true });
      assert.equal(ui.calls.closed, 0); assert.equal(ui.calls.commands.length, 0);
      await key(input, 'ArrowDown'); await key(input, 'Enter'); assert.deepEqual(ui.calls.commands, ['second']);
    } finally { await ui.close(); }
  });
  await t.test('saved session rename and deletion work without tab permission and guard IME form submission', async () => {
    const ui = await fixture({ granted: false }); try {
      await ui.source('sessions'); assert.match(document.body.textContent, /Alpha/); assert.equal(ui.calls.capturePreviews, 0);
      await click(button('重命名')); const field = document.querySelector('[aria-label="新的会话名称"]'); await fill(field, 'Renamed');
      await key(field, 'Enter', { keyCode: 229 }); assert.equal(ui.calls.renames.length, 0);
      await click(button('保存名称')); assert.deepEqual(ui.calls.renames[0], { id: 'alpha', title: 'Renamed', guard: { expectedRevision: 1 } });
      await click(button('删除')); assert.equal(ui.calls.deletes.length, 0); await click(button('删除', document.querySelector('[role=alertdialog]'))); assert.equal(ui.calls.deletes.length, 1);
      assert.equal(ui.calls.requests.length, 0);
    } finally { await ui.close(); }
  });
  await t.test('capture requires a named snapshot preview and a second explicit save', async () => {
    const ui = await fixture(); try {
      await ui.source('sessions'); await click(button('保存当前窗口')); await fill(document.querySelector('[aria-label="会话名称"]'), 'Window capture');
      await key(document.querySelector('[aria-label="会话名称"]'), 'Enter', { keyCode: 229 }); assert.equal(ui.calls.capturePreviews, 0);
      await click(button('预览当前窗口')); assert.match(document.body.textContent, /可保存 1 个链接，重复 1 个，不支持 1 个/); assert.equal(ui.calls.captures.length, 0);
      await click(button('确认保存会话')); assert.equal(ui.calls.captures[0].value.preview, ui.capturePreview); assert.equal(ui.calls.captures[0].guard.expectedRevision, 1);
    } finally { await ui.close(); }
  });
  await t.test('session arrows and Enter preview only, selection re-previews, and restoring requires three separate batches', async () => {
    const ui = await fixture(); try {
      await ui.source('sessions'); const input = document.querySelector('[role=combobox]'); await key(input, 'ArrowDown'); await key(input, 'Enter');
      assert.equal(ui.calls.previews[0].id, 'beta'); assert.equal(ui.calls.batches.length, 0);
      await click(document.querySelector('.browser-session-restore input[type=checkbox]')); await click(button('更新恢复预览')); assert.equal(ui.calls.previews[1].guard.selectedUrls.length, 29);
      await click(button('关闭恢复预览')); assert.equal(ui.calls.batches.length, 0); assert.ok(ui.calls.cancelled.length);
      await key(input, 'Enter'); await click(button('确认恢复，打开第一批')); assert.match(document.body.textContent, /已打开 10，已跳过 0，失败 0，剩余 20/);
      await click(button('继续下一批')); assert.equal(ui.calls.batches.length, 2); await click(button('继续下一批')); assert.equal(ui.calls.batches.length, 3);
      assert.equal(ui.calls.batches[0].original, ui.calls.batches[2].original); assert.match(document.body.textContent, /会话恢复已完成/);
    } finally { await ui.close(); }
  });
  await t.test('permission changes discard late capture and restore previews', async () => {
    const lateCapture = deferred(), lateRestore = deferred(), ui = await fixture({ capturePreview: () => lateCapture.promise, restorePreview: () => lateRestore.promise });
    try {
      await ui.source('sessions'); await click(button('保存当前窗口')); await fill(document.querySelector('[aria-label="会话名称"]'), 'Delayed capture'); await click(button('预览当前窗口'));
      await ui.permission(false); await act(async () => lateCapture.resolve(ui.capturePreview)); assert.equal(button('确认保存会话'), undefined);
      await click(button('取消', document.querySelector('.browser-session-form'))); await ui.permission(true); await click(button('预览恢复'));
      await ui.permission(false); const expired = { tabs: [], pending: 0, opened: 0, skipped: 0, failed: 0, complete: true };
      await act(async () => lateRestore.resolve(expired)); assert.equal(document.querySelector('.browser-session-restore'), null); assert.ok(ui.calls.cancelled.includes(expired));
    } finally { await ui.close(); }
  });
  await t.test('partial restore failures retain completed counts and expose only a safe error', async () => {
    const ui = await fixture({ partialFailure: true }); try {
      await ui.source('sessions'); await click(button('预览恢复')); await click(button('确认恢复，打开第一批'));
      assert.match(document.body.textContent, /已打开 10，已跳过 0，失败 0，剩余 20/); assert.doesNotMatch(document.body.textContent, /PRIVATE ERROR/); assert.ok(button('继续下一批'));
    } finally { await ui.close(); }
  });
});

test('all browser command UI and domain messages have translations in every packaged locale', async () => {
  const keys = new Set();
  for (const file of ['../components/CommandPalette.jsx', '../components/BrowserSessions.jsx', './browser-sessions.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8'); for (const match of source.matchAll(/tr\(['"]([^'"]+)['"]/g)) keys.add(match[1]);
  }
  const adapter = await readFile(new URL('./browser-command.js', import.meta.url), 'utf8'); for (const match of adapter.matchAll(/BROWSER_[A-Z_]+:\s*'([^']+)'/g)) keys.add(match[1]);
  for (const key of keys) for (const { value } of LANGUAGES.filter(locale => locale.value !== 'zh-CN')) assert.ok(catalog[key]?.[value]?.trim(), value + ': ' + key);
});
