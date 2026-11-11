import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, letterIcon } from './model.js';
import { collectCoveletContent, exactDesktopMatches, searchCoveletContent } from './content-search.js';
import { defaultSavedFilters, filterSavedContent, getSavedViews, resolveSavedView, validateSavedFilters, validateSavedView } from './saved-views.js';

const site = (id, page = 0, parentId = null, url = `https://example.com/${id}`) => ({ id, type: 'site', name: `Alpha ${id}`, url,
  groupId: 'group-home', parentId, page, order: 0, icon: letterIcon(id) });
function context() {
  const navigation = createEmptyState();
  navigation.settings.pages = [0, 1];
  navigation.settings.desktopPages = { 0: { id: 'desktop-a', name: 'Work' }, 1: { id: 'desktop-b', name: 'Other' } };
  navigation.entries = [site('a'), site('b', 1, null, 'https://example.net/b'),
    { id: 'folder-a', type: 'folder', name: 'References', groupId: 'group-home', parentId: null, page: 0, order: 2, icon: letterIcon('R') },
    site('child', 1, 'folder-a', 'https://docs.example.com/child')];
  const tools = { notes: [{ id: 'note-a', title: 'Draft', body: 'Alpha note' }],
    reading: [{ id: 'reading-a', title: 'Article', url: 'https://docs.example.com/article', status: 'unread' },
      { id: 'reading-b', title: 'Archive', url: 'https://example.net/archive', status: 'archived' }] };
  const preferences = { version: 1, revision: 1, aliases: {}, privateKeys: [], presentation: false,
    library: { version: 1, tags: [{ id: 'work', name: 'Work' }, { id: 'keep', name: 'Keep' }, { id: 'secret', name: 'Secret' }], items: {
      'site:a': { description: 'Alpha reference', tagIds: ['work', 'keep'] }, 'site:child': { description: 'Hidden descendant', tagIds: ['secret'] },
      'note:note-a': { description: '', tagIds: ['work'] }, 'reading:reading-a': { description: 'Alpha article', tagIds: ['work', 'keep'] },
    } } };
  return { navigation, tools, preferences };
}
const view = (patch = {}) => ({ id: 'view-a', revision: 1, name: 'Saved', ...defaultSavedFilters(), ...patch });

test('the shared collector supplies blank-query lists beyond the bounded home search', () => {
  const navigation = createEmptyState(); navigation.entries = Array.from({ length: 150 }, (_, index) => site(`site-${index}`));
  assert.equal(searchCoveletContent(navigation, null, 'Alpha', { limit: 999 }).length, 100);
  assert.equal(collectCoveletContent(navigation, null, 'Alpha').length, 150);
  const preferences = { aliases: {}, privateKeys: [], presentation: false };
  assert.equal(filterSavedContent(navigation, null, preferences, { type: 'site' }).rows.length, 150);
  assert.equal(searchCoveletContent(navigation, null, '').length, 0);
});

test('an exact desktop remains discoverable when higher-scoring sites fill the display limit', () => {
  const { navigation, tools, preferences } = context();
  navigation.entries = Array.from({ length: 24 }, (_, index) => ({ ...site(`site-${index}`), name: 'Work' }));
  preferences.aliases = Object.fromEntries(navigation.entries.map((entry) => [`site:${entry.id}`, 'Work']));
  const result = filterSavedContent(navigation, tools, preferences, { query: 'Work' });
  const desktops = (rows) => rows.filter((row) => row.type === 'desktop').map((row) => row.record);
  assert.equal(result.status, 'ready');
  assert.equal(exactDesktopMatches(desktops(result.rows.slice(0, 24)), 'Work').length, 0);
  assert.deepEqual(exactDesktopMatches(desktops(result.rows), 'Work').map((record) => record.id), ['desktop-a']);
  assert.equal(exactDesktopMatches(desktops(filterSavedContent(navigation, tools, preferences, { query: 'Work', type: 'navigation' }).rows), 'Work').length, 0);
});

