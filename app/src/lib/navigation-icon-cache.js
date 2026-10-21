import { normalizeIconAddress } from './site-icons.js';
import { validateIconBytes } from './site-info.js';

// Device-local images, separate from navigation assets, backups and sync.
const DATABASE = 'covelet.navigation-icons.v1', STORE = 'images';
const MAX_BYTES = 1024 * 1024, SVG_BYTES = 128 * 1024, MAX_ITEMS = 64, MAX_CACHE_BYTES = 16 * MAX_BYTES;
const MAX_AGE = 30 * 86400000;
const session = new Map(), pending = new Map(), failures = new Map();
let opening, running = 0;
const queue = [];
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
function open() {
  return opening ??= new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(Error('Image cache unavailable')); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'url' });
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('Image cache blocked'));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); opening = undefined; };
      resolve(database);
    };
  }).catch((error) => { opening = undefined; throw error; });
}
async function cached(url) {
  const known = session.get(url);
  if (known && Date.now() - known.updatedAt < MAX_AGE) return remember(url, known);
  try {
    const database = await open();
    const item = await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readonly'), request = transaction.objectStore(STORE).get(url);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    if (!item || item.url !== url || !Number.isFinite(item.updatedAt) || Date.now() - item.updatedAt >= MAX_AGE
      || !Number.isInteger(item.width) || !Number.isInteger(item.height) || item.width < 1 || item.height < 1
      || item.width > 4096 || item.height > 4096 || item.width * item.height > 4_000_000
      || typeof item.adaptive !== 'boolean' || typeof item.vector !== 'boolean') return null;
    for (const blob of [item.blob, ...(item.adaptive ? [item.darkBlob] : [])]) {
      if (!(blob instanceof Blob) || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || !blob.size || blob.size > MAX_BYTES) return null;
      validateIconBytes(new Uint8Array(await blob.arrayBuffer()), blob.type);
    }
    return remember(url, item);
  } catch { return null; }
}
async function save(item) {
  remember(item.url, item);
  try {
    const database = await open();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite'), store = transaction.objectStore(STORE);
      store.put(item);
      const request = store.getAll();
      request.onsuccess = () => {
        const items = request.result.sort((a, b) => b.updatedAt - a.updatedAt);
        let count = 0, bytes = 0;
        for (const entry of items) {
          bytes += imageBytes(entry);
          if (++count > MAX_ITEMS || bytes > MAX_CACHE_BYTES || Date.now() - entry.updatedAt >= MAX_AGE) store.delete(entry.url);
        }
      };
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  } catch { /* Cache quota never blocks adding or displaying a website. */ }
  return item;
}
async function boundedImage(response, signal) {
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const limit = mime === 'image/svg+xml' ? SVG_BYTES : MAX_BYTES;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml'].includes(mime)) throw Error('Unsupported image');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw Error('Image too large');
  if (!response.body?.getReader) throw Error('Bounded streaming unavailable');
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    while (true) {
      active(signal);
      const { done, value } = await reader.read(); if (done) break;
      if ((size += value.length) > limit) { await reader.cancel(); throw Error('Image too large'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw Error('Empty image');
  return new Blob(parts, { type: mime });
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
async function load(url) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  try {
    // An existing host grant or the site's CORS policy may allow this fetch.
    // Never request a new permission, send credentials, or use a proxy.
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', mode: 'cors', signal: controller.signal });
    if (!response.ok || response.redirected || response.url && response.url !== url) throw Error('Image unavailable');
    const original = await boundedImage(response, controller.signal);
    let result;
    if (original.type === 'image/svg+xml') {
      const info = svgInfo(await original.text());
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
    return save({ ...result, url, updatedAt: Date.now() });
  } finally { clearTimeout(timer); }
}
function pump() {
  while (running < 3 && queue.length) {
    const job = queue.shift(); running++;
    load(job.url).then(job.resolve, job.reject).finally(() => { running--; pump(); });
  }
}
export async function navigationIcon(input, { force = false } = {}) {
  let url;
  try { url = normalizeIconAddress(input); } catch { return null; }
  const item = await cached(url); if (item) return item;
  if (pending.has(url)) return pending.get(url);
  if (!force && Date.now() - (failures.get(url) || 0) < 300000 || queue.length >= 64) return null;
  const work = new Promise((resolve, reject) => { queue.push({ url, resolve, reject }); pump(); }).catch(() => {
    failures.set(url, Date.now());
    while (failures.size > 128) failures.delete(failures.keys().next().value);
    return null;
  }).finally(() => pending.delete(url));
  pending.set(url, work);
  return work;
}
