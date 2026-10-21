import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createVisualProcessor, decodeVisualImage, encodeVisualIcon, getVisualRuntimeStatus, observeVisualResult, paletteFromStats, validateLocalVisualUrl } from './visual-processing.js';
import { runVisualOperation } from './visual-worker.js';

const BASE = 'https://covelet.test/newtab.html';
const local = (name) => `blob:https://covelet.test/${name}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function stats() {
  const value = Array(32).fill(0);
  value.splice(0, 15, 1, 0, 1, 0x26787a, 0x667788, 2500, 1000, 2000, 5000, 0x26787a, 0x337788, 0x112233, 6000, 3000, 1000);
  return value;
}
function workerHarness({ hold = false } = {}) {
  const workers = [];
  const factory = () => {
    const worker = { calls: [], terminated: 0,
      postMessage(message) { this.calls.push(message); if (!hold) queueMicrotask(() => this.reply(message)); },
      reply(message = this.calls[0]) { this.onmessage?.({ data: { id: message.id, ok: true, result: message.kind === 'wallpaper' ? { kind: message.kind, stats: stats() } : { kind: 'icon', width: 128, height: 128, stats: stats(), pixels: new ArrayBuffer(128 * 128 * 4) } } }); },
      terminate() { this.terminated++; },
    };
    workers.push(worker);
    return worker;
  };
  return { factory, workers };
}
function processorHarness(overrides = {}) {
  const worker = workerHarness(overrides);
  const decoded = [];
  const processor = createVisualProcessor({ baseUrl: BASE, workerFactory: worker.factory,
    decode: async (url) => { decoded.push(url); return { width: 1, height: 1, pixels: new ArrayBuffer(4) }; },
    encode: async () => new Blob(['derived'], { type: 'image/png' }), ...overrides,
  });
  return { ...worker, processor, decoded };
}

test('visual sources only allow own-origin blob images and the exact bundled fallback', () => {
  assert.equal(validateLocalVisualUrl('./assets/alpine-lake.png', BASE), 'https://covelet.test/assets/alpine-lake.png');
  assert.equal(validateLocalVisualUrl(local('icon'), BASE), local('icon'));
  assert.equal(validateLocalVisualUrl('blob:chrome-extension://abc/uuid', 'chrome-extension://abc/newtab.html'), 'blob:chrome-extension://abc/uuid');
  for (const value of ['https://remote.test/a.png', 'https://covelet.test/other.png', './assets/alpine-lake.png?extra=1', './assets/alpine-lake.png#x', 'data:image/png,a', 'file:///a.png', 'blob:https://remote.test/a', 'blob:chrome-extension://other/uuid', '//remote.test/assets/alpine-lake.png', './assets/a.svg']) assert.throws(() => validateLocalVisualUrl(value, BASE));
  assert.throws(() => validateLocalVisualUrl('blob:null/id', BASE));
});

test('decoding bounds source dimensions before decode, samples at most 256px, and closes bitmaps', async () => {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1024); view.setUint32(20, 512);
  const requests = [], canvases = [];
  let closed = 0, decoded = 0;
  const options = { baseUrl: BASE,
    fetcher: async (url, init) => { requests.push({ url, init }); return new Response(bytes, { headers: { 'content-type': 'image/png' } }); },
    createBitmap: async (_blob, resize) => { decoded++; assert.deepEqual(resize, { resizeWidth: 256, resizeHeight: 128, resizeQuality: 'high' }); return { width: 256, height: 128, close() { closed++; } }; },
    makeCanvas: (width, height) => { canvases.push({ width, height }); return { getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4) }) }) }; },
  };
  const result = await decodeVisualImage(local('picture'), options);
  assert.equal(result.pixels.byteLength, 256 * 128 * 4);
  assert.deepEqual(canvases, [{ width: 256, height: 128 }]);
  assert.equal(closed, 1);
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.referrerPolicy, 'no-referrer');
  assert.equal(requests[0].init.redirect, 'error');
  view.setUint32(16, 8193);
  await assert.rejects(decodeVisualImage(local('oversized'), options));
  assert.equal(decoded, 1, 'oversized headers must fail before allocating a bitmap');
  const count = requests.length;
  await assert.rejects(decodeVisualImage('https://remote.test/a.png', options));
  assert.equal(requests.length, count, 'remote inputs never trigger a fetch');
  const controller = new AbortController();
  await assert.rejects(decodeVisualImage(local('abort'), { ...options, signal: controller.signal,
    fetcher: async () => { view.setUint32(16, 1024); return new Response(bytes, { headers: { 'content-type': 'image/png' } }); },
    createBitmap: async () => { controller.abort(); return { width: 256, height: 128, close() { closed++; } }; },
  }), { name: 'AbortError' });
  assert.equal(closed, 2, 'cancellation after decode still closes the bitmap');
});

test('palette maps real linear-luminance and packed RGB statistics without accepting malformed results', () => {
  const palette = paletteFromStats(stats());
  assert.equal(palette.accent, '#26787a');
  assert.equal(palette.mean, '#667788');
  assert.equal(palette.brightness, 0.25);
  assert.equal(palette.p90, 0.5);
  assert.equal(palette.foreground, '#ffffff');
  assert.deepEqual(palette.weights, [0.6, 0.3, 0.1]);
  const invalid = stats(); invalid[5] = 10001;
  assert.throws(() => paletteFromStats(invalid));
});

test('icon encoding writes the worker pixels and supports both OffscreenCanvas and DOM canvas paths', async () => {
  const input = { width: 128, height: 128, pixels: new ArrayBuffer(128 * 128 * 4) };
  new Uint8Array(input.pixels).set([38, 120, 122, 255], (64 * 128 + 64) * 4);
  const written = [];
  const createImageData = (bytes, width, height) => ({ data: bytes, width, height });
  const makeCanvas = (mode) => () => ({
    getContext: () => ({ putImageData(image, x, y) { written.push({ image, x, y }); } }),
    ...(mode === 'offscreen' ? { convertToBlob: async () => new Blob(['png'], { type: 'image/png' }) } : { toBlob: (done) => done(new Blob(['png'], { type: 'image/png' })) }),
  });
  for (const mode of ['offscreen', 'dom']) {
    const blob = await encodeVisualIcon(input, { makeCanvas: makeCanvas(mode), createImageData });
    assert.equal(blob.type, 'image/png');
  }
  assert.equal(written.length, 2);
  assert.equal(written[0].image.data[(64 * 128 + 64) * 4 + 3], 255);
  await assert.rejects(encodeVisualIcon({ ...input, pixels: new ArrayBuffer(3) }, { makeCanvas: makeCanvas('dom'), createImageData }));
  await assert.rejects(encodeVisualIcon(input, { makeCanvas: () => ({ getContext: () => ({ putImageData() {} }), toBlob: (done) => done(null) }), createImageData }));
});

test('processor starts one worker lazily, shares duplicate requests, and bounds its derived-only cache', async () => {
  const subject = processorHarness({ cacheLimit: 1 });
  assert.equal(subject.workers.length, 0);
  const first = subject.processor.acquire('icon', local('a'));
  const duplicate = subject.processor.acquire('icon', local('a'));
  first.release();
  const value = await duplicate.promise;
  assert(value instanceof Blob);
  assert.equal(subject.workers.length, 1);
  assert.equal(subject.workers[0].calls.length, 1);
  assert.equal(subject.decoded.length, 1);
  duplicate.release();
  const cached = subject.processor.acquire('icon', local('a'));
  assert.equal(await cached.promise, value);
  await subject.processor.acquire('icon', local('b')).promise;
  await subject.processor.acquire('icon', local('a')).promise;
  assert.equal(subject.workers[0].calls.length, 3, 'oldest derived blob is evicted');
  subject.processor.dispose();
  assert.equal(subject.workers[0].terminated, 1);
});

test('cancelled consumers never cache a late response, and a full queue fails back instead of growing', async () => {
  const subject = processorHarness({ hold: true, maxQueued: 1 });
  const leases = ['a', 'b', 'c', 'd'].map((id) => subject.processor.acquire('icon', local(id)));
  for (const lease of leases) lease.promise.catch(() => {});
  await assert.rejects(leases[3].promise, /待处理/);
  await tick();
  assert.equal(subject.workers[0].calls.length, 2);
  leases.forEach((lease) => lease.release());
  await assert.rejects(leases[0].promise, { name: 'AbortError' });
  subject.workers[0].reply();
  await tick();
  const next = subject.processor.acquire('icon', local('a'));
  next.promise.catch(() => {});
  await tick();
  assert.equal(subject.decoded.filter((url) => url === local('a')).length, 2);
  next.release();
  subject.processor.dispose();
});

test('timeouts settle even a stuck decoder and terminate a stuck worker for later recovery', async () => {
  const subject = processorHarness({ decode: () => new Promise(() => {}), timeoutMs: 15 });
  await assert.rejects(subject.processor.acquire('wallpaper', local('never')).promise, /暂不可用/);
  subject.processor.dispose();
  const worker = processorHarness({ hold: true, timeoutMs: 15 });
  await assert.rejects(worker.processor.acquire('wallpaper', local('stuck')).promise, /暂不可用/);
  assert.equal(worker.workers[0].terminated, 1);
  worker.processor.dispose();
});

test('observer lifetimes discard late results and release only their own derived URL', async () => {
  const first = deferred(), second = deferred();
  const published = [], created = [], revoked = [];
  let released = 0;
  const options = (value) => ({ acquire: () => ({ promise: value.promise, release() { released++; } }), publish: (value) => published.push(value), createObjectURL: () => { created.push('blob:derived'); return 'blob:derived'; }, revokeObjectURL: (url) => revoked.push(url) });
  const stopFirst = observeVisualResult('icon', local('old'), options(first));
  stopFirst();
  first.resolve(new Blob(['old']));
  await tick();
  assert.equal(published.length, 0);
  assert.equal(created.length, 0, 'late results must not allocate URLs');
  const stopSecond = observeVisualResult('icon', local('new'), options(second));
  second.resolve(new Blob(['new']));
  await tick();
  assert.equal(published[0].source, local('new'));
  assert.equal(published[0].adapted, true);
  stopSecond();
  assert.deepEqual(revoked, ['blob:derived']);
  assert.equal(released, 2);
});

test('a later successful operation clears the current warning while retaining the failure counter', async () => {
  const before = getVisualRuntimeStatus().failures;
  const stopFailure = observeVisualResult('wallpaper', local('bad'), { acquire: () => ({ promise: Promise.reject(new Error('unavailable')), release() {} }), publish() {} });
  await tick();
  assert.equal(getVisualRuntimeStatus().phase, 'fallback');
  assert.equal(getVisualRuntimeStatus().failures, before + 1);
  const stopSuccess = observeVisualResult('wallpaper', local('good'), { acquire: () => ({ promise: Promise.resolve(paletteFromStats(stats())), release() {} }), publish() {} });
  await tick();
  assert.equal(getVisualRuntimeStatus().phase, 'ready');
  assert.equal(getVisualRuntimeStatus().message, '');
  assert.equal(getVisualRuntimeStatus().failures, before + 1);
  stopFailure(); stopSuccess();
});

test('worker ABI refuses unbounded dimensions, foreign operations and malformed memory ranges', () => {
  const memory = new WebAssembly.Memory({ initial: 8, maximum: 8 });
  const core = { memory, abi_version: () => 1, input_ptr: () => 0, output_ptr: () => 262144, result_ptr: () => 327680,
    analyze_wallpaper() { new Uint32Array(memory.buffer, 327680, 32).set(stats()); return 0; },
    normalize_icon() { new Uint32Array(memory.buffer, 327680, 32).set(stats()); return 0; },
  };
  const input = { kind: 'wallpaper', width: 1, height: 1, pixels: new ArrayBuffer(4) };
  assert.deepEqual(runVisualOperation(core, input).stats, stats());
  assert.throws(() => runVisualOperation(core, { ...input, kind: 'plugin' }));
  assert.throws(() => runVisualOperation(core, { ...input, width: 257 }));
  assert.throws(() => runVisualOperation({ ...core, input_ptr: () => 1e9 }, input));
  assert.throws(() => runVisualOperation({ ...core, abi_version: () => 2 }, input));
});

test('the worker bridge executes the actual packaged WASM for both operations', async () => {
  const { instance } = await WebAssembly.instantiate(await readFile(new URL('../wasm/visual-core.wasm', import.meta.url)), {});
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let y = 2; y < 6; y++) for (let x = 3; x < 5; x++) pixels.set([38, 120, 122, 255], (y * 8 + x) * 4);
  const wallpaper = runVisualOperation(instance.exports, { kind: 'wallpaper', width: 8, height: 8, pixels: pixels.slice().buffer });
  const palette = paletteFromStats(wallpaper.stats);
  assert.equal(palette.accent, '#26787a');
  assert(palette.brightness > 0 && palette.brightness < 1);
  const icon = runVisualOperation(instance.exports, { kind: 'icon', width: 8, height: 8, pixels: pixels.buffer });
  assert.equal(icon.width, 128);
  assert.equal(icon.height, 128);
  assert.equal(icon.pixels.byteLength, 128 * 128 * 4);
  const output = new Uint8Array(icon.pixels);
  assert.equal(output[3], 0);
  assert.equal(output[(64 * 128 + 64) * 4 + 3], 255);
  assert.deepEqual(Array.from(output.slice((64 * 128 + 64) * 4, (64 * 128 + 64) * 4 + 3)), [38, 120, 122]);
});
