import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cloudWebdavOrigin, createWebdavProvider, validateWebdavConfig } from './cloud-webdav.js';
import { createSyncWasm } from './sync-wasm.js';

const encoder = new TextEncoder(), decoder = new TextDecoder();
const hash = value => createHash('sha256').update(value).digest('hex');
const signer = { sha256: async bytes => hash(bytes) };
const profile = { provider: 'webdav', endpoint: 'https://cloud.example.test/remote.php/dav/files/alice/', prefix: 'covelet' };
const directory = `${profile.endpoint}covelet/`;
const secrets = { username: 'fake-user', appPassword: 'FAKE-APP-PASSWORD-NOT-A-CREDENTIAL' };
const actor = 'a'.repeat(32), payload = encoder.encode('{"encrypted":"ONLY-FAKE-CIPHERTEXT"}');
const snapshot = (bytes = payload, clock = 1, installation = actor) => `covelet-${installation}-${clock}-${hash(bytes)}.json`;
const name = snapshot();
const codeIs = code => cause => cause.code === code;
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function row(href, { collection = false, size = payload.length, prefix = 'd:', status = 200, extra = '' } = {}) {
  return `<${prefix}response><${prefix}href>${escape(href)}</${prefix}href><${prefix}propstat><${prefix}prop><${prefix}resourcetype>${collection ? `<${prefix}collection/>` : ''}</${prefix}resourcetype>${size === null ? '' : `<${prefix}getcontentlength>${size}</${prefix}getcontentlength>`}${extra}</${prefix}prop><${prefix}status>HTTP/1.1 ${status} Status</${prefix}status></${prefix}propstat></${prefix}response>`;
}
function listing(rows = [], { base = directory, prefix = 'd:', self = true } = {}) {
  const attribute = prefix ? `xmlns:${prefix.slice(0, -1)}="DAV:"` : 'xmlns="DAV:"';
  return `<?xml version="1.0" encoding="UTF-8"?><${prefix}multistatus ${attribute}>${self ? row(base, { collection: true, size: null, prefix }) : ''}${rows.join('')}</${prefix}multistatus>`;
}
function response(body = '', status = 200, headers) { return new Response([204, 205, 304].includes(status) ? null : body, { status, headers }); }
function queue(results) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(results.length, 'unexpected additional WebDAV request');
    const result = results.shift();
    if (typeof result === 'function') return result(url, options);
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, fetcher };
}
const provider = (transport, options = {}, config = profile, credentials = secrets) => createWebdavProvider(config, credentials, { signer, fetcher: transport.fetcher, ...options });

test('统一同步只创建固定协议子目录，父目录仍由用户选择并预先建立', async () => {
  for (const suffix of ['all-data-v1', 'all-data-v1/blobs']) {
    const config = { ...profile, prefix: `${profile.prefix}/${suffix}` }, transport = queue([response('', 201)]);
    await provider(transport, {}, config).ensureToolDirectory();
    assert.equal(transport.calls[0].method, 'MKCOL');
    assert.equal(transport.calls[0].url, `${profile.endpoint}${config.prefix}/`);
  }
  for (const prefix of ['covelet', 'covelet/arbitrary-child', 'covelet/all-data-v1/other']) {
    const transport = queue([]);
    assert.throws(() => provider(transport, {}, { ...profile, prefix }).ensureToolDirectory(), codeIs('CLOUD_INVALID_CONFIG'));
    assert.equal(transport.calls.length, 0);
  }
  const transport = queue([response('', 409)]);
  await assert.rejects(provider(transport, {}, { ...profile, prefix: 'missing/all-data-v1' }).ensureToolDirectory(), codeIs('CLOUD_NOT_FOUND'));
  assert.equal(transport.calls.length, 1, 'No recursive parent creation');
});

