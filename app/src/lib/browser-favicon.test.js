import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readBrowserFavicon, supportsBrowserFavicons } from './browser-favicon.js';

const DEFAULT = new Uint8Array(readFileSync(new URL('../../public/icons/icon-16.png', import.meta.url)));
const SITE = new Uint8Array(readFileSync(new URL('../../public/assets/search-engines/bing.png', import.meta.url)));
let nextId = 0;
const api = () => {
  const id = `testextension${++nextId}`;
  return { runtime: { id, getManifest: () => ({ permissions: ['favicon'] }), getURL: path => `chrome-extension://${id}${path}` },
    permissions: { request: () => { throw Error('Native icons never request site access.'); }, contains: () => { throw Error('No host permission is required.'); } } };
};
const response = bytes => new Response(bytes, { headers: { 'content-type': 'image/png' } });
const convert = async blob => blob;
const isDefault = url => new URL(new URL(url).searchParams.get('pageUrl')).hostname.endsWith('.invalid');

test('browser favicon API is used only with its declared permission and exact own-extension resource', async () => {
  let calls = 0;
  for (const value of [{}, { runtime: { id: 'test' } }, { runtime: { id: 'test', getManifest: () => ({ permissions: [] }), getURL: () => 'chrome-extension://test/_favicon/' } }]) {
    assert.equal(supportsBrowserFavicons(value), false);
    assert.equal(await readBrowserFavicon('https://example.com', { api: value, fetcher: async () => { calls++; }, convert }), null);
  }
  for (const endpoint of ['https://example.com/_favicon/', 'chrome-extension://other/_favicon/', 'chrome-extension://test/wrong/', 'chrome-extension://test/_favicon/?remote=1']) {
    const value = { runtime: { id: 'test', getManifest: () => ({ permissions: ['favicon'] }), getURL: () => endpoint } };
    assert.equal(supportsBrowserFavicons(value), false);
  }
  assert.equal(calls, 0);
});

test('new sites use internal favicon URLs without host permission or private URL components', async () => {
  const value = api(), calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return response(isDefault(url) ? DEFAULT : SITE); };
  for (const input of ['https://example.com/private?token=secret#hash', 'https://second.example/account']) {
    assert(await readBrowserFavicon(input, { api: value, fetcher, convert }) instanceof Blob);
  }
  assert.equal(calls.length, 3, 'the local default-image sample is shared');
  const pages = [];
  for (const { url: input, options } of calls) {
    const url = new URL(input);
    assert.equal(url.protocol, 'chrome-extension:'); assert.equal(url.hostname, value.runtime.id);
    assert.equal(url.pathname, '/_favicon/'); assert.equal(url.searchParams.get('size'), '256');
    assert.deepEqual([...url.searchParams.keys()], ['pageUrl', 'size']);
    pages.push(url.searchParams.get('pageUrl'));
    assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.redirect, 'error'); assert(options.signal.aborted);
  }
  assert.deepEqual(pages.slice(1), ['https://example.com/', 'https://second.example/']);
});

test('the browser default globe and re-encoded identical pixels are never saved as a site icon', async () => {
  assert.equal(await readBrowserFavicon('https://missing.example', { api: api(), convert, fetcher: async () => response(DEFAULT) }), null);
  assert.equal(await readBrowserFavicon('https://same-pixels.example', { api: api(),
    convert: async () => new Blob([DEFAULT], { type: 'image/png' }), fetcher: async url => response(isDefault(url) ? DEFAULT : SITE),
  }), null);
});

test('a failed default sample is conservative and can be retried', async () => {
  const value = api(); let fail = true;
  const fetcher = async url => {
    if (fail) throw Error('No native resource.');
    return response(isDefault(url) ? DEFAULT : SITE);
  };
  assert.equal(await readBrowserFavicon('https://example.com', { api: value, convert, fetcher }), null);
  fail = false;
  assert(await readBrowserFavicon('https://example.com', { api: value, convert, fetcher }) instanceof Blob);
});

test('unsafe MIME, oversized native bytes and oversized conversion results fail as ordinary fallbacks', async () => {
  for (const bad of [
    () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    () => new Response(SITE, { headers: { 'content-type': 'image/png', 'content-length': String(1024 * 1024 + 1) } }),
    () => new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
    () => new Response('<html>wrong</html>', { headers: { 'content-type': 'image/png' } }),
  ]) assert.equal(await readBrowserFavicon('https://example.com', { api: api(), convert, fetcher: async url => isDefault(url) ? response(DEFAULT) : bad() }), null);
  assert.equal(await readBrowserFavicon('https://example.com', { api: api(),
    convert: async () => new Blob([new Uint8Array(1024 * 1024 + 1)], { type: 'image/png' }), fetcher: async () => response(DEFAULT),
  }), null);
});

test('redirected and foreign native responses are not read or followed', async () => {
  for (const make of [
    () => new Response(null, { status: 302, headers: { location: 'https://other.example/icon.png' } }),
    () => Object.defineProperty(response(SITE), 'url', { value: 'chrome-extension://other/_favicon/' }),
    () => Object.defineProperty(response(SITE), 'redirected', { value: true }),
  ]) {
    let calls = 0;
    assert.equal(await readBrowserFavicon('https://example.com', { api: api(), convert, fetcher: async url => { calls++; return isDefault(url) ? response(DEFAULT) : make(); } }), null);
    assert.equal(calls, 2);
  }
});

test('timeouts bound a hung native request and abort its signal without surfacing an error', async () => {
  let signal;
  assert.equal(await readBrowserFavicon('https://example.com', { api: api(), timeoutMs: 5, convert,
    fetcher: async (_url, options) => { signal = options.signal; return new Promise(() => {}); },
  }), null);
  assert(signal.aborted);
});

test('native image conversion is covered by the operation deadline and failures stay recoverable', async () => {
  assert.equal(await readBrowserFavicon('https://example.com', { api: api(), timeoutMs: 5,
    fetcher: async () => response(DEFAULT), convert: async () => new Promise(() => {}),
  }), null);
  assert.equal(await readBrowserFavicon('https://user:password@example.com/private', { api: api(), convert,
    fetcher: async () => { throw Error('This must not be called for credentials in URL.'); },
  }), null);
});
