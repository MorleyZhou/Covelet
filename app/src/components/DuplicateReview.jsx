import { useContext, useMemo, useRef, useState } from 'react';
import { Copy, LockSimple, Trash } from '@phosphor-icons/react';
import { tr, formatNumber } from '../i18n/index.js';
import { findNavigationDuplicates, previewNavigationDuplicates, commitNavigationDuplicates } from '../lib/navigation-duplicates.js';
import { getContentTags } from '../lib/content-preferences.js';
import { desktopPageName, logicalDesktopPages } from '../lib/desktop-pages.js';
import { resourceLocation } from '../lib/resource-library.js';
import { PresentationContext, privateContentKeys } from '../lib/presentation.js';
import { userErrorMessage } from '../lib/user-error.js';
import { Button } from './ui/button.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs.jsx';
import './duplicate-review.css';

export default function DuplicateReview({ navigation, preferences, Dialog, onClose, onBusyChange, onStateChange }) {
  const presentation = useContext(PresentationContext), working = useRef(false);
  const [category, setCategory] = useState('same-location'), [selection, setSelection] = useState(null), [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const locked = presentation.active || preferences.presentation;
  const effectivePreferences = useMemo(() => ({ ...preferences, presentation: locked }), [preferences, locked]);
  const hiddenKeys = locked ? new Set([...privateContentKeys(navigation, effectivePreferences), ...presentation.hiddenKeys]) : new Set();
  const duplicates = findNavigationDuplicates(navigation, effectivePreferences, { hiddenKeys });
  const groups = category === 'same-location' ? duplicates.sameLocation : duplicates.crossLocation;
  const group = selection && groups.find((item) => item.id === selection.groupId);
  const selectionVisible = group && [selection.keepId, ...selection.removeIds].every((id) => group.items.some((item) => item.entry.id === id));
  const fresh = plan && plan.expectedNavigationRevision === navigation.revision && plan.expectedPreferencesRevision === preferences.revision;
  const previewVisible = selectionVisible && fresh;
  const canConfirm = !busy && previewVisible && plan?.status === 'ready';
  const tags = getContentTags(effectivePreferences, { hiddenKeys }), tagMap = new Map(tags.map((tag) => [tag.id, tag.name]));
  const pages = logicalDesktopPages(navigation), names = pages.map((page) => desktopPageName(navigation.settings, page));
  function location(entry) {
    const { page, folder } = resourceLocation(entry, navigation), name = desktopPageName(navigation.settings, page);
    const desktop = names.filter((item) => item === name).length > 1 ? `${name} · ${tr('第 {0} 屏', [formatNumber(pages.indexOf(page) + 1)])}` : name;
    return folder ? `${desktop} › ${folder.name}` : desktop;
  }
  function clearPreview() { setPlan(null); setError(''); setNotice(''); }
  function chooseGroup(next) {
    setSelection({ groupId: next.id, keepId: next.items[0].entry.id, removeIds: [], mergeMetadata: false }); clearPreview();
  }
  function chooseKeeper(id) {
    setSelection((current) => ({ ...current, keepId: id, removeIds: current.removeIds.filter((item) => item !== id) })); clearPreview();
  }
  function chooseRemoval(id, checked) {
    setSelection((current) => ({ ...current, removeIds: checked ? [...new Set([...current.removeIds, id])] : current.removeIds.filter((item) => item !== id) })); clearPreview();
  }
  function preview() {
    if (!selectionVisible || busy) return;
    setError(''); setNotice('');
    try { setPlan(previewNavigationDuplicates(navigation, effectivePreferences, selection, { hiddenKeys })); }
    catch (reason) { setError(userErrorMessage(reason)); }
  }
  async function confirm() {
    if (!canConfirm || working.current) return;
    working.current = true; setBusy(true); onBusyChange?.(true); setError('');
    try {
      const result = await commitNavigationDuplicates(plan);
      onStateChange?.(result.state); setPlan(null); setSelection(null);
      setNotice(tr('已将 {0} 个副本移入回收站。', [formatNumber(result.removedIds.length)]));
    } catch (reason) { setPlan(null); setError(userErrorMessage(reason)); }
    finally { working.current = false; setBusy(false); onBusyChange?.(false); }
  }
  const reasonMessage = plan?.reason === 'metadata-limits' ? tr('合并后的备注或标签超出限制，请减少所选副本。')
    : plan?.reason === 'empty-selection' ? tr('请选择要移入回收站的副本。') : tr('所选内容已变化，请重新选择。');
  return <Dialog title={tr('重复链接审阅')} wide className="duplicate-review-modal" closeDisabled={busy} onClose={onClose}>
    <div className="duplicate-review" aria-busy={busy || undefined}>
      <p className="hint">{tr('按完整网址识别重复项。请先选择保留项，再勾选要移入回收站的副本。')}</p>
      <Tabs value={category} onValueChange={(next) => { setCategory(next); setSelection(null); clearPreview(); }}>
        <TabsList aria-label={tr('重复链接分类')}><TabsTrigger value="same-location" disabled={busy}>{tr('同位置重复')} <span>{formatNumber(duplicates.sameLocation.length)}</span></TabsTrigger>
          <TabsTrigger value="cross-location" disabled={busy}>{tr('跨位置重复')} <span>{formatNumber(duplicates.crossLocation.length)}</span></TabsTrigger></TabsList>
      </Tabs>
      <div className="duplicate-review-body"><nav className="duplicate-review-groups" aria-label={tr('重复链接组')}>
        {groups.map((item) => <Button type="button" key={item.id} variant="unstyled" size="unstyled" className="duplicate-review-group" aria-pressed={group?.id === item.id} disabled={busy}
          onClick={() => chooseGroup(item)}><Copy size={16} /><span><strong>{item.items[0].entry.name}</strong><small>{item.url}</small><small>{tr('{0} 个副本', [formatNumber(item.items.length)])}</small></span></Button>)}
        {!groups.length && <p className="duplicate-review-empty">{tr('没有找到重复链接')}</p>}
      </nav><div className="duplicate-review-detail">
        {!group ? <p className="duplicate-review-empty">{selection ? tr('所选内容已变化，请重新选择。') : tr('选择一组重复链接开始审阅。')}</p> : <>
          <p className="duplicate-review-url">{group.url}</p>
          <div className="duplicate-review-items">{group.items.map((item) => <article key={item.entry.id} className="duplicate-review-item" data-entry-id={item.entry.id}>
            <div className="duplicate-review-item-heading"><strong>{item.entry.name}</strong>{item.private && <span className="duplicate-private-label"><LockSimple size={13} />{tr('隐藏内容')}</span>}</div>
            <small>{location(item.entry)}</small><span className="duplicate-review-original-url">{item.entry.url}</span>
            {item.description && <p className="duplicate-review-description">{item.description}</p>}
            {item.tags.length > 0 && <div className="duplicate-review-tags" aria-label={tr('标签')}>{item.tags.map((tag) => <span key={tag.id}>{tag.name}</span>)}</div>}
            <div className="duplicate-review-item-choices"><label><input type="radio" name="duplicate-keeper" checked={selection.keepId === item.entry.id} disabled={busy} onChange={() => chooseKeeper(item.entry.id)} /><span>{tr('保留“{0}”', [item.entry.name])}</span></label>
              <label><Checkbox checked={selection.removeIds.includes(item.entry.id)} disabled={busy || selection.keepId === item.entry.id} onCheckedChange={(checked) => chooseRemoval(item.entry.id, checked === true)} aria-label={tr('移除副本“{0}”', [item.entry.name])} /><span>{tr('移入回收站')}</span></label></div>
          </article>)}</div>
          <label className="duplicate-review-merge"><Checkbox checked={selection.mergeMetadata} disabled={busy} onCheckedChange={(checked) => { setSelection((current) => ({ ...current, mergeMetadata: checked === true })); clearPreview(); }} /><span>{tr('将所选副本的备注与标签合并到保留项')}</span></label>
          <p className="hint">{tr('未合并的备注与标签会随副本保留在回收站。')}</p>
          {!selectionVisible && <p className="form-error" role="alert">{tr('所选内容已变化，请重新选择。')}</p>}
          {plan && !previewVisible && <p className="form-error" role="alert">{tr('内容已更新，请重新预览。')}</p>}
          {previewVisible && <section className="duplicate-review-preview" aria-label={tr('处理预览')}>
            {plan.status !== 'ready' ? <p className="form-error" role="alert">{reasonMessage}</p> : <>
              <strong>{tr('将保留“{0}”，移入回收站 {1} 个副本。', [group.items.find((item) => item.entry.id === plan.keepId)?.entry.name || '', formatNumber(plan.removeCount)])}</strong>
              {plan.mergeMetadata && <><p className="hint">{tr('合并后的备注与标签')}</p><p className="duplicate-review-description">{plan.mergedMetadata.description || tr('暂无备注')}</p>
                <div className="duplicate-review-tags" aria-label={tr('标签')}>{plan.mergedMetadata.tagIds.map((id) => <span key={id}>{tagMap.get(id) || tr('标签已失效')}</span>)}</div></>}
              {plan.addedPrivateKeys.length > 0 && <p className="hint"><LockSimple size={14} />{tr('合并包含隐藏内容，保留项也将设为隐藏。')}</p>}
            </>}
          </section>}
        </>}
      </div></div>
      {notice && <p className="hint" role="status">{notice}</p>}{error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-footer"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{tr('关闭')}</Button>
        <Button type="button" variant="secondary" disabled={busy || !selectionVisible || !selection.removeIds.length} onClick={preview}>{plan ? tr('重新预览') : tr('预览')}</Button>
        <Button type="button" variant="destructive" disabled={!canConfirm} onClick={confirm}><Trash size={15} />{tr('移入回收站')}</Button></div>
    </div>
  </Dialog>;
}
