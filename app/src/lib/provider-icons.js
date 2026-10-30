import { tr, getLocale } from "../i18n/index.js";
import { canReadSite, readSiteInfo, siteOrigin, validateIconBytes } from './site-info.js';
import { readBrowserFavicon } from './browser-favicon.js';
import { createEncryptedStore } from './local-data.js';
import { migrateLegacyIndexedDb } from './legacy-indexed-data.js';
import { subscribeSyncedData } from './use-synced-data.js';

const DATABASE = 'owntab.provider-icons.v1';
const STORE = 'icons';
const MAX_CACHED_ORIGINS = 32;
const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const providerIconRecords = createEncryptedStore('provider-icons');
const CACHE_LOCK = 'covelet.provider-icons.cache.v1';
let cacheWrites = Promise.resolve();

export function migrateProviderIconCache() {
  return migrateLegacyIndexedDb(DATABASE, STORE, providerIconRecords, (record, key) => record?.origin || key);
}

// Provider images keep their own namespace and join full encrypted sync.
function encryptedProviderIcons() {
  return {
    async get(origin) {
      await migrateProviderIconCache();
      return (await providerIconRecords.get(origin))?.blob ?? null;
    },
    async set(origin, blob, { shouldWrite = () => true } = {}) {
      await migrateProviderIconCache();
      const write = async () => {
        if (!shouldWrite()) return;
        await providerIconRecords.set(origin, { origin, blob, updatedAt: Date.now() }, { shouldWrite });
        if (!shouldWrite()) return;
        const records = (await providerIconRecords.entries()).sort(([keyA, a], [keyB, b]) =>
          (Number(a?.updatedAt) || 0) - (Number(b?.updatedAt) || 0) || keyA.localeCompare(keyB));
        for (const [key] of records.slice(0, Math.max(0, records.length - MAX_CACHED_ORIGINS))) {
          if (!shouldWrite()) return;
          await providerIconRecords.remove(key);
        }
      };
      if (globalThis.navigator?.locks?.request) return navigator.locks.request(CACHE_LOCK, { mode: 'exclusive' }, write);
      const work = cacheWrites.then(write, write);
      cacheWrites = work.catch(() => {});
      return work;
    },
  };
}

async function validatedRaster(blob) {
  if (!(blob instanceof Blob) || !RASTER_MIMES.has(blob.type) || !blob.size || blob.size > 1024 * 1024) return null;
  validateIconBytes(new Uint8Array(await blob.arrayBuffer()), blob.type);
  return blob;
}

export function createProviderIconCache({ cacheStore = encryptedProviderIcons(), api, fetcher, timeoutMs, convert, browserIcon = readBrowserFavicon } = {}) {
  const inFlight = new Map();
  const session = new Map();
  let revision = 0;
  const remember = (origin, blob) => {
    session.delete(origin);
    session.set(origin, blob);
    while (session.size > MAX_CACHED_ORIGINS) session.delete(session.keys().next().value);
    return blob;
  };
  async function readCached(input) {
    const started = revision;
    try {
      const origin = siteOrigin(input);
      if (session.has(origin)) return remember(origin, session.get(origin));
      const blob = await validatedRaster(await cacheStore.get(origin));
      return started === revision && blob ? remember(origin, blob) : null;
    } catch { return null; }
  }
  return {
    // Active image URLs belong to their rendering hooks, which release them
    // only after switching to the imported bytes. Invalidation touches no disk.
    invalidate() { revision++; session.clear(); inFlight.clear(); },
    // Rendering an existing engine must never request permission or start a
    // network request, even if its icon has not been cached on this device.
    readCached,
    // Cache first, then the browser's local favicon resource. Saving an engine
    // never asks for host access; only already-granted origins may be fetched.
    fetchForSave(input) {
      let origin;
      try { origin = siteOrigin(input); } catch { return Promise.resolve(null); }
      if (inFlight.has(origin)) return inFlight.get(origin);
      const started = revision;
      const work = (async () => {
          const cached = await readCached(origin);
          if (started !== revision) return null;
          if (cached) return cached;
          let icon;
          try { icon = await browserIcon(origin, { api, fetcher, timeoutMs, convert }); } catch { /* Try an existing site grant. */ }
          if (started !== revision) return null;
          if (!icon && await canReadSite(origin, { api })) {
            const result = await readSiteInfo(origin, { api, fetcher, timeoutMs, convert });
            icon = result.icon;
          }
          const blob = await validatedRaster(icon);
          if (started !== revision) return null;
          if (!blob) return null;
          // Keep the current session usable even when IndexedDB is full or
          // unavailable; subsequent rendering still remains entirely offline.
          remember(origin, blob);
          try { await cacheStore.set(origin, blob, { shouldWrite: () => started === revision }); }
          catch { /* A local cache failure must not block saving the engine. */ }
          return started === revision ? blob : null;
      })().catch(() => null).finally(() => { if (inFlight.get(origin) === work) inFlight.delete(origin); });
      inFlight.set(origin, work);
      return work;
    },
  };
}

const providerIcons = createProviderIconCache();
subscribeSyncedData(() => providerIcons.invalidate());
export const readCachedProviderIcon = (input) => providerIcons.readCached(input);
export const fetchProviderIconForSave = (input) => providerIcons.fetchForSave(input);
