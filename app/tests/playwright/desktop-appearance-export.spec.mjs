import { test, expect, addSite } from './extension.fixture.mjs';
import { exportCompleteBackup, openRecovery, chooseBackupFile, restorePreview, makeImagePNG } from './backup-helpers.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

test.use({ hasTouch: true });
const catalog = JSON.parse(await readFile(new URL('../../src/i18n/catalog.json', import.meta.url), 'utf8'));
const t = (key, locale = 'zh-CN') => locale === 'zh-CN' ? key : catalog[key]?.[locale] || catalog[key]?.en || key;
const exportTitle = '导出 Markdown 资料库';
const search = page => page.getByRole('combobox', { name: '搜索或输入网址', exact: true });
const background = page => page.locator('.wallpaper');
const metadataDescription = 'First: "quoted" # label\n---\nurl: forged\u2028line';
const note = (id, title, body = '## Saved heading\n\n**Important** detail.', extra = {}) => ({ id, title, body, pinned: false, revision: 1,
  createdAt: Date.now() - 10_000, updatedAt: Date.now() - 5000, ...extra });

async function choose(scope, label, option) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await scope.page().getByRole('option', { name: option, exact: typeof option === 'string' }).click();
}
async function closeSettings(page, locale = 'zh-CN') {
  const settings = page.getByRole('dialog', { name: t('设置', locale), exact: true });
  await settings.getByRole('button', { name: t('关闭', locale), exact: true }).click(); await expect(settings).toBeHidden();
}
async function snapshot(page) { const backup = await exportCompleteBackup(page); await closeSettings(page); return backup; }
async function restore(page, data, name = 'synthetic-desktop-library.json') {
  const recovery = await openRecovery(page); await chooseBackupFile(page, recovery, Buffer.from(JSON.stringify(data)), name);
  await restorePreview(recovery); await closeSettings(page);
}
async function seed(page, { library = false, complex = true, collision = false } = {}) {
  const before = await snapshot(page), data = structuredClone(before.data), navigation = structuredClone(before.navigation);
  const groupId = navigation.groups[0].id;
  navigation.settings = { ...navigation.settings, pages: [0, 1], background: { kind: 'color', value: '#123456' }, shade: 12, blur: 2,
    visualEnhancement: false, desktopPages: { 0: { id: 'desktop-home', name: 'Home desk' }, 1: { id: 'desktop-work', name: 'Work desk' } } };
  const site = (id, name, page = 0, parentId = null) => ({ id, type: 'site', name, url: `https://example.com/${id}?part=(one)#section`, groupId,
    parentId, page, order: navigation.entries.filter(item => item.parentId === parentId).length, icon: { kind: 'letter', value: name.slice(0, 2) } });
  navigation.entries = [];
  if (!library) {
    for (let index = 0; index < 24; index++) navigation.entries.push(site(`home-${index}`, `Home item ${index}`));
    navigation.entries.push(site('work-0', 'Work item', 1));
  } else {
    navigation.entries.push({ id: 'folder-public', type: 'folder', name: 'Folder # (研究)', groupId, parentId: null, page: 0, order: 0, icon: { kind: 'letter', value: 'Fo' } });
    navigation.entries.push(site('site-public', 'Project: "Design" #1', 0, 'folder-public'));
    navigation.entries.push({ id: 'folder-private', type: 'folder', name: 'Private folder sentinel', groupId, parentId: null, page: 0, order: 1, icon: { kind: 'letter', value: 'Pr' } });
    navigation.entries.push(site('site-inherited', 'Private inherited sentinel', 0, 'folder-private'));
    navigation.entries.push(site('site-private', 'Private site sentinel'));
    const plain = note('note-public', 'Public note (研究)');
    const rich = note('note-complex', 'Complex callout', 'Important', { document: { type: 'doc', content: [
      { type: 'callout', attrs: { tone: 'info' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Important' }] }] },
    ] } });
    data.tools.notes = collision ? ['Report', 'report', '研究#(资料)', 'CON', 'con'].map((name, index) => note(`note-name-${index}`, name))
      : [plain, ...(complex ? [rich] : []), note('note-report', 'Report'), note('note-report-case', 'report'), note('note-private', 'Private note sentinel')];
    data.tools.reading = [{ id: 'reading-public', title: 'Read (later)#文档', url: 'https://example.com/a_(b)?x=%23#section', status: 'read', revisitOn: '2026-11-30',
      revision: 1, createdAt: Date.now() - 10_000, updatedAt: Date.now() - 5000 },
    { id: 'reading-private', title: 'Private reading sentinel', url: 'https://example.com/private-reading', status: 'unread', revision: 1, createdAt: Date.now() - 1000, updatedAt: Date.now() - 500 }];
    data.preferences = { ...data.preferences, privateKeys: ['folder:folder-private', 'site:site-private', 'note:note-private', 'reading:reading-private'],
      library: { version: 1, tags: [{ id: 'tag-native', name: '项目/2026' }, { id: 'tag-space', name: 'Project A' }, { id: 'tag-number', name: '123' }, { id: 'tag-slash', name: 'a//b' }], items: {
        'site:site-public': { description: metadataDescription, tagIds: ['tag-native', 'tag-space', 'tag-number', 'tag-slash'] },
        'reading:reading-public': { description: 'Read after review', tagIds: ['tag-native'] }, 'note:note-public': { description: 'Note context', tagIds: ['tag-space'] },
      } } };
  }
  data.navigation = Buffer.from(zipSync({ ...before.files, 'data.json': strToU8(JSON.stringify(navigation)) })).toString('base64');
  await restore(page, data); return snapshot(page);
}
async function goDesktop(page, name) {
  await page.bringToFront(); await search(page).click(); await search(page).fill(`type:desktop ${name}`);
  await page.getByRole('option').click(); await expect(page.locator('.desktop-page-name')).toHaveText(name);
}
async function appearance(page, name, locale = 'zh-CN') {
  const settings = await openSettingsLocale(page, locale);
  await choose(settings, t('外观范围', locale), new RegExp(`^${name}(?: · .*)?$`, 'u'));
  await expect(settings.locator('.desktop-appearance-editor')).toBeVisible(); return settings;
}
async function openSettingsLocale(page, locale = 'zh-CN') {
  await page.bringToFront(); await page.getByRole('button', { name: t('打开设置', locale), exact: true }).click();
  const settings = page.getByRole('dialog', { name: t('设置', locale), exact: true });
  await settings.getByRole('tab', { name: t('外观', locale), exact: true }).click(); return settings;
}
async function color(scope, value, locale = 'zh-CN') {
  await scope.getByRole('button', { name: t('颜色', locale), exact: true }).click();
  await scope.page().getByRole('textbox', { name: t('背景颜色 HEX', locale), exact: true }).fill(value);
  await scope.page().getByRole('button', { name: t('关闭颜色选择器', locale), exact: true }).click();
}
async function range(scope, label, value) {
  const slider = scope.getByRole('slider', { name: label, exact: true }); await slider.press('Home');
  for (let index = 0; index < value; index++) await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', String(value));
}
async function saveAppearance(settings, locale = 'zh-CN') {
  const editor = settings.locator('.desktop-appearance-editor');
  await editor.getByRole('button', { name: t('保存桌面外观', locale), exact: true }).click();
  await expect(editor).not.toHaveAttribute('aria-busy', 'true');
  await expect(editor.getByRole('button', { name: t('保存桌面外观', locale), exact: true })).toBeDisabled();
}
async function openExport(page, locale = 'zh-CN') {
  await page.bringToFront(); await page.getByRole('button', { name: t('命令面板', locale), exact: true }).click();
  const commands = page.getByRole('dialog', { name: t('命令面板', locale), exact: true });
  await commands.getByRole('combobox').fill(t(exportTitle, locale)); await commands.getByRole('option', { name: t(exportTitle, locale), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: t(exportTitle, locale), exact: true });
  await expect(dialog.locator('.markdown-library-rows')).toBeVisible(); return dialog;
}
async function exportZip(page, dialog, testInfo) {
  const pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: '导出', exact: true }).click();
  const download = await pending, chunks = [], stream = await download.createReadStream();
  for await (const chunk of stream) chunks.push(chunk);
  expect(download.suggestedFilename()).toBe('Covelet-library.zip'); await expect(dialog).toBeHidden();
  const bytes = Buffer.concat(chunks);
  if (testInfo) {
    const artifact = testInfo.outputPath('Covelet-library.zip'); await writeFile(artifact, bytes); await testInfo.attach('mixed-library-zip', { path: artifact, contentType: 'application/zip' });
    const portable = fileURLToPath(new URL('../../../output/0.6.0-portability/exported/Covelet-library.zip', import.meta.url));
    await mkdir(dirname(portable), { recursive: true }); await writeFile(portable, bytes);
  }
  return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, contents]) => [name, strFromU8(contents)]));
}
function properties(markdown) {
  const block = markdown.match(/^---\n([\s\S]*?)\n---\n/u); expect(block).not.toBeNull();
  return Object.fromEntries(block[1].split('\n').map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon), JSON.parse(line.slice(colon + 1))]; }));
}
const exportRow = (dialog, key) => dialog.locator(`[data-export-key="${key}"]`);
async function assertPaintedButtonText(button, testInfo) {
  // Finish finite CSS transitions before sampling their final forced colors.
  const png = (await button.screenshot({ animations: 'disabled' })).toString('base64');
  const paint = await button.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const box = element.getBoundingClientRect(), text = range.getBoundingClientRect(), style = getComputedStyle(element);
    const rgb = value => value.match(/[\d.]+/gu).slice(0, 3).map(Number);
    const luminance = values => values.map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const foreground = rgb(style.color), a = luminance(foreground), b = luminance(rgb(style.backgroundColor));
    return { foreground, color: style.color, background: style.backgroundColor, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), adjust: style.forcedColorAdjust,
      width: box.width, height: box.height, x: text.left - box.left, y: text.top - box.top, textWidth: text.width, textHeight: text.height };
  });
  await testInfo.attach('forced-colors-css', { body: JSON.stringify(paint), contentType: 'application/json' });
  expect(paint.contrast).toBeGreaterThanOrEqual(4.5);
  const coverage = await button.page().evaluate(async ({ png, paint }) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), character => character.charCodeAt(0))], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
    const sx = canvas.width / paint.width, sy = canvas.height / paint.height;
    const x = Math.max(0, Math.floor(paint.x * sx)), y = Math.max(0, Math.floor(paint.y * sy));
    const width = Math.min(canvas.width - x, Math.ceil(paint.textWidth * sx)), height = Math.min(canvas.height - y, Math.ceil(paint.textHeight * sy));
    const pixels = context.getImageData(x, y, width, height).data; let foreground = 0;
    for (let index = 0; index < pixels.length; index += 4) if (paint.foreground.every((value, channel) => Math.abs(value - pixels[index + channel]) < 70)) foreground++;
    return foreground / (width * height);
  }, { png, paint });
  // A UA forced-color backplate can report correct CSS contrast yet paint a
  // solid foreground rectangle instead of readable glyphs. Check actual paint.
  expect(coverage).toBeGreaterThan(.015); expect(coverage).toBeLessThan(.8);
  await testInfo.attach('forced-colors-text-paint', { body: JSON.stringify({ ...paint, coverage }), contentType: 'application/json' });
}

