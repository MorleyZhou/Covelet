import { test, expect, chromium } from '@playwright/test';
import { readFile, writeFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, basename, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const configPath = process.env.COVELET_QA_CONFIG;
let configs = {};
if (configPath) {
  const contents = await readFile(configPath, 'utf8');
  try { configs = JSON.parse(contents.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Local live-test configuration is not valid JSON. Check it locally; do not paste credentials into a report.'); }
}
const build = fileURLToPath(new URL('../../dist/extension/', import.meta.url));
export const providerNames = { github: 'GitHub', gitlab: 'GitLab', r2: 'Cloudflare R2', oss: '阿里云 OSS' };
// Current user scope: future real-service acceptance uses GitHub only.
// Other adapters remain covered by deterministic protocol/unit fixtures.
export const LIVE_TEST_PROVIDERS = Object.freeze(['github']);
const secretValues = new Set();
const redact = value => {
  let text = String(value);
  for (const secret of secretValues) if (secret) text = text.split(secret).join('[REDACTED-CREDENTIAL]');
  return text;
};
export function safeLiveError(error) {
  // Locator assertions may attach a full form ARIA snapshot in matcherResult,
  // independently of Playwright's fallback snapshot switch. Never forward that
  // object or its cause to the runner; retain a redacted plain message only.
  return new Error(redact(error instanceof Error ? error.message : 'Live acceptance failed.'));
}
const cli = (args) => {
  try { return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
  catch { throw new Error('GitHub CLI authentication or QA branch operation failed. Check gh locally.'); }
};

export async function settings(page) {
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('tab', { name: '数据', exact: true }).click();
  await page.getByRole('button', { name: '自备存储同步（Beta）', exact: true }).click();
  return page.locator('.cloud-sync-form');
}
export async function fillSecret(form, name, value) {
  if (typeof value === 'string') secretValues.add(value);
  // Never forward Playwright's fill call log, which can contain its argument.
  try { await form.getByLabel(name, { exact: true }).fill(value); }
  catch { throw new Error('Could not enter a live-test credential. Check the field locally.'); }
}
export async function configure(page, provider, config, token, password) {
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
export async function sync(page, { failure } = {}) {
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
  if (await errorDialog.count()) {
    const message = await errorDialog.innerText();
    if (!failure) throw new Error(`Live sync failed: ${message}`);
    expect(message).toMatch(failure);
    const pending = await form.locator('.cloud-tool-sync-status').innerText();
    await errorDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(errorDialog).toBeHidden();
    await expect(button).toBeEnabled();
    await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
    return { message, pending };
  }
  if (failure) throw new Error('The expected live-sync failure did not occur.');
  await expect(form).toContainText('最近同步：');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(form.locator('.cloud-tool-sync-status')).toContainText('待同步：0 项');
  await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
}
export async function unlock(page, provider, config, token, password) {
  const form = await settings(page);
  await expect(form).toContainText('需解锁');
  const names = ['github', 'gitlab'].includes(provider) ? [`${providerNames[provider]} 访问令牌`] : ['Access Key ID', 'Secret Access Key'];
  for (const name of [...names, '同步密码']) {
    expect((await form.getByLabel(name, { exact: true }).inputValue()) === '', `${name} must be empty after browser restart`).toBe(true);
  }
  if (['github', 'gitlab'].includes(provider)) await fillSecret(form, names[0], token);
  else {
    await fillSecret(form, 'Access Key ID', config.accessKeyId); await fillSecret(form, 'Secret Access Key', config.secretAccessKey);
    if (config.sessionToken) {
      await form.getByRole('button', { name: '临时安全令牌', exact: true }).click();
      await fillSecret(form, '临时安全令牌', config.sessionToken);
    }
  }
  await fillSecret(form, '同步密码', password);
  await form.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(form).toContainText('已解锁'); await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(form.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
}
export async function addSite(page, name, path = 'covelet-qa') {
  await page.getByRole('button', { name: '添加网站', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加网站', exact: true });
  await dialog.getByLabel('网址', { exact: true }).fill(`https://example.com/${path}`);
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog).toBeHidden();
}
export async function rename(page, name) {
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

export async function withLiveSession(provider, scenario) {
  test.skip(!LIVE_TEST_PROVIDERS.includes(provider), 'Live provider deferred by the user');
  test.skip(!configs[provider]?.enabled, 'No dedicated local test resource configured');
  const config = { ...configs[provider] };
  const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17) + '-' + randomUUID().slice(0, 8);
  // Never use the normal sync directory. A unique prefix protects both real
  // data and parallel/repeated QA runs, including when a prior run failed.
  config.prefix = `${config.prefix || 'Covelet-QA'}/${runId}`;
  const token = provider === 'github' && config.tokenSource === 'gh' ? cli(['auth', 'token']) : config.token;
  const origin = provider === 'github' ? 'https://api.github.com' : new URL(config.endpoint).origin;
  let qaBranch, artifact;
  const sessions = [];
  const profiles = new Set();
  let writes = 0, stage = 'launch';
  const writeAttempts = new Map();
  const fault = { armed: false, used: false, status: null, url: null, digest: null, fetchFailed: false, reconciledRead: false };
  const responses = {};
  const at = (name) => { stage = name; console.log(`[${provider}] ${name}`); };
  try {
    if (provider === 'github' && config.tokenSource === 'gh') {
      const sha = cli(['api', `repos/${config.owner}/${config.repo}/git/ref/heads/${config.branch || 'main'}`, '--jq', '.object.sha']);
      const candidate = `covelet-qa/${runId}`;
      cli(['api', `repos/${config.owner}/${config.repo}/git/refs`, '-f', `ref=refs/heads/${candidate}`, '-f', `sha=${sha}`]);
      qaBranch = candidate; config.branch = candidate;
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
      context.on('response', async response => {
        if (new URL(response.url()).origin !== origin) return;
        const key = `${response.request().method()} ${response.status()}`;
        responses[key] = (responses[key] || 0) + 1;
        const objectPath = value => new URL(value).pathname.replace(provider === 'gitlab' ? /\/raw$/ : /$^/, '');
        if (fault.url && response.request().method() === 'GET' && response.ok() && objectPath(response.url()) === objectPath(fault.url)) {
          try {
            const digest = createHash('sha256').update(await response.body()).digest('hex');
            if (digest === fault.digest) fault.reconciledRead = true;
          } catch { /* A missing read acknowledgement must fail the assertion. */ }
        }
      });
      // Real credentials are never recorded in traces, screenshots or logs.
      // Wallpaper and explicit icon operations are irrelevant to this suite.
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && ['PUT', 'POST', 'DELETE'].includes(route.request().method())) {
          writes++;
          writeAttempts.set(url.href, (writeAttempts.get(url.href) || 0) + 1);
          if (fault.armed && !fault.used && ['PUT', 'POST'].includes(route.request().method()) && decodeURIComponent(url.pathname).includes('/blobs/')) {
            fault.used = true; fault.url = url.href;
            let ciphertext = route.request().postDataBuffer() || Buffer.alloc(0);
            if (['github', 'gitlab'].includes(provider)) {
              try { ciphertext = Buffer.from(JSON.parse(ciphertext.toString('utf8')).content, 'base64'); }
              catch { fault.fetchFailed = true; return route.abort('failed'); }
            }
            fault.digest = createHash('sha256').update(ciphertext).digest('hex');
            try {
              // Reach the real provider, then discard its successful response.
              // Catch the original API error: it may contain credential headers.
              const response = await route.fetch({ maxRedirects: 0, timeout: 30_000 });
              fault.status = response.status();
              if (response.ok()) return route.abort('timedout');
              return route.fulfill({ response });
            } catch {
              fault.fetchFailed = true;
              return route.abort('failed');
            }
          }
        }
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
    await scenario({ launch, config, token, runId, at,
      armCommitDrop() { fault.armed = true; },
      state: { get writes() { return writes; }, get lostWrite() { return { used: fault.used, status: fault.status, digest: fault.digest, fetchFailed: fault.fetchFailed, reconciledRead: fault.reconciledRead,
        attempts: fault.url ? writeAttempts.get(fault.url) : 0 }; } } });
  } catch (error) {
    // Application error text is already filtered by the production safe-error
    // boundary. Never include inputs, URLs, request headers or response bodies.
    const dialogs = [];
    for (const session of sessions) if (session.context) for (const page of session.context.pages()) {
      const messages = await page.locator('[role="alertdialog"], .cloud-setup-error').allInnerTexts().catch(() => []);
      dialogs.push(...messages);
    }
    console.log(redact(JSON.stringify({ provider, stage, responses, dialogs })));
    throw safeLiveError(error);
  } finally {
    const closed = await Promise.allSettled(sessions.filter(item => item.context).map(item => item.context.close()));
    const removed = await Promise.allSettled([...profiles, ...(artifact ? [artifact] : [])].map(dispose));
    // Delete only the exact synthetic branch created by this run. Never touch
    // the existing default branch, files or the user's configured sync prefix.
    if (qaBranch) cli(['api', '--method', 'DELETE', `repos/${config.owner}/${config.repo}/git/refs/heads/${qaBranch}`]);
    if ([...closed, ...removed].some(result => result.status === 'rejected')) throw new Error('Live-test temporary resource cleanup was incomplete. Check the test-owned temporary directories locally.');
  }
}