test('WebDAV 规范化有路径的 HTTPS endpoint，仅返回公开字段与精确 origin', () => {
  const input = { ...profile, endpoint: 'https://CLOUD.example.test:443/remote.php/dav/files/%E5%BC%A0%E4%B8%89', prefix: '/Cove 保存/', username: secrets.username, appPassword: secrets.appPassword };
  assert.deepEqual(validateWebdavConfig(input), { provider: 'webdav', endpoint: 'https://cloud.example.test/remote.php/dav/files/%E5%BC%A0%E4%B8%89/', prefix: 'Cove 保存' });
  assert.equal(cloudWebdavOrigin(input), 'https://cloud.example.test');
  assert.equal(validateWebdavConfig({ provider: 'webdav', endpoint: 'https://dav.jianguoyun.com/dav' }).prefix, 'covelet');
  assert.equal(validateWebdavConfig({ ...profile, endpoint: 'https://cloud.example.test' }).endpoint, 'https://cloud.example.test/');
  for (const endpoint of ['http://cloud.example.test/dav/', 'https://user:pass@cloud.example.test/dav/', 'https://cloud.example.test/dav/?secret=x', 'https://cloud.example.test/dav/#x', 'https://cloud.example.test/a/../dav/', 'https://cloud.example.test/a/%2e%2e/dav/', 'https://cloud.example.test/a%2fb/', 'https://cloud.example.test/a%5cb/', 'https://cloud.example.test/a//b/', 'https://cloud.example.test/a b/']) {
    assert.throws(() => validateWebdavConfig({ ...profile, endpoint }), codeIs('CLOUD_INVALID_CONFIG'));
  }
  for (const prefix of ['', '/', '../folder', 'a/../b', 'a//b', 'a\\b', 'a\nb']) assert.throws(() => validateWebdavConfig({ ...profile, prefix }), codeIs('CLOUD_INVALID_CONFIG'));
});

test('PROPFIND 只列指定目录 Depth 1，Basic 应用密码与安全 fetch 选项不进入 URL', async () => {
  const transport = queue([response(listing([row(new URL(name, directory).pathname), row(new URL('not-a-snapshot.txt', directory).pathname), row(new URL('subfolder/', directory).pathname, { collection: true, size: null })]), 207)]);
  let guards = 0;
  assert.deepEqual(await provider(transport, { beforeRequest: () => { guards++; } }).list(), [{ name, size: payload.length }]);
  assert.equal(guards, 1); assert.equal(transport.calls.length, 1);
  const call = transport.calls[0];
  assert.equal(call.method, 'PROPFIND'); assert.equal(call.url, directory); assert.equal(call.headers.depth, '1');
  assert.match(decoder.decode(call.body), /<d:resourcetype\/><d:getcontentlength\/>/);
  assert.equal(atob(call.headers.authorization.slice(6)), `${secrets.username}:${secrets.appPassword}`);
  assert.equal(call.url.includes(secrets.appPassword), false);
  assert.equal(call.credentials, 'omit'); assert.equal(call.referrerPolicy, 'no-referrer'); assert.equal(call.referrer, '');
  assert.equal(call.redirect, 'error'); assert.equal(call.cache, 'no-store');
  assert.equal(call.signal.aborted, true, 'operation aborts remaining work on completion');
});

test('支持默认或任意 DAV 前缀、XML 注释、实体文本、404 可选属性与 Unicode 路径', async () => {
  const custom = { ...profile, endpoint: 'https://cloud.example.test/dav/%E5%BC%A0%E4%B8%89/', prefix: '配置/Cove & Tab' };
  const base = `${custom.endpoint}%E9%85%8D%E7%BD%AE/Cove%20%26%20Tab/`;
  const unicodeSecrets = { username: '张三@example.test', appPassword: secrets.appPassword };
  for (const prefix of ['', 'D:', 'custom:']) {
    let item = row(`${base}${name}`, { prefix });
    item = item.replace(`</${prefix}response>`, `<${prefix}propstat><${prefix}prop><${prefix}getetag/></${prefix}prop><${prefix}status>HTTP/1.1 404 Not Found</${prefix}status></${prefix}propstat></${prefix}response>`);
    const xml = listing([item], { base, prefix }).replace('?>', '?><!-- inert comment -->');
    const transport = queue([response(xml, 207)]);
    assert.deepEqual(await provider(transport, {}, custom, unicodeSecrets).list(), [{ name, size: payload.length }]);
    const decodedAuth = Uint8Array.from(atob(transport.calls[0].headers.authorization.slice(6)), char => char.charCodeAt(0));
    assert.equal(decoder.decode(decodedAuth), `${unicodeSecrets.username}:${unicodeSecrets.appPassword}`);
  }
});

