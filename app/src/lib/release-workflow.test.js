import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const workflow = readFileSync(new URL('../../../.github/workflows/release-stores.yml', import.meta.url), 'utf8');
const blocks = [...workflow.matchAll(/node --input-type=module <<'NODE'\r?\n([\s\S]*?)^ {10}NODE\s*$/gmu)]
  .map(match => match[1].split(/\r?\n/u).map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n').replace(/^import .*;\n/gmu, ''));
assert.equal(blocks.length, 2, 'Both source-version and artifact-generation programs must remain tested.');
const version = '0.7.0', chromeName = `covelet-${version}.zip`, firefoxName = `covelet-${version}-firefox.zip`;
function fixture() {
  const chrome = { version, manifest_version: 3, background: { type: 'module', service_worker: 'background.js' } };
  const firefox = { version, manifest_version: 3, background: { type: 'module', scripts: ['background.js'] }, browser_specific_settings: { gecko: { id: 'covelet@morleyzhou.github.io' } } };
  const files = new Map(Object.entries({ 'app/package.json': JSON.stringify({ version }), 'app/extension.manifest.json': JSON.stringify(chrome),
    'app/package-lock.json': JSON.stringify({ version, packages: { '': { version } } }),
    'app/dist/extension/manifest.json': JSON.stringify(chrome), 'app/dist/extension-firefox/manifest.json': JSON.stringify(firefox),
    [`app/dist/${chromeName}`]: Buffer.from('Chrome ZIP fixture bytes'), [`app/dist/${firefoxName}`]: Buffer.from('Firefox ZIP fixture bytes'),
    [`docs/releases/${version}.md`]: '# Covelet 0.7.0\nRelease notes.',
  }));
  const read = (file, encoding) => { assert(files.has(file), `Missing fixture file ${file}`); const value = files.get(file); return encoding ? Buffer.from(value).toString(encoding) : Buffer.from(value); };
  const run = index => runInNewContext(blocks[index], { assert, createHash, readFileSync: read,
    statSync: file => ({ isFile: () => files.has(file), size: files.has(file) ? Buffer.byteLength(files.get(file)) : 0 }),
    writeFileSync: (file, value) => files.set(file, value), appendFileSync: (file, value) => files.set(file, (files.get(file) || '') + value),
    process: { env: { RELEASE_TAG: `v${version}`, GITHUB_OUTPUT: 'github-output' } }, console: { log() {} },
  });
  return { files, run };
}
const job = name => new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:\\r?$|(?![\\s\\S]))`, 'mu').exec(workflow)?.[1];

test('release generation computes both ZIP digests, exact paired manifest and browser-specific outputs', () => {
  const f = fixture(); f.run(0); f.run(1);
  const digest = name => createHash('sha256').update(f.files.get(`app/dist/${name}`)).digest('hex');
  assert.equal(f.files.get('app/dist/SHA256SUMS.txt'), `${digest(chromeName)}  ${chromeName}\n${digest(firefoxName)}  ${firefoxName}\n`);
  assert.match(f.files.get('github-output'), new RegExp(`firefox_zip_name=${firefoxName.replaceAll('.', '\\.')}\\nfirefox_sha=${digest(firefoxName)}\\n`, 'u'));
  assert(f.files.get('app/dist/release-notes.md').includes(chromeName)); assert(f.files.get('app/dist/release-notes.md').includes(firefoxName));
});

test('source package, manifest and both lockfile version fields must match the tag', () => {
  for (const file of ['app/package.json', 'app/extension.manifest.json', 'app/package-lock.json']) {
    const f = fixture(), value = JSON.parse(f.files.get(file)); value.version = '0.6.0'; f.files.set(file, JSON.stringify(value)); assert.throws(() => f.run(0));
  }
  const f = fixture(); f.files.set('app/package-lock.json', JSON.stringify({ version, packages: { '': { version: '0.6.0' } } })); assert.throws(() => f.run(0));
});

test('missing Firefox bytes, wrong Firefox version and cross-browser background profiles stop packaging', () => {
  for (const mutate of [files => files.delete(`app/dist/${firefoxName}`), files => files.set(`app/dist/${firefoxName}`, Buffer.alloc(0)),
    files => { const value = JSON.parse(files.get('app/dist/extension-firefox/manifest.json')); value.version = '0.6.0'; files.set('app/dist/extension-firefox/manifest.json', JSON.stringify(value)); },
    files => files.set('app/dist/extension-firefox/manifest.json', files.get('app/dist/extension/manifest.json'))]) {
    const f = fixture(); mutate(f.files); assert.throws(() => f.run(1)); assert.equal(f.files.has('app/dist/SHA256SUMS.txt'), false);
  }
});

test('one exact tag checkout builds both targets and GitHub publishes both browser ZIPs', () => {
  assert.equal((job('build').match(/uses: actions\/checkout@/gu) || []).length, 1);
  assert(job('build').includes('ref: refs/tags/${{ env.RELEASE_TAG }}'));
  for (const command of ['npm run build:extension', 'npm run build:firefox', 'npm run check:firefox']) assert(job('build').includes(command));
  assert.equal((job('github-release').match(/gh release (?:create|upload) "\$RELEASE_TAG" "\$ZIP_NAME" "\$FIREFOX_ZIP_NAME" SHA256SUMS\.txt/gu) || []).length, 2);
});

test('every artifact consumer checks exact two-line digest binding and both ZIP manifest profiles', () => {
  for (const name of ['github-release', 'chrome', 'edge']) {
    const body = job(name); assert(body, `Missing release job ${name}`);
    assert(body.includes("printf '%s  %s\\n%s  %s\\n'")); assert(body.includes('cmp -s - SHA256SUMS.txt'));
    assert(body.includes('sha256sum --check --strict SHA256SUMS.txt'));
    assert(body.includes('unzip -p "$ZIP_NAME" manifest.json')); assert(body.includes('unzip -p "$FIREFOX_ZIP_NAME" manifest.json'));
    assert(body.includes('covelet-${RELEASE_TAG#v}-firefox.zip')); assert(body.includes('.background.service_worker == "background.js"'));
    assert(body.includes('.background.scripts == ["background.js"]')); assert(body.includes('.version == $version'));
  }
  assert(!workflow.includes("printf '%s  %s\\n' \"$EXPECTED_SHA\" \"$ZIP_NAME\" | cmp -s - SHA256SUMS.txt"));
});

test('Chrome and Edge remain opt-in and upload only the original tagged Chrome ZIP', () => {
  assert.match(workflow, /submit_stores:[\s\S]*?default: false/u);
  for (const name of ['chrome', 'edge']) {
    const body = job(name); assert(body.includes("github.event_name == 'workflow_dispatch' && inputs.submit_stores == true"));
    assert(body.includes('ZIP_NAME: ${{ needs.github-release.outputs.zip_name }}'));
    assert.equal((body.match(/--data-binary "@\$\{ZIP_NAME\}"/gu) || []).length, 1);
    assert(!body.includes('--data-binary "@${FIREFOX_ZIP_NAME}"'));
  }
  assert(!job('chrome').includes('AMO_JWT')); assert(!job('edge').includes('AMO_JWT'));
});

test('AMO is independently opt-in with environment secrets confined to submission and immutable source', () => {
  const body = job('firefox'); assert(body);
  assert.match(workflow, /submit_firefox:[\s\S]*?default: false/u);
  assert(body.includes("github.event_name == 'workflow_dispatch' && inputs.submit_firefox == true"));
  assert(body.includes('environment: amo-addons'));
  assert(body.includes('inputs.firefox_source_ref || github.workflow_sha'));
  assert(body.includes('^[a-f0-9]{40}$'));
  assert(body.includes('prepare-firefox-amo-source.mjs'));
  assert(body.includes('submit-firefox-amo.mjs'));
  assert(body.includes('--source "$RUNNER_TEMP/amo-package/covelet-${RELEASE_TAG#v}-amo-source.zip"'));
  const build = body.slice(0, body.indexOf('- name: Upload and submit Firefox to AMO'));
  assert(!build.includes('secrets.AMO_JWT'), 'Build/install dependencies never receive signing credentials.');
  for (const secret of ['AMO_JWT_ISSUER', 'AMO_JWT_SECRET']) assert(body.includes(secret + ': ${{ secrets.' + secret + ' }}'));
  assert(body.includes('if: always()'));
});
