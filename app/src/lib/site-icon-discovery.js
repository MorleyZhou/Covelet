import { tr, getLocale } from "../i18n/index.js";
import { canReadSite, siteOrigin } from './site-info.js';
import { normalizeIconAddress, guessIconFit } from './site-icons.js';
import { navigationIcon, readCachedNavigationIcon, getNavigationIconFailure } from './navigation-icon-cache.js';

const HTML_LIMIT = 512 * 1024, MANIFEST_LIMIT = 64 * 1024;
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>]+))/gi)].map((match) => [match[1].toLowerCase(), (match[2] ?? match[3] ?? match[4]).replace(/&amp;/g, '&')]));
const urlAt = (value, base) => { if (typeof value !== 'string' || !value.trim() || value.length > 4096) return ''; try { return normalizeIconAddress(new URL(value, base).href); } catch { return ''; } };

export function publishedIconLinks(html, base) {
  const head = html.slice(0, HTML_LIMIT).replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '').split(/<body\b/i)[0];
  const links = [];
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const attr = attributes(tag), rel = (attr.rel || '').toLowerCase();
    if (!/apple-touch-icon|\bicon\b|\bmanifest\b/.test(rel)) continue;
    const url = urlAt(attr.href, base); if (!url) continue;
    links.push({ url, rel, sizes: attr.sizes || '', type: attr.type || '', media: (attr.media || '').slice(0, 256) });
    if (links.length >= 24) break;
  }
  return links;
}

function iconScheme(media) {
  if (!media || /^\s*(?:all|screen)\s*$/i.test(media)) return 'any';
  // Keep only an unambiguous scheme declaration. Do not evaluate arbitrary
  // page CSS, guess variants from filenames or mix in print/viewport icons.
  return String(media).match(/^\s*(?:(?:only\s+)?(?:all|screen)\s+and\s+)?\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)\s*$/i)?.[1].toLowerCase() || '';
}

async function readBounded(url, limit, signal, prefix = false) {
  const controller = new AbortController(), abort = () => controller.abort();
  const timer = setTimeout(abort, 7000); signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new DOMException(tr("已取消"), 'AbortError');
    const response = await globalThis.fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal });
    if (!response.ok || response.redirected || response.url && response.url !== url) throw Error(tr("无法读取网站图标信息。"));
    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > limit && !prefix) throw Error(tr("图标配置过大。"));
      return new TextDecoder().decode(bytes.subarray(0, limit));
    }
    const parts = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (size + value.length > limit) {
          await reader.cancel();
          if (!prefix) throw Error(tr("图标配置过大。"));
          parts.push(value.slice(0, limit - size)); size = limit; break;
        }
        parts.push(value); size += value.length;
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return new TextDecoder().decode(bytes);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function imageSize(url, signal, { loadIcon, cachedIcon, forceIcon }) {
  const local = (!forceIcon && await cachedIcon(url)) || await loadIcon(url, { force: true, signal });
  if (signal?.aborted) throw new DOMException(tr("已取消"), 'AbortError');
  if (local) {
    return { width: local.width, height: local.height, vector: local.vector, adaptive: local.adaptive };
  }
  // An <img> can display a CORS-protected image whose bytes cannot be saved.
  // Do not report that as successful discovery and re-download it on every tab.
  throw Object.assign(Error(tr("图标不可用。")), getNavigationIconFailure(url) || {}, { source: url });
}

