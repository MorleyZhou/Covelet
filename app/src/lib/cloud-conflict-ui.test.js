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
  const conflict = { id: 'notes-conflict', namespace: 'preferences', key: 'covelet.tools.v1', local: false, deleted: false };
  const profile = { provider: 'webdav', endpoint: 'https://dav.example.test/dav/', prefix: 'qa' };
  export const engine = {
    previews: [], restores: [], counter: 0, deferNext: false, release: null, resolved: false,
    reset() { this.previews = []; this.restores = []; this.counter = 0; this.deferNext = false; this.release = null; this.resolved = false; }
  };
  export const supportsCloudSync = () => true;
  export const getCloudSyncStatus = () => ({ phase: 'saved', unlocked: true, pending: 0, lastSync: 0, message: '' });
  export const subscribeCloudSyncStatus = () => () => {};
  export const loadCloudSyncSettings = async () => ({ profile: { ...profile }, autoSync: false });
  export const getCloudSyncConflicts = async () => engine.resolved ? [] : [{ ...conflict }];
  export async function previewCloudSyncConflict(id) {
    const token = 'preview-token-' + ++engine.counter;
    engine.previews.push({ id, token });
    const value = side => ({ notes: [{ id: 'hidden-note', title: 'HIDDEN_' + side + '_TITLE', body: 'HIDDEN_' + side + '_BODY' }], reading: [], rawCanary: 'PRIVATE_JSON_' + side });
    const preview = { ...conflict, id, token, local: { deleted: false, value: value('LOCAL') }, remote: { deleted: false, value: value('REMOTE') } };
    if (engine.deferNext) {
      engine.deferNext = false;
      return new Promise(resolve => { engine.release = () => resolve(preview); });
    }
    return preview;
  }
  export async function restoreCloudSyncConflict(id, options) {
    engine.restores.push({ id, ...options }); engine.resolved = true;
  }
  const unexpected = () => { throw Error('Unexpected sync I/O in conflict UI test'); };
  export const testCloudConnection = unexpected, saveCloudSyncSettings = unexpected, unlockCloudSync = unexpected,
    lockCloudSync = unexpected, useLocalOnlyCloudSync = unexpected, syncCloudNow = unexpected;
`;

test('real conflict UI protects hidden content and renews previews after unlocking', async (t) => {
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
        builder.onResolve({ filter: /(?:cloud-sync\.js|^fixture:cloud-sync)$/ }, () => ({ path: 'engine', namespace: 'conflict-fixture' }));
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
  async function fixture(active) {
    engine.reset();
    document.body.innerHTML = '<div class="owntab"><div id="settings-root"></div></div>';
    const root = createRoot(document.querySelector('#settings-root'));
    let unlocks = 0;
    const requestUnlock = () => { unlocks++; };
    const render = async (nextActive) => {
      await act(async () => root.render(React.createElement(PresentationContext.Provider, {
        value: { active: nextActive, hiddenKeys: new Set(['note:hidden-note']), requestUnlock },
      }, React.createElement(CloudSyncSettings))));
    };
    await render(active);
    assert.ok(document.querySelector('.cloud-sync-conflicts button'), 'the actual conflict list must load');
    return { render, get unlocks() { return unlocks; }, async close() { await act(async () => root.unmount()); } };
  }
  async function click(button) {
    assert.ok(button, 'expected a real rendered button');
    assert.equal(button.disabled, false, 'the action must be enabled');
    await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  }
  const open = () => click(document.querySelector('.cloud-sync-conflicts button'));
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const confirm = () => dialog()?.querySelector('.prompt-dialog-actions button:last-child');
  const remoteChoice = () => dialog()?.querySelector('.cloud-conflict-sides section:last-child button:last-child');
  const assertPrivateAbsent = () => {
    assert.doesNotMatch(document.body.innerHTML, /HIDDEN_(?:LOCAL|REMOTE)_(?:TITLE|BODY)|PRIVATE_JSON_(?:LOCAL|REMOTE)/);
    assert.equal(dialog(), null);
  };

  await t.test('hidden mode requests the hide password without reading a conflict preview', async () => {
    const ui = await fixture(true);
    try {
      assertPrivateAbsent();
      await open();
      assert.equal(ui.unlocks, 1);
      assert.equal(engine.previews.length, 0);
      assert.equal(engine.restores.length, 0);
      assertPrivateAbsent();
    } finally { await ui.close(); }
  });

  await t.test('locking an open real preview removes summaries and JSON and invalidates its choice', async () => {
    const ui = await fixture(false);
    try {
      await open();
      assert.match(dialog().textContent, /HIDDEN_LOCAL_BODY/);
      assert.match(dialog().textContent, /HIDDEN_REMOTE_BODY/);
      assert.equal(confirm().disabled, true, 'no version is selected by default');
      await click(dialog().querySelector('.cloud-conflict-details button'));
      assert.match(dialog().textContent, /PRIVATE_JSON_LOCAL/, 'technical details use the actual preview renderer');
      await click(remoteChoice());
      const staleConfirm = confirm();
      assert.equal(staleConfirm.disabled, false);
      await ui.render(true);
      assertPrivateAbsent();
      await act(async () => { staleConfirm.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
      assert.equal(engine.restores.length, 0, 'a removed confirmation cannot apply the old choice');
      await ui.render(false);
      assertPrivateAbsent();
      await open();
      assert.equal(engine.previews.length, 2);
      assert.equal(confirm().disabled, true, 'reopening requires an explicit choice again');
      await click(remoteChoice());
      await click(confirm());
      assert.deepEqual(engine.restores, [{ id: 'notes-conflict', choice: 'remote', token: 'preview-token-2' }]);
    } finally { await ui.close(); }
  });

  await t.test('a preview response received while hidden never enters the DOM', async () => {
    const ui = await fixture(false);
    try {
      engine.deferNext = true;
      await open();
      assert.equal(engine.previews.length, 1);
      await ui.render(true);
      await act(async () => { engine.release(); });
      assertPrivateAbsent();
      await ui.render(false);
      assertPrivateAbsent();
      await open();
      assert.equal(engine.previews.length, 2);
      assert.match(dialog().textContent, /HIDDEN_REMOTE_BODY/);
    } finally { await ui.close(); }
  });

  await t.test('a pre-lock response arriving after unlocking cannot reopen an old token', async () => {
    const ui = await fixture(false);
    try {
      engine.deferNext = true;
      await open();
      await ui.render(true);
      await ui.render(false);
      await act(async () => { engine.release(); });
      assertPrivateAbsent();
      await open();
      assert.equal(engine.previews.length, 2);
      await click(remoteChoice());
      await click(confirm());
      assert.deepEqual(engine.restores, [{ id: 'notes-conflict', choice: 'remote', token: 'preview-token-2' }]);
    } finally { await ui.close(); }
  });
});
