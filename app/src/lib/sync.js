import { tr, getLocale } from "../i18n/index.js";
import { createEmptyState, createInitialState, letterIcon, migrateNavigationState } from './model.js';
import { siteIconAddress } from './site-icons.js';

// Each installation owns its keys. A shared mutable "whole state" key would let
// Chrome's last writer silently discard another device's offline changes.
export const SYNC_PREFIX = 'owntab.sync.v1.';
export const SYNC_LIMITS = Object.freeze({ total: 102400, item: 8192, items: 512 });
const encoder = new TextEncoder();
const copy = (value) => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const legacyVisualSettings = new Set(['adaptiveWallpaper', 'adaptIcons']);
const initialSites = new Map(createInitialState().entries.map((entry) => [entry.id, entry]));
const untouchedDefault = (value) => {
  const initial = initialSites.get(value?.id);
  if (!initial) return false;
  const normalized = { ...value, page: value.page ?? 0, iconUrl: siteIconAddress(value) };
  if (normalized.icon?.kind === 'url' && siteIconAddress({ ...value, iconUrl: normalized.icon.value }) === initial.iconUrl) normalized.icon = initial.icon;
  return Object.keys(normalized).length === Object.keys(initial).length && Object.entries(initial)
    .every(([key, expected]) => key === 'icon' ? normalized.icon?.kind === expected.kind && normalized.icon?.value === expected.value : normalized[key] === expected);
};
const validActor = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const error = (message, code = 'SYNC_INVALID') => Object.assign(new Error(message), { code });
const bytes = (value) => encoder.encode(value).length;
const itemBytes = (key, value) => bytes(key) + bytes(JSON.stringify(value));
const sameIconSource = (entry, local) => {
  if (entry.type !== local.type) return false;
  if (entry.type === 'folder') return true;
  try { return new URL(entry.url).origin === new URL(local.url).origin; }
  catch { return false; }
};

export function portableState(input) {
  const state = migrateNavigationState(input);
  state.revision = 0;
  // Sites carry a portable image address, never local bytes or an asset ID.
  // Folder previews and the independent background color remain portable too.
  for (const entry of state.entries) {
    if (entry.type === 'site') {
      entry.iconUrl = siteIconAddress(entry);
      entry.icon = { kind: 'url', value: entry.iconUrl };
    } else if (entry.icon.kind === 'image') entry.icon = letterIcon(entry.name);
  }
  if (state.settings.background.kind === 'image') state.settings.background = copy(createEmptyState().settings.background);
  return state;
}

function recordsOf(input) {
  const state = portableState(input);
  const records = Object.create(null);
  state.groups.forEach((value, position) => { records[`g:${value.id}`] = { ...value, position }; });
  state.providers.forEach((value, position) => { records[`p:${value.id}`] = { ...value, position }; });
  for (const value of state.entries) records[`e:${value.id}`] = value;
  for (const [key, value] of Object.entries(state.settings)) records[`s:${key}`] = value;
  return records;
}

export function createReplica(actor) {
  if (!validActor(actor)) throw error(tr("同步设备标识无效。"));
  return { version: 1, actor, clock: 0, records: {} };
}

export function validateReplica(input) {
  if (!input || input.version !== 1 || !validActor(input.actor) || !Number.isSafeInteger(input.clock) || input.clock < 0
    || !input.records || typeof input.records !== 'object' || Array.isArray(input.records)
    || Object.keys(input).some((key) => !['version', 'actor', 'clock', 'records'].includes(key))
    || Object.keys(input.records).length > 10000) throw error(tr("同步设备文档格式无效。"));
  for (const [key, operation] of Object.entries(input.records)) {
    if (!/^[geps]:[^\s\u0000-\u001f\u007f]{1,200}$/u.test(key) || !operation || typeof operation !== 'object'
      || Object.keys(operation).some((name) => !['n', 'context', 'value'].includes(name))
      || !Number.isSafeInteger(operation.n) || operation.n < 1 || operation.n > input.clock
      || !operation.context || typeof operation.context !== 'object' || Array.isArray(operation.context)
      || Object.keys(operation.context).length > 100 || !Object.hasOwn(operation, 'value')) throw error(tr("同步操作格式无效。"));
    for (const [actor, counter] of Object.entries(operation.context)) if (!validActor(actor) || !Number.isSafeInteger(counter) || counter < 0) throw error(tr("同步因果版本无效。"));
    if (key.startsWith('s:') && !Object.hasOwn(createEmptyState().settings, key.slice(2)) && !legacyVisualSettings.has(key.slice(2))) throw error(tr("同步设置包含未知字段。"));
    if (key.startsWith('s:') && legacyVisualSettings.has(key.slice(2)) && operation.value !== null && typeof operation.value !== 'boolean') throw error(tr("旧视觉设置无效。"));
    if (!key.startsWith('s:') && operation.value !== null && (!operation.value || typeof operation.value !== 'object' || operation.value.id !== key.slice(2))) throw error(tr("同步条目标识与内容不一致。"));
  }
  return copy(input);
}

