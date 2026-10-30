import { tr, getLocale } from "../i18n/index.js";
import { createEncryptedStore } from './local-data.js';
import { subscribeSyncedData } from './use-synced-data.js';
import { migrateLegacyIndexedDb } from './legacy-indexed-data.js';
// Daily image bytes join full encrypted sync in their own cache namespace.
// No request is made until this provider loads.
export const BING_METADATA_URL = 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN';
const BING_ORIGIN = 'https://www.bing.com';
const BUILTIN_URL = './assets/alpine-lake.png';
const CACHE_LOCK = 'owntab.bing-wallpaper.v1';
const MAX_METADATA = 64 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const RETRY_DELAY = 15 * 60 * 1000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DAY = /^\d{8}$/;
const DEVELOPMENT = Boolean(import.meta.env?.DEV) && !globalThis.chrome?.runtime?.id;
const wallpaperRecords = createEncryptedStore('wallpaper');

export function migrateWallpaperCache() {
  return migrateLegacyIndexedDb('owntab.wallpaper.v1', 'daily', wallpaperRecords);
}

function expectedResponseUrl(actual, requested) {
  if (!actual || actual === requested) return true;
  if (!DEVELOPMENT || !globalThis.location) return false;
  const proxy = new URL(actual);
  const original = new URL(requested);
  return proxy.origin === globalThis.location.origin && proxy.pathname === `/__bing${original.pathname}` && proxy.search === original.search && !proxy.hash;
}

function defaultFetch(url, options) {
  // The fixed development proxy only makes browser QA possible. This branch is
  // removed from the extension build; production requests Bing directly.
  const target = DEVELOPMENT ? `/__bing${new URL(url).pathname}${new URL(url).search}` : url;
  return globalThis.fetch(target, options);
}

function error(message) { throw new Error(message); }
function dayAt(time) {
  const value = new Date(time);
  return `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, '0')}${String(value.getDate()).padStart(2, '0')}`;
}
function text(value, limit) {
  if (typeof value !== 'string' || value.length > limit) error(tr("Bing 图片说明无效。"));
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

export function validateBingImageUrl(value) {
  if (typeof value !== 'string' || value.length > 600 || /[\\\u0000-\u0020]/.test(value)) error(tr("Bing 图片地址无效。"));
  const url = new URL(value, BING_ORIGIN);
  if (url.origin !== BING_ORIGIN || url.username || url.password || url.hash || url.pathname !== '/th') error(tr("Bing 图片地址超出允许范围。"));
  const id = url.searchParams.get('id');
  if (!id || !/^OHR\.[A-Za-z0-9_.-]+_1920x1080\.jpg$/.test(id) || id.length > 240) error(tr("Bing 图片标识无效。"));
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || !['id', 'rf', 'pid'].includes(key)) error(tr("Bing 图片参数无效。"));
    if ((key === 'rf' && value !== 'LaDigue_1920x1080.jpg') || (key === 'pid' && value !== 'hp')) error(tr("Bing 图片参数无效。"));
    seen.add(key);
  }
  // Rebuild the endpoint from its validated image id; omit optional tracking tags.
  return `${BING_ORIGIN}/th?id=${encodeURIComponent(id)}`;
}

function metadataFrom(value) {
  if (!value || !Array.isArray(value.images) || value.images.length < 1 || value.images.length > 8) error(tr("Bing 每日图片数据无效。"));
  const image = value.images[0];
  if (!image || !DAY.test(image.startdate) || !DAY.test(image.enddate)) error(tr("Bing 图片日期无效。"));
  const copyrightUrl = new URL(image.copyrightlink);
  if (copyrightUrl.origin !== BING_ORIGIN || copyrightUrl.username || copyrightUrl.password || copyrightUrl.hash || copyrightUrl.pathname !== '/search') error(tr("Bing 图片说明链接无效。"));
  return {
    imageUrl: validateBingImageUrl(image.url),
    date: image.startdate,
    copyright: text(image.copyright, 600),
    title: text(image.title ?? '', 200),
    copyrightUrl: copyrightUrl.href,
  };
}

