import { fromMarkdown, toMarkdown } from '@futelab/folio/serialization';
import { zipSync } from 'fflate';
import { tr } from '../i18n/index.js';
import { loadState } from './storage.js';
import { loadContentPreferences, withNavigationPrivacy } from './content-preferences.js';
import { loadPersonalToolsSnapshot } from './personal-tools.js';
import { privateContentKeys } from './presentation.js';
import { desktopPageName } from './desktop-pages.js';
import { NOTE_LIMITS, validateNoteDocument } from './note-document.js';
import { sameJson } from './json-equal.js';

export const MARKDOWN_LIBRARY_LIMITS = Object.freeze({ files: 2701, fileBytes: 512 * 1024, expandedBytes: 80 * 1024 * 1024, archiveBytes: 30 * 1024 * 1024 });
const TYPES = ['site', 'reading', 'note'], DIRECTORIES = { site: 'sites', reading: 'reading', note: 'notes' };
const plans = new WeakMap(), encoder = new TextEncoder();
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code) => { throw Object.assign(Error(tr(message)), { code }); };
const conflict = () => fail('资料已更新，请重新生成导出预览。', 'REVISION_CONFLICT');
const limitIssue = () => ({ code: 'MARKDOWN_LIBRARY_LIMIT', message: tr('导出内容超过限制，请减少选择后重试。') });
const unsupportedIssue = () => ({ code: 'MARKDOWN_LIBRARY_UNSUPPORTED', message: tr('部分内容无法导出为 Markdown，请取消选择或使用完整备份。') });
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

// The established mutation order also gives this read-only operation a coherent
// snapshot. Neither preview nor export prunes trash, persists data or reads images.
async function withSnapshot(action) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) fail('浏览器无法锁定本机内容，请重试。', 'LOCK_UNAVAILABLE');
  return locks.request('owntab.local.write.v1', { mode: 'exclusive' }, () => withNavigationPrivacy((preferences) =>
    locks.request('covelet.tools.v1', { mode: 'exclusive' }, async () => {
      const [navigation, tools] = await Promise.all([loadState(), loadPersonalToolsSnapshot()]);
      const snapshot = { navigation, tools, preferences: structuredClone(preferences) };
      const result = await action(snapshot);
      const [nextNavigation, nextTools, nextPreferences] = await Promise.all([loadState(), loadPersonalToolsSnapshot(), loadContentPreferences()]);
      // Full canonical comparisons catch replacement/sync with recycled numeric
      // revisions as well as ordinary edits and changes to privacy inheritance.
      if (!sameJson(navigation, nextNavigation) || !sameJson(tools, nextTools) || !sameJson(preferences, nextPreferences)) conflict();
      return result;
    })));
}

