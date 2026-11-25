import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIREFOX_DATA_COLLECTION_TYPES, FIREFOX_DATA_PURPOSES, fetchWithFirefoxDataConsent,
  getFirefoxDataConsent, hasFirefoxDataConsent, isFirefoxDataConsentRuntime,
  requestFirefoxDataConsent, subscribeFirefoxDataConsent,
} from './firefox-data-consent.js';
import { submitWebSearch } from './search.js';

function event() {
  const listeners = new Set();
  return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
    fire: change => { for (const listener of [...listeners]) listener(change); }, size: () => listeners.size };
}
function firefox(initial = []) {
  let granted = [...initial];
  const calls = [], onAdded = event(), onRemoved = event();
  const api = { runtime: { id: 'covelet@test', getURL: path => `moz-extension://test-id/${path}` },
    permissions: { getAll: async () => ({ data_collection: [...granted] }), onAdded, onRemoved,
      request: value => { calls.push(value); granted = [...new Set([...granted, ...value.data_collection])]; return Promise.resolve(true); } } };
  return { api, calls, onAdded, onRemoved, set: values => { granted = [...values]; } };
}
const blocked = { code: 'FIREFOX_DATA_CONSENT_REQUIRED' };

test('Chrome and web fetch retain their original arguments without Firefox permission calls', async () => {
  const api = { runtime: { id: 'chrome-id', getURL: path => `chrome-extension://chrome-id/${path}` },
    permissions: { getAll: () => assert.fail('Chrome does not read data permissions'), request: () => assert.fail() } };
  assert.equal(isFirefoxDataConsentRuntime({ api }), false);
  assert.deepEqual(await getFirefoxDataConsent({ api }), { firefox: false, supported: false, granted: [], missing: [] });
  assert.equal(await requestFirefoxDataConsent('cloud', { api }), true);
  const input = new URL('https://example.test/path'), init = { method: 'POST', body: 'opaque-ciphertext' };
  let count = 0;
  const result = await fetchWithFirefoxDataConsent('cloud', input, init, { api, fetchImpl: (actual, options) => {
    count++; assert.equal(actual, input); assert.equal(options, init); return 'response';
  } });
  assert.equal(result, 'response'); assert.equal(count, 1);
});

test('every network purpose refuses absent consent and never requests from the fetch path', async () => {
  const { api, calls } = firefox(); let requests = 0;
  for (const purpose of Object.keys(FIREFOX_DATA_PURPOSES)) {
    await assert.rejects(fetchWithFirefoxDataConsent(purpose, 'https://example.test/', {}, { api, fetchImpl: () => { requests++; } }), blocked);
  }
  assert.equal(requests, 0); assert.deepEqual(calls, []);
});

test('Firefox without a supported built-in consent response fails closed', async () => {
  const { api } = firefox();
  for (const getAll of [undefined, async () => ({}), async () => { throw Error('Unavailable'); }]) {
    api.permissions.getAll = getAll;
    const state = await getFirefoxDataConsent({ api });
    assert.equal(state.firefox, true); assert.equal(state.supported, false);
    assert.deepEqual(state.missing, FIREFOX_DATA_COLLECTION_TYPES);
    await assert.rejects(fetchWithFirefoxDataConsent('reading', 'https://example.test/', {}, { api, fetchImpl: () => assert.fail() }), blocked);
  }
});

test('explicit request executes synchronously in the calling gesture and asks only for that purpose', async () => {
  const { api, calls } = firefox();
  const pending = requestFirefoxDataConsent('github', { api });
  assert.deepEqual(calls, [{ data_collection: ['personallyIdentifyingInfo'] }]);
  assert.equal(await pending, true);
  assert.equal(await hasFirefoxDataConsent('github', { api }), true);
  assert.equal(await hasFirefoxDataConsent('cloud', { api }), false);
  const state = await getFirefoxDataConsent({ api });
  assert.deepEqual(state.granted, ['personallyIdentifyingInfo']);
  assert.equal(state.supported, true);
});

test('denied, rejected, and unsupported explicit requests do not grant consent', async () => {
  const { api } = firefox();
  for (const request of [undefined, () => false, () => Promise.reject(Error('Denied')), () => { throw Error('Unsupported'); }]) {
    api.permissions.request = request;
    assert.equal(await requestFirefoxDataConsent('search', { api }), false);
  }
  api.permissions.request = () => true;
  assert.equal(await requestFirefoxDataConsent('search', { api }), false, 'unconfirmed grants cannot bypass getAll');
  assert.throws(() => requestFirefoxDataConsent(['none'], { api }), TypeError);
  assert.throws(() => requestFirefoxDataConsent('unknown', { api }), TypeError);
});

