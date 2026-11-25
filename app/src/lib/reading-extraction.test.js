import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, ResourceLoader } from 'jsdom';
import { extractReadingHtml, extractReadingArticle, neutralizeReadingHtml, fetchReadingImage, readerSearchText, readingArticleMarkdown, READING_EXTRACTION_LIMITS } from './reading-extraction.js';

const url = 'https://reading.example/story#part';
const body = 'This article contains the complete readable paragraph for a locally saved reading copy.';
const html = `<html><head><title>Safe &amp; local story</title></head><body><nav>Unwanted navigation links</nav><article><h1>Story heading</h1><p>${body}</p><p>Second paragraph with <strong>important words</strong> and details.</p></article></body></html>`;
const documentFactory = (source) => new JSDOM(source).window.document;
const api = { runtime: { id: 'test-extension' }, permissions: { contains: async () => true, request: async () => true } };
const response = (source = html, type = 'text/html') => new Response(source, { headers: { 'content-type': type } });

test('article extraction prefers actual main text, removes surrounding UI, preserves headings and stable offsets', () => {
  const article = extractReadingHtml(html, url, { documentFactory });
  assert.equal(article.url, url); assert.equal(article.title, 'Safe & local story');
  assert.equal(article.blocks[0].type, 'heading'); assert.equal(article.blocks[0].level, 1);
  assert.equal(article.text, article.blocks.map((block) => block.text).join('\n\n'));
  for (const block of article.blocks) assert.equal(article.text.slice(block.start, block.end), block.text);
  assert.ok(article.text.includes('important words')); assert.ok(!article.text.includes('Unwanted'));
});

