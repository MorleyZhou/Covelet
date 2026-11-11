import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowSquareOut, BookmarkSimple, Copy, FolderSimple, MagnifyingGlass, PencilSimple, Tag } from '@phosphor-icons/react';
import { tr, getLocale, formatNumber } from '../i18n/index.js';
import { defaultSavedFilters, filterSavedContent, SAVED_VIEW_LIMITS } from '../lib/saved-views.js';
import { getContentMetadata, getContentTags } from '../lib/content-preferences.js';
import { desktopPageName, logicalDesktopPages } from '../lib/desktop-pages.js';
import { previewLayoutTransfer } from '../lib/navigation-destinations.js';
import { PresentationContext } from '../lib/presentation.js';
import { resourceDomain, resourceLocation, sortResourceRows } from '../lib/resource-library.js';
import { userErrorMessage } from '../lib/user-error.js';
import ContentMetadataEditor, { SavedContentMetadataEditor } from './ContentMetadataEditor.jsx';
import NavigationDestination from './NavigationDestination.jsx';
import Select from './Select.jsx';
import { Button } from './ui/button.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Input } from './ui/input.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover.jsx';
import { useFloatingContainer } from './DialogSurface.jsx';
import './resource-library.css';

const PAGE_SIZE = 50;
const libraryFilters = (value) => ({ ...defaultSavedFilters(), ...structuredClone(value || {}), type: !value?.type || value.type === 'all' ? 'navigation' : value.type });
const scopeValue = (scope) => scope?.kind === 'desktop' ? `desktop:${scope.desktopId}` : scope?.kind === 'folder' ? `folder:${scope.folderId}` : 'all';
function LibraryTagFilter({ tags, selected, onChange, disabled }) {
  const container = useFloatingContainer();
  return <Popover>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" disabled={disabled} className="content-tag-filter-trigger" data-active={selected.length > 0 || undefined}
      aria-label={selected.length ? tr('标签筛选已开启') : tr('标签筛选')}><Tag size={16} />{tr('标签')}{selected.length > 0 && <span>{formatNumber(selected.length)}</span>}</Button></PopoverTrigger>
    {container && <PopoverContent container={container} className="content-tag-filter-panel" aria-label={tr('标签筛选')}
      onEscapeKeyDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <fieldset className="content-tag-filter" disabled={disabled}><legend>{tr('标签')}</legend><p className="hint">{tr('同时包含所选标签')}</p>
        <div className="content-tag-options">{tags.map((tag) => <label className="content-tag-option" key={tag.id}><Checkbox checked={selected.includes(tag.id)} disabled={!selected.includes(tag.id) && selected.length >= SAVED_VIEW_LIMITS.tags}
          onCheckedChange={(checked) => onChange(checked === true ? [...selected, tag.id] : selected.filter((id) => id !== tag.id))} /><span>{tag.name}</span></label>)}</div>
        {selected.length > 0 && <Button type="button" variant="ghost" size="sm" onClick={() => onChange([])}>{tr('清除标签筛选')}</Button>}
      </fieldset>
    </PopoverContent>}
  </Popover>;
}

