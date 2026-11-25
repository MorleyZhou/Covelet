import { canReadSite, validateIconBytes } from './site-info.js';
import { getExtensionApi } from './extension-api.js';

export const READING_EXTRACTION_LIMITS = Object.freeze({ htmlBytes: 2 * 1024 * 1024, textBytes: 256 * 1024, blocks: 4000, images: 100, timeoutMs: 10000, imageBytes: 2 * 1024 * 1024 });
const encoder = new TextEncoder();
const fail = (code = 'READING_EXTRACTION_FAILED') => { throw Object.assign(Error('The saved page could not be read locally.'), { code }); };
const clean = (value) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim();
const label = (value) => clean(value).slice(0, 200);
export function safeReadingUrl(input, base) {
  if (typeof input !== 'string' || input.length > 4096 || /[\\\u0000-\u0020\u007f]/u.test(input)) return null;
  try {
    const url = new URL(input, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
const escapedText = (value) => value.replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
const layoutTags = new Set(['article', 'main', 'section', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'br', 'strong', 'em', 'b', 'i', 'span', 'title']);
const suppressedTags = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'textarea']);
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function attributes(source) {
  const values = new Map();
  for (const match of source.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu)) {
    const key = match[1].toLowerCase(); if (!values.has(key)) values.set(key, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return values;
}

// Raw remote markup never enters DOMParser: even detached HTML documents may
// fetch images/frames. This tokenizer emits only constant non-fetching tags,
// no source attributes, escaped text, and inert numbered image placeholders.
export function neutralizeReadingHtml(html, url) {
  if (typeof html !== 'string' || encoder.encode(html).length > READING_EXTRACTION_LIMITS.htmlBytes) fail('READING_EXTRACTION_CAPACITY');
  const images = [], output = [], suppressed = [];
  let offset = 0, tokens = 0;
  while (offset < html.length) {
    if (++tokens > 100000) fail('READING_EXTRACTION_CAPACITY');
    const open = html.indexOf('<', offset);
    if (open < 0) { if (!suppressed.length) output.push(escapedText(html.slice(offset))); break; }
    if (!suppressed.length) output.push(escapedText(html.slice(offset, open)));
    if (html.startsWith('<!--', open)) { const end = html.indexOf('-->', open + 4); offset = end < 0 ? html.length : end + 3; continue; }
    let end = open + 1, quote = '';
    for (; end < html.length; end++) {
      const char = html[end]; if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end >= html.length) { if (!suppressed.length) output.push(escapedText(html.slice(open))); break; }
    const token = html.slice(open, end + 1), match = /^<\s*(\/?)\s*([a-z][a-z\d-]*)(?:\s|\/?>)/iu.exec(token);
    offset = end + 1;
    if (!match) { if (!suppressed.length && !/^<!/u.test(token)) output.push(escapedText(token)); continue; }
    const closing = Boolean(match[1]), tag = match[2].toLowerCase();
    if (suppressed.length) {
      if (closing && tag === suppressed.at(-1)) suppressed.pop();
      else if (!closing && suppressedTags.has(tag) && !voidTags.has(tag) && !/\/\s*>$/u.test(token)) suppressed.push(tag);
      continue;
    }
    if (suppressedTags.has(tag)) { if (!closing && !voidTags.has(tag) && !/\/\s*>$/u.test(token)) suppressed.push(tag); continue; }
    if (tag === 'img' && !closing) {
      const attrs = attributes(token), source = safeReadingUrl(attrs.get('src'), url);
      if (source) {
        if (images.length >= READING_EXTRACTION_LIMITS.images) fail('READING_EXTRACTION_CAPACITY');
        images.push({ url: source, text: label(attrs.get('alt') || '') }); output.push(`<reader-image data-index="${images.length - 1}"></reader-image>`);
      }
    } else if (layoutTags.has(tag)) output.push(`<${closing ? '/' : ''}${tag}>`);
  }
  return { html: output.join(''), images };
}

function createDocument(html, documentFactory) {
  if (documentFactory) return documentFactory(html);
  if (!globalThis.DOMParser) fail();
  return new DOMParser().parseFromString(html, 'text/html');
}
export function extractReadingHtml(html, url, { title = '', documentFactory } = {}) {
  const address = safeReadingUrl(url); if (!address) fail();
  const safe = neutralizeReadingHtml(html, address), doc = createDocument(safe.html, documentFactory);
  if (!doc?.querySelector || !doc.body) fail();
  const candidates = [...doc.querySelectorAll('article,main')];
  const root = candidates.sort((a, b) => (b.textContent?.length || 0) - (a.textContent?.length || 0))[0] || doc.body;
  const blocks = []; let text = '';
  function add(type, content, extra = {}) {
    const value = clean(content); if (!value && type !== 'image') return;
    const start = text.length + (blocks.length ? 2 : 0), end = start + value.length;
    text += `${blocks.length ? '\n\n' : ''}${value}`;
    if (blocks.length >= READING_EXTRACTION_LIMITS.blocks || encoder.encode(text).length > READING_EXTRACTION_LIMITS.textBytes) fail('READING_EXTRACTION_CAPACITY');
    blocks.push({ type, text: value, start, end, ...extra });
  }
  const semantic = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE']);
  function walk(node) {
    let pending = '';
    const flush = () => { add('paragraph', pending); pending = ''; };
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { pending += child.textContent; continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (tag === 'READER-IMAGE') { flush(); const image = safe.images[Number(child.getAttribute('data-index'))]; if (image) add('image', image.text, { url: image.url }); }
      else if (semantic.has(tag) && !child.querySelector('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,reader-image')) {
        flush(); add(/^H[1-6]$/u.test(tag) ? 'heading' : tag === 'LI' ? 'list-item' : tag === 'BLOCKQUOTE' ? 'quote' : 'paragraph', child.textContent, /^H[1-6]$/u.test(tag) ? { level: Number(tag[1]) } : {});
      } else if (['STRONG', 'EM', 'B', 'I', 'SPAN'].includes(tag)) pending += child.textContent;
      else if (tag === 'BR') pending += ' ';
      else { flush(); walk(child); }
    }
    flush();
  }
  walk(root);
  // A login shell, empty page or pixel alone is not a readable article.
  if (!blocks.some((block) => block.type !== 'image' && block.text.length >= 20) || text.length < 40) fail();
  return { url: address, title: label(doc.querySelector('title')?.textContent || root.querySelector('h1')?.textContent || title || new URL(address).hostname), text, blocks };
}

async function boundedBody(response, limit) {
  const declared = response.headers?.get('content-length');
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > limit)) fail('READING_EXTRACTION_CAPACITY');
  if (!response.body?.getReader) fail();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (!(value instanceof Uint8Array) || (size += value.byteLength) > limit) fail('READING_EXTRACTION_CAPACITY');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function fetchBounded(url, { fetchImpl = (...args) => globalThis.fetch(...args), api = getExtensionApi(), signal, timeoutMs = READING_EXTRACTION_LIMITS.timeoutMs, image = false } = {}) {
  const address = safeReadingUrl(url); if (!address || !await canReadSite(address, { api })) fail('READING_ACCESS_REQUIRED');
  const target = new URL(address); target.hash = ''; const networkUrl = target.href;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > READING_EXTRACTION_LIMITS.timeoutMs) fail();
  const controller = new AbortController(), abort = () => controller.abort(); let timer;
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
  try {
    return await Promise.race([
      (async () => {
        if (controller.signal.aborted) fail('READING_CANCELLED');
        const response = await fetchImpl(networkUrl, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', referrer: '', redirect: 'error', cache: 'no-store', signal: controller.signal });
        if (!response.ok || response.redirected || response.url && response.url !== networkUrl) fail();
        const mime = (response.headers?.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!(image ? ['image/png', 'image/jpeg', 'image/webp'].includes(mime) : ['text/html', 'application/xhtml+xml'].includes(mime))) fail();
        const bytes = await boundedBody(response, image ? READING_EXTRACTION_LIMITS.imageBytes : READING_EXTRACTION_LIMITS.htmlBytes);
        if (controller.signal.aborted) fail('READING_CANCELLED');
        return { bytes, mime };
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(Error('The saved page request timed out.'), { code: 'READING_EXTRACTION_TIMEOUT' })); }, timeoutMs); }),
      new Promise((_, reject) => { controller.signal.addEventListener('abort', () => reject(Object.assign(Error('The saved page request stopped.'), { code: 'READING_CANCELLED' })), { once: true }); }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', abort); }
}
export async function extractReadingArticle(record, options = {}) {
  const url = safeReadingUrl(record?.url); if (!url) fail();
  const html = options.html === undefined ? new TextDecoder('utf-8', { fatal: true }).decode((await fetchBounded(url, options)).bytes) : options.html;
  return extractReadingHtml(html, url, { ...options, title: record.title });
}
export async function fetchReadingImage(url, options = {}) {
  const { bytes, mime } = await fetchBounded(url, { ...options, image: true });
  validateIconBytes(bytes, mime);
  return new Blob([bytes], { type: mime });
}

export function readerSearchText(article) {
  return article ? [article.title, article.text, ...(article.highlights || []).map((item) => `${item.quote}\n${item.note}`)].join('\n') : '';
}
const markdownText = (value) => value.replace(/([\\`*_[\]<>#])/gu, '\\$1');
export function readingArticleMarkdown(article) {
  if (!article) return '';
  const content = article.blocks.map((block) => block.type === 'heading' ? `${'#'.repeat(block.level)} ${markdownText(block.text)}`
    : block.type === 'list-item' ? `- ${markdownText(block.text)}` : block.type === 'quote' ? `> ${markdownText(block.text)}`
      : block.type === 'image' ? `[${markdownText(block.text || 'Image')}](${block.url.replace(/[()]/gu, (char) => char === '(' ? '%28' : '%29')})` : markdownText(block.text));
  const annotations = (article.highlights || []).map((item) => `> ${markdownText(item.quote).replace(/\n/gu, '\n> ')}${item.note ? `\n\n${markdownText(item.note)}` : ''}`);
  return [`# ${markdownText(article.title)}`, article.url, ...content, ...annotations].join('\n\n');
}
