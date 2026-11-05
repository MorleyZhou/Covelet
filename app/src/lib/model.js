import { tr, getLocale } from "../i18n/index.js";
import { GITHUB_WIDGET_ID, WIDGET_NAMES, validateWidgetConfig, isRetiredClockWidget } from './widget-model.js';
import { DESKTOP_ROWS, MAX_DESKTOP_PAGE } from './desktop-layout.js';
import { validateGradient, gradientCss } from './background-colors.js';
import { normalizeIconAddress, normalizeIconVariants } from './site-icons.js';

const MAX_ENTRIES = 2000;
const MAX_GROUPS = 100;
const MAX_NAME = 200;
const MAX_URL = 4096;
const PRESETS = new Set(['github', 'figma', 'notion', 'mdn', 'bilibili']);
const BACKGROUNDS = new Set(['alpine']);
const TOKEN = 'owntabqueryplaceholder';

const fail = (message) => { throw new Error(message); };
const copy = (value) => structuredClone(value);
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(tr("{0}格式无效", [label]));
};
const keys = (value, allowed, label) => {
  object(value, label);
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(tr("{0}包含未知字段", [label]));
};
const name = (value, label = tr("名称")) => {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_NAME || /[\u0000-\u001f\u007f]/u.test(value)) fail(tr("{0}须为 1 至 {1} 个字符", [label, MAX_NAME]));
  return value.trim();
};
const identifier = (value, label = tr("标识")) => {
  if (typeof value !== 'string' || !value || value.length > 200 || /[\s\u0000-\u001f\u007f]/u.test(value)) fail(tr("{0}无效", [label]));
  return value;
};
const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(tr("{0}须在 {1} 至 {2} 之间", [label, min, max]));
};
const number = (value, min, max, label) => {
  if (!Number.isFinite(value) || value < min || value > max) fail(tr("{0}须在 {1} 至 {2} 之间", [label, min, max]));
};
const assetId = (value) => {
  identifier(value, tr("图片标识"));
  if (/^(?:https?:|data:|blob:|file:|\/)/i.test(value)) fail(tr("图片必须使用本地资源标识"));
};
const containerKey = (entry) => JSON.stringify([entry.groupId, entry.parentId]);
const ordered = (entries) => [...entries].sort((a, b) => a.order - b.order);
const newId = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;

export const DEFAULT_ICON_BACKGROUND = '#f5f5f7';

export function letterIcon(label) {
  return { kind: 'letter', value: [...String(label ?? '').trim()].slice(0, 2).join('') || '网' };
}

