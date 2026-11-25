// Native Firefox equivalent acceptance after Playwright's explicit WebExtension
// page-agent exclusion. No task-specific browser patch, web-page substitute or DAV.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { launchFirefoxMarionette, removeFirefoxProfile } from './lib/firefox-marionette-harness.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url)), output = path.resolve(appRoot, '../output/playwright/covelet/firefox');
const catalog = JSON.parse(await readFile(path.join(appRoot, 'src/i18n/catalog.json'), 'utf8'));
const backupPassword = randomBytes(24).toString('base64url'), devices = [], profiles = new Set();
const receipt = { format: 'covelet-firefox-native-core-verification', version: 1, startedAt: new Date().toISOString(),
  method: 'Official Playwright bundled Firefox157 (build1555), unchanged by this task; native Marionette addon installation and WebDriver element clicks/keys on actual moz-extension pages.',
  playwright: { result: 'blocked', code: 'PLAYWRIGHT_FIREFOX_EXTENSIONS_UNSUPPORTED', report: 'playwright-core.json' },
  webdav: { result: 'waived', reason: 'User explicitly deferred all WebDAV tests; this run issues no WebDAV request.' },
  limitations: ['Native automation acceptance; not human manual acceptance or a Playwright core pass.',
    'Only the isolated copy declares one loopback article origin; Firefox native permission storage grants that exact test origin. Native permission-doorhanger acceptance is separate.',
    'Temporary reinstall verifies durable local data, not signed AMO installation or upgrade.'], stages: [], checks: {} };
