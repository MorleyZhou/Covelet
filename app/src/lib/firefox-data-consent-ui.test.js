import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const appRoot = fileURLToPath(new URL('../../', import.meta.url)), outputRoot = resolve(appRoot, '..', 'output/playwright');
const types = ['searchTerms', 'browsingActivity', 'websiteContent', 'authenticationInfo', 'personallyIdentifyingInfo', 'technicalAndInteraction'];
const purposeTypes = { search: [types[0]], site: types.slice(1, 3), reading: types.slice(1, 3), rss: types.slice(1, 3), cloud: types.slice(1), github: [types[4]], wallpaper: [types[2]] };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('Firefox consent UI preserves offline use and never renders unauthorized Folio image URLs', async t => {
  await mkdir(outputRoot, { recursive: true });
  const temporary = await mkdtemp(join(outputRoot, '.firefox-consent-ui-')), output = join(temporary, 'consent.mjs');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://covelet.test/', pretendToBeVisual: true });
  Object.defineProperty(dom.window.navigator, 'languages', { configurable: true, value: ['zh-CN'] });
  Object.defineProperty(dom.window.navigator, 'language', { configurable: true, value: 'zh-CN' });
  const globals = new Map();
  const install = (key, value) => { globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  for (const key of ['window', 'document', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLImageElement', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'DOMParser', 'DOMRect', 'Range', 'File', 'navigator']) install(key, dom.window[key]);
  for (const [key, value] of Object.entries({ getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) install(key, value);
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  install('ResizeObserver', dom.window.ResizeObserver);
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  t.after(async () => {
    dom.window.close(); for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    assert.equal(dirname(temporary), outputRoot); assert.ok(basename(temporary).startsWith('.firefox-consent-ui-')); await rm(temporary, { recursive: true, force: true });
  });
  await build({ stdin: { contents: "export {default as Consent, FirefoxDataConsentNotice as Notice} from './src/components/FirefoxDataConsent.jsx'; export {default as Note} from './src/components/FolioNoteEditor.jsx';", resolveDir: appRoot }, outfile: output,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' },
    plugins: [{ name: 'consent-test-externals', setup(builder) {
      builder.onResolve({ filter: /\.css$/ }, () => ({ path: 'styles', namespace: 'empty-css' }));
      builder.onLoad({ filter: /.*/, namespace: 'empty-css' }, () => ({ contents: '', loader: 'css' }));
      builder.onResolve({ filter: /i18n\/index\.js$/ }, () => ({ path: new URL('../i18n/index.js', import.meta.url).href, external: true }));
      builder.onResolve({ filter: /^[^./][^:]*$/ }, args => ({ path: import.meta.resolve(args.path), external: true }));
    } }],
  });
  const { Consent, Notice, Note } = await import(pathToFileURL(output).href), { createRoot } = await import('react-dom/client');
  const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text);
  async function click(control) { assert.ok(control, 'expected control'); assert.equal(control.disabled, false); await act(async () => control.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); }
  function apiFixture(options = {}) {
    let granted = options.granted || [], reads = 0, requests = [], listeners = new Set(), direct = false;
    const state = () => ({ firefox: true, supported: true, granted: [...granted], missing: types.filter(type => !granted.includes(type)) });
    const api = { FIREFOX_DATA_COLLECTION_TYPES: types, FIREFOX_DATA_PURPOSES: purposeTypes,
      isFirefoxDataConsentRuntime: () => options.firefox !== false,
      getFirefoxDataConsent: () => { reads++; return options.read ? options.read(reads, state) : Promise.resolve(state()); },
      subscribeFirefoxDataConsent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      requestFirefoxDataConsent: value => { requests.push({ value, direct }); return options.request ? options.request(value) : Promise.resolve(false); },
    };
    return { api, requests, get reads() { return reads; }, get subscribed() { return listeners.size; }, async change(next) { granted = next; await act(async () => { for (const callback of listeners) callback(); }); }, async gesture(control) { direct = true; try { await click(control); } finally { direct = false; } } };
  }
  async function mount(Component, props) {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const render = async patch => { props = { ...props, ...patch }; await act(async () => root.render(React.createElement(Component, props))); };
    await render(); return { render, async close() { await act(async () => root.unmount()); host.remove(); } };
  }
  await t.test('Chrome renders neither consent controls nor notice and does not read or request Firefox permissions', async () => {
    const fixture = apiFixture({ firefox: false }), ui = await mount(Consent, { api: fixture.api }), notice = await mount(Notice, { api: fixture.api });
    try { assert.equal(document.body.textContent, ''); assert.equal(fixture.reads, 0); assert.equal(fixture.subscribed, 0); assert.deepEqual(fixture.requests, []); }
    finally { await ui.close(); await notice.close(); }
  });
  await t.test('groups disclose exact data types and only a direct click requests optional consent; denial keeps the panel usable', async () => {
    const fixture = apiFixture(), ui = await mount(Consent, { api: fixture.api });
    try {
      assert.equal(document.querySelectorAll('[data-purpose]').length, 5); assert.deepEqual(fixture.requests, []);
      const cloud = document.querySelector('[data-purpose=cloud]'); assert.match(cloud.textContent, /认证信息/); assert.match(cloud.textContent, /连接与技术信息/);
      await fixture.gesture(document.querySelector('[data-purpose=reading] button'));
      assert.deepEqual(fixture.requests, [{ value: ['browsingActivity', 'websiteContent'], direct: true }]);
      assert.match(document.body.textContent, /未授予此项授权；本机内容、便笺和手动备份仍可使用/);
      assert.equal(document.querySelector('[data-purpose=reading] button').disabled, false);
      assert.match(document.body.textContent, /about:addons/);
    } finally { await ui.close(); }
  });
  await t.test('grant/revocation updates shared groups and the newtab notice without automatic requests', async () => {
    const fixture = apiFixture(), ui = await mount(Consent, { api: fixture.api }), notice = await mount(Notice, { api: fixture.api });
    try {
      assert.ok(document.querySelector('.firefox-data-notice'));
      await fixture.change(['browsingActivity', 'websiteContent']);
      assert.equal(document.querySelector('.firefox-data-notice'), null);
      assert.equal(document.querySelector('[data-purpose=reading] button').disabled, true);
      assert.equal(document.querySelector('[data-purpose=wallpaper] button').disabled, true);
      await fixture.change([]); assert.ok(document.querySelector('.firefox-data-notice'));
      assert.equal(document.querySelector('[data-purpose=reading] button').disabled, false); assert.deepEqual(fixture.requests, []);
    } finally { await ui.close(); await notice.close(); }
  });
  await t.test('an older granted read cannot overwrite a later revocation, and unmount unsubscribes', async () => {
    const old = deferred(), fixture = apiFixture({ read: (n, state) => n === 1 ? old.promise : Promise.resolve(state()) }), ui = await mount(Consent, { api: fixture.api });
    try {
      await fixture.change([]);
      await act(async () => old.resolve({ firefox: true, supported: true, granted: types, missing: [] }));
      assert.equal(document.querySelector('[data-purpose=cloud] button').disabled, false);
    } finally { await ui.close(); }
    assert.equal(fixture.subscribed, 0);
  });
  await t.test('real Folio editor and reader preserve remote image attrs while blocking initial and newly inserted image DOM', async () => {
    const old = deferred(), fixture = apiFixture({ read: (n, state) => n === 1 ? old.promise : Promise.resolve(state()) });
    let value = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Offline note' }] }, { type: 'image', attrs: { src: 'https://image.example/one.png', alt: 'First picture' } }] };
    const changes = [], errors = [], attempted = [];
    const src = Object.getOwnPropertyDescriptor(dom.window.HTMLImageElement.prototype, 'src'), setAttribute = dom.window.Element.prototype.setAttribute;
    Object.defineProperty(dom.window.HTMLImageElement.prototype, 'src', { ...src, set(value) { if (/^https?:/i.test(value)) attempted.push(value); src.set.call(this, value); } });
    dom.window.Element.prototype.setAttribute = function (name, value) { if (this.tagName === 'IMG' && name.toLowerCase() === 'src' && /^https?:/i.test(value)) attempted.push(value); return setAttribute.call(this, name, value); };
    function Editor(props) { const [draft, setDraft] = React.useState(value); return React.createElement(Note, { ...props, document: draft, documentId: 'consent-note', onInitialize() {}, onError: error => errors.push(error), onChange: next => { value = next; changes.push(next); setDraft(next); } }); }
    const ui = await mount(Editor, { dataConsentApi: fixture.api, preview: true });
    try {
      assert.match(document.body.textContent, /Offline note/); assert.match(document.body.textContent, /First picture/);
      assert.equal(document.querySelectorAll('img[src^="http"]').length, 0); assert.deepEqual(attempted, [], 'no initial src even before the consent read resolves');
      await act(async () => old.resolve({ firefox: true, supported: true, granted: [], missing: types }));
      await ui.render({ preview: false });
      const root = document.querySelector('.ProseMirror'), view = root.editor.view;
      await act(async () => {
        let transaction = view.state.tr.insertText(' locally edited', 13);
        transaction = transaction.insert(transaction.doc.content.size, view.state.schema.nodes.image.create({ src: 'https://image.example/new.png', alt: 'New picture' }));
        view.dispatch(transaction);
      });
      assert.ok(changes.length > 0); assert.match(JSON.stringify(value), /locally edited/);
      assert.match(JSON.stringify(value), /https:\/\/image.example\/one.png/); assert.match(JSON.stringify(value), /https:\/\/image.example\/new.png/);
      assert.deepEqual(attempted, [], 'editing and insertion preserve attrs without assigning a remote DOM src');
      await fixture.change(['browsingActivity', 'websiteContent']);
      assert.equal(document.querySelectorAll('img[src^="https://image.example/"]').length, 2);
      await fixture.change([]); assert.equal(document.querySelectorAll('img[src^="http"]').length, 0);
      assert.match(JSON.stringify(value), /https:\/\/image.example\/new.png/, 'revocation does not alter stored content');
      assert.deepEqual(errors, []);
    } finally { await ui.close(); Object.defineProperty(dom.window.HTMLImageElement.prototype, 'src', src); dom.window.Element.prototype.setAttribute = setAttribute; }
  });
  await t.test('all consent and image-gating phrases have seven complete translations', async () => {
    const phrases = await readFile(join(appRoot, 'src/i18n/amo.phrases.txt'), 'utf8');
    const catalog = JSON.parse(await readFile(join(appRoot, 'src/i18n/catalog.json'), 'utf8'));
    for (const row of phrases.split(/\r?\n/).filter(row => row && !row.startsWith('#'))) {
      const [source, ...translations] = row.split('|'); assert.equal(translations.length, 7, source);
      assert.ok(translations.every(value => value.trim()), source);
      for (const locale of ['en', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'ru']) assert.ok(catalog[source]?.[locale], `${locale}: ${source}`);
    }
  });
});
