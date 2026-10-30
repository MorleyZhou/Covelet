import { normalizeIconAddress } from './site-icons.js';

// Exact, reviewed source addresses only. Never infer a brand from a hostname,
// entry ID, custom icon path, query string, or the name of a saved website.
export const BUNDLED_NAVIGATION_ICONS = Object.freeze({
  'https://www.google.com/images/branding/googleg/2x/googleg_standard_color_128dp.png': 'google.png',
  'https://www.youtube.com/s/desktop/2fe123f7/img/favicon_144x144.png': 'youtube.png',
  'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png': 'github.png',
  'https://abs.twimg.com/responsive-web/client-web/icon-default-large.9ab12c3ecc9e8133a.png': 'x.png',
  'https://cdn.oaistatic.com/assets/apple-touch-icon-mz9nytnj.webp': 'chatgpt.webp',
  'https://grok.com/images/android-chrome-monochrome-512x512.png': 'grok.png',
});

export function bundledNavigationIconAddress(input, api = globalThis.chrome) {
  try {
    const file = BUNDLED_NAVIGATION_ICONS[normalizeIconAddress(input)];
    if (!file || !api?.runtime?.id || typeof api.runtime.getURL !== 'function') return '';
    const path = `assets/default-sites/${file}`, url = new URL(api.runtime.getURL(path));
    return url.protocol === 'chrome-extension:' && url.host === api.runtime.id && url.pathname === `/${path}`
      && !url.search && !url.hash ? url.href : '';
  } catch { return ''; }
}