// Header validation bounds decoding work before an image is handed to the UI.
function dimensions(bytes, mime) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, count) => String.fromCharCode(...bytes.subarray(offset, offset + count));
  let width = 0;
  let height = 0;
  let detected;
  if (bytes.length >= 33 && bytes[0] === 137 && ascii(1, 7) === 'PNG\r\n\x1a\n' && ascii(12, 4) === 'IHDR') {
    detected = 'image/png';
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    detected = 'image/jpeg';
    for (let offset = 2; offset + 3 < bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    detected = 'image/webp';
    const kind = ascii(12, 4);
    if (kind === 'VP8X') {
      if (bytes[20] & 2) error(tr("Bing 图片不能使用动画 WebP。"));
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (kind === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = view.getUint16(26, true) & 16383;
      height = view.getUint16(28, true) & 16383;
    } else if (kind === 'VP8L' && bytes[20] === 47) {
      width = 1 + ((bytes[21] | (bytes[22] << 8)) & 16383);
      height = 1 + (((bytes[22] >> 6) | (bytes[23] << 2) | (bytes[24] << 10)) & 16383);
    }
  }
  if (detected !== mime || !width || !height || width > 8192 || height > 8192 || width * height > MAX_PIXELS) error(tr("Bing 图片格式或尺寸超出限制。"));
  return { width, height };
}

async function boundedBody(response, maxBytes) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) error(tr("Bing 响应超过大小限制。"));
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) error(tr("Bing 响应超过大小限制。"));
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); error(tr("Bing 响应超过大小限制。")); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function request(fetcher, url, limit, timeoutMs, expectedType) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, {
          method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer',
          redirect: 'error', cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok || response.redirected || !expectedResponseUrl(response.url, url)) error(tr("Bing 请求失败或发生重定向。"));
        const mime = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
        if (!expectedType(mime)) error(tr("Bing 响应类型无效。"));
        return { bytes: await boundedBody(response, limit), mime };
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(tr("Bing 图片请求超时。"))); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function createCache() {
  return {
    async read() { await migrateWallpaperCache(); return await wallpaperRecords.get('current') ?? null; },
    async write(value, options) { await migrateWallpaperCache(); await wallpaperRecords.set('current', value, options); },
  };
}

async function validRecord(value) {
  if (!value || value.version !== 1 || !DAY.test(value.attemptDay) || !Number.isFinite(value.attemptAt)) return null;
  const result = { version: 1, attemptDay: value.attemptDay, attemptAt: value.attemptAt };
  if (value.blob instanceof Blob && value.blob.size > 0 && value.blob.size <= MAX_IMAGE && IMAGE_TYPES.has(value.blob.type) && DAY.test(value.fetchedDay) && value.metadata) {
    try {
      const metadata = metadataFrom({ images: [{ startdate: value.metadata.date, enddate: value.metadata.date, url: value.metadata.imageUrl, copyright: value.metadata.copyright, title: value.metadata.title, copyrightlink: value.metadata.copyrightUrl }] });
      dimensions(new Uint8Array(await value.blob.arrayBuffer()), value.blob.type);
      return { ...result, blob: value.blob, fetchedDay: value.fetchedDay, metadata };
    } catch { /* Keep the throttle record but discard invalid cached bytes. */ }
  }
  return result;
}

