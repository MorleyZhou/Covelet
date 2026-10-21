import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderIconCache } from './provider-icons.js';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB0kAAAAASUVORK5CYII=', 'base64'));
const image = () => new Blob([PNG], { type: 'image/png' });
const html = () => new Response('<title>Search</title><link rel="icon" href="/brand.png">', { headers: { 'content-type': 'text/html' } });
const png = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });
const allowed = () => ({ runtime: { id: 'extension' }, permissions: { request: async () => true, contains: async () => true } });
const memory = () => {
  const records = new Map();
  return { records, get: async (origin) => records.get(origin), set: async (origin, blob) => { records.set(origin, blob); } };
};

test('saving a custom engine uses an existing origin grant without requesting new access', async () => {
  const requests = [], calls = [];
  const api = allowed();
  api.permissions.request = (request) => { requests.push(request); return Promise.resolve(true); };
  const cacheStore = memory();
  const icons = createProviderIconCache({
    api, cacheStore, convert: async () => image(),
    fetcher: async (url, options) => { calls.push({ url, options }); return url.endsWith('/') ? html() : png(); },
  });
  const pending = icons.fetchForSave('https://search.example.com:8443/private?q={query}&token=secret#fragment');
  assert.deepEqual(requests, [], 'saving an engine must never request a new permission');
  const blob = await pending;
  assert(blob instanceof Blob);
  assert.deepEqual(calls.map(({ url }) => url), ['https://search.example.com:8443/', 'https://search.example.com:8443/brand.png']);
  for (const { options } of calls) {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.redirect, 'error');
  }
  assert.equal(cacheStore.records.size, 1);
  assert.deepEqual([...cacheStore.records.keys()], ['https://search.example.com:8443']);
  assert.equal(cacheStore.records.get('https://search.example.com:8443'), blob);
  assert.equal(await icons.readCached('https://search.example.com:8443/other?q=private'), blob);
  assert.equal(requests.length, 0, 'rendering an existing provider only reads cache');
  assert.equal(calls.length, 2);
});

test('existing-provider cache reads stay offline and reject unsafe, oversized or mismatched cached image data', async () => {
  let permissionCalls = 0, networkCalls = 0;
  const api = allowed();
  api.permissions.request = async () => { permissionCalls++; return true; };
  api.permissions.contains = async () => { permissionCalls++; return true; };
  const cacheStore = memory();
  const icons = createProviderIconCache({ api, cacheStore, fetcher: async () => { networkCalls++; return png(); } });
  assert.equal(await icons.readCached('https://missing.example/search?q={query}'), null);
  for (const bad of [
    new Blob(['<svg/>'], { type: 'image/svg+xml' }),
    new Blob(['<svg/>'], { type: 'image/png' }),
    new Blob([PNG], { type: 'image/jpeg' }),
    new Blob([new Uint8Array(1024 * 1024 + 1)], { type: 'image/png' }),
    'https://tracker.example/icon.png',
  ]) {
    cacheStore.records.set('https://search.example', bad);
    assert.equal(await icons.readCached('https://search.example/?q={query}'), null);
  }
  const blob = image(); cacheStore.records.set('https://search.example', blob);
  assert.equal(await icons.readCached('https://search.example/?q={query}'), blob);
  assert.equal(await icons.readCached('javascript:alert(1)'), null);
  assert.equal(permissionCalls, 0);
  assert.equal(networkCalls, 0);
});

test('denial, preview, invalid images and network or cache failures do not reject engine saving', async () => {
  let networkCalls = 0;
  const denied = allowed(); denied.permissions.contains = async () => false;
  denied.permissions.request = async () => { throw new Error('No new permission may be requested.'); };
  const neverFetch = async () => { networkCalls++; throw new Error('unexpected network'); };
  assert.equal(await createProviderIconCache({ api: denied, cacheStore: memory(), fetcher: neverFetch }).fetchForSave('https://search.example/?q={query}'), null);
  assert.equal(await createProviderIconCache({ api: {}, cacheStore: memory(), fetcher: neverFetch }).fetchForSave('https://search.example/?q={query}'), null);
  assert.equal(networkCalls, 0);
  const allowedApi = allowed();
  const checkDenied = allowed(); checkDenied.permissions.contains = async () => false;
  assert.equal(await createProviderIconCache({ api: checkDenied, cacheStore: memory(), fetcher: neverFetch }).fetchForSave('https://search.example/?q={query}'), null);
  assert.equal(networkCalls, 0, 'readSiteInfo must still recheck permission after a reported grant');
  assert.equal(await createProviderIconCache({ api: allowedApi, cacheStore: memory(), fetcher: neverFetch }).fetchForSave('https://search.example/?q={query}'), null);
  const bad = createProviderIconCache({ api: allowedApi, cacheStore: memory(), convert: async () => new Blob(['<svg/>'], { type: 'image/svg+xml' }), fetcher: async (url) => url.endsWith('/') ? html() : png() });
  assert.equal(await bad.fetchForSave('https://search.example/?q={query}'), null);
  let cacheReads = 0, cachedFetches = 0, permissionRequests = 0;
  const brokenCache = { get: async () => { cacheReads++; throw new Error('unavailable'); }, set: async () => { throw new Error('full'); } };
  const cacheApi = allowed(); cacheApi.permissions.request = async () => { permissionRequests++; return true; };
  const usable = createProviderIconCache({ api: cacheApi, cacheStore: brokenCache, convert: async () => image(), fetcher: async (url) => { cachedFetches++; return url.endsWith('/') ? html() : png(); } });
  assert.equal(await usable.readCached('https://search.example/'), null);
  const current = await usable.fetchForSave('https://search.example/?q={query}');
  assert(current instanceof Blob, 'a valid current icon remains usable even if persistent cache is full');
  assert.equal(await usable.readCached('https://search.example/different?q=private'), current, 'rendering reuses the same-origin session image after an IndexedDB write failure');
  assert.equal(cacheReads, 2, 'saving checks the persistent cache, then subsequent rendering uses session memory');
  assert.equal(cachedFetches, 2, 'subsequent cache reads do not contact the provider again');
  assert.equal(permissionRequests, 0, 'saving and cache reads never request permission');
});

test('new origins use browser icons without a grant, concurrent saves share work, and later saves remain offline', async () => {
  let nativeCalls = 0, hostCalls = 0, requests = 0;
  const api = allowed();
  api.permissions.contains = async () => false;
  api.permissions.request = async () => { requests++; return false; };
  const cacheStore = memory();
  const cache = createProviderIconCache({ api, cacheStore,
    fetcher: async () => { hostCalls++; throw Error('No host access.'); },
    browserIcon: async (origin) => { nativeCalls++; assert.equal(origin, 'https://search.example'); return image(); },
  });
  const first = cache.fetchForSave('https://search.example/private?secret=1');
  assert.equal(cache.fetchForSave('https://search.example/other'), first);
  const blob = await first;
  assert(blob instanceof Blob);
  assert.equal(await cache.fetchForSave('https://search.example/again'), blob);
  assert.equal(nativeCalls, 1);
  assert.equal(hostCalls, 0);
  assert.equal(requests, 0);
});
