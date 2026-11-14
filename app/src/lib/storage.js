import { tr, getLocale } from "../i18n/index.js";
import { Inflate, zipSync, strToU8 } from 'fflate';
import { createEmptyState, createInitialState, validateState, migrateNavigationState } from './model.js';
import { localData, createEncryptedStore } from './local-data.js';
import { migrateLegacyIndexedDb } from './legacy-indexed-data.js';
import { normalizeIconAddress, siteIconAddress } from './site-icons.js';
import { readNavigationIconResource, restoreNavigationIconResource, retainNavigationIconResources } from './navigation-icon-cache.js';
import { prepareImportedNavigationIcons } from './navigation-icon-intake.js';
import { ICON_IMAGE_LIMIT } from './icon-image-format.js';
import { withNavigationPrivacy, validateContentPreferences } from './content-preferences.js';
import { sameJson } from './json-equal.js';
import { navigationResourceEntries, remapNavigationAssets } from './navigation-resources.js';
import { prepareNavigationDeletion, removeTrashMetadata } from './navigation-trash-core.js';
import { privateContentKeys } from './presentation.js';
import { loadPersonalToolsSnapshot, preparePersonalToolsRestore } from './personal-tools.js';
import { remapWidgetContentReferences } from './referenced-widgets.js';
import { widgetContentReference } from './widget-model.js';

const STORE_KEY = 'owntab.local.v1';
const LOCK_NAME = 'owntab.local.write.v1';
const MiB = 1024 * 1024;
const LIMITS = { archive: 30 * MiB, expanded: 80 * MiB, image: 10 * MiB, icon: ICON_IMAGE_LIMIT, json: 2 * MiB, entries: 14002, pixels: 40_000_000 };
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(message, code = 'INVALID_BACKUP') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function clone(value) { return structuredClone(value); }
function checkedState(value) { return validateState(clone(value)); }
function assetReferences(state) {
  const ids = new Set();
  if (state.settings.background.kind === 'image') ids.add(state.settings.background.value);
  for (const entry of navigationResourceEntries(state)) if (entry.icon?.kind === 'image') ids.add(entry.icon.value);
  return ids;
}
function iconReferences(state) {
  return new Set(navigationResourceEntries(state).filter((entry) => entry.type === 'site' && entry.icon?.kind !== 'image').flatMap((entry) => [
    siteIconAddress(entry), entry.iconVariants?.light?.url, entry.iconVariants?.dark?.url,
  ]).filter(Boolean).map(normalizeIconAddress));
}

async function verifyIconResource(record, tools) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).some((key) => !['url', 'blob', 'darkBlob', 'width', 'height', 'vector', 'adaptive', 'updatedAt'].includes(key))
    || normalizeIconAddress(record.url) !== record.url || !Number.isInteger(record.width) || !Number.isInteger(record.height)
    || record.width < 1 || record.height < 1 || record.width > 4096 || record.height > 4096 || record.width * record.height > 4_000_000
    || typeof record.vector !== 'boolean' || typeof record.adaptive !== 'boolean' || !Number.isFinite(record.updatedAt) || record.updatedAt < 0
    || (!record.adaptive && record.darkBlob !== undefined)) fail(tr('图标文件无法读取。'));
  const result = [];
  for (const blob of [record.blob, ...(record.adaptive ? [record.darkBlob] : [])]) {
    if (!(blob instanceof Blob) || blob.size > LIMITS.icon) fail(tr('图标文件无法读取。'));
    const bytes = await verifyImage(blob, tools), header = imageHeader(bytes, blob.type);
    if (!((header.width === record.width && header.height === record.height)
      || (header.width === record.height && header.height === record.width))) fail(tr('图片尺寸信息不一致。'));
    result.push(bytes);
  }
  return result;
}

function remapAssets(state, ids) {
  return remapNavigationAssets(state, ids);
}

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

function imageHeader(bytes, mime) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let actual;
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length >= 33 && bytes[0] === 137 && ascii(1, 7) === 'PNG\r\n\x1a\n' && ascii(12, 4) === 'IHDR') {
    actual = 'image/png';
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216) {
    actual = 'image/jpeg';
    for (let offset = 2; offset + 3 < bytes.length;) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    actual = 'image/webp';
    const type = ascii(12, 4);
    if (type === 'VP8X') {
      if (bytes[20] & 2) fail(tr("暂不支持动画 WebP 图片。"), 'INVALID_IMAGE');
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (type === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = view.getUint16(26, true) & 16383;
      height = view.getUint16(28, true) & 16383;
    } else if (type === 'VP8L' && bytes[20] === 47) {
      width = 1 + ((bytes[21] | (bytes[22] << 8)) & 16383);
      height = 1 + (((bytes[22] >> 6) | (bytes[23] << 2) | (bytes[24] << 10)) & 16383);
    }
  }
  if (!actual || actual !== mime || !width || !height || width * height > LIMITS.pixels) {
    fail(tr("图片格式或尺寸无效；仅支持 PNG、JPEG、WebP，最多 4000 万像素。"), 'INVALID_IMAGE');
  }
  return { width, height, mime: actual };
}