test('空目录必须包含自身 collection；不自动创建目录或把 404 当空列表', async () => {
  const empty = queue([response(listing(), 207)]);
  assert.deepEqual(await provider(empty).list(), []);
  const missing = queue([response('<secret>FAKE</secret>', 404)]);
  await assert.rejects(provider(missing).list(), codeIs('CLOUD_NOT_FOUND'));
  assert.deepEqual(missing.calls.map(call => call.method), ['PROPFIND']);
  const incomplete = queue([response(listing([], { self: false }), 207)]);
  await assert.rejects(provider(incomplete).list(), codeIs('CLOUD_INVALID_RESPONSE'));
});

test('工具同步可显式创建严格限定的 tools-v1 子目录，不创建父目录且每次请求核对访问', async () => {
  const toolsProfile = { ...profile, prefix: 'covelet/tools-v1' }, toolsDirectory = `${directory}tools-v1/`;
  const transport = queue([response('', 201)]); let guards = 0;
  await provider(transport, { beforeRequest: () => { guards++; } }, toolsProfile).ensureToolDirectory();
  assert.equal(guards, 1); assert.equal(transport.calls.length, 1); assert.equal(transport.calls[0].method, 'MKCOL'); assert.equal(transport.calls[0].url, toolsDirectory);
  const missingParent = queue([response('', 409)]);
  await assert.rejects(provider(missingParent, {}, toolsProfile).ensureToolDirectory(), codeIs('CLOUD_NOT_FOUND'));
  assert.equal(missingParent.calls.length, 1, 'never create a parent or broaden the selected directory');
  const ordinary = queue([]); assert.throws(() => provider(ordinary).ensureToolDirectory(), codeIs('CLOUD_INVALID_CONFIG')); assert.equal(ordinary.calls.length, 0);
  const existing = queue([response('', 405), response(listing([], { base: toolsDirectory }), 207)]);
  await provider(existing, {}, toolsProfile).ensureToolDirectory(); assert.deepEqual(existing.calls.map((call) => call.method), ['MKCOL', 'PROPFIND']); assert.equal(existing.calls[1].headers.depth, '0');
  const denied = queue([]);
  await assert.rejects(provider(denied, { beforeRequest: () => { throw { code: 'CLOUD_LOCKED' }; } }, toolsProfile).ensureToolDirectory(), codeIs('CLOUD_LOCKED'));
  assert.equal(denied.calls.length, 0);
});

test('XML 拒绝 DOCTYPE、实体声明、CDATA、未知实体、无效字符和不完整结构', async () => {
  const valid = listing([row(`${directory}${name}`)]);
  const malformed = [
    valid.replace('?>', '?><!DOCTYPE d:multistatus [<!ENTITY x SYSTEM "https://evil.test/secret">]>'),
    valid.replace('?>', '?><!ENTITY x "secret">'),
    valid.replace(name, '<![CDATA[secret]]>'),
    valid.replace(name, '&external;'), valid.replace(name, '&#0;'), valid.replace(name, '&#xD800;'),
    valid.slice(0, -5), valid.replace('</d:multistatus>', ''), valid + '<d:response/>',
    valid.replace('</d:propstat>', '</d:other>'), valid.replace('xmlns:d="DAV:"', 'xmlns:d="urn:not-dav"'),
    valid.replace('<d:href>', '<d:href attr="x" attr="y">'), valid.replace('HTTP/1.1 200 Status', 'HTTP/1.1 403 Forbidden'),
    valid.replace('</d:multistatus>', '<d:limit-reached/></d:multistatus>'),
  ];
  for (const xml of malformed) {
    const transport = queue([response(xml, 207)]);
    await assert.rejects(provider(transport).list(), codeIs('CLOUD_INVALID_RESPONSE'));
    assert.equal(transport.calls.length, 1);
  }
});

