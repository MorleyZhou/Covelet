import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictRecordPreview } from './cloud-conflict-preview.js';

test('conflict previews show both complete small records as inert text, describe Blob bytes, and bound large bodies', () => {
  assert.equal(conflictRecordPreview({ body: '<img src="https://private.test">', blob: new Blob(['sample'], { type: 'image/png' }) }),
    JSON.stringify({ body: '<img src="https://private.test">', blob: '二进制内容：6 字节，类型 image/png' }, null, 2));
  const preview = conflictRecordPreview({ body: 'a'.repeat(1000000), items: Array(100000).fill('more') });
  assert.ok(preview.length < 13000); assert.match(preview, /预览已截短/);
});
