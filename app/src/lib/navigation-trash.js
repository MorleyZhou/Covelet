import { tr } from '../i18n/index.js';
import { loadState, saveStateWithPrivacy, validateNavigationResources } from './storage.js';
import { loadContentPreferences } from './content-preferences.js';
import { migrateNavigationState } from './model.js';
import { getNavigationTrash, prepareTrashRestore as prepare, restoreTrashItem, removeTrashMetadata } from './navigation-trash-core.js';

export { getNavigationTrash, cloneTrashForAppend } from './navigation-trash-core.js';
const changed = () => Object.assign(Error(tr('所选项目已发生变化，请重新选择。')), { code: 'REVISION_CONFLICT' });
function revisions(state, preferences, options) {
  if (state.revision !== options.expectedNavigationRevision || preferences.revision !== options.expectedPreferencesRevision) throw changed();
}
export function prepareTrashRestore(state, preferences, id, options) {
  const plan = prepare(state, preferences, id, options);
  for (const key of ['restoredIds', 'reattachIds', 'skippedMemberIds']) Object.freeze(plan[key]);
  if (plan.target) Object.freeze(plan.target);
  return Object.freeze(plan);
}
export async function commitTrashRestore(plan) {
  if (!plan || plan.status !== 'ready') throw changed();
  const [state, preferences] = await Promise.all([loadState(), loadContentPreferences()]);
  revisions(state, preferences, plan);
  const result = restoreTrashItem(state, preferences, plan.trashId, { destinationValue: plan.destinationValue });
  await validateNavigationResources(result.state, { entryIds: result.restoredIds });
  const saved = await saveStateWithPrivacy(result.state, state.revision, async (current, commit) => {
    const latest = await loadState(); revisions(latest, current, plan);
    restoreTrashItem(latest, current, plan.trashId, { destinationValue: plan.destinationValue });
    return commit([], { expectedRevision: plan.expectedPreferencesRevision });
  });
  return { ...result, state: saved };
}

async function removeItems(ids, options, expiredOnly = false) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw changed();
  const [state, preferences] = await Promise.all([loadState(), loadContentPreferences()]);
  revisions(state, preferences, options);
  const selected = new Set(ids), available = expiredOnly
    ? (state.trash?.items || []).filter((item) => item.deletedAt + 30 * 86400000 <= Date.now())
    : getNavigationTrash(state, preferences);
  if (ids.some((id) => !available.some((item) => item.id === id))) throw changed();
  const next = migrateNavigationState({ ...state, trash: { version: 1, items: state.trash.items.filter((item) => !selected.has(item.id)) } });
  const saved = await saveStateWithPrivacy(next, state.revision, async (current, commit) => {
    const latest = await loadState(); revisions(latest, current, options);
    if (!expiredOnly && ids.some((id) => !getNavigationTrash(latest, current).some((item) => item.id === id))) throw changed();
    const cleanup = removeTrashMetadata(current, latest, next, selected);
    return commit([], { expectedRevision: options.expectedPreferencesRevision, ...(cleanup ? { replacePreferences: cleanup } : {}) });
  });
  return { state: saved, count: ids.length };
}
export function commitTrashDelete(ids, options) { return removeItems(ids, options); }
export async function purgeExpiredNavigationTrash() {
  const [state, preferences] = await Promise.all([loadState(), loadContentPreferences()]);
  const ids = (state.trash?.items || []).filter((item) => item.deletedAt + 30 * 86400000 <= Date.now()).map((item) => item.id);
  if (!ids.length) return { state, count: 0 };
  return removeItems(ids, { expectedNavigationRevision: state.revision, expectedPreferencesRevision: preferences.revision }, true);
}
