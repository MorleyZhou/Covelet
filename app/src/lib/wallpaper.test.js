import test from 'node:test';
import assert from 'node:assert/strict';
import { BING_METADATA_URL, createWallpaperProvider, validateBingImageUrl } from './wallpaper.js';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB0kAAAAASUVORK5CYII=', 'base64'));
const metadata = () => ({ images: [{
  startdate: '20261018', enddate: '20261019',
  url: '/th?id=OHR.VeniceSunrise_ZH-CN5251815339_1920x1080.jpg&rf=LaDigue_1920x1080.jpg&pid=hp',
  copyright: '威尼斯 (© Example Photo)', title: '水上通衢',
  copyrightlink: 'https://www.bing.com/search?q=Venice&form=hpcapt&mkt=zh-cn',
}] });

function harness(overrides = {}) {
  let stored = null;
  let timestamp = new Date(2026, 9, 19, 12).getTime();
  let serial = 0;
  let queue = Promise.resolve();
  const calls = [];
  const revoked = [];
  const options = {
    extension: true, now: () => timestamp,
    cache: { read: async () => structuredClone(stored), write: async (value) => { stored = structuredClone(value); } },
    locks: { request(_name, _options, action) { const next = queue.then(action, action); queue = next.catch(() => {}); return next; } },
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return url === BING_METADATA_URL
        ? new Response(JSON.stringify(metadata()), { headers: { 'content-type': 'application/json; charset=utf-8' } })
        : new Response(PNG, { headers: { 'content-type': 'image/png' } });
    },
    createObjectURL: () => `blob:wallpaper-${++serial}`,
    revokeObjectURL: (url) => revoked.push(url), decode: null,
    ...overrides,
  };
  return {
    options, calls, revoked, provider: createWallpaperProvider(options),
    nextDay() { timestamp += 24 * 60 * 60 * 1000; },
    advanceMinutes(minutes) { timestamp += minutes * 60 * 1000; },
    get stored() { return stored; }, set stored(value) { stored = value; },
  };
}

test('Bing provider restricts requests, caches one daily image and disposes only its own blob URLs', async () => {
  const subject = harness();
  const result = await subject.provider.load();
  assert.equal(result.source, 'bing');
  assert.equal(result.status, 'fresh');
  assert.equal(result.message, '今日壁纸已更新。');
  assert.equal(result.title, '水上通衢');
  assert.match(result.copyright, /Example Photo/);
  assert.equal(subject.calls.length, 2);
  assert.equal(subject.calls[0].url, BING_METADATA_URL);
  assert.equal(subject.calls[1].url, 'https://www.bing.com/th?id=OHR.VeniceSunrise_ZH-CN5251815339_1920x1080.jpg');
  for (const { init } of subject.calls) {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.method, 'GET');
    assert(init.signal instanceof AbortSignal);
    assert.equal('body' in init, false);
  }
  assert(subject.stored.blob instanceof Blob);
  const next = await createWallpaperProvider(subject.options).load();
  assert.equal(next.status, 'cached');
  assert.equal(next.message, '正在使用今日缓存。');
  assert.equal(subject.calls.length, 2);
  subject.provider.dispose({ url: 'https://www.bing.com/' });
  subject.provider.dispose(result);
  subject.provider.dispose(result);
  assert.deepEqual(subject.revoked, [result.url]);
});

test('sync replaces an older wallpaper record without prematurely revoking the displayed URL', async () => {
  const subject = harness(), current = await subject.provider.load();
  const incoming = structuredClone(subject.stored);
  incoming.attemptAt--;
  incoming.metadata.title = '同步背景';
  subject.stored = incoming;
  subject.provider.invalidate();
  const next = await subject.provider.load();
  assert.equal(next.title, '同步背景');
  assert.equal(next.status, 'cached');
  assert.equal(subject.calls.length, 2, 'valid synchronized daily pixels do not need a new network fetch');
  assert.deepEqual(subject.revoked, [], 'the mounted consumer still owns the old image URL');
  assert.notEqual(next.url, current.url);
  subject.provider.dispose(current);
  assert.deepEqual(subject.revoked, [current.url]);
  subject.provider.dispose(next);
});

