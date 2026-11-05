import { tr, getLocale } from "../i18n/index.js";
// All executable code is bundled. These adapters transfer bounded, encrypted
// snapshot data directly to the single origin explicitly chosen by the user.
import { validateWebdavConfig, cloudWebdavOrigin, createWebdavProvider } from './cloud-webdav.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const CLOUD_SNAPSHOT_MAX_BYTES = 768 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OBJECTS = 5000;
const NAME = /^covelet-([a-f0-9]{32})-([1-9][0-9]{0,15})-([a-f0-9]{64})\.json$/;
const safeErrors = new WeakSet();
const ownError = (message, code = 'CLOUD_INVALID_CONFIG') => {
  const error = Object.assign(new Error(message), { code });
  safeErrors.add(error);
  return error;
};
export const isCloudProviderError = (error) => safeErrors.has(error);
const invalid = () => ownError(tr("云存储配置无效，请检查填写内容。"));
const badResponse = () => ownError(tr("云存储返回的数据格式无效。"), 'CLOUD_INVALID_RESPONSE');
const capacityError = () => ownError(tr("云端快照数量或大小超出安全限制，请使用单独的存储目录。"), 'CLOUD_LIMIT');
const conflictError = () => ownError(tr("云端存在同名但内容不同的快照，已停止写入并保留本地数据。"), 'CLOUD_CONFLICT');
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (letter) => `%${letter.charCodeAt(0).toString(16).toUpperCase()}`);
const encodedPath = (value) => value.split('/').map(encode).join('/');
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export function parseCloudSnapshotName(name) {
  if (typeof name !== 'string') return null;
  const match = NAME.exec(name);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { actor: match[1], clock: Number(match[2]), digest: match[3] };
}

function endpointOf(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw invalid();
    return url.origin;
  } catch { throw invalid(); }
}

function prefixOf(value = 'covelet') {
  if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u001f\u007f\\]/.test(value)) throw invalid();
  const prefix = value.trim().replace(/^\/+|\/+$/g, '');
  if (!prefix || prefix.split('/').some((part) => !part || part === '.' || part === '..')) throw invalid();
  return prefix;
}

function branchOf(value = 'main') {
  if (typeof value !== 'string' || !value || value.length > 255 || /[\u0000-\u0020\u007f~^:?*\[\\]/.test(value)
    || value.includes('..') || value.includes('@{') || value.endsWith('.') || value === '@'
    || value.startsWith('refs/') || value.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) throw invalid();
  return value;
}

export function validateCloudConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  if (input.provider === 'webdav') return validateWebdavConfig(input);
  const prefix = prefixOf(input.prefix);
  if (input.provider === 'gitlab') {
    const project = typeof input.project === 'string' ? input.project.trim() : Number.isSafeInteger(input.project) ? String(input.project) : '';
    if (!/^[1-9][0-9]{0,19}$/.test(project) && (project.split('/').length < 2
      || project.split('/').some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part) || ['.', '..'].includes(part))) || project.length > 500) throw invalid();
    const branch = branchOf(input.branch);
    if (branch === 'HEAD') throw invalid();
    return { provider: 'gitlab', endpoint: endpointOf(input.endpoint || 'https://gitlab.com'), project, branch, prefix };
  }
  if (input.provider === 'github') {
    const owner = typeof input.owner === 'string' ? input.owner.trim() : '';
    const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || ['.', '..'].includes(repo)) throw invalid();
    return { provider: 'github', owner, repo, branch: branchOf(input.branch), prefix };
  }
  if (!['r2', 'oss'].includes(input.provider) || typeof input.bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucket)) throw invalid();
  const endpoint = endpointOf(input.endpoint);
  if (input.provider === 'r2') return { provider: 'r2', endpoint, bucket: input.bucket, prefix };
  if (typeof input.region !== 'string' || !/^[a-z][a-z0-9-]{1,50}$/.test(input.region)) throw invalid();
  return { provider: 'oss', endpoint, bucket: input.bucket, region: input.region, prefix };
}

