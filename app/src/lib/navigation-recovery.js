import { validateContentPreferences } from './content-preferences.js';
import { tr } from '../i18n/index.js';
import { logicalDesktopPages } from './desktop-pages.js';

const navigationKey = /^(site|folder|widget):/u;

export function preserveInvalidViewReferences(input, { sourceNavigation, targetNavigation, targetPreferences, includeRecycledFolders = false, makeId = () => crypto.randomUUID() }) {
  const result = validateContentPreferences(input);
  if (!result.library?.views) return result;
  const folders = new Set((sourceNavigation?.entries || []).filter((entry) => entry.type === 'folder').map((entry) => entry.id));
  if (includeRecycledFolders) for (const item of sourceNavigation?.trash?.items || []) for (const entry of item.ownedEntries) if (entry.type === 'folder') folders.add(entry.id);
  const pages = new Set(sourceNavigation ? logicalDesktopPages(sourceNavigation) : []);
  const desktops = new Set(Object.entries(sourceNavigation?.settings?.desktopPages || {}).filter(([page]) => pages.has(Number(page))).map(([, metadata]) => metadata.id));
  const tags = new Set(result.library.tags.map((tag) => tag.id));
  const occupied = new Set([...(targetNavigation?.entries || []).map((entry) => entry.id), ...Object.values(targetNavigation?.settings?.desktopPages || {}).map((entry) => entry.id),
    ...(targetPreferences?.library?.tags || []).map((tag) => tag.id), ...folders, ...desktops, ...tags]);
  const missing = new Map();
  function isolate(kind, original) {
    const key = `${kind}:${original}`;
    if (!missing.has(key)) {
      let id;
      for (let attempt = 0; attempt < 100; attempt++) {
        const candidate = `missing-${kind}-${makeId()}`;
        if (/^[a-z\d-]{1,100}$/iu.test(candidate) && !occupied.has(candidate)) { id = candidate; break; }
      }
      if (!id) throw Object.assign(Error(tr('恢复期间数据已更新，请重新预览。')), { code: 'REVISION_CONFLICT' });
      missing.set(key, id); occupied.add(id);
    }
    return missing.get(key);
  }
  for (const view of result.library.views) {
    if (view.scope.kind === 'folder' && !folders.has(view.scope.folderId)) view.scope.folderId = isolate('folder', view.scope.folderId);
    if (view.scope.kind === 'desktop' && !desktops.has(view.scope.desktopId)) view.scope.desktopId = isolate('desktop', view.scope.desktopId);
    view.tagIds = view.tagIds.map((id) => tags.has(id) ? id : isolate('tag', id));
  }
  return validateContentPreferences(result);
}

// Append only brings preferences for navigation records actually imported.
// Missing source folder references stay missing, even when a local folder has
// the same ID. Tags keep their source identities until the existing merger
// maps them to the destination dictionary.
export function remapNavigationPreferences(input, { preferenceKeyMap, referenceIdMap, reservedEntryIds = [], makeId = () => crypto.randomUUID() }) {
  const source = validateContentPreferences(input), result = structuredClone(source);
  const mapKey = (key) => navigationKey.test(key) ? preferenceKeyMap.get(key) : key;
  result.aliases = Object.fromEntries(Object.entries(source.aliases).flatMap(([key, value]) => {
    const target = mapKey(key); return target ? [[target, value]] : [];
  }));
  result.privateKeys = [...new Set(source.privateKeys.map(mapKey).filter(Boolean))];
  if (source.library) {
    result.library.items = Object.fromEntries(Object.entries(source.library.items).flatMap(([key, value]) => {
      const target = mapKey(key); return target ? [[target, value]] : [];
    }));
    const references = new Map(referenceIdMap), reserved = new Set([...reservedEntryIds, ...references.values()]);
    if (source.library.views) result.library.views = source.library.views.map((view) => {
      const next = structuredClone(view);
      if (view.scope.kind === 'folder') {
        const original = view.scope.folderId;
        if (!references.has(original)) {
          let id;
          for (let attempt = 0; attempt < 100; attempt++) {
            const candidate = `missing-folder-${makeId()}`;
            if (/^[a-z\d-]{1,100}$/iu.test(candidate) && !reserved.has(candidate)) { id = candidate; break; }
          }
          if (!id) throw Object.assign(Error(tr('恢复期间数据已更新，请重新预览。')), { code: 'REVISION_CONFLICT' });
          references.set(original, id); reserved.add(id);
        }
        next.scope.folderId = references.get(original);
      }
      return next;
    });
  }
  return validateContentPreferences(result);
}
