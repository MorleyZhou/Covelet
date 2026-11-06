import { test, expect, readRecords } from './upgrade.fixture.mjs';
import {
  addSite, editSite, openSync, closeSync, configureOldSync, syncNow, unlockSync,
  navigationConflict, chooseRemote, settleOldPeer, expectSessionCleared, screenshot,
  NAVIGATION_KEY, CLOUD_KEY, FULL_SYNC_KEY, syncRoot,
} from './sync-helpers.mjs';

// Historical and current extension bundles run in real persistent Chromium
// profiles. Only HTTPS WebDAV responses are synthetic; this is upgrade/protocol
// acceptance, not a claim of real WebDAV or dual-machine cloud acceptance.
const preferences = records => records.preferences || {};
const entries = records => preferences(records)[NAVIGATION_KEY]?.state.entries || [];
const metadata = records => preferences(records)[FULL_SYNC_KEY]?.metadata;
const names = records => entries(records).map(entry => entry.name);

test('0.2.2 pending ciphertext and connection survive an in-place 0.3.0 upgrade and resume through UI unlock', async ({ upgrade, network }, testInfo) => {
  test.setTimeout(180_000);
  const old = upgrade.old, oldPage = await old.newtab();
  await addSite(oldPage, 'UPGRADE_SYNC_BASE', 'https://example.com/upgrade-sync-pending');
  let form = await configureOldSync(oldPage);
  await closeSync(oldPage);
  await editSite(oldPage, 'UPGRADE_SYNC_BASE', 'UPGRADE_SYNC_OFFLINE_EDIT');
  network.setWriteFailure(true);
  form = await openSync(oldPage, { old: true });
  await syncNow(form);
  await expect.poll(async () => metadata(await readRecords(oldPage))?.pending, { timeout: 45_000 }).toBeTruthy();
  const before = await readRecords(oldPage), originalPending = metadata(before)?.pending;
  expect(originalPending, 'the old production engine must persist a real failed upload').toBeTruthy();
  expect(originalPending.uploads.length).toBeGreaterThan(0);
  const stagedCiphertexts = Object.fromEntries(originalPending.uploads.map(({ name }) => {
    const staged = before['full-data-pending']?.[name];
    expect(typeof staged?.body, 'the old engine must persist each encrypted chunk').toBe('string');
    return [name, staged];
  }));
  expect(names(before)).toContain('UPGRADE_SYNC_OFFLINE_EDIT');
  expect(preferences(before)[CLOUD_KEY].autoSync).toBe(false);
  await screenshot(oldPage, testInfo, 'old-pending-sync');

  const current = await upgrade.toNew();
  expect(current.id).toBe(old.id);
  await expectSessionCleared(current);
  const page = await current.newtab();
  const after = await readRecords(page);
  expect(preferences(after)[CLOUD_KEY]).toEqual(preferences(before)[CLOUD_KEY]);
  expect(metadata(after).pending).toEqual(originalPending);
  for (const [name, staged] of Object.entries(stagedCiphertexts)) expect(after['full-data-pending'][name]).toEqual(staged);
  expect(names(after)).toContain('UPGRADE_SYNC_OFFLINE_EDIT');
  form = await openSync(page);
  await expect(form.locator('.cloud-setup-steps')).toHaveCount(0);
  await expect(form.locator('.cloud-sync-target')).toContainText('upgrade-proof');
  const requestsBeforeUnlock = network.requests.length;
  await unlockSync(form);
  expect(network.requests.length).toBe(requestsBeforeUnlock);
  expect(metadata(await readRecords(page)).pending).toEqual(originalPending);
  network.setWriteFailure(false);
  await syncNow(form);
  await expect.poll(async () => metadata(await readRecords(page)).pending, { timeout: 45_000 }).toBeNull();
  const originalIndex = network.objects.get(`${syncRoot}all-data-v1/${originalPending.name}`);
  expect(originalIndex, 'retry must publish the original persisted ciphertext/name').toEqual(Buffer.from(originalPending.body));
  for (const [name, staged] of Object.entries(stagedCiphertexts)) {
    const uploaded = [...network.objects].filter(([url]) => url.endsWith('/' + name));
    expect(uploaded, 'retry must retain each original encrypted chunk name').toHaveLength(1);
    expect(uploaded[0][1]).toEqual(Buffer.from(staged.body));
  }
  await expect(page.getByRole('alertdialog', { name: '提示', exact: true })).toHaveCount(0);
  await closeSync(page);
  await expect(page.locator('.site-name').filter({ hasText: 'UPGRADE_SYNC_OFFLINE_EDIT' })).toBeVisible();
  await screenshot(page, testInfo, 'upgraded-pending-retry');

  const restarted = await upgrade.restart();
  expect(restarted.id).toBe(current.id);
  await expectSessionCleared(restarted);
  const reopened = await restarted.newtab();
  expect(names(await readRecords(reopened))).toContain('UPGRADE_SYNC_OFFLINE_EDIT');
  form = await openSync(reopened);
  await unlockSync(form);
  const putsBeforeRepeat = network.requests.filter(request => request.url.startsWith(syncRoot) && request.method === 'PUT').length;
  await syncNow(form);
  await expect.poll(async () => metadata(await readRecords(reopened)).pending).toBeNull();
  expect(network.requests.filter(request => request.url.startsWith(syncRoot) && request.method === 'PUT').length).toBe(putsBeforeRepeat);
});

