// Branded Chrome/Edge acceptance harness using their native CDP endpoints.
// No browser automation framework or production browser profile is used.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = path.resolve(appRoot, '..');
export const acceptanceOutput = path.join(workspaceRoot, 'output', 'playwright', 'covelet', 'record-merge-browser-acceptance');
const browserPaths = {
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
};
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nativeCdp(endpoint) {
  const ws = new WebSocket(endpoint), pending = new Map(), handlers = new Map();
  let sequence = 0;
  const ready = new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const job = pending.get(message.id); if (!job) return;
      clearTimeout(job.timer); pending.delete(message.id);
      if (message.error) job.reject(Object.assign(Error(`CDP ${job.method} failed (${message.error.code})`), { cdpError: message.error }));
      else job.resolve(message.result);
    } else for (const handler of handlers.get(message.method) || []) handler(message.params, message.sessionId);
  });
  ws.addEventListener('close', () => {
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(Error(`CDP connection closed during ${job.method}`)); }
    pending.clear();
  });
  return {
    ready,
    async send(method, params = {}, sessionId) {
      await ready;
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP ${method} timed out`)); }, 30000);
        pending.set(id, { resolve, reject, timer, method });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
      });
    },
    on(method, handler) { if (!handlers.has(method)) handlers.set(method, new Set()); handlers.get(method).add(handler); return () => handlers.get(method)?.delete(handler); },
    close() { ws.close(); },
  };
}

async function removeOwnedProfile(profile, output) {
  const actual = await realpath(profile), root = await realpath(output);
  const relative = path.relative(root, actual);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith('raw-record-merge-profile-')) throw Error('Unsafe acceptance profile cleanup path');
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await rm(actual, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); return; }
    catch (error) { if (attempt === 29) throw error; await delay(200); }
  }
}

// The caller MUST close() in finally. Exported to support the live two-profile
// test while retaining its authentication entirely inside the test process.
export async function startRecordMergeBrowser(browserName, { headless = true, output = acceptanceOutput, extensionRoot = path.join(appRoot, 'dist', 'extension'), existingProfile, preserveProfile = false } = {}) {
  const executable = browserPaths[browserName];
  if (!executable) throw Error('Unknown acceptance browser');
  const extension = await realpath(extensionRoot);
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  await mkdir(output, { recursive: true });
  const profile = existingProfile ? await realpath(existingProfile) : await mkdtemp(path.join(output, `raw-record-merge-profile-${browserName}-`));
  if (existingProfile) {
    const relative = path.relative(await realpath(output), profile);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(profile).startsWith(`raw-record-merge-profile-${browserName}-`)) throw Error('Unsafe acceptance profile reuse path');
    // The old endpoint file survives a normal browser exit. Read only the new
    // process's endpoint, after validating this test-owned profile path.
    await rm(path.join(profile, 'DevToolsActivePort'), { force: true });
  }
  const process = spawn(executable, [
    ...(headless ? ['--headless=new'] : []), '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--lang=zh-CN', '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--edge-skip-compat-layer-relaunch',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  let cdp, closed = false, launchError;
  process.once('error', (error) => { launchError = error; });
  const close = async () => {
    if (closed) return;
    closed = true;
    if (cdp && process.exitCode === null) {
      try { await cdp.send('Browser.close'); } catch { /* Browser closure can precede its acknowledgement. */ }
    }
    cdp?.close();
    for (let attempt = 0; attempt < 50 && process.exitCode === null; attempt++) await delay(100);
    if (process.pid && process.exitCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* It may already have exited. */ }
    }
    if (!preserveProfile) await removeOwnedProfile(profile, output);
  };
  try {
    let port, version;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (launchError) throw launchError;
      if (process.exitCode !== null) throw Error(`${browserName} exited before opening its debugging endpoint`);
      try {
        const candidate = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
        if (/^\d+$/u.test(candidate)) {
          const response = await fetch(`http://127.0.0.1:${candidate}/json/version`, { signal: AbortSignal.timeout(1000) });
          const info = await response.json();
          if (response.ok && typeof info.webSocketDebuggerUrl === 'string') { port = candidate; version = info; break; }
        }
      } catch { /* Starting. */ }
      await delay(100);
    }
    if (!port) throw Error(`${browserName} did not open a debugging endpoint`);
    const endpoint = `http://127.0.0.1:${port}`;
    const protocol = await (await fetch(`${endpoint}/json/protocol`)).json();
    const extensions = protocol.domains.find((domain) => domain.domain === 'Extensions');
    if (!extensions?.commands.some((command) => command.name === 'loadUnpacked')) throw Error(`${browserName} does not advertise Extensions.loadUnpacked`);
    cdp = nativeCdp(version.webSocketDebuggerUrl);
    await cdp.ready;
    const loaded = await cdp.send('Extensions.loadUnpacked', { path: extension });
    let extensionId = loaded.id, workerSessionId;
    for (let attempt = 0; attempt < 150 && !workerSessionId; attempt++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      for (const worker of targetInfos.filter((target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension://') && target.url.endsWith('/background.js'))) {
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
        const result = await cdp.send('Runtime.evaluate', { expression: '({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest() })', returnByValue: true }, sessionId);
        const actual = result.result.value;
        if (actual?.manifest.name === 'Covelet' && actual.manifest.version === manifest.version
          && actual.manifest.chrome_url_overrides?.newtab === manifest.chrome_url_overrides.newtab) {
          extensionId = actual.id; workerSessionId = sessionId; break;
        }
        await cdp.send('Target.detachFromTarget', { sessionId });
      }
      if (!workerSessionId) await delay(100);
    }
    if (!extensionId || !workerSessionId) throw Error(`${browserName} did not start the Covelet extension worker`);
    const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/newtab.html` });
    const { sessionId: pageSessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, pageSessionId);
    await cdp.send('Page.enable', {}, pageSessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, pageSessionId);
    const evaluate = async (expression, { worker = false } = {}) => {
      const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, worker ? workerSessionId : pageSessionId);
      // Avoid including evaluated code or browser exception bodies: either may
      // contain the live provider configuration supplied by the test caller.
      if (result.exceptionDetails) throw Error(`${browserName} extension evaluation failed`);
      return result.result.value;
    };
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate("document.readyState === 'complete' && Boolean(document.querySelector('#root')?.childElementCount)")) break;
      if (attempt === 149) throw Error(`${browserName} extension page did not render`);
      await delay(100);
    }
    return { browserName, processId: process.pid, profile, endpoint, browserVersion: version.Browser,
      extensionId, extensionVersion: manifest.version, workerSessionId, pageSessionId, targetId, cdp, evaluate, close,
      async screenshot(name = `${browserName}-extension.png`) {
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }, pageSessionId);
        const destination = path.join(output, path.basename(name));
        await writeFile(destination, Buffer.from(screenshot.data, 'base64')); return destination;
      },
    };
  } catch (error) { await close(); throw error; }
}

async function smoke() {
  const evidence = { date: '2026-11-24', method: 'Native browser CDP automated smoke; not manual acceptance', browsers: [] };
  for (const name of ['chrome', 'edge']) {
    let browser;
    try {
      browser = await startRecordMergeBrowser(name);
      const runtime = await browser.evaluate('({ id: chrome.runtime.id, name: chrome.runtime.getManifest().name, title: document.title, rendered: Boolean(document.querySelector("#root")?.childElementCount) })');
      await browser.screenshot();
      evidence.browsers.push({ name, version: browser.browserVersion, extensionId: browser.extensionId, extensionVersion: browser.extensionVersion, runtime, result: 'passed' });
      console.log(`${name}: ${browser.browserVersion}; Covelet ${browser.extensionVersion}; loaded and rendered`);
    } finally { await browser?.close(); }
  }
  await writeFile(path.join(acceptanceOutput, 'smoke.json'), JSON.stringify(evidence, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await smoke();
}
