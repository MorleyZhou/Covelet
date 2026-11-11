import { tr } from '../i18n/index.js';
import { migrateNavigationState, normalizeUrl } from './model.js';
import { privateContentKeys } from './presentation.js';
import { CONTENT_LIBRARY_LIMITS, getContentMetadata, getContentTags, loadContentPreferences } from './content-preferences.js';
import * as storage from './storage.js';

const copy = (value) => structuredClone(value);
const conflict = () => Object.assign(Error(tr('所选项目已发生变化，请重新选择。')), { code: 'REVISION_CONFLICT' });
const privacy = () => Object.assign(Error(tr('请先输入密码解除隐藏。')), { code: 'PRIVACY_LOCKED' });
const limits = () => Object.assign(Error(tr('合并后的备注或标签超出限制，请减少所选副本。')), { code: 'DUPLICATE_METADATA_LIMIT' });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function hiddenKeysFor(navigation, preferences, extra) {
  if (!preferences.presentation) return new Set();
  return new Set([...privateContentKeys(navigation, preferences), ...(extra || [])]);
}
function itemLocation(navigation, entry) {
  const folder = entry.parentId ? navigation.entries.find((item) => item.id === entry.parentId && item.type === 'folder') : null;
  const page = folder?.page ?? entry.page ?? 0;
  const desktopId = navigation.settings?.desktopPages?.[page]?.id || `@page:${page}`;
  return { page, parentId: entry.parentId, desktopId, locationKey: folder ? `folder:${folder.id}` : `desktop:${desktopId}` };
}
function duplicateItem(navigation, preferences, entry, tags, privateKeys) {
  const key = `site:${entry.id}`, metadata = getContentMetadata({ ...preferences, presentation: false }, key);
  return { entry: copy(entry), key, ...metadata, ...itemLocation(navigation, entry), private: privateKeys.has(key),
    tags: metadata.tagIds.map((id) => tags.find((tag) => tag.id === id)).filter(Boolean).map(copy) };
}

// A URL appears in exactly one section. Filter privacy before computing either
// its group size or its number of locations, so hidden copies leave no trace.
export function findNavigationDuplicates(navigation, preferences, { hiddenKeys } = {}) {
  const hidden = hiddenKeysFor(navigation, preferences, hiddenKeys), privateKeys = privateContentKeys(navigation, preferences);
  const tags = getContentTags(preferences, { hiddenKeys: hidden }), byUrl = new Map();
  for (const entry of navigation.entries) {
    if (entry.type !== 'site' || entry.detached || hidden.has(`site:${entry.id}`)) continue;
    let url;
    try { url = normalizeUrl(entry.url); } catch { continue; }
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(duplicateItem(navigation, preferences, entry, tags, privateKeys));
  }
  const groups = [];
  for (const [url, items] of byUrl) {
    if (items.length < 2) continue;
    const kind = new Set(items.map((item) => item.locationKey)).size === 1 ? 'same-location' : 'cross-location';
    groups.push({ id: url, url, kind, items });
  }
  return { groups, sameLocation: groups.filter((group) => group.kind === 'same-location'), crossLocation: groups.filter((group) => group.kind === 'cross-location') };
}

