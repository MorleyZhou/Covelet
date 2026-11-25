import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';

export const AMO_DATA_TYPES = ['searchTerms', 'browsingActivity', 'websiteContent', 'authenticationInfo', 'personallyIdentifyingInfo', 'technicalAndInteraction'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function inspectAmoPackage(bytes, version) {
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  const files = unzipSync(bytes);
  assert(Object.keys(files).every(name => !name.startsWith('/') && !name.includes('\\') && !name.split('/').some(part => part === '..' || part === '.git')));
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  assert.equal(manifest.version, version); assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, { scripts: ['background.js'], type: 'module' });
  assert.deepEqual(manifest.permissions, ['storage', 'search', 'activeTab', 'scripting', 'alarms']);
  assert.deepEqual(manifest.optional_permissions, ['tabs', 'history', 'bookmarks']);
  assert.deepEqual(manifest.host_permissions, ['https://www.bing.com/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.browser_specific_settings.gecko.id, 'covelet@morleyzhou.github.io');
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '140.0');
  const consent = manifest.browser_specific_settings.gecko.data_collection_permissions;
  assert.deepEqual(consent?.required, ['none']);
  assert.deepEqual([...consent.optional].sort(), [...AMO_DATA_TYPES].sort());
  assert.equal(manifest.minimum_chrome_version, undefined);
  return manifest;
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) throw Error('Unable to prepare the exact committed AMO source.');
  return result.stdout.trim();
}
export function verifyPreparedAmo({ directory, version, sourceSha }) {
  const receipt = JSON.parse(readFileSync(path.join(directory, 'preparation.json'), 'utf8'));
  assert.equal(receipt.version, version); assert.equal(receipt.sourceSha, sourceSha);
  assert.equal(receipt.package.name, `covelet-${version}-firefox.zip`);
  assert.equal(receipt.source.name, `covelet-${version}-amo-source.zip`);
  const bytes = readFileSync(path.join(directory, receipt.package.name));
  const source = readFileSync(path.join(directory, receipt.source.name));
  const metadata = JSON.parse(readFileSync(path.join(directory, 'amo-metadata.json'), 'utf8'));
  assert.equal(digest(bytes), receipt.package.sha256); assert.equal(digest(source), receipt.source.sha256);
  assert.equal(digest(JSON.stringify(metadata)), receipt.metadataSha256);
  inspectAmoPackage(bytes, version);
  assert(source.length <= 200 * 1024 * 1024);
  const sources = unzipSync(source);
  assert(sources['.gitattributes'] && sources['app/src/lib/firefox-data-consent.js'] && sources['app/package-lock.json']);
  return receipt;
}
export function prepareAmoSource({ root, tag, outputDirectory }) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/u);
  root = realpathSync(root); outputDirectory = path.resolve(outputDirectory);
  const version = tag.slice(1), sourceSha = git(root, ['rev-parse', 'HEAD']);
  assert.match(sourceSha, /^[a-f\d]{40}$/u);
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=all']), '', 'AMO source must be committed and clean, including all build inputs.');
  for (const name of ['package.json', 'extension.manifest.json', 'package-lock.json']) {
    const value = JSON.parse(readFileSync(path.join(root, 'app', name), 'utf8'));
    assert.equal(value.version, version);
    if (name === 'package-lock.json') assert.equal(value.packages[''].version, version);
  }
  const zipName = `covelet-${version}-firefox.zip`, zipPath = path.join(root, 'app/dist', zipName);
  const packageBytes = readFileSync(zipPath), manifest = inspectAmoPackage(packageBytes, version);
  const metadata = JSON.parse(readFileSync(path.join(root, 'docs/store/firefox-amo.json'), 'utf8'));
  assert.equal(metadata.version.license, 'MIT');
  mkdirSync(outputDirectory, { recursive: true });
  const sourceName = `covelet-${version}-amo-source.zip`, sourcePath = path.join(outputDirectory, sourceName);
  git(root, ['archive', '--format=zip', `--output=${sourcePath}`, 'HEAD', '--', '.gitattributes', 'app', 'LICENSE', 'README.md', 'docs/store/firefox-amo-build.md', 'docs/store/firefox-amo.json']);
  const sourceBytes = readFileSync(sourcePath), sources = unzipSync(sourceBytes);
  assert(sourceBytes.length <= 200 * 1024 * 1024, 'AMO source archive exceeds its upload bound.');
  assert(sources['.gitattributes'] && sources['app/package-lock.json'] && sources['docs/store/firefox-amo-build.md'] && sources['app/src/lib/firefox-data-consent.js']);
  assert(Object.keys(sources).every(name => !/(?:^|\/)(?:node_modules|\.git|\.env(?:\.[^/]*)?|live-config\.local\.json)(?:\/|$)/u.test(name)), 'AMO source must not include local dependencies or credentials.');
  metadata.version.approval_notes = `${metadata.version.approval_notes || ''}\n\nRelease ${tag}; exact Firefox source commit ${sourceSha}. The existing release tag is not moved. Chrome/Edge continue using their original tagged package. Source rebuild instructions: docs/store/firefox-amo-build.md.`.trim();
  copyFileSync(zipPath, path.join(outputDirectory, zipName));
  writeFileSync(path.join(outputDirectory, 'amo-metadata.json'), JSON.stringify(metadata, null, 2));
  const receipt = { version, releaseTag: tag, sourceSha, geckoId: manifest.browser_specific_settings.gecko.id,
    package: { name: zipName, sha256: digest(packageBytes), bytes: packageBytes.length }, source: { name: sourceName, sha256: digest(sourceBytes), bytes: sourceBytes.length },
    metadataSha256: digest(JSON.stringify(metadata)), dataCollection: manifest.browser_specific_settings.gecko.data_collection_permissions };
  writeFileSync(path.join(outputDirectory, 'preparation.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    assert(['--root', '--tag', '--output-dir', '--verify-prepared'].includes(args[index]) && args[index + 1], 'Expected --root, --tag and --output-dir or --verify-prepared.');
    assert(!Object.hasOwn(options, args[index]), 'Duplicate AMO source argument.'); options[args[index]] = args[index + 1];
  }
  assert.match(options['--tag'] || '', /^v\d+\.\d+\.\d+$/u);
  const receipt = options['--verify-prepared']
    ? verifyPreparedAmo({ directory: options['--verify-prepared'], version: options['--tag'].slice(1), sourceSha: git(realpathSync(options['--root']), ['rev-parse', 'HEAD']) })
    : prepareAmoSource({ root: options['--root'], tag: options['--tag'], outputDirectory: options['--output-dir'] });
  console.log(JSON.stringify(receipt));
}
