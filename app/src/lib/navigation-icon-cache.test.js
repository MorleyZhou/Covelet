import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { createEncryptedStore, localData } from './local-data.js';
import { createEmptyState } from './model.js';

const PNG = new Uint8Array(readFileSync(new URL('../../public/icons/icon-16.png', import.meta.url)));
const record = (url, extra = {}) => ({ url, updatedAt: Date.now(), width: 16, height: 16,
  adaptive: false, vector: false, blob: new Blob([PNG], { type: 'image/png' }), ...extra });
let moduleId = 0;
const isolatedCache = () => import(`./navigation-icon-cache.js?regression=${++moduleId}`);
const encryptedImages = createEncryptedStore('navigation-icons');
const originalStore = Object.fromEntries(['get', 'set', 'remove', 'entries'].map((name) => [name, encryptedImages[name]]));
const originalLocalGet = localData.get;
afterEach(() => { Object.assign(encryptedImages, originalStore); localData.get = originalLocalGet; });
const globalRestores = new WeakMap();

function replaceGlobal(t, key, value) {
  let restored = globalRestores.get(t);
  if (!restored) { restored = new Set(); globalRestores.set(t, restored); }
  if (!restored.has(key)) {
    restored.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

// Decrypting a persistent record yields a distinct value for every actual
// read. Preserve that behavior: sharing only network work would still replace
// URLs retained by other mounted tiles when the cache is already warm.
function mockEncryptedStore(t, initial, held = new Set()) {
  if (typeof globalThis.createImageBitmap !== 'function') replaceGlobal(t, 'createImageBitmap', async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20), close() {} };
  });
  const records = new Map(initial.map((item) => [item.url, structuredClone(item)]));
  const reads = new Map(), waiting = new Map();
  const release = (url) => {
    held.delete(url);
    for (const complete of waiting.get(url) || []) complete();
    waiting.delete(url);
  };
  replaceGlobal(t, 'indexedDB', undefined); // Legacy migration is intentionally a no-op here.
  localData.get = async () => ({});
  Object.assign(encryptedImages, {
    async get(url) {
      reads.set(url, (reads.get(url) || 0) + 1);
      if (held.has(url)) await new Promise((resolve) => waiting.set(url, [...(waiting.get(url) || []), resolve]));
      return structuredClone(records.get(url));
    },
    async set(url, item) { records.set(url, structuredClone(item)); },
    async remove(url) { records.delete(url); },
    async entries() { return [...records].map(([url, item]) => [url, structuredClone(item)]); },
  });
  t.after(() => { for (const url of held) release(url); });
  return { records, reads, release };
}

test('concurrent warm-cache consumers share one validated record and one encrypted-cache read', async (t) => {
  const url = 'https://icons.example/shared.png';
  const store = mockEncryptedStore(t, [record(url)]);
  let networkCalls = 0;
  replaceGlobal(t, 'fetch', async () => { networkCalls++; throw Error('Warm icons stay local.'); });
  const { navigationIcon } = await isolatedCache();
  const [tile, editor, drag] = await Promise.all([
    navigationIcon(url), navigationIcon(`${url}#ignored-fragment`), navigationIcon(url),
  ]);
  assert(tile?.blob instanceof Blob);
  assert.equal(tile, editor, 'the editor must not create an independently cloned shared record');
  assert.equal(tile, drag, 'the drag preview shares the desktop record');
  assert.equal(store.reads.get(url), 1);
  assert.equal(await navigationIcon(url), tile, 'later readers use the same session record');
  assert.equal(store.reads.get(url), 1);
  assert.equal(networkCalls, 0);
});

test('a pending cache read for one URL does not block another URL', async (t) => {
  const first = 'https://icons.example/first.png', second = 'https://icons.example/second.png';
  const store = mockEncryptedStore(t, [record(first), record(second)], new Set([first]));
  replaceGlobal(t, 'fetch', async () => { throw Error('Warm icons stay local.'); });
  const { navigationIcon } = await isolatedCache();
  let firstReady = false;
  const pending = navigationIcon(first).then((value) => { firstReady = true; return value; });
  await setImmediate();
  const ready = await navigationIcon(second);
  assert.equal(ready?.url, second);
  assert.equal(firstReady, false, 'unrelated icon requests must not serialize behind a delayed cache read');
  assert.equal(store.reads.get(first), 1);
  assert.equal(store.reads.get(second), 1);
  store.release(first);
  assert.equal((await pending)?.url, first);
});

test('corrupt cached bytes are rejected and a forced retry can recover after a transient fetch failure', async (t) => {
  const url = 'https://icons.example/recover.png';
  const store = mockEncryptedStore(t, [record(url, { blob: new Blob(['not a PNG'], { type: 'image/png' }) })]);
  let networkCalls = 0, available = false, decoded = 0;
  replaceGlobal(t, 'fetch', async (input, options) => {
    assert.equal(input, url); assert.equal(options.credentials, 'omit');
    networkCalls++;
    if (!available) throw Error('Temporary network failure.');
    return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  });
  replaceGlobal(t, 'createImageBitmap', async () => ({ width: 16, height: 16, close() { decoded++; } }));
  const { navigationIcon } = await isolatedCache();
  assert.equal(await navigationIcon(url), null, 'corrupt persistent bytes are never exposed as artwork');
  assert.equal(networkCalls, 0, 'normal rendering cannot try the remote source of an invalid cached image');
  assert.equal(await navigationIcon(url, { force: true }), null);
  assert.equal(networkCalls, 1);
  available = true;
  assert.equal(await navigationIcon(url), null, 'ordinary reads respect the bounded failure cooldown');
  assert.equal(networkCalls, 1);
  const recovered = await navigationIcon(url, { force: true });
  assert(recovered?.blob instanceof Blob);
  assert.deepEqual(new Uint8Array(await recovered.blob.arrayBuffer()), PNG);
  assert.equal(networkCalls, 2);
  assert.equal(decoded, 1);
  assert.equal(await navigationIcon(url), recovered);
  assert.deepEqual(new Uint8Array(await store.records.get(url).blob.arrayBuffer()), PNG);
});

