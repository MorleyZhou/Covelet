import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { PresentationContext } from './presentation.js';
import { LANGUAGES } from '../i18n/index.js';
import catalog from '../i18n/catalog.json' with { type: 'json' };
import { readFile } from 'node:fs/promises';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const engineSource = `
  const profile = { provider: 'webdav', endpoint: 'https://dav.example.test/dav/', prefix: 'qa' };
  const conflictRun = { id: 'run-1', startedAt: 1000, finishedAt: 2000, outcome: 'conflict', newConflictCount: 2 };
  const subscribers = new Set();
  export const engine = {
    runs: [], choices: [], gate: null, status: null, syncs: 0, previews: 0, recovery: false, undo: 0,
    reset(legacy) {
      this.runs = legacy ? [] : [conflictRun];
      this.choices = []; this.gate = null; this.previewGate = null; this.syncs = 0; this.previews = 0; this.recovery = false; this.undo = 0; this.recoveryError = false;
      this.rows = [
        { id: 'note-1', label: 'Shared note', status: 'both', local: { body: 'this device' }, remote: { body: 'cloud' }, merged: { body: 'this device' }, choice: 'local', conflict: true },
        { id: 'note-2', label: 'Local note', status: 'one', local: { body: 'unique' }, remote: undefined, merged: { body: 'unique' }, choice: 'merged', conflict: false },
        { id: 'note-3', label: 'Deleted note', status: 'deleted', local: undefined, remote: { body: 'modified' }, merged: { body: 'modified' }, choice: 'remote', conflict: true },
      ];
      this.status = { phase: 'conflict', unlocked: true, pending: 0, conflicts: 2, lastSync: 0, message: '有冲突待处理' };
    },
    update(change) {
      this.status = { ...this.status, ...change };
      for (const listener of subscribers) listener(this.status);
    }
  };
  export const supportsCloudSync = () => true;
  export const getCloudSyncStatus = () => engine.status;
  export const acceptBackgroundCloudSyncStatus = value => engine.update(value);
  export const subscribeCloudSyncStatus = (listener) => {
    subscribers.add(listener); return () => subscribers.delete(listener);
  };
  export const subscribeBackgroundCloudSyncStatus = subscribeCloudSyncStatus;
  export const getBackgroundCloudSyncStatus = getCloudSyncStatus;
  export const loadCloudSyncSettings = async () => ({ profile: { ...profile }, autoSync: false });
  export const getCloudSyncRuns = async () => engine.runs.slice();
  export const getCloudSyncConflicts = async () => engine.status.conflicts ? [
    { id: 'notes', namespace: 'preferences', key: 'covelet.tools.v1' },
    { id: 'icon', namespace: 'navigation-icons', key: 'https://private.example/favicon.png' },
  ] : [];
  export async function previewCloudSyncMerge() { engine.previews++; await engine.previewGate; return { token: 'preview-1', rows: engine.rows }; }
  export async function applyCloudSyncMerge(selection) {
    engine.choices.push(selection);
    await engine.gate;
    engine.recovery = true;
    engine.update({ phase: 'saved', conflicts: 0 });
  }
  export async function undoCloudSyncMerge() { engine.undo++; engine.recovery = false; }
  export const getCloudSyncMergeRecovery = async () => { if (engine.recoveryError) throw Error('Read failure'); return engine.recovery; };
  export async function requestBackgroundCloudSync() {
    engine.syncs++;
    engine.update({ phase: 'syncing', message: '正在同步…' });
    engine.runs = [{ id: 'run-' + (engine.syncs + 1), startedAt: 2500, finishedAt: 3000, outcome: 'success', newConflictCount: 0 }, ...engine.runs];
    engine.update({ phase: 'saved', conflicts: 0, lastSync: 3000, message: '' });
    return engine.status;
  }
  const unexpected = () => { throw Error('Unexpected sync I/O in conflict UI test'); };
  export const testCloudConnection = unexpected, saveCloudSyncSettings = unexpected, unlockCloudSync = unexpected,
    lockCloudSync = unexpected, useLocalOnlyCloudSync = unexpected, syncCloudNow = unexpected;
`;

