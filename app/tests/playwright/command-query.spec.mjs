import { test, expect, openSettings } from './extension.fixture.mjs';
import { tileNamed } from './navigation-helpers.mjs';
import { readFile } from 'node:fs/promises';

// These scenarios exercise the production MV3 pages and encrypted persistence.
// Fixture data enters only through the supported dialogs and toolbar popup.
const project = '项目 A';
const secretProject = 'Secret project';
const secretTitle = 'Hidden acquisition dossier';
const password = 'fixture-hidden-password';
const searchBox = page => page.getByRole('combobox', { name: '搜索或输入网址', exact: true });
const palette = page => page.getByRole('dialog', { name: '命令面板', exact: true });

async function pickTags(scope, tags) {
  for (const tag of tags) {
    const existing = scope.getByRole('checkbox', { name: tag, exact: true });
    if (await existing.count()) await existing.check();
    else {
      await scope.getByRole('textbox', { name: '新标签名称', exact: true }).fill(tag);
      await scope.getByRole('button', { name: '添加标签', exact: true }).click();
      await expect(scope.getByRole('checkbox', { name: tag, exact: true })).toBeChecked();
    }
  }
}

async function addTaggedSite(page, name, url, tags = [], description = '') {
  await page.getByRole('button', { name: '添加网站', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加网站', exact: true });
  await dialog.getByLabel('网址', { exact: true }).fill(url);
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  if (description) await dialog.getByRole('textbox', { name: '备注', exact: true }).fill(description);
  await pickTags(dialog, tags);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(tileNamed(page, name)).toBeVisible();
}

async function addReading(extension, name, url, tags = []) {
  const popup = await extension.context.newPage();
  const path = await extension.worker.evaluate(() => chrome.runtime.getManifest().action.default_popup);
  await popup.goto(`chrome-extension://${extension.id}/${path}`);
  await popup.getByRole('tab', { name: '稍后读', exact: true }).click();
  await expect(popup.getByLabel('网址', { exact: true })).toBeEnabled();
  await popup.getByLabel('网址', { exact: true }).fill(url);
  await popup.getByLabel('名称', { exact: true }).fill(name);
  if (tags.length) {
    await popup.getByRole('button', { name: '备注与标签', exact: true }).click();
    await pickTags(popup, tags);
  }
  const closed = popup.waitForEvent('close');
  await popup.getByRole('button', { name: '保存', exact: true }).click();
  await closed;
}

async function markPrivate(page, name) {
  await tileNamed(page, name).locator('.site-link').focus();
  await tileNamed(page, name).locator('.site-link').press('Shift+F10');
  await page.getByRole('menuitem', { name: '搜索别名', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '内容与隐私', exact: true });
  await dialog.getByRole('checkbox', { name: '开启隐藏时锁定此内容', exact: true }).check();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function hidePrivate(page) {
  await page.getByRole('button', { name: '开启隐藏', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置隐藏密码', exact: true });
  await dialog.getByLabel('新密码', { exact: true }).fill(password);
  await dialog.getByLabel('确认密码', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: '设置并隐藏', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: '关闭隐藏', exact: true })).toBeVisible();
}

test('command panel opens from the toolbar and keyboard, returns focus, and opens a chosen action', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  const trigger = page.getByRole('button', { name: '命令面板', exact: true });
  await trigger.click();
  const panel = palette(page);
  await expect(panel).toBeVisible();
  const input = panel.getByRole('combobox');
  await expect(input).toBeFocused();
  const initialSelection = await input.getAttribute('aria-activedescendant');
  await input.press('ArrowDown');
  await expect(input).not.toHaveAttribute('aria-activedescendant', initialSelection);
  await input.press('ArrowUp');
  await expect(input).toHaveAttribute('aria-activedescendant', initialSelection);
  await input.dispatchEvent('compositionstart', { data: '设' });
  await input.press('Enter');
  await expect(panel).toBeVisible();
  await input.dispatchEvent('compositionend', { data: '设置' });
  await input.fill('设置');
  await expect(panel.getByRole('option').filter({ hasText: '设置' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Control+k');
  await expect(panel).toBeVisible();
  await input.fill('设置');
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(panel).toBeHidden();
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(settings).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('command-settings.png'), animations: 'disabled' });
});

test('quoted tags and combined type, domain, state and exclusion filters use local data and survive saving a view', async ({ extension, network }, testInfo) => {
  const page = await extension.newtab();
  await addTaggedSite(page, 'Project reference', 'https://docs.example/project-reference', [project]);
  await addReading(extension, 'Project unread guide', 'https://docs.example/guide', [project]);
  await addReading(extension, 'Project completed guide', 'https://docs.example/completed', [project, '已完成']);
  const search = searchBox(page);
  const query = `tag:"${project}" type:reading is:unread domain:docs.example -tag:已完成`;
  const requestCount = network.requests.length;
  await search.fill(query);
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toContainText('Project unread guide');
  await expect(page.locator('.structured-conditions .query-condition')).toHaveCount(5);
  await page.getByRole('button', { name: '移除条件 domain: docs.example', exact: true }).click();
  await expect(search).not.toHaveValue(/domain:/);
  await expect(page.locator('.structured-conditions .query-condition')).toHaveCount(4);
  await search.fill(query);
  await expect(page.getByRole('option')).toHaveCount(1);
  expect(network.requests.slice(requestCount)).toEqual([]);

  await page.getByRole('button', { name: '动态清单', exact: true }).click();
  const views = page.getByRole('dialog', { name: '动态清单', exact: true });
  await views.getByRole('button', { name: '保存当前筛选', exact: true }).click();
  await views.getByLabel('清单名称', { exact: true }).fill('Project unread queue');
  await expect(views.getByRole('group', { name: '排除标签', exact: true })).toContainText('已完成');
  await expect(views.getByRole('status')).toContainText('当前匹配 1 项');
  await views.getByRole('button', { name: '保存', exact: true }).click();
  await expect(views.locator('.saved-view-open').filter({ hasText: 'Project unread queue' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(views).toBeHidden();
  await page.reload();
  await expect(search).toBeVisible();
  await page.getByRole('button', { name: '动态清单', exact: true }).click();
  await views.locator('.saved-view-open').filter({ hasText: 'Project unread queue' }).click();
  await expect(views).toBeHidden();
  await expect(page.locator('.saved-search-context')).toContainText('Project unread queue');
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toContainText('Project unread guide');
  await page.screenshot({ path: testInfo.outputPath('saved-structured-view.png'), animations: 'disabled' });
});

test('invalid conditions fail closed, and private tag or content names cannot appear as suggestions', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  await addTaggedSite(page, 'Public acquisition brief', 'https://docs.example/public', [project]);
  await addTaggedSite(page, secretTitle, 'https://private.example/dossier', [secretProject]);
  await markPrivate(page, secretTitle);
  await hidePrivate(page);
  const search = searchBox(page);
  for (const query of [`tag:"${secretProject}"`, 'tag:"No such tag"', 'type:unknown', 'is:unknown', 'domain:']) {
    await search.fill(query);
    await expect(page.getByRole('option')).toHaveCount(0);
    const before = extension.context.pages().length;
    await search.press('Enter');
    await expect(page.getByRole('option')).toHaveCount(0);
    expect(extension.context.pages()).toHaveLength(before);
    await expect(page.locator('.structured-conditions')).toContainText('搜索条件无效，请检查类型、标签或引号。');
    await page.getByRole('button', { name: '清除条件', exact: true }).click();
    await expect(search).toHaveValue('');
  }
  await search.fill('acquisition');
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toContainText('Public acquisition brief');
  await search.press('Escape');
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const panel = palette(page);
  await panel.getByRole('combobox').fill('acquisition');
  await expect(panel).not.toContainText(secretTitle);
  await expect(panel).not.toContainText(secretProject);
  await page.screenshot({ path: testInfo.outputPath('hidden-command-results.png'), animations: 'disabled' });
});

test('IME and active editors keep their keyboard ownership when a command shortcut is pressed', async ({ extension }) => {
  const page = await extension.newtab();
  await page.getByRole('button', { name: '添加网站', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '添加网站', exact: true });
  const name = editor.getByLabel('名称', { exact: true });
  await name.fill('Unfinished project name');
  await name.press('Control+k');
  await expect(palette(page)).toBeHidden();
  await expect(name).toHaveValue('Unfinished project name');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  // This checks composition dispatch in the real extension input. Native OS
  // IME candidate-window behavior remains a separately recorded manual check.
  const search = searchBox(page);
  await search.focus();
  await search.dispatchEvent('compositionstart', { data: '项' });
  await search.dispatchEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true, keyCode: 229 });
  await expect(palette(page)).toBeHidden();
  await search.dispatchEvent('compositionend', { data: '项目' });
});

test('an explicit engine keyword keeps operator-looking external text literal', async ({ extension, network }) => {
  // Adding an engine may explicitly inspect that engine's homepage. Keep that
  // separately allowed action local to this scenario; search itself still
  // uses the fixture's exact /search destination.
  await extension.context.route('https://www.bing.com/', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<!doctype html><title>Fixture engine</title>',
  }));
  const page = await extension.newtab();
  const settings = await openSettings(page, '搜索');
  await settings.getByLabel('引擎名称', { exact: true }).fill('Fixture keyword engine');
  await settings.getByLabel('搜索地址模板', { exact: true }).fill('https://www.bing.com/search?q={query}');
  await settings.getByLabel('搜索关键词', { exact: true }).fill('gh');
  await settings.getByRole('button', { name: '添加引擎', exact: true }).click();
  await expect(settings.locator('.provider-keyword').filter({ hasText: 'gh' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  const search = searchBox(page);
  await search.fill('gh type:foo');
  await expect(page.locator('.structured-conditions')).toHaveCount(0);
  await expect(page.locator('.search-keyword-hint')).toContainText('Fixture keyword engine');
  const destination = page.waitForURL(url => url.origin === 'https://www.bing.com' && url.pathname === '/search');
  await search.press('Enter');
  await destination;
  expect(new URL(page.url()).searchParams.get('q')).toBe('type:foo');
  expect(network.requests.some(request => new URL(request.url).searchParams.get('q') === 'type:foo')).toBe(true);
});

test('command conditions remain translated and usable in all eight languages at a narrow viewport', async ({ extension }, testInfo) => {
  const catalog = JSON.parse(await readFile(new URL('../../src/i18n/catalog.json', import.meta.url), 'utf8'));
  const languages = [['zh-CN', '简体中文'], ['en', 'English'], ['zh-TW', '繁體中文'], ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['ru', 'Русский']];
  const tr = (key, locale) => locale === 'zh-CN' ? key : catalog[key]?.[locale] || catalog[key]?.en || key;
  const page = await extension.newtab();
  let current = 'zh-CN';
  await page.setViewportSize({ width: 390, height: 540 });
  for (const [locale, language] of languages) {
    await page.getByRole('button', { name: tr('打开设置', current), exact: true }).click();
    const settings = page.getByRole('dialog', { name: tr('设置', current), exact: true });
    await settings.getByRole('tab', { name: tr('外观', current), exact: true }).click();
    await settings.locator('.language-setting').getByRole('combobox').click();
    await settings.getByRole('option', { name: language, exact: true }).click();
    current = locale;
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await page.getByRole('button', { name: tr('命令面板', locale), exact: true }).click();
    const panel = page.getByRole('dialog', { name: tr('命令面板', locale), exact: true });
    const input = panel.getByRole('combobox', { name: tr('搜索内容或操作', locale), exact: true });
    await expect(input).toBeFocused();
    if (locale === 'zh-CN') await page.screenshot({ path: testInfo.outputPath('command-default-390x540.png'), animations: 'disabled' });
    await input.fill('type:reading is:unread');
    await expect(panel.locator('.query-condition')).toHaveCount(2);
    await input.fill('type:unknown');
    await expect(panel.locator('.structured-conditions')).toContainText(tr('搜索条件无效，请检查类型、标签或引号。', locale));
    await expect(panel.getByRole('option')).toHaveCount(0);
    const geometry = await panel.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: element.clientWidth, scrollWidth: element.scrollWidth, viewport: innerWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
    await page.screenshot({ path: testInfo.outputPath(`command-${locale}-390x540.png`), animations: 'disabled' });
    await panel.getByRole('button', { name: tr('清除条件', locale), exact: true }).click();
    await expect(input).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  }
});