test('duplicate exact desktop names stay ambiguous when only one fits the display limit', () => {
  const { navigation, tools, preferences } = context();
  navigation.settings.desktopPages[1].name = 'Work';
  navigation.entries = Array.from({ length: 23 }, (_, index) => ({ ...site(`site-${index}`), name: 'Work' }));
  preferences.aliases = Object.fromEntries(navigation.entries.map((entry) => [`site:${entry.id}`, 'Work']));
  const result = filterSavedContent(navigation, tools, preferences, { query: 'Work' });
  const desktops = (rows) => rows.filter((row) => row.type === 'desktop').map((row) => row.record);
  assert.equal(exactDesktopMatches(desktops(result.rows.slice(0, 24)), 'Work').length, 1);
  assert.deepEqual(exactDesktopMatches(desktops(result.rows), 'Work').map((record) => record.id), ['desktop-a', 'desktop-b']);
});

test('all conditions intersect while domains match exact hostnames and reading status stays type-specific', () => {
  const { navigation, tools, preferences } = context();
  const filters = { query: 'Alpha', tagIds: ['work', 'keep'], domain: 'DOCS.EXAMPLE.COM', readingStatus: 'unread' };
  assert.deepEqual(filterSavedContent(navigation, tools, preferences, filters).rows.map((row) => row.key), ['reading:reading-a']);
  assert.deepEqual(filterSavedContent(navigation, tools, preferences, { ...filters, readingStatus: null }).rows.map((row) => row.key), ['reading:reading-a']);
  assert.deepEqual(filterSavedContent(navigation, tools, preferences, { query: 'Alpha', tagIds: ['work', 'keep'], domain: 'EXAMPLE.COM' }).rows.map((row) => row.key), ['site:a']);
  navigation.entries.push(site('bad-domain', 0, null, 'https://notexample.com/'));
  assert(!filterSavedContent(navigation, tools, preferences, { domain: 'example.com' }).rows.some((row) => row.id === 'bad-domain'));
  assert.deepEqual(validateSavedFilters({ domain: '例子.中国' }).domain, 'xn--fsqu00a.xn--fiqs8s');
  for (const domain of ['https://example.com', 'example.com/path', 'evil@example.com', 'example.com:8443']) assert.throws(() => validateSavedFilters({ domain }));
});

test('logical scopes include folder descendants and draft page scopes are accepted only explicitly', () => {
  const { navigation, tools, preferences } = context();
  const scoped = filterSavedContent(navigation, tools, preferences, { scope: { kind: 'desktop', desktopId: 'desktop-a' } });
  assert.deepEqual(scoped.rows.map((row) => row.key), ['desktop:desktop-a', 'site:a', 'folder:folder-a', 'site:child']);
  assert.deepEqual(filterSavedContent(navigation, tools, preferences, { scope: { kind: 'folder', folderId: 'folder-a' } }).rows.map((row) => row.key), ['site:child']);
  const temporary = { scope: { kind: 'desktop', desktopId: '@page:1' } };
  assert.equal(filterSavedContent(navigation, tools, preferences, temporary).status, 'invalid');
  assert.equal(filterSavedContent(navigation, tools, preferences, temporary, { allowDraftScopes: true }).status, 'ready');
  assert.equal(filterSavedContent(navigation, tools, preferences, { scope: { kind: 'desktop', desktopId: '@page:99' } }, { allowDraftScopes: true }).status, 'invalid');
  assert.throws(() => validateSavedView(view(temporary)));
  const sites = filterSavedContent(navigation, tools, preferences, {}, { allowedTypes: ['site', 'folder'] });
  assert(sites.rows.every((row) => ['site', 'folder'].includes(row.type)));
  assert.equal(filterSavedContent(navigation, tools, preferences, { type: 'note' }, { allowedTypes: ['site', 'folder'] }).reason, 'unsupported-type');
  assert(filterSavedContent(navigation, tools, preferences, { type: 'navigation' }).rows.every((row) => ['site', 'folder'].includes(row.type)));
  assert.doesNotThrow(() => validateSavedView(view({ type: 'navigation' })));
});

test('deleted references remain invalid and never relax an ALL-tag or location condition', () => {
  const { navigation, tools, preferences } = context();
  for (const filters of [{ tagIds: ['work', 'deleted'] }, { scope: { kind: 'desktop', desktopId: 'deleted' } }, { scope: { kind: 'folder', folderId: 'deleted' } }]) {
    const result = filterSavedContent(navigation, tools, preferences, filters);
    assert.equal(result.status, 'invalid'); assert.deepEqual(result.rows, []);
  }
  assert.doesNotThrow(() => validateSavedView(view({ tagIds: ['deleted'], scope: { kind: 'desktop', desktopId: 'deleted' } })));
});