test('cache-only warm reads and misses never fetch a saved website', async (t) => {
  const known = 'https://icons.example/offline.png', missing = 'https://icons.example/missing.png';
  const store = mockEncryptedStore(t, [record(known)]);
  let networkCalls = 0;
  replaceGlobal(t, 'fetch', async () => { networkCalls++; throw Error('Cache-only reads must stay offline.'); });
  const { readCachedNavigationIcon, peekNavigationIcon, navigationIcon } = await isolatedCache();
  assert.equal(peekNavigationIcon(known), null, 'a synchronous lookup must not read storage or start a request');
  const [tile, preview] = await Promise.all([readCachedNavigationIcon(known), readCachedNavigationIcon(`${known}#fragment`)]);
  assert(tile?.blob instanceof Blob);
  assert.equal(tile, preview);
  assert.equal(peekNavigationIcon(`${known}#fragment`), tile, 'startup can synchronously adopt the validated local record');
  assert.equal(store.reads.get(known), 1);
  assert.equal(await navigationIcon(known), tile);
  assert.equal(await readCachedNavigationIcon(missing), null);
  assert.equal(await readCachedNavigationIcon('javascript:alert(1)'), null);
  assert.equal(store.reads.get(missing), 1);
  assert.equal(store.records.size, 1, 'a cache miss does not invent or persist a fallback image');
  assert.equal(networkCalls, 0);
});

test('saving a new icon preserves more than 64 persisted desktop icons after memory-cache eviction', async (t) => {
  const existing = Array.from({ length: 70 }, (_, index) => record(`https://icons.example/saved-${index}.png`));
  const store = mockEncryptedStore(t, existing), navigation = createEmptyState();
  navigation.entries = existing.map(({ url }, index) => ({ id: `saved-${index}`, type: 'site', name: `Saved ${index}`,
    url: `https://saved-${index}.example/`, groupId: 'group-home', parentId: null, order: index,
    icon: index % 3 === 1 ? { kind: 'url', value: url } : { kind: 'letter', value: 'S' },
    ...(index % 3 === 0 ? { iconUrl: url } : index % 3 === 2 ? { iconVariants: {
      light: { url, fit: 'contain' }, dark: { url, fit: 'contain' },
    } } : {}),
  }));
  let navigationReads = 0, entryReads = 0, networkCalls = 0;
  localData.get = async (key) => {
    assert.equal(key, 'owntab.local.v1'); navigationReads++;
    return { [key]: { version: 1, state: structuredClone(navigation), snapshots: [] } };
  };
  const entries = encryptedImages.entries;
  encryptedImages.entries = async () => { entryReads++; return entries(); };
  const added = 'https://icons.example/new.png';
  replaceGlobal(t, 'fetch', async (url) => {
    assert.equal(url, added); networkCalls++;
    return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  });
  replaceGlobal(t, 'createImageBitmap', async () => ({ width: 16, height: 16, close() {} }));
  const { readCachedNavigationIcon, navigationIcon } = await isolatedCache();
  const warm = await Promise.all(existing.map(({ url }) => readCachedNavigationIcon(url)));
  assert(warm.every((item) => item?.blob instanceof Blob), 'all 70 existing records pass normal cache validation');
  assert.equal((await navigationIcon(added, { force: true }))?.url, added);
  assert.equal(networkCalls, 1);
  assert.equal(navigationReads, 1);
  assert.equal(entryReads, 1, 'disk cleanup must run; a swallowed navigation-read failure cannot make this test pass');
  assert.equal(store.records.size, 71);
  for (const previous of existing) {
    const persisted = store.records.get(previous.url);
    assert(persisted, `saved desktop icon was pruned: ${previous.url}`);
    assert.equal(persisted.updatedAt, previous.updatedAt);
    assert.deepEqual(new Uint8Array(await persisted.blob.arrayBuffer()), PNG);
  }
  const oldest = await readCachedNavigationIcon(existing[0].url);
  assert(oldest?.blob instanceof Blob);
  assert.equal(store.reads.get(existing[0].url), 2, 'an icon evicted from the small memory LRU remains available on disk');
  assert.equal(networkCalls, 1, 'reloading an evicted memory icon must not fetch it again');
});

test('a synchronized replacement under the same URL refreshes memory without deleting encrypted image bytes', async (t) => {
  const url = 'https://icons.example/replaced.png', initial = record(url);
  const store = mockEncryptedStore(t, [initial]);
  replaceGlobal(t, 'fetch', async () => { throw Error('Synchronized icons stay offline.'); });
  const { readCachedNavigationIcon, invalidateNavigationIconCache } = await isolatedCache();
  const before = await readCachedNavigationIcon(url);
  const incoming = record(url, { vector: true, updatedAt: initial.updatedAt + 1 });
  store.records.set(url, incoming);
  invalidateNavigationIconCache();
  const after = await readCachedNavigationIcon(url);
  assert.notEqual(after, before);
  assert.equal(after.vector, true);
  assert.equal(after.updatedAt, incoming.updatedAt);
  assert.equal(store.reads.get(url), 2);
  assert.equal(store.records.size, 1);
  assert.deepEqual(new Uint8Array(await store.records.get(url).blob.arrayBuffer()), PNG);
});

