import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSessions, createEmptyBrowserSessions, validateBrowserSessions, normalizeBrowserSessionTabs, BROWSER_SESSIONS_KEY, BROWSER_SESSION_LIMITS } from './browser-sessions.js';
import { browserCommandUrl } from './browser-command.js';

const tab = (index, patch = {}) => ({ url: `https://example.com/page-${index}`, title: `Page ${index}`, pinned: false, ...patch });
function state() {
  const values = { 'covelet.content.preferences.v1': { version: 1, revision: 0, aliases: {}, privateKeys: [], presentation: false } }, listeners = new Set();
  let queue = Promise.resolve(), writes = 0, failWrite = false;
  const store = {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => Object.hasOwn(values, key)).map((key) => [key, structuredClone(values[key])])),
    updateMany(keys, update) {
      const next = queue.then(async () => {
        const result = await update(structuredClone(values));
        if (failWrite) throw Object.assign(Error('Private storage diagnostic'), { code: 'LOCAL_DATA_WRITE_FAILED' });
        const changes = {};
        for (const [key, value] of Object.entries(result.writes)) { changes[key] = { oldValue: values[key], newValue: structuredClone(value) }; values[key] = structuredClone(value); }
        writes++; for (const listener of listeners) listener(changes);
      }); queue = next.catch(() => {}); return next;
    },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { store, values, get writes() { return writes; }, set failWrite(value) { failWrite = value; } };
}
function fixture({ saved = state(), locks } = {}) {
  const window = { id: 1, incognito: false, type: 'normal' }, current = [], opened = [];
  let sequence = 0, tabSequence = 100, createHook = null, prepareHook = null, granted = true;
  const permission = () => { if (!granted) throw Object.assign(Error('Please grant tabs permission.'), { code: 'BROWSER_PERMISSION' }); };
  const browser = {
    async getCurrentWindow() { permission(); return structuredClone(window); },
    async captureCurrentWindowSnapshot() {
      permission();
      const tabs = current.filter((item) => browserCommandUrl(item.url));
      return { window: structuredClone(window), tabs: structuredClone(tabs), tabIds: current.map((tab) => tab.id), rawCount: current.length, excludedCount: current.length - tabs.length };
    },
    async queryOpenTabs() { permission(); return structuredClone(current); },
    async createTab(options, { signal, beforeCreate } = {}) {
      const aborted = () => { if (signal?.aborted) throw new DOMException('Cancelled before creation.', 'AbortError'); };
      permission(); aborted();
      if (prepareHook) await prepareHook(options);
      aborted(); await beforeCreate?.(); aborted();
      opened.push(structuredClone(options));
      if (createHook) await createHook(options);
      const created = { ...options, id: tabSequence++, windowId: options.windowId, incognito: false, title: options.url, index: current.length };
      current.push(created); return structuredClone(created);
    },
  };
  const options = { store: saved.store, browser, locks, requireLocks: false, now: () => 100, uuid: () => `session-${++sequence}` };
  return { ...saved, saved, browser, current, opened, window, options, api: createBrowserSessions(options),
    set createHook(value) { createHook = value; }, set prepareHook(value) { prepareHook = value; }, set granted(value) { granted = value; } };
}
const liveTab = (index, patch = {}) => ({ ...tab(index), id: index, windowId: 1, incognito: false, index, ...patch });
function lockManager() {
  const queues = new Map(); let active = 0, maximum = 0;
  return { get maximum() { return maximum; }, request(name, options, callback) {
    const run = callback || options, next = (queues.get(name) || Promise.resolve()).then(async () => { active++; maximum = Math.max(maximum, active); try { return await run(); } finally { active--; } });
    queues.set(name, next.catch(() => {})); return next;
  } };
}