test('revisit filters intersect with status and tags using the supplied local day without changing records', () => {
  const { navigation, tools, preferences } = context(), today = '2026-11-11';
  tools.reading = [
    { id: 'today', title: 'Today', url: 'https://example.com/today', status: 'read', revisitOn: today },
    { id: 'overdue', title: 'Overdue', url: 'https://example.com/overdue', status: 'archived', revisitOn: '2026-11-10' },
    { id: 'future', title: 'Future', url: 'https://example.com/future', status: 'unread', revisitOn: '2026-11-12' },
    { id: 'none', title: 'Unscheduled', url: 'https://example.com/none', status: 'unread' },
  ];
  preferences.library.items['reading:today'] = { description: 'selected', tagIds: ['work'] };
  const before = structuredClone(tools);
  const ids = (filters, day = today) => filterSavedContent(navigation, tools, preferences, filters, { today: day }).rows.map((row) => row.id);
  assert.deepEqual(ids({ revisit: 'due' }), ['today', 'overdue']);
  assert.deepEqual(ids({ revisit: 'scheduled' }), ['today', 'overdue', 'future']);
  assert.deepEqual(ids({ revisit: 'none' }), ['none']);
  assert.deepEqual(ids({ revisit: 'due', readingStatus: 'archived' }), ['overdue']);
  assert.deepEqual(ids({ revisit: 'due', tagIds: ['work'] }), ['today']);
  assert.deepEqual(ids({ revisit: 'due', type: 'navigation' }), []);
  assert.deepEqual(ids({ revisit: 'due', scope: { kind: 'desktop', desktopId: 'desktop-a' } }), []);
  assert.deepEqual(ids({ revisit: 'due' }, '2026-11-12'), ['today', 'overdue', 'future']);
  assert.deepEqual(resolveSavedView(view({ revisit: 'due' }), { navigation, tools, preferences, today }).rows.map((row) => row.id), ['today', 'overdue']);
  preferences.presentation = true; preferences.privateKeys = ['reading:today'];
  assert.deepEqual(ids({ revisit: 'due' }), ['overdue']);
  assert.deepEqual(tools, before);
  assert.equal(filterSavedContent(navigation, tools, preferences, { revisit: 'due' }, { today: 'invalid' }).status, 'invalid');
});

test('saved revisit conditions are optional, bounded and omitted when unset without rewriting legacy views', () => {
  const legacy = view(); delete legacy.revisit;
  assert.equal(validateSavedFilters(legacy.revisit === undefined ? {} : { revisit: legacy.revisit }).revisit, null);
  assert.deepEqual(validateSavedView(legacy), legacy);
  assert.deepEqual(validateSavedView(view({ revisit: null })), legacy);
  assert.equal(validateSavedView(view({ revisit: 'due' })).revisit, 'due');
  for (const revisit of ['', 'today', false, {}, 1]) assert.throws(() => validateSavedFilters({ revisit }));
});

test('private views and inherited hidden references do not expose names, results or saved conditions', () => {
  const { navigation, tools, preferences } = context();
  preferences.presentation = true; preferences.privateKeys = ['folder:folder-a', 'view:private'];
  preferences.library.views = [view({ id: 'private', name: 'Private name' }), view({ id: 'secret-tag', tagIds: ['secret'] }),
    view({ id: 'hidden-folder', scope: { kind: 'folder', folderId: 'folder-a' } }), view({ id: 'deleted-folder', scope: { kind: 'folder', folderId: 'missing' } }), view()];
  assert.deepEqual(getSavedViews(preferences, { navigation, tools }).map((item) => item.id), ['deleted-folder', 'view-a']);
  assert.equal(resolveSavedView(preferences.library.views[0], { navigation, tools, preferences }).reason, 'private-view');
  assert.equal(filterSavedContent(navigation, tools, preferences, { tagIds: ['secret', 'deleted'] }).status, 'hidden');
  assert(!filterSavedContent(navigation, tools, preferences, {}).rows.some((row) => row.id === 'child'));
  preferences.presentation = false;
  assert.equal(getSavedViews(preferences, { navigation, tools }).length, 5);
});