export function normalizeUrl(input) {
  if (typeof input !== 'string') fail(tr("网址须为文字"));
  let value = input.trim();
  if (!value || value.length > MAX_URL || /[\s\\\u0000-\u001f\u007f]/u.test(value)) fail(tr("网址格式无效"));
  const explicit = /^https?:\/\//i.test(value);
  if (!explicit) {
    const hostWithPort = /^[^/:]+:\d+(?:[/?#]|$)/u.test(value);
    if ((!hostWithPort && /^[a-z][a-z\d+.-]*:/i.test(value)) || value.startsWith('//')) fail(tr("仅支持 HTTP 和 HTTPS 网址"));
    const rawHost = value.split(/[/?#]/u)[0].replace(/:\d+$/u, '');
    if (!rawHost.includes('.') || rawHost.includes('@')) fail(tr("本地或特殊地址请明确填写 HTTP 或 HTTPS 协议"));
    value = `https://${value}`;
  }
  let url;
  try { url = new URL(value); } catch { fail(tr("网址格式无效")); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) fail(tr("仅支持 HTTP 和 HTTPS 网址"));
  if (url.username || url.password) fail(tr("网址不能包含用户名或密码"));
  if (!url.hostname.startsWith('[')) {
    const host = url.hostname.replace(/\.$/u, '');
    if (!host || host.split('.').some((part) => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part))) fail(tr("网址域名格式无效"));
  }
  if (url.href.length > MAX_URL) fail(tr("网址过长"));
  return url.href;
}

export function validateProviderTemplate(input) {
  if (typeof input !== 'string' || input.length > MAX_URL) fail(tr("搜索模板格式无效"));
  const template = input.trim();
  if ((template.match(/\{query\}/g) ?? []).length !== 1) fail(tr("搜索模板须包含且仅包含一个 {query}"));
  if (/[{}]/u.test(template.replace('{query}', ''))) fail(tr("搜索模板包含无效占位符"));
  const absolute = template.match(/^https?:\/\/([^/?#]+)(.*)$/iu);
  if (!absolute || absolute[1].includes('{query}')) fail(tr("搜索引擎的协议和域名必须固定"));
  const rest = absolute[2];
  const hash = rest.indexOf('#');
  if (hash >= 0 && rest.slice(hash).includes('{query}')) fail(tr("搜索占位符不能放在片段中"));
  const beforeHash = hash >= 0 ? rest.slice(0, hash) : rest;
  const queryAt = beforeHash.indexOf('?');
  if (queryAt >= 0 && beforeHash.slice(queryAt + 1).includes('{query}')) {
    const parameter = beforeHash.slice(queryAt + 1).split('&').find((part) => part.includes('{query}'));
    if (!parameter || parameter.indexOf('=') < 0 || parameter.indexOf('{query}') <= parameter.indexOf('=')) fail(tr("搜索占位符只能放在查询参数值中"));
  } else if (!beforeHash.split('?')[0].includes('{query}')) {
    fail(tr("搜索占位符只能放在路径或查询参数值中"));
  }
  let token = TOKEN;
  while (template.includes(token)) token += 'x';
  const checked = normalizeUrl(template.replace('{query}', token));
  if (new URL(checked).origin.includes(token)) fail(tr("搜索引擎域名必须固定"));
  if (!checked.includes(token)) fail(tr("网址规范化不能移除搜索占位符"));
  return checked.replace(token, '{query}');
}

export function buildProviderUrl(template, text) {
  const checked = validateProviderTemplate(template);
  if (typeof text !== 'string' || text.length > 2000) fail(tr("搜索文字无效或过长"));
  const path = checked.split('?')[0];
  if (path.includes('{query}') && /^\.{1,2}$/u.test(text)) fail(tr("路径搜索不能使用路径跳转符"));
  return checked.replace('{query}', encodeURIComponent(text));
}

export function createEmptyState() {
  return {
    version: 1, revision: 0,
    groups: [{ id: 'group-home', name: '桌面' }], entries: [],
    providers: [
      { id: 'bing', name: '必应', template: 'https://www.bing.com/search?q={query}' },
      { id: 'google', name: 'Google', template: 'https://www.google.com/search?q={query}' },
      { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={query}' },
    ],
    settings: {
      theme: 'system', background: { kind: 'bing', value: 'daily' }, shade: 0, blur: 0,
      width: 1120, iconSize: 64, gap: 24, columns: 8, showLabels: true, showClock: true, openNewTab: false, minimal: false,
      visualEnhancement: true, pages: [0],
    },
  };
}

// Fresh installations start without navigation entries. Existing data is read
// through the normal migration path; this factory never reseeds it.
export function createInitialState() {
  return createEmptyState();
}

// Exact historical installation records only. A matching hostname, URL or ID
// alone never proves a site is an untouched seed. Extra saved fields, changed
// placement and separately stored aliases/privacy markers protect user choices.
const RETIRED_INITIAL_SITES = [
  ['google', 'Google', 'https://www.google.com/', 'https://www.google.com/images/branding/googleg/2x/googleg_standard_color_128dp.png'],
  ['youtube', 'YouTube', 'https://www.youtube.com/', 'https://www.youtube.com/s/desktop/2fe123f7/img/favicon_144x144.png'],
  ['github', 'GitHub', 'https://github.com/', 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'],
  ['x', 'X', 'https://x.com/', 'https://abs.twimg.com/responsive-web/client-web/icon-default-large.9ab12c3ecc9e8133a.png'],
  ['chatgpt', 'ChatGPT', 'https://chatgpt.com/', 'https://cdn.oaistatic.com/assets/apple-touch-icon-mz9nytnj.webp'],
  ['grok', 'Grok', 'https://grok.com/', 'https://grok.com/images/android-chrome-monochrome-512x512.png'],
].map(([id, name, url, iconUrl], order) => ({ id: `default-${id}`, type: 'site', name, url,
  groupId: 'group-home', parentId: null, page: 0, icon: letterIcon(name), iconUrl, order }));
const exactData = (left, right) => {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && exactData(left[key], right[key]));
};
export function retirePristineInitialSites(input, { protectedIds = [] } = {}) {
  const protectedSet = new Set(protectedIds);
  const remove = new Set(input.entries.filter((entry) => !protectedSet.has(entry.id)
    && RETIRED_INITIAL_SITES.some((seed) => exactData(entry, seed))).map((entry) => entry.id));
  const state = migrateNavigationState(input);
  state.entries = state.entries.filter((entry) => !remove.has(entry.id));
  renumber(state);
  return validateState(state);
}

export function createDemoState() {
  const state = createEmptyState();
  const site = (id, label, url, order, groupId = 'group-home', parentId = null) => ({
    id, type: 'site', name: label, url: normalizeUrl(url), groupId, parentId,
    icon: letterIcon(label), order,
  });
  state.entries = [
    site('site-github', 'GitHub', 'https://github.com', 0),
    site('site-figma', 'Figma', 'https://www.figma.com', 1),
    site('site-notion', 'Notion', 'https://www.notion.so', 2),
    site('site-mdn', 'MDN', 'https://developer.mozilla.org/zh-CN/', 3),
    site('site-bilibili', '哔哩哔哩', 'https://www.bilibili.com', 4),
    { id: 'folder-docs', type: 'folder', name: '文档', groupId: 'group-home', parentId: null, icon: letterIcon('文档'), order: 5 },
    site('site-react', 'React 文档', 'https://react.dev', 0, 'group-home', 'folder-docs'),
    site('site-vite', 'Vite 文档', 'https://vite.dev', 1, 'group-home', 'folder-docs'),
  ];
  return validateState(state);
}

function validateSettings(settings) {
  keys(settings, ['theme', 'background', 'shade', 'blur', 'width', 'iconSize', 'gap', 'columns', 'showLabels', 'showClock', 'openNewTab', 'minimal', 'visualEnhancement', 'adaptiveWallpaper', 'adaptIcons', 'pages'], tr("设置"));
  // Fill newly introduced preferences in old local configurations and backups.
  if (!Object.hasOwn(settings, 'showClock')) settings.showClock = true;
  if (!Object.hasOwn(settings, 'columns')) settings.columns = 8;
  if (!Object.hasOwn(settings, 'pages')) settings.pages = [0];
  if (!Array.isArray(settings.pages) || !settings.pages.length || settings.pages.length > MAX_DESKTOP_PAGE + 1
    || new Set(settings.pages).size !== settings.pages.length) fail(tr("主屏幕列表无效"));
  for (const page of settings.pages) integer(page, 0, MAX_DESKTOP_PAGE, tr("主屏幕"));
  settings.pages.sort((a, b) => a - b);
  // Read old independent toggles, but keep one canonical preference thereafter.
  for (const key of ['adaptiveWallpaper', 'adaptIcons']) {
    if (Object.hasOwn(settings, key) && typeof settings[key] !== 'boolean') fail(tr("{0}须为开关值", [key]));
  }
  if (!Object.hasOwn(settings, 'visualEnhancement')) settings.visualEnhancement = ['adaptiveWallpaper', 'adaptIcons'].some((key) => Object.hasOwn(settings, key))
    ? settings.adaptiveWallpaper === true || settings.adaptIcons === true : true;
  delete settings.adaptiveWallpaper;
  delete settings.adaptIcons;
  if (!['system', 'light', 'dark'].includes(settings.theme)) fail(tr("主题无效"));
  keys(settings.background, ['kind', 'value', 'gradient'], tr("背景"));
  const { kind, value } = settings.background;
  if (typeof value !== 'string' || !value || value.length > 2000) fail(tr("背景值无效"));
  if (Object.hasOwn(settings.background, 'gradient')) {
    if (kind !== 'gradient') fail(tr("背景类型与渐变设置不符"));
    validateGradient(settings.background.gradient);
    if (value !== gradientCss(settings.background.gradient)) fail(tr("渐变背景与颜色设置不符"));
  }
  if (kind === 'bing') {
    if (value !== 'daily') fail(tr("每日背景来源无效"));
  } else if (kind === 'builtin') {
    if (!BACKGROUNDS.has(value)) fail(tr("内置背景无效"));
  } else if (kind === 'color') {
    if (!/^#[a-f\d]{3}(?:[a-f\d]{3})?$/iu.test(value)) fail(tr("背景颜色无效"));
  } else if (kind === 'gradient') {
    // A small CSS vocabulary prevents escaped url()/image-set() or additional image layers in imported data.
    if (!/^(?:linear|radial)-gradient\(/iu.test(value) || !/^[a-z\d\s#%,.()+-]+$/iu.test(value)
      || [...value.matchAll(/([a-z-]+)\s*\(/giu)].some((match) => !['linear-gradient', 'radial-gradient', 'rgb', 'rgba', 'hsl', 'hsla'].includes(match[1].toLowerCase()))) fail(tr("渐变背景无效"));
  } else if (kind === 'image') assetId(value);
  else fail(tr("背景类型无效"));
  number(settings.shade, 0, 90, tr("背景遮罩"));
  number(settings.blur, 0, 40, tr("背景模糊"));
  number(settings.width, 480, 1920, tr("内容宽度"));
  number(settings.iconSize, 48, 144, tr("图标大小"));
  number(settings.gap, 8, 64, tr("图标间距"));
  integer(settings.columns, 2, 12, tr("每行图标数量"));
  for (const key of ['showLabels', 'showClock', 'openNewTab', 'minimal', 'visualEnhancement']) if (typeof settings[key] !== 'boolean') fail(tr("{0}须为开关值", [key]));
}

export function validateState(input) {
  keys(input, ['version', 'revision', 'groups', 'entries', 'providers', 'settings'], tr("数据"));
  if (input.version !== 1) fail(tr("不支持的数据版本"));
  integer(input.revision, 0, Number.MAX_SAFE_INTEGER, tr("数据修订号"));
  if (!Array.isArray(input.groups) || input.groups.length < 1 || input.groups.length > MAX_GROUPS) fail(tr("分组数量须为 1 至 {0}", [MAX_GROUPS]));
  if (!Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES) fail(tr("网址和文件夹总数不能超过 {0}", [MAX_ENTRIES]));
  if (!Array.isArray(input.providers) || input.providers.length > 30) fail(tr("额外搜索引擎数量须为 0 至 30"));
  const state = copy(input);
  const groupIds = new Set();
  for (const group of state.groups) {
    keys(group, ['id', 'name'], tr("分组")); identifier(group.id, tr("分组标识"));
    if (groupIds.has(group.id)) fail(tr("分组标识重复"));
    groupIds.add(group.id); group.name = name(group.name, tr("分组名称"));
  }
  const entries = new Map();
  const containers = new Map();
  for (const entry of state.entries) {
    keys(entry, ['id', 'type', 'name', 'url', 'groupId', 'parentId', 'page', 'position', 'icon', 'iconUrl', 'iconFit', 'iconVariants', 'iconBackground', 'order', 'extensionId', 'config', 'detached'], tr("网址条目"));
    if (entry.detached !== undefined && (entry.type !== 'widget' || typeof entry.detached !== 'boolean')) fail(tr("组件放置状态无效"));
    if (Object.hasOwn(entry, 'page')) integer(entry.page, 0, MAX_DESKTOP_PAGE, tr("主屏幕位置"));
    if (Object.hasOwn(entry, 'position')) {
      keys(entry.position, ['row', 'column'], tr("图标位置"));
      integer(entry.position.row, 0, DESKTOP_ROWS - 1, tr("图标所在行")); integer(entry.position.column, 0, 11, tr("图标所在列"));
    }
    if (Object.hasOwn(entry, 'iconUrl')) {
      if (entry.type !== 'site') fail(tr("只有网站可以设置图标地址"));
      entry.iconUrl = normalizeIconAddress(entry.iconUrl);
    }
    if (entry.iconFit !== undefined && (entry.type !== 'site' || !['contain', 'cover'].includes(entry.iconFit))) fail(tr("图标显示方式无效"));
    if (Object.hasOwn(entry, 'iconVariants')) {
      if (entry.type !== 'site') fail(tr("只有网站可以设置图标地址"));
      entry.iconVariants = normalizeIconVariants(entry.iconVariants);
    }
    identifier(entry.id, tr("条目标识"));
    if (entries.has(entry.id)) fail(tr("条目标识重复"));
    entries.set(entry.id, entry);
    if (!['site', 'folder', 'widget'].includes(entry.type)) fail(tr("条目类型无效"));
    entry.name = name(entry.name);
    if (!groupIds.has(entry.groupId)) fail(tr("条目引用了不存在的分组"));
    if (entry.parentId !== null) identifier(entry.parentId, tr("文件夹标识"));
    if (entry.type === 'folder' && entry.parentId !== null) fail(tr("文件夹不能嵌套"));
    if (entry.type === 'folder' && entry.url !== undefined) fail(tr("文件夹不能包含网址字段"));
    if (entry.type === 'site') entry.url = normalizeUrl(entry.url);
    if (entry.type === 'widget') {
      if (entry.parentId !== null || entry.url !== undefined || entry.icon?.kind !== 'letter') fail(tr("组件只能放在桌面上"));
      entry.config = validateWidgetConfig(entry.extensionId, entry.config);
    } else if (entry.extensionId !== undefined || entry.config !== undefined) fail(tr("普通条目不能包含组件配置"));
    keys(entry.icon, ['kind', 'value'], tr("图标"));
    if (entry.icon.kind === 'preset') {
      if (!PRESETS.has(entry.icon.value)) fail(tr("预设图标无效"));
      // Read known v1 presets from local state, backups and older sync devices;
      // active configurations always derive a text fallback from the site name.
      entry.icon = letterIcon(entry.name);
    } else if (entry.icon.kind === 'letter') name(entry.icon.value, tr("文字图标"));
    else if (entry.icon.kind === 'image') assetId(entry.icon.value);
    else if (entry.icon.kind === 'url' && entry.type === 'site') entry.icon.value = normalizeIconAddress(entry.icon.value);
    else fail(tr("图标类型无效"));
    if (Object.hasOwn(entry, 'iconBackground') && (typeof entry.iconBackground !== 'string'
      || !/^#[a-f\d]{6}$/iu.test(entry.iconBackground))) fail(tr("图标背景色须为六位十六进制颜色"));
    integer(entry.order, 0, MAX_ENTRIES, tr("条目顺序"));
    const key = containerKey(entry);
    if (!containers.has(key)) containers.set(key, []);
    containers.get(key).push(entry.order);
  }
  for (const entry of state.entries) {
    if (entry.parentId !== null) {
      const parent = entries.get(entry.parentId);
      if (!parent || parent.type !== 'folder' || parent.groupId !== entry.groupId) fail(tr("网址的文件夹引用无效或不在同一分组"));
    }
  }
  for (const values of containers.values()) {
    values.sort((a, b) => a - b);
    if (values.some((value, index) => value !== index)) fail(tr("每个容器的条目顺序须连续且不重复"));
  }
  const providers = new Set();
  for (const provider of state.providers) {
    keys(provider, ['id', 'name', 'template'], tr("搜索引擎")); identifier(provider.id, tr("搜索引擎标识"));
    if (provider.id === 'browser') fail(tr("浏览器默认搜索由浏览器提供，不能保存为额外搜索引擎"));
    if (providers.has(provider.id)) fail(tr("搜索引擎标识重复"));
    providers.add(provider.id); provider.name = name(provider.name, tr("搜索引擎名称"));
    provider.template = validateProviderTemplate(provider.template);
  }
  // Retire the former built-in ID only when its validated name and template
  // still equal the old defaults. Cosmetic whitespace/default ports normalize
  // above; a distinct ID or a substantive name/template edit stays portable.
  state.providers = state.providers.filter((provider) => !(provider.id === 'baidu'
    && provider.name === '百度' && provider.template === 'https://www.baidu.com/s?wd={query}'));
  validateSettings(state.settings);
  return state;
}

// Older backups may contain user wallpaper assets. Active configurations only
// retain the daily provider choice; image icons remain supported separately.
export function migrateWallpaperState(input) {
  const state = validateState(input);
  if (state.settings.background.kind === 'image') {
    state.settings.background = { kind: 'bing', value: 'daily' };
  }
  return state;
}

// Keep the v1 wire format readable for old backups/devices, but every active
// configuration has one navigation desktop with paged screens. Existing IDs
// and old grouping order are preserved; a missing page means the first screen.
export function migrateNavigationState(input) {
  const state = migrateWallpaperState(input);
  const groupOrder = new Map(state.groups.map((group, index) => [group.id, index]));
  const roots = state.entries.filter((entry) => entry.parentId === null)
    .sort((a, b) => groupOrder.get(a.groupId) - groupOrder.get(b.groupId) || a.order - b.order);
  roots.forEach((entry, order) => { entry.order = order; });
  for (const entry of state.entries) {
    entry.groupId = 'group-home';
    // Old clocks stay portable and retain their IDs/config/position/runtime.
    // Detach on every read so a later old backup or sync import stays retired.
    if (isRetiredClockWidget(entry)) entry.detached = true;
  }
  state.groups = [{ id: 'group-home', name: '桌面' }];
  return validateState(state);
}

export function searchEntries(state, text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const query = text.trim().toLocaleLowerCase(getLocale());
  return state.entries.filter((entry) => entry.type !== 'widget' && (entry.name.toLocaleLowerCase(getLocale()).includes(query)
    || (entry.type === 'site' && new URL(entry.url).hostname.toLocaleLowerCase(getLocale()).includes(query)))).map(copy);
}

function renumber(state) {
  const containers = new Map();
  for (const entry of state.entries) {
    const key = containerKey(entry);
    if (!containers.has(key)) containers.set(key, []);
    containers.get(key).push(entry);
  }
  for (const entries of containers.values()) ordered(entries).forEach((entry, index) => { entry.order = index; });
}

function finish(state) {
  state.revision += 1;
  return validateState(state);
}

function cleanupFolder(state, id) {
  if (!id) return;
  const folder = state.entries.find((entry) => entry.id === id && entry.type === 'folder');
  if (!folder) return;
  const children = ordered(state.entries.filter((entry) => entry.parentId === id));
  if (children.length > 1) return;
  const roots = ordered(state.entries.filter((entry) => entry.parentId === null));
  roots.splice(roots.findIndex((entry) => entry.id === id), 1, ...children);
  for (const child of children) { child.parentId = null; child.page = folder.page ?? 0; if (folder.position) child.position = copy(folder.position); else delete child.position; }
  state.entries = state.entries.filter((entry) => entry.id !== id);
  roots.forEach((entry, order) => { entry.order = order; });
}

export function moveEntry(input, id, { groupId = 'group-home', parentId = null, index, page } = {}) {
  const state = migrateNavigationState(input);
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) fail(tr("找不到要移动的条目"));
  if (groupId !== 'group-home') fail(tr("目标桌面不存在"));
  const previousParent = entry.parentId;
  if (page !== undefined) integer(page, 0, MAX_DESKTOP_PAGE, tr("主屏幕位置"));
  if (parentId !== null) {
    const parent = state.entries.find((item) => item.id === parentId);
    if (id === parentId || entry.type !== 'site') fail(tr("只有网站可以移入文件夹"));
    if (!parent || parent.type !== 'folder') fail(tr("目标文件夹无效"));
  }
  const target = ordered(state.entries.filter((item) => item.id !== id && item.groupId === groupId && item.parentId === parentId));
  const position = index === undefined ? target.length : index;
  integer(position, 0, target.length, tr("目标位置"));
  state.entries = state.entries.filter((item) => item.id !== id);
  renumber(state);
  entry.groupId = groupId; entry.parentId = parentId;
  delete entry.position;
  if (parentId !== null) entry.page = state.entries.find((item) => item.id === parentId).page ?? 0;
  else if (page !== undefined) entry.page = page;
  if (entry.type === 'folder') state.entries.forEach((item) => { if (item.parentId === id) { item.groupId = groupId; item.page = entry.page ?? 0; } });
  target.splice(position, 0, entry);
  target.forEach((item, order) => { item.order = order; });
  state.entries.push(entry);
  if (previousParent !== parentId) cleanupFolder(state, previousParent);
  renumber(state);
  return finish(state);
}

export function combineEntries(input, draggedId, targetId, { folderId, name: folderName = tr("新建文件夹") } = {}) {
  const state = migrateNavigationState(input);
  if (draggedId === targetId) fail(tr("不能将条目拖到自身"));
  const source = state.entries.find((entry) => entry.id === draggedId);
  const target = state.entries.find((entry) => entry.id === targetId);
  if (!source || !target) fail(tr("找不到要合并的条目"));
  if (source.type !== 'site') fail(tr("文件夹不能移入其他文件夹"));
  if (target.type === 'folder') return moveEntry(state, draggedId, { parentId: targetId });
  if (target.type !== 'site') fail(tr("组件不能合并为文件夹"));
  if (source.parentId !== target.parentId) fail(tr("请先将网址移到同一个容器"));
  if (target.parentId !== null) {
    const siblings = ordered(state.entries.filter((entry) => entry.parentId === target.parentId && entry.id !== draggedId));
    return moveEntry(state, draggedId, { parentId: target.parentId, index: siblings.findIndex((entry) => entry.id === targetId) });
  }
  identifier(folderId, tr("新文件夹标识"));
  if (state.entries.some((entry) => entry.id === folderId)) fail(tr("新文件夹标识已存在"));
  const label = name(folderName, tr("文件夹名称"));
  const roots = ordered(state.entries.filter((entry) => entry.parentId === null && entry.id !== draggedId));
  const folder = { id: folderId, type: 'folder', name: label, groupId: 'group-home', parentId: null, page: target.page ?? 0,
    icon: letterIcon(label), order: target.order };
  if (target.position) folder.position = copy(target.position);
  roots.splice(roots.findIndex((entry) => entry.id === targetId), 1, folder);
  target.parentId = folderId; target.order = 0; target.page = folder.page;
  source.parentId = folderId; source.order = 1; source.page = folder.page;
  delete target.position; delete source.position;
  roots.forEach((entry, order) => { entry.order = order; });
  state.entries.push(folder);
  return finish(state);
}

// A desktop selection enters one folder in a single state transition. Keep the
// target's seat and existing contents; all selected site metadata stays intact.
export function combineSelectedEntries(input, draggedIds, targetId, options = {}) {
  const ids = [...new Set(draggedIds)];
  if (ids.length === 1) return combineEntries(input, ids[0], targetId, options);
  const state = migrateNavigationState(input), selected = new Set(ids);
  const sources = ids.map((id) => state.entries.find((entry) => entry.id === id));
  const target = state.entries.find((entry) => entry.id === targetId);
  if (!ids.length || !target || sources.some((entry) => !entry)) fail(tr("找不到要合并的条目"));
  if (selected.has(targetId)) fail(tr("不能将条目拖到自身"));
  if (sources.some((entry) => entry.type !== 'site')) fail(tr("只有网站可以合并到文件夹。"));
  if (sources.some((entry) => entry.parentId !== null) || target.parentId !== null) fail(tr("多选仅支持主屏幕条目。"));
  if (!['site', 'folder'].includes(target.type)) fail(tr("组件不能合并为文件夹"));

  let folder = target, children;
  if (target.type === 'folder') {
    children = ordered(state.entries.filter((entry) => entry.parentId === target.id));
  } else {
    identifier(options.folderId, tr("新文件夹标识"));
    if (state.entries.some((entry) => entry.id === options.folderId)) fail(tr("新文件夹标识已存在"));
    const label = name(options.name ?? tr("新建文件夹"), tr("文件夹名称"));
    folder = { id: options.folderId, type: 'folder', name: label, groupId: 'group-home', parentId: null,
      page: target.page ?? 0, icon: letterIcon(label), order: target.order };
    if (target.position) folder.position = copy(target.position);
    state.entries.push(folder);
    children = [target];
  }
  children.push(...sources);
  children.forEach((entry, order) => {
    entry.parentId = folder.id; entry.page = folder.page ?? 0; entry.order = order;
    delete entry.position;
  });
  renumber(state);
  return finish(state);
}

export function deleteEntry(input, id) {
  const state = migrateNavigationState(input);
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) fail(tr("找不到要删除的条目"));
  if (entry.type === 'folder') {
    const siblings = ordered(state.entries.filter((item) => item.groupId === entry.groupId && item.parentId === null));
    const children = ordered(state.entries.filter((item) => item.parentId === id));
    siblings.splice(siblings.findIndex((item) => item.id === id), 1, ...children);
    children.forEach((item, index) => { item.parentId = null; item.page = entry.page ?? 0; if (index === 0 && entry.position) item.position = copy(entry.position); else delete item.position; });
    siblings.forEach((item, order) => { item.order = order; });
  }
  state.entries = state.entries.filter((item) => item.id !== id);
  cleanupFolder(state, entry.parentId);
  renumber(state);
  return finish(state);
}

export function configureGitHubWidget(input, config, id, { page = 0 } = {}) {
  return configureWidget(input, GITHUB_WIDGET_ID, config, id, { page });
}

export function configureWidget(input, extensionId, config, id, { page = 0 } = {}) {
  const state = migrateNavigationState(input);
  const checked = validateWidgetConfig(extensionId, config);
  const existing = id ? state.entries.find((entry) => entry.id === id)
    : state.entries.find((entry) => entry.type === 'widget' && entry.extensionId === extensionId);
  if (id && (!existing || existing.type !== 'widget' || existing.extensionId !== extensionId)) fail(tr("组件已在其他页面移除，请重新打开扩展"));
  if (existing) {
    existing.config = checked;
    if (existing.detached) { existing.page = page; delete existing.position; delete existing.detached; }
  }
  else state.entries.push({ id: newId('widget'), type: 'widget', name: WIDGET_NAMES[extensionId], groupId: 'group-home', parentId: null, page,
    icon: letterIcon(WIDGET_NAMES[extensionId]), order: state.entries.filter((entry) => entry.parentId === null).length, extensionId, config: checked });
  return finish(state);
}

export function parseBookmarks(html) {
  if (typeof html !== 'string') fail(tr('请选择浏览器导出的书签 HTML 文件。'));
  if (new TextEncoder().encode(html).byteLength > 5 * 1024 * 1024) fail(tr('书签文件不能超过 5 MB'));
  if (!html.trim()) fail(tr('书签文件为空，请选择浏览器导出的 HTML 文件。'));
  if (typeof DOMParser === 'undefined') fail(tr("当前环境不能解析书签 HTML"));
  // Parse imported markup only inside an inert template. Scripts and resource tags never enter a rendered document.
  const document = new DOMParser().parseFromString('', 'text/html');
  const template = document.createElement('template');
  template.innerHTML = html;
  const list = template.content.querySelector('dl');
  if (!list) fail(tr('请选择浏览器导出的书签 HTML 文件。'));
  const plan = { folders: [], sites: [], invalid: [], duplicateCount: 0 };
  const folderNames = new Set();
  const shortName = (value, fallback) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, MAX_NAME) || fallback;
  const folder = (path) => {
    const originalPath = path.join(' / ');
    const base = shortName(originalPath, tr('未命名文件夹'));
    let label = base, count = 2;
    while (folderNames.has(label)) {
      const suffix = ` (${count++})`;
      label = `${base.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    }
    folderNames.add(label);
    plan.folders.push({ name: label, originalPath });
    if (plan.folders.length + plan.sites.length > MAX_ENTRIES) fail(tr("导入条目不能超过 {0}", [MAX_ENTRIES]));
    return label;
  };
  const walk = (node, path = [], parentName = null, depth = 0) => {
    if (depth > 64) fail(tr('书签文件夹层级过深，请减少层级后重试。'));
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    // Only Netscape list/entry elements are data. Ignore descriptions,
    // scripts, templates and resource tags, even if they contain links.
    if (!['DL', 'DT', 'H3', 'A', 'P'].includes(node.tagName)) return;
    if (node.tagName === 'A') {
      const raw = node.getAttribute('href') ?? '';
      try {
        const url = normalizeUrl(raw);
        plan.sites.push({ name: shortName(node.textContent, new URL(url).hostname), url, folder: parentName });
        if (plan.folders.length + plan.sites.length > MAX_ENTRIES) fail(tr("导入条目不能超过 {0}", [MAX_ENTRIES]));
      } catch (error) {
        if (plan.folders.length + plan.sites.length > MAX_ENTRIES) throw error;
        plan.invalid.push({ name: shortName(node.textContent, tr('未命名网址')), url: raw.slice(0, MAX_URL), reason: tr('书签地址无效，仅支持不含用户名和密码的 HTTP 或 HTTPS 网址。') });
        if (plan.invalid.length > MAX_ENTRIES) fail(tr("无效书签不能超过 {0}", [MAX_ENTRIES]));
      }
      return;
    }
    const children = Array.from(node.children ?? []);
    const heading = node.tagName === 'DT' ? children.find((child) => child.tagName === 'H3') : null;
    if (heading) {
      const nextPath = [...path, shortName(heading.textContent, tr('未命名文件夹'))];
      const nextName = folder(nextPath);
      children.filter((child) => child !== heading).forEach((child) => walk(child, nextPath, nextName, depth + 1));
      // Some exporters explicitly close DT before its sibling DL.
      return children.some((child) => child.tagName === 'DL') ? null : { path: nextPath, name: nextName };
    }
    let pending = null;
    for (const child of children) {
      if (child.tagName === 'H3') {
        const nextPath = [...path, shortName(child.textContent, tr('未命名文件夹'))];
        pending = { path: nextPath, name: folder(nextPath) };
      } else if (child.tagName === 'DL' && pending) {
        walk(child, pending.path, pending.name, depth + 1); pending = null;
      } else if (child.tagName === 'DD') {
        // Firefox folder descriptions close DT and can own the following DL.
        // Read that list, while leaving links in the description itself out.
        const lists = Array.from(child.children).filter((item) => item.tagName === 'DL');
        for (const list of lists) walk(list, pending?.path ?? path, pending?.name ?? parentName, depth + 1);
        if (lists.length) pending = null;
      } else if (child.tagName === 'P' && !child.children.length) {
        // Optional paragraph separators do not consume a pending heading.
      } else pending = walk(child, path, parentName, depth + 1) || null;
    }
  };
  walk(list);
  if (!plan.sites.length && !plan.invalid.length) fail(tr('文件中没有可导入的书签。'));
  const populatedFolders = new Set(plan.sites.map((site) => site.folder).filter((folderName) => folderName !== null));
  plan.folders = plan.folders.filter((folder) => populatedFolders.has(folder.name));
  const seen = new Set();
  for (const site of plan.sites) {
    const key = site.url;
    if (seen.has(key)) plan.duplicateCount += 1;
    seen.add(key);
  }
  return plan;
}

export function applyBookmarkImport(input, plan, groupId = 'group-home') {
  const state = migrateNavigationState(input);
  if (groupId !== 'group-home') fail(tr("导入目标桌面不存在"));
  object(plan, tr("导入计划"));
  if (!Array.isArray(plan.folders) || !Array.isArray(plan.sites) || plan.folders.length + plan.sites.length > MAX_ENTRIES) fail(tr("导入计划无效或条目过多"));
  const folders = new Map(state.entries.filter((item) => item.groupId === groupId && item.type === 'folder').map((item) => [item.name, item.id]));
  const declared = new Set();
  for (const item of plan.folders) {
    object(item, tr("导入文件夹")); const label = name(item.name, tr("文件夹名称"));
    if (declared.has(label)) fail(tr("导入计划中的文件夹名称重复"));
    declared.add(label);
  }
  const seen = new Set(state.entries.filter((entry) => entry.type === 'site').map((entry) => entry.url));
  for (const item of plan.sites) {
    object(item, tr("导入网址"));
    const label = name(item.name), url = normalizeUrl(item.url);
    if (item.folder !== null && (typeof item.folder !== 'string' || !declared.has(item.folder))) fail(tr("导入网址引用了未知文件夹"));
    if (seen.has(url)) continue;
    seen.add(url);
    if (item.folder !== null && !folders.has(item.folder)) {
      const id = newId('folder');
      state.entries.push({ id, type: 'folder', name: item.folder, groupId, parentId: null, icon: letterIcon(item.folder), order: state.entries.filter((entry) => entry.groupId === groupId && entry.parentId === null).length });
      folders.set(item.folder, id);
    }
    const parentId = item.folder === null ? null : folders.get(item.folder);
    state.entries.push({ id: newId('site'), type: 'site', name: label, url, groupId, parentId, icon: letterIcon(label), order: state.entries.filter((entry) => entry.groupId === groupId && entry.parentId === parentId).length });
  }
  return finish(state);
}