// JSON flow values are also YAML 1.2 values. Escape YAML line separators and
// C1 controls explicitly so no title/remark/tag can introduce another property.
function yaml(value) {
  if (typeof value === 'string' && !value.isWellFormed() || Array.isArray(value) && value.some((item) => typeof item === 'string' && !item.isWellFormed())) throw unsupportedIssue();
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
const inline = (value) => value.replace(/[!-/:-@\[-`{-~]/gu, (character) => `\\${character}`)
  .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, (character) => `&#${character.charCodeAt(0)};`);
const paragraph = (value) => value.split('\n').map(inline).join('  \n');
const encodedPath = (path) => path.split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/gu,
  (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

// Official Help documents Unicode letters, numbers, _-/ and a non-numeric
// character, but does not exhaustively specify emoji or slash edge cases.
// Keep a conservative known subset. All original names always remain in
// covelet_tags, including uncertain forms; the preview never calls them invalid.
function nativeTag(value) {
  return /^[\p{L}\p{N}_-][\p{L}\p{M}\p{N}_-]*(?:\/[\p{L}\p{N}_-][\p{L}\p{M}\p{N}_-]*)*$/u.test(value) && /[\p{L}_-]/u.test(value);
}
function utf8Prefix(value, maximum) {
  let result = '', length = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).length;
    if (length + bytes > maximum) break;
    result += character; length += bytes;
  }
  return result;
}
function exportName(title, used) {
  // Obsidian resolves Markdown paths with URI-reserved escapes still intact;
  // e.g. %23 can name a new file rather than the intended '#' filename. Keep
  // those separators and its heading/block syntax out of physical filenames.
  // Exact titles remain in the front matter and the readable index labels.
  let base = title.toWellFormed().normalize('NFC').replace(/[<>:"/\\|?*#;@&=+$,%^\[\]\p{Cc}\p{Cf}]/gu, '_').replace(/\s+/gu, ' ').trim().replace(/[. ]+$/u, '');
  if (base.normalize('NFKC').startsWith('.')) base = `_${base}`;
  if (/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com\d|lpt\d)(?:[. ]|$)/iu.test(base.normalize('NFKC'))) base = `_${base}`;
  base = utf8Prefix(base, 180).replace(/[. ]+$/u, '') || 'Untitled';
  // Windows case-insensitive paths also equate final sigma and dotless i
  // with their uppercase forms. Fold conservatively before reserving a name;
  // exact titles remain untouched in the Markdown/front matter.
  const identity = (name) => name.normalize('NFKC').toUpperCase().normalize('NFKC');
  let filename = `${base}.md`, count = 2;
  while (used.has(identity(filename))) filename = `${base} (${count++}).md`;
  used.add(identity(filename)); return filename;
}
function noteMarkdown(note) {
  if (!note.body.isWellFormed()) throw unsupportedIssue();
  let document = note.document;
  if (!document) {
    // This is exactly the editor's body-only interpretation. Unsupported legacy
    // markup remains literal text rather than being discarded or executed.
    try { document = fromMarkdown(note.body, { limits: NOTE_LIMITS }); }
    catch { document = { type: 'doc', content: [{ type: 'paragraph', ...(note.body ? { content: [{ type: 'text', text: note.body }] } : {}) }] }; }
  }
  document = structuredClone(document); validateNoteDocument(document);
  const omittedIds = new Set(), fragments = new Set();
  function inspect(node) {
    if (node.type === 'image') throw unsupportedIssue();
    if (node.type === 'heading' && node.attrs?.id && node.attrs.id === node.attrs['data-toc-id']) omittedIds.add(node.attrs.id);
    for (const mark of node.marks || []) {
      const href = mark.type === 'link' && mark.attrs?.href;
      if (typeof href === 'string' && href.startsWith('#')) {
        let fragment = href.slice(1);
        try { fragment = decodeURIComponent(fragment); } catch { /* Keep the original fragment if it is not URI encoded. */ }
        fragments.add(fragment);
      }
    }
    for (const child of node.content || []) inspect(child);
  }
  inspect(document);
  // Omitting an editor-generated heading ID is safe only when the document
  // does not contain a self-link that depends on that exact anchor.
  if ([...fragments].some((fragment) => omittedIds.has(fragment))) throw unsupportedIssue();
  // Folio verifies its own Markdown round trip, including marks and attributes.
  // Unsupported tables/callouts/bookmarks/etc. become explicit item issues.
  return toMarkdown(document, { limits: NOTE_LIMITS, headingIds: 'omit-matching-toc' });
}
function markdownFile(item) {
  const properties = { title: item.title, covelet_type: item.type, covelet_tags: item.tagNames,
    tags: item.tagNames.filter(nativeTag), description: item.metadata.description };
  if (item.record.url) properties.url = item.record.url;
  if (item.type === 'site') properties.covelet_path = item.path;
  else {
    properties.created = new Date(item.record.createdAt).toISOString();
    properties.updated = new Date(item.record.updatedAt).toISOString();
    if (item.type === 'reading') {
      properties.status = item.record.status;
      if (item.record.revisitOn !== undefined) properties.revisit_on = item.record.revisitOn;
    } else properties.covelet_pinned = item.record.pinned;
  }
  let body = `# ${inline(item.title)}\n\n`;
  if (item.record.url) body += `[${inline(item.record.url)}](<${item.record.url.replace(/</gu, '%3C').replace(/>/gu, '%3E')}>)\n\n`;
  if (item.metadata.description) body += `${paragraph(item.metadata.description)}\n\n`;
  if (item.type === 'note') body += noteMarkdown(item.record);
  return `---\n${Object.entries(properties).map(([key, value]) => `${key}: ${yaml(value)}`).join('\n')}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`;
}
function indexMarkdown(items) {
  const sections = { site: tr('网站'), reading: tr('稍后读'), note: tr('便笺') };
  let value = `# ${inline(tr('Covelet 资料库'))}\n\n${tr('这是未加密的 Markdown 交换文件，不包含隐藏内容或附件。')}\n`;
  for (const type of TYPES) {
    const selected = items.filter((item) => item.type === type);
    if (!selected.length) continue;
    value += `\n## ${sections[type]}\n\n`;
    for (const item of selected) {
      value += `- [${inline(item.title)}](<${encodedPath(item.filename)}>)`;
      if (item.path.length) value += ` — ${item.path.map(inline).join(' / ')}`;
      if (item.tagNames.length) value += ` — ${tr('标签')}: ${item.tagNames.map(inline).join(', ')}`;
      value += '\n';
    }
  }
  return value;
}
function selectionSize(items) {
  const index = encoder.encode(indexMarkdown(items));
  return { index, totalBytes: items.reduce((size, item) => size + item.bytes.length, index.length),
    issue: items.length + 1 > MARKDOWN_LIBRARY_LIMITS.files || index.length > MARKDOWN_LIBRARY_LIMITS.fileBytes
      || items.reduce((size, item) => size + item.bytes.length, index.length) > MARKDOWN_LIBRARY_LIMITS.expandedBytes ? limitIssue() : null };
}

export async function inspectMarkdownLibrary(options = {}) {
  if (!plain(options) || Object.keys(options).some((key) => key !== 'types')) fail('请选择有效的导出条目。', 'MARKDOWN_LIBRARY_SELECTION');
  const types = options.types === undefined ? [...TYPES] : Array.isArray(options.types) ? [...options.types] : null;
  if (!types || new Set(types).size !== types.length || types.some((type) => !TYPES.includes(type))) fail('请选择有效的导出条目。', 'MARKDOWN_LIBRARY_SELECTION');
  return withSnapshot((snapshot) => {
    const { navigation, tools, preferences } = snapshot, hidden = privateContentKeys(navigation, preferences);
    const folders = new Map(navigation.entries.filter((entry) => entry.type === 'folder').map((entry) => [entry.id, entry]));
    const tagNames = new Map((preferences.library?.tags || []).map((tag) => [tag.id, tag.name]));
    const candidates = [...navigation.entries.filter((entry) => entry.type === 'site').map((record) => ({ type: 'site', record })),
      ...tools.reading.map((record) => ({ type: 'reading', record })), ...tools.notes.map((record) => ({ type: 'note', record }))];
    const items = [], rows = [], issues = [], warnings = [], used = Object.fromEntries(TYPES.map((type) => [type, new Set()]));
    const counts = { site: 0, reading: 0, note: 0 };
    for (const { type, record } of candidates) {
      const key = `${type}:${record.id}`;
      // Filter before filenames, tags, serialization, issue counts or previews.
      if (!types.includes(type) || hidden.has(key)) continue;
      const metadata = structuredClone(preferences.library?.items[key] || { description: '', tagIds: [] });
      const tags = metadata.tagIds.map((id) => tagNames.get(id));
      const path = type === 'site' ? [desktopPageName(navigation.settings, record.page ?? folders.get(record.parentId)?.page ?? 0),
        ...(record.parentId ? [folders.get(record.parentId).name] : [])] : [];
      const title = type === 'site' ? record.name : record.title;
      const item = { key, type, title, record, metadata, tagNames: tags, path, filename: `${DIRECTORIES[type]}/${exportName(title, used[type])}` };
      let bytes = null, issue;
      try {
        bytes = encoder.encode(markdownFile(item));
        if (bytes.length > MARKDOWN_LIBRARY_LIMITS.fileBytes || item.filename.length >= 240) issue = limitIssue();
      } catch { issue = unsupportedIssue(); }
      const unsupportedTags = tags.filter((tag) => !nativeTag(tag));
      const row = { key, type, title, tagNames: tags, path, bytes: bytes?.length || 0, unsupportedTags, ...(issue ? { issue } : {}) };
      counts[type]++; rows.push(row);
      if (issue) issues.push({ key, ...issue });
      else items.push({ ...item, bytes });
      if (unsupportedTags.length) warnings.push({ key, code: 'NON_NATIVE_TAGS', tagNames: unsupportedTags, message: tr('以下标签仅保留在 covelet_tags 属性中。') });
    }
    const size = selectionSize(items);
    const plan = freeze({ version: 1, rows, counts, totalCount: rows.length, totalBytes: size.totalBytes, issues, warnings,
      ...(size.issue ? { selectionIssue: size.issue } : {}) });
    plans.set(plan, { snapshot, items, issues: new Map(issues.map((issue) => [issue.key, issue])), keys: new Set(rows.map((row) => row.key)) });
    return plan;
  });
}

export async function exportMarkdownLibrary(plan, options = {}) {
  const pending = plans.get(plan);
  if (!pending) fail('资料库预览已失效，请重新生成。', 'MARKDOWN_LIBRARY_PREVIEW');
  if (!plain(options) || Object.keys(options).some((key) => key !== 'selectedKeys') || !Array.isArray(options.selectedKeys)) fail('请选择有效的导出条目。', 'MARKDOWN_LIBRARY_SELECTION');
  const selected = [...options.selectedKeys];
  if (!selected.length || new Set(selected).size !== selected.length || selected.some((key) => typeof key !== 'string' || !pending.keys.has(key))) fail('请选择有效的导出条目。', 'MARKDOWN_LIBRARY_SELECTION');
  return withSnapshot((snapshot) => {
    if (!sameJson(snapshot, pending.snapshot)) conflict();
    const issue = selected.map((key) => pending.issues.get(key)).find(Boolean);
    if (issue) throw Object.assign(Error(issue.message), { code: issue.code });
    const keys = new Set(selected), items = pending.items.filter((item) => keys.has(item.key)), size = selectionSize(items);
    if (size.issue) throw Object.assign(Error(size.issue.message), { code: size.issue.code });
    const archive = Object.create(null); archive['index.md'] = size.index;
    for (const item of items) archive[item.filename] = item.bytes;
    const bytes = zipSync(archive, { level: 6 });
    if (bytes.length > MARKDOWN_LIBRARY_LIMITS.archiveBytes) throw Object.assign(Error(limitIssue().message), { code: 'MARKDOWN_LIBRARY_LIMIT' });
    return { blob: new Blob([bytes], { type: 'application/zip' }), filename: 'Covelet-library.zip', count: items.length };
  });
}
