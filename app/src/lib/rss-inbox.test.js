import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createLocalData } from './local-data.js';
import { createRssInbox, normalizeRssFeedUrl, parseRssFeed, rssFeedOrigin, RSS_ALARM, RSS_INBOX_KEY, RSS_LIMITS } from './rss-inbox.js';

const address = 'https://feeds.example/news.xml';
const entry = (id, extra = '') => `<item><title>Title ${id}</title><link>https://articles.example/${id}</link><description><![CDATA[<p>Summary ${id}</p>]]></description>${extra}</item>`;
const rss = (items = [entry('one')]) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>My feed</title>${items.join('')}</channel></rss>`;
function fixture(options = {}) {
  let state = null, clock = 1000000, sequence = 0, xml = rss(), permission = true, failWrite = false, failAlarm = false;
  const listeners = new Set(), requests = [], permissions = [], schedules = [], readings = [], readingCalls = [];
  const store = {
    async read() { return structuredClone(state); },
    async write(value) { if (failWrite) throw Error('PRIVATE storage path'); state = structuredClone(value); for (const listener of listeners) listener(structuredClone(state)); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const alarms = { async get() { if (failAlarm) throw Error('PRIVATE alarm error'); return schedules.at(-1); }, async create(name, value) { if (failAlarm) throw Error('PRIVATE alarm error'); schedules.push({ name, scheduledTime: value.when }); }, async clear(name) { schedules.push({ name, cleared: true }); } };
  const api = createRssInbox({ store, alarms, crypto: webcrypto, locks: null, now: () => clock, uuid: () => `feed-${++sequence}`,
    hasPermission: async (origin) => { permissions.push(origin); return permission; },
    fetcher: async (url, init) => { requests.push({ url, init }); return options.fetcher ? options.fetcher(url, init) : new Response(xml, { headers: { 'content-type': 'application/rss+xml' } }); },
    readReading: async () => structuredClone(readings),
    saveReading: async (input, settings) => { readingCalls.push({ input, settings }); const record = { ...input, id: `reading-${readings.length + 1}`, revision: 1 }; readings.push(record); return record; },
    ...options,
  });
  return { api, store, requests, permissions, schedules, readings, readingCalls, get state() { return state; }, set state(value) { state = value; },
    set xml(value) { xml = value; }, set permission(value) { permission = value; }, set now(value) { clock = value; }, get now() { return clock; },
    set failWrite(value) { failWrite = value; }, set failAlarm(value) { failAlarm = value; } };
}

test('RSS 2 captures only bounded plain summaries and links, never encoded article bodies or resources', () => {
  const xml = rss([entry('one', '<content:encoded xmlns:content="x"><![CDATA[SECRET FULL ARTICLE]]></content:encoded>'),
    '<item><title>Unsafe</title><link>javascript:alert(1)</link></item>', entry('one'),
    '<item><title>A &amp; B</title><guid isPermaLink="true">/two#section</guid><description><![CDATA[<script>SECRET SCRIPT</script><img src="https://tracker.example/x"><p>Safe &nbsp; summary</p>]]></description><pubDate>Tue, 24 Nov 2026 01:00:00 GMT</pubDate></item>']);
  const parsed = parseRssFeed(xml, { url: address });
  assert.equal(parsed.title, 'My feed'); assert.equal(parsed.items.length, 2);
  assert.deepEqual(parsed.items[0], { url: 'https://articles.example/one', title: 'Title one', summary: 'Summary one', publishedAt: null });
  assert.equal(parsed.items[1].url, 'https://feeds.example/two'); assert.equal(parsed.items[1].summary, 'Safe summary');
  assert.equal(parsed.items[1].publishedAt, Date.parse('2026-11-24T01:00:00Z'));
  assert.doesNotMatch(JSON.stringify(parsed), /SECRET|tracker|<|src=/);
});

test('Atom supports namespaced tags, nested xml:base and summary without falling back to full content', () => {
  const xml = '<a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="/stories/"><a:title>Atom</a:title><a:entry xml:base="nested/"><a:title>Entry</a:title><a:link rel="self" href="self"/><a:link rel="alternate" href="article"/><a:summary type="html">&lt;b&gt;Summary&lt;/b&gt;</a:summary><a:content>PRIVATE BODY</a:content><a:updated>2026-11-25T00:00:00Z</a:updated></a:entry><a:entry><a:title>No summary</a:title><a:link href="second"/><a:content>PRIVATE BODY</a:content></a:entry></a:feed>';
  const parsed = parseRssFeed(xml, { url: address });
  assert.equal(parsed.items[0].url, 'https://feeds.example/stories/nested/article');
  assert.equal(parsed.items[0].summary, 'Summary'); assert.equal(parsed.items[1].summary, '');
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE/);
});

test('worker parser rejects malformed XML, DTDs and undeclared entities without DOMParser', () => {
  const bad = ['<rss><channel></rss>', '<rss><channel></channel>', '<rss><channel/></rss><rss/>',
    '<!DOCTYPE rss SYSTEM "https://tracker.example/entity"><rss><channel/></rss>',
    '<!DOCTYPE rss [<!ENTITY secret "x">]><rss><channel/></rss>',
    '<rss><channel><title>&secret;</title></channel></rss>', '<rss><channel><title>&#0;</title></channel></rss>',
    '<rss><channel bad="<raw"/></rss>', '<rss><channel><![CDATA[missing</channel></rss>', '<rss><channel>]]></channel></rss>',
    '<html><body>Not a feed</body></html>', '<rss><channel/><channel/></rss>', '<rss><channel a="1" a="2"/></rss>'];
  for (const xml of bad) assert.throws(() => parseRssFeed(xml, { url: address }), (error) => error.code === 'RSS_FORMAT', xml);
});

test('parser bounds input, depth, entries and Unicode summary bytes', () => {
  assert.throws(() => parseRssFeed(' '.repeat(RSS_LIMITS.feedBytes + 1), { url: address }), { code: 'RSS_TOO_LARGE' });
  assert.throws(() => parseRssFeed(`<rss><channel>${'<x>'.repeat(33)}${'</x>'.repeat(33)}</channel></rss>`, { url: address }), { code: 'RSS_TOO_LARGE' });
  assert.throws(() => parseRssFeed(rss(Array.from({ length: 1001 }, (_, n) => entry(n))), { url: address }), { code: 'RSS_TOO_LARGE' });
  const value = parseRssFeed(rss([`<item><link>https://articles.example/long</link><description>${'汉🙂'.repeat(3000)}</description></item>`]), { url: address }).items[0].summary;
  assert.ok(new TextEncoder().encode(value).length <= 8192); assert.doesNotMatch(value, /\uFFFD/);
  assert.equal(parseRssFeed(rss(Array.from({ length: 101 }, (_, n) => entry(n))), { url: address }).items.length, 100);
});

