import { tr } from '../i18n/index.js';
import { normalizeUrl, parseBookmarks } from './model.js';
import { importMetadataIssues } from './import-plan.js';

const MAX_BYTES = 5 * 1024 * 1024, MAX_ENTRIES = 2000;
const label = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();

// Compatibility is with the observed public Netscape structure, not an
// inferred client version. Imported descriptions are plain attribute text.
export function parseRaindropBookmarks(text) {
  const plan = parseBookmarks(text, { readMetadata: true });
  plan.source = { format: 'raindrop-html' };
  plan.sites.forEach((site, sourceIndex) => {
    const issues = importMetadataIssues(site.metadata, { sourceIndex });
    if (issues.length) site.metadataIssues = issues;
  });
  return plan;
}

// OneTab 2.25's plain serializer joins URL/title with " | " and groups
// with blank lines. This parser deliberately does not scan prose/Markdown.
export function parseOneTabLinks(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_BYTES) throw Error(tr('粘贴内容无效或超过 5 MB'));
  const plan = { folders: [], sites: [], invalid: [], duplicateCount: 0,
    source: { format: 'onetab-text', supportedVersion: '2.25' } };
  const seen = new Set();
  let group = 0, inGroup = false, folder = null, candidates = 0;
  for (const [index, raw] of text.replace(/^\uFEFF/u, '').split(/\r\n?|\n/u).entries()) {
    const line = raw.trim();
    if (!line) { inGroup = false; folder = null; continue; }
    if (++candidates > MAX_ENTRIES) throw Error(tr('导入条目不能超过 {0}', [MAX_ENTRIES]));
    if (!inGroup) { group++; inGroup = true; }
    const separator = line.indexOf(' | '), address = separator < 0 ? line : line.slice(0, separator);
    const rawName = separator < 0 ? '' : line.slice(separator + 3);
    try {
      if (!/^https?:\/\//iu.test(address)) throw Error(tr('仅支持 HTTP 和 HTTPS 网址'));
      const url = normalizeUrl(address), name = label(rawName) || new URL(url).hostname;
      if (name.length > 200) throw Error(tr('导入网址无效。'));
      if (!folder) {
        folder = tr('OneTab 组 {0}', [group]);
        plan.folders.push({ name: folder, originalPath: folder });
      }
      plan.sites.push({ name, url, folder, line: index + 1 });
      if (seen.has(url)) plan.duplicateCount++;
      seen.add(url);
    } catch (reason) {
      plan.invalid.push({ name: label(rawName).slice(0, 200) || tr('未命名网址'), url: address.slice(0, 4096), line: index + 1, reason: reason.message });
    }
    if (plan.folders.length + plan.sites.length > MAX_ENTRIES || plan.invalid.length > MAX_ENTRIES) throw Error(tr('导入条目不能超过 {0}', [MAX_ENTRIES]));
  }
  if (!plan.sites.length && !plan.invalid.length) throw Error(tr('没有可导入的网址'));
  return plan;
}
