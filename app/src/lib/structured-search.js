import { defaultSavedFilters, SAVED_VIEW_LIMITS, validateSavedFilters } from './saved-views.js';

const OPERATORS = new Set(['tag', '-tag', 'type', 'is', 'domain']);
const TYPES = new Set(['all', 'navigation', 'site', 'folder', 'note', 'reading', 'desktop']);
const STATUSES = new Set(['unread', 'read', 'archived']);
const normalizeTag = (value) => value.normalize('NFKC').toLowerCase();
const invalid = (code, operator) => Object.assign(Error(code), { structuredSearch: true, code, operator });
const addressToken = (value) => /^[a-z][a-z\d+.-]*:\/\//iu.test(value) || /^(?:\[[a-f\d:]+\]|localhost|[^\s/:]+\.[^\s/:]+):\d+(?:[/?#]|$)/iu.test(value);

// This parser accepts only the caller's visible tag dictionary. Unknown and
// hidden tag names deliberately share one error, with no lookup of stored data.
// It does not read storage, index content, fetch pages, or interpret bare text
// as Markdown. Existing literal queries and complete URLs keep their meaning.
export function parseStructuredSearch(raw, { tags = [], baseFilters = {}, parseOperators = true } = {}) {
  const conditions = [], text = [];
  let structured = false;
  try {
    if (typeof raw !== 'string' || raw.length > SAVED_VIEW_LIMITS.query || raw.includes('\0')) throw invalid('invalid-query');
    let filters;
    try { filters = validateSavedFilters({ ...defaultSavedFilters(), ...baseFilters, query: raw }, { allowDraftScopes: true }); }
    catch { throw invalid('invalid-filters'); }
    // The main input resolves existing engine keywords before local operators.
    // Its caller disables parsing for that recognized external query; palettes
    // and local-only search surfaces keep normal operator parsing enabled.
    if (parseOperators === false) return { status: 'ready', structured: false, filters, textQuery: raw.trim(), conditions };
    const selected = new Set(filters.tagIds), excluded = new Set(filters.excludeTagIds || []), scalars = new Map();
    const tagList = Array.isArray(tags) ? tags : [];
    let cursor = 0;
    while (cursor < raw.length) {
      while (/\s/u.test(raw[cursor] || '') && cursor < raw.length) cursor++;
      if (cursor >= raw.length) break;
      const start = cursor, tokenEnd = raw.slice(cursor).search(/\s/u), end = tokenEnd < 0 ? raw.length : cursor + tokenEnd;
      const token = raw.slice(cursor, end), prefix = /^(-?[a-z][a-z\d_-]*):/iu.exec(token);
      if (!prefix || addressToken(token)) { text.push(token); cursor = end; continue; }
      const operator = prefix[1].toLowerCase();
      structured = true;
      if (!OPERATORS.has(operator)) throw invalid('unknown-operator', operator);
      cursor += prefix[0].length;
      let value = '';
      if (raw[cursor] === '"') {
        cursor++;
        let closed = false;
        while (cursor < raw.length) {
          const character = raw[cursor++];
          if (character === '"') { closed = true; break; }
          if (character === '\\') {
            if (!['"', '\\'].includes(raw[cursor])) throw invalid('invalid-escape', operator);
            value += raw[cursor++];
          } else value += character;
        }
        if (!closed) throw invalid('unclosed-quote', operator);
        if (cursor < raw.length && !/\s/u.test(raw[cursor])) throw invalid('invalid-value', operator);
      } else {
        while (cursor < raw.length && !/\s/u.test(raw[cursor])) value += raw[cursor++];
        if (value.includes('"')) throw invalid('invalid-value', operator);
      }
      if (!value.trim()) throw invalid('missing-value', operator);
      let identity = value;
      if (operator === 'tag' || operator === '-tag') {
        const tag = tagList.find((item) => typeof item?.name === 'string' && normalizeTag(item.name) === normalizeTag(value));
        if (!tag || typeof tag.id !== 'string') throw invalid('unknown-tag', operator);
        (operator === 'tag' ? selected : excluded).add(tag.id);
        identity = tag.id; value = tag.name;
      } else {
        value = value.toLowerCase();
        if (operator === 'type' && !TYPES.has(value)) throw invalid('invalid-type', operator);
        if (operator === 'is' && !STATUSES.has(value)) throw invalid('invalid-status', operator);
        if (operator === 'domain') {
          try { value = validateSavedFilters({ domain: value }).domain; }
          catch { throw invalid('invalid-domain', operator); }
        }
        if (scalars.has(operator) && scalars.get(operator) !== value) throw invalid('conflicting-condition', operator);
        scalars.set(operator, value); identity = value;
      }
      conditions.push({ key: `${operator}:${identity}:${start}`, operator, value, label: `${operator}:${value}`, start, end: cursor });
    }
    if (selected.size > SAVED_VIEW_LIMITS.tags || excluded.size > SAVED_VIEW_LIMITS.tags) throw invalid('too-many-tags');
    if (filters.tagMode !== 'any' && [...selected].some((id) => excluded.has(id))) throw invalid('conflicting-condition', 'tag');
    if (scalars.has('type')) filters.type = scalars.get('type');
    if (scalars.has('is')) {
      if (!['all', 'reading'].includes(filters.type)) throw invalid('conflicting-condition', 'is');
      filters.type = 'reading'; filters.readingStatus = scalars.get('is');
    }
    if (scalars.has('domain')) filters.domain = scalars.get('domain');
    const textQuery = structured ? text.join(' ') : raw.trim();
    filters = validateSavedFilters({ ...filters, query: textQuery, tagIds: [...selected], ...(excluded.size ? { excludeTagIds: [...excluded] } : {}) }, { allowDraftScopes: true });
    return { status: 'ready', structured, filters, textQuery, conditions };
  } catch (reason) {
    return { status: 'invalid', structured, filters: null, textQuery: typeof raw === 'string' ? raw.trim() : '', conditions,
      error: { code: reason.structuredSearch ? reason.code : 'invalid-query', ...(reason.operator ? { operator: reason.operator } : {}) } };
  }
}

export function removeStructuredCondition(raw, condition) {
  if (typeof raw !== 'string' || !Number.isInteger(condition?.start) || !Number.isInteger(condition?.end)
    || condition.start < 0 || condition.end <= condition.start || condition.end > raw.length) return raw;
  return `${raw.slice(0, condition.start).trimEnd()} ${raw.slice(condition.end).trimStart()}`.trim();
}
