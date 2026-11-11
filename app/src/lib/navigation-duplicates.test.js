import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from './model.js';
import { findNavigationDuplicates, previewNavigationDuplicates, commitNavigationDuplicates } from './navigation-duplicates.js';
import { createStorage } from './storage.js';
import { getContentMetadata, getContentTags, loadContentPreferences } from './content-preferences.js';
import { localData } from './local-data.js';

const URL = 'https://example.test/article?one=1#part';
const site = (id, patch = {}) => ({ id, type: 'site', name: id, url: URL, groupId: 'group-home', parentId: null, page: 0, icon: { kind: 'letter', value: id.slice(0, 1) }, order: 0, ...patch });
const folder = (id, page = 0) => ({ id, type: 'folder', name: id, groupId: 'group-home', parentId: null, page, icon: { kind: 'letter', value: 'F' }, order: 0 });
function nav(entries) {
  const navigation = createEmptyState(), counters = new Map();
  navigation.entries = entries.map((entry) => { const key = entry.parentId; const order = counters.get(key) || 0; counters.set(key, order + 1); return { ...entry, order }; });
  return navigation;
}
function prefs(items = {}, extra = {}) {
  const tagIds = [...new Set(Object.values(items).flatMap((value) => value.tagIds || []))];
  return { version: 1, revision: 4, aliases: {}, privateKeys: [], presentation: false,
    library: { version: 1, tags: tagIds.map((id) => ({ id, name: id })), items: Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { description: '', tagIds: [], ...value }])) }, ...extra };
}

test('duplicate identity uses complete normalizeUrl equality and preserves scheme, query ordering and hash distinctions', () => {
  const navigation = nav([site('a', { url: 'https://EXAMPLE.test:443/article?one=1#part' }), site('b'),
    site('http', { url: URL.replace('https:', 'http:') }), site('query', { url: 'https://example.test/article?two=2&one=1#part' }),
    site('query-order', { url: 'https://example.test/article?one=1&two=2#part' }), site('hash', { url: URL.replace('#part', '#other') }),
    site('no-hash', { url: URL.split('#')[0] })]);
  const found = findNavigationDuplicates(navigation, prefs());
  assert.equal(found.groups.length, 1);
  assert.equal(found.groups[0].url, URL);
  assert.deepEqual(found.groups[0].items.map((item) => item.entry.id), ['a', 'b']);
  assert.equal(found.groups[0].items[0].entry.url, 'https://EXAMPLE.test:443/article?one=1#part');
});

test('visible records are filtered before grouping, counts, location classification and tag descriptions', () => {
  const navigation = nav([site('a'), site('b'), folder('secret-folder', 2), site('child', { parentId: 'secret-folder', page: 2 }), site('private', { page: 3 })]);
  const preferences = prefs({ 'site:child': { description: 'secret description', tagIds: ['secret-tag'] } },
    { presentation: true, privateKeys: ['folder:secret-folder', 'site:private'] });
  const found = findNavigationDuplicates(navigation, preferences);
  assert.equal(found.sameLocation.length, 1); assert.equal(found.crossLocation.length, 0);
  assert.deepEqual(found.groups[0].items.map((item) => item.entry.id), ['a', 'b']);
  assert.ok(!JSON.stringify(found).includes('secret'));
  assert.equal(findNavigationDuplicates(nav([site('a'), site('private')]), { ...preferences, privateKeys: ['site:private'] }).groups.length, 0);
  assert.equal(findNavigationDuplicates(navigation, { ...preferences, privateKeys: [] }, { hiddenKeys: new Set(['site:b', 'site:child', 'site:private']) }).groups.length, 0);
});

test('same-location and cross-location sections are disjoint, using actual parent folder location', () => {
  const navigation = nav([site('a'), site('b'), folder('folder-b', 2), site('child', { parentId: 'folder-b', page: 0 })]);
  navigation.settings.desktopPages = { 2: { id: 'desktop-two', name: 'Two' } };
  const found = findNavigationDuplicates(navigation, prefs());
  assert.equal(found.sameLocation.length, 0); assert.equal(found.crossLocation.length, 1);
  assert.equal(found.groups[0].items[2].page, 2);
  assert.equal(found.groups[0].items[2].desktopId, 'desktop-two');
  assert.equal(found.groups[0].items[2].locationKey, 'folder:folder-b');
});