test('new session collection is local-only, strict, metadata-only and independent of retired tool snapshots', async () => {
  const f = fixture(); f.saved.values['covelet.tools.v1'] = { snapshots: [{ id: 'old', title: 'Historical only', tabs: [tab(1)] }] };
  assert.deepEqual(await f.api.loadBrowserSessions(), createEmptyBrowserSessions());
  const saved = await f.api.saveBrowserSession({ title: 'Work', tabs: [tab(1)] }, { expectedRevision: 0 });
  assert.equal(saved.id, 'session-1'); assert.equal(saved.revision, 1); assert.deepEqual(Object.keys(saved).sort(), ['createdAt', 'id', 'revision', 'tabs', 'title', 'updatedAt']);
  assert.equal(f.saved.values['covelet.tools.v1'].snapshots[0].id, 'old'); assert.equal(f.opened.length, 0);
  assert.deepEqual(Object.keys(f.saved.values[BROWSER_SESSIONS_KEY]), ['version', 'revision', 'sessions']);
});

test('HTTP URL dedup normalizes host/default port, preserves first title/pinned/order, queries and distinct fragments', () => {
  const normalized = normalizeBrowserSessionTabs([
    { url: 'HTTPS://EXAMPLE.COM:443/a#part', title: 'First', pinned: true },
    { url: 'https://example.com/a#part', title: 'Later duplicate', pinned: false },
    { url: 'https://example.com/a#other', title: 'Other section' },
    { url: 'https://example.com/a?q=1#part', title: 'Query' },
  ]);
  assert.equal(normalized.length, 3); assert.equal(normalized[0].title, 'First'); assert.equal(normalized[0].pinned, true);
  assert.equal(normalized[1].url, 'https://example.com/a#other'); assert.equal(normalized[2].url, 'https://example.com/a?q=1#part');
  for (const url of ['chrome://settings/', 'moz-extension://abc/a', 'file:///secret.txt', 'data:text/plain,secret', 'javascript:alert(1)', 'https://user:password@example.com/'])
    assert.throws(() => normalizeBrowserSessionTabs([{ url, title: 'Unsafe' }]), { code: 'BROWSER_SESSION_INVALID' });
  assert.throws(() => normalizeBrowserSessionTabs([{ ...tab(1), body: 'page content' }]), { code: 'BROWSER_SESSION_INVALID' });
});

test('capture previews valid/duplicate/unsupported counts, commits only after confirmation and never closes original tabs', async () => {
  const f = fixture(); f.current.push(liveTab(1), liveTab(2, { url: 'HTTPS://EXAMPLE.COM:443/page-1', pinned: true }), liveTab(3, { url: 'about:config' }), liveTab(4, { url: 'file:///secret' }));
  const preview = await f.api.previewCurrentBrowserSession();
  assert.deepEqual({ total: preview.total, supported: preview.supported, duplicates: preview.duplicates, unsupported: preview.unsupported }, { total: 4, supported: 1, duplicates: 1, unsupported: 2 });
  assert.equal(f.saved.writes, 0); assert.equal(preview.tabs[0].pinned, false);
  const saved = await f.api.captureCurrentBrowserSession({ title: 'Window', preview }, { expectedRevision: 0 });
  assert.equal(saved.tabs.length, 1); assert.equal(f.current.length, 4); assert.equal(f.opened.length, 0);
  await assert.rejects(f.api.captureCurrentBrowserSession({ title: 'Again', preview }), { code: 'BROWSER_SESSION_PREVIEW' });
});

test('capture rejects forged/changed previews, incognito and oversized/empty windows without storing partial results', async () => {
  const f = fixture(); f.current.push(liveTab(1)); const preview = await f.api.previewCurrentBrowserSession();
  await assert.rejects(f.api.captureCurrentBrowserSession({ title: 'Forged', preview: structuredClone(preview) }), { code: 'BROWSER_SESSION_PREVIEW' });
  f.current[0].url = 'https://changed.example/';
  await assert.rejects(f.api.captureCurrentBrowserSession({ title: 'Stale', preview }), { code: 'BROWSER_SESSION_STALE' });
  f.window.incognito = true; await assert.rejects(f.api.previewCurrentBrowserSession(), { code: 'BROWSER_SESSION_UNAVAILABLE' });
  f.window.incognito = false; f.current[0].incognito = true; await assert.rejects(f.api.previewCurrentBrowserSession(), { code: 'BROWSER_SESSION_UNAVAILABLE' });
  f.current.splice(0, f.current.length, ...Array.from({ length: 501 }, (_, index) => liveTab(index)));
  await assert.rejects(f.api.previewCurrentBrowserSession(), { code: 'BROWSER_SESSION_UNAVAILABLE' });
  f.current.splice(0); await assert.rejects(f.api.previewCurrentBrowserSession(), { code: 'BROWSER_SESSION_EMPTY' }); assert.equal(f.saved.writes, 0);
});

