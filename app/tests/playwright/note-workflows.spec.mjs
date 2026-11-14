import { test, expect, openSettings } from './extension.fixture.mjs';
import { createNote, exportCompleteBackup } from './backup-helpers.mjs';
import { readFile } from 'node:fs/promises';

// Only this test-owned copy grants the synthetic page origin. The production
// manifest is unchanged. The tests use real tabs/scripting/selection, but do
// not claim to validate a native toolbar click or its activeTab permission UI.
test.use({ pregrantedHosts: ['https://capture.example/*'] });
const sourceURL = 'https://capture.example/article?detail=a%7Cb#evidence';
const sourceTitle = 'Research capture fixture';
const excerpt = 'Captured insight <literal> **not Markdown**';
const search = page => page.getByRole('combobox', { name: '搜索或输入网址', exact: true });
const noteEditor = dialog => dialog.locator('.folio-note-editor [contenteditable="true"]');
const escaped = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const catalog = JSON.parse(await readFile(new URL('../../src/i18n/catalog.json', import.meta.url), 'utf8'));
const translated = (key, locale) => locale === 'zh-CN' ? key : catalog[key]?.[locale] || catalog[key]?.en || key;

async function notesSnapshot(page) {
  const backup = await exportCompleteBackup(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeHidden();
  return backup.tools.notes;
}

async function openNote(page, query, title) {
  await page.bringToFront();
  await search(page).fill(query);
  await page.getByRole('option').filter({ hasText: title }).click();
  const dialog = page.getByRole('dialog', { name: '便笺', exact: true });
  await expect(dialog.getByLabel('便笺名称', { exact: true })).toHaveValue(title);
  await expect(noteEditor(dialog)).toBeVisible();
  return dialog;
}

async function capturePopup(extension, existingSource, locale = 'zh-CN') {
  const source = existingSource || await extension.context.newPage();
  if (!existingSource) {
    // Opening the real toolbar popup performs its existing explicit icon
    // discovery before switching to Notes. Allow only these known probes.
    await extension.context.route(/^https:\/\/capture\.example\/(?:favicon\.ico|apple-touch-icon(?:-precomposed)?\.png|android-chrome-192x192\.png)$/u,
      route => route.fulfill({ status: 404, body: '' }));
    await extension.context.route(sourceURL.split('#')[0], route => route.fulfill({
      status: 200, contentType: 'text/html',
      body: `<!doctype html><title>${sourceTitle}</title><p id="excerpt">${escaped(excerpt)}</p>`,
    }));
    await source.goto(sourceURL);
  }
  await source.bringToFront();
  await source.locator('#excerpt').evaluate(element => {
    const selection = window.getSelection(), range = document.createRange();
    range.selectNodeContents(element); selection.removeAllRanges(); selection.addRange(range);
  });
  const ready = extension.context.waitForEvent('page');
  await extension.worker.evaluate(async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL(chrome.runtime.getManifest().action.default_popup), active: false });
  });
  const popup = await ready;
  await expect(popup.getByRole('tab', { name: translated('便笺', locale), exact: true })).toBeVisible();
  await popup.getByRole('tab', { name: translated('便笺', locale), exact: true }).click();
  await expect(popup.getByLabel(translated('便笺内容', locale), { exact: true })).toHaveValue(excerpt);
  await expect(popup.locator('.note-capture-source a')).toHaveAttribute('href', sourceURL);
  return { popup, source };
}

async function currentMatchGeometry(page) {
  return page.evaluate(() => {
    const name = [...CSS.highlights.keys()].find(key => key.startsWith('covelet-note-match-') && key.endsWith('-current'));
    const range = name && [...CSS.highlights.get(name)][0];
    const container = range?.startContainer.parentElement?.closest('.folio-editor__content');
    if (!range || !container) return null;
    const match = range.getBoundingClientRect();
    let boundsTop = 0, boundsBottom = innerHeight;
    for (let node = container; node; node = node.parentElement) {
      if (node !== container && !/auto|scroll|hidden|clip/u.test(getComputedStyle(node).overflowY)) continue;
      const rect = node.getBoundingClientRect();
      boundsTop = Math.max(boundsTop, rect.top + node.clientTop);
      boundsBottom = Math.min(boundsBottom, rect.top + node.clientTop + node.clientHeight);
    }
    return { top: match.top, bottom: match.bottom, boundsTop, boundsBottom, scrollTop: container.scrollTop };
  });
}

