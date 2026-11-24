import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { PresentationContext } from './presentation.js';
import { LANGUAGES } from '../i18n/index.js';
import catalog from '../i18n/catalog.json' with { type: 'json' };

const appRoot = fileURLToPath(new URL('../../', import.meta.url)), outputRoot = resolve(appRoot, '..', 'output/playwright');
const note = (id, body, revision = 3) => ({ id, title: `Title ${id}`, body, revision, pinned: false, createdAt: 1, updatedAt: 3 });
const version = (id, record, n = 1) => ({ id, n, capturedAt: n * 1000, record });
const envelope = (notes, revision = 7) => ({ version: 1, revision, clock: revision, notes });
test('note history previews safely and preserves current content through the guarded domain restore', async t => {
  await mkdir(outputRoot, { recursive: true });
  const temporary = await mkdtemp(join(outputRoot, '.note-history-ui-')), output = join(temporary, 'history.mjs');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://covelet.test/', pretendToBeVisual: true });
  const globals = new Map();
  for (const key of ['window', 'document', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement', 'DocumentFragment', 'MutationObserver', 'CustomEvent']) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key] });
  }
  for (const [key, value] of Object.entries({ getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(async () => {
    dom.window.close(); for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    assert.equal(dirname(temporary), outputRoot); assert.ok(basename(temporary).startsWith('.note-history-ui-')); await rm(temporary, { recursive: true, force: true });
  });
  await build({ stdin: { contents: "export {default as NoteHistory} from './src/components/NoteHistory.jsx';", resolveDir: appRoot }, outfile: output,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' },
    plugins: [{ name: 'history-domain-fixture', setup(builder) {
      builder.onResolve({ filter: /(?:note-history|personal-tools)\.js$/ }, () => ({ path: 'domain', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const loadNoteHistory=()=>{}, subscribeNoteHistory=()=>()=>{}, restoreNoteVersion=()=>{};', loader: 'js' }));
      builder.onResolve({ filter: /presentation\.js$/ }, () => ({ path: new URL('./presentation.js', import.meta.url).href, external: true }));
      builder.onResolve({ filter: /i18n\/index\.js$/ }, () => ({ path: new URL('../i18n/index.js', import.meta.url).href, external: true }));
      builder.onResolve({ filter: /^[^./][^:]*$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
    } }],
  });
  const { NoteHistory } = await import(pathToFileURL(output).href), { createRoot } = await import('react-dom/client');
  const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text);
  async function click(control) { assert.ok(control, 'expected control'); assert.equal(control.disabled, false); await act(async () => control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); }
  function Dialog({ title, children }) { return React.createElement('section', { role: 'dialog', 'aria-label': title }, children); }
  async function fixture(options = {}) {
    let history = options.history || envelope({ shared: [version('version-a', note('shared', 'Body A', 1)), version('version-b', note('shared', 'Body B', 2), 2)] });
    const calls = { reads: 0, restored: [], results: [], closed: 0, busy: [] }, listeners = new Set();
    const loader = () => { calls.reads++; return options.load ? options.load(calls.reads) : Promise.resolve(structuredClone(history)); };
    const restore = async (noteId, versionId, guard) => {
      calls.restored.push({ noteId, versionId, guard });
      if (options.restore) return options.restore(noteId, versionId, guard);
      const old = history.notes[noteId].find(item => item.id === versionId).record;
      history = envelope({ ...history.notes, [noteId]: [...history.notes[noteId], version('current-before-restore', structuredClone(props.note), 8)] }, 8);
      return { ...old, revision: props.note.revision + 1 };
    };
    let props = { note: note('shared', 'Body C'), preferencesRevision: 5, Dialog, ...options.props,
      loadHistory: loader, subscribeHistory: listener => { listeners.add(listener); return () => listeners.delete(listener); }, restoreVersion: restore,
      onClose: () => { calls.closed++; }, onRestored: result => { calls.results.push(result); }, onBusyChange: value => calls.busy.push(value) };
    let presentation = { active: false, hiddenKeys: new Set(), requestUnlock: () => {} };
    document.body.innerHTML = '<div id="root"></div>'; const root = createRoot(document.querySelector('#root'));
    async function render(patch = {}, context) { props = { ...props, ...patch }; if (context) presentation = { ...presentation, ...context }; await act(async () => root.render(React.createElement(PresentationContext.Provider, { value: presentation }, React.createElement(NoteHistory, props)))); }
    await render();
    return { calls, render, get history() { return history; }, async changed() { await act(async () => { for (const listener of listeners) listener(history); }); }, async close() { await act(async () => root.unmount()); } };
  }
  await t.test('restore submits all revisions and refreshes the editor only after the domain saved current C', async () => {
    const ui = await fixture();
    try {
      const versions = [...document.querySelectorAll('.note-history-versions button')]; assert.equal(versions.length, 2);
      await click(versions[1]);
      assert.equal(document.querySelector('[aria-label="当前便笺内容"]').textContent, 'Body C');
      assert.equal(document.querySelector('[aria-label="历史便笺内容"]').textContent, 'Body A');
      assert.equal(document.querySelectorAll('[contenteditable=true],textarea,input').length, 0, 'history is read-only');
      await click(button('恢复此版本'));
      assert.deepEqual(ui.calls.restored, [{ noteId: 'shared', versionId: 'version-a', guard: { expectedNoteRevision: 3, expectedHistoryRevision: 7, expectedPreferencesRevision: 5 } }]);
      assert.equal(ui.calls.results[0].body, 'Body A'); assert.ok(ui.history.notes.shared.some(item => item.record.body === 'Body C'));
      assert.deepEqual(ui.calls.busy, [true, false]);
    } finally { await ui.close(); }
  });
  await t.test('historical HTML remains literal text and creates no image, script, or link nodes', async () => {
    const payload = '<img src="https://private.example/pixel" onerror="alert(1)"><script>alert(2)</script>';
    const ui = await fixture({ history: envelope({ shared: [version('literal-html', note('shared', payload, 1))] }) });
    try {
      await click(document.querySelector('.note-history-versions button'));
      assert.equal(document.querySelector('[aria-label="历史便笺内容"]').textContent, payload);
      assert.equal(document.querySelectorAll('img,script,a,iframe').length, 0);
    } finally { await ui.close(); }
  });
  for (const blocked of ['dirty', 'stale', 'hidden']) await t.test(blocked + ' notes do not read or reveal history', async () => {
    const ui = await fixture({ props: { [blocked]: true } });
    try { assert.equal(ui.calls.reads, 0); assert.equal(document.querySelector('[role=dialog]'), null); assert.equal(ui.calls.closed, 1); }
    finally { await ui.close(); }
  });
  await t.test('a delayed history read cannot reappear after the note is hidden', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const ui = await fixture({ load: () => gate });
    try {
      await ui.render({}, { active: true, hiddenKeys: new Set(['note:shared']) });
      await act(async () => release(envelope({ shared: [version('secret', note('shared', 'HIDDEN OLD BODY'))] })));
      assert.doesNotMatch(document.body.textContent, /HIDDEN OLD BODY/); assert.equal(document.querySelector('[role=dialog]'), null);
      assert.deepEqual(ui.calls.restored, []);
    } finally { release(envelope({})); await ui.close(); }
  });
  await t.test('history notifications invalidate a pending read and require a fresh selection', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const ui = await fixture({ load: count => count === 1 ? gate : Promise.resolve(envelope({ shared: [version('fresh', note('shared', 'Fresh body'))] }, 9)) });
    try {
      await ui.changed();
      await act(async () => release(envelope({ shared: [version('outdated', note('shared', 'OUTDATED BODY'))] })));
      assert.doesNotMatch(document.body.textContent, /OUTDATED BODY/); assert.match(document.body.textContent, /历史已更新/);
      assert.equal(button('恢复此版本').disabled, true);
      await click(button('刷新历史')); await click(document.querySelector('.note-history-versions button'));
      assert.equal(document.querySelector('[aria-label="历史便笺内容"]').textContent, 'Fresh body');
    } finally { release(envelope({})); await ui.close(); }
  });
  await t.test('switching notes invalidates the older read and unmount ignores any remaining read', async () => {
    const releases = [], gates = [0, 1].map(() => new Promise(resolve => releases.push(resolve)));
    const ui = await fixture({ load: count => gates[count - 1] });
    try {
      await ui.render({ note: note('other', 'Current other') });
      await act(async () => releases[0](envelope({ shared: [version('old-shared', note('shared', 'WRONG NOTE BODY'))] })));
      assert.doesNotMatch(document.body.textContent, /WRONG NOTE BODY/); assert.equal(document.querySelector('.note-history-versions'), null);
      await ui.close();
      await act(async () => releases[1](envelope({ other: [version('old-other', note('other', 'OLD OTHER BODY'))] })));
      assert.doesNotMatch(document.body.textContent, /OLD OTHER BODY/);
    } finally { for (const release of releases) release(envelope({})); }
  });
  await t.test('CAS rejection disables stale restore and new dirty edits never get replaced by a late success', async () => {
    const ui = await fixture({ restore: async () => { throw Object.assign(new Error('便笺或历史已在其他页面更新，请重新打开历史。'), { code: 'REVISION_CONFLICT' }); } });
    try {
      await click(document.querySelector('.note-history-versions button')); await click(button('恢复此版本'));
      assert.equal(ui.calls.results.length, 0); assert.equal(button('恢复此版本').disabled, true); assert.match(document.body.textContent, /其他页面更新/);
    } finally { await ui.close(); }
    let release; const gate = new Promise(resolve => { release = resolve; });
    const delayed = await fixture({ restore: () => gate });
    try {
      await click(document.querySelector('.note-history-versions button')); await click(button('恢复此版本'));
      await delayed.render({ dirty: true, note: note('shared', 'UNSAVED NEW DRAFT') });
      await act(async () => release(note('shared', 'Old body', 4)));
      assert.equal(delayed.calls.results.length, 0); assert.equal(document.querySelector('[role=dialog]'), null);
    } finally { release(note('shared', 'Old body', 4)); await delayed.close(); }
  });
});

test('note history UI and domain failures have translations in all eight languages', async () => {
  const keys = new Set();
  for (const path of ['../components/NoteHistory.jsx', '../components/PersonalTools.jsx', './note-history-core.js']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    for (const match of source.matchAll(/tr\(['"]([^'"]+)['"]/g)) if (path.includes('NoteHistory') || /历史/.test(match[1])) keys.add(match[1]);
  }
  for (const key of ['便笺历史无效，当前便笺已保留。', '便笺历史超出容量限制，当前便笺已保留。', '同一便笺历史版本存在不同内容，已停止合并。', '便笺或历史已在其他页面更新，请重新打开历史。']) keys.add(key);
  assert.ok(keys.size >= 20);
  for (const key of keys) for (const { value: language } of LANGUAGES.filter(item => item.value !== 'zh-CN')) {
    assert.equal(typeof catalog[key]?.[language], 'string', language + ': ' + key); assert.ok(catalog[key][language].trim());
  }
});
