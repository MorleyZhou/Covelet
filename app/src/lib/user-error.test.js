import test from 'node:test';
import assert from 'node:assert/strict';
import { userErrorMessage } from './user-error.js';
import { tr } from '../i18n/index.js';

test('storage error codes give actionable copy without exposing raw values', () => {
  assert.equal(userErrorMessage({ code: 'LOCAL_DATA_BLOCKED', message: 'upgrade blocked: private-id' }), '请关闭其他 Covelet 页面后重试，原数据已保留。');
  assert.equal(userErrorMessage({ code: 'LOCAL_DATA_KEY_MISSING', message: 'key-id=private' }), '无法打开加密数据，原数据已保留。');
  assert.equal(userErrorMessage({ name: 'QuotaExceededError', message: 'IDB put failed' }), '浏览器存储空间不足，请释放空间后重试。');
  assert.equal(userErrorMessage(Error('https://private.invalid/?token=secret')), '操作失败，请重试。');
});

test('application messages preserve specific consequences and formatted instructions', () => {
  const warning = tr('文件夹内的 {0} 个网站也会删除。', [7]);
  assert.equal(userErrorMessage({ code: 'REVISION_CONFLICT', message: warning }), warning);
  assert.equal(userErrorMessage({ code: 'REVISION_CONFLICT', message: 'Internal token changed' }), '数据已在其他页面更新，请重新打开后再试。');
  assert.equal(userErrorMessage(null, 'fallback'), 'fallback');
});
