import { expect } from './upgrade.fixture.mjs';
import { WEBDAV_BASE } from '../playwright/network.mjs';

// Synthetic credentials only. These flows exercise the packaged old/new UI;
// no application records or browser permissions are written by the test.
export const syncPassword = 'UPGRADE-SYNTHETIC-SYNC-PASSWORD';
export const syncUsername = 'UPGRADE-SYNTHETIC-USER';
export const syncAppPassword = 'UPGRADE-SYNTHETIC-APP-PASSWORD';
export const syncPrefix = 'upgrade-proof';
export const syncRoot = `${WEBDAV_BASE}${syncPrefix}/`;
export const NAVIGATION_KEY = 'owntab.local.v1';
export const CLOUD_KEY = 'covelet.cloud.local.v1';
export const FULL_SYNC_KEY = 'covelet.data-sync.v1';

export async function openSync(page, { old = false } = {}) {
  const form = page.locator('.cloud-sync-form');
  if (await form.isVisible()) return form;
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('tab', { name: '数据', exact: true }).click();
  // v0.2.2 tag 81f1b71 uses this label; v0.3.0 added the overall Beta label.
  await settings.getByRole('button', { name: old ? '自定义存储同步' : '自备存储同步（Beta）', exact: true }).click();
  await expect(form).toBeVisible();
  return form;
}

export async function closeSync(page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('.cloud-sync-form')).toHaveCount(0);
}

export async function addSite(page, name, url) {
  await page.getByRole('button', { name: '添加网站', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '添加网站', exact: true });
  const address = editor.getByLabel('网址', { exact: true }), title = editor.getByLabel('名称', { exact: true });
  await address.click();
  await expect(address).toBeFocused();
  await address.fill(url);
  await title.click();
  await title.fill(name);
  await expect(address).toHaveValue(url);
  await expect(title).toHaveValue(name);
  await editor.getByRole('button', { name: '添加', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(page.locator('.site-name').filter({ hasText: name })).toBeVisible();
}

export async function editSite(page, currentName, nextName) {
  const tile = page.locator('.site-tile').filter({ has: page.getByText(currentName, { exact: true }) });
  await tile.locator('.site-link').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑网站', exact: true });
  await editor.getByLabel('名称', { exact: true }).click();
  await editor.getByLabel('名称', { exact: true }).fill(nextName);
  await expect(editor.getByLabel('名称', { exact: true })).toHaveValue(nextName);
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).toBeHidden();
}

export async function configureOldSync(page) {
  const form = await openSync(page, { old: true });
  await expect(form.locator('.cloud-channel-option[aria-pressed="true"]')).toContainText('WebDAV');
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await form.getByLabel('WebDAV 基目录地址', { exact: true }).fill(WEBDAV_BASE);
  await form.getByLabel('保存目录', { exact: true }).fill(syncPrefix);
  await form.getByLabel('WebDAV 用户名', { exact: true }).fill(syncUsername);
  await form.getByLabel('WebDAV 应用密码', { exact: true }).fill(syncAppPassword);
  await form.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(form).toContainText('最近连接测试通过');
  await form.getByRole('button', { name: '下一步', exact: true }).click();
  await form.getByLabel('同步密码', { exact: true }).fill(syncPassword);
  await expect(form.getByRole('switch', { name: '首次同步成功后自动同步', exact: true })).not.toBeChecked();
  await form.getByRole('button', { name: '保存并首次同步', exact: true }).click();
  await expect(form.locator('.cloud-setup-steps')).toHaveCount(0, { timeout: 45_000 });
  await expect(form).toContainText('最近同步：', { timeout: 45_000 });
  return form;
}

export async function syncNow(form) {
  const action = form.getByRole('button', { name: '立即同步', exact: true });
  await action.click();
  await expect(action).toBeEnabled({ timeout: 45_000 });
}

export async function unlockSync(form) {
  await expect(form.locator('.connection-state')).toHaveText('需解锁');
  await form.getByLabel('WebDAV 用户名', { exact: true }).fill(syncUsername);
  await form.getByLabel('WebDAV 应用密码', { exact: true }).fill(syncAppPassword);
  await form.getByLabel('同步密码', { exact: true }).fill(syncPassword);
  await form.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(form.locator('.connection-state')).toHaveText('已解锁');
  await expect(form).toContainText('当前凭据的连接尚未验证');
}

export function navigationConflict(form) {
  return form.locator('.cloud-sync-conflicts > div').filter({ hasText: '导航、文件夹与外观' });
}

export async function chooseRemote(page, { old = false } = {}) {
  const prompt = page.getByRole('alertdialog', { name: old ? '选择一条完整记录' : '选择保留的版本', exact: true });
  await expect(prompt).toBeVisible();
  await expect(prompt.locator('.prompt-dialog-actions button').last()).toBeDisabled();
  const label = old ? '整条采用远端版本' : '采用云端版本';
  await prompt.locator('.cloud-conflict-sides').getByRole('button', { name: label, exact: true }).click();
  await prompt.locator('.prompt-dialog-actions').getByRole('button', { name: label, exact: true }).click();
  await expect(prompt).toBeHidden();
}

export async function settleOldPeer(page, form) {
  // A receiving profile may have its own persisted initial navigation. Resolve
  // those actual whole-record conflicts using the old dialog before branching.
  for (let attempt = 0; attempt < 10 && await form.locator('.cloud-sync-conflicts button').count(); attempt++) {
    await form.locator('.cloud-sync-conflicts button').first().click();
    await chooseRemote(page, { old: true });
  }
  await expect(form.locator('.cloud-sync-conflicts button')).toHaveCount(0);
  await syncNow(form);
}

export async function expectSessionCleared(session) {
  expect(await session.worker.evaluate(() => chrome.storage.session.get(null))).toEqual({});
}

export async function screenshot(page, testInfo, label) {
  const path = testInfo.outputPath(`${label}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach(label, { path, contentType: 'image/png' });
}