test('a decode started before sync cannot overwrite incoming bytes after the import completes', async (t) => {
  const url = 'https://icons.example/decode-race.png';
  const store = mockEncryptedStore(t, []);
  let release, decodeStarted, decoding = false;
  const started = new Promise((resolve) => { decodeStarted = resolve; });
  replaceGlobal(t, 'fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  replaceGlobal(t, 'createImageBitmap', async () => {
    if (!decoding) { decoding = true; decodeStarted(); await new Promise((resolve) => { release = resolve; }); }
    return { width: 16, height: 16, close() {} };
  });
  const { navigationIcon, invalidateNavigationIconCache } = await isolatedCache();
  const oldFetch = navigationIcon(url, { force: true });
  await started;
  const incoming = record(url, { vector: true, updatedAt: Date.now() + 1 });
  store.records.set(url, incoming);
  invalidateNavigationIconCache();
  release();
  assert.equal(await oldFetch, null);
  assert.equal(store.records.get(url).vector, true);
  assert.equal((await navigationIcon(url)).updatedAt, incoming.updatedAt);
});

test('valid persistent artwork never expires or refreshes itself, even after years', async (t) => {
  const url = 'https://icons.example/permanent.png', updatedAt = Date.now() - 10 * 365 * 86400000;
  const store = mockEncryptedStore(t, [record(url, { updatedAt })]);
  let requests = 0;
  replaceGlobal(t, 'fetch', async () => { requests++; throw Error('An existing icon must remain offline.'); });
  const { navigationIcon, readCachedNavigationIcon, peekNavigationIcon, invalidateNavigationIconCache } = await isolatedCache();
  assert.equal((await navigationIcon(url)).updatedAt, updatedAt);
  assert.equal(peekNavigationIcon(url).updatedAt, updatedAt);
  invalidateNavigationIconCache();
  assert.equal((await readCachedNavigationIcon(url)).updatedAt, updatedAt);
  assert.equal((await navigationIcon(url)).updatedAt, updatedAt);
  assert.equal(store.records.get(url).updatedAt, updatedAt, 'reading must not rewrite the saved image timestamp');
  assert.equal(requests, 0);
});

test('only an explicit refresh replaces valid cached bytes at the same URL and publishes the replacement', async (t) => {
  const url = 'https://icons.example/manual.png', updatedAt = 1;
  const store = mockEncryptedStore(t, [record(url, { updatedAt })]);
  const nextBytes = new Uint8Array(readFileSync(new URL('../../public/icons/icon-32.png', import.meta.url)));
  let requests = 0;
  replaceGlobal(t, 'fetch', async (_url, options) => { assert.equal(options.cache, 'no-store'); requests++; return new Response(nextBytes, { headers: { 'content-type': 'image/png' } }); });
  const { navigationIcon, subscribeNavigationIcons } = await isolatedCache();
  const changes = [], unsubscribe = subscribeNavigationIcons(item => changes.push(item)); t.after(unsubscribe);
  assert.equal((await navigationIcon(url)).updatedAt, updatedAt);
  assert.equal(requests, 0);
  const next = await navigationIcon(url, { force: true });
  assert.equal(requests, 1);
  assert.equal(next.width, 32);
  assert.deepEqual(new Uint8Array(await store.records.get(url).blob.arrayBuffer()), nextBytes);
  assert.deepEqual(changes, [next]);
  assert.equal(await navigationIcon(url), next);
  assert.equal(requests, 1, 'opening the refreshed icon must not fetch it again');
});

test('a failed manual refresh preserves the prior cached icon and does not publish a broken replacement', async (t) => {
  const url = 'https://icons.example/keep-old.png';
  const store = mockEncryptedStore(t, [record(url, { updatedAt: 1 })]);
  let requests = 0;
  replaceGlobal(t, 'fetch', async () => { requests++; throw Error('Offline during an explicit refresh.'); });
  const { navigationIcon, subscribeNavigationIcons } = await isolatedCache();
  const changes = [], unsubscribe = subscribeNavigationIcons(item => changes.push(item)); t.after(unsubscribe);
  const old = await navigationIcon(url);
  assert.equal(await navigationIcon(url, { force: true }), null);
  assert.equal(await navigationIcon(url), old);
  assert.equal(store.records.get(url).updatedAt, 1);
  assert.equal(requests, 1);
  assert.deepEqual(changes, []);
});

test('a cache-only miss never joins or starts the explicit download in progress', async (t) => {
  const url = 'https://icons.example/manual-race.png';
  const store = mockEncryptedStore(t, []);
  let decodeStarted, release, decodes = 0;
  const started = new Promise(resolve => { decodeStarted = resolve; });
  replaceGlobal(t, 'fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  replaceGlobal(t, 'createImageBitmap', async () => {
    const initial = ++decodes === 1;
    if (initial) { decodeStarted(); await new Promise(resolve => { release = resolve; }); }
    return { width: initial ? 16 : 32, height: initial ? 16 : 32, close() {} };
  });
  const { navigationIcon } = await isolatedCache();
  assert.equal(await navigationIcon(url), null);
  const initial = navigationIcon(url, { force: true });
  await started;
  assert.equal(await navigationIcon(url), null, 'a normal render must not wait for or trigger the HTTP operation');
  const sameRefresh = navigationIcon(url, { force: true });
  release();
  const refreshed = await initial;
  assert.equal(await sameRefresh, refreshed);
  assert.equal(decodes, 1);
  assert.equal(store.records.get(url).width, 16);
  assert.equal(await navigationIcon(url), refreshed);
});

