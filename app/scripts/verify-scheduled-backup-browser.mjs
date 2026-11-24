// Native Chrome + production MV3 worker + native OPFS/IndexedDB capabilities.
// The test copy substitutes only the foreground directory picker with an OPFS
// directory; this is not an external operating-system folder-picker test.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { startRecordMergeBrowser, delay } from './verify-record-merge-browsers.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(appRoot, '../output/playwright/covelet/scheduled-backup');
const password = `Synthetic-backup-${randomUUID()}`;
let browser, artifact, stage = 'prepare-test-copy';
const receipt = { date: '2026-11-24', method: 'Automated native CDP on installed headed Chrome; actual production service worker',
  instrumentation: 'Current unpacked build copied unchanged, plus a test bridge using current domain APIs. window.showDirectoryPicker returns a real OPFS directory handle. No scheduler, capture, encryption, worker or retention behavior is mocked. No Playwright.',
  boundaries: ['OPFS directory, not an external operating-system folder picker', 'Automated acceptance, not a full human manual test'], stages: [] };
function at(name) { stage = name; receipt.stages.push(name); console.log(JSON.stringify({ stage: name })); }
async function wait(expression, label, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await browser.evaluate(expression)) return; await delay(150); }
  throw Object.assign(Error(label), { code: 'BROWSER_WAIT_TIMEOUT' });
}
async function click(expression) {
  const point = await browser.evaluate(`(() => { const e=(${expression}); if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  if (!point) throw Object.assign(Error('Expected enabled UI control missing'), { code: 'BROWSER_CONTROL_MISSING' });
  await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, browser.pageSessionId);
  await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, browser.pageSessionId);
  await browser.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, browser.pageSessionId);
  await delay(100);
}
const button = (text) => click(`Array.from(document.querySelectorAll('.scheduled-backup-settings button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`);
async function fill(label, value) {
  await browser.evaluate(`(() => { const input=Array.from(document.querySelectorAll('.scheduled-backup-form label')).find(e=>e.textContent.trim()===${JSON.stringify(label)})?.querySelector('input');if(!input||input.disabled)throw Error('Expected input missing');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await delay(60);
}

async function makeBridge() {
  await mkdir(output, { recursive: true });
  artifact = await mkdtemp(path.join(output, 'raw-scheduled-backup-build-'));
  await cp(path.join(appRoot, 'dist/extension'), artifact, { recursive: true });
  const source = `import {localData} from ${JSON.stringify(path.join(appRoot, 'src/lib/local-data.js'))};
    import {loadState,saveState,inspectBackup} from ${JSON.stringify(path.join(appRoot, 'src/lib/storage.js'))};
    import {saveNote} from ${JSON.stringify(path.join(appRoot, 'src/lib/personal-tools.js'))};
    import {createPrivacyCredential} from ${JSON.stringify(path.join(appRoot, 'src/lib/privacy-lock.js'))};
    import {scheduledBackups} from ${JSON.stringify(path.join(appRoot, 'src/lib/scheduled-backup.js'))};
    import {scheduledBackupStore} from ${JSON.stringify(path.join(appRoot, 'src/lib/scheduled-backup-store.js'))};
    import {decryptCompleteBackup} from ${JSON.stringify(path.join(appRoot, 'src/lib/password-backup.js'))};
    const directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('Covelet-QA-Scheduled-Backups',{create:true});
    const originalPicker=globalThis.showDirectoryPicker;
    const qa={directory,pickerCalls:0,hiddenId:null,verifier:null,
      async seed(){
        await localData.set({'covelet.language.v1':'zh-CN'});
        const prior=await saveNote({title:'Hidden scheduled backup note',body:'QA_HIDDEN_PRIOR_BACKUP_BODY',pinned:false});
        const hidden=await saveNote({id:prior.id,revision:prior.revision,title:prior.title,body:'QA_HIDDEN_BACKUP_BODY',pinned:false});this.hiddenId=hidden.id;
        await saveNote({title:'Public scheduled backup note',body:'QA_PUBLIC_BACKUP_BODY',pinned:false});
        const state=await loadState();state.entries.push({id:'qa-scheduled-site',type:'site',name:'Scheduled backup navigation',url:'https://example.com/qa-scheduled',groupId:state.groups[0].id,parentId:null,order:state.entries.filter(e=>e.parentId===null).length,icon:{kind:'letter',value:'Q'}});await saveState(state,state.revision);
        const credential=await createPrivacyCredential('QA_HIDDEN_PASSWORD_ONLY');this.verifier=credential.verifier;
        await localData.set({'covelet.content.preferences.v1':{version:1,revision:0,aliases:{},privateKeys:['note:'+hidden.id,'site:qa-scheduled-site'],presentation:false},'covelet.privacy.lock.v1':credential,'covelet.ai.connection.v1':{apiKey:'QA_ACCESS_CREDENTIAL_ONLY'}});
      },
      async lockHidden(){await localData.update('covelet.content.preferences.v1',p=>({...p,presentation:true,revision:p.revision+1}));},
      async restoreSeedReferences(){const values=await localData.get(['covelet.tools.v1','covelet.privacy.lock.v1']);this.hiddenId=values['covelet.tools.v1'].notes.find(n=>n.body==='QA_HIDDEN_BACKUP_BODY').id;this.verifier=values['covelet.privacy.lock.v1'].verifier;},
      settings:()=>scheduledBackups.getSettings(),
      runWorker:()=>chrome.runtime.sendMessage({type:'covelet:backup:run'}),
      async audit(password){
        const settings=await scheduledBackups.getSettings(),raw=await scheduledBackupStore.read();
        const files=[],ivs=[],salts=[];let hiddenIncluded=true,navigationIncluded=true,secretsExcluded=true,encryptedOnly=true,flagsIncluded=true,historyIncluded=true,completeV2=true;
        for await(const [name,handle]of directory.entries()){
          if(handle.kind!=='file'){encryptedOnly=false;continue;}
          const file=await handle.getFile(),bytes=new Uint8Array(await file.arrayBuffer());
          const text=new TextDecoder().decode(bytes);encryptedOnly&&=name.endsWith('.covelet')&&new TextDecoder().decode(bytes.slice(0,8))==='CVLTBAK\\0'&&!text.includes('QA_HIDDEN_BACKUP_BODY');
          const decoded=await decryptCompleteBackup(file,password),plain=await decoded.text(),data=JSON.parse(plain);
          hiddenIncluded&&=data.tools.notes.some(n=>n.id===this.hiddenId&&n.body==='QA_HIDDEN_BACKUP_BODY');flagsIncluded&&=data.preferences.privateKeys.includes('note:'+this.hiddenId);
          completeV2&&=data.format==='covelet-complete-backup'&&data.version===2;
          historyIncluded&&=data.noteHistory?.version===1&&data.noteHistory.notes[this.hiddenId]?.some(v=>v.record.body==='QA_HIDDEN_PRIOR_BACKUP_BODY');
          secretsExcluded&&=!['QA_ACCESS_CREDENTIAL_ONLY','QA_HIDDEN_PASSWORD_ONLY',this.verifier].some(value=>plain.includes(value));
          const zip=new Blob([Uint8Array.from(atob(data.navigation),c=>c.charCodeAt(0))]);const navigation=await inspectBackup(zip);navigationIncluded&&=navigation.state.entries.some(e=>e.id==='qa-scheduled-site');
          const hex=values=>[...values].map(b=>b.toString(16).padStart(2,'0')).join('');ivs.push(hex(bytes.slice(36,48)));salts.push(hex(bytes.slice(20,36)));files.push({name,size:file.size});
        }
        return {files,managedCount:settings.files.length,phase:settings.phase,lastSuccess:settings.lastSuccess,lastError:settings.lastError?.code||null,
          hiddenIncluded,flagsIncluded,navigationIncluded,secretsExcluded,encryptedOnly,completeV2,historyIncluded,freshIVs:new Set(ivs).size===files.length,sameConfiguredSalt:new Set(salts).size===1,
          passwordStored:JSON.stringify(raw).includes(password),nativeKey:raw.key instanceof CryptoKey&&raw.key.extractable===false&&raw.key.usages.length===1&&raw.key.usages[0]==='encrypt',nativeDirectory:raw.directory instanceof FileSystemDirectoryHandle,pickerCalls:this.pickerCalls};
      },
      async makeDue(){const state=await scheduledBackupStore.read();state.nextDue=Date.now()-1;await scheduledBackupStore.write(state);await chrome.alarms.create('covelet:backup:due',{when:Date.now()+1000});return true;},
      restoreNativePicker(){globalThis.showDirectoryPicker=originalPicker;}
    };
    globalThis.__scheduledBackupQA=qa;
    globalThis.showDirectoryPicker=async()=>{qa.pickerCalls++;return directory;};`;
  await build({ stdin: { contents: source, resolveDir: appRoot, sourcefile: 'scheduled-backup-test-bridge.js' }, outfile: path.join(artifact, 'scheduled-backup-test-bridge.js'),
    bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', define: { 'import.meta.env': '{}' }, logLevel: 'silent',
    plugins: [{ name: 'qa-wasm', setup(plugin) {
      plugin.onResolve({ filter: /\.wasm\?url$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]), namespace: 'qa-wasm' }));
      plugin.onLoad({ filter: /.*/, namespace: 'qa-wasm' }, async (args) => { const name=`qa-${path.basename(args.path)}`;await cp(args.path,path.join(artifact,name));return {contents:`export default chrome.runtime.getURL(${JSON.stringify(name)});`,loader:'js'}; });
    } }],
  });
}

try {
  await makeBridge();
  at('launch-headed-native-chrome');
  browser = await startRecordMergeBrowser('chrome', { headless: false, output, extensionRoot: artifact });
  receipt.browser = browser.browserVersion; receipt.extensionVersion = browser.extensionVersion;
  await browser.evaluate("import(chrome.runtime.getURL('scheduled-backup-test-bridge.js'))");
  await browser.evaluate('globalThis.__scheduledBackupQA.seed()');
  await wait("document.documentElement.lang==='zh-CN'", 'Chinese UI');
  at('configure-daily-backup-through-production-ui');
  await click("document.querySelector('button[aria-label=\"打开设置\"]')");
  await wait("Boolean(document.querySelector('#settings-tab-backup'))", 'Settings tabs');
  await click("document.querySelector('#settings-tab-backup')");
  await wait("Boolean(Array.from(document.querySelectorAll('.scheduled-backup-settings button')).find(e=>e.textContent.trim()==='设置定时备份'&&!e.disabled))", 'Scheduled settings');
  await button('设置定时备份'); await button('选择备份目录');
  await wait("document.querySelector('.scheduled-backup-directory')?.textContent.includes('Covelet-QA-Scheduled-Backups')", 'OPFS picker result');
  await fill('备份密码', password); await fill('确认备份密码', password); await button('保存备份计划');
  await wait("!document.querySelector('.scheduled-backup-form')&&Boolean(Array.from(document.querySelectorAll('.scheduled-backup-settings button')).find(e=>e.textContent.trim()==='立即备份'&&!e.disabled))", 'Saved daily plan');
  assert.equal((await browser.evaluate('globalThis.__scheduledBackupQA.settings()')).frequency, 'daily');
  await browser.evaluate('globalThis.__scheduledBackupQA.lockHidden()');
  at('actual-worker-complete-capture-and-four-encrypted-writes');
  await button('立即备份');
  await wait("document.querySelector('.scheduled-backup-files')?.textContent.includes('.covelet')&&document.querySelector('.scheduled-backup-settings')?.getAttribute('aria-busy')==='false'", 'First real worker backup');
  for (let index = 0; index < 3; index++) {
    const result = await browser.evaluate('globalThis.__scheduledBackupQA.runWorker()');
    if (!result?.ok) throw Object.assign(Error('Worker backup failed'), { code: result?.error?.code || 'WORKER_BACKUP_FAILED' });
  }
  const firstAudit = await browser.evaluate(`globalThis.__scheduledBackupQA.audit(${JSON.stringify(password)})`);
  assert.equal(firstAudit.files.length, 3); assert.equal(firstAudit.managedCount, 3);
  for (const key of ['hiddenIncluded', 'flagsIncluded', 'navigationIncluded', 'secretsExcluded', 'encryptedOnly', 'completeV2', 'historyIncluded', 'freshIVs', 'sameConfiguredSalt', 'nativeKey', 'nativeDirectory']) assert.equal(firstAudit[key], true, key);
  assert.equal(firstAudit.passwordStored, false); assert.equal(firstAudit.pickerCalls, 1); assert.equal(firstAudit.phase, 'saved');
  await browser.screenshot('four-worker-backups.png');
  at('stop-worker-and-wake-with-real-alarm');
  const targets = await browser.cdp.send('Target.getTargets');
  const oldWorker = targets.targetInfos.find((item) => item.type === 'service_worker' && item.url === `chrome-extension://${browser.extensionId}/background.js`);
  assert.ok(oldWorker);
  await browser.cdp.send('Target.detachFromTarget', { sessionId: browser.workerSessionId });
  await browser.cdp.send('ServiceWorker.enable', {}, browser.pageSessionId);
  await browser.cdp.send('ServiceWorker.stopAllWorkers', {}, browser.pageSessionId);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const now = await browser.cdp.send('Target.getTargets');
    if (!now.targetInfos.some((item) => item.targetId === oldWorker.targetId)) break;
    await delay(100);
  }
  assert.ok(!(await browser.cdp.send('Target.getTargets')).targetInfos.some((item) => item.targetId === oldWorker.targetId), 'old worker terminated');
  await browser.evaluate('globalThis.__scheduledBackupQA.makeDue()');
  at('close-all-covelet-pages-before-alarm');
  for (const target of (await browser.cdp.send('Target.getTargets')).targetInfos.filter((item) => item.type === 'page' && item.url.startsWith(`chrome-extension://${browser.extensionId}/`)))
    await browser.cdp.send('Target.closeTarget', { targetId: target.targetId });
  const pageCloseDeadline = Date.now() + 15000;
  while (Date.now() < pageCloseDeadline && (await browser.cdp.send('Target.getTargets')).targetInfos.some((item) => item.type === 'page' && item.url.startsWith(`chrome-extension://${browser.extensionId}/`))) await delay(100);
  if ((await browser.cdp.send('Target.getTargets')).targetInfos.some((item) => item.type === 'page' && item.url.startsWith(`chrome-extension://${browser.extensionId}/`))) throw Object.assign(Error('Extension page did not close'), { code: 'COVELET_PAGE_STILL_OPEN' });
  at('wait-alarm-with-no-covelet-page');
  let newWorker, newSession;
  const alarmDeadline = Date.now() + 60000;
  while (Date.now() < alarmDeadline) {
    const targets = await browser.cdp.send('Target.getTargets');
    newWorker = targets.targetInfos.find((item) => item.type === 'service_worker' && item.url === `chrome-extension://${browser.extensionId}/background.js` && item.targetId !== oldWorker.targetId);
    if (newWorker) {
      if (!newSession) newSession = (await browser.cdp.send('Target.attachToTarget', { targetId: newWorker.targetId, flatten: true })).sessionId;
      // Inspect only native IndexedDB from the awakened production worker. No
      // extension page exists and no runtime backup request is sent here.
      const observed = await browser.cdp.send('Runtime.evaluate', { expression: `new Promise((resolve,reject)=>{const request=indexedDB.open('covelet.scheduled-backup.v1',1);request.onerror=()=>reject(Error('state unavailable'));request.onsuccess=()=>{const db=request.result,tx=db.transaction('schedule','readonly'),read=tx.objectStore('schedule').get('state');read.onsuccess=()=>{const s=read.result;resolve({lastSuccess:s?.lastSuccess,phase:s?.phase,error:s?.lastError?.code||null});};tx.oncomplete=()=>db.close();};})`, awaitPromise: true, returnByValue: true }, newSession);
      const state = observed.result?.value;
      if (state?.phase === 'error') throw Object.assign(Error('Automatic worker backup failed'), { code: state.error || 'WORKER_BACKUP_FAILED' });
      if (state?.lastSuccess > firstAudit.lastSuccess && state.phase === 'saved') break;
    }
    await delay(150);
  }
  if (!newWorker || Date.now() >= alarmDeadline) throw Object.assign(Error('Alarm worker wake timed out'), { code: 'BROWSER_WAIT_TIMEOUT' });
  assert.ok(newWorker && newWorker.targetId !== oldWorker.targetId);
  assert.ok(!(await browser.cdp.send('Target.getTargets')).targetInfos.some((item) => item.type === 'page' && item.url.startsWith(`chrome-extension://${browser.extensionId}/`)));
  at('reopen-covelet-after-page-free-worker-backup');
  const opened = await browser.cdp.send('Target.createTarget', { url: `chrome-extension://${browser.extensionId}/newtab.html` });
  const page = await browser.cdp.send('Target.attachToTarget', { targetId: opened.targetId, flatten: true });
  browser.targetId = opened.targetId; browser.pageSessionId = page.sessionId;
  await browser.cdp.send('Runtime.enable', {}, page.sessionId); await browser.cdp.send('Page.enable', {}, page.sessionId);
  await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, page.sessionId);
  browser.evaluate = async (expression) => {
    const result = await browser.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, page.sessionId);
    if (result.exceptionDetails) throw Object.assign(Error('Reopened extension evaluation failed'), { code: 'BROWSER_EVALUATION_FAILED' });
    return result.result.value;
  };
  browser.screenshot = async (name) => {
    const screenshot = await browser.cdp.send('Page.captureScreenshot', { format: 'png' }, page.sessionId);
    await writeFile(path.join(output, path.basename(name)), Buffer.from(screenshot.data, 'base64'));
  };
  await wait("document.readyState==='complete'&&Boolean(document.querySelector('#root')?.childElementCount)", 'Reopened extension');
  await browser.evaluate("import(chrome.runtime.getURL('scheduled-backup-test-bridge.js'))");
  await browser.evaluate('globalThis.__scheduledBackupQA.restoreSeedReferences()');
  await click("document.querySelector('button[aria-label=\"打开设置\"]')");
  await wait("Boolean(document.querySelector('#settings-tab-backup'))", 'Reopened settings');
  await click("document.querySelector('#settings-tab-backup')");
  await wait("Boolean(document.querySelector('.scheduled-backup-status'))", 'Persisted plan UI');
  const finalAudit = await browser.evaluate(`globalThis.__scheduledBackupQA.audit(${JSON.stringify(password)})`);
  assert.equal(finalAudit.files.length, 3); assert.equal(finalAudit.managedCount, 3); assert.equal(finalAudit.pickerCalls, 0);
  assert.equal(finalAudit.nativeKey, true); assert.equal(finalAudit.nativeDirectory, true); assert.equal(finalAudit.passwordStored, false);
  assert.equal(finalAudit.hiddenIncluded && finalAudit.flagsIncluded && finalAudit.navigationIncluded && finalAudit.secretsExcluded && finalAudit.encryptedOnly && finalAudit.completeV2 && finalAudit.historyIncluded && finalAudit.freshIVs, true);
  assert.ok(finalAudit.files.some((file) => !firstAudit.files.some((old) => old.name === file.name)));
  receipt.result = 'passed'; receipt.firstAudit = firstAudit; receipt.finalAudit = finalAudit;
  receipt.workerRestart = { oldTargetTerminated: true, newWorkerTarget: true, realAlarmCreatedNewBackup: true,
    noCoveletPageDuringAlarm: true, totalPickerCalls: firstAudit.pickerCalls + finalAudit.pickerCalls, pickerRequestedAgain: false };
  await browser.screenshot('worker-restart-alarm.png');
  at('passed');
  if (process.env.COVELET_QA_HOLD_BACKUP === '1') {
    at('ready-for-native-inspection');
    await browser.evaluate('globalThis.__scheduledBackupQA.restoreNativePicker()');
    await delay(60000);
  }
} catch (error) {
  receipt.result = 'failed'; receipt.failure = { stage, code: error instanceof assert.AssertionError ? 'ASSERTION_FAILED'
    : typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : 'BROWSER_VERIFICATION_FAILED' };
  if (browser) {
    try { receipt.scheduler = await browser.evaluate('globalThis.__scheduledBackupQA?.settings().then(s=>({phase:s.phase,error:s.lastError?.code||null,files:s.files.length}))'); } catch { /* The worker or page may not be available. */ }
    try { if (stage !== 'configure-daily-backup-through-production-ui') await browser.screenshot('failure.png'); } catch { /* Evidence cannot replace the actual failed result. */ }
  }
  console.error(JSON.stringify({ result: 'failed', ...receipt.failure, scheduler: receipt.scheduler })); process.exitCode = 1;
} finally {
  await browser?.close();
  if (artifact) {
    const actual = await realpath(artifact), root = await realpath(output), relative = path.relative(root, actual);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith('raw-scheduled-backup-build-')) throw Error('Unsafe QA build cleanup path');
    await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
}
