import { test, expect } from './extension.fixture.mjs';
import { exportCompleteBackup, openRecovery, chooseBackupFile, restorePreview, revealDesktopItem } from './backup-helpers.mjs';
import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(await readFile(new URL('../../src/i18n/catalog.json', import.meta.url), 'utf8'));
const t = (key, locale = 'zh-CN') => locale === 'zh-CN' ? key : catalog[key]?.[locale] || catalog[key]?.en || key;
const tags = [{ id: 'tag-dev', name: 'Development' }, { id: 'tag-design', name: 'Design' }, { id: 'tag-done', name: 'Completed' }, { id: 'tag-private', name: 'Restricted project' }];
const search = page => page.getByRole('combobox', { name: '搜索或输入网址', exact: true });
const tile = (page, id) => page.locator(`[data-entry-id="${id}"]`);
const row = (dialog, id) => dialog.locator(`.reading-record[data-record-id="${id}"]`);
const metadata = (tagIds = [], description = 'Preserved article context') => ({ tagIds, description });
function record(id, title, { status = 'unread', revisitOn, ...rest } = {}) {
  const now = Date.now() - 10_000;
  return { id, title, url: `https://example.com/${id}`, status, revision: 1, createdAt: now - 1000, updatedAt: now, ...(revisitOn ? { revisitOn } : {}), ...rest };
}
const matrix = () => [record('read-a', 'Alpha article', { revisitOn: '2026-11-14' }), record('read-b', 'Beta article', { revisitOn: '2026-11-20' }),
  record('read-c', 'Gamma article', { revisitOn: '2026-11-15' }), record('read-d', 'Unselected article', { status: 'read', revisitOn: '2026-11-13' })];
const matrixMetadata = () => ({ 'reading:read-a': metadata(['tag-dev']), 'reading:read-b': metadata(['tag-design']),
  'reading:read-c': metadata(['tag-dev', 'tag-design', 'tag-done']), 'reading:read-d': metadata(['tag-dev']) });

