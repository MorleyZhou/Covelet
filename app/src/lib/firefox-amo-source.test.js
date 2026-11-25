import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { inspectAmoPackage, prepareAmoSource, verifyPreparedAmo, AMO_DATA_TYPES } from '../../scripts/prepare-firefox-amo-source.mjs';

function manifest() { return { version: '0.7.0', manifest_version: 3,
  background: { scripts: ['background.js'], type: 'module' }, permissions: ['storage', 'search', 'activeTab', 'scripting', 'alarms'],
  optional_permissions: ['tabs', 'history', 'bookmarks'], host_permissions: ['https://www.bing.com/*'], optional_host_permissions: ['http://*/*', 'https://*/*'],
  browser_specific_settings: { gecko: { id: 'covelet@morleyzhou.github.io', strict_min_version: '140.0', data_collection_permissions: { required: ['none'], optional: [...AMO_DATA_TYPES] } } } }; }
const archive = (value, extra = {}) => zipSync({ 'manifest.json': strToU8(JSON.stringify(value)), ...extra });
test('AMO candidate binds Firefox version, background, identity and existing capability scope', () => {
  const value = manifest(); assert.deepEqual(inspectAmoPackage(archive(value), '0.7.0'), value);
  for (const mutate of [value => value.version = '0.6.0', value => value.background = { service_worker: 'background.js', type: 'module' },
    value => value.permissions.push('history'), value => value.host_permissions.push('https://example.com/*'), value => value.browser_specific_settings.gecko.id = 'other@example.com']) {
    const value = manifest(); mutate(value); assert.throws(() => inspectAmoPackage(archive(value), '0.7.0'));
  }
});
test('AMO rejects missing data declarations, extra required data and absent optional purposes', () => {
  for (const mutate of [value => delete value.browser_specific_settings.gecko.data_collection_permissions,
    value => value.browser_specific_settings.gecko.data_collection_permissions.required.push('browsingActivity'),
    value => value.browser_specific_settings.gecko.data_collection_permissions.optional.pop(),
    value => value.browser_specific_settings.gecko.data_collection_permissions.optional.push('websiteActivity')]) {
    const value = manifest(); mutate(value); assert.throws(() => inspectAmoPackage(archive(value), '0.7.0'));
  }
});
test('AMO candidates refuse unsafe archive paths and malformed requested versions', () => {
  for (const name of ['../unexpected.js', '/unexpected.js', '.git/config', 'a\\unexpected.js']) assert.throws(() => inspectAmoPackage(archive(manifest(), { [name]: strToU8('test') }), '0.7.0'));
  assert.throws(() => inspectAmoPackage(archive(manifest()), '../0.7.0'));
});

test('committed reviewer source retains line-ending rules and exactly recovers the original payload', async t => {
  const stable = path.resolve(fileURLToPath(new URL('../../../output/playwright/', import.meta.url)));
  await mkdir(stable, { recursive: true }); const temporary = await mkdtemp(path.join(stable, '.amo-source-'));
  t.after(async () => { assert.equal(path.dirname(temporary), stable); await rm(temporary, { recursive: true, force: true }); });
  const root = path.join(temporary, 'repo'), directory = path.join(temporary, 'payload'); await mkdir(root);
  const git = args => { const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(['init', '--quiet']);
  const files = { '.gitattributes': '*.rs text eol=lf\n', '.gitignore': 'app/dist/\n', LICENSE: 'MIT\n', 'README.md': '# Test source\n',
    'app/package.json': JSON.stringify({ version: '0.7.0' }), 'app/extension.manifest.json': JSON.stringify({ version: '0.7.0' }),
    'app/package-lock.json': JSON.stringify({ version: '0.7.0', packages: { '': { version: '0.7.0' } } }),
    'app/src/lib/firefox-data-consent.js': 'export const localOnly = true;\n', 'docs/store/firefox-amo-build.md': 'Build from the exact commit.\n',
    'docs/store/firefox-amo.json': JSON.stringify({ addon: {}, version: { license: 'MIT' } }) };
  for (const [name, contents] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), contents); }
  git(['add', '.']); git(['-c', 'commit.gpgsign=false', '-c', 'user.name=Covelet Test', '-c', 'user.email=covelet-test@example.invalid', 'commit', '--quiet', '-m', 'source fixture']);
  await mkdir(path.join(root, 'app/dist'));
  await writeFile(path.join(root, 'app/dist/covelet-0.7.0-firefox.zip'), archive(manifest()));
  const prepared = prepareAmoSource({ root, tag: 'v0.7.0', outputDirectory: directory });
  const sources = unzipSync(await readFile(path.join(directory, prepared.source.name)));
  assert(sources['.gitattributes']); assert(sources['app/package-lock.json']); assert(!Object.keys(sources).some(name => name.startsWith('app/dist/')));
  assert.deepEqual(verifyPreparedAmo({ directory, version: '0.7.0', sourceSha: git(['rev-parse', 'HEAD']) }), prepared);
  assert.throws(() => verifyPreparedAmo({ directory, version: '0.7.0', sourceSha: 'a'.repeat(40) }));
  await writeFile(path.join(directory, 'amo-metadata.json'), JSON.stringify({ changed: true }));
  assert.throws(() => verifyPreparedAmo({ directory, version: '0.7.0', sourceSha: prepared.sourceSha }));
  await writeFile(path.join(root, 'app/src/new-uncommitted-input.js'), 'export const unexpected = true;');
  assert.throws(() => prepareAmoSource({ root, tag: 'v0.7.0', outputDirectory: directory }));
});
