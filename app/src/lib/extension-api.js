// Firefox keeps its chrome namespace callback-compatible. Promise consumers
// use Firefox's native browser namespace; Chromium keeps its existing API.
// Do not replace the global chrome object: migration and sync adapters still
// deliberately use callbacks and runtime.lastError.
export function getExtensionApi(environment = globalThis) {
  try {
    const api = environment.browser;
    if (api?.runtime?.id && new URL(api.runtime.getURL('')).protocol === 'moz-extension:') return api;
  } catch { /* A web preview or malformed API has no Firefox runtime. */ }
  return environment.chrome;
}

export function extensionRoot(api = getExtensionApi()) {
  try {
    if (!api?.runtime?.id || typeof api.runtime.getURL !== 'function') return null;
    const root = new URL(api.runtime.getURL(''));
    if (!['chrome-extension:', 'moz-extension:'].includes(root.protocol) || !root.host || root.username || root.password
      || root.pathname !== '/' || root.search || root.hash) return null;
    if (root.protocol === 'chrome-extension:' && root.host !== api.runtime.id) return null;
    return root;
  } catch { return null; }
}

export function extensionOrigin(api = getExtensionApi()) {
  const root = extensionRoot(api);
  // URL.origin can be "null" for extension schemes in non-browser runtimes.
  return root ? `${root.protocol}//${root.host}` : '';
}
