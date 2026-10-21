import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizeSite } from './site-recognition.js';

const image = () => new Blob(['test fixture'], { type: 'image/png' });
const api = (allowed, requests) => ({ runtime: { id: 'test' }, permissions: {
  contains: async () => allowed, request: async () => { requests.count++; return true; },
} });

test('automatic recognition of multiple new origins never prompts or requests their web pages', async () => {
  const requests = { count: 0 }, calls = [];
  let remoteCalls = 0;
  const icon = image();
  for (const origin of ['https://example.com', 'https://different.example']) {
    const result = await recognizeSite(`${origin}/private?token=secret#value`, {
      api: api(false, requests), browserIcon: async (input) => { calls.push(input); return icon; },
      remoteInfo: async () => { remoteCalls++; throw Error('No host grant.'); },
    });
    assert.equal(result.icon, icon);
    assert.equal(result.title, new URL(origin).hostname);
    assert.equal(result.hasAccess, false);
  }
  assert.deepEqual(calls, ['https://example.com', 'https://different.example']);
  assert.equal(remoteCalls, 0); assert.equal(requests.count, 0);
});

test('an existing exact-origin grant keeps automatic real names and icons without prompting', async () => {
  const requests = { count: 0 }, icon = image();
  let nativeCalls = 0;
  const result = await recognizeSite('https://example.com/private?secret=1', {
    api: api(true, requests), browserIcon: async () => { nativeCalls++; return null; },
    remoteInfo: async (input) => { assert.equal(input, 'https://example.com'); return { title: '官方网站', icon, message: '已识别网站名称和图标。' }; },
  });
  assert.equal(result.title, '官方网站'); assert.equal(result.icon, icon);
  assert.equal(nativeCalls, 0); assert.equal(requests.count, 0);
});

test('homepage failure cannot block a browser icon or leak a misleading size error', async () => {
  const requests = { count: 0 }, icon = image();
  const result = await recognizeSite('https://example.com', {
    api: api(true, requests), browserIcon: async () => icon,
    remoteInfo: async () => { throw Error('网站响应超过识别大小限制。'); },
  });
  assert.equal(result.icon, icon); assert(!result.message.includes('超过'));
  assert.equal(requests.count, 0);
});

test('missing native icons and plain previews remain an ordinary text fallback', async () => {
  const result = await recognizeSite('https://www.example.com/private', {
    api: {}, browserIcon: async () => null, remoteInfo: async () => { throw Error('Unexpected host request.'); },
  });
  assert.equal(result.title, 'example.com'); assert.equal(result.icon, null);
  assert.equal(result.hasAccess, false); assert(!result.message.includes('授权后获取'));
});