test('a native favicon decoding before a manual refresh cannot overwrite the refreshed icon', async (t) => {
  const url = 'https://icons.example/native-manual-race.png';
  const store = mockEncryptedStore(t, []);
  let decodeStarted, release, decodes = 0;
  const started = new Promise(resolve => { decodeStarted = resolve; });
  replaceGlobal(t, 'fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  replaceGlobal(t, 'createImageBitmap', async () => {
    const native = ++decodes === 1;
    if (native) { decodeStarted(); await new Promise(resolve => { release = resolve; }); }
    return { width: native ? 16 : 32, height: native ? 16 : 32, close() {} };
  });
  const { navigationIcon, cacheNavigationIconBlob } = await isolatedCache();
  const native = cacheNavigationIconBlob(url, new Blob([PNG], { type: 'image/png' }));
  await started;
  const refreshed = await navigationIcon(url, { force: true });
  release();
  assert.equal(await native, null);
  assert.equal(store.records.get(url).width, 32);
  assert.equal(await navigationIcon(url), refreshed);
});

test('empty default-icon caches are seeded from extension resources once, never their remote source', async (t) => {
  const { BUNDLED_NAVIGATION_ICONS } = await import('./bundled-navigation-icons.js');
  const store = mockEncryptedStore(t, []), id = 'a'.repeat(32), requests = [];
  replaceGlobal(t, 'chrome', { runtime: { id, getURL: path => `chrome-extension://${id}/${path}` } });
  replaceGlobal(t, 'fetch', async source => {
    requests.push(source);
    assert(source.startsWith(`chrome-extension://${id}/assets/default-sites/`), 'seeding must not request the official HTTPS URL');
    const file = source.split('/').at(-1), bytes = readFileSync(new URL(`../../public/assets/default-sites/${file}`, import.meta.url));
    return new Response(bytes, { headers: { 'content-type': file.endsWith('.webp') ? 'image/webp' : 'image/png' } });
  });
  replaceGlobal(t, 'createImageBitmap', async () => ({ width: 128, height: 128, close() {} }));
  const { navigationIcon, invalidateNavigationIconCache } = await isolatedCache();
  for (const source of Object.keys(BUNDLED_NAVIGATION_ICONS)) assert((await navigationIcon(source))?.blob instanceof Blob);
  assert.equal(store.records.size, 6);
  assert.equal(requests.length, 6);
  invalidateNavigationIconCache();
  for (const source of Object.keys(BUNDLED_NAVIGATION_ICONS)) assert((await navigationIcon(source))?.blob instanceof Blob);
  assert.equal(requests.length, 6, 'later pages use the encrypted copies without re-reading even the bundled files');
});

test('bundled defaults never replace a user-cached image at the same official URL', async (t) => {
  const url = 'https://www.google.com/images/branding/googleg/2x/googleg_standard_color_128dp.png';
  const store = mockEncryptedStore(t, [record(url, { updatedAt: 1 })]);
  replaceGlobal(t, 'chrome', { runtime: { id: 'a'.repeat(32), getURL: path => `chrome-extension://${'a'.repeat(32)}/${path}` } });
  replaceGlobal(t, 'fetch', async () => { throw Error('The valid user copy has priority over bundled artwork'); });
  const { navigationIcon } = await isolatedCache();
  assert.equal((await navigationIcon(url)).width, 16);
  assert.equal(store.records.get(url).updatedAt, 1);
});

test('renaming a site or changing its background never downloads its missing icon', async (t) => {
  const url = 'https://icons.example/name-only.png';
  mockEncryptedStore(t, []);
  let requests = 0;
  replaceGlobal(t, 'fetch', async () => { requests++; throw Error('No user request to change artwork'); });
  const previous = { type: 'site', url: 'https://site.example/', name: 'Before', iconUrl: url, icon: { kind: 'url', value: url } };
  const { prepareSavedNavigationIcon } = await isolatedCache();
  assert.equal(await prepareSavedNavigationIcon({ ...previous, name: 'After', iconBackground: '#fff' }, previous), true);
  assert.equal(requests, 0);
});

test('submitting a new icon URL persists its bytes, while a failed replacement keeps the old cache', async (t) => {
  const oldUrl = 'https://icons.example/old.png', newUrl = 'https://icons.example/user-chosen.png';
  const store = mockEncryptedStore(t, [record(oldUrl)]);
  let available = true, requests = 0;
  replaceGlobal(t, 'fetch', async () => { requests++; if (!available) throw Error('CORS failure'); return new Response(PNG, { headers: { 'content-type': 'image/png' } }); });
  replaceGlobal(t, 'createImageBitmap', async () => ({ width: 16, height: 16, close() {} }));
  const previous = { type: 'site', url: 'https://site.example/', iconUrl: oldUrl, icon: { kind: 'url', value: oldUrl } };
  const { prepareSavedNavigationIcon, navigationIcon } = await isolatedCache();
  const edited = { ...previous, iconUrl: newUrl, icon: { kind: 'url', value: newUrl } };
  assert.equal(await prepareSavedNavigationIcon(edited, previous), true);
  assert.deepEqual(new Uint8Array(await store.records.get(newUrl).blob.arrayBuffer()), PNG);
  assert((await navigationIcon(newUrl))?.blob instanceof Blob);
  assert.equal(requests, 1);
  available = false;
  assert.equal(await prepareSavedNavigationIcon({ ...edited, iconUrl: 'https://icons.example/unreadable.png' }, edited), false);
  assert(store.records.has(newUrl)); assert(store.records.has(oldUrl));
  assert(!store.records.has('https://icons.example/unreadable.png'));
});

