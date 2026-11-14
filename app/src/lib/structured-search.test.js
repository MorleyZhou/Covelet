import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseStructuredSearch, removeStructuredCondition } from './structured-search.js';
import { createEmptyState, letterIcon } from './model.js';
import { defaultSavedFilters, filterSavedContent, resolveSavedView, validateSavedFilters, validateSavedView } from './saved-views.js';
import { validateContentPreferences } from './content-preferences.js';
import { validateSyncValue } from './sync-data-rules.js';

const tags = [{ id: 'project-a', name: '项目 A' }, { id: 'done', name: 'Done' }, { id: 'quote', name: 'A "quoted" tag' }];
const parse = (raw, options = {}) => parseStructuredSearch(raw, { tags, ...options });

test('structured operators resolve stable tag IDs, combine all positive tags and exclude independently', () => {
  const result = parse('login tag:"项目 A" -tag:done type:reading is:unread domain:DOCS.EXAMPLE.COM');
  assert.equal(result.status, 'ready'); assert.equal(result.structured, true); assert.equal(result.textQuery, 'login');
  assert.deepEqual(result.filters, { ...defaultSavedFilters(), query: 'login', tagIds: ['project-a'], excludeTagIds: ['done'], type: 'reading', readingStatus: 'unread', domain: 'docs.example.com' });
  assert.equal(result.conditions.length, 5);
  assert.deepEqual(result.conditions.map((condition) => condition.operator), ['tag', '-tag', 'type', 'is', 'domain']);
  assert.equal(parse('TAG:"项目 A" tag:"项目 A"').filters.tagIds.length, 1);
  assert.equal(new Set(parse('TAG:"项目 A" tag:"项目 A"').conditions.map((condition) => condition.key)).size, 2);
  assert.deepEqual(parse('tag:"A \\"quoted\\" tag"').filters.tagIds, ['quote']);
});

test('literal text, URLs and engine-keyword queries preserve their original meaning', () => {
  for (const raw of ['React 配置', 'https://example.com/tag:Done?type:reading#is:unread', 'example.com:8443/type:note', 'localhost:3000/tag:Done', 'chrome://settings/', 'gh react tag:Done']) {
    const actual = parse(raw);
    if (raw === 'gh react tag:Done') { assert.equal(actual.textQuery, 'gh react'); assert.equal(actual.structured, true); }
    else { assert.equal(actual.status, 'ready'); assert.equal(actual.structured, false); assert.equal(actual.textQuery, raw); }
  }
  assert.equal(parse('  gh   react  ').textQuery, 'gh   react');
  assert.equal(parse('https://example.com/query?tag:Done type:site').textQuery, 'https://example.com/query?tag:Done');
  for (const raw of ['gh type:foo', 'gh tag:Missing', 'gh tag:"unclosed', 'gh unknown:value']) {
    const external = parse(raw, { parseOperators: false });
    assert.equal(external.status, 'ready'); assert.equal(external.structured, false); assert.equal(external.textQuery, raw);
    assert.equal(external.filters.query, raw); assert.deepEqual(external.conditions, []);
  }
});

test('invalid or hidden conditions never produce fallback filters', () => {
  const cases = [
    ['tag:', 'missing-value'], ['tag:"项目 A', 'unclosed-quote'], ['tag:"项目 A"extra', 'invalid-value'],
    ['tag:"bad\\escape"', 'invalid-escape'], ['tag:Missing', 'unknown-tag'], ['unknown:value', 'unknown-operator'],
    ['type:unknown', 'invalid-type'], ['is:due', 'invalid-status'], ['domain:https://example.com', 'invalid-domain'],
    ['tag:"项目 A" -tag:"项目 A"', 'conflicting-condition'], ['type:note is:unread', 'conflicting-condition'],
    ['type:note type:site', 'conflicting-condition'], ['is:read is:unread', 'conflicting-condition'],
  ];
  for (const [raw, code] of cases) {
    const actual = parse(raw); assert.equal(actual.status, 'invalid', raw); assert.equal(actual.filters, null, raw); assert.equal(actual.error.code, code, raw);
  }
  const hidden = parse('tag:Done', { tags: tags.filter((tag) => tag.id !== 'done') });
  assert.deepEqual(hidden.error, parse('tag:Missing').error);
  for (const raw of [null, {}, 'x'.repeat(2001), 'unsafe\0query']) assert.equal(parse(raw).status, 'invalid');
});

