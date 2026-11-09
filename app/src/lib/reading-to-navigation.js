import { tr } from '../i18n/index.js';
import { letterIcon } from './model.js';
import { loadState, saveStateWithPrivacy } from './storage.js';
import { loadContentPreferences } from './content-preferences.js';
import { withReadingRecord } from './personal-tools.js';
import { appendSiteAt, destinationChanged, navigationDestination, siteAtDestination } from './navigation-destinations.js';

export async function copyReadingToNavigation(source, value, expectedRevision) {
  const [state, preferences] = await Promise.all([loadState(), loadContentPreferences()]);
  if (state.revision !== expectedRevision) throw destinationChanged();
  const target = navigationDestination(state, value, preferences);
  const site = { id: crypto.randomUUID(), type: 'site', groupId: 'group-home', name: source.title, url: source.url,
    icon: letterIcon(source.title) };
  const next = appendSiteAt(state, site, target);
  return saveStateWithPrivacy(next, expectedRevision, (current, commit) => withReadingRecord(source.id, source.revision, (record) => {
    const hidden = current.privateKeys.includes(`reading:${record.id}`);
    if (hidden && current.presentation) throw Error(tr('请先输入密码解除隐藏。'));
    navigationDestination(state, value, current);
    if (record.url !== source.url || record.title !== source.title) throw Error(tr('这条记录已在其他页面修改，请重新打开后再保存。'));
    if (state.entries.some((entry) => siteAtDestination(entry, target) && entry.url === site.url)) throw Error(tr('这个网址已在导航中。'));
    return commit(hidden ? [`site:${site.id}`] : []);
  }));
}
