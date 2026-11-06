import { test, expect, openSync, addSite } from './extension.fixture.mjs';
import { WEBDAV_BASE } from './network.mjs';
import { createNote, exportCompleteBackup, makeImagePNG, uploadedSiteImage } from './backup-helpers.mjs';

const syncPassword = 'PLAYWRIGHT-SYNC-PASSWORD';
const badLogin = '登录失败。请检查用户名和应用密码。';
const actionFeedback = form => form.locator('.cloud-action-feedback');
const syncRuns = form => form.locator('.cloud-sync-run-history [data-sync-run-id]');
const choiceLabel = side => side === 'local' ? '以本地为准' : '以云端为准';
const conflictRun = form => syncRuns(form).filter({ has: form.page().getByRole('group', { name: '选择同步版本', exact: true }) });
async function expectSyncToast(page, tone, title, detail) {
  const toast = page.locator(`[data-slot="sync-toast"][data-tone="${tone}"]`);
  await expect(toast.getByText(title, { exact: true })).toBeVisible();
  await expect(page.getByRole(tone === 'error' ? 'alert' : 'status').and(toast)).toBeVisible();
  await expect(toast).toBeInViewport({ ratio: 0.8 });
  await expect(toast).toHaveCSS('position', 'fixed');
  await expect(page.getByRole('dialog').locator('[data-slot="sync-toast"]')).toHaveCount(0);
  const { width, height } = page.viewportSize();
  const bounds = await toast.boundingBox();
  expect(width - bounds.x - bounds.width).toBeLessThan(40);
  expect(height - bounds.y - bounds.height).toBeLessThan(40);
  if (detail) await expect(toast).toContainText(detail);
}
async function configure(page, { saveOnly = false } = {}) {
  const form = await openSync(page);
  await expect(form.locator('.cloud-channel-option[aria-pressed="true"]')).toContainText('WebDAV');
  await expect(form.locator('.cloud-channel-option')).toHaveCount(5);
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await form.getByLabel('服务器地址', { exact: true }).fill(WEBDAV_BASE);
  await form.getByLabel('保存目录', { exact: true }).fill('proof');
  await form.getByLabel('用户名', { exact: true }).fill('PLAYWRIGHT-USER');
  await form.getByLabel('应用密码', { exact: true }).fill('PLAYWRIGHT-APP-PASSWORD');
  await form.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(actionFeedback(form)).toContainText('连接通过，可读取目录');
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await form.getByLabel('同步密码', { exact: true }).fill(syncPassword);
  await form.getByRole('button', { name: saveOnly ? '仅保存' : '保存并同步', exact: true }).click();
  await expect(form.locator('.cloud-setup-steps')).toHaveCount(0, { timeout: 45_000 });
  if (!saveOnly) await expect(actionFeedback(form)).toContainText('同步完成 ·', { timeout: 45_000 });
  return form;
}
async function closeSync(page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('.cloud-sync-form')).toHaveCount(0);
}
async function syncNow(form) {
  const button = form.getByRole('button', { name: '立即同步', exact: true });
  await button.click();
  await expect(actionFeedback(form)).toContainText('同步完成 ·', { timeout: 45_000 });
  await expect(button).toBeEnabled({ timeout: 45_000 });
  await expect(form.locator('.cloud-tool-sync-status')).toBeVisible();
}
async function editSite(page, currentName, nextName) {
  await page.locator('.site-name').filter({ hasText: currentName }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑网站', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill(nextName);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('WebDAV test and sync show visible toasts, keep saving independent, and route 401 to configuration', async ({ extension, network }, testInfo) => {
  const page = await extension.newtab();
  await page.setViewportSize({ width: 390, height: 640 });
  const form = await openSync(page);
  const feedback = actionFeedback(form);
  const activeStep = form.locator('.cloud-setup-steps [aria-current="step"]');
  await expect(activeStep).toContainText('选择存储');
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(activeStep).toContainText('测试连接');
  await form.getByLabel('服务器地址', { exact: true }).fill(WEBDAV_BASE);
  await form.getByLabel('用户名', { exact: true }).fill('PLAYWRIGHT-USER');
  const appPassword = form.getByLabel('应用密码', { exact: true });
  await appPassword.fill('PLAYWRIGHT-APP-PASSWORD');
  network.setAuthFailure(true);
  let releaseTest;
  const pendingTest = new Promise(resolve => { releaseTest = resolve; });
  await extension.context.route(url => url.href.startsWith(WEBDAV_BASE), async route => {
    await pendingTest;
    return route.fallback();
  }, { times: 1 });
  try {
    await form.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(feedback).toContainText('正在测试连接…');
    await expect(feedback).toBeInViewport();
  } finally { releaseTest(); }
  await expect(feedback).toHaveText(badLogin);
  await expect(feedback).toBeInViewport();
  await expectSyncToast(page, 'error', '测试失败', badLogin);
  await expect(form.getByRole('status').filter({ hasText: badLogin })).toHaveCount(1);
  await expect(form).not.toContainText('FIXTURE_PRIVATE_RESPONSE');
  await expect(form.getByRole('button', { name: '下一步', exact: true })).toBeDisabled();
  network.setAuthFailure(false);
  const edit = form.getByRole('button', { name: '修改配置', exact: true });
  await expect(edit).toBeInViewport();
  await edit.click({ trial: true, timeout: 2000 });
  const beforeEdit = network.requests.length;
  await edit.click();
  await expect(appPassword).toBeFocused();
  expect(network.requests.length).toBe(beforeEdit);
  await form.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(feedback).toContainText('连接通过，可读取目录');
  await expect(feedback).toBeInViewport();
  await expectSyncToast(page, 'success', '测试通过');
  await testInfo.attach('connection-test-passed-390', { body: await page.screenshot(), contentType: 'image/png' });
  expect(network.requests.filter(item => item.url.startsWith(WEBDAV_BASE)).every(item => item.method === 'PROPFIND')).toBe(true);
  expect(network.objects.size).toBe(0);
  await expect(form.getByLabel('同步密码', { exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(activeStep).toContainText('设置同步密码');
  await form.getByLabel('同步密码', { exact: true }).fill(syncPassword);
  const before = network.requests.length;
  await form.getByRole('button', { name: '仅保存', exact: true }).click();
  await expect(form.locator('.cloud-setup-steps')).toHaveCount(0);
  await expect(feedback).toContainText('配置已保存，尚未同步');
  await expect(form.getByText('已通过', { exact: true })).toBeVisible();
  await expect(syncRuns(form)).toHaveCount(0);
  expect(network.requests.length).toBe(before);
  expect(network.objects.size).toBe(0);
  await form.getByRole('button', { name: '锁定', exact: true }).click();
  await expect(form.getByText('同步已锁定', { exact: true })).toBeVisible();
  await expect(form.getByLabel('用户名', { exact: true })).toHaveCount(0);
  await expect(form.getByLabel('应用密码', { exact: true })).toHaveCount(0);
  await form.getByLabel('同步密码', { exact: true }).fill(syncPassword);
  const beforeUnverifiedUnlock = network.requests.length;
  await form.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(form.getByText('待测试', { exact: true })).toBeVisible();
  expect(network.requests.length).toBe(beforeUnverifiedUnlock);

  const sync = form.getByRole('button', { name: '立即同步', exact: true });
  await sync.click();
  await expect(feedback).toContainText('同步完成 ·', { timeout: 45_000 });
  await expectSyncToast(page, 'success', '同步成功');
  await expect(syncRuns(form)).toHaveCount(1);
  await expect(syncRuns(form).getByText('同步成功', { exact: true })).toHaveCount(1);
  await expect(form.locator('.cloud-tool-sync-status')).not.toContainText('待同步：');
  const lastSuccess = form.getByText(/^上次成功 ·/);
  const timestamp = await lastSuccess.innerText();
  network.setAuthFailure(true);
  await sync.click();
  await expect(feedback).toHaveText(badLogin);
  await expect(feedback).toBeInViewport();
  await expectSyncToast(page, 'error', '同步失败', badLogin);
  await expect(syncRuns(form)).toHaveCount(2);
  await expect(syncRuns(form).getByText('同步失败', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(lastSuccess).toHaveText(timestamp);
  await expect(edit).toHaveCount(1);
  await form.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(feedback).toHaveText(badLogin);
  await expectSyncToast(page, 'error', '测试失败', badLogin);
  await expect(form.getByText('未通过', { exact: true })).toBeVisible();
  await expect(syncRuns(form)).toHaveCount(2);
  const beforeManagedEdit = network.requests.length;
  await edit.click();
  await expect(activeStep).toContainText('测试连接');
  await expect(appPassword).toBeVisible();
  expect(network.requests.length).toBe(beforeManagedEdit);
});

async function chooseWholeSide(form, side) {
  const label = choiceLabel(side);
  const run = conflictRun(form);
  await expect(run).toHaveCount(1);
  await expect(run.getByRole('button', { name: label, exact: true })).toBeEnabled();
  await run.getByRole('button', { name: label, exact: true }).click();
  await expect(conflictRun(form)).toHaveCount(0, { timeout: 45_000 });
  await expect(syncRuns(form).first()).toContainText('同步成功', { timeout: 45_000 });
}

for (const winner of ['local', 'remote']) {
  test(`choosing ${winner} replaces the entire conflicting snapshot with one resolution`, async ({ extension, network }) => {
    test.setTimeout(180_000);
    const local = await extension.newtab();
    await addSite(local, 'COMMON_BASE_SITE', 'https://example.com/common-sync-base');
    await configure(local);
    await closeSync(local);

    const remoteDevice = await extension.launch();
    const remote = await remoteDevice.newtab();
    let remoteForm = await configure(remote, { saveOnly: true });
    await remoteForm.getByRole('button', { name: '立即同步', exact: true }).click();
    await expect(syncRuns(remoteForm)).toHaveCount(1, { timeout: 45_000 });
    if (await conflictRun(remoteForm).count()) await chooseWholeSide(remoteForm, 'remote');
    await closeSync(remote);
    await expect(remote.locator('.site-name').filter({ hasText: 'COMMON_BASE_SITE' })).toBeVisible();

    await editSite(local, 'COMMON_BASE_SITE', 'LOCAL_BRANCH_SITE');
    await editSite(remote, 'COMMON_BASE_SITE', 'CLOUD_BRANCH_SITE');
    const localOnly = 'LOCAL_ONLY_ASSET', cloudOnly = 'CLOUD_ONLY_ASSET';
    const localImage = await uploadedSiteImage(local, { name: localOnly, url: 'https://example.com/local-only-sync', image: makeImagePNG([27, 73, 162, 255]) });
    const cloudImage = await uploadedSiteImage(remote, { name: cloudOnly, url: 'https://example.com/cloud-only-sync', image: makeImagePNG([162, 73, 27, 255]) });
    const losingPage = winner === 'local' ? remote : local;
    await createNote(losingPage, { title: 'LOSING_SIDE_ONLY_NOTE', body: 'Independent record on just the losing side' });
    remoteForm = await openSync(remote);
    await syncNow(remoteForm);
    await closeSync(remote);

    const localForm = await openSync(local);
    await localForm.getByRole('button', { name: '立即同步', exact: true }).click();
    const run = conflictRun(localForm);
    await expect(run).toHaveCount(1, { timeout: 45_000 });
    await expect(run).toContainText('有冲突');
    await expect(localForm.getByRole('button', { name: choiceLabel('local'), exact: true })).toHaveCount(1);
    await expect(localForm.getByRole('button', { name: choiceLabel('remote'), exact: true })).toHaveCount(1);
    await expect(localForm.getByRole('button', { name: '查看对比', exact: true })).toHaveCount(0);
    await expect(localForm.locator('.cloud-conflict-row')).toHaveCount(0);
    await expect(syncRuns(localForm)).toHaveCount(2);
    await expect(local.locator('.site-name').filter({ hasText: cloudOnly })).toHaveCount(0);
    const writesBeforeChoice = network.requests.filter(request => request.method === 'PUT' && /\/all-data-v1\/[^/]+\.json$/.test(request.url)).length;

    await chooseWholeSide(localForm, winner);
    await expect(syncRuns(localForm)).toHaveCount(3);
    await expect(syncRuns(localForm).getByText('有冲突', { exact: true })).toHaveCount(1);
    const writesAfterChoice = network.requests.filter(request => request.method === 'PUT' && /\/all-data-v1\/[^/]+\.json$/.test(request.url)).length;
    expect(writesAfterChoice - writesBeforeChoice).toBe(1);
    await closeSync(local);

    const expected = winner === 'local' ? [localOnly, 'LOCAL_BRANCH_SITE'] : [cloudOnly, 'CLOUD_BRANCH_SITE'];
    const names = page => page.locator('.site-link .site-name').evaluateAll(items => items.map(item => item.textContent).sort());
    await expect.poll(() => names(local)).toEqual(expected.sort());
    remoteForm = await openSync(remote);
    await syncNow(remoteForm);
    await closeSync(remote);
    await expect.poll(() => names(remote)).toEqual(expected);
    const losingBackup = await exportCompleteBackup(losingPage);
    expect(losingBackup.tools.notes.some(note => note.title === 'LOSING_SIDE_ONLY_NOTE')).toBe(false);
    const winningImage = winner === 'local' ? localImage : cloudImage;
    expect(losingBackup.siteImages.map(({ name, sha256 }) => ({ name, sha256 }))).toEqual([{ name: winningImage.name, sha256: winningImage.sha256 }]);
    for (const bytes of network.objects.values()) {
      expect(bytes.includes('CLOUD_BRANCH_SITE')).toBe(false);
      expect(bytes.includes(syncPassword)).toBe(false);
    }
  });
}
