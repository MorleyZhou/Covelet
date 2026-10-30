// Search only Covelet-owned data. This module never reads browser history,
// open tabs or storage, and does not change the records passed to it.
export const contentKey = (type, id) => `${type}:${id}`;

const normalize = (value) => typeof value === 'string'
  ? value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim() : '';
const displayText = (value) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
const han = /\p{Script=Han}/u;
const latinToken = /^[a-z][a-z\d]*$/u;
const MAX_RESULTS = 100;
const initialCache = new Map();
const recordCache = new WeakMap();
let pinyinCollator;
let supportsPinyin;

// These are approximate pinyin boundaries, not a pronunciation dictionary.
// The browser's Chinese collation selects one pronunciation for polyphones.
const initialBoundaries = [
  ['a', '阿'], ['b', '芭'], ['c', '擦'], ['d', '搭'], ['e', '蛾'],
  ['f', '发'], ['g', '噶'], ['h', '哈'], ['j', '击'], ['k', '喀'],
  ['l', '垃'], ['m', '妈'], ['n', '拿'], ['o', '哦'], ['p', '啪'],
  ['q', '期'], ['r', '然'], ['s', '撒'], ['t', '塌'], ['w', '挖'],
  ['x', '昔'], ['y', '压'], ['z', '匝'],
];

function initials(value) {
  if (initialCache.has(value)) return initialCache.get(value);
  let result = '';
  try {
    pinyinCollator ??= new Intl.Collator('zh-Hans-CN-u-co-pinyin', { sensitivity: 'base' });
    // Skip this optional matching path when the runtime cannot supply pinyin.
    // Some runtimes report "default" when pinyin is the locale's default.
    supportsPinyin ??= pinyinCollator.compare('阿', '八') < 0
      && pinyinCollator.compare('八', '擦') < 0 && pinyinCollator.compare('中', '阿') > 0;
    if (!supportsPinyin) return '';
    for (const character of value) {
      if (!han.test(character)) { result += /[a-z\d]/u.test(character) ? character : ' '; continue; }
      let found = '';
      for (let index = initialBoundaries.length - 1; index >= 0; index--) {
        if (pinyinCollator.compare(character, initialBoundaries[index][1]) >= 0) {
          found = initialBoundaries[index][0]; break;
        }
      }
      result += found;
    }
  } catch { return ''; }
  result = result.replace(/\s+/gu, ' ').trim();
  // Titles/aliases are short; cap the cache so searches cannot retain all old
  // notes after editing or deleting them in a long-lived new-tab page.
  if (initialCache.size >= 512) initialCache.delete(initialCache.keys().next().value);
  initialCache.set(value, result);
  return result;
}

function aliasesFor(aliases, key) {
  const value = aliases instanceof Map ? aliases.get(key)
    : aliases && Object.hasOwn(aliases, key) ? aliases[key] : [];
  return (Array.isArray(value) ? value : [value]).filter((item) => typeof item === 'string')
    .map(normalize).filter(Boolean);
}

function urlFields(value) {
  if (typeof value !== 'string') return { address: '', hostname: '' };
  let decoded = value;
  try { decoded = decodeURI(value); } catch { /* An encoded URL can still match literally. */ }
  let hostname = '';
  try { hostname = new URL(value).hostname; } catch { /* Search also tolerates incomplete imported records. */ }
  return { address: normalize(`${value} ${decoded}`), hostname: normalize(hostname) };
}

function searchableFields(record, type) {
  const title = ['site', 'folder'].includes(type) ? record.name : record.title;
  const body = type === 'note' ? record.body : '';
  const url = type === 'note' ? '' : record.url;
  const cached = recordCache.get(record);
  if (cached && cached.type === type && cached.sourceTitle === title && cached.sourceBody === body && cached.sourceUrl === url) return cached;
  const fields = { type, sourceTitle: title, sourceBody: body, sourceUrl: url,
    title: normalize(title), body: normalize(body), ...urlFields(url) };
  recordCache.set(record, fields);
  return fields;
}

