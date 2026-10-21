import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

const binary = await readFile(new URL('../wasm/visual-core.wasm', import.meta.url))
const module = new WebAssembly.Module(binary)

function core() {
  const { exports } = new WebAssembly.Instance(module)
  return {
    exports,
    call(operation, width, height, bytes) {
      if (bytes) new Uint8Array(exports.memory.buffer, exports.input_ptr(), bytes.length).set(bytes)
      const status = exports[operation](width, height)
      return {
        status,
        result: new Uint32Array(exports.memory.buffer, exports.result_ptr(), 32).slice(),
        pixels: new Uint8Array(exports.memory.buffer, exports.output_ptr(), 128 * 128 * 4).slice(),
      }
    },
  }
}

function rgba(width, height, color) {
  const bytes = new Uint8Array(width * height * 4)
  for (let index = 0; index < bytes.length; index += 4) bytes.set(color, index)
  return bytes
}

function pixel(bytes, x, y) { return [...bytes.slice((y * 128 + x) * 4, (y * 128 + x + 1) * 4)] }

function visibleBounds(bytes) {
  let left = 128; let top = 128; let right = 0; let bottom = 0
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    if (!bytes[(y * 128 + x) * 4 + 3]) continue
    left = Math.min(left, x); top = Math.min(top, y)
    right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1)
  }
  return [left, top, right - left, bottom - top]
}

test('packaged WASM has a small, import-free ABI and fixed bounded memory', () => {
  const { exports } = core()
  assert.deepEqual(WebAssembly.Module.imports(module), [])
  assert.ok(binary.length < 32 * 1024)
  assert.equal(exports.abi_version(), 1)
  assert.equal(exports.memory.buffer.byteLength, 512 * 1024)
  assert.throws(() => exports.memory.grow(1), RangeError)
  const regions = [[exports.input_ptr(), 256 * 256 * 4], [exports.output_ptr(), 128 * 128 * 4], [exports.result_ptr(), 32 * 4]].sort((a, b) => a[0] - b[0])
  for (let index = 0; index < regions.length; index++) {
    assert.ok(regions[index][0] >= 0)
    assert.ok(regions[index][0] + regions[index][1] <= exports.memory.buffer.byteLength)
    if (index) assert.ok(regions[index - 1][0] + regions[index - 1][1] <= regions[index][0])
  }
})

test('wallpaper reports actual RGB, standard linear luminance and full palette weight', () => {
  const { status, result } = core().call('analyze_wallpaper', 16, 16, rgba(16, 16, [255, 0, 0, 255]))
  assert.equal(status, 0)
  assert.equal(result[0], 1)
  assert.equal(result[1], 0)
  assert.equal(result[2], 256)
  assert.equal(result[3], 0xff0000)
  assert.equal(result[4], 0xff0000)
  assert.equal(result[5], 2126)
  assert.ok(Math.abs(result[6] - 2126) <= 40)
  assert.equal(result[9], 0xff0000)
  assert.equal(result[12], 10000)
  assert.deepEqual([...result.slice(13, 15)], [0, 0])
})

test('wallpaper palette retains distinct dominant colors instead of substituting a global mean', () => {
  const bytes = new Uint8Array([0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255])
  const { result } = core().call('analyze_wallpaper', 4, 1, bytes)
  assert.equal(result[3], 0x00ff00)
  assert.equal(result[4], 0x40bf00)
  assert.deepEqual([...result.slice(9, 11)], [0x00ff00, 0xff0000])
  assert.deepEqual([...result.slice(12, 14)], [7500, 2500])
})

test('wallpaper ignores hidden transparent RGB and alpha-weights partially transparent colors', () => {
  const bytes = new Uint8Array([255, 255, 255, 0, 255, 0, 0, 255, 0, 0, 255, 85])
  const { result } = core().call('analyze_wallpaper', 3, 1, bytes)
  assert.equal(result[2], 2)
  assert.equal(result[3], 0xff0000)
  assert.equal(result[4], 0xbf0040)
  assert.equal(result[5], Math.round((2126 * 255 + 722 * 85) / 340))
  assert.deepEqual([...result.slice(12, 14)], [7500, 2500])
})

test('wallpaper percentiles distinguish mixed dark and light regions', () => {
  const { result } = core().call('analyze_wallpaper', 2, 1, new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]))
  assert.equal(result[5], 5000)
  assert.deepEqual([...result.slice(6, 9)], [0, 0, 10000])
  const gray = core().call('analyze_wallpaper', 1, 1, new Uint8Array([128, 128, 128, 255])).result
  assert.ok(Math.abs(gray[5] - 2159) <= 1, 'sRGB middle gray must be converted to linear light')
})

test('normalization trims only transparent borders, centers the image and preserves aspect ratio', () => {
  const bytes = rgba(64, 64, [0, 0, 0, 0])
  for (let y = 20; y < 30; y++) for (let x = 10; x < 30; x++) bytes.set([12, 101, 241, 255], (y * 64 + x) * 4)
  const { status, result, pixels } = core().call('normalize_icon', 64, 64, bytes)
  assert.equal(status, 0)
  assert.deepEqual([...result.slice(15, 19)], [10, 20, 20, 10])
  assert.deepEqual(visibleBounds(pixels), [13, 38, 102, 51])
  assert.deepEqual(pixel(pixels, 64, 64), [12, 101, 241, 255])
  assert.deepEqual(pixel(pixels, 0, 0), [0, 0, 0, 0])
})

