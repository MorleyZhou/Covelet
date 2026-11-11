import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryCenter } from './recovery-center.js';
import { createStorage } from './storage.js';
import { createEmptyState } from './model.js';
import { createConfiguredNavigation } from '../../tests/fixtures/navigation-state.mjs';
import { validatePersonalTools } from './personal-tools.js';
import { validateContentPreferences } from './content-preferences.js';
import { validateSavedDesktopTemplates, BUILTIN_DESKTOP_TEMPLATES } from './desktop-templates.js';
import { defaultSavedFilters, resolveSavedView } from './saved-views.js';

const clone = (value) => structuredClone(value);
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB0kAAAAASUVORK5CYII=', 'base64'));
const icon = (url, updatedAt = 1) => ({ url, blob: new Blob([PNG], { type: 'image/png' }), width: 1, height: 1, vector: false, adaptive: false, updatedAt });
const site = (id, url, iconUrl, order) => ({ id, url, iconUrl, order, type: 'site', name: id, groupId: 'group-home', parentId: null, page: 0, icon: { kind: 'letter', value: 'S' } });
const note = (body = 'before') => ({ id: 'note-a', revision: 1, createdAt: 1, updatedAt: 1, title: 'Private note', body, pinned: false });
function harness() {
  let envelope = null, point = null, rejectPoint = false, pointWrites = 0;
  const icons = new Map(), hydrations = [], restoredImages = [];
  const nav = createStorage({ initialState: createEmptyState, configStore: {
    read: async () => clone(envelope), write: async (value) => { envelope = clone(value); }, subscribe: () => () => {},
  }, assetStore: { get: async () => null }, syncStore: null, imageTools: { validate: async () => ({ width: 1, height: 1 }) },
  iconResources: { read: async (source) => icons.get(source) || null,
    restore: async (record) => { restoredImages.push(record.url); if (!icons.has(record.url)) icons.set(record.url, clone(record)); return icons.get(record.url); },
    prepare: async (state, options) => { hydrations.push(state.entries.map((entry) => entry.id)); const report = { total: state.entries.length, completed: state.entries.length, cached: state.entries.length, failed: 0, missing: [] };
      options.onIconProgress?.(report); return report; } } });
  const domain = (validate, initial) => {
    let data = validate(initial), fail = false, beforeWrite;
    return { validate, read: async () => clone(data),
      async write(value, { expectedRevision }) {
        beforeWrite?.();
        if (data.revision !== expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' });
        if (fail) throw Error('quota');
        data = validate({ ...clone(value), revision: data.revision + 1 }); return clone(data);
      },
      change(value) { data = validate({ ...data, ...clone(value), revision: data.revision + 1 }); },
      failWrites(value = true) { fail = value; }, beforeWrite(action) { beforeWrite = action; },
    };
  };
  const tools = domain(validatePersonalTools, null), preferences = domain(validateContentPreferences, null), templates = domain(validateSavedDesktopTemplates, null);
  const points = { read: async () => clone(point), async write(value) { if (rejectPoint) throw Error('checkpoint quota'); pointWrites++; point = clone(value); } };
  const center = createRecoveryCenter({ nav, tools, preferences, templates, points, locks: { request: (_key, action) => action() } });
  return { center, nav, tools, preferences, templates, points, icons, hydrations, restoredImages, get pointWrites() { return pointWrites; }, failPoint() { rejectPoint = true; } };
}

test('complete backup round trip includes rich tools, schemes, privacy and a pre-restore recovery point', async () => {
  const subject = harness();
  const state = await subject.nav.saveState(createConfiguredNavigation(), 0);
  subject.tools.change({ notes: [note()], reading: [{ id: 'read-a', revision: 1, createdAt: 1, updatedAt: 1, title: 'Read', url: 'https://example.com/?a=1#part', status: 'read' }] });
  subject.templates.change({ templates: [{ id: 'scheme-a', name: 'mine', createdAt: 1, template: BUILTIN_DESKTOP_TEMPLATES[0] }] });
  subject.preferences.change({ aliases: { 'note:note-a': 'alias' }, privateKeys: ['note:note-a'], presentation: true });
  const file = await subject.center.exportCompleteBackup(), json = JSON.parse(await file.text());
  assert.equal(json.preferences.presentation, false);
  assert(!('credentials' in json)); assert(!('target' in json));
  subject.tools.change({ notes: [note('changed')] });
  subject.preferences.change({ privateKeys: [] });
  const plan = await subject.center.preview(file);
  assert.equal(plan.summary.navigation, 6); assert.equal(plan.summary.templates, 1);
  await subject.center.restore(plan);
  assert.equal((await subject.tools.read()).notes[0].body, 'before');
  assert.deepEqual((await subject.preferences.read()).privateKeys, ['note:note-a']);
  assert.equal((await subject.preferences.read()).presentation, false); // Stub writes full values; production preserves the switch.
  assert.equal((await subject.nav.loadState()).entries.length, state.entries.length);
  const recovery = await subject.center.previewRecoveryPoint();
  assert.equal(recovery.tools.notes[0].body, 'changed');
  assert.equal((await subject.center.getRecoveryPoint()).status, 'complete');
});

test('complete backups and recovery points retain metadata while append remaps incoming tag identities', async () => {
  const subject = harness(), oldLibrary = { version: 1, tags: [{ id: 'tag-a', name: 'Work' }], items: { 'site:saved': { description: 'old description', tagIds: ['tag-a'] } } };
  subject.preferences.change({ library: oldLibrary });
  const file = await subject.center.exportCompleteBackup();
  assert.deepEqual(JSON.parse(await file.text()).preferences.library, oldLibrary);
  const edited = { version: 1, tags: [{ id: 'tag-current', name: 'work' }], items: { 'site:saved': { description: 'new description', tagIds: ['tag-current'] } } };
  subject.preferences.change({ library: edited });
  await subject.center.restore(await subject.center.preview(file));
  assert.deepEqual((await subject.preferences.read()).library, oldLibrary);
  assert.deepEqual((await subject.center.previewRecoveryPoint()).preferences.library, edited);
  subject.preferences.change({ library: edited });
  const incoming = harness();
  incoming.preferences.change({ library: { ...oldLibrary, items: { 'reading:fresh': { description: 'new reference', tagIds: ['tag-a'] } } } });
  await subject.center.restore(await subject.center.preview(await incoming.center.exportCompleteBackup()), { selected: ['preferences'], mode: 'append' });
  const merged = (await subject.preferences.read()).library;
  assert.deepEqual(merged.tags, edited.tags); assert.deepEqual(merged.items['site:saved'], edited.items['site:saved']);
  assert.deepEqual(merged.items['reading:fresh'], { description: 'new reference', tagIds: ['tag-current'] });
});

test('complete restore retains saved views and append maps imported desktop identities instead of pointing at the existing desktop', async () => {
  const source = harness(), target = harness(), original = createEmptyState(), current = createEmptyState();
  original.settings.desktopPages = { 0: { id: 'shared-desktop', name: 'Imported desktop' } };
  original.entries = [site('incoming-site', 'https://incoming.example/', '', 0)];
  current.settings.desktopPages = { 0: { id: 'shared-desktop', name: 'Current desktop' } };
  current.entries = [site('current-site', 'https://current.example/', '', 0)];
  delete original.entries[0].iconUrl; delete current.entries[0].iconUrl;
  await source.nav.saveState(original, 0); await target.nav.saveState(current, 0);
  source.preferences.change({ privateKeys: ['view:incoming-view'], library: { version: 1, tags: [], items: {}, views: [
    { id: 'incoming-view', revision: 1, name: 'Incoming', ...defaultSavedFilters(), scope: { kind: 'desktop', desktopId: 'shared-desktop' } },
  ] } });
  target.preferences.change({ library: { version: 1, tags: [], items: {}, views: [
    { id: 'current-view', revision: 2, name: 'Current', ...defaultSavedFilters(), scope: { kind: 'desktop', desktopId: 'shared-desktop' } },
  ] } });
  const file = await source.center.exportCompleteBackup();
  await target.center.restore(await target.center.preview(file), { mode: 'append' });
  const restored = await target.preferences.read(), state = await target.nav.loadState();
  const imported = restored.library.views.find((view) => view.id === 'incoming-view');
  assert.notEqual(imported.scope.desktopId, 'shared-desktop');
  const importedPage = state.entries.find((entry) => entry.id === 'incoming-site').page;
  assert.equal(state.settings.desktopPages[importedPage].id, imported.scope.desktopId);
  assert.equal(restored.library.views.find((view) => view.id === 'current-view').scope.desktopId, 'shared-desktop');
  assert(restored.privateKeys.includes('view:incoming-view'));
  const point = await target.center.previewRecoveryPoint();
  assert.equal(point.preferences.library.views[0].id, 'current-view');
  await target.center.restore(await target.center.preview(file));
  assert.deepEqual((await target.preferences.read()).library.views, (await source.preferences.read()).library.views);
});

test('append keeps a view invalid when deduplication omits its colliding source desktop', async () => {
  const source = harness(), target = harness();
  for (const [subject, id] of [[source, 'incoming-site'], [target, 'local-site']]) {
    const state = createEmptyState();
    state.settings.desktopPages = { 0: { id: 'shared-desktop', name: id } };
    state.entries = [site(id, 'https://duplicate.example/', undefined, 0)]; delete state.entries[0].iconUrl;
    await subject.nav.saveState(state, 0);
  }
  source.preferences.change({ library: { version: 1, tags: [], items: {}, views: [
    { id: 'incoming-view', revision: 1, name: 'Source desktop only', ...defaultSavedFilters(), scope: { kind: 'desktop', desktopId: 'shared-desktop' } },
  ] } });
  await target.center.restore(await target.center.preview(await source.center.exportCompleteBackup()), { mode: 'append' });
  const preferences = await target.preferences.read(), navigation = await target.nav.loadState(), view = preferences.library.views[0];
  assert.notEqual(view.scope.desktopId, 'shared-desktop');
  assert.deepEqual(navigation.entries.map((entry) => entry.id), ['local-site']);
  assert.deepEqual(resolveSavedView(view, { navigation, tools: await target.tools.read(), preferences }), { status: 'invalid', reason: 'missing-desktop', rows: [] });
});

test('selected categories replace same-ID note contents without touching reading, navigation or aliases', async () => {
  const subject = harness(); subject.tools.change({ notes: [note()] });
  const file = await subject.center.exportCompleteBackup();
  subject.tools.change({ notes: [note('changed')] }); subject.preferences.change({ aliases: { 'note:note-a': 'new alias' } });
  const before = await subject.nav.loadState(), plan = await subject.center.preview(file);
  await subject.center.restore(plan, { selected: ['notes'], mode: 'replace' });
  assert.equal((await subject.tools.read()).notes[0].body, 'before');
  assert.deepEqual(await subject.nav.loadState(), before);
  assert.equal((await subject.preferences.read()).aliases['note:note-a'], 'new alias');
});

test('append keeps current same-ID content, URL deduplication and existing navigation positions', async () => {
  const source = harness(), target = harness();
  await source.nav.saveState(createConfiguredNavigation(), 0); source.tools.change({ notes: [note()] });
  const file = await source.center.exportCompleteBackup();
  const existing = createConfiguredNavigation(); existing.entries = existing.entries.slice(0, 1); existing.entries[0].position = { row: 2, column: 2 };
  await target.nav.saveState(existing, 0); target.tools.change({ notes: [note('keep local')] });
  const plan = await target.center.preview(file);
  await target.center.restore(plan, { selected: ['navigation', 'notes'], mode: 'append' });
  const state = await target.nav.loadState();
  assert.equal(state.entries.length, 6); assert.deepEqual(state.entries[0].position, { row: 2, column: 2 });
  assert.equal(state.settings.pages.length, 2);
  assert.equal((await target.tools.read()).notes[0].body, 'keep local');
});

test('append restores only actually added navigation artwork, preserving local images with the same URL', async () => {
  const source = harness(), target = harness(), incoming = createEmptyState(), existing = createEmptyState();
  const shared = 'https://cdn.test/shared.png', local = 'https://cdn.test/local.png', fresh = 'https://cdn.test/fresh.png';
  existing.entries = [site('same-id', 'https://local.test/', local, 0), site('same-url', 'https://duplicate.test/', shared, 1)];
  incoming.entries = [site('same-id', 'https://ignored-id.test/', 'https://cdn.test/ignored-id.png', 0),
    site('ignored-url', 'https://duplicate.test/', 'https://cdn.test/ignored-url.png', 1),
    site('fresh', 'https://fresh.test/', fresh, 2), site('fresh-shared', 'https://fresh-shared.test/', shared, 3)];
  for (const entry of incoming.entries) source.icons.set(entry.iconUrl, icon(entry.iconUrl, 20));
  target.icons.set(local, icon(local, 2)); target.icons.set(shared, icon(shared, 3));
  await source.nav.saveState(incoming, 0); await target.nav.saveState(existing, 0);
  const plan = await target.center.preview(await source.center.exportCompleteBackup());
  let progress = 0, reported = null;
  const result = await target.center.restore(plan, { selected: ['navigation'], mode: 'append', onIconProgress: () => progress++, onIconResult: (report) => { reported = report; } });
  assert.deepEqual((await target.nav.loadState()).entries.map((entry) => entry.id), ['same-id', 'same-url', 'fresh', 'fresh-shared']);
  assert.deepEqual([...target.icons.keys()].sort(), [local, shared, fresh].sort());
  assert.equal(target.icons.get(shared).updatedAt, 3, 'an incoming cache collision does not replace the usable local picture');
  assert.deepEqual(target.hydrations, [['fresh', 'fresh-shared']], 'pre-existing missing artwork is not fetched by an append');
  assert.equal(progress, 1); assert.deepEqual(result.iconReport, reported); assert.equal(result.iconReport.total, 2);
  assert(!target.restoredImages.includes('https://cdn.test/ignored-id.png'));
  assert(!target.restoredImages.includes('https://cdn.test/ignored-url.png'));
});

test('restoring tools only never persists or hydrates navigation icons from an unselected category', async () => {
  const source = harness(), target = harness(), state = createEmptyState(), url = 'https://cdn.test/private.png';
  state.entries = [site('private-source', 'https://private.test/', url, 0)]; source.icons.set(url, icon(url));
  await source.nav.saveState(state, 0); source.tools.change({ notes: [note('restored')] });
  const result = await target.center.restore(await target.center.preview(await source.center.exportCompleteBackup()), { selected: ['notes'] });
  assert.equal(result.iconReport, null); assert.equal(target.icons.size, 0); assert.equal(target.hydrations.length, 0);
  assert.equal((await target.tools.read()).notes[0].body, 'restored');
});

test('old navigation ZIP and v2 tools JSON are previewed through the same recovery center', async () => {
  const subject = harness();
  const zip = await subject.nav.exportBackup(createConfiguredNavigation());
  const navigation = await subject.center.preview(zip);
  assert.deepEqual(navigation.categories, ['navigation']);
  const tools = await subject.center.preview(new Blob([JSON.stringify({ format: 'covelet-personal-tools', version: 2, data: { version: 2, revision: 0, notes: [note()], reading: [], snapshots: [] } })]));
  assert.equal(tools.tools.version, 3); assert.equal(tools.summary.notes, 1);
});

test('v4 tools recovery replaces selected tool metadata while preserving unrelated navigation and reading preferences', async () => {
  const subject = harness(); subject.tools.change({ notes: [note('current note')] });
  subject.preferences.change({ aliases: { 'site:kept': 'navigation alias' }, library: { version: 1, tags: [{ id: 'tag-local', name: 'Work' }], items: {
    'site:kept': { description: 'navigation description', tagIds: ['tag-local'] }, 'note:note-a': { description: '', tagIds: [] },
    'reading:kept': { description: 'reading description', tagIds: ['tag-local'] },
  } } });
  const data = validatePersonalTools({ version: 3, revision: 0, notes: [note('old note')], reading: [], snapshots: [], trash: [] });
  const file = new Blob([JSON.stringify({ format: 'covelet-personal-tools', version: 4, data, preferences: {
    version: 1, revision: 0, aliases: { 'note:note-a': 'restored note alias' }, privateKeys: ['note:note-a'], presentation: false,
    library: { version: 1, tags: [{ id: 'tag-incoming', name: 'work' }], items: { 'note:note-a': { description: '', tagIds: ['tag-incoming'] } } },
  } })]);
  const plan = await subject.center.preview(file);
  assert(plan.categories.includes('preferences'));
  await subject.center.restore(plan, { selected: ['notes', 'preferences'], mode: 'replace' });
  const restored = await subject.preferences.read();
  assert.equal((await subject.tools.read()).notes[0].body, 'old note');
  assert.equal(restored.aliases['site:kept'], 'navigation alias'); assert.equal(restored.aliases['note:note-a'], 'restored note alias');
  assert.equal(restored.library.items['site:kept'].description, 'navigation description');
  assert.equal(restored.library.items['reading:kept'].description, 'reading description');
  assert.deepEqual(restored.library.items['note:note-a'].tagIds, ['tag-local']);
});

test('stale preview and invalid data never write a checkpoint or alter local contents', async () => {
  const subject = harness(), file = await subject.center.exportCompleteBackup(), plan = await subject.center.preview(file);
  subject.tools.change({ notes: [note('new')] });
  await assert.rejects(subject.center.restore(plan), { code: 'REVISION_CONFLICT' });
  assert.equal(subject.pointWrites, 0);
  const invalid = JSON.parse(await file.text()); invalid.credentials = { secret: 'must not import' };
  await assert.rejects(subject.center.preview(new Blob([JSON.stringify(invalid)])), /格式|version/i);
  assert.equal(subject.pointWrites, 0); assert.equal((await subject.tools.read()).notes[0].body, 'new');
  const missing = JSON.parse(await file.text()); delete missing.tools;
  await assert.rejects(subject.center.preview(new Blob([JSON.stringify(missing)])), /格式/);
  missing.tools = null;
  await assert.rejects(subject.center.preview(new Blob([JSON.stringify(missing)])), /格式/);
});

test('append renumbers independent root and folder order without moving existing seats', async () => {
  const source = harness(), target = harness();
  const initial = createEmptyState();
  initial.entries.push({ id: 'local', type: 'site', name: 'local', url: 'https://local.test/', groupId: 'group-home', parentId: null, icon: { kind: 'letter', value: 'L' }, order: 0, page: 0, position: { row: 4, column: 4 } });
  await target.nav.saveState(initial, 0);
  await source.nav.saveState(createConfiguredNavigation(), 0);
  const plan = await target.center.preview(await source.center.exportCompleteBackup());
  await target.center.restore(plan, { selected: ['navigation'], mode: 'append' });
  const state = await target.nav.loadState();
  assert.deepEqual(state.entries.map((item) => item.order), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(state.entries[0].position, { row: 4, column: 4 });
});

test('checkpoint quota failure stops all domain writes', async () => {
  const subject = harness(), file = await subject.center.exportCompleteBackup();
  subject.tools.change({ notes: [note('retain')] }); const before = await subject.nav.loadState();
  const plan = await subject.center.preview(file); subject.failPoint();
  await assert.rejects(subject.center.restore(plan), /checkpoint quota/);
  assert.deepEqual(await subject.nav.loadState(), before); assert.equal((await subject.tools.read()).notes[0].body, 'retain');
});

test('late domain failure rolls back already written domains, preserving the recovery point', async () => {
  const subject = harness(), file = await subject.center.exportCompleteBackup();
  await subject.nav.saveState(createConfiguredNavigation(), 0); const before = await subject.nav.loadState();
  const plan = await subject.center.preview(file); subject.tools.failWrites();
  await assert.rejects(subject.center.restore(plan), /本次更改已撤销/);
  assert.deepEqual((await subject.nav.loadState()).entries, before.entries);
  assert.equal(subject.hydrations.length, 1, 'automatic rollback does not start a second image acquisition');
  assert.equal((await subject.center.getRecoveryPoint()).status, 'rolled-back');
});

test('rollback refuses to overwrite concurrent edits and marks a recoverable partial restore', async () => {
  const subject = harness(), file = await subject.center.exportCompleteBackup();
  subject.tools.change({ notes: [note('before')] });
  const plan = await subject.center.preview(file);
  subject.templates.beforeWrite(() => { subject.tools.change({ notes: [note('concurrent')] }); }); subject.templates.failWrites();
  await assert.rejects(subject.center.restore(plan, { selected: ['tools', 'notes', 'templates'].filter((kind) => kind !== 'tools') }), { code: 'RECOVERY_REQUIRED' });
  assert.equal((await subject.tools.read()).notes[0].body, 'concurrent');
  assert.equal((await subject.center.getRecoveryPoint()).status, 'needs-recovery');
  assert.equal((await subject.center.previewRecoveryPoint()).tools.notes[0].body, 'before');
});

test('retrying a recovery point retains its original bytes across another failed recovery', async () => {
  const subject = harness(), file = await subject.center.exportCompleteBackup();
  subject.tools.change({ notes: [note('irreplaceable')] });
  await subject.center.restore(await subject.center.preview(file), { selected: ['notes'] });
  const original = await subject.center.getRecoveryPoint(), rescue = await subject.center.previewRecoveryPoint(original.id);
  subject.tools.failWrites();
  await assert.rejects(subject.center.restore(rescue, { selected: ['notes'] }));
  const after = await subject.center.getRecoveryPoint();
  assert.equal(after.previous.id, original.id);
  assert.equal((await subject.center.previewRecoveryPoint(original.id)).tools.notes[0].body, 'irreplaceable');
  assert.equal(JSON.parse(await (await subject.center.exportRecoveryPoint(original.id)).text()).tools.notes[0].body, 'irreplaceable');
});

test('an unresolved recovery point cannot be replaced by a new ordinary import', async () => {
  const subject = harness(), file = await subject.center.exportCompleteBackup();
  await subject.points.write({ version: 1, id: 'unresolved', status: 'needs-recovery', createdAt: new Date().toISOString(), data: JSON.parse(await file.text()) });
  const count = subject.pointWrites;
  await assert.rejects(subject.center.restore(await subject.center.preview(file)), /未完成/);
  assert.equal(subject.pointWrites, count);
});


test('A+ recovery excludes legacy snapshots and preserves existing historical collections', async () => {
  const subject = harness(), other = harness();
  const record = { id: 'legacy-tabs', title: 'legacy', revision: 1, createdAt: 1, updatedAt: 1, tabs: [{ url: 'https://example.com/', title: 'Example', pinned: false }] };
  const item = { id: 'legacy-trash', kind: 'snapshots', record, deletedAt: Date.now() };
  subject.tools.change({ snapshots: [record], trash: [item] });
  other.tools.change({ notes: [note('incoming')], snapshots: [{ ...record, id: 'other-tabs' }], trash: [{ ...item, id: 'other-trash' }] });
  const plan = await subject.center.preview(await other.center.exportCompleteBackup());
  assert.equal(plan.categories.includes('snapshots'), false); assert.equal(plan.summary.trash, 0);
  await assert.rejects(subject.center.restore({ ...plan, categories: [...plan.categories, 'snapshots'] }, { selected: ['snapshots'] }));
  assert.equal(subject.pointWrites, 0);
  await subject.center.restore(plan, { selected: ['notes', 'trash'], mode: 'replace' });
  const saved = await subject.tools.read();
  assert.deepEqual(saved.snapshots, [record]); assert.deepEqual(saved.trash, [item]); assert.equal(saved.notes[0].body, 'incoming');
});
