import { fromMarkdown, toMarkdown } from '@futelab/folio/serialization';
import { sanitizeFolioUrl } from '@futelab/folio/core';
import { zipSync } from 'fflate';
import { tr } from '../i18n/index.js';
import { NOTE_LIMITS, noteDocumentText, validateNoteDocument } from './note-document.js';
import { importNoteDrafts, withExportableNotes } from './personal-tools.js';

export const MARKDOWN_NOTE_LIMITS = Object.freeze({ files: 50, fileBytes: 512 * 1024, totalBytes: 5 * 1024 * 1024 });
const plans = new WeakMap(), encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const fail = (message, code = 'MARKDOWN_NOTES') => { throw Object.assign(Error(tr(message)), { code }); };
const parseLimits = { ...NOTE_LIMITS, maxNodes: NOTE_LIMITS.maxNodes + 2, maxTextLength: NOTE_LIMITS.maxTextLength + 200, maxAttributeValues: NOTE_LIMITS.maxAttributeValues + 4 };
const serializationOptions = { limits: parseLimits, headingIds: 'omit-matching-toc' };

function textDocument(body) {
  return { type: 'doc', content: [{ type: 'paragraph', ...(body ? { content: [{ type: 'text', text: body }] } : {}) }] };
}
function imageLinks(document) {
  let count = 0;
  function convert(node, parent) {
    if (node.type === 'image') {
      const source = sanitizeFolioUrl(node.attrs?.src, { kind: 'link' });
      if (!source) fail('Markdown 图片地址不受支持，请改用完整备份。');
      count++;
      const label = [node.attrs?.alt, node.attrs?.title].filter(Boolean).join(' / ') || tr('图片');
      const content = [{ type: 'text', text: `${label}: ${source}`,
        ...(/^https?:\/\//iu.test(source) ? { marks: [{ type: 'link', attrs: { href: source } }] } : {}) }];
      return parent === 'paragraph' ? content : [{ type: 'paragraph', content }];
    }
    return [{ ...node, ...(node.content ? { content: node.content.flatMap((child) => convert(child, node.type)) } : {}) }];
  }
  return { document: convert(document)[0], count };
}
function filenameTitle(filename) {
  const title = filename.replace(/\.(md|markdown)$/iu, '').trim();
  if (!title || title.length > 200 || /[\u0000-\u001f\u007f]/u.test(title)) fail('Markdown 便笺标题无效或过长。');
  return title;
}
function parseFile(source, filename) {
  let document;
  try { document = fromMarkdown(source, { limits: parseLimits }); }
  catch { fail('Markdown 包含不支持的内容或超出便笺限制。'); }
  const transformed = imageLinks(document); document = transformed.document;
  const heading = document.content?.findIndex((node) => node.type === 'heading' && node.attrs?.level === 1) ?? -1;
  const title = heading >= 0 ? noteDocumentText(document.content[heading]).trim() : filenameTitle(filename);
  if (!title || title.length > 200 || /[\u0000-\u001f\u007f]/u.test(title)) fail('Markdown 便笺标题无效或过长。');
  if (heading >= 0) document.content.splice(heading, 1);
  if (!document.content?.length) document = textDocument('');
  document = JSON.parse(JSON.stringify(document));
  validateNoteDocument(document);
  const body = noteDocumentText(document);
  if (body.length > 60000 || body.includes('\0')) fail('Markdown 包含不支持的内容或超出便笺限制。');
  try { toMarkdown(document, serializationOptions); }
  catch { fail('Markdown 包含不支持的内容或超出便笺限制。'); }
  return { draft: { title, body, document }, convertedImages: transformed.count };
}

export async function inspectMarkdownNotes(files) {
  if (!files || !Number.isInteger(files.length) || !files.length || files.length > MARKDOWN_NOTE_LIMITS.files) fail('请选择 1 至 50 个 Markdown 文件。');
  const selected = Array.from(files, (blob) => ({ blob, filename: blob?.name, bytes: blob?.size }));
  for (const file of selected) {
    if (!(file.blob instanceof Blob) || !file.bytes || file.bytes > MARKDOWN_NOTE_LIMITS.fileBytes
      || typeof file.filename !== 'string' || !/\.(md|markdown)$/iu.test(file.filename)) {
      try { fail('Markdown 文件须为 UTF-8，且每个不超过 512 KiB。'); }
      catch (reason) { reason.filename = file.filename; throw reason; }
    }
  }
  const totalBytes = selected.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > MARKDOWN_NOTE_LIMITS.totalBytes) fail('Markdown 文件总大小不能超过 5 MiB。');
  const drafts = [], entries = [];
  for (const file of selected) {
    try {
      let source;
      try { source = decoder.decode(await file.blob.arrayBuffer()).replace(/^\uFEFF/u, ''); }
      catch { fail('Markdown 文件须为 UTF-8，且每个不超过 512 KiB。'); }
      const parsed = parseFile(source, file.filename);
      drafts.push(parsed.draft);
      entries.push(Object.freeze({ filename: file.filename, title: parsed.draft.title, excerpt: parsed.draft.body.replace(/\s+/gu, ' ').slice(0, 140), bytes: file.bytes, convertedImages: parsed.convertedImages }));
    } catch (reason) { reason.filename = file.filename; throw reason; }
  }
  const plan = Object.freeze({ version: 1, count: drafts.length, totalBytes, convertedImages: entries.reduce((sum, entry) => sum + entry.convertedImages, 0), entries: Object.freeze(entries) });
  plans.set(plan, { drafts, state: 'ready' });
  return plan;
}

export async function importMarkdownNotes(plan, options) {
  const pending = plans.get(plan);
  if (!pending || pending.state !== 'ready') fail('Markdown 预览已失效，请重新选择文件。');
  pending.state = 'importing';
  try {
    const result = await importNoteDrafts(pending.drafts, options);
    pending.state = 'consumed'; return result;
  } catch (reason) { pending.state = 'ready'; throw reason; }
}

function noteMarkdown(note) {
  if (/[\u0000-\u001f\u007f]/u.test(note.title)) fail('部分便笺包含无法导出为 Markdown 的内容，请使用完整备份。');
  const document = structuredClone(note.document || textDocument(note.body));
  validateNoteDocument(document);
  function images(node) { return node.type === 'image' || node.content?.some(images); }
  if (images(document)) fail('部分便笺包含无法导出为 Markdown 的内容，请使用完整备份。');
  document.content.unshift({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: note.title }] });
  try { return toMarkdown(document, serializationOptions); }
  catch { fail('部分便笺包含无法导出为 Markdown 的内容，请使用完整备份。'); }
}
function exportName(title, used) {
  let base = title.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_').replace(/\s+/gu, ' ').replace(/[. ]+$/u, '').slice(0, 80) || 'Note';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(base)) base = `_${base}`;
  let name = `${base}.md`, suffix = 2;
  while (used.has(name.toLowerCase())) name = `${base} (${suffix++}).md`;
  used.add(name.toLowerCase()); return name;
}
export async function exportMarkdownNotes(ids, options) {
  return withExportableNotes(ids, options, (notes) => {
    // Validate the whole selection before creating even the first output file.
    const markdown = notes.map(noteMarkdown), names = new Set(), files = notes.map((note, index) => ({ name: exportName(note.title, names), bytes: encoder.encode(markdown[index]) }));
    if (files.some((file) => file.bytes.length > MARKDOWN_NOTE_LIMITS.fileBytes) || files.reduce((sum, file) => sum + file.bytes.length, 0) > MARKDOWN_NOTE_LIMITS.totalBytes) fail('Markdown 文件总大小不能超过 5 MiB。');
    if (files.length === 1) return { blob: new Blob([files[0].bytes], { type: 'text/markdown;charset=utf-8' }), filename: files[0].name };
    const archive = Object.create(null);
    for (const file of files) archive[file.name] = file.bytes;
    return { blob: new Blob([zipSync(archive, { level: 6 })], { type: 'application/zip' }), filename: 'Covelet-notes.zip' };
  });
}
