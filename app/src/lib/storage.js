import { tr, getLocale } from "../i18n/index.js";
import { Inflate, zipSync, strToU8 } from 'fflate';
import { createEmptyState, createInitialState, validateState, migrateNavigationState } from './model.js';
import { browserSyncStore, createReplica, validateReplica, combineReplicas, recordChanges, portableState, materializeState, syncConflicts, readReplicas, publishReplica } from './sync.js';

const STORE_KEY = 'owntab.local.v1';
const LOCK_NAME = 'owntab.local.write.v1';
const MiB = 1024 * 1024;
const LIMITS = { archive: 30 * MiB, expanded: 80 * MiB, image: 10 * MiB, json: 2 * MiB, entries: 2200, pixels: 40_000_000 };
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
  for (const entry of state.entries) if (entry.icon?.kind === 'image') ids.add(entry.icon.value);
  return ids;
}

function remapAssets(state, ids) {
  const result = clone(state);
  if (result.settings.background.kind === 'image') result.settings.background.value = ids.get(result.settings.background.value);
  for (const entry of result.entries) if (entry.icon?.kind === 'image') entry.icon.value = ids.get(entry.icon.value);
  return result;
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

function chromeAvailable() { return Boolean(globalThis.chrome?.storage?.local && globalThis.chrome?.runtime?.id); }
function extensionPage() { return ['chrome-extension:', 'moz-extension:'].includes(globalThis.location?.protocol); }

function browserConfig() {
  const chromeMode = chromeAvailable();
  if (!chromeMode && extensionPage()) fail(tr("扩展本地存储不可用，未切换到预览存储。"), 'STORAGE_UNAVAILABLE');
  const listeners = new Set();
  const storage = chromeMode ? globalThis.chrome.storage : null;
  const notify = (value) => { for (const listener of listeners) listener(value?.state ? clone(value.state) : null); };
  let stopExternal;
  const chromeCall = (method, argument) => new Promise((resolve, reject) => {
    try {
      storage.local[method](argument, (result) => {
        const error = globalThis.chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    } catch (error) { reject(error); }
  });
  return {
    requireLocks: chromeMode,
    async read() {
      if (chromeMode) return (await chromeCall('get', STORE_KEY))[STORE_KEY] ?? null;
      const value = globalThis.localStorage.getItem(STORE_KEY);
      return value ? JSON.parse(value) : null;
    },
    async write(envelope) {
      if (chromeMode) await chromeCall('set', { [STORE_KEY]: envelope });
      else { globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(envelope)); notify(envelope); }
    },
    subscribe(callback) {
      listeners.add(callback);
      if (!stopExternal) {
        if (chromeMode) {
          const listener = (changes, area) => { if (area === 'local' && changes[STORE_KEY]) notify(changes[STORE_KEY].newValue); };
          storage.onChanged.addListener(listener);
          stopExternal = () => storage.onChanged.removeListener(listener);
        } else {
          const listener = (event) => {
            if (event.key === STORE_KEY && event.storageArea === globalThis.localStorage) {
              try { notify(event.newValue ? JSON.parse(event.newValue) : null); } catch { /* Ignore malformed external events. */ }
            }
          };
          globalThis.addEventListener('storage', listener);
          stopExternal = () => globalThis.removeEventListener('storage', listener);
        }
      }
      return () => {
        listeners.delete(callback);
        if (!listeners.size) { stopExternal?.(); stopExternal = undefined; }
      };
    },
  };
}

function indexedAssets() {
  let pending;
  const open = () => pending ??= new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error(tr("本地图片存储不可用。"))); return; }
    const request = indexedDB.open('owntab-assets', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('assets', { keyPath: 'id' });
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); pending = undefined; }; resolve(request.result); };
    request.onerror = () => { pending = undefined; reject(request.error); };
    request.onblocked = () => reject(new Error(tr("请关闭旧版本 Covelet 标签页后重试。")));
  });
  const run = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('assets', mode);
      const request = action(transaction.objectStore('assets'));
      let result;
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || request.error);
      transaction.onabort = () => reject(transaction.error || request.error || new Error(tr("图片存储已取消。")));
    });
  };
  return {
    get: (id) => run('readonly', (store) => store.get(id)),
    add: (record) => run('readwrite', (store) => store.add(record)),
    delete: (id) => run('readwrite', (store) => store.delete(id)),
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
    if (!/^(manifest\.json|data\.json|assets\/[A-Za-z0-9_-]{1,80}\.(png|jpg|webp))$/.test(name) || names.has(name)) fail(tr("备份包含未知、重复或不安全的文件路径。"));
    if ((flags & ~0x0808) || ![0, 8].includes(method) || u16(offset + 34) || (u32(offset + 38) >>> 16 & 0xf000) === 0xa000) fail(tr("备份包含不支持的 ZIP 条目。"));
    const limit = name.startsWith('assets/') ? LIMITS.image : LIMITS.json;
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
export function createStorage({ configStore, assetStore, locks, syncStore, initialState = createEmptyState, syncDelay = 1500, syncMinInterval = 10000, imageTools = browserImages, uuid = () => crypto.randomUUID() } = {}) {
  let config;
  let assets;
  let serial = Promise.resolve();
  let nativeSync;
  let syncTimer;
  let syncFlight;
  let started = false;
  let lastEnabled = false;
  let lastBlockedError = null;
  let initialSync;
  let status = { enabled: false, phase: 'disabled', message: tr("浏览器同步尚未开启；数据仅保存在本机。") };
  const statusListeners = new Set();
  const getNativeSync = () => nativeSync === undefined ? (nativeSync = syncStore === undefined ? browserSyncStore() : syncStore) : nativeSync;
  const setStatus = (next) => { status = next; for (const listener of statusListeners) { try { listener(clone(status)); } catch { /* A view subscriber cannot abort persistence. */ } } return clone(status); };
  const syncMetadata = (value, fresh = false) => {
    if (!value) {
      if (!initialSync) {
        const baseline = fresh ? checkedState(initialState()) : createEmptyState();
        // Track the initial sites locally before sync is enabled, so removing
        // one before the first sync still produces a deletion, not a reseed.
        const document = recordChanges(createReplica(uuid()), createEmptyState(), baseline);
        initialSync = { version: 1, enabled: false, document, documents: {}, base: portableState(baseline), dirty: false, lastPublishedAt: 0, blockedError: null };
      }
      return clone(initialSync);
    }
    if (value.version !== 1 || typeof value.enabled !== 'boolean' || typeof value.dirty !== 'boolean') fail(tr("本地同步元数据无效。"), 'SYNC_INVALID');
    const document = validateReplica(value.document);
    return { version: 1, enabled: value.enabled, dirty: value.dirty, document,
      lastPublishedAt: Number.isFinite(value.lastPublishedAt) ? Math.max(0, value.lastPublishedAt) : 0,
      blockedError: typeof value.blockedError === 'string' ? value.blockedError.slice(0, 1000) : null,
      documents: combineReplicas(value.documents, { [document.actor]: document }), base: portableState(value.base) };
  };
  const getConfig = () => config ??= configStore || browserConfig();
  const getAssets = () => assets ??= assetStore || indexedAssets();
  const readEnvelope = async () => {
    const envelope = await getConfig().read();
    if (!envelope) return { version: 1, state: checkedState(initialState()), snapshots: [], sync: syncMetadata(undefined, true) };
    if (envelope.version !== 1 || !Array.isArray(envelope.snapshots) || envelope.snapshots.length > 3) fail(tr("本地配置版本无效；请先导出数据后再处理。"), 'INVALID_STORAGE');
    return { version: 1, state: migrateNavigationState(envelope.state), snapshots: envelope.snapshots.map(checkedState), sync: syncMetadata(envelope.sync) };
  };
  const exclusive = (action) => {
    const manager = locks || globalThis.navigator?.locks;
    if (manager?.request) return manager.request(LOCK_NAME, { mode: 'exclusive' }, action);
    if (getConfig().requireLocks) return Promise.reject(Object.assign(new Error(tr("浏览器事务锁不可用，未保存以免覆盖其他标签页。")), { code: 'LOCK_UNAVAILABLE' }));
    const next = serial.then(action, action);
    serial = next.catch(() => {});
    return next;
  };
  const queueSync = () => {
    if (!lastEnabled || !getNativeSync()) return;
    clearTimeout(syncTimer);
    if (lastBlockedError) {
      setStatus({ enabled: true, phase: 'error', message: tr("同步已暂停：{0} 本地修改已保存，可导出 ZIP 备份。", [lastBlockedError]) });
      return;
    }
    setStatus({ enabled: true, phase: 'pending', message: tr("本地数据已保存，等待写入浏览器同步区。") });
    syncTimer = setTimeout(() => { api.syncNow().catch(() => {}); }, syncDelay);
    syncTimer.unref?.();
  };
  const start = () => {
    if (started) return;
    started = true;
    getConfig().subscribe(() => {
      readEnvelope().then((envelope) => {
        lastEnabled = envelope.sync.enabled;
        lastBlockedError = envelope.sync.blockedError;
        if (lastEnabled) queueSync();
        else setStatus({ enabled: false, phase: getNativeSync() ? 'disabled' : 'preview', message: getNativeSync() ? tr("浏览器同步已关闭；本地数据和已有同步区数据均保留。") : tr("网页预览不支持浏览器同步，请加载扩展后使用。") });
      }).catch((cause) => setStatus({ enabled: lastEnabled, phase: 'error', message: cause.message }));
    });
    getNativeSync()?.subscribe(queueSync);
  };
  const updateLocalReplica = (metadata, before, after, forced) => {
    if (!metadata.enabled) return metadata;
    try {
      const documents = combineReplicas(metadata.documents, { [metadata.document.actor]: metadata.document });
      const document = recordChanges(metadata.document, metadata.blockedError ? metadata.base : before, after, documents, forced);
      return { ...metadata, document, documents: combineReplicas(documents, { [document.actor]: document }), base: portableState(after),
        dirty: metadata.dirty || document.clock !== metadata.document.clock, blockedError: null };
    } catch (cause) {
      // Protocol limits must not reject an otherwise valid local edit. Keep the
      // old baseline so a later retry accounts for every untracked local change.
      return { ...metadata, blockedError: cause.message || tr("同步记录无法生成。") };
    }
  };
  const writeState = async (next, expectedRevision) => {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail(tr("保存时缺少有效的数据版本。"), 'REVISION_CONFLICT');
    const envelope = await readEnvelope();
    if (envelope.state.revision !== expectedRevision) fail(tr("数据已在另一个标签页更新，请重新加载后再试。"), 'REVISION_CONFLICT');
    const saved = migrateNavigationState({ ...clone(next), revision: expectedRevision + 1 });
    if (strToU8(JSON.stringify(saved)).length > LIMITS.json) fail(tr("配置数据超过 2 MiB。"), 'STORAGE_LIMIT');
    const sync = updateLocalReplica(envelope.sync, envelope.state, saved);
    await getConfig().write({ version: 1, state: saved, snapshots: [envelope.state, ...envelope.snapshots].slice(0, 3), sync });
    lastEnabled = sync.enabled;
    lastBlockedError = sync.blockedError;
    queueSync();
    return clone(saved);
  };
  const api = {
    async loadState() {
      start();
      const envelope = await readEnvelope();
      lastEnabled = envelope.sync.enabled;
      lastBlockedError = envelope.sync.blockedError;
      if (!getNativeSync()) setStatus({ enabled: false, phase: 'preview', message: tr("网页预览不支持浏览器同步，请加载扩展后使用。") });
      else if (lastEnabled) queueSync();
      return envelope.state;
    },
    saveState(next, expectedRevision) { start(); return exclusive(() => writeState(next, expectedRevision)); },
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
      return URL.createObjectURL(asset.blob);
    },
    async exportBackup(state) {
      const data = migrateNavigationState(state);
      const references = [...assetReferences(data)];
      if (references.length + 2 > LIMITS.entries) fail(tr("备份资源数量超出限制。"));
      const files = Object.create(null);
      files['data.json'] = strToU8(JSON.stringify(data));
      if (files['data.json'].length > LIMITS.json) fail(tr("配置数据超过 2 MiB。"));
      const manifest = { format: 'owntab-backup', version: 1, createdAt: new Date().toISOString(), assets: [] };
      let total = files['data.json'].length;
      for (const [index, id] of references.entries()) {
        const asset = await getAssets().get(id);
        if (!asset?.blob) fail(tr("备份缺少图片资源：{0}", [id]), 'MISSING_ASSET');
        const bytes = await verifyImage(asset.blob, imageTools);
        const path = `assets/${index}.${MIME_EXT[asset.blob.type]}`;
        manifest.assets.push({ id, path, mime: asset.blob.type, bytes: bytes.length, sha256: await sha256(bytes) });
        files[path] = bytes;
        total += bytes.length;
        if (total > LIMITS.expanded) fail(tr("备份解压后超过 80 MiB。"));
      }
      files['manifest.json'] = strToU8(JSON.stringify(manifest));
      if (files['manifest.json'].length > LIMITS.json || total + files['manifest.json'].length > LIMITS.expanded) fail(tr("备份清单或资源超出限制。"));
      const zip = zipSync(files, { level: 6 });
      if (zip.length > LIMITS.archive) fail(tr("完整备份超过 30 MiB，请减少自定义图片。"));
      return new Blob([zip], { type: 'application/zip' });
    },
    async inspectBackup(file) {
      if (!(file instanceof Blob) || file.size > LIMITS.archive) fail(tr("备份文件必须在 30 MiB 以内。"));
      const raw = new Uint8Array(await file.arrayBuffer());
      const files = extractZip(raw, zipDirectory(raw));
      const manifest = parseJson(files.get('manifest.json'));
      if (manifest?.format !== 'owntab-backup' || manifest.version !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length + 2 !== files.size) fail(tr("备份格式或版本不受支持。"));
      const state = checkedState(parseJson(files.get('data.json')));
      const references = assetReferences(state);
      const restoredAssets = new Map();
      const paths = new Set(['manifest.json', 'data.json']);
      for (const asset of manifest.assets) {
        if (!asset || typeof asset.id !== 'string' || !references.has(asset.id) || restoredAssets.has(asset.id) || !MIME_EXT[asset.mime] || typeof asset.path !== 'string' || !asset.path.startsWith('assets/') || paths.has(asset.path) || !Number.isSafeInteger(asset.bytes) || !/^[a-f0-9]{64}$/.test(asset.sha256)) fail(tr("备份资源清单无效。"));
        const bytes = files.get(asset.path);
        if (!bytes || bytes.length !== asset.bytes || asset.path.split('.').at(-1) !== MIME_EXT[asset.mime] || await sha256(bytes) !== asset.sha256) fail(tr("备份图片缺失、大小或哈希校验不一致。"));
        const blob = new Blob([bytes], { type: asset.mime });
        await verifyImage(blob, imageTools);
        restoredAssets.set(asset.id, { blob, mime: asset.mime, sha256: asset.sha256 });
        paths.add(asset.path);
      }
      if (references.size !== restoredAssets.size || paths.size !== files.size) fail(tr("备份未完整包含所有图片资源。"));
      return { state, assets: restoredAssets, summary: { sites: state.entries.filter((entry) => entry.type !== 'folder').length, folders: state.entries.filter((entry) => entry.type === 'folder').length, groups: state.groups.length, assets: restoredAssets.size, bytes: raw.length } };
    },
    async restoreBackup(plan, currentRevision) {
      const legacyState = checkedState(plan?.state);
      const state = migrateNavigationState(legacyState);
      if (!(plan.assets instanceof Map)) fail(tr("请先检查备份文件。"));
      const references = assetReferences(state);
      if (assetReferences(legacyState).size !== plan.assets.size || [...references].some((id) => !plan.assets.has(id))) fail(tr("备份图片引用不完整。"));
      const ids = new Map();
      const staged = [];
      try {
        for (const id of assetReferences(legacyState)) {
          const asset = plan.assets.get(id);
          if (!asset?.blob || await sha256(await verifyImage(asset.blob, imageTools)) !== asset.sha256) fail(tr("恢复前的图片校验失败。"));
        }
        for (const id of references) {
          const asset = plan.assets.get(id);
          const nextId = uuid();
          await getAssets().add({ id: nextId, blob: asset.blob, mime: asset.blob.type, createdAt: new Date().toISOString() });
          staged.push(nextId);
          ids.set(id, nextId);
        }
        return await api.saveState(remapAssets(state, ids), currentRevision);
      } catch (error) {
        await Promise.allSettled(staged.map((id) => getAssets().delete(id)));
        throw error;
      }
    },
    restoreSnapshot(expectedRevision) {
      return exclusive(async () => {
        const envelope = await readEnvelope();
        if (envelope.state.revision !== expectedRevision) fail(tr("数据已在另一个标签页更新。"), 'REVISION_CONFLICT');
        const previous = envelope.snapshots[0] && migrateNavigationState(envelope.snapshots[0]);
        if (!previous) fail(tr("还没有可恢复的本地快照。"), 'NO_SNAPSHOT');
        for (const id of assetReferences(previous)) if (!(await getAssets().get(id))?.blob) fail(tr("快照依赖的图片不存在，未改变当前数据。"), 'MISSING_ASSET');
        return writeState(previous, expectedRevision);
      });
    },
    getSyncStatus() { return clone(status); },
    subscribeSyncStatus(callback) { statusListeners.add(callback); callback(clone(status)); return () => statusListeners.delete(callback); },
    async setSyncEnabled(enabled) {
      if (typeof enabled !== 'boolean') fail(tr("同步开关值无效。"), 'SYNC_INVALID');
      start();
      if (enabled && !getNativeSync()) { setStatus({ enabled: false, phase: 'preview', message: tr("网页预览不支持浏览器同步，请加载扩展后使用。") }); fail(tr("请在 Chrome 或 Edge 扩展中开启浏览器同步。"), 'SYNC_UNAVAILABLE'); }
      await exclusive(async () => {
        const envelope = await readEnvelope();
        envelope.sync.enabled = enabled;
        if (enabled) envelope.sync = updateLocalReplica(envelope.sync, envelope.sync.base, envelope.state);
        await getConfig().write(envelope);
        lastEnabled = enabled;
        lastBlockedError = envelope.sync.blockedError;
      });
      if (!enabled) {
        clearTimeout(syncTimer);
        return setStatus({ enabled: false, phase: 'disabled', message: tr("浏览器同步已关闭；本地数据和已有同步区数据均保留。") });
      }
      return api.syncNow();
    },
    async syncNow() {
      start();
      clearTimeout(syncTimer);
      if (syncFlight) return syncFlight;
      syncFlight = exclusive(async () => {
        let envelope = await readEnvelope();
        lastEnabled = envelope.sync.enabled;
        lastBlockedError = envelope.sync.blockedError;
        if (!lastEnabled) return setStatus({ enabled: false, phase: getNativeSync() ? 'disabled' : 'preview', message: getNativeSync() ? tr("浏览器同步尚未开启。") : tr("网页预览不支持浏览器同步，请加载扩展后使用。") });
        const remote = getNativeSync();
        if (!remote) throw Object.assign(new Error(tr("浏览器同步存储不可用；本地数据已保留。")), { code: 'SYNC_UNAVAILABLE' });
        if (envelope.sync.blockedError) {
          const repaired = updateLocalReplica(envelope.sync, envelope.sync.base, envelope.state);
          lastBlockedError = repaired.blockedError;
          if (repaired.blockedError) return setStatus({ enabled: true, phase: 'error', message: tr("同步已暂停：{0} 本地修改已保存，可导出 ZIP 备份。", [repaired.blockedError]) });
          envelope.sync = repaired;
          await getConfig().write(envelope);
        }
        setStatus({ enabled: true, phase: 'pending', message: tr("正在合并并写入浏览器同步区。") });
        const items = await remote.get();
        const incoming = await readReplicas(items);
        const documents = combineReplicas(envelope.sync.documents, incoming.documents, { [envelope.sync.document.actor]: envelope.sync.document });
        const own = documents[envelope.sync.document.actor];
        const merged = migrateNavigationState(materializeState(documents, envelope.state));
        const stateChanged = JSON.stringify(merged) !== JSON.stringify(envelope.state);
        const sync = { ...envelope.sync, document: own, documents, base: portableState(merged) };
        envelope = { ...envelope, sync };
        if (stateChanged) {
          merged.revision = envelope.state.revision + 1;
          envelope = { ...envelope, state: merged, snapshots: [envelope.state, ...envelope.snapshots].slice(0, 3) };
        }
        // Persist received records and conflicts locally before publishing. Network
        // or browser quota failures cannot roll back already saved local work.
        const previous = await getConfig().read();
        if (stateChanged || JSON.stringify(previous?.sync) !== JSON.stringify(sync)) await getConfig().write(envelope);
        let used = Object.entries(items).reduce((sum, [key, value]) => sum + new TextEncoder().encode(key + JSON.stringify(value)).length, 0);
        const head = `${'owntab.sync.v1.'}${own.actor}.head`;
        if (sync.dirty || !items[head] || items[head].clock !== own.clock || incoming.incomplete.includes(own.actor)) {
          // A generation can use three write calls (chunks, commit, old cleanup).
          // Persist the throttle across pages so sustained editing stays below
          // Chrome's hourly write quota, in addition to the 1.5 s debounce.
          const remaining = Math.min(syncMinInterval, sync.lastPublishedAt + syncMinInterval - Date.now());
          if (remaining > 0) {
            clearTimeout(syncTimer);
            syncTimer = setTimeout(() => { api.syncNow().catch(() => {}); }, remaining);
            syncTimer.unref?.();
            return setStatus({ enabled: true, phase: 'pending', bytes: used, message: tr("本地数据已保存；浏览器同步写入已排队，正在等待写入间隔。") });
          }
          const result = await publishReplica(remote, own, items);
          used = result.bytes;
          if (sync.dirty || result.written) { envelope.sync.dirty = false; if (result.written) envelope.sync.lastPublishedAt = Date.now(); await getConfig().write(envelope); }
        }
        const conflicts = syncConflicts(documents).length;
        return setStatus({ enabled: true, phase: incoming.incomplete.length ? 'pending' : 'saved', bytes: used,
          message: incoming.incomplete.length ? tr("部分同步分片尚未到齐；已保留本地完整数据，等待浏览器传入剩余分片或稍后手动重试。")
            : tr("已写入浏览器同步区，跨设备传输由浏览器管理。{0}", [conflicts ? tr("有 {0} 个并发版本可在冲突列表恢复。", [conflicts]) : '']) });
      }).catch((cause) => setStatus({ enabled: lastEnabled, phase: 'error', message: tr("{0} 本地数据仍然保留。", [cause.message]) })).finally(() => { syncFlight = undefined; });
      return syncFlight;
    },
    async getSyncConflicts() {
      const envelope = await readEnvelope();
      return syncConflicts(combineReplicas(envelope.sync.documents, { [envelope.sync.document.actor]: envelope.sync.document }));
    },
    async restoreSyncConflict(id) {
      start();
      return exclusive(async () => {
        const envelope = await readEnvelope();
        if (!envelope.sync.enabled) fail(tr("请先开启同步，再恢复并发版本。"), 'SYNC_DISABLED');
        const documents = combineReplicas(envelope.sync.documents, { [envelope.sync.document.actor]: envelope.sync.document });
        const conflict = syncConflicts(documents).find((item) => item.id === id);
        if (!conflict) fail(tr("此并发版本已处理，请刷新冲突列表。"), 'SYNC_CONFLICT_MISSING');
        const sync = updateLocalReplica(envelope.sync, envelope.state, envelope.state, { [conflict.key]: conflict.value });
        if (sync.blockedError) fail(tr("此并发版本尚未恢复：{0}", [sync.blockedError]), 'SYNC_BLOCKED');
        const saved = migrateNavigationState(materializeState(sync.documents, envelope.state));
        saved.revision = envelope.state.revision + 1;
        sync.base = portableState(saved);
        await getConfig().write({ ...envelope, state: saved, snapshots: [envelope.state, ...envelope.snapshots].slice(0, 3), sync });
        queueSync();
        return saved;
      });
    },
  };
  return api;
}

const storage = createStorage({ initialState: createInitialState });
export const { loadState, saveState, subscribeState, putImage, getAssetUrl, exportBackup, inspectBackup, restoreBackup, restoreSnapshot,
  getSyncStatus, subscribeSyncStatus, setSyncEnabled, syncNow, getSyncConflicts, restoreSyncConflict } = storage;
