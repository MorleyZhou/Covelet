// Installed Chrome UI + real encrypted IndexedDB. Native CDP, no Playwright.
// A disclosed test-only bridge seeds A→B→C using production note/pin APIs and
// reads persisted data. History entry, comparison, selection and restore use UI.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { startRecordMergeBrowser, delay } from './verify-record-merge-browsers.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url)), output = path.resolve(appRoot, '../output/playwright/covelet/note-history');
const A = 'History body A <img src="https://example.invalid/history-image" onerror="alert(1)">';
const B = 'History body B', C = 'History body C';
const receipt = { format: 'covelet-note-history-browser-verification', version: 1, startedAt: new Date().toISOString(),
  method: 'Native CDP automation of installed headed Chrome production UI; not human manual acceptance',
  instrumentation: 'Test-only unpacked copy and bundled domain API bridge for synthetic A/B/C seeding and persisted data inspection. No host permission expansion.', stages: [] };
let browser, artifact, profile, stage = 'prepare', externalRequests = 0;
const at = value => { stage = value; receipt.stages.push(value); console.log(JSON.stringify({ stage: value })); };
async function wait(expression, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await browser.evaluate(expression)) return; await delay(100); }
  throw Error(`${label} timed out`);
}
async function click(expression) {
  const point = await browser.evaluate(`(()=>{const element=(${expression});if(!element||element.disabled)return null;element.scrollIntoView({block:'center'});const r=element.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  assert.ok(point);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await browser.cdp.send('Input.dispatchMouseEvent', { type, ...point, ...(type !== 'mouseMoved' && { button: 'left', clickCount: 1 }) }, browser.pageSessionId);
  await delay(100);
}
const button = (label, scope = '.note-history-modal') => click(`Array.from(document.querySelectorAll(${JSON.stringify(`${scope} button`)})).find(e=>e.textContent.trim()===${JSON.stringify(label)})`);
async function makeBridge() {
  await mkdir(output, { recursive: true }); artifact = await mkdtemp(path.join(output, 'note-history-build-'));
  await cp(path.join(appRoot, 'dist/extension'), artifact, { recursive: true });
  const source = `import {localData} from ${JSON.stringify(path.join(appRoot, 'src/lib/local-data.js'))};
    import {loadState} from ${JSON.stringify(path.join(appRoot, 'src/lib/storage.js'))};
    import {saveNote,loadPersonalToolsSnapshot} from ${JSON.stringify(path.join(appRoot, 'src/lib/personal-tools.js'))};
    import {loadNoteHistory} from ${JSON.stringify(path.join(appRoot, 'src/lib/note-history.js'))};
    import {loadContentPreferences} from ${JSON.stringify(path.join(appRoot, 'src/lib/content-preferences.js'))};
    import {pinContentWidget} from ${JSON.stringify(path.join(appRoot, 'src/lib/pin-widget.js'))};
    const document=body=>({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:body}]}]});
    globalThis.__noteHistoryQA={async language(){await localData.set({'covelet.language.v1':'zh-CN'});},
      async seed(){let note=await saveNote({title:'Native history fixture',body:${JSON.stringify(A)},document:document(${JSON.stringify(A)}),pinned:false});
        note=await saveNote({...note,body:${JSON.stringify(B)},document:document(${JSON.stringify(B)})});
        note=await saveNote({...note,body:${JSON.stringify(C)},document:document(${JSON.stringify(C)})});
        const state=await loadState(),preferences=await loadContentPreferences();
        const pinned=await pinContentWidget({kind:'note',recordId:note.id,size:'small',page:0,expectedNavigationRevision:state.revision,expectedPreferencesRevision:preferences.revision,expectedRecordRevision:note.revision});
        return {noteId:note.id,widgetId:pinned.widgetId};},
      async inspect(id){const tools=await loadPersonalToolsSnapshot(),history=await loadNoteHistory();const note=tools.notes.find(n=>n.id===id);return {note,history:(history.notes[id]||[]).map(v=>({id:v.id,n:v.n,body:v.record.body,document:v.record.document}))};}
    };`;
  await build({ stdin: { contents: source, resolveDir: appRoot, sourcefile: 'note-history-test-bridge.js' }, outfile: path.join(artifact, 'note-history-test-bridge.js'), bundle: true,
    format: 'esm', platform: 'browser', target: 'chrome120', define: { 'import.meta.env': '{}' }, logLevel: 'silent',
    plugins: [{ name: 'test-packaged-wasm', setup(plugin) {
      plugin.onResolve({ filter: /\.wasm\?url$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]), namespace: 'qa-wasm' }));
      plugin.onLoad({ filter: /.*/, namespace: 'qa-wasm' }, async args => { const name = `qa-${path.basename(args.path)}`; await cp(args.path, path.join(artifact, name)); return { contents: `export default chrome.runtime.getURL(${JSON.stringify(name)});`, loader: 'js' }; });
    } }],
  });
}
async function loadBridge() {
  await browser.evaluate("import(chrome.runtime.getURL('note-history-test-bridge.js'))");
  await browser.evaluate('globalThis.__noteHistoryQA.language()'); await wait("document.documentElement.lang==='zh-CN'", 'Chinese UI');
}
async function inspect(noteId) { return browser.evaluate(`globalThis.__noteHistoryQA.inspect(${JSON.stringify(noteId)})`); }
async function openNote(widgetId) {
  await wait(`Boolean(document.getElementById(${JSON.stringify(`widget-title-${widgetId}`)}))`, 'Pinned note');
  await click(`document.getElementById(${JSON.stringify(`widget-title-${widgetId}`)})`);
  await wait("Boolean(document.querySelector('.note-editor button[aria-label=\"便笺历史\"]:not(:disabled)'))", 'Saved note history entry');
}
async function openHistory() {
  await click("document.querySelector('.note-editor button[aria-label=\"便笺历史\"]')");
  await wait("document.querySelectorAll('.note-history-versions button').length>=2", 'History list');
}
async function preview(index, expected, current) {
  await click(`Array.from(document.querySelectorAll('.note-history-versions button')).at(${index})`);
  await wait(`document.querySelector('[aria-label="历史便笺内容"]')?.textContent===${JSON.stringify(expected)}`, 'Historical body');
  assert.equal(await browser.evaluate("document.querySelector('[aria-label=\"当前便笺内容\"]')?.textContent"), current);
  assert.equal(await browser.evaluate("document.querySelectorAll('.note-history-comparison img,.note-history-comparison script,.note-history-comparison iframe,.note-history-comparison a,.note-history-modal [contenteditable=true]').length"), 0);
}
try {
  await makeBridge(); at('launch-chrome'); browser = await startRecordMergeBrowser('chrome', { headless: false, output, extensionRoot: artifact, preserveProfile: true }); profile = browser.profile;
  receipt.browser = { version: browser.browserVersion, extensionVersion: browser.extensionVersion };
  await loadBridge(); at('seed-A-B-C-with-domain-APIs'); const seeded = await browser.evaluate('globalThis.__noteHistoryQA.seed()');
  const before = await inspect(seeded.noteId); assert.equal(before.note.body, C); assert.equal(before.history.length, 2); assert.ok(before.history.some(v => v.body === A));
  at('open-production-note-history'); await openNote(seeded.widgetId);
  await browser.cdp.send('Network.enable', {}, browser.pageSessionId);
  const stop = browser.cdp.on('Network.requestWillBeSent', (event, session) => { if (session === browser.pageSessionId && /^https?:\/\//u.test(event.request.url)) externalRequests++; });
  await openHistory(); at('readonly-compare-old-A-with-current-C'); await preview(-1, A, C); await browser.screenshot('compare-A-with-C.png');
  at('restore-A-through-production-control'); await button('恢复此版本');
  await wait("!document.querySelector('.note-history-modal') && Boolean(document.querySelector('.note-editor button[aria-label=\"便笺历史\"]:not(:disabled)'))", 'Restored editor');
  const restored = await inspect(seeded.noteId); assert.equal(restored.note.body, A); assert.equal(restored.note.id, before.note.id);
  assert.ok(restored.history.some(v => v.body === C)); assert.deepEqual(restored.note.document, before.history.find(v => v.body === A).document);
  await wait(`document.querySelector('.note-editor [contenteditable="true"]')?.textContent.includes(${JSON.stringify(A)})`, 'Refreshed Folio editor');
  at('verify-preserved-C-in-readonly-history'); await openHistory(); await preview(0, C, A); await browser.screenshot('restored-A-history-C.png');
  stop(); assert.equal(externalRequests, 0);
  at('restart-same-chrome-profile'); await browser.close(); browser = undefined;
  browser = await startRecordMergeBrowser('chrome', { headless: false, output, extensionRoot: artifact, existingProfile: profile }); await loadBridge();
  const restarted = await inspect(seeded.noteId); assert.equal(restarted.note.body, A); assert.ok(restarted.history.some(v => v.body === C)); assert.equal(restarted.history.length, restored.history.length);
  await openNote(seeded.widgetId); await openHistory(); await preview(0, C, A); await browser.screenshot('restart-history-durable.png');
  receipt.result = 'passed'; receipt.checks = { domainSeedABC: true, actualSavedNoteHistoryEntry: true, readonlyCompareAAgainstC: true, actualRestoreControl: true,
    currentIsA: true, previousCurrentCRetained: true, folioDocumentRestored: true, editorDraftRefreshed: true, historyCount: restored.history.length,
    noHTMLNodesInPreview: true, externalRequestsDuringHistory: externalRequests, sameProfileBrowserRestart: true, historyAndCurrentDurable: true };
  at('passed');
} catch (error) {
  receipt.result = 'failed'; receipt.failureStage = stage; receipt.failureCode = error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VERIFICATION_FAILED';
  console.error(JSON.stringify({ result: receipt.result, stage, code: receipt.failureCode })); process.exitCode = 1;
} finally {
  const cleanup = []; try { await browser?.close(); } catch { cleanup.push('BROWSER_PROFILE_CLEANUP_FAILED'); }
  for (const [candidate, prefix] of [[profile, 'raw-record-merge-profile-chrome-'], [artifact, 'note-history-build-']]) if (candidate) {
    try { const actual = await realpath(candidate), root = await realpath(output), relative = path.relative(root, actual);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith(prefix)) throw Error('Unsafe cleanup path');
      await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) { if (error.code !== 'ENOENT') cleanup.push(prefix.startsWith('raw-') ? 'PROFILE_CLEANUP_FAILED' : 'BUILD_CLEANUP_FAILED'); }
  }
  if (cleanup.length) receipt.cleanup = cleanup; receipt.finishedAt = new Date().toISOString();
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'browser.json'), JSON.stringify(receipt, null, 2));
}
