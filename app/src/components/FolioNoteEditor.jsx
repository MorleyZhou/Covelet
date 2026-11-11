import { useEffect, useMemo } from 'react';
import { createEmptyFolioDocument, defaultFolioTranslations } from '@futelab/folio/core';
import { FolioEditor, FolioReader, SearchPanel, resolveEditorLabels, resolveBlockMenuLabels } from '@futelab/folio/react';
import { fromMarkdown } from '@futelab/folio/serialization';
import '@futelab/folio/styles.css';
import { getLocale, tr } from '../i18n/index.js';
import sources from '../i18n/folio-source.json' with { type: 'json' };
import { NOTE_LIMITS } from '../lib/note-document.js';
import { isFolioInitializationChange } from '../lib/folio-initialization.js';
import { useDialogSurface } from './DialogSurface.jsx';
import './folio-note.css';

// Translate only Folio's trusted interface labels, never document nodes.
function translateLabels(value, key) {
  if (key === 'keywords') return value;
  if (typeof value === 'string') return tr(value);
  if (Array.isArray(value)) return value.map((item) => translateLabels(item));
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, translateLabels(item, name)]));
}
function NoteSearch(props) {
  return <SearchPanel {...props} labels={translateLabels(sources.search)} />;
}
const components = Object.freeze({ searchPanel: NoteSearch });
const ui = Object.freeze({ toolbar: false });

function legacyDocument(body) {
  if (!body) return createEmptyFolioDocument();
  try { return fromMarkdown(body, { limits: NOTE_LIMITS }); }
  catch {
    // Unsupported legacy Markdown/HTML stays literal and editable. Loading a
    // note never saves a conversion or substitutes an empty document.
    return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] };
  }
}

export default function FolioNoteEditor({ document, body, documentId, preview, disabled, onInitialize, onChange, onError }) {
  const surface = useDialogSurface(), locale = getLocale();
  const value = useMemo(() => document || legacyDocument(body), [document, body]);
  const translations = useMemo(() => ({ [locale]: translateLabels(defaultFolioTranslations['zh-CN']) }), [locale]);
  const labels = useMemo(() => translateLabels(resolveEditorLabels('zh-CN')), [locale]);
  const blockMenuLabels = useMemo(() => translateLabels(resolveBlockMenuLabels('zh-CN')), [locale]);
  useEffect(() => { if (!document) onInitialize(value); }, [document, value, onInitialize]);
  return <div className="folio-note-area" role="region" aria-label={tr('便笺内容')}>
    <div className="folio-note-edit-panel" hidden={preview}>
      <FolioEditor className="folio-note-editor" documentId={documentId} value={value} onChange={(next) => { if (!isFolioInitializationChange(value, next)) onChange(next); }}
        editable={!disabled && !preview} placeholder={tr('开始记录…')} locale={locale} translations={translations}
        labels={labels} blockMenuLabels={blockMenuLabels} components={components} ui={ui}
        portalContainer={surface} onError={onError} />
    </div>
    {preview && <div className="folio-note-reader">
      <FolioReader value={value} limits={NOTE_LIMITS} headingIdPrefix={`note-${documentId}`}
        renderError={() => <p className="form-error" role="alert">{tr('便笺文档无效或超出大小限制。')}</p>} />
    </div>}
  </div>;
}
