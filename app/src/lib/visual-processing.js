import { tr, getLocale } from "../i18n/index.js";
const iconPresentation = new WeakMap();
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_EDGE = 8192;
const MAX_PIXELS = 40_000_000;
const SAMPLE_EDGE = 256;
const OUTPUT_EDGE = 128;
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const FALLBACK_MESSAGE = tr("视觉处理暂不可用，已使用原始外观。");
const abortError = () => new DOMException(tr("视觉处理已取消。"), 'AbortError');
function active(signal) { if (signal?.aborted) throw abortError(); }
function sameOrigin(a, b) { return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port; }
function diagnoseVisual(kind, stage, error) {
  // Development-only diagnostics deliberately exclude URLs, image content,
  // navigation names, error messages and user configuration.
  if (import.meta.env?.DEV && error?.name !== 'AbortError') console.warn('[Covelet visual]', { kind, stage, error: error?.name || 'Error' });
}
let runtimeStatus = Object.freeze({ phase: 'idle', failures: 0, message: '' });
const statusListeners = new Set();
export function getVisualRuntimeStatus() { return runtimeStatus; }
export function subscribeVisualRuntimeStatus(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener); }
function reportRuntime(phase) {
  runtimeStatus = Object.freeze({ phase, failures: runtimeStatus.failures + (phase === 'fallback' ? 1 : 0), message: phase === 'fallback' ? tr("部分视觉增强暂不可用，已使用原始外观。") : '' });
  for (const listener of statusListeners) listener();
}

export function validateLocalVisualUrl(input, baseUrl = globalThis.location?.href) {
  if (typeof input !== 'string' || !input || input.length > 2048 || /[\\\u0000-\u0020]/.test(input)) throw new Error(tr("只能处理已加载的本地图片。"));
  const base = new URL(baseUrl);
  if (!['http:', 'https:', 'chrome-extension:', 'moz-extension:'].includes(base.protocol)) throw new Error(tr("图片来源无效。"));
  const url = new URL(input, base);
  if (url.protocol === 'blob:') {
    const owner = new URL(url.href.slice(5));
    if (!['http:', 'https:', 'chrome-extension:', 'moz-extension:'].includes(owner.protocol) || !sameOrigin(owner, base) || owner.username || owner.password || owner.search || owner.hash) throw new Error(tr("图片不属于当前扩展。"));
    return url.href;
  }
  // Only the shipped wallpaper fallback may be read by path. Site icons arrive
  // as bounded local raster blobs from the independent image cache. General
  // HTTP(S), data:, file:, SVG and external resources stay outside this worker.
  const permitted = ['./assets/alpine-lake.png'].map((path) => new URL(path, base).href);
  if (!sameOrigin(url, base) || !permitted.includes(url.href) || url.username || url.password) throw new Error(tr("只能处理已加载的本地图片。"));
  return url.href;
}

async function boundedBlob(response, signal) {
  const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!RASTER_TYPES.has(mime)) throw new Error(FALLBACK_MESSAGE);
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new Error(FALLBACK_MESSAGE);
  let bytes = 0;
  const parts = [];
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        active(signal);
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error(FALLBACK_MESSAGE); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
  } else {
    const part = await response.arrayBuffer();
    bytes = part.byteLength;
    parts.push(part);
  }
  active(signal);
  if (!bytes || bytes > MAX_BYTES) throw new Error(FALLBACK_MESSAGE);
  return new Blob(parts, { type: mime });
}

function rasterSize(bytes, mime) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  let width = 0, height = 0;
  if (mime === 'image/png' && bytes.length >= 33 && bytes[0] === 137 && ascii(1, 7) === 'PNG\r\n\x1a\n' && ascii(12, 4) === 'IHDR') {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (mime === 'image/jpeg' && bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 3 < bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 7) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += size;
    }
  } else if (mime === 'image/webp' && bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8X' && !(bytes[20] & 2)) {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (kind === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = view.getUint16(26, true) & 16383; height = view.getUint16(28, true) & 16383;
    } else if (kind === 'VP8L' && bytes[20] === 47) {
      width = 1 + ((bytes[21] | (bytes[22] << 8)) & 16383);
      height = 1 + (((bytes[22] >> 6) | (bytes[23] << 2) | (bytes[24] << 10)) & 16383);
    }
  }
  if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) throw new Error(FALLBACK_MESSAGE);
  return { width, height };
}

function canvasAt(width, height) {
  if (globalThis.OffscreenCanvas) return new OffscreenCanvas(width, height);
  if (!globalThis.document) throw new Error(FALLBACK_MESSAGE);
  return Object.assign(document.createElement('canvas'), { width, height });
}

