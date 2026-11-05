import { test, expect, readRecords } from './upgrade.fixture.mjs';
import { NAVIGATION, HOME_MIGRATION, CONTENT_PREFERENCES, contextAction, addLegacyWidget,
  closeDialog, revealDesktopItem, expectRecordsPreserved, exportCompleteBackup, persistLegacySeeds } from './content-helpers.mjs';

const LOCK = 'covelet.privacy.lock.v1';
const PASSWORD = 'Synthetic-Upgrade-Hiding-2026!';
const WRONG_PASSWORD = 'Synthetic-Wrong-Hiding-2026!';
const ALARM_PREFIX = 'covelet-clock:';
const CONTROL_ALARM = 'covelet-clock-lookalike-upgrade-control';

async function expectXHidden(page) {
  await expect(page.locator('.owntab')).toHaveClass(/presentation-active/);
  await expect(page.locator('.presentation-private-tile')).toHaveCount(1);
  await expect(page.locator('a.site-link[href="https://x.com/"]')).toHaveCount(0);
  await expect(page.locator('.site-name').filter({ hasText: /^X$/ })).toHaveCount(0);
}

function migrationEnvelope(prior, entries) {
  return { ...structuredClone(prior), state: { ...structuredClone(prior.state), entries, revision: prior.state.revision + 1 },
    snapshots: [prior.state, ...prior.snapshots].slice(0, 3) };
}

test('old hiding password and hidden state survive upgrade; wrong passwords cannot reveal content', async ({ upgrade }, testInfo) => {
  const old = await upgrade.old.newtab();
  await persistLegacySeeds(old);
  await contextAction(old, 'X', '标记为私密');
  await old.getByRole('button', { name: '开启隐藏', exact: true }).click();
  const setup = old.getByRole('dialog', { name: '设置隐藏密码', exact: true });
  await setup.getByLabel('新密码', { exact: true }).fill(PASSWORD);
  await setup.getByLabel('确认密码', { exact: true }).fill(PASSWORD);
  await setup.getByRole('button', { name: '设置并隐藏', exact: true }).click();
  await expect(setup).toBeHidden(); await expectXHidden(old);
  const before = await readRecords(old), prior = before.preferences[NAVIGATION];
  const credential = before.preferences[LOCK];
  expect(credential).toMatchObject({ version: 1, kdf: 'PBKDF2-SHA256', failedAttempts: 0, retryAt: 0 });
  expect(before.preferences[CONTENT_PREFERENCES]).toMatchObject({ presentation: true, privateKeys: ['site:default-x'] });
  const expectedNavigation = migrationEnvelope(prior, [{ ...prior.state.entries.find(entry => entry.id === 'default-x'), order: 0 }]);

  const next = await upgrade.toNew({ offline: true }), page = await next.newtab();
  expect(next.id).toBe(upgrade.old.id); await expectXHidden(page);
  const upgraded = await readRecords(page);
  expectRecordsPreserved(before, upgraded, { navigation: expectedNavigation });
  expect(upgraded.preferences[HOME_MIGRATION]).toEqual({ version: 1 });
  expect(upgraded.preferences[LOCK]).toEqual(credential);
  const restarted = await upgrade.restart({ offline: true }), reopened = await restarted.newtab();
  await expectXHidden(reopened); expect(await readRecords(reopened)).toEqual(upgraded);

  await reopened.getByRole('button', { name: '关闭隐藏', exact: true }).click();
  const unlock = reopened.getByRole('dialog', { name: '解锁隐藏内容', exact: true });
  await unlock.getByLabel('隐藏密码', { exact: true }).fill(WRONG_PASSWORD);
  await unlock.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(unlock.getByRole('alert')).toBeVisible(); await expectXHidden(reopened);
  const rejected = await readRecords(reopened);
  expect(rejected.preferences[LOCK]).toEqual({ ...credential, failedAttempts: 1 });
  expect(rejected.preferences[CONTENT_PREFERENCES]).toEqual(before.preferences[CONTENT_PREFERENCES]);
  expect(rejected.preferences[NAVIGATION]).toEqual(expectedNavigation);
  await unlock.getByLabel('隐藏密码', { exact: true }).fill(PASSWORD);
  await unlock.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(unlock).toBeHidden();
  await expect(reopened.locator('a.site-link[href="https://x.com/"]')).toBeVisible();
  const revealed = await readRecords(reopened);
  expect(revealed.preferences[LOCK]).toEqual(credential);
  expect(revealed.preferences[CONTENT_PREFERENCES]).toEqual({ ...before.preferences[CONTENT_PREFERENCES], presentation: false,
    revision: before.preferences[CONTENT_PREFERENCES].revision + 1 });
  expect(revealed.preferences[NAVIGATION]).toEqual(expectedNavigation);
  const backup = await exportCompleteBackup(reopened);
  expect(backup.navigation.entries.find(entry => entry.id === 'default-x')).toEqual(expectedNavigation.state.entries[0]);
  expect(backup.data.preferences.privateKeys).toContain('site:default-x');
  await closeDialog(reopened, reopened.getByRole('dialog', { name: '备份与恢复中心', exact: true }));
  await testInfo.attach('privacy-upgrade-proof', { body: JSON.stringify({ oldId: upgrade.old.id, newId: next.id,
    verifierPreserved: true, hiddenAcrossUpgradeAndRestart: true, wrongPasswordRejected: true, oldPasswordUnlocks: true }, null, 2), contentType: 'application/json' });
});

async function alarms(session) {
  return session.worker.evaluate(async () => (await chrome.alarms.getAll()).map(({ name, scheduledTime }) => ({ name, scheduledTime })));
}

