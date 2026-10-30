import { layoutDesktop } from './desktop-layout.js';
import { readCachedNavigationIcon } from './navigation-icon-cache.js';
import { siteIconAddress } from './site-icons.js';

// Warm only the first screen and its visible folder previews, while the
// navigation configuration is still loading. This never fetches a website.
export function initialNavigationIconSources(state) {
  const first = layoutDesktop(state.entries, state.settings.columns, null, state.settings.pages)[0];
  const sites = [];
  for (const entry of first?.items || []) {
    if (entry.type === 'site') sites.push(entry);
    else if (entry.type === 'folder') sites.push(...state.entries.filter((child) => child.parentId === entry.id)
      .sort((a, b) => a.order - b.order).slice(0, 9));
  }
  return [...new Set(sites.filter((entry) => entry.icon?.kind !== 'image').flatMap((entry) => [
    siteIconAddress(entry), entry.iconVariants?.light?.url, entry.iconVariants?.dark?.url,
  ]).filter(Boolean))].slice(0, 64);
}

export async function prepareNavigationIconCache(state) {
  await Promise.all(initialNavigationIconSources(state).map(readCachedNavigationIcon));
}
