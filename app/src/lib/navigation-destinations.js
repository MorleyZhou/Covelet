import { tr } from '../i18n/index.js';

export function desktopDestinationValue(state, page) {
  return `page:${state.settings.desktopPages?.[page]?.id ?? page}`;
}

export function siteDestinationValue(state, site) {
  return site.parentId ? `folder:${site.parentId}` : desktopDestinationValue(state, site.page ?? 0);
}

export function navigationDestination(state, value, preferences) {
  const page = state.settings.pages.find((page) => desktopDestinationValue(state, page) === value);
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

export function appendSiteAt(state, site, target) {
  const order = state.entries.filter((item) => item.parentId === target.parentId).length;
  const entry = { ...site, ...target, order };
  delete entry.position;
  return { ...state, entries: [...state.entries, entry] };
}
