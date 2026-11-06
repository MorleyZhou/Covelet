import { test, expect, addSite } from './extension.fixture.mjs';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { uploadedSiteImage, createNote, openRecovery, chooseBackupFile, restorePreview, exportCompleteBackup, revealDesktopItem, inspectCompleteBackup } from './backup-helpers.mjs';
import { BUILTIN_DESKTOP_TEMPLATES } from '../../src/lib/desktop-templates.js';

const fixture = { site: '备份图片导航', url: 'https://example.com/covelet-backup-image', title: '备份便笺标题', body: '合成备份正文：导航、便笺和图片都应保留。' };

async function createContent(page) {
  const image = await uploadedSiteImage(page, { name: fixture.site, url: fixture.url });
  await createNote(page, { title: fixture.title, body: fixture.body });
  return image;
}
async function closeRecovery(page, recovery) {
  await page.keyboard.press('Escape');
  await expect(recovery).toBeHidden();
}
function contents(backup) {
  return { navigation: backup.navigation, tools: backup.tools, templates: backup.data.templates, preferences: backup.data.preferences,
    images: backup.siteImages.map(({ id, name, url, sha256, mime }) => ({ id, name, url, sha256, mime })) };
}
function renamedBackup(buffer) {
  const backup = inspectCompleteBackup(buffer), data = structuredClone(backup.data), navigation = structuredClone(backup.navigation);
  navigation.entries.find(entry => entry.type === 'site').name = '不应被取消或失败恢复的导航';
  data.navigation = Buffer.from(zipSync({ ...backup.files, 'data.json': strToU8(JSON.stringify(navigation)) })).toString('base64');
  return Buffer.from(JSON.stringify(data));
}
function damagedImageBackup(buffer) {
  const data = JSON.parse(buffer.toString('utf8')), files = unzipSync(Buffer.from(data.navigation, 'base64'));
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])), path = manifest.assets[0].path;
  files[path] = new Uint8Array(files[path]); files[path][files[path].length - 1] ^= 1;
  // Rebuild a valid ZIP with the damaged bytes and the original content hash.
  // The production importer must reject the image, rather than just bad JSON.
  data.navigation = Buffer.from(zipSync(files)).toString('base64');
  return Buffer.from(JSON.stringify(data));
}
test('complete backup restores real navigation, note content and exact local image bytes in another profile', async ({ extension }, testInfo) => {
  const source = await extension.newtab(), image = await createContent(source), exported = await exportCompleteBackup(source);
  expect(exported.siteImages).toHaveLength(1);
  expect(exported.siteImages[0].bytes.equals(image.image)).toBe(true);
  expect(exported.siteImages[0].sha256).toBe(image.sha256);
  expect(exported.tools.notes[0]).toMatchObject({ title: fixture.title, body: fixture.body });

  const legacy = { id: 'qa-legacy-template', name: '以前保存的方案', createdAt: 1, template: BUILTIN_DESKTOP_TEMPLATES[0] };
  const olderBackup = Buffer.from(JSON.stringify({ ...exported.data, templates: { version: 1, revision: 1, templates: [legacy] } }));
  const targetDevice = await extension.launch(), target = await targetDevice.newtab(), recovery = await openRecovery(target);
  await chooseBackupFile(target, recovery, olderBackup);
  await expect(target.getByRole('dialog')).toHaveCount(1);
  await expect(recovery.locator('.recovery-preview')).toContainText('synthetic-backup.json');
  await restorePreview(recovery);
  await closeRecovery(target, recovery);
  const restoredSite = target.locator('.site-link').filter({ hasText: fixture.site });
  await revealDesktopItem(target, restoredSite);
  await expect(restoredSite).toHaveAttribute('href', fixture.url);
  await expect(restoredSite.locator('img[data-artwork-phase="current"]')).toBeVisible();
  await expect.poll(() => restoredSite.locator('img[data-artwork-phase="current"]').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  const notes = target.locator('.personal-widget-notes');
  await revealDesktopItem(target, notes); await notes.click();
  const noteDialog = target.getByRole('dialog', { name: '便笺', exact: true });
  await noteDialog.locator('.tool-record-list button').filter({ hasText: fixture.title }).click();
  await expect(noteDialog.getByLabel('便笺名称', { exact: true })).toHaveValue(fixture.title);
  await expect(noteDialog.locator('[contenteditable="true"]')).toContainText(fixture.body);
  await target.keyboard.press('Escape'); await expect(noteDialog).toBeHidden();
  await target.reload();
  await expect(target.getByRole('combobox', { name: '搜索或输入网址' })).toBeVisible();
  const restored = await exportCompleteBackup(target);
  expect(restored.data.templates.templates).toEqual([legacy]);
  expect(restored.siteImages[0].bytes.equals(image.image)).toBe(true);
  expect(restored.siteImages[0].sha256).toBe(exported.siteImages[0].sha256);
  expect(restored.tools.notes.map(({ title, body, document }) => ({ title, body, document }))).toEqual(exported.tools.notes.map(({ title, body, document }) => ({ title, body, document })));
  expect(restored.navigation.entries.map(({ id, name, url, type }) => ({ id, name, url, type }))).toEqual(exported.navigation.entries.map(({ id, name, url, type }) => ({ id, name, url, type })));
  await testInfo.attach('backup-image-proof', { body: JSON.stringify({ expectedSHA256: image.sha256, restoredSHA256: restored.siteImages[0].sha256, bytes: image.image.length, notes: restored.tools.notes.length }), contentType: 'application/json' });
  const screenshot = testInfo.outputPath('backup-restored.png'); await target.screenshot({ path: screenshot });
  await testInfo.attach('backup-restored', { path: screenshot, contentType: 'image/png' });
});

test('canceling inline restore preserves navigation, notes and image bytes', async ({ extension }) => {
  const page = await extension.newtab(); await createContent(page);
  const before = await exportCompleteBackup(page), recovery = await openRecovery(page);
  await chooseBackupFile(page, recovery, renamedBackup(before.buffer));
  await expect(recovery.locator('.recovery-preview')).toBeVisible();
  await expect(recovery.getByRole('button', { name: '确认恢复', exact: true })).toBeEnabled();
  await recovery.getByRole('button', { name: '取消', exact: true }).click();
  await expect(recovery.locator('.recovery-preview')).toHaveCount(0);
  await expect(recovery).toBeVisible();
  const after = await exportCompleteBackup(page);
  expect(contents(after)).toEqual(contents(before));
});

test('damaged image rejection clears an earlier preview and keeps all original data', async ({ extension }) => {
  const page = await extension.newtab(); await createContent(page);
  const before = await exportCompleteBackup(page), recovery = await openRecovery(page);
  await chooseBackupFile(page, recovery, renamedBackup(before.buffer));
  await expect(recovery.locator('.recovery-preview')).toBeVisible();
  await chooseBackupFile(page, recovery, damagedImageBackup(before.buffer));
  await expect(recovery.getByRole('alert')).toContainText('备份中的图片缺失或已损坏');
  await expect(recovery.locator('.recovery-preview')).toHaveCount(0);
  await expect(recovery.getByRole('button', { name: '确认恢复', exact: true })).toHaveCount(0);
  expect(contents(await exportCompleteBackup(page))).toEqual(contents(before));
});

test('a real later edit invalidates restore without overwriting navigation, notes or images', async ({ extension }) => {
  const page = await extension.newtab(); await createContent(page);
  const original = await exportCompleteBackup(page), recovery = await openRecovery(page);
  await chooseBackupFile(page, recovery, renamedBackup(original.buffer));
  await expect(recovery.locator('.recovery-preview')).toBeVisible();
  const other = await extension.newtab();
  await addSite(other, '预览后新增的导航', 'https://example.com/covelet-after-preview');
  const current = await exportCompleteBackup(page);
  await recovery.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(recovery.getByRole('alert')).toContainText('数据已更新，请重新选择备份文件。');
  await expect(recovery.locator('.recovery-preview')).toHaveCount(0);
  expect(contents(await exportCompleteBackup(page))).toEqual(contents(current));
});
