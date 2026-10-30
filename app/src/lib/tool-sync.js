import { tr } from '../i18n/index.js';
import { localData } from './local-data.js';
import { sameJson } from './json-equal.js';
import { validatePersonalTools, loadPersonalTools, subscribePersonalTools, applySyncedPersonalTools } from './personal-tools.js';
import { encryptCloudPayload, decryptCloudPayload, CLOUD_OBJECT_LIMIT, CLOUD_PLAINTEXT_LIMIT } from './cloud-crypto.js';
import { parseCloudSnapshotName } from './cloud-providers.js';

// Tool bodies deliberately use their own local envelope and remote directory.
// No native browser storage.sync, credentials, snapshots or trash enter it.
const KEY = 'covelet.tools.cloud.v1', LOCK = 'covelet.tools.cloud.lock.v1';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const copy = (value) => structuredClone(value);
const fail = (code = 'TOOLS_SYNC_INVALID') => { throw Object.assign(new Error(code), { code }); };
const validActor = (value) => /^[a-f0-9]{32}$/.test(value);
const records = (data) => Object.fromEntries(['notes', 'reading'].flatMap((kind) => data[kind].map((record) => [`${kind}:${record.id}`, { ...copy(record), revision: 1 }])));
const portable = (data) => {
  const checked = validatePersonalTools({ version: 3, revision: 0, notes: data.notes, reading: data.reading, snapshots: [], trash: [] });
  return { notes: checked.notes.map((record) => ({ ...record, revision: 1 })).sort((a, b) => a.id.localeCompare(b.id)),
    reading: checked.reading.map((record) => ({ ...record, revision: 1 })).sort((a, b) => a.id.localeCompare(b.id)) };
};
const empty = () => ({ version: 1, enabled: false, metadata: null });
function defaultStore() {
  return {
    async read() {
      return (await localData.get(KEY))[KEY] || null;
    },
    async write(value) {
      await localData.set({ [KEY]: value });
    },
    subscribe(callback) {
      return localData.subscribe((items) => { if (items[KEY]) callback(); });
    },
  };
}
const safeMessages = {
  get TOOLS_SYNC_INVALID() { return tr('便笺与阅读同步文档无效，本机内容已保留。'); },
  get TOOLS_SYNC_CAPACITY() { return tr('便笺与阅读同步超出限制，请先完整备份并整理内容；本机内容仍可离线使用。'); },
  get TOOLS_SYNC_LOCAL() { return tr('无法保存本机工具同步状态，未上传新版本。'); },
  get TOOLS_SYNC_TARGET() { return tr('工具内容还有待上传或冲突版本，请先处理后再切换存储位置。'); },
  get CLOUD_LOCKED() { return tr('请先解锁自选存储连接，再同步便笺与阅读。'); },
  get CLOUD_PERMISSION() { return tr('尚未授权访问这个云服务，请先在设置中授权。'); },
  get CLOUD_DECRYPT() { return tr('无法解密同步数据：请检查加密口令，或确认云端文档未损坏。'); },
  get CLOUD_AUTH() { return tr('云存储身份验证失败，请检查凭据和访问权限。'); },
  get CLOUD_NOT_FOUND() { return tr('工具同步目录不可访问，请检查所选保存目录是否存在及其读写权限。'); },
  get CLOUD_RATE_LIMIT() { return tr('云服务请求过于频繁，请稍后重试。'); },
  get CLOUD_INVALID_CONFIG() { return tr('云存储配置无效，请检查填写内容。'); },
  get CLOUD_CREDENTIALS() { return tr('请输入有效的云存储访问凭据。'); },
  get CLOUD_INTEGRITY() { return tr('云端同步数据校验失败，未用部分数据覆盖本机。'); },
  get CLOUD_INVALID_RESPONSE() { return tr('云服务返回了无效的数据，本地数据未被覆盖。'); },
  get CLOUD_CONFLICT() { return tr('云端存在同名但内容不同的快照，已停止写入并保留本地数据。'); },
  get CLOUD_TIMEOUT() { return tr('WebDAV 连接超时，未完成的操作会在下次同步时核对。'); },
  get REVISION_CONFLICT() { return tr('工具内容已在其他页面更新，本次未覆盖，请重新同步。'); },
  get TOOLS_SYNC_REQUEST() { return tr('便笺与阅读同步失败，请检查网络、存储目录和访问权限；本机内容已保留。'); },
};
function safeError(reason) {
  const code = Object.hasOwn(safeMessages, reason?.code) ? reason.code : ['CLOUD_CAPACITY', 'CLOUD_LIMIT'].includes(reason?.code) ? 'TOOLS_SYNC_CAPACITY' : 'TOOLS_SYNC_REQUEST';
  return Object.assign(new Error(safeMessages[code]), { code });
}

