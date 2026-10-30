import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSyncValue } from './sync-data-rules.js';
const PNG = new Uint8Array(readFileSync(new URL('../../public/icons/icon-32.png', import.meta.url)));
const url = 'https://icons.example/shared.png';
const record = (extra = {}) => ({ url, updatedAt: 1, width: 32, height: 32, adaptive: false, vector: false,
  blob: new Blob([PNG], { type: 'image/png' }), ...extra });
test('synchronized navigation images use the same one MiB and real decoding rules as local cache reads', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  let rejectedDecode = false;
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => {
    if (rejectedDecode) throw Error('Corrupt image');
    return { width: 32, height: 32, close() {} };
  } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'createImageBitmap', descriptor); else delete globalThis.createImageBitmap; });
  await validateSyncValue('navigation-icons', url, record());
  for (const invalid of [
    record({ blob: new Blob([PNG, new Uint8Array(1024 * 1024)], { type: 'image/png' }) }),
    record({ width: 64 }), record({ adaptive: true }),
    record({ blob: new Blob([PNG], { type: 'image/vnd.microsoft.icon' }) }),
  ]) await assert.rejects(validateSyncValue('navigation-icons', url, invalid), { code: 'LOCAL_DATA_INVALID' });
  rejectedDecode = true;
  await assert.rejects(validateSyncValue('navigation-icons', url, record()), { code: 'LOCAL_DATA_INVALID' });
});