export function cloudOrigin(profile) {
  const checked = validateCloudConfig(profile);
  if (checked.provider === 'webdav') return cloudWebdavOrigin(checked);
  return checked.provider === 'github' ? 'https://api.github.com' : checked.endpoint;
}

function checkedSecret(value, max = 1024) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[^\x21-\x7e]/.test(value)) throw ownError(tr("请输入有效的云存储访问凭据。"), 'CLOUD_CREDENTIALS');
  return value;
}

function queryOf(entries) {
  return Object.entries(entries).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [encode(key), encode(String(value))])
    .sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('&');
}

function bytesOf(value) {
  if (!(value instanceof Uint8Array) || !value.length || value.length > CLOUD_SNAPSHOT_MAX_BYTES) throw capacityError();
  return value;
}

function equalBytes(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function statusError(status, headers) {
  if (status === 429 || headers?.get('x-ratelimit-remaining') === '0') return ownError(tr("云存储请求过于频繁，请稍后再试。"), 'CLOUD_RATE_LIMIT');
  if (status === 401 || status === 403) return ownError(tr("云存储身份验证失败，请检查凭据和访问权限。"), 'CLOUD_AUTH');
  if (status === 404) return ownError(tr("云端文件、仓库或分支不可访问，请检查存储配置和权限。"), 'CLOUD_NOT_FOUND');
  if (status === 409 || status === 412) return conflictError();
  return ownError(tr("云存储请求未成功，请检查服务配置后重试。"), 'CLOUD_REQUEST_FAILED');
}

async function boundedBody(response) {
  const advertised = response.headers?.get('content-length');
  if (advertised !== null && advertised !== undefined && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw capacityError();
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw capacityError();
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw capacityError(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) { result.set(chunk, position); position += chunk.length; }
  return result;
}

function jsonBody(bytes) {
  try { return JSON.parse(decoder.decode(bytes)); } catch { throw badResponse(); }
}

// This small parser only decodes text fields in ListBucketResult. It never
// constructs a DOM, resolves entities, or loads anything referenced by XML.
function xmlText(value) {
  if (/[<>]/.test(value) || /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(value)) throw badResponse();
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity) => {
    if (!entity.startsWith('#')) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw badResponse();
    return String.fromCodePoint(code);
  });
}

function xmlField(block, name, required = true) {
  const matches = [...block.matchAll(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'g'))];
  if (!matches.length && !required) return null;
  if (matches.length !== 1) throw badResponse();
  return xmlText(matches[0][1]);
}

function bucketPage(bytes) {
  let xml;
  try { xml = decoder.decode(bytes); } catch { throw badResponse(); }
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)) throw badResponse();
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (!/^\s*(?:<\?xml[^?]*\?>\s*)?<ListBucketResult(?:\s[^<>]*)?>[\s\S]*<\/ListBucketResult>\s*$/.test(xml)) throw badResponse();
  if (/<\/?[A-Za-z_][\w.-]*:/.test(xml)) throw badResponse();
  const truncated = xmlField(xml, 'IsTruncated');
  if (!['true', 'false'].includes(truncated)) throw badResponse();
  const encoding = xmlField(xml, 'EncodingType', false);
  if (encoding !== null && encoding !== 'url') throw badResponse();
  const contents = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
  if ((xml.match(/<Contents\b/g) || []).length !== contents.length || (xml.match(/<\/Contents>/g) || []).length !== contents.length
    || contents.some(([, block]) => /<Contents\b/.test(block))) throw badResponse();
  if (contents.length > 1000) throw capacityError();
  const count = xmlField(xml, 'KeyCount', false);
  if (count !== null && (!/^\d+$/.test(count) || Number(count) !== contents.length)) throw badResponse();
  const objects = contents.map(([, block]) => {
    let key = xmlField(block, 'Key');
    const size = xmlField(block, 'Size');
    if (!/^\d+$/.test(size) || !Number.isSafeInteger(Number(size))) throw badResponse();
    if (encoding === 'url') { try { key = decodeURIComponent(key); } catch { throw badResponse(); } }
    return { key, size: Number(size) };
  });
  const next = xmlField(xml, 'NextContinuationToken', truncated === 'true');
  if (next !== null && (!next || next.length > 4096 || /[\u0000-\u001f\u007f]/.test(next))) throw badResponse();
  return { objects, next: truncated === 'true' ? next : null };
}

