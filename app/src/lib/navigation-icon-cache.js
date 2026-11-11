import { normalizeIconAddress, siteIconAddress } from './site-icons.js';
import { bundledNavigationIconAddress } from './bundled-navigation-icons.js';
import { validateIconBytes } from './site-info.js';
import { ICON_IMAGE_LIMIT, ICON_SVG_LIMIT, normalizeIconBlob } from './icon-image-format.js';
import { validateNavigationIconRecord } from './icon-image-record.js';
import { createEncryptedStore, localData } from './local-data.js';
import { migrateLegacyIndexedDb } from './legacy-indexed-data.js';
import { subscribeSyncedData } from './use-synced-data.js';
import { navigationResourceEntries } from './navigation-resources.js';

// Original image bytes use their own encrypted namespace, including full sync.
const persistentImages = createEncryptedStore('navigation-icons');
export const migrateNavigationIconCache = () => migrateLegacyIndexedDb('covelet.navigation-icons.v1', 'images', persistentImages, (item) => item.url);
const MAX_BYTES = ICON_IMAGE_LIMIT, SVG_BYTES = ICON_SVG_LIMIT, MAX_ITEMS = 64, MAX_CACHE_BYTES = 16 * MAX_BYTES;
const MAX_STORED_ITEMS = 4096, MAX_STORED_BYTES = 256 * MAX_BYTES;
const session = new Map(), pending = new Map(), cacheReads = new Map(), failures = new Map();
const failureDetails = new Map();
const imageError = (code, extra = {}) => Object.assign(Error(code), { code, ...extra });
export function getNavigationIconFailure(input) {
  try { return failureDetails.get(normalizeIconAddress(input)) || null; } catch { return { code: 'FORMAT' }; }
}
function recordFailure(url, value) {
  failureDetails.delete(url); failureDetails.set(url, value);
  while (failureDetails.size > 128) failureDetails.delete(failureDetails.keys().next().value);
}
const sourceVersions = new Map(), listeners = new Set();
const retainedSources = new Map();
export function retainNavigationIconResources(state) {
  const sources = new Set(navigationResourceEntries(state).filter((entry) => entry.type === 'site' && entry.icon?.kind !== 'image').flatMap((entry) => [
    siteIconAddress(entry), entry.iconVariants?.light?.url, entry.iconVariants?.dark?.url,
  ]).filter(Boolean));
  for (const source of sources) retainedSources.set(source, (retainedSources.get(source) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const source of sources) {
      const count = retainedSources.get(source) - 1;
      if (count) retainedSources.set(source, count); else retainedSources.delete(source);
    }
  };
}
let changes;
const publish = (item) => { for (const listener of listeners) { try { listener(item); } catch { /* Other mounted icons must still update. */ } } };
function watchChanges() {
  if (changes || globalThis.location?.protocol !== 'chrome-extension:' || !globalThis.BroadcastChannel) return;
  changes = new BroadcastChannel('covelet.navigation-icons.changed.v1');
  changes.onmessage = async ({ data }) => {
    if (data?.version !== 1 || typeof data.url !== 'string') return;
    let source;
    try { source = normalizeIconAddress(data.url); } catch { return; }
    sourceVersions.set(source, (sourceVersions.get(source) || 0) + 1);
    session.delete(source); cacheReads.delete(source);
    const item = await readCachedNavigationIcon(source);
    if (item) publish(item);
  };
}
export const subscribeNavigationIcons = (listener) => { watchChanges(); listeners.add(listener); return () => listeners.delete(listener); };
let cacheRevision = 0;
let running = 0;
const queue = [];
export function invalidateNavigationIconCache() {
  cacheRevision++;
  session.clear(); pending.clear(); cacheReads.clear(); failures.clear(); failureDetails.clear(); sourceVersions.clear();
  for (const job of queue.splice(0)) job.resolve(null);
}
subscribeSyncedData(invalidateNavigationIconCache);
const imageBytes = (item) => item.blob.size + (item.darkBlob?.size || 0);
const active = (signal) => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
const remember = (url, item) => {
  session.delete(url); session.set(url, item);
  let bytes = [...session.values()].reduce((sum, entry) => sum + imageBytes(entry), 0);
  for (const [key, entry] of session) {
    if (session.size <= MAX_ITEMS && bytes <= MAX_CACHE_BYTES) break;
    session.delete(key); bytes -= imageBytes(entry);
  }
  return item;
};
async function cached(url, revision, version, seedBundled = true) {
  const known = session.get(url);
  if (known) return remember(url, known);
  try {
    await migrateNavigationIconCache();
    const item = await persistentImages.get(url);
    if (!item) {
      const bundled = seedBundled && bundledNavigationIconAddress(url);
      if (!bundled || revision !== cacheRevision || version !== (sourceVersions.get(url) || 0)) return null;
      const response = await globalThis.fetch(bundled, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
      if (!response.ok) return null;
      const blob = await boundedImage(response), image = await createImageBitmap(blob);
      try { return await save({ url, blob, width: image.width, height: image.height, vector: false, adaptive: false, updatedAt: Date.now() }, revision, version); }
      finally { image.close(); }
    }
    await validateNavigationIconRecord(item, url);
    return revision === cacheRevision && version === (sourceVersions.get(url) || 0) ? remember(url, item) : null;
  } catch { return null; }
}
export function peekNavigationIcon(input) {
  let url;
  try { url = normalizeIconAddress(input); } catch { return null; }
  return session.get(url) || null;
}
export function readCachedNavigationIcon(input) {
  let url;
  try { url = normalizeIconAddress(input); } catch { return Promise.resolve(null); }
  if (cacheReads.has(url)) return cacheReads.get(url);
  const work = cached(url, cacheRevision, sourceVersions.get(url) || 0).finally(() => { if (cacheReads.get(url) === work) cacheReads.delete(url); });
  cacheReads.set(url, work); return work;
}
async function save(item, revision = cacheRevision, version = sourceVersions.get(item.url) || 0, canSave = () => true) {
  const current = () => revision === cacheRevision && version === (sourceVersions.get(item.url) || 0) && canSave();
  if (!current()) return null;
  try {
    await migrateNavigationIconCache();
    if (!current()) return null;
    if (await persistentImages.set(item.url, item, { shouldWrite: current }) === false) return null;
    if (!current()) return null;
  } catch { recordFailure(item.url, { code: 'STORAGE' }); return null; } // A displayed-only image is not a durable cache success.
  remember(item.url, item);
  try {
    const envelope = (await localData.get('owntab.local.v1'))['owntab.local.v1'];
    const referenced = new Set([envelope?.state, ...(envelope?.snapshots || [])].flatMap((navigation) => navigationResourceEntries(navigation).flatMap((entry) => [
      siteIconAddress(entry), entry.iconUrl, entry.icon?.kind === 'url' ? entry.icon.value : '', entry.iconVariants?.light?.url, entry.iconVariants?.dark?.url,
    ])).filter(Boolean));
    const items = (await persistentImages.entries()).map(([, value]) => value).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!current()) return null;
    let count = 0, bytes = 0;
    for (const entry of items) {
      bytes += imageBytes(entry);
      // The small in-memory LRU must never evict a saved desktop's disk icon.
      // Only unused disk entries are eligible for automatic cleanup.
      if (!current()) return null;
      if ((++count > MAX_STORED_ITEMS || bytes > MAX_STORED_BYTES) && !referenced.has(entry.url) && !retainedSources.has(entry.url)) await persistentImages.remove(entry.url);
    }
  } catch { /* Cleanup failure does not undo an already-persisted image. */ }
  if (!current()) return null;
  failureDetails.delete(item.url);
  publish(item);
  watchChanges();
  try { changes?.postMessage({ version: 1, url: item.url }); } catch { /* Next local read still sees the saved image. */ }
  return item;
}

