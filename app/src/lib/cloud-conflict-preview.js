import { tr } from '../i18n/index.js';

const MAX_ITEMS = 2000, MAX_EXAMPLES = 4;
// Decoded sync values are plain data. Do not invoke accessors while projecting
// that data into a preview, and never read Blob contents or create media URLs.
const field = (value, key) => value && typeof value === 'object'
  ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const array = (value) => Array.isArray(value) ? value : null;
const blobInfo = (value) => value instanceof Blob ? {
  size: Object.getOwnPropertyDescriptor(Blob.prototype, 'size').get.call(value),
  type: Object.getOwnPropertyDescriptor(Blob.prototype, 'type').get.call(value),
} : null;

export function conflictRecordScope({ namespace, key }) {
  if (namespace === 'assets') return tr('图片');
  if (namespace === 'navigation-icons') return tr('网站图标');
  if (namespace === 'provider-icons') return tr('搜索引擎图标');
  if (namespace === 'wallpaper') return tr('壁纸');
  if (namespace === 'preferences') {
    if (key === 'owntab.local.v1') return tr('导航、文件夹与外观');
    if (key === 'covelet.tools.v1') return tr('便笺与稍后读');
    if (key === 'covelet.content.preferences.v1') return tr('别名与隐私标记');
    if (key === 'covelet.desktop-templates.v1') return tr('桌面方案');
    if (key === 'covelet.recovery-point.v1') return tr('恢复前副本');
    if (typeof key === 'string' && key.startsWith('covelet.clock.v1.')) return tr('此时钟');
  }
  return tr('扩展数据');
}

export function conflictRecordImpact(record) {
  if (['assets', 'navigation-icons', 'provider-icons', 'wallpaper'].includes(record.namespace)) {
    return tr('所选版本会替换这份图片或图标文件及其相关信息，并在下次同步时上传。');
  }
  const scope = conflictRecordScope(record);
  return scope === tr('扩展数据')
    ? tr('所选版本会替换这组扩展数据的全部内容，包括同组的其他修改，并在下次同步时上传。')
    : tr('所选版本会替换「{0}」中的全部内容，包括同组的其他修改，并在下次同步时上传。', [scope]);
}

