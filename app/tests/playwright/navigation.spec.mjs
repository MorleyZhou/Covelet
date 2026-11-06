import { test, expect, addSite } from './extension.fixture.mjs';
import { visibleGrid, tileNamed, desktopNames, editSiteThroughKeyboard, enterLayout, pointerDrag, gridPosition, expectPosition, saveNavigationScreenshot } from './navigation-helpers.mjs';

test.beforeEach(async ({ extension }) => {
  // The exact synthetic site's unavailable icons are intentional. Its warning
  // exercises the normal save-with-a-text-icon path, without contacting a site.
  await extension.context.route(/^https:\/\/example\.com\/(?:favicon\.ico|apple-touch-icon(?:-precomposed)?\.png|android-chrome-192x192\.png)$/, route => route.fulfill({ status: 404, body: '' }));
});

test('consecutive add dialogs keep typed text in the uniquely labelled field', async ({ extension }) => {
  const page = await extension.newtab();
  for (const name of ['Alpha', 'Beta']) {
    await page.getByRole('button', { name: '添加网站', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加网站', exact: true });
    const url = dialog.getByLabel('网址', { exact: true }), title = dialog.getByLabel('名称', { exact: true });
    await expect(url).toHaveCount(1); await expect(title).toHaveCount(1);
    await url.fill(`https://example.com/focus-${name.toLowerCase()}`);
    await title.fill(name);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(title).toHaveValue(name);
    await expect(url).toHaveValue(`https://example.com/focus-${name.toLowerCase()}`);
    await expect(title).toBeFocused();
    await dialog.getByRole('button', { name: '添加', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(desktopNames(page)).toContainText([name]);
  }
});

test('editing can cancel, save through the keyboard, persist, and open from local search', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  await addSite(page, 'Navigation Original', 'https://example.com/navigation-original');
  let editor;
  for (const draft of ['Discarded Name', 'Discarded Again', 'Discarded Last']) {
    editor = await editSiteThroughKeyboard(page, 'Navigation Original');
    await editor.getByLabel('名称', { exact: true }).fill(draft);
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    await expect(desktopNames(page)).toHaveText(['Navigation Original']);
    expect(new URL(page.url()).protocol).toBe('chrome-extension:');
  }

  editor = await editSiteThroughKeyboard(page, 'Navigation Original');
  await editor.getByLabel('网址', { exact: true }).fill('https://example.com/navigation-renamed');
  await editor.getByLabel('名称', { exact: true }).fill('Navigation Renamed');
  await editor.getByLabel('名称', { exact: true }).press('Enter');
  await expect(editor).toBeHidden();
  await expect(tileNamed(page, 'Navigation Renamed').locator('.site-link')).toHaveAttribute('href', 'https://example.com/navigation-renamed');
  await page.reload();
  await expect(tileNamed(page, 'Navigation Renamed').locator('.site-link')).toHaveAttribute('href', 'https://example.com/navigation-renamed');
  await expect(page.getByText('Discarded Name', { exact: true })).toHaveCount(0);
  await saveNavigationScreenshot(page, testInfo, 'edited-site');

  // Only the exact synthetic destination is fulfilled, as plain text. The
  // extension page and search interactions remain the real unpacked app.
  await page.route('https://example.com/navigation-renamed', route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'Navigation destination fixture' }));
  const search = page.getByRole('combobox', { name: '搜索或输入网址' });
  await search.fill('Navigation Renamed');
  await expect(page.getByRole('option')).toContainText('Navigation Renamed');
  await search.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-activedescendant', 'candidate-0');
  await search.press('Enter');
  await expect(page).toHaveURL('https://example.com/navigation-renamed');
  await expect(page.locator('body')).toContainText('Navigation destination fixture');
});

test('real pointer gestures group sites, rename a folder, move a child out, and undo dissolution', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  for (const name of ['Alpha', 'Beta', 'Gamma']) await addSite(page, name, `https://example.com/navigation-${name.toLowerCase()}`);
  await pointerDrag(page, tileNamed(page, 'Alpha').locator('.site-icon'), tileNamed(page, 'Beta').locator('.site-icon'), '合并为文件夹');
  await expect(desktopNames(page)).toHaveText(['新建文件夹', 'Gamma']);
  await pointerDrag(page, tileNamed(page, 'Gamma').locator('.site-icon'), tileNamed(page, '新建文件夹').locator('.site-icon').first(), '放入「新建文件夹」');
  await expect(desktopNames(page)).toHaveText(['新建文件夹']);
  await tileNamed(page, '新建文件夹').locator('.site-link').click();
  let folder = page.getByRole('dialog', { name: '新建文件夹', exact: true });
  await expect(folder.locator('.folder-sites .site-name')).toHaveText(['Beta', 'Alpha', 'Gamma']);
  const name = folder.getByRole('textbox', { name: '文件夹名称', exact: true });
  await name.fill('Discarded Folder');
  await name.press('Escape');
  await expect(name).toHaveValue('新建文件夹');
  await expect(folder).toBeVisible();
  await name.fill('工作资料');
  await name.press('Enter');
  folder = page.getByRole('dialog', { name: '工作资料', exact: true });
  await expect(folder).toBeVisible();
  await expect(folder.getByRole('textbox', { name: '文件夹名称', exact: true })).not.toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Escape');
  await expect(folder).toBeHidden();
  await page.reload();
  await expect(desktopNames(page)).toHaveText(['工作资料']);
  await tileNamed(page, '工作资料').locator('.site-link').click();
  folder = page.getByRole('dialog', { name: '工作资料', exact: true });
  await expect(folder.locator('.folder-sites .site-name')).toHaveText(['Beta', 'Alpha', 'Gamma']);
  await saveNavigationScreenshot(page, testInfo, 'folder-contents');
  await expect(folder.getByText('拖到这里移回桌面', { exact: true })).toHaveCount(0);
  await folder.locator('a[href="https://example.com/navigation-alpha"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移到桌面', exact: true }).click();
  await expect(folder).toBeHidden();
  await expect.poll(async () => (await desktopNames(page).allTextContents()).sort()).toEqual(['Alpha', '工作资料']);
  const organized = await desktopNames(page).allTextContents();
  await tileNamed(page, '工作资料').locator('.site-link').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '解散文件夹', exact: true }).click();
  await expect.poll(async () => (await desktopNames(page).allTextContents()).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
  await page.locator('.toast').getByRole('button', { name: '撤销', exact: true }).click();
  await expect(desktopNames(page)).toHaveText(organized);
  await page.reload();
  await expect(desktopNames(page)).toHaveText(organized);
  await tileNamed(page, '工作资料').locator('.site-link').click();
  await expect(page.getByRole('dialog', { name: '工作资料', exact: true }).locator('.folder-sites .site-name')).toHaveText(['Beta', 'Gamma']);
});

