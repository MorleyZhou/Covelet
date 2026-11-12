import { tr, getLocale } from "../i18n/index.js";
import { normalizeUrl } from './model.js';
import { normalizeIconAddress } from './site-icons.js';
import { normalizeIconBlob } from './icon-image-format.js';

// Fetch only the single site being added. No favicon proxy, browsing data or
// page scripts are involved. Host access is optional and requested per origin.
const HTML_LIMIT = 512 * 1024;
const ICON_LIMIT = 1024 * 1024;
const PIXEL_LIMIT = 4_000_000;
const EDGE_LIMIT = 4096;
const RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon']);

function fail(message, code = 'SITE_INFO_FAILED') {
  throw Object.assign(new Error(message), { code });
}

export function siteOrigin(input) {
  return new URL(normalizeUrl(input)).origin;
}

function hostPattern(input) { return `${siteOrigin(input)}/*`; }

export function supportsSiteInfo(api = globalThis.chrome) {
  return Boolean(api?.runtime?.id && api?.permissions?.contains && api?.permissions?.request);
}

export async function canReadSite(input, { api = globalThis.chrome } = {}) {
  if (!supportsSiteInfo(api)) return false;
  return Boolean(await api.permissions.contains({ origins: [hostPattern(input)] }));
}

// Keep this non-async and call request immediately: Chrome requires a user
// gesture. The UI must call it directly from its explicit recognition button.
export function requestSiteAccess(input, { api = globalThis.chrome } = {}) {
  if (!supportsSiteInfo(api)) return Promise.reject(Object.assign(new Error(tr("网页预览无法申请站点访问权限，请加载浏览器扩展后识别，或手动填写。")), { code: 'SITE_INFO_UNAVAILABLE' }));
  const inputs = Array.isArray(input) ? input : [input];
  if (!inputs.length || inputs.length > 16) fail(tr('网址格式无效'), 'SITE_ACCESS_INVALID');
  const origins = new Set();
  for (const value of inputs) origins.add(hostPattern(value));
  return Promise.resolve(api.permissions.request({ origins: [...origins] }));
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#(?:x[\da-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (match, key) => {
    if (key[0] !== '#') return named[key.toLowerCase()] ?? match;
    const point = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
  });
}