function defaultFetch(url, options) { return globalThis.fetch(url, options); }

export async function decodeVisualImage(url, { signal, detailEdge = 0, baseUrl = globalThis.location?.href, fetcher = defaultFetch, createBitmap = (...args) => globalThis.createImageBitmap(...args), makeCanvas = canvasAt } = {}) {
  url = validateLocalVisualUrl(url, baseUrl);
  active(signal);
  const response = await fetcher(url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal });
  if (!response.ok || response.redirected || (response.url && response.url !== url)) throw new Error(FALLBACK_MESSAGE);
  const blob = await boundedBlob(response, signal);
  const original = rasterSize(new Uint8Array(await blob.arrayBuffer()), blob.type);
  active(signal);
  const scale = Math.min(1, SAMPLE_EDGE / Math.max(original.width, original.height));
  const width = Math.max(1, Math.round(original.width * scale));
  const height = Math.max(1, Math.round(original.height * scale));
  const decodeScale = Math.min(1, (detailEdge === 2048 ? 2048 : SAMPLE_EDGE) / Math.max(original.width, original.height));
  const decodeWidth = Math.max(1, Math.round(original.width * decodeScale)), decodeHeight = Math.max(1, Math.round(original.height * decodeScale));
  let bitmap;
  try {
    bitmap = await createBitmap(blob, { resizeWidth: decodeWidth, resizeHeight: decodeHeight, resizeQuality: 'high' });
    active(signal);
    if (bitmap.width !== decodeWidth || bitmap.height !== decodeHeight) throw new Error(FALLBACK_MESSAGE);
    const canvas = makeCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error(FALLBACK_MESSAGE);
    context.imageSmoothingQuality = 'high'; context.drawImage(bitmap, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    let detail;
    if (decodeWidth > width || decodeHeight > height) {
      const detailed = makeCanvas(decodeWidth, decodeHeight), detailedContext = detailed.getContext('2d', { willReadFrequently: true });
      if (!detailedContext) throw new Error(FALLBACK_MESSAGE);
      detailedContext.drawImage(bitmap, 0, 0, decodeWidth, decodeHeight);
      detail = { width: decodeWidth, height: decodeHeight, originalWidth: original.width, originalHeight: original.height,
        pixels: detailedContext.getImageData(0, 0, decodeWidth, decodeHeight).data.slice().buffer };
    }
    return { width, height, originalWidth: original.width, originalHeight: original.height, pixels: data.slice().buffer, ...(detail ? { detail } : {}) };
  } finally { bitmap?.close?.(); }
}

export async function encodeVisualIcon({ width, height, pixels }, { signal, makeCanvas = canvasAt, createImageData = (bytes, width, height) => new ImageData(bytes, width, height) } = {}) {
  active(signal);
  if (width !== OUTPUT_EDGE || height !== OUTPUT_EDGE || !(pixels instanceof ArrayBuffer) || pixels.byteLength !== OUTPUT_EDGE * OUTPUT_EDGE * 4) throw new Error(FALLBACK_MESSAGE);
  const canvas = makeCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error(FALLBACK_MESSAGE);
  context.putImageData(createImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error(FALLBACK_MESSAGE)), 'image/png'));
  active(signal);
  if (!(blob instanceof Blob) || !blob.size || blob.size > 256 * 1024 || blob.type !== 'image/png') throw new Error(FALLBACK_MESSAGE);
  return blob;
}

const hex = (value) => `#${(value >>> 0).toString(16).padStart(6, '0')}`;
export function paletteFromStats(stats) {
  if (!Array.isArray(stats) || stats.length !== 32 || stats[0] !== 1 || stats[1] !== 0 || stats[2] < 1 || stats.slice(3, 5).some((value) => !Number.isInteger(value) || value < 0 || value > 0xffffff) || stats.slice(5, 9).some((value) => !Number.isInteger(value) || value < 0 || value > 10000) || stats.slice(9, 12).some((value) => !Number.isInteger(value) || value < 0 || value > 0xffffff) || stats.slice(12, 15).some((value) => !Number.isInteger(value) || value < 0 || value > 10000)) throw new Error(FALLBACK_MESSAGE);
  const brightness = stats[5] / 10000;
  const p90 = stats[8] / 10000;
  return {
    dominant: hex(stats[3]), mean: hex(stats[4]), accent: hex(stats[3]),
    brightness, p10: stats[6] / 10000, p50: stats[7] / 10000, p90,
    colors: stats.slice(9, 12).map(hex), weights: stats.slice(12, 15).map((value) => value / 10000),
    surface: brightness > 0.45 ? '#f5f5f7' : '#1d1d1f',
    foreground: brightness > 0.45 ? '#1d1d1f' : '#ffffff',
    overlay: Math.min(0.58, Math.max(0.12, p90 ? 1 - 0.18 / p90 : 0.12)),
  };
}

