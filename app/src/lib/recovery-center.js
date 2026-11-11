import { tr } from '../i18n/index.js';
import { localData } from './local-data.js';
import * as navigation from './storage.js';
import { migrateNavigationState } from './model.js';
import { loadPersonalToolsSnapshot, validatePersonalTools, replacePersonalTools, inspectPersonalToolsBackup, personalContentKeys } from './personal-tools.js';
import { loadContentPreferences, validateContentPreferences, replaceContentPreferences, mergeContentPreferences, contentPreferencesForKeys } from './content-preferences.js';
import { loadDesktopTemplateEnvelope, validateSavedDesktopTemplates, replaceDesktopTemplates } from './desktop-templates.js';
import { navigationIconSources } from './navigation-icon-intake.js';
import { cloneTrashForAppend } from './navigation-trash-core.js';
import { navigationResourceEntries } from './navigation-resources.js';
import { remapNavigationPreferences, preserveInvalidViewReferences } from './navigation-recovery.js';
import { privateContentKeys } from './presentation.js';
import { encryptCompleteBackup, decryptCompleteBackup, throwIfBackupCancelled, validateBackupPassword } from './password-backup.js';

const FORMAT = 'covelet-complete-backup';
const MAX_BYTES = 50 * 1024 * 1024;
const KEY = 'covelet.recovery-point.v1';
const copy = (value) => structuredClone(value);
const fail = (message, code = 'INVALID_BACKUP') => { throw Object.assign(Error(message), { code }); };
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
const conflict = () => fail(tr('恢复期间数据已更新，请重新预览。'), 'REVISION_CONFLICT');
const encodedBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
function toBase64(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 16384) text += String.fromCharCode(...bytes.subarray(index, index + 16384));
  return btoa(text);
}
function fromBase64(value) {
  if (typeof value !== 'string' || value.length > 40 * 1024 * 1024 || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)
    || value.includes('=') && !/^={1,2}$/.test(value.slice(value.indexOf('=')))) fail(tr('完整备份中的导航文件无效。'));
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
const checkpointStore = {
  async read() { return (await localData.get(KEY))[KEY] ?? null; },
  async write(value) { await localData.set({ [KEY]: value }); },
};

export const RECOVERY_CATEGORIES = ['navigation', 'notes', 'reading', 'trash', 'templates', 'preferences'];
const summary = (data) => ({
  navigation: data.navigation?.state.entries.length ?? 0,
  notes: data.tools?.notes.length ?? 0, reading: data.tools?.reading.length ?? 0,
  trash: data.tools?.trash?.filter((item) => ['notes', 'reading'].includes(item.kind)).length ?? 0,
  templates: data.templates?.templates.length ?? 0,
  preferences: data.preferences ? new Set([...Object.keys(data.preferences.aliases), ...data.preferences.privateKeys,
    ...Object.keys(data.preferences.library?.items || {}), ...(data.preferences.library?.views || []).map((view) => `view:${view.id}`)]).size : 0,
});

