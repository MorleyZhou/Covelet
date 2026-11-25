// Official bundled Firefox + R2 using the authorized local test config.
// Production domain APIs are bundled into a test-only inspector; credentials
// cross the loopback automation channel in memory and are never logged.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { launchFirefoxMarionette, removeFirefoxProfile } from './lib/firefox-marionette-harness.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(appRoot, '../output/playwright/covelet/firefox/r2');
const receipt = { format: 'covelet-firefox-r2-verification', version: 1, startedAt: new Date().toISOString(),
  method: 'Official Playwright bundled Firefox157 (build1555), unchanged by this task, via native Marionette; real authenticated R2 and production sync/storage/crypto APIs in a test-only bridge. No WebDAV tests.',
  instrumentation: 'Two isolated profiles; test copy grants only configured R2 origin. No mock provider, crypto, storage or merge. UI core validation is a separate receipt.', stages: [] };
const devices = []; let artifact, stage = 'configuration';
const at = value => { stage = value; receipt.stages.push(value); console.log(JSON.stringify({ stage: value })); };
async function call(device, method, args = []) {
  const result = await device.command('WebDriver:ExecuteAsyncScript', { script: `const input=arguments[0],done=arguments[arguments.length-1];const receive=event=>{const result=JSON.parse(event.detail);if(result.id!==input.id)return;document.removeEventListener('covelet:firefox-r2-result',receive);done(result);};document.addEventListener('covelet:firefox-r2-result',receive);document.dispatchEvent(new CustomEvent('covelet:firefox-r2-request',{detail:JSON.stringify(input)}));`, args: [{ id:randomUUID(),method,args }], newSandbox: false }, 180000);
  if (!result.ok) throw Object.assign(Error(result.message || 'Firefox R2 operation failed'), { code: result.code, noteDiagnostic: method === 'add' });
  return result.value;
}
async function prepare(origin) {
  await mkdir(output, { recursive: true }); artifact = await mkdtemp(path.join(output, 'firefox-r2-extension-'));
  await cp(path.join(appRoot, 'dist/extension-firefox'), artifact, { recursive: true });
  await mkdir(path.join(artifact, 'wasm'), { recursive:true });
  await cp(path.join(appRoot, 'src/wasm/sync-core.wasm'), path.join(artifact, 'wasm/sync-core.wasm'));
  const manifestPath = path.join(artifact, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions.push(`${origin}/*`); await writeFile(manifestPath, JSON.stringify(manifest));
  const source = `import {localData,syncDataStore} from ${JSON.stringify(path.join(appRoot, 'src/lib/local-data.js'))};
    import {loadState,saveState} from ${JSON.stringify(path.join(appRoot, 'src/lib/storage.js'))};
    import {saveNote,loadPersonalToolsSnapshot} from ${JSON.stringify(path.join(appRoot, 'src/lib/personal-tools.js'))};
    import {createCloudSync} from ${JSON.stringify(path.join(appRoot, 'src/lib/cloud-sync.js'))};
    const cloud=createCloudSync();
    export const firefoxR2={
      language:()=>localData.set({'covelet.language.v1':'zh-CN'}),
      async configure(profile,secrets,password){await cloud.testCloudConnection(profile,secrets);await cloud.saveCloudSyncSettings(profile,secrets,password,{autoSync:false});return true;},
      sync:()=>cloud.syncCloudNow(),
      preview:()=>cloud.previewCloudSyncMerge(),
      merge:token=>cloud.applyCloudSyncMerge({token,choices:{}}),
      async add(title,body){return saveNote({title,body,pinned:false});},
      async edit(id,patch){const tools=await loadPersonalToolsSnapshot(),record=tools.notes.find(item=>item.id===id);return saveNote({...record,...patch});},
      async site(id,name){const state=await loadState();state.entries.push({id,type:'site',name,url:'https://example.invalid/'+id,groupId:state.groups[0].id,parentId:null,order:state.entries.filter(item=>item.parentId===null).length,icon:{kind:'letter',value:name.slice(0,1)}});await saveState(state,state.revision);return true;},
      async inspect(){const state=await loadState(),tools=await loadPersonalToolsSnapshot(),snapshot=await syncDataStore.snapshot();return {notes:tools.notes.map(({id,title,body})=>({id,title,body})).sort((a,b)=>a.id.localeCompare(b.id)),sites:state.entries.filter(item=>item.type==='site').map(({id,name,url})=>({id,name,url})).sort((a,b)=>a.id.localeCompare(b.id)),deviceOnlyExcluded:snapshot.records.every(item=>!['covelet.cloud.local.v1','covelet.cloud.session.v1','covelet.language.v1','covelet.reading-library.v1','covelet.rss.inbox.v1'].includes(item.key))};},
      lock:()=>cloud.lockCloudSync(),
      unlock:(password)=>cloud.unlockCloudSync(undefined,password)
    };
    // Execute the production APIs in the extension Window realm. Importing
    // directly into Marionette's sandbox creates cross-realm plain objects
    // that the production encrypted store correctly refuses.
    document.addEventListener('covelet:firefox-r2-request',async event=>{
      const {id,method,args}=JSON.parse(event.detail);let result;
      try{if(!Object.hasOwn(firefoxR2,method))throw Error();result={id,ok:true,value:await firefoxR2[method](...args)}}
      catch(error){result={id,ok:false,code:error.code||'R2_OPERATION_FAILED',message:method==='add'?String(error.message):null}}
      document.dispatchEvent(new CustomEvent('covelet:firefox-r2-result',{detail:JSON.stringify(result)}));
    });
    document.documentElement.dataset.firefoxR2Ready='1';`;
  await build({ stdin: { contents: source, resolveDir: appRoot }, outfile: path.join(artifact, 'firefox-r2-bridge.js'), bundle: true,
    format: 'esm', platform: 'browser', target: 'firefox140', define: { 'import.meta.env': '{}' }, logLevel: 'silent',
    plugins: [{ name: 'qa-local-wasm', setup(plugin) {
      plugin.onResolve({ filter: /\.wasm\?url$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.split('?')[0]), namespace: 'qa-wasm' }));
      plugin.onLoad({ filter: /.*/, namespace: 'qa-wasm' }, async args => { const name = `qa-${path.basename(args.path)}`; await cp(args.path, path.join(artifact, name)); return { contents: `export default browser.runtime.getURL(${JSON.stringify(name)});`, loader: 'js' }; });
    } }] });
}
try {
  const local = JSON.parse((await readFile(path.resolve(appRoot, '../output/playwright/covelet/live-config.local.json'), 'utf8')).replace(/^\uFEFF/u, ''));
  const config = local.r2;
  if (!config || ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'].some(key => typeof config[key] !== 'string' || !config[key].trim())) throw Error('R2_CONFIG_REQUIRED');
  const profile = { provider: 'r2', endpoint: config.endpoint, bucket: config.bucket,
    prefix: `${config.prefix || 'Covelet-QA'}/firefox-native-${Date.now()}-${randomUUID().slice(0, 8)}` };
  const secrets = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, ...(config.sessionToken && { sessionToken: config.sessionToken }) };
  const password = `Firefox-R2-${randomUUID()}`;
  await prepare(new URL(profile.endpoint).origin);
  at('launch-two-native-firefox-devices');
  for (let index = 0; index < 2; index++) {
    const device = await launchFirefoxMarionette({ extensionRoot: artifact, output }); devices.push(device);
    assert.equal(device.acceptInsecureCerts,false);
    await device.command('WebDriver:SetTimeouts', { implicit: 0, pageLoad: 30000, script: 180000 });
    const page = await device.newtab(); await page.waitFor('.owntab');
    await page.evaluate(async () => { await new Promise((resolve,reject)=>{const script=document.createElement('script');script.type='module';script.src=browser.runtime.getURL('firefox-r2-bridge.js');script.onload=()=>resolve(true);script.onerror=()=>reject(Error('Bridge load failed'));document.head.append(script)}); });
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.firefoxR2Ready),'1');
    await call(device, 'language');
  }
  receipt.browser = devices[0].browserVersion;
  const [a,b] = devices;
  at('seed-and-establish-real-r2-baseline'); const shared = await call(a, 'add', ['Firefox common note', 'Common Firefox baseline body']);
  await call(a, 'configure', [profile,secrets,password]); await call(a, 'sync');
  await call(b, 'configure', [profile,secrets,password]); await call(b, 'sync');
  await call(a, 'sync'); await call(b, 'sync');
  at('concurrent-edits-and-exclusive-content');
  await call(a, 'edit', [shared.id,{title:'Firefox shared title A'}]);
  await call(a, 'add', ['Firefox exclusive A','A-only content must survive']); await call(a, 'site', ['firefox-a-only','Firefox navigation A']);
  await call(b, 'edit', [shared.id,{body:'Firefox shared body B'}]);
  await call(b, 'add', ['Firefox exclusive B','B-only content must survive']); await call(b, 'site', ['firefox-b-only','Firefox navigation B']);
  await call(a, 'sync'); const conflicted = await call(b, 'sync'); assert.equal(conflicted.phase,'conflict');
  at('preview-and-record-merge'); const preview = await call(b, 'preview');
  receipt.preview = preview.rows.map(({kind,status,choice,conflict})=>({kind,status,choice,conflict}));
  assert(preview.rows.some(row=>row.status==='both')); assert(preview.rows.some(row=>row.status==='one'));
  await call(b, 'merge', [preview.token]);
  // Match the production UI: apply commits locally, then an explicit sync
  // publishes that new merged snapshot before the other device receives it.
  await call(b, 'sync'); await call(a, 'sync'); await call(b, 'sync');
  const stateA = await call(a,'inspect'), stateB = await call(b,'inspect');
  assert.deepEqual(stateA,stateB); assert.equal(stateA.notes.length,3); assert.equal(stateA.sites.length,2);
  const merged = stateA.notes.find(note=>note.id===shared.id); assert.equal(merged.title,'Firefox shared title A'); assert.equal(merged.body,'Firefox shared body B');
  assert.equal(stateA.deviceOnlyExcluded,true);
  at('lock-old-password-rejected-and-unlock'); await call(a,'lock');
  let rejected=false; try { await call(a,'unlock',['wrong-firefox-sync-password']); } catch { rejected=true; } assert.equal(rejected,true);
  await call(a,'unlock',[password]); await call(a,'sync');
  receipt.checks={realAuthenticatedR2:true,twoFirefoxDevices:true,recordPreviewAndMerge:true,uniqueNotesPreserved:2,uniqueNavigationPreserved:2,independentTitleBodyMerged:true,deviceSecretsExcluded:true,passwordUnlockAndWrongPasswordRejection:true};
  receipt.remote={isolatedSubdirectory:true,encryptedTestObjectsRetained:true,tlsCertificateValidation:true};
  receipt.result='passed'; at('passed');
} catch(error) {
  receipt.result='failed'; receipt.failureStage=stage; receipt.failureCode=error instanceof assert.AssertionError?'ASSERTION_FAILED':(typeof error.code==='string' ? error.code : 'FIREFOX_R2_FAILED');
  if(stage==='launch-two-native-firefox-devices') receipt.bootstrapFailure=String(error.message).slice(0,1200);
  if(error.noteDiagnostic) receipt.noteFailure=String(error.message).slice(0,500);
  if(error instanceof assert.AssertionError) receipt.assertion=String(error.message).slice(0,3000);
  console.error(JSON.stringify({stage,code:receipt.failureCode})); process.exitCode=1;
} finally {
  for(const device of devices.reverse()) { try { await device.close(); await removeFirefoxProfile(device.profile,output); } catch { (receipt.cleanup ||= []).push('PROFILE_CLEANUP_FAILED'); } }
  if(artifact) { try { const actual=await realpath(artifact), relative=path.relative(await realpath(output),actual); if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!path.basename(actual).startsWith('firefox-r2-extension-')) throw Error('Unsafe test cleanup'); await rm(actual,{recursive:true,force:true,maxRetries:5,retryDelay:100}); } catch { (receipt.cleanup ||= []).push('TEST_COPY_CLEANUP_FAILED'); } }
  receipt.finishedAt=new Date().toISOString(); await mkdir(output,{recursive:true}); await writeFile(path.join(output,'native-r2.json'),JSON.stringify(receipt,null,2));
}
