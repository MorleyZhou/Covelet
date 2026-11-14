import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { createEmptyState, letterIcon, validateState } from './model.js';
import { effectiveDesktopAppearance } from './desktop-appearance.js';
import { createDesktopTemplate, inspectDesktopTemplate, applyDesktopTemplate } from './desktop-templates.js';
import { createStorage } from './storage.js';
import { validateSyncValue } from './sync-data-rules.js';

const pageStyle = { background: { kind: 'color', value: '#123456' }, shade: 0, blur: 3 };
function styledState() {
  const state = createEmptyState(); state.settings.pages = [0, 2, 4];
  state.settings.desktopPages = { 0: { id: 'public-id', name: 'Personal work name', appearance: structuredClone(pageStyle) },
    2: { id: 'private-id', name: 'Private project name', appearance: { shade: 70 } },
    4: { id: 'empty-id', name: 'Empty desk name', appearance: { blur: 10 } } };
  state.entries = [
    { id: 'public-site', type: 'site', name: 'Public site', url: 'https://example.com/', groupId: 'group-home', parentId: null, page: 0, order: 0, icon: letterIcon('P') },
    { id: 'private-site', type: 'site', name: 'Private site', url: 'https://private.example/', groupId: 'group-home', parentId: null, page: 2, order: 1, icon: letterIcon('P') },
  ];
  return validateState(state);
}

test('relative styles are opt-in, follow public represented pages and contain no desktop identity/name', () => {
  const state = styledState(), before = structuredClone(state);
  const options = { name: 'Public template', publicSiteIds: ['public-site', 'private-site'], privateEntryIds: ['private-site'] };
  assert.equal(createDesktopTemplate(state, options).desktopAppearances, undefined);
  const shared = createDesktopTemplate(state, { ...options, includeDesktopAppearances: true });
  assert.deepEqual(shared.desktopAppearances, [{ page: 0, appearance: pageStyle }]);
  const text = JSON.stringify(shared);
  for (const hidden of ['public-id', 'private-id', 'empty-id', 'Personal work name', 'Private project name', 'Empty desk name', 'private.example']) assert(!text.includes(hidden));
  assert.deepEqual(state, before); assert.deepEqual(inspectDesktopTemplate(text), shared);
  assert.equal(createDesktopTemplate(state, { includeDesktopAppearances: true, privateEntryIds: ['public-site', 'private-site'] }).desktopAppearances, undefined);
});

test('appearance-only template application creates explicitly styled fresh logical pages and leaves existing overrides in place', () => {
  const template = createDesktopTemplate(styledState(), { publicSiteIds: ['public-site'], includeDesktopAppearances: true });
  const current = createEmptyState(); current.settings.desktopPages = { 0: { id: 'local-desk', appearance: { shade: 50 } } };
  const before = structuredClone(current), result = applyDesktopTemplate(current, template);
  assert.equal(result.addedDesktopAppearances, 1); assert.equal(result.addedSites, 0); assert.equal(result.addedWidgets, 0);
  assert.deepEqual(result.state.settings.pages, [0, 1]);
  assert.deepEqual(result.state.settings.desktopPages[0], current.settings.desktopPages[0]);
  assert.notEqual(result.state.settings.desktopPages[1].id, 'public-id');
  assert.notEqual(result.state.settings.desktopPages[1].id, 'local-desk');
  assert.equal(result.state.settings.desktopPages[1].name, undefined);
  assert.deepEqual(result.state.settings.desktopPages[1].appearance, pageStyle);
  assert.deepEqual(current, before);
  const ignored = applyDesktopTemplate(current, template, { appearance: false });
  assert.equal(ignored.addedDesktopAppearances, 0); assert.deepEqual(ignored.state, current);
  const withSites = applyDesktopTemplate(current, template, { sites: true });
  assert.equal(withSites.state.entries[0].page, 1); assert.deepEqual(withSites.state.settings.desktopPages[1].appearance, pageStyle);
});

