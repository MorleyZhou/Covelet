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
  assert.equal(permissionPurpose('alarms'), '清理旧版时钟留下的提醒。');
  assert.equal(permissionLabel('alarms'), '旧版提醒清理');
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

test('every newly added privacy and setup phrase has all seven packaged translations', async () => {
  const catalog = JSON.parse(await readFile(new URL('../i18n/catalog.json', import.meta.url)));
  const files = ['../components/PrivacyCheckup.jsx', './privacy-checkup.js'];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\btr\('([^']+)'/g)) {
      const phrase = match[1];
      assert.ok(catalog[phrase], phrase);
      for (const locale of ['en', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'ru']) assert.ok(catalog[phrase][locale], `${locale}: ${phrase}`);
    }
  }
  for (const phrase of ['正在读取同步设置…', '同步设置步骤', '选择渠道', '密码与首次同步', '推荐', '首次同步会检查写入权限和同步密码；失败后可重试，或仅在本机使用。', '测试时仅申请所选存储地址的访问权限。', '仅保存配置不会验证连接、开启自动同步或执行首次同步。', '首次同步成功后自动同步', '仅在本机使用', '上一步', '保存并首次同步', '下一步', '已关闭同步，仅在本机保存数据。', '隐私自查']) {
    for (const locale of ['en', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'ru']) assert.ok(catalog[phrase]?.[locale], `${locale}: ${phrase}`);
  }
});
