import { test as base, expect, chromium } from '@playwright/test';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { createNetworkFixture } from './network.mjs';
import { createNote, inspectCompleteBackup, openRecovery, revealDesktopItem, restorePreview } from './backup-helpers.mjs';

const baselineZip = fileURLToPath(new URL('../../../output/0.6.0-upgrade/baseline/covelet-0.5.1.zip', import.meta.url));
const currentBuild = fileURLToPath(new URL('../../dist/extension/', import.meta.url));
const baselineSha256 = '60769c07be2f8553a52fff0e24cfdc4741f0f355367806307f72b9dbe8672e74';
const browserExecutables = { chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe', edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' };
const sample = { site: 'Upgrade original site', url: 'https://example.com/covelet-upgrade-original',
  description: 'Upgrade original site context', note: 'Upgrade original note', body: 'upgradebodyneedle 原有便笺正文必须完整保留。',
  reading: 'Upgrade original reading', readingUrl: 'https://example.org/covelet-upgrade-reading', tag: 'Upgrade shared tag' };

function childPath(root, path) {
  const delta = relative(resolve(root), resolve(path));
  expect(delta).not.toBe('');
  expect(isAbsolute(delta)).toBe(false);
  expect(delta === '..' || delta.startsWith(`..${sep}`)).toBe(false);
}

