import { tr } from '../i18n/index.js';
import { deleteEntry, migrateNavigationState, NAVIGATION_TRASH_LIMITS } from './model.js';
import { logicalDesktopPages } from './desktop-pages.js';
import { privateContentKeys } from './presentation.js';
import { sameJson } from './json-equal.js';
import { navigationResourceEntries } from './navigation-resources.js';

const copy = (value) => structuredClone(value);
const retention = NAVIGATION_TRASH_LIMITS.retentionDays * 86400000;
const changed = () => Object.assign(Error(tr('所选项目已发生变化，请重新选择。')), { code: 'REVISION_CONFLICT' });
const locked = () => Object.assign(Error(tr('请先输入密码解除隐藏。')), { code: 'PRIVACY_LOCKED' });
const desktopId = (state, page) => state.settings.desktopPages?.[page]?.id || null;
const entryPage = (state, entry) => entry.parentId ? state.entries.find((item) => item.id === entry.parentId)?.page ?? entry.page ?? 0 : entry.page ?? 0;
const placement = (state, entry) => ({ desktopId: desktopId(state, entry.page ?? 0), page: entry.page ?? 0, parentId: null,
  ...(entry.position ? { position: copy(entry.position) } : {}), order: entry.order });
const samePlacement = (left, right) => left.parentId === right.parentId && (left.page ?? 0) === (right.page ?? 0)
  && sameJson(left.position, right.position) && (left.position || left.order === right.order);
