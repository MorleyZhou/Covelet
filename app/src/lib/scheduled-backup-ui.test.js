import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { LANGUAGES } from '../i18n/index.js';
import catalog from '../i18n/catalog.json' with { type: 'json' };

const appRoot = fileURLToPath(new URL('../../', import.meta.url)), outputRoot = resolve(appRoot, '..', 'output/playwright');
test('scheduled backup settings use foreground directory grants and background-only execution', async t => {
  await mkdir(outputRoot, { recursive: true });
  const temporary = await mkdtemp(join(outputRoot, '.scheduled-backup-ui-')), output = join(temporary, 'settings.mjs');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://covelet.test/', pretendToBeVisual: true });
  const globals = new Map();
  for (const key of ['window', 'document', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement', 'DocumentFragment', 'MutationObserver', 'CustomEvent']) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key] });
  }
  for (const [key, value] of Object.entries({ getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(async () => {
    dom.window.close();
    for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    assert.equal(dirname(temporary), outputRoot); assert.ok(basename(temporary).startsWith('.scheduled-backup-ui-'));
    await rm(temporary, { recursive: true, force: true });
  });
  await build({ stdin: { contents: "export {default as ScheduledBackupSettings} from './src/components/ScheduledBackupSettings.jsx';", resolveDir: appRoot }, outfile: output,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' },
    plugins: [{ name: 'scheduled-backup-test-module', setup(builder) {
      builder.onResolve({ filter: /scheduled-backup\.js$/ }, () => ({ path: 'scheduler', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const scheduledBackups={};', loader: 'js' }));
      builder.onResolve({ filter: /i18n\/index\.js$/ }, () => ({ path: new URL('../i18n/index.js', import.meta.url).href, external: true }));
      builder.onResolve({ filter: /^[^./][^:]*$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
    } }],
  });
  const { ScheduledBackupSettings } = await import(pathToFileURL(output).href), { createRoot } = await import('react-dom/client');
  let gesture = false;
  const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text);
  async function click(control) {
    assert.ok(control, 'expected real control'); assert.equal(control.disabled, false);
    await act(async () => { gesture = true; control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); gesture = false; });
  }
  async function fill(label, value) {
    const input = [...document.querySelectorAll('label')].find(element => element.textContent.trim() === label)?.querySelector('input');
    assert.ok(input, 'expected field: ' + label);
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
  }
  async function fixture(initial = {}) {
    let settings = { enabled: false, frequency: 'daily', directoryName: '', lastSuccess: 0, nextDue: 0, lastError: null, phase: 'disabled', permission: null, files: [], ...initial };
    const calls = { configurations: [], messages: [], pickers: [], grants: [], pageRuns: 0, disables: 0, busy: [], flushes: 0 }, listeners = new Set();
    let nextPermission = 'granted', workerFailure;
    const directory = { name: 'Synthetic backup folder', async queryPermission() { return nextPermission; }, requestPermission(options) { calls.grants.push({ gesture, options }); nextPermission = 'granted'; return Promise.resolve('granted'); } };
    const scheduler = {
      getSettings: async () => structuredClone(settings),
      async configure(options) { calls.configurations.push(options); settings = { ...settings, enabled: true, directoryName: options.directory.name, frequency: options.frequency, phase: 'idle', permission: 'granted', nextDue: 86400000, lastError: null }; return structuredClone(settings); },
      async disable() { calls.disables++; settings = { ...settings, enabled: false, phase: 'disabled', permission: null }; return structuredClone(settings); },
      async run() { calls.pageRuns++; throw Error('Page execution is forbidden'); },
    };
    const sendMessage = async message => {
      calls.messages.push(message);
      if (message.type === 'covelet:backup:run') {
        if (workerFailure) { settings = { ...settings, phase: 'error', lastError: workerFailure }; return { ok: false, error: workerFailure }; }
        settings = { ...settings, phase: 'saved', lastSuccess: 1000, files: Array.from({ length: 3 }, (_, index) => ({ name: `synthetic-${index}.covelet`, createdAt: index + 1, size: 100 })) };
      }
      return { ok: true, status: structuredClone(settings) };
    };
    document.body.innerHTML = '<div id="test-root"></div>'; const root = createRoot(document.querySelector('#test-root'));
    await act(async () => root.render(React.createElement(ScheduledBackupSettings, { scheduler, sendMessage,
      pickDirectory(options) { calls.pickers.push({ gesture, options }); return Promise.resolve(directory); },
      subscribeStatus(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      onBusyChange(value) { calls.busy.push(value); }, beforeOperation: async () => { calls.flushes++; },
    })));
    return { calls, directory, set permission(value) { nextPermission = value; }, set failure(value) { workerFailure = value; },
      async publish(patch) { settings = { ...settings, ...patch }; await act(async () => { for (const listener of listeners) listener(structuredClone(settings)); }); },
      async close() { await act(async () => root.unmount()); },
    };
  }
  await t.test('daily or weekly setup stores credentials locally and only sends a refresh message', async () => {
    const ui = await fixture();
    try {
      assert.equal(ui.calls.pickers.length, 0); assert.equal(ui.calls.grants.length, 0);
      await click(button('设置定时备份')); await click(button('选择备份目录'));
      assert.deepEqual(ui.calls.pickers, [{ gesture: true, options: { mode: 'readwrite', id: 'covelet-scheduled-backups' } }]);
      assert.match(document.body.textContent, /包含隐藏内容/); assert.match(document.body.textContent, /仅保存加密的 \.covelet/);
      assert.match(document.body.textContent, /保留最近 3 份/); assert.match(document.body.textContent, /不可导出的加密密钥/);
      assert.equal(document.querySelectorAll('input[type=checkbox]').length, 0);
      const select = document.querySelector('select');
      await act(async () => { select.value = 'weekly'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
      await fill('备份密码', 'synthetic backup secret'); await fill('确认备份密码', 'mismatch backup secret');
      assert.equal(button('保存备份计划').disabled, true); assert.equal(ui.calls.configurations.length, 0);
      await fill('确认备份密码', 'synthetic backup secret'); await click(button('保存备份计划'));
      assert.equal(ui.calls.configurations.length, 1); assert.equal(ui.calls.configurations[0].directory, ui.directory);
      assert.equal(ui.calls.configurations[0].frequency, 'weekly'); assert.equal(ui.calls.configurations[0].password, 'synthetic backup secret');
      assert.deepEqual(ui.calls.messages, [{ type: 'covelet:backup:refresh' }]);
      assert.doesNotMatch(JSON.stringify(ui.calls.messages), /secret|password|directory/);
      assert.equal(document.querySelectorAll('input[type=password]').length, 0);
      assert.ok(button('立即备份')); assert.equal(ui.calls.pageRuns, 0);
    } finally { await ui.close(); }
  });
  await t.test('run now delegates to the actual worker message and disable never deletes files', async () => {
    const ui = await fixture({ enabled: true, phase: 'idle', directoryName: 'Existing folder', permission: 'granted' });
    try {
      await click(button('立即备份'));
      assert.deepEqual(ui.calls.messages, [{ type: 'covelet:backup:run' }]);
      assert.equal(ui.calls.pageRuns, 0); assert.equal(ui.calls.flushes, 1); assert.equal(ui.calls.busy.includes(true), false);
      assert.match(document.body.textContent, /已保留 3 份备份/);
      assert.match(document.body.textContent, /已有备份文件仍保留/);
      await click(button('停用定时备份')); assert.equal(ui.calls.disables, 1);
      assert.deepEqual(ui.calls.messages.at(-1), { type: 'covelet:backup:refresh' });
      assert.equal(ui.calls.pickers.length, 0); assert.equal(ui.calls.grants.length, 0);
    } finally { await ui.close(); }
  });
  await t.test('permission prompts happen only on explicit foreground grant and not on status updates', async () => {
    const ui = await fixture({ enabled: true, phase: 'error', directoryName: 'Existing folder', permission: 'denied' });
    try {
      assert.match(document.body.textContent, /备份目录需要重新授权/); assert.equal(ui.calls.grants.length, 0);
      await ui.publish({ phase: 'error', permission: 'prompt' }); assert.equal(ui.calls.pickers.length, 0);
      await click(button('修改备份计划')); ui.permission = 'prompt'; await click(button('选择备份目录'));
      assert.equal(ui.calls.grants.length, 0); assert.equal(button('保存备份计划').disabled, true);
      await click(button('授权目录'));
      assert.deepEqual(ui.calls.grants, [{ gesture: true, options: { mode: 'readwrite' } }]);
      assert.equal(ui.calls.configurations.length, 0); assert.equal(ui.calls.pageRuns, 0);
    } finally { await ui.close(); }
  });
  await t.test('worker failure and asynchronous alarm failure remain visible without exposing raw errors', async () => {
    const ui = await fixture({ enabled: true, phase: 'idle', permission: 'granted', directoryName: 'Existing folder' });
    try {
      ui.failure = { code: 'WRITE_FAILED', message: '备份文件未能写入，已有备份已保留。', at: 2 };
      await click(button('立即备份')); assert.match(document.body.textContent, /备份文件未能写入，已有备份已保留/);
      assert.equal(ui.calls.pageRuns, 0);
      await ui.publish({ phase: 'error', lastError: { code: 'UNKNOWN', message: 'PRIVATE NATIVE PATH AND SECRET', at: 3 } });
      await click(button('修改备份计划'));
      assert.doesNotMatch(document.body.textContent, /PRIVATE NATIVE PATH AND SECRET/);
    } finally { await ui.close(); }
  });
});

test('scheduled backup UI and worker errors are translated in all packaged languages', async () => {
  const source = await readFile(new URL('../components/ScheduledBackupSettings.jsx', import.meta.url), 'utf8');
  const keys = new Set([...source.matchAll(/tr\(['"]([^'"]+)['"]/g)].map(match => match[1]));
  for (const file of ['./scheduled-backup.js', './scheduled-backup-background.js']) {
    try { const text = await readFile(new URL(file, import.meta.url), 'utf8'); for (const match of text.matchAll(/tr\(['"]([^'"]+)['"]/g)) keys.add(match[1]); }
    catch (reason) { if (reason.code !== 'ENOENT') throw reason; }
  }
  assert.ok(keys.size >= 25);
  for (const key of keys) for (const { value: language } of LANGUAGES.filter(item => item.value !== 'zh-CN')) {
    assert.equal(typeof catalog[key]?.[language], 'string', language + ': ' + key); assert.ok(catalog[key][language].trim());
  }
});
