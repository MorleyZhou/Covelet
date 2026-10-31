import test from 'node:test';
import assert from 'node:assert/strict';
import { finishCloudSetup } from './cloud-connection.js';

const input = { profile: { provider: 'webdav' }, secrets: { appPassword: 'fixture-only' }, password: 'fixture sync password', autoSync: true };

test('first setup saves without background sync, syncs once, then enables requested auto sync', async () => {
  const calls = [];
  const saved = await finishCloudSetup(input, {
    async saveCloudSyncSettings(profile, secrets, password, options) { calls.push(['save', options.autoSync]); return { profile, autoSync: options.autoSync }; },
    async syncCloudNow() { calls.push(['sync']); return { phase: 'saved' }; },
  });
  assert.deepEqual(calls, [['save', false], ['sync'], ['save', true]]);
  assert.equal(saved.autoSync, true);
});

test('a resolved failure status from the sync controller cannot complete setup or enable background retries', async () => {
  const calls = [];
  await assert.rejects(finishCloudSetup(input, {
    async saveCloudSyncSettings(profile, secrets, password, options) { calls.push(options.autoSync); return {}; },
    async syncCloudNow() { return { phase: 'error', code: 'WEBDAV_AUTH', message: 'WebDAV 登录失败（401）' }; },
  }), { code: 'WEBDAV_AUTH', message: 'WebDAV 登录失败（401）' });
  assert.deepEqual(calls, [false]);
});

test('first-sync failure stays manual and propagates the existing actionable error', async () => {
  const calls = [], failure = Object.assign(new Error('无法解密同步数据'), { code: 'CLOUD_DECRYPT' });
  await assert.rejects(finishCloudSetup(input, {
    async saveCloudSyncSettings(profile, secrets, password, options) { calls.push(['save', options.autoSync]); return {}; },
    async syncCloudNow() { calls.push(['sync']); throw failure; },
  }), error => error === failure);
  assert.deepEqual(calls, [['save', false], ['sync']], 'failure cannot opt into automatic retries');
});

test('save-only setup never invokes connection testing or synchronization and keeps unverified state', async () => {
  let calls = 0;
  const result = await finishCloudSetup({ ...input, firstSync: false }, {
    async saveCloudSyncSettings(profile, secrets, password, options) { calls++; assert.equal(options.autoSync, false); return { connectionTest: null }; },
    async testCloudConnection() { assert.fail('saving is not a test'); },
    async syncCloudNow() { assert.fail('save-only must stay local'); },
  });
  assert.equal(calls, 1);
  assert.equal(result.connectionTest, null);
});
