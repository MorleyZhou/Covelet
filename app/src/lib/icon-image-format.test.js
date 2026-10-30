import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeIconBlob, sniffIconMime, ICON_IMAGE_LIMIT, ICON_SVG_LIMIT } from './icon-image-format.js';
import { validateIconBytes } from './site-info.js';
import { validateNavigationIconRecord } from './icon-image-record.js';

const PNG = new Uint8Array(readFileSync(new URL('../../public/icons/icon-32.png', import.meta.url)));
test('actual PNG bytes override ICO, unknown and absent response MIME, including a low resolution image', async () => {
  for (const declared of ['image/vnd.microsoft.icon', 'image/x-icon', 'application/octet-stream', 'text/plain', '']) {
    const result = await normalizeIconBlob(new Blob([PNG], { type: declared }));
    assert.equal(result.type, 'image/png');
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), PNG);
    validateIconBytes(new Uint8Array(await result.arrayBuffer()), result.type);
  }
});
test('a genuine ICO container is recognized separately from an ICO-labelled PNG', async () => {
  const bytes = new Uint8Array(22 + PNG.length), view = new DataView(bytes.buffer);
  view.setUint16(2, 1, true); view.setUint16(4, 1, true); bytes[6] = bytes[7] = 32;
  view.setUint32(14, PNG.length, true); view.setUint32(18, 22, true); bytes.set(PNG, 22);
  const ico = await normalizeIconBlob(new Blob([bytes], { type: 'image/png' }));
  assert.equal(ico.type, 'image/vnd.microsoft.icon');
  validateIconBytes(new Uint8Array(await ico.arrayBuffer()), ico.type);
});
test('non-image 200 responses and SVG embedded in HTML cannot masquerade as image bytes', async () => {
  for (const text of ['<!doctype html><html>Challenge</html>', '<html><svg/></html>', '{"error":"not found"}', 'not an image']) {
    assert.equal(sniffIconMime(new TextEncoder().encode(text)), null);
    await assert.rejects(normalizeIconBlob(new Blob([text], { type: 'image/png' })), { code: 'FORMAT' });
  }
  assert.equal(sniffIconMime(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml');
});
test('actual SVG content has its smaller input bound even when declared as another format', async () => {
  await assert.rejects(normalizeIconBlob(new Blob(['<svg>', ' '.repeat(ICON_SVG_LIMIT), '</svg>'], { type: 'application/octet-stream' })), { code: 'LIMIT' });
  await assert.rejects(normalizeIconBlob(new Blob([PNG, new Uint8Array(ICON_IMAGE_LIMIT)], { type: 'image/png' })), { code: 'LIMIT' });
});
const record = (extra = {}) => ({ url: 'https://icons.example/32.png', width: 32, height: 32, adaptive: false, vector: false,
  updatedAt: 1, blob: new Blob([PNG], { type: 'image/png' }), ...extra });
test('navigation cache, sync and restored icons share the same size and deep-decoding contract', async () => {
  let calls = 0;
  const decode = async () => { calls++; return { width: 32, height: 32, close() {} }; };
  await validateNavigationIconRecord(record(), undefined, { decode });
  assert.equal(calls, 1);
  await assert.rejects(validateNavigationIconRecord(record({ blob: new Blob([PNG, new Uint8Array(ICON_IMAGE_LIMIT)], { type: 'image/png' }) }), undefined, { decode }));
  await assert.rejects(validateNavigationIconRecord(record(), undefined, { decode: async () => { throw Error('Image does not decode'); } }), /does not decode/);
  await assert.rejects(validateNavigationIconRecord(record({ width: 16 }), undefined, { decode }), /dimensions/);
  await assert.rejects(validateNavigationIconRecord(record({ adaptive: true }), undefined, { decode }));
});
