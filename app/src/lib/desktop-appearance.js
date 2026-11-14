import { tr } from '../i18n/index.js';
import { migrateNavigationState, validateDesktopAppearance } from './model.js';
import { logicalDesktopPages, withDesktopPageIdentity } from './desktop-pages.js';
import { loadState, saveState } from './storage.js';
import { sameJson } from './json-equal.js';

const fields = ['background', 'shade', 'blur'];
const changed = () => Object.assign(Error(tr('这一屏已发生变化，请重新打开屏幕管理。')), { code: 'REVISION_CONFLICT' });

// Render-only resolution. Overflow parts use their original logical page;
// omitted fields remain live inheritance rather than copied global values.
export function effectiveDesktopAppearance(settings, page) {
  const override = settings.desktopPages?.[page]?.appearance;
  return { background: structuredClone(override?.background ?? settings.background),
    shade: override?.shade ?? settings.shade, blur: override?.blur ?? settings.blur };
}

export function prepareDesktopAppearance(input, originalDesktopId, patch, { expectedNavigationRevision, page } = {}) {
  const state = migrateNavigationState(input);
  if (!Number.isSafeInteger(expectedNavigationRevision) || expectedNavigationRevision < 0 || state.revision !== expectedNavigationRevision) throw changed();
  const known = Object.entries(state.settings.desktopPages || {}).find(([, metadata]) => metadata.id === originalDesktopId);
  if (originalDesktopId !== null && (typeof originalDesktopId !== 'string' || !known)) throw changed();
  const targetPage = known ? Number(known[0]) : page;
  if (!Number.isSafeInteger(targetPage) || !logicalDesktopPages(state).includes(targetPage)
    || originalDesktopId === null && state.settings.desktopPages?.[targetPage]) throw changed();
  if (patch !== null && (!patch || typeof patch !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(patch))
    || Object.keys(patch).some((key) => !fields.includes(key)))) throw changed();
  const before = state.settings.desktopPages?.[targetPage]?.appearance || {}, next = structuredClone(before);
  if (patch === null) for (const key of fields) delete next[key];
  else for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = structuredClone(value);
  }
  const checked = validateDesktopAppearance(next);
  if (sameJson(before, checked)) return { state, desktopId: originalDesktopId, page: targetPage, changed: false, sourceRevision: input.revision };
  state.settings = withDesktopPageIdentity(state.settings, targetPage);
  const metadata = state.settings.desktopPages[targetPage];
  if (Object.keys(checked).length) metadata.appearance = checked;
  else delete metadata.appearance;
  return { state: migrateNavigationState(state), desktopId: metadata.id, page: targetPage, changed: true, sourceRevision: input.revision };
}

// The UI can also use the pure preparation with its demo preference adapter.
// Capture input before awaiting a read; saveState supplies the final locked CAS.
export async function saveDesktopAppearance(originalDesktopId, patch, { expectedNavigationRevision, page } = {}) {
  const held = structuredClone(patch), state = await loadState();
  const prepared = prepareDesktopAppearance(state, originalDesktopId, held, { expectedNavigationRevision, page });
  if (!prepared.changed) return prepared;
  return { ...prepared, state: await saveState(prepared.state, expectedNavigationRevision) };
}
