import { tr } from '../i18n/index.js';
import { fetchWithFirefoxDataConsent } from './firefox-data-consent.js';
import { getExtensionApi } from './extension-api.js';
import { localData } from './local-data.js';
import { loadPersonalToolsSnapshot, saveReadingItem } from './personal-tools.js';

export const RSS_INBOX_KEY = 'covelet.rss.inbox.v1';
export const RSS_ALARM = 'covelet:rss:due';
export const RSS_LIMITS = Object.freeze({ feeds: 20, items: 500, feedItems: 100, summaryBytes: 8192, feedBytes: 2 * 1024 * 1024,
  nodes: 15000, depth: 32, minIntervalMinutes: 15, maxIntervalMinutes: 10080, timeoutMs: 15000 });
const LOCK = 'covelet.rss.inbox.write.v1', encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const copy = (value) => structuredClone(value), identity = (value) => typeof value === 'string' && /^[a-z\d-]{1,100}$/iu.test(value);
const time = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const messages = {
  RSS_INVALID_URL: '请填写有效的 HTTP 或 HTTPS 订阅地址。', RSS_PERMISSION: '请先授权访问此订阅来源。',
  RSS_CAPACITY: '订阅或收件箱已达到容量上限。', RSS_FORMAT: '订阅内容格式无效，已有条目已保留。',
  RSS_TOO_LARGE: '订阅内容过大，已有条目已保留。', RSS_NETWORK: '订阅更新失败，请检查网络后重试。',
  RSS_TIMEOUT: '订阅更新超时，已有条目已保留。', RSS_STORAGE: '订阅未能保存，请重试。',
  RSS_MISSING: '此订阅或条目已被移除。', RSS_DUPLICATE: '此订阅来源已添加。',
  RSS_SCHEDULE: '无法安排订阅更新，请稍后重试。', RSS_READING: '未能加入稍后读，请重试。',
};
const failure = (code) => Object.assign(Error(tr(messages[code] || messages.RSS_NETWORK)), { code });
const fail = (code = 'RSS_FORMAT') => { throw failure(code); };
const safeError = (reason, fallback = 'RSS_NETWORK') => failure(Object.hasOwn(messages, reason?.code) ? reason.code : fallback);
const utf8 = (text, maximum) => {
  let size = 0, result = '';
  for (const char of String(text)) { const length = encoder.encode(char).length; if (size + length > maximum) break; size += length; result += char; }
  return result;
};
export function normalizeRssFeedUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u0020\u007f\\]/u.test(value.trim())) fail('RSS_INVALID_URL');
  let url; try { url = new URL(value.trim(), base); } catch { fail('RSS_INVALID_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.href.length > 4096) fail('RSS_INVALID_URL');
  url.hash = ''; return url.href;
}
export const rssFeedOrigin = (url) => new URL(normalizeRssFeedUrl(url)).origin;

function xmlText(value) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value)) fail();
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity) => {
    if (entity[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || !(code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0xd7ff
      || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) fail();
    return String.fromCodePoint(code);
  });
}

