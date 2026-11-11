import { tr } from "../i18n/index.js";
import { normalizeUrl } from './model.js';
import { validateNoteDocument, noteDocumentText } from './note-document.js';
import { sameJson } from './json-equal.js';
import { localData } from './local-data.js';
import { withNavigationPrivacy, loadContentPreferences, validateContentPreferences, contentPreferencesForKeys } from './content-preferences.js';
import { userErrorMessage } from './user-error.js';

const loadToolsCore = () => import('./tools-core.js').then((module) => module.loadToolsCore());

const demo = typeof document !== 'undefined' && import.meta.env?.DEV && new URLSearchParams(location.search).has('demo');
const KEY = demo ? 'covelet.tools.demo.v1' : 'covelet.tools.v1';
const native = () => !demo && Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.local);
const listeners = new Set(), encoder = new TextEncoder();
export const PERSONAL_TRASH_LIMITS = Object.freeze({ retentionDays: 30, maxRecords: 200, maxBytes: 4 * 1024 * 1024 });
// Historical collections remain validated/exportable, without capture or restore actions.
const kinds = ['notes', 'reading', 'snapshots'];
const activeKinds = ['notes', 'reading'];
const retention = PERSONAL_TRASH_LIMITS.retentionDays * 86400000;
const empty = () => ({ version: 3, revision: 0, notes: [], reading: [], snapshots: [], trash: [] });
const copy = (value) => structuredClone(value);
const fail = (message) => { throw Error(message); };
const text = (value, limit, label) => typeof value === 'string' && value.length <= limit && !value.includes('\0') ? value : fail(tr("{0}无法保存，请检查内容或缩短后重试。", [label]));
const identity = (value) => typeof value === 'string' && /^[a-z\d-]{1,100}$/i.test(value) ? value : fail(tr("这条内容无法读取，请从备份恢复。"));
const title = (value, fallback = tr("未命名")) => text(value, 200, tr("名称")).trim() || fallback;
function base(record) {
  identity(record?.id);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
    || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.createdAt || record.updatedAt > 8640000000000000) fail(tr("这条内容无法读取，请从备份恢复。"));
  title(record.title);
}
function checkCollections(input) {
  if (![1, 2, 3].includes(input.version) || !Number.isSafeInteger(input.revision) || input.revision < 0
    || !Array.isArray(input.notes) || input.notes.length > 200 || !Array.isArray(input.reading) || input.reading.length > 500
    || !Array.isArray(input.snapshots) || input.snapshots.length > 50) fail(tr("便笺和稍后读数据无法读取，请从备份恢复。"));
  const ids = new Set(); let tabs = 0;
  for (const record of [...input.notes, ...input.reading, ...input.snapshots]) { base(record); if (ids.has(record.id)) fail(tr("存在重复内容，无法继续。")); ids.add(record.id); }
  for (const record of input.notes) {
    if (Object.keys(record).some((key) => !['id', 'revision', 'createdAt', 'updatedAt', 'title', 'body', 'pinned', 'document'].includes(key)) || typeof record.pinned !== 'boolean') fail(tr("这条便笺无法读取，请从备份恢复。"));
    text(record.body, 60000, tr("便笺"));
    if (Object.hasOwn(record, 'document')) {
      if (input.version === 1) fail(tr("这条便笺无法读取，请从备份恢复。"));
      validateNoteDocument(record.document);
      if (noteDocumentText(record.document) !== record.body) fail(tr('这条便笺无法读取，请从备份恢复。'));
    }
  }
  const urls = new Set();
  for (const record of input.reading) {
    if (Object.keys(record).some((key) => !['id', 'revision', 'createdAt', 'updatedAt', 'title', 'url', 'status'].includes(key)) || !['unread', 'read', 'archived'].includes(record.status)
      || normalizeUrl(record.url) !== record.url || urls.has(record.url)) fail(tr("这个稍后读链接无法读取，请从备份恢复。"));
    urls.add(record.url);
  }
  for (const record of input.snapshots) {
    if (Object.keys(record).some((key) => !['id', 'revision', 'createdAt', 'updatedAt', 'title', 'tabs'].includes(key)) || !Array.isArray(record.tabs) || !record.tabs.length || record.tabs.length > 1000) fail(tr("标签快照格式无效。"));
    tabs += record.tabs.length;
    for (const tab of record.tabs) {
      if (!tab || Object.keys(tab).some((key) => !['url', 'title', 'pinned'].includes(key)) || normalizeUrl(tab.url) !== tab.url || typeof tab.pinned !== 'boolean') fail(tr("标签快照链接无效。"));
      text(tab.title, 200, tr("标签名称"));
    }
  }
  if (tabs > 3000) fail(tr("存储空间已满，请先备份，再清理便笺、稍后读或回收站。"));
}
export function validatePersonalTools(input) {
  if (input === undefined || input === null) return empty();
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['version', 'revision', ...kinds, 'trash'].includes(key))) fail(tr("便笺和稍后读数据无法读取，请从备份恢复。"));
  checkCollections(input);
  const trash = input.version === 3 ? input.trash : [];
  if (input.version !== 3 && Object.hasOwn(input, 'trash') || !Array.isArray(trash) || trash.length > PERSONAL_TRASH_LIMITS.maxRecords) fail(tr('回收站内容无法读取，请从备份恢复。'));
  const trashIds = new Set();
  for (const item of trash) {
    if (!item || typeof item !== 'object' || Object.keys(item).some((key) => !['id', 'kind', 'deletedAt', 'record'].includes(key))
      || !kinds.includes(item.kind) || !Number.isSafeInteger(item.deletedAt) || item.deletedAt < 0 || item.deletedAt > 8640000000000000) fail(tr('回收站内容无法读取，请从备份恢复。'));
    identity(item.id);
    if (trashIds.has(item.id)) fail(tr('存在重复内容，无法继续。'));
    trashIds.add(item.id);
    checkCollections({ version: 3, revision: 0, notes: [], reading: [], snapshots: [], [item.kind]: [item.record] });
  }
  const checked = { ...copy(input), version: 3, trash: copy(trash) };
  if (encoder.encode(JSON.stringify(checked)).length > PERSONAL_TRASH_LIMITS.maxBytes) fail(tr("存储空间已满，请先备份，再清理便笺、稍后读或回收站。"));
  return checked;
}
const check = validatePersonalTools;
function pruneTrash(data) {
  const cutoff = Date.now() - retention;
  data.trash = data.trash.filter((item) => item.deletedAt > cutoff);
  return data;
}
async function readPersonalTools() {
  try { return check((await localData.get(KEY))[KEY]); }
  catch (reason) { throw Error(userErrorMessage(reason, tr("无法读取便笺和稍后读，请重试。"))); }
}
export async function loadPersonalTools() {
  const data = await readPersonalTools();
  // Expiry is a locked local write so backups and other pages agree on what
  // remains recoverable. Merely rendering a trash list never deletes a record.
  if (data.trash.some((item) => item.deletedAt <= Date.now() - retention)) return mutate((next) => next);
  return data;
}
export function subscribePersonalTools(callback) {
  const receive = (value) => { try { callback(check(value)); } catch { /* Do not replace a valid visible record with corrupt data. */ } };
  listeners.add(receive);
  const off = localData.subscribe((items) => { if (items[KEY]) receive(items[KEY].newValue); });
  return () => { listeners.delete(receive); off(); };
}
let queue = Promise.resolve();
async function mutate(update, { expectedRevision, extraRecords } = {}) {
  const run = async () => {
    const current = await readPersonalTools();
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision)) {
      const error = Error(tr('内容已在其他页面更新，请重新打开后重试。')); error.code = 'REVISION_CONFLICT'; throw error;
    }
    const next = pruneTrash(copy(current));
    const result = await update(next);
    next.revision = current.revision + 1;
    const checked = check(next);
    const additional = extraRecords ? extraRecords(result) : {};
    try { await localData.set({ [KEY]: checked, ...additional }); }
    catch (reason) { throw Error(/quota|storage.*full/i.test(reason.message) ? tr("存储空间已满，请先备份，再清理便笺、稍后读或回收站。") : userErrorMessage(reason, tr("内容未能保存，请重试。"))); }
    for (const listener of listeners) listener(checked);
    return copy(result);
  };
  if (navigator.locks?.request) return navigator.locks.request(KEY, run);
  if (native()) throw Error(tr("内容未能保存，请重试。"));
  const pending = queue.then(run, run); queue = pending.catch(() => {}); return pending;
}
const recordFor = (collection, id, revision) => {
  const record = collection.find((item) => item.id === id);
  if (!record || record.revision !== revision) fail(tr("这条记录已在其他页面修改，请重新打开后再保存。"));
  return record;
};
// The caller already holds the navigation and preference locks, in sync order.
export function withReadingRecord(id, revision, action) {
  if (!globalThis.navigator?.locks?.request) throw Error(tr('内容未能保存，请重试。'));
  return navigator.locks.request(KEY, async () => action(recordFor((await readPersonalTools()).reading, id, revision)));
}
const newRecord = (label) => ({ id: crypto.randomUUID(), revision: 1, createdAt: Date.now(), updatedAt: Date.now(), title: label });
function moveToTrash(data, kind, record) {
  if (data.trash.length >= PERSONAL_TRASH_LIMITS.maxRecords) fail(tr('回收站已满，请先备份或清理回收站。'));
  data.trash.push({ id: crypto.randomUUID(), kind, deletedAt: Date.now(), record: copy(record) });
}
function protectOpenEditors(current, incoming) {
  const previous = new Map(kinds.flatMap((kind) => current[kind]).map((record) => [record.id, record]));
  const deletedRevisions = new Map();
  for (const item of current.trash) deletedRevisions.set(item.record.id, Math.max(deletedRevisions.get(item.record.id) || 0, item.record.revision));
  for (const kind of kinds) for (const record of incoming[kind]) {
    const old = previous.get(record.id);
    if (!old) { if (deletedRevisions.has(record.id)) record.revision = Math.max(deletedRevisions.get(record.id) + 1, record.revision); continue; }
    const { revision: oldRevision, ...oldContent } = old, { revision: incomingRevision, ...newContent } = record;
    record.revision = sameJson(oldContent, newContent) ? oldRevision : Math.max(oldRevision + 1, incomingRevision);
  }
}
// Complete backups use these APIs instead of writing storage directly. They
// share the same lock and revision guards as the note editor and popup.
export function replacePersonalTools(input, options = {}) {
  const incoming = check(input);
  return mutate((data) => {
    protectOpenEditors(data, incoming);
    for (const kind of [...kinds, 'trash']) data[kind] = copy(incoming[kind]);
    pruneTrash(data);
    return data;
  }, options);
}
export function mergePersonalTools(input, options = {}) {
  const incoming = check(input);
  return mutate((data) => {
    const ids = new Set(kinds.flatMap((kind) => data[kind]).map((item) => item.id)), urls = new Set(data.reading.map((item) => item.url));
    for (const kind of activeKinds) for (const record of incoming[kind]) {
      if (ids.has(record.id) || kind === 'reading' && urls.has(record.url)) continue;
      data[kind].push(copy(record)); ids.add(record.id); if (kind === 'reading') urls.add(record.url);
    }
    const trashIds = new Set(data.trash.map((item) => item.id));
    for (const item of incoming.trash) if (activeKinds.includes(item.kind) && !trashIds.has(item.id) && item.deletedAt > Date.now() - retention) { data.trash.push(copy(item)); trashIds.add(item.id); }
    return data;
  }, options);
}
export function applySyncedPersonalTools({ notes, reading }, options = {}) {
  const incoming = check({ ...empty(), notes, reading });
  return mutate((data) => {
    protectOpenEditors(data, incoming);
    for (const kind of ['notes', 'reading']) {
      const ids = new Set(incoming[kind].map((record) => record.id));
      for (const record of data[kind]) if (!ids.has(record.id)) moveToTrash(data, kind, record);
      data[kind] = copy(incoming[kind]);
    }
    return data;
  }, options);
}
function saveContentRecord(kind, update, { metadata, expectedPreferencesRevision, expectedMetadata } = {}) {
  if (metadata === undefined) return mutate(update);
  return withNavigationPrivacy((_preferences, prepare) => mutate(update, {
    extraRecords: (record) => prepare([], { metadata: [{ ...metadata, key: `${kind}:${record.id}`, expectedMetadata }], expectedRevision: expectedPreferencesRevision }),
  }));
}
export async function saveNote({ id, revision, title: name, body, document, pinned = false }, options = {}) {
  if (document !== undefined) body = noteDocumentText(validateNoteDocument(document));
  const core = await loadToolsCore(); core.metrics(text(body, 60000, tr("便笺")));
  return saveContentRecord('note', (data) => {
    const note = id ? recordFor(data.notes, id, revision) : newRecord(tr("未命名便笺"));
    if (note.document && document === undefined && note.body !== body) fail(tr('请使用富文本编辑器修改此便笺。'));
    Object.assign(note, { title: title(name, body.trim().split('\n')[0]?.slice(0, 80) || tr("未命名便笺")), body, pinned: Boolean(pinned), updatedAt: Math.max(Date.now(), note.updatedAt), revision: note.revision + (id ? 1 : 0) });
    if (document !== undefined) note.document = copy(document);
    if (!id) data.notes.push(note);
    return note;
  }, options);
}
export function deletePersonalRecord(kind, id, revision) {
  if (!activeKinds.includes(kind)) fail(tr("记录类型无效。"));
  return mutate((data) => { moveToTrash(data, kind, recordFor(data[kind], id, revision)); data[kind] = data[kind].filter((item) => item.id !== id); return true; });
}
export function restoreTrashedPersonalRecord(trashId, options = {}) {
  return mutate((data) => {
    const item = data.trash.find((record) => record.id === trashId);
    if (!item || !activeKinds.includes(item.kind)) fail(tr('这条回收站记录已移除或过期。'));
    if (kinds.some((kind) => data[kind].some((record) => record.id === item.record.id))) fail(tr('这条内容已存在，未覆盖现有内容。'));
    if (item.kind === 'reading' && data.reading.some((record) => record.url === item.record.url)) fail(tr('这个链接已在稍后读中。'));
    const revision = Math.max(...data.trash.filter((entry) => entry.record.id === item.record.id).map((entry) => entry.record.revision)) + 1;
    const restored = { ...copy(item.record), revision, updatedAt: Math.max(Date.now(), item.record.updatedAt) };
    data[item.kind].push(restored); data.trash = data.trash.filter((record) => record.id !== trashId);
    return restored;
  }, options);
}
export function permanentlyDeletePersonalTrash(trashId, options = {}) {
  return mutate((data) => {
    if (!data.trash.some((item) => item.id === trashId)) fail(tr('这条回收站记录已移除或过期。'));
    data.trash = data.trash.filter((item) => item.id !== trashId); return true;
  }, options);
}
export function emptyPersonalTrash({ expectedRevision, ids } = {}) {
  let selected = null;
  if (ids !== undefined) {
    if (!Array.isArray(ids) || ids.length > PERSONAL_TRASH_LIMITS.maxRecords) fail(tr('回收站内容无法读取，请从备份恢复。'));
    selected = new Set(ids.map(identity));
    if (selected.size !== ids.length) fail(tr('存在重复内容，无法继续。'));
    if (expectedRevision === undefined) {
      const error = Error(tr('内容已在其他页面更新，请重新打开后重试。')); error.code = 'REVISION_CONFLICT'; throw error;
    }
  }
  return mutate((data) => {
    if (selected === null) { const count = data.trash.length; data.trash = []; return count; }
    const count = data.trash.filter((item) => selected.has(item.id)).length;
    if (count !== selected.size) fail(tr('这条回收站记录已移除或过期。'));
    data.trash = data.trash.filter((item) => !selected.has(item.id));
    return count;
  }, { expectedRevision });
}
export function saveReadingItem({ id, revision, url, title: name, status = 'unread' }, options = {}) {
  const address = normalizeUrl(url);
  return saveContentRecord('reading', (data) => {
    const existing = data.reading.find((item) => item.url === address && item.id !== id);
    if (existing) fail(tr("这个链接已在稍后读中。"));
    const record = id ? recordFor(data.reading, id, revision) : newRecord('');
    Object.assign(record, { title: title(name, new URL(address).hostname), url: address, status, updatedAt: Math.max(Date.now(), record.updatedAt), revision: record.revision + (id ? 1 : 0) });
    if (!id) data.reading.push(record);
    return record;
  }, options);
}
// Historical snapshot records remain valid for backup compatibility only.
// A+ has no browser Reading List import or tab-snapshot runtime.
export async function exportPersonalTools() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await loadPersonalTools(), preferences = await loadContentPreferences();
    if ((await readPersonalTools()).revision !== data.revision || (await loadContentPreferences()).revision !== preferences.revision) continue;
    const portable = contentPreferencesForKeys(preferences, personalContentKeys(data));
    const hasPreferences = Boolean(portable.library || Object.keys(portable.aliases).length || portable.privateKeys.length);
    const file = new Blob([JSON.stringify({ format: 'covelet-personal-tools', version: hasPreferences ? 4 : 3, exportedAt: new Date().toISOString(), data,
      ...(hasPreferences ? { preferences: portable } : {}) })], { type: 'application/json' });
    if (file.size > 5 * 1024 * 1024) fail(tr('工具备份文件过大。'));
    return file;
  }
  throw Object.assign(Error(tr('内容已在其他页面更新，请重新打开后重试。')), { code: 'REVISION_CONFLICT' });
}
export function personalContentKeys(data, selected = ['notes', 'reading', 'trash']) {
  return [...selected.flatMap((kind) => kind === 'notes' ? data.notes.map((item) => `note:${item.id}`)
    : kind === 'reading' ? data.reading.map((item) => `reading:${item.id}`)
      : kind === 'trash' ? data.trash.filter((item) => activeKinds.includes(item.kind)).map((item) => `${item.kind === 'notes' ? 'note' : 'reading'}:${item.record.id}`) : [])];
}
export function inspectPersonalToolsBackup(envelope) {
  if (envelope?.format !== 'covelet-personal-tools' || ![1, 2, 3, 4].includes(envelope.version) || !envelope.data || typeof envelope.data !== 'object'
    || envelope.data.version !== (envelope.version === 4 ? 3 : envelope.version)) fail(tr('工具备份格式不支持。'));
  const data = check(envelope.data);
  if (envelope.version !== 4) return { data, preferences: null };
  if (Object.keys(envelope).some((key) => !['format', 'version', 'exportedAt', 'data', 'preferences'].includes(key)) || !envelope.preferences) fail(tr('工具备份格式不支持。'));
  const preferences = validateContentPreferences(envelope.preferences), keys = new Set(personalContentKeys(data));
  if ([...Object.keys(preferences.aliases), ...preferences.privateKeys, ...Object.keys(preferences.library?.items || {})].some((key) => !keys.has(key))) fail(tr('工具备份格式不支持。'));
  return { data, preferences: contentPreferencesForKeys(preferences, keys) };
}
export async function importPersonalTools(file) {
  if (!(file instanceof Blob) || file.size > 5 * 1024 * 1024) fail(tr("工具备份文件过大。"));
  let envelope; try { envelope = JSON.parse(await file.text()); } catch { fail(tr("工具备份无法读取。")); }
  const parsed = inspectPersonalToolsBackup(envelope), incoming = parsed.data;
  const addedKeys = [];
  const update = (data) => {
    let count = 0;
    // Merge only new IDs. Existing local edits always win; never silently replace.
    const ids = new Set([...data.notes, ...data.reading, ...data.snapshots].map((item) => item.id)), urls = new Set(data.reading.map((item) => item.url));
    for (const kind of activeKinds) for (const record of incoming[kind]) {
      if (ids.has(record.id) || kind === 'reading' && urls.has(record.url)) continue;
      data[kind].push(copy(record)); ids.add(record.id); if (kind === 'reading') urls.add(record.url); count++;
      addedKeys.push(`${kind === 'notes' ? 'note' : 'reading'}:${record.id}`);
    }
    const trashIds = new Set(data.trash.map((item) => item.id));
    const knownRecordIds = new Set([...ids, ...data.trash.map((item) => item.record.id)]);
    for (const item of incoming.trash) if (activeKinds.includes(item.kind) && !trashIds.has(item.id) && item.deletedAt > Date.now() - retention) {
      data.trash.push(copy(item)); trashIds.add(item.id); count++;
      if (!knownRecordIds.has(item.record.id)) addedKeys.push(`${item.kind === 'notes' ? 'note' : 'reading'}:${item.record.id}`);
    }
    return count;
  };
  if (!parsed.preferences) return mutate(update);
  return withNavigationPrivacy((_preferences, prepare) => mutate(update, { extraRecords: () => prepare([], {
    appendPreferences: contentPreferencesForKeys(parsed.preferences, addedKeys),
  }) }));
}
