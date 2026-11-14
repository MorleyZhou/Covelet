import { test, expect } from './extension.fixture.mjs';
import { exportCompleteBackup, openRecovery, chooseBackupFile, restorePreview } from './backup-helpers.mjs';
import { readFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { editSiteThroughKeyboard } from './navigation-helpers.mjs';

const catalog = JSON.parse(await readFile(new URL('../../src/i18n/catalog.json', import.meta.url), 'utf8'));
const t = (key, locale = 'zh-CN') => locale === 'zh-CN' ? key : catalog[key]?.[locale] || catalog[key]?.en || key;
const title = '导入网址与书签 HTML', shared = 'https://example.com/shared';
const attr = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const raindrop = rows => `<!DOCTYPE NETSCAPE-Bookmark-file-1><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8"><DL><p>${rows.map(item =>
  `<DT><A HREF="${attr(item.url)}" TAGS="${attr((item.tags || []).join(','))}" DESCRIPTION="${attr(item.description || '')}" ICON="https://icons.example/never-fetch.png">${attr(item.name)}</A>${item.dd ? `<DD>${item.dd}` : ''}`).join('\n')}</DL><p>`;
const sourceRows = () => [{ url: shared, name: 'Source first', tags: ['Source A'], description: 'First source context' },
  { url: shared, name: 'Source second', tags: ['Source B'], description: 'Second source context' }];
const mergeGroup = (dialog, url) => dialog.locator(`.import-merge-group[data-merge-url="${url}"]`);
const importedSite = (backup, name) => backup.navigation.entries.find(item => item.type === 'site' && item.name === name);
const metadata = (backup, id) => backup.data.preferences.library?.items[`site:${id}`] || { description: '', tagIds: [] };
const tagNames = (backup, id) => metadata(backup, id).tagIds.map(tag => backup.data.preferences.library.tags.find(item => item.id === tag).name).sort();

async function closeSettings(page) {
  const settings = page.getByRole('dialog', { name: '设置', exact: true });
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(settings).toBeHidden();
}
async function snapshot(page) {
  const backup = await exportCompleteBackup(page); await closeSettings(page); return backup;
}
async function restore(page, data) {
  const recovery = await openRecovery(page);
  await chooseBackupFile(page, recovery, Buffer.from(JSON.stringify(data)), 'import-targets.json');
  await restorePreview(recovery); await closeSettings(page);
}
async function seedDuplicates(page, { paged = false } = {}) {
  const before = await snapshot(page), data = structuredClone(before.data), navigation = structuredClone(before.navigation);
  const groupId = navigation.groups[0].id, pageId = navigation.settings.pages[0];
  for (const [index, name] of ['Local primary', 'Local secondary'].entries()) navigation.entries.push({ id: `site-local-${index}`, type: 'site', name, url: shared,
    groupId, parentId: null, page: pageId, order: index, icon: { kind: 'letter', value: name.slice(0, 2) } });
  if (paged) for (let index = 0; index < 23; index++) navigation.entries.push({ id: `site-paged-${index}`, type: 'site', name: `Paged local ${String(index).padStart(2, '0')}`,
    url: `https://example.com/paged/${index}`, groupId, parentId: null, page: pageId, order: navigation.entries.length, icon: { kind: 'letter', value: 'Pa' } });
  data.navigation = Buffer.from(zipSync({ ...before.files, 'data.json': strToU8(JSON.stringify(navigation)) })).toString('base64');
  data.preferences = { ...data.preferences, library: { version: 1, tags: [{ id: 'tag-local', name: 'Local tag' }], items: {
    'site:site-local-0': { description: 'Primary local context', tagIds: ['tag-local'] },
    'site:site-local-1': { description: 'Secondary local context', tagIds: ['tag-local'] },
  } } };
  if (paged) for (let index = 0; index < 23; index++) data.preferences.library.items[`site:site-paged-${index}`] = { description: `Local paging context ${index}`, tagIds: ['tag-local'] };
  await restore(page, data); return snapshot(page);
}
async function choose(scope, label, option) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await scope.page().getByRole('option', { name: option, exact: typeof option === 'string' }).click();
}
async function openImport(page, locale = 'zh-CN') {
  await page.bringToFront();
  await page.getByRole('button', { name: t('命令面板', locale), exact: true }).click();
  const commands = page.getByRole('dialog', { name: t('命令面板', locale), exact: true });
  await commands.getByRole('combobox').fill(t(title, locale));
  await commands.getByRole('option', { name: t(title, locale), exact: true }).click();
  return page.getByRole('dialog', { name: t(title, locale), exact: true });
}
async function pickSource(page, dialog, button, text, filename, locale = 'zh-CN') {
  const choosing = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: t(button, locale), exact: true }).click();
  await (await choosing).setFiles({ name: filename, mimeType: filename.endsWith('.txt') ? 'text/plain' : 'text/html', buffer: Buffer.from(text) });
}
async function pasteSource(dialog, format, text, locale = 'zh-CN') {
  await choose(dialog, t('粘贴格式', locale), t(format, locale));
  await dialog.getByLabel(t('粘贴网址', locale), { exact: true }).fill(text);
  await dialog.getByRole('button', { name: t('预览网址', locale), exact: true }).click();
}
async function confirm(dialog, locale = 'zh-CN') {
  await dialog.getByRole('button', { name: t('确认导入', locale), exact: true }).click(); await expect(dialog).toBeHidden();
}
async function cancel(dialog, locale = 'zh-CN') {
  await dialog.getByRole('button', { name: t('取消', locale), exact: true }).click(); await expect(dialog).toBeHidden();
}
async function merge(dialog, url, targetName, indices, locale = 'zh-CN') {
  const group = mergeGroup(dialog, url);
  await choose(group, t('合并目标', locale), new RegExp(`${targetName}$`, 'u'));
  for (const index of indices) await group.getByRole('checkbox', { name: t('合并来源 {0}', locale).replace('{0}', index), exact: true }).check();
  await group.getByRole('checkbox', { name: t('合并来源标签', locale), exact: true }).check();
  await group.getByRole('checkbox', { name: t('追加来源备注', locale), exact: true }).check();
  return group;
}
async function hide(page) {
  await page.getByRole('button', { name: '开启隐藏', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: '设置隐藏密码', exact: true });
  await prompt.getByLabel('新密码', { exact: true }).fill('synthetic-import-privacy');
  await prompt.getByLabel('确认密码', { exact: true }).fill('synthetic-import-privacy');
  await prompt.getByRole('button', { name: '设置并隐藏', exact: true }).click(); await expect(prompt).toBeHidden();
}
async function unlock(page) {
  const prompt = page.getByRole('dialog', { name: '解锁隐藏内容', exact: true });
  await prompt.getByLabel('隐藏密码', { exact: true }).fill('synthetic-import-privacy');
  await prompt.getByRole('button', { name: '解锁', exact: true }).click(); await expect(prompt).toBeHidden();
}

