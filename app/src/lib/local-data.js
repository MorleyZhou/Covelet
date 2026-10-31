// One encrypted, device-local persistence boundary. No plaintext fallback is used.
// The key is intentionally device-bound; portable backups/sync encrypt separately.
import { isSyncRecord, normalizeSyncValue, prepareSyncValue, validateSyncValue } from './sync-data-rules.js';
const DATABASE = 'covelet.encrypted.local.v1';
const RECORDS = 'records', KEYS = 'keys', KEY_ID = 'device-key-v1';
// Complete recovery records may contain a 50 MiB JSON backup and its previous
// recovery point. Keep serialization overhead inside a bounded local envelope.
const VERSION = 1, MAX_BYTES = 128 * 1024 * 1024, MAX_MANIFEST = 96 * 1024 * 1024;
const MAX_NODES = 1000000, MAX_DEPTH = 80, MAX_KEY = 16384;
const MAX_SYNC_RECORDS = 20000, MAX_SYNC_BYTES = 512 * 1024 * 1024;
const LEGACY_NAMESPACES = ['preferences', 'assets', 'navigation-icons', 'provider-icons', 'wallpaper'];
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const queues = new Map();
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fail = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
const invalid = (message = 'Unsupported or oversized local data.') => fail('LOCAL_DATA_INVALID', message);
const validKey = (key) => { if (typeof key !== 'string' || !key.length || key.length > MAX_KEY) throw invalid('Invalid local data key.'); return key; };

async function pack(value) {
  let nodes = 0, size = 0;
  const blobs = [], ancestors = new Set();
  async function visit(item, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw invalid();
    if (item === null) return [0];
    if (typeof item === 'boolean') return [1, item];
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw invalid(); return [2, item]; }
    if (typeof item === 'string') { size += item.length * 2; if (size > MAX_BYTES) throw invalid(); return [3, item]; }
    if (typeof Blob !== 'undefined' && item instanceof Blob) {
      size += item.size;
      if (size > MAX_BYTES || item.type.length > 1024) throw invalid();
      const index = blobs.length; blobs.push(item); return [6, index, item.type];
    }
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw invalid();
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > MAX_NODES || Object.keys(item).length !== item.length) throw invalid();
        const result = [];
        for (const child of item) result.push(await visit(child, depth + 1));
        return [4, result];
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)) || Object.getOwnPropertySymbols(item).length) throw invalid();
      const result = [], descriptors = Object.getOwnPropertyDescriptors(item);
      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable) continue;
        if (!own(descriptor, 'value') || key.length > MAX_KEY) throw invalid();
        result.push([key, await visit(descriptor.value, depth + 1)]);
      }
      return [5, result];
    } finally { ancestors.delete(item); }
  }
  const tree = await visit(value, 0), manifest = encoder.encode(JSON.stringify([VERSION, tree, blobs.map((blob) => blob.size)]));
  const length = 8 + manifest.length + blobs.reduce((total, blob) => total + blob.size, 0);
  if (manifest.length > MAX_MANIFEST || length > MAX_BYTES) throw invalid();
  const bytes = new Uint8Array(length);
  bytes.set([67, 86, 76, 84]); new DataView(bytes.buffer).setUint32(4, manifest.length); bytes.set(manifest, 8);
  let offset = 8 + manifest.length;
  for (const blob of blobs) { bytes.set(new Uint8Array(await blob.arrayBuffer()), offset); offset += blob.size; }
  return bytes;
}

