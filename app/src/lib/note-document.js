import { createFolioDocumentValidator } from '@futelab/folio/core';
import { tr } from '../i18n/index.js';

export const NOTE_LIMITS = Object.freeze({ maxDepth: 24, maxNodes: 2000, maxTextLength: 60000, maxAttributeValues: 12000 });
const MAX_BYTES = 512 * 1024, encoder = new TextEncoder();
let validator;

export function validateNoteDocument(document) {
  validator ??= createFolioDocumentValidator({ limits: NOTE_LIMITS });
  if (!validator.validate(document).valid || encoder.encode(JSON.stringify(document)).length > MAX_BYTES) {
    throw Error(tr('便笺文档无效或超出大小限制。'));
  }
  return document;
}

// Keep a plain-text projection for the existing WASM search/statistics and
// desktop excerpt. Rich formatting is preserved in the separate JSON field.
export function noteDocumentText(document) {
  function text(node) {
    if (node.type === 'text') return node.text || '';
    if (node.type === 'hardBreak' || node.type === 'horizontalRule') return '\n';
    if (node.type === 'image') return [node.attrs?.alt, node.attrs?.caption].filter(Boolean).join(' ');
    if (node.type === 'bookmark') return [node.attrs?.title || node.attrs?.url, node.attrs?.description].filter(Boolean).join('\n');
    if (node.type === 'mention') return `@${node.attrs?.label || node.attrs?.id || ''}`;
    const separator = ['doc', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'blockquote', 'callout', 'details', 'detailsContent', 'table', 'tableCell', 'tableHeader', 'columns', 'column'].includes(node.type) ? '\n' : node.type === 'tableRow' ? '\t' : '';
    return (node.content || []).map(text).join(separator);
  }
  return text(document);
}
