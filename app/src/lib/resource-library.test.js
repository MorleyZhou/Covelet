import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceLocation, resourceDomain, sortResourceRows } from './resource-library.js';

const folder = { id: 'folder', type: 'folder', name: 'Work', page: 2, parentId: null, order: 3 };
const child = { id: 'child', type: 'site', name: 'Article 10', url: 'https://www.example.com/article', page: 0, parentId: folder.id, order: 0 };
const root = { id: 'root', type: 'site', name: 'Article 2', url: 'https://a.example.org/', page: 1, parentId: null, order: 4, position: { row: 2, column: 1 } };
const navigation = { entries: [folder, child, root] };
const rows = navigation.entries.map((entry) => ({ key: `${entry.type}:${entry.id}`, entry }));

test('resource locations follow the containing folder rather than a stale child page', () => {
  assert.deepEqual(resourceLocation(child, navigation), { page: 2, folder });
  assert.deepEqual(resourceLocation(root, navigation), { page: 1, folder: null });
});

test('resource domain is the hostname without a path and folders have no domain', () => {
  assert.equal(resourceDomain(child), 'www.example.com');
  assert.equal(resourceDomain(folder), '');
});

test('all resource display sorts preserve navigation order, positions and row references', () => {
  const before = structuredClone(navigation), order = [...rows];
  for (const field of ['name', 'domain', 'location']) for (const direction of ['asc', 'desc']) {
    const sorted = sortResourceRows(rows, navigation, { field, direction }, 'en');
    assert.equal(sorted.length, rows.length);
    assert(sorted.every((row) => rows.includes(row)));
  }
  assert.deepEqual(navigation, before);
  assert.deepEqual(rows, order);
  assert.equal(sortResourceRows(rows, navigation, {}, 'en')[0].entry.id, 'root');
});

test('location sort uses effective folder page and keeps a deterministic name tie break', () => {
  const sorted = sortResourceRows(rows, navigation, { field: 'location' }, 'en');
  assert.deepEqual(sorted.map((row) => row.entry.id), ['root', 'folder', 'child']);
});