export function combineReplicas(...collections) {
  const result = Object.create(null);
  for (const collection of collections) for (const document of Object.values(collection || {})) {
    const checked = validateReplica(document);
    const previous = result[checked.actor];
    if (!previous || checked.clock > previous.clock) result[checked.actor] = checked;
    else if (checked.clock === previous.clock && !same(checked, previous)) throw error(tr("同一同步设备出现不一致版本，已保留本地数据。"), 'SYNC_DEVICE_CONFLICT');
  }
  if (Object.keys(result).length > 100) throw error(tr("同步设备数量过多。"), 'SYNC_CAPACITY');
  return result;
}

export function recordChanges(replica, before, after, documents = {}, forced = {}) {
  const result = validateReplica(replica);
  const prior = recordsOf(before);
  const next = recordsOf(after);
  const changed = [...new Set([...Object.keys(prior), ...Object.keys(next), ...Object.keys(forced)])]
    .filter((key) => Object.hasOwn(forced, key) || !same(prior[key], next[key]));
  if (!changed.length) return result;
  const context = Object.fromEntries(Object.values(documents).map((document) => [document.actor, document.clock]));
  context[result.actor] = Math.max(context[result.actor] || 0, result.clock);
  result.clock++;
  for (const key of changed) result.records[key] = { n: result.clock, context: copy(context), value: copy(Object.hasOwn(forced, key) ? forced[key] : next[key] ?? null) };
  return validateReplica(result);
}

function alternatives(documents) {
  const records = new Map();
  for (const document of Object.values(documents)) for (const [key, operation] of Object.entries(document.records)) {
    if (!records.has(key)) records.set(key, []);
    records.get(key).push({ ...copy(operation), actor: document.actor });
  }
  const result = new Map();
  for (const [key, versions] of records) {
    const concurrent = versions.filter((version) => !versions.some((other) => other !== version
      && (other.actor === version.actor ? other.n > version.n : (other.context[version.actor] || 0) >= version.n)));
    // A concurrent deletion wins visibly, but its competing value remains recoverable.
    concurrent.sort((a, b) => Number(b.value === null) - Number(a.value === null)
      || Number(untouchedDefault(a.value)) - Number(untouchedDefault(b.value))
      || a.actor.localeCompare(b.actor) || b.n - a.n);
    result.set(key, concurrent);
  }
  return result;
}

export function syncConflicts(documents) {
  const result = [];
  for (const [key, versions] of alternatives(documents)) {
    // Group records are only read to recover an old device's ordering. The
    // active product no longer has groups that a user can choose to restore.
    if (key.startsWith('g:') || key.startsWith('s:') && legacyVisualSettings.has(key.slice(2))) continue;
    if (versions.length < 2) continue;
    const winner = versions[0];
    for (const version of versions.slice(1)) {
      if (same(version.value, winner.value)) continue;
      const kind = { e: 'entry', g: 'group', p: 'provider', s: 'setting' }[key[0]];
      result.push({ id: JSON.stringify([key, version.actor, version.n]), key, kind,
        name: version.value?.name || winner.value?.name || key.slice(2), deleted: version.value === null,
        value: copy(version.value), replica: version.actor, counter: version.n });
    }
  }
  return result;
}

