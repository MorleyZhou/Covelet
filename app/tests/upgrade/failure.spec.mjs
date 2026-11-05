import { test, expect, readRecords } from './upgrade.fixture.mjs';

const NAVIGATION = 'owntab.local.v1';
const MARKER = 'covelet.home-migration.v1';
const KEY_CHALLENGE = 'Covelet synthetic upgrade key continuity';

async function addSite(page, name, url) {
  await page.getByRole('button', { name: '添加网站', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加网站', exact: true });
  await dialog.getByLabel('网址', { exact: true }).fill(url);
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await expect(dialog.getByLabel('名称', { exact: true })).toHaveValue(name);
  await expect(dialog.getByLabel('网址', { exact: true })).toHaveValue(url);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.site-name').filter({ hasText: name })).toBeVisible();
}

async function expectVersion(page, version, id) {
  const actual = await page.evaluate(() => ({ version: chrome.runtime.getManifest().version, id: chrome.runtime.id }));
  expect(actual).toEqual({ version, id });
}

// Read the original, non-extractable CryptoKey through native IndexedDB. The
// challenge is synthetic and exists only in test memory; no key is exported and
// no test data is written directly to the app's stores.
async function inspectVault(page, challenge) {
  return page.evaluate(async ({ challenge, marker, plaintext }) => {
    const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const hash = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
    const markerId = await hash(new TextEncoder().encode('record:preferences' + String.fromCharCode(0) + marker));
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('covelet.encrypted.local.v1');
      request.onupgradeneeded = () => { request.transaction.abort(); reject(Error('The old UI must create the encrypted database.')); };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    let key, record;
    try {
      const transaction = database.transaction(['keys', 'records'], 'readonly');
      const read = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      [key, record] = await Promise.all([
        read(transaction.objectStore('keys').get('device-key-v1')),
        read(transaction.objectStore('records').get(markerId)),
      ]);
    } finally { database.close(); }
    if (!(key instanceof CryptoKey)) throw Error('The device key is missing.');
    const metadata = { type: key.type, extractable: key.extractable, algorithm: key.algorithm, usages: [...key.usages].sort() };
    let proof = challenge, decoded;
    if (!proof) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
      proof = { iv: [...iv], ciphertext: [...new Uint8Array(ciphertext)] };
    } else {
      const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(proof.iv) }, key, new Uint8Array(proof.ciphertext));
      decoded = new TextDecoder().decode(bytes);
    }
    return {
      metadata, proof, decoded,
      markerFingerprint: record ? { id: record.id, iv: await hash(record.iv), ciphertext: await hash(record.ciphertext) } : null,
    };
  }, { challenge, marker: MARKER, plaintext: KEY_CHALLENGE });
}

