import { tr, getLocale, builtinName, formatNumber } from "../i18n/index.js";
import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PresentationContext, usePresentedTools } from '../lib/presentation.js';
import { createPortal } from 'react-dom';
import { NotePencil, BookOpen, Plus, Trash, PencilSimple, Check, Archive, ArrowSquareOut, Copy, PushPin, DownloadSimple, UploadSimple, MagnifyingGlass, SquaresFour } from '@phosphor-icons/react';
import Select from './Select.jsx';
import { WIDGET_NAMES, WIDGET_SIZE_OPTIONS, validateWidgetConfig } from '../lib/widget-model.js';
import usePersonalTools from '../lib/use-personal-tools.js';
import { saveNote, saveReadingItem, bulkReadingItems, deletePersonalRecord, exportPersonalTools, importPersonalTools, restoreTrashedPersonalRecord, permanentlyDeletePersonalTrash, emptyPersonalTrash } from '../lib/personal-tools.js';
import { validateNoteDocument, noteDocumentText } from '../lib/note-document.js';
import FolioNoteEditor from './FolioNoteEditor.jsx';
import PromptDialog, { MessageDialog } from './PromptDialog.jsx';
import { PrivacyPasswordForm } from './PrivacyPassword.jsx';
import { DialogSurface } from './DialogSurface.jsx';
import './personal-tools.css';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Disclosure } from './ui/disclosure.jsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs.jsx';
import { userErrorMessage } from '../lib/user-error.js';
import { loadState } from '../lib/storage.js';
import { desktopDestinationValue } from '../lib/navigation-destinations.js';
import { copyReadingToNavigation } from '../lib/reading-to-navigation.js';
import NavigationDestination from './NavigationDestination.jsx';
import { getContentMetadata, getContentTags, useContentPreferences } from '../lib/content-preferences.js';
import ContentMetadataEditor, { ContentTagFilter } from './ContentMetadataEditor.jsx';
import { isReadingDue } from '../lib/reading-revisit.js';
import { useLocalDateKey } from '../lib/use-local-date.js';