test('任意位置的 DAV:error 都使整个列表失败，包括成功响应和 404 可选属性', async () => {
  const marker = '<d:error><d:number-of-matches-within-limits/></d:error>';
  const valid = listing();
  const optional = '<d:propstat><d:prop><d:getetag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status>';
  const variants = [
    valid.replace('</d:response>', `${marker}</d:response>`),
    valid.replace('</d:propstat>', `${marker}</d:propstat>`),
    valid.replace('</d:response>', `${optional}${marker}</d:propstat></d:response>`),
    valid.replace('</d:response>', `${optional}<d:error/></d:propstat></d:response>`),
    valid.replace('</d:response>', '<wrapper xmlns="urn:other"><error xmlns="DAV:"><number-of-matches-within-limits/></error></wrapper></d:response>'),
    valid.replace('</d:response>', '<e:error xmlns:e="DAV:"><e:number-of-matches-within-limits/></e:error></d:response>'),
  ];
  for (const xml of variants) {
    const transport = queue([response(xml, 207)]);
    await assert.rejects(provider(transport).list(), codeIs('CLOUD_INVALID_RESPONSE'));
    assert.deepEqual(transport.calls.map(call => call.method), ['PROPFIND']);
  }
});

test('列表拒绝跨源、凭据、查询片段、越界、嵌套和百分号路径歧义', async () => {
  for (const href of [
    `https://evil.test/covelet/${name}`, `https://user:secret@cloud.example.test/remote.php/dav/files/alice/covelet/${name}`,
    `${directory}${name}?token=secret`, `${directory}${name}#hash`, `../${name}`,
    `${directory}subfolder/${name}`, `${directory}sub%2f${name}`, `${directory}sub%5c${name}`,
    `/remote.php/dav/files/alice/other/${name}`, `${directory}%ZZ`,
  ]) {
    const transport = queue([response(listing([row(href)]), 207)]);
    await assert.rejects(provider(transport).list(), codeIs('CLOUD_INVALID_RESPONSE'));
  }
});

test('拒绝重复 href、重复关键属性和缺失文件属性，不将部分结果当全量', async () => {
  const validRow = row(`${directory}${name}`);
  for (const xml of [
    listing([validRow, validRow]),
    listing([validRow.replace('<d:resourcetype>', '<d:resourcetype/><d:resourcetype>')]),
    listing([row(`${directory}${name}`, { size: null })]),
    listing([validRow.replace('<d:getcontentlength>', '<d:getcontentlength>x</d:getcontentlength><d:getcontentlength>')]),
    listing([validRow], { self: false }),
    listing([validRow.replace('<d:resourcetype></d:resourcetype>', '')]),
  ]) await assert.rejects(provider(queue([response(xml, 207)])).list(), codeIs('CLOUD_INVALID_RESPONSE'));
});

test('坚果云 750 项边界与通用 2000 项扫描边界拒绝不完整列表', async () => {
  const jianguo = { ...profile, endpoint: 'https://dav.jianguoyun.com/dav/' };
  const jianguoBase = `${jianguo.endpoint}covelet/`;
  const many = (count, base) => Array.from({ length: count }, (_, i) => row(`${base}ignored-${i}.txt`, { size: 1 }));
  assert.deepEqual(await provider(queue([response(listing(many(748, jianguoBase), { base: jianguoBase }), 207)]), {}, jianguo).list(), []);
  await assert.rejects(provider(queue([response(listing(many(749, jianguoBase), { base: jianguoBase }), 207)]), {}, jianguo).list(), codeIs('CLOUD_LIMIT'));
  await assert.rejects(provider(queue([response(listing(many(2000, directory)), 207)])).list(), codeIs('CLOUD_LIMIT'));
  const dotted = { ...jianguo, endpoint: 'https://dav.jianguoyun.com./dav/' };
  const dottedBase = `${dotted.endpoint}covelet/`;
  assert.deepEqual(await provider(queue([response(listing(many(748, dottedBase), { base: dottedBase }), 207)]), {}, dotted).list(), []);
  await assert.rejects(provider(queue([response(listing(many(749, dottedBase), { base: dottedBase }), 207)]), {}, dotted).list(), codeIs('CLOUD_LIMIT'));
});