const test = base.extend({
  upgrade: async ({ headless, viewport, locale, timezoneId }, use, testInfo) => {
    await access(baselineZip);
    const archive = await readFile(baselineZip);
    expect(createHash('sha256').update(archive).digest('hex'), 'only the verified official published baseline may execute').toBe(baselineSha256);
    const files = unzipSync(archive), oldManifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    expect(oldManifest.version).toBe('0.5.1');
    const newManifest = JSON.parse(await readFile(join(currentBuild, 'manifest.json'), 'utf8'));
    expect(newManifest.version, 'build 0.6.0 before running the real upgrade test').toBe('0.6.0');
    const workspace = await mkdtemp(join(tmpdir(), 'covelet-upgrade-'));
    const unpacked = join(workspace, 'unpacked'), profile = join(workspace, 'profile');
    childPath(workspace, unpacked); childPath(workspace, profile);
    await mkdir(unpacked); await mkdir(profile);
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith('/')) continue;
      expect(name).not.toMatch(/[\\:\0]/u);
      expect(name.split('/').some((part) => !part || part === '.' || part === '..')).toBe(false);
      const path = resolve(unpacked, name); childPath(unpacked, path);
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
    }
    const sessions = [], errors = [], network = createNetworkFixture();
    let currentVersion = '0.5.1', failure;
    const browserName = process.env.COVELET_NATIVE_BROWSER;
    if (browserName && !browserExecutables[browserName]) throw Error('COVELET_NATIVE_BROWSER must be chrome or edge.');
    async function launch(profilePath = profile) {
      childPath(workspace, profilePath);
      const manifest = JSON.parse(await readFile(join(unpacked, 'manifest.json'), 'utf8'));
      expect(manifest.version).toBe(currentVersion);
      const context = await chromium.launchPersistentContext(profilePath, {
        ...(browserName ? { executablePath: browserExecutables[browserName], ignoreDefaultArgs: ['--disable-extensions'] } : { channel: 'chromium' }),
        headless, viewport, locale, timezoneId,
        args: [...(browserName ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`]),
          '--lang=zh-CN', '--no-first-run', '--disable-background-networking'],
      });
      await network.install(context);
      const captureErrors = (page) => page.on('pageerror', (error) => errors.push({ version: currentVersion, message: error.message }));
      context.pages().forEach(captureErrors); context.on('page', captureErrors);
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      const session = { context, profile: profilePath, version: manifest.version, tracing: true, closed: false };
      sessions.push(session);
      if (browserName) {
        const cdp = await context.browser().newBrowserCDPSession();
        const actual = await cdp.send('Browser.getVersion');
        testInfo.annotations.push({ type: 'native-browser', description: `${manifest.version}: ${actual.product}` });
        await cdp.send('Extensions.loadUnpacked', { path: unpacked }); await cdp.detach();
      }
      await expect.poll(async () => {
        for (const worker of context.serviceWorkers()) {
          if (!worker.url().startsWith('chrome-extension://')) continue;
          const actual = await worker.evaluate(() => ({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest() })).catch(() => null);
          if (actual?.manifest.name === 'Covelet' && actual.manifest.version === manifest.version) {
            expect(actual.manifest.chrome_url_overrides.newtab).toBe('newtab.html');
            session.id = actual.id; session.worker = worker; return actual.id;
          }
        }
        return null;
      }, { timeout: 25_000 }).not.toBeNull();
      session.newtab = async () => {
        const page = await context.newPage(); await page.goto(`chrome-extension://${session.id}/newtab.html`);
        await expect(page.getByRole('combobox', { name: '搜索或输入网址', exact: true })).toBeVisible();
        expect(await page.evaluate(() => chrome.runtime.id)).toBe(session.id); return page;
      };
      session.close = async (name) => {
        if (session.closed) return;
        const path = testInfo.outputPath(`${name}.zip`);
        await context.tracing.stop({ path }); session.tracing = false;
        await testInfo.attach(name, { path, contentType: 'application/zip' });
        await context.close(); session.closed = true;
      };
      return session;
    }
    try {
      const old = await launch();
      await use({ old, network, unpacked, profile, errors,
        async upgrade() {
          expect(old.closed, 'the old persistent context must be closed before replacing its executable files').toBe(true);
          expect(resolve(unpacked)).toBe(resolve(workspace, 'unpacked')); childPath(workspace, unpacked);
          await rm(unpacked, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
          await cp(currentBuild, unpacked, { recursive: true });
          currentVersion = '0.6.0';
          return launch(profile);
        },
        async freshCurrent() {
          expect(currentVersion).toBe('0.6.0');
          const path = join(workspace, 'restore-profile'); childPath(workspace, path); await mkdir(path);
          return launch(path);
        },
      });
      expect(errors, 'old and upgraded production pages must have no uncaught exceptions').toEqual([]);
      expect(network.unexpected).toEqual([]);
    } catch (reason) { failure = reason; }
    finally {
      for (const [index, session] of sessions.entries()) {
        if (session.closed) continue;
        if (failure || testInfo.status !== testInfo.expectedStatus) {
          for (const [pageIndex, page] of session.context.pages().entries()) {
            if (!page.url().startsWith('chrome-extension://')) continue;
            const path = testInfo.outputPath(`upgrade-${index}-${pageIndex}.png`);
            await page.screenshot({ path, fullPage: true }).then(() => testInfo.attach(`upgrade-${index}-${pageIndex}`, { path, contentType: 'image/png' })).catch(() => {});
          }
        }
        await session.close(`upgrade-session-${index}`).catch(async () => { await session.context.close().catch(() => {}); });
      }
      await testInfo.attach('upgrade-network-and-errors', { body: JSON.stringify({ requests: network.requests, unexpected: network.unexpected, errors }, null, 2), contentType: 'application/json' });
      expect(dirname(resolve(workspace))).toBe(resolve(tmpdir())); expect(basename(workspace)).toMatch(/^covelet-upgrade-/u);
      await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    if (failure) throw failure;
  },
});

async function closeDialog(page, name = '设置') {
  const dialog = page.getByRole('dialog', { name, exact: true });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(dialog).toBeHidden();
}
async function pickTag(scope) {
  const existing = scope.getByRole('checkbox', { name: sample.tag, exact: true });
  if (await existing.count()) await existing.check();
  else {
    await scope.getByRole('textbox', { name: '新标签名称', exact: true }).fill(sample.tag);
    await scope.getByRole('button', { name: '添加标签', exact: true }).click();
    await expect(scope.getByRole('checkbox', { name: sample.tag, exact: true })).toBeChecked();
  }
}
async function seedOldUI(session, page) {
  await page.getByRole('button', { name: '添加网站', exact: true }).click();
  const site = page.getByRole('dialog', { name: '添加网站', exact: true });
  await site.getByLabel('网址', { exact: true }).fill(sample.url); await site.getByLabel('名称', { exact: true }).fill(sample.site);
  await site.getByRole('textbox', { name: '备注', exact: true }).fill(sample.description); await pickTag(site);
  await site.getByRole('button', { name: '添加', exact: true }).click(); await expect(site).toBeHidden();
  await createNote(page, { title: sample.note, body: sample.body });
  const popup = await session.context.newPage();
  await popup.goto(`chrome-extension://${session.id}/popup.html`);
  await popup.getByRole('tab', { name: '稍后读', exact: true }).click();
  await popup.getByLabel('网址', { exact: true }).fill(sample.readingUrl); await popup.getByLabel('名称', { exact: true }).fill(sample.reading);
  await popup.getByRole('button', { name: '备注与标签', exact: true }).click(); await pickTag(popup);
  const closed = popup.waitForEvent('close'); await popup.getByRole('button', { name: '保存', exact: true }).click(); await closed;
  await page.bringToFront();
}
async function actualBackup(page, testInfo, name) {
  const recovery = await openRecovery(page), waiting = page.waitForEvent('download');
  await recovery.getByRole('button', { name: '导出备份', exact: true }).click();
  const download = await waiting, path = testInfo.outputPath(name);
  expect(download.suggestedFilename()).toBe('Covelet-complete-backup.json'); await download.saveAs(path);
  await testInfo.attach(name, { path, contentType: 'application/json' });
  const buffer = await readFile(path); await closeDialog(page);
  return { path, buffer, ...inspectCompleteBackup(buffer) };
}
function preservedContents(backup) {
  return { entries: backup.navigation.entries, providers: backup.navigation.providers, settings: backup.navigation.settings,
    notes: backup.tools.notes, reading: backup.tools.reading, trash: backup.tools.trash,
    aliases: backup.data.preferences.aliases, privateKeys: backup.data.preferences.privateKeys, library: backup.data.preferences.library };
}

// This is a native, readonly inspection of the persistence boundary, never an
// application import or a storage fixture injection. The only clear records
// created by this test came through the old production UI above.
async function encryptedEnvelope(page) {
  return page.evaluate(async (needles) => {
    if (!(await indexedDB.databases()).some((item) => item.name === 'covelet.encrypted.local.v1')) throw Error('Production encrypted database was not created by the UI');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('covelet.encrypted.local.v1');
      request.onupgradeneeded = () => { request.transaction.abort(); reject(Error('Readonly upgrade verification cannot create a database')); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const read = (store, key) => new Promise((resolve, reject) => {
      const request = key === undefined ? db.transaction(store, 'readonly').objectStore(store).getAll() : db.transaction(store, 'readonly').objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const [records, key, legacy] = await Promise.all([read('records'), read('keys', 'device-key-v1'), chrome.storage.local.get(null)]);
      const hashes = [];
      for (const record of records) {
        const bytes = new Uint8Array(record.ciphertext), decoded = new TextDecoder().decode(bytes);
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        hashes.push({ id: record.id, space: record.space, version: record.version, ivBytes: record.iv.byteLength, ciphertextBytes: bytes.length,
          ciphertextSha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
          containsPlaintext: needles.some((needle) => decoded.includes(needle)) });
      }
      const clear = JSON.stringify(legacy) + JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((name) => [name, localStorage.getItem(name)])));
      return { records: hashes, key: { extractable: key.extractable, algorithm: key.algorithm, usages: key.usages },
        clearBusinessData: needles.some((needle) => clear.includes(needle)) };
    } finally { db.close(); }
  }, [sample.note, sample.body, sample.site, sample.reading, sample.tag]);
}

test('official 0.5.1 upgrades at the same unpacked path/profile and its actual backup restores offline in 0.6.0', async ({ upgrade }, testInfo) => {
  test.setTimeout(240_000);
  const old = upgrade.old, oldPage = await old.newtab();
  await seedOldUI(old, oldPage);
  const before = await actualBackup(oldPage, testInfo, 'Covelet-v0.5.1-before-upgrade.json');
  expect(before.tools.notes.find((item) => item.title === sample.note)?.body).toBe(sample.body);
  expect(before.tools.reading.find((item) => item.title === sample.reading)?.url).toBe(sample.readingUrl);
  const taggedSite = before.navigation.entries.find((item) => item.name === sample.site);
  expect(before.data.preferences.library.items[`site:${taggedSite.id}`].description).toBe(sample.description);
  const encryptedBefore = await encryptedEnvelope(oldPage);
  expect(encryptedBefore.key).toMatchObject({ extractable: false, algorithm: { name: 'AES-GCM', length: 256 } });
  expect(encryptedBefore.records.length).toBeGreaterThan(2); expect(encryptedBefore.clearBusinessData).toBe(false);
  expect(encryptedBefore.records.every((record) => record.version === 1 && record.ivBytes === 12 && record.ciphertextBytes > 16 && !record.containsPlaintext)).toBe(true);
  const oldId = old.id; await old.close('official-v0.5.1-ui-seeding');
  const current = await upgrade.upgrade();
  expect(current.id, 'unchanged extension path and profile must retain extension identity').toBe(oldId);
  expect(current.profile).toBe(upgrade.profile);
  const page = await current.newtab(), after = await actualBackup(page, testInfo, 'Covelet-v0.6.0-after-upgrade.json');
  expect(preservedContents(after)).toEqual(preservedContents(before));
  const encryptedAfter = await encryptedEnvelope(page);
  expect(encryptedAfter.key).toEqual(encryptedBefore.key); expect(encryptedAfter.clearBusinessData).toBe(false);
  for (const key of ['owntab.local.v1', 'covelet.tools.v1', 'covelet.content.preferences.v1']) {
    const id = createHash('sha256').update(`record:preferences\0${key}`).digest('hex');
    const previous = encryptedBefore.records.find((record) => record.id === id), retained = encryptedAfter.records.find((record) => record.id === id);
    expect(previous, `old encrypted business record ${key} must exist`).toBeTruthy();
    expect(retained, `upgrade must reuse the existing encrypted business record ${key}`).toEqual(previous);
  }
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const commands = page.getByRole('dialog', { name: '命令面板', exact: true });
  await commands.getByRole('combobox').fill('upgradebodyneedle');
  await commands.getByRole('option').filter({ hasText: sample.note }).click();
  const note = page.getByRole('dialog', { name: '便笺', exact: true });
  await expect(note.getByLabel('便笺名称', { exact: true })).toHaveValue(sample.note);
  await expect(note.locator('.note-search-matches')).toBeVisible();
  await note.getByRole('button', { name: '固定到桌面', exact: true }).click();
  const pin = page.getByRole('dialog', { name: '固定到桌面', exact: true });
  await pin.getByRole('button', { name: '固定', exact: true }).click(); await expect(pin).toBeHidden();
  await closeDialog(page, '便笺');
  const changed = await actualBackup(page, testInfo, 'Covelet-v0.6.0-new-feature.json');
  const originalNote = before.tools.notes.find((item) => item.title === sample.note);
  expect(changed.navigation.entries.some((item) => item.extensionId === 'notes' && item.config.noteId === originalNote.id)).toBe(true);
  expect(changed.tools.notes).toEqual(before.tools.notes);

  const fresh = await upgrade.freshCurrent(); await fresh.context.setOffline(true);
  const restoredPage = await fresh.newtab(), recovery = await openRecovery(restoredPage), chooserReady = restoredPage.waitForEvent('filechooser');
  await recovery.getByRole('button', { name: '恢复备份', exact: true }).click(); await (await chooserReady).setFiles(before.path);
  const requestsBeforeRestore = upgrade.network.requests.length;
  await restorePreview(recovery); await closeDialog(restoredPage);
  const restoredSite = restoredPage.locator('.site-link').filter({ hasText: sample.site });
  await revealDesktopItem(restoredPage, restoredSite); await expect(restoredSite).toHaveAttribute('href', sample.url);
  const restored = await actualBackup(restoredPage, testInfo, 'Covelet-v0.6.0-restored-old-backup-offline.json');
  expect(preservedContents(restored)).toEqual(preservedContents(before));
  expect(upgrade.network.requests.length, 'offline old-backup restore/export must stay local').toBe(requestsBeforeRestore);
  expect((await encryptedEnvelope(restoredPage)).clearBusinessData).toBe(false);
  const evidence = { baselineZip, baselineSha256, from: '0.5.1', to: '0.6.0', extensionIdBefore: oldId, extensionIdAfter: current.id,
    sameUnpackedPath: upgrade.unpacked, sameProfile: current.profile, businessCiphertextsRetained: true,
    oldBackup: basename(before.path), upgradedBackup: basename(after.path), oldBackupRestoredOffline: true };
  await writeFile(testInfo.outputPath('upgrade-evidence.json'), JSON.stringify(evidence, null, 2));
  await testInfo.attach('upgrade-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('upgraded-v0.6.0.png'), animations: 'disabled' });
  await current.close('upgraded-v0.6.0-new-features'); await fresh.close('offline-old-backup-restore');
});