async function decodeImage(blob) {
  if (typeof globalThis.createImageBitmap === 'function') return globalThis.createImageBitmap(blob);
  if (!globalThis.Image) fail(tr("当前环境无法解码图片。"), 'INVALID_IMAGE');
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally { URL.revokeObjectURL(url); }
}

const browserImages = {
  async validate(blob) {
    const image = await decodeImage(blob);
    try {
      if (!image.width || !image.height || image.width * image.height > LIMITS.pixels) fail(tr("图片尺寸超出限制。"), 'INVALID_IMAGE');
      return { width: image.width, height: image.height };
    } finally { image.close?.(); }
  },
  async resize(blob, maxEdge) {
    const image = await decodeImage(blob);
    try {
      const ratio = Math.min(1, maxEdge / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * ratio));
      const height = Math.max(1, Math.round(image.height * ratio));
      const canvas = globalThis.OffscreenCanvas ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
      const context = canvas.getContext('2d');
      if (!context) fail(tr("当前环境无法处理图片。"), 'INVALID_IMAGE');
      context.drawImage(image, 0, 0, width, height);
      if (canvas.convertToBlob) return await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
      return await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error(tr("图片保存失败。"))), 'image/webp', 0.9));
    } finally { image.close?.(); }
  },
};

async function verifyImage(blob, tools) {
  if (!(blob instanceof Blob) || !MIME_EXT[blob.type] || !blob.size || blob.size > LIMITS.image) fail(tr("图片必须为 10 MiB 以内的 PNG、JPEG 或 WebP。"), 'INVALID_IMAGE');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const header = imageHeader(bytes, blob.type);
  const decoded = await tools.validate(blob);
  // JPEG EXIF orientation can swap width/height when the browser decodes it.
  if (!((decoded.width === header.width && decoded.height === header.height)
    || (decoded.width === header.height && decoded.height === header.width))) fail(tr("图片尺寸信息不一致。"), 'INVALID_IMAGE');
  return bytes;
}

function extensionPage() { return ['chrome-extension:', 'moz-extension:'].includes(globalThis.location?.protocol); }

function browserConfig() {
  const listeners = new Set();
  const notify = (value) => { for (const listener of listeners) listener(value?.state ? clone(value.state) : null); };
  let stopExternal;
  return {
    requireLocks: Boolean(globalThis.chrome?.runtime?.id) || extensionPage(),
    async read() {
      return (await localData.get(STORE_KEY))[STORE_KEY] ?? null;
    },
    async write(envelope, preferences) {
      await localData.set({ [STORE_KEY]: envelope, ...preferences });
    },
    subscribe(callback) {
      listeners.add(callback);
      if (!stopExternal) {
        stopExternal = localData.subscribe((changes) => { if (changes[STORE_KEY]) notify(changes[STORE_KEY].newValue); });
      }
      return () => {
        listeners.delete(callback);
        if (!listeners.size) { stopExternal?.(); stopExternal = undefined; }
      };
    },
  };
}

function encryptedAssets() {
  const records = createEncryptedStore('assets');
  const ready = () => migrateLegacyIndexedDb('owntab-assets', 'assets', records, (record) => record.id);
  const mutate = (action) => globalThis.navigator?.locks?.request
    ? navigator.locks.request('covelet.assets.write.v1', action) : action();
  return {
    async get(id) { await ready(); return records.get(id); },
    async add(record) {
      await ready();
      return mutate(async () => {
        const existing = await records.get(record.id);
        if (existing !== undefined && existing !== null) throw new DOMException('Key already exists in the object store.', 'ConstraintError');
        await records.set(record.id, record);
      });
    },
    async delete(id) { await ready(); return mutate(() => records.remove(id)); },
  };
}

