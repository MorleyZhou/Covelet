import { expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8, zlibSync } from 'fflate';

export const imageDigest = bytes => createHash('sha256').update(bytes).digest('hex');

// A real, decodable synthetic PNG. No downloaded artwork or application storage
// access is needed to prepare the image fixture.
export function makeImagePNG(rgba = [37, 99, 235, 255]) {
  const width = 32, height = 32, raw = Buffer.alloc(height * (1 + width * 4));
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    Buffer.from(rgba).copy(raw, row * (1 + width * 4) + 1 + column * 4);
  }
  function chunk(type, bytes) {
    const body = Buffer.concat([Buffer.from(type), bytes]), output = Buffer.alloc(bytes.length + 12);
    output.writeUInt32BE(bytes.length); body.copy(output, 4);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  }
  const dimensions = Buffer.alloc(13); dimensions.writeUInt32BE(width); dimensions.writeUInt32BE(height, 4); dimensions[8] = 8; dimensions[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', dimensions), chunk('IDAT', Buffer.from(zlibSync(raw))), chunk('IEND', Buffer.alloc(0))]);
}

function uploadedSiteBackup(backup, { name, url, image }) {
  const assetId = `synthetic-image-${randomUUID()}`, siteId = `synthetic-site-${randomUUID()}`;
  const state = structuredClone(backup.navigation), manifest = structuredClone(backup.manifest);
  const groupId = state.groups[0].id, page = state.settings.pages[0];
  const order = state.entries.filter(entry => entry.groupId === groupId && entry.parentId === null).length;
  const path = `assets/${manifest.assets.length}.png`;
  state.entries.push({ id: siteId, type: 'site', name, url, groupId, parentId: null, page, order, icon: { kind: 'image', value: assetId } });
  manifest.assets.push({ id: assetId, path, mime: 'image/png', bytes: image.length, sha256: imageDigest(image) });
  return Buffer.from(zipSync({ ...backup.files, 'data.json': strToU8(JSON.stringify(state)), 'manifest.json': strToU8(JSON.stringify(manifest)), [path]: image }));
}

export async function openRecovery(page) {
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  if (!await settings.isVisible()) await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const recovery = settings.getByRole('tabpanel', { name: '备份与恢复', exact: true });
  if (!await recovery.isVisible()) await settings.getByRole('tab', { name: '备份与恢复', exact: true }).click();
  await expect(recovery).toBeVisible();
  return recovery;
}

export async function chooseBackupFile(page, recovery, buffer, name = 'synthetic-backup.json') {
  const chooserReady = page.waitForEvent('filechooser');
  await recovery.getByRole('button', { name: '恢复备份', exact: true }).click();
  const chooser = await chooserReady;
  await chooser.setFiles({ name, mimeType: name.endsWith('.zip') ? 'application/zip' : 'application/json', buffer });
}

export async function restorePreview(recovery) {
  await expect(recovery.locator('.recovery-preview')).toBeVisible();
  await recovery.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(recovery.getByText('恢复完成。', { exact: true })).toBeVisible();
  await expect(recovery.getByRole('button', { name: '导出备份', exact: true })).toBeEnabled();
}

export async function revealDesktopItem(page, item) {
  const { key, index } = await item.evaluate(element => {
    const screen = element.closest('.desktop-page');
    return { key: element.closest('.desktop-grid').dataset.pageKey, index: [...screen.parentElement.children].indexOf(screen) };
  });
  const dot = page.locator('.desktop-page-dot').filter({ has: page.locator('span') }).and(page.locator(`[data-page-key="${key}"]`));
  if (await dot.count()) await dot.click();
  else {
    const viewport = page.locator('.desktop-page-viewport');
    await viewport.focus(); await viewport.press('Home');
    for (let position = 0; position < index; position++) await viewport.press('ArrowRight');
  }
  await expect(item).toBeVisible();
}

// Current Covelet has no upload control in the site editor. Importing a small
// navigation ZIP through the production picker exercises the supported local
// image path. Build on the exported navigation to preserve existing sites.
export async function uploadedSiteImage(page, { name, url, image = makeImagePNG() }) {
  const backup = await exportCompleteBackup(page), recovery = await openRecovery(page);
  await chooseBackupFile(page, recovery, uploadedSiteBackup(backup, { name, url, image }), 'synthetic-navigation-image.zip');
  await restorePreview(recovery);
  await page.keyboard.press('Escape');
  await expect(recovery).toBeHidden();
  const site = page.locator('.site-link').filter({ hasText: name });
  await revealDesktopItem(page, site);
  await expect(site.locator('img[data-artwork-phase="current"]')).toBeVisible();
  await expect.poll(() => site.locator('img[data-artwork-phase="current"]').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  return { name, url, image: Buffer.from(image), sha256: imageDigest(image) };
}

export async function createNote(page, { title, body }) {
  const launcher = page.locator('.personal-widget-notes');
  if (!await launcher.count()) {
    await page.getByRole('button', { name: '打开扩展', exact: true }).click();
    await page.locator('#extension-notes').click();
    const extensionDialog = page.getByRole('dialog', { name: '便笺', exact: true });
    await extensionDialog.getByRole('combobox', { name: '桌面尺寸', exact: true }).click();
    await page.getByRole('option', { name: '小 · 2×2', exact: true }).click();
    await extensionDialog.getByRole('button', { name: '添加到桌面', exact: true }).click();
    await expect(extensionDialog).toBeHidden();
  }
  await revealDesktopItem(page, launcher);
  await launcher.click();
  const dialog = page.getByRole('dialog', { name: '便笺', exact: true });
  await dialog.getByRole('button', { name: '新便笺', exact: true }).click();
  await dialog.getByLabel('便笺名称', { exact: true }).fill(title);
  const editor = dialog.locator('.folio-note-editor [contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.fill(body);
  const save = dialog.getByRole('button', { name: '保存', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  await expect(dialog.locator('.tool-record-list button').filter({ hasText: title })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

export function inspectCompleteBackup(buffer) {
  const data = JSON.parse(Buffer.from(buffer).toString('utf8'));
  const files = unzipSync(Buffer.from(data.navigation, 'base64'));
  const navigation = JSON.parse(strFromU8(files['data.json'])), manifest = JSON.parse(strFromU8(files['manifest.json']));
  const siteImages = navigation.entries.filter(entry => entry.type === 'site' && entry.icon?.kind === 'image').map(site => {
    const asset = manifest.assets.find(asset => asset.id === site.icon.value);
    const bytes = Buffer.from(files[asset.path]);
    return { id: site.id, name: site.name, url: site.url, bytes, sha256: imageDigest(bytes), mime: asset.mime };
  });
  return { data, navigation, manifest, files, tools: data.tools, siteImages };
}

export async function exportCompleteBackup(page) {
  const recovery = await openRecovery(page), ready = page.waitForEvent('download');
  await recovery.getByRole('button', { name: '导出备份', exact: true }).click();
  const download = await ready, stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  expect(download.suggestedFilename()).toBe('Covelet-complete-backup.json');
  return { buffer, ...inspectCompleteBackup(buffer) };
}
