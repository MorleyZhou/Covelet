import { tr } from "../i18n/index.js";
// Fixed packaged WebDAV transport for encrypted, content-addressed snapshots.
// Only the user-selected directory is listed. Explicit sync setup may create
// its fixed protocol children, never arbitrary parents; no directory is deleted,
// no redirect followed, and no XML resource is evaluated.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_BODY = 768 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const MAX_SCAN = 2000;
const NAME = /^covelet-([a-f0-9]{32})-([1-9][0-9]{0,15})-([a-f0-9]{64})\.json$/;
const safeErrors = new WeakSet();
// Only errors created here may cross sync boundaries with their safe copy.
export const isWebdavError = cause => safeErrors.has(cause);
const error = (message, code) => {
  const result = Object.assign(new Error(message), { code });
  safeErrors.add(result);
  return result;
};
const invalid = () => error(tr("WebDAV 地址无效：请填写 HTTPS 基目录地址，不要使用分享链接、查询参数或带密码的地址。"), 'CLOUD_INVALID_CONFIG');
const badResponse = () => error(tr("WebDAV 返回的数据不完整或格式无效，已停止同步。"), 'CLOUD_INVALID_RESPONSE');
const limit = () => error(tr("WebDAV 目录数量或数据大小超出安全限制，请使用独立的同步目录。"), 'CLOUD_LIMIT');
const conflict = () => error(tr("云端存在同名但内容不同的快照，已停止写入并保留本地数据。"), 'CLOUD_CONFLICT');
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const encodedPath = value => value.split('/').map(encode).join('/');
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

function snapshotName(name) {
  const match = typeof name === 'string' && NAME.exec(name);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { actor: match[1], clock: Number(match[2]), digest: match[3] };
}

function segments(url) {
  const parts = url.pathname.split('/');
  if (parts.shift() !== '') throw invalid();
  if (parts.at(-1) === '') parts.pop();
  return parts.map(part => {
    let decoded;
    try { decoded = decodeURIComponent(part); } catch { throw invalid(); }
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded)) throw invalid();
    return decoded;
  });
}

export function validateWebdavConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.provider !== 'webdav'
    || typeof input.endpoint !== 'string' || input.endpoint.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(input.endpoint)) throw invalid();
  let url;
  try { url = new URL(input.endpoint); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw invalid();
  // URL parsing normalizes dot segments, so reject their raw spellings before
  // canonicalizing the configured directory as well as the decoded segments.
  if (/(?:\/|%2f)(?:\.|%2e){1,2}(?:\/|%2f|$)/i.test(input.endpoint)) throw invalid();
  const path = segments(url);
  const value = input.prefix ?? 'covelet';
  if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u001f\u007f\\]/.test(value)) throw invalid();
  const prefix = value.trim().replace(/^\/+|\/+$/g, '');
  if (!prefix || prefix.split('/').some(part => !part || part === '.' || part === '..')) throw invalid();
  url.pathname = `/${path.map(encode).join('/')}${path.length ? '/' : ''}`;
  return { provider: 'webdav', endpoint: url.href, prefix };
}

export function cloudWebdavOrigin(input) {
  return new URL(validateWebdavConfig(input).endpoint).origin;
}

function checkedSecrets(input) {
  const username = input?.username, appPassword = input?.appPassword;
  if (typeof username !== 'string' || !username.trim() || username.length > 256 || /[:\u0000-\u001f\u007f]/.test(username)
    || typeof appPassword !== 'string' || !appPassword.trim() || appPassword.length > 1024 || /[\u0000-\u001f\u007f]/.test(appPassword)) {
    throw error(tr("请输入有效的 WebDAV 用户名和应用密码。"), 'CLOUD_CREDENTIALS');
  }
  const bytes = encoder.encode(`${username}:${appPassword}`);
  let encoded = '';
  for (const byte of bytes) encoded += String.fromCharCode(byte);
  bytes.fill(0);
  return `Basic ${btoa(encoded)}`;
}

