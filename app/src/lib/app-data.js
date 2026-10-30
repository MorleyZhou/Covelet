import { useEffect, useRef, useState } from 'react';
import { localData } from './local-data.js';
import { isAppId } from './app-catalog.js';
import { tr } from '../i18n/index.js';

export const APP_KEY_PREFIX = 'covelet.app.v1.';
export async function validateAppDomainData(id, data) {
  if (['tasks', 'snippets', 'language', 'travel', 'meals'].includes(id)) {
    const { validateDailyData } = await import('./daily-apps.js'); validateDailyData(id, data);
  } else if (['stocks', 'currency', 'ledger', 'orders', 'sports'].includes(id)) {
    const { validateMarketData } = await import('./market-apps.js'); validateMarketData(id, data);
  } else if (['online-tools', 'images', 'pdf', 'media', 'canvas'].includes(id)) {
    const { validateProcessingData } = await import('./processing-apps.js'); validateProcessingData(id, data);
  } else if (id === 'subscriptions') {
    if (!Array.isArray(data.sources) || !Array.isArray(data.items) || !data.baselines || typeof data.baselines !== 'object'
      || data.sources.length > 100 || data.items.length > 2000 || data.sources.some((row) => !row || typeof row.id !== 'string' || typeof row.url !== 'string' || !['rss', 'web', 'releases'].includes(row.kind))
      || data.items.some((row) => !row || typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.url !== 'string' || !/^https?:\/\//.test(row.url))) throw Error(tr('订阅内容格式无效。'));
  } else if (id === 'ai-chat') {
    if (!Array.isArray(data.sessions) || data.sessions.length > 200 || !data.config || !['ollama', 'openai'].includes(data.config.provider)
      || typeof data.config.baseUrl !== 'string' || typeof data.config.model !== 'string' || !Array.isArray(data.config.models)
      || data.sessions.some((session) => !session || typeof session.id !== 'string' || typeof session.title !== 'string' || !Array.isArray(session.messages) || session.messages.length > 1000
        || session.messages.some((message) => !message || !['user', 'assistant', 'system'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 1000000))) throw Error(tr('会话内容格式无效。'));
  } else throw Error(tr('不支持此扩展。'));
  return data;
}
export function validateAppEnvelope(value) {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || Object.keys(value).some((key) => !['version', 'revision', 'data'].includes(key))
    || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw Error(tr('扩展数据无效，原有内容已保留。'));
  let count = 0, bytes = 0;
  const visited = new Set();
  const visit = (item, depth) => {
    if (++count > 500000 || depth > 40) throw Error(tr('扩展内容过多，请先导出并整理。'));
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item === 'string') bytes += item.length * 2;
    else if (typeof Blob !== 'undefined' && item instanceof Blob) bytes += item.size;
    else {
      if (!item || typeof item !== 'object' || visited.has(item) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) throw Error(tr('扩展数据格式无效。'));
      visited.add(item);
      for (const [key, child] of Object.entries(item)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error(tr('扩展数据格式无效。')); visit(child, depth + 1); }
      visited.delete(item);
    }
    if (bytes > 64 * 1024 * 1024) throw Error(tr('扩展内容超过大小限制。'));
  };
  visit(value.data, 0); return value;
}
export async function loadAppData(id, defaults = {}) {
  if (!isAppId(id)) throw Error(tr('不支持此扩展。'));
  const key = APP_KEY_PREFIX + id, value = (await localData.get(key))[key];
  if (value === undefined) return { version: 1, revision: 0, data: structuredClone(defaults) };
  validateAppEnvelope(value); await validateAppDomainData(id, value.data); return value;
}
export async function updateAppData(id, defaults, transform, { expectedRevision } = {}) {
  if (!isAppId(id) || typeof transform !== 'function') throw Error(tr('扩展数据格式无效。'));
  return localData.update(APP_KEY_PREFIX + id, async (input) => {
    const current = input === undefined ? { version: 1, revision: 0, data: structuredClone(defaults) } : validateAppEnvelope(input);
    if (input !== undefined) await validateAppDomainData(id, current.data);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw Object.assign(Error(tr('内容已在其他页面更新，请重新打开后修改。')), { code: 'REVISION_CONFLICT' });
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw Error(tr('扩展版本超出范围。'));
    const data = transform(structuredClone(current.data));
    if (data?.then) throw Error(tr('扩展数据格式无效。'));
    await validateAppDomainData(id, data);
    return validateAppEnvelope({ version: 1, revision: current.revision + 1, data });
  });
}
export function useAppData(id, defaults = {}) {
  const initial = useRef(defaults), [envelope, setEnvelope] = useState(null), [error, setError] = useState('');
  const active = useRef(true);
  useEffect(() => {
    active.current = true; let live = true; setEnvelope(null); setError('');
    const receive = (next) => { if (live) { try { setEnvelope(next === undefined ? { version: 1, revision: 0, data: structuredClone(initial.current) } : validateAppEnvelope(next)); } catch (reason) { setError(reason.message); } } };
    const off = localData.subscribe((changes) => { const change = changes[APP_KEY_PREFIX + id]; if (change) receive(change.newValue); });
    loadAppData(id, initial.current).then((value) => { if (live) setEnvelope((previous) => previous || value); }).catch((reason) => { if (live) setError(reason.message); });
    return () => { live = false; active.current = false; off(); };
  }, [id]);
  const update = async (transform, options) => {
    try { const next = await updateAppData(id, initial.current, transform, options); if (active.current) { setEnvelope(next); setError(''); } return next.data; }
    catch (reason) { if (active.current) setError(reason.message); throw reason; }
  };
  return { data: envelope?.data ?? initial.current, revision: envelope?.revision ?? 0, loaded: Boolean(envelope), loading: !envelope && !error, error, update };
}
