import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserCommands, browserCommandUrl, BROWSER_COMMAND_LIMITS } from './browser-command.js';

const tab = (id = 1, extra = {}) => ({ id, windowId: 10, index: id - 1, title: `Tab ${id}`, url: `https://example.test/${id}`, incognito: false, pinned: false, ...extra });
function event() { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: value => { for (const fn of listeners) fn(value); }, get size() { return listeners.size; } }; }
function fixture(options = {}) {
  const calls = [], grants = new Set(options.grants || ['tabs', 'history', 'bookmarks']), tabs = options.tabs || [tab()], windows = new Map([[10, { id: 10, incognito: false, type: 'normal' }], [20, { id: 20, incognito: false, type: 'normal' }]]);
  let currentWindowId = 10;
  const api = { runtime: { id: 'fixture' }, extension: { inIncognitoContext: false },
    permissions: { onAdded: event(), onRemoved: event(), async contains(input) { calls.push(['contains', input]); return input.permissions.every(value => grants.has(value)); },
      request(input) { calls.push(['request', input]); return Promise.resolve(options.grantRequest !== false); } },
    windows: { async getCurrent() { calls.push(['currentWindow']); return structuredClone(windows.get(currentWindowId)); }, async get(id) { calls.push(['getWindow', id]); return structuredClone(windows.get(id)); },
      async update(id, value) { calls.push(['focusWindow', id, value]); options.focus?.(); } },
    tabs: { async query(input) { calls.push(['queryTabs', input]); return options.query ? options.query(input) : structuredClone(tabs.filter(tab => input.windowId === undefined || tab.windowId === input.windowId)); },
      async get(id) { calls.push(['getTab', id]); if (options.get) return options.get(id); const value = tabs.find(tab => tab.id === id); if (!value) throw Error('PRIVATE gone tab'); return structuredClone(value); },
      async update(id, value) { calls.push(['activate', id, value]); }, async remove(id) { calls.push(['remove', id]); },
      async create(value) { calls.push(['create', value]); return { ...value, id: 100 }; } },
    history: { async search(input) { calls.push(['history', input]); return options.history || [{ id: 'history-a', url: 'https://history.test/', title: 'History' }]; } },
    bookmarks: { async search(input) { calls.push(['bookmarks', input]); return options.bookmarks || [{ id: 'bookmark-a', url: 'https://bookmark.test/', title: 'Bookmark' }]; } },
  };
  return { api, commands: createBrowserCommands({ api }), calls, grants, tabs, windows, set currentWindow(value) { currentWindowId = value; } };
}

test('permission status never prompts or queries browser content and dedicated grant starts synchronously', async () => {
  const f = fixture({ grants: [] });
  assert.deepEqual(await f.commands.browserCommandPermissions('history'), { available: true, granted: false, permission: 'history' });
  assert.deepEqual(f.calls, [['contains', { permissions: ['history'] }]]);
  const pending = f.commands.requestBrowserCommandPermission('history'); assert.equal(f.calls.at(-1)[0], 'request'); assert.equal(await pending, true);
  const denied = fixture({ grants: [], grantRequest: false }); assert.equal(await denied.commands.requestBrowserCommandPermission('bookmarks'), false);
});

test('unsupported APIs and missing optional permissions expose safe errors without requesting access', async () => {
  const absent = createBrowserCommands({ api: undefined }); assert.deepEqual(await absent.browserCommandPermissions('tabs'), { available: false, granted: false, permission: 'tabs' });
  const f = fixture({ grants: [] }); await assert.rejects(f.commands.searchBrowserCommands('tabs', ''), { code: 'BROWSER_PERMISSION' });
  assert.equal(f.calls.some(([name]) => ['queryTabs', 'request', 'history', 'bookmarks'].includes(name)), false);
});

test('Chrome hidden optional history/bookmark bindings still offer authorization before the grant', async () => {
  const f = fixture({ grants: [] }); f.api.runtime.getManifest = () => ({ optional_permissions: ['tabs', 'history', 'bookmarks'] });
  delete f.api.history; delete f.api.bookmarks;
  for (const source of ['history', 'bookmarks']) assert.deepEqual(await f.commands.browserCommandPermissions(source), { available: true, granted: false, permission: source });
  f.api.permissions.request = input => { const source = input.permissions[0]; f.grants.add(source); f.api[source] = { search: async () => [{ id: 'granted', title: 'Granted item', url: 'https://granted.test/' }] }; return Promise.resolve(true); };
  assert.equal(await f.commands.requestBrowserCommandPermission('history'), true);
  assert.equal((await f.commands.searchBrowserCommands('history', 'Granted'))[0].url, 'https://granted.test/');
});

