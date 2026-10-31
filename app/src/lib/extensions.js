import { tr, getLocale } from "../i18n/index.js";
// The catalog contains only reviewed modules bundled with Covelet. Configuration
// and imported backups cannot register executable code or download a module.
export const EXTENSION_TYPES = Object.freeze([
  Object.freeze({ id: 'widget', get label() { return tr("桌面组件"); } }),
  Object.freeze({ id: 'functional', get label() { return tr("功能扩展"); } }),
]);

export const EXTENSION_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'development', get label() { return tr("开发工具"); } }),
  Object.freeze({ id: 'time', get label() { return tr("时间工具"); } }),
  Object.freeze({ id: 'productivity', get label() { return tr("记录与阅读"); } }),
  Object.freeze({ id: 'sync', get label() { return tr("数据同步"); } }),
]);

export const BUNDLED_EXTENSIONS = Object.freeze([
  Object.freeze({ id: 'clock', type: 'widget', category: 'time', get name() { return tr("时钟"); },
    get description() { return tr("世界时钟、时区对照、倒计时与计时。"); }, core: 'clock-core.wasm',
    keywords: Object.freeze(['时间', '时钟', '世界时钟', '时区', '倒计时', '秒表', '计时', 'clock', 'timer']) }),
  Object.freeze({ id: 'notes', type: 'widget', category: 'productivity', get name() { return tr("便笺"); },
    get description() { return tr("随手记录，支持 Markdown 预览与置顶。"); }, core: 'tools-core.wasm',
    keywords: Object.freeze(['记录', '便笺', '笔记', 'Markdown', 'notes']) }),
  Object.freeze({ id: 'read-later', type: 'widget', category: 'productivity', get name() { return tr("稍后读"); },
    get description() { return tr("收藏链接，按未读、已读与归档整理。"); }, core: 'tools-core.wasm',
    keywords: Object.freeze(['阅读', '链接', '收藏', '未读', 'reading']) }),
  Object.freeze({
    id: 'github-contributions',
    type: 'widget',
    category: 'development',
    get name() { return tr("GitHub 贡献"); },
    get description() { return tr("在桌面查看 GitHub 贡献热力图。"); },
    core: 'github-core.wasm',
    keywords: Object.freeze(['GitHub', '开发', '贡献', '提交', '绿点', '日历']),
  }),
  Object.freeze({
    id: 'custom-storage-sync',
    type: 'functional',
    category: 'sync',
    get name() { return tr("自定义存储同步"); },
    get description() { return tr("加密同步桌面、扩展和图标。WebDAV 为加固渠道，其他渠道为 Beta。"); },
    core: 'sync-core.wasm',
    keywords: Object.freeze(['GitHub', 'GitLab', 'Cloudflare R2', 'OSS', 'WebDAV', '存储', '同步', '加密']),
  }),
]);

export function extensionsOfType(type) {
  return BUNDLED_EXTENSIONS.filter((extension) => extension.type === type);
}

export function extensionMetadata(extension) {
  return [EXTENSION_CATEGORIES.find((item) => item.id === extension.category)?.label,
    EXTENSION_TYPES.find((item) => item.id === extension.type)?.label].filter(Boolean).join(' · ');
}

export function extensionsForCatalog(category = 'all', query = '') {
  const terms = query.normalize('NFKC').trim().toLocaleLowerCase(getLocale()).split(/\s+/).filter(Boolean);
  return BUNDLED_EXTENSIONS.filter((extension) => {
    if (category !== 'all' && extension.category !== category) return false;
    const text = [extension.name, extension.description, extensionMetadata(extension), ...extension.keywords]
      .join(' ').normalize('NFKC').toLocaleLowerCase(getLocale());
    return terms.every((term) => text.includes(term));
  });
}
