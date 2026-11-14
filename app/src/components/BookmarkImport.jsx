import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileArrowUp, Folder, Link, MagnifyingGlass } from '@phosphor-icons/react';
import { tr, formatNumber } from '../i18n/index.js';
import { readBookmarkFile } from '../lib/bookmark-file.js';
import { parseBulkLinks, prepareImport, prepareImportWithMetadata } from '../lib/import-plan.js';
import { parseRaindropBookmarks, parseOneTabLinks } from '../lib/import-sources.js';
import { userErrorMessage } from '../lib/user-error.js';
import { PresentationContext } from '../lib/presentation.js';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Textarea } from './ui/textarea.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import Select from './Select.jsx';
import { Disclosure } from './ui/disclosure.jsx';
import './import-plan.css';

const MERGE_PAGE_SIZE = 20;
const SOURCE_PAGE_SIZE = 100;

export default function BookmarkImport({ state, preferences, initialPlan = null, initialPage = 0, columns = 8, pageLabel, onApply, onClose, onBusyChange }) {
  const presentation = useContext(PresentationContext);
  const [plan, setPlan] = useState(initialPlan), [text, setText] = useState(''), [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set(initialPlan?.sites.map((_, index) => index) ?? []));
  const [page, setPage] = useState(initialPage), [targetFolderId, setTargetFolderId] = useState('original');
  const [skipDuplicates, setSkipDuplicates] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pasteFormat, setPasteFormat] = useState('links'), [includeMetadata, setIncludeMetadata] = useState(true), [metadataChoices, setMetadataChoices] = useState({});
  const [groupNames, setGroupNames] = useState({});
  const [mergePage, setMergePage] = useState(0);
  const mergeHeading = useRef(null), pagingRequested = useRef(false);
  const [sourcePage, setSourcePage] = useState(0);
  const sourceList = useRef(null), sourcePagingRequested = useRef(false);
  const [, setReviewEpoch] = useState(0);
  const fileFormat = useRef('auto'), openedPreferencesRevision = useRef(preferences.revision);
  const fileInput = useRef(null), gate = useRef(false), active = useRef(true), openedRevision = useRef(state.revision);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    setPlan(initialPlan); setSelected(new Set(initialPlan?.sites.map((_, index) => index) ?? [])); setQuery(''); setError(''); setMergePage(0); setSourcePage(0);
  }, [initialPlan]);
  const enhanced = ['raindrop-html', 'onetab-text'].includes(plan?.source?.format);
  const effectivePlan = useMemo(() => !plan || plan.source?.format !== 'onetab-text' ? plan : ({ ...plan,
    folders: plan.folders.map((folder) => ({ ...folder, name: groupNames[folder.name] ?? folder.name, originalPath: groupNames[folder.name] ?? folder.name })),
    sites: plan.sites.map((site) => ({ ...site, folder: site.folder === null ? null : groupNames[site.folder] ?? site.folder })),
  }), [plan, groupNames]);
  const guarded = presentation.active && (enhanced || pasteFormat !== 'links');
  const changed = state.revision !== openedRevision.current || enhanced && preferences.revision !== openedPreferencesRevision.current;
  const pages = useMemo(() => [...new Set([...state.settings.pages, initialPage, ...state.entries.filter((entry) => entry.parentId === null && !entry.detached).map((entry) => entry.page ?? 0)])].sort((a, b) => a - b), [state, initialPage]);
  const targetHidden = presentation.active && presentation.hiddenKeys.has(`folder:${targetFolderId}`);
  const folders = state.entries.filter((entry) => entry.type === 'folder' && (!presentation.active || !presentation.hiddenKeys.has(`folder:${entry.id}`)));
  const prepared = useMemo(() => {
    if (!plan || guarded) return null;
    const options = { selectedIndices: selected, page, columns, skipDuplicates, targetFolderId: targetFolderId === 'original' ? null : targetFolderId, includeMetadata, metadataChoices };
    try { return enhanced ? prepareImportWithMetadata(state, preferences, effectivePlan, options) : prepareImport(state, effectivePlan, options); }
    catch (reason) { return { error: userErrorMessage(reason) }; }
  }, [state, preferences, plan, effectivePlan, selected, page, columns, skipDuplicates, targetFolderId, enhanced, guarded, includeMetadata, metadataChoices]);
  const duplicateGroups = prepared?.duplicateGroups || [];
  const mergePageCount = Math.max(1, Math.ceil(duplicateGroups.length / MERGE_PAGE_SIZE));
  const currentMergePage = Math.min(mergePage, mergePageCount - 1), mergeStart = currentMergePage * MERGE_PAGE_SIZE;
  const visibleMergeGroups = duplicateGroups.slice(mergeStart, mergeStart + MERGE_PAGE_SIZE);
  useLayoutEffect(() => {
    if (!pagingRequested.current) return;
    pagingRequested.current = false;
    mergeHeading.current?.scrollIntoView({ block: 'nearest' });
    mergeHeading.current?.focus({ preventScroll: true });
  }, [currentMergePage]);
  const hiddenDestination = useMemo(() => {
    if (!presentation.active) return false;
    if (targetHidden) return true;
    if (!prepared?.state) return false;
    const entries = new Map(prepared.state.entries.map((entry) => [entry.id, entry]));
    // Preserving imported folder structure can reuse a same-name local folder,
    // so the implicit destination needs the same guard as an explicit choice.
    return prepared.rows.some((row) => row.willAdd && presentation.hiddenKeys.has(`folder:${entries.get(row.entryId)?.parentId}`));
  }, [presentation.active, presentation.hiddenKeys, targetHidden, prepared]);
  // A capacity/page-limit error must still leave the selection list usable,
  // so users can reduce the import instead of having to reopen the dialog.
  const fallbackRows = useMemo(() => {
    if (guarded) return [];
    const existing = new Set(state.entries.filter((entry) => entry.type === 'site').map((entry) => entry.url));
    const seen = new Set();
    return (plan?.sites ?? []).map((site, index) => {
      const checked = selected.has(index), duplicate = existing.has(site.url) || seen.has(site.url);
      if (checked) seen.add(site.url);
      return { index, name: site.name, url: site.url, folder: site.folder, originalFolder: plan.folders.find((folder) => folder.name === site.folder)?.originalPath || site.folder || '', selected: checked, duplicate, willAdd: checked && (!skipDuplicates || !duplicate) };
    });
  }, [state, plan, selected, skipDuplicates, guarded]);
  const search = query.trim().toLocaleLowerCase();
  const visibleRows = (prepared?.rows ?? fallbackRows).filter((row) => !search || `${row.name} ${row.url} ${row.originalFolder}`.toLocaleLowerCase().includes(search));
  const sourcePageCount = Math.max(1, Math.ceil(visibleRows.length / SOURCE_PAGE_SIZE));
  const currentSourcePage = Math.min(sourcePage, sourcePageCount - 1), sourceStart = currentSourcePage * SOURCE_PAGE_SIZE;
  useLayoutEffect(() => {
    if (!sourcePagingRequested.current) return;
    sourcePagingRequested.current = false;
    if (!sourceList.current) return;
    sourceList.current.scrollTop = 0;
    sourceList.current.scrollIntoView({ block: 'nearest' });
    sourceList.current.focus({ preventScroll: true });
  }, [currentSourcePage]);
  const allGroups = new Map(), groups = new Map();
  for (const row of visibleRows) {
    const key = row.folder ?? '';
    if (!allGroups.has(key)) allGroups.set(key, []);
    allGroups.get(key).push(row);
  }
  for (const row of visibleRows.slice(sourceStart, sourceStart + SOURCE_PAGE_SIZE)) {
    const key = row.folder ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const checkedState = (rows) => rows.length && rows.every((row) => selected.has(row.index)) ? true : rows.some((row) => selected.has(row.index)) ? 'indeterminate' : false;
  const selectRows = (rows, value) => {
    const next = new Set(selected);
    for (const row of rows) if (value === true) next.add(row.index); else next.delete(row.index);
    setSelected(next);
    setMergePage(0);
    setMetadataChoices((current) => Object.fromEntries(Object.entries(current).map(([url, choice]) => [url,
      { ...choice, sourceIndices: choice.sourceIndices.filter((index) => next.has(index)) }]).filter(([, choice]) => choice.sourceIndices.length)));
  };
  const usePlan = (value) => {
    openedPreferencesRevision.current = preferences.revision;
    setPlan(value); setSelected(new Set(value.sites.map((_, index) => index))); setQuery(''); setMetadataChoices({}); setIncludeMetadata(true); setGroupNames({}); setMergePage(0); setSourcePage(0);
  };
  function patchChoice(url, patch) {
    setMetadataChoices((current) => {
      const next = { ...current }, value = { sourceIndices: [], unionTags: false, description: 'keep', ...current[url], ...patch };
      if (!value.targetKey) delete next[url]; else next[url] = value;
      return next;
    });
  }
  async function run(action) {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError(''); onBusyChange?.(true);
    try { return await action(); }
    catch (reason) { if (active.current) setError(userErrorMessage(reason)); }
    finally { gate.current = false; if (active.current) setBusy(false); onBusyChange?.(false); }
  }
  const loadFile = (event) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    const format = fileFormat.current;
    if (presentation.active && format !== 'auto') { presentation.requestUnlock(); return; }
    // A rejected replacement must not leave the previous file ready to apply.
    setPlan(null); setSelected(new Set());
    run(async () => usePlan(await readBookmarkFile(file, { format })));
  };
  function pickFile(accept, format = 'auto') {
    if (presentation.active && format !== 'auto') { presentation.requestUnlock(); return; }
    fileFormat.current = format;
    fileInput.current.accept = accept;
    fileInput.current.click();
  }
  function mergePagination() {
    return <nav className="import-merge-pagination" aria-label={tr('重复项信息合并')}>
      <span role="status">{formatNumber(mergeStart + 1)}–{formatNumber(Math.min(mergeStart + MERGE_PAGE_SIZE, duplicateGroups.length))} / {formatNumber(duplicateGroups.length)}</span>
      {mergePageCount > 1 && <>
        <Button type="button" variant="ghost" size="sm" disabled={busy || currentMergePage === 0} onClick={() => { pagingRequested.current = true; setMergePage(currentMergePage - 1); }}>{tr('上一页')}</Button>
        <span>{tr('第 {0} 页，共 {1} 页', [formatNumber(currentMergePage + 1), formatNumber(mergePageCount)])}</span>
        <Button type="button" variant="ghost" size="sm" disabled={busy || currentMergePage >= mergePageCount - 1} onClick={() => { pagingRequested.current = true; setMergePage(currentMergePage + 1); }}>{tr('下一页')}</Button>
      </>}
    </nav>;
  }
  function sourcePagination() {
    return <nav className="import-source-pagination" aria-label={tr('导入预览')}>
      <span role="status">{formatNumber(sourceStart + 1)}–{formatNumber(Math.min(sourceStart + SOURCE_PAGE_SIZE, visibleRows.length))} / {formatNumber(visibleRows.length)}</span>
      <Button type="button" variant="ghost" size="sm" disabled={busy || currentSourcePage === 0} onClick={() => { sourcePagingRequested.current = true; setSourcePage(currentSourcePage - 1); }}>{tr('上一页')}</Button>
      <span>{tr('第 {0} 页，共 {1} 页', [formatNumber(currentSourcePage + 1), formatNumber(sourcePageCount)])}</span>
      <Button type="button" variant="ghost" size="sm" disabled={busy || currentSourcePage >= sourcePageCount - 1} onClick={() => { sourcePagingRequested.current = true; setSourcePage(currentSourcePage + 1); }}>{tr('下一页')}</Button>
    </nav>;
  }
  return <div className="bookmark-import form-stack">
    <div className="bookmark-import-scroll form-stack">
      {guarded ? <div className="form-stack import-privacy-gate"><p>{tr('导入此格式前，请先解除隐藏。')}</p>
        <Button type="button" variant="secondary" disabled={busy} onClick={presentation.requestUnlock}>{tr('输入密码查看隐藏内容')}</Button></div> : <>
      <Select label={tr('粘贴格式')} value={pasteFormat} disabled={busy} options={[
        { value: 'links', label: tr('网址 / Markdown') }, { value: 'raindrop-html', label: 'Raindrop HTML' }, { value: 'onetab-text', label: tr('OneTab 文本') },
      ]} onChange={(value) => { setPasteFormat(value); setError(''); }} />
      <label className="bookmark-import-paste"><span>{tr('粘贴网址')}</span>
        <Textarea value={text} rows={4} disabled={busy} placeholder={tr('每行一个网址，或粘贴 [名称](https://example.com)')} onChange={(event) => setText(event.target.value)} />
      </label>
      <div className="bookmark-import-source-actions">
        <Button type="button" variant="secondary" disabled={busy || !text.trim()} onClick={() => run(() => usePlan(pasteFormat === 'raindrop-html' ? parseRaindropBookmarks(text)
          : pasteFormat === 'onetab-text' ? parseOneTabLinks(text) : parseBulkLinks(text)))}><Link size={16} />{tr('预览网址')}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => pickFile('text/html,.html,.htm')}><FileArrowUp size={16} />{tr('导入书签 HTML 文件')}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => pickFile('text/markdown,.md')}><FileArrowUp size={16} />{tr('导入 Markdown 链接文件')}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => pickFile('text/html,.html,.htm', 'raindrop-html')}><FileArrowUp size={16} />{tr('导入 Raindrop HTML 文件')}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => pickFile('text/plain,.txt', 'onetab-text')}><FileArrowUp size={16} />{tr('导入 OneTab 文本文件')}</Button>
        <Input ref={fileInput} type="file" hidden onChange={loadFile} />
      </div>
      <p className="hint">{tr('支持 Chrome、Firefox 和 Edge 导出的书签 HTML 文件，仅在本机处理。')}</p>
      <Disclosure title={tr('导入提示')}>
        <p className="hint">{tr('使用浏览器导出的书签 HTML。嵌套文件夹会展平成路径名称；无效地址会列出并跳过。')}</p>
        <p className="hint">{tr('取消「跳过重复网址」后，相同网址也会重复添加；已有网址不会被替换。')}</p>
      </Disclosure>
      {plan && <>
        {plan.source?.format === 'onetab-text' && <fieldset className="import-group-names" disabled={busy}>
          <legend>{tr('导入组名')}</legend>{plan.folders.map((folder, index) => <label key={index}>{tr('第 {0} 组', [formatNumber(index + 1)])}
            <Input maxLength={200} value={groupNames[folder.name] ?? folder.name} onChange={(event) => setGroupNames((current) => ({ ...current, [folder.name]: event.target.value }))} /></label>)}
        </fieldset>}
        <div className="bookmark-import-target">
          <Select label={tr('目标主屏幕')} value={String(page)} onChange={(value) => setPage(Number(value))} disabled={busy || targetFolderId !== 'original'} options={pages.map((value, index) => ({ value: String(value), label: pageLabel?.(value) || tr('第 {0} 屏', [formatNumber(index + 1)]) }))} />
          <Select label={tr('目标位置')} value={targetFolderId} onChange={setTargetFolderId} disabled={busy} options={[
            { value: 'original', label: tr('保留原文件夹结构') },
            ...(targetHidden ? [{ value: targetFolderId, label: tr('已隐藏'), disabled: true }] : []),
            ...folders.map((folder) => ({ value: folder.id, label: folder.name })),
          ]} />
        </div>
        {hiddenDestination && <div className="form-stack"><p className="form-error" role="alert">{tr('请先输入密码解除隐藏。')}</p>
          <Button type="button" variant="secondary" disabled={busy} onClick={presentation.requestUnlock}>{tr('输入密码查看隐藏内容')}</Button></div>}
        <label className="bookmark-import-check"><Checkbox checked={skipDuplicates} disabled={busy} onCheckedChange={(value) => { setSkipDuplicates(value === true); setMetadataChoices({}); }} />{tr('跳过重复网址')}</label>
        {enhanced && <label className="bookmark-import-check"><Checkbox checked={includeMetadata} disabled={busy}
          onCheckedChange={(value) => { setIncludeMetadata(value === true); setMetadataChoices({}); }} />{tr('导入支持的标签和备注')}</label>}
        {prepared && !prepared.error && <p className="bookmark-import-summary" role="status">{tr('已选 {0} 项，将添加 {1} 个网址和 {2} 个文件夹，跳过 {3} 条重复网址。', [formatNumber(selected.size), formatNumber(prepared.addedSites), formatNumber(prepared.addedFolders), formatNumber(prepared.skippedDuplicates)])}</p>}
        {enhanced && Boolean(prepared?.updatedSites) && <p className="hint" role="status">{tr('将更新 {0} 个已有网址的标签或备注。', [formatNumber(prepared.updatedSites)])}</p>}
        <p className="hint">{tr('新内容会加入目标屏幕的空位；放不下时创建新屏幕，已有内容保持原位。')}</p>
        {plan.invalid?.length > 0 && <details className="bookmark-import-invalid"><summary>{tr('已跳过 {0} 项无效地址。', [formatNumber(plan.invalid.length)])}</summary>
          <ul>{plan.invalid.map((item, index) => <li key={index}><span>{item.url || item.name}</span><small>{item.line ? tr('第 {0} 行：{1}', [formatNumber(item.line), item.reason]) : item.reason}</small></li>)}</ul>
        </details>}
        <label className="bookmark-import-filter"><MagnifyingGlass size={16} aria-hidden="true" /><Input value={query} disabled={busy} aria-label={tr('筛选导入条目')} placeholder={tr('按名称、网址或文件夹筛选')} onChange={(event) => { setQuery(event.target.value); setSourcePage(0); }} /></label>
        <label className="bookmark-import-check"><Checkbox checked={checkedState(visibleRows)} disabled={busy || !visibleRows.length} onCheckedChange={(value) => selectRows(visibleRows, value)} />{search ? tr('选择全部筛选结果') : tr('选择全部网址')}</label>
        {sourcePageCount > 1 && sourcePagination()}
        <div ref={sourceList} className="bookmark-import-list" role="region" aria-label={tr('导入预览')} tabIndex={-1}>
          {[...groups].map(([folder, rows]) => <section className="bookmark-import-group" key={folder || 'root'}>
            <label className="bookmark-import-group-heading"><Checkbox checked={checkedState(allGroups.get(folder))} disabled={busy} onCheckedChange={(value) => selectRows(allGroups.get(folder), value)} /><Folder size={16} aria-hidden="true" /><strong>{rows[0].originalFolder || tr('桌面')}</strong><small>{formatNumber(allGroups.get(folder).length)}</small></label>
            {rows.map((row) => <label className={`bookmark-import-row${row.selected && !row.willAdd ? ' is-skipped' : ''}`} key={row.index}>
              <Checkbox checked={selected.has(row.index)} disabled={busy} onCheckedChange={(value) => selectRows([row], value)} aria-label={tr('选择 {0}', [row.name])} />
              <span><strong>{row.name}</strong><small>{row.url}</small>
                {enhanced && plan.sites[row.index].metadata?.tagNames?.length > 0 && <small className="import-source-tags">{tr('标签')} · {plan.sites[row.index].metadata.tagNames.join(' · ')}</small>}
                {enhanced && plan.sites[row.index].metadata?.description && <small className="import-source-description">{tr('备注')} · {plan.sites[row.index].metadata.description}</small>}
              </span>
              <em>{row.selected && row.duplicate && skipDuplicates ? tr('重复，跳过') : row.selected ? tr('待添加') : tr('未选择')}</em>
            </label>)}
          </section>)}
          {!visibleRows.length && <p className="bookmark-import-empty">{plan.sites.length ? tr('没有匹配的导入条目') : tr('没有可导入的网址')}</p>}
        </div>
        {sourcePageCount > 1 && sourcePagination()}
        {enhanced && includeMetadata && skipDuplicates && duplicateGroups.length > 0 && <div className="import-merge-groups">
          <h3 ref={mergeHeading} tabIndex={-1}>{tr('重复项信息合并')}</h3>
          {mergePagination()}
          {visibleMergeGroups.map((group) => {
            const choice = metadataChoices[group.url], target = group.targets.find((item) => item.targetKey === choice?.targetKey);
            return <section className="import-merge-group" key={group.url} data-merge-url={group.url}>
              <strong className="import-merge-url">{group.url}</strong>
              <Select label={tr('合并目标')} value={choice?.targetKey || ''} disabled={busy} options={[
                { value: '', label: tr('保留本地信息') }, ...group.targets.map((item) => ({ value: item.targetKey,
                  label: `${item.targetKey.startsWith('new:') ? tr('本次新增') : pageLabel?.(item.page) || tr('桌面')} / ${item.folderName ? `${item.folderName} / ` : ''}${item.name}` })),
              ]} onChange={(targetKey) => patchChoice(group.url, { targetKey })} />
              {target && <>
                <div className="import-target-metadata"><span>{tr('目标现有信息')}</span>
                  <p>{tr('标签')} · {(target.metadata?.tagNames || (target.metadata?.tagIds || []).map((id) => preferences.library?.tags.find((tag) => tag.id === id)?.name).filter(Boolean)).join(' · ') || '—'}</p>
                  <p>{tr('备注')} · {target.metadata?.description || '—'}</p>
                </div>
                <fieldset disabled={busy} className="import-merge-sources"><legend>{tr('选择参与合并的来源')}</legend>
                  {group.sourceIndices.map((index) => {
                    const source = plan.sites[index];
                    return <label className="import-merge-source" key={index}>
                      <Checkbox aria-label={tr('合并来源 {0}', [formatNumber(index + 1)])} checked={Boolean(choice.sourceIndices.includes(index))}
                        onCheckedChange={(checked) => patchChoice(group.url, { sourceIndices: checked === true ? [...choice.sourceIndices, index] : choice.sourceIndices.filter((value) => value !== index) })} />
                      <span><strong>{source.name}</strong><small>{tr('标签')} · {source.metadata?.tagNames?.join(' · ') || '—'}</small>
                        <small>{tr('备注')} · {source.metadata?.description || '—'}</small></span>
                    </label>;
                  })}
                </fieldset>
                <label className="bookmark-import-check"><Checkbox checked={choice.unionTags} disabled={busy} onCheckedChange={(checked) => patchChoice(group.url, { unionTags: checked === true })} />{tr('合并来源标签')}</label>
                <label className="bookmark-import-check"><Checkbox checked={choice.description === 'append'} disabled={busy} onCheckedChange={(checked) => patchChoice(group.url, { description: checked === true ? 'append' : 'keep' })} />{tr('追加来源备注')}</label>
              </>}
            </section>;
          })}
          {mergePageCount > 1 && mergePagination()}
        </div>}
        {prepared?.issues?.length > 0 && <div className="import-metadata-issues" role="alert">{prepared.issues.map((issue, index) => <p key={index}>
          {issue.sourceIndex !== undefined ? `${tr('第 {0} 项', [formatNumber(issue.sourceIndex + 1)])} · ` : ''}{issue.message}</p>)}</div>}
      </>}
      {(error || prepared?.error || changed) && <p className="form-error" role="alert">{changed ? enhanced
        ? tr('资料已在其他页面更新，请重新预览后再导入。') : tr('桌面已在其他页面更新，请关闭后重新打开导入。') : tr(error || prepared?.error)}</p>}
      {changed && enhanced && <Button type="button" variant="secondary" disabled={busy} onClick={() => {
        openedRevision.current = state.revision; openedPreferencesRevision.current = preferences.revision; setError(''); setReviewEpoch((value) => value + 1);
      }}>{tr('重新预览')}</Button>}
      </>}
    </div>
    <div className="modal-footer">
      <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{tr('取消')}</Button>
      <Button type="button" disabled={busy || guarded || changed || hiddenDestination || !prepared || Boolean(prepared.error) || Boolean(prepared.issues?.length) || prepared.addedSites + (prepared.updatedSites || 0) < 1} onClick={() => run(async () => {
        if (!prepared || prepared.error || changed) return;
        if (hiddenDestination) { presentation.requestUnlock(); return; }
        await onApply(enhanced ? { ...prepared, request: { plan: effectivePlan,
          options: { selectedIndices: [...selected], page, columns, skipDuplicates, targetFolderId: targetFolderId === 'original' ? null : targetFolderId, includeMetadata, metadataChoices },
          expectedNavigationRevision: openedRevision.current, expectedPreferencesRevision: openedPreferencesRevision.current } } : prepared);
      })}>{busy ? tr('正在导入…') : tr('确认导入')}</Button>
    </div>
  </div>;
}
