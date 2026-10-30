import { tr, getLocale } from "../i18n/index.js";
import { localData, syncDataStore as defaultSnapshotStore } from './local-data.js';
import * as navigationStorage from './storage.js';
import { createEmptyState } from './model.js';
import { createReplica, validateReplica, combineReplicas, recordChanges, portableState, materializeState, syncConflicts } from './sync.js';
import { validateCloudConfig, createCloudProvider, cloudOrigin, parseCloudSnapshotName } from './cloud-providers.js';
import * as packagedWasm from './sync-wasm.js';
import { encryptCloudPayload, decryptCloudPayload, validateCloudPassword, CLOUD_OBJECT_LIMIT, CLOUD_PLAINTEXT_LIMIT } from './cloud-crypto.js';
import { revisionDiff, applyRevisionSelection } from './revision-diff.js';
import { createToolSync, validateToolReplica, materializeToolReplicas } from './tool-sync.js';
import { createFullDataSync } from './full-data-sync.js';

const LOCAL_KEY = 'covelet.cloud.local.v1';
const SESSION_KEY = 'covelet.cloud.session.v1';
const LOCK = 'covelet.cloud.sync.v1';
const MAX_OBJECTS = 2000;
const MAX_ACTORS = 100;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const clone = (value) => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const failure = (message, code = 'CLOUD_INVALID') => Object.assign(new Error(message), { code });
const empty = () => ({ version: 1, profile: null, autoSync: false, metadata: null });
const messages = {
  get CLOUD_LOCKED() { return tr("云同步尚未解锁，请重新填写凭据和加密口令。"); },
  get CLOUD_PERMISSION() { return tr("尚未授权访问这个云服务，请先在设置中授权。"); },
  get CLOUD_UNAVAILABLE() { return tr("请加载 Chrome 或 Edge 扩展，再授权使用云同步。"); },
  get CLOUD_DECRYPT() { return tr("无法解密同步数据：请检查加密口令，或确认云端文档未损坏。"); },
  get CLOUD_PASSWORD() { return tr("加密口令至少需要 12 个字符。"); },
  get CLOUD_CAPACITY() { return tr("云同步数据或历史超出限制，已保留全部本地数据；请使用 ZIP 备份。"); },
  get CLOUD_INTEGRITY() { return tr("云端同步数据校验失败，未用部分数据覆盖本机。"); },
  get CLOUD_INVALID() { return tr("云同步配置或文档无效，已保留本地数据。"); },
  get CLOUD_LOCAL() { return tr("无法保存本机云同步状态，未上传新版本。"); },
  get CLOUD_INVALID_CONFIG() { return tr("云存储配置无效，请检查填写内容。"); },
  get CLOUD_CREDENTIALS() { return tr("请输入有效的云存储访问凭据。"); },
  get CLOUD_AUTH() { return tr("云存储身份验证失败，请检查凭据和访问权限。"); },
  get CLOUD_NOT_FOUND() { return tr("云端仓库、分支或存储目录不可访问，请检查配置和权限。"); },
  get CLOUD_RATE_LIMIT() { return tr("云服务请求过于频繁，请稍后重试。"); },
  get CLOUD_INVALID_RESPONSE() { return tr("云服务返回了无效的数据，本地数据未被覆盖。"); },
  get CLOUD_LIMIT() { return tr("云端快照数量或大小超出限制，请使用单独的存储目录。"); },
  get CLOUD_CONFLICT() { return tr("云端存在同名但内容不同的快照，已停止写入并保留本地数据。"); },
  get CLOUD_REQUEST_FAILED() { return tr("云服务请求未成功，请检查配置和网络后重试。"); },
  get CLOUD_PENDING() { return tr("请先完成待上传版本的同步，再恢复历史项目。"); },
  get CLOUD_HISTORY_STALE() { return tr("版本预览已失效，或本机导航已更新，请重新查看差异。"); },
  get CLOUD_HISTORY_SELECTION() { return tr("所选项目不能恢复，请重新查看差异并选择关联的文件夹。"); },
  get CLOUD_TARGET_PENDING() { return tr("还有尚未上传的同步版本，请先完成当前云端同步，再切换存储位置。"); },
  get CLOUD_TARGET_CONFLICTS() { return tr("当前云端还有可恢复的并发版本，请先恢复并完成同步，再切换存储位置。"); },
  get TOOLS_SYNC_TARGET() { return tr('工具内容还有待上传或冲突版本，请先处理后再切换存储位置。'); },
  get REVISION_CONFLICT() { return tr("数据已在另一个标签页更新，本次未覆盖；请重新同步。"); },
  get SYNC_DEVICE_CONFLICT() { return tr("同一设备出现不一致的同步版本，已保留本地数据。"); },
  get SYNC_CAPACITY() { return tr("同步历史超出限制，已保留本地数据；请使用 ZIP 备份。"); },
};

function publicError(cause) {
  const code = Object.hasOwn(messages, cause?.code) ? cause.code : 'CLOUD_REQUEST';
  return failure(messages[code] || tr("云服务请求失败，请检查授权、凭据、网络及服务权限；本地数据仍然保留。"), code);
}

export function supportsCloudSync() {
  const chrome = globalThis.chrome;
  return Boolean(chrome?.runtime?.id && chrome.permissions?.contains && chrome.storage?.local && chrome.storage?.session);
}