async function expectCurrentMatchInView(page) {
  await expect.poll(async () => {
    const value = await currentMatchGeometry(page);
    return Boolean(value && value.scrollTop > 0 && value.top >= value.boundsTop - 1 && value.bottom <= value.boundsBottom + 1);
  }, { message: 'the current text range must be scrolled into the actual Folio viewport' }).toBe(true);
}

async function chooseAppend(popup, title) {
  await popup.getByRole('combobox', { name: '保存方式', exact: true }).click();
  await popup.getByRole('option', { name: '追加到便笺', exact: true }).click();
  await popup.getByRole('textbox', { name: '搜索目标便笺', exact: true }).fill(title);
  await popup.getByRole('combobox', { name: '选择目标便笺', exact: true }).click();
  await popup.getByRole('option', { name: title, exact: true }).click();
}

async function cancelCapture(popup) {
  await popup.getByRole('button', { name: '取消', exact: true }).click();
  const confirm = popup.getByRole('button', { name: '放弃修改', exact: true });
  await expect(confirm).toBeVisible();
  const closed = popup.waitForEvent('close');
  await confirm.click();
  await closed;
}

async function markPrivateNote(page, title) {
  const settings = await openSettings(page, '搜索');
  await settings.getByRole('button', { name: '内容备注、标签与隐私', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '内容与隐私', exact: true });
  await dialog.getByRole('combobox', { name: '选择内容', exact: true }).click();
  await dialog.getByRole('option', { name: `便笺 · ${title}`, exact: true }).click();
  await dialog.getByRole('checkbox', { name: '开启隐藏时锁定此内容', exact: true }).check();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: '开启隐藏', exact: true }).click();
  const passwordDialog = page.getByRole('dialog', { name: '设置隐藏密码', exact: true });
  await passwordDialog.getByLabel('新密码', { exact: true }).fill('synthetic-note-privacy');
  await passwordDialog.getByLabel('确认密码', { exact: true }).fill('synthetic-note-privacy');
  await passwordDialog.getByRole('button', { name: '设置并隐藏', exact: true }).click();
  await expect(passwordDialog).toBeHidden();
}

test('global body hits navigate transient matches without changing a note or creating a dirty draft', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  const padding = Array.from({ length: 70 }, (_, index) => `Research context line ${index}.`).join('\n');
  await createNote(page, { title: 'Research notebook', body: `${padding}\nFirst targetneedle paragraph.\n${padding}\nSecond targetneedle paragraph.\n${padding}\nThird targetneedle paragraph.` });
  await createNote(page, { title: 'titleonlytoken', body: 'Unrelated body content.' });
  const before = await notesSnapshot(page);
  const dialog = await openNote(page, 'targetneedle type:note', 'Research notebook');
  const matches = dialog.locator('[data-note-search-matches]');
  await expect(matches.getByText('第 1 / 3 处', { exact: true })).toBeVisible();
  await expectCurrentMatchInView(page);
  const first = await currentMatchGeometry(page);
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await matches.getByRole('button', { name: '下一处', exact: true }).click();
  await expect(matches.getByText('第 2 / 3 处', { exact: true })).toBeVisible();
  await expectCurrentMatchInView(page);
  expect((await currentMatchGeometry(page)).scrollTop).toBeGreaterThan(first.scrollTop);
  await matches.getByRole('button', { name: '上一处', exact: true }).click();
  await expect(matches.getByText('第 1 / 3 处', { exact: true })).toBeVisible();
  const highlights = await page.evaluate(() => [...CSS.highlights].filter(([key]) => key.startsWith('covelet-note-match-')).map(([key, value]) => ({ key, ranges: value.size })));
  expect(highlights.some(item => item.ranges === 3)).toBe(true);
  await page.setViewportSize({ width: 390, height: 540 });
  await matches.getByRole('button', { name: '下一处', exact: true }).click();
  await expectCurrentMatchInView(page);
  await page.screenshot({ path: testInfo.outputPath('note-search-matches-390x540.png'), animations: 'disabled' });
  await matches.getByRole('button', { name: '关闭搜索定位', exact: true }).click();
  await expect(matches).toHaveCount(0);
  expect(await page.evaluate(() => [...CSS.highlights.keys()].filter(key => key.startsWith('covelet-note-match-')))).toEqual([]);
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 900 });
  const titleOnly = await openNote(page, 'titleonlytoken type:note', 'titleonlytoken');
  await expect(titleOnly.getByText('正文中没有匹配的文字。', { exact: true })).toBeVisible();
  await expect(titleOnly.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(titleOnly).toBeHidden();
  expect(await notesSnapshot(page)).toEqual(before);
});

