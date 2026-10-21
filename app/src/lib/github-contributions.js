import { tr, getLocale } from "../i18n/index.js";
import { normalizeGitHubUsername } from './widget-model.js';
import { canReadSite, requestSiteAccess } from './site-info.js';

export const GITHUB_ORIGIN = 'https://github.com';
const CACHE_KEY = 'covelet.github.calendar.v1';
const MAX_BYTES = 512 * 1024;
const TTL = 60 * 60 * 1000;
const RETRY = 60 * 1000;
const preview = Boolean(import.meta.env?.DEV) && !globalThis.chrome?.runtime?.id;
const fault = (message, code = 'GITHUB_REQUEST') => Object.assign(new Error(message), { code });

export function requestGitHubAccess() {
  return preview ? Promise.resolve(true) : requestSiteAccess(GITHUB_ORIGIN);
}

function attributes(tag) {
  const result = Object.create(null);
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    if (Object.hasOwn(result, match[1])) throw fault(tr("GitHub 日历格式已变化。"));
    result[match[1]] = match[3];
  }
  return result;
}

export function validateContributionDays(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 378) throw fault(tr("GitHub 未返回完整的贡献日历。"));
  const days = input.map((day) => {
    if (!day || typeof day !== 'object' || Object.keys(day).some((key) => !['date', 'count', 'level'].includes(key))
      || !/^20\d{2}-\d{2}-\d{2}$/.test(day.date) || !Number.isInteger(day.count) || day.count < 0 || day.count > 1000000
      || !Number.isInteger(day.level) || day.level < 0 || day.level > 4 || Boolean(day.count) !== Boolean(day.level)) throw fault(tr("GitHub 日历内容无效。"));
    const epoch = Date.parse(`${day.date}T00:00:00Z`);
    if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== day.date) throw fault(tr("GitHub 日历日期无效。"));
    return { date: day.date, count: day.count, level: day.level };
  }).sort((a, b) => a.date.localeCompare(b.date));
  for (let index = 1; index < days.length; index++) {
    if (Date.parse(days[index].date) - Date.parse(days[index - 1].date) !== 86400000) throw fault(tr("GitHub 贡献日历存在缺失或重复日期。"));
  }
  return days;
}

// Read only numeric calendar attributes and plain tooltip text. Remote HTML is
// never inserted into a document, and none of its links/scripts/images are used.
export function parseContributionCalendar(html) {
  if (typeof html !== 'string' || new TextEncoder().encode(html).byteLength > MAX_BYTES) throw fault(tr("GitHub 日历响应超过大小限制。"));
  const counts = new Map();
  for (const match of html.matchAll(/<tool-tip\b([^>]*)>([^<]{0,256})<\/tool-tip>/giu)) {
    const id = attributes(match[1]).for;
    const value = match[2].trim().match(/^(No|[\d,]+) contributions? on /u);
    if (!id || !value) continue;
    if (counts.has(id)) throw fault(tr("GitHub 日历包含重复记录。"));
    counts.set(id, value[1] === 'No' ? 0 : Number(value[1].replaceAll(',', '')));
  }
  const days = [];
  for (const match of html.matchAll(/<td\b([^>]*\bdata-date\s*=[^>]*)>/giu)) {
    const attrs = attributes(match[1]);
    if (!counts.has(attrs.id) || !/^[0-4]$/.test(attrs['data-level'])) throw fault(tr("GitHub 日历格式已变化，请稍后重试。"));
    days.push({ date: attrs['data-date'], count: counts.get(attrs.id), level: Number(attrs['data-level']) });
    if (days.length > 378) throw fault(tr("GitHub 贡献日历超过大小限制。"));
  }
  if (days.length < 350) throw fault(tr("GitHub 未返回完整的贡献日历。"));
  return validateContributionDays(days);
}

