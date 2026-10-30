import { APP_IDS, isAppId } from './app-catalog.js';
import { APP_KEY_PREFIX, validateAppEnvelope, validateAppDomainData } from './app-data.js';
import { localData } from './local-data.js';
import { tr } from '../i18n/index.js';
const revision = async (records) => {
  const bytes = new TextEncoder().encode(JSON.stringify(await encode(records)));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
const invalid = () => { throw Error(tr('备份中的扩展内容无效。')); };
function secretConfig(id, value, previous) {
  const next = structuredClone(value), old = previous?.data;
  if (id === 'ai-chat' && next.data.config) next.data.config.key = old?.config?.key || '';
  if (['stocks', 'sports'].includes(id) && next.data.settings) next.data.settings.apiKey = old?.settings?.apiKey || '';
  if (id === 'orders' && next.data.tracking) next.data.tracking.apiKey = old?.tracking?.apiKey || '';
  return next;
}
async function encode(value) {
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer()); let raw = '';
    for (let i = 0; i < bytes.length; i += 16384) raw += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return [3, value.type, btoa(raw)];
  }
  if (Array.isArray(value)) return [1, await Promise.all(value.map(encode))];
  if (value && typeof value === 'object') return [2, await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encode(item)]))];
  return [0, value];
}
function decode(input) {
  let nodes = 0, bytes = 0;
  const visit = (value, depth) => {
    if (++nodes > 500000 || depth > 45 || !Array.isArray(value)) invalid();
    if (value[0] === 0 && value.length === 2 && (value[1] === null || ['string', 'number', 'boolean'].includes(typeof value[1]))) return value[1];
    if (value[0] === 1 && value.length === 2 && Array.isArray(value[1])) return value[1].map((item) => visit(item, depth + 1));
    if (value[0] === 2 && value.length === 2 && Array.isArray(value[1])) {
      const object = {};
      for (const entry of value[1]) { if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || Object.hasOwn(object, entry[0])) invalid(); Object.defineProperty(object, entry[0], { value: visit(entry[1], depth + 1), enumerable: true, writable: true }); }
      return object;
    }
    if (value[0] === 3 && value.length === 3 && typeof value[1] === 'string' && value[1].length < 200 && typeof value[2] === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value[2]) && value[2].length % 4 === 0) {
      let raw; try { raw = atob(value[2]); } catch { invalid(); }
      bytes += raw.length; if (bytes > 40 * 1024 * 1024) invalid();
      return new Blob([Uint8Array.from(raw, (char) => char.charCodeAt(0))], { type: value[1] });
    }
    invalid();
  };
  return visit(input, 0);
}
export function validateAppCollection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const [id, record] of Object.entries(value)) { if (!isAppId(id)) invalid(); validateAppEnvelope(record); }
  return value;
}
export function mergeAppCollections(current, incoming) {
  validateAppCollection(current); validateAppCollection(incoming);
  const result = structuredClone(current);
  for (const [id, record] of Object.entries(incoming)) {
    if (!result[id]) { result[id] = structuredClone(record); continue; }
    const local = result[id].data, remote = record.data;
    for (const [field, value] of Object.entries(remote)) {
      if (Array.isArray(value) && Array.isArray(local[field])) {
        const identity = (item) => item && typeof item === 'object' ? item.id || JSON.stringify(item) : JSON.stringify(item);
        const seen = new Set(local[field].map(identity));
        for (const item of value) if (!seen.has(identity(item))) { local[field].push(structuredClone(item)); seen.add(identity(item)); }
      } else if (['quotes', 'series', 'tables', 'baselines', 'shoppingChecks'].includes(field) && value && typeof value === 'object' && local[field] && typeof local[field] === 'object') {
        local[field] = { ...structuredClone(value), ...local[field] };
      }
    }
  }
  return result;
}
export const appBackupDomain = {
  merge: mergeAppCollections,
  async validate(records) { validateAppCollection(records); for (const [id, record] of Object.entries(records)) await validateAppDomainData(id, record.data); return records; },
  async read() {
    const values = await localData.get(APP_IDS.map((id) => APP_KEY_PREFIX + id)), records = {};
    for (const id of APP_IDS) if (values[APP_KEY_PREFIX + id]) records[id] = validateAppEnvelope(values[APP_KEY_PREFIX + id]);
    return { records, revision: await revision(records) };
  },
  async encode(records) { validateAppCollection(records); return encode(Object.fromEntries(Object.entries(records).map(([id, record]) => [id, secretConfig(id, record)]))); },
  decode(value) { return validateAppCollection(decode(value)); },
  async write(value, { expectedRevision } = {}) {
    const incoming = validateAppCollection(value.records || value);
    for (const [id, record] of Object.entries(incoming)) await validateAppDomainData(id, record.data);
    await localData.updateMany(APP_IDS.map((id) => APP_KEY_PREFIX + id), async (current) => {
      const records = Object.fromEntries(APP_IDS.filter((id) => current[APP_KEY_PREFIX + id]).map((id) => [id, current[APP_KEY_PREFIX + id]]));
      if (await revision(records) !== expectedRevision) throw Object.assign(Error(tr('恢复期间扩展内容已更新，请重新预览。')), { code: 'REVISION_CONFLICT' });
      const writes = {};
      for (const [id, record] of Object.entries(incoming)) writes[APP_KEY_PREFIX + id] = validateAppEnvelope({ ...secretConfig(id, record, records[id]), revision: (records[id]?.revision || 0) + 1 });
      return { writes, removals: APP_IDS.filter((id) => records[id] && !incoming[id]).map((id) => APP_KEY_PREFIX + id) };
    });
    return this.read();
  },
};