function chromeCall(area, method, argument) {
  return new Promise((resolve, reject) => {
    try {
      area[method](argument, (result) => {
        if (globalThis.chrome?.runtime?.lastError) reject(failure(tr("云同步状态存储失败。"), 'CLOUD_LOCAL'));
        else resolve(result);
      });
    } catch { reject(failure(tr("云同步状态存储失败。"), 'CLOUD_LOCAL')); }
  });
}

function localConfigStore() {
  return {
    async read() {
      try { return (await localData.get(LOCAL_KEY))[LOCAL_KEY] || null; }
      catch { throw failure(tr("无法读取本机云同步设置。"), 'CLOUD_LOCAL'); }
    },
    async write(value) {
      try { await localData.set({ [LOCAL_KEY]: value }); }
      catch { throw failure(tr("无法保存本机云同步设置。"), 'CLOUD_LOCAL'); }
    },
  };
}

// storage.session is shared across extension tabs and is not persisted across a
// browser restart. A plain web preview uses memory, never sessionStorage.
function sessionCredentialsStore() {
  let memory = null;
  return {
    async read() {
      if (globalThis.chrome?.runtime?.id && globalThis.chrome.storage?.session) return (await chromeCall(globalThis.chrome.storage.session, 'get', SESSION_KEY))[SESSION_KEY] || null;
      return clone(memory);
    },
    async write(value) {
      if (globalThis.chrome?.runtime?.id && globalThis.chrome.storage?.session) return chromeCall(globalThis.chrome.storage.session, 'set', { [SESSION_KEY]: value });
      memory = clone(value);
    },
    async clear() {
      if (globalThis.chrome?.runtime?.id && globalThis.chrome.storage?.session) return chromeCall(globalThis.chrome.storage.session, 'remove', SESSION_KEY);
      memory = null;
    },
  };
}

async function defaultPermission(origin) {
  if (!supportsCloudSync()) throw failure(messages.CLOUD_UNAVAILABLE, 'CLOUD_UNAVAILABLE');
  return new Promise((resolve) => {
    try { globalThis.chrome.permissions.contains({ origins: [`${origin}/*`] }, (allowed) => resolve(!globalThis.chrome.runtime.lastError && allowed)); }
    catch { resolve(false); }
  });
}

