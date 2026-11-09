import { tr } from '../i18n/index.js';
import { letterIcon, migrateNavigationState, normalizeUrl, validateState } from './model.js';
import { DESKTOP_ROWS, MAX_DESKTOP_PAGE, layoutDesktop } from './desktop-layout.js';

const MAX_ENTRIES = 2000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_MARKDOWN_LINK_SPAN = 8192;
const fail = (message) => { throw Error(message); };
const newId = (kind) => `${kind}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
const label = (value, fallback) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 200) || fallback;
const overlaps = (ranges, start, end) => ranges.some(([from, to]) => start < to && end > from);

// Read Markdown destinations without losing balanced parentheses in a URL.
// No imported markup is rendered and no network request is involved.
function markdownDestination(text, start, limit = text.length) {
  let cursor = start;
  while (cursor < limit && (text[cursor] === ' ' || text[cursor] === '\t')) cursor++;
  let destination = '';
  if (text[cursor] === '<') {
    const close = text.slice(cursor + 1, limit).indexOf('>');
    if (close < 0) return null;
    const end = cursor + 1 + close;
    if (text.slice(cursor, end).includes('\n')) return null;
    destination = text.slice(cursor + 1, end); cursor = end + 1;
  } else {
    let depth = 0;
    for (; cursor < limit; cursor++) {
      const character = text[cursor];
      if (character === '\n' || character === '\r') return null;
      if (character === '\\' && /[\\()[\]]/u.test(text[cursor + 1] ?? '')) { destination += text[++cursor]; continue; }
      if (character === '(') depth++;
      if (character === ')') {
        if (depth === 0) return { url: destination, end: cursor + 1 };
        depth--;
      }
      if (/\s/u.test(character) && depth === 0) break;
      destination += character;
    }
  }
  while (cursor < limit && (text[cursor] === ' ' || text[cursor] === '\t')) cursor++;
  if (text[cursor] === '"' || text[cursor] === "'") {
    const quote = text[cursor++];
    while (cursor < limit && text[cursor] !== '\n') {
      if (text[cursor] === '\\') { cursor += 2; continue; }
      if (text[cursor++] === quote) break;
    }
    while (cursor < limit && (text[cursor] === ' ' || text[cursor] === '\t')) cursor++;
  }
  return cursor < limit && text[cursor] === ')' ? { url: destination, end: cursor + 1 } : null;
}

function parseLinks(text, countMarkdownToken) {
  const markdownDocument = Boolean(countMarkdownToken);
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_BYTES) fail(tr('粘贴内容无效或超过 5 MB'));
  const plan = { folders: [], sites: [], invalid: [], duplicateCount: 0 };
  const ranges = [], candidates = [], lines = [];
  const add = (url, name, start, end) => {
    candidates.push({ url, name, start }); ranges.push([start, end]);
    if (candidates.length > MAX_ENTRIES) fail(tr('导入条目不能超过 {0}', [MAX_ENTRIES]));
  };
  const markdown = markdownDocument ? /!?\[((?:\\[^\r\n]|[^\[\]\\\r\n]){0,500})\]\(/gu : /!?\[([^\]\n]{0,500})\]\(/gu;
  for (const match of text.matchAll(markdown)) {
    if (match.index < (ranges.at(-1)?.[1] ?? 0)) continue;
    const start = match.index + match[0].length;
    countMarkdownToken?.();
    const target = markdownDestination(text, start, markdownDocument ? Math.min(start + MAX_MARKDOWN_LINK_SPAN, text.length) : text.length);
    if (!target) continue;
    if (match[0].startsWith('!')) ranges.push([match.index, target.end]);
    else add(target.url, match[1].replace(/\\([\\()[\]])/gu, '$1'), match.index, target.end);
  }
  const markdownCount = ranges.length;
  let markdownIndex = 0;
  for (const match of text.matchAll(/<((?:https?:\/\/)[^<>\s]+)>/giu)) {
    const end = match.index + match[0].length;
    while (markdownIndex < markdownCount && ranges[markdownIndex][1] <= match.index) markdownIndex++;
    if (markdownIndex === markdownCount || ranges[markdownIndex][0] >= end) add(match[1], '', match.index, end);
  }
  let offset = 0;
  for (const line of text.split('\n')) {
    const end = offset + line.length, value = line.trim().replace(/^(?:[-*+]|\d+\.)\s+/u, '');
    lines.push({ value, start: offset, end });
    if (value && !overlaps(ranges, offset, end)) {
      // A standalone URL is kept whole, including query values ending in
      // punctuation and quotes. It must not be truncated by prose extraction.
      if (markdownDocument) {
        if (/^[a-z][a-z\d+.-]*:\/\/\S+$/iu.test(value)) add(value, '', offset, end);
      } else {
        try { normalizeUrl(value); add(value, '', offset, end); }
        catch (reason) { if (candidates.length > MAX_ENTRIES) throw reason; }
      }
    }
    offset = end + 1;
  }
  if (!markdownDocument) {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
      if (!overlaps(ranges, match.index, match.index + match[0].length)) add(match[0], '', match.index, match.index + match[0].length);
    }
    for (const { value, start, end } of lines) {
      if (value && !overlaps(ranges, start, end) && !/^#{1,6}\s/u.test(value)) add(value, '', start, end);
    }
  }
  candidates.sort((a, b) => a.start - b.start);
  const seen = new Set(); let lineIndex = 0;
  for (const candidate of candidates) {
    while (lineIndex + 1 < lines.length && lines[lineIndex + 1].start <= candidate.start) lineIndex++;
    const line = lineIndex + 1;
    try {
      if (markdownDocument && !/^https?:\/\//iu.test(candidate.url)) fail(tr('仅支持 HTTP 和 HTTPS 网址'));
      const url = normalizeUrl(candidate.url);
      plan.sites.push({ name: label(candidate.name, new URL(url).hostname), url, folder: null, line });
      if (seen.has(url)) plan.duplicateCount++;
      seen.add(url);
    } catch (reason) {
      plan.invalid.push({ name: label(candidate.name, tr('未命名网址')), url: candidate.url.slice(0, 4096), reason: reason.message, line });
    }
    if (plan.sites.length > MAX_ENTRIES || plan.invalid.length > MAX_ENTRIES) fail(tr('导入条目不能超过 {0}', [MAX_ENTRIES]));
  }
  return plan;
}

export function parseBulkLinks(text) {
  return parseLinks(text);
}

export function parseMarkdownLinks(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_BYTES) fail(tr('书签文件不能超过 5 MB'));
  const plan = { folders: [], sites: [], invalid: [], duplicateCount: 0 };
  const headings = [], folderNames = new Set(), seen = new Set();
  const lines = text.replace(/^\uFEFF/u, '').replace(/<!--[\s\S]*?(?:-->|$)/gu, (comment) => comment.replace(/[^\r\n]/gu, ' ')).split(/\r\n?|\n/u);
  let fence = '', folder = null, markdownTokens = 0;
  const countMarkdownToken = () => {
    if (++markdownTokens > MAX_ENTRIES) fail(tr('导入条目不能超过 {0}', [MAX_ENTRIES]));
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = '';
      continue;
    }
    if (marker) { fence = marker[1]; continue; }

    const atx = /^ {0,3}(#{1,6})(?:[\t ]+|$)(.*)$/u.exec(line);
    const setext = !atx && /^ {0,3}\S/u.test(line) && !/^(?:\s*[-*+]\s|\s*\d+\.\s|\s*https?:\/\/)/iu.test(line)
      ? /^ {0,3}(=+|-+)[\t ]*$/u.exec(lines[index + 1] ?? '') : null;
    if (atx || setext) {
      const level = atx ? atx[1].length : setext[1].startsWith('=') ? 1 : 2;
      const heading = atx ? atx[2].replace(/[\t ]+#+[\t ]*$/u, '') : line;
      headings.length = level - 1;
      headings.push(label(heading, ''));
      folder = null;
      if (setext) index++;
      continue;
    }

    // Markdown examples are not bookmarks. The shared scanner then reads
    // real inline links, angle-bracket autolinks and standalone URL items.
    const content = line.replace(/(?<!`)(`{1,16})(?!`).*?\1(?!`)/gu, (span) => ' '.repeat(span.length));
    if (!/[\[:<]/u.test(content)) continue;
    const { sites, invalid } = parseLinks(content, countMarkdownToken);
    if (sites.length && !folder && headings.some(Boolean)) {
      const originalPath = headings.filter(Boolean).join(' / ');
      const base = label(originalPath, tr('未命名文件夹'));
      folder = base;
      let count = 2;
      while (folderNames.has(folder)) {
        const suffix = ` (${count++})`;
        folder = `${base.slice(0, 200 - suffix.length)}${suffix}`;
      }
      folderNames.add(folder);
      plan.folders.push({ name: folder, originalPath });
    }
    for (const site of sites) {
      plan.sites.push({ ...site, folder, line: index + 1 });
      if (seen.has(site.url)) plan.duplicateCount++;
      seen.add(site.url);
    }
    for (const item of invalid) plan.invalid.push({ ...item, line: index + 1 });
    if (plan.folders.length + plan.sites.length + plan.invalid.length > MAX_ENTRIES) fail(tr('导入条目不能超过 {0}', [MAX_ENTRIES]));
  }
  if (!plan.sites.length && !plan.invalid.length) fail(tr('没有可导入的网址'));
  return plan;
}

function checkedSelection(indices, count) {
  if (indices === undefined) return new Set(Array.from({ length: count }, (_, index) => index));
  if (!Array.isArray(indices) && !(indices instanceof Set)) fail(tr('导入选择无效。'));
  const selected = new Set(indices);
  for (const index of selected) if (!Number.isSafeInteger(index) || index < 0 || index >= count) fail(tr('导入选择无效。'));
  return selected;
}

// Only new roots receive positions. Existing page assignments, coordinates,
// widget configurations and icon metadata remain intact, including responsive
// overflow screens. Their displayed cells are reserved before adding anything.
function positionNewRoots(state, ids, targetPage, columns) {
  const screen = layoutDesktop(state.entries.filter((entry) => !ids.has(entry.id)), columns, null, state.settings.pages)
    .find((item) => item.page === targetPage && item.key === `${targetPage}:0`);
  let occupied = new Set();
  for (const placement of screen?.placements.values() ?? []) {
    for (let row = 0; row < placement.rows; row++) for (let column = 0; column < placement.columns; column++) {
      occupied.add((placement.row - 1 + row) * columns + placement.column - 1 + column);
    }
  }
  let page = targetPage;
  let lastPage = Math.max(0, ...state.settings.pages, ...state.entries.filter((entry) => entry.parentId === null).map((entry) => entry.page ?? 0));
  for (const entry of state.entries.filter((item) => ids.has(item.id))) {
    let slot = 0;
    while (slot < columns * DESKTOP_ROWS && occupied.has(slot)) slot++;
    if (slot === columns * DESKTOP_ROWS) {
      if (lastPage >= MAX_DESKTOP_PAGE) fail(tr('主屏幕数量已达上限。'));
      page = ++lastPage; occupied = new Set(); slot = 0;
    }
    entry.page = page; entry.position = { row: Math.floor(slot / columns), column: slot % columns };
    occupied.add(slot);
  }
  const byId = new Map(state.entries.map((entry) => [entry.id, entry]));
  for (const entry of state.entries) if (ids.has(entry.parentId)) entry.page = byId.get(entry.parentId).page;
  state.settings.pages = [...new Set([...state.settings.pages, targetPage, ...state.entries.filter((entry) => ids.has(entry.id)).map((entry) => entry.page)])].sort((a, b) => a - b);
}

export function prepareImport(input, plan, { selectedIndices, page = 0, columns = input?.settings?.columns ?? 8, skipDuplicates = true, targetFolderId = null } = {}) {
  const state = migrateNavigationState(input);
  if (!Number.isSafeInteger(page) || page < 0 || page > MAX_DESKTOP_PAGE || !Number.isSafeInteger(columns) || columns < 1 || columns > 12) fail(tr('导入目标屏幕无效。'));
  if (typeof skipDuplicates !== 'boolean' || !plan || !Array.isArray(plan.folders) || !Array.isArray(plan.sites)
    || plan.folders.length + plan.sites.length > MAX_ENTRIES) fail(tr('导入计划无效或条目过多'));
  const selected = checkedSelection(selectedIndices, plan.sites.length), folderNames = new Map();
  for (const folder of plan.folders) {
    if (typeof folder?.name !== 'string' || !folder.name.trim() || folder.name.length > 200 || /[\u0000-\u001f\u007f]/u.test(folder.name) || folderNames.has(folder.name)) fail(tr('导入文件夹无效。'));
    folderNames.set(folder.name, folder.originalPath || folder.name);
  }
  const targetFolder = targetFolderId === null ? null : state.entries.find((entry) => entry.type === 'folder' && entry.id === targetFolderId);
  if (targetFolderId !== null && !targetFolder) fail(tr('导入目标文件夹不存在。'));
  const existingUrls = new Set(state.entries.filter((entry) => entry.type === 'site').map((entry) => entry.url));
  const selectedUrls = new Set(), additions = [], rows = [];
  let skippedDuplicates = 0;
  plan.sites.forEach((item, index) => {
    if (typeof item?.name !== 'string' || !item.name.trim() || item.name.length > 200 || /[\u0000-\u001f\u007f]/u.test(item.name)
      || (item.folder !== null && !folderNames.has(item.folder))) fail(tr('导入网址无效。'));
    const url = normalizeUrl(item.url), duplicate = existingUrls.has(url) || selectedUrls.has(url), checked = selected.has(index);
    const willAdd = checked && (!skipDuplicates || !duplicate);
    rows.push({ index, name: item.name.trim(), url, folder: item.folder, originalFolder: folderNames.get(item.folder) || '', selected: checked, duplicate, willAdd });
    if (!checked) return;
    if (skipDuplicates && duplicate) { skippedDuplicates++; return; }
    selectedUrls.add(url); additions.push(rows.at(-1));
  });
  const newRoots = new Set(), destinationFolders = new Map();
  let rootOrder = state.entries.filter((entry) => entry.parentId === null).length;
  let addedFolders = 0;
  for (const row of additions) {
    if (targetFolder || row.folder === null || destinationFolders.has(row.folder)) continue;
    const existing = state.entries.find((entry) => entry.type === 'folder' && entry.name === row.folder && (entry.page ?? 0) === page);
    if (existing) destinationFolders.set(row.folder, existing);
    else {
      const folder = { id: newId('folder'), type: 'folder', name: row.folder, groupId: 'group-home', parentId: null, page, icon: letterIcon(row.folder), order: rootOrder++ };
      destinationFolders.set(row.folder, folder); state.entries.push(folder); newRoots.add(folder.id); addedFolders++;
    }
  }
  let revealId = null;
  for (const row of additions) {
    const parent = targetFolder || destinationFolders.get(row.folder), parentId = parent?.id ?? null;
    const entry = { id: newId('site'), type: 'site', name: row.name, url: row.url, groupId: 'group-home', parentId,
      page: parent?.page ?? page, icon: letterIcon(row.name), order: parentId === null ? rootOrder++ : state.entries.filter((item) => item.parentId === parentId).length };
    state.entries.push(entry);
    if (parentId === null) newRoots.add(entry.id);
    revealId ??= entry.id;
    row.destinationFolder = parent?.name ?? ''; row.entryId = entry.id;
  }
  if (state.entries.length > MAX_ENTRIES) fail(tr('网址和文件夹总数不能超过 {0}', [MAX_ENTRIES]));
  if (newRoots.size) positionNewRoots(state, newRoots, page, columns);
  const entriesById = new Map(state.entries.map((entry) => [entry.id, entry]));
  for (const row of rows) if (row.willAdd) row.targetPage = entriesById.get(row.entryId).page;
  return { state: validateState(state), addedSites: additions.length, addedFolders, skippedDuplicates, revealId, rows, sourceRevision: input.revision };
}
