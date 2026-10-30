import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createNavigationIconIntake, navigationIconSources, requestNavigationIconAccess } from './navigation-icon-intake.js';

const icon = (source) => ({ url: source, blob: new Blob(['fixture'], { type: 'image/png' }), width: 32, height: 32 });
const site = (id, source, extra = {}) => ({ id, type: 'site', name: id, url: `https://${id}.example/private?token=kept-local`,
  icon: { kind: 'letter', value: id }, ...(source ? { iconUrl: source } : {}), ...extra });
const state = (...entries) => ({ entries });
function fixtures(initial = []) {
  const records = new Map(initial.map((source) => [source, icon(source)]));
  const fetched = [], nativePages = [], stored = [];
  return { records, fetched, nativePages, stored,
    read: async (source) => records.get(source) || null,
    fetch: async (source, options) => {
      fetched.push({ source, options });
      const value = icon(source); records.set(source, value); return value;
    },
    native: async (page) => { nativePages.push(page); return null; },
    store: async (source, blob) => { stored.push({ source, blob }); const value = { ...icon(source), blob }; records.set(source, value); return value; },
  };
}

test('intake gathers unique portable sources, including folder children and both themes, without treating uploaded assets as remote icons', () => {
  const shared = 'https://icons.example/shared.png', dark = 'https://icons.example/dark.png';
  const entries = state(
    site('first', shared, { iconVariants: { light: { url: shared, fit: 'contain' }, dark: { url: dark, fit: 'contain' } } }),
    site('child', shared, { parentId: 'folder' }),
    site('uploaded', 'https://icons.example/unused.png', { icon: { kind: 'image', value: 'local-asset' } }),
    { id: 'folder', type: 'folder', icon: { kind: 'letter', value: 'F' } },
    { id: 'clock', type: 'widget', icon: { kind: 'letter', value: 'C' } },
  );
  const sources = navigationIconSources(entries);
  assert.deepEqual(sources.map((entry) => entry.source), [shared, dark]);
  assert.equal(sources[0].entryId, 'first');
  assert.equal(sources[0].pageUrl, entries.entries[0].url);
  assert(sources.every((entry) => entry.conventional === false));
});

test('an old URL-only backup hydrates once during import and later imports read its persistent bytes', async () => {
  const source = 'https://icons.example/legacy.png', data = state(site('legacy', source));
  const io = fixtures(), intake = createNavigationIconIntake(io), progress = [];
  const first = await intake.prepare(data, { onIconProgress: (report) => progress.push(structuredClone(report)) });
  assert.equal(first.total, 1); assert.equal(first.completed, 1);
  assert.equal(first.downloaded, 1); assert.equal(first.cached, 0); assert.equal(first.failed, 0);
  assert.deepEqual(first.missing, []);
  assert.deepEqual(io.fetched, [{ source, options: { force: true } }]);
  assert(io.records.has(source));
  assert.equal(progress[0].completed, 0); assert.equal(progress.at(-1).completed, 1);
  const again = await intake.prepare(data);
  assert.equal(again.cached, 1); assert.equal(again.downloaded, 0);
  assert.equal(io.fetched.length, 1, 'valid imported bytes do not need another download');
});

test('complete backup resources and shared theme images restore with no network or native lookup', async () => {
  const light = 'https://icons.example/light.png', dark = 'https://icons.example/dark.png';
  const io = fixtures([light, dark]);
  const data = state(site('first', light, { iconVariants: { light: { url: light, fit: 'contain' }, dark: { url: dark, fit: 'cover' } } }), site('second', dark));
  const report = await createNavigationIconIntake(io).prepare(data);
  assert.equal(report.total, 2); assert.equal(report.completed, 2); assert.equal(report.cached, 2);
  assert.equal(report.downloaded, 0); assert.equal(report.native, 0); assert.deepEqual(report.missing, []);
  assert.equal(io.fetched.length, 0); assert.equal(io.nativePages.length, 0);
});

test('a conventional missing favicon uses persistent browser bytes before any external request', async () => {
  const entry = site('native'), source = 'https://native.example/favicon.ico', blob = new Blob(['native'], { type: 'image/png' });
  const io = fixtures();
  io.native = async (page) => { io.nativePages.push(page); return blob; };
  const report = await createNavigationIconIntake(io).prepare(state(entry));
  assert.equal(report.native, 1); assert.equal(report.downloaded, 0); assert.equal(report.failed, 0);
  assert.deepEqual(io.nativePages, [entry.url]);
  assert.deepEqual(io.stored, [{ source, blob }]);
  assert.equal(io.fetched.length, 0); assert(io.records.has(source));
});