test('capture confirmation ignores volatile page titles but binds raw tab identities, URL order and pinned state', async () => {
  const f = fixture(); f.current.push(liveTab(1), liveTab(2, { url: 'about:blank' }));
  const preview = await f.api.previewCurrentBrowserSession(); f.current[0].title = 'Updated unread count';
  const saved = await f.api.captureCurrentBrowserSession({ title: 'Stable capture', preview }, { expectedRevision: 0 });
  assert.equal(saved.tabs[0].title, 'Page 1'); assert.equal(Object.hasOwn(preview, 'binding'), false); assert.equal(Object.hasOwn(saved.tabs[0], 'id'), false);
  const changed = await f.api.previewCurrentBrowserSession(); f.current[1].id = 99;
  await assert.rejects(f.api.captureCurrentBrowserSession({ title: 'Closed and replaced internal tab', preview: changed }), { code: 'BROWSER_SESSION_STALE' });
  const pin = await f.api.previewCurrentBrowserSession(); f.current[0].pinned = true;
  await assert.rejects(f.api.captureCurrentBrowserSession({ title: 'Changed pin', preview: pin }), { code: 'BROWSER_SESSION_STALE' });
});

test('atomic envelope and record CAS prevents stale capture, rename and deletion from overwriting current sessions', async () => {
  const f = fixture(), saved = await f.api.saveBrowserSession({ title: 'First', tabs: [tab(1)] }, { expectedRevision: 0 });
  await assert.rejects(f.api.saveBrowserSession({ title: 'Stale add', tabs: [tab(2)] }, { expectedRevision: 0 }), { code: 'BROWSER_SESSION_STALE' });
  const renamed = await f.api.renameBrowserSession(saved.id, 'Renamed', { expectedRevision: 1 }); assert.equal(renamed.revision, 2);
  await assert.rejects(f.api.renameBrowserSession(saved.id, 'Stale', { expectedRevision: 1 }), { code: 'BROWSER_SESSION_STALE' });
  await assert.rejects(f.api.deleteBrowserSession(saved.id, { expectedRevision: 1 }), { code: 'BROWSER_SESSION_STALE' });
  assert.equal((await f.api.loadBrowserSessions()).sessions[0].title, 'Renamed');
  await f.api.deleteBrowserSession(saved.id, { expectedRevision: 2 }); assert.equal((await f.api.loadBrowserSessions()).sessions.length, 0);
});

test('session, per-session URL, aggregate URL and byte capacities refuse without eviction or mutation', async () => {
  const f = fixture(), item = await f.api.saveBrowserSession({ title: 'First', tabs: [tab(1)] });
  for (const [count, tabs] of [[51, [tab(1)]], [5, Array.from({ length: 500 }, (_, index) => tab(index))]]) {
    const value = { version: 1, revision: 0, sessions: Array.from({ length: count }, (_, index) => ({ ...item, id: `session-${index}`, tabs })) };
    assert.throws(() => validateBrowserSessions(value), { code: 'BROWSER_SESSION_CAPACITY' }); assert.equal(value.sessions.length, count);
  }
  await assert.rejects(f.api.saveBrowserSession({ title: 'Too many', tabs: Array.from({ length: 501 }, (_, index) => tab(index)) }), { code: 'BROWSER_SESSION_CAPACITY' });
  const longTabs = Array.from({ length: 500 }, (_, index) => tab(index, { url: `https://example.com/${'x'.repeat(3800)}?n=${index}` }));
  const huge = { version: 1, revision: 0, sessions: Array.from({ length: 3 }, (_, index) => ({ ...item, id: `session-large-${index}`, tabs: longTabs })) };
  assert.throws(() => validateBrowserSessions(huge), { code: 'BROWSER_SESSION_CAPACITY' });
  assert.equal((await f.api.loadBrowserSessions()).sessions.length, 1);
  await assert.rejects(f.api.saveBrowserSession({ title: 'x'.repeat(81), tabs: [tab(1)] }), { code: 'BROWSER_SESSION_INVALID' });
});

