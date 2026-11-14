import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { tr } from '../i18n/index.js';
import { appendCapturedDocument, captureNoteDocument, captureVisibleTags, readSelectedPage } from '../lib/note-capture.js';
import { appendNoteCapture, loadPersonalToolsSnapshot, saveNote, subscribePersonalTools } from '../lib/personal-tools.js';
import { noteDocumentText } from '../lib/note-document.js';
import { getContentTags, loadContentPreferences } from '../lib/content-preferences.js';
import { PresentationContext, privateContentKeys } from '../lib/presentation.js';
import { loadState } from '../lib/storage.js';
import { userErrorMessage } from '../lib/user-error.js';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Textarea } from './ui/textarea.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import PromptDialog from './PromptDialog.jsx';
import { Disclosure } from './ui/disclosure.jsx';
import Select from './Select.jsx';

export default function NoteCapture({ preferences, onBusyChange, onDirtyChange, onCancel, onSaved }) {
  const [draft, setDraft] = useState({ title: '', body: '', pageTitle: '', sourceUrl: '', tagIds: [] });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [rereading, setRereading] = useState(false);
  const [dirty, setDirty] = useState(false), pending = useRef(false), active = useRef(true), job = useRef(null);
  const expectedPreferencesRevision = useRef(preferences.revision);
  const [capturing, setCapturing] = useState(false);
  const [mode, setMode] = useState('new'), [target, setTarget] = useState(null), [noteQuery, setNoteQuery] = useState('');
  const [tools, setTools] = useState(null), [toolsError, setToolsError] = useState(''), [ownPreferences, setOwnPreferences] = useState(null);
  const currentPreferences = ownPreferences && ownPreferences.revision > preferences.revision ? ownPreferences : preferences;
  const titleId = useId(), bodyId = useId(), targetSearchId = useId(), presentation = useContext(PresentationContext);
  const locked = presentation.active || currentPreferences.presentation;
  const tags = getContentTags({ ...currentPreferences, presentation: locked }, { hiddenKeys: locked ? presentation.hiddenKeys : undefined });
  const visibleNotes = (tools?.notes || []).filter((note) => !locked || !currentPreferences.privateKeys.includes(`note:${note.id}`) && !presentation.hiddenKeys.has(`note:${note.id}`));
  const currentTarget = target && visibleNotes.find((note) => note.id === target.note.id);
  const targetStale = Boolean(target && (!currentTarget || currentTarget.revision !== target.note.revision || currentPreferences.revision !== target.preferencesRevision));
  const needle = noteQuery.normalize('NFKC').toLocaleLowerCase();
  const matches = visibleNotes.filter((note) => !needle || `${note.title}\n${note.body}`.normalize('NFKC').toLocaleLowerCase().includes(needle));
  const noteOptions = [...(currentTarget && !matches.some((note) => note.id === currentTarget.id) ? [currentTarget] : []), ...matches]
    .map((note) => ({ value: note.id, label: note.title }));
  if (targetStale) noteOptions.unshift({ value: '@stale', label: tr('所选便笺已变化，请重新选择。'), disabled: true });
  const capturePreview = useMemo(() => {
    if (!draft.body.trim()) return { document: null, error: '' };
    try {
      const document = captureNoteDocument(draft);
      if (mode === 'append' && target && !targetStale) appendCapturedDocument(target.note, document);
      return { document, error: '' };
    } catch (reason) { return { document: null, error: userErrorMessage(reason) }; }
  }, [draft.body, draft.pageTitle, draft.sourceUrl, mode, target, targetStale]);
  const visibleKey = tags.map((tag) => tag.id).join('\0');
  useEffect(() => {
    let mounted = true;
    const receive = (next) => { if (mounted) { setTools((current) => current?.revision > next.revision ? current : next); setToolsError(''); } };
    const unsubscribe = subscribePersonalTools(receive);
    loadPersonalToolsSnapshot().then(receive).catch((reason) => { if (mounted) setToolsError(userErrorMessage(reason)); });
    return () => { mounted = false; unsubscribe(); };
  }, []);
  useEffect(() => { if (locked) setNoteQuery(''); }, [locked]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const tagIds = captureVisibleTags(currentPreferences, draft.tagIds, { locked, hiddenKeys: presentation.hiddenKeys });
    if (tagIds.length !== draft.tagIds.length) {
      setDraft((current) => ({ ...current, tagIds }));
      setNotice(tr('所选项目已发生变化，请重新选择。'));
    }
  }, [visibleKey, locked, draft.tagIds]);
  function patch(value) { setDraft((current) => ({ ...current, ...value })); setDirty(true); setError(''); }
  function setWorking(value) { if (active.current) setBusy(value); onBusyChange?.(value); }
  async function capture() {
    if (pending.current) return;
    const controller = new AbortController(); job.current?.abort(); job.current = controller;
    pending.current = true; setWorking(true); setCapturing(true); setError(''); setNotice(''); setRereading(false);
    try {
      const captured = await readSelectedPage({ signal: controller.signal });
      if (!active.current || controller.signal.aborted || job.current !== controller) return;
      setDraft({ title: captured.title, body: captured.text, pageTitle: captured.title, sourceUrl: captured.url, tagIds: [] });
      setDirty(Boolean(captured.text.trim()));
      if (!captured.text.trim()) setNotice(tr('未读取到页面选文，可手动输入。'));
    } catch (reason) {
      if (active.current && !controller.signal.aborted && job.current === controller) setError(userErrorMessage(reason));
    } finally {
      if (job.current === controller) { pending.current = false; if (active.current) setCapturing(false); setWorking(false); }
    }
  }
  useEffect(() => {
    active.current = true; capture();
    return () => { active.current = false; job.current?.abort(); onBusyChange?.(false); onDirtyChange?.(false); };
  }, []);
  return <form className="popup-form note-capture" aria-busy={busy || undefined} onSubmit={async (event) => {
    event.preventDefault(); event.stopPropagation();
    if (pending.current || event.nativeEvent?.isComposing) return;
    pending.current = true; setWorking(true); setError('');
    try {
      const document = captureNoteDocument(draft);
      if (mode === 'append') {
        if (!target || targetStale) throw Object.assign(Error(tr('所选便笺已变化，请重新选择。')), { code: 'REVISION_CONFLICT' });
        await appendNoteCapture({ id: target.note.id, revision: target.note.revision, document }, { expectedPreferencesRevision: target.preferencesRevision });
      } else {
        if (captureVisibleTags(currentPreferences, draft.tagIds, { locked, hiddenKeys: presentation.hiddenKeys }).length !== draft.tagIds.length) {
          throw Object.assign(Error(tr('所选项目已发生变化，请重新选择。')), { code: 'REVISION_CONFLICT' });
        }
        await saveNote({ title: draft.title, document }, { metadata: { description: '', tagIds: draft.tagIds },
          expectedPreferencesRevision: expectedPreferencesRevision.current, expectedMetadata: { description: '', tagIds: [] } });
      }
      setDirty(false); onDirtyChange?.(false); onSaved?.();
    } catch (reason) {
      if (reason.code === 'REVISION_CONFLICT' || reason.code === 'PRIVACY_LOCKED') {
        const [latest, navigation, nextTools] = await Promise.all([loadContentPreferences(), loadState(), loadPersonalToolsSnapshot()]).catch(() => []);
        if (latest && navigation && active.current) {
          const hiddenKeys = privateContentKeys(navigation, latest);
          setDraft((current) => ({ ...current, tagIds: captureVisibleTags(latest, current.tagIds, { locked, hiddenKeys }) }));
          expectedPreferencesRevision.current = latest.revision;
          setOwnPreferences(latest); setTools(nextTools);
        }
      }
      if (active.current) setError(userErrorMessage(reason));
    }
    finally { pending.current = false; setWorking(false); }
  }}>
    <div className="form-stack popup-form-body">
    <Button type="button" variant="secondary" className="note-capture-read" disabled={busy} onClick={() => dirty ? setRereading(true) : capture()}>{capturing ? tr('正在读取选文…') : tr('读取页面选文')}</Button>
    {notice && <p className="hint" role="status">{notice}</p>}
    <Select label={tr('保存方式')} value={mode} disabled={busy} options={[{ value: 'new', label: tr('新建便笺') }, { value: 'append', label: tr('追加到便笺') }]}
      onChange={(value) => { setMode(value); setError(''); }} />
    {mode === 'new' ? <div className="note-capture-field"><label htmlFor={titleId}>{tr('标题')}</label><Input id={titleId} maxLength={200} value={draft.title} disabled={busy} onChange={(event) => patch({ title: event.target.value })} /></div>
      : <>
        <div className="note-capture-field"><label htmlFor={targetSearchId}>{tr('搜索目标便笺')}</label><Input id={targetSearchId} maxLength={200} value={noteQuery} disabled={busy || !tools} onChange={(event) => setNoteQuery(event.target.value)} /></div>
        <Select label={tr('选择目标便笺')} value={targetStale ? '@stale' : target?.note.id || ''} placeholder={tr('选择目标便笺')} disabled={busy || !tools} options={noteOptions}
          onChange={(id) => { const note = visibleNotes.find((item) => item.id === id); if (note) { setTarget({ note: structuredClone(note), preferencesRevision: currentPreferences.revision }); setError(''); } }} />
        {targetStale && <p className="form-error" role="status">{tr('所选便笺已变化，请重新选择。')}</p>}
        {tools && !noteOptions.some((option) => !option.disabled) && <p className="hint">{noteQuery ? tr('没有找到便笺') : tr('暂无便笺')}</p>}
        {toolsError && <p className="form-error" role="alert">{toolsError}</p>}
      </>}
    <div className="note-capture-field"><label htmlFor={bodyId}>{tr('便笺内容')}</label><Textarea id={bodyId} rows={5} maxLength={60000} value={draft.body} disabled={busy} onChange={(event) => patch({ body: event.target.value })} /></div>
    {draft.sourceUrl && <div className="note-capture-source"><span>{tr('来源')}</span><a href={draft.sourceUrl} title={draft.sourceUrl} target="_blank" rel="noopener noreferrer">{draft.sourceUrl}</a></div>}
    {mode === 'append' && capturePreview.document && <Disclosure title={tr('追加预览')} className="popup-details"><div className="note-capture-preview" role="region" aria-label={tr('追加预览')}>{noteDocumentText(capturePreview.document)}</div></Disclosure>}
    {mode === 'new' && tags.length > 0 && <Disclosure title={tr('标签')} className="popup-details" disabled={busy}><fieldset className="content-tag-picker" aria-label={tr('标签')} disabled={busy}><div className="content-tag-options">{tags.map((tag) => <label className="content-tag-option" key={tag.id}>
      <Checkbox checked={draft.tagIds.includes(tag.id)} disabled={!draft.tagIds.includes(tag.id) && draft.tagIds.length >= 20}
        onCheckedChange={(checked) => patch({ tagIds: checked === true ? [...draft.tagIds, tag.id] : draft.tagIds.filter((id) => id !== tag.id) })} /><span>{tag.name}</span>
    </label>)}</div></fieldset></Disclosure>}
    {(error || capturePreview.error) && <p className="form-error" role="alert">{error || capturePreview.error}</p>}
    </div>
    <div className="quick-add-actions"><Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>{tr('取消')}</Button><Button type="submit" disabled={busy || !draft.body.trim() || Boolean(capturePreview.error) || mode === 'append' && (!target || targetStale || Boolean(toolsError))}>{busy ? tr('保存中…') : mode === 'append' ? tr('追加') : tr('保存')}</Button></div>
    {rereading && <PromptDialog action={tr('放弃修改')} destructive onCancel={() => setRereading(false)} onConfirm={capture}><p>{tr('当前便笺尚未保存，放弃修改？')}</p></PromptDialog>}
  </form>;
}
