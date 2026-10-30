import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizeSite } from './site-recognition.js';

const image = () => new Blob(['test fixture'], { type: 'image/png' });
const api = (allowed, requests) => ({ runtime: { id: 'test' }, permissions: {
  contains: async () => allowed, request: async () => { requests.count++; return true; },
} });

test('automatic recognition of multiple new origins never prompts or requests their web pages', async () => {
  const requests = { count: 0 }, calls = [];
  let remoteCalls = 0;
  const icon = image();
  for (const origin of ['https://example.com', 'https://different.example']) {
    const result = await recognizeSite(`${origin}/private?token=secret#value`, {
      api: api(false, requests), browserIcon: async (input) => { calls.push(input); return icon; },
      remoteInfo: async () => { remoteCalls++; throw Error('No host grant.'); },
      highResolutionIcon: async () => null,
    });
    assert.equal(result.icon, icon);
    assert.equal(result.title, new URL(origin).hostname);
    assert.equal(result.hasAccess, false);
  }
  assert.deepEqual(calls, ['https://example.com', 'https://different.example']);
  assert.equal(remoteCalls, 0); assert.equal(requests.count, 0);
});

test('an existing exact-origin grant keeps automatic real names and icons without prompting', async () => {
  const requests = { count: 0 }, icon = image();
  let nativeCalls = 0;
  const result = await recognizeSite('https://example.com/private?secret=1', {
    api: api(true, requests), browserIcon: async () => { nativeCalls++; return null; },
    highResolutionIcon: async () => null,
    remoteInfo: async (input) => { assert.equal(input, 'https://example.com'); return { title: '官方网站', icon, message: '已识别网站名称和图标。' }; },
  });
  assert.equal(result.title, '官方网站'); assert.equal(result.icon, icon);
  assert.equal(nativeCalls, 0); assert.equal(requests.count, 0);
});

test('homepage failure cannot block a browser icon or leak a misleading size error', async () => {
  const requests = { count: 0 }, icon = image();
  const result = await recognizeSite('https://example.com', {
    api: api(true, requests), browserIcon: async () => icon,
    highResolutionIcon: async () => null,
    remoteInfo: async () => { throw Error('网站响应超过识别大小限制。'); },
  });
  assert.equal(result.icon, icon); assert(!result.message.includes('超过'));
  assert.equal(requests.count, 0);
});

test('an explicit low-resolution PNG is selected independently of HD discovery and website metadata', async () => {
  const requests = { count: 0 }, calls = [];
  const source = 'https://www.gstatic.com/search-console/scfe/favicon.png';
  const controller = new AbortController();
  const result = await recognizeSite('https://search.google.com/search-console/private', {
    api: api(true, requests), iconUrl: source, forceIcon: true, signal: controller.signal,
    directIcon: async (url, options) => {
      calls.push('image'); assert.equal(url, source); assert.equal(options.force, true); assert.equal(options.signal, controller.signal);
      return { url, width: 32, height: 32, vector: false, adaptive: false };
    },
    remoteInfo: async () => { calls.push('metadata'); return { title: 'Search Console', nameFound: true, iconLinks: [{ url: 'https://other.example/large.png' }] }; },
    highResolutionIcon: async () => { throw Error('The explicit selection must not be replaced by discovery.'); },
    browserIcon: async () => { throw Error('Native artwork must not replace the chosen CDN picture.'); },
  });
  assert.deepEqual(calls, ['image', 'metadata']);
  assert.equal(result.iconUrl, source); assert.equal(result.iconAvailable, true); assert.equal(result.highResolution, false);
  assert.equal(result.title, 'Search Console'); assert.equal(result.iconError, null); assert.equal(requests.count, 0);
});

test('failed explicit acquisition preserves its source and error instead of switching to an unrelated image', async () => {
  const requests = { count: 0 }, source = 'https://cdn.example/chosen.png'; let alternatives = 0;
  const result = await recognizeSite('https://website.example/', {
    api: api(true, requests), iconUrl: source, forceIcon: true,
    directIcon: async () => { throw Object.assign(Error('Permission'), { code: 'ACCESS' }); },
    remoteInfo: async () => ({ title: 'Website', nameFound: true, icon: image(), iconUrl: 'https://other.example/default.png' }),
    highResolutionIcon: async () => { alternatives++; return { url: 'https://other.example/default.png' }; },
    browserIcon: async () => { alternatives++; return image(); },
  });
  assert.equal(result.iconAvailable, false); assert.equal(result.icon, null); assert.equal(result.iconUrl, '');
  assert.deepEqual(result.iconError, { code: 'ACCESS', source }); assert.equal(alternatives, 0); assert.equal(result.title, 'Website');
});

test('a usable ordinary discovery result is available even when it is not HD', async () => {
  const result = await recognizeSite('https://example.com', {
    api: api(false, { count: 0 }), highResolutionIcon: async () => ({ url: 'https://cdn.example/favicon.png', width: 32, height: 32, vector: false }),
    browserIcon: async () => { throw Error('Do not replace the usable downloaded icon.'); },
  });
  assert.equal(result.iconAvailable, true); assert.equal(result.highResolution, false); assert.equal(result.iconUrl, 'https://cdn.example/favicon.png');
});

test('external cancellation cannot return an image result for a superseded form', async () => {
  const controller = new AbortController();
  await assert.rejects(recognizeSite('https://example.com', {
    api: api(false, { count: 0 }), iconUrl: 'https://cdn.example/icon.png', signal: controller.signal,
    directIcon: async () => { controller.abort(); return { width: 32, height: 32, vector: false }; },
  }), { name: 'AbortError' });
});

test('missing native icons and plain previews remain an ordinary text fallback', async () => {
  const result = await recognizeSite('https://www.example.com/private', {
    api: {}, browserIcon: async () => null, remoteInfo: async () => { throw Error('Unexpected host request.'); },
  });
  assert.equal(result.title, 'example.com'); assert.equal(result.icon, null);
  assert.equal(result.hasAccess, false); assert(!result.message.includes('授权后获取'));
});