async function expectRetiredPlans(session) {
  await expect.poll(async () => (await alarms(session)).filter(alarm => alarm.name.startsWith(ALARM_PREFIX))).toEqual([]);
}

test.describe('legacy clock reminders with declared notification permission pregranted', () => {
test.use({ legacyNotificationGrant: true });
test('old UI countdown creates a native reminder; upgrade and restart keep retired clock plans inactive', async ({ upgrade }, testInfo) => {
  const old = await upgrade.old.newtab();
  expect(await upgrade.old.worker.evaluate(() => chrome.permissions.contains({ permissions: ['notifications'] }))).toBe(true);
  await addLegacyWidget(old, 'clock', '时钟');
  const launcher = old.locator('.clock-widget');
  await revealDesktopItem(old, launcher); await launcher.click();
  const clockDialog = old.getByRole('dialog', { name: '时钟', exact: true });
  await clockDialog.getByRole('tab', { name: '倒计时', exact: true }).click();
  await clockDialog.getByRole('spinbutton', { name: '倒计时时', exact: true }).fill('0');
  await clockDialog.getByRole('spinbutton', { name: '倒计时分', exact: true }).fill('20');
  await clockDialog.getByRole('spinbutton', { name: '倒计时秒', exact: true }).fill('0');
  // Only this test's temporary old manifest pregrants its already declared
  // optional permission. The countdown UI, permission API and browser alarms
  // remain real. Acceptance of the native permission prompt is not covered.
  await clockDialog.getByRole('switch', { name: '倒计时通知', exact: true }).click();
  await expect(clockDialog.getByRole('switch', { name: '倒计时通知', exact: true })).toBeChecked();
  await clockDialog.getByRole('button', { name: '开始倒计时', exact: true }).click();
  await expect(clockDialog.getByRole('button', { name: '暂停倒计时', exact: true })).toBeEnabled();
  await closeDialog(old, clockDialog);
  const before = await readRecords(old), prior = before.preferences[NAVIGATION];
  const clock = prior.state.entries.find(entry => entry.extensionId === 'clock');
  const clockKey = `covelet.clock.v1.${clock.id}`, ownedAlarm = `${ALARM_PREFIX}${encodeURIComponent(clock.id)}:timer`;
  expect(before.preferences[clockKey]).toMatchObject({ mode: 'countdown', notify: true, duration: 20 * 60 * 1000, timer: { running: true, completed: false } });
  await expect.poll(async () => (await alarms(upgrade.old)).filter(alarm => alarm.name === ownedAlarm).length).toBe(1);
  const expectedNavigation = migrationEnvelope(prior, [{ ...clock, order: 0, detached: true }]);

  let beforeNativeInstall;
  const next = await upgrade.toNew({ offline: true, beforeReload: async ({ worker }) => {
    // Some platforms already load the fresh worker; others retain its old
    // code until the native installer. This intermediate state is diagnostic.
    beforeNativeInstall = await worker.evaluate(async () => ({ alarmEventListener: chrome.alarms.onAlarm.hasListeners(),
      plans: (await chrome.alarms.getAll()).map(({ name, scheduledTime }) => ({ name, scheduledTime })) }));
    await worker.evaluate(async name => { await chrome.alarms.create(name, { when: Date.now() + 60 * 60 * 1000 }); }, CONTROL_ALARM);
    expect(await worker.evaluate(async name => (await chrome.alarms.getAll()).some(alarm => alarm.name === name), CONTROL_ALARM)).toBe(true);
  } }), page = await next.newtab();
  expectRecordsPreserved(before, await readRecords(page), { navigation: expectedNavigation });
  const diagnostic = { oldOwnedAlarm: ownedAlarm, beforeNativeInstall,
    newWorker: await next.worker.evaluate(async () => ({ version: chrome.runtime.getManifest().version,
      alarmEventListener: chrome.alarms.onAlarm.hasListeners(), notificationsGranted: await chrome.permissions.contains({ permissions: ['notifications'] }),
      plans: (await chrome.alarms.getAll()).map(({ name, scheduledTime }) => ({ name, scheduledTime })) })) };
  await testInfo.attach('clock-runtime-diagnostic', { body: JSON.stringify(diagnostic, null, 2), contentType: 'application/json' });
  expect(diagnostic.newWorker.alarmEventListener).toBe(false);
  await expectRetiredPlans(next); await expect(page.locator('.clock-widget')).toHaveCount(0);
  const checkpoint = await readRecords(page);
  const restarted = await upgrade.restart({ offline: true }), reopened = await restarted.newtab();
  await expectRetiredPlans(restarted);
  expect(await readRecords(reopened)).toEqual(checkpoint);
  expect(checkpoint.preferences[clockKey]).toEqual(before.preferences[clockKey]);
  await testInfo.attach('clock-upgrade-proof', { body: JSON.stringify({ oldId: upgrade.old.id, newId: next.id,
    legacyNotificationsPregranted: true, nativePermissionPromptTested: false,
    ownedAlarmCreated: ownedAlarm, ownedAlarmAbsentAfterUpgradeAndRestart: true,
    controlAlarm: { name: CONTROL_ALARM, presentBeforeNativeInstall: true,
      presentAfterNativeInstall: diagnostic.newWorker.plans.some(alarm => alarm.name === CONTROL_ALARM) },
    selectiveCleanupVerifiedByThisTest: false,
    clockRuntimeRetained: clockKey, durationMilliseconds: 20 * 60 * 1000 }, null, 2), contentType: 'application/json' });
});
});
