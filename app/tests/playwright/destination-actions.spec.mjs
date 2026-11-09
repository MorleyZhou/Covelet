import { test, expect, addSite } from './extension.fixture.mjs';
import { desktopNames, enterLayout, pointerDrag, tileNamed } from './navigation-helpers.mjs';

const folder = '新建文件夹';
const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB0kAAAAASUVORK5CYII=', 'base64');
const iconUrl = 'https://example.com/covelet-destination-icon.png';

test.use({ pregrantedHosts: ['https://example.com/*'] });
test.beforeEach(async ({ extension }) => {
  await extension.context.route(/^https:\/\/example\.com\/(?:favicon\.ico|apple-touch-icon(?:-precomposed)?\.png|android-chrome-192x192\.png)$/,
    route => route.fulfill({ status: 404, body: '' }));
  await extension.context.route(iconUrl, route => route.fulfill({ status: 200, contentType: 'image/png', body: icon }));
});

async function choose(scope, label, option) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await scope.getByRole('option', { name: option }).click();
}

async function createFolder(page) {
  await addSite(page, 'Folder A', 'https://example.com/folder-a');
  await addSite(page, 'Folder B', 'https://example.com/folder-b');
  await pointerDrag(page, tileNamed(page, 'Folder A').locator('.site-icon'), tileNamed(page, 'Folder B').locator('.site-icon'), '合并为文件夹');
  await expect(desktopNames(page)).toContainText([folder]);
}

async function openFolder(page) {
  await tileNamed(page, folder).locator('.site-link').click();
  return page.getByRole('dialog', { name: folder, exact: true });
}

async function openPopup(extension, name, url, destination) {
  const path = await extension.worker.evaluate(() => chrome.runtime.getManifest().action.default_popup);
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.id}/${path}`);
  if (destination === 'reading') await page.getByRole('tab', { name: '稍后读', exact: true }).click();
  const address = page.getByLabel('网址', { exact: true });
  await expect(address).toBeEnabled();
  await address.fill(url);
  await page.getByLabel('名称', { exact: true }).fill(name);
  return page;
}

test('unpacked toolbar popup saves into a selected folder', async ({ extension }) => {
  const page = await extension.newtab();
  await createFolder(page);
  const name = 'Popup folder destination', url = 'https://example.com/popup-folder-destination';
  const popup = await openPopup(extension, name, url);
  await popup.getByLabel('图标地址', { exact: true }).fill(iconUrl);
  await choose(popup, '目标位置', /新建文件夹/);
  await popup.getByRole('button', { name: '保存', exact: true }).click();
  await expect(desktopNames(page)).toHaveText([folder]);
  const dialog = await openFolder(page);
  await expect(dialog.getByRole('link', { name, exact: true })).toHaveAttribute('href', url);
});

test('adding a read item to a folder retains its original read state', async ({ extension }) => {
  const page = await extension.newtab();
  await createFolder(page);
  const name = 'Reading folder destination', url = 'https://example.com/reading-folder-destination';
  const popup = await openPopup(extension, name, url, 'reading');
  await popup.getByRole('button', { name: '保存', exact: true }).click();
  const search = page.getByRole('combobox', { name: '搜索或输入网址', exact: true });
  await search.fill(name);
  await page.getByRole('option', { name: new RegExp(name) }).click();
  const reading = page.getByRole('dialog', { name: '稍后读', exact: true });
  await reading.getByRole('button', { name: '标为已读', exact: true }).click();
  await reading.getByRole('tab', { name: '已读', exact: true }).click();
  await reading.getByRole('button', { name: '添加到桌面', exact: true }).click();
  const target = page.getByRole('dialog', { name: '添加到桌面', exact: true });
  await choose(target, '目标位置', /新建文件夹/);
  await target.getByRole('button', { name: '添加', exact: true }).click();
  await expect(target).toBeHidden();
  await expect(reading.getByRole('status')).toHaveText('已添加到桌面。');
  await expect(reading.getByRole('button', { name: '标为未读', exact: true })).toBeVisible();
  await reading.getByRole('button', { name: '关闭', exact: true }).click();
  const dialog = await openFolder(page);
  await expect(dialog.getByRole('link', { name, exact: true })).toHaveAttribute('href', url);
});

test('layout transfer copies selected sites, previews duplicates and undoes a draft move', async ({ extension }) => {
  const page = await extension.newtab();
  await createFolder(page);
  await addSite(page, 'Source A', 'https://example.com/transfer-a');
  await addSite(page, 'Source B', 'https://example.com/transfer-b');
  await enterLayout(page, 'Source A');
  await tileNamed(page, 'Source A').press(' ');
  const toolbar = page.getByRole('toolbar', { name: '编辑布局', exact: true });
  const openTransfer = () => toolbar.getByRole('button', { name: '整理所选网站', exact: true }).click();
  const transfer = page.getByRole('dialog', { name: '整理所选网站', exact: true });
  await openTransfer();
  await choose(transfer, '操作', '复制');
  await choose(transfer, '目标位置', /新建文件夹/);
  await transfer.getByRole('button', { name: '复制', exact: true }).click();
  await expect(transfer).toBeHidden();
  await expect(desktopNames(page)).toHaveText([folder, 'Source A', 'Source B']);

  await tileNamed(page, 'Source A').press(' ');
  await tileNamed(page, 'Source B').press(' ');
  await openTransfer();
  await choose(transfer, '目标位置', /新建文件夹/);
  await expect(transfer.getByRole('status')).toContainText('将跳过 1 条重复网址。');
  await transfer.getByRole('button', { name: '移动', exact: true }).click();
  await expect(desktopNames(page)).toHaveText([folder, 'Source A']);
  await toolbar.getByRole('button', { name: '撤销布局操作', exact: true }).click();
  await expect(desktopNames(page)).toHaveText([folder, 'Source A', 'Source B']);
  await toolbar.getByRole('button', { name: '重做布局操作', exact: true }).click();
  await toolbar.getByRole('button', { name: '完成', exact: true }).click();
  await expect(toolbar).toBeHidden();
  await page.reload();
  await expect(desktopNames(page)).toHaveText([folder, 'Source A']);
  await expect((await openFolder(page)).locator('.folder-sites .site-name')).toHaveText(['Folder B', 'Folder A', 'Source A', 'Source B']);
});
