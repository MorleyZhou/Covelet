import { useEffect, useState } from 'react';
import { tr } from '../i18n/index.js';
import { localData } from './local-data.js';
import { createPrivacyCredential, validatePrivacyCredential, verifyPrivacyPassword, validateNewPrivacyPassword } from './privacy-lock.js';

const demo = typeof location !== 'undefined' && import.meta.env?.DEV && new URLSearchParams(location.search).has('demo');
const KEY = demo ? 'covelet.content.preferences.demo.v1' : 'covelet.content.preferences.v1';
const LOCK_KEY = demo ? 'covelet.privacy.lock.demo.v1' : 'covelet.privacy.lock.v1';
const native = () => !demo && Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.local);
const listeners = new Set();
const empty = () => ({ version: 1, revision: 0, aliases: {}, privateKeys: [], presentation: false });
const validKey = (key) => /^(site|note|reading|widget|folder):[^\s\u0000-\u001f\u007f]{1,200}$/u.test(key);
const metadataKey = (key) => typeof key === 'string' && /^(site|note|reading):[^\s\u0000-\u001f\u007f]{1,200}$/u.test(key);
const tagIdentity = (id) => typeof id === 'string' && /^[a-z\d-]{1,100}$/i.test(id);
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
export const CONTENT_LIBRARY_LIMITS = Object.freeze({ description: 1000, tagName: 60, tags: 200, itemTags: 20, items: 3000, bytes: 1024 * 1024 });
const emptyLibrary = () => ({ version: 1, tags: [], items: {} });
const invalidLibrary = () => { throw Error(tr('备注和标签无效或超出大小限制。')); };
const normalizedTagName = (name) => name.normalize('NFKC').toLowerCase();
function checkedTagName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > CONTENT_LIBRARY_LIMITS.tagName || /[\u0000-\u001f\u007f]/u.test(name)) invalidLibrary();
  return name.trim();
}
function checkedMetadata(value, tags) {
  if (!fields(value, ['description', 'tagIds']) || typeof value.description !== 'string' || value.description.length > CONTENT_LIBRARY_LIMITS.description
    || value.description.includes('\0') || !Array.isArray(value.tagIds) || value.tagIds.length > CONTENT_LIBRARY_LIMITS.itemTags
    || new Set(value.tagIds).size !== value.tagIds.length || value.tagIds.some((id) => !tagIdentity(id) || !tags.has(id))) invalidLibrary();
  return { description: value.description.trim(), tagIds: [...value.tagIds] };
}
function checkedLibrary(value) {
  if (!fields(value, ['version', 'tags', 'items']) || value.version !== 1 || !Array.isArray(value.tags) || value.tags.length > CONTENT_LIBRARY_LIMITS.tags
    || !fields(value.items, Object.keys(value.items || {})) || Object.keys(value.items).length > CONTENT_LIBRARY_LIMITS.items) invalidLibrary();
  const ids = new Set(), names = new Set(), tags = value.tags.map((tag) => {
    if (!fields(tag, ['id', 'name']) || !tagIdentity(tag.id) || ids.has(tag.id)) invalidLibrary();
    const name = checkedTagName(tag.name), identity = normalizedTagName(name);
    if (names.has(identity)) invalidLibrary();
    ids.add(tag.id); names.add(identity); return { id: tag.id, name };
  });
  const items = {};
  for (const [key, metadata] of Object.entries(value.items)) {
    if (!metadataKey(key)) invalidLibrary();
    items[key] = checkedMetadata(metadata, ids);
  }
  const result = { version: 1, tags, items };
  if (new TextEncoder().encode(JSON.stringify(result)).length > CONTENT_LIBRARY_LIMITS.bytes) invalidLibrary();
  return result;
}
const hiddenMetadata = (preferences, key, hiddenKeys = []) => preferences.presentation === true
  && (preferences.privateKeys?.includes(key) || (hiddenKeys instanceof Set ? hiddenKeys.has(key) : hiddenKeys.includes(key)));
