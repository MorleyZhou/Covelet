import { formatNumber, tr } from '../i18n/index.js';

export function logicalDesktopPages(state) {
  return [...new Set([...state.settings.pages, ...state.entries
    .filter((entry) => entry.parentId === null && !entry.detached)
    .map((entry) => entry.page ?? 0)])].sort((left, right) => left - right);
}

export function desktopPageName(settings, page) {
  return settings.desktopPages?.[page]?.name || tr('第 {0} 屏', [formatNumber(page + 1)]);
}

export function defaultDesktopPage(state, id) {
  const selected = Object.entries(state.settings.desktopPages ?? {}).find(([, metadata]) => metadata.id === id);
  return selected ? Number(selected[0]) : logicalDesktopPages(state)[0];
}

export function namedDesktopRecords(settings) {
  return Object.entries(settings.desktopPages ?? {}).filter(([, value]) => value.name)
    .map(([page, value]) => ({ id: value.id, page: Number(page), title: value.name }));
}

// Only the original screen keeps its metadata when an edit promotes temporary
// overflow screens to separate pages.
export function remapDesktopPages(settings, mapping) {
  const pages = {};
  for (const [from, to] of mapping) {
    if (settings.desktopPages?.[from]) pages[to] = settings.desktopPages[from];
  }
  if (Object.keys(pages).length) settings.desktopPages = pages;
  else delete settings.desktopPages;
}

export function withDesktopPageIdentity(settings, page) {
  if (settings.desktopPages?.[page]) return settings;
  return { ...settings, pages: [...new Set([...settings.pages, page])].sort((left, right) => left - right),
    desktopPages: { ...settings.desktopPages, [page]: { id: crypto.randomUUID() } } };
}
