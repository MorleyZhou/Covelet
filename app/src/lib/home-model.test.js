import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, createInitialState, validateState, migrateNavigationState, retirePristineInitialSites, letterIcon } from './model.js';
import { BUNDLED_EXTENSIONS, EXTENSION_CATEGORIES, extensionsForCatalog } from './extensions.js';
import { isRetiredClockWidget, validateWidgetConfig } from './widget-model.js';
import { BUILTIN_DESKTOP_TEMPLATES, inspectDesktopTemplate, createDesktopTemplate, applyDesktopTemplate, validateSavedDesktopTemplates } from './desktop-templates.js';
import { createReplica, recordChanges, packReplica, readReplicas, materializeState } from './sync.js';
import { createConfiguredNavigation, createLegacySeedNavigation } from '../../tests/fixtures/navigation-state.mjs';

const legacyClock = () => ({ id: 'old-clock', type: 'widget', name: 'Travel clock', extensionId: 'clock',
  config: { size: 'small', style: 'digital', zones: ['Asia/Shanghai', 'Europe/London'], timeZone: 'local' },
  groupId: 'group-home', parentId: null, page: 2, position: { row: 1, column: 3 }, icon: letterIcon('Travel clock'), order: 6 });

test('new installations are empty, minimal mode survives validation/migration, and explicit clock visibility is retained', () => {
  const fresh = createInitialState();
  assert.deepEqual(fresh, createEmptyState());
  assert.equal(fresh.entries.length, 0);
  assert.equal(fresh.settings.showClock, true);
  for (const minimal of [true, false]) for (const showClock of [true, false]) {
    const saved = { ...fresh, settings: { ...fresh.settings, minimal, showClock } };
    assert.deepEqual(migrateNavigationState(JSON.parse(JSON.stringify(validateState(saved)))), saved);
  }
  const missingClock = createEmptyState(); delete missingClock.settings.showClock;
  assert.equal(migrateNavigationState(missingClock).settings.showClock, true);
  assert.equal(createInitialState().settings.minimal, false, 'new factories must not share caller mutations');
});

test('only exact untouched historical installation entries are retired; edits, placement and external metadata protect sites', () => {
  const old = createLegacySeedNavigation(), before = structuredClone(old);
  assert.equal(retirePristineInitialSites(old).entries.length, 0);
  assert.deepEqual(old, before);
  for (const change of [
    entry => { entry.id = 'my-own-google'; },
    entry => { entry.name = 'My Google'; },
    entry => { entry.url = 'https://www.google.com/search?q=mine'; },
    entry => { entry.icon = { kind: 'image', value: 'my-upload' }; },
    entry => { entry.iconUrl += '?custom=1'; },
    entry => { entry.iconFit = 'cover'; },
    entry => { entry.iconBackground = '#123456'; },
    entry => { entry.position = { row: 0, column: 0 }; },
    entry => { entry.page = 2; },
  ]) {
    const input = structuredClone(old); change(input.entries[0]);
    const result = retirePristineInitialSites(input);
    assert.equal(result.entries.length, 1);
    assert.deepEqual(result.entries[0], input.entries[0], 'a customized site must be kept, including its metadata and position');
  }
  const moved = structuredClone(old); [moved.entries[0].order, moved.entries[1].order] = [1, 0];
  assert.deepEqual(retirePristineInitialSites(moved).entries.map(entry => entry.id).sort(), ['default-google', 'default-youtube']);
  const protectedSites = retirePristineInitialSites(old, { protectedIds: ['default-google', 'default-github'] });
  assert.deepEqual(protectedSites.entries.map(entry => entry.id), ['default-google', 'default-github']);
  assert.deepEqual(retirePristineInitialSites(createConfiguredNavigation()).entries, createConfiguredNavigation().entries);
});

test('retired clocks remain readable and portable while navigation migration only detaches their placement', async () => {
  const state = createConfiguredNavigation(); state.entries.push(legacyClock()); state.settings.pages.push(2);
  state.settings.minimal = true; state.settings.showClock = false;
  const original = structuredClone(state), migrated = migrateNavigationState(state);
  const clock = migrated.entries.find(isRetiredClockWidget);
  assert.deepEqual(clock, { ...original.entries[6], detached: true });
  assert.deepEqual(state, original);
  assert.deepEqual(migrateNavigationState(migrated), migrated);
  assert.deepEqual(validateWidgetConfig('clock', clock.config), clock.config);
  const replica = recordChanges(createReplica('legacy-clock-device'), createEmptyState(), migrated);
  const packed = await packReplica(replica), received = await readReplicas({ ...packed.chunks, [packed.key]: packed.head });
  const restored = materializeState(received.documents);
  assert.deepEqual(restored.entries.find(isRetiredClockWidget), clock);
  assert.equal(restored.settings.minimal, true);
  assert.equal(restored.settings.showClock, false);
});

test('catalog and new templates cannot add clocks, but old saved/imported templates retain their clock data', () => {
  assert.deepEqual(BUNDLED_EXTENSIONS.map(item => item.id), ['random-wallpaper', 'notes', 'read-later', 'saved-view', 'github-contributions', 'custom-storage-sync']);
  assert.equal(EXTENSION_CATEGORIES.some(item => item.id === 'time'), false);
  assert.equal(extensionsForCatalog('all', 'clock').length, 0);
  assert.ok(BUILTIN_DESKTOP_TEMPLATES.every(template => template.widgets.every(widget => widget.extensionId !== 'clock')));
  const oldTemplate = { ...structuredClone(BUILTIN_DESKTOP_TEMPLATES[0]), name: 'Old travel setup', widgets: [
    { extensionId: 'clock', config: legacyClock().config, page: 0, position: { row: 0, column: 0 } },
    { extensionId: 'notes', config: { size: 'small' }, page: 0, position: { row: 3, column: 0 } },
  ] };
  const inspected = inspectDesktopTemplate(JSON.stringify(oldTemplate));
  assert.deepEqual(inspected.widgets, oldTemplate.widgets);
  assert.equal(validateSavedDesktopTemplates({ version: 1, revision: 1, templates: [{ id: 'legacy', name: oldTemplate.name, createdAt: 1, template: inspected }] }).templates[0].template.widgets[0].extensionId, 'clock');
  const existing = createConfiguredNavigation(); existing.entries.push(legacyClock()); existing.settings.pages.push(2);
  const before = structuredClone(existing), applied = applyDesktopTemplate(existing, oldTemplate, { widgets: true });
  assert.equal(applied.addedWidgets, 1);
  assert.deepEqual(applied.state.entries.find(isRetiredClockWidget), { ...before.entries[6], detached: true });
  assert.equal(applyDesktopTemplate(createEmptyState(), oldTemplate, { widgets: true }).state.entries.some(isRetiredClockWidget), false);
  assert.equal(createDesktopTemplate(existing).widgets.some(widget => widget.extensionId === 'clock'), false);
  assert.deepEqual(existing, before);
  assert.equal(oldTemplate.widgets[0].extensionId, 'clock', 'application must not rewrite the retained source template');
});