test('base filters are immutable, operators override matching scalar controls, and tag chips remove only their own spans', () => {
  const baseFilters = { ...defaultSavedFilters(), type: 'all', tagIds: ['project-a'], domain: 'old.example', scope: { kind: 'folder', folderId: 'f' } };
  const before = structuredClone(baseFilters), raw = 'login  -tag:Done domain:new.example';
  const result = parse(raw, { baseFilters });
  assert.equal(result.filters.domain, 'new.example'); assert.deepEqual(result.filters.tagIds, ['project-a']);
  assert.deepEqual(result.filters.scope, { kind: 'folder', folderId: 'f' }); assert.deepEqual(baseFilters, before);
  assert.equal(removeStructuredCondition(raw, result.conditions[0]), 'login domain:new.example');
  assert.equal(removeStructuredCondition(raw, { start: -1, end: 4 }), raw);
  assert.equal(parse('is:read', { baseFilters: { type: 'note' } }).status, 'invalid');
  assert.equal(parse('', { baseFilters: { unknown: true } }).error.code, 'invalid-filters');
  const draft = parse('type:site', { baseFilters: { scope: { kind: 'desktop', desktopId: '@page:0' } } });
  assert.equal(draft.status, 'ready'); assert.equal(draft.filters.scope.desktopId, '@page:0');
  assert.throws(() => validateSavedView({ id: 'draft', revision: 1, name: 'Draft', ...draft.filters }));
});

function libraryContext() {
  const navigation = createEmptyState();
  navigation.entries = ['a', 'b'].map((id, index) => ({ id, type: 'site', name: '中文标题', url: `https://example.com/${id}`, groupId: 'group-home', parentId: null, order: index, icon: letterIcon(id) }));
  const preferences = { version: 1, revision: 1, aliases: { 'site:a': 'login shortcut' }, privateKeys: [], presentation: false,
    library: { version: 1, tags, items: {
      'site:a': { description: 'login docs', tagIds: ['project-a'] }, 'site:b': { description: 'login docs', tagIds: ['project-a', 'done'] },
      'note:n': { description: '', tagIds: ['project-a'] },
    } } };
  const tools = { notes: [{ id: 'n', title: 'Notes', body: 'login solution' }], reading: [] };
  return { navigation, preferences, tools };
}

test('the shared saved-view model applies exclusions without changing alias, body and pinyin search', () => {
  const { navigation, tools, preferences } = libraryContext();
  const find = (query) => filterSavedContent(navigation, tools, preferences, parse(query).filters).rows.map((row) => row.key);
  assert.deepEqual(find('login tag:"项目 A" -tag:Done'), ['site:a', 'note:n']);
  assert.deepEqual(find('shortcut -tag:Done'), ['site:a']);
  assert.deepEqual(find('zwbt -tag:Done'), ['site:a']);
  assert.deepEqual(find('solution -tag:Done'), ['note:n']);
  assert.deepEqual(find('-tag:Done type:site'), ['site:a']);
});

