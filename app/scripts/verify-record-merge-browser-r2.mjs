// Actual Chrome + Edge, encrypted IndexedDB and real R2; native CDP only.
// Seeding uses a disclosed test-only bridge compiled from current domain APIs.
// Configuration, conflict preview and application use the production UI.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { acceptanceOutput, startRecordMergeBrowser, delay } from './verify-record-merge-browsers.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = path.resolve(appRoot, '..');
let stage = 'configuration', artifact;
const browsers = [];
const receipt = { date: '2026-11-24', method: 'Automated native CDP UI, headed installed Chrome and Edge; not a human manual test',
  instrumentation: 'Test-only copy of current unpacked extension: one exact R2 origin host grant and a bundled test bridge calling current saveNote/saveState/encrypted storage APIs. Production dist and source behavior unchanged.', stages: [] };
function at(name) { stage = name; receipt.stages.push(name); console.log(JSON.stringify({ stage: name })); }
async function wait(browser, expression, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await browser.evaluate(expression)) return; await delay(150); }
  throw Error(`${label} timed out`);
}
async function clickExpression(browser, expression) {
  const point = await browser.evaluate(`(() => { const element = (${expression}); if (!element || element.disabled) return null; element.scrollIntoView({block:'center'}); const r=element.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  if (!point) throw Error('Expected enabled UI control missing');
  await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, browser.pageSessionId);
  await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, browser.pageSessionId);
  await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, browser.pageSessionId);
  await delay(100);
}
const button = (browser, text, scope = '.cloud-sync-form') => clickExpression(browser,
  `Array.from(document.querySelectorAll(${JSON.stringify(`${scope} button`)})).find(e => e.textContent.trim() === ${JSON.stringify(text)})`);
async function fill(browser, label, value) {
  await browser.evaluate(`(() => { const input=Array.from(document.querySelectorAll('.cloud-sync-form label')).find(e=>e.textContent.trim()===${JSON.stringify(label)})?.querySelector('input'); if(!input || input.disabled) throw Error('Expected field missing'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await delay(60);
}
async function escape(browser) {
  await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, browser.pageSessionId);
  await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, browser.pageSessionId);
  await delay(100);
}
async function openSettings(browser) {
  if (await browser.evaluate("Boolean(document.querySelector('.cloud-sync-form'))")) return;
  await clickExpression(browser, "document.querySelector('button[aria-label=\"打开扩展\"]')");
  await wait(browser, "Boolean(document.querySelector('#extension-custom-storage-sync'))", 'Extensions menu');
  await clickExpression(browser, "document.querySelector('#extension-custom-storage-sync')");
  await wait(browser, "Boolean(document.querySelector('.cloud-sync-form'))", 'Sync settings');
}
async function finishOperation(browser, { conflict = false } = {}) {
  await wait(browser, "['success','info','error'].includes(document.querySelector('.cloud-action-feedback')?.dataset.tone) && Boolean(Array.from(document.querySelectorAll('.cloud-sync-actions button')).find(e=>e.textContent.trim()==='测试连接' && !e.disabled))", 'Sync feedback');
  const state = await browser.evaluate("({tone:document.querySelector('.cloud-action-feedback')?.dataset.tone,conflict:document.querySelector('.cloud-action-feedback')?.textContent.includes('有冲突待处理')})");
  if (state.tone === 'error') throw Error('Production sync UI reported an error');
  if (conflict && !state.conflict) throw Error('Expected a concurrent conflict');
}
async function sync(browser, options) { await openSettings(browser); await button(browser, '立即同步'); await finishOperation(browser, options); }
async function configure(browser, config, password) {
  await openSettings(browser);
  await clickExpression(browser, "Array.from(document.querySelectorAll('.cloud-channel-option')).find(e=>e.textContent.includes('Cloudflare R2'))");
  await button(browser, '下一步');
  for (const [name, value] of [['账户 API 地址', config.endpoint], ['Bucket 名称', config.bucket], ['保存目录', config.prefix], ['Access Key ID', config.accessKeyId], ['Secret Access Key', config.secretAccessKey]]) await fill(browser, name, value);
  if (config.sessionToken) { await clickExpression(browser, "Array.from(document.querySelectorAll('.cloud-sync-form button')).find(e=>e.textContent.trim()==='临时安全令牌')"); await fill(browser, '临时安全令牌', config.sessionToken); }
  await button(browser, '测试连接');
  await wait(browser, "document.querySelector('.cloud-action-feedback')?.textContent.includes('连接通过')", 'R2 connection test');
  await button(browser, '下一步');
  await fill(browser, '同步密码', password);
  if (await browser.evaluate("document.querySelector('.cloud-sync-form [role=switch]')?.getAttribute('aria-checked')==='true'")) await clickExpression(browser, "document.querySelector('.cloud-sync-form [role=switch]')");
  await button(browser, '保存并同步');
  await wait(browser, "!document.querySelector('.cloud-setup-steps') && Boolean(Array.from(document.querySelectorAll('.cloud-sync-actions button')).find(e=>e.textContent.trim()==='立即同步' && !e.disabled))", 'Initial sync');
  if (await browser.evaluate("document.querySelector('.cloud-action-feedback')?.dataset.tone==='error'")) throw Error('Initial sync failed');
  await escape(browser);
}

async function makeBridge(config) {
  await mkdir(acceptanceOutput, { recursive: true });
  artifact = await mkdtemp(path.join(acceptanceOutput, 'raw-record-merge-build-'));
  await cp(path.join(appRoot, 'dist', 'extension'), artifact, { recursive: true });
  const manifestPath = path.join(artifact, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...manifest.host_permissions, `${new URL(config.endpoint).origin}/*`])];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const source = `import {localData,syncDataStore} from ${JSON.stringify(path.join(appRoot, 'src/lib/local-data.js'))};
    import {loadState,saveState} from ${JSON.stringify(path.join(appRoot, 'src/lib/storage.js'))};
    import {saveNote,loadPersonalToolsSnapshot} from ${JSON.stringify(path.join(appRoot, 'src/lib/personal-tools.js'))};
    globalThis.__recordMergeQA={
      async language(){await localData.set({'covelet.language.v1':'zh-CN'});},
      snapshot:()=>syncDataStore.snapshot(),
      async addNote(title,body){return saveNote({title,body,pinned:false});},
      async editNote(id,patch){const data=await loadPersonalToolsSnapshot();const item=data.notes.find(x=>x.id===id);return saveNote({...item,...patch});},
      async addSite(id,name){const state=await loadState();state.entries.push({id,type:'site',name,url:'https://example.com/'+id,groupId:state.groups[0].id,parentId:null,order:state.entries.filter(x=>x.parentId===null).length,icon:{kind:'letter',value:name.slice(0,1)}});return saveState(state,state.revision);},
      async renameSite(id,name){const state=await loadState();state.entries.find(x=>x.id===id).name=name;return saveState(state,state.revision);}
    };`;
  await build({ stdin: { contents: source, resolveDir: appRoot, sourcefile: 'record-merge-test-bridge.js' }, outfile: path.join(artifact, 'record-merge-test-bridge.js'),
    bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', define: { 'import.meta.env': '{}' }, logLevel: 'silent',
    plugins: [{ name: 'test-packaged-wasm', setup(plugin) {
      plugin.onResolve({ filter: /\.wasm\?url$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]), namespace: 'test-wasm' }));
      plugin.onLoad({ filter: /.*/, namespace: 'test-wasm' }, async (args) => {
        const name = `qa-${path.basename(args.path)}`; await cp(args.path, path.join(artifact, name));
        return { contents: `export default chrome.runtime.getURL(${JSON.stringify(name)});`, loader: 'js' };
      });
    } }],
  });
  return artifact;
}

