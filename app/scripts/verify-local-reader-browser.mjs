// Native CDP against installed Chrome. Live public articles, production UI and
// encrypted IndexedDB; no Playwright and no production browser profile.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { startRecordMergeBrowser, delay } from './verify-record-merge-browsers.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(appRoot, '../output/playwright/covelet/local-reader');
const names = ['AbortController', 'AbortSignal', 'URL', 'URLSearchParams', 'Headers', 'Request', 'Response', 'Fetch_API',
  'ReadableStream', 'WritableStream', 'TransformStream', 'Blob', 'File', 'FileReader', 'TextEncoder', 'TextDecoder', 'DOMParser', 'Document', 'Element', 'Event'];
const urls = names.map(name => `https://developer.mozilla.org/en-US/docs/Web/API/${name}`);
const downloads = new Map(), downloadDirectory = path.join(output, 'markdown');
const receipt = { format: 'covelet-local-reader-browser-verification', version: 1, startedAt: new Date().toISOString(),
  method: 'Installed headed Chrome, native CDP UI automation; not human manual acceptance.',
  instrumentation: 'Test-only unpacked copy grants exact MDN and synthetic article/image origins. Bundled production API bridge inspects persistence/search/Markdown; native DOM selection establishes selected text. Synthetic hostile page and image response are explicitly instrumented; 20 MDN article responses are live and unmocked.',
  articles: [], stages: [] };