function unpack(input) {
  const bytes = new Uint8Array(input);
  if (bytes.length < 8 || bytes.length > MAX_BYTES || bytes[0] !== 67 || bytes[1] !== 86 || bytes[2] !== 76 || bytes[3] !== 84) throw invalid('Invalid encrypted local data payload.');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  if (length > MAX_MANIFEST || length + 8 > bytes.length) throw invalid();
  const manifest = JSON.parse(decoder.decode(bytes.subarray(8, 8 + length)));
  if (!Array.isArray(manifest) || manifest.length !== 3 || manifest[0] !== VERSION || !Array.isArray(manifest[2])) throw invalid();
  let offset = 8 + length;
  const chunks = manifest[2].map((size) => {
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length) throw invalid();
    const chunk = bytes.slice(offset, offset + size); offset += size; return chunk;
  });
  if (offset !== bytes.length) throw invalid();
  let nodes = 0;
  function visit(node, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH || !Array.isArray(node)) throw invalid();
    if (node[0] === 0 && node.length === 1) return null;
    if (node.length !== 2 && !(node[0] === 6 && node.length === 3)) throw invalid();
    if (node[0] === 1 && typeof node[1] === 'boolean') return node[1];
    if (node[0] === 2 && typeof node[1] === 'number' && Number.isFinite(node[1])) return node[1];
    if (node[0] === 3 && typeof node[1] === 'string') return node[1];
    if (node[0] === 4 && Array.isArray(node[1])) return node[1].map((child) => visit(child, depth + 1));
    if (node[0] === 5 && Array.isArray(node[1])) {
      const result = {};
      for (const pair of node[1]) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || pair[0].length > MAX_KEY || own(result, pair[0])) throw invalid();
        Object.defineProperty(result, pair[0], { value: visit(pair[1], depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
    if (node[0] === 6 && Number.isInteger(node[1]) && node[1] >= 0 && node[1] < chunks.length && typeof node[2] === 'string' && node[2].length <= 1024) return new Blob([chunks[node[1]]], { type: node[2] });
    throw invalid();
  }
  return visit(manifest[1], 0);
}

function indexedBackend(indexedDB, name) {
  let opening;
  function open() {
    if (!indexedDB?.open) return Promise.reject(fail('LOCAL_DATA_UNAVAILABLE', 'Encrypted local storage requires IndexedDB.'));
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, VERSION); let rejected = false;
      request.onupgradeneeded = () => {
        if (rejected) { request.transaction.abort(); return; }
        const db = request.result;
        if (!db.objectStoreNames.contains(RECORDS)) { const store = db.createObjectStore(RECORDS, { keyPath: 'id' }); store.createIndex('space', 'space', { unique: false }); }
        if (!db.objectStoreNames.contains(KEYS)) db.createObjectStore(KEYS);
      };
      request.onerror = () => { rejected = true; reject(fail('LOCAL_DATA_UNAVAILABLE', 'Could not open encrypted local storage.', request.error)); };
      request.onblocked = () => { rejected = true; reject(fail('LOCAL_DATA_BLOCKED', 'Another page is blocking the encrypted storage upgrade. Close older Covelet pages and retry.')); };
      request.onsuccess = () => { const db = request.result; if (rejected) { db.close(); return; } db.onversionchange = () => { db.close(); opening = undefined; }; resolve(db); };
    }).catch((error) => { opening = undefined; throw error; });
    return opening;
  }
  async function transaction(stores, mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode); let value, error;
      const result = (next) => { value = next; }, abort = (cause) => { error = cause; tx.abort(); };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(error || fail('LOCAL_DATA_WRITE_FAILED', 'Encrypted local storage operation failed.', tx.error));
      try { action(tx, result, abort); } catch (cause) { abort(cause); }
    });
  }
  return {
    getKey: () => transaction([KEYS], 'readonly', (tx, result) => { tx.objectStore(KEYS).get(KEY_ID).onsuccess = (event) => result(event.target.result); }),
    ensureKey: (candidate) => transaction([KEYS, RECORDS], 'readwrite', (tx, result, abort) => {
      const keyStore = tx.objectStore(KEYS);
      keyStore.get(KEY_ID).onsuccess = (event) => {
        if (event.target.result) { result(event.target.result); return; }
        tx.objectStore(RECORDS).count().onsuccess = (count) => {
          if (count.target.result) { abort(fail('LOCAL_DATA_KEY_MISSING', 'The device encryption key is missing. Existing encrypted data was preserved.')); return; }
          keyStore.add(candidate, KEY_ID); result(candidate);
        };
      };
    }),
    get: (id) => transaction([RECORDS], 'readonly', (tx, result) => { tx.objectStore(RECORDS).get(id).onsuccess = (event) => result(event.target.result); }),
    entries: (space) => transaction([RECORDS], 'readonly', (tx, result) => { (space === undefined ? tx.objectStore(RECORDS).getAll() : tx.objectStore(RECORDS).index('space').getAll(space)).onsuccess = (event) => result(event.target.result); }),
    put: (records) => transaction([RECORDS], 'readwrite', (tx) => { const store = tx.objectStore(RECORDS); for (const record of records) store.put(record); }),
    remove: (ids) => transaction([RECORDS], 'readwrite', (tx) => { const store = tx.objectStore(RECORDS); for (const id of ids) store.delete(id); }),
    commit: (records, ids) => transaction([RECORDS], 'readwrite', (tx) => { const store = tx.objectStore(RECORDS); for (const id of ids) store.delete(id); for (const record of records) store.put(record); }),
    close: async () => { if (opening) (await opening).close(); opening = undefined; },
  };
}

