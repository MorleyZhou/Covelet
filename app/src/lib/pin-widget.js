import { tr } from '../i18n/index.js';
import { loadState, saveStateWithPrivacy } from './storage.js';
import { configureWidget } from './model.js';
import { appendReferencedWidget, resolveReferencedWidget, widgetContentReference } from './referenced-widgets.js';
import { loadPersonalToolsSnapshot } from './personal-tools.js';

const changed = () => Object.assign(Error(tr('所选项目已发生变化，请重新选择。')), { code: 'REVISION_CONFLICT' });

// The navigation writer owns navigation→preferences locks. Keep the tools lock
// through its atomic write as well, so a note cannot disappear between target
// verification and publishing its card. No target content is copied into it.
export async function pinContentWidget({ kind, recordId, size = 'small', page = 0, widgetId, expectedConfig,
  expectedNavigationRevision, expectedPreferencesRevision, expectedRecordRevision }) {
  if (!['note', 'view'].includes(kind) || !Number.isSafeInteger(expectedRecordRevision) || expectedRecordRevision < 1
    || !Number.isSafeInteger(expectedPreferencesRevision) || expectedPreferencesRevision < 0) throw changed();
  const state = await loadState();
  if (state.revision !== expectedNavigationRevision) throw changed();
  const extensionId = kind === 'note' ? 'notes' : 'saved-view', config = { size, [kind === 'note' ? 'noteId' : 'viewId']: recordId };
  let prepared;
  if (widgetId) {
    const current = state.entries.find((entry) => entry.id === widgetId && entry.type === 'widget' && entry.extensionId === extensionId && !entry.detached);
    if (!current || JSON.stringify(current.config) !== JSON.stringify(expectedConfig)) throw changed();
    prepared = { state: configureWidget(state, extensionId, config, widgetId), widgetId };
  } else prepared = appendReferencedWidget(state, extensionId, config, { page });
  if (!globalThis.navigator?.locks?.request) throw Error(tr('内容未能保存，请重试。'));
  const saved = await saveStateWithPrivacy(prepared.state, expectedNavigationRevision, async (preferences, commit) => {
    if (preferences.revision !== expectedPreferencesRevision) throw changed();
    return navigator.locks.request('covelet.tools.v1', async () => {
      const tools = await loadPersonalToolsSnapshot();
      const entry = prepared.state.entries.find((item) => item.id === prepared.widgetId);
      const result = resolveReferencedWidget(entry, { navigation: state, tools, preferences });
      if (result.status === 'hidden') throw Object.assign(Error(tr('请先输入密码解除隐藏。')), { code: 'PRIVACY_LOCKED' });
      if (result.status !== 'ready' || result.target.revision !== expectedRecordRevision) throw changed();
      const reference = widgetContentReference(entry);
      return commit(preferences.privateKeys.includes(reference.key) ? [`widget:${entry.id}`] : [], { expectedRevision: expectedPreferencesRevision });
    });
  });
  return { state: saved, widgetId: prepared.widgetId };
}
