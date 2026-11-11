import { tr } from '../i18n/index.js';
import { collectCoveletContent, visibleContentTagIds } from './content-search.js';
import { logicalDesktopPages, namedDesktopRecords } from './desktop-pages.js';
import { privateContentKeys } from './presentation.js';

export const SAVED_VIEW_LIMITS = Object.freeze({ views: 50, name: 80, query: 2000, tags: 20, domain: 253 });
export const SAVED_CONTENT_TYPES = Object.freeze(['site', 'folder', 'note', 'reading', 'desktop']);
const FILTER_KEYS = ['query', 'type', 'scope', 'tagIds', 'domain', 'readingStatus'];
const identity = (value) => typeof value === 'string' && /^[a-z\d-]{1,100}$/i.test(value);
const scopeIdentity = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\u0000-\u001f\u007f]/u.test(value) && !value.startsWith('@page:');
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
const invalid = () => { throw Object.assign(Error(tr('清单条件无效，请重新选择。')), { code: 'SAVED_VIEW_INVALID' }); };
export function defaultSavedFilters() { return { query: '', type: 'all', scope: { kind: 'all' }, tagIds: [], domain: '', readingStatus: null }; }

function normalizedDomain(value) {
  if (typeof value !== 'string' || value.length > SAVED_VIEW_LIMITS.domain || /[\s/?#@\\]/u.test(value)) invalid();
  if (!value) return '';
  let url; try { url = new URL(`https://${value}`); } catch { invalid(); }
  if (!url.hostname || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) invalid();
  return url.hostname.toLowerCase().replace(/\.$/u, '');
}
export function validateSavedFilters(input, { allowDraftScopes = false } = {}) {
  if (!fields(input, FILTER_KEYS)) invalid();
  const value = { ...defaultSavedFilters(), ...input };
  if (typeof value.query !== 'string' || value.query.length > SAVED_VIEW_LIMITS.query || value.query.includes('\0')
    || !['all', 'navigation', ...SAVED_CONTENT_TYPES].includes(value.type) || !Array.isArray(value.tagIds) || value.tagIds.length > SAVED_VIEW_LIMITS.tags
    || new Set(value.tagIds).size !== value.tagIds.length || value.tagIds.some((id) => !identity(id))
    || typeof value.domain !== 'string' || value.readingStatus !== null && !['unread', 'read', 'archived'].includes(value.readingStatus)) invalid();
  const scope = value.scope;
  if (!fields(scope, ['kind', 'desktopId', 'folderId'])) invalid();
  if (scope.kind === 'all') {
    if (Object.keys(scope).length !== 1) invalid();
  } else if (scope.kind === 'desktop') {
    const temporary = allowDraftScopes && typeof scope.desktopId === 'string' && /^@page:\d+$/u.test(scope.desktopId);
    if (Object.keys(scope).length !== 2 || !Object.hasOwn(scope, 'desktopId') || !scopeIdentity(scope.desktopId) && !temporary) invalid();
  } else if (scope.kind === 'folder') {
    if (Object.keys(scope).length !== 2 || !scopeIdentity(scope.folderId)) invalid();
  } else invalid();
  return { query: value.query.trim(), type: value.type, scope: { ...scope }, tagIds: [...value.tagIds],
    domain: normalizedDomain(value.domain.trim()), readingStatus: value.readingStatus };
}
export function viewFilters(view) { return Object.fromEntries(FILTER_KEYS.filter((key) => Object.hasOwn(view, key)).map((key) => [key, structuredClone(view[key])])); }
export function validateSavedView(input) {
  if (!fields(input, ['id', 'revision', 'name', ...FILTER_KEYS]) || !identity(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1
    || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > SAVED_VIEW_LIMITS.name || /[\u0000-\u001f\u007f]/u.test(input.name)) invalid();
  return { id: input.id, revision: input.revision, name: input.name.trim(), ...validateSavedFilters(viewFilters(input)) };
}

function filterContext(navigation, tools, preferences, input, { hiddenKeys = [], allowedTypes = SAVED_CONTENT_TYPES, allowDraftScopes = false } = {}) {
  let filters; try { filters = validateSavedFilters(input, { allowDraftScopes }); } catch { return { status: 'invalid', reason: 'invalid-filters' }; }
  const hidden = preferences.presentation ? new Set([...privateContentKeys(navigation, preferences), ...hiddenKeys]) : new Set();
  const tags = new Set((preferences.library?.tags || []).map((tag) => tag.id));
  if (preferences.presentation && filters.tagIds.length) {
    const visible = new Set(visibleContentTagIds(navigation, tools, preferences.library, hidden));
    if (filters.tagIds.some((id) => tags.has(id) && !visible.has(id))) return { status: 'hidden', reason: 'hidden-reference' };
  }
  if (filters.scope.kind === 'folder' && hidden.has(`folder:${filters.scope.folderId}`)) return { status: 'hidden', reason: 'hidden-reference' };
  if (filters.tagIds.some((id) => !tags.has(id))) return { status: 'invalid', reason: 'missing-tag' };
  if (filters.type !== 'all' && filters.type !== 'navigation' && !allowedTypes.includes(filters.type)) return { status: 'invalid', reason: 'unsupported-type' };
  let page = null;
  if (filters.scope.kind === 'desktop') {
    const found = Object.entries(navigation?.settings?.desktopPages || {}).find(([, metadata]) => metadata.id === filters.scope.desktopId);
    page = found ? Number(found[0]) : allowDraftScopes && filters.scope.desktopId.startsWith('@page:') ? Number(filters.scope.desktopId.slice(6)) : null;
    if (page === null || !Number.isSafeInteger(page) || !navigation || !logicalDesktopPages(navigation).includes(page)) return { status: 'invalid', reason: 'missing-desktop' };
  }
  if (filters.scope.kind === 'folder') {
    if (!navigation?.entries.some((entry) => entry.type === 'folder' && entry.id === filters.scope.folderId)) return { status: 'invalid', reason: 'missing-folder' };
  }
  return { status: 'ready', reason: null, filters, hidden, page, allowedTypes };
}

export function filterSavedContent(navigation, tools, preferences, input, options = {}) {
  const context = filterContext(navigation, tools, preferences, input, options);
  if (context.status !== 'ready') return { status: context.status, reason: context.reason, rows: [] };
  const { filters, hidden, page, allowedTypes } = context;
  const folders = new Map((navigation?.entries || []).filter((entry) => entry.type === 'folder').map((entry) => [entry.id, entry]));
  const rows = collectCoveletContent(navigation, tools, filters.query, { aliases: preferences.aliases, hiddenKeys: hidden,
    desktops: navigation ? namedDesktopRecords(navigation.settings) : [], library: preferences.library, tagIds: filters.tagIds, allowEmptyQuery: true });
  return { status: 'ready', reason: null, rows: rows.filter((row) => {
    if (!allowedTypes.includes(row.type)) return false;
    if (filters.type === 'navigation' ? !['site', 'folder'].includes(row.type) : filters.type !== 'all' && row.type !== filters.type) return false;
    if (filters.scope.kind === 'folder' && (row.type !== 'site' || row.entry.parentId !== filters.scope.folderId)) return false;
    if (page !== null) {
      const rowPage = row.type === 'desktop' ? row.record.page : row.entry ? folders.get(row.entry.parentId)?.page ?? row.entry.page ?? 0 : null;
      if (rowPage !== page) return false;
    }
    if (filters.readingStatus && (row.type !== 'reading' || row.record.status !== filters.readingStatus)) return false;
    if (filters.domain) {
      let hostname; try { hostname = new URL(row.url).hostname.toLowerCase().replace(/\.$/u, ''); } catch { return false; }
      if (hostname !== filters.domain) return false;
    }
    return true;
  }) };
}

export function resolveSavedView(view, { navigation, tools, preferences, hiddenKeys = [] } = {}) {
  if (preferences.presentation && (preferences.privateKeys || []).includes(`view:${view.id}`)) return { status: 'hidden', reason: 'private-view', rows: [] };
  return filterSavedContent(navigation, tools, preferences, viewFilters(view), { hiddenKeys });
}
export function getSavedViews(preferences, { navigation, tools, hiddenKeys = [] } = {}) {
  return structuredClone((preferences.library?.views || []).filter((view) => {
    if (!preferences.presentation) return true;
    if ((preferences.privateKeys || []).includes(`view:${view.id}`)) return false;
    return filterContext(navigation, tools, preferences, viewFilters(view), { hiddenKeys }).status !== 'hidden';
  }));
}