export function validateToolReplica(value) {
  if (!value || value.version !== 1 || !validActor(value.actor) || !Number.isSafeInteger(value.clock) || value.clock < 0
    || Object.keys(value).some((key) => !['version', 'actor', 'clock', 'records'].includes(key))
    || !value.records || Array.isArray(value.records) || typeof value.records !== 'object' || Object.keys(value.records).length > 3000) fail();
  for (const [key, op] of Object.entries(value.records)) {
    const match = /^(notes|reading):([a-z\d-]{1,100})$/i.exec(key);
    if (!match || !op || Object.keys(op).some((field) => !['n', 'context', 'value'].includes(field))
      || !Number.isSafeInteger(op.n) || op.n < 1 || op.n > value.clock || !Object.hasOwn(op, 'value')
      || !op.context || typeof op.context !== 'object' || Array.isArray(op.context) || Object.keys(op.context).length > 100) fail();
    for (const [actor, clock] of Object.entries(op.context)) if (!validActor(actor) || !Number.isSafeInteger(clock) || clock < 0) fail();
    if (op.value !== null) {
      if (op.value?.id !== match[2] || op.value.revision !== 1) fail();
      try { portable({ notes: match[1] === 'notes' ? [op.value] : [], reading: match[1] === 'reading' ? [op.value] : [] }); } catch { fail(); }
    }
  }
  if (encoder.encode(JSON.stringify(value)).length > CLOUD_PLAINTEXT_LIMIT - 100) fail('TOOLS_SYNC_CAPACITY');
  return copy(value);
}
function combine(...collections) {
  const result = {};
  for (const values of collections) for (const candidate of Object.values(values || {})) {
    const document = validateToolReplica(candidate), prior = result[document.actor];
    if (!prior || document.clock > prior.clock) result[document.actor] = document;
    else if (document.clock === prior.clock && !sameJson(document, prior)) fail();
  }
  if (Object.keys(result).length > 100 || encoder.encode(JSON.stringify(result)).length > 4 * 1024 * 1024) fail('TOOLS_SYNC_CAPACITY');
  return result;
}
function alternatives(documents) {
  const all = new Map();
  for (const doc of Object.values(documents)) for (const [key, operation] of Object.entries(doc.records)) {
    if (!all.has(key)) all.set(key, []);
    all.get(key).push({ ...copy(operation), actor: doc.actor });
  }
  return new Map([...all].map(([key, versions]) => [key, versions.filter((version) => !versions.some((other) => other !== version
    && (other.actor === version.actor ? other.n > version.n : (other.context[version.actor] || 0) >= version.n)))
    .sort((a, b) => Number(b.value === null) - Number(a.value === null) || a.actor.localeCompare(b.actor) || b.n - a.n)]));
}
export function materializeToolReplicas(documents) {
  const result = { notes: [], reading: [] }, conflicts = [], urls = new Set();
  for (const [key, versions] of [...alternatives(documents)].sort(([a], [b]) => a.localeCompare(b))) {
    const winner = versions[0], kind = key.split(':')[0];
    const divergent = versions.some((version) => !sameJson(version.value, winner.value));
    for (const version of versions) if (divergent && version.value !== null) conflicts.push({ id: JSON.stringify([key, version.actor, version.n]), key, kind, value: copy(version.value) });
    if (!winner?.value) continue;
    if (kind === 'reading' && urls.has(winner.value.url)) {
      const id = JSON.stringify([key, winner.actor, winner.n]), existing = conflicts.find((item) => item.id === id);
      if (existing) existing.duplicate = true;
      else conflicts.push({ id, key, kind, value: copy(winner.value), duplicate: true });
      for (const conflict of conflicts) if (conflict.key === key) conflict.duplicate = true;
      continue;
    }
    if (kind === 'reading') urls.add(winner.value.url);
    result[kind].push(copy(winner.value));
  }
  if (result.notes.length > 200 || result.reading.length > 500) fail('TOOLS_SYNC_CAPACITY');
  return { data: portable(result), conflicts };
}
const materialize = materializeToolReplicas;
function author(document, before, after, observed) {
  const result = validateToolReplica(document), old = records(before), next = records(after);
  const changed = [...new Set([...Object.keys(old), ...Object.keys(next)])].filter((key) => !sameJson(old[key], next[key]));
  if (!changed.length) return result;
  const context = Object.fromEntries(Object.values(observed).map((doc) => [doc.actor, doc.clock]));
  context[result.actor] = result.clock; result.clock++;
  for (const key of changed) result.records[key] = { n: result.clock, context: copy(context), value: next[key] ?? null };
  return validateToolReplica(result);
}

