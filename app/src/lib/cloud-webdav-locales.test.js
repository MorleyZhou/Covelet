import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES, setLanguagePreference } from '../i18n/index.js';
import catalog from '../i18n/catalog.json' with { type: 'json' };
import { createWebdavProvider, validateWebdavConfig } from './cloud-webdav.js';
import { localData } from './local-data.js';

test('every active WebDAV error has a packaged translation in all supported languages', async () => {
  const source = await readFile(new URL('./cloud-webdav.js', import.meta.url), 'utf8');
  const keys = new Set([...source.matchAll(/tr\(["']([^"']+)["']/g)].map(match => match[1]));
  assert.ok(keys.size > 20, 'cover the actual transport error messages');
  for (const key of keys) {
    for (const { value: language } of LANGUAGES.filter(item => item.value !== 'zh-CN')) {
      assert.equal(typeof catalog[key]?.[language], 'string', `${language}: ${key}`);
      assert.ok(catalog[key][language].trim(), `${language}: ${key}`);
    }
  }
});

test('WebDAV validation and authentication failures use the selected language without exposing secrets', async () => {
  const invalid = 'WebDAV 地址无效：请填写 HTTPS 基目录地址，不要使用分享链接、查询参数或带密码的地址。';
  const unauthorized = '登录失败。请检查用户名和应用密码。';
  const secret = 'PRIVATE-APP-PASSWORD';
  const write = localData.set;
  localData.set = async () => {}; // This test changes locale only, without IndexedDB.
  try {
    for (const { value: language } of LANGUAGES) {
      await setLanguagePreference(language);
      assert.throws(() => validateWebdavConfig({ provider: 'webdav', endpoint: `http://user:${secret}@private.test/` }), error => {
        assert.equal(error.code, 'CLOUD_INVALID_CONFIG');
        assert.equal(error.message, language === 'zh-CN' ? invalid : catalog[invalid][language]);
        assert.ok(!error.message.includes(secret));
        return true;
      });
      const provider = createWebdavProvider({ provider: 'webdav', endpoint: 'https://private.test/dav/', prefix: 'covelet' },
        { username: 'private-user', appPassword: secret }, {
          signer: { sha256() { throw Error('The read-only test must not hash or upload data.'); } },
          fetcher: async () => new Response(secret, { status: 401 }),
        });
      await assert.rejects(provider.testConnection(), error => {
        assert.equal(error.code, 'CLOUD_AUTH');
        assert.equal(error.message, language === 'zh-CN' ? unauthorized : catalog[unauthorized][language]);
        assert.ok(!error.message.includes(secret));
        return true;
      });
    }
  } finally {
    await setLanguagePreference('zh-CN');
    localData.set = write;
  }
});