export function getContentMetadata(preferences, key, { hiddenKeys = [] } = {}) {
  if (!metadataKey(key) || hiddenMetadata(preferences, key, hiddenKeys)) return { description: '', tagIds: [] };
  const value = preferences.library?.items[key];
  return value ? structuredClone(value) : { description: '', tagIds: [] };
}
export function getContentTags(preferences, { hiddenKeys = [] } = {}) {
  const tags = preferences.library?.tags || [];
  if (!preferences.presentation) return structuredClone(tags);
  const visible = new Set(Object.entries(preferences.library?.items || {}).filter(([key]) => !hiddenMetadata(preferences, key, hiddenKeys)).flatMap(([, value]) => value.tagIds));
  return structuredClone(tags.filter((tag) => visible.has(tag.id)));
}
function validate(value) {
  if (value == null) return empty();
  if (value.version !== 1 || !value.aliases || typeof value.aliases !== 'object' || Array.isArray(value.aliases)
    || Object.keys(value.aliases).length > 12000 || value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)
    || Object.keys(value).some((key) => !['version', 'revision', 'aliases', 'privateKeys', 'presentation', 'library'].includes(key))
    || value.presentation !== undefined && typeof value.presentation !== 'boolean'
    || value.privateKeys !== undefined && (!Array.isArray(value.privateKeys) || value.privateKeys.length > 12000 || value.privateKeys.some((key) => typeof key !== 'string' || !validKey(key)))) throw Error(tr('本机内容偏好无效。'));
  const aliases = {};
  for (const [key, alias] of Object.entries(value.aliases)) {
    if (!validKey(key) || typeof alias !== 'string' || alias.length > 200 || /[\u0000-\u001f]/.test(alias)) throw Error(tr('搜索别名无效。'));
    if (alias.trim()) aliases[key] = alias.trim();
  }
  return { version: 1, revision: value.revision ?? 0, aliases, privateKeys: [...new Set(value.privateKeys || [])], presentation: value.presentation === true,
    ...(Object.hasOwn(value, 'library') ? { library: checkedLibrary(value.library) } : {}) };
}
export async function loadContentPreferences() {
  return validate((await localData.get(KEY))[KEY]);
}
export async function saveContentAlias(key, alias) {
  return saveContentSettings(key, { alias });
}
export async function saveContentSettings(key, patch, options = {}) {
  if (!validKey(key)) throw Error(tr('搜索别名无效。'));
  return mutateContentPreferences(async (current) => {
    if (current.presentation && current.privateKeys.includes(key)) throw privacyError('请先输入密码解除隐藏。', 'PRIVACY_LOCKED');
    checkExpectedMetadata(current, key, options.expectedMetadata);
    if (current.presentation && key.startsWith('site:')) {
      const navigation = (await localData.get('owntab.local.v1'))['owntab.local.v1']?.state;
      const entry = navigation?.entries?.find((item) => `site:${item.id}` === key);
      if (entry?.parentId && current.privateKeys.includes(`folder:${entry.parentId}`)) throw privacyError('请先输入密码解除隐藏。', 'PRIVACY_LOCKED');
    }
    const privateKeys = new Set(current.privateKeys);
    if (patch.private !== undefined) {
      if (typeof patch.private !== 'boolean') throw Error(tr('本机内容偏好无效。'));
      if (patch.private) privateKeys.add(key); else privateKeys.delete(key);
    }
    const next = { ...current, aliases: patch.alias === undefined ? current.aliases : { ...current.aliases, [key]: patch.alias } };
    const changed = patch.description === undefined && patch.tagIds === undefined ? next : applyContentMetadata(next, key, patch);
    return { ...changed, privateKeys: [...privateKeys] };
  }, options);
}
function applyContentMetadata(current, key, patch) {
  if (!metadataKey(key)) invalidLibrary();
  if (current.presentation && current.privateKeys.includes(key)) throw privacyError('请先输入密码解除隐藏。', 'PRIVACY_LOCKED');
  const library = structuredClone(current.library || emptyLibrary()), previous = library.items[key] || { description: '', tagIds: [] };
  const metadata = checkedMetadata({ description: patch.description ?? previous.description, tagIds: patch.tagIds ?? previous.tagIds }, new Set(library.tags.map((tag) => tag.id)));
  if (!current.library && !metadata.description && !metadata.tagIds.length) return current;
  if (metadata.description || metadata.tagIds.length) library.items[key] = metadata;
  else delete library.items[key];
  return { ...current, library: checkedLibrary(library) };
}
function checkExpectedMetadata(current, key, expected) {
  if (expected === undefined) return;
  const actual = current.library?.items[key] || { description: '', tagIds: [] };
  if (!fields(expected, ['description', 'tagIds']) || expected.description !== actual.description || !Array.isArray(expected.tagIds)
    || JSON.stringify(expected.tagIds) !== JSON.stringify(actual.tagIds)) {
    throw Object.assign(Error(tr('内容已在其他页面更新，请重新打开后重试。')), { code: 'REVISION_CONFLICT' });
  }
}
export function saveContentMetadata(key, patch, options = {}) { return saveContentSettings(key, patch, options); }
export async function createContentTag(name, options = {}) {
  const tag = { id: `tag-${crypto.randomUUID()}`, name: checkedTagName(name) };
  await mutateContentPreferences((current) => {
    const library = structuredClone(current.library || emptyLibrary());
    if (library.tags.some((item) => normalizedTagName(item.name) === normalizedTagName(tag.name))) throw Error(tr(current.presentation ? '此标签名称不可用，请换一个名称。' : '已有同名标签。'));
    library.tags.push(tag); return { ...current, library };
  }, options);
  return tag;
}
async function mutateTag(id, change, options) {
  if (!tagIdentity(id)) invalidLibrary();
  return mutateContentPreferences((current) => {
    const library = structuredClone(current.library || emptyLibrary());
    if (!library.tags.some((tag) => tag.id === id)) throw Error(tr('标签已被移除，请重新选择。'));
    if (current.presentation) throw privacyError('请先输入密码解除隐藏。', 'PRIVACY_LOCKED');
    change(library); return { ...current, library };
  }, options);
}
export function renameContentTag(id, name, options = {}) {
  const nextName = checkedTagName(name);
  return mutateTag(id, (library) => {
    if (library.tags.some((tag) => tag.id !== id && normalizedTagName(tag.name) === normalizedTagName(nextName))) throw Error(tr('已有同名标签。'));
    library.tags = library.tags.map((tag) => tag.id === id ? { ...tag, name: nextName } : tag);
  }, options);
}
export function deleteContentTag(id, options = {}) {
  return mutateTag(id, (library) => {
    library.tags = library.tags.filter((tag) => tag.id !== id);
    for (const [key, value] of Object.entries(library.items)) {
      const metadata = { ...value, tagIds: value.tagIds.filter((tagId) => tagId !== id) };
      if (metadata.description || metadata.tagIds.length) library.items[key] = metadata;
      else delete library.items[key];
    }
  }, options);
}
async function readCredential() {
  return validatePrivacyCredential((await localData.get(LOCK_KEY))[LOCK_KEY]);
}
export async function getPrivacyLockStatus() {
  return { configured: Boolean(await readCredential()) };
}
const privacyError = (message, code) => Object.assign(Error(tr(message)), { code });
async function writeCredential(credential) {
  await localData.set({ [LOCK_KEY]: credential });
}
async function authenticate(credential, password) {
  const result = await verifyPrivacyPassword(credential, password);
  if (!result.valid) {
    await writeCredential(result.credential);
    throw privacyError('隐藏密码不正确。', 'PRIVACY_PASSWORD');
  }
  return result.credential;
}
export async function setPresentationMode(enabled, { password, setup = false } = {}) {
  if (typeof enabled !== 'boolean') throw Error(tr('本机内容偏好无效。'));
  return withPreferencesLock(async () => {
    const current = await loadContentPreferences();
    let credential = await readCredential();
    if (enabled) {
      if (setup && credential) throw privacyError('隐藏密码已在其他页面设置，请使用该密码解锁。', 'PRIVACY_CONFIGURED');
      if (!credential) {
        if (!setup) throw privacyError('请先设置隐藏密码。', 'PRIVACY_SETUP_REQUIRED');
        credential = await createPrivacyCredential(password);
      }
    } else {
      if (!current.presentation) return current;
      credential = await authenticate(credential, password);
    }
    return persistPreferences({ ...current, presentation: enabled, revision: current.revision + 1 }, credential);
  });
}
export async function changePrivacyPassword(password, replacement) {
  validateNewPrivacyPassword(replacement);
  return withPreferencesLock(async () => {
    await authenticate(await readCredential(), password);
    await writeCredential(await createPrivacyCredential(replacement));
  });
}
export const validateContentPreferences = (value) => validate(structuredClone(value));
export function contentPreferencesForKeys(preferences, keys) {
  const current = validate(preferences), selected = new Set(keys);
  const result = { ...empty(), aliases: Object.fromEntries(Object.entries(current.aliases).filter(([key]) => selected.has(key))),
    privateKeys: current.privateKeys.filter((key) => selected.has(key)) };
  const items = Object.fromEntries(Object.entries(current.library?.items || {}).filter(([key]) => selected.has(key)));
  if (Object.keys(items).length) {
    const usedTags = new Set(Object.values(items).flatMap((item) => item.tagIds));
    result.library = { version: 1, tags: current.library.tags.filter((tag) => usedTags.has(tag.id)), items };
  }
  return validate(result);
}
export function mergeContentPreferences(current, incoming, { replaceKeys = [] } = {}) {
  const before = validate(current), source = validate(incoming);
  const replacing = new Set(replaceKeys);
  const result = { ...before, aliases: { ...source.aliases, ...Object.fromEntries(Object.entries(before.aliases).filter(([key]) => !replacing.has(key))) }, privateKeys: [...new Set([...before.privateKeys, ...source.privateKeys])] };
  if (!before.library && !source.library) return result;
  const library = structuredClone(before.library || emptyLibrary()), mapping = new Map();
  for (const key of replacing) delete library.items[key];
  for (const tag of source.library?.tags || []) {
    const existing = library.tags.find((item) => item.id === tag.id) || library.tags.find((item) => normalizedTagName(item.name) === normalizedTagName(tag.name));
    mapping.set(tag.id, existing?.id || tag.id);
    if (!existing) library.tags.push(structuredClone(tag));
  }
  for (const [key, value] of Object.entries(source.library?.items || {})) {
    if (!Object.hasOwn(library.items, key)) library.items[key] = { description: value.description, tagIds: [...new Set(value.tagIds.map((id) => mapping.get(id)))] };
  }
  return validate({ ...result, library });
}
export async function replaceContentPreferences(value, { expectedRevision } = {}) {
  const checked = validate(value);
  return mutateContentPreferences((current) => {
    if (current.revision !== expectedRevision) throw Object.assign(Error(tr('恢复期间数据已更新，请重新预览。')), { code: 'REVISION_CONFLICT' });
    return { ...checked, presentation: current.presentation,
      privateKeys: current.presentation ? [...new Set([...current.privateKeys, ...checked.privateKeys])] : checked.privateKeys };
  });
}
async function mutateContentPreferences(update, { expectedRevision } = {}) {
  return withPreferencesLock(async () => {
    const current = await loadContentPreferences();
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw Object.assign(Error(tr('内容已在其他页面更新，请重新打开后重试。')), { code: 'REVISION_CONFLICT' });
    const next = validate({ ...await update(current), revision: current.revision + 1 });
    return persistPreferences(next);
  });
}
async function persistPreferences(value, credential) {
  const next = validate(value);
  await localData.set({ [KEY]: next, ...(credential ? { [LOCK_KEY]: credential } : {}) });
  for (const listener of listeners) listener(next);
  return next;
}
async function withPreferencesLock(run) {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request(KEY, run);
  throw Error(tr('浏览器无法锁定本机内容偏好，请重试。'));
}
// Called after the navigation lock. Both encrypted records are written by the
// navigation store in one transaction, so a new private site is never public.
export function withNavigationPrivacy(run) {
  return withPreferencesLock(async () => {
    const current = await loadContentPreferences();
    return run(current, (addedKeys = [], { metadata = [], copies = [], expectedRevision, appendPreferences } = {}) => {
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw Object.assign(Error(tr('内容已在其他页面更新，请重新打开后重试。')), { code: 'REVISION_CONFLICT' });
      const privateKeys = [...new Set([...current.privateKeys, ...(appendPreferences?.privateKeys || []), ...addedKeys])];
      let next = appendPreferences ? mergeContentPreferences(current, appendPreferences) : current;
      for (const { from, to } of copies) {
        if (hiddenMetadata(current, from)) throw privacyError('请先输入密码解除隐藏。', 'PRIVACY_LOCKED');
        if (current.library?.items[from]) next = applyContentMetadata(next, to, current.library.items[from]);
      }
      for (const patch of metadata) {
        checkExpectedMetadata(current, patch.key, patch.expectedMetadata);
        next = applyContentMetadata(next, patch.key, patch);
      }
      if (next === current && privateKeys.length === current.privateKeys.length) return {};
      return { [KEY]: validate({ ...next, privateKeys, revision: current.revision + 1 }) };
    });
  });
}
export function useContentPreferences() {
  const [data, setData] = useState(empty), [error, setError] = useState(''), [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    const receive = (value) => { if (active) { try { const next = validate(value); setData((current) => current.revision > next.revision ? current : next); setError(''); setReady(true); } catch (reason) { setError(reason.message); setReady(false); } } };
    listeners.add(receive);
    loadContentPreferences().then(receive).catch((reason) => { if (active) setError(reason.message); });
    const off = localData.subscribe((items) => { if (items[KEY]) receive(items[KEY].newValue); });
    return () => { active = false; listeners.delete(receive); off(); };
  }, []);
  return { data, error, ready };
}
