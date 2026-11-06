import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readPrivacyPermissions, permissionPurpose, permissionLabel } from './privacy-checkup.js';
import manifest from '../../extension.manifest.json' with { type: 'json' };

test('privacy snapshot distinguishes actual grants from optional declaration ranges without requesting access', async () => {
  const browser = {
    runtime: { id: 'fixture', getManifest: () => manifest },
    permissions: {
      getAll(callback) { callback({ permissions: [...manifest.permissions, 'notifications'], origins: ['https://www.bing.com/*', 'https://dav.example.test/*'] }); },
      request() { assert.fail('checkup must never ask for new access'); },
    },
  };
  const result = await readPrivacyPermissions(browser);
  assert.equal(result.grantsKnown, true);
  assert.deepEqual(result.optionalPermissions, []);
  assert.ok(result.grantedPermissions.includes('notifications'));
  assert.ok(result.grantedOrigins.includes('https://dav.example.test/*'));
  assert.deepEqual(result.optionalOriginScope, ['http://*/*', 'https://*/*']);
  assert.equal(result.grantedOrigins.includes('https://*/*'), false);
  assert.equal('requestCount' in result, false, 'permission grants are not evidence of request activity');
  for (const name of [...manifest.permissions, ...manifest.optional_permissions]) assert.ok(permissionPurpose(name));
});

test('clock retirement requests no notification permission and describes any retained old grant honestly', () => {
  assert.deepEqual(manifest.optional_permissions, []);
  assert.ok(manifest.permissions.includes('alarms'), 'owned old browser reminders still need to be cleared');
  assert.equal(permissionPurpose('alarms'), '接续后台同步并清理旧版时钟提醒。');
  assert.equal(permissionLabel('alarms'), '后台任务');
  assert.equal(permissionPurpose('notifications'), '旧版时钟使用的通知权限，当前版本不再发送通知。');
});

test('unavailable or denied permission inspection stays unknown, never falsely reports no permissions or requests', async () => {
  for (const browser of [null, { runtime: { id: 'fixture', lastError: { message: 'not available' }, getManifest: () => manifest }, permissions: { getAll(callback) { callback(); } } }]) {
    const result = await readPrivacyPermissions(browser);
    assert.equal(result.grantsKnown, false);
    assert.deepEqual(result.requiredPermissions, [...manifest.permissions].sort());
    assert.deepEqual(result.grantedOrigins, []);
  }
});

test('privacy and sync setup copy has all seven packaged translations', async () => {
  const catalog = JSON.parse(await readFile(new URL('../i18n/catalog.json', import.meta.url)));
  const files = ['../components/PrivacyCheckup.jsx', './privacy-checkup.js', '../components/CloudSyncSettings.jsx'];
  const phrases = new Set(['已关闭同步，仅在本机保存数据。']);
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const [, singleQuoted, doubleQuoted] of source.matchAll(/\btr\((?:'([^'\n]+)'|"([^"\n]+)")/g)) phrases.add(singleQuoted ?? doubleQuoted);
  }
  for (const phrase of phrases) {
    for (const locale of ['en', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'ru']) assert.ok(catalog[phrase]?.[locale], `${locale}: ${phrase}`);
  }
});
