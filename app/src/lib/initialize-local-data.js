import { localData, createEncryptedStore } from './local-data.js';
import { migrateLegacyIndexedDb } from './legacy-indexed-data.js';
import { migrateNavigationIconCache } from './navigation-icon-cache.js';
import { migrateProviderIconCache } from './provider-icons.js';
import { migrateWallpaperCache } from './wallpaper.js';
import { migrateGitHubCalendarCache } from './github-contributions.js';

let initialization;
export function initializeLocalData() {
  if (!initialization) initialization = (async () => {
    // Import all owned legacy records, including data belonging to extensions
    // that are not currently on the desktop or opened by the user.
    await localData.get(null);
    await Promise.all([
      migrateLegacyIndexedDb('owntab-assets', 'assets', createEncryptedStore('assets'), (record) => record.id),
      migrateNavigationIconCache(), migrateProviderIconCache(), migrateWallpaperCache(), migrateGitHubCalendarCache(),
    ]);
  })().catch((error) => { initialization = undefined; throw error; });
  return initialization;
}
