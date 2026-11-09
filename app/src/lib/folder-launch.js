import { normalizeUrl } from './model.js';

export const MAX_FOLDER_LAUNCH = 10;

export function folderLaunchSites(entries, folderId, hiddenKeys) {
  if (hiddenKeys?.has(`folder:${folderId}`) || !entries.some((entry) => entry.type === 'folder' && entry.id === folderId)) return [];
  const urls = new Set(), sites = [];
  const children = entries.filter((entry) => entry.type === 'site' && entry.parentId === folderId)
    .sort((left, right) => left.order - right.order);
  for (const { id, name, url } of children) {
    if (hiddenKeys?.has(`site:${id}`) || !/^https?:\/\//iu.test(url)) continue;
    let address;
    try { address = normalizeUrl(url); } catch { continue; }
    if (urls.has(address)) continue;
    urls.add(address);
    sites.push({ id, name, url: address });
  }
  return sites;
}

export async function launchFolderSites(sites, openTab, isAvailable = () => true) {
  const opened = [], failed = [];
  for (const site of sites.slice(0, MAX_FOLDER_LAUNCH)) {
    try {
      if (!isAvailable(site)) {
        failed.push(site.id);
        continue;
      }
      await openTab({ url: site.url, active: false });
      opened.push(site.id);
    } catch { failed.push(site.id); }
  }
  return { opened, failed };
}
