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

export function uploadedSiteBackup({ name, url, image = makeImagePNG() }) {
  const assetId = `synthetic-image-${randomUUID()}`, siteId = `synthetic-site-${randomUUID()}`;
  const state = { version: 1, revision: 0, groups: [{ id: 'group-home', name: '桌面' }],
    entries: [{ id: siteId, type: 'site', name, url, groupId: 'group-home', parentId: null, page: 0, order: 0, icon: { kind: 'image', value: assetId } }],
    providers: [], settings: { theme: 'system', background: { kind: 'color', value: '#f2f5f9' }, shade: 0, blur: 0,
      width: 1120, iconSize: 64, gap: 24, columns: 8, showLabels: true, showClock: true, openNewTab: false, minimal: false, visualEnhancement: false, pages: [0] } };
  const manifest = { format: 'owntab-backup', version: 2, createdAt: new Date().toISOString(), icons: [],
    assets: [{ id: assetId, path: 'assets/0.png', mime: 'image/png', bytes: image.length, sha256: imageDigest(image) }] };
  return Buffer.from(zipSync({ 'data.json': strToU8(JSON.stringify(state)), 'manifest.json': strToU8(JSON.stringify(manifest)), 'assets/0.png': image }));
}

export async function openRecovery(page) {
  const recovery = page.getByRole('dialog', { name: '备份与恢复中心', exact: true });
  if (await recovery.isVisible()) return recovery;
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('tab', { name: '数据', exact: true }).click();
  await settings.getByRole('button', { name: '备份与恢复中心', exact: true }).click();
  await expect(recovery).toBeVisible();
  return recovery;
}

export async function chooseBackupFile(page, recovery, buffer, name = 'synthetic-backup.json') {
  const chooserReady = page.waitForEvent('filechooser');
  await recovery.getByRole('button', { name: '选择备份文件', exact: true }).click();
  const chooser = await chooserReady;
  await chooser.setFiles({ name, mimeType: name.endsWith('.zip') ? 'application/zip' : 'application/json', buffer });
}

export async function restorePreview(page, recovery, { mode = 'replace' } = {}) {
  await expect(recovery.locator('.recovery-preview')).toBeVisible();
  const select = recovery.getByRole('combobox', { name: '恢复方式', exact: true });
  const label = mode === 'append' ? '添加新内容，保留已有内容' : '替换所选类别';
  if (!(await select.innerText()).includes(label)) {
    await select.click();
    await page.getByRole('option', { name: label, exact: true }).click();
  }
  await recovery.locator('.recovery-category').filter({ hasText: '我已确认所选类别和恢复方式' }).getByRole('checkbox').check();
  await recovery.getByRole('button', { name: '开始恢复', exact: true }).click();
  await expect(recovery.getByText('恢复完成。', { exact: true })).toBeVisible();
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
// image path. Append preserves existing sites, settings and every note.
export async function uploadedSiteImage(page, { name, url, image = makeImagePNG() }) {
  const recovery = await openRecovery(page);
  await chooseBackupFile(page, recovery, uploadedSiteBackup({ name, url, image }), 'synthetic-navigation-image.zip');
  await restorePreview(page, recovery, { mode: 'append' });
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
  await recovery.getByRole('button', { name: '导出完整备份', exact: true }).click();
  const download = await ready, stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  expect(download.suggestedFilename()).toBe('Covelet-complete-backup.json');
  return { buffer, ...inspectCompleteBackup(buffer) };
}
