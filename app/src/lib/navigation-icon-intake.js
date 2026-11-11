import { normalizeIconAddress, siteIconAddress, faviconAddress } from './site-icons.js';
import { readCachedNavigationIcon, navigationIcon, cacheNavigationIconBlob } from './navigation-icon-cache.js';
import { readBrowserFavicon } from './browser-favicon.js';
import { getSyncedDataRevision } from './use-synced-data.js';
import { navigationResourceEntries } from './navigation-resources.js';

// This describes only declared artwork, never website HTML or speculative
// icon candidates. The same URL shared by tiles/themes is acquired once.
export function navigationIconSources(state, { includeTrash = false } = {}) {
  const sources = new Map();
  for (const entry of includeTrash ? navigationResourceEntries(state) : state?.entries || []) {
    if (entry.type !== 'site' || entry.icon?.kind === 'image') continue;
    for (const input of [siteIconAddress(entry), entry.iconVariants?.light?.url, entry.iconVariants?.dark?.url]) {
      let source;
      try { source = normalizeIconAddress(input); } catch { continue; }
      if (!sources.has(source)) sources.set(source, { source, entryId: entry.id, pageUrl: entry.url,
        conventional: source === faviconAddress(entry.url) });
    }
  }
  return [...sources.values()];
}

// Must be invoked directly by a user click, before any asynchronous reads.
// Only failed image origins are requested, using existing optional grants.
export function requestNavigationIconAccess(sources, api = globalThis.chrome) {
  const origins = [...new Set((sources || []).map(({ source }) => {
    try {
      const url = new URL(normalizeIconAddress(source));
      return url.hostname.includes('*') ? '' : `${url.origin}/*`;
    } catch { return ''; }
  }).filter(Boolean))];
  if (!origins.length) return Promise.resolve(true);
  if (!api?.permissions?.request) return Promise.resolve(false);
  try { return Promise.resolve(api.permissions.request({ origins })).catch(() => false); }
  catch { return Promise.resolve(false); }
}

export function createNavigationIconIntake({ read = readCachedNavigationIcon, fetch: fetchIcon = navigationIcon,
  native = readBrowserFavicon, store = cacheNavigationIconBlob, concurrency = 3 } = {}) {
  const width = Math.max(1, Math.min(3, Math.floor(concurrency) || 3));
  async function missing(state) {
    const result = [];
    // Bound encrypted reads as well as network work for large bookmark files.
    const sources = navigationIconSources(state); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(width, sources.length) }, async () => {
      while (cursor < sources.length) {
        const descriptor = sources[cursor++];
        if (!await read(descriptor.source).catch(() => null)) result.push(descriptor);
      }
    }));
    return result;
  }
  async function prepare(state, { onIconProgress, isCurrent = () => true, sourceUrls } = {}) {
    const selected = sourceUrls ? new Set(sourceUrls) : null;
    const revision = getSyncedDataRevision(), sources = navigationIconSources(state).filter(({ source }) => !selected || selected.has(source));
    const report = { total: sources.length, completed: 0, cached: 0, downloaded: 0, native: 0, failed: 0, missing: [], cancelled: false };
    const current = () => revision === getSyncedDataRevision() && isCurrent();
    const progress = () => { try { onIconProgress?.({ ...report, missing: [...report.missing] }); } catch { /* Observers cannot break restoration. */ } };
    let cursor = 0;
    progress();
    await Promise.all(Array.from({ length: Math.min(width, sources.length) }, async () => {
      while (cursor < sources.length && current()) {
        const descriptor = sources[cursor++]; let kind = '';
        try {
          if (await read(descriptor.source).catch(() => null)) kind = 'cached';
          if (!kind && current() && descriptor.conventional) {
            const blob = await native(descriptor.pageUrl).catch(() => null);
            if (blob && current() && await store(descriptor.source, blob).catch(() => null)) kind = 'native';
          }
          if (!kind && current() && await fetchIcon(descriptor.source, { force: true })) kind = 'downloaded';
        } catch { /* One bad image must not discard the other imported records. */ }
        if (!current()) { report.cancelled = true; break; }
        if (kind) report[kind]++;
        else { report.failed++; report.missing.push(descriptor); }
        report.completed++; progress();
      }
    }));
    if (!current()) report.cancelled = true;
    return report;
  }
  return { prepare, missing, requestAccess: requestNavigationIconAccess };
}

const intake = createNavigationIconIntake();
export const prepareImportedNavigationIcons = intake.prepare;
export const missingNavigationIcons = intake.missing;