test('real selected page text appends with its source and cancellation leaves the saved note unchanged', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  const title = 'Project collection';
  await createNote(page, { title, body: 'Existing evidence to preserve.' });
  const before = await notesSnapshot(page), original = before.find(note => note.title === title);
  let { popup, source } = await capturePopup(extension);
  await chooseAppend(popup, title);
  await popup.getByRole('button', { name: '追加预览', exact: true }).click();
  const preview = popup.getByRole('region', { name: '追加预览', exact: true });
  await expect(preview).toContainText(excerpt);
  await expect(preview).toContainText(sourceURL);
  await cancelCapture(popup);
  await page.bringToFront();
  expect(await notesSnapshot(page)).toEqual(before);

  ({ popup } = await capturePopup(extension, source));
  await chooseAppend(popup, title);
  const closed = popup.waitForEvent('close');
  await popup.getByRole('button', { name: '追加', exact: true }).click();
  await closed;
  await page.bringToFront();
  const after = await notesSnapshot(page), appended = after.find(note => note.id === original.id);
  expect(after).toHaveLength(before.length);
  expect(appended.title).toBe(original.title);
  expect(appended.pinned).toBe(original.pinned);
  expect(appended.revision).toBe(original.revision + 1);
  expect(appended.body.startsWith(original.body)).toBe(true);
  expect(appended.body).toContain(excerpt);
  expect(appended.body).toContain(sourceTitle);
  expect(appended.body).toContain(sourceURL);
  expect(appended.document.content.slice(0, original.document.content.length)).toEqual(original.document.content);
  const dialog = await openNote(page, title, title);
  await expect(noteEditor(dialog)).toContainText(excerpt);
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('appended-note-with-source.png'), animations: 'disabled' });
});

test('an external edit invalidates the chosen append target and retains the captured draft', async ({ extension }) => {
  const page = await extension.newtab(), title = 'Concurrent project';
  await createNote(page, { title, body: 'Original research.' });
  const { popup } = await capturePopup(extension);
  await chooseAppend(popup, title);
  const dialog = await openNote(page, title, title);
  await noteEditor(dialog).fill('External revision must win.');
  const save = dialog.getByRole('button', { name: '保存', exact: true });
  await expect(save).toBeEnabled(); await save.click(); await expect(save).toBeDisabled();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(popup.getByText('所选便笺已变化，请重新选择。', { exact: true }).last()).toBeVisible();
  await expect(popup.getByRole('button', { name: '追加', exact: true })).toBeDisabled();
  await expect(popup.getByLabel('便笺内容', { exact: true })).toHaveValue(excerpt);
  const current = (await notesSnapshot(page)).find(note => note.title === title);
  expect(current.body).toBe('External revision must win.');
  expect(current.body).not.toContain(excerpt);
  await cancelCapture(popup);
});

test('an oversized append is refused before writing and keeps the selection available to shorten', async ({ extension }) => {
  const page = await extension.newtab(), title = 'Near capacity research';
  await createNote(page, { title, body: 'a'.repeat(59990) });
  const before = await notesSnapshot(page);
  const { popup } = await capturePopup(extension);
  await chooseAppend(popup, title);
  await expect(popup.locator('.note-capture .form-error[role="alert"]')).toBeVisible();
  await expect(popup.getByRole('button', { name: '追加', exact: true })).toBeDisabled();
  await expect(popup.getByLabel('便笺内容', { exact: true })).toHaveValue(excerpt);
  await page.bringToFront();
  expect(await notesSnapshot(page)).toEqual(before);
  await cancelCapture(popup);
});