test('Raindrop attributes import as local tags and plain notes while Firefox DD content remains ignored with zero requests', async ({ extension, network }, testInfo) => {
  const page = await extension.newtab(); await snapshot(page);
  const mark = network.requests.length;
  const source = raindrop([{ url: 'https://example.com/research?a=1&b=2', name: 'Research & 设计', tags: ['Project', '设计', 'Project'],
    description: 'Saved & literal <b>context</b>', dd: 'DD description <A HREF="https://ignored.example/">never a bookmark</A><img src="https://ignored.example/pixel">' }]);
  const dialog = await openImport(page);
  await pickSource(page, dialog, '导入 Raindrop HTML 文件', source, 'raindrop.html');
  await expect(dialog.locator('.bookmark-import-row')).toHaveCount(1);
  await expect(dialog.locator('.import-source-description')).toContainText('Saved & literal <b>context</b>');
  await expect(dialog.locator('img[src^="https://ignored.example"]')).toHaveCount(0);
  await confirm(dialog);
  const imported = await snapshot(page), site = importedSite(imported, 'Research & 设计');
  expect(site.url).toBe('https://example.com/research?a=1&b=2'); expect(site.icon.kind).toBe('letter');
  expect(metadata(imported, site.id).description).toBe('Saved & literal <b>context</b>'); expect(tagNames(imported, site.id)).toEqual(['Project', '设计']);
  expect(imported.navigation.entries.some(item => item.url?.includes('ignored.example'))).toBe(false);
  const firefox = await readFile(new URL('../fixtures/bookmarks/firefox.html', import.meta.url), 'utf8');
  const legacy = await openImport(page);
  await pickSource(page, legacy, '导入书签 HTML 文件', firefox, 'firefox.html'); await confirm(legacy);
  const after = await snapshot(page), mozilla = importedSite(after, 'Mozilla Firefox'), chinese = importedSite(after, '中文文档');
  expect(mozilla).toBeDefined(); expect(chinese).toBeDefined();
  expect(metadata(after, mozilla.id)).toEqual({ description: '', tagIds: [] });
  expect(metadata(after, chinese.id)).toEqual({ description: '', tagIds: [] });
  expect(after.navigation.entries.some(item => item.url?.includes('description.test'))).toBe(false);
  expect(network.requests.slice(mark)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('local-raindrop-and-firefox.png'), animations: 'disabled' });
});