function newActor(uuid) {
  const actor = uuid().replaceAll('-', '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(actor)) throw failure(tr("同步设备标识无效。"));
  return actor;
}

export function createCloudSync({ stateStore = navigationStorage, configStore = localConfigStore(), sessionStore = sessionCredentialsStore(),
  providerFactory = createCloudProvider, validateConfig = validateCloudConfig, originOf = cloudOrigin, parseName = parseCloudSnapshotName,
  signer = packagedWasm, hasPermission = defaultPermission, locks = globalThis.navigator?.locks,
  uuid = () => globalThis.crypto.randomUUID(), crypto = globalThis.crypto, now = () => Date.now(),
  autoDelay = 15_000, pullInterval = 60_000, eventWindow = globalThis.window, eventDocument = globalThis.document,
  toolSyncStore, toolsStore, fullData = true, snapshotStore = defaultSnapshotStore, fullSyncStore, fullPendingStore, legacySeed = true } = {}) {
  let serial = Promise.resolve();
  let flight;
  let started = false;
  let timer;
  let interval;
  let unsubscribe;
  let lastPull = 0;
  let applying = false;
  let lastObserved;
  let historyPreview;
  const listeners = new Set();
  let status = { phase: 'unconfigured', message: tr("尚未配置自定义云同步。"), lastSync: 0, conflicts: 0, autoSync: false, unlocked: false, localChanges: false };
  const report = (patch) => {
    status = { ...status, ...patch };
    for (const listener of listeners) { try { listener(clone(status)); } catch { /* Consumer errors cannot break synchronization. */ } }
    return clone(status);
  };
  const exclusive = (action) => {
    if (locks?.request) return locks.request(LOCK, { mode: 'exclusive' }, action);
    if (supportsCloudSync()) return Promise.reject(failure(tr("浏览器事务锁不可用，未开始同步。"), 'CLOUD_LOCAL'));
    const result = serial.then(action, action);
    serial = result.catch(() => {});
    return result;
  };
  const hash = async (value) => {
    const bytes = encoder.encode(JSON.stringify(value));
    if (bytes.length > 1024 * 1024) throw failure(messages.CLOUD_CAPACITY, 'CLOUD_CAPACITY');
    return signer.sha256(bytes);
  };
  const boundedDocuments = (documents) => {
    if (Object.keys(documents).length > MAX_ACTORS || encoder.encode(JSON.stringify(documents)).length > MAX_TOTAL_BYTES) throw failure(messages.CLOUD_CAPACITY, 'CLOUD_CAPACITY');
    return documents;
  };
  const read = async () => {
    const value = await configStore.read();
    if (!value) return empty();
    if (value.version !== 1 || typeof value.autoSync !== 'boolean' || Object.keys(value).some((key) => !['version', 'profile', 'autoSync', 'metadata'].includes(key))) throw failure(tr("云同步本机设置无效。"));
    const profile = value.profile === null ? null : validateConfig(value.profile);
    let metadata = value.metadata;
    if (metadata) {
      if (!profile || metadata.version !== 1 || typeof metadata.target !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.target)
        || !Number.isSafeInteger(metadata.publishedClock) || metadata.publishedClock < 0 || !Number.isFinite(metadata.lastSync) || metadata.lastSync < 0
        || Object.keys(metadata).some((key) => !['version', 'target', 'document', 'documents', 'base', 'pending', 'publishedClock', 'lastSync'].includes(key))) throw failure(tr("本机云同步文档无效。"));
      const document = validateReplica(metadata.document);
      if (!/^[a-f0-9]{32}$/.test(document.actor) || document.clock < 1 || metadata.publishedClock > document.clock) throw failure(tr("本机云同步设备版本无效。"));
      const documents = boundedDocuments(combineReplicas(metadata.documents, { [document.actor]: document }));
      if (metadata.pending && (typeof metadata.pending.body !== 'string' || encoder.encode(metadata.pending.body).length > CLOUD_OBJECT_LIMIT
        || !parseName(metadata.pending.name) || parseName(metadata.pending.name).actor !== document.actor || parseName(metadata.pending.name).clock !== document.clock
        || Object.keys(metadata.pending).some((key) => !['name', 'body'].includes(key)))) throw failure(tr("本机待上传版本无效。"));
      metadata = { ...clone(metadata), document, documents, base: portableState(metadata.base) };
    }
    return { version: 1, profile, autoSync: value.autoSync, metadata };
  };
  const persist = async (config) => {
    try { await configStore.write(clone(config)); } catch { throw failure(tr("无法保存本机云同步状态。"), 'CLOUD_LOCAL'); }
  };
  const targetOf = (profile) => hash(profile);
  const currentSession = async (target) => {
    const value = await sessionStore.read();
    if (!value || value.target !== target || typeof value.password !== 'string' || !value.secrets || typeof value.secrets !== 'object') return null;
    validateCloudPassword(value.password);
    return value;
  };
  const metadataFor = async (config) => {
    const target = await targetOf(config.profile);
    if (config.metadata?.target === target) return config.metadata;
    const document = { ...createReplica(newActor(uuid)), clock: 1 };
    return { version: 1, target, document, documents: { [document.actor]: document }, base: portableState(createEmptyState()),
      pending: null, publishedClock: 0, lastSync: 0 };
  };
  const inspectSettings = async () => {
    const config = await read();
    const target = config.profile ? await targetOf(config.profile) : null;
    const session = target ? await currentSession(target) : null;
    if (fullData) await fullSync.loadFullDataSyncSettings();
    const fullStatus = fullData ? fullSync.getFullDataSyncStatus() : null;
    const conflicts = fullData ? fullStatus.conflicts : config.metadata ? syncConflicts(config.metadata.documents).length : 0;
    report({ phase: config.profile ? (session ? (status.phase === 'syncing' ? 'syncing' : status.phase === 'saved' ? 'saved' : 'idle') : 'locked') : 'unconfigured',
      message: config.profile ? (session ? tr("已解锁，凭据仅保留在当前浏览器会话。") : messages.CLOUD_LOCKED) : tr("尚未配置自定义云同步。"),
      autoSync: config.autoSync, unlocked: Boolean(session), lastSync: fullData ? fullStatus.lastSync : config.metadata?.lastSync || 0, conflicts,
      ...(fullData ? { pending: fullStatus.pending } : {}) });
    return { profile: clone(config.profile), autoSync: config.autoSync, configured: Boolean(config.profile), unlocked: Boolean(session) };
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!started) return;
    timer = setTimeout(async () => {
      try { const settings = await api.loadCloudSyncSettings(); if (settings.autoSync && settings.unlocked) await api.syncCloudNow(); } catch { /* Status holds the safe failure. */ }
    }, autoDelay);
    timer.unref?.();
  };
  const checkAccess = async (config, session) => {
    if (!same(await currentSession(session.target), session)) throw failure(messages.CLOUD_LOCKED, 'CLOUD_LOCKED');
    const latest = await read();
    if (!latest.profile || await targetOf(latest.profile) !== session.target || await targetOf(config.profile) !== session.target) throw failure(messages.CLOUD_LOCKED, 'CLOUD_LOCKED');
    if (!await hasPermission(originOf(config.profile))) throw failure(messages.CLOUD_PERMISSION, 'CLOUD_PERMISSION');
  };
  const toolSync = createToolSync({ store: toolSyncStore, tools: toolsStore, locks, crypto, uuid, now, autoDelay, pullInterval, eventWindow, eventDocument,
    access: async () => {
      const config = await read();
      if (!config.profile) throw failure(messages.CLOUD_LOCKED, 'CLOUD_LOCKED');
      const target = await targetOf(config.profile), session = await currentSession(target);
      if (!session) throw failure(messages.CLOUD_LOCKED, 'CLOUD_LOCKED');
      await checkAccess(config, session);
      // Navigation readers only understand navigation snapshots. A separate
      // directory also prevents tool-body traffic from entering that history.
      const profile = validateConfig({ ...config.profile, prefix: `${config.profile.prefix}/tools-v1` });
      const check = () => checkAccess(config, session);
      return { target, password: session.password, autoSync: config.autoSync, check,
        provider: providerFactory(profile, session.secrets, { signer, beforeRequest: check }) };
    } });
  const fullAccess = async () => {
    let config = await read();
    if (!config.profile) throw failure(messages.CLOUD_LOCKED, 'CLOUD_LOCKED');
    const target = await targetOf(config.profile), session = await currentSession(target);
    if (!session) throw failure(messages.CLOUD_LOCKED, 'CLOUD_LOCKED');
    await checkAccess(config, session);
    await flushLegacyPending(config, session);
    config = await read();
    const check = () => checkAccess(config, session);
    const providerAt = (suffix) => providerFactory(validateConfig({ ...config.profile, prefix: `${config.profile.prefix}/${suffix}` }), session.secrets, { signer, beforeRequest: check });
    return { target, password: session.password, autoSync: config.autoSync, check,
      provider: providerAt('all-data-v1'), assetProvider: providerAt('all-data-v1/blobs') };
  };
  // The first upgraded device imports the old formats without asking old
  // clients to understand the new protocol. Once an all-data manifest exists,
  // the unified directory is authoritative and legacy clients must be upgraded.
  const seedLegacyData = async (snapshot) => {
    const config = await read(), session = await currentSession(await targetOf(config.profile));
    if (!session) throw failure(messages.CLOUD_LOCKED, 'CLOUD_LOCKED');
    const records = clone(snapshot.records);
    const replace = (key, value) => {
      const index = records.findIndex((item) => item.namespace === 'preferences' && item.key === key);
      const next = { namespace: 'preferences', key, value };
      if (index < 0) records.push(next); else records[index] = next;
    };
    const navigation = records.find((item) => item.namespace === 'preferences' && item.key === 'owntab.local.v1');
    const local = navigation?.value.state || await stateStore.loadState();
    const provider = providerFactory(config.profile, session.secrets, { signer, beforeRequest: () => checkAccess(config, session) });
    const incoming = await fetchDocuments(provider, config, session);
    if (Object.keys(incoming.documents).length) {
      const metadata = config.metadata || await metadataFor(config);
      const authored = recordChanges(metadata.document, metadata.base, local, metadata.documents);
      const merged = materializeState(combineReplicas(metadata.documents, incoming.documents, { [authored.actor]: authored }), local);
      replace('owntab.local.v1', { ...(navigation?.value || { version: 1, snapshots: [] }), state: merged });
    }
    const toolConfig = toolSyncStore ? await toolSyncStore.read() : (await localData.get('covelet.tools.cloud.v1'))['covelet.tools.cloud.v1'];
    const toolProvider = providerFactory(validateConfig({ ...config.profile, prefix: `${config.profile.prefix}/tools-v1` }), session.secrets, { signer, beforeRequest: () => checkAccess(config, session) });
    let listing;
    try { listing = await toolProvider.list(); } catch (cause) { if (cause.code === 'CLOUD_NOT_FOUND') listing = []; else throw cause; }
    if (!Array.isArray(listing) || listing.length > MAX_OBJECTS) throw failure(messages.CLOUD_CAPACITY, 'CLOUD_CAPACITY');
    const latest = new Map(), documents = {}, seen = new Set();
    for (const item of listing) {
      const identity = parseName(item?.name);
      if (!identity || seen.has(item.name)) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
      seen.add(item.name);
      const prior = latest.get(identity.actor);
      if (!prior || identity.clock > prior.clock) latest.set(identity.actor, { ...identity, name: item.name });
      else if (identity.clock === prior.clock && identity.digest !== prior.digest) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
    }
    if (latest.size > MAX_ACTORS) throw failure(messages.CLOUD_CAPACITY, 'CLOUD_CAPACITY');
    let total = 0;
    for (const identity of latest.values()) {
      await checkAccess(config, session);
      const bytes = await toolProvider.read(identity.name); total += bytes?.byteLength || 0;
      if (!(bytes instanceof Uint8Array) || bytes.length > CLOUD_OBJECT_LIMIT || total > MAX_TOTAL_BYTES || await signer.sha256(bytes) !== identity.digest) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
      const payload = JSON.parse(decoder.decode(await decryptCloudPayload(bytes, session.password, { crypto })));
      if (payload?.format !== 'covelet-tools-sync' || payload.version !== 1 || Object.keys(payload).some((key) => !['format', 'version', 'document'].includes(key))) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
      const document = validateToolReplica(payload.document);
      if (document.actor !== identity.actor || document.clock !== identity.clock) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
      documents[document.actor] = document;
    }
    if (Object.keys(documents).length) {
      const old = records.find((item) => item.namespace === 'preferences' && item.key === 'covelet.tools.v1');
      const localTools = old?.value || { version: 3, revision: 0, notes: [], reading: [], snapshots: [], trash: [] };
      const combined = { ...documents };
      for (const document of Object.values(toolConfig?.metadata?.documents || {})) {
        const checked = validateToolReplica(document), prior = combined[checked.actor];
        if (!prior || checked.clock > prior.clock) combined[checked.actor] = checked;
        else if (checked.clock === prior.clock && !same(checked, prior)) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
      }
      const merged = materializeToolReplicas(combined).data;
      const base = toolConfig?.metadata?.base || { notes: [], reading: [] };
      // Keep unsynced local edits and local-only tool collections. A competing
      // legacy version stays in its original immutable history for recovery.
      const mergeKind = (kind) => {
        const result = new Map(merged[kind].map((item) => [item.id, item]));
        const before = new Map(base[kind].map((item) => [item.id, item]));
        const current = new Map(localTools[kind].map((item) => [item.id, item]));
        for (const [id, item] of current) if (!same({ ...item, revision: 1 }, before.get(id))) result.set(id, item);
        for (const id of before.keys()) if (!current.has(id)) result.delete(id);
        return [...result.values()];
      };
      replace('covelet.tools.v1', { ...localTools, notes: mergeKind('notes'), reading: mergeKind('reading') });
    }
    return { version: 1, records };
  };
  const fullSync = fullData ? createFullDataSync({ access: fullAccess, store: fullSyncStore, pendingStore: fullPendingStore, snapshotStore,
    signer, crypto, locks, uuid, now, autoDelay, pullInterval, eventWindow, eventDocument, seed: legacySeed ? seedLegacyData : undefined }) : null;
  if (fullSync) fullSync.subscribeFullDataSyncStatus((value) => {
    if (['syncing', 'saved', 'error', 'locked'].includes(value.phase)) report({ ...value, unlocked: value.phase === 'locked' ? false : status.unlocked });
  });
  async function flushLegacyPending(config, session) {
    if (config.metadata?.pending) {
      const provider = providerFactory(config.profile, session.secrets, { signer, beforeRequest: () => checkAccess(config, session) });
      await publishPending(config, session, provider);
    }
    const tools = toolSyncStore ? await toolSyncStore.read() : (await localData.get('covelet.tools.cloud.v1'))['covelet.tools.cloud.v1'];
    const pending = tools?.metadata?.pending;
    if (!pending) return;
    const identity = parseName(pending.name), bytes = encoder.encode(pending.body);
    if (!identity || bytes.length > CLOUD_OBJECT_LIMIT || await signer.sha256(bytes) !== identity.digest) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
    const payload = JSON.parse(decoder.decode(await decryptCloudPayload(bytes, session.password, { crypto })));
    const document = validateToolReplica(payload.document);
    if (payload.format !== 'covelet-tools-sync' || payload.version !== 1 || Object.keys(payload).some((key) => !['format', 'version', 'document'].includes(key))
      || document.actor !== identity.actor || document.clock !== identity.clock || !same(document, tools.metadata.document)) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
    const provider = providerFactory(validateConfig({ ...config.profile, prefix: `${config.profile.prefix}/tools-v1` }), session.secrets, { signer, beforeRequest: () => checkAccess(config, session) });
    await checkAccess(config, session); await provider.write(pending.name, bytes); await checkAccess(config, session);
    tools.metadata.publishedClock = document.clock; tools.metadata.pending = null;
    if (toolSyncStore) await toolSyncStore.write(tools); else await localData.set({ 'covelet.tools.cloud.v1': tools });
  }
  const parseRevision = async (name, body, password) => {
    const identity = parseName(name);
    if (!identity || !(body instanceof Uint8Array) || !body.length || body.length > CLOUD_OBJECT_LIMIT) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
    if (await signer.sha256(body) !== identity.digest) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
    const plaintext = await decryptCloudPayload(body, password, { crypto });
    let document, snapshot = null, createdAt = null;
    try {
      const payload = JSON.parse(decoder.decode(plaintext));
      if (payload?.format === 'covelet-sync-revision') {
        if (payload.version !== 1 || Object.keys(payload).some((key) => !['format', 'version', 'createdAt', 'document', 'state'].includes(key))
          || !Number.isSafeInteger(payload.createdAt) || payload.createdAt < 0 || payload.createdAt > 8640000000000000) throw Error('Invalid revision');
        document = validateReplica(payload.document); snapshot = portableState(payload.state); createdAt = payload.createdAt;
      } else document = validateReplica(payload);
    } catch { throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY'); }
    if (document.actor !== identity.actor || document.clock !== identity.clock) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
    try { materializeState({ [document.actor]: document }); } catch { throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY'); }
    return { document, snapshot, createdAt };
  };
  const parseDocument = async (name, body, password) => (await parseRevision(name, body, password)).document;
  const historyAccess = async () => {
    const config = await read();
    if (!config.profile || !config.metadata) throw failure(messages.CLOUD_LOCKED, 'CLOUD_LOCKED');
    const session = await currentSession(config.metadata.target);
    if (!session) throw failure(messages.CLOUD_LOCKED, 'CLOUD_LOCKED');
    await checkAccess(config, session);
    const provider = providerFactory(config.profile, session.secrets, { signer, beforeRequest: () => checkAccess(config, session) });
    return { config, session, provider };
  };
  const fetchDocuments = async (provider, config, session) => {
    await checkAccess(config, session);
    const listing = await provider.list();
    if (!Array.isArray(listing) || listing.length > MAX_OBJECTS) throw failure(messages.CLOUD_CAPACITY, 'CLOUD_CAPACITY');
    const latest = new Map();
    for (const item of listing) {
      const identity = parseName(item?.name);
      if (!identity) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
      if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > CLOUD_OBJECT_LIMIT)) throw failure(messages.CLOUD_CAPACITY, 'CLOUD_CAPACITY');
      const prior = latest.get(identity.actor);
      if (!prior || identity.clock > prior.clock) latest.set(identity.actor, { ...identity, name: item.name });
      else if (identity.clock === prior.clock && identity.digest !== prior.digest) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
    }
    if (latest.size > MAX_ACTORS) throw failure(messages.CLOUD_CAPACITY, 'CLOUD_CAPACITY');
    const documents = {};
    let total = 0;
    for (const item of latest.values()) {
      await checkAccess(config, session);
      const bytes = await provider.read(item.name);
      total += bytes?.byteLength || 0;
      if (total > MAX_TOTAL_BYTES) throw failure(messages.CLOUD_CAPACITY, 'CLOUD_CAPACITY');
      documents[item.actor] = await parseDocument(item.name, bytes, session.password);
    }
    // Validate every selected document as a complete state before exposing any
    // received data to navigation storage. Corrupt/oversized batches fail whole.
    materializeState(documents);
    return { documents, names: new Set(listing.map((item) => item.name)) };
  };
  const publishPending = async (config, session, provider, remoteNames = new Set()) => {
    const pending = config.metadata.pending;
    if (!pending) return;
    const bytes = encoder.encode(pending.body);
    const pendingDocument = await parseDocument(pending.name, bytes, session.password);
    if (!same(pendingDocument, config.metadata.document)) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
    if (!remoteNames.has(pending.name)) {
      await checkAccess(config, session);
      await provider.write(pending.name, bytes);
    }
    // A request already in flight cannot be recalled, but a response received
    // after locking must not acknowledge the pending revision or revive the UI.
    await checkAccess(config, session);
    config.metadata.publishedClock = pendingDocument.clock;
    config.metadata.pending = null;
    await persist(config);
  };
  const api = {
    loadToolSyncSettings: toolSync.loadToolSyncSettings,
    setToolSyncEnabled: toolSync.setToolSyncEnabled,
    getToolSyncStatus: toolSync.getToolSyncStatus,
    subscribeToolSyncStatus: toolSync.subscribeToolSyncStatus,
    getToolSyncConflicts: toolSync.getToolSyncConflicts,
    useToolSyncConflict: toolSync.useToolSyncConflict,
    syncToolCloudNow: fullData ? () => api.syncCloudNow() : toolSync.syncToolCloudNow,
    async loadCloudSyncSettings() { try { return await inspectSettings(); } catch (cause) { throw publicError(cause); } },
    async saveCloudSyncSettings(profile, secrets, password, { autoSync = false } = {}) {
      try {
        if (typeof autoSync !== 'boolean') throw failure(tr("自动同步设置无效。"));
        const checked = validateConfig(profile);
        validateCloudPassword(password);
        providerFactory(checked, secrets, { signer }); // Validate credentials without a network request.
        await exclusive(async () => {
          const previous = await read();
          const target = await targetOf(checked);
          const guard = fullData ? (action) => fullSync.guardFullDataTarget(target, action) : (action) => action();
          await guard(() => toolSync.guardToolTarget(target, async () => {
            if (previous.metadata && previous.metadata.target !== target) {
              // Switching a target replaces its local causal history. Never let
              // that destroy the only unuploaded/conflicting version after a
              // merge changed the visible navigation state (e.g. delete wins).
              if (previous.metadata.pending) throw failure(messages.CLOUD_TARGET_PENDING, 'CLOUD_TARGET_PENDING');
              if (syncConflicts(previous.metadata.documents).length) throw failure(messages.CLOUD_TARGET_CONFLICTS, 'CLOUD_TARGET_CONFLICTS');
            }
            const config = { version: 1, profile: checked, autoSync, metadata: previous.metadata };
            config.metadata = await metadataFor(config);
            await persist(config);
            await sessionStore.write({ target: config.metadata.target, secrets: clone(secrets), password });
          }));
        });
        const settings = await inspectSettings(); schedule(); return settings;
      } catch (cause) { throw publicError(cause); }
    },
    async unlockCloudSync(secrets, password) {
      try {
        validateCloudPassword(password);
        await exclusive(async () => {
          const config = await read();
          if (!config.profile) throw failure(tr("请先保存云同步配置。"));
          providerFactory(config.profile, secrets, { signer });
          await sessionStore.write({ target: await targetOf(config.profile), secrets: clone(secrets), password });
        });
        const settings = await inspectSettings(); schedule(); return settings;
      } catch (cause) { throw publicError(cause); }
    },
    async lockCloudSync() {
      clearTimeout(timer);
      historyPreview = undefined;
      try { await sessionStore.clear(); return await inspectSettings(); } catch (cause) { throw publicError(cause); }
    },
    getCloudSyncStatus() { return clone(status); },
    subscribeCloudSyncStatus(listener) { listeners.add(listener); listener(clone(status)); return () => listeners.delete(listener); },
    clearCloudHistoryPreview(token) { if (historyPreview?.token === token) historyPreview = undefined; },
    async listCloudHistory() {
      try {
        return await exclusive(async () => {
          const { config, session, provider } = await historyAccess();
          const listing = await provider.list();
          if (!Array.isArray(listing) || listing.length > MAX_OBJECTS) throw failure(messages.CLOUD_CAPACITY, 'CLOUD_CAPACITY');
          const seen = new Set(), revisions = new Map(), versions = [];
          for (const item of listing) {
            const identity = parseName(item?.name);
            if (!identity || seen.has(item.name)) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
            const key = `${identity.actor}:${identity.clock}`;
            if (revisions.has(key) && revisions.get(key) !== identity.digest) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
            revisions.set(key, identity.digest);
            if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > CLOUD_OBJECT_LIMIT)) throw failure(messages.CLOUD_CAPACITY, 'CLOUD_CAPACITY');
            seen.add(item.name); versions.push({ ...identity, name: item.name, bytes: item.size ?? null, own: identity.actor === config.metadata.document.actor });
          }
          await checkAccess(config, session);
          return versions.sort((a, b) => Number(b.own) - Number(a.own) || a.actor.localeCompare(b.actor) || b.clock - a.clock);
        });
      } catch (cause) { throw publicError(cause); }
    },
    async previewCloudHistory(name) {
      try {
        return await exclusive(async () => {
          if (!parseName(name)) throw failure(messages.CLOUD_INTEGRITY, 'CLOUD_INTEGRITY');
          const { config, session, provider } = await historyAccess();
          const revision = await parseRevision(name, await provider.read(name), session.password);
          await checkAccess(config, session);
          const local = await stateStore.loadState();
          const changes = revisionDiff(local, revision), token = uuid();
          const digest = await hash(portableState(local));
          await checkAccess(config, session);
          historyPreview = { token, target: config.metadata.target, revision: local.revision, digest, changes, expiresAt: now() + 600000 };
          return { token, name, revision: local.revision, createdAt: revision.createdAt, legacy: !revision.snapshot, changes: clone(changes) };
        });
      } catch (cause) { throw publicError(cause); }
    },
    async restoreCloudHistory(token, selected) {
      try {
        return await exclusive(async () => {
          const preview = historyPreview;
          const { config, session } = await historyAccess();
          if (!preview || preview.token !== token || preview.target !== config.metadata.target || now() > preview.expiresAt) throw failure(messages.CLOUD_HISTORY_STALE, 'CLOUD_HISTORY_STALE');
          if (config.metadata.pending) throw failure(messages.CLOUD_PENDING, 'CLOUD_PENDING');
          if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some((key) => typeof key !== 'string' || !preview.changes.some((item) => item.key === key))) throw failure(messages.CLOUD_HISTORY_SELECTION, 'CLOUD_HISTORY_SELECTION');
          const local = await stateStore.loadState();
          if (local.revision !== preview.revision || await hash(portableState(local)) !== preview.digest) throw failure(messages.CLOUD_HISTORY_STALE, 'CLOUD_HISTORY_STALE');
          let next;
          try { next = applyRevisionSelection(local, preview.changes, selected); }
          catch { throw failure(messages.CLOUD_HISTORY_SELECTION, 'CLOUD_HISTORY_SELECTION'); }
          await checkAccess(config, session);
          // Navigation storage atomically saves a pre-restore local snapshot.
          // The next ordinary sync authors new operations from this local edit;
          // history clocks and other devices' records are never rolled back.
          const saved = await stateStore.saveState(next, local.revision);
          historyPreview = undefined;
          report({ localChanges: true, message: tr("已恢复所选项目，等待同步。") }); schedule();
          return saved;
        });
      } catch (cause) { throw publicError(cause); }
    },
    async getCloudSyncConflicts() {
      if (fullData) return fullSync.getFullDataConflicts();
      try { const config = await read(); return config.metadata ? syncConflicts(config.metadata.documents) : []; }
      catch (cause) { throw publicError(cause); }
    },
    async restoreCloudSyncConflict(id, options) {
      if (fullData) return fullSync.restoreFullDataConflict(id, options);
      try {
        return await exclusive(async () => {
          const config = await read();
          if (!config.metadata || config.metadata.pending) throw failure(messages.CLOUD_PENDING, 'CLOUD_PENDING');
          const local = await stateStore.loadState();
          const metadata = config.metadata;
          const document = recordChanges(metadata.document, metadata.base, local, metadata.documents);
          let documents = combineReplicas(metadata.documents, { [document.actor]: document });
          const conflict = syncConflicts(documents).find((item) => item.id === id);
          if (!conflict) throw failure(tr("此并发版本已处理。"));
          const recovered = recordChanges(document, local, local, documents, { [conflict.key]: conflict.value });
          documents = boundedDocuments(combineReplicas(documents, { [recovered.actor]: recovered }));
          const merged = materializeState(documents, local);
          metadata.document = recovered; metadata.documents = documents;
          // Persist the authored clock before any later upload or UI commit.
          await persist(config);
          applying = true;
          let saved;
          try { saved = await stateStore.saveState(merged, local.revision); } finally { applying = false; }
          metadata.base = portableState(saved);
          await persist(config);
          report({ localChanges: true, conflicts: syncConflicts(documents).length, message: tr("已恢复所选并发版本，等待同步。") });
          schedule();
          return saved;
        });
      } catch (cause) { throw publicError(cause); }
    },
    async syncCloudNow() {
      if (fullData) return fullSync.syncFullDataNow();
      if (flight) return flight;
      flight = exclusive(async () => {
        const config = await read();
        if (!config.profile) throw failure(tr("请先保存云同步配置。"));
        config.metadata = await metadataFor(config);
        const metadata = config.metadata;
        const session = await currentSession(metadata.target);
        if (!session) throw failure(messages.CLOUD_LOCKED, 'CLOUD_LOCKED');
        report({ phase: 'syncing', message: tr("正在读取并合并加密配置。"), unlocked: true, autoSync: config.autoSync });
        const provider = providerFactory(config.profile, session.secrets, { signer, beforeRequest: () => checkAccess(config, session) });
        const incoming = await fetchDocuments(provider, config, session);
        const receivedOwn = incoming.documents[metadata.document.actor];
        if (receivedOwn && (receivedOwn.clock > metadata.document.clock
          || receivedOwn.clock === metadata.document.clock && !same(receivedOwn, metadata.document))) throw failure(messages.SYNC_DEVICE_CONFLICT, 'SYNC_DEVICE_CONFLICT');
        const received = boundedDocuments(combineReplicas(metadata.documents, incoming.documents, { [metadata.document.actor]: metadata.document }));
        materializeState(received);
        // A timed-out write might already exist remotely. Retry the exact
        // persisted ciphertext and filename before authoring the next clock.
        await publishPending(config, session, provider, incoming.names);
        const local = await stateStore.loadState();
        const before = metadata.base;
        const remoteState = materializeState(received, local);
        const plan = await signer.planSync(await hash(portableState(local)), await hash(before), await hash(portableState(remoteState)));
        // Local edits were made against the last observed causal baseline. The
        // freshly fetched remote versions must not make offline edits appear
        // to have observed and superseded changes the user never saw.
        const document = recordChanges(metadata.document, before, local, metadata.documents);
        const documents = boundedDocuments(combineReplicas(received, { [document.actor]: document }));
        const merged = materializeState(documents, local);
        await checkAccess(config, session);
        metadata.document = document;
        // Received versions become an observed causal baseline only after the
        // corresponding navigation commit succeeds. A revision race must not
        // make a subsequent offline edit supersede unseen cloud changes.
        metadata.documents = combineReplicas(metadata.documents, { [document.actor]: document });
        metadata.base = portableState(local);
        await persist(config);
        let saved = local;
        if (!same(merged, local)) {
          applying = true;
          try { saved = await stateStore.saveState(merged, local.revision); } finally { applying = false; }
        }
        metadata.documents = documents;
        metadata.base = portableState(saved);
        await persist(config);
        if (document.clock > metadata.publishedClock) {
          const plaintext = encoder.encode(JSON.stringify({ format: 'covelet-sync-revision', version: 1, createdAt: now(), document, state: portableState(saved) }));
          if (plaintext.length > CLOUD_PLAINTEXT_LIMIT) throw failure(messages.CLOUD_CAPACITY, 'CLOUD_CAPACITY');
          const bytes = await encryptCloudPayload(plaintext, session.password, { crypto });
          const digest = await signer.sha256(bytes);
          metadata.pending = { name: `covelet-${document.actor}-${document.clock}-${digest}.json`, body: decoder.decode(bytes) };
          await persist(config);
          await publishPending(config, session, provider);
        }
        await checkAccess(config, session);
        metadata.lastSync = now();
        await persist(config);
        lastObserved = JSON.stringify(portableState(saved));
        lastPull = now();
        await checkAccess(config, session);
        return report({ phase: 'saved', code: null, message: tr("已完成加密配置同步。"), lastSync: metadata.lastSync,
          conflicts: syncConflicts(documents).length, localChanges: false, unlocked: true, autoSync: config.autoSync, plan });
      }).catch((cause) => {
        const safe = publicError(cause);
        return report({ phase: safe.code === 'CLOUD_LOCKED' ? 'locked' : 'error', message: safe.message, code: safe.code,
          unlocked: safe.code === 'CLOUD_LOCKED' ? false : status.unlocked, localChanges: true });
      }).finally(() => { flight = undefined; });
      return flight;
    },
    startCloudSync() {
      if (started) return () => api.stopCloudSync();
      started = true;
      if (fullData) {
        fullSync.startFullDataSync();
        inspectSettings().then((settings) => { if (settings.autoSync && settings.unlocked) schedule(); }).catch(() => {});
        return () => api.stopCloudSync();
      }
      toolSync.startToolSync();
      unsubscribe = stateStore.subscribeState?.((state) => {
        if (applying) return;
        try {
          const portable = JSON.stringify(portableState(state));
          if (portable === lastObserved) return;
          lastObserved = portable;
          report({ localChanges: true }); schedule();
        } catch { /* Navigation storage validates its own external changes. */ }
      });
      const refresh = async () => {
        if (!started || eventDocument?.visibilityState === 'hidden' || now() - lastPull < pullInterval) return;
        try { const settings = await inspectSettings(); if (settings.autoSync && settings.unlocked) await api.syncCloudNow(); } catch { /* Leave the prior usable state. */ }
      };
      api._refresh = refresh;
      eventWindow?.addEventListener?.('focus', refresh);
      eventDocument?.addEventListener?.('visibilitychange', refresh);
      interval = setInterval(refresh, pullInterval);
      interval.unref?.();
      inspectSettings().then((settings) => { if (settings.autoSync && settings.unlocked) schedule(); }).catch(() => {});
      return () => api.stopCloudSync();
    },
    stopCloudSync() {
      fullSync?.stopFullDataSync();
      toolSync.stopToolSync();
      started = false; clearTimeout(timer); clearInterval(interval); unsubscribe?.(); unsubscribe = undefined;
      eventWindow?.removeEventListener?.('focus', api._refresh);
      eventDocument?.removeEventListener?.('visibilitychange', api._refresh);
    },
  };
  return api;
}

const cloud = createCloudSync();
export const { loadCloudSyncSettings, saveCloudSyncSettings, unlockCloudSync, lockCloudSync, syncCloudNow, getCloudSyncStatus,
  subscribeCloudSyncStatus, startCloudSync, stopCloudSync, getCloudSyncConflicts, restoreCloudSyncConflict,
  listCloudHistory, previewCloudHistory, restoreCloudHistory, clearCloudHistoryPreview,
  loadToolSyncSettings, setToolSyncEnabled, getToolSyncStatus, subscribeToolSyncStatus, getToolSyncConflicts, useToolSyncConflict, syncToolCloudNow } = cloud;
