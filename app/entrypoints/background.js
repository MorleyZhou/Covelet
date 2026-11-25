import { defineBackground } from 'wxt/utils/define-background';
import { getExtensionApi } from '../src/lib/extension-api.js';
import { retireClockSchedules } from '../src/lib/clock-runtime.js';
import { initializeLanguage, subscribeLanguage, tr } from '../src/i18n/index.js';
import { localData } from '../src/lib/local-data.js';
import { createCloudSync } from '../src/lib/cloud-sync.js';
import { startCloudSyncBackground } from '../src/lib/cloud-sync-background.js';
import { setWorkerSyncValidators } from '../src/lib/sync-data-rules.js';
import { migrateNavigationState } from '../src/lib/model.js';
import { validatePersonalTools } from '../src/lib/personal-tools.js';
import { validateContentPreferences } from '../src/lib/content-preferences.js';
import { validateSavedDesktopTemplates } from '../src/lib/desktop-templates.js';
import { validateContributionDays } from '../src/lib/github-contributions.js';
import { validateNavigationIconRecord } from '../src/lib/icon-image-record.js';
import { validateIconBytes } from '../src/lib/site-info.js';
import { scheduledBackups } from '../src/lib/scheduled-backup.js';
import { startScheduledBackupBackground } from '../src/lib/scheduled-backup-background.js';
import { validateNoteHistory } from '../src/lib/note-history-core.js';
import { rssInbox } from '../src/lib/rss-inbox.js';
import { startRssInboxBackground } from '../src/lib/rss-inbox-background.js';

export default defineBackground({ type: 'module', main() {
  const chrome = getExtensionApi();
  const languageReady = initializeLanguage();
  setWorkerSyncValidators({ migrateNavigationState, validatePersonalTools, validateContentPreferences,
    validateSavedDesktopTemplates, validateContributionDays, validateNavigationIconRecord, validateIconBytes, validateNoteHistory });
  startCloudSyncBackground(createCloudSync(), { ready: languageReady });
  startScheduledBackupBackground(scheduledBackups, { ready: languageReady });
  startRssInboxBackground(rssInbox, { ready: languageReady });
  const updateActionTitle = () => chrome.action.setTitle({ title: tr('添加到 Covelet') }).catch(() => {});
  subscribeLanguage(updateActionTitle);
  languageReady.then(updateActionTitle);
  chrome.commands.onCommand.addListener((command, activeTab) => {
    if (command !== 'open-search') return;
    const url = new URL(chrome.runtime.getURL('newtab.html'));
    url.searchParams.set('focus', 'search');
    chrome.tabs.create({ url: url.href, windowId: activeTab?.windowId }).catch(() => {});
  });
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
