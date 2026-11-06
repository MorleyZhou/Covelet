// Isolated unpacked-extension UI checks. All HTTPS responses are intercepted.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import actions from './fixtures/bookmarks/actions.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const profile = await mkdtemp(path.join(tmpdir(), 'covelet-bookmarks-qa-'));
const root = fileURLToPath(new URL('..', import.meta.url));
const extension = path.join(root, 'dist/extension'), output = path.join(root, 'output/0.2.2-bookmarks');
await mkdir(output, { recursive: true });
const chrome = spawn(process.env.COVELET_CHROMIUM || '/opt/ungoogled-chromium/chrome', ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-background-networking','--no-first-run','--lang=zh-CN',`--user-data-dir=${profile}`, '--remote-debugging-port=0', `--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) { try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await delay(100); } }
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let serial = 0; const pending = new Map(), errors = [], handlers = new Map();
  ws.onmessage = event => { const data = JSON.parse(event.data); if (data.id) { const job = pending.get(data.id); pending.delete(data.id); data.error ? job.reject(data.error) : job.resolve(data.result); } else { if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails); for (const fn of handlers.get(data.method) || []) Promise.resolve(fn(data.params)).catch(error => errors.push(String(error))); } };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})); });
  let extId;
  for (let i = 0; i < 100 && !extId; i++) {
    const { targetInfos } = await send('Target.getTargets');
    for (const worker of targetInfos.filter(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://') && target.url.endsWith('/background.js'))) {
      const { sessionId } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
      try {
        const result = await send('Runtime.evaluate', {
          expression: "(() => { const manifest = chrome.runtime.getManifest(); return manifest.name === 'Covelet' && manifest.chrome_url_overrides?.newtab === 'newtab.html'; })()",
          returnByValue: true,
        }, sessionId);
        if (result.result.value === true) { extId = new URL(worker.url).hostname; break; }
      } finally { await send('Target.detachFromTarget', { sessionId }); }
    }
    if (!extId) await delay(100);
  }
  if (!extId) throw Error('Extension did not load');
  const {targetId} = await send('Target.createTarget',{url:'about:blank'});
  const {sessionId} = await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Runtime.enable',{},sessionId);
  await send('Page.enable',{},sessionId);
  await send('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false},sessionId);
  const evaluate = async expression => { const r = await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true},sessionId); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };

  const args = {evaluate,on:(method,fn)=>handlers.set(method,[...(handlers.get(method)||[]),fn]),send:(m,p)=>send(m,p,sessionId),delay,writeFile,extId,output};
  await actions(args);
  assert.deepEqual(errors, [], "no page runtime or fixture handler exceptions");
  console.log(`Unpacked bookmark import checks passed. Evidence: ${output}`);
  const screenshot = await send('Page.captureScreenshot',{format:'png'},sessionId);
  await writeFile(path.join(output, 'final.png'),Buffer.from(screenshot.data,'base64'));
} finally {
  ws?.close();
  if (chrome.exitCode === null) { const closed = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill('SIGTERM'); await closed; }
  await rm(profile, { recursive: true, force: true });
}
