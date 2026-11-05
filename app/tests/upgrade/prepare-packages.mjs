import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

export const packageRoot = fileURLToPath(new URL('../../../output/playwright/covelet/upgrade-packages/', import.meta.url));
export const packages = Object.freeze({
  old: { version: '0.2.2', sha256: '707e9c38582b424cd9a53c4a21886400fbb4d4865a44fc3ddd4ce86d64e2710d' },
  release: { version: '0.3.0', sha256: 'e945c2aebe59c38ce2257732a7c3f615581ad0963c93d23294a8f4e73d253f7a' },
});
export function packageDirectory(kind) {
  const info = packages[kind];
  assert(info, 'Unknown upgrade package');
  return resolve(packageRoot, info.version + '-' + info.sha256.slice(0, 12));
}
export function preparePackage(kind) {
  const info = packages[kind], filename = 'covelet-' + info.version + '.zip';
  mkdirSync(packageRoot, { recursive: true });
  assert(!lstatSync(packageRoot).isSymbolicLink(), 'Package cache cannot be a symlink');
  const archive = resolve(packageRoot, filename);
  if (!existsSync(archive)) {
    execFileSync('gh', ['release', 'download', 'v' + info.version, '--repo', 'MorleyZhou/Covelet',
      '--dir', packageRoot, '--pattern', filename], { stdio: 'inherit', windowsHide: true });
  }
  assert(!lstatSync(archive).isSymbolicLink(), 'Package cannot be a symlink');
  const bytes = readFileSync(archive);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), info.sha256,
    'Historical release archive changed. Inspect provenance before updating its pinned digest.');
  const files = unzipSync(bytes), target = packageDirectory(kind);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.equal(manifest.version, info.version);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Covelet');
  mkdirSync(target, { recursive: true });
  assert(!lstatSync(target).isSymbolicLink());
  const listFiles = (directory, prefix = '') => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    assert(!entry.isSymbolicLink(), 'Historical package cache cannot contain links');
    const name = prefix + entry.name;
    if (entry.isDirectory()) return listFiles(resolve(directory, entry.name), name + '/');
    assert(entry.isFile(), 'Historical package must contain regular files');
    return [name];
  });
  listFiles(target);
  for (const [name, contents] of Object.entries(files)) {
    assert(!name.includes('\\') && !name.split('/').includes('..') && !name.startsWith('/'), 'Unsafe ZIP path');
    const path = resolve(target, name), inside = relative(target, path);
    assert(inside && !inside.startsWith('..' + sep) && !inside.startsWith(sep));
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      assert(!lstatSync(path).isSymbolicLink());
      assert.deepEqual(readFileSync(path), Buffer.from(contents), 'Cached historical package differs: ' + name);
    } else writeFileSync(path, contents);
  }
  assert.deepEqual(listFiles(target).sort(), Object.keys(files).sort(), 'Historical package cache has unexpected files');
  console.log('Verified upgrade package ' + filename + ' SHA256 ' + info.sha256);
  return target;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  preparePackage('old');
  if (process.argv.includes('--release')) preparePackage('release');
}
