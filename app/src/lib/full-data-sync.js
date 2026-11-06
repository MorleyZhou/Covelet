import { tr } from '../i18n/index.js';
import { isWebdavError } from './cloud-webdav.js';
import { localData, createEncryptedStore } from './local-data.js';
import { encryptCloudPayload, decryptCloudPayload, CLOUD_OBJECT_LIMIT } from './cloud-crypto.js';
import { parseCloudSnapshotName, isCloudProviderError } from './cloud-providers.js';
import { isSyncRecord } from './sync-data-rules.js';
import { sameJson } from './json-equal.js';
import { validateIconBytes } from './site-info.js';
import { ICON_IMAGE_LIMIT } from './icon-image-format.js';

// The remote indexes are small immutable revisions. Typed values and documents
// are separately encrypted, content-addressed chunks so images/recovery points
// do not inherit the old 512 KiB navigation-document limit.
const KEY = 'covelet.data-sync.v1', HISTORY_KEY = 'covelet.data-sync.runs.v1', LOCK = 'covelet.data-sync.lock.v1';
const CHUNK = 256 * 1024, MAX_BYTES = 128 * 1024 * 1024, MAX_METADATA = 8 * 1024 * 1024;
const MAX_RECORDS = 12000, MAX_CHUNKS = 2000, MAX_ACTORS = 100, MAX_REVISIONS = 2000, MAX_RUNS = 20;
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
function defaultStore(key = KEY) {
  return { async read() { return (await localData.get(key))[key] || null; },
    async write(value) { await localData.set({ [key]: value }); } };
}
const groupKeys = (conflicts) => new Set(conflicts.map(({ namespace, key }) => identity(namespace, key)));
const validRunTime = (time) => Number.isSafeInteger(time) && time >= 0 && time <= 8.64e15;
const validRunRef = (item) => item && actorValid(item.id) && validRunTime(item.startedAt);
const PREVIEW_IMAGES = new Set(['assets', 'navigation-icons', 'provider-icons', 'wallpaper']);
const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

async function readPreviewImage(blob) {
  if (!(blob instanceof Blob) || !PREVIEW_TYPES.has(blob.type) || !blob.size || blob.size > ICON_IMAGE_LIMIT) return;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  validateIconBytes(bytes, blob.type);
  const image = await globalThis.createImageBitmap(blob);
  try {
    if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1
      || image.width > 4096 || image.height > 4096 || image.width * image.height > 4_000_000) return;
    return { blob, bytes, width: image.width, height: image.height };
  } finally { image.close?.(); }
}

async function conflictPreviewImage(namespace, key, value) {
  if (!PREVIEW_IMAGES.has(namespace) || !value || typeof globalThis.createImageBitmap !== 'function') return;
  if (namespace === 'navigation-icons' && (value.url !== key || typeof value.adaptive !== 'boolean'
    || value.adaptive !== (value.darkBlob !== undefined))) return;
  if ((namespace === 'provider-icons' && value.origin !== key) || (namespace === 'assets' && value.id !== key)) return;
  try {
    const light = await readPreviewImage(value.blob);
    if (!light || namespace === 'navigation-icons' && (value.width !== light.width || value.height !== light.height)) return;
    const media = { blob: light.blob, width: light.width, height: light.height };
    let dark;
    if (value.darkBlob !== undefined) {
      dark = await readPreviewImage(value.darkBlob);
      if (!dark || dark.width !== light.width || dark.height !== light.height) return;
      media.darkBlob = dark.blob;
    }
    return { media, light, dark };
  } catch { /* Bad or unsupported artwork can still be resolved by its record summary. */ }
}