export function materializeState(documents, localState = createEmptyState()) {
  const records = recordsOf(createEmptyState());
  const resolved = alternatives(documents);
  for (const [key, versions] of resolved) {
    if (versions[0]?.value === null) delete records[key];
    else if (versions[0]) records[key] = copy(versions[0].value);
  }
  const state = createEmptyState();
  const ordered = (prefix) => Object.entries(records).filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => value).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map(({ position: _position, ...value }) => value);
  state.groups = ordered('g:');
  if (!state.groups.length) state.groups = [{ id: 'group-home', name: '桌面' }];
  state.providers = ordered('p:');
  state.entries = Object.entries(records).filter(([key]) => key.startsWith('e:')).map(([, value]) => copy(value));
  for (const [key, value] of Object.entries(records)) if (key.startsWith('s:')) state.settings[key.slice(2)] = copy(value);
  // Default false is not an explicit user choice. Fold old toggles only until
  // a real unified-setting operation exists, including an explicit disable.
  if (!resolved.has('s:visualEnhancement')) delete state.settings.visualEnhancement;
  const groups = new Set(state.groups.map((group) => group.id));
  const byId = new Map(state.entries.map((entry) => [entry.id, entry]));
  // Concurrent folder/group deletion must not discard a surviving site's data.
  for (const entry of state.entries) {
    if (!groups.has(entry.groupId)) entry.groupId = state.groups[0].id;
    if (entry.type === 'folder') entry.parentId = null;
  }
  for (const entry of state.entries) if (entry.parentId !== null) {
    const parent = byId.get(entry.parentId);
    if (!parent || parent.type !== 'folder') entry.parentId = null;
    else entry.groupId = parent.groupId;
  }
  const containers = new Map();
  for (const entry of state.entries) {
    const key = JSON.stringify([entry.groupId, entry.parentId]);
    if (!containers.has(key)) containers.set(key, []);
    containers.get(key).push(entry);
  }
  for (const entries of containers.values()) entries.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).forEach((entry, order) => { entry.order = order; });
  const groupOrder = new Map(state.groups.map((group, index) => [group.id, index]));
  state.entries.sort((a, b) => groupOrder.get(a.groupId) - groupOrder.get(b.groupId)
    || (a.parentId || '').localeCompare(b.parentId || '') || a.order - b.order || a.id.localeCompare(b.id));
  // Keep an unchanged same-origin local image while its portable URL (or a
  // legacy text fallback) still matches. A remote icon change replaces it.
  const local = new Map(localState.entries.map((entry) => [entry.id, entry]));
  const portableLocal = new Map(portableState(localState).entries.map((entry) => [entry.id, entry]));
  for (const entry of state.entries) if (local.get(entry.id)?.icon.kind === 'image') {
    const localEntry = local.get(entry.id);
    const legacyFallback = { kind: 'letter', value: [...localEntry.name][0] || '网' };
    const renamedFallback = letterIcon(entry.name);
    const legacyRenamedFallback = { kind: 'letter', value: [...entry.name][0] || '网' };
    if (sameIconSource(entry, localEntry) && [portableLocal.get(entry.id)?.icon, legacyFallback, renamedFallback, legacyRenamedFallback]
      .some((fallback) => same(entry.icon, fallback))) entry.icon = copy(localEntry.icon);
  }
  state.revision = localState.revision;
  return migrateNavigationState(state);
}