function requireUnversionedOssBucket(bytes) {
  // https://www.alibabacloud.com/help/en/oss/developer-reference/getbucketversioning
  // https://www.alibabacloud.com/help/en/oss/developer-reference/putobject
  let source;
  try { source = decoder.decode(bytes); } catch { throw badResponse(); }
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(source)) throw badResponse();
  source = source.replace(/<!--[\s\S]*?-->/g, '');
  const match = /^\s*(?:<\?xml[^?]*\?>\s*)?<VersioningConfiguration(?:\s+xmlns=(?:"http:\/\/doc\.oss-cn-hangzhou\.aliyuncs\.com"|'http:\/\/doc\.oss-cn-hangzhou\.aliyuncs\.com'))?\s*(?:\/>|>([\s\S]*?)<\/VersioningConfiguration>)\s*$/.exec(source);
  if (!match) throw badResponse();
  const content = (match[1] || '').trim();
  if (!content) return;
  if (!/^<Status>\s*(?:Enabled|Suspended)\s*<\/Status>$/.test(content)) throw badResponse();
  // OSS explicitly ignores forbid-overwrite on both enabled and suspended
  // versioned buckets. Only a never-versioned bucket supplies create-once PUT.
  throw ownError(tr('此 OSS Bucket 已开启或暂停版本控制，无法防止覆盖同名文件。请使用从未开启版本控制的专用 Bucket。'), 'CLOUD_OSS_VERSIONING');
}

function base64(bytes) {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(result);
}