test('hidden notes cannot be discovered as append destinations', async ({ extension }, testInfo) => {
  const page = await extension.newtab(), privateTitle = 'Private acquisition evidence';
  await createNote(page, { title: privateTitle, body: 'Private note body.' });
  await createNote(page, { title: 'Visible research', body: 'Public note body.' });
  await markPrivateNote(page, privateTitle);
  const { popup } = await capturePopup(extension);
  await popup.getByRole('combobox', { name: '保存方式', exact: true }).click();
  await popup.getByRole('option', { name: '追加到便笺', exact: true }).click();
  await popup.getByRole('textbox', { name: '搜索目标便笺', exact: true }).fill('');
  await popup.getByRole('combobox', { name: '选择目标便笺', exact: true }).click();
  await expect(popup.getByRole('option', { name: 'Visible research', exact: true })).toBeVisible();
  await expect(popup.getByRole('option', { name: privateTitle, exact: true })).toHaveCount(0);
  await expect(popup.getByRole('listbox')).not.toContainText('Private note body.');
  await popup.keyboard.press('Escape');
  await popup.getByRole('textbox', { name: '搜索目标便笺', exact: true }).fill('acquisition');
  await expect(popup.getByRole('button', { name: '追加', exact: true })).toBeDisabled();
  await popup.screenshot({ path: testInfo.outputPath('private-note-not-a-destination.png'), animations: 'disabled' });
  await cancelCapture(popup);
});

test('search matches and append controls render in all eight languages without overflowing a narrow window', async ({ extension }, testInfo) => {
  const page = await extension.newtab(), title = 'Localised research';
  await createNote(page, { title, body: 'First localneedle. Second localneedle.' });
  const languages = [['zh-CN', '简体中文'], ['en', 'English'], ['zh-TW', '繁體中文'], ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['ru', 'Русский']];
  let current = 'zh-CN', source;
  for (const [locale, label] of languages) {
    for (const key of ['搜索定位', '关闭搜索定位', '保存方式', '追加到便笺', '搜索目标便笺', '选择目标便笺', '追加预览', '追加']) {
      if (locale !== 'zh-CN') expect(catalog[key]?.[locale], `${key} must have a ${locale} translation`).toBeTruthy();
    }
    await page.bringToFront();
    await page.getByRole('button', { name: translated('打开设置', current), exact: true }).click();
    const settings = page.getByRole('dialog', { name: translated('设置', current), exact: true });
    await settings.getByRole('tab', { name: translated('外观', current), exact: true }).click();
    await settings.locator('.language-setting').getByRole('combobox').click();
    await settings.getByRole('option', { name: label, exact: true }).click();
    current = locale;
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: translated('搜索或输入网址', locale), exact: true }).fill('localneedle type:note');
    await page.getByRole('option').filter({ hasText: title }).click();
    const dialog = page.getByRole('dialog', { name: translated('便笺', locale), exact: true });
    const matches = dialog.locator('[data-note-search-matches]');
    await expect(matches).toBeVisible();
    await expect(matches.getByRole('button', { name: translated('关闭搜索定位', locale), exact: true })).toBeVisible();
    await matches.getByRole('button', { name: translated('下一处', locale), exact: true }).click();
    await expect(dialog.getByRole('button', { name: translated('保存', locale), exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 540 });
    const bounds = await matches.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewport: innerWidth };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
    await page.screenshot({ path: testInfo.outputPath(`note-matches-${locale}-390x540.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 900 });

    const captured = await capturePopup(extension, source, locale);
    source = captured.source;
    const popup = captured.popup;
    await popup.setViewportSize({ width: 390, height: 540 });
    await popup.getByRole('combobox', { name: translated('保存方式', locale), exact: true }).click();
    await popup.getByRole('option', { name: translated('追加到便笺', locale), exact: true }).click();
    await expect(popup.getByRole('textbox', { name: translated('搜索目标便笺', locale), exact: true })).toBeVisible();
    await popup.getByRole('combobox', { name: translated('选择目标便笺', locale), exact: true }).click();
    await popup.getByRole('option', { name: title, exact: true }).click();
    await popup.getByRole('button', { name: translated('追加预览', locale), exact: true }).click();
    await expect(popup.getByRole('region', { name: translated('追加预览', locale), exact: true })).toContainText(sourceURL);
    await expect(popup.getByRole('button', { name: translated('追加', locale), exact: true })).toBeEnabled();
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await popup.screenshot({ path: testInfo.outputPath(`append-${locale}-390x540.png`), animations: 'disabled' });
    await popup.close();
  }
});
