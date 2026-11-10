import { addSite, expect, test } from './extension.fixture.mjs';
import { pointerDrag, tileNamed } from './navigation-helpers.mjs';

test('local search filters by type and opens only the chosen saved folder links', async ({ extension }) => {
  await extension.context.route(/^https:\/\/example\.invalid\/(?:favicon\.ico|apple-touch-icon(?:-precomposed)?\.png|android-chrome-192x192\.png)$/,
    route => route.fulfill({ status: 404, body: '' }));
  await extension.context.route(/^https:\/\/example\.invalid\/launch-(alpha|beta|gamma)$/,
    route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'Launch destination fixture' }));
  const page = await extension.newtab();
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    await addSite(page, `Launch ${name}`, `https://example.invalid/launch-${name.toLowerCase()}`);
  }
  await pointerDrag(page, tileNamed(page, 'Launch Alpha').locator('.site-icon'),
    tileNamed(page, 'Launch Beta').locator('.site-icon'), '合并为文件夹');

  const folderTile = tileNamed(page, '新建文件夹').locator('.site-link');
  await folderTile.click();
  let folder = page.getByRole('dialog', { name: '新建文件夹', exact: true });
  const name = folder.getByRole('textbox', { name: '文件夹名称', exact: true });
  await name.fill('Launch Project');
  await name.press('Enter');
  folder = page.getByRole('dialog', { name: 'Launch Project', exact: true });
  await expect(folder).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(folder).toBeHidden();

  const search = page.getByRole('combobox', { name: '搜索或输入网址', exact: true });
  const filter = page.getByRole('button', { name: '筛选搜索结果', exact: true });
  await search.fill('Launch');
  await expect(page.getByRole('option')).toHaveCount(4);
  await filter.click();
  await page.getByRole('menuitemradio', { name: '文件夹', exact: true }).click();
  await expect(search).toBeFocused();
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toContainText('Launch Project');
  await filter.click();
  await page.getByRole('menuitemradio', { name: '网站', exact: true }).click();
  await expect(page.getByRole('option')).toHaveCount(3);
  await expect(page.getByRole('option').filter({ hasText: 'Launch Alpha' })).toContainText('Launch Project');
  await search.press('Escape');

  await tileNamed(page, 'Launch Project').locator('.site-link').click();
  await folder.getByRole('button', { name: '批量打开网站', exact: true }).click();
  const launch = page.getByRole('dialog', { name: '批量打开网站', exact: true });
  await expect(launch.getByRole('checkbox')).toHaveCount(2);
  await expect(launch.getByRole('button', { name: '打开 2 个网站', exact: true })).toBeVisible();
  await launch.getByRole('checkbox', { name: '选择 Launch Beta', exact: true }).uncheck();
  const previousPages = new Set(extension.context.pages());
  const newPageReady = extension.context.waitForEvent('page');
  await launch.getByRole('button', { name: '打开 1 个网站', exact: true }).click();
  const opened = await newPageReady;
  // The browser may start navigation before Playwright attaches to a tab
  // created by the extension. A reserved destination can render a Chrome error page.
  await expect(launch).toBeHidden();
  expect(extension.context.pages().filter(item => !previousPages.has(item))).toEqual([opened]);
});

test('the runtime registers its shortcut and shortcut URLs focus local search', async ({ extension }) => {
  const commands = await extension.worker.evaluate(() => chrome.commands.getAll());
  expect(commands).toEqual(expect.arrayContaining([expect.objectContaining({
    name: 'open-search', shortcut: '', description: expect.any(String),
  })]));
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.id}/newtab.html?focus=search`);
  await expect(page.getByRole('combobox', { name: '搜索或输入网址', exact: true })).toBeFocused();
});
