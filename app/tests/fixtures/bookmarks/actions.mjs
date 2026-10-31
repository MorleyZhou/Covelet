import assert from 'node:assert/strict';
import { polishScreens, keyboardDisclosure } from '../polish-screens.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default async ({ evaluate, send, delay, on, writeFile, extId, output }) => {
  const requests = [], nativeFavicons = [];
  on('Network.requestWillBeSent', ({ request }) => {
    if (/^https?:/i.test(request.url)) requests.push({ method: request.method, url: request.url });
    if (request.url.includes('/_favicon/')) nativeFavicons.push(request.url);
  });
  on('Fetch.requestPaused', async ({ requestId }) => {
    // Deny every HTTP(S) request, including unrelated startup wallpaper.
    // Tests never contact the fixture sites or a live server.
    await send('Fetch.fulfillRequest', { requestId, responseCode: 503, body: '' });
  });
  await send('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }] });
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "chrome.i18n.getUILanguage = () => 'zh-CN';" });
  const navigate = () => send('Page.navigate', { url: `chrome-extension://${extId}/newtab.html` });
  const wait = async (expression, label) => {
    for (let elapsed = 0; elapsed < 15000; elapsed += 100) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw Error(`Timed out: ${label}\n${await evaluate('document.body.innerText')}`);
  };
  const exists = (selector) => `!!document.querySelector(${JSON.stringify(selector)})`;
  const has = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
  const click = async (text) => {
    await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => (b.innerText.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)})); if (!b || b.disabled) throw Error('Missing/disabled button: ' + ${JSON.stringify(text)}); b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); b.click(); })()`);
    await delay(100);
  };
  const openImport = async () => {
    await wait('!!document.querySelector("button[title=设置]")', 'settings launcher');
    await evaluate('document.querySelector("button[title=设置]").click()');
    await delay(100);
    await click('数据');
    await click('导入网址与书签 HTML');
    await wait('!!document.querySelector(".bookmark-import")', 'bookmark importer');
  };
  const choose = async (file) => {
    const { root } = await send('DOM.getDocument');
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '.bookmark-import input[type=file]' });
    assert.ok(nodeId, 'reachable file picker');
    await send('DOM.setFileInputFiles', { nodeId, files: [file] });
    await delay(150);
  };
  const fixture = (name) => fileURLToPath(new URL(`${name}.html`, import.meta.url));
  const canApply = () => evaluate('[...document.querySelectorAll(".bookmark-import button")].find(b => b.innerText.trim() === "确认导入").disabled === false');
  const screenshot = async (name) => {
    const data = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, `${name}.png`), Buffer.from(data.data, 'base64'));
  };
  const assertLocal = (start, nativeStart) => {
    assert.deepEqual(requests.slice(start), [], 'parse, preview and apply must not request HTTP(S)');
    assert.deepEqual(nativeFavicons.slice(nativeStart), [], 'import does not acquire native favicons');
  };

  await navigate();
  await wait('!!document.querySelector("button[title=设置]")', 'initial desktop');
  await delay(500);
  const startupRequests = requests.length, nativeStart = nativeFavicons.length;
  await openImport();
  const screenTools = { evaluate, send, delay, writeFile, output };
  await keyboardDisclosure(screenTools, '导入提示');
  await polishScreens(screenTools, 'import-tips', '.bookmark-import-modal', '.bookmark-import-scroll');
  await evaluate('document.activeElement.click()');
  assert.match(await evaluate('document.querySelector(".bookmark-import").innerText'), /Chrome、Firefox 和 Edge/);

  for (const [name, content, error] of [
    ['empty', '', '书签文件为空'],
    ['not-html', '{"bookmarks":[]}', '请选择浏览器导出的书签 HTML 文件'],
    ['empty-export', '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p></DL>', '文件中没有可导入的书签'],
    ['oversized', 'x'.repeat(5 * 1024 * 1024 + 1), '书签文件不能超过 5 MB'],
  ]) {
    const file = path.join(output, `${name}.html`);
    await writeFile(file, content);
    await choose(file);
    await wait(has(error), `${name}: localized error`);
    assert.equal(await canApply(), false);
  }
  await screenshot('bad-file-zh-CN');

  await choose(fixture('chrome'));
  await wait(has('将添加 4 个网址和 4 个文件夹，跳过 1 条重复网址'), 'Chrome preview');
  assert.equal(await evaluate('document.querySelector(".bookmark-import-check button").getAttribute("aria-checked")'), 'true', 'skip existing is checked by default');
  const assertGeometry = async () => {
    assert.equal(await evaluate(`(() => { const modal = document.querySelector('.bookmark-import-modal'), footer = modal.querySelector('.modal-footer'), label = modal.querySelector('.bookmark-import-check'), box = modal.getBoundingClientRect(), action = footer.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && action.bottom <= innerHeight && action.top >= box.top && modal.scrollWidth <= modal.clientWidth + 1 && getComputedStyle(label).flexDirection === 'row'; })()`), true, 'footer stays visible, labels stay inline and dialog fits viewport');
  };
  await assertGeometry();
  await screenshot('chrome-preview');
  await polishScreens(screenTools, 'bookmark-preview', '.bookmark-import-modal', '.bookmark-import-scroll');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await delay(150);
  await assertGeometry();
  await evaluate('document.querySelector(".bookmark-import-scroll").scrollTop = document.querySelector(".bookmark-import-scroll").scrollHeight');
  assert.equal(await evaluate('(() => { const row = document.querySelector(".bookmark-import-row").getBoundingClientRect(), pane = document.querySelector(".bookmark-import-scroll").getBoundingClientRect(); return row.top >= pane.top && row.top < pane.bottom; })()'), true, 'preview links are reachable by scrolling');
  await screenshot('chrome-preview-narrow');
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await delay(100);
  // Rejecting a replacement file must clear the prior ready-to-apply plan.
  await choose(path.join(output, 'empty.html'));
  await wait(has('书签文件为空'), 'replacement error');
  assert.equal(await canApply(), false);
  assert.equal(await evaluate('!!document.querySelector(".bookmark-import-list")'), false);
  await choose(fixture('chrome'));
  await wait(has('将添加 4 个网址'), 'Chrome preview again');
  await click('确认导入');
  await wait('!document.querySelector(".bookmark-import")', 'Chrome saved');
  await wait(has('已导入 4 个网址，跳过 1 条重复网址。'), 'completion counts');
  await click('Bookmarks bar');
  await wait(exists('.folder-content a[href="https://example.com/"]'), 'imported link visible in desktop folder');
  assert.equal(await evaluate('document.querySelector(".folder-content a").textContent.includes("Example & 本地")'), true);
  const localId = await evaluate('document.querySelector(".folder-content a").closest("[data-entry-id]").dataset.entryId');
  await screenshot('chrome-desktop-folder');
  await evaluate('document.querySelector("[role=dialog] button[aria-label=关闭]").click()');
  await delay(100);

  await openImport();
  await choose(fixture('chrome'));
  await wait(has('将添加 0 个网址和 0 个文件夹，跳过 5 条重复网址'), 'repeat keeps local');
  assert.equal(await canApply(), false);
  await click('取消');
  for (const [browser, folders] of [['firefox', 3], ['edge', 3]]) {
    await openImport();
    await choose(fixture(browser));
    await wait(has(`将添加 3 个网址和 ${folders} 个文件夹`), `${browser} preview`);
    if (browser === 'firefox') assert.match(await evaluate('document.body.innerText'), /已跳过 1 项无效地址/);
    await click('确认导入');
    await wait('!document.querySelector(".bookmark-import")', `${browser} saved`);
  }

  const hostile = path.join(output, 'hostile.html');
  await writeFile(hostile, '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><script>globalThis.bookmarkExecuted=true</script><img src="https://tracker.test/pixel"><iframe src="https://tracker.test/frame"></iframe><DT><A HREF="javascript:alert(1)">Bookmarklet</A><DT><A HREF="data:text/html,evil">Data URL</A><DT><A HREF="https://offline-fixture.test/" ICON_URI="https://tracker.test/icon">Safe &amp; local</A></DL>');
  await openImport();
  await choose(hostile);
  await wait(has('已跳过 2 项无效地址'), 'unsafe URL preview');
  assert.equal(await evaluate('globalThis.bookmarkExecuted === undefined'), true);
  await click('确认导入');
  await wait(exists('a[href="https://offline-fixture.test/"]'), 'safe root link visible');
  assert.equal(await evaluate('document.querySelectorAll("a[href^=javascript],a[href^=data]").length'), 0);
  await delay(500);
  assertLocal(startupRequests, nativeStart);
  await screenshot('desktop-after-all-imports');

  const beforeReload = requests.length;
  await send('Page.reload');
  await wait(exists('a[href="https://offline-fixture.test/"]'), 'encrypted local persistence across reload');
  await click('Bookmarks bar');
  await wait(exists('.folder-content a[href="https://example.com/"]'), 'Chrome link after reload');
  assert.equal(await evaluate('document.querySelector(".folder-content a").closest("[data-entry-id]").dataset.entryId'), localId, 'existing local ID retained');
  assert.equal(await evaluate('document.querySelector(".folder-content a").textContent.includes("Example & 本地")'), true);
  await evaluate('document.querySelector("[role=dialog] button[aria-label=关闭]").click()');
  for (const name of ['Bookmarks Toolbar / 研究 & 资料', 'Favorites bar / 工作 / 文档']) assert.ok(await evaluate(`[...document.querySelectorAll('.site-name')].some(el => el.textContent === ${JSON.stringify(name)})`));
  await delay(500);
  assert.ok(requests.slice(beforeReload).every(({ url }) => new URL(url).hostname === 'www.bing.com'), 'reload never requests imported sites or their images');
  const reloadRequests = requests.slice(beforeReload);

  // Check the actual fallback-to-browser-language UI in a second language.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "chrome.i18n.getUILanguage = () => 'en';" });
  await send('Page.reload');
  await wait('!!document.querySelector("button[title=Settings]")', 'English UI');
  await evaluate('document.querySelector("button[title=Settings]").click()');
  await delay(100);
  await click('Data');
  await click('Import URLs and bookmark HTML');
  await choose(path.join(output, 'empty.html'));
  await wait(has('The bookmark file is empty.'), 'English file error');
  await screenshot('bad-file-en');
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: true, importedSites: 11, importHttpRequests: 0, importNativeFaviconRequests: 0, startupRequests: requests.slice(0, startupRequests), reloadRequests, checks: ['light/dark 1100/390px import tips and preview','Space disclosure activation and focus retention','settings/data/file-picker reachability', 'Chrome/Firefox/Edge fixtures', 'empty/non-HTML/oversize errors', 'failed replacement clears prior preview', 'skip duplicates default and counts', 'unsafe URLs excluded', 'hostile resources inert', 'desktop folders and links visible', 'encrypted local reload preserves IDs and content', 'zh-CN and English UI errors', 'eight locales covered by unit tests', 'desktop and narrow dialog geometry with pinned actions'] }, null, 2));
};