test('preview deletes nothing by default and explicit non-merge preserves keep metadata and alias without mutating input', () => {
  const navigation = nav([site('a'), site('b')]);
  const preferences = prefs({ 'site:a': { description: 'Keeper', tagIds: ['tag-a'] }, 'site:b': { description: 'Discarded metadata', tagIds: ['tag-b'] } }, { aliases: { 'site:a': 'keep alias', 'site:b': 'other alias' } });
  const before = JSON.stringify({ navigation, preferences });
  assert.equal(previewNavigationDuplicates(navigation, preferences, { keepId: 'a', removeIds: [] }).status, 'invalid');
  const plan = previewNavigationDuplicates(navigation, preferences, { keepId: 'a', removeIds: ['b'] });
  assert.equal(plan.status, 'ready'); assert.equal(plan.mergeMetadata, false);
  assert.deepEqual(plan.mergedMetadata, { description: 'Keeper', tagIds: ['tag-a'] });
  assert.equal(plan.expectedMetadata.length, 2); assert.equal(plan.removeCount, 1);
  assert.equal(before, JSON.stringify({ navigation, preferences }));
});

test('explicit merge deduplicates nonempty descriptions and unions tags, with keep order first and private inheritance', () => {
  const navigation = nav([site('b'), site('a'), folder('secret-folder'), site('c', { parentId: 'secret-folder' })]);
  const preferences = prefs({ 'site:a': { description: 'Keeper', tagIds: ['tag-b', 'tag-a'] }, 'site:b': { description: 'Keeper', tagIds: ['tag-a'] },
    'site:c': { description: 'Other', tagIds: ['tag-c'] } }, { privateKeys: ['folder:secret-folder'] });
  const plan = previewNavigationDuplicates(navigation, preferences, { keepId: 'a', removeIds: ['c', 'b'], mergeMetadata: true });
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.mergedMetadata, { description: 'Keeper\n\nOther', tagIds: ['tag-b', 'tag-a', 'tag-c'] });
  assert.deepEqual(plan.removeIds, ['b', 'c']);
  assert.deepEqual(plan.addedPrivateKeys, ['site:a']);
  assert.deepEqual(previewNavigationDuplicates(navigation, preferences, { keepId: 'a', removeIds: ['c'], mergeMetadata: false }).addedPrivateKeys, []);
});

test('merging rejects overflowing descriptions or tags without truncating the preview', () => {
  const navigation = nav([site('a'), site('b')]);
  const description = previewNavigationDuplicates(navigation, prefs({ 'site:a': { description: 'a'.repeat(999) }, 'site:b': { description: 'b' } }), { keepId: 'a', removeIds: ['b'], mergeMetadata: true });
  assert.equal(description.status, 'invalid'); assert.equal(description.reason, 'metadata-limits');
  assert.equal(description.mergedMetadata.description.length, 1002);
  const tags = previewNavigationDuplicates(navigation, prefs({ 'site:a': { tagIds: Array.from({ length: 20 }, (_, i) => `tag-${i}`) }, 'site:b': { tagIds: ['extra'] } }), { keepId: 'a', removeIds: ['b'], mergeMetadata: true });
  assert.equal(tags.status, 'invalid'); assert.equal(tags.mergedMetadata.tagIds.length, 21);
});

test('an overflowing merge cannot read or write transaction records', async () => {
  const navigation = nav([site('a'), site('b')]);
  const plan = previewNavigationDuplicates(navigation, prefs({ 'site:a': { description: 'a'.repeat(1000) }, 'site:b': { description: 'b' } }), { keepId: 'a', removeIds: ['b'], mergeMetadata: true });
  const forbidden = async () => assert.fail('An invalid merge must not enter storage');
  await assert.rejects(commitNavigationDuplicates(plan, { storageApi: { loadState: forbidden, saveStateWithTrash: forbidden }, loadPreferences: forbidden }), { code: 'DUPLICATE_METADATA_LIMIT' });
});