test('cloud transmission includes settings consent while each other purpose stays narrow', async () => {
  const fixture = firefox(FIREFOX_DATA_PURPOSES.cloud.filter(type => type !== 'technicalAndInteraction'));
  await assert.rejects(fetchWithFirefoxDataConsent('cloud', 'https://storage.test/', {}, { api: fixture.api, fetchImpl: () => assert.fail() }), blocked);
  fixture.set(FIREFOX_DATA_PURPOSES.cloud);
  let calls = 0;
  await fetchWithFirefoxDataConsent('cloud', 'https://storage.test/', {}, { api: fixture.api, fetchImpl: () => { calls++; } });
  assert.equal(calls, 1);
  assert.deepEqual(FIREFOX_DATA_PURPOSES.search, ['searchTerms']);
  assert.deepEqual(FIREFOX_DATA_PURPOSES.wallpaper, ['websiteContent']);
});

test('permission revocation blocks the next request without reusing cached consent', async () => {
  const fixture = firefox(FIREFOX_DATA_PURPOSES.reading); let calls = 0;
  const options = { api: fixture.api, fetchImpl: () => { calls++; return 'response'; } };
  await fetchWithFirefoxDataConsent('reading', 'https://article.test/', {}, options);
  fixture.set([]); fixture.onRemoved.fire({ data_collection: ['browsingActivity', 'websiteContent'] });
  await assert.rejects(fetchWithFirefoxDataConsent('reading', 'https://article.test/', {}, options), blocked);
  assert.equal(calls, 1);
});

test('revocation during an unfinished permission query prevents the network call', async () => {
  const fixture = firefox(), grants = [...FIREFOX_DATA_PURPOSES.rss]; let reply;
  fixture.api.permissions.getAll = () => new Promise(resolve => { reply = resolve; });
  const pending = fetchWithFirefoxDataConsent('rss', 'https://feed.test/', {}, { api: fixture.api, fetchImpl: () => assert.fail() });
  fixture.onRemoved.fire({ data_collection: ['websiteContent'] }); reply({ data_collection: grants });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fixture.onRemoved.size(), 0);
});

test('revocation and caller cancellation abort a pending native fetch and clean their listeners', async () => {
  for (const revoke of [true, false]) {
    const fixture = firefox(FIREFOX_DATA_PURPOSES.rss), controller = new AbortController(); let started;
    const ready = new Promise(resolve => { started = resolve; });
    const pending = fetchWithFirefoxDataConsent('rss', 'https://feed.test/', { signal: controller.signal }, { api: fixture.api,
      fetchImpl: (_input, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); started();
      }) });
    await ready;
    if (revoke) fixture.onRemoved.fire({ data_collection: ['websiteContent'] }); else controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(fixture.onRemoved.size(), 0);
  }
});

test('packaged, Blob and data resources need no transmission consent; unsafe protocols fail closed', async () => {
  const { api } = firefox(); api.permissions.getAll = () => assert.fail('Local resources are not transmitted');
  for (const input of ['moz-extension://test-id/binary.wasm', 'assets/image.png', 'blob:moz-extension://test-id/123', 'data:image/png;base64,AAAA']) {
    let called = false;
    await fetchWithFirefoxDataConsent('site', input, {}, { api, fetchImpl: value => { called = true; assert.equal(value, input); } });
    assert.equal(called, true);
  }
  for (const input of ['file:///private.txt', 'ftp://example.test/', 'javascript:alert(1)']) {
    await assert.rejects(fetchWithFirefoxDataConsent('site', input, {}, { api, fetchImpl: () => assert.fail() }), blocked);
  }
});

test('consent subscriptions observe grants and revocations and can be removed', () => {
  const { api, onAdded, onRemoved } = firefox(); let calls = 0;
  const unsubscribe = subscribeFirefoxDataConsent(() => { calls++; }, { api });
  onAdded.fire({ data_collection: ['searchTerms'] }); onRemoved.fire({ data_collection: ['searchTerms'] });
  assert.equal(calls, 2); unsubscribe();
  assert.equal(onAdded.size(), 0); assert.equal(onRemoved.size(), 0);
});

test('both native and additional-engine searches require consent before any query or navigation', async () => {
  const fixture = firefox(); let queries = 0, navigations = 0;
  fixture.api.search = { search: async () => { queries++; } };
  const providers = [{ id: 'extra', template: 'https://engine.test/?q={query}' }];
  const options = { api: fixture.api, navigate: () => { navigations++; } };
  await assert.rejects(submitWebSearch('sensitive query', 'browser', [], options), blocked);
  await assert.rejects(submitWebSearch('sensitive query', 'extra', providers, options), blocked);
  assert.equal(queries, 0); assert.equal(navigations, 0);
  fixture.set(['searchTerms']);
  await submitWebSearch('sensitive query', 'browser', [], options);
  await submitWebSearch('sensitive query', 'extra', providers, options);
  assert.equal(queries, 1); assert.equal(navigations, 1);
  fixture.set([]);
  await assert.rejects(submitWebSearch('query after revocation', 'browser', [], options), blocked);
  assert.equal(queries, 1);
});
