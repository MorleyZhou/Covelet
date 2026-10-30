import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverHighResolutionIcon } from './site-icon-discovery.js';

const api = { runtime: { id: 'test' }, permissions: { contains: async () => false } };
const icon = (width, extra = {}) => ({ width, height: width, vector: false, adaptive: false, ...extra });
const emptyCache = async () => null;

test('ordinary 32-pixel CDN PNG is selected rather than rejected as non-HD', async () => {
  const source = 'https://www.gstatic.com/search-console/scfe/favicon.png', calls = [];
  const result = await discoverHighResolutionIcon('https://search.google.com', {
    api, links: [{ url: source, rel: 'icon', sizes: '32x32', type: 'image/png' }], cachedIcon: emptyCache,
    loadIcon: async (url) => { calls.push(url); return url === source ? icon(32) : null; },
  });
  assert.equal(result.url, source); assert.equal(result.width, 32);
  assert.equal(calls[0], 'https://search.google.com/favicon.ico', 'a baseline gets an opportunity before speculative HD paths');
  assert.equal(calls.filter((url) => url === source).length, 1);
});

test('a valid local candidate is reused without refreshing that image from the network', async () => {
  const source = 'https://cdn.example/old-but-valid.png', downloaded = [];
  const result = await discoverHighResolutionIcon('https://example.com', {
    api, links: [{ url: source, rel: 'icon', sizes: '32x32' }], cachedIcon: async (url) => url === source ? icon(32) : null,
    loadIcon: async (url) => { downloaded.push(url); return null; },
  });
  assert.equal(result.url, source); assert(!downloaded.includes(source));
});

test('failure of every HD candidate preserves a usable standard favicon', async () => {
  const baseline = 'https://example.com/favicon.ico';
  const result = await discoverHighResolutionIcon('https://example.com', {
    api, links: [{ url: 'https://cdn.example/large.png', rel: 'apple-touch-icon', sizes: '512x512' }], cachedIcon: emptyCache,
    loadIcon: async (url) => { if (url === baseline) return icon(32); throw Error('Unavailable HD source'); },
  });
  assert.equal(result.url, baseline); assert.equal(result.width, 32);
});

test('cached theme variants remain a pair even when their original PNGs are small', async () => {
  const light = 'https://cdn.example/light.png', dark = 'https://cdn.example/dark.png';
  const result = await discoverHighResolutionIcon('https://example.com', {
    api, links: [
      { url: light, rel: 'icon', media: '(prefers-color-scheme: light)' },
      { url: dark, rel: 'icon', media: '(prefers-color-scheme: dark)' },
    ], cachedIcon: async (url) => [light, dark].includes(url) ? icon(32) : null,
    loadIcon: async () => null,
  });
  assert.equal(result.variants.light.url, light); assert.equal(result.variants.dark.url, dark);
});

test('user cancellation is propagated to image acquisition and cannot return a partial result', async () => {
  const controller = new AbortController(); let received;
  await assert.rejects(discoverHighResolutionIcon('https://example.com', {
    api, links: [], signal: controller.signal, cachedIcon: emptyCache,
    loadIcon: async (_url, options) => { received = options.signal; controller.abort(); return icon(32); },
  }), { name: 'AbortError' });
  assert(received?.aborted);
});

test('a larger cached baseline is not downgraded to a smaller declared PNG', async () => {
  const baseline = 'https://example.com/favicon.ico', source = 'https://cdn.example/favicon.png';
  const result = await discoverHighResolutionIcon('https://example.com', {
    api, links: [{ url: source, rel: 'icon' }], cachedIcon: async (url) => url === baseline ? icon(128) : url === source ? icon(32) : null,
    loadIcon: async () => null,
  });
  assert.equal(result.url, baseline); assert.equal(result.width, 128);
});

test('the HD deadline retains a baseline already obtained before a slow upgrade', async () => {
  const baseline = 'https://example.com/favicon.ico'; let stopped = false;
  const result = await discoverHighResolutionIcon('https://example.com', {
    api, links: [{ url: 'https://cdn.example/slow.png', rel: 'apple-touch-icon', sizes: '512x512' }], cachedIcon: emptyCache, timeoutMs: 20,
    loadIcon: async (url, { signal }) => {
      if (url === baseline) return icon(32);
      return new Promise((resolve) => signal.addEventListener('abort', () => { stopped = true; resolve(null); }, { once: true }));
    },
  });
  assert(stopped); assert.equal(result.url, baseline); assert.equal(result.width, 32);
});
