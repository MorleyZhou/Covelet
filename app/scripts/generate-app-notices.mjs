import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Read the installed production dependency graph, never package install scripts.
// Vite can tree-shake some reachable modules; retaining their notices is deliberate.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(app, 'public', 'APP_TOOL_LICENSES.txt');
const roots = ['pdf-lib', 'pdfjs-dist', 'yaml', 'prettier', 'sql-formatter', 'react-markdown', 'remark-gfm'];
const packageJSON = JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8'));
const visited = new Map(), byVersion = new Map(), excludedTypes = new Set(), absentOptional = new Set();
const noticeName = /^(?:licen[cs]e|copying|copyright|notice|third[- _]party[- _]notices?)(?:[._ -].*)?$/i;
const readJSON = async (filename) => JSON.parse(await fs.readFile(filename, 'utf8'));
const normalize = (text) => text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').trimEnd();

async function resolvePackage(name, from) {
  // Resolving package.json through exports fails for several ESM-only packages.
  // Node's real search paths still identify the installed package at each edge.
  const require = createRequire(path.join(from, 'package.json'));
  for (const search of require.resolve.paths(name) || []) {
    const filename = path.join(search, name, 'package.json');
    try { return await fs.realpath(filename); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  return null;
}

async function packageNotices(directory, pkg) {
  const files = [], seen = new Set(); let examined = 0;
  async function visit(current, depth) {
    if (depth > 8 || ++examined > 15000) throw Error(`Notice scan exceeded its bound: ${directory}`);
    const real = await fs.realpath(current); if (seen.has(real)) return; seen.add(real);
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'coverage', '.cache'].includes(entry.name)) await visit(filename, depth + 1);
      } else if (entry.isFile() && noticeName.test(entry.name)) {
        const stat = await fs.stat(filename); if (stat.size > 10 * 1024 * 1024) throw Error(`Notice file is unexpectedly large: ${filename}`);
        const text = normalize(await fs.readFile(filename, 'utf8'));
        if (text.includes('\0') || !text.trim()) throw Error(`Notice file is not readable text: ${filename}`);
        files.push({ name: path.relative(directory, filename).split(path.sep).join('/'), text });
      }
    }
  }
  await visit(directory, 0);
  // Some older packages (for example railroad-diagrams) publish their original
  // dedication as a source header instead of a separate LICENSE file. Copy the
  // installed header verbatim rather than manufacturing a license from metadata.
  if (!files.length) for (const entry of [...new Set([pkg.main, pkg.module, 'index.js', 'index.mjs'].filter((value) => typeof value === 'string'))]) {
    const filename = path.resolve(directory, entry);
    if (!filename.startsWith(directory + path.sep)) continue;
    let source; try { source = await fs.readFile(filename, 'utf8'); } catch (error) { if (['ENOENT', 'EISDIR'].includes(error.code)) continue; throw error; }
    const header = source.match(/^\s*(\/\*[\s\S]*?\*\/)/)?.[1];
    if (header && /licen[cs]e|public.?domain|copyright/i.test(header)) {
      files.push({ name: `${entry} (original leading notice)`, text: normalize(header) }); break;
    }
  }
  if (!files.length) throw Error(`No installed license or notice text found for ${directory}; do not invent one.`);
  return files;
}

