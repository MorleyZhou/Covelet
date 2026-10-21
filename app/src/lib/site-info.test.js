import test from 'node:test';
import assert from 'node:assert/strict';
import { canReadSite, parseSiteMetadata, readSiteInfo, requestSiteAccess, siteOrigin, supportsSiteInfo, validateIconBytes } from './site-info.js';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB0kAAAAASUVORK5CYII=', 'base64'));
const grantedApi = () => ({ runtime: { id: 'test-extension' }, permissions: { contains: async () => true, request: async () => true } });
const png = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });
const html = (value) => new Response(value, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const convert = async () => new Blob([PNG], { type: 'image/png' });

test('recognition requests access immediately and only to the explicitly entered origin', async () => {
  let requests = [], contains = [];
  const api = { runtime: { id: 'extension' }, permissions: {
    request: (value) => { requests.push(value); return Promise.resolve(true); },
    contains: (value) => { contains.push(value); return Promise.resolve(true); },
  } };
  const permission = requestSiteAccess('https://example.com:8443/private?token=secret#test', { api });
  assert.deepEqual(requests, [{ origins: ['https://example.com:8443/*'] }], 'No await may lose the click user gesture before calling Chrome.');
  assert.equal(await permission, true);
  assert.equal(await canReadSite('example.com', { api }), true);
  assert.deepEqual(contains, [{ origins: ['https://example.com/*'] }]);
  assert.equal(siteOrigin('https://例子.测试/path?private=yes'), 'https://xn--fsqu00a.xn--0zwm56d');
  assert.throws(() => requestSiteAccess('https://username:password@example.com', { api }));
  assert.equal(requests.length, 1);
});

test('preview and denied permission cause no network request or implicit authorization', async () => {
  let calls = 0, requests = 0;
  const api = grantedApi();
  api.permissions.contains = async () => false;
  api.permissions.request = async () => { requests++; return true; };
  const fetcher = async () => { calls++; return html('<title>Private</title>'); };
  assert.equal(supportsSiteInfo({}), false);
  assert.equal(await canReadSite('https://example.com', { api: {} }), false);
  await assert.rejects(requestSiteAccess('https://example.com', { api: {} }), { code: 'SITE_INFO_UNAVAILABLE' });
  await assert.rejects(readSiteInfo('https://example.com', { api: {}, fetcher }), { code: 'SITE_INFO_UNAVAILABLE' });
  await assert.rejects(readSiteInfo('https://example.com', { api, fetcher }), { code: 'SITE_ACCESS_REQUIRED' });
  assert.equal(calls, 0);
  assert.equal(requests, 0);
});

test('site recognition only reads root and same-origin icon without cookies, referrer or scripts', async () => {
  const calls = [];
  const result = await readSiteInfo('https://example.com/profile?token=secret#details', {
    api: grantedApi(), convert,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return url === 'https://example.com/'
        ? html('<title>Example</title><link rel="icon" type="image/png" href="/brand.png"><script src="https://external.example/script.js"></script><img src="https://external.example/pixel">')
        : png();
    },
  });
  assert.deepEqual(calls.map((call) => call.url), ['https://example.com/', 'https://example.com/brand.png']);
  for (const { options } of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert(options.signal instanceof AbortSignal);
    assert(!options.body);
  }
  assert.equal(result.title, 'Example');
  assert.equal(result.origin, 'https://example.com');
  assert(result.icon instanceof Blob);
});

test('metadata uses site name then app name then title and safely normalizes text', () => {
  assert.equal(parseSiteMetadata('<title>Page title</title><meta property="og:site_name" content="A &amp; B &#x1f680;">', 'https://example.com').title, 'A & B 🚀');
  assert.equal(parseSiteMetadata('<meta name="application-name" content="My App"><title>Long page title</title>', 'https://example.com').title, 'My App');
  assert.equal(parseSiteMetadata('<title>  Example\n &#160; Docs </title>', 'https://example.com').title, 'Example Docs');
  assert.equal(parseSiteMetadata('<title></title>', 'https://example.com').title, 'example.com');
  assert.equal(parseSiteMetadata(`<title>${'A'.repeat(250)}</title>`, 'https://example.com').title.length, 200);
  assert.equal(parseSiteMetadata('<script>"<title>Injected</title>"</script><!--<title>Comment</title>--><title>Real</title><body><meta property="og:site_name" content="Body">', 'https://example.com').title, 'Real');
});