test('OneTab 2.25 text preserves Unicode and title pipes, separates blank-line groups and allows group renaming', async ({ extension, network }, testInfo) => {
  const page = await extension.newtab(); await snapshot(page); const mark = network.requests.length;
  const source = '\uFEFFhttps://example.com/first?q=a%7Cb | 研究 | 标题\r\nhttps://example.com/no-title\r\n\r\nhttps://例子.中国/文档?q=中文 | 日本語の資料\r\nnot a url | Invalid entry\r\njavascript:alert(1) | Unsupported';
  const dialog = await openImport(page);
  await pickSource(page, dialog, '导入 OneTab 文本文件', source, 'onetab-2.25.txt');
  await expect(dialog.locator('.bookmark-import-row')).toHaveCount(3);
  await dialog.getByLabel('第 1 组', { exact: true }).fill('Project | 研究');
  await dialog.getByLabel('第 2 组', { exact: true }).fill('日本語の資料');
  await expect(dialog.locator('.bookmark-import-list')).toContainText('Project | 研究');
  await expect(dialog.locator('.bookmark-import-invalid')).toContainText('已跳过 2 项无效地址。');
  await page.screenshot({ path: testInfo.outputPath('onetab-group-preview.png'), animations: 'disabled' });
  await confirm(dialog);
  const result = await snapshot(page), first = importedSite(result, '研究 | 标题'), fallback = importedSite(result, 'example.com'), japanese = importedSite(result, '日本語の資料');
  expect(first.url).toBe('https://example.com/first?q=a%7Cb'); expect(fallback.url).toBe('https://example.com/no-title');
  expect(japanese.url).toBe(new URL('https://例子.中国/文档?q=中文').href);
  expect(result.navigation.entries.find(item => item.id === first.parentId).name).toBe('Project | 研究');
  expect(result.navigation.entries.find(item => item.id === japanese.parentId).name).toBe('日本語の資料');
  expect(network.requests.slice(mark)).toEqual([]);
  await page.reload(); expect((await snapshot(page)).navigation.entries).toEqual(result.navigation.entries);
});

