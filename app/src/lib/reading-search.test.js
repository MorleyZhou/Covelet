import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCoveletContent } from './content-search.js';
import { filterSavedContent } from './saved-views.js';
import { parseStructuredSearch } from './structured-search.js';
import { isSyncRecord } from './sync-data-rules.js';

const reading = { id: 'article-a', title: 'Saved link', url: 'https://reading.example.test/article', status: 'unread' };
const article = { id: reading.id, url: reading.url, title: 'Locally extracted title', text: 'The body contains a singular quasar observation.',
  highlights: [{ quote: 'quasar observation', note: 'Follow up with telescope calibration' }] };
const tools = () => ({ notes: [], reading: [reading], readingLibrary: { articles: { [reading.id]: structuredClone(article) } } });
const preferences = { aliases: {}, privateKeys: [], presentation: false,
  library: { tags: [{ id: 'research', name: 'Research' }], items: { 'reading:article-a': { tagIds: ['research'], description: '' } } } };

test('local full text matches article body, extracted title and highlight notes through structured filters', () => {
  for (const phrase of ['quasar', 'calibration', 'Locally extracted']) {
    const parsed = parseStructuredSearch(`tag:Research type:reading is:unread domain:reading.example.test ${phrase}`, { tags: preferences.library.tags });
    assert.equal(parsed.status, 'ready');
    const result = filterSavedContent({ entries: [], settings: {} }, tools(), preferences, parsed.filters);
    assert.deepEqual(result.rows.map((row) => row.id), [reading.id]);
    assert.equal(result.rows[0].type, 'reading');
    assert.equal(result.rows[0].url, reading.url);
  }
  const parsed = parseStructuredSearch('is:read calibration');
  assert.equal(filterSavedContent({ entries: [], settings: {} }, tools(), preferences, parsed.filters).rows.length, 0);
});

test('hidden articles are excluded before body/highlight access, snippets and result counts', () => {
  const input = tools();
  Object.defineProperty(input.readingLibrary.articles, reading.id, { get() { throw Error('Hidden article was inspected'); } });
  const locked = { ...preferences, presentation: true, privateKeys: [`reading:${reading.id}`] };
  const result = filterSavedContent({ entries: [], settings: {} }, input, locked, { query: 'calibration', type: 'reading' });
  assert.deepEqual(result.rows, []);
});

test('removed and changed-address articles cannot contribute stale full text', () => {
  const input = tools(); input.reading = [{ ...reading, url: 'https://reading.example.test/new' }];
  assert.deepEqual(searchCoveletContent([], input, 'quasar'), []);
  input.reading = [];
  assert.deepEqual(searchCoveletContent([], input, 'calibration'), []);
});

test('reader bodies, annotations and RSS inbox stay outside synchronization in both directions', () => {
  for (const key of ['covelet.reading-library.v1', 'covelet.rss.inbox.v1', 'covelet.language.v1']) assert.equal(isSyncRecord('preferences', key), false);
  assert.equal(isSyncRecord('preferences', 'covelet.tools.v1'), true);
});
