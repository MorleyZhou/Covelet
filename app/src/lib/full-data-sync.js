import { tr } from '../i18n/index.js';
import { isWebdavError } from './cloud-webdav.js';
import { localData, createEncryptedStore } from './local-data.js';
import { encryptCloudPayload, decryptCloudPayload, CLOUD_OBJECT_LIMIT } from './cloud-crypto.js';
import { parseCloudSnapshotName } from './cloud-providers.js';
import { isSyncRecord } from './sync-data-rules.js';
import { sameJson } from './json-equal.js';

// The remote indexes are small immutable revisions. Typed values and documents
// are separately encrypted, content-addressed chunks so images/recovery points
// do not inherit the old 512 KiB navigation-document limit.
const KEY = 'covelet.data-sync.v1', LOCK = 'covelet.data-sync.lock.v1';
const CHUNK = 256 * 1024, MAX_BYTES = 128 * 1024 * 1024, MAX_METADATA = 8 * 1024 * 1024;
const MAX_RECORDS = 12000, MAX_CHUNKS = 2000, MAX_ACTORS = 100, MAX_REVISIONS = 2000;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const copy = (value) => structuredClone(value), own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const hex = (value) => /^[a-f0-9]{64}$/.test(value), actorValid = (value) => /^[a-f0-9]{32}$/.test(value);
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every((name) => own(value, name));
const fail = (code = 'DATA_SYNC_INVALID') => { throw Object.assign(new Error(code), { code }); };
const same = sameJson;
// Older all-data indexes accidentally included this device preference. Accept
// its causal history so upgrades and pending retries remain readable, but never
// materialize it, expose a conflict, or include it in a new local snapshot.
const legacyDeviceRecord = (namespace, key) => namespace === 'preferences' && key === 'covelet.language.v1';
const validNamespace = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const validKey = (value) => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\u0000-\u001f\u007f]/.test(value);
function identity(namespace, key) {
  if (!validNamespace(namespace) || !validKey(key)) fail();
  if (!isSyncRecord(namespace, key) && !legacyDeviceRecord(namespace, key)) fail();
  return JSON.stringify([namespace, key]);
}
function splitIdentity(value) {
  let pair; try { pair = JSON.parse(value); } catch { fail(); }
  if (!Array.isArray(pair) || pair.length !== 2 || identity(...pair) !== value) fail();
  return pair;
}
const empty = () => ({ version: 1, metadata: null });
function defaultStore() {
  return { async read() { return (await localData.get(KEY))[KEY] || null; },
    async write(value) { await localData.set({ [KEY]: value }); } };
}
const messages = {
  get LOCAL_DATA_PRIVACY_CONFLICT() { return tr('此删除版本会移除当前隐藏内容的标记，请先在本机解除隐藏，再重新选择。'); },
  get DATA_SYNC_CONFLICT_STALE() { return tr('冲突预览已过期或数据已更新，请重新查看两侧内容后选择。'); },
  get DATA_SYNC_INVALID() { return tr('全量同步数据无效，全部本机数据已保留。'); },
  get DATA_SYNC_CAPACITY() { return tr('全量同步数据超出容量限制，全部本机数据已保留。'); },
  get DATA_SYNC_LOCAL() { return tr('无法保存全量同步状态，尚未确认上传。'); },
  get DATA_SYNC_TARGET() { return tr('全量数据还有待上传或冲突版本，请处理后再切换存储位置。'); },
  get DATA_SYNC_REQUEST() { return tr('全量加密同步未完成，请检查连接后重试；本机数据已保留。'); },
  get CLOUD_LOCKED() { return tr('请先解锁自选存储连接，再同步所有数据。'); },
  get CLOUD_DECRYPT() { return tr('无法解密同步数据：请检查加密口令，或确认云端文档未损坏。'); },
  get REVISION_CONFLICT() { return tr('数据已在其他页面更新，本次未覆盖，请重新同步。'); },
};
function safeError(reason) {
  if (isWebdavError(reason)) return reason;
  const code = own(messages, reason?.code) ? reason.code : ['CLOUD_CAPACITY', 'CLOUD_LIMIT'].includes(reason?.code) ? 'DATA_SYNC_CAPACITY'
    : ['LOCAL_DATA_CONFLICT', 'LOCAL_DATA_REVISION', 'DATA_SYNC_STALE'].includes(reason?.code) ? 'REVISION_CONFLICT' : 'DATA_SYNC_REQUEST';
  return Object.assign(new Error(messages[code]), { code });
}

