import { test, expect, openSettings, addSite } from './extension.fixture.mjs';

test('@smoke real unpacked extension opens with native Chrome APIs', async ({ extension }) => {
  const page = await extension.newtab();
  await expect(page).toHaveTitle('Covelet 新标签页');
  const runtime = await page.evaluate(() => ({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest().manifest_version, session: typeof chrome.storage.session.get }));
  expect(runtime).toEqual({ id: extension.id, manifest: 3, session: 'function' });
});

test('fresh desktop stays empty across reload and offers no clock catalog entry', async ({ extension }) => {
  const page = await extension.newtab();
  await expect(page.locator('.site-tile')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('combobox', { name: '搜索或输入网址' })).toBeVisible();
  await expect(page.locator('.site-tile')).toHaveCount(0);
  await page.getByRole('button', { name: '打开扩展', exact: true }).click();
  await expect(page.locator('.extension-grid')).toBeVisible();
  await expect(page.locator('#extension-clock')).toHaveCount(0);
  await expect(page.locator('#extension-notes')).toBeVisible();
});

test('add a site and find it through actual search keyboard input', async ({ extension }) => {
  const page = await extension.newtab();
  await addSite(page, 'Playwright 导航样例', 'https://example.com/covelet-playwright');
  const search = page.getByRole('combobox', { name: '搜索或输入网址' });
  await search.click();
  await search.fill('导航样例');
  await expect(page.getByRole('listbox')).toContainText('Playwright 导航样例');
  await search.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-activedescendant', 'candidate-0');
  await search.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(search).toBeFocused();
});

test('web search uses the chosen engine and keyboard Enter', async ({ extension, network }) => {
  const page = await extension.newtab();
  await page.getByRole('button', { name: /^选择搜索引擎/ }).click();
  await page.getByRole('menuitemradio', { name: '必应', exact: true }).click();
  const search = page.getByRole('combobox', { name: '搜索或输入网址' });
  await search.fill('Covelet Playwright 搜索');
  const destination = page.waitForURL(url => url.origin === 'https://www.bing.com' && url.pathname === '/search');
  await search.press('Enter');
  await destination;
  expect(new URL(page.url()).searchParams.get('q')).toBe('Covelet Playwright 搜索');
  expect(network.requests.some(item => item.url.includes('/search?q='))).toBe(true);
});

test('data settings use user copy and retain the unencrypted-backup warning', async ({ extension }) => {
  const page = await extension.newtab();
  const settings = await openSettings(page, '数据');
  const version = await page.evaluate(() => chrome.runtime.getManifest().version);
  await settings.getByRole('button', { name: `${version} 更新内容`, exact: true }).click();
  await expect(settings).toContainText('新安装默认空桌面。');
  await expect(settings).toContainText('阿里云 OSS 仍为 Beta。');
  await expect(settings).toContainText('导出的备份文件未加密，请妥善保管。');
  await expect(settings.getByRole('button', { name: '恢复上一份导航副本', exact: true })).toBeVisible();
  await expect(settings).not.toContainText('真实云账号验收仍待完成');
  await settings.getByRole('button', { name: '备份与恢复中心', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '备份与恢复中心', exact: true })).toContainText('恢复前会在当前浏览器保留一份副本。');
});

test('homepage time is separate from widgets and minimal mode persists', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  await expect(page.locator('.home-time time.clock-time')).toBeVisible();
  await expect(page.locator('.home-time .clock-date')).toBeVisible();
  expect(await page.locator('.home-time time').getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await expect(page.locator('.clock-widget')).toHaveCount(0);
  let settings = await openSettings(page, '外观');
  const minimal = settings.getByRole('switch', { name: '极简模式', exact: true });
  await expect(minimal).toHaveAttribute('aria-checked', 'false');
  await minimal.click();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(page.locator('.home-time')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '搜索或输入网址' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('combobox', { name: '搜索或输入网址' })).toBeVisible();
  await expect(page.locator('.home-time')).toHaveCount(0);
  settings = await openSettings(page, '外观');
  await expect(settings.getByRole('switch', { name: '极简模式', exact: true })).toHaveAttribute('aria-checked', 'true');
  await settings.getByRole('switch', { name: '极简模式', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.home-time time.clock-time')).toBeVisible();
  const path = testInfo.outputPath('homepage-time.png');
  await page.screenshot({ path });
  await testInfo.attach('homepage-time', { path, contentType: 'image/png' });
});

for (const theme of ['浅色', '深色']) for (const width of [1280, 390]) {
  test(`search stays usable without an inner border: ${theme}, ${width}px`, async ({ extension, network }, testInfo) => {
    const page = await extension.newtab();
    await page.setViewportSize({ width, height: 900 });
    const settings = await openSettings(page, '外观');
    await settings.getByRole('combobox', { name: '主题', exact: true }).click();
    await page.getByRole('option', { name: theme, exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    const engine = page.getByRole('button', { name: /^选择搜索引擎/ });
    const search = page.getByRole('combobox', { name: '搜索或输入网址' });
    const geometry = await engine.evaluate((button) => {
      const box = button.getBoundingClientRect(), input = document.querySelector('.search-box input').getBoundingClientRect(), style = getComputedStyle(button);
      return { width: box.width, height: box.height, engineRight: box.right, inputLeft: input.left, borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    expect(geometry.width).toBeGreaterThanOrEqual(44);
    expect(geometry.height).toBeGreaterThanOrEqual(44);
    expect(geometry.engineRight).toBeLessThanOrEqual(geometry.inputLeft + 1);
    expect(geometry.borderWidths).toEqual(['0px', '0px', '0px', '0px']);
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    await engine.click();
    await page.getByRole('menuitemradio', { name: '必应', exact: true }).click();
    await expect(search).toBeFocused();
    await search.dispatchEvent('compositionstart', { data: '中' });
    await search.fill('中文输入尚未确认');
    const location = page.url(), before = network.requests.length;
    await search.press('Enter');
    expect(page.url()).toBe(location);
    expect(network.requests.length).toBe(before);
    await expect(search).toHaveValue('中文输入尚未确认');
    await search.dispatchEvent('compositionend', { data: '中文输入尚未确认' });
    await search.press('Escape');
    const path = testInfo.outputPath(`search-${width}-${theme}.png`);
    await page.screenshot({ path });
    await testInfo.attach('search-layout', { path, contentType: 'image/png' });
  });
}