export default function ResourceLibrary({ navigation, tools, preferences, initialFilters, Dialog, onSaveView, onReveal, onTransfer, onBatchTags, onReviewDuplicates, onBusyChange }) {
  const presentation = useContext(PresentationContext), pending = useRef(false);
  const [filters, setFilters] = useState(() => libraryFilters(initialFilters));
  const [sort, setSort] = useState({ field: 'name', direction: 'asc' }), [page, setPage] = useState(0), [selected, setSelected] = useState([]);
  const [operation, setOperation] = useState(null), [editing, setEditing] = useState(null), [busy, setBusy] = useState(false), [childBusy, setChildBusy] = useState(false);
  const [ownPreferences, setOwnPreferences] = useState(null), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const initialKey = JSON.stringify(initialFilters || null), previousInitial = useRef(initialKey);
  const currentPreferences = ownPreferences && ownPreferences.revision > preferences.revision ? ownPreferences : preferences;
  const locked = presentation.active || currentPreferences.presentation;
  const hiddenKeys = locked ? presentation.hiddenKeys : new Set();
  const allBusy = busy || childBusy;
  useEffect(() => { onBusyChange?.(allBusy); }, [allBusy, onBusyChange]);
  useEffect(() => {
    if (previousInitial.current === initialKey) return;
    previousInitial.current = initialKey;
    setFilters(libraryFilters(initialFilters)); setSelected([]); setPage(0); setOperation(null); setError(''); setNotice('');
  }, [initialKey]);
  const result = useMemo(() => filterSavedContent(navigation, tools, { ...currentPreferences, presentation: locked }, filters,
    { hiddenKeys, allowedTypes: ['site', 'folder'], allowDraftScopes: true }), [navigation, tools, currentPreferences, locked, filters, presentation.hiddenKeys]);
  const hidden = result.status === 'hidden';
  const rows = useMemo(() => result.status === 'ready' ? sortResourceRows(result.rows, navigation, sort, getLocale()) : [], [result, navigation, sort, getLocale()]);
  const selectableIds = rows.filter((row) => row.type === 'site').map((row) => row.id), visibleKey = selectableIds.join('\0');
  const selectedIds = selected.filter((id) => selectableIds.includes(id));
  useEffect(() => { setSelected((ids) => ids.filter((id) => selectableIds.includes(id))); }, [visibleKey]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)), currentPage = Math.min(page, totalPages - 1);
  const pageRows = rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE), pageIds = pageRows.filter((row) => row.type === 'site').map((row) => row.id);
  const pageSelected = pageIds.filter((id) => selectedIds.includes(id)).length;
  const tags = hidden ? [] : getContentTags({ ...currentPreferences, presentation: locked }, { hiddenKeys });
  const tagMap = new Map(tags.map((tag) => [tag.id, tag.name]));
  const visibleFolders = navigation.entries.filter((entry) => entry.type === 'folder' && !hiddenKeys.has(`folder:${entry.id}`) && (!locked || !currentPreferences.privateKeys.includes(`folder:${entry.id}`)));
  const desktopPages = logicalDesktopPages(navigation), desktopNames = desktopPages.map((desktopPage) => desktopPageName(navigation.settings, desktopPage));
  function desktopLabel(desktopPage) {
    const name = desktopPageName(navigation.settings, desktopPage);
    return desktopNames.filter((item) => item === name).length > 1 ? `${name} · ${tr('第 {0} 屏', [formatNumber(desktopPages.indexOf(desktopPage) + 1)])}` : name;
  }
  const scopeOptions = [{ value: 'all', label: tr('全部位置') }, ...desktopPages.flatMap((desktopPage) => {
    const desktopId = navigation.settings.desktopPages?.[desktopPage]?.id || `@page:${desktopPage}`;
    const label = desktopLabel(desktopPage);
    return [{ value: `desktop:${desktopId}`, label }, ...visibleFolders.filter((folder) => (folder.page ?? 0) === desktopPage)
      .map((folder) => ({ value: `folder:${folder.id}`, label: `${label} › ${folder.name}` }))];
  })];
  const scope = scopeValue(filters.scope);
  if (!scopeOptions.some((option) => option.value === scope)) scopeOptions.push({ value: scope, label: tr('位置已失效'), disabled: true });
  const typeOptions = [['navigation', tr('网站与文件夹')], ['site', tr('网站')], ['folder', tr('文件夹')]].map(([value, label]) => ({ value, label }));
  if (!typeOptions.some((option) => option.value === filters.type)) typeOptions.push({ value: filters.type, label: tr('不支持的内容类型'), disabled: true });
  const operationVisible = operation && !hidden && operation.ids.every((id) => selectableIds.includes(id));
  const operationFresh = operation && operation.expectedNavigationRevision === navigation.revision && operation.expectedPreferencesRevision === currentPreferences.revision;
  const operationValid = operationVisible && operationFresh;
  const editingExists = editing && navigation.entries.some((entry) => entry.type === 'site' && `site:${entry.id}` === editing);
  let preview;
  if (operationValid && operation.kind === 'transfer' && operation.destinationValue) {
    try { preview = previewLayoutTransfer(navigation, operation.ids, operation.destinationValue, { ...currentPreferences,
      presentation: locked, privateKeys: [...new Set([...currentPreferences.privateKeys, ...hiddenKeys])] }, operation.action, { scope: 'all-sites' }); } catch { /* Preserve the target so the user can choose again. */ }
  }
  function changeFilters(patch) { setFilters((current) => ({ ...current, ...patch })); setPage(0); setSelected([]); setError(''); setNotice(''); }
  function chooseScope(value) {
    changeFilters({ scope: value.startsWith('desktop:') ? { kind: 'desktop', desktopId: value.slice(8) }
      : value.startsWith('folder:') ? { kind: 'folder', folderId: value.slice(7) } : { kind: 'all' } });
  }
  function toggle(id, checked) { setSelected((ids) => checked ? [...new Set([...ids, id])] : ids.filter((item) => item !== id)); setNotice(''); }
  function begin(kind) {
    setError(''); setNotice('');
    setOperation({ kind, ids: [...selectedIds], expectedNavigationRevision: navigation.revision, expectedPreferencesRevision: currentPreferences.revision,
      action: kind === 'transfer' ? 'move' : 'add', destinationValue: '', tagIds: [],
      expectedMetadata: Object.fromEntries(selectedIds.map((id) => [`site:${id}`, getContentMetadata(currentPreferences, `site:${id}`, { hiddenKeys })])) });
  }
  async function run(action) {
    if (pending.current) return;
    pending.current = true; setBusy(true); onBusyChange?.(true); setError('');
    try { await action(); }
    catch (reason) { setError(userErrorMessage(reason)); }
    finally { pending.current = false; setBusy(false); onBusyChange?.(false); }
  }
  function submit(event) {
    event.preventDefault();
    if (!operationValid || allBusy) return;
    run(async () => {
      const { ids, expectedNavigationRevision, expectedPreferencesRevision, expectedMetadata } = operation;
      if (operation.kind === 'transfer') await onTransfer({ ids, operation: operation.action, destinationValue: operation.destinationValue, expectedNavigationRevision, expectedPreferencesRevision });
      else await onBatchTags({ ids, operation: operation.action, tagIds: operation.tagIds, expectedNavigationRevision, expectedPreferencesRevision, expectedMetadata });
      setSelected([]); setOperation(null); setNotice(tr('已整理所选网站。'));
    });
  }
  function locationLabel(entry) {
    const location = resourceLocation(entry, navigation), desktop = desktopLabel(location.page);
    return location.folder ? `${desktop} › ${location.folder.name}` : desktop;
  }
  if (hidden) return <div className="resource-library resource-library-hidden"><p className="hint">{tr('筛选条件包含隐藏内容，解锁后可查看。')}</p>
    <Button type="button" variant="secondary" onClick={presentation.requestUnlock}>{tr('输入密码查看隐藏内容')}</Button></div>;
  return <div className="resource-library" aria-busy={allBusy || undefined}>
    <div className="resource-library-search"><label className="resource-library-query"><MagnifyingGlass size={17} /><Input aria-label={tr('搜索链接')} placeholder={tr('搜索名称或备注')} maxLength={2000} value={filters.query} disabled={allBusy} onChange={(event) => changeFilters({ query: event.target.value })} /></label>
      <div className="resource-library-header-actions">{onSaveView && <Button type="button" variant="secondary" disabled={allBusy || result.status !== 'ready'} onClick={() => run(() => onSaveView(structuredClone(filters)))}><BookmarkSimple size={16} />{tr('保存为清单')}</Button>}
        {onReviewDuplicates && <Button type="button" variant="secondary" disabled={allBusy} onClick={() => run(() => onReviewDuplicates())}><Copy size={16} />{tr('重复链接审阅')}</Button>}</div></div>
    <div className="resource-library-filters"><Select label={tr('内容类型')} value={filters.type} options={typeOptions} disabled={allBusy} onChange={(type) => changeFilters({ type })} />
      <Select label={tr('位置')} value={scope} options={scopeOptions} disabled={allBusy} onChange={chooseScope} />
      <label className="resource-domain-filter">{tr('域名')}<Input value={filters.domain} placeholder="example.com" maxLength={253} disabled={allBusy} onChange={(event) => changeFilters({ domain: event.target.value })} /></label>
      <div className="resource-library-filter-actions"><LibraryTagFilter tags={tags} selected={filters.tagIds} onChange={(tagIds) => changeFilters({ tagIds })} disabled={allBusy} />
        <Button type="button" variant="ghost" size="sm" disabled={allBusy} onClick={() => { setFilters(libraryFilters()); setSelected([]); setPage(0); setError(''); setNotice(''); }}>{tr('重置筛选')}</Button></div></div>
    <div className="resource-library-toolbar"><span role="status">{selectedIds.length ? tr('已选 {0} 个网站', [formatNumber(selectedIds.length)]) : tr('{0} 项', [formatNumber(rows.length)])}</span>
      {selectedIds.length > 0 && <div><Button type="button" variant="ghost" size="sm" disabled={allBusy} onClick={() => begin('tags')}><Tag size={15} />{tr('编辑标签')}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={allBusy} onClick={() => begin('transfer')}><Copy size={15} />{tr('移动或复制')}</Button>
        <Button type="button" variant="ghost" size="sm" disabled={allBusy} onClick={() => setSelected([])}>{tr('取消选择')}</Button></div>}
      <Select label={tr('排序')} value={`${sort.field}:${sort.direction}`} options={[
        { value: 'name:asc', label: tr('名称升序') }, { value: 'name:desc', label: tr('名称降序') }, { value: 'domain:asc', label: tr('按域名') }, { value: 'location:asc', label: tr('按位置') },
      ]} disabled={allBusy} onChange={(value) => { const [field, direction] = value.split(':'); setSort({ field, direction }); setPage(0); }} /></div>
    {result.status !== 'ready' && <p className="form-error" role="alert">{tr('筛选条件已失效，请重新选择。')}</p>}
    {error && !operation && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="hint" role="status">{notice}</p>}
    <div className="resource-library-table-scroll"><table className="resource-library-table" aria-label={tr('链接列表')}><thead><tr>
      <th className="resource-check"><Checkbox aria-label={tr('全选本页网站')} checked={pageIds.length > 0 && pageSelected === pageIds.length ? true : pageSelected ? 'indeterminate' : false}
        disabled={allBusy || !pageIds.length} onCheckedChange={(checked) => setSelected((ids) => checked === true ? [...new Set([...ids, ...pageIds])] : ids.filter((id) => !pageIds.includes(id)))} /></th>
      <th aria-sort={sort.field === 'name' ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>{tr('名称')}{sort.field === 'name' && (sort.direction === 'asc' ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}</th><th>{tr('位置')}</th><th><span className="visually-hidden">{tr('操作')}</span></th>
    </tr></thead><tbody>{pageRows.map((row) => {
      const entry = row.entry, isSite = row.type === 'site', metadata = isSite ? getContentMetadata(currentPreferences, row.key, { hiddenKeys }) : null;
      return <tr key={row.key} data-content-key={row.key} data-selected={selectedIds.includes(row.id) || undefined}>
        <td className="resource-check">{isSite && <Checkbox aria-label={tr('选择“{0}”', [entry.name])} checked={selectedIds.includes(row.id)} disabled={allBusy} onCheckedChange={(checked) => toggle(row.id, checked === true)} />}</td>
        <td className="resource-main">{isSite ? <a href={entry.url} target="_blank" rel="noopener noreferrer" className="resource-name">{entry.name}<ArrowSquareOut size={13} /></a>
          : <Button type="button" variant="unstyled" size="unstyled" className="resource-name" disabled={allBusy} onClick={() => changeFilters({ scope: { kind: 'folder', folderId: entry.id }, type: 'navigation' })}><FolderSimple size={17} />{entry.name}</Button>}
          {isSite && <small>{resourceDomain(entry)}</small>}{metadata?.description && <p className="resource-description">{metadata.description}</p>}
          {metadata?.tagIds.length > 0 && <div className="resource-tag-labels" aria-label={tr('标签')}>{metadata.tagIds.filter((id) => tagMap.has(id)).map((id) => <span key={id}>{tagMap.get(id)}</span>)}</div>}</td>
        <td className="resource-location"><Button type="button" variant="unstyled" size="unstyled" disabled={allBusy} onClick={() => onReveal?.(entry)} title={locationLabel(entry)}>{locationLabel(entry)}</Button></td>
        <td className="resource-row-actions">{isSite && <Button type="button" variant="ghost" size="icon" disabled={allBusy} aria-label={tr('编辑“{0}”的备注与标签', [entry.name])} onClick={() => { setEditing(row.key); setError(''); }}><PencilSimple size={16} /></Button>}</td>
      </tr>;
    })}</tbody></table>{!rows.length && result.status === 'ready' && <p className="resource-library-empty">{tr('没有找到链接')}</p>}</div>
    {totalPages > 1 && <nav className="resource-library-pagination" aria-label={tr('列表分页')}><Button type="button" variant="ghost" size="sm" disabled={allBusy || currentPage === 0} onClick={() => setPage((value) => value - 1)}>{tr('上一页')}</Button>
      <span>{tr('第 {0} 页，共 {1} 页', [formatNumber(currentPage + 1), formatNumber(totalPages)])}</span><Button type="button" variant="ghost" size="sm" disabled={allBusy || currentPage >= totalPages - 1} onClick={() => setPage(currentPage + 1)}>{tr('下一页')}</Button></nav>}
    {editing && <Dialog title={tr('备注与标签')} privacyKeys={[editing]} closeDisabled={childBusy} onClose={() => { if (!childBusy) setEditing(null); }}>
      {editingExists ? <SavedContentMetadataEditor key={editing} contentKey={editing} preferences={currentPreferences} onClose={() => setEditing(null)} onBusyChange={setChildBusy} />
        : <p className="form-error" role="alert">{tr('这条记录已被移除。')}</p>}
    </Dialog>}
    {operation && <Dialog title={operation.kind === 'transfer' ? tr('移动或复制') : tr('编辑标签')} closeDisabled={allBusy} onClose={() => { if (!allBusy) { setOperation(null); setError(''); } }}>
      <form className="form-stack resource-batch-form" onSubmit={submit}>
        {operationVisible && <p className="hint">{tr('已选 {0} 个网站', [formatNumber(operation.ids.length)])}</p>}
        {!operationVisible ? <p className="form-error" role="alert">{tr('所选内容已变化，请重新选择。')}</p> : <>
          <Select label={tr('操作')} value={operation.action} disabled={allBusy} options={operation.kind === 'transfer' ? [{ value: 'move', label: tr('移动') }, { value: 'copy', label: tr('复制') }]
            : [{ value: 'add', label: tr('添加标签') }, { value: 'remove', label: tr('移除标签') }]} onChange={(action) => setOperation((current) => ({ ...current, action }))} />
          {operation.kind === 'transfer' ? <><NavigationDestination state={navigation} preferences={{ ...currentPreferences, presentation: locked, privateKeys: [...new Set([...currentPreferences.privateKeys, ...hiddenKeys])] }}
            value={operation.destinationValue} disabled={allBusy} onChange={(destinationValue) => setOperation((current) => ({ ...current, destinationValue }))} />
            {preview && <p className="hint" role="status">{operation.action === 'move' ? tr('将移动 {0} 个网站。', [formatNumber(preview.sources.length)]) : tr('将复制 {0} 个网站。', [formatNumber(preview.sources.length)])}
              {preview.duplicates > 0 && <> {tr('将跳过 {0} 条重复网址。', [formatNumber(preview.duplicates)])}</>}</p>}</>
            : <ContentMetadataEditor preferences={currentPreferences} allowDescription={false} value={{ description: '', tagIds: operation.tagIds }} disabled={busy} onBusyChange={setChildBusy}
              onChange={(value) => setOperation((current) => ({ ...current, tagIds: value.tagIds }))} onPreferencesChange={(next) => { setOwnPreferences(next); setOperation((current) => current && { ...current, expectedPreferencesRevision: next.revision }); }} />}
        </>}
        {operationVisible && !operationFresh && !childBusy && <p className="form-error" role="alert">{tr('所选内容已变化，请重新选择。')}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-footer"><Button type="button" variant="secondary" disabled={allBusy} onClick={() => { setOperation(null); setError(''); }}>{tr('取消')}</Button>
          <Button type="submit" disabled={allBusy || !operationValid || (operation.kind === 'transfer' ? !preview?.sources.length : !operation.tagIds.length)}>{tr('应用')}</Button></div>
      </form>
    </Dialog>}
  </div>;
}