test('metadata rejects external, executable, SVG, credentialed and duplicate icons', () => {
  const parsed = parseSiteMetadata(`<base href="https://external.example/">
    <link rel="icon" href="https://external.example/icon.png">
    <link rel="icon" href="data:image/png;base64,test">
    <link rel="icon" href="javascript:alert(1)">
    <link rel="icon" href="/bad.svg">
    <link rel="icon" href="https://user@example.com/bad.png">
    <link rel="icon" type="image/svg+xml" href="/masked">
    <link rel="icon" href="/icon.png"><link rel="icon" href="/icon.png#duplicate">
    <link rel="apple-touch-icon" href="/apple.png">
    <script>"<link rel='icon' href='/script.png'>"</script>
    <template><link rel="icon" href="/template.png"></template>`, 'https://example.com');
  assert.deepEqual(parsed.icons, ['https://example.com/apple.png', 'https://example.com/icon.png', 'https://example.com/favicon.ico']);
});

test('a missing or unsupported icon preserves the recognized name and uses no external fallback service', async () => {
  const calls = [];
  const result = await readSiteInfo('https://example.com/', {
    api: grantedApi(), convert,
    fetcher: async (url) => {
      calls.push(url);
      return url.endsWith('/') ? html('<title>Example</title><link rel="icon" href="/icon"><link rel="icon" href="https://cdn.example/icon.png">') : new Response('<svg></svg>', { headers: { 'content-type': 'image/svg+xml' } });
    },
  });
  assert.equal(result.title, 'Example');
  assert.equal(result.icon, null);
  assert.deepEqual(calls, ['https://example.com/', 'https://example.com/icon', 'https://example.com/favicon.ico']);
});

test('large homepages retain metadata from their bounded prefix instead of rejecting full document size', async () => {
  const calls = [];
  const homepage = `<title>Large site</title><link rel="icon" href="/brand.png"><body>${'x'.repeat(700 * 1024)}`;
  const result = await readSiteInfo('https://example.com', {
    api: grantedApi(), convert,
    fetcher: async (url, init) => {
      calls.push({ url, signal: init.signal });
      return url.endsWith('/') ? new Response(homepage, { headers: { 'content-type': 'text/html', 'content-length': String(homepage.length) } }) : png();
    },
  });
  assert.equal(result.title, 'Large site');
  assert.equal(result.iconUrl, 'https://example.com/brand.png');
  assert(result.icon instanceof Blob);
  assert.equal(result.message, '已识别网站名称和图标。');
  assert.equal(calls.length, 2);
  assert(calls.every(({ signal }) => signal.aborted), 'completed or early-cancelled fetches are always aborted in cleanup');
});

test('metadata reads cancel at 512 KiB and never recognize tags beyond that prefix', async () => {
  const calls = [];
  let cancelled = 0, pulls = 0;
  const prefix = new TextEncoder().encode(`<title>Prefix title</title>${' '.repeat(512 * 1024)}`);
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      if (pulls === 1) controller.enqueue(prefix);
      else controller.enqueue(new TextEncoder().encode('<link rel="icon" href="/outside-prefix.png">'));
    },
    cancel() { cancelled++; },
  });
  const result = await readSiteInfo('https://example.com', {
    api: grantedApi(), convert,
    fetcher: async (url) => {
      calls.push(url);
      return url.endsWith('/') ? new Response(body, { headers: { 'content-type': 'text/html', 'content-length': String(20 * 1024 * 1024) } }) : png();
    },
  });
  assert.equal(cancelled, 1);
  assert(pulls <= 2, 'the remainder is never drained after reaching the cap');
  assert.equal(result.title, 'Prefix title');
  assert.deepEqual(calls, ['https://example.com/', 'https://example.com/favicon.ico']);
});

test('truncated ignored blocks cannot supply fake metadata or links', () => {
  for (const tag of ['script', 'style', 'template', 'noscript']) {
    const parsed = parseSiteMetadata(`<title>Real title</title><${tag}><title>Fake title</title><meta property="og:site_name" content="Fake name"><link rel="icon" href="/fake.png">`, 'https://example.com');
    assert.equal(parsed.title, 'Real title', tag);
    assert.deepEqual(parsed.icons, ['https://example.com/favicon.ico'], tag);
  }
  const parsed = parseSiteMetadata('<!-- <title>Fake title</title><link rel="icon" href="/fake.png">', 'https://example.com');
  assert.equal(parsed.title, 'example.com');
  assert.deepEqual(parsed.icons, ['https://example.com/favicon.ico']);
});