async function discoverIcon(input, { api = globalThis.chrome, links, activeTab = false, signal, forceIcon = false,
  loadIcon = navigationIcon, cachedIcon = readCachedNavigationIcon } = {}) {
  const origin = siteOrigin(input);
  if (!links) {
    links = [];
    if (await canReadSite(origin, { api })) {
      try { links = publishedIconLinks(await readBounded(`${origin}/`, HTML_LIMIT, signal, true), origin); }
      catch { /* An unavailable homepage must not hide its usable favicon. */ }
    }
  }
  const candidates = [];
  function add(url, scheme, score, fit, type = '') {
    const vector = /image\/svg\+xml/i.test(type) || /\.svg(?:[?#]|$)/i.test(url);
    const ico = /image\/(?:x-icon|vnd\.microsoft\.icon)/i.test(type) || /\.ico(?:[?#]|$)/i.test(url);
    candidates.push({ url, scheme, score, fit: vector ? 'contain' : fit, vector, ico });
  }
  const decoded = new Map(), failures = [];
  const decode = (url) => {
    if (!decoded.has(url)) decoded.set(url, imageSize(url, signal, { loadIcon, cachedIcon, forceIcon }));
    return decoded.get(url);
  };
  // Obtain a usable ordinary image before spending time on manifests and HD
  // probes. Quality upgrades can fail without discarding this saved baseline.
  const baselineUrl = `${origin}/favicon.ico`;
  let baseline = null;
  try { baseline = { url: baselineUrl, fit: 'contain', ...await decode(baselineUrl) }; }
  catch (error) { failures.push(error); }
  const edgeSize = (sizes) => Math.max(0, ...String(sizes || '').split(/\s+/).map((size) => { const match = size.match(/^(\d+)x(\d+)$/i); return match ? Math.min(Number(match[1]), Number(match[2])) : 0; }));
  let manifests = 0;
  for (const link of links.slice(0, 24)) {
    if (signal?.aborted) break;
    const url = urlAt(link.url, origin), scheme = iconScheme(link.media);
    if (!url || !scheme) continue;
    if (/manifest/i.test(link.rel)) {
      if (++manifests > 2) continue;
      const same = new URL(url).origin === origin;
      if (!(same && activeTab) && !await canReadSite(url, { api })) continue;
      try {
        const manifest = JSON.parse(await readBounded(url, MANIFEST_LIMIT, signal));
        for (const item of (Array.isArray(manifest.icons) ? manifest.icons.slice(0, 12) : [])) {
          const address = typeof item.src === 'string' && urlAt(item.src, url);
          const purpose = typeof item.purpose === 'string' ? item.purpose : 'any';
          if (address && !/\.svgz(?:[?#]|$)/i.test(address) && !/^monochrome$/i.test(purpose.trim())) add(address, scheme, 1000 + Math.min(512, edgeSize(item.sizes)), /maskable/.test(purpose) ? 'cover' : guessIconFit(address), item.type);
        }
      } catch { /* A malformed manifest does not replace the current icon. */ }
    } else if (!/\.svgz(?:[?#]|$)/i.test(url)) {
      add(url, scheme, /apple-touch/i.test(link.rel) ? 1200 + Math.min(512, edgeSize(link.sizes)) : Math.min(512, edgeSize(link.sizes)), /apple-touch/i.test(link.rel) ? 'cover' : guessIconFit(url), link.type);
    }
  }
  // Common HD paths are only probes for this one requested origin; never a
  // background crawl of the desktop. No additional host permission is requested.
  for (const path of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/android-chrome-192x192.png']) add(`${origin}${path}`, 'any', 50, 'cover');
  add(`${origin}/favicon.ico`, 'any', -100, 'contain');
  async function bestFor(predicate, limit, adaptiveOnly = false) {
    const seen = new Set(); let best = null;
    for (const candidate of candidates.filter(predicate).sort((a, b) => b.score - a.score)) {
      if (seen.has(candidate.url)) continue;
      if (seen.size >= limit || signal?.aborted) break;
      seen.add(candidate.url);
      try {
        if (!decoded.has(candidate.url)) {
          // Reserve the last two decode slots for ordinary ICO fallback.
          if (decoded.size >= (candidate.ico ? 9 : 7)) continue;
          decode(candidate.url);
        }
        const size = await decoded.get(candidate.url), edge = Math.min(size.width, size.height), square = edge / Math.max(size.width, size.height);
        if (adaptiveOnly && !size.adaptive) continue;
        const quality = (size.vector ? 512 : Math.min(512, edge)) * square + Math.min(1700, candidate.score) / 30;
        if (!best || quality > best.quality) best = { url: candidate.url, fit: candidate.fit, ...size, quality };
        if ((size.vector || edge >= 512) && square > .95) break;
      } catch (error) { failures.push(error); }
    }
    if (best) { const { quality: _quality, ...result } = best; return result; }
    return null;
  }
  const [light, dark] = await Promise.all([
    bestFor((item) => !item.ico && item.scheme === 'light', 2), bestFor((item) => !item.ico && item.scheme === 'dark', 2),
  ]);
  if (light && dark && (light.url !== dark.url || light.adaptive || dark.adaptive)) return { ...light, variants: {
    light: { url: light.url, fit: light.fit }, dark: { url: dark.url, fit: dark.fit },
  } };
  // A single SVG may contain the site's own light/dark media styles. Both
  // rendered originals are compared before treating it as a genuine pair.
  const adaptive = await bestFor((item) => item.vector && item.scheme === 'any', 2, true);
  if (adaptive) return { ...adaptive, variants: {
    light: { url: adaptive.url, fit: adaptive.fit }, dark: { url: adaptive.url, fit: adaptive.fit },
  } };
  const ordinary = await bestFor((item) => !item.ico && ['any', 'light'].includes(item.scheme), 5);
  const other = ordinary || light || await bestFor((item) => item.ico && item.scheme === 'any', 2);
  const quality = (item) => item ? (item.vector ? 512 : Math.min(512, Math.min(item.width, item.height))) * Math.min(item.width, item.height) / Math.max(item.width, item.height) : -1;
  const best = quality(other) >= quality(baseline) ? other : baseline;
  if (best) return best;
  const failure = failures.find((error) => error.code === 'ACCESS') || failures.find((error) => error.code && error.code !== 'CANCELLED');
  throw Object.assign(Error(tr("图标不可用。")), failure ? { code: failure.code, source: failure.source,
    ...(Number.isInteger(failure.httpStatus) ? { httpStatus: failure.httpStatus } : {}) } : {});
}

export async function discoverHighResolutionIcon(input, options = {}) {
  const controller = new AbortController(), abort = () => controller.abort();
  const duration = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(12000, options.timeoutMs)) : 12000;
  const timer = setTimeout(abort, duration);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    const result = await discoverIcon(input, { ...options, signal: controller.signal });
    if (options.signal?.aborted) throw new DOMException(tr("已取消"), 'AbortError');
    return result;
  }
  catch (error) {
    if (options.signal?.aborted) throw new DOMException(tr('已取消'), 'AbortError');
    throw error;
  }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

export async function currentPageIconLinks(tabId, api = globalThis.chrome) {
  if (!Number.isInteger(tabId) || !api?.scripting?.executeScript) return [];
  const result = await api.scripting.executeScript({ target: { tabId }, func: () => Array.from(document.head.querySelectorAll('link[rel]'))
    .filter((link) => /apple-touch-icon|\bicon\b|\bmanifest\b/i.test(link.rel)).slice(0, 24)
    .map((link) => ({ url: link.href.slice(0, 4096), rel: link.rel.slice(0, 100), sizes: link.sizes?.value?.slice(0, 100) || '', type: link.type.slice(0, 100), media: link.media.slice(0, 256) })) });
  return Array.isArray(result[0]?.result) ? result[0].result : [];
}
