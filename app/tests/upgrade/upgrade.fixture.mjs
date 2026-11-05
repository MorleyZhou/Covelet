import { test as base, expect, chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, cp, rm, mkdir, readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { basename, dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createNetworkFixture, WEBDAV_BASE } from '../playwright/network.mjs';
import { packageDirectory } from './prepare-packages.mjs';

const currentBuild = fileURLToPath(new URL('../../dist/extension/', import.meta.url));
const markerId = createHash('sha256').update('record:preferences\0covelet.home-migration.v1').digest('hex');

// Read-only inspection of the actual encrypted store. Keys stay nonextractable
// inside the browser; content is created only through the old production UI.
export async function readRecords(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('covelet.encrypted.local.v1');
      request.onupgradeneeded = () => { request.transaction.abort(); reject(Error('The old UI must create its encrypted database')); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const [key, records] = await Promise.all([
        new Promise((resolve, reject) => {
          const request = db.transaction('keys').objectStore('keys').get('device-key-v1');
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        }),
        new Promise((resolve, reject) => {
          const request = db.transaction('records').objectStore('records').getAll();
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        }),
      ]);
      if (!(key instanceof CryptoKey) || key.extractable || key.algorithm.name !== 'AES-GCM') throw Error('Expected original nonextractable device key');
      const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
      const result = {};
      for (const record of records) {
        const plain = new Uint8Array(await crypto.subtle.decrypt({
          name: 'AES-GCM', iv: record.iv, tagLength: 128,
          additionalData: new TextEncoder().encode('covelet.encrypted.local.v1:1:' + record.space + ':' + record.id),
        }, key, record.ciphertext));
        if (plain[0] !== 67 || plain[1] !== 86 || plain[2] !== 76 || plain[3] !== 84) throw Error('Unexpected local envelope');
        const length = new DataView(plain.buffer).getUint32(4);
        const manifest = JSON.parse(new TextDecoder().decode(plain.subarray(8, 8 + length)));
        if (manifest[0] !== 1) throw Error('Unexpected local payload version');
        let offset = 8 + length;
        const chunks = manifest[2].map(size => { const bytes = plain.slice(offset, offset + size); offset += size; return bytes; });
        if (offset !== plain.length) throw Error('Invalid local payload length');
        async function unpack(node) {
          if (node[0] === 0) return null;
          if ([1, 2, 3].includes(node[0])) return node[1];
          if (node[0] === 4) return Promise.all(node[1].map(unpack));
          if (node[0] === 5) return Object.fromEntries(await Promise.all(node[1].map(async ([name, value]) => [name, await unpack(value)])));
          if (node[0] === 6) {
            const bytes = chunks[node[1]];
            return { __blob: true, type: node[2], size: bytes.length, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) };
          }
          throw Error('Unexpected local value type');
        }
        const [namespace, name, value] = await unpack(manifest[1]);
        const identity = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('record:' + namespace + '\0' + name)));
        if (identity !== record.id) throw Error('Record identity mismatch');
        (result[namespace] ||= {})[name] = value;
      }
      return result;
    } finally { db.close(); }
  });
}