test('URL validation permits only explicit HTTP(S) feed URLs and computes the exact permission origin', () => {
  assert.equal(normalizeRssFeedUrl(' https://feeds.example/news.xml#part '), address);
  assert.equal(rssFeedOrigin('https://feeds.example:8443/news.xml'), 'https://feeds.example:8443');
  for (const url of ['file:///C:/private', 'javascript:alert(1)', '//feeds.example/x', 'https://user:secret@feeds.example/x', 'https://feeds.example/a b', 'https://feeds.example\\x']) {
    assert.throws(() => normalizeRssFeedUrl(url), { code: 'RSS_INVALID_URL' });
  }
});

test('load, subscription and worker restoration perform no fetch; denied permission never requests access', async () => {
  const f = fixture(), changes = [], unsubscribe = f.api.subscribe((state) => changes.push(state));
  assert.equal((await f.api.load()).feeds.length, 0); await f.api.restoreSchedule(); assert.equal(f.requests.length, 0);
  f.permission = false; await assert.rejects(f.api.add({ url: address }), { code: 'RSS_PERMISSION' });
  assert.equal(f.state, null); assert.equal(f.requests.length, 0); assert.deepEqual(f.permissions, ['https://feeds.example']);
  f.permission = true; const feed = await f.api.add({ url: address });
  assert.equal(feed.lastError, null); assert.ok(changes.length >= 2); unsubscribe();
  const before = changes.length; await f.api.refresh(feed.id); assert.equal(changes.length, before);
});

