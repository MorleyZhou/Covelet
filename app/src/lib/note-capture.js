import { tr } from '../i18n/index.js';
import { NOTE_LIMITS, noteDocumentText, validateNoteDocument } from './note-document.js';
import { fromMarkdown } from '@futelab/folio/serialization';
import { getContentTags } from './content-preferences.js';

const TEXT_LIMIT = 60000;
const changed = () => Object.assign(Error(tr('页面已变化，请重新读取选文。')), { code: 'CAPTURE_CHANGED' });
const unavailable = () => Object.assign(Error(tr('无法读取页面选文，请手动输入。')), { code: 'CAPTURE_UNAVAILABLE' });
const cancelled = () => new DOMException('Aborted', 'AbortError');

function literalParagraph(body) {
  const content = [];
  body.split('\n').forEach((line, index) => {
    if (index) content.push({ type: 'hardBreak' });
    if (line) content.push({ type: 'text', text: line });
  });
  return { type: 'paragraph', ...(content.length ? { content } : {}) };
}

// Preserve existing rich blocks byte-for-byte. Legacy body-only notes use the
// same Markdown interpretation and literal fallback as the existing editor.
export function appendCapturedDocument(note, addition) {
  validateNoteDocument(addition);
  let original = note.document;
  if (!original) {
    try { original = fromMarkdown(note.body, { limits: NOTE_LIMITS }); }
    catch { original = { type: 'doc', content: [{ type: 'paragraph', ...(note.body ? { content: [{ type: 'text', text: note.body }] } : {}) }] }; }
  }
  validateNoteDocument(original);
  const document = { ...structuredClone(original), content: [...structuredClone(original.content || []), ...structuredClone(addition.content || [])] };
  validateNoteDocument(document);
  const body = noteDocumentText(document);
  if (body.length > TEXT_LIMIT || body.includes('\0')) throw Error(tr('便笺文档无效或超出大小限制。'));
  return document;
}

export function captureVisibleTags(preferences, tagIds, { locked = false, hiddenKeys } = {}) {
  const visible = new Set(getContentTags({ ...preferences, presentation: locked || preferences.presentation }, { hiddenKeys }).map((tag) => tag.id));
  return tagIds.filter((id) => visible.has(id));
}

export function captureSourceUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) throw Error();
    return url.href;
  } catch { throw unavailable(); }
}

// This function runs only after an explicit capture action. The injected
// function reads the main frame's DOM selection, never child frame contents.
export async function readSelectedPage({ api = globalThis.chrome, signal } = {}) {
  if (signal?.aborted) throw cancelled();
  if (!api?.tabs?.query || !api?.scripting?.executeScript) throw unavailable();
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id)) throw unavailable();
  const url = captureSourceUrl(tab.url);
  let stale = false;
  const updated = (id, change) => { if (id === tab.id && (change.status === 'loading' || Object.hasOwn(change, 'url'))) stale = true; };
  const removed = (id) => { if (id === tab.id) stale = true; };
  api.tabs.onUpdated?.addListener(updated);
  api.tabs.onRemoved?.addListener(removed);
  try {
    if (signal?.aborted) throw cancelled();
    const results = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] },
      func: () => ({
        text: /^(IFRAME|FRAME)$/.test(document.activeElement?.tagName || '') ? '' : String(window.getSelection()?.toString() || '').slice(0, 60001),
        title: String(document.title || '').slice(0, 200), url: location.href,
      }) });
    if (signal?.aborted) throw cancelled();
    const result = results.find((item) => item.frameId === 0)?.result;
    const latest = await api.tabs.get(tab.id);
    if (signal?.aborted) throw cancelled();
    if (stale || latest.status === 'loading' || captureSourceUrl(latest.url) !== url || !result || captureSourceUrl(result.url) !== url) throw changed();
    if (typeof result.text !== 'string' || typeof result.title !== 'string' || result.text.length > TEXT_LIMIT) {
      throw Object.assign(Error(tr('选文过长，请缩短后重新读取。')), { code: 'CAPTURE_LIMIT' });
    }
    return { text: result.text, title: result.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim(), url, tabId: tab.id };
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (stale) throw changed();
    if (error.code?.startsWith('CAPTURE_')) throw error;
    throw unavailable();
  } finally {
    api.tabs.onUpdated?.removeListener(updated);
    api.tabs.onRemoved?.removeListener(removed);
  }
}

// Selection and page titles are literal text, including HTML/Markdown-looking
// characters. Only the separately validated source URL receives a link mark.
export function captureNoteDocument({ body, pageTitle = '', sourceUrl = '' }) {
  const content = [];
  const paragraph = (text, marks) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] } : {}) });
  if (typeof body !== 'string' || !body.trim()) throw Error(tr('请填写便笺内容。'));
  // Preserve every LF as a visible hard break, including leading/trailing or
  // consecutive blank lines. CR characters stay in their literal text nodes,
  // so a CRLF input also retains its exact plain-text projection.
  content.push(literalParagraph(body));
  if (pageTitle) content.push(paragraph(pageTitle));
  if (sourceUrl) {
    const url = captureSourceUrl(sourceUrl);
    content.push(paragraph(url, [{ type: 'link', attrs: { href: url } }]));
  }
  const document = { type: 'doc', content };
  if (noteDocumentText(document).length > TEXT_LIMIT) throw Error(tr('便笺文档无效或超出大小限制。'));
  return validateNoteDocument(document);
}
