import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, normalizeProviderKeyword, validateState } from './model.js';
import { resolveProviderKeyword, submitWebSearch } from './search.js';
import { createStorage } from './storage.js';

const provider = (id = 'github', keyword = 'gh') => ({ id, name: id, template: 'https://example.test/search?q={query}&source=covelet', keyword });

test('optional keywords normalize ASCII case and blank values without adding a field to legacy providers', () => {
  assert.equal(normalizeProviderKeyword(undefined), undefined);
  assert.equal(normalizeProviderKeyword(' \t '), undefined);
  assert.equal(normalizeProviderKeyword(' GH_2-Test '), 'gh_2-test');
  assert.equal(normalizeProviderKeyword('A'.repeat(20)), 'a'.repeat(20));
  const legacy = createEmptyState(), before = structuredClone(legacy);
  assert.deepEqual(validateState(legacy), legacy);
  assert.ok(validateState(legacy).providers.every((item) => !Object.hasOwn(item, 'keyword')));
  const input = structuredClone(legacy); input.providers[0].keyword = '  GH  ';
  const checked = validateState(input);
  assert.equal(checked.providers[0].keyword, 'gh'); assert.equal(input.providers[0].keyword, '  GH  ');
  checked.providers[0].keyword = ' ';
  assert.equal(Object.hasOwn(validateState(checked).providers[0], 'keyword'), false);
  assert.deepEqual(legacy, before);
});

test('keywords reject nonstrings, non-ASCII lookalikes, leading digits and overlength values', () => {
  for (const value of [null, false, 12, [], {}, '1gh', '_gh', '-gh', 'g h', '中文', 'ＧＨ', 'K', 'ſ', 'a'.repeat(21), 'gh\nquery', 'a.b']) {
    assert.throws(() => normalizeProviderKeyword(value), /搜索关键词/, String(value));
  }
  const input = createEmptyState(); input.providers[0].keyword = null;
  assert.throws(() => validateState(input), /搜索关键词/);
});

test('provider keyword uniqueness is global and case-insensitive after normalization', () => {
  const input = createEmptyState(); input.providers[0].keyword = ' GH '; input.providers[1].keyword = 'gh';
  assert.throws(() => validateState(input), /搜索关键词不能重复/);
  input.providers[1].keyword = '';
  const checked = validateState(input);
  assert.equal(checked.providers[0].keyword, 'gh');
  assert.ok(!Object.hasOwn(checked.providers[1], 'keyword'));
  assert.deepEqual(validateState(checked), checked);
});

test('a keyword is a substantive customization of the retired Baidu preset', () => {
  const input = createEmptyState();
  input.providers.unshift({ id: 'baidu', name: '百度', template: 'https://www.baidu.com/s?wd={query}', keyword: 'BD' });
  assert.equal(validateState(input).providers[0].keyword, 'bd');
  input.providers[0].keyword = ' ';
  assert.equal(validateState(input).providers.some((item) => item.id === 'baidu'), false);
});

test('keyword matching requires an ASCII prefix and space followed by a nonempty query', () => {
  const providers = [provider()], before = structuredClone(providers);
  const matched = resolveProviderKeyword('  GH   中文  words &a=1 #part  ', providers);
  assert.equal(matched.provider, providers[0]);
  assert.equal(matched.query, '中文  words &a=1 #part');
  for (const query of ['', 'gh', 'gh ', 'gh\tquery', 'gh\nquery', 'gh　query', 'other query', '1gh query', 'K query', 'ſ query', 'text gh query', 'https://gh.test/?q=term']) {
    assert.equal(resolveProviderKeyword(query, providers), null, query);
  }
  assert.equal(resolveProviderKeyword(null, providers), null);
  assert.equal(resolveProviderKeyword('gh query', null), null);
  assert.deepEqual(providers, before);
});

test('an ambiguous or malformed unvalidated keyword dictionary does not silently choose an engine', () => {
  assert.equal(resolveProviderKeyword('gh query', [provider('first', 'gh'), provider('second', 'GH')]), null);
  assert.equal(resolveProviderKeyword('k query', [provider('invalid', 'K')]), null);
  const withoutKeyword = provider('id-only'); delete withoutKeyword.keyword;
  assert.equal(resolveProviderKeyword('gh query', [withoutKeyword]), null);
});

test('keyword parsing leaves transport and browser-default selection under caller control', async () => {
  const providers = [provider()], before = structuredClone(providers), browserCalls = [];
  await submitWebSearch('gh literal query', 'browser', providers, {
    api: { search: { query: async (value) => browserCalls.push(value) } },
    navigate: () => assert.fail('No implicit keyword navigation'),
  });
  assert.deepEqual(browserCalls, [{ text: 'gh literal query', disposition: 'CURRENT_TAB' }]);
  const match = resolveProviderKeyword('GH 中文 &a=1 /#?', providers), navigations = [];
  await submitWebSearch(match.query, match.provider.id, providers, {
    newTab: true, api: { search: { query: () => assert.fail('Explicit keyword engine bypasses browser default') } },
    navigate: (url, newTab) => navigations.push({ url, newTab }),
  });
  const destination = new URL(navigations[0].url);
  assert.equal(destination.origin, 'https://example.test');
  assert.equal(destination.searchParams.get('q'), '中文 &a=1 /#?');
  assert.equal(destination.searchParams.get('source'), 'covelet');
  assert.equal([...destination.searchParams].length, 2);
  assert.equal(navigations[0].newTab, true);
  assert.deepEqual(providers, before);
});

test('navigation ZIP backup and retained snapshots preserve keywords while a clear operation omits the optional field', async () => {
  let envelope = null;
  const store = createStorage({ initialState: createEmptyState, configStore: {
    read: async () => structuredClone(envelope), write: async (value) => { envelope = structuredClone(value); },
  }, iconResources: { read: async () => null } });
  const input = createEmptyState(); input.providers[0].keyword = 'GH';
  const saved = await store.saveState(input, 0);
  const backup = await store.exportBackup(saved), inspected = await store.inspectBackup(backup);
  assert.equal(inspected.state.providers[0].keyword, 'gh');
  const cleared = structuredClone(saved); cleared.providers[0].keyword = '';
  const current = await store.saveState(cleared, saved.revision);
  assert.ok(!Object.hasOwn(current.providers[0], 'keyword'));
  assert.equal(envelope.snapshots[0].providers[0].keyword, 'gh');
  assert.equal((await store.inspectBackup(await store.exportBackup(current))).state.providers[0].keyword, undefined);
});
