import { createEmptyState, letterIcon, validateState } from '../../src/lib/model.js';

// Explicit user-configured content for layout/recovery tests. Product startup
// is empty; these synthetic URLs must never be inferred as installation seeds.
export function createConfiguredNavigation() {
  const state = createEmptyState();
  state.entries = ['Google', 'YouTube', 'GitHub', 'X', 'ChatGPT', 'Grok'].map((name, order) => ({
    id: `default-${name.toLowerCase()}`, type: 'site', name,
    url: `https://configured.example/${name.toLowerCase()}/`,
    groupId: 'group-home', parentId: null, page: 0, icon: letterIcon(name), order,
  }));
  return validateState(state);
}

// Exact historical v0.2.2 installation data, independent of the current factory.
export function createLegacySeedNavigation() {
  const state = createEmptyState();
  state.entries = [
    ['google', 'Google', 'https://www.google.com/', 'https://www.google.com/images/branding/googleg/2x/googleg_standard_color_128dp.png'],
    ['youtube', 'YouTube', 'https://www.youtube.com/', 'https://www.youtube.com/s/desktop/2fe123f7/img/favicon_144x144.png'],
    ['github', 'GitHub', 'https://github.com/', 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'],
    ['x', 'X', 'https://x.com/', 'https://abs.twimg.com/responsive-web/client-web/icon-default-large.9ab12c3ecc9e8133a.png'],
    ['chatgpt', 'ChatGPT', 'https://chatgpt.com/', 'https://cdn.oaistatic.com/assets/apple-touch-icon-mz9nytnj.webp'],
    ['grok', 'Grok', 'https://grok.com/', 'https://grok.com/images/android-chrome-monochrome-512x512.png'],
  ].map(([id, name, url, iconUrl], order) => ({ id: `default-${id}`, type: 'site', name, url,
    groupId: 'group-home', parentId: null, page: 0, icon: letterIcon(name), iconUrl, order }));
  return validateState(state);
}