let browser, artifact, profile, stage = 'prepare'; const requests = [];
const at = value => { stage = value; receipt.stages.push(value); console.log(JSON.stringify({ stage: value })); };
async function wait(expression, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await browser.evaluate(expression)) return; await delay(100); }
  throw Error(`${label} timed out`);
}
async function click(expression) {
  const point = await browser.evaluate(`(()=>{const e=(${expression});if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  assert.ok(point, 'Enabled UI target exists');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await browser.cdp.send('Input.dispatchMouseEvent', { type, ...point, ...(type !== 'mouseMoved' && { button: 'left', clickCount: 1 }) }, browser.pageSessionId);
  await delay(80);
}
const button = (label, scope = '.reading-reader-modal') => click(`Array.from(document.querySelectorAll(${JSON.stringify(`${scope} button`)})).find(e=>e.textContent.trim()===${JSON.stringify(label)})`);
async function fill(selector, text) {
  await click(`document.querySelector(${JSON.stringify(selector)})`);
  await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, browser.pageSessionId);
  await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 }, browser.pageSessionId);
  await browser.cdp.send('Input.insertText', { text }, browser.pageSessionId);
  assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value`), text);
}
async function bridge() {
  await browser.evaluate("import(chrome.runtime.getURL('reader-test-bridge.js'))");
  await browser.evaluate("__readerQA.language()"); await wait("document.documentElement.lang==='zh-CN'", 'Chinese UI');
}
async function openReading() {
  await click("document.querySelector('button[aria-label=\"命令面板\"]')");
  await wait("Boolean(document.querySelector('.command-palette input'))", 'Command palette');
  await fill('.command-palette input', '稍后读');
  await click("Array.from(document.querySelectorAll('.command-result')).find(e=>e.querySelector('strong')?.textContent==='稍后读')");
  await wait("Boolean(document.querySelector('.reading-add-form'))", 'Reading tools');
}
async function openRecord(title) {
  await wait(`Array.from(document.querySelectorAll('.reading-record-open')).some(e=>e.textContent.includes(${JSON.stringify(title)}))`, 'Saved reading row');
  await click(`Array.from(document.querySelectorAll('.reading-record-open')).find(e=>e.textContent.includes(${JSON.stringify(title)}))`);
  await wait("Boolean(document.querySelector('.reading-reader-article'))", 'Local article');
}
async function closeReader() {
  await click("document.querySelector('.reading-reader-modal button[aria-label=\"关闭\"]')");
  await wait("!document.querySelector('.reading-reader-modal')", 'Reader close');
}
async function annotate(index) {
  assert.equal(await browser.evaluate(`(()=>{const e=Array.from(document.querySelectorAll('.reading-reader-article p [data-reading-block-text]')).find(e=>e.textContent.length>50);if(!e)return false;const w=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);const n=w.nextNode();if(!n||n.textContent.length<8)return false;const r=document.createRange();r.setStart(n,0);r.setEnd(n,Math.min(n.textContent.length,45));getSelection().removeAllRanges();getSelection().addRange(r);e.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));return true})()`), true);
  await wait("Boolean(document.querySelector('textarea[aria-label=\"批注\"]'))", 'Highlight selection');
  const note = `readeracceptance${String(index).padStart(2, '0')}`;
  await fill('textarea[aria-label="批注"]', note); await button('保存高亮');
  await wait(`Array.from(document.querySelectorAll('.reading-reader-annotation p')).some(e=>e.textContent===${JSON.stringify(note)})`, 'Persisted annotation');
  return note;
}
async function prepare() {
  await mkdir(output, { recursive: true }); artifact = await mkdtemp(path.join(output, 'local-reader-build-'));
  await mkdir(downloadDirectory, { recursive: true });
  for (let index = 1; index <= 20; index++) await rm(path.join(downloadDirectory, `Reader QA ${String(index).padStart(2, '0')}.md`), { force: true });
  await cp(path.join(appRoot, 'dist/extension'), artifact, { recursive: true });
  const manifestPath = path.join(artifact, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions.push('https://developer.mozilla.org/*', 'https://reader-fixture.example.test/*', 'https://hacks.mozilla.org/*');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const source = `import {localData,syncDataStore} from ${JSON.stringify(path.join(appRoot, 'src/lib/local-data.js'))};
    import {loadPersonalToolsSnapshot,saveReadingItem} from ${JSON.stringify(path.join(appRoot, 'src/lib/personal-tools.js'))};
    import {loadReadingLibrary,saveReadingArticle} from ${JSON.stringify(path.join(appRoot, 'src/lib/reading-library.js'))};
    import {loadContentPreferences} from ${JSON.stringify(path.join(appRoot, 'src/lib/content-preferences.js'))};
    import {loadState} from ${JSON.stringify(path.join(appRoot, 'src/lib/storage.js'))};
    import {filterSavedContent} from ${JSON.stringify(path.join(appRoot, 'src/lib/saved-views.js'))};
    import {parseStructuredSearch} from ${JSON.stringify(path.join(appRoot, 'src/lib/structured-search.js'))};
    import {exportReadingMarkdown} from ${JSON.stringify(path.join(appRoot, 'src/lib/markdown-library.js'))};
    import {rssInbox} from ${JSON.stringify(path.join(appRoot, 'src/lib/rss-inbox.js'))};
    globalThis.__readerQA={language:()=>localData.set({'covelet.language.v1':'zh-CN'}),
      async inspect(url){const tools=await loadPersonalToolsSnapshot(),library=await loadReadingLibrary(),record=tools.reading.find(r=>r.url===url);return {record,article:library.articles[record?.id],settings:library.settings};},
      async verify(url,note){const tools=await loadPersonalToolsSnapshot(),library=await loadReadingLibrary(),preferences=await loadContentPreferences(),navigation=await loadState();
        const record=tools.reading.find(r=>r.url===url),article=library.articles[record.id];
        const parsed=parseStructuredSearch('type:reading is:unread domain:'+new URL(url).hostname+' '+note);
        const result=filterSavedContent(navigation,{...tools,readingLibrary:library},preferences,parsed.filters);
        const exported=await exportReadingMarkdown(record.id,{expectedReadingRevision:record.revision,expectedArticleRevision:article.revision,expectedPreferencesRevision:preferences.revision});
        const text=await exported.blob.text();return {matched:result.rows.map(r=>r.id),id:record.id,exportHasNote:text.includes(note),exportHasQuote:text.includes(article.highlights[0].quote),bodyLength:article.text.length,articleTitle:article.title,highlightCount:article.highlights.length};},
      async hostile(){const record=await saveReadingItem({url:'https://reader-fixture.example.test/article',title:'Hostile fixture',status:'unread'},{extract:false});
        await saveReadingArticle(record,{html:'<title>Hostile fixture</title><article><h1>Safe local article</h1><p>This intentionally hostile HTML contains a readable paragraph for verifying that embedded remote resources never load automatically.</p><img src="https://reader-fixture.example.test/click.png" alt="Explicit image"><iframe src="https://reader-fixture.example.test/frame"></iframe><script src="https://reader-fixture.example.test/script"></script><style>@import url(https://reader-fixture.example.test/style);</style></article>'});return record;},
      async rss(){const before=await loadReadingLibrary(),feed=await rssInbox.add({url:'https://hacks.mozilla.org/feed/'}),state=await rssInbox.load();
        const result=await chrome.runtime.sendMessage({type:'covelet:rss:refresh',feedId:feed.id});
        const after=await loadReadingLibrary();return {feeds:state.feeds.length,items:state.items.length,error:state.feeds[0].lastError?.code||null,workerRefresh:result?.ok===true,articleCountBefore:Object.keys(before.articles).length,articleCountAfter:Object.keys(after.articles).length,alarm:Boolean(await chrome.alarms.get('covelet:rss:due'))};},
      async syncKeys(){return (await syncDataStore.snapshot()).records.map(r=>r.key);}
    };`;
  await build({ stdin: { contents: source, resolveDir: appRoot }, outfile: path.join(artifact, 'reader-test-bridge.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', define: { 'import.meta.env': '{}' }, logLevel: 'silent',
    plugins: [{ name: 'qa-wasm', setup(plugin) {
      plugin.onResolve({ filter: /\.wasm\?url$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]), namespace: 'qa-wasm' }));
      plugin.onLoad({ filter: /.*/, namespace: 'qa-wasm' }, async args => { const name = `qa-${path.basename(args.path)}`; await cp(args.path, path.join(artifact, name)); return { contents: `export default chrome.runtime.getURL(${JSON.stringify(name)});`, loader: 'js' }; });
    } }] });
}
try {
  await prepare(); at('launch'); browser = await startRecordMergeBrowser('chrome', { headless: false, output, extensionRoot: artifact, preserveProfile: true }); profile = browser.profile;
  receipt.browser = browser.browserVersion; await bridge(); await browser.cdp.send('Network.enable', {}, browser.pageSessionId);
  await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory, eventsEnabled: true });
  browser.cdp.on('Browser.downloadWillBegin', event => downloads.set(event.guid, { filename: event.suggestedFilename, state: 'inProgress' }));
  browser.cdp.on('Browser.downloadProgress', event => { const item = downloads.get(event.guid); if (item) item.state = event.state; });
  browser.cdp.on('Network.requestWillBeSent', (event, session) => { if (session === browser.pageSessionId && /^https?:/u.test(event.request.url)) requests.push(event.request.url); });
  at('live-20-article-save-read-highlight-search-export'); await openReading();
  for (let index = 0; index < urls.length; index++) {
    const url = urls[index], title = `Reader QA ${String(index + 1).padStart(2, '0')}`;
    await fill('.reading-add-form label:nth-child(1) input', url); await fill('.reading-add-form label:nth-child(2) input', title);
    await button('添加', '.reading-add-form');
    await wait(`__readerQA.inspect(${JSON.stringify(url)}).then(value=>Boolean(value.article))`, 'Live article extraction', 45000);
    await openRecord(title); const note = await annotate(index + 1);
    if (index === 0) {
      for (const [label, value, field] of [['字号', '20', 'fontSize'], ['行距', '2', 'lineHeight'], ['阅读外观', 'dark', 'theme']]) {
        await browser.evaluate(`(()=>{const e=document.querySelector('select[aria-label="${label}"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await wait(`__readerQA.inspect(${JSON.stringify(url)}).then(value=>String(value.settings.${field})===${JSON.stringify(value)})`, 'Persisted reader display setting');
      }
      await browser.screenshot('reader-dark-typography.png');
    }
    const result = await browser.evaluate(`__readerQA.verify(${JSON.stringify(url)},${JSON.stringify(note)})`);
    assert.deepEqual(result.matched, [result.id]); assert.equal(result.exportHasNote, true); assert.equal(result.exportHasQuote, true); assert.equal(result.highlightCount, 1);
    assert.ok(result.articleTitle.includes('MDN')); assert.ok(result.bodyLength > 500);
    await button('导出 Markdown'); const filename = `${title}.md`, deadline = Date.now() + 10000;
    while (Date.now() < deadline && ![...downloads.values()].some(item => item.filename === filename && item.state === 'completed')) await delay(100);
    assert([...downloads.values()].some(item => item.filename === filename && item.state === 'completed'), 'Actual UI Markdown download completed');
    assert((await readFile(path.join(downloadDirectory, filename), 'utf8')).includes(note)); result.uiMarkdownDownload = true;
    receipt.articles.push({ url, ...result }); if (index === 0) await browser.screenshot('first-article-highlight.png');
    await closeReader();
    await fill('input[aria-label="搜索稍后读"]', note);
    await wait(`document.querySelectorAll('.reading-record-open').length===1 && document.querySelector('.reading-record-open')?.textContent.includes(${JSON.stringify(title)})`, 'UI full-text annotation search');
    await fill('input[aria-label="搜索稍后读"]', '');
    console.log(JSON.stringify({ article: index + 1, status: 'passed' }));
  }
  assert.deepEqual(requests.filter(url => !urls.includes(url)), [], 'No embedded article resources or unrelated requests during live reading');
  at('hostile-html-no-prefetch'); await browser.evaluate('__readerQA.hostile()'); await openRecord('Hostile fixture');
  await delay(500); assert.deepEqual(requests.filter(url => url.includes('reader-fixture.example.test')), []);
  assert.equal(await browser.evaluate("document.querySelectorAll('.reading-reader-article img,.reading-reader-article iframe,.reading-reader-article script,.reading-reader-article style').length"), 0);
  await browser.screenshot('no-image-prefetch.png');
  // Intercept just this synthetic image response. Article corpus was live.
  const imageBytes = (await readFile(path.join(artifact, 'icons/icon-16.png'))).toString('base64');
  await browser.cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://reader-fixture.example.test/click.png' }] }, browser.pageSessionId);
  const off = browser.cdp.on('Fetch.requestPaused', (event, session) => {
    if (session === browser.pageSessionId) void browser.cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }], body: imageBytes }, session);
  });
  await button('点击加载图片'); await wait("document.querySelector('.reading-reader-article img')?.getAttribute('src')?.startsWith('blob:') && document.querySelector('.reading-reader-article img').naturalWidth>0", 'Click-only image');
  assert.equal(requests.filter(url => url.endsWith('/click.png')).length, 1); off(); await closeReader();
  at('live-rss-feed-and-background-refresh'); receipt.rss = await browser.evaluate('__readerQA.rss()');
  assert.equal(receipt.rss.feeds, 1); assert.ok(receipt.rss.items > 0); assert.equal(receipt.rss.error, null);
  assert.equal(receipt.rss.workerRefresh, true); assert.equal(receipt.rss.alarm, true);
  assert.equal(receipt.rss.articleCountBefore, receipt.rss.articleCountAfter);
  const keys = await browser.evaluate('__readerQA.syncKeys()'); assert(!keys.includes('covelet.reading-library.v1')); assert(!keys.includes('covelet.rss.inbox.v1'));
  at('restart-persistence'); await browser.close(); browser = undefined;
  browser = await startRecordMergeBrowser('chrome', { headless: false, output, extensionRoot: artifact, existingProfile: profile }); await bridge();
  for (const url of urls) { const saved = await browser.evaluate(`__readerQA.inspect(${JSON.stringify(url)})`); assert.equal(saved.article.highlights.length, 1); }
  receipt.checks = { liveArticles: 20, uiSaveReadHighlight: true, localStructuredSearchAndMarkdown: true, noEmbeddedRequestsBeforeImageClick: true, imageUsesBlobAfterExplicitClick: true, restartDurability: true, syncExclusion: true };
  receipt.result = 'passed'; at('passed');
} catch (error) {
  receipt.result = 'failed'; receipt.failureStage = stage; receipt.failure = error.message; console.error(JSON.stringify({ stage, message: error.message })); process.exitCode = 1;
  try { await browser?.screenshot('failure.png'); } catch {}
} finally {
  try { await browser?.close(); } catch { receipt.cleanup = ['BROWSER_CLOSE_FAILED']; }
  for (const [candidate, prefix] of [[profile, 'raw-record-merge-profile-chrome-'], [artifact, 'local-reader-build-']]) if (candidate) {
    try { const actual = await realpath(candidate), root = await realpath(output), relative = path.relative(root, actual);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith(prefix)) throw Error('Unsafe cleanup path');
      await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) { if (error.code !== 'ENOENT') (receipt.cleanup ||= []).push('TEST_DIRECTORY_CLEANUP_FAILED'); }
  }
  receipt.requests = requests; receipt.finishedAt = new Date().toISOString(); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'browser.json'), JSON.stringify(receipt, null, 2));
}
