import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationIconRepair } from './navigation-icon-repair.js';
const source = 'https://cdn.example/explicit.png';
const entry = (extra = {}) => ({ id: 'site-one', type: 'site', name: 'Keep my title', url: 'https://site.example/private?q=keep#fragment',
  icon: { kind: 'image', value: 'missing-upload' }, iconUrl: source, iconBackground: '#123456', parentId: 'folder-one', order: 4, ...extra });
const report = (extra = {}) => ({ total: 1, completed: 1, cached: 1, downloaded: 0, native: 0, failed: 0, missing: [], cancelled: false, ...extra });
function fixture(entries, options = {}) {
  let current = { version: 1, revision: 5, entries, settings: { arbitrary: 'preserved' } }, calls = [];
  const prepared = [], saved = [], available = new Set(options.available ?? [source]);
  const service = createNavigationIconRepair({
    load: async () => structuredClone(current),
    asset: async (id) => { calls.push(['asset', id]); return options.validAsset ?? false; },
    read: async (url) => available.has(url) ? { blob: new Blob(['already validated']) } : null,
    prepare: async (value, settings) => { prepared.push({ value: structuredClone(value), settings }); return options.report ?? report(); },
    save: async (next, expected) => { saved.push({ next: structuredClone(next), expected }); if (options.conflict) throw Object.assign(Error('Concurrent edit'), { code: 'REVISION_CONFLICT' }); current = { ...structuredClone(next), revision: expected + 1 }; return current; },
  });
  return { repair: service.repair, prepared, saved, calls, read: () => structuredClone(current) };
}
test('explicit repair migrates a missing local asset to its exact cached URL and commits one revision without losing metadata', async () => {
  const original = entry(), subject = fixture([original]), result = await subject.repair();
  assert.equal(subject.prepared[0].value.entries[0].icon.kind, 'url');
  assert.equal(result.repairedLocalAssets, 1); assert.equal(result.state.revision, 6); assert.equal(subject.saved.length, 1);
  assert.equal(subject.saved[0].expected, 5);
  assert.deepEqual(result.state.entries[0], { ...original, icon: { kind: 'url', value: source } });
});
test('a failed exact-source acquisition retains the missing local reference and never commits a guessed replacement', async () => {
  const original = entry(), subject = fixture([original], { available: [], report: report({ cached: 0, failed: 1, missing: [{ source }] }) });
  const result = await subject.repair();
  assert.equal(result.repairedLocalAssets, 0); assert.equal(result.state, undefined); assert.equal(subject.saved.length, 0);
  assert.deepEqual(subject.read().entries, [original]);
});
test('valid local uploads remain local and are never exposed to remote acquisition', async () => {
  const original = entry(), subject = fixture([original], { validAsset: true });
  const result = await subject.repair();
  assert.equal(subject.prepared[0].value.entries[0].icon.kind, 'image');
  assert.equal(subject.saved.length, 0); assert.equal(result.repairedLocalAssets, 0);
});
test('missing local images without an explicit valid source are reported without guessing website favicon addresses', async () => {
  const original = entry({ iconUrl: undefined }), subject = fixture([original]);
  const result = await subject.repair();
  assert.equal(result.unrecoverableLocalAssets, 1); assert.equal(subject.saved.length, 0);
  assert.equal(subject.prepared[0].value.entries[0].icon.kind, 'image');
});
test('permission retry repairs only selected exact sources and preserves failed siblings', async () => {
  const other = entry({ id: 'site-two', iconUrl: 'https://other.example/unselected.png' }), subject = fixture([entry(), other]);
  const sourceUrls = [source], result = await subject.repair({ sourceUrls });
  assert.equal(result.repairedLocalAssets, 1); assert.equal(subject.prepared[0].value.entries[1].icon.kind, 'image');
  assert.deepEqual(subject.prepared[0].settings.sourceUrls, sourceUrls);
  assert.deepEqual(result.state.entries[1], other);
});
test('a cancelled acquisition never rewrites local bindings even if an image arrived before cancellation', async () => {
  const original = entry(), subject = fixture([original], { report: report({ cancelled: true }) });
  const result = await subject.repair();
  assert.equal(result.cancelled, true); assert.equal(subject.saved.length, 0); assert.equal(result.repairedLocalAssets, 0);
  assert.deepEqual(subject.read().entries, [original]);
});
test('a concurrent edit rejects the one CAS binding update and leaves the original navigation intact', async () => {
  const original = entry(), subject = fixture([original], { conflict: true });
  await assert.rejects(subject.repair(), { code: 'REVISION_CONFLICT' });
  assert.equal(subject.saved.length, 1); assert.equal(subject.saved[0].expected, 5);
  assert.deepEqual(subject.read().entries, [original]);
});

test('repair cannot commit after its caller becomes stale while checking prepared image bytes', async () => {
  let current = true, writes = 0;
  const service = createNavigationIconRepair({ load: async () => ({ revision: 2, entries: [entry()] }), asset: async () => false,
    prepare: async () => report(), read: async () => { current = false; return { blob: new Blob(['validated']) }; },
    save: async () => { writes++; },
  });
  const result = await service.repair({ isCurrent: () => current });
  assert.equal(result.cancelled, true); assert.equal(writes, 0); assert.equal(result.repairedLocalAssets, 0);
});