test('desktop appearance inherits each field, saves explicitly, follows identity through reflow and reorder, resets and restores', async ({ extension }, testInfo) => {
  const page = await extension.newtab(), initial = await seed(page);
  const settings = await appearance(page, 'Work desk'), editor = settings.locator('.desktop-appearance-editor');
  await expect(editor.getByRole('combobox', { name: '桌面背景', exact: true })).toHaveText('继承全局背景');
  await choose(editor, '桌面背景', '颜色'); await color(editor, '#654321');
  await editor.getByRole('checkbox', { name: '继承全局遮罩', exact: true }).uncheck(); await range(editor, '背景变暗', 22);
  await editor.getByRole('checkbox', { name: '继承全局模糊', exact: true }).uncheck(); await range(editor, '背景模糊', 6);
  await expect(background(page)).toHaveCSS('background-color', 'rgb(18, 52, 86)'); await saveAppearance(settings); await closeSettings(page);
  await goDesktop(page, 'Work desk'); await expect(background(page)).toHaveCSS('background-color', 'rgb(101, 67, 33)'); await expect(background(page)).toHaveCSS('filter', 'blur(6px)');
  await expect(page.locator('.wallpaper-shade')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.22)');
  const saved = await snapshot(page); expect(saved.navigation.settings.desktopPages[1]).toMatchObject({ id: 'desktop-work', appearance: { background: { kind: 'color', value: '#654321' }, shade: 22, blur: 6 } });
  await page.setViewportSize({ width: 390, height: 540 });
  await goDesktop(page, 'Home desk'); const parts = await page.locator('.desktop-page').count(); expect(parts).toBeGreaterThan(2);
  for (let index = 0; index < parts; index++) {
    const active = page.locator('.desktop-page[aria-hidden="false"]');
    const work = await active.locator('[data-entry-id="work-0"]').count() > 0;
    await expect(background(page)).toHaveCSS('background-color', work ? 'rgb(101, 67, 33)' : 'rgb(18, 52, 86)');
    if (index + 1 < parts) await page.getByRole('button', { name: '下一屏', exact: true }).click();
  }
  const narrow = await snapshot(page); expect(narrow.navigation.settings.desktopPages).toEqual(saved.navigation.settings.desktopPages);
  await page.setViewportSize({ width: 1280, height: 900 }); await goDesktop(page, 'Work desk');
  await page.locator('.desktop-page-viewport').press('Shift+F10'); await page.getByRole('menuitem', { name: '编辑布局', exact: true }).click();
  const toolbar = page.getByRole('toolbar', { name: '编辑布局', exact: true }); await toolbar.getByRole('button', { name: '屏幕管理', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '屏幕管理', exact: true }); await manager.getByRole('button', { name: '前移 Work desk', exact: true }).click();
  await manager.getByRole('button', { name: '前往 Work desk', exact: true }).click(); await toolbar.getByRole('button', { name: '完成', exact: true }).click(); await expect(toolbar).toBeHidden();
  const reordered = await snapshot(page); expect(reordered.navigation.settings.desktopPages[0]).toEqual(saved.navigation.settings.desktopPages[1]);
  const reset = await appearance(page, 'Work desk'); await reset.getByRole('button', { name: '全部继承全局', exact: true }).click(); await saveAppearance(reset); await closeSettings(page);
  await expect(background(page)).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  const inherited = await snapshot(page); expect(inherited.navigation.settings.desktopPages[0]).toMatchObject({ id: 'desktop-work' }); expect(inherited.navigation.settings.desktopPages[0]).not.toHaveProperty('appearance');
  await restore(page, saved.data); await goDesktop(page, 'Work desk'); await expect(background(page)).toHaveCSS('background-color', 'rgb(101, 67, 33)');
  expect((await snapshot(page)).navigation.settings.desktopPages).toEqual(saved.navigation.settings.desktopPages);
  expect(initial.navigation.settings.desktopPages[1].id).toBe('desktop-work');
  await page.screenshot({ path: testInfo.outputPath('restored-desktop-appearance.png'), animations: 'disabled' });
});

