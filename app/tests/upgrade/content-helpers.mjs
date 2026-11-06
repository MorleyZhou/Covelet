import { expect } from './upgrade.fixture.mjs';
import { makeImagePNG, imageDigest, uploadedSiteBackup, chooseBackupFile, openRecovery, exportCompleteBackup, createNote, revealDesktopItem } from '../playwright/backup-helpers.mjs';

export const NAVIGATION = 'owntab.local.v1';
export const HOME_MIGRATION = 'covelet.home-migration.v1';
export const CONTENT_PREFERENCES = 'covelet.content.preferences.v1';
export const TOOLS = 'covelet.tools.v1';
export const SEED_IDS = ['google', 'youtube', 'github', 'x', 'chatgpt', 'grok'].map(id => `default-${id}`);
export { exportCompleteBackup, openRecovery, chooseBackupFile, revealDesktopItem };

export const tileNamed = (page, name) => page.locator('.site-tile').filter({ has: page.getByText(name, { exact: true }) });

export async function closeDialog(page, dialog) {
  await dialog.getByRole('button', { name: '关闭', exact: true }).first().click();
  await expect(dialog).toBeHidden();
}

export async function settingsTab(page, tab) {
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: tab, exact: true }).click();
  return dialog;
}

// A pristine v0.2.2 navigation object is only an in-memory default until a user
// action saves it. Persist it through the real settings UI before upgrading.
export async function persistLegacySeeds(page) {
  const settings = await settingsTab(page, '外观');
  // The actual published 0.2.2 package predates the minimal-mode control.
  await settings.getByRole('combobox', { name: '主题', exact: true }).click();
  await page.getByRole('option', { name: '浅色', exact: true }).click();
  await closeDialog(page, settings);
}

export async function contextAction(page, name, action) {
  const link = tileNamed(page, name).locator('.site-link');
  await revealDesktopItem(page, link);
  await link.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '网站操作', exact: true });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: action, exact: true }).click();
  await expect(menu).toBeHidden();
}

export async function editLegacySite(page, previous, { name = previous, url } = {}) {
  await contextAction(page, previous, '编辑');
  const dialog = page.getByRole('dialog', { name: '编辑网站', exact: true });
  await expect(dialog).toBeVisible();
  if (url) await dialog.getByLabel('网址', { exact: true }).fill(url);
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(tileNamed(page, name)).toBeVisible();
}

export async function addLegacySite(page, name, url) {
  await page.getByRole('button', { name: '添加网站', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加网站', exact: true });
  await dialog.getByLabel('网址', { exact: true }).fill(url);
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(tileNamed(page, name)).toBeVisible();
}

export async function aliasAndPrivateSeeds(page) {
  await contextAction(page, 'GitHub', '搜索别名');
  const preferences = page.getByRole('dialog', { name: '内容与隐私', exact: true });
  await preferences.getByLabel('搜索别名', { exact: true }).fill('upgrade-code-alias');
  await preferences.getByRole('button', { name: '保存', exact: true }).click();
  await expect(preferences).toBeHidden();
  // A private marker is a saved user choice, independent of enabling hiding or
  // creating a privacy password. Keep the synthetic test content visible.
  await contextAction(page, 'X', '标记为私密');
}

export async function groupLegacySeeds(page) {
  const source = tileNamed(page, 'ChatGPT').locator('.site-icon').first();
  const target = tileNamed(page, 'Grok').locator('.site-icon').first();
  const from = await source.boundingBox(), to = await target.boundingBox();
  expect(from).not.toBeNull(); expect(to).not.toBeNull();
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  try {
    await page.mouse.move(start.x + 12, start.y + 3, { steps: 3 });
    await expect(page.locator('.icon-drag-ghost')).toBeVisible();
    await page.mouse.move(end.x, end.y, { steps: 16 });
    await expect(page.locator('.drag-target-label')).toHaveText('合并为文件夹');
  } finally { await page.mouse.up(); }
  await expect(tileNamed(page, '新建文件夹')).toBeVisible();
  await contextAction(page, '新建文件夹', '编辑');
  const dialog = page.getByRole('dialog', { name: '编辑文件夹', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill('Upgrade Folder');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
}

export async function restoreCompletePreview(page, buffer, { mode = 'replace', old = false, name = 'upgrade-backup.json' } = {}) {
  const recovery = await openRecovery(page);
  await chooseBackupFile(page, recovery, buffer, name);
  await expect(recovery.locator('.recovery-preview')).toBeVisible();
  const label = mode === 'append' ? old ? '仅追加新记录，保留已有内容' : '添加新内容，保留已有内容' : '替换所选类别';
  const choice = recovery.getByRole('combobox', { name: '恢复方式', exact: true });
  if (!(await choice.innerText()).includes(label)) {
    await choice.click(); await page.getByRole('option', { name: label, exact: true }).click();
  }
  await recovery.locator('.recovery-category').filter({ hasText: '我已确认所选类别和恢复方式' }).getByRole('checkbox').check();
  await recovery.getByRole('button', { name: '开始恢复', exact: true }).click();
  await expect(recovery.getByText('恢复完成。', { exact: true })).toBeVisible();
  await expect(recovery.getByRole('button', { name: '导出完整备份', exact: true })).toBeEnabled();
  await closeDialog(page, recovery);
}

export async function addLegacyImage(page) {
  const image = makeImagePNG([184, 62, 132, 255]);
  await restoreCompletePreview(page, uploadedSiteBackup({ name: 'Upgrade Image', url: 'https://example.com/upgrade-image', image }),
    { mode: 'append', old: true, name: 'upgrade-image.zip' });
  const link = tileNamed(page, 'Upgrade Image').locator('.site-link');
  await revealDesktopItem(page, link);
  await expect(link.locator('img[data-artwork-phase="current"]')).toBeVisible();
  return { image, sha256: imageDigest(image), type: 'image/png', size: image.length };
}

export async function addLegacyWidget(page, id, title) {
  await page.getByRole('button', { name: '打开扩展', exact: true }).click();
  await page.locator(`#extension-${id}`).click();
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  await dialog.getByRole('button', { name: '添加到桌面', exact: true }).click();
  await expect(dialog).toBeHidden();
}

export async function addLegacyNoteAndClock(page) {
  await createNote(page, { title: 'Upgrade Note', body: '升级前的便笺正文：导航、图片与用户选择都应保留。' });
  await addLegacyWidget(page, 'clock', '时钟');
  const launcher = page.locator('.clock-widget');
  await revealDesktopItem(page, launcher); await launcher.click();
  const clock = page.getByRole('dialog', { name: '时钟', exact: true });
  await clock.getByRole('tab', { name: '计时', exact: true }).click();
  await clock.getByRole('button', { name: '开始计时', exact: true }).click();
  await clock.getByRole('button', { name: '暂停计时', exact: true }).click();
  await expect(clock.getByRole('button', { name: '开始计时', exact: true })).toBeEnabled();
  await closeDialog(page, clock);
}

export function blobsIn(value, result = []) {
  if (!value || typeof value !== 'object') return result;
  if (value.__blob === true) result.push(value);
  else for (const child of Object.values(value)) blobsIn(child, result);
  return result;
}

export function expectRecordsPreserved(before, after, { navigation } = {}) {
  for (const [namespace, records] of Object.entries(before)) for (const [key, value] of Object.entries(records)) {
    const expected = namespace === 'preferences' && key === NAVIGATION && navigation ? navigation : value;
    expect(after[namespace]?.[key], `preserve ${namespace}/${key}`).toEqual(expected);
  }
}
