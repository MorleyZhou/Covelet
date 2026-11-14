import { tr } from '../i18n/index.js';
import { parseBookmarks } from './model.js';
import { parseMarkdownLinks } from './import-plan.js';
import { parseOneTabLinks, parseRaindropBookmarks } from './import-sources.js';

// File.text reads the picked file locally. Never turn a file or its contents
// into a URL, rendered document, or network request.
export async function readBookmarkFile(file, { format = 'auto' } = {}) {
  if (!['auto', 'raindrop-html', 'onetab-text'].includes(format)) throw Error(tr('导入计划无效或条目过多'));
  if (!file || typeof file.text !== 'function') throw Error(tr('请选择浏览器导出的书签 HTML 文件。'));
  if (file.size > 5 * 1024 * 1024) throw Error(tr('书签文件不能超过 5 MB'));
  let content;
  try { content = await file.text(); }
  catch { throw Error(tr('无法读取书签文件，请重新选择。')); }
  if (format === 'raindrop-html') return parseRaindropBookmarks(content);
  if (format === 'onetab-text') return parseOneTabLinks(content);
  const markdown = /\.md$/iu.test(file.name ?? '') || file.type === 'text/markdown';
  return markdown ? parseMarkdownLinks(content) : parseBookmarks(content);
}