// Inert, bounded XML parsing for workers. No DOM, DTD, resource resolution or
// HTML execution is involved. CDATA is accepted as text, as ordinary RSS uses it.
function xmlTree(source, baseUrl) {
  if (typeof source !== 'string' || encoder.encode(source).length > RSS_LIMITS.feedBytes) fail('RSS_TOO_LARGE');
  const text = source.replace(/^\uFEFF/, '');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text) || /<!DOCTYPE|<!ENTITY/i.test(text)) fail();
  const roots = [], stack = []; let offset = 0, nodes = 0, declaration = false;
  const validName = (value) => /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(value);
  while (offset < text.length) {
    if (text[offset] !== '<') {
      const end = text.indexOf('<', offset), value = text.slice(offset, end === -1 ? text.length : end);
      if (value.includes(']]>')) fail();
      if (stack.length) stack.at(-1).parts.push(xmlText(value)); else if (value.trim()) fail();
      offset = end === -1 ? text.length : end; continue;
    }
    if (text.startsWith('<!--', offset)) {
      const end = text.indexOf('-->', offset + 4); if (end === -1 || text.slice(offset + 4, end).includes('--')) fail();
      offset = end + 3; continue;
    }
    if (text.startsWith('<![CDATA[', offset)) {
      const end = text.indexOf(']]>', offset + 9); if (end === -1 || !stack.length) fail();
      stack.at(-1).parts.push(text.slice(offset + 9, end)); offset = end + 3; continue;
    }
    if (text.startsWith('<?xml', offset)) {
      const end = text.indexOf('?>', offset + 5);
      if (end === -1 || declaration || roots.length || stack.length || !/^<\?xml\s+version\s*=\s*(['"])1\.[01]\1(?:\s+encoding\s*=\s*(['"])UTF-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>$/i.test(text.slice(offset, end + 2))) fail();
      declaration = true; offset = end + 2; continue;
    }
    let end = offset + 1, quote = null;
    for (; end < text.length; end++) {
      if (quote) { if (text[end] === quote) quote = null; }
      else if (['"', "'"].includes(text[end])) quote = text[end];
      else if (text[end] === '>') break; else if (text[end] === '<') fail();
    }
    if (end === text.length || quote) fail();
    let token = text.slice(offset + 1, end); offset = end + 1;
    if (token.startsWith('/')) {
      if (!stack.length || token.slice(1).trim() !== stack.at(-1).qualified) fail(); stack.pop(); continue;
    }
    if (token.startsWith('!') || token.startsWith('?')) fail();
    const closed = token.endsWith('/'); if (closed) token = token.slice(0, -1);
    const match = /^([^\s]+)([\s\S]*)$/.exec(token); if (!match || !validName(match[1])) fail();
    const attrs = {}; let consumed = 0;
    while (consumed < match[2].length) {
      const rest = match[2].slice(consumed); if (!rest.trim()) break;
      const attr = /^\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      if (!attr || !validName(attr[1]) || Object.hasOwn(attrs, attr[1]) || Object.keys(attrs).length >= 40) fail();
      const raw = attr[2] ?? attr[3]; if (raw.includes('<')) fail();
      const value = xmlText(raw); if (value.length > 8192) fail('RSS_TOO_LARGE');
      Object.defineProperty(attrs, attr[1], { value, enumerable: true }); consumed += attr[0].length;
    }
    if (++nodes > RSS_LIMITS.nodes || stack.length >= RSS_LIMITS.depth) fail('RSS_TOO_LARGE');
    let base = stack.at(-1)?.base || baseUrl;
    if (attrs['xml:base']) { try { base = new URL(attrs['xml:base'], base).href; } catch { fail(); } }
    const node = { name: match[1].split(':').at(-1).toLowerCase(), qualified: match[1], attrs, children: [], parts: [], base };
    if (stack.length) { stack.at(-1).children.push(node); stack.at(-1).parts.push(node); } else roots.push(node);
    if (!closed) stack.push(node);
  }
  if (stack.length || roots.length !== 1) fail(); return roots[0];
}
const textOf = (node) => node ? node.parts.map((part) => typeof part === 'string' ? part : textOf(part)).join('') : '';
const child = (node, name) => node.children.find((item) => item.name === name);
function plainText(value, maximum) {
  const input = String(value), lower = input.toLowerCase(); let result = '', index = 0;
  while (index < input.length) {
    if (input[index] !== '<') { const end = input.indexOf('<', index); result += input.slice(index, end === -1 ? input.length : end); index = end === -1 ? input.length : end; continue; }
    const end = input.indexOf('>', index + 1); if (end === -1) { result += input.slice(index); break; }
    const token = input.slice(index + 1, end).trim().toLowerCase(), blocked = /^(script|style)(?:\s|$)/.exec(token);
    if (blocked) { const closing = lower.indexOf(`</${blocked[1]}`, end + 1), closeEnd = closing < 0 ? -1 : input.indexOf('>', closing); index = closeEnd < 0 ? input.length : closeEnd + 1; }
    else { result += ' '; index = end + 1; }
  }
  result = result.replace(/&(nbsp|hellip|ndash|mdash|copy|amp|lt|gt|quot|apos);/gi, (_, name) => ({ nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', copy: '©', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name.toLowerCase()]);
  return utf8(result.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim(), maximum);
}
export function parseRssFeed(source, { url } = {}) {
  const feedUrl = normalizeRssFeedUrl(url), root = xmlTree(source, feedUrl), atom = root.name === 'feed';
  let container;
  if (atom) container = root;
  else if (root.name === 'rss' && root.children.filter((item) => item.name === 'channel').length === 1) container = child(root, 'channel');
  else fail();
  const entries = container.children.filter((node) => node.name === (atom ? 'entry' : 'item'));
  if (entries.length > 1000) fail('RSS_TOO_LARGE');
  const items = [], seen = new Set();
  for (const entry of entries) {
    const link = atom ? entry.children.find((item) => item.name === 'link' && (!item.attrs.rel || item.attrs.rel === 'alternate') && item.attrs.href) : child(entry, 'link');
    let address = atom ? link?.attrs.href : textOf(link).trim();
    if (!address && !atom) { const guid = child(entry, 'guid'); if (guid && guid.attrs.isPermaLink !== 'false') address = textOf(guid).trim(); }
    let normalized;
    try { normalized = normalizeRssFeedUrl(address, link?.base ? new URL(link.base, feedUrl).href : feedUrl); } catch { continue; }
    if (seen.has(normalized)) continue; seen.add(normalized);
    const summary = plainText(textOf(child(entry, atom ? 'summary' : 'description')), RSS_LIMITS.summaryBytes);
    const dateText = textOf(child(entry, atom ? 'published' : 'pubdate') || child(entry, 'updated') || child(entry, 'date')).trim();
    const published = Date.parse(dateText);
    items.push({ url: normalized, title: plainText(textOf(child(entry, 'title')), 800) || normalized, summary,
      publishedAt: time(published) ? published : null });
  }
  return { title: plainText(textOf(child(container, 'title')), 800) || new URL(feedUrl).hostname, items: items.slice(0, RSS_LIMITS.feedItems) };
}

const empty = () => ({ version: 1, revision: 0, feeds: [], items: [], lastError: null });
const fields = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const validError = (value) => value === null || fields(value, ['code', 'at']) && Object.hasOwn(messages, value.code) && time(value.at);
function checked(input) {
  const state = input ? copy(input) : empty(), ids = new Set(), urls = new Set();
  if (!fields(state, ['version', 'revision', 'feeds', 'items', 'lastError']) || !validError(state.lastError)
    || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.feeds) || state.feeds.length > RSS_LIMITS.feeds
    || !Array.isArray(state.items) || state.items.length > RSS_LIMITS.items) fail('RSS_STORAGE');
  for (const feed of state.feeds) {
    if (!fields(feed, ['id', 'url', 'title', 'intervalMinutes', 'addedAt', 'lastChecked', 'lastSuccess', 'nextDue', 'lastError'])
      || !identity(feed.id) || ids.has(feed.id) || normalizeRssFeedUrl(feed.url) !== feed.url || urls.has(feed.url) || typeof feed.title !== 'string'
      || encoder.encode(feed.title).length > 800 || !time(feed.addedAt) || !Number.isSafeInteger(feed.intervalMinutes)
      || feed.intervalMinutes < RSS_LIMITS.minIntervalMinutes || feed.intervalMinutes > RSS_LIMITS.maxIntervalMinutes
      || !time(feed.nextDue) || feed.lastChecked !== null && !time(feed.lastChecked) || feed.lastSuccess !== null && !time(feed.lastSuccess)
      || !validError(feed.lastError)) fail('RSS_STORAGE');
    ids.add(feed.id); urls.add(feed.url);
  }
  const itemIds = new Set(), counts = new Map();
  for (const item of state.items) {
    if (!fields(item, ['id', 'feedId', 'url', 'title', 'summary', 'publishedAt', 'receivedAt', 'savedReadingId'])
      || !identity(item.id) || itemIds.has(item.id) || !ids.has(item.feedId) || normalizeRssFeedUrl(item.url) !== item.url || typeof item.title !== 'string'
      || encoder.encode(item.title).length > 800 || typeof item.summary !== 'string' || encoder.encode(item.summary).length > RSS_LIMITS.summaryBytes
      || !time(item.receivedAt) || item.publishedAt !== null && !time(item.publishedAt) || item.savedReadingId !== null && !identity(item.savedReadingId)) fail('RSS_STORAGE');
    itemIds.add(item.id); counts.set(item.feedId, (counts.get(item.feedId) || 0) + 1);
  }
  if ([...counts.values()].some((count) => count > RSS_LIMITS.feedItems)) fail('RSS_STORAGE');
  return state;
}
function publicState(state) {
  const result = copy(state); result.items.reverse();
  for (const feed of result.feeds) if (feed.lastError) feed.lastError.message = tr(messages[feed.lastError.code]);
  if (result.lastError) result.lastError.message = tr(messages[result.lastError.code]);
  return result;
}
const defaultStore = {
  async read() { return (await localData.get(RSS_INBOX_KEY))[RSS_INBOX_KEY] || null; },
  write(value) { return localData.set({ [RSS_INBOX_KEY]: value }); },
  subscribe(listener) { return localData.subscribe((changes) => { if (changes[RSS_INBOX_KEY]) listener(changes[RSS_INBOX_KEY].newValue); }); },
};
async function defaultPermission(origin) {
  try { return await getExtensionApi()?.permissions?.contains({ origins: [`${origin}/*`] }) === true; } catch { return false; }
}
async function readBody(response) {
  const size = response.headers?.get('content-length');
  if (size != null && (!/^\d+$/.test(size) || Number(size) > RSS_LIMITS.feedBytes)) { await response.body?.cancel().catch(() => {}); fail('RSS_TOO_LARGE'); }
  if (!response.body?.getReader) { const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length > RSS_LIMITS.feedBytes) fail('RSS_TOO_LARGE'); return bytes; }
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > RSS_LIMITS.feedBytes) { await reader.cancel(); fail('RSS_TOO_LARGE'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}

export function createRssInbox({ store = defaultStore, fetcher = (...args) => fetchWithFirefoxDataConsent('rss', ...args), hasPermission = defaultPermission,
  saveReading = saveReadingItem, readReading = async () => (await loadPersonalToolsSnapshot()).reading,
  alarms = getExtensionApi()?.alarms, now = () => Date.now(), crypto = globalThis.crypto, uuid = () => crypto.randomUUID(), locks = globalThis.navigator?.locks,
  timeoutMs = RSS_LIMITS.timeoutMs } = {}) {
  let queue = Promise.resolve();
  const exclusive = (action) => {
    if (locks?.request) return locks.request(LOCK, { mode: 'exclusive' }, action);
    if (globalThis.chrome?.runtime?.id) return Promise.reject(failure('RSS_STORAGE'));
    const flight = queue.catch(() => {}).then(action); queue = flight.catch(() => {}); return flight;
  };
  const read = async () => { try { return checked(await store.read()); } catch (reason) { throw safeError(reason, 'RSS_STORAGE'); } };
  const save = async (state) => { if (state.revision >= Number.MAX_SAFE_INTEGER) fail('RSS_CAPACITY'); state.revision++; try { await store.write(checked(state)); } catch (reason) { throw safeError(reason, 'RSS_STORAGE'); } };
  const hash = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  async function schedule(state) {
    try {
      if (!state.feeds.length) { if (alarms?.clear) await alarms.clear(RSS_ALARM); return; }
      if (!alarms?.get || !alarms?.create) fail('RSS_SCHEDULE');
      const when = Math.max(now() + 1000, Math.min(...state.feeds.map((feed) => feed.nextDue))), prior = await alarms.get(RSS_ALARM);
      if (!prior || Math.abs(prior.scheduledTime - when) > 1000 || prior.periodInMinutes !== undefined) await alarms.create(RSS_ALARM, { when });
    } catch (reason) { throw safeError(reason, 'RSS_SCHEDULE'); }
  }
  async function scheduled(state) {
    try { await schedule(state); if (state.lastError?.code === 'RSS_SCHEDULE') { state.lastError = null; await save(state); } }
    catch (reason) { state.lastError = { code: 'RSS_SCHEDULE', at: now() }; await save(state); throw reason; }
  }
  async function fetchFeed(feed) {
    if (!await hasPermission(rssFeedOrigin(feed.url))) fail('RSS_PERMISSION');
    const abort = new AbortController(); let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(failure('RSS_TIMEOUT')); }, Math.max(1, Math.min(timeoutMs, RSS_LIMITS.timeoutMs))); });
    const work = async () => {
      const response = await fetcher(feed.url, { method: 'GET', credentials: 'omit', referrer: '', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store',
        headers: { accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9' }, signal: abort.signal });
      if (!response?.ok || response.redirected || response.url && normalizeRssFeedUrl(response.url) !== feed.url) fail('RSS_NETWORK');
      const bytes = await readBody(response); let source; try { source = decoder.decode(bytes); } catch { fail(); }
      return parseRssFeed(source, { url: feed.url });
    };
    try { return await Promise.race([work(), timeout]); } catch (reason) { throw safeError(reason); }
    finally { clearTimeout(timer); abort.abort(); }
  }
  async function refreshIn(state, selected) {
    const feeds = state.feeds.filter((feed) => selected.has(feed.id));
    const results = new Map(); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, feeds.length) }, async () => {
      while (cursor < feeds.length) { const feed = feeds[cursor++]; try { results.set(feed.id, { parsed: await fetchFeed(feed) }); } catch (error) { results.set(feed.id, { error }); } }
    }));
    for (const feed of feeds) {
      const result = results.get(feed.id); feed.lastChecked = now(); feed.nextDue = now() + feed.intervalMinutes * 60000;
      if (result.error) { feed.lastError = { code: result.error.code, at: now() }; continue; }
      feed.title = result.parsed.title; feed.lastSuccess = now(); feed.lastError = null;
      const existing = new Map(state.items.filter((item) => item.feedId === feed.id).map((item) => [item.url, item]));
      for (const item of [...result.parsed.items].reverse()) {
        const prior = existing.get(item.url);
        if (prior) Object.assign(prior, item);
        else {
          const next = { ...item, id: await hash(`${feed.id}\0${item.url}`), feedId: feed.id, receivedAt: now(), savedReadingId: null };
          existing.set(item.url, next); state.items.push(next);
        }
      }
      let remaining = state.items.filter((item) => item.feedId === feed.id).length;
      state.items = state.items.filter((item) => item.feedId !== feed.id || remaining-- <= RSS_LIMITS.feedItems);
    }
    if (state.items.length > RSS_LIMITS.items) state.items = state.items.slice(-RSS_LIMITS.items);
    state.lastError = null; await save(state); await scheduled(state); return publicState(state);
  }
  const api = {
    async load() { return publicState(await read()); },
    subscribe(listener) { return store.subscribe?.((state) => { try { listener(publicState(checked(state))); } catch { /* Keep the last valid UI state; load() reports corrupt persistence. */ } }) || (() => {}); },
    async add({ url, title = '', intervalMinutes = 60 } = {}) {
      const address = normalizeRssFeedUrl(url);
      if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < RSS_LIMITS.minIntervalMinutes || intervalMinutes > RSS_LIMITS.maxIntervalMinutes) fail('RSS_CAPACITY');
      if (!await hasPermission(rssFeedOrigin(address))) fail('RSS_PERMISSION');
      return exclusive(async () => {
        const state = await read(); if (state.feeds.length >= RSS_LIMITS.feeds) fail('RSS_CAPACITY');
        if (state.feeds.some((feed) => feed.url === address)) fail('RSS_DUPLICATE');
        const feed = { id: uuid(), url: address, title: plainText(title, 800) || new URL(address).hostname, intervalMinutes, addedAt: now(), lastChecked: null,
          lastSuccess: null, nextDue: now(), lastError: null };
        if (!identity(feed.id)) fail('RSS_STORAGE'); state.feeds.push(feed); await save(state);
        await refreshIn(state, new Set([feed.id])); return publicState(state).feeds.find((item) => item.id === feed.id);
      });
    },
    async remove(feedId) {
      return exclusive(async () => {
        const state = await read(); if (!state.feeds.some((feed) => feed.id === feedId)) fail('RSS_MISSING');
        state.feeds = state.feeds.filter((feed) => feed.id !== feedId); state.items = state.items.filter((item) => item.feedId !== feedId);
        await save(state); await scheduled(state); return publicState(state);
      });
    },
    async refresh(feedId) {
      return exclusive(async () => {
        const state = await read(); if (feedId !== undefined && !state.feeds.some((feed) => feed.id === feedId)) fail('RSS_MISSING');
        return refreshIn(state, new Set(state.feeds.filter((feed) => feedId === undefined || feed.id === feedId).map((feed) => feed.id)));
      });
    },
    async refreshDue() {
      return exclusive(async () => {
        const state = await read(), due = new Set(state.feeds.filter((feed) => feed.nextDue <= now()).map((feed) => feed.id));
        if (!due.size) { await scheduled(state); return publicState(state); } return refreshIn(state, due);
      });
    },
    async restoreSchedule() { return exclusive(async () => { const state = await read(); await scheduled(state); return publicState(state); }); },
    async save(itemId) {
      return exclusive(async () => {
        const state = await read(), item = state.items.find((entry) => entry.id === itemId); if (!item) fail('RSS_MISSING');
        let record;
        const readingTitle = item.title.slice(0, 200).replace(/[\uD800-\uDBFF]$/u, '');
        try { record = (await readReading()).find((entry) => entry.url === item.url) || await saveReading({ url: item.url, title: readingTitle }, { extract: false }); }
        catch (reason) { throw safeError(reason, 'RSS_READING'); }
        item.savedReadingId = record.id; await save(state);
        return { id: record.id, revision: record.revision, url: record.url, title: item.title };
      });
    },
  };
  return api;
}
export const rssInbox = createRssInbox();
