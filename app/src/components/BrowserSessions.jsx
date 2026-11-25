import { forwardRef, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { tr, formatNumber, getLocale } from '../i18n/index.js';
import * as browserSessionApi from '../lib/browser-sessions.js';
import * as browserCommandApi from '../lib/browser-command.js';
import { PresentationContext } from '../lib/presentation.js';
import { userErrorMessage } from '../lib/user-error.js';
import PromptDialog from './PromptDialog.jsx';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';

const empty = { version: 1, revision: 0, sessions: [] };
const date = value => new Date(value).toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' });
const statuses = () => ({ pending: tr('待打开'), opened: tr('已打开'), skipped: tr('已存在，已跳过'), failed: tr('打开失败') });
const imeEvent = (event, composing) => composing || event?.isComposing || event?.keyCode === 229 || event?.nativeEvent?.isComposing || event?.nativeEvent?.keyCode === 229;

function BrowserSessions({ query = '', browserApi = browserCommandApi, sessionsApi = browserSessionApi, onBusyChange, onSelectionChange }, ref) {
  const presentation = useContext(PresentationContext), hidden = presentation.active;
  const [envelope, setEnvelope] = useState(null), [permission, setPermission] = useState(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [capture, setCapture] = useState(null), [renaming, setRenaming] = useState(null), [removing, setRemoving] = useState(null), [restore, setRestore] = useState(null);
  const [selected, setSelected] = useState(0), sessionList = useRef(null);
  const mounted = useRef(true), working = useRef(false), composing = useRef(false), readGeneration = useRef(0), permissionGeneration = useRef(0), current = useRef(null), callback = useRef(onBusyChange);
  current.current = { hidden, envelope, capture, restore }; callback.current = onBusyChange;
  const visible = () => mounted.current && !current.current.hidden;
  async function read() {
    if (!visible()) return;
    const request = ++readGeneration.current;
    setLoading(true);
    try {
      const value = await sessionsApi.loadBrowserSessions();
      if (!visible() || request !== readGeneration.current) return;
      setEnvelope(previous => previous && previous.revision > value.revision ? previous : value);
      setRestore(previous => {
        if (!previous) return null;
        const record = value.sessions.find(item => item.id === previous.session.id);
        return record?.revision === previous.session.revision ? previous : null;
      });
    } catch (reason) { if (visible() && request === readGeneration.current) { setEnvelope(null); setError(userErrorMessage(reason, tr('本机会话未能读取，请重试。'))); } }
    finally { if (visible() && request === readGeneration.current) setLoading(false); }
  }
  async function readPermission() {
    const request = ++permissionGeneration.current;
    try { const value = await browserApi.browserCommandPermissions('tabs'); if (visible() && request === permissionGeneration.current) setPermission(value); }
    catch { if (visible() && request === permissionGeneration.current) setPermission({ available: false, granted: false }); }
  }
  function cancelRestore() {
    const preview = current.current.restore?.original;
    if (preview) { try { sessionsApi.cancelBrowserSessionRestore?.(preview); } catch { /* An expired preview is already stopped. */ } }
  }
  useEffect(() => {
    mounted.current = true;
    if (!hidden) { read(); readPermission(); }
    const unsubscribe = hidden ? null : sessionsApi.subscribeBrowserSessions(() => read());
    const permissionChanged = () => {
      cancelRestore(); setCapture(previous => previous ? { ...previous, preview: null } : null); setRestore(null); setPermission(null); readPermission();
    };
    const stopPermissions = hidden ? null : browserApi.subscribeBrowserCommandPermissions?.(permissionChanged);
    return () => { mounted.current = false; readGeneration.current++; permissionGeneration.current++; cancelRestore(); unsubscribe?.(); stopPermissions?.(); if (working.current) callback.current?.(false); };
  }, [sessionsApi, browserApi, hidden]);
  useEffect(() => {
    const preview = restore?.original;
    return () => { if (preview) { try { sessionsApi.cancelBrowserSessionRestore?.(preview); } catch { /* No pending restore remains. */ } } };
  }, [restore?.original, sessionsApi]);
  async function operation(action) {
    if (!visible() || working.current || composing.current) return;
    working.current = true; setBusy(true); setError(''); callback.current?.(true);
    try { await action(); }
    catch (reason) { if (visible()) setError(userErrorMessage(reason, tr('本机会话操作未完成，请刷新后重试。'))); }
    finally { working.current = false; if (mounted.current) setBusy(false); callback.current?.(false); }
  }
  function authorize() {
    if (!visible() || working.current || composing.current) return;
    let request;
    // No async work precedes this explicit permission request.
    try { request = browserApi.requestBrowserCommandPermission('tabs'); }
    catch (reason) { setError(userErrorMessage(reason, tr('未获得浏览器访问权限，请重试授权。'))); return; }
    operation(async () => {
      const granted = await request;
      if (!visible()) return;
      if (!granted) setError(tr('未获得浏览器访问权限，请重试授权。'));
      await readPermission();
    });
  }
  function previewCapture() {
    if (!capture?.title.trim() || !permission?.granted) return;
    const permissionEpoch = permissionGeneration.current;
    operation(async () => {
      const preview = await sessionsApi.previewCurrentBrowserSession();
      if (visible() && permissionEpoch === permissionGeneration.current) setCapture(previous => previous ? { ...previous, preview } : null);
    });
  }
  function saveCapture() {
    const draft = capture, revision = envelope?.revision;
    if (!draft?.preview || !draft.title.trim() || !Number.isSafeInteger(revision)) return;
    operation(async () => {
      await sessionsApi.captureCurrentBrowserSession({ title: draft.title.trim(), preview: draft.preview }, { expectedRevision: revision });
      if (visible()) { setCapture(null); await read(); }
    });
  }
  function rename(event) {
    event.preventDefault();
    const draft = renaming;
    if (!draft?.title.trim() || imeEvent(event, composing.current)) return;
    operation(async () => {
      await sessionsApi.renameBrowserSession(draft.record.id, draft.title.trim(), { expectedRevision: draft.record.revision });
      if (visible()) { setRenaming(null); await read(); }
    });
  }
  function remove() {
    const record = removing;
    operation(async () => {
      await sessionsApi.deleteBrowserSession(record.id, { expectedRevision: record.revision });
      if (visible()) { setRemoving(null); if (restore?.session.id === record.id) setRestore(null); await read(); }
    });
  }
  function previewRestore(record, selection) {
    if (!permission?.granted) { setError(tr('请先授权读取此浏览器来源。')); return; }
    const permissionEpoch = permissionGeneration.current;
    operation(async () => {
      const preview = await sessionsApi.previewBrowserSessionRestore(record.id, { expectedRevision: record.revision, ...(selection ? { selectedUrls: [...selection] } : {}) });
      if (visible() && permissionEpoch === permissionGeneration.current) setRestore({ session: record, original: preview, progress: preview, selection: selection || new Set(record.tabs.map(tab => tab.url)), dirty: false, started: false });
      else { try { sessionsApi.cancelBrowserSessionRestore?.(preview); } catch { /* The discarded capability cannot start a batch. */ } }
    });
  }
  function restoreBatch(retryFailed = false) {
    const attempt = restore;
    if (!attempt || attempt.dirty) return;
    operation(async () => {
      try {
        const progress = await sessionsApi.restoreBrowserSessionBatch(attempt.original, { retryFailed });
        if (visible()) setRestore(previous => previous?.original === attempt.original ? { ...previous, progress, started: true } : previous);
      } catch (reason) {
        if (visible() && reason?.progress) setRestore(previous => previous?.original === attempt.original ? { ...previous, progress: reason.progress, started: true } : previous);
        throw reason;
      }
    });
  }
  const sessions = useMemo(() => {
    if (hidden) return [];
    const terms = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
    return (envelope || empty).sessions.filter(record => terms.every(term => `${record.title} ${record.tabs.map(tab => `${tab.title} ${tab.url}`).join(' ')}`.normalize('NFKC').toLocaleLowerCase().includes(term)));
  }, [query, envelope, hidden]);
  const selectedIndex = Math.min(selected, Math.max(0, sessions.length - 1));
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { onSelectionChange?.({ count: sessions.length, activeId: sessions[selectedIndex] ? `browser-session-result-${selectedIndex}` : undefined }); }, [sessions, selectedIndex, onSelectionChange]);
  useEffect(() => { sessionList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [selectedIndex]);
  useImperativeHandle(ref, () => ({
    moveSelection(delta) { if (!working.current && !composing.current && sessions.length) setSelected(value => (value + delta + sessions.length) % sessions.length); },
    activateSelection() { if (!working.current && !composing.current && sessions[selectedIndex]) previewRestore(sessions[selectedIndex]); },
  }));
  if (hidden) return null;
  const states = statuses(), progress = restore?.progress;
  return <section className="browser-sessions" aria-label={tr('本机会话')} aria-busy={busy || loading}
    onCompositionStartCapture={() => { composing.current = true; }} onCompositionEndCapture={() => { composing.current = false; }}
    onKeyDownCapture={event => { if (imeEvent(event, composing.current) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); } }}>
    <p className="hint">{tr('仅保存当前普通窗口的链接，不关闭原标签。会话仅保存在此设备，不参与同步和备份。')}</p>
    <div className="browser-session-toolbar"><Button type="button" disabled={busy || !envelope} onClick={() => { if (!composing.current) { cancelRestore(); setCapture({ title: '', preview: null }); setRestore(null); setError(''); } }}>{tr('保存当前窗口')}</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={read}>{tr('刷新会话')}</Button></div>
    {permission && !permission.granted && <div className="command-source-notice"><p>{tr('保存窗口和恢复预览需要可选的标签页权限，用于核对标题、网址和已打开的链接。')}</p>
      {permission.available ? <Button type="button" disabled={busy} onClick={authorize}>{tr('授权读取标签页')}</Button> : <p>{tr('此来源需要受支持的浏览器扩展环境。')}</p>}</div>}
    {capture && <form className="browser-session-form" onSubmit={event => { event.preventDefault(); if (!imeEvent(event, composing.current)) previewCapture(); }}>
      <label>{tr('会话名称')}<Input aria-label={tr('会话名称')} value={capture.title} maxLength={80} autoComplete="off" disabled={busy}
        onChange={event => setCapture(previous => ({ ...previous, title: event.target.value }))} /></label>
      {!capture.preview ? <Button type="submit" disabled={busy || !capture.title.trim() || !permission?.granted}>{tr('预览当前窗口')}</Button> : <>
        <p role="status">{tr('可保存 {0} 个链接，重复 {1} 个，不支持 {2} 个。', [formatNumber(capture.preview.supported), formatNumber(capture.preview.duplicates), formatNumber(capture.preview.unsupported)])}</p>
        <ul className="browser-session-tab-preview">{capture.preview.tabs.map(tab => <li key={tab.url}><strong dir="auto">{tab.title || tab.url}</strong><small dir="auto">{tab.url}</small></li>)}</ul>
        <Button type="button" disabled={busy || !capture.title.trim() || !capture.preview.tabs.length} onClick={saveCapture}>{tr('确认保存会话')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={previewCapture}>{tr('重新预览窗口')}</Button>
      </>}
      <Button type="button" variant="ghost" disabled={busy} onClick={() => setCapture(null)}>{tr('取消')}</Button>
    </form>}
    {loading && <p className="hint" role="status">{tr('正在读取本机会话…')}</p>}
    {envelope && <div ref={sessionList} id="browser-session-results" className="browser-session-list" role="listbox" aria-label={tr('已保存的本机会话')}>
      {sessions.map((record, index) => <div id={`browser-session-result-${index}`} className="browser-session-record" role="option" aria-selected={index === selectedIndex} key={record.id} onMouseMove={() => setSelected(index)}>
        {renaming?.record.id === record.id ? <form className="browser-session-rename" onSubmit={rename}><Input aria-label={tr('新的会话名称')} value={renaming.title} maxLength={80} disabled={busy}
          onChange={event => setRenaming(previous => ({ ...previous, title: event.target.value }))} /><Button type="submit" disabled={busy || !renaming.title.trim()}>{tr('保存名称')}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setRenaming(null)}>{tr('取消')}</Button></form>
          : <><div className="browser-session-summary"><strong dir="auto">{record.title}</strong><small>{tr('{0} 个链接', [formatNumber(record.tabs.length)])} · {date(record.updatedAt)}</small></div>
            <div className="browser-session-actions"><Button type="button" variant="ghost" disabled={busy || !permission?.granted} onClick={() => { setCapture(null); previewRestore(record); }}>{tr('预览恢复')}</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => { setRenaming({ record, title: record.title }); setError(''); }}>{tr('重命名')}</Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setRemoving(record)}>{tr('删除')}</Button></div></>}
      </div>)}
      {!sessions.length && <p className="tool-empty">{tr('没有匹配的本机会话。')}</p>}
    </div>}
    {restore && <section className="browser-session-restore" aria-label={tr('会话恢复预览')}>
      <h3 dir="auto">{restore.session.title}</h3><p className="hint">{tr('每次最多打开 10 个后台标签。继续下一批需要再次点击，不会关闭现有标签。')}</p>
      <ul className="browser-session-tab-preview">{restore.session.tabs.map(tab => {
        const status = progress.tabs.find(item => item.url === tab.url)?.status;
        return <li key={tab.url}><label><input type="checkbox" checked={restore.selection.has(tab.url)} disabled={busy || restore.started}
          onChange={event => setRestore(previous => { const selection = new Set(previous.selection); if (event.target.checked) selection.add(tab.url); else selection.delete(tab.url); return { ...previous, selection, dirty: true }; })} />
          <span><strong dir="auto">{tab.title || tab.url}</strong><small dir="auto">{tab.url}</small><small>{restore.selection.has(tab.url) ? states[status] || tr('待预览') : tr('未选择')}</small></span></label></li>;
      })}</ul>
      {restore.dirty ? <Button type="button" disabled={busy || !restore.selection.size} onClick={() => previewRestore(restore.session, restore.selection)}>{tr('更新恢复预览')}</Button>
        : <><p role="status">{tr('已打开 {0}，已跳过 {1}，失败 {2}，剩余 {3}。', [formatNumber(progress.opened), formatNumber(progress.skipped), formatNumber(progress.failed), formatNumber(progress.pending)])}</p>
          {progress.pending > 0 && <Button type="button" disabled={busy} onClick={() => restoreBatch()}>{restore.started ? tr('继续下一批') : tr('确认恢复，打开第一批')}</Button>}
          {!progress.pending && progress.failed > 0 && <Button type="button" disabled={busy} onClick={() => restoreBatch(true)}>{tr('重试失败的标签页')}</Button>}
          {progress.complete && <p className="hint" role="status">{tr('会话恢复已完成。')}</p>}
        </>}
      <Button type="button" variant="ghost" disabled={busy} onClick={() => { cancelRestore(); setRestore(null); }}>{tr('关闭恢复预览')}</Button>
    </section>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {removing && <PromptDialog title={tr('删除本机会话')} action={tr('删除')} busy={busy} destructive onConfirm={remove} onCancel={() => setRemoving(null)}>
      <p>{tr('删除会话“{0}”？已打开的标签页不会关闭。', [removing.title])}</p>
    </PromptDialog>}
  </section>;
}
export default forwardRef(BrowserSessions);
