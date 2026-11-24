import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyNoteHistory, captureNoteVersion, NOTE_HISTORY_KEY } from './note-history-core.js';
import { mergeSyncRecord, countSyncRecordUnits } from './record-sync-merge.js';
import { normalizeSyncValue, prepareSyncValue, validateSyncValue } from './sync-data-rules.js';

const note = (body, revision = 3) => ({ id: 'shared-note', title: 'Shared', body, pinned: false, revision, createdAt: 1, updatedAt: 2 });
const capture = (body, uuid, now = 10) => captureNoteVersion(createEmptyNoteHistory(), note(body), { uuid: () => uuid, now: () => now }).history;
const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';

test('concurrent immutable note versions merge without losing either device history and count as business records', () => {
  const left = capture('Left prior body', a), right = capture('Right prior body', b);
  const before = structuredClone([left, right]);
  const merged = mergeSyncRecord('preferences', NOTE_HISTORY_KEY, { local: left, remote: right });
  assert.deepEqual(merged.value.notes['shared-note'].map(version => version.id).sort(), [a, b]);
  assert.equal(merged.rows.length, 2); assert.equal(merged.units, 2);
  assert.equal(countSyncRecordUnits('preferences', NOTE_HISTORY_KEY, merged.value), 2);
  assert.deepEqual(mergeSyncRecord('preferences', NOTE_HISTORY_KEY, { local: right, remote: left }).value, merged.value);
  assert.deepEqual([left, right], before);
});

test('a per-version preview choice cannot discard an unrelated version', () => {
  const left = capture('Left prior body', a), right = capture('Right prior body', b);
  const preview = mergeSyncRecord('preferences', NOTE_HISTORY_KEY, { local: left, remote: right });
  const row = preview.rows.find(item => item.local?.id === a);
  const selected = mergeSyncRecord('preferences', NOTE_HISTORY_KEY, { local: left, remote: right, choices: { [row.id]: 'remote' } });
  assert.deepEqual(selected.value.notes['shared-note'].map(version => version.id), [b]);
});

test('a reused version ID with different content rejects the whole semantic merge', () => {
  const left = capture('Original immutable body', a), right = structuredClone(left);
  right.notes['shared-note'][0].record.body = 'Tampered';
  const before = structuredClone(left);
  assert.throws(() => mergeSyncRecord('preferences', NOTE_HISTORY_KEY, { local: left, remote: right }), { code: 'DATA_SYNC_INVALID' });
  assert.deepEqual(left, before);
});

test('sync rebases only the local history envelope revision and preserves immutable version clocks and source revisions', async () => {
  const history = capture('Portable body', a); history.revision = 12;
  const normalized = normalizeSyncValue('preferences', NOTE_HISTORY_KEY, history);
  assert.equal(normalized.revision, 0); assert.equal(normalized.clock, history.clock);
  assert.deepEqual(normalized.notes, history.notes);
  const applied = prepareSyncValue('preferences', NOTE_HISTORY_KEY, normalized, { revision: 20 });
  assert.equal(applied.revision, 21); assert.deepEqual(applied.notes, history.notes);
  await validateSyncValue('preferences', NOTE_HISTORY_KEY, applied);
  const invalid = structuredClone(applied); invalid.notes['shared-note'][0].record.body = null;
  await assert.rejects(validateSyncValue('preferences', NOTE_HISTORY_KEY, invalid));
});