test('failed, redirected or unsupported homepages still try only the same-origin favicon', async () => {
  const redirected = () => {
    const response = html('<title>Wrong origin</title><link rel="icon" href="https://evil.example/icon.png">');
    Object.defineProperty(response, 'url', { value: 'https://evil.example/' });
    return response;
  };
  for (const homepage of [
    () => new Response('<title>Unsupported</title>', { headers: { 'content-type': 'application/javascript' } }),
    () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } }),
    () => new Response(null, { status: 500 }),
    () => { throw new Error('Network failed'); },
    redirected,
  ]) {
    const calls = [];
    const result = await readSiteInfo('https://example.com/private?secret=yes', {
      api: grantedApi(), convert,
      fetcher: async (url, init) => { calls.push({ url, signal: init.signal }); return url.endsWith('/') ? homepage() : png(); },
    });
    assert.equal(result.title, 'example.com');
    assert.equal(result.iconUrl, 'https://example.com/favicon.ico');
    assert(result.icon instanceof Blob);
    assert.match(result.message, /名称暂用域名/);
    assert.deepEqual(calls.map(({ url }) => url), ['https://example.com/', 'https://example.com/favicon.ico']);
    assert(calls.every(({ signal }) => signal.aborted));
  }
});

test('homepage timeouts abort their request and still allow a same-origin favicon', async () => {
  const calls = [];
  const result = await readSiteInfo('https://example.com', {
    api: grantedApi(), timeoutMs: 5, convert,
    fetcher: (url, init) => {
      calls.push({ url, signal: init.signal });
      return url.endsWith('/') ? new Promise(() => {}) : Promise.resolve(png());
    },
  });
  assert.equal(result.iconUrl, 'https://example.com/favicon.ico');
  assert.deepEqual(calls.map(({ url }) => url), ['https://example.com/', 'https://example.com/favicon.ico']);
  assert(calls.every(({ signal }) => signal.aborted));
});

test('image responses remain strictly bounded and are not accepted as prefixes', async () => {
  for (const image of [
    () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(1024 * 1024 + 1) } }),
    () => new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
  ]) {
    let conversions = 0;
    const result = await readSiteInfo('https://example.com', {
      api: grantedApi(),
      fetcher: async (url) => url.endsWith('/') ? html('<title>Example</title><link rel="icon" href="/brand.png">') : image(),
      convert: async () => { conversions++; return convert(); },
    });
    assert.equal(result.title, 'Example');
    assert.equal(result.icon, null);
    assert.equal(conversions, 0, 'oversized images must never reach decoding');
    assert.match(result.message, /未获取到可用图标/);
  }
});

test('icon validation rejects MIME spoofing, malformed ICO, oversized bytes and decode bombs', () => {
  validateIconBytes(PNG, 'image/png');
  assert.throws(() => validateIconBytes(PNG, 'image/jpeg'));
  assert.throws(() => validateIconBytes(new TextEncoder().encode('<svg/>'), 'image/png'));
  assert.throws(() => validateIconBytes(new Uint8Array(1024 * 1024 + 1), 'image/png'));
  assert.throws(() => validateIconBytes(PNG, 'image/x-icon'));
  const bomb = PNG.slice();
  new DataView(bomb.buffer).setUint32(16, 100000);
  assert.throws(() => validateIconBytes(bomb, 'image/png'), /尺寸/);
});

test('ICO bytes are bounded and converted to a stored raster blob rather than a remote image URL', async () => {
  const ico = new Uint8Array(22 + PNG.length), view = new DataView(ico.buffer);
  view.setUint16(2, 1, true); view.setUint16(4, 1, true); ico[6] = 1; ico[7] = 1;
  view.setUint32(14, PNG.length, true); view.setUint32(18, 22, true); ico.set(PNG, 22);
  validateIconBytes(ico, 'image/x-icon');
  let convertedMime;
  const result = await readSiteInfo('https://example.com', {
    api: grantedApi(),
    fetcher: async (url) => url.endsWith('/') ? html('<title>ICO</title>') : new Response(ico, { headers: { 'content-type': 'image/x-icon' } }),
    convert: async (blob) => { convertedMime = blob.type; return new Blob([PNG], { type: 'image/png' }); },
  });
  assert.equal(convertedMime, 'image/x-icon');
  assert.equal(result.icon.type, 'image/png');
  assert.equal(result.iconUrl, 'https://example.com/favicon.ico');
  const broken = ico.slice();
  new DataView(broken.buffer).setUint32(18, broken.length, true);
  assert.throws(() => validateIconBytes(broken, 'image/x-icon'));
});

test('only a bounded number of same-origin candidates is tried and a failed conversion falls through', async () => {
  const calls = [];
  let conversions = 0;
  const result = await readSiteInfo('https://example.com', {
    api: grantedApi(),
    fetcher: async (url) => {
      calls.push(url);
      return url.endsWith('/') ? html(`<title>Example</title>${Array.from({ length: 20 }, (_, n) => `<link rel="icon" href="/${n}.png">`).join('')}`) : png();
    },
    convert: async () => { conversions++; if (conversions < 3) throw new Error('Unsupported image'); return new Blob([PNG], { type: 'image/png' }); },
  });
  assert(result.icon);
  assert.equal(calls.length, 4);
  assert.equal(result.iconUrl, 'https://example.com/2.png');
});
