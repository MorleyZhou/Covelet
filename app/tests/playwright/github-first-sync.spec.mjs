import { test, expect, addSite, openSettings, openSync } from './extension.fixture.mjs';

const path = '/repos/covelet-qa/first-sync/contents/';
const token = 'synthetic-github-token-for-playwright';
const password = 'synthetic synchronization password';

test.use({ pregrantedHosts: ['https://api.github.com/*'] });

async function installGithubFixture(context, { objects, writes, onPut }) {
  await context.route(/^https:\/\/api\.github\.com\/repos\/covelet-qa\/first-sync\/contents\/fixture(?:\/|\?|$)/, async route => {
    const request = route.request();
    expect(request.headers().authorization).toBe('Bearer ' + token);
    const name = new URL(request.url()).pathname.slice(path.length);
    if (request.method() === 'PUT') {
      const bytes = Buffer.from(request.postDataJSON().content, 'base64');
      writes.push({ name, bytes });
      if (await onPut?.(route, writes.length)) return;
      objects.set(name, bytes);
      return route.fulfill({ status: 201, json: {} });
    }
    expect(request.method()).toBe('GET');
    if (objects.has(name)) return route.fulfill({ status: 200, body: objects.get(name), contentType: 'application/octet-stream' });
    if (name.endsWith('.json')) return route.fulfill({ status: 404, json: {} });
    return route.fulfill({ status: 200, json: [...objects.entries()]
      .filter(([key]) => key.startsWith(name + '/') && !key.slice(name.length + 1).includes('/'))
      .map(([key, bytes]) => ({ type: 'file', name: key.split('/').at(-1), path: key, size: bytes.length })) });
  });
}

async function githubSetup(form) {
  await form.getByRole('button', { name: 'GitHub', exact: true }).click();
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await form.getByLabel('仓库所有者', { exact: true }).fill('covelet-qa');
  await form.getByLabel('仓库名称', { exact: true }).fill('first-sync');
  await form.getByLabel('保存目录', { exact: true }).fill('fixture');
  await form.getByLabel('GitHub 访问令牌', { exact: true }).fill(token);
  await form.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(form.locator('.cloud-action-feedback')).toHaveText('连接通过，可访问仓库');
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await form.getByLabel('同步密码', { exact: true }).fill(password);
}

const containsIndex = objects => [...objects.keys()].some(key => /^fixture\/all-data-v1\/[^/]+\.json$/.test(key));