// The portable format preserves Blob bytes/types, rejects getters/prototypes,
// and uses a bounded tree rather than JSON-reviver tags supplied by remote data.
async function encodeValue(value) {
  const blobs = [], ancestors = new Set(); let nodes = 0, estimated = 0;
  async function visit(item, depth) {
    if (++nodes > 1000000 || depth > 80) fail('DATA_SYNC_CAPACITY');
    if (item === null) return [0];
    if (typeof item === 'boolean') return [1, item];
    if (typeof item === 'number' && Number.isFinite(item)) return [2, item];
    if (typeof item === 'string') { estimated += encoder.encode(item).length; if (estimated > MAX_BYTES) fail('DATA_SYNC_CAPACITY'); return [3, item]; }
    if (typeof Blob !== 'undefined' && item instanceof Blob) {
      estimated += item.size; if (estimated > MAX_BYTES || item.type.length > 1024) fail('DATA_SYNC_CAPACITY');
      const index = blobs.length; blobs.push(item); return [6, index, item.type];
    }
    if (!item || typeof item !== 'object' || ancestors.has(item)) fail();
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) fail();
        const array = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !own(descriptor, 'value')) fail();
          array.push(await visit(descriptor.value, depth + 1));
        }
        return [4, array];
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)) || Object.getOwnPropertySymbols(item).length) fail();
      const pairs = [];
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable) continue;
        if (!own(descriptor, 'value') || key.length > 16384) fail();
        pairs.push([key, await visit(descriptor.value, depth + 1)]);
      }
      pairs.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0); return [5, pairs];
    } finally { ancestors.delete(item); }
  }
  const tree = await visit(value, 0), manifest = encoder.encode(JSON.stringify([1, tree, blobs.map((blob) => blob.size)]));
  const size = 8 + manifest.length + blobs.reduce((sum, blob) => sum + blob.size, 0);
  if (size > MAX_BYTES || manifest.length > 96 * 1024 * 1024) fail('DATA_SYNC_CAPACITY');
  const result = new Uint8Array(size); result.set([67, 70, 83, 49]); new DataView(result.buffer).setUint32(4, manifest.length); result.set(manifest, 8);
  let offset = 8 + manifest.length;
  for (const blob of blobs) { result.set(new Uint8Array(await blob.arrayBuffer()), offset); offset += blob.size; }
  return result;
}
function decodeValue(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > MAX_BYTES || ![67, 70, 83, 49].every((value, index) => bytes[index] === value)) fail();
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  if (length > 96 * 1024 * 1024 || length + 8 > bytes.length) fail();
  let manifest; try { manifest = JSON.parse(decoder.decode(bytes.subarray(8, 8 + length))); } catch { fail(); }
  if (!Array.isArray(manifest) || manifest.length !== 3 || manifest[0] !== 1 || !Array.isArray(manifest[2])) fail();
  let offset = 8 + length, nodes = 0;
  const blobs = manifest[2].map((size) => { if (!Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length) fail(); const value = bytes.slice(offset, offset + size); offset += size; return value; });
  if (offset !== bytes.length) fail();
  function visit(node, depth) {
    if (++nodes > 1000000 || depth > 80 || !Array.isArray(node)) fail();
    if (node.length === 1 && node[0] === 0) return null;
    if (node.length !== 2 && !(node[0] === 6 && node.length === 3)) fail();
    if (node[0] === 1 && typeof node[1] === 'boolean' || node[0] === 2 && Number.isFinite(node[1]) && typeof node[1] === 'number' || node[0] === 3 && typeof node[1] === 'string') return node[1];
    if (node[0] === 4 && Array.isArray(node[1])) return node[1].map((child) => visit(child, depth + 1));
    if (node[0] === 5 && Array.isArray(node[1])) {
      const value = {};
      for (const pair of node[1]) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || pair[0].length > 16384 || own(value, pair[0])) fail();
        Object.defineProperty(value, pair[0], { enumerable: true, configurable: true, writable: true, value: visit(pair[1], depth + 1) });
      }
      return value;
    }
    if (node[0] === 6 && Number.isInteger(node[1]) && node[1] >= 0 && node[1] < blobs.length && typeof node[2] === 'string' && node[2].length <= 1024) return new Blob([blobs[node[1]]], { type: node[2] });
    fail();
  }
  return visit(manifest[1], 0);
}
function validateReference(value, limit = MAX_BYTES) {
  if (!fields(value, ['digest', 'size', 'chunks']) || !hex(value.digest) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > limit
    || !Array.isArray(value.chunks) || value.chunks.length < 1 || value.chunks.length > MAX_CHUNKS) fail();
  let size = 0;
  for (const chunk of value.chunks) {
    const name = parseCloudSnapshotName(chunk?.name);
    if (!fields(chunk, ['hash', 'size', 'name']) || !hex(chunk.hash) || !name || name.clock !== 1
      || !Number.isSafeInteger(chunk.size) || chunk.size < 1 || chunk.size > CHUNK) fail();
    size += chunk.size;
  }
  if (size !== value.size) fail(); return copy(value);
}
export function validateFullDataReplica(input) {
  if (!fields(input, ['version', 'actor', 'clock', 'records']) || input.version !== 1 || !actorValid(input.actor) || !Number.isSafeInteger(input.clock) || input.clock < 0
    || !input.records || typeof input.records !== 'object' || Array.isArray(input.records) || Object.keys(input.records).length > MAX_RECORDS) fail();
  for (const [key, operation] of Object.entries(input.records)) {
    splitIdentity(key);
    if (!fields(operation, ['n', 'context', 'value']) || !Number.isSafeInteger(operation.n) || operation.n < 1 || operation.n > input.clock
      || !operation.context || typeof operation.context !== 'object' || Array.isArray(operation.context) || Object.keys(operation.context).length > MAX_ACTORS) fail();
    for (const [actor, clock] of Object.entries(operation.context)) if (!actorValid(actor) || !Number.isSafeInteger(clock) || clock < 0 || actor === input.actor && clock >= operation.n) fail();
    if (operation.value !== null) validateReference(operation.value);
  }
  if (encoder.encode(JSON.stringify(input)).length > MAX_METADATA) fail('DATA_SYNC_CAPACITY'); return copy(input);
}
function combine(...collections) {
  const documents = {};
  for (const collection of collections) for (const [actor, input] of Object.entries(collection || {})) {
    const next = validateFullDataReplica(input); if (actor !== next.actor) fail();
    const prior = documents[actor];
    if (!prior || next.clock > prior.clock) documents[actor] = next;
    else if (prior.clock === next.clock && !same(prior, next)) fail();
  }
  if (Object.keys(documents).length > MAX_ACTORS || encoder.encode(JSON.stringify(documents)).length > MAX_METADATA) fail('DATA_SYNC_CAPACITY');
  return documents;
}
function materialize(documents) {
  const groups = new Map(), values = new Map(), conflicts = [];
  for (const document of Object.values(documents)) for (const [key, operation] of Object.entries(document.records)) {
    if (legacyDeviceRecord(...splitIdentity(key))) continue;
    const list = groups.get(key) || []; list.push({ ...copy(operation), actor: document.actor }); groups.set(key, list);
  }
  for (const [key, operations] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const versions = operations.filter((operation) => !operations.some((other) => other !== operation
      && (other.actor === operation.actor ? other.n > operation.n : (other.context[operation.actor] || 0) >= operation.n)))
      .sort((a, b) => Number(b.value === null) - Number(a.value === null) || a.actor.localeCompare(b.actor) || b.n - a.n);
    const winner = versions[0]; if (!winner) fail();
    const distinct = new Set(versions.map((version) => version.value?.digest || null));
    values.set(key, winner.value);
    if (distinct.size > 1) for (const version of versions) conflicts.push({ id: JSON.stringify([key, version.actor, version.n]),
      namespace: splitIdentity(key)[0], key: splitIdentity(key)[1], actor: version.actor, clock: version.n, deleted: version.value === null, reference: version.value });
  }
  return { values, conflicts };
}
const digests = (values) => Object.fromEntries([...values].filter(([, value]) => value !== null).map(([key, value]) => [key, value.digest]));
const difference = (before, next) => [...new Set([...Object.keys(before), ...next.keys()])].filter((key) => before[key] !== next.get(key)?.digest);
function author(document, before, next, observed, forced) {
  // Ordinary edits continue the local branch of an unresolved conflict. They
  // must not acknowledge competing branches or be lost to an older remote
  // choice. Only an explicit whole-record choice observes all competitors.
  const blocked = new Set(materialize(observed).conflicts.map(item => identity(item.namespace, item.key)));
  const result = validateFullDataReplica(document), changed = forced ? [forced.key] : difference(before, next);
  if (!changed.length && result.clock > 0) return result;
  if (result.clock >= Number.MAX_SAFE_INTEGER) fail('DATA_SYNC_CAPACITY');
  const context = Object.fromEntries(Object.values(observed).map((item) => [item.actor, item.clock])); context[result.actor] = result.clock;
  result.clock++;
  for (const key of changed) {
    const causal = !forced && blocked.has(key) ? { ...copy(result.records[key]?.context || {}), [result.actor]: result.clock - 1 } : copy(context);
    result.records[key] = { n: result.clock, context: causal, value: forced ? forced.value : next.get(key) || null };
  }
  return validateFullDataReplica(result);
}