function cacheStore() {
  async function call(method, value) {
    return new Promise((resolve, reject) => {
      globalThis.chrome.storage.local[method](value, (result) => {
        if (globalThis.chrome.runtime.lastError) reject(new Error('cache unavailable'));
        else resolve(result);
      });
    });
  }
  return {
    async read() {
      if (globalThis.chrome?.runtime?.id && globalThis.chrome.storage?.local) return (await call('get', CACHE_KEY))[CACHE_KEY] || {};
      try { return JSON.parse(globalThis.localStorage?.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
    },
    async write(value) {
      if (globalThis.chrome?.runtime?.id && globalThis.chrome.storage?.local) return call('set', { [CACHE_KEY]: value });
      globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(value));
    },
  };
}

export function createGitHubProvider({ request = (...args) => globalThis.fetch(...args), store = cacheStore(), now = () => Date.now(),
  canRead = () => preview ? Promise.resolve(true) : canReadSite(GITHUB_ORIGIN), isPreview = preview, timeout = 12000 } = {}) {
  const flights = new Map();
  async function read(username, force) {
    const time = now();
    let records;
    try { records = await store.read(); } catch { records = {}; }
    if (!records || typeof records !== 'object' || Array.isArray(records)) records = {};
    let cached = records[username];
    try {
      if (!cached || !Number.isFinite(cached.fetchedAt) || cached.fetchedAt > time + 300000 || !Array.isArray(cached.days) || cached.days.length < 350) cached = null;
      else cached = { days: validateContributionDays(cached.days), fetchedAt: cached.fetchedAt, attemptedAt: cached.attemptedAt };
    } catch { cached = null; }
    if (cached && time - cached.fetchedAt < (force ? RETRY : TTL)) return { ...cached, stale: false };
    const attempt = Number(records[username]?.attemptedAt) || 0;
    if (attempt && time - attempt < RETRY) {
      if (cached) return { ...cached, stale: true, error: tr("请稍后再刷新。") };
      throw fault(tr("请稍后再刷新。"), 'GITHUB_RATE_LIMIT');
    }
    try {
      if (!await canRead()) throw fault(tr("请授权访问 GitHub 后重试。"), 'GITHUB_PERMISSION');
      records[username] = { ...(cached || {}), attemptedAt: time };
      const recent = () => Object.fromEntries(Object.entries(records).sort((a, b) => (b[1]?.attemptedAt || 0) - (a[1]?.attemptedAt || 0)).slice(0, 8));
      await store.write(recent()).catch(() => {});
      const controller = new AbortController();
      let timer;
      const expected = isPreview ? new URL(`/__github/users/${username}/contributions`, globalThis.location?.origin || 'http://localhost').href
        : `${GITHUB_ORIGIN}/users/${username}/contributions`;
      const task = async () => {
        const response = await request(expected, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'text/html', 'Accept-Language': 'en-US' } });
        if (response.redirected || (response.url && response.url !== expected)) throw fault(tr("GitHub 日历地址发生变化。"));
        if (!response.ok) throw fault(response.status === 404 ? tr("未找到该 GitHub 用户。") : response.status === 429 ? tr("GitHub 请求过于频繁，请稍后重试。") : tr("暂时无法读取 GitHub 贡献。"));
        if (!/^text\/html(?:;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > MAX_BYTES) throw fault(tr("GitHub 日历响应无效或超过大小限制。"));
        if (!response.body?.getReader) throw fault(tr("GitHub 日历响应不可读取。"));
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let html = '', size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw fault(tr("GitHub 日历响应超过大小限制。"));
            html += decoder.decode(value, { stream: true });
          }
          html += decoder.decode();
        } finally { reader.cancel().catch(() => {}); reader.releaseLock(); }
        return parseContributionCalendar(html);
      };
      let days;
      try { days = await Promise.race([task(), new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(fault(tr("GitHub 响应超时，请稍后重试。")));
      }, timeout); })]); } finally { clearTimeout(timer); controller.abort(); }
      const result = { days, fetchedAt: time, attemptedAt: time };
      records[username] = result;
      await store.write(recent()).catch(() => {});
      return { ...result, stale: false };
    } catch (error) {
      const safe = error?.code?.startsWith('GITHUB_') ? error : fault(tr("暂时无法读取 GitHub 贡献，请检查网络后重试。"));
      if (cached) return { ...cached, stale: true, error: safe.message };
      throw safe;
    }
  }
  return { load(input, { force = false } = {}) {
    const username = normalizeGitHubUsername(input);
    if (!flights.has(username)) flights.set(username, read(username, force).finally(() => flights.delete(username)));
    return flights.get(username);
  } };
}

export const githubContributions = createGitHubProvider();
