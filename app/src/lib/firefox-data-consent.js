import { tr } from '../i18n/index.js';
import { extensionRoot, getExtensionApi } from './extension-api.js';

// These declarations describe user-directed transmission, not telemetry.
// Keep the Firefox manifest list in scripts/extension-target.mjs identical.
export const FIREFOX_DATA_COLLECTION_TYPES = Object.freeze([
  'searchTerms', 'browsingActivity', 'websiteContent', 'authenticationInfo',
  'personallyIdentifyingInfo', 'technicalAndInteraction',
]);
export const FIREFOX_DATA_PURPOSES = Object.freeze({
  search: Object.freeze(['searchTerms']),
  site: Object.freeze(['browsingActivity', 'websiteContent']),
  reading: Object.freeze(['browsingActivity', 'websiteContent']),
  rss: Object.freeze(['browsingActivity', 'websiteContent']),
  cloud: Object.freeze(['browsingActivity', 'websiteContent', 'authenticationInfo', 'personallyIdentifyingInfo', 'technicalAndInteraction']),
  github: Object.freeze(['personallyIdentifyingInfo']),
  wallpaper: Object.freeze(['websiteContent']),
});
const known = new Set(FIREFOX_DATA_COLLECTION_TYPES);
function typesFor(purposeOrTypes) {
  const values = typeof purposeOrTypes === 'string' ? FIREFOX_DATA_PURPOSES[purposeOrTypes] : purposeOrTypes;
  if (!Array.isArray(values) || !values.length || values.some(value => !known.has(value))) throw new TypeError('Invalid data consent purpose.');
  return [...new Set(values)];
}
export function isFirefoxDataConsentRuntime({ api = getExtensionApi(), location = globalThis.location } = {}) {
  return extensionRoot(api)?.protocol === 'moz-extension:' || location?.protocol === 'moz-extension:';
}
function denied() {
  return Object.assign(new Error(tr('请先在隐私检查中允许此功能联网。')), { code: 'FIREFOX_DATA_CONSENT_REQUIRED' });
}
export async function getFirefoxDataConsent({ api = getExtensionApi() } = {}) {
  const firefox = isFirefoxDataConsentRuntime({ api });
  if (!firefox) return { firefox: false, supported: false, granted: [], missing: [] };
  try {
    const permissions = await api?.permissions?.getAll?.();
    if (!Array.isArray(permissions?.data_collection)) throw denied();
    const granted = FIREFOX_DATA_COLLECTION_TYPES.filter(type => permissions.data_collection.includes(type));
    return { firefox: true, supported: true, granted, missing: FIREFOX_DATA_COLLECTION_TYPES.filter(type => !granted.includes(type)) };
  } catch {
    return { firefox: true, supported: false, granted: [], missing: [...FIREFOX_DATA_COLLECTION_TYPES] };
  }
}
export async function hasFirefoxDataConsent(purposeOrTypes, options = {}) {
  const required = typesFor(purposeOrTypes), state = await getFirefoxDataConsent(options);
  return !state.firefox || state.supported && required.every(type => state.granted.includes(type));
}
export async function requireFirefoxDataConsent(purposeOrTypes, options = {}) {
  if (!await hasFirefoxDataConsent(purposeOrTypes, options)) throw denied();
}
// Call directly from a user-activated event. Never prompt from a fetch, timer,
// alarm, effect or service worker: those paths only check the current grant.
export function requestFirefoxDataConsent(purposeOrTypes, { api = getExtensionApi() } = {}) {
  const data_collection = typesFor(purposeOrTypes);
  if (!isFirefoxDataConsentRuntime({ api })) return Promise.resolve(true);
  if (typeof api?.permissions?.request !== 'function' || typeof api?.permissions?.getAll !== 'function') return Promise.resolve(false);
  try {
    // No asynchronous work precedes request(), preserving Firefox's gesture.
    return Promise.resolve(api.permissions.request({ data_collection })).then(granted => granted === true
      ? hasFirefoxDataConsent(data_collection, { api }) : false, () => false);
  } catch { return Promise.resolve(false); }
}
export function subscribeFirefoxDataConsent(listener, { api = getExtensionApi() } = {}) {
  if (typeof listener !== 'function') throw new TypeError('Invalid consent listener.');
  if (!isFirefoxDataConsentRuntime({ api })) return () => {};
  const changed = () => listener();
  api?.permissions?.onAdded?.addListener?.(changed);
  api?.permissions?.onRemoved?.addListener?.(changed);
  return () => {
    api?.permissions?.onAdded?.removeListener?.(changed);
    api?.permissions?.onRemoved?.removeListener?.(changed);
  };
}
function networkUrl(input, api) {
  try {
    const value = typeof input === 'string' || input instanceof URL ? input : input?.url;
    return new URL(value, globalThis.location?.href || extensionRoot(api)?.href);
  } catch { throw denied(); }
}
export async function fetchWithFirefoxDataConsent(purpose, input, init, { api = getExtensionApi(), fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  if (isFirefoxDataConsentRuntime({ api })) {
    const url = networkUrl(input, api);
    if (['http:', 'https:'].includes(url.protocol)) {
      const required = typesFor(purpose), controller = new AbortController();
      const abort = () => controller.abort();
      const removed = change => {
        if (change?.data_collection?.some(type => required.includes(type))) abort();
      };
      const signals = [init?.signal, input?.signal].filter(Boolean);
      for (const signal of signals) {
        if (signal.aborted) abort();
        signal.addEventListener('abort', abort, { once: true });
      }
      api?.permissions?.onRemoved?.addListener?.(removed);
      try {
        await requireFirefoxDataConsent(required, { api });
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        return await fetchImpl(input, { ...init, signal: controller.signal });
      } finally {
        api?.permissions?.onRemoved?.removeListener?.(removed);
        for (const signal of signals) signal.removeEventListener('abort', abort);
      }
    }
    if (!['moz-extension:', 'blob:', 'data:'].includes(url.protocol)) throw denied();
    if (init?.signal?.aborted || input?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
  return fetchImpl(input, init);
}