function statusError(status, method) {
  if (status === 429) return error(tr("WebDAV 请求过于频繁，请稍后再试。"), 'CLOUD_RATE_LIMIT');
  if (status === 401) return error(tr('登录失败。请检查用户名和应用密码。'), 'CLOUD_AUTH');
  if (status === 403) return error(method === 'PUT'
    ? tr('无法写入此目录。请检查目录的写入权限。')
    : tr('无法访问此目录。请检查目录权限。'), 'CLOUD_FORBIDDEN');
  if (status === 404 || status === 409) return error(method === 'GET'
    ? tr('无法读取同步文件。请检查保存目录和权限。')
    : tr('找不到保存目录。请检查服务器地址和目录。'), 'CLOUD_NOT_FOUND');
  if (status === 412) return conflict();
  if (status === 507) return limit();
  if (status >= 500 && status <= 599) return error(tr('存储服务暂时无法完成请求。请稍后重试。'), 'CLOUD_REQUEST_FAILED');
  return error(tr("WebDAV 请求未成功，请检查服务配置后重试。"), 'CLOUD_REQUEST_FAILED');
}

async function boundedBody(response) {
  const advertised = response.headers?.get('content-length');
  if (advertised !== undefined && advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_RESPONSE)) {
    await response.body?.cancel().catch(() => {});
    throw limit();
  }
  if (!response.body?.getReader) {
    const result = new Uint8Array(await response.arrayBuffer());
    if (result.length > MAX_RESPONSE) throw limit();
    return result;
  }
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE) { await reader.cancel().catch(() => {}); throw limit(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function xmlText(value) {
  if (/[<>]/.test(value) || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value)) throw badResponse();
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity) => {
    if (entity[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || !(code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0xd7ff
      || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) throw badResponse();
    return String.fromCodePoint(code);
  });
}

// A bounded inert XML tokenizer. It only stores text and element names, never
// creates a DOM, resolves an entity, or follows a schema/resource URL.
function xmlTree(input) {
  let text;
  try { text = decoder.decode(input); } catch { throw badResponse(); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(text)) throw badResponse();
  const stack = [], roots = [];
  let offset = 0, nodes = 0, declaration = false;
  const namePattern = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
  while (offset < text.length) {
    if (text[offset] !== '<') {
      const end = text.indexOf('<', offset), value = text.slice(offset, end === -1 ? text.length : end);
      if (stack.length) stack.at(-1).node.text += xmlText(value);
      else if (value.trim()) throw badResponse();
      offset = end === -1 ? text.length : end;
      continue;
    }
    if (text.startsWith('<!--', offset)) {
      const end = text.indexOf('-->', offset + 4);
      if (end === -1 || text.slice(offset + 4, end).includes('--')) throw badResponse();
      offset = end + 3; continue;
    }
    if (text.startsWith('<?xml', offset)) {
      const end = text.indexOf('?>', offset + 5);
      if (end === -1 || declaration || roots.length || stack.length
        || !/^<\?xml\s+version\s*=\s*(['"])1\.[01]\1(?:\s+encoding\s*=\s*(['"])UTF-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>$/i.test(text.slice(offset, end + 2))) throw badResponse();
      declaration = true; offset = end + 2; continue;
    }
    let end = offset + 1, quote = null;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else if (char === '<') throw badResponse();
    }
    if (end === text.length || quote) throw badResponse();
    let token = text.slice(offset + 1, end);
    offset = end + 1;
    if (token.startsWith('/')) {
      const closing = token.slice(1).trim();
      if (!namePattern.test(closing) || !stack.length || stack.at(-1).qualified !== closing) throw badResponse();
      stack.pop(); continue;
    }
    if (token.startsWith('!') || token.startsWith('?')) throw badResponse();
    const selfClosing = token.endsWith('/');
    if (selfClosing) token = token.slice(0, -1);
    const match = /^([^\s]+)([\s\S]*)$/.exec(token);
    if (!match || !namePattern.test(match[1])) throw badResponse();
    const qualified = match[1], attributes = match[2];
    const namespaces = Object.create(stack.at(-1)?.namespaces ?? null);
    if (!stack.length) namespaces.xml = 'http://www.w3.org/XML/1998/namespace';
    const seen = new Set();
    let consumed = 0;
    while (consumed < attributes.length) {
      const remainder = attributes.slice(consumed);
      if (!remainder.trim()) break;
      const attr = /^\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(remainder);
      if (!attr || !namePattern.test(attr[1]) || seen.has(attr[1]) || seen.size >= 32) throw badResponse();
      seen.add(attr[1]); consumed += attr[0].length;
      const value = xmlText(attr[2] ?? attr[3]);
      if (value.length > 4096) throw badResponse();
      if (attr[1] === 'xmlns') namespaces[''] = value;
      else if (attr[1].startsWith('xmlns:')) {
        const prefix = attr[1].slice(6);
        if (prefix === 'xmlns' || prefix === 'xml' && value !== 'http://www.w3.org/XML/1998/namespace' || !value) throw badResponse();
        namespaces[prefix] = value;
      }
    }
    const parts = qualified.split(':'), prefix = parts.length === 2 ? parts[0] : '';
    if (prefix && !namespaces[prefix]) throw badResponse();
    if (++nodes > 25000 || stack.length >= 24) throw limit();
    const node = { name: parts.at(-1), namespace: namespaces[prefix] ?? '', children: [], text: '' };
    // RFC 4918 permits DAV:error under responses and propstats, including
    // otherwise successful/optional-property responses. Any such marker can
    // describe a partial result and must invalidate the whole listing.
    if (dav(node, 'error')) throw badResponse();
    if (stack.length) stack.at(-1).node.children.push(node);
    else roots.push(node);
    if (!selfClosing) stack.push({ node, qualified, namespaces });
  }
  if (stack.length || roots.length !== 1) throw badResponse();
  return roots[0];
}

const dav = (node, name) => node.namespace === 'DAV:' && node.name === name;
function fields(node, name) { return node.children.filter(child => dav(child, name)); }
function one(node, name) {
  const matches = fields(node, name);
  if (matches.length !== 1) throw badResponse();
  return matches[0];
}
function leaf(node) {
  if (node.children.length) throw badResponse();
  return node.text.trim();
}
function httpStatus(node) {
  const match = /^HTTP\/[12](?:\.\d)?[ \t]+(\d{3})(?:[ \t]+[^\r\n]*)?$/.exec(leaf(node));
  if (!match) throw badResponse();
  return Number(match[1]);
}

function listObjects(bytes, directory) {
  const root = xmlTree(bytes);
  if (!dav(root, 'multistatus') || root.text.trim() || root.children.some(child => !dav(child, 'response') && !dav(child, 'responsedescription'))) throw badResponse();
  const responses = fields(root, 'response');
  if (!responses.length) throw badResponse();
  const hostname = directory.hostname.replace(/\.+$/, '');
  if (responses.length > MAX_SCAN || /(^|\.)jianguoyun\.com$/i.test(hostname) && responses.length >= 750) throw limit();
  const directoryParts = segments(directory), seen = new Set(), actors = new Set(), objects = [];
  let self = false;
  for (const response of responses) {
    if (response.text.trim()) throw badResponse();
    const href = leaf(one(response, 'href'));
    if (!href || href.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(href)) throw badResponse();
    let url, path;
    try { url = new URL(href, directory); path = segments(url); } catch { throw badResponse(); }
    if (url.protocol !== 'https:' || url.origin !== directory.origin || url.username || url.password || url.search || url.hash
      || path.length < directoryParts.length || path.length > directoryParts.length + 1
      || !directoryParts.every((part, index) => path[index] === part)) throw badResponse();
    const identity = JSON.stringify(path);
    if (seen.has(identity)) throw badResponse();
    seen.add(identity);
    const statuses = fields(response, 'status');
    if (statuses.length) { if (statuses.length !== 1 || httpStatus(statuses[0]) !== 200) throw badResponse(); }
    const propstats = fields(response, 'propstat');
    if (!propstats.length) throw badResponse();
    const properties = new Map();
    for (const propstat of propstats) {
      const status = httpStatus(one(propstat, 'status'));
      const prop = one(propstat, 'prop');
      if (prop.text.trim()) throw badResponse();
      if (status === 404) continue; // Unsupported optional properties.
      if (status !== 200) throw badResponse();
      for (const property of prop.children) {
        if (property.namespace !== 'DAV:') continue;
        if (properties.has(property.name)) throw badResponse();
        properties.set(property.name, property);
      }
    }
    const resource = properties.get('resourcetype');
    if (!resource || resource.text.trim() || resource.children.some(child => !dav(child, 'collection')) || resource.children.length > 1) throw badResponse();
    const collection = resource.children.length === 1;
    if (collection && (resource.children[0].text.trim() || resource.children[0].children.length)) throw badResponse();
    if (path.length === directoryParts.length) {
      if (!collection || self) throw badResponse();
      self = true; continue;
    }
    if (collection) continue;
    const sizeText = properties.get('getcontentlength');
    if (!sizeText || !/^\d+$/.test(leaf(sizeText))) throw badResponse();
    const size = Number(leaf(sizeText));
    if (!Number.isSafeInteger(size)) throw badResponse();
    const name = path.at(-1), metadata = snapshotName(name);
    if (!metadata) continue;
    if (size < 1 || size > MAX_BODY) throw limit();
    actors.add(metadata.actor);
    if (actors.size > 100) throw limit();
    objects.push({ name, size });
  }
  if (!self) throw badResponse();
  return objects.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function createWebdavProvider(input, secrets, options = {}) {
  const profile = validateWebdavConfig(input);
  const directory = new URL(`${encodedPath(profile.prefix)}/`, profile.endpoint);
  const origin = directory.origin, authorization = checkedSecrets(secrets);
  const fetcher = options.fetcher || ((...args) => globalThis.fetch(...args));
  const signer = options.signer;
  if (typeof fetcher !== 'function' || !signer || typeof signer.sha256 !== 'function') throw error(tr("本机同步计算模块尚未准备好。"), 'CLOUD_CRYPTO');
  if (options.beforeRequest !== undefined && typeof options.beforeRequest !== 'function') throw invalid();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(15000, options.timeoutMs)) : 15000;
  const checkedName = name => {
    const metadata = snapshotName(name);
    if (!metadata) throw error(tr("云端快照文件名无效。"), 'CLOUD_INVALID_NAME');
    return metadata;
  };
  const checkedBody = value => {
    if (!(value instanceof Uint8Array) || value.length < 1 || value.length > MAX_BODY) throw limit();
    return value;
  };
  const digest = async bytes => {
    const hash = await signer.sha256(bytes), value = hash instanceof Uint8Array ? hex(hash) : hash;
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw error(tr("本机同步计算模块返回无效结果。"), 'CLOUD_CRYPTO');
    return value;
  };
  const objectUrl = name => new URL(encode(name), directory);
  async function operation(action) {
    const controller = new AbortController();
    let timer, expired = false;
    const timeout = () => error(tr('连接超时。请稍后重试。'), 'CLOUD_TIMEOUT');
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; controller.abort(); reject(timeout()); }, timeoutMs);
    });
    async function request(method, url, body, extras = {}) {
      if (controller.signal.aborted) throw timeout();
      if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || !url.pathname.startsWith(directory.pathname)) throw invalid();
      try { await options.beforeRequest?.(); }
      catch (cause) {
        if (cause?.code === 'CLOUD_LOCKED') throw error(tr("自定义同步已锁定，已停止网络请求。"), 'CLOUD_LOCKED');
        if (cause?.code === 'CLOUD_PERMISSION') throw error(tr("WebDAV 站点访问权限不可用，请重新授权。"), 'CLOUD_PERMISSION');
        throw error(tr("WebDAV 请求已停止，请重新解锁并检查站点权限。"), 'CLOUD_PERMISSION');
      }
      if (controller.signal.aborted) throw timeout();
      const response = await fetcher(url.href, {
        method, body, headers: { authorization, ...extras }, signal: controller.signal,
        credentials: 'omit', referrerPolicy: 'no-referrer', referrer: '', redirect: 'error', cache: 'no-store',
      });
      if (controller.signal.aborted) throw timeout();
      if (response.redirected || response.type === 'opaqueredirect' || response.url && response.url !== url.href) {
        throw error(tr("WebDAV 返回了不允许的跳转，已停止请求。"), 'CLOUD_REDIRECT');
      }
      const bytes = await boundedBody(response);
      if (controller.signal.aborted) throw timeout();
      return { response, bytes };
    }
    try { return await Promise.race([action(request), deadline]); }
    catch (cause) {
      if (expired) throw timeout();
      if (safeErrors.has(cause)) throw cause;
      const code = cause?.cause?.code || cause?.code;
      if (globalThis.navigator?.onLine === false || code === 'ENETUNREACH' || code === 'ERR_INTERNET_DISCONNECTED')
        throw error(tr('网络已断开。请联网后重试。'), 'CLOUD_OFFLINE');
      if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_CONNECTION_TIMED_OUT'].includes(code) || cause?.name === 'TimeoutError') throw timeout();
      if (/^(?:ERR_TLS_|ERR_SSL_|ERR_CERT_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code || ''))
        throw error(tr('WebDAV 安全连接失败，请检查服务器 HTTPS 证书和设备时间。'), 'CLOUD_TLS');
      if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_REFUSED'].includes(code))
        throw error(tr('找不到或无法访问 WebDAV 服务器，请检查域名、端口和服务是否运行。'), 'CLOUD_HOST');
      // Browser fetch deliberately hides DNS/TLS/CORS details. Do not guess.
      throw error(tr('无法连接 WebDAV。请检查网络和服务器地址。'), 'CLOUD_NETWORK');
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async function readBytes(request, name, optional = false) {
    const { response, bytes } = await request('GET', objectUrl(name));
    if (optional && response.status === 404) return null;
    if (response.status !== 200) throw statusError(response.status, 'GET');
    return checkedBody(bytes);
  }
  return {
    testConnection() {
      // Read-only authentication/path probe: never publish data or create a
      // directory. A successful result does not certify PUT or the sync password.
      return operation(async request => {
        const body = encoder.encode('<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>');
        const { response, bytes } = await request('PROPFIND', directory, body, { depth: '0', 'content-type': 'application/xml; charset=utf-8' });
        if (response.status !== 207) throw statusError(response.status);
        listObjects(bytes, directory);
      });
    },
    ensureToolDirectory() {
      // A dedicated opt-in call, never an automatic side effect of list/write.
      if (!/\/(?:tools-v1|all-data-v1(?:\/blobs)?)$/.test(profile.prefix)) throw invalid();
      return operation(async request => {
        const { response } = await request('MKCOL', directory);
        if (response.status === 201) return;
        if (response.status === 405) {
          const body = encoder.encode('<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>');
          const check = await request('PROPFIND', directory, body, { depth: '0', 'content-type': 'application/xml; charset=utf-8' });
          if (check.response.status !== 207) throw statusError(check.response.status);
          listObjects(check.bytes, directory); return;
        }
        if (response.status === 409) throw error(tr('WebDAV 父目录不存在，请先建立所选保存目录。'), 'CLOUD_NOT_FOUND');
        throw statusError(response.status);
      });
    },
    list() {
      return operation(async request => {
        const body = encoder.encode('<?xml version="1.0" encoding="UTF-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>');
        const { response, bytes } = await request('PROPFIND', directory, body, { depth: '1', 'content-type': 'application/xml; charset=utf-8' });
        if (response.status !== 207) throw statusError(response.status);
        return listObjects(bytes, directory);
      });
    },
    read(name) {
      const metadata = checkedName(name);
      return operation(async request => {
        const bytes = await readBytes(request, name);
        if (await digest(bytes) !== metadata.digest) throw error(tr("云端快照校验失败，已保留本地数据。"), 'CLOUD_INTEGRITY');
        return bytes;
      });
    },
    write(name, inputBytes) {
      const metadata = checkedName(name), bytes = new Uint8Array(checkedBody(inputBytes));
      return operation(async request => {
        if (await digest(bytes) !== metadata.digest) throw error(tr("待上传快照内容与文件名不一致。"), 'CLOUD_INTEGRITY');
        const same = existing => existing.length === bytes.length && existing.every((byte, index) => byte === bytes[index]);
        const existing = await readBytes(request, name, true);
        if (existing) { if (!same(existing)) throw conflict(); return; }
        const { response } = await request('PUT', objectUrl(name), bytes, { 'content-type': 'application/json', 'if-none-match': '*' });
        if ([200, 201, 204].includes(response.status)) return;
        if (response.status === 412) {
          const competing = await readBytes(request, name, true);
          if (competing) { if (!same(competing)) throw conflict(); return; }
        }
        throw statusError(response.status, 'PUT');
      });
    },
  };
}