test('subscribed feed requests omit credentials and referrers, reject redirects, and never fetch article URLs', async () => {
  const f = fixture(), feed = await f.api.add({ url: address });
  assert.equal(f.requests.length, 1); const { url, init } = f.requests[0]; assert.equal(url, address);
  assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.referrer, '');
  assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  assert.ok(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, true);
  f.permission = false; const status = await f.api.refresh(feed.id); assert.equal(f.requests.length, 1);
  assert.equal(status.feeds[0].lastError.code, 'RSS_PERMISSION'); assert.equal(status.items.length, 1);
  const redirect = fixture({ fetcher: async () => ({ ok: true, redirected: false, url: 'https://other.example/feed', body: null }) });
  assert.equal((await redirect.api.add({ url: address })).lastError.code, 'RSS_NETWORK');
});

test('malformed and failed refreshes retain exact existing inbox records and expose safe persistent failures', async () => {
  const f = fixture(), feed = await f.api.add({ url: address }), old = structuredClone(f.state.items);
  f.now += 60000; f.xml = '<rss><channel><item></channel>';
  const result = await f.api.refresh(feed.id); assert.deepEqual(f.state.items, old);
  assert.equal(result.feeds[0].lastError.code, 'RSS_FORMAT'); assert.equal(result.feeds[0].lastSuccess, 1000000);
  assert.equal(result.feeds[0].lastChecked, f.now); assert.equal(result.feeds[0].nextDue, f.now + 3600000);
  assert.match(result.feeds[0].lastError.message, /已有条目/);
  f.xml = rss([entry('two')]); const repaired = await f.api.refresh(feed.id);
  assert.equal(repaired.feeds[0].lastError, null); assert.equal(repaired.items.length, 2);
  const broken = fixture({ fetcher: async () => { throw Error('PRIVATE credential network path'); } });
  const badFeed = await broken.api.add({ url: address }); assert.equal(badFeed.lastError.code, 'RSS_NETWORK');
  assert.doesNotMatch(JSON.stringify(badFeed), /PRIVATE|credential/);
});

test('bounded response streams and timeout failures preserve earlier state even if an abandoned fetch later returns', async () => {
  for (const response of [() => new Response('x', { headers: { 'content-length': String(RSS_LIMITS.feedBytes + 1) } }),
    () => new Response(new Uint8Array(RSS_LIMITS.feedBytes + 1)), () => new Response(new Uint8Array([0xff, 0xfe]))]) {
    const f = fixture({ fetcher: async () => response() }), feed = await f.api.add({ url: address });
    assert.ok(['RSS_TOO_LARGE', 'RSS_FORMAT'].includes(feed.lastError.code)); assert.equal(f.state.items.length, 0);
  }
  let release;
  const f = fixture({ timeoutMs: 5, fetcher: async () => new Promise((resolve) => { release = resolve; }) });
  const feed = await f.api.add({ url: address }); assert.equal(feed.lastError.code, 'RSS_TIMEOUT');
  const before = structuredClone(f.state); release(new Response(rss())); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.state, before);
});

