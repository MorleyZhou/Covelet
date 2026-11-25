// Installed Chrome, native CDP input, actual browser tabs and production UI.
// No Playwright, provider credentials, R2 or WebDAV are used in this test.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { startRecordMergeBrowser, delay } from './verify-record-merge-browsers.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url)), output = path.resolve(appRoot, '../output/playwright/covelet/browser-command');
const catalog = JSON.parse(await readFile(path.join(appRoot, 'src/i18n/catalog.json'), 'utf8'));
const receipt = { format: 'covelet-browser-command-native-verification', version: 1, startedAt: new Date().toISOString(),
  method: 'Installed Chrome in an isolated profile; real extension UI and CDP native mouse/keyboard input. No Playwright.',
  instrumentation: ['Only the test-owned extension copy pregrants optional tabs/history/bookmarks to avoid OS permission-doorhanger automation; production manifest keeps them optional.',
    'Thirty real pages are served by one process-local HTTP fixture. The harness seeds one bookmark and closes only fixture tabs after proving save leaves them open.',
    'IME guards use injected DOM composition events with native CDP keys; this is not OS input-method acceptance.'], stages: [], checks: {} };
let browser, server, artifact, profile, origin, appTabId, windowId, stage = 'prepare';
const prefix = `case-${Date.now()}`, title = 'COVELET Native30 session', renamed = 'COVELET 本机会话重命名';
const at = value => { stage = value; receipt.stages.push(value); console.log(JSON.stringify({ stage: value })); };
const evaluate = expression => browser.evaluate(expression);
async function wait(expression, label, timeout = 30000) {
  const until = Date.now() + timeout;
  do { if (await evaluate(expression)) return; await delay(100); } while (Date.now() < until);
  throw Error(`Native command UI timed out: ${label}`);
}
async function key(value, code, number) {
  for (const type of ['keyDown', 'keyUp']) await browser.cdp.send('Input.dispatchKeyEvent', { type, key: value, code, windowsVirtualKeyCode: number, nativeVirtualKeyCode: number }, browser.pageSessionId);
  await delay(80);
}
async function click(expression) {
  const point = await evaluate(`(()=>{const e=(${expression});if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  assert(point, 'Enabled native input target exists');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await browser.cdp.send('Input.dispatchMouseEvent', { type, ...point, ...(type !== 'mouseMoved' && { button: 'left', clickCount: 1 }) }, browser.pageSessionId);
  await delay(150);
}
const byText = (text, selector = 'button', scope = 'document') => `Array.from((${scope}).querySelectorAll(${JSON.stringify(selector)})).find(e=>e.getAttribute('aria-label')===${JSON.stringify(text)}||e.textContent.trim()===${JSON.stringify(text)})`;
async function button(text, scope = 'document') {
  const expression = byText(text, 'button', scope); await wait(`Boolean((${expression})&&!(${expression}).disabled)`, text); await click(expression);
}
async function fill(selector, value) {
  await wait(`Boolean(document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled)`, selector);
  await click(`document.querySelector(${JSON.stringify(selector)})`);
  for (const type of ['keyDown', 'keyUp']) await browser.cdp.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, browser.pageSessionId);
  await browser.cdp.send('Input.insertText', { text: value }, browser.pageSessionId);
  await wait(`document.querySelector(${JSON.stringify(selector)})?.value===${JSON.stringify(value)}`, 'native text retained');
}
async function chinese() {
  const locale = await evaluate('document.documentElement.lang'); if (locale === 'zh-CN') return;
  const translated = value => catalog[value]?.[locale] || catalog[value]?.en || value;
  await button(translated('打开设置')); await click('document.querySelector("#settings-tab-appearance")');
  await click('document.querySelector(".language-setting [role=combobox]")'); await click(byText('简体中文', '[role=option]'));
  await wait('document.documentElement.lang==="zh-CN"', 'Chinese language'); await button('关闭', 'document.querySelector(".settings-modal")');
}
async function palette(source = 'content') {
  if (!await evaluate('Boolean(document.querySelector(".command-palette"))')) await button('命令面板');
  await wait('Boolean(document.querySelector(".command-source select"))', 'source selector'); await sourceSelect(source);
}
async function sourceSelect(value) {
  const index = await evaluate(`Array.from(document.querySelector('.command-source select').options).findIndex(e=>e.value===${JSON.stringify(value)})`); assert(index >= 0);
  await click('document.querySelector(".command-source select")'); await key('Home', 'Home', 36);
  for (let n = 0; n < index; n++) await key('ArrowDown', 'ArrowDown', 40);
  await key('Enter', 'Enter', 13); await wait(`document.querySelector('.command-source select')?.value===${JSON.stringify(value)}`, `source ${value}`);
}
const sessionScope = 'document.querySelector(".browser-sessions")';
async function fixtureTabs() {
  return evaluate(`chrome.tabs.query({windowId:${windowId}}).then(tabs=>tabs.filter(tab=>tab.url?.startsWith(${JSON.stringify(`${origin}/${prefix}/tab/`)})).map(({id,url,title,pinned,active,status})=>({id,url,title,pinned,active,status})))`);
}
async function totalTabs() { return evaluate(`chrome.tabs.query({windowId:${windowId}}).then(tabs=>tabs.length)`); }
async function returnToApp() { await evaluate(`chrome.tabs.update(${appTabId},{active:true})`); await browser.cdp.send('Page.bringToFront', {}, browser.pageSessionId); }
async function firstSession() { await wait('Boolean(document.querySelector(".browser-session-record"))', 'saved session'); }
async function restorePreview() { await button('预览恢复', 'document.querySelector(".browser-session-record")'); await wait('Boolean(document.querySelector(".browser-session-restore"))', 'restore preview'); }
async function cancelPreview() { await button('关闭恢复预览', 'document.querySelector(".browser-session-restore")'); await wait('!document.querySelector(".browser-session-restore")', 'preview cancellation'); }
async function permissionProbe({ ui = false } = {}) {
  const artifact = await mkdtemp(path.join(output, 'permission-probe-')); let probe;
  try {
    await cp(path.join(appRoot, 'dist/extension'), artifact, { recursive: true });
    const manifestPath = path.join(artifact, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.optional_permissions = [...new Set([...(manifest.optional_permissions || []), 'tabs', 'history', 'bookmarks'])];
    for (const value of ['tabs', 'history', 'bookmarks']) assert(!manifest.permissions.includes(value));
    await writeFile(manifestPath, JSON.stringify(manifest));
    await build({ stdin: { contents: `import {browserCommandPermissions} from ${JSON.stringify(path.join(appRoot, 'src/lib/browser-command.js'))};globalThis.__commandPermissions=async()=>Object.fromEntries(await Promise.all(['tabs','history','bookmarks'].map(async source=>[source,await browserCommandPermissions(source)])));`, resolveDir: appRoot },
      outfile: path.join(artifact, 'permission-probe.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', define: { 'import.meta.env': '{}' }, logLevel: 'silent',
      plugins: [{ name: 'permission-probe-local-wasm', setup(plugin) {
        plugin.onResolve({ filter: /\.wasm\?url$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]), namespace: 'local-wasm' }));
        plugin.onLoad({ filter: /.*/, namespace: 'local-wasm' }, async args => { const name = `probe-${path.basename(args.path)}`; await cp(args.path, path.join(artifact, name)); return { contents: `export default chrome.runtime.getURL(${JSON.stringify(name)});`, loader: 'js' }; });
      } }] });
    probe = await startRecordMergeBrowser('chrome', { output, extensionRoot: artifact, headless: false }); browser = probe;
    await evaluate("import(chrome.runtime.getURL('permission-probe.js'))");
    const statuses = await evaluate('__commandPermissions()');
    for (const source of ['tabs', 'history', 'bookmarks']) assert.deepEqual(statuses[source], { available: true, granted: false, permission: source });
    const result = { statuses, namespace: await evaluate('({tabs:typeof chrome.tabs?.query,history:typeof chrome.history?.search,bookmarks:typeof chrome.bookmarks?.search})'), contentQueried: false, granted: false };
    if (ui) {
      await chinese();
      for (const source of ['tabs', 'history', 'bookmarks']) { await palette(source); await wait('Array.from(document.querySelectorAll(".command-source-notice button")).some(e=>e.textContent.trim()==="授权此来源")', `${source} explicit grant button`); }
      result.afterSelectingSources = await evaluate('__commandPermissions()');
      for (const source of ['tabs', 'history', 'bookmarks']) assert.equal(result.afterSelectingSources[source].granted, false);
      await probe.screenshot('ungranted-source-permission.png'); result.productionUiAuthorizationButtons = true;
    }
    await writeFile(path.join(output, 'permission-availability.json'), JSON.stringify(result, null, 2)); return result;
  } finally {
    await probe?.close(); browser = undefined;
    const actual = await realpath(artifact), relative = path.relative(await realpath(output), actual);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith('permission-probe-')) throw Error('Unsafe permission probe cleanup');
    await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
try {
  await mkdir(output, { recursive: true });
  at('ungranted-browser-permission-availability');
  receipt.ungrantedPermissionProbe = await permissionProbe({ ui: !process.argv.includes('--permissions-only') });
  receipt.checks.ungrantedSourcesOfferExplicitAuthorization = true;
  if (process.argv.includes('--permissions-only')) { receipt.result = 'permissions-probe-passed'; at('permissions-probe-passed'); }
  else {
  const requests = []; server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    const match = new RegExp(`^/${prefix}/tab/(\\d{2})$`, 'u').exec(request.url);
    response.writeHead(match ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(match ? `<!doctype html><title>COVELET QA Tab ${match[1]}</title><p>Native tab ${match[1]} fixture.</p>` : '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  artifact = await mkdtemp(path.join(output, 'browser-command-build-')); await cp(path.join(appRoot, 'dist/extension'), artifact, { recursive: true });
  const manifestPath = path.join(artifact, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const permission of ['tabs', 'history', 'bookmarks']) { assert(manifest.optional_permissions.includes(permission)); assert(!manifest.permissions.includes(permission)); }
  receipt.productionRequiredPermissions = [...manifest.permissions];
  manifest.permissions.push('tabs', 'history', 'bookmarks'); manifest.optional_permissions = manifest.optional_permissions.filter(value => !['tabs', 'history', 'bookmarks'].includes(value));
  await writeFile(manifestPath, JSON.stringify(manifest));
  at('native-extension-setup'); browser = await startRecordMergeBrowser('chrome', { output, extensionRoot: artifact, headless: false, preserveProfile: true }); profile = browser.profile;
  receipt.browserVersion = browser.browserVersion; await chinese();
  ({ id: appTabId, windowId } = await evaluate('chrome.tabs.getCurrent().then(({id,windowId})=>({id,windowId}))'));
  at('create-thirty-real-test-tabs');
  for (let n = 1; n <= 30; n++) await evaluate(`chrome.tabs.create({windowId:${windowId},url:${JSON.stringify(`${origin}/${prefix}/tab/${String(n).padStart(2, '0')}`)},active:false,pinned:${n <= 2}})`);
  await wait(`chrome.tabs.query({windowId:${windowId}}).then(tabs=>{const rows=tabs.filter(t=>t.url?.startsWith(${JSON.stringify(`${origin}/${prefix}/tab/`)}));return rows.length===30&&rows.every(t=>t.status==='complete'&&t.title.startsWith('COVELET QA Tab '));})`, 'thirty loaded real tabs');
  await evaluate(`chrome.bookmarks.create({title:'COVELET QA Bookmark',url:${JSON.stringify(`${origin}/${prefix}/tab/01`)}})`);

  at('browser-search-and-native-keyboard'); await palette('tabs'); await fill('.command-palette input[role=combobox]', 'COVELET QA Tab');
  await wait('document.querySelectorAll(".command-result").length===30', 'tab search thirty results');
  const beforeIme = await evaluate('document.querySelector(".command-palette input[role=combobox]").getAttribute("aria-activedescendant")');
  await evaluate('document.querySelector(".command-palette input[role=combobox]").dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:"中"}))');
  await key('ArrowDown', 'ArrowDown', 40); await key('Enter', 'Enter', 13); await key('Escape', 'Escape', 27);
  assert.equal(await evaluate('Boolean(document.querySelector(".command-palette"))'), true);
  assert.equal(await evaluate('document.querySelector(".command-palette input[role=combobox]").getAttribute("aria-activedescendant")'), beforeIme);
  assert.equal(await evaluate(`chrome.tabs.get(${appTabId}).then(t=>t.active)`), true);
  await evaluate('document.querySelector(".command-palette input[role=combobox]").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"中"}))');
  await key('ArrowDown', 'ArrowDown', 40); const selectedUrl = await evaluate('document.querySelector(".command-result[aria-selected=true] small").textContent');
  await key('Enter', 'Enter', 13); await wait('!document.querySelector(".command-palette")', 'Enter switches and closes');
  assert.equal((await fixtureTabs()).find(tab => tab.url === selectedUrl).active, true); await returnToApp();
  receipt.checks.nativeTabSearchSwitchAndImeGuards = true;

  await palette('tabs'); await fill('.command-palette input[role=combobox]', 'COVELET QA Tab 30'); await wait('document.querySelectorAll(".command-result").length===1', 'one tab search');
  const closed = (await fixtureTabs()).find(tab => tab.url.endsWith('/30')); await click('document.querySelector(".command-tab-close")');
  await wait(`chrome.tabs.query({windowId:${windowId}}).then(t=>t.every(t=>t.id!==${closed.id}))`, 'explicit tab closed');
  assert.equal((await fixtureTabs()).length, 29);
  await evaluate(`chrome.tabs.create({windowId:${windowId},url:${JSON.stringify(closed.url)},active:false})`);
  await sourceSelect('history'); await fill('.command-palette input[role=combobox]', 'COVELET QA Tab 01'); await wait('document.querySelectorAll(".command-result").length>=1', 'native history result');
  await sourceSelect('bookmarks'); await fill('.command-palette input[role=combobox]', 'COVELET QA Bookmark'); await wait('document.querySelectorAll(".command-result").length===1', 'native bookmark result');
  receipt.checks.nativeHistoryBookmarksAndSeparateTabClose = true;

  at('capture-thirty-tabs-without-closing-originals'); await fill('.command-palette input[role=combobox]', ''); await sourceSelect('sessions');
  await button('保存当前窗口', sessionScope); await fill('.browser-session-form input[aria-label="会话名称"]', title); await button('预览当前窗口', sessionScope);
  await wait('document.querySelectorAll(".browser-session-form .browser-session-tab-preview li").length===30', 'capture thirty');
  await button('确认保存会话', sessionScope); await firstSession(); assert.equal((await fixtureTabs()).length, 30);
  receipt.checks.saveLeavesThirtyOriginalTabsOpen = true;

  at('cancel-preview-and-deduplicate-already-open-tabs'); const allBefore = await totalTabs();
  await click('document.querySelector(".command-palette input[role=combobox]")'); await key('ArrowDown', 'ArrowDown', 40); await key('Enter', 'Enter', 13);
  await wait('Boolean(document.querySelector(".browser-session-restore"))', 'session main-input keyboard preview');
  assert.equal(await totalTabs(), allBefore); receipt.checks.sessionKeyboardOpensPreviewWithoutCreating = true;
  await wait('document.querySelector(".browser-session-restore")?.textContent.includes("会话恢复已完成。")', 'existing thirty deduplicated');
  await cancelPreview(); assert.equal(await totalTabs(), allBefore);
  receipt.checks.cancelPreviewAndExistingDedupCreateZero = true;
  const originals = await fixtureTabs(); assert.equal(originals.length, 30);
  // Test setup closes only IDs whose current URL and window match this fixture.
  for (const tab of originals) await evaluate(`chrome.tabs.get(${tab.id}).then(t=>{if(t.windowId!==${windowId}||t.url!==${JSON.stringify(tab.url)})throw Error('Test tab identity changed');return chrome.tabs.remove(t.id);})`);
  assert.equal((await fixtureTabs()).length, 0);
  await restorePreview(); const beforeCancelEmpty = await totalTabs(); await cancelPreview(); assert.equal(await totalTabs(), beforeCancelEmpty);

  at('explicit-three-batches-of-ten-inactive-tabs'); await restorePreview();
  for (let batch = 1; batch <= 3; batch++) {
    await button(batch === 1 ? '确认恢复，打开第一批' : '继续下一批', 'document.querySelector(".browser-session-restore")');
    await wait(`chrome.tabs.query({windowId:${windowId}}).then(t=>t.filter(t=>t.url?.startsWith(${JSON.stringify(`${origin}/${prefix}/tab/`)})).length===${batch * 10})`, `batch ${batch} exact ten`);
    const rows = await fixtureTabs(); assert.equal(rows.length, batch * 10); assert(rows.every(tab => tab.active === false));
    assert.equal(await evaluate(`chrome.tabs.get(${appTabId}).then(t=>t.active)`), true);
  }
  await wait('document.querySelector(".browser-session-restore")?.textContent.includes("会话恢复已完成。")', 'three batches complete');
  const restored = await fixtureTabs(); assert.deepEqual(restored.map(tab => tab.url).sort(), originals.map(tab => tab.url).sort()); assert.equal(restored.filter(tab => tab.pinned).length, 2);
  await browser.screenshot('restored-thirty.png'); await cancelPreview();
  const beforeRepeat = await totalTabs(); await restorePreview(); await wait('document.querySelector(".browser-session-restore")?.textContent.includes("会话恢复已完成。")', 'repeat dedup'); await cancelPreview(); assert.equal(await totalTabs(), beforeRepeat);
  receipt.checks.threeExplicitTenTabBatchesInactivePinnedAndDuplicateSafe = true;

  at('native-session-rename-and-restart'); await button('重命名', 'document.querySelector(".browser-session-record")'); await fill('.browser-session-rename input', renamed);
  await evaluate('document.querySelector(".browser-session-rename input").dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:"中"}))');
  await key('Enter', 'Enter', 13); assert.equal(await evaluate('Boolean(document.querySelector(".browser-session-rename"))'), true);
  await evaluate('document.querySelector(".browser-session-rename input").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"中"}))');
  await button('保存名称', sessionScope);
  await wait(`document.querySelector('.browser-session-summary strong')?.textContent===${JSON.stringify(renamed)}`, 'renamed');
  await browser.close(); browser = undefined;
  browser = await startRecordMergeBrowser('chrome', { output, extensionRoot: artifact, headless: false, existingProfile: profile, preserveProfile: true });
  ({ id: appTabId, windowId } = await evaluate('chrome.tabs.getCurrent().then(({id,windowId})=>({id,windowId}))'));
  await chinese(); await palette('sessions'); await firstSession();
  assert.equal(await evaluate('document.querySelector(".browser-session-summary strong").textContent'), renamed);
  receipt.checks.sessionRenamePersistsAcrossRestart = true;
  at('native-confirmed-session-delete'); const beforeDeleteCount = await totalTabs(); await button('删除', 'document.querySelector(".browser-session-record")'); await wait('Boolean(document.querySelector(".prompt-dialog"))', 'delete confirmation');
  await button('删除', 'document.querySelector(".prompt-dialog")'); await wait('document.querySelectorAll(".browser-session-record").length===0', 'session deleted');
  assert.equal(await totalTabs(), beforeDeleteCount);
  receipt.checks.explicitSessionDelete = true; receipt.fixture = { pages: 30, testOnlyHttpServer: true, requests: requests.length };
  receipt.result = 'passed'; at('passed');
  }
} catch (error) {
  receipt.result = 'failed'; receipt.failureStage = stage; receipt.failure = String(error.message).slice(0, 1600); process.exitCode = 1;
  console.error(JSON.stringify({ stage, message: receipt.failure })); try { await browser?.screenshot('failure.png'); } catch {}
} finally {
  try { await browser?.close(); } catch { (receipt.cleanup ||= []).push('BROWSER_CLOSE_FAILED'); }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const [candidate, prefix] of [[profile, 'raw-record-merge-profile-chrome-'], [artifact, 'browser-command-build-']]) if (candidate) {
    try { const actual = await realpath(candidate), root = await realpath(output), relative = path.relative(root, actual);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith(prefix)) throw Error('Unsafe browser command test cleanup');
      await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) { if (error.code !== 'ENOENT') (receipt.cleanup ||= []).push('OWNED_DIRECTORY_CLEANUP_FAILED'); }
  }
  receipt.finishedAt = new Date().toISOString(); await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'native.json'), JSON.stringify(receipt, null, 2));
}
