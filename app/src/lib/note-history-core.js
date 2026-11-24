import { validateNoteDocument, noteDocumentText } from './note-document.js';
import { tr } from '../i18n/index.js';

export const NOTE_HISTORY_KEY = 'covelet.note-history.v1';
export const NOTE_HISTORY_LIMITS = Object.freeze({ versions: 20, versionBytes: 768 * 1024, noteBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 });
const encoder = new TextEncoder(), copy = (value) => structuredClone(value);
const bytes = (value) => encoder.encode(JSON.stringify(value)).length;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fields = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const id = (value) => typeof value === 'string' && /^[a-z\d-]{1,100}$/iu.test(value);
const time = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const order = (left, right) => left.n - right.n || compare(left.id, right.id);
const messages = { NOTE_HISTORY_INVALID: '便笺历史无效，当前便笺已保留。', NOTE_HISTORY_CAPACITY: '便笺历史超出容量限制，当前便笺已保留。',
  NOTE_HISTORY_CONFLICT: '同一便笺历史版本存在不同内容，已停止合并。', NOTE_HISTORY_STALE: '便笺或历史已在其他页面更新，请重新打开历史。' };
export function noteHistoryError(code = 'NOTE_HISTORY_INVALID') { return Object.assign(Error(tr(messages[code] || messages.NOTE_HISTORY_INVALID)), { code }); }
const fail = (code) => { throw noteHistoryError(code); };
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])])) : value;
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

export function createEmptyNoteHistory() { return { version: 1, revision: 0, clock: 0, notes: {} }; }

// Kept independent of personal-tools so sync/backup validators can import this
// module without loading storage or entering a personal-tools module cycle.
export function validateNoteHistoryRecord(note) {
  if (!fields(note, ['id', 'revision', 'createdAt', 'updatedAt', 'title', 'body', 'pinned', 'document']) || !id(note.id)
    || !Number.isSafeInteger(note.revision) || note.revision < 1 || !time(note.createdAt) || !time(note.updatedAt) || note.updatedAt < note.createdAt
    || typeof note.title !== 'string' || note.title.length > 200 || note.title.includes('\0')
    || typeof note.body !== 'string' || note.body.length > 60000 || note.body.includes('\0') || typeof note.pinned !== 'boolean') fail();
  if (Object.hasOwn(note, 'document')) {
    try { validateNoteDocument(note.document); if (noteDocumentText(note.document) !== note.body) fail(); } catch { fail(); }
  }
  return copy(note);
}

function checked(input, { bounded = true } = {}) {
  const history = input == null ? createEmptyNoteHistory() : copy(input);
  if (!fields(history, ['version', 'revision', 'clock', 'notes']) || Object.keys(history).length !== 4 || history.version !== 1
    || !Number.isSafeInteger(history.revision) || history.revision < 0 || !Number.isSafeInteger(history.clock) || history.clock < 0
    || !object(history.notes) || Object.keys(history.notes).length > 12000) fail();
  const allIds = new Set();
  for (const [noteId, versions] of Object.entries(history.notes)) {
    if (!id(noteId) || !Array.isArray(versions) || !versions.length) fail();
    if (bounded && versions.length > NOTE_HISTORY_LIMITS.versions) fail('NOTE_HISTORY_CAPACITY');
    for (const version of versions) {
      if (!fields(version, ['id', 'n', 'capturedAt', 'record']) || Object.keys(version).length !== 4 || !id(version.id) || allIds.has(version.id)
        || !Number.isSafeInteger(version.n) || version.n < 1 || version.n > history.clock || !time(version.capturedAt)) fail();
      allIds.add(version.id); validateNoteHistoryRecord(version.record);
      if (version.record.id !== noteId) fail();
      if (bytes(version) > NOTE_HISTORY_LIMITS.versionBytes) fail('NOTE_HISTORY_CAPACITY');
    }
    if (bounded && bytes(versions) > NOTE_HISTORY_LIMITS.noteBytes) fail('NOTE_HISTORY_CAPACITY');
  }
  if (bounded && bytes(history) > NOTE_HISTORY_LIMITS.totalBytes) fail('NOTE_HISTORY_CAPACITY');
  return history;
}
export function validateNoteHistory(value) { return checked(value); }

