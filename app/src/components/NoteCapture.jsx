import { useContext, useEffect, useId, useRef, useState } from 'react';
import { tr } from '../i18n/index.js';
import { captureNoteDocument, captureVisibleTags, readSelectedPage } from '../lib/note-capture.js';
import { saveNote } from '../lib/personal-tools.js';
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

export default function NoteCapture({ preferences, onBusyChange, onDirtyChange, onCancel, onSaved }) {
  const [draft, setDraft] = useState({ title: '', body: '', pageTitle: '', sourceUrl: '', tagIds: [] });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [rereading, setRereading] = useState(false);
  const [dirty, setDirty] = useState(false), pending = useRef(false), active = useRef(true), job = useRef(null);
  const expectedPreferencesRevision = useRef(preferences.revision);
  const [capturing, setCapturing] = useState(false);
  const titleId = useId(), bodyId = useId(), presentation = useContext(PresentationContext);
  const locked = presentation.active || preferences.presentation;
  const tags = getContentTags({ ...preferences, presentation: locked }, { hiddenKeys: locked ? presentation.hiddenKeys : undefined });
  const visibleKey = tags.map((tag) => tag.id).join('\0');
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const tagIds = captureVisibleTags(preferences, draft.tagIds, { locked, hiddenKeys: presentation.hiddenKeys });
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
      if (captureVisibleTags(preferences, draft.tagIds, { locked, hiddenKeys: presentation.hiddenKeys }).length !== draft.tagIds.length) {
        throw Object.assign(Error(tr('所选项目已发生变化，请重新选择。')), { code: 'REVISION_CONFLICT' });
      }
      await saveNote({ title: draft.title, document }, { metadata: { description: '', tagIds: draft.tagIds },
        expectedPreferencesRevision: expectedPreferencesRevision.current, expectedMetadata: { description: '', tagIds: [] } });
      setDirty(false); onDirtyChange?.(false); onSaved?.();
    } catch (reason) {
      if (reason.code === 'REVISION_CONFLICT') {
        const [latest, navigation] = await Promise.all([loadContentPreferences(), loadState()]).catch(() => []);
        if (latest && navigation && active.current) {
          const hiddenKeys = privateContentKeys(navigation, latest);
          setDraft((current) => ({ ...current, tagIds: captureVisibleTags(latest, current.tagIds, { locked, hiddenKeys }) }));
          expectedPreferencesRevision.current = latest.revision;
        }
      }
      if (active.current) setError(userErrorMessage(reason));
    }
    finally { pending.current = false; setWorking(false); }
  }}>
    <div className="form-stack popup-form-body">
    <Button type="button" variant="secondary" className="note-capture-read" disabled={busy} onClick={() => dirty ? setRereading(true) : capture()}>{capturing ? tr('正在读取选文…') : tr('读取页面选文')}</Button>
    {notice && <p className="hint" role="status">{notice}</p>}
    <div className="note-capture-field"><label htmlFor={titleId}>{tr('标题')}</label><Input id={titleId} maxLength={200} value={draft.title} disabled={busy} onChange={(event) => patch({ title: event.target.value })} /></div>
    <div className="note-capture-field"><label htmlFor={bodyId}>{tr('便笺内容')}</label><Textarea id={bodyId} rows={5} maxLength={60000} value={draft.body} disabled={busy} onChange={(event) => patch({ body: event.target.value })} /></div>
    {draft.sourceUrl && <div className="note-capture-source"><span>{tr('来源')}</span><a href={draft.sourceUrl} title={draft.sourceUrl} target="_blank" rel="noopener noreferrer">{draft.sourceUrl}</a></div>}
    {tags.length > 0 && <Disclosure title={tr('标签')} className="popup-details" disabled={busy}><fieldset className="content-tag-picker" aria-label={tr('标签')} disabled={busy}><div className="content-tag-options">{tags.map((tag) => <label className="content-tag-option" key={tag.id}>
      <Checkbox checked={draft.tagIds.includes(tag.id)} disabled={!draft.tagIds.includes(tag.id) && draft.tagIds.length >= 20}
        onCheckedChange={(checked) => patch({ tagIds: checked === true ? [...draft.tagIds, tag.id] : draft.tagIds.filter((id) => id !== tag.id) })} /><span>{tag.name}</span>
    </label>)}</div></fieldset></Disclosure>}
    {error && <p className="form-error" role="alert">{error}</p>}
    </div>
    <div className="quick-add-actions"><Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>{tr('取消')}</Button><Button type="submit" disabled={busy || !draft.body.trim()}>{busy ? tr('保存中…') : tr('保存')}</Button></div>
    {rereading && <PromptDialog action={tr('放弃修改')} destructive onCancel={() => setRereading(false)} onConfirm={capture}><p>{tr('当前便笺尚未保存，放弃修改？')}</p></PromptDialog>}
  </form>;
}