test('desktops share cached random photos without fetches, and stale edits or invalid backups preserve saved appearance', async ({ extension }, testInfo) => {
  const wallpaperRequests = [];
  await extension.context.route(/^https:\/\/www\.bing\.com\/(?:HPImageArchive\.aspx|th)\?/, route => {
    const url = new URL(route.request().url()); wallpaperRequests.push(url.href);
    return url.pathname === '/HPImageArchive.aspx' ? route.fulfill({ json: { images: [{ startdate: '20261114', enddate: '20261115',
      url: '/th?id=OHR.SharedDesktopFixture_1920x1080.jpg', title: 'Shared desktop fixture', copyright: 'Covelet synthetic fixture', copyrightlink: 'https://www.bing.com/search?q=Covelet' }] } })
      : route.fulfill({ contentType: 'image/png', body: makeImagePNG() });
  });
  const page = await extension.newtab(); await seed(page);
  const permissions = await extension.worker.evaluate(() => chrome.permissions.getAll());
  await page.getByRole('button', { name: '打开扩展', exact: true }).click(); await page.locator('#extension-random-wallpaper').click();
  const wallpaper = page.getByRole('dialog', { name: '随机壁纸', exact: true }); await wallpaper.getByRole('button', { name: '设为背景', exact: true }).click();
  await expect(wallpaper.getByRole('status')).toHaveText('已更换壁纸。'); await wallpaper.getByRole('button', { name: '关闭', exact: true }).click();
  const photo = await background(page).evaluate(element => getComputedStyle(element).backgroundImage); expect(photo).toContain('blob:'); const requests = wallpaperRequests.length; expect(requests).toBeGreaterThan(0);
  let settings = await appearance(page, 'Work desk'); await choose(settings, '桌面背景', '随机壁纸'); await saveAppearance(settings); await closeSettings(page);
  await goDesktop(page, 'Work desk'); await expect(background(page)).toHaveCSS('background-image', photo);
  settings = await appearance(page, 'Work desk'); await choose(settings, '桌面背景', '颜色'); await color(settings.locator('.desktop-appearance-editor'), '#ccbbaa'); await saveAppearance(settings); await closeSettings(page);
  settings = await appearance(page, 'Work desk'); await choose(settings, '桌面背景', '随机壁纸'); await saveAppearance(settings); await closeSettings(page);
  await goDesktop(page, 'Home desk'); await goDesktop(page, 'Work desk'); await expect(background(page)).toHaveCSS('background-image', photo); expect(wallpaperRequests.length).toBe(requests);
  const saved = await snapshot(page); settings = await appearance(page, 'Work desk'); await choose(settings, '桌面背景', '颜色');
  const other = await extension.newtab(); await addSite(other, 'Concurrent site', 'https://example.com/concurrent-appearance');
  await expect(settings.getByRole('alert')).toContainText('桌面已变化'); await expect(settings.getByRole('button', { name: '保存桌面外观', exact: true })).toBeDisabled();
  await expect(settings.getByRole('combobox', { name: '桌面背景', exact: true })).toHaveText('颜色');
  await settings.getByRole('button', { name: '放弃修改并重新载入', exact: true }).click(); await closeSettings(page);
  const after = await snapshot(page); expect(after.navigation.settings.desktopPages).toEqual(saved.navigation.settings.desktopPages);
  const invalid = structuredClone(after.data), navigation = structuredClone(after.navigation); navigation.settings.desktopPages[1].appearance.background = { kind: 'image', value: 'https://example.com/forbidden.png' };
  invalid.navigation = Buffer.from(zipSync({ ...after.files, 'data.json': strToU8(JSON.stringify(navigation)) })).toString('base64');
  const recovery = await openRecovery(page); await chooseBackupFile(page, recovery, Buffer.from(JSON.stringify(invalid)), 'invalid-appearance.json');
  await expect(recovery.getByRole('alert')).toBeVisible(); await expect(recovery.getByRole('button', { name: '确认恢复', exact: true })).toHaveCount(0); await closeSettings(page);
  expect((await snapshot(page)).navigation).toEqual(after.navigation); expect(await extension.worker.evaluate(() => chrome.permissions.getAll())).toEqual(permissions);
  await page.screenshot({ path: testInfo.outputPath('shared-cached-wallpaper.png'), animations: 'disabled' });
});

