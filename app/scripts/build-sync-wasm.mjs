import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, access, copyFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binaryPath = join(app, 'src/wasm/sync-core.wasm')
const metadataPath = join(app, 'wasm/sync-core/manifest.json')
const sourcePaths = ['wasm/sync-core/Cargo.toml', 'wasm/sync-core/Cargo.lock', 'wasm/sync-core/src/lib.rs', 'scripts/build-sync-wasm.mjs']
const expectedCompiler = 'rustc 1.85.1 (4eb161250 2025-03-15)'
const target = 'wasm32-unknown-unknown'
const memoryBytes = 2097152
const flags = [
  '-C', 'link-arg=--initial-memory=2097152', '-C', 'link-arg=--max-memory=2097152',
  '-C', 'link-arg=-zstack-size=65536', '-C', 'link-arg=--stack-first',
  '--remap-path-prefix', `${app}=covelet`,
]
// Only the source-path remapping argument varies by checkout location. The
// normalized manifest records the same reviewable flags on every machine.
const recordedFlags = flags.map(value => value === `${app}=covelet` ? '<app>=covelet' : value)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function sourceChecksums() {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha256(await readFile(join(app, path)))])))
}

function inspect(bytes) {
  if (bytes.length > 64 * 1024) throw new Error('Sync WASM exceeds its 64 KiB code budget.')
  const module = new WebAssembly.Module(bytes)
  if (WebAssembly.Module.imports(module).length) throw new Error('Sync WASM must have no host, network or runtime imports.')
  const instance = new WebAssembly.Instance(module)
  for (const name of ['memory', 'abi_version', 'max_input_bytes', 'max_key_bytes', 'input_ptr', 'key_ptr', 'output_ptr', 'sha256_hash', 'hmac_sha256', 'sync_plan']) {
    if (!(name in instance.exports)) throw new Error(`Missing sync WASM ABI export: ${name}`)
  }
  const api = instance.exports
  if (api.abi_version() !== 1 || api.max_input_bytes() !== 1048576 || api.max_key_bytes() !== 512) throw new Error('Sync WASM ABI or limits differ from the reviewed configuration.')
  if (api.memory.buffer.byteLength !== memoryBytes) throw new Error('Sync WASM must use fixed 2 MiB memory.')
  try { api.memory.grow(1); throw new Error('Sync WASM memory unexpectedly grew.') } catch (error) {
    if (!(error instanceof RangeError)) throw error
  }
}

async function check() {
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  const checksums = await sourceChecksums()
  for (const path of sourcePaths) if (metadata.sources?.[path] !== checksums[path]) throw new Error(`Sync WASM source changed: ${path}. Run node scripts/build-sync-wasm.mjs --rebuild.`)
  if (metadata.compiler !== expectedCompiler || metadata.target !== target || JSON.stringify(metadata.flags) !== JSON.stringify(recordedFlags)) {
    throw new Error('Sync WASM metadata differs from the pinned reproducible build configuration.')
  }
  const bytes = await readFile(binaryPath)
  if (metadata.sha256 !== sha256(bytes) || metadata.bytes !== bytes.length) throw new Error('Packaged sync WASM checksum mismatch. Rebuild from the checked-in source and Cargo.lock.')
  inspect(bytes)
  console.log(`Sync WASM verified: ${bytes.length} bytes, SHA-256 ${metadata.sha256}, ABI 1, no imports, fixed 2 MiB memory.`)
}

async function compiler() {
  const cache = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Covelet/rust-build/rustup/toolchains/1.85.1-x86_64-pc-windows-msvc/bin/rustc.exe') : null
  for (const candidate of [process.env.COVELET_RUSTC, cache, 'rustc'].filter(Boolean)) {
    if (candidate !== 'rustc') { try { await access(candidate, constants.X_OK) } catch { continue } }
    const version = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true })
    if (version.status !== 0 || version.stdout.trim() !== expectedCompiler) continue
    const result = spawnSync(candidate, ['--print', 'target-libdir', '--target', target], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) continue
    try { await access(result.stdout.trim()) } catch { continue }
    return candidate
  }
  throw new Error('Rebuilding sync WASM requires Rust 1.85.1 with wasm32-unknown-unknown and cached Cargo.lock dependencies. Set COVELET_RUSTC to the pinned compiler. --check does not need Rust; this script never downloads tools or dependencies.')
}

async function rebuild() {
  const rustc = await compiler()
  const cargo = rustc === 'rustc' ? 'cargo' : join(dirname(rustc), process.platform === 'win32' ? 'cargo.exe' : 'cargo')
  const targetDirectory = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Covelet/rust-build/sync-core-target')
    : join(app, 'wasm/sync-core/target')
  const result = spawnSync(cargo, ['build', '--manifest-path', 'wasm/sync-core/Cargo.toml', '--target', target, '--release', '--locked', '--offline'], {
    cwd: app, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, RUSTC: rustc, CARGO_TARGET_DIR: targetDirectory, CARGO_ENCODED_RUSTFLAGS: flags.join('\u001f') },
  })
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Sync WASM compilation failed.')
  await mkdir(dirname(binaryPath), { recursive: true })
  await copyFile(join(targetDirectory, target, 'release/covelet_sync_core.wasm'), binaryPath)
  const bytes = await readFile(binaryPath)
  inspect(bytes)
  await writeFile(metadataPath, `${JSON.stringify({
    abi: 1, compiler: expectedCompiler, target, flags: recordedFlags, memoryBytes,
    bytes: bytes.length, sha256: sha256(bytes), sources: await sourceChecksums(),
  }, null, 2)}\n`)
  await check()
}

try {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args[0] && !['--check', '--rebuild'].includes(args[0]))) throw new Error('Usage: node scripts/build-sync-wasm.mjs [--check|--rebuild]')
  if (args[0] === '--rebuild') await rebuild()
  else await check()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