test('saved exclusions survive field validation and sync while missing/hidden references stay restrictive', async () => {
  const { navigation, tools, preferences } = libraryContext();
  const view = validateSavedView({ id: 'saved', revision: 1, name: 'Unfinished', ...parse('-tag:Done').filters });
  const portable = { ...preferences, library: { ...preferences.library, views: [view] } };
  assert.deepEqual(validateContentPreferences(portable).library.views[0].excludeTagIds, ['done']);
  await validateSyncValue('preferences', 'covelet.content.preferences.v1', portable);
  assert.deepEqual(resolveSavedView(view, { navigation, tools, preferences }).rows.map((row) => row.key), ['site:a', 'note:n']);
  const renamed = structuredClone(preferences); renamed.library.tags.find((tag) => tag.id === 'done').name = 'Completed';
  assert.equal(resolveSavedView(view, { navigation, tools, preferences: renamed }).rows.length, 2);
  const deleted = structuredClone(preferences); deleted.library.tags = deleted.library.tags.filter((tag) => tag.id !== 'done');
  assert.equal(resolveSavedView(view, { navigation, tools, preferences: deleted }).reason, 'missing-tag');
  const locked = structuredClone(preferences); locked.presentation = true; locked.privateKeys = ['site:b'];
  assert.equal(resolveSavedView(view, { navigation, tools, preferences: locked }).status, 'hidden');
  for (const excludeTagIds of [null, ['done', 'done'], ['unsafe/id'], Array.from({ length: 21 }, (_, index) => `tag-${index}`)]) assert.throws(() => validateSavedFilters({ excludeTagIds }));
  assert(!Object.hasOwn(validateSavedView({ id: 'legacy', revision: 1, name: 'Legacy', ...defaultSavedFilters() }), 'excludeTagIds'));
  const future = structuredClone(portable); future.library.views[0].futureOperator = true;
  await assert.rejects(validateSyncValue('preferences', 'covelet.content.preferences.v1', future));
});

test('the frozen published 0.5.1 validator refuses new exclusions without dropping the condition', async () => {
  // This fixture is the unchanged saved-views.js source at the published
  // v0.5.1 tag. Only import locations change when loading it in this test.
  const frozen = await readFile(new URL('../../tests/fixtures/compatibility/saved-views-0.5.1.js', import.meta.url), 'utf8');
  const source = frozen.replace(/from '(\.[^']+)'/gu, (_match, relative) => `from '${new URL(relative, new URL('./saved-views.js', import.meta.url)).href}'`);
  const legacy = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const view = { id: 'portable', revision: 1, name: 'Unfinished', ...parse('-tag:Done').filters }, before = structuredClone(view);
  assert.throws(() => legacy.validateSavedView(view), { code: 'SAVED_VIEW_INVALID' });
  assert.deepEqual(view, before);
  assert.doesNotThrow(() => legacy.validateSavedView({ id: 'legacy', revision: 1, name: 'Legacy', ...defaultSavedFilters() }));
  for (const patch of [{ tagMode: 'any' }, { revisit: 'today' }, { revisit: 'next7d' }]) {
    const extended = { id: 'extended', revision: 1, name: 'Extended', ...defaultSavedFilters(), ...patch }, before = structuredClone(extended);
    assert.throws(() => legacy.validateSavedView(extended), { code: 'SAVED_VIEW_INVALID' });
    assert.deepEqual(extended, before);
    assert.doesNotThrow(() => validateSavedView(extended));
  }
});

test('an ANY base condition accepts overlapping excluded tags without changing default ALL query conflicts', () => {
  const parsed = parse('tag:"项目 A" tag:Done -tag:Done', { baseFilters: { tagMode: 'any', revisit: 'next7d' } });
  assert.equal(parsed.status, 'ready'); assert.equal(parsed.filters.tagMode, 'any'); assert.equal(parsed.filters.revisit, 'next7d');
  assert.deepEqual(parsed.filters.tagIds, ['project-a', 'done']); assert.deepEqual(parsed.filters.excludeTagIds, ['done']);
  assert.equal(parse('tag:Done -tag:Done').status, 'invalid');
  assert.equal(parse('tag:Done -tag:Done', { baseFilters: { tagMode: 'any' } }).status, 'ready');
  const { navigation, tools, preferences } = libraryContext();
  assert.deepEqual(filterSavedContent(navigation, tools, preferences, parsed.filters, { today: '2026-11-14' }).rows, []);
  const union = parse('tag:"项目 A" tag:Done -tag:Done', { baseFilters: { tagMode: 'any' } });
  assert.deepEqual(filterSavedContent(navigation, tools, preferences, union.filters).rows.map((row) => row.key), ['site:a', 'note:n']);
});
