import { tr } from '../i18n/index.js';
import { parseBookmarks } from './model.js';
import { parseMarkdownLinks } from './import-plan.js';

// File.text reads the picked file locally. Never turn a file or its contents
// into a URL, rendered document, or network request.
export async function readBookmarkFile(file) {
  if (!file || typeof file.text !== 'function') throw Error(tr('请选择浏览器导出的书签 HTML 文件。'));
  if (file.size > 5 * 1024 * 1024) throw Error(tr('书签文件不能超过 5 MB'));
  let content;
  try { content = await file.text(); }
  catch { throw Error(tr('无法读取书签文件，请重新选择。')); }
  const markdown = /\.md$/iu.test(file.name ?? '') || file.type === 'text/markdown';
  return markdown ? parseMarkdownLinks(content) : parseBookmarks(content);
}
