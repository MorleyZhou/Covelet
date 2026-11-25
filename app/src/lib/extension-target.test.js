import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extensionBrowser, extensionDirectory, extensionOutputDirectory, extensionManifest } from '../../scripts/extension-target.mjs';
import { FIREFOX_DATA_COLLECTION_TYPES } from './firefox-data-consent.js';

const baseline = JSON.parse(readFileSync(new URL('../../extension.manifest.json', import.meta.url), 'utf8'));
test('Chrome target preserves its exact reviewed manifest and fixed extension identity path', () => {
  const result = extensionManifest(baseline, 'chrome');
  assert.deepEqual(result, baseline); assert.notEqual(result, baseline);
  assert.equal(extensionDirectory('chrome'), 'extension');
  assert.equal(extensionBrowser([]), 'chrome');
});
test('Firefox MV3 target only removes unavailable Chrome capabilities and substitutes event background', () => {
  const prior = structuredClone(baseline), result = extensionManifest(baseline, 'firefox');
  assert.deepEqual(baseline, prior);
  assert.equal(result.manifest_version, 3); assert.equal(result.version, baseline.version);
  assert.equal(result.minimum_chrome_version, undefined);
  assert.deepEqual(result.background, { scripts: ['background.js'], type: 'module' });
  assert.deepEqual(result.permissions, ['storage', 'search', 'activeTab', 'scripting', 'alarms']);
  assert(result.permissions.every(permission => baseline.permissions.includes(permission)));
  assert.deepEqual(result.host_permissions, ['https://www.bing.com/*']);
  assert.deepEqual(result.optional_host_permissions, baseline.optional_host_permissions);
  assert.deepEqual(result.content_security_policy, baseline.content_security_policy);
  assert.deepEqual(result.browser_specific_settings.gecko, { id: 'covelet@morleyzhou.github.io', strict_min_version: '140.0',
    data_collection_permissions: { required: ['none'], optional: [...FIREFOX_DATA_COLLECTION_TYPES] } });
  assert.equal(extensionDirectory('firefox'), 'extension-firefox');
});
test('browser selection is explicit and refuses conflicting or unsupported targets before building', () => {
  assert.equal(extensionBrowser(['--unpacked', '--browser', 'firefox']), 'firefox');
  assert.equal(extensionBrowser(['--browser=firefox']), 'firefox');
  for (const args of [['--browser'], ['--browser', '../../outside'], ['--browser=unknown'], ['--browser=chrome', '--browser=firefox']]) assert.throws(() => extensionBrowser(args));
  assert.throws(() => extensionDirectory('../../outside'));
  assert.throws(() => extensionManifest({ manifest_version: 2 }, 'firefox'));
});

test('browser-entry privileges stay optional on both targets without new required or host privileges', () => {
  assert.deepEqual(baseline.optional_permissions, ['tabs', 'history', 'bookmarks']);
  for (const browser of ['chrome', 'firefox']) {
    const manifest = extensionManifest(baseline, browser);
    assert.deepEqual(manifest.optional_permissions, ['tabs', 'history', 'bookmarks']);
    assert(manifest.permissions.every(permission => !['tabs', 'history', 'bookmarks', 'sessions', 'tabCapture', 'tabGroups'].includes(permission)));
    assert.deepEqual(manifest.host_permissions, ['https://www.bing.com/*']);
    assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  }
});

test('custom WXT modes cannot escape or overwrite the other browser output directory', () => {
  assert.equal(extensionOutputDirectory('chrome', 'production'), 'extension');
  assert.equal(extensionOutputDirectory('firefox', 'production'), 'extension-firefox');
  assert.equal(extensionOutputDirectory('firefox', 'development'), 'extension-firefox-dev');
  assert.equal(extensionOutputDirectory('firefox', 'qa-stage'), 'extension-firefox-qa-stage');
  for (const mode of ['../../extension', '../../../../outside', '..\\..\\extension', '/outside', 'C:\\outside', '', '__proto__', 'x'.repeat(65)]) {
    assert.throws(() => extensionOutputDirectory('firefox', mode));
  }
});
