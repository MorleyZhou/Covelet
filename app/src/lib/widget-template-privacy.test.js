import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, letterIcon } from './model.js';
import { createDesktopTemplate, inspectDesktopTemplate, applyDesktopTemplate } from './desktop-templates.js';

const pin = (id, extensionId, config, order) => ({ id, type: 'widget', name: 'PRIVATE RECORD TITLE', extensionId, config,
  groupId: 'group-home', parentId: null, page: 0, icon: letterIcon('P'), order });

test('public desktop templates redact bound content identities and names into generic or unconfigured components', () => {
  const state = createEmptyState();
  state.entries = [pin('note-pin', 'notes', { size: 'medium', noteId: 'private-note-id' }, 0),
    pin('view-pin', 'saved-view', { size: 'small', viewId: 'private-view-id' }, 1)];
  const original = structuredClone(state), template = createDesktopTemplate(state, { name: 'Public layout' });
  assert.deepEqual(template.widgets.map((widget) => widget.config), [{ size: 'medium' }, { size: 'small' }]);
  assert.equal(JSON.stringify(template).includes('private-note-id'), false);
  assert.equal(JSON.stringify(template).includes('private-view-id'), false);
  assert.equal(JSON.stringify(template).includes('PRIVATE RECORD TITLE'), false);
  assert.deepEqual(state, original);
  assert.deepEqual(inspectDesktopTemplate(JSON.stringify(template)), template);
});

test('public template input refuses content bindings even when they happen to name a valid local target', () => {
  const state = createEmptyState();
  state.entries = [pin('note-pin', 'notes', { size: 'small', noteId: 'local-note' }, 0), pin('view-pin', 'saved-view', { size: 'small', viewId: 'local-view' }, 1)];
  const template = createDesktopTemplate(state);
  for (const [index, field, id] of [[0, 'noteId', 'local-note'], [1, 'viewId', 'local-view']]) {
    const untrusted = structuredClone(template); untrusted.widgets[index].config[field] = id;
    assert.throws(() => inspectDesktopTemplate(untrusted));
    assert.throws(() => applyDesktopTemplate(state, untrusted, { widgets: true }));
  }
});

test('applying a shared layout never reuses or relocates bound local pins for its generic slots', () => {
  const state = createEmptyState();
  state.entries = [pin('note-pin', 'notes', { size: 'medium', noteId: 'local-note' }, 0), pin('view-pin', 'saved-view', { size: 'small', viewId: 'local-view' }, 1)];
  const original = structuredClone(state), template = createDesktopTemplate(state), applied = applyDesktopTemplate(state, template, { appearance: false, widgets: true });
  assert.equal(applied.addedWidgets, 2); assert.equal(applied.movedWidgets, 0);
  for (const entry of original.entries) assert.deepEqual(applied.state.entries.find((item) => item.id === entry.id), entry);
  const added = applied.state.entries.filter((entry) => !original.entries.some((before) => before.id === entry.id));
  assert.deepEqual(added.map((entry) => entry.config), [{ size: 'medium' }, { size: 'small' }]);
  assert.deepEqual(state, original);
});
