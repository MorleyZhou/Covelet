import { test, expect, openSync, addSite } from './extension.fixture.mjs';
import { WEBDAV_BASE } from './network.mjs';

const syncPassword = 'PLAYWRIGHT-SYNC-PASSWORD';
const hidePassword = 'PLAYWRIGHT-HIDE-PASSWORD';
async function configure(page, { saveOnly = false } = {}) {
  const form = await openSync(page);
  await expect(form.locator('.cloud-channel-option[aria-pressed="true"]')).toContainText('WebDAV');
  await expect(form.locator('.cloud-channel-option')).toHaveCount(5);
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await form.getByLabel('WebDAV 基目录地址', { exact: true }).fill(WEBDAV_BASE);
  await form.getByLabel('保存目录', { exact: true }).fill('proof');
  await form.getByLabel('WebDAV 用户名', { exact: true }).fill('PLAYWRIGHT-USER');
  await form.getByLabel('WebDAV 应用密码', { exact: true }).fill('PLAYWRIGHT-APP-PASSWORD');
  await form.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(form).toContainText('最近连接测试通过');
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await form.getByLabel('同步密码', { exact: true }).fill(syncPassword);
  await form.getByRole('button', { name: saveOnly ? '保存配置' : '保存并首次同步', exact: true }).click();
  await expect(form.locator('.cloud-setup-steps')).toHaveCount(0, { timeout: 45_000 });
  if (!saveOnly) await expect(form).toContainText('最近同步：', { timeout: 45_000 });
  return form;
}
async function closeSync(page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('.cloud-sync-form')).toHaveCount(0);
}
async function syncNow(form) {
  const button = form.getByRole('button', { name: '立即同步', exact: true });
  await button.click();
  await expect(button).toBeEnabled({ timeout: 45_000 });
  await expect(form.locator('.cloud-tool-sync-status')).toBeVisible();
}
async function chooseRemote(page) {
  const prompt = page.getByRole('alertdialog', { name: '选择保留的版本', exact: true });
  await expect(prompt).toBeVisible();
  await expect(prompt.locator('.prompt-dialog-actions button').last()).toBeDisabled();
  await prompt.locator('.cloud-conflict-sides').getByRole('button', { name: '采用云端版本', exact: true }).click();
  await prompt.locator('.prompt-dialog-actions').getByRole('button', { name: '采用云端版本', exact: true }).click();
  await expect(prompt).toBeHidden();
}
async function editSite(page, currentName, nextName) {
  await page.locator('.site-name').filter({ hasText: currentName }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑网站', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill(nextName);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function unlockHidden(page) {
  const dialog = page.getByRole('dialog', { name: '解锁隐藏内容', exact: true });
  await dialog.getByLabel('隐藏密码', { exact: true }).fill(hidePassword);
  await dialog.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('connection test is read-only, save is independent, and 401 stays readable', async ({ extension, network }) => {
  const page = await extension.newtab();
  const form = await openSync(page);
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await form.getByLabel('WebDAV 基目录地址', { exact: true }).fill(WEBDAV_BASE);
  await form.getByLabel('WebDAV 用户名', { exact: true }).fill('PLAYWRIGHT-USER');
  await form.getByLabel('WebDAV 应用密码', { exact: true }).fill('PLAYWRIGHT-APP-PASSWORD');
  network.setAuthFailure(true);
  await form.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(form).toContainText('WebDAV 登录失败（401）');
  await expect(form).not.toContainText('FIXTURE_PRIVATE_RESPONSE');
  await expect(form.getByRole('button', { name: '下一步', exact: true })).toBeDisabled();
  network.setAuthFailure(false);
  await form.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(form).toContainText('最近连接测试通过');
  expect(network.requests.filter(item => item.url.startsWith(WEBDAV_BASE)).every(item => item.method === 'PROPFIND')).toBe(true);
  expect(network.objects.size).toBe(0);
  await expect(form.getByLabel('同步密码', { exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await form.getByLabel('同步密码', { exact: true }).fill(syncPassword);
  const before = network.requests.length;
  await form.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(form.locator('.cloud-setup-steps')).toHaveCount(0);
  expect(network.requests.length).toBe(before);
  expect(network.objects.size).toBe(0);
  await form.getByRole('button', { name: '锁定', exact: true }).click();
  await form.getByLabel('WebDAV 用户名', { exact: true }).fill('PLAYWRIGHT-USER');
  await form.getByLabel('WebDAV 应用密码', { exact: true }).fill('PLAYWRIGHT-APP-PASSWORD');
  await form.getByLabel('同步密码', { exact: true }).fill(syncPassword);
  const beforeUnverifiedUnlock = network.requests.length;
  await form.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(form).toContainText('当前凭据的连接尚未验证');
  expect(network.requests.length).toBe(beforeUnverifiedUnlock);
});

test('two real profiles generate a whole-group conflict and hide its real DOM before unlock', async ({ extension, network }) => {
  test.setTimeout(180_000);
  const local = await extension.newtab();
  await addSite(local, 'PRIVATE_BASE_SITE', 'https://example.com/private-proof');
  let localForm = await configure(local);
  expect(network.objects.size).toBeGreaterThan(0);
  await closeSync(local);

  const remoteDevice = await extension.launch();
  const remote = await remoteDevice.newtab();
  let remoteForm = await configure(remote);
  // A first sync can preserve the empty local navigation as a conflict. Choose
  // the uploaded group through the real dialog before branching on both devices.
  for (let attempt = 0; attempt < 8 && await remoteForm.locator('.cloud-sync-conflicts button').count(); attempt++) {
    await remoteForm.locator('.cloud-sync-conflicts button').first().click();
    await chooseRemote(remote);
  }
  await syncNow(remoteForm);
  await closeSync(remote);
  await expect(remote.locator('.site-name').filter({ hasText: 'PRIVATE_BASE_SITE' })).toBeVisible();
  await editSite(remote, 'PRIVATE_BASE_SITE', 'PRIVATE_REMOTE_SITE');
  await editSite(local, 'PRIVATE_BASE_SITE', 'PRIVATE_LOCAL_SITE');
  remoteForm = await openSync(remote);
  await syncNow(remoteForm);
  localForm = await openSync(local);
  await syncNow(localForm);
  const navConflict = () => localForm.locator('.cloud-sync-conflicts > div').filter({ hasText: '导航、文件夹与外观' }).getByRole('button');
  await expect(navConflict()).toBeVisible();
  await closeSync(local);

  await local.locator('.site-name').filter({ hasText: 'PRIVATE_LOCAL_SITE' }).click({ button: 'right' });
  await local.getByRole('menuitem', { name: '标记为私密', exact: true }).click();
  await local.getByRole('button', { name: '开启隐藏', exact: true }).click();
  const setup = local.getByRole('dialog', { name: '设置隐藏密码', exact: true });
  await setup.getByLabel('新密码', { exact: true }).fill(hidePassword);
  await setup.getByLabel('确认密码', { exact: true }).fill(hidePassword);
  await setup.getByRole('button', { name: '设置并隐藏', exact: true }).click();
  await expect(setup).toBeHidden();
  localForm = await openSync(local);
  await expect(localForm.locator('.cloud-conflict-sides')).toHaveCount(0);
  expect(await local.locator('body').innerHTML()).not.toMatch(/PRIVATE_(?:LOCAL|REMOTE)_SITE/);
  const beforeUnlock = network.requests.length;
  await navConflict().click();
  await expect(local.getByRole('dialog', { name: '解锁隐藏内容', exact: true })).toBeVisible();
  expect(network.requests.length).toBe(beforeUnlock);
  await expect(local.locator('.cloud-conflict-sides')).toHaveCount(0);
  await unlockHidden(local);
  await navConflict().click();
  const prompt = local.getByRole('alertdialog', { name: '选择保留的版本', exact: true });
  await expect(prompt).toBeVisible();
  await expect(prompt.locator('.cloud-conflict-details button')).toHaveCount(2);
  // The bounded summary may omit this site in a populated desktop. Expanding
  // the real details must still show both full versions and remain hide-safe.
  for (const details of await prompt.locator('.cloud-conflict-details button').all()) await details.click();
  await expect(prompt).toContainText('PRIVATE_LOCAL_SITE');
  await expect(prompt).toContainText('PRIVATE_REMOTE_SITE');
  await expect(prompt.locator('.cloud-conflict-impact')).toContainText('全部内容');
  await expect(prompt).not.toContainText('选择一条完整记录');
  await expect(prompt.locator('.prompt-dialog-actions button').last()).toBeDisabled();

  const privacyTab = await extension.newtab();
  await privacyTab.getByRole('button', { name: '开启隐藏', exact: true }).click();
  await expect(local.locator('.cloud-conflict-sides')).toHaveCount(0);
  expect(await local.locator('body').innerHTML()).not.toMatch(/PRIVATE_(?:LOCAL|REMOTE)_SITE/);
  await navConflict().click();
  await unlockHidden(local);
  await navConflict().click();
  await chooseRemote(local);
  await syncNow(localForm);
  await closeSync(local);
  await expect(local.locator('.site-name').filter({ hasText: 'PRIVATE_REMOTE_SITE' })).toBeVisible();
  await expect(local.locator('.site-name').filter({ hasText: 'PRIVATE_LOCAL_SITE' })).toHaveCount(0);
  // Only fixture ciphertext reaches the simulated service; all browser storage,
  // permission checks, encryption, conflict choice and CAS are production code.
  for (const bytes of network.objects.values()) {
    expect(bytes.includes('PRIVATE_REMOTE_SITE')).toBe(false);
    expect(bytes.includes(syncPassword)).toBe(false);
  }
});
