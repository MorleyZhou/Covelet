import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createReadingLibrary, createEmptyReadingLibrary, validateReadingLibrary, validateReadingArticle, READING_LIBRARY_KEY, READING_LIBRARY_LIMITS } from './reading-library.js';
import { extractReadingHtml } from './reading-extraction.js';

const url = 'https://reading.example/story#part', body = 'A saved reading body has enough useful content to form a safe independent local article.';
const record = (id = 'reading-a') => ({ id, url, title: 'Saved link', revision: 1, createdAt: 1, updatedAt: 1, status: 'unread' });
const extraction = () => extractReadingHtml(`<article><h1>Local title</h1><p>${body}</p></article>`, url, { documentFactory: (html) => new JSDOM(html).window.document });
function fixture({ extract = async () => extraction() } = {}) {
  const values = { 'covelet.tools.v1': { reading: [record()] }, 'covelet.content.preferences.v1': { version: 1, revision: 2, aliases: {}, presentation: false, privateKeys: [] } }, listeners = new Set();
  let writes = 0, failWrite = false, sequence = 0, queue = Promise.resolve();
  const store = {
    get: async (key) => Object.hasOwn(values, key) ? { [key]: structuredClone(values[key]) } : {},
    updateMany(keys, update) {
      const pending = queue.then(async () => {
        const result = await update(structuredClone(values)); if (failWrite) throw Object.assign(Error('storage full'), { code: 'LOCAL_DATA_WRITE_FAILED' });
        const changes = {};
        for (const [key, value] of Object.entries(result.writes)) { changes[key] = { oldValue: values[key], newValue: structuredClone(value) }; values[key] = structuredClone(value); }
        writes++; for (const listener of listeners) listener(changes); return result.writes;
      }); queue = pending.catch(() => {}); return pending;
    },
    subscribe: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
  };
  const api = createReadingLibrary({ store, extract, now: () => 100, uuid: () => `highlight-${++sequence}` });
  return { api, values, get writes() { return writes; }, set failWrite(value) { failWrite = value; } };
}

test('cache load is local-only, article save has canonical offsets and preserves original fragment URL', async () => {
  let reads = 0; const f = fixture({ extract: async () => { reads++; return extraction(); } });
  assert.deepEqual(await f.api.loadReadingLibrary(), createEmptyReadingLibrary()); assert.equal(reads, 0);
  const article = await f.api.saveReadingArticle(record()); assert.equal(article.url, url); assert.equal(article.revision, 1); assert.equal(reads, 1);
  assert.equal(article.text, article.blocks.map((block) => block.text).join('\n\n'));
  assert.equal((await f.api.loadReadingLibrary()).articles['reading-a'].title, 'Local title'); assert.equal(reads, 1);
});

test('network, extraction and invalid extracted content safely fall back without changing existing local content', async () => {
  const f = fixture(); await f.api.saveReadingArticle(record()); const before = structuredClone(f.values);
  for (const extract of [async () => { throw Error('network credentials secret'); }, async () => null, async () => ({ ...extraction(), text: 'forged' })]) {
    const other = createReadingLibrary({ store: { get: async () => ({}), updateMany: async () => assert.fail('failed extraction must not write') }, extract });
    assert.equal(await other.saveReadingArticle(record()), null);
  }
  assert.deepEqual(f.values, before);
});

test('save CAS checks live reading id, revision and URL after fetch, and blocks hidden records atomically', async () => {
  for (const change of [(values) => { values['covelet.tools.v1'].reading = []; }, (values) => { values['covelet.tools.v1'].reading[0].url = 'https://changed.example/'; }, (values) => { values['covelet.tools.v1'].reading[0].revision++; }, (values) => { values['covelet.content.preferences.v1'].presentation = true; values['covelet.content.preferences.v1'].privateKeys = ['reading:reading-a']; }]) {
    let f; f = fixture({ extract: async () => { change(f.values); return extraction(); } });
    await assert.rejects(f.api.saveReadingArticle(record()), (error) => ['READING_STALE', 'PRIVACY_LOCKED'].includes(error.code)); assert.equal(f.writes, 0);
  }
});