function label(value) {
  return decodeEntities(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function attributes(source) {
  const values = new Map();
  for (const match of source.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const key = match[1].toLowerCase();
    if (!values.has(key)) values.set(key, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return values;
}

function iconUrl(value, origin) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\u0000-\u0020\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value, `${origin}/`);
    if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    if (/\.svgz?(?:$|[?#])/i.test(url.href)) return null;
    return url.href;
  } catch { return null; }
}

// This is deliberately a bounded text parser, not DOMParser/innerHTML. Remote
// markup is never attached to any document and cannot load resources or execute.
export function parseSiteMetadata(html, originInput) {
  const origin = siteOrigin(originInput);
  if (typeof html !== 'string' || html.length > HTML_LIMIT) fail(tr("网站首页内容超过识别限制。"));
  // A bounded prefix may end inside an ignored block. Remove its remaining
  // content as well, so quoted markup cannot become a title or icon candidate.
  const clean = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(script|style|template|noscript)\b[^>]*(?:>|$)[\s\S]*?(?:<\/\1\s*>|$)/gi, '').split(/<body\b/i, 1)[0];
  const title = label(clean.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '');
  let siteName = '', appName = '';
  const candidates = [], links = [];
  for (const tag of clean.matchAll(/<(meta|link)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
    const attr = attributes(tag[2]);
    if (tag[1].toLowerCase() === 'meta') {
      const key = (attr.get('property') ?? attr.get('name') ?? '').toLowerCase();
      if (key === 'og:site_name' && !siteName) siteName = label(attr.get('content') ?? '');
      if (key === 'application-name' && !appName) appName = label(attr.get('content') ?? '');
      continue;
    }
    const rel = (attr.get('rel') ?? '').toLowerCase().split(/\s+/);
    if (links.length < 24 && rel.some((value) => ['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'manifest'].includes(value))) {
      let address;
      try { if (attr.get('href')?.trim()) address = normalizeIconAddress(new URL(attr.get('href'), `${origin}/`).href); } catch { /* Ignore invalid declarations. */ }
      if (address) links.push({ url: address, rel: rel.join(' '), sizes: attr.get('sizes') || '', type: attr.get('type') || '', media: (attr.get('media') || '').slice(0, 256) });
    }
    if (!rel.includes('icon') && !rel.includes('apple-touch-icon') && !rel.includes('apple-touch-icon-precomposed')) continue;
    const type = (attr.get('type') ?? '').toLowerCase().split(';', 1)[0];
    if (type && !RASTER_MIMES.has(type)) continue;
    const url = iconUrl(attr.get('href'), origin);
    if (!url || candidates.some((entry) => entry.url === url)) continue;
    const sizes = attr.get('sizes')?.match(/(?:^|\s)(\d{1,4})x(\d{1,4})(?:$|\s)/i);
    const edge = sizes ? Math.min(Number(sizes[1]), Number(sizes[2])) : 0;
    candidates.push({ url, score: rel.includes('apple-touch-icon') ? 300 : edge >= 64 && edge <= 512 ? 200 + Math.min(edge, 256) / 10 : 100 });
  }
  const icons = candidates.sort((a, b) => b.score - a.score).slice(0, 3).map((entry) => entry.url);
  const fallback = `${origin}/favicon.ico`;
  if (!icons.includes(fallback)) icons.push(fallback);
  return { title: siteName || appName || title || new URL(origin).hostname, icons, links };
}

async function boundedBody(response, limit) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) fail(tr("网站响应超过识别大小限制。"));
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > limit) fail(tr("网站响应超过识别大小限制。"));
    return bytes;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail(tr("网站响应超过识别大小限制。")); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

// Page metadata lives near the beginning of the document. A large homepage is
// not an oversized icon: retain only a bounded prefix and cancel the remainder
// instead of rejecting it because of the full document's Content-Length.
async function metadataPrefix(response, limit) {
  if (!response.body?.getReader) {
    // Modern Fetch responses have readable streams. Do not buffer an unbounded
    // response in environments that only expose arrayBuffer().
    const length = response.headers.get('content-length');
    if (length === null || !/^\d+$/.test(length) || Number(length) > limit) fail(tr("当前网站响应无法安全读取。"));
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.subarray(0, limit);
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, limit - size);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size === limit) { await reader.cancel(); break; }
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function defaultFetch(url, options) { return globalThis.fetch(url, options); }

async function request(fetcher, url, limit, timeoutMs, accept, prefix = false) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, {
          method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer',
          redirect: 'error', cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok || response.redirected || (response.url && response.url !== url)) fail(tr("网站请求失败或发生重定向，请手动填写，或输入最终网址后重试。"));
        const mime = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
        if (!accept(mime)) fail(tr("网站返回了无法识别的内容类型。"));
        return { bytes: await (prefix ? metadataPrefix(response, limit) : boundedBody(response, limit)), mime, contentType: response.headers.get('content-type') ?? '' };
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(tr("网站识别超时，请重试或手动填写。"))); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}

function rasterDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, count) => String.fromCharCode(...bytes.subarray(offset, offset + count));
  if (bytes.length >= 33 && bytes[0] === 137 && ascii(1, 7) === 'PNG\r\n\x1a\n' && ascii(12, 4) === 'IHDR') return { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 3 < bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 7) return { mime: 'image/jpeg', width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      offset += size;
    }
  }
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8X' && !(bytes[20] & 2)) return { mime: 'image/webp', width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
    if (kind === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) return { mime: 'image/webp', width: view.getUint16(26, true) & 16383, height: view.getUint16(28, true) & 16383 };
    if (kind === 'VP8L' && bytes[20] === 47) return { mime: 'image/webp', width: 1 + ((bytes[21] | (bytes[22] << 8)) & 16383), height: 1 + (((bytes[22] >> 6) | (bytes[23] << 2) | (bytes[24] << 10)) & 16383) };
  }
  return null;
}

function checkDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > EDGE_LIMIT || height > EDGE_LIMIT || width * height > PIXEL_LIMIT) fail(tr("网站图标尺寸超出限制。"), 'LIMIT');
}

export function validateIconBytes(bytes, mime) {
  if (bytes instanceof Uint8Array && bytes.length > ICON_LIMIT) fail(tr("网站图标格式或大小无效。"), 'LIMIT');
  if (!(bytes instanceof Uint8Array) || !bytes.length || !RASTER_MIMES.has(mime)) fail(tr("网站图标格式或大小无效。"));
  if (mime === 'image/x-icon' || mime === 'image/vnd.microsoft.icon') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 22 || view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) fail(tr("ICO 图标格式无效。"));
    const count = view.getUint16(4, true);
    if (count < 1 || count > 32 || 6 + 16 * count > bytes.length) fail(tr("ICO 图标目录无效。"));
    for (let index = 0; index < count; index++) {
      const entry = 6 + index * 16;
      const size = view.getUint32(entry + 8, true), offset = view.getUint32(entry + 12, true);
      if (offset < 6 + 16 * count || size < 12 || offset + size > bytes.length) fail(tr("ICO 图标内容无效。"));
      const data = bytes.subarray(offset, offset + size), png = rasterDimensions(data);
      if (png) { if (png.mime !== 'image/png') fail(tr("ICO 图标内容无效。")); checkDimensions(png.width, png.height); }
      else {
        const dib = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (data.length < 40 || dib.getUint32(0, true) < 40 || dib.getUint32(0, true) > data.length) fail(tr("ICO 图标位图无效。"));
        checkDimensions(dib.getInt32(4, true), Math.abs(dib.getInt32(8, true)) / 2);
      }
    }
    return;
  }
  const dimensions = rasterDimensions(bytes);
  if (!dimensions || dimensions.mime !== mime) fail(tr("网站图标与声明格式不符。"));
  checkDimensions(dimensions.width, dimensions.height);
}