test('快照名称与其他适配器相同，拒绝零时钟、非安全整数、大小写和路径注入', () => {
  for (const invalidName of [name.replace('-1-', '-0-'), name.replace('-1-', '-01-'), snapshot(payload, Number.MAX_SAFE_INTEGER + 1), name.toUpperCase(), `../${name}`, `sub/${name}`, null]) {
    const value = provider(queue([]));
    assert.throws(() => value.read(invalidName), codeIs('CLOUD_INVALID_NAME'));
    assert.throws(() => value.write(invalidName, payload), codeIs('CLOUD_INVALID_NAME'));
  }
});

test('读取验证文件名摘要，可接入真实随包 WASM', async () => {
  const realSigner = await createSyncWasm(await readFile(new URL('../wasm/sync-core.wasm', import.meta.url)));
  const transport = queue([response(payload)]);
  assert.deepEqual(await provider(transport, { signer: realSigner }).read(name), payload);
  assert.equal(transport.calls[0].url, `${directory}${name}`);
  await assert.rejects(provider(queue([response('different')])).read(name), codeIs('CLOUD_INTEGRITY'));
  await assert.rejects(provider(queue([response('', 404)])).read(name), codeIs('CLOUD_NOT_FOUND'));
});

test('条件 PUT 只创建不可变快照，上传前检查摘要且复制输入', async () => {
  const original = payload.slice();
  const transport = queue([response('', 404), response('', 201)]);
  let guard = 0;
  const pending = provider(transport, { beforeRequest: () => { guard++; } }).write(name, original);
  original.fill(0);
  await pending;
  assert.equal(guard, 2);
  assert.deepEqual(transport.calls.map(call => call.method), ['GET', 'PUT']);
  assert.equal(transport.calls[1].headers['if-none-match'], '*');
  assert.equal(transport.calls[1].headers['content-type'], 'application/json');
  assert.deepEqual(transport.calls[1].body, payload);
  const invalidTransport = queue([]);
  await assert.rejects(provider(invalidTransport).write(name, encoder.encode('different')), codeIs('CLOUD_INTEGRITY'));
  assert.equal(invalidTransport.calls.length, 0);
});

test('已有相同快照为幂等无 PUT，同名不同内容保留冲突', async () => {
  const same = queue([response(payload)]);
  await provider(same).write(name, payload);
  assert.deepEqual(same.calls.map(call => call.method), ['GET']);
  const competing = queue([response('different')]);
  await assert.rejects(provider(competing).write(name, payload), codeIs('CLOUD_CONFLICT'));
  assert.equal(competing.calls.length, 1);
});

test('412 创建竞争读回核对，相同则成功，不同或消失则停止', async () => {
  for (const [final, expected] of [[response(payload), null], [response('different'), 'CLOUD_CONFLICT'], [response('', 404), 'CLOUD_CONFLICT']]) {
    const transport = queue([response('', 404), response('', 412), final]);
    const action = provider(transport).write(name, payload);
    if (expected) await assert.rejects(action, codeIs(expected)); else await action;
    assert.deepEqual(transport.calls.map(call => call.method), ['GET', 'PUT', 'GET']);
  }
});

test('锁定或撤销授权后禁止后续 PUT，并清理 guard 的任意敏感异常文字', async () => {
  for (const code of ['CLOUD_LOCKED', 'CLOUD_PERMISSION', 'UNTRUSTED_ERROR']) {
    const transport = queue([response('', 404)]);
    let guards = 0;
    const value = provider(transport, { beforeRequest: () => {
      if (++guards === 2) throw Object.assign(new Error(`SECRET ${secrets.appPassword} https://private.test/path`), { code });
    } });
    await assert.rejects(value.write(name, payload), cause => {
      assert.equal(cause.code, code === 'CLOUD_LOCKED' ? 'CLOUD_LOCKED' : 'CLOUD_PERMISSION');
      assert.equal(cause.message.includes('SECRET'), false);
      assert.equal(cause.message.includes(secrets.appPassword), false);
      return true;
    });
    assert.deepEqual(transport.calls.map(call => call.method), ['GET']);
  }
});

