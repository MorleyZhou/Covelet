import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEmptyState, configureWidget, validateState, letterIcon } from './model.js';
import { appendReferencedWidget, remapWidgetContentReferences, resolveReferencedWidget, widgetContentReference } from './referenced-widgets.js';
import { NOTES_WIDGET_ID, SAVED_VIEW_WIDGET_ID, validateWidgetConfig } from './widget-model.js';
import { privateContentKeys } from './presentation.js';
import { defaultSavedFilters } from './saved-views.js';
import { BUNDLED_EXTENSIONS } from './extensions.js';
import { builtinName, tr } from '../i18n/index.js';
import { validateSyncValue } from './sync-data-rules.js';

const pin = (id, extensionId = 'notes', target = 'note-a') => ({ id, type: 'widget', name: extensionId === 'notes' ? '便笺' : '动态清单', extensionId,
  config: { size: 'small', [extensionId === 'notes' ? 'noteId' : 'viewId']: target }, groupId: 'group-home', parentId: null,
  page: 0, order: 0, icon: letterIcon('Pin') });
const preferences = (patch = {}) => ({ version: 1, revision: 0, presentation: false, aliases: {}, privateKeys: [], library: { version: 1, tags: [], items: {}, views: [] }, ...patch });

test('reference configs keep legacy generic notes readable while validating bounded legacy and UUID target identities', () => {
  for (const size of ['mini', 'small', 'medium', 'large']) {
    assert.deepEqual(validateWidgetConfig('notes', { size }), { size });
    assert.deepEqual(validateWidgetConfig('read-later', { size }), { size });
    assert.deepEqual(validateWidgetConfig('saved-view', { size }), { size });
    for (const noteId of ['note-a', 'B', '123', '12345678-1234-1234-1234-123456789abc']) assert.deepEqual(validateWidgetConfig('notes', { size, noteId }), { size, noteId });
    assert.deepEqual(validateWidgetConfig('saved-view', { size, viewId: 'view-a' }), { size, viewId: 'view-a' });
  }
  for (const target of [null, undefined, '', 12, 'unsafe/id', 'note:one', 'note with spaces', 'x'.repeat(101)]) {
    assert.throws(() => validateWidgetConfig('notes', { size: 'small', noteId: target }));
    assert.throws(() => validateWidgetConfig('saved-view', { size: 'small', viewId: target }));
  }
  for (const [id, config] of [['notes', { viewId: 'a' }], ['read-later', { noteId: 'a' }], ['saved-view', { noteId: 'a' }], ['notes', { noteId: 'a', body: 'embedded stale snapshot' }]]) assert.throws(() => validateWidgetConfig(id, { size: 'small', ...config }));
  assert.deepEqual(widgetContentReference(pin('w')), { field: 'noteId', kind: 'note', id: 'note-a', key: 'note:note-a' });
  assert.equal(widgetContentReference({ type: 'site', config: { noteId: 'note-a' } }), null);
  assert.equal(widgetContentReference({ type: 'widget', extensionId: 'notes', config: { size: 'mini' } }), null);
  assert.equal(BUNDLED_EXTENSIONS.find((item) => item.id === SAVED_VIEW_WIDGET_ID).type, 'widget');
  assert.equal(builtinName(SAVED_VIEW_WIDGET_ID, '动态清单'), tr('动态清单'));
});