export function pruneNoteHistory(input, { protectIds = [] } = {}) {
  const history = checked(input, { bounded: false }), protectedIds = new Set(protectIds), sizes = new Map();
  for (const versions of Object.values(history.notes)) for (const version of versions) sizes.set(version.id, bytes(version));
  const arrayBytes = (versions) => 2 + versions.reduce((sum, version) => sum + sizes.get(version.id), 0) + Math.max(0, versions.length - 1);
  for (const [noteId, versions] of Object.entries(history.notes)) {
    versions.sort(order);
    while (versions.length > NOTE_HISTORY_LIMITS.versions || arrayBytes(versions) > NOTE_HISTORY_LIMITS.noteBytes) {
      const remove = versions.findIndex((version) => !protectedIds.has(version.id));
      if (remove < 0) fail('NOTE_HISTORY_CAPACITY'); versions.splice(remove, 1);
    }
    if (!versions.length) delete history.notes[noteId];
  }
  const baseBytes = bytes({ ...history, notes: {} }) - 2;
  const totalBytes = () => {
    const entries = Object.entries(history.notes);
    return baseBytes + 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, [noteId, versions]) => sum + bytes(noteId) + 1 + arrayBytes(versions), 0);
  };
  const candidates = Object.entries(history.notes).flatMap(([noteId, versions]) => versions.filter((version) => !protectedIds.has(version.id)).map((version) => ({ noteId, version })))
    .sort((left, right) => left.version.n - right.version.n || compare(left.noteId, right.noteId) || compare(left.version.id, right.version.id));
  let cursor = 0;
  while (totalBytes() > NOTE_HISTORY_LIMITS.totalBytes) {
    const candidate = candidates[cursor++]; if (!candidate) fail('NOTE_HISTORY_CAPACITY');
    history.notes[candidate.noteId] = history.notes[candidate.noteId].filter((version) => version.id !== candidate.version.id);
    if (!history.notes[candidate.noteId].length) delete history.notes[candidate.noteId];
  }
  history.notes = Object.fromEntries(Object.entries(history.notes).sort(([left], [right]) => compare(left, right)));
  return validateNoteHistory(history);
}

export function captureNoteVersion(input, record, { now = () => Date.now(), uuid = () => globalThis.crypto.randomUUID(), protectIds = [] } = {}) {
  const history = validateNoteHistory(input), note = validateNoteHistoryRecord(record);
  if (history.clock >= Number.MAX_SAFE_INTEGER || history.revision >= Number.MAX_SAFE_INTEGER) fail('NOTE_HISTORY_CAPACITY');
  const version = { id: uuid(), n: history.clock + 1, capturedAt: now(), record: note };
  if (!id(version.id) || !time(version.capturedAt)) fail();
  history.clock = version.n; history.revision++;
  (history.notes[note.id] ||= []).push(version);
  return { history: pruneNoteHistory(history, { protectIds: [...protectIds, version.id] }), version: copy(version) };
}

export function mergeNoteHistories(leftInput, rightInput, { noteIds, protectIds = [] } = {}) {
  const left = validateNoteHistory(leftInput), right = validateNoteHistory(rightInput), selected = noteIds === undefined ? null : new Set(noteIds);
  const result = { version: 1, revision: Math.max(left.revision, right.revision), clock: Math.max(left.clock, right.clock), notes: copy(left.notes) };
  for (const [noteId, incoming] of Object.entries(right.notes)) {
    if (selected && !selected.has(noteId)) continue;
    const versions = new Map((result.notes[noteId] || []).map((version) => [version.id, version]));
    for (const version of incoming) {
      if (versions.has(version.id) && !equal(versions.get(version.id), version)) fail('NOTE_HISTORY_CONFLICT');
      versions.set(version.id, version);
    }
    result.notes[noteId] = [...versions.values()];
  }
  return pruneNoteHistory(result, { protectIds });
}
