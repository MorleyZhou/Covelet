import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowCounterClockwise, FolderSimple, Trash } from '@phosphor-icons/react';
import { tr, getLocale, formatNumber } from '../i18n/index.js';
import { getNavigationTrash, prepareTrashRestore, commitTrashRestore, commitTrashDelete } from '../lib/navigation-trash.js';
import { desktopPageName, logicalDesktopPages } from '../lib/desktop-pages.js';
import { PresentationContext, privateContentKeys } from '../lib/presentation.js';
import { userErrorMessage } from '../lib/user-error.js';
import { loadState } from '../lib/storage.js';
import { loadContentPreferences } from '../lib/content-preferences.js';
import NavigationDestination from './NavigationDestination.jsx';
import PromptDialog from './PromptDialog.jsx';
import { Button } from './ui/button.jsx';
import './navigation-trash.css';

const dateLabel = (value) => new Date(value).toLocaleDateString(getLocale(), { year: 'numeric', month: 'short', day: 'numeric' });

export default function NavigationTrash({ navigation: suppliedNavigation, preferences: suppliedPreferences, Dialog, onBusyChange, onStateChange, beforeOperation, disabled = false }) {
  const presentation = useContext(PresentationContext), working = useRef(false);
  const [snapshot, setSnapshot] = useState(null);
  const navigation = snapshot?.navigation.revision > suppliedNavigation.revision ? snapshot.navigation : suppliedNavigation;
  const preferences = snapshot?.preferences.revision > suppliedPreferences.revision ? snapshot.preferences : suppliedPreferences;
  const [now, setNow] = useState(Date.now), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [restoring, setRestoring] = useState(null), [deleting, setDeleting] = useState(null);
  const locked = presentation.active || preferences.presentation;
  const effectivePreferences = useMemo(() => ({ ...preferences, presentation: locked }), [preferences, locked]);
  const hiddenKeys = privateContentKeys(navigation, effectivePreferences);
  for (const key of presentation.hiddenKeys) hiddenKeys.add(key);
  const rows = disabled ? [] : getNavigationTrash(navigation, effectivePreferences, { now });
  const visibleIds = new Set(rows.map((row) => row.id));
  const restoredRow = restoring && rows.find((row) => row.id === restoring.trashId);
  const restoreFresh = restoring && restoring.plan.expectedNavigationRevision === navigation.revision && restoring.plan.expectedPreferencesRevision === preferences.revision;
  const restoreVisible = restoredRow && restoring.plan.status !== 'hidden';
  const canRestore = !disabled && !busy && restoreVisible && restoreFresh && restoring.plan.status === 'ready';
  const deleteFresh = deleting && deleting.expectedNavigationRevision === navigation.revision && deleting.expectedPreferencesRevision === preferences.revision && deleting.ids.every((id) => visibleIds.has(id));
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer = setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  function targetLabel(target) {
    if (!target) return tr('请选择恢复位置');
    const desktop = desktopPageName(navigation.settings, target.page);
    const folder = target.parentId && navigation.entries.find((entry) => entry.id === target.parentId && entry.type === 'folder');
    return folder && (!locked || !hiddenKeys.has(`folder:${folder.id}`)) ? `${desktop} › ${folder.name}` : desktop;
  }
  function originLabel(row) {
    const identity = row.origin?.desktopId;
    const found = identity && Object.entries(navigation.settings.desktopPages || {}).find(([, value]) => value.id === identity);
    const page = identity ? found ? Number(found[0]) : null : row.origin?.page ?? 0;
    if (page === null || !logicalDesktopPages(navigation).includes(page)) return tr('原位置已失效');
    if (row.origin?.parentId) {
      const folder = navigation.entries.find((entry) => entry.id === row.origin.parentId && entry.type === 'folder');
      if (!folder || locked && hiddenKeys.has(`folder:${folder.id}`)) return tr('原位置不可用');
      return `${desktopPageName(navigation.settings, folder.page ?? page)} › ${folder.name}`;
    }
    return desktopPageName(navigation.settings, page);
  }
  async function freshSnapshot() {
    await beforeOperation?.();
    const [nextNavigation, nextPreferences] = await Promise.all([loadState(), loadContentPreferences()]);
    setSnapshot({ navigation: nextNavigation, preferences: nextPreferences });
    return { navigation: nextNavigation, preferences: { ...nextPreferences, presentation: presentation.active || nextPreferences.presentation } };
  }
  function prepare(id, destinationValue) {
    if (busy || disabled || !visibleIds.has(id)) return;
    setNotice('');
    run(async () => {
      const fresh = await freshSnapshot();
      const plan = prepareTrashRestore(fresh.navigation, fresh.preferences, id, destinationValue ? { destinationValue } : {});
      setRestoring({ trashId: id, plan });
    });
  }
  async function run(action) {
    if (working.current || disabled) return;
    working.current = true; setBusy(true); onBusyChange?.(true); setError('');
    try { await action(); }
    catch (reason) { setError(userErrorMessage(reason)); }
    finally { working.current = false; setBusy(false); onBusyChange?.(false); }
  }
  function restore() {
    if (!canRestore) return;
    run(async () => {
      const result = await commitTrashRestore(restoring.plan);
      onStateChange?.(result.state); setRestoring(null); setNotice(tr('已恢复所选内容。'));
    });
  }
  function requestDelete(ids) {
    setNotice('');
    run(async () => {
      const fresh = await freshSnapshot();
      const freshIds = new Set(getNavigationTrash(fresh.navigation, fresh.preferences).map((row) => row.id));
      if (!ids.length || ids.some((id) => !freshIds.has(id))) throw Error(tr('回收站内容已变化，请重新选择。'));
      setDeleting({ ids: [...ids], expectedNavigationRevision: fresh.navigation.revision, expectedPreferencesRevision: fresh.preferences.revision });
    });
  }
  function permanentlyDelete() {
    if (!deleteFresh || busy) return;
    run(async () => {
      const result = await commitTrashDelete(deleting.ids, deleting);
      onStateChange?.(result.state || result); setDeleting(null); setNotice(tr('已永久删除所选内容。'));
    });
  }
  return <section className="navigation-trash" aria-label={tr('网站与文件夹回收站')} aria-busy={busy || undefined}>
    <div className="navigation-trash-heading"><h3>{tr('网站与文件夹')}</h3><span>{tr('{0} 条记录', [formatNumber(rows.length)])}</span>
      <Button type="button" variant="ghost" size="sm" disabled={busy || disabled || !rows.length} onClick={() => requestDelete(rows.map((row) => row.id))}>{tr('清空当前可见记录')}</Button></div>
    <p className="hint">{tr('网站和文件夹保留 30 天。恢复前可核对位置和成员。')}</p>
    <div className="navigation-trash-list">{rows.map((row) => <article className="navigation-trash-record" key={row.id} data-trash-id={row.id}>
      <div className="navigation-trash-content"><strong>{row.kind === 'folder' && <FolderSimple size={16} />}{row.title}</strong>
        {row.url && <span className="navigation-trash-url">{row.url}</span>}
        <small>{originLabel(row)} · {tr('删除于 {0}', [dateLabel(row.deletedAt)])}</small>
        {row.kind === 'folder' && <small>{tr('{0} 个网站，{1} 条成员记录', [formatNumber(row.siteCount), formatNumber(row.memberCount)])}</small>}
        <small>{tr('保留至 {0}', [dateLabel(row.expiresAt)])}</small></div>
      <div className="navigation-trash-actions"><Button type="button" variant="ghost" size="sm" disabled={busy || disabled} onClick={() => prepare(row.id)}><ArrowCounterClockwise size={16} />{tr('恢复')}</Button>
        <Button type="button" variant="ghost" size="icon" aria-label={tr('永久删除“{0}”', [row.title])} disabled={busy || disabled} onClick={() => requestDelete([row.id])}><Trash size={16} /></Button></div>
    </article>)}{!rows.length && <p className="navigation-trash-empty">{tr('回收站为空')}</p>}</div>
    {notice && <p className="hint" role="status">{notice}</p>}{error && !restoring && !deleting && <p className="form-error" role="alert">{error}</p>}
    {restoring && <Dialog title={tr('恢复网站或文件夹')} wide className="navigation-trash-preview-modal" closeDisabled={busy} onClose={() => { if (!busy) { setRestoring(null); setError(''); } }}>
      <div className="navigation-trash-preview">
        {!restoreVisible ? <p className="form-error" role="alert">{tr('回收站内容已变化，请重新选择。')}</p> : <>
          <strong>{restoredRow.title}</strong>
          <NavigationDestination state={navigation} preferences={{ ...effectivePreferences, privateKeys: [...hiddenKeys] }} allowFolders={restoredRow.kind !== 'folder'}
            value={restoring.plan.destinationValue || ''} disabled={busy} onChange={(value) => prepare(restoring.trashId, value)} />
          {restoring.plan.status === 'needs-destination' && <p className="hint">{tr('原位置不可用，请选择恢复位置。')}</p>}
          {!restoreFresh ? <p className="form-error" role="alert">{tr('内容已更新，请重新预览。')}</p> : restoring.plan.status === 'conflict' ? <p className="form-error" role="alert">{tr('恢复内容存在冲突，请重新选择位置。')}</p>
            : restoring.plan.status === 'ready' && <div className="navigation-trash-summary"><p>{tr('恢复到：{0}', [targetLabel(restoring.plan.target)])}</p>
              <p>{tr('将恢复 {0} 项，重新挂回 {1} 个成员，跳过 {2} 个已变化的成员。', [formatNumber(restoring.plan.restoredIds.length), formatNumber(restoring.plan.reattachIds.length), formatNumber(restoring.plan.skippedMemberIds.length)])}</p></div>}
          {!restoreFresh && <Button type="button" variant="secondary" disabled={busy} onClick={() => prepare(restoring.trashId, restoring.plan.destinationValue)}>{tr('重新预览')}</Button>}
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-footer"><Button type="button" variant="secondary" disabled={busy} onClick={() => { setRestoring(null); setError(''); }}>{tr('取消')}</Button><Button type="button" disabled={!canRestore} onClick={restore}>{tr('确认恢复')}</Button></div>
      </div>
    </Dialog>}
    {deleting && <PromptDialog title={tr('永久删除')} action={tr('永久删除')} destructive privacySafe busy={busy} confirmDisabled={!deleteFresh} onCancel={() => { setDeleting(null); setError(''); }} onConfirm={permanentlyDelete}>
      <p>{deleteFresh ? tr('永久删除当前选择的 {0} 条回收记录？此操作无法撤销。', [formatNumber(deleting.ids.length)]) : tr('回收站内容已变化，请重新选择。')}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </PromptDialog>}
  </section>;
}
