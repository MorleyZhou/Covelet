import test from 'node:test';
import assert from 'node:assert/strict';
import { aiEndpoint, parseModelList, readChatStream, streamContent, mergeFeedItems, releaseItems, safeContentURL } from './connected-apps.js';
import { appURL, fetchAppResponse, readAppResponse } from './app-network.js';

test('model routing preserves explicit local service ports and does not accept credentials', () => {
  assert.equal(aiEndpoint({ baseUrl: 'http://localhost:11434', provider: 'ollama' }), 'http://localhost:11434/api/chat');
  assert.equal(aiEndpoint({ baseUrl: 'http://localhost:1234/v1/', provider: 'openai' }, 'models'), 'http://localhost:1234/v1/models');
  assert.throws(() => aiEndpoint({ baseUrl: 'http://user:secret@localhost', provider: 'openai' }));
  assert.throws(() => appURL('javascript:alert(1)'));
  assert.throws(() => appURL('http://remote.example/chat'));
  assert.equal(appURL('http://127.0.0.1:11434/api/chat').port, '11434');
});
test('model discovery rejects malformed results and deduplicates names', () => {
  assert.deepEqual(parseModelList({ models: [{ name: 'one' }, { name: 'one' }, { name: 'two' }] }, 'ollama'), ['one', 'two']);
  assert.deepEqual(parseModelList({ data: [{ id: 'local-model' }] }, 'openai'), ['local-model']);
  assert.throws(() => parseModelList({ data: null }, 'openai'));
});
function responseStream(text, type, width = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let at = 0; at < bytes.length; at += width) controller.enqueue(bytes.slice(at, at + width)); controller.close(); } }), { headers: { 'content-type': type } });
}
test('Ollama replies preserve UTF-8 across arbitrary byte boundaries and publish accumulated content', async () => {
  const updates = [], wire = [{ message: { content: '你好' } }, { message: { content: ' 🌏' } }, { done: true }].map(JSON.stringify).join('\n') + '\n';
  assert.equal(await readChatStream(responseStream(wire, 'application/x-ndjson'), 'ollama', (content) => updates.push(content)), '你好 🌏');
  assert.deepEqual(updates, ['你好', '你好 🌏']);
});
test('SSE replies accept comments, split packets, completion markers and a final line without newline', async () => {
  const wire = ': heartbeat\n\ndata: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]';
  assert.equal(await readChatStream(responseStream(wire, 'text/event-stream', 7), 'openai', () => {}), 'AB');
  assert.throws(() => streamContent('data: {"error":"model unavailable"}', 'openai'), /model unavailable/);
  assert.throws(() => streamContent('not json', 'ollama'));
});
test('non-streaming JSON fallback and oversized bodies remain bounded', async () => {
  assert.equal(await readChatStream(new Response(JSON.stringify({ choices: [{ message: { content: 'fallback' } }] }), { headers: { 'content-type': 'application/json' } }), 'openai', () => {}), 'fallback');
  await assert.rejects(readAppResponse(responseStream('123456789', 'text/plain', 2), 8));
  await assert.rejects(readChatStream(new Response('{"unexpected":true}', { headers: { 'content-type': 'application/json' } }), 'openai', () => {}));
});
test('feed refresh preserves user read and star state while adding genuinely new items', () => {
  const old = [{ id: 'a', read: true, starred: true, title: 'old' }];
  const result = mergeFeedItems(old, [{ id: 'a', read: false, starred: false, title: 'updated' }, { id: 'b', read: false, starred: false, title: 'new' }]);
  assert.equal(result.length, 2); assert.equal(result.find((item) => item.id === 'a').read, true);
  assert.equal(result.find((item) => item.id === 'a').starred, true); assert.equal(old[0].title, 'old');
});
test('release and content links remain inert HTTP data and drafts are excluded', () => {
  assert.equal(safeContentURL('javascript:alert(1)'), ''); assert.equal(safeContentURL('https://user:pass@example.com'), '');
  assert.deepEqual(releaseItems([{ id: 1, draft: true, html_url: 'https://github.com/a/b' }, { id: 2, html_url: 'javascript:alert(1)' }], { id: 'source' }), []);
  assert.equal(releaseItems([{ id: 3, name: 'v1', html_url: 'https://github.com/a/b/releases/1', body: '<script>inert</script>' }], { id: 'source' })[0].summary, '<script>inert</script>');
});
test('missing service permission prevents the request before any network operation', async () => {
  const savedChrome = globalThis.chrome, savedFetch = globalThis.fetch; let calls = 0;
  globalThis.chrome = { permissions: { contains: async () => false } }; globalThis.fetch = async () => { calls++; throw Error('must not fetch'); };
  try { await assert.rejects(fetchAppResponse('https://not-granted.example/data')); assert.equal(calls, 0); }
  finally { globalThis.chrome = savedChrome; globalThis.fetch = savedFetch; }
});
