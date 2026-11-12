import { tr } from '../i18n/index.js';
import { createEncryptedStore, localData } from './local-data.js';
import { subscribeSyncedData } from './use-synced-data.js';
import { migrateLegacyIndexedDb } from './legacy-indexed-data.js';
import { COMMONS_API_ORIGIN, commonsCatalogUrl, parseCommonsCatalog, validateCommonsMetadata } from './wallpaper-commons.js';
// No request is made until this provider loads.
export const BING_METADATA_URL = 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN';
const BING_RECENT_METADATA_URL = BING_METADATA_URL.replace('&n=1&', '&n=8&');
const BING_ARCHIVE_METADATA_URL = BING_RECENT_METADATA_URL.replace('&idx=0&', '&idx=7&');
const BING_ORIGIN = 'https://www.bing.com';
const COMMONS_ORIGIN = 'https://upload.wikimedia.org';
const COMMONS_HEADERS = { 'Api-User-Agent': 'Covelet Wallpaper (https://github.com/MorleyZhou/Covelet)' };
const SOURCE_KEY = 'covelet.wallpaper.source.v1';
const INTERVAL_KEY = 'covelet.wallpaper.interval.v1';
export const WALLPAPER_SOURCES = Object.freeze([
  Object.freeze({ id: 'bing', label: 'Bing', origin: BING_ORIGIN }),
  Object.freeze({ id: 'commons', label: 'Wikimedia Commons', origin: COMMONS_ORIGIN,
    origins: Object.freeze([COMMONS_API_ORIGIN, COMMONS_ORIGIN]) }),
]);
export const WALLPAPER_INTERVALS = Object.freeze([
  ...[5, 10, 15, 30].map(amount => [amount, 'minute']),
  ...[1, 3, 6, 12].map(amount => [amount, 'hour']),
  ...[1, 3, 5, 10, 15].map(amount => [amount, 'day']),
  [1, 'month'],
].map(([amount, unit]) => Object.freeze({ id: `${amount}-${unit}`, amount, unit })));
export const DEFAULT_WALLPAPER_INTERVAL = '1-day';
const intervalsById = new Map(WALLPAPER_INTERVALS.map(interval => [interval.id, interval]));
// Keep the four pre-0.5.1 cached photos readable while new rotations use the API.
const LEGACY_COMMONS_IMAGES = [
  ['2/29', 'Moraine_lake_in_Banff_national_park.jpg', 'Moraine Lake', 'Bruno.menetrier'],
  ['7/75', 'Lake_Mountain_Landscape.jpg', 'Lake Mountain Landscape', 'Bonnie Moreland'],
  ['f/f4', 'Desert_dunes.jpg', 'Desert Dunes', 'Wikigab'],
  ['8/89', 'Yellowstone_National_Park_at_Sunset_-_Flickr_-_isteeves.jpg', 'Yellowstone at Sunset', 'Irene Steeves'],
].map(([directory, filename, title, copyright]) => ({
  imageUrl: `${COMMONS_ORIGIN}/wikipedia/commons/${directory}/${filename}`,
  title, copyright, copyrightUrl: `https://commons.wikimedia.org/wiki/File:${filename}`,
}));
const BUILTIN_URL = './assets/alpine-lake.png';
const CACHE_LOCK = 'owntab.bing-wallpaper.v1';
const MAX_METADATA = 64 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const RETRY_DELAY = 15 * 60 * 1000;
const CATALOG_AGE = 24 * 60 * 60 * 1000, MAX_CATALOG = 64, MAX_HISTORY = 256;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DAY = /^\d{8}$/;
const DEVELOPMENT = Boolean(import.meta.env?.DEV) && !globalThis.chrome?.runtime?.id;
const wallpaperRecords = createEncryptedStore('wallpaper');

export function migrateWallpaperCache() {
  return migrateLegacyIndexedDb('owntab.wallpaper.v1', 'daily', wallpaperRecords);
}

function validSource(source) {
  return WALLPAPER_SOURCES.some(({ id }) => id === source);
}

