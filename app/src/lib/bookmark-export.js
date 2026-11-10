import { formatNumber, tr } from '../i18n/index.js';
import { layoutDesktop } from './desktop-layout.js';
import { normalizeUrl } from './model.js';

const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value) => value.replace(/[&<>"']/gu, (character) => entities[character]);
const group = (name, body) => body ? `<DT><H3>${escape(name)}</H3>\n<DL><p>\n${body}</DL><p>\n` : '';
const ordered = (entries) => entries.slice().sort((a, b) => a.order - b.order);

function link(entry) {
  if (!/^https?:\/\//iu.test(entry.url)) return '';
  try { return `<DT><A HREF="${escape(normalizeUrl(entry.url))}">${escape(entry.name)}</A>\n`; }
  catch { return ''; }
}

function pageIds(state) {
  return [...new Set([...state.settings.pages, ...state.entries.filter((entry) => !entry.parentId && !entry.detached).map((entry) => entry.page ?? 0)])].sort((a, b) => a - b);
}

function pageNames(state, pageLabel) {
  return new Map(pageIds(state).map((page, index) => [page, pageLabel?.(page) || tr('第 {0} 屏', [formatNumber(index + 1)])]));
}

const eligibleFolder = (entry, hiddenKeys) => entry.type === 'folder' && !entry.detached && !hiddenKeys.has(`folder:${entry.id}`);

export function bookmarkExportScopes(state, hiddenKeys, pageLabel) {
  const pages = pageNames(state, pageLabel);
  return [
    { value: 'all', label: tr('全部导航') },
    ...Array.from(pages, ([page, label]) => ({ value: `page:${page}`, label })),
    ...ordered(state.entries.filter((entry) => eligibleFolder(entry, hiddenKeys))).map((folder) => ({
      value: `folder:${folder.id}`, label: `${pages.get(folder.page ?? 0)} / ${folder.name}`,
    })),
  ];
}

export function serializeBookmarkExport(state, { scope, hiddenKeys, pageLabel }) {
  const children = new Map();
  for (const entry of ordered(state.entries)) {
    if (entry.type !== 'site' || !entry.parentId || hiddenKeys.has(`site:${entry.id}`)) continue;
    if (!children.has(entry.parentId)) children.set(entry.parentId, []);
    children.get(entry.parentId).push(entry);
  }
  const folderHtml = (entry) => eligibleFolder(entry, hiddenKeys)
    ? group(entry.name, (children.get(entry.id) || []).map(link).join('')) : '';
  let body = '';
  if (scope.startsWith('folder:')) {
    const folder = state.entries.find((entry) => entry.id === scope.slice(7));
    if (folder) body = folderHtml(folder);
  } else {
    const pages = pageNames(state, pageLabel);
    const contents = new Map();
    for (const screen of layoutDesktop(state.entries, state.settings.columns, null, state.settings.pages)) {
      const visible = screen.items.map((entry) => {
        if (entry.type === 'folder') return folderHtml(entry);
        return entry.type === 'site' && !hiddenKeys.has(`site:${entry.id}`) ? link(entry) : '';
      }).join('');
      contents.set(screen.page, (contents.get(screen.page) || '') + visible);
    }
    if (scope === 'all') body = Array.from(pages, ([page, name]) => group(name, contents.get(page))).join('');
    else if (scope.startsWith('page:')) body = contents.get(Number(scope.slice(5))) || '';
  }
  if (!body) throw Error(tr('没有可导出的网站。'));
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${body}</DL><p>\n`;
}