test('history uses explicit nonempty query, retained-time range and thirty-result native bound', async () => {
  const f = fixture(); assert.deepEqual(await f.commands.searchBrowserCommands('history', ' \n '), []); assert.deepEqual(f.calls, []);
  const rows = await f.commands.searchBrowserCommands('history', ' earlier article ');
  assert.deepEqual(f.calls.find(([name]) => name === 'history'), ['history', { text: 'earlier article', startTime: 0, maxResults: 30 }]);
  assert.equal(rows[0].url, 'https://history.test/'); assert.equal(rows[0].source, 'history');
});

test('bookmark search excludes folders, credentials, private/internal schemes and caps plain metadata without icons', async () => {
  const values = [{ id: 'folder', title: 'Folder' }, { id: 'js', url: 'javascript:alert(1)' }, { id: 'credential', url: 'https://user:secret@example.test/' },
    ...Array.from({ length: 40 }, (_, n) => ({ id: String(n), url: `https://bookmarks.test/${n}`, title: `Page ${n}`, favIconUrl: 'https://tracker.test/favicon' }))];
  const f = fixture({ bookmarks: values }), rows = await f.commands.searchBrowserCommands('bookmarks', 'Page');
  assert.equal(rows.length, 30); assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'source', 'title', 'url']);
  assert.doesNotMatch(JSON.stringify(rows), /Folder|tracker|favicon|secret|javascript/); assert.deepEqual(f.calls.find(([name]) => name === 'bookmarks'), ['bookmarks', 'Page']);
});

test('open tab search matches every ordinary text term, preserves duplicate real tabs and excludes incognito/internal pages', async () => {
  const f = fixture({ tabs: [tab(1, { title: 'Research 中文' }), tab(2, { url: 'https://example.test/1', title: 'Research 中文 copy' }),
    tab(3, { incognito: true, title: 'PRIVATE Research 中文' }), tab(4, { url: 'chrome://settings', title: 'Research 中文' })] });
  const rows = await f.commands.searchBrowserCommands('tabs', 'Ｒesearch 中文 example.test');
  assert.equal(rows.length, 2); assert.notEqual(rows[0].id, rows[1].id); assert.equal(rows[0].url, rows[1].url);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|chrome:\/\//); assert.deepEqual(f.calls.find(([name]) => name === 'queryTabs'), ['queryTabs', { windowType: 'normal' }]);
});

test('normal current-window capture is complete, sorted and exposes excluded count without closing originals', async () => {
  const f = fixture({ tabs: [tab(2, { pinned: true }), tab(1), tab(3, { url: 'about:blank' })] });
  const snapshot = await f.commands.captureCurrentWindowSnapshot(); assert.equal(snapshot.rawCount, 3); assert.equal(snapshot.excludedCount, 1);
  assert.deepEqual(snapshot.tabs.map(tab => tab.id), [1, 2]); assert.equal(snapshot.tabs[1].pinned, true); assert.equal(snapshot.window.id, 10);
  assert.deepEqual(snapshot.tabIds, [1, 2, 3]);
  assert.equal(f.calls.some(([name]) => ['remove', 'create'].includes(name)), false);
});

test('capture refuses partial/ambiguous, private or navigating tab lists', async () => {
  for (const tabs of [[tab(1), tab(1)], [tab(1, { windowId: 20 })], [tab(1, { incognito: true })], [tab(1, { pendingUrl: 'https://new.test/' })]]) {
    const f = fixture({ tabs, query: async () => structuredClone(tabs) }); await assert.rejects(f.commands.queryCurrentWindowTabs(), error => ['BROWSER_COMMAND_INVALID', 'BROWSER_PRIVATE_WINDOW', 'BROWSER_TAB_CHANGED'].includes(error.code));
    assert.equal(f.calls.some(([name]) => name === 'create'), false);
  }
});

test('capture cap500 and global cap10000 reject rather than silently truncating dedup data', async () => {
  const f = fixture({ tabs: Array.from({ length: 501 }, (_, n) => tab(n)) }); await assert.rejects(f.commands.queryCurrentWindowTabs(), { code: 'BROWSER_COMMAND_LIMIT' });
  const global = fixture({ tabs: Array.from({ length: 10001 }, (_, n) => tab(n)) }); await assert.rejects(global.commands.queryOpenTabs(), { code: 'BROWSER_COMMAND_LIMIT' });
  assert.equal(BROWSER_COMMAND_LIMITS.results, 30);
});