// Each data domain retains its own revision lock. A durable recovery point is
// committed before the first change; rollback never overwrites a later edit.
export function createRecoveryCenter({ nav = navigation, tools = { read: loadPersonalToolsSnapshot, validate: validatePersonalTools, write: replacePersonalTools },
  preferences = { read: loadContentPreferences, validate: validateContentPreferences, write: replaceContentPreferences },
  templates = { read: loadDesktopTemplateEnvelope, validate: validateSavedDesktopTemplates, write: replaceDesktopTemplates },
  points = checkpointStore, locks = globalThis.navigator?.locks } = {}) {
  const readDomains = async () => {
    const [state, toolData, prefs, schemes] = await Promise.all([nav.loadState(), tools.read(), preferences.read(), templates.read()]);
    return { state, tools: toolData, preferences: prefs, templates: schemes };
  };
  const versions = (value) => ({ navigation: value.state.revision, tools: value.tools.revision, preferences: value.preferences.revision, templates: value.templates.revision });
  const pointRecord = (point) => { const { previous: _previous, ...value } = point; return value; };
  const findPoint = (point, id) => !id || point?.id === id ? point : point?.previous?.id === id ? point.previous : null;
  const pointInfo = (point) => point ? { id: point.id, createdAt: point.createdAt, status: point.status } : null;
  async function capture({ signal } = {}) {
    // Retry when another tab changes a domain while assets are being read.
    for (let attempt = 0; attempt < 3; attempt++) {
      throwIfBackupCancelled(signal); const before = await readDomains(); throwIfBackupCancelled(signal);
      const blob = await nav.exportBackup(before.state); throwIfBackupCancelled(signal);
      const after = await readDomains(); throwIfBackupCancelled(signal);
      if (JSON.stringify(versions(before)) !== JSON.stringify(versions(after))) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer()); throwIfBackupCancelled(signal);
      const data = { format: FORMAT, version: 1, createdAt: new Date().toISOString(),
        navigation: toBase64(bytes),
        tools: tools.validate(before.tools), preferences: preferences.validate({ ...before.preferences, presentation: false }), templates: templates.validate(before.templates) };
      if (encodedBytes(data) > MAX_BYTES) fail(tr('完整备份超过 50 MiB，请先清理不需要的内容。'));
      return { data, current: before };
    }
    conflict();
  }
  async function inspect(file, { signal } = {}) {
    throwIfBackupCancelled(signal);
    if (!(file instanceof Blob) || !file.size || file.size > MAX_BYTES) fail(tr('完整备份文件须在 50 MiB 以内。'));
    const prefix = new Uint8Array(await file.slice(0, 4).arrayBuffer()); throwIfBackupCancelled(signal);
    if (prefix[0] === 80 && prefix[1] === 75) {
      const plan = await nav.inspectBackup(file); throwIfBackupCancelled(signal);
      return { format: 'legacy-navigation', createdAt: null, navigation: plan, tools: null, templates: null, preferences: null,
        categories: ['navigation'], summary: summary({ navigation: plan }), source: null };
    }
    let input;
    let contents;
    try {
      const bytes = await file.arrayBuffer(); throwIfBackupCancelled(signal);
      contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch { throwIfBackupCancelled(signal); fail(tr('备份文件无法读取。')); }
    throwIfBackupCancelled(signal);
    try { input = JSON.parse(contents); } catch { fail(tr('备份文件无法读取。')); }
    if (input?.format === 'covelet-personal-tools') {
      const parsed = inspectPersonalToolsBackup(input), checked = tools.validate(parsed.data);
      const result = { format: 'legacy-tools', createdAt: typeof input.exportedAt === 'string' && Number.isFinite(Date.parse(input.exportedAt)) ? input.exportedAt : null, navigation: null,
        tools: checked, preferences: parsed.preferences, templates: null, categories: ['notes', 'reading', 'trash', ...(parsed.preferences ? ['preferences'] : [])], source: null };
      return { ...result, summary: summary(result) };
    }
    const required = ['format', 'version', 'createdAt', 'navigation', 'tools', 'preferences', 'templates'];
    if (!fields(input, required) || required.some((key) => !Object.hasOwn(input, key) || input[key] == null) || input.format !== FORMAT || input.version !== 1
      || typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))) fail(tr('完整备份格式或版本不受支持。'));
    const navigation = await nav.inspectBackup(new Blob([fromBase64(input.navigation)], { type: 'application/zip' })); throwIfBackupCancelled(signal);
    const result = { format: FORMAT, createdAt: input.createdAt, source: copy(input),
      navigation,
      tools: tools.validate(input.tools), preferences: preferences.validate(input.preferences), templates: templates.validate(input.templates),
      categories: RECOVERY_CATEGORIES };
    return { ...result, summary: summary(result) };
  }
  async function preview(file, options = {}) {
    throwIfBackupCancelled(options.signal); const plan = await inspect(file, options); throwIfBackupCancelled(options.signal);
    const current = await readDomains(); throwIfBackupCancelled(options.signal);
    return { ...plan, expected: versions(current) };
  }
  function selectedTools(current, incoming, selected, mode) {
    const next = copy(current);
    for (const kind of ['notes', 'reading', 'trash']) {
      if (!selected.includes(kind)) continue;
      const records = (incoming[kind] || []).filter((item) => kind !== 'trash' || ['notes', 'reading'].includes(item.kind));
      if (mode === 'replace') next[kind] = [...(kind === 'trash' ? current.trash.filter((item) => item.kind === 'snapshots') : []), ...copy(records)];
      else {
        const ids = new Set([...next.notes, ...next.reading, ...next.snapshots, ...(next.trash || [])].map((item) => item.id));
        const urls = new Set(next.reading.map((item) => item.url));
        for (const item of records) {
          if (ids.has(item.id) || kind === 'reading' && urls.has(item.url)) continue;
          (next[kind] ??= []).push(copy(item)); ids.add(item.id); if (kind === 'reading') urls.add(item.url);
        }
      }
    }
    // Preserve this device's sync tracking; restoring content is a fresh local
    // edit, not a rollback of deletion knowledge learned from other devices.
    return tools.validate(next);
  }
  async function mergeNavigation(current, incoming, currentPreferences) {
    const existing = await nav.inspectBackup(await nav.exportBackup(current));
    const state = migrateNavigationState(copy(existing.state)), source = migrateNavigationState(copy(incoming.state));
    const ids = new Set(state.entries.map((entry) => entry.id)), urls = new Set(state.entries.filter((entry) => entry.type === 'site').map((entry) => entry.url));
    const offset = Math.max(...state.settings.pages) + 1;
    const pageMap = new Map(source.settings.pages.map((page, index) => [page, offset + index]));
    const added = source.entries.filter((entry) => !ids.has(entry.id) && (entry.type !== 'site' || !urls.has(entry.url)));
    const roots = new Set(added.filter((entry) => entry.type === 'folder').map((entry) => entry.id));
    const reservedPreferenceKeys = [...Object.keys(currentPreferences.aliases), ...currentPreferences.privateKeys, ...Object.keys(currentPreferences.library?.items || {})];
    const reservedIds = new Set([...navigationResourceEntries(state).map((entry) => entry.id), ...(state.trash?.items || []).flatMap((item) => item.memberRefs.map((member) => member.id)),
      ...reservedPreferenceKeys.map((key) => key.slice(key.indexOf(':') + 1))]);
    const occupiedIds = new Set([...reservedIds, ...navigationResourceEntries(source).map((entry) => entry.id)]), plannedIds = new Map();
    for (const entry of added) {
      let id = entry.id;
      if (reservedIds.has(id)) {
        id = null;
        for (let attempt = 0; attempt < 100; attempt++) { const candidate = crypto.randomUUID(); if (!occupiedIds.has(candidate)) { id = candidate; break; } }
        if (!id) conflict();
      }
      occupiedIds.add(id); plannedIds.set(entry.id, id);
    }
    const assets = new Map(existing.assets), appended = [], activeIdMap = new Map();
    for (const entry of added) {
      if (entry.parentId && !roots.has(entry.parentId)) continue;
      if (entry.type === 'site' && urls.has(entry.url)) continue;
      const next = { ...entry, id: plannedIds.get(entry.id), parentId: entry.parentId ? plannedIds.get(entry.parentId) : null,
        groupId: state.groups[0].id, page: pageMap.get(entry.page ?? 0) ?? offset };
      if (next.parentId) { delete next.page; delete next.position; }
      if (next.icon?.kind === 'image') {
        // ZIP resource IDs are untrusted and can collide with local assets.
        const id = crypto.randomUUID(), asset = incoming.assets.get(next.icon.value);
        if (!asset) fail(tr('备份中的图片不完整，请重新选择备份文件。'));
        assets.set(id, asset); next.icon = { ...next.icon, value: id };
      }
      next.order = state.entries.filter((item) => item.parentId === next.parentId && item.groupId === next.groupId).length;
      state.entries.push(next); ids.add(next.id); if (next.type === 'site') urls.add(next.url);
      appended.push(next); activeIdMap.set(entry.id, next.id);
      if (next.parentId === null && !state.settings.pages.includes(next.page)) state.settings.pages.push(next.page);
    }
    state.settings.pages.sort((a, b) => a - b);
    const desktopIds = new Set(Object.values(state.settings.desktopPages ?? {}).map((page) => page.id)), desktopIdMap = new Map();
    for (const [page, metadata] of Object.entries(source.settings.desktopPages ?? {})) {
      const target = pageMap.get(Number(page));
      const id = desktopIds.has(metadata.id) ? crypto.randomUUID() : metadata.id;
      desktopIdMap.set(metadata.id, id);
      // Even if every source site was deduplicated, its view must not fall
      // through to a different local desktop that happens to share its ID.
      if (!state.settings.pages.includes(target)) continue;
      (state.settings.desktopPages ??= {})[target] = { ...metadata, id };
      desktopIds.add(id);
    }
    const cloned = cloneTrashForAppend(state, source, { activeIdMap, desktopIdMap, pageMap, reservedPreferenceKeys });
    const importedOwnedIds = new Set(cloned.ownedIdMap.values()), assetIds = new Map();
    const importedOwned = navigationResourceEntries(cloned.state).filter((entry) => importedOwnedIds.has(entry.id));
    for (const entry of importedOwned) if (entry.icon?.kind === 'image') {
      const originalId = entry.icon.value;
      if (!assetIds.has(originalId)) {
        const asset = incoming.assets.get(originalId);
        if (!asset) fail(tr('备份中的图片不完整，请重新选择备份文件。'));
        const id = crypto.randomUUID(); assetIds.set(originalId, id); assets.set(id, asset);
      }
      entry.icon.value = assetIds.get(originalId);
    }
    const icons = new Map(existing.icons), appendedSources = new Set(navigationIconSources({ entries: [...appended, ...importedOwned] }).map((item) => item.source));
    for (const [source, record] of incoming.icons || []) if (appendedSources.has(source) && !icons.has(source)) icons.set(source, record);
    return { plan: { state: migrateNavigationState(cloned.state), assets, icons }, desktopIdMap,
      preferenceKeyMap: cloned.preferenceKeyMap, referenceIdMap: cloned.referenceIdMap };
  }
  async function restore(plan, { selected = plan.categories, mode = 'replace', onIconProgress, onIconResult } = {}) {
    if (!plan?.expected || !['replace', 'append'].includes(mode) || !Array.isArray(selected) || !selected.length || selected.some((key) => !RECOVERY_CATEGORIES.includes(key) || !plan.categories.includes(key))) fail(tr('请选择有效的恢复类别。'));
    const action = async () => {
      const snapshot = await capture(), before = snapshot.current, expected = versions(before);
      if (Object.keys(expected).some((key) => expected[key] !== plan.expected[key])) conflict();
      const existingPoint = await points.read(), sourcePoint = plan.recoveryPointId ? findPoint(existingPoint, plan.recoveryPointId) : null;
      if (plan.recoveryPointId && !sourcePoint) fail(tr('恢复前副本已更新，请重新预览。'));
      if (existingPoint && ['applying', 'needs-recovery'].includes(existingPoint.status) && !sourcePoint) fail(tr('上次恢复未完成，请先从「恢复前副本」找回需要的内容，再导入其他备份。'));
      // Re-validate mutable preview values before any persistence.
      const next = {}; let desktopIdMap = new Map(), navigationMapping = null;
      if (selected.includes('navigation')) {
        if (mode === 'append') {
          const merged = await mergeNavigation(before.state, plan.navigation, before.preferences);
          next.navigation = merged.plan; desktopIdMap = merged.desktopIdMap;
          navigationMapping = merged;
        } else next.navigation = plan.navigation;
      }
      if (selected.some((key) => ['notes', 'reading', 'trash'].includes(key))) next.tools = selectedTools(before.tools, plan.tools, selected, mode);
      if (selected.includes('templates')) {
        const list = mode === 'append' ? [...before.templates.templates, ...plan.templates.templates.filter((item) => !before.templates.templates.some((old) => old.id === item.id))] : plan.templates.templates;
        next.templates = templates.validate({ ...before.templates, templates: list });
      }
      if (selected.includes('preferences')) {
        if (plan.format === 'legacy-tools' && plan.preferences) {
          const existingKeys = new Set(personalContentKeys(before.tools));
          const importedKeys = mode === 'replace' ? personalContentKeys(plan.tools, selected)
            : personalContentKeys(next.tools || before.tools, selected).filter((key) => !existingKeys.has(key));
          next.preferences = preferences.validate(mergeContentPreferences(before.preferences, contentPreferencesForKeys(plan.preferences, importedKeys),
            { replaceKeys: mode === 'replace' ? personalContentKeys(before.tools, selected) : [] }));
        } else {
          const protectedPreferences = mode === 'append' ? preserveInvalidViewReferences(plan.preferences, { sourceNavigation: plan.navigation?.state,
            targetNavigation: next.navigation?.state || before.state, targetPreferences: before.preferences, includeRecycledFolders: Boolean(navigationMapping) }) : plan.preferences;
          const incomingPreferences = navigationMapping ? remapNavigationPreferences(protectedPreferences, {
            preferenceKeyMap: navigationMapping.preferenceKeyMap, referenceIdMap: navigationMapping.referenceIdMap,
            reservedEntryIds: navigationResourceEntries(next.navigation.state).map((entry) => entry.id),
          }) : protectedPreferences;
          next.preferences = preferences.validate(mode === 'append' ? mergeContentPreferences(before.preferences, incomingPreferences, { desktopIdMap }) : incomingPreferences);
        }
      }
      if (next.navigation) {
        const base = next.preferences || before.preferences;
        const retained = new Set(base.privateKeys), present = new Set(navigationResourceEntries(next.navigation.state).map((entry) => `${entry.type}:${entry.id}`));
        if (plan.preferences) for (const key of privateContentKeys(plan.navigation.state, plan.preferences)) {
          const mapped = navigationMapping ? navigationMapping.preferenceKeyMap.get(key) : key;
          if (present.has(mapped)) retained.add(mapped);
        }
        // Omitting the metadata category, or restoring while locked, must not
        // expose a formerly inherited private site after its folder changes.
        if (!selected.includes('preferences') || before.preferences.presentation) {
          const effective = privateContentKeys(next.navigation.state, { ...base, privateKeys: [...retained] });
          for (const key of privateContentKeys(before.state, before.preferences)) if (present.has(key) && !effective.has(key)) retained.add(key);
        }
        next.preferences = preferences.validate({ ...base, privateKeys: [...retained] });
      }
      // Validation includes archive resources before the checkpoint and writes.
      if (next.navigation) next.navigation = await nav.validateBackupPlan(next.navigation);
      const point = { version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: 'applying', data: snapshot.data, selected, mode,
        ...(sourcePoint || existingPoint ? { previous: pointRecord(sourcePoint || existingPoint) } : {}) };
      await points.write(point); // Failure here means nothing has changed.
      const saved = {}, completed = [];
      let iconReport = null, applyingDomain = null;
      const existingIds = new Set(before.state.entries.map((entry) => entry.id));
      const iconOptions = { onIconProgress, onIconResult: (report) => { iconReport = report; onIconResult?.(report); },
        ...(mode === 'append' && next.navigation ? { iconEntryIds: next.navigation.state.entries.filter((entry) => !existingIds.has(entry.id)).map((entry) => entry.id) } : {}) };
      try {
        const paired = next.navigation && next.preferences && typeof nav.restoreBackupWithPreferences === 'function';
        for (const domain of ['navigation', 'tools', 'templates', 'preferences']) {
          if (!next[domain]) continue;
          if (paired && domain === 'preferences') continue;
          applyingDomain = paired && domain === 'navigation' ? 'navigation-preferences' : domain;
          if (paired && domain === 'navigation') {
            const result = await nav.restoreBackupWithPreferences(next.navigation, { ...iconOptions,
              expectedNavigationRevision: expected.navigation, expectedPreferencesRevision: expected.preferences, preferences: next.preferences });
            saved.navigation = result.state; saved.preferences = result.preferences; completed.push('navigation-preferences'); applyingDomain = null; continue;
          }
          saved[domain] = domain === 'navigation' ? await nav.restoreBackup(next.navigation, expected.navigation, iconOptions)
            : await ({ tools, templates, preferences })[domain].write(next[domain], { expectedRevision: expected[domain] });
          completed.push(domain);
          applyingDomain = null;
        }
        await points.write({ ...point, status: 'complete' });
        return { state: await nav.loadState(), summary: summary(plan), recoveryPoint: point.id, iconReport };
      } catch (cause) {
        const rollbackFailed = [];
        if (applyingDomain && (completed.length || cause.code !== 'REVISION_CONFLICT')) {
          try {
            const changed = applyingDomain === 'navigation-preferences'
              ? (await nav.loadState()).revision !== expected.navigation || (await preferences.read()).revision !== expected.preferences
              : applyingDomain === 'navigation' ? (await nav.loadState()).revision !== expected.navigation
                : (await ({ tools, templates, preferences })[applyingDomain].read()).revision !== expected[applyingDomain];
            if (changed) rollbackFailed.push(applyingDomain);
          } catch { rollbackFailed.push(applyingDomain); }
        }
        for (const domain of completed.reverse()) {
          try {
            if (domain === 'navigation-preferences') {
              // A newer tool/template may still depend on the imported
              // metadata. Keep the pair when an earlier rollback was refused.
              if (rollbackFailed.length) conflict();
              const original = await nav.inspectBackup(new Blob([fromBase64(snapshot.data.navigation)]));
              await nav.restoreBackupWithPreferences(original, { expectedNavigationRevision: saved.navigation.revision,
                expectedPreferencesRevision: saved.preferences.revision, preferences: before.preferences, hydrateIcons: false });
            } else if (domain === 'navigation') {
              const original = await nav.inspectBackup(new Blob([fromBase64(snapshot.data.navigation)]));
              await nav.restoreBackup(original, saved.navigation.revision, { hydrateIcons: false });
            } else await ({ tools, templates, preferences })[domain].write(before[domain], { expectedRevision: saved[domain].revision });
          } catch { rollbackFailed.push(domain); }
        }
        await points.write({ ...point, status: rollbackFailed.length ? 'needs-recovery' : 'rolled-back', failedDomains: rollbackFailed }).catch(() => {});
        throw Object.assign(Error(rollbackFailed.length ? tr('恢复未完成，部分更改未能撤销。请打开「恢复前副本」，预览并恢复需要找回的内容。') : tr('恢复失败，本次更改已撤销。')), { code: rollbackFailed.length ? 'RECOVERY_REQUIRED' : cause.code, cause });
      }
    };
    if (!locks?.request) fail(tr('无法开始恢复，当前数据未改变。请稍后重试。'));
    return locks.request('covelet.complete-recovery.v1', action);
  }
  return {
    preview, restore,
    async exportCompleteBackup(options = {}) { const { data } = await capture(options); throwIfBackupCancelled(options.signal); return new Blob([JSON.stringify(data)], { type: 'application/json' }); },
    async exportEncryptedBackup(password, options = {}) {
      throwIfBackupCancelled(options.signal); validateBackupPassword(password);
      const { data } = await capture(options); throwIfBackupCancelled(options.signal);
      const blob = await encryptCompleteBackup(new Blob([JSON.stringify(data)], { type: 'application/json' }), password, options); throwIfBackupCancelled(options.signal);
      return blob;
    },
    async previewEncryptedBackup(file, password, options = {}) {
      throwIfBackupCancelled(options.signal);
      const plain = await decryptCompleteBackup(file, password, options); throwIfBackupCancelled(options.signal);
      const plan = await preview(plain, options); throwIfBackupCancelled(options.signal);
      if (plan.format !== FORMAT) fail(tr('完整备份格式或版本不受支持。'));
      return plan;
    },
    async getRecoveryPoint() { const point = await points.read(); return point ? { ...pointInfo(point), previous: pointInfo(point.previous) } : null; },
    async previewRecoveryPoint(id) {
      const point = findPoint(await points.read(), id);
      if (!point?.data) fail(tr('还没有恢复前副本。'));
      return { ...await preview(new Blob([JSON.stringify(point.data)], { type: 'application/json' })), recoveryPointId: point.id };
    },
    async exportRecoveryPoint(id) {
      const point = findPoint(await points.read(), id); if (!point?.data) fail(tr('还没有恢复前副本。'));
      return new Blob([JSON.stringify(point.data)], { type: 'application/json' });
    },
  };
}
export const recoveryCenter = createRecoveryCenter();
