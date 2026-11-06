import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { PresentationContext } from './presentation.js';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const engineSource = `
  const profile = { provider: 'webdav', endpoint: 'https://dav.example.test/dav/', prefix: 'qa' };
  const conflictRun = { id: 'run-1', startedAt: 1000, finishedAt: 2000, outcome: 'conflict', newConflictCount: 2 };
  const subscribers = new Set();
  export const engine = {
    runs: [], choices: [], gate: null, status: null,
    reset(legacy) {
      this.runs = legacy ? [] : [conflictRun];
      this.choices = []; this.gate = null;
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
  export async function resolveCloudSyncConflicts(choice) {
    engine.choices.push(choice);
    engine.update({ phase: 'syncing', message: '正在同步…' });
    await engine.gate;
    engine.runs = [{ id: 'run-2', startedAt: 2500, finishedAt: 3000, outcome: 'success', newConflictCount: 0 }, ...engine.runs];
    engine.update({ phase: 'saved', conflicts: 0, lastSync: 3000, message: '' });
    return engine.status;
  }
  export const requestBackgroundCloudSync = resolveCloudSyncConflicts;
  const unexpected = () => { throw Error('Unexpected sync I/O in conflict UI test'); };
  export const testCloudConnection = unexpected, saveCloudSyncSettings = unexpected, unlockCloudSync = unexpected,
    lockCloudSync = unexpected, useLocalOnlyCloudSync = unexpected, syncCloudNow = unexpected;
`;

test('sync settings offer one whole-snapshot choice without blocking the page', async (t) => {
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
  const group = () => document.querySelector('[role="group"][aria-label="选择同步版本"]');
  const button = (name, root = group()) => [...(root?.querySelectorAll('button') || [])].find(element => element.textContent.trim() === name);
  async function click(control) {
    assert.ok(control, 'expected a real rendered button');
    assert.equal(control.disabled, false, 'the action must be enabled');
    await act(async () => { control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  }

  for (const side of ['local', 'remote']) {
    await t.test('choosing ' + side + ' schedules one background operation for the whole snapshot', async () => {
      const ui = await fixture(false);
      let release;
      engine.gate = new Promise(resolve => { release = resolve; });
      try {
        assert.equal(document.querySelectorAll('[role="group"][aria-label="选择同步版本"]').length, 1);
        assert.equal(group().closest('[data-sync-run-id]').dataset.syncRunId, 'run-1');
        assert.match(group().closest('[data-sync-run-id]').textContent, /有冲突/);
        assert.ok(button('以本地为准'));
        assert.ok(button('以云端为准'));
        assert.equal(button('查看对比', document), undefined);
        assert.doesNotMatch(document.body.textContent, /private\.example|网站图标/);
        await click(button(side === 'local' ? '以本地为准' : '以云端为准'));
        assert.deepEqual(engine.choices, [side]);
        assert.notEqual(ui.busy.at(-1), true, 'background work must not leave page-wide busy state');
        await act(async () => release());
        assert.equal(group(), null, 'completed resolution removes the active choice');
        assert.equal(document.querySelectorAll('[data-sync-run-id]').length, 2);
        assert.deepEqual(engine.choices, [side], 'no per-record operation or second manual sync');
      } finally { release(); await ui.close(); }
    });
  }

  await t.test('hidden mode blocks the whole-snapshot choice until the user unlocks', async () => {
    const ui = await fixture(false);
    try {
      const stale = button('以云端为准');
      await ui.render(true);
      assert.ok(!button('以云端为准') || button('以云端为准').disabled);
      await act(async () => { stale.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
      assert.deepEqual(engine.choices, []);
      await click(button('解锁隐藏内容', document));
      assert.equal(ui.unlocks, 1);
      await ui.render(false);
      assert.ok(button('以云端为准'));
    } finally { await ui.close(); }
  });

  await t.test('older unresolved conflicts without a history row still have one choice pair', async () => {
    const ui = await fixture(false, { legacy: true });
    try {
      assert.equal(document.querySelectorAll('[role="group"][aria-label="选择同步版本"]').length, 1);
      assert.ok(button('以本地为准'));
      assert.ok(button('以云端为准'));
    } finally { await ui.close(); }
  });
});
