import { useContext, useEffect, useRef, useState } from 'react';
import { tr, getLocale } from '../i18n/index.js';
import { PresentationContext } from '../lib/presentation.js';
import { loadReadingLibrary, subscribeReadingLibrary, saveReadingArticle, addReadingHighlight, updateReadingHighlight,
  deleteReadingHighlight, saveReadingSettings, fetchReadingImage, removeReadingArticle } from '../lib/reading-library.js';
import { requestSiteAccess } from '../lib/site-info.js';
import { userErrorMessage } from '../lib/user-error.js';
import { exportReadingMarkdown } from '../lib/markdown-library.js';
import PromptDialog from './PromptDialog.jsx';
import { Button } from './ui/button.jsx';
import './reading-reader.css';

const defaults = { fontSize: 18, lineHeight: 1.8, theme: 'system' };
const permissionFailure = () => new Error(tr('尚未授权读取此网页，请授权后重试。'));
const originalOrigin = url => { try { return new URL(url).hostname; } catch { return ''; } };

function ReaderImage({ url, alt, fetchImage = fetchReadingImage, requestAccess = requestSiteAccess }) {
  const [source, setSource] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const work = useRef(null), lease = useRef(null), generation = useRef(0);
  useEffect(() => () => { generation.current++; work.current?.abort(); if (lease.current) URL.revokeObjectURL(lease.current); lease.current = null; }, [url]);
  function load() {
    if (work.current) return;
    // Request only this image's exact origin directly from its explicit click.
    let access;
    try { access = requestAccess(url); } catch (reason) { setError(userErrorMessage(reason)); return; }
    const request = ++generation.current, controller = new AbortController(); work.current = controller; setBusy(true); setError('');
    Promise.resolve(access).then(granted => { if (request !== generation.current || controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError'); if (!granted) throw permissionFailure(); return fetchImage(url, { signal: controller.signal }); }).then(blob => {
      if (request !== generation.current || controller.signal.aborted) return;
      const next = URL.createObjectURL(blob); if (lease.current) URL.revokeObjectURL(lease.current); lease.current = next; setSource(next);
    }).catch(reason => { if (request === generation.current && reason?.name !== 'AbortError') setError(userErrorMessage(reason, tr('图片未能加载，请重试。'))); })
      .finally(() => { if (request === generation.current) { work.current = null; setBusy(false); } });
  }
  return <div className="reading-reader-image">{source ? <img src={source} alt={alt} referrerPolicy="no-referrer" />
    : <Button type="button" variant="secondary" disabled={busy} onClick={load}>{busy ? tr('正在加载图片…') : tr('点击加载图片')}</Button>}
    {error && <p className="form-error" role="alert">{error}</p>}</div>;
}

function markedText(block, highlights, onSelect) {
  const marks = highlights.filter(item => item.start < block.end && item.end > block.start), points = new Set([0, block.text.length]);
  for (const item of marks) { points.add(Math.max(0, item.start - block.start)); points.add(Math.min(block.text.length, item.end - block.start)); }
  const positions = [...points].sort((a, b) => a - b);
  return positions.slice(0, -1).map((start, index) => {
    const end = positions[index + 1], highlight = marks.find(item => item.start <= block.start + start && item.end >= block.start + end);
    const value = block.text.slice(start, end);
    return highlight ? <mark key={start} role="button" tabIndex={0} data-reading-highlight-id={highlight.id} title={highlight.note || tr('高亮')}
      onClick={() => onSelect(highlight)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(highlight); } }}>{value}</mark> : <span key={start}>{value}</span>;
  });
}