test('an unresolved 0.2.2 whole-navigation conflict survives upgrade and chooses one complete version', async ({ upgrade }, testInfo) => {
  test.setTimeout(240_000);
  const oldPage = await upgrade.old.newtab();
  await addSite(oldPage, 'UPGRADE_CONFLICT_BASE', 'https://example.com/upgrade-conflict');
  await addSite(oldPage, 'UPGRADE_COLLATERAL_BASE', 'https://example.com/upgrade-conflict-collateral');
  let form = await configureOldSync(oldPage);
  await closeSync(oldPage);

  const peer = await upgrade.launchOldPeer(), peerPage = await peer.newtab();
  const peerForm = await configureOldSync(peerPage);
  await settleOldPeer(peerPage, peerForm);
  await closeSync(peerPage);
  await expect(peerPage.locator('.site-name').filter({ hasText: 'UPGRADE_CONFLICT_BASE' })).toBeVisible();
  await editSite(peerPage, 'UPGRADE_CONFLICT_BASE', 'UPGRADE_CONFLICT_REMOTE');
  await editSite(oldPage, 'UPGRADE_CONFLICT_BASE', 'UPGRADE_CONFLICT_LOCAL');
  await editSite(oldPage, 'UPGRADE_COLLATERAL_BASE', 'UPGRADE_COLLATERAL_LOCAL');
  await syncNow(await openSync(peerPage, { old: true }));
  form = await openSync(oldPage, { old: true });
  await syncNow(form);
  await expect(navigationConflict(form).getByRole('button')).toBeVisible();
  const before = await readRecords(oldPage), beforeMetadata = metadata(before);
  expect(names(before)).toContain('UPGRADE_CONFLICT_LOCAL');
  expect(names(before)).toContain('UPGRADE_COLLATERAL_LOCAL');
  expect(beforeMetadata.pending).toBeNull();
  await screenshot(oldPage, testInfo, 'old-unresolved-conflict');

  const current = await upgrade.toNew();
  await expectSessionCleared(current);
  const page = await current.newtab(), after = await readRecords(page);
  expect(metadata(after).documents).toEqual(beforeMetadata.documents);
  expect(names(after)).toContain('UPGRADE_CONFLICT_LOCAL');
  expect(names(after)).toContain('UPGRADE_COLLATERAL_LOCAL');
  form = await openSync(page);
  await expect(navigationConflict(form).getByRole('button')).toBeDisabled();
  await unlockSync(form);
  await navigationConflict(form).getByRole('button').click();
  const prompt = page.getByRole('alertdialog', { name: '选择保留的版本', exact: true });
  await expect(prompt.locator('.cloud-conflict-impact')).toContainText('全部内容');
  for (const detail of await prompt.locator('.cloud-conflict-details button').all()) await detail.click();
  await expect(prompt).toContainText('UPGRADE_CONFLICT_LOCAL');
  await expect(prompt).toContainText('UPGRADE_CONFLICT_REMOTE');
  await expect(prompt).toContainText('UPGRADE_COLLATERAL_LOCAL');
  await screenshot(page, testInfo, 'upgraded-whole-record-choice');
  await chooseRemote(page);
  // The remote group includes the unedited collateral site. A field/entry merge
  // would wrongly keep the local collateral rename alongside the remote edit.
  const chosen = await readRecords(page);
  expect(names(chosen)).toContain('UPGRADE_CONFLICT_REMOTE');
  expect(names(chosen)).toContain('UPGRADE_COLLATERAL_BASE');
  expect(names(chosen)).not.toContain('UPGRADE_CONFLICT_LOCAL');
  expect(names(chosen)).not.toContain('UPGRADE_COLLATERAL_LOCAL');
  await expect(navigationConflict(form)).toHaveCount(0);
  await syncNow(form);
  await syncNow(await openSync(peerPage, { old: true }));
  expect(names(await readRecords(peerPage))).toContain('UPGRADE_CONFLICT_REMOTE');
  expect(names(await readRecords(peerPage))).toContain('UPGRADE_COLLATERAL_BASE');
  expect(names(await readRecords(peerPage))).not.toContain('UPGRADE_COLLATERAL_LOCAL');
});