export const test = base.extend({
  legacyNotificationGrant: [false, { option: true }],
  network: async ({}, use) => { await use(createNetworkFixture()); },
  upgrade: async ({ network, headless, viewport, locale, timezoneId, legacyNotificationGrant }, use, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), 'covelet-upgrade-'));
    const extensionPath = join(root, 'extension'), profile = join(root, 'profile'), sessions = [], errors = [];
    const oldSource = packageDirectory('old');
    const newSource = process.env.COVELET_UPGRADE_TARGET === 'release' ? packageDirectory('release') : currentBuild;
    let active, originalId, version;
    // Both versions occupy the exact same path. The entire profile, including
    // the original CryptoKey and IndexedDB, survives each browser shutdown.
    async function replaceProgram(source) {
      expect(dirname(extensionPath)).toBe(root);
      try { expect((await lstat(extensionPath)).isSymbolicLink()).toBe(false); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rm(extensionPath, { recursive: true, force: true });
      await mkdir(extensionPath);
      for (const entry of await readdir(source)) await cp(join(source, entry), join(extensionPath, entry), { recursive: true, dereference: false });
      if (source === oldSource && legacyNotificationGrant) {
        // Only the dedicated reminder case pregrants an already declared old
        // optional permission in a temporary copy. Never alter the pinned ZIP,
        // the package cache, or either production manifest.
        const path = join(extensionPath, 'manifest.json');
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        expect(manifest.optional_permissions).toContain('notifications');
        expect(manifest.permissions).not.toContain('notifications');
        manifest.permissions.push('notifications');
        manifest.optional_permissions = manifest.optional_permissions.filter(value => value !== 'notifications');
        await writeFile(path, JSON.stringify(manifest));
      }
    }
    async function closeActive() {
      if (active?.context) {
        active.trace = join(root, 'phase-' + sessions.indexOf(active) + '.zip');
        await active.context.tracing.stop({ path: active.trace });
        await active.context.close(); active.context = null;
      }
    }
    async function launch(source, options = {}) {
      await closeActive();
      await replaceProgram(source);
      const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
      version = manifest.version;
      const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless, viewport, locale, timezoneId,
        args: ['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath,
          '--lang=zh-CN', '--no-first-run', '--disable-background-networking', '--enable-unsafe-extension-debugging'],
      });
      const session = { context, profile, version, extensionPath, browserVersion: context.browser().version() };
      sessions.push(session); active = session;
      await network.install(context, { offline: Boolean(options.offline) });
      // Old and new user-save paths intentionally receive unavailable icons.
      await context.route(/^https:\/\/example\.com\/(?:favicon\.ico|apple-touch-icon(?:-precomposed)?\.png|android-chrome-192x192\.png)$/, route => options.offline
        ? route.abort('internetdisconnected') : route.fulfill({ status: 404, body: '' }));
      if (options.offline) await context.setOffline(true);
      if (options.failMigration) await context.addInitScript(({ markerId }) => {
        const put = IDBObjectStore.prototype.put;
        globalThis.__upgradeMigrationAborts = 0;
        IDBObjectStore.prototype.put = function (record, ...args) {
          if (this.name === 'records' && record?.id === markerId) {
            globalThis.__upgradeMigrationAborts++;
            this.transaction.abort();
            throw new DOMException('Synthetic upgrade transaction abort', 'AbortError');
          }
          return put.call(this, record, ...args);
        };
      }, { markerId });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      let worker;
      const identifyWorker = async (retiredWorker) => {
        for (const candidate of context.serviceWorkers()) {
          if (!candidate.url().startsWith('chrome-extension://')) continue;
          const runtime = await candidate.evaluate(() => ({
            id: chrome.runtime.id, manifest: chrome.runtime.getManifest(),
            ready: chrome.runtime.onStartup.hasListeners() && chrome.runtime.onInstalled.hasListeners(),
            clockListener: chrome.alarms.onAlarm.hasListeners(),
          })).catch(() => null);
          if (runtime?.manifest.name !== 'Covelet' || !runtime.ready || retiredWorker && runtime.clockListener) continue;
          expect(runtime.manifest.version).toBe(manifest.version);
          expect(runtime.manifest.permissions).toEqual(manifest.permissions);
          worker = candidate; session.id = runtime.id; return runtime.id;
        }
      };
      await expect.poll(() => identifyWorker(), { timeout: 20_000 }).toBeTruthy();
      if (originalId) expect(session.id, 'Upgrade must retain its native extension identity').toBe(originalId);
      else originalId = session.id;
      if (options.reloadExtension) {
        // Replacing unpacked files and relaunching can leave the previous
        // service-worker script cache alive despite a new getManifest version.
        // Use Chrome's native unpacked installer lifecycle, preserving all
        // installed data. No uninstall or storage rewrite is involved.
        const previousWorker = worker;
        if (options.beforeReload) await options.beforeReload({ context, worker, id: session.id });
        const browserSession = await context.browser().newBrowserCDPSession();
        try {
          const installed = await browserSession.send('Extensions.loadUnpacked', { path: extensionPath });
          expect(installed.id).toBe(originalId);
        } finally { await browserSession.detach(); }
        await expect.poll(() => identifyWorker(previousWorker), { timeout: 20_000,
          message: 'A native extension reload must execute the new background without the retired alarm listener' }).toBeTruthy();
        expect(session.id).toBe(originalId);
      }
      if (manifest.version === '0.3.0') {
        expect(await worker.evaluate(() => chrome.alarms.onAlarm.hasListeners()),
          'The retired clock alarm listener must not survive in the executing 0.3.0 background').toBe(false);
      }
      session.worker = worker;
      session.newtab = async ({ ready = true } = {}) => {
        const page = await context.newPage();
        await page.goto('chrome-extension://' + session.id + '/newtab.html');
        expect(await page.evaluate(() => chrome.runtime.getManifest().version)).toBe(manifest.version);
        expect(await page.evaluate(() => chrome.runtime.id)).toBe(originalId);
        if (options.offline) {
          expect(await page.evaluate(() => navigator.onLine)).toBe(false);
          // A route.fulfill can otherwise bypass native offline mode. Prove
          // even the explicitly allowed HTTPS fixture cannot return a response.
          expect(await page.evaluate(async url => {
            try { await fetch(url); return false; } catch { return true; }
          }, WEBDAV_BASE)).toBe(true);
        }
        if (ready) await expect(page.locator('.owntab')).toBeVisible({ timeout: 30_000 });
        return page;
      };
      return session;
    }
    let failed = false;
    try {
      const old = await launch(oldSource);
      expect(old.version).toBe('0.2.2');
      await use({
        old, toNew: async options => {
          const next = await launch(newSource, { ...options, reloadExtension: true });
          expect(next.version).toBe('0.3.0'); return next;
        },
        restart: options => launch(newSource, options),
        // A peer has its own profile and program path; it must not replace the
        // upgraded device. Only synthetic protocol data is shared.
        launchOldPeer: async () => {
          const peerRoot = join(root, 'peer-' + sessions.length), peerProfile = join(peerRoot, 'profile');
          const peerExtension = join(peerRoot, 'extension'); await mkdir(peerRoot);
          await cp(oldSource, peerExtension, { recursive: true });
          const context = await chromium.launchPersistentContext(peerProfile, {
            channel: 'chromium', headless, viewport, locale, timezoneId,
            args: ['--disable-extensions-except=' + peerExtension, '--load-extension=' + peerExtension, '--lang=zh-CN', '--no-first-run', '--disable-background-networking'],
          });
          await network.install(context);
          await context.route(/^https:\/\/example\.com\/(?:favicon\.ico|apple-touch-icon(?:-precomposed)?\.png|android-chrome-192x192\.png)$/, route => route.fulfill({ status: 404, body: '' }));
          await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
          context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
          const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
          const id = await worker.evaluate(() => chrome.runtime.id);
          const session = { context, worker, id, profile: peerProfile, version: '0.2.2',
            newtab: async () => { const page = await context.newPage(); await page.goto('chrome-extension://' + id + '/newtab.html'); await expect(page.locator('.owntab')).toBeVisible(); return page; } };
          sessions.push(session); return session;
        },
      });
      expect(errors, 'Upgrade pages must have no uncaught errors').toEqual([]);
      expect(network.unexpected, 'Upgrade may contact only explicit synthetic routes').toEqual([]);
    } catch (error) { failed = true; throw error; }
    finally {
      for (const [index, session] of sessions.entries()) {
        if (!session.context) {
          if ((failed || testInfo.status !== testInfo.expectedStatus) && session.trace) {
            const trace = testInfo.outputPath('upgrade-trace-' + index + '.zip');
            await cp(session.trace, trace);
            await testInfo.attach('upgrade-trace-' + index, { path: trace, contentType: 'application/zip' });
          }
          continue;
        }
        try {
          if (failed || testInfo.status !== testInfo.expectedStatus) {
            const trace = testInfo.outputPath('upgrade-trace-' + index + '.zip');
            await session.context.tracing.stop({ path: trace });
            await testInfo.attach('upgrade-trace-' + index, { path: trace, contentType: 'application/zip' });
            for (const [pageIndex, page] of session.context.pages().entries()) {
              if (!page.url().startsWith('chrome-extension://')) continue;
              const path = testInfo.outputPath('upgrade-' + index + '-' + pageIndex + '.png');
              await page.screenshot({ path, fullPage: true }).then(() => testInfo.attach('upgrade-screenshot', { path, contentType: 'image/png' })).catch(() => {});
            }
          } else await session.context.tracing.stop();
        } finally { await session.context.close(); }
      }
      await testInfo.attach('upgrade-runtime-proof', { body: JSON.stringify({ oldVersion: '0.2.2', newVersion: version, extensionId: originalId, sameProfile: true,
        browserVersion: sessions[0]?.browserVersion,
        legacyNotificationsPregranted: legacyNotificationGrant,
        target: process.env.COVELET_UPGRADE_TARGET === 'release' ? 'published-v0.3.0' : 'current-build',
        requests: network.requests, unexpected: network.unexpected, errors }), contentType: 'application/json' });
      expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
      expect(basename(root)).toMatch(/^covelet-upgrade-/);
      expect((await lstat(root)).isSymbolicLink()).toBe(false);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  },
});
export { expect };