test('failed encrypted write preserves the collection and subscriptions only publish validated committed sessions', async () => {
  const f = fixture(), seen = [], off = f.api.subscribeBrowserSessions((value) => seen.push(value));
  await f.api.saveBrowserSession({ title: 'First', tabs: [tab(1)] }); assert.equal(seen.length, 1);
  const before = structuredClone(f.saved.values); f.saved.failWrite = true;
  await assert.rejects(f.api.renameBrowserSession('session-1', 'Failed', { expectedRevision: 1 }), { code: 'BROWSER_SESSION_STORAGE' });
  assert.deepEqual(f.saved.values, before); assert.equal(seen.length, 1);
  off(); f.saved.failWrite = false; await f.api.deleteBrowserSession('session-1', { expectedRevision: 1 }); assert.equal(seen.length, 1);
});

test('30 URL restore requires exactly three explicit inactive batches and repeated restore does not duplicate opened URLs', async () => {
  const f = fixture(), saved = await f.api.saveBrowserSession({ title: 'Thirty', tabs: Array.from({ length: 30 }, (_, index) => tab(index, { pinned: index === 0 })) });
  const preview = await f.api.previewBrowserSessionRestore(saved.id, { expectedRevision: 1 }); assert.equal(preview.pending, 30); assert.equal(f.opened.length, 0);
  const one = await f.api.restoreBrowserSessionBatch(preview); assert.equal(one.opened, 10); assert.equal(one.pending, 20);
  const two = await f.api.restoreBrowserSessionBatch(preview); assert.equal(two.opened, 20); assert.equal(two.pending, 10);
  const three = await f.api.restoreBrowserSessionBatch(preview); assert.equal(three.opened, 30); assert.equal(three.complete, true);
  assert(f.opened.every((options) => options.active === false && options.windowId === 1)); assert.equal(f.opened[0].pinned, true);
  await f.api.restoreBrowserSessionBatch(preview); assert.equal(f.opened.length, 30);
  const again = await f.api.previewBrowserSessionRestore(saved.id); assert.equal(again.skipped, 30); assert.equal(again.complete, true);
});

test('selection and existing URL preview dedup all normal windows while preserving fragment identities', async () => {
  const f = fixture(), saved = await f.api.saveBrowserSession({ title: 'Selected', tabs: [tab(1), tab(2), tab(3), tab(4, { url: `${tab(1).url}#part` })] });
  f.current.push(liveTab(1), liveTab(2, { windowId: 2 }));
  const preview = await f.api.previewBrowserSessionRestore(saved.id, { selectedUrls: [tab(1).url, tab(2).url, `${tab(1).url}#part`] });
  assert.equal(preview.skipped, 2); assert.equal(preview.pending, 1);
  await f.api.restoreBrowserSessionBatch(preview); assert.deepEqual(f.opened.map((options) => options.url), [`${tab(1).url}#part`]);
  await assert.rejects(f.api.previewBrowserSessionRestore(saved.id, { selectedUrls: ['https://forged.example/'] }), { code: 'BROWSER_SESSION_PREVIEW' });
});

