// --generate only compiles assets and records digests. --check is for a later,
// explicitly requested release build; generation never invokes that path.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = 'wasm/tools-core/src/lib.rs', binary = 'src/wasm/tools-core.wasm';
const flags = ['--crate-name', 'covelet_tools_core', '--crate-type', 'cdylib', '--edition=2021', '--target', 'wasm32-unknown-unknown',
  '-C', 'opt-level=s', '-C', 'lto=fat', '-C', 'panic=abort', '-C', 'strip=symbols', '-C', 'codegen-units=1',
  '-C', 'link-arg=--initial-memory=1048576', '-C', 'link-arg=--max-memory=1048576', '-C', 'link-arg=-zstack-size=65536', '-C', 'link-arg=--stack-first'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const paths = [source, 'wasm/tools-core/Cargo.toml', 'scripts/build-tools-wasm.mjs'];
const mode = process.argv[2];
if (!['--generate', '--check'].includes(mode) || process.argv.length !== 3) throw Error('Usage: node scripts/build-tools-wasm.mjs --generate|--check');
async function sourceDigests() { return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, hash(await readFile(join(root, path)))]))); }
if (mode === '--check') {
  const metadata = JSON.parse(await readFile(join(root, 'wasm/tools-core/manifest.json'), 'utf8'));
  const bytes = await readFile(join(root, binary)), sources = await sourceDigests();
  if (metadata.abi !== 1 || metadata.compiler !== 'Rust 1.85.1' || metadata.target !== 'wasm32-unknown-unknown'
    || JSON.stringify(metadata.flags) !== JSON.stringify(flags) || metadata.bytes !== bytes.length || metadata.sha256 !== hash(bytes)
    || paths.some((path) => metadata.sources?.[path] !== sources[path])) throw Error('Tools WASM or source digests changed. Generate the packaged asset first.');
  console.log(`Packaged tools WASM digests match (${bytes.length} bytes).`);
} else {
const rustc = process.env.COVELET_RUSTC || (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Covelet/rust-build/rustup/toolchains/1.85.1-x86_64-pc-windows-msvc/bin/rustc.exe'));
if (!rustc) throw Error('Set COVELET_RUSTC to the installed Rust 1.85.1 compiler.');
await access(rustc);
await mkdir(join(root, 'src/wasm'), { recursive: true });
const result = spawnSync(rustc, [...flags, source, '-o', binary], { cwd: root, encoding: 'utf8', windowsHide: true });
if (result.status !== 0) throw Error(result.stderr || result.error?.message || 'WASM generation failed.');
const bytes = await readFile(join(root, binary));
const sources = await sourceDigests();
await writeFile(join(root, 'wasm/tools-core/manifest.json'), `${JSON.stringify({ abi: 1, compiler: 'Rust 1.85.1', target: 'wasm32-unknown-unknown', flags, bytes: bytes.length, sha256: hash(bytes), sources }, null, 2)}\n`);
console.log(`Generated packaged tools-core.wasm (${bytes.length} bytes). No validation was run.`);
}