test('opaque white backgrounds are preserved rather than mistaken for removable padding', () => {
  const { pixels, result } = core().call('normalize_icon', 4, 4, rgba(4, 4, [255, 255, 255, 255]))
  assert.deepEqual([...result.slice(15, 19)], [0, 0, 4, 4])
  assert.deepEqual(visibleBounds(pixels), [13, 13, 102, 102])
  assert.deepEqual(pixel(pixels, 13, 13), [255, 255, 255, 255])
  assert.deepEqual(pixel(pixels, 114, 114), [255, 255, 255, 255])
})

test('upsampling uses premultiplied alpha so hidden RGB cannot create dark or green fringes', () => {
  const source = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 0, 128])
  const { pixels } = core().call('normalize_icon', 3, 1, source)
  let partial = 0
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue
    assert.deepEqual([...pixels.slice(i, i + 3)], [255, 0, 0])
    if (pixels[i + 3] < 255) partial++
  }
  assert.ok(partial > 0, 'original/interpolated transparency is retained')
})

test('area downsampling retains color and partial transparency at maximum input dimensions', () => {
  const source = rgba(256, 256, [0, 255, 0, 0])
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x += 2) source.set([240, 90, 12, 128], (y * 256 + x) * 4)
  const { pixels, result } = core().call('normalize_icon', 256, 256, source)
  assert.equal(result[2], 128 * 256)
  assert.deepEqual([...result.slice(15, 19)], [0, 0, 255, 256])
  let partial = 0
  for (let i = 0; i < pixels.length; i += 4) {
    if (!pixels[i + 3]) continue
    assert.deepEqual([...pixels.slice(i, i + 3)], [240, 90, 12])
    assert.ok(pixels[i + 3] <= 128)
    partial++
  }
  assert.ok(partial > 0)
})

test('one-pixel and extreme-aspect icons remain visible and canonical output is stable', () => {
  const instance = core()
  const first = instance.call('normalize_icon', 1, 1, new Uint8Array([12, 34, 56, 1]))
  assert.deepEqual(visibleBounds(first.pixels), [13, 13, 102, 102])
  assert.deepEqual(pixel(first.pixels, 64, 64), [12, 34, 56, 1])
  const second = instance.call('normalize_icon', 128, 128, first.pixels)
  assert.equal(second.result[19], 0)
  assert.deepEqual(second.pixels, first.pixels)
  const thin = instance.call('normalize_icon', 1, 256, rgba(1, 256, [90, 70, 50, 255]))
  assert.deepEqual(visibleBounds(thin.pixels), [63, 13, 1, 102])
})

test('invalid dimensions and transparent inputs return explicit errors without stale output', () => {
  const instance = core()
  instance.call('normalize_icon', 1, 1, new Uint8Array([255, 255, 255, 255]))
  const empty = instance.call('normalize_icon', 1, 1, new Uint8Array([255, 255, 255, 0]))
  assert.equal(empty.status, 2)
  assert.deepEqual([...empty.result.slice(0, 3)], [1, 2, 0])
  assert.ok(empty.pixels.every(value => value === 0))
  assert.equal(instance.call('analyze_wallpaper', 1, 1, new Uint8Array([255, 255, 255, 0])).status, 2)
  for (const operation of ['analyze_wallpaper', 'normalize_icon']) {
    for (const [width, height] of [[0, 1], [1, 0], [257, 1], [1, 257], [0xffffffff, 256]]) {
      const { status, result } = instance.call(operation, width, height)
      assert.equal(status, 1)
      assert.deepEqual([...result.slice(0, 3)], [1, 1, 0])
      assert.ok(result.slice(2).every(value => value === 0))
    }
  }
})

test('bounded real-WASM performance diagnostic', t => {
  const { exports } = core()
  const source = new Uint8Array(256 * 256 * 4)
  for (let i = 0; i < source.length; i += 4) source.set([(i >> 2) & 255, (i >> 6) & 255, (i >> 10) & 255, 255], i)
  new Uint8Array(exports.memory.buffer, exports.input_ptr(), source.length).set(source)
  for (const operation of ['analyze_wallpaper', 'normalize_icon']) {
    for (let warmup = 0; warmup < 5; warmup++) assert.equal(exports[operation](256, 256), 0)
    const samples = []
    for (let run = 0; run < 20; run++) {
      const start = performance.now()
      assert.equal(exports[operation](256, 256), 0)
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    t.diagnostic(`${operation}, 256×256, Node ${process.version}: median ${samples[10].toFixed(3)} ms, p95 ${samples[18].toFixed(3)} ms (20 runs; decoding/worker transport excluded).`)
  }
  assert.equal(exports.memory.buffer.byteLength, 512 * 1024)
})
