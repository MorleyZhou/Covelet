import { test as base, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createNetworkFixture } from './network.mjs';

const extensionPath = fileURLToPath(new URL('../../dist/extension/', import.meta.url));
if (process.env.COVELET_NATIVE_BROWSER && !['chrome', 'edge'].includes(process.env.COVELET_NATIVE_BROWSER)) throw Error('COVELET_NATIVE_BROWSER must be chrome or edge.');
export const test = base.extend({
  pregrantedHosts: [[], { option: true }],
  network: async ({}, use) => { await use(createNetworkFixture()); },
  extension: async ({ headless, viewport, locale, timezoneId, hasTouch, network, pregrantedHosts }, use, testInfo) => {
    const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
    expect(manifest.name).toBe('Covelet');
    expect(manifest.chrome_url_overrides?.newtab).toBe('newtab.html');
    const sessions = [], errors = [];
    async function launch(previous) {
      const profile = previous?.profile || await mkdtemp(join(tmpdir(), 'covelet-playwright-'));
      const session = previous || { profile };
      if (!previous) sessions.push(session);
      let path = extensionPath;
      if (pregrantedHosts.length) {
        // Synthetic provider tests grant only their exact host in a temporary copy.
        path = join(profile, 'test-extension');
        if (!previous) {
          await cp(extensionPath, path, { recursive: true });
          await writeFile(join(path, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: [...manifest.host_permissions, ...pregrantedHosts] }));
        }
      }
      const context = await chromium.launchPersistentContext(profile, {
        ...(process.env.COVELET_NATIVE_BROWSER ? {
          executablePath: ({ chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe', edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' })[process.env.COVELET_NATIVE_BROWSER],
          ignoreDefaultArgs: ['--disable-extensions'],
        } : { channel: 'chromium' }), headless, viewport, locale, timezoneId, hasTouch,
        args: [...(process.env.COVELET_NATIVE_BROWSER ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${path}`, `--load-extension=${path}`]), '--lang=zh-CN', '--no-first-run', '--disable-background-networking'],
      });
      session.context = context;
      await network.install(context);
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      session.tracing = true;
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      if (process.env.COVELET_NATIVE_BROWSER) {
        const cdp = await context.browser().newBrowserCDPSession();
        const actualBrowser = await cdp.send('Browser.getVersion');
        testInfo.annotations.push({ type: 'native-browser', description: actualBrowser.product });
        await cdp.send('Extensions.loadUnpacked', { path });
        await cdp.detach();
      }
      let worker, id;
      await expect.poll(async () => {
        for (const candidate of context.serviceWorkers()) {
          if (!candidate.url().startsWith('chrome-extension://')) continue;
          const actual = await candidate.evaluate(() => ({ manifest: chrome.runtime.getManifest(), id: chrome.runtime.id })).catch(() => null);
          if (actual?.manifest.name === 'Covelet' && actual.manifest.chrome_url_overrides?.newtab === manifest.chrome_url_overrides.newtab) {
            expect(actual.manifest.version).toBe(manifest.version);
            expect(actual.manifest.permissions).toEqual(manifest.permissions);
            expect(new URL(candidate.url()).hostname).toBe(actual.id);
            worker = candidate; id = actual.id; return id;
          }
        }
        return null;
      }, { timeout: 20_000, message: 'Covelet MV3 worker must identify itself by its runtime manifest' }).not.toBeNull();
      Object.assign(session, { worker, id });
      session.restart = async () => {
        await context.tracing.stop();
        session.tracing = false;
        await context.close();
        session.context = null;
        return launch(session);
      };
      session.newtab = async () => {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${id}/${manifest.chrome_url_overrides.newtab}`);
        await expect(page.locator('.owntab')).toBeVisible();
        await expect(page.getByRole('combobox', { name: '搜索或输入网址' })).toBeVisible();
        expect(new URL(page.url()).protocol).toBe('chrome-extension:');
        expect(await page.evaluate(() => chrome.runtime.id)).toBe(id);
        return page;
      };
      return session;
    }
    let failure;
    try {
      const initial = await launch();
      await use({ ...initial, launch });
      expect(errors, 'extension pages must have no uncaught JavaScript errors').toEqual([]);
      expect(network.unexpected, 'only explicitly allowed network fixtures may be contacted').toEqual([]);
    } catch (error) { failure = error; }
    finally {
      const failed = Boolean(failure) || testInfo.status !== testInfo.expectedStatus;
      for (const [index, { context, profile, tracing }] of sessions.entries()) {
        try {
        if (context && failed) {
          for (const [pageIndex, page] of context.pages().entries()) {
            if (!page.url().startsWith('chrome-extension://')) continue;
            const path = testInfo.outputPath(`extension-${index}-${pageIndex}.png`);
            await page.screenshot({ path, fullPage: true }).then(() => testInfo.attach(`extension-${index}-${pageIndex}`, { path, contentType: 'image/png' })).catch(() => {});
          }
          const trace = testInfo.outputPath(`trace-${index}.zip`);
          if (tracing) {
            await context.tracing.stop({ path: trace });
            await testInfo.attach(`trace-${index}`, { path: trace, contentType: 'application/zip' });
          }
        } else if (tracing) await context.tracing.stop();
        } finally {
        await context?.close();
        expect(dirname(resolve(profile))).toBe(resolve(tmpdir()));
        expect(basename(profile)).toMatch(/^covelet-playwright-/);
        await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        }
      }
      await testInfo.attach('network-and-errors', { body: JSON.stringify({ requests: network.requests, unexpected: network.unexpected, errors }, null, 2), contentType: 'application/json' });
    }
    if (failure) throw failure;
  },
});
export { expect };

export async function openSettings(page, tab) {
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  await expect(dialog).toBeVisible();
  if (tab) await dialog.getByRole('tab', { name: tab, exact: true }).click();
  return dialog;
}
export async function openSync(page) {
  await page.getByRole('button', { name: '打开扩展', exact: true }).click();
  await page.locator('#extension-custom-storage-sync').click();
  const form = page.getByRole('dialog', { name: '自备存储同步', exact: true }).locator('.cloud-sync-form');
  await expect(form).toBeVisible();
  return form;
}
export async function addSite(page, name, url) {
  await page.getByRole('button', { name: '添加网站', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加网站', exact: true });
  await dialog.getByLabel('网址', { exact: true }).fill(url);
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.site-name').filter({ hasText: name })).toBeVisible();
}
