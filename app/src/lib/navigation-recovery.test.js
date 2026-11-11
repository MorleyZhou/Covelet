import test from 'node:test';
import assert from 'node:assert/strict';
import { remapNavigationPreferences } from './navigation-recovery.js';
import { defaultSavedFilters } from './saved-views.js';

test('append remaps only imported navigation metadata and preserves other content domains', () => {
  const input = { version: 1, revision: 3, presentation: true,
    aliases: { 'site:old': 'recycled', 'folder:skipped': 'do not attach locally', 'note:note-a': 'note alias' },
    privateKeys: ['site:old', 'folder:skipped', 'note:note-a'],
    library: { version: 1, tags: [{ id: 'tag-a', name: 'Work' }], items: {
      'site:old': { description: 'source metadata', tagIds: ['tag-a'] },
      'site:skipped': { description: 'wrong local site', tagIds: ['tag-a'] },
      'note:note-a': { description: '', tagIds: ['tag-a'] },
    } } };
  const before = structuredClone(input), mapped = remapNavigationPreferences(input, {
    preferenceKeyMap: new Map([['site:old', 'site:restored']]), referenceIdMap: new Map(),
  });
  assert.deepEqual(input, before);
  assert.deepEqual(mapped.aliases, { 'site:restored': 'recycled', 'note:note-a': 'note alias' });
  assert.deepEqual(mapped.privateKeys, ['site:restored', 'note:note-a']);
  assert.deepEqual(Object.keys(mapped.library.items), ['site:restored', 'note:note-a']);
  assert.deepEqual(mapped.library.items['site:restored'], input.library.items['site:old']);
  assert.deepEqual(mapped.library.tags, input.library.tags);
});

test('folder view references follow imported identities and missing references never bind local collisions', () => {
  const view = (id, folderId) => ({ id, revision: 1, name: id, ...defaultSavedFilters(), scope: { kind: 'folder', folderId } });
  const input = { version: 1, revision: 0, presentation: false, aliases: {}, privateKeys: [], library: {
    version: 1, tags: [], items: {}, views: [view('mapped-view', 'owned'), view('skipped-view', 'skipped'), view('missing-view', 'missing'), view('another-view', 'missing')],
  } };
  const result = remapNavigationPreferences(input, { preferenceKeyMap: new Map(), referenceIdMap: new Map([['owned', 'fresh-owned'], ['skipped', 'missing-source-folder']]),
    reservedEntryIds: ['missing-folder-collision'], makeId: (() => { const ids = ['collision', 'fresh']; return () => ids.shift(); })(),
  });
  assert.deepEqual(result.library.views.map((entry) => entry.scope.folderId), ['fresh-owned', 'missing-source-folder', 'missing-folder-fresh', 'missing-folder-fresh']);
  assert.throws(() => remapNavigationPreferences(input, { preferenceKeyMap: new Map(), referenceIdMap: new Map(), makeId: () => '.' }), { code: 'REVISION_CONFLICT' });
});
