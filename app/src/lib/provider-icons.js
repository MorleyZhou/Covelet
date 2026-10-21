import { tr, getLocale } from "../i18n/index.js";
import { canReadSite, readSiteInfo, siteOrigin, validateIconBytes } from './site-info.js';
import { readBrowserFavicon } from './browser-favicon.js';

const DATABASE = 'owntab.provider-icons.v1';
const STORE = 'icons';
const MAX_CACHED_ORIGINS = 32;
const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// This cache is deliberately separate from configuration and navigation assets:
// neither browser sync nor ZIP backups include search-provider image bytes.
function indexedProviderIcons() {
  let opening;
  const open = () => opening ??= new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error(tr("本地图标缓存不可用。"))); return; }
    const request = globalThis.indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'origin' });
    request.onerror = () => reject(request.error || new Error(tr("无法打开本地图标缓存。")));
    request.onblocked = () => reject(new Error(tr("本地图标缓存暂不可用。")));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); opening = undefined; };
      resolve(database);
    };
  }).catch((cause) => { opening = undefined; throw cause; });
  return {
    async get(origin) {
      const database = await open();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).get(origin);
        transaction.oncomplete = () => resolve(request.result?.blob ?? null);
        transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error(tr("无法读取本地图标缓存。")));
      });
    },
    async set(origin, blob) {
      const database = await open();
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readwrite');
        const store = transaction.objectStore(STORE);
        store.put({ origin, blob, updatedAt: Date.now() });
        const request = store.getAll();
        request.onsuccess = () => {
          const records = request.result.sort((a, b) => a.updatedAt - b.updatedAt || a.origin.localeCompare(b.origin));
          for (const record of records.slice(0, Math.max(0, records.length - MAX_CACHED_ORIGINS))) store.delete(record.origin);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error(tr("无法保存本地图标缓存。")));
      });
    },
  };
}

async function validatedRaster(blob) {
  if (!(blob instanceof Blob) || !RASTER_MIMES.has(blob.type) || !blob.size || blob.size > 1024 * 1024) return null;
  validateIconBytes(new Uint8Array(await blob.arrayBuffer()), blob.type);
  return blob;
}

export function createProviderIconCache({ cacheStore = indexedProviderIcons(), api, fetcher, timeoutMs, convert, browserIcon = readBrowserFavicon } = {}) {
  const inFlight = new Map();
  const session = new Map();
  const remember = (origin, blob) => {
    session.delete(origin);
    session.set(origin, blob);
    while (session.size > MAX_CACHED_ORIGINS) session.delete(session.keys().next().value);
    return blob;
  };
  async function readCached(input) {
    try {
      const origin = siteOrigin(input);
      if (session.has(origin)) return remember(origin, session.get(origin));
      const blob = await validatedRaster(await cacheStore.get(origin));
      return blob ? remember(origin, blob) : null;
    } catch { return null; }
  }
  return {
    // Rendering an existing engine must never request permission or start a
    // network request, even if its icon has not been cached on this device.
    readCached,
    // Cache first, then the browser's local favicon resource. Saving an engine
    // never asks for host access; only already-granted origins may be fetched.
    fetchForSave(input) {
      let origin;
      try { origin = siteOrigin(input); } catch { return Promise.resolve(null); }
      if (inFlight.has(origin)) return inFlight.get(origin);
      const work = (async () => {
          const cached = await readCached(origin);
          if (cached) return cached;
          let icon;
          try { icon = await browserIcon(origin, { api, fetcher, timeoutMs, convert }); } catch { /* Try an existing site grant. */ }
          if (!icon && await canReadSite(origin, { api })) {
            const result = await readSiteInfo(origin, { api, fetcher, timeoutMs, convert });
            icon = result.icon;
          }
          const blob = await validatedRaster(icon);
          if (!blob) return null;
          // Keep the current session usable even when IndexedDB is full or
          // unavailable; subsequent rendering still remains entirely offline.
          remember(origin, blob);
          try { await cacheStore.set(origin, blob); }
          catch { /* A local cache failure must not block saving the engine. */ }
          return blob;
      })().catch(() => null).finally(() => { inFlight.delete(origin); });
      inFlight.set(origin, work);
      return work;
    },
  };
}

const providerIcons = createProviderIconCache();
export const readCachedProviderIcon = (input) => providerIcons.readCached(input);
export const fetchProviderIconForSave = (input) => providerIcons.fetchForSave(input);
