import { tr, getLocale, builtinName, providerName } from "../i18n/index.js";
import { migrateNavigationState } from './model.js';
import { portableState } from './sync.js';
import { siteIconAddress } from './site-icons.js';

const copy = (value) => structuredClone(value);
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const settingLabels = { get theme() { return tr("主题"); }, get background() { return tr("背景"); }, get shade() { return tr("背景明暗"); }, get blur() { return tr("背景模糊"); }, get width() { return tr("内容宽度"); }, get iconSize() { return tr("图标尺寸"); }, get gap() { return tr("图标间距"); }, get columns() { return tr("每行数量"); }, get showLabels() { return tr("导航名称"); }, get openNewTab() { return tr("新标签打开"); }, get visualEnhancement() { return tr("视觉增强"); }, get pages() { return tr("主屏幕"); } };
export const REVISION_FIELD_LABELS = { get name() { return tr("名称"); }, get url() { return tr("网址"); }, get parentId() { return tr("文件夹"); }, get page() { return tr("屏幕"); }, get position() { return tr("位置"); }, get order() { return tr("顺序"); }, get icon() { return tr("图标"); }, get iconUrl() { return tr("图标地址"); }, get iconFit() { return tr("图标适配"); }, get iconVariants() { return tr("图标地址"); }, get iconBackground() { return tr("图标背景"); }, get config() { return tr("组件配置"); }, get detached() { return tr("桌面显示"); }, get template() { return tr("搜索模板"); }, get type() { return tr("类型"); }, get extensionId() { return tr("扩展"); }, get groupId() { return tr("桌面"); } };
export function revisionChangeLabel(change) {
  if (change.kind === 'appearance') return settingLabels[change.key.slice(2)] || change.label;
  const record = change.after || change.before;
  if (change.kind === 'search' && record) return providerName(record);
  return record?.type === 'widget' ? builtinName(record.extensionId, record.name) : change.label;
}
function recordsOf(state) {
  const records = new Map();
  for (const entry of state.entries) records.set(`e:${entry.id}`, entry);
  state.providers.forEach((provider, position) => records.set(`p:${provider.id}`, { ...provider, position }));
  for (const [key, value] of Object.entries(state.settings)) if (Object.hasOwn(settingLabels, key)) records.set(`s:${key}`, value);
  return records;
}
export function revisionDiff(local, { snapshot, document }) {
  const current = recordsOf(portableState(local));
  const previous = snapshot ? recordsOf(portableState(snapshot)) : new Map(Object.entries(document.records).filter(([key]) => key.startsWith('e:') || key.startsWith('p:') || key.startsWith('s:') && Object.hasOwn(settingLabels, key.slice(2))).map(([key, operation]) => [key, operation.value]));
  const keys = snapshot ? new Set([...current.keys(), ...previous.keys()]) : new Set(previous.keys());
  const changes = [];
  for (const key of keys) {
    const before = current.get(key) ?? null, raw = previous.get(key) ?? null;
    const after = raw && key.startsWith('p:') ? { ...raw, position: Number.isSafeInteger(raw.position) && raw.position >= 0 && raw.position < 30 ? raw.position : before?.position ?? 0 } : raw;
    if (canonical(before) === canonical(after)) continue;
    changes.push({ key, kind: key[0] === 'e' ? 'navigation' : key[0] === 'p' ? 'search' : 'appearance',
      label: key.startsWith('s:') ? settingLabels[key.slice(2)] : after?.name || before?.name || key.slice(2),
      action: before === null ? 'add' : after === null ? 'remove' : 'update', before: copy(before), after: copy(after) });
  }
  return changes.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label, getLocale()));
}
export function revisionSelection(changes, selected) {
  const byKey = new Map(changes.map((change) => [change.key, change])), result = new Set(selected);
  for (const key of result) {
    const change = byKey.get(key);
    if (!change) throw Error(tr("所选差异已失效。"));
    // A restored child must not point to a missing or explicitly deleted folder.
    const parent = change.key.startsWith('e:') && change.after?.parentId;
    const parentChange = parent && byKey.get(`e:${parent}`);
    if (parentChange?.action === 'add') result.add(parentChange.key);
    if (parentChange?.action === 'remove') result.delete(parentChange.key);
  }
  return [...result];
}
export function applyRevisionSelection(local, changes, selected) {
  const keys = revisionSelection(changes, selected), next = copy(local);
  if (!keys.length || keys.length > 2100) throw Error(tr("请先选择要恢复的项目。"));
  const selectedChanges = changes.filter((item) => keys.includes(item.key));
  for (const change of selectedChanges) {
    const id = change.key.slice(2);
    if (change.kind === 'appearance') {
      if (change.after === null) throw Error(tr("不能移除必要的外观设置。"));
      next.settings[id] = copy(change.after);
    } else {
      const collection = change.kind === 'navigation' ? 'entries' : 'providers';
      const previous = next[collection].find((item) => item.id === id);
      next[collection] = next[collection].filter((item) => item.id !== id);
      if (change.after !== null) {
        const restored = copy(change.after);
        if (collection === 'providers') delete restored.position;
        if (collection === 'entries') {
          restored.groupId = 'group-home';
          // Preserve a valid device-local image if the historical portable URL
          // still names exactly the same source. Never revive a dangling ID.
          if (previous?.icon.kind === 'image' && previous.url === restored.url && siteIconAddress(previous) === siteIconAddress(restored)) restored.icon = copy(previous.icon);
        }
        next[collection].push(restored);
      }
    }
  }
  // Reinsert selected providers at their historical positions, preserving the
  // relative order of all unselected providers. Position is not a stored field.
  const providers = selectedChanges.filter((change) => change.kind === 'search' && change.after !== null).sort((a, b) => a.after.position - b.after.position || a.key.localeCompare(b.key));
  const restoredProviders = new Map(next.providers.map((provider) => [provider.id, provider]));
  const movedIds = new Set(providers.map((change) => change.key.slice(2)));
  next.providers = next.providers.filter((provider) => !movedIds.has(provider.id));
  for (const change of providers) next.providers.splice(Math.min(change.after.position, next.providers.length), 0, restoredProviders.get(change.key.slice(2)));
  const byId = new Map(next.entries.map((entry) => [entry.id, entry]));
  const containers = new Map();
  for (const entry of next.entries) {
    entry.groupId = 'group-home';
    if (entry.parentId && byId.get(entry.parentId)?.type !== 'folder') { entry.parentId = null; delete entry.position; }
    const key = entry.parentId || '';
    if (!containers.has(key)) containers.set(key, []);
    containers.get(key).push(entry);
  }
  for (const items of containers.values()) items.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).forEach((entry, order) => { entry.order = order; });
  return migrateNavigationState(next);
}