test('deduplication and rolling inbox limits never alter saved reading records, including after source removal', async () => {
  const f = fixture(); f.xml = rss(Array.from({ length: 100 }, (_, n) => entry(`a-${n}`)));
  const feed = await f.api.add({ url: address }); const first = (await f.api.load()).items[0];
  await f.api.save(first.id); assert.equal(f.readings.length, 1);
  f.xml = rss([entry('a-0'), entry('newest')]); await f.api.refresh(feed.id);
  assert.equal(f.state.items.length, 100); assert.equal(new Set(f.state.items.map((item) => item.url)).size, 100);
  assert.ok(f.state.items.some((item) => item.url.endsWith('/newest')));
  for (let n = 1; n <= 5; n++) { f.xml = rss(Array.from({ length: 100 }, (_, item) => entry(`${n}-${item}`))); await f.api.add({ url: `https://feed-${n}.example/rss` }); }
  assert.equal(f.state.items.length, 500); assert.equal(f.readings.length, 1);
  await f.api.remove(feed.id); assert.equal(f.readings.length, 1); assert.equal(f.state.items.some((item) => item.feedId === feed.id), false);
});

test('feed count and interval limits stop before network or a persistence mutation', async () => {
  const f = fixture(); f.xml = rss([]);
  for (let n = 0; n < 20; n++) await f.api.add({ url: `https://feed-${n}.example/rss` });
  const before = structuredClone(f.state), calls = f.requests.length;
  await assert.rejects(f.api.add({ url: 'https://overflow.example/rss' }), { code: 'RSS_CAPACITY' });
  await assert.rejects(f.api.add({ url: address, intervalMinutes: 14 }), { code: 'RSS_CAPACITY' });
  await assert.rejects(f.api.add({ url: address, intervalMinutes: 10081 }), { code: 'RSS_CAPACITY' });
  assert.equal(f.requests.length, calls); assert.deepEqual(f.state, before);
});

test('saving an inbox entry is link-only and reuses existing reading records without changing private titles', async () => {
  const f = fixture(); await f.api.add({ url: address }); const item = (await f.api.load()).items[0];
  const saved = await f.api.save(item.id); assert.equal(saved.id, 'reading-1'); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.readingCalls, [{ input: { url: item.url, title: item.title }, settings: { extract: false } }]);
  f.readings[0].title = 'PRIVATE local title'; f.readings[0].revision = 8;
  const reused = await f.api.save(item.id); assert.equal(reused.revision, 8); assert.equal(reused.title, item.title);
  assert.equal(f.readingCalls.length, 1); assert.equal(f.readings[0].title, 'PRIVATE local title');
  assert.doesNotMatch(JSON.stringify(f.state), /PRIVATE/); assert.equal(f.state.items[0].savedReadingId, saved.id);
});

test('valid long RSS titles are safely reduced to the normal reading title limit when saving', async () => {
  const f = fixture(); const title = `${'a'.repeat(199)}🙂${'b'.repeat(100)}`;
  f.xml = rss([`<item><title>${title}</title><link>https://articles.example/long-title</link></item>`]);
  await f.api.add({ url: address }); const item = (await f.api.load()).items[0]; await f.api.save(item.id);
  assert.equal(item.title, title); assert.equal(f.readingCalls[0].input.title, 'a'.repeat(199));
});

test('read-later save failure and encrypted-store failures retain inbox contents for retry', async () => {
  const f = fixture({ saveReading: async () => { throw Error('PRIVATE reading failure'); } });
  await f.api.add({ url: address }); const item = (await f.api.load()).items[0], before = structuredClone(f.state);
  await assert.rejects(f.api.save(item.id), { code: 'RSS_READING' }); assert.deepEqual(f.state, before);
  f.failWrite = true; await assert.rejects(f.api.remove(before.feeds[0].id), { code: 'RSS_STORAGE' }); assert.deepEqual(f.state, before);
});