export function previewNavigationDuplicates(navigation, preferences, selection = {}, { hiddenKeys } = {}) {
  const { keepId, removeIds, mergeMetadata = false } = selection;
  const invalid = (reason, status = 'invalid', extra = {}) => ({ status, reason, keepId, removeIds: [], removeCount: 0, mergeMetadata, ...extra });
  if (typeof keepId !== 'string' || !Array.isArray(removeIds) || !removeIds.length) return invalid('empty-selection');
  if (typeof mergeMetadata !== 'boolean' || removeIds.some((id) => typeof id !== 'string' || id === keepId)
    || new Set(removeIds).size !== removeIds.length) return invalid('invalid-selection');
  const requested = new Set([keepId, ...removeIds]), entries = navigation.entries.filter((entry) => requested.has(entry.id));
  if (entries.length !== requested.size || entries.some((entry) => entry.type !== 'site' || entry.detached)) return invalid('invalid-selection');
  const hidden = hiddenKeysFor(navigation, preferences, hiddenKeys);
  if (entries.some((entry) => hidden.has(`site:${entry.id}`))) return invalid('hidden-reference', 'hidden');
  const keep = entries.find((entry) => entry.id === keepId), others = entries.filter((entry) => entry.id !== keepId);
  let url;
  try {
    url = normalizeUrl(keep.url);
    if (others.some((entry) => normalizeUrl(entry.url) !== url)) return invalid('not-duplicate');
  } catch { return invalid('invalid-selection'); }
  const targets = [keep, ...others], expectedMetadata = targets.map((entry) => ({ key: `site:${entry.id}`,
    ...getContentMetadata({ ...preferences, presentation: false }, `site:${entry.id}`) }));
  let mergedMetadata = { description: expectedMetadata[0].description, tagIds: [...expectedMetadata[0].tagIds] };
  if (mergeMetadata) {
    mergedMetadata = { description: [...new Set(expectedMetadata.map((item) => item.description.trim()).filter(Boolean))].join('\n\n'),
      tagIds: [...new Set(expectedMetadata.flatMap((item) => item.tagIds))] };
  }
  const privateKeys = privateContentKeys(navigation, preferences), addedPrivateKeys = mergeMetadata && targets.some((entry) => privateKeys.has(`site:${entry.id}`))
    && !privateKeys.has(`site:${keepId}`) ? [`site:${keepId}`] : [];
  const plan = { status: 'ready', reason: null, keepId, removeIds: others.map((entry) => entry.id), removeCount: others.length,
    mergeMetadata, mergedMetadata, addedPrivateKeys, expectedNavigationRevision: navigation.revision,
    expectedPreferencesRevision: preferences.revision ?? 0, expectedMetadata, entries: copy(targets) };
  if (mergedMetadata.description.length > CONTENT_LIBRARY_LIMITS.description || mergedMetadata.tagIds.length > CONTENT_LIBRARY_LIMITS.itemTags) {
    return { ...plan, status: 'invalid', reason: 'metadata-limits' };
  }
  return plan;
}

function removedState(navigation, removeIds) {
  const removed = new Set(removeIds), next = copy(navigation), containers = new Map();
  next.entries = next.entries.filter((entry) => !removed.has(entry.id));
  for (const entry of next.entries) {
    const key = JSON.stringify([entry.groupId, entry.parentId]);
    if (!containers.has(key)) containers.set(key, []);
    containers.get(key).push(entry);
  }
  for (const entries of containers.values()) entries.sort((a, b) => a.order - b.order).forEach((entry, index) => { entry.order = index; });
  // Keep empty/single-child folders. A duplicate review removes only the
  // explicitly selected sites and never dissolves an unselected container.
  return migrateNavigationState(next);
}

// Dependency seams let the transaction tests use the real navigation store
// against isolated encrypted-record adapters, without touching a browser profile.
export async function commitNavigationDuplicates(plan, { storageApi = storage, loadPreferences = loadContentPreferences } = {}) {
  if (plan?.status === 'hidden') throw privacy();
  if (plan?.reason === 'metadata-limits') throw limits();
  if (plan?.status !== 'ready') throw conflict();
  const [navigation, preferences] = await Promise.all([storageApi.loadState(), loadPreferences()]);
  if (navigation.revision !== plan.expectedNavigationRevision || (preferences.revision ?? 0) !== plan.expectedPreferencesRevision) throw conflict();
  const fresh = previewNavigationDuplicates(navigation, preferences, plan);
  if (fresh.status === 'hidden') throw privacy();
  if (fresh.reason === 'metadata-limits') throw limits();
  if (fresh.status !== 'ready' || !same(fresh.entries, plan.entries) || !same(fresh.expectedMetadata, plan.expectedMetadata)
    || !same(fresh.mergedMetadata, plan.mergedMetadata) || !same(fresh.addedPrivateKeys, plan.addedPrivateKeys)) throw conflict();
  const next = removedState(navigation, fresh.removeIds);
  const keepBaseline = { description: fresh.expectedMetadata[0].description, tagIds: fresh.expectedMetadata[0].tagIds };
  const state = await storageApi.saveStateWithTrash(next, plan.expectedNavigationRevision, { cause: 'duplicates',
    expectedPreferencesRevision: plan.expectedPreferencesRevision, expectedMetadata: plan.expectedMetadata,
    metadata: fresh.mergeMetadata ? [{ key: `site:${fresh.keepId}`, ...fresh.mergedMetadata, expectedMetadata: keepBaseline }] : [],
    addedPrivateKeys: fresh.addedPrivateKeys });
  return { state, removedIds: [...fresh.removeIds] };
}