test('highlights anchor exact UTF-16 selection, survive reload, support guarded note edits and explicit removal', async () => {
  const f = fixture(), article = await f.api.saveReadingArticle(record()), start = article.text.indexOf('safe'), quote = 'safe independent';
  const added = await f.api.addReadingHighlight(record().id, { start, end: start + quote.length, quote, note: 'Annotation' }, { expectedRevision: 1, expectedReadingRevision: 1, expectedPreferencesRevision: 2 });
  assert.equal(added.id, 'highlight-1'); assert.equal(added.revision, 1);
  assert.equal((await f.api.loadReadingLibrary()).articles[record().id].highlights[0].quote, quote);
  await assert.rejects(f.api.updateReadingHighlight(record().id, added.id, { note: 'stale' }, { expectedRevision: 1 }), { code: 'READING_STALE' });
  const updated = await f.api.updateReadingHighlight(record().id, added.id, { note: 'Revised annotation' }, { expectedRevision: 2, expectedHighlightRevision: 1 }); assert.equal(updated.revision, 2);
  await assert.rejects(f.api.deleteReadingHighlight(record().id, added.id, { expectedRevision: 3, expectedHighlightRevision: 1 }), { code: 'READING_STALE' });
  await f.api.deleteReadingHighlight(record().id, added.id, { expectedRevision: 3, expectedHighlightRevision: 2 });
  assert.deepEqual((await f.api.loadReadingLibrary()).articles[record().id].highlights, []);
});

test('fresh and legacy preferences use revision zero for first article/highlight CAS without persisting defaults', async () => {
  for (const stored of [undefined, { version: 1, aliases: {} }]) {
    const f = fixture();
    if (stored === undefined) delete f.values['covelet.content.preferences.v1']; else f.values['covelet.content.preferences.v1'] = stored;
    await f.api.saveReadingArticle(record(), { expectedPreferencesRevision: 0 });
    const added = await f.api.addReadingHighlight(record().id, { start: 0, end: 5, quote: 'Local', note: 'first' }, { expectedRevision: 1, expectedPreferencesRevision: 0 });
    assert.equal(added.quote, 'Local'); assert.deepEqual(f.values['covelet.content.preferences.v1'], stored);
    const before = structuredClone(f.values[READING_LIBRARY_KEY]);
    await assert.rejects(f.api.addReadingHighlight(record().id, { start: 0, end: 5, quote: 'Local', note: 'stale' }, { expectedRevision: 2, expectedPreferencesRevision: 1 }), { code: 'READING_STALE' });
    assert.deepEqual(f.values[READING_LIBRARY_KEY], before);
  }
});

test('present malformed preferences never become an implicit revision-zero privacy default', async () => {
  for (const stored of [null, {}, { revision: 0 }, { version: 1, aliases: {}, revision: '0' }, { version: 1, aliases: {}, presentation: 'false' }, { version: 1, aliases: {}, privateKeys: 'reading:reading-a' }]) {
    const f = fixture(); f.values['covelet.content.preferences.v1'] = stored;
    await assert.rejects(f.api.saveReadingArticle(record(), { expectedPreferencesRevision: 0 }), { code: 'READING_STALE' }); assert.equal(f.writes, 0);
  }
});

test('forged selections, unknown fields and excessive annotation length are rejected before any write', async () => {
  const f = fixture(); await f.api.saveReadingArticle(record()); const before = structuredClone(f.values);
  for (const selection of [{ start: 0, end: 5, quote: 'wrong', note: '' }, { start: -1, end: 2, quote: 'xx', note: '' }, { start: 0, end: 5, quote: 'Local', note: 'x'.repeat(2001) }, { start: 0, end: 5, quote: 'Local', note: '', html: '<script>' }])
    await assert.rejects(f.api.addReadingHighlight(record().id, selection), { code: 'READING_LIBRARY_INVALID' });
  assert.deepEqual(f.values, before);
});