function textScore(value, token, exact, prefix, anywhere) {
  if (!value) return 0;
  return value === token ? exact : value.startsWith(token) ? prefix : value.includes(token) ? anywhere : 0;
}

function matchScore(title, body, address, hostname, aliases, tokens, query) {
  const initialFields = tokens.some((token) => latinToken.test(token))
    ? [title, ...aliases].filter((value) => han.test(value)).map(initials) : [];
  let score = 0;
  for (const token of tokens) {
    const best = Math.max(
      textScore(title, token, 120, 90, 65),
      ...aliases.map((alias) => textScore(alias, token, 110, 80, 60)),
      textScore(hostname, token, 65, 50, 35),
      textScore(address, token, 40, 30, 25),
      textScore(body, token, 25, 20, 15),
      ...(latinToken.test(token) ? initialFields.map((value) => textScore(value, token, 48, 40, 30)) : []),
    );
    if (!best) return 0;
    score += best;
  }
  return score + textScore(title, query, 160, 80, 40)
    + Math.max(0, ...aliases.map((alias) => textScore(alias, query, 100, 50, 20)));
}

function noteExcerpt(body, tokens) {
  const text = displayText(body);
  if (text.length <= 140) return text;
  const normalized = normalize(text);
  const matches = tokens.map((token) => normalized.indexOf(token)).filter((position) => position >= 0);
  const start = matches.length ? Math.max(0, Math.min(...matches) - 35) : 0;
  // NFKC can slightly shift character offsets; this is an excerpt hint only.
  return `${start ? '…' : ''}${text.slice(start, start + 140)}${start + 140 < text.length ? '…' : ''}`;
}

/**
 * Search navigation sites, note titles/bodies and reading titles/URLs.
 * Every whitespace-separated query token must match at least one field.
 * aliases and hiddenKeys use contentKey(type, id), e.g. "note:note-id".
 * Title/alias matching also supports approximate Chinese pinyin initials.
 * Results retain original entry/record references and original URLs.
 */
export function searchCoveletContent(navigation, tools, query, { aliases = {}, hiddenKeys = [], limit = 24 } = {}) {
  const normalized = normalize(query);
  const boundedLimit = Number.isFinite(limit) ? Math.min(MAX_RESULTS, Math.max(0, Math.floor(limit))) : 24;
  if (!normalized || normalized.length > 2000 || !boundedLimit) return [];
  const tokens = [...new Set(normalized.split(' '))];
  if (tokens.length > 64) return [];
  const hidden = hiddenKeys instanceof Set ? hiddenKeys : new Set(Array.isArray(hiddenKeys) ? hiddenKeys : []);
  const results = [];

  const add = (type, record) => {
    if (!record || typeof record.id !== 'string') return;
    const key = contentKey(type, record.id);
    // Hidden data never reaches normalization, snippets, scoring or totals.
    if (hidden.has(key)) return;
    const title = ['site', 'folder'].includes(type) ? record.name : record.title;
    const body = type === 'note' ? record.body : '';
    const fields = searchableFields(record, type);
    const score = matchScore(fields.title, fields.body, fields.address, fields.hostname, aliasesFor(aliases, key), tokens, normalized);
    if (!score) return;
    results.push({ key, type, id: record.id, title: typeof title === 'string' ? title : '',
      subtitle: type === 'note' ? noteExcerpt(body, tokens) : typeof record.url === 'string' ? record.url : '',
      ...(type === 'note' ? {} : { url: record.url }),
      ...(['site', 'folder'].includes(type) ? { entry: record } : { record }), score });
  };

  for (const entry of Array.isArray(navigation) ? navigation : navigation?.entries ?? []) {
    if (['site', 'folder'].includes(entry?.type)) add(entry.type, entry);
  }
  for (const record of tools?.notes ?? []) add('note', record);
  for (const record of tools?.reading ?? []) add('reading', record);
  // Modern JS sort is stable: identical scores retain saved navigation/tool order.
  return results.sort((left, right) => right.score - left.score).slice(0, boundedLimit);
}
