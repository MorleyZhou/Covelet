import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryCenter } from './recovery-center.js';
import { createStorage } from './storage.js';
import { createEmptyState, deleteEntry } from './model.js';
import { prepareNavigationDeletion, restoreTrashItem } from './navigation-trash-core.js';
import { createConfiguredNavigation } from '../../tests/fixtures/navigation-state.mjs';
import { validatePersonalTools } from './personal-tools.js';
import { validateContentPreferences, prepareContentPreferencesRestore } from './content-preferences.js';
import { validateSavedDesktopTemplates, BUILTIN_DESKTOP_TEMPLATES } from './desktop-templates.js';
import { defaultSavedFilters, resolveSavedView } from './saved-views.js';
import { fromMarkdown } from '@futelab/folio/serialization';
import { captureNoteDocument } from './note-capture.js';
import { noteDocumentText } from './note-document.js';
import { localData } from './local-data.js';
import { encryptCompleteBackup, decryptCompleteBackup, isEncryptedBackup, PASSWORD_BACKUP_LIMITS } from './password-backup.js';

const clone = (value) => structuredClone(value);
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB0kAAAAASUVORK5CYII=', 'base64'));
const icon = (url, updatedAt = 1) => ({ url, blob: new Blob([PNG], { type: 'image/png' }), width: 1, height: 1, vector: false, adaptive: false, updatedAt });
const site = (id, url, iconUrl, order) => ({ id, url, iconUrl, order, type: 'site', name: id, groupId: 'group-home', parentId: null, page: 0, icon: { kind: 'letter', value: 'S' } });
const note = (body = 'before') => ({ id: 'note-a', revision: 1, createdAt: 1, updatedAt: 1, title: 'Private note', body, pinned: false });
function harness() {
  let envelope = null, point = null, rejectPoint = false, pointWrites = 0;
  let preferences;
  const icons = new Map(), assets = new Map(), hydrations = [], restoredImages = [], commits = [];
  const nav = createStorage({ initialState: createEmptyState, configStore: {
    read: async () => clone(envelope), write: async (value, records) => {
      const incoming = records?.['covelet.content.preferences.v1'];
      const staged = incoming ? preferences.prepare(incoming, { expectedRevision: incoming.revision - 1 }) : null;
      envelope = clone(value); if (staged) preferences.commitPrepared(staged);
      commits.push({ navigationRevision: value.state.revision, preferencesRevision: staged?.revision });
    }, subscribe: () => () => {},
  }, assetStore: { get: async (id) => clone(assets.get(id)), add: async (record) => assets.set(record.id, clone(record)), delete: async (id) => assets.delete(id) },
  syncStore: null, imageTools: { validate: async () => ({ width: 1, height: 1 }) },
  privacy: async (run) => run(await preferences.read(), (_keys, { replacePreferences, expectedRevision } = {}) => {
    if (!replacePreferences) throw Error('Expected paired recovery preferences.');
    return { 'covelet.content.preferences.v1': prepareContentPreferencesRestore(preferences.current(), replacePreferences, { expectedRevision }) };
  }),
  iconResources: { read: async (source) => icons.get(source) || null,
    restore: async (record) => { restoredImages.push(record.url); if (!icons.has(record.url)) icons.set(record.url, clone(record)); return icons.get(record.url); },
    prepare: async (state, options) => { hydrations.push(state.entries.map((entry) => entry.id)); const report = { total: state.entries.length, completed: state.entries.length, cached: state.entries.length, failed: 0, missing: [] };
      options.onIconProgress?.(report); return report; } } });
  const domain = (validate, initial) => {
    let data = validate(initial), fail = false, beforeWrite;
    function prepare(value, { expectedRevision }) {
      beforeWrite?.();
      if (data.revision !== expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' });
      if (fail) throw Error('quota');
      return validate({ ...clone(value), revision: data.revision + 1 });
    }
    return { validate, read: async () => clone(data),
      async write(value, { expectedRevision }) {
        data = prepare(value, { expectedRevision }); return clone(data);
      },
      prepare, commitPrepared(value) { data = clone(value); }, current: () => clone(data),
      change(value) { data = validate({ ...data, ...clone(value), revision: data.revision + 1 }); },
      failWrites(value = true) { fail = value; }, beforeWrite(action) { beforeWrite = action; },
    };
  };
  const tools = domain(validatePersonalTools, null), templates = domain(validateSavedDesktopTemplates, null);
  preferences = domain(validateContentPreferences, null);
  const points = { read: async () => clone(point), async write(value) { if (rejectPoint) throw Error('checkpoint quota'); pointWrites++; point = clone(value); } };
  const center = createRecoveryCenter({ nav, tools, preferences, templates, points, locks: { request: (_key, action) => action() } });
  return { center, nav, tools, preferences, templates, points, icons, assets, commits, hydrations, restoredImages, get pointWrites() { return pointWrites; }, failPoint() { rejectPoint = true; } };
}

function singleNavigation(id, url, { privateFolder = false } = {}) {
  const state = createEmptyState(), item = site(id, url, '', 0); delete item.iconUrl;
  state.settings.desktopPages = { 0: { id: 'source-desktop', name: 'Source' } };
  state.entries = privateFolder ? [{ id: 'private-folder', type: 'folder', name: 'Private', groupId: 'group-home', parentId: null,
    page: 0, order: 0, icon: { kind: 'letter', value: 'P' } }, { ...item, parentId: 'private-folder' }] : [item];
  return state;
}

test('password-encrypted full backup remains readonly until explicit restore and retains navigation trash, images, rich notes, dates, views and metadata', async () => {
  const source = harness(), target = harness(), navigation = singleNavigation('encrypted-site', 'https://encrypted.test/');
  navigation.entries[0].icon = { kind: 'image', value: 'shared-image' };
  navigation.trash = { version: 1, items: [{ id: 'encrypted-trash', kind: 'site', deletedAt: Date.now(), origin: { desktopId: 'source-desktop', page: 0, parentId: null }, ownedEntries: [{ ...navigation.entries[0], id: 'recycled-site', name: 'Recycled', url: 'https://recycled.test/' }], memberRefs: [] }] };
  source.assets.set('shared-image', { id: 'shared-image', blob: new Blob([PNG], { type: 'image/png' }) });
  await source.nav.saveState(navigation, 0);
  const document = JSON.parse(JSON.stringify(fromMarkdown('## Kept\n\n[Source](https://source.test/)')));
  source.tools.change({ notes: [{ ...note(), document, body: noteDocumentText(document) }], reading: [{ id: 'dated-reading', revision: 1, createdAt: 1, updatedAt: 2, title: 'Dated', url: 'https://reading.test/', status: 'archived', revisitOn: '2026-12-01' }] });
  source.preferences.change({ privateKeys: ['note:note-a'], aliases: { 'site:recycled-site': 'Trash alias' }, library: { version: 1, tags: [{ id: 'kept-tag', name: 'Kept tag' }], items: { 'site:recycled-site': { description: 'Owned metadata', tagIds: ['kept-tag'] }, 'note:note-a': { description: '', tagIds: ['kept-tag'] } }, views: [{ id: 'kept-view', revision: 1, name: 'Due', ...defaultSavedFilters(), type: 'reading', revisit: 'due', excludeTagIds: ['kept-tag'] }] } });
  source.templates.change({ templates: [{ id: 'kept-scheme', name: 'Mine', createdAt: 1, template: BUILTIN_DESKTOP_TEMPLATES[0] }] });
  const previousSource = clone({ tools: await source.tools.read(), preferences: await source.preferences.read(), templates: await source.templates.read(), state: await source.nav.loadState() }), sourceWrites = source.commits.length;
  const encrypted = await source.center.exportEncryptedBackup('Complete-backup-password'); assert.equal(await isEncryptedBackup(encrypted), true);
  assert.deepEqual({ tools: await source.tools.read(), preferences: await source.preferences.read(), templates: await source.templates.read(), state: await source.nav.loadState() }, previousSource);
  assert.equal(source.commits.length, sourceWrites); assert.equal(source.pointWrites, 0);
  const plain = await decryptCompleteBackup(encrypted, 'Complete-backup-password'), plan = await target.center.previewEncryptedBackup(encrypted, 'Complete-backup-password');
  assert.deepEqual(plan.summary, (await target.center.preview(plain)).summary); assert.equal(target.commits.length, 0); assert.equal(target.pointWrites, 0);
  await target.center.restore(plan);
  const restored = await target.nav.loadState(); assert.equal(restored.entries[0].icon.value, restored.trash.items[0].ownedEntries[0].icon.value);
  assert.equal(target.assets.size, 1); assert.equal((await target.tools.read()).notes[0].body, noteDocumentText(document));
  assert.equal((await target.tools.read()).reading[0].revisitOn, '2026-12-01'); assert.equal((await target.tools.read()).reading[0].status, 'archived');
  assert.equal((await target.preferences.read()).library.views[0].revisit, 'due'); assert.equal((await target.preferences.read()).library.items['site:recycled-site'].description, 'Owned metadata');
  assert.deepEqual((await target.preferences.read()).library.views[0].excludeTagIds, ['kept-tag']);
  assert.equal((await target.templates.read()).templates[0].id, 'kept-scheme'); assert.equal(target.pointWrites, 2);
});

test('password errors, corruption, oversized input, invalid decrypted domains and cancellation never write business data or recovery points', async () => {
  const source = harness(), target = harness(), password = 'Complete-backup-password';
  const encrypted = await source.center.exportEncryptedBackup(password), original = clone({ state: await target.nav.loadState(), tools: await target.tools.read(), preferences: await target.preferences.read(), templates: await target.templates.read() });
  const corrupted = new Uint8Array(await encrypted.arrayBuffer()); corrupted[corrupted.length - 1] ^= 1;
  await assert.rejects(target.center.previewEncryptedBackup(encrypted, 'wrong-password'), { code: 'BACKUP_DECRYPT_FAILED' });
  await assert.rejects(target.center.previewEncryptedBackup(new Blob([corrupted]), password), { code: 'BACKUP_DECRYPT_FAILED' });
  class Oversized extends Blob { get size() { return PASSWORD_BACKUP_LIMITS.plaintext + PASSWORD_BACKUP_LIMITS.overhead + 1; } }
  await assert.rejects(target.center.previewEncryptedBackup(new Oversized(), password), { code: 'INVALID_ENCRYPTED_BACKUP' });
  const json = JSON.parse(await (await source.center.exportCompleteBackup()).text());
  const invalidUTF8 = Buffer.from(JSON.stringify({ ...json, tools: { ...json.tools, notes: [note('UTF8_SENTINEL')] } }));
  invalidUTF8[invalidUTF8.indexOf('UTF8_SENTINEL')] = 0xff;
  const authenticatedInvalidUTF8 = await encryptCompleteBackup(new Blob([invalidUTF8]), password);
  await assert.rejects(target.center.previewEncryptedBackup(authenticatedInvalidUTF8, password), { code: 'INVALID_BACKUP', message: '备份文件无法读取。' });
  for (const invalid of ['not JSON', JSON.stringify({ ...json, tools: { ...json.tools, notes: [{ ...note(), body: null }] } }), JSON.stringify({ ...json, preferences: { ...json.preferences, library: { version: 1, tags: [], items: { 'site:missing': { description: '', tagIds: ['dangling-tag'] } } } } })]) {
    await assert.rejects(target.center.previewEncryptedBackup(await encryptCompleteBackup(new Blob([invalid]), password), password));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(target.center.exportEncryptedBackup(password, { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(target.center.previewEncryptedBackup(encrypted, password, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual({ state: await target.nav.loadState(), tools: await target.tools.read(), preferences: await target.preferences.read(), templates: await target.templates.read() }, original);
  assert.equal(target.commits.length, 0); assert.equal(target.pointWrites, 0); assert.equal(target.assets.size, 0); assert.equal(target.icons.size, 0);
});

test('default recovery reader captures and previews expired personal trash without pruning or advancing its revision', async (t) => {
  const subject = harness(), expired = validatePersonalTools({ version: 3, revision: 42, notes: [], reading: [], snapshots: [], trash: [{ id: 'expired-trash', kind: 'notes', deletedAt: Date.now() - 31 * 86400000, record: note('Expired persisted body') }] });
  let writes = 0;
  t.mock.method(localData, 'get', async (keys) => (Array.isArray(keys) ? keys : [keys]).includes('covelet.tools.v1') ? { 'covelet.tools.v1': clone(expired) } : {});
  t.mock.method(localData, 'set', async () => { writes++; throw Error('Unexpected backup write'); });
  const center = createRecoveryCenter({ nav: subject.nav, preferences: subject.preferences, templates: subject.templates, points: subject.points });
  const plain = await center.exportCompleteBackup(), encrypted = await center.exportEncryptedBackup('Readonly-backup-password');
  assert.deepEqual(JSON.parse(await plain.text()).tools, expired);
  assert.deepEqual((await center.preview(plain)).tools, expired);
  assert.deepEqual((await center.previewEncryptedBackup(encrypted, 'Readonly-backup-password')).tools, expired);
  assert.equal(writes, 0); assert.equal(subject.commits.length, 0); assert.equal(subject.pointWrites, 0);
});

test('navigation and preferences restore in one commit, and a failed paired preference write exposes neither', async () => {
  const source = harness(), target = harness();
  await source.nav.saveState(singleNavigation('incoming', 'https://incoming.test/'), 0);
  source.preferences.change({ privateKeys: ['site:incoming'], aliases: { 'site:incoming': 'source alias' } });
  await target.nav.saveState(singleNavigation('current', 'https://current.test/'), 0);
  const beforeState = await target.nav.loadState(), beforePreferences = await target.preferences.read(), beforeWrites = target.commits.length;
  const plan = await target.center.preview(await source.center.exportCompleteBackup());
  target.preferences.failWrites();
  await assert.rejects(target.center.restore(plan), /本次更改已撤销/);
  assert.deepEqual(await target.nav.loadState(), beforeState); assert.deepEqual(await target.preferences.read(), beforePreferences);
  assert.equal(target.commits.length, beforeWrites);
  target.preferences.failWrites(false);
  await target.center.restore(await target.center.preview(await source.center.exportCompleteBackup()));
  const writes = target.commits.slice(beforeWrites);
  assert.equal(writes.length, 1); assert.equal(writes[0].preferencesRevision, (await target.preferences.read()).revision);
  assert.deepEqual((await target.preferences.read()).privateKeys, ['site:incoming']);
});

test('navigation-only recovery carries imported private markings and preserves local inherited privacy', async () => {
  const source = harness(), target = harness();
  await source.nav.saveState(singleNavigation('kept-child', 'https://incoming.test/'), 0);
  source.preferences.change({ privateKeys: ['site:kept-child'] });
  await target.nav.saveState(singleNavigation('local-child', 'https://local.test/', { privateFolder: true }), 0);
  target.preferences.change({ privateKeys: ['folder:private-folder'], presentation: false, aliases: { 'note:keep': 'untouched' } });
  await target.center.restore(await target.center.preview(await source.center.exportCompleteBackup()), { selected: ['navigation'] });
  assert((await target.preferences.read()).privateKeys.includes('site:kept-child'));
  assert.equal((await target.preferences.read()).aliases['note:keep'], 'untouched');
  const oldPrivate = harness(), publicSameId = harness();
  await oldPrivate.nav.saveState(singleNavigation('same-child', 'https://same.test/', { privateFolder: true }), 0);
  oldPrivate.preferences.change({ privateKeys: ['folder:private-folder'], presentation: true });
  await publicSameId.nav.saveState(singleNavigation('same-child', 'https://same.test/'), 0);
  await oldPrivate.center.restore(await oldPrivate.center.preview(await publicSameId.center.exportCompleteBackup()));
  assert((await oldPrivate.preferences.read()).privateKeys.includes('site:same-child'));
  assert.equal((await oldPrivate.preferences.read()).presentation, true);
});

test('append remaps recycled identities and their orphan metadata without borrowing local same-ID content or images', async () => {
  const source = harness(), target = harness(), original = singleNavigation('same-site', 'https://recycled.test/');
  original.entries[0].icon = { kind: 'image', value: 'shared-image' };
  source.assets.set('shared-image', { id: 'shared-image', blob: new Blob([PNG], { type: 'image/png' }) });
  source.preferences.change({ privateKeys: ['site:same-site'], aliases: { 'site:same-site': 'recycled alias' }, library: {
    version: 1, tags: [{ id: 'source-tag', name: 'Work' }], items: { 'site:same-site': { description: 'recycled description', tagIds: ['source-tag'] } },
  } });
  const recycled = prepareNavigationDeletion(original, deleteEntry(original, 'same-site'), await source.preferences.read(), { makeId: () => 'source-event' }).state;
  await source.nav.saveState(recycled, 0);
  const current = singleNavigation('same-site', 'https://local.test/');
  current.entries[0].icon = { kind: 'image', value: 'shared-image' };
  const localBlob = new Blob([PNG, new Uint8Array([1])], { type: 'image/png' });
  target.assets.set('shared-image', { id: 'shared-image', blob: localBlob });
  await target.nav.saveState(current, 0);
  target.preferences.change({ aliases: { 'site:same-site': 'local alias' }, library: {
    version: 1, tags: [{ id: 'local-tag', name: 'work' }], items: { 'site:same-site': { description: 'local description', tagIds: ['local-tag'] } },
  } });
  await target.center.restore(await target.center.preview(await source.center.exportCompleteBackup()), { mode: 'append' });
  const saved = await target.nav.loadState(), preferences = await target.preferences.read(), owned = saved.trash.items[0].ownedEntries[0];
  assert.notEqual(owned.id, 'same-site'); assert.notEqual(owned.icon.value, 'shared-image');
  assert.equal(saved.entries[0].url, 'https://local.test/'); assert.equal(preferences.aliases['site:same-site'], 'local alias');
  assert.equal(preferences.aliases[`site:${owned.id}`], 'recycled alias');
  assert.deepEqual(preferences.library.items[`site:${owned.id}`], { description: 'recycled description', tagIds: ['local-tag'] });
  assert(preferences.privateKeys.includes(`site:${owned.id}`));
  assert.deepEqual(new Uint8Array(await target.assets.get('shared-image').blob.arrayBuffer()), new Uint8Array(await localBlob.arrayBuffer()));
  assert.deepEqual(new Uint8Array(await target.assets.get(owned.icon.value).blob.arrayBuffer()), PNG);
  const restored = restoreTrashItem(saved, preferences, saved.trash.items[0].id, { destinationValue: 'page-id:source-desktop' }).state;
  assert(restored.entries.some((entry) => entry.id === owned.id && entry.url === 'https://recycled.test/'));
});

test('append cannot attach source children or folder views to a skipped local same-ID folder', async () => {
  const source = harness(), target = harness(), original = singleNavigation('source-child', 'https://source-child.test/', { privateFolder: true });
  await source.nav.saveState(original, 0);
  source.preferences.change({ library: { version: 1, tags: [], items: {}, views: [
    { id: 'folder-view', revision: 1, name: 'Source folder', ...defaultSavedFilters(), scope: { kind: 'folder', folderId: 'private-folder' } },
  ] } });
  await target.nav.saveState(singleNavigation('local-child', 'https://local.test/', { privateFolder: true }), 0);
  await target.center.restore(await target.center.preview(await source.center.exportCompleteBackup()), { mode: 'append' });
  const state = await target.nav.loadState(), preferences = await target.preferences.read();
  assert.equal(state.entries.some((entry) => entry.id === 'source-child'), false);
  assert.notEqual(preferences.library.views[0].scope.folderId, 'private-folder');
  assert.equal(resolveSavedView(preferences.library.views[0], { navigation: state, preferences, tools: { notes: [], reading: [] } }).status, 'invalid');
});

test('incoming active IDs are remapped around local recycled owners, orphan metadata and absent member references', async () => {
  for (const collision of ['owned', 'orphan', 'member']) {
    const source = harness(), target = harness(), incoming = singleNavigation('shared', 'https://incoming.test/');
    source.preferences.change({ aliases: { 'site:shared': 'incoming alias' } });
    await source.nav.saveState(incoming, 0);
    if (collision === 'owned') {
      const original = singleNavigation('shared', 'https://recycled.test/');
      await target.nav.saveState(prepareNavigationDeletion(original, deleteEntry(original, 'shared'), await target.preferences.read(), { makeId: () => 'owned-event' }).state, 0);
    } else if (collision === 'orphan') target.preferences.change({ aliases: { 'site:shared': 'local orphan' } });
    else {
      const original = singleNavigation('shared', 'https://old-member.test/', { privateFolder: true });
      const dissolved = prepareNavigationDeletion(original, deleteEntry(original, 'private-folder'), await target.preferences.read(), { makeId: () => 'member-event' }).state;
      dissolved.entries = [];
      await target.nav.saveState(dissolved, 0);
    }
    await target.center.restore(await target.center.preview(await source.center.exportCompleteBackup()), { mode: 'append' });
    const state = await target.nav.loadState(), preferences = await target.preferences.read(), added = state.entries.find((entry) => entry.url === 'https://incoming.test/');
    assert(added); assert.notEqual(added.id, 'shared', collision);
    assert.equal(preferences.aliases[`site:${added.id}`], 'incoming alias');
    if (collision === 'orphan') assert.equal(preferences.aliases['site:shared'], 'local orphan');
    if (collision === 'owned') assert.equal(state.trash.items[0].ownedEntries[0].id, 'shared');
    if (collision === 'member') assert.equal(state.trash.items[0].memberRefs[0].id, 'shared');
  }
});

test('a concurrent first tool-write failure preserves imported metadata and marks the paired restore recoverable', async () => {
  const source = harness(), target = harness();
  await source.nav.saveState(singleNavigation('incoming', 'https://incoming.test/'), 0);
  source.tools.change({ notes: [note('incoming body')] });
  source.preferences.change({ aliases: { 'note:note-a': 'incoming metadata' } });
  await target.nav.saveState(singleNavigation('current', 'https://current.test/'), 0);
  target.tools.change({ notes: [note('before')] });
  target.preferences.change({ aliases: { 'note:note-a': 'before metadata' } });
  const plan = await target.center.preview(await source.center.exportCompleteBackup());
  target.tools.beforeWrite(() => target.tools.change({ notes: [note('concurrent body')] }));
  await assert.rejects(target.center.restore(plan), { code: 'RECOVERY_REQUIRED' });
  assert.equal((await target.tools.read()).notes[0].body, 'concurrent body');
  assert.equal((await target.preferences.read()).aliases['note:note-a'], 'incoming metadata');
  assert.equal((await target.nav.loadState()).entries[0].id, 'incoming');
  assert.equal((await target.center.getRecoveryPoint()).status, 'needs-recovery');
  assert.equal((await target.center.previewRecoveryPoint()).preferences.aliases['note:note-a'], 'before metadata');
});

test('an atomic first-pair CAS rejection preserves concurrent preferences and permits a fresh preview retry', async () => {
  const source = harness(), target = harness();
  await source.nav.saveState(singleNavigation('incoming', 'https://incoming.test/'), 0);
  await target.nav.saveState(singleNavigation('current', 'https://current.test/'), 0);
  const before = await target.nav.loadState(), writes = target.commits.length, file = await source.center.exportCompleteBackup();
  const plan = await target.center.preview(file);
  target.preferences.beforeWrite(() => target.preferences.change({ aliases: { 'note:concurrent': 'retain' } }));
  await assert.rejects(target.center.restore(plan), { code: 'REVISION_CONFLICT' });
  assert.equal(target.commits.length, writes); assert.deepEqual(await target.nav.loadState(), before);
  assert.equal((await target.preferences.read()).aliases['note:concurrent'], 'retain');
  assert.equal((await target.center.getRecoveryPoint()).status, 'rolled-back');
  target.preferences.beforeWrite(null);
  await target.center.restore(await target.center.preview(file));
  assert.equal((await target.nav.loadState()).entries[0].id, 'incoming');
});

test('append preserves missing desktop and tag view conditions even when the target has matching local IDs', async () => {
  for (const selected of [['navigation', 'preferences'], ['preferences']]) {
    const source = harness(), target = harness(), current = singleNavigation('local-site', 'https://local.test/');
    current.settings.desktopPages[0].id = 'missing-desktop';
    await target.nav.saveState(current, 0);
    target.preferences.change({ library: { version: 1, tags: [{ id: 'missing-tag', name: 'Local tag' }], items: {
      'site:local-site': { description: '', tagIds: ['missing-tag'] },
    } } });
    source.preferences.change({ library: { version: 1, tags: [], items: {}, views: [
      { id: 'desktop-view', revision: 1, name: 'Missing desktop', ...defaultSavedFilters(), scope: { kind: 'desktop', desktopId: 'missing-desktop' } },
      { id: 'tag-view', revision: 1, name: 'Missing tag', ...defaultSavedFilters(), tagIds: ['missing-tag'] },
      { id: 'same-tag-view', revision: 1, name: 'Same missing tag', ...defaultSavedFilters(), tagIds: ['missing-tag'] },
    ] } });
    await target.center.restore(await target.center.preview(await source.center.exportCompleteBackup()), { mode: 'append', selected });
    const preferences = await target.preferences.read(), navigation = await target.nav.loadState();
    for (const view of preferences.library.views) assert.equal(resolveSavedView(view, { navigation, preferences, tools: { notes: [], reading: [] } }).status, 'invalid');
    assert.equal(preferences.library.views[1].tagIds[0], preferences.library.views[2].tagIds[0]);
    assert.notEqual(preferences.library.views[0].scope.desktopId, 'missing-desktop');
    assert.notEqual(preferences.library.views[1].tagIds[0], 'missing-tag');
  }
});

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
  assert.equal((await subject.preferences.read()).presentation, true); // Paired recovery preserves this device's lock.
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

test('reading dates and revisit views survive complete append, replace and pre-restore copies', async () => {
  const source = harness(), target = harness();
  const dated = (id, revisitOn) => ({ id, revision: 1, createdAt: 1, updatedAt: 2, title: id, url: `https://example.test/${id}`, status: 'read', revisitOn });
  source.tools.change({ reading: [dated('reading-a', '2026-11-11'), dated('reading-b', '2026-12-01')], trash: [
    { id: 'trash-date', kind: 'reading', deletedAt: Date.now(), record: dated('reading-trash', '2026-11-12') },
  ] });
  source.preferences.change({ library: { version: 1, tags: [], items: {}, views: [
    { id: 'due-view', revision: 1, name: 'Revisit', ...defaultSavedFilters(), revisit: 'due' },
  ] } });
  target.tools.change({ reading: [dated('reading-a', '2040-01-01')] });
  const file = await source.center.exportCompleteBackup();
  await target.center.restore(await target.center.preview(file), { mode: 'append' });
  const appended = await target.tools.read();
  assert.equal(appended.reading[0].revisitOn, '2040-01-01'); assert.equal(appended.reading[1].revisitOn, '2026-12-01');
  assert.equal(appended.trash[0].record.revisitOn, '2026-11-12');
  assert.equal((await target.preferences.read()).library.views[0].revisit, 'due');
  await target.center.restore(await target.center.preview(file));
  assert.equal((await target.tools.read()).reading[0].revisitOn, '2026-11-11');
  assert.equal((await target.center.previewRecoveryPoint()).tools.reading[0].revisitOn, '2040-01-01');
});

test('existing complete backups preserve Markdown tasks and captured literal text with source links', async () => {
  const subject = harness();
  const markdown = JSON.parse(JSON.stringify(fromMarkdown('- [x] Finished\n- [ ] Next\n\n[Source](https://example.test/article?q=1#part)')));
  const captured = captureNoteDocument({ body: '<script>literal</script>\n**literal Markdown**', pageTitle: 'Actual page', sourceUrl: 'https://example.test/captured?q=1#part' });
  const richNotes = [markdown, captured].map((document, index) => ({ ...note(), id: `rich-${index}`, title: `Rich ${index}`, document, body: noteDocumentText(document) }));
  subject.tools.change({ notes: richNotes });
  const file = await subject.center.exportCompleteBackup();
  subject.tools.change({ notes: [note('Newer local body')] });
  await subject.center.restore(await subject.center.preview(file));
  assert.deepEqual((await subject.tools.read()).notes.map(({ revision, ...record }) => record), richNotes.map(({ revision, ...record }) => record));
  assert.equal((await subject.center.previewRecoveryPoint()).tools.notes[0].body, 'Newer local body');
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
