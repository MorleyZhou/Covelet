import { siteOrigin, validateIconBytes, convertIcon } from './site-info.js';

const LIMIT = 1024 * 1024;
const SIZE = '256';
const DEFAULT_PAGE = 'https://covelet-favicon-unavailable.invalid/';
const INPUT_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon']);
const OUTPUT_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const baselines = new Map();
const baselineWork = new Map();
const MAX_BASELINES = 4;

function endpointFor(api) {
  try {
    const runtime = api?.runtime, id = runtime?.id;
    if (typeof id !== 'string' || !id || typeof runtime.getURL !== 'function' || typeof runtime.getManifest !== 'function'
      || !Array.isArray(runtime.getManifest()?.permissions) || !runtime.getManifest().permissions.includes('favicon')) return null;
    const url = new URL(runtime.getURL('/_favicon/'));
    if (url.protocol !== 'chrome-extension:' || url.hostname !== id || url.host !== id || url.username || url.password
      || url.pathname !== '/_favicon/' || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

export function supportsBrowserFavicons(api = globalThis.chrome) {
  return Boolean(endpointFor(api));
}

function defaultFetch(url, options) { return globalThis.fetch(url, options); }

function iconUrl(endpoint, page) {
  const url = new URL(endpoint.href);
  url.searchParams.set('pageUrl', page);
  url.searchParams.set('size', SIZE);
  return url.href;
}

function ensureActive(signal) {
  if (signal.aborted) throw new Error('Favicon operation ended.');
}

async function boundedBody(response, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIMIT)) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Favicon response exceeds its limit.');
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    ensureActive(signal);
    if (bytes.length > LIMIT) throw new Error('Favicon response exceeds its limit.');
    return bytes;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      ensureActive(signal);
      const { done, value } = await reader.read();
      ensureActive(signal);
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) { await reader.cancel().catch(() => {}); throw new Error('Favicon response exceeds its limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function fetchIcon(fetcher, url, signal) {
  ensureActive(signal);
  const response = await fetcher(url, {
    method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', referrer: '',
    redirect: 'error', cache: 'no-store', signal,
  });
  ensureActive(signal);
  if (!response.ok || response.redirected || response.type === 'opaqueredirect' || response.url && response.url !== url) throw new Error('Invalid native favicon response.');
  const mime = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!INPUT_MIMES.has(mime)) throw new Error('Unsupported favicon format.');
  const bytes = await boundedBody(response, signal);
  validateIconBytes(bytes, mime);
  return { bytes, mime };
}

async function convertedIcon(input, convert, signal) {
  ensureActive(signal);
  const blob = await convert(new Blob([input.bytes], { type: input.mime }));
  ensureActive(signal);
  if (!(blob instanceof Blob) || !OUTPUT_MIMES.has(blob.type) || !blob.size || blob.size > LIMIT) throw new Error('Invalid converted favicon.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  ensureActive(signal);
  validateIconBytes(bytes, blob.type);
  return { blob, bytes };
}

const equal = (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index]);

function baseline(endpoint, fetcher, convert, signal) {
  // URL.origin is "null" for chrome-extension: in some JS runtimes, so build
  // the cache key from the already-validated scheme and own runtime host.
  const key = `${endpoint.protocol}//${endpoint.host}`;
  const cached = baselines.get(key);
  if (cached) { baselines.delete(key); baselines.set(key, cached); return Promise.resolve(cached); }
  const pending = baselineWork.get(key);
  if (pending && !pending.signal.aborted) return pending.promise;
  const work = { signal, promise: null };
  work.promise = (async () => {
    // This URL goes only to Chrome/Edge's local favicon endpoint. The .invalid
    // page identifies an uncached default sample; it is never fetched directly.
    const raw = await fetchIcon(fetcher, iconUrl(endpoint, DEFAULT_PAGE), signal);
    const converted = await convertedIcon(raw, convert, signal);
    ensureActive(signal);
    const value = { raw: raw.bytes, converted: converted.bytes };
    baselines.set(key, value);
    while (baselines.size > MAX_BASELINES) baselines.delete(baselines.keys().next().value);
    return value;
  })().finally(() => { if (baselineWork.get(key) === work) baselineWork.delete(key); });
  baselineWork.set(key, work);
  return work.promise;
}

export async function readBrowserFavicon(input, {
  api = globalThis.chrome, fetcher = defaultFetch, convert = convertIcon, timeoutMs = 5000,
} = {}) {
  let timer;
  const controller = new AbortController();
  try {
    const endpoint = endpointFor(api);
    if (!endpoint || typeof fetcher !== 'function' || typeof convert !== 'function' || fetcher === defaultFetch && typeof globalThis.fetch !== 'function') return null;
    const page = `${siteOrigin(input)}/`;
    const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(15000, timeoutMs)) : 5000;
    return await Promise.race([
      (async () => {
        const defaults = await baseline(endpoint, fetcher, convert, controller.signal);
        ensureActive(controller.signal);
        const raw = await fetchIcon(fetcher, iconUrl(endpoint, page), controller.signal);
        if (equal(raw.bytes, defaults.raw)) return null;
        const converted = await convertedIcon(raw, convert, controller.signal);
        if (equal(converted.bytes, defaults.converted)) return null;
        return converted.blob;
      })(),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, duration); }),
    ]);
  } catch { return null; }
  finally { clearTimeout(timer); controller.abort(); }
}
