import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createEmptyState, letterIcon, parseBookmarks, validateState } from './model.js';
import { parseOneTabLinks, parseRaindropBookmarks } from './import-sources.js';
import { prepareImport, prepareImportWithMetadata } from './import-plan.js';
import { readBookmarkFile } from './bookmark-file.js';

globalThis.DOMParser = new JSDOM('').window.DOMParser;
const fixture = (name) => readFile(new URL(`../../tests/fixtures/import-sources/${name}`, import.meta.url), 'utf8');
const metadata = (tagIds = [], description = '') => ({ description, tagIds });
const preferences = (patch = {}) => ({ version: 1, revision: 4, aliases: {}, privateKeys: [], presentation: false,
  library: { version: 1, tags: [{ id: 'local-tag', name: 'Design' }], items: {} }, ...patch });
const site = (id, url, order, parentId = null) => ({ id, type: 'site', name: id, url, groupId: 'group-home', parentId,
  page: 0, order, icon: letterIcon(id) });
const planOf = (sites) => ({ folders: [], sites: sites.map((item) => ({ name: 'Source', url: 'https://example.com/', folder: null, ...item })), invalid: [], duplicateCount: 0,
  source: { format: 'raindrop-html' } });
const choice = (targetKey, sourceIndices, patch = {}) => ({ targetKey, sourceIndices, unionTags: true, description: 'append', ...patch });

test('historical Raindrop attributes preserve known and unknown fields while ordinary bookmarks remain unchanged', async () => {
  const text = await fixture('raindrop-historical.html'), ordinary = parseBookmarks(text), plan = parseRaindropBookmarks(text);
  assert.equal(plan.sites.length, 3); assert.deepEqual(plan.source, { format: 'raindrop-html' });
  assert.deepEqual(plan.sites[0].metadata, { tagNames: ['Research', 'Design'], description: 'An example description & a literal <mark> label.' });
  assert.deepEqual(plan.sites[1].metadata, { tagNames: [], description: '' });
  assert.equal(Object.hasOwn(plan.sites[2], 'metadata'), false);
  assert(ordinary.sites.every((item) => !Object.hasOwn(item, 'metadata')));
  assert.equal(plan.sites[0].url, 'https://example.com/article?part=a&view=full#section');
  assert.equal(plan.sites[0].folder, 'Research');
  assert(!JSON.stringify(plan).includes('This is a highlight'));
});

test('OneTab plain serializer keeps URL pipes, title pipes, order, groups and line numbers', async () => {
  const plan = parseOneTabLinks(`\uFEFF${(await fixture('onetab-2.25.txt')).replace(/\r\n?/gu, '\n').replaceAll('\n', '\r\n')}\r\nhttps://example.edu/\r\n`);
  assert.deepEqual(plan.source, { format: 'onetab-text', supportedVersion: '2.25' });
  assert.deepEqual(plan.sites.map(({ url, name, line }) => [url, name, line]), [
    ['https://example.com/one?x=a|b#part', 'Example one', 1], ['https://example.org/two', 'Example | second title', 2],
    ['https://example.net/three', '第三页', 4], ['https://example.edu/', 'example.edu', 6],
  ]);
  assert.deepEqual(plan.folders.map((folder) => folder.name), ['OneTab 组 1', 'OneTab 组 2', 'OneTab 组 3']);
  const renamed = structuredClone(plan), oldName = renamed.folders[1].name;
  renamed.folders[1].name = 'Edited group';
  for (const item of renamed.sites) if (item.folder === oldName) item.folder = 'Edited group';
  const prepared = prepareImport(createEmptyState(), renamed);
  assert.equal(prepared.state.entries.find((entry) => entry.url === 'https://example.net/three').parentId,
    prepared.state.entries.find((entry) => entry.name === 'Edited group').id);
});

test('source parsing stays inert with hostile attributes/resources and never extracts DD or Markdown links', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', (...args) => { requests.push(args); throw Error('network forbidden'); });
  const text = '<DL><script>globalThis.importExecuted=true</script><img src="https://tracker.example/pixel"><DT><A HREF="https://safe.example/" TAGS="&lt;script&gt;" DESCRIPTION="&lt;img src=x onerror=alert(1)&gt;">Safe</A><DD><A HREF="https://ignored.example/">Highlight link</A></DL>';
  const plan = await readBookmarkFile(new File([text], 'raindrop.html'), { format: 'raindrop-html' });
  assert.equal(plan.sites.length, 1); assert.equal(plan.sites[0].metadata.description, '<img src=x onerror=alert(1)>');
  assert.equal(globalThis.importExecuted, undefined);
  const rejected = parseOneTabLinks('javascript:alert(1) | Unsafe\nhttps://user:pass@example.com/ | Credentials\n[Markdown](https://ignored.example/)\nhttps://safe.example/ | Safe');
  assert.equal(rejected.invalid.length, 3); assert.equal(rejected.sites.length, 1); assert.deepEqual(requests, []);
  assert.throws(() => parseOneTabLinks('x'.repeat(5 * 1024 * 1024 + 1)), /5 MB/);
  assert.throws(() => parseOneTabLinks('https://example.com/ | Title\n'.repeat(2001)), /2000/);
  assert.throws(() => parseOneTabLinks(' \n\r\n'), /没有可导入的网址/);
});

