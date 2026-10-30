import { defineBackground } from 'wxt/utils/define-background';
import { emptyClockState, handleClockAlarm, restoreClockSchedules, scheduleClockState } from '../src/lib/clock-runtime.js';
import { initializeLanguage, subscribeLanguage, tr } from '../src/i18n/index.js';
import { installTabSnapshotActions } from '../src/lib/tab-snapshot-runtime.js';
import { localData } from '../src/lib/local-data.js';
import { restoreTaskReminders, handleTaskReminder } from '../src/lib/task-reminders.js';

export default defineBackground({ type: 'module', main() {
  const languageReady = initializeLanguage();
  installTabSnapshotActions(languageReady);
  const updateActionTitle = () => chrome.action.setTitle({ title: tr('添加到 Covelet') }).catch(() => {});
  subscribeLanguage(updateActionTitle);
  languageReady.then(updateActionTitle);
  let restoration = Promise.resolve();
  const restore = (removed = []) => {
    restoration = restoration.catch(() => {}).then(() => languageReady).then(async () => {
      // Deleted runtime records no longer appear in restoreClockSchedules().
      // Clear their owned deadlines explicitly before rebuilding current plans.
      for (const id of removed) await scheduleClockState(id, emptyClockState());
      await restoreClockSchedules();
      await restoreTaskReminders();
    }).catch(() => {});
  };
  chrome.alarms.onAlarm.addListener((alarm) => { languageReady.then(() => Promise.all([handleClockAlarm(alarm.name), handleTaskReminder(alarm.name)])).catch(() => {}); });
  chrome.runtime.onStartup.addListener(() => restore());
  chrome.runtime.onInstalled.addListener(() => restore());
  localData.subscribe((items) => {
    if (items['covelet.app.v1.tasks']) restoreTaskReminders().catch(() => {});
    const clockKeys = Object.keys(items).filter((key) => key.startsWith('covelet.clock.v1.'));
    if (items['owntab.local.v1'] || clockKeys.length) restore(clockKeys.filter((key) => items[key].newValue === undefined).map((key) => key.slice('covelet.clock.v1.'.length)));
  });
  restore();
} });