test('restore capability rejects copies, session rename/deletion and stale existing URL or current-window snapshots', async () => {
  const f = fixture(), saved = await f.api.saveBrowserSession({ title: 'Stale', tabs: [tab(1)] });
  const preview = await f.api.previewBrowserSessionRestore(saved.id);
  await assert.rejects(f.api.restoreBrowserSessionBatch(structuredClone(preview)), { code: 'BROWSER_SESSION_PREVIEW' });
  f.current.push(liveTab(9)); await assert.rejects(f.api.restoreBrowserSessionBatch(preview), { code: 'BROWSER_SESSION_STALE' }); f.current.splice(0);
  await f.api.renameBrowserSession(saved.id, 'New name', { expectedRevision: 1 }); await assert.rejects(f.api.restoreBrowserSessionBatch(preview), { code: 'BROWSER_SESSION_STALE' });
  const fresh = await f.api.previewBrowserSessionRestore(saved.id); f.window.id = 2; await assert.rejects(f.api.restoreBrowserSessionBatch(fresh), { code: 'BROWSER_SESSION_STALE' }); f.window.id = 1;
  await f.api.deleteBrowserSession(saved.id, { expectedRevision: 2 }); await assert.rejects(f.api.restoreBrowserSessionBatch(fresh), { code: 'BROWSER_SESSION_STALE' }); assert.equal(f.opened.length, 0);
});

test('cancelled previews create nothing and cancellation during a batch prevents remaining calls', async () => {
  const f = fixture(), saved = await f.api.saveBrowserSession({ title: 'Cancel', tabs: [tab(1), tab(2)] });
  const cancelled = await f.api.previewBrowserSessionRestore(saved.id); f.api.cancelBrowserSessionRestore(cancelled);
  await assert.rejects(f.api.restoreBrowserSessionBatch(cancelled), { code: 'BROWSER_SESSION_PREVIEW' }); assert.equal(f.opened.length, 0);
  const preview = await f.api.previewBrowserSessionRestore(saved.id); f.createHook = () => f.api.cancelBrowserSessionRestore(preview);
  const progress = await f.api.restoreBrowserSessionBatch(preview); assert.equal(progress.cancelled, true); assert.equal(progress.opened, 1); assert.equal(progress.pending, 1);
});

test('partial create failures need explicit retry and successful or unknown-outcome-created URLs are never repeated', async () => {
  const f = fixture(), saved = await f.api.saveBrowserSession({ title: 'Retry', tabs: [tab(1), tab(2), tab(3)] }); let failed = true;
  f.createHook = (options) => { if (options.url === tab(2).url && failed) throw Error('Unavailable'); };
  const preview = await f.api.previewBrowserSessionRestore(saved.id), first = await f.api.restoreBrowserSessionBatch(preview);
  assert.equal(first.opened, 2); assert.equal(first.failed, 1); assert.equal(first.pending, 0);
  await f.api.restoreBrowserSessionBatch(preview); assert.equal(f.opened.length, 3);
  failed = false; const retry = await f.api.restoreBrowserSessionBatch(preview, { retryFailed: true }); assert.equal(retry.complete, true); assert.equal(retry.opened, 3);
  assert.equal(f.opened.filter((options) => options.url === tab(1).url).length, 1);
  const other = fixture(), record = await other.api.saveBrowserSession({ title: 'Lost reply', tabs: [tab(1)] });
  other.createHook = (options) => { other.current.push(liveTab(1, { url: options.url })); throw Error('reply lost after create'); };
  const token = await other.api.previewBrowserSessionRestore(record.id), reply = await other.api.restoreBrowserSessionBatch(token);
  assert.equal(reply.opened, 1); await other.api.restoreBrowserSessionBatch(token, { retryFailed: true }); assert.equal(other.opened.length, 1);
});

test('created URLs remain remembered after browser redirect so later batches and retries cannot reopen them', async () => {
  const f = fixture(), saved = await f.api.saveBrowserSession({ title: 'Redirect', tabs: Array.from({ length: 11 }, (_, index) => tab(index)) });
  const preview = await f.api.previewBrowserSessionRestore(saved.id); await f.api.restoreBrowserSessionBatch(preview);
  for (const current of f.current) current.url = `https://redirect.example/${current.id}`;
  const result = await f.api.restoreBrowserSessionBatch(preview); assert.equal(result.opened, 11); assert.equal(result.complete, true); assert.equal(f.opened.length, 11);
});

