import { tr } from '../i18n/index.js';
import { getExtensionApi } from './extension-api.js';

export const BROWSER_COMMAND_LIMITS = Object.freeze({ results: 30, currentWindowTabs: 500, openTabs: 10000, queryLength: 2000 });
const sources = { tabs: 'tabs', history: 'history', bookmarks: 'bookmarks' };
const messages = {
  BROWSER_UNAVAILABLE: '此浏览器无法提供这项功能。', BROWSER_PERMISSION: '请先授权读取此浏览器来源。',
  BROWSER_PRIVATE_WINDOW: '无法在无痕或非普通窗口中使用此功能。', BROWSER_TAB_CHANGED: '标签页已变化，请刷新结果后重试。',
  BROWSER_COMMAND_FAILED: '浏览器操作未完成，请重试。', BROWSER_COMMAND_LIMIT: '浏览器条目超过容量上限，请减少条目后重试。',
  BROWSER_COMMAND_INVALID: '浏览器条目无效，请刷新后重试。',
};
const fail = code => { throw Object.assign(Error(tr(messages[code])), { code }); };
const identity = value => Number.isSafeInteger(value) && value >= 0;
const aborted = signal => { if (signal?.aborted) throw new DOMException('Browser command cancelled.', 'AbortError'); };
const title = (value, fallback) => typeof value === 'string' && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 1000) : fallback;
export function browserCommandUrl(input) {
  if (typeof input !== 'string' || input.length > 4096 || /[\s\u0000-\u001f\u007f\\]/u.test(input)) return null;
  try { const url = new URL(input); return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
const sourceOf = source => { if (!Object.hasOwn(sources, source)) fail('BROWSER_COMMAND_INVALID'); return sources[source]; };
const effectiveUrl = tab => browserCommandUrl(tab.pendingUrl || tab.url);

// Browser metadata stays transient: no persistence, icons, page contents,
// resource retrieval, periodic work or permission prompt occurs during search.
export function createBrowserCommands({ api = getExtensionApi() } = {}) {
  const issuedTabs = new WeakMap(), issuedLinks = new WeakSet();
  const privateContext = () => { if (api?.extension?.inIncognitoContext) fail('BROWSER_PRIVATE_WINDOW'); };
  function available(source) {
    const permission = sourceOf(source); let declared = false;
    try { const manifest = api?.runtime?.getManifest?.(); declared = [...(manifest?.permissions || []), ...(manifest?.optional_permissions || [])].includes(permission); } catch { /* Unknown environments must expose the actual API. */ }
    // Chrome hides history/bookmarks bindings until an optional grant. The
    // declared permission must still expose the dedicated authorization button.
    return Boolean(api?.runtime?.id && api.permissions?.contains && api.permissions?.request
      && (permission === 'tabs' ? api.tabs?.query && api.tabs?.get && api.windows?.getCurrent : api[permission]?.search || declared));
  }
  async function operation(action) {
    try { return await action(); }
    catch (error) { if (error?.name === 'AbortError' || Object.hasOwn(messages, error?.code)) throw error; fail('BROWSER_COMMAND_FAILED'); }
  }
  async function permissions(source) {
    const permission = sourceOf(source); privateContext();
    if (!available(source)) return { available: false, granted: false, permission };
    return operation(async () => ({ available: true, granted: await api.permissions.contains({ permissions: [permission] }) === true, permission }));
  }
  async function requirePermission(source, signal) {
    aborted(signal); const status = await permissions(source); aborted(signal);
    if (!status.available) fail('BROWSER_UNAVAILABLE'); if (!status.granted) fail('BROWSER_PERMISSION');
  }
  function checkedWindow(window) {
    if (!identity(window?.id) || typeof window.incognito !== 'boolean') fail('BROWSER_COMMAND_INVALID');
    if (window.incognito || window.type !== 'normal') fail('BROWSER_PRIVATE_WINDOW');
    return { id: window.id, incognito: false, type: 'normal' };
  }
  async function currentWindow() {
    privateContext(); if (!api?.runtime?.id || !api.windows?.getCurrent) fail('BROWSER_UNAVAILABLE');
    return operation(async () => checkedWindow(await api.windows.getCurrent()));
  }
  function tabsOf(raw, maximum, windowId, rejectPending = false) {
    if (!Array.isArray(raw)) fail('BROWSER_COMMAND_INVALID'); if (raw.length > maximum) fail('BROWSER_COMMAND_LIMIT');
    const ids = new Set(), result = [];
    for (const tab of raw) {
      if (!identity(tab?.id) || !identity(tab.windowId) || ids.has(tab.id) || typeof tab.incognito !== 'boolean' || windowId !== undefined && tab.windowId !== windowId) fail('BROWSER_COMMAND_INVALID');
      ids.add(tab.id);
      if (windowId !== undefined && tab.incognito) fail('BROWSER_PRIVATE_WINDOW');
      if (tab.incognito) continue;
      if (rejectPending && tab.pendingUrl && tab.pendingUrl !== tab.url) fail('BROWSER_TAB_CHANGED');
      const url = effectiveUrl(tab); if (!url) continue;
      result.push({ id: tab.id, windowId: tab.windowId, url, title: title(tab.title, url), pinned: tab.pinned === true, incognito: false,
        index: Number.isSafeInteger(tab.index) && tab.index >= 0 ? tab.index : result.length });
    }
    return result;
  }
  async function capture(options = {}) {
    await requirePermission('tabs', options.signal); const window = await currentWindow(); aborted(options.signal);
    return operation(async () => {
      const raw = await api.tabs.query({ windowId: window.id }); aborted(options.signal);
      const tabs = tabsOf(raw, BROWSER_COMMAND_LIMITS.currentWindowTabs, window.id, true).sort((a, b) => a.index - b.index);
      const tabIds = [...raw].sort((a, b) => (a.index ?? a.id) - (b.index ?? b.id)).map(tab => tab.id);
      return { window, tabs, rawCount: raw.length, excludedCount: raw.length - tabs.length, tabIds };
    });
  }
  async function openTabs(options = {}) {
    await requirePermission('tabs', options.signal); await currentWindow(); aborted(options.signal);
    return operation(async () => { const raw = await api.tabs.query({ windowType: 'normal' }); aborted(options.signal); return tabsOf(raw, BROWSER_COMMAND_LIMITS.openTabs); });
  }
  async function search(source, query, { signal } = {}) {
    sourceOf(source); aborted(signal); privateContext();
    if (typeof query !== 'string' || query.length > BROWSER_COMMAND_LIMITS.queryLength) fail('BROWSER_COMMAND_INVALID');
    const text = query.trim(); if (source !== 'tabs' && !text) return [];
    await requirePermission(source, signal); await currentWindow(); aborted(signal);
    return operation(async () => {
      if (source === 'tabs') {
        const raw = await api.tabs.query({ windowType: 'normal' }); aborted(signal); tabsOf(raw, BROWSER_COMMAND_LIMITS.openTabs);
        const terms = text.normalize('NFKC').toLocaleLowerCase().split(/\s+/u).filter(Boolean), rows = [];
        for (const tab of raw) {
          if (tab.incognito) continue; const url = effectiveUrl(tab); if (!url) continue;
          const name = title(tab.title, url), haystack = `${name}\n${url}`.normalize('NFKC').toLocaleLowerCase();
          if (!terms.every(term => haystack.includes(term))) continue;
          const row = Object.freeze({ id: `tab:${tab.id}`, source, title: name, url, tabId: tab.id, windowId: tab.windowId, pinned: tab.pinned === true });
          issuedTabs.set(row, { id: tab.id, windowId: tab.windowId, url: tab.url || '', pendingUrl: tab.pendingUrl || '' }); rows.push(row);
          if (rows.length === BROWSER_COMMAND_LIMITS.results) break;
        }
        return rows;
      }
      const raw = await api[source].search(source === 'history' ? { text, startTime: 0, maxResults: BROWSER_COMMAND_LIMITS.results } : text); aborted(signal);
      if (!Array.isArray(raw)) fail('BROWSER_COMMAND_INVALID'); if (raw.length > BROWSER_COMMAND_LIMITS.openTabs) fail('BROWSER_COMMAND_LIMIT'); const rows = [];
      for (const item of raw) {
        const url = browserCommandUrl(item?.url); if (!url) continue;
        if (typeof item.id !== 'string' && !identity(item.id)) continue;
        const row = Object.freeze({ id: `${source}:${item.id}`, source, title: title(item.title, url), url }); issuedLinks.add(row); rows.push(row);
        if (rows.length === BROWSER_COMMAND_LIMITS.results) break;
      }
      return rows;
    });
  }
  async function liveTab(row, signal) {
    const expected = issuedTabs.get(row); if (!expected) fail('BROWSER_TAB_CHANGED');
    await requirePermission('tabs', signal);
    return operation(async () => {
      let tab; try { tab = await api.tabs.get(expected.id); } catch { fail('BROWSER_TAB_CHANGED'); }
      aborted(signal); privateContext();
      if (tab?.id !== expected.id || tab.incognito !== false || tab.windowId !== expected.windowId || (tab.url || '') !== expected.url
        || (tab.pendingUrl || '') !== expected.pendingUrl || !effectiveUrl(tab)) fail('BROWSER_TAB_CHANGED'); return tab;
    });
  }
  return {
    browserCommandPermissions: permissions,
    requestBrowserCommandPermission(source) {
      sourceOf(source); privateContext(); if (!available(source)) return Promise.reject(Object.assign(Error(tr(messages.BROWSER_UNAVAILABLE)), { code: 'BROWSER_UNAVAILABLE' }));
      // Call synchronously from the dedicated permission button's gesture.
      return operation(() => api.permissions.request({ permissions: [sourceOf(source)] })).then(value => value === true);
    },
    subscribeBrowserCommandPermissions(listener) {
      if (typeof listener !== 'function') fail('BROWSER_COMMAND_INVALID');
      const change = () => listener(); api?.permissions?.onAdded?.addListener(change); api?.permissions?.onRemoved?.addListener(change);
      return () => { api?.permissions?.onAdded?.removeListener(change); api?.permissions?.onRemoved?.removeListener(change); };
    },
    searchBrowserCommands: search,
    async activateBrowserTab(row, { signal } = {}) {
      const tab = await liveTab(row, signal); if (!api.windows?.update || !api.tabs?.update) fail('BROWSER_UNAVAILABLE');
      await operation(() => api.windows.update(tab.windowId, { focused: true })); await liveTab(row, signal);
      await operation(() => api.tabs.update(tab.id, { active: true }));
    },
    async closeBrowserTab(row, { signal } = {}) {
      const tab = await liveTab(row, signal); if (!api.tabs?.remove) fail('BROWSER_UNAVAILABLE');
      await operation(() => api.tabs.remove(tab.id)); issuedTabs.delete(row);
    },
    async openBrowserCommand(row, { signal } = {}) {
      if (!issuedLinks.has(row) || !browserCommandUrl(row.url)) fail('BROWSER_COMMAND_INVALID');
      await requirePermission(row.source, signal); const window = await currentWindow(); aborted(signal);
      if (!api.tabs?.create) fail('BROWSER_UNAVAILABLE'); return operation(() => api.tabs.create({ url: row.url, active: true, windowId: window.id }));
    },
    getCurrentWindow: currentWindow,
    captureCurrentWindowSnapshot: capture,
    async queryCurrentWindowTabs(options) { return (await capture(options)).tabs; },
    queryOpenTabs: openTabs,
    async createTab({ url, active, pinned = false, windowId } = {}, { signal, beforeCreate } = {}) {
      const address = browserCommandUrl(url); if (!address || active !== false || typeof pinned !== 'boolean' || windowId !== undefined && !identity(windowId)
        || beforeCreate !== undefined && typeof beforeCreate !== 'function') fail('BROWSER_COMMAND_INVALID');
      await requirePermission('tabs', signal);
      privateContext(); if (!api?.runtime?.id || !api.tabs?.create) fail('BROWSER_UNAVAILABLE');
      const window = windowId === undefined ? await currentWindow() : await operation(async () => {
        if (!api.windows?.get) fail('BROWSER_UNAVAILABLE'); return checkedWindow(await api.windows.get(windowId));
      });
      aborted(signal);
      // The session layer owns this final live revision/privacy check. Preserve
      // its safe error codes and do not interleave an await after the abort gate.
      await beforeCreate?.();
      aborted(signal);
      return operation(() => api.tabs.create({ url: address, active: false, pinned, windowId: window.id }));
    },
  };
}
export const browserCommands = createBrowserCommands();
export const browserCommandPermissions = browserCommands.browserCommandPermissions;
export const requestBrowserCommandPermission = browserCommands.requestBrowserCommandPermission;
export const subscribeBrowserCommandPermissions = browserCommands.subscribeBrowserCommandPermissions;
export const searchBrowserCommands = browserCommands.searchBrowserCommands;
export const activateBrowserTab = browserCommands.activateBrowserTab;
export const closeBrowserTab = browserCommands.closeBrowserTab;
export const openBrowserCommand = browserCommands.openBrowserCommand;
