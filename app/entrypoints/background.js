import { defineBackground } from 'wxt/utils/define-background';
import { handleClockAlarm, restoreClockSchedules } from '../src/lib/clock-runtime.js';
import { initializeLanguage, subscribeLanguage, tr } from '../src/i18n/index.js';

export default defineBackground({ type: 'module', main() {
  const languageReady = initializeLanguage();
  const updateActionTitle = () => chrome.action.setTitle({ title: tr('添加到 Covelet') }).catch(() => {});
  subscribeLanguage(updateActionTitle);
  languageReady.then(updateActionTitle);
  let restoration = Promise.resolve();
  const restore = () => { restoration = restoration.catch(() => {}).then(() => languageReady).then(restoreClockSchedules).catch(() => {}); };
  chrome.alarms.onAlarm.addListener((alarm) => { languageReady.then(() => handleClockAlarm(alarm.name)).catch(() => {}); });
  chrome.runtime.onStartup.addListener(restore);
  chrome.runtime.onInstalled.addListener(restore);
  chrome.storage.onChanged.addListener((items, area) => { if (area === 'local' && items['owntab.local.v1']) restore(); });
  restore();
} });