try {
  const settings = JSON.parse((await readFile(path.join(workspaceRoot, 'output/playwright/covelet/live-config.local.json'), 'utf8')).replace(/^\uFEFF/u, ''));
  const config = settings.r2;
  if (!config || ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'].some((key) => typeof config[key] !== 'string' || !config[key].trim())) throw Error('Local R2 config required');
  config.prefix = `${config.prefix || 'Covelet-QA'}/browser-record-merge-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const password = `Covelet-browser-test-${randomUUID()}`;
  const extensionRoot = await makeBridge(config);
  at('launch-installed-browsers');
  for (const name of ['chrome', 'edge']) {
    const browser = await startRecordMergeBrowser(name, { headless: false, extensionRoot }); browsers.push(browser);
    await browser.evaluate("import(chrome.runtime.getURL('record-merge-test-bridge.js'))");
    await browser.evaluate('globalThis.__recordMergeQA.language()');
    await wait(browser, "document.documentElement.lang==='zh-CN'", 'Chinese test UI');
    await browser.evaluate(`document.title=${JSON.stringify(`Covelet ${name === 'edge' ? 'Edge' : 'Chrome'} 合并验证`)}`);
  }
  const [chrome, edge] = browsers;
  at('seed-shared-navigation-and-note');
  const sharedNote = await chrome.evaluate("globalThis.__recordMergeQA.addNote('Shared note','Shared baseline body')");
  await chrome.evaluate("globalThis.__recordMergeQA.addSite('qa-shared-a','Shared navigation A')");
  await chrome.evaluate("globalThis.__recordMergeQA.addSite('qa-shared-b','Shared navigation B')");
  at('configure-chrome-real-r2'); await configure(chrome, config, password);
  at('configure-edge-real-r2'); await configure(edge, config, password);
  at('establish-common-baseline'); await sync(chrome); await escape(chrome); await sync(edge); await escape(edge);
  at('edit-shared-records-and-add-exclusive-content');
  await chrome.evaluate(`globalThis.__recordMergeQA.editNote(${JSON.stringify(sharedNote.id)},{title:'Chrome shared title'})`);
  await chrome.evaluate("globalThis.__recordMergeQA.addNote('Chrome exclusive note','Chrome-only content must survive')");
  await chrome.evaluate("globalThis.__recordMergeQA.renameSite('qa-shared-a','Chrome renamed navigation A')");
  await chrome.evaluate("globalThis.__recordMergeQA.addSite('qa-chrome-only','Chrome exclusive navigation')");
  await edge.evaluate(`globalThis.__recordMergeQA.editNote(${JSON.stringify(sharedNote.id)},{body:'Edge shared body'})`);
  await edge.evaluate("globalThis.__recordMergeQA.addNote('Edge exclusive note','Edge-only content must survive')");
  await edge.evaluate("globalThis.__recordMergeQA.renameSite('qa-shared-b','Edge renamed navigation B')");
  await edge.evaluate("globalThis.__recordMergeQA.addSite('qa-edge-only','Edge exclusive navigation')");
  at('publish-chrome-and-detect-edge-conflict'); await sync(chrome); await escape(chrome); await sync(edge, { conflict: true });
  await button(edge, '预览合并'); await wait(edge, "document.querySelectorAll('.cloud-merge-row').length>=5", 'Record preview');
  receipt.preview = await edge.evaluate("Array.from(document.querySelectorAll('.cloud-merge-row')).map(e=>({label:e.querySelector('.cloud-merge-row-heading strong')?.textContent,status:e.querySelector('.cloud-merge-row-heading span')?.textContent,choice:e.querySelector('select')?.value}))");
  assert.ok(receipt.preview.some((row) => row.status === '两侧都改了'));
  assert.ok(receipt.preview.some((row) => row.status === '仅一边改了'));
  await edge.screenshot('edge-real-r2-merge-preview.png');
  at('edge-preview-ready-for-inspection');
  // A bounded inspection window allows Computer Use to inspect and apply the
  // actual controls. Without takeover, the same production control is clicked.
  if (process.env.COVELET_QA_HOLD_PREVIEW === '1') {
    const until = Date.now() + 60000;
    while (Date.now() < until && await edge.evaluate("Boolean(document.querySelector('.cloud-merge-preview'))")) await delay(250);
  }
  if (await edge.evaluate("Boolean(document.querySelector('.cloud-merge-preview'))")) await button(edge, '应用合并');
  await wait(edge, "!document.querySelector('.cloud-merge-preview') && Boolean(Array.from(document.querySelectorAll('.cloud-sync-actions button')).find(e=>e.textContent.trim()==='立即同步' && !e.disabled))", 'Merge application');
  if (await edge.evaluate("document.querySelector('.cloud-action-feedback')?.dataset.tone==='error'")) throw Error('Merge application failed');
  await edge.screenshot('edge-real-r2-merged.png'); await escape(edge);
  at('converge-both-browsers'); await sync(chrome); await escape(chrome); await sync(edge); await escape(edge);
  const left = await chrome.evaluate('globalThis.__recordMergeQA.snapshot()'), right = await edge.evaluate('globalThis.__recordMergeQA.snapshot()');
  assert.equal(left.token, right.token);
  const tools = left.records.find((record) => record.key === 'covelet.tools.v1').value;
  const navigation = left.records.find((record) => record.key === 'owntab.local.v1').value.state;
  assert.equal(tools.notes.length, 3);
  assert.equal(tools.notes.find((note) => note.id === sharedNote.id).title, 'Chrome shared title');
  assert.equal(tools.notes.find((note) => note.id === sharedNote.id).body, 'Edge shared body');
  assert.ok(tools.notes.some((note) => note.title === 'Chrome exclusive note'));
  assert.ok(tools.notes.some((note) => note.title === 'Edge exclusive note'));
  assert.equal(navigation.entries.length, 4);
  assert.ok(navigation.entries.some((entry) => entry.id === 'qa-chrome-only'));
  assert.ok(navigation.entries.some((entry) => entry.id === 'qa-edge-only'));
  assert.equal(navigation.entries.find((entry) => entry.id === 'qa-shared-a').name, 'Chrome renamed navigation A');
  assert.equal(navigation.entries.find((entry) => entry.id === 'qa-shared-b').name, 'Edge renamed navigation B');
  at('verify-search-engine-reload');
  await clickExpression(chrome, "document.querySelector('button.engine-button')");
  await clickExpression(chrome, "Array.from(document.querySelectorAll('[role=menuitemradio]')).find(e=>e.textContent.trim()==='Google')");
  await wait(chrome, "document.querySelector('button.engine-button')?.getAttribute('title')==='Google'", 'Engine change');
  await chrome.cdp.send('Page.reload', {}, chrome.pageSessionId);
  await wait(chrome, "document.querySelector('button.engine-button')?.getAttribute('title')==='Google'", 'Persisted engine reload');
  await chrome.screenshot('chrome-real-r2-final.png'); await edge.screenshot('edge-real-r2-final.png');
  receipt.result = 'passed'; receipt.browsers = browsers.map((browser) => ({ name: browser.browserName, version: browser.browserVersion, extensionVersion: browser.extensionVersion }));
  receipt.records = { notes: 3, navigation: 4, identicalSnapshotDigests: true, exclusiveContentRetained: true, searchEngineReloadPersisted: true };
  receipt.remote = { provider: 'r2', uniqueSyntheticTestPrefix: true, encryptedObjectsRetained: true };
  at('passed');
} catch (error) {
  receipt.result = 'failed'; receipt.failureStage = stage;
  // Deliberately avoid logging raw provider errors or filled form snapshots.
  console.error(JSON.stringify({ result: 'failed', stage, reason: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VERIFICATION_FAILED',
    diagnostic: stage === 'configuration' && Array.isArray(error.errors) ? error.errors.map((entry) => entry.text).slice(0, 5) : undefined }));
  process.exitCode = 1;
} finally {
  for (const browser of browsers.reverse()) await browser.close();
  if (artifact) {
    const actual = await realpath(artifact), root = await realpath(acceptanceOutput), relative = path.relative(root, actual);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith('raw-record-merge-build-')) throw Error('Unsafe acceptance build cleanup path');
    await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  await mkdir(acceptanceOutput, { recursive: true });
  await writeFile(path.join(acceptanceOutput, 'real-r2-browser.json'), JSON.stringify(receipt, null, 2));
}
