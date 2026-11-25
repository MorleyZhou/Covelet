// Real Firefox extension bootstrap: Playwright owns the isolated browser, while
// Mozilla's documented RDP add-ons actor installs the temporary WebExtension.
import { firefox } from 'playwright';
import { connect, createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function unusedPort() {
  const server = createServer(); await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function debuggerConnection(port) {
  let socket;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { socket = await new Promise((resolve, reject) => { const candidate = connect({ port, host: '127.0.0.1' }); candidate.once('error', reject); candidate.once('connect', () => resolve(candidate)); }); break; }
    catch { await delay(100); }
  }
  if (!socket) throw Error('Firefox loopback debugger did not start');
  let buffer = Buffer.alloc(0), active, helloResolve, helloReject;
  const hello = new Promise((resolve, reject) => { helloResolve = resolve; helloReject = reject; });
  const rejectPending = () => { active?.reject(Error('Firefox debugger disconnected')); helloReject(Error('Firefox debugger disconnected')); };
  socket.on('error', rejectPending); socket.on('close', rejectPending);
  socket.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length) {
      const colon = buffer.indexOf(58); if (colon === -1) return;
      const prefix = buffer.subarray(0, colon).toString();
      if (!/^\d{1,8}$/u.test(prefix) || Number(prefix) > 8 * 1024 * 1024) { socket.destroy(); return; }
      const length = Number(prefix); if (buffer.length < colon + 1 + length) return;
      let packet; try { packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length)); } catch { socket.destroy(); return; }
      buffer = buffer.subarray(colon + 1 + length);
      if (helloResolve) { helloResolve(packet); helloResolve = null; continue; }
      if (active && packet.from === active.to && !['tabListChanged', 'addonListChanged', 'tabNavigated'].includes(packet.type)) {
        const pending = active; active = null;
        packet.error ? pending.reject(Error(`Firefox debugger request failed: ${packet.error}: ${String(packet.message || '').slice(0, 1500)}`)) : pending.resolve(packet);
      }
    }
  });
  await Promise.race([hello, delay(10000).then(() => { throw Error('Firefox debugger greeting timed out'); })]);
  return {
    async request(to, type, properties = {}) {
      if (active) throw Error('Firefox debugger requests must be sequential');
      let timer;
      return new Promise((resolve, reject) => {
        const settle = fn => value => { clearTimeout(timer); fn(value); };
        active = { to, resolve: settle(resolve), reject: settle(reject) };
        timer = setTimeout(() => { active = null; reject(Error(`Firefox debugger ${type} timed out`)); }, 15000);
        const body = Buffer.from(JSON.stringify({ to, type, ...properties })); socket.write(Buffer.concat([Buffer.from(`${body.length}:`), body]));
      });
    },
    close() { socket.destroy(); },
  };
}
export async function removeFirefoxProfile(profile, output) {
  if (!profile) return;
  let actual; try { actual = await realpath(profile); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const root = await realpath(output), relative = path.relative(root, actual);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith('firefox-profile-')) throw Error('Unsafe Firefox test-profile cleanup');
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
export async function launchFirefoxExtension({ extensionRoot, output, profile: priorProfile, network, headless = true, firefoxUserPrefs = {} } = {}) {
  await mkdir(output, { recursive: true });
  const extension = await realpath(extensionRoot), manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  const profile = priorProfile || await mkdtemp(path.join(output, 'firefox-profile-'));
  if (priorProfile) {
    const actual = await realpath(priorProfile), relative = path.relative(await realpath(output), actual);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith('firefox-profile-')) throw Error('Unsafe Firefox test-profile reuse');
  }
  const port = await unusedPort(); let context, rdp;
  try {
    context = await firefox.launchPersistentContext(profile, { headless, viewport: { width: 1280, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
      acceptDownloads: true, ignoreHTTPSErrors: true, args: ['--start-debugger-server', String(port)],
      firefoxUserPrefs: { 'devtools.debugger.remote-enabled': true, 'devtools.debugger.prompt-connection': false,
        'devtools.debugger.force-local': true, 'devtools.chrome.enabled': true, 'browser.shell.checkDefaultBrowser': false, ...firefoxUserPrefs } });
    await network?.install(context);
    rdp = await debuggerConnection(port);
    const root = await rdp.request('root', 'getRoot'); if (!root.addonsActor) throw Error('Firefox has no temporary add-ons actor');
    const installed = await rdp.request(root.addonsActor, 'installTemporaryAddon', { addonPath: extension, openDevTools: false });
    const expected = manifest.browser_specific_settings?.gecko?.id;
    let addon;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await rdp.request('root', 'listAddons');
      addon = response.addons?.find(candidate => candidate.id === expected && candidate.manifestURL?.startsWith('moz-extension://'));
      if (addon) break; await delay(100);
    }
    if (!addon || !expected || installed.addon?.id && installed.addon.id !== expected) throw Error('Firefox did not identify the Covelet temporary extension');
    const manifestUrl = new URL(addon.manifestURL), origin = `${manifestUrl.protocol}//${manifestUrl.host}`, errors = [];
    const observe = page => page.on('pageerror', error => { if (page.url().startsWith('moz-extension://')) errors.push({ message: error.message, url: page.url() }); });
    context.pages().forEach(observe); context.on('page', observe);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    return { context, profile, origin, addon, errors, manifest, browserVersion: context.browser().version(),
      async newtab() { const page = await context.newPage(); await page.goto(`${origin}/${manifest.chrome_url_overrides.newtab}`, { waitUntil: 'domcontentloaded' }); await page.locator('.owntab').waitFor({ timeout: 30000 }); return page; },
      async close({ trace } = {}) { rdp?.close(); if (trace) await context.tracing.stop({ path: trace }); else await context.tracing.stop(); await context.close(); },
    };
  } catch (error) { rdp?.close(); await context?.close(); if (!priorProfile) await removeFirefoxProfile(profile, output); throw error; }
}
