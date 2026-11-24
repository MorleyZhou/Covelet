// Actual installed Chrome UI + encrypted IndexedDB + real R2. Native CDP only.
// The test-only extension copy adds one exact R2 host grant and a domain API
// bridge for synthetic seeding/snapshot inspection. Password changes and unlocks
// are performed exclusively through the production UI, never through the bridge.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { startRecordMergeBrowser, delay } from './verify-record-merge-browsers.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url)), workspaceRoot = path.resolve(appRoot, '..');
const output = path.join(workspaceRoot, 'output/playwright/covelet/password-rotation');
const receipt = { format: 'covelet-password-rotation-browser-verification', version: 1,
  startedAt: new Date().toISOString(), method: 'Native CDP production UI automation in installed headed Chrome; not human manual acceptance',
  instrumentation: 'Test-only unpacked copy, one exact R2 origin host grant, synthetic domain seeding/snapshot bridge. No production code behavior changed.', stages: [] };
let browser, artifact, profile, stage = 'configuration';
const at = value => { stage = value; receipt.stages.push(value); console.log(JSON.stringify({ stage: value })); };
const fail = () => { throw Error('VERIFICATION_FAILED'); };
async function wait(expression, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await browser.evaluate(expression)) return; await delay(150); }
  throw Error(`${label} timed out`);
}
async function click(expression) {
  const point = await browser.evaluate(`(() => {const element=(${expression}); if(!element || element.disabled)return null; element.scrollIntoView({block:'center'}); const r=element.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  if (!point) fail();
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await browser.cdp.send('Input.dispatchMouseEvent', { type, ...point,
    ...(type !== 'mouseMoved' && { button: 'left', clickCount: 1 }) }, browser.pageSessionId);
  await delay(100);
}
const buttonExpression = text => `Array.from(document.querySelectorAll('.cloud-sync-form button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
const button = text => click(buttonExpression(text));
async function fill(label, value) {
  const expression = `Array.from(document.querySelectorAll('.cloud-sync-form label')).find(e=>e.textContent.trim()===${JSON.stringify(label)})?.querySelector('input')`;
  await click(expression);
  await browser.evaluate(`(${expression}).select()`);
  await browser.cdp.send('Input.insertText', { text: value }, browser.pageSessionId);
  await delay(60);
  assert.equal(await browser.evaluate(`(() => {const input=(${expression});const props=Object.keys(input).find(key=>key.startsWith('__reactProps'));return input.value===${JSON.stringify(value)} && (!props || input[props].value===${JSON.stringify(value)});})()`), true);
}
async function openSettings() {
  if (await browser.evaluate("Boolean(document.querySelector('.cloud-sync-form'))")) return;
  await click("document.querySelector('button[aria-label=\"打开扩展\"]')");
  await wait("Boolean(document.querySelector('#extension-custom-storage-sync'))", 'Extensions menu');
  await click("document.querySelector('#extension-custom-storage-sync')");
  await wait("Boolean(document.querySelector('.cloud-sync-form'))", 'Sync settings');
}
async function sync() {
  await button('立即同步');
  await wait(`document.querySelector('.cloud-action-feedback')?.dataset.tone==='success' && Boolean((${buttonExpression('立即同步')}) && !(${buttonExpression('立即同步')}).disabled)`, 'Normal sync');
}
async function unlock(password, expected) {
  await fill('同步密码', password); await button('解锁');
  if (expected === 'rejected') {
    await wait(`document.querySelector('.cloud-action-feedback')?.dataset.tone==='error' && Boolean((${buttonExpression('解锁')}) && !(${buttonExpression('解锁')}).disabled)`, 'Rejected old password');
    assert.equal(await browser.evaluate("document.querySelector('.connection-state')?.textContent.includes('同步已锁定')"), true);
  } else {
    await wait(`Boolean((${buttonExpression('立即同步')}) && !(${buttonExpression('立即同步')}).disabled) || document.querySelector('.cloud-action-feedback')?.dataset.tone==='error'`, 'New password unlock');
    if (await browser.evaluate("document.querySelector('.cloud-action-feedback')?.dataset.tone==='error'")) {
      receipt.unlockDiagnostic = await browser.evaluate(`globalThis.__passwordRotationQA.canOpenEnvelope(${JSON.stringify(password)})`);
      fail();
    }
    assert.equal(await browser.evaluate("document.querySelector('.connection-state')?.textContent.includes('已解锁')"), true);
  }
}
async function inspect() {
  return browser.evaluate("globalThis.__passwordRotationQA.snapshot().then(s=>({token:s.token,notes:s.records.find(r=>r.key==='covelet.tools.v1')?.value.notes.map(n=>({id:n.id,title:n.title,body:n.body})),navigation:s.records.find(r=>r.key==='owntab.local.v1')?.value.state.entries.map(e=>({id:e.id,name:e.name,url:e.url}))}))");
}
async function screenshot(name, selector = '.cloud-sync-form') {
  const clip = await browser.evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.max(1,Math.min(r.width,innerWidth-r.x)),height:Math.max(1,Math.min(r.height,innerHeight-r.y)),scale:1};})()`);
  const image = await browser.cdp.send('Page.captureScreenshot', { format: 'png', clip }, browser.pageSessionId);
  await writeFile(path.join(output, name), Buffer.from(image.data, 'base64'));
}
async function makeBridge(config) {
  artifact = await mkdtemp(path.join(output, 'password-rotation-build-'));
  await cp(path.join(appRoot, 'dist/extension'), artifact, { recursive: true });
  const manifestPath = path.join(artifact, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...manifest.host_permissions, `${new URL(config.endpoint).origin}/*`])];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const source = `import {localData,syncDataStore} from ${JSON.stringify(path.join(appRoot, 'src/lib/local-data.js'))};
    import {loadState,saveState} from ${JSON.stringify(path.join(appRoot, 'src/lib/storage.js'))};
    import {saveNote} from ${JSON.stringify(path.join(appRoot, 'src/lib/personal-tools.js'))};
    import {decryptCloudPayload} from ${JSON.stringify(path.join(appRoot, 'src/lib/cloud-crypto.js'))};
    globalThis.__passwordRotationQA={snapshot:()=>syncDataStore.snapshot(),async language(){await localData.set({'covelet.language.v1':'zh-CN'});},
      async canOpenEnvelope(password){const config=(await localData.get('covelet.cloud.local.v1'))['covelet.cloud.local.v1'];let opens=false;try{await decryptCloudPayload(new TextEncoder().encode(config.credentialEnvelope),password);opens=true;}catch{}return {opens,currentEpochPresent:!!config.passwordEpoch,pendingJournal:!!await syncDataStore.readPasswordRotation()};},
      async seed(){await saveNote({title:'Password rotation fixture',body:'Synthetic text preserved across password change',pinned:false});
        const state=await loadState();state.entries.push({id:'qa-password-rotation-site',type:'site',name:'Rotation fixture',url:'https://example.com/password-rotation',groupId:state.groups[0].id,parentId:null,order:state.entries.length,icon:{kind:'letter',value:'R'}});await saveState(state,state.revision);}};`;
  await build({ stdin: { contents: source, resolveDir: appRoot, sourcefile: 'password-rotation-test-bridge.js' }, outfile: path.join(artifact, 'password-rotation-test-bridge.js'),
    bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', define: { 'import.meta.env': '{}' }, logLevel: 'silent',
    plugins: [{ name: 'test-packaged-wasm', setup(plugin) {
      plugin.onResolve({ filter: /\.wasm\?url$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]), namespace: 'qa-wasm' }));
      plugin.onLoad({ filter: /.*/, namespace: 'qa-wasm' }, async args => { const name = `qa-${path.basename(args.path)}`; await cp(args.path, path.join(artifact, name));
        return { contents: `export default chrome.runtime.getURL(${JSON.stringify(name)});`, loader: 'js' }; });
    } }],
  });
}
async function loadBridge() {
  await browser.evaluate("import(chrome.runtime.getURL('password-rotation-test-bridge.js'))");
  await browser.evaluate('globalThis.__passwordRotationQA.language()');
  await wait("document.documentElement.lang==='zh-CN'", 'Chinese UI');
}
async function configure(config, password) {
  await openSettings();
  await click("Array.from(document.querySelectorAll('.cloud-channel-option')).find(e=>e.textContent.includes('Cloudflare R2'))");
  await button('下一步');
  for (const [label, value] of [['账户 API 地址', config.endpoint], ['Bucket 名称', config.bucket], ['保存目录', config.prefix], ['Access Key ID', config.accessKeyId], ['Secret Access Key', config.secretAccessKey]]) await fill(label, value);
  if (config.sessionToken) { await button('临时安全令牌'); await fill('临时安全令牌', config.sessionToken); }
  await button('测试连接'); await wait("document.querySelector('.cloud-action-feedback')?.textContent.includes('连接通过')", 'R2 connection');
  await button('下一步'); await fill('同步密码', password);
  if (await browser.evaluate("document.querySelector('.cloud-sync-form [role=switch]')?.getAttribute('aria-checked')==='true'")) await click("document.querySelector('.cloud-sync-form [role=switch]')");
  await button('保存并同步');
  await wait(`!document.querySelector('.cloud-setup-steps') && Boolean((${buttonExpression('立即同步')}) && !(${buttonExpression('立即同步')}).disabled)`, 'Initial R2 sync');
  if (await browser.evaluate("document.querySelector('.cloud-action-feedback')?.dataset.tone==='error'")) fail();
}
try {
  await mkdir(output, { recursive: true });
  const parsed = JSON.parse((await readFile(path.join(workspaceRoot, 'output/playwright/covelet/live-config.local.json'), 'utf8')).replace(/^\uFEFF/u, ''));
  const config = { ...parsed.r2 };
  if (['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'].some(key => typeof config[key] !== 'string' || !config[key].trim())) fail();
  config.prefix = `${config.prefix || 'Covelet-QA'}/browser-password-rotation-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const oldPassword = `Covelet-old-${randomUUID()}`, newPassword = `Covelet-new-${randomUUID()}`;
  await makeBridge(config);
  at('launch-chrome'); browser = await startRecordMergeBrowser('chrome', { headless: false, output, extensionRoot: artifact, preserveProfile: true });
  profile = browser.profile;
  receipt.browser = { name: browser.browserName, version: browser.browserVersion, extensionVersion: browser.extensionVersion };
  await loadBridge();
  at('seed-synthetic-data'); await browser.evaluate('globalThis.__passwordRotationQA.seed()');
  at('configure-real-r2'); await configure(config, oldPassword); await sync();
  const baseline = await inspect();
  assert.equal(baseline.notes.length, 1); assert.equal(baseline.navigation.length, 1);
  at('production-password-change-form'); await button('修改同步密码');
  await screenshot('password-change-form-empty.png', '.cloud-password-change');
  for (const [label, value] of [['当前同步密码', oldPassword], ['新同步密码', newPassword], ['确认新同步密码', newPassword]]) await fill(label, value);
  await button('更新同步密码');
  await wait(`document.querySelector('.cloud-action-feedback')?.textContent.includes('请用新密码重新解锁') && Boolean((${buttonExpression('解锁')}) && !(${buttonExpression('解锁')}).disabled)`, 'Password cutover locked');
  assert.equal(await browser.evaluate("document.querySelectorAll('input[type=password]').length===1 && document.querySelector('input[type=password]').value===''"), true);
  assert.deepEqual(await inspect(), baseline);
  receipt.envelopeAfterRotation = await browser.evaluate(`Promise.all([globalThis.__passwordRotationQA.canOpenEnvelope(${JSON.stringify(oldPassword)}),globalThis.__passwordRotationQA.canOpenEnvelope(${JSON.stringify(newPassword)})]).then(([oldPassword,newPassword])=>({oldPassword,newPassword}))`);
  assert.equal(receipt.envelopeAfterRotation.oldPassword.opens, false);
  assert.equal(receipt.envelopeAfterRotation.newPassword.opens, true);
  await screenshot('password-change-locked.png');
  at('old-password-rejected'); await unlock(oldPassword, 'rejected');
  at('new-password-explicit-unlock'); await unlock(newPassword, 'accepted'); await sync();
  assert.deepEqual(await inspect(), baseline);
  at('restart-same-chrome-profile'); await browser.close(); browser = undefined;
  browser = await startRecordMergeBrowser('chrome', { headless: false, output, extensionRoot: artifact, existingProfile: profile });
  await loadBridge(); await openSettings();
  await wait(`Boolean(${buttonExpression('解锁')})`, 'Restart stays locked');
  assert.equal(await browser.evaluate("document.querySelector('input[type=password]')?.value===''"), true);
  at('new-password-after-browser-restart'); await unlock(newPassword, 'accepted'); await sync();
  assert.deepEqual(await inspect(), baseline);
  await screenshot('password-change-restarted-synced.png');
  receipt.result = 'passed'; receipt.checks = { actualProductionPasswordForm: true, successfulCutoverRequiresUnlock: true, oldPasswordRejected: true,
    newPasswordExplicitlyUnlocked: true, sameProfileBrowserRestart: true, sessionClearedAcrossRestart: true, normalSyncAfterRestart: true,
    contentUnchanged: true, notes: baseline.notes.length, navigation: baseline.navigation.length };
  receipt.remote = { provider: 'r2', uniqueSyntheticTestPrefix: true, encryptedEvidenceRetained: true };
  at('passed');
} catch (error) {
  receipt.result = 'failed'; receipt.failureStage = stage; receipt.failureCode = error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VERIFICATION_FAILED';
  console.error(JSON.stringify({ result: receipt.result, stage, code: receipt.failureCode })); process.exitCode = 1;
} finally {
  const cleanup = [];
  try { await browser?.close(); } catch { cleanup.push('BROWSER_PROFILE_CLEANUP_FAILED'); }
  for (const [candidate, prefix] of [[profile, 'raw-record-merge-profile-chrome-'], [artifact, 'password-rotation-build-']]) if (candidate) {
    try {
      const actual = await realpath(candidate), root = await realpath(output), relative = path.relative(root, actual);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith(prefix)) throw Error('Unsafe cleanup path');
      await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) { if (error.code !== 'ENOENT') cleanup.push(prefix.startsWith('raw-') ? 'PROFILE_CLEANUP_FAILED' : 'BUILD_CLEANUP_FAILED'); }
  }
  if (cleanup.length) receipt.cleanup = cleanup;
  receipt.finishedAt = new Date().toISOString();
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'browser-r2.json'), JSON.stringify(receipt, null, 2));
}
