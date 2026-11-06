import { test, expect, readRecords } from './upgrade.fixture.mjs';
import { NAVIGATION, HOME_MIGRATION, CONTENT_PREFERENCES, TOOLS, SEED_IDS, persistLegacySeeds, settingsTab,
  closeDialog, exportCompleteBackup, restoreCompletePreview, editLegacySite, addLegacySite, aliasAndPrivateSeeds,
  groupLegacySeeds, addLegacyImage, addLegacyNoteAndClock, blobsIn, expectRecordsPreserved, tileNamed, revealDesktopItem } from './content-helpers.mjs';

const navigation = records => records.preferences?.[NAVIGATION];
const seedIds = records => (navigation(records)?.state.entries || []).filter(entry => SEED_IDS.includes(entry.id)).map(entry => entry.id).sort();

test('untouched 0.2.2 seeds retire once, retain a recovery snapshot and remain when the user restores old content', async ({ upgrade }) => {
  const old = await upgrade.old.newtab();
  await expect(old.locator('.site-name')).toHaveText(['Google', 'YouTube', 'GitHub', 'X', 'ChatGPT', 'Grok']);
  await persistLegacySeeds(old);
  await expect.poll(async () => seedIds(await readRecords(old))).toEqual([...SEED_IDS].sort());
  const originalBackup = await exportCompleteBackup(old);
  await closeDialog(old, old.getByRole('dialog', { name: '备份与恢复中心', exact: true }));
  const before = await readRecords(old), prior = navigation(before);
  expect(before.preferences[HOME_MIGRATION]).toBeUndefined();

  const next = await upgrade.toNew({ offline: true });
  expect(next.id).toBe(upgrade.old.id);
  const page = await next.newtab();
  await expect(page.locator('.site-tile')).toHaveCount(0);
  const migrated = await readRecords(page), current = navigation(migrated);
  expect(migrated.preferences[HOME_MIGRATION]).toEqual({ version: 1 });
  expect(current.state.entries).toEqual([]);
  expect(current.state.revision).toBe(prior.state.revision + 1);
  expect(current.state.settings.theme).toBe('light');
  expect(current.snapshots).toEqual([prior.state, ...prior.snapshots].slice(0, 3));
  const expected = structuredClone(prior);
  expected.state.entries = []; expected.state.revision++;
  expected.snapshots = [prior.state, ...prior.snapshots].slice(0, 3);
  expectRecordsPreserved(before, migrated, { navigation: expected });
  await page.reload();
  expect(navigation(await readRecords(page))).toEqual(current);

  const emptyBackup = await exportCompleteBackup(page);
  await closeDialog(page, page.getByRole('dialog', { name: '备份与恢复中心', exact: true }));
  const settings = await settingsTab(page, '数据');
  await settings.getByRole('button', { name: '恢复上一份导航副本', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeHidden();
  await expect.poll(async () => seedIds(await readRecords(page))).toEqual([...SEED_IDS].sort());
  const fromSnapshot = navigation(await readRecords(page));
  expect(fromSnapshot.state.entries).toEqual(prior.state.entries);
  await page.reload();
  expect(navigation(await readRecords(page))).toEqual(fromSnapshot);

  // Restore an empty backup first: the following six sites must genuinely come
  // from the original release's exported file, rather than already being there.
  await restoreCompletePreview(page, emptyBackup.buffer);
  await expect(page.locator('.site-tile')).toHaveCount(0);
  await restoreCompletePreview(page, originalBackup.buffer);
  await expect.poll(async () => seedIds(await readRecords(page))).toEqual([...SEED_IDS].sort());
  const restored = await readRecords(page);
  expect(navigation(restored).state.entries).toEqual(prior.state.entries);
  await page.reload();
  expect(navigation(await readRecords(page))).toEqual(navigation(restored));
  expect((await readRecords(page)).preferences[HOME_MIGRATION]).toEqual({ version: 1 });
  const restarted = await upgrade.restart({ offline: true }), reopened = await restarted.newtab();
  expect(restarted.id).toBe(next.id);
  expect(navigation(await readRecords(reopened))).toEqual(navigation(restored));
});

test('real 0.2.2 user content, private markers, notes, PNG bytes and retired clock data survive upgrade and restart', async ({ upgrade }, testInfo) => {
  const old = await upgrade.old.newtab();
  await editLegacySite(old, 'Google', { name: 'User Google' });
  // Keep the same origin so the old editor can retain its existing icon rather
  // than requiring a successful download from an unrelated icon host.
  await editLegacySite(old, 'YouTube', { url: 'https://www.youtube.com/upgrade-youtube' });
  await aliasAndPrivateSeeds(old);
  await groupLegacySeeds(old);
  await addLegacySite(old, 'User Added Site', 'https://example.com/upgrade-custom');
  const image = await addLegacyImage(old);
  await addLegacyNoteAndClock(old);
  const oldBackup = await exportCompleteBackup(old);
  await closeDialog(old, old.getByRole('dialog', { name: '备份与恢复中心', exact: true }));
  const before = await readRecords(old), prior = navigation(before);
  expect(seedIds(before)).toEqual([...SEED_IDS].sort());
  expect(prior.state.entries.find(entry => entry.id === 'default-google').name).toBe('User Google');
  expect(prior.state.entries.find(entry => entry.id === 'default-youtube').url).toBe('https://www.youtube.com/upgrade-youtube');
  const folder = prior.state.entries.find(entry => entry.name === 'Upgrade Folder');
  expect(folder.type).toBe('folder');
  expect(prior.state.entries.filter(entry => entry.parentId === folder.id).map(entry => entry.id).sort()).toEqual(['default-chatgpt', 'default-grok']);
  expect(before.preferences[CONTENT_PREFERENCES].aliases['site:default-github']).toBe('upgrade-code-alias');
  expect(before.preferences[CONTENT_PREFERENCES].privateKeys).toContain('site:default-x');
  const note = before.preferences[TOOLS].notes.find(note => note.title === 'Upgrade Note');
  expect(note.body).toContain('升级前的便笺正文');
  const clock = prior.state.entries.find(entry => entry.extensionId === 'clock');
  expect(clock).toBeTruthy();
  const clockKey = `covelet.clock.v1.${clock.id}`;
  expect(before.preferences[clockKey]).toMatchObject({ mode: 'stopwatch', stopwatch: { running: false } });
  expect(blobsIn(before.assets)).toContainEqual({ __blob: true, type: image.type, size: image.size, sha256: image.sha256 });
  expect(oldBackup.siteImages.find(item => item.name === 'Upgrade Image').bytes.equals(image.image)).toBe(true);

  const next = await upgrade.toNew({ offline: true }), page = await next.newtab();
  expect(next.id).toBe(upgrade.old.id);
  const after = await readRecords(page);
  expect(after.preferences[HOME_MIGRATION]).toEqual({ version: 1 });
  // Clock retirement is an intentional navigation edit: detach its launcher,
  // retain its full record/runtime, and keep the untouched old navigation in
  // the new first snapshot. All other user-created fields must remain exact.
  const expected = structuredClone(prior);
  expected.state.entries.find(entry => entry.id === clock.id).detached = true;
  expected.state.revision++;
  expected.snapshots = [prior.state, ...prior.snapshots].slice(0, 3);
  expectRecordsPreserved(before, after, { navigation: expected });
  expect(seedIds(after)).toEqual([...SEED_IDS].sort());
  expect(after.preferences[clockKey]).toEqual(before.preferences[clockKey]);
  await expect(page.locator('.clock-widget')).toHaveCount(0);
  await expect(tileNamed(page, 'User Google')).toBeVisible();
  const imageLink = tileNamed(page, 'Upgrade Image').locator('.site-link');
  await revealDesktopItem(page, imageLink);
  await expect(imageLink.locator('img[data-artwork-phase="current"]')).toHaveCount(1);
  await expect.poll(() => imageLink.locator('img[data-artwork-phase="current"]').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  const newBackup = await exportCompleteBackup(page);
  expect(newBackup.navigation.entries).toEqual(oldBackup.navigation.entries.map(entry => entry.id === clock.id ? { ...entry, detached: true } : entry));
  expect(newBackup.navigation.settings).toEqual(oldBackup.navigation.settings);
  expect(newBackup.tools).toEqual(oldBackup.tools);
  expect(newBackup.data.preferences).toEqual(oldBackup.data.preferences);
  expect(newBackup.siteImages.find(item => item.name === 'Upgrade Image').bytes.equals(image.image)).toBe(true);
  expect(newBackup.siteImages.find(item => item.name === 'Upgrade Image').sha256).toBe(image.sha256);
  await closeDialog(page, page.getByRole('dialog', { name: '备份与恢复中心', exact: true }));
  await page.getByRole('button', { name: '打开扩展', exact: true }).click();
  await expect(page.locator('#extension-clock')).toHaveCount(0);
  await closeDialog(page, page.getByRole('dialog', { name: '扩展', exact: true }));
  const checkpoint = await readRecords(page);
  await page.reload();
  expect(await readRecords(page)).toEqual(checkpoint);
  const restarted = await upgrade.restart({ offline: true }), reopened = await restarted.newtab();
  expect(restarted.id).toBe(next.id);
  expect(await readRecords(reopened)).toEqual(checkpoint);
  await testInfo.attach('content-upgrade-proof', { body: JSON.stringify({ oldId: upgrade.old.id, newId: next.id,
    seedIdsPreserved: seedIds(after), navigationEntries: prior.state.entries.length, image: { sha256: image.sha256, bytes: image.size, type: image.type },
    noteId: note.id, clockRecordRetained: clockKey, migrationMarker: after.preferences[HOME_MIGRATION] }, null, 2), contentType: 'application/json' });
});
