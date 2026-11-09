import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FileArrowUp, Folder, Link, MagnifyingGlass } from '@phosphor-icons/react';
import { tr, formatNumber } from '../i18n/index.js';
import { readBookmarkFile } from '../lib/bookmark-file.js';
import { parseBulkLinks, prepareImport } from '../lib/import-plan.js';
import { userErrorMessage } from '../lib/user-error.js';
import { PresentationContext } from '../lib/presentation.js';
import { Button } from './ui/button.jsx';
import { Input } from './ui/input.jsx';
import { Textarea } from './ui/textarea.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import Select from './Select.jsx';
import { Disclosure } from './ui/disclosure.jsx';
import './import-plan.css';

export default function BookmarkImport({ state, initialPlan = null, initialPage = 0, columns = 8, pageLabel, onApply, onClose, onBusyChange }) {
  const presentation = useContext(PresentationContext);
  const [plan, setPlan] = useState(initialPlan), [text, setText] = useState(''), [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set(initialPlan?.sites.map((_, index) => index) ?? []));
  const [page, setPage] = useState(initialPage), [targetFolderId, setTargetFolderId] = useState('original');
  const [skipDuplicates, setSkipDuplicates] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const fileInput = useRef(null), gate = useRef(false), active = useRef(true), openedRevision = useRef(state.revision);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    setPlan(initialPlan); setSelected(new Set(initialPlan?.sites.map((_, index) => index) ?? [])); setQuery(''); setError('');
  }, [initialPlan]);
  const changed = state.revision !== openedRevision.current;
  const pages = useMemo(() => [...new Set([...state.settings.pages, initialPage, ...state.entries.filter((entry) => entry.parentId === null && !entry.detached).map((entry) => entry.page ?? 0)])].sort((a, b) => a - b), [state, initialPage]);
  const targetHidden = presentation.active && presentation.hiddenKeys.has(`folder:${targetFolderId}`);
  const folders = state.entries.filter((entry) => entry.type === 'folder' && (!presentation.active || !presentation.hiddenKeys.has(`folder:${entry.id}`)));
  const prepared = useMemo(() => {
    if (!plan) return null;
    try { return prepareImport(state, plan, { selectedIndices: selected, page, columns, skipDuplicates, targetFolderId: targetFolderId === 'original' ? null : targetFolderId }); }
    catch (reason) { return { error: userErrorMessage(reason) }; }
  }, [state, plan, selected, page, columns, skipDuplicates, targetFolderId]);
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
    const existing = new Set(state.entries.filter((entry) => entry.type === 'site').map((entry) => entry.url));
    const seen = new Set();
    return (plan?.sites ?? []).map((site, index) => {
      const checked = selected.has(index), duplicate = existing.has(site.url) || seen.has(site.url);
      if (checked) seen.add(site.url);
      return { index, name: site.name, url: site.url, folder: site.folder, originalFolder: plan.folders.find((folder) => folder.name === site.folder)?.originalPath || site.folder || '', selected: checked, duplicate, willAdd: checked && (!skipDuplicates || !duplicate) };
    });
  }, [state, plan, selected, skipDuplicates]);
  const search = query.trim().toLocaleLowerCase();
  const visibleRows = (prepared?.rows ?? fallbackRows).filter((row) => !search || `${row.name} ${row.url} ${row.originalFolder}`.toLocaleLowerCase().includes(search));
  const groups = new Map();
  for (const row of visibleRows) {
    const key = row.folder ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const checkedState = (rows) => rows.length && rows.every((row) => selected.has(row.index)) ? true : rows.some((row) => selected.has(row.index)) ? 'indeterminate' : false;
  const selectRows = (rows, value) => setSelected((current) => {
    const next = new Set(current);
    for (const row of rows) if (value === true) next.add(row.index); else next.delete(row.index);
    return next;
  });
  const usePlan = (value) => { setPlan(value); setSelected(new Set(value.sites.map((_, index) => index))); setQuery(''); };
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
    // A rejected replacement must not leave the previous file ready to apply.
    setPlan(null); setSelected(new Set());
    run(async () => usePlan(await readBookmarkFile(file)));
  };
  function pickFile(accept) {
    fileInput.current.accept = accept;
    fileInput.current.click();
  }
  return <div className="bookmark-import form-stack">
    <div className="bookmark-import-scroll form-stack">
      <label className="bookmark-import-paste"><span>{tr('粘贴网址')}</span>
        <Textarea value={text} rows={4} disabled={busy} placeholder={tr('每行一个网址，或粘贴 [名称](https://example.com)')} onChange={(event) => setText(event.target.value)} />
      </label>
      <div className="bookmark-import-source-actions">
        <Button type="button" variant="secondary" disabled={busy || !text.trim()} onClick={() => run(() => usePlan(parseBulkLinks(text)))}><Link size={16} />{tr('预览网址')}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => pickFile('text/html,.html,.htm')}><FileArrowUp size={16} />{tr('导入书签 HTML 文件')}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => pickFile('text/markdown,.md')}><FileArrowUp size={16} />{tr('导入 Markdown 链接文件')}</Button>
        <Input ref={fileInput} type="file" hidden onChange={loadFile} />
      </div>
      <p className="hint">{tr('支持 Chrome、Firefox 和 Edge 导出的书签 HTML 文件，仅在本机处理。')}</p>
      <Disclosure title={tr('导入提示')}>
        <p className="hint">{tr('使用浏览器导出的书签 HTML。嵌套文件夹会展平成路径名称；无效地址会列出并跳过。')}</p>
        <p className="hint">{tr('取消「跳过重复网址」后，相同网址也会重复添加；已有网址不会被替换。')}</p>
      </Disclosure>
      {plan && <>
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
        <label className="bookmark-import-check"><Checkbox checked={skipDuplicates} disabled={busy} onCheckedChange={(value) => setSkipDuplicates(value === true)} />{tr('跳过重复网址')}</label>
        {prepared && !prepared.error && <p className="bookmark-import-summary" role="status">{tr('已选 {0} 项，将添加 {1} 个网址和 {2} 个文件夹，跳过 {3} 条重复网址。', [formatNumber(selected.size), formatNumber(prepared.addedSites), formatNumber(prepared.addedFolders), formatNumber(prepared.skippedDuplicates)])}</p>}
        <p className="hint">{tr('新内容会加入目标屏幕的空位；放不下时创建新屏幕，已有内容保持原位。')}</p>
        {plan.invalid?.length > 0 && <details className="bookmark-import-invalid"><summary>{tr('已跳过 {0} 项无效地址。', [formatNumber(plan.invalid.length)])}</summary>
          <ul>{plan.invalid.map((item, index) => <li key={index}><span>{item.url || item.name}</span><small>{item.line ? tr('第 {0} 行：{1}', [formatNumber(item.line), item.reason]) : item.reason}</small></li>)}</ul>
        </details>}
        <label className="bookmark-import-filter"><MagnifyingGlass size={16} aria-hidden="true" /><Input value={query} disabled={busy} aria-label={tr('筛选导入条目')} placeholder={tr('按名称、网址或文件夹筛选')} onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="bookmark-import-check"><Checkbox checked={checkedState(visibleRows)} disabled={busy || !visibleRows.length} onCheckedChange={(value) => selectRows(visibleRows, value)} />{search ? tr('选择全部筛选结果') : tr('选择全部网址')}</label>
        <div className="bookmark-import-list" aria-label={tr('导入预览')}>
          {[...groups].map(([folder, rows]) => <section className="bookmark-import-group" key={folder || 'root'}>
            <label className="bookmark-import-group-heading"><Checkbox checked={checkedState(rows)} disabled={busy} onCheckedChange={(value) => selectRows(rows, value)} /><Folder size={16} aria-hidden="true" /><strong>{rows[0].originalFolder || tr('桌面')}</strong><small>{formatNumber(rows.length)}</small></label>
            {rows.map((row) => <label className={`bookmark-import-row${row.selected && !row.willAdd ? ' is-skipped' : ''}`} key={row.index}>
              <Checkbox checked={selected.has(row.index)} disabled={busy} onCheckedChange={(value) => selectRows([row], value)} aria-label={tr('选择 {0}', [row.name])} />
              <span><strong>{row.name}</strong><small>{row.url}</small></span>
              <em>{row.selected && row.duplicate && skipDuplicates ? tr('重复，跳过') : row.selected ? tr('待添加') : tr('未选择')}</em>
            </label>)}
          </section>)}
          {!visibleRows.length && <p className="bookmark-import-empty">{plan.sites.length ? tr('没有匹配的导入条目') : tr('没有可导入的网址')}</p>}
        </div>
      </>}
      {(error || prepared?.error || changed) && <p className="form-error" role="alert">{changed ? tr('桌面已在其他页面更新，请关闭后重新打开导入。') : tr(error || prepared?.error)}</p>}
    </div>
    <div className="modal-footer">
      <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{tr('取消')}</Button>
      <Button type="button" disabled={busy || changed || hiddenDestination || !prepared || Boolean(prepared.error) || prepared.addedSites < 1} onClick={() => run(async () => {
        if (!prepared || prepared.error || changed) return;
        if (hiddenDestination) { presentation.requestUnlock(); return; }
        await onApply(prepared);
      })}>{busy ? tr('正在导入…') : tr('确认导入')}</Button>
    </div>
  </div>;
}
