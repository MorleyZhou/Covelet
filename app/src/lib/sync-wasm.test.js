import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { createSyncWasm, SYNC_WASM_MAX_INPUT, SYNC_WASM_MAX_KEY } from './sync-wasm.js';

const binary = await readFile(new URL('../wasm/sync-core.wasm', import.meta.url));
const api = await createSyncWasm(binary);
const encode = value => new TextEncoder().encode(value);
const hex = bytes => Buffer.from(bytes).toString('hex');
const hashA = 'aa'.repeat(32), hashB = 'bb'.repeat(32), hashC = 'cc'.repeat(32);

test('真实同步 WASM 只有包内计算导出、零宿主导入且固定 2 MiB 内存', async () => {
  const module = await WebAssembly.compile(binary);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const instance = await WebAssembly.instantiate(module);
  assert.equal(instance.exports.abi_version(), 1);
  assert.equal(instance.exports.memory.buffer.byteLength, 2 * 1024 * 1024);
  assert.throws(() => instance.exports.memory.grow(1), RangeError);
});

test('SHA-256 标准空值、abc、多块与百万字符向量匹配', async () => {
  for (const [data, expected] of [
    [encode(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    [encode('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    [new Uint8Array(1000000).fill(97), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ]) assert.equal(await api.sha256(data), expected);
});

test('HMAC-SHA256 RFC 4231 包含短密钥与超过块长密钥的标准向量', async () => {
  for (const [key, data, expected] of [
    [new Uint8Array(20).fill(0x0b), encode('Hi There'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
    [encode('Jefe'), encode('what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
    [new Uint8Array(20).fill(0xaa), new Uint8Array(50).fill(0xdd), '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe'],
    [new Uint8Array(131).fill(0xaa), encode('Test Using Larger Than Block-Size Key - Hash Key First'), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'],
  ]) {
    const result = await api.hmacSha256(key, data);
    assert.equal(result.constructor, Uint8Array);
    assert.equal(result.length, 32);
    assert.equal(hex(result), expected);
  }
});

test('接受 ArrayBuffer 和非零偏移切片且不修改调用方数据，签名结果独立', async () => {
  const source = encode('xabcx'), slice = source.subarray(1, 4);
  const expected = createHash('sha256').update(slice).digest('hex');
  assert.equal(await api.sha256(slice), expected);
  assert.equal(await api.sha256(encode('abc').buffer), expected);
  const key = encode('secret'), data = encode('中国路径/文件');
  const keyBefore = key.slice(), dataBefore = data.slice();
  const signature = await api.hmacSha256(key, data);
  assert.equal(hex(signature), createHmac('sha256', key).update(data).digest('hex'));
  await api.hmacSha256(encode('other'), encode('other'));
  assert.equal(hex(signature), createHmac('sha256', key).update(data).digest('hex'));
  assert.deepEqual(key, keyBefore); assert.deepEqual(data, dataBefore);
  assert.equal(new TextDecoder().decode(source), 'xabcx');
});

test('1 MiB 数据、512 字节密钥及空 HMAC 与独立实现一致', async () => {
  const data = new Uint8Array(SYNC_WASM_MAX_INPUT).fill(0xa5), key = new Uint8Array(SYNC_WASM_MAX_KEY).fill(0x7b);
  assert.equal(await api.sha256(data), createHash('sha256').update(data).digest('hex'));
  assert.equal(hex(await api.hmacSha256(key, data)), createHmac('sha256', key).update(data).digest('hex'));
  assert.equal(hex(await api.hmacSha256(new ArrayBuffer(0), new Uint8Array())), createHmac('sha256', new Uint8Array()).digest('hex'));
});

test('同步规划完整覆盖相同、单端变更、双端同结果与双端冲突', async () => {
  assert.equal(await api.planSync(hashA, hashA, hashA), 'unchanged');
  assert.equal(await api.planSync(hashB, hashA, hashA), 'push');
  assert.equal(await api.planSync(hashA, hashA, hashB), 'pull');
  assert.equal(await api.planSync(hashB, hashA, hashC), 'merge');
  assert.equal(await api.planSync(hashB, hashA, hashB), 'unchanged');
  assert.equal(await api.planSync(hashA.toUpperCase(), hashA, hashA), 'unchanged');
});

test('桥接拒绝错误类型、不完整摘要与超限输入，失败后仍可正常计算', async () => {
  for (const value of ['abc', null, undefined, [1, 2], new Uint16Array(2), new DataView(new ArrayBuffer(2))]) {
    await assert.rejects(api.sha256(value), TypeError);
  }
  await assert.rejects(api.sha256(new Uint8Array(SYNC_WASM_MAX_INPUT + 1)), RangeError);
  await assert.rejects(api.hmacSha256(new Uint8Array(SYNC_WASM_MAX_KEY + 1), encode('a')), RangeError);
  await assert.rejects(api.hmacSha256(encode('a'), new Uint8Array(SYNC_WASM_MAX_INPUT + 1)), RangeError);
  for (const hash of [null, '', 'a'.repeat(63), 'g'.repeat(64), ` ${hashA}`, `${hashA}\n`]) {
    await assert.rejects(api.planSync(hash, hashA, hashB), TypeError);
    await assert.rejects(api.planSync(hashA, hash, hashB), TypeError);
    await assert.rejects(api.planSync(hashA, hashB, hash), TypeError);
  }
  assert.equal(await api.sha256(encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('WASM 自身也拒绝恶意长度而不读取或写坏缓冲区', async () => {
  const { instance } = await WebAssembly.instantiate(binary, {}), core = instance.exports;
  const memory = new Uint8Array(core.memory.buffer);
  memory.fill(0x7f, core.output_ptr(), core.output_ptr() + 32);
  for (const length of [SYNC_WASM_MAX_INPUT + 1, 0xffffffff]) assert.equal(core.sha256_hash(length), 1);
  assert.equal(core.hmac_sha256(SYNC_WASM_MAX_KEY + 1, 0), 1);
  assert.equal(core.hmac_sha256(0, SYNC_WASM_MAX_INPUT + 1), 1);
  assert.ok(memory.subarray(core.output_ptr(), core.output_ptr() + 32).every(value => value === 0x7f));
});

test('交错摘要、签名与规划调用不会污染共用 WASM 缓冲区', async () => {
  const calls = Array.from({ length: 20 }, (_, index) => {
    const data = encode(`payload-${index}`), key = encode(`key-${index}`);
    return Promise.all([
      api.sha256(data).then(result => assert.equal(result, createHash('sha256').update(data).digest('hex'))),
      api.hmacSha256(key, data).then(result => assert.equal(hex(result), createHmac('sha256', key).update(data).digest('hex'))),
      api.planSync(hashA, hashB, hashC).then(result => assert.equal(result, 'merge')),
    ]);
  });
  await Promise.all(calls);
});

test('只接受有效且兼容的本地二进制，不把 URL 当作加载入口', async () => {
  await assert.rejects(createSyncWasm('https://example.com/plugin.wasm'), TypeError);
  await assert.rejects(createSyncWasm(new Uint8Array(65537)), RangeError);
  await assert.rejects(createSyncWasm(new Uint8Array([0, 1, 2])), WebAssembly.CompileError);
  const visual = await readFile(new URL('../wasm/visual-core.wasm', import.meta.url));
  await assert.rejects(createSyncWasm(visual), /接口不完整/);
});

test('默认 API 仅获取固定随包 WASM，模块可共用且失败后可重试', async () => {
  const originalFetch = globalThis.fetch, requests = [];
  let fail = true;
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (fail) { fail = false; return new Response('', { status: 404 }); }
    return new Response(binary, { headers: { 'Content-Type': 'application/wasm' } });
  };
  try {
    const packaged = await import('./sync-wasm.js?packaged-loader-test');
    await assert.rejects(packaged.sha256(encode('abc')), /包内/);
    assert.equal(await packaged.sha256(encode('abc')), await api.sha256(encode('abc')));
    assert.equal(hex(await packaged.hmacSha256(encode('key'), encode('abc'))), hex(await api.hmacSha256(encode('key'), encode('abc'))));
    assert.equal(await packaged.planSync(hashA, hashA, hashB), 'pull');
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url, new URL('../wasm/sync-core.wasm', import.meta.url).href);
      assert.equal(request.options.redirect, 'error');
      assert.equal(request.options.credentials, 'omit');
      assert.equal(request.options.referrerPolicy, 'no-referrer');
    }
  } finally { globalThis.fetch = originalFetch; }
});
