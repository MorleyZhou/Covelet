import { readFile } from 'node:fs/promises';
import { test, expect } from './extension.fixture.mjs';

test('empty desktop offers first-use actions and remembers starting blank', async ({ extension }) => {
  const page = await extension.newtab();
  const onboarding = page.locator('.empty-desktop');
  await expect(onboarding.getByRole('button')).toHaveText(['添加常用网站', '导入书签', '空白开始']);
  for (const viewport of [{ width: 390, height: 540 }, { width: 1280, height: 620 }]) {
    await page.setViewportSize(viewport);
    await expect(onboarding.getByRole('button', { name: '添加常用网站' })).toBeInViewport();
    await expect(onboarding.getByRole('button', { name: '空白开始' })).toBeInViewport();
  }
  await onboarding.getByRole('button', { name: '添加常用网站' }).click();
  const add = page.getByRole('dialog', { name: '添加网站', exact: true });
  await expect(add).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(add).toBeHidden();
  await onboarding.getByRole('button', { name: '空白开始' }).click();
  await expect(onboarding).toHaveCount(0);
  const restarted = await extension.restart();
  const freshTab = await restarted.newtab();
  await expect(freshTab.locator('.empty-desktop')).toHaveCount(0);
  await expect(freshTab.locator('.site-tile')).toHaveCount(0);
});

test('Markdown preview groups links and offline HTML download excludes marked links', async ({ extension }) => {
  const page = await extension.newtab();
  await page.locator('.empty-desktop').getByRole('button', { name: '导入书签', exact: true }).click();
  const importer = page.locator('.bookmark-import');
  await expect(importer.getByRole('button', { name: '导入 Markdown 链接文件', exact: true })).toBeVisible();
  const source = ['- [私密网址](https://private.example/)', '# 工作资料', '- [公开网址](https://public.example/?a=1&b=2)', '- [跳过](https://skip.example/)'].join('\n');
  await importer.locator('input[type=file]').setInputFiles({ name: 'links.md', mimeType: 'text/markdown', buffer: Buffer.from(source) });
  await expect(importer.locator('.bookmark-import-list')).toContainText('工作资料');
  await importer.getByRole('checkbox', { name: '选择 跳过', exact: true }).click();
  await importer.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(importer).toHaveCount(0);

  const privateSite = page.locator('.site-link[href="https://private.example/"]');
  await expect(privateSite).toBeVisible();
  await privateSite.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '标记为私密', exact: true }).click();
  await expect(privateSite).toBeVisible();
  await privateSite.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '取消私密标记', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.desktop-page-viewport').press('Shift+F10');
  await page.getByRole('menuitem', { name: '导出书签 HTML', exact: true }).click();
  const exporter = page.getByRole('dialog', { name: '导出书签 HTML', exact: true });
  const downloadPromise = page.waitForEvent('download');
  await exporter.getByRole('button', { name: '导出', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('covelet-bookmarks.html');
  const html = await readFile(await download.path(), 'utf8');
  expect(html).toContain('<H3>工作资料</H3>');
  expect(html).toContain('https://public.example/?a=1&amp;b=2');
  expect(html).not.toMatch(/private\.example|skip\.example|私密网址/);
});
