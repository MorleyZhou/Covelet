// Test-only native Firefox automation. Uses the unmodified bundled executable;
// Marionette supports extension documents that Playwright's Juggler skips.
import { firefox } from 'playwright';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
async function deadline(promise, ms, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function ownedProfile(profile, output) {
  const actual = await realpath(profile), root = await realpath(output), relative = path.relative(root, actual);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(actual).startsWith('firefox-profile-')) throw Error('Unsafe Firefox test-profile path');
  return actual;
}
export async function removeFirefoxProfile(profile, output) {
  if (!profile) return;
  let actual;
  try { actual = await ownedProfile(profile, output); } catch (reason) { if (reason.code === 'ENOENT') return; throw reason; }
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
async function marionetteConnection(port, process) {
  let socket;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (process.exitCode !== null) throw Error('Firefox exited before Marionette started');
    try {
      socket = await new Promise((resolve, reject) => {
        const candidate = connect({ host: '127.0.0.1', port });
        candidate.once('error', reject); candidate.once('connect', () => resolve(candidate));
      }); break;
    } catch { await delay(100); }
  }
  if (!socket) throw Error('Firefox Marionette loopback connection timed out');
  let bytes = Buffer.alloc(0), nextId = 0, active, greet, rejectGreeting, queue = Promise.resolve();
  const greeting = new Promise((resolve, reject) => { greet = resolve; rejectGreeting = reject; });
  const disconnected = () => { active?.reject(Error('Firefox Marionette disconnected')); active = null; rejectGreeting(Error('Firefox Marionette disconnected')); };
  socket.on('error', disconnected); socket.on('close', disconnected);
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length) {
      const colon = bytes.indexOf(58); if (colon === -1) return;
      const prefix = bytes.subarray(0, colon).toString();
      if (!/^\d{1,9}$/u.test(prefix) || Number(prefix) > 32 * 1024 * 1024) { socket.destroy(); return; }
      const size = Number(prefix); if (bytes.length < colon + 1 + size) return;
      let packet; try { packet = JSON.parse(bytes.subarray(colon + 1, colon + 1 + size).toString()); } catch { socket.destroy(); return; }
      bytes = bytes.subarray(colon + 1 + size);
      if (greet) { greet(packet); greet = null; continue; }
      if (!Array.isArray(packet) || packet[0] !== 1 || !active || packet[1] !== active.id) continue;
      const pending = active; active = null;
      if (packet[2]) pending.reject(Object.assign(Error(`Firefox ${packet[2].error || 'command error'}: ${String(packet[2].message || '').slice(0, 1200)}`), { code: packet[2].error }));
      else pending.resolve(packet[3]);
    }
  });
  await deadline(greeting, 10000, 'Firefox Marionette greeting timed out');
  return {
    command(name, parameters = {}, timeout = 30000) {
      const perform = () => new Promise((resolve, reject) => {
        const id = ++nextId, timer = setTimeout(() => { active = null; reject(Error(`Firefox ${name} timed out`)); }, timeout);
        const settle = fn => value => { clearTimeout(timer); fn(value); };
        active = { id, resolve: settle(resolve), reject: settle(reject) };
        const body = Buffer.from(JSON.stringify([0, id, name, parameters]));
        socket.write(Buffer.concat([Buffer.from(`${body.length}:`), body]));
      });
      const pending = queue.catch(() => {}).then(perform); queue = pending.catch(() => {}); return pending;
    },
    close() { socket.destroy(); },
  };
}
const valueOf = result => result && Object.hasOwn(result, 'value') ? result.value : result;

