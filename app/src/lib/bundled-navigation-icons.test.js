import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLegacySeedNavigation } from '../../tests/fixtures/navigation-state.mjs';
import { validateIconBytes } from './site-info.js';
import { BUNDLED_NAVIGATION_ICONS, bundledNavigationIconAddress } from './bundled-navigation-icons.js';

const id = 'a'.repeat(32), api = { runtime: { id, getURL: path => `chrome-extension://${id}/${path}` } };

test('all six historical seed icon sources retain valid packaged original images', () => {
  const defaults = createLegacySeedNavigation().entries;
  assert.equal(defaults.length, 6);
  assert.equal(Object.keys(BUNDLED_NAVIGATION_ICONS).length, 6);
  for (const entry of defaults) {
    const file = BUNDLED_NAVIGATION_ICONS[entry.iconUrl];
    assert(file, `${entry.name} is missing its packaged icon`);
    const bytes = new Uint8Array(readFileSync(new URL(`../../public/assets/default-sites/${file}`, import.meta.url)));
    validateIconBytes(bytes, file.endsWith('.webp') ? 'image/webp' : 'image/png');
    assert.equal(bundledNavigationIconAddress(entry.iconUrl, api), `chrome-extension://${id}/assets/default-sites/${file}`);
  }
});

test('bundled seeds do not match custom paths, query strings, lookalike domains or unsafe runtimes', () => {
  const source = createLegacySeedNavigation().entries[0].iconUrl;
  for (const custom of [source + '?custom=1', 'https://www.google.com/favicon.ico', source.replace('www.google.com', 'www.google.com.evil.example'), 'javascript:alert(1)']) {
    assert.equal(bundledNavigationIconAddress(custom, api), '');
  }
  assert.equal(bundledNavigationIconAddress(source, {}), '');
  assert.equal(bundledNavigationIconAddress(source, { runtime: { id, getURL: () => 'https://www.google.com/logo.png' } }), '');
});
