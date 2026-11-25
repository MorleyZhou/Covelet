import { tr } from '../i18n/index.js';
import { normalizeUrl } from './model.js';
import { localData } from './local-data.js';
import { getExtensionApi } from './extension-api.js';
import { browserCommands } from './browser-command.js';

export const BROWSER_SESSIONS_KEY = 'covelet.browser-sessions.v1';
export const BROWSER_SESSION_LIMITS = Object.freeze({ sessions: 50, tabs: 500, totalTabs: 2000, bytes: 4 * 1024 * 1024, title: 80, tabTitle: 200, batch: 10 });
const PREFERENCES = 'covelet.content.preferences.v1', RESTORE_LOCK = 'covelet.browser-sessions.restore.v1';
const encoder = new TextEncoder(), copy = (value) => structuredClone(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const identity = (value) => typeof value === 'string' && /^[a-z\d-]{1,100}$/iu.test(value);
const time = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const label = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function fail(code = 'BROWSER_SESSION_INVALID') {
  const message = code === 'BROWSER_SESSION_CAPACITY' ? tr('本机会话已达到容量上限，请先清理不需要的会话。')
    : code === 'BROWSER_SESSION_STALE' ? tr('会话或标签页已更新，请重新预览。')
      : code === 'BROWSER_SESSION_EMPTY' ? tr('当前窗口没有可保存的网页标签。')
        : code === 'BROWSER_SESSION_BUSY' ? tr('这个会话批次正在恢复，请稍后继续。')
          : code === 'BROWSER_SESSION_PREVIEW' ? tr('会话预览已失效，请重新预览。')
            : code === 'BROWSER_SESSION_UNAVAILABLE' ? tr('当前浏览器无法读取或恢复标签会话。')
              : code === 'BROWSER_SESSION_STORAGE' ? tr('本机会话未能保存，已有会话已保留。')
                : code === 'PRIVACY_LOCKED' ? tr('请先输入密码解除隐藏。')
                  : tr('本机会话数据无效，已有会话已保留。');
  throw Object.assign(Error(message), { code });
}
const nextRevision = (value) => { if (value >= Number.MAX_SAFE_INTEGER) fail('BROWSER_SESSION_CAPACITY'); return value + 1; };
const freeze = (value) => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };
const address = (value) => { try { return /^https?:\/\//iu.test(value) ? normalizeUrl(value) : null; } catch { return null; } };
function tabTitle(value, url) {
  const source = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim() : '';
  let result = '';
  for (const char of source || new URL(url).hostname) { if (result.length + char.length > BROWSER_SESSION_LIMITS.tabTitle) break; result += char; }
  return result;
}
export function normalizeBrowserSessionTabs(tabs) {
  if (!Array.isArray(tabs)) fail();
  if (tabs.length > BROWSER_SESSION_LIMITS.tabs) fail('BROWSER_SESSION_CAPACITY');
  const seen = new Set(), result = [];
  for (const tab of tabs) {
    if (!fields(tab, ['url', 'title', 'pinned']) || !label(tab.title, BROWSER_SESSION_LIMITS.tabTitle) || tab.pinned !== undefined && typeof tab.pinned !== 'boolean') fail();
    const url = address(tab.url); if (!url) fail();
    if (seen.has(url)) continue;
    seen.add(url); result.push({ url, title: tab.title.trim(), pinned: tab.pinned === true });
  }
  if (!result.length) fail('BROWSER_SESSION_EMPTY');
  return result;
}
export function createEmptyBrowserSessions() { return { version: 1, revision: 0, sessions: [] }; }
export function validateBrowserSessions(input) {
  const value = input === undefined || input === null ? createEmptyBrowserSessions() : input;
  if (!fields(value, ['version', 'revision', 'sessions']) || Object.keys(value).length !== 3 || value.version !== 1
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.sessions)) fail();
  if (value.sessions.length > BROWSER_SESSION_LIMITS.sessions) fail('BROWSER_SESSION_CAPACITY');
  const ids = new Set(); let count = 0;
  for (const session of value.sessions) {
    if (!fields(session, ['id', 'revision', 'title', 'createdAt', 'updatedAt', 'tabs']) || Object.keys(session).length !== 6 || !identity(session.id) || ids.has(session.id)
      || !Number.isSafeInteger(session.revision) || session.revision < 1 || !label(session.title, BROWSER_SESSION_LIMITS.title)
      || !time(session.createdAt) || !time(session.updatedAt) || session.updatedAt < session.createdAt || !Array.isArray(session.tabs)) fail();
    const normalized = normalizeBrowserSessionTabs(session.tabs);
    if (normalized.length !== session.tabs.length || normalized.some((tab, index) => tab.url !== session.tabs[index].url
      || tab.title !== session.tabs[index].title || tab.pinned !== session.tabs[index].pinned)) fail();
    count += session.tabs.length; ids.add(session.id);
  }
  if (count > BROWSER_SESSION_LIMITS.totalTabs || encoder.encode(JSON.stringify(value)).length > BROWSER_SESSION_LIMITS.bytes) fail('BROWSER_SESSION_CAPACITY');
  return copy(value);
}
function unlocked(preferences) {
  if (preferences !== undefined && (!object(preferences) || preferences.version !== 1 || preferences.presentation !== undefined && typeof preferences.presentation !== 'boolean')) fail();
  if (preferences?.presentation === true) fail('PRIVACY_LOCKED');
}
function normalWindow(window) {
  if (!Number.isInteger(window?.id) || window.id < 0 || window.incognito !== false || window.type !== undefined && window.type !== 'normal') fail('BROWSER_SESSION_UNAVAILABLE');
  return window;
}
function canonicalOpenTabs(tabs) {
  if (!Array.isArray(tabs) || tabs.length > 10000) fail('BROWSER_SESSION_UNAVAILABLE');
  const urls = [];
  for (const tab of tabs) if (tab && !tab.incognito) { const url = address(tab.url); if (url) urls.push(url); }
  return urls.sort();
}
let fallbackRestore = Promise.resolve();

export function createBrowserSessions({ store = localData, browser = browserCommands, locks = globalThis.navigator?.locks,
  requireLocks = Boolean(getExtensionApi()?.runtime?.id), now = () => Date.now(), uuid = () => globalThis.crypto.randomUUID() } = {}) {
  const captures = new WeakMap(), restores = new WeakMap();
  async function snapshot() {
    const values = await store.get([BROWSER_SESSIONS_KEY, PREFERENCES]); unlocked(values[PREFERENCES]);
    return validateBrowserSessions(values[BROWSER_SESSIONS_KEY]);
  }
  async function mutate(change, expectedRevision) {
    let result;
    try {
      await store.updateMany([BROWSER_SESSIONS_KEY, PREFERENCES], (values) => {
        unlocked(values[PREFERENCES]);
        const current = validateBrowserSessions(values[BROWSER_SESSIONS_KEY]);
        if (expectedRevision !== undefined && current.revision !== expectedRevision) fail('BROWSER_SESSION_STALE');
        result = change(current); current.revision = nextRevision(current.revision);
        return { writes: { [BROWSER_SESSIONS_KEY]: validateBrowserSessions(current) } };
      });
    } catch (error) { if (error?.code?.startsWith('BROWSER_SESSION_') || error?.code === 'PRIVACY_LOCKED') throw error; fail('BROWSER_SESSION_STORAGE'); }
    return copy(result);
  }
  async function save({ title, tabs }, { expectedRevision } = {}) {
    if (!label(title, BROWSER_SESSION_LIMITS.title)) fail();
    const normalized = normalizeBrowserSessionTabs(tabs);
    return mutate((current) => {
      if (current.sessions.length >= BROWSER_SESSION_LIMITS.sessions) fail('BROWSER_SESSION_CAPACITY');
      const timestamp = now(), session = { id: uuid(), revision: 1, title: title.trim(), createdAt: timestamp, updatedAt: timestamp, tabs: normalized };
      current.sessions.push(session); return session;
    }, expectedRevision);
  }
  async function currentWindowSnapshot() {
    if (!browser?.captureCurrentWindowSnapshot) fail('BROWSER_SESSION_UNAVAILABLE');
    const captured = await browser.captureCurrentWindowSnapshot(), window = normalWindow(captured?.window);
    if (!Array.isArray(captured.tabs) || captured.tabs.length > BROWSER_SESSION_LIMITS.tabs || !Number.isSafeInteger(captured.rawCount) || captured.rawCount < captured.tabs.length
      || captured.rawCount > BROWSER_SESSION_LIMITS.tabs || !Number.isSafeInteger(captured.excludedCount) || captured.excludedCount < 0
      || captured.rawCount !== captured.tabs.length + captured.excludedCount) fail('BROWSER_SESSION_UNAVAILABLE');
    const seen = new Set(), tabs = [], identities = []; let duplicates = 0;
    for (const tab of captured.tabs) {
      if (tab?.incognito !== false || tab.windowId !== window.id) fail('BROWSER_SESSION_UNAVAILABLE');
      const url = address(tab.url); if (!url) fail('BROWSER_SESSION_UNAVAILABLE');
      if (!Number.isSafeInteger(tab.id) || tab.id < 0) fail('BROWSER_SESSION_UNAVAILABLE');
      identities.push({ id: tab.id, url, pinned: tab.pinned === true });
      if (seen.has(url)) { duplicates++; continue; }
      seen.add(url); tabs.push({ url, title: tabTitle(tab.title, url), pinned: tab.pinned === true });
    }
    if (captured.tabIds !== undefined && (!Array.isArray(captured.tabIds) || captured.tabIds.length !== captured.rawCount
      || new Set(captured.tabIds).size !== captured.tabIds.length || captured.tabIds.some((id) => !Number.isSafeInteger(id) || id < 0))) fail('BROWSER_SESSION_UNAVAILABLE');
    return { windowId: window.id, tabs, supported: tabs.length, duplicates, unsupported: captured.excludedCount, total: captured.rawCount,
      binding: { windowId: window.id, total: captured.rawCount, unsupported: captured.excludedCount, identities, ...(captured.tabIds ? { tabIds: [...captured.tabIds] } : {}) } };
  }
  async function capturePreview() {
    await snapshot(); const captured = await currentWindowSnapshot(); await snapshot();
    if (!captured.tabs.length) fail('BROWSER_SESSION_EMPTY');
    const { binding: _binding, ...publicPreview } = captured;
    const preview = freeze(copy(publicPreview)); captures.set(preview, { snapshot: copy(captured), inFlight: false }); return preview;
  }
  async function capture({ title, preview }, options = {}) {
    if (!preview || !captures.has(preview)) fail('BROWSER_SESSION_PREVIEW');
    const plan = captures.get(preview); if (plan.inFlight) fail('BROWSER_SESSION_BUSY');
    plan.inFlight = true;
    try {
      await snapshot(); const current = await currentWindowSnapshot();
      if (!same(current.binding, plan.snapshot.binding)) fail('BROWSER_SESSION_STALE');
      const result = await save({ title, tabs: plan.snapshot.tabs }, options); captures.delete(preview); return result;
    } finally { plan.inFlight = false; }
  }
  function findSession(library, id, expectedRevision) {
    const session = library.sessions.find((item) => item.id === id);
    if (!session || expectedRevision !== undefined && session.revision !== expectedRevision) fail('BROWSER_SESSION_STALE');
    return session;
  }
  function progress(plan) {
    const tabs = plan.entries.map(({ tab, status }) => ({ ...copy(tab), alreadyOpen: status === 'skipped', status, ...(status === 'failed' ? { error: 'BROWSER_SESSION_CREATE_FAILED' } : {}) }));
    const counts = (status) => plan.entries.filter((entry) => entry.status === status).length;
    const pending = counts('pending'), failed = counts('failed');
    return freeze({ sessionId: plan.sessionId, title: plan.title, revision: plan.revision, tabs, total: tabs.length, pending, opened: counts('opened'), failed,
      skipped: counts('skipped'), complete: !pending && !failed, remaining: pending + failed, cancelled: plan.cancelled });
  }
  async function previewRestore(sessionId, { selectedUrls, expectedRevision } = {}) {
    const library = await snapshot(), session = findSession(library, sessionId, expectedRevision);
    if (!browser?.getCurrentWindow || !browser.queryOpenTabs || !browser.createTab) fail('BROWSER_SESSION_UNAVAILABLE');
    const window = normalWindow(await browser.getCurrentWindow()), urls = canonicalOpenTabs(await browser.queryOpenTabs());
    let selected = session.tabs;
    if (selectedUrls !== undefined) {
      if (!Array.isArray(selectedUrls) || !selectedUrls.length || selectedUrls.length > BROWSER_SESSION_LIMITS.tabs || new Set(selectedUrls).size !== selectedUrls.length
        || selectedUrls.some((url) => typeof url !== 'string' || !session.tabs.some((tab) => tab.url === url))) fail('BROWSER_SESSION_PREVIEW');
      const wanted = new Set(selectedUrls); selected = session.tabs.filter((tab) => wanted.has(tab.url));
    }
    const current = findSession(await snapshot(), sessionId, session.revision); if (!same(current, session)) fail('BROWSER_SESSION_STALE');
    const existing = new Set(urls), plan = { sessionId, title: session.title, revision: session.revision, windowId: window.id, initialUrls: urls,
      entries: selected.map((tab) => ({ tab: copy(tab), status: existing.has(tab.url) ? 'skipped' : 'pending' })), opened: new Set(), controller: new AbortController(), started: false, inFlight: false, cancelled: false };
    const preview = progress(plan); restores.set(preview, plan); return preview;
  }
  async function withRestoreLock(action) {
    if (locks?.request) return locks.request(RESTORE_LOCK, { mode: 'exclusive' }, action);
    if (requireLocks) fail('BROWSER_SESSION_UNAVAILABLE');
    const pending = fallbackRestore.catch(() => {}).then(action); fallbackRestore = pending.catch(() => {}); return pending;
  }
  async function restoreBatch(preview, { retryFailed = false } = {}) {
    const plan = preview && restores.get(preview);
    if (!plan || plan.cancelled || typeof retryFailed !== 'boolean') fail('BROWSER_SESSION_PREVIEW');
    if (plan.inFlight) fail('BROWSER_SESSION_BUSY');
    plan.inFlight = true;
    try {
      return await withRestoreLock(async () => {
        if (plan.cancelled) return progress(plan);
        findSession(await snapshot(), plan.sessionId, plan.revision);
        const window = normalWindow(await browser.getCurrentWindow()); if (window.id !== plan.windowId) fail('BROWSER_SESSION_STALE');
        const actual = canonicalOpenTabs(await browser.queryOpenTabs());
        if (!plan.started && !same(actual, plan.initialUrls)) fail('BROWSER_SESSION_STALE');
        plan.started = true;
        const candidates = plan.entries.filter((entry) => entry.status === 'pending');
        if (!candidates.length && retryFailed) candidates.push(...plan.entries.filter((entry) => entry.status === 'failed'));
        for (const entry of candidates.slice(0, BROWSER_SESSION_LIMITS.batch)) {
          if (plan.cancelled) break;
          findSession(await snapshot(), plan.sessionId, plan.revision);
          const currentWindow = normalWindow(await browser.getCurrentWindow()); if (currentWindow.id !== plan.windowId) fail('BROWSER_SESSION_STALE');
          const existing = new Set(canonicalOpenTabs(await browser.queryOpenTabs()));
          // Browser queries yield to UI cancellation, privacy locks and edits
          // from another page. Recheck after them, immediately before issuing
          // any new create operation; a pre-query check alone can be stale.
          if (plan.cancelled) break;
          findSession(await snapshot(), plan.sessionId, plan.revision);
          if (plan.cancelled) break;
          if (plan.opened.has(entry.tab.url)) { entry.status = 'opened'; continue; }
          if (existing.has(entry.tab.url)) { entry.status = 'skipped'; continue; }
          try {
            await browser.createTab({ url: entry.tab.url, active: false, pinned: entry.tab.pinned, windowId: plan.windowId }, {
              signal: plan.controller.signal,
              beforeCreate: async () => { findSession(await snapshot(), plan.sessionId, plan.revision); },
            });
            plan.opened.add(entry.tab.url); entry.status = 'opened';
          } catch (error) {
            if (error?.name === 'AbortError' && plan.cancelled) break;
            if (error?.code === 'PRIVACY_LOCKED' || error?.code === 'BROWSER_SESSION_STALE'
              || error?.code === 'BROWSER_PERMISSION' || error?.code === 'BROWSER_PRIVATE_WINDOW' || error?.code === 'BROWSER_UNAVAILABLE') throw error;
            entry.status = 'failed';
            if (plan.cancelled) break;
            // A rejected response may have arrived after creation. Read back
            // before offering a retry, so a known new URL is never duplicated.
            const after = new Set(canonicalOpenTabs(await browser.queryOpenTabs()));
            if (after.has(entry.tab.url)) { plan.opened.add(entry.tab.url); entry.status = 'opened'; }
          }
        }
        return progress(plan);
      });
    } catch (error) {
      if (error && typeof error === 'object') error.progress = progress(plan);
      throw error;
    } finally { plan.inFlight = false; }
  }
  return {
    loadBrowserSessions: snapshot,
    subscribeBrowserSessions(listener) {
      if (typeof listener !== 'function') fail();
      return store.subscribe((changes) => { if (Object.hasOwn(changes, BROWSER_SESSIONS_KEY)) { try { listener(validateBrowserSessions(changes[BROWSER_SESSIONS_KEY].newValue)); } catch { /* Corrupt data must not replace a valid open list. */ } } });
    },
    saveBrowserSession: save,
    previewCurrentBrowserSession: capturePreview,
    captureCurrentBrowserSession: capture,
    renameBrowserSession(sessionId, title, { expectedRevision } = {}) {
      if (!label(title, BROWSER_SESSION_LIMITS.title) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail();
      return mutate((library) => { const session = findSession(library, sessionId, expectedRevision); session.title = title.trim(); session.revision = nextRevision(session.revision); session.updatedAt = Math.max(now(), session.updatedAt); return session; });
    },
    deleteBrowserSession(sessionId, { expectedRevision } = {}) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail();
      return mutate((library) => { const session = findSession(library, sessionId, expectedRevision); library.sessions = library.sessions.filter((item) => item.id !== sessionId); return session; });
    },
    previewBrowserSessionRestore: previewRestore,
    restoreBrowserSessionBatch: restoreBatch,
    cancelBrowserSessionRestore(preview) { const plan = preview && restores.get(preview); if (!plan) fail('BROWSER_SESSION_PREVIEW'); plan.cancelled = true; plan.controller.abort(); return progress(plan); },
  };
}
const browserSessions = createBrowserSessions();
export const loadBrowserSessions = browserSessions.loadBrowserSessions;
export const subscribeBrowserSessions = browserSessions.subscribeBrowserSessions;
export const saveBrowserSession = browserSessions.saveBrowserSession;
export const previewCurrentBrowserSession = browserSessions.previewCurrentBrowserSession;
export const captureCurrentBrowserSession = browserSessions.captureCurrentBrowserSession;
export const renameBrowserSession = browserSessions.renameBrowserSession;
export const deleteBrowserSession = browserSessions.deleteBrowserSession;
export const previewBrowserSessionRestore = browserSessions.previewBrowserSessionRestore;
export const restoreBrowserSessionBatch = browserSessions.restoreBrowserSessionBatch;
export const cancelBrowserSessionRestore = browserSessions.cancelBrowserSessionRestore;
