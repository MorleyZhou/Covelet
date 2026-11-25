import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createEmptyFolioDocument, defaultFolioTranslations, sanitizeFolioUrl } from '@futelab/folio/core';
import { Extension } from '@tiptap/core';
import { FolioEditor, FolioReader, SearchPanel, resolveEditorLabels, resolveBlockMenuLabels } from '@futelab/folio/react';
import { fromMarkdown } from '@futelab/folio/serialization';
import '@futelab/folio/styles.css';
import { getLocale, tr } from '../i18n/index.js';
import sources from '../i18n/folio-source.json' with { type: 'json' };
import { NOTE_LIMITS } from '../lib/note-document.js';
import { isFolioInitializationChange } from '../lib/folio-initialization.js';
import { useDialogSurface } from './DialogSurface.jsx';
import useFolioControlViewport from './use-folio-control-viewport.js';
import './folio-note.css';
import NoteSearchMatches from './NoteSearchMatches.jsx';
import * as firefoxConsent from '../lib/firefox-data-consent.js';
import { useFirefoxDataConsentState } from './FirefoxDataConsent.jsx';
import { Button } from './ui/button.jsx';

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

function localImageSource(node) {
  const src = sanitizeFolioUrl(node.attrs?.src, { kind: 'image' });
  if (!src) return '';
  try {
    const url = new URL(src, globalThis.location?.href || 'moz-extension://covelet-local/');
    return ['data:', 'moz-extension:'].includes(url.protocol) ? src : '';
  } catch { return ''; }
}
function imagePlaceholder(node) {
  return [node.attrs?.alt, node.attrs?.caption, tr('远程图片需联网授权，原图信息已保留。')].filter(Boolean).join(' — ');
}
// Keep image attrs in the actual document; restrict this editor's derived DOM
// serializer before its first EditorView is created. A plugin NodeView alone
// is too late: Tiptap installs plugin views after rendering the initial state.
function blockedImageExtensions() {
  return [{ name: 'coveletFirefoxImageConsent', tiptapExtensions: [Extension.create({
    name: 'coveletFirefoxImageConsentView',
    onBeforeCreate({ editor }) {
      editor.schema.nodes.image.spec.toDOM = node => {
        const src = localImageSource(node);
        return src ? ['img', { src, alt: node.attrs?.alt || '', class: 'folio-image' }]
          : ['span', { class: 'folio-image-consent-placeholder', contenteditable: 'false' }, imagePlaceholder(node)];
      };
    },
  })], renderers: [{ type: 'image', render(node) {
    const src = localImageSource(node);
    return src ? <figure><img src={src} alt={node.attrs?.alt || ''} />{node.attrs?.caption && <figcaption>{node.attrs.caption}</figcaption>}</figure>
      : <span className="folio-image-consent-placeholder">{imagePlaceholder(node)}</span>;
  } }] }];
}

function legacyDocument(body) {
  if (!body) return createEmptyFolioDocument();
  try { return fromMarkdown(body, { limits: NOTE_LIMITS }); }
  catch {
    // Unsupported legacy Markdown/HTML stays literal and editable. Loading a
    // note never saves a conversion or substitutes an empty document.
    return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] };
  }
}

export default function FolioNoteEditor({ document, body, documentId, preview, disabled, onInitialize, onChange, onError, searchQuery, onCloseSearch, dataConsentApi = firefoxConsent }) {
  const surface = useDialogSurface(), locale = getLocale();
  const area = useRef(null), [portalHost, setPortalHost] = useState(null);
  const consent = useFirefoxDataConsentState(dataConsentApi), allowRemoteImages = consent.allows('reading');
  const [permissionBusy, setPermissionBusy] = useState(false), [permissionMessage, setPermissionMessage] = useState(''), mounted = useRef(true), requesting = useRef(false);
  const imageExtensions = useMemo(() => allowRemoteImages ? undefined : blockedImageExtensions(), [allowRemoteImages, locale]);
  const clipboard = useMemo(() => allowRemoteImages ? undefined : { defaultPaste: 'plain-text' }, [allowRemoteImages]);
  useFolioControlViewport(area, portalHost);
  const value = useMemo(() => document || legacyDocument(body), [document, body]);
  const translations = useMemo(() => ({ [locale]: translateLabels(defaultFolioTranslations['zh-CN']) }), [locale]);
  const labels = useMemo(() => translateLabels(resolveEditorLabels('zh-CN')), [locale]);
  const blockMenuLabels = useMemo(() => translateLabels(resolveBlockMenuLabels('zh-CN')), [locale]);
  useEffect(() => { if (!document) onInitialize(value); }, [document, value, onInitialize]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function requestImages() {
    if (disabled || requesting.current || !consent.state?.supported) return;
    let result;
    try { result = dataConsentApi.requestFirefoxDataConsent('reading'); }
    catch { setPermissionMessage(tr('未授予此项授权；本机内容、便笺和手动备份仍可使用。')); return; }
    requesting.current = true; setPermissionBusy(true); setPermissionMessage('');
    Promise.resolve(result).then(async granted => {
      if (!mounted.current) return;
      if (!granted) setPermissionMessage(tr('未授予此项授权；本机内容、便笺和手动备份仍可使用。'));
      await consent.refresh();
    }).catch(() => { if (mounted.current) setPermissionMessage(tr('未授予此项授权；本机内容、便笺和手动备份仍可使用。')); })
      .finally(() => { requesting.current = false; if (mounted.current) setPermissionBusy(false); });
  }
  return <><div ref={area} className="folio-note-area" role="region" aria-label={tr('便笺内容')}>
    {consent.firefox && !allowRemoteImages && <div className="folio-image-consent-notice"><p className="hint">{tr('未授权时仅显示本机图片；文字仍可编辑，粘贴使用纯文本。')}</p>
      <Button type="button" variant="ghost" size="sm" disabled={disabled || permissionBusy || !consent.state?.supported} onClick={requestImages}>{tr('允许便笺图片联网')}</Button>
      {permissionMessage && <p className="hint" role="status">{permissionMessage}</p>}
    </div>}
    {searchQuery !== null && searchQuery !== undefined && <NoteSearchMatches rootRef={area} query={searchQuery} active={!disabled} onClose={onCloseSearch} />}
    <div className="folio-note-edit-panel" hidden={preview}>
      <FolioEditor key={allowRemoteImages ? 'images-allowed' : 'images-blocked'} className="folio-note-editor" documentId={documentId} value={value} extensions={imageExtensions} clipboard={clipboard} onChange={(next) => { if (!isFolioInitializationChange(value, next)) onChange(next); }}
        editable={!disabled && !preview} placeholder={tr('开始记录…')} locale={locale} translations={translations}
        labels={labels} blockMenuLabels={blockMenuLabels} components={components} ui={ui}
        portalContainer={portalHost || surface} onError={onError} />
    </div>
    {preview && <div className="folio-note-reader">
      <FolioReader value={value} extensions={imageExtensions} limits={NOTE_LIMITS} headingIdPrefix={`note-${documentId}`}
        renderError={() => <p className="form-error" role="alert">{tr('便笺文档无效或超出大小限制。')}</p>} />
    </div>}
  </div>{surface && createPortal(<div className="folio-note-portals" ref={setPortalHost} />, surface)}</>;
}