// Nonconflicting records may advance independently. Conflicting records keep
// the complete local value (including local deletion) until an explicit choice.
function retainLocalConflicts(view, local) {
  const values = new Map(view.values);
  for (const item of view.conflicts) {
    const key = identity(item.namespace, item.key);
    values.set(key, local.get(key) || null);
  }
  return values;
}

export function createFullDataSync({ access, snapshotStore, store = defaultStore(), pendingStore = createEncryptedStore('full-data-pending'),
  signer, crypto = globalThis.crypto, uuid = () => crypto.randomUUID(), now = () => Date.now(), locks = globalThis.navigator?.locks,
  seed, autoDelay = 15000, pullInterval = 60000, eventWindow = globalThis.window, eventDocument = globalThis.document } = {}) {
  let conflictPreview;
  let serial = Promise.resolve(), flight, started = false, applying = false, timer, interval, unsubscribe;
  const listeners = new Set();
  let status = { phase: 'idle', pending: 0, conflicts: 0, lastSync: 0, localChanges: false, code: null, message: '' };
  const report = (patch) => { status = { ...status, ...patch }; for (const listener of listeners) { try { listener(copy(status)); } catch {} } return copy(status); };
  const exclusive = (action) => {
    if (locks?.request) return locks.request(LOCK, { mode: 'exclusive' }, action);
    if (globalThis.chrome?.runtime?.id) return Promise.reject(safeError({ code: 'DATA_SYNC_LOCAL' }));
    const next = serial.then(action, action); serial = next.catch(() => {}); return next;
  };
  const hash = async (bytes) => signer?.sha256 ? signer.sha256(bytes) : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const persist = async (config) => { if (encoder.encode(JSON.stringify(config)).length > MAX_METADATA) fail('DATA_SYNC_CAPACITY'); try { await store.write(copy(config)); } catch { fail('DATA_SYNC_LOCAL'); } };
  const read = async () => {
    const config = await store.read() || empty();
    if (!fields(config, ['version', 'metadata']) || config.version !== 1) fail();
    const m = config.metadata;
    if (m) {
      if (!fields(m, ['target', 'document', 'documents', 'base', 'pending', 'publishedClock', 'lastSync']) || !hex(m.target)
        || !Number.isSafeInteger(m.publishedClock) || m.publishedClock < 0 || !Number.isFinite(m.lastSync) || m.lastSync < 0) fail();
      validateFullDataReplica(m.document); combine(m.documents, { [m.document.actor]: m.document });
      if (m.publishedClock > m.document.clock || !m.base || typeof m.base !== 'object' || Array.isArray(m.base) || Object.keys(m.base).length > MAX_RECORDS) fail();
      for (const [key, digest] of Object.entries(m.base)) { splitIdentity(key); if (!hex(digest)) fail(); }
      if (m.pending) {
        const name = parseCloudSnapshotName(m.pending.name);
        if (!fields(m.pending, ['name', 'body', 'uploads']) || !name || name.actor !== m.document.actor || name.clock !== m.document.clock
          || typeof m.pending.body !== 'string' || encoder.encode(m.pending.body).length > CLOUD_OBJECT_LIMIT || !Array.isArray(m.pending.uploads) || m.pending.uploads.length > MAX_CHUNKS) fail();
        for (const item of m.pending.uploads) validateReference({ digest: item.hash, size: item.size, chunks: [item] }, CHUNK);
      }
    }
    if (encoder.encode(JSON.stringify(config)).length > MAX_METADATA) fail('DATA_SYNC_CAPACITY'); return copy(config);
  };
  const knownReferences = (documents) => {
    const chunks = new Map(), values = new Map();
    for (const document of Object.values(documents)) for (const operation of Object.values(document.records)) if (operation.value) {
      values.set(operation.value.digest, operation.value); for (const chunk of operation.value.chunks) chunks.set(chunk.hash, chunk);
    }
    return { chunks, values };
  };
  const cleanupStaging = async (config) => {
    if (typeof pendingStore.entries !== 'function') return;
    const protectedNames = new Set(config.metadata?.pending?.uploads.map((chunk) => chunk.name) || []);
    const documents = [...Object.values(config.metadata?.documents || {}), ...(config.metadata?.document ? [config.metadata.document] : [])];
    for (const document of documents) for (const operation of Object.values(document.records)) {
      for (const chunk of operation.value?.chunks || []) protectedNames.add(chunk.name);
    }
    try {
      for (const [name] of await pendingStore.entries()) if (!protectedNames.has(name)) await pendingStore.remove(name);
    } catch { fail('DATA_SYNC_LOCAL'); }
  };
  const prepareSnapshot = async (snapshot, known, staged) => {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.records) || snapshot.records.length > MAX_RECORDS) fail();
    const values = new Map(); let total = 0;
    for (const record of snapshot.records) {
      if (!fields(record, ['namespace', 'key', 'value'])) fail();
      if (!isSyncRecord(record.namespace, record.key)) fail();
      const key = identity(record.namespace, record.key); if (values.has(key)) fail();
      const bytes = await encodeValue(record.value); total += bytes.length; if (total > MAX_BYTES) fail('DATA_SYNC_CAPACITY');
      const digest = await hash(bytes), prior = known.values.get(digest);
      const reference = prior?.size === bytes.length ? prior : await stageBinary(bytes, known.chunks, staged);
      known.values.set(digest, reference); values.set(key, reference);
    }
    return values;
  };
  async function stageBinary(bytes, known, staged) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const piece = bytes.slice(offset, offset + CHUNK), digest = await hash(piece);
      let chunk = known.get(digest);
      if (chunk && chunk.size !== piece.length) fail();
      if (!chunk) {
        const encrypted = await encryptCloudPayload(piece, staged.password, { crypto });
        const cipherDigest = await hash(encrypted);
        chunk = { hash: digest, size: piece.length, name: `covelet-${cipherDigest.slice(0, 32)}-1-${cipherDigest}.json` };
        try { await pendingStore.set(chunk.name, { body: decoder.decode(encrypted) }); } catch { fail('DATA_SYNC_LOCAL'); }
        known.set(digest, chunk); staged.uploads.set(chunk.name, chunk);
      }
      chunks.push(chunk);
    }
    if (known.size > MAX_CHUNKS) fail('DATA_SYNC_CAPACITY');
    return { digest: await hash(bytes), size: bytes.length, chunks };
  }
  const makeReader = (connection) => {
    const cache = new Map(); let total = 0;
    const piece = async (chunk) => {
      if (cache.has(chunk.name)) return cache.get(chunk.name);
      const work = (async () => {
        await connection.check();
        let body = await pendingStore.get(chunk.name), bytes;
        if (body) { if (typeof body.body !== 'string') fail(); bytes = encoder.encode(body.body); }
        else bytes = await connection.assetProvider.read(chunk.name);
        const name = parseCloudSnapshotName(chunk.name);
        if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CLOUD_OBJECT_LIMIT || await hash(bytes) !== name.digest) fail();
        const plain = await decryptCloudPayload(bytes, connection.password, { crypto });
        if (plain.length !== chunk.size || await hash(plain) !== chunk.hash) fail();
        total += plain.length; if (total > MAX_BYTES + MAX_METADATA || cache.size > MAX_CHUNKS) fail('DATA_SYNC_CAPACITY');
        return plain;
      })();
      cache.set(chunk.name, work); return work;
    };
    return async (reference, limit = MAX_BYTES) => {
      validateReference(reference, limit); const bytes = new Uint8Array(reference.size); let offset = 0;
      for (const chunk of reference.chunks) { const content = await piece(chunk); bytes.set(content, offset); offset += content.length; }
      if (await hash(bytes) !== reference.digest) fail(); return bytes;
    };
  };
  const parseIndex = async (name, bytes, connection, readBinary) => {
    const info = parseCloudSnapshotName(name);
    if (!info || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CLOUD_OBJECT_LIMIT || await hash(bytes) !== info.digest) fail();
    const plain = await decryptCloudPayload(bytes, connection.password, { crypto });
    let index; try { index = JSON.parse(decoder.decode(plain)); } catch { fail(); }
    if (!fields(index, ['format', 'version', 'actor', 'clock', 'createdAt', 'document']) || index.format !== 'covelet-all-data' || index.version !== 1
      || index.actor !== info.actor || index.clock !== info.clock || !Number.isFinite(index.createdAt) || index.createdAt < 0) fail();
    let document; try { document = JSON.parse(decoder.decode(await readBinary(index.document, MAX_METADATA))); } catch (reason) { if (reason?.code) throw reason; fail(); }
    document = validateFullDataReplica(document); if (document.actor !== info.actor || document.clock !== info.clock) fail(); return document;
  };
  const list = async (provider, connection) => {
    await connection.check();
    try { return await provider.list(); }
    catch (reason) {
      const ensure = provider.ensureDirectory || provider.ensureToolDirectory;
      if (reason?.code !== 'CLOUD_NOT_FOUND' || !ensure) throw reason;
      await connection.check(); await ensure.call(provider); return provider.list();
    }
  };
  const fetchDocuments = async (connection, readBinary) => {
    const listing = await list(connection.provider, connection);
    if (!Array.isArray(listing) || listing.length > MAX_REVISIONS) fail('DATA_SYNC_CAPACITY');
    const latest = new Map(), names = new Set();
    for (const item of listing) {
      const identity = parseCloudSnapshotName(item?.name); if (!identity || names.has(item.name)) fail(); names.add(item.name);
      if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > CLOUD_OBJECT_LIMIT)) fail('DATA_SYNC_CAPACITY');
      const prior = latest.get(identity.actor);
      if (!prior || identity.clock > prior.clock) latest.set(identity.actor, { ...identity, name: item.name });
      else if (identity.clock === prior.clock && identity.digest !== prior.digest) fail();
    }
    if (latest.size > MAX_ACTORS) fail('DATA_SYNC_CAPACITY');
    const documents = {};
    for (const item of latest.values()) { await connection.check(); documents[item.actor] = await parseIndex(item.name, await connection.provider.read(item.name), connection, readBinary); }
    return { documents: combine(documents), names };
  };
  const decodeRecords = async (values, readBinary) => {
    const records = []; let total = 0;
    for (const [id, reference] of values) if (reference !== null) {
      total += reference.size; if (total > MAX_BYTES) fail('DATA_SYNC_CAPACITY');
      const [namespace, key] = splitIdentity(id); records.push({ namespace, key, value: decodeValue(await readBinary(reference)) });
    }
    return { version: 1, records };
  };
  const validateConflicts = async (conflicts, readBinary) => {
    for (const item of conflicts) if (item.reference) decodeValue(await readBinary(item.reference));
  };
  const publish = async (config, connection, names = new Set()) => {
    const m = config.metadata, pending = m.pending; if (!pending) return;
    // Verify the persisted index and each staged ciphertext before transmitting.
    const reader = makeReader(connection), document = await parseIndex(pending.name, encoder.encode(pending.body), connection, reader);
    if (!same(document, m.document)) fail();
    if (pending.uploads.length) {
      const ensure = connection.assetProvider.ensureDirectory || connection.assetProvider.ensureToolDirectory;
      if (ensure) { await connection.check(); await ensure.call(connection.assetProvider); }
    }
    for (const chunk of pending.uploads) {
      const staged = await pendingStore.get(chunk.name);
      if (!staged || typeof staged.body !== 'string') fail('DATA_SYNC_LOCAL');
      const bytes = encoder.encode(staged.body), name = parseCloudSnapshotName(chunk.name);
      if (await hash(bytes) !== name.digest) fail();
      const plain = await decryptCloudPayload(bytes, connection.password, { crypto });
      if (plain.length !== chunk.size || await hash(plain) !== chunk.hash) fail();
      await connection.check(); await connection.assetProvider.write(chunk.name, bytes); await connection.check();
    }
    if (!names.has(pending.name)) { await connection.check(); await connection.provider.write(pending.name, encoder.encode(pending.body)); }
    await connection.check(); m.publishedClock = document.clock; m.pending = null; await persist(config);
    // A cleanup failure only leaves encrypted ciphertext; never roll back an
    // acknowledged immutable revision or reuse its filename for another body.
    for (const chunk of pending.uploads) { try { await pendingStore.remove(chunk.name); } catch {} }
  };
  const stagedReferences = async (document, reference) => {
    // A previous CAS/storage failure may have retained an authored operation
    // before constructing its pending index. Recover its already encrypted
    // chunks as well, rather than publishing dangling remote references.
    const all = new Map(reference.chunks.map((chunk) => [chunk.name, chunk]));
    for (const operation of Object.values(document.records)) for (const chunk of operation.value?.chunks || []) all.set(chunk.name, chunk);
    const pending = [];
    for (const chunk of all.values()) if (await pendingStore.get(chunk.name)) pending.push(chunk);
    if (pending.length > MAX_CHUNKS) fail('DATA_SYNC_CAPACITY'); return pending;
  };
  const countPending = (metadata, values) => {
    const changed = new Set(difference(metadata?.base || {}, values));
    if (metadata) for (const [key, operation] of Object.entries(metadata.document.records)) if (operation.n > metadata.publishedClock) changed.add(key);
    return changed.size;
  };
  const inspect = async () => {
    const config = await read(), snapshot = await snapshotStore.snapshot();
    // Inspect hashes only; it must never stage encrypted remote objects.
    const values = new Map();
    for (const record of snapshot.records) values.set(identity(record.namespace, record.key), { digest: await hash(await encodeValue(record.value)) });
    const pending = countPending(config.metadata, values);
    return report({ pending, localChanges: pending > 0, conflicts: config.metadata ? materialize(config.metadata.documents).conflicts.length : 0,
      lastSync: config.metadata?.lastSync || 0 });
  };
  const schedule = () => {
    clearTimeout(timer); if (!started) return;
    timer = setTimeout(async () => { try { const connection = await access(); if (connection.autoSync) await api.syncFullDataNow(); } catch {} }, autoDelay); timer.unref?.();
  };
  const api = {
    getFullDataSyncStatus: () => copy(status),
    subscribeFullDataSyncStatus(listener) { listeners.add(listener); listener(copy(status)); return () => listeners.delete(listener); },
    async loadFullDataSyncSettings() { try { await inspect(); return { configured: Boolean((await read()).metadata) }; } catch (reason) { throw safeError(reason); } },
    async ensureFullDataTarget(target) {
      const config = await read(), m = config.metadata; if (!m || m.target === target) return;
      const snapshot = await snapshotStore.snapshot(), values = new Map();
      for (const record of snapshot.records) values.set(identity(record.namespace, record.key), { digest: await hash(await encodeValue(record.value)) });
      if (m.pending || m.document.clock > m.publishedClock || materialize(m.documents).conflicts.length || countPending(m, values)) fail('DATA_SYNC_TARGET');
    },
    async guardFullDataTarget(target, action) { return exclusive(async () => { try { await api.ensureFullDataTarget(target); return await action(); } catch (reason) { throw safeError(reason); } }); },
    async getFullDataConflicts() {
      try { const config = await read(); return config.metadata ? materialize(config.metadata.documents).conflicts.map(({ reference, ...item }) => ({ ...item, local: item.actor === config.metadata.document.actor, digest: reference?.digest || null })) : []; }
      catch (reason) { throw safeError(reason); }
    },
    clearFullDataConflictPreview() { conflictPreview = undefined; },
    async previewFullDataConflict(id) {
      try {
        return await exclusive(async () => {
          conflictPreview = undefined;
          const config = await read(), m = config.metadata;
          if (!m || m.pending) fail('DATA_SYNC_TARGET');
          const connection = await access(); if (connection.target !== m.target) fail('DATA_SYNC_TARGET'); await connection.check();
          const chosen = materialize(m.documents).conflicts.find(item => item.id === id); if (!chosen) fail('DATA_SYNC_CONFLICT_STALE');
          const snapshot = await snapshotStore.snapshot(), reader = makeReader(connection);
          const local = snapshot.records.find(item => item.namespace === chosen.namespace && item.key === chosen.key);
          const remote = chosen.reference === null ? null : decodeValue(await reader(chosen.reference));
          await connection.check();
          const token = uuid();
          conflictPreview = { id, token, target: m.target, snapshotToken: snapshot.token, documents: await hash(await encodeValue(m.documents)), expiresAt: now() + 600000 };
          return { id, token, namespace: chosen.namespace, key: chosen.key, actor: chosen.actor, clock: chosen.clock,
            local: { deleted: !local, value: local?.value ?? null }, remote: { deleted: chosen.deleted, value: remote } };
        });
      } catch (reason) { throw safeError(reason); }
    },
    async restoreFullDataConflict(id, { discard = false, choice, token } = {}) {
      try {
        return await exclusive(async () => {
          const config = await read(); await cleanupStaging(config);
          const m = config.metadata; if (!m || m.pending) fail('DATA_SYNC_TARGET');
          const connection = await access(); if (connection.target !== m.target) fail('DATA_SYNC_TARGET'); await connection.check();
          const snapshot = await snapshotStore.snapshot();
          if (choice !== undefined || token !== undefined) {
            const preview = conflictPreview;
            if (!['local', 'remote'].includes(choice) || !preview || preview.id !== id || preview.token !== token || preview.target !== m.target
              || preview.snapshotToken !== snapshot.token || preview.expiresAt < now() || preview.documents !== await hash(await encodeValue(m.documents))) fail('DATA_SYNC_CONFLICT_STALE');
            discard = choice === 'local';
          }
          const known = knownReferences(m.documents), staged = { password: connection.password, uploads: new Map() };
          const local = await prepareSnapshot(snapshot, known, staged), authored = author(m.document, m.base, local, m.documents);
          const documents = combine(m.documents, { [authored.actor]: authored }), selection = materialize(documents), chosen = selection.conflicts.find((item) => item.id === id);
          if (!chosen) fail();
          const key = identity(chosen.namespace, chosen.key), reference = discard ? local.get(key) || null : chosen.reference;
          const document = author(authored, digests(local), local, documents, { key, value: reference }), all = combine(documents, { [document.actor]: document });
          const merged = materialize(all), visible = retainLocalConflicts(merged, local), reader = makeReader(connection), next = await decodeRecords(visible, reader); await validateConflicts(merged.conflicts, reader);
          // No remote write happens here. Commit the chosen local record before
          // acknowledging its causal winner: a CAS/validation rejection must
          // leave the conflict unresolved, including active-privacy deletion.
          applying = true; let saved;
          try { saved = await snapshotStore.apply(next, { expectedToken: snapshot.token, wholeRecord: { namespace: chosen.namespace, key: chosen.key } }); } finally { applying = false; }
          m.document = document; m.documents = all; m.base = digests(visible); await persist(config);
          conflictPreview = undefined;
          await inspect(); schedule(); return saved;
        });
      } catch (reason) { throw safeError(reason); }
    },
    async syncFullDataNow() {
      if (flight) return flight;
      flight = exclusive(async () => {
        const config = await read(); await cleanupStaging(config);
        const connection = await access(); await connection.check();
        if (!hex(connection.target) || !connection.provider || !connection.assetProvider) fail();
        const reader = makeReader(connection), incoming = await fetchDocuments(connection, reader), first = !config.metadata || config.metadata.target !== connection.target;
        if (config.metadata?.target !== connection.target) {
          await api.ensureFullDataTarget(connection.target);
          const actor = uuid().replaceAll('-', '').toLowerCase(); if (!actorValid(actor)) fail();
          config.metadata = { target: connection.target, document: { version: 1, actor, clock: 0, records: {} }, documents: {}, base: {}, pending: null, publishedClock: 0, lastSync: 0 };
        }
        const m = config.metadata, ownRemote = incoming.documents[m.document.actor];
        if (ownRemote && (ownRemote.clock > m.document.clock || ownRemote.clock === m.document.clock && !same(ownRemote, m.document))) fail();
        report({ phase: 'syncing', code: null, message: tr('正在同步所有扩展数据和图标。') });
        const received = combine(m.documents, incoming.documents, { [m.document.actor]: m.document });
        const receivedView = materialize(received); await decodeRecords(receivedView.values, reader); await validateConflicts(receivedView.conflicts, reader);
        // Finish the exact previous ciphertext before allocating a new clock.
        await publish(config, connection, incoming.names);
        const actual = await snapshotStore.snapshot(), logical = first && incoming.names.size === 0 && seed ? await seed(copy(actual)) : actual;
        const known = knownReferences(received), staged = { password: connection.password, uploads: new Map() };
        const local = await prepareSnapshot(logical, known, staged), document = author(m.document, m.base, local, m.documents);
        const actualValues = logical === actual ? local : await prepareSnapshot(actual, known, staged);
        const documents = combine(received, { [document.actor]: document }), merged = materialize(documents);
        const visible = retainLocalConflicts(merged, actualValues);
        const next = await decodeRecords(visible, reader); await validateConflicts(merged.conflicts, reader); await connection.check();
        m.document = document; m.documents = combine(m.documents, { [document.actor]: document }); m.base = digests(actualValues); await persist(config);
        // A full snapshot import is a single CAS operation supplied by the
        // encrypted persistence layer. No consumer sees a partial record set.
        applying = true;
        try { await snapshotStore.apply(next, { expectedToken: actual.token }); } finally { applying = false; }
        m.documents = documents; m.base = digests(visible); await persist(config);
        if (document.clock > m.publishedClock) {
          const reference = await stageBinary(encoder.encode(JSON.stringify(document)), known.chunks, staged);
          const bytes = await encryptCloudPayload(encoder.encode(JSON.stringify({ format: 'covelet-all-data', version: 1, actor: document.actor, clock: document.clock, createdAt: now(), document: reference })), connection.password, { crypto });
          m.pending = { name: `covelet-${document.actor}-${document.clock}-${await hash(bytes)}.json`, body: decoder.decode(bytes), uploads: await stagedReferences(document, reference) };
          await persist(config); await publish(config, connection);
        }
        await connection.check(); m.lastSync = now(); await persist(config); await inspect();
        // A protected local visibility marking or a concurrent post-import edit
        // can intentionally differ from the received materialization. Keep it
        // pending and author it in the next normal causal revision.
        if (status.pending) schedule();
        return report({ phase: 'saved', code: null, message: tr('已完成所有数据的加密同步。'), lastSync: m.lastSync, conflicts: merged.conflicts.length });
      }).catch(async (reason) => {
        const safe = safeError(reason); try { await inspect(); } catch {}
        return report({ phase: safe.code === 'CLOUD_LOCKED' ? 'locked' : 'error', code: safe.code, message: safe.message });
      }).finally(() => { flight = undefined; });
      return flight;
    },
    startFullDataSync() {
      if (started) return () => api.stopFullDataSync(); started = true;
      unsubscribe = snapshotStore?.subscribe?.((event) => { if (!applying && event?.source !== 'sync') { inspect().catch(() => {}); schedule(); } });
      const refresh = () => { if (eventDocument?.visibilityState !== 'hidden') schedule(); };
      api._refresh = refresh; eventWindow?.addEventListener?.('focus', refresh); eventDocument?.addEventListener?.('visibilitychange', refresh);
      interval = setInterval(refresh, pullInterval); interval.unref?.(); inspect().then(schedule).catch(() => {}); return () => api.stopFullDataSync();
    },
    stopFullDataSync() {
      started = false; clearTimeout(timer); clearInterval(interval); unsubscribe?.(); unsubscribe = undefined;
      eventWindow?.removeEventListener?.('focus', api._refresh); eventDocument?.removeEventListener?.('visibilitychange', api._refresh);
    },
  };
  return api;
}