test('a missing native favicon falls back only to the exact conventional image address', async () => {
  const io = fixtures(), entry = site('unknown');
  const report = await createNavigationIconIntake(io).prepare(state(entry));
  assert.equal(report.downloaded, 1); assert.equal(report.native, 0);
  assert.deepEqual(io.fetched.map(({ source }) => source), ['https://unknown.example/favicon.ico']);
  assert.deepEqual(io.nativePages, [entry.url]);
});

test('a native lookup error still permits the selected exact favicon to be retrieved', async () => {
  const io = fixtures();
  io.native = async () => { throw Error('Native resource unavailable'); };
  const report = await createNavigationIconIntake(io).prepare(state(site('native-error')));
  assert.equal(report.downloaded, 1); assert.equal(report.native, 0); assert.equal(report.failed, 0);
  assert.deepEqual(io.fetched.map(({ source }) => source), ['https://native-error.example/favicon.ico']);
});

test('a native image that could not be persisted is not reported as a successful restoration', async () => {
  const io = fixtures();
  io.native = async () => new Blob(['native'], { type: 'image/png' });
  io.store = async () => null;
  io.fetch = async () => null;
  const report = await createNavigationIconIntake(io).prepare(state(site('quota')));
  assert.equal(report.native, 0); assert.equal(report.downloaded, 0); assert.equal(report.failed, 1);
  assert.equal(report.missing[0].source, 'https://quota.example/favicon.ico');
});

test('an unavailable custom image is never replaced by an unrelated browser favicon', async () => {
  const source = 'https://custom-cdn.example/chosen-logo.png', io = fixtures();
  io.fetch = async (address) => { io.fetched.push(address); throw Error('CORS protected'); };
  io.native = async (page) => { io.nativePages.push(page); return new Blob(['unrelated']); };
  const report = await createNavigationIconIntake(io).prepare(state(site('custom', source)));
  assert.equal(report.failed, 1); assert.equal(report.completed, 1);
  assert.deepEqual(report.missing.map(({ source: address, entryId }) => ({ source: address, entryId })), [{ source, entryId: 'custom' }]);
  assert.equal(io.nativePages.length, 0); assert.equal(io.stored.length, 0);
});

test('checking missing images is cache-only and preserves source descriptors for explicit repair', async () => {
  const known = 'https://icons.example/known.png', missing = 'https://icons.example/missing.png', io = fixtures([known]);
  const data = state(site('known', known), site('missing', missing));
  const result = await createNavigationIconIntake(io).missing(data);
  assert.deepEqual(result, [{ source: missing, entryId: 'missing', pageUrl: data.entries[1].url, conventional: false }]);
  assert.equal(io.fetched.length, 0); assert.equal(io.nativePages.length, 0); assert.equal(io.stored.length, 0);
});

test('permission retry touches only previously failed sources still referenced by current navigation', async () => {
  const io = fixtures();
  const data = state(site('theme', 'https://icons.example/main.png', { iconVariants: {
    light: { url: 'https://icons.example/light.png', fit: 'contain' },
    dark: { url: 'https://icons.example/dark.png', fit: 'contain' },
  } }), site('new-other-tab', 'https://new.example/icon.png'));
  const report = await createNavigationIconIntake(io).prepare(data, {
    sourceUrls: ['https://icons.example/dark.png', 'https://removed.example/icon.png'],
  });
  assert.equal(report.total, 1); assert.equal(report.downloaded, 1);
  assert.equal(io.fetched.length, 1); assert.equal(io.fetched[0].source, 'https://icons.example/dark.png');
});

test('individual retrieval failures do not block other images and remain available for an explicit retry', async () => {
  const bad = 'https://icons.example/offline.png', good = 'https://icons.example/available.png', io = fixtures();
  let offline = true;
  const fetchIcon = io.fetch;
  io.fetch = async (source, options) => {
    if (source === bad && offline) { io.fetched.push({ source, options }); throw Error('Offline'); }
    return fetchIcon(source, options);
  };
  const data = state(site('offline', bad), site('available', good)), intake = createNavigationIconIntake(io);
  const first = await intake.prepare(data);
  assert.equal(first.completed, 2); assert.equal(first.downloaded, 1); assert.equal(first.failed, 1);
  assert.equal(first.missing[0].source, bad); assert(io.records.has(good)); assert(!io.records.has(bad));
  await intake.missing(data);
  assert.equal(io.fetched.length, 2, 'cache-only inspection does not automatically retry failures');
  offline = false;
  const retry = await intake.prepare(data);
  assert.equal(retry.cached, 1); assert.equal(retry.downloaded, 1); assert.equal(retry.failed, 0);
  assert.deepEqual(retry.missing, []); assert.equal(io.fetched.length, 3);
});