test('same-capability double submit is blocked while cross-instance Web Lock restoration remains serial and freshly deduplicated', async () => {
  const locks = lockManager(), f = fixture({ locks }), saved = await f.api.saveBrowserSession({ title: 'Serial', tabs: [tab(1), tab(2)] });
  const one = await f.api.previewBrowserSessionRestore(saved.id), secondApi = createBrowserSessions(f.options), two = await secondApi.previewBrowserSessionRestore(saved.id);
  let release, entered; const enteredPromise = new Promise((resolve) => { entered = resolve; }), pause = new Promise((resolve) => { release = resolve; });
  f.createHook = async () => { entered(); await pause; };
  const first = f.api.restoreBrowserSessionBatch(one); await enteredPromise;
  await assert.rejects(f.api.restoreBrowserSessionBatch(one), { code: 'BROWSER_SESSION_BUSY' });
  const second = secondApi.restoreBrowserSessionBatch(two); release();
  assert.equal((await first).opened, 2); await assert.rejects(second, { code: 'BROWSER_SESSION_STALE' });
  assert.equal(locks.maximum, 1); assert.equal(f.opened.length, 2);
});

test('permission revocation or hidden mode mid-batch stops further tabs and exposes safe partial progress', async () => {
  for (const change of [(f) => { f.granted = false; }, (f) => { f.saved.values['covelet.content.preferences.v1'].presentation = true; }]) {
    const f = fixture(), saved = await f.api.saveBrowserSession({ title: 'Guarded', tabs: [tab(1), tab(2)] }), preview = await f.api.previewBrowserSessionRestore(saved.id);
    f.createHook = () => change(f);
    await assert.rejects(f.api.restoreBrowserSessionBatch(preview), (error) => { assert.equal(error.progress.opened, 1); assert.equal(error.progress.pending, 1); return ['BROWSER_PERMISSION', 'PRIVACY_LOCKED'].includes(error.code); });
    assert.equal(f.opened.length, 1);
  }
});

test('cancellation, hidden mode and session edits during a delayed duplicate query stop creation before the first tab', async () => {
  for (const kind of ['cancel', 'hidden', 'rename']) {
    const f = fixture(), saved = await f.api.saveBrowserSession({ title: 'Final guard', tabs: [tab(1), tab(2)] });
    const preview = await f.api.previewBrowserSessionRestore(saved.id), original = f.browser.queryOpenTabs;
    let calls = 0, release, entered;
    const paused = new Promise((resolve) => { entered = resolve; }), resume = new Promise((resolve) => { release = resolve; });
    f.browser.queryOpenTabs = async () => {
      const result = await original();
      if (++calls === 2) { entered(); await resume; }
      return result;
    };
    const attempt = f.api.restoreBrowserSessionBatch(preview); await paused;
    if (kind === 'cancel') f.api.cancelBrowserSessionRestore(preview);
    else if (kind === 'hidden') f.saved.values['covelet.content.preferences.v1'].presentation = true;
    else await f.api.renameBrowserSession(saved.id, 'Changed while browser query was pending', { expectedRevision: 1 });
    release();
    if (kind === 'cancel') { const result = await attempt; assert.equal(result.cancelled, true); assert.equal(result.opened, 0); }
    else await assert.rejects(attempt, (error) => { assert.equal(error.progress.opened, 0); return error.code === (kind === 'hidden' ? 'PRIVACY_LOCKED' : 'BROWSER_SESSION_STALE'); });
    assert.equal(f.opened.length, 0); assert.equal(f.current.length, 0);
  }
});

