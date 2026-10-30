import test from 'node:test';
import assert from 'node:assert/strict';
import { initialNavigationIconSources } from './navigation-icon-startup.js';

const site = (id, extra = {}) => ({ id, type: 'site', parentId: null, order: 0, page: 0,
  url: `https://${id}.example/`, iconUrl: `https://icons.example/${id}.png`, ...extra });

test('startup warms the first screen and the nine displayed folder previews, including theme variants', () => {
  const children = Array.from({ length: 11 }, (_, index) => site(`child-${index}`, { parentId: 'folder', order: 10 - index }));
  const state = { settings: { columns: 8, pages: [0, 1] }, entries: [
    site('primary', { iconVariants: { light: { url: 'https://icons.example/light.png' }, dark: { url: 'https://icons.example/dark.png' } } }),
    { id: 'folder', type: 'folder', parentId: null, page: 0, order: 1 }, ...children,
    site('legacy-asset', { order: 2, icon: { kind: 'image', value: 'local-image-id' } }),
    site('second-page', { page: 1 }), site('detached', { detached: true }),
  ] };
  const sources = initialNavigationIconSources(state);
  assert.deepEqual(sources.slice(0, 3), ['https://icons.example/primary.png', 'https://icons.example/light.png', 'https://icons.example/dark.png']);
  assert.equal(sources.length, 12);
  assert(sources.includes('https://icons.example/child-10.png'));
  assert(!sources.includes('https://icons.example/child-0.png'));
  assert(!sources.some((url) => /second-page|detached|legacy-asset/.test(url)));
});

test('an intentionally empty first screen does not preload a later page', () => {
  assert.deepEqual(initialNavigationIconSources({ settings: { columns: 8, pages: [0, 1] }, entries: [site('later', { page: 1 })] }), []);
});