test('Markdown ZIP preserves all three content types and properties, always excludes private content and requires complex-note deselection', async ({ extension }, testInfo) => {
  const page = await extension.newtab(), before = await seed(page, { library: true }); expect(before.data.preferences.presentation).toBe(false);
  const dialog = await openExport(page); await expect(dialog.locator('.markdown-library-rows > label')).toHaveCount(6);
  await expect(dialog).not.toContainText('Private'); await expect(dialog).toContainText('Project A'); await expect(dialog).toContainText('仅作为属性保留的标签');
  await expect(dialog.getByRole('button', { name: '导出', exact: true })).toBeDisabled(); await exportRow(dialog, 'note:note-complex').getByRole('checkbox').uncheck();
  await page.screenshot({ path: testInfo.outputPath('library-explicit-deselection.png'), animations: 'disabled' });
  const files = await exportZip(page, dialog, testInfo), docs = Object.entries(files).filter(([name]) => name !== 'index.md').map(([name, text]) => ({ name, text, properties: properties(text) }));
  expect(docs.map(item => item.properties.covelet_type).sort()).toEqual(['note', 'note', 'note', 'reading', 'site']);
  const site = docs.find(item => item.properties.covelet_type === 'site').properties, reading = docs.find(item => item.properties.covelet_type === 'reading').properties;
  expect(site.title).toBe('Project: "Design" #1'); expect(site.description).toBe(metadataDescription); expect(site.covelet_path).toEqual(['Home desk', 'Folder # (研究)']);
  expect(site.covelet_tags).toEqual(['项目/2026', 'Project A', '123', 'a//b']); expect(site.tags).toEqual(['项目/2026']);
  expect(reading).toMatchObject({ status: 'read', revisit_on: '2026-11-30', url: 'https://example.com/a_(b)?x=%23#section' }); expect(reading.created).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(docs.find(item => item.properties.covelet_type === 'note').text).toContain('**Important**');
  expect(Object.values(files).join('\n')).not.toMatch(/Private|Complex callout/u); expect(files['index.md']).toContain('sites/'); expect(files['index.md']).toContain('reading/'); expect(files['index.md']).toContain('notes/');
  const after = await snapshot(page); expect(after.navigation).toEqual(before.navigation); expect(after.tools).toEqual(before.tools); expect(after.data.preferences).toEqual(before.data.preferences);
});

