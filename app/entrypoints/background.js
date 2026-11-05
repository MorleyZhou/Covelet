import { defineBackground } from 'wxt/utils/define-background';
import { retireClockSchedules } from '../src/lib/clock-runtime.js';
import { initializeLanguage, subscribeLanguage, tr } from '../src/i18n/index.js';
import { localData } from '../src/lib/local-data.js';

export default defineBackground({ type: 'module', main() {
  const languageReady = initializeLanguage();
  const updateActionTitle = () => chrome.action.setTitle({ title: tr('添加到 Covelet') }).catch(() => {});
  subscribeLanguage(updateActionTitle);
  languageReady.then(updateActionTitle);
  let restoration = Promise.resolve();
  const retire = () => {
    restoration = restoration.catch(() => {}).then(() => languageReady).then(async () => {
      await retireClockSchedules();
    }).catch(() => {});
  };
  chrome.runtime.onStartup.addListener(retire);
  chrome.runtime.onInstalled.addListener(retire);
  localData.subscribe((items) => {
    const clockKeys = Object.keys(items).filter((key) => key.startsWith('covelet.clock.v1.'));
    if (items['owntab.local.v1'] || clockKeys.length) retire();
  });
  retire();
} });