// Portable backup resources keep both adaptive bitmaps and the original URL.
// Importers must validate bytes before allowing them into the display cache.
export const readNavigationIconResource = readCachedNavigationIcon;
export async function restoreNavigationIconResource(item, { replace = false } = {}) {
  const revision = cacheRevision;
  let url;
  try { url = normalizeIconAddress(item?.url); } catch { return null; }
  const version = sourceVersions.get(url) || 0;
  try {
    await validateNavigationIconRecord(item, url);
    const existing = await cached(url, revision, version, false);
    if (existing && !replace) return existing;
    if (revision !== cacheRevision || version !== (sourceVersions.get(url) || 0)) return null;
    sourceVersions.set(url, version + 1); cacheReads.delete(url);
    return await save({ url, blob: item.blob, ...(item.adaptive ? { darkBlob: item.darkBlob } : {}),
      width: item.width, height: item.height, vector: item.vector, adaptive: item.adaptive, updatedAt: item.updatedAt }, revision, version + 1);
  } catch { return null; }
}
export async function cacheNavigationIconBlob(input, blob) {
  const revision = cacheRevision;
  let url;
  try { url = normalizeIconAddress(input); } catch { return null; }
  const version = sourceVersions.get(url) || 0;
  const existing = await readCachedNavigationIcon(url); if (existing) return existing;
  try { blob = await normalizeIconBlob(blob); } catch { return null; }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) return null;
  validateIconBytes(new Uint8Array(await blob.arrayBuffer()), blob.type);
  const image = await createImageBitmap(blob);
  try { return await save({ url, blob, width: image.width, height: image.height, vector: false, adaptive: false, updatedAt: Date.now() }, revision, version); }
  finally { image.close(); }
}
async function boundedImage(response, signal) {
  const limit = MAX_BYTES;
  const length = response.headers.get('content-length');
  if (length !== null && !/^\d+$/.test(length)) throw imageError('FORMAT');
  if (length !== null && Number(length) > limit) throw imageError('LIMIT');
  if (!response.body?.getReader) throw imageError('FORMAT');
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    while (true) {
      active(signal);
      const { done, value } = await reader.read(); if (done) break;
      if ((size += value.length) > limit) { await reader.cancel(); throw imageError('LIMIT'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw imageError('FORMAT');
  return normalizeIconBlob(new Blob(parts));
}
function svgInfo(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source) || !globalThis.DOMParser) throw Error('Unsupported SVG');
  // Parse inert XML only. These nodes are never inserted into the page.
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') throw Error('Invalid SVG');
  const nodes = [...document.querySelectorAll('*')];
  const allowed = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop', 'title', 'desc', 'style', 'symbol', 'use']);
  if (nodes.length > 512) throw Error('SVG too complex');
  let styles = '';
  for (const node of nodes) {
    if (!allowed.has(node.localName) || node.namespaceURI !== 'http://www.w3.org/2000/svg') throw Error('Unsupported SVG element');
    for (const attribute of node.attributes) {
      if (/^on/i.test(attribute.localName) || attribute.localName === 'base'
        || attribute.localName === 'href' && !attribute.value.startsWith('#')) throw Error('External SVG resource');
      if (attribute.localName === 'style' || /url\s*\(/i.test(attribute.value)) styles += `\n${attribute.value}`;
    }
    if (node.localName === 'style') styles += `\n${node.getAttribute('media') ? `@media ${node.getAttribute('media')}` : ''}\n${node.textContent}`;
  }
  if (/@import|@font-face/i.test(styles)) throw Error('External SVG style');
  for (const match of styles.matchAll(/url\s*\(\s*([^)]*)\)/gi)) if (!/^['"]?#[^\s'"()]+['"]?$/.test(match[1].trim())) throw Error('External SVG image');
  const root = document.documentElement;
  const box = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const length = (value) => /^\s*\d+(?:\.\d+)?(?:px)?\s*$/i.test(value || '') ? parseFloat(value) : 0;
  const width = length(root.getAttribute('width')) || box[2] || 256, height = length(root.getAttribute('height')) || box[3] || 256;
  if (![width, height].every((value) => Number.isFinite(value) && value > 0 && value <= 4096)) throw Error('SVG size exceeds budget');
  return { width, height, adaptive: /(?:@media|media\s*=)[^{}]*prefers-color-scheme\s*:\s*(?:light|dark)/i.test(styles.replace(/\/\*[\s\S]*?\*\//g, '')) };
}
async function rasterize(blob, scheme, width, height, signal, vector = true) {
  active(signal);
  const url = URL.createObjectURL(blob), image = new Image(); let timer;
  const scale = vector ? 256 / Math.max(width, height) : Math.min(1, 256 / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * scale)), outHeight = Math.max(1, Math.round(height * scale));
  image.style.cssText = `position:fixed;left:-10000px;top:-10000px;pointer-events:none;visibility:hidden;color-scheme:${scheme};width:${outWidth}px;height:${outHeight}px`;
  image.setAttribute('aria-hidden', 'true'); image.inert = true;
  try {
    // SVG is loaded solely as an image: no inline SVG, object, iframe or code.
    // The image element's color-scheme selects the site's own CSS variant.
    document.body.appendChild(image);
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error('Image decode timeout')), 4000);
      image.onload = resolve; image.onerror = () => reject(Error('Image decode failed')); image.src = url;
    });
    active(signal);
    const canvas = Object.assign(document.createElement('canvas'), { width: outWidth, height: outHeight });
    const context = canvas.getContext('2d'); if (!context) throw Error('Canvas unavailable');
    context.drawImage(image, 0, 0, outWidth, outHeight);
    const result = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!result || !result.size || result.size > MAX_BYTES) throw Error('Rasterization failed');
    return { blob: result, width: outWidth, height: outHeight };
  } finally { clearTimeout(timer); image.onload = image.onerror = null; image.removeAttribute('src'); image.remove(); URL.revokeObjectURL(url); }
}
async function load(url, revision, version, force, signal) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let stage = 'NETWORK';
  try {
    // An existing host grant or the site's CORS policy may allow this fetch.
    // Never request a new permission, send credentials, or use a proxy.
    active(signal);
    const response = await globalThis.fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', mode: 'cors', cache: force ? 'no-store' : 'default', signal: controller.signal });
    if (!response.ok) throw imageError('HTTP', { httpStatus: response.status });
    if (response.type === 'opaque' || response.type === 'opaqueredirect') throw imageError('NETWORK');
    if (response.url) {
      const destination = normalizeIconAddress(response.url);
      if (url.startsWith('https:') && !destination.startsWith('https:')) throw imageError('REDIRECT');
    }
    stage = 'FORMAT';
    const original = await boundedImage(response, controller.signal);
    let result;
    if (original.type === 'image/svg+xml') {
      const info = svgInfo(await original.text());
      stage = 'DECODE';
      const light = await rasterize(original, 'light', info.width, info.height, controller.signal);
      const dark = info.adaptive ? await rasterize(original, 'dark', info.width, info.height, controller.signal) : null;
      let adaptive = false;
      if (dark) {
        const a = new Uint8Array(await light.blob.arrayBuffer()), b = new Uint8Array(await dark.blob.arrayBuffer());
        adaptive = a.length !== b.length || a.some((value, index) => value !== b[index]);
      }
      result = { ...light, vector: true, adaptive, ...(adaptive ? { darkBlob: dark.blob } : {}) };
    } else {
      const bytes = new Uint8Array(await original.arrayBuffer());
      validateIconBytes(bytes, original.type);
      stage = 'DECODE';
      if (/icon$/.test(original.type)) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let width = 1, height = 1;
        for (let index = 0; index < view.getUint16(4, true); index++) {
          const edge = 6 + index * 16, w = bytes[edge] || 256, h = bytes[edge + 1] || 256;
          if (Math.min(w, h) > Math.min(width, height)) { width = w; height = h; }
        }
        // Chrome's Image decoder supports ICO even where createImageBitmap
        // does not. Keep it in the final fallback tier without upscaling.
        result = { ...await rasterize(original, 'light', width, height, controller.signal, false), vector: false, adaptive: false };
      } else {
        const image = await createImageBitmap(original);
        try { result = { blob: original, width: image.width, height: image.height, vector: false, adaptive: false }; }
        finally { image.close(); }
      }
    }
    active(controller.signal);
    const saved = await save({ ...result, url, updatedAt: Date.now() }, revision, version, () => !controller.signal.aborted);
    active(controller.signal);
    return saved;
  } catch (reason) {
    if (controller.signal.aborted) throw imageError(signal?.aborted ? 'CANCELLED' : 'TIMEOUT');
    if (reason?.code && ['HTTP', 'FORMAT', 'LIMIT', 'REDIRECT', 'NETWORK', 'DECODE', 'STORAGE', 'CANCELLED'].includes(reason.code)) throw reason;
    if (stage === 'NETWORK') {
      let access;
      try { access = await globalThis.chrome?.permissions?.contains?.({ origins: [`${new URL(url).origin}/*`] }); } catch { /* Unknown access stays a network error. */ }
      throw imageError(access === false ? 'ACCESS' : 'NETWORK');
    }
    throw imageError(stage);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function pump() {
  while (running < 3 && queue.length) {
    const job = queue.shift(); running++;
    load(job.url, job.revision, job.version, job.force, job.signal).then(job.resolve, job.reject).finally(() => { running--; pump(); });
  }
}
export async function navigationIcon(input, { force = false, signal } = {}) {
  let url;
  try { url = normalizeIconAddress(input); } catch { return null; }
  // Merely displaying a saved URL must never issue an HTTP request, even
  // when its previous cross-origin fetch failed and left no persistent bytes.
  if (!force) return readCachedNavigationIcon(url);
  if (signal?.aborted) { recordFailure(url, { code: 'CANCELLED' }); return null; }
  // Only explicit discovery uses force. A normal render always keeps valid
  // persistent bytes, regardless of age, and never refreshes them in the background.
  const key = force ? `${url}\0refresh` : url;
  if (pending.has(key)) return pending.get(key);
  const revision = cacheRevision;
  const version = force ? (sourceVersions.get(url) || 0) + 1 : sourceVersions.get(url) || 0;
  if (force) { sourceVersions.set(url, version); cacheReads.delete(url); }
  // Include the IndexedDB read in the shared operation. Parallel cache hits
  // otherwise produce distinct Blob records and replace the live URL lease.
  const work = (async () => {
    if (!force) { const item = await readCachedNavigationIcon(url); if (item) return item; }
    if (revision !== cacheRevision || version !== (sourceVersions.get(url) || 0)) return null;
    if (!force && Date.now() - (failures.get(url) || 0) < 300000 || queue.length >= 64) return null;
    return new Promise((resolve, reject) => { queue.push({ url, revision, version, force, signal, resolve, reject }); pump(); });
  })().catch((reason) => {
    if (revision !== cacheRevision || version !== (sourceVersions.get(url) || 0)) return null;
    failures.set(url, Date.now());
    recordFailure(url, { code: reason?.code || 'NETWORK', ...(Number.isInteger(reason?.httpStatus) ? { httpStatus: reason.httpStatus } : {}) });
    while (failures.size > 128) failures.delete(failures.keys().next().value);
    return null;
  }).finally(() => { if (pending.get(key) === work) pending.delete(key); });
  pending.set(key, work);
  return work;
}

// Called only by a user submitting a new/changed icon, never by rendering.
export async function prepareSavedNavigationIcon(entry, previous, { iconEdited = false } = {}) {
  if (entry.type !== 'site' || entry.icon?.kind === 'image') return true;
  const sources = (item) => [...new Set([siteIconAddress(item), item.iconVariants?.light?.url, item.iconVariants?.dark?.url].filter(Boolean))];
  const requested = sources(entry);
  if (!iconEdited && previous?.icon?.kind !== 'image' && previous && JSON.stringify(requested) === JSON.stringify(sources(previous))) return true;
  const results = await Promise.all(requested.map(async (source) => await readCachedNavigationIcon(source) || await navigationIcon(source, { force: true })));
  return results.every(Boolean);
}