// Validate the central directory before inflation; never trust names or declared sizes.
function zipDirectory(bytes) {
  if (bytes.length < 22 || bytes.length > LIMITS.archive) fail(tr("备份文件必须在 30 MiB 以内。"));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at) => view.getUint16(at, true);
  const u32 = (at) => view.getUint32(at, true);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50) end--;
  if (end < 0 || u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length) fail(tr("备份 ZIP 目录损坏。"));
  const count = u16(end + 10);
  const directorySize = u32(end + 12);
  const directoryStart = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || count < 2 || count > LIMITS.entries || directoryStart + directorySize !== end) fail(tr("不支持分卷、ZIP64 或超出限制的备份。"));
  const entries = [];
  const names = new Set();
  let offset = directoryStart;
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) fail(tr("ZIP 条目目录损坏。"));
    const flags = u16(offset + 8);
    const method = u16(offset + 10);
    const crc = u32(offset + 16);
    const compressed = u32(offset + 20);
    const original = u32(offset + 24);
    const nameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const local = u32(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > end) fail(tr("ZIP 条目越界。"));
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!/^(manifest\.json|data\.json|(?:assets|icons)\/[A-Za-z0-9_-]{1,80}\.(png|jpg|webp))$/.test(name) || names.has(name)) fail(tr("备份包含未知、重复或不安全的文件路径。"));
    if ((flags & ~0x0808) || ![0, 8].includes(method) || u16(offset + 34) || (u32(offset + 38) >>> 16 & 0xf000) === 0xa000) fail(tr("备份包含不支持的 ZIP 条目。"));
    const limit = name.startsWith('assets/') ? LIMITS.image : name.startsWith('icons/') ? LIMITS.icon : LIMITS.json;
    if (!original || original > limit || compressed > LIMITS.archive || (method === 0 && compressed !== original)) fail(tr("备份条目超出大小限制。"));
    expanded += original;
    if (expanded > LIMITS.expanded) fail(tr("备份解压后超过 80 MiB。"));
    if (local + 30 > directoryStart || u32(local) !== 0x04034b50 || u16(local + 6) !== flags || u16(local + 8) !== method) fail(tr("ZIP 本地文件头无效。"));
    const localNameLength = u16(local + 26);
    const dataStart = local + 30 + localNameLength + u16(local + 28);
    if (dataStart + compressed > directoryStart || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) fail(tr("ZIP 文件内容越界或名称不一致。"));
    if (!(flags & 8) && (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== original)) fail(tr("ZIP 文件大小声明不一致。"));
    entries.push({ name, method, crc, compressed, original, start: dataStart, local });
    names.add(name);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end || !names.has('manifest.json') || !names.has('data.json')) fail(tr("备份缺少清单或数据文件。"));
  const ranges = [...entries].sort((a, b) => a.local - b.local);
  for (let index = 1; index < ranges.length; index++) if (ranges[index].local < ranges[index - 1].start + ranges[index - 1].compressed) fail(tr("备份文件区域重叠。"));
  return entries;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function extractZip(bytes, entries) {
  const files = new Map();
  let total = 0;
  for (const entry of entries) {
    const chunks = [];
    let size = 0;
    const accept = (chunk) => {
      size += chunk.length;
      total += chunk.length;
      if (size > entry.original || total > LIMITS.expanded) fail(tr("备份实际解压大小超出声明或限制。"));
      chunks.push(chunk.slice());
    };
    if (entry.method === 0) accept(bytes.subarray(entry.start, entry.start + entry.compressed));
    else {
      const stream = new Inflate((chunk) => accept(chunk));
      // Small compressed chunks bound temporary output even when central sizes are forged.
      for (let offset = 0; offset < entry.compressed; offset += 1024) {
        stream.push(bytes.subarray(entry.start + offset, entry.start + Math.min(offset + 1024, entry.compressed)), offset + 1024 >= entry.compressed);
      }
    }
    if (size !== entry.original) fail(tr("备份解压大小与声明不一致。"));
    const result = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) { result.set(chunk, position); position += chunk.length; }
    if (crc32(result) !== entry.crc) fail(tr("备份文件校验失败。"));
    files.set(entry.name, result);
  }
  return files;
}

function parseJson(bytes) {
  try { return JSON.parse(decoder.decode(bytes)); }
  catch { fail(tr("备份中的 JSON 文件无效。")); }
}