test('concurrent highlight additions serialize without dropping a unique annotation and concurrent refresh preserves highlights', async () => {
  let release; const f = fixture(); const article = await f.api.saveReadingArticle(record());
  const selection = { start: 0, end: 5, quote: 'Local', note: '' };
  await Promise.all([f.api.addReadingHighlight(record().id, selection), f.api.addReadingHighlight(record().id, { ...selection, note: 'second' })]);
  let saved = (await f.api.loadReadingLibrary()).articles[record().id]; assert.equal(saved.highlights.length, 2);
  const refreshed = await f.api.saveReadingArticle(record()); assert.equal(refreshed.highlights.length, 2);
  const changed = createReadingLibrary({ store: { get: async () => ({}), updateMany: async (keys, update) => update(structuredClone(f.values)) }, extract: async () => ({ ...extraction(), title: 'New title', text: 'changed', blocks: [{ type: 'paragraph', text: 'changed', start: 0, end: 7 }] }) });
  await assert.rejects(changed.saveReadingArticle(record()), { code: 'READING_ARTICLE_CHANGED' });
  saved = (await f.api.loadReadingLibrary()).articles[record().id]; assert.equal(saved.text, article.text); assert.equal(saved.highlights.length, 2);
});

test('typography settings persist with envelope CAS and subscriptions publish only validated library changes', async () => {
  const f = fixture(), received = [], unsubscribe = f.api.subscribeReadingLibrary((value) => received.push(value));
  const settings = await f.api.saveReadingSettings({ fontSize: 22, lineHeight: 2, theme: 'dark' }, { expectedRevision: 0 }); assert.equal(settings.fontSize, 22);
  assert.equal(received.length, 1); assert.equal(received[0].revision, 1);
  await assert.rejects(f.api.saveReadingSettings({ fontSize: 5 }), { code: 'READING_LIBRARY_INVALID' });
  await assert.rejects(f.api.saveReadingSettings({ theme: 'light' }, { expectedRevision: 0 }), { code: 'READING_STALE' });
  unsubscribe(); await f.api.saveReadingSettings({ theme: 'light' }); assert.equal(received.length, 1);
  assert.equal((await f.api.loadReadingLibrary()).settings.theme, 'light');
});

test('capacity rejects instead of evicting articles or highlights; explicit orphan cleanup frees the retained body', async () => {
  const f = fixture(), article = await f.api.saveReadingArticle(record()), library = await f.api.loadReadingLibrary();
  for (let index = 0; index < 500; index++) library.articles[`reading-${index}`] = { ...structuredClone(article), id: `reading-${index}` };
  assert.throws(() => validateReadingLibrary(library), { code: 'READING_LIBRARY_CAPACITY' });
  const tooMany = structuredClone(article); tooMany.highlights = Array.from({ length: 101 }, (_, index) => ({ id: `highlight-${index}`, start: 0, end: 5, quote: 'Local', note: '', revision: 1, createdAt: 1, updatedAt: 1 }));
  assert.throws(() => validateReadingArticle(tooMany), { code: 'READING_LIBRARY_CAPACITY' });
  const huge = structuredClone(article); huge.text = '中'.repeat(90000); huge.blocks = [{ type: 'paragraph', text: huge.text, start: 0, end: huge.text.length }];
  assert.throws(() => validateReadingArticle(huge), { code: 'READING_LIBRARY_CAPACITY' });
  f.values['covelet.tools.v1'].reading = [];
  await f.api.removeReadingArticle(record().id, { expectedRevision: article.revision }); assert.deepEqual((await f.api.loadReadingLibrary()).articles, {});
});

test('failed encrypted commit and privacy or metadata races preserve article body and annotation', async () => {
  const f = fixture(); await f.api.saveReadingArticle(record()); const before = structuredClone(f.values); f.failWrite = true;
  await assert.rejects(f.api.addReadingHighlight(record().id, { start: 0, end: 5, quote: 'Local', note: '' }), { code: 'LOCAL_DATA_WRITE_FAILED' }); assert.deepEqual(f.values, before);
  f.failWrite = false; f.values['covelet.content.preferences.v1'].revision++;
  await assert.rejects(f.api.addReadingHighlight(record().id, { start: 0, end: 5, quote: 'Local', note: '' }, { expectedPreferencesRevision: 2 }), { code: 'READING_STALE' });
  f.values['covelet.content.preferences.v1'].presentation = true; f.values['covelet.content.preferences.v1'].privateKeys = ['reading:reading-a'];
  await assert.rejects(f.api.removeReadingArticle(record().id, { expectedRevision: 1 }), { code: 'PRIVACY_LOCKED' });
  assert.deepEqual(f.values[READING_LIBRARY_KEY], before[READING_LIBRARY_KEY]);
});