async function closeDialog(page, title, locale = 'zh-CN') {
  const dialog = page.getByRole('dialog', { name: t(title, locale), exact: true });
  await dialog.getByRole('button', { name: t('关闭', locale), exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function snapshot(page) {
  const backup = await exportCompleteBackup(page);
  await closeDialog(page, '设置');
  return backup;
}
// Seed many precise date/tag combinations through the supported backup picker.
// Nothing in this suite writes Chrome storage or invokes application internals.
async function seed(page, { reading = matrix(), items = matrixMetadata(), privateKeys = [], notes = [], views = [] } = {}) {
  const baseline = await snapshot(page), data = structuredClone(baseline.data);
  data.tools = { ...data.tools, revision: data.tools.revision + 1, reading, notes };
  data.preferences = { ...data.preferences, revision: data.preferences.revision + 1, privateKeys,
    library: { version: 1, tags: structuredClone(tags), items, views } };
  const recovery = await openRecovery(page);
  await chooseBackupFile(page, recovery, Buffer.from(JSON.stringify(data)), 'reading-matrix.json');
  await restorePreview(recovery);
  await closeDialog(page, '设置');
  return snapshot(page);
}
async function choose(scope, label, option) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await scope.getByRole('option', { name: option, exact: true }).click();
}
async function openReading(page, locale = 'zh-CN') {
  await page.bringToFront();
  await page.getByRole('button', { name: t('命令面板', locale), exact: true }).click();
  const panel = page.getByRole('dialog', { name: t('命令面板', locale), exact: true });
  await panel.getByRole('combobox').fill(t('稍后读', locale));
  await panel.getByRole('option', { name: t('稍后读', locale), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: t('稍后读', locale), exact: true });
  await expect(dialog.getByRole('button', { name: t('批量选择', locale), exact: true })).toBeEnabled();
  return dialog;
}
async function selectReading(dialog, titles, locale = 'zh-CN') {
  const begin = dialog.getByRole('button', { name: t('批量选择', locale), exact: true });
  if (await begin.isVisible()) await begin.click();
  for (const title of titles) await dialog.getByRole('checkbox', { name: t('选择“{0}”', locale).replace('{0}', title), exact: true }).check();
}
async function applyBulk(page, action, { titles = ['Alpha article', 'Beta article'], tagNames = [], date } = {}) {
  const dialog = await openReading(page);
  await selectReading(dialog, titles);
  await choose(dialog, '批量操作', action);
  for (const name of tagNames) await dialog.getByRole('group', { name: '批量标签', exact: true }).getByRole('checkbox', { name, exact: true }).check();
  if (date) await dialog.getByLabel('统一再看日期', { exact: true }).fill(date);
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已处理 2 条链接。');
  await closeDialog(page, '稍后读');
  return snapshot(page);
}
async function newView(page, name, { include = [], exclude = [], mode = '包含全部所选标签', revisit } = {}) {
  await page.getByRole('button', { name: '动态清单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '动态清单', exact: true });
  await dialog.getByRole('button', { name: '新建清单', exact: true }).click();
  await dialog.getByLabel('清单名称', { exact: true }).fill(name);
  await choose(dialog, '标签匹配', mode);
  for (const name of include) await dialog.getByRole('group', { name: '标签', exact: true }).getByRole('checkbox', { name, exact: true }).check();
  for (const name of exclude) await dialog.getByRole('group', { name: '排除标签', exact: true }).getByRole('checkbox', { name, exact: true }).check();
  if (revisit) await choose(dialog, '再看日期', revisit);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.locator('.saved-view-open').filter({ hasText: name })).toBeVisible();
  await closeDialog(page, '动态清单');
}
async function applyView(page, name) {
  await page.getByRole('button', { name: '动态清单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '动态清单', exact: true });
  await dialog.locator('.saved-view-open').filter({ hasText: name }).click();
  await expect(dialog).toBeHidden();
}
async function expectResults(page, titles) {
  await search(page).click();
  await expect.poll(async () => (await page.getByRole('option').locator('strong').allTextContents()).sort()).toEqual([...titles].sort());
}
async function pinView(page, name) {
  await page.getByRole('button', { name: '动态清单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '动态清单', exact: true });
  await dialog.locator('.saved-view-row').filter({ has: page.getByText(name, { exact: true }) }).getByRole('button', { name: '固定到桌面', exact: true }).click();
  const pin = page.getByRole('dialog', { name: '固定到桌面', exact: true });
  await expect(pin.getByRole('combobox', { name: '目标桌面', exact: true })).toBeEnabled();
  await pin.getByRole('button', { name: '固定', exact: true }).click();
  await expect(pin).toBeHidden();
  await closeDialog(page, '动态清单');
  const data = await snapshot(page), view = data.data.preferences.library.views.find(item => item.name === name);
  return data.navigation.entries.find(entry => entry.extensionId === 'saved-view' && entry.config.viewId === view.id);
}
async function hide(page) {
  await page.getByRole('button', { name: '开启隐藏', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置隐藏密码', exact: true });
  await dialog.getByLabel('新密码', { exact: true }).fill('synthetic-reading-privacy');
  await dialog.getByLabel('确认密码', { exact: true }).fill('synthetic-reading-privacy');
  await dialog.getByRole('button', { name: '设置并隐藏', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('bulk tags and revisit dates change only selected fields and survive complete backup and reload', async ({ extension }, testInfo) => {
  const page = await extension.newtab(), before = await seed(page);
  const added = await applyBulk(page, '添加所选标签', { tagNames: ['Completed'] });
  for (const id of ['read-a', 'read-b']) {
    const key = `reading:${id}`;
    expect(added.data.preferences.library.items[key]).toEqual({ ...before.data.preferences.library.items[key], tagIds: [...before.data.preferences.library.items[key].tagIds, 'tag-done'] });
    expect(added.tools.reading.find(item => item.id === id)).toMatchObject({ ...before.tools.reading.find(item => item.id === id), revision: 2, updatedAt: expect.any(Number) });
  }
  const removed = await applyBulk(page, '移除所选标签', { tagNames: ['Completed'] });
  for (const id of ['read-a', 'read-b']) expect(removed.data.preferences.library.items[`reading:${id}`]).toEqual(before.data.preferences.library.items[`reading:${id}`]);
  const dated = await applyBulk(page, '设置再看日期', { date: '2026-12-05' });
  for (const id of ['read-a', 'read-b']) expect(dated.tools.reading.find(item => item.id === id)).toMatchObject({ revisitOn: '2026-12-05', status: 'unread' });
  expect(dated.data.preferences).toEqual(removed.data.preferences);
  const cleared = await applyBulk(page, '清除再看日期');
  for (const id of ['read-a', 'read-b']) expect(cleared.tools.reading.find(item => item.id === id)).not.toHaveProperty('revisitOn');
  for (const id of ['read-c', 'read-d']) {
    expect(cleared.tools.reading.find(item => item.id === id)).toEqual(before.tools.reading.find(item => item.id === id));
    expect(cleared.data.preferences.library.items[`reading:${id}`]).toEqual(before.data.preferences.library.items[`reading:${id}`]);
  }
  const recovery = await openRecovery(page);
  await chooseBackupFile(page, recovery, cleared.buffer, 'bulk-roundtrip.json');
  await restorePreview(recovery);
  await closeDialog(page, '设置');
  const restored = await snapshot(page);
  expect(restored.tools.reading).toEqual(cleared.tools.reading);
  expect(restored.data.preferences.library).toEqual(cleared.data.preferences.library);
  await page.reload();
  const dialog = await openReading(page);
  await expect(row(dialog, 'read-a').locator('time')).toHaveCount(0);
  await expect(row(dialog, 'read-b').locator('time')).toHaveCount(0);
  await expect(row(dialog, 'read-c').locator('time')).toHaveAttribute('datetime', '2026-11-15');
  await page.screenshot({ path: testInfo.outputPath('bulk-result.png'), animations: 'disabled' });
});

test('stale cross-tab selections refuse metadata and date batches without partial changes', async ({ extension }) => {
  const page = await extension.newtab(); await seed(page);
  const dialog = await openReading(page);
  await selectReading(dialog, ['Alpha article', 'Beta article']);
  await choose(dialog, '批量操作', '添加所选标签');
  await dialog.getByRole('group', { name: '批量标签', exact: true }).getByRole('checkbox', { name: 'Completed', exact: true }).check();
  const other = await extension.newtab(), otherDialog = await openReading(other);
  await row(otherDialog, 'read-a').getByRole('button', { name: '编辑链接', exact: true }).click();
  await otherDialog.getByLabel('备注', { exact: true }).fill('Concurrent metadata wins');
  await otherDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(otherDialog.getByRole('button', { name: '添加', exact: true })).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText('所选内容已变化，请重新选择。');
  await expect(dialog.getByRole('button', { name: '应用', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('checkbox', { name: '选择“Beta article”', exact: true })).toBeChecked();
  await choose(dialog, '批量操作', '设置再看日期');
  await dialog.getByLabel('统一再看日期', { exact: true }).fill('2026-12-10');
  await expect(dialog.getByRole('button', { name: '应用', exact: true })).toBeDisabled();
  await closeDialog(other, '稍后读'); await closeDialog(page, '稍后读');
  const after = await snapshot(page);
  expect(after.data.preferences.library.items['reading:read-a']).toEqual(metadata(['tag-dev'], 'Concurrent metadata wins'));
  expect(after.data.preferences.library.items['reading:read-b']).toEqual(metadata(['tag-design']));
  expect(after.tools.reading.find(item => item.id === 'read-b')).toMatchObject({ revision: 1, revisitOn: '2026-11-20' });
  expect(after.tools.reading.find(item => item.id === 'read-a').revisitOn).toBe('2026-11-14');
});

test('saved views keep all, any and excluded tags after reload and reuse them in desktop search', async ({ extension }, testInfo) => {
  const page = await extension.newtab(); await seed(page);
  await newView(page, 'Both disciplines', { include: ['Development', 'Design'] });
  await newView(page, 'Either unfinished', { include: ['Development', 'Design'], exclude: ['Completed'], mode: '包含任一所选标签' });
  const stored = await snapshot(page), views = stored.data.preferences.library.views;
  expect(views.find(item => item.name === 'Both disciplines')).not.toHaveProperty('tagMode');
  expect(views.find(item => item.name === 'Either unfinished')).toMatchObject({ tagMode: 'any', tagIds: ['tag-dev', 'tag-design'], excludeTagIds: ['tag-done'] });
  await page.reload();
  await applyView(page, 'Both disciplines'); await expectResults(page, ['Gamma article']);
  await search(page).press('Escape');
  await applyView(page, 'Either unfinished'); await expectResults(page, ['Alpha article', 'Beta article', 'Unselected article']);
  await search(page).press('Escape');
  await page.getByRole('button', { name: '标签筛选已开启', exact: true }).click();
  await expect(page.getByText('包含任一所选标签', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('any-tag-filter.png'), animations: 'disabled' });
});

test('today and next seven days use inclusive local dates and refresh across midnight', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  await page.clock.install({ time: new Date('2026-11-14T15:59:40Z') });
  await page.reload();
  const reading = [...matrix(), record('read-e', 'Seventh-day boundary', { revisitOn: '2026-11-21' }), record('read-f', 'No revisit date')];
  await seed(page, { reading });
  await newView(page, 'Today only', { revisit: '今天' });
  await newView(page, 'Next week', { revisit: '未来七天' });
  await applyView(page, 'Today only'); await expectResults(page, ['Alpha article']); await search(page).press('Escape');
  await applyView(page, 'Next week'); await expectResults(page, ['Alpha article', 'Beta article', 'Gamma article']); await search(page).press('Escape');
  const entry = await pinView(page, 'Next week');
  await revealDesktopItem(page, tile(page, entry.id));
  await expect(tile(page, entry.id).locator('.personal-widget-heading b')).toHaveText('3');
  await page.clock.fastForward(30_000);
  await expect.poll(() => page.evaluate(() => new Date().getDate())).toBe(15);
  await expect.poll(async () => (await tile(page, entry.id).locator('.saved-view-result strong').allTextContents()).sort()).toEqual(['Beta article', 'Gamma article', 'Seventh-day boundary']);
  await applyView(page, 'Today only'); await expectResults(page, ['Gamma article']);
  await page.screenshot({ path: testInfo.outputPath('local-midnight-revisit.png'), animations: 'disabled' });
});

test('pinned views update from bulk changes and shield a tag that becomes private while already locked', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  const reading = [...matrix(), record('read-private', 'Private research dossier')];
  const items = { ...matrixMetadata(), 'reading:read-a': metadata(['tag-dev', 'tag-private']), 'reading:read-private': metadata(['tag-private']) };
  await seed(page, { reading, items, privateKeys: ['reading:read-private'] });
  await newView(page, 'Open project', { include: ['Development', 'Restricted project'], mode: '包含任一所选标签' });
  const entry = await pinView(page, 'Open project');
  await revealDesktopItem(page, tile(page, entry.id));
  await expect(tile(page, entry.id).locator('.personal-widget-heading b')).toHaveText('4');
  await hide(page);
  await expect(tile(page, entry.id).locator('.personal-widget-heading b')).toHaveText('3');
  await applyView(page, 'Open project');
  await expectResults(page, ['Alpha article', 'Gamma article', 'Unselected article']); await search(page).press('Escape');
  // The presentation lock is already active. Removing the last public use of
  // this tag changes the visible dictionary without toggling presentation.
  const other = await extension.newtab(), dialog = await openReading(other);
  await selectReading(dialog, ['Alpha article']);
  await choose(dialog, '批量操作', '移除所选标签');
  await dialog.getByRole('group', { name: '批量标签', exact: true }).getByRole('checkbox', { name: 'Restricted project', exact: true }).check();
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('已处理 1 条链接。');
  await expect(dialog).not.toContainText('Restricted project');
  await dialog.getByRole('button', { name: '清除所选标签', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '清除所选标签', exact: true })).toHaveCount(0);
  await expect(tile(page, entry.id)).toContainText('已隐藏');
  await expect(tile(page, entry.id).locator('b')).toHaveCount(0);
  await expect(page.locator('.search-area')).not.toContainText('Restricted project');
  await expect(page.locator('.search-area input[role="combobox"]')).toHaveValue('');
  await expect(page.locator('.search-area')).not.toContainText('Private research dossier');
  await tile(page, entry.id).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '编辑组件', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '动态清单', exact: true }).click();
  const views = page.getByRole('dialog', { name: '动态清单', exact: true });
  await expect(views).not.toContainText('Open project');
  await expect(views).not.toContainText('Restricted project');
  await closeDialog(page, '动态清单');
  await page.screenshot({ path: testInfo.outputPath('already-locked-dictionary-shield.png'), animations: 'disabled' });
});

test('bulk and saved-view controls fit a narrow viewport in all eight languages', async ({ extension }, testInfo) => {
  const page = await extension.newtab(); await seed(page);
  await page.setViewportSize({ width: 390, height: 540 });
  const languages = [['zh-CN', '简体中文'], ['en', 'English'], ['zh-TW', '繁體中文'], ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['ru', 'Русский']];
  let current = 'zh-CN';
  for (const [locale, language] of languages) {
    await page.getByRole('button', { name: t('打开设置', current), exact: true }).click();
    const settings = page.getByRole('dialog', { name: t('设置', current), exact: true });
    await settings.getByRole('tab', { name: t('外观', current), exact: true }).click();
    await settings.locator('.language-setting').getByRole('combobox').click();
    await settings.getByRole('option', { name: language, exact: true }).click(); current = locale;
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await closeDialog(page, '设置', locale);
    const dialog = await openReading(page, locale);
    await selectReading(dialog, ['Alpha article'], locale);
    await choose(dialog, t('批量操作', locale), t('添加所选标签', locale));
    await expect(dialog.getByRole('group', { name: t('批量标签', locale), exact: true })).toBeVisible();
    await dialog.getByRole('group', { name: t('批量标签', locale), exact: true }).getByRole('checkbox', { name: 'Design', exact: true }).check();
    await expect(dialog.getByRole('button', { name: t('应用', locale), exact: true })).toBeEnabled();
    await choose(dialog, t('批量操作', locale), t('设置再看日期', locale));
    await dialog.getByLabel(t('统一再看日期', locale), { exact: true }).fill('2026-12-06');
    await expect(dialog.getByRole('button', { name: t('应用', locale), exact: true })).toBeEnabled();
    const measure = async scope => scope.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: element.clientWidth, scroll: element.scrollWidth, viewport: innerWidth };
    });
    for (const scope of [dialog, dialog.locator('.reading-bulk-toolbar')]) {
      const g = await measure(scope); expect(g.left).toBeGreaterThanOrEqual(0); expect(g.right).toBeLessThanOrEqual(g.viewport + 1); expect(g.scroll).toBeLessThanOrEqual(g.width + 1);
    }
    await page.screenshot({ path: testInfo.outputPath(`bulk-${locale}-390x540.png`), animations: 'disabled' });
    await closeDialog(page, '稍后读', locale);
    await page.getByRole('button', { name: t('动态清单', locale), exact: true }).click();
    const views = page.getByRole('dialog', { name: t('动态清单', locale), exact: true });
    await views.getByRole('button', { name: t('新建清单', locale), exact: true }).click();
    await choose(views, t('标签匹配', locale), t('包含任一所选标签', locale));
    await choose(views, t('再看日期', locale), t('未来七天', locale));
    await expect(views.getByRole('group', { name: t('排除标签', locale), exact: true })).toBeVisible();
    const g = await measure(views); expect(g.scroll).toBeLessThanOrEqual(g.width + 1); expect(g.right).toBeLessThanOrEqual(g.viewport + 1);
    await page.screenshot({ path: testInfo.outputPath(`filters-${locale}-390x540.png`), animations: 'disabled' });
    await views.getByRole('button', { name: t('关闭', locale), exact: true }).click();
    const discard = page.getByRole('alertdialog', { name: t('放弃修改', locale), exact: true });
    await discard.getByRole('button', { name: t('放弃修改', locale), exact: true }).click();
    await expect(views).toBeHidden();
  }
});