export function conflictRecordSummary(record, version) {
  const summary = { scope: conflictRecordScope(record), lines: [], partial: false };
  const add = (line) => summary.lines.push(line);
  function text(value, limit = 120) {
    if (typeof value !== 'string') return '';
    if (value.length > limit) summary.partial = true;
    // Limit work before normalizing whitespace and remove display controls.
    return value.slice(0, limit).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').trim() + (value.length > limit ? '…' : '');
  }
  function examples(items, render) {
    if (items.length > MAX_EXAMPLES) summary.partial = true;
    const result = [];
    for (let index = 0; index < Math.min(items.length, MAX_EXAMPLES); index++) result.push(render(field(items, String(index))));
    return result.join(' · ');
  }
  const name = (item) => text(field(item, 'name')) || text(field(item, 'title')) || tr('未命名');
  const fallback = () => add(tr('暂不支持此内容的摘要，请展开技术详情比较。'));
  if (field(version, 'deleted')) {
    add(tr('此版本已删除这组内容。采用此版本会保留删除结果。'));
    return summary;
  }
  const value = field(version, 'value');
  if (record.namespace === 'preferences' && record.key === 'owntab.local.v1') {
    const entries = array(field(field(value, 'state'), 'entries'));
    if (!entries) { fallback(); return summary; }
    const groups = { site: [], folder: [], widget: [] };
    for (let index = 0; index < Math.min(entries.length, MAX_ITEMS); index++) {
      const item = field(entries, String(index)), type = field(item, 'type');
      if (typeof type === 'string' && Object.hasOwn(groups, type)) groups[type].push(item);
    }
    if (entries.length > MAX_ITEMS) { summary.partial = true; add(tr('内容较多，以下仅列出部分项目。')); }
    else add(tr('网站 {0} 个 · 文件夹 {1} 个 · 组件 {2} 个', [groups.site.length, groups.folder.length, groups.widget.length]));
    if (groups.site.length) add(tr('网站：{0}', [examples(groups.site, item => `${name(item)} — ${text(field(item, 'url'), 160)}`)]));
    if (groups.folder.length) add(tr('文件夹：{0}', [examples(groups.folder, name)]));
    if (groups.widget.length) add(tr('组件：{0}', [examples(groups.widget, name)]));
    add(tr('还包含桌面布局、外观、搜索设置和导航历史。'));
  } else if (record.namespace === 'preferences' && record.key === 'covelet.tools.v1') {
    const notes = array(field(value, 'notes')), reading = array(field(value, 'reading'));
    if (!notes || !reading) { fallback(); return summary; }
    add(tr('便笺 {0} 条 · 稍后读 {1} 条', [notes.length, reading.length]));
    if (notes.length) add(tr('便笺：{0}', [examples(notes, item => `${name(item)} — ${text(field(item, 'body'))}`)]));
    if (reading.length) add(tr('稍后读：{0}', [examples(reading, item => `${name(item)} — ${text(field(item, 'url'), 160)}`)]));
    const trash = array(field(value, 'trash')), snapshots = array(field(value, 'snapshots'));
    if (trash?.length || snapshots?.length) add(tr('另含回收站 {0} 项和旧版快照 {1} 份。', [trash?.length || 0, snapshots?.length || 0]));
  } else if (record.namespace === 'preferences' && record.key === 'covelet.desktop-templates.v1') {
    const templates = array(field(value, 'templates'));
    if (!templates) { fallback(); return summary; }
    add(tr('桌面方案 {0} 个', [templates.length]));
    if (templates.length) add(examples(templates, name));
  } else if (['assets', 'navigation-icons', 'provider-icons', 'wallpaper'].includes(record.namespace)) {
    const blob = blobInfo(value) || blobInfo(field(value, 'blob'));
    if (!blob) { fallback(); return summary; }
    add(tr('文件大小：{0} 字节 · 类型：{1}', [blob.size, blob.type || tr('未知')]));
    const width = field(value, 'width'), height = field(value, 'height');
    if (Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0) add(tr('尺寸：{0} × {1}', [width, height]));
    if (blobInfo(field(value, 'darkBlob'))) add(tr('包含深色外观图片。'));
    add(tr('这里只显示文件信息，不能判断两张图片是否相同。'));
  } else {
    // Unknown records can belong to future content types. Do not infer meaning
    // from their field names or imply this excerpt lists their full scope.
    fallback();
    if (typeof value === 'string') { add(text(value, 320)); summary.partial = true; }
  }
  return summary;
}

// Bounded text only: no HTML, remote image rendering or Blob URLs. The choice
// always applies the full decoded record, never this display projection.
export function conflictRecordPreview(value) {
  let budget = 12000, entries = 0, truncated = false;
  function visit(item, depth = 0) {
    if (budget <= 0 || ++entries > 500 || depth > 12) { truncated = true; return '…'; }
    const blob = blobInfo(item);
    if (blob) return tr('二进制内容：{0} 字节，类型 {1}', [blob.size, blob.type || 'application/octet-stream']);
    if (typeof item === 'string') {
      const result = item.slice(0, Math.max(0, budget)); budget -= result.length;
      if (result.length !== item.length) { truncated = true; return result + '…'; }
      return result;
    }
    if (Array.isArray(item)) {
      const result = []; for (let index = 0; index < item.length; index++) { if (entries > 500 || budget <= 0) { truncated = true; break; } result.push(visit(field(item, String(index)), depth + 1)); } return result;
    }
    if (item && typeof item === 'object') {
      const result = Object.create(null);
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (entries > 500 || budget <= 0) { truncated = true; break; }
        const shownKey = key.slice(0, Math.min(160, budget));
        if (shownKey.length !== key.length) truncated = true;
        budget -= shownKey.length; result[shownKey] = visit(field(item, key), depth + 1);
      }
      return result;
    }
    budget -= String(item).length; return item;
  }
  const text = JSON.stringify(visit(value), null, 2);
  return truncated ? text + '\n' + tr('内容较长，预览已截短；选择时仍会采用此版本的完整内容。') : text;
}
