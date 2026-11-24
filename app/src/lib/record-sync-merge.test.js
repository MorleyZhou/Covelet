import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSyncRecord, countSyncRecordUnits, countSyncSnapshotUnits } from './record-sync-merge.js';
import { createEmptyState, validateState } from './model.js';
import { validatePersonalTools } from './personal-tools.js';
import { validateContentPreferences } from './content-preferences.js';

const copy = (value) => structuredClone(value);
const note = (id, body = id) => ({ id, title: id, body, pinned: false, revision: 1, createdAt: 1, updatedAt: 1 });
const tools = (...notes) => ({ version: 3, revision: 0, notes, reading: [], snapshots: [], trash: [] });
const nav = () => ({ version: 1, state: createEmptyState(), snapshots: [] });
const site = (id, order = 0, parentId = null) => ({ id, type: 'site', name: id, url: `https://${id}.example/`, groupId: 'group-home', parentId, order, icon: { kind: 'letter', value: id } });
const merge = (key, base, local, remote, options = {}) => mergeSyncRecord('preferences', key, { base, local, remote, hasBase: true, ...options });

test('each device adding different notes retains both records and a stable merged order', () => {
  const base = tools(), local = tools(note('local')), remote = tools(note('remote'));
  const result = merge('covelet.tools.v1', base, local, remote);
  assert.deepEqual(result.value.notes.map((item) => item.id), ['local', 'remote']);
  assert.deepEqual(result.rows.map((row) => row.status), ['one', 'one']);
  assert.ok(result.rows.every((row) => !row.conflict));
  validatePersonalTools(result.value);
  assert.deepEqual(merge('covelet.tools.v1', base, remote, local).value, result.value);
  assert.deepEqual(local, tools(note('local')), 'merging does not mutate inputs');
});

test('two devices changing different fields of the same note combine them', () => {
  const base = tools(note('shared')), local = copy(base), remote = copy(base);
  local.notes[0].title = 'Local title'; local.notes[0].updatedAt = 10;
  remote.notes[0].body = 'Remote body'; remote.notes[0].updatedAt = 20;
  const result = merge('covelet.tools.v1', base, local, remote);
  assert.equal(result.value.notes[0].title, 'Local title');
  assert.equal(result.value.notes[0].body, 'Remote body');
  assert.equal(result.value.notes[0].updatedAt, 20);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, 'both');
  assert.equal(result.rows[0].conflict, false);
  assert.equal(result.rows[0].choice, 'merged');
  validatePersonalTools(result.value);
});

test('two devices changing the same field require an explicit record choice', () => {
  const base = tools(note('shared')), local = copy(base), remote = copy(base);
  local.notes[0].body = 'Local'; remote.notes[0].body = 'Remote';
  const result = merge('covelet.tools.v1', base, local, remote), row = result.rows[0];
  assert.equal(row.conflict, true);
  assert.equal(row.status, 'both');
  assert.equal(row.choice, 'local');
  assert.equal(result.value.notes[0].body, 'Local');
  const selected = merge('covelet.tools.v1', base, local, remote, { choices: { [row.id]: 'remote' } });
  assert.deepEqual(selected.value.notes[0], remote.notes[0]);
});

test('delete versus modify defaults to retaining the modified note and permits deletion', () => {
  const base = tools(note('shared')), local = tools(), remote = copy(base);
  remote.notes[0].body = 'Keep this modification';
  const result = merge('covelet.tools.v1', base, local, remote), row = result.rows[0];
  assert.equal(row.status, 'deleted'); assert.equal(row.conflict, true);
  assert.equal(result.value.notes[0].body, 'Keep this modification');
  assert.equal(merge('covelet.tools.v1', base, local, remote, { choices: { [row.id]: 'local' } }).value.notes.length, 0);
  assert.equal(merge('covelet.tools.v1', base, local, base).value.notes.length, 0, 'delete versus unchanged adopts deletion');
});

