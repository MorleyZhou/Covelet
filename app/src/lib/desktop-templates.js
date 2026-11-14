import { tr } from '../i18n/index.js';
import { localData } from './local-data.js';
import { createEmptyState, letterIcon, migrateNavigationState, validateDesktopAppearance, validateState } from './model.js';
import { DESKTOP_ROWS, MAX_DESKTOP_PAGE, freezeDesktopPositions, nextDesktopPage } from './desktop-layout.js';
import { CLOCK_WIDGET_ID, NOTES_WIDGET_ID, READING_WIDGET_ID, SAVED_VIEW_WIDGET_ID, WIDGET_NAMES, validateWidgetConfig, widgetContentReference } from './widget-model.js';
import { prepareImport } from './import-plan.js';
import { withDesktopPageIdentity } from './desktop-pages.js';

export const DESKTOP_TEMPLATE_MAX_BYTES = 256 * 1024;
export const DESKTOP_TEMPLATE_MAX_SAVED = 20;
const FORMAT = 'covelet-desktop-template';
const SAFE_WIDGETS = new Set([CLOCK_WIDGET_ID, NOTES_WIDGET_ID, READING_WIDGET_ID, SAVED_VIEW_WIDGET_ID]);
// Old templates retain their clock configuration when read or backed up, but
// new captures and applications no longer add or reposition the retired widget.
export const activeTemplateWidgets = (template) => template.widgets.filter((widget) => widget.extensionId !== CLOCK_WIDGET_ID);
const APPEARANCE_KEYS = ['theme', 'background', 'shade', 'blur', 'width', 'iconSize', 'gap', 'columns', 'showLabels', 'showClock', 'visualEnhancement'];
const encoder = new TextEncoder();
const copy = (value) => structuredClone(value);
const fail = (message) => { throw Error(message); };
const newId = (kind) => `${kind}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail(tr('无法读取这份桌面方案，请重新选择文件。'));
}
function templateName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) fail(tr('方案名称须为 1 至 200 个字符。'));
  return value.trim();
}
function encoded(value) {
  try {
    const json = JSON.stringify(value);
    if (!json || encoder.encode(json).byteLength > DESKTOP_TEMPLATE_MAX_BYTES) fail(tr('桌面方案不能超过 256 KB。'));
    return json;
  } catch (reason) { fail(reason.message || tr('桌面方案格式无效。')); }
}
function appearanceOf(settings) {
  const appearance = Object.fromEntries(APPEARANCE_KEYS.map((key) => [key, copy(settings[key])]));
  if (appearance.background.kind === 'image') appearance.background = { kind: 'bing', value: 'daily' };
  return appearance;
}
function publicWidgetConfig(extensionId, config) {
  // Shared templates carry geometry, never personal content identities. Notes
  // become the existing generic component; a view becomes an unbound picker.
  return [NOTES_WIDGET_ID, SAVED_VIEW_WIDGET_ID].includes(extensionId) ? { size: config.size } : copy(config);
}
function checkedPosition(position) {
  if (position === undefined) return undefined;
  fields(position, ['row', 'column']);
  if (!Number.isSafeInteger(position.row) || position.row < 0 || position.row >= DESKTOP_ROWS
    || !Number.isSafeInteger(position.column) || position.column < 0 || position.column > 11) fail(tr('方案中的图标位置无效。'));
  return copy(position);
}
function checkedPage(page) {
  if (!Number.isSafeInteger(page) || page < 0 || page > MAX_DESKTOP_PAGE) fail(tr('方案中的主屏幕无效。'));
  return page;
}

export function inspectDesktopTemplate(input) {
  let raw = input;
  if (typeof raw === 'string') {
    if (encoder.encode(raw).byteLength > DESKTOP_TEMPLATE_MAX_BYTES) fail(tr('桌面方案不能超过 256 KB。'));
    try { raw = JSON.parse(raw); } catch { fail(tr('无法读取这份桌面方案，请重新选择文件。')); }
  }
  encoded(raw);
  fields(raw, ['format', 'version', 'name', 'appearance', 'widgets', 'sites', 'desktopAppearances']);
  if (raw.format !== FORMAT || raw.version !== 1 || !Array.isArray(raw.widgets) || !Array.isArray(raw.sites)
    || raw.widgets.length > 50 || raw.widgets.length + raw.sites.length > 2000) fail(tr('桌面方案格式或版本不受支持。'));
  fields(raw.appearance, APPEARANCE_KEYS);
  if (!raw.appearance.background || raw.appearance.background.kind === 'image') fail(tr('桌面方案不能包含图片资源。'));
  const sample = createEmptyState();
  sample.settings = { ...sample.settings, ...copy(raw.appearance) };
  const widgets = raw.widgets.map((widget, index) => {
    fields(widget, ['extensionId', 'config', 'page', 'position']);
    if (!SAFE_WIDGETS.has(widget.extensionId)) fail(tr('桌面方案不能包含账号组件或未知组件。'));
    if ([NOTES_WIDGET_ID, SAVED_VIEW_WIDGET_ID].includes(widget.extensionId)) fields(widget.config, ['size']);
    const result = { extensionId: widget.extensionId, config: validateWidgetConfig(widget.extensionId, widget.config), page: checkedPage(widget.page) };
    const position = checkedPosition(widget.position);
    if (position) result.position = position;
    sample.entries.push({ id: `template-widget-${index}`, type: 'widget', name: WIDGET_NAMES[result.extensionId], extensionId: result.extensionId,
      config: result.config, groupId: 'group-home', parentId: null, page: result.page, ...(position ? { position } : {}), icon: letterIcon(WIDGET_NAMES[result.extensionId]), order: index });
    return result;
  });
  raw.sites.forEach((site, index) => {
    fields(site, ['name', 'url', 'page', 'position']);
    const position = checkedPosition(site.position);
    sample.entries.push({ id: `template-site-${index}`, type: 'site', name: site.name, url: site.url,
      groupId: 'group-home', parentId: null, page: checkedPage(site.page), ...(position ? { position } : {}), icon: letterIcon(site.name), order: widgets.length + index });
  });
  const checked = validateState(sample);
  const template = { format: FORMAT, version: 1, name: templateName(raw.name), appearance: appearanceOf(checked.settings), widgets,
    sites: checked.entries.filter((entry) => entry.type === 'site').map((entry) => ({ name: entry.name, url: entry.url, page: entry.page, ...(entry.position ? { position: entry.position } : {}) })) };
  if (Object.hasOwn(raw, 'desktopAppearances')) {
    if (!Array.isArray(raw.desktopAppearances) || raw.desktopAppearances.length > MAX_DESKTOP_PAGE + 1) fail(tr('方案中的主屏幕无效。'));
    const pages = new Set();
    const appearances = raw.desktopAppearances.map((item) => {
      fields(item, ['page', 'appearance']);
      const page = checkedPage(item.page), appearance = validateDesktopAppearance(item.appearance);
      if (pages.has(page) || !Object.keys(appearance).length) fail(tr('方案中的主屏幕无效。'));
      pages.add(page); return { page, appearance };
    });
    if (appearances.length) template.desktopAppearances = appearances;
  }
  encoded(template);
  return template;
}

export function createDesktopTemplate(input, { name = tr('我的桌面方案'), publicSiteIds = [], privateEntryIds = [], includeDesktopAppearances = false } = {}) {
  if (typeof includeDesktopAppearances !== 'boolean') fail(tr('方案应用选项无效。'));
  const state = migrateNavigationState(input), privateIds = new Set(privateEntryIds), selected = new Set(publicSiteIds);
  const widgets = state.entries.filter((entry) => entry.type === 'widget' && entry.extensionId !== CLOCK_WIDGET_ID && !entry.detached && SAFE_WIDGETS.has(entry.extensionId) && !privateIds.has(entry.id));
  const sites = state.entries.filter((entry) => entry.type === 'site' && selected.has(entry.id) && !privateIds.has(entry.id) && !privateIds.has(entry.parentId));
  const pages = [...new Set([...widgets, ...sites].map((entry) => entry.page ?? 0))].sort((a, b) => a - b);
  const pageMap = new Map(pages.map((page, index) => [page, index]));
  // Engine-only, explicit opt-in. The current app has no template sharing UI.
  // Only public represented pages enter this anonymous relative page map.
  const desktopAppearances = includeDesktopAppearances ? pages.filter((page) => state.settings.desktopPages?.[page]?.appearance)
    .map((page) => ({ page: pageMap.get(page), appearance: copy(state.settings.desktopPages[page].appearance) })) : [];
  return inspectDesktopTemplate({ format: FORMAT, version: 1, name, appearance: appearanceOf(state.settings),
    ...(desktopAppearances.length ? { desktopAppearances } : {}),
    widgets: widgets.map((entry) => ({ extensionId: entry.extensionId, config: publicWidgetConfig(entry.extensionId, entry.config), page: pageMap.get(entry.page ?? 0), ...(entry.position ? { position: copy(entry.position) } : {}) })),
    sites: sites.map((entry) => ({ name: entry.name, url: entry.url, page: pageMap.get(entry.page ?? 0), ...(entry.parentId === null && entry.position ? { position: copy(entry.position) } : {}) })) });
}

export function applyDesktopTemplate(input, value, { appearance = true, widgets = false, sites = false } = {}) {
  if ([appearance, widgets, sites].some((value) => typeof value !== 'boolean')) fail(tr('方案应用选项无效。'));
  const template = inspectDesktopTemplate(value);
  let state = migrateNavigationState(input);
  const originalPages = new Set(state.settings.pages);
  if (appearance) state.settings = { ...state.settings, ...copy(template.appearance) };
  const selectedWidgets = widgets ? activeTemplateWidgets(template) : [], selectedSites = sites ? template.sites : [];
  const selectedAppearances = appearance ? template.desktopAppearances || [] : [];
  const sourcePages = [...new Set([...selectedWidgets, ...selectedSites, ...selectedAppearances].map((entry) => entry.page))].sort((a, b) => a - b);
  const firstPage = sourcePages.length ? nextDesktopPage(state.entries, state.settings.pages) : null;
  if (sourcePages.length && (firstPage === null || firstPage + sourcePages.length - 1 > MAX_DESKTOP_PAGE)) fail(tr('主屏幕数量已达上限。'));
  const pageMap = new Map(sourcePages.map((page, index) => [page, firstPage + index]));
  state.settings.pages = [...new Set([...state.settings.pages, ...pageMap.values()])].sort((a, b) => a - b);
  const styledPages = new Set();
  for (const item of selectedAppearances) {
    const page = pageMap.get(item.page);
    state.settings = withDesktopPageIdentity(state.settings, page);
    state.settings.desktopPages[page].appearance = copy(item.appearance);
    styledPages.add(page);
  }
  const affected = new Set(), usedWidgets = new Set();
  let movedWidgets = 0, addedWidgets = 0, addedSites = 0, skippedDuplicates = 0, revealId = null;
  for (const widget of selectedWidgets) {
    let entry = state.entries.find((item) => item.type === 'widget' && item.extensionId === widget.extensionId && !widgetContentReference(item) && !usedWidgets.has(item.id));
    if (entry) {
      // Widget runtimes and tool records are keyed by the existing ID. Only
      // geometry changes; style, zones and every other config field survive.
      entry.config = { ...entry.config, size: widget.config.size }; movedWidgets++;
    } else {
      entry = { id: newId('widget'), type: 'widget', name: WIDGET_NAMES[widget.extensionId], extensionId: widget.extensionId, config: copy(widget.config),
        groupId: 'group-home', parentId: null, icon: letterIcon(WIDGET_NAMES[widget.extensionId]), order: state.entries.filter((item) => item.parentId === null).length };
      state.entries.push(entry); addedWidgets++;
    }
    entry.page = pageMap.get(widget.page); delete entry.detached;
    if (widget.position) entry.position = copy(widget.position); else delete entry.position;
    usedWidgets.add(entry.id); affected.add(entry.id); revealId ??= entry.id;
  }
  for (const sourcePage of sourcePages) {
    const pageSites = selectedSites.filter((site) => site.page === sourcePage);
    if (!pageSites.length) continue;
    const imported = prepareImport(state, { folders: [], sites: pageSites.map((site) => ({ name: site.name, url: site.url, folder: null })) },
      { page: pageMap.get(sourcePage), columns: state.settings.columns, skipDuplicates: true });
    state = imported.state; addedSites += imported.addedSites; skippedDuplicates += imported.skippedDuplicates;
    revealId ??= imported.revealId;
    for (const row of imported.rows) if (row.willAdd) {
      const entry = state.entries.find((item) => item.id === row.entryId), source = pageSites[row.index];
      if (source.position) entry.position = copy(source.position);
      affected.add(entry.id);
    }
  }
  if (affected.size) {
    const affectedPages = new Set(state.entries.filter((entry) => affected.has(entry.id)).map((entry) => entry.page));
    const frozen = freezeDesktopPositions(state.entries, state.settings.columns, affectedPages, state.settings.pages);
    const placed = new Map(frozen.entries.filter((entry) => affected.has(entry.id)).map((entry) => [entry.id, entry]));
    // freezeDesktopPositions also normalizes folder children. Merge only the
    // affected roots so unrelated entries retain their original metadata.
    state.entries = state.entries.map((entry) => placed.get(entry.id) ?? entry);
    state.settings.pages = [...new Set([...state.settings.pages, ...frozen.pageMap.values()])].sort((a, b) => a - b);
  }
  const occupiedPages = new Set(state.entries.filter((entry) => affected.has(entry.id)).map((entry) => entry.page));
  state.settings.pages = state.settings.pages.filter((page) => originalPages.has(page) || occupiedPages.has(page) || styledPages.has(page));
  return { state: validateState(state), sourceRevision: input.revision, revealId, addedSites, addedWidgets, movedWidgets, skippedDuplicates,
    addedDesktopAppearances: styledPages.size, page: firstPage };
}

const builtin = (name, appearance, widgets) => inspectDesktopTemplate({ format: FORMAT, version: 1, name,
  appearance: { ...appearanceOf(createEmptyState().settings), ...appearance }, widgets, sites: [] });
export const BUILTIN_DESKTOP_TEMPLATES = Object.freeze([
  builtin('纯净导航', { background: { kind: 'color', value: '#f2f5f9' }, columns: 8, iconSize: 64, gap: 24 }, []),
  builtin('阅读记录', { background: { kind: 'color', value: '#eef4ef' }, columns: 8 }, [
    { extensionId: NOTES_WIDGET_ID, config: { size: 'medium' }, page: 0, position: { row: 0, column: 0 } },
    { extensionId: READING_WIDGET_ID, config: { size: 'medium' }, page: 0, position: { row: 0, column: 4 } },
  ]),
]);

const demo = typeof document !== 'undefined' && import.meta.env?.DEV && new URLSearchParams(location.search).has('demo');
const STORAGE_KEY = demo ? 'covelet.desktop-templates.demo.v1' : 'covelet.desktop-templates.v1';
const native = () => !demo && Boolean(globalThis.chrome?.runtime?.id && globalThis.chrome?.storage?.local);
function checkSaved(input) {
  if (input === undefined || input === null) return { version: 1, revision: 0, templates: [] };
  fields(input, ['version', 'revision', 'templates']);
  if (input.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0 || !Array.isArray(input.templates) || input.templates.length > DESKTOP_TEMPLATE_MAX_SAVED) fail(tr('本机桌面方案数据无效。'));
  const ids = new Set();
  return { version: 1, revision: input.revision, templates: input.templates.map((item) => {
    fields(item, ['id', 'name', 'createdAt', 'template']);
    if (typeof item.id !== 'string' || !/^[a-z\d-]{1,100}$/iu.test(item.id) || ids.has(item.id) || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0) fail(tr('本机桌面方案数据无效。'));
    ids.add(item.id);
    return { id: item.id, name: templateName(item.name), createdAt: item.createdAt, template: inspectDesktopTemplate(item.template) };
  }) };
}
async function readSaved() {
  try { return checkSaved((await localData.get(STORAGE_KEY))[STORAGE_KEY]); }
  catch (reason) { if (reason instanceof Error) throw reason; fail(tr('无法读取本机桌面方案。')); }
}
export async function loadSavedDesktopTemplates() { return copy((await readSaved()).templates); }
export const validateSavedDesktopTemplates = (value) => checkSaved(copy(value));
export async function loadDesktopTemplateEnvelope() { return copy(await readSaved()); }
export async function replaceDesktopTemplates(value, { expectedRevision } = {}) {
  const checked = checkSaved(value);
  return mutateSaved((envelope) => {
    if (envelope.revision !== expectedRevision) fail(tr('恢复期间数据已更新，请重新预览。'));
    envelope.templates = copy(checked.templates);
    return { ...envelope, revision: envelope.revision + 1 };
  });
}
let queue = Promise.resolve();
async function mutateSaved(update) {
  const action = async () => {
    const envelope = await readSaved(), next = copy(envelope);
    const result = update(next);
    next.revision = envelope.revision + 1; checkSaved(next);
    try {
      await localData.set({ [STORAGE_KEY]: next });
    } catch { fail(tr('无法保存本机桌面方案，请检查可用存储空间。')); }
    return copy(result);
  };
  if (globalThis.navigator?.locks?.request) return navigator.locks.request(STORAGE_KEY, action);
  if (native() || typeof document !== 'undefined') fail(tr('方案未保存，请稍后重试。'));
  const pending = queue.then(action, action); queue = pending.catch(() => {}); return pending;
}
export async function saveDesktopTemplate(name, value) {
  const checkedName = templateName(name), template = inspectDesktopTemplate({ ...inspectDesktopTemplate(value), name: checkedName });
  return mutateSaved((envelope) => {
    if (envelope.templates.length >= DESKTOP_TEMPLATE_MAX_SAVED) fail(tr('最多保存 20 份本机桌面方案，请先删除不用的方案。'));
    const record = { id: newId('template'), name: checkedName, createdAt: Date.now(), template };
    envelope.templates.push(record); return record;
  });
}
export async function deleteDesktopTemplate(id) {
  return mutateSaved((envelope) => {
    const record = envelope.templates.find((item) => item.id === id);
    if (!record) fail(tr('这份桌面方案已在其他页面删除。'));
    envelope.templates = envelope.templates.filter((item) => item.id !== id); return record;
  });
}
