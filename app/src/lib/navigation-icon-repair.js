import { loadState, saveState } from './storage.js';
import { createEncryptedStore } from './local-data.js';
import { normalizeIconAddress } from './site-icons.js';
import { sniffIconMime } from './icon-image-format.js';
import { prepareImportedNavigationIcons } from './navigation-icon-intake.js';
import { readCachedNavigationIcon, retainNavigationIconResources } from './navigation-icon-cache.js';
import { getSyncedDataRevision } from './use-synced-data.js';

const assets = createEncryptedStore('assets');
async function validLocalAsset(id) {
  try {
    const { blob } = await assets.get(id) || {};
    // Uploaded assets have their own larger historical backup limits. They
    // must not be declared corrupt merely because URL icons use a 1 MiB cap.
    if (!(blob instanceof Blob) || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)
      || !blob.size || blob.size > 10 * 1024 * 1024) return false;
    if (sniffIconMime(new Uint8Array(await blob.arrayBuffer())) !== blob.type) return false;
    const image = await createImageBitmap(blob);
    try { return image.width > 0 && image.height > 0 && image.width * image.height <= 40_000_000; }
    finally { image.close(); }
  } catch { return false; }
}

// asset(id) answers whether a deeply validated uploaded/local image exists.
// Only an explicit saved iconUrl can repair a missing local asset. Website
// favicons are never guessed for a lost custom upload.
export function createNavigationIconRepair({ load = loadState, save = saveState, asset = validLocalAsset,
  prepare = prepareImportedNavigationIcons, read = readCachedNavigationIcon } = {}) {
  async function repair(options = {}) {
    const revision = getSyncedDataRevision();
    const current = () => revision === getSyncedDataRevision() && (!options.isCurrent || options.isCurrent());
    const original = await load(), transformed = { ...original, entries: [...original.entries] };
    const selected = options.sourceUrls ? new Set(options.sourceUrls) : null;
    const checkedAssets = new Map(), candidates = new Map();
    let unrecoverableLocalAssets = 0;
    for (const [index, entry] of original.entries.entries()) {
      if (entry.type !== 'site' || entry.icon?.kind !== 'image') continue;
      if (!checkedAssets.has(entry.icon.value)) checkedAssets.set(entry.icon.value, Promise.resolve().then(() => asset(entry.icon.value)).catch(() => false));
      if (await checkedAssets.get(entry.icon.value)) continue;
      let source;
      try { source = normalizeIconAddress(entry.iconUrl); } catch { unrecoverableLocalAssets++; continue; }
      if (selected && !selected.has(source)) continue;
      transformed.entries[index] = { ...entry, iconUrl: source, icon: { kind: 'url', value: source } };
      candidates.set(entry.id, source);
    }
    const release = retainNavigationIconResources(transformed);
    try {
      const report = await prepare(transformed, { ...options, isCurrent: current });
      const result = { ...report, repairedLocalAssets: 0, unrecoverableLocalAssets };
      if (report.cancelled || !current()) return { ...result, cancelled: true };
      if (!candidates.size) return result;
      const ready = new Set();
      for (const [id, source] of candidates) if (await read(source).catch(() => null)) ready.add(id);
      if (!current()) return { ...result, cancelled: true };
      if (!ready.size) return result;
      // Persist bindings only after their exact selected URL has valid local
      // bytes. Other failed or unselected entries retain their original data.
      const next = { ...original, entries: original.entries.map((entry) => ready.has(entry.id)
        ? { ...entry, iconUrl: candidates.get(entry.id), icon: { kind: 'url', value: candidates.get(entry.id) } } : entry) };
      const saved = await save(next, original.revision);
      return { ...result, repairedLocalAssets: ready.size, state: saved };
    } finally { release(); }
  }
  return { repair };
}

export const repairNavigationIcons = createNavigationIconRepair().repair;
