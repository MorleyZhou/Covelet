import { tr, getLocale } from "../i18n/index.js";
import { normalizeUrl } from './model.js';
import { loadToolsCore } from './tools-core.js';
import { validateNoteDocument, noteDocumentText } from './note-document.js';

const demo = typeof document !== 'undefined' && import.meta.env?.DEV && new URLSearchParams(location.search).has('demo');
const KEY = demo ? 'covelet.tools.demo.v1' : 'covelet.tools.v1';
const native = () => !demo && Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.local);
const listeners = new Set(), encoder = new TextEncoder();
const empty = () => ({ version: 2, revision: 0, notes: [], reading: [], snapshots: [] });
const copy = (value) => structuredClone(value);
const fail = (message) => { throw Error(message); };
const text = (value, limit, label) => typeof value === 'string' && value.length <= limit && !value.includes('\0') ? value : fail(tr("{0}无效或过长。", [label]));
const identity = (value) => typeof value === 'string' && /^[a-z\d-]{1,100}$/i.test(value) ? value : fail(tr("记录标识无效。"));
const title = (value, fallback = tr("未命名")) => text(value, 200, tr("名称")).trim() || fallback;
function base(record) {
  identity(record?.id);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
    || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.createdAt || record.updatedAt > 8640000000000000) fail(tr("记录版本无效。"));
  title(record.title);
}
function check(input) {
  if (input === undefined || input === null) return empty();
  if (![1, 2].includes(input.version) || !Number.isSafeInteger(input.revision) || input.revision < 0 || Object.keys(input).some((key) => !['version', 'revision', 'notes', 'reading', 'snapshots'].includes(key))
    || !Array.isArray(input.notes) || input.notes.length > 200 || !Array.isArray(input.reading) || input.reading.length > 500
    || !Array.isArray(input.snapshots) || input.snapshots.length > 50) fail(tr("本机工具数据无效。"));
  const ids = new Set(); let tabs = 0;
  for (const record of [...input.notes, ...input.reading, ...input.snapshots]) { base(record); if (ids.has(record.id)) fail(tr("记录标识重复。")); ids.add(record.id); }
  for (const record of input.notes) {
    if (Object.keys(record).some((key) => !['id', 'revision', 'createdAt', 'updatedAt', 'title', 'body', 'pinned', 'document'].includes(key)) || typeof record.pinned !== 'boolean') fail(tr("便笺格式无效。"));
    text(record.body, 60000, tr("便笺"));
    if (Object.hasOwn(record, 'document')) {
      if (input.version !== 2) fail(tr("便笺格式无效。"));
      validateNoteDocument(record.document);
      if (noteDocumentText(record.document) !== record.body) fail(tr('便笺正文与文档不一致。'));
    }
  }
  const urls = new Set();
  for (const record of input.reading) {
    if (Object.keys(record).some((key) => !['id', 'revision', 'createdAt', 'updatedAt', 'title', 'url', 'status'].includes(key)) || !['unread', 'read', 'archived'].includes(record.status)
      || normalizeUrl(record.url) !== record.url || urls.has(record.url)) fail(tr("稍后读格式无效。"));
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
  if (tabs > 3000 || encoder.encode(JSON.stringify(input)).length > 4 * 1024 * 1024) fail(tr("本机工具存储已满，请先导出并清理旧记录。"));
  return { ...copy(input), version: 2 };
}
export async function loadPersonalTools() {
  if (native()) return check((await chrome.storage.local.get(KEY))[KEY]);
  try { const raw = localStorage.getItem(KEY); return check(raw ? JSON.parse(raw) : null); }
  catch (reason) { throw Error(reason.message || tr("无法读取本机工具数据。")); }
}
export function subscribePersonalTools(callback) {
  const receive = (value) => { try { callback(check(value)); } catch { /* Do not replace a valid visible record with corrupt data. */ } };
  listeners.add(receive);
  const change = (items, area) => { if (area === 'local' && items[KEY]) receive(items[KEY].newValue); };
  const storage = (event) => { if (event.key === KEY) loadPersonalTools().then(receive).catch(() => {}); };
  if (native()) chrome.storage.onChanged.addListener(change); else addEventListener('storage', storage);
  return () => { listeners.delete(receive); if (native()) chrome.storage.onChanged.removeListener(change); else removeEventListener('storage', storage); };
}
let queue = Promise.resolve();
async function mutate(update) {
  const run = async () => {
    const current = await loadPersonalTools(), next = copy(current);
    const result = await update(next);
    next.revision = current.revision + 1;
    const checked = check(next);
    try { if (native()) await chrome.storage.local.set({ [KEY]: checked }); else localStorage.setItem(KEY, JSON.stringify(checked)); }
    catch (reason) { throw Error(/quota|storage.*full/i.test(reason.message) ? tr("本机存储不足，请先导出并清理旧记录。") : tr("无法保存本机工具数据，请重试。")); }
    for (const listener of listeners) listener(checked);
    return copy(result);
  };
  if (navigator.locks?.request) return navigator.locks.request(KEY, run);
  if (native()) throw Error(tr("浏览器无法锁定本机数据，请关闭其他 Covelet 页面后重试。"));
  const pending = queue.then(run, run); queue = pending.catch(() => {}); return pending;
}
const recordFor = (collection, id, revision) => {
  const record = collection.find((item) => item.id === id);
  if (!record || record.revision !== revision) fail(tr("这条记录已在其他页面修改，请重新打开后再保存。"));
  return record;
};
const newRecord = (label) => ({ id: crypto.randomUUID(), revision: 1, createdAt: Date.now(), updatedAt: Date.now(), title: label });
export async function saveNote({ id, revision, title: name, body, document, pinned = false }) {
  if (document !== undefined) body = noteDocumentText(validateNoteDocument(document));
  const core = await loadToolsCore(); core.metrics(text(body, 60000, tr("便笺")));
  return mutate((data) => {
    const note = id ? recordFor(data.notes, id, revision) : newRecord(tr("未命名便笺"));
    if (note.document && document === undefined && note.body !== body) fail(tr('请使用富文本编辑器修改此便笺。'));
    Object.assign(note, { title: title(name, body.trim().split('\n')[0]?.slice(0, 80) || tr("未命名便笺")), body, pinned: Boolean(pinned), updatedAt: Math.max(Date.now(), note.updatedAt), revision: note.revision + (id ? 1 : 0) });
    if (document !== undefined) note.document = copy(document);
    if (!id) data.notes.push(note);
    return note;
  });
}
export function deletePersonalRecord(kind, id, revision) {
  if (!['notes', 'reading', 'snapshots'].includes(kind)) fail(tr("记录类型无效。"));
  return mutate((data) => { recordFor(data[kind], id, revision); data[kind] = data[kind].filter((item) => item.id !== id); return true; });
}
export function saveReadingItem({ id, revision, url, title: name, status = 'unread' }) {
  const address = normalizeUrl(url);
  return mutate((data) => {
    const existing = data.reading.find((item) => item.url === address && item.id !== id);
    if (existing) fail(tr("这个链接已在稍后读中。"));
    const record = id ? recordFor(data.reading, id, revision) : newRecord('');
    Object.assign(record, { title: title(name, new URL(address).hostname), url: address, status, updatedAt: Math.max(Date.now(), record.updatedAt), revision: record.revision + (id ? 1 : 0) });
    if (!id) data.reading.push(record);
    return record;
  });
}
export async function importBrowserReadingList() {
  if (!native() || !await chrome.permissions.request({ permissions: ['readingList'] }) || !chrome.readingList) fail(tr("请在扩展中允许访问阅读清单。"));
  const items = await chrome.readingList.query({});
  if (!Array.isArray(items) || items.length > 500) fail(tr("浏览器阅读清单超过 500 条，请先整理后再导入。"));
  return mutate((data) => {
    const seen = new Set(data.reading.map((item) => item.url)); let count = 0;
    for (const item of items) {
      let url; try { url = normalizeUrl(item.url); } catch { continue; }
      if (seen.has(url)) continue;
      data.reading.push({ ...newRecord(title((item.title || '').slice(0, 200), new URL(url).hostname)), url, status: item.hasBeenRead ? 'read' : 'unread' });
      seen.add(url); count++;
    }
    return count;
  });
}
export async function captureTabSnapshot(name) {
  // The permission request stays in this explicit button gesture. No tab query
  // happens on new-tab startup, installation, a timer, or in the background.
  if (!native() || !await chrome.permissions.request({ permissions: ['tabs'] })) fail(tr("请在扩展中允许读取标签页。"));
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const candidates = tabs.filter((tab) => !tab.incognito).sort((a, b) => a.index - b.index).flatMap((tab) => {
    try { return [{ url: normalizeUrl(tab.url), title: (tab.title || '').slice(0, 200), pinned: Boolean(tab.pinned) }]; } catch { return []; }
  });
  if (!candidates.length) fail(tr("当前窗口没有可保存的普通网页。"));
  if (candidates.length > 1000) fail(tr("单次最多保存 1000 个标签。"));
  const core = await loadToolsCore(), unique = core.unique(candidates.map((tab) => tab.url)).map((index) => candidates[index]);
  return mutate((data) => { const record = { ...newRecord(title(name, new Date().toLocaleString(getLocale()))), tabs: unique }; data.snapshots.push(record); return record; });
}
export function renameTabSnapshot(id, revision, name) {
  return mutate((data) => { const record = recordFor(data.snapshots, id, revision); record.title = title(name); record.updatedAt = Math.max(Date.now(), record.updatedAt); record.revision++; return record; });
}
export async function restoreTabSnapshot(id, revision, indices) {
  const data = await loadPersonalTools(), record = recordFor(data.snapshots, id, revision);
  if (!Array.isArray(indices) || !indices.length || indices.length > 50 || new Set(indices).size !== indices.length
    || indices.some((index) => !Number.isInteger(index) || index < 0 || index >= record.tabs.length)) fail(tr("一次请选择 1 至 50 个标签。"));
  if (!native() || !chrome.tabs?.create) fail(tr("请在浏览器扩展中恢复标签快照。"));
  // Open a separate window to avoid displacing the current session. Do not
  // navigate existing tabs, close tabs, or follow non-HTTP(S) saved addresses.
  const first = record.tabs[indices[0]], window = await chrome.windows.create({ url: normalizeUrl(first.url), focused: true, incognito: false });
  let opened = 1;
  try {
    if (first.pinned && window.tabs?.[0]?.id) await chrome.tabs.update(window.tabs[0].id, { pinned: true });
    for (const index of indices.slice(1)) { const tab = record.tabs[index]; await chrome.tabs.create({ windowId: window.id, url: normalizeUrl(tab.url), pinned: tab.pinned, active: false }); opened++; }
  } catch { fail(tr("已打开 {0} 个标签，其余标签未打开。快照仍然保留。", [opened])); }
  return opened;
}
export async function exportPersonalTools() {
  const data = await loadPersonalTools();
  return new Blob([JSON.stringify({ format: 'covelet-personal-tools', version: 2, exportedAt: new Date().toISOString(), data })], { type: 'application/json' });
}
export async function importPersonalTools(file) {
  if (!(file instanceof Blob) || file.size > 5 * 1024 * 1024) fail(tr("工具备份文件过大。"));
  let envelope; try { envelope = JSON.parse(await file.text()); } catch { fail(tr("工具备份无法读取。")); }
  if (envelope?.format !== 'covelet-personal-tools' || ![1, 2].includes(envelope.version) || !envelope.data || typeof envelope.data !== 'object'
    || envelope.data.version !== envelope.version) fail(tr("工具备份格式不支持。"));
  const incoming = check(envelope.data);
  return mutate((data) => {
    let count = 0;
    // Merge only new IDs. Existing local edits always win; never silently replace.
    const ids = new Set([...data.notes, ...data.reading, ...data.snapshots].map((item) => item.id)), urls = new Set(data.reading.map((item) => item.url));
    for (const kind of ['notes', 'reading', 'snapshots']) for (const record of incoming[kind]) {
      if (ids.has(record.id) || kind === 'reading' && urls.has(record.url)) continue;
      data[kind].push(copy(record)); ids.add(record.id); if (kind === 'reading') urls.add(record.url); count++;
    }
    return count;
  });
}