export function createWallpaperProvider({
  fetcher = defaultFetch,
  cache = createCache(), now = () => Date.now(),
  extension = Boolean(globalThis.chrome?.runtime?.id) || DEVELOPMENT,
  locks = globalThis.navigator?.locks, timeoutMs = 12000,
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
  decode = globalThis.createImageBitmap ? (blob) => globalThis.createImageBitmap(blob) : null,
} = {}) {
  let volatileRecord = null;
  let pending = null;
  let revision = 0;
  const ownedUrls = new Set();
  const fallback = (message = '') => ({ url: BUILTIN_URL, title: tr('内置背景'), copyright: '', copyrightUrl: '', stale: false, source: 'builtin', status: 'fallback', message });
  async function read(started) {
    let stored;
    try { stored = await validRecord(await cache.read()); } catch { stored = null; }
    if (started !== revision) return null;
    if (stored && (!volatileRecord || stored.attemptAt > volatileRecord.attemptAt)) volatileRecord = stored;
    return volatileRecord;
  }
  async function write(record, started) {
    if (started !== revision) return false;
    volatileRecord = record;
    try { await cache.write(record, { shouldWrite: () => started === revision }); } catch { /* A full/blocked cache must not prevent local use. */ }
    return started === revision;
  }
  async function refresh(started) {
    if (started !== revision) return {};
    const timestamp = Number(now());
    const today = dayAt(timestamp);
    let record = await read(started);
    if (started !== revision) return {};
    if (record?.fetchedDay === today && record.blob) return { record, status: 'cached', message: tr("正在使用今日缓存。") };
    // A successful image is fetched once per local day. Failed updates have a
    // 15-minute cooldown, so going offline briefly does not block the whole day.
    if (record?.attemptDay === today && timestamp - record.attemptAt < RETRY_DELAY) return { record, status: record.blob ? 'stale' : 'fallback', message: tr("今日背景暂不可用；15 分钟后打开或返回页面时重试。") };
    record = { ...record, version: 1, attemptDay: today, attemptAt: timestamp };
    if (!await write(record, started)) return {};
    try {
      const metadataResponse = await request(fetcher, BING_METADATA_URL, MAX_METADATA, timeoutMs, (mime) => mime === 'application/json');
      const metadata = metadataFrom(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataResponse.bytes)));
      const imageResponse = await request(fetcher, metadata.imageUrl, MAX_IMAGE, timeoutMs, (mime) => IMAGE_TYPES.has(mime));
      if (started !== revision) return {};
      dimensions(imageResponse.bytes, imageResponse.mime);
      const blob = new Blob([imageResponse.bytes], { type: imageResponse.mime });
      if (decode) {
        const image = await decode(blob);
        try {
          if (!image.width || !image.height || image.width > 8192 || image.height > 8192 || image.width * image.height > MAX_PIXELS) error(tr("Bing 图片尺寸超出限制。"));
        } finally { image.close?.(); }
      }
      record = { ...record, blob, metadata, fetchedDay: today };
      if (!await write(record, started)) return {};
      return { record, status: 'fresh', message: tr("今日壁纸已更新。") };
    } catch {
      return { record, status: record.blob ? 'stale' : 'fallback', message: record.blob ? tr("今日背景暂不可用，继续显示上次缓存。") : tr("今日背景暂不可用，已使用内置背景。") };
    }
  }
  return {
    // Existing rendered URLs remain owned until the caller disposes them.
    // A sync import only discards stale record/flight references in memory.
    invalidate() { revision++; volatileRecord = null; pending = null; },
    async load() {
      if (!extension) return fallback(tr('Bing 每日背景需要加载浏览器扩展后获取，网页预览使用内置背景。'));
      const started = revision;
      if (!pending) {
        const work = (locks?.request ? locks.request(CACHE_LOCK, { mode: 'exclusive' }, () => refresh(started)) : refresh(started)).finally(() => { if (pending === work) pending = null; });
        pending = work;
      }
      const { record, status, message = '' } = await pending;
      if (started !== revision) return fallback();
      if (!record?.blob) return fallback(message);
      const url = createObjectURL(record.blob);
      ownedUrls.add(url);
      return { ...record.metadata, url, stale: status === 'stale', source: 'bing', status, message };
    },
    dispose(result) {
      if (result?.url && ownedUrls.delete(result.url)) revokeObjectURL(result.url);
    },
    disposeAll() {
      for (const url of ownedUrls) revokeObjectURL(url);
      ownedUrls.clear();
    },
  };
}

let defaultProvider;
subscribeSyncedData(() => defaultProvider?.invalidate());
export function loadDailyWallpaper(options) {
  if (options) return createWallpaperProvider(options).load();
  defaultProvider ??= createWallpaperProvider();
  return defaultProvider.load();
}
