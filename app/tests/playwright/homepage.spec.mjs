import { test, expect, openSettings, openSync, addSite } from './extension.fixture.mjs';

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

test('settings separate backup, trash, and about, and sync opens from Extensions', async ({ extension }) => {
  const page = await extension.newtab();
  const settings = await openSettings(page, '关于');
  const version = await page.evaluate(() => chrome.runtime.getManifest().version);
  await settings.getByRole('button', { name: `${version} 更新内容`, exact: true }).click();
  await expect(settings).toContainText('网站和稍后读支持备注，网站、便笺与稍后读共用标签。');
  await settings.getByRole('button', { name: '0.4.0 更新内容', exact: true }).click();
  await expect(settings).toContainText('命名桌面、设置默认桌面并搜索跳转。');
  await settings.getByRole('button', { name: '0.3.1 更新内容', exact: true }).click();
  await expect(settings).toContainText('首页保持一屏。');
  await settings.getByRole('button', { name: '0.3.0 更新内容', exact: true }).click();
  await expect(settings).toContainText('新安装默认空桌面。');
  await expect(settings).not.toContainText('阿里云 OSS 仍为 Beta。');
  await expect(settings).not.toContainText('真实云账号验收仍待完成');
  await expect(settings.getByRole('link', { name: '隐私政策', exact: true })).toHaveAttribute('href', 'https://covelet.future-element.com/privacy/');
  await settings.getByRole('button', { name: '隐私自查', exact: true }).click();
  await expect(settings).toContainText('当前权限与用途');
  await expect(settings.getByRole('tab', { name: '数据', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('tab', { name: '隐私自查', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('tab', { name: '时间与日期', exact: true })).toBeVisible();
  await settings.getByRole('tab', { name: '回收站', exact: true }).click();
  await expect(settings.getByRole('tabpanel', { name: '回收站', exact: true })).toContainText('回收站为空');
  await settings.getByRole('tab', { name: '备份与恢复', exact: true }).click();
  const backup = settings.getByRole('tabpanel', { name: '备份与恢复', exact: true });
  await expect(backup.getByRole('button')).toHaveText(['导出备份', '加密导出', '恢复备份']);
  await expect(backup).toContainText('普通备份文件未加密，请妥善保管。');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await expect(await openSync(page)).toBeVisible();
});

test('homepage time is separate from widgets and minimal mode persists', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  await expect(page.locator('.home-time time.clock-time')).toBeVisible();
  await expect(page.locator('.home-time .clock-date')).toBeVisible();
  expect(await page.locator('.home-time time').getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await expect(page.locator('.clock-widget')).toHaveCount(0);
  let settings = await openSettings(page, '外观');
  const minimal = settings.getByRole('switch', { name: '极简模式', exact: true });
  await expect(settings.locator('.appearance-toggle')).toHaveText('极简模式');
  await expect(settings.getByText('隐藏时间和日期。', { exact: true })).toHaveCount(0);
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
  await expect(settings.locator('.appearance-toggle')).toHaveText('极简模式');
  await expect(settings.getByRole('switch', { name: '极简模式', exact: true })).toHaveAttribute('aria-checked', 'true');
  await settings.getByRole('switch', { name: '极简模式', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.home-time time.clock-time')).toBeVisible();
  const path = testInfo.outputPath('homepage-time.png');
  await page.screenshot({ path });
  await testInfo.attach('homepage-time', { path, contentType: 'image/png' });
});

test('clock, search, and navigation share one viewport on short screens', async ({ extension }) => {
  const page = await extension.newtab();
  for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']) await addSite(page, name, `https://example.com/viewport-${name.toLowerCase()}`);
  for (const viewport of [{ width: 1280, height: 620 }, { width: 390, height: 540 }]) {
    await page.setViewportSize(viewport);
    await expect(page.locator('.home-time')).toBeInViewport();
    await expect(page.getByRole('combobox', { name: '搜索或输入网址' })).toBeInViewport();
    const desktop = page.locator('.desktop-page-viewport');
    await expect(desktop).toBeInViewport();
    await expect(desktop.locator('.desktop-page[aria-hidden=false] .site-link').first()).toBeInViewport();
    const dimensions = await desktop.evaluate(element => {
      const { top, bottom, height } = element.getBoundingClientRect();
      return { top, bottom, height, viewport: innerHeight, document: document.scrollingElement.scrollHeight,
        navigationScrollHeight: element.scrollHeight, navigationClientHeight: element.clientHeight };
    });
    expect(dimensions.top).toBeGreaterThanOrEqual(0);
    expect(dimensions.height).toBeGreaterThan(0);
    expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.document).toBe(dimensions.viewport);
    expect(dimensions.navigationScrollHeight, `navigation fits at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(dimensions.navigationClientHeight + 1);
    await desktop.hover();
    await page.mouse.wheel(0, 900);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  }
});

test('time zone changes the displayed day, and calendar options persist across reload', async ({ extension }) => {
  const page = await extension.newtab();
  await page.clock.install({ time: new Date('2026-01-20T04:00:00Z') });
  await page.reload();
  await expect(page.locator('.clock-lunar')).toBeVisible();
  await expect(page.locator('.clock-zodiac')).toBeVisible();
  let settings = await openSettings(page, '时间与日期');
  const zone = () => settings.getByRole('combobox', { name: '时区', exact: true });
  await zone().click();
  await page.getByRole('option', { name: '北京', exact: true }).click();
  await expect(page.locator('.clock-zodiac')).toHaveText('水瓶座');
  await zone().click();
  await page.getByRole('option', { name: '洛杉矶', exact: true }).click();
  await expect(page.locator('.clock-zodiac')).toHaveText('摩羯座');
  await settings.getByRole('switch', { name: '显示农历', exact: true }).click();
  await settings.getByRole('switch', { name: '显示星座', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.clock-lunar')).toHaveCount(0);
  await expect(page.locator('.clock-zodiac')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.home-time time.clock-time')).toBeVisible();
  settings = await openSettings(page, '时间与日期');
  await expect(zone()).toHaveText('洛杉矶');
  await expect(settings.getByRole('switch', { name: '显示农历', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(settings.getByRole('switch', { name: '显示星座', exact: true })).toHaveAttribute('aria-checked', 'false');
});

test('appearance settings keep compact rows and keyboard access at 390px', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  await page.setViewportSize({ width: 390, height: 844 });
  const settings = await openSettings(page, '外观');
  const controls = settings.getByRole('group', { name: '外观', exact: true });
  await expect(controls.getByRole('combobox', { name: '语言', exact: true })).toBeInViewport();
  const theme = controls.getByRole('combobox', { name: '主题', exact: true });
  await expect(theme).toBeInViewport();
  await expect(controls.getByRole('switch', { name: '极简模式', exact: true })).toBeInViewport();
  const geometry = await settings.locator('.appearance-settings').evaluate(panel => {
    const rect = element => {
      const { y, width, height, left, right } = element.getBoundingClientRect();
      return { y, width, height, left, right };
    };
    const sliders = [...panel.querySelectorAll('.appearance-ranges [role=slider]')]
      .map(slider => rect(slider.closest('.range-label')));
    return { sliders, fits: panel.scrollWidth <= panel.clientWidth + 1 };
  });
  expect(geometry.fits).toBe(true);
  await expect(settings.getByRole('button', { name: '颜色', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Bing 每日壁纸', exact: true })).toHaveCount(0);
  expect(geometry.sliders).toHaveLength(2);
  expect(geometry.sliders[0].left).toBeCloseTo(geometry.sliders[1].left, 0);
  expect(geometry.sliders[0].right).toBeCloseTo(geometry.sliders[1].right, 0);
  await theme.press('Space');
  await expect(page.getByRole('option', { name: '深色', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(theme).toBeFocused();
  const screenshot = testInfo.outputPath('appearance-390.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('appearance-narrow', { path: screenshot, contentType: 'image/png' });
  await expect(settings.getByRole('button', { name: '桌面方案与分享', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await page.locator('.desktop-page-viewport').dispatchEvent('contextmenu', { clientX: 120, clientY: 150 });
  const layoutMenu = page.getByRole('menu', { name: '布局操作', exact: true });
  await expect(layoutMenu.getByRole('menuitem', { name: '编辑布局', exact: true })).toBeVisible();
  await expect(layoutMenu.getByRole('menuitem', { name: '桌面方案与分享', exact: true })).toHaveCount(0);
  await layoutMenu.getByRole('menuitem', { name: '导入网址与书签 HTML', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '导入网址与书签 HTML', exact: true })).toBeVisible();
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