export async function launchFirefoxMarionette({ extensionRoot, output, profile: priorProfile, headless = true, acceptInsecureCerts = false, firefoxUserPrefs = {} } = {}) {
  await mkdir(output, { recursive: true });
  const extension = await realpath(extensionRoot), manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  const profile = priorProfile ? await ownedProfile(priorProfile, output) : await mkdtemp(path.join(output, 'firefox-profile-'));
  const downloads = path.join(output, 'downloads'); await mkdir(downloads, { recursive: true });
  const port = await unusedPort(), prefs = {
    'marionette.enabled': true, 'marionette.port': port, 'marionette.host': '127.0.0.1',
    'browser.shell.checkDefaultBrowser': false, 'browser.startup.homepage_override.mstone': 'ignore',
    'browser.startup.homepage': 'about:blank', 'browser.startup.page': 0, 'browser.sessionstore.resume_from_crash': false,
    'datareporting.policy.dataSubmissionEnabled': false, 'datareporting.healthreport.uploadEnabled': false,
    'toolkit.telemetry.enabled': false, 'toolkit.telemetry.unified': false, 'browser.tabs.warnOnClose': false,
    'browser.download.folderList': 2, 'browser.download.dir': downloads, 'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false,
    'browser.helperApps.neverAsk.saveToDisk': 'application/json,application/zip,application/octet-stream,text/markdown,text/plain',
    'intl.accept_languages': 'zh-CN,zh,en', ...firefoxUserPrefs,
  };
  await writeFile(path.join(profile, 'user.js'), Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
  const process = spawn(firefox.executablePath(), ['-no-remote', '-profile', profile, '-marionette', '--remote-allow-system-access', ...(headless ? ['-headless'] : [])],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', client, exited = false;
  const exit = new Promise(resolve => { process.once('exit', () => { exited = true; resolve(); }); process.once('error', () => { exited = true; resolve(); }); });
  process.stdout.on('data', () => {}); process.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
  async function close() {
    if (client && !exited) await client.command('Marionette:Quit', { flags: ['eForceQuit'] }, 5000).catch(() => {});
    client?.close();
    if (!exited) await deadline(exit, 5000, 'Firefox has not exited yet').catch(() => {});
    if (!exited) { process.kill(); await deadline(exit, 5000, 'Firefox process did not exit').catch(() => {}); }
  }
  try {
    client = await marionetteConnection(port, process);
    const command = async (name, parameters, timeout) => valueOf(await client.command(name, parameters, timeout));
    const session = await command('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts, strictFileInteractability: false } } });
    await command('WebDriver:SetTimeouts', { implicit: 0, pageLoad: 30000, script: 30000 });
    const addonId = await command('Addon:Install', { path: extension, temporary: true });
    const expected = manifest.browser_specific_settings?.gecko?.id;
    if (!expected || addonId !== expected) throw Error('Firefox installed an unexpected temporary extension');
    await command('Marionette:SetContext', { value: 'chrome' });
    const origin = await command('WebDriver:ExecuteScript', { script: 'return WebExtensionPolicy.getByID(arguments[0]).getURL("").replace(/\\/$/, "");', args: [expected] });
    if (typeof origin !== 'string' || !/^moz-extension:\/\/[a-z\d-]+$/iu.test(origin)) throw Error('Firefox extension UUID could not be verified');
    await command('Marionette:SetContext', { value: 'content' });
    await command('WebDriver:SetWindowRect', { width: 1280, height: 900 });
    const evaluate = (fn, arg) => command('WebDriver:ExecuteScript', { script: `return (${fn.toString()})(arguments[0]);`, args: [arg ?? null], newSandbox: false });
    const pages = new Map(); let operations = Promise.resolve();
    const onPage = (handle, action) => {
      const operation = operations.catch(() => {}).then(async () => {
        await command('WebDriver:SwitchToWindow', { handle, focus: true }); return action();
      });
      operations = operation.catch(() => {}); return operation;
    };
    function pageFor(handle) {
      if (pages.has(handle)) return pages.get(handle);
      const find = selector => command('WebDriver:FindElement', { using: 'css selector', value: selector });
      const elementId = element => element?.[ELEMENT] || element?.ELEMENT || element?.id;
      const page = {
        handle,
        url: () => onPage(handle, () => command('WebDriver:GetCurrentURL')),
        goto: url => onPage(handle, () => command('WebDriver:Navigate', { url })),
        evaluate: (fn, arg) => onPage(handle, () => evaluate(fn, arg)),
        find: selector => onPage(handle, async () => {
          const element = await find(selector), id = elementId(element);
          if (!id) throw Error('Firefox did not return a native element identity');
          return { ...element, id, click: () => onPage(handle, () => command('WebDriver:ElementClick', { id })),
            sendKeys: text => onPage(handle, () => command('WebDriver:ElementSendKeys', { id, text: String(text) })),
            clear: () => onPage(handle, () => command('WebDriver:ElementClear', { id })) };
        }),
        click: selector => onPage(handle, async () => command('WebDriver:ElementClick', { id: elementId(await find(selector)) })),
        fill: (selector, text) => onPage(handle, async () => {
          const id = elementId(await find(selector)); await command('WebDriver:ElementClear', { id });
          await command('WebDriver:ElementSendKeys', { id, text: String(text) });
        }),
        setFiles: (selector, files) => onPage(handle, async () => command('WebDriver:ElementSendKeys', { id: elementId(await find(selector)), text: (Array.isArray(files) ? files : [files]).map(file => path.resolve(file)).join('\n') })),
        text: selector => onPage(handle, async () => command('WebDriver:GetElementText', { id: elementId(await find(selector)) })),
        async waitFor(selector, { timeout = 30000 } = {}) {
          const until = Date.now() + timeout; let reason;
          do { try { return await page.find(selector); } catch (error) { reason = error; await delay(100); } } while (Date.now() < until);
          throw reason;
        },
        screenshot: destination => onPage(handle, async () => {
          const bytes = Buffer.from(await command('WebDriver:TakeScreenshot', { full: false }), 'base64');
          if (destination) await writeFile(destination, bytes); return bytes;
        }),
        close: () => onPage(handle, () => command('WebDriver:CloseWindow')),
      };
      pages.set(handle, page); return page;
    }
    return { profile, origin, manifest, addonId, downloads, command, close, acceptInsecureCerts, stderr: () => stderr,
      browserVersion: session.capabilities?.browserVersion || session.browserVersion || 'unknown',
      async newtab(url = `${origin}/${manifest.chrome_url_overrides.newtab}`) {
        const result = await command('WebDriver:NewWindow', { type: 'tab', focus: true }), page = pageFor(result.handle);
        await page.goto(url); return page;
      },
      page: pageFor,
    };
  } catch (error) {
    await close(); if (!priorProfile) await removeFirefoxProfile(profile, output); throw error;
  }
}