test('all open-tabs query returns complete nonprivate metadata across normal windows for restore deduplication', async () => {
  const f = fixture({ tabs: [tab(1), tab(2, { windowId: 20 }), tab(3, { incognito: true }), tab(4, { url: 'file:///private' })] });
  const rows = await f.commands.queryOpenTabs(); assert.deepEqual(rows.map(tab => tab.id), [1, 2]);
  assert.deepEqual(f.calls.find(([name]) => name === 'queryTabs'), ['queryTabs', { windowType: 'normal' }]);
});

test('private extension context/current windows cannot read browser data, even when normal windows also exist', async () => {
  const f = fixture(); f.api.extension.inIncognitoContext = true;
  await assert.rejects(f.commands.searchBrowserCommands('history', 'private'), { code: 'BROWSER_PRIVATE_WINDOW' }); assert.deepEqual(f.calls, []);
  f.api.extension.inIncognitoContext = false; f.windows.get(10).incognito = true;
  await assert.rejects(f.commands.queryOpenTabs(), { code: 'BROWSER_PRIVATE_WINDOW' });
  await assert.rejects(f.commands.searchBrowserCommands('bookmarks', 'private'), { code: 'BROWSER_PRIVATE_WINDOW' });
  assert.equal(f.calls.some(([name]) => ['queryTabs', 'history', 'bookmarks'].includes(name)), false);
});

test('activation focuses the matching window then revalidates full tab identity before selecting it', async () => {
  const f = fixture({ tabs: [tab(7, { windowId: 20 })] }), [row] = await f.commands.searchBrowserCommands('tabs', '');
  await f.commands.activateBrowserTab(row);
  assert.deepEqual(f.calls.filter(([name]) => ['focusWindow', 'activate'].includes(name)), [['focusWindow', 20, { focused: true }], ['activate', 7, { active: true }]]);
  assert.equal(f.calls.filter(([name]) => name === 'getTab').length, 2);
});

test('stale URL, moved window, navigation target, closed/recycled or forged tab identities cannot be closed', async () => {
  for (const mutate of [tabs => { tabs[0].url = 'https://changed.test/'; }, tabs => { tabs[0].windowId = 20; }, tabs => { tabs[0].pendingUrl = 'https://pending.test/'; }, tabs => { tabs.length = 0; }, tabs => { tabs[0].incognito = true; }]) {
    const f = fixture(), [row] = await f.commands.searchBrowserCommands('tabs', ''); mutate(f.tabs);
    await assert.rejects(f.commands.closeBrowserTab(row), { code: 'BROWSER_TAB_CHANGED' }); assert.equal(f.calls.some(([name]) => name === 'remove'), false);
  }
  const f = fixture(), [row] = await f.commands.searchBrowserCommands('tabs', '');
  await assert.rejects(f.commands.closeBrowserTab(structuredClone(row)), { code: 'BROWSER_TAB_CHANGED' });
  await f.commands.closeBrowserTab(row); assert.deepEqual(f.calls.at(-1), ['remove', 1]);
  await assert.rejects(f.commands.closeBrowserTab(row), { code: 'BROWSER_TAB_CHANGED' });
});

test('tab changes during window focus and permission revocation stop the second activation step', async () => {
  const f = fixture({ focus: () => { f.tabs[0].url = 'https://changed.test/'; } }), [row] = await f.commands.searchBrowserCommands('tabs', '');
  await assert.rejects(f.commands.activateBrowserTab(row), { code: 'BROWSER_TAB_CHANGED' }); assert.equal(f.calls.some(([name]) => name === 'activate'), false);
  const revoked = fixture(), [target] = await revoked.commands.searchBrowserCommands('tabs', ''); revoked.grants.delete('tabs');
  await assert.rejects(revoked.commands.closeBrowserTab(target), { code: 'BROWSER_PERMISSION' }); assert.equal(revoked.calls.some(([name]) => name === 'remove'), false);
});

test('history/bookmark results open explicitly without requesting tabs access or copying page contents', async () => {
  const f = fixture({ grants: ['history'] }), [row] = await f.commands.searchBrowserCommands('history', 'earlier');
  await f.commands.openBrowserCommand(row); assert.deepEqual(f.calls.at(-1), ['create', { url: 'https://history.test/', active: true, windowId: 10 }]);
  assert.equal(f.calls.some(([name]) => ['queryTabs', 'request'].includes(name)), false);
  await assert.rejects(f.commands.openBrowserCommand({ source: 'history', url: 'https://forged.test/' }), { code: 'BROWSER_COMMAND_INVALID' });
});