async function digest(text) {
  const result = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(result)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

export function assertSyncCapacity(items) {
  const values = Object.entries(items);
  const total = values.reduce((sum, [key, value]) => sum + itemBytes(key, value), 0);
  if (values.length > SYNC_LIMITS.items || total > SYNC_LIMITS.total || values.some(([key, value]) => itemBytes(key, value) > SYNC_LIMITS.item)) {
    throw error(tr("浏览器同步区容量不足（总计 100 KiB、单项 8 KiB）；完整数据已保留本机，请减少导航或继续使用 ZIP 备份。"), 'SYNC_CAPACITY');
  }
  return total;
}

export async function packReplica(input) {
  const document = validateReplica(input);
  const text = JSON.stringify(document);
  if (bytes(text) > SYNC_LIMITS.total) throw error(tr("配置及同步历史超过浏览器同步容量；完整数据已保留本机。"), 'SYNC_CAPACITY');
  const hash = await digest(text);
  const base = `${SYNC_PREFIX}${document.actor}.${hash.slice(0, 16)}.`;
  const chunks = {};
  let chunk = '';
  let index = 0;
  let size = itemBytes(`${base}${index}`, '');
  for (const character of text) {
    const cost = bytes(JSON.stringify(character)) - 2;
    if (size + cost > 7600) {
      chunks[`${base}${index++}`] = chunk;
      chunk = '';
      size = itemBytes(`${base}${index}`, '');
    }
    chunk += character;
    size += cost;
  }
  chunks[`${base}${index}`] = chunk;
  const key = `${SYNC_PREFIX}${document.actor}.head`;
  const head = { version: 1, actor: document.actor, clock: document.clock, hash, bytes: bytes(text), parts: Object.keys(chunks) };
  assertSyncCapacity({ ...chunks, [key]: head });
  return { key, head, chunks };
}

export async function readReplicas(items) {
  assertSyncCapacity(items);
  const documents = Object.create(null);
  const incomplete = [];
  for (const [key, head] of Object.entries(items)) {
    if (!key.startsWith(SYNC_PREFIX) || !key.endsWith('.head')) continue;
    if (!head || head.version !== 1 || !validActor(head.actor) || key !== `${SYNC_PREFIX}${head.actor}.head`
      || !Number.isSafeInteger(head.clock) || head.clock < 0 || !/^[a-f0-9]{64}$/.test(head.hash)
      || !Number.isSafeInteger(head.bytes) || head.bytes < 1 || head.bytes > SYNC_LIMITS.total
      || !Array.isArray(head.parts) || !head.parts.length || head.parts.length > 32
      || new Set(head.parts).size !== head.parts.length
      || head.parts.some((part, index) => part !== `${SYNC_PREFIX}${head.actor}.${head.hash.slice(0, 16)}.${index}`)) throw error(tr("浏览器同步提交信息无效，未覆盖本地数据。"));
    if (head.parts.some((part) => typeof items[part] !== 'string')) { incomplete.push(head.actor); continue; }
    const text = head.parts.map((part) => items[part]).join('');
    if (bytes(text) !== head.bytes || await digest(text) !== head.hash) throw error(tr("浏览器同步分片校验失败，未覆盖本地数据。"));
    let document;
    try { document = validateReplica(JSON.parse(text)); } catch { throw error(tr("浏览器同步数据格式无效，未覆盖本地数据。")); }
    if (document.actor !== head.actor || document.clock !== head.clock) throw error(tr("浏览器同步版本信息不一致。"));
    documents[document.actor] = document;
  }
  return { documents, incomplete };
}

export async function publishReplica(store, document, items) {
  const packed = await packReplica(document);
  const obsolete = Object.keys(items).filter((key) => key.startsWith(`${SYNC_PREFIX}${document.actor}.`) && key !== packed.key && !Object.hasOwn(packed.chunks, key));
  if (same(items[packed.key], packed.head) && Object.entries(packed.chunks).every(([key, value]) => items[key] === value)) {
    // A previous commit may have succeeded while its cleanup failed. Retry that
    // cleanup even when no new chunks or head need to be written.
    if (obsolete.length) await store.remove(obsolete);
    const final = { ...items };
    for (const key of obsolete) delete final[key];
    return { bytes: assertSyncCapacity(final), written: false };
  }
  // Count staged + previous committed chunks. A quota failure must leave the old
  // commit readable rather than deleting it to make room for an uncommitted one.
  assertSyncCapacity({ ...items, ...packed.chunks, [packed.key]: items[packed.key] || packed.head });
  assertSyncCapacity({ ...items, ...packed.chunks, [packed.key]: packed.head });
  await store.set(packed.chunks);
  await store.set({ [packed.key]: packed.head });
  if (obsolete.length) await store.remove(obsolete);
  const final = { ...items, ...packed.chunks, [packed.key]: packed.head };
  for (const key of obsolete) delete final[key];
  return { bytes: assertSyncCapacity(final), written: true };
}

export function browserSyncStore() {
  const chrome = globalThis.chrome;
  if (!chrome?.runtime?.id || !chrome?.storage?.sync) return null;
  const call = (method, argument) => new Promise((resolve, reject) => {
    try {
      chrome.storage.sync[method](argument, (result) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) reject(error(lastError.message, 'SYNC_BROWSER_ERROR'));
        else resolve(result);
      });
    } catch (cause) { reject(cause); }
  });
  return {
    get: () => call('get', null), set: (items) => call('set', items), remove: (keys) => call('remove', keys),
    subscribe(callback) {
      const listener = (changes, area) => { if (area === 'sync' && Object.keys(changes).some((key) => key.startsWith(SYNC_PREFIX))) callback(); };
      chrome.storage.onChanged.addListener(listener);
      return () => chrome.storage.onChanged.removeListener(listener);
    },
  };
}