function renumber(state) {
  const groups = new Map();
  for (const entry of state.entries) {
    const key = entry.parentId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  for (const entries of groups.values()) entries.sort((a, b) => a.order - b.order).forEach((entry, index) => { entry.order = index; });
  return state;
}
function hiddenItem(state, preferences, item) {
  if (!preferences.presentation) return false;
  const hidden = privateContentKeys(state, preferences);
  return [...item.ownedEntries, ...item.memberRefs.map((member) => ({ type: 'site', id: member.id }))]
    .some((entry) => hidden.has(`${entry.type}:${entry.id}`));
}
export function getNavigationTrash(state, preferences, { now = Date.now() } = {}) {
  return copy((state.trash?.items || []).filter((item) => item.deletedAt + retention > now && !hiddenItem(state, preferences, item)).map((item) => {
    const entry = item.ownedEntries[0];
    return { ...item, title: entry.name, ...(entry.url ? { url: entry.url } : {}), entry,
      expiresAt: item.deletedAt + retention, ownedCount: item.ownedEntries.length,
      siteCount: item.ownedEntries.filter((entry) => entry.type === 'site').length, memberCount: item.memberRefs.length };
  }));
}

export function prepareNavigationDeletion(input, desired, preferences, { cause = 'context-delete', now = Date.now(), makeId = () => crypto.randomUUID() } = {}) {
  if (!['context-delete', 'layout-delete', 'duplicates'].includes(cause)) throw changed();
  const before = migrateNavigationState(input), state = migrateNavigationState(desired);
  if (!sameJson(before.trash, state.trash)) throw changed();
  const expiredTrashIds = (before.trash?.items || []).filter((item) => item.deletedAt + retention <= now).map((item) => item.id);
  if (expiredTrashIds.length) {
    const expired = new Set(expiredTrashIds);
    state.trash.items = state.trash.items.filter((item) => !expired.has(item.id));
  }
  const remaining = new Map(state.entries.map((entry) => [entry.id, entry]));
  const removed = before.entries.filter((entry) => ['site', 'folder'].includes(entry.type) && !remaining.has(entry.id));
  if (!removed.length) return { state, addedPrivateKeys: [], expiredTrashIds };
  const hidden = privateContentKeys(before, preferences);
  if (preferences.presentation && removed.some((entry) => hidden.has(`${entry.type}:${entry.id}`))) throw locked();
  const removedIds = new Set(removed.map((entry) => entry.id)), grouped = new Set(), events = [], addedPrivateKeys = [];
  const origin = (entry) => { const page = entryPage(before, entry); return { desktopId: desktopId(before, page), page, parentId: entry.parentId }; };
  for (const folder of removed.filter((entry) => entry.type === 'folder')) {
    const children = before.entries.filter((entry) => entry.parentId === folder.id);
    // Derive only the normal promotion placement. A moved child is never
    // captured as a restorable member merely because its old folder vanished.
    let promoting = children.filter((entry) => {
      const current = remaining.get(entry.id);
      return current && current.parentId === null && (current.page ?? 0) === (folder.page ?? 0)
        && (!current.position || sameJson(current.position, folder.position));
    });
    if (folder.position) {
      const first = promoting.find((entry) => sameJson(remaining.get(entry.id).position, folder.position));
      if (first) promoting = promoting.filter((entry) => entry.order >= first.order);
    }
    const promotingIds = new Set(promoting.map((entry) => entry.id));
    const promotionBase = renumber({ ...copy(before), entries: copy(before.entries.filter((entry) => entry.parentId !== folder.id || promotingIds.has(entry.id))) });
    const promoted = new Map(deleteEntry(promotionBase, folder.id).entries.map((entry) => [entry.id, entry]));
    const memberRefs = children.filter((entry) => {
      const current = remaining.get(entry.id), expected = promoted.get(entry.id);
      return promotingIds.has(entry.id) && current && expected && current.parentId === null && samePlacement(current, expected);
    }).map((entry) => { const current = remaining.get(entry.id); return { id: entry.id, name: current.name, url: current.url, placement: placement(state, current) }; });
    const ownedEntries = [copy(folder), ...children.filter((entry) => removedIds.has(entry.id)).map(copy)];
    for (const entry of ownedEntries) grouped.add(entry.id);
    events.push({ id: `trash-${makeId()}`, kind: 'folder', deletedAt: now, origin: origin(folder), ownedEntries, memberRefs });
    for (const child of children) if (hidden.has(`site:${child.id}`)) addedPrivateKeys.push(`site:${child.id}`);
  }
  for (const entry of removed.filter((entry) => entry.type === 'site' && !grouped.has(entry.id))) {
    events.push({ id: `trash-${makeId()}`, kind: 'site', deletedAt: now, origin: origin(entry), ownedEntries: [copy(entry)], memberRefs: [] });
    if (hidden.has(`site:${entry.id}`)) addedPrivateKeys.push(`site:${entry.id}`);
  }
  state.trash = { version: 1, items: [...(state.trash?.items || []), ...events] };
  return { state: migrateNavigationState(state), addedPrivateKeys: [...new Set(addedPrivateKeys)], expiredTrashIds };
}

export function removeTrashMetadata(preferences, before, after, ids) {
  const selected = ids instanceof Set ? ids : new Set(ids);
  const affected = new Set((before.trash?.items || []).filter((item) => selected.has(item.id)).flatMap((item) => item.ownedEntries.map((entry) => `${entry.type}:${entry.id}`)));
  for (const entry of navigationResourceEntries(after)) affected.delete(`${entry.type}:${entry.id}`);
  const result = copy(preferences); let changed = false;
  for (const key of affected) {
    if (Object.hasOwn(result.aliases, key)) { delete result.aliases[key]; changed = true; }
    if (result.library && Object.hasOwn(result.library.items, key)) { delete result.library.items[key]; changed = true; }
  }
  // Missing-folder saved views and private orphan keys remain conservative.
  return changed ? result : null;
}

function destination(state, preferences, value, kind) {
  const pages = logicalDesktopPages(state);
  const page = pages.find((page) => value === (desktopId(state, page) ? `page-id:${desktopId(state, page)}` : `page:${page}`));
  if (page !== undefined) return { page, parentId: null };
  if (kind === 'site') {
    const folder = state.entries.find((entry) => entry.type === 'folder' && value === `folder:${entry.id}`);
    if (folder && !(preferences.presentation && preferences.privateKeys.includes(`folder:${folder.id}`))) return { page: folder.page ?? 0, parentId: folder.id };
  }
  return null;
}
function originalDestination(state, item) {
  if (item.origin.parentId !== null) return state.entries.some((entry) => entry.type === 'folder' && entry.id === item.origin.parentId) ? `folder:${item.origin.parentId}` : null;
  if (!item.origin.desktopId) return null;
  return Object.entries(state.settings.desktopPages || {}).some(([page, data]) => data.id === item.origin.desktopId && logicalDesktopPages(state).includes(Number(page)))
    ? `page-id:${item.origin.desktopId}` : null;
}
function compatibleMember(state, member) {
  const entry = state.entries.find((entry) => entry.type === 'site' && entry.id === member.id);
  if (!entry || entry.parentId !== null) return false;
  const actual = placement(state, entry), baseline = member.placement;
  if (baseline.desktopId && actual.desktopId !== baseline.desktopId) return false;
  return (baseline.desktopId || actual.page === baseline.page) && sameJson(actual.position, baseline.position) && (baseline.position || actual.order === baseline.order);
}
export function prepareTrashRestore(state, preferences, id, { destinationValue, now = Date.now() } = {}) {
  const item = state.trash?.items.find((item) => item.id === id);
  const common = { trashId: id, destinationValue: destinationValue || null, expectedNavigationRevision: state.revision, expectedPreferencesRevision: preferences.revision,
    restoredIds: [], reattachIds: [], skippedMemberIds: [] };
  if (!item || item.deletedAt + retention <= now) return { ...common, status: 'conflict', reason: 'missing-or-expired' };
  if (hiddenItem(state, preferences, item)) return { ...common, status: 'hidden', reason: 'private-content' };
  const value = destinationValue || originalDestination(state, item), target = value && destination(state, preferences, value, item.kind);
  const result = { ...common, destinationValue: value || null, title: item.ownedEntries[0].name };
  if (!target) return { ...result, status: 'needs-destination', reason: 'missing-position' };
  if (item.ownedEntries.some((entry) => state.entries.some((current) => current.id === entry.id))) return { ...result, status: 'conflict', reason: 'id-collision' };
  const reattachIds = item.memberRefs.filter((member) => compatibleMember(state, member)).map((member) => member.id);
  return { ...result, status: 'ready', target, restoredIds: item.ownedEntries.map((entry) => entry.id), reattachIds,
    skippedMemberIds: item.memberRefs.filter((member) => !reattachIds.includes(member.id)).map((member) => member.id) };
}
export function restoreTrashItem(input, preferences, id, options = {}) {
  const state = migrateNavigationState(input), plan = prepareTrashRestore(state, preferences, id, options);
  if (plan.status === 'hidden') throw locked();
  if (plan.status !== 'ready') throw changed();
  const item = state.trash.items.find((item) => item.id === id), first = item.ownedEntries[0], target = plan.target;
  const roots = state.entries.filter((entry) => entry.parentId === target.parentId), root = { ...copy(first), ...target, groupId: 'group-home', order: roots.length };
  delete root.position;
  state.entries.push(root);
  if (item.kind === 'folder') {
    const children = item.ownedEntries.slice(1).map(copy);
    children.push(...plan.reattachIds.map((id) => state.entries.find((entry) => entry.id === id)));
    children.forEach((entry, index) => { entry.parentId = root.id; entry.page = target.page; entry.order = index; delete entry.position; });
    state.entries.push(...children.filter((entry) => !state.entries.includes(entry)));
  }
  state.trash.items = state.trash.items.filter((entry) => entry.id !== id);
  return { state: migrateNavigationState(renumber(state)), restoredIds: plan.restoredIds, reattachedIds: plan.reattachIds, skippedMemberIds: plan.skippedMemberIds };
}

export function cloneTrashForAppend(target, source, { activeIdMap = new Map(), desktopIdMap = new Map(), pageMap = new Map(), reservedPreferenceKeys = [], makeId = () => crypto.randomUUID() } = {}) {
  const state = copy(target), occupied = new Set([...state.entries.map((entry) => entry.id), ...(state.trash?.items || []).flatMap((item) => [...item.ownedEntries.map((entry) => entry.id), ...item.memberRefs.map((member) => member.id)]),
    ...reservedPreferenceKeys.map((key) => key.slice(key.indexOf(':') + 1))]);
  const ownedIdMap = new Map(), referenceIdMap = new Map(activeIdMap), preferenceKeyMap = new Map();
  const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\u0000-\u001f\u007f]/u.test(value);
  const allocateFrom = (preferred, taken, prefix = '') => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const next = attempt === 0 ? preferred : `${prefix}${makeId()}`;
      if (validId(next) && !taken.has(next)) { taken.add(next); return next; }
    }
    throw changed();
  };
  const allocate = (id) => allocateFrom(id, occupied);
  const missingDesktops = new Map(), desktopIds = new Set([...Object.values(state.settings.desktopPages || {}).map((item) => item.id), ...desktopIdMap.values()]);
  const desktopReference = (id) => {
    if (id === null) return null;
    if (desktopIdMap.has(id)) return desktopIdMap.get(id);
    if (!missingDesktops.has(id)) missingDesktops.set(id, allocateFrom(`missing-desktop-${makeId()}`, desktopIds, 'missing-desktop-'));
    return missingDesktops.get(id);
  };
  for (const entry of source.entries) {
    if (activeIdMap.has(entry.id)) preferenceKeyMap.set(`${entry.type}:${entry.id}`, `${entry.type}:${activeIdMap.get(entry.id)}`);
    else referenceIdMap.set(entry.id, allocate(`missing-${makeId()}`));
  }
  for (const item of source.trash?.items || []) for (const entry of item.ownedEntries) {
    const id = allocate(entry.id); ownedIdMap.set(entry.id, id); referenceIdMap.set(entry.id, id); preferenceKeyMap.set(`${entry.type}:${entry.id}`, `${entry.type}:${id}`);
  }
  const reference = (id) => {
    if (id === null) return null;
    if (!referenceIdMap.has(id)) referenceIdMap.set(id, allocate(`missing-${makeId()}`));
    return referenceIdMap.get(id);
  };
  const mapPlacement = (value) => ({ ...value, page: pageMap.get(value.page) ?? value.page,
    desktopId: desktopReference(value.desktopId), parentId: reference(value.parentId) });
  const eventIds = new Set((state.trash?.items || []).map((item) => item.id)), items = [];
  for (const original of source.trash?.items || []) {
    const id = allocateFrom(original.id, eventIds, 'trash-');
    items.push({ ...copy(original), id, origin: mapPlacement(original.origin), ownedEntries: original.ownedEntries.map((entry) => ({ ...copy(entry), id: ownedIdMap.get(entry.id),
      parentId: entry.parentId === null ? null : reference(entry.parentId), ...(entry.page !== undefined ? { page: pageMap.get(entry.page) ?? entry.page } : {}) })),
    memberRefs: original.memberRefs.map((member) => ({ ...copy(member), id: reference(member.id), placement: mapPlacement(member.placement) })) });
  }
  if (source.trash || state.trash) state.trash = { version: 1, items: [...(state.trash?.items || []), ...items] };
  return { state: migrateNavigationState(state), entryIdMap: new Map([...activeIdMap, ...ownedIdMap]), ownedIdMap, referenceIdMap, preferenceKeyMap };
}