function defaultWorkerFactory() {
  return new Worker(new URL('./visual-worker.js', import.meta.url), { type: 'module' });
}

function createWorkerClient(workerFactory, timeoutMs) {
  let worker, serial = 0;
  const waiting = new Map();
  function stop(error = new Error(FALLBACK_MESSAGE)) {
    const previous = worker;
    worker = null;
    if (previous) {
      previous.onmessage = previous.onerror = previous.onmessageerror = null;
      previous.terminate();
    }
    for (const job of waiting.values()) job.reject(error);
    waiting.clear();
  }
  return {
    run(data, signal) {
      active(signal);
      if (!worker) {
        worker = workerFactory();
        const owner = worker;
        worker.onmessage = ({ data: message }) => {
          if (worker !== owner) return;
          const job = waiting.get(message?.id);
          if (!job) return;
          waiting.delete(message.id);
          if (message.cancelled) job.reject(abortError());
          else if (message.ok) job.resolve(message.result);
          else job.reject(new Error(FALLBACK_MESSAGE));
        };
        worker.onerror = () => { if (worker === owner) stop(); };
        worker.onmessageerror = () => { if (worker === owner) stop(); };
      }
      const id = ++serial, owner = worker;
      return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); waiting.delete(id); };
        const aborted = () => { cleanup(); reject(abortError()); };
        const timer = setTimeout(() => { if (worker === owner && waiting.has(id)) stop(); }, timeoutMs);
        waiting.set(id, { resolve(value) { cleanup(); resolve(value); }, reject(error) { cleanup(); reject(error); } });
        signal?.addEventListener('abort', aborted, { once: true });
        try { worker.postMessage({ id, ...data }, data.kind === 'captions' ? data.patches.map((patch) => patch.pixels) : [data.pixels]); }
        catch (error) { cleanup(); reject(error); }
      });
    },
    stop,
  };
}

