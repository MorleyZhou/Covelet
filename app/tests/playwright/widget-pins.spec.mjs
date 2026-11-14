import { test, expect, openSettings } from './extension.fixture.mjs';
import { createNote, exportCompleteBackup, openRecovery, chooseBackupFile, restorePreview, revealDesktopItem } from './backup-helpers.mjs';
import { zipSync } from 'fflate';
import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(await readFile(new URL('../../src/i18n/catalog.json', import.meta.url), 'utf8'));
const t = (key, locale = 'zh-CN') => locale === 'zh-CN' ? key : catalog[key]?.[locale] || catalog[key]?.en || key;
const search = page => page.getByRole('combobox', { name: '搜索或输入网址', exact: true });
const tile = (page, id) => page.locator(`[data-entry-id="${id}"]`);
const editor = dialog => dialog.locator('.folio-note-editor [contenteditable="true"]');

async function closeDialog(page, title = '便笺') {
  const dialog = page.getByRole('dialog', { name: title, exact: true });
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function snapshot(page) {
  const backup = await exportCompleteBackup(page);
  await closeDialog(page, '设置');
  return backup;
}
async function openNote(page, title) {
  await page.bringToFront();
  await search(page).click();
  await search(page).fill(title);
  await page.getByRole('option').filter({ hasText: title }).click();
  const dialog = page.getByRole('dialog', { name: '便笺', exact: true });
  await expect(dialog.getByLabel('便笺名称', { exact: true })).toHaveValue(title);
  return dialog;
}
async function addNote(page, title, body) {
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const commands = page.getByRole('dialog', { name: '命令面板', exact: true });
  await commands.getByRole('combobox').fill('新便笺');
  await commands.getByRole('option', { name: '新便笺', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '便笺', exact: true });
  await dialog.getByLabel('便笺名称', { exact: true }).fill(title);
  await editor(dialog).fill(body);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await closeDialog(page);
}
async function confirmPin(page, { desktop, size = '小 · 2×2', locale = 'zh-CN' } = {}) {
  const dialog = page.getByRole('dialog', { name: t('固定到桌面', locale), exact: true });
  const destination = dialog.getByRole('combobox', { name: t('目标桌面', locale), exact: true });
  await expect(destination).toBeEnabled();
  if (desktop) await expect(destination).toHaveText(desktop);
  await dialog.getByRole('combobox', { name: t('尺寸', locale), exact: true }).click();
  await dialog.getByRole('option', { name: t(size, locale), exact: true }).click();
  await dialog.getByRole('button', { name: t('固定', locale), exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function pinNote(page, title, options) {
  const dialog = await openNote(page, title);
  await dialog.getByRole('button', { name: '固定到桌面', exact: true }).click();
  await confirmPin(page, options);
  await closeDialog(page);
  const backup = await snapshot(page), note = backup.tools.notes.find(item => item.title === title);
  const entries = backup.navigation.entries.filter(item => item.extensionId === 'notes' && item.config.noteId === note.id);
  expect(entries.length).toBeGreaterThan(0);
  return { backup, note, entry: entries.at(-1), entries };
}
async function saveView(page, name, query) {
  await search(page).fill(query);
  await page.getByRole('button', { name: '动态清单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '动态清单', exact: true });
  await dialog.getByRole('button', { name: '保存当前筛选', exact: true }).click();
  await dialog.getByLabel('清单名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.locator('.saved-view-open').filter({ hasText: name })).toBeVisible();
  await closeDialog(page, '动态清单');
}
async function pinView(page, name, options) {
  await page.getByRole('button', { name: '动态清单', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '动态清单', exact: true });
  await dialog.locator('.saved-view-row').filter({ has: page.getByText(name, { exact: true }) })
    .getByRole('button', { name: '固定到桌面', exact: true }).click();
  await confirmPin(page, options);
  await closeDialog(page, '动态清单');
  const backup = await snapshot(page), view = backup.data.preferences.library.views.find(item => item.name === name);
  const entries = backup.navigation.entries.filter(item => item.extensionId === 'saved-view' && item.config.viewId === view.id);
  expect(entries.length).toBeGreaterThan(0);
  return { backup, view, entry: entries.at(-1), entries };
}
async function removeWidget(page, entry) {
  const item = tile(page, entry.id);
  await revealDesktopItem(page, item);
  await item.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移除组件', exact: true }).click();
  await expect(item).toHaveCount(0);
}
async function deleteNote(page, title) {
  const dialog = await openNote(page, title);
  await dialog.getByRole('button', { name: '删除便笺', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click();
  await closeDialog(page);
}
async function newDesktop(page, name) {
  await page.bringToFront();
  await page.locator('.desktop-page-viewport').press('Shift+F10');
  await page.getByRole('menuitem', { name: '编辑布局', exact: true }).click();
  const toolbar = page.getByRole('toolbar', { name: '编辑布局', exact: true });
  await toolbar.getByRole('button', { name: '屏幕管理', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '屏幕管理', exact: true });
  await manager.getByRole('button', { name: '添加一屏', exact: true }).click();
  const input = manager.getByRole('textbox', { name: '第 2 屏名称', exact: true });
  await input.fill(name); await input.press('Enter');
  await manager.getByRole('button', { name: `前往 ${name}`, exact: true }).click();
  await toolbar.getByRole('button', { name: '完成', exact: true }).click();
  await expect(toolbar).toBeHidden();
  await expect(page.locator('.desktop-page-name')).toHaveText(name);
}
async function restoreFile(page, buffer, name) {
  const recovery = await openRecovery(page);
  await chooseBackupFile(page, recovery, buffer, name);
  await restorePreview(recovery);
  await closeDialog(page, '设置');
}
async function markNotePrivate(page, title) {
  const settings = await openSettings(page, '搜索');
  await settings.getByRole('button', { name: '内容备注、标签与隐私', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '内容与隐私', exact: true });
  await dialog.getByRole('combobox', { name: '选择内容', exact: true }).click();
  await dialog.getByRole('option', { name: `便笺 · ${title}`, exact: true }).click();
  await dialog.getByRole('checkbox', { name: '开启隐藏时锁定此内容', exact: true }).check();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function hide(page) {
  await page.getByRole('button', { name: '开启隐藏', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置隐藏密码', exact: true });
  await dialog.getByLabel('新密码', { exact: true }).fill('synthetic-pinned-privacy');
  await dialog.getByLabel('确认密码', { exact: true }).fill('synthetic-pinned-privacy');
  await dialog.getByRole('button', { name: '设置并隐藏', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('the same note has independent desktop pins, opens directly, updates live and survives removal', async ({ extension }, testInfo) => {
  const page = await extension.newtab(), title = 'Pinned project notebook';
  await createNote(page, { title, body: 'Initial pinned evidence.' });
  const first = await pinNote(page, title);
  expect(first.backup.navigation.entries.some(entry => entry.extensionId === 'notes' && !entry.config.noteId)).toBe(true);
  await newDesktop(page, '工作');
  const second = await pinNote(page, title, { desktop: '工作' });
  expect(second.entries).toHaveLength(2);
  expect(new Set(second.entries.map(entry => entry.id)).size).toBe(2);
  expect(new Set(second.entries.map(entry => entry.page)).size).toBe(2);
  for (const entry of second.entries) expect(entry.name).toBe('便笺');
  await revealDesktopItem(page, tile(page, second.entry.id));
  await tile(page, second.entry.id).locator('[data-widget-launcher]').click();
  const dialog = page.getByRole('dialog', { name: '便笺', exact: true });
  await expect(dialog.getByLabel('便笺名称', { exact: true })).toHaveValue(title);
  await editor(dialog).fill('Updated evidence shared by both pins.');
  await expect(dialog.getByRole('button', { name: '固定到桌面', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await closeDialog(page);
  for (const entry of second.entries) await expect(tile(page, entry.id)).toContainText('Updated evidence shared by both pins.');
  await removeWidget(page, second.entry);
  const after = await snapshot(page);
  expect(after.tools.notes.find(note => note.id === first.note.id)?.body).toBe('Updated evidence shared by both pins.');
  expect(after.navigation.entries.filter(entry => entry.config?.noteId === first.note.id)).toHaveLength(1);
  await revealDesktopItem(page, tile(page, first.entry.id));
  await page.screenshot({ path: testInfo.outputPath('note-pin-survives-other-pin-removal.png'), animations: 'disabled' });
});

test('deleting a pinned note never falls back to a different note and restoring its record repairs the reference', async ({ extension }) => {
  const page = await extension.newtab(), title = 'Specific record';
  await createNote(page, { title, body: 'Only this record belongs to the pin.' });
  const pinned = await pinNote(page, title);
  await addNote(page, 'Unrelated latest note', 'Must never appear in the missing pin.');
  await deleteNote(page, title);
  const card = tile(page, pinned.entry.id);
  await expect(card).toContainText(/已删除|已移除|失效|不可用/u);
  await expect(card).not.toContainText('Unrelated latest note');
  await expect(card).not.toContainText('Must never appear');
  const settings = await openSettings(page, '回收站');
  const row = settings.locator('.personal-trash-record').filter({ hasText: title });
  await row.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(row).toHaveCount(0);
  await closeDialog(page, '设置');
  await expect(card).toContainText(title);
  await expect(card).toContainText('Only this record belongs to the pin.');
});

test('saved-view pins update their contents, open the chosen record and keep view data when a component is removed', async ({ extension }, testInfo) => {
  const page = await extension.newtab();
  await createNote(page, { title: 'View research Alpha', body: 'pinviewkeyword Alpha evidence.' });
  await page.getByRole('button', { name: '打开扩展', exact: true }).click();
  await page.locator('#extension-saved-view').click();
  const extensionDialog = page.getByRole('dialog', { name: '动态清单', exact: true });
  await extensionDialog.getByRole('button', { name: '添加到桌面', exact: true }).click();
  await expect(extensionDialog).toBeHidden();
  const unconfigured = (await snapshot(page)).navigation.entries.find(entry => entry.extensionId === 'saved-view' && !entry.config.viewId);
  expect(unconfigured).toBeTruthy();
  const placeholder = tile(page, unconfigured.id);
  await expect(placeholder).toContainText('选择动态清单');
  await expect(placeholder).not.toContainText('View research Alpha');
  await placeholder.locator('[data-widget-launcher]').click();
  let picker = page.getByRole('dialog', { name: '选择动态清单', exact: true });
  await expect(picker.getByText('还没有动态清单', { exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await picker.getByRole('button', { name: '取消', exact: true }).click();
  await saveView(page, 'Project research queue', 'pinviewkeyword type:note');
  await placeholder.locator('[data-widget-launcher]').click();
  picker = page.getByRole('dialog', { name: '选择动态清单', exact: true });
  await picker.getByRole('combobox', { name: '动态清单', exact: true }).click();
  await picker.getByRole('option', { name: 'Project research queue', exact: true }).click();
  await picker.getByRole('button', { name: '保存', exact: true }).click();
  await expect(picker).toBeHidden();
  const configured = await snapshot(page);
  const first = { entry: configured.navigation.entries.find(entry => entry.id === unconfigured.id), view: configured.data.preferences.library.views.find(view => view.name === 'Project research queue') };
  expect(first.entry.config.viewId).toBe(first.view.id);
  const second = await pinView(page, 'Project research queue');
  await removeWidget(page, second.entry);
  expect((await snapshot(page)).data.preferences.library.views.some(view => view.id === first.view.id)).toBe(true);
  await addNote(page, 'View research Beta', 'pinviewkeyword Beta evidence.');
  const card = tile(page, first.entry.id);
  await revealDesktopItem(page, card);
  await expect(card).toContainText('View research Alpha');
  await expect(card).toContainText('View research Beta');
  await search(page).fill(''); await search(page).press('Escape');
  await page.screenshot({ path: testInfo.outputPath('saved-view-live-two-matches.png'), animations: 'disabled' });
  await card.getByRole('button').filter({ hasText: 'View research Beta' }).click();
  const note = page.getByRole('dialog', { name: '便笺', exact: true });
  await expect(note.getByLabel('便笺名称', { exact: true })).toHaveValue('View research Beta');
  await editor(note).fill('This record is no longer part of the queue.');
  await note.getByRole('button', { name: '保存', exact: true }).click();
  await closeDialog(page);
  await expect(card).not.toContainText('View research Beta');
  await expect(card).toContainText('View research Alpha');
  await page.getByRole('button', { name: '动态清单', exact: true }).click();
  const views = page.getByRole('dialog', { name: '动态清单', exact: true });
  await views.locator('.saved-view-row').filter({ hasText: 'Project research queue' }).getByRole('button', { name: '删除清单', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click();
  await closeDialog(page, '动态清单');
  await expect(card).toContainText(/已删除|已移除|失效|不可用/u);
  await expect(card).not.toContainText('View research Alpha');
  await page.screenshot({ path: testInfo.outputPath('deleted-view-does-not-show-all-notes.png'), animations: 'disabled' });
});

test('direct and conditionally hidden targets reveal no card titles, counts, menus or search suggestions', async ({ extension }, testInfo) => {
  const page = await extension.newtab(), title = 'Secret acquisition notebook', tag = 'Acquisition restricted';
  await createNote(page, { title, body: 'Private strategy must remain hidden.' });
  await addNote(page, 'Visible planning', 'Public working notes.');
  const note = await openNote(page, title);
  await note.getByRole('textbox', { name: '新标签名称', exact: true }).fill(tag);
  await note.getByRole('button', { name: '添加标签', exact: true }).click();
  await expect(note.getByRole('checkbox', { name: tag, exact: true })).toBeChecked();
  await note.getByRole('button', { name: '保存', exact: true }).click();
  await closeDialog(page);
  const direct = await pinNote(page, title);
  await saveView(page, 'Secret acquisition queue', `tag:"${tag}" type:note`);
  const conditional = await pinView(page, 'Secret acquisition queue');
  await page.getByRole('button', { name: '打开扩展', exact: true }).click();
  await page.locator('#extension-saved-view').click();
  const configuration = page.getByRole('dialog', { name: '动态清单', exact: true });
  await configuration.getByRole('button', { name: '添加到桌面', exact: true }).click();
  await expect(configuration).toBeHidden();
  const placeholder = (await snapshot(page)).navigation.entries.find(entry => entry.extensionId === 'saved-view' && !entry.config.viewId);
  await tile(page, placeholder.id).locator('[data-widget-launcher]').click();
  const picker = page.getByRole('dialog', { name: '选择动态清单', exact: true });
  await picker.getByRole('combobox', { name: '动态清单', exact: true }).click();
  await picker.getByRole('option', { name: 'Secret acquisition queue', exact: true }).click();
  await expect(picker.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await expect(page.locator('.search-area input[role="combobox"]')).toHaveValue(`tag:"${tag}" type:note`);
  const commandTab = await extension.newtab();
  await commandTab.getByRole('button', { name: '命令面板', exact: true }).click();
  const openCommands = commandTab.getByRole('dialog', { name: '命令面板', exact: true });
  await openCommands.getByRole('combobox').fill('acquisition');
  await expect(openCommands.getByRole('option').filter({ hasText: title })).toBeVisible();
  const otherTab = await extension.newtab();
  await markNotePrivate(otherTab, title);
  await hide(otherTab);
  await expect(page.locator('.search-area input[role="combobox"]')).toHaveValue('');
  await expect(openCommands).toBeHidden();
  await expect(commandTab.locator('.search-area input[role="combobox"]')).toHaveValue('');
  await expect(picker.getByText('清单包含隐藏条件，请先解锁。', { exact: true })).toBeVisible();
  await expect(picker.getByRole('combobox')).toHaveCount(0);
  await expect(picker.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  expect(await picker.ariaSnapshot()).not.toMatch(/Secret acquisition|Acquisition restricted|Private strategy/u);
  await page.bringToFront();
  await page.screenshot({ path: testInfo.outputPath('chooser-hidden-from-other-tab.png'), animations: 'disabled' });
  await picker.getByRole('button', { name: '关闭', exact: true }).click();
  await page.bringToFront();
  expect((await snapshot(page)).navigation.entries.find(entry => entry.id === placeholder.id)?.config.viewId).toBeUndefined();
  for (const entry of [direct.entry, conditional.entry]) {
    const card = tile(page, entry.id);
    await revealDesktopItem(page, card);
    await expect(card.getByRole('button', { name: '输入密码查看隐藏内容', exact: true })).toBeVisible();
    expect(await card.evaluate(element => element.outerHTML)).not.toMatch(/Secret acquisition|Private strategy|Acquisition restricted/u);
    await expect(card.locator('b:visible')).toHaveCount(0);
    expect(await card.ariaSnapshot()).not.toMatch(/Secret acquisition|Private strategy|Acquisition restricted|条便笺|当前匹配/u);
    await card.click({ button: 'right' });
    await expect(page.getByRole('menu', { name: '组件操作', exact: true })).toHaveCount(0);
  }
  await page.screenshot({ path: testInfo.outputPath('hidden-pins-desktop.png'), animations: 'disabled' });
  await search(page).fill('acquisition');
  await expect(page.getByRole('option')).toHaveCount(0);
  await search(page).press('Escape');
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const commands = page.getByRole('dialog', { name: '命令面板', exact: true });
  await commands.getByRole('combobox').fill('acquisition');
  await expect(commands.getByRole('option')).toHaveCount(0);
  await expect(commands).not.toContainText(title);
  await page.screenshot({ path: testInfo.outputPath('hidden-reference-widgets.png'), animations: 'disabled' });
});

test('navigation-only restore cannot bind an unrelated local note with a colliding ID, while complete restore binds its source note', async ({ extension }, testInfo) => {
  const source = await extension.newtab(), title = 'Source bound note';
  await createNote(source, { title, body: 'Authentic source content.' });
  const pinned = await pinNote(source, title), sourceBackup = await snapshot(source);
  const destinationSession = await extension.launch(), destination = await destinationSession.newtab();
  await createNote(destination, { title: 'Unrelated colliding local note', body: 'Do not reveal this content through the source pin.' });
  const localBackup = await snapshot(destination), colliding = structuredClone(localBackup.data);
  colliding.tools.notes[0].id = pinned.note.id;
  await restoreFile(destination, Buffer.from(JSON.stringify(colliding)), 'synthetic-colliding-note.json');
  await destination.evaluate(id => {
    const violations = [];
    const scan = () => {
      const card = document.querySelector(`[data-entry-id="${id}"]`);
      if (card && /Unrelated colliding local note|Do not reveal this content/u.test(card.textContent)) violations.push(card.textContent);
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.__pinReferenceAudit = { violations, observer };
  }, pinned.entry.id);
  const navigationOnly = Buffer.from(zipSync(sourceBackup.files));
  await restoreFile(destination, navigationOnly, 'synthetic-reference-navigation.zip');
  const missing = tile(destination, pinned.entry.id);
  await expect(missing).toContainText(/已删除|已移除|失效|不可用/u);
  await expect(missing).not.toContainText('Unrelated colliding local note');
  await expect(missing).not.toContainText('Do not reveal this content');
  const isolated = await snapshot(destination);
  expect(isolated.tools.notes.find(note => note.id === pinned.note.id)?.title).toBe('Unrelated colliding local note');
  expect(isolated.navigation.entries.find(entry => entry.id === pinned.entry.id)?.config.noteId).not.toBe(pinned.note.id);
  await restoreFile(destination, sourceBackup.buffer, 'synthetic-complete-reference.json');
  await expect(tile(destination, pinned.entry.id)).toContainText(title);
  await expect(tile(destination, pinned.entry.id)).toContainText('Authentic source content.');
  await tile(destination, pinned.entry.id).locator('[data-widget-launcher]').click();
  const dialog = destination.getByRole('dialog', { name: '便笺', exact: true });
  await expect(dialog.getByLabel('便笺名称', { exact: true })).toHaveValue(title);
  await expect(editor(dialog)).toContainText('Authentic source content.');
  expect(await destination.evaluate(() => {
    window.__pinReferenceAudit.observer.disconnect();
    return window.__pinReferenceAudit.violations;
  })).toEqual([]);
  await destination.screenshot({ path: testInfo.outputPath('complete-reference-restored.png'), animations: 'disabled' });
});

test('pin actions and bound cards remain translated in eight languages at a narrow viewport', async ({ extension }, testInfo) => {
  const page = await extension.newtab(), title = 'Multilingual project';
  await createNote(page, { title, body: 'Portable project evidence.' });
  const pinned = await pinNote(page, title);
  await saveView(page, 'Multilingual view', 'type:note');
  const view = await pinView(page, 'Multilingual view');
  const languages = [['zh-CN', '简体中文'], ['en', 'English'], ['zh-TW', '繁體中文'], ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['ru', 'Русский']];
  let current = 'zh-CN';
  for (const [locale, label] of languages) {
    await page.getByRole('button', { name: t('打开设置', current), exact: true }).click();
    const settings = page.getByRole('dialog', { name: t('设置', current), exact: true });
    await settings.getByRole('tab', { name: t('外观', current), exact: true }).click();
    await settings.locator('.language-setting').getByRole('combobox').click();
    await settings.getByRole('option', { name: label, exact: true }).click();
    current = locale;
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await page.getByRole('dialog', { name: t('设置', locale), exact: true }).getByRole('button', { name: t('关闭', locale), exact: true }).click();
    await page.getByRole('combobox', { name: t('搜索或输入网址', locale), exact: true }).fill(title);
    await page.getByRole('option').filter({ hasText: title }).click();
    const note = page.getByRole('dialog', { name: t('便笺', locale), exact: true });
    await note.getByRole('button', { name: t('固定到桌面', locale), exact: true }).click();
    const pin = page.getByRole('dialog', { name: t('固定到桌面', locale), exact: true });
    await page.setViewportSize({ width: 390, height: 540 });
    await expect(pin.getByRole('combobox', { name: t('目标桌面', locale), exact: true })).toBeEnabled();
    await expect.poll(() => pin.evaluate(dialog => dialog.contains(document.activeElement)), {
      message: 'the loaded pin dialog must own keyboard focus before any user field interaction',
    }).toBe(true);
    await expect(pin.getByRole('button', { name: t('固定', locale), exact: true })).toBeEnabled();
    const bounds = await pin.evaluate(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, viewport: innerWidth, width: element.clientWidth, scrollWidth: element.scrollWidth }; });
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport + 1);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1);
    await page.screenshot({ path: testInfo.outputPath(`pin-${locale}-390x540.png`), animations: 'disabled' });
    await pin.getByRole('button', { name: t('取消', locale), exact: true }).click();
    await expect(note.getByRole('button', { name: t('固定到桌面', locale), exact: true })).toBeFocused();
    if (await note.isVisible()) await note.getByRole('button', { name: t('关闭', locale), exact: true }).click();
    await expect(tile(page, pinned.entry.id)).toContainText(title);
    await expect(tile(page, view.entry.id)).toContainText('Multilingual view');
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});