test('layout pointer placement supports keyboard focus, selection, undo, redo, cancel and persisted Enter', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  for (const name of ['Alpha', 'Beta', 'Gamma']) await addSite(page, name, `https://example.com/layout-${name.toLowerCase()}`);
  const alpha = tileNamed(page, 'Alpha'), beta = tileNamed(page, 'Beta'), gamma = tileNamed(page, 'Gamma');
  const original = await gridPosition(alpha);
  await enterLayout(page, 'Alpha');
  await alpha.focus();
  await alpha.press('ArrowRight'); await expect(beta).toBeFocused();
  await beta.press('End'); await expect(gamma).toBeFocused();
  await gamma.press('Home'); await expect(alpha).toBeFocused();
  await alpha.press(' '); await expect(alpha).toHaveAttribute('aria-pressed', 'true');
  await alpha.press('Control+a');
  await expect(visibleGrid(page).locator('.site-tile[aria-pressed="true"]')).toHaveCount(3);
  await alpha.press(' '); await expect(alpha).toHaveAttribute('aria-pressed', 'false');
  await visibleGrid(page).locator('.desktop-empty-slot').nth(4).click();
  await expect(visibleGrid(page).locator('.site-tile[aria-pressed="true"]')).toHaveCount(0);
  const target = { row: '0', column: '3' };
  await pointerDrag(page, alpha.locator('.site-icon'), visibleGrid(page).locator('.desktop-empty-slot').nth(3), '放置到这里');
  await expectPosition(alpha, target);
  await alpha.focus(); await alpha.press('Control+z'); await expectPosition(alpha, original);
  await alpha.press('Control+Shift+z'); await expectPosition(alpha, target);
  await alpha.press('Escape');
  await expect(page.getByRole('toolbar', { name: '编辑布局', exact: true })).toHaveCount(0);
  await expectPosition(alpha, original);
  await page.reload(); await expectPosition(alpha, original);

  await enterLayout(page, 'Alpha');
  await pointerDrag(page, alpha.locator('.site-icon'), visibleGrid(page).locator('.desktop-empty-slot').nth(3), '放置到这里');
  await expectPosition(alpha, target);
  await alpha.focus(); await alpha.press('Enter');
  await expect(page.getByRole('toolbar', { name: '编辑布局', exact: true })).toHaveCount(0);
  await page.reload(); await expectPosition(alpha, target);
  await expect(desktopNames(page)).toHaveCount(3);
  await saveNavigationScreenshot(page, testInfo, 'saved-pointer-layout');
});

test('an edit opened before another real tab saves cannot overwrite its newer site', async ({ extension }) => {
  const first = await extension.newtab();
  await addSite(first, 'Concurrent Original', 'https://example.com/concurrent');
  const stale = await editSiteThroughKeyboard(first, 'Concurrent Original');
  await stale.getByLabel('名称', { exact: true }).fill('Stale Draft');
  const second = await extension.newtab();
  const current = await editSiteThroughKeyboard(second, 'Concurrent Original');
  await current.getByLabel('名称', { exact: true }).fill('Newer Saved Version');
  await current.getByRole('button', { name: '保存', exact: true }).click();
  await expect(current).toBeHidden();
  await expect(first.locator('.navigation-shelf .site-name')).toHaveText('Newer Saved Version');
  await stale.getByRole('button', { name: '保存', exact: true }).click();
  await expect(stale.getByRole('alert')).toContainText(/其他页面|另一个标签页/);
  await expect(stale).toBeVisible();
  await stale.getByRole('button', { name: '取消', exact: true }).click();
  await first.reload();
  await expect(desktopNames(first)).toHaveText(['Newer Saved Version']);
  await expect(first.getByText('Stale Draft', { exact: true })).toHaveCount(0);
});