// Adapters make backup and transaction tests independent of a real browser database.
export function createStorage({ configStore, assetStore, privacy = withNavigationPrivacy, personalTools = { read: loadPersonalToolsSnapshot, prepare: preparePersonalToolsRestore }, iconResources = { read: readNavigationIconResource, restore: restoreNavigationIconResource,
  prepare: prepareImportedNavigationIcons, retain: retainNavigationIconResources }, locks, initialState = createEmptyState, imageTools = browserImages, uuid = () => crypto.randomUUID() } = {}) {
  let config;
  let assets;
  let serial = Promise.resolve();
  const retiredSyncStatus = () => ({ enabled: false, phase: 'disabled', message: tr("浏览器同步已停用，请使用自备存储同步。") });
  const getConfig = () => config ??= configStore || browserConfig();
  const getAssets = () => assets ??= assetStore || encryptedAssets();
  const readEnvelope = async () => {
    const envelope = await getConfig().read();
    if (!envelope) return { version: 1, state: checkedState(initialState()), snapshots: [] };
    if (envelope.version !== 1 || !Array.isArray(envelope.snapshots) || envelope.snapshots.length > 3) fail(tr("本地配置版本无效；请先导出数据后再处理。"), 'INVALID_STORAGE');
    // Retired browser-sync metadata is retained verbatim for compatibility.
    // It is no longer interpreted, updated or allowed to limit local saves.
    return { ...clone(envelope), state: migrateNavigationState(envelope.state), snapshots: envelope.snapshots.map(checkedState) };
  };
  const exclusive = (action) => {
    const manager = locks || globalThis.navigator?.locks;
    if (manager?.request) return manager.request(LOCK_NAME, { mode: 'exclusive' }, action);
    if (getConfig().requireLocks) return Promise.reject(Object.assign(new Error(tr("本次修改未保存，请稍后重试。")), { code: 'LOCK_UNAVAILABLE' }));
    const next = serial.then(action, action);
    serial = next.catch(() => {});
    return next;
  };
  const writeState = async (next, expectedRevision, preferences) => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(tr("保存时缺少有效的数据版本。"), 'REVISION_CONFLICT');
    const envelope = await readEnvelope();
    if (envelope.state.revision !== expectedRevision) fail(tr("数据已在另一个标签页更新，请重新加载后再试。"), 'REVISION_CONFLICT');
    if (preferences !== undefined && sameJson(migrateNavigationState({ ...clone(next), revision: expectedRevision }), envelope.state)) {
      if (Object.keys(preferences).length) await getConfig().write(envelope, preferences);
      return clone(envelope.state);
    }
    const saved = migrateNavigationState({ ...clone(next), revision: expectedRevision + 1 });
    if (strToU8(JSON.stringify(saved)).length > LIMITS.json) fail(tr("配置数据超过 2 MiB。"), 'STORAGE_LIMIT');
    await getConfig().write({ ...envelope, state: saved, snapshots: [envelope.state, ...envelope.snapshots].slice(0, 3) }, preferences);
    return clone(saved);
  };
  const prepareIcons = async (state, options) => {
    if (options.hydrateIcons === false || !iconResources.prepare) return;
    const entryIds = Array.isArray(options.iconEntryIds) ? new Set(options.iconEntryIds) : null;
    const report = await iconResources.prepare(entryIds ? { ...state, entries: state.entries.filter((entry) => entryIds.has(entry.id)) } : state, options);
    if (report?.cancelled) fail(tr('数据已更新，已停止本次图标补齐，请重试。'), 'REVISION_CONFLICT');
    try { options.onIconResult?.(report); } catch { /* UI observers cannot interrupt a validated restoration. */ }
  };
  const writeRecoveryPair = (next, currentRevision, pair) => exclusive(() => privacy(async (_current, prepare) => {
    const commit = async () => {
      const records = prepare([], { replacePreferences: pair.preferences, expectedRevision: pair.expectedPreferencesRevision });
      const committedPreferences = records['covelet.content.preferences.v1'];
      let committedTools;
      if (pair.tools !== undefined) {
        committedTools = await personalTools.prepare(await personalTools.read(), pair.tools, { expectedRevision: pair.expectedToolsRevision });
        records['covelet.tools.v1'] = committedTools;
      }
      const state = await writeState(next, currentRevision, records);
      return { state, preferences: committedPreferences, ...(committedTools ? { tools: committedTools } : {}) };
    };
    if (pair.tools === undefined) return commit();
    const manager = locks || globalThis.navigator?.locks;
    if (manager?.request) return manager.request('covelet.tools.v1', { mode: 'exclusive' }, commit);
    if (getConfig().requireLocks) fail(tr('无法开始恢复，当前数据未改变。请稍后重试。'), 'LOCK_UNAVAILABLE');
    return commit();
  }));
  const api = {
    async loadState() { return (await readEnvelope()).state; },
    saveState(next, expectedRevision) { return exclusive(() => writeState(next, expectedRevision)); },
    saveStateWithPrivacy(next, expectedRevision, action) {
      return exclusive(() => privacy((current, changes) =>
        action(current, (addedKeys = [], metadataOptions = {}) => writeState(next, expectedRevision, changes(addedKeys, metadataOptions)))));
    },
    applyPreparedNavigationImport({ expectedNavigationRevision, expectedPreferencesRevision } = {}, factory) {
      return exclusive(() => privacy(async (current, changes) => {
        if (typeof factory !== 'function' || !Number.isSafeInteger(expectedNavigationRevision) || expectedNavigationRevision < 0
          || !Number.isSafeInteger(expectedPreferencesRevision) || expectedPreferencesRevision < 0) fail(tr('内容已在其他页面更新，请重新打开后重试。'), 'REVISION_CONFLICT');
        const before = (await readEnvelope()).state;
        if (before.revision !== expectedNavigationRevision || current.revision !== expectedPreferencesRevision) fail(tr('内容已在其他页面更新，请重新打开后重试。'), 'REVISION_CONFLICT');
        if (current.presentation) fail(tr('请先输入密码解除隐藏。'), 'PRIVACY_LOCKED');
        const result = await factory(clone(before), clone(current));
        if (!result || typeof result !== 'object' || Array.isArray(result) || !result.state
          || typeof result.preferencesChanged !== 'boolean' || !Array.isArray(result.expectedMetadata) || !Array.isArray(result.issues)
          || !Number.isSafeInteger(result.addedSites) || result.addedSites < 0 || !Number.isSafeInteger(result.updatedSites) || result.updatedSites < 0) fail(tr('导入计划无效或条目过多'), 'IMPORT_PLAN_INVALID');
        if (result.issues.length) fail(typeof result.issues[0]?.message === 'string' ? result.issues[0].message : tr('导入计划无效或条目过多'), 'IMPORT_METADATA_INVALID');
        if (result.sourceRevision !== before.revision || result.sourcePreferencesRevision !== current.revision) fail(tr('内容已在其他页面更新，请重新打开后重试。'), 'REVISION_CONFLICT');
        if (!result.addedSites && !result.updatedSites) fail(tr('没有可应用的更改。'), 'IMPORT_NO_CHANGES');
        if (!result.nextPreferences || typeof result.nextPreferences !== 'object' || Array.isArray(result.nextPreferences)) fail(tr('导入计划无效或条目过多'), 'IMPORT_PLAN_INVALID');
        const nextPreferences = validateContentPreferences(result.nextPreferences);
        const preferencesChanged = !sameJson(nextPreferences, current);
        if (nextPreferences.revision !== current.revision || preferencesChanged !== result.preferencesChanged) fail(tr('导入计划无效或条目过多'), 'IMPORT_PLAN_INVALID');
        const records = changes([], { expectedRevision: expectedPreferencesRevision, expectedMetadata: result.expectedMetadata,
          ...(result.preferencesChanged ? { replacePreferences: nextPreferences } : {}) });
        const saved = await writeState(result.state, expectedNavigationRevision, records);
        return { ...result, state: saved, nextPreferences: clone(records['covelet.content.preferences.v1'] || current) };
      }));
    },
    saveStateWithTrash(next, expectedRevision, { cause = 'context-delete', expectedPreferencesRevision, metadata = [], expectedMetadata = [], addedPrivateKeys = [], copies = [] } = {}) {
      return exclusive(() => privacy(async (current, changes) => {
        const before = (await readEnvelope()).state;
        if (before.revision !== expectedRevision) fail(tr('数据已在另一个标签页更新，请重新加载后再试。'), 'REVISION_CONFLICT');
        const beforeHidden = privateContentKeys(before, current), afterHidden = privateContentKeys(next, current);
        const withoutOrder = (entry) => { if (!entry) return null; const { order, ...value } = entry; return value; };
        if (current.presentation && [...new Set([...before.entries.map((entry) => entry.id), ...next.entries.map((entry) => entry.id)])].some((id) => {
          const previous = before.entries.find((entry) => entry.id === id), following = next.entries.find((entry) => entry.id === id), key = `${previous?.type || following?.type}:${id}`;
          return (beforeHidden.has(key) || afterHidden.has(key)) && !sameJson(withoutOrder(previous), withoutOrder(following));
        })) fail(tr('请先输入密码解除隐藏。'), 'PRIVACY_LOCKED');
        const effective = privateContentKeys({ entries: [...before.entries, ...next.entries], trash: before.trash }, current);
        const copyMetadata = [], keys = [...addedPrivateKeys];
        for (const entry of before.entries) if (entry.type === 'site' && beforeHidden.has(`site:${entry.id}`) && !afterHidden.has(`site:${entry.id}`)) keys.push(`site:${entry.id}`);
        const guarded = [...metadata.map((patch) => patch.key), ...expectedMetadata.map((baseline) => baseline.key)];
        for (const item of copies) {
          const source = before.entries.find((entry) => `site:${entry.id}` === item.from) || next.entries.find((entry) => `site:${entry.id}` === item.from);
          const target = next.entries.find((entry) => `site:${entry.id}` === item.to);
          if (!source || !target) fail(tr('目标位置已变化，请重新选择。'), 'TARGET_CHANGED');
          guarded.push(item.from, item.to);
          if (effective.has(item.from)) keys.push(item.to);
          copyMetadata.push({ key: item.to, ...(current.library?.items[item.from] || { description: '', tagIds: [] }) });
        }
        if (current.presentation && guarded.some((key) => effective.has(key))) fail(tr('请先输入密码解除隐藏。'), 'PRIVACY_LOCKED');
        const prepared = prepareNavigationDeletion(before, next, current, { cause });
        keys.push(...prepared.addedPrivateKeys);
        const cleaned = removeTrashMetadata(current, before, prepared.state, prepared.expiredTrashIds);
        return writeState(prepared.state, expectedRevision, changes([...new Set(keys)], {
          metadata: [...copyMetadata, ...metadata], expectedMetadata, expectedRevision: expectedPreferencesRevision,
          ...(cleaned ? { replacePreferences: cleaned } : {}),
        }));
      }));
    },
    async validateNavigationResources(state, { entryIds } = {}) {
      const selected = entryIds ? new Set(entryIds) : null;
      const scope = selected ? { ...state, entries: state.entries.filter((entry) => selected.has(entry.id)), trash: undefined } : state;
      for (const id of assetReferences(scope)) {
        const asset = await getAssets().get(id);
        if (!asset?.blob) fail(tr('回收内容的图片已丢失，当前数据未改变。'), 'MISSING_ASSET');
        await verifyImage(asset.blob, imageTools);
      }
    },
    subscribeState(callback) {
      return getConfig().subscribe((state) => {
        try { callback(state ? migrateNavigationState(state) : checkedState(createEmptyState())); }
        catch { /* A malformed external change must not replace the visible valid state. */ }
      });
    },
    async putImage(file, kind = 'icon') {
      if (kind !== 'icon') fail(tr("已停用用户壁纸上传；请使用 Bing 每日壁纸或内置背景。"), 'INVALID_IMAGE');
      await verifyImage(file, imageTools);
      const blob = await imageTools.resize(file, 256);
      await verifyImage(blob, imageTools);
      const id = uuid();
      await getAssets().add({ id, blob, mime: blob.type, createdAt: new Date().toISOString() });
      return id;
    },
    async getAssetUrl(id) {
      const asset = await getAssets().get(id);
      if (!asset?.blob) fail(tr("本地图片不存在，请重新选择图片或恢复完整备份。"), 'MISSING_ASSET');
      await verifyImage(asset.blob, imageTools);
      return URL.createObjectURL(asset.blob);
    },
    async exportBackup(state) {
      const data = migrateNavigationState(state);
      const references = [...assetReferences(data)];
      if (references.length + 2 > LIMITS.entries) fail(tr("图片数量超出备份限制，请减少自定义图片。"));
      const files = Object.create(null);
      files['data.json'] = strToU8(JSON.stringify(data));
      if (files['data.json'].length > LIMITS.json) fail(tr("配置数据超过 2 MiB。"));
      const manifest = { format: 'owntab-backup', version: 2, createdAt: new Date().toISOString(), assets: [], icons: [] };
      let total = files['data.json'].length;
      for (const [index, id] of references.entries()) {
        const asset = await getAssets().get(id);
        if (!asset?.blob) fail(tr("有图片无法读取，未能导出备份。"), 'MISSING_ASSET');
        const bytes = await verifyImage(asset.blob, imageTools);
        const path = `assets/${index}.${MIME_EXT[asset.blob.type]}`;
        manifest.assets.push({ id, path, mime: asset.blob.type, bytes: bytes.length, sha256: await sha256(bytes) });
        files[path] = bytes;
        total += bytes.length;
        if (total > LIMITS.expanded) fail(tr("备份解压后超过 80 MiB。"));
      }
      // URL configuration alone cannot restore images while offline. Include
      // only referenced persistent originals, including both adaptive schemes;
      // exporting never discovers sites or downloads missing artwork.
      for (const source of iconReferences(data)) {
        const record = await iconResources.read(source);
        if (!record) continue;
        let blobs;
        try { blobs = await verifyIconResource(record, imageTools); } catch { continue; }
        if (record.url !== source) fail(tr('无法读取图标，备份未导出。'));
        const item = { url: source, width: record.width, height: record.height, vector: record.vector, adaptive: record.adaptive, updatedAt: record.updatedAt };
        for (const [index, bytes] of blobs.entries()) {
          const field = index ? 'darkBlob' : 'blob', blob = record[field];
          const path = `icons/${manifest.icons.length}${index ? '-dark' : ''}.${MIME_EXT[blob.type]}`;
          item[field] = { path, mime: blob.type, bytes: bytes.length, sha256: await sha256(bytes) };
          files[path] = bytes; total += bytes.length;
          if (total > LIMITS.expanded || Object.keys(files).length + 1 > LIMITS.entries) fail(tr('备份内容过多，请减少自定义图片后重试。'));
        }
        manifest.icons.push(item);
      }
      files['manifest.json'] = strToU8(JSON.stringify(manifest));
      if (files['manifest.json'].length > LIMITS.json || total + files['manifest.json'].length > LIMITS.expanded) fail(tr("备份内容过多，请减少自定义图片后重试。"));
      const zip = zipSync(files, { level: 6 });
      if (zip.length > LIMITS.archive) fail(tr("完整备份超过 30 MiB，请减少自定义图片。"));
      return new Blob([zip], { type: 'application/zip' });
    },
    async inspectBackup(file) {
      if (!(file instanceof Blob) || file.size > LIMITS.archive) fail(tr("备份文件必须在 30 MiB 以内。"));
      const raw = new Uint8Array(await file.arrayBuffer());
      const files = extractZip(raw, zipDirectory(raw));
      const manifest = parseJson(files.get('manifest.json'));
      if (manifest?.format !== 'owntab-backup' || ![1, 2].includes(manifest.version) || !Array.isArray(manifest.assets)
        || manifest.version === 2 && !Array.isArray(manifest.icons)
        || manifest.version === 1 && Object.hasOwn(manifest, 'icons')) fail(tr("备份格式或版本不受支持。"));
      const state = checkedState(parseJson(files.get('data.json')));
      const references = assetReferences(state);
      const restoredAssets = new Map();
      const paths = new Set(['manifest.json', 'data.json']);
      for (const asset of manifest.assets) {
        if (!asset || typeof asset.id !== 'string' || !references.has(asset.id) || restoredAssets.has(asset.id) || !MIME_EXT[asset.mime] || typeof asset.path !== 'string' || !asset.path.startsWith('assets/') || paths.has(asset.path) || !Number.isSafeInteger(asset.bytes) || !/^[a-f0-9]{64}$/.test(asset.sha256)) fail(tr("备份中的图片信息无法读取。"));
        const bytes = files.get(asset.path);
        if (!bytes || bytes.length !== asset.bytes || asset.path.split('.').at(-1) !== MIME_EXT[asset.mime] || await sha256(bytes) !== asset.sha256) fail(tr("备份中的图片缺失或已损坏，请重新选择备份文件。"));
        const blob = new Blob([bytes], { type: asset.mime });
        await verifyImage(blob, imageTools);
        restoredAssets.set(asset.id, { blob, mime: asset.mime, sha256: asset.sha256 });
        paths.add(asset.path);
      }
      const restoredIcons = new Map(), sourceReferences = iconReferences(state);
      if ((manifest.icons?.length || 0) > sourceReferences.size) fail(tr('备份中的图片信息无法读取。'));
      for (const item of manifest.icons || []) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !sourceReferences.has(item.url) || restoredIcons.has(item.url)
          || Object.keys(item).some((key) => !['url', 'blob', 'darkBlob', 'width', 'height', 'vector', 'adaptive', 'updatedAt'].includes(key))) fail(tr('备份中的图片信息无法读取。'));
        const record = { ...item };
        for (const field of ['blob', ...(item.adaptive ? ['darkBlob'] : [])]) {
          const resource = item[field];
          if (!resource || typeof resource !== 'object' || Array.isArray(resource) || Object.keys(resource).length !== 4
            || Object.keys(resource).some((key) => !['path', 'mime', 'bytes', 'sha256'].includes(key))
            || !MIME_EXT[resource.mime] || typeof resource.path !== 'string' || !/^icons\/[A-Za-z0-9_-]{1,80}\.(png|jpg|webp)$/.test(resource.path)
            || paths.has(resource.path) || !Number.isSafeInteger(resource.bytes) || !/^[a-f0-9]{64}$/.test(resource.sha256)) fail(tr('备份中的图片信息无法读取。'));
          const bytes = files.get(resource.path);
          if (!bytes || bytes.length !== resource.bytes || resource.path.split('.').at(-1) !== MIME_EXT[resource.mime]
            || await sha256(bytes) !== resource.sha256) fail(tr('备份中的图片缺失或已损坏，请重新选择备份文件。'));
          record[field] = new Blob([bytes], { type: resource.mime }); paths.add(resource.path);
        }
        await verifyIconResource(record, imageTools); restoredIcons.set(item.url, record);
      }
      if (references.size !== restoredAssets.size || paths.size !== files.size) fail(tr("备份中的图片不完整，请重新选择备份文件。"));
      return { state, assets: restoredAssets, icons: restoredIcons, summary: { sites: state.entries.filter((entry) => entry.type !== 'folder').length, folders: state.entries.filter((entry) => entry.type === 'folder').length, groups: state.groups.length, assets: restoredAssets.size, bytes: raw.length } };
    },
    async validateBackupPlan(plan) {
      const legacyState = checkedState(plan?.state), state = migrateNavigationState(legacyState);
      if (!(plan.assets instanceof Map)) fail(tr('请先检查备份文件。'));
      const references = assetReferences(state);
      if (assetReferences(legacyState).size !== plan.assets.size || [...references].some((id) => !plan.assets.has(id))) fail(tr('备份中的图片不完整，请重新选择备份文件。'));
      for (const id of assetReferences(legacyState)) {
        const asset = plan.assets.get(id);
        if (!asset?.blob || await sha256(await verifyImage(asset.blob, imageTools)) !== asset.sha256) fail(tr('备份中的图片无法读取，未开始恢复。'));
      }
      const icons = plan.icons === undefined ? new Map() : plan.icons;
      if (!(icons instanceof Map)) fail(tr('备份中的图片信息无法读取。'));
      const sources = iconReferences(legacyState);
      for (const [source, record] of icons) {
        if (!sources.has(source) || record?.url !== source) fail(tr('备份中的图片信息无法读取。'));
        await verifyIconResource(record, imageTools);
      }
      return { ...plan, state: legacyState, assets: new Map(plan.assets), icons: new Map(icons) };
    },
    async restoreBackup(plan, currentRevision, options = {}) {
      if (!Number.isSafeInteger(currentRevision) || (await readEnvelope()).state.revision !== currentRevision) fail(tr('数据已在另一个标签页更新，请重新加载后再试。'), 'REVISION_CONFLICT');
      const checked = await api.validateBackupPlan(plan);
      const legacyState = checked.state;
      let state = migrateNavigationState(legacyState);
      if (!options.preserveContentReferences && navigationResourceEntries(state).some(widgetContentReference)) {
        const currentTools = await personalTools.read();
        const views = await privacy((current) => current.library?.views || []);
        state = remapWidgetContentReferences(state, {
          reservedNoteIds: [...currentTools.notes, ...currentTools.trash.filter((item) => item.kind === 'notes').map((item) => item.record)].map((note) => note.id),
          reservedViewIds: views.map((view) => view.id),
        });
      }
      if (!(plan.assets instanceof Map)) fail(tr("请先检查备份文件。"));
      const references = assetReferences(state);
      if (assetReferences(legacyState).size !== plan.assets.size || [...references].some((id) => !plan.assets.has(id))) fail(tr("备份中的图片不完整，请重新选择备份文件。"));
      const ids = new Map();
      const staged = [];
      const releaseIcons = iconResources.retain?.(state);
      try {
        for (const id of assetReferences(legacyState)) {
          const asset = plan.assets.get(id);
          if (!asset?.blob || await sha256(await verifyImage(asset.blob, imageTools)) !== asset.sha256) fail(tr("备份中的图片无法读取，未开始恢复。"));
        }
        for (const record of checked.icons.values()) {
          if (!await iconResources.restore(record)) fail(tr('图片保存失败。'), 'MISSING_ASSET');
        }
        await prepareIcons(state, options);
        for (const id of references) {
          const asset = plan.assets.get(id);
          const nextId = uuid();
          await getAssets().add({ id: nextId, blob: asset.blob, mime: asset.blob.type, createdAt: new Date().toISOString() });
          staged.push(nextId);
          ids.set(id, nextId);
        }
        const remapped = remapAssets(state, ids);
        if (options.pairedPreferences) {
          return await writeRecoveryPair(remapped, currentRevision, options.pairedPreferences);
        }
        return await api.saveState(remapped, currentRevision);
      } catch (error) {
        await Promise.allSettled(staged.map((id) => getAssets().delete(id)));
        throw error;
      } finally { releaseIcons?.(); }
    },
    restoreBackupWithPreferences(plan, { expectedNavigationRevision, expectedPreferencesRevision, preferences, tools, expectedToolsRevision, ...options } = {}) {
      const pair = { preferences, expectedPreferencesRevision, tools, expectedToolsRevision };
      return api.restoreBackup(plan, expectedNavigationRevision, { ...options, pairedPreferences: pair });
    },
    async restoreContentWithPreferences({ expectedNavigationRevision, expectedPreferencesRevision, preferences, tools, expectedToolsRevision } = {}) {
      // Content-only recovery also uses the navigation CAS. No assets or layout
      // are replaced, but live pins cannot observe tools and privacy separately.
      return writeRecoveryPair(await api.loadState(), expectedNavigationRevision,
        { preferences, expectedPreferencesRevision, tools, expectedToolsRevision });
    },
    async restoreSnapshot(expectedRevision, options = {}) {
      const envelope = await readEnvelope();
      if (envelope.state.revision !== expectedRevision) fail(tr("数据已在另一个标签页更新。"), 'REVISION_CONFLICT');
      const previous = envelope.snapshots[0] && migrateNavigationState(envelope.snapshots[0]);
      if (!previous) fail(tr("还没有可恢复的导航副本。"), 'NO_SNAPSHOT');
      for (const id of assetReferences(previous)) if (!(await getAssets().get(id))?.blob) fail(tr("导航副本中的图片已丢失，当前数据未改变。"), 'MISSING_ASSET');
      // Image preparation may involve an explicit one-time download. Leave
      // ordinary navigation writes available and recheck the revision at CAS.
      const releaseIcons = iconResources.retain?.(previous);
      try {
        await prepareIcons(previous, options);
        return await api.saveState(previous, expectedRevision);
      } finally { releaseIcons?.(); }
    },
    // Compatibility for already-open callers. These APIs never read or write
    // browser-native sync, create timers, or claim a successful remote sync.
    getSyncStatus() { return retiredSyncStatus(); },
    subscribeSyncStatus(callback) { callback(retiredSyncStatus()); return () => {}; },
    async setSyncEnabled(enabled) {
      if (typeof enabled !== 'boolean') fail(tr("同步开关值无效。"), 'SYNC_INVALID');
      if (enabled) fail(retiredSyncStatus().message, 'SYNC_UNAVAILABLE');
      return retiredSyncStatus();
    },
    async syncNow() { return retiredSyncStatus(); },
    async getSyncConflicts() { return []; },
    async restoreSyncConflict() { fail(retiredSyncStatus().message, 'SYNC_UNAVAILABLE'); },
  };
  return api;
}

const storage = createStorage({ initialState: createInitialState });
export const { loadState, saveState, saveStateWithPrivacy, applyPreparedNavigationImport, saveStateWithTrash, validateNavigationResources, restoreBackupWithPreferences, restoreContentWithPreferences, subscribeState, putImage, getAssetUrl, exportBackup, inspectBackup, validateBackupPlan, restoreBackup, restoreSnapshot,
  getSyncStatus, subscribeSyncStatus, setSyncEnabled, syncNow, getSyncConflicts, restoreSyncConflict } = storage;