test('template style input rejects identity, unknown settings, duplicate pages, image assets and unsafe CSS', () => {
  const template = createDesktopTemplate(styledState(), { publicSiteIds: ['public-site'], includeDesktopAppearances: true });
  for (const item of [
    { page: 0, appearance: {}, id: 'local-desk' }, { page: 0, appearance: { theme: 'dark' } },
    { page: 0, appearance: { background: { kind: 'image', value: 'asset' } } },
    { page: 0, appearance: { background: { kind: 'gradient', value: 'linear-gradient(#fff,#000),url(https://tracker.example/)' } } },
    { page: -1, appearance: { shade: 10 } }, { page: 0, appearance: {} },
  ]) assert.throws(() => inspectDesktopTemplate({ ...template, desktopAppearances: [item] }));
  assert.throws(() => inspectDesktopTemplate({ ...template, desktopAppearances: [template.desktopAppearances[0], template.desktopAppearances[0]] }));
});

function navigationStore(initial = createEmptyState()) {
  let envelope = { version: 1, state: structuredClone(initial), snapshots: [] }, writes = 0;
  const store = createStorage({ configStore: { read: async () => structuredClone(envelope),
    async write(value) { envelope = structuredClone(value); writes++; }, subscribe: () => () => {} },
    assetStore: { get: async () => null, add: async () => { throw Error('no wallpaper asset expected'); }, delete: async () => {} },
    iconResources: { read: async () => null, restore: async () => { throw Error('no icon expected'); }, prepare: async () => ({ total: 0, completed: 0, cached: 0, failed: 0, missing: [] }) },
  });
  return { store, current: () => structuredClone(envelope), writes: () => writes };
}

test('navigation ZIP and rollback snapshots retain partial inheritance without wallpaper assets or network', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('network forbidden'); });
  const original = styledState(), source = navigationStore(original), target = navigationStore();
  const archive = await source.store.exportBackup(original), files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ['data.json', 'manifest.json']);
  const saved = await target.store.restoreBackup(await target.store.inspectBackup(archive), 0, { hydrateIcons: false });
  assert.deepEqual(saved.settings.desktopPages, original.settings.desktopPages);
  const changed = structuredClone(saved); changed.settings.desktopPages[0].appearance.blur = 20;
  const second = await target.store.saveState(changed, saved.revision);
  const restored = await target.store.restoreSnapshot(second.revision, { hydrateIcons: false });
  assert.deepEqual(restored.settings.desktopPages, original.settings.desktopPages);
  assert.equal(effectiveDesktopAppearance(restored.settings, 2).blur, restored.settings.blur);
  assert.equal(source.writes(), 0);
});

test('corrupt per-page image or CSS values fail ZIP and sync validation before any navigation publication', async () => {
  const source = navigationStore(styledState()), archive = await source.store.exportBackup(styledState());
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  const state = JSON.parse(new TextDecoder().decode(files['data.json']));
  state.settings.desktopPages[0].appearance.background = { kind: 'image', value: 'missing-image' };
  files['data.json'] = strToU8(JSON.stringify(state));
  const corrupt = new Blob([zipSync(files)]), target = navigationStore(), before = target.current();
  await assert.rejects(target.store.inspectBackup(corrupt));
  await assert.rejects(validateSyncValue('preferences', 'owntab.local.v1', { version: 1, state, snapshots: [] }));
  await assert.rejects(validateSyncValue('preferences', 'owntab.local.v1', { version: 1, state: styledState(), snapshots: [state] }));
  assert.deepEqual(target.current(), before); assert.equal(target.writes(), 0);
  await validateSyncValue('preferences', 'owntab.local.v1', { version: 1, state: styledState(), snapshots: [styledState()] });
});

test('published 0.5.1 refuses new desktop metadata rather than silently dropping appearance during validation', async () => {
  const frozen = await readFile(new URL('../../tests/fixtures/compatibility/model-0.5.1.js', import.meta.url), 'utf8');
  const source = frozen.replace(/from (['"])(\.[^'"]+)\1/gu, (_match, _quote, relative) => `from '${new URL(relative, new URL('./model.js', import.meta.url)).href}'`);
  const legacy = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.doesNotThrow(() => legacy.validateState(createEmptyState()));
  const current = styledState(), before = structuredClone(current);
  assert.throws(() => legacy.validateState(current)); assert.deepEqual(current, before);
  assert.deepEqual(validateState(current), current);
});