test('invalid, hidden, self-selected or different-URL targets never produce a ready preview', () => {
  const navigation = nav([site('a'), site('b'), site('other', { url: 'https://other.test/' }), folder('folder')]);
  for (const removeIds of [['a'], ['b', 'b'], ['missing'], ['folder'], ['other']]) {
    assert.notEqual(previewNavigationDuplicates(navigation, prefs(), { keepId: 'a', removeIds }).status, 'ready');
  }
  assert.equal(previewNavigationDuplicates(navigation, prefs({}, { presentation: true, privateKeys: ['site:b'] }), { keepId: 'a', removeIds: ['b'] }).status, 'hidden');
});

test('commit rejects stale navigation, stale preferences, same-revision metadata changes and tampered preview before calling storage', async () => {
  const navigation = nav([site('a'), site('b')]), preferences = prefs({ 'site:a': { description: 'Keep' }, 'site:b': { description: 'Remove' } });
  const plan = previewNavigationDuplicates(navigation, preferences, { keepId: 'a', removeIds: ['b'], mergeMetadata: true });
  let saves = 0;
  const deps = (state = navigation, current = preferences) => ({ storageApi: { loadState: async () => copy(state), saveStateWithTrash: async () => { saves++; } }, loadPreferences: async () => copy(current) });
  const copy = (value) => structuredClone(value);
  await assert.rejects(commitNavigationDuplicates(plan, deps({ ...navigation, revision: 1 })), { code: 'REVISION_CONFLICT' });
  await assert.rejects(commitNavigationDuplicates(plan, deps(navigation, { ...preferences, revision: 5 })), { code: 'REVISION_CONFLICT' });
  const changed = copy(preferences); changed.library.items['site:b'].description = 'Other tab';
  await assert.rejects(commitNavigationDuplicates(plan, deps(navigation, changed)), { code: 'REVISION_CONFLICT' });
  const tampered = copy(plan); tampered.mergedMetadata.description = 'Never previewed';
  await assert.rejects(commitNavigationDuplicates(tampered, deps()), { code: 'REVISION_CONFLICT' });
  assert.equal(saves, 0);
});

function transactionHarness(t, navigation, preferences) {
  const preferenceKey = 'covelet.content.preferences.v1', queues = new Map();
  const records = { [preferenceKey]: structuredClone(preferences) };
  let envelope = { version: 1, state: structuredClone(navigation), snapshots: [] }, writes = 0, independentWrites = 0, rejectWrite = false;
  const locks = { request(name, options, callback) {
    const run = callback || options, next = (queues.get(name) || Promise.resolve()).then(run);
    queues.set(name, next.catch(() => {})); return next;
  } };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  t.after(() => { if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else delete globalThis.navigator; });
  t.mock.method(localData, 'get', async (requested) => {
    const keys = requested == null ? Object.keys(records) : Array.isArray(requested) ? requested : [requested];
    return structuredClone(Object.fromEntries(keys.filter((key) => Object.hasOwn(records, key)).map((key) => [key, records[key]])));
  });
  t.mock.method(localData, 'set', async (patch) => { independentWrites++; Object.assign(records, structuredClone(patch)); });
  const configStore = { read: async () => structuredClone(envelope), write: async (value, extra = {}) => {
    if (rejectWrite) throw Error('Synthetic transaction quota failure');
    const nextEnvelope = structuredClone(value), nextRecords = structuredClone(extra);
    envelope = nextEnvelope; Object.assign(records, nextRecords); writes++;
  } };
  const store = createStorage({ configStore, locks, iconResources: { read: async () => null } });
  return { store, records, preferenceKey, deps: { storageApi: store, loadPreferences: loadContentPreferences },
    failWrites() { rejectWrite = true; },
    get preferences() { return records[preferenceKey]; }, get envelope() { return structuredClone(envelope); },
    get writes() { return writes; }, get independentWrites() { return independentWrites; } };
}

