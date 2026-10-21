import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binaryPath = join(app, 'src/wasm/github-core.wasm')
const metadataPath = join(app, 'wasm/github-core/manifest.json')
const sourcePaths = ['wasm/github-core/Cargo.toml', 'wasm/github-core/src/lib.rs', 'scripts/build-github-wasm.mjs']
const expectedCompiler = 'rustc 1.85.1 (4eb161250 2025-03-15)'
const target = 'wasm32-unknown-unknown'
const flags = [
  '--crate-name', 'covelet_github_core', '--crate-type', 'cdylib', '--edition=2021', '--target', target,
  '-C', 'opt-level=s', '-C', 'lto=fat', '-C', 'codegen-units=1', '-C', 'panic=abort',
  '-C', 'debuginfo=0', '-C', 'strip=symbols',
  '-C', 'link-arg=--initial-memory=524288', '-C', 'link-arg=--max-memory=524288',
  '-C', 'link-arg=-zstack-size=65536', '-C', 'link-arg=--stack-first',
]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function sourceChecksums() {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha256(await readFile(join(app, path)))])))
}

function inspect(bytes) {
  if (bytes.length > 32 * 1024) throw new Error('GitHub WASM exceeds its 32 KiB code budget.')
  const module = new WebAssembly.Module(bytes)
  if (WebAssembly.Module.imports(module).length) throw new Error('GitHub WASM must have no host, network or runtime imports.')
  const instance = new WebAssembly.Instance(module)
  const required = ['memory', 'abi_version', 'input_ptr', 'output_ptr', 'result_ptr', 'analyze_calendar']
  for (const name of required) if (!(name in instance.exports)) throw new Error(`Missing WASM ABI export: ${name}`)
  if (instance.exports.abi_version() !== 1) throw new Error('GitHub WASM ABI must be version 1.')
  if (instance.exports.memory.buffer.byteLength !== 524288) throw new Error('GitHub WASM must use fixed 512 KiB memory.')
  try { instance.exports.memory.grow(1); throw new Error('GitHub WASM memory unexpectedly grew.') } catch (error) {
    if (!(error instanceof RangeError)) throw error
  }
}

async function check() {
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  const checksums = await sourceChecksums()
  for (const path of sourcePaths) {
    if (metadata.sources?.[path] !== checksums[path]) throw new Error(`GitHub WASM source changed: ${path}. Run node scripts/build-github-wasm.mjs --rebuild.`)
  }
  if (metadata.compiler !== expectedCompiler || metadata.target !== target || JSON.stringify(metadata.flags) !== JSON.stringify(flags)) {
    throw new Error('GitHub WASM build metadata does not match the pinned reproducible build configuration.')
  }
  const bytes = await readFile(binaryPath)
  if (metadata.sha256 !== sha256(bytes) || metadata.bytes !== bytes.length) throw new Error('Packaged visual WASM checksum mismatch. Rebuild from the checked-in Rust source.')
  inspect(bytes)
  console.log(`GitHub WASM verified: ${bytes.length} bytes, SHA-256 ${metadata.sha256}, ABI 1, no imports, fixed 512 KiB memory.`)
}

async function compiler() {
  const cache = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Covelet/rust-build/rustup/toolchains/1.85.1-x86_64-pc-windows-msvc/bin/rustc.exe') : null
  const choices = [process.env.COVELET_RUSTC, 'rustc', cache].filter(Boolean)
  for (const candidate of choices) {
    if (candidate !== 'rustc') { try { await access(candidate, constants.X_OK) } catch { continue } }
    const version = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true })
    if (version.status !== 0 || version.stdout.trim() !== expectedCompiler) continue
    const result = spawnSync(candidate, ['--print', 'target-libdir', '--target', target], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) continue
    try { await access(result.stdout.trim()) } catch { continue }
    return candidate
  }
  throw new Error('Rebuilding needs Rust 1.85.1 and wasm32-unknown-unknown. Install with `rustup toolchain install 1.85.1 --profile minimal --target wasm32-unknown-unknown`, then set COVELET_RUSTC to that toolchain rustc executable. Ordinary builds can use `node scripts/build-github-wasm.mjs --check` to verify the checked-in binary without Rust. This script never downloads code or toolchains.')
}

async function rebuild() {
  const rustc = await compiler()
  await mkdir(dirname(binaryPath), { recursive: true })
  const result = spawnSync(rustc, [...flags, 'wasm/github-core/src/lib.rs', '-o', 'src/wasm/github-core.wasm'], {
    cwd: app, encoding: 'utf8', windowsHide: true,
  })
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Rust WASM compilation failed.')
  const bytes = await readFile(binaryPath)
  inspect(bytes)
  await writeFile(metadataPath, `${JSON.stringify({
    abi: 1, compiler: expectedCompiler, target, flags, bytes: bytes.length, sha256: sha256(bytes), sources: await sourceChecksums(),
  }, null, 2)}\n`)
  await check()
}

try {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args[0] && !['--check', '--rebuild'].includes(args[0]))) throw new Error('Usage: node scripts/build-github-wasm.mjs [--check|--rebuild]')
  if (args[0] === '--rebuild') await rebuild()
  else await check()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