test('explicit pins create independent placements and generic configuration never replaces a pinned target', () => {
  const original = configureWidget(createEmptyState(), NOTES_WIDGET_ID, { size: 'mini' });
  const before = structuredClone(original), genericId = original.entries[0].id;
  const first = appendReferencedWidget(original, NOTES_WIDGET_ID, { size: 'small', noteId: 'note-a' });
  const second = appendReferencedWidget(first.state, NOTES_WIDGET_ID, { size: 'large', noteId: 'note-a' });
  assert.deepEqual(original, before); assert.notEqual(first.widgetId, second.widgetId);
  assert.equal(second.state.entries.length, 3); assert.equal(second.state.entries.find((entry) => entry.id === genericId).config.noteId, undefined);
  const genericChanged = configureWidget(second.state, NOTES_WIDGET_ID, { size: 'medium' });
  assert.equal(genericChanged.entries.find((entry) => entry.id === genericId).config.size, 'medium');
  assert.deepEqual(genericChanged.entries.find((entry) => entry.id === first.widgetId).config, { size: 'small', noteId: 'note-a' });
  const resized = configureWidget(genericChanged, NOTES_WIDGET_ID, { size: 'mini', noteId: 'note-a' }, first.widgetId);
  assert.equal(resized.entries.find((entry) => entry.id === first.widgetId).id, first.widgetId);
  const fourth = configureWidget(resized, NOTES_WIDGET_ID, { size: 'small', noteId: 'note-a' });
  assert.equal(fourth.entries.length, 4);
  const onlyPin = appendReferencedWidget(createEmptyState(), NOTES_WIDGET_ID, { size: 'small', noteId: 'note-a' }).state;
  assert.equal(configureWidget(onlyPin, NOTES_WIDGET_ID, { size: 'small' }).entries.length, 2);
  assert.throws(() => appendReferencedWidget(original, NOTES_WIDGET_ID, { size: 'small', noteId: 'note-a' }, { page: 9 }));
  assert.throws(() => appendReferencedWidget(original, 'read-later', { size: 'small' }));
});

test('notes resolve live identity across edits, deletion and restoration and inherit direct privacy even while missing', () => {
  const { state: navigation, widgetId } = appendReferencedWidget(createEmptyState(), 'notes', { size: 'small', noteId: 'note-a' });
  const entry = navigation.entries.find((entry) => entry.id === widgetId), note = { id: 'note-a', title: 'Project note', body: 'Original', revision: 1 };
  const environment = { navigation, tools: { notes: [note], reading: [] }, preferences: preferences() };
  assert.equal(resolveReferencedWidget(entry, environment).target, note);
  note.body = 'Edited content'; assert.equal(resolveReferencedWidget(entry, environment).target.body, 'Edited content');
  environment.tools.notes = []; assert.equal(resolveReferencedWidget(entry, environment).status, 'missing');
  environment.tools.notes = [{ ...note, revision: 2 }]; assert.equal(resolveReferencedWidget(entry, environment).status, 'ready');
  environment.preferences.privateKeys = ['note:note-a'];
  assert(privateContentKeys(navigation, environment.preferences).has(`widget:${widgetId}`));
  assert.equal(resolveReferencedWidget(entry, environment).status, 'ready');
  environment.preferences.presentation = true;
  const hidden = resolveReferencedWidget(entry, environment); assert.equal(hidden.status, 'hidden'); assert.equal(hidden.target, undefined); assert.deepEqual(hidden.rows, []);
  environment.tools.notes = []; assert.equal(resolveReferencedWidget(entry, environment).status, 'hidden');
  const placeholder = { ...entry, config: { size: 'small' } };
  assert.equal(resolveReferencedWidget(placeholder, environment).status, 'hidden');
  assert.equal(resolveReferencedWidget(placeholder, { ...environment, preferences: preferences() }).status, 'unconfigured');
});