export default function ReadingReader({ record, Dialog, hidden = false, exportBlocked = false, preferencesRevision, onClose, onBusyChange, onDirtyChange,
  loadLibrary = loadReadingLibrary, subscribeLibrary = subscribeReadingLibrary, saveArticle = saveReadingArticle,
  addHighlight = addReadingHighlight, updateHighlight = updateReadingHighlight, deleteHighlight = deleteReadingHighlight,
  saveSettings = saveReadingSettings, fetchImage = fetchReadingImage, requestAccess = requestSiteAccess, exportMarkdown = exportReadingMarkdown, removeArticle = removeReadingArticle }) {
  const presentation = useContext(PresentationContext), hiddenNow = hidden || presentation.active && presentation.hiddenKeys.has(`reading:${record?.id}`);
  const [library, setLibrary] = useState(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [selection, setSelection] = useState(null), [editing, setEditing] = useState(null), [note, setNote] = useState(''), [discard, setDiscard] = useState(null);
  const [removingCache, setRemovingCache] = useState(false);
  const active = useRef(true), generation = useRef(0), working = useRef(false), body = useRef(null), frame = useRef(null), callbacks = useRef(null);
  frame.current = { id: record?.id, url: record?.url, hidden: hiddenNow, exportBlocked };
  callbacks.current = { onClose, onBusyChange, onDirtyChange };
  const cached = library?.articles?.[record?.id], article = cached?.url === record?.url ? cached : null;
  const settings = library?.settings || defaults, highlights = article?.highlights || [];
  const dirty = editing ? note !== editing.note : Boolean(selection && note);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    active.current = true; let changed = false; const request = ++generation.current, id = record?.id, url = record?.url;
    setLibrary(null); setLoading(true); setSelection(null); setEditing(null); setNote(''); setError('');
    const current = () => active.current && request === generation.current && !frame.current.hidden && frame.current.id === id && frame.current.url === url;
    if (hiddenNow || !id) { callbacks.current.onClose?.(); setLoading(false); return; }
    loadLibrary().then(value => { if (current() && !changed) setLibrary(value); }).catch(reason => { if (current() && !changed) setError(userErrorMessage(reason)); }).finally(() => { if (current()) setLoading(false); });
    const unsubscribe = subscribeLibrary(value => { changed = true; if (current()) { setLibrary(value); setLoading(false); } });
    return () => { generation.current++; active.current = false; unsubscribe(); callbacks.current.onDirtyChange?.(false); if (working.current) callbacks.current.onBusyChange?.(false); };
  }, [record?.id, record?.url, hiddenNow, loadLibrary, subscribeLibrary]);
  useEffect(() => { if (!dirty) { setSelection(null); setEditing(null); setNote(''); } }, [article?.text]);
  function guard() { return { expectedRevision: article?.revision, expectedPreferencesRevision: preferencesRevision, expectedReadingRevision: record.revision }; }
  async function run(action) {
    if (working.current || frame.current.hidden) return;
    const request = generation.current, id = record.id; working.current = true; setBusy(true); setError(''); callbacks.current.onBusyChange?.(true);
    try {
      await action();
      const next = await loadLibrary();
      if (active.current && request === generation.current && !frame.current.hidden && frame.current.id === id) setLibrary(next);
    } catch (reason) { if (active.current && request === generation.current && !frame.current.hidden) setError(userErrorMessage(reason, tr('阅读内容未能保存，请重试。'))); }
    finally { working.current = false; if (active.current && request === generation.current) { setBusy(false); callbacks.current.onBusyChange?.(false); } }
  }
  function retry() {
    if (working.current || frame.current.hidden) return;
    if (dirty) { setError(tr('请先保存或取消当前批注。')); return; }
    let access;
    try { access = requestAccess(record.url); } catch (reason) { setError(userErrorMessage(reason)); return; }
    run(async () => {
      if (!await access) throw permissionFailure();
      if (!active.current || frame.current.hidden || frame.current.id !== record.id) return;
      const value = await saveArticle(record, { expectedPreferencesRevision: preferencesRevision });
      if (!value) throw new Error(tr('未能提取正文，链接仍保留。可打开原网页阅读。'));
    });
  }
  function captureSelection() {
    if (!article || working.current || frame.current.hidden) return;
    if (dirty) return;
    const chosen = globalThis.getSelection?.(); if (!chosen?.rangeCount || chosen.isCollapsed) return;
    const range = chosen.getRangeAt(0), element = node => node.nodeType === 1 ? node : node.parentElement;
    const first = element(range.startContainer)?.closest('[data-reading-block-start]'), last = element(range.endContainer)?.closest('[data-reading-block-start]');
    if (!first || !last || !body.current?.contains(first) || !body.current.contains(last)) return;
    const startRoot = first.querySelector('[data-reading-block-text]'), endRoot = last.querySelector('[data-reading-block-text]');
    if (!startRoot?.contains(range.startContainer) || !endRoot?.contains(range.endContainer)) return;
    try {
      const from = range.cloneRange(), to = range.cloneRange(); from.selectNodeContents(startRoot); from.setEnd(range.startContainer, range.startOffset); to.selectNodeContents(endRoot); to.setEnd(range.endContainer, range.endOffset);
      const start = Number(first.dataset.readingBlockStart) + from.toString().length, end = Number(last.dataset.readingBlockStart) + to.toString().length;
      if (start >= end || !article.text.slice(start, end).trim()) return;
      if (end - start > 6000) { setError(tr('所选文字过长，请缩小范围。')); return; }
      setSelection({ start, end, quote: article.text.slice(start, end) }); setEditing(null); setNote(''); setError('');
    } catch { /* A selection outside article text is not an annotation. */ }
  }
  function editHighlight(value) {
    if (working.current) return;
    if (dirty) { if (editing?.id !== value.id) setDiscard({ highlight: value }); return; }
    setEditing(value); setSelection(null); setNote(value.note); setError('');
  }
  function saveAnnotation() {
    if (!article || (!selection && !editing)) return;
    const selected = selection, edit = editing, value = note;
    run(async () => {
      if (edit) await updateHighlight(record.id, edit.id, { note: value }, { ...guard(), expectedHighlightRevision: edit.revision });
      else await addHighlight(record.id, { ...selected, note: value }, guard());
      if (active.current && !frame.current.hidden) { setSelection(null); setEditing(null); setNote(''); }
    });
  }
  function close() { if (!working.current) { if (dirty) setDiscard({}); else onClose?.(); } }
  function removeAnnotation(value) {
    run(async () => {
      await deleteHighlight(record.id, value.id, { ...guard(), expectedHighlightRevision: value.revision });
      if (editing?.id === value.id && active.current && !frame.current.hidden) { setEditing(null); setSelection(null); setNote(''); }
    });
  }
  function downloadMarkdown() {
    if (dirty || frame.current.exportBlocked) return;
    run(async () => {
      const result = await exportMarkdown(record.id, { expectedReadingRevision: record.revision, expectedArticleRevision: article?.revision, expectedPreferencesRevision: preferencesRevision });
      if (!active.current || frame.current.hidden || frame.current.exportBlocked) return;
      const url = URL.createObjectURL(result.blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  const staleAnnotation = editing && highlights.find(item => item.id === editing.id)?.revision !== editing.revision
    || selection && article?.text.slice(selection.start, selection.end) !== selection.quote;
  if (hiddenNow || !record) return null;
  return <Dialog title={tr('阅读')} wide maximizable className="reading-reader-modal" privacyKeys={[`reading:${record.id}`]} closeDisabled={busy} onClose={close}>
    <div className="reading-reader" data-reader-theme={settings.theme} style={{ '--reader-font-size': `${settings.fontSize}px`, '--reader-line-height': settings.lineHeight }}>
      <div className="reading-reader-toolbar"><a href={record.url} target="_blank" rel="noreferrer noopener">{tr('打开原网页')} · {originalOrigin(record.url)}</a>
        <Button type="button" variant="ghost" disabled={busy || exportBlocked || dirty} onClick={downloadMarkdown}>{tr('导出 Markdown')}</Button>
        {cached && <Button type="button" variant="ghost" disabled={busy || dirty} onClick={() => setRemovingCache(true)}>{tr('移除本机正文')}</Button>}
        <div className="reading-reader-display"><label>{tr('字号')}<select aria-label={tr('字号')} value={settings.fontSize} disabled={busy || !library} onChange={event => run(() => saveSettings({ fontSize: Number(event.target.value) }, { expectedRevision: library.revision }))}>{[16, 18, 20, 22, 24, 28].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label>{tr('行距')}<select aria-label={tr('行距')} value={settings.lineHeight} disabled={busy || !library} onChange={event => run(() => saveSettings({ lineHeight: Number(event.target.value) }, { expectedRevision: library.revision }))}>{[1.5, 1.8, 2, 2.2].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label>{tr('阅读外观')}<select aria-label={tr('阅读外观')} value={settings.theme} disabled={busy || !library} onChange={event => run(() => saveSettings({ theme: event.target.value }, { expectedRevision: library.revision }))}><option value="system">{tr('跟随系统')}</option><option value="light">{tr('浅色')}</option><option value="dark">{tr('深色')}</option></select></label></div>
      </div>
      <p className="hint">{tr('这是未加密的 Markdown 交换文件，不包含隐藏内容或附件。')}</p>
      {loading && <p className="hint" role="status">{tr('正在读取本机正文…')}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!loading && !article && <div className="reading-reader-empty"><h2>{record.title}</h2><p>{tr('此链接尚未保存正文。')}</p><Button type="button" variant="secondary" disabled={busy} onClick={retry}>{busy ? tr('正在提取正文…') : tr('提取正文')}</Button><p className="hint">{tr('只在你点击后读取原网页，并把正文保存到本机。')}</p></div>}
      {article && <div className={`reading-reader-workspace${highlights.length || selection || editing ? ' has-annotations' : ''}`}>
        <article ref={body} className="reading-reader-article" onMouseUp={captureSelection} onKeyUp={event => { if (event.shiftKey) captureSelection(); }}>
          <h1>{article.title || record.title}</h1>
          {article.blocks.map((block, index) => {
            const text = <span data-reading-block-text>{markedText(block, highlights, editHighlight)}</span>, props = { 'data-reading-block-start': block.start };
            if (block.type === 'image') return <figure key={index} {...props}><figcaption>{text}</figcaption><ReaderImage key={block.url} url={block.url} alt={block.text} fetchImage={fetchImage} requestAccess={requestAccess} /></figure>;
            if (block.type === 'heading') { const Heading = `h${Math.min(6, Math.max(2, block.level || 2))}`; return <Heading key={index} {...props}>{text}</Heading>; }
            if (block.type === 'quote') return <blockquote key={index} {...props}>{text}</blockquote>;
            return <p key={index} {...props} className={block.type === 'list-item' ? 'reading-reader-list-item' : undefined}>{text}</p>;
          })}
          <div className="reading-reader-article-actions"><Button type="button" variant="ghost" disabled={busy} onClick={retry}>{tr('重新提取正文')}</Button></div>
        </article>
        {(highlights.length > 0 || selection || editing) && <aside className="reading-reader-annotations" aria-label={tr('高亮与批注')}>
          <h2>{tr('高亮与批注')}</h2>
          {(selection || editing) && <div className="reading-reader-annotation-draft"><blockquote>{selection?.quote || editing.quote}</blockquote><label>{tr('批注')}<textarea aria-label={tr('批注')} rows={3} maxLength={2000} value={note} disabled={busy} onChange={event => setNote(event.target.value)} /></label>
            {staleAnnotation && <p className="form-error">{tr('这条批注已更新，请重新选择。')}</p>}
            <div><Button type="button" variant="ghost" disabled={busy} onClick={() => { setSelection(null); setEditing(null); setNote(''); }}>{tr('取消')}</Button><Button type="button" disabled={busy || staleAnnotation} onClick={saveAnnotation}>{editing ? tr('保存批注') : tr('保存高亮')}</Button></div></div>}
          {highlights.map(value => <div className="reading-reader-annotation" key={value.id}><blockquote>{value.quote}</blockquote>{value.note && <p>{value.note}</p>}<small>{new Date(value.updatedAt).toLocaleDateString(getLocale())}</small><div><Button type="button" variant="ghost" disabled={busy} onClick={() => editHighlight(value)}>{tr('编辑批注')}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => removeAnnotation(value)}>{tr('删除高亮')}</Button></div></div>)}
        </aside>}
      </div>}
      {discard && <PromptDialog title={tr('放弃修改')} action={tr('放弃修改')} onCancel={() => setDiscard(null)} onConfirm={() => {
        if (discard.highlight) { setEditing(discard.highlight); setSelection(null); setNote(discard.highlight.note); setDiscard(null); }
        else onClose?.();
      }}><p>{tr('批注尚未保存，放弃修改？')}</p></PromptDialog>}
      {removingCache && <PromptDialog title={tr('移除本机正文')} action={tr('移除正文')} destructive busy={busy} onCancel={() => setRemovingCache(false)} onConfirm={() => run(async () => {
        await removeArticle(record.id, { expectedRevision: cached.revision, expectedReadingRevision: record.revision, expectedPreferencesRevision: preferencesRevision });
        if (active.current && !frame.current.hidden) { setRemovingCache(false); setSelection(null); setEditing(null); setNote(''); }
      })}><p>{tr('移除此链接保存的正文、高亮和批注？稍后读链接会保留，可重新提取正文。')}</p></PromptDialog>}
    </div>
  </Dialog>;
}