export async function loadWallpaperSource() {
  const source = (await localData.get(SOURCE_KEY))[SOURCE_KEY];
  return validSource(source) ? source : 'bing';
}

export async function saveWallpaperSource(source) {
  if (!validSource(source)) throw new TypeError('Invalid wallpaper source.');
  await localData.set({ [SOURCE_KEY]: source });
}

export function subscribeWallpaperSource(listener) {
  return localData.subscribe((changes) => {
    if (!changes[SOURCE_KEY]) return;
    const source = changes[SOURCE_KEY].newValue;
    listener(validSource(source) ? source : 'bing');
  });
}

const validInterval = (value) => intervalsById.has(value) ? value : DEFAULT_WALLPAPER_INTERVAL;
export async function loadWallpaperInterval() {
  return validInterval((await localData.get(INTERVAL_KEY))[INTERVAL_KEY]);
}

export async function saveWallpaperInterval(interval) {
  if (!intervalsById.has(interval)) throw new TypeError('Invalid wallpaper interval.');
  await localData.set({ [INTERVAL_KEY]: interval });
}

export function subscribeWallpaperInterval(listener) {
  return localData.subscribe((changes) => {
    if (changes[INTERVAL_KEY]) listener(validInterval(changes[INTERVAL_KEY].newValue));
  });
}

function expectedResponseUrl(actual, requested) {
  if (!actual || actual === requested) return true;
  if (!DEVELOPMENT || !globalThis.location) return false;
  const proxy = new URL(actual);
  const original = new URL(requested);
  return original.origin === BING_ORIGIN && proxy.origin === globalThis.location.origin && proxy.pathname === `/__bing${original.pathname}` && proxy.search === original.search && !proxy.hash;
}

function defaultFetch(url, options) {
  // The fixed development proxy only makes browser QA possible. This branch is
  // removed from the extension build; production requests Bing directly.
  const original = new URL(url);
  const target = DEVELOPMENT && original.origin === BING_ORIGIN ? `/__bing${original.pathname}${original.search}` : url;
  return globalThis.fetch(target, options);
}

async function defaultSourceAccess(origin) {
  if (origin === BING_ORIGIN) return true;
  try { return await globalThis.chrome?.permissions?.contains({ origins: [`${origin}/*`] }) === true; }
  catch { return false; }
}

function error(message) { throw new Error(message); }
function dayAt(time) {
  const value = new Date(time);
  return `${value.getFullYear()}${String(value.getMonth() + 1).padStart(2, '0')}${String(value.getDate()).padStart(2, '0')}`;
}
function startOfDay(day) {
  return new Date(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))).getTime();
}

function nextRotation(fetchedAt, { amount, unit }) {
  if (unit === 'minute') return fetchedAt + amount * 60_000;
  if (unit === 'hour') return fetchedAt + amount * 3_600_000;
  const date = new Date(fetchedAt);
  if (unit === 'day') return date.setDate(date.getDate() + amount);
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + amount);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return date.setDate(Math.min(originalDay, lastDay));
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