test('view widgets evaluate current filters and condition-only hidden references without privacy recursion', () => {
  const navigation = createEmptyState();
  navigation.entries = [{ id: 'public', type: 'site', name: 'Public', url: 'https://example.test/public', groupId: 'group-home', parentId: null, order: 0, icon: letterIcon('P') },
    { id: 'private', type: 'site', name: 'Private', url: 'https://example.test/private', groupId: 'group-home', parentId: null, order: 1, icon: letterIcon('P') }];
  const added = appendReferencedWidget(navigation, 'saved-view', { size: 'medium', viewId: 'view-a' });
  const entry = added.state.entries.find((entry) => entry.id === added.widgetId);
  const data = preferences({ privateKeys: ['site:private'], library: { version: 1, tags: [{ id: 'private-tag', name: 'Secret tag' }], items: {
    'site:private': { description: 'Secret', tagIds: ['private-tag'] },
  }, views: [{ id: 'view-a', revision: 1, name: 'Project view', ...defaultSavedFilters(), tagIds: ['private-tag'] }] } });
  const environment = { navigation: added.state, tools: { notes: [], reading: [] }, preferences: data };
  assert.deepEqual(resolveReferencedWidget(entry, environment).rows.map((row) => row.id), ['private']);
  data.presentation = true;
  assert.equal(privateContentKeys(added.state, data).has(`widget:${entry.id}`), false, 'structural privacy does not evaluate saved queries');
  const hidden = resolveReferencedWidget(entry, environment);
  assert.equal(hidden.status, 'hidden'); assert.equal(hidden.target, undefined); assert.deepEqual(hidden.rows, []);
  data.presentation = false; data.library.views[0].tagIds = [];
  assert.equal(resolveReferencedWidget(entry, environment).rows.length, 2);
  data.library.views[0].excludeTagIds = ['private-tag']; data.presentation = true;
  assert.equal(resolveReferencedWidget(entry, environment).status, 'hidden');
  data.privateKeys.push('view:view-a'); assert(privateContentKeys(added.state, data).has(`widget:${entry.id}`));
  data.library.views = []; assert.equal(resolveReferencedWidget(entry, environment).status, 'hidden');
  data.presentation = false; assert.equal(resolveReferencedWidget(entry, environment).status, 'missing');
  data.library.views = [{ id: 'view-a', revision: 1, name: 'Unsupported', ...defaultSavedFilters(), futureOperator: true }];
  assert.equal(resolveReferencedWidget(entry, environment).status, 'invalid');
});

test('restore remaps only imported references, reserves collisions and leaves omitted targets safely missing', () => {
  const navigation = createEmptyState();
  navigation.entries = [pin('local'), pin('incoming-a'), pin('incoming-b'), pin('incoming-missing', 'saved-view', 'view-missing'), pin('incoming-view', 'saved-view', 'view-a')];
  const before = structuredClone(navigation), ids = ['collision', 'fresh'];
  const mapped = remapWidgetContentReferences(navigation, { importedWidgetIds: ['incoming-a', 'incoming-b', 'incoming-missing', 'incoming-view'],
    noteIdMap: new Map([['note-a', 'new-note-a']]), viewIdMap: new Map([['view-a', 'new-view-a']]), reservedViewIds: ['missing-view-collision'], makeId: () => ids.shift() });
  assert.deepEqual(navigation, before);
  assert.deepEqual(mapped.entries.map((entry) => widgetContentReference(entry).id), ['note-a', 'new-note-a', 'new-note-a', 'missing-view-fresh', 'new-view-a']);
  const isolated = remapWidgetContentReferences(navigation, { importedWidgetIds: ['incoming-a', 'incoming-b'], makeId: () => 'same' });
  assert.equal(isolated.entries[1].config.noteId, 'missing-note-same'); assert.equal(isolated.entries[2].config.noteId, 'missing-note-same');
  assert.throws(() => remapWidgetContentReferences(navigation, { makeId: () => '.' }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => remapWidgetContentReferences(navigation, { noteIdMap: new Map([['note-a', 'not/a/valid/id']]) }), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(navigation, before);
});

test('new references validate for portable navigation and the frozen published widget validator refuses them', async () => {
  const note = appendReferencedWidget(createEmptyState(), 'notes', { size: 'small', noteId: 'legacy-note-a' });
  const both = appendReferencedWidget(note.state, 'saved-view', { size: 'large', viewId: 'view-a' }).state;
  assert.deepEqual(validateState(both), both);
  await validateSyncValue('preferences', 'owntab.local.v1', { version: 1, state: both, snapshots: [] });
  const frozen = await readFile(new URL('../../tests/fixtures/compatibility/widget-model-0.5.1.js', import.meta.url), 'utf8');
  const source = frozen.replace(/from (['"])(\.[^'"]+)\1/gu, (_match, _quote, relative) => `from '${new URL(relative, new URL('./widget-model.js', import.meta.url)).href}'`);
  const legacy = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.doesNotThrow(() => legacy.validateWidgetConfig('notes', { size: 'small' }));
  assert.throws(() => legacy.validateWidgetConfig('notes', note.state.entries[0].config));
  assert.throws(() => legacy.validateWidgetConfig('saved-view', both.entries[1].config));
  assert.deepEqual(both.entries[0].config, { size: 'small', noteId: 'legacy-note-a' });
});