const newest = (items) => [...items].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
const stop = (event) => event.stopPropagation();
const formatDate = (value) => new Date(value).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const formatReadingDay = (value) => new Date(`${value}T00:00:00Z`).toLocaleDateString(getLocale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const READING_PAGE_SIZE = 50;
const emptyMetadata = () => ({ description: '', tagIds: [] });
const sameMetadata = (left, right) => left.description === right.description
  && left.tagIds.length === right.tagIds.length && left.tagIds.every((id) => right.tagIds.includes(id));
const matchesTags = (metadata, selected) => selected.every((id) => metadata.tagIds.includes(id));
function ContentTagLabels({ tags, tagIds }) {
  const selected = tags.filter((tag) => tagIds.includes(tag.id));
  return selected.length ? <span className="personal-content-tags" aria-label={tr('标签')}>{selected.map((tag) => <span key={tag.id}>{tag.name}</span>)}</span> : null;
}
function useAction(onBusyChange) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), active = useRef(true), gate = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function run(action) {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError(''); onBusyChange?.(true);
    try { return await action(); }
    catch (reason) { if (active.current) setError(userErrorMessage(reason)); }
    finally { gate.current = false; if (active.current) { setBusy(false); onBusyChange?.(false); } }
  }
  return { run, busy, error, setError };
}
function Confirm({ children, onCancel, onConfirm, busy, confirmDisabled, privacySafe = false, action = tr("删除") }) {
  return <PromptDialog title={action} action={action} onCancel={onCancel} onConfirm={onConfirm} busy={busy} confirmDisabled={confirmDisabled} privacySafe={privacySafe} destructive={action === tr('删除') || action === tr('放弃修改')}><p>{children}</p></PromptDialog>;
}
const trashPrivacyKey = (item) => item.kind === 'notes' ? `note:${item.record.id}` : item.kind === 'reading' ? `reading:${item.record.id}` : null;
// Keep the editor and its floating controls mounted when only its record is
// hidden. The surrounding list and public tool actions remain independent.
function PrivateEditor({ hidden, busy, onBusyChange, onDiscard, className = '', children }) {
  const [surface, setSurface] = useState(null);
  return <div className={`personal-record-editor ${className}`}>
    {hidden && <div className="personal-record-shield"><p className="hint">{tr('此内容已隐藏，解锁后可继续编辑，未保存的修改会保留。')}</p>
      <PrivacyPasswordForm purpose="unlock" disabled={busy} Heading="h3" onBusyChange={onBusyChange} />
      {onDiscard && <Button variant="ghost" type="button" disabled={busy} onClick={onDiscard}>{tr('放弃修改')}</Button>}</div>}
    <DialogSurface.Provider value={surface}>
      <div ref={setSurface} className="personal-record-preserved" style={{ display: hidden ? 'none' : 'contents' }} inert={hidden || undefined} aria-hidden={hidden || undefined}>{children}</div>
    </DialogSurface.Provider>
  </div>;
}
export function PersonalToolsTrash({ data, run, busy = false, standalone = false }) {
  const presentation = useContext(PresentationContext), [prompt, setPrompt] = useState(null);
  const hidden = (key) => presentation.active && key && presentation.hiddenKeys.has(key);
  const items = [...(data?.trash || [])].filter((item) => ['notes', 'reading'].includes(item.kind) && !hidden(trashPrivacyKey(item))).sort((a, b) => b.deletedAt - a.deletedAt || a.id.localeCompare(b.id));
  const emptyIds = prompt?.kind === 'empty' ? prompt.items.filter((item) => !hidden(item.privacyKey)).map((item) => item.id) : [];
  const content = <>
    <p>{tr('删除的便笺和稍后读保留 30 天，最多 200 条。')}</p>
    <div className="personal-trash-header"><span>{tr('{0} 条记录', [formatNumber(items.length)])}</span><Button variant="ghost" type="button" disabled={busy || !items.length} onClick={() => setPrompt({ kind: 'empty', revision: data.revision, items: items.map((item) => ({ id: item.id, privacyKey: trashPrivacyKey(item) })) })}>{tr('清空回收站')}</Button></div>
    <div className="personal-trash-list" aria-label={tr('回收站')}>{items.map((item) => <div className="personal-trash-record" key={item.id}>
      <div><strong>{item.record.title}</strong><small>{item.kind === 'notes' ? tr('便笺') : tr('稍后读')} · {tr('删除于 {0}', [formatDate(item.deletedAt)])}</small></div>
      <Button variant="ghost" type="button" disabled={busy} onClick={() => run(() => restoreTrashedPersonalRecord(item.id, { expectedRevision: data.revision }))}>{tr('恢复')}</Button>
      <Button variant="ghost" type="button" disabled={busy} aria-label={tr('永久删除“{0}”', [item.record.title])} onClick={() => setPrompt({ kind: 'delete', id: item.id, title: item.record.title, privacyKey: trashPrivacyKey(item), revision: data.revision })}><Trash size={16} /></Button>
    </div>)}{!items.length && <p className="tool-empty">{tr('回收站为空')}</p>}</div>
    {prompt && !hidden(prompt.privacyKey) && <PromptDialog title={prompt.kind === 'empty' ? tr('清空回收站') : tr('永久删除')} action={tr('永久删除')} destructive busy={busy} confirmDisabled={prompt.kind === 'empty' && !emptyIds.length} onCancel={() => setPrompt(null)} onConfirm={() => run(async () => {
      if (prompt.kind === 'empty') await emptyPersonalTrash({ expectedRevision: prompt.revision, ids: emptyIds });
      else await permanentlyDeletePersonalTrash(prompt.id, { expectedRevision: prompt.revision });
      setPrompt(null);
    })}><p>{prompt.kind === 'empty' ? presentation.active ? tr('永久删除当前可见的回收站记录？此操作无法撤销。') : tr('永久删除回收站中的所有记录？此操作无法撤销。') : tr('永久删除“{0}”？此操作无法撤销。', [prompt.title])}</p></PromptDialog>}
  </>;
  return standalone ? <section className="personal-trash" aria-label={tr('回收站')}>{content}</section>
    : <Disclosure className="personal-trash" title={tr('回收站')}>{content}</Disclosure>;
}
export function PersonalToolsTrashPanel({ onBusyChange, disabled = false }) {
  const { data, error } = usePersonalTools({ loadCore: false }), action = useAction(onBusyChange);
  return <>
    <PersonalToolsTrash data={disabled ? null : data} run={action.run} busy={disabled || action.busy} standalone />
    {(error || action.error) && <p className="form-error" role="alert">{userErrorMessage(error || action.error)}</p>}
  </>;
}
function ToolDataActions({ data, run, busy, onImported }) {
  const input = useRef(null);
  return <Disclosure className="tool-data-actions" title={tr("备份与回收站")}><div className="tool-data-buttons">
    <Button variant="ghost" type="button" className="button quiet" disabled={busy} onClick={() => run(async () => {
      const blob = await exportPersonalTools(), url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = `Covelet-tools-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    })}><DownloadSimple size={16} />{tr("导出")}</Button>
    <Button variant="ghost" type="button" className="button quiet" disabled={busy} onClick={() => input.current?.click()}><UploadSimple size={16} />{tr("导入")}</Button>
    <Input ref={input} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) run(async () => { await importPersonalTools(file); onImported?.(); }); }} />
    </div><p>{tr('导入备份不会覆盖已有记录。')}</p><PersonalToolsTrash data={data} run={run} busy={busy} /></Disclosure>;
}

export function PersonalWidgetSettings({ extensionId, entry, introduction, onUse, onBusyChange }) {
  const [size, setSize] = useState(entry?.config.size || 'small'), action = useAction(onBusyChange);
  return <form className="form-stack widget-config-form" onSubmit={(event) => { event.preventDefault(); action.run(() => onUse(validateWidgetConfig(extensionId, { size }), entry, extensionId)); }}>
    <div className="settings-scroll form-stack">{introduction}<Select label={tr("尺寸")} value={size} onChange={setSize} disabled={action.busy} options={WIDGET_SIZE_OPTIONS} />
      <p className="hint">{tr('移除组件不会删除内容。')}</p><MessageDialog message={action.error} onClose={() => action.setError('')} /></div>
    <div className="settings-footer"><Button variant="default" type="submit" className="button primary" disabled={action.busy}>{entry && !entry.detached ? tr("保存") : tr("使用")}</Button></div>
  </form>;
}
export function PersonalWidgetPreview({ extensionId }) {
  const Icon = extensionId === 'notes' ? NotePencil : BookOpen;
  return <figure className={`personal-widget-preview ${extensionId}`} aria-label={tr("{0}预览", [WIDGET_NAMES[extensionId]])}><Icon size={32} /><strong>{WIDGET_NAMES[extensionId]}</strong></figure>;
}
export default function PersonalWidget({ entry, open, onOpen, onClose, Dialog, portalTarget }) {
  const { data: rawData } = usePersonalTools(), data = usePresentedTools(rawData);
  const [dirty, setDirty] = useState(false), [discard, setDiscard] = useState(false), [busy, setBusy] = useState(false);
  const notes = entry.extensionId === 'notes', items = newest(data?.[notes ? 'notes' : 'reading'] || []);
  const visible = notes ? items : items.filter((item) => item.status === 'unread');
  const Icon = notes ? NotePencil : BookOpen, mini = entry.config.size === 'mini';
  useEffect(() => { if (!open) { setDirty(false); setDiscard(false); } }, [open]);
  const close = () => { if (busy) return; if (dirty) setDiscard(true); else onClose(); };
  return <>
    <Button variant="unstyled" size="unstyled" type="button" data-widget-launcher data-widget-surface id={`widget-title-${entry.id}`} className={`personal-widget personal-widget-${entry.config.size} personal-widget-${entry.extensionId}`}
      aria-haspopup="dialog" aria-expanded={open} aria-label={tr("{0}，{1}，打开", [builtinName(entry.extensionId, entry.name), notes ? tr("{0} 条便笺", [formatNumber(items.length)]) : tr("{0} 条未读", [formatNumber(visible.length)])])} onClick={onOpen}>
      <span className="personal-widget-heading"><Icon size={mini ? 25 : 20} /><span>{notes ? tr("便笺") : tr("未读")}</span><b>{formatNumber(notes ? items.length : visible.length)}</b></span>
      {!mini && <span className="personal-widget-body">{notes ? visible[0] ? <><strong>{visible[0].title}</strong><span className="personal-note-excerpt">{visible[0].body}</span></> : <span className="personal-widget-empty">{tr("记下此刻的想法")}</span>
        : visible.length ? visible.slice(0, entry.config.size === 'large' ? 7 : 3).map((item) => <span className="personal-reading-preview" key={item.id}><strong>{item.title}</strong><small>{new URL(item.url).hostname}</small></span>) : <span className="personal-widget-empty">{tr("没有未读链接")}</span>}</span>}
    </Button>
    {open && Dialog && portalTarget && createPortal(<div className="personal-dialog-layer" onContextMenu={stop} onKeyDown={stop} onPointerDown={stop} onPointerMove={stop} onPointerUp={stop}>
      <Dialog title={builtinName(entry.extensionId, entry.name)} privacyKeys={[`widget:${entry.id}`]} onClose={close} closeDisabled={busy} className="personal-tools-modal" wide maximizable>
        {discard && <Confirm privacySafe busy={busy} action={tr("放弃修改")} onCancel={() => setDiscard(false)} onConfirm={onClose}>{tr('当前内容尚未保存，放弃修改？')}</Confirm>}
        {notes ? <NotesTools onDirtyChange={setDirty} onBusyChange={setBusy} /> : <ReadingTools Dialog={Dialog} onBusyChange={setBusy} onDirtyChange={setDirty} />}
      </Dialog></div>, portalTarget)}
  </>;
}

export function PersonalToolsDialog({ kind, initialRecordId, Dialog, onClose }) {
  const [dirty, setDirty] = useState(false), [discard, setDiscard] = useState(false), [busy, setBusy] = useState(false);
  return <Dialog title={kind === 'note' ? tr('便笺') : tr('稍后读')} closeDisabled={busy} wide maximizable className="personal-tools-modal"
    onClose={() => { if (!busy) { if (dirty) setDiscard(true); else onClose(); } }}>
    {discard && <Confirm privacySafe busy={busy} action={tr('放弃修改')} onCancel={() => setDiscard(false)} onConfirm={onClose}>{tr('当前内容尚未保存，放弃修改？')}</Confirm>}
    {kind === 'note' ? <NotesTools initialRecordId={initialRecordId} onDirtyChange={setDirty} onBusyChange={setBusy} /> : <ReadingTools Dialog={Dialog} initialRecordId={initialRecordId} onDirtyChange={setDirty} onBusyChange={setBusy} />}
  </Dialog>;
}

function NotesTools({ onDirtyChange, onBusyChange, initialRecordId }) {
  const { data: rawData, core, error: loadError } = usePersonalTools(), action = useAction(), data = usePresentedTools(rawData), presentation = useContext(PresentationContext);
  const contentPreferences = useContentPreferences(), preferences = contentPreferences.data;
  const locked = presentation.active || preferences.presentation;
  const [unlocking, setUnlocking] = useState(false), [metadataBusy, setMetadataBusy] = useState(false);
  const [draft, setDraft] = useState({ title: '', body: '', pinned: false }), [dirty, setDirty] = useState(false), [query, setQuery] = useState('');
  const [metadata, setMetadata] = useState(emptyMetadata), [originalMetadata, setOriginalMetadata] = useState(emptyMetadata);
  const [selectedTagIds, setSelectedTagIds] = useState([]);
  const [preview, setPreview] = useState(false), [pending, setPending] = useState(null), [deleting, setDeleting] = useState(false);
  const [editorKey, setEditorKey] = useState(() => crypto.randomUUID());
  const hidden = (key) => locked && (presentation.hiddenKeys.has(key) || preferences.privateKeys.includes(key));
  const notes = newest(data?.notes || []).filter((item) => !hidden(`note:${item.id}`)), latest = rawData?.notes.find((item) => item.id === draft.id);
  const draftHidden = Boolean(draft.id) && hidden(`note:${draft.id}`);
  const metadataFor = (key) => getContentMetadata({ ...preferences, presentation: locked }, key, { hiddenKeys: presentation.hiddenKeys });
  const visibleTags = getContentTags({ ...preferences, presentation: locked }, { hiddenKeys: presentation.hiddenKeys });
  const changedElsewhere = draft.id && (!latest || latest.revision !== draft.revision
    || contentPreferences.ready && !draftHidden && !sameMetadata(metadataFor(`note:${draft.id}`), originalMetadata));
  const busy = action.busy || unlocking || metadataBusy;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const select = (note) => {
    const nextMetadata = note ? metadataFor(`note:${note.id}`) : emptyMetadata();
    setEditorKey(note?.id || crypto.randomUUID()); setDraft(note ? { ...note } : { title: '', body: '', pinned: false });
    setMetadata(nextMetadata); setOriginalMetadata(nextMetadata);
    setDirty(false); setPreview(false); setPending(null); setDeleting(false); action.setError('');
  };
  const selectedInitial = useRef(null);
  useEffect(() => {
    if (!initialRecordId || !data || !contentPreferences.ready || selectedInitial.current === initialRecordId) return;
    selectedInitial.current = initialRecordId;
    const record = data.notes.find((item) => item.id === initialRecordId);
    if (record) select(record); else action.setError(tr('这条记录已被移除。'));
  }, [initialRecordId, data, contentPreferences.ready]);
  const choose = (note) => dirty ? setPending({ note }) : select(note);
  const reopen = () => { if (dirty) setPending({ note: latest || null }); else select(latest || null); };
  const patch = (value) => { setDraft((current) => ({ ...current, ...value })); setDirty(true); };
  const matches = notes.filter((note) => matchesTags(metadataFor(`note:${note.id}`), selectedTagIds)
    && (!query || core?.contains(`${note.title}\n${note.body}`, query)));
  const availableTagIds = [...new Set(notes.flatMap((note) => metadataFor(`note:${note.id}`).tagIds))];
  const documentError = useMemo(() => {
    try {
      if (draft.document) validateNoteDocument(draft.document);
      if (draft.body.length > 60000 || draft.body.includes('\0')) throw Error(tr('便笺文档无效或超出大小限制。'));
      return '';
    } catch (reason) { return userErrorMessage(reason, tr('这条便笺无法读取，请从备份恢复。')); }
  }, [draft.document, draft.body]);
  const metrics = useMemo(() => {
    if (documentError || !core) return null;
    try { return core.metrics(draft.body); } catch { return null; }
  }, [core, draft.body, documentError]);
  return <div className="personal-tools-body notes-tools-body">
    <div className="personal-tools-toolbar"><div className="tool-search"><MagnifyingGlass size={16} /><Input unstyled aria-label={tr("搜索便笺")} placeholder={tr("搜索便笺")} value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} /></div><Button variant="secondary" type="button" className="button" disabled={busy || !contentPreferences.ready} onClick={() => choose(null)}><Plus size={17} />{tr("新便笺")}</Button></div>
    <ContentTagFilter preferences={preferences} availableTagIds={availableTagIds} selectedTagIds={selectedTagIds} onChange={setSelectedTagIds} disabled={busy || !contentPreferences.ready} />
    <MessageDialog message={loadError || contentPreferences.error || action.error || (!draftHidden && (documentError || (!busy && changedElsewhere ? tr('这条便笺已在其他页面更新。') : '')))} onClose={() => action.setError('')} />
    {pending && <Confirm privacySafe action={tr("放弃修改")} busy={busy} onCancel={() => setPending(null)} onConfirm={() => select(pending.note)}>{tr("当前便笺尚未保存，放弃修改？")}</Confirm>}
    <div className="notes-workspace"><div className="tool-record-list" aria-label={tr("便笺列表")}>{matches.map((note) => <Button variant="unstyled" size="unstyled" type="button" key={note.id} aria-pressed={draft.id === note.id} disabled={busy || !contentPreferences.ready} onClick={() => choose(note)}><strong>{note.pinned && <PushPin size={12} weight="fill" />}{note.title}</strong><span>{note.body.slice(0, 90) || tr("空白便笺")}</span><ContentTagLabels tags={visibleTags} tagIds={metadataFor(`note:${note.id}`).tagIds} /><small>{formatDate(note.updatedAt)}</small></Button>)}{!matches.length && <p className="tool-empty">{query || selectedTagIds.length ? tr("没有找到便笺") : tr("暂无便笺")}</p>}</div>
    <PrivateEditor hidden={draftHidden} busy={busy} onBusyChange={setUnlocking}><form className="note-editor" onKeyDownCapture={(event) => {
      if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 && (event.ctrlKey || event.metaKey) && event.key === 'Enter'
        && event.target.closest('[contenteditable="true"], .note-title-input') && !event.target.closest('[role="dialog"]:not([data-ui-modal]), [role="alertdialog"]')) {
        event.preventDefault(); event.stopPropagation(); event.currentTarget.requestSubmit();
      }
    }} onSubmit={(event) => {
      event.preventDefault();
      if (!data || !core || !contentPreferences.ready || busy || draftHidden || !dirty || changedElsewhere || documentError) return;
      action.run(async () => {
        const saved = await saveNote(draft, { metadata, expectedPreferencesRevision: preferences.revision, expectedMetadata: originalMetadata });
        setDraft(saved); setOriginalMetadata(metadata); setDirty(false);
      });
    }}>
      <label className="visually-hidden" htmlFor="note-title">{tr("便笺名称")}</label><Input unstyled id="note-title" className="note-title-input" value={draft.title} placeholder={tr("未命名便笺")} maxLength={200} disabled={busy} onChange={(event) => patch({ title: event.target.value })} />
      <div className="note-editor-actions"><Button variant="ghost" type="button" className="button quiet" disabled={busy} aria-pressed={draft.pinned} onClick={() => patch({ pinned: !draft.pinned })}><PushPin size={16} weight={draft.pinned ? 'fill' : 'regular'} />{tr("置顶")}</Button>
        <Button variant="ghost" type="button" className="button quiet" disabled={busy} aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? tr("编辑") : tr("预览")}</Button>
        <Button variant="ghost" type="button" className="button quiet" disabled={!draft.body || busy} onClick={() => action.run(async () => { try { await navigator.clipboard.writeText(draft.document ? noteDocumentText(draft.document) : draft.body); } catch { throw Error(tr("无法复制，请手动选择文字。")); } })} aria-label={tr("复制便笺")}><Copy size={16} /></Button></div>
      <ContentMetadataEditor preferences={preferences} contentKey={draft.id ? `note:${draft.id}` : undefined} value={metadata}
        onChange={(value) => { setMetadata(value); setDirty(true); }} disabled={action.busy || unlocking || draftHidden || !contentPreferences.ready} allowDescription={false} onBusyChange={setMetadataBusy} />
      <FolioNoteEditor key={editorKey} documentId={editorKey} document={draft.document} body={draft.body} preview={preview} disabled={busy || draftHidden}
        onInitialize={(document) => setDraft((current) => current.document ? current : { ...current, document, body: noteDocumentText(document) })}
        onChange={(document) => patch({ document, body: noteDocumentText(document) })} onError={(reason) => action.setError(userErrorMessage(reason, tr('便笺未能保存，请重试。')))} />
      {deleting && !draftHidden && <Confirm busy={busy} onCancel={() => setDeleting(false)} onConfirm={() => action.run(async () => { await deletePersonalRecord('notes', draft.id, draft.revision); select(null); })}>{tr("删除“{0}”？", [draft.title])}</Confirm>}
      <div className="note-editor-footer"><small>{tr("{0} 字符", [formatNumber(metrics?.characters ?? draft.body.length)])}</small>{draft.id && <Button variant="ghost" type="button" className="button quiet" disabled={busy} onClick={() => setDeleting(true)} aria-label={tr("删除便笺")}><Trash size={16} /></Button>}<Button variant="default" type={changedElsewhere ? 'button' : 'submit'} className="button primary" onClick={changedElsewhere ? reopen : undefined} disabled={!data || !core || !contentPreferences.ready || busy || !changedElsewhere && (!dirty || Boolean(documentError))}>{changedElsewhere ? tr('重新打开') : tr("保存")}</Button></div>
    </form></PrivateEditor></div><ToolDataActions data={rawData} run={action.run} busy={busy} />
  </div>;
}

function ReadingTools({ Dialog, onBusyChange, onDirtyChange, initialRecordId }) {
  const { data: rawData, core, error: loadError } = usePersonalTools(), action = useAction(), data = usePresentedTools(rawData), presentation = useContext(PresentationContext);
  const contentPreferences = useContentPreferences(), preferences = contentPreferences.data;
  const locked = presentation.active || preferences.presentation;
  const [unlocking, setUnlocking] = useState(false), [metadataBusy, setMetadataBusy] = useState(false);
  const [filter, setFilter] = useState('unread'), [query, setQuery] = useState(''), [draft, setDraft] = useState({ title: '', url: '' }), [deleting, setDeleting] = useState(null);
  const [metadata, setMetadata] = useState(emptyMetadata), [originalMetadata, setOriginalMetadata] = useState(emptyMetadata);
  const [selectedTagIds, setSelectedTagIds] = useState([]), [discarding, setDiscarding] = useState(null);
  const [copy, setCopy] = useState(null), [copyStatus, setCopyStatus] = useState('');
  const [queryRecordId, setQueryRecordId] = useState(null);
  const today = useLocalDateKey(), revisitInputId = useId(), listRef = useRef(null);
  const [page, setPage] = useState(0), [selectionMode, setSelectionMode] = useState(false), [selected, setSelected] = useState({});
  const [bulkAction, setBulkAction] = useState('read'), [bulkDelete, setBulkDelete] = useState(null), [bulkStatus, setBulkStatus] = useState('');
  const hidden = (key) => locked && (presentation.hiddenKeys.has(key) || preferences.privateKeys.includes(key));
  const draftHidden = Boolean(draft.id) && hidden(`reading:${draft.id}`);
  const deletionHidden = Boolean(deleting) && hidden(`reading:${deleting.id}`);
  const copyHidden = copy && hidden(`reading:${copy.record.id}`);
  const queryHidden = Boolean(queryRecordId) && hidden(`reading:${queryRecordId}`);
  const visibleQuery = queryHidden ? '' : query;
  const metadataFor = (key) => getContentMetadata({ ...preferences, presentation: locked }, key, { hiddenKeys: presentation.hiddenKeys });
  const visibleTags = getContentTags({ ...preferences, presentation: locked }, { hiddenKeys: presentation.hiddenKeys });
  const latest = rawData?.reading.find((item) => item.id === draft.id);
  const changedElsewhere = draft.id && (!latest || latest.revision !== draft.revision
    || contentPreferences.ready && !draftHidden && !sameMetadata(metadataFor(`reading:${draft.id}`), originalMetadata));
  const draftHasContent = Boolean(draft.url || draft.title || draft.revisitOn || metadata.description || metadata.tagIds.length);
  const busy = action.busy || unlocking || metadataBusy;
  function select(record) {
    const nextMetadata = record ? metadataFor(`reading:${record.id}`) : emptyMetadata();
    setDraft(record ? { ...record } : { title: '', url: '' });
    setMetadata(nextMetadata); setOriginalMetadata(nextMetadata); action.setError('');
  }
  const selectedInitial = useRef(null);
  useEffect(() => {
    if (!initialRecordId || !data || selectedInitial.current === initialRecordId) return;
    selectedInitial.current = initialRecordId;
    const record = data.reading.find((item) => item.id === initialRecordId);
    if (record) { setFilter(record.status); setQuery(record.title); setQueryRecordId(record.id); } else action.setError(tr('这条记录已被移除。'));
  }, [initialRecordId, data]);
  useEffect(() => { onDirtyChange(draftHasContent); }, [draftHasContent, onDirtyChange]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if (queryRecordId && hidden(`reading:${queryRecordId}`)) { setQuery(''); setQueryRecordId(null); }
  }, [queryRecordId, locked, presentation.hiddenKeys, preferences.privateKeys]);
  const visibleRecords = newest(data?.reading || []).filter((item) => !hidden(`reading:${item.id}`));
  const records = visibleRecords.filter((item) => (filter === 'due' ? isReadingDue(item, today) : item.status === filter) && matchesTags(metadataFor(`reading:${item.id}`), selectedTagIds)
    && (!visibleQuery || core?.contains(`${item.title}\n${item.url}\n${metadataFor(`reading:${item.id}`).description}`, visibleQuery)));
  if (filter === 'due') records.sort((a, b) => a.revisitOn.localeCompare(b.revisitOn) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const availableTagIds = [...new Set(visibleRecords.flatMap((item) => metadataFor(`reading:${item.id}`).tagIds))];
  const pageCount = Math.max(1, Math.ceil(records.length / READING_PAGE_SIZE)), currentPage = Math.min(page, pageCount - 1);
  const pageRecords = records.slice(currentPage * READING_PAGE_SIZE, (currentPage + 1) * READING_PAGE_SIZE);
  const selectedIds = Object.keys(selected).filter((id) => !hidden(`reading:${id}`));
  const selectionStale = selectedIds.some((id) => !rawData?.reading.some((item) => item.id === id && item.revision === selected[id]));
  const pageSelected = pageRecords.filter((item) => Object.hasOwn(selected, item.id)).length;
  const bulkVisible = bulkDelete && bulkDelete.ids.every((id) => !hidden(`reading:${id}`));
  const bulkValid = bulkVisible && rawData?.revision === bulkDelete.expectedRevision && preferences.revision === bulkDelete.expectedPreferencesRevision
    && bulkDelete.ids.every((id) => rawData.reading.some((item) => item.id === id && item.revision === bulkDelete.expectedRecordRevisions[id]));
  const selectedTagKey = selectedTagIds.join('\0');
  useEffect(() => {
    setSelected((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !hidden(`reading:${id}`))));
  }, [locked, presentation.hiddenKeys, preferences.privateKeys]);
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; }, [filter, visibleQuery, selectedTagKey, currentPage]);
  function clearSelection() { setSelected({}); setBulkDelete(null); setBulkStatus(''); }
  function changeFilter(value) { setFilter(value); setPage(0); clearSelection(); action.setError(''); }
  function changeTags(ids) { setSelectedTagIds(ids); setPage(0); clearSelection(); }
  function toggleRecord(item, checked) {
    setSelected((current) => {
      const next = { ...current };
      if (checked) next[item.id] ??= item.revision; else delete next[item.id];
      return next;
    });
    setBulkStatus(''); action.setError('');
  }
  function togglePage(checked) {
    setSelected((current) => {
      const next = { ...current };
      for (const item of pageRecords) { if (checked) next[item.id] ??= item.revision; else delete next[item.id]; }
      return next;
    });
    setBulkStatus(''); action.setError('');
  }
  async function applyBulk(snapshot, operation) {
    const result = await bulkReadingItems(snapshot.ids, operation, snapshot);
    clearSelection(); setBulkStatus(tr('已处理 {0} 条链接。', [formatNumber(result.count)]));
  }
  function beginBulk() {
    if (!rawData || busy || !contentPreferences.ready || !selectedIds.length || selectionStale) return;
    const snapshot = { ids: [...selectedIds], expectedRevision: rawData.revision, expectedPreferencesRevision: preferences.revision,
      expectedRecordRevisions: Object.fromEntries(selectedIds.map((id) => [id, selected[id]])) };
    action.setError(''); setBulkStatus('');
    if (bulkAction === 'delete') setBulkDelete(snapshot); else action.run(() => applyBulk(snapshot, bulkAction));
  }
  function chooseDestination(record) {
    action.run(async () => {
      const state = await loadState();
      setCopyStatus('');
      setCopy({ record, state, value: desktopDestinationValue(state) });
    });
  }
  function closeDestination() { setCopy(null); action.setError(''); }
  function addToDesktop(event) {
    event.preventDefault();
    if (!copy?.value || copyHidden || event.nativeEvent?.isComposing) return;
    action.run(async () => {
      try {
        await copyReadingToNavigation(copy.record, copy.value, copy.state.revision);
        closeDestination(); setCopyStatus(tr('已添加到桌面。'));
      } catch (error) {
        if (error.code === 'TARGET_CHANGED' || error.code === 'REVISION_CONFLICT') {
          const state = await loadState().catch(() => null);
          if (state) setCopy({ ...copy, state, value: '' });
        }
        throw error;
      }
    });
  }
  return <Tabs value={filter} onValueChange={changeFilter} asChild><div className="personal-tools-body reading-tools">
    <PrivateEditor hidden={draftHidden} busy={busy} onBusyChange={setUnlocking} onDiscard={() => setDiscarding({ record: null })} className="reading-draft-surface"><form className="reading-add-form" onSubmit={(event) => {
      event.preventDefault();
      if (draftHidden || selectionMode || busy || !contentPreferences.ready || changedElsewhere) return;
      action.run(async () => {
        await saveReadingItem({ ...draft, revisitOn: draft.revisitOn || null, status: draft.status || 'unread' }, { metadata, expectedPreferencesRevision: preferences.revision, expectedMetadata: originalMetadata });
        select(null);
      });
    }}>
      <label>{tr("网址")}<Input type="text" inputMode="url" required value={draft.url} maxLength={4096} placeholder="https://…" disabled={busy || selectionMode} onChange={(event) => setDraft((value) => ({ ...value, url: event.target.value }))} /></label>
      <label>{tr("名称")}<Input value={draft.title} maxLength={200} disabled={busy || selectionMode} placeholder={tr("可留空")} onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))} /></label>
      <div>{draft.id && <Button variant="secondary" className="button" type="button" disabled={busy} onClick={() => select(null)}>{tr("取消")}</Button>}<Button variant="default" type={changedElsewhere ? 'button' : 'submit'} className="button primary"
        onClick={changedElsewhere ? () => setDiscarding({ record: latest || null }) : undefined} disabled={!data || !contentPreferences.ready || selectionMode || busy || !changedElsewhere && !draft.url.trim()}>{changedElsewhere ? tr('重新打开') : draft.id ? tr("保存") : tr("添加")}</Button></div>
      <div className="reading-revisit-field"><label htmlFor={revisitInputId}>{tr('再看日期')}<Input id={revisitInputId} type="date" min="0001-01-01" max="9999-12-31" value={draft.revisitOn || ''} disabled={busy || selectionMode}
        onChange={(event) => setDraft((value) => ({ ...value, revisitOn: event.target.value }))} /></label>
        {draft.revisitOn && <Button type="button" variant="ghost" disabled={busy || selectionMode} onClick={() => setDraft((value) => ({ ...value, revisitOn: '' }))}>{tr('清除日期')}</Button>}</div>
      <div className="reading-metadata-fields"><ContentMetadataEditor preferences={preferences} contentKey={draft.id ? `reading:${draft.id}` : undefined} value={metadata}
        onChange={setMetadata} disabled={action.busy || unlocking || draftHidden || selectionMode || !contentPreferences.ready} onBusyChange={setMetadataBusy} /></div>
    </form></PrivateEditor>
    {discarding && <Confirm privacySafe action={tr('放弃修改')} busy={busy} onCancel={() => setDiscarding(null)} onConfirm={() => { select(discarding.record); setDiscarding(null); }}>{tr('当前内容尚未保存，放弃修改？')}</Confirm>}
    <div className="personal-tools-toolbar"><TabsList className="tool-segments" aria-label={tr('阅读筛选')}>{[['unread', tr("未读")], ['read', tr("已读")], ['archived', tr("归档")], ['due', tr('待再看')]].map(([value, label]) => <TabsTrigger key={value} value={value} disabled={busy}>{label}</TabsTrigger>)}</TabsList><div className="tool-search"><MagnifyingGlass size={16} /><Input unstyled aria-label={tr("搜索稍后读")} placeholder={tr("搜索")} maxLength={100} value={visibleQuery} disabled={busy} onChange={(event) => { setQuery(event.target.value); setQueryRecordId(null); setPage(0); clearSelection(); }} /></div></div>
    <div className="reading-filter-actions"><ContentTagFilter preferences={preferences} availableTagIds={availableTagIds} selectedTagIds={selectedTagIds} onChange={changeTags} disabled={busy || !contentPreferences.ready} />
      <Button type="button" variant="ghost" size="sm" disabled={busy || draftHasContent || !contentPreferences.ready || !selectionMode && !records.length} onClick={() => { setSelectionMode((value) => !value); clearSelection(); action.setError(''); }}>{selectionMode ? tr('取消选择') : tr('批量选择')}</Button></div>
    {selectionMode && <div className="reading-bulk-toolbar"><label><Checkbox aria-label={tr('全选本页链接')} checked={pageRecords.length && pageSelected === pageRecords.length ? true : pageSelected ? 'indeterminate' : false}
      disabled={busy || !pageRecords.length} onCheckedChange={(checked) => togglePage(checked === true)} />{tr('全选本页')}</label><span>{tr('已选 {0} 条链接', [formatNumber(selectedIds.length)])}</span>
      <Select label={tr('批量操作')} value={bulkAction} disabled={busy} options={[{ value: 'read', label: tr('标为已读') }, { value: 'unread', label: tr('标为未读') }, { value: 'archived', label: tr('归档') }, { value: 'delete', label: tr('删除') }]}
        onChange={setBulkAction} /><Button type="button" variant={bulkAction === 'delete' ? 'destructive' : 'default'} disabled={busy || !selectedIds.length || selectionStale} onClick={beginBulk}>{tr('应用')}</Button>
      {selectionStale && !busy && <p className="form-error" role="alert">{tr('所选内容已变化，请重新选择。')}</p>}</div>}
    <MessageDialog message={loadError || contentPreferences.error || (!copy && action.error) || (!draftHidden && !busy && changedElsewhere ? tr('这条记录已在其他页面修改，请重新打开后再保存。') : '')} onClose={() => action.setError('')} />
    {copyStatus && <p className="hint" role="status">{copyStatus}</p>}
    {bulkStatus && <p className="hint" role="status">{bulkStatus}</p>}
    {bulkDelete && <Confirm privacySafe busy={busy} confirmDisabled={!bulkValid} onCancel={() => setBulkDelete(null)} onConfirm={() => {
      if (bulkValid) action.run(() => applyBulk(bulkDelete, 'delete'));
    }}>{bulkValid ? tr('删除所选 {0} 条链接？它们会移入回收站。', [formatNumber(bulkDelete.ids.length)]) : tr('所选内容已变化，请重新选择。')}</Confirm>}
    {copy && <Dialog title={tr('添加到桌面')} privacyKeys={[`reading:${copy.record.id}`]} onClose={closeDestination} closeDisabled={action.busy}>
      <form className="form-stack" onSubmit={addToDesktop}>
        <NavigationDestination state={copy.state} preferences={{ presentation: presentation.active, privateKeys: [...presentation.hiddenKeys] }}
          value={copy.value} onChange={(value) => setCopy((current) => ({ ...current, value }))} disabled={action.busy || copyHidden} />
        {action.error && !copyHidden && <p className="form-error" role="alert">{action.error}</p>}
        <div className="dialog-actions">
          <Button variant="secondary" type="button" disabled={action.busy} onClick={closeDestination}>{tr('取消')}</Button>
          <Button type="submit" disabled={action.busy || copyHidden || !copy.value}>{tr('添加')}</Button>
        </div>
      </form>
    </Dialog>}
    {deleting && !deletionHidden && <Confirm busy={busy} onCancel={() => setDeleting(null)} onConfirm={() => action.run(async () => { await deletePersonalRecord('reading', deleting.id, deleting.revision); if (draft.id === deleting.id) select(null); setDeleting(null); })}>{tr("删除“{0}”？", [deleting.title])}</Confirm>}
    <TabsContent ref={listRef} value={filter} className="reading-records">{pageRecords.map((item) => <div className="reading-record" key={item.id} data-record-id={item.id}>{selectionMode && <Checkbox className="reading-record-select" aria-label={tr('选择“{0}”', [item.title])} checked={Object.hasOwn(selected, item.id)} disabled={busy} onCheckedChange={(checked) => toggleRecord(item, checked === true)} />}
      <div className="reading-record-content"><a href={item.url} target="_blank" rel="noreferrer noopener"><strong>{item.title}</strong><small>{new URL(item.url).hostname}</small><ArrowSquareOut size={15} /></a>
      {item.revisitOn && <div className="reading-record-revisit" data-due={isReadingDue(item, today) || undefined}><time dateTime={item.revisitOn}>{tr('再看日期：{0}', [formatReadingDay(item.revisitOn)])}</time>
        {filter === 'due' && <span>{item.status === 'unread' ? tr('未读') : item.status === 'read' ? tr('已读') : tr('归档')}</span>}</div>}
      {metadataFor(`reading:${item.id}`).description && <p className="reading-record-description">{metadataFor(`reading:${item.id}`).description}</p>}
      <ContentTagLabels tags={visibleTags} tagIds={metadataFor(`reading:${item.id}`).tagIds} /></div>{!selectionMode && <div className="reading-record-actions">
      <Button variant="ghost" type="button" className="button quiet" disabled={busy} aria-label={item.status === 'unread' ? tr("标为已读") : tr("标为未读")} title={item.status === 'unread' ? tr("标为已读") : tr("标为未读")} onClick={() => action.run(() => saveReadingItem({ ...item, status: item.status === 'unread' ? 'read' : 'unread' }))}><Check size={17} weight={item.status === 'read' ? 'bold' : 'regular'} /></Button>
      {item.status !== 'archived' && <Button variant="ghost" type="button" className="button quiet" disabled={busy} aria-label={tr("归档")} title={tr("归档")} onClick={() => action.run(() => saveReadingItem({ ...item, status: 'archived' }))}><Archive size={17} /></Button>}
      <Button variant="ghost" type="button" className="button quiet" disabled={busy} aria-label={tr('添加到桌面')} title={tr('添加到桌面')} aria-haspopup="dialog" onClick={() => chooseDestination(item)}><SquaresFour size={17} /></Button>
      <Button variant="ghost" type="button" className="button quiet" disabled={busy || draftHasContent || !contentPreferences.ready} aria-label={tr("编辑链接")} title={tr("编辑")} onClick={() => select(item)}><PencilSimple size={17} /></Button>
      <Button variant="ghost" type="button" className="button quiet" disabled={busy} aria-label={tr("删除链接")} title={tr("删除")} onClick={() => setDeleting(item)}><Trash size={17} /></Button></div>}</div>)}{!records.length && <p className="tool-empty">{visibleQuery || selectedTagIds.length ? tr("没有找到链接") : filter === 'due' ? tr('暂无待再看的链接') : tr("暂无链接")}</p>}</TabsContent>
    {pageCount > 1 && <nav className="reading-pagination" aria-label={tr('列表分页')}><Button type="button" variant="ghost" size="sm" disabled={busy || currentPage === 0} onClick={() => setPage(currentPage - 1)}>{tr('上一页')}</Button>
      <span>{tr('第 {0} 页，共 {1} 页', [formatNumber(currentPage + 1), formatNumber(pageCount)])}</span><Button type="button" variant="ghost" size="sm" disabled={busy || currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>{tr('下一页')}</Button></nav>}
    <div className="reading-bottom-actions"><ToolDataActions data={rawData} run={action.run} busy={busy} /></div>
  </div></Tabs>;
}