test('plan cancellation signal and final live callback stop creation while the browser adapter is awaiting its window check', async () => {
  for (const kind of ['cancel', 'hidden', 'rename']) {
    const f = fixture(), saved = await f.api.saveBrowserSession({ title: 'Adapter guard', tabs: [tab(1), tab(2)] });
    const preview = await f.api.previewBrowserSessionRestore(saved.id);
    let release, entered;
    const paused = new Promise((resolve) => { entered = resolve; }), resume = new Promise((resolve) => { release = resolve; });
    f.prepareHook = async () => { entered(); await resume; };
    const attempt = f.api.restoreBrowserSessionBatch(preview); await paused;
    if (kind === 'cancel') f.api.cancelBrowserSessionRestore(preview);
    else if (kind === 'hidden') f.saved.values['covelet.content.preferences.v1'].presentation = true;
    else await f.api.renameBrowserSession(saved.id, 'Changed before native creation', { expectedRevision: 1 });
    release();
    if (kind === 'cancel') { const result = await attempt; assert.equal(result.cancelled, true); assert.equal(result.opened, 0); assert.equal(result.pending, 2); }
    else await assert.rejects(attempt, (error) => { assert.equal(error.progress.opened, 0); assert.equal(error.progress.pending, 2); return error.code === (kind === 'hidden' ? 'PRIVACY_LOCKED' : 'BROWSER_SESSION_STALE'); });
    assert.equal(f.opened.length, 0); assert.equal(f.current.length, 0);
  }
});

test('cancellation after native creation has been issued retains its one successful receipt and stops the next URL', async () => {
  const f = fixture(), saved = await f.api.saveBrowserSession({ title: 'Keep issued result', tabs: [tab(1), tab(2)] });
  const preview = await f.api.previewBrowserSessionRestore(saved.id);
  let release, entered;
  const issued = new Promise((resolve) => { entered = resolve; }), resume = new Promise((resolve) => { release = resolve; });
  f.createHook = async () => { entered(); await resume; };
  const attempt = f.api.restoreBrowserSessionBatch(preview); await issued; assert.equal(f.opened.length, 1);
  f.api.cancelBrowserSessionRestore(preview); release();
  const progress = await attempt;
  assert.equal(progress.cancelled, true); assert.equal(progress.opened, 1); assert.equal(progress.pending, 1); assert.equal(progress.failed, 0);
  assert.equal(f.opened.length, 1); assert.equal(f.current.length, 1); assert.equal(f.current[0].url, tab(1).url);
});

test('hidden mode rejects read, capture, store changes and previews without leaking session counts', async () => {
  const f = fixture(); await f.api.saveBrowserSession({ title: 'Private collection', tabs: [tab(1)] }); const before = structuredClone(f.saved.values[BROWSER_SESSIONS_KEY]);
  f.saved.values['covelet.content.preferences.v1'].presentation = true;
  for (const call of [() => f.api.loadBrowserSessions(), () => f.api.previewCurrentBrowserSession(), () => f.api.saveBrowserSession({ title: 'Blocked', tabs: [tab(2)] }), () => f.api.renameBrowserSession('session-1', 'Blocked', { expectedRevision: 1 }), () => f.api.deleteBrowserSession('session-1', { expectedRevision: 1 }), () => f.api.previewBrowserSessionRestore('session-1')])
    await assert.rejects(call(), { code: 'PRIVACY_LOCKED' });
  assert.deepEqual(f.saved.values[BROWSER_SESSIONS_KEY], before); assert.equal(f.opened.length, 0);
});

test('strict persisted schema refuses unknown fields, unsafe metadata and duplicate stored normalized URLs', () => {
  const session = { id: 'valid-session', revision: 1, title: 'Valid', createdAt: 1, updatedAt: 1, tabs: [tab(1)] }, wrap = (item) => ({ version: 1, revision: 0, sessions: [item] });
  for (const value of [{ ...createEmptyBrowserSessions(), version: 2 }, { ...createEmptyBrowserSessions(), secret: 'x' }, wrap({ ...session, cookies: 'secret' }), wrap({ ...session, tabs: [{ ...tab(1), id: 9 }] }), wrap({ ...session, tabs: [tab(1), tab(1)] }), wrap({ ...session, tabs: [tab(1, { pinned: 'false' })] })]) assert.throws(() => validateBrowserSessions(value), { code: 'BROWSER_SESSION_INVALID' });
  assert.equal(BROWSER_SESSION_LIMITS.batch, 10);
});
