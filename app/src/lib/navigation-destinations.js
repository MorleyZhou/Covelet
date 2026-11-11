import { tr } from '../i18n/index.js';
import { migrateNavigationState } from './model.js';
import { saveStateWithTrash } from './storage.js';
import { logicalDesktopPages } from './desktop-pages.js';
import { privateContentKeys } from './presentation.js';

export function desktopDestinationValue(state, page = logicalDesktopPages(state)[0]) {
  const id = state.settings.desktopPages?.[page]?.id;
  return id ? `page-id:${id}` : `page:${page}`;
}

export function siteDestinationValue(state, site) {
  return site.parentId ? `folder:${site.parentId}` : desktopDestinationValue(state, site.page ?? 0);
}

export function navigationDestination(state, value, preferences) {
  const page = logicalDesktopPages(state).find((page) => desktopDestinationValue(state, page) === value);
  if (page !== undefined) return { page, parentId: null };
  const folder = state.entries.find((item) => item.type === 'folder' && !item.detached && value === `folder:${item.id}`);
  if (!folder || (preferences.presentation && preferences.privateKeys.includes(`folder:${folder.id}`))) {
    throw destinationChanged();
  }
  return { page: folder.page ?? 0, parentId: folder.id };
}

export function destinationChanged() {
  return Object.assign(Error(tr('目标位置已变化，请重新选择。')), { code: 'TARGET_CHANGED' });
}

export function siteAtDestination(site, target) {
  return site.type === 'site' && site.parentId === target.parentId && (target.parentId !== null || (site.page ?? 0) === target.page);
}

export function inheritedSitePrivacy(site, target, preferences) {
  const hiddenFolder = (id) => id && preferences.privateKeys.includes(`folder:${id}`);
  return hiddenFolder(site?.parentId) && !hiddenFolder(target.parentId) ? [`site:${site.id}`] : [];
}

export function appendSiteAt(state, site, target) {
  const order = state.entries.filter((item) => item.parentId === target.parentId).length;
  const entry = { ...site, ...target, order };
  delete entry.position;
  return { ...state, entries: [...state.entries, entry] };
}

export function previewLayoutTransfer(state, selectedIds, value, preferences, operation, { scope = 'roots' } = {}) {
  const target = navigationDestination(state, value, preferences);
  const selected = new Set(selectedIds);
  const hidden = preferences.presentation ? privateContentKeys(state, preferences) : new Set();
  const visible = (site) => !hidden.has(`site:${site.id}`);
  const existing = new Set(state.entries.filter((site) => siteAtDestination(site, target) && visible(site)).map((site) => site.url));
  const sources = [];
  let duplicates = 0;
  const candidates = state.entries.filter((site) => site.type === 'site' && (scope === 'all-sites' || site.parentId === null) && selected.has(site.id) && visible(site))
    .sort((a, b) => {
      if (scope !== 'all-sites') return a.order - b.order;
      const rootA = a.parentId ? state.entries.find((item) => item.id === a.parentId) : a;
      const rootB = b.parentId ? state.entries.find((item) => item.id === b.parentId) : b;
      return (rootA?.page ?? 0) - (rootB?.page ?? 0) || (rootA?.order ?? 0) - (rootB?.order ?? 0) || a.order - b.order;
    });
  for (const site of candidates) {
    if (operation === 'move' && siteAtDestination(site, target)) continue;
    if (existing.has(site.url)) { duplicates++; continue; }
    existing.add(site.url);
    sources.push(site);
  }
  return { target, sources, duplicates };
}

export function prepareLayoutTransfer(state, { target, sources }, operation, makeId = () => crypto.randomUUID()) {
  if (!sources.length) throw Error(tr('没有可移动的项目，请重新选择。'));
  const sourceIds = new Set(sources.map((source) => source.id)), copies = new Map();
  const remaining = state.entries.filter((entry) => operation === 'copy' || !sourceIds.has(entry.id));
  const entries = structuredClone(remaining);
  const containers = new Map();
  for (const entry of entries) {
    if (!containers.has(entry.parentId)) containers.set(entry.parentId, []);
    containers.get(entry.parentId).push(entry);
  }
  const group = containers.get(target.parentId) || [];
  containers.set(target.parentId, group);
  for (const siblings of containers.values()) {
    siblings.sort((a, b) => a.order - b.order).forEach((entry, index) => { entry.order = index; });
  }
  const ids = [];
  for (const source of sources) {
    const id = operation === 'copy' ? makeId() : source.id;
    const entry = { ...structuredClone(source), ...target, id, order: group.length };
    delete entry.position;
    group.push(entry);
    entries.push(entry);
    ids.push(id);
    if (operation === 'copy') copies.set(id, source.id);
  }
  return { state: migrateNavigationState({ ...state, entries }), ids, copies, target };
}

function originalCopySource(id, copies) {
  const visited = new Set();
  while (copies.has(id)) {
    if (visited.has(id)) throw destinationChanged();
    visited.add(id); id = copies.get(id);
  }
  return id;
}

export function layoutTransferPreferences(preferences, copies) {
  if (!copies.size) return preferences;
  const keys = new Set(preferences.privateKeys);
  for (const id of copies.keys()) if (keys.has(`site:${originalCopySource(id, copies)}`)) keys.add(`site:${id}`);
  const library = preferences.library ? { ...preferences.library, items: { ...preferences.library.items } } : null;
  if (library) for (const id of copies.keys()) {
    const sourceId = originalCopySource(id, copies);
    if (library.items[`site:${sourceId}`]) library.items[`site:${id}`] = structuredClone(library.items[`site:${sourceId}`]);
  }
  return { ...preferences, privateKeys: [...keys], ...(library ? { library } : {}) };
}

export function saveLayoutTransfer(state, expectedRevision, copies) {
  const savedCopies = state.entries.filter((entry) => copies.has(entry.id));
  return saveStateWithTrash(state, expectedRevision, { cause: 'layout-delete',
    copies: savedCopies.map((entry) => ({ from: `site:${originalCopySource(entry.id, copies)}`, to: `site:${entry.id}` })) });
}