test('new source metadata reuses tag identity and keeps navigation/prefs inputs untouched', () => {
  const state = createEmptyState(), prefs = preferences(), plan = planOf([{ metadata: { tagNames: ['Ｄｅｓｉｇｎ', 'Research'], description: 'Description' } }]);
  const before = structuredClone({ state, prefs, plan }), result = prepareImportWithMetadata(state, prefs, plan);
  assert.deepEqual({ state, prefs, plan }, before);
  assert.equal(result.addedSites, 1); assert.equal(result.updatedSites, 0); assert.equal(result.addedTags, 1); assert.deepEqual(result.issues, []);
  assert.equal(result.sourcePreferencesRevision, 4); assert.equal(result.nextPreferences.revision, 4); assert.equal(result.preferencesChanged, true);
  const entry = result.state.entries[0], imported = result.nextPreferences.library.items[`site:${entry.id}`];
  assert.equal(imported.description, 'Description'); assert.equal(imported.tagIds[0], 'local-tag');
  assert.deepEqual(result.nextPreferences.library.tags.map((tag) => tag.name), ['Design', 'Research']);
});

test('default duplicates retain every local copy; explicit URL-group target and sources merge only supported metadata', () => {
  const state = createEmptyState(); state.entries = [site('a', 'https://example.com/', 0), site('b', 'https://example.com/', 1)];
  const prefs = preferences(); prefs.aliases['site:a'] = 'alias'; prefs.library.items['site:a'] = metadata(['local-tag'], 'Local');
  const plan = planOf([{ name: 'Changed title', metadata: { tagNames: ['Research'], description: 'Source' } },
    { metadata: { tagNames: ['Another'], description: 'Other source' } }]);
  const untouched = prepareImportWithMetadata(state, prefs, plan);
  assert.equal(untouched.addedSites, 0); assert.equal(untouched.updatedSites, 0); assert.equal(untouched.preferencesChanged, false);
  assert.deepEqual(untouched.nextPreferences, prefs); assert.deepEqual(untouched.duplicateGroups[0].targets.map((item) => item.targetKey), ['site:a', 'site:b']);
  const result = prepareImportWithMetadata(state, prefs, plan, { metadataChoices: { 'https://example.com/': choice('site:a', [0]) } });
  assert.deepEqual(result.state.entries, state.entries); assert.equal(result.updatedSites, 1); assert.equal(result.addedTags, 1);
  assert.deepEqual(result.expectedMetadata, [{ key: 'site:a', description: 'Local', tagIds: ['local-tag'] }]);
  assert.equal(result.nextPreferences.library.items['site:a'].description, 'Local\n\nSource');
  assert.equal(result.nextPreferences.library.items['site:b'], undefined); assert.equal(result.nextPreferences.aliases['site:a'], 'alias');
  assert(!result.nextPreferences.library.tags.some((tag) => tag.name === 'Another'));
});

test('source-source duplicate metadata needs an explicit stable new-row target; unchecked sources cannot contribute', () => {
  const plan = planOf([{ metadata: { tagNames: ['First'], description: 'First' } }, { metadata: { tagNames: ['Second'], description: 'Second' } }]);
  const state = createEmptyState(), prefs = preferences(), initial = prepareImportWithMetadata(state, prefs, plan);
  assert.equal(initial.skippedDuplicates, 1); assert.equal(initial.duplicateGroups[0].newTargetKey, 'new:0');
  assert.deepEqual(initial.nextPreferences.library.tags.map((tag) => tag.name), ['Design', 'First']);
  const options = { metadataChoices: { 'https://example.com/': choice('new:0', [0, 1]) } };
  const merged = prepareImportWithMetadata(state, prefs, plan, options);
  assert.equal(merged.nextPreferences.library.items[`site:${merged.rows[0].entryId}`].description, 'First\n\nSecond');
  assert.equal(merged.updatedSites, 0); assert.equal(merged.addedTags, 2);
  const invalid = prepareImportWithMetadata(state, prefs, plan, { ...options, selectedIndices: [0] });
  assert.equal(invalid.nextPreferences, null); assert.equal(invalid.issues[0].code, 'IMPORT_CHOICE_INVALID');
  const secondOnly = prepareImportWithMetadata(state, prefs, plan, { selectedIndices: [1] });
  assert(secondOnly.nextPreferences.library.tags.some((tag) => tag.name === 'Second'));
  assert(!secondOnly.nextPreferences.library.tags.some((tag) => tag.name === 'First'));
});