test('one-shot alarms refresh only due subscriptions and restore durably without initiating requests', async () => {
  const f = fixture(), first = await f.api.add({ url: address, intervalMinutes: 15 }), second = await f.api.add({ url: 'https://other-feed.example/rss', intervalMinutes: 60 });
  assert.equal(f.schedules.at(-1).name, RSS_ALARM); assert.equal(f.schedules.at(-1).scheduledTime, f.now + 15 * 60000);
  const count = f.requests.length; await f.api.restoreSchedule(); await f.api.refreshDue(); assert.equal(f.requests.length, count);
  f.now += 15 * 60000; await f.api.refreshDue(); assert.equal(f.requests.length, count + 1); assert.equal(f.requests.at(-1).url, address);
  assert.equal(f.state.feeds.find((feed) => feed.id === second.id).lastChecked, 1000000);
  assert.equal(f.state.feeds.find((feed) => feed.id === first.id).lastChecked, f.now);
  const restarted = createRssInbox({ store: f.store, crypto: webcrypto, locks: null, now: () => f.now, fetcher: () => assert.fail('restoration must not fetch'), alarms: { get: async () => null, create: async () => {} } });
  assert.deepEqual((await restarted.restoreSchedule()).items, (await f.api.load()).items);
  f.failAlarm = true; f.now += 10000; await assert.rejects(f.api.restoreSchedule(), { code: 'RSS_SCHEDULE' });
  assert.equal(f.state.lastError.code, 'RSS_SCHEDULE');
  f.failAlarm = false; await f.api.restoreSchedule(); assert.equal(f.state.lastError, null);
});

test('persistent state validation refuses unknown body or credential fields rather than forwarding them to UI', async () => {
  const f = fixture(); await f.api.add({ url: address });
  for (const mutate of [(state) => { state.password = 'PRIVATE'; }, (state) => { state.items[0].body = 'PRIVATE'; },
    (state) => { state.feeds[0].token = 'PRIVATE'; }, (state) => { state.lastError = { code: 'RSS_NETWORK', at: 1, input: 'PRIVATE' }; }]) {
    const before = structuredClone(f.state); mutate(f.state); await assert.rejects(f.api.load(), { code: 'RSS_STORAGE' }); f.state = before;
  }
});

test('RSS config and summaries use actual encrypted device storage and survive a fresh controller instance', async () => {
  const records = new Map(); let key;
  const backend = { getKey: async () => key, ensureKey: async (candidate) => key ||= candidate,
    get: async (id) => structuredClone(records.get(id)), entries: async (space) => [...records.values()].filter((record) => space === undefined || record.space === space).map((value) => structuredClone(value)),
    put: async (writes) => { for (const value of writes) records.set(value.id, structuredClone(value)); }, remove: async (ids) => { for (const id of ids) records.delete(id); },
    commit: async (writes, removes) => { for (const id of removes) records.delete(id); for (const value of writes) records.set(value.id, structuredClone(value)); } };
  const persistence = createLocalData({ crypto: webcrypto, backend, databaseName: 'rss-encrypted-test', legacyLocal: null, localStorage: null, broadcastChannel: null });
  const store = { read: async () => (await persistence.localData.get(RSS_INBOX_KEY))[RSS_INBOX_KEY], write: async (state) => persistence.localData.set({ [RSS_INBOX_KEY]: state }) };
  try {
    const api = createRssInbox({ store, crypto: webcrypto, locks: null, hasPermission: async () => true, fetcher: async () => new Response(rss([entry('PRIVATE-SENTINEL')])), alarms: { get: async () => null, create: async () => {} } });
    await api.add({ url: 'https://private-feed.example/rss' });
    const restarted = createRssInbox({ store, crypto: webcrypto, locks: null }); assert.equal((await restarted.load()).items[0].summary, 'Summary PRIVATE-SENTINEL');
    assert.equal(key.extractable, false);
    for (const value of records.values()) { assert.doesNotMatch(JSON.stringify(value), /PRIVATE|private-feed|rss\.inbox/); assert.doesNotMatch(Buffer.from(value.ciphertext).toString('utf8'), /PRIVATE|private-feed/); }
    assert.equal((await persistence.syncDataStore.snapshot()).records.some((record) => record.key === RSS_INBOX_KEY), false);
  } finally { await persistence.close(); }
});
