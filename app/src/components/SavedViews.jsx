import { useContext, useMemo, useRef, useState } from 'react';
import { PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import { tr, formatNumber } from '../i18n/index.js';
import { deleteSavedView, getContentTags, getSavedViews, loadContentPreferences } from '../lib/content-preferences.js';
import { defaultSavedFilters, filterSavedContent, resolveSavedView, viewFilters, SAVED_VIEW_LIMITS } from '../lib/saved-views.js';
import { desktopPageName, logicalDesktopPages } from '../lib/desktop-pages.js';
import { useLocalDateKey } from '../lib/use-local-date.js';
import { PresentationContext } from '../lib/presentation.js';
import { userErrorMessage } from '../lib/user-error.js';
import PromptDialog from './PromptDialog.jsx';
import Select from './Select.jsx';
import { Button } from './ui/button.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Input } from './ui/input.jsx';
import './saved-views.css';

function conditionMessage(result) {
  if (result.status === 'hidden') return tr('清单包含隐藏条件，请先解锁。');
  if (result.reason === 'missing-tag') return tr('清单中的标签已被删除，请调整条件。');
  if (result.reason === 'missing-desktop' || result.reason === 'missing-folder') return tr('清单中的范围已被删除，请重新选择。');
  return tr('筛选条件无效，请检查后重试。');
}

export default function SavedViews({ navigation, tools, preferences, initialFilters, Dialog, onApply, onSaveView, onClose, onBusyChange }) {
  const presentation = useContext(PresentationContext), working = useRef(false);
  const today = useLocalDateKey();
  const [editor, setEditor] = useState(null), [deleting, setDeleting] = useState(null), [discarding, setDiscarding] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = presentation.active || preferences.presentation;
  const effectivePreferences = useMemo(() => ({ ...preferences, presentation: locked }), [preferences, locked]);
  const hiddenKeys = locked ? presentation.hiddenKeys : undefined;
  const environment = { navigation, tools, preferences: effectivePreferences, hiddenKeys, today };
  const views = getSavedViews(effectivePreferences, { navigation, tools, hiddenKeys });
  const tags = getContentTags(effectivePreferences, { hiddenKeys });
  const typeOptions = [
    { value: 'all', label: tr('全部内容') }, { value: 'navigation', label: tr('网站与文件夹') }, { value: 'site', label: tr('网站') },
    { value: 'folder', label: tr('文件夹') }, { value: 'note', label: tr('便笺') },
    { value: 'reading', label: tr('稍后读') }, { value: 'desktop', label: tr('桌面') },
  ];
  const folderOptions = navigation.entries.filter((item) => item.type === 'folder' && !item.detached
    && (!locked || !presentation.hiddenKeys.has(`folder:${item.id}`) && !preferences.privateKeys.includes(`folder:${item.id}`)))
    .map((item) => ({ value: `folder:${item.id}`, label: `${desktopPageName(navigation.settings, item.page ?? 0)} / ${item.name}` }));
  const scopeOptions = [{ value: 'all', label: tr('全部位置') },
    ...logicalDesktopPages(navigation).map((page) => ({ value: `desktop:${navigation.settings.desktopPages?.[page]?.id || `@page:${page}`}`,
      label: desktopPageName(navigation.settings, page) })), ...folderOptions];
  const value = editor?.value;
  const originalView = editor?.original.id ? preferences.library?.views?.find((view) => view.id === editor.original.id) : null;
  const originalHidden = originalView && resolveSavedView(originalView, environment).status === 'hidden';
  const preview = value ? filterSavedContent(navigation, tools, effectivePreferences, viewFilters(value), { hiddenKeys, today, allowDraftScopes: true }) : null;
  const editorHidden = Boolean(value && (originalHidden || preview?.status === 'hidden'
    || locked && (editor.private || editor.originalPrivate || preferences.privateKeys.includes(`view:${value.id}`))));
  const dirty = editor && (JSON.stringify({ ...editor.value, revisit: editor.value.revisit ?? null })
    !== JSON.stringify({ ...editor.original, revisit: editor.original.revisit ?? null }) || editor.private !== editor.originalPrivate);
  const missingTagIds = value?.tagIds.filter((id) => !preferences.library?.tags.some((tag) => tag.id === id)) || [];
  const scopeValue = value?.scope.kind === 'desktop' ? `desktop:${value.scope.desktopId}`
    : value?.scope.kind === 'folder' ? `folder:${value.scope.folderId}` : 'all';
  const scopeChanged = value?.scope.kind === 'desktop' && value.scope.desktopId.startsWith('@page:')
    && editor.expectedNavigationRevision !== navigation.revision;
  if (value && !scopeOptions.some((option) => option.value === scopeValue)) scopeOptions.push({ value: scopeValue, label: tr('范围已失效'), disabled: true });
  if (scopeChanged) scopeOptions.push({ value: 'scope-changed', label: tr('目标位置已变化，请重新选择。'), disabled: true });
  const deleteVisible = deleting && views.some((view) => view.id === deleting.id);

  function startEditing(view, isPrivate = false) {
    const original = structuredClone(view);
    setEditor({ value: structuredClone(view), original, private: isPrivate, originalPrivate: isPrivate,
      expectedNavigationRevision: navigation.revision }); setError('');
  }
  function startNew(filters) { startEditing({ name: '', ...defaultSavedFilters(), ...structuredClone(filters) }); }
  function patch(changes) { setEditor((current) => ({ ...current, value: { ...current.value, ...changes },
    ...(Object.hasOwn(changes, 'scope') ? { expectedNavigationRevision: navigation.revision } : {}) })); setError(''); }
  function requestClose(destination = 'close') {
    if (busy) return;
    if (dirty) { setDiscarding(destination); return; }
    if (destination === 'list') { setEditor(null); setError(''); } else onClose();
  }
  async function run(action) {
    if (working.current) return;
    working.current = true; setBusy(true); onBusyChange?.(true); setError('');
    try { await action(); }
    catch (reason) { setError(userErrorMessage(reason)); }
    finally { working.current = false; setBusy(false); onBusyChange?.(false); }
  }
  function save(event) {
    event.preventDefault();
    if (!value.name.trim() || editorHidden || scopeChanged || preview?.reason === 'invalid-filters' || event.nativeEvent.isComposing) return;
    run(async () => {
      const latest = await loadContentPreferences();
      await onSaveView({ ...value, name: value.name.trim() }, { expectedRevision: latest.revision,
        expectedViewRevision: editor.original.revision ?? 0, expectedNavigationRevision: editor.expectedNavigationRevision, private: editor.private });
      setEditor(null);
    });
  }

  return <Dialog title={tr('动态清单')} wide className="saved-views-modal" closeDisabled={busy} onClose={() => requestClose()}>
    <div className="saved-views" aria-busy={busy || undefined}>
      {!editor ? <>
        <div className="saved-views-toolbar">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => startNew(defaultSavedFilters())}><Plus size={17} />{tr('新建清单')}</Button>
          {initialFilters && <Button type="button" variant="secondary" disabled={busy} onClick={() => startNew(initialFilters)}>{tr('保存当前筛选')}</Button>}
        </div>
        <div className="saved-views-list">
          {views.map((view) => {
            const result = resolveSavedView(view, environment);
            return <div className="saved-view-row" key={view.id}>
              <Button type="button" variant="unstyled" size="unstyled" className="saved-view-open" disabled={busy || result.status !== 'ready'} onClick={() => run(async () => {
                await onApply(viewFilters(view), view); onClose();
              })}>
                <strong>{view.name}</strong><span>{result.status === 'ready' ? typeOptions.find((option) => option.value === view.type)?.label : conditionMessage(result)}</span>
              </Button>
              <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={tr('编辑清单')} onClick={() => startEditing(view, preferences.privateKeys.includes(`view:${view.id}`))}><PencilSimple size={18} /></Button>
              <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={tr('删除清单')} onClick={() => { setDeleting(structuredClone(view)); setError(''); }}><Trash size={18} /></Button>
            </div>;
          })}
          {!views.length && <p className="saved-views-empty">{tr('还没有动态清单')}</p>}
        </div>
      </> : editorHidden ? <div className="saved-view-shield">
        <p>{tr('清单包含隐藏条件，请先解锁。')}</p>
        <Button type="button" variant="secondary" disabled={busy} onClick={presentation.requestUnlock}>{tr('输入密码查看隐藏内容')}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => requestClose('list')}>{tr('返回清单')}</Button>
      </div> : <form className="form-stack saved-view-form" onSubmit={save}>
        <label>{tr('清单名称')}<Input autoFocus required value={value.name} maxLength={SAVED_VIEW_LIMITS.name} disabled={busy} onChange={(event) => patch({ name: event.target.value })} /></label>
        <label>{tr('搜索文字')}<Input value={value.query} maxLength={SAVED_VIEW_LIMITS.query} disabled={busy} onChange={(event) => patch({ query: event.target.value })} /></label>
        <div className="saved-view-selects">
          <Select label={tr('内容类型')} value={value.type} options={typeOptions} disabled={busy} onChange={(type) => patch({ type })} />
          <Select label={tr('筛选范围')} value={scopeChanged ? 'scope-changed' : scopeValue} options={scopeOptions} disabled={busy} onChange={(scope) => patch({ scope: scope === 'all' ? { kind: 'all' }
            : scope.startsWith('desktop:') ? { kind: 'desktop', desktopId: scope.slice(8) } : { kind: 'folder', folderId: scope.slice(7) } })} />
        </div>
        <label>{tr('域名')}<Input value={value.domain} maxLength={SAVED_VIEW_LIMITS.domain} placeholder="example.com" disabled={busy} onChange={(event) => patch({ domain: event.target.value })} /></label>
        <div className="saved-view-selects">
          <Select label={tr('阅读状态')} value={value.readingStatus ?? 'all'} disabled={busy} options={[
            { value: 'all', label: tr('全部状态') }, { value: 'unread', label: tr('未读') }, { value: 'read', label: tr('已读') }, { value: 'archived', label: tr('归档') },
          ]} onChange={(readingStatus) => patch({ readingStatus: readingStatus === 'all' ? null : readingStatus })} />
          <Select label={tr('再看日期')} value={value.revisit ?? 'all'} disabled={busy} options={[
            { value: 'all', label: tr('不限日期') }, { value: 'due', label: tr('待再看') },
            { value: 'scheduled', label: tr('已设日期') }, { value: 'none', label: tr('未设日期') },
          ]} onChange={(revisit) => patch({ revisit: revisit === 'all' ? null : revisit })} />
        </div>
        {value.revisit && <p className="hint">{tr('日期条件仅匹配稍后读，可与阅读状态组合。')}</p>}
        <fieldset className="saved-view-tags" disabled={busy}>
          <legend>{tr('标签')}</legend><p className="hint">{tr('同时包含所选标签')}</p>
          <div className="saved-view-tag-options">
            {tags.map((tag) => <label className="saved-view-tag" key={tag.id}><Checkbox checked={value.tagIds.includes(tag.id)}
              disabled={!value.tagIds.includes(tag.id) && value.tagIds.length >= SAVED_VIEW_LIMITS.tags}
              onCheckedChange={(checked) => patch({ tagIds: checked === true ? [...value.tagIds, tag.id] : value.tagIds.filter((id) => id !== tag.id) })} /><span>{tag.name}</span></label>)}
          </div>
          {missingTagIds.length > 0 && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => patch({ tagIds: value.tagIds.filter((id) => !missingTagIds.includes(id)) })}>{tr('移除失效标签')}</Button>}
        </fieldset>
        {Boolean(value.excludeTagIds?.length) && <fieldset className="saved-view-tags" disabled={busy}>
          <legend>{tr('排除标签')}</legend>
          <div className="saved-view-tag-options">{value.excludeTagIds.map((id) => <Button key={id} type="button" variant="secondary" size="sm"
            onClick={() => patch({ excludeTagIds: value.excludeTagIds.filter((value) => value !== id) })}>{tags.find((tag) => tag.id === id)?.name || tr('移除失效标签')} ×</Button>)}</div>
        </fieldset>}
        <label className="saved-view-private"><Checkbox checked={editor.private} disabled={busy} onCheckedChange={(checked) => setEditor((current) => ({ ...current, private: checked === true }))} />{tr('开启隐藏时锁定此清单')}</label>
        <p className={preview?.status === 'ready' && !scopeChanged ? 'hint' : 'form-error'} role="status">{scopeChanged
          ? tr('目标位置已变化，请重新选择。') : preview?.status === 'ready'
            ? tr('当前匹配 {0} 项', [formatNumber(preview.rows.length)]) : conditionMessage(preview)}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="saved-view-form-actions">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => requestClose('list')}>{tr('返回清单')}</Button>
          <Button type="submit" disabled={busy || !value.name.trim() || scopeChanged || preview?.reason === 'invalid-filters'}>{tr('保存')}</Button>
        </div>
      </form>}
      {error && !editor && !deleteVisible && <p className="form-error" role="alert">{error}</p>}
      {deleteVisible && <PromptDialog title={tr('删除清单')} action={tr('删除')} destructive busy={busy} onCancel={() => { setDeleting(null); setError(''); }} onConfirm={() => run(async () => {
        const latest = await loadContentPreferences();
        await deleteSavedView(deleting.id, { expectedRevision: latest.revision, expectedViewRevision: deleting.revision }); setDeleting(null);
      })}><p>{tr('删除此动态清单？')}</p>{error && <p className="form-error" role="alert">{error}</p>}</PromptDialog>}
      {discarding && <PromptDialog title={tr('放弃修改')} action={tr('放弃修改')} destructive privacySafe busy={busy} onCancel={() => setDiscarding(null)} onConfirm={() => {
        const destination = discarding; setDiscarding(null); setEditor(null); setError(''); if (destination === 'close') onClose();
      }}><p>{tr('当前内容尚未保存，放弃修改？')}</p></PromptDialog>}
    </div>
  </Dialog>;
}