function entryIn(records, name) {
  const navigation = records.preferences?.[NAVIGATION];
  expect(navigation, 'The encrypted navigation envelope must remain readable.').toBeTruthy();
  const matches = navigation.state.entries.filter(entry => entry.name === name);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function expectOriginalContent(actual, original) {
  // Retiring untouched installation seeds can compact the user's root order.
  // Every other saved field must survive; later checkpoints compare the full
  // migrated navigation envelope, including the now-stable order.
  const { order: previousOrder, ...previousContent } = original;
  const { order, ...content } = actual;
  expect(content).toEqual(previousContent);
  expect(Number.isInteger(order)).toBe(true);
  expect(order).toBeGreaterThanOrEqual(0);
}

async function migratedState(page, originalEntry, keyProof, id) {
  await expect(page.locator('.owntab')).toBeVisible();
  await expectVersion(page, '0.3.0', id);
  await expect(page.locator('.site-name').filter({ hasText: originalEntry.name })).toBeVisible();
  const records = await readRecords(page);
  expect(records.preferences?.[MARKER]).toEqual({ version: 1 });
  expectOriginalContent(entryIn(records, originalEntry.name), originalEntry);
  const vault = await inspectVault(page, keyProof.proof);
  expect(vault.metadata).toEqual(keyProof.metadata);
  expect(vault.decoded).toBe(KEY_CHALLENGE);
  expect(vault.markerFingerprint).not.toBeNull();
  return { navigation: records.preferences[NAVIGATION], marker: records.preferences[MARKER], markerFingerprint: vault.markerFingerprint };
}

test('an aborted migration preserves the old navigation and key, then resumes once after restart', async ({ upgrade }) => {
  const old = await upgrade.old.newtab();
  await expectVersion(old, '0.2.2', upgrade.old.id);
  await addSite(old, 'Upgrade Abort Original', 'https://example.com/upgrade-abort');
  const before = await readRecords(old), original = entryIn(before, 'Upgrade Abort Original');
  expect(before.preferences?.[MARKER]).toBeUndefined();
  const keyProof = await inspectVault(old);
  expect(keyProof.metadata).toEqual({ type: 'secret', extractable: false, algorithm: { name: 'AES-GCM', length: 256 }, usages: ['decrypt', 'encrypt'] });
  expect(keyProof.markerFingerprint).toBeNull();
  const originalId = upgrade.old.id;

  const failed = await upgrade.toNew({ failMigration: true });
  expect(failed.id).toBe(originalId);
  const failurePage = await failed.newtab({ ready: false });
  await expectVersion(failurePage, '0.3.0', originalId);
  const failure = failurePage.locator('.loading-screen, .local-data-startup');
  await expect(failure.locator('h1, [role="alert"]')).toBeVisible();
  await expect(failure).toContainText(/暂时无法读取本地数据|未能保存|无法打开本机数据|旧版数据未能转换/);
  await expect(failure.getByRole('button', { name: /^(重新读取|重试)$/ })).toBeVisible();
  await expect(failurePage.locator('.owntab')).toHaveCount(0);
  expect(await failurePage.evaluate(() => globalThis.__upgradeMigrationAborts), 'The injected marker transaction abort must actually run.').toBeGreaterThan(0);
  const afterFailure = await readRecords(failurePage);
  expect(afterFailure.preferences?.[MARKER]).toBeUndefined();
  expect(afterFailure.preferences[NAVIGATION]).toEqual(before.preferences[NAVIGATION]);
  expect(afterFailure.assets || {}).toEqual(before.assets || {});
  const failedVault = await inspectVault(failurePage, keyProof.proof);
  expect(failedVault.metadata).toEqual(keyProof.metadata);
  expect(failedVault.decoded).toBe(KEY_CHALLENGE);
  expect(failedVault.markerFingerprint).toBeNull();

  const recovered = await upgrade.restart();
  const recoveredPage = await recovered.newtab();
  const committed = await migratedState(recoveredPage, original, keyProof, originalId);
  await recoveredPage.reload();
  expect(await migratedState(recoveredPage, original, keyProof, originalId)).toEqual(committed);
  const restarted = await upgrade.restart();
  expect(await migratedState(await restarted.newtab(), original, keyProof, originalId)).toEqual(committed);
});

test('an offline upgrade keeps local content readable and accepts edits that survive an offline restart', async ({ upgrade }) => {
  const old = await upgrade.old.newtab();
  await expectVersion(old, '0.2.2', upgrade.old.id);
  await addSite(old, 'Upgrade Offline Original', 'https://example.com/upgrade-offline-original');
  const original = entryIn(await readRecords(old), 'Upgrade Offline Original');
  const keyProof = await inspectVault(old), originalId = upgrade.old.id;

  const current = await upgrade.toNew({ offline: true });
  expect(current.id).toBe(originalId);
  const page = await current.newtab();
  const migrated = await migratedState(page, original, keyProof, originalId);
  const search = page.getByRole('combobox', { name: '搜索或输入网址' });
  await search.fill(original.name);
  await expect(page.getByRole('option')).toContainText(original.name);
  await search.press('Escape');
  await addSite(page, 'Added While Offline', 'https://example.com/upgrade-offline-added');
  const saved = await readRecords(page);
  const added = entryIn(saved, 'Added While Offline');
  expect(added.url).toBe('https://example.com/upgrade-offline-added');
  expectOriginalContent(entryIn(saved, original.name), original);
  expect((await inspectVault(page, keyProof.proof)).markerFingerprint).toEqual(migrated.markerFingerprint);

  const restarted = await upgrade.restart({ offline: true });
  const reopened = await restarted.newtab();
  const persisted = await migratedState(reopened, original, keyProof, originalId);
  expect(entryIn(await readRecords(reopened), added.name)).toEqual(added);
  expect(persisted.navigation).toEqual(saved.preferences[NAVIGATION]);
  expect(persisted.markerFingerprint).toEqual(migrated.markerFingerprint);
});
