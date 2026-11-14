import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, letterIcon, migrateNavigationState, validateDesktopAppearance, validateState } from './model.js';
import { effectiveDesktopAppearance, prepareDesktopAppearance, saveDesktopAppearance } from './desktop-appearance.js';
import { beginDesktopEdit, moveDesktopPage, removeDesktopScreen, renameDesktopPage } from './desktop-edit.js';
import { localData } from './local-data.js';
import { createColorBackground } from './background-colors.js';

const options = (state, page = 0) => ({ expectedNavigationRevision: state.revision, page });
const withStyle = () => prepareDesktopAppearance(createEmptyState(), null, { background: { kind: 'color', value: '#123456' }, shade: 20 }, { expectedNavigationRevision: 0, page: 0 });

test('legacy desktops inherit each global field and explicit zero values remain independent overrides', () => {
  const state = createEmptyState(), before = structuredClone(state);
  assert.deepEqual(effectiveDesktopAppearance(state.settings, 0), { background: state.settings.background, shade: state.settings.shade, blur: state.settings.blur });
  assert.equal(migrateNavigationState(state).settings.desktopPages, undefined);
  const prepared = prepareDesktopAppearance(state, null, { shade: 0 }, options(state));
  assert.equal(prepared.changed, true); assert(prepared.desktopId); assert.equal(prepared.sourceRevision, 0);
  assert.equal(prepared.state.revision, 0); assert.deepEqual(state, before);
  prepared.state.settings.shade = 50; prepared.state.settings.blur = 8;
  assert.deepEqual(effectiveDesktopAppearance(prepared.state.settings, 0), { background: state.settings.background, shade: 0, blur: 8 });
  const resolved = effectiveDesktopAppearance(prepared.state.settings, 0); resolved.background.value = 'changed';
  assert.equal(prepared.state.settings.background.value, 'alpine');
  assert.deepEqual(effectiveDesktopAppearance(prepared.state.settings, 999), { background: state.settings.background, shade: 50, blur: 8 });
});

test('partial field reset and reset-all preserve identity/name, while no-op reset creates no identity', () => {
  const initial = createEmptyState(), empty = prepareDesktopAppearance(initial, null, null, options(initial));
  assert.equal(empty.changed, false); assert.equal(empty.desktopId, null); assert.equal(empty.state.settings.desktopPages, undefined);
  const first = withStyle(), named = renameDesktopPage(first.state, 0, 'Work');
  const partial = prepareDesktopAppearance(named, first.desktopId, { shade: null, blur: 4 }, options(named));
  assert.deepEqual(partial.state.settings.desktopPages[0], { id: first.desktopId, name: 'Work', appearance: { background: { kind: 'color', value: '#123456' }, blur: 4 } });
  const reset = prepareDesktopAppearance(partial.state, first.desktopId, null, options(partial.state));
  assert.deepEqual(reset.state.settings.desktopPages[0], { id: first.desktopId, name: 'Work' });
  assert.equal(prepareDesktopAppearance(reset.state, first.desktopId, {}, options(reset.state)).changed, false);
  assert.equal(prepareDesktopAppearance(reset.state, first.desktopId, { blur: null }, options(reset.state)).changed, false);
  const raw = structuredClone(reset.state); raw.settings.desktopPages[0].appearance = {};
  assert.deepEqual(validateState(raw).settings.desktopPages[0], { id: first.desktopId, name: 'Work' });
});

test('appearance stays with original logical identity through overflow promotion, rename, reorder and removal', () => {
  const initial = createEmptyState(); initial.settings.pages = [0, 1];
  initial.entries = Array.from({ length: 7 }, (_, index) => ({ id: `s${index}`, type: 'site', name: `Site ${index}`,
    url: `https://example.com/${index}`, groupId: 'group-home', parentId: null, page: 0, order: index, icon: letterIcon('S') }));
  const first = prepareDesktopAppearance(initial, null, { shade: 20 }, options(initial, 1));
  const captured = beginDesktopEdit(first.state, 1);
  assert.equal(captured.state.settings.desktopPages[1], undefined);
  assert.deepEqual(captured.state.settings.desktopPages[2].appearance, { shade: 20 });
  const moved = moveDesktopPage(captured.state, 2, -1, '2:0', 1).state;
  assert.equal(moved.settings.desktopPages[1].id, first.desktopId);
  const changed = prepareDesktopAppearance(moved, first.desktopId, { blur: 2 }, options(moved, 2));
  assert.equal(changed.page, 1, 'the stale numeric page cannot redirect an existing identity');
  assert.deepEqual(changed.state.settings.desktopPages[1].appearance, { shade: 20, blur: 2 });
  const removed = removeDesktopScreen(moved, '1:0', 1).state;
  assert(!Object.values(removed.settings.desktopPages || {}).some((item) => item.id === first.desktopId));
  assert.throws(() => prepareDesktopAppearance(removed, first.desktopId, { blur: 2 }, options(removed)), { code: 'REVISION_CONFLICT' });
});

