// Device/session management never overwrites another device's unlock state or
// synchronizer. All content namespaces, including future extensions, are open
// by default; this is deliberately not a business-data whitelist.
export const SYNC_JOB_KEY = 'covelet.data-sync.job.v1';
const DEVICE_KEYS = new Set(['covelet.cloud.local.v1', 'covelet.tools.cloud.v1', 'covelet.data-sync.v1', 'covelet.data-sync.runs.v1', 'covelet.cloud.session.v1', 'covelet.privacy.lock.v1', 'covelet.ai.connection.v1', 'covelet.language.v1', 'covelet.home-migration.v1', 'covelet.wallpaper.source.v1', 'covelet.wallpaper.interval.v1', 'covelet.home-time.v1', SYNC_JOB_KEY]);
const PREFERENCES = 'covelet.content.preferences.v1';
const NAVIGATION = 'owntab.local.v1';
const TOOLS = 'covelet.tools.v1';
const TEMPLATES = 'covelet.desktop-templates.v1';
export const isSyncRecord = (namespace, key) => namespace !== 'full-data-pending' && (namespace !== 'wallpaper' || key !== 'commons')
  && (namespace !== 'preferences' || !DEVICE_KEYS.has(key) && !key.startsWith('covelet.app.v1.'));
const clone = (value) => structuredClone(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Blob);
const revisioned = (namespace, key) => namespace === 'preferences' && (key === PREFERENCES || key === TOOLS || key === TEMPLATES || key.startsWith('covelet.clock.v1.'));
const fail = () => { throw Object.assign(Error('Synchronized extension data is invalid; local data was preserved.'), { code: 'LOCAL_DATA_INVALID' }); };
function canonical(value) {
  if (value instanceof Blob || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function normalizeSyncValue(namespace, key, input) {
  const value = clone(input);
  if (namespace === 'preferences') {
    if (key === NAVIGATION && object(value)) {
      delete value.sync;
      if (object(value.state)) value.state.revision = 0;
      for (const state of value.snapshots || []) if (object(state)) state.revision = 0;
    }
    if (revisioned(namespace, key) && object(value)) value.revision = 0;
    if (key === PREFERENCES && object(value)) {
      delete value.presentation;
      if (Array.isArray(value.privateKeys)) value.privateKeys = [...new Set(value.privateKeys)].sort();
    }
    if (key === TOOLS && object(value)) {
      for (const kind of ['notes', 'reading', 'snapshots']) for (const record of value[kind] || []) record.revision = 1;
      for (const record of value.trash || []) if (object(record.record)) record.record.revision = 1;
    }
  }
  return canonical(value);
}
const nextRevision = (value) => {
  const revision = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (revision >= Number.MAX_SAFE_INTEGER) fail();
  return revision + 1;
};
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
export function prepareSyncValue(namespace, key, input, previous, { wholeRecord = false } = {}) {
  const value = clone(input);
  if (namespace !== 'preferences') return value;
  if (key === NAVIGATION) {
    value.state.revision = nextRevision(previous?.state?.revision);
    if (previous && Object.hasOwn(previous, 'sync')) value.sync = clone(previous.sync);
  }
  if (revisioned(namespace, key)) value.revision = nextRevision(previous?.revision);
  if (key === PREFERENCES) {
    value.presentation = previous?.presentation === true;
    if (value.presentation && !wholeRecord) value.privateKeys = [...new Set([...(previous.privateKeys || []), ...(value.privateKeys || [])])];
  }
  if (key === TOOLS) {
    for (const kind of ['notes', 'reading', 'snapshots']) {
      const existing = new Map((previous?.[kind] || []).map((record) => [record.id, record]));
      for (const record of value[kind] || []) {
        const old = existing.get(record.id);
        record.revision = old ? same({ ...record, revision: 1 }, { ...old, revision: 1 }) ? old.revision : nextRevision(old.revision) : Math.max(1, record.revision || 1);
      }
    }
  }
  return value;
}

let workerValidators;
// The background module registers static imports because MV3 service workers
// cannot execute import(). Pages keep lazy loading for startup and cycle safety.
export function setWorkerSyncValidators(validators) { workerValidators = validators; }

// Validators run before the single encrypted commit.
export async function validateSyncValue(namespace, key, value) {
  if (namespace === 'preferences') {
    if (key.startsWith('covelet.app.v1.')) {
      fail(); // Removed tool-pack namespaces cannot enter an A+ sync snapshot.
    } else if (key === NAVIGATION) {
      if (!object(value) || value.version !== 1 || !Array.isArray(value.snapshots) || value.snapshots.length > 3
        || Object.keys(value).some((field) => !['version', 'state', 'snapshots', 'sync'].includes(field))) fail();
      const { migrateNavigationState } = workerValidators || await import('./model.js');
      migrateNavigationState(value.state);
      for (const state of value.snapshots) migrateNavigationState(state);
    } else if (key === TOOLS) {
      const { validatePersonalTools } = workerValidators || await import('./personal-tools.js'); validatePersonalTools(value);
    } else if (key === PREFERENCES) {
      const { validateContentPreferences } = workerValidators || await import('./content-preferences.js'); validateContentPreferences(value);
    } else if (key === TEMPLATES) {
      const { validateSavedDesktopTemplates } = workerValidators || await import('./desktop-templates.js'); validateSavedDesktopTemplates(value);
    } else if (key.startsWith('covelet.clock.v1.')) {
      if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !['clock', 'world', 'compare', 'countdown', 'stopwatch', 'alarm'].includes(value.mode) || typeof value.notify !== 'boolean'
        || !Number.isFinite(value.duration) || value.duration < 1000 || value.duration > 86400000) fail();
      for (const timer of [value.timer, value.stopwatch]) if (!object(timer) || !Number.isFinite(timer.elapsed) || timer.elapsed < 0 || timer.elapsed > 31536000000
        || !Number.isFinite(timer.startedAt) || timer.startedAt < 0 || typeof timer.running !== 'boolean') fail();
      if (typeof value.timer.completed !== 'boolean') fail();
    } else if (key === 'covelet.github.calendar.v1') {
      if (!object(value) || Object.keys(value).length > 200 || JSON.stringify(value).length > 1024 * 1024) fail();
      const { validateContributionDays } = workerValidators || await import('./github-contributions.js');
      for (const entry of Object.values(value)) {
        if (!object(entry) || !Number.isFinite(entry.attemptedAt) || entry.attemptedAt < 0) fail();
        if (entry.days !== undefined) { validateContributionDays(entry.days); if (!Number.isFinite(entry.fetchedAt) || entry.fetchedAt < 0) fail(); }
      }
    }
  } else if (['assets', 'navigation-icons', 'provider-icons', 'wallpaper'].includes(namespace)) {
    if (!object(value)) fail();
    if (namespace === 'navigation-icons') {
      const { validateNavigationIconRecord } = workerValidators || await import('./icon-image-record.js');
      try { await validateNavigationIconRecord(value, key); } catch { fail(); }
      return;
    }
    for (const field of ['blob', 'darkBlob']) if (value[field] !== undefined) {
      const blob = value[field];
      if (!(blob instanceof Blob) || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || !blob.size || blob.size > 10 * 1024 * 1024) fail();
      if (namespace === 'navigation-icons' || namespace === 'provider-icons') {
        const { validateIconBytes } = workerValidators || await import('./site-info.js'); validateIconBytes(new Uint8Array(await blob.arrayBuffer()), blob.type);
      }
    }
    if (namespace === 'assets' && (value.id !== key || !(value.blob instanceof Blob))) fail();
    if (namespace === 'navigation-icons' && (value.url !== key || !(value.blob instanceof Blob) || !Number.isInteger(value.width) || !Number.isInteger(value.height)
      || value.width < 1 || value.height < 1 || value.width > 4096 || value.height > 4096 || value.width * value.height > 4000000
      || !Number.isFinite(value.updatedAt) || typeof value.adaptive !== 'boolean' || typeof value.vector !== 'boolean' || value.adaptive && !(value.darkBlob instanceof Blob))) fail();
    if (namespace === 'provider-icons' && (value.origin !== key || !(value.blob instanceof Blob) || !Number.isFinite(value.updatedAt))) fail();
  }
}