export async function convertIcon(blob) {
  blob = await normalizeIconBlob(blob);
  let image;
  if (globalThis.createImageBitmap) image = await globalThis.createImageBitmap(blob);
  else {
    if (!globalThis.Image) fail(tr("当前环境无法解码网站图标。"));
    const objectUrl = URL.createObjectURL(blob);
    try { image = new Image(); image.src = objectUrl; await image.decode(); }
    finally { URL.revokeObjectURL(objectUrl); }
  }
  try {
    checkDimensions(image.width, image.height);
    const scale = Math.min(1, 256 / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
    const canvas = globalThis.OffscreenCanvas ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
    const context = canvas.getContext('2d');
    if (!context) fail(tr("当前环境无法处理网站图标。"));
    context.drawImage(image, 0, 0, width, height);
    if (canvas.convertToBlob) return await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 });
    return await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error(tr("网站图标转换失败。"))), 'image/webp', 0.92));
  } finally { image.close?.(); }
}

export async function readSiteInfo(input, {
  api = globalThis.chrome, fetcher = defaultFetch, timeoutMs = 5000, convert = convertIcon, metadataOnly = false,
} = {}) {
  const origin = siteOrigin(input);
  if (!supportsSiteInfo(api)) fail(tr("网页预览无法读取站点信息，请加载浏览器扩展后识别，或手动填写。"), 'SITE_INFO_UNAVAILABLE');
  if (!await canReadSite(input, { api })) fail(tr("请先允许读取此网站的名称和图标。"), 'SITE_ACCESS_REQUIRED');
  // The navigation URL remains untouched; only the site's public root is read.
  // A failed homepage must not prevent trying its conventional favicon path.
  const hostname = new URL(origin).hostname;
  let metadata = { title: hostname, icons: [`${origin}/favicon.ico`] };
  try {
    const response = await request(fetcher, `${origin}/`, HTML_LIMIT, timeoutMs, (mime) => mime === 'text/html' || mime === 'application/xhtml+xml', true);
    const charset = response.contentType.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? 'utf-8';
    let html;
    try { html = new TextDecoder(charset).decode(response.bytes); }
    catch { html = new TextDecoder('utf-8').decode(response.bytes); }
    metadata = parseSiteMetadata(html, origin);
  } catch { /* Keep the hostname and independently try the same-origin icon. */ }
  const hasName = metadata.title !== hostname;
  if (metadataOnly) return { title: metadata.title, nameFound: hasName, icon: null, origin, iconUrl: '', iconLinks: metadata.links || [], message: '' };
  for (const url of metadata.icons) {
    try {
      const image = await request(fetcher, url, ICON_LIMIT, timeoutMs, () => true);
      const original = await normalizeIconBlob(new Blob([image.bytes], { type: image.mime }));
      if (original.type === 'image/svg+xml') continue;
      validateIconBytes(image.bytes, original.type);
      const icon = await convert(original);
      if (!(icon instanceof Blob) || !['image/png', 'image/jpeg', 'image/webp'].includes(icon.type)) fail(tr("网站图标转换失败。"));
      validateIconBytes(new Uint8Array(await icon.arrayBuffer()), icon.type);
      return { title: metadata.title, nameFound: hasName, icon, origin, iconUrl: url, iconLinks: metadata.links, message: hasName ? tr("已识别网站名称和图标。") : tr("已获取网站图标；名称暂用域名，可手动修改。") };
    } catch { /* Continue to the next same-origin icon, then retain the name. */ }
  }
  return { title: metadata.title, nameFound: hasName, icon: null, origin, iconUrl: '', iconLinks: metadata.links, message: hasName ? tr("已识别网站名称；未获取到可用图标，将使用文字图标。") : tr("未获取到网站名称和图标，将使用域名和文字图标，可手动修改。") };
}
