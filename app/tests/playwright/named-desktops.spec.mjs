import { test, expect, addSite, openSettings } from './extension.fixture.mjs';
import { enterLayout } from './navigation-helpers.mjs';

test('named desktops follow screen reordering, keyboard search and the saved default', async ({ extension }) => {
  const page = await extension.newtab();
  await addSite(page, 'Personal home', 'https://personal.example/');
  await enterLayout(page, 'Personal home');
  const editor = page.getByRole('toolbar', { name: '编辑布局' });
  await editor.getByRole('button', { name: '屏幕管理' }).click();
  const manager = page.getByRole('dialog', { name: '屏幕管理' });
  await manager.getByRole('button', { name: '添加一屏' }).click();
  const work = manager.getByRole('textbox', { name: '第 2 屏名称' });
  await work.fill('工作');
  await work.press('Enter');
  await manager.getByRole('button', { name: '前往 工作', exact: true }).click();
  await editor.getByRole('button', { name: '完成' }).click();
  await expect(editor).toBeHidden();
  await expect(page.locator('.desktop-page-name')).toHaveText('工作');
  await addSite(page, 'Project home', 'https://project.example/');

  const settings = await openSettings(page, '布局');
  await settings.getByRole('combobox', { name: '默认桌面' }).click();
  await settings.getByRole('option', { name: '工作' }).click();
  await expect(settings.getByRole('combobox', { name: '默认桌面' })).toHaveText('工作');
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await enterLayout(page, 'Project home');
  await editor.getByRole('button', { name: '屏幕管理' }).click();
  await manager.getByRole('button', { name: '前移 工作' }).click();
  await manager.getByRole('button', { name: '前往 工作', exact: true }).click();
  await editor.getByRole('button', { name: '完成' }).click();
  await expect(editor).toBeHidden();
  await expect(page.locator('.desktop-page[aria-hidden="false"] .site-name')).toHaveText(['Project home']);

  const restarted = await extension.restart(), next = await restarted.newtab();
  await expect(next.locator('.desktop-page-name')).toHaveText('工作');
  await next.getByRole('button', { name: '下一屏', exact: true }).click();
  await expect(next.locator('.desktop-page[aria-hidden="false"] .site-name')).toHaveText(['Personal home']);
  const search = next.getByRole('combobox', { name: '搜索或输入网址' });
  await search.fill('工作');
  await search.press('Enter');
  await expect(next.locator('.desktop-page[aria-hidden="false"] .site-name')).toHaveText(['Project home']);
});