export function createVisualProcessor({
  baseUrl = globalThis.location?.href,
  decode = decodeVisualImage, encode = encodeVisualIcon,
  workerFactory = defaultWorkerFactory,
  timeoutMs = 12000, maxQueued = 64, cacheLimit = 32, idleMs = 5000,
} = {}) {
  const client = createWorkerClient(workerFactory, timeoutMs);
  const pending = new Map(), cache = new Map(), queue = [];
  let running = 0, captionJobs = 0, disposed = false, idleTimer;
  const remember = (key, value) => {
    cache.delete(key);
    cache.set(key, value);
    const wallpaperKeys = [...cache.keys()].filter((entry) => entry.startsWith('wallpaper:'));
    for (const old of wallpaperKeys.slice(0, -2)) cache.delete(old);
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
  };
  function pump() {
    clearTimeout(idleTimer);
    if (disposed) return;
    while (!disposed && running < 2 && queue.length) {
      const task = queue.shift();
      if (!task.refs) continue;
      running++;
      task.started = true;
      task.stage = 'decode';
      const { signal } = task.controller;
      const timer = setTimeout(() => { task.timedOut = true; client.stop(); task.controller.abort(); }, timeoutMs);
      let onAbort;
      const work = Promise.resolve().then(async () => {
        const image = await decode(task.url, { signal, baseUrl, detailEdge: task.kind === 'wallpaper' ? 2048 : 0 });
        active(signal);
        const { detail, ...thumbnail } = image;
        const sample = task.kind === 'wallpaper' ? detail || { ...thumbnail, pixels: thumbnail.pixels.slice(0) } : null;
        task.stage = 'wasm';
        const result = await client.run({ kind: task.kind, ...thumbnail }, signal);
        active(signal);
        task.stage = task.kind === 'wallpaper' ? 'palette' : 'encode';
        if (task.kind === 'wallpaper') return { ...paletteFromStats(result.stats), sample };
        const blob = await encode(result, { signal });
        // WASM reports content coverage. Full app artwork keeps its original
        // pixels and fills the rounded mask, without a second padded square.
        iconPresentation.set(blob, result.presentation || { fullBleed: false });
        return blob;
      });
      const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(task.timedOut ? new Error(FALLBACK_MESSAGE) : abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      Promise.race([work, interrupted]).then((result) => {
        active(signal);
        if (task.refs) remember(task.key, result);
        task.resolve(result);
      }).catch((error) => { diagnoseVisual(task.kind, task.stage, error); task.reject(error); }).finally(() => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (pending.get(task.key) === task) pending.delete(task.key);
        running--;
        pump();
      });
    }
    if (!running && !captionJobs && !queue.length) {
      idleTimer = setTimeout(() => { if (!running && !captionJobs && !queue.length) client.stop(); }, idleMs);
      idleTimer.unref?.();
    }
  }
  return {
    peekIconPresentation(url) {
      const blob = cache.get(`icon:${url}`);
      return blob ? iconPresentation.get(blob) : undefined;
    },
    async captions(patches, signal) {
      active(signal);
      if (disposed) throw new Error(FALLBACK_MESSAGE);
      clearTimeout(idleTimer);
      captionJobs++;
      try {
        const result = await client.run({ kind: 'captions', patches }, signal);
        active(signal);
        if (!Array.isArray(result.captions) || result.captions.length !== patches.length) throw new Error(FALLBACK_MESSAGE);
        reportRuntime('ready');
        return result.captions;
      } catch (error) {
        if (error?.name !== 'AbortError') { diagnoseVisual('captions', 'wasm', error); reportRuntime('fallback'); }
        throw error;
      } finally { captionJobs--; pump(); }
    },
    acquire(kind, input) {
      let url;
      try {
        if (disposed || !['wallpaper', 'icon'].includes(kind)) throw new Error(FALLBACK_MESSAGE);
        url = validateLocalVisualUrl(input, baseUrl);
      } catch (error) { diagnoseVisual(kind, 'validate', error); return { promise: Promise.reject(error), release() {} }; }
      const key = `${kind}:${url}`;
      if (cache.has(key)) {
        const value = cache.get(key);
        remember(key, value);
        return { promise: Promise.resolve(value), release() {} };
      }
      let task = pending.get(key);
      if (!task) {
        if (queue.length >= maxQueued) return { promise: Promise.reject(new Error(tr("待处理图标较多，暂时使用原始图标。"))), release() {} };
        task = { key, kind, url, refs: 0, controller: new AbortController() };
        task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
        pending.set(key, task);
        queue.push(task);
      }
      task.refs++;
      pump();
      let released = false;
      return { promise: task.promise, release() {
        if (released) return;
        released = true;
        if (--task.refs !== 0) return;
        if (pending.get(key) === task) pending.delete(key);
        task.controller.abort();
        task.reject(abortError());
        const index = queue.indexOf(task);
        if (index >= 0) queue.splice(index, 1);
      } };
    },
    dispose() {
      disposed = true;
      clearTimeout(idleTimer);
      for (const task of pending.values()) { task.controller.abort(); task.reject(abortError()); }
      pending.clear();
      queue.length = 0;
      cache.clear();
      client.stop();
    },
  };
}

let processor;
export function getCachedIconPresentation(url) {
  return processor?.peekIconPresentation(url);
}

export function acquireVisualResult(kind, url) {
  processor ??= createVisualProcessor();
  return processor.acquire(kind, url);
}

export function analyzeNavigationContrast(patches, signal) {
  processor ??= createVisualProcessor();
  return processor.captions(patches, signal);
}

// Guard async publication independently of React rendering. Each input change
// has a separate lifetime; a late result can never create a stale object URL.
export function observeVisualResult(kind, url, { acquire = acquireVisualResult, publish, createObjectURL = (blob) => URL.createObjectURL(blob), revokeObjectURL = (value) => URL.revokeObjectURL(value) } = {}) {
  let activeLifetime = true, objectUrl;
  const lease = acquire(kind, url);
  lease.promise.then((value) => {
    if (!activeLifetime) return;
    try {
      if (kind === 'icon') objectUrl = createObjectURL(value);
      reportRuntime('ready');
      publish({ source: url, phase: 'ready', message: '', ...(kind === 'icon' ? { url: objectUrl, adapted: true, ...iconPresentation.get(value) } : { palette: value }) });
    } catch (error) {
      diagnoseVisual(kind, 'publish', error);
      reportRuntime('fallback');
      publish({ source: url, phase: 'fallback', message: FALLBACK_MESSAGE });
    }
  }).catch((error) => {
    if (activeLifetime && error?.name !== 'AbortError') {
      reportRuntime('fallback');
      publish({ source: url, phase: 'fallback', message: FALLBACK_MESSAGE });
    }
  });
  return () => {
    if (!activeLifetime) return;
    activeLifetime = false;
    lease.release();
    if (objectUrl) revokeObjectURL(objectUrl);
  };
}
