import { tr } from '../i18n/index.js';
import { resolveSavedView, validateSavedView } from './saved-views.js';
import { privateContentKeys } from './presentation.js';
import { navigationResourceEntries } from './navigation-resources.js';
import { NOTES_WIDGET_ID, SAVED_VIEW_WIDGET_ID, validWidgetContentId, validateWidgetConfig, widgetContentReference } from './widget-model.js';

export { appendReferencedWidget } from './model.js';
export { widgetContentReference } from './widget-model.js';

// Evaluate current portable records, never an embedded title/body snapshot.
// Conditional private view references are checked here at runtime; structural
// privateContentKeys only follows explicit target markings and cannot recurse.
export function resolveReferencedWidget(entry, { navigation, tools, preferences = {}, hiddenKeys = [], today } = {}) {
  if (entry?.type !== 'widget' || ![NOTES_WIDGET_ID, SAVED_VIEW_WIDGET_ID].includes(entry.extensionId)) return { status: 'invalid', reason: 'unsupported-widget', rows: [] };
  try { validateWidgetConfig(entry.extensionId, entry.config); }
  catch { return { status: 'invalid', reason: 'invalid-config', rows: [] }; }
  const reference = widgetContentReference(entry);
  const hidden = preferences.presentation ? new Set([...privateContentKeys(navigation, preferences), ...hiddenKeys]) : new Set();
  if (hidden.has(`widget:${entry.id}`) || reference && hidden.has(reference.key)) return { status: 'hidden', reason: 'private-reference', rows: [] };
  if (!reference) return { status: 'unconfigured', reason: 'missing-reference', rows: [] };
  if (reference.kind === 'note') {
    const target = tools?.notes?.find((note) => note.id === reference.id);
    return target ? { status: 'ready', key: reference.key, target, rows: [] } : { status: 'missing', key: reference.key, reason: 'missing-note', rows: [] };
  }
  const target = preferences.library?.views?.find((view) => view.id === reference.id);
  if (!target) return { status: 'missing', key: reference.key, reason: 'missing-view', rows: [] };
  try { validateSavedView(target); }
  catch { return { status: 'invalid', key: reference.key, reason: 'invalid-view', rows: [] }; }
  const result = resolveSavedView(target, { navigation, tools, preferences, hiddenKeys: hidden, today });
  if (result.status !== 'ready') return { ...result, key: reference.key, rows: [] };
  return { ...result, key: reference.key, target };
}

// Restore/import maps contain only source targets actually carried across.
// An absent mapping is intentionally isolated, never rebound to a local target
// just because the same source ID exists on this device.
export function remapWidgetContentReferences(navigation, { noteIdMap = new Map(), viewIdMap = new Map(), importedWidgetIds,
  reservedNoteIds = [], reservedViewIds = [], makeId = () => crypto.randomUUID() } = {}) {
  const state = structuredClone(navigation), widgets = navigationResourceEntries(state);
  const selected = importedWidgetIds === undefined ? null : new Set(importedWidgetIds);
  const occupied = new Set([...reservedNoteIds, ...reservedViewIds, ...noteIdMap.values(), ...viewIdMap.values(),
    ...widgets.map((entry) => widgetContentReference(entry)?.id).filter(Boolean)]);
  const missing = new Map();
  const conflict = () => { throw Object.assign(Error(tr('恢复期间数据已更新，请重新预览。')), { code: 'REVISION_CONFLICT' }); };
  for (const entry of widgets) {
    const reference = widgetContentReference(entry);
    if (!reference || selected && !selected.has(entry.id)) continue;
    const mapping = reference.kind === 'note' ? noteIdMap : viewIdMap;
    let target = mapping.get(reference.id);
    if (target === undefined) {
      if (!missing.has(reference.key)) {
        for (let attempt = 0; attempt < 100; attempt++) {
          const candidate = `missing-${reference.kind}-${makeId()}`;
          if (validWidgetContentId(candidate) && !occupied.has(candidate)) { missing.set(reference.key, candidate); occupied.add(candidate); break; }
        }
        if (!missing.has(reference.key)) conflict();
      }
      target = missing.get(reference.key);
    }
    if (!validWidgetContentId(target)) conflict();
    entry.config = validateWidgetConfig(entry.extensionId, { ...entry.config, [reference.field]: target });
  }
  return state;
}
