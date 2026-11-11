import { tr } from '../i18n/index.js';
import { loadState, saveStateWithPrivacy } from './storage.js';
import { loadContentPreferences } from './content-preferences.js';
import { privateContentKeys } from './presentation.js';
import { prepareLayoutTransfer, previewLayoutTransfer } from './navigation-destinations.js';

const changed = () => Object.assign(Error(tr('所选项目已发生变化，请重新选择。')), { code: 'REVISION_CONFLICT' });
const hidden = () => Object.assign(Error(tr('请先输入密码解除隐藏。')), { code: 'PRIVACY_LOCKED' });

function selectedSites(state, preferences, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 12000 || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw changed();
  const entries = ids.map((id) => state.entries.find((item) => item.id === id));
  if (entries.some((entry) => !entry || entry.type !== 'site')) throw changed();
  const hiddenKeys = privateContentKeys(state, preferences);
  if (preferences.presentation && entries.some((entry) => hiddenKeys.has(`site:${entry.id}`))) throw hidden();
  return { entries, hiddenKeys };
}

async function snapshot(expectedNavigationRevision, expectedPreferencesRevision) {
  const [state, preferences] = await Promise.all([loadState(), loadContentPreferences()]);
  if (state.revision !== expectedNavigationRevision || preferences.revision !== expectedPreferencesRevision) throw changed();
  return { state, preferences };
}

export async function commitNavigationTransfer({ ids, operation, destinationValue, expectedNavigationRevision, expectedPreferencesRevision }) {
  if (!['move', 'copy'].includes(operation)) throw changed();
  const { state, preferences } = await snapshot(expectedNavigationRevision, expectedPreferencesRevision);
  selectedSites(state, preferences, ids);
  const preview = previewLayoutTransfer(state, ids, destinationValue, preferences, operation, { scope: 'all-sites' });
  const prepared = prepareLayoutTransfer(state, preview, operation);
  const saved = await saveStateWithPrivacy(prepared.state, expectedNavigationRevision, async (current, commit) => {
    const latest = await loadState();
    if (latest.revision !== expectedNavigationRevision || current.revision !== expectedPreferencesRevision) throw changed();
    const { hiddenKeys } = selectedSites(latest, current, ids);
    const verified = previewLayoutTransfer(latest, ids, destinationValue, current, operation, { scope: 'all-sites' });
    if (verified.sources.length !== preview.sources.length || verified.sources.some((source, index) => source.id !== preview.sources[index].id)) throw changed();
    const addedKeys = [], metadata = [];
    for (const id of prepared.ids) {
      const sourceId = operation === 'copy' ? prepared.copies.get(id) : id;
      if (hiddenKeys.has(`site:${sourceId}`)) addedKeys.push(`site:${id}`);
      if (operation === 'copy') metadata.push({ key: `site:${id}`,
        ...(current.library?.items[`site:${sourceId}`] || { description: '', tagIds: [] }) });
    }
    return commit(addedKeys, { metadata, expectedRevision: expectedPreferencesRevision });
  });
  return { state: saved, ids: prepared.ids, duplicates: preview.duplicates };
}

export async function commitNavigationTags({ ids, operation, tagIds, expectedNavigationRevision, expectedPreferencesRevision, expectedMetadata }) {
  if (!['add', 'remove'].includes(operation) || !Array.isArray(tagIds) || !tagIds.length || tagIds.length > 20 || new Set(tagIds).size !== tagIds.length) throw changed();
  const { state, preferences } = await snapshot(expectedNavigationRevision, expectedPreferencesRevision);
  selectedSites(state, preferences, ids);
  const saved = await saveStateWithPrivacy(state, expectedNavigationRevision, async (current, commit) => {
    const latest = await loadState();
    if (latest.revision !== expectedNavigationRevision || current.revision !== expectedPreferencesRevision) throw changed();
    selectedSites(latest, current, ids);
    if (tagIds.some((id) => !current.library?.tags.some((tag) => tag.id === id))) throw changed();
    const metadata = ids.map((id) => {
      const key = `site:${id}`, actual = current.library?.items[key] || { description: '', tagIds: [] };
      if (!expectedMetadata?.[key]) throw changed();
      return { key, description: actual.description,
        tagIds: operation === 'add' ? [...new Set([...actual.tagIds, ...tagIds])] : actual.tagIds.filter((tagId) => !tagIds.includes(tagId)),
        expectedMetadata: expectedMetadata[key] };
    });
    return commit([], { metadata, expectedRevision: expectedPreferencesRevision });
  });
  return { state: saved, ids };
}
