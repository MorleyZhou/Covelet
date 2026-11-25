import test from 'node:test';
import assert from 'node:assert/strict';
import { getExtensionApi, extensionRoot, extensionOrigin } from './extension-api.js';
import { canReadSite, requestSiteAccess } from './site-info.js';
import { submitWebSearch } from './search.js';
import { requestBackgroundCloudSync } from './cloud-sync-background.js';

const uuid = '1b64fe0d-8b94-48ce-ad38-71d1d63ded34';
const firefox = extra => ({ runtime: { id: 'covelet@example.test', getURL: path => `moz-extension://${uuid}/${path}` }, ...extra });
function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
}

test('Promise consumers select native Firefox browser APIs without changing Chrome or callback APIs', () => {
  const chrome = { runtime: { id: 'a'.repeat(32) }, marker: 'callback-compatible' }, browser = firefox();
  assert.equal(getExtensionApi({ chrome, browser }), browser);
  assert.equal(chrome.marker, 'callback-compatible');
  assert.equal(getExtensionApi({ chrome }), chrome);
  assert.equal(getExtensionApi({ chrome, browser: { runtime: { id: chrome.runtime.id, getURL: path => `chrome-extension://${chrome.runtime.id}/${path}` } } }), chrome);
  assert.equal(getExtensionApi({ chrome, browser: { runtime: { id: 'invalid', getURL() { throw Error(); } } } }), chrome);
  assert.equal(getExtensionApi({}), undefined);
});

test('own extension origins use Firefox UUID resources and reject unsafe roots', () => {
  assert.equal(extensionOrigin(firefox()), `moz-extension://${uuid}`);
  assert.equal(extensionRoot(firefox()).pathname, '/');
  for (const address of ['https://example.test/', `moz-extension://user:secret@${uuid}/`, `moz-extension://${uuid}/unexpected/`, `moz-extension://${uuid}/?token=secret`]) {
    assert.equal(extensionOrigin({ runtime: { id: 'covelet@example.test', getURL: () => address } }), '');
  }
  assert.equal(extensionRoot({ runtime: { id: 'a'.repeat(32), getURL: () => `chrome-extension://${'b'.repeat(32)}/` } }), null);
});

test('Firefox exact-origin grants use Promise APIs immediately in the initiating gesture', async t => {
  const calls = [];
  globals(t, { chrome: { permissions: { contains() { assert.fail('callback namespace'); }, request() { assert.fail('callback namespace'); } } },
    browser: firefox({ permissions: { contains: async options => { calls.push(['contains', options]); return true; },
      request: options => { calls.push(['request', options]); return Promise.resolve(true); } } }) });
  const requested = requestSiteAccess('https://example.test:8443/article?private=1');
  assert.deepEqual(calls, [['request', { origins: ['https://example.test:8443/*'] }]]);
  assert.equal(await requested, true);
  assert.equal(await canReadSite('https://example.test:8443/article'), true);
  assert.deepEqual(calls[1], ['contains', { origins: ['https://example.test:8443/*'] }]);
});

test('Firefox search and background messages await native Promises and keep safe rejection handling', async t => {
  const calls = [], api = firefox({ permissions: { getAll: async () => ({ data_collection: ['searchTerms'] }) }, search: { query: async options => { calls.push(options); } } });
  api.runtime.sendMessage = async () => { throw Error('No background receiver'); };
  globals(t, { chrome: { runtime: { id: api.runtime.id, sendMessage() { assert.fail('callback namespace'); } }, search: { query() { assert.fail('callback namespace'); } } }, browser: api });
  await submitWebSearch('中文 & private=1', 'browser', [], { newTab: true, navigate() { assert.fail('Unexpected URL fallback'); } });
  assert.deepEqual(calls, [{ text: '中文 & private=1', disposition: 'NEW_TAB' }]);
  assert.deepEqual(await requestBackgroundCloudSync(), { phase: 'error', code: 'DATA_SYNC_LOCAL' });
});
