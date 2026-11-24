import test from 'node:test';
import assert from 'node:assert/strict';
import { fromMarkdown } from '@futelab/folio/serialization';
import { NOTE_HISTORY_LIMITS, createEmptyNoteHistory, validateNoteHistory, captureNoteVersion, mergeNoteHistories, pruneNoteHistory } from './note-history-core.js';
import { noteDocumentText } from './note-document.js';

const copy = (value) => structuredClone(value), bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const note = (id = 'note-a', body = 'Full original body', revision = 1) => ({ id, title: id, body, pinned: false, revision, createdAt: 1, updatedAt: 2 });
let serial = 0;
const capture = (history, record, options = {}) => captureNoteVersion(history, record, { now: () => 50, uuid: () => `version-${++serial}`, ...options });

test('history captures complete independent rich-note snapshots without mutating the current note or the previous envelope', () => {
  const document = fromMarkdown('## Heading\n\n**Full text** and [link](https://example.test/)');
  const current = { ...note(), document, body: noteDocumentText(document), pinned: true };
  const before = copy(current), empty = createEmptyNoteHistory();
  const { history, version } = capture(empty, current);
  assert.deepEqual(current, before); assert.deepEqual(empty, createEmptyNoteHistory());
  assert.deepEqual(version.record, before); assert.equal(history.clock, 1); assert.equal(history.revision, 1);
  current.document.content[0].content[0].text = 'Later draft';
  assert.deepEqual(history.notes['note-a'][0].record, before);
  assert.deepEqual(validateNoteHistory(history), history);
});

test('the newest twenty versions survive and the single Lamport clock never resets after histories are pruned', () => {
  let history = createEmptyNoteHistory();
  for (let index = 1; index <= 25; index++) history = capture(history, note('note-a', `Version ${index}`, index)).history;
  assert.equal(history.notes['note-a'].length, 20);
  assert.deepEqual(history.notes['note-a'].map((version) => version.n), Array.from({ length: 20 }, (_, index) => index + 6));
  assert.equal(history.clock, 25);
  const cleared = { ...history, notes: {} }, next = capture(cleared, note());
  assert.equal(next.version.n, 26); assert.equal(next.history.clock, 26);
  assert.equal(cleared.clock, 25); assert.deepEqual(cleared.notes, {});
});

test('per-note and global byte caps evict only old history while a protected current snapshot always survives', () => {
  const document = fromMarkdown('界'.repeat(59000)), body = noteDocumentText(document);
  let history = createEmptyNoteHistory();
  for (let index = 1; index <= 15; index++) history = capture(history, { ...note('large-note', body, index), document }).history;
  assert.ok(history.notes['large-note'].length < 15); assert.ok(bytes(history.notes['large-note']) <= NOTE_HISTORY_LIMITS.noteBytes);
  assert.equal(history.notes['large-note'].at(-1).record.revision, 15);
  const raw = createEmptyNoteHistory(); raw.clock = 55;
  for (let index = 1; index <= 55; index++) raw.notes[`note-${index}`] = [{ id: `full-${index}`, n: index, capturedAt: index,
    record: { ...note(`note-${index}`, body), document } }];
  assert.ok(bytes(raw) > NOTE_HISTORY_LIMITS.totalBytes);
  const original = copy(raw), result = pruneNoteHistory(raw, { protectIds: ['full-1'] });
  assert.ok(bytes(result) <= NOTE_HISTORY_LIMITS.totalBytes); assert.ok(result.notes['note-1']);
  assert.ok(!result.notes['note-2']); assert.ok(result.notes['note-55']); assert.deepEqual(raw, original);
});

test('concurrent histories retain both immutable version IDs and merge clocks without field-level blending', () => {
  const left = capture(createEmptyNoteHistory(), note('shared', 'Device A'), { uuid: () => 'device-a-version' }).history;
  const right = capture(createEmptyNoteHistory(), note('shared', 'Device B'), { uuid: () => 'device-b-version' }).history;
  const merged = mergeNoteHistories(left, right);
  assert.deepEqual(merged.notes.shared.map((version) => version.record.body), ['Device A', 'Device B']);
  assert.deepEqual(mergeNoteHistories(right, left), merged);
  assert.deepEqual(mergeNoteHistories(merged, right), merged);
  assert.equal(capture(merged, note('shared', 'Current snapshot')).version.n, 2);
  const forged = copy(left); forged.notes.shared[0].record.body = 'Changed existing version';
  assert.throws(() => mergeNoteHistories(left, forged), { code: 'NOTE_HISTORY_CONFLICT' });
});

test('selected-note backup merging cannot attach skipped records and retains the global causal clock', () => {
  const local = capture(createEmptyNoteHistory(), note('local')).history;
  let incoming = capture(createEmptyNoteHistory(), note('imported')).history;
  incoming = capture(incoming, note('skipped')).history;
  const result = mergeNoteHistories(local, incoming, { noteIds: ['imported'] });
  assert.deepEqual(Object.keys(result.notes), ['imported', 'local']); assert.equal(result.clock, incoming.clock);
  assert.equal(result.notes.skipped, undefined);
});

test('malformed history, duplicate IDs and unsafe note fields fail without pruning or modifying current content', () => {
  const good = capture(createEmptyNoteHistory(), note()).history;
  for (const change of [
    (value) => { value.password = 'forbidden'; },
    (value) => { value.clock = 0; },
    (value) => { value.notes['note-a'][0].record.id = 'different-note'; },
    (value) => { value.notes['note-a'][0].record.deviceKey = 'forbidden'; },
    (value) => { value.notes['note-a'][0].record.body = 'x'.repeat(60001); },
    (value) => { value.notes['note-a'].push(copy(value.notes['note-a'][0])); },
    (value) => { value.notes['note-a'][0].record.document = fromMarkdown('Different projection'); },
  ]) {
    const bad = copy(good); change(bad); assert.throws(() => validateNoteHistory(bad));
  }
  const old = copy(good); old.clock = Number.MAX_SAFE_INTEGER;
  assert.throws(() => capture(old, note()), { code: 'NOTE_HISTORY_CAPACITY' });
  assert.deepEqual(good.notes['note-a'][0].record, note());
});