test('image allowlist rejects arbitrary hosts, endpoints, credentials and unexpected parameters', () => {
  const invalid = [
    'https://example.com/th?id=OHR.Foo_1920x1080.jpg',
    'http://www.bing.com/th?id=OHR.Foo_1920x1080.jpg',
    'https://user@www.bing.com/th?id=OHR.Foo_1920x1080.jpg',
    'https://www.bing.com/redirect?id=OHR.Foo_1920x1080.jpg',
    '/th?id=OHR.Foo_1920x1080.jpg#fragment',
    '/th?id=OHR.Foo_1920x1080.jpg&target=https://example.com/',
    '/th?id=OHR.Foo_1920x1080.jpg&id=OHR.Bar_1920x1080.jpg',
    '/th?id=OHR.Foo_1920x1080.jpg&pid=other',
    '/th?id=not-OHR_1920x1080.jpg',
    '\\example.com\th?id=OHR.Foo_1920x1080.jpg',
  ];
  for (const url of invalid) assert.throws(() => validateBingImageUrl(url), undefined, url);
});

test('hostile metadata never causes an image request and fails back to the packaged wallpaper', async () => {
  for (const mutate of [
    (data) => { data.images[0].url = 'https://evil.example/th?id=OHR.Foo_1920x1080.jpg'; },
    (data) => { data.images[0].copyrightlink = 'https://evil.example/search?q=x'; },
    (data) => { data.images[0].copyrightlink = 'https://www.bing.com/redirect?q=x'; },
  ]) {
    let calls = 0;
    const subject = harness({ fetcher: async () => {
      calls++;
      const value = metadata(); mutate(value);
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    } });
    const result = await subject.provider.load();
    assert.equal(result.source, 'builtin');
    assert.equal(result.url, './assets/alpine-lake.png');
    assert.equal(calls, 1);
    await subject.provider.load();
    assert.equal(calls, 1, 'failed requests are throttled during the cooldown');
  }
});

test('request timeout aborts the request and does not repeatedly retry on every new tab', async () => {
  let observed;
  let calls = 0;
  const subject = harness({ timeoutMs: 10, fetcher: (_url, init) => {
    calls++;
    observed = init.signal;
    return new Promise(() => {});
  } });
  assert.equal((await subject.provider.load()).source, 'builtin');
  assert.equal(observed.aborted, true);
  assert.equal((await createWallpaperProvider(subject.options).load()).source, 'builtin');
  assert.equal(calls, 1);
});

test('failed daily refresh retains the previous image, then retries on the next day', async () => {
  const subject = harness();
  await subject.provider.load();
  const oldBlob = subject.stored.blob;
  subject.nextDay();
  let failures = 0;
  const offline = createWallpaperProvider({ ...subject.options, fetcher: async () => { failures++; throw new Error('offline'); } });
  const result = await offline.load();
  assert.equal(result.source, 'bing');
  assert.equal(result.stale, true);
  assert.equal(subject.stored.blob.size, oldBlob.size);
  await offline.load();
  assert.equal(failures, 1);
  subject.nextDay();
  assert.equal((await createWallpaperProvider(subject.options).load()).status, 'fresh');
  assert.equal(subject.calls.length, 4);
});

test('a failed morning request retries after 15 minutes, then reuses the successful image all day', async () => {
  const subject = harness();
  let attempts = 0;
  const provider = createWallpaperProvider({ ...subject.options, fetcher: async (url, init) => {
    if (++attempts === 1) throw new Error('temporarily offline');
    return subject.options.fetcher(url, init);
  } });
  assert.equal((await provider.load()).source, 'builtin');
  subject.advanceMinutes(14);
  assert.equal((await provider.load()).source, 'builtin');
  assert.equal(attempts, 1);
  subject.advanceMinutes(1);
  assert.equal((await provider.load()).status, 'fresh');
  assert.equal(attempts, 3);
  subject.advanceMinutes(120);
  assert.equal((await provider.load()).status, 'cached');
  assert.equal(attempts, 3);
});

