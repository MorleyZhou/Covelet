import { useContext, useEffect, useRef, useState } from 'react';
import { tr, getLocale } from '../i18n/index.js';
import { PresentationContext } from '../lib/presentation.js';
import { loadNoteHistory, subscribeNoteHistory } from '../lib/note-history.js';
import { restoreNoteVersion } from '../lib/personal-tools.js';
import { userErrorMessage } from '../lib/user-error.js';
import { Button } from './ui/button.jsx';
import './note-history.css';

const date = value => new Date(value).toLocaleString(getLocale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function NoteHistory({ note, preferencesRevision, Dialog, onClose, onRestored, onBusyChange,
  dirty = false, stale = false, hidden = false, disabled = false,
  loadHistory = loadNoteHistory, subscribeHistory = subscribeNoteHistory, restoreVersion = restoreNoteVersion }) {
  const presentation = useContext(PresentationContext);
  const hiddenNow = hidden || presentation.active && presentation.hiddenKeys.has(`note:${note?.id}`);
  const blocked = !note?.id || hiddenNow || dirty || stale || disabled;
  const mustClose = !note?.id || hiddenNow || dirty || disabled;
  const [history, setHistory] = useState(null), [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [invalid, setInvalid] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), active = useRef(true), restoring = useRef(false), current = useRef(null), callbacks = useRef(null);
  current.current = { id: note?.id, revision: note?.revision, preferencesRevision, hidden: hiddenNow, blocked, dirty };
  callbacks.current = { onClose, onRestored, onBusyChange };
  async function read() {
    if (current.current.blocked || restoring.current) return;
    const request = ++generation.current, frame = { ...current.current };
    setHistory(null); setSelectedId(null); setInvalid(false); setError(''); setLoading(true);
    const valid = () => active.current && request === generation.current && !current.current.blocked
      && current.current.id === frame.id && current.current.revision === frame.revision && current.current.preferencesRevision === frame.preferencesRevision;
    try {
      const value = await loadHistory();
      if (valid()) { setHistory(value); setSelectedId(null); }
    } catch (reason) { if (valid()) setError(userErrorMessage(reason, tr('便笺历史未能读取，请重试。'))); }
    finally { if (active.current && request === generation.current) setLoading(false); }
  }
  useEffect(() => {
    generation.current++;
    if (mustClose || stale && !restoring.current) {
      setHistory(null); setSelectedId(null); setLoading(false); callbacks.current.onClose?.();
    } else if (!restoring.current) read();
  }, [note?.id, note?.revision, preferencesRevision, mustClose, stale, loadHistory]);
  useEffect(() => {
    active.current = true;
    const unsubscribe = subscribeHistory(() => {
      if (!active.current || restoring.current) return;
      generation.current++; setHistory(null); setSelectedId(null); setLoading(false); setInvalid(true);
    });
    return () => { active.current = false; generation.current++; unsubscribe(); if (restoring.current) callbacks.current.onBusyChange?.(false); };
  }, [subscribeHistory]);
  const versions = [...(history?.notes?.[note?.id] || [])].sort((left, right) => right.n - left.n || left.id.localeCompare(right.id));
  const selected = versions.find(version => version.id === selectedId);
  function restore() {
    if (current.current.blocked || restoring.current || !selected || !history || invalid) return;
    const frame = { ...current.current }, versionId = selected.id, historyRevision = history.revision;
    restoring.current = true; setBusy(true); setError(''); callbacks.current.onBusyChange?.(true);
    Promise.resolve().then(() => restoreVersion(frame.id, versionId, { expectedNoteRevision: frame.revision,
      expectedHistoryRevision: historyRevision, expectedPreferencesRevision: frame.preferencesRevision })).then(saved => {
      // A successful domain commit may update the parent subscription before
      // this promise resolves. Preserve any new draft or privacy transition.
      if (active.current && current.current.id === frame.id && !current.current.hidden && !current.current.dirty)
        callbacks.current.onRestored?.(saved);
    }).catch(reason => {
      if (active.current && !current.current.hidden) {
        setError(userErrorMessage(reason, tr('便笺或历史已在其他页面更新，请重新打开历史。')));
        generation.current++; setHistory(null); setSelectedId(null); setInvalid(true);
      }
    }).finally(() => {
      restoring.current = false;
      if (active.current) { setBusy(false); callbacks.current.onBusyChange?.(false); }
    });
  }
  if (mustClose || stale && !restoring.current) return null;
  return <Dialog title={tr('便笺历史')} wide className="note-history-modal" closeDisabled={busy} onClose={() => { if (!restoring.current) onClose?.(); }}>
    <div className="note-history-panel" aria-busy={loading || busy}>
      <div className="note-history-toolbar"><p className="hint">{tr('每条便笺最多保留 20 个版本，空间不足时清理最旧历史。')}</p><Button type="button" variant="ghost" disabled={busy || loading} onClick={read}>{tr('刷新历史')}</Button></div>
      {loading && <p className="hint" role="status">{tr('正在读取便笺历史…')}</p>}
      {invalid && !error && <p className="hint" role="status">{tr('便笺历史已更新，请刷新后重新选择。')}</p>}
      {history && <div className="note-history-workspace">
        <div className="note-history-versions" role="list" aria-label={tr('便笺历史版本')}>
          {versions.map(version => <div role="listitem" key={version.id}><Button type="button" variant="unstyled" size="unstyled" disabled={busy} aria-pressed={version.id === selectedId}
            onClick={() => { setSelectedId(version.id); setError(''); }}><time dateTime={new Date(version.capturedAt).toISOString()}>{date(version.capturedAt)}</time><strong>{version.record.title || tr('未命名便笺')}</strong></Button></div>)}
          {!versions.length && <p className="tool-empty">{tr('暂无便笺历史')}</p>}
        </div>
        {selected ? <section className="note-history-comparison" aria-label={tr('便笺版本对比')}>
          <article><h3>{tr('当前版本')}</h3><strong dir="auto">{note.title || tr('未命名便笺')}</strong><pre dir="auto" aria-label={tr('当前便笺内容')}>{note.body}</pre></article>
          <article><h3>{tr('历史版本')}</h3><strong dir="auto">{selected.record.title || tr('未命名便笺')}</strong><pre dir="auto" aria-label={tr('历史便笺内容')}>{selected.record.body}</pre></article>
        </section> : <p className="note-history-empty hint">{tr('选择一个历史版本查看对比。')}</p>}
      </div>}
      {selected && <p className="hint">{tr('恢复前会把当前便笺保存为一个历史版本。')}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="note-history-actions"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{tr('关闭')}</Button><Button type="button" variant="default" disabled={busy || loading || invalid || !selected} onClick={restore}>{busy ? tr('正在恢复…') : tr('恢复此版本')}</Button></div>
    </div>
  </Dialog>;
}