test('响应 advertised/流式 1 MiB 与快照 768 KiB 上限均受限', async () => {
  for (const result of [response('', 200, { 'content-length': String(1024 * 1024 + 1) }), response('', 200, { 'content-length': 'unknown' }), response(new Uint8Array(1024 * 1024 + 1))]) {
    await assert.rejects(provider(queue([result])).read(name), codeIs('CLOUD_LIMIT'));
  }
  const full = new Uint8Array(768 * 1024).fill(42), fullName = snapshot(full);
  assert.equal((await provider(queue([response(full)])).read(fullName)).length, full.length);
  await assert.rejects(provider(queue([response(new Uint8Array(768 * 1024 + 1))])).read(name), codeIs('CLOUD_LIMIT'));
  assert.throws(() => provider(queue([])).write(name, new Uint8Array(768 * 1024 + 1)), codeIs('CLOUD_LIMIT'));
  assert.throws(() => provider(queue([])).write(name, new Uint8Array()), codeIs('CLOUD_LIMIT'));
  await assert.rejects(provider(queue([response(listing([row(`${directory}${name}`, { size: 768 * 1024 + 1 })]), 207)])).list(), codeIs('CLOUD_LIMIT'));
});

test('整个操作包含多步请求、guard 与响应读取的超时，超时后不再发 PUT', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const transport = queue([async () => delayed]);
  await assert.rejects(provider(transport, { timeoutMs: 10 }).write(name, payload), codeIs('CLOUD_TIMEOUT'));
  release(response('', 404));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(transport.calls.map(call => call.method), ['GET']);
  await assert.rejects(provider(queue([]), { timeoutMs: 10, beforeRequest: () => new Promise(() => {}) }).list(), codeIs('CLOUD_TIMEOUT'));
  const stream = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('<d:')); } });
  await assert.rejects(provider(queue([response(stream, 207)]), { timeoutMs: 10 }).list(), codeIs('CLOUD_TIMEOUT'));
});

test('所有错误不反射 URL、XML 或凭据，重定向不跟随', async () => {
  for (const [result, code] of [
    [response(`<secret>${secrets.appPassword}</secret>`, 401), 'CLOUD_AUTH'],
    [response(`<secret>${secrets.appPassword}</secret>`, 403), 'CLOUD_AUTH'],
    [response('', 429), 'CLOUD_RATE_LIMIT'], [response('', 507), 'CLOUD_LIMIT'],
    [new Error(`${secrets.appPassword} ${directory} XML PRIVATE`), 'CLOUD_NETWORK'],
    [{ redirected: true, status: 200 }, 'CLOUD_REDIRECT'],
    [{ url: 'https://evil.test/', status: 200 }, 'CLOUD_REDIRECT'],
  ]) await assert.rejects(provider(queue([result])).read(name), cause => {
    assert.equal(cause.code, code);
    assert.equal(cause.message.includes(secrets.appPassword), false);
    assert.equal(cause.message.includes(directory), false);
    assert.equal(cause.message.includes('PRIVATE'), false);
    return true;
  });
});

test('无效应用凭据与签名器在网络前拒绝，默认 bridge 使用 globalThis.fetch', async () => {
  for (const credentials of [{ username: 'bad:user', appPassword: 'x' }, { username: '', appPassword: 'x' }, { username: 'user', appPassword: '' }, { username: 'u', appPassword: 'secret\n' }]) {
    assert.throws(() => provider(queue([]), {}, profile, credentials), codeIs('CLOUD_CREDENTIALS'));
  }
  assert.throws(() => createWebdavProvider(profile, secrets, {}), codeIs('CLOUD_CRYPTO'));
  const original = globalThis.fetch;
  let requested;
  globalThis.fetch = async (url, options) => { requested = { url, options }; return response(listing(), 207); };
  try {
    assert.deepEqual(await createWebdavProvider(profile, secrets, { signer }).list(), []);
    assert.equal(requested.url, directory);
    assert.equal(requested.options.method, 'PROPFIND');
  } finally { globalThis.fetch = original; }
});