test('concurrent providers share the daily cache under an exclusive navigator lock', async () => {
  const subject = harness();
  const another = createWallpaperProvider(subject.options);
  const [first, second, third] = await Promise.all([subject.provider.load(), another.load(), subject.provider.load()]);
  assert.deepEqual([first.source, second.source, third.source], ['bing', 'bing', 'bing']);
  assert.equal(subject.calls.length, 2);
  assert.notEqual(first.url, third.url, 'each consumer owns an independently disposable object URL');
});

test('malformed, oversize or redirected responses cannot become a cached image', async () => {
  const tooManyPixels = PNG.slice();
  new DataView(tooManyPixels.buffer).setUint32(16, 9000);
  const cases = [
    () => new Response('<html>bad</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(11 * 1024 * 1024) } }),
    () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    () => new Response(tooManyPixels, { headers: { 'content-type': 'image/png' } }),
    () => Object.defineProperty(new Response(PNG, { headers: { 'content-type': 'image/png' } }), 'redirected', { value: true }),
  ];
  for (const makeResponse of cases) {
    const subject = harness({ fetcher: async (url) => url === BING_METADATA_URL
      ? new Response(JSON.stringify(metadata()), { headers: { 'content-type': 'application/json' } })
      : makeResponse() });
    const result = await subject.provider.load();
    assert.equal(result.source, 'builtin');
    assert.equal(subject.stored.blob, undefined);
  }
});

test('a corrupt cached image is discarded and cannot bypass the daily request throttle', async () => {
  const subject = harness();
  await subject.provider.load();
  subject.stored = { ...subject.stored, blob: new Blob(['not an image'], { type: 'image/png' }) };
  const result = await createWallpaperProvider(subject.options).load();
  assert.equal(result.source, 'builtin');
  assert.equal(subject.calls.length, 2);
});

test('plain production web pages never make Bing requests without an extension environment', async () => {
  const subject = harness({ extension: false });
  const result = await subject.provider.load();
  assert.equal(result.source, 'builtin');
  assert.match(result.message, /加载浏览器扩展/);
  assert.equal(subject.calls.length, 0);
  assert.equal(subject.stored, null);
});

test('an explicit Bing shuffle selects a different validated image from the archive', async () => {
  const subject = harness();
  let archiveRequests = 0;
  const alternative = { ...metadata().images[0], url: '/th?id=OHR.Ocean_1920x1080.jpg' };
  const provider = createWallpaperProvider({ ...subject.options, random: () => 0, fetcher: async (url, init) => {
    if (!url.includes('&n=8&')) return subject.options.fetcher(url, init);
    archiveRequests++;
    return Response.json({ images: [metadata().images[0], { ...alternative, url: 'https://evil.example/th' }, alternative] });
  } });
  const [daily, shuffled] = await Promise.all([provider.load(), provider.load({ force: true })]);
  assert.equal(archiveRequests, 1);
  assert.notEqual(shuffled.imageUrl, daily.imageUrl);
  assert.equal(shuffled.imageUrl, 'https://www.bing.com/th?id=OHR.Ocean_1920x1080.jpg');
  assert.equal(shuffled.status, 'fresh');
  assert.equal((await provider.load()).imageUrl, shuffled.imageUrl);
});

test('scheduled rotation reads an old cache and concurrent reopened tabs fetch only one new picture', async () => {
  const subject = harness();
  const daily = await subject.provider.load();
  delete subject.stored.fetchedAt;
  const loadedAt = subject.stored.attemptAt;
  let archiveRequests = 0;
  const options = { ...subject.options, fetcher: async (url, init) => {
    if (!url.includes('&n=8&')) return subject.options.fetcher(url, init);
    archiveRequests++;
    const [first] = metadata().images;
    return Response.json({ images: [first, { ...first, url: '/th?id=OHR.Ocean_1920x1080.jpg' }] });
  } };
  const firstTab = createWallpaperProvider(options), secondTab = createWallpaperProvider(options);
  const cadence = { interval: '5-minute' };
  subject.advanceMinutes(4);
  const cached = await firstTab.load(cadence);
  assert.equal(cached.imageUrl, daily.imageUrl);
  assert.equal(cached.nextRefreshAt, loadedAt + 5 * 60_000);
  assert.equal(archiveRequests, 0);
  subject.advanceMinutes(1);
  const results = await Promise.all([firstTab.load(cadence), secondTab.load(cadence)]);
  assert.equal(archiveRequests, 1);
  assert.equal(results[0].status, 'fresh');
  assert.equal(results[1].status, 'cached');
  for (const result of results) {
    assert.notEqual(result.imageUrl, daily.imageUrl);
    assert.equal(result.nextRefreshAt, loadedAt + 10 * 60_000);
  }
});

test('a failed scheduled refresh retains the last image and throttles requests across tabs', async () => {
  const subject = harness();
  const cadence = { interval: '5-minute' };
  const first = await subject.provider.load(cadence);
  let failures = 0;
  const options = { ...subject.options, fetcher: async () => { failures++; throw new Error('offline'); } };
  subject.advanceMinutes(5);
  const failed = await createWallpaperProvider(options).load(cadence);
  assert.equal(failed.imageUrl, first.imageUrl);
  assert.equal(failed.status, 'stale');
  assert.equal(failed.nextRefreshAt, first.nextRefreshAt + 15 * 60_000);
  subject.advanceMinutes(5);
  assert.equal((await createWallpaperProvider(options).load(cadence)).nextRefreshAt, failed.nextRefreshAt);
  assert.equal(failures, 1);
});

test('monthly rotation lands on the last day of a shorter calendar month', async () => {
  let timestamp = new Date(2026, 0, 31, 13).getTime();
  const subject = harness({ now: () => timestamp, hasSourceAccess: async () => true });
  const cadence = { source: 'commons', interval: '1-month' };
  const first = await subject.provider.load(cadence);
  assert.equal(first.nextRefreshAt, new Date(2026, 1, 28, 13).getTime());
  timestamp = first.nextRefreshAt - 1;
  assert.equal((await subject.provider.load(cadence)).imageUrl, first.imageUrl);
  assert.equal(subject.calls.length, 1);
  timestamp++;
  assert.notEqual((await subject.provider.load(cadence)).imageUrl, first.imageUrl);
  assert.equal(subject.calls.length, 2);
});

test('Wikimedia shuffles different licensed photos, uses an isolated cache and needs an origin grant to download', async () => {
  const records = new Map();
  const permissionsChecked = [];
  let permission = false;
  const subject = harness({
    cache: {
      read: async (source) => records.get(source),
      write: async (value, _options, source) => { records.set(source, value); },
    },
    random: () => 0,
    hasSourceAccess: async (origin) => { permissionsChecked.push(origin); return origin === 'https://www.bing.com' || permission; },
  });
  assert.equal((await subject.provider.load({ source: 'commons', force: true })).source, 'builtin');
  assert.deepEqual(permissionsChecked, ['https://upload.wikimedia.org']);
  assert.equal(subject.calls.length, 0);
  assert.equal(records.size, 0);

  permission = true;
  const first = await subject.provider.load({ source: 'commons' });
  assert.equal(first.source, 'commons');
  assert.equal(first.status, 'fresh');
  assert.equal(first.title, 'Moraine Lake');
  assert.equal(first.copyright, 'Bruno.menetrier');
  assert.match(first.copyrightUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
  assert.equal(subject.calls[0].url, first.imageUrl);
  assert.equal(subject.calls[0].init.credentials, 'omit');
  assert.equal(subject.calls[0].init.referrerPolicy, 'no-referrer');

  const shuffled = await subject.provider.load({ source: 'commons', force: true });
  assert.equal(shuffled.status, 'fresh');
  assert.notEqual(shuffled.imageUrl, first.imageUrl);
  assert.equal(subject.calls.length, 2);
  assert.equal((await subject.provider.load()).source, 'bing');
  assert.deepEqual([...records.keys()], ['commons', 'bing']);

  permission = false;
  subject.nextDay();
  const reopened = createWallpaperProvider(subject.options);
  assert.equal((await reopened.load({ source: 'commons', cachedOnly: true })).imageUrl, shuffled.imageUrl);
  assert.equal((await reopened.load({ source: 'commons' })).status, 'stale');
  assert.equal(subject.calls.length, 4, 'a revoked origin cannot fetch but previously cached bytes still work');
});