async function collect(name, from, requiredBy, optional = false) {
  // PDF rendering runs in Chromium's Canvas, not PDF.js's optional Node.js
  // native addon. No native canvas entry or binary is included in this bundle.
  if (optional && name === '@napi-rs/canvas' && requiredBy.startsWith('pdfjs-dist@')) return;
  // Type declarations do not execute and are not included in the browser bundle.
  if (name.startsWith('@types/')) { excludedTypes.add(name); return; }
  const filename = await resolvePackage(name, from);
  if (!filename) {
    if (optional) { absentOptional.add(`${requiredBy} -> ${name}`); return; }
    throw Error(`Required installed dependency is missing: ${requiredBy} -> ${name}`);
  }
  const already = visited.get(filename);
  if (already) { already.requiredBy.add(requiredBy); return; }
  const pkg = await readJSON(filename);
  if (!pkg.name || !pkg.version) throw Error(`Installed package has no name/version: ${filename}`);
  const directory = path.dirname(filename), files = await packageNotices(directory, pkg);
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || (Array.isArray(pkg.licenses) ? pkg.licenses.map((item) => item.type).join(' OR ') : 'not declared in package metadata');
  const contentHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const id = `${pkg.name}@${pkg.version}`, previous = byVersion.get(id);
  if (previous && previous.contentHash !== contentHash) throw Error(`Installed copies have different notices for ${id}; review them before packaging.`);
  const record = previous || { name: pkg.name, version: pkg.version, license, files, contentHash, requiredBy: new Set(),
    repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '', homepage: pkg.homepage || '' };
  record.requiredBy.add(requiredBy); visited.set(filename, record); byVersion.set(id, record);
  const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies };
  for (const child of Object.keys(dependencies).sort()) await collect(child, directory, id, Object.hasOwn(pkg.optionalDependencies || {}, child));
  // Runtime peers (notably React) resolve at this installed package's location.
  for (const child of Object.keys(pkg.peerDependencies || {}).sort()) {
    if (Object.hasOwn(dependencies, child)) continue;
    await collect(child, directory, id, pkg.peerDependenciesMeta?.[child]?.optional === true);
  }
}

for (const name of roots) {
  if (!Object.hasOwn(packageJSON.dependencies || {}, name)) throw Error(`Notice root is not a production dependency: ${name}`);
  await collect(name, app, 'Covelet app tools');
}
const records = [...byVersion.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'));
const lines = [
  'Covelet app tools - installed third-party license and notice texts',
  '',
  'Generated by scripts/generate-app-notices.mjs from installed node_modules.',
  'No license text below is synthesized from an SPDX identifier.',
  'Scope: the installed dependency and runtime-peer graph reachable from:',
  ...roots.map((name) => `  - ${name}`),
  '',
  'Development-only dependencies are not traversed. Type-only @types packages are excluded.',
  'Installed optional runtime dependencies are included. Uninstalled optional dependencies are listed below.',
  'PDF.js optional @napi-rs/canvas is Node-only and excluded from the Chromium application and this graph.',
  'The graph may include modules removed by production tree-shaking; their notices are retained.',
  'Bundled upstream notices (including Prettier THIRD-PARTY-NOTICES.md) are copied in full.',
  'Existing UI/framework and icon notices remain in THIRD_PARTY_NOTICES.txt and UI_LICENSES.txt.',
  '',
  `Installed package versions: ${records.length}`,
  ...records.map((record) => `  ${record.name}@${record.version} - ${record.license}`),
  '',
  'Excluded type declaration packages:',
  ...[...excludedTypes].sort().map((name) => `  ${name}`),
  '',
  'Optional dependencies not installed:',
  ...(absentOptional.size ? [...absentOptional].sort().map((edge) => `  ${edge}`) : ['  None']),
  '',
];
for (const record of records) {
  lines.push('='.repeat(78), `${record.name}@${record.version}`, `Declared license: ${record.license}`, `Required by: ${[...record.requiredBy].sort().join(', ')}`);
  if (record.homepage) lines.push(`Homepage: ${record.homepage}`);
  if (record.repository) lines.push(`Repository: ${record.repository}`);
  lines.push('');
  for (const file of record.files) lines.push(`--- Installed file: ${record.name}/${file.name} ---`, '', file.text, '');
}
const text = `${lines.join('\n')}\n`;
if (process.argv.includes('--check')) {
  if (await fs.readFile(output, 'utf8') !== text) throw Error('APP_TOOL_LICENSES.txt is stale. Run node scripts/generate-app-notices.mjs.');
  console.log(`App tool notices match ${records.length} installed package versions.`);
} else {
  await fs.writeFile(output, text, 'utf8');
  console.log(`Wrote ${path.relative(app, output)}: ${records.length} installed package versions, ${Buffer.byteLength(text)} bytes.`);
}