function equalPreviewImage(left, right) {
  if (!left || !right) return left === right;
  return left.blob.type === right.blob.type && left.bytes.length === right.bytes.length
    && left.bytes.every((byte, index) => byte === right.bytes[index]);
}
const messages = {
  get LOCAL_DATA_PRIVACY_CONFLICT() { return tr('此删除版本会移除当前隐藏内容的标记，请先在本机解除隐藏，再重新选择。'); },
  get DATA_SYNC_CONFLICT_STALE() { return tr('冲突已变化，请同步后重试。'); },
  get DATA_SYNC_INVALID() { return tr('同步数据无效，本机数据已保留。'); },
  get DATA_SYNC_CAPACITY() { return tr('同步数据超出容量限制，本机数据已保留。'); },
  get DATA_SYNC_LOCAL() { return tr('无法保存同步状态，尚未确认上传。'); },
  get DATA_SYNC_TARGET() { return tr('还有待上传内容或冲突版本，请处理后再切换存储位置。'); },
  get DATA_SYNC_REQUEST() { return tr('同步未完成，请检查连接后重试；本机数据已保留。'); },
  get CLOUD_LOCKED() { return tr('请先解锁存储连接，再开始同步。'); },
  get CLOUD_PERMISSION() { return tr('尚未授权访问这个云服务，请先在设置中授权。'); },
  get CLOUD_UNAVAILABLE() { return tr('请加载 Chrome 或 Edge 扩展，再授权使用云同步。'); },
  get CLOUD_DECRYPT() { return tr('无法解密云端数据。请确认使用了原来的同步密码。'); },
  get REVISION_CONFLICT() { return tr('数据已在其他页面更新，本次未覆盖，请重新同步。'); },
};
function safeError(reason) {
  if (isWebdavError(reason) || isCloudProviderError(reason)) return reason;
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

function replaceReplica(document, selected, observed) {
  const result = validateFullDataReplica(document);
  if (result.clock >= Number.MAX_SAFE_INTEGER) fail('DATA_SYNC_CAPACITY');
  const context = Object.fromEntries(Object.values(observed).map(item => [item.actor, item.clock]));
  context[result.actor] = result.clock;
  const keys = new Set([...materialize(observed).values.keys(), ...selected.keys()]);
  result.clock++;
  result.records = Object.fromEntries([...keys].map(key => [key, { n: result.clock, context, value: selected.get(key) ?? null }]));
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

export function createFullDataSync({ access, currentTarget, snapshotStore, store = snapshotStore?.syncMetadataStore || defaultStore(), historyStore = defaultStore(HISTORY_KEY), pendingStore = createEncryptedStore('full-data-pending'),
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
  const gitOid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  function validatePending(pending, document) {
    const name = parseCloudSnapshotName(pending?.name);
    if (!fields(pending, ['name', 'body', 'uploads']) || !name || name.actor !== document.actor || name.clock !== document.clock
      || typeof pending.body !== 'string' || encoder.encode(pending.body).length > CLOUD_OBJECT_LIMIT || !Array.isArray(pending.uploads) || pending.uploads.length > MAX_CHUNKS) fail();
    for (const item of pending.uploads) validateReference({ digest: item.hash, size: item.size, chunks: [item] }, CHUNK);
  }
  const read = async () => {
    const config = await store.read() || empty();
    if (!fields(config, ['version', 'metadata']) || config.version !== 1) fail();
    const m = config.metadata;
    if (m) {
      const keys = ['target', 'document', 'documents', 'base', 'pending', 'publishedClock', 'lastSync'];
      if (own(m, 'resolutionId')) keys.push('resolutionId', 'resolutionClock');
      if (own(m, 'cleanup')) keys.push('cleanup');
      if (own(m, 'cleanupOutcome')) keys.push('cleanupOutcome');
      if (own(m, 'gitEpoch')) keys.push('gitEpoch');
      if (own(m, 'gitReset')) keys.push('gitReset');
      if (!fields(m, keys) || !hex(m.target) || own(m, 'resolutionId') && (!actorValid(m.resolutionId) || !Number.isSafeInteger(m.resolutionClock) || m.resolutionClock < 1)
        || !Number.isSafeInteger(m.publishedClock) || m.publishedClock < 0 || !Number.isFinite(m.lastSync) || m.lastSync < 0) fail();
      validateFullDataReplica(m.document); combine(m.documents, { [m.document.actor]: m.document });
      if (m.publishedClock > m.document.clock || m.resolutionClock > m.document.clock || !m.base || typeof m.base !== 'object' || Array.isArray(m.base) || Object.keys(m.base).length > MAX_RECORDS) fail();
      for (const [key, digest] of Object.entries(m.base)) { splitIdentity(key); if (!hex(digest)) fail(); }
      if (m.pending) validatePending(m.pending, m.document);
      if (own(m, 'gitEpoch') && !parseCloudSnapshotName(m.gitEpoch)) fail();
      if (own(m, 'gitReset')) {
        const plan = m.gitReset;
        if (!fields(plan, ['id', 'head', 'document', 'pending', 'candidate']) || !actorValid(plan.id)
          || !gitOid(plan.head) || plan.candidate !== null && !gitOid(plan.candidate)) fail();
        validateFullDataReplica(plan.document);
        validatePending(plan.pending, plan.document);
      }
      if (own(m, 'cleanup')) {
        const cleanup = m.cleanup, index = parseCloudSnapshotName(cleanup?.index);
        if (!fields(cleanup, ['index', 'obsolete']) || !index || index.actor !== m.document.actor || index.clock !== m.resolutionClock
          || !Array.isArray(cleanup.obsolete) || cleanup.obsolete.length > MAX_REVISIONS || new Set(cleanup.obsolete).size !== cleanup.obsolete.length
          || cleanup.obsolete.some(name => !parseCloudSnapshotName(name) || name === cleanup.index)) fail();
      }
      if (own(m, 'cleanupOutcome') && (!m.resolutionId || !['indexes-cleaned', 'retained', 'files-cleaned'].includes(m.cleanupOutcome))) fail();
    }
    if (encoder.encode(JSON.stringify(config)).length > MAX_METADATA) fail('DATA_SYNC_CAPACITY'); return copy(config);
  };
  async function readHistory(target) {
    const empty = { runs: [], origins: {} };
    if (!target) return empty;
    try {
      const history = await historyStore.read();
      if (history?.version !== 1 || history.target !== target || !Array.isArray(history.runs) || history.runs.length > MAX_RUNS
        || !history.origins || typeof history.origins !== 'object' || Array.isArray(history.origins) || Object.keys(history.origins).length > MAX_RECORDS) return empty;
      return {
        runs: history.runs.filter(item => validRunRef(item) && validRunTime(item.finishedAt) && item.finishedAt >= item.startedAt
          && ['success', 'failure', 'conflict'].includes(item.outcome) && Number.isSafeInteger(item.newConflictCount)
          && item.newConflictCount >= 0).map(({ id, startedAt, finishedAt, outcome, newConflictCount, conflictCount }) => ({
          id, startedAt, finishedAt, outcome, newConflictCount, ...(Number.isSafeInteger(conflictCount) && conflictCount >= 0 && { conflictCount }),
        })),
        origins: history.origins,
      };
    } catch { return empty; }
  }
  async function recordRun(run, outcome) {
    if (!run.target) return;
    // The history shares the sync lock but lives apart from the protocol state.
    // Unavailable history storage must not alter a completed sync's outcome.
    try {
      const history = await readHistory(run.target);
      const previous = history.runs.find(item => item.id === run.id);
      const discoveredIn = { id: run.id, startedAt: previous?.startedAt ?? run.startedAt };
      let newConflictCount = previous?.newConflictCount || 0;
      let origins = history.origins;
      if (run.after) {
        origins = {};
        let originCount = 0;
        for (const key of run.after) {
          const isNew = !run.before.has(key);
          if (isNew) newConflictCount++;
          if (originCount === MAX_RECORDS) continue;
          const digest = await hash(encoder.encode(key));
          const origin = isNew ? discoveredIn : history.origins[digest];
          if (validRunRef(origin)) { origins[digest] = origin; originCount++; }
        }
      }
      const entry = { ...discoveredIn, finishedAt: Math.max(run.startedAt, now()), outcome, newConflictCount, conflictCount: run.after?.size ?? 0 };
      await historyStore.write({ version: 1, target: run.target, runs: [entry, ...history.runs.filter(item => item.id !== run.id)].slice(0, MAX_RUNS), origins });
    } catch { /* Keep the sync result independent from history. */ }
  }
  const knownReferences = (documents) => {
    const chunks = new Map(), values = new Map();
    for (const document of Object.values(documents)) for (const operation of Object.values(document.records)) if (operation.value) {
      values.set(operation.value.digest, operation.value); for (const chunk of operation.value.chunks) chunks.set(chunk.hash, chunk);
    }
    return { chunks, values };
  };
  const cleanupStaging = async (config) => {
    if (typeof pendingStore.entries !== 'function') return;
    const pending = config.metadata?.pending;
    const protectedNames = new Set();
    for (const checkpoint of [pending, config.metadata?.gitReset?.pending]) if (checkpoint) {
      protectedNames.add(checkpoint.name);
      for (const chunk of checkpoint.uploads) protectedNames.add(chunk.name);
    }
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
  const makeReader = (connection, ref, allowStaged = ref === undefined) => {
    const cache = new Map(); let total = 0;
    const piece = async (chunk) => {
      if (cache.has(chunk.name)) return cache.get(chunk.name);
      const work = (async () => {
        await connection.check();
        let body = allowStaged ? await pendingStore.get(chunk.name) : undefined, bytes;
        if (body) { if (typeof body.body !== 'string') fail(); bytes = encoder.encode(body.body); }
        else bytes = await connection.assetProvider.read(chunk.name, ref);
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
  const parseIndexHeader = async (name, bytes, connection) => {
    const info = parseCloudSnapshotName(name);
    if (!info || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CLOUD_OBJECT_LIMIT || await hash(bytes) !== info.digest) fail();
    const plain = await decryptCloudPayload(bytes, connection.password, { crypto });
    let index; try { index = JSON.parse(decoder.decode(plain)); } catch { fail(); }
    if (!fields(index, ['format', 'version', 'actor', 'clock', 'createdAt', 'document']) || index.format !== 'covelet-all-data' || index.version !== 1
      || index.actor !== info.actor || index.clock !== info.clock || !Number.isFinite(index.createdAt) || index.createdAt < 0) fail();
    validateReference(index.document, MAX_METADATA);
    return index;
  };
  const readIndexDocument = async (index, readBinary) => {
    let document; try { document = JSON.parse(decoder.decode(await readBinary(index.document, MAX_METADATA))); } catch (reason) { if (reason?.code) throw reason; fail(); }
    document = validateFullDataReplica(document); if (document.actor !== index.actor || document.clock !== index.clock) fail(); return document;
  };
  const parseIndex = async (name, bytes, connection, readBinary) => readIndexDocument(await parseIndexHeader(name, bytes, connection), readBinary);
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
    const ref = connection.git?.pin.head;
    const listing = connection.git ? connection.git.files.indexes : await list(connection.provider, connection);
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
    for (const item of latest.values()) { await connection.check(); documents[item.actor] = await parseIndex(item.name, await connection.provider.read(item.name, ref), connection, readBinary); }
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
  async function finishIndexCleanup(config, connection, run) {
    const m = config.metadata, plan = m.cleanup;
    if (!plan) return;
    let outcome = 'retained';
    try {
      await connection.check();
      const head = await connection.provider.pinIndexes();
      const listed = await connection.provider.list(head);
      const names = new Set(listed.map(item => item.name));
      const obsolete = new Set(plan.obsolete);
      if (!names.has(plan.index) || [...names].some(name => name !== plan.index && !obsolete.has(name))) fail('DATA_SYNC_CONFLICT_STALE');

      // Read the new index and every record from a fixed remote commit. The
      // staging store must never satisfy a restore verification read.
      const reader = makeReader(connection, head);
      const document = await parseIndex(plan.index, await connection.provider.read(plan.index, head), connection, reader);
      const { values } = materialize({ [document.actor]: document });
      if (!same(document, m.document) || !same(digests(values), m.base)) fail();
      await decodeRecords(values, reader);

      const candidates = plan.obsolete.filter(name => names.has(name));
      for (const name of candidates) {
        await connection.check();
        await parseIndexHeader(name, await connection.provider.read(name, head), connection);
      }
      // Old clients can still hold references to historical chunks. Keep the
      // blobs so deleting obsolete indexes cannot break an in-flight writer.
      if (candidates.length) await connection.provider.pruneIndexes(head, candidates);
      outcome = 'indexes-cleaned';
    } catch (reason) {
      if (['CLOUD_TIMEOUT', 'CLOUD_NETWORK', 'CLOUD_OFFLINE', 'CLOUD_RATE_LIMIT', 'CLOUD_LOCKED'].includes(reason?.code)) outcome = 'deferred';
    }
    run.cleanup = outcome;
    if (outcome === 'deferred') return;
    delete m.cleanup;
    m.cleanupOutcome = outcome;
    // The chosen snapshot is already published. Keep an unacknowledged plan
    // replayable if this local write fails, without reporting a sync failure.
    try { await persist(config); }
    catch { m.cleanup = plan; delete m.cleanupOutcome; run.cleanup = 'deferred'; }
  }
  const validateConflicts = async (conflicts, readBinary) => {
    for (const item of conflicts) if (item.reference) decodeValue(await readBinary(item.reference));
  };
  function referencedChunks(document, header) {
    const names = new Set(header.document.chunks.map(chunk => chunk.name));
    for (const operation of Object.values(document.records)) {
      for (const chunk of operation.value?.chunks || []) names.add(chunk.name);
    }
    return names;
  }
  async function githubAdditions(pending, document, connection, tracked = new Set()) {
    const bytes = encoder.encode(pending.body);
    const header = await parseIndexHeader(pending.name, bytes, connection);
    const required = referencedChunks(document, header);
    const uploads = new Map(pending.uploads.map(chunk => [chunk.name, chunk]));
    const { storage } = connection.git, additions = [];
    let checkpoint;
    try { checkpoint = (await pendingStore.get(pending.name))?.git; } catch { /* The same bytes can be uploaded again. */ }
    checkpoint = checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint) ? checkpoint : {};
    const upload = async (kind, name, content) => {
      let sha = checkpoint[name];
      if (!gitOid(sha)) {
        await connection.check();
        sha = await storage.uploadBlob(content);
        if (!gitOid(sha)) fail();
        checkpoint[name] = sha;
        await pendingStore.set(pending.name, { git: checkpoint });
      }
      additions.push({ kind, name, sha });
    };
    for (const name of required) {
      if (tracked.has(name)) continue;
      const chunk = uploads.get(name), stored = chunk && await pendingStore.get(name);
      if (!stored || typeof stored.body !== 'string') fail();
      const content = encoder.encode(stored.body);
      if (await hash(content) !== parseCloudSnapshotName(name).digest) fail();
      await upload('blob', name, content);
    }
    await upload('index', pending.name, bytes);
    return { additions, required };
  }
  async function refreshGithub(connection, pin, layout) {
    const storage = connection.git.storage;
    const files = await storage.files(pin, layout.layout);
    if (layout.epoch && !files.indexes.some(file => file.name === layout.epoch)) fail();
    connection.git = { storage, pin, files, ...layout };
  }
  async function githubConnection(connection, needsPin) {
    const storage = connection.provider.githubStorage;
    if (!storage || !connection.githubV2) return connection;
    const current = await storage.readLayout();
    if (current.layout === 'v1' && !needsPin) return connection;
    const pin = await storage.pin(), layout = await storage.readLayout(pin);
    const next = { ...connection, ...(layout.layout === 'v2' && connection.githubV2), git: { storage } };
    await refreshGithub(next, pin, layout);
    return next;
  }
  async function publishGitHub(pending, document, connection) {
    const git = connection.git;
    if (git.files.indexes.some(file => file.name === pending.name)) return;
    const tracked = new Set(git.files.blobs.map(file => file.name));
    const { additions } = await githubAdditions(pending, document, connection, tracked);
    const candidate = await git.storage.prepare(git.pin, { additions });
    await connection.check();
    await git.storage.advance(git.pin, candidate);
    // A single run may publish its resumed revision and then a new local edit.
    // Refresh the pinned tree so the second write also has an exact parent.
    const pin = await git.storage.pin(candidate);
    await refreshGithub(connection, pin, { layout: 'v2', epoch: git.epoch });
  }
  const publish = async (config, connection, names = new Set()) => {
    const m = config.metadata, pending = m.pending; if (!pending) return;
    // Verify the persisted index and each staged ciphertext before transmitting.
    const reader = makeReader(connection, connection.git?.pin.head, true);
    const document = await parseIndex(pending.name, encoder.encode(pending.body), connection, reader);
    if (!same(document, m.document)) fail();
    if (connection.git?.layout === 'v2') {
      await publishGitHub(pending, document, connection);
    } else {
      let acknowledged = 0;
      try {
        const progress = await pendingStore.get(pending.name);
        if (fields(progress, ['acknowledged']) && Number.isSafeInteger(progress.acknowledged)
          && progress.acknowledged >= 0 && progress.acknowledged <= pending.uploads.length) acknowledged = progress.acknowledged;
      } catch { /* Missing progress only requires checking the same immutable chunks again. */ }
      if (acknowledged < pending.uploads.length) {
        const ensure = connection.assetProvider.ensureDirectory || connection.assetProvider.ensureToolDirectory;
        if (ensure) { await connection.check(); await ensure.call(connection.assetProvider); }
      }
      for (let index = acknowledged; index < pending.uploads.length; index++) {
        const chunk = pending.uploads[index];
        const staged = await pendingStore.get(chunk.name);
        if (!staged || typeof staged.body !== 'string') fail('DATA_SYNC_LOCAL');
        const bytes = encoder.encode(staged.body), name = parseCloudSnapshotName(chunk.name);
        if (await hash(bytes) !== name.digest) fail();
        const plain = await decryptCloudPayload(bytes, connection.password, { crypto });
        if (plain.length !== chunk.size || await hash(plain) !== chunk.hash) fail();
        await connection.check(); await connection.assetProvider.write(chunk.name, bytes); await connection.check();
        // The encrypted checkpoint is keyed by the immutable index name. A
        // response lost before acknowledgement still uses a same-bytes retry.
        try { await pendingStore.set(pending.name, { acknowledged: index + 1 }); } catch { /* Do not invalidate the verified upload. */ }
      }
      if (!names.has(pending.name)) { await connection.check(); await connection.provider.write(pending.name, encoder.encode(pending.body)); }
    }
    await connection.check(); m.publishedClock = document.clock; m.pending = null; await persist(config);
    // A cleanup failure only leaves encrypted ciphertext; never roll back an
    // acknowledged immutable revision or reuse its filename for another body.
    for (const chunk of pending.uploads) { try { await pendingStore.remove(chunk.name); } catch {} }
    try { await pendingStore.remove(pending.name); } catch {}
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
  async function stageRevision(document, known, staged, connection) {
    const reference = await stageBinary(encoder.encode(JSON.stringify(document)), known.chunks, staged);
    const bytes = await encryptCloudPayload(encoder.encode(JSON.stringify({ format: 'covelet-all-data', version: 1,
      actor: document.actor, clock: document.clock, createdAt: now(), document: reference })), connection.password, { crypto });
    return { name: `covelet-${document.actor}-${document.clock}-${await hash(bytes)}.json`, body: decoder.decode(bytes), uploads: await stagedReferences(document, reference) };
  }
  function checkOwnRevision(metadata, incoming) {
    const ownRemote = incoming.documents[metadata.document.actor];
    if (ownRemote && (ownRemote.clock > metadata.document.clock || ownRemote.clock === metadata.document.clock && !same(ownRemote, metadata.document))) fail();
  }
  async function cloudSnapshot(incoming, actor, connection, reader) {
    const view = materialize(incoming.documents);
    // Old clients could publish their divergent branch before stopping at a
    // conflict. Use the last index before that branch, retaining shared data
    // from this device without treating its rejected branch as the cloud copy.
    const divergence = view.conflicts.filter(item => item.actor === actor).reduce((clock, item) => Math.min(clock, item.clock), Infinity);
    if (!Number.isFinite(divergence)) return view.values;
    const cloud = { ...incoming.documents };
    delete cloud[actor];
    let prior;
    for (const name of incoming.names) {
      const index = parseCloudSnapshotName(name);
      if (index.actor === actor && index.clock < divergence && (!prior || index.clock > prior.clock)) prior = { name, clock: index.clock };
    }
    if (prior) {
      await connection.check();
      cloud[actor] = await parseIndex(prior.name, await connection.provider.read(prior.name, connection.git?.pin.head), connection, reader);
    }
    return materialize(cloud).values;
  }
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
    return report({ pending, localChanges: pending > 0, conflicts: config.metadata ? groupKeys(materialize(config.metadata.documents).conflicts).size : 0,
      lastSync: config.metadata?.lastSync || 0 });
  };
  const schedule = () => {
    clearTimeout(timer); if (!started) return;
    timer = setTimeout(async () => { try { const connection = await access(); if (connection.autoSync) await api.syncFullDataNow(); } catch {} }, autoDelay); timer.unref?.();
  };
  async function finishGithubReset(config, connection, run) {
    const m = config.metadata, plan = m.gitReset, git = connection.git;
    if (!git || !connection.githubV2) fail();
    if (git.epoch !== plan.pending.name) {
      if (git.pin.head !== plan.head) {
        delete m.gitReset;
        await persist(config);
        fail('DATA_SYNC_CONFLICT_STALE');
      }
      if (!plan.candidate) {
        const files = git.layout === 'v2' ? git.files : await git.storage.files(git.pin, 'v2');
        const { additions, required } = await githubAdditions(plan.pending, plan.document, connection);
        const deletions = [
          ...files.indexes.filter(file => file.name !== plan.pending.name).map(file => ({ kind: 'index', name: file.name })),
          ...files.blobs.filter(file => !required.has(file.name)).map(file => ({ kind: 'blob', name: file.name })),
        ];
        plan.candidate = await git.storage.prepare(git.pin, { additions, deletions, seal: plan.pending.name });
        await persist(config);
      }
      try { await verifyGithubReset(plan, connection); }
      catch (reason) {
        if (['DATA_SYNC_INVALID', 'CLOUD_INVALID_RESPONSE', 'CLOUD_INTEGRITY', 'CLOUD_NOT_FOUND'].includes(reason?.code)) {
          delete m.gitReset;
          await persist(config);
        }
        throw reason;
      }
      await connection.check();
      try { await git.storage.advance(git.pin, plan.candidate); }
      catch (reason) {
        if (reason?.code === 'CLOUD_STALE_HEAD') { delete m.gitReset; await persist(config); }
        throw reason;
      }
    }
    // An interrupted update may already have committed. The marker identifies
    // the exact previously verified replacement, even after a later commit.
    const document = plan.document, documents = { [document.actor]: document };
    config.metadata = { target: m.target, document, documents, base: digests(materialize(documents).values),
      pending: null, publishedClock: document.clock, lastSync: now(), gitEpoch: plan.pending.name,
      resolutionId: plan.id, resolutionClock: document.clock, cleanupOutcome: 'files-cleaned' };
    await persist(config);
    run.after = new Set();
    run.cleanup = 'files-cleaned';
    run.postPublishCleanup = true;
    return 'replayed';
  }
  async function verifyGithubReset(plan, connection) {
    // Detached commits are readable before they replace the branch contents.
    const candidate = { ...connection, ...connection.githubV2 }, { storage } = connection.git;
    const pin = await storage.pin(plan.candidate);
    const layout = await storage.readLayout(pin), files = await storage.files(pin, 'v2');
    if (layout.epoch !== plan.pending.name || files.indexes.length !== 1 || files.indexes[0].name !== plan.pending.name) fail();
    const reader = makeReader(candidate, plan.candidate);
    const header = await parseIndexHeader(plan.pending.name, await candidate.provider.read(plan.pending.name, plan.candidate), candidate);
    const document = await readIndexDocument(header, reader);
    if (!same(document, plan.document)) fail();
    const required = referencedChunks(document, header);
    if (files.blobs.length !== required.size || files.blobs.some(file => !required.has(file.name))) fail();
    await decodeRecords(materialize({ [document.actor]: document }).values, reader);
  }
  async function resetGithubSnapshot(config, connection, run) {
    const m = config.metadata, git = connection.git;
    if (!m || m.target !== connection.target || m.gitEpoch !== (git.epoch || undefined)) fail('DATA_SYNC_CONFLICT_STALE');
    const incoming = await fetchDocuments(connection, makeReader(connection, git.pin.head));
    checkOwnRevision(m, incoming);
    const observed = combine(m.documents, incoming.documents, { [m.document.actor]: m.document });
    if (!materialize(observed).conflicts.length) fail('DATA_SYNC_CONFLICT_STALE');
    const actual = await snapshotStore.snapshot();
    // Build a self-contained revision from local data so the new epoch has no
    // references to chunks or rejected values in the previous epoch.
    const known = knownReferences({}), staged = { password: connection.password, uploads: new Map() };
    const selected = await prepareSnapshot(actual, known, staged);
    const actor = uuid().replaceAll('-', '').toLowerCase();
    const document = replaceReplica({ version: 1, actor, clock: 0, records: {} }, selected, {});
    m.gitReset = { id: run.id, head: git.pin.head, document, pending: await stageRevision(document, known, staged, connection), candidate: null };
    await persist(config);
    return finishGithubReset(config, connection, run);
  }
  async function adoptGithubEpoch(config, connection, run) {
    const m = config.metadata, git = connection.git;
    const actual = await snapshotStore.snapshot();
    const reader = makeReader(connection, git.pin.head);
    const { documents } = await fetchDocuments(connection, reader);
    const view = materialize(documents);
    const snapshot = await decodeRecords(view.values, reader);
    await validateConflicts(view.conflicts, reader);
    const actor = uuid().replaceAll('-', '').toLowerCase();
    const document = documents[actor] || { version: 1, actor, clock: 0, records: {} };
    config.metadata = { target: m.target, document, documents, base: digests(view.values), pending: null,
      publishedClock: document.clock, lastSync: m.lastSync, gitEpoch: git.epoch };
    const localDigests = new Map();
    for (const item of actual.records) localDigests.set(identity(item.namespace, item.key), { digest: await hash(await encodeValue(item.value)) });
    const edited = new Set(difference(m.base, localDigests));
    const unsent = Object.keys(m.document.records).filter(key => m.document.records[key].n > m.publishedClock);
    for (const key of unsent) edited.add(key);
    for (const key of edited) if (localDigests.get(key)?.digest === view.values.get(key)?.digest) edited.delete(key);
    if (edited.size) {
      // Local edits made since the previous checkpoint still need a decision.
      // Re-author only those edits against the new epoch's cloud versions.
      const known = knownReferences(documents), staged = { password: connection.password, uploads: new Map() };
      const next = await prepareSnapshot({ version: 1, records: actual.records.filter(item => edited.has(identity(item.namespace, item.key))) }, known, staged);
      const baseline = Object.fromEntries(Object.entries(m.base).filter(([key]) => edited.has(key)));
      for (const key of unsent) if (edited.has(key)) baseline[key] = '';
      config.metadata.document = author(document, baseline, next, {});
      config.metadata.documents = combine(documents, { [actor]: config.metadata.document });
      config.metadata.base = digests(localDigests);
      const merged = materialize(config.metadata.documents);
      run.after = groupKeys(merged.conflicts);
      if (run.after.size) { await persist(config); return 'conflict'; }
      const mergedSnapshot = await decodeRecords(merged.values, makeReader(connection, git.pin.head, true));
      config.metadata.base = digests(merged.values);
      await applyEpoch(mergedSnapshot);
      return syncSnapshot(config, connection, run);
    }
    run.after = groupKeys(view.conflicts);
    if (run.after.size) {
      config.metadata.base = digests(localDigests);
      await persist(config);
      return 'conflict';
    }
    await applyEpoch(snapshot);
    return undefined;

    async function applyEpoch(next) {
      await connection.check();
      applying = true;
      try {
        const atomic = snapshotStore.syncMetadataStore === store;
        await snapshotStore.apply(next, { expectedToken: actual.token, ...(atomic && { syncMetadata: config }) });
        if (!atomic) await persist(config);
      } finally { applying = false; }
    }
  }
  function transfer(work, { taskId, expectedTarget } = {}, choice) {
    if (flight) return flight;
    let afterSync;
    report({ phase: 'syncing', code: null, message: tr('正在同步…'), cleanup: null });
    flight = exclusive(async () => {
      const id = typeof taskId === 'string' ? taskId.replaceAll('-', '') : '';
      const run = { id: actorValid(id) ? id : crypto.randomUUID().replaceAll('-', ''), startedAt: now(), before: new Set(), after: null };
      try { run.target = await currentTarget?.(); } catch { /* Access performs its own validation. */ }
      try {
        if (expectedTarget && run.target && run.target !== expectedTarget) { run.target = undefined; fail('CLOUD_LOCKED'); }
        const config = await read(); await cleanupStaging(config);
        let connection = await access({ expectedTarget });
        if (!hex(connection.target) || !connection.provider || !connection.assetProvider) fail();
        if (expectedTarget && connection.target !== expectedTarget) fail('CLOUD_LOCKED');
        run.target = connection.target;
        const metadata = config.metadata?.target === connection.target ? config.metadata : null;
        connection = await githubConnection(connection, choice === 'local' || Boolean(metadata?.gitReset));
        if (config.metadata?.target === connection.target) run.before = groupKeys(materialize(config.metadata.documents).conflicts);
        run.after = run.before;
        await connection.check();
        let result;
        if (choice === 'remote' && metadata?.gitReset && connection.git?.epoch !== metadata.gitReset.pending.name) {
          delete metadata.gitReset;
          await persist(config);
        }
        if (metadata?.gitReset) result = await finishGithubReset(config, connection, run);
        else if (metadata?.gitEpoch && connection.git?.layout !== 'v2') fail('DATA_SYNC_CONFLICT_STALE');
        else if (metadata && connection.git?.layout === 'v2' && metadata.gitEpoch !== connection.git.epoch) {
          result = await adoptGithubEpoch(config, connection, run);
        } else if (choice === 'local' && connection.git) {
          if (metadata?.resolutionId === run.id && metadata.cleanupOutcome === 'files-cleaned') {
            run.cleanup = 'files-cleaned'; run.postPublishCleanup = true; result = 'replayed';
          } else if (metadata?.resolutionId === run.id) result = await work(config, connection, run);
          else result = await resetGithubSnapshot(config, connection, run);
        } else result = await work(config, connection, run);
        if (result === 'conflict') {
          await inspect(); await recordRun(run, 'conflict');
          return report({ phase: 'conflict', code: null, message: tr('有冲突待处理'), conflicts: run.after.size });
        }
        // Optional cleanup runs after the sync checkpoint. A concurrent local
        // lock can suspend cleanup without invalidating the published snapshot.
        if (!run.cleanup || !run.postPublishCleanup) await connection.check();
        if (result !== 'replayed') { config.metadata.lastSync = now(); await persist(config); }
        await inspect(); await recordRun(run, 'success');
        if (status.pending) schedule();
        afterSync = connection.afterSync;
        return report({ phase: 'saved', code: null, message: tr('同步完成。'), lastSync: config.metadata.lastSync, conflicts: run.after.size,
          ...(run.cleanup && { cleanup: run.cleanup }) });
      } catch (reason) {
        await recordRun(run, 'failure');
        throw reason;
      }
    }).then(async (result) => {
      // Credential migration can acquire the config lock. Wait until the
      // sync lock has been released to preserve the lock acquisition order.
      await afterSync?.();
      return result;
    }).catch(async (reason) => {
      const safe = safeError(reason); try { await inspect(); } catch {}
      return report({ phase: safe.code === 'CLOUD_LOCKED' ? 'locked' : 'error', code: safe.code, message: safe.message });
    }).finally(() => { flight = undefined; });
    return flight;
  }

  async function syncSnapshot(config, connection, run) {
    const ref = connection.git?.pin.head, reader = makeReader(connection, ref, true);
    const incoming = await fetchDocuments(connection, ref ? makeReader(connection, ref) : reader), first = !config.metadata || config.metadata.target !== connection.target;
    if (first) {
      await api.ensureFullDataTarget(connection.target);
      const actor = uuid().replaceAll('-', '').toLowerCase(); if (!actorValid(actor)) fail();
      config.metadata = { target: connection.target, document: { version: 1, actor, clock: 0, records: {} }, documents: {}, base: {}, pending: null, publishedClock: 0, lastSync: 0 };
      if (connection.git?.epoch) config.metadata.gitEpoch = connection.git.epoch;
    }
    const m = config.metadata;
    checkOwnRevision(m, incoming);
    const received = combine(m.documents, incoming.documents, { [m.document.actor]: m.document });
    const receivedView = materialize(received); await decodeRecords(receivedView.values, reader); await validateConflicts(receivedView.conflicts, reader);
    // Finish the exact previous ciphertext before allocating a new clock.
    await publish(config, connection, incoming.names);
    if (m.cleanup) {
      await finishIndexCleanup(config, connection, run);
      if (run.cleanup === 'deferred') return 'replayed';
    }
    const actual = await snapshotStore.snapshot(), logical = first && incoming.names.size === 0 && seed ? await seed(copy(actual)) : actual;
    const known = knownReferences(received), staged = { password: connection.password, uploads: new Map() };
    const local = await prepareSnapshot(logical, known, staged);
    const document = connection.git?.epoch && !m.document.clock && !difference(m.base, local).length
      ? m.document : author(m.document, m.base, local, m.documents);
    const actualValues = logical === actual ? local : await prepareSnapshot(actual, known, staged);
    const documents = combine(received, { [document.actor]: document }), merged = materialize(documents);
    if (merged.conflicts.length) {
      // Keep both complete sides available. Applying even an unrelated cloud
      // change here would silently change the local snapshot before the choice.
      await validateConflicts(merged.conflicts, reader); await connection.check();
      m.document = document; m.documents = documents; m.base = digests(actualValues); await persist(config);
      run.after = groupKeys(merged.conflicts);
      return 'conflict';
    }
    const next = await decodeRecords(merged.values, reader); await connection.check();
    m.document = document; m.documents = combine(m.documents, { [document.actor]: document }); m.base = digests(actualValues); await persist(config);
    // A full snapshot import is a single CAS operation supplied by the
    // encrypted persistence layer. No consumer sees a partial record set.
    applying = true;
    try { await snapshotStore.apply(next, { expectedToken: actual.token }); } finally { applying = false; }
    m.documents = documents; m.base = digests(merged.values); await persist(config);
    run.after = new Set();
    if (document.clock > m.publishedClock) {
      m.pending = await stageRevision(document, known, staged, connection);
      await persist(config); await publish(config, connection);
    }
  }

  async function replaceSnapshot(choice, config, connection, run) {
    const m = config.metadata;
    if (!m || m.target !== connection.target) fail('DATA_SYNC_CONFLICT_STALE');
    const canPrune = choice === 'local' && connection.provider.pinIndexes && connection.provider.pruneIndexes;
    if (choice === 'local' && !canPrune) run.cleanup = 'unsupported';
    if (m.resolutionId === run.id && m.publishedClock >= m.resolutionClock) {
      run.postPublishCleanup = Boolean(m.cleanup);
      await finishIndexCleanup(config, connection, run);
      run.cleanup ??= m.cleanupOutcome;
      return 'replayed';
    }
    const ref = connection.git?.pin.head, reader = makeReader(connection, ref, true);
    const incoming = await fetchDocuments(connection, ref ? makeReader(connection, ref) : reader);
    checkOwnRevision(m, incoming);
    if (m.resolutionId === run.id) {
      if (!m.pending || m.document.clock !== m.resolutionClock) fail('DATA_SYNC_LOCAL');
      await publish(config, connection, incoming.names);
      run.postPublishCleanup = Boolean(m.cleanup);
      await finishIndexCleanup(config, connection, run);
      return;
    }
    const observed = combine(m.documents, incoming.documents, { [m.document.actor]: m.document });
    if (!materialize(observed).conflicts.length) fail('DATA_SYNC_CONFLICT_STALE');
    const actual = await snapshotStore.snapshot();
    const known = knownReferences(observed), staged = { password: connection.password, uploads: new Map() };
    const selected = choice === 'local' ? await prepareSnapshot(actual, known, staged) : await cloudSnapshot(incoming, m.document.actor, connection, reader);
    const document = replaceReplica(m.document, selected, observed);
    const next = choice === 'remote' ? await decodeRecords(selected, reader) : null;
    const pending = await stageRevision(document, known, staged, connection);
    Object.assign(m, { document, documents: combine(observed, { [document.actor]: document }), base: digests(selected),
      pending, resolutionId: run.id, resolutionClock: document.clock });
    delete m.cleanup;
    delete m.cleanupOutcome;
    if (canPrune) m.cleanup = { index: pending.name, obsolete: [...incoming.names] };
    if (encoder.encode(JSON.stringify(config)).length > MAX_METADATA) fail('DATA_SYNC_CAPACITY');
    await connection.check();
    if (next) {
      applying = true;
      try {
        const atomic = snapshotStore.syncMetadataStore === store;
        await snapshotStore.apply(next, { expectedToken: actual.token, ...(atomic && { syncMetadata: config }) });
        if (!atomic) await persist(config);
      } finally { applying = false; }
    } else await persist(config);
    run.after = new Set();
    // With the checkpoint committed, a restarted task can reuse every
    // ciphertext and finish exactly the same revision.
    await publish(config, connection, incoming.names);
    run.postPublishCleanup = Boolean(m.cleanup);
    await finishIndexCleanup(config, connection, run);
  }
  const api = {
    getFullDataSyncStatus: () => copy(status),
    subscribeFullDataSyncStatus(listener) { listeners.add(listener); listener(copy(status)); return () => listeners.delete(listener); },
    async loadFullDataSyncSettings() { try { await inspect(); return { configured: Boolean((await read()).metadata) }; } catch (reason) { throw safeError(reason); } },
    async ensureFullDataTarget(target) {
      const config = await read(), m = config.metadata; if (!m || m.target === target) return;
      const snapshot = await snapshotStore.snapshot(), values = new Map();
      for (const record of snapshot.records) values.set(identity(record.namespace, record.key), { digest: await hash(await encodeValue(record.value)) });
      if (m.gitReset || m.pending || m.document.clock > m.publishedClock || materialize(m.documents).conflicts.length || countPending(m, values)) fail('DATA_SYNC_TARGET');
    },
    async guardFullDataTarget(target, action) { return exclusive(async () => { try { await api.ensureFullDataTarget(target); return await action(); } catch (reason) { throw safeError(reason); } }); },
    async getFullDataRuns(target) { return (await readHistory(target)).runs; },
    async getFullDataConflicts() {
      try {
        const { metadata } = await read(); if (!metadata) return [];
        const conflicts = materialize(metadata.documents).conflicts, discovered = new Map();
        if (conflicts.length) {
          const { origins } = await readHistory(metadata.target);
          if (Object.keys(origins).length) for (const key of groupKeys(conflicts)) {
            const origin = origins[await hash(encoder.encode(key))];
            if (validRunRef(origin)) discovered.set(key, { id: origin.id, startedAt: origin.startedAt });
          }
        }
        return conflicts.map(({ reference, ...item }) => ({ ...item, local: item.actor === metadata.document.actor, digest: reference?.digest || null,
          discoveredIn: discovered.get(identity(item.namespace, item.key)) || null }));
      }
      catch (reason) { throw safeError(reason); }
    },
    clearFullDataConflictPreview() { conflictPreview = undefined; },
    async previewFullDataConflict(id) {
      try {
        return await exclusive(async () => {
          conflictPreview = undefined;
          const config = await read(), m = config.metadata;
          if (!m || m.pending || m.gitReset) fail('DATA_SYNC_TARGET');
          const connection = await githubConnection(await access({ readOnly: true }));
          if (connection.target !== m.target) fail('DATA_SYNC_TARGET');
          if (m.gitEpoch !== (connection.git?.epoch || undefined)) fail('DATA_SYNC_CONFLICT_STALE');
          await connection.check();
          const chosen = materialize(m.documents).conflicts.find(item => item.id === id); if (!chosen) fail('DATA_SYNC_CONFLICT_STALE');
          const snapshot = await snapshotStore.snapshot(), reader = makeReader(connection, connection.git?.pin.head, true);
          const local = snapshot.records.find(item => item.namespace === chosen.namespace && item.key === chosen.key);
          const remote = chosen.reference === null ? null : decodeValue(await reader(chosen.reference));
          const localImage = await conflictPreviewImage(chosen.namespace, chosen.key, local?.value);
          const remoteImage = await conflictPreviewImage(chosen.namespace, chosen.key, remote);
          const mediaEqual = localImage && remoteImage ? equalPreviewImage(localImage.light, remoteImage.light) && equalPreviewImage(localImage.dark, remoteImage.dark) : undefined;
          let mediaMetadataEqual;
          if (mediaEqual) {
            // JSON comparison ignores Blob bytes. Only claim full equality if
            // the authenticated record hash also agrees, including any extra bytes.
            if (!same(local.value, remote)) mediaMetadataEqual = false;
            else if (await hash(await encodeValue(local.value)) === chosen.reference.digest) mediaMetadataEqual = true;
          }
          const documents = await hash(await encodeValue(m.documents));
          await connection.check();
          const token = uuid();
          conflictPreview = { id, token, target: m.target, snapshotToken: snapshot.token, documents, expiresAt: now() + 600000 };
          return { id, token, namespace: chosen.namespace, key: chosen.key, actor: chosen.actor, clock: chosen.clock,
            local: { deleted: !local, value: local?.value ?? null, ...(localImage && { media: localImage.media }) },
            remote: { deleted: chosen.deleted, value: remote, ...(remoteImage && { media: remoteImage.media }) },
            ...(mediaEqual !== undefined && { mediaEqual }), ...(mediaMetadataEqual !== undefined && { mediaMetadataEqual }) };
        });
      } catch (reason) { throw safeError(reason); }
    },
    async restoreFullDataConflict(id, { discard = false, choice, token } = {}) {
      try {
        return await exclusive(async () => {
          const config = await read(); await cleanupStaging(config);
          const m = config.metadata; if (!m || m.pending || m.gitReset) fail('DATA_SYNC_TARGET');
          const connection = await githubConnection(await access());
          if (connection.target !== m.target) fail('DATA_SYNC_TARGET');
          if (m.gitEpoch !== (connection.git?.epoch || undefined)) fail('DATA_SYNC_CONFLICT_STALE');
          await connection.check();
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
          if (!chosen) fail('DATA_SYNC_CONFLICT_STALE');
          const key = identity(chosen.namespace, chosen.key), reference = discard ? local.get(key) || null : chosen.reference;
          const document = author(authored, digests(local), local, documents, { key, value: reference }), all = combine(documents, { [document.actor]: document });
          const merged = materialize(all), visible = retainLocalConflicts(merged, local), reader = makeReader(connection, connection.git?.pin.head, true), next = await decodeRecords(visible, reader); await validateConflicts(merged.conflicts, reader);
          await connection.check();
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
    async syncFullDataNow(options) { return transfer(syncSnapshot, options); },
    async resolveFullDataConflicts(choice, options) {
      if (!['local', 'remote'].includes(choice)) throw safeError({ code: 'DATA_SYNC_INVALID' });
      if (flight) await flight;
      return transfer((config, connection, run) => replaceSnapshot(choice, config, connection, run), options, choice);
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
