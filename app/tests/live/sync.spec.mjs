import { test, expect, chromium } from '@playwright/test';
import { readFile, writeFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, basename, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const configPath = process.env.COVELET_QA_CONFIG;
let configs = {};
if (configPath) {
  const contents = await readFile(configPath, 'utf8');
  try { configs = JSON.parse(contents.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Local live-test configuration is not valid JSON. Check it locally; do not paste credentials into a report.'); }
}
const build = fileURLToPath(new URL('../../dist/extension/', import.meta.url));
const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17);
const providerNames = { github: 'GitHub', gitlab: 'GitLab', r2: 'Cloudflare R2', oss: '阿里云 OSS' };
const cli = (args) => {
  try { return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
  catch { throw new Error('GitHub CLI authentication or QA branch operation failed. Check gh locally.'); }
};

async function settings(page) {
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('tab', { name: '数据', exact: true }).click();
  await page.getByRole('button', { name: '自备存储同步（Beta）', exact: true }).click();
  return page.locator('.cloud-sync-form');
}
async function fillSecret(form, name, value) {
  // Never forward Playwright's fill call log, which can contain its argument.
  try { await form.getByLabel(name, { exact: true }).fill(value); }
  catch { throw new Error('Could not enter a live-test credential. Check the field locally.'); }
}
async function configure(page, provider, config, token, password) {
  const form = await settings(page);
  await form.locator('.cloud-channel-option').filter({ hasText: providerNames[provider] }).click();
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  const fill = (name, value) => form.getByLabel(name, { exact: true }).fill(value);
  const secret = (name, value) => fillSecret(form, name, value);
  if (provider === 'github') {
    await fill('仓库所有者', config.owner); await fill('仓库名称', config.repo); await fill('分支', config.branch || 'main');
  } else if (provider === 'gitlab') {
    await fill('GitLab 服务地址', config.endpoint); await fill('项目 ID 或完整路径', String(config.project)); await fill('分支', config.branch || 'main');
  } else {
    await fill(provider === 'r2' ? '账户 API 地址' : 'Bucket 访问域名', config.endpoint); await fill('Bucket 名称', config.bucket);
    if (provider === 'oss') await fill('地域', config.region);
  }
  await fill('保存目录', config.prefix);
  if (['github', 'gitlab'].includes(provider)) await secret(`${providerNames[provider]} 访问令牌`, token);
  else {
    await secret('Access Key ID', config.accessKeyId); await secret('Secret Access Key', config.secretAccessKey);
    if (config.sessionToken) {
      await form.getByRole('button', { name: '临时安全令牌', exact: true }).click();
      await secret('临时安全令牌', config.sessionToken);
    }
  }
  await form.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(form).toContainText('最近连接测试通过', { timeout: 45_000 });
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await secret('同步密码', password);
  await form.getByRole('button', { name: '保存并首次同步', exact: true }).click();
  await expect(form.locator('.cloud-setup-steps')).toHaveCount(0, { timeout: 90_000 });
  await expect(form).toContainText('最近同步：', { timeout: 90_000 });
  // The status can render before the async persistence/finally clears busy.
  // Escape is deliberately ignored while that final write is still running.
  await expect(form.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
}
async function sync(page) {
  const form = await settings(page);
  const button = form.getByRole('button', { name: '立即同步', exact: true });
  await button.click();
  // Error dialogs make the underlying form inaccessible. Notice that outcome
  // immediately instead of waiting for an aria-hidden button for 90 seconds.
  await expect.poll(async () => {
    if (await page.getByRole('alertdialog').count()) return 'error';
    return await button.count() && await button.isEnabled() ? 'idle' : 'busy';
  }, { timeout: 90_000 }).not.toBe('busy');
  const errorDialog = page.getByRole('alertdialog');
  if (await errorDialog.count()) throw new Error(`Live sync failed: ${await errorDialog.innerText()}`);
  await expect(form).toContainText('最近同步：');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(form.locator('.cloud-tool-sync-status')).toContainText('待同步：0 项');
  await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
}
async function addSite(page, name, path = 'covelet-qa') {
  await page.getByRole('button', { name: '添加网站', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加网站', exact: true });
  await dialog.getByLabel('网址', { exact: true }).fill(`https://example.com/${path}`);
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function rename(page, name) {
  await page.locator('.site-name').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑网站', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function dispose(path) {
  expect(dirname(resolve(path))).toBe(resolve(tmpdir()));
  expect(basename(path)).toMatch(/^covelet-live-/);
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

for (const provider of Object.keys(providerNames)) {
  test(`${provider}: real service / two isolated extension profiles / bidirectional and repeated sync`, async () => {
    test.skip(!configs[provider]?.enabled, 'No dedicated local test resource configured');
    const config = { ...configs[provider] };
    // Never use the normal sync directory. A unique prefix protects both real
    // data and parallel/repeated QA runs, including when a prior run failed.
    config.prefix = `${config.prefix || 'Covelet-QA'}/${runId}`;
    const token = provider === 'github' && config.tokenSource === 'gh' ? cli(['auth', 'token']) : config.token;
    const origin = provider === 'github' ? 'https://api.github.com' : new URL(config.endpoint).origin;
    let qaBranch, artifact;
    const sessions = [];
    const profiles = new Set();
    let writes = 0, stage = 'launch';
    const responses = {};
    const at = (name) => { stage = name; console.log(`[${provider}] ${name}`); };
    try {
      if (provider === 'github' && config.tokenSource === 'gh') {
        const sha = cli(['api', `repos/${config.owner}/${config.repo}/git/ref/heads/${config.branch || 'main'}`, '--jq', '.object.sha']);
        qaBranch = `covelet-qa/${runId}`; config.branch = qaBranch;
        cli(['api', `repos/${config.owner}/${config.repo}/git/refs`, '-f', `ref=refs/heads/${qaBranch}`, '-f', `sha=${sha}`]);
      }
      artifact = await mkdtemp(join(tmpdir(), 'covelet-live-build-'));
      await cp(build, artifact, { recursive: true });
      const manifestPath = join(artifact, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      // Test-only copy grants the exact test origin. Production permissions are
      // untouched. This suite tests sync, not the native permission prompt.
      manifest.host_permissions = [...new Set([...manifest.host_permissions, `${origin}/*`])];
      await writeFile(manifestPath, JSON.stringify(manifest));
      async function launch(profile) {
        const path = profile || await mkdtemp(join(tmpdir(), 'covelet-live-profile-'));
        profiles.add(path);
        const context = await chromium.launchPersistentContext(path, { channel: 'chromium', headless: true,
          locale: 'zh-CN', args: [`--disable-extensions-except=${artifact}`, `--load-extension=${artifact}`, '--lang=zh-CN', '--no-first-run', '--disable-background-networking'] });
        const session = { context, path }; sessions.push(session);
        context.on('response', response => {
          if (new URL(response.url()).origin !== origin) return;
          const key = `${response.request().method()} ${response.status()}`;
          responses[key] = (responses[key] || 0) + 1;
        });
        // Real credentials are never recorded in traces, screenshots or logs.
        // Wallpaper and explicit icon operations are irrelevant to this suite.
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin === origin && ['PUT', 'POST', 'DELETE'].includes(route.request().method())) writes++;
          return url.origin === origin || !['http:', 'https:'].includes(url.protocol) ? route.continue() : route.abort();
        });
        let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const id = await worker.evaluate(() => chrome.runtime.id);
        const identity = await worker.evaluate(() => chrome.runtime.getManifest());
        expect(identity.name).toBe('Covelet'); expect(identity.chrome_url_overrides.newtab).toBe('newtab.html');
        const page = await context.newPage(); await page.goto(`chrome-extension://${id}/newtab.html`);
        await expect(page.getByRole('combobox', { name: '搜索或输入网址' })).toBeVisible();
        session.page = page; return session;
      }
      const a = await launch(), b = await launch(), password = `Covelet-live-${runId}-password`;
      await addSite(a.page, 'QA from profile A');
      at('profile A first sync');
      await configure(a.page, provider, config, token, password);
      at('profile B first sync');
      await configure(b.page, provider, config, token, password);
      at('bidirectional edits');
      await sync(a.page); await sync(b.page);
      await expect(b.page.locator('.site-name')).toHaveText('QA from profile A');
      await rename(b.page, 'QA from profile B'); await sync(b.page); await sync(a.page);
      await expect(a.page.locator('.site-name')).toHaveText('QA from profile B');
      const beforeRepeat = writes;
      at('repeat without new writes');
      await sync(a.page); await sync(b.page);
      await expect(b.page.locator('.site-name')).toHaveText('QA from profile B');
      expect(writes).toBe(beforeRepeat);
      // Both profiles edit the same entire navigation record before syncing.
      // A shortcut added only by B must disappear if B explicitly adopts A.
      await rename(a.page, 'QA chosen A'); await rename(b.page, 'QA retained B');
      await addSite(b.page, 'QA B-only shortcut', 'covelet-qa-b-only');
      at('publish concurrent A'); await sync(a.page);
      at('publish concurrent B'); await sync(b.page);
      await expect(b.page.locator('.site-name')).toHaveText(['QA retained B', 'QA B-only shortcut']);
      const conflicts = await settings(b.page);
      at('choose one whole record');
      await conflicts.getByRole('button', { name: '查看并选择版本', exact: true }).first().click();
      const choice = b.page.getByRole('alertdialog', { name: '选择保留的版本', exact: true });
      await expect(choice.locator('.prompt-dialog-actions button').last()).toBeDisabled();
      await choice.locator('.cloud-conflict-sides').getByRole('button', { name: '采用云端版本', exact: true }).click();
      await choice.locator('.prompt-dialog-actions').getByRole('button', { name: '采用云端版本', exact: true }).click();
      await expect(choice).toBeHidden();
      await expect(conflicts.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled();
      await b.page.keyboard.press('Escape'); await expect(conflicts).toHaveCount(0);
      await sync(b.page); await sync(a.page);
      await expect(a.page.locator('.site-name')).toHaveText('QA chosen A');
      await expect(b.page.locator('.site-name')).toHaveText('QA chosen A');
      // Browser restart must keep records while clearing session credentials.
      at('restart and unlock');
      await a.context.close(); a.context = null;
      const restarted = await launch(a.path);
      await expect(restarted.page.locator('.site-name')).toHaveText('QA chosen A');
      const locked = await settings(restarted.page);
      await expect(locked).toContainText('需解锁');
      const credentialNames = ['github', 'gitlab'].includes(provider) ? [`${providerNames[provider]} 访问令牌`] : ['Access Key ID', 'Secret Access Key'];
      for (const name of [...credentialNames, '同步密码']) {
        expect((await locked.getByLabel(name, { exact: true }).inputValue()) === '', `${name} must be empty after browser restart`).toBe(true);
      }
      if (['github', 'gitlab'].includes(provider)) await fillSecret(locked, credentialNames[0], token);
      else {
        await fillSecret(locked, 'Access Key ID', config.accessKeyId); await fillSecret(locked, 'Secret Access Key', config.secretAccessKey);
        if (config.sessionToken) {
          await locked.getByRole('button', { name: '临时安全令牌', exact: true }).click();
          await fillSecret(locked, '临时安全令牌', config.sessionToken);
        }
      }
      await fillSecret(locked, '同步密码', password);
      await locked.getByRole('button', { name: '解锁', exact: true }).click();
      await expect(locked).toContainText('已解锁'); await expect(restarted.page.getByRole('alertdialog')).toHaveCount(0);
      await expect(locked.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled();
      await restarted.page.keyboard.press('Escape'); await expect(locked).toHaveCount(0);
      await sync(restarted.page);
      await expect(restarted.page.locator('.site-name')).toHaveText('QA chosen A');
    } catch (error) {
      // Application error text is already filtered by the production safe-error
      // boundary. Never include inputs, URLs, request headers or response bodies.
      const dialogs = [];
      for (const session of sessions) if (session.context) for (const page of session.context.pages()) {
        const messages = await page.locator('[role="alertdialog"], .cloud-setup-error').allInnerTexts().catch(() => []);
        dialogs.push(...messages);
      }
      console.log(JSON.stringify({ provider, stage, responses, dialogs }));
      throw error;
    } finally {
      const closed = await Promise.allSettled(sessions.filter(item => item.context).map(item => item.context.close()));
      const removed = await Promise.allSettled([...profiles, ...(artifact ? [artifact] : [])].map(dispose));
      // Delete only the exact synthetic branch created by this run. Never touch
      // the existing default branch, files or the user's configured sync prefix.
      if (qaBranch) cli(['api', '--method', 'DELETE', `repos/${config.owner}/${config.repo}/git/refs/heads/${qaBranch}`]);
      if ([...closed, ...removed].some(result => result.status === 'rejected')) throw new Error('Live-test temporary resource cleanup was incomplete. Check the test-owned temporary directories locally.');
    }
  });
}