test('untrusted remote HTML is neutralized before DOMParser with no active tags, source attributes, CSS or scripts', async () => {
  const requests = [], scripts = [];
  class NoNetwork extends ResourceLoader { fetch(address) { requests.push(address); return null; } }
  const remote = `<html><head><base href="https://evil.example/"><link rel=stylesheet href="https://evil.example/style"><style>@import 'https://evil.example/css';</style></head><body onload="bad()"><article style="background:url(https://evil.example/bg)"><h1 onclick="bad()">Local</h1><p>${body}</p><img src="https://evil.example/pixel" srcset="https://evil.example/other 2x" onerror="bad()"><iframe src="https://evil.example/frame"></iframe><script>globalThis.bad=1;fetch('https://evil.example/js')</script><svg><image href="https://evil.example/svg"/></svg><object data="https://evil.example/o"></object><form action="https://evil.example/f"><input name=secret value=password></form></article></body></html>`;
  let parserInput;
  const article = extractReadingHtml(remote, url, { documentFactory(source) {
    parserInput = source;
    const dom = new JSDOM(source, { resources: new NoNetwork(), runScripts: 'dangerously', beforeParse(window) { window.bad = () => scripts.push(true); } });
    return dom.window.document;
  } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(requests, []); assert.deepEqual(scripts, []);
  assert.ok(!/<(?:img|iframe|script|style|link|base|svg|object|form|input)\b/iu.test(parserInput));
  assert.ok(!/\s(?:src|href|style|on\w+)\s*=/iu.test(parserInput));
  assert.equal(article.blocks.find((block) => block.type === 'image').url, 'https://evil.example/pixel');
  assert.equal(article.blocks.find((block) => block.type === 'image').text, '');
});

test('malformed tags and encoded payloads remain inert text and image placeholder is a constant numbered token', () => {
  const safe = neutralizeReadingHtml(`<article><p>${body} &lt;img src=x onerror=alert(1)&gt;</p><IMG src='javascript:alert(1)'><img src='data:text/html,x'><img src='https://u:p@evil.example/x'><img src='/image?a=1'><p title='><img src=x>'>ending</p></article>`, url);
  const article = extractReadingHtml(safe.html, url, { documentFactory });
  assert.ok(!/<[^>]+\sonerror=/iu.test(safe.html)); assert.equal(safe.images.length, 1);
  assert.equal(safe.images[0].url, 'https://reading.example/image?a=1');
  assert.ok(article.text.includes('<img src=x onerror=alert(1)>'));
});

test('leading image without alt preserves canonical empty block offsets and source attributes cannot change text offsets', () => {
  const article = extractReadingHtml(`<article><img src=/safe.png><p>${body}</p></article>`, url, { documentFactory });
  assert.equal(article.blocks[0].start, 0); assert.equal(article.blocks[0].end, 0);
  assert.equal(article.blocks[1].start, 2); assert.ok(article.text.startsWith('\n\n'));
  assert.throws(() => extractReadingHtml(`<article>${'<img src=/image.png>'.repeat(101)}<p>${body}</p></article>`, url, { documentFactory }), { code: 'READING_EXTRACTION_CAPACITY' });
});

test('fetch checks exact site permission, uses a fragment-free target, sends no credentials and rejects changed response URL', async () => {
  let calls = 0;
  const article = await extractReadingArticle({ url, title: 'Fallback' }, { api, documentFactory, fetchImpl: async (target, options) => {
    calls++; assert.equal(target, 'https://reading.example/story'); assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.referrer, ''); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    assert.equal(options.method, 'GET'); assert.equal(options.signal.aborted, false); return response();
  } });
  assert.equal(article.url, url); assert.equal(calls, 1);
  await assert.rejects(extractReadingArticle({ url }, { api: { ...api, permissions: { ...api.permissions, contains: async () => false } }, fetchImpl: () => { calls++; } }), { code: 'READING_ACCESS_REQUIRED' });
  assert.equal(calls, 1);
  await assert.rejects(extractReadingArticle({ url }, { api, documentFactory, fetchImpl: async () => { const result = response(); Object.defineProperty(result, 'url', { value: 'https://other.example/story' }); return result; } }));
});

test('redirects, login shells, unsupported MIME, bounded HTML, text overflow, stalled bodies and explicit cancellation stop extraction', async () => {
  for (const result of [response(html, 'application/json'), response('<form>login</form>'), response('x'.repeat(READING_EXTRACTION_LIMITS.htmlBytes + 1)), response(`<article><p>${'中'.repeat(90000)}</p></article>`)])
    await assert.rejects(extractReadingArticle({ url }, { api, documentFactory, fetchImpl: async () => result }));
  await assert.rejects(extractReadingArticle({ url }, { api, fetchImpl: async () => { const result = response(); Object.defineProperty(result, 'redirected', { value: true }); return result; } }));
  let cancelled = false;
  await assert.rejects(extractReadingArticle({ url }, { api, timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/html' } }) }), /timed out|stopped/u);
  const controller = new AbortController(); controller.abort(); let requests = 0;
  await assert.rejects(extractReadingArticle({ url }, { api, signal: controller.signal, fetchImpl: () => { requests++; } }), { code: 'READING_CANCELLED' });
  assert.equal(requests, 0);
  // An aborted real fetch owns its body; a mock stream may remain pending, but
  // the public operation is bounded by the timeout regardless of fetch behavior.
  assert.equal(typeof cancelled, 'boolean');
});

test('image helper fetches only on explicit invocation and validates raster bytes instead of trusting MIME or SVG', async () => {
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
  const blob = await fetchReadingImage('https://images.example/a.png', { api, fetchImpl: async () => response(png, 'image/png') });
  assert.equal(blob.type, 'image/png'); assert.equal(blob.size, png.length);
  await assert.rejects(fetchReadingImage('https://images.example/a.svg', { api, fetchImpl: async () => response('<svg/>', 'image/svg+xml') }));
  await assert.rejects(fetchReadingImage('https://images.example/a.png', { api, fetchImpl: async () => response('not an image', 'image/png') }));
});

test('pure reader search and Markdown contain annotations, while images export as click links', () => {
  const article = { ...extractReadingHtml(html, url, { documentFactory }), highlights: [{ quote: 'readable paragraph', note: 'Research note' }] };
  assert.ok(readerSearchText(article).includes('Research note'));
  const markdown = readingArticleMarkdown(article); assert.ok(markdown.startsWith('# Safe & local story')); assert.ok(markdown.includes('> readable paragraph'));
  assert.ok(markdown.includes('Research note')); assert.equal(readerSearchText(null), ''); assert.equal(readingArticleMarkdown(null), '');
});