test('session tab creation is inactive, pinned and bound to a revalidated normal target window', async () => {
  const f = fixture(); f.currentWindow = 20; await f.commands.createTab({ url: 'https://saved.test/#part', pinned: true, active: false, windowId: 10 });
  assert.deepEqual(f.calls.at(-1), ['create', { url: 'https://saved.test/#part', active: false, pinned: true, windowId: 10 }]);
  for (const input of [{ url: 'https://saved.test/', active: true }, { url: 'chrome://settings', active: false }, { url: 'https://user:secret@saved.test/', active: false }]) await assert.rejects(f.commands.createTab(input), { code: 'BROWSER_COMMAND_INVALID' });
  f.windows.get(10).incognito = true; await assert.rejects(f.commands.createTab({ url: 'https://saved.test/', active: false, windowId: 10 }), { code: 'BROWSER_PRIVATE_WINDOW' });
  f.grants.delete('tabs'); await assert.rejects(f.commands.createTab({ url: 'https://saved.test/', active: false, windowId: 20 }), { code: 'BROWSER_PERMISSION' });
  assert.equal(f.calls.filter(([name]) => name === 'create').length, 1);
});

test('late or already aborted queries never return results or trigger tab side effects', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }), controller = new AbortController();
  const f = fixture({ query: async () => { await gate; return [tab()]; } });
  const work = f.commands.searchBrowserCommands('tabs', '', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); release(); await assert.rejects(work, { name: 'AbortError' });
  const count = f.calls.length; await assert.rejects(f.commands.searchBrowserCommands('tabs', 'x', { signal: controller.signal }), { name: 'AbortError' }); assert.equal(f.calls.length, count);
});

test('session cancellation during native window validation and final guard failures create no tabs', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), f = fixture(), controller = new AbortController();
  f.api.windows.get = async () => { await gate; return { id: 10, incognito: false, type: 'normal' }; };
  const work = f.commands.createTab({ url: 'https://saved.test/', active: false, windowId: 10 }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); release();
  await assert.rejects(work, { name: 'AbortError' }); assert.equal(f.calls.some(([name]) => name === 'create'), false);
  const guarded = fixture();
  for (const code of ['BROWSER_SESSION_STALE', 'PRIVACY_LOCKED']) await assert.rejects(guarded.commands.createTab({ url: 'https://saved.test/', active: false, windowId: 10 }, {
    beforeCreate: async () => { throw Object.assign(Error('Safe session guard'), { code }); },
  }), { code });
  assert.equal(guarded.calls.some(([name]) => name === 'create'), false);
});

test('an already-issued native create keeps its success receipt when cancellation arrives during completion', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }), f = fixture(), controller = new AbortController();
  f.api.tabs.create = async value => { f.calls.push(['issuedCreate', value]); await gate; return { id: 123, ...value }; };
  const work = f.commands.createTab({ url: 'https://saved.test/', active: false, windowId: 10 }, { signal: controller.signal, beforeCreate: async () => {} });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.some(([name]) => name === 'issuedCreate'), true);
  controller.abort(); release(); assert.equal((await work).id, 123);
});

test('permission events invalidate transient UI state and remove both listeners on cleanup', () => {
  const f = fixture(); let count = 0; const off = f.commands.subscribeBrowserCommandPermissions(() => count++);
  f.api.permissions.onAdded.emit({ permissions: ['tabs'] }); f.api.permissions.onRemoved.emit({ permissions: ['tabs'] }); assert.equal(count, 2);
  off(); assert.equal(f.api.permissions.onAdded.size, 0); assert.equal(f.api.permissions.onRemoved.size, 0);
});

test('raw browser failures never reveal URL, credential or native error details', async () => {
  const f = fixture({ query: async () => { throw Error('PRIVATE https://secret.test/ token=credential'); } });
  await assert.rejects(f.commands.searchBrowserCommands('tabs', ''), error => error.code === 'BROWSER_COMMAND_FAILED' && !/PRIVATE|secret|credential/u.test(error.message));
  for (const value of ['javascript:alert(1)', 'chrome://settings/', 'about:blank', 'file:///secret', 'data:text/plain,x', 'https://user:pw@example.test/', 'https://example.test/a b']) assert.equal(browserCommandUrl(value), null);
  assert.equal(browserCommandUrl('https://EXAMPLE.test:443/a?q=1#part'), 'https://example.test/a?q=1#part');
});
