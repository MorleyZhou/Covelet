import messages from './messages.js';
import { localData } from '../lib/local-data.js';
import { appDefinition } from '../lib/app-catalog.js';

export const LANGUAGES = Object.freeze([
  { value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }, { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja', label: '日本語' }, { value: 'ko', label: '한국어' }, { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' }, { value: 'ru', label: 'Русский' },
].map(Object.freeze));
const supported = new Set(LANGUAGES.map((item) => item.value));
export function resolveLanguage(input) {
  const language = typeof input === 'string' ? input.replaceAll('_', '-').toLowerCase() : '';
  if (/^zh(?:-|$)/.test(language)) return /(?:^|-)hant(?:-|$)/.test(language) || /^zh-(?:tw|hk|mo)(?:-|$)/.test(language) ? 'zh-TW' : 'zh-CN';
  const base = language.split('-')[0];
  return supported.has(base) ? base : 'en';
}
function browserLanguage() {
  let value;
  try { value = globalThis.chrome?.i18n?.getUILanguage?.(); } catch { /* Web preview has no extension API. */ }
  return resolveLanguage(value || globalThis.navigator?.languages?.[0] || globalThis.navigator?.language);
}
const demo = typeof location !== 'undefined' && import.meta.env?.DEV && new URLSearchParams(location.search).has('demo');
const KEY = demo ? 'covelet.language.demo.v1' : 'covelet.language.v1';
const native = () => !demo && Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.local);
let preference = 'auto', locale = browserLanguage(), initialization;
const listeners = new Set(), recentMessages = new Map();
const translatedSources = new Map();
for (const [source, row] of Object.entries(messages)) for (const value of Object.values(row)) {
  if (typeof value === 'string' && !value.includes('{')) translatedSources.set(value, source);
}
const validPreference = (value) => value === 'auto' || supported.has(value);
export const getLocale = () => locale;
export const getLanguagePreference = () => preference;
export const languageSnapshot = () => `${preference}:${locale}`;
export function subscribeLanguage(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function apply(value) {
  preference = validPreference(value) ? value : 'auto';
  locale = preference === 'auto' ? browserLanguage() : preference;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    document.documentElement.dir = 'ltr';
    document.title = tr(document.querySelector('meta[name="covelet-page"]')?.content === 'popup' ? '添加到 Covelet' : 'Covelet 新标签页');
  }
  for (const listener of listeners) listener();
}
export function initializeLanguage() {
  if (!initialization) initialization = (async () => {
    localData.subscribe((items) => { if (items[KEY]) apply(items[KEY].newValue); });
    const value = (await localData.get(KEY))[KEY]; apply(value);
    globalThis.addEventListener?.('languagechange', () => { if (preference === 'auto') apply('auto'); });
  })().catch(() => apply('auto'));
  return initialization;
}
export async function setLanguagePreference(value) {
  if (!validPreference(value)) throw Error(tr('语言设置无效。'));
  try { await localData.set({ [KEY]: value }); }
  catch { throw Error(tr('语言设置未保存，请重试。')); }
  apply(value);
}
// Message keys are stable source phrases. Parameters are positional and are
// never evaluated as code, HTML, URLs or translation keys from user content.
export function tr(key, values = []) {
  if (typeof key !== 'string') return key;
  let source = key, parameters = values;
  if (!Object.hasOwn(messages, source) && recentMessages.has(source)) ({ source, values: parameters } = recentMessages.get(source));
  else if (!Object.hasOwn(messages, source) && translatedSources.has(source)) source = translatedSources.get(source);
  const trimmed = source.trim();
  const row = Object.hasOwn(messages, source) ? messages[source] : Object.hasOwn(messages, trimmed) ? messages[trimmed] : null;
  if (!row) return key;
  const pattern = locale === 'zh-CN' ? trimmed : row[locale] || row.en;
  const result = pattern.replace(/\{(\d+)\}/g, (match, index) => index < parameters.length ? String(parameters[index]) : match);
  const leading = source.slice(0, source.length - source.trimStart().length), trailing = source.slice(source.trimEnd().length);
  const text = `${leading}${result}${trailing}`;
  // Transient errors/status messages can survive a language change. Only our
  // own previously formatted messages are retranslated, never arbitrary data.
  recentMessages.set(text, { source: trimmed, values: parameters });
  if (recentMessages.size > 512) recentMessages.delete(recentMessages.keys().next().value);
  return text;
}
export const formatNumber = (value, options) => new Intl.NumberFormat(locale, options).format(value);
export function builtinName(id, savedName) {
  const key = ({ clock: '时钟', 'github-contributions': 'GitHub 贡献', notes: '便笺', 'read-later': '稍后读' })[id] || appDefinition(id)?.title;
  if (!key) return savedName;
  const variants = [key, ...Object.values(messages[key] || {})];
  return variants.includes(savedName) ? tr(key) : savedName;
}
export function providerName(provider) {
  if (!provider) return tr('浏览器默认搜索');
  return provider.id === 'bing' && provider.name === '必应' && provider.template === 'https://www.bing.com/search?q={query}' ? tr('必应') : provider.name;
}