test('tag rename keeps stable IDs and combines an independent description edit', () => {
  const base = { version: 1, revision: 0, aliases: {}, privateKeys: [], library: { version: 1,
    tags: [{ id: 'tag-shared', name: 'Before' }], items: { 'note:shared': { description: 'Before', tagIds: ['tag-shared'] } } } };
  const local = copy(base), remote = copy(base);
  local.library.tags[0].name = 'Renamed'; remote.library.items['note:shared'].description = 'Changed remotely';
  const result = merge('covelet.content.preferences.v1', base, local, remote);
  assert.deepEqual(result.value.library.tags, [{ id: 'tag-shared', name: 'Renamed' }]);
  assert.deepEqual(result.value.library.items['note:shared'], { description: 'Changed remotely', tagIds: ['tag-shared'] });
  assert.ok(result.rows.some((row) => row.kind === 'tag'));
  validateContentPreferences(result.value);
});

test('folder movement retains stable child references while another device renames it', () => {
  const base = nav(); base.state.entries = [
    { ...site('folder', 0), type: 'folder' }, site('child', 0, 'folder'), site('other', 1),
  ]; delete base.state.entries[0].url;
  const local = copy(base), remote = copy(base);
  local.state.entries[0].page = 1; local.state.entries[0].position = { row: 1, column: 1 };
  remote.state.entries[0].name = 'Remote folder name';
  const result = merge('owntab.local.v1', base, local, remote);
  const folder = result.value.state.entries.find((entry) => entry.id === 'folder');
  assert.equal(folder.page, 1); assert.equal(folder.name, 'Remote folder name');
  assert.equal(result.value.state.entries.find((entry) => entry.id === 'child').parentId, 'folder');
  validateState(result.value.state);
});

test('concurrent incompatible placements remain indivisible during merged and remote choices', () => {
  const base = nav(); base.state.entries = [site('shared')];
  const local = copy(base), remote = copy(base);
  local.state.entries[0].page = 1; local.state.entries[0].position = { row: 1, column: 2 };
  remote.state.entries[0].page = 2; remote.state.entries[0].position = { row: 3, column: 4 };
  const result = merge('owntab.local.v1', base, local, remote), row = result.rows[0];
  assert.equal(row.conflict, true);
  assert.equal(result.value.state.entries[0].page, 1);
  assert.deepEqual(result.value.state.entries[0].position, { row: 1, column: 2 });
  const selected = merge('owntab.local.v1', base, local, remote, { choices: { [row.id]: 'remote' } });
  assert.equal(selected.value.state.entries[0].page, 2);
  assert.deepEqual(selected.value.state.entries[0].position, { row: 3, column: 4 });
});

test('independent navigation additions normalize colliding order slots without losing IDs', () => {
  const base = nav(), local = copy(base), remote = copy(base);
  local.state.entries = [site('local')]; remote.state.entries = [site('remote')];
  const result = merge('owntab.local.v1', base, local, remote);
  assert.deepEqual(result.value.state.entries.map((entry) => [entry.id, entry.order]), [['local', 0], ['remote', 1]]);
  validateState(result.value.state);
});

test('upgrade without a common baseline unions distinct records and keeps same-ID conflicts', () => {
  const local = tools(note('local'), note('shared', 'Local')), remote = tools(note('remote'), note('shared', 'Remote'));
  const result = merge('covelet.tools.v1', undefined, local, remote, { hasBase: false });
  assert.deepEqual(result.value.notes.map((record) => record.id), ['local', 'remote', 'shared']);
  assert.equal(result.value.notes.find((record) => record.id === 'shared').body, 'Local');
  assert.equal(result.rows.find((row) => row.label === 'shared').conflict, true);
});