test('real navigation transaction merges metadata and privacy with duplicate trash in one write, preserving keep alias and the emptied folder', async (t) => {
  const navigation = nav([site('a'), folder('source-folder'), site('b', { parentId: 'source-folder' }), site('unrelated', { url: 'https://unrelated.test/' })]);
  const preferences = prefs({ 'site:a': { description: 'Keep description', tagIds: ['keep-tag'] }, 'site:b': { description: 'Source description', tagIds: ['source-tag'] },
    'site:unrelated': { tagIds: ['public-tag'] } }, { aliases: { 'site:a': 'keeper alias', 'site:b': 'source alias' }, privateKeys: ['folder:source-folder'] });
  const subject = transactionHarness(t, navigation, preferences), before = structuredClone({ navigation, preferences });
  const plan = previewNavigationDuplicates(navigation, preferences, { keepId: 'a', removeIds: ['b'], mergeMetadata: true });
  const result = await commitNavigationDuplicates(plan, subject.deps);
  assert.deepEqual(result.removedIds, ['b']);
  assert.deepEqual(result.state.entries.map((entry) => entry.id), ['a', 'source-folder', 'unrelated']);
  assert.equal(result.state.trash.items.length, 1);
  assert.equal(result.state.trash.items[0].kind, 'site');
  assert.equal(result.state.trash.items[0].origin.parentId, 'source-folder');
  assert.deepEqual(result.state.trash.items[0].ownedEntries.map((entry) => entry.id), ['b']);
  assert.deepEqual(getContentMetadata(subject.preferences, 'site:a'), { description: 'Keep description\n\nSource description', tagIds: ['keep-tag', 'source-tag'] });
  assert.equal(subject.preferences.aliases['site:a'], 'keeper alias');
  assert.ok(subject.preferences.privateKeys.includes('site:a')); assert.ok(subject.preferences.privateKeys.includes('site:b'));
  assert.deepEqual(getContentTags({ ...subject.preferences, presentation: true }).map((tag) => tag.id), ['public-tag']);
  assert.equal(subject.writes, 1); assert.equal(subject.independentWrites, 0);
  assert.equal(result.state.revision, navigation.revision + 1);
  assert.equal(subject.preferences.revision, preferences.revision + 1);
  assert.deepEqual({ navigation, preferences }, before);
});

test('storage quota failure preserves navigation, metadata, privacy and trash as one transaction', async (t) => {
  const navigation = nav([site('a'), site('b')]), preferences = prefs({ 'site:a': { description: 'Keep' }, 'site:b': { description: 'Source' } });
  const subject = transactionHarness(t, navigation, preferences), before = structuredClone({ envelope: subject.envelope, records: subject.records });
  const plan = previewNavigationDuplicates(navigation, preferences, { keepId: 'a', removeIds: ['b'], mergeMetadata: true });
  subject.failWrites(); await assert.rejects(commitNavigationDuplicates(plan, subject.deps), /quota failure/);
  assert.deepEqual({ envelope: subject.envelope, records: subject.records }, before);
  assert.equal(subject.writes + subject.independentWrites, 0);
});

test('metadata changed after preview recheck is still rejected under the real navigation/preferences lock', async (t) => {
  const navigation = nav([site('a'), site('b')]), preferences = prefs({ 'site:a': { description: 'Keep' }, 'site:b': { description: 'Source' } });
  const subject = transactionHarness(t, navigation, preferences);
  const plan = previewNavigationDuplicates(navigation, preferences, { keepId: 'a', removeIds: ['b'] });
  const storageApi = { ...subject.store, saveStateWithTrash: (...args) => {
    // Deliberately keep the global revision unchanged to exercise the per-key
    // baseline, independently of the stronger normal revision check.
    subject.preferences.library.items['site:b'].description = 'External update';
    return subject.store.saveStateWithTrash(...args);
  } };
  await assert.rejects(commitNavigationDuplicates(plan, { ...subject.deps, storageApi }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(subject.envelope.state, navigation);
  assert.equal(subject.preferences.library.items['site:b'].description, 'External update');
  assert.equal(subject.writes + subject.independentWrites, 0);
});

test('a keeper becoming private during commit blocks a non-merge removal too', async (t) => {
  const navigation = nav([site('a'), site('b')]), preferences = prefs();
  const subject = transactionHarness(t, navigation, preferences);
  const plan = previewNavigationDuplicates(navigation, preferences, { keepId: 'a', removeIds: ['b'] });
  const storageApi = { ...subject.store, saveStateWithTrash: (...args) => {
    subject.preferences.presentation = true; subject.preferences.privateKeys = ['site:a'];
    return subject.store.saveStateWithTrash(...args);
  } };
  await assert.rejects(commitNavigationDuplicates(plan, { ...subject.deps, storageApi }), { code: 'PRIVACY_LOCKED' });
  assert.deepEqual(subject.envelope.state, navigation);
  assert.equal(subject.writes + subject.independentWrites, 0);
});