test('duplicates retain local information by default and merge only explicitly selected sources into a chosen target or new copy', async ({ extension }, testInfo) => {
  const page = await extension.newtab(), before = await seedDuplicates(page, { paged: true });
  const initial = await openImport(page);
  await pasteSource(initial, 'Raindrop HTML', raindrop([...sourceRows(), { url: 'https://example.com/unique', name: 'Unique article', tags: ['Unique tag'], description: 'Unique context' }]));
  await expect(mergeGroup(initial, shared).getByRole('combobox', { name: '合并目标', exact: true })).toHaveText('保留本地信息');
  await expect(mergeGroup(initial, shared).getByRole('checkbox')).toHaveCount(0);
  await confirm(initial);
  const kept = await snapshot(page);
  for (const id of ['site-local-0', 'site-local-1']) expect(metadata(kept, id)).toEqual(metadata(before, id));
  const unique = importedSite(kept, 'Unique article'); expect(tagNames(kept, unique.id)).toEqual(['Unique tag']);
  const fresh = 'https://example.com/fresh-pair';
  const mergeDialog = await openImport(page);
  await pasteSource(mergeDialog, 'Raindrop HTML', raindrop([...sourceRows(), { url: fresh, name: 'Fresh first', tags: ['Fresh A'], description: 'Fresh context A' },
    { url: fresh, name: 'Fresh second', tags: ['Fresh B'], description: 'Fresh context B' }]));
  await merge(mergeDialog, shared, 'Local secondary', [1, 2]);
  await merge(mergeDialog, fresh, 'Fresh first', [4]);
  await page.screenshot({ path: testInfo.outputPath('explicit-metadata-merge.png'), animations: 'disabled' });
  await confirm(mergeDialog);
  const merged = await snapshot(page);
  expect(metadata(merged, 'site-local-0')).toEqual(metadata(before, 'site-local-0'));
  expect(tagNames(merged, 'site-local-1')).toEqual(['Local tag', 'Source A', 'Source B']);
  const description = metadata(merged, 'site-local-1').description;
  expect(description).toContain('Secondary local context'); expect(description).toContain('First source context'); expect(description).toContain('Second source context');
  for (const id of ['site-local-0', 'site-local-1']) expect(merged.navigation.entries.find(item => item.id === id)).toEqual(before.navigation.entries.find(item => item.id === id));
  const newTarget = importedSite(merged, 'Fresh first'); expect(tagNames(merged, newTarget.id)).toEqual(['Fresh A', 'Fresh B']);
  expect(metadata(merged, newTarget.id).description).toContain('Fresh context A'); expect(metadata(merged, newTarget.id).description).toContain('Fresh context B');
  const copies = await openImport(page); await pasteSource(copies, 'Raindrop HTML', raindrop(sourceRows()));
  await copies.getByRole('checkbox', { name: '跳过重复网址', exact: true }).uncheck(); await confirm(copies);
  const copied = await snapshot(page), copySites = copied.navigation.entries.filter(item => item.url === shared && !item.id.startsWith('site-local-'));
  expect(copySites).toHaveLength(2);
  for (const [index, name] of ['Source first', 'Source second'].entries()) { const site = copySites.find(item => item.name === name); expect(tagNames(copied, site.id)).toEqual([`Source ${index ? 'B' : 'A'}`]); }
  expect(metadata(copied, 'site-local-1')).toEqual(metadata(merged, 'site-local-1'));
  const paged = await openImport(page);
  await pasteSource(paged, 'Raindrop HTML', raindrop(Array.from({ length: 23 }, (_, index) => ({ url: `https://example.com/paged/${index}`,
    name: `Paging source ${index}`, tags: [`Paging tag ${index}`], description: `Source paging context ${index}` }))));
  const pager = paged.locator('.import-merge-pagination').first(), heading = paged.getByRole('heading', { name: '重复项信息合并', exact: true });
  await expect(paged.locator('.import-merge-group')).toHaveCount(20);
  const firstGroup = await merge(paged, 'https://example.com/paged/0', 'Paged local 00', [1]);
  await expect(firstGroup.getByRole('checkbox', { name: '追加来源备注', exact: true })).toBeFocused();
  await pager.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(paged.locator('.import-merge-group')).toHaveCount(3); await expect(heading).toBeFocused();
  await merge(paged, 'https://example.com/paged/22', 'Paged local 22', [23]);
  await pager.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(paged.locator('.import-merge-group')).toHaveCount(20); await expect(heading).toBeFocused();
  await expect(firstGroup.getByRole('combobox', { name: '合并目标', exact: true })).toHaveText(/Paged local 00$/u);
  for (const name of ['合并来源 1', '合并来源标签', '追加来源备注']) await expect(firstGroup.getByRole('checkbox', { name, exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('paged-merge-retains-decisions.png'), animations: 'disabled' });
  await confirm(paged);
  const pagedResult = await snapshot(page); expect(pagedResult.navigation.entries).toEqual(copied.navigation.entries);
  for (let index = 0; index < 23; index++) {
    const id = `site-paged-${index}`;
    if (index === 0 || index === 22) {
      expect(tagNames(pagedResult, id)).toEqual(['Local tag', `Paging tag ${index}`]);
      expect(metadata(pagedResult, id).description).toContain(`Local paging context ${index}`);
      expect(metadata(pagedResult, id).description).toContain(`Source paging context ${index}`);
    } else expect(metadata(pagedResult, id)).toEqual(metadata(copied, id));
  }
});

test('metadata limits leave deselection and metadata skipping available, and stale or canceled imports write nothing', async ({ extension }) => {
  const page = await extension.newtab(); await seedDuplicates(page);
  const bad = { url: 'https://example.com/oversized', name: 'Oversized metadata', tags: Array.from({ length: 21 }, (_, index) => `Tag ${index}`), description: 'x'.repeat(1001) };
  const valid = { url: 'https://example.com/valid', name: 'Valid metadata', tags: ['Accepted'], description: 'Accepted context' };
  const dialog = await openImport(page); await pasteSource(dialog, 'Raindrop HTML', raindrop([bad, valid]));
  await expect(dialog.locator('.import-metadata-issues')).toBeVisible(); await expect(dialog.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: '选择 Oversized metadata', exact: true }).uncheck();
  await confirm(dialog);
  const reduced = await snapshot(page); expect(importedSite(reduced, 'Oversized metadata')).toBeUndefined(); expect(importedSite(reduced, 'Valid metadata')).toBeDefined();
  const skip = await openImport(page); await pasteSource(skip, 'Raindrop HTML', raindrop([bad]));
  await skip.getByRole('checkbox', { name: '导入支持的标签和备注', exact: true }).uncheck(); await confirm(skip);
  const skipped = await snapshot(page), withoutMetadata = importedSite(skipped, 'Oversized metadata'); expect(metadata(skipped, withoutMetadata.id)).toEqual({ description: '', tagIds: [] });
  const stale = await openImport(page); await pasteSource(stale, 'Raindrop HTML', raindrop([...sourceRows(), { url: 'https://example.com/stale', name: 'Reviewed article', tags: ['Reviewed tag'] }]));
  await merge(stale, shared, 'Local secondary', [1]);
  const other = await extension.newtab(), edited = await editSiteThroughKeyboard(other, 'Local secondary');
  await edited.getByLabel('备注', { exact: true }).fill('Concurrent local context');
  await edited.getByRole('textbox', { name: '新标签名称', exact: true }).fill('Concurrent tag');
  await edited.getByRole('button', { name: '添加标签', exact: true }).click();
  await edited.getByRole('button', { name: '保存', exact: true }).click(); await expect(edited).toBeHidden();
  await expect(stale.getByRole('alert')).toContainText('资料已在其他页面更新'); await expect(stale.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled();
  const during = await snapshot(other); expect(importedSite(during, 'Reviewed article')).toBeUndefined(); expect(tagNames(during, 'site-local-1')).toEqual(['Concurrent tag', 'Local tag']);
  expect(metadata(during, 'site-local-1').description).toBe('Concurrent local context'); expect(during.data.preferences.library.tags.some(item => item.name === 'Reviewed tag')).toBe(false);
  await stale.getByRole('button', { name: '重新预览', exact: true }).click();
  const reviewed = mergeGroup(stale, shared);
  await expect(reviewed.getByRole('checkbox', { name: '合并来源 1', exact: true })).toBeChecked();
  await expect(reviewed.getByRole('checkbox', { name: '合并来源标签', exact: true })).toBeChecked();
  await expect(reviewed.getByRole('checkbox', { name: '追加来源备注', exact: true })).toBeChecked();
  await expect(reviewed.locator('.import-target-metadata')).toContainText('Concurrent local context');
  await confirm(stale);
  const after = await snapshot(page); expect(importedSite(after, 'Reviewed article')).toBeDefined();
  expect(tagNames(after, 'site-local-1')).toEqual(['Concurrent tag', 'Local tag', 'Source A']);
  expect(metadata(after, 'site-local-1').description).toContain('Concurrent local context'); expect(metadata(after, 'site-local-1').description).toContain('First source context');
  expect(metadata(after, 'site-local-0')).toEqual(metadata(skipped, 'site-local-0'));
  const canceled = await openImport(page); await pasteSource(canceled, 'Raindrop HTML', raindrop([{ url: 'https://example.com/cancel', name: 'Cancel this source', tags: ['Canceled tag'] }])); await cancel(canceled);
  const final = await snapshot(page); expect(final.navigation.entries).toEqual(after.navigation.entries); expect(final.data.preferences).toEqual(after.data.preferences);
});

test('locking during a real local file read hides import details and preserves the pending source for unlocking', async ({ extension }, testInfo) => {
  const page = await extension.newtab(); await seedDuplicates(page);
  // Delay the real File.text result to deterministically exercise an async
  // lock transition. The native file read, parser, storage and commit are real.
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      const value = original.call(this);
      return this.name === 'delayed-raindrop.html' ? value.then(text => new Promise(resolve => { window.finishImportRead = () => resolve(text); })) : value;
    };
  });
  const dialog = await openImport(page);
  await pickSource(page, dialog, '导入 Raindrop HTML 文件', raindrop([{ url: 'https://example.com/pending', name: 'Pending local file', tags: ['Pending source tag'], description: 'Preserve pending context' }]), 'delayed-raindrop.html');
  await expect.poll(() => page.evaluate(() => typeof window.finishImportRead)).toBe('function');
  const other = await extension.newtab(); await hide(other);
  await page.evaluate(() => window.finishImportRead());
  await expect(dialog.locator('.import-privacy-gate')).toBeVisible(); await expect(dialog.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled();
  await expect(dialog).not.toContainText('Local primary'); await expect(dialog).not.toContainText('Pending local file'); await expect(dialog.locator('.bookmark-import-row')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('async-import-privacy-gate.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '输入密码查看隐藏内容', exact: true }).click(); await unlock(page);
  await expect(dialog.locator('.bookmark-import-row')).toContainText('Pending local file');
  await expect(dialog.getByRole('button', { name: '确认导入', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '重新预览', exact: true }).click();
  await confirm(dialog);
  const imported = await snapshot(page), pending = importedSite(imported, 'Pending local file'); expect(pending).toBeDefined(); expect(tagNames(imported, pending.id)).toEqual(['Pending source tag']);
  expect(metadata(imported, pending.id).description).toBe('Preserve pending context');
});

test('source formats and explicit merge controls remain usable in eight languages at 390 pixels', async ({ extension }, testInfo) => {
  const page = await extension.newtab(); await seedDuplicates(page); await page.setViewportSize({ width: 390, height: 540 });
  const languages = [['zh-CN', '简体中文'], ['en', 'English'], ['zh-TW', '繁體中文'], ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['ru', 'Русский']];
  let current = 'zh-CN';
  for (const [locale, language] of languages) {
    await page.getByRole('button', { name: t('打开设置', current), exact: true }).click();
    const settings = page.getByRole('dialog', { name: t('设置', current), exact: true });
    await settings.getByRole('tab', { name: t('外观', current), exact: true }).click(); await settings.locator('.language-setting').getByRole('combobox').click();
    await settings.getByRole('option', { name: language, exact: true }).click(); current = locale;
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    const localizedSettings = page.getByRole('dialog', { name: t('设置', locale), exact: true });
    await localizedSettings.getByRole('button', { name: t('关闭', locale), exact: true }).click(); await expect(localizedSettings).toBeHidden();
    const dialog = await openImport(page, locale);
    await expect(dialog.getByRole('button', { name: t('导入 Raindrop HTML 文件', locale), exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: t('导入 OneTab 文本文件', locale), exact: true })).toBeVisible();
    await pasteSource(dialog, 'Raindrop HTML', raindrop(sourceRows()), locale);
    const group = await merge(dialog, shared, 'Local secondary', [1, 2], locale);
    await expect(dialog.getByRole('button', { name: t('确认导入', locale), exact: true })).toBeEnabled();
    await group.getByRole('checkbox', { name: t('追加来源备注', locale), exact: true }).scrollIntoViewIfNeeded();
    for (const scope of [dialog, group]) {
      const geometry = await scope.evaluate(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: element.clientWidth, scroll: element.scrollWidth, viewport: innerWidth }; });
      expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1); expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
    }
    await page.screenshot({ path: testInfo.outputPath(`merge-${locale}-390x540.png`), animations: 'disabled' }); await cancel(dialog, locale);
    const oneTab = await openImport(page, locale); await pasteSource(oneTab, 'OneTab 文本', 'https://example.com/locale | Locale title', locale);
    await expect(oneTab.getByRole('group', { name: t('导入组名', locale), exact: true })).toBeVisible();
    await oneTab.getByLabel(t('第 {0} 组', locale).replace('{0}', '1'), { exact: true }).fill('Locale group');
    await cancel(oneTab, locale);
  }
});