test('capacity problems remain actionable and can be avoided by deselection, keeping fields or disabling metadata', () => {
  const state = createEmptyState(), prefs = preferences(), long = 'x'.repeat(1001);
  const plan = planOf([{ url: 'https://example.com/bad', metadata: { description: long } }, { url: 'https://example.com/good', metadata: { description: 'Good' } }]);
  const blocked = prepareImportWithMetadata(state, prefs, plan);
  assert.equal(blocked.nextPreferences, null); assert.equal(blocked.issues[0].field, 'description');
  assert.deepEqual(prepareImportWithMetadata(state, prefs, plan, { selectedIndices: [1] }).issues, []);
  const without = prepareImportWithMetadata(state, prefs, plan, { includeMetadata: false });
  assert.equal(without.addedSites, 2); assert.equal(without.preferencesChanged, false); assert.deepEqual(without.nextPreferences, prefs);
  state.entries = [site('a', 'https://example.com/bad', 0)];
  const keep = prepareImportWithMetadata(state, prefs, plan, { selectedIndices: [0], metadataChoices: {
    'https://example.com/bad': choice('site:a', [0], { description: 'keep', unionTags: false }),
  } });
  assert.deepEqual(keep.issues, []); assert.equal(keep.updatedSites, 0);
  assert.throws(() => prepareImportWithMetadata(createEmptyState(), prefs, planOf([{ metadata: { description: 3 } }]), { selectedIndices: [] }), { code: 'IMPORT_METADATA_INVALID' });
});

test('merged descriptions/tags and full library capacity are checked together without partial results', () => {
  const state = createEmptyState(); state.entries = [site('a', 'https://example.com/', 0)];
  const prefs = preferences(), tags = Array.from({ length: 200 }, (_, index) => ({ id: `tag-${index}`, name: `Tag ${index}` }));
  prefs.library.tags = tags; prefs.library.items['site:a'] = metadata(tags.slice(0, 20).map((tag) => tag.id), 'x'.repeat(998));
  const plan = planOf([{ metadata: { tagNames: ['New'], description: 'More' } }]);
  const before = structuredClone(prefs), result = prepareImportWithMetadata(state, prefs, plan, {
    metadataChoices: { 'https://example.com/': choice('site:a', [0]) },
  });
  assert.equal(result.nextPreferences, null); assert(result.issues.some((issue) => issue.code === 'IMPORT_METADATA_LIMIT'));
  assert.deepEqual(prefs, before);
});

test('copy mode never merges old records; invalid decisions and locked presentation cannot broaden import', () => {
  const state = createEmptyState(); state.entries = [site('a', 'https://example.com/', 0)];
  const prefs = preferences(), plan = planOf([{ metadata: { description: 'Source' } }]);
  const copied = prepareImportWithMetadata(state, prefs, plan, { skipDuplicates: false });
  assert.equal(copied.addedSites, 1); assert.equal(copied.updatedSites, 0); assert.equal(copied.nextPreferences.library.items['site:a'], undefined);
  for (const metadataChoices of [
    { 'https://example.com/': choice('site:missing', [0]) },
    { 'https://EXAMPLE.com/': choice('site:a', [0]) },
    { 'https://example.com/': choice('site:a', [0, 0]) },
  ]) assert.equal(prepareImportWithMetadata(state, prefs, plan, { metadataChoices }).issues[0].code, 'IMPORT_CHOICE_INVALID');
  assert.equal(prepareImportWithMetadata(state, prefs, plan, { skipDuplicates: false,
    metadataChoices: { 'https://example.com/': choice('site:a', [0]) } }).issues[0].code, 'IMPORT_CHOICE_INVALID');
  for (const input of [plan, planOf([{ url: 'https://different.example/' }])]) {
    assert.throws(() => prepareImportWithMetadata(state, { ...prefs, presentation: true }, input), { code: 'PRIVACY_LOCKED' });
  }
  assert.doesNotThrow(() => validateState(copied.state));
});