test('portable Unicode and colliding filenames have valid encoded relative links that actually open', async ({ extension }) => {
  const page = await extension.newtab(); await seed(page, { library: true, complex: false, collision: true });
  const dialog = await openExport(page), types = dialog.getByRole('group', { name: '导出内容', exact: true });
  await types.getByRole('checkbox', { name: '网站', exact: true }).uncheck(); await expect(exportRow(dialog, 'site:site-public')).toHaveCount(0);
  await types.getByRole('checkbox', { name: '稍后读', exact: true }).uncheck(); await expect(exportRow(dialog, 'reading:reading-public')).toHaveCount(0);
  const files = await exportZip(page, dialog), names = Object.keys(files).filter(name => name !== 'index.md'); expect(names).toHaveLength(5);
  expect(new Set(names.map(name => name.normalize('NFKC').toLowerCase())).size).toBe(5);
  expect(names.every(name => !/^(?:.*\/)?(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/iu.test(name) && !name.includes('..') && !name.includes('\\'))).toBe(true);
  expect(names.every(name => !/[#;@&=+$,^%\[\]]/u.test(name))).toBe(true);
  expect(names.map(name => properties(files[name]).title)).toContain('研究#(资料)');
  const destinations = [...files['index.md'].matchAll(/\]\(<([^>]+)>\)/gu)].map(match => match[1]); expect(destinations).toHaveLength(5);
  expect(files['index.md']).not.toContain('%23'); expect(files['index.md']).toContain('%28');
  for (const destination of destinations) { expect(files[decodeURIComponent(destination)]).toBeDefined(); expect(new URL(destination, 'https://library.example/index.md').hash).toBe(''); }
  // Render only standard index links into a tiny independent HTML reader. This
  // validates browser path resolution, not an Obsidian/Vault compatibility claim.
  await extension.context.route('https://library.example/**', route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    if (path === 'index.md') return route.fulfill({ contentType: 'text/html', body: destinations.map((destination, index) => `<a href="${destination}">Entry ${index}</a>`).join('<br>') });
    return route.fulfill({ status: files[path] ? 200 : 404, contentType: 'text/plain; charset=utf-8', body: files[path] || '' });
  });
  const reader = await extension.context.newPage();
  for (const [index, destination] of destinations.entries()) {
    await reader.goto('https://library.example/index.md'); await reader.getByRole('link', { name: `Entry ${index}`, exact: true }).click();
    await expect(reader).toHaveURL(new URL(destination, 'https://library.example/index.md').href); await expect(reader.locator('body')).toContainText('covelet_type: "note"');
  }
});

test('stale export writes no file, retains selection for refresh, and a newly private item closes the preview', async ({ extension }) => {
  const page = await extension.newtab(); await seed(page, { library: true, complex: false });
  const downloads = []; page.on('download', item => downloads.push(item)); let dialog = await openExport(page);
  await exportRow(dialog, 'note:note-public').getByRole('checkbox').uncheck();
  const other = await extension.newtab();
  await other.locator('[data-entry-id="folder-public"] .site-link').click();
  const folder = other.getByRole('dialog', { name: 'Folder # (研究)', exact: true });
  await folder.locator('[data-entry-id="site-public"] .site-link').click({ button: 'right' }); await other.getByRole('menuitem', { name: '编辑', exact: true }).click();
  const edit = other.getByRole('dialog', { name: '编辑网站', exact: true }); await edit.getByLabel('备注', { exact: true }).fill('Newer review context'); await edit.getByRole('button', { name: '保存', exact: true }).click(); await expect(edit).toBeHidden();
  await dialog.getByRole('button', { name: '导出', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('资料已更新'); expect(downloads).toHaveLength(0);
  await expect(exportRow(dialog, 'note:note-public').getByRole('checkbox')).not.toBeChecked(); await dialog.getByRole('button', { name: '重新预览', exact: true }).click();
  await expect(exportRow(dialog, 'note:note-public').getByRole('checkbox')).toBeChecked(); const files = await exportZip(page, dialog);
  expect(Object.values(files).join('\n')).toContain('Newer review context'); expect(downloads).toHaveLength(1);
  dialog = await openExport(page);
  await other.bringToFront(); if (!await folder.isVisible()) await other.locator('[data-entry-id="folder-public"] .site-link').click();
  await folder.locator('[data-entry-id="site-public"] .site-link').click({ button: 'right' }); await other.getByRole('menuitem', { name: '标记为私密', exact: true }).click();
  await expect(dialog).toBeHidden(); expect(downloads).toHaveLength(1);
  dialog = await openExport(page); await expect(exportRow(dialog, 'site:site-public')).toHaveCount(0); await expect(dialog).not.toContainText('Project: "Design" #1');
});

test('new appearance and export flows support eight languages, keyboard, touch, 200 percent zoom and forced colors', async ({ extension }, testInfo) => {
  const page = await extension.newtab(); await seed(page, { library: true, complex: false }); await page.setViewportSize({ width: 390, height: 540 });
  const languages = [['zh-CN', '简体中文'], ['en', 'English'], ['zh-TW', '繁體中文'], ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['ru', 'Русский']]; let current = 'zh-CN';
  for (const [locale, language] of languages) {
    let settings = await openSettingsLocale(page, current); await settings.locator('.language-setting').getByRole('combobox').click();
    await page.getByRole('option', { name: language, exact: true }).click(); current = locale; settings = page.getByRole('dialog', { name: t('设置', locale), exact: true });
    const scope = settings.getByRole('combobox', { name: t('外观范围', locale), exact: true }); await scope.press('Space'); await page.keyboard.press('Escape'); await expect(scope).toBeFocused();
    await choose(settings, t('外观范围', locale), 'Work desk');
    const editor = settings.locator('.desktop-appearance-editor'), inherit = editor.getByRole('checkbox', { name: t('继承全局遮罩', locale), exact: true });
    await inherit.focus(); await inherit.press('Space'); await expect(inherit).not.toBeChecked(); await inherit.press('Space'); await expect(inherit).toBeChecked();
    await expect(editor.getByRole('button', { name: t('保存桌面外观', locale), exact: true })).toBeDisabled();
    const geometry = async element => element.evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: node.clientWidth, scroll: node.scrollWidth, viewport: innerWidth }; });
    let g = await geometry(settings); expect(g.scroll).toBeLessThanOrEqual(g.width + 1); expect(g.right).toBeLessThanOrEqual(g.viewport + 1);
    await page.screenshot({ path: testInfo.outputPath(`appearance-${locale}-390.png`), animations: 'disabled' }); await closeSettings(page, locale);
    const dialog = await openExport(page, locale); await expect(dialog.getByRole('button', { name: t('导出', locale), exact: true })).toBeInViewport();
    g = await geometry(dialog); expect(g.scroll).toBeLessThanOrEqual(g.width + 1); expect(g.right).toBeLessThanOrEqual(g.viewport + 1);
    await page.screenshot({ path: testInfo.outputPath(`library-${locale}-390.png`), animations: 'disabled' });
    const cancel = dialog.getByRole('button', { name: t('取消', locale), exact: true }), box = await cancel.boundingBox(); await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); await expect(dialog).toBeHidden();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(await page.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); await chrome.tabs.setZoom(tab.id, 2); return chrome.tabs.getZoom(tab.id); })).toBe(2);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(640); await page.emulateMedia({ forcedColors: 'active' });
  const dialog = await openExport(page, current); await expect(dialog.getByRole('button', { name: t('导出', current), exact: true })).toBeInViewport();
  await dialog.getByRole('button', { name: t('重新预览', current), exact: true }).focus(); await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: t('导出', current), exact: true })).toBeFocused();
  await assertPaintedButtonText(dialog.getByRole('button', { name: t('导出', current), exact: true }), testInfo);
  await page.screenshot({ path: testInfo.outputPath('library-200-percent-forced-colors.png'), animations: 'disabled' });
  await page.evaluate(async () => { const tab = await chrome.tabs.getCurrent(); await chrome.tabs.setZoom(tab.id, 1); });
});