let artifact, server, articleOrigin, stage = 'prepare', marker = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const at = value => { stage = value; receipt.stages.push(value); console.log(JSON.stringify({ stage: value })); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function until(page, predicate, arg, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do { if (await page.evaluate(predicate, arg)) return; await delay(100); } while (Date.now() < deadline);
  throw Error(`Native Firefox UI timed out: ${label}`);
}
async function target(page, { scope = 'body', selector = 'button', text, mode = 'text' }) {
  const id = `target-${++marker}`, input = { scope, selector, text, mode, id };
  const identify = value => {
    const visible = element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && !element.disabled;
    const elements = [...(document.querySelector(value.scope)?.querySelectorAll(value.selector) || [])];
    const element = elements.find(element => visible(element) && (value.mode === 'command' ? element.querySelector('strong')?.textContent.trim() === value.text
      : element.getAttribute('aria-label') === value.text || element.textContent.trim() === value.text));
    if (!element) return false; element.setAttribute('data-firefox-qa-target', value.id); return true;
  };
  await until(page, identify, input, `enabled ${text}`); return `[data-firefox-qa-target="${id}"]`;
}
async function clickText(page, text, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await page.click(await target(page, { text, ...options })); await delay(180); return; }
    catch (error) { if (!String(error.code || error.message).includes('intercepted') || !await dismissIconFallback(page)) throw error; }
  }
  throw Error(`Native click remained obscured: ${text}`);
}
async function dialog(page, title) {
  const id = `dialog-${++marker}`;
  await until(page, ({ title, id }) => {
    const element = [...document.querySelectorAll('[role="dialog"]')].find(element => {
      const labelled = (element.getAttribute('aria-labelledby') || '').split(/\s+/u).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
      return element.getBoundingClientRect().width > 0 && (element.getAttribute('aria-label') === title || labelled === title || element.querySelector('h1,h2,h3')?.textContent.trim() === title);
    });
    if (!element) return false; element.setAttribute('data-firefox-qa-dialog', id); return true;
  }, { title, id }, title); return `[data-firefox-qa-dialog="${id}"]`;
}
async function fillLabel(page, label, value, scope = 'body') {
  const id = `input-${++marker}`;
  await until(page, ({ scope, label, id }) => {
    const element = [...(document.querySelector(scope)?.querySelectorAll('input,textarea') || [])].find(input => input.getBoundingClientRect().width > 0 && !input.disabled
      && (input.getAttribute('aria-label') === label || [...(input.labels || [])].some(node => node.textContent.trim() === label)));
    if (!element) return false; element.setAttribute('data-firefox-qa-target', id); return true;
  }, { scope, label, id }, label);
  const selector = `[data-firefox-qa-target="${id}"]`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.click(selector); await page.fill(selector, value); await delay(100);
    if (await page.evaluate(({ selector, value }) => document.querySelector(selector)?.value === value, { selector, value })) return;
  }
  throw Error(`Native field did not retain entered text: ${label}`);
}
async function closeDialog(page, title) {
  const scope = await dialog(page, title); await clickText(page, '关闭', { scope });
  await until(page, selector => !document.querySelector(selector), scope, `${title} close`);
}
async function chinese(page) {
  await page.waitFor('.owntab'); const locale = await page.evaluate(() => document.documentElement.lang);
  if (locale === 'zh-CN') return;
  const translated = source => catalog[source]?.[locale] || catalog[source]?.en || source;
  await clickText(page, translated('打开设置')); await page.click('#settings-tab-appearance');
  await page.click('.language-setting [role="combobox"]'); await clickText(page, '简体中文', { selector: '[role="option"]' });
  await until(page, () => document.documentElement.lang === 'zh-CN', null, 'saved Chinese language'); await closeDialog(page, '设置');
}
async function command(page, label) {
  await dismissIconFallback(page);
  await clickText(page, '命令面板'); await page.waitFor('.command-palette input'); await delay(150);
  await clickText(page, label === '便笺' ? '新便笺' : label, { selector: '.command-result', mode: 'command' });
}
async function dismissIconFallback(page) {
  const expected = await page.evaluate(() => [...document.querySelectorAll('.prompt-dialog')].some(element => element.textContent.includes('无法获取图片，请检查网络或网站访问权限。')));
  if (expected) {
    await clickText(page, '关闭', { scope: '.prompt-dialog' });
    await until(page, () => !document.querySelector('.prompt-dialog'), null, 'expected image permission prompt closed');
    receipt.iconPermissionFallbacks = (receipt.iconPermissionFallbacks || 0) + 1;
  }
  const toast = await page.evaluate(() => document.querySelector('.toast.error')?.textContent.includes('无法获取图片，请检查网络或网站访问权限。'));
  if (toast) {
    try { await page.click('.toast.error button[aria-label="关闭提示"]'); }
    catch (error) { if (!String(error.code || error.message).includes('intercepted')) throw error; }
    await until(page, () => !document.querySelector('.toast.error'), null, 'expected image permission notice dismissed', 9000);
  }
  return expected || toast;
}
async function addSite(page, title, url) {
  await clickText(page, '添加网站'); const scope = await dialog(page, '添加网站');
  await fillLabel(page, '网址', url, scope); await fillLabel(page, '名称', title, scope); await clickText(page, '添加', { scope });
  await until(page, selector => !document.querySelector(selector), scope, 'site editor closed');
  await until(page, title => [...document.querySelectorAll('.site-name')].some(element => element.textContent === title), title, 'saved navigation');
  await delay(300); await dismissIconFallback(page);
}
async function note(page, title, body, existing = false) {
  await command(page, '便笺'); const scope = await dialog(page, '便笺');
  if (existing) await clickText(page, title, { scope, selector: '.tool-record-list button', mode: 'command' }); else await clickText(page, '新便笺', { scope });
  await fillLabel(page, '便笺名称', title, scope); await page.fill(`${scope} .folio-note-editor [contenteditable="true"]`, body);
  await clickText(page, '保存', { scope });
  await until(page, scope => [...document.querySelector(scope).querySelectorAll('button')].some(button => button.textContent.trim() === '保存' && button.disabled), scope, 'saved note');
  await closeDialog(page, '便笺');
}
async function recovery(page) {
  await clickText(page, '打开设置'); await page.click('#settings-tab-backup');
  await page.waitFor('.recovery-center'); return '.recovery-center';
}
async function downloaded(device, before) {
  const deadline = Date.now() + 30000;
  do {
    const files = (await readdir(device.downloads)).filter(name => !before.has(name) && !name.endsWith('.part'));
    for (const filename of files) {
      const candidate = path.join(device.downloads, filename); try { const bytes = await readFile(candidate); if (bytes.length) return { filename, bytes, path: candidate }; } catch {}
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw Error('Native Firefox backup download timed out');
}
const parseBackup = bytes => { const data = JSON.parse(bytes), files = unzipSync(Buffer.from(data.navigation, 'base64')); return { data, tools: data.tools, navigation: JSON.parse(strFromU8(files['data.json'])) }; };
async function exportBackup(device, page, encrypted = false) {
  const scope = await recovery(page), before = new Set(await readdir(device.downloads));
  if (encrypted) {
    await clickText(page, '加密导出', { scope }); await fillLabel(page, '备份密码', backupPassword, scope); await fillLabel(page, '确认备份密码', backupPassword, scope);
    await clickText(page, '加密并下载', { scope });
  } else await clickText(page, '导出备份', { scope });
  const result = await downloaded(device, before); await closeDialog(page, '设置'); return { ...result, ...(encrypted ? {} : parseBackup(result.bytes)) };
}
async function restoreBackup(page, filename, encrypted = false) {
  const scope = await recovery(page);
  // The browser's actual hidden picker input receives the file via native
  // ElementSendKeys, exactly as ordinary WebDriver file-upload automation.
  await page.setFiles(`${scope} input[type="file"]`, filename);
  if (encrypted) { await fillLabel(page, '备份密码', backupPassword, scope); await clickText(page, '解锁并预览', { scope }); }
  await until(page, scope => Boolean(document.querySelector(`${scope} .recovery-preview`)), scope, 'backup restore preview');
  await clickText(page, '确认恢复', { scope });
  await until(page, scope => document.querySelector(scope)?.textContent.includes('恢复完成。'), scope, 'backup restored'); await closeDialog(page, '设置');
}
async function rejectWrongBackupPassword(device, page, filename) {
  const before = await exportBackup(device, page), scope = await recovery(page);
  await page.setFiles(`${scope} input[type="file"]`, filename);
  await fillLabel(page, '备份密码', `${backupPassword}-incorrect`, scope); await clickText(page, '解锁并预览', { scope });
  await until(page, scope => document.querySelector(`${scope} .form-error`)?.textContent.includes('密码不正确，或加密备份已损坏。'), scope, 'wrong encrypted-backup password rejected');
  assert.equal(await page.evaluate(scope => Boolean(document.querySelector(`${scope} .recovery-preview`)), scope), false);
  await closeDialog(page, '设置'); const after = await exportBackup(device, page);
  assert.deepEqual(after.navigation, before.navigation); assert.deepEqual(after.tools, before.tools);
  receipt.checks.wrongEncryptedBackupPasswordPreservesLocal = true;
}
async function inspectEncrypted(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('covelet.encrypted.local.v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const transaction = db.transaction(['records', 'keys'], 'readonly'), read = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const [records, key] = await Promise.all([read(transaction.objectStore('records').getAll()), read(transaction.objectStore('keys').get('device-key-v1'))]);
      return { count: records.length, extractable: key.extractable, algorithm: key.algorithm.name, length: key.algorithm.length,
        ciphertextOnly: records.every(record => Object.keys(record).sort().join(',') === 'ciphertext,id,iv,space,version' && /^[a-f0-9]{64}$/u.test(record.id) && record.iv.byteLength === 12) };
    } finally { db.close(); }
  });
}
async function launch(profile) {
  const device = await launchFirefoxMarionette({ extensionRoot: artifact, output, profile, headless: process.env.COVELET_FIREFOX_HEADED !== '1' }); devices.push(device); profiles.add(device.profile);
  await device.command('Marionette:SetContext', { value: 'chrome' });
  try {
    await device.command('WebDriver:ExecuteScript', { script: 'return (async()=>{const {ExtensionPermissions}=ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");const policy=WebExtensionPolicy.getByID(arguments[0]);await ExtensionPermissions.add(arguments[0],{permissions:[],origins:[arguments[1]]},policy.extension);return true;})();', args: [device.addonId, `${articleOrigin}/*`] });
  } finally { await device.command('Marionette:SetContext', { value: 'content' }); }
  return device;
}
try {
  await mkdir(output, { recursive: true });
  const articleRequests = []; server = createServer((request, response) => {
    articleRequests.push({ method: request.method, path: request.url });
    if (request.url !== '/article' || request.method !== 'GET') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><title>Firefox local article</title><article><h1>Firefox reading</h1><p>This local reading paragraph provides enough text for the article parser and includes firefoxreadingsentinel. The plain readable article is served by an isolated process for native Firefox acceptance.</p></article>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); articleOrigin = `http://127.0.0.1:${server.address().port}`;
  artifact = await mkdtemp(path.join(output, 'firefox-extension-')); await cp(path.join(appRoot, 'dist/extension-firefox'), artifact, { recursive: true });
  const manifestPath = path.join(artifact, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage', 'search', 'activeTab', 'scripting', 'alarms']); manifest.host_permissions.push('http://127.0.0.1/*'); await writeFile(manifestPath, JSON.stringify(manifest));
  at('native-temporary-addon-and-real-newtab'); let a = await launch(), pageA = await a.newtab(); await chinese(pageA);
  receipt.browserVersion = a.browserVersion; receipt.geckoId = a.addonId;
  assert.equal(a.acceptInsecureCerts, false); receipt.acceptInsecureCerts = a.acceptInsecureCerts;
  receipt.runtime = await pageA.evaluate(() => ({ protocol: location.protocol, runtimeRoot: browser.runtime.getURL(''), locks: Boolean(navigator.locks),
    browserPromise: typeof browser.storage.local.get('probe')?.then === 'function', chromePromise: typeof chrome.storage.local.get('probe')?.then === 'function', directoryPicker: typeof showDirectoryPicker }));
  assert.equal(receipt.runtime.protocol, 'moz-extension:'); assert.equal(receipt.runtime.locks, true); assert.equal(receipt.runtime.browserPromise, true); await pageA.screenshot(path.join(output, 'native-newtab.png'));
  receipt.articlePermission = await pageA.evaluate(async origin => ({ exact: await browser.permissions.contains({ origins: [`${origin}/*`] }),
    declaredHost: await browser.permissions.contains({ origins: ['http://127.0.0.1/*'] }) }), articleOrigin);
  console.log(JSON.stringify({ articlePermission: receipt.articlePermission }));
  assert.equal(receipt.articlePermission.exact, true);
  receipt.checks.newtabNativeRuntime = true;
  at('native-navigation-and-note-save-edit'); await addSite(pageA, 'Firefox common site', 'https://example.invalid/firefox-common');
  await note(pageA, 'Firefox common note', 'FIREFOX-PRIVATE baseline note body');
  await note(pageA, 'Firefox common note', 'FIREFOX-PRIVATE edited note body', true);
  receipt.checks.navigationNoteCreateEdit = true;
  at('native-reader-local-body-highlight'); await command(pageA, '稍后读'); const reading = await dialog(pageA, '稍后读');
  await fillLabel(pageA, '网址', `${articleOrigin}/article`, `${reading} .reading-add-form`); await fillLabel(pageA, '名称', 'Firefox reading', `${reading} .reading-add-form`);
  await clickText(pageA, '添加', { scope: `${reading} .reading-add-form` }); await clickText(pageA, 'Firefox reading', { selector: '.reading-record-open', mode: 'command' });
  await until(pageA, () => document.querySelector('.reading-reader-article')?.textContent.includes('firefoxreadingsentinel'), null, 'native reading body');
  // DOM Range creates a deterministic selection; committing the highlight is
  // still an actual native element click, with no application API injection.
  await pageA.evaluate(() => { const element = [...document.querySelectorAll('[data-reading-block-text]')].find(element => element.textContent.includes('firefoxreadingsentinel'));
    const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await fillLabel(pageA, '批注', 'Firefox highlight persists', '.reading-reader-modal'); await clickText(pageA, '保存高亮', { scope: '.reading-reader-modal' });
  await until(pageA, () => document.querySelector('.reading-reader-annotation')?.textContent.includes('Firefox highlight persists'), null, 'saved native highlight');
  at('native-reader-markdown-download'); const beforeMarkdown = new Set(await readdir(a.downloads));
  await clickText(pageA, '导出 Markdown', { scope: '.reading-reader-modal' }); const markdown = await downloaded(a, beforeMarkdown), markdownText = markdown.bytes.toString('utf8');
  assert.match(markdown.filename, /\.md$/iu); assert.match(markdownText, /firefoxreadingsentinel/u); assert.match(markdownText, /Firefox highlight persists/u);
  assert.doesNotMatch(markdownText, /!\[[^\]]*\]\(https?:/u);
  receipt.markdown = { filename: markdown.filename, bytes: markdown.bytes.length, sha256: hash(markdown.bytes), bodySentinel: true, annotation: true, remoteImageSyntax: false };
  receipt.checks.readerMarkdownDownload = true;
  await pageA.screenshot(path.join(output, 'native-reading-highlight.png')); await clickText(pageA, '关闭', { scope: '.reading-reader-modal' }); await closeDialog(pageA, '稍后读');
  receipt.checks.readingBodyAndHighlight = true;
  at('native-html-bookmark-picker'); await command(pageA, '导入网址与书签 HTML');
  const imported = path.join(output, 'firefox-bookmarks.html'); await writeFile(imported, '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Firefox imported folder</H3><DL><p><DT><A HREF="https://example.invalid/firefox-imported">Firefox imported bookmark</A></DL><p></DL>');
  await pageA.setFiles('.bookmark-import input[type="file"]', imported); await clickText(pageA, '确认导入', { scope: '.bookmark-import' });
  await until(pageA, () => !document.querySelector('.bookmark-import'), null, 'native HTML import applied');
  const plain = await exportBackup(a, pageA), encrypted = await exportBackup(a, pageA, true);
  assert.equal(plain.data.version, 2); assert.equal(plain.tools.notes[0].body, 'FIREFOX-PRIVATE edited note body');
  assert(plain.navigation.entries.some(record => record.name === 'Firefox imported bookmark')); assert.doesNotMatch(encrypted.bytes.toString('utf8'), /FIREFOX-PRIVATE|Firefox common note/);
  receipt.checks.htmlImport = true; receipt.backup = { encryptedBytes: encrypted.bytes.length, sha256: hash(encrypted.bytes), jsonVersion: plain.data.version };
  receipt.encryptedIndexedDB = await inspectEncrypted(pageA); assert.equal(receipt.encryptedIndexedDB.ciphertextOnly, true); assert.equal(receipt.encryptedIndexedDB.extractable, false); assert.equal(receipt.encryptedIndexedDB.length, 256);
  receipt.checks.nativeEncryptedIndexedDB = true;
  at('native-encrypted-complete-backup-second-profile-restore'); let b = await launch(), pageB = await b.newtab(); await chinese(pageB);
  await rejectWrongBackupPassword(b, pageB, encrypted.path);
  await restoreBackup(pageB, encrypted.path, true); const restored = await exportBackup(b, pageB);
  assert.equal(restored.tools.notes[0].body, plain.tools.notes[0].body); assert.deepEqual(restored.navigation.entries.map(record => record.id), plain.navigation.entries.map(record => record.id));
  assert.deepEqual(restored.data.noteHistory, plain.data.noteHistory); receipt.checks.encryptedCompleteBackupRestore = true;
  at('native-version1-json-and-navigation-zip-restore'); const legacy = { ...plain.data, version: 1 }; delete legacy.noteHistory;
  const legacyPath = path.join(output, 'version-1-compatible.json'); await writeFile(legacyPath, JSON.stringify(legacy)); await restoreBackup(pageB, legacyPath);
  const afterLegacy = await exportBackup(b, pageB); assert.equal(afterLegacy.tools.notes[0].body, plain.tools.notes[0].body);
  const zipPath = path.join(output, 'navigation-compatible.zip'); await writeFile(zipPath, Buffer.from(plain.data.navigation, 'base64')); await restoreBackup(pageB, zipPath);
  const afterZip = await exportBackup(b, pageB); assert.deepEqual(afterZip.navigation.entries.map(record => record.id), plain.navigation.entries.map(record => record.id));
  receipt.checks.version1JsonAndNavigationZipRestore = true;
  at('native-browser-restart-and-temporary-reinstall-durability'); const profile = a.profile, originalOrigin = a.origin; await a.close(); devices.splice(devices.indexOf(a), 1);
  a = await launch(profile); pageA = await a.newtab(); await chinese(pageA); assert.equal(a.origin, originalOrigin);
  const restarted = await exportBackup(a, pageA); assert.equal(restarted.tools.notes[0].body, 'FIREFOX-PRIVATE edited note body');
  await command(pageA, '稍后读'); await clickText(pageA, 'Firefox reading', { selector: '.reading-record-open', mode: 'command' });
  await until(pageA, () => document.querySelector('.reading-reader-annotation')?.textContent.includes('Firefox highlight persists'), null, 'durable reader highlight');
  await pageA.screenshot(path.join(output, 'native-restarted-reader.png')); receipt.checks.restartEncryptedDurability = true;
  assert(articleRequests.length > 0); assert(articleRequests.every(request => request.method === 'GET' && request.path === '/article'));
  receipt.articleFixture = { origin: 'test-owned loopback HTTP', requests: articleRequests, productServer: false };
  receipt.result = 'passed'; at('passed');
} catch (error) {
  receipt.result = 'failed'; receipt.failureStage = stage; receipt.failure = String(error.message).slice(0, 1800); process.exitCode = 1;
  console.error(JSON.stringify({ stage, message: receipt.failure }));
  for (const [index, device] of devices.entries()) { try { const handle = await device.command('WebDriver:GetWindowHandle'); await device.page(handle).screenshot(path.join(output, `native-failure-${index}.png`)); } catch {} }
} finally {
  for (const device of devices) { try { await device.close(); } catch { (receipt.cleanup ||= []).push('BROWSER_CLOSE_FAILED'); } }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const profile of profiles) { try { await removeFirefoxProfile(profile, output); } catch { (receipt.cleanup ||= []).push('PROFILE_CLEANUP_FAILED'); } }
  if (artifact) { const actual = await realpath(artifact), relative = path.relative(await realpath(output), actual);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(actual).startsWith('firefox-extension-')) await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  receipt.finishedAt = new Date().toISOString(); await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'native-core.json'), JSON.stringify(receipt, null, 2));
}