test('GitHub first sync can be dismissed, reports a failed upload and retries the saved connection', async ({ extension }) => {
  const objects = new Map(), writes = [];
  let finishUpload;
  const failedUpload = new Promise(resolve => { finishUpload = resolve; });
  await installGithubFixture(extension.context, { objects, writes, async onPut(route, attempt) {
    if (attempt !== 1) return false;
    await failedUpload;
    await route.fulfill({ status: 503, json: { message: 'PRIVATE_SERVER_RESPONSE' } });
    return true;
  } });

  const page = await extension.newtab();
  await addSite(page, 'GitHub recovery fixture', 'https://example.com/github-recovery');
  let form = await openSync(page);
  const feedback = () => form.locator('.cloud-action-feedback');
  const toast = () => page.locator('[data-slot="sync-toast"]');
  const syncRuns = () => form.locator('.cloud-sync-run-history [data-sync-run-id]');
  try {
    await githubSetup(form);
    await expect(toast().getByText('测试通过', { exact: true })).toBeVisible();
    await form.getByRole('button', { name: '保存并同步', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(form.locator('.cloud-setup-steps')).toHaveCount(0);
    await expect(feedback()).toContainText('正在同步…');
    const dialog = page.getByRole('dialog', { name: '自备存储同步', exact: true });
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
    form = await openSync(page);
    await expect(feedback()).toContainText('正在同步…');
    await expect(form.getByRole('button', { name: /^(正在同步…|立即同步)$/ })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
    finishUpload();
    await expect(toast().getByText('同步失败', { exact: true })).toBeVisible();
    await expect(toast()).toHaveAttribute('data-tone', 'error');
    await expect(toast()).toBeInViewport();
    const shownToast = await toast().elementHandle();
    form = await openSync(page);
    await expect(toast()).toHaveCount(1);
    expect(await toast().evaluate((element, previous) => element === previous, shownToast)).toBe(true);
    await expect(dialog.locator('[data-slot="sync-toast"]')).toHaveCount(0);
    await expect(page.getByRole('alert').and(toast())).toBeVisible();
    await expect(feedback()).toHaveText('存储服务暂时无法完成请求。请稍后重试。');
    await expect(syncRuns()).toHaveCount(1);
    await expect(syncRuns().getByText('同步失败', { exact: true })).toBeVisible();
    await expect(form).not.toContainText('PRIVATE_SERVER_RESPONSE');
    await expect(toast()).not.toContainText('PRIVATE_SERVER_RESPONSE');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    const layout = () => form.evaluate(element => {
      const dialog = element.closest('[role="dialog"]');
      const fields = element.querySelector('.cloud-sync-fields');
      return {
        dialog: dialog.getBoundingClientRect().toJSON(),
        form: element.getBoundingClientRect().toJSON(),
        scroll: [fields.clientWidth, fields.clientHeight, fields.scrollWidth, fields.scrollHeight, fields.scrollTop],
      };
    });
    const beforeDismiss = await layout();
    await toast().getByRole('button', { name: '关闭提示', exact: true }).click();
    await expect(toast()).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(await layout()).toEqual(beforeDismiss);
    await expect(feedback()).toHaveText('存储服务暂时无法完成请求。请稍后重试。');
    await expect(form.locator('.cloud-setup-steps')).toHaveCount(0);
    await form.getByRole('button', { name: '重试', exact: true }).click();
    await expect(feedback()).toContainText(/同步完成 · \d{1,2}:\d{2}/, { timeout: 45_000 });
    await expect(toast().getByText('同步成功', { exact: true })).toBeVisible();
    await expect(toast()).toHaveAttribute('data-tone', 'success');
    await expect(syncRuns()).toHaveCount(2);
    expect(containsIndex(objects)).toBe(true);

    await form.getByRole('button', { name: '锁定', exact: true }).click();
    await expect(form.getByLabel('GitHub 访问令牌', { exact: true })).toHaveCount(0);
    await form.getByLabel('同步密码', { exact: true }).fill(password);
    await form.getByRole('button', { name: '解锁', exact: true }).click();
    await expect(form.locator('.connection-state')).toHaveText('已解锁');
    const syncNow = form.getByRole('button', { name: '立即同步', exact: true });
    await syncNow.click();
    await expect(feedback()).toContainText(/同步完成 · \d{1,2}:\d{2}/, { timeout: 45_000 });
    await expect(toast().getByText('同步成功', { exact: true })).toBeVisible();
    await expect(syncRuns()).toHaveCount(3);
    await expect(syncNow).toBeEnabled();
    const anotherTab = await extension.newtab();
    const anotherForm = await openSync(anotherTab);
    await expect(anotherForm.locator('.cloud-sync-run-history [data-sync-run-id]')).toHaveCount(3);
  } finally { finishUpload(); }
});

test('the background sync finishes after its Covelet tab is closed', async ({ extension }) => {
  const objects = new Map(), writes = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await installGithubFixture(extension.context, { objects, writes, async onPut(_route, attempt) {
    if (attempt === 1) await gate;
  } });
  // Leave a plain page open so closing the last Covelet tab does not exit Chromium.
  const plainPage = await extension.context.newPage();
  const page = await extension.newtab();
  for (const other of extension.context.pages()) {
    if (other !== page && other.url().startsWith('chrome-extension:')) await other.close();
  }
  try {
    await addSite(page, 'Background sync fixture', 'https://example.com/background-sync');
    const form = await openSync(page);
    await githubSetup(form);
    await form.getByRole('button', { name: '保存并同步', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
    const appearance = await openSettings(page, '外观');
    await expect(appearance.getByRole('combobox', { name: '主题', exact: true })).toBeEnabled();
    await page.close();
    expect(extension.context.pages().every(tab => !tab.url().startsWith('chrome-extension:'))).toBe(true);
    release();
    await expect.poll(() => containsIndex(objects), { timeout: 45_000 }).toBe(true);
    const reopened = await extension.newtab();
    const resumedForm = await openSync(reopened);
    await expect(resumedForm.locator('[data-sync-run-id]')).toHaveCount(1);
    await expect(resumedForm.locator('[data-sync-run-id]')).toContainText('同步成功');
  } finally { release(); await plainPage.close(); }
});

test('interrupted browser sync resumes the exact ciphertext after restart and unlock', async ({ extension }) => {
  test.setTimeout(120_000);
  const objects = new Map(), writes = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await installGithubFixture(extension.context, { objects, writes, async onPut(route, attempt) {
    if (attempt !== 1) return false;
    await gate;
    await route.abort('failed').catch(() => {});
    return true;
  } });
  try {
    const page = await extension.newtab();
    await addSite(page, 'Resumable sync fixture', 'https://example.com/resume-sync');
    const form = await openSync(page);
    await githubSetup(form);
    await form.getByRole('button', { name: '保存并同步', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    const original = writes[0];
    expect(objects.size).toBe(0);

    const restarted = await extension.restart();
    release();
    expect(restarted.id).toBe(extension.id);
    await installGithubFixture(restarted.context, { objects, writes });
    const reopened = await restarted.newtab(), resumedForm = await openSync(reopened);
    await expect(resumedForm.getByText('同步已锁定', { exact: true })).toBeVisible();
    expect(writes).toHaveLength(1);
    await resumedForm.getByLabel('同步密码', { exact: true }).fill(password);
    await resumedForm.getByRole('button', { name: '解锁', exact: true }).click();
    await expect.poll(() => containsIndex(objects), { timeout: 60_000 }).toBe(true);
    expect(writes[1].name).toBe(original.name);
    expect(writes[1].bytes.equals(original.bytes)).toBe(true);
    await expect(resumedForm.locator('[data-sync-run-id]').first()).toContainText('同步成功', { timeout: 45_000 });
    await expect(reopened.locator('.site-name').filter({ hasText: 'Resumable sync fixture' })).toBeVisible();
  } finally { release(); }
});