export function createToolSync({ access, store = defaultStore(), tools = { loadPersonalTools, subscribePersonalTools, applySyncedPersonalTools },
  locks = globalThis.navigator?.locks, crypto = globalThis.crypto, uuid = () => crypto.randomUUID(), now = () => Date.now(),
  autoDelay = 15_000, pullInterval = 60_000, eventWindow = globalThis.window, eventDocument = globalThis.document } = {}) {
  let serial = Promise.resolve(), flight, started = false, applying = false, timer, interval, unsubscribe, unsubscribeConfig;
  const listeners = new Set();
  let status = { enabled: false, phase: 'disabled', pending: 0, lastSync: 0, conflicts: 0, message: '', code: null };
  const report = (patch) => { status = { ...status, ...patch }; for (const listener of listeners) { try { listener(copy(status)); } catch {} } return copy(status); };
  const exclusive = (action) => {
    if (locks?.request) return locks.request(LOCK, { mode: 'exclusive' }, action);
    if (globalThis.chrome?.runtime?.id) return Promise.reject(safeError({ code: 'TOOLS_SYNC_LOCAL' }));
    const result = serial.then(action, action); serial = result.catch(() => {}); return result;
  };
  const hash = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (part) => part.toString(16).padStart(2, '0')).join('');
  const read = async () => {
    const value = await store.read() || empty();
    if (value.version !== 1 || typeof value.enabled !== 'boolean' || Object.keys(value).some((key) => !['version', 'enabled', 'metadata'].includes(key))) fail();
    if (value.metadata) {
      const m = value.metadata;
      if (!/^[a-f0-9]{64}$/.test(m.target) || !Number.isFinite(m.lastSync) || m.lastSync < 0 || !Number.isSafeInteger(m.publishedClock)
        || m.publishedClock < 0 || Object.keys(m).some((key) => !['target', 'document', 'documents', 'base', 'pending', 'publishedClock', 'lastSync'].includes(key))) fail();
      validateToolReplica(m.document); combine(m.documents, { [m.document.actor]: m.document }); portable(m.base);
      if (m.publishedClock > m.document.clock || m.pending && (typeof m.pending.body !== 'string' || encoder.encode(m.pending.body).length > CLOUD_OBJECT_LIMIT
        || !parseCloudSnapshotName(m.pending.name) || Object.keys(m.pending).some((key) => !['name', 'body'].includes(key)))) fail();
    }
    return copy(value);
  };
  const persist = async (value) => { try { await store.write(copy(value)); } catch { fail('TOOLS_SYNC_LOCAL'); } };
  const pendingCount = (metadata, data) => {
    const a = records(metadata?.base || { notes: [], reading: [] }), b = records(data);
    const changed = new Set([...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !sameJson(a[key], b[key])));
    if (metadata) for (const [key, operation] of Object.entries(metadata.document.records)) if (operation.n > metadata.publishedClock) changed.add(key);
    return changed.size;
  };
  const inspect = async () => {
    const config = await read(), data = portable(await tools.loadPersonalTools());
    return report({ enabled: config.enabled, phase: config.enabled ? status.phase === 'syncing' ? 'syncing' : status.phase === 'error' ? 'error' : 'idle' : 'disabled',
      pending: pendingCount(config.metadata, data), lastSync: config.metadata?.lastSync || 0,
      conflicts: config.metadata ? materialize(config.metadata.documents).conflicts.length : 0 });
  };
  const schedule = () => {
    clearTimeout(timer); if (!started) return;
    timer = setTimeout(async () => { try { const config = await read(); if (!config.enabled) return; const connection = await access(); if (connection.autoSync) await api.syncToolCloudNow(); } catch {} }, autoDelay);
    timer.unref?.();
  };
  const parse = async (name, bytes, password) => {
    const identity = parseCloudSnapshotName(name);
    if (!identity || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > CLOUD_OBJECT_LIMIT || await hash(bytes) !== identity.digest) fail();
    const plaintext = await decryptCloudPayload(bytes, password, { crypto });
    let payload;
    try { payload = JSON.parse(decoder.decode(plaintext)); } catch { fail(); }
    if (payload?.format !== 'covelet-tools-sync' || payload.version !== 1 || Object.keys(payload).some((key) => !['format', 'version', 'document'].includes(key))) fail();
    const document = validateToolReplica(payload.document);
    if (document.actor !== identity.actor || document.clock !== identity.clock) fail();
    return document;
  };
  const publish = async (config, connection, names) => {
    const m = config.metadata; if (!m.pending) return;
    const bytes = encoder.encode(m.pending.body), document = await parse(m.pending.name, bytes, connection.password);
    if (!sameJson(document, m.document)) fail();
    await connection.check(); if (!names.has(m.pending.name)) await connection.provider.write(m.pending.name, bytes);
    await connection.check(); m.publishedClock = document.clock; m.pending = null; await persist(config);
  };
  const api = {
    getToolSyncStatus: () => copy(status),
    subscribeToolSyncStatus(listener) { listeners.add(listener); listener(copy(status)); return () => listeners.delete(listener); },
    async loadToolSyncSettings() { try { await inspect(); return { enabled: status.enabled }; } catch (reason) { throw safeError(reason); } },
    async setToolSyncEnabled(enabled) {
      try { if (typeof enabled !== 'boolean') fail(); await exclusive(async () => { const config = await read(); config.enabled = enabled; await persist(config); }); await inspect(); schedule(); return { enabled }; }
      catch (reason) { throw safeError(reason); }
    },
    async ensureToolTarget(target) {
      const config = await read(), m = config.metadata;
      if (m && m.target !== target && (m.pending || m.document.clock > m.publishedClock || materialize(m.documents).conflicts.length || pendingCount(m, portable(await tools.loadPersonalTools())))) fail('TOOLS_SYNC_TARGET');
    },
    async guardToolTarget(target, action) { return exclusive(async () => { await api.ensureToolTarget(target); return action(); }); },
    async getToolSyncConflicts() { try { const config = await read(); return config.metadata ? materialize(config.metadata.documents).conflicts : []; } catch (reason) { throw safeError(reason); } },
    async useToolSyncConflict(id, { discard = false } = {}) {
      try {
        return await exclusive(async () => {
          const config = await read(), m = config.metadata;
          if (!m || m.pending) fail('TOOLS_SYNC_TARGET');
          const local = await tools.loadPersonalTools(), data = portable(local);
          let document = author(m.document, m.base, data, m.documents);
          const documents = combine(m.documents, { [document.actor]: document });
          const conflict = materialize(documents).conflicts.find((item) => item.id === id); if (!conflict) fail();
          const context = Object.fromEntries(Object.values(documents).map((doc) => [doc.actor, doc.clock]));
          document.clock++; document.records[conflict.key] = { n: document.clock, context, value: discard ? null : copy(conflict.value) };
          document = validateToolReplica(document);
          const nextDocuments = combine(documents, { [document.actor]: document }), next = materialize(nextDocuments);
          // Duplicate URLs cannot be represented twice in the reading list;
          // keep that competing record exportable instead of discarding it.
          if (!discard && !next.data[conflict.kind].some((record) => record.id === conflict.value.id)) fail();
          m.document = document; m.documents = combine(m.documents, { [document.actor]: document }); m.base = data; await persist(config);
          applying = true; let saved;
          try { saved = await tools.applySyncedPersonalTools(next.data, { expectedRevision: local.revision }); } finally { applying = false; }
          m.documents = nextDocuments; m.base = portable(saved); await persist(config);
          await inspect(); schedule(); return copy(saved);
        });
      } catch (reason) { throw safeError(reason); }
    },
    async syncToolCloudNow() {
      if (flight) return flight;
      flight = exclusive(async () => {
        const config = await read(); if (!config.enabled) return inspect();
        const connection = await access(); await connection.check();
        if (config.metadata?.target !== connection.target) {
          await api.ensureToolTarget(connection.target);
          const actor = uuid().replaceAll('-', '').toLowerCase(); if (!validActor(actor)) fail();
          config.metadata = { target: connection.target, document: { version: 1, actor, clock: 0, records: {} }, documents: {}, base: { notes: [], reading: [] }, pending: null, publishedClock: 0, lastSync: 0 };
        }
        const m = config.metadata;
        report({ phase: 'syncing', message: tr('正在同步加密便笺与阅读。'), code: null });
        let listing;
        try { listing = await connection.provider.list(); }
        catch (reason) {
          if (reason?.code !== 'CLOUD_NOT_FOUND' || !connection.provider.ensureToolDirectory) throw reason;
          await connection.check(); await connection.provider.ensureToolDirectory();
          // 405 can mean an existing non-collection. The normal strict listing
          // must prove a complete directory before any data write is allowed.
          listing = await connection.provider.list();
        }
        if (!Array.isArray(listing) || listing.length > 2000) fail('TOOLS_SYNC_CAPACITY');
        const latest = new Map(), names = new Set();
        for (const item of listing) {
          const identity = parseCloudSnapshotName(item?.name); if (!identity || names.has(item.name)) fail(); names.add(item.name);
          if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > CLOUD_OBJECT_LIMIT)) fail('TOOLS_SYNC_CAPACITY');
          const prior = latest.get(identity.actor);
          if (!prior || identity.clock > prior.clock) latest.set(identity.actor, { ...identity, name: item.name });
          else if (identity.clock === prior.clock && identity.digest !== prior.digest) fail();
        }
        if (latest.size > 100) fail('TOOLS_SYNC_CAPACITY');
        const incoming = {}; let total = 0;
        for (const item of latest.values()) { await connection.check(); const bytes = await connection.provider.read(item.name); total += bytes?.byteLength || 0; if (total > 4 * 1024 * 1024) fail('TOOLS_SYNC_CAPACITY'); incoming[item.actor] = await parse(item.name, bytes, connection.password); }
        const own = incoming[m.document.actor]; if (own && (own.clock > m.document.clock || own.clock === m.document.clock && !sameJson(own, m.document))) fail();
        const received = combine(m.documents, incoming, { [m.document.actor]: m.document }); materialize(received);
        await publish(config, connection, names);
        const local = await tools.loadPersonalTools(), localData = portable(local);
        // Offline changes only observe the previous committed baseline. Freshly
        // fetched clocks cannot silently supersede edits the user never saw.
        const document = author(m.document, m.base, localData, m.documents), documents = combine(received, { [document.actor]: document });
        const merged = materialize(documents);
        m.document = document; m.documents = combine(m.documents, { [document.actor]: document }); m.base = localData;
        await persist(config); await connection.check();
        let saved = local;
        if (!sameJson(localData, merged.data)) { applying = true; try { saved = await tools.applySyncedPersonalTools(merged.data, { expectedRevision: local.revision }); } finally { applying = false; } }
        m.documents = documents; m.base = portable(saved); await persist(config);
        if (document.clock > m.publishedClock) {
          const plain = encoder.encode(JSON.stringify({ format: 'covelet-tools-sync', version: 1, document }));
          const bytes = await encryptCloudPayload(plain, connection.password, { crypto });
          m.pending = { name: `covelet-${document.actor}-${document.clock}-${await hash(bytes)}.json`, body: decoder.decode(bytes) };
          await persist(config); await publish(config, connection, new Set());
        }
        await connection.check(); m.lastSync = now(); await persist(config);
        // A new edit while the write was in flight remains visibly pending.
        const pending = pendingCount(m, portable(await tools.loadPersonalTools()));
        return report({ enabled: true, phase: 'saved', message: tr('本机已完成上传与合并，其他设备须自行同步。'), code: null, lastSync: m.lastSync, pending, conflicts: merged.conflicts.length });
      }).catch(async (reason) => {
        const safe = safeError(reason);
        try { const config = await read(); report({ pending: pendingCount(config.metadata, portable(await tools.loadPersonalTools())) }); } catch { /* Preserve the last known count if local storage also failed. */ }
        return report({ phase: safe.code === 'CLOUD_LOCKED' ? 'locked' : 'error', code: safe.code, message: safe.message });
      }).finally(() => { flight = undefined; });
      return flight;
    },
    startToolSync() {
      if (started) return () => api.stopToolSync(); started = true;
      unsubscribe = tools.subscribePersonalTools?.(() => { if (!applying) { inspect().catch(() => {}); schedule(); } });
      unsubscribeConfig = store.subscribe?.(() => { inspect().catch(() => {}); });
      const refresh = () => { if (eventDocument?.visibilityState !== 'hidden') schedule(); };
      api._refresh = refresh; eventWindow?.addEventListener?.('focus', refresh); eventDocument?.addEventListener?.('visibilitychange', refresh);
      interval = setInterval(refresh, pullInterval); interval.unref?.(); inspect().then(schedule).catch(() => {}); return () => api.stopToolSync();
    },
    stopToolSync() { started = false; clearTimeout(timer); clearInterval(interval); unsubscribe?.(); unsubscribeConfig?.(); eventWindow?.removeEventListener?.('focus', api._refresh); eventDocument?.removeEventListener?.('visibilitychange', api._refresh); },
  };
  return api;
}