test('a bulk import paces more than the image bridge queue limit instead of dropping later entries', async () => {
  const io = fixtures(); let active = 0, maximum = 0;
  const fetchIcon = io.fetch;
  io.fetch = async (source, options) => {
    active++; maximum = Math.max(maximum, active);
    try { await setImmediate(); return await fetchIcon(source, options); }
    finally { active--; }
  };
  const data = state(...Array.from({ length: 120 }, (_, index) => site(`site-${index}`, `https://icons.example/${index}.png`)));
  const report = await createNavigationIconIntake({ ...io, concurrency: 3 }).prepare(data);
  assert.equal(report.total, 120); assert.equal(report.completed, 120); assert.equal(report.downloaded, 120); assert.equal(report.failed, 0);
  assert.equal(io.fetched.length, 120); assert.equal(io.records.size, 120);
  assert(maximum <= 3); assert(maximum > 1, 'independent downloads can run concurrently');
});

test('a superseded import stops starting later downloads after its generation changes', async () => {
  let current = true, started = 0, release;
  const held = new Promise((resolve) => { release = resolve; });
  const io = fixtures();
  io.fetch = async (source) => { started++; await held; return icon(source); };
  const data = state(...Array.from({ length: 15 }, (_, index) => site(`old-${index}`, `https://icons.example/old-${index}.png`)));
  const work = createNavigationIconIntake({ ...io, concurrency: 3 }).prepare(data, { isCurrent: () => current });
  for (let turn = 0; started < 3 && turn < 100; turn++) await setImmediate();
  assert.equal(started, 3, 'the initial bounded workers begin before cancellation');
  current = false; release();
  const report = await work;
  assert.equal(report.cancelled, true);
  assert.equal(started, 3, 'queued entries from the superseded import are never started');
});

test('permission repair requests only the exact failed image origins and deduplicates their paths', async () => {
  const calls = [], failed = [
    { source: 'https://cdn.example/a.png', pageUrl: 'https://site.example/private' },
    { source: 'https://cdn.example/b.png?size=128' },
    { source: 'https://cdn.example:8443/c.png' },
    { source: 'http://legacy.example/icon.ico' },
  ];
  const api = { permissions: { request: (value) => { calls.push(value); return Promise.resolve(true); } } };
  const pending = requestNavigationIconAccess(failed, api);
  assert.equal(calls.length, 1, 'request begins synchronously inside the originating click gesture');
  assert.equal(await pending, true);
  assert.deepEqual(calls[0], { origins: ['https://cdn.example/*', 'https://cdn.example:8443/*', 'http://legacy.example/*'] });
  assert(!calls[0].origins.includes('https://site.example/*'), 'website access is not implicitly requested for CDN artwork');
  assert(calls[0].origins.every((origin) => !origin.includes('*://') && !origin.includes('*/*/*') && !origin.includes('*.')));
});

test('denied, throwing and unavailable image permissions remain ordinary repair failures', async () => {
  const failed = [{ source: 'https://cdn.example/icon.png' }];
  assert.equal(await requestNavigationIconAccess(failed, { permissions: { request: () => false } }), false);
  assert.equal(await requestNavigationIconAccess(failed, { permissions: { request: () => Promise.reject(Error('Denied')) } }), false);
  assert.equal(await requestNavigationIconAccess(failed, { permissions: { request: () => { throw Error('No user gesture'); } } }), false);
  assert.equal(await requestNavigationIconAccess(failed, {}), false);
});

test('empty and invalid repair sources never expand into wildcard permissions', async () => {
  let calls = 0;
  const api = { permissions: { request: () => { calls++; return true; } } };
  assert.equal(await requestNavigationIconAccess([], api), true);
  assert.equal(await requestNavigationIconAccess([
    { source: 'file:///private/icon.png' }, { source: 'chrome-extension://other/icon.png' },
    { source: 'https://user:secret@cdn.example/icon.png' }, { source: 'https://*.example/icon.png' },
    { source: 'not-a-url' },
  ], api), true);
  assert.equal(calls, 0);
});