function bingMetadata(image) {
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

function bingImages(value) {
  if (!value || !Array.isArray(value.images) || value.images.length < 1 || value.images.length > 8) error(tr("Bing 每日图片数据无效。"));
  const images = [];
  for (const image of value.images) {
    try {
      const metadata = bingMetadata(image);
      if (!images.some(item => imageIdentity(item) === imageIdentity(metadata))) images.push(metadata);
    } catch { /* Ignore invalid archive entries. */ }
  }
  return images;
}

function imageIdentity(metadata) {
  const url = new URL(metadata.imageUrl);
  // Regional Bing ids can point to the same photograph with different digits.
  return url.origin === BING_ORIGIN
    ? url.searchParams.get('id').replace(/_[A-Z]{2}-[A-Z]{2}\d+(?=_1920x1080\.jpg$)/i, '')
    : url.href;
}

function chooseImage(images, record, random) {
  const current = record.metadata && imageIdentity(record.metadata);
  const alternatives = images.filter(image => imageIdentity(image) !== current);
  const history = new Set([...(record.history || []), ...(current ? [current] : [])]);
  const unseen = alternatives.filter(image => !history.has(imageIdentity(image)));
  const candidates = unseen.length ? unseen : alternatives;
  if (!candidates.length) return null;
  const index = Math.max(0, Math.min(candidates.length - 1, Math.floor(random() * candidates.length) || 0));
  return { metadata: candidates[index], history: unseen.length ? [...history] : [] };
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
          ...([COMMONS_ORIGIN, COMMONS_API_ORIGIN].includes(new URL(url).origin) && { headers: COMMONS_HEADERS }),
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
  async function cacheKey(source) {
    if (source !== 'bing') return source;
    await migrateWallpaperCache();
    return 'current';
  }
  return {
    async read(source) { return await wallpaperRecords.get(await cacheKey(source)) ?? null; },
    async write(value, options, source) { await wallpaperRecords.set(await cacheKey(source), value, options); },
  };
}

function cachedMetadata(value, source) {
  if (!value || !DAY.test(value.date)) return null;
  const { date, imageUrl, copyright, title, copyrightUrl } = value;
  if (source === 'bing') return bingMetadata({ startdate: date, enddate: date, url: imageUrl, copyright, title, copyrightlink: copyrightUrl });
  const legacy = LEGACY_COMMONS_IMAGES.find(image => image.imageUrl === imageUrl);
  return { ...(legacy || validateCommonsMetadata(value)), date };
}

async function validRecord(value, source) {
  if (!value || value.version !== 1 || !DAY.test(value.attemptDay) || !Number.isFinite(value.attemptAt)) return null;
  const result = { version: 1, attemptDay: value.attemptDay, attemptAt: value.attemptAt };
  if (Array.isArray(value.history) && value.history.length <= MAX_HISTORY
    && value.history.every(item => typeof item === 'string' && item.length > 0 && item.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(item))) {
    result.history = [...new Set(value.history)];
  }
  const catalog = value.catalog;
  if (catalog && Number.isSafeInteger(catalog.fetchedAt) && catalog.fetchedAt >= 0 && catalog.fetchedAt <= value.attemptAt
    && Array.isArray(catalog.images) && catalog.images.length <= MAX_CATALOG
    && (catalog.nextOffset === null || Number.isSafeInteger(catalog.nextOffset) && catalog.nextOffset > 0 && catalog.nextOffset <= 10000)) {
    const images = [];
    for (const item of catalog.images) {
      try {
        const metadata = cachedMetadata(item, source);
        if (metadata && !images.some(prior => imageIdentity(prior) === imageIdentity(metadata))) images.push(metadata);
      } catch { /* A bad candidate must never become a network target. */ }
    }
    if (images.length) result.catalog = { fetchedAt: catalog.fetchedAt, images, nextOffset: catalog.nextOffset };
  }
  if (value.blob instanceof Blob && value.blob.size > 0 && value.blob.size <= MAX_IMAGE && IMAGE_TYPES.has(value.blob.type) && DAY.test(value.fetchedDay) && value.metadata) {
    try {
      const metadata = cachedMetadata(value.metadata, source);
      if (!metadata) return result;
      dimensions(new Uint8Array(await value.blob.arrayBuffer()), value.blob.type);
      const { fetchedAt, fetchedDay } = value;
      const lastFetchedAt = Number.isSafeInteger(fetchedAt) && fetchedAt >= 0 && fetchedAt <= value.attemptAt ? fetchedAt
        : dayAt(value.attemptAt) === fetchedDay ? value.attemptAt : startOfDay(fetchedDay);
      return { ...result, blob: value.blob, fetchedDay, fetchedAt: lastFetchedAt, metadata };
    } catch { /* Keep the throttle record but discard invalid cached bytes. */ }
  }
  return result;
}

export function createWallpaperProvider({
  fetcher = defaultFetch,
  cache = createCache(), now = () => Date.now(),
  hasSourceAccess = defaultSourceAccess, random = Math.random,
  extension = Boolean(globalThis.chrome?.runtime?.id) || DEVELOPMENT,
  locks = globalThis.navigator?.locks, timeoutMs = 12000,
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
  decode = globalThis.createImageBitmap ? (blob) => globalThis.createImageBitmap(blob) : null,
} = {}) {
  const states = new Map();
  let revision = 0;
  const ownedUrls = new Set();
  const fallback = (message = '', nextRefreshAt = Number(now()) + RETRY_DELAY) => ({ url: BUILTIN_URL, title: tr('内置背景'), copyright: '', copyrightUrl: '', stale: false, source: 'builtin', status: 'fallback', message, nextRefreshAt });
  async function read(source, state, started) {
    let stored;
    try { stored = await validRecord(await cache.read(source), source); } catch { stored = null; }
    if (started !== revision) return null;
    if (stored && (!state.unpersisted || stored.attemptAt > state.record?.attemptAt)) state.record = stored;
    return state.record;
  }
  async function write(record, source, state, started, requirePersistence = false) {
    if (started !== revision) return false;
    const previous = state.record;
    state.record = record;
    try { await cache.write(record, { shouldWrite: () => started === revision }, source); state.unpersisted = false; }
    catch {
      state.unpersisted = true;
      if (requirePersistence) { state.record = previous; return false; }
    }
    return started === revision;
  }
  async function loadCatalog(source, record, timestamp) {
    const prior = record.catalog;
    const fresh = prior && prior.fetchedAt <= timestamp && timestamp - prior.fetchedAt < CATALOG_AGE
      && (source !== 'bing' || dayAt(prior.fetchedAt) === dayAt(timestamp));
    const seen = new Set([...(record.history || []), ...(record.metadata ? [imageIdentity(record.metadata)] : [])]);
    if (fresh && (source === 'bing' || prior.images.some(image => !seen.has(imageIdentity(image))))) return prior;
    if (source === 'bing') {
      const getImages = async url => {
        const response = await request(fetcher, url, MAX_METADATA, timeoutMs, mime => mime === 'application/json');
        return bingImages(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)));
      };
      const images = await getImages(BING_RECENT_METADATA_URL);
      try {
        for (const image of await getImages(BING_ARCHIVE_METADATA_URL)) {
          if (!images.some(prior => imageIdentity(prior) === imageIdentity(image))) images.push(image);
        }
      } catch { /* The current archive is still usable if its older page fails. */ }
      return { images, fetchedAt: timestamp, nextOffset: null };
    }
    let offset = prior?.nextOffset ?? 0;
    const images = [];
    let nextOffset;
    // The API can return ineligible sizes or licenses. Advance a bounded number
    // of pages instead of silently falling back to the old four bundled links.
    for (let page = 0; page < 3; page++) {
      const response = await request(fetcher, commonsCatalogUrl(offset), 4 * MAX_METADATA, timeoutMs, mime => mime === 'application/json');
      const parsed = parseCommonsCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)));
      nextOffset = parsed.nextOffset;
      for (const image of parsed.images) {
        const metadata = { ...image, date: dayAt(timestamp) };
        if (!images.some(prior => imageIdentity(prior) === imageIdentity(metadata))) images.push(metadata);
      }
      if (images.some(image => !seen.has(imageIdentity(image))) || nextOffset === null || nextOffset <= offset) break;
      offset = nextOffset;
    }
    return { images: images.slice(-MAX_CATALOG), fetchedAt: timestamp, nextOffset };
  }
  async function refresh({ id: source, origin, origins = [origin] }, state, started, force, interval) {
    if (started !== revision) return {};
    const timestamp = Number(now());
    const today = dayAt(timestamp);
    let record = await read(source, state, started);
    if (started !== revision) return {};
    const nextRefreshAt = interval && record?.blob && record.fetchedAt <= timestamp ? nextRotation(record.fetchedAt, interval) : timestamp;
    const current = interval ? nextRefreshAt > timestamp : record?.fetchedDay === today && record.blob;
    if (!force && current) return { record, status: 'cached', nextRefreshAt, message: tr("正在使用今日缓存。") };
    const retryAt = record?.attemptAt + RETRY_DELAY;
    // Failed updates have a separate cooldown. Successful rotations may run
    // every five minutes without bypassing the retry throttle on failures.
    const coolingDown = interval ? record?.attemptAt <= timestamp && record.attemptAt !== record.fetchedAt && retryAt > timestamp
      : record?.attemptDay === today && timestamp - record.attemptAt < RETRY_DELAY;
    if (!force && coolingDown) return { record, status: record.blob ? 'stale' : 'fallback', nextRefreshAt: retryAt, message: tr("今日背景暂不可用；15 分钟后打开或返回页面时重试。") };
    const unavailable = () => ({ record, status: record?.blob ? 'stale' : 'fallback', nextRefreshAt: timestamp + RETRY_DELAY,
      message: record?.blob ? tr("今日背景暂不可用，继续显示上次缓存。") : tr("今日背景暂不可用，已使用内置背景。") });
    try {
      for (const required of origins) if (!await hasSourceAccess(required)) return unavailable();
      record = { ...record, version: 1, attemptDay: today, attemptAt: timestamp };
      if (!await write(record, source, state, started)) return {};
      let selection, catalog;
      if (source === 'bing' && !force && !(interval && record.blob)) {
        const metadataResponse = await request(fetcher, BING_METADATA_URL, MAX_METADATA, timeoutMs, mime => mime === 'application/json');
        const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataResponse.bytes));
        if (!Array.isArray(data?.images) || data.images.length < 1 || data.images.length > 8) return unavailable();
        selection = { metadata: bingMetadata(data.images[0]), history: record.history || [] };
      } else {
        catalog = await loadCatalog(source, record, timestamp);
        selection = chooseImage(catalog.images, record, random);
        if (!selection) return unavailable();
      }
      const { metadata } = selection;
      if (started !== revision) return {};
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
      const nextRecord = { ...record, blob, metadata, fetchedDay: today, fetchedAt: timestamp,
        ...(catalog && { catalog }), history: [...new Set([...selection.history, imageIdentity(metadata)])].slice(-MAX_HISTORY) };
      if (!await write(nextRecord, source, state, started, true)) return started === revision ? unavailable() : {};
      record = nextRecord;
      return { record, status: 'fresh', nextRefreshAt: interval ? nextRotation(timestamp, interval) : undefined, message: tr("今日壁纸已更新。") };
    } catch { return unavailable(); }
  }
  return {
    // Existing rendered URLs remain owned until the caller disposes them.
    // A sync import only discards stale record/flight references in memory.
    invalidate() { revision++; states.clear(); },
    async load({ source = 'bing', force = false, cachedOnly = false, interval: intervalId } = {}) {
      if (!extension) return fallback(tr('Bing 每日背景需要加载浏览器扩展后获取，网页预览使用内置背景。'));
      const provider = WALLPAPER_SOURCES.find(({ id }) => id === source);
      if (!provider) return fallback();
      const started = revision;
      if (!states.has(source)) states.set(source, {});
      const state = states.get(source);
      const interval = intervalsById.get(intervalId);
      let result;
      if (cachedOnly) {
        result = { record: await read(source, state, started), status: 'cached' };
      } else {
        // A manual shuffle or a change in cadence must be checked after the
        // in-flight read finishes under the source lock.
        if (state.pending && (force && !state.pending.force || state.pending.interval !== interval)) await state.pending.work;
        if (started !== revision) return fallback();
        if (!state.pending) {
          const run = () => refresh(provider, state, started, force, interval);
          const lock = source === 'bing' ? CACHE_LOCK : `${CACHE_LOCK}.${source}`;
          const work = (locks?.request ? locks.request(lock, { mode: 'exclusive' }, run) : run()).finally(() => { state.pending = null; });
          state.pending = { work, force, interval };
        }
        result = await state.pending.work;
      }
      const { record, status, message = '', nextRefreshAt } = result;
      if (started !== revision) return fallback();
      if (!record?.blob) return fallback(message, nextRefreshAt);
      const url = createObjectURL(record.blob);
      ownedUrls.add(url);
      return { ...record.metadata, url, stale: status === 'stale', source, status, message, nextRefreshAt };
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