export function createCloudProvider(input, secrets, options = {}) {
  const profile = validateCloudConfig(input);
  if (profile.provider === 'webdav') return createWebdavProvider(profile, secrets, options);
  const origin = cloudOrigin(profile);
  const fetcher = options.fetcher || ((...args) => globalThis.fetch(...args));
  const signer = options.signer;
  if (typeof fetcher !== 'function' || !signer || typeof signer.sha256 !== 'function' || typeof signer.hmacSha256 !== 'function') throw ownError(tr("本机同步计算模块尚未准备好。"), 'CLOUD_CRYPTO');
  if (options.beforeRequest !== undefined && typeof options.beforeRequest !== 'function') throw invalid();
  const credentials = ['github', 'gitlab'].includes(profile.provider) ? { token: checkedSecret(secrets?.token) } : {
    accessKeyId: checkedSecret(secrets?.accessKeyId, 256), secretAccessKey: checkedSecret(secrets?.secretAccessKey, 500),
    sessionToken: secrets?.sessionToken ? checkedSecret(secrets.sessionToken, 8192) : '',
  };
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(60000, options.timeoutMs)) : 15000;

  async function digest(bytes) {
    const result = await signer.sha256(bytes);
    const value = typeof result === 'string' ? result : result instanceof Uint8Array ? hex(result) : '';
    if (!/^[a-f0-9]{64}$/.test(value)) throw ownError(tr("本机同步计算模块返回无效结果。"), 'CLOUD_CRYPTO');
    return value;
  }
  async function hmac(key, value) {
    const result = await signer.hmacSha256(key, typeof value === 'string' ? encoder.encode(value) : value);
    if (!(result instanceof Uint8Array) || result.length !== 32) throw ownError(tr("本机同步计算模块返回无效结果。"), 'CLOUD_CRYPTO');
    return result;
  }
  function timestamp() {
    try {
      const value = typeof options.date === 'function' ? options.date() : options.date ?? new Date();
      const result = new Date(value).toISOString().replace(/[:-]|\.\d{3}/g, '');
      if (!/^\d{8}T\d{6}Z$/.test(result)) throw invalid();
      return result;
    } catch { throw ownError(tr("本机时间无效，请校准系统时间。"), 'CLOUD_CLOCK'); }
  }

  async function signedHeaders(method, url, body, extras = {}) {
    const time = timestamp();
    const day = time.slice(0, 8);
    const headers = { ...extras };
    let canonical, scope, algorithm, key;
    if (profile.provider === 'r2') {
      headers['x-amz-date'] = time;
      headers['x-amz-content-sha256'] = await digest(body || new Uint8Array());
      if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
      const names = ['host', ...Object.keys(headers)].sort();
      const canonicalHeaders = names.map((name) => `${name}:${name === 'host' ? url.host : headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');
      const signed = names.join(';');
      canonical = `${method}\n${url.pathname}\n${url.search.slice(1)}\n${canonicalHeaders}\n${signed}\n${headers['x-amz-content-sha256']}`;
      scope = `${day}/auto/s3/aws4_request`;
      algorithm = 'AWS4-HMAC-SHA256';
      key = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), day);
      key = await hmac(key, 'auto'); key = await hmac(key, 's3'); key = await hmac(key, 'aws4_request');
      const signature = hex(await hmac(key, `${algorithm}\n${time}\n${scope}\n${await digest(encoder.encode(canonical))}`));
      headers.authorization = `${algorithm} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
    } else {
      headers['x-oss-date'] = time;
      headers['x-oss-content-sha256'] = 'UNSIGNED-PAYLOAD';
      if (credentials.sessionToken) headers['x-oss-security-token'] = credentials.sessionToken;
      const names = Object.keys(headers).sort();
      const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');
      // Native OSS V4 signs /bucket/key even though the bucket is in the host.
      canonical = `${method}\n/${encode(profile.bucket)}${url.pathname}\n${url.search.slice(1)}\n${canonicalHeaders}\n\nUNSIGNED-PAYLOAD`;
      scope = `${day}/${profile.region}/oss/aliyun_v4_request`;
      algorithm = 'OSS4-HMAC-SHA256';
      key = await hmac(encoder.encode(`aliyun_v4${credentials.secretAccessKey}`), day);
      key = await hmac(key, profile.region); key = await hmac(key, 'oss'); key = await hmac(key, 'aliyun_v4_request');
      const signature = hex(await hmac(key, `${algorithm}\n${time}\n${scope}\n${await digest(encoder.encode(canonical))}`));
      headers.authorization = `${algorithm} Credential=${credentials.accessKeyId}/${scope}, Signature=${signature}`;
    }
    return headers;
  }

  function objectUrl(name) {
    const key = name ? `${profile.prefix}/${name}` : '';
    const path = profile.provider === 'r2' ? `/${encode(profile.bucket)}${key ? `/${encodedPath(key)}` : ''}` : `/${encodedPath(key)}`;
    return new URL(`${origin}${path}`);
  }
  function githubUrl(name, branchCheck = false) {
    const base = `${origin}/repos/${encode(profile.owner)}/${encode(profile.repo)}`;
    const url = new URL(branchCheck ? `${base}/branches/${encode(profile.branch)}` : `${base}/contents/${encodedPath(profile.prefix)}${name ? `/${encode(name)}` : ''}`);
    if (!branchCheck) url.search = queryOf({ ref: profile.branch });
    return url;
  }
  function gitlabUrl(kind = 'tree', name, page = 1) {
    const base = `${origin}/api/v4/projects/${encode(profile.project)}/repository`;
    const path = kind === 'branch' ? `/branches/${encode(profile.branch)}` : kind === 'tree' ? '/tree' : `/files/${encode(`${profile.prefix}/${name}`)}${kind === 'raw' ? '/raw' : ''}`;
    const url = new URL(`${base}${path}`);
    if (kind === 'tree') url.search = queryOf({ ref: profile.branch, path: profile.prefix, recursive: 'false', per_page: '100', page });
    else if (kind === 'raw') url.search = queryOf({ ref: profile.branch });
    return url;
  }

  async function operation(action) {
    const abort = new AbortController();
    let timer;
    let expired = false;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; abort.abort(); reject(ownError(tr("云存储连接超时，未完成的操作会在下次同步时核对。"), 'CLOUD_TIMEOUT')); }, timeoutMs);
    });
    async function request(method, url, body, extras) {
      if (abort.signal.aborted) throw ownError(tr("云存储连接超时。"), 'CLOUD_TIMEOUT');
      if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || url.hash) throw invalid();
      const headers = profile.provider === 'github' ? {
        accept: 'application/vnd.github+json', authorization: `Bearer ${credentials.token}`, 'x-github-api-version': '2026-03-10', ...extras,
      } : profile.provider === 'gitlab' ? { accept: 'application/json', 'private-token': credentials.token, ...extras } : await signedHeaders(method, url, body, extras);
      // A controller may lock the session or change targets while signing or a
      // prior network request is pending. Recheck immediately before every I/O,
      // including the existence GET and subsequent immutable create request.
      try { await options.beforeRequest?.(); }
      catch (cause) {
        if (cause?.code === 'CLOUD_PERMISSION') throw ownError(tr("尚未授权访问这个云服务，已停止请求。"), 'CLOUD_PERMISSION');
        if (cause?.code === 'CLOUD_UNAVAILABLE') throw ownError(tr("当前浏览器无法使用云同步，已停止请求。"), 'CLOUD_UNAVAILABLE');
        throw ownError(tr("云同步已锁定或目标已更改，已停止请求。"), 'CLOUD_LOCKED');
      }
      if (abort.signal.aborted) throw ownError(tr("云存储连接超时。"), 'CLOUD_TIMEOUT');
      const response = await fetcher(url.href, { method, body, headers, signal: abort.signal, credentials: 'omit', referrerPolicy: 'no-referrer', referrer: '', redirect: 'error', cache: 'no-store' });
      if (response.redirected || response.type === 'opaqueredirect' || response.url && new URL(response.url).origin !== origin) throw ownError(tr("云存储返回了不允许的跳转，已停止请求。"), 'CLOUD_REDIRECT');
      const bytes = await boundedBody(response);
      return { response, bytes };
    }
    try { return await Promise.race([action(request), deadline]); }
    catch (error) {
      if (expired) throw ownError(tr("云存储连接超时，未完成的操作会在下次同步时核对。"), 'CLOUD_TIMEOUT');
      if (safeErrors.has(error)) throw error;
      throw ownError(tr("无法连接云存储，请检查网络、站点授权和跨域配置。"), 'CLOUD_NETWORK');
    } finally { clearTimeout(timer); abort.abort(); }
  }

  async function rawRead(request, name, optional = false) {
    const url = profile.provider === 'github' ? githubUrl(name) : profile.provider === 'gitlab' ? gitlabUrl('raw', name) : objectUrl(name);
    const extras = profile.provider === 'github' ? { accept: 'application/vnd.github.raw+json' } : profile.provider === 'gitlab' ? { accept: 'application/octet-stream' } : undefined;
    const result = await request('GET', url, undefined, extras);
    if (optional && result.response.status === 404) return null;
    if (result.response.status !== 200) throw statusError(result.response.status, result.response.headers);
    return bytesOf(result.bytes);
  }

  function checkedName(name) {
    const metadata = parseCloudSnapshotName(name);
    if (!metadata) throw ownError(tr("云端快照文件名无效。"), 'CLOUD_INVALID_NAME');
    return metadata;
  }

  function finalList(objects) {
    const actors = new Set();
    const names = new Set();
    const result = [];
    for (const object of objects) {
      const metadata = parseCloudSnapshotName(object.name);
      if (!metadata) continue;
      if (object.size > CLOUD_SNAPSHOT_MAX_BYTES) throw capacityError();
      if (names.has(object.name)) throw badResponse();
      names.add(object.name); actors.add(metadata.actor);
      if (actors.size > 100 || names.size > MAX_OBJECTS) throw capacityError();
      result.push(object);
    }
    return result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  return {
    list() {
      return operation(async (request) => {
        if (profile.provider === 'gitlab') {
          const objects = [];
          const paths = new Set();
          let scanned = 0;
          for (let page = 1; page <= 51; page++) {
            const result = await request('GET', gitlabUrl('tree', undefined, page));
            if (result.response.status === 404 && page === 1) {
              const check = await request('GET', gitlabUrl('branch'));
              if (check.response.status !== 200 || jsonBody(check.bytes)?.name !== profile.branch) throw statusError(check.response.status === 200 ? 404 : check.response.status, check.response.headers);
              return [];
            }
            if (result.response.status !== 200) throw statusError(result.response.status, result.response.headers);
            const data = jsonBody(result.bytes);
            if (!Array.isArray(data) || data.length > 100) throw badResponse();
            scanned += data.length;
            if (scanned > MAX_OBJECTS) throw capacityError();
            const pageHeader = result.response.headers.get('x-page');
            const next = result.response.headers.get('x-next-page');
            const total = result.response.headers.get('x-total');
            const totalPages = result.response.headers.get('x-total-pages');
            if (pageHeader !== null && pageHeader !== String(page)
              || next !== null && next !== '' && next !== String(page + 1)
              || total !== null && (!/^\d+$/.test(total) || !Number.isSafeInteger(Number(total)))
              || totalPages !== null && (!/^[1-9]\d*$/.test(totalPages) || Number(totalPages) < page)) throw badResponse();
            if (total !== null && Number(total) > MAX_OBJECTS || totalPages !== null && Number(totalPages) > 50) throw capacityError();
            if (total !== null && Number(total) < scanned || next && totalPages !== null && Number(totalPages) <= page) throw badResponse();
            for (const item of data) {
              if (!item || typeof item.name !== 'string' || !item.name || item.name.includes('/') || !['blob', 'tree'].includes(item.type)
                || item.path !== `${profile.prefix}/${item.name}` || paths.has(item.path)) throw badResponse();
              paths.add(item.path);
              if (item.type === 'blob' && parseCloudSnapshotName(item.name)) {
                if (item.mode !== undefined && !['100644', '100755'].includes(item.mode)) throw badResponse();
                objects.push({ name: item.name });
              }
            }
            if (data.length < 100) {
              if (next || totalPages !== null && Number(totalPages) !== page || total !== null && Number(total) !== scanned) throw badResponse();
              return finalList(objects);
            }
            if (!next && (totalPages !== null && Number(totalPages) === page || total !== null && Number(total) === scanned)) return finalList(objects);
            // Probe one more numbered page even if pagination headers are not
            // exposed, rather than silently truncating a full 100-item page.
          }
          throw capacityError();
        }
        if (profile.provider === 'github') {
          const result = await request('GET', githubUrl());
          if (result.response.status === 404) {
            // A missing directory is normal on first sync; a missing branch,
            // private repository or permission is not an empty directory.
            const check = await request('GET', githubUrl(undefined, true));
            if (check.response.status !== 200 || jsonBody(check.bytes)?.name !== profile.branch) throw statusError(check.response.status === 200 ? 404 : check.response.status, check.response.headers);
            return [];
          }
          if (result.response.status !== 200) throw statusError(result.response.status, result.response.headers);
          const data = jsonBody(result.bytes);
          if (!Array.isArray(data)) throw badResponse();
          // Contents has a hard 1,000-entry directory limit with no pagination.
          if (data.length >= 1000) throw capacityError();
          const objects = [];
          for (const item of data) {
            if (item?.type !== 'file' || !parseCloudSnapshotName(item.name)) continue;
            if (item.path !== `${profile.prefix}/${item.name}` || !Number.isSafeInteger(item.size) || item.size < 0 || item.target) throw badResponse();
            objects.push({ name: item.name, size: item.size });
          }
          return finalList(objects);
        }
        const found = [];
        const tokens = new Set();
        let token;
        let scanned = 0;
        do {
          const url = objectUrl();
          url.search = queryOf({ 'list-type': '2', 'encoding-type': 'url', prefix: `${profile.prefix}/`, 'max-keys': '1000', 'continuation-token': token });
          const { response, bytes } = await request('GET', url);
          if (response.status !== 200) throw statusError(response.status, response.headers);
          const page = bucketPage(bytes);
          scanned += page.objects.length;
          if (scanned > MAX_OBJECTS) throw capacityError();
          for (const object of page.objects) {
            if (!object.key.startsWith(`${profile.prefix}/`)) continue;
            const name = object.key.slice(profile.prefix.length + 1);
            if (parseCloudSnapshotName(name)) found.push({ name, size: object.size });
          }
          token = page.next;
          if (token && (tokens.has(token) || tokens.size >= 50)) throw badResponse();
          if (token) tokens.add(token);
        } while (token);
        return finalList(found);
      });
    },
    read(name) {
      const metadata = checkedName(name);
      return operation(async (request) => {
        const bytes = await rawRead(request, name);
        if (await digest(bytes) !== metadata.digest) throw ownError(tr("云端快照校验失败，已保留本地数据。"), 'CLOUD_INTEGRITY');
        return bytes;
      });
    },
    write(name, inputBytes) {
      const metadata = checkedName(name);
      // Copy once so callers cannot mutate a payload after its hash is checked.
      const bytes = new Uint8Array(bytesOf(inputBytes));
      return operation(async (request) => {
        if (await digest(bytes) !== metadata.digest) throw ownError(tr("待上传快照的内容与文件名不一致。"), 'CLOUD_INTEGRITY');
        const existing = await rawRead(request, name, true);
        if (existing) { if (!equalBytes(existing, bytes)) throw conflictError(); return; }
        if (profile.provider === 'oss') {
          const versioning = await request('GET', new URL(`${origin}/?versioning`));
          if ([401, 403].includes(versioning.response.status)) throw ownError(tr('无法读取 OSS Bucket 版本状态，请检查凭据和 GetBucketVersioning 权限。'), 'CLOUD_OSS_VERSIONING_CHECK');
          if (versioning.response.status !== 200) throw statusError(versioning.response.status, versioning.response.headers);
          requireUnversionedOssBucket(versioning.bytes);
        }
        let result;
        if (profile.provider === 'github') {
          const body = encoder.encode(JSON.stringify({ message: 'Covelet encrypted sync snapshot', content: base64(bytes), branch: profile.branch }));
          const url = githubUrl(name); url.search = '';
          result = await request('PUT', url, body, { 'content-type': 'application/json' });
          if (result.response.status === 201) return;
        } else if (profile.provider === 'gitlab') {
          const body = encoder.encode(JSON.stringify({ branch: profile.branch, encoding: 'base64', content: base64(bytes), commit_message: 'Covelet encrypted sync snapshot' }));
          result = await request('POST', gitlabUrl('file', name), body, { 'content-type': 'application/json' });
          if (result.response.status === 201) return;
        } else {
          const headers = { 'content-type': 'application/json', ...(profile.provider === 'r2' ? { 'if-none-match': '*' } : { 'x-oss-forbid-overwrite': 'true' }) };
          result = await request('PUT', objectUrl(name), bytes, headers);
          if (result.response.status === 200) return;
        }
        if ((profile.provider === 'gitlab' ? [400, 409] : [409, 412, 422]).includes(result.response.status)) {
          const competing = await rawRead(request, name, true);
          if (competing) { if (!equalBytes(competing, bytes)) throw conflictError(); return; }
        }
        throw statusError(result.response.status, result.response.headers);
      });
    },
  };
}