test('stale revisions or reassigned unbound pages cannot write to another desktop', () => {
  const first = withStyle(), before = structuredClone(first.state);
  assert.throws(() => prepareDesktopAppearance(first.state, first.desktopId, { blur: 1 }, { expectedNavigationRevision: 3 }), { code: 'REVISION_CONFLICT' });
  assert.throws(() => prepareDesktopAppearance(first.state, null, { blur: 1 }, options(first.state)), { code: 'REVISION_CONFLICT' });
  assert.throws(() => prepareDesktopAppearance(first.state, 'missing', { blur: 1 }, options(first.state)), { code: 'REVISION_CONFLICT' });
  assert.throws(() => prepareDesktopAppearance(first.state, null, { blur: 1 }, options(first.state, 4)), { code: 'REVISION_CONFLICT' });
  assert.deepEqual(first.state, before);
});

test('only portable background modes and finite shade/blur are accepted, without introducing image resources', () => {
  for (const appearance of [
    { background: { kind: 'builtin', value: 'alpine' } }, { background: { kind: 'bing', value: 'daily' } },
    { background: { kind: 'color', value: '#abc' } }, { background: createColorBackground({ colors: ['#123456', '#abcdef'], angle: 45, curve: [0, 0, 1, 1] }) },
    { shade: 90, blur: 40 },
  ]) assert.deepEqual(validateDesktopAppearance(appearance), appearance);
  for (const appearance of [null, [], new Date(), { theme: 'dark' }, { source: 'commons' }, { shade: -1 }, { shade: 91 }, { blur: 41 }, { blur: NaN },
    { blur: Infinity }, { shade: null }, { background: null }, { background: { kind: 'image', value: 'asset-a' } },
    { background: { kind: 'bing', value: 'https://tracker.example/' } }, { background: { kind: 'bing', value: 'daily', source: 'commons' } },
    { background: { kind: 'gradient', value: 'linear-gradient(#fff,#000),url(https://tracker.example/pixel)' } },
    { background: { kind: 'builtin', value: 'missing' } },
  ]) assert.throws(() => validateDesktopAppearance(appearance));
  const old = createEmptyState(); old.settings.background = { kind: 'image', value: 'legacy-asset' };
  assert.doesNotThrow(() => validateState(old));
  assert.deepEqual(migrateNavigationState(old).settings.background, { kind: 'bing', value: 'daily' });
});

function persistence(t, { race = false, fail = false } = {}) {
  const key = 'owntab.local.v1';
  let envelope = { version: 1, state: createEmptyState(), snapshots: [] }, reads = 0;
  t.mock.method(localData, 'get', async (requested) => {
    if (requested === key && race && ++reads === 2) envelope.state.revision++;
    return structuredClone({ [requested]: requested === key ? envelope : undefined });
  });
  const writes = t.mock.method(localData, 'set', async (patch) => {
    if (fail) throw Error('synthetic quota exceeded');
    if (patch[key]) envelope = structuredClone(patch[key]);
  });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_name, options, callback) => (callback || options)() } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'navigator', descriptor) : delete globalThis.navigator);
  return { writes, current: () => structuredClone(envelope) };
}

test('saved page appearance has one navigation CAS write; no-op saves preserve snapshots and global settings', async (t) => {
  const subject = persistence(t), before = subject.current();
  const result = await saveDesktopAppearance(null, { shade: 20 }, { expectedNavigationRevision: 0, page: 0 });
  assert.equal(result.state.revision, 1); assert.equal(subject.writes.mock.callCount(), 1);
  assert.deepEqual(result.state.settings.background, before.state.settings.background);
  const stored = subject.current();
  const same = await saveDesktopAppearance(result.desktopId, { shade: 20 }, { expectedNavigationRevision: 1 });
  assert.equal(same.changed, false); assert.equal(subject.writes.mock.callCount(), 1); assert.deepEqual(subject.current(), stored);
});

test('save conflict or quota failure keeps existing appearance and unrelated navigation untouched', async (t) => {
  await t.test('a change between the read and locked write rejects CAS', async (t) => {
    const subject = persistence(t, { race: true });
    await assert.rejects(saveDesktopAppearance(null, { shade: 20 }, { expectedNavigationRevision: 0, page: 0 }), { code: 'REVISION_CONFLICT' });
    assert.equal(subject.current().state.settings.desktopPages, undefined); assert.equal(subject.writes.mock.callCount(), 0);
  });
  await t.test('quota failure does not publish the prepared identity or style', async (t) => {
    const subject = persistence(t, { fail: true }), before = subject.current();
    await assert.rejects(saveDesktopAppearance(null, { blur: 4 }, { expectedNavigationRevision: 0, page: 0 }), /quota/);
    assert.deepEqual(subject.current(), before);
  });
});
