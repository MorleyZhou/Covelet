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
function validate(value) {
  if (value == null) return empty();
  if (value.version !== 1 || !value.aliases || typeof value.aliases !== 'object' || Array.isArray(value.aliases)
    || Object.keys(value.aliases).length > 12000 || value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0)
    || Object.keys(value).some((key) => !['version', 'revision', 'aliases', 'privateKeys', 'presentation'].includes(key))
    || value.presentation !== undefined && typeof value.presentation !== 'boolean'
    || value.privateKeys !== undefined && (!Array.isArray(value.privateKeys) || value.privateKeys.length > 12000 || value.privateKeys.some((key) => typeof key !== 'string' || !validKey(key)))) throw Error(tr('本机内容偏好无效。'));
  const aliases = {};
  for (const [key, alias] of Object.entries(value.aliases)) {
    if (!validKey(key) || typeof alias !== 'string' || alias.length > 200 || /[\u0000-\u001f]/.test(alias)) throw Error(tr('搜索别名无效。'));
    if (alias.trim()) aliases[key] = alias.trim();
  }
  return { version: 1, revision: value.revision ?? 0, aliases, privateKeys: [...new Set(value.privateKeys || [])], presentation: value.presentation === true };
}
export async function loadContentPreferences() {
  return validate((await localData.get(KEY))[KEY]);
}
export async function saveContentAlias(key, alias) {
  return saveContentSettings(key, { alias });
}
export async function saveContentSettings(key, patch) {
  if (!validKey(key)) throw Error(tr('搜索别名无效。'));
  return mutateContentPreferences((current) => {
    if (current.presentation && current.privateKeys.includes(key)) throw privacyError('请先输入密码解除隐藏。', 'PRIVACY_LOCKED');
    const privateKeys = new Set(current.privateKeys);
    if (patch.private !== undefined) {
      if (typeof patch.private !== 'boolean') throw Error(tr('本机内容偏好无效。'));
      if (patch.private) privateKeys.add(key); else privateKeys.delete(key);
    }
    return { ...current, aliases: patch.alias === undefined ? current.aliases : { ...current.aliases, [key]: patch.alias }, privateKeys: [...privateKeys] };
  });
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
export async function replaceContentPreferences(value, { expectedRevision } = {}) {
  const checked = validate(value);
  return mutateContentPreferences((current) => {
    if (current.revision !== expectedRevision) throw Object.assign(Error(tr('恢复期间数据已更新，请重新预览。')), { code: 'REVISION_CONFLICT' });
    return { ...checked, presentation: current.presentation,
      privateKeys: current.presentation ? [...new Set([...current.privateKeys, ...checked.privateKeys])] : checked.privateKeys };
  });
}
async function mutateContentPreferences(update) {
  return withPreferencesLock(async () => {
    const current = await loadContentPreferences();
    const next = validate({ ...update(current), revision: current.revision + 1 });
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