test('rich note body and document are one conflict unit', () => {
  const base = tools(note('shared')), local = copy(base), remote = copy(base);
  local.notes[0].body = 'Local'; remote.notes[0].document = { version: 1, content: 'Remote' };
  const result = merge('covelet.tools.v1', base, local, remote);
  assert.equal(result.rows[0].conflict, true);
  assert.equal(result.value.notes[0].body, 'Local');
  assert.equal(result.value.notes[0].document, undefined, 'does not pair a remote document with a local plain body');
});

test('appearance is merged by setting while background stays an atomic field', () => {
  const base = nav(), local = copy(base), remote = copy(base);
  local.state.settings.theme = 'dark'; remote.state.settings.blur = 20;
  const result = merge('owntab.local.v1', base, local, remote);
  assert.equal(result.value.state.settings.theme, 'dark'); assert.equal(result.value.state.settings.blur, 20);
  assert.ok(result.rows.every((row) => row.kind === 'appearance'));
  validateState(result.value.state);
});

test('unknown storage records and Blob values use whole record choices without false byte equality', () => {
  const local = { blob: new Blob(['local'], { type: 'image/png' }) }, remote = { blob: new Blob(['remote'], { type: 'image/png' }) };
  const result = mergeSyncRecord('assets', 'image', { local, remote });
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].conflict, true);
  assert.equal(result.rows[0].choice, 'local');
  const unknown = merge('covelet.future.v1', { a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 2 });
  assert.equal(unknown.rows.length, 1); assert.deepEqual(unknown.value, { a: 2, b: 1 });
});

test('duplicate IDs and more than 12000 logical records stop without trimming input', () => {
  const duplicate = tools(note('same'), note('same'));
  assert.throws(() => merge('covelet.tools.v1', tools(), duplicate, tools()), { code: 'DATA_SYNC_INVALID' });
  const local = tools(...Array.from({ length: 12001 }, (_, index) => note(`n-${index}`)));
  assert.throws(() => merge('covelet.tools.v1', tools(), local, tools()), { code: 'DATA_SYNC_CAPACITY' });
  assert.equal(local.notes.length, 12001);
});

test('snapshot capacity counts unchanged logical records across different storage keys', () => {
  const first = tools(...Array.from({ length: 6000 }, (_, index) => note(`n-${index}`)));
  const second = { version: 1, revision: 0, aliases: Object.fromEntries(Array.from({ length: 6000 }, (_, index) => [`note:n-${index}`, `Alias ${index}`])), privateKeys: [] };
  const entries = [{ namespace: 'preferences', key: 'covelet.tools.v1', value: first },
    { namespace: 'preferences', key: 'covelet.content.preferences.v1', value: second }];
  assert.equal(merge('covelet.tools.v1', first, first, first).rows.length, 0);
  assert.equal(merge('covelet.content.preferences.v1', second, second, second).rows.length, 0);
  assert.equal(countSyncRecordUnits('preferences', 'covelet.tools.v1', first), 6001);
  assert.equal(countSyncRecordUnits('preferences', 'covelet.content.preferences.v1', second), 6001);
  assert.throws(() => countSyncSnapshotUnits({ version: 1, records: entries }), { code: 'DATA_SYNC_CAPACITY' });
  assert.equal(countSyncSnapshotUnits({ version: 1, records: entries }, 12002), 12002);
  assert.deepEqual(entries.map((record) => record.key), ['covelet.tools.v1', 'covelet.content.preferences.v1']);
});

test('snapshot unit counting includes unknown keys and rejects duplicate storage identities', () => {
  const entry = { namespace: 'future', key: 'one', value: { retained: true } };
  assert.equal(countSyncRecordUnits('preferences', 'missing', undefined), 0);
  assert.equal(countSyncSnapshotUnits({ version: 1, records: [entry] }), 1);
  assert.throws(() => countSyncSnapshotUnits({ version: 1, records: [entry, copy(entry)] }), { code: 'DATA_SYNC_INVALID' });
  assert.throws(() => countSyncSnapshotUnits({ version: 1, records: [entry] }, 0), { code: 'DATA_SYNC_CAPACITY' });
});