test('backup resources replace corrupt local bytes without issuing a network request', async (t) => {
  const url = 'https://icons.example/restore-corrupt.png';
  const store = mockEncryptedStore(t, [record(url, { blob: new Blob(['broken'], { type: 'image/png' }) })]);
  replaceGlobal(t, 'fetch', async () => { throw Error('Backup bytes are complete'); });
  replaceGlobal(t, 'createImageBitmap', async () => ({ width: 16, height: 16, close() {} }));
  const { readNavigationIconResource, restoreNavigationIconResource, peekNavigationIcon } = await isolatedCache();
  assert.equal(await readNavigationIconResource(url), null);
  const restored = await restoreNavigationIconResource(record(url, { updatedAt: 1000 }));
  assert(restored); assert.equal(restored.updatedAt, 1000);
  assert.deepEqual(new Uint8Array(await store.records.get(url).blob.arrayBuffer()), PNG);
  assert.equal(peekNavigationIcon(url), restored);
});

test('backup resources preserve a valid local icon at the same address', async (t) => {
  const url = 'https://icons.example/preserve-local.png';
  const store = mockEncryptedStore(t, [record(url, { updatedAt: 1 })]);
  let writes = 0;
  encryptedImages.set = async () => { writes++; throw Error('A valid local image must not be overwritten'); };
  replaceGlobal(t, 'fetch', async () => { throw Error('No download while restoring bytes'); });
  replaceGlobal(t, 'createImageBitmap', async () => ({ width: 16, height: 16, close() {} }));
  const { restoreNavigationIconResource } = await isolatedCache();
  const restored = await restoreNavigationIconResource(record(url, { updatedAt: 2000 }));
  assert.equal(restored.updatedAt, 1); assert.equal(writes, 0); assert.equal(store.records.get(url).updatedAt, 1);
});

test('incoming backup artwork at an official default URL is restored before bundled seeding', async (t) => {
  const url = 'https://www.google.com/images/branding/googleg/2x/googleg_standard_color_128dp.png';
  const store = mockEncryptedStore(t, []), id = 'b'.repeat(32);
  let requests = 0;
  replaceGlobal(t, 'chrome', { runtime: { id, getURL: path => `chrome-extension://${id}/${path}` } });
  replaceGlobal(t, 'fetch', async () => { requests++; throw Error('Packaged seed must not precede incoming backup artwork'); });
  replaceGlobal(t, 'createImageBitmap', async () => ({ width: 16, height: 16, close() {} }));
  const { restoreNavigationIconResource, readNavigationIconResource } = await isolatedCache();
  const restored = await restoreNavigationIconResource(record(url, { updatedAt: 3456 }));
  assert.equal(restored?.updatedAt, 3456); assert.equal(restored?.width, 16);
  assert.equal((await readNavigationIconResource(url)).updatedAt, 3456);
  assert.equal(store.records.get(url).updatedAt, 3456); assert.equal(requests, 0);
});

test('portable adaptive icon resources retain both light and dark original bitmaps', async (t) => {
  const url = 'https://icons.example/adaptive-backup.svg', store = mockEncryptedStore(t, []);
  replaceGlobal(t, 'createImageBitmap', async () => ({ width: 16, height: 16, close() {} }));
  replaceGlobal(t, 'fetch', async () => { throw Error('Both theme images are in the backup'); });
  const { restoreNavigationIconResource, readNavigationIconResource, invalidateNavigationIconCache } = await isolatedCache();
  const incoming = record(url, { vector: true, adaptive: true, darkBlob: new Blob([PNG], { type: 'image/png' }), updatedAt: 4567 });
  assert(await restoreNavigationIconResource(incoming));
  invalidateNavigationIconCache();
  const restored = await readNavigationIconResource(url);
  assert.equal(restored.adaptive, true); assert.equal(restored.vector, true);
  assert.deepEqual(new Uint8Array(await restored.blob.arrayBuffer()), PNG);
  assert.deepEqual(new Uint8Array(await restored.darkBlob.arrayBuffer()), PNG);
  assert(store.records.get(url).darkBlob instanceof Blob);
});

test('invalid backup icon resources never enter the encrypted or live display cache', async (t) => {
  const url = 'https://icons.example/invalid-backup.png', store = mockEncryptedStore(t, []);
  replaceGlobal(t, 'createImageBitmap', async () => ({ width: 16, height: 16, close() {} }));
  replaceGlobal(t, 'fetch', async () => { throw Error('Invalid resources cannot trigger retrieval'); });
  const { restoreNavigationIconResource, peekNavigationIcon } = await isolatedCache();
  for (const patch of [
    { url: 'chrome-extension://other/private.png' }, { updatedAt: NaN }, { width: 0 }, { height: 4097 },
    { width: 32 }, { vector: 'yes' }, { adaptive: true },
    { blob: new Blob(['not-an-image'], { type: 'image/png' }) },
    { blob: new Blob([PNG], { type: 'text/html' }) },
    { adaptive: true, darkBlob: new Blob(['broken'], { type: 'image/png' }) },
  ]) assert.equal(await restoreNavigationIconResource(record(url, patch)), null);
  assert.equal(store.records.size, 0); assert.equal(peekNavigationIcon(url), null);
});

test('a backup decode begun before a manual refresh cannot overwrite the new generation', async (t) => {
  const url = 'https://icons.example/restore-manual-race.png', store = mockEncryptedStore(t, []);
  let release, begin, decodes = 0;
  const started = new Promise(resolve => { begin = resolve; });
  replaceGlobal(t, 'fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  replaceGlobal(t, 'createImageBitmap', async () => {
    const backup = ++decodes === 1;
    if (backup) { begin(); await new Promise(resolve => { release = resolve; }); }
    return { width: backup ? 16 : 32, height: backup ? 16 : 32, close() {} };
  });
  const { restoreNavigationIconResource, navigationIcon } = await isolatedCache();
  const restoring = restoreNavigationIconResource(record(url, { updatedAt: 123 }));
  await started;
  const refreshed = await navigationIcon(url, { force: true });
  release();
  const restored = await restoring;
  assert(restored === null || restored === refreshed, 'an overlapping restore may adopt the newer valid record, but never its stale backup bytes');
  assert.equal(store.records.get(url).width, 32); assert.equal(await navigationIcon(url), refreshed);
});