test('sync settings preview record choices and apply them together', async (t) => {
  const temporary = await mkdtemp(join(appRoot, 'node_modules', '.covelet-conflict-ui-'));
  const output = join(temporary, 'settings.mjs');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://covelet.test/', pretendToBeVisual: true });
  const globals = new Map();
  const expose = (key, value) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement', 'DocumentFragment', 'MutationObserver', 'CustomEvent']) expose(key, key === 'window' ? dom.window : dom.window[key]);
  expose('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  expose('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  expose('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  expose('IS_REACT_ACT_ENVIRONMENT', true);
  t.after(async () => {
    dom.window.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    assert.equal(dirname(temporary), join(appRoot, 'node_modules'));
    assert.ok(basename(temporary).startsWith('.covelet-conflict-ui-'));
    await rm(temporary, { recursive: true, force: true });
  });
  await build({
    stdin: { contents: "export { default as CloudSyncSettings } from './src/components/CloudSyncSettings.jsx'; export { engine } from 'fixture:cloud-sync';", resolveDir: appRoot, sourcefile: 'conflict-ui-entry.mjs' },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' },
    plugins: [{
      name: 'conflict-engine-fixture',
      setup(builder) {
        builder.onResolve({ filter: /(?:cloud-sync(?:-background)?\.js|^fixture:cloud-sync)$/ }, () => ({ path: 'engine', namespace: 'conflict-fixture' }));
        builder.onResolve({ filter: /CloudHistory\.jsx$/ }, () => ({ path: 'history', namespace: 'conflict-fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'conflict-fixture' }, ({ path }) => ({ contents: path === 'engine' ? engineSource : 'export default function CloudHistory() { return null; }', loader: 'js' }));
        // These must be the same React contexts/catalog used by the test host.
        builder.onResolve({ filter: /presentation\.js$/ }, () => ({ path: new URL('./presentation.js', import.meta.url).href, external: true }));
        builder.onResolve({ filter: /i18n\/index\.js$/ }, () => ({ path: new URL('../i18n/index.js', import.meta.url).href, external: true }));
      },
    }],
  });
  const { CloudSyncSettings, engine } = await import(pathToFileURL(output).href);
  const { createRoot } = await import('react-dom/client');
  async function fixture(active, { legacy = false } = {}) {
    engine.reset(legacy);
    document.body.innerHTML = '<div class="owntab"><div id="settings-root"></div></div>';
    const root = createRoot(document.querySelector('#settings-root'));
    const busy = [];
    let unlocks = 0;
    const requestUnlock = () => { unlocks++; };
    const render = async (nextActive) => {
      await act(async () => root.render(React.createElement(PresentationContext.Provider, {
        value: { active: nextActive, hiddenKeys: new Set(['note:hidden-note']), requestUnlock },
      }, React.createElement(CloudSyncSettings, { onBusyChange: value => busy.push(value) }))));
    };
    await render(active);
    return { busy, render, get unlocks() { return unlocks; }, async close() { await act(async () => root.unmount()); } };
  }
  const group = () => document.querySelector('[role="group"][aria-label="合并同步记录"]');
  const button = (name, root = group()) => [...(root?.querySelectorAll('button') || [])].find(element => element.textContent.trim() === name);
  async function click(control) {
    assert.ok(control, 'expected a real rendered button');
    assert.equal(control.disabled, false, 'the action must be enabled');
    await act(async () => { control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  }

  for (const side of ['local', 'remote', 'merged']) {
    await t.test('choosing ' + side + ' applies one record plan and publishes with normal sync', async () => {
      const ui = await fixture(false);
      let release;
      engine.gate = new Promise(resolve => { release = resolve; });
      try {
        assert.equal(document.querySelectorAll('[role="group"][aria-label="合并同步记录"]').length, 1);
        assert.equal(group().closest('[data-sync-run-id]').dataset.syncRunId, 'run-1');
        assert.match(group().closest('[data-sync-run-id]').textContent, /有冲突/);
        assert.ok(button('预览合并'));
        assert.equal(button('以本地为准'), undefined);
        assert.equal(button('以云端为准'), undefined);
        assert.doesNotMatch(document.body.textContent, /private\.example|网站图标/);
        await click(button('预览合并'));
        assert.equal(engine.previews, 1);
        assert.deepEqual(engine.choices, [], 'preview does not apply content');
        assert.match(group().textContent, /两侧都改了/);
        assert.match(group().textContent, /仅一边改了/);
        assert.match(group().textContent, /一边删了/);
        const select = group().querySelector('[aria-label="Shared note：保留方式"]');
        await act(async () => { select.value = side; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
        await click(button('应用合并'));
        assert.deepEqual(engine.choices, [{ token: 'preview-1', choices: { 'note-1': side } }]);
        assert.notEqual(ui.busy.at(-1), true, 'background work must not leave page-wide busy state');
        await act(async () => release());
        assert.equal(group(), null, 'completed resolution removes the active choice');
        assert.equal(document.querySelectorAll('[data-sync-run-id]').length, 2);
        assert.equal(engine.syncs, 1, 'publish once with ordinary sync');
        assert.ok(button('撤销上次合并', document));
        await click(button('撤销上次合并', document));
        assert.equal(engine.undo, 1);
        assert.equal(engine.syncs, 2);
        assert.equal(button('撤销上次合并', document), undefined);
      } finally { release(); await ui.close(); }
    });
  }

  await t.test('hidden mode clears preview contents and blocks stale apply handlers', async () => {
    const ui = await fixture(false);
    try {
      await click(button('预览合并'));
      const stale = button('应用合并');
      await ui.render(true);
      assert.equal(button('应用合并'), undefined);
      assert.doesNotMatch(document.body.textContent, /Shared note|this device|unique/);
      await act(async () => { stale.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
      assert.deepEqual(engine.choices, []);
      await click(button('解锁隐藏内容', document));
      assert.equal(ui.unlocks, 1);
      await ui.render(false);
      assert.ok(button('预览合并'));
      assert.equal(button('应用合并'), undefined);
    } finally { await ui.close(); }
  });

  await t.test('older unresolved conflicts without a history row still offer merge preview', async () => {
    const ui = await fixture(false, { legacy: true });
    try {
      assert.equal(document.querySelectorAll('[role="group"][aria-label="合并同步记录"]').length, 1);
      assert.ok(button('预览合并'));
    } finally { await ui.close(); }
  });

  for (const invalidation of ['privacy', 'lock']) await t.test('a delayed preview stays invalid after ' + invalidation + ' toggles back', async () => {
    const ui = await fixture(false);
    let release;
    engine.previewGate = new Promise(resolve => { release = resolve; });
    try {
      await click(button('预览合并'));
      if (invalidation === 'privacy') { await ui.render(true); await ui.render(false); }
      else {
        await act(async () => engine.update({ unlocked: false }));
        await act(async () => engine.update({ unlocked: true }));
      }
      await act(async () => release());
      assert.equal(button('应用合并'), undefined);
      assert.doesNotMatch(document.body.textContent, /Shared note|this device|unique/);
      assert.deepEqual(engine.choices, []);
    } finally { release(); await ui.close(); }
  });

  await t.test('recovery discovery failures offer a retry instead of hiding undo silently', async () => {
    const ui = await fixture(false);
    try {
      engine.recoveryError = true;
      await act(async () => engine.update({ phase: 'conflict' }));
      assert.match(document.body.textContent, /恢复前副本暂时无法读取/);
      engine.recoveryError = false; engine.recovery = true;
      await click(button('重试', document));
      assert.doesNotMatch(document.body.textContent, /恢复前副本暂时无法读取/);
      assert.ok(button('撤销上次合并', document));
    } finally { await ui.close(); }
  });

  await t.test('pagination retains choices from an earlier page', async () => {
    const ui = await fixture(false);
    try {
      engine.rows = Array.from({ length: 51 }, (_, index) => ({ id: 'row-' + index, label: 'Row ' + index, status: 'one', choice: 'merged', local: index, merged: index }));
      await click(button('预览合并'));
      assert.equal(group().querySelectorAll('[data-merge-row-id]').length, 50);
      const first = group().querySelector('select');
      await act(async () => { first.value = 'local'; first.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
      await click(button('下一页'));
      assert.equal(group().querySelectorAll('[data-merge-row-id]').length, 1);
      await click(button('应用合并'));
      assert.deepEqual(engine.choices, [{ token: 'preview-1', choices: { 'row-0': 'local' } }]);
    } finally { await ui.close(); }
  });
});

test('record merge UI strings have translations in every packaged language', async () => {
  const source = await readFile(new URL('../components/CloudSyncSettings.jsx', import.meta.url), 'utf8');
  const keys = [...source.matchAll(/tr\(['"]([^'"]*(?:合并|两侧|一边|保留方式|保留本机|保留云端|这条记录)[^'"]*)['"]/g)].map(match => match[1]);
  assert.ok(keys.length >= 15);
  for (const key of keys) for (const { value: language } of LANGUAGES.filter(item => item.value !== 'zh-CN')) {
    assert.equal(typeof catalog[key]?.[language], 'string', language + ': ' + key);
    assert.ok(catalog[key][language].trim());
  }
});
