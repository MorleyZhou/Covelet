import { tr, getLocale, builtinName, formatNumber } from "../i18n/index.js";
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NotePencil, BookOpen, Plus, Trash, PencilSimple, Check, Archive, ArrowSquareOut, Copy, PushPin, DownloadSimple, UploadSimple, Browser, MagnifyingGlass } from '@phosphor-icons/react';
import Select from './Select.jsx';
import { WIDGET_NAMES, WIDGET_SIZE_OPTIONS, validateWidgetConfig } from '../lib/widget-model.js';
import usePersonalTools from '../lib/use-personal-tools.js';
import { saveNote, saveReadingItem, deletePersonalRecord, importBrowserReadingList, captureTabSnapshot, renameTabSnapshot, restoreTabSnapshot, exportPersonalTools, importPersonalTools } from '../lib/personal-tools.js';
import { validateNoteDocument, noteDocumentText } from '../lib/note-document.js';
import FolioNoteEditor from './FolioNoteEditor.jsx';
import PromptDialog, { MessageDialog } from './PromptDialog.jsx';
import './personal-tools.css';

const newest = (items) => [...items].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
const stop = (event) => event.stopPropagation();
const formatDate = (value) => new Date(value).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function useAction(onBusyChange) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), active = useRef(true), gate = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function run(action) {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError(''); onBusyChange?.(true);
    try { return await action(); }
    catch (reason) { if (active.current) setError(reason.message); }
    finally { gate.current = false; if (active.current) { setBusy(false); onBusyChange?.(false); } }
  }
  return { run, busy, error, setError };
}
function Confirm({ children, onCancel, onConfirm, busy, confirmDisabled, action = tr("删除") }) {
  return <PromptDialog title={action} action={action} onCancel={onCancel} onConfirm={onConfirm} busy={busy} confirmDisabled={confirmDisabled} destructive={action === tr('删除') || action === tr('放弃修改')}><p>{children}</p></PromptDialog>;
}
function ToolDataActions({ run, busy, onImported }) {
  const input = useRef(null);
  return <details className="tool-data-actions"><summary>{tr("工具数据")}</summary><div>
    <button type="button" className="button quiet" disabled={busy} onClick={() => run(async () => {
      const blob = await exportPersonalTools(), url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = `Covelet-tools-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    })}><DownloadSimple size={16} />{tr("导出")}</button>
    <button type="button" className="button quiet" disabled={busy} onClick={() => input.current?.click()}><UploadSimple size={16} />{tr("导入")}</button>
    <input ref={input} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) run(async () => { await importPersonalTools(file); onImported?.(); }); }} />
    </div><p>{tr("便笺、稍后读与标签快照仅保存在本机。导入会保留已有记录；这些内容不参与导航同步。")}</p></details>;
}

export function PersonalWidgetSettings({ extensionId, entry, introduction, onUse, onBusyChange }) {
  const [size, setSize] = useState(entry?.config.size || 'small'), action = useAction(onBusyChange);
  return <form className="form-stack widget-config-form" onSubmit={(event) => { event.preventDefault(); action.run(() => onUse(validateWidgetConfig(extensionId, { size }), entry, extensionId)); }}>
    <div className="settings-scroll form-stack">{introduction}<Select label={tr("尺寸")} value={size} onChange={setSize} disabled={action.busy} options={WIDGET_SIZE_OPTIONS} />
      <p className="hint">{tr("内容保存在本机，移除桌面组件会保留内容。")}</p><MessageDialog message={action.error} onClose={() => action.setError('')} /></div>
    <div className="settings-footer"><button type="submit" className="button primary" disabled={action.busy}>{entry && !entry.detached ? tr("保存") : tr("使用")}</button></div>
  </form>;
}
export function PersonalWidgetPreview({ extensionId }) {
  const Icon = extensionId === 'notes' ? NotePencil : BookOpen;
  return <figure className={`personal-widget-preview ${extensionId}`} aria-label={tr("{0}预览", [WIDGET_NAMES[extensionId]])}><Icon size={32} /><strong>{WIDGET_NAMES[extensionId]}</strong></figure>;
}
export default function PersonalWidget({ entry, open, onOpen, onClose, Dialog, portalTarget }) {
  const { data } = usePersonalTools();
  const [dirty, setDirty] = useState(false), [discard, setDiscard] = useState(false), [busy, setBusy] = useState(false);
  const notes = entry.extensionId === 'notes', items = newest(data?.[notes ? 'notes' : 'reading'] || []);
  const visible = notes ? items : items.filter((item) => item.status === 'unread');
  const Icon = notes ? NotePencil : BookOpen, mini = entry.config.size === 'mini';
  useEffect(() => { if (!open) { setDirty(false); setDiscard(false); } }, [open]);
  const close = () => { if (busy) return; if (dirty) setDiscard(true); else onClose(); };
  return <>
    <button type="button" data-widget-launcher data-widget-surface id={`widget-title-${entry.id}`} className={`personal-widget personal-widget-${entry.config.size} personal-widget-${entry.extensionId}`}
      aria-haspopup="dialog" aria-expanded={open} aria-label={tr("{0}，{1}，打开", [builtinName(entry.extensionId, entry.name), notes ? tr("{0} 条便笺", [formatNumber(items.length)]) : tr("{0} 条未读", [formatNumber(visible.length)])])} onClick={onOpen}>
      <span className="personal-widget-heading"><Icon size={mini ? 25 : 20} /><span>{notes ? tr("便笺") : tr("未读")}</span><b>{formatNumber(notes ? items.length : visible.length)}</b></span>
      {!mini && <span className="personal-widget-body">{notes ? visible[0] ? <><strong>{visible[0].title}</strong><span className="personal-note-excerpt">{visible[0].body}</span></> : <span className="personal-widget-empty">{tr("记下此刻的想法")}</span>
        : visible.length ? visible.slice(0, entry.config.size === 'large' ? 7 : 3).map((item) => <span className="personal-reading-preview" key={item.id}><strong>{item.title}</strong><small>{new URL(item.url).hostname}</small></span>) : <span className="personal-widget-empty">{tr("没有未读链接")}</span>}</span>}
    </button>
    {open && Dialog && portalTarget && createPortal(<div className="personal-dialog-layer" onPointerDown={stop} onPointerMove={stop} onPointerUp={stop} onClick={stop} onContextMenu={stop} onKeyDown={stop}>
      <Dialog title={builtinName(entry.extensionId, entry.name)} onClose={close} closeDisabled={busy} className="personal-tools-modal" wide maximizable>
        {discard && <Confirm busy={busy} action={tr("放弃修改")} onCancel={() => setDiscard(false)} onConfirm={onClose}>{tr("放弃未保存的便笺修改？")}</Confirm>}
        {notes ? <NotesTools onDirtyChange={setDirty} onBusyChange={setBusy} /> : <ReadingTools onBusyChange={setBusy} onDirtyChange={setDirty} />}
      </Dialog></div>, portalTarget)}
  </>;
}

function NotesTools({ onDirtyChange, onBusyChange }) {
  const { data, core, error: loadError } = usePersonalTools(), action = useAction(onBusyChange);
  const [draft, setDraft] = useState({ title: '', body: '', pinned: false }), [dirty, setDirty] = useState(false), [query, setQuery] = useState('');
  const [preview, setPreview] = useState(false), [pending, setPending] = useState(null), [deleting, setDeleting] = useState(false);
  const [editorKey, setEditorKey] = useState(() => crypto.randomUUID());
  const notes = newest(data?.notes || []), latest = notes.find((item) => item.id === draft.id);
  const changedElsewhere = draft.id && (!latest || latest.revision !== draft.revision);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  const select = (note) => { setEditorKey(note?.id || crypto.randomUUID()); setDraft(note ? { ...note } : { title: '', body: '', pinned: false }); setDirty(false); setPreview(false); setPending(null); setDeleting(false); action.setError(''); };
  const choose = (note) => dirty ? setPending({ note }) : select(note);
  const reopen = () => { if (dirty) setPending({ note: latest || null }); else select(latest || null); };
  const patch = (value) => { setDraft((current) => ({ ...current, ...value })); setDirty(true); };
  const matches = notes.filter((note) => !query || core?.contains(`${note.title}\n${note.body}`, query));
  const documentError = useMemo(() => {
    try {
      if (draft.document) validateNoteDocument(draft.document);
      if (draft.body.length > 60000 || draft.body.includes('\0')) throw Error(tr('便笺文档无效或超出大小限制。'));
      return '';
    } catch (reason) { return reason.message; }
  }, [draft.document, draft.body]);
  const metrics = useMemo(() => {
    if (documentError || !core) return null;
    try { return core.metrics(draft.body); } catch { return null; }
  }, [core, draft.body, documentError]);
  return <div className="personal-tools-body notes-tools-body">
    <div className="personal-tools-toolbar"><div className="tool-search"><MagnifyingGlass size={16} /><input aria-label={tr("搜索便笺")} placeholder={tr("搜索便笺")} value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} /></div><button type="button" className="button" disabled={action.busy} onClick={() => choose(null)}><Plus size={17} />{tr("新便笺")}</button></div>
    <MessageDialog message={loadError || action.error || documentError || (!action.busy && changedElsewhere ? tr('这条便笺已在其他页面更新。') : '')} onClose={() => action.setError('')} />
    {pending && <Confirm action={tr("放弃修改")} busy={action.busy} onCancel={() => setPending(null)} onConfirm={() => select(pending.note)}>{tr("当前便笺尚未保存，放弃修改？")}</Confirm>}
    <div className="notes-workspace"><div className="tool-record-list" aria-label={tr("便笺列表")}>{matches.map((note) => <button type="button" key={note.id} aria-pressed={draft.id === note.id} disabled={action.busy} onClick={() => choose(note)}><strong>{note.pinned && <PushPin size={12} weight="fill" />}{note.title}</strong><span>{note.body.slice(0, 90) || tr("空白便笺")}</span><small>{formatDate(note.updatedAt)}</small></button>)}{!matches.length && <p className="tool-empty">{query ? tr("没有找到便笺") : tr("暂无便笺")}</p>}</div>
    <form className="note-editor" onKeyDownCapture={(event) => {
      if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 && (event.ctrlKey || event.metaKey) && event.key === 'Enter'
        && event.target.closest('[contenteditable="true"], .note-title-input') && !event.target.closest('[role="dialog"]')) {
        event.preventDefault(); event.stopPropagation(); event.currentTarget.requestSubmit();
      }
    }} onSubmit={(event) => {
      event.preventDefault();
      if (!data || !core || action.busy || !dirty || changedElsewhere || documentError) return;
      action.run(async () => { const saved = await saveNote(draft); setDraft(saved); setDirty(false); });
    }}>
      <label className="visually-hidden" htmlFor="note-title">{tr("便笺名称")}</label><input id="note-title" className="note-title-input" value={draft.title} placeholder={tr("未命名便笺")} maxLength={200} disabled={action.busy} onChange={(event) => patch({ title: event.target.value })} />
      <div className="note-editor-actions"><button type="button" className="button quiet" disabled={action.busy} aria-pressed={draft.pinned} onClick={() => patch({ pinned: !draft.pinned })}><PushPin size={16} weight={draft.pinned ? 'fill' : 'regular'} />{tr("置顶")}</button>
        <button type="button" className="button quiet" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? tr("编辑") : tr("预览")}</button>
        <button type="button" className="button quiet" disabled={!draft.body || action.busy} onClick={() => action.run(async () => { try { await navigator.clipboard.writeText(draft.document ? noteDocumentText(draft.document) : draft.body); } catch { throw Error(tr("无法复制，请手动选择文字。")); } })} aria-label={tr("复制便笺")}><Copy size={16} /></button></div>
      <FolioNoteEditor key={editorKey} documentId={editorKey} document={draft.document} body={draft.body} preview={preview} disabled={action.busy}
        onInitialize={(document) => setDraft((current) => current.document ? current : { ...current, document, body: noteDocumentText(document) })}
        onChange={(document) => patch({ document, body: noteDocumentText(document) })} onError={(reason) => action.setError(reason.message)} />
      {deleting && <Confirm busy={action.busy} onCancel={() => setDeleting(false)} onConfirm={() => action.run(async () => { await deletePersonalRecord('notes', draft.id, draft.revision); select(null); })}>{tr("删除“{0}”？", [draft.title])}</Confirm>}
      <div className="note-editor-footer"><small>{tr("{0} 字符", [formatNumber(metrics?.characters ?? draft.body.length)])}</small>{draft.id && <button type="button" className="button quiet" disabled={action.busy} onClick={() => setDeleting(true)} aria-label={tr("删除便笺")}><Trash size={16} /></button>}<button type={changedElsewhere ? 'button' : 'submit'} className="button primary" onClick={changedElsewhere ? reopen : undefined} disabled={!data || !core || action.busy || !changedElsewhere && (!dirty || Boolean(documentError))}>{changedElsewhere ? tr('重新打开') : tr("保存")}</button></div>
    </form></div><ToolDataActions run={action.run} busy={action.busy} />
  </div>;
}

function ReadingTools({ onBusyChange, onDirtyChange }) {
  const { data, core, error: loadError } = usePersonalTools(), action = useAction(onBusyChange);
  const [filter, setFilter] = useState('unread'), [query, setQuery] = useState(''), [draft, setDraft] = useState({ title: '', url: '' }), [deleting, setDeleting] = useState(null);
  useEffect(() => { onDirtyChange(Boolean(draft.url || draft.title)); }, [draft, onDirtyChange]);
  const records = newest(data?.reading || []).filter((item) => item.status === filter && (!query || core?.contains(`${item.title}\n${item.url}`, query)));
  return <div className="personal-tools-body reading-tools">
    <form className="reading-add-form" onSubmit={(event) => { event.preventDefault(); action.run(async () => { await saveReadingItem({ ...draft, status: draft.status || 'unread' }); setDraft({ title: '', url: '' }); }); }}>
      <label>{tr("网址")}<input type="text" inputMode="url" required value={draft.url} maxLength={4096} placeholder="https://…" disabled={action.busy} onChange={(event) => setDraft((value) => ({ ...value, url: event.target.value }))} /></label>
      <label>{tr("名称")}<input value={draft.title} maxLength={200} disabled={action.busy} placeholder={tr("可留空")} onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))} /></label>
      <div>{draft.id && <button className="button" type="button" disabled={action.busy} onClick={() => setDraft({ title: '', url: '' })}>{tr("取消")}</button>}<button type="submit" className="button primary" disabled={!data || action.busy || !draft.url.trim()}>{draft.id ? tr("保存") : tr("添加")}</button></div>
    </form>
    <div className="personal-tools-toolbar"><div className="tool-segments" aria-label={tr("阅读状态")}>{[['unread', tr("未读")], ['read', tr("已读")], ['archived', tr("归档")]].map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="tool-search"><MagnifyingGlass size={16} /><input aria-label={tr("搜索稍后读")} placeholder={tr("搜索")} maxLength={100} value={query} onChange={(event) => setQuery(event.target.value)} /></div></div>
    <MessageDialog message={loadError || action.error} onClose={() => action.setError('')} />
    {deleting && <Confirm busy={action.busy} onCancel={() => setDeleting(null)} onConfirm={() => action.run(async () => { await deletePersonalRecord('reading', deleting.id, deleting.revision); if (draft.id === deleting.id) setDraft({ title: '', url: '' }); setDeleting(null); })}>{tr("删除“{0}”？", [deleting.title])}</Confirm>}
    <div className="reading-records">{records.map((item) => <div className="reading-record" key={item.id}><a href={item.url} target="_blank" rel="noreferrer noopener"><strong>{item.title}</strong><small>{new URL(item.url).hostname}</small><ArrowSquareOut size={15} /></a><div>
      <button type="button" className="button quiet" disabled={action.busy} aria-label={item.status === 'unread' ? tr("标为已读") : tr("标为未读")} title={item.status === 'unread' ? tr("标为已读") : tr("标为未读")} onClick={() => action.run(() => saveReadingItem({ ...item, status: item.status === 'unread' ? 'read' : 'unread' }))}><Check size={17} weight={item.status === 'read' ? 'bold' : 'regular'} /></button>
      {item.status !== 'archived' && <button type="button" className="button quiet" disabled={action.busy} aria-label={tr("归档")} title={tr("归档")} onClick={() => action.run(() => saveReadingItem({ ...item, status: 'archived' }))}><Archive size={17} /></button>}
      <button type="button" className="button quiet" disabled={action.busy || Boolean(draft.url || draft.title)} aria-label={tr("编辑链接")} title={tr("编辑")} onClick={() => setDraft(item)}><PencilSimple size={17} /></button>
      <button type="button" className="button quiet" disabled={action.busy} aria-label={tr("删除链接")} title={tr("删除")} onClick={() => setDeleting(item)}><Trash size={17} /></button></div></div>)}{!records.length && <p className="tool-empty">{query ? tr("没有找到链接") : tr("暂无链接")}</p>}</div>
    <div className="reading-bottom-actions"><button type="button" className="button quiet" disabled={action.busy || !globalThis.chrome?.runtime?.id} onClick={() => action.run(importBrowserReadingList)}>{tr("从浏览器阅读清单导入")}</button><ToolDataActions run={action.run} busy={action.busy} /></div>
  </div>;
}

export function TabSnapshotTools({ introduction, onBusyChange }) {
  const { data, core, error: loadError } = usePersonalTools(), action = useAction(onBusyChange);
  const [name, setName] = useState(''), [selected, setSelected] = useState(null), [indices, setIndices] = useState([]), [confirm, setConfirm] = useState(null), [rename, setRename] = useState(''), [query, setQuery] = useState('');
  const [selectedRevision, setSelectedRevision] = useState(null);
  const snapshots = newest(data?.snapshots || []).filter((item) => !query || core?.contains(item.title, query)), snapshot = data?.snapshots.find((item) => item.id === selected);
  const stale = Boolean(snapshot && snapshot.revision !== selectedRevision);
  useEffect(() => { if (stale) setConfirm(null); }, [stale]);
  function select(item) { setSelected(item.id); setSelectedRevision(item.revision); setIndices([]); setConfirm(null); setRename(item.title); }
  const native = Boolean(globalThis.chrome?.runtime?.id);
  return <div className="tab-snapshot-settings"><div className="settings-scroll form-stack">{introduction}
    <form className="snapshot-capture" onSubmit={(event) => { event.preventDefault(); action.run(async () => { const record = await captureTabSnapshot(name); setName(''); select(record); }); }}><label>{tr("快照名称")}<input value={name} maxLength={200} disabled={action.busy} placeholder={tr("例如 工作资料")} onChange={(event) => setName(event.target.value)} /></label><button className="button primary" type="submit" disabled={!native || !data || action.busy}><Browser size={17} />{tr("保存当前窗口")}</button></form>
    {!native && <p className="hint">{tr("请在扩展中保存和恢复标签快照。")}</p>}
    <MessageDialog message={loadError || action.error || (!action.busy && stale ? tr('快照已在其他页面更新。') : '')} onClose={() => action.setError('')} />
    <div className="tool-search"><MagnifyingGlass size={16} /><input aria-label={tr("搜索标签快照")} placeholder={tr("搜索快照")} value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} /></div>
    <div className="snapshot-workspace"><div className="tool-record-list" aria-label={tr("快照列表")}>{snapshots.map((item) => <button key={item.id} type="button" aria-pressed={item.id === selected} disabled={action.busy} onClick={() => select(item)}><strong>{item.title}</strong><span>{tr("{0} 个标签", [formatNumber(item.tabs.length)])}</span><small>{formatDate(item.createdAt)}</small></button>)}{!snapshots.length && <p className="tool-empty">{tr("暂无快照")}</p>}</div>
    {snapshot ? <section className="snapshot-detail" aria-label={tr("快照内容")}><form className="snapshot-rename" onSubmit={(event) => { event.preventDefault(); action.run(async () => { const value = await renameTabSnapshot(snapshot.id, selectedRevision, rename); setSelectedRevision(value.revision); }); }}><label className="visually-hidden" htmlFor="snapshot-name">{tr("快照名称")}</label><input id="snapshot-name" value={rename} maxLength={200} disabled={action.busy} onChange={(event) => setRename(event.target.value)} /><button type="submit" className="button quiet" disabled={action.busy || stale || rename === snapshot.title || !rename.trim()}>{tr("保存名称")}</button></form>
      <div className="snapshot-selection-actions"><button type="button" className="button quiet" disabled={action.busy} onClick={() => setIndices(indices.length ? [] : snapshot.tabs.slice(0, 50).map((_, index) => index))}>{indices.length ? tr("取消选择") : snapshot.tabs.length > 50 ? tr("选择前 50 个") : tr("全选")}</button><span>{tr("{0} 个已选", [formatNumber(indices.length)])}</span></div>
      <div className="snapshot-tab-list">{snapshot.tabs.map((tab, index) => <label key={index}><input type="checkbox" checked={indices.includes(index)} disabled={action.busy || !indices.includes(index) && indices.length >= 50} onChange={(event) => setIndices((items) => event.target.checked ? [...items, index].sort((a, b) => a - b) : items.filter((item) => item !== index))} /><span><strong>{tab.title || new URL(tab.url).hostname}</strong><small>{tab.url}</small></span>{tab.pinned && <PushPin size={13} />}</label>)}</div>
      <div className="snapshot-detail-actions"><button type="button" className="button quiet" disabled={action.busy || stale} onClick={() => setConfirm('delete')} aria-label={tr("删除快照")}><Trash size={17} /></button><button type="button" className="button primary" disabled={action.busy || !stale && (!native || !indices.length)} onClick={() => stale ? select(snapshot) : setConfirm('restore')}>{stale ? tr('重新打开') : tr("打开所选标签")}</button></div>
      {confirm && <Confirm busy={action.busy} confirmDisabled={stale} action={confirm === 'delete' ? tr("删除") : tr("打开")} onCancel={() => setConfirm(null)} onConfirm={() => action.run(async () => { if (confirm === 'delete') { await deletePersonalRecord('snapshots', snapshot.id, selectedRevision); setSelected(null); } else await restoreTabSnapshot(snapshot.id, selectedRevision, indices); setConfirm(null); })}>{confirm === 'delete' ? tr("删除“{0}”？已打开的标签不受影响。", [snapshot.title]) : tr("在新窗口打开所选 {0} 个标签？", [formatNumber(indices.length)])}</Confirm>}
    </section> : <p className="tool-empty">{tr("选择快照查看标签")}</p>}</div>
    <ToolDataActions run={action.run} busy={action.busy} />
  </div></div>;
}