test('an encrypted write rejection cannot become a displayed-only success or notify consumers', async (t) => {
  const url = 'https://icons.example/quota-missing.png', store = mockEncryptedStore(t, []);
  encryptedImages.set = async () => { throw Error('Quota exceeded'); };
  replaceGlobal(t, 'fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  replaceGlobal(t, 'createImageBitmap', async () => ({ width: 16, height: 16, close() {} }));
  const { restoreNavigationIconResource, navigationIcon, peekNavigationIcon, subscribeNavigationIcons } = await isolatedCache();
  let notifications = 0;
  const unsubscribe = subscribeNavigationIcons(() => { notifications++; }); t.after(unsubscribe);
  assert.equal(await restoreNavigationIconResource(record(url)), null);
  assert.equal(peekNavigationIcon(url), null); assert.equal(store.records.size, 0);
  assert.equal(await navigationIcon(url, { force: true }), null);
  assert.equal(peekNavigationIcon(url), null); assert.equal(notifications, 0); assert.equal(store.records.size, 0);
});

test('failed persistence of a manual replacement preserves the previous encrypted and mounted icon', async (t) => {
  const url = 'https://icons.example/quota-old.png', store = mockEncryptedStore(t, [record(url, { updatedAt: 1 })]);
  replaceGlobal(t, 'fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  const { navigationIcon, peekNavigationIcon, subscribeNavigationIcons } = await isolatedCache();
  const previous = await navigationIcon(url); let notifications = 0;
  const unsubscribe = subscribeNavigationIcons(() => { notifications++; }); t.after(unsubscribe);
  encryptedImages.set = async () => { throw Error('Quota exceeded'); };
  assert.equal(await navigationIcon(url, { force: true }), null);
  assert.equal(peekNavigationIcon(url), previous); assert.equal(await navigationIcon(url), previous);
  assert.equal(store.records.get(url).updatedAt, 1); assert.equal(store.records.get(url).width, 16);
  assert.equal(notifications, 0);
});

test('portable resource reads stay local when an arbitrary saved source is missing', async (t) => {
  const url = 'https://icons.example/backup-read-only.png'; mockEncryptedStore(t, []);
  let requests = 0;
  replaceGlobal(t, 'fetch', async () => { requests++; throw Error('Resource export must not retrieve missing images'); });
  const { readNavigationIconResource } = await isolatedCache();
  assert.equal(await readNavigationIconResource(url), null); assert.equal(requests, 0);
});

test('overlapping import leases protect old incoming resources before the navigation commit and release them for normal cleanup', async (t) => {
  const existing = Array.from({ length: 4096 }, (_, index) => record(`https://icons.example/capacity-${index}.png`, { updatedAt: 10000 - index }));
  const store = mockEncryptedStore(t, existing), incoming = 'https://icons.example/incoming-old-backup.png';
  replaceGlobal(t, 'createImageBitmap', async () => ({ width: 16, height: 16, close() {} }));
  replaceGlobal(t, 'fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  const { retainNavigationIconResources, restoreNavigationIconResource, navigationIcon } = await isolatedCache();
  const importing = { entries: [{ id: 'incoming', type: 'site', url: 'https://incoming.example/', iconUrl: incoming, icon: { kind: 'letter', value: 'I' } }] };
  const first = retainNavigationIconResources(importing), second = retainNavigationIconResources(importing);
  t.after(first); t.after(second);
  assert(await restoreNavigationIconResource(record(incoming, { updatedAt: 1 })));
  assert(store.records.has(incoming), 'even the oldest incoming resource survives its own pre-commit cleanup');
  assert(await navigationIcon('https://icons.example/new-capacity-first.png', { force: true }));
  assert(store.records.has(incoming), 'subsequent resource saves cannot prune bytes still needed by an active import');
  first(); first();
  assert(await navigationIcon('https://icons.example/new-capacity-second.png', { force: true }));
  assert(store.records.has(incoming), 'releasing one lease twice must not release a different import owner');
  second();
  assert(await navigationIcon('https://icons.example/new-capacity-third.png', { force: true }));
  assert(!store.records.has(incoming), 'unreferenced old artwork becomes eligible once every import releases it');
  assert.equal(store.records.size, 4096, 'the retention lease must not permanently disable capacity cleanup');
});

test('stored owned trash and navigation snapshots pin cached icons until a committed purge releases every reference', async (t) => {
  const retained = 'https://icons.example/owned-old.png';
  const existing = [record(retained, { updatedAt: 1 }), ...Array.from({ length: 4095 }, (_, index) => record(`https://icons.example/pinned-${index}.png`, { updatedAt: 10000 - index }))];
  const store = mockEncryptedStore(t, existing);
  const owned = { id: 'gone', type: 'site', url: 'https://gone.example/', iconUrl: retained, icon: { kind: 'letter', value: 'G' } };
  let envelope = { version: 1, state: { entries: [], trash: { version: 1, items: [{ deletedAt: 1, ownedEntries: [owned] }] } }, snapshots: [] };
  localData.get = async (key) => ({ [key]: structuredClone(envelope) });
  replaceGlobal(t, 'fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  const { navigationIcon } = await isolatedCache();
  assert(await navigationIcon('https://icons.example/new-owned-1.png', { force: true })); assert(store.records.has(retained));
  envelope = { ...envelope, state: { entries: [], trash: { version: 1, items: [] } }, snapshots: [{ entries: [owned] }] };
  assert(await navigationIcon('https://icons.example/new-owned-2.png', { force: true })); assert(store.records.has(retained));
  envelope.snapshots = [];
  assert(await navigationIcon('https://icons.example/new-owned-3.png', { force: true })); assert(!store.records.has(retained));
});

test('a cross-page icon replacement fences an older in-flight download and retains the newer encrypted bytes', async (t) => {
  const url = 'https://icons.example/cross-page-race.png', store = mockEncryptedStore(t, [record(url, { updatedAt: 1 })]);
  const channels = [];
  class TestBroadcastChannel {
    constructor(name) { this.name = name; this.sent = []; this.onmessage = null; channels.push(this); }
    postMessage(message) { this.sent.push(message); }
    close() { this.onmessage = null; }
  }
  replaceGlobal(t, 'location', { protocol: 'chrome-extension:' });
  replaceGlobal(t, 'BroadcastChannel', TestBroadcastChannel);
  t.after(() => { for (const channel of channels) channel.close(); });
  let release, begin;
  const started = new Promise(resolve => { begin = resolve; });
  const staleBytes = readFileSync(new URL('../../public/icons/icon-32.png', import.meta.url));
  replaceGlobal(t, 'fetch', async () => { begin(); await new Promise(resolve => { release = resolve; }); return new Response(staleBytes, { headers: { 'content-type': 'image/png' } }); });
  const { navigationIcon, readNavigationIconResource, subscribeNavigationIcons, peekNavigationIcon } = await isolatedCache();
  const published = [], unsubscribe = subscribeNavigationIcons(item => published.push(item)); t.after(unsubscribe);
  assert.equal(channels.length, 1); assert.equal(channels[0].name, 'covelet.navigation-icons.changed.v1');
  assert.equal((await readNavigationIconResource(url)).updatedAt, 1);
  const oldDownload = navigationIcon(url, { force: true });
  await started;
  const incoming = record(url, { updatedAt: 999, vector: true });
  store.records.set(url, incoming);
  await channels[0].onmessage({ data: { version: 1, url } });
  assert.equal(peekNavigationIcon(url).updatedAt, 999); assert.equal(published.length, 1);
  release();
  assert.equal(await oldDownload, null, 'work started before the external replacement cannot publish stale bytes');
  assert.equal(store.records.get(url).updatedAt, 999); assert.equal(store.records.get(url).vector, true);
  assert.equal((await navigationIcon(url)).updatedAt, 999); assert.equal(published.length, 1);
});

test('header-valid cached bytes that fail bitmap decoding are missing and may be restored from valid backup bytes', async (t) => {
  const url = 'https://icons.example/truncated-cached.png';
  const truncated = new Blob([PNG.subarray(0, 33)], { type: 'image/png' });
  const store = mockEncryptedStore(t, [record(url, { blob: truncated })]);
  let failedDecodes = 0;
  replaceGlobal(t, 'createImageBitmap', async (blob) => {
    if (blob.size === truncated.size) { failedDecodes++; throw Error('Truncated PNG has no decodable pixels'); }
    return { width: 16, height: 16, close() {} };
  });
  let requests = 0;
  replaceGlobal(t, 'fetch', async () => { requests++; throw Error('Local repair must not download'); });
  const { readNavigationIconResource, restoreNavigationIconResource, peekNavigationIcon } = await isolatedCache();
  assert.equal(await readNavigationIconResource(url), null); assert.equal(peekNavigationIcon(url), null);
  assert(failedDecodes > 0, 'the cached header alone must not count as successful image validation');
  assert(await restoreNavigationIconResource(record(url, { updatedAt: 999 })));
  assert.equal(store.records.get(url).updatedAt, 999); assert.equal(requests, 0);
});

test('cached image dimensions must match their decoded pixels rather than trusting metadata', async (t) => {
  const url = 'https://icons.example/cached-dimension-mismatch.png';
  mockEncryptedStore(t, [record(url, { width: 32, height: 32 })]);
  let requests = 0;
  replaceGlobal(t, 'fetch', async () => { requests++; throw Error('Invalid cache reads do not fetch'); });
  const { readNavigationIconResource, peekNavigationIcon } = await isolatedCache();
  assert.equal(await readNavigationIconResource(url), null);
  assert.equal(peekNavigationIcon(url), null); assert.equal(requests, 0);
});

test('a PNG returned with an ICO MIME or no image MIME persists as real PNG bytes', async (t) => {
  const store = mockEncryptedStore(t, []);
  replaceGlobal(t, 'fetch', async (url) => new Response(PNG, { headers: url.includes('ico') ? { 'content-type': 'image/vnd.microsoft.icon' } : {} }));
  const { navigationIcon, getNavigationIconFailure } = await isolatedCache();
  for (const url of ['https://icons.example/favicon.ico', 'https://icons.example/unknown']) {
    const item = await navigationIcon(url, { force: true });
    assert.equal(item.blob.type, 'image/png'); assert.equal(store.records.get(url).blob.type, 'image/png');
    assert.equal(getNavigationIconFailure(url), null);
  }
});

test('image redirects retain the configured source key while using valid final image bytes', async (t) => {
  const url = 'https://icons.example/redirect.png', store = mockEncryptedStore(t, []);
  replaceGlobal(t, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'follow');
    const response = new Response(PNG, { headers: { 'content-type': 'image/png' } });
    Object.defineProperty(response, 'url', { value: 'https://cdn.example/final.png' });
    Object.defineProperty(response, 'redirected', { value: true }); return response;
  });
  const { navigationIcon } = await isolatedCache();
  assert.equal((await navigationIcon(url, { force: true })).url, url);
  assert(store.records.has(url)); assert(!store.records.has('https://cdn.example/final.png'));
});

test('manual fetch failures report HTTP, format, decode, permission and persistence stages without erasing old bytes', async (t) => {
  const url = 'https://icons.example/failure.png', store = mockEncryptedStore(t, [record(url)]);
  const { navigationIcon, getNavigationIconFailure, readCachedNavigationIcon } = await isolatedCache();
  const original = await readCachedNavigationIcon(url);
  replaceGlobal(t, 'fetch', async () => new Response('not found', { status: 404 }));
  assert.equal(await navigationIcon(url, { force: true }), null); assert.deepEqual(getNavigationIconFailure(url), { code: 'HTTP', httpStatus: 404 });
  replaceGlobal(t, 'fetch', async () => new Response('<html>Challenge</html>', { headers: { 'content-type': 'image/png' } }));
  assert.equal(await navigationIcon(url, { force: true }), null); assert.equal(getNavigationIconFailure(url).code, 'FORMAT');
  replaceGlobal(t, 'fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  replaceGlobal(t, 'createImageBitmap', async () => { throw Error('Bad decode'); });
  assert.equal(await navigationIcon(url, { force: true }), null); assert.equal(getNavigationIconFailure(url).code, 'DECODE');
  replaceGlobal(t, 'chrome', { permissions: { contains: async () => false } });
  replaceGlobal(t, 'fetch', async () => { throw TypeError('Failed to fetch'); });
  assert.equal(await navigationIcon(url, { force: true }), null); assert.equal(getNavigationIconFailure(url).code, 'ACCESS');
  assert.equal(await readCachedNavigationIcon(url), original);
  assert.deepEqual(new Uint8Array(await store.records.get(url).blob.arrayBuffer()), PNG);
});

test('a user-edited same source checks its missing cache while a naming-only save remains local', async (t) => {
  const url = 'https://icons.example/repeated.png'; mockEncryptedStore(t, []); let requests = 0;
  replaceGlobal(t, 'fetch', async () => { requests++; return new Response(PNG, { headers: { 'content-type': 'image/png' } }); });
  const { prepareSavedNavigationIcon } = await isolatedCache();
  const entry = { id: 'entry', type: 'site', url: 'https://site.example/', iconUrl: url };
  assert(await prepareSavedNavigationIcon({ ...entry, name: 'Changed name' }, entry)); assert.equal(requests, 0);
  assert(await prepareSavedNavigationIcon(entry, entry, { iconEdited: true })); assert.equal(requests, 1);
});

test('cancelling an explicitly owned acquisition aborts its fetch and never saves new bytes', async (t) => {
  const url = 'https://icons.example/aborted.png', store = mockEncryptedStore(t, []), controller = new AbortController();
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  replaceGlobal(t, 'fetch', async (_url, { signal }) => { started(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); });
  const { navigationIcon, getNavigationIconFailure } = await isolatedCache();
  const work = navigationIcon(url, { force: true, signal: controller.signal });
  await begun; controller.abort(); assert.equal(await work, null);
  assert.equal(store.records.has(url), false); assert.equal(getNavigationIconFailure(url).code, 'CANCELLED');
});

test('a decoded image completed after cancellation cannot enter the encrypted or mounted cache', async (t) => {
  const url = 'https://icons.example/slow-decode.png', store = mockEncryptedStore(t, []), controller = new AbortController();
  let begin, release;
  const started = new Promise(resolve => { begin = resolve; }), held = new Promise(resolve => { release = resolve; });
  replaceGlobal(t, 'fetch', async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
  replaceGlobal(t, 'createImageBitmap', async () => { begin(); await held; return { width: 16, height: 16, close() {} }; });
  const { navigationIcon, peekNavigationIcon, getNavigationIconFailure } = await isolatedCache();
  const work = navigationIcon(url, { force: true, signal: controller.signal });
  await started; controller.abort(); release();
  assert.equal(await work, null); assert.equal(store.records.has(url), false); assert.equal(peekNavigationIcon(url), null);
  assert.equal(getNavigationIconFailure(url).code, 'CANCELLED');
});

test('a full replacement restore adopts backup bytes even when a valid local URL version exists', async (t) => {
  const url = 'https://icons.example/version.png', store = mockEncryptedStore(t, [record(url, { updatedAt: 1 })]);
  const { restoreNavigationIconResource, readCachedNavigationIcon } = await isolatedCache();
  const previous = await readCachedNavigationIcon(url), incoming = record(url, { updatedAt: 99 });
  assert.equal(await restoreNavigationIconResource(incoming), previous);
  const replaced = await restoreNavigationIconResource(incoming, { replace: true });
  assert.equal(replaced.updatedAt, 99); assert.equal(store.records.get(url).updatedAt, 99);
});

test('recognized images over byte, SVG or pixel budgets report limits rather than unsupported formats', async (t) => {
  const url = 'https://icons.example/oversize.png'; mockEncryptedStore(t, []);
  const { navigationIcon, getNavigationIconFailure } = await isolatedCache();
  for (const response of [
    new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(1024 * 1024 + 1) } }),
    new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
    new Response(`<svg>${' '.repeat(128 * 1024)}</svg>`, { headers: { 'content-type': 'image/svg+xml' } }),
  ]) {
    replaceGlobal(t, 'fetch', async () => response);
    assert.equal(await navigationIcon(url, { force: true }), null);
    assert.equal(getNavigationIconFailure(url).code, 'LIMIT');
  }
  const bomb = PNG.slice(); new DataView(bomb.buffer).setUint32(16, 100000);
  replaceGlobal(t, 'fetch', async () => new Response(bomb, { headers: { 'content-type': 'image/png' } }));
  assert.equal(await navigationIcon(url, { force: true }), null); assert.equal(getNavigationIconFailure(url).code, 'LIMIT');
});