function legacyCall(area, method, argument) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => { if (!settled) { settled = true; error ? reject(error) : resolve(value); } };
    try {
      const result = area[method](argument, (value) => {
        const error = globalThis.chrome?.runtime?.lastError;
        finish(error ? fail('LOCAL_DATA_MIGRATION_FAILED', 'Could not migrate legacy local data.', new Error(error.message)) : null, value);
      });
      if (result?.then) result.then((value) => finish(null, value), (error) => finish(error));
    } catch (error) { finish(error); }
  });
}

const bytesEqual = (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index]);
const isOwnedLegacyKey = (key) => /^(?:covelet|owntab)[.:-]/.test(key) && key !== 'covelet.cloud.session.v1';

/** Dependency injection is for focused tests; production always uses IndexedDB/Web Crypto. */
export function createLocalData(options = {}) {
  const name = options.databaseName || DATABASE;
  const crypto = options.crypto || globalThis.crypto;
  const backend = options.backend || indexedBackend(options.indexedDB || globalThis.indexedDB, name);
  const locks = options.locks ?? globalThis.navigator?.locks;
  const legacy = options.legacyLocal === undefined ? () => globalThis.chrome?.storage?.local : () => options.legacyLocal;
  const localStorage = options.localStorage === undefined ? () => globalThis.localStorage : () => options.localStorage;
  const listeners = new Map(), stores = new Map(), syncListeners = new Set();
  let channel, closed = false;
  const sender = crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const requireCrypto = () => { if (!crypto?.subtle || !crypto.getRandomValues) throw fail('LOCAL_DATA_UNAVAILABLE', 'Encrypted local storage requires Web Crypto.'); };
  const exclusive = (action) => {
    const previous = queues.get(name) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (closed) throw fail('LOCAL_DATA_CLOSED', 'Encrypted local storage is closed.');
      return locks?.request ? locks.request(`${name}:write`, action) : action();
    });
    queues.set(name, next);
    next.finally(() => { if (queues.get(name) === next) queues.delete(name); }).catch(() => {});
    return next;
  };
  async function hash(value) { requireCrypto(); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join(''); }
  async function identity(namespace, key) { return { space: await hash(`namespace:${namespace}`), id: await hash(`record:${namespace}\0${key}`) }; }
  async function key() {
    requireCrypto();
    let value = await backend.getKey();
    if (!value) value = await backend.ensureKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    if (!value || value.extractable || value.algorithm?.name !== 'AES-GCM' || value.algorithm.length !== 256 || !value.usages.includes('encrypt') || !value.usages.includes('decrypt')) throw fail('LOCAL_DATA_KEY_INVALID', 'The device encryption key is invalid. Existing data was preserved.');
    return value;
  }
  const aad = (space, id) => encoder.encode(`${DATABASE}:${VERSION}:${space}:${id}`);
  async function encrypt(namespace, recordKey, value, encryptionKey) {
    // Namespace is inside the authenticated ciphertext, allowing future store
    // namespaces to participate in full sync without a plaintext registry.
    const { space, id } = await identity(namespace, recordKey), plain = await pack([namespace, recordKey, value]), iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(space, id), tagLength: 128 }, encryptionKey, plain);
    return { record: { id, space, version: VERSION, iv: iv.buffer, ciphertext }, plain };
  }
  async function decrypt(namespace, record, encryptionKey, expectedKey) {
    if (!record) return undefined;
    try {
      if (record.version !== VERSION || typeof record.id !== 'string' || typeof record.space !== 'string' || !(record.iv instanceof ArrayBuffer) || record.iv.byteLength !== 12 || !(record.ciphertext instanceof ArrayBuffer) || record.ciphertext.byteLength < 16 || record.ciphertext.byteLength > MAX_BYTES + 16) throw invalid();
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: aad(record.space, record.id), tagLength: 128 }, encryptionKey, record.ciphertext));
      const decoded = unpack(plain);
      if (!Array.isArray(decoded) || ![2, 3].includes(decoded.length)) throw invalid();
      const storedNamespace = decoded.length === 3 ? validKey(decoded[0]) : namespace;
      if (!storedNamespace || namespace !== undefined && namespace !== storedNamespace) throw invalid();
      const recordKey = validKey(decoded[decoded.length - 2]), value = decoded[decoded.length - 1];
      const identityValue = await identity(storedNamespace, recordKey);
      if (identityValue.id !== record.id || identityValue.space !== record.space || (expectedKey !== undefined && expectedKey !== recordKey)) throw invalid();
      return { namespace: storedNamespace, key: recordKey, value, plain };
    } catch (error) { throw fail('LOCAL_DATA_DECRYPT_FAILED', 'Encrypted local data could not be verified. Existing data was preserved.', error); }
  }
  function notify(namespace, changes) {
    if (!changes.length) return;
    const publicChanges = {};
    for (const change of changes) Object.defineProperty(publicChanges, change.key, { enumerable: true, value: { oldValue: change.oldValue, newValue: change.newValue } });
    for (const listener of listeners.get(namespace) || []) { try { listener(publicChanges); } catch { /* One consumer must not break persistence or other subscribers. */ } }
  }
  function openChannel() {
    if (channel || options.broadcastChannel === null) return;
    const factory = options.broadcastChannel || (typeof BroadcastChannel !== 'undefined' ? (name) => new BroadcastChannel(name) : null);
    if (!factory) return;
    channel = factory(`${name}:changes`); channel.unref?.();
    channel.onmessage = (event) => {
      const message = event.data;
      if (message?.sender !== sender && message?.version === VERSION && message?.type === 'data-change' && ['local', 'sync'].includes(message.source)) {
        for (const listener of syncListeners) { try { listener({ source: message.source }); } catch {} }
        return;
      }
      if (!message || message.sender === sender || message.version !== VERSION || !Array.isArray(message.changes) || message.changes.length > 10000 || typeof message.space !== 'string') return;
      exclusive(async () => {
        // Messages contain ciphertext only. Never broadcast URLs, content, keys or credentials.
        for (const [namespace, callbacks] of listeners) {
          if (!callbacks.size || await hash(`namespace:${namespace}`) !== message.space) continue;
          const encryptionKey = await key(), decoded = [];
          for (const change of message.changes) {
            if (!Array.isArray(change) || change.length !== 2) throw invalid();
            const oldValue = await decrypt(namespace, change[0], encryptionKey), newValue = await decrypt(namespace, change[1], encryptionKey);
            if (!oldValue && !newValue || oldValue && newValue && oldValue.key !== newValue.key) throw invalid();
            decoded.push({ key: newValue?.key || oldValue.key, oldValue: oldValue?.value, newValue: newValue?.value });
          }
          notify(namespace, decoded);
        }
      }).catch(() => { /* A future read reports storage verification errors without replacing usable UI state. */ });
    };
  }
  function announce(namespace, space, changes) {
    notify(namespace, changes);
    // Cache namespaces are not subscribed; avoid duplicating large image ciphertext on the channel.
    if (namespace !== 'preferences' && !listeners.has(namespace)) return;
    openChannel();
    try { channel?.postMessage({ version: VERSION, sender, space, changes: changes.map((change) => [change.oldRecord || null, change.newRecord || null]) }); } catch { /* A closed context does not invalidate an already committed write. */ }
  }
  function signalSyncData(source) {
    for (const listener of syncListeners) { try { listener({ source }); } catch {} }
    openChannel();
    try { channel?.postMessage({ version: VERSION, sender, type: 'data-change', source }); } catch {}
  }
  async function migrate(namespace, requested, encryptionKey) {
    if (namespace !== 'preferences') return;
    const area = legacy(), browser = area?.get && area?.remove ? await legacyCall(area, 'get', requested) : {};
    const sources = new Map();
    for (const [recordKey, value] of Object.entries(browser || {})) if (recordKey !== 'covelet.cloud.session.v1' && (requested !== null || isOwnedLegacyKey(recordKey)) && value !== undefined) sources.set(recordKey, [{ value, area }]);
    const storage = localStorage();
    const storageKeys = requested === null ? Array.from({ length: storage?.length || 0 }, (_, index) => storage.key(index)).filter((entry) => typeof entry === 'string' && isOwnedLegacyKey(entry)) : requested;
    for (const recordKey of storageKeys || []) {
      if (!storage?.getItem || recordKey === 'covelet.cloud.session.v1') continue;
      const raw = storage.getItem(recordKey);
      if (raw !== null) { let value; try { value = JSON.parse(raw); } catch { value = raw; } const existing = sources.get(recordKey) || []; existing.push({ value, raw, storage }); sources.set(recordKey, existing); }
    }
    for (const [recordKey, copies] of sources) {
      validKey(recordKey);
      const { id } = await identity(namespace, recordKey);
      let record = await backend.get(id);
      if (!record) { const encrypted = await encrypt(namespace, recordKey, copies[0].value, encryptionKey); await backend.put([encrypted.record]); record = await backend.get(id); }
      const verified = await decrypt(namespace, record, encryptionKey, recordKey);
      if (!verified) throw fail('LOCAL_DATA_MIGRATION_FAILED', 'Encrypted migration verification failed. Legacy data was preserved.');
      // Every remaining copy must agree. An older page may have edited its legacy
      // copy while migration ran; keep both rather than choosing silently.
      for (const source of copies) if (!bytesEqual(await pack(source.value), await pack(verified.value))) throw fail('LOCAL_DATA_MIGRATION_CONFLICT', 'Legacy and encrypted local data differ. Both copies were preserved for recovery.');
      // Recheck each source before cleanup so a concurrent legacy edit is retained.
      for (const source of copies) {
        if (source.area) {
          const current = (await legacyCall(source.area, 'get', [recordKey])) || {};
          if (!own(current, recordKey) || !bytesEqual(await pack(source.value), await pack(current[recordKey]))) throw fail('LOCAL_DATA_MIGRATION_CONFLICT', 'Legacy local data changed during migration. Existing copies were preserved.');
          await legacyCall(source.area, 'remove', [recordKey]);
        } else {
          if (source.storage.getItem(recordKey) !== source.raw) throw fail('LOCAL_DATA_MIGRATION_CONFLICT', 'Legacy local data changed during migration. Existing copies were preserved.');
          source.storage.removeItem(recordKey);
        }
      }
    }
  }
  function createEncryptedStore(namespace) {
    validKey(namespace);
    if (stores.has(namespace)) return stores.get(namespace);
    const store = {
      get: (recordKey) => exclusive(async () => { validKey(recordKey); const encryptionKey = await key(); await migrate(namespace, [recordKey], encryptionKey); const { id } = await identity(namespace, recordKey); return (await decrypt(namespace, await backend.get(id), encryptionKey, recordKey))?.value; }),
      set: (recordKey, value, { shouldWrite } = {}) => exclusive(async () => { validKey(recordKey); if (shouldWrite && !shouldWrite()) return false; return write(namespace, { [recordKey]: value }); }),
      remove: (recordKey) => exclusive(async () => { validKey(recordKey); return remove(namespace, [recordKey]); }),
      entries: () => exclusive(async () => { const encryptionKey = await key(); await migrate(namespace, null, encryptionKey); const space = await hash(`namespace:${namespace}`), result = []; for (const record of await backend.entries(space)) { const decoded = await decrypt(namespace, record, encryptionKey); result.push([decoded.key, decoded.value]); } return result; }),
    };
    stores.set(namespace, store); return store;
  }
  async function write(namespace, values) {
    if (!values || Object.getPrototypeOf(values) !== Object.prototype || Object.getOwnPropertySymbols(values).length) throw invalid();
    const recordKeys = Object.keys(values); if (recordKeys.length > 10000) throw invalid(); recordKeys.forEach(validKey);
    const encryptionKey = await key(); await migrate(namespace, recordKeys, encryptionKey);
    const changes = [], records = []; let totalBytes = 0;
    for (const recordKey of recordKeys) {
      if (!own(Object.getOwnPropertyDescriptor(values, recordKey), 'value')) throw invalid();
      const encrypted = await encrypt(namespace, recordKey, values[recordKey], encryptionKey), oldRecord = await backend.get(encrypted.record.id), oldValue = await decrypt(namespace, oldRecord, encryptionKey, recordKey);
      totalBytes += encrypted.plain.byteLength;
      if (totalBytes > MAX_BYTES) throw invalid('A single local data write exceeds the 128 MiB limit.');
      // Re-decode so mutations by the caller cannot alter values delivered to subscribers.
      const newValue = unpack(encrypted.plain)[2];
      records.push(encrypted.record); changes.push({ key: recordKey, oldValue: oldValue?.value, newValue, oldRecord, newRecord: encrypted.record });
    }
    if (!records.length) return;
    await backend.put(records); announce(namespace, records[0].space, changes);
    if (changes.some((change) => isSyncRecord(namespace, change.key))) signalSyncData('local');
  }
  async function remove(namespace, recordKeys) {
    const encryptionKey = await key(); await migrate(namespace, recordKeys, encryptionKey);
    const ids = [], changes = [];
    for (const recordKey of recordKeys) { const { id } = await identity(namespace, recordKey), oldRecord = await backend.get(id); ids.push(id); if (oldRecord) { const previous = await decrypt(namespace, oldRecord, encryptionKey, recordKey); changes.push({ key: recordKey, oldValue: previous.value, newValue: undefined, oldRecord }); } }
    await backend.remove(ids); if (changes.length) announce(namespace, changes[0].oldRecord.space, changes);
    if (changes.some((change) => isSyncRecord(namespace, change.key))) signalSyncData('local');
  }
  const parseKeys = (requested) => { const values = typeof requested === 'string' ? [requested] : Array.isArray(requested) ? requested : requested && Object.getPrototypeOf(requested) === Object.prototype ? Object.keys(requested) : null; if (requested !== null && requested !== undefined && !values) throw invalid(); if (values?.length > 10000) throw invalid(); return values ? [...new Set(values.map(validKey))] : null; };
  const recordIdentity = (namespace, recordKey) => JSON.stringify([namespace, recordKey]);
  async function allDecoded(encryptionKey) {
    const namespaces = [...new Set([...LEGACY_NAMESPACES, ...stores.keys()])];
    const legacySpaces = new Map(await Promise.all(namespaces.map(async (namespace) => [await hash(`namespace:${namespace}`), namespace])));
    const pendingSpace = await hash('namespace:full-data-pending');
    const result = [];
    for (const record of await backend.entries()) {
      if (record.space === pendingSpace) continue;
      // Existing v1 records have no namespace inside their ciphertext. Every
      // shipped legacy namespace is known; new writes are self-describing.
      const decoded = await decrypt(legacySpaces.get(record.space), record, encryptionKey);
      result.push({ ...decoded, record });
    }
    return result;
  }
  async function makeSnapshot(decoded) {
    const records = decoded.filter((item) => isSyncRecord(item.namespace, item.key)).map((item) => ({
      namespace: item.namespace, key: item.key, value: normalizeSyncValue(item.namespace, item.key, item.value),
    })).sort((left, right) => recordIdentity(left.namespace, left.key) < recordIdentity(right.namespace, right.key) ? -1 : recordIdentity(left.namespace, left.key) > recordIdentity(right.namespace, right.key) ? 1 : 0);
    if (records.length > MAX_SYNC_RECORDS) throw invalid('Too many synchronized extension records.');
    const hashes = []; let bytes = 0;
    for (const record of records) {
      const packed = await pack(record); bytes += packed.byteLength;
      if (bytes > MAX_SYNC_BYTES) throw invalid('Synchronized extension data exceeds 512 MiB.');
      hashes.push([record.namespace, record.key, [...new Uint8Array(await crypto.subtle.digest('SHA-256', packed))].map((byte) => byte.toString(16).padStart(2, '0')).join('')]);
    }
    return { version: 1, records, token: await hash(JSON.stringify(hashes)) };
  }
  async function withSyncLocks(snapshot, action) {
    if (!locks?.request) return action();
    // Existing writers hold a domain lock across read/modify/write. Acquire
    // those before the global persistence lock so a writer which started
    // before the import cannot later overwrite the imported record.
    const clockKeys = await exclusive(async () => {
      const encryptionKey = await key();
      return (await allDecoded(encryptionKey)).filter((item) => item.namespace === 'preferences' && item.key.startsWith('covelet.clock.v1.')).map((item) => item.key);
    });
    for (const item of Array.isArray(snapshot?.records) ? snapshot.records : []) if (item?.namespace === 'preferences' && typeof item.key === 'string' && item.key.startsWith('covelet.clock.v1.')) clockKeys.push(item.key);
    const names = ['covelet.complete-recovery.v1', ...new Set(['owntab.local.write.v1', 'covelet.content.preferences.v1', 'covelet.tools.v1', 'covelet.desktop-templates.v1', ...clockKeys])].slice(0, MAX_SYNC_RECORDS + 5);
    const acquire = (index) => index < names.length ? locks.request(names[index], { mode: 'exclusive' }, () => acquire(index + 1)) : action();
    return acquire(0);
  }
  const syncDataStore = {
    snapshot: () => exclusive(async () => {
      const encryptionKey = await key(); await migrate('preferences', null, encryptionKey);
      return makeSnapshot(await allDecoded(encryptionKey));
    }),
    apply: (snapshot, { expectedToken, wholeRecord } = {}) => withSyncLocks(snapshot, () => exclusive(async () => {
      if (!snapshot || Object.getPrototypeOf(snapshot) !== Object.prototype || snapshot.version !== 1 || !Array.isArray(snapshot.records)
        || snapshot.records.length > MAX_SYNC_RECORDS || typeof expectedToken !== 'string' || !/^[a-f0-9]{64}$/.test(expectedToken)
        || Object.keys(snapshot).some((field) => !['version', 'records', 'token'].includes(field))) throw invalid('Invalid synchronized extension snapshot.');
      const encryptionKey = await key(); await migrate('preferences', null, encryptionKey);
      const decoded = await allDecoded(encryptionKey), previousSnapshot = await makeSnapshot(decoded);
      if (previousSnapshot.token !== expectedToken) throw fail('REVISION_CONFLICT', 'Local extension data changed while synchronizing. Retry synchronization.');
      const existing = new Map(decoded.map((item) => [recordIdentity(item.namespace, item.key), item]));
      const incoming = new Map(); let bytes = 0;
      for (const entry of snapshot.records) {
        // Copy via the strict framing first: getters, unsupported prototypes,
        // cycles and caller mutations must not reach validators or persistence.
        const packed = await pack(entry), record = unpack(packed); bytes += packed.byteLength;
        if (bytes > MAX_SYNC_BYTES || !record || Object.getPrototypeOf(record) !== Object.prototype
          || Object.keys(record).length !== 3 || !own(record, 'namespace') || !own(record, 'key') || !own(record, 'value')) throw invalid();
        validKey(record.namespace); validKey(record.key);
        if (record.namespace.includes('\0') || !isSyncRecord(record.namespace, record.key)) throw invalid('Device-only synchronization metadata cannot be imported.');
        const id = recordIdentity(record.namespace, record.key);
        if (incoming.has(id)) throw invalid('Duplicate synchronized extension record.');
        await validateSyncValue(record.namespace, record.key, record.value);
        incoming.set(id, record);
      }
      // Preserve a local active privacy lock even if another device deleted
      // its preferences record; deletion is never an implicit local unlock.
      const privacyId = recordIdentity('preferences', 'covelet.content.preferences.v1'), privacy = existing.get(privacyId);
      const selected = wholeRecord ? recordIdentity(wholeRecord.namespace, wholeRecord.key) : null;
      // Explicit conflict choices must not silently union portable fields.
      // Deleting an active local visibility record would also unlock this
      // device; require the user to unlock locally before choosing deletion.
      if (selected === privacyId && !incoming.has(privacyId) && privacy?.value.presentation)
        throw fail('LOCAL_DATA_PRIVACY_CONFLICT', 'Unlock hidden content on this device before choosing this deleted version.');
      if (!incoming.has(privacyId) && privacy?.value.presentation) incoming.set(privacyId, { namespace: 'preferences', key: privacy.key,
        value: { version: 1, revision: 0, aliases: {}, privateKeys: [...privacy.value.privateKeys] } });
      const records = [], remove = [], changes = new Map();
      const change = (namespace, item) => { if (!changes.has(namespace)) changes.set(namespace, []); changes.get(namespace).push(item); };
      for (const [id, entry] of incoming) {
        const previous = existing.get(id);
        if (previous && bytesEqual(await pack(normalizeSyncValue(entry.namespace, entry.key, previous.value)), await pack(normalizeSyncValue(entry.namespace, entry.key, entry.value)))) continue;
        const value = prepareSyncValue(entry.namespace, entry.key, entry.value, previous?.value, { wholeRecord: selected === id });
        await validateSyncValue(entry.namespace, entry.key, value);
        if (previous && bytesEqual(await pack(normalizeSyncValue(entry.namespace, entry.key, previous.value)), await pack(normalizeSyncValue(entry.namespace, entry.key, value)))) continue;
        const encrypted = await encrypt(entry.namespace, entry.key, value, encryptionKey);
        records.push(encrypted.record);
        change(entry.namespace, { key: entry.key, oldValue: previous?.value, newValue: unpack(encrypted.plain)[2], oldRecord: previous?.record, newRecord: encrypted.record });
      }
      for (const [id, previous] of existing) if (isSyncRecord(previous.namespace, previous.key) && !incoming.has(id)) {
        remove.push(previous.record.id); change(previous.namespace, { key: previous.key, oldValue: previous.value, newValue: undefined, oldRecord: previous.record });
      }
      if (records.length || remove.length) {
        if (!backend.commit) throw fail('LOCAL_DATA_WRITE_FAILED', 'Atomic synchronized writes are unavailable. Local data was preserved.');
        await backend.commit(records, remove);
        for (const [namespace, list] of changes) announce(namespace, list[0].newRecord?.space || list[0].oldRecord.space, list);
        signalSyncData('sync');
      }
      return { ...await makeSnapshot(await allDecoded(encryptionKey)), changed: records.length + remove.length };
    })),
    subscribe: (listener) => { if (typeof listener !== 'function') throw invalid(); syncListeners.add(listener); openChannel(); return () => syncListeners.delete(listener); },
  };
  const localData = {
    updateMany: (recordKeys, transform) => exclusive(async () => {
      const requested = parseKeys(recordKeys);
      if (!requested || typeof transform !== 'function') throw invalid();
      const encryptionKey = await key(); await migrate('preferences', requested, encryptionKey);
      const old = new Map(), values = {};
      for (const recordKey of requested) {
        const { id } = await identity('preferences', recordKey), record = await backend.get(id);
        const decoded = await decrypt('preferences', record, encryptionKey, recordKey);
        old.set(recordKey, { record, value: decoded?.value }); if (decoded) Object.defineProperty(values, recordKey, { value: decoded.value, enumerable: true });
      }
      const { writes = {}, removals = [] } = await transform(values);
      if (!removals.every((recordKey) => requested.includes(recordKey)) || Object.keys(writes).some((recordKey) => !requested.includes(recordKey) || removals.includes(recordKey))) throw invalid();
      const records = [], ids = [], changes = [];
      for (const [recordKey, value] of Object.entries(writes)) {
        const encrypted = await encrypt('preferences', recordKey, value, encryptionKey); records.push(encrypted.record);
        changes.push({ key: recordKey, oldValue: old.get(recordKey)?.value, newValue: unpack(encrypted.plain)[2], oldRecord: old.get(recordKey)?.record, newRecord: encrypted.record });
      }
      for (const recordKey of removals) if (old.get(recordKey)?.record) { ids.push(old.get(recordKey).record.id); changes.push({ key: recordKey, oldValue: old.get(recordKey).value, newValue: undefined, oldRecord: old.get(recordKey).record }); }
      if (!backend.commit) throw fail('LOCAL_DATA_WRITE_FAILED', 'Atomic local writes are unavailable.');
      await backend.commit(records, ids);
      if (changes.length) { announce('preferences', changes[0].newRecord?.space || changes[0].oldRecord.space, changes); signalSyncData('local'); }
      return writes;
    }),
    // Read/modify/write under the same cross-context lock as sync imports.
    // Callbacks must not call storage again while holding this lock.
    update: (recordKey, transform) => exclusive(async () => {
      validKey(recordKey);
      if (typeof transform !== 'function') throw invalid();
      const encryptionKey = await key();
      await migrate('preferences', [recordKey], encryptionKey);
      const { id } = await identity('preferences', recordKey);
      const previous = (await decrypt('preferences', await backend.get(id), encryptionKey, recordKey))?.value;
      const next = await transform(previous);
      await write('preferences', { [recordKey]: next });
      return next;
    }),
    get: (requested = null) => exclusive(async () => {
      const recordKeys = parseKeys(requested), defaults = requested && !Array.isArray(requested) && typeof requested === 'object' ? requested : {}, encryptionKey = await key();
      await migrate('preferences', recordKeys, encryptionKey);
      const records = recordKeys === null ? await backend.entries(await hash('namespace:preferences')) : (await Promise.all(recordKeys.map(async (recordKey) => backend.get((await identity('preferences', recordKey)).id)))).filter(Boolean);
      const result = {}; for (const recordKey of Object.keys(defaults)) Object.defineProperty(result, recordKey, { value: defaults[recordKey], enumerable: true, configurable: true });
      for (const record of records) { const decoded = await decrypt('preferences', record, encryptionKey); Object.defineProperty(result, decoded.key, { value: decoded.value, enumerable: true, configurable: true }); }
      return result;
    }),
    set: (values) => exclusive(() => write('preferences', values)),
    remove: (requested) => exclusive(() => { const recordKeys = parseKeys(requested); if (!recordKeys) throw invalid('Removing all local data requires explicit keys.'); return remove('preferences', recordKeys); }),
    subscribe: (listener) => { if (typeof listener !== 'function') throw invalid(); let callbacks = listeners.get('preferences'); if (!callbacks) listeners.set('preferences', callbacks = new Set()); callbacks.add(listener); openChannel(); return () => callbacks.delete(listener); },
    // Exact keys only, for modules whose old localStorage representation was raw text.
    migrateLocalStorage: (recordKeys) => localData.get(recordKeys),
  };
  return { localData, createEncryptedStore, syncDataStore, close: async () => { closed = true; channel?.close(); listeners.clear(); syncListeners.clear(); await backend.close?.(); } };
}

const defaultStorage = createLocalData();
export const localData = defaultStorage.localData;
export const createEncryptedStore = defaultStorage.createEncryptedStore;
export const syncDataStore = defaultStorage.syncDataStore;