test('strict validation rejects unknown versions/fields, unsafe image URLs, invalid block offsets and null URLs', () => {
  const article = { ...extraction(), id: 'reading-a', highlights: [], revision: 1, createdAt: 1, updatedAt: 1 };
  for (const input of [{ ...createEmptyReadingLibrary(), version: 2 }, { ...createEmptyReadingLibrary(), extra: true }, { ...createEmptyReadingLibrary(), articles: { 'reading-a': { ...article, html: '<img>' } } }]) assert.throws(() => validateReadingLibrary(input), { code: 'READING_LIBRARY_INVALID' });
  assert.throws(() => validateReadingArticle({ ...article, url: null }), { code: 'READING_LIBRARY_INVALID' });
  const malformed = structuredClone(article); malformed.blocks[0].start++;
  assert.throws(() => validateReadingArticle(malformed), { code: 'READING_LIBRARY_INVALID' });
  const image = { ...article, text: `${article.text}\n\nimage`, blocks: [...article.blocks, { type: 'image', text: 'image', start: article.text.length + 2, end: article.text.length + 7, url: 'javascript:alert(1)' }] };
  assert.throws(() => validateReadingArticle(image), { code: 'READING_LIBRARY_INVALID' });
  const emptyImage = extractReadingHtml(`<article><img src=/empty.png><p>${body}</p></article>`, url, { documentFactory: (source) => new JSDOM(source).window.document });
  assert.doesNotThrow(() => validateReadingArticle({ ...emptyImage, id: 'reading-a', highlights: [], revision: 1, createdAt: 1, updatedAt: 1 }));
  assert.equal(READING_LIBRARY_LIMITS.totalBytes, 32 * 1024 * 1024);
});

test('aggregate library capacity rejects an otherwise valid sub-500 collection before any cache is evicted', () => {
  const text = 'x'.repeat(60000), template = { id: 'reading-a', url, title: 'Local', text,
    blocks: [{ type: 'paragraph', text, start: 0, end: text.length }], highlights: [], revision: 1, createdAt: 1, updatedAt: 1 };
  const library = createEmptyReadingLibrary();
  for (let index = 0; index < 300; index++) library.articles[`reading-${index}`] = { ...template, id: `reading-${index}` };
  assert.throws(() => validateReadingLibrary(library), { code: 'READING_LIBRARY_CAPACITY' });
  assert.equal(Object.keys(library.articles).length, 300);
});

test('explicit orphan cleanup retains active and recycled reading articles and refuses stale or corrupt membership', async () => {
  const f = fixture(), article = await f.api.saveReadingArticle(record()), library = await f.api.loadReadingLibrary();
  for (const identity of ['recycled', 'orphan']) library.articles[identity] = { ...structuredClone(article), id: identity };
  f.values[READING_LIBRARY_KEY] = library; f.values['covelet.tools.v1'].trash = [{ kind: 'reading', record: { id: 'recycled' } }];
  await assert.rejects(f.api.cleanupRemovedReadingArticles({ expectedRevision: library.revision - 1 }), { code: 'READING_STALE' });
  assert.deepEqual(await f.api.cleanupRemovedReadingArticles({ expectedRevision: library.revision }), { removed: 1 });
  assert.deepEqual(Object.keys((await f.api.loadReadingLibrary()).articles).sort(), ['reading-a', 'recycled']);
  delete f.values['covelet.tools.v1']; const before = structuredClone(f.values[READING_LIBRARY_KEY]);
  await assert.rejects(f.api.cleanupRemovedReadingArticles(), { code: 'READING_STALE' }); assert.deepEqual(f.values[READING_LIBRARY_KEY], before);
});