test('description append is idempotent for full paragraph blocks without dropping unrelated substring text', () => {
  const state = createEmptyState(); state.entries = [site('a', 'https://example.com/', 0)];
  const prefs = preferences(); prefs.library.items['site:a'] = metadata([], 'Local\n\nSource');
  const plan = planOf([{ metadata: { description: 'Source' } }, { metadata: { description: 'Source' } }, { metadata: { description: 'our' } }]);
  const same = prepareImportWithMetadata(state, prefs, plan, { metadataChoices: { 'https://example.com/': choice('site:a', [0, 1], { unionTags: false }) } });
  assert.equal(same.updatedSites, 0); assert.equal(same.preferencesChanged, false);
  const result = prepareImportWithMetadata(state, prefs, plan, { metadataChoices: { 'https://example.com/': choice('site:a', [0, 1, 2], { unionTags: false }) } });
  assert.equal(result.nextPreferences.library.items['site:a'].description, 'Local\n\nSource\n\nour');
  assert.deepEqual(result.duplicateGroups[0].targets[0].metadata.description, 'Local\n\nSource', 'candidate preview remains the pre-merge baseline');
});

test('new target previews include resolved tag names and support a partial explicit target choice', () => {
  const plan = planOf([{ metadata: { tagNames: ['New'], description: 'Own' } }, { metadata: { description: 'Other' } }]);
  const result = prepareImportWithMetadata(createEmptyState(), preferences(), plan, {
    metadataChoices: { 'https://example.com/': choice('new:0', [], { unionTags: false, description: 'keep' }) },
  });
  assert.deepEqual(result.issues, []); assert.deepEqual(result.duplicateGroups[0].targets[0].metadata.tagNames, ['New']);
  assert.equal(result.duplicateGroups[0].targets[0].metadata.description, 'Own');
  assert(!Object.hasOwn(result.nextPreferences.library.items[`site:${result.rows[0].entryId}`], 'tagNames'));
});

test('a large source prepares bounded metadata in one library and aggregate byte overflow is actionable', () => {
  const state = createEmptyState(), prefs = preferences();
  const plan = planOf(Array.from({ length: 1900 }, (_, index) => ({ url: `https://example.com/${index}`,
    metadata: { tagNames: ['Shared'], description: `Description ${index}` } })));
  const result = prepareImportWithMetadata(state, prefs, plan);
  assert.equal(result.addedSites, 1900); assert.equal(result.addedTags, 1); assert.equal(result.nextPreferences.library.tags.length, 2);
  assert.equal(Object.keys(result.nextPreferences.library.items).length, 1900); assert.deepEqual(result.issues, []);
  const overflowing = planOf(Array.from({ length: 1100 }, (_, index) => ({ url: `https://example.com/${index}`, metadata: { description: 'x'.repeat(1000) } })));
  const blocked = prepareImportWithMetadata(state, prefs, overflowing);
  assert.equal(blocked.nextPreferences, null); assert(blocked.issues.some((issue) => issue.field === 'library'));
  assert.equal(state.entries.length, 0); assert.deepEqual(prefs, preferences());
});

test('canonical URL grouping retains protocol, query and fragment distinctions and rejects forged row metadata', () => {
  const state = createEmptyState(); state.entries = [site('a', 'https://example.com/?q=1#one', 0)];
  const plan = planOf([{ url: 'https://EXAMPLE.com:443/?q=1#one' }, { url: 'http://example.com/?q=1#one' },
    { url: 'https://example.com/?q=2#one' }, { url: 'https://example.com/?q=1#two' }]);
  const result = prepareImportWithMetadata(state, preferences(), plan);
  assert.equal(result.addedSites, 3); assert.equal(result.skippedDuplicates, 1);
  assert.equal(result.duplicateGroups[0].url, 'https://example.com/?q=1#one');
  for (const forged of [planOf([{ id: 'untrusted-entry' }]), planOf([{ metadata: { private: false } }]),
    { ...plan, source: { format: 'remote-account' } }]) {
    assert.throws(() => prepareImportWithMetadata(createEmptyState(), preferences(), forged, { selectedIndices: [] }), { code: 'IMPORT_METADATA_INVALID' });
  }
});

test('explicit file routing preserves legacy Markdown/HTML behavior and source format boundaries', async () => {
  const text = await fixture('onetab-2.25.txt');
  assert.equal((await readBookmarkFile(new File([text], 'export.txt'), { format: 'onetab-text' })).sites.length, 3);
  const markdown = await readBookmarkFile(new File(['[Example](https://example.com/)'], 'links.md'));
  assert.equal(markdown.sites.length, 1); assert.equal(markdown.source, undefined);
  const plan = await readBookmarkFile(new File([await fixture('raindrop-historical.html')], 'bookmarks.html'));
  assert.equal(plan.source, undefined); assert(plan.sites.every((item) => item.metadata === undefined));
});
